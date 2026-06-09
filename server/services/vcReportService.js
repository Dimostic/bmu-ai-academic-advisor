/**
 * VC Report Service
 * Handles AI analysis, processing, and chat for VC reports
 */

const VCReport = require('../models/VCReport');
const VCReportChunk = require('../models/VCReportChunk');
const { query } = require('../../config/db');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

// Lazy-load document processor to avoid circular dependency
let _documentProcessor = null;
function getDocumentProcessor() {
    if (!_documentProcessor) {
        _documentProcessor = require('./documentProcessor');
    }
    return _documentProcessor;
}

// Lazy-load AI service
let _aiService = null;
function getAIService() {
    if (!_aiService) {
        _aiService = require('./aiService');
    }
    return _aiService;
}

let _audioService = null;
function getAudioService() {
    if (!_audioService) {
        _audioService = require('./audioService');
    }
    return _audioService;
}

class VCReportService {
    constructor() {
        this.deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        this.deepSeekBaseUrl = 'https://api.deepseek.com/v1';
        this.maxTokens = parseInt(process.env.AI_MAX_TOKENS) || 4096;
        this.temperature = 0.3; // Lower temperature for analysis tasks
        this.sectionSummaryThreshold = parseInt(process.env.VC_SECTION_SUMMARY_THRESHOLD, 10) || 20000;
        this.sectionSummaryMax = parseInt(process.env.VC_SECTION_SUMMARY_MAX, 10) || 12;
        this.sectionSummaryChars = parseInt(process.env.VC_SECTION_SUMMARY_CHARS, 10) || 6000;
        this.chatTopK = parseInt(process.env.VC_REPORT_CHAT_TOPK, 10) || 5;
        this.chatMaxTopK = parseInt(process.env.VC_REPORT_CHAT_MAX_TOPK, 10) || 12;
        this.chatContextMaxChars = parseInt(process.env.VC_REPORT_CHAT_MAX_CONTEXT_CHARS, 10) || 12000;
        this.chatHistoryMaxChars = parseInt(process.env.VC_CHAT_HISTORY_MAX_CHARS, 10) || 2400;
        this.chatHistorySnippetChars = parseInt(process.env.VC_CHAT_HISTORY_SNIPPET_CHARS, 10) || 800;
        this.chatSummaryMaxChars = parseInt(process.env.VC_CHAT_SUMMARY_MAX_CHARS, 10) || 1200;
        this.chatKeyPointMaxChars = parseInt(process.env.VC_CHAT_KEY_POINT_MAX_CHARS, 10) || 240;
    }

    async _callDeepSeek(messages, { temperature = this.temperature, maxTokens = this.maxTokens } = {}) {
        const response = await axios.post(
            `${this.deepSeekBaseUrl}/chat/completions`,
            {
                model: 'deepseek-chat',
                messages,
                max_tokens: maxTokens,
                temperature
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.deepSeekApiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            }
        );

        return response.data.choices[0]?.message?.content || '';
    }

    _normalizeLine(line) {
        return String(line || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _normalizeVoiceOption(voice) {
        const cleaned = String(voice || '').trim();
        if (!cleaned) return null;
        if (!/^[A-Za-z0-9_.-]+$/.test(cleaned)) return null;
        return cleaned.slice(0, 64);
    }

    _isAppendixHeading(line) {
        return /^(APPENDIX|APPENDICES|ANNEX|ANNEXURE|ATTACHMENT|SCHEDULE|APPENDICE|APPENDIXES)\b/i.test(line);
    }

    _isHeading(line) {
        const trimmed = this._normalizeLine(line);
        if (!trimmed || trimmed.length < 3 || trimmed.length > 120) return false;
        if (/^\d+$/.test(trimmed)) return false;

        const patterns = [
            /^(CHAPTER|PART|SECTION|ARTICLE|SCHEDULE)\s+[IVXLCDM\d]+/i,
            /^(EXECUTIVE SUMMARY|SUMMARY|HIGHLIGHTS|KEY POINTS|RECOMMENDATIONS|CONCERNS|FINDINGS|BACKGROUND|INTRODUCTION|CONCLUSION|APPENDIX|ANNEX|ATTACHMENT)\b/i,
            /^[A-Z][A-Z\s,]{8,80}$/,
            /^\d+(\.\d+)*\s+[A-Z]/
        ];

        return patterns.some((pattern) => pattern.test(trimmed));
    }

    _splitTextIntoSections(text) {
        const lines = String(text || '').split('\n');
        const sections = [];
        let current = { title: 'Report', content: '', isAppendix: false };

        for (const line of lines) {
            const trimmed = this._normalizeLine(line);
            if (!trimmed) continue;

            if (this._isHeading(trimmed)) {
                if (current.content.trim().length > 0) {
                    sections.push({ ...current, content: current.content.trim() });
                }
                current = {
                    title: trimmed,
                    content: '',
                    isAppendix: this._isAppendixHeading(trimmed)
                };
            } else {
                current.content += `${trimmed}\n`;
            }
        }

        if (current.content.trim().length > 0) {
            sections.push({ ...current, content: current.content.trim() });
        }

        if (sections.length === 0) {
            const normalized = String(text || '').trim();
            if (normalized.length > this.sectionSummaryThreshold) {
                return this._splitIntoPseudoSections(normalized, 'Report');
            }
            return [{ title: 'Report', content: normalized, isAppendix: false }];
        }

        const normalized = String(text || '').trim();
        if (sections.length === 1 && normalized.length > this.sectionSummaryThreshold) {
            return this._splitIntoPseudoSections(normalized, sections[0].title || 'Report');
        }

        return sections;
    }

    _splitIntoPseudoSections(text, baseTitle) {
        const normalized = String(text || '').trim();
        const segmentSize = Math.max(2000, Math.min(this.sectionSummaryChars, 8000));
        const sections = [];
        let index = 0;

        for (let start = 0; start < normalized.length; start += segmentSize) {
            const slice = normalized.slice(start, start + segmentSize).trim();
            if (!slice) continue;
            sections.push({
                title: `${baseTitle} (Part ${index + 1})`,
                content: slice,
                isAppendix: false
            });
            index += 1;
        }

        return sections.length > 0
            ? sections
            : [{ title: baseTitle || 'Report', content: normalized, isAppendix: false }];
    }

    _groupSections(sections, maxSections) {
        if (sections.length <= maxSections) return sections;

        const groupSize = Math.ceil(sections.length / maxSections);
        const grouped = [];

        for (let i = 0; i < sections.length; i += groupSize) {
            const slice = sections.slice(i, i + groupSize);
            const titleParts = slice.map(s => s.title).filter(Boolean);
            const title = titleParts.length > 0
                ? `${titleParts[0]}${titleParts.length > 1 ? ' - ' + titleParts[titleParts.length - 1] : ''}`
                : `Section ${grouped.length + 1}`;
            const content = slice.map(s => s.content).join('\n\n');
            const isAppendix = slice.every(s => s.isAppendix);
            grouped.push({ title, content, isAppendix });
        }

        return grouped;
    }

    async _summarizeSections(sections, report) {
        const nonAppendix = sections.filter(s => !s.isAppendix);
        const usableSections = nonAppendix.length > 0 ? nonAppendix : sections;
        const grouped = this._groupSections(usableSections, this.sectionSummaryMax);

        const summaries = [];
        for (let i = 0; i < grouped.length; i++) {
            const section = grouped[i];
            const sectionText = section.content.slice(0, this.sectionSummaryChars);
            const prompt = `Summarize this section from a report submitted to the Vice Chancellor of Bayelsa Medical University.

Report Title: ${report.title}
Section: ${section.title}

SECTION CONTENT:
${sectionText}

Provide a concise 2-4 sentence summary focusing on decisions, obligations, risks, and key facts.`;

            const content = await this._callDeepSeek([
                { role: 'system', content: 'You summarize report sections clearly and concisely.' },
                { role: 'user', content: prompt }
            ], { temperature: 0.2, maxTokens: Math.min(this.maxTokens, 700) });

            const clean = String(content || '').trim();
            summaries.push(`Section ${i + 1}: ${clean || 'Summary unavailable.'}`);
        }

        return summaries;
    }

    _parseAnalysis(content, fallbackSummary) {
        let analysis;
        try {
            const jsonMatch = String(content || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                analysis = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON found in response');
            }
        } catch (parseError) {
            console.error('[VCReportService] Failed to parse AI response:', parseError);
            analysis = {
                summary: fallbackSummary || 'Analysis could not be generated. Please review the report manually.',
                keyPoints: [],
                highlights: [],
                concerns: [],
                recommendations: [],
                sentiment: 'neutral'
            };
        }

        return {
            summary: analysis.summary || fallbackSummary || 'No summary available',
            keyPoints: Array.isArray(analysis.keyPoints) ? analysis.keyPoints.slice(0, 5) : [],
            highlights: Array.isArray(analysis.highlights) ? analysis.highlights.slice(0, 3) : [],
            concerns: Array.isArray(analysis.concerns) ? analysis.concerns.slice(0, 3) : [],
            recommendations: Array.isArray(analysis.recommendations) ? analysis.recommendations.slice(0, 3) : [],
            sentiment: ['positive', 'negative', 'neutral', 'mixed'].includes(analysis.sentiment)
                ? analysis.sentiment
                : 'neutral'
        };
    }

    _truncateText(text, maxChars) {
        if (!text) return '';
        const normalized = String(text).replace(/\s+/g, ' ').trim();
        if (!maxChars || normalized.length <= maxChars) return normalized;
        return `${normalized.substring(0, maxChars - 12).trim()}... [truncated]`;
    }

    _trimToMaxChars(text, maxChars) {
        if (!text) return '';
        const normalized = String(text).trim();
        if (!maxChars || normalized.length <= maxChars) return normalized;
        return `${normalized.substring(0, maxChars - 12).trim()}... [truncated]`;
    }

    _safeParseJsonArray(raw) {
        if (!raw) return [];
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    _formatKeyPoints(rawPoints) {
        const points = this._safeParseJsonArray(rawPoints)
            .filter(Boolean)
            .slice(0, 5)
            .map(point => this._truncateText(point, this.chatKeyPointMaxChars))
            .filter(Boolean);

        if (!points.length) return 'Not available';
        return points.map((point, idx) => `${idx + 1}. ${point}`).join('\n');
    }

    _trimHistory(history) {
        const perMessage = this.chatHistorySnippetChars;
        const maxTotal = this.chatHistoryMaxChars;
        if (!Array.isArray(history) || history.length === 0) return [];

        let total = 0;
        const trimmed = [];

        for (let i = history.length - 1; i >= 0; i--) {
            const msg = history[i];
            const content = this._truncateText(msg.content, perMessage);
            if (!content) continue;
            if (trimmed.length > 0 && total + content.length > maxTotal) break;
            trimmed.push({ role: msg.role, content });
            total += content.length;
            if (total >= maxTotal) break;
        }

        return trimmed.reverse();
    }

    _extractKeywords(query) {
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

        return String(query || '')
            .toLowerCase()
            .split(/\s+/)
            .map(word => word.replace(/[^\w-]/g, ''))
            .filter(word => word.length > 2 && !stopWords.has(word))
            .slice(0, 10);
    }

    /**
     * Process a report - extract text, chunk, generate embeddings, and analyze
     */
    async processReport(reportId) {
        const report = await VCReport.findById(reportId);
        if (!report) {
            throw new Error('Report not found');
        }

        try {
            // Update status to processing
            await VCReport.updateProcessingStatus(reportId, 'processing');

            // Get document processor
            const processor = getDocumentProcessor();

            // Extract text from document
            console.log(`[VCReportService] Extracting text from: ${report.file_path}`);
            const extractedText = await processor.extractText(report.file_path, report.file_type);

            if (!extractedText || extractedText.length < 50) {
                throw new Error('Failed to extract text from document');
            }

            // Chunk the content
            const chunks = await processor.chunkText(extractedText, 1000, 200);

            console.log(`[VCReportService] Created ${chunks.length} chunks for report ${reportId}`);

            // Generate embeddings for each chunk
            const aiService = getAIService();
            const chunksWithEmbeddings = [];

            for (let i = 0; i < chunks.length; i++) {
                try {
                    const embedding = await aiService.generateEmbedding(chunks[i]);
                    chunksWithEmbeddings.push({
                        chunkIndex: i,
                        content: chunks[i],
                        embedding
                    });
                } catch (embedError) {
                    console.error(`[VCReportService] Embedding error for chunk ${i}:`, embedError.message);
                    chunksWithEmbeddings.push({
                        chunkIndex: i,
                        content: chunks[i],
                        embedding: []
                    });
                }
            }

            // Delete old chunks and insert new ones
            await VCReportChunk.deleteByReportId(reportId);
            await VCReportChunk.insertChunks(reportId, chunksWithEmbeddings);

            // Generate AI analysis
            console.log(`[VCReportService] Generating AI analysis for report ${reportId}`);
            const analysis = await this.analyzeReport(reportId, extractedText);

            // Save analysis
            await VCReport.saveAnalysis(reportId, analysis);

            // Update status to completed
            await VCReport.updateProcessingStatus(reportId, 'completed', chunks.length);

            console.log(`[VCReportService] Successfully processed report ${reportId}`);
            return { success: true, chunks: chunks.length, analysis };

        } catch (error) {
            console.error(`[VCReportService] Error processing report ${reportId}:`, error);
            await VCReport.updateProcessingStatus(reportId, 'failed');
            throw error;
        }
    }

    /**
     * Analyze report content using AI
     */
    async analyzeReport(reportId, fullText) {
        const report = await VCReport.findById(reportId);
        const sections = this._splitTextIntoSections(fullText);
        const maxTextLength = 15000;
        const useHierarchical = fullText.length > this.sectionSummaryThreshold && sections.length > 1;
        let analysisInput = '';
        let inputLabel = 'REPORT CONTENT';

        const categoryLabels = {
            'academic_affairs': 'Academic Affairs',
            'administrative': 'Administrative',
            'financial': 'Financial',
            'security': 'Security',
            'student_affairs': 'Student Affairs',
            'staff_welfare': 'Staff Welfare',
            'senate': 'Senate',
            'infrastructure': 'Infrastructure',
            'research': 'Research',
            'community_service': 'Community Service',
            'compliance_audit': 'Compliance & Audit',
            'strategic_planning': 'Strategic Planning',
            'other': 'Other'
        };

        const buildCondensedText = () => {
            const nonAppendix = sections.filter(s => !s.isAppendix);
            const usableSections = nonAppendix.length > 0 ? nonAppendix : sections;
            const combined = usableSections
                .map(section => `${section.title}\n${section.content}`.trim())
                .join('\n\n');
            return combined.length > maxTextLength
                ? combined.substring(0, maxTextLength) + '\n\n[Content truncated for analysis...]'
                : combined;
        };

        if (useHierarchical) {
            try {
                const sectionSummaries = await this._summarizeSections(sections, report);
                if (sectionSummaries.length > 0) {
                    analysisInput = sectionSummaries.join('\n\n');
                    inputLabel = 'SECTION SUMMARIES';
                }
            } catch (error) {
                console.warn('[VCReportService] Section summaries failed, using condensed text:', error.message);
            }
        }

        if (!analysisInput) {
            analysisInput = buildCondensedText();
        }

        const prompt = `You are an executive assistant analyzing a report submitted to the Vice Chancellor of Bayelsa Medical University.

Report Title: ${report.title}
Category: ${categoryLabels[report.category] || report.category}
Submitted by: ${report.submitted_by_name || 'Unknown'}
Department: ${report.department || 'Not specified'}
Date: ${report.report_date || report.submitted_at}

${inputLabel}:
${analysisInput}

Analyze this report and provide a structured analysis in the following JSON format (respond ONLY with valid JSON):
{
    "summary": "A concise 2-3 sentence executive summary of the report",
    "keyPoints": [
        "Key point 1",
        "Key point 2",
        "Key point 3"
    ],
    "highlights": [
        "Positive achievement or development 1",
        "Positive achievement or development 2"
    ],
    "concerns": [
        "Issue or concern that needs attention 1",
        "Issue or concern that needs attention 2"
    ],
    "recommendations": [
        "Recommended action 1",
        "Recommended action 2"
    ],
    "sentiment": "positive|neutral|negative|mixed"
}

Guidelines:
- keyPoints: Extract 3-5 most important facts or findings
- highlights: Extract positive news, achievements, or successes (1-3 items)
- concerns: Extract problems, challenges, or issues requiring attention (0-3 items, can be empty array if none)
- recommendations: Suggest 1-3 actionable recommendations based on the report
- sentiment: Overall sentiment - "positive" if mostly good news, "negative" if mostly problems, "mixed" if both, "neutral" if factual/routine`;

        try {
            const content = await this._callDeepSeek([
                { role: 'system', content: 'You are an executive assistant that analyzes reports and provides structured JSON responses. Always respond with valid JSON only.' },
                { role: 'user', content: prompt }
            ]);

            return this._parseAnalysis(content, 'No summary available');

        } catch (error) {
            console.error('[VCReportService] AI analysis error:', error.message);
            return {
                summary: 'Analysis failed. Please try again later.',
                keyPoints: [],
                highlights: [],
                concerns: [],
                recommendations: [],
                sentiment: 'neutral'
            };
        }
    }

    /**
     * Re-analyze a report
     */
    async reanalyzeReport(reportId) {
        const fullText = await VCReportChunk.getFullText(reportId);
        if (!fullText) {
            throw new Error('Report has no content to analyze');
        }

        const analysis = await this.analyzeReport(reportId, fullText);
        await VCReport.saveAnalysis(reportId, analysis);
        return analysis;
    }

    // ========== CHAT FUNCTIONALITY ==========

    /**
     * Create a new chat session for a report
     */
    async createChatSession(reportId, userId) {
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const report = await VCReport.findById(reportId);
        
        const sql = `
            INSERT INTO vc_report_chat_sessions 
            (report_id, user_id, session_token, title, created_at) 
            VALUES (?, ?, ?, ?, NOW())
        `;
        
        const result = await query(sql, [
            reportId, 
            userId, 
            sessionToken, 
            `Chat about: ${report?.title || 'Report'}`
        ]);

        return {
            sessionId: result.insertId,
            sessionToken,
            reportId,
            title: `Chat about: ${report?.title || 'Report'}`
        };
    }

    /**
     * Get chat sessions for a report
     */
    async getChatSessions(reportId, userId) {
        const sql = `
            SELECT id, report_id, session_token, title, created_at, updated_at
            FROM vc_report_chat_sessions
            WHERE report_id = ? AND user_id = ?
            ORDER BY updated_at DESC
        `;
        return query(sql, [reportId, userId]);
    }

    /**
     * Get chat history for a session
     */
    async getChatHistory(sessionToken) {
        const sql = `
            SELECT m.id, m.role, m.content, m.audio_url, m.created_at
            FROM vc_report_chat_messages m
            JOIN vc_report_chat_sessions s ON m.session_id = s.id
            WHERE s.session_token = ?
            ORDER BY m.created_at ASC
        `;
        return query(sql, [sessionToken]);
    }

    /**
     * Chat with a report
     */
    async chat(sessionToken, userMessage, userId, options = {}) {
        // Get session
        const sessionResult = await query(
            'SELECT * FROM vc_report_chat_sessions WHERE session_token = ?',
            [sessionToken]
        );
        
        if (!sessionResult[0]) {
            throw new Error('Chat session not found');
        }

        const session = sessionResult[0];
        const report = await VCReport.findById(session.report_id);

        if (!report) {
            throw new Error('Report not found');
        }

        const normalizedVoice = this._normalizeVoiceOption(options.voice);
        const wantsAudio = options.withAudio === true;

        // Save user message
        await query(
            'INSERT INTO vc_report_chat_messages (session_id, role, content, audio_url, created_at) VALUES (?, ?, ?, ?, NOW())',
            [session.id, 'user', userMessage, null]
        );

        // Get chat history for context
        const history = await this.getChatHistory(sessionToken);
        const recentHistory = this._trimHistory(history);

        // Get relevant chunks from the report
        const relevantContentRaw = await this._getRelevantContent(session.report_id, userMessage);
        const relevantContent = this._trimToMaxChars(relevantContentRaw, this.chatContextMaxChars);

        const summary = this._truncateText(report.ai_summary || 'Not available', this.chatSummaryMaxChars);
        const keyPoints = this._formatKeyPoints(report.ai_key_points);

        // Build messages for AI
        const messages = [
            {
                role: 'system',
                content: `You are an intelligent assistant helping the Vice Chancellor analyze and understand a report.

Report Title: ${report.title}
Category: ${report.category}
Submitted by: ${report.submitted_by_name || 'Unknown'}
Department: ${report.department || 'Not specified'}

AI Summary: ${summary}

Key Points:
${keyPoints}

RELEVANT REPORT EXCERPTS:
${relevantContent}

Instructions:
1. Answer questions based on the report content provided
2. If asked about specific details, quote from the report excerpts
3. Be concise but thorough
4. If the information is not in the report, say so clearly
5. Provide actionable insights when appropriate`
            }
        ];

        // Add conversation history
        for (const msg of recentHistory) {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        }

        // Add current user message
        messages.push({ role: 'user', content: userMessage });

        try {
            const response = await axios.post(
                `${this.deepSeekBaseUrl}/chat/completions`,
                {
                    model: 'deepseek-chat',
                    messages,
                    max_tokens: this.maxTokens,
                    temperature: 0.5
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.deepSeekApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );

            const assistantMessage = response.data.choices[0]?.message?.content || 
                'I apologize, but I could not generate a response. Please try again.';

            let audioUrl = null;
            const enableVoice = process.env.ENABLE_VOICE_RESPONSES === 'true';
            if (enableVoice && wantsAudio) {
                const ttsResult = await getAudioService().generateAudioResponse(assistantMessage, {
                    voice: normalizedVoice || undefined
                });
                if (ttsResult.success) {
                    audioUrl = ttsResult.audioUrl;
                }
            }

            // Save assistant response
            await query(
                'INSERT INTO vc_report_chat_messages (session_id, role, content, audio_url, created_at) VALUES (?, ?, ?, ?, NOW())',
                [session.id, 'assistant', assistantMessage, audioUrl]
            );

            // Update session timestamp
            await query(
                'UPDATE vc_report_chat_sessions SET updated_at = NOW() WHERE id = ?',
                [session.id]
            );

            return {
                message: assistantMessage,
                audioUrl,
                sessionToken,
                reportId: session.report_id
            };

        } catch (error) {
            console.error('[VCReportService] Chat error:', error.message);
            throw new Error('Failed to generate response. Please try again.');
        }
    }

    /**
     * Get relevant content from report chunks for a query
     */
    _getDynamicTopK(query, totalChunks) {
        const base = this.chatTopK;
        const max = this.chatMaxTopK;
        const qLen = String(query || '').trim().length;
        let topK = base;

        if (qLen > 120) topK += 1;
        if (qLen > 240) topK += 2;
        if (qLen > 360) topK += 2;

        if (totalChunks > 80) topK += 1;
        if (totalChunks > 160) topK += 2;
        if (totalChunks > 300) topK += 2;

        topK = Math.min(max, Math.max(base, topK));
        return totalChunks ? Math.min(topK, totalChunks) : topK;
    }

    async _getRelevantContent(reportId, query) {
        const aiService = getAIService();
        const keywords = this._extractKeywords(query);
        const phrase = String(query || '').trim().toLowerCase();
        
        // Get all chunks with embeddings
        const chunks = await VCReportChunk.getChunksWithEmbeddings(reportId);
        
        if (!chunks || chunks.length === 0) {
            // Fallback to first few chunks
            const allChunks = await VCReportChunk.getContentByReportId(reportId);
            const content = allChunks.slice(0, this.chatTopK).map(c => c.content).join('\n\n---\n\n');
            return this._trimToMaxChars(content, this.chatContextMaxChars);
        }

        // Generate query embedding
        try {
            const queryEmbedding = await aiService.generateEmbedding(query);

            const topK = this._getDynamicTopK(query, chunks.length);
            const totalChunks = chunks.length || 1;
            
            // Calculate hybrid scores (semantic + keyword + phrase)
            const scored = chunks.map(chunk => {
                const content = String(chunk.content || '');
                const contentLower = content.toLowerCase();
                const similarity = this._cosineSimilarity(queryEmbedding, chunk.embedding || []);
                const keywordMatches = keywords.filter(k => contentLower.includes(k)).length;
                const keywordScore = keywords.length ? keywordMatches / keywords.length : 0;
                const phraseScore = phrase.length > 4 && contentLower.includes(phrase) ? 1 : 0;
                const chunkIndex = Number(chunk.chunk_index ?? chunk.chunkIndex ?? 0);
                const positionBoost = (1 - Math.min(chunkIndex / totalChunks, 1)) * 0.05;
                const score = (similarity * 0.65) + (keywordScore * 0.25) + (phraseScore * 0.1) + positionBoost;
                return { ...chunk, score };
            });

            // Sort by hybrid score and take top results
            scored.sort((a, b) => b.score - a.score);
            const topChunks = scored.slice(0, topK);

            const content = topChunks.map(c => c.content).join('\n\n---\n\n');
            return this._trimToMaxChars(content, this.chatContextMaxChars);

        } catch (error) {
            console.error('[VCReportService] Error getting relevant content:', error);
            if (chunks && chunks.length > 0 && keywords.length > 0) {
                const scored = chunks.map(chunk => {
                    const content = String(chunk.content || '');
                    const contentLower = content.toLowerCase();
                    const keywordMatches = keywords.filter(k => contentLower.includes(k)).length;
                    const keywordScore = keywordMatches / keywords.length;
                    const phraseScore = phrase.length > 4 && contentLower.includes(phrase) ? 1 : 0;
                    const score = (keywordScore * 0.7) + (phraseScore * 0.3);
                    return { ...chunk, score };
                });
                scored.sort((a, b) => b.score - a.score);
                const fallbackChunks = scored.slice(0, this.chatTopK);
                const content = fallbackChunks.map(c => c.content).join('\n\n---\n\n');
                return this._trimToMaxChars(content, this.chatContextMaxChars);
            }

            // Fallback to keyword search
            const fallbackTerm = keywords[0] || query.split(' ')[0] || '';
            const keywordResults = fallbackTerm
                ? await VCReportChunk.searchByContent(reportId, fallbackTerm, this.chatTopK)
                : [];
            if (keywordResults.length > 0) {
                const content = keywordResults.map(c => c.content).join('\n\n---\n\n');
                return this._trimToMaxChars(content, this.chatContextMaxChars);
            }
            // Ultimate fallback
            const allChunks = await VCReportChunk.getContentByReportId(reportId);
            const content = allChunks.slice(0, this.chatTopK).map(c => c.content).join('\n\n---\n\n');
            return this._trimToMaxChars(content, this.chatContextMaxChars);
        }
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
        if (vecA.length !== vecB.length) return 0;

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

    // ========== NOTES FUNCTIONALITY ==========

    /**
     * Add a note to a report
     */
    async addNote(reportId, userId, noteText) {
        const sql = `
            INSERT INTO vc_report_notes (report_id, user_id, note_text, created_at)
            VALUES (?, ?, ?, NOW())
        `;
        const result = await query(sql, [reportId, userId, noteText]);
        return result.insertId;
    }

    /**
     * Get notes for a report
     */
    async getNotes(reportId, userId) {
        const sql = `
            SELECT n.*, u.first_name, u.last_name
            FROM vc_report_notes n
            JOIN users u ON n.user_id = u.id
            WHERE n.report_id = ? AND n.user_id = ?
            ORDER BY n.created_at DESC
        `;
        return query(sql, [reportId, userId]);
    }

    /**
     * Update a note
     */
    async updateNote(noteId, userId, noteText) {
        const sql = `
            UPDATE vc_report_notes 
            SET note_text = ?, updated_at = NOW() 
            WHERE id = ? AND user_id = ?
        `;
        const result = await query(sql, [noteText, noteId, userId]);
        return result.affectedRows > 0;
    }

    /**
     * Delete a note
     */
    async deleteNote(noteId, userId) {
        const sql = 'DELETE FROM vc_report_notes WHERE id = ? AND user_id = ?';
        const result = await query(sql, [noteId, userId]);
        return result.affectedRows > 0;
    }

    // ========== SEARCH FUNCTIONALITY ==========

    /**
     * Search across all reports
     */
    async searchReports(searchQuery, userId, options = {}) {
        const { category, limit = 20 } = options;
        
        let whereClause = 'WHERE r.is_active = TRUE AND r.is_archived = FALSE';
        const params = [];

        // Search in title, description, summary
        whereClause += ' AND (r.title LIKE ? OR r.description LIKE ? OR r.ai_summary LIKE ?)';
        const searchTerm = `%${searchQuery}%`;
        params.push(searchTerm, searchTerm, searchTerm);

        if (category) {
            whereClause += ' AND r.category = ?';
            params.push(category);
        }

        const sql = `
            SELECT r.id, r.title, r.category, r.ai_summary, r.submitted_at,
                   CONCAT(u.first_name, ' ', u.last_name) as submitted_by_name
            FROM vc_reports r
            LEFT JOIN users u ON r.submitted_by = u.id
            ${whereClause}
            ORDER BY r.submitted_at DESC
            LIMIT ?
        `;
        params.push(limit);

        return query(sql, params);
    }

    /**
     * Semantic search across all report chunks
     */
    async semanticSearch(searchQuery, options = {}) {
        const { limit = 10, category } = options;
        const aiService = getAIService();

        try {
            // Generate query embedding
            const queryEmbedding = await aiService.generateEmbedding(searchQuery);

            // Get all chunks with embeddings
            const allChunks = await VCReportChunk.getAllChunksWithEmbeddings();

            // Filter by category if specified
            let chunks = allChunks;
            if (category) {
                chunks = allChunks.filter(c => c.report_category === category);
            }

            // Score and rank
            const scored = chunks.map(chunk => {
                const similarity = this._cosineSimilarity(queryEmbedding, chunk.embedding || []);
                return { ...chunk, similarity };
            });

            scored.sort((a, b) => b.similarity - a.similarity);

            // Group by report and take top results
            const seenReports = new Set();
            const results = [];

            for (const chunk of scored) {
                if (results.length >= limit) break;
                
                if (!seenReports.has(chunk.report_id)) {
                    seenReports.add(chunk.report_id);
                    results.push({
                        reportId: chunk.report_id,
                        reportTitle: chunk.report_title,
                        category: chunk.report_category,
                        excerpt: chunk.content.substring(0, 300) + '...',
                        similarity: chunk.similarity
                    });
                }
            }

            return results;

        } catch (error) {
            console.error('[VCReportService] Semantic search error:', error);
            // Fallback to regular search
            return this.searchReports(searchQuery, null, options);
        }
    }
}

// Export singleton
module.exports = new VCReportService();
