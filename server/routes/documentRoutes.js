const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const Document = require('../models/Document');
const AuditTrail = require('../models/AuditTrail');
const documentProcessor = require('../services/documentProcessor');
const documentQualityService = require('../services/documentQualityService');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { uploadDocument, handleUploadError } = require('../middleware/upload');
const { documentValidation } = require('../middleware/validation');

const router = express.Router();

function normalizeTagsInput(rawTags) {
    if (typeof rawTags === 'undefined') return undefined;
    if (rawTags === null) return [];

    if (Array.isArray(rawTags)) {
        return rawTags
            .map(tag => String(tag).trim())
            .filter(Boolean);
    }

    if (typeof rawTags === 'string') {
        const trimmed = rawTags.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (!Array.isArray(parsed)) {
                    throw new Error('Tags must be a JSON array');
                }
                return parsed
                    .map(tag => String(tag).trim())
                    .filter(Boolean);
            } catch (error) {
                throw new Error('Invalid tags JSON');
            }
        }
        return trimmed
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);
    }

    throw new Error('Invalid tags format');
}

// Get all documents (with pagination and filters)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, category, search, status } = req.query;
        
        const result = await Document.getAll(parseInt(page), parseInt(limit), {
            category,
            search,
            embeddingStatus: status
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        console.error('Get documents error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch documents'
        });
    }
});

// Resolve the canonical Students' Handbook (the page-bound viewer at
// /handbook calls this so the client doesn't need to hard-code an id).
router.get('/handbook', authenticateToken, async (req, res) => {
    try {
        const { query: dbQuery } = require('../../config/db');
        // Match against the documents table; titles are e.g.
        //   "STUDENTS' HANDBOOK 2026 BMU Jan26.pdf"
        //   "BMU Students Handbook"
        const rows = await dbQuery(
            `SELECT id, title FROM documents
             WHERE is_active = TRUE
               AND (LOWER(title) LIKE '%student%handbook%'
                    OR LOWER(title) LIKE '%handbook%bmu%')
             ORDER BY (LOWER(title) LIKE '%student%handbook%') DESC, id DESC
             LIMIT 1`
        );
        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'Handbook not found' });
        }
        res.json({ success: true, id: rows[0].id, title: rows[0].title });
    } catch (err) {
        console.error('Handbook lookup error:', err);
        res.status(500).json({ success: false, error: 'Could not resolve handbook' });
    }
});

// Get document by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const document = await Document.findById(req.params.id);

        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        res.json({
            success: true,
            document: {
                id: document.id,
                title: document.title,
                description: document.description,
                fileName: document.file_name,
                fileType: document.file_type,
                fileSize: document.file_size,
                category: document.category,
                tags: document.tags ? JSON.parse(document.tags) : [],
                embeddingStatus: document.embedding_status,
                aiReviewStatus: document.ai_review_status,
                aiReviewScore: document.ai_review_score,
                aiReview: document.ai_review_json ? JSON.parse(document.ai_review_json) : null,
                authorityRank: document.authority_rank,
                authorityLabel: document.authority_label,
                uploadedBy: document.uploaded_by_email,
                uploadedByName: document.uploaded_by_name,
                createdAt: document.created_at,
                updatedAt: document.updated_at
            }
        });

    } catch (error) {
        console.error('Get document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch document'
        });
    }
});

// Upload new document (admin only)
router.post('/upload', authenticateToken, requireAdmin, uploadDocument.single('file'), handleUploadError, async (req, res) => {
    try {
        const { title, description, category, tags } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

        // Create document record
        let parsedTags = [];
        try {
            const normalized = normalizeTagsInput(tags);
            parsedTags = typeof normalized === 'undefined' ? [] : normalized;
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        const documentId = await Document.create({
            title: title || file.originalname,
            description,
            fileName: file.originalname,
            filePath: file.path,
            fileType: path.extname(file.originalname).toLowerCase(),
            fileSize: file.size,
            category: category || 'general',
            tags: parsedTags,
            uploadedBy: req.user.id
        });

        let review = null;
        try {
            review = await documentQualityService.reviewDocument(documentId);
        } catch (reviewError) {
            console.warn('[Documents] Upload review failed:', reviewError.message);
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_UPLOADED',
            entityType: 'document',
            entityId: documentId,
            details: { title, category, fileName: file.originalname, reviewStatus: review?.status, reviewScore: review?.score },
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            message: 'Document uploaded successfully',
            documentId,
            document: {
                id: documentId,
                title: title || file.originalname,
                fileName: file.originalname,
                fileSize: file.size,
                category: category || 'general'
            },
            review
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to upload document'
        });
    }
});

// Review all active documents for AI ingestion readiness (admin only)
router.post('/review-all', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documents } = await Document.getAll(1, 500, {});
        const results = [];

        for (const document of documents) {
            try {
                const review = await documentQualityService.reviewDocument(document.id);
                results.push({ id: document.id, title: document.title, success: true, status: review.status, score: review.score });
            } catch (error) {
                results.push({ id: document.id, title: document.title, success: false, error: error.message });
            }
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENTS_AI_REVIEWED_BATCH',
            details: {
                total: results.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: `Reviewed ${results.length} documents`,
            results
        });
    } catch (error) {
        console.error('Batch review error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to review documents'
        });
    }
});

// Review document suitability for AI ingestion (admin only)
router.post('/:id/review', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const document = await Document.findById(id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        const review = await documentQualityService.reviewDocument(id);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_AI_REVIEWED',
            entityType: 'document',
            entityId: parseInt(id),
            details: { status: review.status, score: review.score },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Document review completed',
            review
        });
    } catch (error) {
        console.error('Review document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to review document'
        });
    }
});

// Set admin authority ranking for retrieval (admin only)
router.put('/:id/authority', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { rank, label } = req.body;

        const document = await Document.findById(id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        const success = await documentQualityService.updateAuthority(id, { rank, label });
        if (!success) {
            return res.status(400).json({
                success: false,
                error: 'Could not update authority ranking'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_AUTHORITY_UPDATED',
            entityType: 'document',
            entityId: parseInt(id),
            details: { rank, label },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Authority ranking updated'
        });
    } catch (error) {
        console.error('Update authority error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update authority ranking'
        });
    }
});

// Update document metadata (admin only)
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, category, tags } = req.body;

        const document = await Document.findById(id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        let parsedTags;
        if (typeof tags !== 'undefined') {
            try {
                parsedTags = normalizeTagsInput(tags);
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    error: error.message
                });
            }
        }

        const updates = { title, description, category };
        if (typeof parsedTags !== 'undefined') {
            updates.tags = parsedTags;
        }

        const success = await Document.update(id, updates);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'DOCUMENT_UPDATED',
                entityType: 'document',
                entityId: parseInt(id),
                details: { title, category },
                ipAddress: req.ip
            });

            res.json({
                success: true,
                message: 'Document updated successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

    } catch (error) {
        console.error('Update document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update document'
        });
    }
});

// Delete document (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const document = await Document.findById(id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Per requirement: any delete must remove from DB (hard delete)
        const success = await Document.hardDelete(id);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'DOCUMENT_DELETED_PERMANENT',
                entityType: 'document',
                entityId: parseInt(id),
                details: { title: document.title },
                ipAddress: req.ip
            });

            res.json({
                success: true,
                message: 'Document deleted successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to delete document'
            });
        }

    } catch (error) {
        console.error('Delete document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete document'
        });
    }
});

// Process/train a single document (admin only)
router.post('/:id/process', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const document = await Document.findById(id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Start processing in background
        const result = await documentProcessor.processDocument(id);

        await AuditTrail.log({
            userId: req.user.id,
            action: result.success ? 'DOCUMENT_PROCESSED' : 'DOCUMENT_PROCESSING_FAILED',
            entityType: 'document',
            entityId: parseInt(id),
            details: result,
            ipAddress: req.ip
        });

        res.json({
            success: result.success,
            message: result.success ? 'Document processed successfully' : 'Document processing failed',
            details: result
        });

    } catch (error) {
        console.error('Process document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process document'
        });
    }
});

// Process all pending documents (admin only)
router.post('/process-all', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await documentProcessor.processAllPending();

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENTS_BATCH_PROCESSED',
            details: {
                processed: result.processed,
                successful: result.successful,
                failed: result.failed
            },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: `Processed ${result.processed} documents`,
            ...result
        });

    } catch (error) {
        console.error('Batch process error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process documents'
        });
    }
});

// Get document statistics (admin only)
router.get('/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const stats = await Document.getStats();
        const categoryStats = await Document.getCategoryStats();

        res.json({
            success: true,
            stats: {
                ...stats,
                categories: categoryStats
            }
        });

    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics'
        });
    }
});

// Get documents by category
router.get('/category/:category', authenticateToken, async (req, res) => {
    try {
        const { category } = req.params;
        const documents = await Document.getByCategory(category);

        res.json({
            success: true,
            category,
            documents
        });

    } catch (error) {
        console.error('Get by category error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch documents'
        });
    }
});

// Search documents
router.get('/search/:query', authenticateToken, async (req, res) => {
    try {
        const { query } = req.params;
        const { limit = 10 } = req.query;

        const documents = await Document.searchByContent(query, parseInt(limit));

        res.json({
            success: true,
            query,
            documents
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search documents'
        });
    }
});

// Download document file
router.get('/:id/download', authenticateToken, async (req, res) => {
    try {
        const document = await Document.findById(req.params.id);

        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Check if file exists
        try {
            await fs.access(document.file_path);
        } catch {
            return res.status(404).json({
                success: false,
                error: 'File not found on server'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_DOWNLOADED',
            entityType: 'document',
            entityId: parseInt(req.params.id),
            ipAddress: req.ip
        });

        res.download(document.file_path, document.file_name);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download document'
        });
    }
});

// Get document content (chunks/sections) for viewer
router.get('/:id/content', authenticateToken, async (req, res) => {
    try {
        const document = await Document.findById(req.params.id);

        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Get document chunks for search purposes
        const DocumentChunk = require('../models/DocumentChunk');
        const chunks = await DocumentChunk.getChunksByDocumentId(req.params.id);

        // Get full content - prefer HTML if available, otherwise use text
        const contentHtml = document.content_html || null;
        const fullText = document.content_text || '';
        
        // Build table of contents from document structure
        let tableOfContents = [];
        let documentContent = '';
        
        if (contentHtml) {
            // Parse HTML to extract headings for TOC and add IDs for navigation
            const { toc, processedHtml } = processHtmlForViewer(contentHtml);
            tableOfContents = toc;
            documentContent = processedHtml;
        } else {
            // Fall back to text - try to detect structure from text
            const { toc, processedHtml } = processTextForViewer(fullText);
            tableOfContents = toc;
            documentContent = processedHtml;
        }

        // Build chunk-to-section mapping for search navigation
        const chunkToSectionMap = buildChunkToSectionMap(chunks, fullText, tableOfContents);

        // Log document view
        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_VIEWED',
            entityType: 'document',
            entityId: parseInt(req.params.id),
            ipAddress: req.ip
        });

        res.json({
            success: true,
            documentId: req.params.id,
            documentTitle: document.title,
            hasHtml: !!contentHtml,
            tableOfContents,
            content: documentContent,
            chunkToSectionMap,
            totalChunks: chunks.length
        });

    } catch (error) {
        console.error('Get document content error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch document content'
        });
    }
});

// Debug endpoint to diagnose TOC extraction issues
router.get('/:id/debug-toc', authenticateToken, async (req, res) => {
    try {
        const document = await Document.findById(req.params.id);
        if (!document) {
            return res.status(404).json({ success: false, error: 'Document not found' });
        }
        
        const contentHtml = document.content_html || null;
        const fullText = document.content_text || '';
        
        let debugInfo = {
            documentId: req.params.id,
            title: document.title,
            hasHtml: !!contentHtml,
            htmlLength: contentHtml ? contentHtml.length : 0,
            textLength: fullText.length,
            sampleHtml: contentHtml ? contentHtml.substring(0, 2000) : null,
            sampleText: fullText.substring(0, 1000),
            tocCount: 0,
            toc: []
        };
        
        if (contentHtml) {
            const { toc } = processHtmlForViewer(contentHtml);
            debugInfo.tocCount = toc.length;
            debugInfo.toc = toc;
        } else {
            const { toc } = processTextForViewer(fullText);
            debugInfo.tocCount = toc.length;
            debugInfo.toc = toc;
        }
        
        res.json({ success: true, debug: debugInfo });
    } catch (error) {
        console.error('Debug TOC error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Process HTML content for viewer - extract TOC and add navigation IDs
function processHtmlForViewer(html) {
    const toc = [];
    let sectionId = 0;
    
    // First, normalize HTML - convert <b> to <strong> for consistency
    let processedHtml = html
        .replace(/<b(\s[^>]*)?>([^<]*)<\/b>/gi, '<strong$1>$2</strong>')
        // Also normalize spans with bold styling
        .replace(/<span[^>]*font-weight:\s*bold[^>]*>([^<]*)<\/span>/gi, '<strong>$1</strong>')
        .replace(/<span[^>]*font-weight:\s*700[^>]*>([^<]*)<\/span>/gi, '<strong>$1</strong>');
    
    // Convert common Word/Legal document patterns to proper headings
    
    // Pattern 1: CHAPTER headings with Roman or Arabic numerals
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(CHAPTER\s+[IVXLCDM\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );
    
    // Pattern 2: PART headings
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(PART\s+[IVXLCDM\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );
    
    // Pattern 3: SECTION headings (common in acts/legislation)
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(SECTION\s+[\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );
    
    // Pattern 4: "Section X." or "Section X -" style (common in legal documents)
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(Section\s+\d+[\.\-\s][^<]{0,80})<\/strong>\s*<\/p>/gi,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );
    
    // Pattern 5: Standalone numeric sections like "1." "2." at start of bold text
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(\d+\.\s+[A-Z][^<]{2,60})<\/strong>\s*<\/p>/g,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );
    
    // Pattern 6: Numbered section headers like "1.1 Something" or "1.1. Something"
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*([\d]+\.[\d\.]*\s*[A-Z][^<]{2,60})<\/strong>\s*<\/p>/g,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );
    
    // Pattern 7: ARTICLE headings
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(ARTICLE\s+[IVXLCDM\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );
    
    // Pattern 8: SCHEDULE headings
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(SCHEDULE[S]?\s*[IVXLCDM\d]*[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );
    
    // Pattern 9: ACT title/year pattern (e.g., "THE BMU ACT, 2018")
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(THE\s+[A-Z][A-Z\s]+ACT[,\s]+\d{4}[^<]*)<\/strong>\s*<\/p>/gi,
        '<h1 class="doc-heading doc-heading-1">$1</h1>'
    );
    
    // Pattern 10: Standalone bold ALL CAPS paragraphs (short titles)
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*([A-Z][A-Z\s\-,]{3,60})\s*<\/strong>\s*<\/p>/g,
        (match, text) => {
            const cleanText = text.trim();
            // Only convert if truly all caps and reasonable length
            if (cleanText.length >= 4 && cleanText.length < 80 && cleanText === cleanText.toUpperCase()) {
                return `<h3 class="doc-heading doc-heading-3">${cleanText}</h3>`;
            }
            return match;
        }
    );
    
    // Pattern 11: Handle cases where heading text is in spans inside strong
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*<span[^>]*>\s*((?:CHAPTER|PART|SECTION|ARTICLE)\s+[IVXLCDM\d]+[^<]*)\s*<\/span>\s*<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );
    
    // Pattern 12: Handle paragraphs that are entirely bold without <strong> tag (using style)
    processedHtml = processedHtml.replace(
        /<p[^>]*style="[^"]*font-weight:\s*(?:bold|700)[^"]*"[^>]*>([A-Z][A-Z\s\-,]{3,60})<\/p>/gi,
        (match, text) => {
            const cleanText = text.trim();
            if (cleanText.length >= 4 && cleanText.length < 80 && cleanText === cleanText.toUpperCase()) {
                return `<h3 class="doc-heading doc-heading-3">${cleanText}</h3>`;
            }
            return match;
        }
    );
    
    // Pattern 13: Handle bold text that might have inner spans/formatting
    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>((?:CHAPTER|PART|SECTION|ARTICLE|SCHEDULE)\s+[IVXLCDM\d]+[^<]*(?:<[^>]+>[^<]*<\/[^>]+>)?[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

    // Now find all headings (including the ones we just created) and create TOC entries
    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
    let match;
    const headings = [];
    
    while ((match = headingRegex.exec(processedHtml)) !== null) {
        const level = parseInt(match[1]);
        const text = match[0].replace(/<[^>]+>/g, '').trim(); // Strip HTML tags from heading text
        
        if (text.length > 0 && text.length < 150) {
            headings.push({
                fullMatch: match[0],
                level,
                text,
                index: match.index
            });
        }
    }
    
    // Assign IDs to headings in forward order first
    const headingIds = headings.map((h, idx) => `section-${idx}`);
    
    // Replace headings with versions that have IDs (process in reverse to maintain indices)
    for (let i = headings.length - 1; i >= 0; i--) {
        const h = headings[i];
        const id = headingIds[i]; // Use the pre-calculated ID
        const newHeading = `<h${h.level} id="${id}" class="doc-heading doc-heading-${h.level}">${h.text}</h${h.level}>`;
        processedHtml = processedHtml.substring(0, h.index) + newHeading + processedHtml.substring(h.index + h.fullMatch.length);
    }
    
    // Build TOC from headings (in correct order) - IDs now match
    headings.forEach((h, idx) => {
        toc.push({
            id: headingIds[idx],
            level: h.level,
            title: h.text.substring(0, 100),
            sectionIndex: idx
        });
    });
    
    // If no headings found, create a single TOC entry for the whole document
    if (toc.length === 0) {
        toc.push({
            id: 'section-0',
            level: 1,
            title: 'Document Content',
            sectionIndex: 0
        });
        processedHtml = `<div id="section-0">${processedHtml}</div>`;
    }
    
    return { toc, processedHtml };
}

// Pre-process text to insert line breaks before common heading patterns
// This helps with PDF text that often runs together
function preprocessTextForHeadings(text) {
    // First, clean up common PDF artifacts
    let processed = text
        // Remove page number patterns like "1 | P a g e" or "Page 1 of 50"
        .replace(/\d+\s*\|\s*P\s*a\s*g\s*e/gi, '\n')
        .replace(/Page\s+\d+\s+of\s+\d+/gi, '\n')
        .replace(/^\d+\s*$/gm, '')  // Standalone page numbers
        // Normalize whitespace
        .replace(/[ \t]+/g, ' ');
    
    // Insert line breaks before common heading patterns that might be in the middle of text
    
    // Pattern: PART I, PART II, etc. (with dash or hyphen and title)
    processed = processed.replace(/\s+(PART\s+[IVXLCDM\d]+\s*[-–—:]\s*[A-Z])/gi, '\n\n$1');
    
    // Pattern: CHAPTER I, CHAPTER 1, etc.
    processed = processed.replace(/\s+(CHAPTER\s+[IVXLCDM\d]+)/gi, '\n\n$1');
    
    // Pattern: SECTION 1:, SECTION 2:, etc. (with colon - common in manuals)
    processed = processed.replace(/\s+(SECTION\s+\d+\s*:\s*[A-Z])/gi, '\n\n$1');
    
    // Pattern: SECTION 1, Section 2., etc. (without colon)
    processed = processed.replace(/\s+(SECTION\s+\d+[\.\s])/gi, '\n\n$1');
    
    // Pattern: ARTICLE I, ARTICLE 1, etc.
    processed = processed.replace(/\s+(ARTICLE\s+[IVXLCDM\d]+)/gi, '\n\n$1');
    
    // Pattern: SCHEDULE, SCHEDULES, First Schedule, etc.
    processed = processed.replace(/\s+((?:FIRST|SECOND|THIRD|FOURTH|FIFTH)?\s*SCHEDULE[S]?)/gi, '\n\n$1');
    
    // Pattern: ARRANGEMENT OF SECTIONS
    processed = processed.replace(/\s+(ARRANGEMENT[S]?\s+OF\s+SECTIONS?)/gi, '\n\n$1');
    
    // Pattern: A LAW to establish... (common in legislation)
    processed = processed.replace(/\s+(A\s+LAW\s+to\s+establish)/gi, '\n\n$1');
    
    // Pattern: ENACTED by...
    processed = processed.replace(/\s+(ENACTED\s+by)/gi, '\n\n$1');
    
    // Pattern: PRELIMINARY, INTERPRETATION, MISCELLANEOUS
    processed = processed.replace(/\s+(PRELIMINARY|INTERPRETATION|MISCELLANEOUS|TRANSITIONAL|COMMENCEMENT)\s/gi, '\n\n$1 ');
    
    // Pattern: Numbered sections like "1.1 Establishment", "2.3 Location" (subsections in manuals)
    processed = processed.replace(/\s+(\d+\.\d+\s+[A-Z][a-z]+)/g, '\n\n$1');
    
    // Pattern: Main numbered sections like "1. Establishment", "2. Location" at start
    processed = processed.replace(/\s+(\d+\.\s+[A-Z][a-z]+(?:\s+(?:of|and|the|with|for)\s+)?[A-Za-z]+)/g, '\n$1');
    
    return processed;
}

// Process plain text content for viewer
function processTextForViewer(text) {
    const toc = [];
    
    // Pre-process text to identify headings that might be embedded in paragraphs
    const preprocessedText = preprocessTextForHeadings(text);
    const lines = preprocessedText.split('\n');
    
    let processedHtml = '';
    let sectionId = 0;
    let currentParagraph = [];
    
    // Clean up common OCR artifacts
    const cleanLine = (line) => {
        return line
            .replace(/[~]+/g, '')  // Remove tildes
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .trim();
    };
    
    // Patterns that indicate a heading/section title
    const headingPatterns = [
        /^(CHAPTER|PART|SECTION|ARTICLE|SCHEDULE)\s+[IVXLCDMivxlcdm\d]+/i,  // PART I, PART 1, PART III
        /^(PART|CHAPTER)\s+[IVXLCDM\d]+\s*[-–—:]\s*.+/i,  // PART I - ESTABLISHMENT... or PART I: ...
        /^SECTION\s+\d+\s*:\s*[A-Z]/i,  // SECTION 1: INTRODUCTION (common in manuals)
        /^(First|Second|Third|Fourth|Fifth)\s+Schedule/i,  // First Schedule, Second Schedule
        /^[\dIVXLCDMivxlcdm]+\.\s+[A-Z]/,  // "1. INTRODUCTION" or "I. OVERVIEW"
        /^[A-Z][A-Z\s,]{8,50}$/,  // ALL CAPS lines (likely headings) - 8-50 chars
        /^\d+\.\d+\s+[A-Z][a-z]/,  // "1.1 Establishment" (subsections in manuals)
        /^[\d]+\.[\d\.]*\s+[A-Z]/,  // "1.1 Something" or "1.1.1 Something"
        /^Section\s+\d+[\.\-\s:]/i,  // "Section 1." or "Section 1 -" or "Section 1:"
        /^THE\s+[A-Z][A-Z\s]+(?:ACT|LAW|BILL)[,\s]+\d{4}/i,  // "THE BMU ACT, 2018"
        /^[A-Z][A-Z\s]+(?:ACT|LAW|BILL)[,\s]+\d{4}/i,  // "BAYELSA ... LAW, 2018"
        /^\d+\.\s+[A-Z][A-Z\s]{5,}$/,  // "1. DEFINITIONS" style
        /^ARRANGEMENT[S]?\s+OF\s+SECTIONS?/i,  // Common in legislation
        /^PRELIMINARY/i,
        /^INTERPRETATION/i,
        /^MISCELLANEOUS/i,
        /^TRANSITIONAL/i,
        /^COMMENCEMENT/i,
        /^SHORT\s+TITLE/i,
        /^GOVERNMENT\s+OF\s+/i,  // Government headers
        /^FUNCTIONS\s+OF\s+THE\s+/i,  // Functions of the...
        /^POWERS\s+OF\s+/i,  // Powers of...
        /^ESTABLISHMENT\s+/i,  // Establishment...
        /^A\s+LAW\s+to\s+establish/i,  // A LAW to establish...
        /^ENACTED\s+by/i,  // ENACTED by...
        /^\d+\.\s+[A-Z][a-z]+(?:\s+(?:of|and|the)\s+)?(?:the\s+)?[A-Z]/,  // "1. Establishment of the University"
        /^MANUAL\s+OF\s+/i,  // MANUAL OF ACCOUNTING...
        /^BAYELSA\s+MEDICAL\s+UNIVERSITY/i,  // University name header
        /^INTRODUCTION$/i,  // Single word section headers
        /^OBJECTIVES?$/i,
        /^SCOPE$/i,
        /^DEFINITIONS?$/i,
        /^APPENDIX/i,
        /^ANNEX/i,
    ];
    
    const isHeading = (line) => {
        const trimmed = cleanLine(line);
        if (trimmed.length < 3 || trimmed.length > 150) return false;
        // Skip lines that are just page markers or numbers
        if (/^\d+$/.test(trimmed)) return false;
        if (/^page\s+\d+/i.test(trimmed)) return false;
        return headingPatterns.some(pattern => pattern.test(trimmed));
    };
    
    // Determine heading level based on content
    const getHeadingLevel = (text) => {
        if (/^(GOVERNMENT|THE\s+[A-Z]|BAYELSA|MANUAL\s+OF)/i.test(text)) return 1;
        if (/^(PART|CHAPTER|SCHEDULE|ARTICLE)\s+/i.test(text)) return 2;
        if (/^SECTION\s+\d+\s*:/i.test(text)) return 2;  // SECTION 1: INTRODUCTION
        if (/^(First|Second|Third|Fourth|Fifth)\s+Schedule/i.test(text)) return 2;
        if (/^ARRANGEMENT/i.test(text)) return 2;
        if (/^\d+\.\d+\s+/i.test(text)) return 3;  // Subsections like 1.1, 2.3
        return 3;
    };
    
    const flushParagraph = () => {
        if (currentParagraph.length > 0) {
            const paraText = currentParagraph.join(' ').trim();
            if (paraText) {
                processedHtml += `<p>${escapeHtmlBasic(paraText)}</p>\n`;
            }
            currentParagraph = [];
        }
    };
    
    for (const line of lines) {
        const trimmed = cleanLine(line);
        
        if (!trimmed) {
            flushParagraph();
            continue;
        }
        
        if (isHeading(trimmed)) {
            flushParagraph();
            const id = `section-${sectionId}`;
            const level = getHeadingLevel(trimmed);
            const cleanedHeading = trimmed;
            processedHtml += `<h${level} id="${id}" class="doc-heading doc-heading-${level}">${escapeHtmlBasic(cleanedHeading)}</h${level}>\n`;
            toc.push({
                id,
                level: level,
                title: cleanedHeading.substring(0, 100),
                sectionIndex: sectionId
            });
            sectionId++;
        } else {
            currentParagraph.push(trimmed);
        }
    }
    
    flushParagraph();
    
    // If no structure detected, wrap everything in a single section
    if (toc.length === 0) {
        toc.push({
            id: 'section-0',
            level: 1,
            title: 'Document Content',
            sectionIndex: 0
        });
        processedHtml = `<div id="section-0">${processedHtml}</div>`;
    }
    
    return { toc, processedHtml };
}

// Basic HTML escaping for text content
function escapeHtmlBasic(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Build mapping from chunk index to TOC section
function buildChunkToSectionMap(chunks, fullText, toc) {
    if (!chunks.length || !toc.length) return [];
    
    return chunks.map((chunk, idx) => {
        const chunkContent = chunk.content || '';
        const chunkStart = fullText.indexOf(chunkContent.substring(0, 50));
        
        // Find which TOC section this chunk belongs to
        let sectionIndex = 0;
        if (chunkStart >= 0 && toc.length > 1) {
            // Estimate position in document
            const position = chunkStart / fullText.length;
            sectionIndex = Math.min(
                Math.floor(position * toc.length),
                toc.length - 1
            );
        }
        
        return {
            chunkIndex: idx,
            sectionIndex,
            sectionId: toc[sectionIndex]?.id || 'section-0'
        };
    });
}

// Semantic search within a specific document
router.post('/:id/search', authenticateToken, async (req, res) => {
    try {
        const { query: searchQuery, limit = 10 } = req.body;

        if (!searchQuery) {
            return res.status(400).json({
                success: false,
                error: 'Search query is required'
            });
        }

        const document = await Document.findById(req.params.id);

        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Use AI service for semantic search
        const aiService = require('../services/aiService');
        
        // Generate embedding for the query
        const queryEmbedding = await aiService.generateEmbedding(searchQuery);

        // Get all chunks for this document
        const DocumentChunk = require('../models/DocumentChunk');
        const chunks = await DocumentChunk.getChunksByDocumentId(req.params.id);

        // Get full text for page mapping
        const fullText = document.content_text || '';
        const pages = splitIntoPages(fullText, 3000);

        // Calculate similarity scores for each chunk
        const scoredChunks = chunks.map(chunk => {
            let chunkEmbedding;
            try {
                chunkEmbedding = JSON.parse(chunk.embedding);
            } catch {
                return null;
            }

            // Calculate cosine similarity
            const score = cosineSimilarity(queryEmbedding, chunkEmbedding);

            // Find which page this chunk belongs to
            let pageIndex = 0;
            const chunkStart = fullText.indexOf(chunk.content?.substring(0, 100) || '');
            if (chunkStart >= 0) {
                let charCount = 0;
                for (let i = 0; i < pages.length; i++) {
                    charCount += pages[i].length;
                    if (chunkStart < charCount) {
                        pageIndex = i;
                        break;
                    }
                }
            }

            return {
                chunkIndex: chunk.chunk_index,
                pageIndex: pageIndex,
                pageNumber: pageIndex + 1,
                content: chunk.content,
                score
            };
        }).filter(Boolean);

        // Sort by score
        scoredChunks.sort((a, b) => b.score - a.score);

        // Group results by page to avoid duplicate page references
        // and get the best score for each page
        const pageResults = new Map();
        for (const result of scoredChunks) {
            if (!pageResults.has(result.pageIndex)) {
                pageResults.set(result.pageIndex, {
                    pageIndex: result.pageIndex,
                    pageNumber: result.pageNumber,
                    chunkIndex: result.chunkIndex,
                    content: result.content,
                    score: result.score,
                    // Extract relevant excerpt around potential match
                    excerpt: extractRelevantExcerpt(result.content, searchQuery)
                });
            }
        }

        // Convert to array and limit results
        const results = Array.from(pageResults.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, parseInt(limit));

        // Apply minimum relevance threshold (0.3 = 30% similarity)
        const relevantResults = results.filter(r => r.score >= 0.3);

        res.json({
            success: true,
            query: searchQuery,
            documentId: req.params.id,
            totalPages: pages.length,
            results: relevantResults.length > 0 ? relevantResults : results.slice(0, 3) // Return top 3 even if below threshold
        });

    } catch (error) {
        console.error('Document search error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search document'
        });
    }
});

// Extract a relevant excerpt from content based on query terms
function extractRelevantExcerpt(content, query) {
    if (!content || !query) return content?.substring(0, 200) || '';
    
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const contentLower = content.toLowerCase();
    
    // Find the best position where query terms appear
    let bestPos = 0;
    let bestScore = 0;
    
    for (let i = 0; i < content.length - 100; i += 50) {
        const window = contentLower.substring(i, i + 200);
        const score = queryTerms.reduce((acc, term) => {
            return acc + (window.includes(term) ? 1 : 0);
        }, 0);
        
        if (score > bestScore) {
            bestScore = score;
            bestPos = i;
        }
    }
    
    // Extract excerpt around best position
    const start = Math.max(0, bestPos - 20);
    const end = Math.min(content.length, bestPos + 180);
    let excerpt = content.substring(start, end);
    
    // Clean up - try to start/end at word boundaries
    if (start > 0) {
        const firstSpace = excerpt.indexOf(' ');
        if (firstSpace > 0 && firstSpace < 20) {
            excerpt = excerpt.substring(firstSpace + 1);
        }
        excerpt = '...' + excerpt;
    }
    if (end < content.length) {
        const lastSpace = excerpt.lastIndexOf(' ');
        if (lastSpace > excerpt.length - 20) {
            excerpt = excerpt.substring(0, lastSpace);
        }
        excerpt = excerpt + '...';
    }
    
    return excerpt;
}

// Helper function to calculate cosine similarity
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    if (normA === 0 || normB === 0) return 0;
    
    return dotProduct / (normA * normB);
}

// Helper function to split text into pages (for search result mapping)
function splitIntoPages(text, charsPerPage = 3000) {
    if (!text) return [''];
    
    const pages = [];
    let remaining = text;
    
    while (remaining.length > 0) {
        if (remaining.length <= charsPerPage) {
            pages.push(remaining);
            break;
        }
        
        // Try to break at a paragraph or sentence boundary
        let breakPoint = charsPerPage;
        const paragraphBreak = remaining.lastIndexOf('\n\n', charsPerPage);
        const sentenceBreak = remaining.lastIndexOf('. ', charsPerPage);
        
        if (paragraphBreak > charsPerPage * 0.7) {
            breakPoint = paragraphBreak + 2;
        } else if (sentenceBreak > charsPerPage * 0.7) {
            breakPoint = sentenceBreak + 2;
        }
        
        pages.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint);
    }
    
    return pages.length > 0 ? pages : [''];
}

// Summarize document using AI - Direct Ollama call with longer timeout
router.post('/:id/summarize', authenticateToken, async (req, res) => {
    try {
        const document = await Document.findById(req.params.id);

        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        const fullText = document.content_text || '';
        if (!fullText || fullText.length < 100) {
            return res.status(400).json({
                success: false,
                error: 'Document has insufficient content to summarize'
            });
        }

        // Use shorter text and direct Ollama call with longer timeout
        // Keep only first ~8000 chars to reduce token load
        const textToSummarize = fullText.substring(0, 8000);
        
        const prompt = `Summarize this document concisely. Include:
- Main purpose/topic
- Key sections or chapters
- Important policies or rules

Document: "${document.title || 'Untitled'}"

Content:
${textToSummarize}

Provide a clear, organized summary (200-400 words):`;

        // Call Ollama directly with extended timeout for summarization
        const axios = require('axios');
        const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        const ollamaModel = process.env.OLLAMA_CHAT_MODEL || 'mistral:7b';
        
        console.log(`[Summarize] Calling Ollama directly for doc ${req.params.id}, text length: ${textToSummarize.length}`);
        
        const response = await axios.post(
            `${ollamaUrl.replace(/\/$/, '')}/api/generate`,
            {
                model: ollamaModel,
                prompt: prompt,
                stream: false,
                options: {
                    temperature: 0.3,
                    num_predict: 500,  // Limit output length for faster response
                    num_ctx: 2048,     // Smaller context = faster on CPU
                    top_p: 0.9,
                    num_thread: 8      // Use multiple CPU threads
                }
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 180000  // 3 minutes timeout for summarization
            }
        );

        const summary = response.data?.response || '';

        if (!summary) {
            throw new Error('No summary generated');
        }

        // Log the action
        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_SUMMARIZED',
            entityType: 'document',
            entityId: parseInt(req.params.id),
            details: { title: document.title },
            ipAddress: req.ip
        });

        console.log(`[Summarize] Successfully generated summary for doc ${req.params.id}, length: ${summary.length}`);

        res.json({
            success: true,
            documentId: req.params.id,
            title: document.title,
            summary: summary.trim()
        });

    } catch (error) {
        console.error('Document summarize error:', error.message);
        
        // Provide more specific error messages
        let errorMessage = 'Failed to summarize document';
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            errorMessage = 'Summary generation timed out. Please try again or try a shorter document.';
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'AI service is not available. Please try again later.';
        }
        
        res.status(500).json({
            success: false,
            error: errorMessage
        });
    }
});

module.exports = router;
