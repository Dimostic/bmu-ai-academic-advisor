#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
    enforceGuestDemoVoiceAccess,
    recordGuestDemoUsage
} = require('../middleware/usageLimits');
const { assessTranscriptQuality } = require('../services/sttService');
const { pool } = require('../../config/db');

function mockReq({ user = null, guestId = '', body = {} } = {}) {
    return {
        user,
        body,
        get(name) {
            return String(name || '').toLowerCase() === 'x-advisor-guest-demo-id' ? guestId : '';
        }
    };
}

function mockRes() {
    const res = {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
    return res;
}

function runMiddleware(req) {
    const res = mockRes();
    let nextCalled = false;
    enforceGuestDemoVoiceAccess(req, res, () => { nextCalled = true; });
    return { res, nextCalled, req };
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function closeDbPool() {
    if (pool && typeof pool.end === 'function') {
        await new Promise(resolve => pool.end(resolve));
    }
}

async function main() {
    const anonymous = runMiddleware(mockReq());
    assert(!anonymous.nextCalled, 'Anonymous STT request should not pass');
    assert(anonymous.res.statusCode === 401, 'Anonymous STT request should return 401');
    assert(anonymous.res.payload?.code === 'AUTH_OR_GUEST_DEMO_REQUIRED', 'Anonymous STT error code mismatch');

    const guestId = `test-stt-${Date.now()}`;
    const guest = runMiddleware(mockReq({ guestId }));
    assert(guest.nextCalled, 'Guest demo STT request with a guest ID should pass');
    assert(guest.req._guestDemoUsage?.key === guestId, 'Guest demo STT request should attach quota metadata');

    for (let i = 0; i < 5; i += 1) {
        recordGuestDemoUsage(mockReq({ guestId, body: { guestDemo: true } }));
    }
    const exhausted = runMiddleware(mockReq({ guestId }));
    assert(!exhausted.nextCalled, 'Exhausted guest demo STT request should not pass');
    assert(exhausted.res.statusCode === 429, 'Exhausted guest demo STT request should return 429');
    assert(exhausted.res.payload?.code === 'GUEST_DEMO_LIMIT_REACHED', 'Exhausted guest demo STT error code mismatch');

    const authed = runMiddleware(mockReq({ user: { id: 42 } }));
    assert(authed.nextCalled, 'Authenticated STT request should pass');

    const routePath = path.join(__dirname, '../routes/advisorRoutes.js');
    const routeSource = fs.readFileSync(routePath, 'utf8');
    assert(
        routeSource.includes("parseInt(process.env.ADVISOR_STT_RATE_LIMIT || '10', 10)"),
        'STT route should default to the stricter 10/minute rate limit'
    );
    assert(
        routeSource.includes('sttLimiter, enforceGuestDemoVoiceAccess, handleSttAudioUpload'),
        'STT route should enforce guest/auth access before upload parsing'
    );
    assert(
        routeSource.includes("return req.user?.id ? `user:${req.user.id}` : `ip:${ipKey}`;"),
        'STT rate limiter should key anonymous calls by IP'
    );

    const silenceArtefacts = [
        'do you translate',
        'Can you translate?',
        'Translate to English.',
        'Thank you for watching.',
        'Please like and subscribe',
        'subscribe to my channel',
        '[Music]',
        'this is a foreign language',
        'hmm'
    ];
    for (const phrase of silenceArtefacts) {
        const quality = assessTranscriptQuality(phrase);
        assert(!quality.ok, `STT should reject silence artefact: ${phrase}`);
    }

    const validQuestion = assessTranscriptQuality('Who is the Chancellor of BMU?');
    assert(validQuestion.ok, 'STT should accept a clear advisor question');

    console.log(JSON.stringify({
        ok: true,
        checked: 'advisor STT access, guest quota, rate-key, upload-order, and transcript-quality protection'
    }, null, 2));
}

main()
    .then(async () => {
        await closeDbPool();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(error.message || error);
        await closeDbPool().catch(() => {});
        process.exit(1);
    });
