const { query } = require('../../config/db');

class DocumentChunk {
    static async deleteByDocumentId(documentId) {
        const res = await query('DELETE FROM document_chunks WHERE document_id = ?', [documentId]);
        return res.affectedRows || 0;
    }

    static async insertChunk({ documentId, chunkIndex, content, embedding }) {
        const sql = `
            INSERT INTO document_chunks (document_id, chunk_index, content, embedding)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                content = VALUES(content),
                embedding = VALUES(embedding)
        `;
        const res = await query(sql, [documentId, chunkIndex, content, JSON.stringify(embedding)]);
        return res.insertId || null;
    }

    static async getChunksByDocumentId(documentId) {
        return query(
            'SELECT id, document_id, chunk_index, content, embedding FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC',
            [documentId]
        );
    }
}

module.exports = DocumentChunk;
