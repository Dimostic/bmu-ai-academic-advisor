/**
 * FAQ Routes - API endpoints for FAQ management and user access
 * 
 * ACCESS LEVELS:
 * - PUBLIC (no auth): Limited FAQ access - categories, popular FAQs (truncated answers)
 * - AUTHENTICATED (logged in): Full FAQ access with complete answers
 * - ADMIN: FAQ management, generation, editing
 * - SUPERADMIN: Batch generation, bulk operations
 */

const express = require('express');
const CachedQA = require('../models/CachedQA');
const ChatMessage = require('../models/ChatMessage');
const FAQCategory = require('../models/FAQCategory');
const faqService = require('../services/faqService');
const AuditTrail = require('../models/AuditTrail');
const { authenticateToken, requireAdmin, requireSuperAdmin, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// HELPER: Truncate answer for public access
// ============================================================
const truncateForPublic = (text, maxLength = 150) => {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength).trim() + '... [Login to see full answer]';
};

const formatFAQForAccess = (faq, isAuthenticated = false) => {
    if (isAuthenticated) {
        return faq; // Full access
    }
    // Public access - truncate sensitive fields
    return {
        id: faq.id,
        question: faq.question,
        answer: truncateForPublic(faq.answer),
        category_name: faq.category_name || faq.categoryName,
        qa_type: faq.qa_type || faq.qaType,
        isPartial: true // Flag to show login prompt
    };
};

// ==================== PUBLIC ROUTES (limited access) ====================

/**
 * Get all FAQ categories with counts
 * Public access for FAQ browsing
 */
router.get('/categories', optionalAuth, async (req, res) => {
    try {
        const categories = await FAQCategory.findAll();
        res.json({
            success: true,
            categories
        });
    } catch (error) {
        console.error('Get FAQ categories error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get categories'
        });
    }
});

/**
 * Get FAQs by category (public gets truncated, authenticated gets full)
 */
router.get('/category/:categoryId', optionalAuth, async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { limit = 50 } = req.query;
        const isAuthenticated = !!req.user;

        const faqs = await CachedQA.findByCategory(categoryId, parseInt(limit));
        const category = await FAQCategory.findById(categoryId);

        res.json({
            success: true,
            category,
            isAuthenticated,
            faqs: faqs.map(faq => formatFAQForAccess(faq, isAuthenticated))
        });
    } catch (error) {
        console.error('Get FAQs by category error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get FAQs'
        });
    }
});

/**
 * Get popular FAQs (public gets truncated answers)
 */
router.get('/popular', optionalAuth, async (req, res) => {
    try {
        const { limit = 10 } = req.query;
        const isAuthenticated = !!req.user;
        const faqs = await CachedQA.getPopular(parseInt(limit));
        
        res.json({
            success: true,
            isAuthenticated,
            faqs: faqs.map(faq => formatFAQForAccess(faq, isAuthenticated))
        });
    } catch (error) {
        console.error('Get popular FAQs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get popular FAQs'
        });
    }
});

/**
 * Search FAQs by text (public gets truncated results)
 */
router.get('/search', optionalAuth, async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;
        const isAuthenticated = !!req.user;
        
        if (!q || q.trim().length < 2) {
            return res.status(400).json({
                success: false,
                error: 'Search query must be at least 2 characters'
            });
        }

        const results = await CachedQA.searchByQuestion(q.trim(), parseInt(limit));
        
        res.json({
            success: true,
            query: q,
            isAuthenticated,
            results: results.map(faq => formatFAQForAccess(faq, isAuthenticated))
        });
    } catch (error) {
        console.error('Search FAQs error:', error);
        res.status(500).json({
            success: false,
            error: 'Search failed'
        });
    }
});

/**
 * Get a single FAQ by ID (public gets truncated, authenticated gets full)
 */
router.get('/item/:id', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const isAuthenticated = !!req.user;
        const faq = await CachedQA.findById(id);
        
        if (!faq) {
            return res.status(404).json({
                success: false,
                error: 'FAQ not found'
            });
        }

        // Record usage when viewed
        await CachedQA.recordUsage(id);

        res.json({
            success: true,
            isAuthenticated,
            faq: formatFAQForAccess(faq, isAuthenticated)
        });
    } catch (error) {
        console.error('Get FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get FAQ'
        });
    }
});

/**
 * Submit feedback on FAQ helpfulness
 */
router.post('/item/:id/feedback', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { helpful } = req.body;
        const db = require('../../config/db');

        // First check if there's an existing cache hit to update
        const [existing] = await db.query(
            `SELECT id FROM qa_cache_hits WHERE cached_qa_id = ? ORDER BY created_at DESC LIMIT 1`,
            [id]
        );

        if (existing && existing.length > 0) {
            // Update the most recent cache hit for this FAQ
            await db.query(
                `UPDATE qa_cache_hits SET was_helpful = ? WHERE id = ?`,
                [helpful, existing[0].id]
            );
        } else {
            // No cache hit exists, create one for this direct FAQ view feedback
            await db.query(
                `INSERT INTO qa_cache_hits (cached_qa_id, user_query, was_helpful, created_at) VALUES (?, '[direct view]', ?, NOW())`,
                [id, helpful]
            );
        }

        res.json({
            success: true,
            message: 'Feedback recorded'
        });
    } catch (error) {
        console.error('FAQ feedback error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to record feedback'
        });
    }
});

// ==================== ADMIN ROUTES ====================

/**
 * Get a single FAQ by ID (admin - full data)
 */
router.get('/admin/item/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const faq = await CachedQA.findById(id);
        
        if (!faq) {
            return res.status(404).json({
                success: false,
                error: 'FAQ not found'
            });
        }

        res.json({
            success: true,
            faq
        });
    } catch (error) {
        console.error('Admin get FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get FAQ'
        });
    }
});

/**
 * Get all FAQs with pagination and filters (admin)
 */
router.get('/admin/list', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, categoryId, documentId, isVerified, search } = req.query;

        const result = await CachedQA.findAll({
            page: parseInt(page),
            limit: parseInt(limit),
            categoryId: categoryId ? parseInt(categoryId) : undefined,
            documentId: documentId ? parseInt(documentId) : undefined,
            isVerified: isVerified !== undefined ? isVerified === 'true' : undefined,
            search
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Admin get FAQs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get FAQs'
        });
    }
});

/**
 * Get FAQ statistics (admin)
 */
router.get('/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const stats = await faqService.getStats();
        
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Get FAQ stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get statistics'
        });
    }
});

/**
 * Get frequently asked questions from chat (admin)
 */
router.get('/admin/suggestions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days, 10);
        const minCount = parseInt(req.query.minCount, 10);
        const limit = parseInt(req.query.limit, 10);
        const page = parseInt(req.query.page, 10);
        const minLength = parseInt(req.query.minLength, 10);
        const maxLength = parseInt(req.query.maxLength, 10);

        const result = await ChatMessage.getFrequentQuestions({
            days: Number.isFinite(days) ? days : 30,
            minCount: Number.isFinite(minCount) ? minCount : 3,
            limit: Number.isFinite(limit) ? limit : 10,
            page: Number.isFinite(page) ? page : 1,
            minLength: Number.isFinite(minLength) ? minLength : 8,
            maxLength: Number.isFinite(maxLength) ? maxLength : 300
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Get FAQ suggestions error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get FAQ suggestions'
        });
    }
});

/**
 * Generate Q&A from document (admin)
 */
router.post('/admin/generate/:documentId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        const { maxQuestions } = req.body;

        // Start generation (async)
        const result = await faqService.generateQAFromDocument(parseInt(documentId), {
            maxQuestions: maxQuestions ? parseInt(maxQuestions) : undefined,
            userId: req.user.id
        });

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_GENERATION_STARTED',
            entityType: 'document',
            entityId: documentId,
            details: { maxQuestions, jobId: result.jobId },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Generate FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate FAQs: ' + error.message
        });
    }
});

/**
 * Get generation job status (admin)
 */
router.get('/admin/jobs/:jobId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await faqService.getJobStatus(parseInt(jobId));
        
        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'Job not found'
            });
        }

        res.json({
            success: true,
            job
        });
    } catch (error) {
        console.error('Get job status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get job status'
        });
    }
});

/**
 * Get all generation jobs (admin)
 */
router.get('/admin/jobs', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { status, documentId, limit = 20 } = req.query;
        
        const jobs = await faqService.getJobs({
            status,
            documentId: documentId ? parseInt(documentId) : undefined,
            limit: parseInt(limit)
        });

        res.json({
            success: true,
            jobs
        });
    } catch (error) {
        console.error('Get jobs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get jobs'
        });
    }
});

/**
 * Get document FAQ coverage status (admin)
 */
router.get('/admin/coverage', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const coverage = await faqService.getDocumentCoverage();
        
        res.json({
            success: true,
            documents: coverage,
            summary: {
                total: coverage.length,
                comprehensive: coverage.filter(d => d.coverageLevel === 'comprehensive').length,
                good: coverage.filter(d => d.coverageLevel === 'good').length,
                moderate: coverage.filter(d => d.coverageLevel === 'moderate').length,
                minimal: coverage.filter(d => d.coverageLevel === 'minimal').length,
                none: coverage.filter(d => d.coverageLevel === 'none').length
            }
        });
    } catch (error) {
        console.error('Get FAQ coverage error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get coverage'
        });
    }
});

/**
 * Regenerate FAQ for document (admin) - clears existing and generates fresh
 */
router.post('/admin/regenerate/:documentId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        
        const result = await faqService.regenerateForDocument(parseInt(documentId), req.user.id);
        
        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_REGENERATION_STARTED',
            entityType: 'document',
            entityId: documentId,
            details: { jobId: result.jobId },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'FAQ regeneration started',
            ...result
        });
    } catch (error) {
        console.error('Regenerate FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to regenerate FAQs: ' + error.message
        });
    }
});

/**
 * Generate FAQ for all documents without coverage (admin)
 */
router.post('/admin/generate-all', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // Get documents without FAQ coverage
        const coverage = await faqService.getDocumentCoverage();
        const docsToProcess = coverage.filter(d => d.coverageLevel === 'none' || d.coverageLevel === 'minimal');
        
        if (docsToProcess.length === 0) {
            return res.json({
                success: true,
                message: 'All documents already have adequate FAQ coverage',
                queued: 0
            });
        }

        // Queue generation for each document (run sequentially in background)
        let queued = 0;
        for (const doc of docsToProcess.slice(0, 10)) { // Limit to 10 at a time
            faqService.generateQAFromDocument(doc.id, { userId: req.user.id, phased: true })
                .then(result => console.log(`[FAQRoutes] Generated ${result.questionsGenerated} FAQs for doc ${doc.id}`))
                .catch(err => console.error(`[FAQRoutes] Failed to generate FAQs for doc ${doc.id}:`, err.message));
            queued++;
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_BULK_GENERATION_STARTED',
            entityType: 'system',
            details: { documentsQueued: queued, totalPending: docsToProcess.length },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: `Queued FAQ generation for ${queued} documents`,
            queued,
            totalPending: docsToProcess.length
        });
    } catch (error) {
        console.error('Generate all FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start bulk FAQ generation: ' + error.message
        });
    }
});

/**
 * Get FAQs for a specific document (admin)
 */
router.get('/admin/document/:documentId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        const faqs = await CachedQA.findByDocument(parseInt(documentId));
        
        // Group by type
        const byType = {};
        faqs.forEach(faq => {
            const type = faq.qa_type || 'general';
            if (!byType[type]) byType[type] = [];
            byType[type].push(faq);
        });

        res.json({
            success: true,
            documentId: parseInt(documentId),
            totalCount: faqs.length,
            byType,
            faqs
        });
    } catch (error) {
        console.error('Get document FAQs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get document FAQs'
        });
    }
});

/**
 * Manually add a FAQ (admin)
 */
router.post('/admin/add', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { question, answer, categoryId, documentId, variations, sources } = req.body;

        if (!question || !answer) {
            return res.status(400).json({
                success: false,
                error: 'Question and answer are required'
            });
        }

        const qaId = await faqService.addManualQA({
            question,
            answer,
            categoryId: categoryId ? parseInt(categoryId) : null,
            documentId: documentId ? parseInt(documentId) : null,
            variations: variations || [],
            sources: sources || [],
            userId: req.user.id
        });

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_CREATED',
            entityType: 'cached_qa',
            entityId: qaId,
            details: { question: question.substring(0, 100) },
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            id: qaId,
            message: 'FAQ added successfully'
        });
    } catch (error) {
        console.error('Add FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add FAQ'
        });
    }
});

/**
 * Update a FAQ (admin)
 */
router.put('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        await CachedQA.update(parseInt(id), updates);

        // If question changed, update embedding
        if (updates.question) {
            await faqService.updateEmbedding(parseInt(id));
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_UPDATED',
            entityType: 'cached_qa',
            entityId: id,
            details: { fields: Object.keys(updates) },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'FAQ updated successfully'
        });
    } catch (error) {
        console.error('Update FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update FAQ'
        });
    }
});

/**
 * Verify a FAQ (admin approval)
 */
router.post('/admin/:id/verify', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        await CachedQA.verify(parseInt(id), req.user.id);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_VERIFIED',
            entityType: 'cached_qa',
            entityId: id,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'FAQ verified successfully'
        });
    } catch (error) {
        console.error('Verify FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to verify FAQ'
        });
    }
});

/**
 * Regenerate FAQ answer using AI (admin)
 * Takes the question and uses AI to generate a new/improved answer
 */
router.post('/admin/:id/regenerate-answer', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { question, currentAnswer } = req.body;

        if (!question) {
            return res.status(400).json({
                success: false,
                error: 'Question is required'
            });
        }

        // Generate new answer using AI
        const result = await faqService.regenerateFAQAnswer(parseInt(id), question, currentAnswer);

        if (!result.success) {
            return res.status(500).json({
                success: false,
                error: result.error || 'Failed to generate answer'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_ANSWER_REGENERATED',
            entityType: 'cached_qa',
            entityId: id,
            details: { question: question.substring(0, 100) },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            answer: result.answer,
            sources: result.sources || [],
            message: 'Answer regenerated successfully'
        });
    } catch (error) {
        console.error('Regenerate FAQ answer error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to regenerate answer: ' + error.message
        });
    }
});

/**
 * Delete (deactivate) a FAQ (admin)
 */
router.delete('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        await CachedQA.deactivate(parseInt(id));

        // Invalidate cache
        faqService.invalidateEmbeddingsCache();

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_DELETED',
            entityType: 'cached_qa',
            entityId: id,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'FAQ deleted successfully'
        });
    } catch (error) {
        console.error('Delete FAQ error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete FAQ'
        });
    }
});

// ==================== CATEGORY MANAGEMENT (Admin) ====================

/**
 * Create category (admin)
 */
router.post('/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, description, icon, displayOrder } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                error: 'Category name is required'
            });
        }

        const categoryId = await FAQCategory.create({ name, description, icon, displayOrder });

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_CATEGORY_CREATED',
            entityType: 'faq_category',
            entityId: categoryId,
            details: { name },
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            id: categoryId,
            message: 'Category created successfully'
        });
    } catch (error) {
        console.error('Create category error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create category'
        });
    }
});

/**
 * Update category (admin)
 */
router.put('/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        await FAQCategory.update(parseInt(id), updates);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_CATEGORY_UPDATED',
            entityType: 'faq_category',
            entityId: id,
            details: { fields: Object.keys(updates) },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Category updated successfully'
        });
    } catch (error) {
        console.error('Update category error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update category'
        });
    }
});

/**
 * Delete category (admin)
 */
router.delete('/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        await FAQCategory.delete(parseInt(id));

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_CATEGORY_DELETED',
            entityType: 'faq_category',
            entityId: id,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Category deleted successfully'
        });
    } catch (error) {
        console.error('Delete category error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete category'
        });
    }
});

// ==================== BATCHED FAQ GENERATION (Admin/Superadmin) ====================

/**
 * Get available FAQ generation phases
 */
router.get('/admin/phases', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const phases = faqService.getAvailablePhases();
        res.json({
            success: true,
            phases
        });
    } catch (error) {
        console.error('Get phases error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get phases'
        });
    }
});

/**
 * Prepare batch generation plan for a document
 * Returns batch structure without generating anything
 */
router.get('/admin/batch-plan/:documentId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        const plan = await faqService.prepareBatchGeneration(parseInt(documentId));
        
        res.json({
            success: true,
            plan
        });
    } catch (error) {
        console.error('Prepare batch plan error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to prepare batch plan: ' + error.message
        });
    }
});

/**
 * Generate a single batch (one phase + one chunk)
 * Allows step-by-step controlled generation
 */
router.post('/admin/generate-batch', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documentId, phase, chunkIndex } = req.body;
        
        if (!documentId || !phase || chunkIndex === undefined) {
            return res.status(400).json({
                success: false,
                error: 'documentId, phase, and chunkIndex are required'
            });
        }

        const result = await faqService.generateSingleBatch(
            parseInt(documentId),
            phase,
            parseInt(chunkIndex),
            req.user.id
        );

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_BATCH_GENERATED',
            entityType: 'document',
            entityId: documentId,
            details: { 
                phase, 
                chunkIndex, 
                questionsGenerated: result.questionsGenerated 
            },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Generate batch error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate batch: ' + error.message
        });
    }
});

/**
 * Generate an entire phase for a document
 */
router.post('/admin/generate-phase', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { documentId, phase } = req.body;
        
        if (!documentId || !phase) {
            return res.status(400).json({
                success: false,
                error: 'documentId and phase are required'
            });
        }

        const result = await faqService.generatePhase(
            parseInt(documentId),
            phase,
            req.user.id
        );

        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_PHASE_GENERATED',
            entityType: 'document',
            entityId: documentId,
            details: { 
                phase, 
                questionsGenerated: result.questionsGenerated,
                chunksProcessed: result.processedChunks
            },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Generate phase error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate phase: ' + error.message
        });
    }
});

// ==================== IMPORT/EXPORT ROUTES ====================

/**
 * Download CSV template for FAQ import
 */
router.get('/admin/import-template', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // Get categories for reference
        const categories = await FAQCategory.findAll();
        
        // Create CSV template with headers and example rows
        const headers = [
            'question',
            'answer', 
            'category_name',
            'qa_type',
            'question_variations',
            'confidence_score',
            'is_verified'
        ];
        
        // Example rows
        const exampleRows = [
            [
                'What is the academic calendar for the current session?',
                'The academic calendar for the current session runs from September to July. First semester is September to February, and second semester is March to July. Please check the official university website for specific dates.',
                'Academic',
                'definitional',
                'When does the academic year start?|What are the semester dates?',
                '0.95',
                'false'
            ],
            [
                'How do I apply for student ID card?',
                'To apply for a student ID card: 1) Visit the Student Affairs office, 2) Complete the ID application form, 3) Provide a passport photograph, 4) Pay the required fee at the bursary, 5) Collect your ID within 2 weeks.',
                'Administrative',
                'procedural',
                'How to get student ID?|Student ID card process|Where to collect ID card?',
                '1.0',
                'true'
            ],
            [
                'What is the minimum GPA required to avoid probation?',
                'Students must maintain a minimum Cumulative Grade Point Average (CGPA) of 1.50 to avoid academic probation. Students on probation have one semester to improve their grades above the threshold.',
                'Academic',
                'quantitative',
                'Minimum CGPA requirement|What GPA is probation?',
                '0.90',
                'false'
            ]
        ];
        
        // Build CSV content
        let csvContent = headers.join(',') + '\n';
        
        // Add example rows with proper CSV escaping
        for (const row of exampleRows) {
            csvContent += row.map(cell => {
                // Escape quotes and wrap in quotes if contains comma, newline, or quotes
                if (cell.includes(',') || cell.includes('\n') || cell.includes('"')) {
                    return '"' + cell.replace(/"/g, '""') + '"';
                }
                return cell;
            }).join(',') + '\n';
        }
        
        // Add comment section with instructions
        csvContent += '\n# INSTRUCTIONS (delete these comment lines before importing):\n';
        csvContent += '# - question: The FAQ question (required)\n';
        csvContent += '# - answer: The answer text (required)\n';
        csvContent += '# - category_name: Category name - must match existing category or leave blank\n';
        csvContent += '#   Available categories: ' + categories.map(c => c.name).join(', ') + '\n';
        csvContent += '# - qa_type: One of: general, definitional, procedural, quantitative, role_specific, scenario, compliance\n';
        csvContent += '# - question_variations: Alternative phrasings separated by | (pipe)\n';
        csvContent += '# - confidence_score: Number between 0 and 1 (default: 1.0)\n';
        csvContent += '# - is_verified: true or false (default: false)\n';
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="faq_import_template.csv"');
        res.send(csvContent);
        
    } catch (error) {
        console.error('Download template error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate template'
        });
    }
});

/**
 * Import FAQs from CSV data
 */
router.post('/admin/import', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { faqs, skipDuplicates = true, autoVerify = false } = req.body;
        
        if (!faqs || !Array.isArray(faqs) || faqs.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No FAQs provided for import'
            });
        }
        
        // Validate and process FAQs
        const validFaqs = [];
        const errors = [];
        const duplicates = [];
        
        // Get categories for lookup
        const categories = await FAQCategory.findAll();
        const categoryMap = {};
        for (const cat of categories) {
            categoryMap[cat.name.toLowerCase()] = cat.id;
        }
        
        // Valid QA types
        const validQaTypes = ['general', 'definitional', 'procedural', 'quantitative', 'role_specific', 'scenario', 'compliance'];
        
        for (let i = 0; i < faqs.length; i++) {
            const faq = faqs[i];
            const rowNum = i + 1;
            
            // Validate required fields
            if (!faq.question || !faq.question.trim()) {
                errors.push({ row: rowNum, error: 'Question is required' });
                continue;
            }
            if (!faq.answer || !faq.answer.trim()) {
                errors.push({ row: rowNum, error: 'Answer is required' });
                continue;
            }
            
            // Check for duplicates
            if (skipDuplicates) {
                const existing = await CachedQA.searchByQuestion(faq.question.trim(), 1);
                if (existing.length > 0 && existing[0].question.toLowerCase() === faq.question.trim().toLowerCase()) {
                    duplicates.push({ row: rowNum, question: faq.question.substring(0, 50) + '...' });
                    continue;
                }
            }
            
            // Resolve category
            let categoryId = null;
            if (faq.category_name) {
                categoryId = categoryMap[faq.category_name.toLowerCase()];
                if (!categoryId) {
                    // Create new category if doesn't exist
                    const newCatId = await FAQCategory.create({
                        name: faq.category_name,
                        description: `Imported category: ${faq.category_name}`,
                        icon: 'fas fa-folder'
                    });
                    categoryId = newCatId;
                    categoryMap[faq.category_name.toLowerCase()] = newCatId;
                }
            }
            
            // Parse question variations
            let questionVariations = [];
            if (faq.question_variations) {
                if (typeof faq.question_variations === 'string') {
                    questionVariations = faq.question_variations.split('|').map(v => v.trim()).filter(v => v);
                } else if (Array.isArray(faq.question_variations)) {
                    questionVariations = faq.question_variations;
                }
            }
            
            // Validate QA type
            let qaType = 'general';
            if (faq.qa_type && validQaTypes.includes(faq.qa_type.toLowerCase())) {
                qaType = faq.qa_type.toLowerCase();
            }
            
            // Parse confidence score
            let confidenceScore = 1.0;
            if (faq.confidence_score) {
                const parsed = parseFloat(faq.confidence_score);
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                    confidenceScore = parsed;
                }
            }
            
            // Parse is_verified
            const isVerified = autoVerify || faq.is_verified === true || faq.is_verified === 'true';
            
            validFaqs.push({
                question: faq.question.trim(),
                answer: faq.answer.trim(),
                categoryId,
                questionVariations,
                qaType,
                confidenceScore,
                isVerified,
                createdBy: req.user.id,
                answerSources: faq.answer_sources || []
            });
        }
        
        // Batch insert valid FAQs
        let importedCount = 0;
        const importedIds = [];
        
        if (validFaqs.length > 0) {
            // Insert in batches of 50
            const batchSize = 50;
            for (let i = 0; i < validFaqs.length; i += batchSize) {
                const batch = validFaqs.slice(i, i + batchSize);
                const ids = await CachedQA.createBatch(batch);
                importedIds.push(...ids);
                importedCount += batch.length;
            }
            
            // If any were verified, update the verified_at and verified_by
            const verifiedFaqs = validFaqs.filter(f => f.isVerified);
            if (verifiedFaqs.length > 0) {
                const db = require('../../config/db');
                await db.query(
                    `UPDATE cached_qa SET is_verified = TRUE, verified_by = ?, verified_at = NOW() 
                     WHERE id IN (?) AND is_verified = FALSE`,
                    [req.user.id, importedIds]
                );
            }
        }
        
        // Log the import
        await AuditTrail.log({
            userId: req.user.id,
            action: 'FAQ_BULK_IMPORT',
            entityType: 'faq',
            details: {
                totalProvided: faqs.length,
                imported: importedCount,
                duplicatesSkipped: duplicates.length,
                errors: errors.length
            },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: `Successfully imported ${importedCount} FAQs`,
            summary: {
                totalProvided: faqs.length,
                imported: importedCount,
                duplicatesSkipped: duplicates.length,
                errorsCount: errors.length
            },
            duplicates: duplicates.slice(0, 10), // Only show first 10
            errors: errors.slice(0, 10) // Only show first 10
        });
        
    } catch (error) {
        console.error('Import FAQs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to import FAQs: ' + error.message
        });
    }
});

/**
 * Export FAQs to CSV
 */
router.get('/admin/export', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { categoryId, isVerified, format = 'csv' } = req.query;
        
        // Build query
        let sql = `
            SELECT cq.*, fc.name as category_name, d.title as document_title
            FROM cached_qa cq
            LEFT JOIN faq_categories fc ON fc.id = cq.category_id
            LEFT JOIN documents d ON d.id = cq.document_id
            WHERE cq.is_active = TRUE
        `;
        const params = [];
        
        if (categoryId) {
            sql += ' AND cq.category_id = ?';
            params.push(categoryId);
        }
        if (isVerified !== undefined) {
            sql += ' AND cq.is_verified = ?';
            params.push(isVerified === 'true');
        }
        
        sql += ' ORDER BY cq.category_id, cq.created_at';
        
        const db = require('../../config/db');
        const rows = await db.query(sql, params);
        
        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="faq_export.json"');
            
            const exportData = rows.map(row => ({
                question: row.question,
                answer: row.answer,
                category_name: row.category_name || '',
                qa_type: row.qa_type || 'general',
                question_variations: JSON.parse(row.question_variations || '[]').join('|'),
                confidence_score: row.confidence_score || 1.0,
                is_verified: row.is_verified ? 'true' : 'false',
                usage_count: row.usage_count || 0,
                document_title: row.document_title || ''
            }));
            
            return res.json(exportData);
        }
        
        // CSV format
        const headers = [
            'question',
            'answer',
            'category_name',
            'qa_type',
            'question_variations',
            'confidence_score',
            'is_verified',
            'usage_count',
            'document_title'
        ];
        
        let csvContent = headers.join(',') + '\n';
        
        for (const row of rows) {
            const variations = JSON.parse(row.question_variations || '[]').join('|');
            const csvRow = [
                row.question,
                row.answer,
                row.category_name || '',
                row.qa_type || 'general',
                variations,
                row.confidence_score || 1.0,
                row.is_verified ? 'true' : 'false',
                row.usage_count || 0,
                row.document_title || ''
            ];
            
            csvContent += csvRow.map(cell => {
                const str = String(cell);
                if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                    return '"' + str.replace(/"/g, '""') + '"';
                }
                return str;
            }).join(',') + '\n';
        }
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="faq_export.csv"');
        res.send(csvContent);
        
    } catch (error) {
        console.error('Export FAQs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export FAQs'
        });
    }
});

module.exports = router;
