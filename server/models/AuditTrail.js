// filepath: /Applications/MAMP/htdocs/bmucia-agent/server/models/AuditTrail.js
const { query } = require('../../config/db');

class AuditTrail {
    // Log an action
    static async log(data) {
        const {
            userId,
            action,
            entityType = null,
            entityId = null,
            details = null,
            ipAddress = null,
            userAgent = null
        } = data;

        const sql = `
            INSERT INTO audit_trail (user_id, action, entity_type, entity_id, details, ip_address, user_agent, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        const result = await query(sql, [
            userId,
            action,
            entityType,
            entityId,
            details ? JSON.stringify(details) : null,
            ipAddress,
            userAgent
        ]);

        return result.insertId;
    }

    // Get audit trail with pagination and filters
    static async getAll(page = 1, limit = 50, filters = {}) {
        const offset = (page - 1) * limit;
        let whereClause = 'WHERE 1=1';
        const params = [];

        if (filters.userId) {
            whereClause += ' AND a.user_id = ?';
            params.push(filters.userId);
        }

        if (filters.action) {
            whereClause += ' AND a.action = ?';
            params.push(filters.action);
        }

        if (filters.entityType) {
            whereClause += ' AND a.entity_type = ?';
            params.push(filters.entityType);
        }

        if (filters.startDate) {
            whereClause += ' AND a.created_at >= ?';
            params.push(filters.startDate);
        }

        if (filters.endDate) {
            whereClause += ' AND a.created_at <= ?';
            params.push(filters.endDate);
        }

        if (filters.search) {
            whereClause += ' AND (a.action LIKE ? OR a.entity_type LIKE ? OR u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        // Count total - must include JOIN when search filter references user fields
        const countSql = `SELECT COUNT(*) as total FROM audit_trail a LEFT JOIN users u ON a.user_id = u.id ${whereClause}`;
        const countResult = await query(countSql, params);
        const total = countResult[0].total;

        // Get records
        params.push(limit, offset);
        const sql = `
            SELECT a.*, u.email as user_email, u.first_name, u.last_name
            FROM audit_trail a
            LEFT JOIN users u ON a.user_id = u.id
            ${whereClause}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        `;

        const logs = await query(sql, params);

        return {
            logs,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    // Get user activity summary
    static async getUserActivity(userId, days = 30) {
        const sql = `
            SELECT 
                action,
                COUNT(*) as count,
                DATE(created_at) as date
            FROM audit_trail
            WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY action, DATE(created_at)
            ORDER BY date DESC, count DESC
        `;

        return query(sql, [userId, days]);
    }

    // Get action statistics
    static async getActionStats(days = 30) {
        const sql = `
            SELECT 
                action,
                COUNT(*) as count
            FROM audit_trail
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY action
            ORDER BY count DESC
        `;

        return query(sql, [days]);
    }

    // Get daily activity counts
    static async getDailyActivity(days = 30) {
        const sql = `
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_actions,
                COUNT(DISTINCT user_id) as unique_users
            FROM audit_trail
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `;

        return query(sql, [days]);
    }

    // Get recent actions for a specific entity
    static async getEntityHistory(entityType, entityId, limit = 20) {
        const sql = `
            SELECT a.*, u.email as user_email, u.first_name, u.last_name
            FROM audit_trail a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE a.entity_type = ? AND a.entity_id = ?
            ORDER BY a.created_at DESC
            LIMIT ?
        `;

        return query(sql, [entityType, entityId, limit]);
    }

    // Export audit trail for a date range
    static async exportByDateRange(startDate, endDate) {
        const sql = `
            SELECT 
                a.id,
                a.created_at,
                u.email as user_email,
                u.first_name,
                u.last_name,
                a.action,
                a.entity_type,
                a.entity_id,
                a.details,
                a.ip_address
            FROM audit_trail a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE a.created_at BETWEEN ? AND ?
            ORDER BY a.created_at DESC
        `;

        return query(sql, [startDate, endDate]);
    }

    // Clean old records (data retention)
    static async cleanOldRecords(daysToKeep = 365) {
        const sql = `
            DELETE FROM audit_trail 
            WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `;
        
        const result = await query(sql, [daysToKeep]);
        return result.affectedRows;
    }
}

module.exports = AuditTrail;
