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
    function hasCookieSessionMarker() {
        return /(?:^|;\s*)bmu_auth_present=1(?:;|$)/.test(document.cookie || '');
    }
    function clearAuthCache() {
        try { localStorage.removeItem('bmu_token'); } catch (_) {}
        try { sessionStorage.removeItem('bmu_token'); } catch (_) {}
        try { localStorage.removeItem('bmu_user'); } catch (_) {}
        try { localStorage.removeItem('bmu_advisor_session'); } catch (_) {}
        try { localStorage.removeItem('bmu_advisor_sessions'); } catch (_) {}
        try { document.cookie = 'bmu_auth_present=; Max-Age=0; path=/; SameSite=Lax'; } catch (_) {}
    }
    if (!token && !hasCookieSessionMarker()) {
        location.replace('/login?next=/admin');
        return;
    }

    function authHeaders(extra) {
        return Object.assign(token ? { Authorization: 'Bearer ' + token } : {}, extra || {});
    }

    async function api(path, opts) {
        opts = opts || {};
        const init = {
            method: opts.method || 'GET',
            headers: authHeaders(opts.body && !opts.formData ? { 'Content-Type': 'application/json' } : {}),
            body: opts.body
                ? (opts.formData ? opts.body : JSON.stringify(opts.body))
                : undefined,
            credentials: 'same-origin'
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
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            try {
                await fetch('/api/users/logout', {
                    method: 'POST',
                    headers: authHeaders(),
                    credentials: 'same-origin'
                });
            } catch (_) {}
            clearAuthCache();
            location.replace('/');
        });
    }
    renderAuthSlot();

    // ---------------------------------------------------------- Section nav
    const main = document.getElementById('adminMain');
    let latestDocumentReviewHtml = '';
    let currentDocumentLabJobId = null;
    let pendingStructuredRecordsView = null;
    let latestRecentFacts = [];
    const navButtons = document.querySelectorAll('.admin-nav button');
    const sections = {
        dashboard: renderDashboard,
        advisorOps: renderAdvisorOpsPage,
        documents: renderDocuments,
        documentLab: renderDocumentLab,
        structuredRecords: renderStructuredRecords,
        recentSources: renderRecentSources,
        dataQuality: renderDataQuality,
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
            <h3 style="margin: 22px 0 8px; color: var(--bg-deep);">Structured data quality</h3>
            <div id="structuredQuality"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
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
            await renderStructuredQuality('structuredQuality');

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
            const [overview, quality, trend, audioArchive] = await Promise.all([
                api('/api/admin/advisor/health-overview'),
                api('/api/admin/advisor/quality-summary').catch(() => ({ summary: {} })),
                api('/api/admin/advisor/quality-trend?days=14').catch(() => ({ trend: [] })),
                api('/api/admin/audio-archive/stats').catch(e => ({ error: e.message, summary: {} }))
            ]);

            const metrics = overview.health?.metrics || {};
            const slo = metrics.slo || {};
            const providers = overview.health?.providers || {};
            const summary = quality.summary || overview.quality || {};
            const trendRows = trend.trend || [];
            const audio = audioArchive.summary || {};
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
                <h4 style="margin: 18px 0 8px; color: var(--bg-deep);">Common answer audio</h4>
                <div class="stat-row">
                    ${stat('Audio files', Number(audio.totalArchives || 0).toLocaleString())}
                    ${stat('Storage used', formatBytes(Number(audio.totalBytes || 0)))}
                    ${stat('Audio hits', Number(audio.totalHits || 0).toLocaleString())}
                    ${stat('FAQ audio coverage', `${Number(audio.verifiedCachedAnswersWithAudio || 0).toLocaleString()} / ${Number(audio.verifiedCachedAnswers || 0).toLocaleString()}`)}
                    ${stat('Last updated', audio.lastUpdatedAt ? formatDate(audio.lastUpdatedAt) : '—')}
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
                    <button class="btn btn-ghost" id="opsPrewarmAudio"><i class="fa-solid fa-volume-high"></i> Prewarm top 10 audio</button>
                    <button class="btn btn-ghost" id="opsExport"><i class="fa-solid fa-file-csv"></i> Export quality CSV</button>
                    <button class="btn btn-primary" id="opsTestAlert"><i class="fa-solid fa-bell"></i> Send test alert</button>
                </div>
                ${audioArchive.error ? `<p class="auth-error">Audio archive status unavailable: ${escapeHtml(audioArchive.error)}</p>` : ''}
                <h4 style="margin: 12px 0 8px; color: var(--bg-deep);">Quality trend (14 days)</h4>
                ${chart}
                ${trendHtml}
            `;

            document.getElementById('opsRefresh')?.addEventListener('click', () => renderDashboard());
            document.getElementById('opsPrewarmAudio')?.addEventListener('click', async () => {
                if (!confirm('Generate or reuse audio for the top 10 verified cached answers?')) return;
                const btn = document.getElementById('opsPrewarmAudio');
                if (btn) btn.disabled = true;
                try {
                    toast('Preparing common-answer audio...');
                    const result = await api('/api/admin/audio-archive/prewarm', {
                        method: 'POST',
                        body: { limit: 10, gender: 'female' }
                    });
                    toast(result.message || `Prepared ${result.prepared || 0} audio file(s)`);
                    await renderAdvisorOps(targetId);
                } catch (err) {
                    toast(err.message || 'Could not prewarm audio', 'error');
                } finally {
                    if (btn) btn.disabled = false;
                }
            });
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

    async function renderDataQuality() {
        main.innerHTML = `
            <h2>Data Quality</h2>
            <p class="lede">Structured data checks for facts Dr. Tari answers exactly: officers, courses, fees, programme requirements, cutoffs, registration rules, and calendar records.</p>
            <div id="dataQualityBody"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
        `;
        await renderStructuredQuality('dataQualityBody', { full: true });
    }

    function qualityStatusClass(status) {
        const value = String(status || '').toLowerCase();
        if (value === 'healthy') return 'badge-success';
        if (value === 'watch') return 'badge-warn';
        return 'badge-danger';
    }

    function qualityStatusLabel(status) {
        const value = String(status || '').toLowerCase();
        if (value === 'healthy') return 'Healthy';
        if (value === 'watch') return 'Watch';
        return 'Needs review';
    }

    function qualityActionHtml(action, fallbackLabel = 'Review') {
        if (!action) return '—';
        const label = action.label || fallbackLabel;
        if (action.section) {
            return `<button class="btn btn-ghost btn-sm" data-structured-quality-section="${escapeHtml(action.section)}"><i class="fa-solid fa-arrow-right"></i> ${escapeHtml(label)}</button>`;
        }
        if (action.table) {
            return `<button class="btn btn-ghost btn-sm" data-structured-quality-action="${escapeHtml(action.table)}" data-structured-quality-q="${escapeHtml(action.q || '')}"><i class="fa-solid fa-magnifying-glass"></i> ${escapeHtml(label)}</button>`;
        }
        return '—';
    }

    function renderQualityReadiness(readiness, data, options = {}) {
        const score = Math.round(Number(readiness?.score ?? 0));
        const status = String(readiness?.status || 'needs_review');
        const generatedAt = data?.generatedAt ? formatDate(data.generatedAt) : '—';
        const queueCount = Number(readiness?.pendingReviewCount || (readiness?.reviewQueue || []).length || 0);
        const recent = data?.recentFacts || {};
        const fullClass = options.full ? ' quality-hero--full' : '';
        return `
            <section class="quality-hero${fullClass}">
                <div class="quality-score-ring" style="--quality-score:${Math.max(0, Math.min(100, score))};" aria-label="Data readiness score ${escapeHtml(score)} percent">
                    <strong>${escapeHtml(score)}%</strong>
                    <span>ready</span>
                </div>
                <div class="quality-hero-copy">
                    <div class="quality-hero-title">
                        <h3>Structured fact readiness</h3>
                        <span class="badge ${qualityStatusClass(status)}">${escapeHtml(qualityStatusLabel(status))}</span>
                    </div>
                    <p>${escapeHtml(readiness?.summary || 'Structured data readiness is being calculated.')}</p>
                    <div class="quality-hero-meta">
                        <span><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(readiness?.highWarnings || 0)} high</span>
                        <span><i class="fa-solid fa-circle-info"></i> ${escapeHtml(readiness?.mediumWarnings || 0)} medium</span>
                        <span><i class="fa-solid fa-list-check"></i> ${escapeHtml(queueCount)} queued</span>
                        <span><i class="fa-solid fa-satellite-dish"></i> ${escapeHtml(recent.approvedCurrent || 0)} current recent facts</span>
                        <span><i class="fa-regular fa-clock"></i> ${escapeHtml(generatedAt)}</span>
                    </div>
                </div>
            </section>
        `;
    }

    function renderQualityHealthGrid(readiness, options = {}) {
        const cards = readiness?.categoryHealth || [];
        if (!cards.length) return '';
        const limit = options.full ? cards.length : Math.min(cards.length, 4);
        return `<div class="quality-health-grid">${cards.slice(0, limit).map(card => `
            <article class="quality-health-card quality-health-card--${escapeHtml(card.status || 'watch')}">
                <div>
                    <strong>${escapeHtml(card.label || 'Quality area')}</strong>
                    <span class="badge ${qualityStatusClass(card.status)}">${escapeHtml(card.score ?? 0)}%</span>
                </div>
                <p>${escapeHtml(card.message || '')}</p>
                ${qualityActionHtml(card.action, 'Open')}
            </article>
        `).join('')}</div>`;
    }

    function renderQualityReviewQueue(readiness, options = {}) {
        const rows = readiness?.reviewQueue || [];
        if (!rows.length) {
            return '<p class="empty">No priority data-review tasks are queued.</p>';
        }
        const limit = options.full ? rows.length : Math.min(rows.length, 6);
        return table(
            ['Priority', 'Severity', 'Area', 'Issue', 'Action'],
            rows.slice(0, limit).map(row => [
                escapeHtml(String(row.priority ?? '—')),
                `<span class="badge ${row.severity === 'high' ? 'badge-danger' : 'badge-warn'}">${escapeHtml(row.severity || 'medium')}</span>`,
                escapeHtml(row.area || '—'),
                escapeHtml(row.issue || '—'),
                qualityActionHtml(row.action, 'Review')
            ])
        );
    }

    async function renderStructuredQuality(targetId, options = {}) {
        const el = document.getElementById(targetId);
        if (!el) return;
        try {
            const full = !!options.full;
            const data = await api('/api/admin/structured-records/quality');
            const readiness = data.readiness || {};
            const warnings = data.warnings || [];
            const tableCounts = data.tableCounts || [];
            const courses = data.courses || {};
            const programmes = data.programmes || {};
            const officers = data.officers || {};
            const rules = data.rules || {};
            const recentFacts = data.recentFacts || {};
            const highWarnings = warnings.filter(item => item.severity === 'high').length;
            const mediumWarnings = warnings.filter(item => item.severity === 'medium').length;
            const tableSummary = tableCounts.length
                ? table(
                    ['Table', 'Active', 'Total'],
                    tableCounts.map(row => [
                        escapeHtml(row.label || row.table || '—'),
                        escapeHtml(String(row.active ?? 0)),
                        escapeHtml(String(row.total ?? 0))
                    ])
                )
                : '<p class="empty">No structured tables found.</p>';
            const warningRows = warnings.length
                ? table(
                    ['Severity', 'Area', 'Issue', 'Action'],
                    warnings.slice(0, full ? 60 : 20).map(row => [
                        `<span class="badge ${row.severity === 'high' ? 'badge-danger' : 'badge-warn'}">${escapeHtml(row.severity)}</span>`,
                        escapeHtml(row.area || '—'),
                        escapeHtml(row.message || '—'),
                        qualityActionHtml(row.action, row.action?.label || 'Review')
                    ])
                )
                : '<p class="empty">No obvious structured-data warnings detected.</p>';
            const unitConflictSamples = (courses.unitConflictSamples || []).slice(0, full ? 25 : 6);
            const unitConflictRows = unitConflictSamples.length
                ? table(
                    ['Programme', 'Course', 'Units', 'Rows', 'Action'],
                    unitConflictSamples.map(row => [
                        escapeHtml(`${row.programme || 'Unknown'} ${row.level_label || ''} ${row.semester_label || ''}`.trim()),
                        escapeHtml(`${row.course_code || ''} ${row.course_title || ''}`.trim()),
                        escapeHtml(row.credit_units || '—'),
                        escapeHtml(String(row.row_count || 0)),
                        `<button class="btn btn-ghost btn-sm" data-structured-quality-action="academic_courses" data-structured-quality-q="${escapeHtml(row.course_code || row.course_title || row.programme || '')}"><i class="fa-solid fa-magnifying-glass"></i> Review rows</button>`
                    ])
                )
                : '<p class="empty">No course unit conflicts detected.</p>';
            const programmeGapSamples = (programmes.gapSamples || []).slice(0, full ? 50 : 0);
            const programmeGapRows = programmeGapSamples.length
                ? table(
                    ['Programme', 'Gaps', 'Coverage', 'Linked names', 'Action'],
                    programmeGapSamples.map(row => {
                        const gaps = row.gaps || [];
                        const firstGap = gaps[0] || '';
                        const actionTable = firstGap.includes('courses')
                            ? 'academic_courses'
                            : (firstGap.includes('fees') ? 'academic_fees' : 'academic_rules');
                        const actionLabel = firstGap.includes('courses')
                            ? 'Open courses'
                            : (firstGap.includes('fees') ? 'Open fees' : 'Open requirements');
                        return [
                            escapeHtml(row.programme || '—'),
                            escapeHtml(gaps.join(', ') || '—'),
                            escapeHtml(`Courses ${row.courseCount || 0} · Fees ${row.feeCount || 0} · Requirements ${row.ruleCount || 0}`),
                            escapeHtml((row.linkedProgrammeNames || []).join(', ') || (row.programmeAliases || []).join(', ') || '—'),
                            `<button class="btn btn-ghost btn-sm" data-structured-quality-action="${escapeHtml(actionTable)}" data-structured-quality-q="${escapeHtml(row.programme || row.canonicalProgramme || '')}"><i class="fa-solid fa-magnifying-glass"></i> ${escapeHtml(actionLabel)}</button>`
                        ];
                    })
                )
                : '<p class="empty">No programme coverage gaps detected.</p>';
            const sourceLimitedSamples = (programmes.sourceLimitedSamples || []).slice(0, full ? 25 : 0);
            const sourceLimitedRows = sourceLimitedSamples.length
                ? table(
                    ['Programme', 'Status', 'Known sources', 'Coverage', 'Action'],
                    sourceLimitedSamples.map(row => [
                        escapeHtml(row.programme || '—'),
                        escapeHtml((row.programmeStatuses || []).join(', ') || row.programmeStatus || 'source limited'),
                        escapeHtml((row.sourcePaths || []).join('; ') || '—'),
                        escapeHtml(`Courses ${row.courseCount || 0} · Fees ${row.feeCount || 0} · Requirements ${row.ruleCount || 0}`),
                        `<button class="btn btn-ghost btn-sm" data-structured-quality-action="academic_programmes" data-structured-quality-q="${escapeHtml(row.programme || row.canonicalProgramme || '')}"><i class="fa-solid fa-magnifying-glass"></i> Open programme</button>`
                    ])
                )
                : '<p class="empty">No source-limited programme identities detected.</p>';
            const incompleteLevelSamples = (courses.incompleteLevelSamples || []).slice(0, full ? 50 : 0);
            const incompleteLevelRows = incompleteLevelSamples.length
                ? table(
                    ['Programme', 'Course records', 'Available levels', 'Action'],
                    incompleteLevelSamples.map(row => [
                        escapeHtml(row.programme || '—'),
                        escapeHtml(String(row.courseCount || 0)),
                        escapeHtml((row.levels || []).join(', ') || 'none'),
                        `<button class="btn btn-ghost btn-sm" data-structured-quality-action="academic_courses" data-structured-quality-q="${escapeHtml(row.programme || '')}"><i class="fa-solid fa-magnifying-glass"></i> Review courses</button>`
                    ])
                )
                : '<p class="empty">No likely incomplete course-level coverage detected.</p>';
            const invalidCodeSamples = (courses.invalidCodeSamples || []).slice(0, full ? 50 : 0);
            const invalidCodeRows = invalidCodeSamples.length
                ? table(
                    ['Programme', 'Level', 'Course code', 'Title', 'Source', 'Action'],
                    invalidCodeSamples.map(row => [
                        escapeHtml(row.programme || '—'),
                        escapeHtml(row.level_label || '—'),
                        escapeHtml(row.course_code || '—'),
                        escapeHtml(row.course_title || '—'),
                        escapeHtml(row.source_path || '—'),
                        `<button class="btn btn-ghost btn-sm" data-structured-quality-action="academic_courses" data-structured-quality-q="${escapeHtml(row.course_code || row.course_title || row.programme || '')}"><i class="fa-solid fa-magnifying-glass"></i> Review row</button>`
                    ])
                )
                : '<p class="empty">No invalid course code samples detected.</p>';
            const ruleSummary = (rules.categories || []).slice(0, 8).map(row =>
                `<span class="badge">${escapeHtml(row.category)}: ${escapeHtml(String(row.count || 0))}</span>`
            ).join('');

            el.innerHTML = `
                ${renderQualityReadiness(readiness, data, { full })}
                ${renderQualityHealthGrid(readiness, { full })}
                <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Priority review queue</h4>
                ${renderQualityReviewQueue(readiness, { full })}
                <div class="stat-row">
                    ${stat('High warnings', highWarnings)}
                    ${stat('Medium warnings', mediumWarnings)}
                    ${stat('Programmes with gaps', programmes.gapCount ?? 0)}
                    ${stat('Source-limited', programmes.sourceLimitedCount ?? 0)}
                    ${stat('Active course records', courses.activeCount ?? 0)}
                    ${stat('Course programmes', courses.programmeCount ?? 0)}
                    ${stat('Invalid code samples', courses.invalidCodeCount ?? 0)}
                    ${stat('Unit conflicts', courses.unitConflictCount ?? 0)}
                    ${stat('Critical officer gaps', (officers.missingCriticalRoles || []).length)}
                    ${stat('Pending recent facts', recentFacts.pending ?? 0)}
                    ${stat('Approved recent facts', recentFacts.approvedCurrent ?? recentFacts.approved ?? 0)}
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap; margin: 12px 0 16px;">
                    <button class="btn btn-ghost" id="structuredQualityRefresh"><i class="fa-solid fa-arrows-rotate"></i> Refresh data quality</button>
                    <button class="btn btn-primary" data-section-jump="structuredRecords"><i class="fa-solid fa-table-list"></i> Open structured facts</button>
                    ${ruleSummary}
                </div>
                <h4 style="margin: 12px 0 8px; color: var(--bg-deep);">Warnings to review</h4>
                ${warningRows}
                <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Course unit conflicts</h4>
                ${unitConflictRows}
                ${full ? `
                    <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Programme coverage gaps</h4>
                    ${programmeGapRows}
                    <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Source-limited programme identities</h4>
                    <p class="empty" style="margin-top:-2px;">These are not treated as quality failures. They identify programme names that are only present in a narrow source, such as a fee schedule, and need an authoritative programme/course source before Dr. Tari should answer detailed academic questions from them.</p>
                    ${sourceLimitedRows}
                    <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Likely incomplete course levels</h4>
                    ${incompleteLevelRows}
                    <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Invalid course code samples</h4>
                    ${invalidCodeRows}
                ` : ''}
                <h4 style="margin: 16px 0 8px; color: var(--bg-deep);">Structured table coverage</h4>
                ${tableSummary}
            `;
            document.getElementById('structuredQualityRefresh')?.addEventListener('click', () => renderStructuredQuality(targetId, options));
            el.querySelector('[data-section-jump="structuredRecords"]')?.addEventListener('click', () => {
                document.querySelector('[data-section="structuredRecords"]')?.click();
            });
            el.querySelectorAll('[data-structured-quality-section]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const section = btn.dataset.structuredQualitySection || '';
                    if (section) document.querySelector(`[data-section="${section}"]`)?.click();
                });
            });
            el.querySelectorAll('[data-structured-quality-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const tableName = btn.dataset.structuredQualityAction || '';
                    pendingStructuredRecordsView = {
                        table: tableName,
                        q: btn.dataset.structuredQualityQ || '',
                        status: tableName === 'bmu_recent_facts' ? 'pending' : 'active'
                    };
                    document.querySelector('[data-section="structuredRecords"]')?.click();
                });
            });
        } catch (err) {
            el.innerHTML = `<p class="auth-error">${escapeHtml(err.message || 'Could not load structured data quality')}</p>`;
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
                const feedbackNotes = String(it.feedback_notes || '').trim();
                const feedbackNotesHtml = feedbackNotes
                    ? `<details class="curate-a"><summary>Feedback notes</summary><pre>${escapeHtml(feedbackNotes)}</pre></details>`
                    : '';
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
                    ${feedbackNotesHtml}
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

    // ------------------------------------------------ BMU RECENT SOURCES
    async function renderRecentSources() {
        main.innerHTML = `
            <h2>BMU Recent Sources</h2>
            <p class="lede">Monitor approved BMU website and social pages for current public information. New facts remain pending until an admin approves them for advisor use.</p>
            <div class="admin-actions">
                <button class="btn btn-primary" id="recentCheckAllBtn"><i class="fa-solid fa-satellite-dish"></i> Check all sources</button>
                <button class="btn btn-ghost" id="recentRefreshBtn"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
                <button class="btn btn-ghost" id="recentOpenFactsBtn"><i class="fa-solid fa-table-list"></i> Open fact table</button>
                <button class="btn btn-ghost" id="recentOpenSourcesBtn"><i class="fa-solid fa-database"></i> Open source table</button>
            </div>
            <div class="recent-review-path">
                <strong>Where extracted items appear:</strong>
                <span>Admin → Recent Sources → Detected recent facts. Newly extracted facts are pending until approved or rejected here.</span>
            </div>
            <details class="recent-paste-panel" open>
                <summary><i class="fa-solid fa-paste"></i> Paste official BMU notice for extraction</summary>
                <div class="recent-paste-grid">
                    <label>Source
                        <select id="recentPasteSource" class="input">
                            <option value="">Manual BMU notice</option>
                        </select>
                    </label>
                    <label>Notice title
                        <input id="recentPasteTitle" class="input" placeholder="BMU 2026/2027 admissions cut-off marks" />
                    </label>
                    <label class="recent-paste-wide">Source URL, if available
                        <input id="recentPasteUrl" class="input" placeholder="https://bmu.edu.ng/..." />
                    </label>
                    <label class="recent-paste-wide">Notice text
                        <textarea id="recentPasteText" class="input" placeholder="Paste the official BMU notice, social caption, website text, or circular here."></textarea>
                    </label>
                    <div class="recent-paste-wide recent-paste-actions">
                        <button class="btn btn-primary" id="recentPasteExtractBtn" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Extract pending facts</button>
                        <span id="recentPasteResult" class="lede"></span>
                    </div>
                </div>
            </details>
            <div id="recentSourceStats" class="stat-row"></div>
            <div id="recentSourceList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading sources…</div></div>
            <h3 style="margin:22px 0 8px;color:var(--bg-deep);">Detected recent facts</h3>
            <p class="lede">Review candidate facts carefully before approval. Approved current facts are used for high-risk answers about admissions, fees, cutoffs, registration, deadlines and calendar changes.</p>
            <div id="recentFactsList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading facts…</div></div>
            <dialog id="recentFactReviewDialog" class="modal modal--wide recent-fact-review-dialog"></dialog>
        `;
        document.getElementById('recentRefreshBtn')?.addEventListener('click', loadRecentSources);
        document.getElementById('recentCheckAllBtn')?.addEventListener('click', async (ev) => {
            ev.currentTarget.disabled = true;
            try {
                toast('Checking BMU sources. Social pages may block automated access.');
                const r = await api('/api/admin/recent-sources/check', { method: 'POST', body: {} });
                toast(`Checked ${r.checked || 0} source(s); detected ${r.detected || 0} candidate fact(s).`);
                await loadRecentSources();
            } catch (err) {
                toast(err.message || 'Could not check recent sources', 'error');
            } finally {
                ev.currentTarget.disabled = false;
            }
        });
        document.getElementById('recentOpenFactsBtn')?.addEventListener('click', () => {
            pendingStructuredRecordsView = { table: 'bmu_recent_facts', status: 'pending' };
            document.querySelector('[data-section="structuredRecords"]')?.click();
        });
        document.getElementById('recentOpenSourcesBtn')?.addEventListener('click', () => {
            pendingStructuredRecordsView = { table: 'bmu_recent_sources', status: '' };
            document.querySelector('[data-section="structuredRecords"]')?.click();
        });
        document.getElementById('recentPasteExtractBtn')?.addEventListener('click', handleRecentPasteIngest);
        await loadRecentSources();
    }

    async function loadRecentSources() {
        try {
            const data = await api('/api/admin/recent-sources/summary');
            const sources = data.sources || [];
            const facts = data.facts || [];
            latestRecentFacts = facts;
            const pending = facts.filter(f => f.status === 'pending').length;
            const approved = facts.filter(f => f.status === 'approved').length;
            const lastChecked = sources
                .map(s => s.last_checked_at)
                .filter(Boolean)
                .sort()
                .pop();
            document.getElementById('recentSourceStats').innerHTML = [
                stat('Sources', sources.length),
                stat('Pending facts', pending),
                stat('Approved facts', approved),
                stat('Last check', lastChecked ? formatDate(lastChecked) : '—')
            ].join('');
            renderRecentPasteSourceOptions(sources);
            document.getElementById('recentSourceList').innerHTML = renderRecentSourceCards(sources);
            document.getElementById('recentFactsList').innerHTML = renderRecentFactsTable(facts);
            document.getElementById('recentSourceList').onclick = handleRecentSourceClick;
            document.getElementById('recentFactsList').onclick = handleRecentFactClick;
        } catch (err) {
            document.getElementById('recentSourceList').innerHTML = `<p class="auth-error">${escapeHtml(err.message || 'Could not load recent sources')}</p>`;
            document.getElementById('recentFactsList').innerHTML = '';
        }
    }

    function renderRecentPasteSourceOptions(sources) {
        const select = document.getElementById('recentPasteSource');
        if (!select) return;
        const current = select.value;
        select.innerHTML = [
            '<option value="">Manual BMU notice</option>',
            ...sources.map(source => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.source_name || source.source_url || 'BMU source')}</option>`)
        ].join('');
        if ([...select.options].some(option => option.value === current)) select.value = current;
    }

    async function handleRecentPasteIngest(ev) {
        const btn = ev?.currentTarget;
        const resultEl = document.getElementById('recentPasteResult');
        const sourceId = document.getElementById('recentPasteSource')?.value || '';
        const title = document.getElementById('recentPasteTitle')?.value || '';
        const sourceUrl = document.getElementById('recentPasteUrl')?.value || '';
        const text = document.getElementById('recentPasteText')?.value || '';
        if (text.trim().length < 40) {
            toast('Paste more BMU notice text before extraction', 'error');
            return;
        }
        if (btn) btn.disabled = true;
        if (resultEl) resultEl.textContent = 'Extracting candidate facts…';
        try {
            const r = await api('/api/admin/recent-sources/ingest-text', {
                method: 'POST',
                body: {
                    sourceId: sourceId ? Number(sourceId) : null,
                    title,
                    sourceUrl,
                    text
                }
            });
            const message = `Detected ${r.detected || 0}; new ${r.inserted || 0}; refreshed ${r.updated || 0}. Review below before approval.`;
            if (resultEl) resultEl.textContent = message;
            toast(message);
            await loadRecentSources();
        } catch (err) {
            if (resultEl) resultEl.textContent = '';
            toast(err.message || 'Could not extract recent facts', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function renderRecentSourceCards(sources) {
        if (!sources.length) return '<p class="empty">No BMU recent sources configured.</p>';
        return `<div class="topic-tiles">${sources.map(source => `
            <article class="topic-tile">
                <span class="badge ${source.last_status === 'ok' ? 'badge-success' : source.last_status === 'error' ? 'badge-danger' : 'badge-info'}">${escapeHtml(source.last_status || 'not checked')}</span>
                <h3>${escapeHtml(source.source_name || 'BMU source')}</h3>
                <p>${escapeHtml(source.source_type || 'website')} · rank ${escapeHtml(source.source_rank ?? '—')} · every ${escapeHtml(source.check_frequency_hours || 24)}h</p>
                <p class="lede">${escapeHtml(source.last_error || source.source_url || '')}</p>
                <div class="admin-actions" style="margin-top:10px;">
                    <button class="btn btn-primary btn-sm" data-recent-source-check="${escapeHtml(source.id)}"><i class="fa-solid fa-arrows-rotate"></i> Check</button>
                    <a class="btn btn-ghost btn-sm" href="${escapeHtml(source.source_url || '#')}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> Open</a>
                </div>
            </article>
        `).join('')}</div>`;
    }

    function renderRecentFactsTable(facts) {
        if (!facts.length) return '<p class="empty">No recent facts detected yet. Click “Check all sources”, or paste an official BMU notice above and extract it.</p>';
        const rows = facts.map(fact => [
            `<span class="badge ${fact.status === 'approved' ? 'badge-success' : fact.status === 'rejected' ? 'badge-danger' : fact.status === 'pending' ? 'badge-warn' : 'badge-info'}">${escapeHtml(fact.status || 'pending')}</span>`,
            `<div><strong>${escapeHtml(fact.title || 'Recent BMU fact')}</strong><div style="color:var(--muted);font-size:.82rem;">${escapeHtml(fact.category || 'general')} · ${escapeHtml(fact.session_label || fact.detected_date_label || 'recent')}${fact.expires_at ? ` · expires ${escapeHtml(formatDate(fact.expires_at))}` : ''}${Number(fact.structured_suggestion_count || 0) ? ` · ${escapeHtml(fact.structured_suggestion_count)} structured suggestion(s)` : ''}</div></div>`,
            escapeHtml((fact.fact_text || '').length > 260 ? fact.fact_text.slice(0, 257) + '...' : fact.fact_text || ''),
            escapeHtml(fact.source_name || fact.source_type || '—'),
            `<div class="admin-actions">
                <button class="btn btn-ghost btn-sm" data-recent-fact-review="${escapeHtml(fact.id)}"><i class="fa-solid fa-eye"></i> Review</button>
                ${fact.status !== 'approved' ? `<button class="btn btn-primary btn-sm" data-recent-fact-status="approved" data-id="${escapeHtml(fact.id)}"><i class="fa-solid fa-check"></i> Approve</button>` : ''}
                ${fact.status !== 'rejected' ? `<button class="btn btn-ghost btn-sm" data-recent-fact-status="rejected" data-id="${escapeHtml(fact.id)}"><i class="fa-solid fa-ban"></i> Reject</button>` : ''}
                <a class="btn btn-ghost btn-sm" href="${escapeHtml(fact.source_url || '#')}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i></a>
            </div>`
        ]);
        return table(['Status', 'Title', 'Detected text', 'Source', 'Actions'], rows);
    }

    async function handleRecentSourceClick(ev) {
        const btn = ev.target.closest('[data-recent-source-check]');
        if (!btn) return;
        const sourceId = parseInt(btn.dataset.recentSourceCheck, 10);
        btn.disabled = true;
        try {
            const r = await api('/api/admin/recent-sources/check', { method: 'POST', body: { sourceId } });
            toast(`Checked source; detected ${r.detected || 0} candidate fact(s).`);
            await loadRecentSources();
        } catch (err) {
            toast(err.message || 'Could not check source', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    async function handleRecentFactClick(ev) {
        const reviewBtn = ev.target.closest('[data-recent-fact-review]');
        if (reviewBtn) {
            const id = parseInt(reviewBtn.dataset.recentFactReview, 10);
            const fact = latestRecentFacts.find(item => Number(item.id) === id);
            if (fact) openRecentFactReviewDialog(fact);
            return;
        }
        const btn = ev.target.closest('[data-recent-fact-status]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id, 10);
        const status = btn.dataset.recentFactStatus;
        btn.disabled = true;
        try {
            await api(`/api/admin/recent-facts/${id}/status`, { method: 'POST', body: { status } });
            toast(status === 'approved' ? 'Recent fact approved for advisor use' : 'Recent fact rejected');
            await loadRecentSources();
        } catch (err) {
            toast(err.message || 'Could not update recent fact', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    function recentFactRiskLabel(fact) {
        const text = `${fact.category || ''} ${fact.title || ''} ${fact.fact_text || ''}`.toLowerCase();
        if (/\b(fee|fees|tuition|cut[- ]?off|admission|eligibility|registration|deadline|calendar|exam|graduation|probation|withdrawal)\b/.test(text)) {
            return 'High-risk current fact';
        }
        return 'General current fact';
    }

    function openRecentFactReviewDialog(fact) {
        const dialog = document.getElementById('recentFactReviewDialog');
        if (!dialog) return;
        const risk = recentFactRiskLabel(fact);
        const statusClass = fact.status === 'approved' ? 'badge-success' : fact.status === 'rejected' ? 'badge-danger' : 'badge-info';
        dialog.innerHTML = `
            <form method="dialog" class="recent-fact-review-form">
                <div class="modal-head">
                    <div>
                        <h2><i class="fa-solid fa-satellite-dish"></i> Review BMU recent fact</h2>
                        <p class="lede">Approve only if the wording is accurate, current, and traceable to the source below.</p>
                    </div>
                    <button class="icon-btn" type="button" data-recent-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="recent-fact-review-grid">
                    <section>
                        <span class="badge ${statusClass}">${escapeHtml(fact.status || 'pending')}</span>
                        <span class="badge badge-info">${escapeHtml(risk)}</span>
                        <h3>${escapeHtml(fact.title || 'Recent BMU fact')}</h3>
                        <p>${escapeHtml(fact.fact_text || '')}</p>
                    </section>
                    <aside>
                        <dl>
                            <dt>Source</dt><dd>${escapeHtml(fact.source_name || fact.source_type || 'BMU source')}</dd>
                            <dt>Category</dt><dd>${escapeHtml(fact.category || 'general')}</dd>
                            <dt>Session/date</dt><dd>${escapeHtml(fact.session_label || fact.detected_date_label || 'recent')}</dd>
                            <dt>Currentness</dt><dd>${escapeHtml(fact.currentness_label || 'recent')}</dd>
                            <dt>Expires</dt><dd>${escapeHtml(fact.expires_at ? formatDate(fact.expires_at) : 'Not set')}</dd>
                            <dt>Programme</dt><dd>${escapeHtml(fact.programme || 'All / not specified')}</dd>
                            <dt>Authority</dt><dd>${escapeHtml(fact.authority_type || 'recent')} · rank ${escapeHtml(fact.authority_rank ?? '—')}</dd>
                            <dt>Confidence</dt><dd>${escapeHtml(fact.confidence ?? '—')}</dd>
                        </dl>
                    </aside>
                </div>
                <section class="recent-structured-suggestions" id="recentStructuredSuggestions">
                    <div class="recent-structured-head">
                        <div>
                            <h3><i class="fa-solid fa-table-list"></i> Structured record suggestions</h3>
                            <p class="lede">Promote high-risk facts here so the advisor can answer from exact lookup tables.</p>
                        </div>
                        <button class="btn btn-primary btn-sm" type="button" data-recent-promote-all style="display:none;"><i class="fa-solid fa-layer-group"></i> Promote all</button>
                    </div>
                    <div id="recentStructuredSuggestionList"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Checking for structured rows...</div></div>
                </section>
                <menu>
                    <button class="btn btn-ghost" type="button" data-recent-dialog-close>Close</button>
                    <button class="btn btn-ghost" type="button" data-recent-open-structured><i class="fa-solid fa-table-list"></i> Edit row</button>
                    ${fact.status !== 'rejected' ? '<button class="btn btn-ghost" type="button" data-recent-review-status="rejected"><i class="fa-solid fa-ban"></i> Reject</button>' : ''}
                    ${fact.status !== 'approved' ? '<button class="btn btn-primary" type="button" data-recent-review-status="approved"><i class="fa-solid fa-check"></i> Approve</button>' : ''}
                </menu>
            </form>
        `;
        dialog.querySelectorAll('[data-recent-dialog-close]').forEach(btn => btn.addEventListener('click', () => dialog.close()));
        dialog.querySelector('[data-recent-open-structured]')?.addEventListener('click', () => {
            dialog.close();
            pendingStructuredRecordsView = {
                table: 'bmu_recent_facts',
                status: 'pending',
                q: fact.title || fact.fact_text || String(fact.id)
            };
            document.querySelector('[data-section="structuredRecords"]')?.click();
        });
        dialog.querySelectorAll('[data-recent-review-status]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const status = btn.dataset.recentReviewStatus;
                btn.disabled = true;
                try {
                    await api(`/api/admin/recent-facts/${encodeURIComponent(fact.id)}/status`, { method: 'POST', body: { status } });
                    toast(status === 'approved' ? 'Recent fact approved for advisor use' : 'Recent fact rejected');
                    dialog.close();
                    await loadRecentSources();
                } catch (err) {
                    toast(err.message || 'Could not update recent fact', 'error');
                    btn.disabled = false;
                }
            });
        });
        loadRecentFactStructuredSuggestions(fact.id, dialog);
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', 'open');
    }

    async function loadRecentFactStructuredSuggestions(factId, dialog) {
        const list = dialog.querySelector('#recentStructuredSuggestionList');
        const promoteAll = dialog.querySelector('[data-recent-promote-all]');
        if (!list) return;
        try {
            const r = await api(`/api/admin/recent-facts/${encodeURIComponent(factId)}/structured-suggestions`);
            const suggestions = r.suggestions || [];
            list.innerHTML = renderRecentStructuredSuggestions(suggestions);
            if (promoteAll) {
                promoteAll.style.display = suggestions.length > 1 ? '' : 'none';
                promoteAll.onclick = () => promoteRecentStructuredSuggestion(factId, null, true, promoteAll, dialog);
            }
            list.onclick = async ev => {
                const promoteBtn = ev.target.closest('[data-recent-promote-suggestion]');
                if (promoteBtn) {
                    await promoteRecentStructuredSuggestion(factId, promoteBtn.dataset.recentPromoteSuggestion, false, promoteBtn, dialog);
                    return;
                }
                const tableBtn = ev.target.closest('[data-recent-open-suggestion-table]');
                if (tableBtn) {
                    dialog.close();
                    pendingStructuredRecordsView = {
                        table: tableBtn.dataset.recentOpenSuggestionTable,
                        status: 'active',
                        q: tableBtn.dataset.recentSuggestionQuery || ''
                    };
                    document.querySelector('[data-section="structuredRecords"]')?.click();
                }
            };
        } catch (err) {
            list.innerHTML = `<p class="auth-error">${escapeHtml(err.message || 'Could not load structured suggestions')}</p>`;
            if (promoteAll) promoteAll.style.display = 'none';
        }
    }

    function renderRecentStructuredSuggestions(suggestions) {
        if (!suggestions.length) {
            return '<p class="empty">No structured rows were detected from this fact. Use Edit row for manual correction, or keep it as an approved recent text fact.</p>';
        }
        return `<div class="recent-structured-list">${suggestions.map(suggestion => {
            const record = suggestion.record || {};
            const query = record.programme || record.requirement_type || suggestion.title || '';
            return `
                <article class="recent-structured-card">
                    <div class="recent-structured-card-head">
                        <div>
                            <span class="badge badge-info">${escapeHtml(suggestion.tableLabel || suggestion.table)}</span>
                            <h4>${escapeHtml(suggestion.title || 'Structured suggestion')}</h4>
                        </div>
                        <span class="badge ${Number(suggestion.confidence || 0) >= 0.9 ? 'badge-success' : 'badge-warn'}">${escapeHtml(Math.round(Number(suggestion.confidence || 0) * 100))}%</span>
                    </div>
                    <p>${escapeHtml(suggestion.summary || '')}</p>
                    ${renderRecentSuggestionFields(record)}
                    ${(suggestion.reviewNotes || []).length ? `<ul class="recent-structured-notes">${suggestion.reviewNotes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}
                    <div class="admin-actions">
                        <button class="btn btn-primary btn-sm" type="button" data-recent-promote-suggestion="${escapeHtml(suggestion.index)}"><i class="fa-solid fa-check-double"></i> Promote row</button>
                        <button class="btn btn-ghost btn-sm" type="button" data-recent-open-suggestion-table="${escapeHtml(suggestion.table)}" data-recent-suggestion-query="${escapeHtml(query)}"><i class="fa-solid fa-table"></i> Open table</button>
                    </div>
                </article>
            `;
        }).join('')}</div>`;
    }

    function renderRecentSuggestionFields(record) {
        const priority = [
            'programme', 'admission_cycle', 'entry_mode', 'merit_cutoff', 'cutoff_label',
            'student_category', 'session_label', 'requirement_type', 'requirement_text',
            'eligibility_text', 'application_process', 'contact_text', 'portal_url', 'source_path'
        ];
        const fields = priority
            .filter(key => record[key] !== undefined && record[key] !== null && String(record[key]).trim())
            .slice(0, 8);
        if (!fields.length) return '';
        return `<dl class="recent-structured-fields">${fields.map(key => `
            <dt>${escapeHtml(structuredFieldLabel(key))}</dt>
            <dd>${escapeHtml(String(record[key]).length > 260 ? String(record[key]).slice(0, 257) + '...' : record[key])}</dd>
        `).join('')}</dl>`;
    }

    async function promoteRecentStructuredSuggestion(factId, suggestionIndex, all, btn, dialog) {
        if (btn) btn.disabled = true;
        try {
            const r = await api(`/api/admin/recent-facts/${encodeURIComponent(factId)}/promote-structured`, {
                method: 'POST',
                body: all ? { all: true } : { suggestionIndex: Number(suggestionIndex) }
            });
            toast(`Promoted ${r.promotedCount || 0} structured record(s)`);
            await loadRecentSources();
            await loadRecentFactStructuredSuggestions(factId, dialog);
        } catch (err) {
            toast(err.message || 'Could not promote structured record', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ------------------------------------------------ STRUCTURED RECORDS
    async function renderStructuredRecords() {
        const initialView = pendingStructuredRecordsView;
        pendingStructuredRecordsView = null;
        main.innerHTML = `
            <h2>Structured Facts</h2>
            <p class="lede">Direct production lookup tables for exact advisor answers. Use this for corrected officers, fees, courses, programme rules, calendar dates, and approved facts.</p>
            <div class="structured-quick-nav" aria-label="Common structured fact categories">
                <button class="structured-quick-card" type="button" data-structured-quick="academic_programmes"><i class="fa-solid fa-graduation-cap"></i><span>Programmes</span><small>Identity, departments, duration</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_rules"><i class="fa-solid fa-list-check"></i><span>Requirements</span><small>Admission, graduation, rules</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_fees"><i class="fa-solid fa-money-bill-wave"></i><span>Fees</span><small>Programme totals and categories</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_courses"><i class="fa-solid fa-book"></i><span>Courses</span><small>Programme, level, semester</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_officers"><i class="fa-solid fa-user-tie"></i><span>Officers</span><small>Current office holders</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_admission_cutoffs"><i class="fa-solid fa-ranking-star"></i><span>Cutoffs</span><small>Admission cycle marks</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_registration_requirements"><i class="fa-solid fa-clipboard-list"></i><span>Registration</span><small>New and returning students</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="academic_calendar_events"><i class="fa-solid fa-calendar-days"></i><span>Calendar</span><small>Dates and deadlines</small></button>
                <button class="structured-quick-card" type="button" data-structured-quick="bmu_recent_facts"><i class="fa-solid fa-satellite-dish"></i><span>Recent</span><small>Pending/approved notices</small></button>
            </div>
            <div class="admin-actions">
                <label>Table
                    <select id="structuredTableSelect" class="input"></select>
                </label>
                <label>Search
                    <input id="structuredSearchInput" class="input" placeholder="programme, officer, course code, source..." />
                </label>
                <button class="btn btn-ghost" id="structuredClearSearchBtn" type="button"><i class="fa-solid fa-xmark"></i> Clear search</button>
                <label>Status
                    <select id="structuredStatusFilter" class="input"></select>
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
                <label>Rows
                    <select id="structuredPageSizeSelect" class="input">
                        <option value="60">60</option>
                        <option value="120" selected>120</option>
                        <option value="240">240</option>
                        <option value="300">300</option>
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
            <div id="structuredWorkflowGuide"></div>
            <div id="structuredImportResult"></div>
            <div id="structuredRecordsBody"><div class="loading"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
            <div id="structuredPagination" class="admin-actions structured-pagination"></div>
            <dialog id="structuredEditDialog" class="modal modal--wide structured-edit-dialog"></dialog>
        `;

        let tables = [];
        let currentTable = '';
        let currentRecords = [];
        let currentTableInfo = null;
        let currentOffset = 0;
        let pageSize = 120;
        let searchTimer = null;
        try {
            const r = await api('/api/admin/structured-records/tables');
            tables = r.tables || [];
            const select = document.getElementById('structuredTableSelect');
            select.innerHTML = tables.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.label)} (${escapeHtml(t.count)})</option>`).join('');
            currentTable = initialView?.table && tables.some(t => t.name === initialView.table)
                ? initialView.table
                : tables[0]?.name || '';
            select.value = currentTable;
            syncStructuredStatusFilter(Object.prototype.hasOwnProperty.call(initialView || {}, 'status') ? initialView.status : undefined);
            if (initialView?.q) {
                const searchInput = document.getElementById('structuredSearchInput');
                if (searchInput) searchInput.value = initialView.q;
            }
            syncStructuredQuickNav();

            select.addEventListener('change', () => {
                currentTable = select.value;
                currentOffset = 0;
                const ruleFilter = document.getElementById('structuredRuleCategoryFilter');
                if (ruleFilter) ruleFilter.value = '';
                syncStructuredStatusFilter();
                syncStructuredQuickNav();
                loadStructuredRecords();
            });
            document.querySelectorAll('[data-structured-quick]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const table = btn.dataset.structuredQuick;
                    if (!tables.some(t => t.name === table)) return;
                    currentTable = table;
                    select.value = table;
                    currentOffset = 0;
                    const ruleFilter = document.getElementById('structuredRuleCategoryFilter');
                    if (ruleFilter) ruleFilter.value = '';
                    syncStructuredStatusFilter();
                    syncStructuredQuickNav();
                    loadStructuredRecords();
                });
            });
            document.getElementById('structuredRefreshBtn')?.addEventListener('click', loadStructuredRecords);
            document.getElementById('structuredStatusFilter')?.addEventListener('change', () => {
                currentOffset = 0;
                loadStructuredRecords();
            });
            document.getElementById('structuredRuleCategoryFilter')?.addEventListener('change', () => {
                currentOffset = 0;
                loadStructuredRecords();
            });
            document.getElementById('structuredPageSizeSelect')?.addEventListener('change', e => {
                pageSize = Math.max(1, Math.min(300, parseInt(e.target.value, 10) || 120));
                currentOffset = 0;
                loadStructuredRecords();
            });
            document.getElementById('structuredAddBtn')?.addEventListener('click', () => {
                if (!currentTable || !currentTableInfo) return;
                openStructuredRecordDialog(currentTable, currentTableInfo, createBlankStructuredRecord(currentTableInfo), loadStructuredRecords, { isNew: true });
            });
            const searchInput = document.getElementById('structuredSearchInput');
            searchInput?.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    currentOffset = 0;
                    loadStructuredRecords();
                }, 350);
            });
            searchInput?.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    clearTimeout(searchTimer);
                    currentOffset = 0;
                    loadStructuredRecords();
                } else if (e.key === 'Escape') {
                    e.currentTarget.value = '';
                    clearTimeout(searchTimer);
                    currentOffset = 0;
                    loadStructuredRecords();
                }
            });
            document.getElementById('structuredClearSearchBtn')?.addEventListener('click', () => {
                const input = document.getElementById('structuredSearchInput');
                if (input) input.value = '';
                clearTimeout(searchTimer);
                currentOffset = 0;
                loadStructuredRecords();
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
            syncStructuredQuickNav();
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
            const guide = document.getElementById('structuredWorkflowGuide');
            if (guide) guide.innerHTML = renderStructuredWorkflowGuide(currentTable, info);
            document.getElementById('structuredRecordsBody').innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading records…</div>';
            try {
                const params = new URLSearchParams({ limit: String(pageSize), offset: String(currentOffset) });
                if (q) params.set('q', q);
                if (status) params.set('status', status);
                if (currentTable === 'academic_rules' && requirementCategory) params.set('requirement_category', requirementCategory);
                const r = await api(`/api/admin/structured-records/${encodeURIComponent(currentTable)}?${params.toString()}`);
                const records = r.records || [];
                const tableInfo = r.table || info;
                const pagination = r.pagination || { offset: currentOffset, limit: pageSize, total: records.length, returned: records.length };
                currentRecords = records;
                currentTableInfo = tableInfo;
                document.getElementById('structuredTableInfo').innerHTML = [
                    stat('Selected table', tableInfo.label || currentTable),
                    stat('Showing', structuredPaginationRange(pagination)),
                    stat('Total matched', pagination.total ?? records.length),
                    stat('Required', (tableInfo.required || []).join(', ') || '—')
                ].join('');
                if (guide) guide.innerHTML = renderStructuredWorkflowGuide(currentTable, tableInfo);
                document.getElementById('structuredRecordsBody').innerHTML = records.length
                    ? renderStructuredRecordsGrid(tableInfo, records)
                    : `<p class="empty">${escapeHtml(q || status || requirementCategory ? 'No records found for the current search and filters.' : 'No records found. Download the template and import new records.')}</p>`;
                document.getElementById('structuredRecordsBody').onclick = handleStructuredRecordClick;
                renderStructuredPagination(pagination);
            } catch (err) {
                document.getElementById('structuredRecordsBody').innerHTML = `<p class="auth-error">${escapeHtml(err.message)}</p>`;
                document.getElementById('structuredPagination').innerHTML = '';
            }
        }

        function syncStructuredQuickNav() {
            document.querySelectorAll('[data-structured-quick]').forEach(btn => {
                const exists = tables.some(t => t.name === btn.dataset.structuredQuick);
                btn.disabled = !exists;
                btn.classList.toggle('active', btn.dataset.structuredQuick === currentTable);
            });
        }

        function structuredStatusOptions(tableName) {
            if (tableName === 'bmu_recent_facts') {
                return [
                    { value: '', label: 'Any status' },
                    { value: 'pending', label: 'Pending review' },
                    { value: 'approved', label: 'Approved' },
                    { value: 'rejected', label: 'Rejected' },
                    { value: 'inactive', label: 'Archived' }
                ];
            }
            if (tableName === 'bmu_recent_sources') {
                return [
                    { value: '', label: 'Any status' },
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Archived' }
                ];
            }
            return [
                { value: '', label: 'Any status' },
                { value: 'active', label: 'Active' },
                { value: 'draft', label: 'Draft' },
                { value: 'inactive', label: 'Archived' }
            ];
        }

        function structuredDefaultStatus(tableName) {
            return tableName === 'bmu_recent_facts' ? 'pending' : 'active';
        }

        function syncStructuredStatusFilter(preferredStatus) {
            const filter = document.getElementById('structuredStatusFilter');
            if (!filter) return;
            const options = structuredStatusOptions(currentTable);
            const previous = preferredStatus !== undefined ? String(preferredStatus || '') : String(filter.value || '');
            filter.innerHTML = options
                .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
                .join('');
            const fallback = structuredDefaultStatus(currentTable);
            filter.value = options.some(option => option.value === previous)
                ? previous
                : (options.some(option => option.value === fallback) ? fallback : '');
        }

        function structuredPaginationRange(pagination) {
            const total = Number(pagination.total || 0);
            if (!total) return '0';
            const start = Number(pagination.offset || 0) + 1;
            const end = Math.min(total, Number(pagination.offset || 0) + Number(pagination.returned || 0));
            return `${start}-${end}`;
        }

        function renderStructuredPagination(pagination = {}) {
            const holder = document.getElementById('structuredPagination');
            if (!holder) return;
            const total = Number(pagination.total || 0);
            const offset = Number(pagination.offset || 0);
            const limit = Number(pagination.limit || pageSize);
            const hasPrevious = offset > 0;
            const hasNext = offset + Number(pagination.returned || 0) < total;
            const lastOffset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
            holder.innerHTML = total > limit ? `
                <button class="btn btn-ghost" id="structuredFirstPageBtn" ${hasPrevious ? '' : 'disabled'}><i class="fa-solid fa-angles-left"></i> First</button>
                <button class="btn btn-ghost" id="structuredPrevPageBtn" ${hasPrevious ? '' : 'disabled'}><i class="fa-solid fa-chevron-left"></i> Previous</button>
                <span class="lede">Showing ${escapeHtml(structuredPaginationRange(pagination))} of ${escapeHtml(total)}</span>
                <button class="btn btn-ghost" id="structuredNextPageBtn" ${hasNext ? '' : 'disabled'}>Next <i class="fa-solid fa-chevron-right"></i></button>
                <button class="btn btn-ghost" id="structuredLastPageBtn" ${hasNext ? '' : 'disabled'}>Last <i class="fa-solid fa-angles-right"></i></button>
            ` : '';
            document.getElementById('structuredFirstPageBtn')?.addEventListener('click', () => {
                currentOffset = 0;
                loadStructuredRecords();
            });
            document.getElementById('structuredPrevPageBtn')?.addEventListener('click', () => {
                currentOffset = Math.max(0, currentOffset - limit);
                loadStructuredRecords();
            });
            document.getElementById('structuredNextPageBtn')?.addEventListener('click', () => {
                currentOffset += limit;
                loadStructuredRecords();
            });
            document.getElementById('structuredLastPageBtn')?.addEventListener('click', () => {
                currentOffset = lastOffset;
                loadStructuredRecords();
            });
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

        function renderStructuredWorkflowGuide(tableName, tableInfo = {}) {
            const guides = {
                academic_programmes: {
                    title: 'Programme identity workflow',
                    checks: ['Confirm programme name, faculty/college, department, degree and entry modes.', 'Keep admission and graduation rules in Programme requirements, not in the identity row.', 'Set status to active only for currently offered programmes.']
                },
                academic_rules: {
                    title: 'Programme requirements workflow',
                    checks: ['Use one row per admission, graduation, progression, examination or transfer rule.', 'Choose the requirement category first; source and currentness stay in Advanced fields.', 'For high-risk rules, preserve the exact approved wording in Requirement text.']
                },
                academic_fees: {
                    title: 'Fees workflow',
                    checks: ['Use one row per programme, session, level/category and student category.', 'Enter the human amount and the numeric amount when known.', 'Do not mark fees active without a source document or approved notice.']
                },
                academic_courses: {
                    title: 'Courses workflow',
                    checks: ['Use one row per course, programme, level and semester.', 'Keep course code, title and credit units exactly as BMU source documents state them.', 'Archive duplicate or invalid source rows instead of editing unrelated programmes.']
                },
                academic_officers: {
                    title: 'Officers workflow',
                    checks: ['Use one row per office or role.', 'For vacant roles, leave the officer name blank and state the vacancy in exact wording.', 'Use profile/source notes for aliases such as Pro-Chancellor and Chairman of Governing Council.']
                },
                academic_admission_cutoffs: {
                    title: 'Admission cutoffs workflow',
                    checks: ['Use one row per programme and admission cycle.', 'Cutoff marks are session-specific; confirm the year before activating.', 'Expired cycles should be superseded or inactive, not deleted.']
                },
                academic_registration_requirements: {
                    title: 'Registration workflow',
                    checks: ['Use one row per student group, session/semester and requirement type.', 'Separate new-student application steps from returning-student semester registration.', 'Add deadlines and portal URLs when BMU publishes them.']
                },
                academic_calendar_events: {
                    title: 'Calendar workflow',
                    checks: ['Use one row per event or date range.', 'Keep session labels explicit and avoid mixing old and current calendars.', 'Prefer approved BMU calendar notices for deadlines.']
                },
                bmu_recent_facts: {
                    title: 'Recent-source review workflow',
                    checks: ['Approve only facts that are accurate, current and traceable to BMU sources.', 'Promote cutoffs, registration and other high-risk facts into structured tables.', 'Set or confirm Review expiry so time-sensitive facts stop being definitive when stale.']
                },
                bmu_recent_sources: {
                    title: 'Recent-source monitoring workflow',
                    checks: ['Use official BMU website/social URLs only.', 'Higher source rank means stronger authority during review.', 'Social sources still require admin approval before advisor use.']
                }
            };
            const guide = guides[tableName] || {
                title: `${tableInfo.label || 'Structured facts'} workflow`,
                checks: ['Edit visible fields first.', 'Open Advanced fields only for source, authority and currentness metadata.', 'Keep high-risk facts tied to an approved source.']
            };
            return `
                <section class="structured-workflow-guide" aria-label="${escapeHtml(guide.title)}">
                    <div>
                        <strong><i class="fa-solid fa-route"></i> ${escapeHtml(guide.title)}</strong>
                        <p>${guide.checks.map(escapeHtml).join(' ')}</p>
                    </div>
                </section>
            `;
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
            academic_programmes: ['programme', 'faculty', 'department', 'degree', 'duration_years', 'available_entry_modes', 'professional_regulatory_body', 'programme_status'],
            academic_courses: ['programme', 'level_label', 'semester_label', 'course_code', 'course_title', 'credit_units', 'status'],
            academic_calendar_events: ['event_title', 'event_date_label', 'session_label', 'status'],
            academic_rules: ['rule_type', 'requirement_category', 'programme', 'entry_mode', 'requirement_text', 'source_path', 'status'],
            bmu_recent_facts: ['status', 'title', 'category', 'fact_text', 'session_label', 'programme', 'source_name', 'confidence'],
            bmu_recent_sources: ['source_name', 'source_type', 'source_url', 'last_status', 'last_checked_at', 'status'],
            structured_facts: ['fact_type', 'subject', 'predicate_name', 'human_text', 'authority_rank', 'status']
        };
        const preferred = byTable[tableInfo.name] || all.slice(0, 6);
        return preferred.filter(column => all.includes(column));
    }

    function formatStructuredGridCell(column, value) {
        const text = String(value ?? '');
        if (column === 'status') {
            const status = text.toLowerCase();
            const cls = status === 'active' || status === 'approved' ? 'badge-success'
                : status === 'inactive' || status === 'rejected' ? 'badge-danger'
                : status === 'draft' || status === 'pending' ? 'badge-warn'
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
        const advanced = new Set(['value_json', 'row_json', 'source_path', 'status', 'authority_type', 'scope_label', 'currentness_label', 'expires_at', 'superseded_by', 'record_hash']);
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
                    ${simpleColumns.map(column => renderStructuredRecordField(column, record[column], requiredFields.has(column), tableName)).join('')}
                </div>
                ${advancedColumns.length ? `
                    <details class="structured-advanced">
                        <summary>Advanced source and system fields</summary>
                        <div class="structured-edit-grid">
                            ${advancedColumns.map(column => renderStructuredRecordField(column, record[column], requiredFields.has(column), tableName)).join('')}
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
        dialog.querySelectorAll('[data-structured-dialog-close]').forEach(btn => {
            btn.addEventListener('click', () => dialog.close());
        });
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

    function renderStructuredRecordField(column, value, required = false, tableName = '') {
        const isLong = /text|json|source_path|raw_text|human_text|value_json|row_json/.test(column);
        const label = structuredFieldLabel(column);
        const requiredAttr = required ? ' required' : '';
        const requiredMark = required ? ' <span class="required-indicator">Required</span>' : '';
        const placeholder = structuredFieldPlaceholder(column);
        const fixedOptions = structuredFieldSelectOptions(column, tableName);
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

    function structuredFieldSelectOptions(column, tableName = '') {
        if (column === 'status' && tableName === 'bmu_recent_facts') {
            return ['pending', 'approved', 'rejected', 'inactive'];
        }
        if (column === 'status' && tableName === 'bmu_recent_sources') {
            return ['active', 'inactive'];
        }
        if (column === 'currentness_label' && tableName === 'bmu_recent_facts') {
            return ['recent', 'current', 'pending_review', 'superseded', 'rejected', 'historical'];
        }
        const options = {
            status: ['active', 'draft', 'inactive'],
            programme_status: ['active', 'pending_review', 'paused', 'withdrawn', 'inactive'],
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
            professional_regulatory_body: ['NUC', 'MDCN', 'PCN', 'NMCN', 'MLSCN', 'RRBN', 'ODORBN', 'MRTB'],
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
            available_entry_modes: 'UTME; Direct Entry; Transfer',
            programme_status: 'active, paused, withdrawn, pending approval...',
            professional_regulatory_body: 'MDCN, NUC, PCN, NMCN...',
            version_label: 'CCMAS 2023, BMU 2025/2026...',
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
            required_subjects: 'English Language, Mathematics, Physics, Chemistry, Biology',
            minimum_grades: 'Credit pass; minimum C6; acceptable A-level passes...',
            olevel_sittings_rule: 'One sitting; not more than two sittings...',
            jamb_subjects: 'English, Biology, Chemistry, Physics',
            post_utme_rule: 'Acceptable post-UTME/screening score...',
            special_conditions: 'Any exception, waiver, or additional condition...',
            minimum_credit_units: 'Minimum 120 credit units',
            required_courses: 'List core/required courses or course groups',
            elective_requirements: 'Required electives or elective unit minimum',
            cgpa_requirement: 'Minimum CGPA 1.50',
            clinical_posting_requirement: 'Required clinical posting/rotation',
            project_requirement: 'Research project requirement',
            professional_exam_requirement: 'Professional examination requirement',
            duration_limits: 'Minimum/maximum duration rule',
            approval_condition: 'Senate/professional-body approval condition',
            source_name: 'BMU Official Website, BMU Facebook, admin pasted notice...',
            source_type: 'website, social_facebook, manual_paste...',
            source_url: 'https://bmu.edu.ng/...',
            title: 'BMU 2026/2027 admissions cut-off marks',
            category: 'admissions, fees, registration, calendar...',
            fact_text: 'Exact detected fact awaiting review',
            detected_date_label: '27 August 2026',
            confidence: '0.74',
            admin_notes: 'Reason for approval, rejection, correction, or expiry',
            expires_at: 'Leave blank for no expiry, or use YYYY-MM-DD HH:mm:ss.',
            superseded_by: 'ID of the newer fact that replaces this one',
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
            available_entry_modes: 'Available entry modes',
            programme_status: 'Programme status',
            professional_regulatory_body: 'Professional/regulatory body',
            version_label: 'Version',
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
            required_subjects: 'Required subjects',
            minimum_grades: 'Minimum grades',
            olevel_sittings_rule: "O'Level sittings rule",
            jamb_subjects: 'JAMB / UTME subjects',
            post_utme_rule: 'Post-UTME / interview rule',
            special_conditions: 'Special conditions',
            minimum_credit_units: 'Minimum credit units',
            required_courses: 'Required/core courses',
            elective_requirements: 'Elective requirements',
            cgpa_requirement: 'CGPA / GPA requirement',
            clinical_posting_requirement: 'Clinical posting requirement',
            project_requirement: 'Project / research requirement',
            professional_exam_requirement: 'Professional exam requirement',
            duration_limits: 'Duration limits',
            approval_condition: 'Approval condition',
            source_name: 'Source name',
            source_type: 'Source type',
            source_url: 'Source URL',
            title: 'Notice title',
            category: 'Category',
            fact_text: 'Detected fact text',
            detected_date_label: 'Detected date',
            confidence: 'Confidence',
            admin_notes: 'Admin notes',
            expires_at: 'Review expiry',
            superseded_by: 'Superseded by fact ID',
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
