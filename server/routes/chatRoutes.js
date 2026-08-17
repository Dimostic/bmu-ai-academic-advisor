const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const AuditTrail = require('../models/AuditTrail');
const User = require('../models/User');
const aiService = require('../services/aiService');
const audioService = require('../services/audioService');
const { authenticateToken, authenticateTokenAllowQuery, optionalAuth } = require('../middleware/auth');
const { chatMessageValidation } = require('../middleware/validation');
const { uploadAudio, handleUploadError } = require('../middleware/upload');
const { query } = require('../../config/db');

const router = express.Router();
const AUDIO_DIR = path.join(__dirname, '../../uploads/audio');
const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.webm', '.ogg', '.m4a', '.aiff']);

// Serve generated or uploaded audio securely
router.get('/audio/:filename', authenticateTokenAllowQuery, async (req, res) => {
    try {
        const { filename } = req.params;
        if (!filename || filename !== path.basename(filename)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid filename'
            });
        }

        const ext = path.extname(filename).toLowerCase();
        if (!ALLOWED_AUDIO_EXTS.has(ext)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid audio file type'
            });
        }

        const filePath = path.join(AUDIO_DIR, filename);
        await fs.access(filePath);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({
                success: false,
                error: 'Audio file not found'
            });
        }
        console.error('Audio fetch error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to load audio file'
        });
    }
});

// Get available AI models
router.get('/models', authenticateToken, async (req, res) => {
    try {
        const models = aiService.getAvailableModels(req.user.role);
        res.json({
            success: true,
            models
        });
    } catch (error) {
        console.error('Get models error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get available models'
        });
    }
});

// Get user's usage limits
router.get('/usage', authenticateToken, async (req, res) => {
    try {
        const usage = await aiService.getUserUsage(req.user.id);
        res.json({
            success: true,
            usage: {
                used: usage.used,
                limit: usage.limit,
                remaining: usage.remaining,
                unlimited: usage.unlimited,
                resetDate: getNextMonthDate()
            }
        });
    } catch (error) {
        console.error('Get usage error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get usage stats'
        });
    }
});

// Helper to get next month's start date
function getNextMonthDate() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

// Start a new chat session
router.post('/session/start', authenticateToken, async (req, res) => {
    try {
        const { platform = 'web' } = req.body;
        
        const session = await ChatSession.create(req.user.id, platform);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CHAT_SESSION_STARTED',
            entityType: 'chat_session',
            entityId: session.id,
            details: { platform },
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            session: {
                id: session.id,
                sessionToken: session.sessionToken,
                platform: session.platform
            }
        });

    } catch (error) {
        console.error('Session start error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start chat session'
        });
    }
});

// Send a message and get AI response
router.post('/message', authenticateToken, chatMessageValidation, async (req, res) => {
    try {
        const startTime = Date.now();
        const { message, sessionToken, model, documentIds } = req.body;
        const inventoryQuery = aiService.isDocumentInventoryQuery(message);
        const officerQuery = aiService.isPrincipalOfficerQuery(message);
        if (inventoryQuery || officerQuery) {
            console.log(`[ChatRoutes] Special query: "${message}" inventory=${inventoryQuery} officer=${officerQuery}`);
        }

        // Check monthly prompt limit
        const limitCheck = await User.checkPromptLimit(req.user.id);
        if (!limitCheck.allowed) {
            return res.status(429).json({
                success: false,
                error: `Monthly prompt limit reached (${limitCheck.limit} prompts). Your limit resets next month.`,
                code: 'PROMPT_LIMIT_EXCEEDED',
                usage: {
                    count: limitCheck.count,
                    limit: limitCheck.limit,
                    remaining: 0
                }
            });
        }

        // Get or create session
        let session;
        if (sessionToken) {
            session = await ChatSession.findByToken(sessionToken);
            if (!session || session.user_id !== req.user.id) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid session token'
                });
            }
        } else {
            // Create new session
            session = await ChatSession.create(req.user.id, 'web');
        }

        // Update session activity
        await ChatSession.updateActivity(session.id);

        // Save user message
        const userMessageId = await ChatMessage.create({
            sessionId: session.id,
            userId: req.user.id,
            messageType: 'text',
            sender: 'user',
            content: message
        });

        if (inventoryQuery) {
            const inventory = await aiService.getDocumentInventoryResponse({ documentIds });
            const responseTimeMs = Date.now() - startTime;
            const aiMessageId = await ChatMessage.create({
                sessionId: session.id,
                userId: req.user.id,
                messageType: 'text',
                sender: 'assistant',
                content: inventory.response,
                tokensUsed: 0,
                responseTimeMs,
                referencedDocuments: inventory.referencedDocuments
            });

            await User.incrementPromptCount(req.user.id);

            try {
                const currentMonthYear = new Date().toISOString().slice(0, 7);
                await query(`
                    INSERT INTO usage_logs (user_id, chat_message_id, model_id, prompt_tokens, completion_tokens, total_tokens, month_year)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    req.user.id,
                    aiMessageId,
                    'system',
                    0,
                    0,
                    0,
                    currentMonthYear
                ]);
            } catch (logError) {
                console.error('Failed to log usage:', logError.message);
            }

            const updatedUsage = await User.checkPromptLimit(req.user.id);

            return res.json({
                success: true,
                sessionToken: session.session_token || session.sessionToken,
                userMessage: {
                    id: userMessageId,
                    content: message,
                    timestamp: new Date()
                },
                aiResponse: {
                    id: aiMessageId,
                    content: inventory.response,
                    tokensUsed: 0,
                    responseTimeMs,
                    referencedDocuments: inventory.referencedDocuments,
                    model: 'system',
                    timestamp: new Date()
                },
                usage: updatedUsage
            });
        }

        if (officerQuery) {
            const officerResponse = await aiService.getPrincipalOfficerResponse(message);
            const responseTimeMs = Date.now() - startTime;
            const aiMessageId = await ChatMessage.create({
                sessionId: session.id,
                userId: req.user.id,
                messageType: 'text',
                sender: 'assistant',
                content: officerResponse.response,
                tokensUsed: 0,
                responseTimeMs,
                referencedDocuments: officerResponse.referencedDocuments
            });

            await User.incrementPromptCount(req.user.id);

            try {
                const currentMonthYear = new Date().toISOString().slice(0, 7);
                await query(`
                    INSERT INTO usage_logs (user_id, chat_message_id, model_id, prompt_tokens, completion_tokens, total_tokens, month_year)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    req.user.id,
                    aiMessageId,
                    'system',
                    0,
                    0,
                    0,
                    currentMonthYear
                ]);
            } catch (logError) {
                console.error('Failed to log usage:', logError.message);
            }

            const updatedUsage = await User.checkPromptLimit(req.user.id);

            return res.json({
                success: true,
                sessionToken: session.session_token || session.sessionToken,
                userMessage: {
                    id: userMessageId,
                    content: message,
                    timestamp: new Date()
                },
                aiResponse: {
                    id: aiMessageId,
                    content: officerResponse.response,
                    tokensUsed: 0,
                    responseTimeMs,
                    referencedDocuments: officerResponse.referencedDocuments,
                    model: 'system',
                    timestamp: new Date()
                },
                usage: updatedUsage
            });
        }

        // Get conversation history for context
        const history = await ChatMessage.getRecentContext(session.id, 10);

        // Generate AI response with optional model selection and document filtering
        const aiResponse = await aiService.generateResponse(message, history, {
            userRole: req.user.role,
            platform: 'web',
            userName: req.user.first_name,
            model: model,
            documentIds: documentIds // Filter context to specific documents
        });

        // Save AI response
        const aiMessageId = await ChatMessage.create({
            sessionId: session.id,
            userId: req.user.id,
            messageType: 'text',
            sender: 'assistant',
            content: aiResponse.response,
            tokensUsed: aiResponse.tokensUsed,
            responseTimeMs: aiResponse.responseTimeMs,
            referencedDocuments: aiResponse.referencedDocuments
        });

        // Increment user's monthly prompt count
        await User.incrementPromptCount(req.user.id);

        // Log token usage for analytics
        try {
            const currentMonthYear = new Date().toISOString().slice(0, 7); // Format: YYYY-MM
            await query(`
                INSERT INTO usage_logs (user_id, chat_message_id, model_id, prompt_tokens, completion_tokens, total_tokens, month_year)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                req.user.id,
                aiMessageId,
                aiResponse.model || model || 'unknown',
                aiResponse.promptTokens || 0,
                aiResponse.completionTokens || 0,
                aiResponse.tokensUsed || 0,
                currentMonthYear
            ]);
        } catch (logError) {
            // Don't fail the request if logging fails
            console.error('Failed to log usage:', logError.message);
        }

        // Get updated usage stats
        const updatedUsage = await User.checkPromptLimit(req.user.id);

        res.json({
            success: true,
            sessionToken: session.session_token || session.sessionToken,
            userMessage: {
                id: userMessageId,
                content: message,
                timestamp: new Date()
            },
            aiResponse: {
                id: aiMessageId,
                content: aiResponse.response,
                tokensUsed: aiResponse.tokensUsed,
                responseTimeMs: aiResponse.responseTimeMs,
                referencedDocuments: aiResponse.referencedDocuments,
                model: aiResponse.model,
                timestamp: new Date()
            },
            usage: updatedUsage
        });

    } catch (error) {
        console.error('Chat message error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process message'
        });
    }
});

// Send a message and get STREAMING AI response (for faster perceived response time)
router.post('/message/stream', authenticateToken, chatMessageValidation, async (req, res) => {
    try {
        const { message, sessionToken, model, documentIds } = req.body;
        const inventoryQuery = aiService.isDocumentInventoryQuery(message);
        const officerQuery = aiService.isPrincipalOfficerQuery(message);
        if (inventoryQuery || officerQuery) {
            console.log(`[ChatRoutes] Special query: "${message}" inventory=${inventoryQuery} officer=${officerQuery}`);
        }

        // Check monthly prompt limit
        const limitCheck = await User.checkPromptLimit(req.user.id);
        if (!limitCheck.allowed) {
            return res.status(429).json({
                success: false,
                error: `Monthly prompt limit reached (${limitCheck.limit} prompts).`,
                code: 'PROMPT_LIMIT_EXCEEDED'
            });
        }

        // Get or create session
        let session;
        if (sessionToken) {
            session = await ChatSession.findByToken(sessionToken);
            if (!session || session.user_id !== req.user.id) {
                return res.status(400).json({ success: false, error: 'Invalid session token' });
            }
        } else {
            session = await ChatSession.create(req.user.id, 'web');
        }

        // Update session activity
        await ChatSession.updateActivity(session.id);

        // Save user message
        const userMessageId = await ChatMessage.create({
            sessionId: session.id,
            userId: req.user.id,
            messageType: 'text',
            sender: 'user',
            content: message
        });

        // Get conversation history
        const history = await ChatMessage.getRecentContext(session.id, 6); // Reduced for speed

        // Set up SSE headers for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

        // Send initial metadata
        res.write(`data: ${JSON.stringify({ 
            type: 'start', 
            sessionToken: session.session_token || session.sessionToken,
            userMessageId 
        })}\n\n`);

        const startTime = Date.now();

        if (inventoryQuery) {
            const inventory = await aiService.getDocumentInventoryResponse({ documentIds });
            const responseTime = Date.now() - startTime;
            const aiMessageId = await ChatMessage.create({
                sessionId: session.id,
                userId: req.user.id,
                messageType: 'text',
                sender: 'assistant',
                content: inventory.response,
                tokensUsed: 0,
                responseTimeMs: responseTime,
                referencedDocuments: inventory.referencedDocuments
            });

            await User.incrementPromptCount(req.user.id);

            try {
                const currentMonthYear = new Date().toISOString().slice(0, 7);
                await query(`
                    INSERT INTO usage_logs (user_id, chat_message_id, model_id, prompt_tokens, completion_tokens, total_tokens, month_year)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [req.user.id, aiMessageId, 'system', 0, 0, 0, currentMonthYear]);
            } catch (logError) {
                console.error('Failed to log usage:', logError.message);
            }

            const updatedUsage = await User.checkPromptLimit(req.user.id);
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: inventory.response })}\n\n`);
            res.write(`data: ${JSON.stringify({ 
                type: 'done', 
                aiMessageId,
                tokensUsed: 0,
                responseTimeMs: responseTime,
                referencedDocuments: inventory.referencedDocuments,
                model: 'system',
                usage: updatedUsage,
                fromCache: false
            })}\n\n`);
            res.end();
            return;
        }

        if (officerQuery) {
            const officerResponse = await aiService.getPrincipalOfficerResponse(message);
            const responseTime = Date.now() - startTime;
            const aiMessageId = await ChatMessage.create({
                sessionId: session.id,
                userId: req.user.id,
                messageType: 'text',
                sender: 'assistant',
                content: officerResponse.response,
                tokensUsed: 0,
                responseTimeMs: responseTime,
                referencedDocuments: officerResponse.referencedDocuments
            });

            await User.incrementPromptCount(req.user.id);

            try {
                const currentMonthYear = new Date().toISOString().slice(0, 7);
                await query(`
                    INSERT INTO usage_logs (user_id, chat_message_id, model_id, prompt_tokens, completion_tokens, total_tokens, month_year)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [req.user.id, aiMessageId, 'system', 0, 0, 0, currentMonthYear]);
            } catch (logError) {
                console.error('Failed to log usage:', logError.message);
            }

            const updatedUsage = await User.checkPromptLimit(req.user.id);
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: officerResponse.response })}\n\n`);
            res.write(`data: ${JSON.stringify({ 
                type: 'done', 
                aiMessageId,
                tokensUsed: 0,
                responseTimeMs: responseTime,
                referencedDocuments: officerResponse.referencedDocuments,
                model: 'system',
                usage: updatedUsage,
                fromCache: false
            })}\n\n`);
            res.end();
            return;
        }

        // Generate streaming response with optional document filtering
        const streamResult = await aiService.generateStreamingResponse(message, history, {
            userRole: req.user.role,
            platform: 'web',
            userName: req.user.first_name,
            model: model,
            documentIds: documentIds, // Filter context to specific documents
            onChunk: (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
            }
        });

        const responseTime = Date.now() - startTime;

        // Save AI response to database
        const aiMessageId = await ChatMessage.create({
            sessionId: session.id,
            userId: req.user.id,
            messageType: 'text',
            sender: 'assistant',
            content: streamResult.fullResponse,
            tokensUsed: streamResult.tokensUsed,
            responseTimeMs: responseTime,
            referencedDocuments: streamResult.referencedDocuments
        });

        // Increment prompt count
        await User.incrementPromptCount(req.user.id);

        // Log usage
        try {
            const currentMonthYear = new Date().toISOString().slice(0, 7);
            await query(`
                INSERT INTO usage_logs (user_id, chat_message_id, model_id, prompt_tokens, completion_tokens, total_tokens, month_year)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [req.user.id, aiMessageId, streamResult.model || model || 'unknown', 0, 0, streamResult.tokensUsed || 0, currentMonthYear]);
        } catch (logError) {
            console.error('Failed to log usage:', logError.message);
        }

        // Send completion event
        const updatedUsage = await User.checkPromptLimit(req.user.id);
        res.write(`data: ${JSON.stringify({ 
            type: 'done', 
            aiMessageId,
            tokensUsed: streamResult.tokensUsed,
            responseTimeMs: responseTime,
            referencedDocuments: streamResult.referencedDocuments,
            model: streamResult.model,
            usage: updatedUsage,
            fromCache: streamResult.fromCache
        })}\n\n`);

        res.end();

    } catch (error) {
        console.error('Streaming chat error:', error);
        // If headers not sent, send JSON error
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Failed to process message' });
        } else {
            // If streaming, send error event
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        }
    }
});

// Send voice message
router.post('/voice', authenticateToken, uploadAudio.single('audio'), handleUploadError, async (req, res) => {
    try {
        const { sessionToken, voice } = req.body;
        const audioFile = req.file;

        if (!audioFile) {
            return res.status(400).json({
                success: false,
                error: 'No audio file provided'
            });
        }

        const normalizedVoice = typeof voice === 'string' && /^[A-Za-z0-9_.-]+$/.test(voice)
            ? voice.trim().slice(0, 64)
            : null;

        // Get or create session
        let session;
        if (sessionToken) {
            session = await ChatSession.findByToken(sessionToken);
            if (!session || session.user_id !== req.user.id) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid session token'
                });
            }
        } else {
            session = await ChatSession.create(req.user.id, 'web');
        }

        // Process voice message
        const sttResult = await audioService.processVoiceMessage(audioFile.path);

        if (!sttResult.success) {
            return res.status(400).json({
                success: false,
                error: 'Failed to transcribe audio'
            });
        }

        const transcribedText = sttResult.transcribedText;

        // Save user voice message
        const userAudioUrl = `/api/chat/audio/${audioFile.filename}`;
        const userMessageId = await ChatMessage.create({
            sessionId: session.id,
            userId: req.user.id,
            messageType: 'audio',
            sender: 'user',
            content: transcribedText,
            audioUrl: userAudioUrl
        });

        // Get conversation history
        const history = await ChatMessage.getRecentContext(session.id, 10);

        // Generate AI response
        const aiResponse = await aiService.generateResponse(transcribedText, history, {
            userRole: req.user.role,
            platform: 'web'
        });

        // Generate audio response if enabled
        let audioResponseUrl = null;
        const enableVoice = process.env.ENABLE_VOICE_RESPONSES === 'true';
        
        if (enableVoice) {
            const ttsResult = await audioService.generateAudioResponse(aiResponse.response, normalizedVoice ? { voice: normalizedVoice } : {});
            if (ttsResult.success) {
                audioResponseUrl = ttsResult.audioUrl;
            }
        }

        // Save AI response
        const aiMessageId = await ChatMessage.create({
            sessionId: session.id,
            userId: req.user.id,
            messageType: audioResponseUrl ? 'audio' : 'text',
            sender: 'assistant',
            content: aiResponse.response,
            audioUrl: audioResponseUrl,
            tokensUsed: aiResponse.tokensUsed,
            responseTimeMs: aiResponse.responseTimeMs,
            referencedDocuments: aiResponse.referencedDocuments
        });

        res.json({
            success: true,
            sessionToken: session.session_token || session.sessionToken,
            transcribedText,
            userMessage: {
                id: userMessageId,
                content: transcribedText,
                audioUrl: userAudioUrl,
                timestamp: new Date()
            },
            aiResponse: {
                id: aiMessageId,
                content: aiResponse.response,
                audioUrl: audioResponseUrl,
                tokensUsed: aiResponse.tokensUsed,
                timestamp: new Date()
            }
        });

    } catch (error) {
        console.error('Voice message error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process voice message'
        });
    }
});

// Get chat history for a session
router.get('/session/:sessionToken/history', authenticateToken, async (req, res) => {
    try {
        const { sessionToken } = req.params;
        const { limit = 50, offset = 0 } = req.query;

        const session = await ChatSession.findByToken(sessionToken);
        if (!session || session.user_id !== req.user.id) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        const messages = await ChatMessage.getBySession(session.id, parseInt(limit), parseInt(offset));

        res.json({
            success: true,
            sessionToken,
            messages: messages.map(msg => ({
                id: msg.id,
                type: msg.message_type,
                sender: msg.sender,
                content: msg.content,
                audioUrl: msg.audio_url,
                referencedDocuments: msg.referenced_documents ? JSON.parse(msg.referenced_documents) : [],
                timestamp: msg.created_at
            }))
        });

    } catch (error) {
        console.error('Get history error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch chat history'
        });
    }
});

// Get user's all chat sessions
router.get('/sessions', authenticateToken, async (req, res) => {
    try {
        const { platform } = req.query;
        const sessions = await ChatSession.getUserSessions(req.user.id, platform);

        res.json({
            success: true,
            sessions: sessions.map(s => ({
                id: s.id,
                sessionToken: s.session_token,
                platform: s.platform,
                createdAt: s.created_at,
                lastActivity: s.last_activity
            }))
        });

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch sessions'
        });
    }
});

// End a chat session
router.post('/session/:sessionToken/end', authenticateToken, async (req, res) => {
    try {
        const { sessionToken } = req.params;
        
        const session = await ChatSession.findByToken(sessionToken);
        if (!session || session.user_id !== req.user.id) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        await ChatSession.endSession(sessionToken);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CHAT_SESSION_ENDED',
            entityType: 'chat_session',
            entityId: session.id,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Session ended'
        });

    } catch (error) {
        console.error('End session error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to end session'
        });
    }
});

// Add feedback to a message
router.post('/message/:messageId/feedback', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { rating, comment } = req.body;

        if (rating < 1 || rating > 5) {
            return res.status(400).json({
                success: false,
                error: 'Rating must be between 1 and 5'
            });
        }

        const success = await ChatMessage.addFeedback(messageId, rating, comment);

        if (success) {
            res.json({
                success: true,
                message: 'Feedback submitted'
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Message not found'
            });
        }

    } catch (error) {
        console.error('Feedback error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit feedback'
        });
    }
});

// Get suggested questions
router.get('/suggestions', authenticateToken, async (req, res) => {
    try {
        const { sessionToken } = req.query;
        
        let suggestions = [
            "What are the admission requirements for BMU?",
            "What is the university's policy on academic integrity?",
            "How do I apply for a leave of absence?",
            "What are the examination regulations?",
            "How can I access the university library?"
        ];

        if (sessionToken) {
            const session = await ChatSession.findByToken(sessionToken);
            if (session && session.user_id === req.user.id) {
                const history = await ChatMessage.getRecentContext(session.id, 5);
                if (history.length > 0) {
                    const dynamicSuggestions = await aiService.generateSuggestions(history);
                    if (dynamicSuggestions.length > 0) {
                        suggestions = dynamicSuggestions;
                    }
                }
            }
        }

        res.json({
            success: true,
            suggestions
        });

    } catch (error) {
        console.error('Suggestions error:', error);
        res.json({
            success: true,
            suggestions: [
                "What are the admission requirements?",
                "Tell me about university policies",
                "What are the academic regulations?"
            ]
        });
    }
});

// Get chat statistics (admin only)
router.get('/stats', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Admin access required'
            });
        }

        const { days = 30 } = req.query;
        
        const messageStats = await ChatMessage.getStats(parseInt(days));
        const sessionStats = await ChatSession.getStats(parseInt(days));
        const feedbackStats = await ChatMessage.getFeedbackStats();

        res.json({
            success: true,
            stats: {
                messages: messageStats,
                sessions: sessionStats,
                feedback: feedbackStats
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

// Summarize selected text
router.post('/summarize', authenticateToken, async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text || text.length < 50) {
            return res.status(400).json({
                success: false,
                error: 'Text must be at least 50 characters long'
            });
        }
        
        // Limit text length
        const textToSummarize = text.substring(0, 5000);
        
        const prompt = `Please provide a concise summary of the following text. 
Highlight the key points and main ideas.

Text:
${textToSummarize}

Summary:`;

        const summary = await aiService.generateResponse(prompt, {
            maxTokens: 500,
            temperature: 0.3
        });

        res.json({
            success: true,
            summary: summary || 'Unable to generate summary'
        });

    } catch (error) {
        console.error('Summarize text error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to summarize text'
        });
    }
});

module.exports = router;
