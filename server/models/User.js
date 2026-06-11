const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../../config/db');

class User {
    // Create a new user (email verification REQUIRED).
    //
    // Security note: a previous version auto-approved any email whose string
    // happened to end with "@bmu.edu.ng" — including obvious fakes like
    // attacker@bmu.edu.ng for which the registrant did NOT control the inbox.
    // Now ALL accounts start as is_verified=0, is_approved=0 and require:
    //   1. Clicking the link emailed to the address  → is_verified=1
    //   2. After that, BMU-domain emails are auto-approved (since the user
    //      proved control of a BMU mailbox); other domains still need an
    //      admin to flip is_approved.
    // This closes the spoof-the-domain hole without losing the convenience
    // of fast onboarding for legitimate BMU staff/students.
    static async create(userData) {
        const { email, password, firstName, lastName, phone, department, matricNo, role = 'student' } = userData;
        const hashedPassword = await bcrypt.hash(password, 10);

        const universityDomain = (process.env.UNIVERSITY_DOMAIN || 'bmu.edu.ng').toLowerCase();
        const isUniversityEmail = typeof email === 'string'
            && email.toLowerCase().endsWith('@' + universityDomain);

        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Everyone starts unverified + unapproved. The /verify-email route
        // promotes verified BMU users straight to is_approved=1; non-BMU
        // emails go to the admin pending queue after verification.
        const sql = `
            INSERT INTO users (email, password, first_name, last_name, phone, department, matric_no, role,
                verification_token, verification_token_expires,
                is_verified, is_approved, is_active,
                monthly_prompt_limit, monthly_prompt_count,
                daily_prompt_limit,   daily_prompt_count,
                created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, TRUE, 100, 0, 10, 0, NOW())
        `;
        const result = await query(sql, [
            email, hashedPassword, firstName, lastName, phone, department,
            matricNo || null,
            role,
            verificationToken, verificationTokenExpires
        ]);
        return {
            userId: result.insertId,
            verificationToken,
            isUniversityEmail
        };
    }

    // Create a user from an admin form. Skips email verification entirely
    // (the admin is vouching for the address) and forces a password change
    // on the next login so the temporary password the admin chose isn't kept.
    static async adminCreate({ email, password, firstName, lastName, role = 'student', department = null, phone = null, matricNo = null }) {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `
            INSERT INTO users (email, password, must_change_password,
                first_name, last_name, phone, department, matric_no, role,
                is_verified, is_approved, is_active, approved_at,
                monthly_prompt_limit, monthly_prompt_count,
                daily_prompt_limit,   daily_prompt_count,
                created_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1, TRUE, NOW(), 100, 0, 10, 0, NOW())
        `;
        const result = await query(sql, [
            email, hashedPassword,
            firstName, lastName, phone, department,
            matricNo || null, role
        ]);
        return result.insertId;
    }

    // Find user by email (for login - must be verified AND approved)
    static async findByEmail(email) {
        const sql = 'SELECT * FROM users WHERE email = ? AND is_active = TRUE';
        const results = await query(sql, [email]);
        return results[0] || null;
    }

    // Find user by email (including unverified/unapproved for registration check)
    static async findByEmailAny(email) {
        const sql = 'SELECT * FROM users WHERE email = ?';
        const results = await query(sql, [email]);
        return results[0] || null;
    }

    // Find user by verification token
    static async findByVerificationToken(token) {
        const sql = 'SELECT * FROM users WHERE verification_token = ? AND verification_token_expires > NOW()';
        const results = await query(sql, [token]);
        return results[0] || null;
    }

    // Verify user email. If the email belongs to the BMU university domain,
    // also auto-approve the account so the holder can log in immediately
    // (proving control of a BMU mailbox is sufficient evidence of legitimacy).
    // Non-BMU emails still go through the admin pending-approval queue.
    static async verifyEmail(userId) {
        const universityDomain = (process.env.UNIVERSITY_DOMAIN || 'bmu.edu.ng').toLowerCase();
        const sql = `
            UPDATE users
            SET is_verified = TRUE,
                verification_token = NULL,
                verification_token_expires = NULL,
                is_approved = CASE
                    WHEN LOWER(email) LIKE ? THEN 1
                    ELSE is_approved
                END,
                approved_at = CASE
                    WHEN LOWER(email) LIKE ? AND approved_at IS NULL THEN NOW()
                    ELSE approved_at
                END,
                updated_at = NOW()
            WHERE id = ?
        `;
        const result = await query(sql, [`%@${universityDomain}`, `%@${universityDomain}`, userId]);
        return result.affectedRows > 0;
    }

    // Set / clear the must_change_password flag.
    static async setMustChangePassword(userId, value) {
        await query(
            `UPDATE users SET must_change_password = ?, updated_at = NOW() WHERE id = ?`,
            [value ? 1 : 0, userId]
        );
    }

    // Approve user (admin/superadmin) - requires email to be verified first
    static async approveUser(userId, approvedById) {
        const sql = `
            UPDATE users 
            SET is_approved = TRUE, is_active = TRUE, approved_by = ?, approved_at = NOW(), updated_at = NOW() 
            WHERE id = ? AND is_verified = TRUE
        `;
        const result = await query(sql, [approvedById, userId]);
        return result.affectedRows > 0;
    }

    // Reject/unapprove user
    static async rejectUser(userId) {
        const sql = `
            UPDATE users 
            SET is_approved = FALSE, approved_by = NULL, approved_at = NULL, updated_at = NOW() 
            WHERE id = ?
        `;
        const result = await query(sql, [userId]);
        return result.affectedRows > 0;
    }

    // Resend verification email (regenerate token)
    static async regenerateVerificationToken(userId) {
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        
        const sql = `
            UPDATE users 
            SET verification_token = ?, verification_token_expires = ?, updated_at = NOW() 
            WHERE id = ? AND is_verified = FALSE
        `;
        const result = await query(sql, [verificationToken, verificationTokenExpires, userId]);
        return result.affectedRows > 0 ? verificationToken : null;
    }

    // Get pending approvals (verified but not approved)
    static async getPendingApprovals(page = 1, limit = 20) {
        const offset = (page - 1) * limit;
        
        const countSql = `SELECT COUNT(*) as total FROM users WHERE is_verified = TRUE AND is_approved = FALSE AND is_active = TRUE`;
        const countResult = await query(countSql);
        const total = countResult[0].total;

        const sql = `
            SELECT id, email, first_name, last_name, phone, department, role, created_at 
            FROM users 
            WHERE is_verified = TRUE AND is_approved = FALSE AND is_active = TRUE
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `;
        const users = await query(sql, [limit, offset]);

        return {
            users,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    // Find user by ID
    static async findById(id) {
        // The DB schema may not include newer columns (e.g., whatsapp_number) depending on setup.
        // Use a schema-tolerant query: check columns first, then select only what exists.
        const cols = await query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
        );
        const colSet = new Set((cols || []).map(c => c.COLUMN_NAME));

        const selectCols = [
            'id',
            'email',
            'first_name',
            'last_name',
            'phone',
            'department',
            'role',
            // optional columns
            colSet.has('whatsapp_number') ? 'whatsapp_number' : null,
            colSet.has('is_verified') ? 'is_verified' : null,
            colSet.has('must_change_password') ? 'must_change_password' : null,
            colSet.has('created_at') ? 'created_at' : null,
            colSet.has('last_login') ? 'last_login' : null
        ].filter(Boolean);

        const sql = `SELECT ${selectCols.join(', ')} FROM users WHERE id = ? AND is_active = TRUE`;
        const results = await query(sql, [id]);
        return results[0] || null;
    }

    // Update user
    static async update(id, updates) {
        const allowedFields = ['first_name', 'last_name', 'phone', 'department', 'whatsapp_number'];
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
            if (allowedFields.includes(dbKey)) {
                fields.push(`${dbKey} = ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return false;

        values.push(id);
        const sql = `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`;
        const result = await query(sql, values);
        return result.affectedRows > 0;
    }

    // Update password
    static async updatePassword(id, newPassword) {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const sql = 'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [hashedPassword, id]);
        return result.affectedRows > 0;
    }

    // Set reset token
    static async setResetToken(email, token, expires) {
        const sql = 'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE email = ?';
        const result = await query(sql, [token, expires, email]);
        return result.affectedRows > 0;
    }

    // Find by reset token
    static async findByResetToken(token) {
        const sql = 'SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > NOW() AND is_active = TRUE';
        const results = await query(sql, [token]);
        return results[0] || null;
    }

    // Clear reset token
    static async clearResetToken(id) {
        const sql = 'UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = ?';
        await query(sql, [id]);
    }

    // Update last login
    static async updateLastLogin(id) {
        const sql = 'UPDATE users SET last_login = NOW() WHERE id = ?';
        await query(sql, [id]);
    }

    // Verify password
    static async verifyPassword(plainPassword, hashedPassword) {
        return bcrypt.compare(plainPassword, hashedPassword);
    }

    // Get all users (admin only)
    static async getAll(page = 1, limit = 20, filters = {}) {
        const offset = (page - 1) * limit;
        let whereClause = 'WHERE is_active = TRUE';
        const params = [];

        if (filters.role) {
            whereClause += ' AND role = ?';
            params.push(filters.role);
        }

        if (filters.search) {
            whereClause += ' AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        // Filter by verification/approval status
        if (filters.status === 'pending_verification') {
            whereClause += ' AND is_verified = FALSE';
        } else if (filters.status === 'pending_approval') {
            whereClause += ' AND is_verified = TRUE AND is_approved = FALSE';
        } else if (filters.status === 'approved') {
            whereClause += ' AND is_verified = TRUE AND is_approved = TRUE';
        }

        const countSql = `SELECT COUNT(*) as total FROM users ${whereClause}`;
        const countResult = await query(countSql, params);
        const total = countResult[0].total;

        params.push(limit, offset);
        const sql = `
            SELECT id, email, first_name, last_name, phone, department, role, 
                   is_verified, is_approved, approved_by, approved_at, created_at, last_login 
            FROM users ${whereClause} 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `;
        const users = await query(sql, params);

        return {
            users,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    // Update user role (admin only)
    static async updateRole(id, role) {
        const validRoles = ['student', 'staff', 'admin', 'superadmin'];
        if (!validRoles.includes(role)) {
            throw new Error('Invalid role');
        }
        const sql = 'UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [role, id]);
        return result.affectedRows > 0;
    }

    // Deactivate user
    static async deactivate(id) {
        const sql = 'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    // Reactivate user
    static async reactivate(id) {
        const sql = 'UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [id]);
        return result.affectedRows > 0;
    }

    // Get all superadmins (for notifications)
    static async getSuperadmins() {
        const sql = `
            SELECT id, email, first_name, last_name 
            FROM users 
            WHERE role = 'superadmin' AND is_active = TRUE AND is_verified = TRUE AND is_approved = TRUE
        `;
        return await query(sql);
    }

    // Find user by ID (including unapproved users for admin panel)
    static async findByIdAny(id) {
        const sql = 'SELECT * FROM users WHERE id = ?';
        const results = await query(sql, [id]);
        return results[0] || null;
    }

    // Log audit action
    static async logAction(userId, action, entityType = null, entityId = null, details = null, ipAddress = null, userAgent = null) {
        const sql = `
            INSERT INTO audit_trail (user_id, action, entity_type, entity_id, details, ip_address, user_agent, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        await query(sql, [userId, action, entityType, entityId, details ? JSON.stringify(details) : null, ipAddress, userAgent]);
    }

    // =====================================================
    // Monthly Prompt Limits
    // =====================================================

    // Check if user can send a prompt (returns { allowed, remaining, limit })
    static async checkPromptLimit(userId) {
        const user = await this.findByIdAny(userId);
        if (!user) return { allowed: false, remaining: 0, limit: 0, error: 'User not found' };

        // Admins and superadmins have unlimited prompts (limit = -1)
        if (user.role === 'admin' || user.role === 'superadmin') {
            return { allowed: true, remaining: -1, limit: -1, unlimited: true };
        }

        // Default limit is 100 prompts per month for regular users
        const limit = user.monthly_prompt_limit || 100;
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        const resetDate = user.monthly_prompt_reset ? new Date(user.monthly_prompt_reset).toISOString().slice(0, 7) : null;

        // Reset count if it's a new month
        if (!resetDate || resetDate !== currentMonth) {
            await query(
                'UPDATE users SET monthly_prompt_count = 0, monthly_prompt_reset = CURDATE() WHERE id = ?',
                [userId]
            );
            return { allowed: true, remaining: limit, limit, count: 0 };
        }

        const count = user.monthly_prompt_count || 0;
        const remaining = Math.max(0, limit - count);

        return {
            allowed: count < limit,
            remaining,
            limit,
            count
        };
    }

    // Increment user's monthly prompt count
    static async incrementPromptCount(userId) {
        const sql = 'UPDATE users SET monthly_prompt_count = COALESCE(monthly_prompt_count, 0) + 1 WHERE id = ?';
        await query(sql, [userId]);
    }

    // Get user's usage stats
    static async getUsageStats(userId) {
        const limitCheck = await this.checkPromptLimit(userId);
        
        // Get token usage for current month
        const monthYear = new Date().toISOString().slice(0, 7);
        const tokenSql = `
            SELECT 
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as completion_tokens
            FROM usage_logs 
            WHERE user_id = ? AND month_year = ?
        `;
        const tokenResult = await query(tokenSql, [userId, monthYear]);
        
        return {
            ...limitCheck,
            tokens: tokenResult[0] || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 }
        };
    }

    // Approve user with role assignment
    static async approveUserWithRole(userId, approvedById, role = 'staff') {
        const validRoles = ['student', 'staff', 'admin', 'superadmin'];
        if (!validRoles.includes(role)) {
            throw new Error('Invalid role');
        }

        // Set prompt limit based on role (100 for staff, unlimited for admin/superadmin)
        const promptLimit = (role === 'admin' || role === 'superadmin') ? -1 : 100;

        const sql = `
            UPDATE users 
            SET is_approved = TRUE, 
                approved_by = ?, 
                approved_at = NOW(), 
                role = ?,
                monthly_prompt_limit = ?,
                updated_at = NOW() 
            WHERE id = ? AND is_verified = TRUE
        `;
        const result = await query(sql, [approvedById, role, promptLimit, userId]);
        return result.affectedRows > 0;
    }

    // Update role with appropriate limits
    static async updateRoleWithLimits(id, role) {
        const validRoles = ['student', 'staff', 'admin', 'superadmin'];
        if (!validRoles.includes(role)) {
            throw new Error('Invalid role');
        }

        // Set prompt limit based on role (100 for staff, unlimited for admin/superadmin)
        const promptLimit = (role === 'admin' || role === 'superadmin') ? -1 : 100;

        const sql = 'UPDATE users SET role = ?, monthly_prompt_limit = ?, updated_at = NOW() WHERE id = ?';
        const result = await query(sql, [role, promptLimit, id]);
        return result.affectedRows > 0;
    }
}

module.exports = User;