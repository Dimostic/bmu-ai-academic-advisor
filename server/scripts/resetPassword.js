#!/usr/bin/env node
/**
 * Emergency Password Reset Script
 * 
 * Use this script to reset a user's password from the command line.
 * Useful when email is disabled and you've forgotten your admin password.
 * 
 * Usage:
 *   node server/scripts/resetPassword.js <email> <new_password>
 * 
 * Examples:
 *   node server/scripts/resetPassword.js bmuapps@bmu.edu.ng NewPassword123
 *   node server/scripts/resetPassword.js admin@bmu.edu.ng MySecurePass!
 */

const bcrypt = require('bcryptjs');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { query, closePool } = require('../../config/db');

async function resetPassword(email, newPassword) {
    console.log('\n🔐 Emergency Password Reset Tool\n');
    console.log('================================\n');

    // Validate inputs
    if (!email || !newPassword) {
        console.error('❌ Usage: node resetPassword.js <email> <new_password>');
        console.error('   Example: node resetPassword.js admin@bmu.edu.ng NewPassword123\n');
        process.exit(1);
    }

    if (newPassword.length < 8) {
        console.error('❌ Password must be at least 8 characters long.\n');
        process.exit(1);
    }

    try {
        // Find user by email
        console.log(`🔍 Looking for user: ${email}`);
        const users = await query('SELECT id, email, role, first_name, last_name FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) {
            console.error(`❌ User not found: ${email}\n`);
            
            // Show available users
            console.log('📋 Available users:');
            const allUsers = await query('SELECT email, role FROM users WHERE is_active = TRUE ORDER BY role DESC, email');
            allUsers.forEach(u => {
                console.log(`   - ${u.email} (${u.role})`);
            });
            console.log('');
            process.exit(1);
        }

        const user = users[0];
        console.log(`✅ Found user: ${user.first_name || ''} ${user.last_name || ''} (${user.role})\n`);

        // Hash the new password
        console.log('🔒 Hashing new password...');
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update the password
        console.log('💾 Updating password in database...');
        const result = await query(
            'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
            [hashedPassword, user.id]
        );

        if (result.affectedRows > 0) {
            console.log('\n✅ Password reset successfully!\n');
            console.log('📝 Details:');
            console.log(`   Email: ${email}`);
            console.log(`   Role: ${user.role}`);
            console.log(`   New Password: ${'*'.repeat(newPassword.length)}`);
            console.log('\n🔐 You can now login with the new password.\n');

            // Log the action in audit trail
            try {
                await query(
                    `INSERT INTO audit_trail (user_id, action, entity_type, entity_id, details, created_at)
                     VALUES (?, 'PASSWORD_RESET_CLI', 'user', ?, ?, NOW())`,
                    [user.id, user.id, JSON.stringify({ method: 'CLI script', email: user.email })]
                );
                console.log('📋 Action logged to audit trail.\n');
            } catch (auditErr) {
                console.log('⚠️  Could not log to audit trail (non-critical).\n');
            }
        } else {
            console.error('❌ Failed to update password.\n');
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('\nFull error:', error);
        process.exit(1);
    } finally {
        // Close database connection
        if (typeof closePool === 'function') {
            await closePool();
        }
        process.exit(0);
    }
}

// Get command line arguments
const args = process.argv.slice(2);
const email = args[0];
const newPassword = args[1];

// Run the script
resetPassword(email, newPassword);
