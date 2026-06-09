/**
 * Data access for the academic-advisor tables (see migration_advisor.sql).
 * Plain SQL on top of the existing `mysql` pool — no ORM.
 */
const { query } = require('../../config/db');
const crypto = require('crypto');

const Advisor = {
    // -----------------------------------------------------------------------
    // Topics
    // -----------------------------------------------------------------------
    async listTopics() {
        return await query(`
            SELECT id, parent_id, slug, title, description, icon, display_order
            FROM advisor_topics
            WHERE is_active = TRUE
            ORDER BY display_order, title
        `);
    },

    async findTopicBySlug(slug) {
        const rows = await query(
            `SELECT id, slug, title, description FROM advisor_topics WHERE slug = ? LIMIT 1`,
            [slug]
        );
        return rows[0] || null;
    },

    // -----------------------------------------------------------------------
    // Students
    // -----------------------------------------------------------------------
    async findStudentByUserId(userId) {
        if (!userId) return null;
        const rows = await query(
            `SELECT * FROM students WHERE user_id = ? LIMIT 1`,
            [userId]
        );
        return rows[0] || null;
    },

    async findStudentByMatric(matricNo) {
        if (!matricNo) return null;
        const rows = await query(
            `SELECT * FROM students WHERE matric_no = ? LIMIT 1`,
            [matricNo.toUpperCase().trim()]
        );
        return rows[0] || null;
    },

    // -----------------------------------------------------------------------
    // Conversations
    // -----------------------------------------------------------------------
    async createConversation({ studentId = null, title = null, language = 'en-NG', voiceEnabled = true } = {}) {
        const token = crypto.randomUUID();
        const result = await query(
            `INSERT INTO advisor_conversations (student_id, session_token, title, language, voice_enabled)
             VALUES (?, ?, ?, ?, ?)`,
            [studentId, token, title, language, voiceEnabled ? 1 : 0]
        );
        return await this.getConversationById(result.insertId);
    },

    async getConversationById(id) {
        const rows = await query(
            `SELECT * FROM advisor_conversations WHERE id = ? LIMIT 1`,
            [id]
        );
        return rows[0] || null;
    },

    async getConversationByToken(token) {
        if (!token) return null;
        const rows = await query(
            `SELECT * FROM advisor_conversations WHERE session_token = ? LIMIT 1`,
            [token]
        );
        return rows[0] || null;
    },

    async touchConversation(id, topicId = null) {
        await query(
            `UPDATE advisor_conversations
             SET last_active_at = CURRENT_TIMESTAMP,
                 last_topic_id  = COALESCE(?, last_topic_id)
             WHERE id = ?`,
            [topicId, id]
        );
    },

    // -----------------------------------------------------------------------
    // Messages
    // -----------------------------------------------------------------------
    async addMessage(msg) {
        const {
            conversationId,
            role,
            inputMode = 'text',
            text,
            speechText = null,
            displayMarkdown = null,
            audioUrl = null,
            visemesJson = null,
            citationsJson = null,
            suggestedActionsJson = null,
            followUpsJson = null,
            topicId = null,
            latencyMs = null,
            tokensIn = null,
            tokensOut = null
        } = msg;

        const result = await query(
            `INSERT INTO advisor_messages
             (conversation_id, role, input_mode, text, speech_text, display_markdown,
              audio_url, visemes_json, citations_json, suggested_actions_json, follow_ups_json,
              topic_id, latency_ms, tokens_in, tokens_out)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                conversationId, role, inputMode, text, speechText, displayMarkdown,
                audioUrl, visemesJson, citationsJson, suggestedActionsJson, followUpsJson,
                topicId, latencyMs, tokensIn, tokensOut
            ]
        );
        return result.insertId;
    },

    async getRecentMessages(conversationId, limit = 20) {
        return await query(
            `SELECT role, text, speech_text, display_markdown, topic_id, created_at
             FROM advisor_messages
             WHERE conversation_id = ?
             ORDER BY id DESC
             LIMIT ?`,
            [conversationId, limit]
        );
    },

    // -----------------------------------------------------------------------
    // Escalations
    // -----------------------------------------------------------------------
    async createEscalation(data) {
        const {
            studentId = null,
            conversationId = null,
            topicId = null,
            subject,
            message,
            contactEmail = null,
            contactPhone = null,
            priority = 'normal'
        } = data;

        const result = await query(
            `INSERT INTO escalations
             (student_id, conversation_id, topic_id, subject, message, contact_email, contact_phone, priority)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [studentId, conversationId, topicId, subject, message, contactEmail, contactPhone, priority]
        );
        return result.insertId;
    },

    async markEscalationEmailed(id, assignedEmail) {
        await query(
            `UPDATE escalations
             SET email_sent_at = CURRENT_TIMESTAMP, assigned_email = ?
             WHERE id = ?`,
            [assignedEmail, id]
        );
    }
};

module.exports = Advisor;
