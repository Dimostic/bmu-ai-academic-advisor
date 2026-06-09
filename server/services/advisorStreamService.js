/**
 * Streaming variant of advisorService.ask.
 *
 * Differs from the non-streaming flow in three ways:
 *   1. DeepSeek is called with stream=true.
 *   2. As soon as the model emits the [ANSWER] marker, the [SPEECH] block is
 *      considered final and we kick off TTSMaker IN PARALLEL with continued
 *      streaming of [ANSWER] content. Total user-visible latency drops from
 *      "LLM + TTS" to "max(LLM, TTS)" because the typewriter starts at the
 *      first answer chunk and audio arrives concurrently.
 *   3. The route emits Server-Sent Events; the client wires those into the
 *      typewriter / audio / metadata UI.
 *
 * Events emitted (via an injected `send(event, data)` callback):
 *   - `session`        { sessionToken } — sent once, immediately
 *   - `speech_ready`   { speech_text }  — speech block is finalised
 *   - `token`          { text }         — new chunk of [ANSWER] markdown
 *   - `audio`          { provider, audio_url?, use_browser_fallback?, speech_text? }
 *   - `done`           { reply, audio, sessionToken, conversationId, messageId, meta }
 *   - `error`          { error }
 */
const Advisor = require('../models/Advisor');
const llm = require('./llmClient');
const persona = require('./advisorPersonaService');
const tts = require('./ttsService');

const HISTORY_TURNS = parseInt(process.env.ADVISOR_HISTORY_TURNS || '8', 10);
const RAG_ENABLED   = process.env.ENABLE_RAG !== 'false';
const RAG_TIMEOUT_MS = parseInt(process.env.ADVISOR_RAG_TIMEOUT_MS || '4000', 10);

let retrievalService = null;
try { retrievalService = require('./retrievalService'); }
catch (_) { /* missing optional service */ }

async function _resolveConversation({ sessionToken, studentId, voiceEnabled }) {
    if (sessionToken) {
        const existing = await Advisor.getConversationByToken(sessionToken);
        if (existing) return existing;
    }
    return await Advisor.createConversation({
        studentId,
        voiceEnabled: voiceEnabled !== false
    });
}

async function _fetchRagContext(question) {
    if (!RAG_ENABLED || !retrievalService || !question || question.length < 3) return '';
    // Race retrieval against a tight timeout so a slow embedding service can't
    // block the start of the LLM stream. We accept the answer-without-context
    // trade-off here: streaming responsiveness > document grounding.
    return await Promise.race([
        retrievalService.retrieve(question, { limit: 5 })
            .then(r => r?.context || '')
            .catch(err => {
                console.warn('[advisorStreamService] RAG retrieval failed:', err.message);
                return '';
            }),
        new Promise(resolve => setTimeout(() => {
            console.warn(`[advisorStreamService] RAG timeout >${RAG_TIMEOUT_MS}ms, continuing without context`);
            resolve('');
        }, RAG_TIMEOUT_MS))
    ]);
}

async function _buildHistory(conversationId) {
    const rows = await Advisor.getRecentMessages(conversationId, HISTORY_TURNS * 2);
    return rows.reverse().map(r => ({
        role: r.role === 'advisor' ? 'assistant' : 'student',
        text: r.role === 'advisor'
            ? (r.speech_text || r.text || '').slice(0, 400)
            : (r.text || '').slice(0, 400)
    }));
}

/**
 * @param {object} params
 * @param {string} params.question
 * @param {string} [params.inputMode]    'text' | 'voice'
 * @param {string} [params.sessionToken]
 * @param {object} [params.student]
 * @param {boolean}[params.voiceEnabled]
 * @param {(event:string, data:object) => void} params.send  emits an SSE event
 */
async function askStream({
    question, inputMode = 'text', sessionToken, student = null,
    voiceEnabled = true, send
}) {
    const startedAt = Date.now();
    if (!question || typeof question !== 'string' || !question.trim()) {
        send('error', { error: 'question is required' });
        return;
    }
    const trimmed = question.trim().slice(0, 4000);

    let conversation;
    try {
        conversation = await _resolveConversation({
            sessionToken, studentId: student?.id || null, voiceEnabled
        });
    } catch (err) {
        send('error', { error: `conversation: ${err.message}` });
        return;
    }
    send('session', { sessionToken: conversation.session_token });

    // Persist student turn early so a mid-stream failure still leaves a record.
    try {
        await Advisor.addMessage({
            conversationId: conversation.id,
            role: 'student',
            inputMode,
            text: trimmed
        });
    } catch (err) {
        console.warn('[advisorStreamService] persist student turn failed:', err.message);
    }

    let history = [];
    let ragContext = '';
    try {
        [history, ragContext] = await Promise.all([
            _buildHistory(conversation.id),
            _fetchRagContext(trimmed)
        ]);
    } catch (err) {
        console.warn('[advisorStreamService] context build failed:', err.message);
    }

    const messages = [
        { role: 'system', content: persona.buildSystemPrompt({ studentContext: student, ragContext }) },
        { role: 'user',   content: persona.buildUserPrompt(trimmed, history) }
    ];

    let accumulated = '';
    let lastAnswerEmitted = 0;
    let speechEmitted = null;     // the speech_text we kicked TTS for
    let ttsPromise = null;
    let llmUsage = {};
    let llmError = null;

    const startTtsIfReady = (speech) => {
        if (speechEmitted || !speech) return;
        speechEmitted = speech;
        send('speech_ready', { speech_text: speech });
        if (voiceEnabled === false || !conversation.voice_enabled) {
            send('audio', { provider: 'none', use_browser_fallback: false, speech_text: speech });
            ttsPromise = Promise.resolve({ provider: 'none' });
            return;
        }
        ttsPromise = tts.synthesise(speech).then(audio => {
            if (audio.audioUrl) {
                send('audio', {
                    provider: audio.provider,
                    audio_url: audio.audioUrl,
                    backup_url: audio.audioBackupUrl || null,
                    from_cache: Boolean(audio.fromCache),
                    speech_text: speech
                });
            } else {
                send('audio', {
                    provider: 'browser',
                    use_browser_fallback: true,
                    speech_text: speech,
                    error: audio.error || null
                });
            }
            return audio;
        }).catch(err => {
            console.warn('[advisorStreamService] TTS error:', err.message);
            send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: speech, error: err.message });
            return { provider: 'browser', useBrowserFallback: true };
        });
    };

    try {
        for await (const ev of llm.streamChat(messages)) {
            if (ev.usage) llmUsage = ev.usage;
            if (ev.delta) {
                accumulated += ev.delta;
                const scan = persona.streamScan(accumulated, lastAnswerEmitted);
                if (scan.speech && !speechEmitted) startTtsIfReady(scan.speech);
                if (scan.newAnswer) {
                    send('token', { text: scan.newAnswer });
                    lastAnswerEmitted = scan.totalAnswer;
                }
            }
            if (ev.done) {
                if (ev.usage) llmUsage = ev.usage;
                break;
            }
        }
    } catch (err) {
        llmError = err.message;
        console.error('[advisorStreamService] LLM stream error:', err.message);
    }

    // Final flush: maybe more answer text arrived between last scan and stream end.
    {
        const scan = persona.streamScan(accumulated, lastAnswerEmitted);
        if (scan.speech && !speechEmitted) startTtsIfReady(scan.speech);
        if (scan.newAnswer) {
            send('token', { text: scan.newAnswer });
            lastAnswerEmitted = scan.totalAnswer;
        }
    }

    let parsed;
    if (llmError && !accumulated) {
        parsed = {
            speech_text: "I'm having trouble reaching my knowledge service right now. Please try again in a moment, or I can connect you with a human advisor.",
            display_markdown: "**I'm temporarily unable to answer.** Please try again in a moment.\n\n_If the issue persists, you can request to speak with a human advisor._",
            topic_slug: null, citations: [],
            suggested_actions: [{ label: 'Talk to a human advisor', action: 'escalate_to_human' }],
            follow_up_questions: [], needs_escalation: true, confidence: 0
        };
    } else {
        parsed = persona.parseAdvisorReply(accumulated, trimmed);
    }

    // If [SPEECH] never closed (model didn't emit [ANSWER]), kick off TTS now
    // using the parsed speech_text — better late than never.
    if (!speechEmitted && parsed.speech_text) startTtsIfReady(parsed.speech_text);

    const audio = ttsPromise ? await ttsPromise.catch(() => ({ provider: 'browser', useBrowserFallback: true })) : { provider: 'none' };

    // Resolve topic
    let topicId = null;
    if (parsed.topic_slug) {
        try {
            const t = await Advisor.findTopicBySlug(parsed.topic_slug);
            topicId = t?.id || null;
        } catch (_) { /* ignore */ }
    }

    let messageId = null;
    try {
        messageId = await Advisor.addMessage({
            conversationId: conversation.id,
            role: 'advisor',
            inputMode: 'text',
            text: parsed.display_markdown || parsed.speech_text,
            speechText: parsed.speech_text,
            displayMarkdown: parsed.display_markdown,
            audioUrl: audio.audioUrl || null,
            citationsJson: JSON.stringify(parsed.citations || []),
            suggestedActionsJson: JSON.stringify(parsed.suggested_actions || []),
            followUpsJson: JSON.stringify(parsed.follow_up_questions || []),
            topicId,
            latencyMs: Date.now() - startedAt,
            tokensIn:  llmUsage?.prompt_tokens || null,
            tokensOut: llmUsage?.completion_tokens || null
        });
        await Advisor.touchConversation(conversation.id, topicId);
    } catch (err) {
        console.warn('[advisorStreamService] persist advisor turn failed:', err.message);
    }

    send('done', {
        success: true,
        sessionToken: conversation.session_token,
        conversationId: conversation.id,
        messageId,
        reply: {
            speech_text:         parsed.speech_text,
            display_markdown:    parsed.display_markdown,
            topic_slug:          parsed.topic_slug,
            citations:           parsed.citations,
            suggested_actions:   parsed.suggested_actions,
            follow_up_questions: parsed.follow_up_questions,
            needs_escalation:    parsed.needs_escalation,
            confidence:          parsed.confidence
        },
        audio: {
            provider:             audio.provider,
            audio_url:            audio.audioUrl || null,
            backup_url:           audio.audioBackupUrl || null,
            from_cache:           Boolean(audio.fromCache),
            use_browser_fallback: Boolean(audio.useBrowserFallback)
        },
        meta: {
            latency_ms: Date.now() - startedAt,
            tokens_in:  llmUsage?.prompt_tokens || null,
            tokens_out: llmUsage?.completion_tokens || null,
            error:      llmError
        }
    });
}

module.exports = { askStream };
