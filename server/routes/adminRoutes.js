const express = require('express');
const { query } = require('../../config/db');
const AuditTrail = require('../models/AuditTrail');
const Document = require('../models/Document');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// Get dashboard statistics
router.get('/dashboard', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // User statistics
        const userStats = await query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
                SUM(CASE WHEN role = 'superadmin' THEN 1 ELSE 0 END) as superadmins,
                SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as new_this_week
            FROM users WHERE is_active = TRUE
        `);

        // Document statistics
        const docStats = await Document.getStats();

        // Chat statistics
        const chatStats = await query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(DISTINCT session_id) as total_sessions,
                SUM(tokens_used) as total_tokens
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);

        // Recent activity
        const recentActivity = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as message_count
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);

        res.json({
            success: true,
            dashboard: {
                users: userStats[0],
                documents: docStats,
                chat: chatStats[0],
                recentActivity
            }
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch dashboard data'
        });
    }
});

// Alias for /dashboard - some clients call /stats
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // User statistics
        const userStats = await query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
                SUM(CASE WHEN role = 'superadmin' THEN 1 ELSE 0 END) as superadmins
            FROM users WHERE is_active = TRUE
        `);

        // Document statistics  
        const docStats = await Document.getStats();

        // Chat statistics
        const chatStats = await query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(DISTINCT session_id) as total_sessions
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);

        res.json({
            success: true,
            stats: {
                totalUsers: parseInt(userStats[0]?.total) || 0,
                totalDocuments: docStats?.total || 0,
                trainedDocuments: docStats?.trained || 0,
                totalSessions: parseInt(chatStats[0]?.total_sessions) || 0,
                totalMessages: parseInt(chatStats[0]?.total_messages) || 0
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

// Alias for /audit-trail - some clients call /audit  
router.get('/audit', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50, search } = req.query;

        const result = await AuditTrail.getAll(parseInt(page), parseInt(limit), {
            search
        });

        res.json({
            success: true,
            logs: result.logs || result.items || [],
            pagination: result.pagination || { page: parseInt(page), total: result.total || 0 }
        });

    } catch (error) {
        console.error('Audit error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch audit logs'
        });
    }
});

// Get audit trail
router.get('/audit-trail', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50, userId, action, startDate, endDate, search } = req.query;

        const result = await AuditTrail.getAll(parseInt(page), parseInt(limit), {
            userId: userId ? parseInt(userId) : null,
            action,
            startDate,
            endDate,
            search
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        console.error('Audit trail error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch audit trail'
        });
    }
});

// ======================== USER MANAGEMENT ========================

// Get all users (admin)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, role } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let whereClause = '1=1';
        const params = [];
        
        if (search) {
            whereClause += ' AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam);
        }
        
        if (status === 'active') {
            whereClause += ' AND is_active = TRUE AND is_verified = TRUE AND is_approved = TRUE';
        } else if (status === 'pending') {
            whereClause += ' AND (is_verified = FALSE OR is_approved = FALSE)';
        } else if (status === 'inactive') {
            whereClause += ' AND is_active = FALSE';
        }
        
        if (role) {
            whereClause += ' AND role = ?';
            params.push(role);
        }
        
        // Get total count
        const countResult = await query(`SELECT COUNT(*) as total FROM users WHERE ${whereClause}`, params);
        const total = countResult[0]?.total || 0;
        
        // Get users - use only columns that definitely exist in base schema
        const users = await query(`
            SELECT id, email, first_name, last_name, role, department, phone,
                   is_active, is_verified, is_approved, created_at, updated_at
            FROM users 
            WHERE ${whereClause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);
        
        res.json({
            success: true,
            users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch users: ' + error.message
        });
    }
});

// Update user status (activate/deactivate)
router.put('/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        
        await query('UPDATE users SET is_active = ? WHERE id = ?', [isActive, id]);
        
        await AuditTrail.log({
            userId: req.user.id,
            action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
            entityType: 'user',
            entityId: id,
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: isActive ? 'User activated' : 'User deactivated'
        });
    } catch (error) {
        console.error('Update user status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update user status'
        });
    }
});

// Update user role - Enhanced with proper permission checks
router.put('/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        const requestingUser = req.user;
        
        if (!['staff', 'admin', 'superadmin'].includes(role)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid role'
            });
        }
        
        // Prevent changing own role
        if (parseInt(id) === requestingUser.id) {
            return res.status(400).json({
                success: false,
                error: 'Cannot change your own role'
            });
        }
        
        // Get target user
        const targetUser = await User.findById(id);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        // Permission checks based on requesting user's role
        if (requestingUser.role === 'admin') {
            // Admins cannot:
            // - Set anyone as superadmin
            // - Change superadmin's role
            // - Change other admin's role (only superadmin can)
            if (role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can assign superadmin role'
                });
            }
            if (targetUser.role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Cannot modify superadmin users'
                });
            }
            if (targetUser.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can change admin roles'
                });
            }
        }
        // Superadmins can do anything
        
        const oldRole = targetUser.role;
        await query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        
        await AuditTrail.log({
            userId: requestingUser.id,
            action: 'USER_ROLE_CHANGED',
            entityType: 'user',
            entityId: id,
            details: { oldRole, newRole: role },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User role updated'
        });
    } catch (error) {
        console.error('Update user role error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update user role'
        });
    }
});

// Delete user - with proper permission checks
router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const requestingUser = req.user;
        
        // Prevent deleting self
        if (parseInt(id) === requestingUser.id) {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete your own account'
            });
        }
        
        // Get target user
        const targetUser = await User.findById(id);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        // Permission checks
        if (requestingUser.role === 'admin') {
            // Admins cannot delete superadmins or other admins
            if (targetUser.role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Cannot delete superadmin users'
                });
            }
            if (targetUser.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can delete admin users'
                });
            }
        }
        // Superadmins can delete anyone except themselves
        
        // Soft delete - just deactivate and anonymize
        await query(`
            UPDATE users SET 
                is_active = FALSE, 
                email = CONCAT('deleted_', id, '_', email),
                first_name = 'Deleted',
                last_name = 'User'
            WHERE id = ?
        `, [id]);
        
        await AuditTrail.log({
            userId: requestingUser.id,
            action: 'USER_DELETED',
            entityType: 'user',
            entityId: id,
            details: { deletedUserRole: targetUser.role, deletedUserEmail: targetUser.email },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete user'
        });
    }
});

// Reset user password (admin only) - since email is disabled
router.post('/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;
        const requestingUser = req.user;
        
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 8 characters long'
            });
        }
        
        // Prevent resetting own password through this endpoint
        if (parseInt(id) === requestingUser.id) {
            return res.status(400).json({
                success: false,
                error: 'Use the profile page to change your own password'
            });
        }
        
        // Get target user
        const targetUser = await User.findByIdAny(id);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        // Permission checks
        if (requestingUser.role === 'admin') {
            // Admins cannot reset superadmin or other admin passwords
            if (targetUser.role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Cannot reset superadmin password'
                });
            }
            if (targetUser.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can reset admin passwords'
                });
            }
        }
        
        // Reset the password
        await User.updatePassword(id, newPassword);
        
        await AuditTrail.log({
            userId: requestingUser.id,
            action: 'USER_PASSWORD_RESET',
            entityType: 'user',
            entityId: id,
            details: { resetBy: requestingUser.email, targetEmail: targetUser.email },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: `Password reset successfully for ${targetUser.email}`
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset password'
        });
    }
});

// Approve user (admin and superadmin can approve)
router.post('/users/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        await query('UPDATE users SET is_approved = TRUE, is_active = TRUE WHERE id = ?', [id]);
        
        // Send approval email
        try {
            const emailService = require('../services/emailService');
            const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            const loginUrl = `${baseUrl}/#/login`;
            
            await emailService.sendApprovalEmail({
                to: user.email,
                userName: user.first_name || user.email,
                loginUrl
            });
        } catch (emailErr) {
            console.error('Failed to send approval email:', emailErr);
        }
        
        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_APPROVED',
            entityType: 'user',
            entityId: id,
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User approved successfully'
        });
    } catch (error) {
        console.error('Approve user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to approve user'
        });
    }
});

// Reject user (admin and superadmin can reject)
router.post('/users/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        await query('UPDATE users SET is_active = FALSE WHERE id = ?', [id]);
        
        // Send rejection email
        try {
            const emailService = require('../services/emailService');
            await emailService.sendRejectionEmail({
                to: user.email,
                userName: user.first_name || user.email,
                reason: reason || 'Your registration request was not approved.'
            });
        } catch (emailErr) {
            console.error('Failed to send rejection email:', emailErr);
        }
        
        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_REJECTED',
            entityType: 'user',
            entityId: id,
            details: { reason },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User rejected'
        });
    } catch (error) {
        console.error('Reject user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reject user'
        });
    }
});

// Get system settings (superadmin only)
router.get('/settings', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const settings = await query(`
            SELECT setting_key, setting_value, setting_type, description, is_public
            FROM system_settings
            ORDER BY setting_key
        `);

        res.json({
            success: true,
            settings
        });

    } catch (error) {
        console.error('Settings error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch settings'
        });
    }
});

// Update system setting (superadmin only)
router.put('/settings/:key', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        const result = await query(
            'UPDATE system_settings SET setting_value = ?, updated_by = ?, updated_at = NOW() WHERE setting_key = ?',
            [value, req.user.id, key]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: 'Setting not found'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'SETTING_UPDATED',
            entityType: 'system_setting',
            details: { key, value },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Setting updated successfully'
        });

    } catch (error) {
        console.error('Update setting error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update setting'
        });
    }
});

// Get analytics data
router.get('/analytics', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);

        // Daily message counts
        const dailyMessages = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN sender = 'user' THEN 1 ELSE 0 END) as user_messages,
                SUM(CASE WHEN sender = 'assistant' THEN 1 ELSE 0 END) as ai_messages,
                AVG(response_time_ms) as avg_response_time,
                SUM(tokens_used) as tokens_used
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [daysInt]);

        // User registrations
        const userRegistrations = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as new_users
            FROM users
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [daysInt]);

        // Top active users with token usage
        const topUsers = await query(`
            SELECT 
                u.id,
                u.email,
                u.first_name,
                u.last_name,
                COUNT(cm.id) as message_count,
                COALESCE(SUM(cm.tokens_used), 0) as total_tokens
            FROM users u
            JOIN chat_messages cm ON u.id = cm.user_id
            WHERE cm.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY u.id
            ORDER BY message_count DESC
            LIMIT 10
        `, [daysInt]);

        // Document categories
        const documentCategories = await Document.getCategoryStats();

        // Feedback summary
        const feedbackStats = await ChatMessage.getFeedbackStats();

        // Platform usage
        const platformUsage = await query(`
            SELECT 
                cs.platform,
                COUNT(DISTINCT cs.id) as sessions,
                COUNT(cm.id) as messages
            FROM chat_sessions cs
            LEFT JOIN chat_messages cm ON cs.id = cm.session_id
            WHERE cs.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY cs.platform
        `, [daysInt]);

        res.json({
            success: true,
            analytics: {
                period: `${daysInt} days`,
                dailyMessages,
                userRegistrations,
                topUsers,
                documentCategories,
                feedbackStats,
                platformUsage
            }
        });

    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch analytics'
        });
    }
});

// Get token usage analytics (by model and user)
router.get('/analytics/tokens', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

        // Token usage by model (current month)
        const byModel = await query(`
            SELECT 
                model_id,
                COUNT(*) as request_count,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                AVG(total_tokens) as avg_tokens_per_request
            FROM usage_logs
            WHERE month_year = ?
            GROUP BY model_id
            ORDER BY total_tokens DESC
        `, [currentMonth]);

        // Token usage by user (current month, top 20)
        const byUser = await query(`
            SELECT 
                u.id as user_id,
                u.email,
                CONCAT(u.first_name, ' ', u.last_name) as user_name,
                u.role,
                u.monthly_prompt_count,
                u.monthly_prompt_limit,
                COUNT(ul.id) as request_count,
                COALESCE(SUM(ul.total_tokens), 0) as total_tokens,
                COALESCE(SUM(ul.prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(ul.completion_tokens), 0) as completion_tokens
            FROM users u
            LEFT JOIN usage_logs ul ON u.id = ul.user_id AND ul.month_year = ?
            WHERE u.is_active = TRUE
            GROUP BY u.id, u.email, u.first_name, u.last_name, u.role, u.monthly_prompt_count, u.monthly_prompt_limit
            ORDER BY total_tokens DESC
            LIMIT 20
        `, [currentMonth]);

        // Daily token usage trend
        const dailyTrend = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as requests,
                SUM(total_tokens) as tokens
            FROM usage_logs
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [daysInt]);

        // Overall totals for current month
        const monthlyTotals = await query(`
            SELECT 
                COUNT(*) as total_requests,
                COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens
            FROM usage_logs
            WHERE month_year = ?
        `, [currentMonth]);

        res.json({
            success: true,
            tokenUsage: {
                period: currentMonth,
                byModel,
                byUser,
                dailyTrend,
                monthlyTotals: monthlyTotals[0] || {}
            }
        });

    } catch (error) {
        console.error('Token analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token analytics'
        });
    }
});

// Get action summary
router.get('/action-stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const stats = await AuditTrail.getActionStats(parseInt(days));

        res.json({
            success: true,
            actionStats: stats
        });

    } catch (error) {
        console.error('Action stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch action statistics'
        });
    }
});

// System health check
router.get('/health', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // Check database connection
        const dbCheck = await query('SELECT 1 as result');
        const dbStatus = dbCheck[0]?.result === 1;

        // Get uptime and memory usage
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();

        // Check AI provider configuration (DeepSeek)
        const apiKeyConfigured = !!process.env.DEEPSEEK_API_KEY;

        res.json({
            success: true,
            health: {
                status: 'operational',
                database: dbStatus ? 'connected' : 'disconnected',
                apiKey: apiKeyConfigured ? 'configured' : 'not configured',
                uptime: Math.floor(uptime),
                memory: {
                    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
                    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB'
                },
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            success: false,
            health: {
                status: 'degraded',
                error: error.message
            }
        });
    }
});

// ======================== METRICS ENDPOINTS ========================

// Get retrieval service metrics
router.get('/metrics/retrieval', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        const metrics = aiService.getRetrievalMetrics();
        
        res.json({
            success: true,
            metrics,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Retrieval metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch retrieval metrics'
        });
    }
});

// Get Elasticsearch metrics
router.get('/metrics/elasticsearch', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const elasticsearchService = require('../services/elasticsearchService');
        const stats = await elasticsearchService.getStats();
        const isAvailable = await elasticsearchService.isAvailable();
        
        res.json({
            success: true,
            elasticsearch: {
                available: isAvailable,
                ...stats
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Elasticsearch metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch Elasticsearch metrics'
        });
    }
});

// Get FAQ cache metrics
router.get('/metrics/faq', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // NOTE: column is `last_used_at` in the academic-advisor schema (was
        // `last_used` in the legacy assistant DB).
        const stats = await query(`
            SELECT 
                COUNT(*) as total_faqs,
                COUNT(DISTINCT document_id) as documents_with_faqs,
                AVG(confidence_score) as avg_confidence,
                SUM(usage_count) as total_usage,
                MAX(last_used_at) as last_used_at
            FROM cached_qa
        `);
        
        // Get by document breakdown
        const byDocument = await query(`
            SELECT 
                d.title,
                d.id as document_id,
                COUNT(*) as faq_count,
                AVG(cq.confidence_score) as avg_confidence,
                SUM(cq.usage_count) as total_usage
            FROM cached_qa cq
            JOIN documents d ON cq.document_id = d.id
            GROUP BY d.id, d.title
            ORDER BY faq_count DESC
        `);
        
        res.json({
            success: true,
            faq: {
                ...stats[0],
                byDocument
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('FAQ metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch FAQ metrics'
        });
    }
});

// Get combined system performance metrics
router.get('/metrics/performance', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        const elasticsearchService = require('../services/elasticsearchService');
        
        // Retrieval metrics
        const retrievalMetrics = aiService.getRetrievalMetrics();
        
        // ES status
        const esAvailable = await elasticsearchService.isAvailable();
        const esStats = esAvailable ? await elasticsearchService.getStats() : null;
        
        // FAQ stats
        const faqStats = await query(`
            SELECT COUNT(*) as total, SUM(usage_count) as hits FROM cached_qa
        `);
        
        // Recent chat performance (last 24h)
        const chatPerf = await query(`
            SELECT 
                COUNT(*) as messages_24h,
                AVG(response_time_ms) as avg_response_time_ms,
                MAX(response_time_ms) as max_response_time_ms,
                MIN(response_time_ms) as min_response_time_ms
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND sender = 'assistant'
        `);
        
        // Vector store stats
        const vectorStats = await query(`
            SELECT COUNT(*) as total_chunks, COUNT(DISTINCT document_id) as documents
            FROM document_chunks WHERE embedding IS NOT NULL
        `);
        
        res.json({
            success: true,
            performance: {
                retrieval: retrievalMetrics,
                elasticsearch: {
                    available: esAvailable,
                    documentCount: esStats?.documentCount || 0,
                    indexSize: esStats?.indexSizeHuman || 'N/A'
                },
                faq: {
                    totalCached: faqStats[0]?.total || 0,
                    totalHits: faqStats[0]?.hits || 0
                },
                chat: chatPerf[0] || {},
                vectorStore: vectorStats[0] || {}
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Performance metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch performance metrics'
        });
    }
});

// Clear retrieval caches (admin only)
router.post('/cache/clear', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        const { type = 'all' } = req.body; // all, query, context, document
        
        aiService.clearRetrievalCache();
        
        // Log the action
        const AuditTrail = require('../models/AuditTrail');
        await AuditTrail.log({
            userId: req.user.id,
            action: 'CACHE_CLEARED',
            details: { type },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: `Cache cleared: ${type}`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Cache clear error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear cache'
        });
    }
});

// Rebuild Elasticsearch index (superadmin only)
router.post('/elasticsearch/rebuild', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const elasticsearchService = require('../services/elasticsearchService');
        
        const isAvailable = await elasticsearchService.isAvailable();
        if (!isAvailable) {
            return res.status(503).json({
                success: false,
                error: 'Elasticsearch is not available'
            });
        }
        
        // Start rebuild (this can take a while)
        res.json({
            success: true,
            message: 'Index rebuild started. Check logs for progress.',
            timestamp: new Date().toISOString()
        });
        
        // Run rebuild asynchronously
        elasticsearchService.rebuildIndex().then(result => {
            console.log('[Admin] Elasticsearch rebuild completed:', result);
        }).catch(err => {
            console.error('[Admin] Elasticsearch rebuild failed:', err);
        });
        
    } catch (error) {
        console.error('ES rebuild error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start index rebuild'
        });
    }
});

// Data cleanup (superadmin only)
router.post('/cleanup', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { cleanAuditDays = 365, cleanChatDays = 365, cleanExportDays = 7 } = req.body;

        const results = {
            auditRecords: await AuditTrail.cleanOldRecords(cleanAuditDays),
            chatMessages: await ChatMessage.cleanOldMessages(cleanChatDays)
        };

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DATA_CLEANUP',
            details: results,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Cleanup completed',
            results
        });

    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to perform cleanup'
        });
    }
});

// Get cache statistics and health
router.get('/cache/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            // Cache service not available
        }

        const stats = {
            aiService: aiService.getResponseCacheStats(),
            timestamp: new Date().toISOString()
        };

        if (cacheService) {
            stats.redis = cacheService.getStats();
            stats.health = await cacheService.healthCheck();
        }

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Cache stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get cache statistics'
        });
    }
});

// Clear cache (specific namespace or all)
router.post('/cache/clear', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { namespace } = req.body; // 'faq', 'embedding', 'response', 'retrieval', or 'all'
        
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        if (namespace === 'all') {
            await cacheService.clearAll();
        } else if (namespace) {
            await cacheService.clearNamespace(namespace);
        } else {
            return res.status(400).json({
                success: false,
                error: 'Please specify namespace or "all"'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CACHE_CLEARED',
            details: { namespace },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: `Cache cleared: ${namespace}`
        });
    } catch (error) {
        console.error('Cache clear error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear cache'
        });
    }
});

// Trigger cache warming manually
router.post('/cache/warm', authenticateToken, requireAdmin, async (req, res) => {
    try {
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        // Run cache warming
        const result = await cacheService.warmCache();

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CACHE_WARMED',
            details: result,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Cache warming completed',
            result
        });
    } catch (error) {
        console.error('Cache warming error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to warm cache'
        });
    }
});

// Get cache warming status
router.get('/cache/warmup-status', authenticateToken, requireAdmin, async (req, res) => {
    try {
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        res.json({
            success: true,
            warmup: cacheService.getWarmupStatus()
        });
    } catch (error) {
        console.error('Cache warmup status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get warmup status'
        });
    }
});

// Add custom queries to warmup list
router.post('/cache/warmup-queries', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { queries } = req.body;
        
        if (!queries || !Array.isArray(queries)) {
            return res.status(400).json({
                success: false,
                error: 'Please provide an array of queries'
            });
        }

        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        cacheService.addWarmupQueries(queries);

        res.json({
            success: true,
            message: `Added ${queries.length} queries to warmup list`,
            warmup: cacheService.getWarmupStatus()
        });
    } catch (error) {
        console.error('Add warmup queries error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add warmup queries'
        });
    }
});

// ============================================================================
// FAQ Curation — review recent advisor Q&A turns and promote them into the
// `cached_qa` table so they short-circuit the LLM next time the same (or
// semantically similar) question is asked.
//
// Workflow:
//   GET    /admin/advisor/recent-qa      — recent advisor turns + cache hit?
//   POST   /admin/advisor/promote/:id    — turn an advisor_messages row into a
//                                          cached_qa entry (with embedding)
//   DELETE /admin/cached-qa/:id          — deactivate (soft-delete) a cache
//                                          entry curated earlier
// ============================================================================

// List the most recent advisor reply turns paired with the immediately-
// preceding student question, so an admin can decide what to promote.
router.get('/advisor/recent-qa', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const limit  = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

        // Pair each advisor row with its most-recent earlier student row in
        // the same conversation. We sort by the advisor row's id descending.
        const rows = await query(`
            SELECT
                a.id              AS advisor_message_id,
                a.conversation_id,
                a.created_at,
                a.text            AS advisor_text,
                a.display_markdown,
                a.speech_text,
                a.tokens_in, a.tokens_out, a.latency_ms,
                a.citations_json,
                (SELECT s.text
                   FROM advisor_messages s
                   WHERE s.conversation_id = a.conversation_id
                     AND s.role = 'student'
                     AND s.id < a.id
                   ORDER BY s.id DESC LIMIT 1)        AS question_text,
                (SELECT q.id FROM cached_qa q
                   WHERE q.is_active = 1
                     AND q.question = (SELECT s2.text
                                         FROM advisor_messages s2
                                         WHERE s2.conversation_id = a.conversation_id
                                           AND s2.role = 'student'
                                           AND s2.id < a.id
                                         ORDER BY s2.id DESC LIMIT 1)
                   LIMIT 1)                            AS existing_cache_id
            FROM advisor_messages a
            WHERE a.role = 'advisor'
            ORDER BY a.id DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        // Drop rows that have no preceding student question (would be useless
        // to cache).
        const items = rows.filter(r => r.question_text && r.question_text.trim().length > 2);

        res.json({ success: true, items });
    } catch (err) {
        console.error('Recent advisor Q&A error:', err);
        res.status(500).json({ success: false, error: 'Could not load recent Q&A' });
    }
});

// Promote an advisor reply into the FAQ cache. Generates the question
// embedding via the existing embedding service so the FAQ similarity search
// will pick it up.
router.post('/advisor/promote/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const advisorId = parseInt(req.params.id, 10);
        if (!advisorId) return res.status(400).json({ success: false, error: 'Invalid id' });

        // Optional overrides
        let { question, answer, categoryId, qaType } = req.body || {};

        // Pull the advisor row + its preceding student question.
        const arows = await query(
            `SELECT id, conversation_id, text AS advisor_text,
                    display_markdown, speech_text, citations_json
             FROM advisor_messages
             WHERE id = ? AND role = 'advisor' LIMIT 1`,
            [advisorId]
        );
        const a = arows[0];
        if (!a) return res.status(404).json({ success: false, error: 'Advisor message not found' });

        if (!question) {
            const srows = await query(
                `SELECT text FROM advisor_messages
                 WHERE conversation_id = ? AND role = 'student' AND id < ?
                 ORDER BY id DESC LIMIT 1`,
                [a.conversation_id, a.id]
            );
            question = (srows[0]?.text || '').trim();
        }
        if (!question) {
            return res.status(400).json({
                success: false,
                error: 'No preceding student question found; supply `question` in the body to override.'
            });
        }

        if (!answer) {
            // Prefer the cleaner display_markdown; fall back to speech_text.
            answer = (a.display_markdown || a.speech_text || a.advisor_text || '').trim();
        }
        if (!answer || answer.length < 8) {
            return res.status(400).json({ success: false, error: 'Answer is empty or too short to cache.' });
        }

        // De-dupe: if this exact question is already cached & active, refresh
        // its answer instead of inserting a duplicate.
        const existingRows = await query(
            `SELECT id FROM cached_qa WHERE is_active = 1 AND question = ? LIMIT 1`,
            [question]
        );

        let answerSources = [];
        try { answerSources = a.citations_json ? JSON.parse(a.citations_json) : []; }
        catch (_) { answerSources = []; }

        // Generate embedding for the question.
        let embedding = null;
        try {
            const aiService = require('../services/aiService');
            embedding = await aiService.generateEmbedding(question, true);
        } catch (err) {
            console.warn('[promote-qa] embedding failed:', err.message);
            // Still allow promotion — the FAQ service will skip rows with no
            // embedding when matching, but the row is still usable via
            // exact-question lookup.
        }

        const CachedQA = require('../models/CachedQA');

        if (existingRows.length) {
            const id = existingRows[0].id;
            // Direct SQL update (CachedQA.update() whitelists fewer columns
            // than we need for a curated refresh — we want to bump answer,
            // sources, embedding, verification AND qa_type in one shot).
            await query(
                `UPDATE cached_qa
                 SET answer            = ?,
                     answer_sources    = ?,
                     embedding         = ?,
                     confidence_score  = 1.0,
                     is_active         = 1,
                     is_verified       = 1,
                     verified_by       = ?,
                     verified_at       = NOW(),
                     qa_type           = ?,
                     updated_at        = NOW()
                 WHERE id = ?`,
                [
                    answer,
                    JSON.stringify(answerSources),
                    embedding ? JSON.stringify(embedding) : null,
                    req.user.id,
                    qaType || 'curated',
                    id
                ]
            );
            await AuditTrail.log({
                userId: req.user.id,
                action: 'PROMOTE_ADVISOR_QA',
                entityType: 'cached_qa',
                entityId: id,
                details: { advisorMessageId: advisorId, mode: 'refreshed' },
                ipAddress: req.ip,
                userAgent: req.headers['user-agent']
            });
            return res.json({ success: true, mode: 'refreshed', cachedQaId: id });
        }

        const newId = await CachedQA.create({
            documentId: null,
            categoryId: categoryId || null,
            question,
            questionVariations: [],
            answer,
            answerSources,
            embedding,
            confidenceScore: 1.0,
            createdBy: req.user.id,
            qaType: qaType || 'curated'
        });

        // Mark verified (curated by an admin).
        try {
            await query(
                `UPDATE cached_qa SET is_verified = 1, verified_by = ?, verified_at = NOW() WHERE id = ?`,
                [req.user.id, newId]
            );
        } catch (_) { /* table may not have these columns in all envs */ }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'PROMOTE_ADVISOR_QA',
            entityType: 'cached_qa',
            entityId: newId,
            details: { advisorMessageId: advisorId, mode: 'created' },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({ success: true, mode: 'created', cachedQaId: newId });
    } catch (err) {
        console.error('Promote advisor Q&A error:', err);
        res.status(500).json({ success: false, error: 'Could not promote Q&A' });
    }
});

// Soft-delete a cached_qa entry.
router.delete('/cached-qa/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
        const CachedQA = require('../models/CachedQA');
        await CachedQA.deactivate(id);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DELETE_CACHED_QA',
            entityType: 'cached_qa',
            entityId: id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete cached_qa error:', err);
        res.status(500).json({ success: false, error: 'Could not delete cache entry' });
    }
});

module.exports = router;
