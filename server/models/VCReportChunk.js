const { query } = require('../../config/db');

class VCReportChunk {
    /**
     * Delete all chunks for a report
     */
    static async deleteByReportId(reportId) {
        const sql = 'DELETE FROM vc_report_chunks WHERE report_id = ?';
        const res = await query(sql, [reportId]);
        return res.affectedRows || 0;
    }

    /**
     * Insert a chunk
     */
    static async insertChunk({ reportId, chunkIndex, content, embedding }) {
        const sql = `
            INSERT INTO vc_report_chunks (report_id, chunk_index, content, embedding, created_at)
            VALUES (?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                content = VALUES(content),
                embedding = VALUES(embedding)
        `;
        const res = await query(sql, [reportId, chunkIndex, content, JSON.stringify(embedding)]);
        return res.insertId || null;
    }

    /**
     * Insert multiple chunks at once
     */
    static async insertChunks(reportId, chunks) {
        if (!chunks || chunks.length === 0) return 0;
        
        const sql = `
            INSERT INTO vc_report_chunks (report_id, chunk_index, content, embedding, created_at)
            VALUES ?
        `;
        
        const values = chunks.map((chunk, index) => [
            reportId,
            chunk.chunkIndex !== undefined ? chunk.chunkIndex : index,
            chunk.content,
            JSON.stringify(chunk.embedding || []),
            new Date()
        ]);
        
        const res = await query(sql, [values]);
        return res.affectedRows || 0;
    }

    /**
     * Get all chunks for a report
     */
    static async getChunksByReportId(reportId) {
        const sql = `
            SELECT id, report_id, chunk_index, content, embedding 
            FROM vc_report_chunks 
            WHERE report_id = ? 
            ORDER BY chunk_index ASC
        `;
        return query(sql, [reportId]);
    }

    /**
     * Get chunk content by report ID (without embeddings for display)
     */
    static async getContentByReportId(reportId) {
        const sql = `
            SELECT chunk_index, content 
            FROM vc_report_chunks 
            WHERE report_id = ? 
            ORDER BY chunk_index ASC
        `;
        return query(sql, [reportId]);
    }

    /**
     * Get full text content of a report
     */
    static async getFullText(reportId) {
        const chunks = await this.getContentByReportId(reportId);
        return chunks.map(c => c.content).join('\n\n');
    }

    /**
     * Get chunk count for a report
     */
    static async getChunkCount(reportId) {
        const sql = 'SELECT COUNT(*) as count FROM vc_report_chunks WHERE report_id = ?';
        const results = await query(sql, [reportId]);
        return results[0]?.count || 0;
    }

    /**
     * Search chunks by content (keyword search)
     */
    static async searchByContent(reportId, searchTerm, limit = 10) {
        const sql = `
            SELECT id, report_id, chunk_index, content
            FROM vc_report_chunks
            WHERE report_id = ? AND content LIKE ?
            ORDER BY chunk_index ASC
            LIMIT ?
        `;
        return query(sql, [reportId, `%${searchTerm}%`, limit]);
    }

    /**
     * Get chunks with embeddings for semantic search
     */
    static async getChunksWithEmbeddings(reportId) {
        const sql = `
            SELECT id, report_id, chunk_index, content, embedding
            FROM vc_report_chunks
            WHERE report_id = ? AND embedding IS NOT NULL
            ORDER BY chunk_index ASC
        `;
        const results = await query(sql, [reportId]);
        
        // Parse embeddings
        return results.map(row => ({
            ...row,
            embedding: row.embedding ? JSON.parse(row.embedding) : null
        }));
    }

    /**
     * Get all chunks across all reports with embeddings (for vector search)
     */
    static async getAllChunksWithEmbeddings() {
        const sql = `
            SELECT c.id, c.report_id, c.chunk_index, c.content, c.embedding,
                   r.title as report_title, r.category as report_category
            FROM vc_report_chunks c
            JOIN vc_reports r ON c.report_id = r.id
            WHERE r.is_active = TRUE AND c.embedding IS NOT NULL
            ORDER BY c.report_id, c.chunk_index
        `;
        const results = await query(sql);
        
        return results.map(row => ({
            ...row,
            embedding: row.embedding ? JSON.parse(row.embedding) : null
        }));
    }
}

module.exports = VCReportChunk;
