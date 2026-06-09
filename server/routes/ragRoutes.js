const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const vectorStore = require('../services/vectorStore');
const AuditTrail = require('../models/AuditTrail');

const router = express.Router();

// Admin-only: rebuild FAISS index from DB chunks
router.post('/rebuild', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await vectorStore.rebuildFromDatabase();

        await AuditTrail.log({
            userId: req.user.id,
            action: 'RAG_INDEX_REBUILT',
            entityType: 'rag',
            details: result,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('RAG rebuild error:', error);
        res.status(500).json({ success: false, error: 'Failed to rebuild RAG index' });
    }
});

module.exports = router;
