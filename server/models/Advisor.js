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

    async ensureStudentForUser(user = null) {
        if (!user?.id) return null;

        const existing = await this.findStudentByUserId(user.id);
        if (existing?.id) return existing;

        const first = (user.first_name || user.firstName || '').trim();
        const last = (user.last_name || user.lastName || '').trim();
        const email = (user.email || '').trim() || null;
        const fullName = `${first} ${last}`.trim() || email || `BMU User ${user.id}`;

        // students.matric_no is required+unique, so generate a stable
        // synthetic value for self-registered users without a formal matric.
        let matric = `USR/${user.id}`;
        try {
            await query(
                `INSERT INTO students (user_id, matric_no, full_name, email, is_active)
                 VALUES (?, ?, ?, ?, TRUE)`,
                [user.id, matric, fullName, email]
            );
        } catch (err) {
            // Collision fallback (very rare): append a short time suffix.
            if (!/duplicate/i.test(String(err?.message || ''))) throw err;
            matric = `USR/${user.id}/${Date.now().toString().slice(-6)}`;
            await query(
                `INSERT INTO students (user_id, matric_no, full_name, email, is_active)
                 VALUES (?, ?, ?, ?, TRUE)`,
                [user.id, matric, fullName, email]
            );
        }

        return await this.findStudentByUserId(user.id);
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

    async getConversationByTokenForStudent(token, studentId) {
        if (!token || !studentId) return null;
        const rows = await query(
            `SELECT *
             FROM advisor_conversations
             WHERE session_token = ? AND student_id = ?
             LIMIT 1`,
            [token, studentId]
        );
        return rows[0] || null;
    },

    async listConversationsByStudentId(studentId, limit = 20) {
        if (!studentId) return [];
        const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
        return await query(
            `SELECT c.id,
                    c.session_token,
                    c.title,
                    c.last_active_at,
                    c.created_at,
                    (
                        SELECT m.text
                        FROM advisor_messages m
                        WHERE m.conversation_id = c.id
                        ORDER BY m.id DESC
                        LIMIT 1
                    ) AS last_message,
                    (
                        SELECT m.text
                        FROM advisor_messages m
                        WHERE m.conversation_id = c.id AND m.role = 'student'
                        ORDER BY m.id ASC
                        LIMIT 1
                    ) AS first_question,
                    (
                        SELECT COUNT(*)
                        FROM advisor_messages m
                        WHERE m.conversation_id = c.id
                    ) AS message_count
             FROM advisor_conversations c
             WHERE c.student_id = ?
             ORDER BY c.last_active_at DESC, c.id DESC
             LIMIT ?`,
            [studentId, safeLimit]
        );
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

    async getConversationMessages(conversationId, limit = 120) {
        const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 120));
        return await query(
            `SELECT role, text, speech_text, display_markdown, topic_id, created_at
             FROM (
                SELECT id, role, text, speech_text, display_markdown, topic_id, created_at
                FROM advisor_messages
                WHERE conversation_id = ?
                ORDER BY id DESC
                LIMIT ?
             ) AS recent
             ORDER BY recent.id ASC`,
            [conversationId, safeLimit]
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
