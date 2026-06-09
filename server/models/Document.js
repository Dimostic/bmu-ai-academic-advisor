// filepath: /Applications/MAMP/htdocs/bmucia-agent/server/models/Document.js
const { query } = require('../../config/db');
const path = require('path');
const fs = require('fs').promises;

class Document {
    // Create a new document record
    static async create(documentData) {
        const {
            title,
            description,
            fileName,
            filePath,
            fileType,
            fileSize,
            category = 'general',
            tags = [],
            uploadedBy
        } = documentData;

        const sql = `
            INSERT INTO documents 
            (title, description, file_name, file_path, file_type, file_size, category, tags, uploaded_by, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        
        const result = await query(sql, [
            title,
            description,
            fileName,
            filePath,
            fileType,
            fileSize,
            category,
            JSON.stringify(tags),
            uploadedBy
        ]);
        
        return result.insertId;
    }

    // Get document by ID
    static async findById(id) {
        const sql = `
            SELECT d.*, u.email as uploaded_by_email, u.first_name as uploaded_by_name
            FROM documents d
            LEFT JOIN users u ON d.uploaded_by = u.id
            WHERE d.id = ? AND d.is_active = TRUE
        `;
        const results = await query(sql, [id]);
        return results[0] || null;
    }

    // Get all documents with pagination and filters
    static async getAll(page = 1, limit = 20, filters = {}) {
        const offset = (page - 1) * limit;
        let whereClause = 'WHERE d.is_active = TRUE';
        const params = [];

        if (filters.category) {
            whereClause += ' AND d.category = ?';
            params.push(filters.category);
        }

        if (filters.embeddingStatus) {
            whereClause += ' AND d.embedding_status = ?';
            params.push(filters.embeddingStatus);
        }

        if (filters.search) {
            whereClause += ' AND (d.title LIKE ? OR d.description LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm);
        }

        // Count total
        const countSql = `SELECT COUNT(*) as total FROM documents d ${whereClause}`;
        const countResult = await query(countSql, params);
        const total = countResult[0].total;

        // Get documents
        params.push(limit, offset);
        const sql = `
            SELECT d.*, u.email as uploaded_by_email, u.first_name as uploaded_by_name
            FROM documents d
            LEFT JOIN users u ON d.uploaded_by = u.id
            ${whereClause}
            ORDER BY d.created_at DESC
            LIMIT ? OFFSET ?
        `;
        
        const documents = await query(sql, params);

        return {
            documents,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    // Update document
    static async update(id, updates) {
        const allowedFields = ['title', 'description', 'category', 'tags'];
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
            if (allowedFields.includes(dbKey)) {
                fields.push(`${dbKey} = ?`);
                values.push(key === 'tags' ? JSON.stringify(value) : value);
            }
        }

        if (fields.length === 0) return false;

        values.push(id);
        const sql = `UPDATE documents SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`;
        const result = await query(sql, values);
        return result.affectedRows > 0;
    }

    // Update embedding status
    static async updateEmbeddingStatus(id, status, embeddingId = null) {
        const sql = 'UPDATE documents SET embedding_status = ?, embedding_id = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [status, embeddingId, id]);
        return result.affectedRows > 0;
    }

    // Update content text (extracted from document)
    static async updateContentText(id, contentText) {
        const sql = 'UPDATE documents SET content_text = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [contentText, id]);
        return result.affectedRows > 0;
    }

    // Update content HTML (preserves document formatting)
    static async updateContentHtml(id, contentHtml) {
        const sql = 'UPDATE documents SET content_html = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [contentHtml, id]);
        return result.affectedRows > 0;
    }

    // Update both content text and HTML
    static async updateContent(id, contentText, contentHtml) {
        const sql = 'UPDATE documents SET content_text = ?, content_html = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [contentText, contentHtml, id]);
        return result.affectedRows > 0;
    }

    // Delete document (soft delete)
    static async delete(id) {
        const sql = 'UPDATE documents SET is_active = FALSE, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    // Hard delete document and file
    static async hardDelete(id) {
        // Get doc including file_path even if already inactive
        const docSql = 'SELECT * FROM documents WHERE id = ?';
        const docs = await query(docSql, [id]);
        const doc = docs[0];
        if (!doc) return false;

        // Best-effort cleanup of dependent rows
        try {
            await query('DELETE FROM document_chunks WHERE document_id = ?', [id]);
        } catch (e) {
            // ignore if table doesn't exist / constraint differs
            try { console.warn('[Document.hardDelete] Cleanup document_chunks failed:', e.message); } catch {}
        }

        try {
            await query('DELETE FROM cached_qa WHERE document_id = ?', [id]);
        } catch (e) {
            try { console.warn('[Document.hardDelete] Cleanup cached_qa failed:', e.message); } catch {}
        }

        // Delete file from filesystem
        try {
            if (doc.file_path) {
                await fs.unlink(doc.file_path);
            }
        } catch (err) {
            console.error('Error deleting file:', err.message);
        }

        const sql = 'DELETE FROM documents WHERE id = ?';
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    // Search documents by content (full-text search)
    static async searchByContent(searchQuery, limit = 10) {
        const sql = `
            SELECT id, title, description, category, 
                   MATCH(title, description, content_text) AGAINST(? IN NATURAL LANGUAGE MODE) as relevance
            FROM documents
            WHERE is_active = TRUE 
              AND embedding_status = 'completed'
              AND MATCH(title, description, content_text) AGAINST(? IN NATURAL LANGUAGE MODE)
            ORDER BY relevance DESC
            LIMIT ?
        `;
        const results = await query(sql, [searchQuery, searchQuery, limit]);
        return results;
    }

    // Get documents by category
    static async getByCategory(category) {
        const sql = `
            SELECT id, title, description, file_type, category, created_at
            FROM documents
            WHERE category = ? AND is_active = TRUE AND embedding_status = 'completed'
            ORDER BY title ASC
        `;
        return query(sql, [category]);
    }

    // Get training ready documents
    static async getTrainingReady() {
        const sql = `
            SELECT id, title, file_path, file_type, content_text
            FROM documents
            WHERE is_active = TRUE AND embedding_status = 'completed' AND content_text IS NOT NULL
        `;
        return query(sql);
    }

    // Get documents pending training
    static async getPendingTraining() {
        const sql = `
            SELECT id, title, file_path, file_type
            FROM documents
            WHERE is_active = TRUE AND embedding_status = 'pending'
        `;
        return query(sql);
    }

    // Get a lightweight list of active documents (optionally filtered by status or IDs)
    static async getActiveList(options = {}) {
        const { embeddingStatus = null, ids = null } = options;
        let whereClause = 'WHERE is_active = TRUE';
        const params = [];

        if (embeddingStatus) {
            whereClause += ' AND embedding_status = ?';
            params.push(embeddingStatus);
        }

        if (Array.isArray(ids) && ids.length > 0) {
            const idList = ids
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0);
            if (idList.length === 0) return [];
            whereClause += ` AND id IN (${idList.map(() => '?').join(', ')})`;
            params.push(...idList);
        }

        const sql = `
            SELECT id, title, category, embedding_status
            FROM documents
            ${whereClause}
            ORDER BY title ASC
        `;
        return query(sql, params);
    }

    // Get document statistics
    static async getStats() {
        const sql = `
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN embedding_status = 'completed' THEN 1 ELSE 0 END) as trained,
                SUM(CASE WHEN embedding_status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN embedding_status = 'processing' THEN 1 ELSE 0 END) as processing,
                SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(file_size) as total_size
            FROM documents
            WHERE is_active = TRUE
        `;
        const results = await query(sql);
        return results[0];
    }

    // Get category statistics
    static async getCategoryStats() {
        const sql = `
            SELECT category, COUNT(*) as count
            FROM documents
            WHERE is_active = TRUE
            GROUP BY category
            ORDER BY count DESC
        `;
        return query(sql);
    }
}

module.exports = Document;
