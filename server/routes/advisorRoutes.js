/**
 * /api/advisor — academic advisor endpoints.
 *
 *   GET  /topics                List the seeded topic areas.
 *   POST /ask                   Ask the advisor a text question.
 *   POST /stt                   Upload an audio blob and get a transcript
 *                               (used only when the browser's Web Speech API
 *                                is unavailable).
 *   POST /escalate              Save an escalation and email the duty advisor.
 *   GET  /health                Quick provider-readiness check.
 *
 * Auth model: requests are anonymous by default (`optionalAuth`). When a
 * logged-in user has an associated `students` row, personalisation kicks in.
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { optionalAuth, authenticateToken } = require('../middleware/auth');
const { enforceLimits, recordUsage, getUsage } = require('../middleware/usageLimits');
const { query } = require('../../config/db');
const Advisor = require('../models/Advisor');
const advisorService = require('../services/advisorService');
const advisorStreamService = require('../services/advisorStreamService');
const sttService = require('../services/sttService');
const ttsService = require('../services/ttsService');
const emailService = (() => {
    try { return require('../services/emailService'); }
    catch (_) { return null; }
})();

// 8 MB cap for short voice clips (Whisper recommends <25 MB).
const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// GET /api/advisor/topics
// ---------------------------------------------------------------------------
router.get('/topics', async (_req, res) => {
    try {
        const topics = await Advisor.listTopics();
        res.json({ success: true, topics });
    } catch (err) {
        console.error('[advisorRoutes] topics:', err.message);
        res.status(500).json({ success: false, error: 'Could not load topics' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/advisor/usage — caller's quota for the day + month
// ---------------------------------------------------------------------------
router.get('/usage', optionalAuth, getUsage);

// ---------------------------------------------------------------------------
// GET /api/advisor/history — recent conversations for the signed-in user
// ---------------------------------------------------------------------------
// NOTE: Conversations can be created with student_id=NULL if the user hasn't
// linked their account to a student record yet. This query includes both
// student-linked conversations AND orphaned conversations (NULL student_id)
// that were created during the current session, so history isn't lost.
router.get('/history', authenticateToken, async (req, res) => {
    try {
        const student = await Advisor.findStudentByUserId(req.user.id);
        const limit = Math.max(1, Math.min(50, parseInt(req.query?.limit, 10) || 20));
        
        // If user has a linked student record, get conversations for that student.
        // Also include conversations with student_id=NULL to capture any orphaned
        // conversations from before account linking.
        let rows = [];
        if (student?.id) {
            rows = await query(
                `SELECT c.id,
                        c.session_token,
                        c.title,
                        c.last_active_at,
                        c.created_at,
                        (SELECT m.text FROM advisor_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
                        (SELECT m.text FROM advisor_messages m WHERE m.conversation_id = c.id AND m.role = 'student' ORDER BY m.id ASC LIMIT 1) AS first_question,
                        (SELECT COUNT(*) FROM advisor_messages m WHERE m.conversation_id = c.id) AS message_count
                 FROM advisor_conversations c
                 WHERE c.student_id = ? OR c.student_id IS NULL
                 ORDER BY c.last_active_at DESC, c.id DESC
                 LIMIT ?`,
                [student.id, limit]
            );
        } else {
            // No student record yet; still try to return recent conversations if any exist.
            // This is a fallback for edge cases.
            rows = [];
        }

        const conversations = rows.map(r => ({
            sessionToken: r.session_token,
            title: (r.title || r.first_question || 'Conversation').toString().slice(0, 120),
            preview: (r.last_message || '').toString().slice(0, 180),
            messageCount: Number(r.message_count || 0),
            lastActiveAt: r.last_active_at,
            createdAt: r.created_at
        }));

        res.json({ success: true, conversations });
    } catch (err) {
        console.error('[advisorRoutes] history:', err.message);
        res.status(500).json({ success: false, error: 'Could not load conversation history' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/advisor/history/:sessionToken/messages
// ---------------------------------------------------------------------------
// Load messages from a specific conversation, verifying ownership.
// For users with a student record, we verify the conversation belongs to their
// student_id. For conversations with NULL student_id, we trust the session
// token (since they were created in the current session for this user).
router.get('/history/:sessionToken/messages', authenticateToken, async (req, res) => {
    try {
        const sessionToken = String(req.params.sessionToken || '').trim();
        if (!sessionToken) {
            return res.status(400).json({ success: false, error: 'sessionToken is required' });
        }

        const conv = await Advisor.getConversationByToken(sessionToken);
        if (!conv?.id) {
            return res.status(404).json({ success: false, error: 'Conversation not found' });
        }

        // Verify ownership: if conversation has a student_id, verify it matches the logged-in user.
        // If conversation has NULL student_id, we accept it (orphaned conversation from before linking).
        if (conv.student_id !== null) {
            const student = await Advisor.findStudentByUserId(req.user.id);
            if (!student?.id || conv.student_id !== student.id) {
                return res.status(404).json({ success: false, error: 'Conversation not found' });
            }
        }

        const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit, 10) || 120));
        const messages = await Advisor.getConversationMessages(conv.id, limit);

        res.json({
            success: true,
            conversation: {
                sessionToken: conv.session_token,
                lastActiveAt: conv.last_active_at,
                createdAt: conv.created_at
            },
            messages
        });
    } catch (err) {
        console.error('[advisorRoutes] history messages:', err.message);
        res.status(500).json({ success: false, error: 'Could not load conversation messages' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/advisor/health
// ---------------------------------------------------------------------------
router.get('/health', (_req, res) => {
    res.json({
        success: true,
        providers: {
            llm: Boolean(process.env.DEEPSEEK_API_KEY),
            tts: ttsService.isConfigured(),
            stt: sttService.isConfigured(),
            rag: process.env.ENABLE_RAG !== 'false'
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/advisor/sse-test  — minimal SSE for diagnosing flush issues
// ---------------------------------------------------------------------------
router.get('/sse-test', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    let n = 0;
    const id = setInterval(() => {
        n++;
        res.write(`event: tick\ndata: ${JSON.stringify({ n, at: Date.now() })}\n\n`);
        if (n >= 5) {
            clearInterval(id);
            res.write(`event: done\ndata: {}\n\n`);
            res.end();
        }
    }, 1000);
    req.on('close', () => clearInterval(id));
});

// ---------------------------------------------------------------------------
// POST /api/advisor/ask
// Body: { question, sessionToken?, voiceEnabled?, inputMode? }
// ---------------------------------------------------------------------------
router.post('/ask', optionalAuth, enforceLimits, async (req, res) => {
    try {
        const { question, sessionToken, voiceEnabled = true, inputMode = 'text' } = req.body || {};
        if (!question || typeof question !== 'string' || !question.trim()) {
            return res.status(400).json({ success: false, error: 'question is required' });
        }

        let student = null;
        if (req.user?.id) {
            student = await Advisor.findStudentByUserId(req.user.id);
            // Even when there's no `students` row, surface the user's first
            // name so the advisor can address them by name occasionally.
            if (!student && req.user.first_name) {
                student = { first_name: req.user.first_name, full_name: `${req.user.first_name} ${req.user.last_name || ''}`.trim() };
            } else if (student && req.user.first_name && !student.first_name) {
                student.first_name = req.user.first_name;
            }
        }

        const result = await advisorService.ask({
            question,
            inputMode: inputMode === 'voice' ? 'voice' : 'text',
            sessionToken,
            student,
            voiceEnabled: voiceEnabled !== false,
            advisorGender: (req.body?.advisorGender === 'male' || req.user?.advisor_gender === 'male') ? 'male' : 'female'
        });
        // Increment quota counters AFTER a successful reply so failed calls
        // don't burn quota.
        await recordUsage(req);
        res.json(result);
    } catch (err) {
        console.error('[advisorRoutes] ask:', err);
        res.status(500).json({ success: false, error: err.message || 'Advisor request failed' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/advisor/ask/stream  (Server-Sent Events)
// Body: { question, sessionToken?, voiceEnabled?, inputMode? }
//
// Streams events:
//   session       — initial session token
//   speech_ready  — speech_text finalised; TTS started in parallel
//   token         — chunk of [ANSWER] markdown for the typewriter
//   audio         — TTS audio_url ready (or browser fallback signal)
//   done          — final structured payload
//   error         — fatal error (stream then ends)
// ---------------------------------------------------------------------------
router.post('/ask/stream', optionalAuth, enforceLimits, async (req, res) => {
    const { question, sessionToken, voiceEnabled = true, inputMode = 'text' } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ success: false, error: 'question is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    // NOTE: do NOT listen to req.on('close') here — Node fires that on the
    // request stream as soon as body-parser finishes consuming the request
    // body (well before the response actually closes). Listen on `res` so we
    // only set `closed` when the client actually disconnects.
    res.on('close', () => { closed = true; });

    const send = (event, data) => {
        if (closed) return;
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (_) { /* socket likely closed */ }
    };

    // Periodic heartbeat so reverse proxies don't time out long streams.
    const heartbeat = setInterval(() => {
        if (closed) return;
        try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
    }, 15_000);

    try {
        let student = null;
        if (req.user?.id) {
            student = await Advisor.findStudentByUserId(req.user.id);
            if (!student && req.user.first_name) {
                student = { first_name: req.user.first_name, full_name: `${req.user.first_name} ${req.user.last_name || ''}`.trim() };
            } else if (student && req.user.first_name && !student.first_name) {
                student.first_name = req.user.first_name;
            }
        }

        await advisorStreamService.askStream({
            question,
            inputMode: inputMode === 'voice' ? 'voice' : 'text',
            sessionToken,
            student,
            voiceEnabled: voiceEnabled !== false,
            advisorGender: (req.body?.advisorGender === 'male' || req.user?.advisor_gender === 'male') ? 'male' : 'female',
            send
        });
        // Quota credit for streamed conversations as well
        await recordUsage(req);
    } catch (err) {
        console.error('[advisorRoutes] ask/stream:', err);
        send('error', { error: err.message || 'Advisor stream failed' });
    } finally {
        clearInterval(heartbeat);
        if (!closed) res.end();
    }
});

// ---------------------------------------------------------------------------
// POST /api/advisor/stt
// multipart/form-data with field "audio"; optional "language" form field.
// ---------------------------------------------------------------------------
router.post('/stt', audioUpload.single('audio'), async (req, res) => {
    try {
        if (!sttService.isConfigured()) {
            return res.status(503).json({
                success: false,
                error: 'Server-side STT not configured. Use the browser Web Speech API instead.'
            });
        }
        if (!req.file?.buffer) {
            return res.status(400).json({ success: false, error: 'audio file is required' });
        }
        const result = await sttService.transcribe(req.file.buffer, {
            filename: req.file.originalname || 'audio.webm',
            mimetype: req.file.mimetype || 'audio/webm',
            language: req.body?.language || 'en'
        });

        // Per privacy setting we never persist the raw audio buffer.
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[advisorRoutes] stt:', err.message);
        res.status(500).json({ success: false, error: err.message || 'Transcription failed' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/advisor/escalate
// Body: { subject, message, sessionToken?, topicSlug?, contactEmail?, contactPhone? }
// ---------------------------------------------------------------------------
router.post('/escalate', optionalAuth, async (req, res) => {
    try {
        const {
            subject, message, sessionToken, topicSlug,
            contactEmail, contactPhone, priority = 'normal'
        } = req.body || {};

        if (!subject || !message) {
            return res.status(400).json({ success: false, error: 'subject and message are required' });
        }

        let student = null;
        if (req.user?.id) student = await Advisor.findStudentByUserId(req.user.id);

        let conversationId = null;
        if (sessionToken) {
            const conv = await Advisor.getConversationByToken(sessionToken);
            conversationId = conv?.id || null;
        }

        let topicId = null;
        if (topicSlug) {
            const t = await Advisor.findTopicBySlug(topicSlug);
            topicId = t?.id || null;
        }

        const id = await Advisor.createEscalation({
            studentId: student?.id || null,
            conversationId,
            topicId,
            subject: String(subject).slice(0, 220),
            message: String(message).slice(0, 8000),
            contactEmail: contactEmail || student?.email || null,
            contactPhone: contactPhone || student?.phone || null,
            priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal'
        });

        // Best-effort email notification — never block the response on it.
        const advisorEmail = process.env.ADVISOR_ESCALATION_EMAIL || 'advisor@bmu.edu.ng';
        if (emailService && process.env.EMAIL_ENABLED === 'true') {
            emailService.sendEmail?.({
                to: advisorEmail,
                subject: `[BMU Advisor] Escalation: ${subject}`,
                text: `A student has escalated a question.\n\nFrom: ${student?.full_name || 'Anonymous'} (${contactEmail || student?.email || 'no email'})\nMatric: ${student?.matric_no || 'n/a'}\n\nMessage:\n${message}\n\nReply to: ${contactEmail || student?.email || 'unknown'}`
            }).then(() => Advisor.markEscalationEmailed(id, advisorEmail))
              .catch(e => console.warn('[advisorRoutes] escalation email failed:', e.message));
        }

        res.json({ success: true, escalationId: id, assignedTo: advisorEmail });
    } catch (err) {
        console.error('[advisorRoutes] escalate:', err);
        res.status(500).json({ success: false, error: err.message || 'Escalation failed' });
    }
});

module.exports = router;
