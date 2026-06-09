const { query } = require('../../config/db');
const { v4: uuidv4 } = require('uuid');

class ChatSession {
    // Create a new chat session
    static async create(userId, platform = 'web') {
        const sessionToken = uuidv4();
        const sql = `
            INSERT INTO chat_sessions (user_id, session_token, platform, created_at)
            VALUES (?, ?, ?, NOW())
        `;
        
        const result = await query(sql, [userId, sessionToken, platform]);
        return {
            id: result.insertId,
            sessionToken,
            platform
        };
    }

    // Find session by token
    static async findByToken(sessionToken) {
        const sql = `
            SELECT cs.*, u.email, u.first_name, u.last_name, u.role
            FROM chat_sessions cs
            JOIN users u ON cs.user_id = u.id
            WHERE cs.session_token = ? AND cs.is_active = TRUE
        `;
        const results = await query(sql, [sessionToken]);
        return results[0] || null;
    }

    // Find session by ID
    static async findById(id) {
        const sql = `
            SELECT cs.*, u.email, u.first_name, u.last_name
            FROM chat_sessions cs
            JOIN users u ON cs.user_id = u.id
            WHERE cs.id = ?
        `;
        const results = await query(sql, [id]);
        return results[0] || null;
    }

    // Get user's active sessions
    static async getUserSessions(userId, platform = null) {
        let sql = `
            SELECT id, session_token, platform, created_at, last_activity
            FROM chat_sessions
            WHERE user_id = ? AND is_active = TRUE
        `;
        const params = [userId];

        if (platform) {
            sql += ' AND platform = ?';
            params.push(platform);
        }

        sql += ' ORDER BY last_activity DESC';
        return query(sql, params);
    }

    // Update last activity
    static async updateActivity(sessionId) {
        const sql = 'UPDATE chat_sessions SET last_activity = NOW() WHERE id = ?';
        await query(sql, [sessionId]);
    }

    // End session
    static async endSession(sessionToken) {
        const sql = 'UPDATE chat_sessions SET is_active = FALSE WHERE session_token = ?';
        const result = await query(sql, [sessionToken]);
        return result.affectedRows > 0;
    }

    // End all user sessions
    static async endAllUserSessions(userId) {
        const sql = 'UPDATE chat_sessions SET is_active = FALSE WHERE user_id = ?';
        const result = await query(sql, [userId]);
        return result.affectedRows;
    }

    // Get session statistics
    static async getStats(days = 30) {
        const sql = `
            SELECT 
                platform,
                COUNT(*) as total_sessions,
                COUNT(DISTINCT user_id) as unique_users
            FROM chat_sessions
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY platform
        `;
        return query(sql, [days]);
    }
}

module.exports = ChatSession;
