const { query } = require('../../config/db');
const path = require('path');
const fs = require('fs').promises;

const DEFAULT_VC_ALLOWED_EMAILS = [
    'bmuapps@bmu.edu.ng',
    'dimie.ogoina@bmu.edu.ng'
];

function getAllowedVcEmails() {
    const raw = String(process.env.VC_REPORTS_ALLOWED_EMAILS || '').trim();
    const list = raw
        ? raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_VC_ALLOWED_EMAILS.slice();
    return Array.from(new Set(list));
}

class VCReport {
    /**
     * Create a new VC report record
     */
    static async create(reportData) {
        const {
            title,
            description,
            category = 'other',
            fileName,
            filePath,
            fileType,
            fileSize,
            submittedBy,
            reportDate,
            department
        } = reportData;

        const sql = `
            INSERT INTO vc_reports 
            (title, description, category, file_name, file_path, file_type, file_size, 
             submitted_by, report_date, department, submitted_at, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `;
        
        const result = await query(sql, [
            title,
            description,
            category,
            fileName,
            filePath,
            fileType,
            fileSize,
            submittedBy,
            reportDate || null,
            department
        ]);
        
        return result.insertId;
    }

    /**
     * Get report by ID
     */
    static async findById(id) {
        const sql = `
            SELECT r.*, 
                   u.email as submitted_by_email, 
                   u.first_name as submitted_by_first_name,
                   u.last_name as submitted_by_last_name,
                   CONCAT(u.first_name, ' ', u.last_name) as submitted_by_name,
                   u.department as submitted_by_department
            FROM vc_reports r
            LEFT JOIN users u ON r.submitted_by = u.id
            WHERE r.id = ? AND r.is_active = TRUE
        `;
        const results = await query(sql, [id]);
        return results[0] || null;
    }

    /**
     * Get all reports with pagination and filters
     */
    static async getAll(page = 1, limit = 20, filters = {}) {
        const offset = (page - 1) * limit;
        let whereClause = 'WHERE r.is_active = TRUE';
        const params = [];

        // Category filter
        if (filters.category) {
            whereClause += ' AND r.category = ?';
            params.push(filters.category);
        }

        // Status filter
        if (filters.processingStatus) {
            whereClause += ' AND r.processing_status = ?';
            params.push(filters.processingStatus);
        }

        // Read/Unread filter
        if (filters.isRead !== undefined) {
            whereClause += ' AND r.is_read = ?';
            params.push(filters.isRead);
        }

        // Starred filter
        if (filters.isStarred !== undefined && filters.isStarred) {
            whereClause += ' AND r.is_starred = TRUE';
        }

        // Archived filter
        if (filters.isArchived !== undefined) {
            whereClause += ' AND r.is_archived = ?';
            params.push(filters.isArchived);
        } else {
            // By default, don't show archived
            whereClause += ' AND r.is_archived = FALSE';
        }

        // Sentiment filter
        if (filters.sentiment) {
            whereClause += ' AND r.ai_sentiment = ?';
            params.push(filters.sentiment);
        }

        // Date range filter
        if (filters.startDate) {
            whereClause += ' AND r.submitted_at >= ?';
            params.push(filters.startDate);
        }
        if (filters.endDate) {
            whereClause += ' AND r.submitted_at <= ?';
            params.push(filters.endDate);
        }

        // Search filter
        if (filters.search) {
            whereClause += ' AND (r.title LIKE ? OR r.description LIKE ? OR r.ai_summary LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        // Submitted by filter
        if (filters.submittedBy) {
            whereClause += ' AND r.submitted_by = ?';
            params.push(filters.submittedBy);
        }

        // Department filter
        if (filters.department) {
            whereClause += ' AND r.department = ?';
            params.push(filters.department);
        }

        // Count total
        const countSql = `SELECT COUNT(*) as total FROM vc_reports r ${whereClause}`;
        const countResult = await query(countSql, params);
        const total = countResult[0].total;

        // Get reports with ordering
        let orderBy = 'r.submitted_at DESC'; // Default: newest first
        if (filters.sortBy) {
            const validSorts = {
                'submitted_at': 'r.submitted_at',
                'title': 'r.title',
                'category': 'r.category',
                'processing_status': 'r.processing_status',
                'is_read': 'r.is_read'
            };
            if (validSorts[filters.sortBy]) {
                orderBy = `${validSorts[filters.sortBy]} ${filters.sortOrder === 'asc' ? 'ASC' : 'DESC'}`;
            }
        }

        // Starred reports first option
        if (filters.starredFirst) {
            orderBy = `r.is_starred DESC, ${orderBy}`;
        }

        const dataSql = `
            SELECT r.*, 
                   u.email as submitted_by_email, 
                   u.first_name as submitted_by_first_name,
                   u.last_name as submitted_by_last_name,
                   CONCAT(u.first_name, ' ', u.last_name) as submitted_by_name,
                   u.department as submitted_by_department
            FROM vc_reports r
            LEFT JOIN users u ON r.submitted_by = u.id
            ${whereClause}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `;
        params.push(limit, offset);
        const reports = await query(dataSql, params);

        return {
            reports,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
    }

    /**
     * Update report
     */
    static async update(id, updateData) {
        const allowedFields = [
            'title', 'description', 'category', 'report_date', 'department',
            'processing_status', 'chunks_count',
            'ai_summary', 'ai_key_points', 'ai_concerns', 'ai_highlights', 
            'ai_recommendations', 'ai_sentiment', 'ai_analyzed_at',
            'is_read', 'read_at', 'is_starred', 'is_archived'
        ];
        
        const updates = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updateData)) {
            const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase to snake_case
            if (allowedFields.includes(dbKey)) {
                updates.push(`${dbKey} = ?`);
                // Handle JSON fields
                if (['ai_key_points', 'ai_concerns', 'ai_highlights', 'ai_recommendations'].includes(dbKey)) {
                    values.push(JSON.stringify(value));
                } else {
                    values.push(value);
                }
            }
        }
        
        if (updates.length === 0) {
            return false;
        }
        
        values.push(id);
        const sql = `UPDATE vc_reports SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`;
        const result = await query(sql, values);
        return result.affectedRows > 0;
    }

    /**
     * Mark report as read
     */
    static async markAsRead(id) {
        const sql = `
            UPDATE vc_reports 
            SET is_read = TRUE, read_at = NOW(), updated_at = NOW() 
            WHERE id = ?
        `;
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    /**
     * Toggle starred status
     */
    static async toggleStarred(id) {
        const sql = `
            UPDATE vc_reports 
            SET is_starred = NOT is_starred, updated_at = NOW() 
            WHERE id = ?
        `;
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    /**
     * Archive report
     */
    static async archive(id) {
        const sql = `
            UPDATE vc_reports 
            SET is_archived = TRUE, updated_at = NOW() 
            WHERE id = ?
        `;
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    /**
     * Unarchive report
     */
    static async unarchive(id) {
        const sql = `
            UPDATE vc_reports 
            SET is_archived = FALSE, updated_at = NOW() 
            WHERE id = ?
        `;
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    /**
     * Delete report (soft delete)
     */
    static async delete(id) {
        const sql = `
            UPDATE vc_reports 
            SET is_active = FALSE, updated_at = NOW() 
            WHERE id = ?
        `;
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    /**
     * Hard delete report and its file
     */
    static async hardDelete(id) {
        // Get file path first
        const report = await this.findById(id);
        if (report && report.file_path) {
            try {
                await fs.unlink(report.file_path);
            } catch (e) {
                console.error(`Failed to delete file: ${report.file_path}`, e.message);
            }
        }
        
        // Delete from database (cascades to chunks)
        const sql = 'DELETE FROM vc_reports WHERE id = ?';
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    /**
     * Get report statistics
     */
    static async getStats() {
        const sql = `
            SELECT 
                COUNT(*) as total_reports,
                SUM(CASE WHEN is_read = FALSE AND is_archived = FALSE THEN 1 ELSE 0 END) as unread_count,
                SUM(CASE WHEN is_starred = TRUE AND is_archived = FALSE THEN 1 ELSE 0 END) as starred_count,
                SUM(CASE WHEN is_archived = TRUE THEN 1 ELSE 0 END) as archived_count,
                SUM(CASE WHEN processing_status = 'completed' THEN 1 ELSE 0 END) as processed_count,
                SUM(CASE WHEN processing_status = 'pending' OR processing_status = 'processing' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN processing_status = 'failed' THEN 1 ELSE 0 END) as failed_count,
                SUM(CASE WHEN ai_sentiment = 'positive' THEN 1 ELSE 0 END) as positive_count,
                SUM(CASE WHEN ai_sentiment = 'negative' THEN 1 ELSE 0 END) as negative_count,
                SUM(CASE WHEN ai_sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral_count,
                SUM(CASE WHEN ai_sentiment = 'mixed' THEN 1 ELSE 0 END) as mixed_count
            FROM vc_reports
            WHERE is_active = TRUE
        `;
        const results = await query(sql);
        return results[0];
    }

    /**
     * Get category breakdown
     */
    static async getCategoryStats() {
        const sql = `
            SELECT 
                category,
                COUNT(*) as count,
                SUM(CASE WHEN is_read = FALSE THEN 1 ELSE 0 END) as unread_count
            FROM vc_reports
            WHERE is_active = TRUE AND is_archived = FALSE
            GROUP BY category
            ORDER BY count DESC
        `;
        return query(sql);
    }

    /**
     * Get recent reports
     */
    static async getRecent(limit = 10) {
        const sql = `
            SELECT r.*, 
                   u.email as submitted_by_email, 
                   CONCAT(u.first_name, ' ', u.last_name) as submitted_by_name
            FROM vc_reports r
            LEFT JOIN users u ON r.submitted_by = u.id
            WHERE r.is_active = TRUE AND r.is_archived = FALSE
            ORDER BY r.submitted_at DESC
            LIMIT ?
        `;
        return query(sql, [limit]);
    }

    /**
     * Get reports with concerns (negative or mixed sentiment)
     */
    static async getReportsWithConcerns(limit = 10) {
        const sql = `
            SELECT r.*, 
                   CONCAT(u.first_name, ' ', u.last_name) as submitted_by_name
            FROM vc_reports r
            LEFT JOIN users u ON r.submitted_by = u.id
            WHERE r.is_active = TRUE 
              AND r.is_archived = FALSE
              AND (r.ai_sentiment = 'negative' OR r.ai_sentiment = 'mixed')
            ORDER BY r.submitted_at DESC
            LIMIT ?
        `;
        return query(sql, [limit]);
    }

    /**
     * Update processing status
     */
    static async updateProcessingStatus(id, status, chunksCount = null) {
        let sql = `UPDATE vc_reports SET processing_status = ?, updated_at = NOW()`;
        const params = [status];
        
        if (chunksCount !== null) {
            sql += ', chunks_count = ?';
            params.push(chunksCount);
        }
        
        sql += ' WHERE id = ?';
        params.push(id);
        
        const result = await query(sql, params);
        return result.affectedRows > 0;
    }

    /**
     * Save AI analysis results
     */
    static async saveAnalysis(id, analysis) {
        const sql = `
            UPDATE vc_reports 
            SET ai_summary = ?,
                ai_key_points = ?,
                ai_concerns = ?,
                ai_highlights = ?,
                ai_recommendations = ?,
                ai_sentiment = ?,
                ai_analyzed_at = NOW(),
                updated_at = NOW()
            WHERE id = ?
        `;
        const result = await query(sql, [
            analysis.summary,
            JSON.stringify(analysis.keyPoints || []),
            JSON.stringify(analysis.concerns || []),
            JSON.stringify(analysis.highlights || []),
            JSON.stringify(analysis.recommendations || []),
            analysis.sentiment || 'neutral',
            id
        ]);
        return result.affectedRows > 0;
    }

    /**
     * Check if user has VC reports access
     */
    static async checkUserAccess(userId) {
        const sql = `
            SELECT role, email
            FROM users 
            WHERE id = ? AND is_active = TRUE
        `;
        const results = await query(sql, [userId]);
        if (!results[0]) return false;
        
        const user = results[0];
        const allowedEmails = new Set(getAllowedVcEmails());
        const userEmail = String(user.email || '').toLowerCase();

        // Superadmins always have access
        if (user.role === 'superadmin') return true;
        // Allow only specific whitelisted emails
        return allowedEmails.has(userEmail);
    }

    /**
     * Get allowed VC report emails from config
     */
    static getAllowedEmails() {
        return getAllowedVcEmails();
    }

    /**
     * Check if an email has VC reports access (superadmin + allowed list)
     */
    static async checkEmailAccess(email) {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!normalizedEmail) {
            return {
                hasAccess: false,
                normalizedEmail: '',
                allowedByWhitelist: false,
                user: null
            };
        }

        const sql = `
            SELECT id, email, role
            FROM users 
            WHERE email = ? AND is_active = TRUE
            LIMIT 1
        `;
        const results = await query(sql, [normalizedEmail]);
        const user = results[0] || null;

        const allowedEmails = new Set(getAllowedVcEmails());
        const allowedByWhitelist = allowedEmails.has(normalizedEmail);
        const hasAccess = (user && user.role === 'superadmin') || allowedByWhitelist;

        return {
            hasAccess,
            normalizedEmail,
            allowedByWhitelist,
            user: user
                ? { id: user.id, email: user.email, role: user.role }
                : null
        };
    }

    /**
     * Grant VC reports access to a user
     */
    static async grantAccess(userId) {
        const sql = `UPDATE users SET vc_reports_access = TRUE WHERE id = ?`;
        const result = await query(sql, [userId]);
        return result.affectedRows > 0;
    }

    /**
     * Revoke VC reports access from a user
     */
    static async revokeAccess(userId) {
        const sql = `UPDATE users SET vc_reports_access = FALSE WHERE id = ?`;
        const result = await query(sql, [userId]);
        return result.affectedRows > 0;
    }

    /**
     * Get users with VC reports access
     */
    static async getUsersWithAccess() {
        const allowedEmails = getAllowedVcEmails();
        let sql = `
            SELECT id, email, first_name, last_name, role, department
            FROM users 
            WHERE is_active = TRUE
              AND (role = 'superadmin'
        `;
        const params = [];
        if (allowedEmails.length > 0) {
            sql += ' OR email IN (?)';
            params.push(allowedEmails);
        }
        sql += ') ORDER BY role, first_name';
        return query(sql, params);
    }

    /**
     * Get all departments that have submitted reports
     */
    static async getDepartments() {
        const sql = `
            SELECT DISTINCT department 
            FROM vc_reports 
            WHERE department IS NOT NULL AND department != '' AND is_active = TRUE
            ORDER BY department
        `;
        const results = await query(sql);
        return results.map(r => r.department);
    }
}

module.exports = VCReport;
