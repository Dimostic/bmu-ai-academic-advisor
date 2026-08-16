/**
 * Enhanced Retrieval Service using LangChain
 * 
 * This service provides:
 * 1. Hybrid search (semantic + keyword)
 * 2. Query expansion and rewriting (via LangChain)
 * 3. Intelligent re-ranking
 * 4. Context compression
 * 5. Caching at multiple levels
 * 6. LangChain text splitting and embeddings
 * 
 * Architecture:
 * User Query → Query Processor → Hybrid Search → Re-ranker → Context Compressor → Response
 */

const { query } = require('../../config/db');
const vectorStore = require('./vectorStore');
const faqService = require('./faqService');

// Lazy-load aiService to avoid circular dependency
let _aiService = null;
function getAIService() {
    if (!_aiService) {
        _aiService = require('./aiService');
    }
    return _aiService;
}

// Lazy-load LangChain service
let _langchainService = null;
const USE_LANGCHAIN = process.env.USE_LANGCHAIN !== 'false'; // Default: enabled
function getLangChainService() {
    if (!_langchainService && USE_LANGCHAIN) {
        try {
            _langchainService = require('./langchainService');
            console.log('[RetrievalService] LangChain service loaded');
        } catch (e) {
            console.warn('[RetrievalService] LangChain not available:', e.message);
        }
    }
    return _langchainService;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

class RetrievalService {
    constructor() {
        // Configuration
        this.config = {
            // Retrieval settings - increased topK and lowered threshold for better recall
            topK: parseInt(process.env.RETRIEVAL_TOP_K) || 15,
            reRankTopK: parseInt(process.env.RERANK_TOP_K) || 7,
            minRelevanceScore: parseFloat(process.env.MIN_RELEVANCE_SCORE) || 0.2, // Lowered from 0.3
            
            // Hybrid search weights — give semantic full weight so high-cosine
            // matches compete with the bounded title/exact-phrase boosts.
            // Title match contributes via the boost ladder above, not via
            // per-chunk weight.
            semanticWeight: parseFloat(process.env.SEMANTIC_WEIGHT) || 1.0,
            keywordWeight: parseFloat(process.env.KEYWORD_WEIGHT) || 0.5,
            
            // Caching
            queryCacheTTL: 5 * 60 * 1000, // 5 minutes
            contextCacheTTL: 10 * 60 * 1000, // 10 minutes
            
            // Context compression - increased for more context
            maxContextLength: parseInt(process.env.MAX_CONTEXT_LENGTH) || 6000,
            chunkOverlapRatio: 0.1,
            
            // Query processing
            enableQueryExpansion: process.env.ENABLE_QUERY_EXPANSION !== 'false',
            enableHybridSearch: process.env.ENABLE_HYBRID_SEARCH !== 'false',
            enableReRanking: process.env.ENABLE_RERANKING !== 'false',
            enableCanonicalRewrite: process.env.ADVISOR_PHASE3_CANONICAL_REWRITE !== 'false',
            enableSourceRankingPolicy: process.env.ADVISOR_PHASE3_SOURCE_POLICY !== 'false',

            // Primary-source boost — the Students' Handbook is the canonical
            // BMU knowledge base; other documents merely expand on it. Any
            // chunk whose document title matches `primarySourcePattern`
            // (case-insensitive substring) has its final score multiplied by
            // `primarySourceBoost`, so when the handbook is relevant at all
            // it surfaces ahead of more specialised documents.
            primarySourcePattern: (process.env.ADVISOR_PRIMARY_SOURCE_PATTERN || 'quick facts').toLowerCase(),
            primarySourceBoost:   parseFloat(process.env.ADVISOR_PRIMARY_SOURCE_BOOST || '1.20'),

            // Programme-policy boosts: CCMAS documents are authoritative for
            // progression / graduation / withdrawal criteria in specific
            // programmes and should outrank generic handbook summaries.
            ccmasPattern: (process.env.ADVISOR_CCMAS_PATTERN || 'ccmas').toLowerCase(),
            ccmasBoost: parseFloat(process.env.ADVISOR_CCMAS_BOOST || '1.35'),
            alliedHealthPattern: (process.env.ADVISOR_ALLIED_HEALTH_PATTERN || 'allied health sciences').toLowerCase(),
            alliedHealthBoost: parseFloat(process.env.ADVISOR_ALLIED_HEALTH_BOOST || '1.45'),

            // Admin and evidence ranking. Admin authority is a human-curated
            // source-quality signal; cross-source occurrence is a confidence
            // signal when the current query retrieves relevant chunks from
            // multiple independent documents.
            enableAdminAuthorityRanking: process.env.ADVISOR_AUTHORITY_RANKING !== 'false',
            authorityRankingStrength: parseFloat(process.env.ADVISOR_AUTHORITY_RANKING_STRENGTH || '0.24'),
            enableCrossSourceOccurrenceRanking: process.env.ADVISOR_OCCURRENCE_RANKING !== 'false',
            crossSourceOccurrenceMinSources: parseInt(process.env.ADVISOR_OCCURRENCE_MIN_SOURCES || '3', 10),
            crossSourceOccurrenceMaxBoost: parseFloat(process.env.ADVISOR_OCCURRENCE_MAX_BOOST || '0.18'),
            enableStructuredFactLookup: process.env.ADVISOR_STRUCTURED_FACT_LOOKUP !== 'false',
            enableNormalizedAcademicLookup: process.env.ADVISOR_NORMALIZED_ACADEMIC_LOOKUP !== 'false',
            enableHighRiskFactPolicy: process.env.ADVISOR_HIGH_RISK_FACT_POLICY !== 'false'
        };
        
        // Multi-level caches
        this._queryCache = new Map(); // Query → embedding
        this._contextCache = new Map(); // Query hash → retrieved context
        this._documentCache = new Map(); // Document ID → metadata
        
        // Performance metrics
        this._metrics = {
            totalQueries: 0,
            cacheHits: 0,
            avgRetrievalTime: 0,
            avgReRankTime: 0
        };
        
        console.log('[RetrievalService] Initialized with config:', {
            topK: this.config.topK,
            semanticWeight: this.config.semanticWeight,
            keywordWeight: this.config.keywordWeight,
            enableHybridSearch: this.config.enableHybridSearch
        });
    }

    /**
     * Main retrieval pipeline
     * Combines semantic search, keyword search, FAQ matching, and re-ranking
     */
    async retrieve(userQuery, options = {}) {
        const startTime = Date.now();
        this._metrics.totalQueries++;
        
        const {
            sessionContext = {},
            limit = this.config.reRankTopK,
            includeMetadata = true,
            skipCache = false,
            documentIds = null // Optional: filter to specific document IDs
        } = options;
        
        try {
            // 1. Check context cache (skip if document filter is specified)
            const cacheKey = this._generateCacheKey(userQuery, options);
            if (!skipCache && !documentIds) {
                const cached = this._getFromCache(cacheKey, 'context');
                if (cached) {
                    this._metrics.cacheHits++;
                    return { ...cached, fromCache: true, retrievalTimeMs: Date.now() - startTime };
                }
            }
            
            // 2. Process query (expand, normalize)
            const processedQuery = await this._processQuery(userQuery, sessionContext);
            const structuredFacts = this.config.enableStructuredFactLookup
                ? await this._lookupStructuredFacts(processedQuery)
                : [];
            const structuredTables = this.config.enableStructuredFactLookup
                ? await this._lookupStructuredTables(processedQuery)
                : [];
            const normalizedAcademicRecords = this.config.enableNormalizedAcademicLookup
                ? await this._lookupNormalizedAcademicRecords(processedQuery)
                : [];
            const highRiskPolicy = this.config.enableHighRiskFactPolicy
                ? this._buildHighRiskFactPolicy(processedQuery, structuredFacts, structuredTables, normalizedAcademicRecords)
                : null;
            
            // 3. FAQ check REMOVED - FAQ is now a separate feature
            // Chat uses pure RAG for accurate, document-based responses
            
            // 4. Hybrid search (semantic + keyword), with optional document filter
            let searchResults = await this._hybridSearch(processedQuery, this.config.topK, documentIds);
            
            // 5. Re-rank results
            const reRankedResults = this.config.enableReRanking
                ? await this._reRankResults(processedQuery.normalized, searchResults)
                : searchResults;

            const policyBoosted = this._applyProgrammePolicyBoost(reRankedResults, processedQuery);
            const sourceRanked = this.config.enableSourceRankingPolicy
                ? this._applySourceRankingPolicy(policyBoosted, processedQuery)
                : policyBoosted;
            const authorityRanked = this.config.enableAdminAuthorityRanking
                ? this._applyAdminAuthorityRanking(sourceRanked)
                : sourceRanked;
            const occurrenceRanked = this.config.enableCrossSourceOccurrenceRanking
                ? this._applyCrossSourceOccurrenceRanking(authorityRanked)
                : authorityRanked;

            // 5b. Re-apply primary-source boost after re-ranking. The
            // re-ranker rebuilds `score` from scratch (only ~40% of it comes
            // from the original boosted score), so without this step the
            // handbook would lose its lead to other documents with strong
            // term coverage. We re-sort afterwards so the boosted order is
            // what feeds the context compressor.
            const boosted = this._applyPrimarySourceBoost(occurrenceRanked, processedQuery)
                .sort((a, b) => b.score - a.score);

            // 6. Select top results and compress context
            const topResults = boosted.slice(0, limit);
            const compressedContext = await this._compressContext(topResults, processedQuery.normalized);
            const normalizedAcademicContext = this._formatNormalizedAcademicContext(normalizedAcademicRecords);
            const structuredContext = this._formatStructuredFactsContext(structuredFacts);
            const tableContext = this._formatStructuredTablesContext(structuredTables);
            const policyContext = highRiskPolicy?.context || '';
            
            // 7. Build final result
            const result = {
                type: 'document_retrieval',
                context: [policyContext, normalizedAcademicContext, structuredContext, tableContext, compressedContext.text].filter(Boolean).join('\n\n---\n\n'),
                chunks: topResults.map(r => ({
                    content: r.content,
                    documentId: r.documentId,
                    documentTitle: r.documentTitle,
                    authorityRank: r.authorityRank,
                    authorityLabel: r.authorityLabel,
                    sourceOccurrenceDocs: r.sourceOccurrenceDocs,
                    score: r.score,
                    chunkIndex: r.chunkIndex
                })),
                sources: this._extractSources(topResults),
                confidence: topResults.length > 0 ? topResults[0].score : 0,
                retrievalTimeMs: Date.now() - startTime,
                metadata: includeMetadata ? {
                    queryExpanded: processedQuery.expanded,
                    canonicalQuery: processedQuery.canonicalQuery || processedQuery.normalized,
                    totalCandidates: searchResults.length,
                    reRanked: this.config.enableReRanking,
                    phase: 'phase3',
                    sourcePolicy: processedQuery.sourcePolicy || 'default',
                    normalizedAcademicRecords: normalizedAcademicRecords.length,
                    structuredFacts: structuredFacts.length,
                    structuredTables: structuredTables.length,
                    highRiskPolicy
                } : undefined
            };
            
            // Cache result
            this._setCache(cacheKey, result, 'context');
            
            // Update metrics
            this._updateMetrics('retrieval', Date.now() - startTime);
            
            return result;
            
        } catch (error) {
            console.error('[RetrievalService] Retrieval error:', error);
            return {
                type: 'error',
                context: '',
                chunks: [],
                sources: [],
                confidence: 0,
                error: error.message,
                retrievalTimeMs: Date.now() - startTime
            };
        }
    }

    async _lookupStructuredFacts(processedQuery, limit = 8) {
        try {
            const q = String(processedQuery?.canonicalQuery || processedQuery?.normalized || '').toLowerCase();
            const terms = q
                .replace(/[^a-z0-9\s-]/g, ' ')
                .split(/\s+/)
                .filter(term => term.length > 2 && !['what', 'who', 'how', 'many', 'much', 'about', 'tell', 'does', 'are', 'the', 'for'].includes(term))
                .slice(0, 8);
            if (!terms.length) return [];

            const factMatchExpr = "(LOWER(COALESCE(subject, '')) LIKE ? OR LOWER(COALESCE(human_text, '')) LIKE ? OR LOWER(COALESCE(source_path, '')) LIKE ?)";
            const likeConditions = terms.map(() => factMatchExpr).join(' OR ');
            const params = [];
            for (const term of terms) {
                const like = `%${term}%`;
                params.push(like, like, like);
            }
            const scoreExpr = terms.map(() => factMatchExpr).join(' + ');
            const scoreParams = [];
            for (const term of terms) {
                const like = `%${term}%`;
                scoreParams.push(like, like, like);
            }

            const rows = await query(`
                SELECT id, fact_type, subject, predicate_name, value_json, human_text,
                       authority_type, scope_label, source_path, authority_rank,
                       (${scoreExpr}) AS match_count
                FROM structured_facts
                WHERE status = 'active'
                  AND (${likeConditions})
                ORDER BY match_count DESC, authority_rank DESC, updated_at DESC
                LIMIT ?
            `, [...scoreParams, ...params, limit]);

            return (rows || []).filter(row => Number(row.match_count || 0) > 0).map(row => ({
                id: row.id,
                factType: row.fact_type,
                subject: row.subject,
                predicate: row.predicate_name,
                value: (() => { try { return JSON.parse(row.value_json || '{}'); } catch (_) { return {}; } })(),
                text: row.human_text,
                authorityType: row.authority_type,
                scope: row.scope_label,
                sourcePath: row.source_path,
                authorityRank: row.authority_rank,
                score: Number(row.match_count || 0)
            }));
        } catch (error) {
            if (!/structured_facts/i.test(error.message || '')) {
                console.warn('[RetrievalService] Structured fact lookup skipped:', error.message);
            }
            return [];
        }
    }

    async _lookupStructuredTables(processedQuery, limit = 5) {
        try {
            const q = String(processedQuery?.canonicalQuery || processedQuery?.normalized || '').toLowerCase();
            const terms = q
                .replace(/[^a-z0-9\s-]/g, ' ')
                .split(/\s+/)
                .filter(term => term.length > 2 && !['what', 'who', 'how', 'many', 'much', 'about', 'tell', 'does', 'are', 'the', 'for'].includes(term))
                .slice(0, 8);
            if (!terms.length) return [];

            const tableMatchExpr = "(LOWER(COALESCE(title, '')) LIKE ? OR LOWER(COALESCE(programme, '')) LIKE ? OR LOWER(COALESCE(section_label, '')) LIKE ? OR LOWER(COALESCE(source_path, '')) LIKE ? OR LOWER(COALESCE(markdown, '')) LIKE ?)";
            const likeConditions = terms.map(() => tableMatchExpr).join(' OR ');
            const params = [];
            for (const term of terms) {
                const like = `%${term}%`;
                params.push(like, like, like, like, like);
            }
            const scoreExpr = terms.map(() => tableMatchExpr).join(' + ');
            const scoreParams = [];
            for (const term of terms) {
                const like = `%${term}%`;
                scoreParams.push(like, like, like, like, like);
            }

            const rows = await query(`
                SELECT id, title, table_type, programme, section_label, source_path, markdown,
                       rows_json, metadata_json, authority_rank, (${scoreExpr}) AS match_count
                FROM structured_tables
                WHERE status = 'active'
                  AND (${likeConditions})
                ORDER BY match_count DESC, authority_rank DESC, updated_at DESC
                LIMIT ?
            `, [...scoreParams, ...params, limit]);

            return (rows || []).filter(row => Number(row.match_count || 0) > 0).map(row => ({
                id: row.id,
                title: row.title,
                tableType: row.table_type,
                programme: row.programme,
                section: row.section_label,
                sourcePath: row.source_path,
                markdown: row.markdown,
                rows: (() => { try { return JSON.parse(row.rows_json || '[]'); } catch (_) { return []; } })(),
                metadata: (() => { try { return JSON.parse(row.metadata_json || '{}'); } catch (_) { return {}; } })(),
                authorityRank: row.authority_rank,
                score: Number(row.match_count || 0)
            }));
        } catch (error) {
            if (!/structured_tables/i.test(error.message || '')) {
                console.warn('[RetrievalService] Structured table lookup skipped:', error.message);
            }
            return [];
        }
    }

    async _lookupNormalizedAcademicRecords(processedQuery, limit = 12) {
        const terms = this._queryLookupTerms(processedQuery, 8);
        if (!terms.length) return [];

        const searches = [
            {
                type: 'programme',
                table: 'academic_programmes',
                fields: ['programme', 'faculty', 'department', 'degree', 'entry_mode', 'scope_label', 'source_path', 'raw_text'],
                select: 'id, programme, faculty, department, degree, duration_years, entry_mode, authority_type, scope_label, source_path, raw_text'
            },
            {
                type: 'course',
                table: 'academic_courses',
                fields: ['programme', 'level_label', 'semester_label', 'course_code', 'course_title', 'scope_label', 'source_path', 'raw_text'],
                select: 'id, programme, level_label, semester_label, course_code, course_title, credit_units, authority_type, scope_label, source_path, raw_text'
            },
            {
                type: 'fee',
                table: 'academic_fees',
                fields: ['programme', 'fee_category', 'amount_label', 'session_label', 'student_category', 'scope_label', 'source_path', 'raw_text'],
                select: 'id, programme, fee_category, amount_label, amount_value, session_label, student_category, authority_type, scope_label, source_path, raw_text'
            },
            {
                type: 'calendar',
                table: 'academic_calendar_events',
                fields: ['event_title', 'event_date_label', 'session_label', 'scope_label', 'source_path', 'raw_text'],
                select: 'id, event_title, event_date_label, session_label, authority_type, scope_label, source_path, raw_text'
            },
            {
                type: 'officer',
                table: 'academic_officers',
                fields: ['office', 'officer_name', 'scope_label', 'source_path', 'raw_text'],
                select: 'id, office, officer_name, authority_type, scope_label, source_path, raw_text'
            },
            {
                type: 'rule',
                table: 'academic_rules',
                fields: ['rule_type', 'subject', 'programme', 'scope_label', 'source_path', 'raw_text'],
                select: 'id, rule_type, subject, programme, authority_type, scope_label, source_path, raw_text'
            }
        ];

        const records = [];
        for (const search of searches) {
            try {
                const matchExpr = this._likeMatchExpression(search.fields);
                const likeConditions = terms.map(() => matchExpr).join(' OR ');
                const scoreExpr = terms.map(() => matchExpr).join(' + ');
                const params = [];
                const scoreParams = [];
                for (const term of terms) {
                    const like = `%${term}%`;
                    for (let i = 0; i < search.fields.length; i++) scoreParams.push(like);
                    for (let i = 0; i < search.fields.length; i++) params.push(like);
                }
                const rows = await query(`
                    SELECT ${search.select}, (${scoreExpr}) AS match_count
                    FROM ${search.table}
                    WHERE status = 'active'
                      AND (${likeConditions})
                    ORDER BY match_count DESC, updated_at DESC
                    LIMIT ?
                `, [...scoreParams, ...params, Math.max(2, Math.ceil(limit / 2))]);

                for (const row of rows || []) {
                    if (Number(row.match_count || 0) <= 0) continue;
                    records.push({
                        type: search.type,
                        id: row.id,
                        score: Number(row.match_count || 0),
                        authorityType: row.authority_type,
                        scope: row.scope_label,
                        sourcePath: row.source_path,
                        rawText: row.raw_text,
                        data: row
                    });
                }
            } catch (error) {
                if (!/academic_/i.test(error.message || '')) {
                    console.warn(`[RetrievalService] Normalized ${search.type} lookup skipped:`, error.message);
                }
            }
        }

        return records
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    _queryLookupTerms(processedQuery, limit = 8) {
        const q = String(processedQuery?.canonicalQuery || processedQuery?.normalized || '').toLowerCase();
        return q
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter(term => term.length > 2 && !['what', 'who', 'how', 'many', 'much', 'about', 'tell', 'does', 'are', 'the', 'for', 'can', 'will', 'with'].includes(term))
            .slice(0, limit);
    }

    _likeMatchExpression(fields) {
        return `(${fields.map(field => `LOWER(COALESCE(${field}, '')) LIKE ?`).join(' OR ')})`;
    }

    _formatNormalizedAcademicContext(records) {
        if (!Array.isArray(records) || !records.length) return '';
        const lines = [
            '[Normalized Academic Records - highest priority for exact facts]',
            'Use these records before broad document excerpts for programme duration, courses, fees, calendar dates, officers, and academic rules.'
        ];

        for (const record of records) {
            const data = record.data || {};
            if (record.type === 'programme') {
                lines.push(`- Programme: ${data.programme}${data.duration_years ? ` | Duration: ${data.duration_years} years` : ''}${data.entry_mode ? ` | Entry: ${data.entry_mode}` : ''}${record.scope ? ` [${record.scope}]` : ''}${record.sourcePath ? ` Source path: ${record.sourcePath}` : ''}`);
            } else if (record.type === 'course') {
                lines.push(`- Course: ${data.course_code || 'Uncoded'}${data.course_title ? ` | ${data.course_title}` : ''}${data.credit_units ? ` | Units: ${data.credit_units}` : ''}${data.programme ? ` | Programme: ${data.programme}` : ''}${record.sourcePath ? ` Source path: ${record.sourcePath}` : ''}`);
            } else if (record.type === 'fee') {
                lines.push(`- Fee: ${data.fee_category || 'Fee record'}${data.programme ? ` | Programme: ${data.programme}` : ''}${data.amount_label ? ` | Amount: ${data.amount_label}` : ''}${data.session_label ? ` | Session: ${data.session_label}` : ''}${record.sourcePath ? ` Source path: ${record.sourcePath}` : ''}`);
            } else if (record.type === 'calendar') {
                lines.push(`- Calendar: ${data.event_title}${data.event_date_label ? ` | Date: ${data.event_date_label}` : ''}${data.session_label ? ` | Session: ${data.session_label}` : ''}${record.sourcePath ? ` Source path: ${record.sourcePath}` : ''}`);
            } else if (record.type === 'officer') {
                lines.push(`- Officer: ${data.office}${data.officer_name ? ` | Name: ${data.officer_name}` : ''}${record.sourcePath ? ` Source path: ${record.sourcePath}` : ''}`);
            } else {
                lines.push(`- Rule: ${data.rule_type}${data.subject ? ` | ${data.subject}` : ''}${data.programme ? ` | Programme: ${data.programme}` : ''}: ${record.rawText || ''}${record.sourcePath ? ` Source path: ${record.sourcePath}` : ''}`);
            }
        }

        return lines.join('\n');
    }

    _formatStructuredFactsContext(facts) {
        if (!Array.isArray(facts) || !facts.length) return '';
        const lines = [
            '[Structured Facts - approved exact records]',
            'Use these records for exact factual questions. If they conflict with document RAG, state the source/authority difference.'
        ];
        for (const fact of facts) {
            lines.push(`- ${fact.factType}${fact.subject ? ` | ${fact.subject}` : ''}: ${fact.text}${fact.scope ? ` [${fact.scope}]` : ''}${fact.sourcePath ? ` Source path: ${fact.sourcePath}` : ''}`);
        }
        return lines.join('\n');
    }

    _formatStructuredTablesContext(tables) {
        if (!Array.isArray(tables) || !tables.length) return '';
        const lines = [
            '[Structured Tables - approved table records]',
            'Use these records for table-heavy factual questions. Prefer the machine-readable rows for numbers, durations, fees, course units, and requirements.'
        ];
        for (const table of tables) {
            lines.push(`\nTable: ${table.title}${table.programme ? ` | Programme: ${table.programme}` : ''}${table.section ? ` | Section: ${table.section}` : ''}${table.sourcePath ? ` | Source path: ${table.sourcePath}` : ''}`);
            lines.push('Human-readable table:');
            lines.push(String(table.markdown || '').split(/\r?\n/).slice(0, 12).join('\n'));
            const rows = Array.isArray(table.rows) ? table.rows.slice(0, 8) : [];
            if (rows.length) {
                lines.push(`Machine rows JSON: ${JSON.stringify(rows)}`);
            }
        }
        return lines.join('\n');
    }

    _buildHighRiskFactPolicy(processedQuery, structuredFacts = [], structuredTables = [], normalizedAcademicRecords = []) {
        const q = String(processedQuery?.canonicalQuery || processedQuery?.normalized || '').toLowerCase();
        const patterns = [
            ['admission eligibility', /\b(admission|entry requirement|eligibility|utme|direct entry|o'?level|waec|neco)\b/],
            ['fees', /\b(fee|fees|tuition|payment|charges|cost|levy)\b/],
            ['deadlines/calendar', /\b(deadline|closing date|calendar|resumption|exam date|registration date)\b/],
            ['progression/probation/withdrawal', /\b(progression|probation|withdrawal|withdraw|repeat|carry over|cgpa|gpa)\b/],
            ['graduation/examination rules', /\b(graduation|graduate|exam|examination|professional examination|pass mark|grade)\b/],
            ['course registration/transfer/accreditation', /\b(course registration|register course|transfer|accreditation|mdcn|nuc)\b/]
        ];
        const matched = patterns.filter(([, re]) => re.test(q)).map(([label]) => label);
        if (!matched.length) return null;

        const hasExactRecord = (structuredFacts.length + structuredTables.length + normalizedAcademicRecords.length) > 0;
        return {
            isHighRisk: true,
            topics: matched,
            hasExactRecord,
            context: [
                '[High-Risk Academic Fact Policy]',
                `Detected topic(s): ${matched.join(', ')}.`,
                hasExactRecord
                    ? 'Approved normalized records and/or structured facts/tables are available. Use them for the exact answer and mention the authority/scope where relevant.'
                    : 'No approved normalized or structured fact/table was found for this query. Do not give a definitive answer from model memory or weak context. If excerpts only show national minimums or partial policy, say that clearly and ask the user to confirm with current BMU authority.'
            ].join('\n')
        };
    }

    /**
     * Process and expand query for better retrieval
     */
    async _processQuery(userQuery, sessionContext = {}) {
        const normalized = userQuery.trim().toLowerCase();
        const canonicalQuery = this.config.enableCanonicalRewrite
            ? this._rewriteCanonicalQuery(normalized)
            : normalized;
        const sourcePolicy = this._detectSourcePolicy(canonicalQuery);
        
        // Simple query expansion using synonyms and related terms
        let expanded = canonicalQuery;
        
        if (this.config.enableQueryExpansion) {
            // BMU-specific term expansion - comprehensive list
            const expansions = {
                // Leave and absence
                'leave': 'leave vacation absence time off annual sick maternity paternity',
                'annual leave': 'annual leave vacation yearly entitlement days off',
                'sick leave': 'sick leave illness medical health absence',
                'maternity': 'maternity leave pregnancy childbirth maternal parental',
                'paternity': 'paternity leave father parental child birth',
                
                // Compensation
                'salary': 'salary pay compensation remuneration wage income earnings',
                'allowance': 'allowance benefit entitlement payment bonus stipend',
                'pension': 'pension retirement superannuation gratuity benefits',
                'bonus': 'bonus incentive reward payment additional',
                
                // Career
                'promotion': 'promotion advancement career progression upgrade rank',
                'appointment': 'appointment employment hiring recruitment engagement',
                'tenure': 'tenure appointment contract service permanent confirmation',
                'transfer': 'transfer posting deployment reassignment relocation',
                'resignation': 'resignation resign leaving departure exit termination',
                'retirement': 'retirement retire pension superannuation disengagement',
                
                // Academic
                'admission': 'admission entry enrollment registration matriculation acceptance',
                'exam': 'examination test assessment evaluation quiz',
                'examination': 'examination exam test assessment evaluation',
                'result': 'result grade score mark performance outcome',
                'graduation': 'graduation convocation certificate degree completion',
                'transcript': 'transcript result academic record statement',
                'fee': 'fee payment tuition charges cost levy fees structure',
                'fees': 'fees fee payment tuition charges cost levy structure schedule',
                'tuition': 'tuition fee payment levy charges',
                'cost': 'cost fee tuition payment charge price',
                'price': 'price cost fee tuition charge',
                'scholarship': 'scholarship bursary grant financial aid award',
                'course': 'course program programme module subject class',

                // BMU-specific programme name aliases. The fees and curriculum
                // documents use the official programme groupings (e.g. "MEDICINE
                // & DENTISTRY"), but students naturally ask using degree codes
                // (MBBS, BNSc, BMLS). Without these aliases the embedding model
                // doesn't connect "MBBS fees" to a chunk titled
                // "## 1. MEDICINE & DENTISTRY".
                'mbbs':       'mbbs medicine dentistry surgery clinical sciences medical doctor',
                'medicine':   'medicine dentistry mbbs surgery clinical sciences faculty medical doctor',
                'medicine and surgery': 'mbbs medicine dentistry surgery clinical sciences medical doctor',
                'med and surg':         'mbbs medicine dentistry surgery clinical sciences medical doctor',
                'surgery':    'surgery mbbs medicine dentistry clinical',
                'medical doctor': 'mbbs medicine dentistry surgery clinical',
                'dentistry':  'dentistry medicine dental sciences clinical mbbs bds',
                'bds':        'bds dentistry dental medicine',
                'nursing':    'nursing bnsc',
                'pharmacy':   'pharmacy pharmaceutical sciences pharm',
                'bnsc':       'bnsc nursing science',
                'bmls':       'bmls medical laboratory science',
                'medical lab':'medical lab laboratory science bmls',
                'optometry':  'optometry vision sciences',
                'physiotherapy':'physiotherapy physical therapy',
                'radiography':'radiography radiology imaging',
                'biochemistry':'biochemistry basic medical sciences',
                'anatomy':    'anatomy human anatomy basic medical sciences',
                'physiology': 'physiology human physiology basic medical sciences',
                'public health':'public health community health',
                'nutrition':  'nutrition human nutrition dietetics',
                
                // Personnel
                'staff': 'staff employee worker personnel member faculty',
                'student': 'student learner undergraduate postgraduate pupil scholar',
                'faculty': 'faculty academic teaching staff lecturer professor',
                'lecturer': 'lecturer teacher instructor professor academic faculty',
                
                // Policy and governance
                'policy': 'policy regulation rule guideline procedure standard',
                'regulation': 'regulation rule policy guideline law act statute',
                'procedure': 'procedure process protocol guideline steps method',
                'guideline': 'guideline policy regulation standard protocol',
                'code': 'code conduct ethics rule regulation policy',
                
                // Discipline
                'disciplinary': 'disciplinary misconduct violation offense penalty sanction',
                'misconduct': 'misconduct violation breach offense discipline',
                'grievance': 'grievance complaint appeal dispute petition',
                'complaint': 'complaint grievance petition issue concern',
                'appeal': 'appeal grievance review reconsideration petition',
                
                // General university terms
                'university': 'university institution BMU bayelsa medical',
                'department': 'department unit faculty division section',
                'senate': 'senate council governing body committee academic board',
                'council': 'council board governing body committee administration',
                'dean': 'dean head director faculty leadership',
                'registrar': 'registrar registry administration records office',
                'bursar': 'bursar bursary finance accounts payment',
                'librarian': 'librarian university librarian library director information resources',
                'vice chancellor': 'vice chancellor vice-chancellor vc',
                'vice-chancellor': 'vice chancellor vice-chancellor vc',
                
                // Strategic/Vision terms
                'aspire': 'aspire agenda vision strategic plan initiative goal mission',
                'vision': 'vision aspire agenda mission strategic goal',
                'agenda': 'agenda aspire vision plan initiative programme',
                'strategic': 'strategic plan agenda vision mission development',
                
                // Time periods
                'semester': 'semester term session period academic year',
                'session': 'session semester term academic year period',
                'deadline': 'deadline due date cutoff submission closing'
            };
            
            // Check for matching terms and add expansions
            for (const [term, synonyms] of Object.entries(expansions)) {
                if (normalized.includes(term)) {
                    // Only add unique terms not already in the query
                    const newTerms = synonyms.split(' ').filter(s => !normalized.includes(s));
                    expanded = `${expanded} ${newTerms.join(' ')}`;
                }
            }
        }
        
        // Add context from conversation history if available
        const contextTerms = sessionContext.recentTopics || [];
        if (contextTerms.length > 0) {
            expanded = `${expanded} ${contextTerms.slice(0, 3).join(' ')}`;
        }

        return {
            original: userQuery,
            normalized,
            canonicalQuery,
            expanded: expanded.trim(),
            intent: this._detectQueryIntent(canonicalQuery),
            sourcePolicy
        };
    }

    _rewriteCanonicalQuery(queryText) {
        const q = String(queryText || '').trim().toLowerCase();
        if (!q) return q;

        const replacements = [
            [/\bprogrammes?\b/g, 'programme'],
            [/\bcourses?\b/g, 'course'],
            [/\bfees?\b/g, 'fee'],
            [/\bfees structure\b/g, 'fee structure'],
            [/\btuition fees?\b/g, 'tuition fee'],
            [/\brequirements?\b/g, 'requirement'],
            [/\bresults?\b/g, 'result'],
            [/\bexaminations?\b/g, 'exam'],
            [/\bhostel\b/g, 'hostel accommodation'],
            [/\bhostels?\b/g, 'hostel accommodation']
        ];

        let rewritten = q;
        for (const [pattern, replacement] of replacements) {
            rewritten = rewritten.replace(pattern, replacement);
        }

        return rewritten;
    }

    _detectSourcePolicy(queryText) {
        const q = String(queryText || '').toLowerCase();
        if (/(fee|tuition|payment|charges|cost|scholarship|allowance)/.test(q)) return 'fee_policy';
        if (/(progress|promotion|probation|withdraw|graduation|cgpa|gpa|result|exam|grade|carry over|repeat)/.test(q)) return 'programme_policy';
        if (/(programme|program|course|admission|requirement|curriculum|department|faculty)/.test(q)) return 'academic_programme';
        return 'general';
    }

    _applySourceRankingPolicy(results, processedQuery) {
        if (!Array.isArray(results) || !results.length || !processedQuery) return results;

        const policy = processedQuery.sourcePolicy || 'general';
        const matchers = {
            fee_policy: [/fees?|tuition|payment|charges|cost|financial/i],
            programme_policy: [/ccmas|progression|probation|withdrawal|graduation|academic.*standard|result|exam|grade/i],
            academic_programme: [/programme|program|curriculum|admission|requirement|course|faculty|department/i]
        };

        const boostRules = matchers[policy] || [];
        if (!boostRules.length) return results;

        const boosted = results.map((result) => {
            const title = String(result.documentTitle || '').toLowerCase();
            const content = String(result.content || '').toLowerCase();
            let score = Number(result.score || 0);

            if (boostRules.some(re => re.test(title) || re.test(content))) {
                score = score * 1.28;
                result.sourcePolicyBoosted = true;
            }

            if (policy === 'programme_policy' && /ccmas/.test(title)) {
                score = score * 1.40;
            }

            if (policy === 'fee_policy' && /(fees|tuition|payment|finance)/.test(title)) {
                score = score * 1.35;
            }

            if ((policy === 'academic_programme' || policy === 'general') && /students' handbook|student handbook|quick facts/.test(title)) {
                score = score * 1.10;
            }

            result.score = score;
            return result;
        });

        console.log(`[RetrievalService] Source-ranking policy applied: ${policy} (${boosted.filter(r => r.sourcePolicyBoosted).length} candidates boosted)`);
        return boosted.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    _applyAdminAuthorityRanking(results) {
        if (!Array.isArray(results) || !results.length) return results;

        const strength = this.config.authorityRankingStrength;
        if (!(strength > 0)) return results;

        let boosted = 0;
        for (const result of results) {
            const rank = Number.isFinite(Number(result.authorityRank))
                ? clamp(Number(result.authorityRank), 0, 100)
                : 50;
            const normalized = (rank - 50) / 50;
            const factor = 1 + (normalized * strength);
            result.authorityRank = rank;
            result.authorityBoostFactor = factor;
            result.score = Number(result.score || 0) * factor;
            if (Math.abs(factor - 1) > 0.01) boosted++;
        }

        if (boosted > 0) {
            console.log(`[RetrievalService] Admin authority ranking applied to ${boosted} chunk(s)`);
        }
        return results.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    _applyCrossSourceOccurrenceRanking(results) {
        if (!Array.isArray(results) || !results.length) return results;

        const minSources = Math.max(2, this.config.crossSourceOccurrenceMinSources || 3);
        const distinctDocs = new Set(results.map(r => r.documentId).filter(Boolean));
        if (distinctDocs.size < minSources) return results;

        const docCounts = new Map();
        for (const result of results) {
            docCounts.set(result.documentId, (docCounts.get(result.documentId) || 0) + 1);
        }

        const globalBoost = Math.min(
            this.config.crossSourceOccurrenceMaxBoost,
            Math.max(0, distinctDocs.size - minSources + 1) * 0.045
        );

        if (!(globalBoost > 0)) return results;

        for (const result of results) {
            const docCount = docCounts.get(result.documentId) || 1;
            const docBoost = Math.min(0.06, Math.max(0, docCount - 1) * 0.015);
            result.sourceOccurrenceDocs = distinctDocs.size;
            result.documentOccurrenceCount = docCount;
            result.sourceOccurrenceBoostFactor = 1 + globalBoost + docBoost;
            result.score = Number(result.score || 0) * result.sourceOccurrenceBoostFactor;
        }

        console.log(`[RetrievalService] Cross-source occurrence ranking applied across ${distinctDocs.size} document(s)`);
        return results.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    /**
     * Detect query intent for better retrieval strategy
     */
    _detectQueryIntent(query) {
        const intents = {
            definitional: /^(what is|what are|define|meaning of|who is)/i,
            procedural: /^(how (do|can|to)|steps to|process for|procedure)/i,
            eligibility: /(eligible|qualify|requirement|criteria|can i|am i)/i,
            quantitative: /(how (many|much|long)|number of|amount|duration|deadline|date)/i,
            comparison: /(difference between|compare|vs|versus|better)/i,
            policy: /(policy|rule|regulation|guideline|law|act)/i,
            programmePolicy: /(progress|promotion|advance|carry[\s-]?over|repeat|probation|withdraw|graduat|cgpa|gpa|academic standard|minimum grade|criteria|requirement)/i
        };
        
        for (const [intent, pattern] of Object.entries(intents)) {
            if (pattern.test(query)) {
                return intent;
            }
        }
        
        return 'general';
    }

    /**
     * Hybrid search combining semantic and keyword search
     */
    async _hybridSearch(processedQuery, topK, documentIds = null) {
        const results = [];
        const hasDocFilter = documentIds && Array.isArray(documentIds) && documentIds.length > 0;
        
        // Parallel execution of semantic, keyword, title-based, AND exact phrase search
        const [semanticResults, keywordResults, titleMatchResults, exactPhraseResults] = await Promise.all([
            this._semanticSearch(processedQuery.expanded, topK * 2, documentIds),
            this.config.enableHybridSearch 
                ? this._keywordSearch(processedQuery.normalized, topK * 2, documentIds)
                : Promise.resolve([]),
            // Title-first search for exact document matching
            // Title-first search: include both original and expanded query
            // so that BMU-specific synonym expansions (e.g. fees -> fees
            // structure, MBBS -> medicine) can match dedicated documents.
            this._titleMatchSearch(processedQuery.expanded || processedQuery.original, topK, documentIds),
            // Exact phrase match in content - high priority for specific queries
            this._exactPhraseSearch(processedQuery.normalized, topK, documentIds)
        ]);
        
        // Merge and score results
        const seen = new Set();
        const mergedResults = [];
        
        // PRIORITY 0: Exact phrase matches.
        // Previously forced to score 0.98+, which (combined with the title
        // match floor of 0.95) meant any chunk merely containing 2 query
        // words could outrank the best semantic hit. Now treated as a high
        // but bounded score that still respects content relevance.
        for (const result of exactPhraseResults) {
            const key = `${result.documentId}-${result.chunkIndex}`;
            if (!seen.has(key)) {
                seen.add(key);
                mergedResults.push({
                    ...result,
                    semanticScore: 0,
                    keywordScore: 0,
                    titleMatchScore: 0,
                    exactPhraseScore: result.score,
                    score: 0.65 + (result.score * 0.20)
                });
                console.log(`[RetrievalService] Exact phrase match: "${result.documentTitle}" score=${result.score.toFixed(3)}`);
            }
        }
        
        // PRIORITY 1: Title-matched results.
        //
        // Previously these were forced to score >=0.95 which made them ALWAYS
        // outrank semantic hits. Combined with over-fired title matching that
        // can be triggered by many docs, this caused the wrong document to
        // dominate (e.g. handbook crushes a dedicated fees doc on a fee
        // query). Now we treat title-match as a strong but bounded boost on
        // top of the chunk's own semantic score so the relevance of the
        // chunk content still matters.
        for (const result of titleMatchResults) {
            const key = `${result.documentId}-${result.chunkIndex}`;
            if (!seen.has(key)) {
                seen.add(key);
                mergedResults.push({
                    ...result,
                    semanticScore: 0,
                    keywordScore: 0,
                    titleMatchScore: result.score,
                    exactPhraseScore: 0,
                    score: 0.55 + (result.score * 0.25)
                });
                console.log(`[RetrievalService] Title match: "${result.documentTitle}" score=${result.score.toFixed(3)}`);
            }
        }
        
        // PRIORITY 2: Add semantic results with weighted score
        for (const result of semanticResults) {
            const key = `${result.documentId}-${result.chunkIndex}`;
            if (!seen.has(key)) {
                seen.add(key);
                mergedResults.push({
                    ...result,
                    semanticScore: result.score,
                    keywordScore: 0,
                    titleMatchScore: 0,
                    exactPhraseScore: 0,
                    score: result.score * this.config.semanticWeight
                });
            }
        }
        
        // PRIORITY 3: Merge keyword results.
        //
        // A chunk where every keyword matches is a strong relevance signal
        // — it's exactly the case where we want a small dedicated doc (e.g.
        // a 31-chunk Brief Profile chunk that contains every word of the
        // user's question) to compete with semantic hits from giant docs.
        // We map raw keyword score (matchCount / keywords.length) onto a
        // fixed range that respects but doesn't dwarf semantic scores:
        //   raw 1.0 (all keywords match) -> 0.85
        //   raw 0.5                      -> 0.55
        //   raw 0.0                      -> 0.25
        const kwToScore = (raw) => 0.25 + (raw * 0.60);
        for (const result of keywordResults) {
            const key = `${result.documentId}-${result.chunkIndex}`;
            const existing = mergedResults.find(r => 
                r.documentId === result.documentId && r.chunkIndex === result.chunkIndex
            );
            const kwScore = kwToScore(result.score);
            if (existing) {
                // Combine: take the max of existing and keyword-derived score
                existing.keywordScore = result.score;
                existing.score = Math.max(existing.score, kwScore);
            } else if (!seen.has(key)) {
                seen.add(key);
                mergedResults.push({
                    ...result,
                    semanticScore: 0,
                    keywordScore: result.score,
                    titleMatchScore: 0,
                    exactPhraseScore: 0,
                    score: kwScore
                });
            }
        }
        
        // Apply policy-specific source boosts before generic primary-source
        // bias so programme rules are sourced from CCMAS documents.
        const policyBoosted = this._applyProgrammePolicyBoost(mergedResults, processedQuery);

        // Sort by combined score and filter by minimum relevance
        return this._applyPrimarySourceBoost(policyBoosted, processedQuery)
            .filter(r => r.score >= this.config.minRelevanceScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    _isProgrammePolicyQuery(processedQuery) {
        const q = String(processedQuery?.normalized || '').toLowerCase();
        const intent = String(processedQuery?.intent || '').toLowerCase();

        const asksPolicy = intent === 'programmepolicy'
            || /(progress|promotion|advance|carry[\s-]?over|repeat|probation|withdraw|graduat|cgpa|gpa|academic standard|minimum grade|criteria|requirement)/i.test(q);
        const hasProgramme = /(mbbs|medicine|dentistry|bnsc|nursing|bmls|medical laboratory science|medical lab|allied health|pharmacy|physiotherapy|radiography|optometry|public health|biochemistry|anatomy|physiology)/i.test(q);

        return asksPolicy && hasProgramme;
    }

    _applyProgrammePolicyBoost(results, processedQuery) {
        if (!this._isProgrammePolicyQuery(processedQuery)) return results;

        const ccmasPattern = this.config.ccmasPattern;
        const ccmasBoost = this.config.ccmasBoost;
        const alliedHealthPattern = this.config.alliedHealthPattern;
        const alliedHealthBoost = this.config.alliedHealthBoost;
        const q = String(processedQuery?.normalized || '').toLowerCase();
        const asksMedLab = /(bmls|medical laboratory science|medical lab)/i.test(q);

        let boosted = 0;
        for (const r of results) {
            const title = String(r.documentTitle || '').toLowerCase();
            const content = String(r.content || '').toLowerCase();
            let factor = 1;

            if (ccmasPattern && (title.includes(ccmasPattern) || content.includes('ccmas'))) {
                factor = Math.max(factor, ccmasBoost);
            }
            if (asksMedLab && alliedHealthPattern && title.includes(alliedHealthPattern)) {
                factor = Math.max(factor, alliedHealthBoost);
            }

            if (factor > 1) {
                r.programmePolicyBoosted = true;
                r.score = r.score * factor;
                boosted++;
            }
        }

        if (boosted > 0) {
            console.log(`[RetrievalService] Programme-policy boost applied to ${boosted} chunk(s)`);
        }
        return results;
    }
    
    /**
     * Multiply the score of any chunk whose document title matches the
     * configured "primary source" (default: the Students' Handbook). The
     * handbook is BMU's canonical reference; other curricula / regulations
     * only expand on it, so when both match we want the handbook chunk first.
     *
     * Scores are not re-clamped to 1.0 — downstream code (re-ranker, sorter)
     * compares scores ordinally, so values >1 are fine and preserve the
     * relative ranking between two boosted handbook chunks.
     */
    _applyPrimarySourceBoost(results, processedQuery = null) {
        // For programme-specific progression/withdrawal questions, the
        // curriculum (CCMAS) documents are the primary source.
        if (this._isProgrammePolicyQuery(processedQuery)) return results;

        const pattern = this.config.primarySourcePattern;
        const boost   = this.config.primarySourceBoost;
        if (!pattern || !(boost > 1)) return results;
        let boosted = 0;
        for (const r of results) {
            const title = (r.documentTitle || '').toLowerCase();
            if (title.includes(pattern)) {
                r.primarySourceBoosted = true;
                r.score = r.score * boost;
                boosted++;
            }
        }
        if (boosted > 0) {
            console.log(`[RetrievalService] Primary-source boost x${boost} applied to ${boosted} chunk(s) matching "${pattern}"`);
        }
        return results;
    }
    
    /**
     * Exact phrase search: Find chunks containing the exact query phrase
     * This is critical for queries like "annual leave" where we want chunks that specifically discuss this topic
     */
    async _exactPhraseSearch(queryText, topK, documentIds = null) {
        try {
            const queryLower = queryText.toLowerCase().trim();
            
            // Skip if query is too short or just stop words
            const significantWords = queryLower.split(/\s+/).filter(w => 
                w.length > 2 && !['what', 'is', 'the', 'about', 'tell', 'me', 'can', 'you', 'how', 'does', 'do', 'many', 'much', 'number', 'days', 'given', 'for', 'are'].includes(w)
            );
            
            if (significantWords.length === 0) return [];
            
            // Build phrase search - look for the key terms together
            // For "how many days for annual leave" -> search for "annual leave"
            let searchPhrases = [];
            
            // Add pairs of significant words as phrases
            for (let i = 0; i < significantWords.length - 1; i++) {
                searchPhrases.push(`${significantWords[i]} ${significantWords[i + 1]}`);
            }
            
            // Also search for individual significant words if no pairs found
            if (searchPhrases.length === 0) {
                searchPhrases.push(...significantWords);
            }
            
            if (searchPhrases.length === 0) return [];

            const expandedPhrases = new Set();
            for (const phrase of searchPhrases) {
                expandedPhrases.add(phrase);
                if (phrase.includes(' ')) {
                    expandedPhrases.add(phrase.replace(/\s+/g, '-'));
                }
            }
            searchPhrases = Array.from(expandedPhrases);
            
            // Build LIKE conditions - search for phrases in content
            const likeConditions = searchPhrases.map(() => 'LOWER(dc.content) LIKE ?').join(' OR ');
            const likeParams = searchPhrases.map(p => `%${p}%`);
            
            // Add document filter if specified
            let whereClause = `(${likeConditions})`;
            let queryParams = [...likeParams];
            
            if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
                const placeholders = documentIds.map(() => '?').join(', ');
                whereClause += ` AND d.id IN (${placeholders})`;
                queryParams = [...queryParams, ...documentIds];
            }
            
            // Query for chunks containing the exact phrases
            const rows = await query(`
                SELECT 
                    dc.id,
                    dc.document_id as documentId,
                    dc.chunk_index as chunkIndex,
                    dc.content,
                    d.title as documentTitle,
                    d.category as documentCategory,
                    d.authority_rank as authorityRank,
                    d.authority_label as authorityLabel
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE ${whereClause}
                ORDER BY dc.chunk_index ASC
                LIMIT ?
            `, [...queryParams, topK * 2]);
            
            if (rows && rows.length > 0) {
                console.log(`[RetrievalService] Exact phrase search found ${rows.length} chunks for phrases: ${searchPhrases.join(', ')}`);
            }
            
            // Score based on how many phrases match and phrase density
            return (rows || []).map(row => {
                const contentLower = (row.content || '').toLowerCase();
                let score = 0.5;
                
                // Count how many search phrases are found
                const matchCount = searchPhrases.filter(p => contentLower.includes(p)).length;
                score = 0.5 + (matchCount / searchPhrases.length) * 0.5;
                
                // Bonus for multiple occurrences of the phrase
                for (const phrase of searchPhrases) {
                    const matches = (contentLower.match(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                    if (matches > 1) {
                        score = Math.min(score + 0.1 * (matches - 1), 1.0);
                    }
                }
                
                // Prefer earlier chunks (often contain definitions/summaries)
                const positionBonus = Math.max(0, 0.1 - row.chunkIndex * 0.01);
                score += positionBonus;
                
                return {
                    documentId: row.documentId,
                    chunkIndex: row.chunkIndex,
                    content: row.content,
                    documentTitle: row.documentTitle,
                    documentCategory: row.documentCategory,
                    authorityRank: row.authorityRank,
                    authorityLabel: row.authorityLabel,
                    score: Math.min(score, 1.0)
                };
            });
            
        } catch (error) {
            console.error('[RetrievalService] Exact phrase search error:', error);
            return [];
        }
    }
    
    /**
     * Title-first search: Find documents whose titles match the query phrase.
     *
     * IMPORTANT: only match on multi-token phrases (>=2 words), never single
     * words. Single-word title matching badly over-fires when titles share
     * any common term — e.g. searching "What are the fees for MBBS" against
     * a doc titled "BMU CAREER PROSPECTS" returns hits because both contain
     * "BMU". This drowns out the dedicated fees document in the merge step
     * (which scores title hits at 0.95+, far above any semantic match).
     *
     * Stop-words excluded so phrases like "the fees" don't match either.
     */
    async _titleMatchSearch(queryText, topK, documentIds = null) {
        try {
            const queryLower = queryText.toLowerCase().trim();
            const STOPWORDS = new Set([
                'what','when','where','which','about','their','this','that','with',
                'have','been','they','will','into','from','your','there','these',
                'those','please','tell','should','would','could','what','is','the',
                'about','tell','me','can','you','how','does','do','for','are','any','many'
            ]);
            const words = queryLower
                .replace(/[^a-z0-9 ]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 2 && !STOPWORDS.has(w));

            // Build ONLY multi-token phrases (2-3 words). Single words are
            // intentionally dropped — they cause too many spurious hits.
            const keyPhrases = [];
            if (queryLower.split(/\s+/).length >= 2) keyPhrases.push(queryLower);
            for (let i = 0; i < words.length - 1; i++) {
                const pair = `${words[i]} ${words[i + 1]}`;
                keyPhrases.push(pair);
                // Also try a singular variant for common pluralisation (fees -> fee, courses -> course)
                if (words[i].endsWith('s') && words[i].length > 3) keyPhrases.push(`${words[i].slice(0, -1)} ${words[i + 1]}`);
                if (words[i + 1].endsWith('s') && words[i + 1].length > 3) keyPhrases.push(`${words[i]} ${words[i + 1].slice(0, -1)}`);
                if (i < words.length - 2) {
                    keyPhrases.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
                }
            }
            // Dedupe
            const seen = new Set();
            const dedupedPhrases = keyPhrases.filter(p => { if (seen.has(p)) return false; seen.add(p); return true; });
            if (dedupedPhrases.length === 0) return [];
            
            // Build LIKE conditions for title matching
            const likeConditions = dedupedPhrases.map(() => 'LOWER(d.title) LIKE ?').join(' OR ');
            const likeParams = dedupedPhrases.map(p => `%${p}%`);
            
            // Add document filter if specified
            let whereClause = `(${likeConditions})`;
            let queryParams = [...likeParams];
            
            if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
                const placeholders = documentIds.map(() => '?').join(', ');
                whereClause += ` AND d.id IN (${placeholders})`;
                queryParams = [...queryParams, ...documentIds];
            }
            
            // Query for chunks from title-matching documents
            const rows = await query(`
                SELECT 
                    dc.id,
                    dc.document_id as documentId,
                    dc.chunk_index as chunkIndex,
                    dc.content,
                    d.title as documentTitle,
                    d.category as documentCategory,
                    d.authority_rank as authorityRank,
                    d.authority_label as authorityLabel
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE ${whereClause}
                ORDER BY 
                    CASE WHEN LOWER(d.title) LIKE ? THEN 0 ELSE 1 END,
                    dc.chunk_index ASC
                LIMIT ?
            `, [...queryParams, `%${queryLower}%`, topK * 2]);
            
            if (rows && rows.length > 0) {
                console.log(`[RetrievalService] Title match found ${rows.length} chunks from documents matching "${queryLower}"`);
            }
            
            // Score based on how well the title matches
            return (rows || []).map(row => {
                const titleLower = (row.documentTitle || '').toLowerCase();
                let score = 0.5; // Base score for any title match
                
                // Exact phrase match in title = highest score
                if (titleLower.includes(queryLower)) {
                    score = 1.0;
                } else {
                    // Count matching key phrases
                    const matchCount = dedupedPhrases.filter(p => titleLower.includes(p)).length;
                    score = 0.5 + (matchCount / dedupedPhrases.length) * 0.5;
                }
                
                // Prefer earlier chunks (they often contain the introduction/summary)
                const positionPenalty = Math.min(row.chunkIndex * 0.02, 0.2);
                score -= positionPenalty;
                
                return {
                    documentId: row.documentId,
                    chunkIndex: row.chunkIndex,
                    content: row.content,
                    documentTitle: row.documentTitle,
                    documentCategory: row.documentCategory,
                    authorityRank: row.authorityRank,
                    authorityLabel: row.authorityLabel,
                    score: Math.max(score, 0.5)
                };
            });
            
        } catch (error) {
            console.error('[RetrievalService] Title match search error:', error);
            return [];
        }
    }

    /**
     * Semantic search using vector embeddings
     * @param {string} queryText - The query text to search for
     * @param {number} topK - Maximum number of results to return
     * @param {number[]|null} documentIds - Optional array of document IDs to filter by
     */
    async _semanticSearch(queryText, topK, documentIds = null) {
        try {
            // Check embedding cache
            let embedding = this._getFromCache(queryText, 'query');
            
            if (!embedding) {
                embedding = await getAIService().generateEmbedding(queryText, true);
                this._setCache(queryText, embedding, 'query');
            }
            
            if (!embedding || embedding.length === 0) {
                return [];
            }
            
            // Search vector store (get more results if filtering, to ensure enough after filter)
            const hasDocFilter = documentIds && Array.isArray(documentIds) && documentIds.length > 0;
            const searchLimit = hasDocFilter ? topK * 3 : topK;
            const hits = await vectorStore.search(embedding, searchLimit);
            
            // Filter by document IDs if specified
            let filteredHits = hits;
            if (hasDocFilter) {
                filteredHits = hits.filter(hit => documentIds.includes(hit.documentId));
                console.log(`[RetrievalService] Semantic search filtered: ${hits.length} -> ${filteredHits.length} hits (docs: ${documentIds.join(',')})`);
            }
            
            // Enrich with document metadata
            const enrichedHits = await Promise.all(
                filteredHits.slice(0, topK).map(async (hit) => {
                    const docMeta = await this._getDocumentMetadata(hit.documentId);
                    return {
                        ...hit,
                        documentTitle: docMeta?.title || 'Unknown Document',
                        documentCategory: docMeta?.category || 'general',
                        authorityRank: docMeta?.authority_rank ?? 50,
                        authorityLabel: docMeta?.authority_label || 'Standard'
                    };
                })
            );
            
            return enrichedHits;
            
        } catch (error) {
            console.error('[RetrievalService] Semantic search error:', error);
            return [];
        }
    }

    /**
     * Keyword/full-text search using MySQL FULLTEXT
     * @param {string} queryText - The query text to search for
     * @param {number} topK - Maximum number of results to return
     * @param {number[]|null} documentIds - Optional array of document IDs to filter by
     */
    async _keywordSearch(queryText, topK, documentIds = null) {
        try {
            // Extract meaningful keywords (remove stop words)
            const stopWords = new Set([
                'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
                'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
                'should', 'may', 'might', 'must', 'can', 'of', 'in', 'to', 'for',
                'with', 'on', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
                'before', 'after', 'above', 'below', 'between', 'under', 'again',
                'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
                'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
                'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
                'very', 'just', 'what', 'which', 'who', 'this', 'that', 'these', 'those'
            ]);
            
            const keywords = queryText
                .toLowerCase()
                .replace(/[^\w\s]/g, ' ')   // strip punctuation so "motto?" -> "motto"
                .split(/\s+/)
                .filter(word => word.length > 2 && !stopWords.has(word))
                .slice(0, 10);
            
            if (keywords.length === 0) {
                return [];
            }
            
            // Build search query - use LIKE for partial matching since FULLTEXT may not be set up
            const likeConditions = keywords.map(() => 'content LIKE ?').join(' OR ');
            const likeParams = keywords.map(k => `%${k}%`);
            
            // Add document ID filter if specified
            const hasDocFilter = documentIds && Array.isArray(documentIds) && documentIds.length > 0;
            let whereClause = `(${likeConditions})`;
            let queryParams = [...likeParams];
            
            if (hasDocFilter) {
                const placeholders = documentIds.map(() => '?').join(', ');
                whereClause += ` AND dc.document_id IN (${placeholders})`;
                queryParams = [...queryParams, ...documentIds];
                console.log(`[RetrievalService] Keyword search with doc filter: ${documentIds.join(',')}`);
            }
            
            // Score chunks in SQL by counting how many of the requested
            // keywords match. Without this, MySQL returns the first N rows
            // it finds with no ordering — typically by insertion order — so
            // smaller / later-inserted documents (like the 8-chunk fees doc)
            // are dropped before they're considered. Now we score and
            // ORDER BY DESC, then take the top K.
            const scoreExpr = keywords.map(() => '(LOWER(dc.content) LIKE ?)').join(' + ');
            const scoreParams = keywords.map(k => `%${k}%`);

            const rows = await query(`
                SELECT 
                    dc.id,
                    dc.document_id as documentId,
                    dc.chunk_index as chunkIndex,
                    dc.content,
                    d.title as documentTitle,
                    d.category as documentCategory,
                    d.authority_rank as authorityRank,
                    d.authority_label as authorityLabel,
                    (${scoreExpr}) AS match_count
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE ${whereClause}
                ORDER BY match_count DESC, dc.document_id ASC
                LIMIT ?
            `, [...scoreParams, ...queryParams, topK]);
            
            // Calculate simple relevance score based on keyword matches
            return (rows || []).map(row => {
                const contentLower = (row.content || '').toLowerCase();
                const matchCount = keywords.filter(k => contentLower.includes(k)).length;
                const score = matchCount / keywords.length;
                
                return {
                    documentId: row.documentId,
                    chunkIndex: row.chunkIndex,
                    content: row.content,
                    documentTitle: row.documentTitle,
                    documentCategory: row.documentCategory,
                    authorityRank: row.authorityRank,
                    authorityLabel: row.authorityLabel,
                    score: Math.min(score, 1.0)
                };
            }).filter(r => r.score > 0);
            
        } catch (error) {
            console.error('[RetrievalService] Keyword search error:', error);
            return [];
        }
    }

    /**
     * Re-rank results using cross-encoder style scoring
     * This is a simplified version - a full implementation would use a cross-encoder model
     */
    async _reRankResults(queryText, results) {
        if (results.length === 0) return results;
        
        const startTime = Date.now();
        
        // Simple re-ranking based on:
        // 1. Query term coverage in content
        // 2. Document title match (IMPORTANT for exact topic matching)
        // 3. Content length (prefer more substantial chunks)
        // 4. Position of query terms (earlier = better)
        
        const queryTerms = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        
        const reRanked = results.map(result => {
            const contentLower = (result.content || '').toLowerCase();
            const titleLower = (result.documentTitle || '').toLowerCase();
            const contentLength = result.content?.length || 0;
            
            // Term coverage score in content
            const termCoverage = queryTerms.filter(t => contentLower.includes(t)).length / queryTerms.length;
            
            // TITLE MATCH BOOST - significantly boost if query terms appear in document title
            let titleBoost = 0;
            const titleMatchCount = queryTerms.filter(t => titleLower.includes(t)).length;
            if (titleMatchCount > 0) {
                titleBoost = (titleMatchCount / queryTerms.length) * 0.4; // Up to 0.4 boost for title match
                // Extra boost for exact phrase match in title
                if (titleLower.includes(queryText.toLowerCase().trim())) {
                    titleBoost += 0.2;
                }
            }
            
            // Length score (normalized, prefer 500-2000 chars)
            const lengthScore = Math.min(contentLength / 1000, 1) * 0.5 + 0.5;
            
            // Position score (where do query terms appear)
            let positionScore = 0;
            for (const term of queryTerms) {
                const pos = contentLower.indexOf(term);
                if (pos >= 0) {
                    positionScore += (1 - pos / contentLength) * 0.3;
                }
            }
            positionScore = Math.min(positionScore / queryTerms.length, 1);
            
            // Combine scores - title boost is additive
            const reRankScore = (
                result.score * 0.4 +  // Original score weight (reduced to make room for title boost)
                termCoverage * 0.2 +
                lengthScore * 0.1 +
                positionScore * 0.1 +
                titleBoost  // Title matching boost
            );
            
            return {
                ...result,
                originalScore: result.score,
                titleBoost,
                reRankScore,
                score: reRankScore
            };
        });
        
        // Sort by re-ranked score
        reRanked.sort((a, b) => b.score - a.score);
        
        this._updateMetrics('rerank', Date.now() - startTime);
        
        return reRanked;
    }

    /**
     * Compress and optimize context for LLM consumption
     */
    async _compressContext(results, queryText) {
        if (results.length === 0) {
            return { text: '', length: 0 };
        }
        
        const maxLength = this.config.maxContextLength;
        let contextParts = [];
        let currentLength = 0;
        
        for (const result of results) {
            const content = result.content || '';
            const docTitle = result.documentTitle || 'Document';
            const docCategory = result.documentCategory || '';
            const header = `[Source: "${docTitle}"${docCategory ? ` (${docCategory})` : ''}]\n`;
            const fullPart = header + content + '\n';
            
            if (currentLength + fullPart.length <= maxLength) {
                contextParts.push(fullPart);
                currentLength += fullPart.length;
            } else {
                // Truncate to fit remaining space
                const remaining = maxLength - currentLength - header.length - 50;
                if (remaining > 200) {
                    const truncated = this._smartTruncate(content, remaining, queryText);
                    contextParts.push(header + truncated + '... [truncated]');
                    currentLength = maxLength;
                }
                break;
            }
        }
        
        const text = contextParts.join('\n---\n');
        
        return {
            text,
            length: text.length,
            partsIncluded: contextParts.length,
            truncated: currentLength >= maxLength
        };
    }

    /**
     * Smart truncation that preserves query-relevant content
     */
    _smartTruncate(content, maxLength, queryText) {
        if (content.length <= maxLength) return content;
        
        const queryTerms = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        const sentences = content.split(/[.!?]+/).filter(s => s.trim());
        
        // Score sentences by relevance
        const scoredSentences = sentences.map((sentence, idx) => {
            const sentenceLower = sentence.toLowerCase();
            const termScore = queryTerms.filter(t => sentenceLower.includes(t)).length;
            return { sentence: sentence.trim(), score: termScore, idx };
        });
        
        // Sort by score, keeping some order context
        scoredSentences.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.idx - b.idx; // Keep original order for same score
        });
        
        // Build truncated content from most relevant sentences
        let result = '';
        for (const { sentence } of scoredSentences) {
            if (result.length + sentence.length + 2 <= maxLength) {
                result += (result ? '. ' : '') + sentence;
            } else {
                break;
            }
        }
        
        return result || content.substring(0, maxLength);
    }

    /**
     * Check FAQ cache for direct answer
     */
    async _checkFAQCache(queryText) {
        try {
            const faqMatch = await faqService.findSimilarQuestion(queryText);
            
            if (faqMatch && faqMatch.cachedQA) {
                return {
                    answer: faqMatch.cachedQA.answer,
                    sources: faqMatch.cachedQA.answer_sources 
                        ? JSON.parse(faqMatch.cachedQA.answer_sources) 
                        : [],
                    confidence: faqMatch.similarityScore,
                    questionMatched: faqMatch.cachedQA.question
                };
            }
            
            return null;
        } catch (error) {
            console.error('[RetrievalService] FAQ cache check error:', error);
            return null;
        }
    }

    /**
     * Get document metadata with caching
     */
    async _getDocumentMetadata(documentId) {
        const cached = this._documentCache.get(documentId);
        if (cached && Date.now() - cached.time < this.config.contextCacheTTL) {
            return cached.data;
        }
        
        try {
            const rows = await query(
                'SELECT id, title, category, file_type, authority_rank, authority_label FROM documents WHERE id = ?',
                [documentId]
            );
            
            const data = rows?.[0] || null;
            this._documentCache.set(documentId, { data, time: Date.now() });
            
            return data;
        } catch (error) {
            return null;
        }
    }

    /**
     * Extract unique sources from results
     */
    _extractSources(results) {
        const seen = new Set();
        const sources = [];
        
        for (const result of results) {
            const key = result.documentId;
            if (!seen.has(key)) {
                seen.add(key);
                sources.push({
                    documentId: result.documentId,
                    title: result.documentTitle,
                    category: result.documentCategory,
                    authorityRank: result.authorityRank,
                    authorityLabel: result.authorityLabel,
                    sourceOccurrenceDocs: result.sourceOccurrenceDocs
                });
            }
        }
        
        return sources;
    }

    // === Cache Management ===
    
    _generateCacheKey(query, options) {
        const optionsStr = JSON.stringify({
            limit: options.limit,
            skipCache: options.skipCache
        });
        return `${query.toLowerCase().trim()}::${optionsStr}`;
    }
    
    _getFromCache(key, type) {
        const cache = type === 'query' ? this._queryCache : this._contextCache;
        const item = cache.get(key);
        
        if (!item) return null;
        
        const ttl = type === 'query' ? this.config.queryCacheTTL : this.config.contextCacheTTL;
        if (Date.now() - item.time > ttl) {
            cache.delete(key);
            return null;
        }
        
        return item.data;
    }
    
    _setCache(key, data, type) {
        const cache = type === 'query' ? this._queryCache : this._contextCache;
        const maxSize = type === 'query' ? 200 : 100;
        
        // Simple LRU: remove oldest if full
        if (cache.size >= maxSize) {
            const firstKey = cache.keys().next().value;
            cache.delete(firstKey);
        }
        
        cache.set(key, { data, time: Date.now() });
    }
    
    clearCache(type = 'all') {
        if (type === 'all' || type === 'query') {
            this._queryCache.clear();
        }
        if (type === 'all' || type === 'context') {
            this._contextCache.clear();
        }
        if (type === 'all' || type === 'document') {
            this._documentCache.clear();
        }
    }

    // === Metrics ===
    
    _updateMetrics(type, timeMs) {
        if (type === 'retrieval') {
            this._metrics.avgRetrievalTime = 
                (this._metrics.avgRetrievalTime * (this._metrics.totalQueries - 1) + timeMs) / 
                this._metrics.totalQueries;
        } else if (type === 'rerank') {
            this._metrics.avgReRankTime = 
                (this._metrics.avgReRankTime * (this._metrics.totalQueries - 1) + timeMs) / 
                this._metrics.totalQueries;
        }
    }
    
    getMetrics() {
        return {
            ...this._metrics,
            cacheHitRate: this._metrics.totalQueries > 0 
                ? (this._metrics.cacheHits / this._metrics.totalQueries * 100).toFixed(2) + '%'
                : '0%',
            queryCacheSize: this._queryCache.size,
            contextCacheSize: this._contextCache.size,
            documentCacheSize: this._documentCache.size
        };
    }
}

module.exports = new RetrievalService();
