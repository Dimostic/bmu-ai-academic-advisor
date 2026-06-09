/**
 * Academic-advisor orchestrator.
 *
 * Flow:
 *   1. Look up / create the student's conversation.
 *   2. Pull recent message history + (optionally) RAG context from BMU docs.
 *   3. Call the LLM with the advisor persona + structured-output system prompt.
 *   4. Parse the structured reply; persist both the student question and the
 *      advisor reply (including suggested actions, citations, follow-ups).
 *   5. Generate TTS audio for `speech_text` (TTSMaker or browser fallback).
 *
 * Returns a single payload the frontend can render directly.
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
catch (err) { console.warn('[advisorService] retrievalService unavailable:', err.message); }

/**
 * Resolve (or create) the conversation row for this turn.
 */
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

/**
 * Fetch supporting BMU document context via the existing retrievalService.
 * Returns "" when RAG is disabled or no relevant chunks were found.
 */
async function _fetchRagContext(question) {
    if (!RAG_ENABLED || !retrievalService || !question || question.length < 3) return '';
    return await Promise.race([
        retrievalService.retrieve(question, { limit: 5 })
            .then(r => r?.context || '')
            .catch(err => {
                console.warn('[advisorService] RAG retrieval failed:', err.message);
                return '';
            }),
        new Promise(resolve => setTimeout(() => resolve(''), RAG_TIMEOUT_MS))
    ]);
}

/**
 * Build the recent-history array passed to the LLM.
 * Reverses to chronological order and trims to HISTORY_TURNS items.
 */
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
 * Public entry point used by /api/advisor/ask.
 *
 * @param {object} params
 * @param {string} params.question            the student's text or transcript
 * @param {string} [params.inputMode='text']  'text' | 'voice'
 * @param {string} [params.sessionToken]      conversation id (uuid)
 * @param {object} [params.student]           student row from `students` table
 * @param {boolean}[params.voiceEnabled=true] generate TTS?
 * @returns {Promise<object>}
 */
async function ask({ question, inputMode = 'text', sessionToken, student = null, voiceEnabled = true }) {
    const startedAt = Date.now();
    if (!question || typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required');
    }
    const trimmed = question.trim().slice(0, 4000);

    // 1. Conversation
    const conversation = await _resolveConversation({
        sessionToken,
        studentId: student?.id || null,
        voiceEnabled
    });

    // 2. Persist student turn (so any failure below still leaves a record)
    await Advisor.addMessage({
        conversationId: conversation.id,
        role: 'student',
        inputMode,
        text: trimmed
    });

    // 3. Context: history + RAG
    const [history, ragContext] = await Promise.all([
        _buildHistory(conversation.id),
        _fetchRagContext(trimmed)
    ]);

    // 4. LLM call
    const messages = [
        { role: 'system', content: persona.buildSystemPrompt({ studentContext: student, ragContext }) },
        { role: 'user',   content: persona.buildUserPrompt(trimmed, history) }
    ];

    let llmResult;
    try {
        // Persona returns a delimited [SPEECH] / [ANSWER] / [META] format, not raw
        // JSON, so we don't request response_format=json_object here.
        llmResult = await llm.chat(messages);
    } catch (err) {
        console.error('[advisorService] LLM error:', err.message);
        const fallback = {
            speech_text: "I'm having trouble reaching my knowledge service right now. Please try again in a moment, or I can connect you with a human advisor.",
            display_markdown: "**I'm temporarily unable to answer.** Please try again in a moment.\n\n_If the issue persists, you can request to speak with a human advisor._",
            topic_slug: null, citations: [], suggested_actions: [{ label: 'Talk to a human advisor', action: 'escalate_to_human' }],
            follow_up_questions: [], needs_escalation: true, confidence: 0
        };
        return await _persistAndPackage({
            conversation, parsed: fallback, llmUsage: null, voiceEnabled,
            startedAt, errorMsg: err.message
        });
    }

    // 5. Parse + persist + TTS
    const parsed = persona.parseAdvisorReply(llmResult.content, trimmed);
    return await _persistAndPackage({
        conversation, parsed, llmUsage: llmResult.usage, voiceEnabled, startedAt
    });
}

async function _persistAndPackage({ conversation, parsed, llmUsage, voiceEnabled, startedAt, errorMsg = null }) {
    // Resolve topic id for tagging
    let topicId = null;
    if (parsed.topic_slug) {
        const topic = await Advisor.findTopicBySlug(parsed.topic_slug);
        topicId = topic?.id || null;
    }

    // TTS
    let audio = { provider: 'none', useBrowserFallback: true };
    if (voiceEnabled !== false && conversation.voice_enabled) {
        audio = await tts.synthesise(parsed.speech_text);
    }

    // Persist advisor turn
    const messageId = await Advisor.addMessage({
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

    return {
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
            provider:           audio.provider,
            audio_url:          audio.audioUrl || null,
            use_browser_fallback: Boolean(audio.useBrowserFallback)
        },
        meta: {
            latency_ms: Date.now() - startedAt,
            tokens_in:  llmUsage?.prompt_tokens || null,
            tokens_out: llmUsage?.completion_tokens || null,
            error:      errorMsg
        }
    };
}

module.exports = { ask };
