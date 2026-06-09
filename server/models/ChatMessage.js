const { query } = require('../../config/db');

class ChatMessage {
    // Create a new message
    static async create(messageData) {
        const {
            sessionId,
            userId,
            messageType = 'text',
            sender,
            content,
            audioUrl = null,
            tokensUsed = 0,
            responseTimeMs = 0,
            referencedDocuments = []
        } = messageData;

        const sql = `
            INSERT INTO chat_messages 
            (session_id, user_id, message_type, sender, content, audio_url, tokens_used, response_time_ms, referenced_documents, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        const result = await query(sql, [
            sessionId,
            userId,
            messageType,
            sender,
            content,
            audioUrl,
            tokensUsed,
            responseTimeMs,
            JSON.stringify(referencedDocuments)
        ]);

        return result.insertId;
    }

    // Get messages for a session
    static async getBySession(sessionId, limit = 50, offset = 0) {
        const sql = `
            SELECT id, message_type, sender, content, audio_url, tokens_used, referenced_documents, created_at
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY created_at ASC
            LIMIT ? OFFSET ?
        `;
        return query(sql, [sessionId, limit, offset]);
    }

    // Get message by ID
    static async findById(id) {
        const sql = 'SELECT * FROM chat_messages WHERE id = ?';
        const results = await query(sql, [id]);
        return results[0] || null;
    }

    // Get recent messages for context
    static async getRecentContext(sessionId, messageCount = 10) {
        const sql = `
            SELECT sender, content
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `;
        const results = await query(sql, [sessionId, messageCount]);
        return results.reverse(); // Return in chronological order
    }

    // Add feedback to a message
    static async addFeedback(messageId, rating, comment = null) {
        const sql = 'UPDATE chat_messages SET feedback_rating = ?, feedback_comment = ? WHERE id = ?';
        const result = await query(sql, [rating, comment, messageId]);
        return result.affectedRows > 0;
    }

    // Get user's chat history
    static async getUserHistory(userId, page = 1, limit = 20) {
        const offset = (page - 1) * limit;
        
        const countSql = `
            SELECT COUNT(*) as total
            FROM chat_messages
            WHERE user_id = ?
        `;
        const countResult = await query(countSql, [userId]);
        const total = countResult[0].total;

        const sql = `
            SELECT cm.*, cs.platform
            FROM chat_messages cm
            JOIN chat_sessions cs ON cm.session_id = cs.id
            WHERE cm.user_id = ?
            ORDER BY cm.created_at DESC
            LIMIT ? OFFSET ?
        `;
        const messages = await query(sql, [userId, limit, offset]);

        return {
            messages,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    // Get conversation export data
    static async exportConversation(sessionId) {
        const sql = `
            SELECT 
                cm.sender,
                cm.content,
                cm.message_type,
                cm.created_at,
                cm.tokens_used,
                u.email as user_email
            FROM chat_messages cm
            LEFT JOIN users u ON cm.user_id = u.id
            WHERE cm.session_id = ?
            ORDER BY cm.created_at ASC
        `;
        return query(sql, [sessionId]);
    }

    // Get usage statistics
    static async getStats(days = 30) {
        const sql = `
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_messages,
                SUM(CASE WHEN sender = 'user' THEN 1 ELSE 0 END) as user_messages,
                SUM(CASE WHEN sender = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
                SUM(tokens_used) as total_tokens,
                AVG(response_time_ms) as avg_response_time
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `;
        return query(sql, [days]);
    }

    // Get frequently asked user questions from chat messages
    static async getFrequentQuestions({
        days = 30,
        minCount = 3,
        limit = 20,
        page = 1,
        minLength = 8,
        maxLength = 300
    } = {}) {
        const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(days, 365)) : 30;
        const safeMinCount = Number.isFinite(minCount) ? Math.max(2, Math.min(minCount, 100)) : 3;
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const offset = (safePage - 1) * safeLimit;
        const safeMinLength = Number.isFinite(minLength) ? Math.max(1, Math.min(minLength, 200)) : 8;
        const safeMaxLength = Number.isFinite(maxLength) ? Math.max(safeMinLength, Math.min(maxLength, 1000)) : 300;

        const normalizedExpr = "LOWER(TRIM(REPLACE(REPLACE(content, '\\n', ' '), '\\r', ' ')))";
        const baseWhere = `
            sender = 'user'
            AND message_type = 'text'
            AND content IS NOT NULL
            AND TRIM(content) <> ''
            AND CHAR_LENGTH(TRIM(content)) >= ?
            AND CHAR_LENGTH(content) <= ?
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        `;
        const baseParams = [safeMinLength, safeMaxLength, safeDays];

        const countSql = `
            SELECT COUNT(*) as total FROM (
                SELECT ${normalizedExpr} AS normalized
                FROM chat_messages
                WHERE ${baseWhere}
                GROUP BY normalized
                HAVING COUNT(*) >= ?
            ) as grouped_questions
        `;
        const countRows = await query(countSql, [...baseParams, safeMinCount]);
        const total = countRows[0]?.total || 0;

        const dataSql = `
            SELECT 
                MIN(content) AS question,
                ${normalizedExpr} AS normalized,
                COUNT(*) AS occurrences,
                MAX(created_at) AS last_asked_at
            FROM chat_messages
            WHERE ${baseWhere}
            GROUP BY normalized
            HAVING COUNT(*) >= ?
            ORDER BY occurrences DESC, last_asked_at DESC
            LIMIT ? OFFSET ?
        `;
        const items = await query(dataSql, [...baseParams, safeMinCount, safeLimit, offset]);

        return {
            items,
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit)
        };
    }

    // Get feedback statistics
    static async getFeedbackStats() {
        const sql = `
            SELECT 
                feedback_rating,
                COUNT(*) as count
            FROM chat_messages
            WHERE feedback_rating IS NOT NULL
            GROUP BY feedback_rating
            ORDER BY feedback_rating
        `;
        return query(sql);
    }

    // Search messages
    static async search(searchQuery, userId = null, limit = 50) {
        let sql = `
            SELECT cm.*, cs.platform
            FROM chat_messages cm
            JOIN chat_sessions cs ON cm.session_id = cs.id
            WHERE cm.content LIKE ?
        `;
        const params = [`%${searchQuery}%`];

        if (userId) {
            sql += ' AND cm.user_id = ?';
            params.push(userId);
        }

        sql += ' ORDER BY cm.created_at DESC LIMIT ?';
        params.push(limit);

        return query(sql, params);
    }

    // Delete old messages (data retention)
    static async cleanOldMessages(daysToKeep = 365) {
        const sql = `
            DELETE FROM chat_messages 
            WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `;
        const result = await query(sql, [daysToKeep]);
        return result.affectedRows;
    }
}

module.exports = ChatMessage;
