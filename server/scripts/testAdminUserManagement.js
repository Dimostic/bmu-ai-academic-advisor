const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');

function loadModule(relative, mocks) {
    const filename = path.resolve(__dirname, relative);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const load = name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name);
    const wrapper = vm.runInNewContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(filename, 'utf8') + '\n})', { process, console, Buffer, setTimeout, clearTimeout }, { filename });
    wrapper(load, module, module.exports, path.dirname(filename), filename);
    return module.exports;
}

async function main() {
    const users = new Map([
        [2, { id: 2, role: 'student', is_verified: 0, is_approved: 0, is_active: 1 }],
        [3, { id: 3, role: 'student', is_verified: 1, is_approved: 0, is_active: 0 }],
        [4, { id: 4, role: 'staff', is_verified: 0, is_approved: 0, is_active: 1 }],
        [5, { id: 5, role: 'superadmin', is_verified: 0, is_approved: 0, is_active: 1 }],
        [6, { id: 6, role: 'admin', is_verified: 1, is_approved: 1, is_active: 1 }],
        [9, { id: 9, role: 'staff', is_verified: 1, is_approved: 1, is_active: 1 }]
    ]);
    users.forEach(u => { u.email = `fixture${u.id}@bmu.edu.ng`; });
    const updates = [], created = [], mail = [], audit = [];
    const User = {
        findByEmailAny: async () => null,
        findByIdAny: async id => users.get(Number(id)),
        findById: async id => users.get(Number(id)),
        create: async data => { created.push(data); return { userId: 20, verificationToken: 'fixture', isUniversityEmail: true }; },
        adminCreate: async data => { created.push(data); return 21; },
        approveUserWithRole: async (id, by, role) => { updates.push({ action: 'approve', id, role }); Object.assign(users.get(id), { role, is_approved: 1, is_active: 1 }); return true; },
        adminVerifyAndActivate: async (id, by, role) => { updates.push({ action: 'activate', id, role }); Object.assign(users.get(id), { role, is_verified: 1, is_approved: 1, is_active: 1 }); return true; },
        updateRoleWithLimits: async (id, role) => { updates.push({ action: 'role', id, role }); users.get(Number(id)).role = role; return true; }
    };
    const auth = {
        authenticateToken(req, res, next) { req.user = { id: 1, role: req.get('x-test-role') || 'superadmin', email: 'fixture-admin@bmu.edu.ng' }; next(); },
        requireAdmin(req, res, next) { return ['admin', 'superadmin'].includes(req.user.role) ? next() : res.sendStatus(403); },
        requireSuperAdmin(req, res, next) { return req.user.role === 'superadmin' ? next() : res.sendStatus(403); },
        optionalAuth(req, res, next) { next(); }
    };
    const mocks = {
        '../models/User': User,
        '../models/AuditTrail': { log: async data => { audit.push(data); } },
        '../middleware/auth': auth,
        '../services/emailService': {
            sendVerificationEmail: async () => ({ success: true }),
            sendApprovalEmail: data => { mail.push(data); return new Promise(() => {}); }
        },
        '../../config/db': { query: async (sql, args) => { updates.push({ sql, args }); return { affectedRows: 1 }; } }
    };
    for (const name of ['Document', 'ChatMessage', 'Advisor']) mocks['../models/' + name] = {};
    for (const name of ['advisorStreamService', 'responseQualityService', 'documentLabService', 'ttsService', 'bmuRecentSourceService']) mocks['../services/' + name] = {};
    const app = express();
    app.use(express.json());
    app.use('/api/users', loadModule('../routes/userRoutes.js', mocks));
    app.use('/api/admin', loadModule('../routes/adminRoutes.js', mocks));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = async (url, body, method = 'POST', role = 'superadmin') => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
        return { status: res.status, body: await res.json() };
    };
    try {
        let r = await call('/api/users/register', { firstName: 'Test', lastName: 'Student', email: 'fixture@bmu.edu.ng', password: 'Fixture@123', role: 'superadmin' });
        assert.equal(r.status, 201); assert.equal(created[0].role, 'student');
        r = await call('/api/users/register', { firstName: 'Test', lastName: 'Student', email: 'fixture@example.net', password: 'Fixture@123', role: 'superadmin' });
        assert.equal(r.status, 400, 'A supplied role must not bypass public-registration domain validation');
        r = await call('/api/admin/users', { firstName: 'Test', lastName: 'Student', email: 'new@example.net', password: 'Fixture@123' });
        assert.equal(r.status, 201); assert.equal(created[1].role, 'student');
        r = await call('/api/users/admin/users/3/approve', {});
        assert.equal(r.status, 200); assert.equal(users.get(3).role, 'student'); assert.equal(users.get(3).is_active, 1);
        const before = updates.length;
        r = await call('/api/users/admin/users/3/approve', {});
        assert.equal(r.status, 200); assert.equal(updates.length, before, 'Repeat approval must not update roles or quotas again');
        r = await call('/api/users/admin/users/2/verify-activate', {}, 'POST', 'admin');
        assert.equal(r.status, 200); assert.equal(users.get(2).role, 'student'); assert.equal(users.get(2).is_verified, 1);
        const activationCount = updates.length, emailCount = mail.length;
        r = await call('/api/users/admin/users/2/verify-activate', {}, 'POST', 'admin');
        assert.equal(r.status, 200); assert.equal(updates.length, activationCount); assert.equal(mail.length, emailCount);
        r = await call('/api/users/admin/users/4/verify-activate', {});
        assert.equal(r.status, 200); assert.equal(users.get(4).role, 'staff', 'Genuine existing staff roles must be preserved');
        r = await call('/api/users/admin/users/5/verify-activate', {}, 'POST', 'admin'); assert.equal(r.status, 403);
        r = await call('/api/users/admin/users/2/verify-activate', { role: 'superadmin' }, 'POST', 'admin'); assert.equal(r.status, 403);
        r = await call('/api/users/admin/users/not-an-id/verify-activate', {}); assert.equal(r.status, 400);
        r = await call('/api/admin/users/9/role', { role: 'student' }, 'PUT'); assert.equal(r.status, 200);
        r = await call('/api/users/admin/users/9/role', { role: 'student' }, 'PUT'); assert.equal(r.status, 200);
        r = await call('/api/admin/users/6/role', { role: 'student' }, 'PUT', 'admin'); assert.equal(r.status, 403);
        assert(mail.every(m => m.loginUrl.endsWith('/login?next=/advisor')), 'Notification links must open the advisor login');
        assert(audit.some(a => a.action === 'USER_VERIFIED_ACTIVATED_BY_ADMIN'));
        const sqlCalls = [];
        const Model = loadModule('../models/User.js', { '../../config/db': { query: async (sql, params) => { sqlCalls.push({ sql, params }); return { affectedRows: 1 }; } } });
        await Model.approveUserWithRole(2, 1); await Model.adminVerifyAndActivate(2, 1);
        assert(sqlCalls.every(c => c.params[1] === 'student'));
        assert(sqlCalls.every(c => c.sql.includes('is_active = TRUE')));
        console.log('PASS: student defaults, role preservation/editing, activation idempotency, stalled-mail responsiveness, permissions and model defaults (mock DB; no production changes).');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
