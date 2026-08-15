const fs = require('fs').promises;
const path = require('path');
const { execFileSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../config/db');
const Document = require('../models/Document');
const documentProcessor = require('./documentProcessor');
const documentQualityService = require('./documentQualityService');

const LAB_DIR = path.join(__dirname, '../../uploads/document-lab');
const PROMOTED_DIR = path.join(LAB_DIR, 'promoted');
const DEFAULT_TARGET_CHARS = 12000;
const DOCUMENT_CATEGORIES = new Set(['policy', 'regulation', 'academic', 'administrative', 'legal', 'general']);
let schemaEnsured = false;

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function cleanTitle(value, fallback = 'Document') {
    return String(value || fallback).trim().replace(/\s+/g, ' ').slice(0, 255);
}

function isImageFile(filePath) {
    return /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(filePath || '');
}

function escapeMarkdownCell(value) {
    return String(value || '').trim().replace(/\|/g, '\\|');
}

function normalizeTableLikeLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let convertedTables = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const next = (lines[i + 1] || '').trim();
        const tableish = trimmed && (/	/.test(trimmed) || /\S\s{3,}\S/.test(trimmed));
        const nextTableish = next && (/	/.test(next) || /\S\s{3,}\S/.test(next));

        if (!tableish || !nextTableish) {
            out.push(line);
            continue;
        }

        const tableRows = [];
        while (i < lines.length) {
            const row = (lines[i] || '').trim();
            if (!row || !(/	/.test(row) || /\S\s{3,}\S/.test(row))) break;
            const cells = row.split(/	+|\s{3,}/).map(escapeMarkdownCell).filter(Boolean);
            if (cells.length < 2) break;
            tableRows.push(cells);
            i++;
        }
        i--;

        if (tableRows.length < 2) {
            out.push(line);
            continue;
        }

        const width = Math.max(...tableRows.map(r => r.length));
        const padded = tableRows.map(r => {
            const copy = r.slice();
            while (copy.length < width) copy.push('');
            return copy;
        });
        out.push('| ' + padded[0].join(' | ') + ' |');
        out.push('| ' + padded[0].map(() => '---').join(' | ') + ' |');
        for (const row of padded.slice(1)) out.push('| ' + row.join(' | ') + ' |');
        convertedTables++;
    }

    return { text: out.join('\n'), convertedTables };
}

function markdownClean(text, title) {
    const normalized = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
    const withTables = normalizeTableLikeLines(normalized);
    const body = withTables.text.trim();
    const heading = `# ${cleanTitle(title)}\n\n`;
    return {
        markdown: body.startsWith('#') ? body : heading + body,
        convertedTables: withTables.convertedTables
    };
}

function detectIssue(review) {
    const warnings = (review?.warnings || []).join(' ').toLowerCase();
    const metrics = review?.metrics || {};
    if (!metrics.textChars || metrics.textChars < 300 || review?.status === 'reject') return 'needs_readable_source';
    if (/low text density|ocr|scanned/.test(warnings)) return 'needs_ocr_cleanup';
    if ((metrics.estimatedChunks || 0) > 500) return 'needs_splitting';
    if ((metrics.tableSignals || 0) > 15 || /table-like/.test(warnings)) return 'needs_table_cleanup';
    if (/few clear headings/.test(warnings)) return 'needs_structure_cleanup';
    if (review?.status === 'ready') return 'ready_for_approval';
    return 'needs_review';
}

function buildRecommendations(issueType, review, tableCount) {
    const recommendations = [...(review?.recommendations || [])];
    if (issueType === 'needs_readable_source') {
        recommendations.unshift('Ask for a readable digital file or OCR-ready scan before ingestion.');
    }
    if (issueType === 'needs_splitting') {
        recommendations.unshift('Split into smaller approved parts before sending to Documents.');
    }
    if (issueType === 'needs_table_cleanup') {
        recommendations.unshift('Review converted Markdown tables before approval.');
    }
    if (tableCount > 0) {
        recommendations.unshift(`${tableCount} table-like block(s) were converted to Markdown table format.`);
    }
    return Array.from(new Set(recommendations)).slice(0, 12);
}

function splitByHeadings(markdown, title, targetChars = DEFAULT_TARGET_CHARS) {
    const text = String(markdown || '').trim();
    if (!text) return [];

    const lines = text.split('\n');
    const sections = [];
    let currentTitle = cleanTitle(title);
    let current = [];

    for (const line of lines) {
        const heading = line.match(/^(#{1,3})\s+(.{4,120})$/);
        if (heading && current.join('\n').length > 800) {
            sections.push({ title: currentTitle, content: current.join('\n').trim() });
            current = [];
            currentTitle = cleanTitle(heading[2], title);
        }
        current.push(line);
    }
    if (current.join('\n').trim()) sections.push({ title: currentTitle, content: current.join('\n').trim() });

    const chunks = [];
    let buffer = [];
    let bufferTitle = sections[0]?.title || cleanTitle(title);
    let bufferLen = 0;

    for (const section of sections) {
        if (bufferLen && bufferLen + section.content.length > targetChars) {
            chunks.push({ title: bufferTitle, content: buffer.join('\n\n').trim() });
            buffer = [];
            bufferLen = 0;
            bufferTitle = section.title;
        }
        if (section.content.length > targetChars * 1.4) {
            if (bufferLen) {
                chunks.push({ title: bufferTitle, content: buffer.join('\n\n').trim() });
                buffer = [];
                bufferLen = 0;
            }
            const paragraphs = section.content.split(/\n{2,}/);
            let part = [];
            let partLen = 0;
            let partNo = 1;
            for (const paragraph of paragraphs) {
                if (partLen >= 800 && partLen + paragraph.length > targetChars) {
                    chunks.push({ title: `${section.title} - Part ${partNo++}`, content: part.join('\n\n').trim() });
                    part = [];
                    partLen = 0;
                }
                part.push(paragraph);
                partLen += paragraph.length + 2;
            }
            if (part.length) chunks.push({ title: `${section.title} - Part ${partNo}`, content: part.join('\n\n').trim() });
            continue;
        }
        buffer.push(section.content);
        bufferLen += section.content.length + 2;
    }

    if (buffer.length) chunks.push({ title: bufferTitle, content: buffer.join('\n\n').trim() });
    const merged = mergeThinSplitChunks(chunks, title);
    return merged.length ? merged : [{ title: cleanTitle(title), content: text }];
}

function isThinSplitChunk(chunk) {
    const content = String(chunk?.content || '').trim();
    if (content.length < 350) return true;
    const withoutHeadings = content
        .split(/\r?\n/)
        .filter(line => !/^#{1,6}\s+/.test(line.trim()))
        .join('\n')
        .trim();
    return withoutHeadings.length < 180;
}

function mergeThinSplitChunks(chunks, fallbackTitle) {
    const source = (chunks || [])
        .filter(chunk => String(chunk?.content || '').trim())
        .map(chunk => ({
            title: cleanTitle(chunk.title || fallbackTitle),
            content: String(chunk.content || '').trim()
        }));
    if (source.length <= 1) return source;

    const merged = [];
    for (const chunk of source) {
        if (isThinSplitChunk(chunk)) {
            const next = source[source.indexOf(chunk) + 1];
            if (next) {
                next.content = `${chunk.content}\n\n${next.content}`.trim();
                if (!next.title || next.title === cleanTitle(fallbackTitle)) {
                    next.title = chunk.title;
                }
                continue;
            }
            if (merged.length) {
                const previous = merged[merged.length - 1];
                previous.content = `${previous.content}\n\n${chunk.content}`.trim();
                continue;
            }
        }
        merged.push(chunk);
    }

    return merged.map((chunk, index) => ({
        title: chunk.title || `${cleanTitle(fallbackTitle)} - Part ${index + 1}`,
        content: chunk.content
    }));
}

class DocumentLabService {
    async ensureDirs() {
        await fs.mkdir(LAB_DIR, { recursive: true });
        await fs.mkdir(PROMOTED_DIR, { recursive: true });
    }

    async ensureSchema() {
        if (schemaEnsured) return true;
        await this.ensureDirs();
        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                source_document_id INT NULL,
                title VARCHAR(255) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                file_path VARCHAR(500) NOT NULL,
                file_type VARCHAR(50) NOT NULL,
                file_size INT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'needs_review',
                issue_type VARCHAR(60) NOT NULL DEFAULT 'needs_review',
                extracted_text LONGTEXT NULL,
                repaired_text LONGTEXT NULL,
                review_status VARCHAR(32) NULL,
                review_score DECIMAL(5,2) NULL,
                review_json LONGTEXT NULL,
                recommendations_json LONGTEXT NULL,
                uploaded_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_lab_status (status),
                INDEX idx_lab_issue (issue_type),
                INDEX idx_lab_source_document (source_document_id)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_outputs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                job_id INT NOT NULL,
                title VARCHAR(255) NOT NULL,
                output_type VARCHAR(50) NOT NULL DEFAULT 'cleaned_markdown',
                content_markdown LONGTEXT NOT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'draft',
                readiness_status VARCHAR(32) NULL,
                readiness_score DECIMAL(5,2) NULL,
                readiness_json LONGTEXT NULL,
                sort_order INT NOT NULL DEFAULT 0,
                promoted_document_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_lab_output_job (job_id),
                INDEX idx_lab_output_status (status),
                CONSTRAINT fk_lab_outputs_job FOREIGN KEY (job_id) REFERENCES document_lab_jobs(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);

        schemaEnsured = true;
        return true;
    }

    async listJobs(limit = 100) {
        await this.ensureSchema();
        const rows = await query(`
            SELECT j.*,
                   (SELECT COUNT(*) FROM document_lab_outputs o WHERE o.job_id = j.id) AS output_count,
                   (SELECT COUNT(*) FROM document_lab_outputs o WHERE o.job_id = j.id AND o.status = 'promoted') AS promoted_count
            FROM document_lab_jobs j
            ORDER BY j.updated_at DESC
            LIMIT ?
        `, [Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300)]);
        return rows.map(row => this._shapeJob(row));
    }

    async getJob(jobId) {
        await this.ensureSchema();
        const jobs = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = jobs[0];
        if (!job) return null;
        const outputs = await query('SELECT * FROM document_lab_outputs WHERE job_id = ? ORDER BY sort_order ASC, id ASC', [jobId]);
        return {
            ...this._shapeJob(job),
            outputs: outputs.map(output => this._shapeOutput(output))
        };
    }

    async createFromUpload(file, userId, metadata = {}) {
        await this.ensureSchema();
        const title = cleanTitle(metadata.title || file.originalname);
        const result = await query(`
            INSERT INTO document_lab_jobs
                (title, file_name, file_path, file_type, file_size, uploaded_by, status, issue_type)
            VALUES (?, ?, ?, ?, ?, ?, 'needs_review', 'needs_review')
        `, [
            title,
            file.originalname,
            file.path,
            path.extname(file.originalname).toLowerCase(),
            file.size,
            userId || null
        ]);
        return this.analyzeJob(result.insertId, { prepareOutputs: true });
    }

    async createFromDocument(documentId, userId) {
        await this.ensureSchema();
        const doc = await Document.findById(documentId);
        if (!doc) throw new Error('Document not found');
        const result = await query(`
            INSERT INTO document_lab_jobs
                (source_document_id, title, file_name, file_path, file_type, file_size, extracted_text, uploaded_by, status, issue_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', 'needs_review')
        `, [
            doc.id,
            cleanTitle(doc.title || doc.file_name),
            doc.file_name,
            doc.file_path,
            doc.file_type,
            doc.file_size,
            doc.content_text || null,
            userId || null
        ]);
        return this.analyzeJob(result.insertId, { prepareOutputs: true });
    }

    async importFlaggedDocuments(userId, options = {}) {
        await this.ensureSchema();
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 25, 1), 100);
        const includeUnreviewed = options.includeUnreviewed === true;
        const params = [];
        let where = `
            d.is_active = TRUE
            AND NOT EXISTS (
                SELECT 1 FROM document_lab_jobs j
                WHERE j.source_document_id = d.id
            )
            AND (
                d.ai_review_status IN ('needs_cleanup', 'needs_splitting', 'reject')
                OR (d.ai_review_score IS NOT NULL AND d.ai_review_score < 70)
        `;
        if (includeUnreviewed) {
            where += " OR d.ai_review_status IS NULL OR d.ai_review_status = 'not_reviewed'";
        }
        where += ')';
        params.push(limit);

        const docs = await query(`
            SELECT d.id, d.title, d.ai_review_status, d.ai_review_score
            FROM documents d
            WHERE ${where}
            ORDER BY
                CASE
                    WHEN d.ai_review_status = 'reject' THEN 0
                    WHEN d.ai_review_status = 'needs_cleanup' THEN 1
                    WHEN d.ai_review_status = 'needs_splitting' THEN 2
                    WHEN d.ai_review_score IS NULL THEN 3
                    ELSE 4
                END,
                d.ai_review_score ASC,
                d.updated_at DESC
            LIMIT ?
        `, params);

        const results = [];
        for (const doc of docs) {
            try {
                const job = await this.createFromDocument(doc.id, userId);
                results.push({ success: true, documentId: doc.id, title: doc.title, jobId: job.id, issueType: job.issueType });
            } catch (error) {
                results.push({ success: false, documentId: doc.id, title: doc.title, error: error.message });
            }
        }

        return {
            imported: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results
        };
    }

    async analyzeJob(jobId, options = {}) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');

        let extractedText = job.extracted_text || '';
        let extractionError = null;
        if (!String(extractedText).trim()) {
            try {
                extractedText = await this.extractReadableText(job.file_path);
            } catch (error) {
                extractionError = error.message;
                extractedText = '';
            }
        }

        let review;
        if (extractedText.trim()) {
            review = await documentQualityService.reviewText(extractedText, {
                title: job.title,
                fileType: job.file_type,
                fileSize: job.file_size
            });
        } else {
            review = {
                status: 'reject',
                score: 0,
                file: { title: job.title, fileType: job.file_type, fileSize: job.file_size },
                metrics: { textChars: 0, estimatedChunks: 0, tableSignals: 0 },
                scores: { extraction: 0, structure: 0, categorization: 0, embedding: 0, authority: 0 },
                suggestedCategory: 'general',
                suggestedTags: [],
                suggestedAuthorityRank: 50,
                suggestedAuthorityLabel: 'Standard',
                warnings: [extractionError || 'No readable text could be extracted.'],
                recommendations: ['Ask the document owner for a readable PDF, Word file, or clean OCR scan.'],
                preview: ''
            };
        }

        const cleaned = markdownClean(extractedText, job.title);
        const issueType = detectIssue(review);
        const recommendations = buildRecommendations(issueType, review, cleaned.convertedTables);
        const status = issueType === 'ready_for_approval' ? 'ready_for_approval' : 'needs_repair';

        await query(`
            UPDATE document_lab_jobs
            SET extracted_text = ?,
                repaired_text = ?,
                status = ?,
                issue_type = ?,
                review_status = ?,
                review_score = ?,
                review_json = ?,
                recommendations_json = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [
            extractedText || null,
            cleaned.markdown || null,
            status,
            issueType,
            review.status,
            review.score,
            JSON.stringify(review),
            JSON.stringify(recommendations),
            jobId
        ]);

        if (options.prepareOutputs !== false && extractedText.trim()) {
            const existing = await query('SELECT COUNT(*) AS count FROM document_lab_outputs WHERE job_id = ?', [jobId]);
            if (!existing[0].count) {
                await this.prepareOutputs(jobId);
            }
        }

        return this.getJob(jobId);
    }

    async extractReadableText(filePath) {
        if (isImageFile(filePath)) {
            try {
                return execFileSync('tesseract', [filePath, 'stdout', '-l', 'eng'], {
                    timeout: 120000,
                    maxBuffer: 20 * 1024 * 1024
                }).toString();
            } catch (error) {
                throw new Error('Image OCR failed or Tesseract is not available.');
            }
        }
        return documentProcessor.extractText(filePath);
    }

    async prepareOutputs(jobId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        if (!String(job.repaired_text || '').trim()) {
            throw new Error('No cleaned text is available for this job.');
        }

        await query("DELETE FROM document_lab_outputs WHERE job_id = ? AND status IN ('draft', 'needs_review', 'approved')", [jobId]);

        const review = safeJson(job.review_json, {});
        const shouldSplit = (review?.metrics?.estimatedChunks || 0) > 500 || job.issue_type === 'needs_splitting';
        const parts = shouldSplit
            ? splitByHeadings(job.repaired_text, job.title)
            : [{ title: job.title, content: job.repaired_text }];

        let order = 1;
        for (const part of parts) {
            const title = parts.length > 1 ? `${cleanTitle(job.title)} - ${cleanTitle(part.title)}`
                : cleanTitle(part.title || job.title);
            const outputType = parts.length > 1 ? 'split_part' : 'cleaned_markdown';
            const readiness = await documentQualityService.reviewText(part.content, {
                title,
                fileType: '.md',
                fileSize: Buffer.byteLength(part.content, 'utf8')
            });
            await query(`
                INSERT INTO document_lab_outputs
                    (job_id, title, output_type, content_markdown, status, readiness_status, readiness_score, readiness_json, sort_order)
                VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
            `, [
                jobId,
                title.slice(0, 255),
                outputType,
                part.content,
                readiness.status,
                readiness.score,
                JSON.stringify(readiness),
                order++
            ]);
        }

        return this.getJob(jobId);
    }

    async buildSplitPlan(jobId, options = {}) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        if (!String(job.repaired_text || '').trim()) {
            throw new Error('No cleaned text is available for this job.');
        }

        const review = safeJson(job.review_json, {});
        const targetChars = Math.min(Math.max(parseInt(options.targetChars, 10) || DEFAULT_TARGET_CHARS, 4000), 30000);
        const shouldSplit = (review?.metrics?.estimatedChunks || 0) > 500 || job.issue_type === 'needs_splitting';
        const rawParts = shouldSplit
            ? splitByHeadings(job.repaired_text, job.title, targetChars)
            : [{ title: job.title, content: job.repaired_text }];

        const parts = [];
        let order = 1;
        for (const part of rawParts) {
            const title = rawParts.length > 1
                ? `${cleanTitle(job.title)} - ${cleanTitle(part.title)}`
                : cleanTitle(part.title || job.title);
            const readiness = await documentQualityService.reviewText(part.content, {
                title,
                fileType: '.md',
                fileSize: Buffer.byteLength(part.content, 'utf8')
            });
            parts.push({
                clientId: `part-${order}`,
                sortOrder: order,
                title: title.slice(0, 255),
                contentMarkdown: part.content,
                charCount: part.content.length,
                estimatedChunks: readiness.metrics?.estimatedChunks || 0,
                readinessStatus: readiness.status,
                readinessScore: readiness.score,
                readiness
            });
            order++;
        }

        return {
            jobId: job.id,
            title: job.title,
            issueType: job.issue_type,
            targetChars,
            strategy: shouldSplit ? 'heading_and_size_split' : 'single_cleaned_output',
            partCount: parts.length,
            parts
        };
    }

    async createOutputsFromPlan(jobId, parts = []) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        if (!Array.isArray(parts) || !parts.length) {
            throw new Error('No approved split parts were submitted.');
        }

        await query("DELETE FROM document_lab_outputs WHERE job_id = ? AND status IN ('draft', 'needs_review', 'approved')", [jobId]);
        let order = 1;
        for (const part of parts) {
            const title = cleanTitle(part.title || `${job.title} - Part ${order}`);
            const content = String(part.contentMarkdown || '').trim();
            if (!content) continue;
            const readiness = await documentQualityService.reviewText(content, {
                title,
                fileType: '.md',
                fileSize: Buffer.byteLength(content, 'utf8')
            });
            await query(`
                INSERT INTO document_lab_outputs
                    (job_id, title, output_type, content_markdown, status, readiness_status, readiness_score, readiness_json, sort_order)
                VALUES (?, ?, 'split_part', ?, 'draft', ?, ?, ?, ?)
            `, [
                jobId,
                title.slice(0, 255),
                content,
                readiness.status,
                readiness.score,
                JSON.stringify(readiness),
                order++
            ]);
        }

        if (order === 1) throw new Error('No non-empty approved parts were submitted.');
        await query("UPDATE document_lab_jobs SET status = 'ready_for_approval', updated_at = NOW() WHERE id = ?", [jobId]);
        return this.getJob(jobId);
    }

    async updateOutput(outputId, updates = {}) {
        await this.ensureSchema();
        const fields = [];
        const values = [];
        if (typeof updates.title === 'string') {
            fields.push('title = ?');
            values.push(cleanTitle(updates.title));
        }
        if (typeof updates.contentMarkdown === 'string') {
            fields.push('content_markdown = ?');
            values.push(updates.contentMarkdown);
        }
        if (typeof updates.status === 'string') {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (!fields.length) throw new Error('No output updates provided');
        values.push(outputId);
        await query(`UPDATE document_lab_outputs SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, values);
        return this.reviewOutput(outputId);
    }

    async reviewOutput(outputId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_outputs WHERE id = ?', [outputId]);
        const output = rows[0];
        if (!output) throw new Error('Lab output not found');
        const readiness = await documentQualityService.reviewText(output.content_markdown, {
            title: output.title,
            fileType: '.md',
            fileSize: Buffer.byteLength(output.content_markdown || '', 'utf8')
        });
        await query(`
            UPDATE document_lab_outputs
            SET readiness_status = ?, readiness_score = ?, readiness_json = ?, updated_at = NOW()
            WHERE id = ?
        `, [readiness.status, readiness.score, JSON.stringify(readiness), outputId]);
        return this._shapeOutput({ ...output, readiness_status: readiness.status, readiness_score: readiness.score, readiness_json: JSON.stringify(readiness) });
    }

    async promoteOutput(outputId, userId, options = {}) {
        await this.ensureSchema();
        const rows = await query(`
            SELECT o.*, j.source_document_id, j.file_name AS source_file_name
            FROM document_lab_outputs o
            JOIN document_lab_jobs j ON j.id = o.job_id
            WHERE o.id = ?
        `, [outputId]);
        const output = rows[0];
        if (!output) throw new Error('Lab output not found');

        const readiness = safeJson(output.readiness_json, null) || await documentQualityService.reviewText(output.content_markdown, {
            title: output.title,
            fileType: '.md',
            fileSize: Buffer.byteLength(output.content_markdown || '', 'utf8')
        });
        if (!options.force && !['ready', 'ready_with_warnings'].includes(readiness.status)) {
            throw new Error('Output is not ready for promotion. Review or clean it first.');
        }

        await this.ensureDirs();
        const fileName = `${uuidv4()}.md`;
        const filePath = path.join(PROMOTED_DIR, fileName);
        await fs.writeFile(filePath, output.content_markdown, 'utf8');
        const docId = await Document.create({
            title: output.title,
            description: `Promoted from Document Lab output #${output.id}`,
            fileName,
            filePath,
            fileType: '.md',
            fileSize: Buffer.byteLength(output.content_markdown || '', 'utf8'),
            category: DOCUMENT_CATEGORIES.has(readiness.suggestedCategory) ? readiness.suggestedCategory : 'general',
            tags: readiness.suggestedTags || [],
            uploadedBy: userId || null
        });
        await Document.updateContentText(docId, output.content_markdown);
        await documentQualityService.saveReview(docId, readiness);
        await query(
            "UPDATE document_lab_outputs SET status = 'promoted', promoted_document_id = ?, updated_at = NOW() WHERE id = ?",
            [docId, outputId]
        );
        await query("UPDATE document_lab_jobs SET status = 'promoted', updated_at = NOW() WHERE id = ?", [output.job_id]);
        return { documentId: docId, output: await this.reviewOutput(outputId) };
    }

    _shapeJob(row) {
        return {
            id: row.id,
            sourceDocumentId: row.source_document_id,
            title: row.title,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            status: row.status,
            issueType: row.issue_type,
            reviewStatus: row.review_status,
            reviewScore: row.review_score,
            review: safeJson(row.review_json, null),
            recommendations: safeJson(row.recommendations_json, []),
            outputCount: Number(row.output_count || 0),
            promotedCount: Number(row.promoted_count || 0),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    _shapeOutput(row) {
        return {
            id: row.id,
            jobId: row.job_id,
            title: row.title,
            outputType: row.output_type,
            contentMarkdown: row.content_markdown,
            status: row.status,
            readinessStatus: row.readiness_status,
            readinessScore: row.readiness_score,
            readiness: safeJson(row.readiness_json, null),
            sortOrder: row.sort_order,
            promotedDocumentId: row.promoted_document_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = new DocumentLabService();
