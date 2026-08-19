/**
 * FAQ Service - Comprehensive Q&A generation, caching, and semantic matching
 * 
 * This service provides:
 * 1. Automatic phased Q&A generation from documents using AI
 * 2. Semantic search for finding similar cached questions
 * 3. Cache-first response system to reduce LLM load
 * 4. Hierarchical question generation (definitional, procedural, role-specific, cross-reference)
 * 5. Background processing for long documents
 */

const { query } = require('../../config/db');
const CachedQA = require('../models/CachedQA');
const FAQCategory = require('../models/FAQCategory');
const Document = require('../models/Document');
const aiService = require('./aiService');

function _classifyCourseIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!/(course|courses|curriculum|units?)/i.test(q)) {
        return { mode: 'neutral', query: q };
    }

    const hasSpecificScope = /(in|for|under|within)\s+(the\s+)?(department|faculty|school|programme|program|discipline)/i.test(q)
        || /\b(100|200|300|400|500|600)\s*level\b/i.test(q)
        || /\b(medicine|nursing|pharmacy|anatomy|physiology|biochemistry|medical\s+laboratory|mls|public\s+health|radiography|dentistry)\b/i.test(q);

    // Generic "courses offered at BMU" should resolve toward programme-style FAQs.
    const isGenericProgrammeQuery = /(all\s+courses|courses\s+offered|offer\w*\s+courses|list\s+courses)/i.test(q)
        && !hasSpecificScope;

    if (isGenericProgrammeQuery) {
        return {
            mode: 'programme',
            query: q.replace(/\bcourses?\b/g, 'programme')
        };
    }

    if (hasSpecificScope) {
        return {
            mode: 'specific_course',
            query: `${q} student courses`
        };
    }

    return {
        mode: 'generic_course',
        query: q.replace(/\bcourses?\b/g, 'programme')
    };
}

function _isFeeAmountQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /(fee|fees|tuition|cost|payment|payable|levy|how\s+much|pay)/i.test(q)
        && /(indigene|non[-\s]?indigene|programme|program|course|level|\b100\b|\b200\b|\b300\b|\b400\b|\b500\b|\b600\b|medicine|mbbs|nursing|pharmacy|laboratory|dentistry|public\s+health|community\s+health|optometry|physiotherapy|radiography|anatomy|physiology|biochemistry|computer\s+science|microbiology|statistics|mathematics|physics|chemistry|biology|nutrition|dental)/i.test(q);
}

function _qaLooksLikeFeeAmount(qa) {
    const hay = `${qa?.question || ''}\n${qa?.answer || ''}\n${JSON.stringify(qa?.answerSources || [])}`.toLowerCase();
    return /fee structures? new\.docx|official\s+total\s+payable|indigene\s+total\s+payable|non[-\s]?indigene\s+total\s+payable|\bn\d{2,}/i.test(hay);
}

function _cacheMatchAllowed(userQuery, qa) {
    if (_isFeeAmountQuestion(userQuery) && !_qaLooksLikeFeeAmount(qa)) {
        console.log(`[FAQService] Rejected FAQ match for fee amount query: "${String(userQuery).slice(0, 50)}..." -> "${String(qa?.question || '').slice(0, 50)}..."`);
        return false;
    }
    return true;
}

// Q&A generation phase configurations
const QA_GENERATION_PHASES = {
    // Phase 1: Foundational/Definitional questions
    FOUNDATIONAL: {
        name: 'foundational',
        targetCount: 15,
        focus: 'definitions, scope, key terms, applicability, purpose statements',
        promptTemplate: (docTitle, category, content) => `You are an expert FAQ generator for Bayelsa Medical University documents.

DOCUMENT: "${docTitle}" (Category: ${category})
CONTENT FOCUS: Definitions, scope, and foundational concepts

CONTENT:
${content}

Generate ${15} foundational questions and answers covering:
1. Definitions of key terms used in the document
2. Scope and applicability (who does this apply to?)
3. Purpose and objectives of the document/policy
4. Basic eligibility criteria mentioned
5. Key dates or periods referenced

RULES:
- Questions should be phrased as users would naturally ask
- Answers must be extractive (directly from document text)
- Each answer must include section/chapter reference in parentheses
- Keep answers concise but complete

OUTPUT FORMAT (JSON array only):
[{"question":"...","variations":["alt1","alt2"],"answer":"...","sources":["Section X.X"],"type":"definitional"}]`
    },

    // Phase 2: Procedural & Policy questions
    PROCEDURAL: {
        name: 'procedural',
        targetCount: 25,
        focus: 'processes, procedures, rules, requirements, how-to',
        promptTemplate: (docTitle, category, content) => `You are an expert FAQ generator for Bayelsa Medical University documents.

DOCUMENT: "${docTitle}" (Category: ${category})
CONTENT FOCUS: Procedures, processes, and policy rules

CONTENT:
${content}

Generate ${25} procedural questions and answers covering:
1. "How do I...?" process questions
2. "What are the steps to...?" procedure questions
3. "What documents are required for...?" requirement questions
4. "Who approves/authorizes...?" authority questions
5. "What is the timeline/deadline for...?" timing questions
6. "What happens if...?" consequence questions

RULES:
- Include variations of how users might phrase each question
- Answers must quote or paraphrase document text directly
- Always cite the specific section, chapter, or annexure
- Cover all major procedures mentioned in the content

OUTPUT FORMAT (JSON array only):
[{"question":"...","variations":["alt1","alt2"],"answer":"...","sources":["Section X.X"],"type":"procedural"}]`
    },

    // Phase 3: Quantitative & Specific Details
    QUANTITATIVE: {
        name: 'quantitative',
        targetCount: 20,
        focus: 'numbers, amounts, durations, limits, scales, percentages',
        promptTemplate: (docTitle, category, content) => `You are an expert FAQ generator for Bayelsa Medical University documents.

DOCUMENT: "${docTitle}" (Category: ${category})
CONTENT FOCUS: Quantitative details and specific values

CONTENT:
${content}

Generate ${20} questions about specific numbers and quantities:
1. "How many days/hours/months for...?" duration questions
2. "What is the maximum/minimum for...?" limit questions
3. "What percentage/rate applies to...?" calculation questions
4. "How much does... cost/pay?" financial questions
5. "What is the salary/allowance for...?" compensation questions
6. "How many times can...?" frequency questions

RULES:
- Extract exact numbers, percentages, durations from the document
- If ranges are mentioned, include the full range in answers
- Always cite the specific location in the document
- Include unit of measurement in answers

OUTPUT FORMAT (JSON array only):
[{"question":"...","variations":["alt1","alt2"],"answer":"...","sources":["Section X.X"],"type":"quantitative"}]`
    },

    // Phase 4: Role-specific & Cadre Details
    ROLE_SPECIFIC: {
        name: 'role_specific',
        targetCount: 20,
        focus: 'job roles, cadres, qualifications, promotions, career paths',
        promptTemplate: (docTitle, category, content) => `You are an expert FAQ generator for Bayelsa Medical University documents.

DOCUMENT: "${docTitle}" (Category: ${category})
CONTENT FOCUS: Role-specific information, qualifications, career progression

CONTENT:
${content}

Generate ${20} role-specific questions covering:
1. "What qualifications are required for [position]?"
2. "What is the career path for [role]?"
3. "What are the duties/responsibilities of [position]?"
4. "How do I get promoted from [level] to [next level]?"
5. "What experience is needed for [role]?"
6. "What is the salary grade/scale for [position]?"

RULES:
- Create questions for each distinct role/position mentioned
- Include both entry requirements and progression paths
- Reference specific annexures or schedules containing role details
- Use actual job titles from the document

OUTPUT FORMAT (JSON array only):
[{"question":"...","variations":["alt1","alt2"],"answer":"...","sources":["Section X.X"],"type":"role_specific"}]`
    },

    // Phase 5: Scenario-based & Cross-reference
    SCENARIO: {
        name: 'scenario',
        targetCount: 15,
        focus: 'complex scenarios, conditional situations, cross-section combinations',
        promptTemplate: (docTitle, category, content) => `You are an expert FAQ generator for Bayelsa Medical University documents.

DOCUMENT: "${docTitle}" (Category: ${category})
CONTENT FOCUS: Complex scenarios and conditional situations

CONTENT:
${content}

Generate ${15} scenario-based questions covering:
1. "What if I [condition] while [situation]?" conditional questions
2. "Can I [action] if I am [status]?" eligibility edge cases
3. "What is the difference between [A] and [B]?" comparison questions
4. Questions combining information from multiple sections
5. Exception cases and special circumstances
6. Conflict resolution between policies

RULES:
- Synthesize information from multiple parts of the document when relevant
- Address real-world scenarios employees/students might face
- Include questions about exceptions to general rules
- Reference all relevant sections in the answer

OUTPUT FORMAT (JSON array only):
[{"question":"...","variations":["alt1","alt2"],"answer":"...","sources":["Section X.X","Section Y.Y"],"type":"scenario"}]`
    },

    // Phase 6: Rights, Responsibilities & Compliance
    COMPLIANCE: {
        name: 'compliance',
        targetCount: 15,
        focus: 'rights, obligations, compliance requirements, disciplinary matters',
        promptTemplate: (docTitle, category, content) => `You are an expert FAQ generator for Bayelsa Medical University documents.

DOCUMENT: "${docTitle}" (Category: ${category})
CONTENT FOCUS: Rights, responsibilities, and compliance

CONTENT:
${content}

Generate ${15} questions about rights and obligations:
1. "What are my rights regarding...?" rights questions
2. "What am I required to do when...?" obligation questions
3. "What happens if I fail to...?" consequence questions
4. "Can I be disciplined for...?" disciplinary questions
5. "Who can I report [issue] to?" grievance questions
6. "What protections exist for...?" protection questions

RULES:
- Cover both employee/student rights and institutional rights
- Include disciplinary procedures and appeals processes
- Reference grievance mechanisms mentioned
- Cite specific penalties or consequences from the document

OUTPUT FORMAT (JSON array only):
[{"question":"...","variations":["alt1","alt2"],"answer":"...","sources":["Section X.X"],"type":"compliance"}]`
    }
};

class FAQService {
    constructor() {
        // Cache settings (loaded from DB on first use)
        this._settings = null;
        this._settingsLoadedAt = 0;
        this._settingsTTL = 60 * 1000; // Reload settings every minute

        // In-memory FAQ embedding index for fast search
        this._faqEmbeddings = null;
        this._faqEmbeddingsLoadedAt = 0;
        this._faqEmbeddingsTTL = 5 * 60 * 1000; // Reload every 5 minutes
        
        // Background job queue for phased generation
        this._generationQueue = [];
        this._isProcessingQueue = false;
    }

    /**
     * Load settings from database
     */
    async _loadSettings() {
        const now = Date.now();
        if (this._settings && (now - this._settingsLoadedAt) < this._settingsTTL) {
            return this._settings;
        }

        const rows = await query(`
            SELECT setting_key, setting_value, setting_type 
            FROM system_settings 
            WHERE setting_key LIKE 'faq_%'
        `);

        this._settings = {};
        for (const row of rows) {
            let value = row.setting_value;
            if (row.setting_type === 'number') value = parseFloat(value);
            else if (row.setting_type === 'boolean') value = value === 'true';
            this._settings[row.setting_key] = value;
        }

        // Defaults - Enhanced for comprehensive Q&A generation
        this._settings.faq_cache_enabled = this._settings.faq_cache_enabled ?? true;
        this._settings.faq_similarity_threshold = this._settings.faq_similarity_threshold ?? 0.85; // Higher threshold to reduce false matches
        this._settings.faq_max_questions_per_doc = this._settings.faq_max_questions_per_doc ?? 110; // Increased for comprehensive coverage
        this._settings.faq_auto_generate = this._settings.faq_auto_generate ?? true; // Enable auto-generation by default
        this._settings.faq_phased_generation = this._settings.faq_phased_generation ?? true; // Enable phased generation
        this._settings.faq_chunk_size = this._settings.faq_chunk_size ?? 8000; // Content chunk size for each phase

        this._settingsLoadedAt = now;
        return this._settings;
    }

    /**
     * Check if FAQ caching is enabled
     */
    async isEnabled() {
        const settings = await this._loadSettings();
        return settings.faq_cache_enabled;
    }

    /**
     * Load FAQ embeddings into memory for fast search
     */
    async _loadFAQEmbeddings() {
        const now = Date.now();
        if (this._faqEmbeddings && (now - this._faqEmbeddingsLoadedAt) < this._faqEmbeddingsTTL) {
            return this._faqEmbeddings;
        }

        try {
            this._faqEmbeddings = await CachedQA.getAllEmbeddings();
            this._faqEmbeddingsLoadedAt = now;
            console.log(`[FAQService] Loaded ${this._faqEmbeddings.length} FAQ embeddings into memory`);
        } catch (error) {
            console.error('[FAQService] Error loading FAQ embeddings:', error.message);
            this._faqEmbeddings = [];
        }

        return this._faqEmbeddings;
    }

    /**
     * Invalidate FAQ embeddings cache (call after adding/updating FAQs)
     */
    invalidateEmbeddingsCache() {
        this._faqEmbeddings = null;
        this._faqEmbeddingsLoadedAt = 0;
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        
        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        return magnitude === 0 ? 0 : dotProduct / magnitude;
    }

    /**
     * Find similar cached Q&A using semantic search
     * Returns the best match if above threshold, null otherwise
     */
    async findSimilarQuestion(userQuery, options = {}) {
        const settings = await this._loadSettings();
        if (!settings.faq_cache_enabled) return null;

        const startTime = Date.now();
        const threshold = options.threshold || settings.faq_similarity_threshold;
        const courseIntent = _classifyCourseIntent(userQuery);
        const searchQuery = courseIntent.query || userQuery;

        // === QUERY VALIDATION ===
        // Reject very short or ambiguous queries that are prone to false matches
        const normalizedQuery = String(searchQuery || userQuery).trim().toLowerCase();
        const wordCount = normalizedQuery.split(/\s+/).filter(w => w.length > 1).length;
        
        // STRICT thresholds to prevent hallucination from bad FAQ matches
        // Semantic similarity often produces false positives at < 90%
        let effectiveThreshold;
        if (wordCount <= 1) {
            // Skip single-word queries entirely (handled below)
            effectiveThreshold = 1.0;
        } else if (wordCount <= 3) {
            effectiveThreshold = Math.max(threshold, 0.94);  // 94%+ for very short queries
        } else if (wordCount <= 5) {
            effectiveThreshold = Math.max(threshold, 0.92);  // 92%+ for short queries  
        } else if (wordCount <= 8) {
            effectiveThreshold = Math.max(threshold, 0.90);  // 90%+ for medium queries
        } else {
            effectiveThreshold = Math.max(threshold, 0.88);  // 88%+ for longer queries
        }
        
        // Skip FAQ matching for single-word queries entirely
        if (wordCount <= 1) {
            console.log(`[FAQService] Skipping FAQ match for single-word query: "${userQuery}"`);
            return null;
        }

        try {
            // Generate embedding for user query
            const queryEmbedding = await aiService.generateEmbedding(searchQuery, true);
            if (!queryEmbedding || queryEmbedding.length === 0) return null;

            // Load FAQ embeddings
            const faqEmbeddings = await this._loadFAQEmbeddings();
            if (faqEmbeddings.length === 0) return null;

            // Find best match using cosine similarity
            let bestMatch = null;
            let bestScore = 0;

            for (const faq of faqEmbeddings) {
                const score = this._cosineSimilarity(queryEmbedding, faq.embedding);
                if (score > bestScore && score >= effectiveThreshold) {
                    bestScore = score;
                    bestMatch = faq;
                }
            }

            if (!bestMatch) {
                console.log(`[FAQService] No FAQ match above threshold ${(effectiveThreshold * 100).toFixed(0)}% for: "${searchQuery.substring(0, 50)}..." (${wordCount} words, intent=${courseIntent.mode})`);
                return null;
            }

            // Get full Q&A details
            const fullQA = await CachedQA.findById(bestMatch.id);
            if (!fullQA) return null;
            if (!_cacheMatchAllowed(userQuery, fullQA)) return null;

            const responseTime = Date.now() - startTime;
            
            // Log the match for debugging with full details
            console.log(`[FAQService] FAQ match: "${searchQuery.substring(0, 40)}..." → "${fullQA.question.substring(0, 40)}..." (${(bestScore * 100).toFixed(1)}% ≥ ${(effectiveThreshold * 100).toFixed(0)}% threshold, intent=${courseIntent.mode})`);

            return {
                cachedQA: fullQA,
                similarityScore: bestScore,
                responseTimeMs: responseTime,
                source: 'faq_cache'
            };
        } catch (error) {
            console.error('[FAQService] Error finding similar question:', error.message);
            return null;
        }
    }

    /**
     * Get cached response if available, otherwise return null
     * This is the main entry point for the chat flow
     */
    async getCachedResponse(userQuery, sessionContext = {}) {
        const match = await this.findSimilarQuestion(userQuery);
        
        if (!match) return null;

        // Record usage
        await CachedQA.recordUsage(match.cachedQA.id);

        // Log cache hit for analytics
        await CachedQA.logCacheHit({
            cachedQaId: match.cachedQA.id,
            userId: sessionContext.userId,
            sessionId: sessionContext.sessionId,
            userQuery: userQuery,
            similarityScore: match.similarityScore,
            responseTimeMs: match.responseTimeMs
        });

        return {
            content: match.cachedQA.answer,
            sources: match.cachedQA.answerSources,
            fromCache: true,
            cacheConfidence: match.similarityScore,
            responseTimeMs: match.responseTimeMs,
            cachedQaId: match.cachedQA.id,
            matchedQuestion: match.cachedQA.question
        };
    }

    /**
     * Chunk document content for phased processing
     * Splits content intelligently at section/paragraph boundaries
     */
    _chunkDocumentContent(content, maxChunkSize = 8000) {
        const chunks = [];
        let remaining = content;
        
        while (remaining.length > 0) {
            if (remaining.length <= maxChunkSize) {
                chunks.push(remaining);
                break;
            }
            
            // Find a good break point (section header, double newline, or sentence end)
            let breakPoint = maxChunkSize;
            
            // Try to break at section headers (common patterns)
            const sectionPatterns = [
                /\n(?:CHAPTER|SECTION|PART|ARTICLE|ANNEXURE)\s+[IVX0-9]+/gi,
                /\n\d+\.\s+[A-Z]/g,
                /\n[A-Z][A-Z\s]+:\s*\n/g
            ];
            
            for (const pattern of sectionPatterns) {
                const matches = [...remaining.substring(maxChunkSize * 0.5, maxChunkSize).matchAll(pattern)];
                if (matches.length > 0) {
                    const lastMatch = matches[matches.length - 1];
                    breakPoint = Math.floor(maxChunkSize * 0.5) + lastMatch.index;
                    break;
                }
            }
            
            // Fallback: break at paragraph or sentence
            if (breakPoint === maxChunkSize) {
                const doubleNewline = remaining.lastIndexOf('\n\n', maxChunkSize);
                if (doubleNewline > maxChunkSize * 0.5) {
                    breakPoint = doubleNewline;
                } else {
                    const period = remaining.lastIndexOf('. ', maxChunkSize);
                    if (period > maxChunkSize * 0.5) {
                        breakPoint = period + 1;
                    }
                }
            }
            
            chunks.push(remaining.substring(0, breakPoint).trim());
            remaining = remaining.substring(breakPoint).trim();
        }
        
        return chunks;
    }

    /**
     * Generate Q&A pairs from a single content chunk using a specific phase
     */
    async _generateQAForPhase(phaseName, document, contentChunk, categoryId, jobId) {
        const phase = QA_GENERATION_PHASES[phaseName];
        if (!phase) throw new Error(`Unknown phase: ${phaseName}`);
        
        const prompt = phase.promptTemplate(document.title, document.category, contentChunk);
        
        let aiResponse;
        try {
            if (aiService.useOllamaChat) {
                const axios = require('axios');
                const response = await axios.post(
                    `${aiService.ollamaUrl.replace(/\/$/, '')}/api/generate`,
                    {
                        model: aiService.ollamaChatModel,
                        prompt: prompt,
                        stream: false,
                        format: 'json',
                        options: {
                            temperature: 0.3,
                            num_predict: 4096
                        }
                    },
                    { timeout: 180000 }
                );
                aiResponse = response.data?.response || '';
            } else {
                const axios = require('axios');
                const response = await axios.post(
                    `${aiService.baseUrl}/chat/completions`,
                    {
                        model: aiService.model,
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 4096,
                        temperature: 0.3
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${aiService.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 120000
                    }
                );
                aiResponse = response.data?.choices?.[0]?.message?.content || '';
            }
        } catch (aiError) {
            console.error(`[FAQService] AI call failed for phase ${phaseName}:`, aiError.message);
            return [];
        }
        
        // Parse JSON response
        let qaItems = [];
        try {
            let jsonStr = aiResponse;
            const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1].trim();
            const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
            if (arrayMatch) jsonStr = arrayMatch[0];
            qaItems = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error(`[FAQService] Failed to parse AI response for phase ${phaseName}`);
            return [];
        }
        
        return Array.isArray(qaItems) ? qaItems : [];
    }

    /**
     * Comprehensive phased Q&A generation from a document
     * Generates Q&A in multiple passes for thorough coverage
     */
    async generateQAFromDocument(documentId, options = {}) {
        const settings = await this._loadSettings();
        const userId = options.userId;
        const usePhased = options.phased !== false && settings.faq_phased_generation;
        const maxQuestionsPerPhase = options.maxQuestionsPerPhase || 20;

        // Create generation job
        const jobResult = await query(
            `INSERT INTO qa_generation_jobs (document_id, status, initiated_by, started_at, config)
             VALUES (?, 'processing', ?, NOW(), ?)`,
            [documentId, userId, JSON.stringify({ phased: usePhased, maxQuestionsPerPhase })]
        );
        const jobId = jobResult.insertId;

        try {
            // Get document content
            const document = await Document.findById(documentId);
            if (!document || !document.content_text) {
                throw new Error('Document not found or has no content');
            }

            console.log(`[FAQService] Starting comprehensive Q&A generation for: ${document.title}`);
            console.log(`[FAQService] Document length: ${document.content_text.length} chars, Phased: ${usePhased}`);

            // Determine category
            const categoryMapping = {
                'policy': 'Academic Policies',
                'regulation': 'Academic Policies',
                'academic': 'Academic Policies',
                'administrative': 'Administrative Procedures',
                'legal': 'Administrative Procedures',
                'general': 'General Information'
            };
            
            const categoryName = categoryMapping[document.category] || 'General Information';
            const categories = await FAQCategory.findAll();
            const category = categories.find(c => c.name === categoryName);
            const categoryId = category?.id;

            const allQAItems = [];
            const savedItems = [];
            const phaseResults = {};

            if (usePhased && document.content_text.length > 3000) {
                // PHASED GENERATION for comprehensive coverage
                const contentChunks = this._chunkDocumentContent(document.content_text, settings.faq_chunk_size);
                console.log(`[FAQService] Document split into ${contentChunks.length} chunks`);
                
                const phases = Object.keys(QA_GENERATION_PHASES);
                const totalSteps = phases.length * contentChunks.length;
                let completedSteps = 0;
                
                for (const phaseName of phases) {
                    phaseResults[phaseName] = [];
                    
                    for (let chunkIdx = 0; chunkIdx < contentChunks.length; chunkIdx++) {
                        const chunk = contentChunks[chunkIdx];
                        
                        // Skip very short chunks
                        if (chunk.length < 500) {
                            completedSteps++;
                            continue;
                        }
                        
                        console.log(`[FAQService] Phase ${phaseName}, chunk ${chunkIdx + 1}/${contentChunks.length}`);
                        
                        const phaseQA = await this._generateQAForPhase(phaseName, document, chunk, categoryId, jobId);
                        phaseResults[phaseName].push(...phaseQA);
                        allQAItems.push(...phaseQA.map(qa => ({ ...qa, phase: phaseName })));
                        
                        completedSteps++;
                        const progress = Math.round((completedSteps / totalSteps) * 80); // Reserve 20% for saving
                        
                        await query(
                            'UPDATE qa_generation_jobs SET progress = ?, phase_info = ? WHERE id = ?',
                            [progress, JSON.stringify({ currentPhase: phaseName, chunkIndex: chunkIdx + 1, totalChunks: contentChunks.length }), jobId]
                        );
                        
                        // Small delay between phases to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    
                    console.log(`[FAQService] Phase ${phaseName} complete: ${phaseResults[phaseName].length} Q&A items`);
                }
            } else {
                // SINGLE-PASS GENERATION for shorter documents
                const content = document.content_text.substring(0, 15000);
                
                // Use comprehensive single prompt
                const qaPrompt = this._buildComprehensivePrompt(document.title, document.category, content);
                
                let aiResponse;
                if (aiService.useOllamaChat) {
                    const axios = require('axios');
                    const response = await axios.post(
                        `${aiService.ollamaUrl.replace(/\/$/, '')}/api/generate`,
                        {
                            model: aiService.ollamaChatModel,
                            prompt: qaPrompt,
                            stream: false,
                            format: 'json',
                            options: { temperature: 0.3, num_predict: 8192 }
                        },
                        { timeout: 300000 }
                    );
                    aiResponse = response.data?.response || '';
                } else {
                    const axios = require('axios');
                    const response = await axios.post(
                        `${aiService.baseUrl}/chat/completions`,
                        {
                            model: aiService.model,
                            messages: [{ role: 'user', content: qaPrompt }],
                            max_tokens: 8192,
                            temperature: 0.3
                        },
                        {
                            headers: { 'Authorization': `Bearer ${aiService.apiKey}`, 'Content-Type': 'application/json' },
                            timeout: 180000
                        }
                    );
                    aiResponse = response.data?.choices?.[0]?.message?.content || '';
                }
                
                try {
                    let jsonStr = aiResponse;
                    const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
                    if (jsonMatch) jsonStr = jsonMatch[1].trim();
                    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
                    if (arrayMatch) jsonStr = arrayMatch[0];
                    allQAItems.push(...JSON.parse(jsonStr));
                } catch (parseError) {
                    throw new Error('Failed to parse AI-generated Q&A');
                }
            }

            // Deduplicate Q&A items
            const uniqueQA = this._deduplicateQA(allQAItems);
            console.log(`[FAQService] Generated ${allQAItems.length} total, ${uniqueQA.length} unique Q&A items`);

            // Save all Q&A items with embeddings
            await query('UPDATE qa_generation_jobs SET progress = 80 WHERE id = ?', [jobId]);
            
            for (let i = 0; i < uniqueQA.length; i++) {
                const item = uniqueQA[i];
                try {
                    const embedding = await aiService.generateEmbedding(item.question, false);
                    
                    const qaId = await CachedQA.create({
                        documentId,
                        categoryId,
                        question: item.question,
                        questionVariations: item.variations || [],
                        answer: item.answer,
                        answerSources: item.sources || [document.title],
                        embedding,
                        confidenceScore: 0.85,
                        createdBy: userId,
                        qaType: item.type || 'general'
                    });
                    
                    savedItems.push({ id: qaId, question: item.question, type: item.type });
                    
                    // Update progress (80-100%)
                    const saveProgress = 80 + Math.round((i / uniqueQA.length) * 20);
                    if (i % 10 === 0) {
                        await query('UPDATE qa_generation_jobs SET progress = ?, questions_generated = ? WHERE id = ?',
                            [saveProgress, savedItems.length, jobId]);
                    }
                } catch (itemError) {
                    console.error(`[FAQService] Failed to save Q&A item ${i}: ${itemError.message}`);
                }
            }

            // Mark job as completed
            await query(
                `UPDATE qa_generation_jobs SET status = 'completed', completed_at = NOW(), 
                 questions_generated = ?, progress = 100, phase_info = ? WHERE id = ?`,
                [savedItems.length, JSON.stringify(phaseResults), jobId]
            );

            // Invalidate embeddings cache
            this.invalidateEmbeddingsCache();

            console.log(`[FAQService] Completed: ${savedItems.length} Q&A pairs saved for: ${document.title}`);

            return {
                success: true,
                jobId,
                documentId,
                questionsGenerated: savedItems.length,
                phaseBreakdown: Object.fromEntries(
                    Object.entries(phaseResults).map(([k, v]) => [k, v.length])
                ),
                items: savedItems
            };

        } catch (error) {
            console.error('[FAQService] Q&A generation failed:', error.message);
            
            await query(
                'UPDATE qa_generation_jobs SET status = \'failed\', error_message = ? WHERE id = ?',
                [error.message, jobId]
            );

            return {
                success: false,
                jobId,
                documentId,
                error: error.message
            };
        }
    }

    /**
     * Get generation job status
     */
    async getJobStatus(jobId) {
        const rows = await query(
            `SELECT qj.*, d.title as document_title
             FROM qa_generation_jobs qj
             LEFT JOIN documents d ON d.id = qj.document_id
             WHERE qj.id = ?`,
            [jobId]
        );
        return rows[0] || null;
    }

    /**
     * Get all generation jobs
     */
    async getJobs(options = {}) {
        const { status, documentId, limit = 20 } = options;
        
        let sql = `
            SELECT qj.*, d.title as document_title, u.email as initiated_by_email
            FROM qa_generation_jobs qj
            LEFT JOIN documents d ON d.id = qj.document_id
            LEFT JOIN users u ON u.id = qj.initiated_by
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            sql += ' AND qj.status = ?';
            params.push(status);
        }
        if (documentId) {
            sql += ' AND qj.document_id = ?';
            params.push(documentId);
        }

        sql += ' ORDER BY qj.created_at DESC LIMIT ?';
        params.push(limit);

        return await query(sql, params);
    }

    /**
     * Manually add a Q&A pair (admin function)
     */
    async addManualQA({ question, answer, categoryId, documentId, variations, sources, userId }) {
        // Generate embedding
        const embedding = await aiService.generateEmbedding(question, false);

        const qaId = await CachedQA.create({
            documentId,
            categoryId,
            question,
            questionVariations: variations || [],
            answer,
            answerSources: sources || [],
            embedding,
            confidenceScore: 1.0, // Manual = high confidence
            createdBy: userId
        });

        // Invalidate cache
        this.invalidateEmbeddingsCache();

        return qaId;
    }

    /**
     * Build comprehensive single-pass prompt for shorter documents
     */
    _buildComprehensivePrompt(title, category, content) {
        return `You are an expert FAQ generator for Bayelsa Medical University documents.
Transform this document into a comprehensive Q&A knowledge base.

DOCUMENT: "${title}" (Category: ${category})

CONTENT:
${content}

Generate 50-80 diverse Q&A pairs covering:

1. DEFINITIONAL (10-15 questions):
   - "What is the definition of [term]?"
   - "Who is considered a [category]?"
   - "What does [acronym] stand for?"

2. PROCEDURAL (15-20 questions):
   - "How do I apply for [X]?"
   - "What is the process for [X]?"
   - "What documents are required for [X]?"
   - "Who approves [X]?"

3. QUANTITATIVE (10-15 questions):
   - "How many days of [X] are allowed?"
   - "What is the deadline for [X]?"
   - "What percentage/amount for [X]?"

4. ELIGIBILITY (10-15 questions):
   - "Who is eligible for [X]?"
   - "What qualifications are required for [X]?"
   - "Can [category of person] apply for [X]?"

5. SCENARIO-BASED (10-15 questions):
   - "What happens if [condition]?"
   - "What is the difference between [A] and [B]?"
   - "If I am [status], can I [action]?"

RULES:
- Questions must use natural language as users would ask
- Answers must be extractive (from document text)
- Include 2-3 question variations per item
- End each answer with section reference in parentheses
- Cover ALL substantive parts of the document

OUTPUT FORMAT (JSON array only, no other text):
[{"question":"...","variations":["..."],"answer":"...","sources":["Section X"],"type":"definitional|procedural|quantitative|eligibility|scenario"}]`;
    }

    /**
     * Deduplicate Q&A items based on question similarity
     */
    _deduplicateQA(qaItems) {
        const seen = new Map();
        const unique = [];
        
        for (const item of qaItems) {
            if (!item.question || !item.answer) continue;
            
            // Normalize question for comparison
            const normalized = item.question
                .toLowerCase()
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            
            // Check for similar questions (simple word overlap)
            let isDuplicate = false;
            for (const [existingNorm, existingIdx] of seen.entries()) {
                const similarity = this._calculateWordOverlap(normalized, existingNorm);
                if (similarity > 0.8) {
                    // Merge variations if duplicate
                    const existing = unique[existingIdx];
                    if (item.variations) {
                        existing.variations = [...new Set([
                            ...(existing.variations || []),
                            item.question,
                            ...item.variations
                        ])];
                    }
                    isDuplicate = true;
                    break;
                }
            }
            
            if (!isDuplicate) {
                seen.set(normalized, unique.length);
                unique.push(item);
            }
        }
        
        return unique;
    }

    /**
     * Calculate word overlap between two strings (Jaccard similarity)
     */
    _calculateWordOverlap(str1, str2) {
        const words1 = new Set(str1.split(' ').filter(w => w.length > 2));
        const words2 = new Set(str2.split(' ').filter(w => w.length > 2));
        
        if (words1.size === 0 || words2.size === 0) return 0;
        
        const intersection = [...words1].filter(w => words2.has(w)).length;
        const union = new Set([...words1, ...words2]).size;
        
        return intersection / union;
    }

    /**
     * Automatically generate FAQ after document processing
     * Called by documentProcessor after successful processing
     */
    async autoGenerateForDocument(documentId, userId = null) {
        const settings = await this._loadSettings();
        
        if (!settings.faq_auto_generate) {
            console.log(`[FAQService] Auto-generation disabled, skipping document ${documentId}`);
            return null;
        }
        
        // Check if FAQs already exist for this document
        const existingQA = await CachedQA.findByDocument(documentId);
        if (existingQA && existingQA.length > 20) {
            console.log(`[FAQService] Document ${documentId} already has ${existingQA.length} Q&A pairs, skipping`);
            return { skipped: true, existingCount: existingQA.length };
        }
        
        console.log(`[FAQService] Auto-generating FAQ for document ${documentId}`);
        
        // Queue for background processing
        return this.generateQAFromDocument(documentId, { 
            userId, 
            phased: settings.faq_phased_generation 
        });
    }

    /**
     * Regenerate FAQ for a document (replaces existing)
     */
    async regenerateForDocument(documentId, userId = null) {
        // Delete existing Q&A for this document
        await query('DELETE FROM cached_qa WHERE document_id = ?', [documentId]);
        
        console.log(`[FAQService] Cleared existing FAQ for document ${documentId}, regenerating...`);
        
        // Generate fresh
        return this.generateQAFromDocument(documentId, { userId, phased: true });
    }

    /**
     * Regenerate a single FAQ answer using AI
     * @param {number} faqId - The FAQ ID
     * @param {string} question - The question to answer
     * @param {string} currentAnswer - The current answer (for context)
     * @returns {Object} - { success, answer, sources, error }
     */
    async regenerateFAQAnswer(faqId, question, currentAnswer = '') {
        try {
            console.log(`[FAQService] Regenerating answer for FAQ ${faqId}: "${question.substring(0, 50)}..."`);

            // Search for relevant documents/context
            const searchResult = await aiService.searchRelevantDocuments(question, 6);
            const { context: docContext, documents: relevantDocs, hasRelevantContent } = searchResult;

            // Build the prompt for answer generation
            let prompt = `You are an expert FAQ answer writer for Bayelsa Medical University (BMU).

TASK: Generate a comprehensive, accurate answer for the following question.

QUESTION: ${question}
`;

            if (currentAnswer) {
                prompt += `
CURRENT ANSWER (for reference - improve upon this):
${currentAnswer}
`;
            }

            if (hasRelevantContent && docContext) {
                prompt += `
RELEVANT DOCUMENT EXCERPTS:
${docContext}
`;
            }

            prompt += `
INSTRUCTIONS:
1. Write a clear, professional answer that directly addresses the question
2. If document excerpts are provided, base your answer on that information
3. Include specific details like numbers, dates, requirements where available
4. Use bullet points or numbered lists for clarity when appropriate
5. Keep the answer concise but comprehensive (2-4 paragraphs typically)
6. If citing from documents, mention the source naturally (e.g., "According to the Staff Conditions of Service...")
7. Do NOT include phrases like "Based on the provided documents" - just give the answer directly

ANSWER:`;

            // Call DeepSeek API directly for answer generation
            const axios = require('axios');
            const response = await axios.post(
                'https://api.deepseek.com/v1/chat/completions',
                {
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'user', content: prompt }
                    ],
                    max_tokens: 1500,
                    temperature: 0.5, // Lower temperature for more factual responses
                    top_p: 0.9
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );

            const generatedAnswer = response.data.choices[0].message.content.trim();

            // Extract source document titles
            const sources = relevantDocs.map(doc => doc.title || doc.documentTitle).filter(Boolean);

            console.log(`[FAQService] Successfully regenerated answer for FAQ ${faqId} (${generatedAnswer.length} chars)`);

            return {
                success: true,
                answer: generatedAnswer,
                sources: [...new Set(sources)] // Unique sources
            };

        } catch (error) {
            console.error(`[FAQService] Error regenerating answer for FAQ ${faqId}:`, error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message
            };
        }
    }

    /**
     * Get FAQ coverage statistics for all documents
     */
    async getDocumentCoverage() {
        const rows = await query(`
            SELECT 
                d.id,
                d.title,
                d.category,
                d.embedding_status,
                COUNT(cq.id) as qa_count,
                MAX(cq.created_at) as last_qa_generated
            FROM documents d
            LEFT JOIN cached_qa cq ON cq.document_id = d.id AND cq.is_active = TRUE
            WHERE d.is_active = TRUE
            GROUP BY d.id
            ORDER BY qa_count DESC, d.title ASC
        `);
        
        return rows.map(r => ({
            ...r,
            hasFAQ: r.qa_count > 0,
            coverageLevel: r.qa_count >= 50 ? 'comprehensive' : 
                           r.qa_count >= 20 ? 'moderate' : 
                           r.qa_count > 0 ? 'minimal' : 'none'
        }));
    }

    /**
     * Update embedding for an existing Q&A (if question changed)
     */
    async updateEmbedding(qaId) {
        const qa = await CachedQA.findById(qaId);
        if (!qa) throw new Error('Q&A not found');

        const embedding = await aiService.generateEmbedding(qa.question, false);
        
        await query(
            'UPDATE cached_qa SET embedding = ? WHERE id = ?',
            [JSON.stringify(embedding), qaId]
        );

        this.invalidateEmbeddingsCache();
        return true;
    }

    /**
     * Get FAQ statistics
     */
    async getStats() {
        const [totals] = await query(`
            SELECT 
                COUNT(*) as total_qa,
                SUM(CASE WHEN is_verified THEN 1 ELSE 0 END) as verified_qa,
                SUM(CASE WHEN NOT is_verified THEN 1 ELSE 0 END) as unverified_qa,
                SUM(usage_count) as total_usage,
                COUNT(DISTINCT document_id) as documents_covered
            FROM cached_qa
            WHERE is_active = TRUE
        `);

        const cacheAnalytics = await CachedQA.getCacheAnalytics(30);
        const categoryStats = await FAQCategory.getStats();
        const documentCoverage = await this.getDocumentCoverage();

        return {
            totalFaqs: parseInt(totals.total_qa) || 0,
            verifiedFaqs: parseInt(totals.verified_qa) || 0,
            unverifiedFaqs: parseInt(totals.unverified_qa) || 0,
            totalUsage: parseInt(totals.total_usage) || 0,
            documentsWithFaqs: parseInt(totals.documents_covered) || 0,
            totals,
            cacheAnalytics,
            categoryStats,
            documentCoverage
        };
    }

    // ============================================================
    // BATCHED FAQ GENERATION - Admin-controlled phase-by-phase
    // ============================================================

    /**
     * Analyze document and prepare batches for FAQ generation
     * Returns batch plan without generating anything
     */
    async prepareBatchGeneration(documentId) {
        const document = await Document.findById(documentId);
        if (!document || !document.content_text) {
            throw new Error('Document not found or has no content');
        }

        const settings = await this._loadSettings();
        const contentLength = document.content_text.length;
        
        // Chunk the document
        const chunks = this._chunkDocumentContent(document.content_text, settings.faq_chunk_size);
        
        // Get available phases
        const phases = Object.keys(QA_GENERATION_PHASES);
        
        // Create batch plan
        const batches = [];
        let batchNum = 1;
        
        for (const phaseName of phases) {
            const phase = QA_GENERATION_PHASES[phaseName];
            for (let i = 0; i < chunks.length; i++) {
                if (chunks[i].length >= 500) { // Skip very short chunks
                    batches.push({
                        batchNumber: batchNum++,
                        phase: phaseName,
                        phaseName: phase.name,
                        chunkIndex: i,
                        chunkPreview: chunks[i].substring(0, 200) + '...',
                        chunkLength: chunks[i].length,
                        targetQuestions: Math.ceil(phase.targetCount / chunks.length),
                        status: 'pending'
                    });
                }
            }
        }

        // Check existing FAQ count
        const existingFAQs = await CachedQA.findByDocument(documentId);

        return {
            documentId,
            documentTitle: document.title,
            contentLength,
            totalChunks: chunks.length,
            totalBatches: batches.length,
            phases: phases.map(p => ({
                name: p,
                focus: QA_GENERATION_PHASES[p].focus,
                targetCount: QA_GENERATION_PHASES[p].targetCount
            })),
            existingFAQCount: existingFAQs.length,
            estimatedTotalQuestions: phases.reduce((sum, p) => sum + QA_GENERATION_PHASES[p].targetCount, 0),
            batches
        };
    }

    /**
     * Generate FAQ for a single batch (one phase + one chunk)
     * Allows admin to control generation step by step
     */
    async generateSingleBatch(documentId, phaseName, chunkIndex, userId = null) {
        const document = await Document.findById(documentId);
        if (!document || !document.content_text) {
            throw new Error('Document not found or has no content');
        }

        const phase = QA_GENERATION_PHASES[phaseName.toUpperCase()];
        if (!phase) {
            throw new Error(`Invalid phase: ${phaseName}. Valid phases: ${Object.keys(QA_GENERATION_PHASES).join(', ')}`);
        }

        const settings = await this._loadSettings();
        const chunks = this._chunkDocumentContent(document.content_text, settings.faq_chunk_size);
        
        if (chunkIndex < 0 || chunkIndex >= chunks.length) {
            throw new Error(`Invalid chunk index: ${chunkIndex}. Document has ${chunks.length} chunks.`);
        }

        const chunk = chunks[chunkIndex];
        if (chunk.length < 500) {
            return {
                success: true,
                skipped: true,
                reason: 'Chunk too short (< 500 chars)',
                questionsGenerated: 0
            };
        }

        console.log(`[FAQService] Generating batch: ${phaseName} chunk ${chunkIndex + 1}/${chunks.length} for "${document.title}"`);

        // Determine category
        const categoryMapping = {
            'policy': 'Academic Policies',
            'regulation': 'Academic Policies',
            'academic': 'Academic Policies',
            'administrative': 'Administrative Procedures',
            'legal': 'Administrative Procedures',
            'general': 'General Information'
        };
        const categoryName = categoryMapping[document.category] || 'General Information';
        const categories = await FAQCategory.findAll();
        const category = categories.find(c => c.name === categoryName);
        const categoryId = category?.id;

        // Generate Q&A for this batch
        const qaItems = await this._generateQAForPhase(phaseName.toUpperCase(), document, chunk, categoryId, null);
        
        if (qaItems.length === 0) {
            return {
                success: true,
                questionsGenerated: 0,
                message: 'No Q&A pairs generated for this batch'
            };
        }

        // Deduplicate against existing FAQs
        const existingFAQs = await CachedQA.findByDocument(documentId);
        const existingQuestions = new Set(existingFAQs.map(f => 
            f.question.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
        ));

        const newItems = qaItems.filter(item => {
            const normalized = item.question.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
            return !existingQuestions.has(normalized);
        });

        // Save new Q&A items
        const savedItems = [];
        for (const item of newItems) {
            try {
                const embedding = await aiService.generateEmbedding(item.question, false);
                
                const qaId = await CachedQA.create({
                    documentId,
                    categoryId,
                    question: item.question,
                    questionVariations: item.variations || [],
                    answer: item.answer,
                    answerSources: item.sources || [document.title],
                    embedding,
                    confidenceScore: 0.85,
                    createdBy: userId,
                    qaType: item.type || phase.name
                });
                
                savedItems.push({ id: qaId, question: item.question, type: item.type });
            } catch (err) {
                console.error(`[FAQService] Failed to save Q&A: ${err.message}`);
            }
        }

        // Invalidate cache
        this.invalidateEmbeddingsCache();

        console.log(`[FAQService] Batch complete: ${savedItems.length} new Q&A pairs saved`);

        return {
            success: true,
            phase: phaseName,
            chunkIndex,
            totalChunks: chunks.length,
            questionsGenerated: savedItems.length,
            duplicatesSkipped: qaItems.length - newItems.length,
            items: savedItems,
            nextBatch: chunkIndex + 1 < chunks.length 
                ? { phase: phaseName, chunkIndex: chunkIndex + 1 }
                : null
        };
    }

    /**
     * Generate FAQ for an entire phase (all chunks)
     */
    async generatePhase(documentId, phaseName, userId = null) {
        const document = await Document.findById(documentId);
        if (!document || !document.content_text) {
            throw new Error('Document not found or has no content');
        }

        const settings = await this._loadSettings();
        const chunks = this._chunkDocumentContent(document.content_text, settings.faq_chunk_size);
        
        const results = {
            phase: phaseName,
            documentId,
            documentTitle: document.title,
            totalChunks: chunks.length,
            processedChunks: 0,
            questionsGenerated: 0,
            duplicatesSkipped: 0,
            errors: 0,
            items: []
        };

        for (let i = 0; i < chunks.length; i++) {
            try {
                const batchResult = await this.generateSingleBatch(documentId, phaseName, i, userId);
                results.processedChunks++;
                results.questionsGenerated += batchResult.questionsGenerated || 0;
                results.duplicatesSkipped += batchResult.duplicatesSkipped || 0;
                if (batchResult.items) {
                    results.items.push(...batchResult.items);
                }
            } catch (err) {
                console.error(`[FAQService] Error in phase ${phaseName} chunk ${i}: ${err.message}`);
                results.errors++;
            }
        }

        return results;
    }

    /**
     * Get available phases for FAQ generation
     */
    getAvailablePhases() {
        return Object.entries(QA_GENERATION_PHASES).map(([key, phase]) => ({
            key,
            name: phase.name,
            focus: phase.focus,
            targetCount: phase.targetCount
        }));
    }
}

// Export singleton instance
module.exports = new FAQService();
