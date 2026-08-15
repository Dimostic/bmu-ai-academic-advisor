const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const AuditTrail = require('../models/AuditTrail');
const documentLabService = require('../services/documentLabService');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { handleUploadError } = require('../middleware/upload');

const router = express.Router();
const LAB_UPLOAD_DIR = path.join(__dirname, '../../uploads/document-lab');
fs.mkdirSync(LAB_UPLOAD_DIR, { recursive: true });

const labStorage = multer.diskStorage({
    destination: async (req, file, cb) => {
        cb(null, LAB_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
    }
});

const labFileFilter = (req, file, cb) => {
    const allowedExtensions = new Set([
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.rtf', '.md',
        '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'
    ]);
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.has(ext)) return cb(null, true);
    cb(new Error('Invalid file type for Document Lab. Upload PDF, Office, text, Markdown, or image files.'), false);
};

const uploadLabDocument = multer({
    storage: labStorage,
    fileFilter: labFileFilter,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800
    }
});

router.get('/jobs', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const jobs = await documentLabService.listJobs(req.query.limit || 100);
        res.json({ success: true, jobs });
    } catch (error) {
        console.error('Document Lab list error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Document Lab jobs' });
    }
});

router.get('/jobs/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const job = await documentLabService.getJob(req.params.id);
        if (!job) return res.status(404).json({ success: false, error: 'Document Lab job not found' });
        res.json({ success: true, job });
    } catch (error) {
        console.error('Document Lab get error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Document Lab job' });
    }
});

router.post('/upload', authenticateToken, requireAdmin, uploadLabDocument.single('file'), handleUploadError, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        const job = await documentLabService.createFromUpload(req.file, req.user.id, req.body || {});
        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_LAB_UPLOADED',
            entityType: 'document_lab_job',
            entityId: job.id,
            details: { title: job.title, issueType: job.issueType, reviewStatus: job.reviewStatus },
            ipAddress: req.ip
        });
        res.status(201).json({ success: true, message: 'Document sent to Document Lab', job });
    } catch (error) {
        console.error('Document Lab upload error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create Document Lab job' });
    }
});

router.post('/from-document/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const job = await documentLabService.createFromDocument(req.params.id, req.user.id);
        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_SENT_TO_LAB',
            entityType: 'document',
            entityId: parseInt(req.params.id, 10),
            details: { labJobId: job.id, title: job.title, issueType: job.issueType },
            ipAddress: req.ip
        });
        res.status(201).json({ success: true, message: 'Document sent to Document Lab', job });
    } catch (error) {
        console.error('Document Lab from-document error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to send document to lab' });
    }
});

router.post('/import-flagged', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await documentLabService.importFlaggedDocuments(req.user.id, {
            limit: req.body?.limit,
            includeUnreviewed: req.body?.includeUnreviewed === true
        });
        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_LAB_IMPORT_FLAGGED',
            entityType: 'document_lab_job',
            details: {
                imported: result.imported,
                failed: result.failed,
                includeUnreviewed: req.body?.includeUnreviewed === true
            },
            ipAddress: req.ip
        });
        res.json({
            success: true,
            message: `Imported ${result.imported} flagged document(s) to Document Lab`,
            ...result
        });
    } catch (error) {
        console.error('Document Lab import flagged error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to import flagged documents' });
    }
});

router.post('/jobs/:id/analyze', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const job = await documentLabService.analyzeJob(req.params.id, { prepareOutputs: true });
        res.json({ success: true, message: 'Document Lab analysis completed', job });
    } catch (error) {
        console.error('Document Lab analyze error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to analyze lab job' });
    }
});

router.post('/jobs/:id/prepare', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const job = await documentLabService.prepareOutputs(req.params.id);
        res.json({ success: true, message: 'Draft outputs prepared', job });
    } catch (error) {
        console.error('Document Lab prepare error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to prepare outputs' });
    }
});

router.put('/outputs/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const output = await documentLabService.updateOutput(req.params.id, req.body || {});
        res.json({ success: true, message: 'Output updated and rechecked', output });
    } catch (error) {
        console.error('Document Lab output update error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to update output' });
    }
});

router.post('/outputs/:id/review', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const output = await documentLabService.reviewOutput(req.params.id);
        res.json({ success: true, message: 'Output readiness rechecked', output });
    } catch (error) {
        console.error('Document Lab output review error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to recheck output' });
    }
});

router.post('/outputs/:id/promote', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await documentLabService.promoteOutput(req.params.id, req.user.id, {
            force: req.body?.force === true
        });
        await AuditTrail.log({
            userId: req.user.id,
            action: 'DOCUMENT_LAB_OUTPUT_PROMOTED',
            entityType: 'document',
            entityId: result.documentId,
            details: { outputId: parseInt(req.params.id, 10) },
            ipAddress: req.ip
        });
        res.json({ success: true, message: 'Output promoted to Documents', ...result });
    } catch (error) {
        console.error('Document Lab promote error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to promote output' });
    }
});

module.exports = router;
