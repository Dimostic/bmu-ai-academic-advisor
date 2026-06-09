/**
 * VC Documents API Routes
 * Handles all endpoints for the VC Documents system
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const VCDocument = require('../models/VCDocument');
const VCDocumentChunk = require('../models/VCDocumentChunk');
const AuditTrail = require('../models/AuditTrail');
const vcDocumentService = require('../services/vcDocumentService');
const documentProcessor = require('../services/documentProcessor');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ========== FILE UPLOAD CONFIGURATION ==========

const uploadDir = path.join(__dirname, '../../uploads/vc_documents');

// Ensure upload directory exists
(async () => {
    try {
        await fs.mkdir(uploadDir, { recursive: true });
    } catch (err) {
        console.error('Failed to create VC documents upload directory:', err);
    }
})();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `document-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error(`File type ${ext} not allowed. Allowed types: ${allowedTypes.join(', ')}`), false);
    }
};

const MAX_VC_DOCUMENT_SIZE = parseInt(process.env.MAX_VC_DOCUMENT_SIZE || process.env.MAX_FILE_SIZE, 10) || 52428800;
const MAX_VC_DOCUMENT_SIZE_MB = Math.max(1, Math.round(MAX_VC_DOCUMENT_SIZE / (1024 * 1024)));

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_VC_DOCUMENT_SIZE
    }
});

const handleVCDocumentUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                error: `File too large. Maximum size allowed is ${MAX_VC_DOCUMENT_SIZE_MB}MB.`
            });
        }
        return res.status(400).json({
            success: false,
            error: `Upload error: ${err.message}`
        });
    }
    if (err) {
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }
    next();
};

// ========== MIDDLEWARE ==========

/**
 * Middleware to check VC documents access
 */
const requireVCAccess = async (req, res, next) => {
    try {
        const hasAccess = await VCDocument.checkUserAccess(req.user.id);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'You do not have access to VC Documents'
            });
        }
        next();
    } catch (error) {
        console.error('VC access check error:', error);
        res.status(500).json({
            success: false,
            error: 'Access verification failed'
        });
    }
};

// ========== DOCUMENT CRUD ENDPOINTS ==========

/**
 * GET /api/vc-documents
 * Get all documents with pagination and filters
 */
router.get('/', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            category,
            search,
            isRead,
            isStarred,
            isArchived,
            sentiment,
            processingStatus,
            startDate,
            endDate,
            department,
            sortBy,
            sortOrder,
            starredFirst
        } = req.query;

        const filters = {
            category,
            search,
            processingStatus,
            sentiment,
            department,
            sortBy,
            sortOrder,
            starredFirst: starredFirst === 'true'
        };

        // Parse boolean filters
        if (isRead !== undefined) filters.isRead = isRead === 'true';
        if (isStarred !== undefined) filters.isStarred = isStarred === 'true';
        if (isArchived !== undefined) filters.isArchived = isArchived === 'true';
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;

        const result = await VCDocument.getAll(parseInt(page), parseInt(limit), filters);

        // Parse JSON fields for each document
        const documents = result.documents.map(document => ({
            ...document,
            ai_key_points: document.ai_key_points ? JSON.parse(document.ai_key_points) : [],
            ai_concerns: document.ai_concerns ? JSON.parse(document.ai_concerns) : [],
            ai_highlights: document.ai_highlights ? JSON.parse(document.ai_highlights) : [],
            ai_recommendations: document.ai_recommendations ? JSON.parse(document.ai_recommendations) : []
        }));

        res.json({
            success: true,
            documents,
            total: result.total,
            page: result.page,
            limit: result.limit,
            totalPages: result.totalPages
        });

    } catch (error) {
        console.error('Get VC documents error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch documents'
        });
    }
});

/**
 * GET /api/vc-documents/stats
 * Get document statistics
 */
router.get('/stats', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const stats = await VCDocument.getStats();
        const categoryStats = await VCDocument.getCategoryStats();
        const recentDocuments = await VCDocument.getRecent(5);
        const concernDocuments = await VCDocument.getDocumentsWithConcerns(5);

        res.json({
            success: true,
            stats,
            categoryBreakdown: categoryStats,
            recentDocuments,
            concernDocuments
        });

    } catch (error) {
        console.error('Get VC document stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics'
        });
    }
});

/**
 * GET /api/vc-documents/categories
 * Get list of document categories
 */
router.get('/categories', authenticateToken, requireVCAccess, async (req, res) => {
    const categories = [
        { value: 'policy', label: 'Policy', icon: 'fa-scale-balanced' },
        { value: 'regulation', label: 'Regulation', icon: 'fa-gavel' },
        { value: 'memo', label: 'Memo', icon: 'fa-note-sticky' },
        { value: 'circular', label: 'Circular', icon: 'fa-bullhorn' },
        { value: 'directive', label: 'Directive', icon: 'fa-compass' },
        { value: 'agreement', label: 'Agreement', icon: 'fa-handshake' },
        { value: 'minutes', label: 'Minutes', icon: 'fa-clipboard' },
        { value: 'budget', label: 'Budget', icon: 'fa-coins' },
        { value: 'audit', label: 'Audit', icon: 'fa-clipboard-check' },
        { value: 'strategy', label: 'Strategy', icon: 'fa-chart-line' },
        { value: 'research', label: 'Research', icon: 'fa-flask' },
        { value: 'compliance', label: 'Compliance', icon: 'fa-shield-check' },
        { value: 'operations', label: 'Operations', icon: 'fa-gears' },
        { value: 'other', label: 'Other', icon: 'fa-folder' }
    ];

    res.json({ success: true, categories });
});

/**
 * GET /api/vc-documents/access-check
 * Check if the current user has VC documents access
 */
router.get('/access-check', authenticateToken, async (req, res) => {
    try {
        const emailParam = String(req.query.email || '').trim();
        if (emailParam) {
            if (req.user.role !== 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Super Admin access required.'
                });
            }

            const result = await VCDocument.checkEmailAccess(emailParam);
            return res.json({
                success: true,
                hasAccess: result.hasAccess,
                checkedEmail: result.normalizedEmail,
                allowedByWhitelist: result.allowedByWhitelist,
                user: result.user,
                allowedEmails: VCDocument.getAllowedEmails()
            });
        }

        const hasAccess = await VCDocument.checkUserAccess(req.user.id);
        const response = {
            success: true,
            hasAccess,
            user: {
                id: req.user.id,
                email: req.user.email,
                role: req.user.role
            }
        };

        if (req.user.role === 'superadmin') {
            response.allowedEmails = VCDocument.getAllowedEmails();
        }

        res.json(response);
    } catch (error) {
        console.error('VC access check error:', error);
        res.status(500).json({
            success: false,
            error: 'Access check failed'
        });
    }
});

/**
 * GET /api/vc-documents/departments
 * Get list of departments that have uploaded documents
 */
router.get('/departments', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const departments = await VCDocument.getDepartments();
        res.json({ success: true, departments });
    } catch (error) {
        console.error('Get departments error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch departments'
        });
    }
});

/**
 * GET /api/vc-documents/:id
 * Get a single document by ID
 */
router.get('/:id', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const document = await VCDocument.findById(req.params.id);

        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Parse JSON fields
        const parsedDocument = {
            ...document,
            ai_key_points: document.ai_key_points ? JSON.parse(document.ai_key_points) : [],
            ai_concerns: document.ai_concerns ? JSON.parse(document.ai_concerns) : [],
            ai_highlights: document.ai_highlights ? JSON.parse(document.ai_highlights) : [],
            ai_recommendations: document.ai_recommendations ? JSON.parse(document.ai_recommendations) : []
        };

        // Get notes for this user
        const notes = await vcDocumentService.getNotes(document.id, req.user.id);

        res.json({
            success: true,
            document: parsedDocument,
            notes
        });

    } catch (error) {
        console.error('Get VC document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch document'
        });
    }
});

/**
 * GET /api/vc-documents/:id/content
 * Get the full text content of a document
 */
router.get('/:id/content', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const document = await VCDocument.findById(req.params.id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        const { contentHtml, contentText } = await getDocumentContent(document);

        let tableOfContents = [];
        let documentContent = '';

        if (contentHtml) {
            const { toc, processedHtml } = processHtmlForViewer(contentHtml);
            tableOfContents = toc;
            documentContent = processedHtml;
        } else {
            const { toc, processedHtml } = processTextForViewer(contentText || '');
            tableOfContents = toc;
            documentContent = processedHtml;
        }

        res.json({
            success: true,
            documentId: document.id,
            title: document.title,
            hasHtml: !!contentHtml,
            tableOfContents,
            content: documentContent
        });

    } catch (error) {
        console.error('Get document content error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch document content'
        });
    }
});

/**
 * POST /api/vc-documents/upload
 * Upload a new document
 */
router.post('/upload', authenticateToken, upload.single('file'), handleVCDocumentUploadError, async (req, res) => {
    try {
        const { title, description, category, documentDate, department } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

        if (!title) {
            return res.status(400).json({
                success: false,
                error: 'Document title is required'
            });
        }

        // Create document record
        const documentId = await VCDocument.create({
            title: title || file.originalname,
            description,
            category: category || 'other',
            fileName: file.originalname,
            filePath: file.path,
            fileType: path.extname(file.originalname).toLowerCase(),
            fileSize: file.size,
            uploadedBy: req.user.id,
            documentDate: documentDate || null,
            department: department || req.user.department
        });

        // Log audit trail
        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_document_upload',
            resourceType: 'vc_document',
            resourceId: documentId,
            details: { title, category, fileName: file.originalname }
        });

        // Process document in background
        vcDocumentService.processDocument(documentId).catch(err => {
            console.error(`Background processing failed for document ${documentId}:`, err);
        });

        res.json({
            success: true,
            message: 'Document uploaded successfully. Processing will begin shortly.',
            documentId
        });

    } catch (error) {
        console.error('Upload VC document error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to upload document'
        });
    }
});

/**
 * POST /api/vc-documents/:id/process
 * Manually trigger processing/reprocessing of a document
 */
router.post('/:id/process', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const document = await VCDocument.findById(req.params.id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        // Start processing in background
        vcDocumentService.processDocument(req.params.id).catch(err => {
            console.error(`Processing failed for document ${req.params.id}:`, err);
        });

        res.json({
            success: true,
            message: 'Document processing started'
        });

    } catch (error) {
        console.error('Process document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start processing'
        });
    }
});

/**
 * POST /api/vc-documents/:id/reanalyze
 * Re-run AI analysis on a document
 */
router.post('/:id/reanalyze', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const document = await VCDocument.findById(req.params.id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        const analysis = await vcDocumentService.reanalyzeDocument(req.params.id);

        res.json({
            success: true,
            message: 'Document re-analyzed successfully',
            analysis
        });

    } catch (error) {
        console.error('Reanalyze document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to re-analyze document'
        });
    }
});

/**
 * PUT /api/vc-documents/:id
 * Update document metadata
 */
router.put('/:id', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { title, description, category, documentDate, department } = req.body;
        
        const updated = await VCDocument.update(req.params.id, {
            title,
            description,
            category,
            document_date: documentDate,
            department
        });

        if (!updated) {
            return res.status(404).json({
                success: false,
                error: 'Document not found or no changes made'
            });
        }

        res.json({
            success: true,
            message: 'Document updated successfully'
        });

    } catch (error) {
        console.error('Update document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update document'
        });
    }
});

/**
 * POST /api/vc-documents/:id/read
 * Mark document as read
 */
router.post('/:id/read', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCDocument.markAsRead(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to mark as read'
        });
    }
});

/**
 * POST /api/vc-documents/:id/star
 * Toggle starred status
 */
router.post('/:id/star', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCDocument.toggleStarred(req.params.id);
        const document = await VCDocument.findById(req.params.id);
        res.json({
            success: true,
            isStarred: document?.is_starred || false
        });
    } catch (error) {
        console.error('Toggle star error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to toggle star'
        });
    }
});

/**
 * POST /api/vc-documents/:id/archive
 * Archive a document
 */
router.post('/:id/archive', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCDocument.archive(req.params.id);
        res.json({ success: true, message: 'Document archived' });
    } catch (error) {
        console.error('Archive error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to archive document'
        });
    }
});

/**
 * POST /api/vc-documents/:id/unarchive
 * Unarchive a document
 */
router.post('/:id/unarchive', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCDocument.unarchive(req.params.id);
        res.json({ success: true, message: 'Document unarchived' });
    } catch (error) {
        console.error('Unarchive error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to unarchive document'
        });
    }
});

/**
 * DELETE /api/vc-documents/:id
 * Delete a document (soft delete)
 */
router.delete('/:id', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        // Only superadmin can delete
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmin can delete documents'
            });
        }

        await VCDocument.delete(req.params.id);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_document_delete',
            resourceType: 'vc_document',
            resourceId: req.params.id,
            details: { soft_delete: true }
        });

        res.json({ success: true, message: 'Document deleted' });

    } catch (error) {
        console.error('Delete document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete document'
        });
    }
});

/**
 * DELETE /api/vc-documents/:id/hard
 * Permanently delete a document (hard delete)
 */
router.delete('/:id/hard', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmin can delete documents'
            });
        }

        const document = await VCDocument.findById(req.params.id);
        if (!document) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }

        if (!document.is_archived) {
            return res.status(400).json({
                success: false,
                error: 'Archive the document before permanent deletion'
            });
        }

        await VCDocument.hardDelete(req.params.id);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_document_delete',
            resourceType: 'vc_document',
            resourceId: req.params.id,
            details: { hard_delete: true }
        });

        res.json({ success: true, message: 'Document permanently deleted' });
    } catch (error) {
        console.error('Hard delete document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete document'
        });
    }
});

// ========== NOTES ENDPOINTS ==========

/**
 * POST /api/vc-documents/:id/notes
 * Add a note to a document
 */
router.post('/:id/notes', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { noteText } = req.body;
        if (!noteText) {
            return res.status(400).json({
                success: false,
                error: 'Note text is required'
            });
        }

        const noteId = await vcDocumentService.addNote(req.params.id, req.user.id, noteText);
        res.json({
            success: true,
            noteId,
            message: 'Note added'
        });

    } catch (error) {
        console.error('Add note error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add note'
        });
    }
});

/**
 * PUT /api/vc-documents/:id/notes/:noteId
 * Update a note
 */
router.put('/:id/notes/:noteId', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { noteText } = req.body;
        const updated = await vcDocumentService.updateNote(req.params.noteId, req.user.id, noteText);
        
        if (!updated) {
            return res.status(404).json({
                success: false,
                error: 'Note not found'
            });
        }

        res.json({ success: true, message: 'Note updated' });

    } catch (error) {
        console.error('Update note error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update note'
        });
    }
});

/**
 * DELETE /api/vc-documents/:id/notes/:noteId
 * Delete a note
 */
router.delete('/:id/notes/:noteId', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const deleted = await vcDocumentService.deleteNote(req.params.noteId, req.user.id);
        
        if (!deleted) {
            return res.status(404).json({
                success: false,
                error: 'Note not found'
            });
        }

        res.json({ success: true, message: 'Note deleted' });

    } catch (error) {
        console.error('Delete note error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete note'
        });
    }
});

// ========== CHAT ENDPOINTS ==========

/**
 * POST /api/vc-documents/:id/chat/sessions
 * Create a new chat session for a document
 */
router.post('/:id/chat/sessions', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const session = await vcDocumentService.createChatSession(req.params.id, req.user.id);
        res.json({
            success: true,
            session
        });

    } catch (error) {
        console.error('Create chat session error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create chat session'
        });
    }
});

/**
 * GET /api/vc-documents/:id/chat/sessions
 * Get all chat sessions for a document
 */
router.get('/:id/chat/sessions', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const sessions = await vcDocumentService.getChatSessions(req.params.id, req.user.id);
        res.json({
            success: true,
            sessions
        });

    } catch (error) {
        console.error('Get chat sessions error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch chat sessions'
        });
    }
});

/**
 * GET /api/vc-documents/chat/:sessionToken/history
 * Get chat history for a session
 */
router.get('/chat/:sessionToken/history', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const messages = await vcDocumentService.getChatHistory(req.params.sessionToken);
        res.json({
            success: true,
            messages: messages.map(msg => ({
                id: msg.id,
                role: msg.role,
                content: msg.content,
                audioUrl: msg.audio_url,
                createdAt: msg.created_at
            }))
        });

    } catch (error) {
        console.error('Get chat history error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch chat history'
        });
    }
});

/**
 * POST /api/vc-documents/chat/:sessionToken
 * Send a message in a chat session
 */
router.post('/chat/:sessionToken', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { message, voice, withAudio } = req.body;
        if (!message) {
            return res.status(400).json({
                success: false,
                error: 'Message is required'
            });
        }

        const response = await vcDocumentService.chat(req.params.sessionToken, message, req.user.id, {
            voice,
            withAudio: withAudio === true || withAudio === 'true'
        });
        res.json({
            success: true,
            response: response.message,
            audioUrl: response.audioUrl,
            sessionToken: response.sessionToken
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to process message'
        });
    }
});

// ========== SEARCH ENDPOINTS ==========

/**
 * GET /api/vc-documents/search
 * Search documents
 */
router.get('/search', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { q, category, limit } = req.query;
        if (!q) {
            return res.status(400).json({
                success: false,
                error: 'Search query is required'
            });
        }

        const results = await vcDocumentService.searchDocuments(q, req.user.id, {
            category,
            limit: parseInt(limit) || 20
        });

        res.json({
            success: true,
            results
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({
            success: false,
            error: 'Search failed'
        });
    }
});

/**
 * GET /api/vc-documents/semantic-search
 * Semantic search across document content
 */
router.get('/semantic-search', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { q, category, limit } = req.query;
        if (!q) {
            return res.status(400).json({
                success: false,
                error: 'Search query is required'
            });
        }

        const results = await vcDocumentService.semanticSearch(q, {
            category,
            limit: parseInt(limit) || 10
        });

        res.json({
            success: true,
            results
        });

    } catch (error) {
        console.error('Semantic search error:', error);
        res.status(500).json({
            success: false,
            error: 'Search failed'
        });
    }
});

// ========== ACCESS MANAGEMENT ENDPOINTS ==========

/**
 * GET /api/vc-documents/access/users
 * Get users with VC documents access (superadmin only)
 */
router.get('/access/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Superadmin access required'
            });
        }

        const users = await VCDocument.getUsersWithAccess();
        res.json({ success: true, users });

    } catch (error) {
        console.error('Get access users error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch users'
        });
    }
});

/**
 * POST /api/vc-documents/access/grant/:userId
 * Grant VC documents access to a user (superadmin only)
 */
router.post('/access/grant/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Superadmin access required'
            });
        }

        return res.status(403).json({
            success: false,
            error: 'VC Documents access is restricted to a fixed allowlist.'
        });

    } catch (error) {
        console.error('Grant access error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to grant access'
        });
    }
});

/**
 * POST /api/vc-documents/access/revoke/:userId
 * Revoke VC documents access from a user (superadmin only)
 */
router.post('/access/revoke/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Superadmin access required'
            });
        }

        return res.status(403).json({
            success: false,
            error: 'VC Documents access is restricted to a fixed allowlist.'
        });

    } catch (error) {
        console.error('Revoke access error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to revoke access'
        });
    }
});

/**
 * GET /api/vc-documents/access/check
 * Check if current user has VC documents access
 */
router.get('/access/check', authenticateToken, async (req, res) => {
    try {
        const hasAccess = await VCDocument.checkUserAccess(req.user.id);
        res.json({
            success: true,
            hasAccess
        });
    } catch (error) {
        console.error('Check access error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check access'
        });
    }
});

/**
 * GET /api/vc-documents/:id/download
 * Download the original document file
 */
router.get('/:id/download', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const document = await VCDocument.findById(req.params.id);
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
                error: 'Document file not found'
            });
        }

        res.download(document.file_path, document.file_name);

    } catch (error) {
        console.error('Download document error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download document'
        });
    }
});

// =========================
// VC Document Content Helpers
// =========================

const processedContentDir = path.join(__dirname, '../../uploads/vc_documents_processed');

async function readIfExists(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

function sanitizeHtmlForViewer(html) {
    if (!html) return '';
    let sanitized = String(html);

    sanitized = sanitized.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '');
    sanitized = sanitized.replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '');
    sanitized = sanitized.replace(/<\s*iframe[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, '');
    sanitized = sanitized.replace(/<\s*(object|embed|link|meta|base)[^>]*>/gi, '');

    sanitized = sanitized.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
    sanitized = sanitized.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');

    sanitized = sanitized.replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '');
    sanitized = sanitized.replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, '');

    sanitized = sanitized.replace(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/gi, (match, quote, css) => {
        const cleaned = css
            .replace(/expression\s*\([^)]*\)/gi, '')
            .replace(/url\(\s*['"]?\s*javascript:[^)]+?\)/gi, 'url("")');
        return ` style=${quote}${cleaned}${quote}`;
    });

    return sanitized;
}

function mergeChunksWithOverlap(chunks, maxOverlap = 400) {
    if (!chunks || chunks.length === 0) return '';
    let fullText = '';

    for (const chunk of chunks) {
        const raw = String(chunk?.content || '').trim();
        if (!raw) continue;

        if (!fullText) {
            fullText = raw;
            continue;
        }

        const maxLen = Math.min(maxOverlap, fullText.length, raw.length);
        let overlap = 0;

        for (let len = maxLen; len >= 30; len--) {
            if (fullText.slice(-len) === raw.slice(0, len)) {
                overlap = len;
                break;
            }
        }

        const appendText = overlap > 0 ? raw.slice(overlap) : raw;
        if (appendText.trim()) {
            fullText += `\n\n${appendText}`;
        }
    }

    return fullText;
}

async function getDocumentContent(document) {
    await fs.mkdir(processedContentDir, { recursive: true });

    const ext = path.extname(document.file_name || document.file_path || '').toLowerCase();
    const textPath = path.join(processedContentDir, `${document.id}.txt`);
    const htmlPath = path.join(processedContentDir, `${document.id}.html`);

    let contentText = await readIfExists(textPath);
    let contentHtml = await readIfExists(htmlPath);

    if (!contentText) {
        try {
            contentText = await documentProcessor.extractText(document.file_path, document.file_type);
            if (contentText) {
                await fs.writeFile(textPath, contentText, 'utf8');
            }
        } catch (err) {
            console.warn('[VC Documents] Extract text failed, falling back to chunks:', err.message);
        }
    }

    if (!contentHtml && (ext === '.docx' || ext === '.doc')) {
        try {
            contentHtml = await documentProcessor.extractHtmlFromWord(document.file_path);
            if (contentHtml) {
                await fs.writeFile(htmlPath, contentHtml, 'utf8');
            }
        } catch (err) {
            console.warn('[VC Documents] Extract HTML failed:', err.message);
        }
    }

    if (!contentText) {
        const chunks = await VCDocumentChunk.getContentByDocumentId(document.id);
        contentText = mergeChunksWithOverlap(chunks);
    }

    return { contentText, contentHtml };
}

// Process HTML content for viewer - extract TOC and add navigation IDs
function processHtmlForViewer(html) {
    const toc = [];
    let sectionId = 0;

    // Normalize HTML - convert <b> to <strong> for consistency
    let processedHtml = sanitizeHtmlForViewer(html)
        .replace(/<b(\s[^>]*)?>([^<]*)<\/b>/gi, '<strong$1>$2</strong>')
        .replace(/<span[^>]*font-weight:\s*bold[^>]*>([^<]*)<\/span>/gi, '<strong>$1</strong>')
        .replace(/<span[^>]*font-weight:\s*700[^>]*>([^<]*)<\/span>/gi, '<strong>$1</strong>');

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(CHAPTER\s+[IVXLCDM\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(PART\s+[IVXLCDM\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(SECTION\s+[\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(Section\s+\d+[\.\-\s][^<]{0,80})<\/strong>\s*<\/p>/gi,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(\d+\.\s+[A-Z][^<]{2,60})<\/strong>\s*<\/p>/g,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*([\d]+\.[\d\.]*\s*[A-Z][^<]{2,60})<\/strong>\s*<\/p>/g,
        '<h3 class="doc-heading doc-heading-3">$1</h3>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(ARTICLE\s+[IVXLCDM\d]+[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(SCHEDULE[S]?\s*[IVXLCDM\d]*[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*(THE\s+[A-Z][A-Z\s]+ACT[,\s]+\d{4}[^<]*)<\/strong>\s*<\/p>/gi,
        '<h1 class="doc-heading doc-heading-1">$1</h1>'
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*([A-Z][A-Z\s\-,]{3,60})\s*<\/strong>\s*<\/p>/g,
        (match, text) => {
            const cleanText = text.trim();
            if (cleanText.length >= 4 && cleanText.length < 80 && cleanText === cleanText.toUpperCase()) {
                return `<h3 class="doc-heading doc-heading-3">${cleanText}</h3>`;
            }
            return match;
        }
    );

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>\s*<span[^>]*>\s*((?:CHAPTER|PART|SECTION|ARTICLE)\s+[IVXLCDM\d]+[^<]*)\s*<\/span>\s*<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

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

    processedHtml = processedHtml.replace(
        /<p[^>]*>\s*<strong[^>]*>((?:CHAPTER|PART|SECTION|ARTICLE|SCHEDULE)\s+[IVXLCDM\d]+[^<]*(?:<[^>]+>[^<]*<\/[^>]+>)?[^<]*)<\/strong>\s*<\/p>/gi,
        '<h2 class="doc-heading doc-heading-2">$1</h2>'
    );

    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
    let match;
    const headings = [];

    while ((match = headingRegex.exec(processedHtml)) !== null) {
        const level = parseInt(match[1], 10);
        const text = match[0].replace(/<[^>]+>/g, '').trim();
        if (text.length > 0 && text.length < 150) {
            headings.push({
                fullMatch: match[0],
                level,
                text,
                index: match.index
            });
        }
    }

    const headingIds = headings.map((h, idx) => `section-${idx}`);

    for (let i = headings.length - 1; i >= 0; i--) {
        const h = headings[i];
        const id = headingIds[i];
        const newHeading = `<h${h.level} id="${id}" class="doc-heading doc-heading-${h.level}">${h.text}</h${h.level}>`;
        processedHtml = processedHtml.substring(0, h.index) + newHeading + processedHtml.substring(h.index + h.fullMatch.length);
    }

    headings.forEach((h, idx) => {
        toc.push({
            id: headingIds[idx],
            level: h.level,
            title: h.text.substring(0, 100),
            sectionIndex: idx
        });
    });

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

function preprocessTextForHeadings(text) {
    let processed = text
        .replace(/\d+\s*\|\s*P\s*a\s*g\s*e/gi, '\n')
        .replace(/Page\s+\d+\s+of\s+\d+/gi, '\n')
        .replace(/^\d+\s*$/gm, '')
        .replace(/[ \t]+/g, ' ');

    processed = processed.replace(/\s+(PART\s+[IVXLCDM\d]+\s*[-\u2013\u2014:]\s*[A-Z])/gi, '\n\n$1');
    processed = processed.replace(/\s+(CHAPTER\s+[IVXLCDM\d]+)/gi, '\n\n$1');
    processed = processed.replace(/\s+(SECTION\s+\d+\s*:\s*[A-Z])/gi, '\n\n$1');
    processed = processed.replace(/\s+(SECTION\s+\d+[\.\s])/gi, '\n\n$1');
    processed = processed.replace(/\s+(ARTICLE\s+[IVXLCDM\d]+)/gi, '\n\n$1');
    processed = processed.replace(/\s+((?:FIRST|SECOND|THIRD|FOURTH|FIFTH)?\s*SCHEDULE[S]?)/gi, '\n\n$1');
    processed = processed.replace(/\s+(ARRANGEMENT[S]?\s+OF\s+SECTIONS?)/gi, '\n\n$1');
    processed = processed.replace(/\s+(A\s+LAW\s+to\s+establish)/gi, '\n\n$1');
    processed = processed.replace(/\s+(ENACTED\s+by)/gi, '\n\n$1');
    processed = processed.replace(/\s+(PRELIMINARY|INTERPRETATION|MISCELLANEOUS|TRANSITIONAL|COMMENCEMENT)\s/gi, '\n\n$1 ');
    processed = processed.replace(/\s+(\d+\.\d+\s+[A-Z][a-z]+)/g, '\n\n$1');
    processed = processed.replace(/\s+(\d+\.\s+[A-Z][a-z]+(?:\s+(?:of|and|the|with|for)\s+)?[A-Za-z]+)/g, '\n$1');

    return processed;
}

function processTextForViewer(text) {
    const toc = [];

    const preprocessedText = preprocessTextForHeadings(text);
    const lines = preprocessedText.split('\n');

    let processedHtml = '';
    let sectionId = 0;
    let currentParagraph = [];

    const cleanLine = (line) => {
        return line
            .replace(/[~]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    };

    const headingPatterns = [
        /^(CHAPTER|PART|SECTION|ARTICLE|SCHEDULE)\s+[IVXLCDMivxlcdm\d]+/i,
        /^(PART|CHAPTER)\s+[IVXLCDM\d]+\s*[-\u2013\u2014:]\s*.+/i,
        /^SECTION\s+\d+\s*:\s*[A-Z]/i,
        /^(First|Second|Third|Fourth|Fifth)\s+Schedule/i,
        /^[\dIVXLCDMivxlcdm]+\.\s+[A-Z]/,
        /^[A-Z][A-Z\s,]{8,50}$/,
        /^\d+\.\d+\s+[A-Z][a-z]/,
        /^[\d]+\.[\d\.]*\s+[A-Z]/,
        /^Section\s+\d+[\.\-\s:]/i,
        /^THE\s+[A-Z][A-Z\s]+(?:ACT|LAW|BILL)[,\s]+\d{4}/i,
        /^[A-Z][A-Z\s]+(?:ACT|LAW|BILL)[,\s]+\d{4}/i,
        /^\d+\.\s+[A-Z][A-Z\s]{5,}$/,
        /^ARRANGEMENT[S]?\s+OF\s+SECTIONS?/i,
        /^PRELIMINARY/i,
        /^INTERPRETATION/i,
        /^MISCELLANEOUS/i,
        /^TRANSITIONAL/i,
        /^COMMENCEMENT/i,
        /^SHORT\s+TITLE/i,
        /^GOVERNMENT\s+OF\s+/i,
        /^FUNCTIONS\s+OF\s+THE\s+/i,
        /^POWERS\s+OF\s+/i,
        /^ESTABLISHMENT\s+/i,
        /^A\s+LAW\s+to\s+establish/i,
        /^ENACTED\s+by/i,
        /^\d+\.\s+[A-Z][a-z]+(?:\s+(?:of|and|the)\s+)?(?:the\s+)?[A-Z]/,
        /^MANUAL\s+OF\s+/i,
        /^BAYELSA\s+MEDICAL\s+UNIVERSITY/i,
        /^INTRODUCTION$/i,
        /^OBJECTIVES?$/i,
        /^SCOPE$/i,
        /^DEFINITIONS?$/i,
        /^APPENDIX/i,
        /^ANNEX/i,
    ];

    const isHeading = (line) => {
        const trimmed = cleanLine(line);
        if (trimmed.length < 3 || trimmed.length > 150) return false;
        if (/^\d+$/.test(trimmed)) return false;
        if (/^page\s+\d+/i.test(trimmed)) return false;
        return headingPatterns.some(pattern => pattern.test(trimmed));
    };

    const getHeadingLevel = (text) => {
        if (/^(GOVERNMENT|THE\s+[A-Z]|BAYELSA|MANUAL\s+OF)/i.test(text)) return 1;
        if (/^(PART|CHAPTER|SCHEDULE|ARTICLE)\s+/i.test(text)) return 2;
        if (/^SECTION\s+\d+\s*:/i.test(text)) return 2;
        if (/^(First|Second|Third|Fourth|Fifth)\s+Schedule/i.test(text)) return 2;
        if (/^ARRANGEMENT/i.test(text)) return 2;
        if (/^\d+\.\d+\s+/i.test(text)) return 3;
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
            processedHtml += `<h${level} id="${id}" class="doc-heading doc-heading-${level}">${escapeHtmlBasic(trimmed)}</h${level}>\n`;
            toc.push({
                id,
                level,
                title: trimmed.substring(0, 100),
                sectionIndex: sectionId
            });
            sectionId++;
        } else {
            currentParagraph.push(trimmed);
        }
    }

    flushParagraph();

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

function escapeHtmlBasic(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = router;
