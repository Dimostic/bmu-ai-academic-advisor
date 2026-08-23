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
    function clearAuthCache() {
        try { localStorage.removeItem('bmu_token'); } catch (_) {}
        try { sessionStorage.removeItem('bmu_token'); } catch (_) {}
        try { localStorage.removeItem('bmu_user'); } catch (_) {}
        try { localStorage.removeItem('bmu_advisor_session'); } catch (_) {}
        try { localStorage.removeItem('bmu_advisor_sessions'); } catch (_) {}
    }
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
                    clearAuthCache();
                    setTimeout(() => location.replace('/login?next=/admin&reason=expired'), 1200);
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
            clearAuthCache();
            location.replace('/');
        });
    }
    renderAuthSlot();

    // ---------------------------------------------------------- Section nav
    const main = document.getElementById('adminMain');
    let latestDocumentReviewHtml = '';
    let currentDocumentLabJobId = null;
    const navButtons = document.querySelectorAll('.admin-nav button');
    const sections = {
        dashboard: renderDashboard,
        advisorOps: renderAdvisorOpsPage,
        documents: renderDocuments,
        documentLab: renderDocumentLab,
        structuredRecords: renderStructuredRecords,
        faqs:      renderFAQs,
        users:     renderUsers,
        audit:     renderAudit,
        escalations: renderEscalations,
        evaluation: renderEvaluationTests,
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
        const mobileStrip = document.getElementById('advisorMobileStrip');

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

        if (mobileStrip) {
            const dismissed = mobileStrip.dataset.dismissed === '1';
            mobileStrip.style.display = dismissed ? 'none' : '';
            mobileStrip.innerHTML = dismissed ? '' : `
                <div style="${tone} border-radius: 16px; padding: 12px 14px; border: 1px solid; display:flex; align-items:center; justify-content:space-between; gap: 10px; box-shadow: 0 14px 24px rgba(0,0,0,.06); backdrop-filter: blur(10px);">
                    <div style="min-width: 0;">
                        <div style="font-weight: 800; font-size: .95rem; line-height: 1.1;">Advisor ${escapeHtml(statusLabel)}</div>
                        <div style="opacity: .9; font-size: .82rem; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            p95 ${escapeHtml(String(Number(metrics.p95LatencyMs || 0)))} ms · ${escapeHtml(Number(metrics.errorRatePct || 0).toFixed(2))}% error
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap: 8px; flex-shrink: 0;">
                        <span class="badge ${status === 'alert' ? 'badge-danger' : status === 'warning' ? 'badge-warn' : 'badge-ok'}">${escapeHtml(statusLabel)}</span>
                        <button type="button" class="btn btn-ghost btn-sm" id="dismissAdvisorStrip" aria-label="Dismiss advisor status strip" style="padding: 8px 10px; min-height: 32px;"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
            `;

            if (!dismissed) {
                document.getElementById('dismissAdvisorStrip')?.addEventListener('click', () => {
                    mobileStrip.dataset.dismissed = '1';
                    mobileStrip.style.display = 'none';
                    mobileStrip.innerHTML = '';
                });
            }
        }

        if (mobileStrip) {
            mobileStrip.innerHTML = `
                <div style="${tone} border-radius: 16px; padding: 12px 14px; border: 1px solid; display:flex; align-items:center; justify-content:space-between; gap: 10px; box-shadow: 0 14px 24px rgba(0,0,0,.06); backdrop-filter: blur(10px);">
                    <div style="min-width: 0;">
                        <div style="font-weight: 800; font-size: .95rem; line-height: 1.1;">Advisor ${escapeHtml(statusLabel)}</div>
                        <div style="opacity: .9; font-size: .82rem; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            p95 ${escapeHtml(String(Number(metrics.p95LatencyMs || 0)))} ms · ${escapeHtml(Number(metrics.errorRatePct || 0).toFixed(2))}% error
                        </div>
                    </div>
                    <span class="badge ${status === 'alert' ? 'badge-danger' : status === 'warning' ? 'badge-warn' : 'badge-ok'}">${escapeHtml(statusLabel)}</span>
                </div>
            `;
        }
    }

    async function renderAdvisorOpsPage() {
        main.innerHTML = `
            <h2>Advisor Ops</h2>
            <p class="lede">Operational health, quality, trend, export, and alert drill controls for the advisor service.</p>
            <div id="advisorOpsPage"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        const mobileStrip = document.getElementById('advisorMobileStrip');
        if (mobileStrip) {
            mobileStrip.dataset.dismissed = '1';
            mobileStrip.style.display = 'none';
            mobileStrip.innerHTML = '';
        }
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
            <p class="lede">Upload BMU documents for AI readiness review, then process approved documents for retrieval.</p>
            <div class="admin-actions">
                <label class="dropzone" id="dropzone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <strong>Click or drop a file here to upload and review</strong>
                    <small style="display:block; margin-top:4px;">PDF, DOCX, XLSX, TXT, MD up to 100MB</small>
                    <input type="file" id="fileInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.md" />
                </label>
                <button class="btn btn-ghost" id="reviewAllDocsBtn" type="button"><i class="fa-solid fa-list-check"></i> Review all</button>
                <button class="btn btn-ghost" id="sendFlaggedToLabBtn" type="button"><i class="fa-solid fa-flask-vial"></i> Send flagged to Lab</button>
            </div>
            <div id="docReviewResult">${latestDocumentReviewHtml}</div>
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
                const uploaded = await api('/api/documents/upload', { method: 'POST', body: fd, formData: true });
                toast('Uploaded and reviewed.');
                showDocumentReview(uploaded.review, file.name);
                renderDocuments();
            } catch (err) {
                toast(err.message || 'Upload failed', 'error');
            }
        });
        document.getElementById('reviewAllDocsBtn').addEventListener('click', async () => {
            if (!confirm('Review all active documents for AI readiness? Large PDFs may take a little while.')) return;
            const btn = document.getElementById('reviewAllDocsBtn');
            btn.disabled = true;
            try {
                toast('Reviewing documents…');
                const r = await api('/api/documents/review-all', { method: 'POST' });
                const failed = (r.results || []).filter(x => !x.success).length;
                toast(failed ? `Review completed with ${failed} failure(s)` : 'All documents reviewed');
                latestDocumentReviewHtml = `<div class="doc-review-panel"><div><span class="badge badge-success">batch review</span><strong>${escapeHtml(r.message || 'Review complete')}</strong><small>${escapeHtml((r.results || []).filter(x => x.success).length)} successful · ${escapeHtml(failed)} failed</small></div></div>`;
                renderDocuments();
            } catch (err) {
                toast(err.message || 'Batch review failed', 'error');
            } finally {
                btn.disabled = false;
            }
        });
        document.getElementById('sendFlaggedToLabBtn').addEventListener('click', async () => {
            if (!confirm('Send documents with failed/low AI readiness into Document Lab? Already-imported documents will be skipped.')) return;
            const btn = document.getElementById('sendFlaggedToLabBtn');
            btn.disabled = true;
            try {
                toast('Importing flagged documents to Lab…');
                const r = await api('/api/document-lab/import-flagged', { method: 'POST', body: { limit: 50 } });
                toast(r.failed ? `Imported ${r.imported}; ${r.failed} failed` : `Imported ${r.imported} flagged document(s)`);
                renderDocumentLab();
            } catch (err) {
                toast(err.message || 'Could not import flagged documents', 'error');
            } finally {
                btn.disabled = false;
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
                reviewBadge(d),
                authorityCell(d),
                escapeHtml(d.uploadedByName || d.uploadedBy || '—'),
                escapeHtml(formatDate(d.createdAt || d.created_at)),
                `<button class="btn btn-ghost" data-act="reprocess" data-id="${d.id}" title="Re-extract + re-embed"><i class="fa-solid fa-rotate"></i></button>
                 <button class="btn btn-ghost" data-act="review"    data-id="${d.id}" data-title="${escapeHtml(d.title || d.fileName || 'Document')}" title="Review AI readiness"><i class="fa-solid fa-clipboard-check"></i></button>
                 <button class="btn btn-ghost" data-act="lab"       data-id="${d.id}" title="Send to Document Lab"><i class="fa-solid fa-flask-vial"></i></button>
                 <button class="btn btn-ghost" data-act="authority" data-id="${d.id}" data-rank="${escapeHtml(d.authorityRank || d.authority_rank || 50)}" data-label="${escapeHtml(d.authorityLabel || d.authority_label || 'Standard')}" title="Set source authority"><i class="fa-solid fa-ranking-star"></i></button>
                 <button class="btn btn-ghost" data-act="delete"    data-id="${d.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>`
            ]);
            document.getElementById('docList').innerHTML = table(
                ['Title', 'Embedding', 'AI readiness', 'Authority', 'Uploaded by', 'Date', 'Actions'], rows
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
                } else if (btn.dataset.act === 'review') {
                    try {
                        const r = await api('/api/documents/' + id + '/review', { method: 'POST' });
                        toast('Review completed');
                        showDocumentReviewModal(r.review, btn.dataset.title || r.review?.file?.title || 'Document review');
                        renderDocuments();
                    } catch (err) { toast(err.message, 'error'); }
                } else if (btn.dataset.act === 'authority') {
                    const current = btn.dataset.rank || '50';
                    const rank = prompt('Authority rank from 0 to 100. Use higher values for official BMU/canonical sources.', current);
                    if (rank === null) return;
                    const label = prompt('Authority label', btn.dataset.label || 'Admin ranked');
                    if (label === null) return;
                    try {
                        await api('/api/documents/' + id + '/authority', { method: 'PUT', body: { rank, label } });
                        toast('Authority ranking updated');
                        renderDocuments();
                    } catch (err) { toast(err.message, 'error'); }
                } else if (btn.dataset.act === 'lab') {
                    try {
                        toast('Sending document to lab…');
                        const r = await api('/api/document-lab/from-document/' + id, { method: 'POST' });
                        toast('Sent to Document Lab');
                        renderDocumentLab(r.job?.id);
                    } catch (err) { toast(err.message, 'error'); }
                }
            });
        } catch (err) {
            document.getElementById('docList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }
    function showDocumentReview(review, title) {
        const el = document.getElementById('docReviewResult');
        if (!el || !review) return;
        const warnings = (review.warnings || []).slice(0, 4).map(w => `<li>${escapeHtml(w)}</li>`).join('');
        const recs = (review.recommendations || []).slice(0, 4).map(r => `<li>${escapeHtml(r)}</li>`).join('');
        el.innerHTML = `
            <div class="doc-review-panel">
                <div>
                    <span class="badge ${reviewStatusClass(review.status)}">${escapeHtml(review.status || 'reviewed')}</span>
                    <strong>${escapeHtml(title || review.file?.title || 'Document review')}</strong>
                    <small>${escapeHtml(Math.round(Number(review.score || 0)))} / 100 · ${escapeHtml(review.metrics?.estimatedChunks || 0)} estimated chunks · ${escapeHtml(review.metrics?.textChars || 0)} readable chars</small>
                </div>
                <div>
                    <strong>Suggested authority</strong>
                    <small>${escapeHtml(review.suggestedAuthorityLabel || 'Standard')} · ${escapeHtml(review.suggestedAuthorityRank || 50)}/100</small>
                </div>
                <div>
                    <strong>Suggested category</strong>
                    <small>${escapeHtml(review.suggestedCategory || 'general')}</small>
                </div>
                ${(warnings || recs) ? `<div class="doc-review-notes">${warnings ? `<ul>${warnings}</ul>` : ''}${recs ? `<ul>${recs}</ul>` : ''}</div>` : ''}
            </div>
        `;
        latestDocumentReviewHtml = el.innerHTML;
    }
    function showDocumentReviewModal(review, title) {
        if (!review) return;
        document.querySelector('.doc-review-modal')?.remove();
        const warnings = (review.warnings || []).map(w => `<li>${escapeHtml(w)}</li>`).join('');
        const recs = (review.recommendations || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
        const metrics = review.metrics || {};
        const scores = review.scores || {};
        const modal = document.createElement('div');
        modal.className = 'doc-review-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = `
            <div class="doc-review-dialog">
                <button type="button" class="icon-btn doc-review-close" aria-label="Close review"><i class="fa-solid fa-xmark"></i></button>
                <div class="doc-review-head">
                    <span class="badge ${reviewStatusClass(review.status)}">${escapeHtml(String(review.status || 'reviewed').replace(/_/g, ' '))}</span>
                    <h3>${escapeHtml(title || review.file?.title || 'Document review')}</h3>
                    <p>${escapeHtml(Math.round(Number(review.score || 0)))} / 100 readiness score</p>
                </div>
                <div class="doc-review-grid">
                    <div>
                        <strong>Text readiness</strong>
                        <small>${escapeHtml(metrics.textChars || 0)} readable chars · ${escapeHtml(metrics.estimatedChunks || 0)} estimated chunks · ${escapeHtml(metrics.charsPerMb || 0)} chars/MB</small>
                    </div>
                    <div>
                        <strong>Suggested authority</strong>
                        <small>${escapeHtml(review.suggestedAuthorityLabel || 'Standard')} · ${escapeHtml(review.suggestedAuthorityRank || 50)}/100</small>
                    </div>
                    <div>
                        <strong>Suggested category</strong>
                        <small>${escapeHtml(review.suggestedCategory || 'general')}</small>
                    </div>
                    <div>
                        <strong>Quality scores</strong>
                        <small>Extract ${escapeHtml(scores.extraction ?? '—')} · Structure ${escapeHtml(scores.structure ?? '—')} · Embed ${escapeHtml(scores.embedding ?? '—')}</small>
                    </div>
                </div>
                ${(warnings || recs) ? `<div class="doc-review-modal-notes">${warnings ? `<section><strong>Warnings</strong><ul>${warnings}</ul></section>` : ''}${recs ? `<section><strong>Recommendations</strong><ul>${recs}</ul></section>` : ''}</div>` : ''}
            </div>
        `;
        document.body.appendChild(modal);
        const close = () => modal.remove();
        modal.querySelector('.doc-review-close')?.addEventListener('click', close);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }
    function reviewBadge(d) {
        const status = d.aiReviewStatus || d.ai_review_status || 'not_reviewed';
        const score = d.aiReviewScore || d.ai_review_score;
        const review = parseReviewJson(d.aiReview || d.ai_review_json);
        const warnings = review?.warnings?.length ? ` · ${review.warnings.length} warning${review.warnings.length === 1 ? '' : 's'}` : '';
        return `<span class="badge ${reviewStatusClass(status)}">${escapeHtml(status.replace(/_/g, ' '))}${score ? ` · ${Math.round(Number(score))}/100` : ''}${escapeHtml(warnings)}</span>`;
    }
    function authorityCell(d) {
        const rank = d.authorityRank || d.authority_rank || 50;
        const label = d.authorityLabel || d.authority_label || 'Standard';
        return `<div><strong>${escapeHtml(rank)}/100</strong><div style="color:var(--muted); font-size:.82rem;">${escapeHtml(label)}</div></div>`;
    }
    function reviewStatusClass(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'ready') return 'badge-success';
        if (s === 'ready_with_warnings') return 'badge-warn';
        if (s === 'needs_cleanup' || s === 'needs_splitting') return 'badge-warn';
        if (s === 'reject' || s === 'failed') return 'badge-danger';
        return 'badge-info';
    }
    function parseReviewJson(value) {
        if (!value) return null;
        if (typeof value === 'object') return value;
        try { return JSON.parse(value); } catch (_) { return null; }
    }
    function statusBadge(s) {
        const k = String(s || '').toLowerCase();
        const cls = k === 'completed' ? 'badge-success'
                : k === 'pending'   ? 'badge-warn'
                : k === 'failed'    ? 'badge-danger'
                : 'badge-info';
        return `<span class="badge ${cls}">${escapeHtml(s || 'unknown')}</span>`;
    }

    // -------------------------------------------------------- DOCUMENT LAB
    async function renderDocumentLab(selectedJobId) {
        main.innerHTML = `
            <h2>Document Lab</h2>
            <p class="lede">Repair documents before they enter the live knowledge base. OCR scanned files, clean tables into Markdown, split long content, then approve outputs for Documents.</p>
            <div class="admin-actions">
                <label class="dropzone" id="labDropzone">
                    <i class="fa-solid fa-microscope"></i>
                    <strong>Upload to Document Lab</strong>
                    <small style="display:block; margin-top:4px;">PDF, Office, text, Markdown, or image files</small>
                    <input type="file" id="labFileInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.md,.rtf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp" />
                </label>
                <button class="btn btn-ghost" id="labImportFlaggedBtn" type="button"><i class="fa-solid fa-arrow-right-to-bracket"></i> Import flagged documents</button>
                <button class="btn btn-ghost" id="labRefreshBtn" type="button"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
            </div>
            <section class="document-lab-normalized" id="labNormalizedPanel">
                <div>
                    <h3>Normalized academic facts</h3>
                    <p>Production lookup records for programmes, courses, fees, dates, officers, and academic rules.</p>
                </div>
                <div class="document-lab-normalized-actions">
                    <button class="btn btn-ghost" id="labNormalizedStatsBtn" type="button"><i class="fa-solid fa-chart-simple"></i> Refresh stats</button>
                    <button class="btn btn-primary" id="labNormalizedBackfillBtn" type="button"><i class="fa-solid fa-database"></i> Run next batch</button>
                </div>
                <div class="document-lab-normalized-stats" id="labNormalizedStats">
                    <span class="badge badge-info">Loading stats</span>
                </div>
            </section>
            <div id="labQueue"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading lab queue…</div></div>
            <div id="labWorkspace"></div>
        `;

        document.getElementById('labFileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0]; if (!file) return;
            const fd = new FormData();
            fd.append('file', file);
            fd.append('title', file.name);
            try {
                toast('Uploading to Document Lab…');
                const r = await api('/api/document-lab/upload', { method: 'POST', body: fd, formData: true });
                toast('Lab review created');
                renderDocumentLab(r.job?.id);
            } catch (err) {
                toast(err.message || 'Lab upload failed', 'error');
            }
        });
        document.getElementById('labImportFlaggedBtn').addEventListener('click', async () => {
            if (!confirm('Import existing Documents with failed/low AI readiness into this lab queue?')) return;
            const btn = document.getElementById('labImportFlaggedBtn');
            btn.disabled = true;
            try {
                toast('Importing flagged documents…');
                const r = await api('/api/document-lab/import-flagged', { method: 'POST', body: { limit: 50 } });
                toast(r.failed ? `Imported ${r.imported}; ${r.failed} failed` : `Imported ${r.imported} flagged document(s)`);
                renderDocumentLab();
            } catch (err) {
                toast(err.message || 'Could not import flagged documents', 'error');
            } finally {
                btn.disabled = false;
            }
        });
        document.getElementById('labRefreshBtn').addEventListener('click', () => renderDocumentLab(selectedJobId));
        document.getElementById('labNormalizedStatsBtn').addEventListener('click', loadNormalizedAcademicStats);
        document.getElementById('labNormalizedBackfillBtn').addEventListener('click', runNormalizedAcademicBackfillBatch);
        loadNormalizedAcademicStats();

        try {
            const r = await api('/api/document-lab/jobs?limit=200');
            const jobs = r.jobs || [];
            if (!jobs.length) {
                document.getElementById('labQueue').innerHTML = '<p class="empty">No lab jobs yet.</p>';
                return;
            }
            const rows = jobs.map(job => [
                `<div><strong>${escapeHtml(job.title)}</strong><div style="color:var(--muted); font-size:.82rem;">${escapeHtml(job.fileType || '')} · ${escapeHtml(formatBytes(job.fileSize))}</div></div>`,
                `<span class="badge ${labIssueClass(job.issueType)}">${escapeHtml(String(job.issueType || 'needs_review').replace(/_/g, ' '))}</span>`,
                `<span class="badge ${reviewStatusClass(job.reviewStatus)}">${escapeHtml(job.reviewStatus || 'not reviewed')}${job.reviewScore ? ` · ${Math.round(Number(job.reviewScore))}/100` : ''}</span>`,
                escapeHtml(String(job.outputCount || 0)),
                escapeHtml(formatDate(job.updatedAt)),
                `<button class="btn btn-ghost" data-lab-act="open" data-id="${job.id}" title="Open outputs"><i class="fa-solid fa-folder-open"></i></button>
                 <button class="btn btn-ghost" data-lab-act="analyze" data-id="${job.id}" title="Analyze and repair"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
                 <button class="btn btn-ghost" data-lab-act="plan" data-id="${job.id}" title="Review split/clean plan"><i class="fa-solid fa-scissors"></i></button>
                 <button class="btn btn-ghost" data-lab-act="digest" data-id="${job.id}" title="Create structured digest"><i class="fa-solid fa-layer-group"></i></button>
                 <button class="btn btn-ghost" data-lab-act="academic" data-id="${job.id}" title="Academic hierarchy parse"><i class="fa-solid fa-sitemap"></i></button>
                 <button class="btn btn-ghost" data-lab-act="facts" data-id="${job.id}" title="Approve structured facts"><i class="fa-solid fa-database"></i></button>`
            ]);
            document.getElementById('labQueue').innerHTML = table(
                ['Document', 'Issue', 'Readiness', 'Outputs', 'Updated', 'Actions'],
                rows
            );
            document.getElementById('labQueue').onclick = async (e) => {
                const btn = e.target.closest('button[data-lab-act]'); if (!btn) return;
                const id = btn.dataset.id;
                try {
                    if (btn.dataset.labAct === 'open') return loadLabJob(id);
                    if (btn.dataset.labAct === 'analyze') {
                        toast('Analyzing lab job…');
                        await api('/api/document-lab/jobs/' + id + '/analyze', { method: 'POST' });
                        toast('Analysis complete');
                        return renderDocumentLab(id);
                    }
                    if (btn.dataset.labAct === 'plan') {
                        toast('Building split plan…');
                        return loadSplitPlan(id);
                    }
                    if (btn.dataset.labAct === 'digest') {
                        toast('Creating structured digest…');
                        await api('/api/document-lab/jobs/' + id + '/structured-digest', { method: 'POST' });
                        toast('Structured digest created');
                        return renderDocumentLab(id);
                    }
                    if (btn.dataset.labAct === 'academic') {
                        toast('Creating academic hierarchy parse…');
                        const r = await api('/api/document-lab/jobs/' + id + '/academic-parse', { method: 'POST' });
                        const stats = r.job?.academicParse || {};
                        toast(`Created ${stats.childChunks || 0} chunk(s), ${stats.tables || 0} table(s), ${stats.facts || 0} fact(s)`);
                        return renderDocumentLab(id);
                    }
                    if (btn.dataset.labAct === 'facts') {
                        if (!confirm('Approve draft structured facts from this lab job for production lookup?')) return;
                        const r = await api('/api/document-lab/jobs/' + id + '/approve-facts', { method: 'POST' });
                        toast(`Approved ${r.approved || 0} fact(s), ${r.approvedTables || 0} table(s)`);
                        return renderDocumentLab(id);
                    }
                } catch (err) {
                    toast(err.message || 'Lab action failed', 'error');
                }
            };
            if (selectedJobId || jobs[0]?.id) loadLabJob(selectedJobId || jobs[0].id);
        } catch (err) {
            document.getElementById('labQueue').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    async function loadNormalizedAcademicStats() {
        const target = document.getElementById('labNormalizedStats');
        if (!target) return;
        target.innerHTML = '<span class="badge badge-info"><i class="fa-solid fa-spinner fa-spin"></i> Loading</span>';
        try {
            const r = await api('/api/document-lab/normalized-academic/stats');
            const stats = r.stats || {};
            const counts = stats.counts || {};
            target.innerHTML = `
                <span class="badge badge-info">${escapeHtml(String(stats.normalizedTotal || 0))} normalized</span>
                <span class="badge badge-info">${escapeHtml(String(stats.structuredFacts || 0))} source facts</span>
                <span class="badge badge-info">${escapeHtml(String(stats.structuredTables || 0))} source tables</span>
                <small>
                    Programmes ${escapeHtml(String(counts.academic_programmes || 0))} ·
                    Courses ${escapeHtml(String(counts.academic_courses || 0))} ·
                    Fees ${escapeHtml(String(counts.academic_fees || 0))} ·
                    Calendar ${escapeHtml(String(counts.academic_calendar_events || 0))} ·
                    Officers ${escapeHtml(String(counts.academic_officers || 0))} ·
                    Rules ${escapeHtml(String(counts.academic_rules || 0))}
                </small>
            `;
        } catch (err) {
            target.innerHTML = `<span class="badge badge-danger">${escapeHtml(err.message || 'Stats unavailable')}</span>`;
        }
    }

    async function runNormalizedAcademicBackfillBatch() {
        const btn = document.getElementById('labNormalizedBackfillBtn');
        const target = document.getElementById('labNormalizedStats');
        if (!btn) return;
        btn.disabled = true;
        const state = runNormalizedAcademicBackfillBatch.state || { afterFactId: 0, afterTableId: 0 };
        try {
            toast('Normalizing next academic fact batch…');
            const r = await api('/api/document-lab/normalized-academic/backfill', {
                method: 'POST',
                body: {
                    limit: 50,
                    afterFactId: state.afterFactId,
                    afterTableId: state.afterTableId
                }
            });
            runNormalizedAcademicBackfillBatch.state = {
                afterFactId: r.afterFactId || state.afterFactId,
                afterTableId: r.afterTableId || state.afterTableId
            };
            const total = Number(r.normalizedFacts || 0) + Number(r.normalizedTables || 0);
            toast(r.done ? `Backfill complete: ${total} candidate(s) normalized in final batch` : `Batch complete: ${total} candidate(s) normalized`);
            if (target) {
                target.innerHTML = `
                    <span class="badge ${r.done ? 'badge-success' : 'badge-info'}">${r.done ? 'Backfill complete' : 'Batch complete'}</span>
                    <span class="badge badge-info">${escapeHtml(String(r.factsScanned || 0))} facts scanned</span>
                    <span class="badge badge-info">${escapeHtml(String(r.tablesScanned || 0))} tables scanned</span>
                    <small>Cursor: fact ${escapeHtml(String(r.afterFactId || 0))}, table ${escapeHtml(String(r.afterTableId || 0))}</small>
                `;
            }
            await loadNormalizedAcademicStats();
        } catch (err) {
            toast(err.message || 'Normalized backfill failed', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    async function loadLabJob(jobId) {
        currentDocumentLabJobId = jobId;
        const workspace = document.getElementById('labWorkspace');
        if (!workspace) return;
        workspace.innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading lab workspace…</div>';
        try {
            const r = await api('/api/document-lab/jobs/' + jobId);
            const job = r.job;
            const recs = (job.recommendations || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
            const outputs = job.outputs || [];
            const facts = job.facts || [];
            const tablesFound = job.tables || [];
            workspace.innerHTML = `
                <div class="document-lab-workspace">
                    <div class="document-lab-summary">
                        <div>
                            <span class="badge ${labIssueClass(job.issueType)}">${escapeHtml(String(job.issueType || 'needs_review').replace(/_/g, ' '))}</span>
                            <h3>${escapeHtml(job.title)}</h3>
                            <p>${escapeHtml(job.fileName || '')} · ${escapeHtml(formatBytes(job.fileSize))}</p>
                        </div>
                        <div>
                            <strong>AI readiness</strong>
                            <small>${escapeHtml(job.reviewStatus || 'not reviewed')}${job.reviewScore ? ` · ${Math.round(Number(job.reviewScore))}/100` : ''}</small>
                        </div>
                        ${recs ? `<div class="document-lab-recs"><strong>Recommendations</strong><ul>${recs}</ul></div>` : ''}
                    </div>
                    ${renderStructuredReviewPanel(facts, tablesFound)}
                    <h3 style="margin:18px 0 10px;color:var(--bg-deep);">Draft outputs</h3>
                    <div id="labOutputs">
                        ${outputs.length ? outputs.map(renderLabOutput).join('') : '<p class="empty">No outputs yet. Use Analyze or Regenerate outputs.</p>'}
                    </div>
                </div>
            `;
            document.getElementById('labOutputs')?.addEventListener('click', handleLabOutputClick);
            document.getElementById('labStructuredReview')?.addEventListener('click', handleStructuredReviewClick);
        } catch (err) {
            workspace.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    async function loadSplitPlan(jobId) {
        currentDocumentLabJobId = jobId;
        const workspace = document.getElementById('labWorkspace');
        if (!workspace) return;
        workspace.innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Building split proposal…</div>';
        try {
            const r = await api('/api/document-lab/jobs/' + jobId + '/split-plan');
            const plan = r.plan;
            workspace.innerHTML = `
                <div class="document-lab-workspace">
                    <div class="document-lab-summary">
                        <div>
                            <span class="badge ${labIssueClass(plan.issueType)}">${escapeHtml(String(plan.issueType || '').replace(/_/g, ' '))}</span>
                            <h3>Split proposal: ${escapeHtml(plan.title)}</h3>
                            <p>${escapeHtml(plan.partCount)} proposed part${plan.partCount === 1 ? '' : 's'} · ${escapeHtml(plan.strategy)}</p>
                        </div>
                        <div>
                            <strong>Admin approval</strong>
                            <small>Select the parts to create as draft outputs. You can edit each part before approving.</small>
                        </div>
                    </div>
                    <div class="document-lab-plan-actions">
                        <button class="btn btn-primary" id="approveSplitPlanBtn"><i class="fa-solid fa-check"></i> Create approved outputs</button>
                        <button class="btn btn-ghost" id="backToLabJobBtn"><i class="fa-solid fa-arrow-left"></i> Back to outputs</button>
                    </div>
                    <div id="splitPlanParts">
                        ${(plan.parts || []).map(renderSplitPlanPart).join('')}
                    </div>
                </div>
            `;
            document.getElementById('backToLabJobBtn')?.addEventListener('click', () => loadLabJob(jobId));
            document.getElementById('approveSplitPlanBtn')?.addEventListener('click', async () => {
                const parts = [...document.querySelectorAll('.document-lab-plan-part')]
                    .filter(card => card.querySelector('.split-plan-approve')?.checked)
                    .map(card => ({
                        title: card.querySelector('.split-plan-title')?.value || '',
                        contentMarkdown: card.querySelector('.split-plan-content')?.value || ''
                    }));
                if (!parts.length) {
                    toast('Select at least one part to approve', 'error');
                    return;
                }
                try {
                    toast('Creating approved outputs…');
                    await api('/api/document-lab/jobs/' + jobId + '/outputs-from-plan', { method: 'POST', body: { parts } });
                    toast('Approved outputs created');
                    renderDocumentLab(jobId);
                } catch (err) {
                    toast(err.message || 'Could not approve split plan', 'error');
                }
            });
        } catch (err) {
            workspace.innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }
    }

    function renderSplitPlanPart(part) {
        return `
            <section class="document-lab-plan-part">
                <div class="document-lab-output-head">
                    <label class="split-plan-check">
                        <input type="checkbox" class="split-plan-approve" checked />
                        <span>Approve part ${escapeHtml(part.sortOrder || '')}</span>
                    </label>
                    <span class="badge ${reviewStatusClass(part.readinessStatus)}">${escapeHtml(String(part.readinessStatus || 'not reviewed').replace(/_/g, ' '))}${part.readinessScore ? ` · ${Math.round(Number(part.readinessScore))}/100` : ''}</span>
                </div>
                <input class="lab-output-title split-plan-title" value="${escapeHtml(part.title || '')}" aria-label="Split title" />
                <small class="split-plan-meta">${escapeHtml(part.charCount || 0)} chars · ${escapeHtml(part.estimatedChunks || 0)} estimated chunks</small>
                <textarea class="lab-output-content split-plan-content" spellcheck="false">${escapeHtml(part.contentMarkdown || '')}</textarea>
            </section>
        `;
    }

    function renderLabOutput(output) {
        const ready = output.readinessStatus || 'not_reviewed';
        const outputLabel = String(output.outputType || '').replace(/_/g, ' ') || 'draft output';
        return `
            <section class="document-lab-output" data-output-id="${output.id}">
                <div class="document-lab-output-head">
                    <div>
                        <span class="badge ${reviewStatusClass(ready)}">${escapeHtml(String(ready).replace(/_/g, ' '))}${output.readinessScore ? ` · ${Math.round(Number(output.readinessScore))}/100` : ''}</span>
                        <span class="badge badge-info">${escapeHtml(outputLabel)}</span>
                        <input class="lab-output-title" value="${escapeHtml(output.title || '')}" aria-label="Output title" />
                    </div>
                    <div class="document-lab-output-actions">
                        <button class="btn btn-ghost" data-output-act="save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                        <button class="btn btn-ghost" data-output-act="review"><i class="fa-solid fa-clipboard-check"></i> Recheck</button>
                        <button class="btn btn-primary" data-output-act="promote"><i class="fa-solid fa-arrow-up-from-bracket"></i> Approve to Documents</button>
                    </div>
                </div>
                <textarea class="lab-output-content" spellcheck="false">${escapeHtml(output.contentMarkdown || '')}</textarea>
                ${output.promotedDocumentId ? `<p class="lede" style="margin:8px 0 0;">Promoted document ID: ${escapeHtml(output.promotedDocumentId)}</p>` : ''}
            </section>
        `;
    }

    function renderStructuredReviewPanel(facts, tablesFound) {
        if (!facts.length && !tablesFound.length) {
            return `
                <section class="document-lab-structured-review" id="labStructuredReview">
                    <div class="document-lab-review-head">
                        <div>
                            <h3>Structured review</h3>
                            <p>No extracted facts or tables yet. Run Academic hierarchy parse to create reviewable records.</p>
                        </div>
                    </div>
                </section>
            `;
        }
        const draftFacts = facts.filter(x => x.status === 'draft').length;
        const draftTables = tablesFound.filter(x => x.status === 'draft').length;
        return `
            <section class="document-lab-structured-review" id="labStructuredReview">
                <div class="document-lab-review-head">
                    <div>
                        <h3>Structured review</h3>
                        <p>${escapeHtml(facts.length)} facts · ${escapeHtml(tablesFound.length)} tables · ${escapeHtml(draftFacts + draftTables)} awaiting approval</p>
                    </div>
                    <div class="document-lab-output-actions">
                        <button class="btn btn-primary" data-structured-act="approve-all"><i class="fa-solid fa-database"></i> Approve all drafts</button>
                    </div>
                </div>
                <details open>
                    <summary>Facts (${escapeHtml(facts.length)})</summary>
                    <div class="structured-review-list">
                        ${facts.length ? facts.map(renderFactReviewCard).join('') : '<p class="empty">No facts extracted.</p>'}
                    </div>
                </details>
                <details ${facts.length ? '' : 'open'}>
                    <summary>Tables (${escapeHtml(tablesFound.length)})</summary>
                    <div class="structured-review-list">
                        ${tablesFound.length ? tablesFound.map(renderTableReviewCard).join('') : '<p class="empty">No tables extracted.</p>'}
                    </div>
                </details>
            </section>
        `;
    }

    function renderFactReviewCard(fact) {
        const locked = fact.status === 'approved' ? 'disabled' : '';
        return `
            <article class="structured-review-card" data-fact-id="${fact.id}">
                <div class="structured-review-card-head">
                    <span class="badge ${fact.status === 'approved' ? 'badge-success' : fact.status === 'rejected' ? 'badge-danger' : 'badge-info'}">${escapeHtml(fact.status || 'draft')}</span>
                    <input class="structured-fact-type" value="${escapeHtml(fact.factType || '')}" ${locked} aria-label="Fact type" />
                    <input class="structured-fact-subject" value="${escapeHtml(fact.subject || '')}" ${locked} aria-label="Subject" />
                </div>
                <textarea class="structured-fact-text" ${locked} spellcheck="false" aria-label="Fact text">${escapeHtml(fact.humanText || '')}</textarea>
                <div class="structured-review-grid">
                    <input class="structured-fact-predicate" value="${escapeHtml(fact.predicate || '')}" ${locked} aria-label="Predicate" />
                    <input class="structured-fact-authority" value="${escapeHtml(fact.authorityType || '')}" ${locked} aria-label="Authority type" />
                    <input class="structured-fact-scope" value="${escapeHtml(fact.scope || '')}" ${locked} aria-label="Scope" />
                </div>
                <input class="structured-fact-source" value="${escapeHtml(fact.sourcePath || '')}" ${locked} aria-label="Source path" />
                <textarea class="structured-fact-json" ${locked} spellcheck="false" aria-label="Fact JSON">${escapeHtml(JSON.stringify(fact.value || {}, null, 2))}</textarea>
                <div class="document-lab-output-actions">
                    <button class="btn btn-ghost" data-fact-act="save" ${locked}><i class="fa-solid fa-floppy-disk"></i> Save</button>
                    <button class="btn btn-ghost" data-fact-act="${fact.status === 'rejected' ? 'restore' : 'reject'}" ${fact.status === 'approved' ? 'disabled' : ''}><i class="fa-solid fa-ban"></i> ${fact.status === 'rejected' ? 'Restore' : 'Reject'}</button>
                    <button class="btn btn-primary" data-fact-act="approve" ${locked}><i class="fa-solid fa-check"></i> Approve fact</button>
                </div>
            </article>
        `;
    }

    function renderTableReviewCard(tableRecord) {
        const locked = tableRecord.status === 'approved' ? 'disabled' : '';
        return `
            <article class="structured-review-card" data-table-id="${tableRecord.id}">
                <div class="structured-review-card-head">
                    <span class="badge ${tableRecord.status === 'approved' ? 'badge-success' : tableRecord.status === 'rejected' ? 'badge-danger' : 'badge-info'}">${escapeHtml(tableRecord.status || 'draft')}</span>
                    <input class="structured-table-title" value="${escapeHtml(tableRecord.title || '')}" ${locked} aria-label="Table title" />
                    <input class="structured-table-type" value="${escapeHtml(tableRecord.tableType || '')}" ${locked} aria-label="Table type" />
                </div>
                <div class="structured-review-grid">
                    <input class="structured-table-programme" value="${escapeHtml(tableRecord.programme || '')}" ${locked} aria-label="Programme" />
                    <input class="structured-table-section" value="${escapeHtml(tableRecord.section || '')}" ${locked} aria-label="Section" />
                    <input class="structured-table-source" value="${escapeHtml(tableRecord.sourcePath || '')}" ${locked} aria-label="Source path" />
                </div>
                <textarea class="structured-table-markdown" ${locked} spellcheck="false" aria-label="Table Markdown">${escapeHtml(tableRecord.markdown || '')}</textarea>
                <textarea class="structured-table-json" ${locked} spellcheck="false" aria-label="Table rows JSON">${escapeHtml(JSON.stringify(tableRecord.rows || [], null, 2))}</textarea>
                <div class="document-lab-output-actions">
                    <button class="btn btn-ghost" data-table-act="save" ${locked}><i class="fa-solid fa-floppy-disk"></i> Save</button>
                    <button class="btn btn-ghost" data-table-act="${tableRecord.status === 'rejected' ? 'restore' : 'reject'}" ${tableRecord.status === 'approved' ? 'disabled' : ''}><i class="fa-solid fa-ban"></i> ${tableRecord.status === 'rejected' ? 'Restore' : 'Reject'}</button>
                    <button class="btn btn-primary" data-table-act="approve" ${locked}><i class="fa-solid fa-check"></i> Approve table</button>
                </div>
            </article>
        `;
    }

    async function handleStructuredReviewClick(e) {
        const approveAll = e.target.closest('button[data-structured-act="approve-all"]');
        if (approveAll) {
            if (!currentDocumentLabJobId) return;
            if (!confirm('Approve all draft facts and tables from this lab job for production lookup?')) return;
            try {
                const r = await api('/api/document-lab/jobs/' + currentDocumentLabJobId + '/approve-facts', { method: 'POST' });
                toast(`Approved ${r.approved || 0} fact(s), ${r.approvedTables || 0} table(s)`);
                return loadLabJob(currentDocumentLabJobId);
            } catch (err) {
                toast(err.message || 'Could not approve structured records', 'error');
                return;
            }
        }

        const factBtn = e.target.closest('button[data-fact-act]');
        if (factBtn) return handleFactReviewAction(factBtn);
        const tableBtn = e.target.closest('button[data-table-act]');
        if (tableBtn) return handleTableReviewAction(tableBtn);
    }

    async function handleFactReviewAction(btn) {
        const card = btn.closest('[data-fact-id]');
        const id = card?.dataset.factId;
        if (!id) return;
        try {
            if (btn.dataset.factAct === 'save') {
                await api('/api/document-lab/facts/' + id, {
                    method: 'PUT',
                    body: collectFactReviewPayload(card)
                });
                toast('Fact saved');
            } else if (btn.dataset.factAct === 'approve') {
                await api('/api/document-lab/facts/' + id, {
                    method: 'PUT',
                    body: collectFactReviewPayload(card)
                });
                await api('/api/document-lab/facts/' + id + '/approve', { method: 'POST' });
                toast('Fact approved');
            } else if (btn.dataset.factAct === 'reject' || btn.dataset.factAct === 'restore') {
                await api('/api/document-lab/facts/' + id + '/status', {
                    method: 'POST',
                    body: { status: btn.dataset.factAct === 'restore' ? 'draft' : 'rejected' }
                });
                toast(btn.dataset.factAct === 'restore' ? 'Fact restored' : 'Fact rejected');
            }
            if (currentDocumentLabJobId) loadLabJob(currentDocumentLabJobId);
        } catch (err) {
            toast(err.message || 'Fact action failed', 'error');
        }
    }

    async function handleTableReviewAction(btn) {
        const card = btn.closest('[data-table-id]');
        const id = card?.dataset.tableId;
        if (!id) return;
        try {
            if (btn.dataset.tableAct === 'save') {
                await api('/api/document-lab/tables/' + id, {
                    method: 'PUT',
                    body: collectTableReviewPayload(card)
                });
                toast('Table saved');
            } else if (btn.dataset.tableAct === 'approve') {
                await api('/api/document-lab/tables/' + id, {
                    method: 'PUT',
                    body: collectTableReviewPayload(card)
                });
                await api('/api/document-lab/tables/' + id + '/approve', { method: 'POST' });
                toast('Table approved');
            } else if (btn.dataset.tableAct === 'reject' || btn.dataset.tableAct === 'restore') {
                await api('/api/document-lab/tables/' + id + '/status', {
                    method: 'POST',
                    body: { status: btn.dataset.tableAct === 'restore' ? 'draft' : 'rejected' }
                });
                toast(btn.dataset.tableAct === 'restore' ? 'Table restored' : 'Table rejected');
            }
            if (currentDocumentLabJobId) loadLabJob(currentDocumentLabJobId);
        } catch (err) {
            toast(err.message || 'Table action failed', 'error');
        }
    }

    function collectFactReviewPayload(card) {
        const valueText = card.querySelector('.structured-fact-json')?.value || '{}';
        JSON.parse(valueText);
        return {
            factType: card.querySelector('.structured-fact-type')?.value || '',
            subject: card.querySelector('.structured-fact-subject')?.value || '',
            predicate: card.querySelector('.structured-fact-predicate')?.value || '',
            humanText: card.querySelector('.structured-fact-text')?.value || '',
            authorityType: card.querySelector('.structured-fact-authority')?.value || '',
            scope: card.querySelector('.structured-fact-scope')?.value || '',
            sourcePath: card.querySelector('.structured-fact-source')?.value || '',
            valueJson: valueText
        };
    }

    function collectTableReviewPayload(card) {
        const rowsText = card.querySelector('.structured-table-json')?.value || '[]';
        JSON.parse(rowsText);
        return {
            title: card.querySelector('.structured-table-title')?.value || '',
            tableType: card.querySelector('.structured-table-type')?.value || '',
            programme: card.querySelector('.structured-table-programme')?.value || '',
            section: card.querySelector('.structured-table-section')?.value || '',
            sourcePath: card.querySelector('.structured-table-source')?.value || '',
            markdown: card.querySelector('.structured-table-markdown')?.value || '',
            rowsJson: rowsText
        };
    }

    async function handleLabOutputClick(e) {
        const btn = e.target.closest('button[data-output-act]'); if (!btn) return;
        const card = btn.closest('.document-lab-output');
        const id = card?.dataset.outputId;
        if (!id) return;
        const title = card.querySelector('.lab-output-title')?.value || '';
        const contentMarkdown = card.querySelector('.lab-output-content')?.value || '';
        try {
            if (btn.dataset.outputAct === 'save') {
                await api('/api/document-lab/outputs/' + id, { method: 'PUT', body: { title, contentMarkdown, status: 'draft' } });
                toast('Output saved and rechecked');
            } else if (btn.dataset.outputAct === 'review') {
                await api('/api/document-lab/outputs/' + id, { method: 'PUT', body: { title, contentMarkdown } });
                toast('Output rechecked');
            } else if (btn.dataset.outputAct === 'promote') {
                await api('/api/document-lab/outputs/' + id, { method: 'PUT', body: { title, contentMarkdown, status: 'approved' } });
                const promoted = await api('/api/document-lab/outputs/' + id + '/promote', { method: 'POST', body: {} });
                toast('Promoted to Documents as #' + promoted.documentId);
            }
            if (currentDocumentLabJobId) renderDocumentLab(currentDocumentLabJobId);
        } catch (err) {
            toast(err.message || 'Output action failed', 'error');
        }
    }

    function labIssueClass(issue) {
        const s = String(issue || '').toLowerCase();
        if (s === 'ready_for_approval') return 'badge-success';
        if (s === 'needs_readable_source') return 'badge-danger';
        if (s.includes('ocr') || s.includes('split') || s.includes('table') || s.includes('structure')) return 'badge-warn';
        return 'badge-info';
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

    // -------------------------------------------------------- EVALUATION
    async function renderEvaluationTests() {
        main.innerHTML = `
            <h2>Evaluation tests</h2>
            <p class="lede">Test high-risk academic questions against retrieval evidence before trusting production answers.</p>
            <form id="evalCreateForm" class="compose-card" style="margin-bottom:16px;">
                <div class="form-row">
                    <label>Question<input name="question" required placeholder="How many years is MBBS for UTME entry?" /></label>
                    <label>Topic<input name="topic" placeholder="admission, fees, graduation…" /></label>
                </div>
                <div class="form-row">
                    <label>Expected terms<textarea name="expectedTerms" placeholder="MBBS&#10;6 years&#10;UTME"></textarea></label>
                    <label>Forbidden terms<textarea name="forbiddenTerms" placeholder="Put terms that must not appear"></textarea></label>
                </div>
                <div class="form-row">
                    <label>Source hint<input name="sourceHint" placeholder="Medicine and Dentistry CCMAS" /></label>
                    <label>Minimum confidence<input name="minConfidence" type="number" min="0" max="1" step="0.01" value="0.12" /></label>
                </div>
                <button class="btn btn-primary" type="submit"><i class="fa-solid fa-plus"></i> Add test</button>
            </form>
            <div class="admin-actions">
                <button class="btn btn-primary" id="evalRunAllBtn"><i class="fa-solid fa-play"></i> Run active tests</button>
                <button class="btn btn-ghost" id="evalRefreshBtn"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
            </div>
            <div id="evalSummary" class="stat-row"></div>
            <div id="evalList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;

        document.getElementById('evalCreateForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            try {
                await api('/api/admin/evaluation/tests', {
                    method: 'POST',
                    body: {
                        question: fd.get('question'),
                        topic: fd.get('topic'),
                        expectedTerms: splitTerms(fd.get('expectedTerms')),
                        forbiddenTerms: splitTerms(fd.get('forbiddenTerms')),
                        sourceHint: fd.get('sourceHint'),
                        minConfidence: Number(fd.get('minConfidence') || 0.12)
                    }
                });
                toast('Evaluation test added');
                e.currentTarget.reset();
                loadEvaluationTests();
            } catch (err) {
                toast(err.message || 'Could not add test', 'error');
            }
        });
        document.getElementById('evalRefreshBtn')?.addEventListener('click', loadEvaluationTests);
        document.getElementById('evalRunAllBtn')?.addEventListener('click', async () => {
            const btn = document.getElementById('evalRunAllBtn');
            btn.disabled = true;
            try {
                toast('Running evaluation tests…');
                const r = await api('/api/admin/evaluation/run-all', { method: 'POST', body: { limit: 50 } });
                toast(`Evaluation complete: ${r.passed || 0} passed, ${r.failed || 0} failed`);
                loadEvaluationTests();
            } catch (err) {
                toast(err.message || 'Could not run tests', 'error');
            } finally {
                btn.disabled = false;
            }
        });

        async function loadEvaluationTests() {
            try {
                const r = await api('/api/admin/evaluation/tests?limit=300');
                const s = r.summary || {};
                document.getElementById('evalSummary').innerHTML = [
                    stat('Active', s.active || 0),
                    stat('Passed', s.passed || 0),
                    stat('Failed', s.failed || 0),
                    stat('Never run', s.neverRun || 0)
                ].join('');
                const tests = r.tests || [];
                if (!tests.length) {
                    document.getElementById('evalList').innerHTML = '<p class="empty">No evaluation tests yet.</p>';
                    return;
                }
                document.getElementById('evalList').innerHTML = tests.map(renderEvalTestCard).join('');
                document.getElementById('evalList').onclick = handleEvalClick;
            } catch (err) {
                document.getElementById('evalList').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
            }
        }
        loadEvaluationTests();
    }

    function splitTerms(value) {
        return String(value || '').split(/\r?\n|,/).map(x => x.trim()).filter(Boolean);
    }

    function renderEvalTestCard(test) {
        const status = test.lastStatus || 'not_run';
        const statusCls = status === 'passed' ? 'badge-success' : (status === 'failed' ? 'badge-danger' : 'badge-info');
        const result = test.lastResult || {};
        const missing = result.missingExpected || [];
        const forbidden = result.foundForbidden || [];
        return `
            <section class="eval-card" data-eval-id="${test.id}">
                <div class="document-lab-output-head">
                    <div>
                        <span class="badge ${statusCls}">${escapeHtml(status.replace(/_/g, ' '))}${test.lastScore !== null ? ` · ${Math.round(Number(test.lastScore) * 100)}%` : ''}</span>
                        <span class="badge badge-info">${escapeHtml(test.topic || 'general')}</span>
                        <h3>${escapeHtml(test.question)}</h3>
                        <p class="lede" style="margin:6px 0 0;">Expected: ${escapeHtml((test.expectedTerms || []).join(', ') || 'none')} ${test.sourceHint ? `· Source hint: ${escapeHtml(test.sourceHint)}` : ''}</p>
                    </div>
                    <div class="document-lab-output-actions">
                        <button class="btn btn-primary" data-eval-act="run"><i class="fa-solid fa-play"></i> Run</button>
                        <button class="btn btn-ghost" data-eval-act="archive"><i class="fa-solid fa-box-archive"></i> Archive</button>
                    </div>
                </div>
                ${test.lastRunAt ? `<small class="split-plan-meta">Last run: ${escapeHtml(formatDate(test.lastRunAt))} · Confidence: ${escapeHtml(result.confidence ?? '—')} · Facts: ${escapeHtml(result.structuredFacts ?? 0)} · Tables: ${escapeHtml(result.structuredTables ?? 0)}</small>` : ''}
                ${missing.length || forbidden.length ? `<div class="auth-error" style="margin:8px 0;">${missing.length ? `Missing: ${escapeHtml(missing.join(', '))}` : ''}${missing.length && forbidden.length ? ' · ' : ''}${forbidden.length ? `Forbidden found: ${escapeHtml(forbidden.join(', '))}` : ''}</div>` : ''}
                ${result.preview ? `<details><summary>Evidence preview</summary><pre class="eval-preview">${escapeHtml(result.preview)}</pre></details>` : ''}
            </section>
        `;
    }

    async function handleEvalClick(e) {
        const btn = e.target.closest('button[data-eval-act]');
        if (!btn) return;
        const card = btn.closest('[data-eval-id]');
        const id = card?.dataset.evalId;
        if (!id) return;
        try {
            if (btn.dataset.evalAct === 'run') {
                btn.disabled = true;
                toast('Running evaluation test…');
                const r = await api('/api/admin/evaluation/tests/' + id + '/run', { method: 'POST' });
                toast(r.result?.status === 'passed' ? 'Evaluation passed' : 'Evaluation failed', r.result?.status === 'passed' ? undefined : 'error');
                renderEvaluationTests();
            } else if (btn.dataset.evalAct === 'archive') {
                if (!confirm('Archive this evaluation test?')) return;
                await api('/api/admin/evaluation/tests/' + id, { method: 'DELETE' });
                toast('Evaluation test archived');
                renderEvaluationTests();
            }
        } catch (err) {
            toast(err.message || 'Evaluation action failed', 'error');
        }
    }

    // ------------------------------------------------ STRUCTURED RECORDS
    async function renderStructuredRecords() {
        main.innerHTML = `
            <h2>Structured Facts</h2>
            <p class="lede">Direct production lookup tables for exact advisor answers. Use this for corrected officers, fees, courses, programme rules, calendar dates, and approved facts.</p>
            <div class="admin-actions">
                <label>Table
                    <select id="structuredTableSelect" class="input"></select>
                </label>
                <label>Search
                    <input id="structuredSearchInput" class="input" placeholder="programme, officer, course code, source..." />
                </label>
                <label>Status
                    <select id="structuredStatusFilter" class="input">
                        <option value="">Any status</option>
                        <option value="active">Active</option>
                        <option value="draft">Draft</option>
                        <option value="inactive">Archived</option>
                    </select>
                </label>
                <label id="structuredRuleCategoryLabel" style="display:none;">Requirement
                    <select id="structuredRuleCategoryFilter" class="input">
                        <option value="">Any requirement</option>
                        <option value="admission">Admission</option>
                        <option value="graduation">Graduation</option>
                        <option value="progression">Progression</option>
                        <option value="examination">Examination</option>
                        <option value="course_registration">Course registration</option>
                        <option value="transfer">Transfer</option>
                        <option value="regulation">Regulation</option>
                        <option value="fees">Fees</option>
                        <option value="calendar">Calendar</option>
                        <option value="general">General</option>
                    </select>
                </label>
                <button class="btn btn-ghost" id="structuredRefreshBtn"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
                <button class="btn btn-primary" id="structuredAddBtn"><i class="fa-solid fa-plus"></i> Add new</button>
                <button class="btn btn-ghost" id="structuredTemplateBtn"><i class="fa-solid fa-file-excel"></i> Template</button>
                <label class="btn btn-primary" style="cursor:pointer;">
                    <i class="fa-solid fa-upload"></i> Import
                    <input type="file" id="structuredImportInput" accept=".xlsx,.xls,.csv" style="display:none;" />
                </label>
            </div>
            <div id="structuredTableInfo" class="stat-row"></div>
            <div id="structuredImportResult"></div>
            <div id="structuredRecordsBody"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
            <dialog id="structuredEditDialog" class="modal modal--wide structured-edit-dialog"></dialog>
        `;

        let tables = [];
        let currentTable = '';
        let currentRecords = [];
        let currentTableInfo = null;
        try {
            const r = await api('/api/admin/structured-records/tables');
            tables = r.tables || [];
            const select = document.getElementById('structuredTableSelect');
            select.innerHTML = tables.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.label)} (${escapeHtml(t.count)})</option>`).join('');
            currentTable = tables[0]?.name || '';

            select.addEventListener('change', () => {
                currentTable = select.value;
                const ruleFilter = document.getElementById('structuredRuleCategoryFilter');
                if (ruleFilter) ruleFilter.value = '';
                loadStructuredRecords();
            });
            document.getElementById('structuredRefreshBtn')?.addEventListener('click', loadStructuredRecords);
            document.getElementById('structuredStatusFilter')?.addEventListener('change', loadStructuredRecords);
            document.getElementById('structuredRuleCategoryFilter')?.addEventListener('change', loadStructuredRecords);
            document.getElementById('structuredAddBtn')?.addEventListener('click', () => {
                if (!currentTable || !currentTableInfo) return;
                openStructuredRecordDialog(currentTable, currentTableInfo, createBlankStructuredRecord(currentTableInfo), loadStructuredRecords, { isNew: true });
            });
            document.getElementById('structuredSearchInput')?.addEventListener('keydown', e => {
                if (e.key === 'Enter') loadStructuredRecords();
            });
            document.getElementById('structuredTemplateBtn')?.addEventListener('click', () => downloadStructuredTemplate(currentTable));
            document.getElementById('structuredImportInput')?.addEventListener('change', e => importStructuredRecords(currentTable, e.target.files?.[0]));
            await loadStructuredRecords();
        } catch (err) {
            document.getElementById('structuredRecordsBody').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
        }

        async function loadStructuredRecords() {
            if (!currentTable) return;
            const info = tables.find(t => t.name === currentTable) || {};
            const q = document.getElementById('structuredSearchInput')?.value || '';
            const status = document.getElementById('structuredStatusFilter')?.value || '';
            const requirementCategory = document.getElementById('structuredRuleCategoryFilter')?.value || '';
            const ruleCategoryLabel = document.getElementById('structuredRuleCategoryLabel');
            if (ruleCategoryLabel) ruleCategoryLabel.style.display = currentTable === 'academic_rules' ? '' : 'none';
            document.getElementById('structuredTableInfo').innerHTML = [
                stat('Selected table', info.label || currentTable),
                stat('Records', info.count ?? '—'),
                stat('Required', (info.required || []).join(', ') || '—')
            ].join('');
            document.getElementById('structuredRecordsBody').innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading records…</div>';
            try {
                const params = new URLSearchParams({ limit: '120' });
                if (q) params.set('q', q);
                if (status) params.set('status', status);
                if (currentTable === 'academic_rules' && requirementCategory) params.set('requirement_category', requirementCategory);
                const r = await api(`/api/admin/structured-records/${encodeURIComponent(currentTable)}?${params.toString()}`);
                const records = r.records || [];
                const tableInfo = r.table || info;
                currentRecords = records;
                currentTableInfo = tableInfo;
                document.getElementById('structuredTableInfo').innerHTML = [
                    stat('Selected table', tableInfo.label || currentTable),
                    stat('Loaded', records.length),
                    stat('Required', (tableInfo.required || []).join(', ') || '—')
                ].join('');
                document.getElementById('structuredRecordsBody').innerHTML = records.length
                    ? renderStructuredRecordsGrid(tableInfo, records)
                    : '<p class="empty">No records found. Download the template and import new records.</p>';
                document.getElementById('structuredRecordsBody').onclick = handleStructuredRecordClick;
            } catch (err) {
                document.getElementById('structuredRecordsBody').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
            }
        }

        async function handleStructuredRecordClick(e) {
            const btn = e.target.closest('button[data-structured-act]');
            if (!btn) return;
            const id = btn.dataset.structuredId;
            if (!id) return;
            if (btn.dataset.structuredAct === 'edit') {
                const record = currentRecords.find(item => String(item.id) === String(id));
                if (record && currentTableInfo) openStructuredRecordDialog(currentTable, currentTableInfo, record, loadStructuredRecords);
            } else if (btn.dataset.structuredAct === 'archive') {
                const record = currentRecords.find(item => String(item.id) === String(id));
                const label = record ? structuredRecordTitle(currentTableInfo, record) : `record ${id}`;
                if (!confirm(`Archive ${label}? The record will be hidden from production lookup but kept for audit.`)) return;
                btn.disabled = true;
                try {
                    await api(`/api/admin/structured-records/${encodeURIComponent(currentTable)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
                    toast('Structured record archived');
                    await loadStructuredRecords();
                } catch (err) {
                    toast(err.message || 'Could not archive structured record', 'error');
                } finally {
                    btn.disabled = false;
                }
            }
        }

        async function importStructuredRecords(tableName, file) {
            if (!tableName || !file) return;
            const fd = new FormData();
            fd.append('file', file);
            try {
                toast('Importing structured records…');
                const r = await api(`/api/admin/structured-records/${encodeURIComponent(tableName)}/import`, {
                    method: 'POST',
                    body: fd,
                    formData: true
                });
                const errors = r.errors || [];
                document.getElementById('structuredImportResult').innerHTML = errors.length
                    ? `<div class="auth-error">Imported ${escapeHtml((r.created || 0) + (r.updated || 0))}; ${escapeHtml(errors.length)} row(s) need correction. ${escapeHtml(errors.map(x => `Row ${x.row}: ${x.error}`).join(' | '))}</div>`
                    : `<p class="lede">Imported ${escapeHtml((r.created || 0) + (r.updated || 0))} record(s).</p>`;
                toast(errors.length ? 'Import completed with row warnings' : 'Import complete', errors.length ? 'error' : undefined);
                eResetImportInput();
                const refreshed = await api('/api/admin/structured-records/tables');
                tables = refreshed.tables || tables;
                await loadStructuredRecords();
            } catch (err) {
                toast(err.message || 'Import failed', 'error');
            }
        }

        function eResetImportInput() {
            const input = document.getElementById('structuredImportInput');
            if (input) input.value = '';
        }
    }

    function renderStructuredRecordsGrid(tableInfo, records) {
        const columns = structuredVisibleColumns(tableInfo);
        const head = [
            '<th class="structured-actions-col">Actions</th>',
            ...columns.map(column => `<th>${escapeHtml(structuredFieldLabel(column))}</th>`)
        ].join('');
        const body = records.map(record => {
            const archived = String(record.status || '').toLowerCase() === 'inactive';
            return `
                <tr class="${archived ? 'structured-row-archived' : ''}">
                    <td class="structured-actions-cell">
                        <button class="btn btn-ghost" data-structured-act="edit" data-structured-id="${escapeHtml(record.id)}"><i class="fa-solid fa-pen-to-square"></i> Edit</button>
                        <button class="btn btn-ghost" data-structured-act="archive" data-structured-id="${escapeHtml(record.id)}"><i class="fa-solid fa-box-archive"></i> Archive</button>
                    </td>
                    ${columns.map(column => `<td title="${escapeHtml(record[column] || '')}">${formatStructuredGridCell(column, record[column])}</td>`).join('')}
                </tr>
            `;
        }).join('');
        return `
            <div class="structured-grid-shell">
                <table class="admin-table structured-grid-table">
                    <thead><tr>${head}</tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
        `;
    }

    function structuredVisibleColumns(tableInfo) {
        const all = tableInfo.columns || [];
        const byTable = {
            academic_officers: ['office', 'officer_name', 'source_path', 'status'],
            academic_fees: ['programme', 'student_category', 'fee_category', 'amount_label', 'session_label', 'status'],
            academic_programmes: ['programme', 'faculty', 'department', 'degree', 'duration_years', 'entry_mode', 'status'],
            academic_courses: ['programme', 'level_label', 'semester_label', 'course_code', 'course_title', 'credit_units', 'status'],
            academic_calendar_events: ['event_title', 'event_date_label', 'session_label', 'status'],
            academic_rules: ['rule_type', 'requirement_category', 'programme', 'entry_mode', 'requirement_text', 'source_path', 'status'],
            structured_facts: ['fact_type', 'subject', 'predicate_name', 'human_text', 'authority_rank', 'status']
        };
        const preferred = byTable[tableInfo.name] || all.slice(0, 6);
        return preferred.filter(column => all.includes(column));
    }

    function formatStructuredGridCell(column, value) {
        const text = String(value ?? '');
        if (column === 'status') {
            const cls = text.toLowerCase() === 'active' ? 'badge-success'
                : text.toLowerCase() === 'inactive' ? 'badge-danger'
                : 'badge-info';
            return `<span class="badge ${cls}">${escapeHtml(text || '—')}</span>`;
        }
        return escapeHtml(text.length > 140 ? text.slice(0, 137) + '...' : (text || '—'));
    }

    function structuredRecordTitle(tableInfo, record) {
        const columns = tableInfo?.columns || [];
        const titleColumn = columns.find(c => /programme|office|subject|course_title|event_title|rule_type|human_text/.test(c)) || columns[0];
        return String(record?.[titleColumn] || `record ${record?.id || ''}`).trim();
    }

    function createBlankStructuredRecord(tableInfo) {
        const record = {};
        for (const column of tableInfo.columns || []) {
            record[column] = Object.prototype.hasOwnProperty.call(tableInfo.defaults || {}, column)
                ? tableInfo.defaults[column]
                : '';
        }
        return record;
    }

    function openStructuredRecordDialog(tableName, tableInfo, record, afterSave, options = {}) {
        const dialog = document.getElementById('structuredEditDialog');
        if (!dialog) return;
        const isNew = !!options.isNew;
        const columns = tableInfo.columns || [];
        const advanced = new Set(['value_json', 'row_json', 'source_path', 'status', 'authority_type', 'scope_label', 'currentness_label', 'record_hash']);
        const requiredFields = new Set(tableInfo.required || []);
        const simpleColumns = columns.filter(column => !advanced.has(column));
        const advancedColumns = columns.filter(column => advanced.has(column));
        dialog.innerHTML = `
            <form method="dialog" class="structured-edit-form" data-structured-id="${escapeHtml(record.id || '')}">
                <div class="modal-head">
                    <div>
                        <h2><i class="fa-solid fa-table-list"></i> ${isNew ? 'Add' : 'Edit'} ${escapeHtml(tableInfo.label || 'record')}</h2>
                        <p class="lede">${isNew ? 'Create a new production lookup record. Required fields are marked.' : `ID ${escapeHtml(record.id)} · ${escapeHtml(structuredRecordTitle(tableInfo, record))}`}</p>
                    </div>
                    <button class="icon-btn" type="button" data-structured-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="structured-edit-grid">
                    ${simpleColumns.map(column => renderStructuredRecordField(column, record[column], requiredFields.has(column))).join('')}
                </div>
                ${advancedColumns.length ? `
                    <details class="structured-advanced">
                        <summary>Advanced source and system fields</summary>
                        <div class="structured-edit-grid">
                            ${advancedColumns.map(column => renderStructuredRecordField(column, record[column], requiredFields.has(column))).join('')}
                        </div>
                    </details>
                ` : ''}
                <menu>
                    <button class="btn btn-ghost" value="cancel" type="button" data-structured-dialog-close>Cancel</button>
                    ${isNew ? '' : '<button class="btn btn-ghost" type="button" data-structured-dialog-archive><i class="fa-solid fa-box-archive"></i> Archive</button>'}
                    <button class="btn btn-primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> ${isNew ? 'Create record' : 'Save changes'}</button>
                </menu>
            </form>
        `;
        dialog.querySelector('[data-structured-dialog-close]')?.addEventListener('click', () => dialog.close());
        dialog.querySelector('[data-structured-dialog-archive]')?.addEventListener('click', async () => {
            if (!confirm(`Archive ${structuredRecordTitle(tableInfo, record)}?`)) return;
            try {
                await api(`/api/admin/structured-records/${encodeURIComponent(tableName)}/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
                toast('Structured record archived');
                dialog.close();
                await afterSave();
            } catch (err) {
                toast(err.message || 'Could not archive structured record', 'error');
            }
        });
        dialog.querySelector('form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const payload = collectStructuredRecordPayload(dialog);
                await api(isNew
                    ? `/api/admin/structured-records/${encodeURIComponent(tableName)}`
                    : `/api/admin/structured-records/${encodeURIComponent(tableName)}/${encodeURIComponent(record.id)}`, {
                    method: isNew ? 'POST' : 'PUT',
                    body: payload
                });
                toast(isNew ? 'Structured record created' : 'Structured record updated');
                dialog.close();
                await afterSave();
            } catch (err) {
                toast(err.message || `Could not ${isNew ? 'create' : 'update'} structured record`, 'error');
            }
        });
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', 'open');
    }

    function renderStructuredRecordField(column, value, required = false) {
        const isLong = /text|json|source_path|raw_text|human_text|value_json|row_json/.test(column);
        const label = structuredFieldLabel(column);
        const requiredAttr = required ? ' required' : '';
        const requiredMark = required ? ' <span class="required-indicator">Required</span>' : '';
        const placeholder = structuredFieldPlaceholder(column);
        const fixedOptions = structuredFieldSelectOptions(column);
        if (fixedOptions.length) {
            const current = String(value || fixedOptions[0] || '');
            return `<label>${escapeHtml(label)}${requiredMark}<select data-structured-field="${escapeHtml(column)}"${requiredAttr}>
                ${fixedOptions.map(option => `<option value="${escapeHtml(option)}"${current.toLowerCase() === option.toLowerCase() ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
            </select></label>`;
        }
        const suggestions = structuredFieldSuggestions(column);
        const listId = suggestions.length ? `structured-list-${column.replace(/[^a-z0-9_-]/gi, '-')}` : '';
        const listAttr = listId ? ` list="${escapeHtml(listId)}"` : '';
        const listMarkup = listId ? `<datalist id="${escapeHtml(listId)}">${suggestions.map(option => `<option value="${escapeHtml(option)}"></option>`).join('')}</datalist>` : '';
        if (isLong) {
            return `<label>${escapeHtml(label)}${requiredMark}<textarea data-structured-field="${escapeHtml(column)}" spellcheck="false" placeholder="${escapeHtml(placeholder)}"${requiredAttr}>${escapeHtml(value || '')}</textarea></label>`;
        }
        return `<label>${escapeHtml(label)}${requiredMark}<input data-structured-field="${escapeHtml(column)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}"${listAttr}${requiredAttr} />${listMarkup}</label>`;
    }

    function structuredFieldSelectOptions(column) {
        const options = {
            status: ['active', 'draft', 'inactive'],
            requirement_category: ['admission', 'graduation', 'progression', 'examination', 'course_registration', 'transfer', 'regulation', 'fees', 'calendar', 'general'],
            entry_mode: ['', 'UTME', 'Direct Entry', 'Transfer', 'Postgraduate', 'All entry modes'],
            semester_label: ['', 'First semester', 'Second semester', 'All semesters'],
            currentness_label: ['current', 'historical', 'pending_review', 'superseded'],
            authority_type: ['institution', 'regulator', 'professional_body', 'student_handbook', 'senate', 'unknown']
        };
        return options[column] || [];
    }

    function structuredFieldSuggestions(column) {
        const suggestions = {
            rule_type: ['admission_requirement', 'graduation_requirement', 'progression_rule', 'examination_rule', 'course_registration_rule', 'transfer_rule', 'professional_requirement', 'accreditation_requirement'],
            level_label: ['100 level', '200 level', '300 level', '400 level', '500 level', '600 level', 'All levels'],
            student_category: ['indigene', 'non-indigene', 'foreign student', 'all students'],
            fee_category: ['tuition', 'official_total_payable', 'acceptance_fee', 'registration_fee', 'hostel_fee', 'clinical_fee'],
            authority_type: ['institution', 'regulator', 'professional_body', 'student_handbook', 'senate'],
            currentness_label: ['current', 'historical', 'pending_review', 'superseded']
        };
        return suggestions[column] || [];
    }

    function structuredFieldPlaceholder(column) {
        const placeholders = {
            fact_type: 'principal_officer, fee, admission_rule...',
            subject: 'Bursar, MBBS fees, 300 level MLS courses...',
            predicate_name: 'office_holder, amount, requirement...',
            value_json: '{"office":"Bursar","officer_name":"Dr Ebipuado Ombu"}',
            human_text: 'Write the exact answer/fact users should receive.',
            source_path: 'Name of approved source document',
            programme: 'Medicine and Surgery (MBBS)',
            faculty: 'Faculty or college name',
            department: 'Department name',
            degree: 'MBBS, B.Sc, B.NSc...',
            duration_years: '5',
            entry_mode: 'UTME, Direct Entry...',
            level_label: '300 level',
            semester_label: 'First semester',
            course_code: 'MLS 313',
            course_title: 'Basic Hematology',
            credit_units: '2',
            fee_category: 'tuition, total payable, acceptance fee...',
            amount_label: 'N1,230,000',
            amount_value: '1230000',
            session_label: '2025/2026',
            student_category: 'indigene, non-indigene, foreign student...',
            event_title: 'First semester registration begins',
            event_date_label: 'Monday 12 January 2026',
            office: 'Bursar',
            officer_name: 'Dr Ebipuado Ombu',
            rule_type: 'admission_requirement, graduation_requirement...',
            requirement_category: 'admission, graduation, progression...',
            raw_text: 'Paste the exact approved wording.',
            requirement_text: 'Write the requirement exactly as approved.',
            minimum_value: 'Minimum 5 credits, CGPA 1.50, 180 UTME score...',
            row_json: '{"programme":"Medical Laboratory Science","level":"300 level"}'
        };
        return placeholders[column] || '';
    }

    function structuredFieldLabel(column) {
        const labels = {
            fact_type: 'Type of fact',
            subject: 'Subject',
            predicate_name: 'Relationship',
            value_json: 'Structured value',
            human_text: 'Answer text / fact wording',
            authority_type: 'Authority type',
            scope_label: 'Scope',
            source_path: 'Source document',
            status: 'Status',
            currentness_label: 'Currentness',
            authority_rank: 'Authority rank',
            programme: 'Programme',
            faculty: 'Faculty',
            department: 'Department',
            degree: 'Degree',
            duration_years: 'Duration in years',
            entry_mode: 'Entry mode',
            level_label: 'Level',
            semester_label: 'Semester',
            course_code: 'Course code',
            course_title: 'Course title',
            credit_units: 'Credit units',
            fee_category: 'Fee category',
            amount_label: 'Amount shown to users',
            amount_value: 'Amount as number',
            session_label: 'Session',
            student_category: 'Student category',
            event_title: 'Calendar event',
            event_date_label: 'Date or date range',
            office: 'Office / role',
            officer_name: 'Officer name',
            rule_type: 'Rule type',
            requirement_category: 'Requirement category',
            requirement_text: 'Requirement text',
            minimum_value: 'Minimum / threshold',
            raw_text: 'Exact wording',
            row_json: 'Structured row'
        };
        return labels[column] || column.replace(/_/g, ' ');
    }

    function collectStructuredRecordPayload(card) {
        const payload = {};
        card.querySelectorAll('[data-structured-field]').forEach(el => {
            payload[el.dataset.structuredField] = el.value;
        });
        return payload;
    }

    async function downloadStructuredTemplate(tableName) {
        if (!tableName) return;
        try {
            const res = await fetch(`/api/admin/structured-records/${encodeURIComponent(tableName)}/template`, {
                headers: authHeaders()
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Could not download template');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${tableName}_template.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast(err.message || 'Template download failed', 'error');
        }
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
