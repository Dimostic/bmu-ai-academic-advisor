/* eslint-disable no-console */
/**
 * BMU AI Academic Advisor — admin portal client.
 *
 * This is a single-page admin app with sidebar navigation. It consumes the
 * existing admin/document/user/audit/faq APIs (no new endpoints required).
 *
 * Sections:
 *   - dashboard: stats overview (users, documents, FAQs, retrieval timing)
 *   - documents: list + upload + delete + re-process
 *   - faqs:     list + per-document generation
 *   - users:    list + approve pending + change role + (de)activate
 *   - audit:    recent audit-trail entries
 *   - metrics:  retrieval / FAQ / performance numbers
 */
(() => {
    'use strict';

    // ------------------------------------------------------------------ Auth
    const token = localStorage.getItem('bmu_token') || sessionStorage.getItem('bmu_token');
    if (!token) {
        location.replace('/login?next=/admin');
        return;
    }

    function authHeaders(extra) {
        return Object.assign({ Authorization: 'Bearer ' + token }, extra || {});
    }

    async function api(path, opts) {
        opts = opts || {};
        const init = {
            method: opts.method || 'GET',
            headers: authHeaders(opts.body && !opts.formData ? { 'Content-Type': 'application/json' } : {}),
            body: opts.body
                ? (opts.formData ? opts.body : JSON.stringify(opts.body))
                : undefined
        };
        const res = await fetch(path, init);
        if (res.status === 401 || res.status === 403) {
            // Forbidden: probably not an admin. Bounce back to advisor.
            if (path !== '/api/admin/stats') {
                toast(res.status === 403 ? 'Admin access required' : 'Session expired', 'error');
                if (res.status === 401) {
                    setTimeout(() => location.replace('/login?next=/admin'), 1200);
                }
            }
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'unauthorised');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
    }

    // ----------------------------------------------------------------- Toast
    const toastHost = document.getElementById('toastHost');
    function toast(msg, kind) {
        const el = document.createElement('div');
        el.className = 'toast' + (kind === 'error' ? ' toast--error' : '');
        el.textContent = msg;
        toastHost.appendChild(el);
        setTimeout(() => el.remove(), 4200);
    }

    // -------------------------------------------------------- Topbar / auth
    let user = null;
    try { user = JSON.parse(localStorage.getItem('bmu_user') || 'null'); } catch (_) {}
    const authSlot = document.getElementById('authSlot');
    function renderAuthSlot() {
        const name = (user?.firstName || user?.first_name || user?.email || 'You').toString().split(' ')[0];
        authSlot.innerHTML = `
            <span class="link-muted" title="${escapeHtml(user?.email || '')}">
                <i class="fa-solid fa-user-shield"></i> ${escapeHtml(name)}
            </span>
            <button id="logoutBtn" class="btn btn-ghost" title="Sign out">
                <i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out
            </button>
        `;
        document.getElementById('logoutBtn').addEventListener('click', () => {
            localStorage.removeItem('bmu_token');
            localStorage.removeItem('bmu_user');
            sessionStorage.removeItem('bmu_token');
            location.replace('/');
        });
    }
    renderAuthSlot();

    // ---------------------------------------------------------- Section nav
    const main = document.getElementById('adminMain');
    const navButtons = document.querySelectorAll('.admin-nav button');
    const sections = {
        dashboard: renderDashboard,
        documents: renderDocuments,
        faqs:      renderFAQs,
        users:     renderUsers,
        audit:     renderAudit,
        metrics:   renderMetrics,
        curate:    renderCurate
    };
    navButtons.forEach(b => b.addEventListener('click', () => {
        navButtons.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const fn = sections[b.dataset.section];
        if (fn) fn();
    }));

    // -------------------------------------------------------- DASHBOARD
    async function renderDashboard() {
        main.innerHTML = `
            <h2>Dashboard</h2>
            <p class="lede">Health and traffic at a glance.</p>
            <div class="stat-row" id="statRow"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
            <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Recent activity</h3>
            <div id="recent"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        try {
            const data = await api('/api/admin/dashboard');
            const d = data.dashboard || {};
            const u = d.users || {}; const docs = d.documents || {}; const c = d.chat || {};
            document.getElementById('statRow').innerHTML = [
                stat('Users (active)', u.total ?? '—'),
                stat('Pending approvals', u.pending_approval ?? '—'),
                stat('Documents', docs.total ?? '—'),
                stat('Indexed chunks', docs.trained ?? docs.completed ?? '—'),
                stat('Messages (30d)', c.total_messages ?? '—'),
                stat('Sessions (30d)', c.total_sessions ?? '—')
            ].join('');

            const recent = d.recentActivity || [];
            if (!recent.length) {
                document.getElementById('recent').innerHTML = '<p class="empty">No activity yet.</p>';
            } else {
                document.getElementById('recent').innerHTML =
                    table(['Date', 'Messages'], recent.map(r => [r.date, r.message_count]));
            }
        } catch (err) {
            main.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }
    function stat(label, value, delta) {
        return `<div class="stat-card">
            <div class="label">${escapeHtml(label)}</div>
            <div class="value">${escapeHtml(String(value))}</div>
            ${delta ? `<div class="delta">${escapeHtml(delta)}</div>` : ''}
        </div>`;
    }

    // -------------------------------------------------------- DOCUMENTS
    async function renderDocuments() {
        main.innerHTML = `
            <h2>Documents</h2>
            <p class="lede">Upload BMU documents (PDF, Word, Excel, Markdown). Each upload is automatically extracted, chunked, and embedded.</p>
            <div class="admin-actions">
                <label class="dropzone" id="dropzone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <strong>Click or drop a file here to upload</strong>
                    <small style="display:block; margin-top:4px;">PDF, DOCX, XLSX, TXT, MD up to 100MB</small>
                    <input type="file" id="fileInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.md" />
                </label>
            </div>
            <div id="docList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading documents…</div></div>
        `;
        document.getElementById('fileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0]; if (!file) return;
            const fd = new FormData();
            fd.append('file', file);
            fd.append('title', file.name);
            fd.append('category', 'general');
            try {
                toast('Uploading ' + file.name + '…');
                await api('/api/documents/upload', { method: 'POST', body: fd, formData: true });
                toast('Uploaded — processing in the background.');
                renderDocuments();
            } catch (err) {
                toast(err.message || 'Upload failed', 'error');
            }
        });

        try {
            const r = await api('/api/documents?limit=200');
            const docs = r.documents || [];
            if (!docs.length) {
                document.getElementById('docList').innerHTML = '<p class="empty">No documents yet.</p>';
                return;
            }
            const rows = docs.map(d => [
                `<div><strong>${escapeHtml(d.title || d.fileName)}</strong>
                  <div style="color:var(--muted); font-size:.82rem;">${escapeHtml(d.fileType || '')} · ${escapeHtml(d.category || '')} · ${escapeHtml(formatBytes(d.fileSize))}</div></div>`,
                statusBadge(d.embeddingStatus || d.embedding_status),
                escapeHtml(d.uploadedByName || d.uploadedBy || '—'),
                escapeHtml(formatDate(d.createdAt || d.created_at)),
                `<button class="btn btn-ghost" data-act="reprocess" data-id="${d.id}" title="Re-extract + re-embed"><i class="fa-solid fa-rotate"></i></button>
                 <button class="btn btn-ghost" data-act="delete"    data-id="${d.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>`
            ]);
            document.getElementById('docList').innerHTML = table(
                ['Title', 'Status', 'Uploaded by', 'Date', 'Actions'], rows
            );
            document.getElementById('docList').addEventListener('click', async (e) => {
                const btn = e.target.closest('button[data-act]'); if (!btn) return;
                const id = btn.dataset.id;
                if (btn.dataset.act === 'delete') {
                    if (!confirm('Delete this document and all its chunks/FAQs?')) return;
                    try { await api('/api/documents/' + id, { method: 'DELETE' }); toast('Deleted'); renderDocuments(); }
                    catch (err) { toast(err.message, 'error'); }
                } else if (btn.dataset.act === 'reprocess') {
                    try { await api('/api/documents/' + id + '/process', { method: 'POST' }); toast('Re-processing started'); renderDocuments(); }
                    catch (err) { toast(err.message, 'error'); }
                }
            });
        } catch (err) {
            document.getElementById('docList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }
    function statusBadge(s) {
        const k = String(s || '').toLowerCase();
        const cls = k === 'completed' ? 'badge-success'
                : k === 'pending'   ? 'badge-warn'
                : k === 'failed'    ? 'badge-danger'
                : 'badge-info';
        return `<span class="badge ${cls}">${escapeHtml(s || 'unknown')}</span>`;
    }

    // -------------------------------------------------------- FAQs
    async function renderFAQs() {
        main.innerHTML = `
            <h2>FAQs</h2>
            <p class="lede">Pre-generated questions and answers used to answer common queries instantly. Generate fresh FAQs after uploading new documents.</p>
            <div id="faqStats" class="stat-row"></div>
            <div id="faqDocs"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        try {
            const cats = await api('/api/faq/categories');
            const total = (cats.categories || []).reduce((s, c) => s + (c.qa_count || 0), 0);
            document.getElementById('faqStats').innerHTML = [
                stat('Total FAQs', total),
                stat('Categories', (cats.categories || []).length)
            ].join('');

            const docsR = await api('/api/documents?limit=200');
            const docs = docsR.documents || [];
            const rows = docs.map(d => [
                escapeHtml(d.title),
                statusBadge(d.embeddingStatus || d.embedding_status),
                escapeHtml(formatDate(d.createdAt || d.created_at)),
                `<button class="btn btn-ghost" data-act="gen" data-id="${d.id}" title="Generate FAQs from this document">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Generate
                </button>`
            ]);
            document.getElementById('faqDocs').innerHTML = table(
                ['Document', 'Status', 'Uploaded', 'Action'], rows
            );
            document.getElementById('faqDocs').addEventListener('click', async (e) => {
                const btn = e.target.closest('button[data-act=gen]'); if (!btn) return;
                if (!confirm('Generate FAQs for this document? This calls DeepSeek and can take ~10s.')) return;
                btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    const r = await api('/api/faq/admin/generate/' + btn.dataset.id, { method: 'POST', body: { simple: true } });
                    toast(r.message || 'Generation started');
                } catch (err) { toast(err.message, 'error'); }
                finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate'; }
            });
        } catch (err) {
            main.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    // -------------------------------------------------------- CURATE Q&A
    // Lists the most recent advisor replies and lets an admin promote any
    // of them into the FAQ cache so they short-circuit the LLM next time.
    async function renderCurate() {
        main.innerHTML = `
            <h2>Curate Q&amp;A</h2>
            <p class="lede">Recent advisor replies. Click <strong>Promote</strong> to save a reply to the FAQ cache so future, similar questions get instant answers without calling the LLM.</p>
            <div class="admin-actions">
                <button class="btn btn-ghost" id="curateRefresh"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
            </div>
            <div id="curateList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        document.getElementById('curateRefresh').addEventListener('click', renderCurate);

        const listEl = document.getElementById('curateList');
        try {
            const r = await api('/api/admin/advisor/recent-qa?limit=40');
            const items = r.items || [];
            if (!items.length) {
                listEl.innerHTML = '<p class="lede">No advisor replies yet. Once students chat with Dr. Tari, their Q&amp;A pairs will appear here.</p>';
                return;
            }
            listEl.innerHTML = items.map(it => {
                const cached = it.existing_cache_id
                    ? '<span class="badge badge-ok"><i class="fa-solid fa-check"></i> in cache</span>'
                    : '<span class="badge">not cached</span>';
                const when = new Date(it.created_at).toLocaleString();
                const fullAnswer = it.display_markdown || it.advisor_text || '';
                const preview = fullAnswer.slice(0, 800);
                const promoteLabel = it.existing_cache_id ? 'Refresh in cache' : 'Promote to cache';
                return `
                <article class="curate-card" data-id="${it.advisor_message_id}">
                    <div class="curate-meta">
                        <span class="muted">${escapeHtml(when)}</span>
                        ${cached}
                    </div>
                    <div class="curate-q"><strong>Q:</strong> ${escapeHtml(it.question_text || '')}</div>
                    <details class="curate-a">
                        <summary>Show advisor reply (${preview.length} chars)</summary>
                        <pre>${escapeHtml(preview)}</pre>
                    </details>
                    <div class="curate-actions">
                        <button class="btn btn-primary btn-sm promote-btn" type="button">
                            <i class="fa-solid fa-star"></i> ${promoteLabel}
                        </button>
                        <button class="btn btn-ghost btn-sm edit-btn" type="button">
                            <i class="fa-solid fa-pen"></i> Edit &amp; promote
                        </button>
                    </div>
                    <form class="curate-edit hidden">
                        <label>
                            Question (canonical phrasing)
                            <input type="text" name="question" maxlength="500" required />
                        </label>
                        <label>
                            Answer (this is what students will see)
                            <textarea name="answer" rows="8" required></textarea>
                        </label>
                        <p class="muted" style="font-size:.85rem; margin: 4px 0 8px;">
                            Tip: keep it concise &mdash; the spoken summary is auto-generated from the first non-empty line, so put the headline answer up front.
                        </p>
                        <div class="curate-actions">
                            <button type="submit" class="btn btn-primary btn-sm">
                                <i class="fa-solid fa-floppy-disk"></i> Save &amp; promote
                            </button>
                            <button type="button" class="btn btn-ghost btn-sm cancel-edit-btn">Cancel</button>
                        </div>
                    </form>
                </article>`;
            }).join('');

            // Quick promote (use as-is)
            listEl.querySelectorAll('.promote-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const card = btn.closest('.curate-card');
                    const id   = card.dataset.id;
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Promoting…';
                    try {
                        const r = await api('/api/admin/advisor/promote/' + id, { method: 'POST', body: {} });
                        toast(r.mode === 'created' ? 'Added to FAQ cache' : 'Refreshed in FAQ cache');
                        renderCurate();
                    } catch (err) {
                        toast(err.message || 'Could not promote', 'error');
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fa-solid fa-star"></i> Promote to cache';
                    }
                });
            });

            // Edit & promote — open inline form, pre-filled from the row
            listEl.querySelectorAll('.edit-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const card = btn.closest('.curate-card');
                    const id   = card.dataset.id;
                    const item = items.find(x => String(x.advisor_message_id) === String(id));
                    if (!item) return;
                    const form = card.querySelector('.curate-edit');
                    form.querySelector('input[name="question"]').value = item.question_text || '';
                    // Use the cleaner display_markdown — that one is already
                    // scrubbed of markdown symbols and vocatives.
                    form.querySelector('textarea[name="answer"]').value =
                        item.display_markdown || item.advisor_text || '';
                    form.classList.remove('hidden');
                    // Hide the row's quick-action buttons while editing.
                    card.querySelectorAll('.curate-actions').forEach((row, idx) => {
                        if (idx === 0) row.classList.add('hidden'); // top row of buttons
                    });
                    form.querySelector('input[name="question"]').focus();
                });
            });

            listEl.querySelectorAll('.cancel-edit-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const card = btn.closest('.curate-card');
                    card.querySelector('.curate-edit').classList.add('hidden');
                    card.querySelectorAll('.curate-actions')[0].classList.remove('hidden');
                });
            });

            listEl.querySelectorAll('.curate-edit').forEach(form => {
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const card = form.closest('.curate-card');
                    const id   = card.dataset.id;
                    const question = form.querySelector('input[name="question"]').value.trim();
                    const answer   = form.querySelector('textarea[name="answer"]').value.trim();
                    if (!question || answer.length < 8) {
                        toast('Question and answer are both required', 'error');
                        return;
                    }
                    const submit = form.querySelector('button[type="submit"]');
                    submit.disabled = true;
                    submit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
                    try {
                        const r = await api('/api/admin/advisor/promote/' + id, {
                            method: 'POST',
                            body: { question, answer }
                        });
                        toast(r.mode === 'created' ? 'Saved to FAQ cache' : 'Refreshed in FAQ cache');
                        renderCurate();
                    } catch (err) {
                        toast(err.message || 'Could not save', 'error');
                        submit.disabled = false;
                        submit.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save &amp; promote';
                    }
                });
            });
        } catch (err) {
            listEl.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    // -------------------------------------------------------- USERS
    async function renderUsers() {
        main.innerHTML = `
            <h2>Users</h2>
            <p class="lede">Approve pending registrations, change roles, and deactivate accounts.</p>
            <div class="admin-actions">
                <button class="btn btn-ghost" id="filterAll">All</button>
                <button class="btn btn-ghost" id="filterPending">Pending approval</button>
                <button class="btn btn-ghost" id="filterAdmins">Admins</button>
            </div>
            <div id="userList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        let filter = 'all';
        async function load() {
            try {
                const params = new URLSearchParams({ limit: '200' });
                if (filter === 'pending') params.set('status', 'pending_approval');
                if (filter === 'admins') params.set('role', 'admin');
                const r = await api('/api/admin/users?' + params.toString());
                const users = r.users || r.data || [];
                if (!users.length) {
                    document.getElementById('userList').innerHTML = '<p class="empty">No users match this filter.</p>';
                    return;
                }
                const rows = users.map(u => {
                    const fullName = ((u.firstName || u.first_name || '') + ' ' + (u.lastName || u.last_name || '')).trim() || '—';
                    const status = !u.is_verified ? 'Unverified'
                                : !u.is_approved ? 'Pending approval'
                                : !u.is_active   ? 'Deactivated'
                                : 'Active';
                    const cls = status === 'Active' ? 'badge-success'
                            : status === 'Pending approval' ? 'badge-warn'
                            : 'badge-info';
                    return [
                        `<div><strong>${escapeHtml(fullName)}</strong>
                          <div style="color:var(--muted); font-size:.82rem;">${escapeHtml(u.email)}</div></div>`,
                        escapeHtml(u.role || 'staff'),
                        `<span class="badge ${cls}">${status}</span>`,
                        escapeHtml(formatDate(u.createdAt || u.created_at)),
                        userActions(u, status)
                    ];
                });
                document.getElementById('userList').innerHTML = table(
                    ['User', 'Role', 'Status', 'Joined', 'Actions'], rows
                );
                attachUserActions();
            } catch (err) {
                document.getElementById('userList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
            }
        }
        function userActions(u, status) {
            const id = u.id;
            const buttons = [];
            if (status === 'Pending approval') {
                buttons.push(`<button class="btn btn-primary" data-act="approve" data-id="${id}"><i class="fa-solid fa-check"></i> Approve</button>`);
                buttons.push(`<button class="btn btn-ghost" data-act="reject"  data-id="${id}"><i class="fa-solid fa-xmark"></i> Reject</button>`);
            } else if (status === 'Deactivated') {
                buttons.push(`<button class="btn btn-ghost" data-act="reactivate" data-id="${id}"><i class="fa-solid fa-rotate"></i> Reactivate</button>`);
            } else {
                buttons.push(`<button class="btn btn-ghost" data-act="deactivate" data-id="${id}"><i class="fa-solid fa-pause"></i> Deactivate</button>`);
            }
            const roleSel = `<select data-act="role" data-id="${id}" class="btn btn-ghost" style="padding:6px 10px;">
                <option value="staff" ${u.role==='staff'?'selected':''}>staff</option>
                <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
                <option value="superadmin" ${u.role==='superadmin'?'selected':''}>superadmin</option>
            </select>`;
            return buttons.join(' ') + ' ' + roleSel;
        }
        function attachUserActions() {
            document.getElementById('userList').addEventListener('click', async (e) => {
                const btn = e.target.closest('button[data-act]'); if (!btn) return;
                const id = btn.dataset.id;
                const act = btn.dataset.act;
                try {
                    if (act === 'approve')      { await api('/api/users/admin/users/' + id + '/approve', { method: 'POST' }); }
                    else if (act === 'reject')  { if (!confirm('Reject this account?')) return; await api('/api/users/admin/users/' + id + '/reject', { method: 'POST' }); }
                    else if (act === 'deactivate') { await api('/api/admin/users/' + id + '/status', { method: 'PUT', body: { isActive: false } }); }
                    else if (act === 'reactivate') { await api('/api/admin/users/' + id + '/status', { method: 'PUT', body: { isActive: true  } }); }
                    toast('Done'); load();
                } catch (err) { toast(err.message, 'error'); }
            });
            document.getElementById('userList').addEventListener('change', async (e) => {
                const sel = e.target.closest('select[data-act=role]'); if (!sel) return;
                try { await api('/api/admin/users/' + sel.dataset.id + '/role', { method: 'PUT', body: { role: sel.value } }); toast('Role updated'); }
                catch (err) { toast(err.message, 'error'); load(); }
            });
        }
        document.getElementById('filterAll').addEventListener('click', () => { filter = 'all'; load(); });
        document.getElementById('filterPending').addEventListener('click', () => { filter = 'pending'; load(); });
        document.getElementById('filterAdmins').addEventListener('click', () => { filter = 'admins'; load(); });
        load();
    }

    // -------------------------------------------------------- AUDIT
    async function renderAudit() {
        main.innerHTML = `
            <h2>Audit trail</h2>
            <p class="lede">Recent administrative and login actions.</p>
            <div id="auditList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        try {
            const r = await api('/api/admin/audit?limit=100');
            const items = r.entries || r.audit || r.data || [];
            if (!items.length) { document.getElementById('auditList').innerHTML = '<p class="empty">No audit entries yet.</p>'; return; }
            const rows = items.map(a => [
                escapeHtml(formatDate(a.createdAt || a.created_at)),
                escapeHtml(a.action || a.event || ''),
                escapeHtml(a.user_email || a.userEmail || a.userId || a.user_id || '—'),
                escapeHtml(a.entity_type || a.entityType || ''),
                escapeHtml(a.ip_address || a.ipAddress || '')
            ]);
            document.getElementById('auditList').innerHTML = table(
                ['When', 'Action', 'User', 'Entity', 'IP'], rows
            );
        } catch (err) {
            document.getElementById('auditList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    // -------------------------------------------------------- METRICS
    async function renderMetrics() {
        main.innerHTML = `
            <h2>Retrieval metrics</h2>
            <p class="lede">How well the RAG pipeline is performing.</p>
            <div id="metricsBody"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        try {
            const [retrieval, faq, perf] = await Promise.all([
                api('/api/admin/metrics/retrieval').catch(e => ({ error: e.message })),
                api('/api/admin/metrics/faq').catch(e => ({ error: e.message })),
                api('/api/admin/metrics/performance').catch(e => ({ error: e.message }))
            ]);
            const r = retrieval.metrics || retrieval || {};
            const f = faq.metrics || faq || {};
            const p = perf.metrics || perf || {};
            document.getElementById('metricsBody').innerHTML = `
                <div class="stat-row">
                    ${stat('Total queries', r.totalQueries ?? '—')}
                    ${stat('Cache hit rate', r.cacheHitRate ?? '—')}
                    ${stat('Avg retrieval', (r.avgRetrievalTime ? Math.round(r.avgRetrievalTime) + ' ms' : '—'))}
                    ${stat('Avg re-rank',  (r.avgReRankTime    ? Math.round(r.avgReRankTime)    + ' ms' : '—'))}
                </div>
                <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">FAQ cache</h3>
                <div class="stat-row">
                    ${stat('FAQs total', f.totalFAQs ?? f.total ?? '—')}
                    ${stat('Cache hits',  f.cacheHits ?? '—')}
                    ${stat('Cache hit rate', f.hitRate ?? '—')}
                </div>
                <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Performance</h3>
                <div class="stat-row">
                    ${stat('Memory (MB)', p.memoryMB ?? '—')}
                    ${stat('Uptime',     p.uptime ?? '—')}
                </div>
            `;
        } catch (err) {
            main.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    // -------------------------------------------------------- helpers
    function table(headers, rows) {
        const head = '<tr>' + headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
        const body = rows.map(r => '<tr>' + r.map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('');
        return `<table class="admin-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function formatBytes(n) {
        if (!n) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function formatDate(d) {
        if (!d) return '—';
        try { return new Date(d).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }); }
        catch (_) { return String(d); }
    }

    // First render
    renderDashboard();
})();
