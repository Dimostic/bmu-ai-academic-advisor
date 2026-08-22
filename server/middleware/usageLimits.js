/**
 * Usage-limit enforcement for the academic advisor.
 *
 * Each authenticated /api/advisor/ask* call is metered against two windows:
 *   - daily_prompt_count   resets at local midnight (UTC date boundary)
 *   - monthly_prompt_count resets when the YYYY-MM stamp changes
 *
 * Limits are read from the `users` row (`daily_prompt_limit`,
 * `monthly_prompt_limit`). A value of -1 = unlimited, which is what we set
 * for admin/superadmin in migration_advisor_usage.sql.
 *
 * Anonymous (un-authenticated) requests are NOT counted: those go through
 * `optionalAuth` so they may still reach the route, but the advisor UI now
 * gates the chat behind login, so in practice this only affects direct API
 * use which we can leave un-metered for now (and re-visit if abused).
 *
 * Public surface:
 *
 *   const { enforceLimits, recordUsage } = require('./middleware/usageLimits');
 *
 *   router.post('/ask',         optionalAuth, enforceLimits, ..., async (req, res) => {
 *       // ...do the work...
 *       await recordUsage(req); // increment counters atomically
 *   });
 */

const { query } = require('../../config/db');

const GUEST_DEMO_LIMIT = parseInt(process.env.GUEST_DEMO_PROMPT_LIMIT, 10) || 5;
const guestDemoUsage = new Map();

function _guestDemoKey(req) {
    const raw = String(req.get?.('x-advisor-guest-demo-id') || req.body?.guestDemoId || '').trim();
    if (!raw) return '';
    return raw.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 120);
}

function _truthy(value) {
    return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

/**
 * Lazily reset the rolling-window counters before any check / write.
 *
 *   * monthly: when the row's stored month_year (DATE_FORMAT(monthly_prompt_reset))
 *             differs from the current YYYY-MM.
 *   * daily:   when daily_prompt_reset is NULL or earlier than CURDATE().
 *
 * We do this in-band on the first request of each new day/month so we don't
 * need a cron. Both counters reset to 0 and the *_reset stamp is set to the
 * current period.
 */
async function _resetIfStale(userId) {
    // Single round-trip: fetch + maybe-update in one statement set.
    await query(`
        UPDATE users
        SET monthly_prompt_count = CASE
                WHEN monthly_prompt_reset IS NULL
                  OR DATE_FORMAT(monthly_prompt_reset, '%Y-%m') <> DATE_FORMAT(NOW(), '%Y-%m')
                THEN 0 ELSE monthly_prompt_count
            END,
            monthly_prompt_reset = CASE
                WHEN monthly_prompt_reset IS NULL
                  OR DATE_FORMAT(monthly_prompt_reset, '%Y-%m') <> DATE_FORMAT(NOW(), '%Y-%m')
                THEN CURDATE() ELSE monthly_prompt_reset
            END,
            daily_prompt_count = CASE
                WHEN daily_prompt_reset IS NULL
                  OR daily_prompt_reset <> CURDATE()
                THEN 0 ELSE daily_prompt_count
            END,
            daily_prompt_reset = CASE
                WHEN daily_prompt_reset IS NULL
                  OR daily_prompt_reset <> CURDATE()
                THEN CURDATE() ELSE daily_prompt_reset
            END
        WHERE id = ?
    `, [userId]);
}

/**
 * Express middleware: blocks requests that would exceed the user's daily or
 * monthly limit. Anonymous requests are passed through (no quota).
 *
 * On reject, returns 429 with a friendly JSON body the client can render:
 *   { success:false, error:'…', code:'RATE_LIMITED', limit, used, resetIn }
 */
async function enforceLimits(req, res, next) {
    try {
        const user = req.user;
        if (!user || !user.id) return next();          // anonymous; skip

        await _resetIfStale(user.id);

        const rows = await query(
            `SELECT monthly_prompt_count, monthly_prompt_limit,
                    daily_prompt_count,   daily_prompt_limit
             FROM users WHERE id = ?`,
            [user.id]
        );
        const u = rows[0] || {};

        // -1 means unlimited (admin/superadmin)
        const monthLimit = Number(u.monthly_prompt_limit ?? 100);
        const dayLimit   = Number(u.daily_prompt_limit   ?? 10);
        const monthUsed  = Number(u.monthly_prompt_count ?? 0);
        const dayUsed    = Number(u.daily_prompt_count   ?? 0);

        if (monthLimit !== -1 && monthUsed >= monthLimit) {
            return res.status(429).json({
                success: false,
                code: 'MONTHLY_LIMIT_REACHED',
                error: `You've used all ${monthLimit} questions for this month. Your quota refreshes on the 1st.`,
                limit: monthLimit,
                used: monthUsed,
                window: 'month'
            });
        }
        if (dayLimit !== -1 && dayUsed >= dayLimit) {
            return res.status(429).json({
                success: false,
                code: 'DAILY_LIMIT_REACHED',
                error: `You've used all ${dayLimit} questions for today. Try again after midnight.`,
                limit: dayLimit,
                used: dayUsed,
                window: 'day'
            });
        }

        // Stash usage info on req for downstream observability.
        req._advisorUsage = { monthLimit, monthUsed, dayLimit, dayUsed };
        return next();
    } catch (err) {
        console.error('[usageLimits.enforceLimits] error:', err.message);
        // Fail-open: don't block legitimate users on a metering bug.
        return next();
    }
}

function enforceGuestDemoLimit(req, res, next) {
    const user = req.user;
    if (user?.id) return next();
    if (!_truthy(req.body?.guestDemo)) {
        return res.status(401).json({
            success: false,
            code: 'AUTH_OR_GUEST_DEMO_REQUIRED',
            error: 'Please sign in or start the guest demo to ask Dr. Tari.'
        });
    }

    const key = _guestDemoKey(req);
    if (!key) {
        return res.status(400).json({
            success: false,
            code: 'GUEST_DEMO_ID_REQUIRED',
            error: 'Guest demo session is required.'
        });
    }

    const used = Number(guestDemoUsage.get(key) || 0);
    if (used >= GUEST_DEMO_LIMIT) {
        return res.status(429).json({
            success: false,
            code: 'GUEST_DEMO_LIMIT_REACHED',
            error: `You've used all ${GUEST_DEMO_LIMIT} guest demo questions. Create an account to continue.`,
            limit: GUEST_DEMO_LIMIT,
            used,
            window: 'guest_demo'
        });
    }

    req._guestDemoUsage = { key, used, limit: GUEST_DEMO_LIMIT };
    return next();
}

function enforceGuestDemoAccess(req, res, next) {
    const user = req.user;
    if (user?.id) return next();
    if (!_truthy(req.body?.guestDemo)) {
        return res.status(401).json({
            success: false,
            code: 'AUTH_OR_GUEST_DEMO_REQUIRED',
            error: 'Please sign in or start the guest demo to use Dr. Tari voice input.'
        });
    }

    const key = _guestDemoKey(req);
    if (!key) {
        return res.status(400).json({
            success: false,
            code: 'GUEST_DEMO_ID_REQUIRED',
            error: 'Guest demo session is required.'
        });
    }

    const used = Number(guestDemoUsage.get(key) || 0);
    if (used >= GUEST_DEMO_LIMIT) {
        return res.status(429).json({
            success: false,
            code: 'GUEST_DEMO_LIMIT_REACHED',
            error: `You've used all ${GUEST_DEMO_LIMIT} guest demo questions. Create an account to continue.`,
            limit: GUEST_DEMO_LIMIT,
            used,
            window: 'guest_demo'
        });
    }

    req._guestDemoUsage = { key, used, limit: GUEST_DEMO_LIMIT };
    return next();
}

/**
 * Increment both daily and monthly counters for the user. Idempotent enough
 * for our purposes — call once per successful advisor reply.
 */
async function recordUsage(req) {
    try {
        const user = req?.user;
        if (!user || !user.id) return;
        await _resetIfStale(user.id);
        await query(
            `UPDATE users
             SET monthly_prompt_count = COALESCE(monthly_prompt_count, 0) + 1,
                 daily_prompt_count   = COALESCE(daily_prompt_count, 0)   + 1
             WHERE id = ?`,
            [user.id]
        );
    } catch (err) {
        console.error('[usageLimits.recordUsage] error:', err.message);
    }
}

function recordGuestDemoUsage(req) {
    const user = req?.user;
    if (user?.id || !req?.body?.guestDemo) return null;
    const key = req?._guestDemoUsage?.key || _guestDemoKey(req);
    if (!key) return null;

    const used = Math.min(GUEST_DEMO_LIMIT, Number(guestDemoUsage.get(key) || 0) + 1);
    guestDemoUsage.set(key, used);
    return { used, limit: GUEST_DEMO_LIMIT, remaining: Math.max(0, GUEST_DEMO_LIMIT - used) };
}

/**
 * Public read-only summary of the caller's current quotas. Used by the client
 * to render a "12 / 100 this month" badge.
 */
async function getUsage(req, res) {
    try {
        if (!req.user?.id) return res.json({ success: true, anonymous: true });
        await _resetIfStale(req.user.id);
        const rows = await query(
            `SELECT monthly_prompt_count, monthly_prompt_limit,
                    daily_prompt_count,   daily_prompt_limit
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        const u = rows[0] || {};
        res.json({
            success: true,
            month: { used: Number(u.monthly_prompt_count || 0), limit: Number(u.monthly_prompt_limit ?? 100) },
            day:   { used: Number(u.daily_prompt_count || 0),   limit: Number(u.daily_prompt_limit   ?? 10) }
        });
    } catch (err) {
        console.error('[usageLimits.getUsage] error:', err.message);
        res.status(500).json({ success: false, error: 'Could not fetch usage' });
    }
}

module.exports = { enforceLimits, recordUsage, getUsage, enforceGuestDemoLimit, enforceGuestDemoAccess, recordGuestDemoUsage };
