/**
 * VC Reports API Routes
 * Handles all endpoints for the VC Reports system
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const VCReport = require('../models/VCReport');
const VCReportChunk = require('../models/VCReportChunk');
const AuditTrail = require('../models/AuditTrail');
const vcReportService = require('../services/vcReportService');
const documentProcessor = require('../services/documentProcessor');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ========== FILE UPLOAD CONFIGURATION ==========

const uploadDir = path.join(__dirname, '../../uploads/vc_reports');

// Ensure upload directory exists
(async () => {
    try {
        await fs.mkdir(uploadDir, { recursive: true });
    } catch (err) {
        console.error('Failed to create VC reports upload directory:', err);
    }
})();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `report-${uniqueSuffix}${ext}`);
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

const MAX_VC_REPORT_SIZE = parseInt(process.env.MAX_VC_REPORT_SIZE || process.env.MAX_FILE_SIZE, 10) || 52428800;
const MAX_VC_REPORT_SIZE_MB = Math.max(1, Math.round(MAX_VC_REPORT_SIZE / (1024 * 1024)));

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_VC_REPORT_SIZE
    }
});

const handleVCReportUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                error: `File too large. Maximum size allowed is ${MAX_VC_REPORT_SIZE_MB}MB.`
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
 * Middleware to check VC reports access
 */
const requireVCAccess = async (req, res, next) => {
    try {
        const hasAccess = await VCReport.checkUserAccess(req.user.id);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'You do not have access to VC Reports'
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

// ========== REPORT CRUD ENDPOINTS ==========

/**
 * GET /api/vc-reports
 * Get all reports with pagination and filters
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

        const result = await VCReport.getAll(parseInt(page), parseInt(limit), filters);

        // Parse JSON fields for each report
        const reports = result.reports.map(report => ({
            ...report,
            ai_key_points: report.ai_key_points ? JSON.parse(report.ai_key_points) : [],
            ai_concerns: report.ai_concerns ? JSON.parse(report.ai_concerns) : [],
            ai_highlights: report.ai_highlights ? JSON.parse(report.ai_highlights) : [],
            ai_recommendations: report.ai_recommendations ? JSON.parse(report.ai_recommendations) : []
        }));

        res.json({
            success: true,
            reports,
            total: result.total,
            page: result.page,
            limit: result.limit,
            totalPages: result.totalPages
        });

    } catch (error) {
        console.error('Get VC reports error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch reports'
        });
    }
});

/**
 * GET /api/vc-reports/stats
 * Get report statistics
 */
router.get('/stats', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const stats = await VCReport.getStats();
        const categoryStats = await VCReport.getCategoryStats();
        const recentReports = await VCReport.getRecent(5);
        const concernReports = await VCReport.getReportsWithConcerns(5);

        res.json({
            success: true,
            stats,
            categoryBreakdown: categoryStats,
            recentReports,
            concernReports
        });

    } catch (error) {
        console.error('Get VC report stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics'
        });
    }
});

/**
 * GET /api/vc-reports/categories
 * Get list of report categories
 */
router.get('/categories', authenticateToken, requireVCAccess, async (req, res) => {
    const categories = [
        { value: 'academic_affairs', label: 'Academic Affairs', icon: 'fa-graduation-cap' },
        { value: 'administrative', label: 'Administrative', icon: 'fa-building' },
        { value: 'financial', label: 'Financial', icon: 'fa-dollar-sign' },
        { value: 'security', label: 'Security', icon: 'fa-shield-alt' },
        { value: 'student_affairs', label: 'Student Affairs', icon: 'fa-user-graduate' },
        { value: 'staff_welfare', label: 'Staff Welfare', icon: 'fa-users' },
        { value: 'senate', label: 'Senate', icon: 'fa-landmark' },
        { value: 'infrastructure', label: 'Infrastructure', icon: 'fa-tools' },
        { value: 'research', label: 'Research', icon: 'fa-flask' },
        { value: 'community_service', label: 'Community Service', icon: 'fa-hands-helping' },
        { value: 'compliance_audit', label: 'Compliance & Audit', icon: 'fa-clipboard-check' },
        { value: 'strategic_planning', label: 'Strategic Planning', icon: 'fa-chart-line' },
        { value: 'other', label: 'Other', icon: 'fa-folder' }
    ];

    res.json({ success: true, categories });
});

/**
 * GET /api/vc-reports/access-check
 * Check if the current user has VC reports access
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

            const result = await VCReport.checkEmailAccess(emailParam);
            return res.json({
                success: true,
                hasAccess: result.hasAccess,
                checkedEmail: result.normalizedEmail,
                allowedByWhitelist: result.allowedByWhitelist,
                user: result.user,
                allowedEmails: VCReport.getAllowedEmails()
            });
        }

        const hasAccess = await VCReport.checkUserAccess(req.user.id);
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
            response.allowedEmails = VCReport.getAllowedEmails();
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
 * GET /api/vc-reports/departments
 * Get list of departments that have submitted reports
 */
router.get('/departments', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const departments = await VCReport.getDepartments();
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
 * GET /api/vc-reports/:id
 * Get a single report by ID
 */
router.get('/:id', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const report = await VCReport.findById(req.params.id);

        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Report not found'
            });
        }

        // Parse JSON fields
        const parsedReport = {
            ...report,
            ai_key_points: report.ai_key_points ? JSON.parse(report.ai_key_points) : [],
            ai_concerns: report.ai_concerns ? JSON.parse(report.ai_concerns) : [],
            ai_highlights: report.ai_highlights ? JSON.parse(report.ai_highlights) : [],
            ai_recommendations: report.ai_recommendations ? JSON.parse(report.ai_recommendations) : []
        };

        // Get notes for this user
        const notes = await vcReportService.getNotes(report.id, req.user.id);

        res.json({
            success: true,
            report: parsedReport,
            notes
        });

    } catch (error) {
        console.error('Get VC report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch report'
        });
    }
});

/**
 * GET /api/vc-reports/:id/content
 * Get the full text content of a report
 */
router.get('/:id/content', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const report = await VCReport.findById(req.params.id);
        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Report not found'
            });
        }

        const { contentHtml, contentText } = await getReportContent(report);

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
            reportId: report.id,
            title: report.title,
            hasHtml: !!contentHtml,
            tableOfContents,
            content: documentContent
        });

    } catch (error) {
        console.error('Get report content error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch report content'
        });
    }
});

/**
 * POST /api/vc-reports/upload
 * Upload a new report
 */
router.post('/upload', authenticateToken, upload.single('file'), handleVCReportUploadError, async (req, res) => {
    try {
        const { title, description, category, reportDate, department } = req.body;
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
                error: 'Report title is required'
            });
        }

        // Create report record
        const reportId = await VCReport.create({
            title: title || file.originalname,
            description,
            category: category || 'other',
            fileName: file.originalname,
            filePath: file.path,
            fileType: path.extname(file.originalname).toLowerCase(),
            fileSize: file.size,
            submittedBy: req.user.id,
            reportDate: reportDate || null,
            department: department || req.user.department
        });

        // Log audit trail
        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_report_upload',
            resourceType: 'vc_report',
            resourceId: reportId,
            details: { title, category, fileName: file.originalname }
        });

        // Process report in background
        vcReportService.processReport(reportId).catch(err => {
            console.error(`Background processing failed for report ${reportId}:`, err);
        });

        res.json({
            success: true,
            message: 'Report uploaded successfully. Processing will begin shortly.',
            reportId
        });

    } catch (error) {
        console.error('Upload VC report error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to upload report'
        });
    }
});

/**
 * POST /api/vc-reports/:id/process
 * Manually trigger processing/reprocessing of a report
 */
router.post('/:id/process', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const report = await VCReport.findById(req.params.id);
        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Report not found'
            });
        }

        // Start processing in background
        vcReportService.processReport(req.params.id).catch(err => {
            console.error(`Processing failed for report ${req.params.id}:`, err);
        });

        res.json({
            success: true,
            message: 'Report processing started'
        });

    } catch (error) {
        console.error('Process report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start processing'
        });
    }
});

/**
 * POST /api/vc-reports/:id/reanalyze
 * Re-run AI analysis on a report
 */
router.post('/:id/reanalyze', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const report = await VCReport.findById(req.params.id);
        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Report not found'
            });
        }

        const analysis = await vcReportService.reanalyzeReport(req.params.id);

        res.json({
            success: true,
            message: 'Report re-analyzed successfully',
            analysis
        });

    } catch (error) {
        console.error('Reanalyze report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to re-analyze report'
        });
    }
});

/**
 * PUT /api/vc-reports/:id
 * Update report metadata
 */
router.put('/:id', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { title, description, category, reportDate, department } = req.body;
        
        const updated = await VCReport.update(req.params.id, {
            title,
            description,
            category,
            report_date: reportDate,
            department
        });

        if (!updated) {
            return res.status(404).json({
                success: false,
                error: 'Report not found or no changes made'
            });
        }

        res.json({
            success: true,
            message: 'Report updated successfully'
        });

    } catch (error) {
        console.error('Update report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update report'
        });
    }
});

/**
 * POST /api/vc-reports/:id/read
 * Mark report as read
 */
router.post('/:id/read', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCReport.markAsRead(req.params.id);
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
 * POST /api/vc-reports/:id/star
 * Toggle starred status
 */
router.post('/:id/star', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCReport.toggleStarred(req.params.id);
        const report = await VCReport.findById(req.params.id);
        res.json({
            success: true,
            isStarred: report?.is_starred || false
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
 * POST /api/vc-reports/:id/archive
 * Archive a report
 */
router.post('/:id/archive', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCReport.archive(req.params.id);
        res.json({ success: true, message: 'Report archived' });
    } catch (error) {
        console.error('Archive error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to archive report'
        });
    }
});

/**
 * POST /api/vc-reports/:id/unarchive
 * Unarchive a report
 */
router.post('/:id/unarchive', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        await VCReport.unarchive(req.params.id);
        res.json({ success: true, message: 'Report unarchived' });
    } catch (error) {
        console.error('Unarchive error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to unarchive report'
        });
    }
});

/**
 * DELETE /api/vc-reports/:id
 * Delete a report (soft delete)
 */
router.delete('/:id', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        // Only superadmin can delete
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmin can delete reports'
            });
        }

        await VCReport.delete(req.params.id);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_report_delete',
            resourceType: 'vc_report',
            resourceId: req.params.id,
            details: { soft_delete: true }
        });

        res.json({ success: true, message: 'Report deleted' });

    } catch (error) {
        console.error('Delete report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete report'
        });
    }
});

// ========== NOTES ENDPOINTS ==========

/**
 * POST /api/vc-reports/:id/notes
 * Add a note to a report
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

        const noteId = await vcReportService.addNote(req.params.id, req.user.id, noteText);
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
 * PUT /api/vc-reports/:id/notes/:noteId
 * Update a note
 */
router.put('/:id/notes/:noteId', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const { noteText } = req.body;
        const updated = await vcReportService.updateNote(req.params.noteId, req.user.id, noteText);
        
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
 * DELETE /api/vc-reports/:id/notes/:noteId
 * Delete a note
 */
router.delete('/:id/notes/:noteId', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const deleted = await vcReportService.deleteNote(req.params.noteId, req.user.id);
        
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
 * POST /api/vc-reports/:id/chat/sessions
 * Create a new chat session for a report
 */
router.post('/:id/chat/sessions', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const session = await vcReportService.createChatSession(req.params.id, req.user.id);
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
 * GET /api/vc-reports/:id/chat/sessions
 * Get all chat sessions for a report
 */
router.get('/:id/chat/sessions', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const sessions = await vcReportService.getChatSessions(req.params.id, req.user.id);
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
 * GET /api/vc-reports/chat/:sessionToken/history
 * Get chat history for a session
 */
router.get('/chat/:sessionToken/history', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const messages = await vcReportService.getChatHistory(req.params.sessionToken);
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
 * POST /api/vc-reports/chat/:sessionToken
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

        const response = await vcReportService.chat(req.params.sessionToken, message, req.user.id, {
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
 * GET /api/vc-reports/search
 * Search reports
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

        const results = await vcReportService.searchReports(q, req.user.id, {
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
 * GET /api/vc-reports/semantic-search
 * Semantic search across report content
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

        const results = await vcReportService.semanticSearch(q, {
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
 * GET /api/vc-reports/access/users
 * Get users with VC reports access (superadmin only)
 */
router.get('/access/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Superadmin access required'
            });
        }

        const users = await VCReport.getUsersWithAccess();
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
 * POST /api/vc-reports/access/grant/:userId
 * Grant VC reports access to a user (superadmin only)
 */
router.post('/access/grant/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Superadmin access required'
            });
        }

        await VCReport.grantAccess(req.params.userId);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_reports_access_grant',
            resourceType: 'user',
            resourceId: req.params.userId
        });

        res.json({ success: true, message: 'Access granted' });

    } catch (error) {
        console.error('Grant access error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to grant access'
        });
    }
});

/**
 * POST /api/vc-reports/access/revoke/:userId
 * Revoke VC reports access from a user (superadmin only)
 */
router.post('/access/revoke/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Superadmin access required'
            });
        }

        await VCReport.revokeAccess(req.params.userId);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'vc_reports_access_revoke',
            resourceType: 'user',
            resourceId: req.params.userId
        });

        res.json({ success: true, message: 'Access revoked' });

    } catch (error) {
        console.error('Revoke access error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to revoke access'
        });
    }
});

/**
 * GET /api/vc-reports/access/check
 * Check if current user has VC reports access
 */
router.get('/access/check', authenticateToken, async (req, res) => {
    try {
        const hasAccess = await VCReport.checkUserAccess(req.user.id);
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
 * GET /api/vc-reports/:id/download
 * Download the original report file
 */
router.get('/:id/download', authenticateToken, requireVCAccess, async (req, res) => {
    try {
        const report = await VCReport.findById(req.params.id);
        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Report not found'
            });
        }

        // Check if file exists
        try {
            await fs.access(report.file_path);
        } catch {
            return res.status(404).json({
                success: false,
                error: 'Report file not found'
            });
        }

        res.download(report.file_path, report.file_name);

    } catch (error) {
        console.error('Download report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download report'
        });
    }
});

// =========================
// VC Report Content Helpers
// =========================

const processedContentDir = path.join(__dirname, '../../uploads/vc_reports_processed');

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

async function getReportContent(report) {
    await fs.mkdir(processedContentDir, { recursive: true });

    const ext = path.extname(report.file_name || report.file_path || '').toLowerCase();
    const textPath = path.join(processedContentDir, `${report.id}.txt`);
    const htmlPath = path.join(processedContentDir, `${report.id}.html`);

    let contentText = await readIfExists(textPath);
    let contentHtml = await readIfExists(htmlPath);

    if (!contentText) {
        try {
            contentText = await documentProcessor.extractText(report.file_path, report.file_type);
            if (contentText) {
                await fs.writeFile(textPath, contentText, 'utf8');
            }
        } catch (err) {
            console.warn('[VC Reports] Extract text failed, falling back to chunks:', err.message);
        }
    }

    if (!contentHtml && (ext === '.docx' || ext === '.doc')) {
        try {
            contentHtml = await documentProcessor.extractHtmlFromWord(report.file_path);
            if (contentHtml) {
                await fs.writeFile(htmlPath, contentHtml, 'utf8');
            }
        } catch (err) {
            console.warn('[VC Reports] Extract HTML failed:', err.message);
        }
    }

    if (!contentText) {
        const chunks = await VCReportChunk.getContentByReportId(report.id);
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
