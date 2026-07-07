const express = require('express');
const crypto = require('crypto');
const User = require('../models/User');
const AuditTrail = require('../models/AuditTrail');
const { authenticateToken, requireAdmin, requireSuperAdmin, generateToken } = require('../middleware/auth');
const { 
    registerValidation, 
    loginValidation, 
    passwordChangeValidation,
    passwordResetRequestValidation,
    passwordResetValidation,
    profileUpdateValidation 
} = require('../middleware/validation');
const emailService = require('../services/emailService');

const router = express.Router();

async function resendVerificationForUser({ user, req }) {
    if (!user || user.is_verified) {
        return { sent: false, reason: 'already_verified' };
    }

    const verificationToken = await User.regenerateVerificationToken(user.id);
    if (!verificationToken) {
        return { sent: false, reason: 'token_generation_failed' };
    }

    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${baseUrl}/verify-email?token=${verificationToken}`;

    await emailService.sendVerificationEmail({
        to: user.email,
        verifyUrl,
        userName: user.first_name || user.email
    });

    return { sent: true };
}

// Registration
router.post('/register', registerValidation, async (req, res) => {
    try {
        const { email, password, firstName, lastName, phone, department, matricNo } = req.body;

        // Check if user already exists (including unverified)
        const existingUser = await User.findByEmailAny(email);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: 'Email already registered'
            });
        }

        // Create user with verification token. User.create auto-approves
        // accounts with a @<UNIVERSITY_DOMAIN> email so legitimate BMU
        // students can log in immediately without admin intervention.
        const { userId, verificationToken, isUniversityEmail } = await User.create({
            email,
            password,
            firstName,
            lastName,
            phone,
            department,
            matricNo,
            role: 'staff'
        });

        // Always send a verification email so we can prove the registrant
        // actually controls the inbox. Without this step a fake
        // "attacker@bmu.edu.ng" address (i.e. one whose holder doesn't
        // exist) could otherwise auto-approve into the system.
        let emailSent = false;
        const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const verificationUrl = `${baseUrl}/verify-email?token=${verificationToken}`;
        try {
            const r = await emailService.sendVerificationEmail({
                to: email,
                userName: firstName || email.split('@')[0],
                verifyUrl: verificationUrl
            });
            emailSent = r && r.success !== false;
            console.log(`[Registration] Verification email ${emailSent ? 'sent' : 'NOT sent'} to: ${email}`);
        } catch (emailError) {
            console.error('[Registration] Failed to send verification email:', emailError.message);
        }

        // Log action
        await AuditTrail.log({
            userId,
            action: 'USER_REGISTERED',
            entityType: 'user',
            entityId: userId,
            details: { email, isUniversityEmail, emailSent },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Friendly response: the account is always in "needs verification"
        // state. If email isn't configured (EMAIL_ENABLED=false on the
        // server), tell the user to ask an admin to approve them — they
        // can't self-verify without the link.
        const message = emailSent
            ? `Registration successful! We've sent a verification link to ${email}. Click it to activate your account.${isUniversityEmail ? ' Once verified, your BMU account is approved automatically.' : ' After verification an admin will review and approve your account.'}`
            : 'Registration successful, but we could not send the verification email automatically. Please contact an administrator to activate your account.';

        res.status(201).json({
            success: true,
            message,
            userId,
            requiresVerification: true,
            requiresApproval: !isUniversityEmail,
            emailSent,
            autoApproved: false
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            error: 'Registration failed. Please try again.'
        });
    }
});

// Verify email
router.get('/verify-email', async (req, res) => {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).json({
                success: false,
                error: 'Verification token is required'
            });
        }

        const user = await User.findByVerificationToken(token);
        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired verification token'
            });
        }

        // Mark email as verified
        await User.verifyEmail(user.id);

        // Log action
        await AuditTrail.log({
            userId: user.id,
            action: 'EMAIL_VERIFIED',
            entityType: 'user',
            entityId: user.id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Notify superadmins about pending approval
        try {
            const superadmins = await User.getSuperadmins();
            const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            const adminUrl = `${baseUrl}/#/admin?section=users&status=pending_approval`;
            
            for (const admin of superadmins) {
                await emailService.sendAdminNotificationEmail({
                    to: admin.email,
                    newUserEmail: user.email,
                    newUserName: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
                    adminUrl
                });
            }
        } catch (notifyError) {
            console.error('Failed to notify admins:', notifyError);
        }

        res.json({
            success: true,
            message: 'Email verified successfully! Your account is now pending administrator approval. You will receive an email once approved.'
        });

    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({
            success: false,
            error: 'Email verification failed. Please try again.'
        });
    }
});

// Resend verification email
router.post('/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email is required'
            });
        }

        const user = await User.findByEmailAny(email);
        if (!user) {
            // Don't reveal if user exists or not
            return res.json({
                success: true,
                message: 'If an account exists with this email, a verification link will be sent.'
            });
        }

        if (user.is_verified) {
            return res.status(400).json({
                success: false,
                error: 'Email is already verified'
            });
        }

        // Regenerate verification token
        const verificationToken = await User.regenerateVerificationToken(user.id);
        if (!verificationToken) {
            return res.status(400).json({
                success: false,
                error: 'Failed to generate verification token'
            });
        }

        // Send verification email
        const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const verifyUrl = `${baseUrl}/verify-email?token=${verificationToken}`;
        
        await emailService.sendVerificationEmail({
            to: email,
            verifyUrl,
            userName: user.first_name || email
        });

        res.json({
            success: true,
            message: 'Verification email sent. Please check your inbox.'
        });

    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to resend verification email'
        });
    }
});

// Login
router.post('/login', loginValidation, async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findByEmail(email);
        if (!user) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid email or password' 
            });
        }

        const isMatch = await User.verifyPassword(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid email or password' 
            });
        }

        // Check if email is verified
        if (!user.is_verified) {
            return res.status(403).json({
                success: false,
                error: 'Please verify your email address first. Check your inbox for the verification link.',
                code: 'EMAIL_NOT_VERIFIED'
            });
        }

        // Check if account is approved by admin
        if (!user.is_approved) {
            return res.status(403).json({
                success: false,
                error: 'Your account is pending administrator approval. Please wait for an admin to approve your registration.',
                code: 'PENDING_APPROVAL'
            });
        }

        // Generate token
        const token = generateToken(user);

        // Update last login
        await User.updateLastLogin(user.id);

        // Log action
        await AuditTrail.log({
            userId: user.id,
            action: 'USER_LOGIN',
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                role: user.role,
                department: user.department,
                advisorGender: user.advisor_gender || 'female',
                mustChangePassword: !!user.must_change_password
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Login failed. Please try again.' 
        });
    }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                phone: user.phone,
                department: user.department,
                role: user.role,
                advisorGender: user.advisor_gender || 'female',
                whatsappNumber: user.whatsapp_number,
                isVerified: user.is_verified,
                createdAt: user.created_at,
                lastLogin: user.last_login
            }
        });
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch profile' 
        });
    }
});

// Update profile
router.put('/me', authenticateToken, profileUpdateValidation, async (req, res) => {
    try {
        const updates = req.body;
        const success = await User.update(req.user.id, updates);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'PROFILE_UPDATED',
                entityType: 'user',
                entityId: req.user.id,
                details: { updatedFields: Object.keys(updates) },
                ipAddress: req.ip
            });

            res.json({ 
                success: true, 
                message: 'Profile updated successfully' 
            });
        } else {
            res.status(400).json({ 
                success: false, 
                error: 'No valid fields to update' 
            });
        }
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to update profile' 
        });
    }
});

// Change password
router.post('/change-password', authenticateToken, passwordChangeValidation, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        const user = await User.findByEmail(req.user.email);
        const isMatch = await User.verifyPassword(currentPassword, user.password);
        
        if (!isMatch) {
            return res.status(400).json({ 
                success: false, 
                error: 'Current password is incorrect' 
            });
        }

        await User.updatePassword(req.user.id, newPassword);
        // Clear the must_change_password flag so the user is no longer
        // forced to the change-password screen on subsequent logins.
        await User.setMustChangePassword(req.user.id, false);

        await AuditTrail.log({
            userId: req.user.id,
            action: 'PASSWORD_CHANGED',
            ipAddress: req.ip
        });

        res.json({ 
            success: true, 
            message: 'Password changed successfully' 
        });
    } catch (error) {
        console.error('Password change error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to change password' 
        });
    }
});

// Save the user's advisor avatar/voice preference. Drives both the on-screen
// image (male-advisor.png vs female-advisor.png) and the TTSMaker voice id.
router.post('/advisor-preference', authenticateToken, async (req, res) => {
    try {
        const gender = req.body?.gender;
        if (gender !== 'male' && gender !== 'female') {
            return res.status(400).json({ success: false, error: 'gender must be "male" or "female"' });
        }
        const saved = await User.setAdvisorGender(req.user.id, gender);
        res.json({ success: true, advisorGender: saved });
    } catch (error) {
        console.error('Advisor preference error:', error);
        res.status(500).json({ success: false, error: 'Could not save preference' });
    }
});

// Request password reset
router.post('/forgot-password', passwordResetRequestValidation, async (req, res) => {
    try {
        const { email } = req.body;

        const user = await User.findByEmail(email);
        
        // Always return success to prevent email enumeration
        if (!user) {
            return res.json({ 
                success: true, 
                message: 'If an account exists with this email, a reset link will be sent.' 
            });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000); // 1 hour

        await User.setResetToken(email, resetToken, expires);

        // Send email with reset link (do not reveal if it fails)
        const appBaseUrl = (process.env.APP_BASE_URL || '').trim() || `${req.protocol}://${req.get('host')}`;
        const resetUrl = `${appBaseUrl}/reset-password?token=${resetToken}`;

        try {
            await emailService.sendPasswordResetEmail({
                to: email,
                resetUrl,
                userName: user.first_name || undefined
            });
        } catch (e) {
            console.error('Password reset email send failed:', e.message);
        }

        res.json({ 
            success: true, 
            message: 'If an account exists with this email, a reset link will be sent.' 
        });
    } catch (error) {
        console.error('Password reset request error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to process request' 
        });
    }
});

// Reset password
router.post('/reset-password', passwordResetValidation, async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        const user = await User.findByResetToken(token);
        if (!user) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid or expired reset token' 
            });
        }

        await User.updatePassword(user.id, newPassword);
        await User.clearResetToken(user.id);

        await AuditTrail.log({
            userId: user.id,
            action: 'PASSWORD_RESET',
            ipAddress: req.ip
        });

        res.json({ 
            success: true, 
            message: 'Password reset successful. You can now login.' 
        });
    } catch (error) {
        console.error('Password reset error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to reset password' 
        });
    }
});

// Logout (client-side token removal, but log the action)
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_LOGOUT',
            ipAddress: req.ip
        });

        res.json({ 
            success: true, 
            message: 'Logged out successfully' 
        });
    } catch (error) {
        res.json({ success: true });
    }
});

// ============ Admin Routes ============

// Get all users (admin only)
router.get('/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, role, search, status } = req.query;
        const result = await User.getAll(parseInt(page), parseInt(limit), { role, search, status });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch users' 
        });
    }
});

// Resend verification to one user (admin)
router.post('/admin/users/:id/resend-verification', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const user = await User.findByIdAny(userId);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const result = await resendVerificationForUser({ user, req });
        if (!result.sent) {
            return res.status(400).json({
                success: false,
                error: result.reason === 'already_verified'
                    ? 'User email is already verified'
                    : 'Could not resend verification email'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'ADMIN_RESENT_VERIFICATION_EMAIL',
            entityType: 'user',
            entityId: userId,
            details: { email: user.email },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({ success: true, message: 'Verification email resent successfully' });
    } catch (error) {
        console.error('Admin resend verification error:', error);
        res.status(500).json({ success: false, error: 'Failed to resend verification email' });
    }
});

// Bulk resend verification to unverified users (admin)
router.post('/admin/users/resend-verification-unverified', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const requestedLimit = parseInt(req.body?.limit, 10);
        const limit = Number.isInteger(requestedLimit)
            ? Math.max(1, Math.min(requestedLimit, 500))
            : 200;

        const list = await User.getAll(1, limit, { status: 'pending_verification' });
        const users = list?.users || [];

        let sent = 0;
        const failed = [];

        for (const user of users) {
            try {
                const result = await resendVerificationForUser({ user, req });
                if (result.sent) sent += 1;
            } catch (error) {
                failed.push({
                    id: user.id,
                    email: user.email,
                    error: error.message
                });
            }
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'ADMIN_BULK_RESEND_VERIFICATION',
            entityType: 'user',
            details: {
                requestedLimit: limit,
                foundUnverified: users.length,
                sent,
                failedCount: failed.length
            },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({
            success: true,
            message: `Resent verification to ${sent} user(s).`,
            processed: users.length,
            sent,
            failedCount: failed.length,
            failed: failed.slice(0, 25)
        });
    } catch (error) {
        console.error('Bulk resend verification error:', error);
        res.status(500).json({ success: false, error: 'Failed to resend verification emails' });
    }
});

// Update user role (superadmin only, admins can promote to admin)
router.put('/admin/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        // Prevent self-demotion
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot change your own role' 
            });
        }

        // Validate role
        const validRoles = ['staff', 'admin', 'superadmin'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid role specified'
            });
        }

        // Only superadmins can assign superadmin role
        if (role === 'superadmin' && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmins can assign the superadmin role'
            });
        }

        // Admins cannot demote superadmins
        const targetUser = await User.findByIdAny(parseInt(id));
        if (targetUser && targetUser.role === 'superadmin' && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Admins cannot change superadmin roles'
            });
        }

        const success = await User.updateRoleWithLimits(id, role);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'USER_ROLE_UPDATED',
                entityType: 'user',
                entityId: parseInt(id),
                details: { newRole: role },
                ipAddress: req.ip
            });

            res.json({ 
                success: true, 
                message: 'User role updated successfully' 
            });
        } else {
            res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
    } catch (error) {
        console.error('Update role error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to update role' 
        });
    }
});

// Deactivate user (admin only)
router.put('/admin/users/:id/deactivate', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot deactivate yourself' 
            });
        }

        const success = await User.deactivate(id);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'USER_DEACTIVATED',
                entityType: 'user',
                entityId: parseInt(id),
                ipAddress: req.ip
            });

            res.json({ 
                success: true, 
                message: 'User deactivated successfully' 
            });
        } else {
            res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
    } catch (error) {
        console.error('Deactivate user error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to deactivate user' 
        });
    }
});

// Reactivate user (admin only)
router.put('/admin/users/:id/reactivate', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const success = await User.reactivate(id);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'USER_REACTIVATED',
                entityType: 'user',
                entityId: parseInt(id),
                ipAddress: req.ip
            });

            res.json({ 
                success: true, 
                message: 'User reactivated successfully' 
            });
        } else {
            res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
    } catch (error) {
        console.error('Reactivate user error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to reactivate user' 
        });
    }
});

// Create admin user (superadmin only)
router.post('/admin/create', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { email, password, firstName, lastName, phone, department, role } = req.body;

        // Validate role
        if (!['admin', 'superadmin'].includes(role)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid role for admin creation' 
            });
        }

        // Check if user already exists
        const existingUser = await User.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email already registered' 
            });
        }

        const userId = await User.create({
            email,
            password,
            firstName,
            lastName,
            phone,
            department,
            role
        });

        await AuditTrail.log({
            userId: req.user.id,
            action: 'ADMIN_CREATED',
            entityType: 'user',
            entityId: userId,
            details: { role },
            ipAddress: req.ip
        });

        res.status(201).json({ 
            success: true, 
            message: `${role} account created successfully`,
            userId
        });

    } catch (error) {
        console.error('Admin creation error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to create admin account' 
        });
    }
});

// Get pending approvals count (for admin dashboard)
router.get('/admin/pending-count', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await User.getPendingApprovals(1, 1);
        res.json({
            success: true,
            count: result.pagination.total
        });
    } catch (error) {
        console.error('Pending count error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get pending count'
        });
    }
});

// Approve user (superadmin only)
router.post('/admin/users/:id/approve', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = parseInt(id);

        // Get user details first (use findByIdAny to get unapproved users)
        const user = await User.findByIdAny(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        if (user.is_approved) {
            return res.status(400).json({
                success: false,
                error: 'User is already approved'
            });
        }

        if (!user.is_verified) {
            return res.status(400).json({
                success: false,
                error: 'User has not verified their email yet'
            });
        }

        // Get role from request body (default to 'staff')
        const { role = 'staff' } = req.body;

        // Validate role assignment permissions
        // Superadmins can assign any role, admins can only assign staff or admin
        const validRoles = ['staff', 'admin', 'superadmin'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid role specified'
            });
        }

        // Only superadmins can create other superadmins
        if (role === 'superadmin' && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmins can assign the superadmin role'
            });
        }

        // Admins cannot assign superadmin role
        if (role === 'superadmin' && req.user.role === 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Admins cannot assign the superadmin role'
            });
        }

        const success = await User.approveUserWithRole(userId, req.user.id, role);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'USER_APPROVED',
                entityType: 'user',
                entityId: userId,
                details: { approvedEmail: user.email, assignedRole: role },
                ipAddress: req.ip
            });

            // Send approval notification email
            try {
                const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
                const loginUrl = `${baseUrl}/#/login`;
                
                await emailService.sendApprovalEmail({
                    to: user.email,
                    userName: user.first_name || user.email,
                    loginUrl
                });
            } catch (emailError) {
                console.error('Failed to send approval email:', emailError);
            }

            res.json({
                success: true,
                message: `User approved successfully as ${role}`
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to approve user'
            });
        }
    } catch (error) {
        console.error('Approve user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to approve user'
        });
    }
});

// Verify + activate user (admin alternate to self-verification)
router.post('/admin/users/:id/verify-activate', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = parseInt(id);

        const targetUser = await User.findByIdAny(userId);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        if (targetUser.role === 'superadmin' && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmins can manage superadmin accounts'
            });
        }

        const desiredRole = req.body?.role || targetUser.role || 'student';
        const validRoles = ['student', 'staff', 'admin', 'superadmin'];
        if (!validRoles.includes(desiredRole)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid role specified'
            });
        }

        if (desiredRole === 'superadmin' && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                error: 'Only superadmins can assign the superadmin role'
            });
        }

        const success = await User.adminVerifyAndActivate(userId, req.user.id, desiredRole);
        if (!success) {
            return res.status(500).json({
                success: false,
                error: 'Failed to verify and activate user'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_VERIFIED_ACTIVATED_BY_ADMIN',
            entityType: 'user',
            entityId: userId,
            details: { email: targetUser.email, role: desiredRole },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        try {
            const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            const loginUrl = `${baseUrl}/#/login`;
            await emailService.sendApprovalEmail({
                to: targetUser.email,
                userName: targetUser.first_name || targetUser.email,
                loginUrl
            });
        } catch (emailError) {
            console.error('Failed to send verify+activate notification email:', emailError);
        }

        res.json({
            success: true,
            message: 'User verified and activated successfully'
        });
    } catch (error) {
        console.error('Verify+activate user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to verify and activate user'
        });
    }
});

// Reject user (superadmin only)
router.post('/admin/users/:id/reject', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const userId = parseInt(id);

        // Get user details first (use findByIdAny to get unapproved users)
        const user = await User.findByIdAny(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const success = await User.rejectUser(userId);

        if (success) {
            await AuditTrail.log({
                userId: req.user.id,
                action: 'USER_REJECTED',
                entityType: 'user',
                entityId: userId,
                details: { rejectedEmail: user.email, reason },
                ipAddress: req.ip
            });

            // Send rejection notification email
            try {
                await emailService.sendRejectionEmail({
                    to: user.email,
                    userName: user.first_name || user.email,
                    reason
                });
            } catch (emailError) {
                console.error('Failed to send rejection email:', emailError);
            }

            res.json({
                success: true,
                message: 'User rejected successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to reject user'
            });
        }
    } catch (error) {
        console.error('Reject user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reject user'
        });
    }
});

module.exports = router;