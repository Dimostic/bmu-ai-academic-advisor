const fs = require('fs').promises;
const path = require('path');
const { query } = require('../../config/db');
const documentProcessor = require('./documentProcessor');

const DEFAULT_AUTHORITY = 50;
let schemaEnsured = false;

const CATEGORY_RULES = [
    { category: 'quick_facts', tags: ['quick facts', 'profile'], patterns: [/quick facts/i, /brief profile/i, /about bmu/i] },
    { category: 'fees', tags: ['fees', 'tuition', 'payments'], patterns: [/fee/i, /tuition/i, /payment/i, /charges/i] },
    { category: 'academic_calendar', tags: ['calendar', 'session', 'dates'], patterns: [/academic calendar/i, /semester/i, /session/i] },
    { category: 'student_handbook', tags: ['handbook', 'student policy'], patterns: [/handbook/i, /student regulations/i, /student affairs/i] },
    { category: 'programmes', tags: ['programmes', 'courses', 'curriculum'], patterns: [/programme/i, /program\b/i, /course/i, /curriculum/i, /faculty/i, /college/i] },
    { category: 'regulatory', tags: ['ccmas', 'regulatory', 'guidelines'], patterns: [/ccmas/i, /mdcn/i, /nuc/i, /minimum academic standards/i] },
    { category: 'law', tags: ['law', 'act', 'governance'], patterns: [/law/i, /act/i, /statute/i] },
    { category: 'health_services', tags: ['health centre', 'clinic', 'medical services'], patterns: [/health centre/i, /clinic/i, /medical services/i] }
];

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function round(n, places = 1) {
    const factor = 10 ** places;
    return Math.round(n * factor) / factor;
}

function scoreTextDensity(textChars, fileSize) {
    if (!fileSize) return textChars >= 500 ? 75 : 15;
    const mb = fileSize / (1024 * 1024);
    const charsPerMb = mb > 0 ? textChars / mb : textChars;
    if (textChars < 300) return 10;
    if (charsPerMb < 1200) return 30;
    if (charsPerMb < 5000) return 58;
    if (charsPerMb < 15000) return 76;
    return 92;
}

function countMatches(text, regex) {
    return (text.match(regex) || []).length;
}

function detectCategory(title, text) {
    const haystack = `${title || ''}\n${String(text || '').slice(0, 30000)}`;
    const scored = CATEGORY_RULES.map(rule => {
        const hits = rule.patterns.reduce((sum, pattern) => sum + countMatches(haystack, pattern), 0);
        return { ...rule, hits };
    }).filter(rule => rule.hits > 0).sort((a, b) => b.hits - a.hits);

    if (!scored.length) {
        return { category: 'general', confidence: 35, tags: [] };
    }

    const top = scored[0];
    const totalHits = scored.reduce((sum, rule) => sum + rule.hits, 0);
    return {
        category: top.category,
        confidence: clamp(55 + (top.hits / Math.max(totalHits, 1)) * 35, 55, 95),
        tags: Array.from(new Set(scored.slice(0, 3).flatMap(rule => rule.tags)))
    };
}

function suggestAuthority(title, category) {
    const t = String(title || '').toLowerCase();
    if (/quick facts|brief profile|fee|tuition|academic calendar|student courses/.test(t)) {
        return { rank: 95, label: 'BMU canonical' };
    }
    if (/student.*handbook|handbook.*student/.test(t)) {
        return { rank: 90, label: 'BMU handbook' };
    }
    if (/bmu law|health centre|college of medicine|prospectus/.test(t) || ['law', 'health_services'].includes(category)) {
        return { rank: 85, label: 'BMU official' };
    }
    if (/ccmas|mdcn|nuc|guideline/.test(t) || category === 'regulatory') {
        return { rank: 75, label: 'External regulator' };
    }
    if (/career prospect/.test(t)) {
        return { rank: 55, label: 'Reference' };
    }
    return { rank: DEFAULT_AUTHORITY, label: 'Standard' };
}

function buildDecision(overall, metrics, warnings) {
    if (metrics.textChars < 300) return 'reject';
    if (metrics.estimatedChunks > 1200) return 'needs_splitting';
    if (warnings.some(w => /OCR|low text density|little readable text/i.test(w))) return 'needs_cleanup';
    if (overall >= 78) return 'ready';
    if (overall >= 58) return 'ready_with_warnings';
    return 'needs_cleanup';
}

class DocumentQualityService {
    async ensureSchema() {
        if (schemaEnsured) return true;

        const columns = [
            ['ai_review_status', "ALTER TABLE documents ADD COLUMN ai_review_status VARCHAR(32) NOT NULL DEFAULT 'not_reviewed'"],
            ['ai_review_score', 'ALTER TABLE documents ADD COLUMN ai_review_score DECIMAL(5,2) NULL'],
            ['ai_review_json', 'ALTER TABLE documents ADD COLUMN ai_review_json LONGTEXT NULL'],
            ['authority_rank', `ALTER TABLE documents ADD COLUMN authority_rank INT NOT NULL DEFAULT ${DEFAULT_AUTHORITY}`],
            ['authority_label', "ALTER TABLE documents ADD COLUMN authority_label VARCHAR(80) NOT NULL DEFAULT 'Standard'"]
        ];

        for (const [name, statement] of columns) {
            try {
                await query(statement);
            } catch (error) {
                if (!/duplicate column|already exists/i.test(error.message || '')) {
                    console.warn(`[DocumentQuality] Could not add documents.${name}:`, error.message);
                }
            }
        }

        schemaEnsured = true;
        return true;
    }

    async reviewFile(filePath, options = {}) {
        const title = options.title || path.basename(filePath || '');
        const fileSize = Number(options.fileSize || 0);
        const fileType = String(options.fileType || path.extname(filePath || '')).replace(/^\./, '').toLowerCase();
        const warnings = [];
        const recommendations = [];

        let rawText = '';
        if (typeof options.rawText === 'string') {
            rawText = options.rawText;
        } else {
            try {
                rawText = await documentProcessor.extractText(filePath);
            } catch (error) {
                warnings.push(`Text extraction failed: ${error.message}`);
            }
        }

        const text = String(rawText || '').trim();
        const textChars = text.length;
        const nonWhitespaceChars = text.replace(/\s/g, '').length;
        const mb = fileSize > 0 ? fileSize / (1024 * 1024) : 0;
        const charsPerMb = mb > 0 ? textChars / mb : textChars;
        const lineCount = text ? text.split(/\r?\n/).length : 0;
        const headingCount = countMatches(text, /(^|\n)\s*(#{1,4}\s+|[A-Z][A-Z0-9 ,.'’&()/:-]{8,}|chapter\s+\d+|section\s+\d+)/gim);
        const tableSignals = countMatches(text, /\t|\|{1,}| {3,}\S/g);
        const longLineCount = text.split(/\r?\n/).filter(line => line.length > 240).length;
        const chunkSize = parseInt(process.env.RAG_CHUNK_SIZE || process.env.CHUNK_SIZE || '1000', 10);
        const chunkOverlap = parseInt(process.env.RAG_CHUNK_OVERLAP || process.env.CHUNK_OVERLAP || '150', 10);
        const estimatedChunks = textChars > 0 ? Math.ceil(textChars / Math.max(chunkSize - chunkOverlap, 400)) : 0;

        if (!textChars) warnings.push('No readable text was extracted.');
        if (textChars > 0 && textChars < 500) warnings.push('Very little readable text was extracted.');
        if (fileType === 'pdf' && fileSize > 5 * 1024 * 1024 && charsPerMb < 2500) {
            warnings.push('Low text density for a large PDF; scanned pages or image-heavy layout may need OCR cleanup.');
        }
        if (estimatedChunks > 1200) warnings.push('Document is very long and should be split into focused parts before ingestion.');
        else if (estimatedChunks > 500) warnings.push('Document is long; consider splitting by college, faculty, programme, or policy section.');
        if (lineCount > 0 && longLineCount / lineCount > 0.2) {
            warnings.push('Many long lines detected; table-like content may lose meaning unless converted to clean tables or Markdown.');
        }
        if (headingCount < 3 && textChars > 5000) {
            warnings.push('Few clear headings detected; chunking may mix unrelated topics.');
        }

        const category = detectCategory(title, text);
        const authority = suggestAuthority(title, category.category);

        const extractionScore = scoreTextDensity(textChars, fileSize);
        const structureScore = clamp(35 + Math.min(headingCount, 30) * 1.6 + Math.min(tableSignals, 40) * 0.45 - Math.min(longLineCount, 40) * 0.8, 20, 95);
        const categoryScore = category.confidence;
        const embeddingScore = clamp(95 - Math.max(0, estimatedChunks - 250) * 0.04 - Math.max(0, estimatedChunks - 900) * 0.08, 35, 95);
        const authorityScore = clamp(authority.rank, 25, 100);
        const overall = round(
            extractionScore * 0.34 +
            structureScore * 0.18 +
            categoryScore * 0.16 +
            embeddingScore * 0.22 +
            authorityScore * 0.10,
            1
        );
        const decision = buildDecision(overall, { textChars, estimatedChunks }, warnings);

        if (decision === 'ready') recommendations.push('Ready for ingestion.');
        if (decision === 'ready_with_warnings') recommendations.push('Ingestible, but review warnings before relying on fine details.');
        if (decision === 'needs_cleanup') recommendations.push('Clean source formatting or OCR output, then rerun review before processing.');
        if (decision === 'needs_splitting') recommendations.push('Split into smaller files with explicit titles and section headings.');
        if (decision === 'reject') recommendations.push('Replace with a text-readable document or OCR the source first.');
        if (category.category === 'general') recommendations.push('Add a specific category and descriptive tags so retrieval can route questions better.');
        if (authority.rank < 70) recommendations.push('Consider assigning a higher authority rank only if this is an official BMU source.');

        return {
            status: decision,
            score: overall,
            file: { title, fileType, fileSize },
            metrics: {
                textChars,
                nonWhitespaceChars,
                charsPerMb: round(charsPerMb, 1),
                lineCount,
                headingCount,
                tableSignals,
                longLineCount,
                estimatedChunks,
                chunkSize,
                chunkOverlap
            },
            scores: {
                extraction: round(extractionScore, 1),
                structure: round(structureScore, 1),
                categorization: round(categoryScore, 1),
                embedding: round(embeddingScore, 1),
                authority: round(authorityScore, 1)
            },
            suggestedCategory: category.category,
            suggestedTags: category.tags,
            suggestedAuthorityRank: authority.rank,
            suggestedAuthorityLabel: authority.label,
            warnings,
            recommendations,
            preview: text.slice(0, 1000)
        };
    }

    async reviewDocument(documentId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM documents WHERE id = ? AND is_active = TRUE', [documentId]);
        const doc = rows?.[0];
        if (!doc) throw new Error('Document not found');

        let review;
        if (doc.content_text && String(doc.content_text).trim().length > 300) {
            review = await this.reviewText(doc.content_text, {
                title: doc.title || doc.file_name,
                fileType: doc.file_type,
                fileSize: doc.file_size
            });
            review.reviewBasis = 'stored_extracted_text';
            review.recommendations = [
                'Reviewed from the text currently stored for AI retrieval.',
                ...(review.recommendations || [])
            ];
        } else if (doc.file_path) {
            try {
                await fs.access(doc.file_path);
                review = await this.reviewFile(doc.file_path, {
                    title: doc.title || doc.file_name,
                    fileType: doc.file_type,
                    fileSize: doc.file_size
                });
            } catch (error) {
                review = {
                    status: 'reject',
                    score: 0,
                    file: { title: doc.title || doc.file_name, fileType: doc.file_type, fileSize: doc.file_size },
                    metrics: { textChars: 0, estimatedChunks: 0 },
                    scores: { extraction: 0, structure: 0, categorization: 0, embedding: 0, authority: DEFAULT_AUTHORITY },
                    suggestedCategory: doc.category || 'general',
                    suggestedTags: [],
                    suggestedAuthorityRank: doc.authority_rank || DEFAULT_AUTHORITY,
                    suggestedAuthorityLabel: doc.authority_label || 'Standard',
                    warnings: [`Source file is not accessible: ${error.message}`],
                    recommendations: ['Restore the source file or re-upload the document.'],
                    preview: ''
                };
            }
        } else {
            review = await this.reviewText(doc.content_text || '', {
                title: doc.title || doc.file_name,
                fileType: doc.file_type,
                fileSize: doc.file_size
            });
        }

        await this.saveReview(documentId, review);
        return review;
    }

    async reviewText(text, options = {}) {
        return this.reviewFile('', { ...options, rawText: String(text || '') });
    }

    async saveReview(documentId, review) {
        await this.ensureSchema();
        await query(
            `UPDATE documents
             SET ai_review_status = ?,
                 ai_review_score = ?,
                 ai_review_json = ?,
                 authority_rank = CASE WHEN authority_rank IS NULL OR authority_rank = 0 OR authority_rank = ? THEN ? ELSE authority_rank END,
                 authority_label = CASE WHEN authority_label IS NULL OR authority_label = '' OR authority_label = 'Standard' THEN ? ELSE authority_label END,
                 updated_at = NOW()
             WHERE id = ?`,
            [
                review.status,
                review.score,
                JSON.stringify(review),
                DEFAULT_AUTHORITY,
                review.suggestedAuthorityRank || DEFAULT_AUTHORITY,
                review.suggestedAuthorityLabel || 'Standard',
                documentId
            ]
        );
    }

    async updateAuthority(documentId, { rank, label }) {
        await this.ensureSchema();
        const authorityRank = clamp(parseInt(rank, 10) || DEFAULT_AUTHORITY, 0, 100);
        const authorityLabel = String(label || 'Admin ranked').trim().slice(0, 80);
        const result = await query(
            'UPDATE documents SET authority_rank = ?, authority_label = ?, updated_at = NOW() WHERE id = ? AND is_active = TRUE',
            [authorityRank, authorityLabel, documentId]
        );
        return result.affectedRows > 0;
    }
}

module.exports = new DocumentQualityService();
