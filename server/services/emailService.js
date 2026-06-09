const nodemailer = require('nodemailer');

class EmailService {
    constructor() {
        this.enabled = process.env.EMAIL_ENABLED === 'true';

        // Backwards compatible FROM handling:
        // - Prefer explicit FROM_NAME/FROM_EMAIL if provided
        // - Else fall back to EMAIL_FROM
        // - Else default to no-reply
        const fromEmail = process.env.FROM_EMAIL || process.env.EMAIL_FROM || 'no-reply@bmu.edu.ng';
        const fromName = process.env.FROM_NAME;
        this.from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

        // Lazily created transporter
        this._transporter = null;
    }

    getTransporter() {
        if (this._transporter) return this._transporter;

        // Support SMTP (recommended) or a generic sendmail fallback for dev.
        if (process.env.EMAIL_TRANSPORT === 'sendmail') {
            this._transporter = nodemailer.createTransport({
                sendmail: true,
                newline: 'unix',
                path: process.env.SENDMAIL_PATH || undefined
            });
            return this._transporter;
        }

        // Default: SMTP
        const host = process.env.SMTP_HOST;
        const port = Number(process.env.SMTP_PORT || 587);
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;

        if (!host) {
            throw new Error('SMTP_HOST not configured');
        }

        // Nodemailer:
        // - secure=true typically means SMTPS (port 465)
        // - port 587 typically uses STARTTLS with secure=false
        // Accept common values for SMTP_SECURE:
        // - true/false
        // - tls/starttls (treated as NOT SMTPS, i.e. secure=false)
        const secureRaw = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
        const isTruthy = secureRaw === 'true' || secureRaw === '1' || secureRaw === 'yes';
        const isStartTlsHint = secureRaw === 'tls' || secureRaw === 'starttls';
        const secure = port === 465 ? true : (isStartTlsHint ? false : isTruthy);

        // TLS options - handle self-signed or untrusted certificates
        // Set SMTP_REJECT_UNAUTHORIZED=false to skip certificate validation (not recommended for production)
        const rejectUnauthorized = process.env.SMTP_REJECT_UNAUTHORIZED !== 'false';

        this._transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: user ? { user, pass } : undefined,
            tls: {
                // Do not fail on invalid/self-signed certs if configured
                rejectUnauthorized,
                // Minimum TLS version
                minVersion: 'TLSv1.2'
            }
        });

        console.log(`[EmailService] SMTP configured: ${host}:${port}, secure=${secure}, rejectUnauthorized=${rejectUnauthorized}`);

        return this._transporter;
    }

    async sendMail({ to, subject, text, html }) {
        if (!this.enabled) {
            console.log('[EmailService] Email disabled, skipping send');
            return { success: false, disabled: true };
        }

        try {
            const transporter = this.getTransporter();
            const info = await transporter.sendMail({
                from: this.from,
                to,
                subject,
                text,
                html
            });

            console.log(`[EmailService] Email sent to ${to}, messageId: ${info.messageId}`);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            console.error('[EmailService] Failed to send email:', error.message);
            if (error.code) {
                console.error('[EmailService] Error code:', error.code);
            }
            throw error;
        }
    }

    async sendPasswordResetEmail({ to, resetUrl, userName }) {
        const subject = 'BMU AI Assistant - Password Reset';
        const safeName = userName ? String(userName) : 'there';

        const text = [
            `Hello ${safeName},`,
            '',
            'We received a request to reset your BMU AI Assistant password.',
            '',
            'Click the link below to reset your password (valid for 1 hour):',
            resetUrl,
            '',
            'If you did not request a password reset, you can safely ignore this email.',
            '',
            'Best regards,',
            'BMU AI Assistant Team'
        ].join('\n');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2c3e50;">Password Reset Request</h2>
                <p>Hello ${safeName},</p>
                <p>We received a request to reset your BMU AI Assistant password.</p>
                <p style="margin: 30px 0;">
                    <a href="${resetUrl}" style="background-color: #e74c3c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        Reset Password
                    </a>
                </p>
                <p><small>This link is valid for 1 hour.</small></p>
                <p style="color: #7f8c8d; font-size: 14px; margin-top: 20px;">
                    If the button above doesn't work, copy and paste this URL into your browser:<br>
                    <a href="${resetUrl}" style="color: #3498db; word-break: break-all;">${resetUrl}</a>
                </p>
                <p>If you did not request a password reset, you can safely ignore this email.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="color: #95a5a6; font-size: 12px;">BMU AI Assistant - Bayelsa Medical University</p>
            </div>
        `;

        return this.sendMail({ to, subject, text, html });
    }

    // Send email verification link
    async sendVerificationEmail({ to, verifyUrl, userName }) {
        const subject = 'BMU AI Assistant - Verify Your Email';
        const safeName = userName ? String(userName) : 'there';

        const text = [
            `Hello ${safeName},`,
            '',
            'Welcome to BMU AI Assistant! Please verify your email address to activate your account.',
            '',
            `Click the link below to verify your email (valid for 24 hours):`,
            verifyUrl,
            '',
            'After email verification, your account will need to be approved by an administrator before you can log in.',
            '',
            'If you did not create an account, you can ignore this email.',
            '',
            'Best regards,',
            'BMU AI Assistant Team'
        ].join('\n');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2c3e50;">Welcome to BMU AI Assistant!</h2>
                <p>Hello ${safeName},</p>
                <p>Thank you for registering. Please verify your email address to activate your account.</p>
                <p style="margin: 30px 0;">
                    <a href="${verifyUrl}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        Verify Email Address
                    </a>
                </p>
                <p><small>This link is valid for 24 hours.</small></p>
                <p style="color: #7f8c8d; font-size: 14px; margin-top: 20px;">
                    If the button above doesn't work, copy and paste this URL into your browser:<br>
                    <a href="${verifyUrl}" style="color: #3498db; word-break: break-all;">${verifyUrl}</a>
                </p>
                <p style="color: #7f8c8d; font-size: 14px; margin-top: 20px;">
                    <strong>Note:</strong> After email verification, your account will need to be approved by an administrator before you can log in.
                </p>
                <p>If you did not create an account, you can safely ignore this email.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="color: #95a5a6; font-size: 12px;">BMU AI Assistant - Bayelsa Medical University</p>
            </div>
        `;

        return this.sendMail({ to, subject, text, html });
    }

    // Notify user their account has been approved
    async sendApprovalEmail({ to, userName, loginUrl }) {
        const subject = 'BMU AI Assistant - Account Approved!';
        const safeName = userName ? String(userName) : 'there';
        
        // Ensure loginUrl has a fallback
        const safeLoginUrl = loginUrl || (process.env.APP_BASE_URL 
            ? `${process.env.APP_BASE_URL}/#/login` 
            : 'https://bmuaiagent.mehetti.com/#/login');

        const text = [
            `Hello ${safeName},`,
            '',
            'Great news! Your BMU AI Assistant account has been approved by an administrator.',
            '',
            'You can now log in and start using the platform:',
            safeLoginUrl,
            '',
            'Best regards,',
            'BMU AI Assistant Team'
        ].join('\n');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #27ae60;">🎉 Account Approved!</h2>
                <p>Hello ${safeName},</p>
                <p>Great news! Your BMU AI Assistant account has been approved by an administrator.</p>
                <p style="margin: 30px 0;">
                    <a href="${safeLoginUrl}" style="background-color: #27ae60; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        Log In Now
                    </a>
                </p>
                <p style="color: #7f8c8d; font-size: 14px; margin-top: 20px;">
                    If the button above doesn't work, copy and paste this URL into your browser:<br>
                    <a href="${safeLoginUrl}" style="color: #3498db; word-break: break-all;">${safeLoginUrl}</a>
                </p>
                <p>If you have any questions, please contact your administrator.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="color: #95a5a6; font-size: 12px;">BMU AI Assistant - Bayelsa Medical University</p>
            </div>
        `;

        return this.sendMail({ to, subject, text, html });
    }

    // Notify user their account has been rejected/unapproved
    async sendRejectionEmail({ to, userName, reason }) {
        const subject = 'BMU AI Assistant - Account Status Update';
        const safeName = userName ? String(userName) : 'there';
        const reasonText = reason || 'No specific reason provided.';

        const text = [
            `Hello ${safeName},`,
            '',
            'We regret to inform you that your BMU AI Assistant account request could not be approved at this time.',
            '',
            reason ? `Reason: ${reasonText}` : '',
            '',
            'If you believe this is an error or have questions, please contact the university IT department.',
            '',
            'Best regards,',
            'BMU AI Assistant Team'
        ].filter(Boolean).join('\n');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #e74c3c;">Account Status Update</h2>
                <p>Hello ${safeName},</p>
                <p>We regret to inform you that your BMU AI Assistant account request could not be approved at this time.</p>
                ${reason ? `<p><strong>Reason:</strong> ${reasonText}</p>` : ''}
                <p>If you believe this is an error or have questions, please contact the university IT department.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="color: #95a5a6; font-size: 12px;">BMU AI Assistant - Bayelsa Medical University</p>
            </div>
        `;

        return this.sendMail({ to, subject, text, html });
    }

    // Notify admins of new user pending approval
    async sendAdminNotificationEmail({ to, newUserEmail, newUserName, adminUrl }) {
        const subject = 'BMU AI Assistant - New User Pending Approval';
        const safeName = newUserName || newUserEmail;

        const text = [
            'Hello Administrator,',
            '',
            `A new user has verified their email and is pending your approval:`,
            '',
            `Name: ${safeName}`,
            `Email: ${newUserEmail}`,
            '',
            `Please review and approve/reject the user:`,
            adminUrl,
            '',
            'BMU AI Assistant'
        ].join('\n');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #f39c12;">⏳ New User Pending Approval</h2>
                <p>Hello Administrator,</p>
                <p>A new user has verified their email and is pending your approval:</p>
                <table style="margin: 20px 0; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 8px; font-weight: bold;">Name:</td>
                        <td style="padding: 8px;">${safeName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px; font-weight: bold;">Email:</td>
                        <td style="padding: 8px;">${newUserEmail}</td>
                    </tr>
                </table>
                <p style="margin: 30px 0;">
                    <a href="${adminUrl}" style="background-color: #f39c12; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        Review User
                    </a>
                </p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="color: #95a5a6; font-size: 12px;">BMU AI Assistant - Bayelsa Medical University</p>
            </div>
        `;

        return this.sendMail({ to, subject, text, html });
    }
}

module.exports = new EmailService();
