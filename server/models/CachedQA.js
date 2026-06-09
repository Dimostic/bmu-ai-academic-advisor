const { query } = require('../../config/db');

class CachedQA {
    /**
     * Create a new cached Q&A pair
     */
    static async create({ documentId, categoryId, question, questionVariations, answer, answerSources, embedding, confidenceScore, createdBy, qaType }) {
        const result = await query(
            `INSERT INTO cached_qa 
             (document_id, category_id, question, question_variations, answer, answer_sources, embedding, confidence_score, created_by, qa_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                documentId || null,
                categoryId || null,
                question,
                JSON.stringify(questionVariations || []),
                answer,
                JSON.stringify(answerSources || []),
                embedding ? JSON.stringify(embedding) : null,
                confidenceScore || 1.0,
                createdBy || null,
                qaType || 'general'
            ]
        );
        return result.insertId;
    }

    /**
     * Create multiple Q&A pairs in batch
     */
    static async createBatch(qaItems) {
        if (!qaItems || qaItems.length === 0) return [];
        
        const values = qaItems.map(qa => [
            qa.documentId || null,
            qa.categoryId || null,
            qa.question,
            JSON.stringify(qa.questionVariations || []),
            qa.answer,
            JSON.stringify(qa.answerSources || []),
            qa.embedding ? JSON.stringify(qa.embedding) : null,
            qa.confidenceScore || 1.0,
            qa.createdBy || null,
            qa.qaType || 'general'
        ]);

        const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const flatValues = values.flat();

        const result = await query(
            `INSERT INTO cached_qa 
             (document_id, category_id, question, question_variations, answer, answer_sources, embedding, confidence_score, created_by, qa_type)
             VALUES ${placeholders}`,
            flatValues
        );
        
        // Return array of inserted IDs
        const insertedIds = [];
        for (let i = 0; i < qaItems.length; i++) {
            insertedIds.push(result.insertId + i);
        }
        return insertedIds;
    }

    /**
     * Find by ID
     */
    static async findById(id) {
        const rows = await query('SELECT * FROM cached_qa WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this._parseRow(rows[0]);
    }

    /**
     * Get all active Q&A pairs with pagination
     */
    static async findAll({ page = 1, limit = 20, categoryId, documentId, isVerified, search }) {
        let sql = `
            SELECT cq.*, fc.name as category_name, d.title as document_title,
                   u.first_name as verified_by_name
            FROM cached_qa cq
            LEFT JOIN faq_categories fc ON fc.id = cq.category_id
            LEFT JOIN documents d ON d.id = cq.document_id
            LEFT JOIN users u ON u.id = cq.verified_by
            WHERE cq.is_active = TRUE
        `;
        const params = [];

        if (categoryId) {
            sql += ' AND cq.category_id = ?';
            params.push(categoryId);
        }
        if (documentId) {
            sql += ' AND cq.document_id = ?';
            params.push(documentId);
        }
        if (isVerified !== undefined) {
            sql += ' AND cq.is_verified = ?';
            params.push(isVerified);
        }
        if (search) {
            sql += ' AND MATCH(cq.question) AGAINST(? IN NATURAL LANGUAGE MODE)';
            params.push(search);
        }

        // Get total count - use a separate simple count query
        const countSql = `
            SELECT COUNT(*) as total 
            FROM cached_qa cq
            WHERE cq.is_active = TRUE
            ${categoryId ? ' AND cq.category_id = ?' : ''}
            ${documentId ? ' AND cq.document_id = ?' : ''}
            ${isVerified !== undefined ? ' AND cq.is_verified = ?' : ''}
            ${search ? ' AND MATCH(cq.question) AGAINST(? IN NATURAL LANGUAGE MODE)' : ''}
        `;
        const countResult = await query(countSql, params);
        const total = countResult[0]?.total || 0;

        // Add pagination
        sql += ' ORDER BY cq.usage_count DESC, cq.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, (page - 1) * limit);

        const rows = await query(sql, params);
        return {
            items: rows.map(r => this._parseRow(r)),
            total,
            page,
            totalPages: Math.ceil(total / limit)
        };
    }

    /**
     * Search for similar questions using full-text search
     */
    static async searchByQuestion(questionText, limit = 5) {
        const rows = await query(
            `SELECT *, 
                    MATCH(question) AGAINST(? IN NATURAL LANGUAGE MODE) as relevance
             FROM cached_qa 
             WHERE is_active = TRUE 
               AND MATCH(question) AGAINST(? IN NATURAL LANGUAGE MODE)
             ORDER BY relevance DESC
             LIMIT ?`,
            [questionText, questionText, limit]
        );
        return rows.map(r => this._parseRow(r));
    }

    /**
     * Get Q&A by document
     */
    static async findByDocument(documentId) {
        const rows = await query(
            'SELECT * FROM cached_qa WHERE document_id = ? AND is_active = TRUE ORDER BY created_at ASC',
            [documentId]
        );
        return rows.map(r => this._parseRow(r));
    }

    /**
     * Get Q&A by category
     */
    static async findByCategory(categoryId, limit = 50) {
        const rows = await query(
            `SELECT cq.*, d.title as document_title 
             FROM cached_qa cq
             LEFT JOIN documents d ON d.id = cq.document_id
             WHERE cq.category_id = ? AND cq.is_active = TRUE 
             ORDER BY cq.usage_count DESC, cq.created_at ASC
             LIMIT ?`,
            [categoryId, limit]
        );
        return rows.map(r => this._parseRow(r));
    }

    /**
     * Get popular FAQs (most used)
     */
    static async getPopular(limit = 10) {
        const rows = await query(
            `SELECT cq.*, fc.name as category_name, d.title as document_title
             FROM cached_qa cq
             LEFT JOIN faq_categories fc ON fc.id = cq.category_id
             LEFT JOIN documents d ON d.id = cq.document_id
             WHERE cq.is_active = TRUE AND cq.usage_count > 0
             ORDER BY cq.usage_count DESC
             LIMIT ?`,
            [limit]
        );
        return rows.map(r => this._parseRow(r));
    }

    /**
     * Update a Q&A pair
     */
    static async update(id, updates) {
        const allowedFields = ['question', 'question_variations', 'answer', 'answer_sources', 
                              'category_id', 'confidence_score', 'is_active', 'is_verified'];
        
        const setClauses = [];
        const params = [];
        
        for (const [key, value] of Object.entries(updates)) {
            const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase to snake_case
            if (allowedFields.includes(dbKey)) {
                setClauses.push(`${dbKey} = ?`);
                if (dbKey.includes('variations') || dbKey.includes('sources')) {
                    params.push(JSON.stringify(value));
                } else {
                    params.push(value);
                }
            }
        }

        if (setClauses.length === 0) return false;

        params.push(id);
        await query(
            `UPDATE cached_qa SET ${setClauses.join(', ')} WHERE id = ?`,
            params
        );
        return true;
    }

    /**
     * Verify a Q&A pair (admin approval)
     */
    static async verify(id, userId) {
        await query(
            `UPDATE cached_qa SET is_verified = TRUE, verified_by = ?, verified_at = NOW() WHERE id = ?`,
            [userId, id]
        );
        return true;
    }

    /**
     * Record usage (when a cached answer is served)
     */
    static async recordUsage(id) {
        await query(
            'UPDATE cached_qa SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?',
            [id]
        );
    }

    /**
     * Log a cache hit for analytics
     */
    static async logCacheHit({ cachedQaId, userId, sessionId, userQuery, similarityScore, responseTimeMs }) {
        await query(
            `INSERT INTO qa_cache_hits 
             (cached_qa_id, user_id, session_id, user_query, similarity_score, response_time_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [cachedQaId, userId || null, sessionId || null, userQuery, similarityScore, responseTimeMs]
        );
    }

    /**
     * Get cache hit analytics
     */
    static async getCacheAnalytics(days = 30) {
        const stats = await query(`
            SELECT 
                COUNT(*) as total_hits,
                COUNT(DISTINCT cached_qa_id) as unique_questions_hit,
                AVG(similarity_score) as avg_similarity,
                AVG(response_time_ms) as avg_response_time,
                SUM(CASE WHEN was_helpful = TRUE THEN 1 ELSE 0 END) as helpful_count,
                SUM(CASE WHEN was_helpful = FALSE THEN 1 ELSE 0 END) as not_helpful_count
            FROM qa_cache_hits
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [days]);

        const topHits = await query(`
            SELECT cq.id, cq.question, COUNT(qh.id) as hit_count, AVG(qh.similarity_score) as avg_score
            FROM cached_qa cq
            JOIN qa_cache_hits qh ON qh.cached_qa_id = cq.id
            WHERE qh.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY cq.id
            ORDER BY hit_count DESC
            LIMIT 10
        `, [days]);

        return {
            summary: stats[0],
            topHits
        };
    }

    /**
     * Delete Q&A pairs for a document
     */
    static async deleteByDocument(documentId) {
        const result = await query('DELETE FROM cached_qa WHERE document_id = ?', [documentId]);
        return result.affectedRows;
    }

    /**
     * Soft delete (deactivate)
     */
    static async deactivate(id) {
        await query('UPDATE cached_qa SET is_active = FALSE WHERE id = ?', [id]);
        return true;
    }

    /**
     * Get all embeddings for vector search
     */
    static async getAllEmbeddings() {
        const rows = await query(
            'SELECT id, question, embedding FROM cached_qa WHERE is_active = TRUE AND embedding IS NOT NULL'
        );
        return rows.map(r => ({
            id: r.id,
            question: r.question,
            embedding: JSON.parse(r.embedding)
        }));
    }

    /**
     * Parse database row
     */
    static _parseRow(row) {
        if (!row) return null;
        return {
            id: row.id,
            documentId: row.document_id,
            categoryId: row.category_id,
            categoryName: row.category_name,
            documentTitle: row.document_title,
            question: row.question,
            questionVariations: row.question_variations ? JSON.parse(row.question_variations) : [],
            answer: row.answer,
            answerSources: row.answer_sources ? JSON.parse(row.answer_sources) : [],
            confidenceScore: parseFloat(row.confidence_score) || 1.0,
            usageCount: row.usage_count || 0,
            lastUsedAt: row.last_used_at,
            isVerified: Boolean(row.is_verified),
            verifiedBy: row.verified_by,
            verifiedByName: row.verified_by_name,
            verifiedAt: row.verified_at,
            isActive: Boolean(row.is_active),
            createdBy: row.created_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            relevance: row.relevance
        };
    }
}

module.exports = CachedQA;
