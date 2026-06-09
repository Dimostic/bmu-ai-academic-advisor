/*
 * BMU AI Assistant - Frontend Controller
 * - Single-page navigation
 * - Auth (register/login/logout/profile/change password)
 * - Chat (text + voice input, optional audio replies)
 * - Documents (list/search/filter + admin upload + process/train)
 * - Admin panel (dashboard/analytics/audit + exports)
 */

// =========================
// Global state
// =========================

const AppState = {
    // Resolve API base automatically. You can override by setting window.BMU_API_BASE in index.html.
    apiBase: (typeof window !== 'undefined' && window.BMU_API_BASE)
        ? String(window.BMU_API_BASE).replace(/\/$/, '')
        : (typeof window !== 'undefined' && window.location && window.location.origin)
            ? window.location.origin
            : '',
    token: null,
    user: null,
    currentPage: 'home',
    voiceModeEnabled: false,
    voiceModeTarget: null,
    mediaRecorder: null,
    recordedChunks: [],
    currentSessionToken: null,
    chatSessions: [],
    usage: null, // User's usage stats (prompts used/remaining)
    chat: {
        sessionsLoaded: false,
        sessionsLoading: false,
        historyLoading: false,
        activeSessionId: null,
        useStreaming: true, // Enable streaming responses for faster perceived speed
        selectedDocuments: [], // Array of document IDs to filter context (empty = all documents)
        allDocumentsForSelector: [], // Cached list of documents for selector
        documentSelectorOpen: false,
        pendingDocumentSelection: null
    },
    documents: {
        page: 1,
        limit: 12,
        totalPages: 1,
        category: '',
        search: '',
        status: '',
        stats: null
    },
    admin: {
        currentSection: 'dashboard',
        usersSearch: '',
        usersStatusFilter: '',
        usersRoleFilter: '',
        auditTrailSearch: ''
    },
    vcReports: {
        hasAccess: false,
        reports: [],
        currentReport: null,
        currentReportId: null,
        chatSessionToken: null,
        notes: [],
        page: 1,
        limit: 20,
        totalPages: 1,
        filters: {
            category: '',
            status: '',
            sentiment: '',
            search: '',
            archive: 'active'
        },
        stats: null
    },
    vcDocuments: {
        hasAccess: false,
        documents: [],
        currentDocument: null,
        currentDocumentId: null,
        chatSessionToken: null,
        notes: [],
        page: 1,
        limit: 20,
        totalPages: 1,
        filters: {
            category: '',
            status: '',
            sentiment: '',
            search: ''
        },
        stats: null
    }
};

const ViewerState = {
    currentDocId: null,
    currentDoc: null,
    tableOfContents: [],  // TOC from document structure
    chunkToSectionMap: [], // Maps chunk indexes to sections for search
    documentContent: '',   // Full document HTML content
    currentSectionIndex: 0,
    zoomLevel: 100,
    darkMode: false,
    bookmarks: [],
    searchResults: [],
    currentSearchIndex: 0,
    smartSearchResults: [],
    currentSmartSearchIndex: 0,
    listenersSetup: false,
    allDocuments: [],
    activeSearchType: null,  // 'text' or 'smart' - tracks which search is active
    contextMenuVisible: false
};

const TTS_VOICE_STORAGE_KEY = 'ttsVoiceSelection';
const DEFAULT_TTS_VOICE = 'en-NG-EzinneNeural';
const TTS_VOICE_OPTIONS = new Set([
    'en-NG-EzinneNeural',
    'en-NG-AbeoNeural',
    'en-GB-LibbyNeural',
    'en-GB-RyanNeural',
    'en-US-JennyNeural',
    'en-US-GuyNeural'
]);

// =========================
// Utilities
// =========================

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Parse simple markdown to HTML for chat messages
 * Handles: **bold**, *italic*, `code`, bullet points, numbered lists
 */
function parseMarkdown(text) {
    if (!text) return '';
    
    // First escape HTML
    let html = escapeHtml(text);
    
    // Convert **bold** to <strong>
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Convert *italic* to <em> (but not inside words or for bullet points)
    // Only match *text* that's not part of ** and not at start of line (bullet)
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    
    // Convert `code` to <code>
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Convert line breaks
    html = html.replace(/\n/g, '<br/>');
    
    // Convert bullet points (lines starting with - or •)
    html = html.replace(/(^|<br\/>)\s*[-•]\s+/g, '$1• ');
    
    // Convert numbered lists (lines starting with 1. 2. etc)
    html = html.replace(/(^|<br\/>)\s*(\d+)\.\s+/g, '$1$2. ');
    
    return html;
}

function formatDateTime(value) {
    try {
        const d = value instanceof Date ? value : new Date(value);
        return d.toLocaleString();
    } catch {
        return '';
    }
}

function showLoading(show, text = 'Loading...') {
    const overlay = $('loadingOverlay');
    if (!overlay) return;
    const p = overlay.querySelector('p');
    if (p) p.textContent = text;
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function showToast(message, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const iconMap = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };

    toast.innerHTML = `
        <i class="fas ${iconMap[type] || iconMap.info}"></i>
        <div class="toast-message">${escapeHtml(message)}</div>
        <button class="toast-close" aria-label="Close">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(toast);

    const close = () => {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    };
    toast.querySelector('.toast-close')?.addEventListener('click', close);
    window.setTimeout(close, 5000);
}

async function apiFetch(path, { method = 'GET', headers = {}, body = null, isForm = false } = {}) {
    const url = `${AppState.apiBase}${path}`;
    const finalHeaders = { ...headers };
    if (AppState.token) {
        finalHeaders['Authorization'] = `Bearer ${AppState.token}`;
    }
    if (!isForm) {
        finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    }

    const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body && !isForm ? JSON.stringify(body) : body
    });

    let data = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        data = await res.json();
    } else {
        data = await res.text();
    }

    if (!res.ok) {
        // Handle validation errors (400 with errors array)
        let errMsg = 'Request failed';
        if (data && data.errors && Array.isArray(data.errors)) {
            // Join all validation error messages
            errMsg = data.errors.map(err => err.message).join('. ');
        } else if (data && data.error) {
            errMsg = data.error;
        } else {
            errMsg = `Request failed (${res.status})`;
        }
        const e = new Error(errMsg);
        e.status = res.status;
        e.payload = data;
        e.code = data?.code || null; // Include error code from backend
        throw e;
    }

    return data;
}

function saveAuth(token, user, { persist = true } = {}) {
    AppState.token = token;
    AppState.user = user;

    // Persist token/user based on user choice.
    const storage = persist ? localStorage : sessionStorage;
    storage.setItem('bmu_token', token);
    storage.setItem('bmu_user', JSON.stringify(user));

    // Ensure we don't have conflicting stale entries.
    const other = persist ? sessionStorage : localStorage;
    other.removeItem('bmu_token');
    other.removeItem('bmu_user');
}

function clearAuth() {
    AppState.token = null;
    AppState.user = null;
    AppState.currentSessionToken = null;

    localStorage.removeItem('bmu_token');
    localStorage.removeItem('bmu_user');
    sessionStorage.removeItem('bmu_token');
    sessionStorage.removeItem('bmu_user');
}

function loadAuthFromStorage() {
    // Prefer session storage for non-remembered sessions.
    const token = sessionStorage.getItem('bmu_token') || localStorage.getItem('bmu_token');
    const userRaw = sessionStorage.getItem('bmu_user') || localStorage.getItem('bmu_user');
    if (token && userRaw) {
        try {
            AppState.token = token;
            AppState.user = JSON.parse(userRaw);
        } catch {
            clearAuth();
        }
    }
}

function isAdmin() {
    return AppState.user && (AppState.user.role === 'admin' || AppState.user.role === 'superadmin');
}

function isSuperAdmin() {
    return AppState.user && AppState.user.role === 'superadmin';
}

function enforceEmailRules(email, intendedRole = 'staff') {
    const e = String(email || '').trim().toLowerCase();
    // Staff must use @bmu.edu.ng. Admin/superadmin may use other domains.
    if (intendedRole === 'staff' && !e.endsWith('@bmu.edu.ng')) {
        return { ok: false, error: 'Staff registration requires a @bmu.edu.ng email address.' };
    }
    return { ok: true };
}

function isSameDay(a, b) {
    try {
        const da = new Date(a);
        const db = new Date(b);
        return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    } catch {
        return false;
    }
}

function formatSessionLabel(session) {
    const last = session.lastActivity || session.last_activity || session.createdAt || session.created_at;
    const dt = last ? new Date(last) : new Date();
    const now = new Date();
    const prefix = isSameDay(dt, now) ? 'Today' : dt.toLocaleDateString();
    return `${prefix} • ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function safeJoinUrl(base, maybePath) {
    if (!maybePath) return null;
    const p = String(maybePath);
    if (p.startsWith('http://') || p.startsWith('https://')) return p;
    if (p.startsWith('/')) return `${base}${p}`;
    return `${base}/${p}`;
}

function resolveAudioUrl(maybePath) {
    if (!maybePath) return null;
    let pathValue = String(maybePath);
    if (pathValue.startsWith('/uploads/audio/')) {
        pathValue = pathValue.replace('/uploads/audio/', '/api/chat/audio/');
    }
    const absolute = safeJoinUrl(AppState.apiBase, pathValue);
    if (!absolute || !AppState.token || absolute.includes('token=')) return absolute;
    if (AppState.apiBase && !absolute.startsWith(AppState.apiBase)) return absolute;
    const separator = absolute.includes('?') ? '&' : '?';
    return `${absolute}${separator}token=${encodeURIComponent(AppState.token)}`;
}

function isValidTtsVoice(voice) {
    return TTS_VOICE_OPTIONS.has(voice);
}

function getSelectedTtsVoice() {
    const stored = localStorage.getItem(TTS_VOICE_STORAGE_KEY);
    return isValidTtsVoice(stored) ? stored : DEFAULT_TTS_VOICE;
}

function setSelectedTtsVoice(voice) {
    const value = isValidTtsVoice(voice) ? voice : DEFAULT_TTS_VOICE;
    localStorage.setItem(TTS_VOICE_STORAGE_KEY, value);
    document.querySelectorAll('.tts-voice-select').forEach(select => {
        if (select.value !== value) select.value = value;
    });
}

function initTtsVoiceSelectors() {
    const selects = document.querySelectorAll('.tts-voice-select');
    if (!selects.length) return;
    const value = getSelectedTtsVoice();
    selects.forEach(select => {
        if (select.dataset.initialized === '1') {
            if (select.value !== value) select.value = value;
            return;
        }
        select.value = value;
        select.addEventListener('change', (e) => setSelectedTtsVoice(e.target.value));
        select.dataset.initialized = '1';
    });
}

function getTtsVoiceLang(voiceName) {
    const match = String(voiceName || '').match(/^([a-z]{2}-[A-Z]{2})/);
    return match ? match[1] : null;
}

function selectSpeechSynthesisVoice(voiceName, voices) {
    if (!Array.isArray(voices) || voices.length === 0) return null;
    const normalized = String(voiceName || '').trim();
    if (normalized) {
        const exact = voices.find(v => v.name === normalized);
        if (exact) return exact;
        const lang = getTtsVoiceLang(normalized);
        if (lang) {
            const langMatch = voices.find(v => v.lang === lang || v.lang.startsWith(lang));
            if (langMatch) return langMatch;
        }
    }
    return null;
}

// Handle image load errors (hide image if not found)
function hideOnError(imgId) {
    const img = document.getElementById(imgId);
    if (img) {
        img.onerror = function() {
            this.classList.add('hidden');
        };
    }
}

// List of image IDs to apply error handler
['navLogo', 'heroLogo', 'loginLogo', 'registerLogo', 'resetLogo'].forEach(hideOnError);

// =========================
// Password Toggle
// =========================

function setupPasswordToggles() {
    // All password toggle buttons
    const toggles = [
        { toggle: 'loginPasswordToggle', input: 'loginPassword' },
        { toggle: 'regPasswordToggle', input: 'regPassword' },
        { toggle: 'resetNewPasswordToggle', input: 'resetNewPassword' }
    ];
    
    toggles.forEach(({ toggle, input }) => {
        const btn = $(toggle);
        const inp = $(input);
        if (btn && inp) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const isPassword = inp.type === 'password';
                inp.type = isPassword ? 'text' : 'password';
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.classList.toggle('fa-eye', !isPassword);
                    icon.classList.toggle('fa-eye-slash', isPassword);
                }
            });
        }
    });
}

// =========================
// Navigation / UI
// =========================

function showPage(page) {
    // Map page name to section id used in index.html.
    // Some pages use kebab-case ids (e.g. forgot-passwordPage, change-passwordPage).
    // Be tolerant: callers may pass either camelCase or kebab-case.
    const pageIdMap = {
        forgotPassword: 'forgot-password',
        changePassword: 'change-password'
    };

    const normalized = pageIdMap[page] || page;

    // Try multiple candidates to avoid UX-breaking "Page not found".
    const candidates = [
        `${normalized}Page`,
        `${String(page || '')}Page`,
        `${String(page || '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}Page`
    ].filter(Boolean);

    const pages = document.querySelectorAll('.page');
    pages.forEach(p => p.classList.remove('active'));

    let target = null;
    for (const id of candidates) {
        target = $(id);
        if (target) break;
    }

    if (!target) {
        // Helpful diagnostics (shows exactly what IDs we tried and what pages exist in DOM)
        try {
            const existing = Array.from(document.querySelectorAll('.page'))
                .map(el => el.id)
                .filter(Boolean);
            console.warn('[showPage] Page not found:', {
                page,
                normalized,
                candidates,
                existingPageIds: existing
            });
        } catch {
            // ignore
        }

        showToast('Page not found', 'error');
        return;
    }

    target.classList.add('active');
    AppState.currentPage = page;

    // Reset viewer zoom when leaving the viewer page to prevent it from affecting other pages
    if (page !== 'viewer') {
        document.documentElement.style.setProperty('--viewer-zoom', '1');
    }

    if (AppState.voiceModeEnabled) {
        const activePage = getVoiceModeTarget().page;
        if (page !== activePage) {
            AppState.voiceModeEnabled = false;
            updateVoiceModeButton();
            stopVoiceMode();
        }
    }

    // nav highlight
    document.querySelectorAll('.nav-link').forEach(a => {
        const p = a.getAttribute('data-page');
        a.classList.toggle('active', p === page);
    });

    const resourcesPages = new Set(['documents', 'viewer', 'vc-reports', 'vc-documents']);
    const resourcesGroup = $('navResourcesGroup');
    resourcesGroup && resourcesGroup.classList.toggle('active', resourcesPages.has(page));

    // close dropdown/mobile nav
    $('userDropdown')?.classList.remove('show');
    $('navLinks')?.classList.remove('show');

    // page-specific bootstraps
    if (page === 'chat') initChatPage();
    if (page === 'documents') loadDocuments(1);
    if (page === 'viewer') initViewerPage();
    if (page === 'faq') initFAQPage();
    if (page === 'profile') loadProfileIntoForm();
    if (page === 'vc-reports') initVCReportsPage();
    if (page === 'vc-documents') initVCDocumentsPage();
    if (page === 'admin') {
        showAdminSection('dashboard');
        return;
    }
}

function toggleMobileNav() {
    $('navLinks')?.classList.toggle('show');
}

function toggleUserMenu() {
    $('userDropdown')?.classList.toggle('show');
}

function togglePassword(inputId) {
    const el = $(inputId);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

function updateNavForAuth() {
    const guestButtons = $('guestButtons');
    const userMenu = $('userMenu');
    const chatNavLink = $('chatNavLink');
    const docsNavLink = $('docsNavLink');
    const viewerNavLink = $('viewerNavLink');
    const adminNavLink = $('adminNavLink');
    const vcReportsNavLink = $('vcReportsNavLink');
    const vcDocumentsNavLink = $('vcDocumentsNavLink');
    const uploadDocBtn = $('uploadDocBtn');

    if (AppState.user && AppState.token) {
        guestButtons && guestButtons.classList.add('hidden');
        userMenu && userMenu.classList.remove('hidden');
        chatNavLink && chatNavLink.classList.remove('hidden');
        docsNavLink && docsNavLink.classList.remove('hidden');
        viewerNavLink && viewerNavLink.classList.remove('hidden');
        adminNavLink && adminNavLink.classList.toggle('hidden', !isAdmin());
        uploadDocBtn && uploadDocBtn.classList.toggle('hidden', !isAdmin());

        // Show VC Reports link only if user has access
        if (vcReportsNavLink) {
            checkVCReportsAccess().then(hasAccess => {
                vcReportsNavLink.classList.toggle('hidden', !hasAccess);
                AppState.vcReports.hasAccess = hasAccess;
                if (hasAccess) {
                    loadVCReportsStats();
                } else {
                    AppState.vcReports.stats = null;
                    updateResourcesBadge();
                }
            });
        }

        // Show VC Documents link only if user has access
        if (vcDocumentsNavLink) {
            checkVCDocumentsAccess().then(hasAccess => {
                vcDocumentsNavLink.classList.toggle('hidden', !hasAccess);
                AppState.vcDocuments.hasAccess = hasAccess;
                if (hasAccess) {
                    loadVCDocumentsStats();
                } else {
                    AppState.vcDocuments.stats = null;
                    updateResourcesBadge();
                }
            });
        }

        const displayName = `${AppState.user.firstName || ''} ${AppState.user.lastName || ''}`.trim() || AppState.user.email;
        $('userDisplayName') && ($('userDisplayName').textContent = displayName);

        // superadmin-only links in admin sidebar
        document.querySelectorAll('.superadmin-only').forEach(el => {
            el.classList.toggle('hidden', !isSuperAdmin());
        });

        loadDocumentStatsForNav();
    } else {
        guestButtons && guestButtons.classList.remove('hidden');
        userMenu && userMenu.classList.add('hidden');
        chatNavLink && chatNavLink.classList.add('hidden');
        docsNavLink && docsNavLink.classList.add('hidden');
        viewerNavLink && viewerNavLink.classList.add('hidden');
        adminNavLink && adminNavLink.classList.add('hidden');
        vcReportsNavLink && vcReportsNavLink.classList.add('hidden');
        vcDocumentsNavLink && vcDocumentsNavLink.classList.add('hidden');
        uploadDocBtn && uploadDocBtn.classList.add('hidden');
        AppState.vcReports.stats = null;
        AppState.vcDocuments.stats = null;
        AppState.documents.stats = null;
        updateResourcesBadge();
    }
}

function updateResourcesBadge() {
    const badge = $('resourcesBadge');
    if (!badge) return;

    const vcUnread = Number(AppState.vcReports?.stats?.unread_count || 0);
    const vcDocUnread = Number(AppState.vcDocuments?.stats?.unread_count || 0);
    const docPending = Number(AppState.documents?.stats?.pending || 0);
    const total = vcUnread + vcDocUnread + docPending;

    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : String(total);
        badge.classList.remove('hidden');
        const parts = [];
        if (vcUnread) parts.push(`${vcUnread} unread VC report${vcUnread === 1 ? '' : 's'}`);
        if (vcDocUnread) parts.push(`${vcDocUnread} unread VC document${vcDocUnread === 1 ? '' : 's'}`);
        if (docPending) parts.push(`${docPending} pending document${docPending === 1 ? '' : 's'}`);
        badge.title = parts.join(' • ');
    } else {
        badge.textContent = '';
        badge.classList.add('hidden');
        badge.removeAttribute('title');
    }
}

async function loadDocumentStatsForNav() {
    if (!isAdmin()) {
        AppState.documents.stats = null;
        updateResourcesBadge();
        return;
    }

    try {
        const res = await apiFetch('/api/documents/admin/stats');
        if (res?.success) {
            AppState.documents.stats = res.stats || null;
            updateResourcesBadge();
        }
    } catch (e) {
        console.error('Error loading document stats:', e);
    }
}

// =========================
// Auth flows
// =========================

async function handleRegister(event) {
    event.preventDefault();

    const firstName = $('regFirstName')?.value?.trim();
    const lastName = $('regLastName')?.value?.trim();
    const email = $('regEmail')?.value?.trim();
    const department = $('regDepartment')?.value?.trim();
    const phone = $('regPhone')?.value?.trim();
    const password = $('regPassword')?.value;
    const confirm = $('regConfirmPassword')?.value;

    if (password !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }

    const emailRule = enforceEmailRules(email, 'staff');
    if (!emailRule.ok) {
        showToast(emailRule.error, 'warning');
        return;
    }

    showLoading(true, 'Creating account...');
    try {
        const res = await apiFetch('/api/users/register', {
            method: 'POST',
            body: { email, password, firstName, lastName, phone, department }
        });
        
        // Show success message with verification info
        showToast(res.message || 'Registration successful! Check your email to verify your account.', 'success');
        $('registerForm')?.reset();
        showPage('login');
        
        // Show additional info about the verification process
        if (res.requiresVerification) {
            setTimeout(() => {
                showToast('After email verification, your account will need administrator approval.', 'info');
            }, 2500);
        }
    } catch (e) {
        showToast(e.message || 'Registration failed', 'error');
    } finally {
        showLoading(false);
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const email = $('loginEmail')?.value?.trim();
    const password = $('loginPassword')?.value;
    const remember = !!$('rememberMe')?.checked;

    showLoading(true, 'Signing in...');
    try {
        const res = await apiFetch('/api/users/login', {
            method: 'POST',
            body: { email, password }
        });
        if (!res || !res.token || !res.user) {
            throw new Error('Unexpected login response');
        }
        saveAuth(res.token, res.user, { persist: remember });
        updateNavForAuth();
        showToast('Welcome back.', 'success');
        $('loginForm')?.reset();
        showPage('chat');
    } catch (e) {
        // Handle specific error codes
        if (e.code === 'EMAIL_NOT_VERIFIED') {
            showToast(e.message || 'Please verify your email first.', 'error');
            // Store email for resend functionality
            AppState.pendingVerificationEmail = email;
            showResendVerificationOption();
        } else if (e.code === 'PENDING_APPROVAL') {
            showToast(e.message || 'Your account is pending approval.', 'warning');
        } else {
            showToast(e.message || 'Login failed', 'error');
        }
    } finally {
        showLoading(false);
    }
}

// Show option to resend verification email
function showResendVerificationOption() {
    const loginPage = $('loginPage');
    if (!loginPage) return;
    
    // Remove any existing resend notice
    const existing = loginPage.querySelector('.resend-verification-notice');
    if (existing) existing.remove();
    
    const notice = document.createElement('div');
    notice.className = 'resend-verification-notice';
    notice.innerHTML = `
        <p class="text-warning"><i class="fas fa-exclamation-triangle"></i> Your email is not verified.</p>
        <button type="button" class="btn btn-outline btn-sm" id="resendVerificationBtn">
            <i class="fas fa-envelope"></i> Resend Verification Email
        </button>
    `;
    
    const form = loginPage.querySelector('form');
    if (form) {
        form.parentNode.insertBefore(notice, form.nextSibling);
    }
    
    // Add click handler
    const btn = notice.querySelector('#resendVerificationBtn');
    if (btn) {
        btn.addEventListener('click', handleResendVerification);
    }
}

// Handle resend verification email
async function handleResendVerification() {
    const email = AppState.pendingVerificationEmail;
    if (!email) {
        showToast('Please enter your email and try logging in first.', 'warning');
        return;
    }
    
    showLoading(true, 'Sending verification email...');
    try {
        const res = await apiFetch('/api/users/resend-verification', {
            method: 'POST',
            body: { email }
        });
        showToast(res.message || 'Verification email sent. Please check your inbox.', 'success');
        
        // Remove the notice
        const notice = document.querySelector('.resend-verification-notice');
        if (notice) notice.remove();
    } catch (e) {
        showToast(e.message || 'Failed to resend verification email', 'error');
    } finally {
        showLoading(false);
    }
}

async function logout() {
    try {
        if (AppState.token) {
            await apiFetch('/api/users/logout', { method: 'POST' });
        }
    } catch {
        // ignore
    } finally {
        clearAuth();
        updateNavForAuth();
        showToast('Logged out', 'info');
        showPage('home');
    }
}

async function handleForgotPassword(event) {
    event.preventDefault();
    const email = $('resetEmail')?.value?.trim();
    showLoading(true, 'Requesting reset...');
    try {
        const res = await apiFetch('/api/users/forgot-password', {
            method: 'POST',
            body: { email }
        });
        showToast(res.message || 'If the account exists, a reset link will be sent.', 'success');
        $('forgotPasswordForm')?.reset();
        showPage('login');
    } catch (e) {
        showToast(e.message || 'Request failed', 'error');
    } finally {
        showLoading(false);
    }
}

async function handleChangePassword(event) {
    event.preventDefault();
    const currentPassword = $('currentPassword')?.value;
    const newPassword = $('newPassword')?.value;
    const confirmPassword = $('confirmNewPassword')?.value;

    if (newPassword !== confirmPassword) {
        showToast('New passwords do not match', 'error');
        return;
    }

    showLoading(true, 'Updating password...');
    try {
        const res = await apiFetch('/api/users/change-password', {
            method: 'POST',
            body: { currentPassword, newPassword, confirmPassword }
        });
        showToast(res.message || 'Password updated', 'success');
        $('changePasswordForm')?.reset();
        showPage('profile');
    } catch (e) {
        showToast(e.message || 'Failed to update password', 'error');
    } finally {
        showLoading(false);
    }
}

async function loadProfileIntoForm() {
    if (!AppState.token) {
        showPage('login');
        return;
    }
    showLoading(true, 'Loading profile...');
    try {
        const res = await apiFetch('/api/users/me');
        if (res?.user) {
            // keep freshest profile in state/storage
            AppState.user = {
                ...AppState.user,
                ...res.user
            };
            localStorage.setItem('bmu_user', JSON.stringify(AppState.user));
        }

        const u = res.user;
        $('profileName') && ($('profileName').textContent = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email);
        $('profileRole') && ($('profileRole').textContent = u.role || 'staff');

        $('profileFirstName') && ($('profileFirstName').value = u.firstName || '');
        $('profileLastName') && ($('profileLastName').value = u.lastName || '');
        $('profileEmail') && ($('profileEmail').value = u.email || '');
        $('profileDepartment') && ($('profileDepartment').value = u.department || '');
        $('profilePhone') && ($('profilePhone').value = u.phone || '');
        $('profileWhatsapp') && ($('profileWhatsapp').value = u.whatsappNumber || '');
    } catch (e) {
        showToast(e.message || 'Failed to load profile', 'error');
    } finally {
        showLoading(false);
    }
}

async function handleUpdateProfile(event) {
    event.preventDefault();
    const firstName = $('profileFirstName')?.value?.trim();
    const lastName = $('profileLastName')?.value?.trim();
    const department = $('profileDepartment')?.value?.trim();
    const phone = $('profilePhone')?.value?.trim();
    const whatsappNumber = $('profileWhatsapp')?.value?.trim();

    showLoading(true, 'Saving profile...');
    try {
        const res = await apiFetch('/api/users/me', {
            method: 'PUT',
            body: { firstName, lastName, department, phone, whatsappNumber }
        });
        showToast(res.message || 'Profile updated', 'success');
        await loadProfileIntoForm();
        updateNavForAuth();
    } catch (e) {
        showToast(e.message || 'Failed to update profile', 'error');
    } finally {
        showLoading(false);
    }
}

function parseHashRoute() {
    try {
        const raw = String(window.location.hash || '').replace(/^#\/?/, ''); // Remove # and optional leading /
        if (!raw) return { route: null, params: {} };

        const [routePart, queryPart] = raw.split('?');
        const params = {};
        if (queryPart) {
            const usp = new URLSearchParams(queryPart);
            for (const [k, v] of usp.entries()) params[k] = v;
        }
        return { route: routePart || null, params };
    } catch {
        return { route: null, params: {} };
    }
}

function openResetPageWithToken(token) {
    if ($('resetToken')) $('resetToken').value = token || '';
    if ($('resetNewPassword')) $('resetNewPassword').value = '';
    if ($('resetConfirmPassword')) $('resetConfirmPassword').value = '';
    showPage('reset');
}

async function handleResetPasswordSubmit(event) {
    event.preventDefault();

    const token = $('resetToken')?.value?.trim();
    const newPassword = $('resetNewPassword')?.value;
    const confirm = $('resetConfirmPassword')?.value;

    if (!token) {
        showToast('Missing reset token. Please use the link from your email again.', 'error');
        return;
    }

    if (newPassword !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }

    showLoading(true, 'Resetting password...');
    try {
        const res = await apiFetch('/api/users/reset-password', {
            method: 'POST',
            body: { token, newPassword }
        });
        showToast(res.message || 'Password reset successful. Please login.', 'success');
        // clear token from hash
        window.location.hash = '';
        showPage('login');
    } catch (e) {
        showToast(e.message || 'Failed to reset password', 'error');
    } finally {
        showLoading(false);
    }
}

async function handleResetPasswordFromLink() {
    const { route, params } = parseHashRoute();
    
    // Handle email verification route
    if (route === 'verify-email') {
        return handleEmailVerification(params.token);
    }
    
    // Handle admin section deep links
    if (route === 'admin') {
        if (params.section === 'users' && params.status) {
            AppState.admin.usersStatusFilter = params.status;
        }
    }
    
    if (route !== 'reset') return;

    const token = params.token;
    if (!token) {
        showToast('Invalid reset link (missing token).', 'error');
        showPage('login');
        return;
    }

    openResetPageWithToken(token);
}

// Handle email verification from link
async function handleEmailVerification(token) {
    if (!token) {
        showToast('Invalid verification link (missing token).', 'error');
        showPage('login');
        return;
    }

    showLoading(true, 'Verifying your email...');
    try {
        const res = await apiFetch(`/api/users/verify-email?token=${encodeURIComponent(token)}`);
        showToast(res.message || 'Email verified successfully!', 'success');
        showPage('login');
        
        // Show additional info message
        setTimeout(() => {
            showToast('Your account is pending administrator approval. You will be notified by email.', 'info');
        }, 2000);
    } catch (e) {
        showToast(e.message || 'Email verification failed', 'error');
        showPage('login');
    } finally {
        showLoading(false);
        // Clear the hash to avoid re-verification on refresh
        window.location.hash = '';
    }
}

// =========================
// Chat
// =========================

function initChatPage() {
    if (!AppState.token) {
        showPage('login');
        return;
    }

    // auto-grow textarea (attach once)
    const input = $('chatInput');
    if (input && !input.dataset.bound) {
        input.dataset.bound = '1';
        input.classList.add('chat-textarea');

        // CSP note: avoid setting inline styles. We use the element's "rows" attribute as a CSP-safe way
        // to grow/shrink the textarea.
        const lineHeight = 20; // px (approx; based on CSS)
        const maxHeight = 150;

        input.addEventListener('input', () => {
            // Reset rows to measure content growth.
            input.rows = 1;
            const rows = Math.max(1, Math.min(Math.ceil(input.scrollHeight / lineHeight), Math.ceil(maxHeight / lineHeight)));
            input.rows = rows;
        });
    }

    // Load sessions sidebar
    loadChatSessions();

    // Load usage indicator
    loadUsageIndicator();

    // Initialize document selector
    initDocumentSelector();

    // Sync voice mode button state
    updateVoiceModeButton();

    // If no session selected yet, show welcome+suggestions
    if (!AppState.currentSessionToken) {
        addSystemWelcomeMessage();
        loadSuggestedQuestions();
    }
}

// Load usage indicator for current user
async function loadUsageIndicator() {
    if (!AppState.token) return;

    const indicator = $('usageIndicator');
    if (!indicator) return;

    try {
        const res = await apiFetch('/api/chat/usage');
        const usage = res.usage;
        
        updateUsageIndicator(usage);
    } catch (e) {
        console.error('Failed to load usage:', e);
        const textEl = indicator.querySelector('.usage-text');
        if (textEl) textEl.textContent = 'Usage unavailable';
    }
}

// Update usage indicator display
function updateUsageIndicator(usage) {
    const indicator = $('usageIndicator');
    if (!indicator) return;

    const textEl = indicator.querySelector('.usage-text');
    if (!textEl) return;

    // Remove all status classes
    indicator.classList.remove('warning', 'danger', 'unlimited');

    if (usage.unlimited) {
        textEl.textContent = 'Unlimited';
        indicator.classList.add('unlimited');
        indicator.title = 'Admin account - unlimited prompts';
    } else {
        const used = usage.used || 0;
        const limit = usage.limit || 100;
        const remaining = usage.remaining !== undefined ? usage.remaining : (limit - used);
        const percentage = (used / limit) * 100;

        textEl.textContent = `${remaining}/${limit} left`;
        indicator.title = `${used} of ${limit} prompts used this month`;

        if (percentage >= 90) {
            indicator.classList.add('danger');
        } else if (percentage >= 70) {
            indicator.classList.add('warning');
        }
    }
}

// =========================
// Document Selector for Chat
// =========================

async function initDocumentSelector() {
    const toggle = $('documentSelectorToggle');
    const dropdown = $('documentSelectorDropdown');
    const searchInput = $('documentSelectorSearch');
    const clearBtn = $('clearDocSelection');
    const allDocsRadio = document.querySelector('input[name="docSelection"][value="all"]');

    if (!toggle || !dropdown) return;

    // Prevent duplicate initialization - only bind events once
    if (toggle.dataset.initialized) {
        // Just reload the documents list if already initialized
        await loadDocumentsForSelector();
        return;
    }
    toggle.dataset.initialized = '1';

    // Load documents for selector
    await loadDocumentsForSelector();

    // Toggle dropdown
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.classList.contains('hidden');
        if (isOpen) {
            closeDocumentSelector();
        } else {
            openDocumentSelector();
        }
    });

    // Search documents
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterDocumentSelector(e.target.value);
        });
    }

    // Clear selection
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            AppState.chat.selectedDocuments = [];
            if (allDocsRadio) allDocsRadio.checked = true;
            updateDocumentSelectorUI();
            renderDocumentSelectorList();
        });
    }

    // All documents radio
    if (allDocsRadio) {
        allDocsRadio.addEventListener('change', () => {
            if (allDocsRadio.checked) {
                AppState.chat.selectedDocuments = [];
                updateDocumentSelectorUI();
            }
        });
    }

    // Close on outside click (use a named function to avoid duplicates)
    if (!window._docSelectorOutsideClickBound) {
        window._docSelectorOutsideClickBound = true;
        document.addEventListener('click', (e) => {
            const dd = $('documentSelectorDropdown');
            const tg = $('documentSelectorToggle');
            if (dd && !dd.classList.contains('hidden') && 
                !dd.contains(e.target) && 
                tg && !tg.contains(e.target)) {
                closeDocumentSelector();
            }
        });
    }
}

function openDocumentSelector() {
    const dropdown = $('documentSelectorDropdown');
    const toggle = $('documentSelectorToggle');
    if (dropdown) dropdown.classList.remove('hidden');
    if (toggle) toggle.classList.add('open');
    AppState.chat.documentSelectorOpen = true;
}

function closeDocumentSelector() {
    const dropdown = $('documentSelectorDropdown');
    const toggle = $('documentSelectorToggle');
    if (dropdown) dropdown.classList.add('hidden');
    if (toggle) toggle.classList.remove('open');
    AppState.chat.documentSelectorOpen = false;
}

async function loadDocumentsForSelector() {
    const listEl = $('documentSelectorList');
    
    // Show loading state
    if (listEl) {
        listEl.innerHTML = `<div class="document-option csp-muted"><i class="fas fa-spinner fa-spin"></i> Loading documents...</div>`;
    }
    
    try {
        // Fetch documents with completed embeddings (trained documents)
        const res = await apiFetch('/api/documents?status=completed&limit=100');
        AppState.chat.allDocumentsForSelector = res.documents || [];
        applyPendingDocumentSelection();
        renderDocumentSelectorList();
    } catch (e) {
        console.error('Failed to load documents for selector:', e);
        AppState.chat.allDocumentsForSelector = [];
        if (listEl) {
            listEl.innerHTML = `<div class="document-option csp-muted">Failed to load documents</div>`;
        }
    }
}

function renderDocumentSelectorList(filter = '') {
    const listEl = $('documentSelectorList');
    if (!listEl) return;

    let docs = AppState.chat.allDocumentsForSelector || [];
    
    // Filter by search term
    if (filter) {
        const lowerFilter = filter.toLowerCase();
        docs = docs.filter(doc => 
            doc.title.toLowerCase().includes(lowerFilter) ||
            (doc.category || '').toLowerCase().includes(lowerFilter)
        );
    }

    if (docs.length === 0) {
        listEl.innerHTML = `<div class="document-option csp-muted">No documents found</div>`;
        return;
    }

    const categoryIcons = {
        'policy': 'fa-gavel',
        'regulation': 'fa-balance-scale',
        'academic': 'fa-graduation-cap',
        'administrative': 'fa-building',
        'legal': 'fa-landmark',
        'general': 'fa-file-alt'
    };

    listEl.innerHTML = docs.map(doc => {
        const isSelected = AppState.chat.selectedDocuments.includes(doc.id);
        const icon = categoryIcons[doc.category] || categoryIcons['general'];
        return `
            <label class="document-option" data-doc-id="${doc.id}">
                <input type="checkbox" value="${doc.id}" ${isSelected ? 'checked' : ''}>
                <span>
                    <i class="fas ${icon}"></i>
                    ${escapeHtml(doc.title.length > 35 ? doc.title.substring(0, 35) + '...' : doc.title)}
                </span>
                <span class="doc-category">${escapeHtml(doc.category || 'general')}</span>
            </label>
        `;
    }).join('');

    // Add change listeners to checkboxes
    listEl.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const docId = parseInt(e.target.value);
            if (e.target.checked) {
                if (!AppState.chat.selectedDocuments.includes(docId)) {
                    AppState.chat.selectedDocuments.push(docId);
                }
            } else {
                AppState.chat.selectedDocuments = AppState.chat.selectedDocuments.filter(id => id !== docId);
            }
            // Uncheck "All Documents" when specific docs are selected
            const allDocsRadio = document.querySelector('input[name="docSelection"][value="all"]');
            if (allDocsRadio && AppState.chat.selectedDocuments.length > 0) {
                allDocsRadio.checked = false;
            } else if (allDocsRadio && AppState.chat.selectedDocuments.length === 0) {
                allDocsRadio.checked = true;
            }
            updateDocumentSelectorUI();
        });
    });
}

function normalizeDocumentIds(docIds) {
    const raw = Array.isArray(docIds) ? docIds : [docIds];
    const ids = raw
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id > 0);
    return Array.from(new Set(ids));
}

function applyChatDocumentSelection(docIds, { replace = true } = {}) {
    const ids = normalizeDocumentIds(docIds);
    if (replace) {
        AppState.chat.selectedDocuments = ids;
    } else {
        ids.forEach(id => {
            if (!AppState.chat.selectedDocuments.includes(id)) {
                AppState.chat.selectedDocuments.push(id);
            }
        });
    }

    const allDocsRadio = document.querySelector('input[name="docSelection"][value="all"]');
    if (allDocsRadio) {
        allDocsRadio.checked = AppState.chat.selectedDocuments.length === 0;
    }

    updateDocumentSelectorUI();
    renderDocumentSelectorList();
}

function applyPendingDocumentSelection() {
    const pending = AppState.chat.pendingDocumentSelection;
    if (!pending || pending.length === 0) return;
    AppState.chat.pendingDocumentSelection = null;
    applyChatDocumentSelection(pending, { replace: true });
}

function filterDocumentSelector(searchTerm) {
    renderDocumentSelectorList(searchTerm);
}

function updateDocumentSelectorUI() {
    const label = $('documentSelectorLabel');
    const toggle = $('documentSelectorToggle');
    const countEl = $('selectedDocCount');
    const selectedCount = AppState.chat.selectedDocuments.length;

    if (label) {
        if (selectedCount === 0) {
            label.textContent = 'All Documents';
        } else if (selectedCount === 1) {
            const doc = AppState.chat.allDocumentsForSelector.find(d => d.id === AppState.chat.selectedDocuments[0]);
            label.textContent = doc ? (doc.title.length > 25 ? doc.title.substring(0, 25) + '...' : doc.title) : '1 document';
        } else {
            label.textContent = `${selectedCount} documents`;
        }
    }

    if (toggle) {
        if (selectedCount > 0) {
            toggle.classList.add('active');
        } else {
            toggle.classList.remove('active');
        }
    }

    if (countEl) {
        countEl.textContent = `${selectedCount} selected`;
    }
}

function getSelectedDocumentIds() {
    return AppState.chat.selectedDocuments.length > 0 ? AppState.chat.selectedDocuments : null;
}

async function loadChatSessions() {
    if (!AppState.token) return;
    if (AppState.chat.sessionsLoading) return;

    AppState.chat.sessionsLoading = true;
    const listEl = $('chatSessionsList');
    if (listEl) {
        listEl.innerHTML = `<div class="session-item csp-muted csp-click-disabled">Loading sessions</div>`.replace(/\u007f/g,'');
    }

    try {
        const res = await apiFetch('/api/chat/sessions');
        AppState.chatSessions = res.sessions || [];
        AppState.chat.sessionsLoaded = true;
        renderChatSessions();
    } catch (e) {
        if (listEl) {
            listEl.innerHTML = `<div class="session-item csp-muted csp-click-disabled">Failed to load sessions</div>`;
        }
    } finally {
        AppState.chat.sessionsLoading = false;
    }
}

function renderChatSessions() {
    const listEl = $('chatSessionsList');
    if (!listEl) return;

    const sessions = Array.isArray(AppState.chatSessions) ? AppState.chatSessions : [];

    if (!sessions.length) {
        listEl.innerHTML = `<div class="session-item csp-muted csp-click-disabled">No sessions yet</div>`;
        return;
    }

    listEl.innerHTML = '';
    sessions
        .slice()
        .sort((a, b) => new Date(b.lastActivity || b.last_activity || b.createdAt || b.created_at) - new Date(a.lastActivity || a.last_activity || a.createdAt || a.created_at))
        .forEach(s => {
            const item = document.createElement('div');
            item.className = 'session-item';
            const token = s.sessionToken || s.session_token;
            const label = formatSessionLabel(s);
            item.innerHTML = `
                <div class="csp-flex-between">
                    <div>
                        <div class="csp-fw-600">Chat</div>
                        <div class="session-date">${escapeHtml(label)}</div>
                    </div>
                    <i class="fas fa-chevron-right csp-op-50"></i>
                </div>
            `;
            item.classList.toggle('active', token && token === AppState.currentSessionToken);
            item.addEventListener('click', () => selectChatSession(token, s.id));
            listEl.appendChild(item);
        });
}

async function selectChatSession(sessionToken, sessionId = null) {
    if (!sessionToken) return;
    AppState.currentSessionToken = sessionToken;
    AppState.chat.activeSessionId = sessionId;

    renderChatSessions();
    await loadChatHistory(sessionToken);
    await loadSuggestedQuestions(sessionToken);
}

async function loadChatHistory(sessionToken) {
    if (!AppState.token || !sessionToken) return;
    if (AppState.chat.historyLoading) return;
    AppState.chat.historyLoading = true;

    clearChatMessagesUI();
    addTypingIndicator();

    try {
        const res = await apiFetch(`/api/chat/session/${encodeURIComponent(sessionToken)}/history?limit=200&offset=0`);
        removeTypingIndicator();

        const msgs = res.messages || [];
        if (!msgs.length) {
            addSystemWelcomeMessage();
            return;
        }

        // render in chronological order
        msgs
            .slice()
            .reverse()
            .forEach(m => {
                const audioUrl = resolveAudioUrl(m.audioUrl);
                addMessageToUI({
                    sender: m.sender,
                    text: m.content,
                    audioUrl,
                    timestamp: m.timestamp
                }, { messageId: m.id, referencedDocuments: m.referencedDocuments, type: m.type });
            });

    } catch (e) {
        removeTypingIndicator();
        showToast(e.message || 'Failed to load chat history', 'error');
        addSystemWelcomeMessage();
    } finally {
        AppState.chat.historyLoading = false;
    }
}

async function loadSuggestedQuestions(sessionToken = null) {
    if (!AppState.token) return;
    try {
        const qs = new URLSearchParams();
        if (sessionToken) qs.set('sessionToken', sessionToken);
        const res = await apiFetch(`/api/chat/suggestions?${qs.toString()}`);
        const suggestions = res.suggestions || [];
        const wrap = $('suggestedQuestions');
        if (!wrap) return;

        // Keep first <p> and replace buttons
        const label = wrap.querySelector('p');
        wrap.innerHTML = '';
        if (label) wrap.appendChild(label);

        suggestions.slice(0, 5).forEach(s => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = s;
            btn.addEventListener('click', () => sendSuggestedQuestion(btn));
            wrap.appendChild(btn);
        });
    } catch {
        // ignore
    }
}

async function startNewChat() {
    if (!AppState.token) return showPage('login');
    showLoading(true, 'Starting new chat...');
    try {
        const res = await apiFetch('/api/chat/session/start', {
            method: 'POST',
            body: { platform: 'web' }
        });
        AppState.currentSessionToken = res.session?.sessionToken || res.session?.session_token || res.sessionToken;
        AppState.chat.activeSessionId = res.session?.id || null;

        clearChatMessagesUI();
        addSystemWelcomeMessage();
        await loadSuggestedQuestions(AppState.currentSessionToken);

        // refresh sidebar
        await loadChatSessions();
        showToast('New chat started', 'success');
    } catch (e) {
        showToast(e.message || 'Failed to start chat', 'error');
    } finally {
        showLoading(false);
    }
}

async function endCurrentChat() {
    const token = AppState.currentSessionToken;
    if (!token) {
        clearChatMessagesUI();
        addSystemWelcomeMessage();
        return;
    }

    showLoading(true, 'Ending chat...');
    try {
        await apiFetch(`/api/chat/session/${encodeURIComponent(token)}/end`, { method: 'POST' });
        showToast('Chat ended', 'info');
    } catch (e) {
        // still end locally
        showToast(e.message || 'Chat ended locally', 'warning');
    } finally {
        showLoading(false);
        AppState.currentSessionToken = null;
        AppState.chat.activeSessionId = null;
        clearChatMessagesUI();
        addSystemWelcomeMessage();
        loadChatSessions();
    }
}

function clearChatMessagesUI() {
    const cm = $('chatMessages');
    if (!cm) return;
    cm.innerHTML = '';
}

// Clear all messages and show welcome screen
function clearAllChats() {
    clearChatMessagesUI();
    addSystemWelcomeMessage();
    loadSuggestedQuestions();
    showToast('Chat cleared', 'success');
}

function addSystemWelcomeMessage() {
    const cm = $('chatMessages');
    if (!cm) return;

    cm.innerHTML = `
        <div class="chat-welcome">
            <div class="welcome-icon"><i class="fas fa-robot"></i></div>
            <h3>Welcome to BMU AI Assistant</h3>
            <p>Ask me anything about Bayelsa Medical University's policies, regulations, and procedures.</p>
            <div class="suggested-questions" id="suggestedQuestions">
                <p>Try asking:</p>
                <button type="button" data-suggest="1">What are the admission requirements?</button>
                <button type="button" data-suggest="1">Explain the academic integrity policy</button>
                <button type="button" data-suggest="1">How do I apply for leave?</button>
            </div>
        </div>
    `;

    // Bind clicks (CSP-safe: no inline handlers)
    cm.querySelectorAll('button[data-suggest="1"]').forEach(btn => {
        btn.addEventListener('click', () => sendSuggestedQuestion(btn));
    });
}

// Thinking indicator messages that rotate
const thinkingMessages = [
    'Thinking',
    'Searching knowledge base',
    'Analyzing your question',
    'Finding relevant information',
    'Preparing response'
];
let thinkingMessageIndex = 0;
let thinkingInterval = null;

function addTypingIndicator() {
    const cm = $('chatMessages');
    if (!cm) return;
    
    // Clear any existing interval
    if (thinkingInterval) {
        clearInterval(thinkingInterval);
        thinkingInterval = null;
    }
    
    thinkingMessageIndex = 0;
    
    const wrap = document.createElement('div');
    wrap.className = 'message assistant';
    wrap.id = 'typingIndicatorMessage';
    wrap.innerHTML = `
        <div class="message-avatar"><i class="fas fa-robot"></i></div>
        <div class="message-content">
            <div class="thinking-indicator">
                <div class="thinking-text">
                    <span class="thinking-text-content" id="thinkingText">${thinkingMessages[0]}</span>
                    <div class="thinking-dots"><span></span><span></span><span></span></div>
                </div>
                <div class="thinking-progress">
                    <div class="thinking-progress-bar"></div>
                </div>
            </div>
        </div>
    `;
    cm.appendChild(wrap);
    cm.scrollTop = cm.scrollHeight;
    
    // Rotate through thinking messages
    thinkingInterval = setInterval(() => {
        thinkingMessageIndex = (thinkingMessageIndex + 1) % thinkingMessages.length;
        const textEl = $('thinkingText');
        if (textEl) {
            textEl.textContent = thinkingMessages[thinkingMessageIndex];
        }
    }, 2500);
}

function removeTypingIndicator() {
    if (thinkingInterval) {
        clearInterval(thinkingInterval);
        thinkingInterval = null;
    }
    $('typingIndicatorMessage')?.remove();
}

function renderReferencedDocuments(refDocs = []) {
    const docs = Array.isArray(refDocs) ? refDocs : [];
    if (!docs.length) return '';

    const items = docs.slice(0, 5).map(d => {
        const title = d.title || d.document_title || d.name || 'Referenced document';
        const section = d.section || d.sectionTitle || d.section_name;
        const sectionHtml = section ? ` <span class="message-reference-section">(${escapeHtml(section)})</span>` : '';
        return `<li>${escapeHtml(title)}${sectionHtml}</li>`;
    }).join('');

    return `
        <div class="message-references">
            <div class="message-references-title">References</div>
            <ul class="message-references-list">${items}</ul>
        </div>
    `;
}

function renderMessageActions({ messageId, text } = {}) {
    if (!messageId) return '';
    // No inline onclick handlers; bind after insertion.
    // Include read aloud and copy buttons for AI responses
    return `
        <div class="message-actions" data-message-id="${Number(messageId)}" data-text="${escapeHtml(text || '')}">
            <button class="btn btn-sm btn-outline" type="button" data-action="copy" title="Copy response">
                <i class="fas fa-copy"></i>
            </button>
            <button class="btn btn-sm btn-outline" type="button" data-action="read-aloud" title="Read aloud">
                <i class="fas fa-volume-up"></i>
            </button>
            <button class="btn btn-sm btn-outline" type="button" data-rate="5">Helpful</button>
            <button class="btn btn-sm btn-outline" type="button" data-rate="1">Not helpful</button>
        </div>
    `;
}

// Text-to-Speech for reading AI responses aloud
let currentSpeech = null;
let currentAudio = null;

function readAloud(text, options = {}) {
    const { onEnd, suppressToast = false } = options;
    // Check for browser support
    if (!('speechSynthesis' in window)) {
        if (!suppressToast) {
            showToast('Text-to-speech is not supported in this browser', 'warning');
        }
        return;
    }
    
    // Stop any current speech
    if (currentSpeech) {
        window.speechSynthesis.cancel();
        currentSpeech = null;
    }

    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    
    if (!text || !text.trim()) {
        showToast('No text to read', 'info');
        return;
    }
    
    const cleanedText = sanitizeTextForTts(text);
    if (!cleanedText.trim()) {
        if (!suppressToast) {
            showToast('No readable text to speak', 'info');
        }
        return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanedText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    
    // Try to use a good voice
    const voices = window.speechSynthesis.getVoices();
    const selectedVoice = getSelectedTtsVoice();
    const preferredVoice = selectSpeechSynthesisVoice(selectedVoice, voices)
        || voices.find(v => v.lang === 'en-NG' || v.lang.startsWith('en-NG'))
        || voices.find(v => v.lang.startsWith('en-GB'))
        || voices.find(v => v.lang.startsWith('en-US'))
        || voices.find(v => v.lang.startsWith('en') && v.name.includes('Google'))
        || voices.find(v => v.lang.startsWith('en'));
    if (preferredVoice) {
        utterance.voice = preferredVoice;
    }
    
    utterance.onstart = () => {
        currentSpeech = utterance;
        if (!suppressToast) {
            showToast('Reading aloud...', 'info');
        }
    };
    
    utterance.onend = () => {
        currentSpeech = null;
        if (typeof onEnd === 'function') {
            onEnd();
        }
    };
    
    utterance.onerror = (event) => {
        currentSpeech = null;
        if (event.error !== 'canceled' && !suppressToast) {
            showToast('Failed to read aloud: ' + event.error, 'error');
        }
        if (typeof onEnd === 'function') {
            onEnd();
        }
    };
    
    window.speechSynthesis.speak(utterance);
}

function playAudioUrl(audioUrl, options = {}) {
    const { onEnd, onError, suppressToast = false } = options;
    if (!audioUrl) {
        if (typeof onEnd === 'function') onEnd();
        return;
    }

    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }

    const audio = new Audio(audioUrl);
    let finished = false;

    const finish = () => {
        if (finished) return;
        finished = true;
        currentAudio = null;
        if (typeof onEnd === 'function') onEnd();
    };

    const fail = (err) => {
        if (finished) return;
        finished = true;
        currentAudio = null;
        if (!suppressToast) {
            showToast('Failed to play audio response', 'error');
        }
        if (typeof onError === 'function') onError(err);
    };

    audio.onended = finish;
    audio.onerror = () => fail(new Error('Audio playback failed'));
    audio.play().catch(fail);
    currentAudio = audio;
}

function sanitizeTextForTts(text) {
    if (!text) return '';

    let cleaned = String(text);

    // Strip common markdown artifacts and bullets.
    cleaned = cleaned
        .replace(/[#*_`~]/g, ' ')
        .replace(/^\s*[-•]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,!?;:])/g, '$1')
        .trim();

    return cleaned;
}

function stopReadAloud({ suppressToast = false } = {}) {
    if (currentSpeech) {
        window.speechSynthesis.cancel();
        currentSpeech = null;
        if (!suppressToast) {
            showToast('Stopped reading', 'info');
        }
    }

    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
        if (!suppressToast) {
            showToast('Stopped audio playback', 'info');
        }
    }
}

// Copy text to clipboard
async function copyToClipboard(text) {
    if (!text || !text.trim()) {
        showToast('No text to copy', 'info');
        return;
    }
    
    try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard', 'success');
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showToast('Copied to clipboard', 'success');
        } catch (e) {
            showToast('Failed to copy text', 'error');
        }
        document.body.removeChild(textarea);
    }
}

function addMessageToUI({ sender, text, audioUrl, timestamp }, meta = {}) {
    const cm = $('chatMessages');
    if (!cm) return;

    // remove welcome block on first real message
    const welcome = cm.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `message ${sender === 'user' ? 'user' : 'assistant'}`;

    const avatarIcon = sender === 'user' ? 'fa-user' : 'fa-robot';
    // Use markdown parsing for assistant messages, plain escape for user messages
    const formattedText = sender === 'assistant' ? parseMarkdown(text || '') : escapeHtml(text || '').replace(/\n/g, '<br/>');
    const safeText = escapeHtml(text || ''); // Keep plain version for data attributes
    const timeText = formatDateTime(timestamp || new Date());

    const referencesHtml = sender === 'assistant' ? renderReferencedDocuments(meta.referencedDocuments) : '';
    const actionsHtml = sender === 'assistant' ? renderMessageActions({ messageId: meta.messageId, text: text }) : '';
    
    // Add resend button for user messages
    const resendHtml = sender === 'user' ? `
        <button class="message-resend-btn" type="button" data-resend-text="${safeText}" title="Resend this message">
            <i class="fas fa-redo"></i> Resend
        </button>
    ` : '';

    msg.innerHTML = `
        <div class="message-avatar"><i class="fas ${avatarIcon}"></i></div>
        <div class="message-content">
            <div class="message-text">${formattedText}</div>
            ${audioUrl ? `<div class="message-audio"><audio controls src="${escapeHtml(audioUrl)}"></audio></div>` : ''}
            ${referencesHtml}
            ${actionsHtml}
            ${resendHtml}
            <div class="message-time">${escapeHtml(timeText)}</div>
        </div>
    `;

    // Bind resend button for user messages
    const resendBtn = msg.querySelector('.message-resend-btn');
    if (resendBtn) {
        resendBtn.addEventListener('click', () => {
            const messageText = resendBtn.getAttribute('data-resend-text');
            if (messageText) {
                resendMessage(messageText);
            }
        });
    }

    // Bind feedback buttons and read aloud (CSP-safe)
    const actionsEl = msg.querySelector('.message-actions');
    if (actionsEl) {
        const messageId = Number(actionsEl.getAttribute('data-message-id'));
        const messageText = actionsEl.getAttribute('data-text') || text || '';
        
        // Copy button
        actionsEl.querySelector('[data-action="copy"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            copyToClipboard(messageText);
        });
        
        // Read aloud button
        actionsEl.querySelector('[data-action="read-aloud"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (currentSpeech) {
                stopReadAloud();
            } else {
                readAloud(messageText);
            }
        });
        
        // Rating buttons
        actionsEl.querySelectorAll('button[data-rate]').forEach(btn => {
            btn.addEventListener('click', () => {
                const rating = Number(btn.getAttribute('data-rate'));
                rateMessage(messageId, rating);
            });
        });
    }

    cm.appendChild(msg);
    cm.scrollTop = cm.scrollHeight;
}

async function handleSendMessage(event) {
    event.preventDefault();
    if (!AppState.token) return showPage('login');

    const input = $('chatInput');
    const text = input?.value?.trim();
    if (!text) return;

    if (AppState.voiceModeEnabled) {
        voiceModeAwaitingResponse = true;
        stopRecording();
    }

    input.value = '';
    // CSP: no inline style mutations
    input.removeAttribute('style');

    addMessageToUI({ sender: 'user', text, timestamp: new Date() });
    
    // Use streaming or regular endpoint based on setting
    if (AppState.chat.useStreaming) {
        await handleStreamingMessage(text);
    } else {
        await handleRegularMessage(text);
    }
}

// Streaming message handler for faster perceived response
async function handleStreamingMessage(text) {
    const body = { message: text };
    if (typeof AppState.currentSessionToken === 'string' && AppState.currentSessionToken.trim()) {
        body.sessionToken = AppState.currentSessionToken.trim();
    }
    
    // Add selected document IDs if any
    const selectedDocs = getSelectedDocumentIds();
    if (selectedDocs && selectedDocs.length > 0) {
        body.documentIds = selectedDocs;
    }

    // Create streaming message element
    const cm = $('chatMessages');
    const streamingMsg = document.createElement('div');
    streamingMsg.className = 'message assistant';
    streamingMsg.id = 'streamingMessage';
    streamingMsg.innerHTML = `
        <div class="message-avatar"><i class="fas fa-robot"></i></div>
        <div class="message-content">
            <div class="message-text" id="streamingText">
                <span class="streaming-cursor">▊</span>
            </div>
            <div class="message-time">${formatDateTime(new Date())}</div>
        </div>
    `;
    cm.appendChild(streamingMsg);
    cm.scrollTop = cm.scrollHeight;

    let fullText = '';
    let messageId = null;
    let referencedDocuments = [];

    try {
        const response = await fetch(`${AppState.apiBase}/api/chat/message/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AppState.token}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to send message');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                
                try {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'start') {
                        AppState.currentSessionToken = data.sessionToken || AppState.currentSessionToken;
                    } else if (data.type === 'chunk') {
                        fullText += data.content;
                        const textEl = $('streamingText');
                        if (textEl) {
                            // Use markdown parsing for streaming text
                            textEl.innerHTML = parseMarkdown(fullText) + '<span class="streaming-cursor">▊</span>';
                            cm.scrollTop = cm.scrollHeight;
                        }
                    } else if (data.type === 'done') {
                        messageId = data.aiMessageId;
                        referencedDocuments = data.referencedDocuments || [];
                        
                        // Update usage display if available
                        if (data.usage) {
                            updateUsageDisplay(data.usage);
                        }
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                } catch (e) {
                    // Ignore JSON parse errors for incomplete data
                }
            }
        }

        // Finalize the message
        $('streamingMessage')?.remove();
        addMessageToUI({
            sender: 'assistant',
            text: fullText,
            timestamp: new Date()
        }, {
            messageId,
            referencedDocuments
        });

        handleVoiceModeAssistantResponse(fullText);

        // Refresh sessions
        loadChatSessions();

    } catch (e) {
        $('streamingMessage')?.remove();
        showToast(e.message || 'Failed to send message', 'error');
        if (AppState.voiceModeEnabled) {
            voiceModeAwaitingResponse = false;
            startVoiceModeListening();
        }
    }
}

// Regular (non-streaming) message handler
async function handleRegularMessage(text) {
    addTypingIndicator();

    try {
        const body = { message: text };
        if (typeof AppState.currentSessionToken === 'string' && AppState.currentSessionToken.trim()) {
            body.sessionToken = AppState.currentSessionToken.trim();
        }
        
        // Add selected document IDs if any
        const selectedDocs = getSelectedDocumentIds();
        if (selectedDocs && selectedDocs.length > 0) {
            body.documentIds = selectedDocs;
        }

        const res = await apiFetch('/api/chat/message', {
            method: 'POST',
            body
        });

        AppState.currentSessionToken = res.sessionToken || AppState.currentSessionToken;

        // refresh sidebar after first message creates session server-side
        await loadChatSessions();

        removeTypingIndicator();
        addMessageToUI({
            sender: 'assistant',
            text: res.aiResponse?.content,
            audioUrl: resolveAudioUrl(res.aiResponse?.audioUrl),
            timestamp: res.aiResponse?.timestamp || new Date()
        }, {
            messageId: res.aiResponse?.id,
            referencedDocuments: res.aiResponse?.referencedDocuments
        });
        
        // Update usage indicator
        if (res.usage) {
            updateUsageDisplay(res.usage);
        }

        handleVoiceModeAssistantResponse(res.aiResponse?.content || '', res.aiResponse?.audioUrl);
    } catch (e) {
        removeTypingIndicator();
        showToast(e.message || 'Failed to send message', 'error');
        if (AppState.voiceModeEnabled) {
            voiceModeAwaitingResponse = false;
            startVoiceModeListening();
        }
    }
}

function handleVoiceModeAssistantResponse(text, audioUrl = null) {
    if (!AppState.voiceModeEnabled) return;

    voiceModeAwaitingResponse = false;
    voiceModeSubmitLock = false;

    const cleaned = sanitizeTextForTts(text);
    if (!cleaned) {
        endVoiceModeSession();
        return;
    }

    if (voiceModeSpeaking || currentSpeech || currentAudio) {
        return;
    }

    const now = Date.now();
    if (cleaned === lastSpokenText && now - lastSpokenAt < 5000) {
        endVoiceModeSession();
        return;
    }

    const target = getVoiceModeTarget();
    stopRecording({ recordingId: target.recordingId });
    const resolvedAudioUrl = resolveAudioUrl(audioUrl);
    lastSpokenText = cleaned;
    lastSpokenAt = now;

    if (resolvedAudioUrl) {
        voiceModeSpeaking = true;
        playAudioUrl(resolvedAudioUrl, {
            suppressToast: true,
            onEnd: () => {
                voiceModeSpeaking = false;
                endVoiceModeSession();
            },
            onError: () => {
                voiceModeSpeaking = false;
                if (!('speechSynthesis' in window)) {
                    showToast('Text-to-speech is not supported in this browser', 'warning');
                    endVoiceModeSession();
                    return;
                }
                voiceModeSpeaking = true;
                readAloud(cleaned, {
                    suppressToast: true,
                    onEnd: () => {
                        voiceModeSpeaking = false;
                        endVoiceModeSession();
                    }
                });
            }
        });
        return;
    }

    if (!('speechSynthesis' in window)) {
        showToast('Text-to-speech is not supported in this browser', 'warning');
        endVoiceModeSession();
        return;
    }

    voiceModeSpeaking = true;
    readAloud(cleaned, {
        suppressToast: true,
        onEnd: () => {
            voiceModeSpeaking = false;
            endVoiceModeSession();
        }
    });
}

// Resend a message (for retry functionality)
async function resendMessage(text) {
    if (!text || !AppState.token) return;
    
    // Add the message to UI again
    addMessageToUI({ sender: 'user', text, timestamp: new Date() });
    
    // Send using the appropriate handler
    if (AppState.chat.useStreaming) {
        await handleStreamingMessage(text);
    } else {
        await handleRegularMessage(text);
    }
}

// Helper to update usage display after a message
function updateUsageDisplay(usage) {
    if (usage) {
        updateUsageIndicator(usage);
    }
}

function handleChatKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('chatForm')?.requestSubmit();
    }
}

function sendSuggestedQuestion(btnEl) {
    const q = btnEl?.textContent?.trim();
    if (!q) return;
    const input = $('chatInput');
    if (input) input.value = q;
    $('chatForm')?.requestSubmit();
}

const VoiceModeDefaults = {
    page: 'chat',
    inputId: 'chatInput',
    formId: 'chatForm',
    recordingId: 'voiceRecording',
    startBtnId: 'startRecordingBtn',
    stopBtnId: 'stopRecordingBtn',
    voiceModeBtnId: 'voiceModeBtn'
};

function resolveVoiceTarget(overrides = {}) {
    const base = {
        ...VoiceModeDefaults,
        ...(AppState.voiceModeTarget || {})
    };
    return { ...base, ...(overrides || {}) };
}

function setVoiceModeTarget(overrides = {}) {
    AppState.voiceModeTarget = resolveVoiceTarget(overrides);
    return AppState.voiceModeTarget;
}

function getVoiceModeTarget() {
    return resolveVoiceTarget();
}

function toggleVoiceMode(targetOverrides = null) {
    const previousTarget = getVoiceModeTarget();
    const target = targetOverrides ? setVoiceModeTarget(targetOverrides) : previousTarget;
    const isSameTarget = AppState.voiceModeEnabled
        && previousTarget.page === target.page
        && previousTarget.formId === target.formId;

    if (AppState.voiceModeEnabled && isSameTarget) {
        AppState.voiceModeEnabled = false;
        updateVoiceModeButton();
        stopVoiceMode();
        showToast('Voice mode disabled', 'info');
        return;
    }

    if (AppState.voiceModeEnabled && !isSameTarget) {
        stopVoiceMode();
    }

    AppState.voiceModeEnabled = true;
    updateVoiceModeButton();
    voiceModeAwaitingResponse = false;
    resetVoiceModeBuffer();
    showVoiceModeGuide();
    startVoiceModeListening();
    showToast('Voice mode enabled. Listening...', 'info');
}

function endVoiceModeSession() {
    if (!AppState.voiceModeEnabled) return;
    AppState.voiceModeEnabled = false;
    updateVoiceModeButton();
    stopVoiceMode();
    showToast('Voice mode ended', 'info');
}

// Browser-based speech recognition using Web Speech API
let speechRecognition = null;
let voiceModeAwaitingResponse = false;
let voiceModeSpeaking = false;
let voiceModeBuffer = '';
let voiceModeInterim = '';
const VOICE_MODE_END_PHRASE = 'deal now';
const VOICE_MODE_DELETE_PHRASE = 'delete now';
let lastSpokenText = '';
let lastSpokenAt = 0;
let voiceModeSubmitLock = false;
let voiceModeSubmitAt = 0;

function updateVoiceModeButton() {
    const activeTarget = AppState.voiceModeEnabled ? getVoiceModeTarget() : null;
    const buttons = [
        { id: 'voiceModeBtn', page: 'chat' },
        { id: 'vcDocVoiceModeBtn', page: 'vc-documents' },
        { id: 'vcReportVoiceModeBtn', page: 'vc-reports' }
    ];

    buttons.forEach(({ id, page }) => {
        const btn = $(id);
        if (!btn) return;
        const isActive = !!(activeTarget && activeTarget.page === page);
        btn.classList.toggle('voice-mode-active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = isActive ? 'fas fa-microphone-alt' : 'fas fa-microphone';
        }
    });
}

function startVoiceModeListening() {
    if (!AppState.voiceModeEnabled) return;
    if (voiceModeAwaitingResponse || voiceModeSpeaking) return;
    if (speechRecognition) return;
    const target = getVoiceModeTarget();
    startRecording({
        mode: 'voice-mode',
        inputId: target.inputId,
        formId: target.formId,
        recordingId: target.recordingId
    });
}

function stopVoiceMode() {
    voiceModeAwaitingResponse = false;
    voiceModeSpeaking = false;
    resetVoiceModeBuffer();
    voiceModeSubmitLock = false;
    const target = getVoiceModeTarget();
    stopRecording({ recordingId: target.recordingId });
    stopReadAloud({ suppressToast: true });
}

function resetVoiceModeBuffer() {
    voiceModeBuffer = '';
    voiceModeInterim = '';
}

function canSubmitVoiceMode() {
    const now = Date.now();
    if (voiceModeSubmitLock && now - voiceModeSubmitAt < 1500) return false;
    return true;
}

function lockVoiceModeSubmit() {
    voiceModeSubmitLock = true;
    voiceModeSubmitAt = Date.now();
}

function hasVoiceModeEndPhrase(text) {
    return new RegExp(`\\b${VOICE_MODE_END_PHRASE}\\b`, 'i').test(text || '');
}

function hasVoiceModeDeletePhrase(text) {
    return new RegExp(`\\b${VOICE_MODE_DELETE_PHRASE}\\b`, 'i').test(text || '');
}

function stripVoiceModeEndPhrase(text) {
    if (!text) return '';
    const re = new RegExp(`\\b${VOICE_MODE_END_PHRASE}\\b`, 'ig');
    return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

function stripVoiceModeDeletePhrase(text) {
    if (!text) return '';
    const re = new RegExp(`\\b${VOICE_MODE_DELETE_PHRASE}\\b`, 'ig');
    return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

function stripVoiceModePhrases(text) {
    return stripVoiceModeDeletePhrase(stripVoiceModeEndPhrase(text || ''));
}

function showVoiceModeGuide() {
    if (localStorage.getItem('voiceModeGuideSeen') === '1') return;

    let modal = $('voiceModeGuideModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'voiceModeGuideModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3><i class="fas fa-microphone"></i> Voice Mode</h3>
                    <button class="close-btn" id="voiceModeGuideCloseBtn">&times;</button>
                </div>
                <div class="modal-body" style="padding: 20px 24px;">
                    <p>To use Voice Mode:</p>
                    <ol style="margin: 12px 0 0 18px; line-height: 1.6;">
                        <li>Click <strong>Voice Mode</strong> to start listening.</li>
                        <li>Speak your question naturally.</li>
                        <li>Say <strong>"${VOICE_MODE_END_PHRASE}"</strong> to send it.</li>
                        <li>Say <strong>"${VOICE_MODE_DELETE_PHRASE}"</strong> to clear and start over.</li>
                        <li>Wait for the reply - it will be read aloud.</li>
                    </ol>
                    <p style="margin-top: 12px; font-size: 0.9rem; color: var(--text-secondary);">
                        Tip: If you pause without saying the phrase, Voice Mode keeps listening.
                    </p>
                </div>
                <div class="modal-actions" style="padding: 0 24px 24px;">
                    <button class="btn btn-primary" id="voiceModeGuideOkBtn">Got it</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => {
            modal.classList.remove('show');
            localStorage.setItem('voiceModeGuideSeen', '1');
        };

        $('voiceModeGuideCloseBtn')?.addEventListener('click', close);
        $('voiceModeGuideOkBtn')?.addEventListener('click', close);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }

    modal.classList.add('show');
}

async function startRecording(options = {}) {
    const { mode = 'manual' } = options;
    const target = resolveVoiceTarget(options);
    const inputEl = $(target.inputId);
    const formEl = $(target.formId);
    const recordingEl = $(target.recordingId);
    // Check for Web Speech API support (browser-based, no server needed)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
        showToast('Voice input is not supported in this browser. Try Chrome or Edge.', 'warning');
        return;
    }
    
    try {
        speechRecognition = new SpeechRecognition();
        const isVoiceMode = mode === 'voice-mode';
        speechRecognition.continuous = isVoiceMode;
        speechRecognition.interimResults = isVoiceMode;
        speechRecognition.lang = 'en-US';
        
        speechRecognition.onstart = () => {
            recordingEl?.classList.remove('hidden');
        };
        
        speechRecognition.onresult = (event) => {
            if (isVoiceMode) {
                if (voiceModeAwaitingResponse) return;
                let interimText = '';
                let finalText = '';

                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const result = event.results[i];
                    const transcript = result[0]?.transcript || '';
                    if (result.isFinal) {
                        finalText += ` ${transcript}`;
                    } else {
                        interimText += ` ${transcript}`;
                    }
                }

                if (finalText.trim()) {
                    voiceModeBuffer = `${voiceModeBuffer} ${finalText}`.trim();
                }

                voiceModeInterim = interimText.trim();
                const combined = `${voiceModeBuffer} ${voiceModeInterim}`.trim();

                if (inputEl) {
                    inputEl.value = stripVoiceModePhrases(combined);
                }

                if (hasVoiceModeDeletePhrase(combined)) {
                    resetVoiceModeBuffer();
                    if (inputEl) inputEl.value = '';
                    showToast(`Cleared. Continue speaking and say "${VOICE_MODE_END_PHRASE}" to send.`, 'info');
                    return;
                }

                if (hasVoiceModeEndPhrase(combined)) {
                    if (!canSubmitVoiceMode()) {
                        return;
                    }
                    const cleaned = stripVoiceModePhrases(combined);
                    if (!cleaned) {
                        showToast(`Please say your message before "${VOICE_MODE_END_PHRASE}"`, 'info');
                        resetVoiceModeBuffer();
                        return;
                    }

                    voiceModeAwaitingResponse = true;
                    lockVoiceModeSubmit();
                    resetVoiceModeBuffer();
                    stopRecording();

                    if (inputEl) {
                        inputEl.value = cleaned;
                        formEl?.requestSubmit();
                    }
                }
                return;
            }

            const transcript = event.results[0][0].transcript;
            if (transcript.trim()) {
                if (inputEl) {
                    inputEl.value = transcript;
                    formEl?.requestSubmit();
                }
            }
        };
        
        speechRecognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            if (event.error === 'not-allowed') {
                showToast('Microphone permission denied', 'error');
            } else if (event.error === 'no-speech') {
                showToast('No speech detected. Please try again.', 'info');
            } else {
                showToast('Voice recognition failed: ' + event.error, 'error');
            }
            recordingEl?.classList.add('hidden');
        };
        
        speechRecognition.onend = () => {
            recordingEl?.classList.add('hidden');
            speechRecognition = null;
            if (mode === 'voice-mode' && AppState.voiceModeEnabled && !voiceModeAwaitingResponse && !voiceModeSpeaking) {
                window.setTimeout(() => startVoiceModeListening(), 250);
            }
        };
        
        speechRecognition.start();
        if (mode !== 'voice-mode') {
            showToast('Listening... Speak now', 'info');
        }
    } catch (e) {
        showToast('Voice input failed: ' + e.message, 'error');
    }
}

function stopRecording(options = {}) {
    const target = resolveVoiceTarget(options);
    if (speechRecognition) {
        speechRecognition.stop();
        speechRecognition = null;
    }
    $(target.recordingId)?.classList.add('hidden');
}

async function uploadVoiceRecording() {
    if (!AppState.recordedChunks.length) return;
    const blob = new Blob(AppState.recordedChunks, { type: 'audio/webm' });
    const form = new FormData();
    form.append('audio', blob, `voice_${Date.now()}.webm`);
    if (AppState.currentSessionToken) form.append('sessionToken', AppState.currentSessionToken);
    form.append('voice', getSelectedTtsVoice());

    addMessageToUI({ sender: 'user', text: '[Voice message]', timestamp: new Date() });
    addTypingIndicator();

    try {
        const res = await apiFetch('/api/chat/voice', {
            method: 'POST',
            body: form,
            isForm: true,
            headers: {}
        });
        AppState.currentSessionToken = res.sessionToken || AppState.currentSessionToken;

        // refresh sidebar
        await loadChatSessions();

        removeTypingIndicator();
        // Replace placeholder with transcription for better UX
        addMessageToUI({ sender: 'user', text: res.transcribedText || '(transcription unavailable)', timestamp: new Date() });
        addMessageToUI({
            sender: 'assistant',
            text: res.aiResponse?.content,
            audioUrl: resolveAudioUrl(res.aiResponse?.audioUrl),
            timestamp: res.aiResponse?.timestamp || new Date()
        }, {
            messageId: res.aiResponse?.id,
            referencedDocuments: res.aiResponse?.referencedDocuments
        });
        handleVoiceModeAssistantResponse(res.aiResponse?.content || '', res.aiResponse?.audioUrl);
    } catch (e) {
        removeTypingIndicator();
        showToast(e.message || 'Failed to process voice message', 'error');
    }
}

async function rateMessage(messageId, rating) {
    if (!AppState.token) return;
    try {
        await apiFetch(`/api/chat/message/${Number(messageId)}/feedback`, {
            method: 'POST',
            body: { rating, comment: '' }
        });
        showToast('Feedback submitted', 'success');
    } catch (e) {
        showToast(e.message || 'Failed to submit feedback', 'error');
    }
}

// =========================
// Documents
// =========================

async function loadDocuments(page = 1) {
    if (!AppState.token) return showPage('login');
    AppState.documents.page = page;

    const params = new URLSearchParams();
    params.set('page', String(AppState.documents.page));
    params.set('limit', String(AppState.documents.limit));
    if (AppState.documents.category) params.set('category', AppState.documents.category);
    if (AppState.documents.search) params.set('search', AppState.documents.search);
    if (AppState.documents.status) params.set('status', AppState.documents.status);

    showLoading(true, 'Loading documents...');
    try {
        const res = await apiFetch(`/api/documents?${params.toString()}`);
        const list = res.documents || res.items || [];
        AppState.documents.totalPages = res.totalPages || Math.ceil((res.total || 0) / AppState.documents.limit) || 1;
        renderDocuments(list);
        renderDocumentsPagination(res.page || AppState.documents.page, AppState.documents.totalPages);
    } catch (e) {
        showToast(e.message || 'Failed to load documents', 'error');
    } finally {
        showLoading(false);
    }
}

function docIconForType(fileType) {
    const t = String(fileType || '').toLowerCase();
    if (t.includes('pdf')) return 'fa-file-pdf';
    if (t.includes('doc')) return 'fa-file-word';
    if (t.includes('xls')) return 'fa-file-excel';
    if (t.includes('csv')) return 'fa-file-csv';
    return 'fa-file-alt';
}

function renderDocuments(docs) {
    const container = $('documentsList');
    if (!container) return;
    container.innerHTML = '';

    if (!docs.length) {
        container.innerHTML = `<div class="auth-card auth-card-wide">No documents found.</div>`;
        return;
    }

    docs.forEach(d => {
        const card = document.createElement('div');
        card.className = 'document-card';
        const category = d.category || 'general';
        const desc = d.description || '';
        const created = d.createdAt || d.created_at;
        const status = d.embeddingStatus || d.embedding_status;
        const fileType = d.fileType || d.file_type;

        const adminButtons = isAdmin() ? `
            <button class="btn btn-sm btn-secondary" data-action="doc-process" data-id="${Number(d.id)}"><i class="fas fa-brain"></i> Process</button>
            <button class="btn btn-sm btn-danger" data-action="doc-delete" data-id="${Number(d.id)}"><i class="fas fa-trash"></i> Delete</button>
        ` : '';

        card.innerHTML = `
            <div class="document-card-header">
                <div class="document-icon"><i class="fas ${docIconForType(fileType)}"></i></div>
                <h3>${escapeHtml(d.title || 'Untitled')}</h3>
                <span class="category-badge">${escapeHtml(category)}</span>
            </div>
            <div class="document-card-body">
                <p>${escapeHtml(desc)}</p>
                <div class="document-meta">
                    <span><i class="fas fa-calendar"></i> ${escapeHtml(created ? formatDateTime(created) : '')}</span>
                    <span><i class="fas fa-tag"></i> ${escapeHtml(status || 'unknown')}</span>
                </div>
                <div class="document-actions">
                    <button class="btn btn-sm btn-outline" data-action="doc-view" data-id="${Number(d.id)}"><i class="fas fa-eye"></i> View</button>
                    ${adminButtons}
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function renderDocumentsPagination(current, totalPages) {
    const container = $('documentsPagination');
    if (!container) return;
    container.innerHTML = '';
    if (totalPages <= 1) return;

    const mkBtn = (label, page, disabled = false, active = false) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.disabled = disabled;
        if (active) b.classList.add('active');
        b.addEventListener('click', () => loadDocuments(page));
        return b;
    };

    container.appendChild(mkBtn('Prev', Math.max(1, current - 1), current === 1));
    const start = Math.max(1, current - 2);
    const end = Math.min(totalPages, current + 2);
    for (let p = start; p <= end; p++) {
        container.appendChild(mkBtn(String(p), p, false, p === current));
    }
    container.appendChild(mkBtn('Next', Math.min(totalPages, current + 1), current === totalPages));
}

function searchDocuments() {
    const v = $('documentSearch')?.value?.trim() || '';
    AppState.documents.search = v;
    loadDocuments(1);
}

function filterDocuments() {
    const cat = $('categoryFilter')?.value || '';
    AppState.documents.category = cat;
    loadDocuments(1);
}

async function viewDocument(id) {
    // Open document in the Document Viewer page
    ViewerState.currentDocId = id;
    showPage('viewer');
    await loadDocumentInViewer(id);
}

function showUploadModal() {
    if (!isAdmin()) {
        showToast('Only admins can upload documents', 'warning');
        return;
    }
    $('uploadModal')?.classList.add('show');
}

function closeModal(id) {
    const modal = $(id);
    if (modal) {
        modal.classList.remove('show');
        // For dynamically created modals, remove them entirely
        if (modal.style.display === 'flex' || modal.style.display === 'block') {
            modal.remove();
        }
    }
}

async function handleDocumentUpload(event) {
    event.preventDefault();
    if (!isAdmin()) return;

    const title = $('docTitle')?.value?.trim();
    const description = $('docDescription')?.value?.trim();
    const category = $('docCategory')?.value;
    const file = $('docFile')?.files?.[0];

    if (!file) {
        showToast('Please choose a file', 'warning');
        return;
    }

    const form = new FormData();
    form.append('title', title || file.name);
    form.append('description', description || '');
    form.append('category', category || 'general');
    form.append('file', file);

    showLoading(true, 'Uploading document...');
    try {
        const res = await apiFetch('/api/documents/upload', {
            method: 'POST',
            body: form,
            isForm: true
        });
        showToast(res.message || 'Document uploaded', 'success');
        $('uploadForm')?.reset();
        closeModal('uploadModal');
        loadDocuments(1);
    } catch (e) {
        showToast(e.message || 'Upload failed', 'error');
    } finally {
        showLoading(false);
    }
}

async function processDocument(id) {
    if (!isAdmin()) return;
    showLoading(true, 'Processing document...');
    try {
        const res = await apiFetch(`/api/documents/${id}/process`, { method: 'POST' });

        // Helpful debug info (kept in console; not shown to end-users)
        try {
            console.debug('[processDocument] response:', res);
        } catch {
            // ignore
        }

        if (!res?.success) {
            const detailErr = res?.details?.error || res?.error;
            showToast(detailErr ? `Document processing failed: ${detailErr}` : 'Document processing failed', 'error');
        } else {
            showToast(res.message || 'Document processed successfully', 'success');
        }

        loadDocuments(AppState.documents.page);
    } catch (e) {
        showToast(e.message || 'Processing failed', 'error');
        try {
            console.error('[processDocument] request failed:', e);
        } catch {
            // ignore
        }
    } finally {
        showLoading(false);
    }
}

async function deleteDocument(id) {
    if (!isAdmin()) return;
    const ok = confirm('Delete this document?');
    if (!ok) return;
    showLoading(true, 'Deleting document...');
    try {
        const res = await apiFetch(`/api/documents/${id}`, { method: 'DELETE' });
        showToast(res.message || 'Deleted', 'success');
        loadDocuments(AppState.documents.page);
    } catch (e) {
        showToast(e.message || 'Delete failed', 'error');
    } finally {
        showLoading(false);
    }
}

// file label UX
document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'docFile') {
        const file = e.target.files?.[0];
        const fileNameEl = $('fileName');
        if (fileNameEl) fileNameEl.textContent = file ? file.name : '';
    }
});

// =========================
// Viewer navigation helpers (enterprise-grade)
// =========================

function getViewerScrollContainer() {
    return $('viewerPaperArea'); // main scroll container
}

function getViewerContentRoot() {
    return $('viewerContent')?.querySelector('.document-body') || $('viewerContent');
}

function normalizeForCompare(s) {
    return String(s || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function ensureId(el, preferredId) {
    if (!el) return null;
    if (el.id) return el.id;

    const safe = String(preferredId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\-\s_]/g, '')
        .replace(/\s+/g, '-')
        .replace(/_+/g, '-')
        .replace(/\-+/g, '-')
        .replace(/^\-+|\-+$/g, '');

    const base = safe || 'section';
    let id = base;
    let i = 1;
    const root = getViewerContentRoot() || document;
    while (root.querySelector?.(`#${CSS.escape(id)}`)) {
        i++;
        id = `${base}-${i}`;
    }

    el.id = id;
    return id;
}

function resolveTocTarget(sectionId, tocIdx) {
    const root = getViewerContentRoot();
    if (!root) return null;

    // 1) Exact id within viewer
    if (sectionId) {
        try {
            const byId = root.querySelector(`#${CSS.escape(sectionId)}`) || document.getElementById(sectionId);
            if (byId && root.contains(byId)) return byId;
        } catch {
            // ignore
        }

        // 2) Attribute match
        const byAttr = root.querySelector(`[id="${sectionId}"]`);
        if (byAttr) return byAttr;
    }

    // 3) Fallback: match heading text against TOC title
    const tocItem = ViewerState.tableOfContents?.[tocIdx];
    const wantTitle = normalizeForCompare(tocItem?.title);
    if (wantTitle) {
        const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .doc-heading');
        for (const h of headings) {
            const got = normalizeForCompare(h.textContent);
            if (!got) continue;
            if (got === wantTitle) return h;
            if (got.includes(wantTitle) || wantTitle.includes(got)) return h;
        }
    }

    // 4) Last fallback: pick nth heading-ish element
    const all = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .doc-heading, [id^="section-"], [id^="heading-"]');
    if (typeof tocIdx === 'number' && all[tocIdx]) return all[tocIdx];

    return null;
}

function scrollViewerToElement(el, { highlightClass = 'highlight-section', offset = 0 } = {}) {
    const container = getViewerScrollContainer();
    const root = getViewerContentRoot();
    if (!container || !root || !el) return false;

    // Ensure element is inside viewer content
    if (!root.contains(el)) return false;

    // Use native scrollIntoView within nested scroll container (most reliable)
    try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    } catch {
        // fallback to manual calculation
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const target = container.scrollTop + (eRect.top - cRect.top) - offset;
        container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }

    if (highlightClass) {
        el.classList.add(highlightClass);
        setTimeout(() => el.classList.remove(highlightClass), 2000);
    }

    return true;
}

// =========================
// VC Reports Page
// =========================

const VCReportsState = {
    initialized: false,
    listenersSetup: false
};

const VCContentState = {
    reportId: null,
    tableOfContents: [],
    contentHtml: '',
    searchResults: [],
    currentSearchIndex: 0,
    listenersSetup: false
};

const VCDocumentsState = {
    initialized: false,
    listenersSetup: false
};

const VCDocumentContentState = {
    documentId: null,
    tableOfContents: [],
    contentHtml: '',
    searchResults: [],
    currentSearchIndex: 0,
    listenersSetup: false
};

/**
 * Check if user has VC Reports access
 */
async function checkVCReportsAccess() {
    if (!AppState.token) return false;
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/access/check`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        return data.success && data.hasAccess;
    } catch (e) {
        console.error('Error checking VC access:', e);
        return false;
    }
}

/**
 * Check if user has VC Documents access
 */
async function checkVCDocumentsAccess() {
    if (!AppState.token) return false;

    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/access/check`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        return data.success && data.hasAccess;
    } catch (e) {
        console.error('Error checking VC documents access:', e);
        return false;
    }
}

/**
 * Initialize VC Reports page
 */
async function initVCReportsPage() {
    if (!AppState.vcReports.hasAccess) {
        const hasAccess = await checkVCReportsAccess();
        if (!hasAccess) {
            showToast('You do not have access to VC Reports', 'error');
            showPage('home');
            return;
        }
        AppState.vcReports.hasAccess = true;
    }

    // Setup event listeners only once
    if (!VCReportsState.listenersSetup) {
        setupVCReportsListeners();
        VCReportsState.listenersSetup = true;
    }

    // Load stats and reports
    await loadVCReportsStats();
    await loadVCReports();
}

/**
 * Setup VC Reports event listeners
 */
function setupVCReportsListeners() {
    // Upload button
    $('uploadReportBtn')?.addEventListener('click', showVCUploadModal);
    
    // Filters
    $('vcCategoryFilter')?.addEventListener('change', () => {
        AppState.vcReports.filters.category = $('vcCategoryFilter').value;
        loadVCReports();
    });
    
    $('vcStatusFilter')?.addEventListener('change', () => {
        AppState.vcReports.filters.status = $('vcStatusFilter').value;
        loadVCReports();
    });
    
    $('vcSentimentFilter')?.addEventListener('change', () => {
        AppState.vcReports.filters.sentiment = $('vcSentimentFilter').value;
        loadVCReports();
    });
    
    // Search
    let searchTimeout;
    $('vcSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            AppState.vcReports.filters.search = e.target.value;
            loadVCReports();
        }, 300);
    });
    
    // Tab switching
    document.querySelectorAll('#vcReportTabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchVCTab(tab);
        });
    });
    
    // Report actions
    $('vcStarBtn')?.addEventListener('click', () => toggleVCReportStar());
    $('vcDownloadBtn')?.addEventListener('click', () => downloadVCReport());
    $('vcArchiveBtn')?.addEventListener('click', () => archiveVCReport());
    $('vcReanalyzeBtn')?.addEventListener('click', () => reanalyzeVCReport());
    
    // Chat form
    $('vcChatForm')?.addEventListener('submit', handleVCChatSubmit);

    const vcReportVoiceTarget = {
        page: 'vc-reports',
        inputId: 'vcChatInput',
        formId: 'vcChatForm',
        recordingId: 'vcReportVoiceRecording'
    };
    $('vcReportVoiceModeBtn')?.addEventListener('click', () => toggleVoiceMode(vcReportVoiceTarget));
    $('vcReportStartRecordingBtn')?.addEventListener('click', () => startRecording(vcReportVoiceTarget));
    $('vcReportStopRecordingBtn')?.addEventListener('click', () => stopRecording(vcReportVoiceTarget));
    
    // Suggested questions
    document.querySelectorAll('#vcChatTab .suggested-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $('vcChatInput').value = btn.textContent;
            handleVCChatSubmit(new Event('submit'));
        });
    });
    
    // Add note button
    $('addNoteBtn')?.addEventListener('click', () => showVCNoteModal());
    
    // Upload modal
    $('closeVcUploadModalBtn')?.addEventListener('click', closeVCUploadModal);
    $('cancelVcUploadBtn')?.addEventListener('click', closeVCUploadModal);
    $('vcUploadForm')?.addEventListener('submit', handleVCReportUpload);
    
    // File input display
    $('vcUploadFile')?.addEventListener('change', (e) => {
        const fileName = e.target.files[0]?.name || '';
        $('vcUploadFileName').textContent = fileName;
    });
    
    // Note modal
    $('closeVcNoteModalBtn')?.addEventListener('click', closeVCNoteModal);
    $('cancelVcNoteBtn')?.addEventListener('click', closeVCNoteModal);
    $('vcNoteForm')?.addEventListener('submit', handleVCNoteSave);

    // VC content viewer controls
    setupVCContentViewerListeners();
}

/**
 * Load VC Reports statistics
 */
async function loadVCReportsStats() {
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/stats`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            AppState.vcReports.stats = data.stats;
            
            // Update UI
            $('vcUnreadCount').textContent = data.stats.unread_count || 0;
            $('vcStarredCount').textContent = data.stats.starred_count || 0;
            $('vcTotalCount').textContent = data.stats.total_reports || 0;
            updateResourcesBadge();
        }
    } catch (e) {
        console.error('Error loading VC stats:', e);
    }
}

/**
 * Load VC Reports list
 */
async function loadVCReports(page = 1) {
    const listEl = $('vcReportsList');
    if (!listEl) return;
    
    listEl.innerHTML = `
        <div class="loading-placeholder">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading reports...</p>
        </div>
    `;
    
    try {
        const params = new URLSearchParams({
            page: page.toString(),
            limit: AppState.vcReports.limit.toString(),
            starredFirst: 'true'
        });
        
        const { category, status, sentiment, search } = AppState.vcReports.filters;
        if (category) params.append('category', category);
        if (sentiment) params.append('sentiment', sentiment);
        if (search) params.append('search', search);
        
        // Handle status filter
        if (status === 'unread') params.append('isRead', 'false');
        if (status === 'read') params.append('isRead', 'true');
        if (status === 'starred') params.append('isStarred', 'true');
        
        console.log('[VC Reports] Fetching reports with params:', params.toString());
        
        const res = await fetch(`${AppState.apiBase}/api/vc-reports?${params}`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        console.log('[VC Reports] API response:', data);
        
        if (data.success) {
            AppState.vcReports.reports = data.reports;
            AppState.vcReports.page = data.page;
            AppState.vcReports.totalPages = data.totalPages;
            
            console.log('[VC Reports] Rendering', data.reports.length, 'reports');
            renderVCReportsList(data.reports);
        } else {
            console.error('[VC Reports] API error:', data.error);
            listEl.innerHTML = `<div class="loading-placeholder"><p>Failed to load reports: ${data.error || 'Unknown error'}</p></div>`;
        }
    } catch (e) {
        console.error('Error loading VC reports:', e);
        listEl.innerHTML = `<div class="loading-placeholder"><p>Error loading reports</p></div>`;
    }
}

/**
 * Render VC Reports list
 */
function renderVCReportsList(reports) {
    const listEl = $('vcReportsList');
    if (!listEl) return;
    
    if (!reports || reports.length === 0) {
        listEl.innerHTML = `
            <div class="loading-placeholder">
                <i class="fas fa-folder-open"></i>
                <p>No reports found</p>
            </div>
        `;
        return;
    }
    
    const categoryLabels = {
        'academic_affairs': 'Academic',
        'administrative': 'Admin',
        'financial': 'Financial',
        'security': 'Security',
        'student_affairs': 'Students',
        'staff_welfare': 'Staff',
        'senate': 'Senate',
        'infrastructure': 'Infrastructure',
        'research': 'Research',
        'community_service': 'Community',
        'compliance_audit': 'Audit',
        'strategic_planning': 'Strategy',
        'other': 'Other'
    };
    
    listEl.innerHTML = reports.map(report => {
        const isActive = AppState.vcReports.currentReportId === report.id;
        const isUnread = !report.is_read;
        const isStarred = report.is_starred;
        const date = new Date(report.submitted_at).toLocaleDateString();
        const category = categoryLabels[report.category] || report.category;
        const status = (report.processing_status || 'completed').toLowerCase();
        const statusLabels = {
            pending: 'Pending',
            processing: 'Processing',
            failed: 'Failed',
            completed: 'Completed'
        };
        const statusBadge = status !== 'completed'
            ? `<span class="status-badge ${status}">${statusLabels[status] || 'Processing'}</span>`
            : '';
        
        return `
            <div class="vc-report-item ${isActive ? 'active' : ''} ${isUnread ? 'unread' : ''}" 
                 onclick="selectVCReport(${report.id})">
                <div class="report-item-header">
                    <span class="report-item-title">${escapeHtml(report.title)}</span>
                    <span class="report-item-star ${isStarred ? 'starred' : ''}">
                        <i class="fa${isStarred ? 's' : 'r'} fa-star"></i>
                    </span>
                </div>
                <div class="report-item-meta">
                    <span><i class="fas fa-folder"></i> ${category}</span>
                    <span><i class="fas fa-calendar"></i> ${date}</span>
                    <span class="sentiment-indicator ${report.ai_sentiment || 'neutral'}"></span>
                    ${statusBadge ? `<span>${statusBadge}</span>` : ''}
                </div>
                ${report.ai_summary ? `<div class="report-item-summary">${escapeHtml(report.ai_summary)}</div>` : ''}
            </div>
        `;
    }).join('');
}

/**
 * Select and view a VC Report
 */
async function selectVCReport(reportId) {
    AppState.vcReports.currentReportId = reportId;
    
    // Update list highlighting
    document.querySelectorAll('.vc-report-item').forEach(el => {
        el.classList.remove('active');
    });
    event?.target?.closest('.vc-report-item')?.classList.add('active');
    
    // Show loading
    $('vcReportPlaceholder')?.classList.add('hidden');
    $('vcReportHeader')?.classList.remove('hidden');
    $('vcReportTabs')?.classList.remove('hidden');
    $('vcTabContent')?.classList.remove('hidden');
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${reportId}`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            AppState.vcReports.currentReport = data.report;
            AppState.vcReports.notes = data.notes || [];
            resetVCContentState();
            
            renderVCReportDetails(data.report);
            renderVCNotes(data.notes || []);
            
            // Mark as read
            if (!data.report.is_read) {
                markVCReportAsRead(reportId);
            }
            
            // Switch to summary tab
            switchVCTab('summary');
            
            // Create or get chat session
            await initVCReportChat(reportId);
        } else {
            showToast('Failed to load report', 'error');
        }
    } catch (e) {
        console.error('Error loading report:', e);
        showToast('Error loading report', 'error');
    }
}

/**
 * Render VC Report details
 */
function renderVCReportDetails(report) {
    const categoryLabels = {
        'academic_affairs': 'Academic Affairs',
        'administrative': 'Administrative',
        'financial': 'Financial',
        'security': 'Security',
        'student_affairs': 'Student Affairs',
        'staff_welfare': 'Staff Welfare',
        'senate': 'Senate',
        'infrastructure': 'Infrastructure',
        'research': 'Research',
        'community_service': 'Community Service',
        'compliance_audit': 'Compliance & Audit',
        'strategic_planning': 'Strategic Planning',
        'other': 'Other'
    };
    
    // Header
    $('vcReportTitle').textContent = report.title;
    $('vcReportCategory').textContent = categoryLabels[report.category] || report.category;
    $('vcReportSubmitter').textContent = report.submitted_by_name || report.submitted_by_email || 'Unknown';
    $('vcReportDate').textContent = new Date(report.submitted_at).toLocaleDateString();
    
    // Sentiment badge
    const sentimentBadge = $('vcReportSentimentBadge');
    if (sentimentBadge) {
        sentimentBadge.className = `meta-item sentiment ${report.ai_sentiment || 'neutral'}`;
        $('vcReportSentiment').textContent = (report.ai_sentiment || 'neutral').charAt(0).toUpperCase() + 
                                              (report.ai_sentiment || 'neutral').slice(1);
    }

    // Processing status badge
    const processingStatus = (report.processing_status || 'completed').toLowerCase();
    const statusLabels = {
        pending: 'Pending',
        processing: 'Processing',
        failed: 'Failed',
        completed: 'Completed'
    };
    const statusBadge = $('vcReportProcessingStatus');
    if (statusBadge) {
        if (processingStatus !== 'completed') {
            statusBadge.textContent = statusLabels[processingStatus] || 'Processing';
            statusBadge.className = `status-badge ${processingStatus}`;
            statusBadge.classList.remove('hidden');
        } else {
            statusBadge.textContent = '';
            statusBadge.className = 'status-badge hidden';
        }
    }
    
    // Star button
    const starBtn = $('vcStarBtn');
    if (starBtn) {
        starBtn.innerHTML = `<i class="fa${report.is_starred ? 's' : 'r'} fa-star"></i>`;
        starBtn.classList.toggle('starred', report.is_starred);
    }
    
    // AI Summary
    const statusMessages = {
        pending: 'Processing queued. Summary will appear when complete.',
        processing: 'Processing in progress. Summary will appear when complete.',
        failed: 'Processing failed. Click "Re-analyze with AI" to retry.'
    };
    $('vcAiSummary').textContent = report.ai_summary
        || statusMessages[processingStatus]
        || 'No AI summary available. Click "Re-analyze with AI" to generate one.';
    
    // Key Points
    const keyPointsList = $('vcKeyPointsList');
    if (keyPointsList) {
        const keyPoints = report.ai_key_points || [];
        keyPointsList.innerHTML = keyPoints.length > 0
            ? keyPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')
            : '<li class="empty-list">No key points identified</li>';
    }
    
    // Highlights
    const highlightsList = $('vcHighlightsList');
    if (highlightsList) {
        const highlights = report.ai_highlights || [];
        highlightsList.innerHTML = highlights.length > 0
            ? highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')
            : '<li class="empty-list">No highlights identified</li>';
    }
    
    // Concerns
    const concernsList = $('vcConcernsList');
    if (concernsList) {
        const concerns = report.ai_concerns || [];
        concernsList.innerHTML = concerns.length > 0
            ? concerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')
            : '<li class="empty-list">No concerns identified</li>';
    }
    
    // Recommendations
    const recommendationsList = $('vcRecommendationsList');
    if (recommendationsList) {
        const recommendations = report.ai_recommendations || [];
        recommendationsList.innerHTML = recommendations.length > 0
            ? recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')
            : '<li class="empty-list">No recommendations available</li>';
    }
}

/**
 * Switch VC Report tab
 */
function switchVCTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('#vcReportTabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab panes
    document.querySelectorAll('#vcTabContent .tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    
    const targetPane = $(`vc${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Tab`);
    targetPane?.classList.add('active');
    
    // Load content for specific tabs
    if (tabName === 'content') {
        loadVCReportContent();
    }
}

/**
 * Load full report content
 */
async function loadVCReportContent() {
    const contentRoot = $('vcContentDocument');
    if (!contentRoot || !AppState.vcReports.currentReportId) return;

    resetVCContentSearch();

    if (VCContentState.reportId === AppState.vcReports.currentReportId && VCContentState.contentHtml) {
        renderVCContentDocument();
        renderVCContentToc();
        return;
    }

    renderVCContentLoading();

    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/content`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();

        if (data.success) {
            VCContentState.reportId = AppState.vcReports.currentReportId;
            VCContentState.tableOfContents = data.tableOfContents || [];
            VCContentState.contentHtml = data.content || '';

            renderVCContentDocument();
            renderVCContentToc();
        } else {
            renderVCContentError('Failed to load content');
        }
    } catch (e) {
        console.error('Error loading content:', e);
        renderVCContentError('Error loading content');
    }
}

function setupVCContentViewerListeners() {
    if (VCContentState.listenersSetup) return;
    VCContentState.listenersSetup = true;

    $('vcSidebarCollapseBtn')?.addEventListener('click', () => {
        $('vcContentSidebar')?.classList.add('collapsed');
        $('vcSidebarExpandBtn')?.classList.add('visible');
    });

    $('vcSidebarExpandBtn')?.addEventListener('click', () => {
        $('vcContentSidebar')?.classList.remove('collapsed');
        $('vcSidebarExpandBtn')?.classList.remove('visible');
    });

    $('vcContentSearchBtn')?.addEventListener('click', () => {
        performVCContentSearch();
    });

    $('vcContentSearchInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performVCContentSearch();
        }
    });

    $('vcContentSearchClearBtn')?.addEventListener('click', () => {
        const input = $('vcContentSearchInput');
        if (input) input.value = '';
        resetVCContentSearch();
    });

    $('vcPrevSearchResult')?.addEventListener('click', () => navigateVCSearchResult(-1));
    $('vcNextSearchResult')?.addEventListener('click', () => navigateVCSearchResult(1));
    $('vcCloseSearchResults')?.addEventListener('click', () => resetVCContentSearch());

    $('vcContentPrintBtn')?.addEventListener('click', () => window.print());
    $('vcContentDownloadBtn')?.addEventListener('click', () => downloadVCReport());
}

function resetVCContentState() {
    VCContentState.reportId = null;
    VCContentState.tableOfContents = [];
    VCContentState.contentHtml = '';
    resetVCContentSearch();
}

function renderVCContentLoading() {
    const contentRoot = $('vcContentDocument');
    if (contentRoot) {
        contentRoot.innerHTML = `
            <div class="content-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <p>Loading report content...</p>
            </div>
        `;
    }

    const tocList = $('vcContentTocList');
    if (tocList) {
        tocList.innerHTML = `
            <div class="toc-placeholder">
                <i class="fas fa-book-open"></i>
                <p>Loading sections...</p>
            </div>
        `;
    }
}

function renderVCContentError(message) {
    const contentRoot = $('vcContentDocument');
    if (contentRoot) {
        contentRoot.innerHTML = `
            <div class="viewer-placeholder">
                <i class="fas fa-file-alt"></i>
                <h3>Unable to load report</h3>
                <p>${escapeHtml(message || 'Failed to load report content.')}</p>
            </div>
        `;
    }
}

function renderVCContentDocument() {
    const contentRoot = $('vcContentDocument');
    if (!contentRoot) return;

    if (!VCContentState.contentHtml) {
        renderVCContentError('No content available for this report.');
        return;
    }

    const report = AppState.vcReports.currentReport || {};
    const categoryLabels = {
        'academic_affairs': 'Academic Affairs',
        'administrative': 'Administrative',
        'financial': 'Financial',
        'security': 'Security',
        'student_affairs': 'Student Affairs',
        'staff_welfare': 'Staff Welfare',
        'senate': 'Senate',
        'infrastructure': 'Infrastructure',
        'research': 'Research',
        'community_service': 'Community Service',
        'compliance_audit': 'Compliance & Audit',
        'strategic_planning': 'Strategic Planning',
        'other': 'Other'
    };

    const metaParts = [];
    if (report.category) metaParts.push(categoryLabels[report.category] || report.category);
    if (report.submitted_at) metaParts.push(formatDateTime(report.submitted_at));
    if (report.department) metaParts.push(report.department);

    const docBadge = $('vcContentDocBadge');
    if (docBadge) {
        docBadge.textContent = categoryLabels[report.category] || report.category || 'VC Report';
    }

    const metaText = metaParts.join(' • ');
    const titleHtml = `
        <div class="document-title">
            <h1>${escapeHtml(report.title || 'VC Report')}</h1>
            <div class="doc-meta">${escapeHtml(metaText)}</div>
        </div>
    `;

    const bodyHtml = `
        <div class="document-body">
            ${VCContentState.contentHtml}
        </div>
    `;

    contentRoot.innerHTML = titleHtml + bodyHtml;
}

function renderVCContentToc() {
    const tocList = $('vcContentTocList');
    if (!tocList) return;

    if (!VCContentState.tableOfContents.length) {
        tocList.innerHTML = `
            <div class="toc-placeholder">
                <i class="fas fa-book-open"></i>
                <p>No sections detected</p>
            </div>
        `;
        return;
    }

    tocList.innerHTML = VCContentState.tableOfContents.map((item, idx) => {
        const indent = (item.level || 1) > 1 ? `style="padding-left: ${(item.level - 1) * 15}px"` : '';
        return `
            <div class="toc-chapter ${idx === 0 ? 'active' : ''}" data-section="${idx}" data-id="${escapeHtml(item.id || '')}" ${indent}>
                <div class="toc-chapter-title">${escapeHtml(item.title)}</div>
            </div>
        `;
    }).join('');

    tocList.querySelectorAll('.toc-chapter').forEach(item => {
        item.addEventListener('click', () => {
            const idx = Number(item.dataset.section);
            const sectionId = item.dataset.id || '';

            const target = resolveVCTocTarget(sectionId, idx);
            if (!target) {
                showToast('Section not found in report', 'warning');
                return;
            }

            const resolvedId = ensureIdForRoot(target, sectionId || VCContentState.tableOfContents?.[idx]?.id || VCContentState.tableOfContents?.[idx]?.title, getVCContentRoot());
            VCContentState.tableOfContents[idx].id = resolvedId;

            scrollVCContentToElement(target, { highlightClass: 'highlight-section', offset: 80 });

            tocList.querySelectorAll('.toc-chapter').forEach((el, i) => el.classList.toggle('active', i === idx));
        });
    });
}

function getVCContentScrollContainer() {
    return $('vcContentPaperArea');
}

function getVCContentRoot() {
    return $('vcContentDocument')?.querySelector('.document-body') || $('vcContentDocument');
}

function ensureIdForRoot(el, preferredId, root) {
    if (!el) return null;
    if (el.id) return el.id;

    const safe = String(preferredId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\-\s_]/g, '')
        .replace(/\s+/g, '-')
        .replace(/_+/g, '-')
        .replace(/\-+/g, '-')
        .replace(/^\-+|\-+$/g, '');

    const base = safe || 'section';
    let id = base;
    let i = 1;
    const scope = root || document;
    while (scope.querySelector?.(`#${CSS.escape(id)}`)) {
        i++;
        id = `${base}-${i}`;
    }

    el.id = id;
    return id;
}

function resolveVCTocTarget(sectionId, tocIdx) {
    const root = getVCContentRoot();
    if (!root) return null;

    if (sectionId) {
        try {
            const byId = root.querySelector(`#${CSS.escape(sectionId)}`) || document.getElementById(sectionId);
            if (byId && root.contains(byId)) return byId;
        } catch {
            // ignore
        }

        const byAttr = root.querySelector(`[id="${sectionId}"]`);
        if (byAttr) return byAttr;
    }

    const tocItem = VCContentState.tableOfContents?.[tocIdx];
    const wantTitle = normalizeForCompare(tocItem?.title);
    if (wantTitle) {
        const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .doc-heading');
        for (const h of headings) {
            const got = normalizeForCompare(h.textContent);
            if (!got) continue;
            if (got === wantTitle) return h;
            if (got.includes(wantTitle) || wantTitle.includes(got)) return h;
        }
    }

    const all = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .doc-heading, [id^="section-"], [id^="heading-"]');
    if (typeof tocIdx === 'number' && all[tocIdx]) return all[tocIdx];

    return null;
}

function scrollVCContentToElement(el, { highlightClass = 'highlight-section', offset = 0 } = {}) {
    const container = getVCContentScrollContainer();
    const root = getVCContentRoot();
    if (!container || !root || !el) return false;

    if (!root.contains(el)) return false;

    try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    } catch {
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const target = container.scrollTop + (eRect.top - cRect.top) - offset;
        container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }

    if (highlightClass) {
        el.classList.add(highlightClass);
        setTimeout(() => el.classList.remove(highlightClass), 2000);
    }

    return true;
}

function resetVCContentSearch() {
    VCContentState.searchResults = [];
    VCContentState.currentSearchIndex = 0;
    clearVCContentHighlights();
    hideVCSearchResults();
}

function clearVCContentHighlights() {
    const root = getVCContentRoot();
    if (!root) return;
    root.querySelectorAll?.('.search-highlight')?.forEach(el => {
        const text = document.createTextNode(el.textContent || '');
        if (el.parentNode) el.parentNode.replaceChild(text, el);
    });
}

function hideVCSearchResults() {
    const section = $('vcSearchResultsSection');
    if (section) {
        section.classList.add('hidden');
        section.classList.remove('visible');
    }
}

function showVCSearchResults() {
    const section = $('vcSearchResultsSection');
    if (section) {
        section.classList.remove('hidden');
        section.classList.add('visible');
    }
}

function navigateVCSearchResult(delta) {
    if (!VCContentState.searchResults.length) {
        showToast('No search results', 'info');
        return;
    }

    VCContentState.currentSearchIndex += delta;
    if (VCContentState.currentSearchIndex < 0) {
        VCContentState.currentSearchIndex = VCContentState.searchResults.length - 1;
    } else if (VCContentState.currentSearchIndex >= VCContentState.searchResults.length) {
        VCContentState.currentSearchIndex = 0;
    }

    scrollToVCSearchResult(VCContentState.currentSearchIndex);
}

function updateVCSearchPosition() {
    const posEl = $('vcSearchResultPosition');
    if (posEl && VCContentState.searchResults.length) {
        posEl.textContent = `${VCContentState.currentSearchIndex + 1}/${VCContentState.searchResults.length}`;
    }
}

function showVCSearchResultsInSidebar(query) {
    const countEl = $('vcSearchResultsCount');
    const listEl = $('vcSearchResultsList');
    if (!listEl) return;

    const count = VCContentState.searchResults.length;
    if (count === 0) {
        hideVCSearchResults();
        showToast('No matches found', 'info');
        return;
    }

    showVCSearchResults();
    if (countEl) countEl.textContent = `${count} result${count !== 1 ? 's' : ''}`;

    listEl.innerHTML = VCContentState.searchResults.slice(0, 100).map((result, idx) => `
        <div class="search-result-item ${idx === 0 ? 'active' : ''}" data-index="${idx}">
            <div class="search-result-context">${escapeHtml(result.context)}</div>
        </div>
    `).join('');

    listEl.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const idx = parseInt(item.dataset.index, 10);
            VCContentState.currentSearchIndex = idx;
            scrollToVCSearchResult(idx);
        });
    });

    updateVCSearchPosition();

    if (count > 0) {
        scrollToVCSearchResult(0);
    }
}

function performVCContentSearch() {
    const rawQuery = $('vcContentSearchInput')?.value?.trim();
    if (!rawQuery || rawQuery.length < 2) {
        showToast('Please enter at least 2 characters to search', 'info');
        return;
    }

    resetVCContentSearch();

    const root = getVCContentRoot();
    if (!root) {
        showToast('No report loaded', 'warning');
        return;
    }

    const caseSensitive = false;
    const searchTerms = parseSearchQuery(rawQuery);
    if (searchTerms.length === 0) {
        showToast('Please enter a valid search term', 'info');
        return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
            if (!n || !n.parentNode) return NodeFilter.FILTER_REJECT;
            const parent = n.parentNode;
            if (parent.classList && parent.classList.contains('search-highlight')) return NodeFilter.FILTER_REJECT;
            const text = n.textContent || '';
            if (text.trim().length < 2) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const matches = [];
    let node;

    while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (!matchesSearchCriteria(text, searchTerms, caseSensitive)) continue;

        for (const term of searchTerms) {
            const needle = caseSensitive ? term.value : term.value.toLowerCase();
            const hay = caseSensitive ? text : text.toLowerCase();
            if (!needle) continue;

            let from = 0;
            while (from < hay.length) {
                const at = hay.indexOf(needle, from);
                if (at === -1) break;
                matches.push({ node, start: at, end: at + needle.length, term: text.substring(at, at + needle.length) });
                from = at + Math.max(1, needle.length);
            }
        }
    }

    if (!matches.length) {
        showToast('No matches found', 'info');
        return;
    }

    matches.sort((a, b) => {
        if (a.node === b.node) return b.start - a.start;
        return 0;
    });

    let globalIdx = 0;
    const perNode = new Map();

    for (const m of matches) {
        const list = perNode.get(m.node) || [];
        list.push(m);
        perNode.set(m.node, list);
    }

    perNode.forEach((nodeMatches, textNode) => {
        let working = textNode;
        for (const m of nodeMatches) {
            try {
                const full = working.textContent || '';
                if (m.end > full.length) continue;

                const after = working.splitText(m.end);
                const mid = working.splitText(m.start);

                const span = document.createElement('span');
                span.className = 'search-highlight';
                span.setAttribute('data-search-index', String(globalIdx));
                span.textContent = mid.textContent || '';

                mid.parentNode?.replaceChild(span, mid);

                const context = getContextAroundMatch(full, span.textContent);
                VCContentState.searchResults.push({
                    index: globalIdx,
                    context,
                    term: span.textContent,
                    element: span
                });

                globalIdx++;
                working = after;
            } catch {
                // Skip failed split
            }
        }
    });

    showVCSearchResultsInSidebar(rawQuery);
}

function scrollToVCSearchResult(idx) {
    if (idx < 0 || idx >= VCContentState.searchResults.length) return;

    const result = VCContentState.searchResults[idx];
    const contentRoot = $('vcContentDocument');
    if (!result || !contentRoot) return;

    document.querySelectorAll('#vcSearchResultsList .search-result-item').forEach((item, i) => {
        item.classList.toggle('active', i === idx);
    });

    const sidebarItem = document.querySelector(`#vcSearchResultsList .search-result-item[data-index="${idx}"]`);
    sidebarItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let el = result.element;
    if (!el || !el.isConnected) {
        el = contentRoot.querySelector(`.search-highlight[data-search-index="${idx}"]`);
    }
    if (!el) {
        const all = contentRoot.querySelectorAll('.search-highlight');
        el = all[idx] || null;
    }

    if (!el) return;

    contentRoot.querySelectorAll('.search-highlight-current').forEach(x => x.classList.remove('search-highlight-current'));
    el.classList.add('search-highlight-current');

    scrollVCContentToElement(el, { highlightClass: null, offset: 120 });

    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);

    updateVCSearchPosition();
}

/**
 * Mark report as read
 */
async function markVCReportAsRead(reportId) {
    try {
        await fetch(`${AppState.apiBase}/api/vc-reports/${reportId}/read`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        
        // Update UI
        document.querySelector(`.vc-report-item[onclick*="${reportId}"]`)?.classList.remove('unread');
        
        // Refresh stats
        loadVCReportsStats();
    } catch (e) {
        console.error('Error marking read:', e);
    }
}

/**
 * Toggle star on current report
 */
async function toggleVCReportStar() {
    if (!AppState.vcReports.currentReportId) return;
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/star`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            // Update UI
            const starBtn = $('vcDocStarBtn');
            if (starBtn) {
                starBtn.innerHTML = `<i class="fa${data.isStarred ? 's' : 'r'} fa-star"></i>`;
                starBtn.classList.toggle('starred', data.isStarred);
            }
            
            // Refresh list and stats
            loadVCReports();
            loadVCReportsStats();
        }
    } catch (e) {
        console.error('Error toggling star:', e);
        showToast('Failed to update star', 'error');
    }
}

/**
 * Archive current report
 */
async function archiveVCReport() {
    if (!AppState.vcReports.currentReportId) return;
    
    if (!confirm('Archive this report? It will be moved to the archive.')) return;
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/archive`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('Report archived', 'success');
            
            // Reset view and reload
            AppState.vcReports.currentReportId = null;
            AppState.vcReports.currentReport = null;
            
            $('vcReportPlaceholder')?.classList.remove('hidden');
            $('vcReportHeader')?.classList.add('hidden');
            $('vcReportTabs')?.classList.add('hidden');
            $('vcTabContent')?.classList.add('hidden');
            
            loadVCReports();
            loadVCReportsStats();
        }
    } catch (e) {
        console.error('Error archiving:', e);
        showToast('Failed to archive report', 'error');
    }
}

/**
 * Download original report file
 */
function downloadVCReport() {
    if (!AppState.vcReports.currentReportId) return;
    
    window.open(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/download`, '_blank');
}

/**
 * Re-analyze report with AI
 */
async function reanalyzeVCReport() {
    if (!AppState.vcReports.currentReportId) return;
    
    const btn = $('vcDocReanalyzeBtn');
    const originalHtml = btn?.innerHTML;
    
    try {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
        btn.disabled = true;
        
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/reanalyze`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('Report re-analyzed successfully', 'success');
            
            // Reload report details
            await selectVCReport(AppState.vcReports.currentReportId);
        } else {
            showToast(data.error || 'Failed to re-analyze', 'error');
        }
    } catch (e) {
        console.error('Error reanalyzing:', e);
        showToast('Failed to re-analyze report', 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
}

// ========== VC DOCUMENT CHAT ==========

/**
 * Initialize chat for a report
 */
async function initVCReportChat(reportId) {
    try {
        // Get existing sessions or create new one
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${reportId}/chat/sessions`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success && data.sessions.length > 0) {
            // Use most recent session
            AppState.vcReports.chatSessionToken = data.sessions[0].session_token;
            await loadVCChatHistory(data.sessions[0].session_token);
        } else {
            // Create new session
            const createRes = await fetch(`${AppState.apiBase}/api/vc-reports/${reportId}/chat/sessions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${AppState.token}` }
            });
            const createData = await createRes.json();
            
            if (createData.success) {
                AppState.vcReports.chatSessionToken = createData.session.sessionToken;
            }
        }
    } catch (e) {
        console.error('Error initializing chat:', e);
    }
}

/**
 * Load chat history
 */
async function loadVCChatHistory(sessionToken) {
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/chat/${sessionToken}/history`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success && data.messages.length > 0) {
            const messagesEl = $('vcChatMessages');
            messagesEl.innerHTML = '';
            
            data.messages.forEach(msg => {
                appendVCChatMessage(msg.role, msg.content, msg.audioUrl || msg.audio_url);
            });
        }
    } catch (e) {
        console.error('Error loading chat history:', e);
    }
}

/**
 * Handle chat form submit
 */
async function handleVCChatSubmit(e) {
    e.preventDefault();
    
    const input = $('vcChatInput');
    const message = input?.value?.trim();
    
    if (!message || !AppState.vcReports.chatSessionToken) return;
    
    if (AppState.voiceModeEnabled) {
        const target = getVoiceModeTarget();
        voiceModeAwaitingResponse = true;
        stopRecording({ recordingId: target.recordingId });
    }

    input.value = '';
    
    await sendVCChatMessage(message);
}

/**
 * Send chat message
 */
async function sendVCChatMessage(message) {
    // Hide welcome and add user message
    const welcomeEl = document.querySelector('#vcChatMessages .chat-welcome');
    if (welcomeEl) welcomeEl.style.display = 'none';
    
    appendVCChatMessage('user', message);
    
    // Show typing indicator
    const typingId = 'vc-typing-' + Date.now();
    appendVCChatMessage('assistant', '<i class="fas fa-spinner fa-spin"></i> Thinking...', null, typingId);
    
    try {
        const voiceTarget = AppState.voiceModeEnabled ? getVoiceModeTarget() : null;
        const wantsAudio = AppState.voiceModeEnabled && voiceTarget?.page === 'vc-reports';
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/chat/${AppState.vcReports.chatSessionToken}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${AppState.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message,
                voice: wantsAudio ? getSelectedTtsVoice() : null,
                withAudio: wantsAudio
            })
        });
        const data = await res.json();
        
        // Remove typing indicator
        document.getElementById(typingId)?.remove();
        
        if (data.success) {
            appendVCChatMessage('assistant', data.response, data.audioUrl);
            handleVoiceModeAssistantResponse(data.response, data.audioUrl);
        } else {
            appendVCChatMessage('assistant', 'Sorry, I encountered an error. Please try again.');
            if (AppState.voiceModeEnabled) {
                voiceModeAwaitingResponse = false;
                startVoiceModeListening();
            }
        }
    } catch (e) {
        console.error('Error sending message:', e);
        document.getElementById(typingId)?.remove();
        appendVCChatMessage('assistant', 'Failed to send message. Please try again.');
        if (AppState.voiceModeEnabled) {
            voiceModeAwaitingResponse = false;
            startVoiceModeListening();
        }
    }
}

/**
 * Append chat message to UI
 */
function appendVCChatMessage(role, content, audioUrl = null, id = null) {
    const messagesEl = $('vcChatMessages');
    if (!messagesEl) return;
    
    const div = document.createElement('div');
    div.className = `vc-chat-message ${role}`;
    if (id) div.id = id;
    
    const icon = role === 'user' ? 'fa-user' : 'fa-robot';
    
    const resolvedAudioUrl = resolveAudioUrl(audioUrl);
    const audioHtml = resolvedAudioUrl
        ? `<div class="message-audio"><audio controls src="${escapeHtml(resolvedAudioUrl)}"></audio></div>`
        : '';

    div.innerHTML = `
        <div class="message-avatar"><i class="fas ${icon}"></i></div>
        <div class="message-content">${role === 'assistant' ? parseMarkdown(content) : escapeHtml(content)}${audioHtml}</div>
    `;
    
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ========== VC DOCUMENT NOTES ==========

/**
 * Render notes list
 */
function renderVCNotes(notes) {
    const listEl = $('vcNotesList');
    if (!listEl) return;
    
    if (!notes || notes.length === 0) {
        listEl.innerHTML = `
            <div class="no-notes">
                <i class="fas fa-sticky-note"></i>
                <p>No notes yet. Click "Add Note" to create one.</p>
            </div>
        `;
        return;
    }
    
    listEl.innerHTML = notes.map(note => `
        <div class="note-item" data-id="${note.id}">
            <div class="note-header">
                <span class="note-date">${new Date(note.created_at).toLocaleString()}</span>
                <div class="note-actions">
                    <button class="btn btn-xs btn-outline" onclick="editVCNote(${note.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-xs btn-outline" onclick="deleteVCNote(${note.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="note-text">${escapeHtml(note.note_text)}</div>
        </div>
    `).join('');
}

/**
 * Show note modal
 */
function showVCNoteModal(noteId = null, noteText = '') {
    $('vcNoteModalTitle').textContent = noteId ? 'Edit Note' : 'Add Note';
    $('vcNoteId').value = noteId || '';
    $('vcNoteText').value = noteText;
    $('vcNoteModal')?.classList.add('show');
}

function closeVCNoteModal() {
    $('vcNoteModal')?.classList.remove('show');
}

/**
 * Handle note save
 */
async function handleVCNoteSave(e) {
    e.preventDefault();
    
    const noteId = $('vcNoteId')?.value;
    const noteText = $('vcNoteText')?.value?.trim();
    
    if (!noteText || !AppState.vcReports.currentReportId) return;
    
    try {
        let res;
        if (noteId) {
            // Update existing
            res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/notes/${noteId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${AppState.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ noteText })
            });
        } else {
            // Create new
            res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/notes`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${AppState.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ noteText })
            });
        }
        
        const data = await res.json();
        
        if (data.success) {
            showToast('Note saved', 'success');
            closeVCNoteModal();
            
            // Reload report to get updated notes
            await selectVCReport(AppState.vcReports.currentReportId);
            switchVCTab('notes');
        } else {
            showToast(data.error || 'Failed to save note', 'error');
        }
    } catch (e) {
        console.error('Error saving note:', e);
        showToast('Failed to save note', 'error');
    }
}

/**
 * Add new note
 */
function addVCNote() {
    showVCNoteModal();
}

/**
 * Edit existing note
 */
function editVCNote(noteId) {
    const note = AppState.vcReports.notes.find(n => n.id === noteId);
    if (note) {
        showVCNoteModal(noteId, note.note_text);
    }
}

/**
 * Delete note
 */
async function deleteVCNote(noteId) {
    if (!confirm('Delete this note?')) return;
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-reports/${AppState.vcReports.currentReportId}/notes/${noteId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('Note deleted', 'success');
            await selectVCReport(AppState.vcReports.currentReportId);
            switchVCTab('notes');
        }
    } catch (e) {
        console.error('Error deleting note:', e);
        showToast('Failed to delete note', 'error');
    }
}

// ========== VC DOCUMENT UPLOAD ==========

function showVCUploadModal() {
    $('vcUploadForm')?.reset();
    $('vcUploadFileName').textContent = '';
    $('vcUploadDepartment').value = AppState.user?.department || '';
    $('vcUploadModal')?.classList.add('show');
}

function closeVCUploadModal() {
    $('vcUploadModal')?.classList.remove('show');
}

/**
 * Handle report upload
 */
async function handleVCReportUpload(e) {
    e.preventDefault();
    
    const formData = new FormData();
    formData.append('title', $('vcUploadTitle')?.value?.trim());
    formData.append('description', $('vcUploadDescription')?.value?.trim());
    formData.append('category', $('vcUploadCategory')?.value);
    formData.append('reportDate', $('vcUploadDate')?.value);
    formData.append('department', $('vcUploadDepartment')?.value?.trim());
    
    const file = $('vcUploadFile')?.files[0];
    if (!file) {
        showToast('Please select a file', 'error');
        return;
    }
    formData.append('file', file);
    
    const submitBtn = document.querySelector('#vcUploadForm button[type="submit"]');
    const originalHtml = submitBtn?.innerHTML;
    
    try {
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
        submitBtn.disabled = true;
        
        await apiFetch('/api/vc-reports/upload', {
            method: 'POST',
            body: formData,
            isForm: true
        });

        showToast('Report submitted successfully! Processing will begin shortly.', 'success');
        closeVCUploadModal();
        loadVCReports();
        loadVCReportsStats();
    } catch (e) {
        console.error('Error uploading report:', e);
        const fallback = e?.status === 413
            ? 'File too large. Please upload a smaller file.'
            : 'Failed to upload report';
        const message = (e?.message && !String(e.message).startsWith('Request failed'))
            ? e.message
            : fallback;
        showToast(message, 'error');
    } finally {
        submitBtn.innerHTML = originalHtml;
        submitBtn.disabled = false;
    }
}


// =========================
// VC Documents Page
// =========================

/**
 * Initialize VC Documents page
 */
async function initVCDocumentsPage() {
    if (!AppState.vcDocuments.hasAccess) {
        const hasAccess = await checkVCDocumentsAccess();
        if (!hasAccess) {
            showToast('You do not have access to VC Documents', 'error');
            showPage('home');
            return;
        }
        AppState.vcDocuments.hasAccess = true;
    }

    // Setup event listeners only once
    if (!VCDocumentsState.listenersSetup) {
        setupVCDocumentsListeners();
        VCDocumentsState.listenersSetup = true;
    }

    // Load stats and documents
    await loadVCDocumentsStats();
    await loadVCDocuments();
}

/**
 * Setup VC Documents event listeners
 */
function setupVCDocumentsListeners() {
    // Upload button
    $('uploadVCDocumentBtn')?.addEventListener('click', showVCDocumentUploadModal);
    
    // Filters
    $('vcDocCategoryFilter')?.addEventListener('change', () => {
        AppState.vcDocuments.filters.category = $('vcDocCategoryFilter').value;
        loadVCDocuments();
    });
    
    $('vcDocStatusFilter')?.addEventListener('change', () => {
        AppState.vcDocuments.filters.status = $('vcDocStatusFilter').value;
        loadVCDocuments();
    });
    
    $('vcDocSentimentFilter')?.addEventListener('change', () => {
        AppState.vcDocuments.filters.sentiment = $('vcDocSentimentFilter').value;
        loadVCDocuments();
    });

    $('vcDocArchiveFilter')?.addEventListener('change', () => {
        AppState.vcDocuments.filters.archive = $('vcDocArchiveFilter').value || 'active';
        loadVCDocuments();
    });
    
    // Search
    let searchTimeout;
    $('vcDocSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            AppState.vcDocuments.filters.search = e.target.value;
            loadVCDocuments();
        }, 300);
    });
    
    // Tab switching
    document.querySelectorAll('#vcDocTabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchVCDocumentTab(tab);
        });
    });
    
    // Document actions
    $('vcDocStarBtn')?.addEventListener('click', () => toggleVCDocumentStar());
    $('vcDocDownloadBtn')?.addEventListener('click', () => downloadVCDocument());
    $('vcDocArchiveBtn')?.addEventListener('click', () => archiveVCDocument());
    $('vcDocDeleteBtn')?.addEventListener('click', () => deleteVCDocumentPermanently());
    $('vcDocReanalyzeBtn')?.addEventListener('click', () => reanalyzeVCDocument());
    
    // Chat form
    $('vcDocChatForm')?.addEventListener('submit', handleVCDocumentChatSubmit);

    const vcDocVoiceTarget = {
        page: 'vc-documents',
        inputId: 'vcDocChatInput',
        formId: 'vcDocChatForm',
        recordingId: 'vcDocVoiceRecording'
    };
    $('vcDocVoiceModeBtn')?.addEventListener('click', () => toggleVoiceMode(vcDocVoiceTarget));
    $('vcDocStartRecordingBtn')?.addEventListener('click', () => startRecording(vcDocVoiceTarget));
    $('vcDocStopRecordingBtn')?.addEventListener('click', () => stopRecording(vcDocVoiceTarget));
    
    // Suggested questions
    document.querySelectorAll('#vcDocChatTab .suggested-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $('vcDocChatInput').value = btn.textContent;
            handleVCDocumentChatSubmit(new Event('submit'));
        });
    });
    
    // Add note button
    $('vcDocAddNoteBtn')?.addEventListener('click', () => showVCDocumentNoteModal());
    
    // Upload modal
    $('closeVcDocUploadModalBtn')?.addEventListener('click', closeVCDocumentUploadModal);
    $('cancelVcDocUploadBtn')?.addEventListener('click', closeVCDocumentUploadModal);
    $('vcDocUploadForm')?.addEventListener('submit', handleVCDocumentUpload);
    
    // File input display
    $('vcDocUploadFile')?.addEventListener('change', (e) => {
        const fileName = e.target.files[0]?.name || '';
        $('vcDocUploadFileName').textContent = fileName;
    });
    
    // Note modal
    $('closeVcDocNoteModalBtn')?.addEventListener('click', closeVCDocumentNoteModal);
    $('cancelVcDocNoteModalBtn')?.addEventListener('click', closeVCDocumentNoteModal);
    $('vcDocNoteForm')?.addEventListener('submit', handleVCDocumentNoteSave);

    // VC content viewer controls
    setupVCDocumentContentViewerListeners();
}

/**
 * Load VC Documents statistics
 */
async function loadVCDocumentsStats() {
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/stats`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            AppState.vcDocuments.stats = data.stats;
            
            // Update UI
            $('vcDocUnreadCount').textContent = data.stats.unread_count || 0;
            $('vcDocStarredCount').textContent = data.stats.starred_count || 0;
            $('vcDocTotalCount').textContent = data.stats.total_documents || 0;
            updateResourcesBadge();
        }
    } catch (e) {
        console.error('Error loading VC stats:', e);
    }
}

/**
 * Load VC Documents list
 */
async function loadVCDocuments(page = 1) {
    const listEl = $('vcDocumentsList');
    if (!listEl) return;
    
    listEl.innerHTML = `
        <div class="loading-placeholder">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading documents...</p>
        </div>
    `;
    
    try {
        const params = new URLSearchParams({
            page: page.toString(),
            limit: AppState.vcDocuments.limit.toString(),
            starredFirst: 'true'
        });
        
        const { category, status, sentiment, search, archive } = AppState.vcDocuments.filters;
        if (category) params.append('category', category);
        if (sentiment) params.append('sentiment', sentiment);
        if (search) params.append('search', search);
        
        // Handle status filter
        if (status === 'unread') params.append('isRead', 'false');
        if (status === 'read') params.append('isRead', 'true');
        if (status === 'starred') params.append('isStarred', 'true');

        if (archive === 'archived') params.append('isArchived', 'true');
        if (archive === 'active') params.append('isArchived', 'false');
        
        console.log('[VC Documents] Fetching documents with params:', params.toString());
        
        const res = await fetch(`${AppState.apiBase}/api/vc-documents?${params}`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        console.log('[VC Documents] API response:', data);
        
        if (data.success) {
            AppState.vcDocuments.documents = data.documents;
            AppState.vcDocuments.page = data.page;
            AppState.vcDocuments.totalPages = data.totalPages;
            
            console.log('[VC Documents] Rendering', data.documents.length, 'documents');
            renderVCDocumentsList(data.documents);
        } else {
            console.error('[VC Documents] API error:', data.error);
            listEl.innerHTML = `<div class="loading-placeholder"><p>Failed to load documents: ${data.error || 'Unknown error'}</p></div>`;
        }
    } catch (e) {
        console.error('Error loading VC documents:', e);
        listEl.innerHTML = `<div class="loading-placeholder"><p>Error loading documents</p></div>`;
    }
}

/**
 * Render VC Documents list
 */
function renderVCDocumentsList(documents) {
    const listEl = $('vcDocumentsList');
    if (!listEl) return;
    
    if (!documents || documents.length === 0) {
        listEl.innerHTML = `
            <div class="loading-placeholder">
                <i class="fas fa-folder-open"></i>
                <p>No documents found</p>
            </div>
        `;
        return;
    }
    
    const categoryLabels = {
        'policy': 'Policy',
        'regulation': 'Regulation',
        'memo': 'Memo',
        'circular': 'Circular',
        'directive': 'Directive',
        'agreement': 'Agreement',
        'minutes': 'Minutes',
        'budget': 'Budget',
        'audit': 'Audit',
        'strategy': 'Strategy',
        'research': 'Research',
        'compliance': 'Compliance',
        'operations': 'Operations',
        'other': 'Other'
    };
    
    listEl.innerHTML = documents.map(document => {
        const isActive = AppState.vcDocuments.currentDocumentId === document.id;
        const isUnread = !document.is_read;
        const isStarred = document.is_starred;
        const dateValue = document.document_date || document.uploaded_at;
        const date = dateValue ? new Date(dateValue).toLocaleDateString() : '--';
        const category = categoryLabels[document.category] || document.category;
        const status = (document.processing_status || 'completed').toLowerCase();
        const statusLabels = {
            pending: 'Pending',
            processing: 'Processing',
            failed: 'Failed',
            completed: 'Completed'
        };
        const statusBadge = status !== 'completed'
            ? `<span class="status-badge ${status}">${statusLabels[status] || 'Processing'}</span>`
            : '';
        const archiveBadge = document.is_archived
            ? '<span class="status-badge archived">Archived</span>'
            : '';
        
        return `
            <div class="vc-report-item vc-document-item ${isActive ? 'active' : ''} ${isUnread ? 'unread' : ''}" 
                 data-id="${document.id}" onclick="selectVCDocument(${document.id}, event)">
                <div class="report-item-header">
                    <span class="report-item-title">${escapeHtml(document.title)}</span>
                    <span class="report-item-star ${isStarred ? 'starred' : ''}">
                        <i class="fa${isStarred ? 's' : 'r'} fa-star"></i>
                    </span>
                </div>
                <div class="report-item-meta">
                    <span><i class="fas fa-folder"></i> ${category}</span>
                    <span><i class="fas fa-calendar"></i> ${date}</span>
                    <span class="sentiment-indicator ${document.ai_sentiment || 'neutral'}"></span>
                    ${statusBadge ? `<span>${statusBadge}</span>` : ''}
                    ${archiveBadge ? `<span>${archiveBadge}</span>` : ''}
                </div>
                ${document.ai_summary ? `<div class="report-item-summary">${escapeHtml(document.ai_summary)}</div>` : ''}
            </div>
        `;
    }).join('');
}

/**
 * Select and view a VC Document
 */
async function selectVCDocument(documentId, evt) {
    AppState.vcDocuments.currentDocumentId = documentId;
    
    // Update list highlighting
    const listEl = $('vcDocumentsList');
    listEl?.querySelectorAll('.vc-document-item').forEach(el => {
        el.classList.remove('active');
    });
    listEl?.querySelector(`.vc-document-item[data-id="${documentId}"]`)?.classList.add('active');
    evt?.target?.closest('.vc-document-item')?.classList.add('active');
    
    // Show loading
    $('vcDocPlaceholder')?.classList.add('hidden');
    $('vcDocHeader')?.classList.remove('hidden');
    $('vcDocTabs')?.classList.remove('hidden');
    $('vcDocTabContent')?.classList.remove('hidden');
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${documentId}`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            AppState.vcDocuments.currentDocument = data.document;
            AppState.vcDocuments.notes = data.notes || [];
            resetVCDocumentContentState();
            
            renderVCDocumentDetails(data.document);
            renderVCDocumentNotes(data.notes || []);
            
            // Mark as read
            if (!data.document.is_read) {
                markVCDocumentAsRead(documentId);
            }
            
            // Switch to summary tab
            switchVCDocumentTab('summary');
            
            // Create or get chat session
            await initVCDocumentChat(documentId);
        } else {
            showToast('Failed to load document', 'error');
        }
    } catch (e) {
        console.error('Error loading document:', e);
        showToast('Error loading document', 'error');
    }
}

/**
 * Render VC Document details
 */
function renderVCDocumentDetails(document) {
    const categoryLabels = {
        'policy': 'Policy',
        'regulation': 'Regulation',
        'memo': 'Memo',
        'circular': 'Circular',
        'directive': 'Directive',
        'agreement': 'Agreement',
        'minutes': 'Minutes',
        'budget': 'Budget',
        'audit': 'Audit',
        'strategy': 'Strategy',
        'research': 'Research',
        'compliance': 'Compliance',
        'operations': 'Operations',
        'other': 'Other'
    };
    
    // Header
    $('vcDocTitle').textContent = document.title;
    $('vcDocCategory').textContent = categoryLabels[document.category] || document.category;
    const uploadedBy = String(document.uploaded_by_name || '').trim() || document.uploaded_by_email || 'Unknown';
    $('vcDocSubmitter').textContent = uploadedBy;
    const dateValue = document.document_date || document.uploaded_at;
    $('vcDocDate').textContent = dateValue ? new Date(dateValue).toLocaleDateString() : '--';
    
    // Sentiment badge
    const sentimentBadge = $('vcDocSentimentBadge');
    if (sentimentBadge) {
        sentimentBadge.className = `meta-item sentiment ${document.ai_sentiment || 'neutral'}`;
        $('vcDocSentiment').textContent = (document.ai_sentiment || 'neutral').charAt(0).toUpperCase() + 
                                              (document.ai_sentiment || 'neutral').slice(1);
    }

    // Processing status badge
    const processingStatus = (document.processing_status || 'completed').toLowerCase();
    const statusLabels = {
        pending: 'Pending',
        processing: 'Processing',
        failed: 'Failed',
        completed: 'Completed'
    };
    const statusBadge = $('vcDocProcessingStatus');
    if (statusBadge) {
        if (processingStatus !== 'completed') {
            statusBadge.textContent = statusLabels[processingStatus] || 'Processing';
            statusBadge.className = `status-badge ${processingStatus}`;
            statusBadge.classList.remove('hidden');
        } else {
            statusBadge.textContent = '';
            statusBadge.className = 'status-badge hidden';
        }
    }
    
    // Star button
    const starBtn = $('vcDocStarBtn');
    if (starBtn) {
        starBtn.innerHTML = `<i class="fa${document.is_starred ? 's' : 'r'} fa-star"></i>`;
        starBtn.classList.toggle('starred', document.is_starred);
    }

    // Archive button
    const archiveBtn = $('vcDocArchiveBtn');
    if (archiveBtn) {
        const isArchived = !!document.is_archived;
        archiveBtn.title = isArchived ? 'Unarchive' : 'Archive';
        archiveBtn.innerHTML = `<i class="fas ${isArchived ? 'fa-box-open' : 'fa-archive'}"></i>`;
    }

    // Permanent delete button (superadmin only, archived items)
    const deleteBtn = $('vcDocDeleteBtn');
    if (deleteBtn) {
        const canDelete = isSuperAdmin() && !!document.is_archived;
        deleteBtn.classList.toggle('hidden', !canDelete);
    }
    
    // AI Summary
    const statusMessages = {
        pending: 'Processing queued. Summary will appear when complete.',
        processing: 'Processing in progress. Summary will appear when complete.',
        failed: 'Processing failed. Click "Re-analyze with AI" to retry.'
    };
    $('vcDocAiSummary').textContent = document.ai_summary
        || statusMessages[processingStatus]
        || 'No AI summary available. Click "Re-analyze with AI" to generate one.';
    
    // Key Points
    const keyPointsList = $('vcDocKeyPointsList');
    if (keyPointsList) {
        const keyPoints = document.ai_key_points || [];
        keyPointsList.innerHTML = keyPoints.length > 0
            ? keyPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')
            : '<li class="empty-list">No key points identified</li>';
    }
    
    // Highlights
    const highlightsList = $('vcDocHighlightsList');
    if (highlightsList) {
        const highlights = document.ai_highlights || [];
        highlightsList.innerHTML = highlights.length > 0
            ? highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')
            : '<li class="empty-list">No highlights identified</li>';
    }
    
    // Concerns
    const concernsList = $('vcDocConcernsList');
    if (concernsList) {
        const concerns = document.ai_concerns || [];
        concernsList.innerHTML = concerns.length > 0
            ? concerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')
            : '<li class="empty-list">No concerns identified</li>';
    }
    
    // Recommendations
    const recommendationsList = $('vcDocRecommendationsList');
    if (recommendationsList) {
        const recommendations = document.ai_recommendations || [];
        recommendationsList.innerHTML = recommendations.length > 0
            ? recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')
            : '<li class="empty-list">No recommendations available</li>';
    }
}

/**
 * Switch VC Document tab
 */
function switchVCDocumentTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('#vcDocTabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab panes
    document.querySelectorAll('#vcDocTabContent .tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    
    const targetPane = $(`vcDoc${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Tab`);
    targetPane?.classList.add('active');
    
    // Load content for specific tabs
    if (tabName === 'content') {
        loadVCDocumentContent();
    }
}

/**
 * Load full document content
 */
async function loadVCDocumentContent() {
    const contentRoot = $('vcDocContentDocument');
    if (!contentRoot || !AppState.vcDocuments.currentDocumentId) return;

    resetVCDocumentContentSearch();

    if (VCDocumentContentState.documentId === AppState.vcDocuments.currentDocumentId && VCDocumentContentState.contentHtml) {
        renderVCDocumentContentDocument();
        renderVCDocumentContentToc();
        return;
    }

    renderVCDocumentContentLoading();

    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/content`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();

        if (data.success) {
            VCDocumentContentState.documentId = AppState.vcDocuments.currentDocumentId;
            VCDocumentContentState.tableOfContents = data.tableOfContents || [];
            VCDocumentContentState.contentHtml = data.content || '';

            renderVCDocumentContentDocument();
            renderVCDocumentContentToc();
        } else {
            renderVCDocumentContentError('Failed to load content');
        }
    } catch (e) {
        console.error('Error loading content:', e);
        renderVCDocumentContentError('Error loading content');
    }
}

function setupVCDocumentContentViewerListeners() {
    if (VCDocumentContentState.listenersSetup) return;
    VCDocumentContentState.listenersSetup = true;

    $('vcDocSidebarCollapseBtn')?.addEventListener('click', () => {
        $('vcDocContentSidebar')?.classList.add('collapsed');
        $('vcDocSidebarExpandBtn')?.classList.add('visible');
    });

    $('vcDocSidebarExpandBtn')?.addEventListener('click', () => {
        $('vcDocContentSidebar')?.classList.remove('collapsed');
        $('vcDocSidebarExpandBtn')?.classList.remove('visible');
    });

    $('vcDocContentSearchBtn')?.addEventListener('click', () => {
        performVCDocumentContentSearch();
    });

    $('vcDocContentSearchInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performVCDocumentContentSearch();
        }
    });

    $('vcDocContentSearchClearBtn')?.addEventListener('click', () => {
        const input = $('vcDocContentSearchInput');
        if (input) input.value = '';
        resetVCDocumentContentSearch();
    });

    $('vcDocPrevSearchResult')?.addEventListener('click', () => navigateVCDocumentSearchResult(-1));
    $('vcDocNextSearchResult')?.addEventListener('click', () => navigateVCDocumentSearchResult(1));
    $('vcDocCloseSearchResults')?.addEventListener('click', () => resetVCDocumentContentSearch());

    $('vcDocContentPrintBtn')?.addEventListener('click', () => window.print());
    $('vcDocContentDownloadBtn')?.addEventListener('click', () => downloadVCDocument());
}

function resetVCDocumentContentState() {
    VCDocumentContentState.documentId = null;
    VCDocumentContentState.tableOfContents = [];
    VCDocumentContentState.contentHtml = '';
    resetVCDocumentContentSearch();
}

function renderVCDocumentContentLoading() {
    const contentRoot = $('vcDocContentDocument');
    if (contentRoot) {
        contentRoot.innerHTML = `
            <div class="content-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <p>Loading document content...</p>
            </div>
        `;
    }

    const tocList = $('vcDocContentTocList');
    if (tocList) {
        tocList.innerHTML = `
            <div class="toc-placeholder">
                <i class="fas fa-book-open"></i>
                <p>Loading sections...</p>
            </div>
        `;
    }
}

function renderVCDocumentContentError(message) {
    const contentRoot = $('vcDocContentDocument');
    if (contentRoot) {
        contentRoot.innerHTML = `
            <div class="viewer-placeholder">
                <i class="fas fa-file-alt"></i>
                <h3>Unable to load document</h3>
                <p>${escapeHtml(message || 'Failed to load document content.')}</p>
            </div>
        `;
    }
}

function renderVCDocumentContentDocument() {
    const contentRoot = $('vcDocContentDocument');
    if (!contentRoot) return;

    if (!VCDocumentContentState.contentHtml) {
        renderVCDocumentContentError('No content available for this document.');
        return;
    }

    const document = AppState.vcDocuments.currentDocument || {};
    const categoryLabels = {
        'policy': 'Policy',
        'regulation': 'Regulation',
        'memo': 'Memo',
        'circular': 'Circular',
        'directive': 'Directive',
        'agreement': 'Agreement',
        'minutes': 'Minutes',
        'budget': 'Budget',
        'audit': 'Audit',
        'strategy': 'Strategy',
        'research': 'Research',
        'compliance': 'Compliance',
        'operations': 'Operations',
        'other': 'Other'
    };

    const metaParts = [];
    if (document.category) metaParts.push(categoryLabels[document.category] || document.category);
    const dateValue = document.document_date || document.uploaded_at;
    if (dateValue) metaParts.push(formatDateTime(dateValue));
    const department = document.department || document.uploaded_by_department;
    if (department) metaParts.push(department);

    const docBadge = $('vcDocContentDocBadge');
    if (docBadge) {
        docBadge.textContent = categoryLabels[document.category] || document.category || 'VC Document';
    }

    const metaText = metaParts.join(' • ');
    const titleHtml = `
        <div class="document-title">
            <h1>${escapeHtml(document.title || 'VC Document')}</h1>
            <div class="doc-meta">${escapeHtml(metaText)}</div>
        </div>
    `;

    const bodyHtml = `
        <div class="document-body">
            ${VCDocumentContentState.contentHtml}
        </div>
    `;

    contentRoot.innerHTML = titleHtml + bodyHtml;
}

function renderVCDocumentContentToc() {
    const tocList = $('vcDocContentTocList');
    if (!tocList) return;

    if (!VCDocumentContentState.tableOfContents.length) {
        tocList.innerHTML = `
            <div class="toc-placeholder">
                <i class="fas fa-book-open"></i>
                <p>No sections detected</p>
            </div>
        `;
        return;
    }

    tocList.innerHTML = VCDocumentContentState.tableOfContents.map((item, idx) => {
        const indent = (item.level || 1) > 1 ? `style="padding-left: ${(item.level - 1) * 15}px"` : '';
        return `
            <div class="toc-chapter ${idx === 0 ? 'active' : ''}" data-section="${idx}" data-id="${escapeHtml(item.id || '')}" ${indent}>
                <div class="toc-chapter-title">${escapeHtml(item.title)}</div>
            </div>
        `;
    }).join('');

    tocList.querySelectorAll('.toc-chapter').forEach(item => {
        item.addEventListener('click', () => {
            const idx = Number(item.dataset.section);
            const sectionId = item.dataset.id || '';

            const target = resolveVCDocumentTocTarget(sectionId, idx);
            if (!target) {
                showToast('Section not found in document', 'warning');
                return;
            }

            const resolvedId = ensureIdForVCDocumentRoot(target, sectionId || VCDocumentContentState.tableOfContents?.[idx]?.id || VCDocumentContentState.tableOfContents?.[idx]?.title, getVCDocumentContentRoot());
            VCDocumentContentState.tableOfContents[idx].id = resolvedId;

            scrollVCDocumentContentToElement(target, { highlightClass: 'highlight-section', offset: 80 });

            tocList.querySelectorAll('.toc-chapter').forEach((el, i) => el.classList.toggle('active', i === idx));
        });
    });
}

function getVCDocumentContentScrollContainer() {
    return $('vcDocContentPaperArea');
}

function getVCDocumentContentRoot() {
    return $('vcDocContentDocument')?.querySelector('.document-body') || $('vcDocContentDocument');
}

function ensureIdForVCDocumentRoot(el, preferredId, root) {
    if (!el) return null;
    if (el.id) return el.id;

    const safe = String(preferredId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\-\s_]/g, '')
        .replace(/\s+/g, '-')
        .replace(/_+/g, '-')
        .replace(/\-+/g, '-')
        .replace(/^\-+|\-+$/g, '');

    const base = safe || 'section';
    let id = base;
    let i = 1;
    const scope = root || document;
    while (scope.querySelector?.(`#${CSS.escape(id)}`)) {
        i++;
        id = `${base}-${i}`;
    }

    el.id = id;
    return id;
}

function resolveVCDocumentTocTarget(sectionId, tocIdx) {
    const root = getVCDocumentContentRoot();
    if (!root) return null;

    if (sectionId) {
        try {
            const byId = root.querySelector(`#${CSS.escape(sectionId)}`) || document.getElementById(sectionId);
            if (byId && root.contains(byId)) return byId;
        } catch {
            // ignore
        }

        const byAttr = root.querySelector(`[id="${sectionId}"]`);
        if (byAttr) return byAttr;
    }

    const tocItem = VCDocumentContentState.tableOfContents?.[tocIdx];
    const wantTitle = normalizeForCompare(tocItem?.title);
    if (wantTitle) {
        const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .doc-heading');
        for (const h of headings) {
            const got = normalizeForCompare(h.textContent);
            if (!got) continue;
            if (got === wantTitle) return h;
            if (got.includes(wantTitle) || wantTitle.includes(got)) return h;
        }
    }

    const all = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .doc-heading, [id^="section-"], [id^="heading-"]');
    if (typeof tocIdx === 'number' && all[tocIdx]) return all[tocIdx];

    return null;
}

function scrollVCDocumentContentToElement(el, { highlightClass = 'highlight-section', offset = 0 } = {}) {
    const container = getVCDocumentContentScrollContainer();
    const root = getVCDocumentContentRoot();
    if (!container || !root || !el) return false;

    if (!root.contains(el)) return false;

    try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    } catch {
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const target = container.scrollTop + (eRect.top - cRect.top) - offset;
        container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }

    if (highlightClass) {
        el.classList.add(highlightClass);
        setTimeout(() => el.classList.remove(highlightClass), 2000);
    }

    return true;
}

function resetVCDocumentContentSearch() {
    VCDocumentContentState.searchResults = [];
    VCDocumentContentState.currentSearchIndex = 0;
    clearVCDocumentContentHighlights();
    hideVCDocumentSearchResults();
}

function clearVCDocumentContentHighlights() {
    const root = getVCDocumentContentRoot();
    if (!root) return;
    root.querySelectorAll?.('.search-highlight')?.forEach(el => {
        const text = document.createTextNode(el.textContent || '');
        if (el.parentNode) el.parentNode.replaceChild(text, el);
    });
}

function hideVCDocumentSearchResults() {
    const section = $('vcDocSearchResultsSection');
    if (section) {
        section.classList.add('hidden');
        section.classList.remove('visible');
    }
}

function showVCDocumentSearchResults() {
    const section = $('vcDocSearchResultsSection');
    if (section) {
        section.classList.remove('hidden');
        section.classList.add('visible');
    }
}

function navigateVCDocumentSearchResult(delta) {
    if (!VCDocumentContentState.searchResults.length) {
        showToast('No search results', 'info');
        return;
    }

    VCDocumentContentState.currentSearchIndex += delta;
    if (VCDocumentContentState.currentSearchIndex < 0) {
        VCDocumentContentState.currentSearchIndex = VCDocumentContentState.searchResults.length - 1;
    } else if (VCDocumentContentState.currentSearchIndex >= VCDocumentContentState.searchResults.length) {
        VCDocumentContentState.currentSearchIndex = 0;
    }

    scrollToVCDocumentSearchResult(VCDocumentContentState.currentSearchIndex);
}

function updateVCDocumentSearchPosition() {
    const posEl = $('vcDocSearchResultPosition');
    if (posEl && VCDocumentContentState.searchResults.length) {
        posEl.textContent = `${VCDocumentContentState.currentSearchIndex + 1}/${VCDocumentContentState.searchResults.length}`;
    }
}

function showVCDocumentSearchResultsInSidebar(query) {
    const countEl = $('vcDocSearchResultsCount');
    const listEl = $('vcDocSearchResultsList');
    if (!listEl) return;

    const count = VCDocumentContentState.searchResults.length;
    if (count === 0) {
        hideVCDocumentSearchResults();
        showToast('No matches found', 'info');
        return;
    }

    showVCDocumentSearchResults();
    if (countEl) countEl.textContent = `${count} result${count !== 1 ? 's' : ''}`;

    listEl.innerHTML = VCDocumentContentState.searchResults.slice(0, 100).map((result, idx) => `
        <div class="search-result-item ${idx === 0 ? 'active' : ''}" data-index="${idx}">
            <div class="search-result-context">${escapeHtml(result.context)}</div>
        </div>
    `).join('');

    listEl.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const idx = parseInt(item.dataset.index, 10);
            VCDocumentContentState.currentSearchIndex = idx;
            scrollToVCDocumentSearchResult(idx);
        });
    });

    updateVCDocumentSearchPosition();

    if (count > 0) {
        scrollToVCDocumentSearchResult(0);
    }
}

function performVCDocumentContentSearch() {
    const rawQuery = $('vcDocContentSearchInput')?.value?.trim();
    if (!rawQuery || rawQuery.length < 2) {
        showToast('Please enter at least 2 characters to search', 'info');
        return;
    }

    resetVCDocumentContentSearch();

    const root = getVCDocumentContentRoot();
    if (!root) {
        showToast('No document loaded', 'warning');
        return;
    }

    const caseSensitive = false;
    const searchTerms = parseSearchQuery(rawQuery);
    if (searchTerms.length === 0) {
        showToast('Please enter a valid search term', 'info');
        return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
            if (!n || !n.parentNode) return NodeFilter.FILTER_REJECT;
            const parent = n.parentNode;
            if (parent.classList && parent.classList.contains('search-highlight')) return NodeFilter.FILTER_REJECT;
            const text = n.textContent || '';
            if (text.trim().length < 2) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const matches = [];
    let node;

    while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (!matchesSearchCriteria(text, searchTerms, caseSensitive)) continue;

        for (const term of searchTerms) {
            const needle = caseSensitive ? term.value : term.value.toLowerCase();
            const hay = caseSensitive ? text : text.toLowerCase();
            if (!needle) continue;

            let from = 0;
            while (from < hay.length) {
                const at = hay.indexOf(needle, from);
                if (at === -1) break;
                matches.push({ node, start: at, end: at + needle.length, term: text.substring(at, at + needle.length) });
                from = at + Math.max(1, needle.length);
            }
        }
    }

    if (!matches.length) {
        showToast('No matches found', 'info');
        return;
    }

    matches.sort((a, b) => {
        if (a.node === b.node) return b.start - a.start;
        return 0;
    });

    let globalIdx = 0;
    const perNode = new Map();

    for (const m of matches) {
        const list = perNode.get(m.node) || [];
        list.push(m);
        perNode.set(m.node, list);
    }

    perNode.forEach((nodeMatches, textNode) => {
        let working = textNode;
        for (const m of nodeMatches) {
            try {
                const full = working.textContent || '';
                if (m.end > full.length) continue;

                const after = working.splitText(m.end);
                const mid = working.splitText(m.start);

                const span = document.createElement('span');
                span.className = 'search-highlight';
                span.setAttribute('data-search-index', String(globalIdx));
                span.textContent = mid.textContent || '';

                mid.parentNode?.replaceChild(span, mid);

                const context = getContextAroundMatch(full, span.textContent);
                VCDocumentContentState.searchResults.push({
                    index: globalIdx,
                    context,
                    term: span.textContent,
                    element: span
                });

                globalIdx++;
                working = after;
            } catch {
                // Skip failed split
            }
        }
    });

    showVCDocumentSearchResultsInSidebar(rawQuery);
}

function scrollToVCDocumentSearchResult(idx) {
    if (idx < 0 || idx >= VCDocumentContentState.searchResults.length) return;

    const result = VCDocumentContentState.searchResults[idx];
    const contentRoot = $('vcDocContentDocument');
    if (!result || !contentRoot) return;

    document.querySelectorAll('#vcDocSearchResultsList .search-result-item').forEach((item, i) => {
        item.classList.toggle('active', i === idx);
    });

    const sidebarItem = document.querySelector(`#vcDocSearchResultsList .search-result-item[data-index="${idx}"]`);
    sidebarItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let el = result.element;
    if (!el || !el.isConnected) {
        el = contentRoot.querySelector(`.search-highlight[data-search-index="${idx}"]`);
    }
    if (!el) {
        const all = contentRoot.querySelectorAll('.search-highlight');
        el = all[idx] || null;
    }

    if (!el) return;

    contentRoot.querySelectorAll('.search-highlight-current').forEach(x => x.classList.remove('search-highlight-current'));
    el.classList.add('search-highlight-current');

    scrollVCDocumentContentToElement(el, { highlightClass: null, offset: 120 });

    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);

    updateVCDocumentSearchPosition();
}

/**
 * Mark document as read
 */
async function markVCDocumentAsRead(documentId) {
    try {
        await fetch(`${AppState.apiBase}/api/vc-documents/${documentId}/read`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        
        // Update UI
        document.querySelector(`.vc-document-item[data-id="${documentId}"]`)?.classList.remove('unread');
        
        // Refresh stats
        loadVCDocumentsStats();
    } catch (e) {
        console.error('Error marking read:', e);
    }
}

/**
 * Toggle star on current document
 */
async function toggleVCDocumentStar() {
    if (!AppState.vcDocuments.currentDocumentId) return;
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/star`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            // Update UI
            const starBtn = $('vcDocStarBtn');
            if (starBtn) {
                starBtn.innerHTML = `<i class="fa${data.isStarred ? 's' : 'r'} fa-star"></i>`;
                starBtn.classList.toggle('starred', data.isStarred);
            }
            
            // Refresh list and stats
            loadVCDocuments();
            loadVCDocumentsStats();
        }
    } catch (e) {
        console.error('Error toggling star:', e);
        showToast('Failed to update star', 'error');
    }
}

/**
 * Archive current document
 */
async function archiveVCDocument() {
    if (!AppState.vcDocuments.currentDocumentId) return;

    const isArchived = !!AppState.vcDocuments.currentDocument?.is_archived;
    const action = isArchived ? 'unarchive' : 'archive';
    const actionLabel = isArchived ? 'Unarchive' : 'Archive';

    if (!confirm(`${actionLabel} this document?`)) return;

    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/${action}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();

        if (data.success) {
            showToast(`Document ${isArchived ? 'unarchived' : 'archived'}`, 'success');

            // Reset view and reload
            AppState.vcDocuments.currentDocumentId = null;
            AppState.vcDocuments.currentDocument = null;

            $('vcDocPlaceholder')?.classList.remove('hidden');
            $('vcDocHeader')?.classList.add('hidden');
            $('vcDocTabs')?.classList.add('hidden');
            $('vcDocTabContent')?.classList.add('hidden');

            loadVCDocuments();
            loadVCDocumentsStats();
        }
    } catch (e) {
        console.error('Error archiving:', e);
        showToast(`Failed to ${actionLabel.toLowerCase()} document`, 'error');
    }
}

/**
 * Permanently delete current document
 */
async function deleteVCDocumentPermanently() {
    if (!AppState.vcDocuments.currentDocumentId) return;

    if (!isSuperAdmin()) {
        showToast('Only superadmin can permanently delete documents', 'error');
        return;
    }

    if (!AppState.vcDocuments.currentDocument?.is_archived) {
        showToast('Archive the document before permanent deletion', 'info');
        return;
    }

    if (!confirm('Permanently delete this document? This cannot be undone.')) return;

    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/hard`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();

        if (data.success) {
            showToast('Document permanently deleted', 'success');

            AppState.vcDocuments.currentDocumentId = null;
            AppState.vcDocuments.currentDocument = null;

            $('vcDocPlaceholder')?.classList.remove('hidden');
            $('vcDocHeader')?.classList.add('hidden');
            $('vcDocTabs')?.classList.add('hidden');
            $('vcDocTabContent')?.classList.add('hidden');

            loadVCDocuments();
            loadVCDocumentsStats();
        } else {
            showToast(data.error || 'Failed to delete document', 'error');
        }
    } catch (e) {
        console.error('Error deleting document:', e);
        showToast('Failed to delete document', 'error');
    }
}

/**
 * Download original document file
 */
function downloadVCDocument() {
    if (!AppState.vcDocuments.currentDocumentId) return;
    
    window.open(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/download`, '_blank');
}

/**
 * Re-analyze document with AI
 */
async function reanalyzeVCDocument() {
    if (!AppState.vcDocuments.currentDocumentId) return;
    
    const btn = $('vcDocReanalyzeBtn');
    const originalHtml = btn?.innerHTML;
    
    try {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
        btn.disabled = true;
        
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/reanalyze`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('Document re-analyzed successfully', 'success');
            
            // Reload document details
            await selectVCDocument(AppState.vcDocuments.currentDocumentId);
        } else {
            showToast(data.error || 'Failed to re-analyze', 'error');
        }
    } catch (e) {
        console.error('Error reanalyzing:', e);
        showToast('Failed to re-analyze document', 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
}

// ========== VC REPORT CHAT ==========

/**
 * Initialize chat for a document
 */
async function initVCDocumentChat(documentId) {
    try {
        // Get existing sessions or create new one
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${documentId}/chat/sessions`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success && data.sessions.length > 0) {
            // Use most recent session
            AppState.vcDocuments.chatSessionToken = data.sessions[0].session_token;
            await loadVCDocumentChatHistory(data.sessions[0].session_token);
        } else {
            // Create new session
            const createRes = await fetch(`${AppState.apiBase}/api/vc-documents/${documentId}/chat/sessions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${AppState.token}` }
            });
            const createData = await createRes.json();
            
            if (createData.success) {
                AppState.vcDocuments.chatSessionToken = createData.session.sessionToken;
            }
        }
    } catch (e) {
        console.error('Error initializing chat:', e);
    }
}

/**
 * Load chat history
 */
async function loadVCDocumentChatHistory(sessionToken) {
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/chat/${sessionToken}/history`, {
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success && data.messages.length > 0) {
            const messagesEl = $('vcDocChatMessages');
            messagesEl.innerHTML = '';
            
            data.messages.forEach(msg => {
                appendVCDocumentChatMessage(msg.role, msg.content, msg.audioUrl || msg.audio_url);
            });
        }
    } catch (e) {
        console.error('Error loading chat history:', e);
    }
}

/**
 * Handle chat form submit
 */
async function handleVCDocumentChatSubmit(e) {
    e.preventDefault();
    
    const input = $('vcDocChatInput');
    const message = input?.value?.trim();
    
    if (!message || !AppState.vcDocuments.chatSessionToken) return;
    
    if (AppState.voiceModeEnabled) {
        const target = getVoiceModeTarget();
        voiceModeAwaitingResponse = true;
        stopRecording({ recordingId: target.recordingId });
    }

    input.value = '';
    
    await sendVCDocumentChatMessage(message);
}

/**
 * Send chat message
 */
async function sendVCDocumentChatMessage(message) {
    // Hide welcome and add user message
    const welcomeEl = document.querySelector('#vcDocChatMessages .chat-welcome');
    if (welcomeEl) welcomeEl.style.display = 'none';
    
    appendVCDocumentChatMessage('user', message);
    
    // Show typing indicator
    const typingId = 'vc-typing-' + Date.now();
    appendVCDocumentChatMessage('assistant', '<i class="fas fa-spinner fa-spin"></i> Thinking...', null, typingId);
    
    try {
        const voiceTarget = AppState.voiceModeEnabled ? getVoiceModeTarget() : null;
        const wantsAudio = AppState.voiceModeEnabled && voiceTarget?.page === 'vc-documents';
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/chat/${AppState.vcDocuments.chatSessionToken}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${AppState.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message,
                voice: wantsAudio ? getSelectedTtsVoice() : null,
                withAudio: wantsAudio
            })
        });
        const data = await res.json();
        
        // Remove typing indicator
        document.getElementById(typingId)?.remove();
        
        if (data.success) {
            appendVCDocumentChatMessage('assistant', data.response, data.audioUrl);
            handleVoiceModeAssistantResponse(data.response, data.audioUrl);
        } else {
            appendVCDocumentChatMessage('assistant', 'Sorry, I encountered an error. Please try again.');
            if (AppState.voiceModeEnabled) {
                voiceModeAwaitingResponse = false;
                startVoiceModeListening();
            }
        }
    } catch (e) {
        console.error('Error sending message:', e);
        document.getElementById(typingId)?.remove();
        appendVCDocumentChatMessage('assistant', 'Failed to send message. Please try again.');
        if (AppState.voiceModeEnabled) {
            voiceModeAwaitingResponse = false;
            startVoiceModeListening();
        }
    }
}

/**
 * Append chat message to UI
 */
function appendVCDocumentChatMessage(role, content, audioUrl = null, id = null) {
    const messagesEl = $('vcDocChatMessages');
    if (!messagesEl) return;
    
    const div = document.createElement('div');
    div.className = `vc-chat-message ${role}`;
    if (id) div.id = id;
    
    const icon = role === 'user' ? 'fa-user' : 'fa-robot';
    
    const resolvedAudioUrl = resolveAudioUrl(audioUrl);
    const audioHtml = resolvedAudioUrl
        ? `<div class="message-audio"><audio controls src="${escapeHtml(resolvedAudioUrl)}"></audio></div>`
        : '';

    div.innerHTML = `
        <div class="message-avatar"><i class="fas ${icon}"></i></div>
        <div class="message-content">${role === 'assistant' ? parseMarkdown(content) : escapeHtml(content)}${audioHtml}</div>
    `;
    
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ========== VC REPORT NOTES ==========

/**
 * Render notes list
 */
function renderVCDocumentNotes(notes) {
    const listEl = $('vcDocNotesList');
    if (!listEl) return;
    
    if (!notes || notes.length === 0) {
        listEl.innerHTML = `
            <div class="no-notes">
                <i class="fas fa-sticky-note"></i>
                <p>No notes yet. Click "Add Note" to create one.</p>
            </div>
        `;
        return;
    }
    
    listEl.innerHTML = notes.map(note => `
        <div class="note-item" data-id="${note.id}">
            <div class="note-header">
                <span class="note-date">${new Date(note.created_at).toLocaleString()}</span>
                <div class="note-actions">
                    <button class="btn btn-xs btn-outline" onclick="editVCDocumentNote(${note.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-xs btn-outline" onclick="deleteVCDocumentNote(${note.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="note-text">${escapeHtml(note.note_text)}</div>
        </div>
    `).join('');
}

/**
 * Show note modal
 */
function showVCDocumentNoteModal(noteId = null, noteText = '') {
    $('vcDocNoteModalTitle').textContent = noteId ? 'Edit Note' : 'Add Note';
    $('vcDocNoteId').value = noteId || '';
    $('vcDocNoteText').value = noteText;
    $('vcDocNoteModal')?.classList.add('show');
}

function closeVCDocumentNoteModal() {
    $('vcDocNoteModal')?.classList.remove('show');
}

/**
 * Handle note save
 */
async function handleVCDocumentNoteSave(e) {
    e.preventDefault();
    
    const noteId = $('vcDocNoteId')?.value;
    const noteText = $('vcDocNoteText')?.value?.trim();
    
    if (!noteText || !AppState.vcDocuments.currentDocumentId) return;
    
    try {
        let res;
        if (noteId) {
            // Update existing
            res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/notes/${noteId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${AppState.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ noteText })
            });
        } else {
            // Create new
            res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/notes`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${AppState.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ noteText })
            });
        }
        
        const data = await res.json();
        
        if (data.success) {
            showToast('Note saved', 'success');
            closeVCDocumentNoteModal();
            
            // Reload document to get updated notes
            await selectVCDocument(AppState.vcDocuments.currentDocumentId);
            switchVCDocumentTab('notes');
        } else {
            showToast(data.error || 'Failed to save note', 'error');
        }
    } catch (e) {
        console.error('Error saving note:', e);
        showToast('Failed to save note', 'error');
    }
}

/**
 * Add new note
 */
function addVCDocumentNote() {
    showVCDocumentNoteModal();
}

/**
 * Edit existing note
 */
function editVCDocumentNote(noteId) {
    const note = AppState.vcDocuments.notes.find(n => n.id === noteId);
    if (note) {
        showVCDocumentNoteModal(noteId, note.note_text);
    }
}

/**
 * Delete note
 */
async function deleteVCDocumentNote(noteId) {
    if (!confirm('Delete this note?')) return;
    
    try {
        const res = await fetch(`${AppState.apiBase}/api/vc-documents/${AppState.vcDocuments.currentDocumentId}/notes/${noteId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${AppState.token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('Note deleted', 'success');
            await selectVCDocument(AppState.vcDocuments.currentDocumentId);
            switchVCDocumentTab('notes');
        }
    } catch (e) {
        console.error('Error deleting note:', e);
        showToast('Failed to delete note', 'error');
    }
}

// ========== VC REPORT UPLOAD ==========

function showVCDocumentUploadModal() {
    $('vcDocUploadForm')?.reset();
    $('vcDocUploadFileName').textContent = '';
    $('vcDocUploadDepartment').value = AppState.user?.department || '';
    $('vcDocUploadModal')?.classList.add('show');
}

function closeVCDocumentUploadModal() {
    $('vcDocUploadModal')?.classList.remove('show');
}

/**
 * Handle document upload
 */
async function handleVCDocumentUpload(e) {
    e.preventDefault();
    
    const formData = new FormData();
    formData.append('title', $('vcDocUploadTitle')?.value?.trim());
    formData.append('description', $('vcDocUploadDescription')?.value?.trim());
    formData.append('category', $('vcDocUploadCategory')?.value);
    formData.append('documentDate', $('vcDocUploadDate')?.value);
    formData.append('department', $('vcDocUploadDepartment')?.value?.trim());
    
    const file = $('vcDocUploadFile')?.files[0];
    if (!file) {
        showToast('Please select a file', 'error');
        return;
    }
    formData.append('file', file);
    
    const submitBtn = document.querySelector('#vcDocUploadForm button[type="submit"]');
    const originalHtml = submitBtn?.innerHTML;
    
    try {
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
        submitBtn.disabled = true;
        
        await apiFetch('/api/vc-documents/upload', {
            method: 'POST',
            body: formData,
            isForm: true
        });

        showToast('Document submitted successfully! Processing will begin shortly.', 'success');
        closeVCDocumentUploadModal();
        loadVCDocuments();
        loadVCDocumentsStats();
    } catch (e) {
        console.error('Error uploading document:', e);
        const fallback = e?.status === 413
            ? 'File too large. Please upload a smaller file.'
            : 'Failed to upload document';
        const message = (e?.message && !String(e.message).startsWith('Request failed'))
            ? e.message
            : fallback;
        showToast(message, 'error');
    } finally {
        submitBtn.innerHTML = originalHtml;
        submitBtn.disabled = false;
    }
}

// =========================
// FAQ Page
// =========================

const FAQState = {
    categories: [],
    currentCategory: null,
    popularFaqs: [],
    searchResults: [],
    currentFaqId: null,
    initialized: false
};

async function initFAQPage() {
    if (FAQState.initialized) {
        // Just refresh popular FAQs
        loadPopularFaqs();
        return;
    }
    
    // Setup event listeners
    setupFAQEventListeners();
    
    // Load initial data
    await Promise.all([
        loadFAQCategories(),
        loadPopularFaqs()
    ]);
    
    FAQState.initialized = true;
}

function setupFAQEventListeners() {
    // Search functionality
    $('faqSearchBtn')?.addEventListener('click', searchFAQs);
    $('faqSearchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchFAQs();
    });
    
    // Ask AI link
    $('faqAskAiLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        const query = $('faqSearchInput')?.value?.trim();
        if (query) {
            // Pre-fill chat with the query
            showPage('chat');
            setTimeout(() => {
                const chatInput = $('chatInput');
                if (chatInput) {
                    chatInput.value = query;
                    chatInput.focus();
                }
            }, 100);
        } else {
            showPage('chat');
        }
    });
    
    // Back to categories button
    $('faqBackToCategories')?.addEventListener('click', () => {
        $('faqResultsSection')?.classList.add('hidden');
        $('popularFaqSection')?.classList.remove('hidden');
        document.querySelector('.faq-categories-section')?.classList.remove('hidden');
        FAQState.currentCategory = null;
    });
    
    // FAQ detail close button
    $('faqDetailClose')?.addEventListener('click', closeFAQDetail);
    
    // Click outside to close detail
    $('faqDetailOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'faqDetailOverlay') closeFAQDetail();
    });
    
    // Helpful feedback buttons
    $('faqHelpfulYes')?.addEventListener('click', () => submitFAQFeedback(true));
    $('faqHelpfulNo')?.addEventListener('click', () => submitFAQFeedback(false));
}

async function loadFAQCategories() {
    const container = $('faqCategoriesGrid');
    if (!container) return;
    
    container.innerHTML = `
        <div class="faq-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading categories...</p>
        </div>
    `;
    
    try {
        const res = await apiFetch('/api/faq/categories');
        FAQState.categories = res.categories || [];
        renderFAQCategories();
    } catch (e) {
        container.innerHTML = `
            <div class="faq-empty">
                <i class="fas fa-exclamation-circle"></i>
                <h3>Failed to load categories</h3>
                <p>${escapeHtml(e.message)}</p>
            </div>
        `;
    }
}

function renderFAQCategories() {
    const container = $('faqCategoriesGrid');
    if (!container) return;
    
    if (FAQState.categories.length === 0) {
        container.innerHTML = `
            <div class="faq-empty">
                <i class="fas fa-folder-open"></i>
                <h3>No categories yet</h3>
                <p>FAQ categories will appear here once they're set up.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = FAQState.categories.map(cat => `
        <div class="faq-category-card" data-category-id="${cat.id}">
            <div class="faq-category-icon">
                <i class="${escapeHtml(cat.icon || 'fas fa-folder')}"></i>
            </div>
            <div class="faq-category-info">
                <h3>${escapeHtml(cat.name)}</h3>
                <p>${escapeHtml(cat.description || '')}</p>
                <span class="faq-category-count">${cat.qa_count || 0} questions</span>
            </div>
        </div>
    `).join('');
    
    // Add click handlers
    container.querySelectorAll('.faq-category-card').forEach(card => {
        card.addEventListener('click', () => {
            const categoryId = card.dataset.categoryId;
            loadFAQsByCategory(categoryId);
        });
    });
}

async function loadPopularFaqs() {
    const container = $('popularFaqList');
    if (!container) return;
    
    container.innerHTML = `
        <div class="faq-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading popular questions...</p>
        </div>
    `;
    
    try {
        const res = await apiFetch('/api/faq/popular?limit=5');
        FAQState.popularFaqs = res.faqs || [];
        renderFAQList(container, FAQState.popularFaqs, 'No popular questions yet');
        
        // Hide section if no popular FAQs
        const section = $('popularFaqSection');
        if (section) {
            section.classList.toggle('hidden', FAQState.popularFaqs.length === 0);
        }
    } catch (e) {
        container.innerHTML = '';
        $('popularFaqSection')?.classList.add('hidden');
    }
}

async function loadFAQsByCategory(categoryId) {
    const category = FAQState.categories.find(c => String(c.id) === String(categoryId));
    FAQState.currentCategory = category;
    
    // Show results section, hide others
    $('popularFaqSection')?.classList.add('hidden');
    document.querySelector('.faq-categories-section')?.classList.add('hidden');
    $('faqResultsSection')?.classList.remove('hidden');
    
    $('faqResultsTitle').textContent = category ? category.name : 'Category';
    
    const container = $('faqResultsList');
    container.innerHTML = `
        <div class="faq-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading questions...</p>
        </div>
    `;
    
    try {
        const res = await apiFetch(`/api/faq/category/${categoryId}`);
        renderFAQList(container, res.faqs || [], 'No questions in this category yet');
    } catch (e) {
        container.innerHTML = `
            <div class="faq-empty">
                <i class="fas fa-exclamation-circle"></i>
                <h3>Failed to load questions</h3>
                <p>${escapeHtml(e.message)}</p>
            </div>
        `;
    }
}

async function searchFAQs() {
    const query = $('faqSearchInput')?.value?.trim();
    if (!query || query.length < 2) {
        showToast('Please enter at least 2 characters to search', 'warning');
        return;
    }
    
    // Show results section
    $('popularFaqSection')?.classList.add('hidden');
    document.querySelector('.faq-categories-section')?.classList.add('hidden');
    $('faqResultsSection')?.classList.remove('hidden');
    
    $('faqResultsTitle').textContent = `Search Results for "${escapeHtml(query)}"`;
    
    const container = $('faqResultsList');
    container.innerHTML = `
        <div class="faq-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Searching...</p>
        </div>
    `;
    
    try {
        const res = await apiFetch(`/api/faq/search?q=${encodeURIComponent(query)}`);
        FAQState.searchResults = res.results || [];
        
        if (FAQState.searchResults.length === 0) {
            container.innerHTML = `
                <div class="faq-empty">
                    <i class="fas fa-search"></i>
                    <h3>No results found</h3>
                    <p>Try different keywords or <a href="#" id="searchAskAi">ask our AI assistant</a></p>
                </div>
            `;
            $('searchAskAi')?.addEventListener('click', (e) => {
                e.preventDefault();
                showPage('chat');
                setTimeout(() => {
                    const chatInput = $('chatInput');
                    if (chatInput) {
                        chatInput.value = query;
                        chatInput.focus();
                    }
                }, 100);
            });
        } else {
            renderFAQList(container, FAQState.searchResults);
        }
    } catch (e) {
        container.innerHTML = `
            <div class="faq-empty">
                <i class="fas fa-exclamation-circle"></i>
                <h3>Search failed</h3>
                <p>${escapeHtml(e.message)}</p>
            </div>
        `;
    }
}

function renderFAQList(container, faqs, emptyMessage = 'No questions found') {
    if (!container) return;
    
    if (!faqs || faqs.length === 0) {
        container.innerHTML = `
            <div class="faq-empty">
                <i class="fas fa-question-circle"></i>
                <h3>${escapeHtml(emptyMessage)}</h3>
            </div>
        `;
        return;
    }
    
    container.innerHTML = faqs.map(faq => `
        <div class="faq-item" data-faq-id="${faq.id}">
            <div class="faq-item-question">
                <i class="fas fa-question-circle"></i>
                <span>${escapeHtml(faq.question)}</span>
            </div>
            <div class="faq-item-meta">
                ${faq.categoryName ? `<span><i class="fas fa-folder"></i> ${escapeHtml(faq.categoryName)}</span>` : ''}
                ${faq.usageCount > 0 ? `<span><i class="fas fa-eye"></i> ${faq.usageCount} views</span>` : ''}
                ${faq.isVerified ? `<span><i class="fas fa-check-circle" style="color: var(--success-color)"></i> Verified</span>` : ''}
            </div>
        </div>
    `).join('');
    
    // Add click handlers
    container.querySelectorAll('.faq-item').forEach(item => {
        item.addEventListener('click', () => {
            const faqId = item.dataset.faqId;
            openFAQDetail(faqId);
        });
    });
}

async function openFAQDetail(faqId) {
    FAQState.currentFaqId = faqId;
    
    // Show overlay with loading state
    const overlay = $('faqDetailOverlay');
    overlay?.classList.remove('hidden');
    
    $('faqDetailCategory').textContent = 'Loading...';
    $('faqDetailQuestion').textContent = '';
    $('faqDetailAnswer').innerHTML = '<div class="faq-loading"><i class="fas fa-spinner fa-spin"></i></div>';
    $('faqDetailSources').innerHTML = '';
    
    // Reset feedback buttons
    $('faqHelpfulYes')?.classList.remove('active');
    $('faqHelpfulNo')?.classList.remove('active');
    
    try {
        const res = await apiFetch(`/api/faq/item/${faqId}`);
        const faq = res.faq;
        
        $('faqDetailCategory').textContent = faq.categoryName || 'General';
        $('faqDetailQuestion').textContent = faq.question;
        $('faqDetailAnswer').innerHTML = formatFAQAnswer(faq.answer);
        
        // Show sources if available
        const sourcesContainer = $('faqDetailSources');
        if (faq.answerSources && faq.answerSources.length > 0) {
            sourcesContainer.innerHTML = `
                <h4>Sources</h4>
                <ul>
                    ${faq.answerSources.map(src => `<li><i class="fas fa-file-alt"></i> ${escapeHtml(src)}</li>`).join('')}
                </ul>
            `;
        } else {
            sourcesContainer.innerHTML = '';
        }
    } catch (e) {
        $('faqDetailAnswer').innerHTML = `<p style="color: var(--error-color)">Failed to load: ${escapeHtml(e.message)}</p>`;
    }
}

function formatFAQAnswer(answer) {
    if (!answer) return '';
    
    // Convert line breaks to paragraphs and handle basic formatting
    let formatted = escapeHtml(answer);
    
    // Convert double line breaks to paragraphs
    formatted = formatted.split(/\n\n+/).map(p => `<p>${p}</p>`).join('');
    
    // Convert single line breaks within paragraphs
    formatted = formatted.replace(/\n/g, '<br>');
    
    // Convert bullet points
    formatted = formatted.replace(/<p>[-•]\s*/g, '<li>').replace(/<\/p>(\s*<li>)/g, '</li>$1');
    
    return formatted;
}

function closeFAQDetail() {
    $('faqDetailOverlay')?.classList.add('hidden');
    FAQState.currentFaqId = null;
}

async function submitFAQFeedback(helpful) {
    if (!FAQState.currentFaqId) return;
    
    // Update UI
    $('faqHelpfulYes')?.classList.toggle('active', helpful);
    $('faqHelpfulNo')?.classList.toggle('active', !helpful);
    
    try {
        await apiFetch(`/api/faq/item/${FAQState.currentFaqId}/feedback`, {
            method: 'POST',
            body: JSON.stringify({ helpful })
        });
        showToast('Thanks for your feedback!', 'success');
    } catch (e) {
        // Silently fail - feedback is not critical
        console.error('FAQ feedback failed:', e);
    }
}

// =========================
// Document Viewer
// =========================

function initViewerPage() {
    if (!AppState.token) {
        showPage('login');
        return;
    }
    
    // Initialize event listeners (only once)
    if (!ViewerState.listenersSetup) {
        setupViewerEventListeners();
        ViewerState.listenersSetup = true;
    }
    
    // Load bookmarks from localStorage
    loadBookmarksFromStorage();
    
    // Load documents into selector dropdown
    loadDocumentsForViewer();
    
    // If we have a document ID, load it
    if (ViewerState.currentDocId) {
        loadDocumentInViewer(ViewerState.currentDocId);
    }
}

function setupViewerEventListeners() {
    // Sidebar collapse/expand buttons
    $('sidebarCollapseBtn')?.addEventListener('click', () => {
        $('viewerSidebar')?.classList.add('collapsed');
        $('sidebarExpandBtn')?.classList.add('visible');
    });
    
    $('sidebarExpandBtn')?.addEventListener('click', () => {
        $('viewerSidebar')?.classList.remove('collapsed');
        $('sidebarExpandBtn')?.classList.remove('visible');
    });
    
    // Document selector dropdown
    $('viewerDocSelector')?.addEventListener('change', (e) => {
        const docId = e.target.value;
        if (docId) loadDocumentInViewer(docId);
    });
    
    // Zoom controls
    $('zoomInBtn')?.addEventListener('click', () => adjustZoom(10));
    $('zoomOutBtn')?.addEventListener('click', () => adjustZoom(-10));
    
    // Print
    $('printDocBtn')?.addEventListener('click', printDocument);
    
    // Download document
    $('downloadDocBtn')?.addEventListener('click', downloadCurrentDocument);
    
    // Text search button click
    $('viewerSearchBtn')?.addEventListener('click', () => {
        performTextSearch();
    });
    
    // Text search with Enter key
    $('viewerTextSearch')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performTextSearch();
        }
    });
    
    // Clear search button
    $('searchClearBtn')?.addEventListener('click', () => {
        const input = $('viewerTextSearch');
        if (input) input.value = '';
        resetSearchState();
    });
    
    // Search navigation
    $('prevSearchResult')?.addEventListener('click', () => navigateSearchResult(-1));
    $('nextSearchResult')?.addEventListener('click', () => navigateSearchResult(1));
    $('closeSearchResults')?.addEventListener('click', () => {
        resetSearchState();
    });
    
    // Ask AI button - navigate to chat page with document context
    $('viewerAskAiBtn')?.addEventListener('click', askAiAboutDocument);
    
    // Scroll tracking for progress bar
    $('viewerPaperArea')?.addEventListener('scroll', () => {
        updateReadingProgress();
        updateActiveChapterOnScroll();
    });
}

function goToSectionById(sectionId, idx) {
    const target = resolveTocTarget(sectionId, idx);
    if (!target) {
        showToast('Section not found in document', 'warning');
        return;
    }

    const resolvedId = ensureId(target, sectionId || ViewerState.tableOfContents?.[idx]?.id || ViewerState.tableOfContents?.[idx]?.title);
    ViewerState.tableOfContents[idx].id = resolvedId;

    scrollViewerToElement(target, { highlightClass: 'highlight-section', offset: 80 });

    document.querySelectorAll('.toc-chapter').forEach((el, i) => el.classList.toggle('active', i === idx));
    ViewerState.currentSectionIndex = idx;
}

function navigateToSmartResult(idx) {
    const results = ViewerState.smartSearchResults;
    if (!results || idx < 0 || idx >= results.length) return;
    
    ViewerState.currentSmartSearchIndex = idx;
    const result = results[idx];
    
    // Update UI
    const posEl = $('searchResultPosition');
    if (posEl) posEl.textContent = `${idx + 1}/${results.length}`;
    
    // Update active state in sidebar
    document.querySelectorAll('#searchResultsList .search-result-item').forEach((item, i) => {
        item.classList.toggle('active', i === idx);
        if (i === idx) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    
    // Clear previous highlights
    clearSearchHighlights();
    
    const paperArea = $('viewerPaperArea');
    const docBody = $('viewerContent')?.querySelector('.document-body') || $('viewerContent');
    if (!docBody || !paperArea) return;
    
    // Get the content from the result to search for
    const searchContent = result.content || result.excerpt || '';
    if (!searchContent) {
        // Fallback: try to use chunk mapping
        if (result.chunkIndex !== undefined) {
            navigateToChunk(result.chunkIndex);
        }
        return;
    }
    
    // Extract multiple search phrases from the content
    const phrases = extractSearchPhrases(searchContent);
    
    // Search for matching text in the document
    const walker = document.createTreeWalker(docBody, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let bestMatch = null;
    let bestScore = 0;
    
    while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (text.trim().length < 20) continue;
        
        const textLower = text.toLowerCase();
        
        // Calculate match score based on how many phrases match
        let score = 0;
        for (const phrase of phrases) {
            if (textLower.includes(phrase.toLowerCase())) {
                score += phrase.length;
            }
        }
        
        if (score > bestScore) {
            bestScore = score;
            bestMatch = node;
        }
    }
    
    if (bestMatch && bestMatch.parentNode) {
        // Highlight the matched text
        const span = document.createElement('span');
        span.className = 'search-highlight smart-result-highlight';
        span.textContent = bestMatch.textContent;
        bestMatch.parentNode.replaceChild(span, bestMatch);
        
        // Scroll to the highlighted element
        setTimeout(() => {
            const paperRect = paperArea.getBoundingClientRect();
            const spanRect = span.getBoundingClientRect();
            const currentScrollTop = paperArea.scrollTop;
            const targetScrollTop = spanRect.top - paperRect.top + currentScrollTop - (paperRect.height / 3);
            
            paperArea.scrollTo({
                top: Math.max(0, targetScrollTop),
                behavior: 'smooth'
            });
            
            span.classList.add('flash');
            setTimeout(() => span.classList.remove('flash'), 2000);
        }, 100);
    } else if (result.chunkIndex !== undefined) {
        // Fallback: navigate using chunk mapping
        navigateToChunk(result.chunkIndex);
    } else {
        showToast('Could not locate exact position in document', 'warning');
    }
}

function extractSearchPhrases(content) {
    if (!content) return [];
    
    const phrases = [];
    const words = content.split(/\s+/).filter(w => w.length > 3);
    
    // Get unique meaningful phrases (3-5 word sequences)
    for (let i = 0; i < words.length - 2; i += 3) {
        const phrase = words.slice(i, i + 4).join(' ');
        if (phrase.length > 15 && phrase.length < 100) {
            phrases.push(phrase);
        }
    }
    
    // Also add individual longer words
    words.filter(w => w.length > 6).slice(0, 5).forEach(w => phrases.push(w));
    
    return phrases.slice(0, 10); // Limit to 10 phrases
}

function applyZoom() {
    const zoomFactor = ViewerState.zoomLevel / 100;
    
    // Update CSS custom property on the root
    document.documentElement.style.setProperty('--viewer-zoom', String(zoomFactor));
    
    // Also apply directly to the document content for better compatibility
    const viewerContent = $('viewerContent');
    if (viewerContent) {
        viewerContent.style.transform = `scale(${zoomFactor})`;
        viewerContent.style.transformOrigin = 'top center';
    }
    
    // Update zoom level display
    const zoomEl = $('zoomLevel');
    if (zoomEl) {
        zoomEl.textContent = `${ViewerState.zoomLevel}%`;
    }
}

function toggleDarkMode() {
    ViewerState.darkMode = !ViewerState.darkMode;
    const viewerPage = $('viewerPage');
    if (viewerPage) {
        viewerPage.classList.toggle('dark-mode', ViewerState.darkMode);
    }
    const btn = $('darkModeToggle');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = ViewerState.darkMode ? 'fas fa-sun' : 'fas fa-moon';
        }
    }
    showToast(ViewerState.darkMode ? 'Dark mode enabled' : 'Dark mode disabled', 'info');
}

function navigateSearchResults(direction) {
    // Determine which search type is active
    const activeType = ViewerState.activeSearchType;
    
    if (activeType === 'smart' && ViewerState.smartSearchResults.length > 0) {
        ViewerState.currentSmartSearchIndex += direction;
        if (ViewerState.currentSmartSearchIndex < 0) {
            ViewerState.currentSmartSearchIndex = ViewerState.smartSearchResults.length - 1;
        } else if (ViewerState.currentSmartSearchIndex >= ViewerState.smartSearchResults.length) {
            ViewerState.currentSmartSearchIndex = 0;
        }
        const result = ViewerState.smartSearchResults[ViewerState.currentSmartSearchIndex];
        if (result) {
            navigateToSmartResult(result);
        }
        updateSearchResultsCounter();
    } else if (activeType === 'text' && ViewerState.searchResults.length > 0) {
        ViewerState.currentSearchIndex += direction;
        if (ViewerState.currentSearchIndex < 0) {
            ViewerState.currentSearchIndex = ViewerState.searchResults.length - 1;
        } else if (ViewerState.currentSearchIndex >= ViewerState.searchResults.length) {
            ViewerState.currentSearchIndex = 0;
        }
        highlightCurrentSearchResult();
        updateSearchResultsCounter();
    } else {
        showToast('No search results to navigate', 'info');
    }
}

function updateSearchResultsCounter() {
    const counter = $('searchResultsCounter');
    if (!counter) return;
    
    if (ViewerState.activeSearchType === 'smart' && ViewerState.smartSearchResults.length > 0) {
        counter.textContent = `${ViewerState.currentSmartSearchIndex + 1} / ${ViewerState.smartSearchResults.length}`;
    } else if (ViewerState.activeSearchType === 'text' && ViewerState.searchResults.length > 0) {
        counter.textContent = `${ViewerState.currentSearchIndex + 1} / ${ViewerState.searchResults.length}`;
    } else {
        counter.textContent = '';
    }
}

function highlightCurrentSearchResult() {
    // Use the unified scrollToSearchResult function for proper scrolling
    scrollToSearchResult(ViewerState.currentSearchIndex);
}

function setupDocumentContextMenu() {
    const viewerContent = $('viewerContent');
    if (!viewerContent) return;
    
    // Create context menu element if it doesn't exist
    let contextMenu = $('documentContextMenu');
    if (!contextMenu) {
        contextMenu = document.createElement('div');
        contextMenu.id = 'documentContextMenu';
        contextMenu.className = 'document-context-menu';
        contextMenu.innerHTML = `
            <div class="context-menu-item" data-action="read-aloud">
                <i class="fas fa-volume-up"></i> Read Aloud
            </div>
            <div class="context-menu-item" data-action="copy">
                <i class="fas fa-copy"></i> Copy Text
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" data-action="print">
                <i class="fas fa-print"></i> Print Document
            </div>
        `;
        document.body.appendChild(contextMenu);
        
        // Add click handlers for menu items
        contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = item.dataset.action;
                handleContextMenuAction(action);
                hideContextMenu();
            });
        });
    }
    
    // Right-click handler
    viewerContent.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY);
    });
    
    // Hide menu on click elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.document-context-menu')) {
            hideContextMenu();
        }
    });
    
    // Hide menu on scroll
    $('viewerPaperArea')?.addEventListener('scroll', hideContextMenu);
}

function showContextMenu(x, y) {
    const menu = $('documentContextMenu');
    if (!menu) return;
    
    // Position the menu
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('visible');
    ViewerState.contextMenuVisible = true;
    
    // Adjust if menu goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${y - rect.height}px`;
    }
}

function hideContextMenu() {
    const menu = $('documentContextMenu');
    if (menu) {
        menu.classList.remove('visible');
        ViewerState.contextMenuVisible = false;
    }
}

function handleContextMenuAction(action) {
    const selection = window.getSelection();
    const selectedText = selection?.toString()?.trim() || '';
    
    switch (action) {
        case 'read-aloud':
            const textToRead = selectedText || getVisibleDocumentText();
            if (textToRead) {
                readAloud(textToRead);
            } else {
                showToast('No text to read', 'warning');
            }
            break;
        case 'copy':
            if (selectedText) {
                navigator.clipboard.writeText(selectedText).then(() => {
                    showToast('Text copied to clipboard', 'success');
                });
            } else {
                copyCurrentSectionText();
            }
            break;
        case 'print':
            printDocument();
            break;
    }
}

function getVisibleDocumentText() {
    const docBody = $('viewerContent')?.querySelector('.document-body');
    if (!docBody) return '';
    return docBody.textContent?.trim() || '';
}

async function summarizeText(text) {
    if (!text || text.length < 50) {
        showToast('Please select more text to summarize (at least 50 characters)', 'info');
        return;
    }
    
    showLoading(true, 'Generating summary...');
    
    try {
        const res = await apiFetch('/api/chat/summarize', {
            method: 'POST',
            body: { text: text.substring(0, 5000) } // Limit text length
        });
        
        showSummaryModal(res.summary || 'No summary generated');
    } catch (e) {
        console.error('Summarize error:', e);
        showToast('Failed to generate summary: ' + (e.message || 'Unknown error'), 'error');
    } finally {
        showLoading(false);
    }
}

async function summarizeDocument() {
    if (!ViewerState.currentDocId) {
        showToast('No document loaded', 'warning');
        return;
    }
    
    showLoading(true, 'Generating document summary...');
    
    try {
        const res = await apiFetch(`/api/documents/${ViewerState.currentDocId}/summarize`, {
            method: 'POST'
        });
        
        showSummaryModal(res.summary || 'No summary generated', ViewerState.currentDoc?.title);
    } catch (e) {
        console.error('Document summarize error:', e);
        showToast('Failed to generate summary: ' + (e.message || 'Unknown error'), 'error');
    } finally {
        showLoading(false);
    }
}

function showSummaryModal(summary, title = 'Summary') {
    // Create modal if it doesn't exist
    let modal = $('summaryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'summaryModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal summary-modal">
                <div class="modal-header">
                    <h3 id="summaryModalTitle"><i class="fas fa-compress-alt"></i> Summary</h3>
                    <button class="btn btn-sm btn-outline modal-close" onclick="closeSummaryModal()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="summary-content" id="summaryContent"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-outline" onclick="copySummary()">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                    <button class="btn btn-outline" onclick="readSummaryAloud()">
                        <i class="fas fa-volume-up"></i> Read Aloud
                    </button>
                    <button class="btn btn-primary" onclick="closeSummaryModal()">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    // Update content
    const titleEl = $('summaryModalTitle');
    if (titleEl) titleEl.innerHTML = `<i class="fas fa-compress-alt"></i> ${escapeHtml(title)}`;
    
    const contentEl = $('summaryContent');
    if (contentEl) contentEl.innerHTML = escapeHtml(summary).replace(/\n/g, '<br>');
    
    modal.classList.add('show');
}

function closeSummaryModal() {
    const modal = $('summaryModal');
    if (modal) modal.classList.remove('show');
    stopReadAloud();
}

function copySummary() {
    const content = $('summaryContent')?.textContent || '';
    navigator.clipboard.writeText(content).then(() => {
        showToast('Summary copied to clipboard', 'success');
    });
}

function readSummaryAloud() {
    const content = $('summaryContent')?.textContent || '';
    if (content) readAloud(content);
}

// Load documents list for viewer dropdown
async function loadDocumentsForViewer() {
    const selector = $('viewerDocSelector');
    if (!selector) return;
    
    try {
        const res = await apiFetch('/api/documents?limit=100');
        const docs = res.documents || [];
        ViewerState.allDocuments = docs;
        
        selector.innerHTML = '<option value="">-- Select a document --</option>';
        docs.forEach(doc => {
            const option = document.createElement('option');
            option.value = doc.id;
            option.textContent = doc.title || doc.fileName;
            selector.appendChild(option);
        });
        
        // If we have a current doc, select it
        if (ViewerState.currentDocId) {
            selector.value = String(ViewerState.currentDocId);
        }
    } catch (e) {
        console.error('Failed to load documents for viewer:', e);
    }
}

// Load a document into the viewer
async function loadDocumentInViewer(docId) {
    if (!docId) {
        renderViewerPlaceholder();
        return;
    }
    
    showLoading(true, 'Loading document...');
    ViewerState.currentDocId = docId;
    
    // Reset all search state
    resetSearchState();
    
    // Clear smart search panel
    $('smartSearchPanel')?.classList.remove('active');
    $('smartSearchToggle')?.classList.remove('active');
    const smartInput = $('viewerSmartSearch');
    if (smartInput) smartInput.value = '';
    
    // Clear text search input
    const textSearchInput = $('viewerTextSearch');
    if (textSearchInput) textSearchInput.value = '';
    
    try {
        // First get document metadata
        const docRes = await apiFetch(`/api/documents/${docId}`);
        ViewerState.currentDoc = docRes.document;
        
        // Update UI
        const titleEl = $('viewerDocTitle');
        if (titleEl) titleEl.textContent = ViewerState.currentDoc?.title || 'Document';
        
        const badgeEl = $('viewerDocBadge');
        if (badgeEl) badgeEl.textContent = ViewerState.currentDoc?.category || 'General';
        
        // Update selector dropdown
        const selector = $('viewerDocSelector');
        if (selector) selector.value = String(docId);
        
        // Fetch document content
        const contentRes = await apiFetch(`/api/documents/${docId}/content`);
        ViewerState.tableOfContents = contentRes.tableOfContents || [];
        ViewerState.documentContent = contentRes.content || '';
        ViewerState.chunkToSectionMap = contentRes.chunkToSectionMap || [];
        
        // Render table of contents
        renderTableOfContents();
        
        // Render document content
        renderDocumentContent();
        
        // Reset state
        ViewerState.currentSectionIndex = 0;
        
    } catch (e) {
        console.error('Failed to load document:', e);
        
        // Clear the invalid document ID so it doesn't keep trying
        ViewerState.currentDocId = null;
        ViewerState.currentDoc = null;
        
        // Reset selector dropdown to placeholder
        const selector = $('viewerDocSelector');
        if (selector) selector.value = '';
        
        // Show user-friendly message based on error
        if (e.status === 404) {
            showToast('This document no longer exists. It may have been deleted.', 'warning');
        } else {
            showToast(e.message || 'Failed to load document', 'error');
        }
        
        renderViewerPlaceholder();
    } finally {
        showLoading(false);
    }
}

// Render table of contents
function renderTableOfContents() {
    const tocList = $('viewerTocList');
    if (!tocList) return;

    if (!ViewerState.tableOfContents.length) {
        tocList.innerHTML = `
            <div class="toc-placeholder">
                <i class="fas fa-book-open"></i>
                <p>No sections detected</p>
            </div>
        `;
        return;
    }

    tocList.innerHTML = ViewerState.tableOfContents.map((item, idx) => {
        const indent = (item.level || 1) > 1 ? `style="padding-left: ${(item.level - 1) * 15}px"` : '';
        return `
            <div class="toc-chapter ${idx === 0 ? 'active' : ''}" data-section="${idx}" data-id="${escapeHtml(item.id || '')}" ${indent}>
                <div class="toc-chapter-title">${escapeHtml(item.title)}</div>
            </div>
        `;
    }).join('');

    // Add click handlers (robust)
    tocList.querySelectorAll('.toc-chapter').forEach(item => {
        item.addEventListener('click', () => {
            const idx = Number(item.dataset.section);
            const sectionId = item.dataset.id || '';

            const target = resolveTocTarget(sectionId, idx);
            if (!target) {
                showToast('Section not found in document', 'warning');
                return;
            }

            // Ensure it has an id (helps debugging + future linking)
            const resolvedId = ensureId(target, sectionId || ViewerState.tableOfContents?.[idx]?.id || ViewerState.tableOfContents?.[idx]?.title);
            ViewerState.tableOfContents[idx].id = resolvedId;

            scrollViewerToElement(target, { highlightClass: 'highlight-section', offset: 80 });

            // Update TOC active state
            document.querySelectorAll('.toc-chapter').forEach((el, i) => el.classList.toggle('active', i === idx));
            ViewerState.currentSectionIndex = idx;
        });
    });
}

// Render document content
function renderDocumentContent() {
    const contentEl = $('viewerContent');
    if (!contentEl) return;
    
    if (!ViewerState.documentContent) {
        renderViewerPlaceholder();
        return;
    }
    
    // Create document title header
    const doc = ViewerState.currentDoc;
    const tocCount = ViewerState.tableOfContents.length;
    const titleHtml = `
        <div class="document-title">
            <h1>${escapeHtml(doc?.title || 'Document')}</h1>
            <div class="doc-meta">
                <span>${escapeHtml(doc?.category || 'General')}</span>
                ${doc?.createdAt ? ` • ${formatDateTime(doc.createdAt)}` : ''}
                ${tocCount > 1 ? ` • ${tocCount} sections` : ''}
            </div>
        </div>
    `;
    
    const bodyHtml = `
        <div class="document-body">
            ${ViewerState.documentContent}
        </div>
    `;
    
    contentEl.innerHTML = titleHtml + bodyHtml;
}

// Render placeholder when no document loaded
function renderViewerPlaceholder(message = null) {
    const contentEl = $('viewerContent');
    if (!contentEl) return;
    
    const displayMessage = message || 'Choose a document from the dropdown above to view its contents';
    
    contentEl.innerHTML = `
        <div class="viewer-placeholder">
            <i class="fas fa-file-alt"></i>
            <h3>Select a Document</h3>
            <p>${escapeHtml(displayMessage)}</p>
        </div>
    `;
}

// Reset search state
function resetSearchState() {
    ViewerState.searchResults = [];
    ViewerState.currentSearchIndex = 0;
    ViewerState.smartSearchResults = [];
    ViewerState.currentSmartSearchIndex = 0;
    ViewerState.activeSearchType = null;
    clearSearchHighlights();
    hideSearchResults();
}

// Clear search highlights
function clearSearchHighlights() {
    const root = $('viewerContent')?.querySelector('.document-body') || $('viewerContent') || document;
    root.querySelectorAll?.('.search-highlight')?.forEach(el => {
        const text = document.createTextNode(el.textContent || '');
        if (el.parentNode) el.parentNode.replaceChild(text, el);
    });
}

// Hide search results panel
function hideSearchResults() {
    const section = $('searchResultsSection');
    if (section) {
        section.classList.add('hidden');
        section.classList.remove('visible');
    }
}

// Show search results panel
function showSearchResults() {
    const section = $('searchResultsSection');
    if (section) {
        section.classList.remove('hidden');
        section.classList.add('visible');
    }
}

// Navigate search results
function navigateSearchResult(delta) {
    if (!ViewerState.searchResults.length) {
        showToast('No search results', 'info');
        return;
    }

    ViewerState.activeSearchType = 'text';
    ViewerState.currentSearchIndex += delta;
    if (ViewerState.currentSearchIndex < 0) {
        ViewerState.currentSearchIndex = ViewerState.searchResults.length - 1;
    } else if (ViewerState.currentSearchIndex >= ViewerState.searchResults.length) {
        ViewerState.currentSearchIndex = 0;
    }

    scrollToSearchResult(ViewerState.currentSearchIndex);
}

// Navigate smart search results
function navigateSmartSearchResult(delta) {
    const results = ViewerState.smartSearchResults;
    if (!results || !results.length) return;
    
    let newIdx = ViewerState.currentSmartSearchIndex + delta;
    if (newIdx < 0) newIdx = results.length - 1;
    if (newIdx >= results.length) newIdx = 0;
    
    navigateToSmartResult(newIdx);
}

// Update search position indicator
function updateSearchPosition() {
    const posEl = $('searchResultPosition');
    if (posEl && ViewerState.searchResults.length) {
        posEl.textContent = `${ViewerState.currentSearchIndex + 1}/${ViewerState.searchResults.length}`;
    }
}

// Highlight and scroll to search result
function highlightAndScrollToResult(idx) {
    // Update active state in sidebar list
    document.querySelectorAll('.search-result-item').forEach((item, i) => {
        item.classList.toggle('active', i === idx);
    });
    
    // Scroll sidebar item into view
    const resultItems = document.querySelectorAll('.search-result-item');
    if (resultItems[idx]) {
        resultItems[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    
    // Find and scroll to the highlighted text in the document
    const highlights = document.querySelectorAll('.search-highlight');
    if (highlights[idx]) {
        const highlight = highlights[idx];
        const paperArea = $('viewerPaperArea');
        
        if (paperArea) {
            // Remove previous "current" styling
            document.querySelectorAll('.search-highlight-current').forEach(el => {
                el.classList.remove('search-highlight-current');
            });
            
            // Add current styling
            highlight.classList.add('search-highlight-current');
            
            // Calculate scroll position
            const paperRect = paperArea.getBoundingClientRect();
            const highlightRect = highlight.getBoundingClientRect();
            const scrollTop = paperArea.scrollTop;
            const elementOffsetFromViewport = highlightRect.top - paperRect.top;
            const targetScrollTop = scrollTop + elementOffsetFromViewport - (paperRect.height / 3);
            
            paperArea.scrollTo({ 
                top: Math.max(0, targetScrollTop), 
                behavior: 'smooth' 
            });
            
            // Flash effect
            highlight.classList.add('flash');
            setTimeout(() => highlight.classList.remove('flash'), 1500);
        }
    }
    
    // Update position indicator
    updateSearchPosition();
}

// Update active chapter based on scroll position
function updateActiveChapterOnScroll() {
    const wrapper = $('viewerPaperArea');
    if (!wrapper || !ViewerState.tableOfContents.length) return;
    
    const scrollTop = wrapper.scrollTop;
    let activeIdx = 0;
    
    ViewerState.tableOfContents.forEach((item, idx) => {
        const el = document.getElementById(item.id);
        if (el) {
            const rect = el.getBoundingClientRect();
            const wrapperRect = wrapper.getBoundingClientRect();
            if (rect.top - wrapperRect.top <= 100) {
                activeIdx = idx;
            }
        }
    });
    
    document.querySelectorAll('.toc-chapter').forEach((item, i) => {
        item.classList.toggle('active', i === activeIdx);
    });
    
    ViewerState.currentSectionIndex = activeIdx;
}

// Update reading progress bar
function updateReadingProgress() {
    const wrapper = $('viewerPaperArea');
    const progressBar = $('readingProgressBar');
    if (!wrapper || !progressBar) return;
    
    const scrollTop = wrapper.scrollTop;
    const scrollHeight = wrapper.scrollHeight - wrapper.clientHeight;
    const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
    
    progressBar.style.width = `${Math.min(100, progress)}%`;
}

// Load bookmarks from storage
function loadBookmarksFromStorage() {
    try {
        const stored = localStorage.getItem('viewerBookmarks');
        ViewerState.bookmarks = stored ? JSON.parse(stored) : [];
    } catch {
        ViewerState.bookmarks = [];
    }
    renderBookmarks();
}

// Render bookmarks
function renderBookmarks() {
    const container = $('viewerBookmarksList');
    if (!container) return;
    
    if (!ViewerState.bookmarks.length) {
        container.innerHTML = '<p class="empty-state">No bookmarks yet</p>';
        return;
    }
    
    container.innerHTML = ViewerState.bookmarks.map(b => `
        <div class="bookmark-item" data-id="${b.id}">
            <span>${escapeHtml(b.title)}</span>
            <button class="btn btn-xs btn-outline" onclick="removeBookmark('${b.id}')">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
}

// Navigate to chunk (for smart search fallback)
function navigateToChunk(chunkIdx) {
    const mapping = ViewerState.chunkToSectionMap?.find(m => m.chunkIndex === chunkIdx);
    if (mapping && mapping.sectionId) {
        const sectionEl = document.getElementById(mapping.sectionId);
        if (sectionEl) {
            const paperArea = $('viewerPaperArea');
            if (paperArea) {
                const paperRect = paperArea.getBoundingClientRect();
                const sectionRect = sectionEl.getBoundingClientRect();
                const targetScroll = paperArea.scrollTop + (sectionRect.top - paperRect.top) - 30;
                paperArea.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
            }
            sectionEl.classList.add('highlight-section');
            setTimeout(() => sectionEl.classList.remove('highlight-section'), 2000);
            return;
        }
    }
    
    const docBody = $('viewerContent')?.querySelector('.document-body');
    if (docBody) {
        docBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Print document
function printDocument() {
    window.print();
}

// Download current document
async function downloadCurrentDocument() {
    if (!ViewerState.currentDocId) {
        showToast('No document loaded', 'warning');
        return;
    }
    
    showLoading(true, 'Preparing download...');
    
    try {
        // Fetch the file with authentication
        const response = await fetch(`${AppState.apiBase}/api/documents/${ViewerState.currentDocId}/download`, {
            headers: {
                'Authorization': `Bearer ${AppState.token}`
            }
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Download failed');
        }
        
        // Get filename from Content-Disposition header if available
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = ViewerState.currentDoc?.fileName || 'document';
        if (contentDisposition) {
            const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (match && match[1]) {
                filename = match[1].replace(/['"]/g, '');
            }
        }
        
        // Create blob and download
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showToast('Download started', 'success');
    } catch (e) {
        console.error('Download error:', e);
        showToast('Download failed: ' + (e.message || 'Unknown error'), 'error');
    } finally {
        showLoading(false);
    }
}

// Copy current section text
function copyCurrentSectionText() {
    const docBody = $('viewerContent')?.querySelector('.document-body');
    if (!docBody) return;
    
    const text = docBody.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
        showToast('Document text copied to clipboard', 'success');
    }).catch(() => {
        showToast('Failed to copy text', 'error');
    });
}

// Adjust zoom level
function adjustZoom(delta) {
    ViewerState.zoomLevel = Math.max(50, Math.min(200, ViewerState.zoomLevel + delta));
    applyZoom();
    showToast(`Zoom: ${ViewerState.zoomLevel}%`, 'info');
}

// Ask AI about document
function askAiAboutDocument() {
    if (!ViewerState.currentDoc) {
        showToast('No document loaded', 'warning');
        return;
    }
    
    const docId = Number(ViewerState.currentDocId || ViewerState.currentDoc?.id);
    if (Number.isInteger(docId)) {
        AppState.chat.pendingDocumentSelection = [docId];
    }

    // Navigate to chat page with context
    showPage('chat');
    
    if (Number.isInteger(docId)) {
        applyChatDocumentSelection([docId], { replace: true });
    }

    const input = $('chatInput');
    if (input) {
        input.value = `I have a question about the document "${ViewerState.currentDoc.title}": `;
        input.focus();
    }
}

// Text search function - supports AND, OR, "exact phrase", case sensitivity
function performTextSearch() {
    const rawQuery = $('viewerTextSearch')?.value?.trim();
    if (!rawQuery || rawQuery.length < 2) {
        showToast('Please enter at least 2 characters to search', 'info');
        return;
    }

    // Clear previous search state
    resetSearchState();
    ViewerState.activeSearchType = 'text';

    const root = getViewerContentRoot();
    if (!root) {
        showToast('No document loaded', 'warning');
        return;
    }

    const caseSensitive = $('searchCaseSensitive')?.checked || false;
    const searchTerms = parseSearchQuery(rawQuery);
    if (searchTerms.length === 0) {
        showToast('Please enter a valid search term', 'info');
        return;
    }

    // Build a list of text nodes with their absolute offsets (so we can create stable match anchors)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
            if (!n || !n.parentNode) return NodeFilter.FILTER_REJECT;
            const parent = n.parentNode;
            // Avoid searching inside existing highlights / UI
            if (parent.closest && parent.closest('.search-results-section')) return NodeFilter.FILTER_REJECT;
            if (parent.classList && parent.classList.contains('search-highlight')) return NodeFilter.FILTER_REJECT;
            const text = n.textContent || '';
            if (text.trim().length < 2) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const matches = []; // { node, start, end, term }
    let node;

    while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (!matchesSearchCriteria(text, searchTerms, caseSensitive)) continue;

        // Find concrete ranges for each term in this node
        for (const term of searchTerms) {
            const needle = caseSensitive ? term.value : term.value.toLowerCase();
            const hay = caseSensitive ? text : text.toLowerCase();
            if (!needle) continue;

            let from = 0;
            while (from < hay.length) {
                const at = hay.indexOf(needle, from);
                if (at === -1) break;
                matches.push({ node, start: at, end: at + needle.length, term: text.substring(at, at + needle.length) });
                from = at + Math.max(1, needle.length);
            }
        }
    }

    if (!matches.length) {
        showToast('No matches found', 'info');
        return;
    }

    // Sort matches so we wrap from end->start per node (so offsets don't shift)
    matches.sort((a, b) => {
        if (a.node === b.node) return b.start - a.start;
        return 0;
    });

    // Apply highlights; create stable element references
    let globalIdx = 0;
    const perNode = new Map();

    for (const m of matches) {
        const list = perNode.get(m.node) || [];
        list.push(m);
        perNode.set(m.node, list);
    }

    perNode.forEach((nodeMatches, textNode) => {
        // Wrap matches into spans using splitText (precise)
        let working = textNode;
        for (const m of nodeMatches) {
            try {
                const full = working.textContent || '';
                if (m.end > full.length) continue;

                // Split into: [0..start][start..end][end..]
                const after = working.splitText(m.end);
                const mid = working.splitText(m.start);

                const span = document.createElement('span');
                span.className = 'search-highlight';
                span.setAttribute('data-search-index', String(globalIdx));
                span.textContent = mid.textContent || '';

                mid.parentNode?.replaceChild(span, mid);

                const context = getContextAroundMatch(full, span.textContent);
                ViewerState.searchResults.push({
                    index: globalIdx,
                    context,
                    term: span.textContent,
                    element: span
                });

                globalIdx++;
                working = after;
            } catch {
                // If splitText fails (rare), skip
            }
        }
    });

    showSearchResultsInSidebar(rawQuery);
}

// Parse search query into terms with operators
function parseSearchQuery(query) {
    const terms = [];
    
    // First extract quoted phrases
    const phraseRegex = /"([^"]+)"/g;
    let match;
    let processedQuery = query;
    
    while ((match = phraseRegex.exec(query)) !== null) {
        terms.push({
            type: 'phrase',
            value: match[1],
            required: true
        });
        processedQuery = processedQuery.replace(match[0], ' ');
    }
    
    // Split remaining query by spaces and process operators
    const parts = processedQuery.split(/\s+/).filter(p => p.length > 0);
    let nextOperator = 'AND'; // Default operator
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].toUpperCase();
        
        if (part === 'AND') {
            nextOperator = 'AND';
            continue;
        } else if (part === 'OR') {
            nextOperator = 'OR';
            continue;
        }
        
        // Skip very short words unless it's the only term
        if (parts[i].length < 2 && terms.length > 0) continue;
        
        terms.push({
            type: 'word',
            value: parts[i],
            operator: nextOperator,
            required: nextOperator === 'AND'
        });
        
        nextOperator = 'AND'; // Reset to default
    }
    
    return terms;
}

// Check if text matches search criteria
function matchesSearchCriteria(text, searchTerms, caseSensitive) {
    if (searchTerms.length === 0) return false;
    
    const compareText = caseSensitive ? text : text.toLowerCase();
    
    let hasRequiredMatch = false;
    let hasAnyMatch = false;
    let allRequiredMatch = true;
    
    for (const term of searchTerms) {
        const termValue = caseSensitive ? term.value : term.value.toLowerCase();
        const found = compareText.includes(termValue);
        
        if (found) {
            hasAnyMatch = true;
            if (term.required) hasRequiredMatch = true;
        } else {
            if (term.required) allRequiredMatch = false;
        }
    }
    
    // For AND logic, all required terms must match
    // For OR logic, at least one term must match
    const hasOnlyOrTerms = searchTerms.every(t => !t.required);
    
    if (hasOnlyOrTerms) {
        return hasAnyMatch;
    }
    
    return allRequiredMatch && hasRequiredMatch;
}

// Highlight search terms in a text node
function highlightSearchTermsInNode(textNode, searchTerms, caseSensitive) {
    const text = textNode.textContent;
    if (!text || !textNode.parentNode) return;
    
    // Build a combined regex for all search terms
    const escapedTerms = searchTerms.map(t => escapeRegex(t.value));
    const flags = caseSensitive ? 'g' : 'gi';
    const combinedRegex = new RegExp(`(${escapedTerms.join('|')})`, flags);
    
    const parts = text.split(combinedRegex);
    if (parts.length <= 1) return;
    
    const fragment = document.createDocumentFragment();
    let highlightIndex = ViewerState.searchResults.length;
    
    parts.forEach((part, partIdx) => {
        if (!part) return;
        
        // Check if this part matches any search term
        const isMatch = searchTerms.some(term => {
            const termVal = caseSensitive ? term.value : term.value.toLowerCase();
            const partVal = caseSensitive ? part : part.toLowerCase();
            return partVal === termVal;
        });
        
        if (isMatch) {
            const span = document.createElement('span');
            span.className = 'search-highlight';
            span.setAttribute('data-search-index', String(highlightIndex));
            span.textContent = part;
            fragment.appendChild(span);
            
            // Store result with reference to the element
            ViewerState.searchResults.push({
                index: highlightIndex,
                context: getContextAroundMatch(text, part),
                term: part,
                element: span
            });
            highlightIndex++;
        } else {
            fragment.appendChild(document.createTextNode(part));
        }
    });
    
    if (fragment.childNodes.length > 0) {
        textNode.parentNode.replaceChild(fragment, textNode);
    }
}

// Get context around a match
function getContextAroundMatch(fullText, match) {
    const idx = fullText.toLowerCase().indexOf(match.toLowerCase());
    if (idx === -1) return fullText.substring(0, 80);
    
    const start = Math.max(0, idx - 30);
    const end = Math.min(fullText.length, idx + match.length + 50);
    
    let context = fullText.substring(start, end);
    if (start > 0) context = '...' + context;
    if (end < fullText.length) context = context + '...';
    
    return context;
}

// Show search results in sidebar
function showSearchResultsInSidebar(query) {
    const countEl = $('searchResultsCount');
    const listEl = $('searchResultsList');
    
    if (!listEl) return;
    
    const count = ViewerState.searchResults.length;
    
    if (count === 0) {
        hideSearchResults();
        showToast('No matches found', 'info');
        return;
    }
    
    showSearchResults();
    if (countEl) countEl.textContent = `${count} result${count !== 1 ? 's' : ''}`;
    
    // Show up to 100 results in sidebar
    listEl.innerHTML = ViewerState.searchResults.slice(0, 100).map((result, idx) => `
        <div class="search-result-item ${idx === 0 ? 'active' : ''}" data-index="${idx}">
            <div class="search-result-context">${escapeHtml(result.context)}</div>
        </div>
    `).join('');
    
    // Add click handlers to navigate to result
    listEl.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const idx = parseInt(item.dataset.index);
            ViewerState.currentSearchIndex = idx;
            scrollToSearchResult(idx);
        });
    });
    
    // Update position indicator
    updateSearchPosition();
    
    // Auto-scroll to first result
    if (count > 0) {
        scrollToSearchResult(0);
    }
}

// Scroll to a specific search result
function scrollToSearchResult(idx) {
    if (idx < 0 || idx >= ViewerState.searchResults.length) return;

    const result = ViewerState.searchResults[idx];
    const viewerContent = $('viewerContent');
    if (!result || !viewerContent) return;

    // Sync active list item
    document.querySelectorAll('#searchResultsList .search-result-item').forEach((item, i) => {
        item.classList.toggle('active', i === idx);
    });

    const sidebarItem = document.querySelector(`#searchResultsList .search-result-item[data-index="${idx}"]`);
    sidebarItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Resolve highlight inside viewer
    let el = result.element;
    if (!el || !el.isConnected) {
        el = viewerContent.querySelector(`.search-highlight[data-search-index="${idx}"]`);
    }
    if (!el) {
        // As a last resort, pick nth highlight
        const all = viewerContent.querySelectorAll('.search-highlight');
        el = all[idx] || null;
    }

    if (!el) return;

    viewerContent.querySelectorAll('.search-highlight-current').forEach(x => x.classList.remove('search-highlight-current'));
    el.classList.add('search-highlight-current');

    scrollViewerToElement(el, { highlightClass: null, offset: 120 });

    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);

    updateSearchPosition();
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Smart search using AI
async function performSmartSearch() {
    const query = $('viewerSmartSearch')?.value?.trim();
    if (!query) {
        showToast('Please enter a search query', 'warning');
        return;
    }
    
    if (!ViewerState.currentDocId) {
        showToast('No document loaded', 'error');
        return;
    }
    
    clearSearchHighlights();
    ViewerState.searchResults = [];
    ViewerState.currentSearchIndex = 0;
    ViewerState.smartSearchResults = [];
    ViewerState.currentSmartSearchIndex = 0;
    ViewerState.activeSearchType = 'smart';
    
    $('smartSearchPanel')?.classList.remove('active');
    $('smartSearchToggle')?.classList.remove('active');
    
    const searchList = $('searchResultsList');
    const countEl = $('searchResultsCount');
    
    showSearchResults();
    if (countEl) countEl.textContent = 'Searching...';
    if (searchList) searchList.innerHTML = '<div class="toc-loading"><i class="fas fa-spinner fa-spin"></i> AI analyzing document...</div>';
    
    try {
        const res = await apiFetch(`/api/documents/${ViewerState.currentDocId}/search`, {
            method: 'POST',
            body: { query, limit: 10 }
        });
        
        const results = res.results || [];
        
        if (!results.length) {
            if (countEl) countEl.textContent = '0 results';
            if (searchList) searchList.innerHTML = '<p class="empty-state">No relevant sections found.</p>';
            return;
        }
        
        ViewerState.smartSearchResults = results;
        ViewerState.currentSmartSearchIndex = 0;
        
        if (countEl) countEl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
        
        const posEl = $('searchResultPosition');
        if (posEl) posEl.textContent = `1/${results.length}`;
        
        if (searchList) {
            searchList.innerHTML = results.map((result, idx) => {
                const relevancePercent = Math.round((result.score || 0) * 100);
                const relevanceClass = relevancePercent >= 50 ? 'high' : relevancePercent >= 30 ? 'medium' : 'low';
                const excerpt = result.excerpt || result.content?.substring(0, 150) || '';
                return `
                    <div class="search-result-item ${idx === 0 ? 'active' : ''}" data-smart-idx="${idx}">
                        <div class="search-result-header">
                            <span class="relevance-badge ${relevanceClass}">${relevancePercent}% match</span>
                        </div>
                        <div class="search-result-excerpt">${escapeHtml(excerpt)}...</div>
                    </div>
                `;
            }).join('');
            
            searchList.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    const idx = parseInt(item.dataset.smartIdx);
                    navigateToSmartResult(idx);
                });
            });
        }
        
        if (results.length > 0) {
            navigateToSmartResult(0);
        }
        
    } catch (e) {
        console.error('Smart search error:', e);
        if (countEl) countEl.textContent = 'Search failed';
        if (searchList) searchList.innerHTML = `<p class="empty-state">Search failed: ${escapeHtml(e.message)}</p>`;
    }
}

window.closeSummaryModal = closeSummaryModal;
window.copySummary = copySummary;
window.readSummaryAloud = readSummaryAloud;

// =========================
// Admin
// =========================

async function loadAdminAuditTrail(search = '', page = 1) {
    const container = $('adminContent');
    if (!container) return;
    
    try {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', '20');
        if (search) params.set('search', search);
        
        const res = await apiFetch(`/api/admin/audit?${params.toString()}`);
        const logs = res.logs || [];
        
        let html = `
            <div class="admin-section">
                <h2><i class="fas fa-history"></i> Audit Trail</h2>
                <div class="admin-filters">
                    <input type="text" id="auditSearch" placeholder="Search actions..." value="${escapeHtml(search)}">
                    <button class="btn btn-primary" onclick="loadAdminAuditTrail(document.getElementById('auditSearch').value)">Search</button>
                </div>
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>User</th>
                            <th>Action</th>
                            <th>Details</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        logs.forEach(log => {
            html += `
                <tr>
                    <td>${escapeHtml(formatDateTime(log.created_at))}</td>
                    <td>${escapeHtml(log.user_email || 'System')}</td>
                    <td><span class="badge">${escapeHtml(log.action)}</span></td>
                    <td>${escapeHtml(JSON.stringify(log.details || {}))}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table></div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load audit trail: ${escapeHtml(e.message)}</p>`;
    }
}

async function loadAdminUsers(search = '', page = 1) {
    const container = $('adminContent');
    if (!container) return;
    
    const currentUserRole = AppState.user?.role;
    const isSuperAdmin = currentUserRole === 'superadmin';
    
    try {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', '20');
        if (search) params.set('search', search);
        if (AppState.admin.usersStatusFilter) params.set('status', AppState.admin.usersStatusFilter);
        if (AppState.admin.usersRoleFilter) params.set('role', AppState.admin.usersRoleFilter);
        
        const res = await apiFetch(`/api/admin/users?${params.toString()}`);
        const users = res.users || [];
        
        let html = `
            <div class="admin-section">
                <h2><i class="fas fa-users"></i> User Management</h2>
                <p class="admin-help-text">
                    ${isSuperAdmin ? 
                        'As superadmin, you can manage all users including admins.' : 
                        'As admin, you can manage staff users. Only superadmins can modify admin roles.'}
                </p>
                <div class="admin-filters">
                    <input type="text" id="userSearch" placeholder="Search users..." value="${escapeHtml(search)}">
                    <select id="userStatusFilter" onchange="AppState.admin.usersStatusFilter = this.value; loadAdminUsers(document.getElementById('userSearch').value)">
                        <option value="">All Status</option>
                        <option value="active" ${AppState.admin.usersStatusFilter === 'active' ? 'selected' : ''}>Active</option>
                        <option value="pending" ${AppState.admin.usersStatusFilter === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="inactive" ${AppState.admin.usersStatusFilter === 'inactive' ? 'selected' : ''}>Inactive</option>
                    </select>
                    <select id="userRoleFilter" onchange="AppState.admin.usersRoleFilter = this.value; loadAdminUsers(document.getElementById('userSearch').value)">
                        <option value="">All Roles</option>
                        <option value="staff" ${AppState.admin.usersRoleFilter === 'staff' ? 'selected' : ''}>Staff</option>
                        <option value="admin" ${AppState.admin.usersRoleFilter === 'admin' ? 'selected' : ''}>Admin</option>
                        <option value="superadmin" ${AppState.admin.usersRoleFilter === 'superadmin' ? 'selected' : ''}>Superadmin</option>
                    </select>
                    <button class="btn btn-primary" onclick="loadAdminUsers(document.getElementById('userSearch').value)">Search</button>
                </div>
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Department</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        users.forEach(user => {
            const isOwnAccount = user.id === AppState.user?.id;
            const isPending = !user.is_verified || !user.is_approved;
            const status = isPending ? 'pending' : (user.is_active ? 'active' : 'inactive');
            const statusClass = status === 'active' ? 'success' : (status === 'pending' ? 'warning' : 'danger');
            
            // Determine what actions the current user can perform on this user
            const canChangeRole = !isOwnAccount && (
                isSuperAdmin || 
                (currentUserRole === 'admin' && user.role === 'staff')
            );
            const canToggleStatus = !isOwnAccount && (
                isSuperAdmin || 
                (currentUserRole === 'admin' && user.role !== 'superadmin' && user.role !== 'admin')
            );
            const canDelete = !isOwnAccount && (
                isSuperAdmin || 
                (currentUserRole === 'admin' && user.role === 'staff')
            );
            const canResetPassword = !isOwnAccount && (
                isSuperAdmin || 
                (currentUserRole === 'admin' && user.role === 'staff')
            );
            const canApprove = isPending && !isOwnAccount;
            
            // Build role options based on permissions
            let roleOptions = '';
            if (canChangeRole) {
                roleOptions = `<option value="staff" ${user.role === 'staff' ? 'selected' : ''}>Staff</option>`;
                if (isSuperAdmin || currentUserRole === 'admin') {
                    roleOptions += `<option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>`;
                }
                if (isSuperAdmin) {
                    roleOptions += `<option value="superadmin" ${user.role === 'superadmin' ? 'selected' : ''}>Superadmin</option>`;
                }
            }
            
            html += `
                <tr class="${isOwnAccount ? 'own-account' : ''}">
                    <td>
                        ${escapeHtml(user.first_name || '')} ${escapeHtml(user.last_name || '')}
                        ${isOwnAccount ? '<span class="badge badge-info">You</span>' : ''}
                    </td>
                    <td>${escapeHtml(user.email)}</td>
                    <td>${escapeHtml(user.department || '-')}</td>
                    <td>
                        ${canChangeRole ? `
                            <select class="role-select" onchange="changeUserRole(${user.id}, this.value, '${user.role}')">
                                ${roleOptions}
                            </select>
                        ` : `
                            <span class="badge badge-${user.role === 'superadmin' ? 'danger' : (user.role === 'admin' ? 'warning' : 'secondary')}">${escapeHtml(user.role)}</span>
                        `}
                    </td>
                    <td><span class="badge badge-${statusClass}">${escapeHtml(status)}</span></td>
                    <td class="user-actions">
                        ${canApprove ? `
                            <button class="btn btn-sm btn-success" onclick="approveUser(${user.id})" title="Approve">
                                <i class="fas fa-check"></i>
                            </button>
                            <button class="btn btn-sm btn-danger" onclick="rejectUser(${user.id})" title="Reject">
                                <i class="fas fa-times"></i>
                            </button>
                        ` : ''}
                        ${!isPending && canToggleStatus ? (user.is_active ? 
                            `<button class="btn btn-sm btn-warning" onclick="toggleUserActive(${user.id}, false)" title="Deactivate">
                                <i class="fas fa-user-slash"></i>
                            </button>` :
                            `<button class="btn btn-sm btn-success" onclick="toggleUserActive(${user.id}, true)" title="Activate">
                                <i class="fas fa-user-check"></i>
                            </button>`
                        ) : ''}
                        ${canDelete ? `
                            <button class="btn btn-sm btn-danger" onclick="deleteUser(${user.id}, '${escapeHtml(user.email)}')" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        ` : ''}
                        ${canResetPassword ? `
                            <button class="btn btn-sm btn-info" onclick="resetUserPassword(${user.id}, '${escapeHtml(user.email)}')" title="Reset Password">
                                <i class="fas fa-key"></i>
                            </button>
                        ` : ''}
                        ${isOwnAccount ? '<span class="text-muted">-</span>' : ''}
                    </td>
                </tr>
            `;
        });
        
        if (users.length === 0) {
            html += '<tr><td colspan="6" class="text-center">No users found</td></tr>';
        }
        
        html += '</tbody></table>';
        
        // Pagination
        if (res.pagination && res.pagination.totalPages > 1) {
            html += `
                <div class="pagination">
                    ${page > 1 ? `<button class="btn btn-sm" onclick="loadAdminUsers('${escapeHtml(search)}', ${page - 1})">Previous</button>` : ''}
                    <span>Page ${page} of ${res.pagination.totalPages}</span>
                    ${page < res.pagination.totalPages ? `<button class="btn btn-sm" onclick="loadAdminUsers('${escapeHtml(search)}', ${page + 1})">Next</button>` : ''}
                </div>
            `;
        }
        
        html += '</div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load users: ${escapeHtml(e.message)}</p>`;
    }
}

async function showAdminSection(section) {
    if (!isAdmin()) {
        showPage('home');
        return;
    }
    
    AppState.admin.currentSection = section;
    
    // Update nav active state
    document.querySelectorAll('.admin-nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.section === section);
    });
    
    const container = $('adminContent');
    if (!container) return;
    
    container.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
    
    switch (section) {
        case 'dashboard':
            await loadAdminDashboard();
            break;
        case 'users':
            await loadAdminUsers();
            break;
        case 'documents':
            renderAdminDocumentsHelp();
            break;
        case 'training':
            await renderAdminTrainingHelp();
            break;
        case 'faqs':
            await loadAdminFAQs();
            break;
        case 'analytics':
            await loadAdminAnalytics();
            break;
        case 'exports':
            renderAdminExports();
            break;
        case 'audit':
            await loadAdminAuditTrail();
            break;
        case 'settings':
            await loadAdminSettings();
            break;
        default:
            container.innerHTML = '<p>Section not found</p>';
    }
}

async function loadAdminDashboard() {
    const container = $('adminContent');
    if (!container) return;
    
    try {
        const [statsRes, docsRes] = await Promise.all([
            apiFetch('/api/admin/stats'),
            apiFetch('/api/documents/admin/stats')
        ]);
        
        const stats = statsRes.stats || {};
        const docStats = docsRes.stats || {};

        AppState.documents.stats = docStats;
        updateResourcesBadge();
        
        container.innerHTML = `
            <div class="admin-section">
                <h2><i class="fas fa-tachometer-alt"></i> Dashboard</h2>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-icon"><i class="fas fa-users"></i></div>
                        <div class="stat-value">${formatNumber(stats.totalUsers || 0)}</div>
                        <div class="stat-label">Total Users</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon"><i class="fas fa-comments"></i></div>
                        <div class="stat-value">${formatNumber(stats.totalSessions || 0)}</div>
                        <div class="stat-label">Chat Sessions</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon"><i class="fas fa-file-alt"></i></div>
                        <div class="stat-value">${formatNumber(docStats.total || 0)}</div>
                        <div class="stat-label">Documents</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon"><i class="fas fa-brain"></i></div>
                        <div class="stat-value">${formatNumber(docStats.trained || 0)}</div>
                        <div class="stat-label">Trained Docs</div>
                    </div>
                </div>
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load dashboard: ${escapeHtml(e.message)}</p>`;
    }
}

async function loadAdminAnalytics() {
    const container = $('adminContent');
    if (!container) return;
    
    try {
        const res = await apiFetch('/api/admin/analytics');
        const data = res.analytics || {};
        
        // Calculate metrics from the response
        const dailyMessages = data.dailyMessages || [];
        const messagesThisWeek = dailyMessages.slice(-7).reduce((sum, d) => sum + (parseInt(d.total) || 0), 0);
        const totalTokensUsed = dailyMessages.reduce((sum, d) => sum + (parseInt(d.tokens_used) || 0), 0);
        const topUsers = data.topUsers || [];
        const activeUsers = topUsers.length;
        const feedbackStats = data.feedbackStats || {};
        const avgRating = feedbackStats.averageRating || 0;
        const avgResponseTime = dailyMessages.length > 0 
            ? Math.round(dailyMessages.reduce((sum, d) => sum + (parseFloat(d.avg_response_time) || 0), 0) / dailyMessages.length)
            : 0;
        
        container.innerHTML = `
            <div class="admin-section">
                <h2><i class="fas fa-chart-bar"></i> Analytics</h2>
                <div class="stats-grid stats-grid-5">
                    <div class="stat-card">
                        <div class="stat-icon chats"><i class="fas fa-envelope"></i></div>
                        <div class="stat-value">${formatNumber(messagesThisWeek)}</div>
                        <div class="stat-label">Messages (7 days)</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon tokens"><i class="fas fa-coins"></i></div>
                        <div class="stat-value">${formatNumber(totalTokensUsed)}</div>
                        <div class="stat-label">Tokens Used (${data.period || '30 days'})</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon users"><i class="fas fa-users"></i></div>
                        <div class="stat-value">${formatNumber(activeUsers)}</div>
                        <div class="stat-label">Active Users</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon rating"><i class="fas fa-star"></i></div>
                        <div class="stat-value">${(avgRating || 0).toFixed(1)}</div>
                        <div class="stat-label">Avg Rating</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon response"><i class="fas fa-clock"></i></div>
                        <div class="stat-value">${avgResponseTime}ms</div>
                        <div class="stat-label">Avg Response</div>
                    </div>
                </div>
                
                ${topUsers.length > 0 ? `
                    <div class="analytics-section">
                        <h3><i class="fas fa-medal"></i> Top Active Users</h3>
                        <table class="admin-table">
                            <thead>
                                <tr>
                                    <th>User</th>
                                    <th>Role</th>
                                    <th>Messages</th>
                                    <th>Tokens Used</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${topUsers.slice(0, 10).map(u => `
                                    <tr>
                                        <td>${escapeHtml(u.first_name || '')} ${escapeHtml(u.last_name || '')} <small>(${escapeHtml(u.email)})</small></td>
                                        <td><span class="badge badge-outline">${escapeHtml(u.role || 'staff')}</span></td>
                                        <td>${formatNumber(u.message_count || 0)}</td>
                                        <td>${formatNumber(u.total_tokens || 0)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                ` : '<p class="empty-state">No user activity in this period</p>'}
                
                ${dailyMessages.length > 0 ? `
                    <div class="analytics-section">
                        <h3><i class="fas fa-chart-line"></i> Daily Activity</h3>
                        <div class="daily-chart">
                            ${dailyMessages.slice(-14).map(d => `
                                <div class="chart-bar-wrapper" title="${d.date}: ${d.total} messages, ${formatNumber(d.tokens_used || 0)} tokens">
                                    <div class="chart-bar" style="height: ${Math.min(100, (parseInt(d.total) / Math.max(...dailyMessages.map(x => parseInt(x.total) || 1))) * 100)}%"></div>
                                    <div class="chart-label">${new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load analytics: ${escapeHtml(e.message)}</p>`;
    }
}

// =========================
// FAQ Moderation
// =========================

// State for FAQ moderation
AppState.faqAdmin = {
    currentPage: 1,
    searchTerm: '',
    categoryFilter: '',
    verifiedFilter: '',
    documentFilter: '',
    currentFAQ: null,
    pageSize: 25,
    suggestionDefaults: {
        days: 30,
        minCount: 3,
        limit: 6
    }
};

const FAQ_SUGGESTIONS_IGNORE_KEY = 'bmu_faq_suggestions_ignored';

function getIgnoredFaqSuggestions() {
    try {
        const raw = localStorage.getItem(FAQ_SUGGESTIONS_IGNORE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.map(entry => String(entry)));
    } catch {
        return new Set();
    }
}

function setIgnoredFaqSuggestions(ignoredSet) {
    try {
        const values = Array.from(ignoredSet || []);
        localStorage.setItem(FAQ_SUGGESTIONS_IGNORE_KEY, JSON.stringify(values));
    } catch {
        // Ignore storage failures
    }
}

function normalizeFaqSuggestionKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function renderFaqSuggestions(items, hiddenCount = 0) {
    if (!items || items.length === 0) {
        const message = hiddenCount > 0
            ? 'All suggestions are hidden. Clear ignores to see them again.'
            : 'We will surface chat questions once they are asked a few times.';
        return `
            <div class="faq-suggestions-empty">
                <i class="fas fa-comment-slash"></i>
                <div>
                    <strong>No suggestions to show</strong>
                    <p>${escapeHtml(message)}</p>
                </div>
            </div>
        `;
    }

    return items.map(item => {
        const questionText = item.question || item.normalized || '';
        const count = item.occurrences || 0;
        const lastAsked = item.last_asked_at ? formatDateTime(item.last_asked_at) : '—';
        return `
            <div class="faq-suggestion-card">
                <div class="faq-suggestion-main">
                    <div class="faq-suggestion-question">${escapeHtml(questionText)}</div>
                    <div class="faq-suggestion-meta">
                        <span><i class="fas fa-repeat"></i> ${count}x</span>
                        <span><i class="fas fa-clock"></i> ${escapeHtml(lastAsked)}</span>
                    </div>
                </div>
                <div class="faq-suggestion-actions">
                    <button class="btn btn-sm btn-primary" data-action="add-suggestion" data-question="${escapeHtml(questionText)}">
                        <i class="fas fa-plus"></i> Add to FAQ
                    </button>
                    <button class="btn btn-sm btn-outline" data-action="ignore-suggestion" data-ignore-key="${escapeHtml(item.ignoreKey || '')}">
                        <i class="fas fa-eye-slash"></i> Ignore
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function loadAdminFAQs() {
    const container = $('adminContent');
    if (!container) return;
    
    try {
        // Load stats and FAQs in parallel
        const [statsRes, faqsRes, categoriesRes] = await Promise.all([
            apiFetch('/api/faq/admin/stats'),
            apiFetch(`/api/faq/admin/list?page=${AppState.faqAdmin.currentPage}&limit=${AppState.faqAdmin.pageSize}${AppState.faqAdmin.searchTerm ? '&search=' + encodeURIComponent(AppState.faqAdmin.searchTerm) : ''}${AppState.faqAdmin.categoryFilter ? '&categoryId=' + AppState.faqAdmin.categoryFilter : ''}${AppState.faqAdmin.verifiedFilter !== '' ? '&isVerified=' + AppState.faqAdmin.verifiedFilter : ''}${AppState.faqAdmin.documentFilter ? '&documentId=' + AppState.faqAdmin.documentFilter : ''}`),
            apiFetch('/api/faq/categories')
        ]);
        
        const stats = statsRes.stats || {};
        const faqs = faqsRes.items || [];
        const categories = categoriesRes.categories || [];
        const suggestionDefaults = AppState.faqAdmin.suggestionDefaults;
        let suggestions = [];
        let suggestionsTotal = 0;
        let suggestionsHidden = 0;
        let visibleSuggestions = [];
        try {
            const suggestionsRes = await apiFetch(`/api/faq/admin/suggestions?days=${suggestionDefaults.days}&minCount=${suggestionDefaults.minCount}&limit=${suggestionDefaults.limit}`);
            suggestions = suggestionsRes.items || [];
            suggestionsTotal = suggestionsRes.total || suggestions.length;
            const ignoredSet = getIgnoredFaqSuggestions();
            const suggestionsWithKeys = suggestions.map(item => ({
                ...item,
                ignoreKey: normalizeFaqSuggestionKey(item.normalized || item.question)
            }));
            visibleSuggestions = suggestionsWithKeys.filter(item => item.ignoreKey && !ignoredSet.has(item.ignoreKey));
            suggestionsHidden = suggestionsWithKeys.length - visibleSuggestions.length;
        } catch (e) {
            console.warn('Failed to load FAQ suggestions:', e);
        }
        const totalPages = faqsRes.totalPages || 1;
        const totalItems = faqsRes.total || 0;
        const startItem = (AppState.faqAdmin.currentPage - 1) * AppState.faqAdmin.pageSize + 1;
        const endItem = Math.min(AppState.faqAdmin.currentPage * AppState.faqAdmin.pageSize, totalItems);
        
        container.innerHTML = `
            <div class="admin-section faq-admin-redesign">
                <!-- Header -->
                <div class="faq-admin-header">
                    <div class="faq-header-left">
                        <h2><i class="fas fa-question-circle"></i> FAQ Management</h2>
                        <p class="faq-subtitle">Manage questions and answers for the AI assistant</p>
                    </div>
                    <div class="faq-header-actions">
                        <button class="btn btn-outline btn-sm" id="downloadTemplateBtn" title="Download CSV Template">
                            <i class="fas fa-file-download"></i> <span class="btn-text">Template</span>
                        </button>
                        <button class="btn btn-outline btn-sm" id="importFaqBtn" title="Import FAQs">
                            <i class="fas fa-upload"></i> <span class="btn-text">Import</span>
                        </button>
                        <button class="btn btn-outline btn-sm" id="exportFaqBtn" title="Export FAQs">
                            <i class="fas fa-download"></i> <span class="btn-text">Export</span>
                        </button>
                        <button class="btn btn-primary" id="addFaqBtn">
                            <i class="fas fa-plus"></i> Add FAQ
                        </button>
                    </div>
                </div>
                
                <!-- Quick Stats Bar -->
                <div class="faq-stats-bar">
                    <div class="stat-pill">
                        <i class="fas fa-database"></i>
                        <span class="stat-number">${totalItems}</span>
                        <span class="stat-text">Total</span>
                    </div>
                    <div class="stat-pill stat-verified">
                        <i class="fas fa-check-circle"></i>
                        <span class="stat-number">${stats.verifiedFaqs || 0}</span>
                        <span class="stat-text">Verified</span>
                    </div>
                    <div class="stat-pill stat-pending">
                        <i class="fas fa-clock"></i>
                        <span class="stat-number">${stats.unverifiedFaqs || 0}</span>
                        <span class="stat-text">Pending</span>
                    </div>
                    <div class="stat-pill stat-usage">
                        <i class="fas fa-chart-line"></i>
                        <span class="stat-number">${formatNumber(stats.totalUsage || 0)}</span>
                        <span class="stat-text">Uses</span>
                    </div>
                </div>

                <!-- Chat FAQ Suggestions -->
                <div class="faq-suggestions">
                    <div class="faq-suggestions-header">
                        <div>
                            <h3><i class="fas fa-comments"></i> Chat FAQ Candidates</h3>
                            <p>Top repeated questions from the last ${suggestionDefaults.days} days (min ${suggestionDefaults.minCount} asks)</p>
                        </div>
                        <div class="faq-suggestions-actions">
                            <span class="faq-suggestions-count">${visibleSuggestions.length} showing${suggestionsTotal ? ` of ${suggestionsTotal}` : ''}${suggestionsHidden ? ` · ${suggestionsHidden} hidden` : ''}</span>
                            <button class="btn btn-sm btn-outline" id="refreshFaqSuggestionsBtn">
                                <i class="fas fa-sync"></i> Refresh
                            </button>
                            <button class="btn btn-sm btn-outline ${suggestionsHidden ? '' : 'hidden'}" id="clearFaqSuggestionsBtn">
                                <i class="fas fa-eraser"></i> Clear ignored
                            </button>
                        </div>
                    </div>
                    <div class="faq-suggestions-list" id="faqSuggestionsList">
                        ${renderFaqSuggestions(visibleSuggestions, suggestionsHidden)}
                    </div>
                </div>
                
                <!-- Filters & Search -->
                <div class="faq-toolbar">
                    <div class="faq-search-box">
                        <i class="fas fa-search"></i>
                        <input type="text" id="faqAdminSearchInput" placeholder="Search questions or answers..." 
                               value="${escapeHtml(AppState.faqAdmin.searchTerm)}">
                        ${AppState.faqAdmin.searchTerm ? '<button class="search-clear" id="searchClearBtn"><i class="fas fa-times"></i></button>' : ''}
                    </div>
                    <div class="faq-filters-group">
                        <select id="faqCategoryFilter" class="filter-select">
                            <option value="">All Categories</option>
                            ${categories.map(c => `<option value="${c.id}" ${AppState.faqAdmin.categoryFilter == c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
                        </select>
                        <select id="faqVerifiedFilter" class="filter-select">
                            <option value="">All Status</option>
                            <option value="true" ${AppState.faqAdmin.verifiedFilter === 'true' ? 'selected' : ''}>✓ Verified</option>
                            <option value="false" ${AppState.faqAdmin.verifiedFilter === 'false' ? 'selected' : ''}>⏳ Pending</option>
                        </select>
                        <select id="faqPageSizeSelect" class="filter-select filter-select-sm">
                            <option value="25" ${AppState.faqAdmin.pageSize === 25 ? 'selected' : ''}>25 per page</option>
                            <option value="50" ${AppState.faqAdmin.pageSize === 50 ? 'selected' : ''}>50 per page</option>
                            <option value="100" ${AppState.faqAdmin.pageSize === 100 ? 'selected' : ''}>100 per page</option>
                        </select>
                    </div>
                </div>
                
                <!-- FAQ Table -->
                <div class="faq-table-container">
                    ${faqs.length === 0 ? `
                        <div class="faq-empty-state">
                            <i class="fas fa-inbox"></i>
                            <h3>No FAQs Found</h3>
                            <p>${AppState.faqAdmin.searchTerm || AppState.faqAdmin.categoryFilter || AppState.faqAdmin.verifiedFilter 
                                ? 'Try adjusting your filters or search terms' 
                                : 'Add your first FAQ to get started'}</p>
                            ${!AppState.faqAdmin.searchTerm && !AppState.faqAdmin.categoryFilter ? 
                                '<button class="btn btn-primary" id="emptyAddFaqBtn"><i class="fas fa-plus"></i> Add First FAQ</button>' : 
                                '<button class="btn btn-outline" id="clearAllFiltersBtn"><i class="fas fa-times"></i> Clear Filters</button>'}
                        </div>
                    ` : `
                        <table class="faq-table">
                            <thead>
                                <tr>
                                    <th class="col-status">Status</th>
                                    <th class="col-question">Question</th>
                                    <th class="col-answer">Answer</th>
                                    <th class="col-category">Category</th>
                                    <th class="col-stats">Stats</th>
                                    <th class="col-actions">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="faqTableBody">
                                ${faqs.map(faq => renderFAQTableRow(faq)).join('')}
                            </tbody>
                        </table>
                    `}
                </div>
                
                <!-- Pagination -->
                ${totalPages > 0 && faqs.length > 0 ? `
                    <div class="faq-pagination">
                        <div class="pagination-info">
                            Showing <strong>${startItem}-${endItem}</strong> of <strong>${totalItems}</strong> FAQs
                        </div>
                        <div class="pagination-controls">
                            <button type="button" class="btn btn-sm btn-icon faq-page-first" ${AppState.faqAdmin.currentPage <= 1 ? 'disabled' : ''} title="First page" onclick="navigateFAQPage(1)">
                                <i class="fas fa-angle-double-left"></i>
                            </button>
                            <button type="button" class="btn btn-sm btn-icon faq-page-prev" ${AppState.faqAdmin.currentPage <= 1 ? 'disabled' : ''} title="Previous page" onclick="navigateFAQPage(${AppState.faqAdmin.currentPage - 1})">
                                <i class="fas fa-angle-left"></i>
                            </button>
                            <div class="page-numbers">
                                ${generatePageNumbers(AppState.faqAdmin.currentPage, totalPages)}
                            </div>
                            <button type="button" class="btn btn-sm btn-icon faq-page-next" ${AppState.faqAdmin.currentPage >= totalPages ? 'disabled' : ''} title="Next page" onclick="navigateFAQPage(${AppState.faqAdmin.currentPage + 1})">
                                <i class="fas fa-angle-right"></i>
                            </button>
                            <button type="button" class="btn btn-sm btn-icon faq-page-last" ${AppState.faqAdmin.currentPage >= totalPages ? 'disabled' : ''} title="Last page" onclick="navigateFAQPage(${totalPages})">
                                <i class="fas fa-angle-double-right"></i>
                            </button>
                        </div>
                    </div>
                ` : ''}
            </div>
            
            <!-- FAQ Edit Modal -->
            <div id="faqEditModal" class="modal faq-modal">
                <div class="modal-content modal-lg">
                    <div class="modal-header">
                        <h3 id="faqModalTitle"><i class="fas fa-edit"></i> Edit FAQ</h3>
                        <button class="close-btn">&times;</button>
                    </div>
                    <form id="faqEditForm">
                        <div class="form-group">
                            <label for="faqQuestion">Question *</label>
                            <textarea id="faqQuestion" rows="2" required class="form-control"></textarea>
                        </div>
                        <div class="form-group">
                            <label for="faqAnswer">Answer *</label>
                            <textarea id="faqAnswer" rows="6" required class="form-control"></textarea>
                            <button type="button" class="btn btn-sm btn-secondary mt-2" id="regenerateAnswerBtn" onclick="regenerateFAQAnswer()">
                                <i class="fas fa-magic"></i> Regenerate with AI
                            </button>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label for="faqCategory">Category</label>
                                <select id="faqCategory" class="form-control">
                                    <option value="">-- Select Category --</option>
                                    ${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="faqConfidence">Confidence Score</label>
                                <input type="number" id="faqConfidence" min="0" max="1" step="0.01" value="1.0" class="form-control">
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="faqVariations">Question Variations (one per line)</label>
                            <textarea id="faqVariations" rows="3" class="form-control" placeholder="Alternative ways to ask this question..."></textarea>
                        </div>
                        <div class="modal-actions">
                            <button type="button" class="btn btn-outline faq-cancel-btn">Cancel</button>
                            <button type="submit" class="btn btn-primary">
                                <i class="fas fa-save"></i> Save FAQ
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        
        // Add enter key handler for search
        const searchInput = document.getElementById('faqAdminSearchInput');
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    searchAdminFAQs();
                }
            });
            // Also search as user types (debounced)
            searchInput.addEventListener('input', debounce(() => {
                searchAdminFAQs();
            }, 500));
        }
        
        // Search clear button
        const searchClearBtn = document.getElementById('searchClearBtn');
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', () => {
                AppState.faqAdmin.searchTerm = '';
                AppState.faqAdmin.currentPage = 1;
                loadAdminFAQs();
            });
        }
        
        // Event delegation for FAQ table actions
        const faqTableBody = document.getElementById('faqTableBody');
        if (faqTableBody) {
            faqTableBody.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-action]');
                if (btn) {
                    const action = btn.dataset.action;
                    const id = parseInt(btn.dataset.id);
                    
                    switch (action) {
                        case 'view':
                            viewFAQDetail(id);
                            break;
                        case 'edit':
                            editFAQ(id);
                            break;
                        case 'verify':
                            verifyFAQ(id);
                            break;
                        case 'delete':
                            deleteFAQ(id);
                            break;
                    }
                    return;
                }
                
                // Toggle row expansion
                const row = e.target.closest('.faq-row');
                if (row && !e.target.closest('.faq-actions')) {
                    row.classList.toggle('expanded');
                }
            });
        }
        
        // Add FAQ button
        const addFaqBtn = document.getElementById('addFaqBtn');
        if (addFaqBtn) {
            addFaqBtn.addEventListener('click', showAddFAQModal);
        }
        
        // Empty state add button
        const emptyAddFaqBtn = document.getElementById('emptyAddFaqBtn');
        if (emptyAddFaqBtn) {
            emptyAddFaqBtn.addEventListener('click', showAddFAQModal);
        }
        
        // Clear all filters button
        const clearAllFiltersBtn = document.getElementById('clearAllFiltersBtn');
        if (clearAllFiltersBtn) {
            clearAllFiltersBtn.addEventListener('click', clearFAQFilters);
        }
        
        // Import/Export buttons
        const downloadTemplateBtn = document.getElementById('downloadTemplateBtn');
        if (downloadTemplateBtn) {
            downloadTemplateBtn.addEventListener('click', downloadFAQTemplate);
        }
        
        const importFaqBtn = document.getElementById('importFaqBtn');
        if (importFaqBtn) {
            importFaqBtn.addEventListener('click', showImportFAQModal);
        }
        
        const exportFaqBtn = document.getElementById('exportFaqBtn');
        if (exportFaqBtn) {
            exportFaqBtn.addEventListener('click', exportFAQs);
        }
        
        // Filter dropdowns
        const categoryFilter = document.getElementById('faqCategoryFilter');
        const verifiedFilter = document.getElementById('faqVerifiedFilter');
        const pageSizeSelect = document.getElementById('faqPageSizeSelect');
        
        if (categoryFilter) {
            categoryFilter.addEventListener('change', filterAdminFAQs);
        }
        if (verifiedFilter) {
            verifiedFilter.addEventListener('change', filterAdminFAQs);
        }
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', (e) => {
                AppState.faqAdmin.pageSize = parseInt(e.target.value);
                AppState.faqAdmin.currentPage = 1;
                loadAdminFAQs();
            });
        }

        // FAQ suggestions actions
        const suggestionsList = container.querySelector('#faqSuggestionsList');
        if (suggestionsList) {
            suggestionsList.addEventListener('click', (e) => {
                const addBtn = e.target.closest('button[data-action="add-suggestion"]');
                if (addBtn) {
                    showAddFAQModal({ question: addBtn.dataset.question || '' });
                    return;
                }

                const ignoreBtn = e.target.closest('button[data-action="ignore-suggestion"]');
                if (ignoreBtn) {
                    const ignoreKey = ignoreBtn.dataset.ignoreKey || '';
                    if (!ignoreKey) return;
                    const ignored = getIgnoredFaqSuggestions();
                    ignored.add(ignoreKey);
                    setIgnoredFaqSuggestions(ignored);
                    showToast('Suggestion hidden', 'info');
                    loadAdminFAQs();
                }
            });
        }

        const refreshSuggestionsBtn = container.querySelector('#refreshFaqSuggestionsBtn');
        if (refreshSuggestionsBtn) {
            refreshSuggestionsBtn.addEventListener('click', () => {
                loadAdminFAQs();
            });
        }

        const clearSuggestionsBtn = container.querySelector('#clearFaqSuggestionsBtn');
        if (clearSuggestionsBtn) {
            clearSuggestionsBtn.addEventListener('click', () => {
                setIgnoredFaqSuggestions(new Set());
                showToast('Hidden suggestions restored', 'success');
                loadAdminFAQs();
            });
        }
        
        // Pagination is handled via inline onclick handlers
        // Also add event listeners as backup
        const paginationBtns = container.querySelectorAll('.pagination-controls button');
        paginationBtns.forEach((btn) => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                
                if (this.classList.contains('faq-page-first')) {
                    navigateFAQPage(1);
                } else if (this.classList.contains('faq-page-prev')) {
                    navigateFAQPage(AppState.faqAdmin.currentPage - 1);
                } else if (this.classList.contains('faq-page-next')) {
                    navigateFAQPage(AppState.faqAdmin.currentPage + 1);
                } else if (this.classList.contains('faq-page-last')) {
                    // Get totalPages from the button's data or calculate
                    const totalPages = Math.ceil((faqsRes.total || 0) / AppState.faqAdmin.pageSize) || 1;
                    navigateFAQPage(totalPages);
                } else if (this.classList.contains('page-num')) {
                    const pageText = this.textContent.trim();
                    const page = parseInt(pageText);
                    if (page) navigateFAQPage(page);
                }
            });
        });
        
        // Modal form submission
        const modalForm = document.getElementById('faqEditForm');
        if (modalForm) {
            modalForm.addEventListener('submit', saveFAQ);
        }
        
        // Modal close button
        const closeBtn = container.querySelector('#faqEditModal .close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeFAQModal);
        }
        
        // Modal cancel button
        const cancelBtn = container.querySelector('.faq-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', closeFAQModal);
        }
        
    } catch (e) {
        console.error('Load admin FAQs error:', e);
        container.innerHTML = `<p class="error">Failed to load FAQs: ${escapeHtml(e.message)}</p>`;
    }
}

// Generate page number buttons
function generatePageNumbers(currentPage, totalPages) {
    if (totalPages <= 1) return '';
    
    const pages = [];
    const maxVisible = 5;
    
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }
    
    if (startPage > 1) {
        pages.push(`<button type="button" class="page-num" onclick="navigateFAQPage(1)">1</button>`);
        if (startPage > 2) pages.push(`<span class="page-ellipsis">...</span>`);
    }
    
    for (let i = startPage; i <= endPage; i++) {
        pages.push(`<button type="button" class="page-num ${i === currentPage ? 'active' : ''}" onclick="navigateFAQPage(${i})">${i}</button>`);
    }
    
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) pages.push(`<span class="page-ellipsis">...</span>`);
        pages.push(`<button type="button" class="page-num" onclick="navigateFAQPage(${totalPages})">${totalPages}</button>`);
    }
    
    return pages.join('');
}

// Render FAQ as table row with expandable answer
function renderFAQTableRow(faq) {
    const truncatedQuestion = faq.question.length > 80 ? faq.question.substring(0, 80) + '...' : faq.question;
    const truncatedAnswer = faq.answer && faq.answer.length > 100 ? faq.answer.substring(0, 100) + '...' : faq.answer;
    const hasLongContent = faq.question.length > 80 || (faq.answer && faq.answer.length > 100);
    
    return `
        <tr class="faq-row ${hasLongContent ? 'expandable' : ''}" data-faq-id="${faq.id}">
            <td class="col-status">
                ${faq.isVerified 
                    ? '<span class="status-badge verified" title="Verified"><i class="fas fa-check-circle"></i></span>' 
                    : '<span class="status-badge pending" title="Pending Review"><i class="fas fa-clock"></i></span>'}
            </td>
            <td class="col-question">
                <div class="question-cell">
                    <span class="question-text">${escapeHtml(truncatedQuestion)}</span>
                    ${hasLongContent ? '<i class="fas fa-chevron-down expand-icon"></i>' : ''}
                </div>
                <div class="full-question" style="display: none;">${escapeHtml(faq.question)}</div>
            </td>
            <td class="col-answer">
                <div class="answer-preview">${escapeHtml(truncatedAnswer)}</div>
                <div class="full-answer" style="display: none;">${escapeHtml(faq.answer || '')}</div>
            </td>
            <td class="col-category">
                ${faq.categoryName 
                    ? `<span class="category-tag">${escapeHtml(faq.categoryName)}</span>` 
                    : '<span class="no-category">—</span>'}
            </td>
            <td class="col-stats">
                <div class="stats-mini">
                    <span class="stat-item" title="Usage count"><i class="fas fa-eye"></i> ${faq.usageCount || 0}</span>
                    <span class="stat-item" title="Confidence: ${((faq.confidenceScore || 1) * 100).toFixed(0)}%">
                        <i class="fas fa-star${(faq.confidenceScore || 1) >= 0.8 ? '' : '-half-alt'}"></i>
                    </span>
                </div>
            </td>
            <td class="col-actions">
                <div class="faq-actions">
                    <button class="btn-icon" data-action="view" data-id="${faq.id}" title="View">
                        <i class="fas fa-expand"></i>
                    </button>
                    <button class="btn-icon" data-action="edit" data-id="${faq.id}" title="Edit">
                        <i class="fas fa-edit"></i>
                    </button>
                    ${!faq.isVerified ? `
                        <button class="btn-icon btn-verify" data-action="verify" data-id="${faq.id}" title="Verify">
                            <i class="fas fa-check"></i>
                        </button>
                    ` : ''}
                    <button class="btn-icon btn-delete" data-action="delete" data-id="${faq.id}" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
}

// Debounce helper function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Keep old function for backward compatibility
function renderFAQAdminRow(faq) {
    const truncatedAnswer = faq.answer && faq.answer.length > 150 
        ? faq.answer.substring(0, 150) + '...' 
        : faq.answer;
    
    return `
        <div class="faq-admin-item ${faq.isVerified ? 'verified' : 'pending'}" data-faq-id="${faq.id}">
            <div class="faq-item-header">
                <div class="faq-item-badges">
                    ${faq.isVerified 
                        ? '<span class="badge badge-success"><i class="fas fa-check"></i> Verified</span>' 
                        : '<span class="badge badge-warning"><i class="fas fa-clock"></i> Pending</span>'}
                    ${faq.categoryName ? `<span class="badge badge-info">${escapeHtml(faq.categoryName)}</span>` : ''}
                    ${faq.qaType ? `<span class="badge badge-outline">${escapeHtml(faq.qaType)}</span>` : ''}
                </div>
                <div class="faq-item-stats">
                    <span title="Usage count"><i class="fas fa-chart-line"></i> ${faq.usageCount || 0}</span>
                    <span title="Confidence"><i class="fas fa-percentage"></i> ${((faq.confidenceScore || 1) * 100).toFixed(0)}%</span>
                </div>
            </div>
            <div class="faq-item-content">
                <h4 class="faq-question">${escapeHtml(faq.question)}</h4>
                <p class="faq-answer-preview">${escapeHtml(truncatedAnswer)}</p>
                ${faq.documentTitle ? `<small class="faq-source"><i class="fas fa-file-alt"></i> ${escapeHtml(faq.documentTitle)}</small>` : ''}
            </div>
            <div class="faq-item-actions">
                <button class="btn btn-sm btn-outline faq-view-btn" data-action="view" data-id="${faq.id}" title="View Details">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="btn btn-sm btn-outline faq-edit-btn" data-action="edit" data-id="${faq.id}" title="Edit">
                    <i class="fas fa-edit"></i>
                </button>
                ${!faq.isVerified ? `
                    <button class="btn btn-sm btn-success faq-verify-btn" data-action="verify" data-id="${faq.id}" title="Verify">
                        <i class="fas fa-check"></i>
                    </button>
                ` : ''}
                <button class="btn btn-sm btn-danger faq-delete-btn" data-action="delete" data-id="${faq.id}" title="Delete">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

async function viewFAQDetail(id) {
    try {
        showLoading(true, 'Loading FAQ...');
        // Use admin endpoint to get full data
        const res = await apiFetch(`/api/faq/admin/item/${id}`);
        const faq = res.faq;
        
        const variations = faq.questionVariations || faq.question_variations || [];
        const sources = faq.answerSources || faq.answer_sources || [];
        
        showLoading(false);
        
        // Create a modal to show full details
        const modalHtml = `
            <div id="faqViewModal" class="modal active faq-modal">
                <div class="modal-content modal-lg">
                    <div class="modal-header">
                        <h3><i class="fas fa-info-circle"></i> FAQ Details</h3>
                        <button class="close-btn" id="faqViewCloseBtn">&times;</button>
                    </div>
                    <div class="faq-detail-view">
                        <div class="detail-section">
                            <label>Status</label>
                            <div class="badges">
                                ${faq.isVerified 
                                    ? '<span class="badge badge-success"><i class="fas fa-check"></i> Verified</span>' 
                                    : '<span class="badge badge-warning"><i class="fas fa-clock"></i> Pending Review</span>'}
                                ${faq.categoryName ? `<span class="badge badge-info">${escapeHtml(faq.categoryName)}</span>` : ''}
                            </div>
                        </div>
                        <div class="detail-section">
                            <label>Question</label>
                            <p class="detail-text">${escapeHtml(faq.question)}</p>
                        </div>
                        <div class="detail-section">
                            <label>Answer</label>
                            <div class="detail-text answer-text">${escapeHtml(faq.answer)}</div>
                        </div>
                        ${variations.length > 0 ? `
                            <div class="detail-section">
                                <label>Question Variations (${variations.length})</label>
                                <ul class="variation-list">
                                    ${variations.map(v => `<li>${escapeHtml(v)}</li>`).join('')}
                                </ul>
                            </div>
                        ` : ''}
                        ${sources.length > 0 ? `
                            <div class="detail-section">
                                <label>Sources</label>
                                <ul class="source-list">
                                    ${sources.map(s => `<li>${escapeHtml(typeof s === 'string' ? s : s.text || JSON.stringify(s))}</li>`).join('')}
                                </ul>
                            </div>
                        ` : ''}
                        <div class="detail-stats">
                            <div><strong>Usage:</strong> ${faq.usageCount || 0} times</div>
                            <div><strong>Confidence:</strong> ${((faq.confidenceScore || 1) * 100).toFixed(0)}%</div>
                            <div><strong>Created:</strong> ${formatDateTime(faq.createdAt)}</div>
                            ${faq.verifiedAt ? `<div><strong>Verified:</strong> ${formatDateTime(faq.verifiedAt)}</div>` : ''}
                        </div>
                    </div>
                    <div class="modal-actions">
                        <button class="btn btn-outline" id="faqViewCloseBtn2">Close</button>
                        <button class="btn btn-primary" id="faqViewEditBtn" data-faq-id="${faq.id}">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        // Add event listeners
        const closeViewModal = () => {
            const modal = document.getElementById('faqViewModal');
            if (modal) modal.remove();
        };
        
        document.getElementById('faqViewCloseBtn')?.addEventListener('click', closeViewModal);
        document.getElementById('faqViewCloseBtn2')?.addEventListener('click', closeViewModal);
        document.getElementById('faqViewEditBtn')?.addEventListener('click', (e) => {
            const faqId = parseInt(e.currentTarget.dataset.faqId);
            closeViewModal();
            editFAQ(faqId);
        });
        
    } catch (e) {
        showLoading(false);
        showToast('Failed to load FAQ: ' + e.message, 'error');
    }
}

async function editFAQ(id) {
    try {
        showLoading(true, 'Loading FAQ...');
        // Use admin endpoint to get full data
        const res = await apiFetch(`/api/faq/admin/item/${id}`);
        AppState.faqAdmin.currentFAQ = res.faq;
        showLoading(false);
        
        const modal = document.getElementById('faqEditModal');
        const titleEl = document.getElementById('faqModalTitle');
        
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-edit"></i> Edit FAQ';
        
        document.getElementById('faqQuestion').value = res.faq.question || '';
        document.getElementById('faqAnswer').value = res.faq.answer || '';
        document.getElementById('faqCategory').value = res.faq.categoryId || res.faq.category_id || '';
        document.getElementById('faqConfidence').value = res.faq.confidenceScore || res.faq.confidence_score || 1.0;
        document.getElementById('faqVariations').value = (res.faq.questionVariations || res.faq.question_variations || []).join('\n');
        
        if (modal) modal.classList.add('active');
        
    } catch (e) {
        showLoading(false);
        showToast('Failed to load FAQ: ' + e.message, 'error');
    }
}

function showAddFAQModal(prefill = {}) {
    AppState.faqAdmin.currentFAQ = null;
    
    const modal = document.getElementById('faqEditModal');
    const titleEl = document.getElementById('faqModalTitle');
    
    if (titleEl) titleEl.innerHTML = '<i class="fas fa-plus"></i> Add New FAQ';
    
    document.getElementById('faqQuestion').value = prefill.question || '';
    document.getElementById('faqAnswer').value = prefill.answer || '';
    document.getElementById('faqCategory').value = '';
    document.getElementById('faqConfidence').value = '1.0';
    document.getElementById('faqVariations').value = '';
    
    if (modal) modal.classList.add('active');
}

function closeFAQModal() {
    const modal = document.getElementById('faqEditModal');
    if (modal) modal.classList.remove('active');
    AppState.faqAdmin.currentFAQ = null;
}

async function saveFAQ(event) {
    event.preventDefault();
    
    const question = document.getElementById('faqQuestion').value.trim();
    const answer = document.getElementById('faqAnswer').value.trim();
    const categoryId = document.getElementById('faqCategory').value;
    const confidenceScore = parseFloat(document.getElementById('faqConfidence').value) || 1.0;
    const variationsText = document.getElementById('faqVariations').value.trim();
    const variations = variationsText ? variationsText.split('\n').map(v => v.trim()).filter(v => v) : [];
    
    if (!question || !answer) {
        showToast('Question and answer are required', 'error');
        return;
    }
    
    showLoading(true, 'Saving FAQ...');
    
    try {
        if (AppState.faqAdmin.currentFAQ) {
            // Update existing
            await apiFetch(`/api/faq/admin/${AppState.faqAdmin.currentFAQ.id}`, {
                method: 'PUT',
                body: {
                    question,
                    answer,
                    categoryId: categoryId ? parseInt(categoryId) : null,
                    confidenceScore,
                    questionVariations: variations
                }
            });
            showToast('FAQ updated successfully', 'success');
        } else {
            // Create new
            await apiFetch('/api/faq/admin/add', {
                method: 'POST',
                body: {
                    question,
                    answer,
                    categoryId: categoryId ? parseInt(categoryId) : null,
                    variations
                }
            });
            showToast('FAQ created successfully', 'success');
        }
        
        closeFAQModal();
        await loadAdminFAQs();
        
    } catch (e) {
        showToast('Failed to save FAQ: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * Regenerate FAQ answer using AI
 */
async function regenerateFAQAnswer() {
    const question = document.getElementById('faqQuestion').value.trim();
    const currentAnswer = document.getElementById('faqAnswer').value.trim();
    
    if (!question) {
        showToast('Please enter a question first', 'error');
        return;
    }
    
    // Get FAQ ID if editing existing FAQ
    const faqId = AppState.faqAdmin.currentFAQ?.id || 0;
    
    const regenerateBtn = document.getElementById('regenerateAnswerBtn');
    const originalBtnHtml = regenerateBtn.innerHTML;
    
    try {
        // Update button to show loading state
        regenerateBtn.disabled = true;
        regenerateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
        
        const response = await apiFetch(`/api/faq/admin/${faqId}/regenerate-answer`, {
            method: 'POST',
            body: {
                question,
                currentAnswer
            }
        });
        
        if (response.success && response.answer) {
            // Update the answer textarea
            document.getElementById('faqAnswer').value = response.answer;
            showToast('Answer regenerated successfully!', 'success');
            
            // Show sources if available
            if (response.sources && response.sources.length > 0) {
                console.log('Sources used:', response.sources);
            }
        } else {
            showToast(response.error || 'Failed to regenerate answer', 'error');
        }
    } catch (e) {
        console.error('Regenerate answer error:', e);
        showToast('Failed to regenerate answer: ' + e.message, 'error');
    } finally {
        // Restore button
        regenerateBtn.disabled = false;
        regenerateBtn.innerHTML = originalBtnHtml;
    }
}

async function verifyFAQ(id) {
    if (!confirm('Verify this FAQ? It will become publicly visible.')) return;
    
    showLoading(true, 'Verifying...');
    try {
        await apiFetch(`/api/faq/admin/${id}/verify`, { method: 'POST' });
        showToast('FAQ verified', 'success');
        await loadAdminFAQs();
    } catch (e) {
        showToast('Failed to verify: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

async function deleteFAQ(id) {
    if (!confirm('Delete this FAQ? This action cannot be undone.')) return;
    
    showLoading(true, 'Deleting...');
    try {
        await apiFetch(`/api/faq/admin/${id}`, { method: 'DELETE' });
        showToast('FAQ deleted', 'success');
        await loadAdminFAQs();
    } catch (e) {
        showToast('Failed to delete: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

function searchAdminFAQs() {
    const input = document.getElementById('faqAdminSearchInput');
    AppState.faqAdmin.searchTerm = input ? input.value.trim() : '';
    AppState.faqAdmin.currentPage = 1;
    loadAdminFAQs();
}

function filterAdminFAQs() {
    const catFilter = document.getElementById('faqCategoryFilter');
    const verFilter = document.getElementById('faqVerifiedFilter');
    
    AppState.faqAdmin.categoryFilter = catFilter ? catFilter.value : '';
    AppState.faqAdmin.verifiedFilter = verFilter ? verFilter.value : '';
    AppState.faqAdmin.currentPage = 1;
    loadAdminFAQs();
}

function clearFAQFilters() {
    AppState.faqAdmin.searchTerm = '';
    AppState.faqAdmin.categoryFilter = '';
    AppState.faqAdmin.verifiedFilter = '';
    AppState.faqAdmin.documentFilter = '';
    AppState.faqAdmin.currentPage = 1;
    loadAdminFAQs();
}

function navigateFAQPage(page) {
    if (page < 1) return;
    AppState.faqAdmin.currentPage = page;
    loadAdminFAQs();
}

// ==================== FAQ Import/Export Functions ====================

/**
 * Download the CSV template for FAQ import
 */
async function downloadFAQTemplate() {
    try {
        showLoading(true, 'Downloading template...');
        const response = await fetch('/api/faq/admin/import-template', {
            headers: {
                'Authorization': `Bearer ${AppState.token}`
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to download template');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'faq_import_template.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        
        showToast('Template downloaded successfully', 'success');
    } catch (e) {
        showToast('Failed to download template: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * Show the import FAQ modal
 */
function showImportFAQModal() {
    // Remove existing modal if any
    const existingModal = document.getElementById('faqImportModal');
    if (existingModal) existingModal.remove();
    
    const modalHtml = `
        <div id="faqImportModal" class="modal active faq-modal">
            <div class="modal-content modal-lg">
                <div class="modal-header">
                    <h3><i class="fas fa-upload"></i> Import FAQs</h3>
                    <button class="close-btn" id="importModalCloseBtn">&times;</button>
                </div>
                <div class="import-modal-body">
                    <div class="import-instructions">
                        <h4>Instructions:</h4>
                        <ol>
                            <li>Download the <a href="#" id="templateLinkInModal">CSV template</a> first</li>
                            <li>Fill in your FAQs following the format in the template</li>
                            <li>Required fields: <strong>question</strong> and <strong>answer</strong></li>
                            <li>Upload your CSV file or paste the data below</li>
                        </ol>
                    </div>
                    
                    <div class="import-options">
                        <label class="checkbox-label">
                            <input type="checkbox" id="importSkipDuplicates" checked>
                            Skip duplicate questions
                        </label>
                        <label class="checkbox-label">
                            <input type="checkbox" id="importAutoVerify">
                            Auto-verify imported FAQs
                        </label>
                    </div>
                    
                    <div class="import-tabs">
                        <button class="tab-btn active" data-tab="file">Upload File</button>
                        <button class="tab-btn" data-tab="paste">Paste CSV</button>
                    </div>
                    
                    <div class="import-tab-content" id="fileTabContent">
                        <div class="file-drop-zone" id="faqDropZone">
                            <i class="fas fa-cloud-upload-alt"></i>
                            <p>Drag & drop your CSV file here</p>
                            <p class="or-text">or</p>
                            <input type="file" id="faqFileInput" accept=".csv" hidden>
                            <button class="btn btn-outline" id="browseFileBtn">Browse Files</button>
                        </div>
                        <div class="selected-file" id="selectedFileInfo" style="display: none;">
                            <i class="fas fa-file-csv"></i>
                            <span id="selectedFileName"></span>
                            <button class="btn btn-sm btn-outline" id="removeFileBtn">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>
                    
                    <div class="import-tab-content" id="pasteTabContent" style="display: none;">
                        <textarea id="csvPasteArea" rows="10" placeholder="Paste your CSV data here...
Example:
question,answer,category_name,qa_type
What is BMU?,Bayelsa Medical University is...,General,definitional"></textarea>
                    </div>
                    
                    <div class="import-preview" id="importPreview" style="display: none;">
                        <h4>Preview (<span id="previewCount">0</span> FAQs)</h4>
                        <div class="preview-table-container">
                            <table class="preview-table">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Question</th>
                                        <th>Answer</th>
                                        <th>Category</th>
                                    </tr>
                                </thead>
                                <tbody id="previewTableBody"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-outline" id="importCancelBtn">Cancel</button>
                    <button class="btn btn-primary" id="importSubmitBtn" disabled>
                        <i class="fas fa-upload"></i> Import FAQs
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Initialize import modal event handlers
    initImportModalHandlers();
}

/**
 * Initialize event handlers for the import modal
 */
function initImportModalHandlers() {
    // Close button
    document.getElementById('importModalCloseBtn')?.addEventListener('click', closeImportModal);
    document.getElementById('importCancelBtn')?.addEventListener('click', closeImportModal);
    
    // Template link
    document.getElementById('templateLinkInModal')?.addEventListener('click', (e) => {
        e.preventDefault();
        downloadFAQTemplate();
    });
    
    // Tab switching
    document.querySelectorAll('#faqImportModal .tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tab = e.target.dataset.tab;
            document.querySelectorAll('#faqImportModal .tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            document.getElementById('fileTabContent').style.display = tab === 'file' ? 'block' : 'none';
            document.getElementById('pasteTabContent').style.display = tab === 'paste' ? 'block' : 'none';
        });
    });
    
    // File input
    const fileInput = document.getElementById('faqFileInput');
    const browseBtn = document.getElementById('browseFileBtn');
    const dropZone = document.getElementById('faqDropZone');
    
    browseBtn?.addEventListener('click', () => fileInput?.click());
    
    fileInput?.addEventListener('change', (e) => {
        if (e.target.files?.length) {
            handleFileSelect(e.target.files[0]);
        }
    });
    
    // Drag and drop
    dropZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    
    dropZone?.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    
    dropZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files?.length) {
            handleFileSelect(e.dataTransfer.files[0]);
        }
    });
    
    // Remove file button
    document.getElementById('removeFileBtn')?.addEventListener('click', () => {
        AppState.faqImportData = null;
        document.getElementById('selectedFileInfo').style.display = 'none';
        document.getElementById('faqDropZone').style.display = 'flex';
        document.getElementById('importPreview').style.display = 'none';
        document.getElementById('importSubmitBtn').disabled = true;
        document.getElementById('faqFileInput').value = '';
    });
    
    // Paste area
    document.getElementById('csvPasteArea')?.addEventListener('input', (e) => {
        const csvText = e.target.value.trim();
        if (csvText.length > 10) {
            parseCSVAndPreview(csvText);
        }
    });
    
    // Submit button
    document.getElementById('importSubmitBtn')?.addEventListener('click', submitFAQImport);
}

/**
 * Handle file selection
 */
function handleFileSelect(file) {
    if (!file.name.endsWith('.csv')) {
        showToast('Please select a CSV file', 'error');
        return;
    }
    
    document.getElementById('selectedFileName').textContent = file.name;
    document.getElementById('selectedFileInfo').style.display = 'flex';
    document.getElementById('faqDropZone').style.display = 'none';
    
    const reader = new FileReader();
    reader.onload = (e) => {
        parseCSVAndPreview(e.target.result);
    };
    reader.readAsText(file);
}

/**
 * Parse CSV text and show preview
 */
function parseCSVAndPreview(csvText) {
    try {
        const lines = csvText.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
        if (lines.length < 2) {
            showToast('CSV must have a header row and at least one data row', 'error');
            return;
        }
        
        // Parse header
        const headers = parseCSVRow(lines[0]);
        const questionIdx = headers.findIndex(h => h.toLowerCase() === 'question');
        const answerIdx = headers.findIndex(h => h.toLowerCase() === 'answer');
        
        if (questionIdx === -1 || answerIdx === -1) {
            showToast('CSV must have "question" and "answer" columns', 'error');
            return;
        }
        
        // Parse data rows
        const faqs = [];
        for (let i = 1; i < lines.length; i++) {
            const row = parseCSVRow(lines[i]);
            if (row.length < 2) continue;
            
            const faq = {};
            headers.forEach((header, idx) => {
                faq[header.toLowerCase().replace(/ /g, '_')] = row[idx] || '';
            });
            
            if (faq.question && faq.answer) {
                faqs.push(faq);
            }
        }
        
        if (faqs.length === 0) {
            showToast('No valid FAQ entries found in CSV', 'error');
            return;
        }
        
        // Store for submission
        AppState.faqImportData = faqs;
        
        // Show preview
        const previewBody = document.getElementById('previewTableBody');
        previewBody.innerHTML = faqs.slice(0, 10).map((faq, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td>${escapeHtml(faq.question.substring(0, 60))}${faq.question.length > 60 ? '...' : ''}</td>
                <td>${escapeHtml(faq.answer.substring(0, 80))}${faq.answer.length > 80 ? '...' : ''}</td>
                <td>${escapeHtml(faq.category_name || '-')}</td>
            </tr>
        `).join('');
        
        if (faqs.length > 10) {
            previewBody.innerHTML += `<tr><td colspan="4" class="more-rows">... and ${faqs.length - 10} more FAQs</td></tr>`;
        }
        
        document.getElementById('previewCount').textContent = faqs.length;
        document.getElementById('importPreview').style.display = 'block';
        document.getElementById('importSubmitBtn').disabled = false;
        
    } catch (e) {
        showToast('Failed to parse CSV: ' + e.message, 'error');
    }
}

/**
 * Parse a single CSV row handling quoted values
 */
function parseCSVRow(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current.trim());
    return result;
}

/**
 * Submit the FAQ import
 */
async function submitFAQImport() {
    if (!AppState.faqImportData || AppState.faqImportData.length === 0) {
        showToast('No FAQs to import', 'error');
        return;
    }
    
    const skipDuplicates = document.getElementById('importSkipDuplicates')?.checked ?? true;
    const autoVerify = document.getElementById('importAutoVerify')?.checked ?? false;
    
    showLoading(true, `Importing ${AppState.faqImportData.length} FAQs...`);
    
    try {
        const res = await apiFetch('/api/faq/admin/import', {
            method: 'POST',
            body: {
                faqs: AppState.faqImportData,
                skipDuplicates,
                autoVerify
            }
        });
        
        closeImportModal();
        
        // Show result summary
        let message = `Successfully imported ${res.summary.imported} FAQs`;
        if (res.summary.duplicatesSkipped > 0) {
            message += `, ${res.summary.duplicatesSkipped} duplicates skipped`;
        }
        if (res.summary.errorsCount > 0) {
            message += `, ${res.summary.errorsCount} errors`;
        }
        
        showToast(message, res.summary.imported > 0 ? 'success' : 'warning');
        
        // Reload FAQ list
        await loadAdminFAQs();
        
    } catch (e) {
        showToast('Failed to import FAQs: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * Close the import modal
 */
function closeImportModal() {
    const modal = document.getElementById('faqImportModal');
    if (modal) modal.remove();
    AppState.faqImportData = null;
}

/**
 * Export FAQs to CSV
 */
async function exportFAQs() {
    try {
        showLoading(true, 'Exporting FAQs...');
        
        // Build query params from current filters
        let url = '/api/faq/admin/export?format=csv';
        if (AppState.faqAdmin.categoryFilter) {
            url += `&categoryId=${AppState.faqAdmin.categoryFilter}`;
        }
        if (AppState.faqAdmin.verifiedFilter !== '') {
            url += `&isVerified=${AppState.faqAdmin.verifiedFilter}`;
        }
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${AppState.token}`
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to export FAQs');
        }
        
        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `faq_export_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(downloadUrl);
        a.remove();
        
        showToast('FAQs exported successfully', 'success');
    } catch (e) {
        showToast('Failed to export FAQs: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

function renderAdminDocumentsHelp() {
    const container = $('adminContent');
    if (!container) return;
    
    container.innerHTML = `
        <div class="admin-section">
            <h2><i class="fas fa-file-alt"></i> Documents</h2>
            <p>Manage documents from the <a href="#" onclick="showPage('documents'); return false;">Documents page</a>.</p>
            <p>Use the "Process" button on each document to train the AI on its content.</p>
        </div>
    `;
}

async function renderAdminTrainingHelp() {
    const container = $('adminContent');
    if (!container) return;
    
    try {
        // Load document stats
        const docRes = await apiFetch('/api/documents/admin/stats');
        const stats = docRes.stats || {};
        
        container.innerHTML = `
            <div class="admin-section">
                <h2><i class="fas fa-brain"></i> AI Training</h2>
                
                <!-- Overview Stats -->
                <div class="stats-grid stats-grid-3">
                    <div class="stat-card">
                        <div class="stat-icon"><i class="fas fa-file-alt"></i></div>
                        <div class="stat-value">${stats.total || 0}</div>
                        <div class="stat-label">Total Documents</div>
                    </div>
                    <div class="stat-card stat-success">
                        <div class="stat-icon"><i class="fas fa-check-circle"></i></div>
                        <div class="stat-value">${stats.processed || 0}</div>
                        <div class="stat-label">Processed</div>
                    </div>
                    <div class="stat-card stat-warning">
                        <div class="stat-icon"><i class="fas fa-clock"></i></div>
                        <div class="stat-value">${stats.pending || 0}</div>
                        <div class="stat-label">Pending</div>
                    </div>
                </div>
                
                <!-- Actions -->
                <div class="training-section">
                    <h3><i class="fas fa-cogs"></i> Quick Actions</h3>
                    <div class="training-actions">
                        <button class="btn btn-primary" onclick="rebuildRagIndex()">
                            <i class="fas fa-sync"></i> Rebuild RAG Index
                        </button>
                        <button class="btn btn-outline" onclick="warmFAQCache()">
                            <i class="fas fa-fire"></i> Warm FAQ Cache
                        </button>
                    </div>
                </div>
                
                <!-- Info -->
                <div class="training-section">
                    <h3><i class="fas fa-info-circle"></i> About AI Training</h3>
                    <p class="text-muted">
                        The AI assistant uses document embeddings for semantic search (RAG). 
                        When you upload and process documents, they are automatically indexed for AI queries.
                    </p>
                    <ul class="text-muted" style="margin-left: 20px; margin-top: 10px;">
                        <li>Use "Rebuild RAG Index" to refresh the vector store after major changes</li>
                        <li>Use "Warm FAQ Cache" to pre-load frequently asked questions</li>
                        <li>Manage FAQs in the <a href="#" onclick="showAdminSection('faqs'); return false;">FAQ Management</a> section</li>
                    </ul>
                </div>
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load training stats: ${escapeHtml(e.message)}</p>`;
    }
}

// Warm FAQ cache
async function warmFAQCache() {
    showLoading(true, 'Warming cache...');
    try {
        await apiFetch('/api/admin/cache/warmup', { method: 'POST' });
        showToast('Cache warmed successfully', 'success');
    } catch (e) {
        showToast('Cache warming failed: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

async function loadAdminSettings() {
    const container = $('adminContent');
    if (!container) return;
    
    if (!isSuperAdmin()) {
        container.innerHTML = '<p class="error">Access denied. Superadmin only.</p>';
        return;
    }
    
    try {
        const res = await apiFetch('/api/admin/settings');
        const settings = res.settings || [];
        
        let html = `
            <div class="admin-section">
                <h2><i class="fas fa-sliders-h"></i> System Settings</h2>
                <div class="settings-list">
        `;
        
        if (settings.length === 0) {
            html += '<p class="empty-state">No settings configured.</p>';
        } else {
            settings.forEach(setting => {
                html += `
                    <div class="setting-item">
                        <div class="setting-info">
                            <label>${escapeHtml(setting.setting_key)}</label>
                            <small>${escapeHtml(setting.description || '')}</small>
                        </div>
                        <div class="setting-value">
                            <input type="text" 
                                   id="setting_${setting.setting_key}" 
                                   value="${escapeHtml(setting.setting_value || '')}"
                                   data-key="${escapeHtml(setting.setting_key)}"
                                   class="form-control">
                            <button class="btn btn-sm btn-primary" onclick="saveSetting('${escapeHtml(setting.setting_key)}')">
                                <i class="fas fa-save"></i>
                            </button>
                        </div>
                    </div>
                `;
            });
        }
        
        html += '</div></div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load settings: ${escapeHtml(e.message)}</p>`;
    }
}

async function saveSetting(key) {
    const input = document.getElementById(`setting_${key}`);
    if (!input) return;
    
    showLoading(true, 'Saving setting...');
    try {
        await apiFetch(`/api/admin/settings/${key}`, {
            method: 'PUT',
            body: { value: input.value }
        });
        showToast('Setting saved', 'success');
    } catch (e) {
        showToast(e.message || 'Failed to save setting', 'error');
    } finally {
        showLoading(false);
    }
}

function renderAdminExports() {
    const container = $('adminContent');
    if (!container) return;
    
    container.innerHTML = `
        <div class="admin-section">
            <h2><i class="fas fa-download"></i> Data Exports</h2>
            <div class="export-buttons">
                <button class="btn btn-outline" onclick="runExport('users')">
                    <i class="fas fa-users"></i> Export Users
                </button>
                <button class="btn btn-outline" onclick="runExport('chat-history')">
                    <i class="fas fa-comments"></i> Export Chat Sessions
                </button>
                <button class="btn btn-outline" onclick="runExport('audit-trail')">
                    <i class="fas fa-history"></i> Export Audit Trail
                </button>
            </div>
        </div>
    `;
}

async function runExport(type) {
    showLoading(true, 'Generating export...');
    try {
        const res = await apiFetch(`/api/exports/${type}`, { method: 'POST' });
        if (res.downloadUrl) {
            // Use authenticated fetch to download the file (can't use window.location.href as it won't send auth header)
            const downloadRes = await fetch(`${AppState.apiBase}${res.downloadUrl}`, {
                headers: {
                    'Authorization': `Bearer ${AppState.token}`
                }
            });
            
            if (!downloadRes.ok) {
                throw new Error('Failed to download file');
            }
            
            const blob = await downloadRes.blob();
            const filename = res.downloadUrl.split('/').pop() || 'export.csv';
            
            // Create download link
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();
        }
        showToast('Export downloaded', 'success');
    } catch (e) {
        showToast(e.message || 'Export failed', 'error');
    } finally {
        showLoading(false);
    }
}

async function rebuildRagIndex() {
    if (!confirm('Rebuild the AI knowledge index? This may take a while.')) return;
    
    showLoading(true, 'Rebuilding index...');
    try {
        await apiFetch('/api/rag/rebuild', { method: 'POST' });
        showToast('Index rebuilt successfully', 'success');
    } catch (e) {
        showToast(e.message || 'Rebuild failed', 'error');
    } finally {
        showLoading(false);
    }
}

async function toggleUserActive(userId, value) {
    showLoading(true, value ? 'Activating user...' : 'Deactivating user...');
    try {
        await apiFetch(`/api/admin/users/${userId}/status`, {
            method: 'PUT',
            body: { isActive: value }
        });
        showToast(value ? 'User activated' : 'User deactivated', 'success');
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
    } catch (e) {
        showToast(e.message || 'Failed to update user', 'error');
    } finally {
        showLoading(false);
    }
}

async function changeUserRole(userId, newRole, currentRole) {
    if (newRole === currentRole) return;
    
    const roleLabels = { staff: 'Staff', admin: 'Admin', superadmin: 'Superadmin' };
    if (!confirm(`Change this user's role from ${roleLabels[currentRole]} to ${roleLabels[newRole]}?`)) {
        // Reset the select to previous value
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
        return;
    }
    
    showLoading(true, 'Updating role...');
    try {
        await apiFetch(`/api/admin/users/${userId}/role`, {
            method: 'PUT',
            body: { role: newRole }
        });
        showToast(`Role updated to ${roleLabels[newRole]}`, 'success');
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
    } catch (e) {
        showToast(e.message || 'Failed to update role', 'error');
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
    } finally {
        showLoading(false);
    }
}

async function deleteUser(userId, email) {
    if (!confirm(`Are you sure you want to delete user "${email}"?\n\nThis action cannot be undone.`)) return;
    
    showLoading(true, 'Deleting user...');
    try {
        await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
        showToast('User deleted successfully', 'success');
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
    } catch (e) {
        showToast(e.message || 'Failed to delete user', 'error');
    } finally {
        showLoading(false);
    }
}

async function resetUserPassword(userId, email) {
    // Create a custom modal for password reset
    const modalHtml = `
        <div id="resetPasswordModal" class="modal" style="display: flex;">
            <div class="modal-content" style="max-width: 400px;">
                <div class="modal-header">
                    <h3><i class="fas fa-key"></i> Reset Password</h3>
                    <button class="modal-close" id="resetModalCloseBtn">&times;</button>
                </div>
                <form id="resetPasswordForm" autocomplete="off">
                    <div class="modal-body">
                        <div class="reset-user-info" style="background: var(--bg-secondary); padding: 12px; border-radius: 8px; margin-bottom: 16px;">
                            <p style="margin: 0; font-size: 0.9rem; color: var(--text-muted);">Resetting password for:</p>
                            <p style="margin: 4px 0 0 0; font-weight: 600; color: var(--primary-color);">
                                <i class="fas fa-user"></i> ${escapeHtml(email)}
                            </p>
                        </div>
                        <!-- Hidden username for accessibility -->
                        <input type="text" name="username" value="${escapeHtml(email)}" autocomplete="username" style="display:none;">
                        <div class="form-group">
                            <label for="resetPasswordInput">New Password</label>
                            <input type="password" id="resetPasswordInput" name="new-password" placeholder="Enter new password (min 8 characters)" minlength="8" required autocomplete="new-password">
                        </div>
                        <div class="form-group">
                            <label for="resetPasswordConfirm">Confirm Password</label>
                            <input type="password" id="resetPasswordConfirm" name="confirm-password" placeholder="Confirm new password" minlength="8" required autocomplete="new-password">
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" id="resetModalCancelBtn">Cancel</button>
                        <button type="submit" class="btn btn-primary" id="confirmResetBtn">
                            <i class="fas fa-key"></i> Reset Password
                        </button>
                    </div>
                </form>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('resetPasswordModal');
    if (existingModal) existingModal.remove();
    
    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Focus on password input
    document.getElementById('resetPasswordInput').focus();
    
    // Close modal function
    const closeResetModal = () => {
        const modal = document.getElementById('resetPasswordModal');
        if (modal) modal.remove();
    };
    
    // Handle close button
    document.getElementById('resetModalCloseBtn').addEventListener('click', closeResetModal);
    document.getElementById('resetModalCancelBtn').addEventListener('click', closeResetModal);
    
    // Click outside to close
    document.getElementById('resetPasswordModal').addEventListener('click', (e) => {
        if (e.target.id === 'resetPasswordModal') closeResetModal();
    });
    
    // Handle form submission
    document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const newPassword = document.getElementById('resetPasswordInput').value;
        const confirmPassword = document.getElementById('resetPasswordConfirm').value;
        
        if (!newPassword || newPassword.length < 8) {
            showToast('Password must be at least 8 characters long', 'error');
            return;
        }
        
        if (newPassword !== confirmPassword) {
            showToast('Passwords do not match', 'error');
            return;
        }
        
        closeResetModal();
        showLoading(true, 'Resetting password...');
        
        try {
            await apiFetch(`/api/admin/users/${userId}/reset-password`, {
                method: 'POST',
                body: { newPassword }
            });
            showToast(`Password reset successfully for ${email}`, 'success');
        } catch (err) {
            showToast(err.message || 'Failed to reset password', 'error');
        } finally {
            showLoading(false);
        }
    });
}

async function approveUser(userId) {
    showLoading(true, 'Approving user...');
    try {
        await apiFetch(`/api/admin/users/${userId}/approve`, { method: 'POST' });
        showToast('User approved', 'success');
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
    } catch (e) {
        showToast(e.message || 'Failed to approve user', 'error');
    } finally {
        showLoading(false);
    }
}

async function rejectUser(userId) {
    const reason = prompt('Reason for rejection (optional):');
    if (reason === null) return; // User cancelled
    
    showLoading(true, 'Rejecting user...');
    try {
        await apiFetch(`/api/admin/users/${userId}/reject`, { 
            method: 'POST',
            body: { reason }
        });
        showToast('User rejected', 'success');
        loadAdminUsers(document.getElementById('userSearch')?.value || '');
    } catch (e) {
        showToast(e.message || 'Failed to reject user', 'error');
    } finally {
        showLoading(false);
    }
}

// =========================
// Boot
// =========================

function setupGlobalEventListeners() {
    // Navigation buttons (guest)
    $('loginBtn')?.addEventListener('click', () => showPage('login'));
    $('registerBtn')?.addEventListener('click', () => showPage('register'));
    $('getStartedBtn')?.addEventListener('click', () => showPage('register'));
    $('loginHeroBtn')?.addEventListener('click', () => showPage('login'));
    
    // Mobile nav toggle
    $('navToggleBtn')?.addEventListener('click', toggleMobileNav);
    
    // User menu toggle
    $('userMenuBtn')?.addEventListener('click', toggleUserMenu);
    
    // User dropdown links
    $('profileLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('profile');
    });
    $('changePasswordLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('changePassword');
    });
    $('logoutLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        logout();
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const userMenu = $('userMenu');
        const dropdown = $('userDropdown');
        if (userMenu && dropdown && !userMenu.contains(e.target)) {
            dropdown.classList.remove('show');
        }
    });
    
    // Form submissions
    $('loginForm')?.addEventListener('submit', handleLogin);
    $('registerForm')?.addEventListener('submit', handleRegister);
    $('forgotPasswordForm')?.addEventListener('submit', handleForgotPassword);
    $('changePasswordForm')?.addEventListener('submit', handleChangePassword);
    $('profileForm')?.addEventListener('submit', handleUpdateProfile);
    $('resetPasswordForm')?.addEventListener('submit', handleResetPasswordSubmit);
    $('uploadForm')?.addEventListener('submit', handleDocumentUpload);
    $('chatForm')?.addEventListener('submit', handleSendMessage);
    
    // Chat input keydown
    $('chatInput')?.addEventListener('keydown', handleChatKeydown);
    
    // Chat action buttons
    $('newChatBtn')?.addEventListener('click', startNewChat);
    $('endChatBtn')?.addEventListener('click', endCurrentChat);
    $('clearAllChatsBtn')?.addEventListener('click', clearAllChats);
    $('voiceModeBtn')?.addEventListener('click', () => toggleVoiceMode({
        page: 'chat',
        inputId: 'chatInput',
        formId: 'chatForm',
        recordingId: 'voiceRecording'
    }));
    $('startRecordingBtn')?.addEventListener('click', () => startRecording({
        inputId: 'chatInput',
        formId: 'chatForm',
        recordingId: 'voiceRecording'
    }));
    $('stopRecordingBtn')?.addEventListener('click', () => stopRecording({ recordingId: 'voiceRecording' }));
    
    // Documents page buttons
    $('uploadDocBtn')?.addEventListener('click', showUploadModal);
    $('documentSearchBtn')?.addEventListener('click', searchDocuments);
    $('documentSearch')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchDocuments();
    });
    $('categoryFilter')?.addEventListener('change', filterDocuments);
    
    // Modal close buttons
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.getAttribute('data-close-modal');
            closeModal(modalId);
        });
    });
    $('uploadModalClose')?.addEventListener('click', () => closeModal('uploadModal'));
    $('uploadModalCancel')?.addEventListener('click', () => closeModal('uploadModal'));
    
    // Forgot password link
    $('forgotPasswordLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('forgotPassword');
    });
    
    // Auth page navigation links
    $('registerLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('register');
    });
    $('loginLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('login');
    });
    
    // Back to login links (by ID and data attribute)
    $('backToLoginLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('login');
    });
    $('backToLoginLink2')?.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('login');
    });
    document.querySelectorAll('[data-back-to-login]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            showPage('login');
        });
    });
    
    // Password visibility toggle buttons
    setupPasswordToggles();
    
    // Viewer zoom buttons
    $('zoomInBtn')?.addEventListener('click', () => {
        ViewerState.zoomLevel = Math.min(200, ViewerState.zoomLevel + 10);
        applyZoom();
    });
    $('zoomOutBtn')?.addEventListener('click', () => {
        ViewerState.zoomLevel = Math.max(50, ViewerState.zoomLevel - 10);
        applyZoom();
    });
    $('zoomResetBtn')?.addEventListener('click', () => {
        ViewerState.zoomLevel = 100;
        applyZoom();
    });
    
    // Viewer dark mode toggle
    $('darkModeToggle')?.addEventListener('click', toggleDarkMode);
    
    // Viewer search buttons
    $('textSearchBtn')?.addEventListener('click', performTextSearch);
    $('smartSearchBtn')?.addEventListener('click', performSmartSearch);
    $('textSearchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') performTextSearch();
    });
    $('smartSearchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') performSmartSearch();
    });
    
    // Viewer navigation
    $('prevResultBtn')?.addEventListener('click', () => navigateSearchResults(-1));
    $('nextResultBtn')?.addEventListener('click', () => navigateSearchResults(1));
    
    // Print button
    $('printDocBtn')?.addEventListener('click', () => window.print());
    
    // Summary modal close
    $('summaryModalClose')?.addEventListener('click', () => {
        $('summaryModal')?.classList.remove('show');
    });
}

async function bootstrap() {
    // Setup all event listeners first
    setupGlobalEventListeners();
    initTtsVoiceSelectors();
    
    loadAuthFromStorage();
    updateNavForAuth();

    // Check for reset/verify hash routes FIRST
    const { route } = parseHashRoute();
    
    // Handle special routes that don't require auth
    if (route === 'reset' || route === 'verify-email') {
        await handleResetPasswordFromLink();
        return; // Don't continue - we've already navigated
    }

    // Attempt to verify stored token
    if (AppState.token) {
        try {
            const res = await apiFetch('/api/users/me');
            if (res?.user) {
                AppState.user = { ...AppState.user, ...res.user };
                updateNavForAuth();
            }
        } catch {
            clearAuth();
            updateNavForAuth();
        }
    }

    // Navigate to initial page
    if (route && route !== 'reset' && route !== 'verify-email') {
        showPage(route);
    } else if (!AppState.token) {
        showPage('home');
    } else {
        showPage('chat');
    }
}

// =========================
// CSP-safe delegated click handlers (no inline onclick)
// =========================

document.addEventListener('click', (e) => {
    // Handle document action buttons
    const docAction = e.target.closest('[data-action^="doc-"]');
    if (docAction) {
        const action = docAction.dataset.action;
        const id = Number(docAction.dataset.id);
        if (action === 'doc-view') viewDocument(id);
        if (action === 'doc-process') processDocument(id);
        if (action === 'doc-delete') deleteDocument(id);
    }
    
    // Admin nav links
    const adminLink = e.target.closest('.admin-nav-link');
    if (adminLink) {
        e.preventDefault();
        const section = adminLink.dataset.section;
        if (section) showAdminSection(section);
    }
    
    // Navigation links
    const navLink = e.target.closest('[data-page]');
    if (navLink && !navLink.closest('.admin-nav')) {
        e.preventDefault();
        showPage(navLink.dataset.page);
    }
});

// Export functions to window for inline handlers that may exist in HTML
window.showPage = showPage;
window.toggleMobileNav = toggleMobileNav;
window.toggleUserMenu = toggleUserMenu;
window.togglePassword = togglePassword;
window.logout = logout;
window.handleRegister = handleRegister;
window.handleLogin = handleLogin;
window.handleForgotPassword = handleForgotPassword;
window.handleChangePassword = handleChangePassword;
window.handleUpdateProfile = handleUpdateProfile;

window.startNewChat = startNewChat;
window.endCurrentChat = endCurrentChat;
window.clearAllChats = clearAllChats;
window.handleSendMessage = handleSendMessage;
window.handleChatKeydown = handleChatKeydown;
window.sendSuggestedQuestion = sendSuggestedQuestion;
window.toggleVoiceMode = toggleVoiceMode;
window.startRecording = startRecording;
window.stopRecording = stopRecording;

window.searchDocuments = searchDocuments;
window.filterDocuments = filterDocuments;
window.showUploadModal = showUploadModal;
window.closeModal = closeModal;
window.handleDocumentUpload = handleDocumentUpload;
window.viewDocument = viewDocument;
window.processDocument = processDocument;
window.deleteDocument = deleteDocument;

// Document Viewer exports
window.initViewerPage = initViewerPage;
window.loadDocumentInViewer = loadDocumentInViewer;
window.goToSection = goToSectionById;
window.performTextSearch = performTextSearch;
window.performSmartSearch = performSmartSearch;

window.showAdminSection = showAdminSection;
window.runExport = runExport;
window.saveSetting = saveSetting;
window.toggleUserActive = toggleUserActive;
window.changeUserRole = changeUserRole;
window.deleteUser = deleteUser;
window.resetUserPassword = resetUserPassword;
window.approveUser = approveUser;
window.rejectUser = rejectUser;

// VC Reports exports
window.initVCReportsPage = initVCReportsPage;
window.loadVCReports = loadVCReports;
window.selectVCReport = selectVCReport;
window.toggleVCReportStar = toggleVCReportStar;
window.archiveVCReport = archiveVCReport;
window.downloadVCReport = downloadVCReport;
window.reanalyzeVCReport = reanalyzeVCReport;
window.sendVCChatMessage = sendVCChatMessage;
window.addVCNote = addVCNote;
window.editVCNote = editVCNote;
window.deleteVCNote = deleteVCNote;
window.showVCUploadModal = showVCUploadModal;
window.handleVCReportUpload = handleVCReportUpload;

// VC Documents exports
window.initVCDocumentsPage = initVCDocumentsPage;
window.loadVCDocuments = loadVCDocuments;
window.selectVCDocument = selectVCDocument;
window.toggleVCDocumentStar = toggleVCDocumentStar;
window.archiveVCDocument = archiveVCDocument;
window.downloadVCDocument = downloadVCDocument;
window.reanalyzeVCDocument = reanalyzeVCDocument;
window.addVCDocumentNote = addVCDocumentNote;
window.editVCDocumentNote = editVCDocumentNote;
window.deleteVCDocumentNote = deleteVCDocumentNote;
window.showVCDocumentUploadModal = showVCDocumentUploadModal;
window.handleVCDocumentUpload = handleVCDocumentUpload;

// FAQ Admin exports
window.loadAdminFAQs = loadAdminFAQs;
window.viewFAQDetail = viewFAQDetail;
window.editFAQ = editFAQ;
window.showAddFAQModal = showAddFAQModal;
window.closeFAQModal = closeFAQModal;
window.saveFAQ = saveFAQ;
window.verifyFAQ = verifyFAQ;
window.deleteFAQ = deleteFAQ;
window.regenerateFAQAnswer = regenerateFAQAnswer;
window.searchAdminFAQs = searchAdminFAQs;
window.filterAdminFAQs = filterAdminFAQs;
window.clearFAQFilters = clearFAQFilters;
window.navigateFAQPage = navigateFAQPage;
window.downloadFAQTemplate = downloadFAQTemplate;
window.showImportFAQModal = showImportFAQModal;
window.exportFAQs = exportFAQs;

window.loadChatSessions = loadChatSessions;
window.selectChatSession = selectChatSession;
window.rateMessage = rateMessage;
window.handleResetPasswordSubmit = handleResetPasswordSubmit;
window.rebuildRagIndex = rebuildRagIndex;
window.resendMessage = resendMessage;

// Handle hash changes (e.g., clicking email links)
window.addEventListener('hashchange', () => {
    const { route } = parseHashRoute();
    
    // Handle special routes
    if (route === 'reset' || route === 'verify-email') {
        handleResetPasswordFromLink();
        return;
    }
    
    // Handle login route (from approval email)
    if (route === 'login') {
        showPage('login');
        return;
    }
    
    // Handle other routes
    if (route) {
        showPage(route);
    }
});

document.addEventListener('DOMContentLoaded', bootstrap);
