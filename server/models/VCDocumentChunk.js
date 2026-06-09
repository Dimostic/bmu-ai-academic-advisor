const { query } = require('../../config/db');

class VCDocumentChunk {
    /**
     * Delete all chunks for a document
     */
    static async deleteByDocumentId(documentId) {
        const sql = 'DELETE FROM vc_document_chunks WHERE document_id = ?';
        const res = await query(sql, [documentId]);
        return res.affectedRows || 0;
    }

    /**
     * Insert a chunk
     */
    static async insertChunk({ documentId, chunkIndex, content, embedding }) {
        const sql = `
            INSERT INTO vc_document_chunks (document_id, chunk_index, content, embedding, created_at)
            VALUES (?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                content = VALUES(content),
                embedding = VALUES(embedding)
        `;
        const res = await query(sql, [documentId, chunkIndex, content, JSON.stringify(embedding)]);
        return res.insertId || null;
    }

    /**
     * Insert multiple chunks at once
     */
    static async insertChunks(documentId, chunks) {
        if (!chunks || chunks.length === 0) return 0;
        
        const sql = `
            INSERT INTO vc_document_chunks (document_id, chunk_index, content, embedding, created_at)
            VALUES ?
        `;
        
        const values = chunks.map((chunk, index) => [
            documentId,
            chunk.chunkIndex !== undefined ? chunk.chunkIndex : index,
            chunk.content,
            JSON.stringify(chunk.embedding || []),
            new Date()
        ]);
        
        const res = await query(sql, [values]);
        return res.affectedRows || 0;
    }

    /**
     * Get all chunks for a document
     */
    static async getChunksByDocumentId(documentId) {
        const sql = `
            SELECT id, document_id, chunk_index, content, embedding 
            FROM vc_document_chunks 
            WHERE document_id = ? 
            ORDER BY chunk_index ASC
        `;
        return query(sql, [documentId]);
    }

    /**
     * Get chunk content by document ID (without embeddings for display)
     */
    static async getContentByDocumentId(documentId) {
        const sql = `
            SELECT chunk_index, content 
            FROM vc_document_chunks 
            WHERE document_id = ? 
            ORDER BY chunk_index ASC
        `;
        return query(sql, [documentId]);
    }

    /**
     * Get full text content of a document
     */
    static async getFullText(documentId) {
        const chunks = await this.getContentByDocumentId(documentId);
        return chunks.map(c => c.content).join('\n\n');
    }

    /**
     * Get chunk count for a document
     */
    static async getChunkCount(documentId) {
        const sql = 'SELECT COUNT(*) as count FROM vc_document_chunks WHERE document_id = ?';
        const results = await query(sql, [documentId]);
        return results[0]?.count || 0;
    }

    /**
     * Search chunks by content (keyword search)
     */
    static async searchByContent(documentId, searchTerm, limit = 10) {
        const sql = `
            SELECT id, document_id, chunk_index, content
            FROM vc_document_chunks
            WHERE document_id = ? AND content LIKE ?
            ORDER BY chunk_index ASC
            LIMIT ?
        `;
        return query(sql, [documentId, `%${searchTerm}%`, limit]);
    }

    /**
     * Get chunks with embeddings for semantic search
     */
    static async getChunksWithEmbeddings(documentId) {
        const sql = `
            SELECT id, document_id, chunk_index, content, embedding
            FROM vc_document_chunks
            WHERE document_id = ? AND embedding IS NOT NULL
            ORDER BY chunk_index ASC
        `;
        const results = await query(sql, [documentId]);
        
        // Parse embeddings
        return results.map(row => ({
            ...row,
            embedding: row.embedding ? JSON.parse(row.embedding) : null
        }));
    }

    /**
     * Get all chunks across all documents with embeddings (for vector search)
     */
    static async getAllChunksWithEmbeddings() {
        const sql = `
            SELECT c.id, c.document_id, c.chunk_index, c.content, c.embedding,
                   d.title as document_title, d.category as document_category
            FROM vc_document_chunks c
            JOIN vc_documents d ON c.document_id = d.id
            WHERE d.is_active = TRUE AND c.embedding IS NOT NULL
            ORDER BY c.document_id, c.chunk_index
        `;
        const results = await query(sql);
        
        return results.map(row => ({
            ...row,
            embedding: row.embedding ? JSON.parse(row.embedding) : null
        }));
    }
}

module.exports = VCDocumentChunk;
