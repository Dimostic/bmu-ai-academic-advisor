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
        advisorOps: renderAdvisorOpsPage,
        documents: renderDocuments,
        faqs:      renderFAQs,
        users:     renderUsers,
        audit:     renderAudit,
        escalations: renderEscalations,
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
            <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Advisor ops</h3>
            <div id="advisorOps"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
            <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Recent activity</h3>
            <div id="recent"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        try {
            const [data, overview] = await Promise.all([
                api('/api/admin/dashboard'),
                api('/api/admin/advisor/health-overview').catch(() => null)
            ]);
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

            renderAdvisorBanner(overview);
            await renderAdvisorOps('advisorOps');

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

    function renderAdvisorBanner(data) {
        const banner = document.getElementById('advisorAlertBanner');
        if (!banner) return;
        const pill = document.getElementById('advisorStatusPill');

        const metrics = data?.health?.metrics || {};
        const slo = metrics.slo || {};
        const summary = data?.quality || {};
        const status = String(slo.status || 'disabled').toLowerCase();
        const statusLabel = status === 'alert' ? 'Alert' : status === 'warning' ? 'Warning' : status === 'ok' ? 'Healthy' : 'Disabled';
        const tone = status === 'alert'
            ? 'background: linear-gradient(135deg, rgba(190,51,58,.16), rgba(190,51,58,.08)); border-color: rgba(190,51,58,.28); color: #8a1f26;'
            : status === 'warning'
                ? 'background: linear-gradient(135deg, rgba(232,170,0,.16), rgba(232,170,0,.08)); border-color: rgba(232,170,0,.28); color: #8c6200;'
                : 'background: linear-gradient(135deg, rgba(20,124,94,.14), rgba(20,124,94,.06)); border-color: rgba(20,124,94,.24); color: #17684f;';

        banner.innerHTML = `
            <div style="${tone} border-radius: 18px; padding: 14px 16px; border: 1px solid; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap: 10px; box-shadow: 0 14px 30px rgba(0,0,0,.05);">
                <div>
                    <div style="font-weight: 800; letter-spacing: .01em; font-size: 1rem;">Advisor status: ${escapeHtml(statusLabel)}</div>
                    <div style="opacity: .9; font-size: .92rem; margin-top: 3px;">
                        p95 ${escapeHtml(String(Number(metrics.p95LatencyMs || 0)))} ms · error rate ${escapeHtml(Number(metrics.errorRatePct || 0).toFixed(2))}% · avg quality ${(Number(summary.avg_overall || 0) * 100).toFixed(1)}%
                    </div>
                </div>
                <div style="display:flex; gap: 8px; flex-wrap:wrap;">
                    <span class="badge ${status === 'alert' ? 'badge-danger' : status === 'warning' ? 'badge-warn' : 'badge-ok'}">${escapeHtml(statusLabel)}</span>
                    <span class="badge">SLO ${escapeHtml(slo.enabled === false ? 'off' : 'on')}</span>
                    <span class="badge">Trend ${Number(summary.total_scored || 0)} scored</span>
                </div>
            </div>
        `;

        if (pill) {
            pill.style.display = '';
            pill.className = `badge ${status === 'alert' ? 'badge-danger' : status === 'warning' ? 'badge-warn' : 'badge-ok'}`;
            pill.dataset.status = status;
            pill.textContent = `Advisor ${statusLabel}`;
        }
    }

    async function renderAdvisorOpsPage() {
        main.innerHTML = `
            <h2>Advisor Ops</h2>
            <p class="lede">Operational health, quality, trend, export, and alert drill controls for the advisor service.</p>
            <div id="advisorOpsPage"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        const overview = await api('/api/admin/advisor/health-overview').catch(() => null);
        renderAdvisorBanner(overview);
        await renderAdvisorOps('advisorOpsPage');
    }

    function trendSparkline(rows) {
        const values = (rows || [])
            .map(row => Number(row.avg_overall || 0))
            .filter(value => Number.isFinite(value));
        if (!values.length) return '';

        const width = 520;
        const height = 96;
        const padding = 10;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = (max - min) || 1;
        const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
        const points = values.map((value, index) => {
            const x = padding + (step * index);
            const y = height - padding - (((value - min) / range) * (height - padding * 2));
            return { x, y, value };
        });
        const polyline = points.map(point => `${point.x},${point.y}`).join(' ');
        const bars = points.map(point => {
            const barHeight = height - padding - point.y;
            return `<rect x="${point.x - 4}" y="${point.y}" width="8" height="${Math.max(2, barHeight)}" rx="3" ry="3" fill="rgba(15,61,62,.18)" />`;
        }).join('');

        return `
            <div class="advisor-trend-chart" style="margin: 12px 0 16px; padding: 12px; border: 1px solid rgba(15,61,62,.12); border-radius: 16px; background: rgba(255,255,255,.66);">
                <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; color:var(--muted); font-size:.85rem;">
                    <span>Trend range: ${(min * 100).toFixed(1)}% - ${(max * 100).toFixed(1)}%</span>
                    <span>${values.length} point${values.length === 1 ? '' : 's'}</span>
                </div>
                <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Advisor quality trend chart" style="display:block; width:100%; height:auto; overflow:visible;">
                    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(15,61,62,.12)" stroke-width="2" />
                    ${bars}
                    <polyline fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polyline}" />
                    ${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="var(--accent)" />`).join('')}
                </svg>
            </div>
        `;
    }

    async function renderAdvisorOps(targetId) {
        const el = document.getElementById(targetId);
        if (!el) return;
        try {
            const [overview, quality, trend] = await Promise.all([
                api('/api/admin/advisor/health-overview'),
                api('/api/admin/advisor/quality-summary').catch(() => ({ summary: {} })),
                api('/api/admin/advisor/quality-trend?days=14').catch(() => ({ trend: [] }))
            ]);

            const metrics = overview.health?.metrics || {};
            const slo = metrics.slo || {};
            const providers = overview.health?.providers || {};
            const summary = quality.summary || overview.quality || {};
            const trendRows = trend.trend || [];
            const overall = Number(summary.avg_overall || 0);
            const chart = trendSparkline(trendRows);

            const statusClass = slo.status === 'alert' ? 'badge-danger' : (slo.status === 'warning' ? 'badge-warn' : 'badge-ok');

            const trendHtml = trendRows.length
                ? table(
                    ['Day', 'Scored', 'Avg quality', 'Low quality', 'Auto-cache eligible'],
                    trendRows.map(row => [
                        escapeHtml(row.day || '—'),
                        escapeHtml(String(row.total_scored ?? 0)),
                        escapeHtml(Number(row.avg_overall || 0).toFixed(2)),
                        escapeHtml(String(row.low_quality ?? 0)),
                        escapeHtml(String(row.eligible_for_auto_cache ?? 0))
                    ])
                )
                : '<p class="empty">No trend data yet.</p>';

            el.innerHTML = `
                <div class="stat-row">
                    ${stat('SLO status', slo.status || 'disabled')}
                    ${stat('p95 latency', `${Number(metrics.p95LatencyMs || 0)} ms`)}
                    ${stat('Error rate', `${Number(metrics.errorRatePct || 0).toFixed(2)}%`)}
                    ${stat('Avg quality', `${(overall * 100).toFixed(1)}%`)}
                    ${stat('Low quality', Number(summary.low_quality || 0))}
                    ${stat('Auto-cached', Number(summary.auto_cached_count || 0))}
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap; margin: 12px 0 16px;">
                    <span class="badge ${statusClass}">SLO ${escapeHtml(slo.status || 'disabled')}</span>
                    <span class="badge">LLM ${providers.llm ? 'on' : 'off'}</span>
                    <span class="badge">TTS ${providers.tts ? 'on' : 'off'}</span>
                    <span class="badge">STT ${providers.stt ? 'on' : 'off'}</span>
                    <span class="badge">RAG ${providers.rag ? 'on' : 'off'}</span>
                </div>
                <div class="admin-actions" style="margin-bottom: 14px;">
                    <button class="btn btn-ghost" id="opsRefresh"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
                    <button class="btn btn-ghost" id="opsExport"><i class="fa-solid fa-file-csv"></i> Export quality CSV</button>
                    <button class="btn btn-primary" id="opsTestAlert"><i class="fa-solid fa-bell"></i> Send test alert</button>
                </div>
                <h4 style="margin: 12px 0 8px; color: var(--bg-deep);">Quality trend (14 days)</h4>
                ${chart}
                ${trendHtml}
            `;

            document.getElementById('opsRefresh')?.addEventListener('click', () => renderDashboard());
            document.getElementById('opsExport')?.addEventListener('click', async () => {
                try {
                    const res = await fetch('/api/admin/advisor/quality-export?limit=500', { headers: authHeaders() });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `advisor-quality-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                    toast('Quality CSV exported');
                } catch (err) {
                    toast(err.message || 'Could not export quality CSV', 'error');
                }
            });
            document.getElementById('opsTestAlert')?.addEventListener('click', async () => {
                const btn = document.getElementById('opsTestAlert');
                if (!btn) return;
                btn.disabled = true;
                try {
                    await api('/api/admin/advisor/test-alert', { method: 'POST', body: { status: 'warning' } });
                    toast('Test alert sent');
                } catch (err) {
                    toast(err.message || 'Could not send test alert', 'error');
                } finally {
                    btn.disabled = false;
                }
            });
        } catch (err) {
            el.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
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
    // Wire up the "Compose a new Q&A" form rendered at the top of the
    // Curate panel. Two buttons:
    //   - AI cleanup: round-trips the text through the LLM with strict
    //                 "edit-only" rules (no new facts) and replaces the
    //                 form contents with the tidied version.
    //   - Save to cache: POST /api/admin/cached-qa, which embeds the
    //                    question and stores the row.
    function wireComposeForm() {
        const form = document.getElementById('composeForm');
        if (!form) return;

        const cleanupBtn = document.getElementById('composeCleanupBtn');
        cleanupBtn.addEventListener('click', async () => {
            const question = form.querySelector('input[name="question"]').value.trim();
            const answer   = form.querySelector('textarea[name="answer"]').value.trim();
            if (!question || answer.length < 8) {
                toast('Type a question and an answer first', 'error');
                return;
            }
            cleanupBtn.disabled = true;
            cleanupBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cleaning up…';
            try {
                const r = await api('/api/admin/advisor/cleanup-text', {
                    method: 'POST',
                    body: { question, answer }
                });
                form.querySelector('input[name="question"]').value = r.question || question;
                form.querySelector('textarea[name="answer"]').value = r.answer || answer;
                toast(r.changed ? 'AI tidied the wording — review before saving' : 'Already clean — nothing changed');
            } catch (err) {
                toast(err.message || 'AI cleanup failed', 'error');
            } finally {
                cleanupBtn.disabled = false;
                cleanupBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI cleanup';
            }
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
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
                const r = await api('/api/admin/cached-qa', {
                    method: 'POST',
                    body: { question, answer }
                });
                toast(r.mode === 'created' ? 'Added to FAQ cache' : 'Refreshed an existing FAQ');
                form.reset();
                document.getElementById('composeBlock').open = false;
                renderCurate();
            } catch (err) {
                toast(err.message || 'Could not save', 'error');
            } finally {
                submit.disabled = false;
                submit.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to cache';
            }
        });
    }

    // Lists the most recent advisor replies and lets an admin promote any
    // of them into the FAQ cache so they short-circuit the LLM next time.
    async function renderCurate() {
        main.innerHTML = `
            <h2>Curate Q&amp;A</h2>
            <p class="lede">Add new question-answer pairs by hand, or promote existing advisor replies. Both go into the FAQ cache that short-circuits the LLM for future students.</p>

            <div id="qualitySummary" class="admin-actions" style="margin-bottom:10px;"></div>

            <details class="curate-compose" id="composeBlock">
                <summary><i class="fa-solid fa-plus"></i> Compose a new Q&amp;A</summary>
                <form id="composeForm" class="curate-edit" style="margin-top:12px;">
                    <label>
                        Question
                        <input type="text" name="question" maxlength="500" required
                               placeholder="e.g. How do I apply for hostel accommodation at BMU?" />
                    </label>
                    <label>
                        Answer
                        <textarea name="answer" rows="6" required
                                  placeholder="Type the answer in plain prose. The first line is used as the spoken summary, so put the headline up front."></textarea>
                    </label>
                    <p class="muted" style="font-size:.85rem;">
                        Tip: click <strong>AI cleanup</strong> to have the model fix grammar, spelling, and clarity without changing any facts.
                    </p>
                    <div class="curate-actions">
                        <button type="button" class="btn btn-ghost btn-sm" id="composeCleanupBtn">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> AI cleanup
                        </button>
                        <button type="submit" class="btn btn-primary btn-sm">
                            <i class="fa-solid fa-floppy-disk"></i> Save to cache
                        </button>
                    </div>
                </form>
            </details>

            <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Recent advisor replies</h3>
            <div class="admin-actions">
                <button class="btn btn-ghost" id="curateRefresh"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
                <label style="display:flex;gap:6px;align-items:center;">
                    <input type="checkbox" id="curateOnlyLow" />
                    Show low-score only
                </label>
            </div>
            <div id="curateList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        document.getElementById('curateRefresh').addEventListener('click', renderCurate);
        wireComposeForm();

        const listEl = document.getElementById('curateList');
        const onlyLowEl = document.getElementById('curateOnlyLow');
        let onlyLow = false;
        onlyLowEl?.addEventListener('change', () => {
            onlyLow = !!onlyLowEl.checked;
            loadRecent();
        });

        try {
            const q = await api('/api/admin/advisor/quality-summary');
            const s = q.summary || {};
            const avg = Number(s.avg_overall || 0);
            document.getElementById('qualitySummary').innerHTML = [
                `<span class="badge">Avg quality: ${(avg * 100).toFixed(1)}%</span>`,
                `<span class="badge">Low-quality: ${Number(s.low_quality || 0)}</span>`,
                `<span class="badge">Auto-cache eligible: ${Number(s.eligible_for_auto_cache || 0)}</span>`,
                `<span class="badge">Auto-cached: ${Number(s.auto_cached_count || 0)}</span>`,
                `<span class="badge">Helpful votes: ${Number(s.helpful_votes || 0)}</span>`,
                `<span class="badge">Unhelpful votes: ${Number(s.unhelpful_votes || 0)}</span>`
            ].join(' ');
        } catch (_) {
            const box = document.getElementById('qualitySummary');
            if (box) box.innerHTML = '';
        }

        async function loadRecent() {
        try {
            const qs = new URLSearchParams({ limit: '40' });
            if (onlyLow) qs.set('onlyLow', '1');
            const r = await api('/api/admin/advisor/recent-qa?' + qs.toString());
            const items = r.items || [];
            if (!items.length) {
                listEl.innerHTML = '<p class="lede">No advisor replies yet. Once students chat with Dr. Tari, their Q&amp;A pairs will appear here.</p>';
                return;
            }
            listEl.innerHTML = items.map(it => {
                const cached = it.existing_cache_id
                    ? '<span class="badge badge-ok"><i class="fa-solid fa-check"></i> in cache</span>'
                    : '<span class="badge">not cached</span>';
                const overall = Number(it.overall_score || 0);
                const scorePct = Number.isFinite(overall) && overall > 0 ? `${(overall * 100).toFixed(1)}%` : 'unscored';
                const scoreBadge = !it.overall_score
                    ? `<span class="badge">quality: ${scorePct}</span>`
                    : (overall < 0.70
                        ? `<span class="badge badge-danger">quality: ${scorePct}</span>`
                        : `<span class="badge badge-ok">quality: ${scorePct}</span>`);
                const autoCache = it.auto_cached
                    ? '<span class="badge badge-ok">auto-cached</span>'
                    : (it.auto_cache_eligible ? '<span class="badge">auto-cache eligible</span>' : '');
                const decision = String(it.admin_cache_decision || 'none');
                const decisionBadge = decision === 'approved'
                    ? '<span class="badge badge-ok">admin: approved</span>'
                    : (decision === 'blocked' ? '<span class="badge badge-danger">admin: blocked</span>' : '');
                const helpfulCount = Number(it.helpful_count || 0);
                const notHelpfulCount = Number(it.not_helpful_count || 0);
                const feedbackPct = (helpfulCount + notHelpfulCount) > 0
                    ? `${((helpfulCount / (helpfulCount + notHelpfulCount)) * 100).toFixed(0)}%`
                    : 'n/a';
                const when = new Date(it.created_at).toLocaleString();
                const fullAnswer = it.display_markdown || it.advisor_text || '';
                const preview = fullAnswer.slice(0, 800);
                const promoteLabel = it.existing_cache_id ? 'Refresh in cache' : 'Promote to cache';
                return `
                <article class="curate-card" data-id="${it.advisor_message_id}">
                    <div class="curate-meta">
                        <span class="muted">${escapeHtml(when)}</span>
                        ${cached}
                        ${scoreBadge}
                        ${autoCache}
                        ${decisionBadge}
                        <span class="badge">👍 ${helpfulCount}</span>
                        <span class="badge">👎 ${notHelpfulCount}</span>
                        <span class="badge">helpful rate: ${feedbackPct}</span>
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
                        <button class="btn btn-ghost btn-sm approve-cache-btn" type="button">
                            <i class="fa-solid fa-circle-check"></i> Approve auto-cache
                        </button>
                        <button class="btn btn-ghost btn-sm block-cache-btn" type="button">
                            <i class="fa-solid fa-ban"></i> Block auto-cache
                        </button>
                        <button class="btn btn-ghost btn-sm clear-cache-decision-btn" type="button">
                            <i class="fa-solid fa-rotate-left"></i> Clear decision
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

            listEl.querySelectorAll('.approve-cache-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const card = btn.closest('.curate-card');
                    const id = card.dataset.id;
                    btn.disabled = true;
                    try {
                        await api('/api/admin/advisor/quality/' + id + '/decision', {
                            method: 'POST',
                            body: { decision: 'approved' }
                        });
                        toast('Approved and promoted for cache');
                        renderCurate();
                    } catch (err) {
                        toast(err.message || 'Could not approve cache decision', 'error');
                        btn.disabled = false;
                    }
                });
            });

            listEl.querySelectorAll('.block-cache-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const card = btn.closest('.curate-card');
                    const id = card.dataset.id;
                    btn.disabled = true;
                    try {
                        await api('/api/admin/advisor/quality/' + id + '/decision', {
                            method: 'POST',
                            body: { decision: 'blocked' }
                        });
                        toast('Auto-cache blocked for this response');
                        renderCurate();
                    } catch (err) {
                        toast(err.message || 'Could not block cache decision', 'error');
                        btn.disabled = false;
                    }
                });
            });

            listEl.querySelectorAll('.clear-cache-decision-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const card = btn.closest('.curate-card');
                    const id = card.dataset.id;
                    btn.disabled = true;
                    try {
                        await api('/api/admin/advisor/quality/' + id + '/decision', {
                            method: 'POST',
                            body: { decision: 'none' }
                        });
                        toast('Cache decision reset');
                        renderCurate();
                    } catch (err) {
                        toast(err.message || 'Could not clear cache decision', 'error');
                        btn.disabled = false;
                    }
                });
            });
        } catch (err) {
            listEl.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
        }

        loadRecent();
    }

    // -------------------------------------------------------- USERS
    // -------------------------------------------------------- USERS
    // Wire up the "Create a user" inline form (super-admin only).
    function wireCreateUserForm() {
        const form = document.getElementById('createUserForm');
        if (!form) return;
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const payload = {
                firstName: (fd.get('firstName') || '').trim(),
                lastName:  (fd.get('lastName')  || '').trim(),
                email:     (fd.get('email')     || '').trim(),
                password:  fd.get('password')   || '',
                role:      fd.get('role')       || 'staff',
                department:(fd.get('department')|| '').trim() || undefined
            };
            if (payload.password.length < 8) {
                toast('Password must be at least 8 characters', 'error');
                return;
            }
            const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true;
            submit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…';
            try {
                const r = await api('/api/admin/users', { method: 'POST', body: payload });
                toast(r.message || 'User created');
                form.reset();
                document.getElementById('createUserBlock').open = false;
                renderUsers();
            } catch (err) {
                toast(err.message || 'Could not create user', 'error');
            } finally {
                submit.disabled = false;
                submit.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Create account';
            }
        });
    }

    async function renderUsers() {
        main.innerHTML = `
            <h2>Users</h2>
            <p class="lede">Approve pending registrations, resend missing verification links, change roles, and deactivate accounts.</p>
            <details class="curate-compose" id="createUserBlock">
                <summary><i class="fa-solid fa-user-plus"></i> Create a user</summary>
                <form id="createUserForm" class="curate-edit" style="margin-top:12px;">
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                        <label>First name <input type="text" name="firstName" required maxlength="50" /></label>
                        <label>Last name <input type="text" name="lastName" required maxlength="50" /></label>
                    </div>
                    <label>Email <input type="email" name="email" required /></label>
                    <label>
                        Temporary password
                        <input type="text" name="password" required minlength="8" placeholder="At least 8 characters" />
                    </label>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                        <label>Role
                            <select name="role">
                                <option value="student" selected>Student</option>
                                <option value="staff">Staff</option>
                                <option value="admin">Admin</option>
                                <option value="superadmin">Super-admin</option>
                            </select>
                        </label>
                        <label>Department <input type="text" name="department" maxlength="100" /></label>
                    </div>
                    <p class="muted" style="font-size:.85rem;">
                        The new user will be forced to change this temporary password the first time they sign in.
                    </p>
                    <div class="curate-actions">
                        <button type="submit" class="btn btn-primary btn-sm">
                            <i class="fa-solid fa-floppy-disk"></i> Create account
                        </button>
                    </div>
                </form>
            </details>
            <div class="admin-actions">
                <input id="usersSearch" class="admin-search" type="search" placeholder="Search users by name or email…" />
                <button class="btn btn-primary" id="bulkResendUnverified"><i class="fa-solid fa-envelope-circle-check"></i> Auto resend unverified</button>
                <button class="btn btn-ghost" id="filterAll">All</button>
                <button class="btn btn-ghost" id="filterPending">Pending approval</button>
                <button class="btn btn-ghost" id="filterAdmins">Admins</button>
            </div>
            <div id="userList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        wireCreateUserForm();
        let filter = 'all';
        let searchText = '';
        const canManagePromptLimits = user?.role === 'superadmin';

        function renderPromptLimitControls(u) {
            if (!canManagePromptLimits) return '';
            const daily = Number.isFinite(Number(u.daily_prompt_limit)) ? Number(u.daily_prompt_limit) : 10;
            const monthly = Number.isFinite(Number(u.monthly_prompt_limit)) ? Number(u.monthly_prompt_limit) : 100;
            return `
                <div class="prompt-limit-controls" data-user-id="${u.id}">
                    <input type="number" data-field="daily" min="-1" value="${daily}" title="Daily limit (-1 for unlimited)" />
                    <input type="number" data-field="monthly" min="-1" value="${monthly}" title="Monthly limit (-1 for unlimited)" />
                    <button class="btn btn-primary btn-sm" data-act="set-limits" data-id="${u.id}">Save</button>
                </div>
            `;
        }

        async function load() {
            try {
                const params = new URLSearchParams({ limit: '200' });
                if (filter === 'pending') params.set('status', 'pending_approval');
                if (filter === 'admins') params.set('role', 'admin');
                if (searchText) params.set('search', searchText);
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
                    // Format usage as "used / limit". Limit of -1 means
                    // unlimited (admin/superadmin).
                    const fmt = (used, limit) => {
                        if (limit == null) return '—';
                        if (Number(limit) === -1) return '∞';
                        return `${Number(used || 0)} / ${Number(limit)}`;
                    };
                    const row = [
                        `<div><strong>${escapeHtml(fullName)}</strong>
                          <div style="color:var(--muted); font-size:.82rem;">${escapeHtml(u.email)}</div></div>`,
                        escapeHtml(u.role || 'student'),
                        `<span class="badge ${cls}">${status}</span>`,
                        escapeHtml(fmt(u.daily_prompt_count, u.daily_prompt_limit)),
                        escapeHtml(fmt(u.monthly_prompt_count, u.monthly_prompt_limit)),
                        escapeHtml(formatDate(u.createdAt || u.created_at)),
                        userActions(u, status)
                    ];
                    if (canManagePromptLimits) {
                        row.push(renderPromptLimitControls(u));
                    }
                    return row;
                });
                const headers = ['User', 'Role', 'Status', 'Today', 'This month', 'Joined', 'Actions'];
                if (canManagePromptLimits) headers.push('Prompt limits');
                document.getElementById('userList').innerHTML = table(
                    headers, rows
                );
                attachUserActions();
            } catch (err) {
                document.getElementById('userList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
            }
        }
        function userActions(u, status) {
            const id = u.id;
            const buttons = [];
            if (status === 'Unverified') {
                buttons.push(`<button class="btn btn-primary" data-act="verify-activate" data-id="${id}"><i class="fa-solid fa-user-check"></i> Verify & Activate</button>`);
                buttons.push(`<button class="btn btn-ghost" data-act="resend-verification" data-id="${id}"><i class="fa-solid fa-envelope"></i> Resend Link</button>`);
                buttons.push(`<button class="btn btn-ghost" data-act="reject"  data-id="${id}"><i class="fa-solid fa-xmark"></i> Reject</button>`);
            } else if (status === 'Pending approval') {
                buttons.push(`<button class="btn btn-primary" data-act="approve" data-id="${id}"><i class="fa-solid fa-check"></i> Approve</button>`);
                buttons.push(`<button class="btn btn-ghost" data-act="reject"  data-id="${id}"><i class="fa-solid fa-xmark"></i> Reject</button>`);
            } else if (status === 'Deactivated') {
                buttons.push(`<button class="btn btn-ghost" data-act="reactivate" data-id="${id}"><i class="fa-solid fa-rotate"></i> Reactivate</button>`);
            } else {
                buttons.push(`<button class="btn btn-ghost" data-act="deactivate" data-id="${id}"><i class="fa-solid fa-pause"></i> Deactivate</button>`);
            }
            const roleSel = `<select data-act="role" data-id="${id}" class="btn btn-ghost" style="padding:6px 10px;">
                <option value="student" ${u.role==='student'?'selected':''}>student</option>
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
                    if (act === 'verify-activate') {
                        if (!confirm('Verify this email and activate the account now?')) return;
                        await api('/api/users/admin/users/' + id + '/verify-activate', { method: 'POST' });
                    }
                    if (act === 'resend-verification') {
                        await api('/api/users/admin/users/' + id + '/resend-verification', { method: 'POST' });
                    }
                    if (act === 'approve')      { await api('/api/users/admin/users/' + id + '/approve', { method: 'POST' }); }
                    else if (act === 'reject')  { if (!confirm('Reject this account?')) return; await api('/api/users/admin/users/' + id + '/reject', { method: 'POST' }); }
                    else if (act === 'deactivate') { await api('/api/admin/users/' + id + '/status', { method: 'PUT', body: { isActive: false } }); }
                    else if (act === 'reactivate') { await api('/api/admin/users/' + id + '/status', { method: 'PUT', body: { isActive: true  } }); }
                    else if (act === 'set-limits') {
                        const wrap = btn.closest('.prompt-limit-controls');
                        const daily = parseInt(wrap?.querySelector('input[data-field="daily"]')?.value, 10);
                        const monthly = parseInt(wrap?.querySelector('input[data-field="monthly"]')?.value, 10);
                        if (!Number.isInteger(daily) || daily < -1 || !Number.isInteger(monthly) || monthly < -1) {
                            toast('Limits must be integers and at least -1', 'error');
                            return;
                        }
                        await api('/api/admin/users/' + id + '/prompt-limits', {
                            method: 'PUT',
                            body: { dailyPromptLimit: daily, monthlyPromptLimit: monthly }
                        });
                    }
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
        document.getElementById('bulkResendUnverified').addEventListener('click', async () => {
            if (!confirm('Resend verification links to all currently unverified users?')) return;
            try {
                const result = await api('/api/users/admin/users/resend-verification-unverified', {
                    method: 'POST',
                    body: { limit: 200 }
                });
                const msg = `Processed ${result.processed || 0}, sent ${result.sent || 0}, failed ${result.failedCount || 0}`;
                toast(msg);
                load();
            } catch (err) {
                toast(err.message || 'Bulk resend failed', 'error');
            }
        });
        const usersSearch = document.getElementById('usersSearch');
        usersSearch?.addEventListener('input', () => {
            searchText = usersSearch.value.trim();
            load();
        });
        load();
    }

    // -------------------------------------------------------- AUDIT
    async function renderAudit() {
        main.innerHTML = `
            <h2>Audit trail</h2>
            <p class="lede">Recent administrative and login actions.</p>
            <div class="admin-actions">
                <input id="auditSearch" class="admin-search" type="search" placeholder="Search audit entries by action, user, or entity…" />
            </div>
            <div id="auditList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        let searchText = '';
        async function loadAudit() {
            try {
            const q = new URLSearchParams({ limit: '200' });
            if (searchText) q.set('search', searchText);
            const r = await api('/api/admin/audit?' + q.toString());
            // Server returns `{logs, pagination}`. Older endpoints used
            // `entries`/`audit`/`data` so we keep them as fallbacks.
            const items = r.logs || r.entries || r.audit || r.data || [];
            if (!items.length) { document.getElementById('auditList').innerHTML = '<p class="empty">No audit entries yet.</p>'; return; }
            const rows = items.map(a => [
                escapeHtml(formatDate(a.created_at || a.createdAt)),
                escapeHtml(a.action || a.event || ''),
                escapeHtml(
                    (a.user_email || a.userEmail) ||
                    (a.first_name && a.last_name ? `${a.first_name} ${a.last_name}` : '') ||
                    a.user_id || a.userId || '—'
                ),
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
        document.getElementById('auditSearch')?.addEventListener('input', (e) => {
            searchText = (e.target.value || '').trim();
            loadAudit();
        });
        loadAudit();
    }

    // -------------------------------------------------------- ESCALATIONS
    async function renderEscalations() {
        main.innerHTML = `
            <h2>Escalations</h2>
            <p class="lede">Track student escalation emails: who sent them, when, what was sent, and delivery status.</p>
            <div class="admin-actions">
                <input id="escSearch" class="admin-search" type="search" placeholder="Search by subject, student, email, or message…" />
                <select id="escStatus" class="btn btn-ghost" style="padding:8px 10px;">
                    <option value="">All workflow statuses</option>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                </select>
                <select id="escEmailStatus" class="btn btn-ghost" style="padding:8px 10px;">
                    <option value="">All email statuses</option>
                    <option value="sent">Email sent</option>
                    <option value="pending">Email pending</option>
                    <option value="failed">Email failed</option>
                </select>
                <button id="escExportCsv" class="btn btn-ghost"><i class="fa-solid fa-file-csv"></i> Export CSV</button>
            </div>
            <div id="escList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;

        let searchText = '';
        let workflowStatus = '';
        let emailStatus = '';
        async function loadEsc() {
            try {
                const q = new URLSearchParams({ limit: '200' });
                if (searchText) q.set('search', searchText);
                if (workflowStatus) q.set('status', workflowStatus);
                if (emailStatus) q.set('emailStatus', emailStatus);
                const r = await api('/api/admin/escalations?' + q.toString());
                const items = r.escalations || [];
                if (!items.length) {
                    document.getElementById('escList').innerHTML = '<p class="empty">No escalations found.</p>';
                    return;
                }

                const rows = items.map(it => {
                    const statusCls = it.emailStatus === 'sent'
                        ? 'badge-success'
                        : (it.emailStatus === 'failed' ? 'badge-danger' : 'badge-warn');
                    const flowCls = it.status === 'resolved' || it.status === 'closed'
                        ? 'badge-success'
                        : (it.status === 'in_progress' ? 'badge-info' : 'badge-warn');
                    const who = it.student?.name || 'Anonymous';
                    const whoDetail = it.student?.matricNo || it.contactEmail || '—';
                    const msgPreview = (it.message || '').slice(0, 240);
                    const sentAt = it.emailSentAt ? formatDate(it.emailSentAt) : '—';
                    const error = it.emailError ? `<div style="color:#8a2522;font-size:.8rem;">${escapeHtml(it.emailError)}</div>` : '';
                    const canRetry = it.emailStatus !== 'sent';
                    return [
                        `<div>
                            <strong>${escapeHtml(it.subject || 'No subject')}</strong>
                            <div style="color:var(--muted); font-size:.82rem;">${escapeHtml(msgPreview)}${(it.message || '').length > 240 ? '…' : ''}</div>
                            <details style="margin-top:6px;"><summary>Show full message</summary><pre style="white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.03);padding:8px;border-radius:8px;">${escapeHtml(it.message || '')}</pre></details>
                        </div>`,
                        `<div><strong>${escapeHtml(who)}</strong><div style="color:var(--muted); font-size:.82rem;">${escapeHtml(whoDetail)}</div></div>`,
                        `<span class="badge ${statusCls}">${escapeHtml(it.emailStatus || 'pending')}</span>${error}`,
                        `<div>${escapeHtml(it.assignedEmail || '—')}</div><div style="color:var(--muted); font-size:.82rem;">Sent: ${escapeHtml(sentAt)}</div>`,
                        escapeHtml(formatDate(it.createdAt)),
                        `<div>
                            <span class="badge ${flowCls}">${escapeHtml(it.status || 'open')}</span>
                            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
                                <select data-act="set-status" data-id="${it.id}" class="btn btn-ghost" style="padding:5px 8px;">
                                    <option value="open" ${it.status === 'open' ? 'selected' : ''}>open</option>
                                    <option value="in_progress" ${it.status === 'in_progress' ? 'selected' : ''}>in_progress</option>
                                    <option value="resolved" ${it.status === 'resolved' ? 'selected' : ''}>resolved</option>
                                    <option value="closed" ${it.status === 'closed' ? 'selected' : ''}>closed</option>
                                </select>
                                <button type="button" class="btn btn-ghost" data-act="save-status" data-id="${it.id}"><i class="fa-solid fa-floppy-disk"></i></button>
                                ${canRetry ? `<button type="button" class="btn btn-ghost" data-act="retry-email" data-id="${it.id}"><i class="fa-solid fa-paper-plane"></i></button>` : ''}
                            </div>
                        </div>`
                    ];
                });

                document.getElementById('escList').innerHTML = table(
                    ['Escalation', 'From', 'Email status', 'To', 'When', 'Workflow'],
                    rows
                );

                const escList = document.getElementById('escList');
                escList.onclick = async (e) => {
                    const btn = e.target.closest('button[data-act]');
                    if (!btn) return;
                    const id = btn.dataset.id;
                    const act = btn.dataset.act;
                    try {
                        if (act === 'retry-email') {
                            btn.disabled = true;
                            await api('/api/admin/escalations/' + id + '/retry-email', { method: 'POST' });
                            toast('Escalation email retried');
                            loadEsc();
                            return;
                        }
                        if (act === 'save-status') {
                            const sel = escList.querySelector(`select[data-act="set-status"][data-id="${id}"]`);
                            const status = sel?.value;
                            if (!status) return;
                            btn.disabled = true;
                            await api('/api/admin/escalations/' + id + '/status', {
                                method: 'PUT',
                                body: { status }
                            });
                            toast('Escalation status updated');
                            loadEsc();
                        }
                    } catch (err) {
                        toast(err.message || 'Action failed', 'error');
                    } finally {
                        btn.disabled = false;
                    }
                };
            } catch (err) {
                document.getElementById('escList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
            }
        }

        document.getElementById('escSearch')?.addEventListener('input', (e) => {
            searchText = (e.target.value || '').trim();
            loadEsc();
        });
        document.getElementById('escStatus')?.addEventListener('change', (e) => {
            workflowStatus = (e.target.value || '').trim();
            loadEsc();
        });
        document.getElementById('escEmailStatus')?.addEventListener('change', (e) => {
            emailStatus = (e.target.value || '').trim();
            loadEsc();
        });
        document.getElementById('escExportCsv')?.addEventListener('click', async () => {
            const q = new URLSearchParams();
            if (searchText) q.set('search', searchText);
            if (workflowStatus) q.set('status', workflowStatus);
            if (emailStatus) q.set('emailStatus', emailStatus);
            try {
                const res = await fetch('/api/admin/escalations/export.csv?' + q.toString(), {
                    headers: authHeaders()
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `escalations-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (err) {
                toast(err.message || 'Could not export CSV', 'error');
            }
        });
        loadEsc();
    }

    // -------------------------------------------------------- METRICS
    async function renderMetrics() {
        main.innerHTML = `
            <h2>Retrieval metrics</h2>
            <p class="lede">How well the RAG pipeline is performing. Counters are kept in process memory and reset on every server restart.</p>
            <div id="metricsBody"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
            <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Advisor operations</h3>
            <div id="metricsAdvisorOps"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        try {
            const [retrieval, faq, perf] = await Promise.all([
                api('/api/admin/metrics/retrieval').catch(e => ({ error: e.message })),
                api('/api/admin/metrics/faq').catch(e => ({ error: e.message })),
                api('/api/admin/metrics/performance').catch(e => ({ error: e.message }))
            ]);
            // Server shapes:
            //   /metrics/retrieval  -> { metrics: {totalQueries, cacheHits, cacheHitRate, avgRetrievalTime, avgReRankTime, ...} }
            //   /metrics/faq        -> { faq: { total_faqs, total_usage, avg_confidence, last_used_at, byDocument } }
            //   /metrics/performance-> { performance: {...} } (or top-level fields, depending on env)
            const r = retrieval.metrics || retrieval || {};
            const f = faq.faq || faq.metrics || faq || {};
            const p = perf.performance || perf.metrics || perf || {};

            const fmtMs = v => v ? Math.round(v) + ' ms' : '—';
            const fmtPct = v => (v == null ? '—' : (typeof v === 'string' ? v : (v * 100).toFixed(1) + '%'));
            const fmtNum = v => (v == null ? '—' : Number(v).toLocaleString());

            document.getElementById('metricsBody').innerHTML = `
                <div class="stat-row">
                    ${stat('Total queries',  fmtNum(r.totalQueries))}
                    ${stat('Cache hits',     fmtNum(r.cacheHits))}
                    ${stat('Cache hit rate', r.cacheHitRate ?? '—')}
                    ${stat('Avg retrieval',  fmtMs(r.avgRetrievalTime))}
                    ${stat('Avg re-rank',    fmtMs(r.avgReRankTime))}
                </div>
                <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">FAQ cache</h3>
                <div class="stat-row">
                    ${stat('FAQs total',          fmtNum(f.total_faqs ?? f.totalFAQs ?? f.total))}
                    ${stat('Documents covered',   fmtNum(f.documents_with_faqs))}
                    ${stat('Avg confidence',      f.avg_confidence != null ? Number(f.avg_confidence).toFixed(2) : '—')}
                    ${stat('Total cache hits',    fmtNum(f.total_usage ?? f.cacheHits))}
                    ${stat('Last cache hit',      f.last_used_at ? formatDate(f.last_used_at) : '—')}
                </div>
                <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Performance</h3>
                <div class="stat-row">
                    ${stat('Memory (MB)', fmtNum(p.memoryMB ?? p.memory_mb))}
                    ${stat('Uptime',      p.uptime ?? p.uptime_human ?? '—')}
                    ${stat('Vector chunks', fmtNum(p.totalChunks ?? p.total_chunks))}
                </div>
            `;

            const overview = await api('/api/admin/advisor/health-overview').catch(() => null);
            renderAdvisorBanner(overview);
            await renderAdvisorOps('metricsAdvisorOps');
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
    navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.section === 'advisorOps'));
    renderAdvisorOpsPage();
})();
