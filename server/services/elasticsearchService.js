/**
 * Elasticsearch Service for BMU AI Agent
 * 
 * Provides efficient document indexing and search capabilities.
 * Falls back gracefully when Elasticsearch is not available.
 * 
 * Setup instructions:
 * 1. Install Elasticsearch: docker run -d --name elasticsearch -p 9200:9200 -e "discovery.type=single-node" elasticsearch:8.11.0
 * 2. Set environment variables:
 *    - ELASTICSEARCH_URL=http://localhost:9200
 *    - ELASTICSEARCH_ENABLED=true
 *    - ELASTICSEARCH_INDEX=bmu_documents
 */

const { query } = require('../../config/db');

class ElasticsearchService {
    constructor() {
        this.enabled = process.env.ELASTICSEARCH_ENABLED === 'true';
        this.url = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
        this.indexName = process.env.ELASTICSEARCH_INDEX || 'bmu_documents';
        this.client = null;
        this._initialized = false;
        this._initPromise = null;
        
        // Index settings optimized for text search
        this.indexSettings = {
            settings: {
                number_of_shards: 1,
                number_of_replicas: 0,
                analysis: {
                    analyzer: {
                        bmu_analyzer: {
                            type: 'custom',
                            tokenizer: 'standard',
                            filter: [
                                'lowercase',
                                'asciifolding',
                                'english_stop',
                                'english_stemmer',
                                'edge_ngram_filter'
                            ]
                        },
                        bmu_search_analyzer: {
                            type: 'custom',
                            tokenizer: 'standard',
                            filter: [
                                'lowercase',
                                'asciifolding',
                                'english_stop',
                                'english_stemmer'
                            ]
                        }
                    },
                    filter: {
                        english_stop: {
                            type: 'stop',
                            stopwords: '_english_'
                        },
                        english_stemmer: {
                            type: 'stemmer',
                            language: 'english'
                        },
                        edge_ngram_filter: {
                            type: 'edge_ngram',
                            min_gram: 2,
                            max_gram: 20
                        }
                    }
                },
                // Performance optimizations
                index: {
                    refresh_interval: '5s',
                    max_result_window: 10000
                }
            },
            mappings: {
                properties: {
                    document_id: { type: 'integer' },
                    chunk_index: { type: 'integer' },
                    content: {
                        type: 'text',
                        analyzer: 'bmu_analyzer',
                        search_analyzer: 'bmu_search_analyzer',
                        fields: {
                            exact: { type: 'keyword' },
                            raw: { type: 'text' }
                        }
                    },
                    title: {
                        type: 'text',
                        analyzer: 'bmu_analyzer',
                        search_analyzer: 'bmu_search_analyzer',
                        boost: 2.0
                    },
                    category: { type: 'keyword' },
                    embedding: {
                        type: 'dense_vector',
                        dims: parseInt(process.env.EMBEDDING_DIM) || 768,
                        index: true,
                        similarity: 'cosine'
                    },
                    created_at: { type: 'date' },
                    updated_at: { type: 'date' }
                }
            }
        };
        
        if (this.enabled) {
            console.log(`[ElasticsearchService] Enabled, URL: ${this.url}, Index: ${this.indexName}`);
        } else {
            console.log('[ElasticsearchService] Disabled - using fallback search');
        }
    }

    /**
     * Initialize Elasticsearch client
     */
    async initialize() {
        if (!this.enabled) return false;
        if (this._initialized) return true;
        if (this._initPromise) return this._initPromise;
        
        this._initPromise = (async () => {
            try {
                // Dynamic import for @elastic/elasticsearch
                const { Client } = await import('@elastic/elasticsearch');
                
                this.client = new Client({
                    node: this.url,
                    maxRetries: 3,
                    requestTimeout: 30000,
                    sniffOnStart: false
                });
                
                // Test connection
                const health = await this.client.cluster.health();
                console.log(`[ElasticsearchService] Connected, cluster status: ${health.status}`);
                
                // Create index if not exists
                await this._ensureIndex();
                
                this._initialized = true;
                return true;
                
            } catch (error) {
                console.error('[ElasticsearchService] Initialization failed:', error.message);
                this.enabled = false;
                this._initialized = false;
                return false;
            }
        })();
        
        return this._initPromise;
    }

    /**
     * Ensure index exists with proper mappings
     */
    async _ensureIndex() {
        if (!this.client) return;
        
        try {
            const exists = await this.client.indices.exists({ index: this.indexName });
            
            if (!exists) {
                await this.client.indices.create({
                    index: this.indexName,
                    body: this.indexSettings
                });
                console.log(`[ElasticsearchService] Created index: ${this.indexName}`);
            } else {
                // Update mappings if needed
                await this.client.indices.putMapping({
                    index: this.indexName,
                    body: this.indexSettings.mappings
                }).catch(() => {}); // Ignore mapping update errors
            }
        } catch (error) {
            console.error('[ElasticsearchService] Index setup error:', error.message);
        }
    }

    /**
     * Index a document chunk
     */
    async indexChunk(chunk) {
        if (!this.enabled || !await this.initialize()) {
            return null;
        }
        
        try {
            const doc = {
                document_id: chunk.documentId,
                chunk_index: chunk.chunkIndex,
                content: chunk.content,
                title: chunk.title || '',
                category: chunk.category || 'general',
                created_at: new Date().toISOString()
            };
            
            // Add embedding if available
            if (chunk.embedding && Array.isArray(chunk.embedding)) {
                doc.embedding = chunk.embedding;
            }
            
            const response = await this.client.index({
                index: this.indexName,
                id: `${chunk.documentId}_${chunk.chunkIndex}`,
                body: doc,
                refresh: false // Batch indexing optimization
            });
            
            return response._id;
            
        } catch (error) {
            console.error('[ElasticsearchService] Index chunk error:', error.message);
            return null;
        }
    }

    /**
     * Bulk index multiple chunks
     */
    async bulkIndex(chunks) {
        if (!this.enabled || !await this.initialize()) {
            return { indexed: 0, errors: chunks.length };
        }
        
        if (chunks.length === 0) return { indexed: 0, errors: 0 };
        
        try {
            const operations = chunks.flatMap(chunk => [
                { index: { _index: this.indexName, _id: `${chunk.documentId}_${chunk.chunkIndex}` } },
                {
                    document_id: chunk.documentId,
                    chunk_index: chunk.chunkIndex,
                    content: chunk.content,
                    title: chunk.title || '',
                    category: chunk.category || 'general',
                    embedding: chunk.embedding,
                    created_at: new Date().toISOString()
                }
            ]);
            
            const response = await this.client.bulk({
                body: operations,
                refresh: true
            });
            
            const errors = response.items.filter(item => item.index?.error).length;
            
            return {
                indexed: chunks.length - errors,
                errors,
                took: response.took
            };
            
        } catch (error) {
            console.error('[ElasticsearchService] Bulk index error:', error.message);
            return { indexed: 0, errors: chunks.length };
        }
    }

    /**
     * Search documents using text query
     */
    async search(queryText, options = {}) {
        if (!this.enabled || !await this.initialize()) {
            return [];
        }
        
        const {
            limit = 10,
            documentId = null,
            category = null,
            minScore = 0.1
        } = options;
        
        try {
            const must = [
                {
                    multi_match: {
                        query: queryText,
                        fields: ['content^1', 'title^2'],
                        type: 'best_fields',
                        fuzziness: 'AUTO',
                        operator: 'or',
                        minimum_should_match: '30%'
                    }
                }
            ];
            
            const filter = [];
            if (documentId) filter.push({ term: { document_id: documentId } });
            if (category) filter.push({ term: { category: category } });
            
            const response = await this.client.search({
                index: this.indexName,
                body: {
                    query: {
                        bool: {
                            must,
                            filter: filter.length > 0 ? filter : undefined
                        }
                    },
                    min_score: minScore,
                    size: limit,
                    _source: ['document_id', 'chunk_index', 'content', 'title', 'category'],
                    highlight: {
                        fields: {
                            content: {
                                fragment_size: 200,
                                number_of_fragments: 3,
                                pre_tags: ['<mark>'],
                                post_tags: ['</mark>']
                            }
                        }
                    }
                }
            });
            
            return response.hits.hits.map(hit => ({
                documentId: hit._source.document_id,
                chunkIndex: hit._source.chunk_index,
                content: hit._source.content,
                title: hit._source.title,
                category: hit._source.category,
                score: hit._score,
                highlights: hit.highlight?.content || []
            }));
            
        } catch (error) {
            console.error('[ElasticsearchService] Search error:', error.message);
            return [];
        }
    }

    /**
     * Hybrid search combining text and vector similarity
     */
    async hybridSearch(queryText, embedding, options = {}) {
        if (!this.enabled || !await this.initialize()) {
            return [];
        }
        
        const {
            limit = 10,
            textWeight = 0.3,
            vectorWeight = 0.7
        } = options;
        
        try {
            const response = await this.client.search({
                index: this.indexName,
                body: {
                    query: {
                        script_score: {
                            query: {
                                bool: {
                                    should: [
                                        {
                                            multi_match: {
                                                query: queryText,
                                                fields: ['content', 'title^2'],
                                                type: 'best_fields',
                                                boost: textWeight
                                            }
                                        }
                                    ],
                                    minimum_should_match: 0
                                }
                            },
                            script: {
                                source: `
                                    double textScore = _score * params.textWeight;
                                    double vectorScore = 0;
                                    if (doc['embedding'].size() > 0) {
                                        vectorScore = cosineSimilarity(params.queryVector, 'embedding') * params.vectorWeight;
                                    }
                                    return textScore + vectorScore + 0.1;
                                `,
                                params: {
                                    queryVector: embedding,
                                    textWeight,
                                    vectorWeight
                                }
                            }
                        }
                    },
                    size: limit,
                    _source: ['document_id', 'chunk_index', 'content', 'title', 'category']
                }
            });
            
            return response.hits.hits.map(hit => ({
                documentId: hit._source.document_id,
                chunkIndex: hit._source.chunk_index,
                content: hit._source.content,
                title: hit._source.title,
                category: hit._source.category,
                score: hit._score
            }));
            
        } catch (error) {
            console.error('[ElasticsearchService] Hybrid search error:', error.message);
            return [];
        }
    }

    /**
     * Delete document from index
     */
    async deleteDocument(documentId) {
        if (!this.enabled || !await this.initialize()) {
            return false;
        }
        
        try {
            await this.client.deleteByQuery({
                index: this.indexName,
                body: {
                    query: {
                        term: { document_id: documentId }
                    }
                },
                refresh: true
            });
            
            return true;
        } catch (error) {
            console.error('[ElasticsearchService] Delete error:', error.message);
            return false;
        }
    }

    /**
     * Rebuild index from database
     */
    async rebuildIndex() {
        if (!this.enabled || !await this.initialize()) {
            return { success: false, error: 'Elasticsearch not available' };
        }
        
        try {
            console.log('[ElasticsearchService] Starting index rebuild...');
            
            // Delete existing index
            try {
                await this.client.indices.delete({ index: this.indexName });
            } catch (e) {
                // Index may not exist
            }
            
            // Recreate index
            await this._ensureIndex();
            
            // Get all chunks from database
            const chunks = await query(`
                SELECT 
                    dc.document_id as documentId,
                    dc.chunk_index as chunkIndex,
                    dc.content,
                    dc.embedding,
                    d.title,
                    d.category
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                ORDER BY dc.document_id, dc.chunk_index
            `);
            
            if (!chunks || chunks.length === 0) {
                return { success: true, indexed: 0 };
            }
            
            // Parse embeddings and bulk index
            const processedChunks = chunks.map(chunk => ({
                ...chunk,
                embedding: chunk.embedding ? JSON.parse(chunk.embedding) : null
            }));
            
            // Index in batches of 100
            const batchSize = 100;
            let totalIndexed = 0;
            let totalErrors = 0;
            
            for (let i = 0; i < processedChunks.length; i += batchSize) {
                const batch = processedChunks.slice(i, i + batchSize);
                const result = await this.bulkIndex(batch);
                totalIndexed += result.indexed;
                totalErrors += result.errors;
            }
            
            console.log(`[ElasticsearchService] Index rebuild complete: ${totalIndexed} indexed, ${totalErrors} errors`);
            
            return {
                success: true,
                indexed: totalIndexed,
                errors: totalErrors,
                total: chunks.length
            };
            
        } catch (error) {
            console.error('[ElasticsearchService] Rebuild error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get index statistics
     */
    async getStats() {
        if (!this.enabled || !await this.initialize()) {
            return { enabled: false };
        }
        
        try {
            const stats = await this.client.indices.stats({ index: this.indexName });
            const count = await this.client.count({ index: this.indexName });
            
            return {
                enabled: true,
                documentCount: count.count,
                indexSize: stats._all.primaries.store.size_in_bytes,
                indexSizeHuman: this._formatBytes(stats._all.primaries.store.size_in_bytes)
            };
        } catch (error) {
            return { enabled: true, error: error.message };
        }
    }

    _formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Check if Elasticsearch is available
     */
    async isAvailable() {
        if (!this.enabled) return false;
        
        try {
            await this.initialize();
            const health = await this.client?.cluster.health({ timeout: '5s' });
            return health?.status !== 'red';
        } catch {
            return false;
        }
    }
}

module.exports = new ElasticsearchService();
