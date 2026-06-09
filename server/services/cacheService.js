/**
 * Redis Cache Service for BMU AI Agent
 * 
 * Provides distributed caching for:
 * - FAQ responses (high hit rate)
 * - Query embeddings (expensive to compute)
 * - LLM responses (for identical queries)
 * - Session data
 * 
 * Falls back to in-memory cache if Redis is unavailable
 */

let Redis;
try {
    Redis = require('ioredis');
} catch (e) {
    console.warn('[CacheService] ioredis not installed, using memory-only cache');
}

class CacheService {
    constructor() {
        this.redis = null;
        this.isConnected = false;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 3;
        
        // Fallback in-memory cache
        this._memoryCache = new Map();
        this._memoryCacheMaxSize = 500;
        
        // Cache configuration
        this.config = {
            // Redis connection
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT) || 6379,
            password: process.env.REDIS_PASSWORD || undefined,
            db: parseInt(process.env.REDIS_DB) || 0,
            keyPrefix: 'bmu:',
            
            // TTLs (in seconds)
            ttl: {
                faq: 3600,           // 1 hour for FAQ responses
                embedding: 86400,    // 24 hours for embeddings
                response: 1800,      // 30 minutes for LLM responses
                session: 3600,       // 1 hour for session data
                retrieval: 600,      // 10 minutes for retrieval results
                warmup: 7200,        // 2 hours for warmed cache entries
                default: 300         // 5 minutes default
            }
        };

        // Statistics
        this._stats = {
            hits: 0,
            misses: 0,
            redisHits: 0,
            memoryHits: 0,
            errors: 0,
            warmupCount: 0,
            lastWarmupAt: null
        };

        // Cache warming configuration
        this._warmupConfig = {
            enabled: process.env.CACHE_WARMUP_ENABLED !== 'false',
            intervalMs: parseInt(process.env.CACHE_WARMUP_INTERVAL) || 30 * 60 * 1000, // 30 minutes
            popularFAQLimit: 50,  // Top N FAQs to warm
            commonQueries: [
                // Common BMU-related queries
                'what is bmu',
                'bayelsa medical university',
                'how to apply',
                'admission requirements',
                'tuition fees',
                'academic calendar',
                'contact information',
                'staff conditions of service',
                'leave policy',
                'promotion requirements',
                'salary structure',
                'benefits and allowances',
                'disciplinary procedures',
                'grievance procedure',
                'who is a dependent',
                'medical benefits',
                'retirement benefits',
                'annual leave entitlement',
                'sick leave policy',
                'maternity leave',
                'study leave',
                'examination regulations',
                'grading system'
            ]
        };

        this._warmupInterval = null;

        // Initialize Redis connection
        this._initRedis();
    }

    /**
     * Initialize Redis connection with retry logic
     */
    async _initRedis() {
        if (!Redis) {
            console.log('[CacheService] Running in memory-only mode (ioredis not available)');
            return;
        }

        if (process.env.DISABLE_REDIS === 'true') {
            console.log('[CacheService] Redis disabled by configuration');
            return;
        }

        try {
            this.redis = new Redis({
                host: this.config.host,
                port: this.config.port,
                password: this.config.password,
                db: this.config.db,
                keyPrefix: this.config.keyPrefix,
                retryStrategy: (times) => {
                    if (times > this.maxConnectionAttempts) {
                        console.warn('[CacheService] Max Redis connection attempts reached, using memory cache');
                        return null; // Stop retrying
                    }
                    return Math.min(times * 200, 2000); // Exponential backoff
                },
                lazyConnect: true,
                connectTimeout: 5000,
                maxRetriesPerRequest: 1
            });

            // Event handlers
            this.redis.on('connect', () => {
                this.isConnected = true;
                console.log(`[CacheService] Redis connected at ${this.config.host}:${this.config.port}`);
            });

            this.redis.on('error', (err) => {
                if (this.isConnected) {
                    console.error('[CacheService] Redis error:', err.message);
                }
                this._stats.errors++;
            });

            this.redis.on('close', () => {
                this.isConnected = false;
                console.log('[CacheService] Redis connection closed');
            });

            // Attempt connection
            await this.redis.connect();

        } catch (error) {
            console.warn('[CacheService] Redis initialization failed:', error.message);
            console.log('[CacheService] Using memory-only cache');
            this.redis = null;
        }
    }

    /**
     * Generate cache key with namespace
     */
    _makeKey(namespace, key) {
        // Normalize and hash long keys
        const normalizedKey = String(key).toLowerCase().trim();
        if (normalizedKey.length > 100) {
            const crypto = require('crypto');
            const hash = crypto.createHash('md5').update(normalizedKey).digest('hex');
            return `${namespace}:${hash}`;
        }
        return `${namespace}:${normalizedKey.replace(/[^a-z0-9]/g, '_')}`;
    }

    /**
     * Get value from cache (Redis first, then memory)
     */
    async get(namespace, key) {
        const cacheKey = this._makeKey(namespace, key);

        // Try Redis first
        if (this.isConnected && this.redis) {
            try {
                const value = await this.redis.get(cacheKey);
                if (value) {
                    this._stats.hits++;
                    this._stats.redisHits++;
                    try {
                        return JSON.parse(value);
                    } catch {
                        return value;
                    }
                }
            } catch (error) {
                console.warn('[CacheService] Redis get error:', error.message);
                this._stats.errors++;
            }
        }

        // Try memory cache
        const memoryEntry = this._memoryCache.get(cacheKey);
        if (memoryEntry && memoryEntry.expires > Date.now()) {
            this._stats.hits++;
            this._stats.memoryHits++;
            return memoryEntry.value;
        }

        // Cache miss
        this._stats.misses++;
        return null;
    }

    /**
     * Set value in cache (both Redis and memory)
     */
    async set(namespace, key, value, ttlSeconds = null) {
        const cacheKey = this._makeKey(namespace, key);
        const ttl = ttlSeconds || this.config.ttl[namespace] || this.config.ttl.default;

        // Store in Redis
        if (this.isConnected && this.redis) {
            try {
                const serialized = JSON.stringify(value);
                await this.redis.setex(cacheKey, ttl, serialized);
            } catch (error) {
                console.warn('[CacheService] Redis set error:', error.message);
                this._stats.errors++;
            }
        }

        // Store in memory cache
        this._setMemory(cacheKey, value, ttl);

        return true;
    }

    /**
     * Set value in memory cache with TTL
     */
    _setMemory(key, value, ttlSeconds) {
        // Evict oldest entries if cache is full
        if (this._memoryCache.size >= this._memoryCacheMaxSize) {
            const keysToDelete = [];
            const now = Date.now();
            
            // First, delete expired entries
            for (const [k, v] of this._memoryCache.entries()) {
                if (v.expires < now) {
                    keysToDelete.push(k);
                }
            }
            
            // If still full, delete oldest 20%
            if (this._memoryCache.size - keysToDelete.length >= this._memoryCacheMaxSize) {
                const entries = Array.from(this._memoryCache.entries())
                    .sort((a, b) => a[1].created - b[1].created);
                const deleteCount = Math.floor(this._memoryCacheMaxSize * 0.2);
                for (let i = 0; i < deleteCount; i++) {
                    keysToDelete.push(entries[i][0]);
                }
            }
            
            keysToDelete.forEach(k => this._memoryCache.delete(k));
        }

        this._memoryCache.set(key, {
            value,
            created: Date.now(),
            expires: Date.now() + (ttlSeconds * 1000)
        });
    }

    /**
     * Delete value from cache
     */
    async delete(namespace, key) {
        const cacheKey = this._makeKey(namespace, key);

        // Delete from Redis
        if (this.isConnected && this.redis) {
            try {
                await this.redis.del(cacheKey);
            } catch (error) {
                console.warn('[CacheService] Redis delete error:', error.message);
            }
        }

        // Delete from memory
        this._memoryCache.delete(cacheKey);
    }

    /**
     * Clear all cache entries for a namespace
     */
    async clearNamespace(namespace) {
        // Clear from Redis
        if (this.isConnected && this.redis) {
            try {
                const pattern = `${this.config.keyPrefix}${namespace}:*`;
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    // Remove prefix from keys before deleting
                    const keysWithoutPrefix = keys.map(k => k.replace(this.config.keyPrefix, ''));
                    await this.redis.del(...keysWithoutPrefix);
                }
                console.log(`[CacheService] Cleared ${keys.length} Redis keys for namespace: ${namespace}`);
            } catch (error) {
                console.warn('[CacheService] Redis clear error:', error.message);
            }
        }

        // Clear from memory
        const prefix = `${namespace}:`;
        let cleared = 0;
        for (const key of this._memoryCache.keys()) {
            if (key.startsWith(prefix)) {
                this._memoryCache.delete(key);
                cleared++;
            }
        }
        console.log(`[CacheService] Cleared ${cleared} memory cache entries for namespace: ${namespace}`);
    }

    /**
     * Clear all cache
     */
    async clearAll() {
        // Clear Redis
        if (this.isConnected && this.redis) {
            try {
                const pattern = `${this.config.keyPrefix}*`;
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    const keysWithoutPrefix = keys.map(k => k.replace(this.config.keyPrefix, ''));
                    await this.redis.del(...keysWithoutPrefix);
                }
                console.log(`[CacheService] Cleared all Redis cache (${keys.length} keys)`);
            } catch (error) {
                console.warn('[CacheService] Redis clear all error:', error.message);
            }
        }

        // Clear memory
        const size = this._memoryCache.size;
        this._memoryCache.clear();
        console.log(`[CacheService] Cleared all memory cache (${size} entries)`);
    }

    // ============ CONVENIENCE METHODS FOR SPECIFIC USE CASES ============

    /**
     * Cache FAQ response
     */
    async cacheFAQ(question, response, sources = []) {
        return this.set('faq', question, { response, sources, cachedAt: Date.now() });
    }

    /**
     * Get cached FAQ response
     */
    async getFAQ(question) {
        return this.get('faq', question);
    }

    /**
     * Cache embedding vector
     */
    async cacheEmbedding(text, embedding) {
        // Embeddings are large, so use a hash of the text as key
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex');
        return this.set('embedding', hash, embedding);
    }

    /**
     * Get cached embedding
     */
    async getEmbedding(text) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex');
        return this.get('embedding', hash);
    }

    /**
     * Cache LLM response
     */
    async cacheLLMResponse(query, response, model = 'default') {
        const key = `${model}:${query}`;
        return this.set('response', key, { response, cachedAt: Date.now() });
    }

    /**
     * Get cached LLM response
     */
    async getLLMResponse(query, model = 'default') {
        const key = `${model}:${query}`;
        return this.get('response', key);
    }

    /**
     * Cache retrieval results
     */
    async cacheRetrieval(query, results) {
        return this.set('retrieval', query, { results, cachedAt: Date.now() });
    }

    /**
     * Get cached retrieval results
     */
    async getRetrieval(query) {
        return this.get('retrieval', query);
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const total = this._stats.hits + this._stats.misses;
        return {
            ...this._stats,
            hitRate: total > 0 ? ((this._stats.hits / total) * 100).toFixed(1) + '%' : '0%',
            memoryCacheSize: this._memoryCache.size,
            redisConnected: this.isConnected,
            warmup: this.getWarmupStatus()
        };
    }

    /**
     * Health check
     */
    async healthCheck() {
        const health = {
            memoryCache: {
                status: 'healthy',
                size: this._memoryCache.size,
                maxSize: this._memoryCacheMaxSize
            },
            redis: {
                status: 'disconnected',
                host: this.config.host,
                port: this.config.port
            }
        };

        if (this.isConnected && this.redis) {
            try {
                await this.redis.ping();
                health.redis.status = 'healthy';
                
                // Get Redis info
                const info = await this.redis.info('memory');
                const usedMemory = info.match(/used_memory_human:(\S+)/);
                if (usedMemory) {
                    health.redis.usedMemory = usedMemory[1];
                }
            } catch (error) {
                health.redis.status = 'error';
                health.redis.error = error.message;
            }
        }

        return health;
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        if (this.redis) {
            try {
                await this.redis.quit();
                console.log('[CacheService] Redis connection closed gracefully');
            } catch (error) {
                console.warn('[CacheService] Error closing Redis:', error.message);
            }
        }
    }

    /**
     * Start cache warming - call after services are ready
     * @param {Object} options - Configuration options
     */
    async startCacheWarming(options = {}) {
        if (!this._warmupConfig.enabled) {
            console.log('[CacheService] Cache warming disabled');
            return;
        }

        // Override config if provided
        if (options.intervalMs) this._warmupConfig.intervalMs = options.intervalMs;
        if (options.popularFAQLimit) this._warmupConfig.popularFAQLimit = options.popularFAQLimit;

        // Run initial warmup after a short delay (let services initialize)
        setTimeout(() => {
            this.warmCache().catch(err => {
                console.error('[CacheService] Initial cache warmup failed:', err.message);
            });
        }, 5000);

        // Set up periodic warming
        if (this._warmupInterval) clearInterval(this._warmupInterval);
        this._warmupInterval = setInterval(() => {
            this.warmCache().catch(err => {
                console.error('[CacheService] Periodic cache warmup failed:', err.message);
            });
        }, this._warmupConfig.intervalMs);

        console.log(`[CacheService] Cache warming enabled (interval: ${Math.round(this._warmupConfig.intervalMs / 60000)} min)`);
    }

    /**
     * Stop cache warming
     */
    stopCacheWarming() {
        if (this._warmupInterval) {
            clearInterval(this._warmupInterval);
            this._warmupInterval = null;
            console.log('[CacheService] Cache warming stopped');
        }
    }

    /**
     * Warm the cache with popular FAQs and pre-generate embeddings
     * Can be called manually or by the periodic warming job
     */
    async warmCache() {
        const startTime = Date.now();
        console.log('[CacheService] Starting cache warmup...');
        
        let warmedCount = 0;
        let embeddingsWarmed = 0;
        let errors = 0;

        try {
            // 1. Warm popular FAQs from database
            const CachedQA = require('../models/CachedQA');
            const popularFAQs = await CachedQA.getPopular(this._warmupConfig.popularFAQLimit);
            
            for (const faq of popularFAQs) {
                try {
                    // Cache the FAQ response
                    await this.set('faq', faq.question, {
                        response: faq.answer,
                        sources: faq.answerSources || [],
                        matchedQuestion: faq.question,
                        cachedAt: Date.now(),
                        fromWarmup: true
                    }, this.config.ttl.warmup);
                    warmedCount++;
                    
                    // Also cache question variations if they exist
                    if (faq.questionVariations && Array.isArray(faq.questionVariations)) {
                        for (const variation of faq.questionVariations) {
                            if (variation && variation.length > 5) {
                                await this.set('faq', variation, {
                                    response: faq.answer,
                                    sources: faq.answerSources || [],
                                    matchedQuestion: faq.question,
                                    cachedAt: Date.now(),
                                    fromWarmup: true
                                }, this.config.ttl.warmup);
                                warmedCount++;
                            }
                        }
                    }
                } catch (err) {
                    errors++;
                }
            }

            // 2. Pre-generate embeddings for common queries
            // Only if AI service is available
            let aiService = null;
            try {
                aiService = require('./aiService');
            } catch (e) {
                console.warn('[CacheService] AI service not available for embedding warmup');
            }

            if (aiService) {
                for (const queryText of this._warmupConfig.commonQueries) {
                    try {
                        // Check if embedding already cached
                        const existingEmbedding = await this.getEmbedding(queryText);
                        if (!existingEmbedding) {
                            // Generate and cache embedding
                            const embedding = await aiService.generateEmbedding(queryText, false);
                            if (embedding && embedding.length > 0) {
                                await this.cacheEmbedding(queryText, embedding);
                                embeddingsWarmed++;
                            }
                        }
                    } catch (err) {
                        errors++;
                    }
                }
            }

            const duration = Date.now() - startTime;
            this._stats.warmupCount++;
            this._stats.lastWarmupAt = new Date().toISOString();

            console.log(`[CacheService] Cache warmup complete: ${warmedCount} FAQs, ${embeddingsWarmed} embeddings warmed in ${duration}ms (${errors} errors)`);

            return {
                success: true,
                faqsWarmed: warmedCount,
                embeddingsWarmed,
                errors,
                durationMs: duration
            };

        } catch (error) {
            console.error('[CacheService] Cache warmup failed:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get warmup status and statistics
     */
    getWarmupStatus() {
        return {
            enabled: this._warmupConfig.enabled,
            intervalMs: this._warmupConfig.intervalMs,
            intervalMinutes: Math.round(this._warmupConfig.intervalMs / 60000),
            popularFAQLimit: this._warmupConfig.popularFAQLimit,
            commonQueriesCount: this._warmupConfig.commonQueries.length,
            warmupCount: this._stats.warmupCount,
            lastWarmupAt: this._stats.lastWarmupAt,
            isRunning: !!this._warmupInterval
        };
    }

    /**
     * Add custom queries to the warmup list
     * @param {string[]} queries - Array of query strings to add
     */
    addWarmupQueries(queries) {
        if (!Array.isArray(queries)) return;
        for (const q of queries) {
            if (q && typeof q === 'string' && !this._warmupConfig.commonQueries.includes(q.toLowerCase())) {
                this._warmupConfig.commonQueries.push(q.toLowerCase());
            }
        }
        console.log(`[CacheService] Added ${queries.length} queries to warmup list (total: ${this._warmupConfig.commonQueries.length})`);
    }
}

// Export singleton instance
module.exports = new CacheService();
