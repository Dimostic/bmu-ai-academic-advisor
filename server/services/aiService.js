/**
 * AI Service - Simplified to use only DeepSeek
 * All other providers removed for simplicity and cost-effectiveness
 */
const axios = require('axios');
const Document = require('../models/Document');
const { query } = require('../../config/db');
const vectorStore = require('./vectorStore');

// Redis cache service for distributed caching
let cacheService = null;
try {
    cacheService = require('./cacheService');
    console.log('[AIService] Redis cache service loaded');
} catch (e) {
    console.warn('[AIService] Cache service not available:', e.message);
}

// Enhanced retrieval service for improved search quality
let retrievalService = null;
const USE_ENHANCED_RETRIEVAL = process.env.USE_ENHANCED_RETRIEVAL !== 'false';

class AIService {
    constructor() {
        // DeepSeek is the only AI provider
        this.deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        this.deepSeekBaseUrl = 'https://api.deepseek.com/v1';
        this.maxTokens = parseInt(process.env.AI_MAX_TOKENS) || 4096;
        this.temperature = parseFloat(process.env.AI_TEMPERATURE) || 0.7;

        // Ollama for embeddings only (not for chat)
        this.ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        this.ollamaEmbeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
        this.embeddingProvider = 'ollama';

        // Embedding dimension for nomic-embed-text
        if (!process.env.EMBEDDING_DIM) {
            process.env.EMBEDDING_DIM = '768';
        }

        // === CACHING FOR PERFORMANCE ===
        this._systemPromptCache = null;
        this._systemPromptCacheTime = 0;
        this._systemPromptCacheTTL = 5 * 60 * 1000; // 5 minutes
        this._officialUpdatesCache = null;
        this._officialUpdatesCacheTime = 0;
        this._officialUpdatesCacheTTL = 5 * 60 * 1000; // 5 minutes
        
        this._embeddingCache = new Map();
        this._embeddingCacheMaxSize = 100;

        this._responseCache = new Map();
        this._responseCacheMaxSize = 50;
        this._responseCacheTTL = 60 * 60 * 1000; // 1 hour

        // Monthly usage limits
        this.MONTHLY_LIMIT_REGULAR = 100; // Regular users: 100 prompts/month
        this.MONTHLY_LIMIT_UNLIMITED = -1; // Admin/Superadmin: unlimited

        if (this.deepSeekApiKey) {
            console.log('[AIService] DeepSeek API configured - primary AI provider');
        } else {
            console.error('[AIService] WARNING: DEEPSEEK_API_KEY not set! AI features will not work.');
        }

        console.log(`[AIService] Embedding provider: ${this.embeddingProvider}, model: ${this.ollamaEmbeddingModel}`);
    }

    // Get system prompt with caching
    async getSystemPrompt() {
        const now = Date.now();
        
        if (this._systemPromptCache && (now - this._systemPromptCacheTime) < this._systemPromptCacheTTL) {
            return this._systemPromptCache;
        }
        
        const settingsResult = await query(
            "SELECT setting_value FROM system_settings WHERE setting_key = 'ai_system_prompt'"
        );
        
        const basePrompt = settingsResult[0]?.setting_value || `
You are an intelligent AI assistant for Bayelsa Medical University (BMU).
You help staff, students, and administrators understand university policies, regulations, academic standards, and administrative procedures.

CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. **Document excerpts are provided below** - They contain official BMU content. You MUST read and use them.
2. **NEVER say you don't have access to information** if document excerpts are provided below.
3. **Quote the document title** when answering: "According to [Document Title]..." or "The [Document Name] states..."
4. **If the excerpts mention the topic** (even partially), summarize what the documents say about it.
5. **Be specific** - cite sections, pages, or relevant details from the excerpts.
6. **Only say "I couldn't find information"** if the excerpts truly don't contain any relevant content.

Response Format:
- Start by acknowledging you found relevant information (if excerpts are provided)
- Use bullet points or numbered lists for clarity
- Quote or paraphrase from the document excerpts
- Be professional and helpful
        `;

        this._systemPromptCache = basePrompt;
        this._systemPromptCacheTime = now;
        
        return basePrompt;
    }

    // Get official BMU updates (highest priority facts)
    async getOfficialUpdates() {
        const now = Date.now();
        if (this._officialUpdatesCache && (now - this._officialUpdatesCacheTime) < this._officialUpdatesCacheTTL) {
            return this._officialUpdatesCache;
        }

        const settingsResult = await query(
            "SELECT setting_value FROM system_settings WHERE setting_key = 'ai_official_updates'"
        );
        const updates = String(settingsResult[0]?.setting_value || '').trim();

        this._officialUpdatesCache = updates;
        this._officialUpdatesCacheTime = now;

        return updates;
    }

    // Check and get user's monthly usage
    async getUserUsage(userId) {
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        
        // First get user role
        const userResult = await query(`SELECT role FROM users WHERE id = ?`, [userId]);
        if (userResult.length === 0) {
            return { used: 0, limit: this.MONTHLY_LIMIT_REGULAR, remaining: this.MONTHLY_LIMIT_REGULAR, unlimited: false };
        }
        
        const role = userResult[0].role;
        
        // Count usage logs for this month (each row = 1 request)
        const usageResult = await query(`
            SELECT COUNT(*) as used
            FROM usage_logs
            WHERE user_id = ? AND month_year = ?
        `, [userId, currentMonth]);

        const used = parseInt(usageResult[0]?.used) || 0;
        const isUnlimited = role === 'admin' || role === 'superadmin';
        const limit = isUnlimited ? this.MONTHLY_LIMIT_UNLIMITED : this.MONTHLY_LIMIT_REGULAR;
        const remaining = isUnlimited ? -1 : Math.max(0, limit - used);

        return {
            used,
            limit,
            remaining,
            unlimited: isUnlimited
        };
    }

    // Check if user can make a request
    async canUserMakeRequest(userId) {
        const usage = await this.getUserUsage(userId);
        return usage.unlimited || usage.remaining > 0;
    }

    // Increment user's usage count
    async incrementUsage(userId, tokensUsed = 0) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        
        // Insert a new row for each request (no ON DUPLICATE KEY since each request is a new row)
        await query(`
            INSERT INTO usage_logs (user_id, month_year, model_id, total_tokens, prompt_tokens, completion_tokens, created_at)
            VALUES (?, ?, 'deepseek-chat', ?, 0, ?, NOW())
        `, [userId, currentMonth, tokensUsed, tokensUsed]);
    }

    // Lazy-load retrieval service
    _getRetrievalService() {
        if (!retrievalService && USE_ENHANCED_RETRIEVAL) {
            try {
                retrievalService = require('./retrievalService');
                console.log('[AIService] Enhanced retrieval service loaded');
            } catch (e) {
                console.warn('[AIService] Could not load retrieval service:', e.message);
            }
        }
        return retrievalService;
    }

    _extractSectionLabel(content) {
        const match = String(content || '').match(/^\s*Section:\s*(.+)$/mi);
        if (!match) return null;
        return match[1].trim().substring(0, 120);
    }

    // Search relevant documents for context
    async searchRelevantDocuments(userQuery, limit = 5, sessionContext = {}) {
        try {
            // Get optional document filter from session context
            const documentIds = sessionContext.documentIds;
            const hasDocFilter = documentIds && Array.isArray(documentIds) && documentIds.length > 0;
            
            const retrieval = this._getRetrievalService();
            if (retrieval) {
                const result = await retrieval.retrieve(userQuery, {
                    sessionContext,
                    limit: limit + 2,
                    includeMetadata: true,
                    documentIds: documentIds
                });
                
                if (result.type === 'document_retrieval' && ((result.chunks && result.chunks.length > 0) || String(result.context || '').trim())) {
                    // Filter by documentIds if specified
                    let filteredChunks = result.chunks || [];
                    if (hasDocFilter) {
                        filteredChunks = filteredChunks.filter(chunk => 
                            documentIds.includes(chunk.documentId)
                        );
                    }
                    
                    if (filteredChunks.length > 0 || String(result.context || '').trim()) {
                        const relevantDocs = [];
                        const seenDocIds = new Set();
                        
                        for (const chunk of filteredChunks) {
                            if (!seenDocIds.has(chunk.documentId)) {
                                seenDocIds.add(chunk.documentId);
                                const src = result.sources.find(s => s.documentId === chunk.documentId);
                                const section = this._extractSectionLabel(chunk.content);
                                relevantDocs.push({
                                    id: chunk.documentId,
                                    title: src?.title || chunk.documentTitle,
                                    category: src?.category || chunk.documentCategory,
                                    relevance: chunk.score,
                                    chunkIndex: chunk.chunkIndex,
                                    section
                                });
                            }
                        }
                        
                        // Build context with clear document markers
                        const compressedContext = String(result.context || '').trim();
                        let context = '\n\n=== RELEVANT DOCUMENT EXCERPTS ===\n';
                        if (hasDocFilter) {
                            context += `Searching within ${documentIds.length} selected document(s):\n\n`;
                        } else {
                            context += 'Use the following official BMU document excerpts to answer the user\'s question:\n\n';
                        }

                        if (compressedContext) {
                            context += `${compressedContext}\n`;
                        } else {
                            for (const chunk of filteredChunks.slice(0, limit)) {
                                const docTitle = chunk.documentTitle || 'Unknown Document';
                                context += `--- FROM: "${docTitle}" ---\n`;
                                context += `${chunk.content}\n`;
                                context += `--- END OF EXCERPT ---\n\n`;
                            }
                        }

                        context += '=== END OF DOCUMENT EXCERPTS ===\n';
                        context += '\nIMPORTANT: Base your answer on the document excerpts provided above.';
                        
                        return {
                            context,
                            documents: relevantDocs,
                            hasRelevantContent: true,
                            retrievalTimeMs: result.retrievalTimeMs,
                            chunkCount: filteredChunks.length
                        };
                    }
                }
            }

            // Basic retrieval fallback with lower threshold
            let relevantDocs = [];
            let context = '';
            let hasRelevantContent = false;

            const useRag = (process.env.ENABLE_RAG || 'true') === 'true';
            if (useRag) {
                const qEmbedding = await this.generateEmbedding(userQuery, true);
                let hits = await vectorStore.search(qEmbedding, limit * 3);
                
                // Filter by documentIds if specified
                if (hasDocFilter) {
                    hits = hits.filter(h => documentIds.includes(h.documentId));
                }
                
                // Lower threshold to 0.25 to catch more potentially relevant content
                const relevantHits = hits.filter(h => h.score >= 0.25);

                if (relevantHits.length > 0) {
                    hasRelevantContent = true;
                    context += '\n\n=== RELEVANT DOCUMENT EXCERPTS ===\n';
                    if (hasDocFilter) {
                        context += `Searching within ${documentIds.length} selected document(s):\n\n`;
                    } else {
                        context += 'Use the following official BMU document excerpts to answer the user\'s question:\n\n';
                    }

                    // Group by document for better context
                    const byDoc = new Map();
                    for (const h of relevantHits) {
                        if (!byDoc.has(h.documentId)) {
                            byDoc.set(h.documentId, []);
                        }
                        byDoc.get(h.documentId).push(h);
                    }

                    // Get top documents (up to limit)
                    const topDocs = Array.from(byDoc.entries())
                        .sort((a, b) => Math.max(...b[1].map(x => x.score)) - Math.max(...a[1].map(x => x.score)))
                        .slice(0, limit);

                    for (const [docId, chunks] of topDocs) {
                        const doc = await Document.findById(docId);
                        if (!doc) continue;

                        context += `--- FROM: "${doc.title}" (${doc.category}) ---\n`;
                        
                        // Include multiple chunks from same document for better context
                        const sortedChunks = chunks.sort((a, b) => b.score - a.score).slice(0, 2);
                        for (const chunk of sortedChunks) {
                            const snippet = String(chunk.content || '').substring(0, 1200);
                            context += `${snippet}\n\n`;
                        }
                        
                        context += `--- END OF EXCERPT ---\n\n`;
                        
                        relevantDocs.push({
                            id: doc.id,
                            title: doc.title,
                            category: doc.category,
                            relevance: Math.max(...chunks.map(c => c.score)),
                            chunkIndex: sortedChunks[0].chunkIndex
                        });
                    }
                    
                    context += '=== END OF DOCUMENT EXCERPTS ===\n';
                    context += '\nIMPORTANT: Base your answer on the document excerpts provided above.';

                    return { context, documents: relevantDocs, hasRelevantContent, chunkCount: relevantHits.length };
                }
            }

            // MySQL full-text fallback
            let documents = await Document.searchByContent(userQuery, limit);
            
            // Filter by documentIds if specified
            if (hasDocFilter && documents.length > 0) {
                documents = documents.filter(doc => documentIds.includes(doc.id));
            }
            
            if (documents.length === 0) {
                return { context: '', documents: [], hasRelevantContent: false, chunkCount: 0 };
            }

            hasRelevantContent = true;
            context = '\n\n=== RELEVANT DOCUMENT EXCERPTS ===\n';
            if (hasDocFilter) {
                context += `Searching within ${documentIds.length} selected document(s):\n\n`;
            } else {
                context += 'Use the following official BMU document excerpts to answer the user\'s question:\n\n';
            }
            
            for (const doc of documents) {
                const fullDoc = await Document.findById(doc.id);
                if (fullDoc && fullDoc.content_text) {
                    const content = fullDoc.content_text.substring(0, 3000);
                    context += `--- FROM: "${doc.title}" (${doc.category}) ---\n`;
                    context += `${content}\n`;
                    context += `--- END OF EXCERPT ---\n\n`;
                    relevantDocs.push({
                        id: doc.id,
                        title: doc.title,
                        category: doc.category,
                        relevance: doc.relevance
                    });
                }
            }
            
            context += '=== END OF DOCUMENT EXCERPTS ===\n';
            context += '\nIMPORTANT: Base your answer on the document excerpts provided above.';

            return { context, documents: relevantDocs, hasRelevantContent, chunkCount: documents.length };
        } catch (error) {
            console.error('Error searching documents:', error);
            return { context: '', documents: [], hasRelevantContent: false, chunkCount: 0 };
        }
    }

    // Generate AI response using DeepSeek
    async generateResponse(userMessage, conversationHistory = [], sessionContext = {}) {
        const startTime = Date.now();
        const userId = sessionContext.userId;

        // Check usage limits for authenticated users
        if (userId) {
            const canProceed = await this.canUserMakeRequest(userId);
            if (!canProceed) {
                return {
                    success: false,
                    response: "You've reached your monthly limit of 100 prompts. Your limit will reset at the beginning of next month. Please contact an administrator if you need additional access.",
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: [],
                    limitReached: true
                };
            }
        }

        if (this._isChatContext(sessionContext) && this._isDocumentInventoryQuery(userMessage)) {
            try {
                const inventory = await this._buildDocumentInventoryResponse(sessionContext);
                return {
                    success: true,
                    response: inventory.response,
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: inventory.referencedDocuments,
                    model: 'system'
                };
            } catch (error) {
                console.error('[AIService] Document inventory error:', error.message);
                return {
                    success: false,
                    response: 'Unable to load the document list right now. Please try again.',
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: [],
                    model: 'system'
                };
            }
        }

        const officialUpdates = await this.getOfficialUpdates();
        const cacheKey = this._buildResponseCacheKey(userMessage, sessionContext, officialUpdates);

        if (this._isViceChancellorQuery(userMessage) && officialUpdates) {
            try {
                const vcResponse = await this._buildViceChancellorResponse(officialUpdates);
                return {
                    success: true,
                    response: vcResponse.response,
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: vcResponse.referencedDocuments,
                    model: 'system'
                };
            } catch (error) {
                console.error('[AIService] Vice Chancellor response error:', error.message);
            }
        }

        // Check DeepSeek API key
        if (!this.deepSeekApiKey) {
            return {
                success: false,
                response: "AI service is not configured. Please contact the administrator.",
                tokensUsed: 0,
                responseTimeMs: Date.now() - startTime,
                referencedDocuments: [],
                error: 'DEEPSEEK_API_KEY not configured'
            };
        }

        // Check Redis cache
        if (cacheService && conversationHistory.length <= 2) {
            try {
                const redisCached = await cacheService.getLLMResponse(cacheKey, 'deepseek');
                if (redisCached) {
                    // Still count against usage for cached responses
                    if (userId) await this.incrementUsage(userId, 0);
                    return {
                        success: true,
                        response: redisCached.response,
                        tokensUsed: 0,
                        responseTimeMs: Date.now() - startTime,
                        referencedDocuments: redisCached.referencedDocuments || [],
                        fromCache: true,
                        cacheType: 'redis'
                    };
                }
            } catch (e) {
                // Redis error shouldn't block
            }
        }

        // Check memory cache
        const cachedResp = this._responseCache.get(cacheKey);
        if (cachedResp && (Date.now() - cachedResp.timestamp) < this._responseCacheTTL) {
            if (userId) await this.incrementUsage(userId, 0);
            return {
                ...cachedResp.response,
                responseTimeMs: Date.now() - startTime,
                fromCache: true,
                cacheType: 'memory'
            };
        }

        try {
            const systemPrompt = await this.getSystemPrompt();
            const searchResult = await this.searchRelevantDocuments(userMessage, 8, sessionContext);
            const { context: docContext, documents: relevantDocs, hasRelevantContent, chunkCount } = searchResult;

            let enhancedSystemPrompt = systemPrompt;
            
            // Add document context with clear instructions
            if (hasRelevantContent && docContext) {
                enhancedSystemPrompt += docContext;
            } else {
                enhancedSystemPrompt += `

IMPORTANT: No relevant documents were found in the BMU knowledge base for this specific query.
- If the question is about BMU policies, procedures, or regulations, inform the user that you couldn't find specific documentation and suggest they contact the relevant university department.
- For general questions not specific to BMU, you may provide helpful general information while noting it's not from official BMU sources.
`;
            }

            if (officialUpdates) {
                enhancedSystemPrompt += `

OFFICIAL BMU UPDATES (highest priority, override document excerpts if conflicting):
${officialUpdates}
`;
            }
            
            // Add user context
            enhancedSystemPrompt += `

User Information:
- Role: ${sessionContext.userRole || 'staff'}
- Platform: ${sessionContext.platform || 'web'}
${hasRelevantContent ? `- Documents searched: ${chunkCount || relevantDocs.length} relevant excerpts found` : '- No relevant documents found'}

Remember: If OFFICIAL BMU UPDATES are provided above, they take precedence. Otherwise, if document excerpts are provided, you MUST use them to answer. Do not claim you don't have information if relevant excerpts are provided.`;

            const messages = [{ role: 'system', content: enhancedSystemPrompt }];

            // Add conversation history (last 4 messages)
            const recentHistory = conversationHistory.slice(-4);
            for (const msg of recentHistory) {
                const content = msg.content.length > 500 ? msg.content.substring(0, 500) + '...' : msg.content;
                messages.push({
                    role: msg.sender === 'user' ? 'user' : 'assistant',
                    content
                });
            }

            messages.push({ role: 'user', content: userMessage });

            // Call DeepSeek API
            console.log(`[AIService] Calling DeepSeek API`);
            const response = await axios.post(
                `${this.deepSeekBaseUrl}/chat/completions`,
                {
                    model: 'deepseek-chat',
                    messages: messages,
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    top_p: 0.9,
                    presence_penalty: 0.1,
                    frequency_penalty: 0.1
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.deepSeekApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );

            const aiResponse = response.data.choices[0].message.content;
            const tokensUsed = response.data.usage?.total_tokens || 0;
            const responseTime = Date.now() - startTime;

            // Increment usage for authenticated users
            if (userId) {
                await this.incrementUsage(userId, tokensUsed);
            }

            const result = {
                success: true,
                response: aiResponse,
                tokensUsed,
                responseTimeMs: responseTime,
                referencedDocuments: relevantDocs,
                model: 'deepseek-chat'
            };

            // Cache the response
            if (conversationHistory.length <= 2 && aiResponse && aiResponse.length > 50) {
                this._cacheResponse(userMessage, result, cacheKey);
            }

            return result;

        } catch (error) {
            console.error('AI Service Error:', error.response?.data || error.message);
            
            let errorResponse = "I apologize, but I'm experiencing technical difficulties.";
            
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                errorResponse = "Unable to connect to the AI service. Please try again.";
            } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
                errorResponse = "Request took too long. Please try a shorter question.";
            } else if (error.response?.status === 429) {
                errorResponse = "AI service is busy. Please wait and try again.";
            } else if (error.response?.status >= 500) {
                errorResponse = "AI service temporarily unavailable. Please try later.";
            }
            
            return {
                success: false,
                response: errorResponse,
                tokensUsed: 0,
                responseTimeMs: Date.now() - startTime,
                referencedDocuments: [],
                error: error.message
            };
        }
    }

    // Generate streaming response using DeepSeek
    async generateStreamingResponse(userMessage, conversationHistory = [], sessionContext = {}) {
        const startTime = Date.now();
        const { onChunk } = sessionContext;
        const userId = sessionContext.userId;

        // Check usage limits
        if (userId) {
            const canProceed = await this.canUserMakeRequest(userId);
            if (!canProceed) {
                const errorMsg = "You've reached your monthly limit of 100 prompts. Your limit resets next month.";
                if (onChunk) onChunk(errorMsg);
                return {
                    success: false,
                    fullResponse: errorMsg,
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: [],
                    limitReached: true
                };
            }
        }

        if (this._isChatContext(sessionContext) && this._isDocumentInventoryQuery(userMessage)) {
            try {
                const inventory = await this._buildDocumentInventoryResponse(sessionContext);
                if (onChunk) onChunk(inventory.response);
                return {
                    success: true,
                    fullResponse: inventory.response,
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: inventory.referencedDocuments,
                    fromCache: false,
                    model: 'system'
                };
            } catch (error) {
                const errorMsg = 'Unable to load the document list right now. Please try again.';
                console.error('[AIService] Document inventory error:', error.message);
                if (onChunk) onChunk(errorMsg);
                return {
                    success: false,
                    fullResponse: errorMsg,
                    tokensUsed: 0,
                    responseTimeMs: Date.now() - startTime,
                    referencedDocuments: [],
                    error: error.message
                };
            }
        }

        if (this._isViceChancellorQuery(userMessage)) {
            try {
                const officialUpdates = await this.getOfficialUpdates();
                if (officialUpdates) {
                    const vcResponse = await this._buildViceChancellorResponse(officialUpdates);
                    if (onChunk) onChunk(vcResponse.response);
                    return {
                        success: true,
                        fullResponse: vcResponse.response,
                        tokensUsed: 0,
                        responseTimeMs: Date.now() - startTime,
                        referencedDocuments: vcResponse.referencedDocuments,
                        fromCache: false,
                        model: 'system'
                    };
                }
            } catch (error) {
                console.error('[AIService] Vice Chancellor response error:', error.message);
            }
        }

        if (!this.deepSeekApiKey) {
            const errorMsg = "AI service is not configured. Please contact the administrator.";
            if (onChunk) onChunk(errorMsg);
            return {
                success: false,
                fullResponse: errorMsg,
                tokensUsed: 0,
                responseTimeMs: Date.now() - startTime,
                referencedDocuments: []
            };
        }

        try {
            const [systemPrompt, officialUpdates, searchResult] = await Promise.all([
                this.getSystemPrompt(),
                this.getOfficialUpdates(),
                this.searchRelevantDocuments(userMessage, 8, sessionContext)
            ]);

            const { context: docContext, documents: relevantDocs, hasRelevantContent, chunkCount } = searchResult;

            let enhancedSystemPrompt = systemPrompt;
            
            // Add document context with clear instructions
            if (hasRelevantContent && docContext) {
                enhancedSystemPrompt += docContext;
            } else {
                enhancedSystemPrompt += `

IMPORTANT: No relevant documents were found in the BMU knowledge base for this query.
Suggest contacting the relevant department for BMU-specific queries.
`;
            }

            if (officialUpdates) {
                enhancedSystemPrompt += `

OFFICIAL BMU UPDATES (highest priority, override document excerpts if conflicting):
${officialUpdates}
`;
            }
            
            enhancedSystemPrompt += `\nUser Role: ${sessionContext.userRole || 'staff'}`;
            enhancedSystemPrompt += `\n${hasRelevantContent ? `Documents found: ${chunkCount || relevantDocs.length} excerpts` : 'No documents found'}`;
            enhancedSystemPrompt += `\nRemember: OFFICIAL BMU UPDATES take precedence if provided; otherwise use document excerpts when available.`;

            const messages = [{ role: 'system', content: enhancedSystemPrompt }];
            
            const recentHistory = conversationHistory.slice(-3);
            for (const msg of recentHistory) {
                const content = msg.content.length > 400 ? msg.content.substring(0, 400) + '...' : msg.content;
                messages.push({
                    role: msg.sender === 'user' ? 'user' : 'assistant',
                    content
                });
            }
            messages.push({ role: 'user', content: userMessage });

            let fullResponse = '';
            let tokensUsed = 0;

            console.log(`[AIService] Streaming from DeepSeek`);
            
            const response = await axios.post(
                `${this.deepSeekBaseUrl}/chat/completions`,
                {
                    model: 'deepseek-chat',
                    messages: messages,
                    max_tokens: 1024,
                    temperature: this.temperature,
                    stream: true
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.deepSeekApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000,
                    responseType: 'stream'
                }
            );

            await new Promise((resolve, reject) => {
                let buffer = '';
                
                response.data.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;
                        
                        try {
                            const json = JSON.parse(data);
                            const content = json.choices?.[0]?.delta?.content;
                            if (content) {
                                fullResponse += content;
                                if (onChunk) onChunk(content);
                            }
                            if (json.usage) {
                                tokensUsed = json.usage.total_tokens || 0;
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                });
                
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });

            // Increment usage
            if (userId) {
                await this.incrementUsage(userId, tokensUsed);
            }

            const responseTime = Date.now() - startTime;
            console.log(`[AIService] Streaming complete: ${responseTime}ms`);

            return {
                success: true,
                fullResponse,
                tokensUsed,
                responseTimeMs: responseTime,
                referencedDocuments: relevantDocs,
                fromCache: false,
                model: 'deepseek-chat'
            };

        } catch (error) {
            console.error('Streaming AI Error:', error.message);
            
            const errorResponse = "I apologize, but I'm experiencing technical difficulties. Please try again.";
            if (onChunk) onChunk(errorResponse);
            
            return {
                success: false,
                fullResponse: errorResponse,
                tokensUsed: 0,
                responseTimeMs: Date.now() - startTime,
                referencedDocuments: [],
                error: error.message
            };
        }
    }

    // Generate response cache key
    _generateResponseCacheKey(query, salt = '') {
        const normalized = String(query || '')
            .toLowerCase()
            .trim()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .substring(0, 100);

        if (!salt) return normalized;

        const crypto = require('crypto');
        const saltHash = crypto.createHash('md5').update(String(salt)).digest('hex');
        return `${saltHash}:${normalized}`;
    }

    // Cache a successful response
    async _cacheResponse(query, response, cacheKeyOverride = null) {
        const cacheKey = cacheKeyOverride || this._generateResponseCacheKey(query);
        
        if (this._responseCache.size >= this._responseCacheMaxSize) {
            const firstKey = this._responseCache.keys().next().value;
            this._responseCache.delete(firstKey);
        }
        
        const cacheData = {
            success: response.success,
            response: response.response,
            tokensUsed: response.tokensUsed,
            referencedDocuments: response.referencedDocuments,
            model: response.model
        };
        
        this._responseCache.set(cacheKey, {
            response: cacheData,
            timestamp: Date.now()
        });
        
        if (cacheService) {
            cacheService.cacheLLMResponse(cacheKey, cacheData.response, 'deepseek').catch(e => {
                console.warn('[AIService] Redis cache write failed:', e.message);
            });
        }
    }

    // Generate embeddings (using Ollama)
    async generateEmbedding(text, useCache = true) {
        const input = String(text || '').substring(0, 8000).trim();
        if (!input) throw new Error('Cannot embed empty text');

        const cacheKey = input.toLowerCase().substring(0, 200);

        if (useCache && cacheService) {
            try {
                const redisEmbedding = await cacheService.getEmbedding(input);
                if (redisEmbedding) {
                    this._embeddingCache.set(cacheKey, redisEmbedding);
                    return redisEmbedding;
                }
            } catch (e) {}
        }

        if (useCache && this._embeddingCache.has(cacheKey)) {
            return this._embeddingCache.get(cacheKey);
        }

        try {
            const response = await axios.post(
                `${this.ollamaUrl.replace(/\/$/, '')}/api/embeddings`,
                {
                    model: this.ollamaEmbeddingModel,
                    prompt: input
                },
                { 
                    headers: { 'Content-Type': 'application/json' },
                    timeout: parseInt(process.env.OLLAMA_EMBED_TIMEOUT_MS || '120000', 10)
                }
            );

            const embedding = response.data?.embedding;
            if (!Array.isArray(embedding) || embedding.length === 0) {
                throw new Error('Ollama embeddings returned empty vector');
            }

            if (useCache && embedding) {
                if (this._embeddingCache.size >= this._embeddingCacheMaxSize) {
                    const firstKey = this._embeddingCache.keys().next().value;
                    this._embeddingCache.delete(firstKey);
                }
                
                this._embeddingCache.set(cacheKey, embedding);
                
                if (cacheService) {
                    cacheService.cacheEmbedding(input, embedding).catch(() => {});
                }
            }

            return embedding;
        } catch (error) {
            console.error('Embedding generation error:', error.message);
            throw new Error(error.response?.data?.error || error.message);
        }
    }

    // Analyze document
    async analyzeDocument(documentId) {
        const doc = await Document.findById(documentId);
        if (!doc || !doc.content_text) {
            throw new Error('Document not found or has no content');
        }

        const prompt = `
            Analyze this university document and extract:
            1. Main topics covered
            2. Key policies or regulations
            3. Important dates, deadlines, or requirements
            4. Target audience
            5. Brief summary (2-3 sentences)

            Document Title: ${doc.title}
            Category: ${doc.category}
            Content:
            ${doc.content_text.substring(0, 6000)}
        `;

        return await this.generateResponse(prompt, [], { userRole: 'system' });
    }

    // Generate suggestions
    async generateSuggestions(conversationHistory, count = 3) {
        try {
            const recentMessages = conversationHistory.slice(-5).map(m => m.content).join('\n');
            
            const prompt = `
                Based on this BMU conversation:
                ${recentMessages}
                
                Suggest ${count} follow-up questions. Return only questions, one per line.
            `;

            const response = await this.generateResponse(prompt, [], { userRole: 'system' });
            
            if (response.success) {
                return response.response.split('\n').filter(s => s.trim()).slice(0, count);
            }
            
            return [];
        } catch (error) {
            console.error('Suggestions error:', error.message);
            return [];
        }
    }

    isDocumentInventoryQuery(message) {
        return this._isDocumentInventoryQuery(message);
    }

    async getDocumentInventoryResponse(sessionContext = {}) {
        return this._buildDocumentInventoryResponse(sessionContext);
    }

    isViceChancellorQuery(message) {
        return this._isViceChancellorQuery(message);
    }

    async getViceChancellorResponse() {
        return this.getPrincipalOfficerResponse('name of the vice chancellor');
    }

    isPrincipalOfficerQuery(message) {
        return Boolean(this._detectPrincipalOfficer(message));
    }

    async getPrincipalOfficerResponse(message) {
        const officer = this._detectPrincipalOfficer(message);
        if (!officer) {
            return {
                response: 'Please specify the BMU principal officer role you want to ask about.',
                referencedDocuments: []
            };
        }

        const lookup = await this._lookupPrincipalOfficer(officer);
        const name = this._normalizeOfficerName(officer, lookup.name);
        if (name) {
            const sourceLabel = lookup.sourceLabel || 'BMU principal officer records';
            const response = `The ${officer.label} is ${name}.\n\nSource: ${sourceLabel}.`;
            return {
                response,
                referencedDocuments: lookup.referencedDocument ? [lookup.referencedDocument] : []
            };
        }

        const officialUpdates = await this.getOfficialUpdates();
        const updateLine = this._extractPrincipalOfficerFromText(officer, officialUpdates);
        const updateName = this._normalizeOfficerName(officer, updateLine);
        if (updateName) {
            return {
                response: `The ${officer.label} is ${updateName}.\n\nSource: official BMU update.`,
                referencedDocuments: []
            };
        }

        return {
            response: `I could not find a current approved name for the ${officer.label} in the BMU advisor knowledge base.`,
            referencedDocuments: []
        };
    }

    _isChatContext(sessionContext = {}) {
        return Boolean(sessionContext && typeof sessionContext.platform === 'string');
    }

    _isDocumentInventoryQuery(message) {
        const text = String(message || '').toLowerCase().trim();
        if (!text) return false;
        if (!/\b(documents?|docs)\b/.test(text)) return false;

        const requirementPattern = /\b(documents?|docs)\b.*\b(required|required for|needed|need|requirements)\b/;
        const admissionPattern = /\b(documents?|docs)\b\s+(for|to)\s+(admission|application|enrollment|registration|clearance|verification)\b/;
        if (requirementPattern.test(text) || admissionPattern.test(text)) return false;

        const directPatterns = [
            /^what\s+documents?\b/,
            /^which\s+documents?\b/,
            /\bdocuments?\s+are\s+available\b/,
            /\bdocuments?\s+do\s+you\s+have\b/,
            /\bavailable\s+documents?\b/,
            /\bdocument\s+inventory\b/
        ];

        if (directPatterns.some(pattern => pattern.test(text))) return true;

        const hints = [
            /\b(all|available|indexed|ingested|trained|loaded)\b/,
            /\b(in|inside)\b.*\b(system|database|knowledge base|knowledgebase|documents page)\b/,
            /\b(do you have|you have|you can access|you are trained on|you know about)\b/,
            /\b(list|show|display)\b/,
            /\b(document list|list of documents)\b/
        ];

        return hints.some(pattern => pattern.test(text));
    }

    async _buildDocumentInventoryResponse(sessionContext = {}) {
        const documentIds = sessionContext.documentIds;
        const hasDocFilter = Array.isArray(documentIds) && documentIds.length > 0;

        const docs = await Document.getActiveList();

        if (!docs.length) {
            const emptyMsg = hasDocFilter
                ? 'No active documents found in your current selection.'
                : 'No active documents found in the knowledge base.';
            return { response: emptyMsg, referencedDocuments: [] };
        }

        const groups = {
            completed: [],
            processing: [],
            pending: [],
            failed: [],
            unknown: []
        };

        for (const doc of docs) {
            const status = (doc.embedding_status || 'unknown').toLowerCase();
            if (groups[status]) {
                groups[status].push(doc);
            } else {
                groups.unknown.push(doc);
            }
        }

        const total = docs.length;
        const intro = hasDocFilter
            ? `You currently have a document filter enabled (${documentIds.length} selected). Here is the full BMU document inventory (${total} total):`
            : `Here are the BMU documents in the knowledge base (${total} total):`;

        const lines = [intro];

        const sectionOrder = [
            { key: 'completed', label: 'Ready for chat' },
            { key: 'processing', label: 'Processing' },
            { key: 'pending', label: 'Pending' },
            { key: 'failed', label: 'Failed' },
            { key: 'unknown', label: 'Other status' }
        ];

        for (const section of sectionOrder) {
            const list = groups[section.key];
            if (!list.length) continue;
            lines.push('', `${section.label} (${list.length}):`);
            for (const doc of list) {
                const category = doc.category ? ` (${doc.category})` : '';
                lines.push(`- ${doc.title}${category}`);
            }
        }

        lines.push('');
        if (hasDocFilter) {
            lines.push('Note: The chat filter remains active; clear it to search across all documents.');
        }
        lines.push('Only documents marked "completed" are used for chat responses.');

        return {
            response: lines.join('\n'),
            referencedDocuments: docs.map(doc => ({
                id: doc.id,
                title: doc.title,
                category: doc.category,
                embeddingStatus: doc.embedding_status
            }))
        };
    }

    _isViceChancellorQuery(message) {
        const officer = this._detectPrincipalOfficer(message);
        return officer?.key === 'vice_chancellor';
    }

    _principalOfficerDefinitions() {
        return [
            {
                key: 'vice_chancellor',
                label: 'Vice-Chancellor',
                officeTerms: ['vice-chancellor', 'vice chancellor', 'vc'],
                patterns: [/vice[-\s]?chancellor/i, /vice\s+(?:counsell?or|cancellor|cancel(?:l)?or)/i, /\bv\s*c\b/i, /\bvc\b/i, /wise\s+chancellor/i, /first\s+chancellor/i]
            },
            {
                key: 'deputy_vice_chancellor_sampou',
                label: 'Deputy Vice-Chancellor (Sampou)',
                officeTerms: ['deputy vice-chancellor (sampou)', 'deputy vice chancellor sampou', 'dvc sampou'],
                patterns: [/deputy\s+vice[-\s]?chancellor.*sampou/i, /\bdvc\b.*sampou/i]
            },
            {
                key: 'deputy_vice_chancellor',
                label: 'Deputy Vice-Chancellor',
                officeTerms: ['deputy vice-chancellor', 'deputy vice chancellor', 'dvc'],
                patterns: [/deputy\s+vice[-\s]?chancellor/i, /\bdvc\b/i]
            },
            {
                key: 'registrar',
                label: 'Registrar',
                officeTerms: ['registrar'],
                patterns: [/\bregistrar\b/i]
            },
            {
                key: 'bursar',
                label: 'Bursar',
                officeTerms: ['bursar'],
                patterns: [/\bbursar\b/i, /\b(?:boss|bossa|bosa|bussa|bursah)\b/i]
            },
            {
                key: 'university_librarian',
                label: 'University Librarian',
                officeTerms: ['university librarian', 'librarian'],
                patterns: [/university\s+librarian/i, /\blibrarian\b/i]
            },
            {
                key: 'governing_council_chair',
                label: 'Pro-Chancellor / Chairman of Governing Council',
                officeTerms: ['pro-chancellor', 'pro chancellor', 'governing council chair', 'governing council chairman', 'council chair', 'council chairman', 'chairman governing council', 'chairman of the governing council'],
                patterns: [/pro[-\s]?chancellor/i, /governing\s+council\s+chair(?:man)?/i, /council\s+chair(?:man)?/i, /chair(?:man)?\s+(?:of\s+)?(?:the\s+)?governing\s+council/i]
            }
        ];
    }

    _detectPrincipalOfficer(message) {
        const text = String(message || '').toLowerCase().trim();
        if (!text) return null;

        const nameIntent = [
            /\bwho\b/,
            /\bname\b/,
            /\bcurrent\b/,
            /\bnow\b/,
            /\bpresent\b/,
            /\bofficer\b/,
            /\bprincipal\s+officer\b/,
            /\btell\s+me\b/
        ];

        const hasNameIntent = nameIntent.some(pattern => pattern.test(text));
        const definitions = this._principalOfficerDefinitions();
        const match = definitions.find(def => def.patterns.some(pattern => pattern.test(text)));
        if (!match) return null;

        // Role-only queries such as "bursar" and "VC" should still resolve.
        const compactRoleOnly = text.replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).length <= 4;
        return hasNameIntent || compactRoleOnly ? match : null;
    }

    async _lookupPrincipalOfficer(officer) {
        const fromAcademicOfficers = await this._lookupOfficerInAcademicOfficers(officer);
        if (fromAcademicOfficers.name) return fromAcademicOfficers;

        const fromStructuredFacts = await this._lookupOfficerInStructuredFacts(officer);
        if (fromStructuredFacts.name) return fromStructuredFacts;

        const fromProfile = await this._lookupOfficerInProfileDocuments(officer);
        if (fromProfile.name) return fromProfile;

        return { name: '', sourceLabel: '', referencedDocument: null };
    }

    async _lookupOfficerInAcademicOfficers(officer) {
        try {
            const terms = officer.officeTerms.map(term => term.toLowerCase());
            const likeClause = terms
                .map(() => "(LOWER(office) LIKE ? OR LOWER(COALESCE(raw_text, '')) LIKE ?)")
                .join(' OR ');
            const params = terms.flatMap(term => [`%${term}%`, `%${term}%`]);
            const rows = await query(`
                SELECT office, officer_name, source_path, raw_text, scope_label
                FROM academic_officers
                WHERE status = 'active' AND (${likeClause})
                ORDER BY updated_at DESC
                LIMIT 5
            `, params);

            for (const row of rows || []) {
                const raw = row.officer_name || row.raw_text || '';
                const name = this._extractPrincipalOfficerFromText(officer, `${row.office || ''}: ${raw}`);
                if (name) {
                    return {
                        name,
                        sourceLabel: row.scope_label || row.source_path || 'approved academic officer record',
                        referencedDocument: null
                    };
                }
            }
        } catch (error) {
            console.warn('[AIService] Academic officer lookup skipped:', error.message);
        }

        return { name: '', sourceLabel: '', referencedDocument: null };
    }

    async _lookupOfficerInStructuredFacts(officer) {
        try {
            const terms = officer.officeTerms.map(term => term.toLowerCase());
            const likeClause = terms
                .map(() => "(LOWER(subject) LIKE ? OR LOWER(COALESCE(human_text, '')) LIKE ? OR LOWER(COALESCE(source_path, '')) LIKE ?)")
                .join(' OR ');
            const params = terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]);
            const rows = await query(`
                SELECT subject, human_text, source_path, authority_rank
                FROM structured_facts
                WHERE status = 'active' AND (${likeClause})
                ORDER BY authority_rank DESC, updated_at DESC
                LIMIT 8
            `, params);

            for (const row of rows || []) {
                const raw = `${row.subject || ''}: ${row.human_text || ''}`;
                const name = this._extractPrincipalOfficerFromText(officer, raw);
                if (name) {
                    return {
                        name,
                        sourceLabel: row.source_path || 'approved structured fact',
                        referencedDocument: null
                    };
                }
            }
        } catch (error) {
            console.warn('[AIService] Structured officer fact lookup skipped:', error.message);
        }

        return { name: '', sourceLabel: '', referencedDocument: null };
    }

    async _lookupOfficerInProfileDocuments(officer) {
        try {
            const terms = officer.officeTerms.map(term => term.toLowerCase());
            const contentClause = terms.map(() => 'LOWER(dc.content) LIKE ?').join(' OR ');
            const params = terms.map(term => `%${term}%`);
            const rows = await query(`
                SELECT d.id, d.title, d.category, dc.content
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE d.is_active = TRUE
                  AND (
                    LOWER(d.title) LIKE '%brief profile%'
                    OR LOWER(d.title) LIKE '%profile of bmu%'
                    OR LOWER(d.title) LIKE '%quick facts%'
                  )
                  AND (${contentClause})
                ORDER BY
                  CASE
                    WHEN LOWER(d.title) LIKE '%brief profile%' THEN 0
                    WHEN LOWER(d.title) LIKE '%profile of bmu%' THEN 1
                    ELSE 2
                  END,
                  dc.chunk_index ASC
                LIMIT 8
            `, params);

            for (const row of rows || []) {
                const name = this._extractPrincipalOfficerFromText(officer, row.content || '');
                if (name) {
                    return {
                        name,
                        sourceLabel: row.title || 'BMU profile document',
                        referencedDocument: {
                            id: row.id,
                            title: row.title,
                            category: row.category
                        }
                    };
                }
            }
        } catch (error) {
            console.warn('[AIService] Profile officer lookup skipped:', error.message);
        }

        return { name: '', sourceLabel: '', referencedDocument: null };
    }

    _extractPrincipalOfficerFromText(officer, sourceText) {
        const text = String(sourceText || '')
            .replace(/`n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\s+\n/g, '\n')
            .replace(/\n\s+/g, '\n')
            .trim();
        if (!text) return '';

        const labels = officer.officeTerms
            .filter(term => term !== 'vc' && term !== 'dvc')
            .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '[-\\s]+'));
        const labelPattern = labels.length ? labels.join('|') : officer.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = [
            'Vice[-\\s]?Chancellor',
            'Deputy\\s+Vice[-\\s]?Chancellor(?:\\s*\\(Sampou\\))?',
            'Registrar',
            'Bursar',
            'University\\s+Librarian',
            'Governing\\s+Council\\s+Chair',
            'Governing\\s+Council\\s+Chairman',
            'Pro[-\\s]?Chancellor',
            'Meetings?\\s+Schedule',
            'Administrative\\s+Structure'
        ].join('|');

        const rowPattern = new RegExp(`(?:^|[\\n|])\\s*(?:${labelPattern})\\s*(?:[:\\-|–—]|\\s{2,})\\s*([^\\n|]+?)(?=\\s+(?:${boundary})\\s*(?::|$)|\\n|\\||$)`, 'i');
        const rowMatch = text.match(rowPattern);
        if (rowMatch && rowMatch[1]) {
            return this._cleanOfficerName(rowMatch[1]);
        }

        const inlinePattern = new RegExp(`(?:${labelPattern})\\s*[:\\-|–—]?\\s*((?:Prof\\.?|Professor|Dr\\.?|Mr\\.?|Mrs\\.?|Ms\\.?|Barr\\.?)\\s*(?:\\([^)]+\\)\\s*)?[A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,5}(?:\\s*\\([^)]+\\))?)`, 'i');
        const inlineMatch = text.match(inlinePattern);
        if (inlineMatch && inlineMatch[1]) {
            return this._cleanOfficerName(inlineMatch[1]);
        }

        return '';
    }

    _cleanOfficerName(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*\((?:appointed|inaugurated|acting|current)\b[^)]*\)\s*/ig, ' ')
            .replace(/\b(?:under|with|overall|weekly|twice|monthly|quarterly)\b.*$/i, '')
            .replace(/[.;,:\-|–—\s]+$/g, '')
            .trim();
    }

    _normalizeOfficerName(officer, value) {
        const raw = this._cleanOfficerName(value);
        if (officer?.key === 'bursar') {
            if (!raw || /ebiapiado\s+ombu/i.test(raw) || /ebipiado\s+ombu/i.test(raw)) {
                return 'Dr Ebipuado Ombu';
            }
        }
        return raw;
    }

    _extractViceChancellorUpdate(officialUpdates) {
        const text = String(officialUpdates || '').trim();
        if (!text) return '';

        const lines = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        const lineMatch = lines.find(line => /vice[-\s]?chancellor/i.test(line));
        if (lineMatch) return lineMatch;

        const sentences = text.split('. ').map(s => s.trim()).filter(Boolean);
        const sentenceMatch = sentences.find(sentence => /vice[-\s]?chancellor/i.test(sentence));
        return sentenceMatch || text;
    }

    async _getProfileDocReference() {
        try {
            const rows = await query(
                "SELECT id, title, category FROM documents WHERE is_active = TRUE AND title LIKE '%Profile of BMU%' LIMIT 1"
            );
            return rows[0] || null;
        } catch (error) {
            console.warn('[AIService] Failed to load Profile of BMU reference:', error.message);
            return null;
        }
    }

    async _extractViceChancellorFromProfileDoc() {
        try {
            const rows = await query(`
                SELECT dc.content
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE d.is_active = TRUE
                  AND d.title LIKE '%Profile of BMU%'
                  AND dc.content LIKE '%Vice-Chancellor%'
                ORDER BY dc.chunk_index ASC
                LIMIT 1
            `);
            const content = rows[0]?.content || '';
            if (!content) return '';

            const match = content.match(/Vice[-\s]?Chancellor\s*:\s*([^\\n\\r]+?)(?:\\s+Deputy Vice-Chancellors\\s*:\\s*|\\s+Registrar\\s*:\\s*|$)/i);
            if (match && match[1]) {
                return `Vice-Chancellor: ${match[1].trim()}`;
            }

            return content;
        } catch (error) {
            console.warn('[AIService] Failed to extract Vice Chancellor from Profile of BMU:', error.message);
            return '';
        }
    }

    async _buildViceChancellorResponse(officialUpdates) {
        const updateLine = this._extractViceChancellorUpdate(officialUpdates);
        const profileLine = await this._extractViceChancellorFromProfileDoc();
        const responseLines = [];

        if (updateLine) {
            if (!/current\s+vice[-\s]?chancellor/i.test(updateLine)) {
                responseLines.push('Current Vice Chancellor (official BMU update):');
            }
            responseLines.push(updateLine);
        } else if (profileLine) {
            responseLines.push('Current Vice Chancellor (Profile of BMU):');
            responseLines.push(profileLine);
        } else if (officialUpdates && officialUpdates.trim()) {
            responseLines.push('Official BMU updates:');
            responseLines.push(officialUpdates.trim());
        } else {
            responseLines.push('No official update is available for the Vice Chancellor at this time.');
        }

        const profileDoc = await this._getProfileDocReference();
        if (profileDoc) {
            responseLines.push('', `Source document: ${profileDoc.title}.`);
        }

        return {
            response: responseLines.join('\n'),
            referencedDocuments: profileDoc ? [profileDoc] : []
        };
    }

    _getDocumentFilterKey(sessionContext = {}) {
        const documentIds = sessionContext.documentIds;
        if (!Array.isArray(documentIds) || documentIds.length === 0) return 'all';

        const ids = documentIds
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id > 0)
            .sort((a, b) => a - b);

        if (ids.length === 0) return 'all';
        return ids.join(',');
    }

    _buildResponseCacheKey(userMessage, sessionContext = {}, officialUpdates = '') {
        const docFilterKey = this._getDocumentFilterKey(sessionContext);
        const salt = `${String(officialUpdates || '').trim()}|docs:${docFilterKey}`;
        return this._generateResponseCacheKey(userMessage, salt);
    }

    // Get cache stats
    getResponseCacheStats() {
        const validEntries = Array.from(this._responseCache.entries())
            .filter(([_, v]) => (Date.now() - v.timestamp) < this._responseCacheTTL).length;
        
        return {
            memory: {
                size: this._responseCache.size,
                validEntries,
                maxSize: this._responseCacheMaxSize
            },
            redis: cacheService ? cacheService.getStats() : null
        };
    }

    // Clear caches
    clearRetrievalCache() {
        this._embeddingCache.clear();
        
        const retrieval = this._getRetrievalService();
        if (retrieval && typeof retrieval.clearCache === 'function') {
            retrieval.clearCache('all');
        }
        
        console.log('[AIService] Caches cleared');
    }

    // Get retrieval metrics
    getRetrievalMetrics() {
        const retrieval = this._getRetrievalService();
        if (retrieval && typeof retrieval.getMetrics === 'function') {
            return { enhanced: true, ...retrieval.getMetrics() };
        }
        return { enhanced: false, embeddingCacheSize: this._embeddingCache.size };
    }

    // Get available AI models - DeepSeek only, available to all users
    getAvailableModels(userRole = 'staff') {
        // DeepSeek is available to ALL users now
        return [
            {
                id: 'deepseek-chat',
                name: 'DeepSeek',
                provider: 'deepseek',
                description: 'DeepSeek AI - Fast and intelligent responses',
                speed: 'fast',
                isDefault: true,
                available: true
            }
        ];
    }
}

module.exports = new AIService();
