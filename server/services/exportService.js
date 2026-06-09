const { query } = require('../../config/db');
const fs = require('fs').promises;
const path = require('path');
const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');

class ExportService {
    constructor() {
        this.exportDir = path.join(__dirname, '../../uploads/exports');
    }

    // Create export request record
    async createExportRequest(userId, exportType, format, filters = {}) {
        const sql = `
            INSERT INTO export_requests (user_id, export_type, format, filters, status, created_at)
            VALUES (?, ?, ?, ?, 'pending', NOW())
        `;
        const result = await query(sql, [userId, exportType, format, JSON.stringify(filters)]);
        return result.insertId;
    }

    // Update export request status
    async updateExportStatus(requestId, status, filePath = null, errorMessage = null) {
        const sql = `
            UPDATE export_requests 
            SET status = ?, file_path = ?, error_message = ?, 
                completed_at = ${status === 'completed' || status === 'failed' ? 'NOW()' : 'NULL'}
            WHERE id = ?
        `;
        await query(sql, [status, filePath, errorMessage, requestId]);
    }

    // Export chat history
    async exportChatHistory(userId, filters = {}, format = 'csv') {
        let sql = `
            SELECT 
                cm.id,
                cs.session_token,
                cs.platform,
                u.email as user_email,
                cm.sender,
                cm.content,
                cm.message_type,
                cm.tokens_used,
                cm.created_at
            FROM chat_messages cm
            JOIN chat_sessions cs ON cm.session_id = cs.id
            LEFT JOIN users u ON cm.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (filters.userId) {
            sql += ' AND cm.user_id = ?';
            params.push(filters.userId);
        }

        if (filters.startDate) {
            sql += ' AND cm.created_at >= ?';
            params.push(filters.startDate);
        }

        if (filters.endDate) {
            sql += ' AND cm.created_at <= ?';
            params.push(filters.endDate);
        }

        if (filters.platform) {
            sql += ' AND cs.platform = ?';
            params.push(filters.platform);
        }

        sql += ' ORDER BY cm.created_at DESC';

        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(parseInt(filters.limit));
        }

        const data = await query(sql, params);
        return this.formatExport(data, format, 'chat_history');
    }

    // Export documents list
    async exportDocuments(filters = {}, format = 'csv') {
        let sql = `
            SELECT 
                d.id,
                d.title,
                d.description,
                d.file_name,
                d.file_type,
                d.file_size,
                d.category,
                d.embedding_status,
                u.email as uploaded_by,
                d.created_at,
                d.updated_at
            FROM documents d
            LEFT JOIN users u ON d.uploaded_by = u.id
            WHERE d.is_active = TRUE
        `;
        const params = [];

        if (filters.category) {
            sql += ' AND d.category = ?';
            params.push(filters.category);
        }

        if (filters.status) {
            sql += ' AND d.embedding_status = ?';
            params.push(filters.status);
        }

        sql += ' ORDER BY d.created_at DESC';

        const data = await query(sql, params);
        return this.formatExport(data, format, 'documents');
    }

    // Export users list (admin only)
    async exportUsers(filters = {}, format = 'csv') {
        let sql = `
            SELECT 
                id,
                email,
                first_name,
                last_name,
                phone,
                department,
                role,
                is_verified,
                last_login,
                created_at
            FROM users
            WHERE is_active = TRUE
        `;
        const params = [];

        if (filters.role) {
            sql += ' AND role = ?';
            params.push(filters.role);
        }

        sql += ' ORDER BY created_at DESC';

        const data = await query(sql, params);
        return this.formatExport(data, format, 'users');
    }

    // Export audit trail (superadmin only)
    async exportAuditTrail(filters = {}, format = 'csv') {
        let sql = `
            SELECT 
                a.id,
                a.created_at as timestamp,
                u.email as user_email,
                a.action,
                a.entity_type,
                a.entity_id,
                a.ip_address,
                a.details
            FROM audit_trail a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (filters.startDate) {
            sql += ' AND a.created_at >= ?';
            params.push(filters.startDate);
        }

        if (filters.endDate) {
            sql += ' AND a.created_at <= ?';
            params.push(filters.endDate);
        }

        if (filters.action) {
            sql += ' AND a.action = ?';
            params.push(filters.action);
        }

        sql += ' ORDER BY a.created_at DESC';

        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(parseInt(filters.limit));
        }

        const data = await query(sql, params);
        return this.formatExport(data, format, 'audit_trail');
    }

    // Export analytics summary
    async exportAnalytics(filters = {}, format = 'csv') {
        const days = filters.days || 30;

        // Get various analytics
        const userStats = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as new_users,
                SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff_count,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admin_count
            FROM users
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, [days]);

        const chatStats = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_messages,
                SUM(tokens_used) as tokens_used,
                AVG(response_time_ms) as avg_response_time
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, [days]);

        const documentStats = await query(`
            SELECT 
                category,
                COUNT(*) as count,
                SUM(CASE WHEN embedding_status = 'completed' THEN 1 ELSE 0 END) as trained
            FROM documents
            WHERE is_active = TRUE
            GROUP BY category
        `);

        // For CSV export, flatten to daily chat stats (most useful tabular data)
        if (format === 'csv') {
            const flatData = chatStats.map(row => ({
                date: row.date,
                total_messages: row.total_messages || 0,
                tokens_used: row.tokens_used || 0,
                avg_response_time_ms: Math.round(row.avg_response_time || 0)
            }));
            return this.formatExport(flatData, format, 'analytics');
        }

        // For JSON, include all nested data
        const combined = {
            period: `Last ${days} days`,
            generatedAt: new Date().toISOString(),
            userStats,
            chatStats,
            documentStats
        };

        return this.formatExport([combined], format, 'analytics');
    }

    // Format data for export
    async formatExport(data, format, filename) {
        const uniqueFilename = `${filename}_${uuidv4()}`;
        let filePath;

        switch (format) {
            case 'csv':
                filePath = await this.exportToCSV(data, uniqueFilename);
                break;
            case 'xlsx':
                filePath = await this.exportToExcel(data, uniqueFilename);
                break;
            case 'json':
                filePath = await this.exportToJSON(data, uniqueFilename);
                break;
            default:
                filePath = await this.exportToCSV(data, uniqueFilename);
        }

        return {
            filePath,
            filename: path.basename(filePath),
            recordCount: data.length
        };
    }

    // Export to CSV
    async exportToCSV(data, filename) {
        if (data.length === 0) {
            const filePath = path.join(this.exportDir, `${filename}.csv`);
            await fs.writeFile(filePath, 'No data available');
            return filePath;
        }

        const headers = Object.keys(data[0]);
        const csvRows = [headers.join(',')];

        for (const row of data) {
            const values = headers.map(header => {
                let val = row[header];
                if (val === null || val === undefined) val = '';
                if (typeof val === 'object') val = JSON.stringify(val);
                val = String(val).replace(/"/g, '""');
                return `"${val}"`;
            });
            csvRows.push(values.join(','));
        }

        const filePath = path.join(this.exportDir, `${filename}.csv`);
        await fs.writeFile(filePath, csvRows.join('\n'));
        return filePath;
    }

    // Export to Excel
    async exportToExcel(data, filename) {
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.json_to_sheet(data);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Data');

        const filePath = path.join(this.exportDir, `${filename}.xlsx`);
        xlsx.writeFile(workbook, filePath);
        return filePath;
    }

    // Export to JSON
    async exportToJSON(data, filename) {
        const filePath = path.join(this.exportDir, `${filename}.json`);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        return filePath;
    }

    // Get export request by ID
    async getExportRequest(requestId) {
        const sql = 'SELECT * FROM export_requests WHERE id = ?';
        const results = await query(sql, [requestId]);
        return results[0] || null;
    }

    // Get user's export requests
    async getUserExports(userId, page = 1, limit = 20) {
        const offset = (page - 1) * limit;
        const sql = `
            SELECT * FROM export_requests
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `;
        return query(sql, [userId, limit, offset]);
    }

    // Clean old export files
    async cleanOldExports(maxAgeDays = 7) {
        try {
            const files = await fs.readdir(this.exportDir);
            const now = Date.now();
            const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
            let deletedCount = 0;

            for (const file of files) {
                const filePath = path.join(this.exportDir, file);
                const stats = await fs.stat(filePath);
                
                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filePath);
                    deletedCount++;
                }
            }

            return { deletedCount };
        } catch (error) {
            return { deletedCount: 0, error: error.message };
        }
    }
}

module.exports = new ExportService();
