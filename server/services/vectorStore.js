const fs = require('fs').promises;
const path = require('path');
const faiss = require('faiss-node');
const { query } = require('../../config/db');

class VectorStore {
    constructor() {
        this.dim = Number(process.env.EMBEDDING_DIM || 1536);
        this.indexDir = path.join(__dirname, '../../uploads/vector');
        this.indexPath = path.join(this.indexDir, 'faiss.index');
        this.metaPath = path.join(this.indexDir, 'meta.json');
        this._index = null;
        this._meta = null;
    }

    async _ensureLoaded() {
        if (this._index && this._meta) return;

        await fs.mkdir(this.indexDir, { recursive: true });

        // Load meta
        try {
            const raw = await fs.readFile(this.metaPath, 'utf8');
            this._meta = JSON.parse(raw);
        } catch {
            this._meta = { nextId: 1, items: {} };
        }

        // Load FAISS index (or create)
        try {
            // faiss-node API varies by version - try different methods
            if (typeof faiss.readIndexSync === 'function') {
                this._index = faiss.readIndexSync(this.indexPath);
            } else if (faiss.Index && typeof faiss.Index.read === 'function') {
                this._index = faiss.Index.read(this.indexPath);
            } else {
                throw new Error('No read method available');
            }
            console.log(`[VectorStore] Loaded index with ${this._index.ntotal()} vectors`);
        } catch (e) {
            console.log(`[VectorStore] Creating new index (${e.message})`);
            // Use inner product index (cosine similarity if vectors are normalized)
            this._index = new faiss.IndexFlatIP(this.dim);
        }
    }

    async _persist() {
        await fs.mkdir(this.indexDir, { recursive: true });

        // faiss-node API differs by version. Support the common variants.
        if (typeof faiss.writeIndexSync === 'function') {
            faiss.writeIndexSync(this._index, this.indexPath);
        } else if (typeof faiss.writeIndex === 'function') {
            await faiss.writeIndex(this._index, this.indexPath);
        } else if (this._index && typeof this._index.write === 'function') {
            // Newer versions have write(path) on the index instance
            this._index.write(this.indexPath);
        } else {
            throw new Error('FAISS index persistence is not supported by the installed faiss-node build.');
        }

        await fs.writeFile(this.metaPath, JSON.stringify(this._meta, null, 2), 'utf8');
        console.log(`[VectorStore] Persisted index with ${this._index.ntotal()} vectors`);
    }

    _normalize(vec) {
        const v = Array.isArray(vec) ? vec : Array.from(vec || []);
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        return v.map(x => x / norm);
    }

    async addChunk({ documentId, chunkIndex, content, embedding }) {
        await this._ensureLoaded();
        if (!embedding || embedding.length !== this.dim) {
            throw new Error(`Invalid embedding dim. Expected ${this.dim}, got ${embedding?.length || 0}`);
        }

        const id = this._meta.nextId++;
        const vector = this._normalize(embedding);
        this._index.add(vector);

        this._meta.items[String(id)] = {
            id,
            documentId,
            chunkIndex,
            content
        };

        await this._persist();
        return id;
    }

    async removeByDocument(documentId) {
        // IndexFlat* doesn't support delete; rebuild is needed.
        // We rebuild from DB to keep it deterministic and consistent.
        await this.rebuildFromDatabase();
        return true;
    }

    async search(embedding, k = 5) {
        await this._ensureLoaded();
        if (!embedding || embedding.length !== this.dim) {
            throw new Error(`Invalid embedding dim. Expected ${this.dim}, got ${embedding?.length || 0}`);
        }

        const q = this._normalize(embedding);
        if (this._index.ntotal() === 0) return [];

        const topK = Math.min(Number(k) || 5, this._index.ntotal());
        const res = this._index.search(q, topK);
        // faiss-node result format varies by version:
        // - Older versions: { distances: number[][], labels: number[][] }
        // - Newer versions: { distances: number[], labels: number[] }
        const distances = Array.isArray(res.distances?.[0]) ? res.distances[0] : (res.distances || []);
        const labels = Array.isArray(res.labels?.[0]) ? res.labels[0] : (res.labels || []);

        const out = [];
        for (let i = 0; i < labels.length; i++) {
            const id = labels[i];
            if (id < 0) continue;
            const meta = this._meta.items[String(id)];
            if (!meta) continue;
            out.push({
                ...meta,
                score: distances[i]
            });
        }
        return out;
    }

    async rebuildFromDatabase() {
        await fs.mkdir(this.indexDir, { recursive: true });

        // Fresh index + meta
        this._index = new faiss.IndexFlatIP(this.dim);
        this._meta = { nextId: 1, items: {} };

        const rows = await query(`
            SELECT dc.id, dc.document_id as documentId, dc.chunk_index as chunkIndex,
                   dc.content, dc.embedding
            FROM document_chunks dc
            INNER JOIN documents d ON d.id = dc.document_id
            WHERE d.is_active = TRUE
            ORDER BY dc.document_id ASC, dc.chunk_index ASC
        `);

        for (const row of rows) {
            const embedding = JSON.parse(row.embedding);
            await this.addChunk({
                documentId: row.documentId,
                chunkIndex: row.chunkIndex,
                content: row.content,
                embedding
            });
        }

        await this._persist();
        return { chunks: rows.length };
    }

    /**
     * Check if FAISS index is in sync with database and rebuild if needed.
     * Called on server startup to prevent stale index issues.
     */
    async syncWithDatabase() {
        try {
            await this._ensureLoaded();

            // Get chunk count from database
            const dbResult = await query(`
                SELECT COUNT(*) as cnt FROM document_chunks dc
                INNER JOIN documents d ON d.id = dc.document_id
                WHERE d.is_active = TRUE
            `);
            const dbChunkCount = dbResult[0]?.cnt || 0;

            // Get chunk count from FAISS index
            const faissChunkCount = Object.keys(this._meta?.items || {}).length;

            console.log(`[VectorStore] Sync check: DB has ${dbChunkCount} chunks, FAISS has ${faissChunkCount} vectors`);

            // If counts don't match, rebuild the index
            if (dbChunkCount !== faissChunkCount) {
                console.log(`[VectorStore] Index out of sync! Rebuilding from database...`);
                const result = await this.rebuildFromDatabase();
                console.log(`[VectorStore] Rebuild complete: ${result.chunks} chunks indexed`);
                return { synced: true, rebuilt: true, chunks: result.chunks };
            }

            // Additional check: verify all document IDs in DB are in FAISS
            const dbDocs = await query(`
                SELECT DISTINCT dc.document_id 
                FROM document_chunks dc
                INNER JOIN documents d ON d.id = dc.document_id
                WHERE d.is_active = TRUE
            `);
            const dbDocIds = new Set(dbDocs.map(r => r.document_id));
            const faissDocIds = new Set(Object.values(this._meta?.items || {}).map(i => i.documentId));

            const missingDocs = [...dbDocIds].filter(id => !faissDocIds.has(id));
            if (missingDocs.length > 0) {
                console.log(`[VectorStore] Missing documents in FAISS: ${missingDocs.join(', ')}. Rebuilding...`);
                const result = await this.rebuildFromDatabase();
                console.log(`[VectorStore] Rebuild complete: ${result.chunks} chunks indexed`);
                return { synced: true, rebuilt: true, chunks: result.chunks, missingDocs };
            }

            console.log(`[VectorStore] Index is in sync with database`);
            return { synced: true, rebuilt: false, chunks: faissChunkCount };

        } catch (error) {
            console.error(`[VectorStore] Sync check failed:`, error.message);
            return { synced: false, error: error.message };
        }
    }
}

module.exports = new VectorStore();
