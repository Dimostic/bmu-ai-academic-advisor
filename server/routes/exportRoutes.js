const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const exportService = require('../services/exportService');
const AuditTrail = require('../models/AuditTrail');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// Export chat history
router.post('/chat-history', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { format = 'csv', userId, startDate, endDate, platform, limit } = req.body;

        const result = await exportService.exportChatHistory(req.user.id, {
            userId,
            startDate,
            endDate,
            platform,
            limit
        }, format);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'EXPORT_CHAT_HISTORY',
            details: { format, recordCount: result.recordCount },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Export completed',
            downloadUrl: `/api/exports/download/${result.filename}`,
            recordCount: result.recordCount
        });

    } catch (error) {
        console.error('Export chat history error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export chat history'
        });
    }
});

// Export documents list
router.post('/documents', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { format = 'csv', category, status } = req.body;

        const result = await exportService.exportDocuments({
            category,
            status
        }, format);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'EXPORT_DOCUMENTS',
            details: { format, recordCount: result.recordCount },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Export completed',
            downloadUrl: `/api/exports/download/${result.filename}`,
            recordCount: result.recordCount
        });

    } catch (error) {
        console.error('Export documents error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export documents'
        });
    }
});

// Export users list (superadmin only)
router.post('/users', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { format = 'csv', role } = req.body;

        const result = await exportService.exportUsers({ role }, format);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'EXPORT_USERS',
            details: { format, recordCount: result.recordCount },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Export completed',
            downloadUrl: `/api/exports/download/${result.filename}`,
            recordCount: result.recordCount
        });

    } catch (error) {
        console.error('Export users error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export users'
        });
    }
});

// Export audit trail (superadmin only)
router.post('/audit-trail', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { format = 'csv', startDate, endDate, action, limit } = req.body;

        const result = await exportService.exportAuditTrail({
            startDate,
            endDate,
            action,
            limit
        }, format);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'EXPORT_AUDIT_TRAIL',
            details: { format, recordCount: result.recordCount },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Export completed',
            downloadUrl: `/api/exports/download/${result.filename}`,
            recordCount: result.recordCount
        });

    } catch (error) {
        console.error('Export audit trail error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export audit trail'
        });
    }
});

// Export analytics
router.post('/analytics', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { format = 'json', days = 30 } = req.body;

        const result = await exportService.exportAnalytics({ days }, format);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'EXPORT_ANALYTICS',
            details: { format, days },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Export completed',
            downloadUrl: `/api/exports/download/${result.filename}`
        });

    } catch (error) {
        console.error('Export analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export analytics'
        });
    }
});

// Download exported file
router.get('/download/:filename', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(__dirname, '../../uploads/exports', filename);

        // Security check - prevent directory traversal
        if (filename.includes('..') || filename.includes('/')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid filename'
            });
        }

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({
                success: false,
                error: 'Export file not found'
            });
        }

        res.download(filePath, filename);

    } catch (error) {
        console.error('Download export error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download export'
        });
    }
});

// Get user's export history
router.get('/history', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const exports = await exportService.getUserExports(req.user.id, parseInt(page), parseInt(limit));

        res.json({
            success: true,
            exports
        });

    } catch (error) {
        console.error('Get export history error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch export history'
        });
    }
});

module.exports = router;
