/* eslint-disable no-console */
/**
 * BMU AI Academic Advisor — client app.
 *
 * Responsibilities:
 *   - Conversation flow (POST /api/advisor/ask)
 *   - Voice input: Web Speech API primary, server STT (/api/advisor/stt) fallback
 *   - Voice output: TTSMaker audio URL, with speechSynthesis fallback
 *   - Lip-sync: amplitude-driven mouth shape from the playing audio element
 *   - Typewriter answer panel timed to the spoken duration
 *   - Topic carousel, follow-up chips, escalation modal, history sidebar
 *
 * Lottie character swap (optional): call from the browser console:
 *   window.loadLottieCharacter('https://lottie.host/your-character.json');
 */

(() => {
    'use strict';

    // -----------------------------------------------------------------------
    // Auth gate: the advisor experience requires a signed-in user. If we
    // don't have a JWT, bounce to /login carrying the URL we wanted to land
    // on (so the login page can come back here). Any ?q=... param survives
    // the round-trip via the login page.
    // -----------------------------------------------------------------------
    const _existingToken = sessionStorage.getItem('bmu_token') || localStorage.getItem('bmu_token');
    if (!_existingToken) {
        const here = location.pathname + location.search;
        const params = new URLSearchParams();
        params.set('next', '/advisor');
        const presetQ = new URLSearchParams(location.search).get('q');
        if (presetQ) params.set('q', presetQ);
        location.replace('/login?' + params.toString());
        return;
    }

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const transcript    = $('transcript');
    const composer      = $('composer');
    const questionInput = $('questionInput');
    const sendBtn       = $('sendBtn');
    const micBtn        = $('micBtn');
    const micWave       = $('micWave');
    const topicsScroller= $('topicsScroller');
    const followups     = $('followups');
    const escalateDlg   = $('escalateDialog');
    const historyToggle = $('historyToggleBtn');
    const historyPane   = $('historyPane');
    const historyClose  = $('historyCloseBtn');
    const historyList   = $('historyList');
    const advisorStatus = $('avatarStatus');
    const avatarPane    = document.querySelector('.avatar-pane');
    const avatarMuteBtn = $('avatarMuteBtn');
    const avatarPauseBtn= $('avatarPauseBtn');
    // The SVG element is rendered inside #avatarSvgHost by applyAvatar().
    // We re-resolve advisorSvg / mouthShape / brow / hand handles every
    // time we render so they always point at the live nodes.
    const avatarSvgHost = $('avatarSvgHost');
    let advisorSvg, mouthShape, mouthInner, mouthUpper, mouthLower, mouthCavity, mouthTeeth, browL, browR, lidL, lidR, pupilL, pupilR, headG, handL, handR;
    const advisorName   = $('advisorName');
    const welcomeName   = $('welcomeName');
    const toastHost     = $('toastHost');
    const avatarToggleBtn = $('avatarToggleBtn');
    const usageOverlay  = $('usageOverlay');
    const usageOverlayTitle = $('usageOverlayTitle');
    const usageOverlayBody  = $('usageOverlayBody');
    const usageOverlayHints = $('usageOverlayHints');

    // Handbook (FAQ) browser
    const handbookBtn       = $('handbookBtn');
    const handbookDlg       = $('handbookDialog');
    const handbookClose     = $('handbookClose');
    const handbookSearch    = $('handbookSearch');
    const handbookCategories= $('handbookCategories');
    const handbookResults   = $('handbookResults');
    const adminLink         = $('adminLink');

    // ---------- State ----------
    const state = {
        sessionToken: localStorage.getItem('bmu_advisor_session') || null,
        localSessionTokens: (() => {
            try {
                const arr = JSON.parse(localStorage.getItem('bmu_advisor_sessions') || '[]');
                return Array.isArray(arr) ? arr.filter(Boolean).slice(0, 80) : [];
            } catch (_) {
                return [];
            }
        })(),
        topics: [],
        token: sessionStorage.getItem('bmu_token') || localStorage.getItem('bmu_token') || null,
        recording: false,
        mediaRecorder: null,
        audioCtx: null,
        currentAudio: null,
        ttsMuted: localStorage.getItem('bmu_tts_muted') === '1',
        ttsPaused: false,
        currentLottie: null,
        activeResponseBubble: null,
        speakingFocusTimer: null,
        lastSpeakingFocusAt: 0,
        historyLoaded: false,
        loadingHistory: false,
        usageIntroShown: false,
        usage: null
    };

    if (state.sessionToken && !state.localSessionTokens.includes(state.sessionToken)) {
        state.localSessionTokens = [state.sessionToken, ...state.localSessionTokens].slice(0, 80);
        try { localStorage.setItem('bmu_advisor_sessions', JSON.stringify(state.localSessionTokens)); } catch (_) { /* ignore */ }
    }

    function isMobileLayout() {
        return window.matchMedia('(max-width: 1024px)').matches;
    }

    function syncMobileLayoutVars() {
        const topBar = document.querySelector('.top-bar');
        const topH = topBar ? Math.ceil(topBar.getBoundingClientRect().height) : 64;
        const avatarH = avatarPane ? Math.ceil(avatarPane.getBoundingClientRect().height) : 160;
        document.documentElement.style.setProperty('--mobile-topbar-h', `${topH}px`);
        document.documentElement.style.setProperty('--mobile-avatar-h', `${avatarH}px`);
    }

    function setActiveResponseBubble(el) {
        if (state.activeResponseBubble && state.activeResponseBubble !== el) {
            state.activeResponseBubble.classList.remove('is-speaking-focus');
        }
        state.activeResponseBubble = el || null;
        if (state.activeResponseBubble && document.body.classList.contains('is-speaking')) {
            state.activeResponseBubble.classList.add('is-speaking-focus');
        }
    }

    function focusActiveResponseBubble(force = false) {
        if (!isMobileLayout()) return;
        if (!document.body.classList.contains('is-speaking')) return;
        const el = state.activeResponseBubble;
        if (!el) return;

        const now = Date.now();
        if (!force && now - state.lastSpeakingFocusAt < 900) return;
        state.lastSpeakingFocusAt = now;

        el.classList.add('is-speaking-focus');
        el.scrollIntoView({ behavior: force ? 'smooth' : 'auto', block: 'start', inline: 'nearest' });
    }

    function authHeaders() {
        return state.token ? { Authorization: `Bearer ${state.token}` } : {};
    }

    function rememberSessionToken(token) {
        const t = String(token || '').trim();
        if (!t) return;
        const next = [t, ...state.localSessionTokens.filter(x => x !== t)].slice(0, 80);
        state.localSessionTokens = next;
        try { localStorage.setItem('bmu_advisor_sessions', JSON.stringify(next)); } catch (_) { /* ignore */ }
    }

    function localSessionsQuery() {
        return state.localSessionTokens.length
            ? `&localSessions=${encodeURIComponent(state.localSessionTokens.join(','))}`
            : '';
    }

    function showUsageOverlay({ title, body, hints = [] }) {
        if (!usageOverlay) return;
        if (usageOverlayTitle) usageOverlayTitle.innerHTML = `<i class="fa-solid fa-gauge"></i> ${escapeHtml(title || 'Usage Limits')}`;
        if (usageOverlayBody) usageOverlayBody.textContent = body || '';
        if (usageOverlayHints) {
            usageOverlayHints.innerHTML = '';
            for (const h of hints) {
                const li = document.createElement('li');
                li.textContent = h;
                usageOverlayHints.appendChild(li);
            }
        }
        if (typeof usageOverlay.showModal === 'function') usageOverlay.showModal();
        else usageOverlay.setAttribute('open', '');
    }

    function maybeShowUsageIntro(user) {
        if (!user || state.usageIntroShown) return;
        const key = `bmu_usage_intro_seen_${user.id || user.email || 'user'}`;
        if (localStorage.getItem(key) === '1') return;
        const dayLimit = Number(state.usage?.day?.limit ?? 10);
        const monthLimit = Number(state.usage?.month?.limit ?? 100);
        showUsageOverlay({
            title: 'Daily and Monthly Prompt Limits',
            body: `You can ask up to ${dayLimit === -1 ? 'unlimited' : dayLimit} prompts per day and ${monthLimit === -1 ? 'unlimited' : monthLimit} prompts per month.`,
            hints: [
                'Your usage is tracked automatically each time the advisor replies.',
                'Daily quota resets at midnight, monthly quota resets on the 1st.',
                'If you hit a limit, you will see a prompt with what to do next.'
            ]
        });
        localStorage.setItem(key, '1');
        state.usageIntroShown = true;
    }

    // ---------- Toast ----------
    function toast(msg, kind = 'info') {
        const el = document.createElement('div');
        el.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
        el.textContent = msg;
        toastHost.appendChild(el);
        setTimeout(() => el.remove(), 4200);
    }

    // ---------- Avatar state machine ----------
    // The "expression" is a high-level mood the advisor wears; the
    // "state" is what it's doing right now (idle / listening / thinking /
    // speaking). Both are driven independently so a smile can survive a
    // blink, and a "thinking" furrow can co-exist with the speaking bob.
    let currentState = 'idle';
    let currentExpression = 'neutral';
    let browAnchors = null;

    function setAvatarState(stateName, label) {
        currentState = stateName;
        advisorStatus.dataset.state = stateName;
        advisorStatus.querySelector('.label').textContent = label || stateName;
        const speaking = stateName === 'speaking' || stateName === 'talking';
        document.body.classList.toggle('is-speaking', speaking);

        if (state.speakingFocusTimer) {
            clearInterval(state.speakingFocusTimer);
            state.speakingFocusTimer = null;
        }
        if (speaking) {
            focusActiveResponseBubble(true);
            state.speakingFocusTimer = setInterval(() => focusActiveResponseBubble(false), 1200);
        } else if (state.activeResponseBubble) {
            state.activeResponseBubble.classList.remove('is-speaking-focus');
        }

        if (advisorSvg) {
            advisorSvg.classList.toggle('av-listening', stateName === 'listening');
            advisorSvg.classList.toggle('av-thinking',  stateName === 'thinking');
            advisorSvg.classList.toggle('av-speaking',  speaking);
        }
    }

    // ---------- Avatar gender ----------
    // Read the user's preference (localStorage cache OR the cached user
    // record). Defaults to 'female' so unchanged accounts keep the same
    // Dr. Tari they're used to.
    function getAdvisorGender() {
        const cached = localStorage.getItem('bmu_advisor_gender');
        if (cached === 'male' || cached === 'female') return cached;
        try {
            const u = JSON.parse(localStorage.getItem('bmu_user') || 'null');
            if (u?.advisorGender === 'male' || u?.advisorGender === 'female') return u.advisorGender;
        } catch (_) { /* ignore */ }
        return 'female';
    }

    /** Render the SVG for the chosen gender into the host div, then
     *  re-resolve all the named handles so every helper below points at
     *  the live nodes (the previous SVG, if any, is replaced wholesale). */
    function applyAvatar(gender) {
        const g = gender === 'male' ? 'male' : 'female';
        if (!avatarSvgHost || !window.BMUAvatars) return;

        avatarSvgHost.innerHTML = window.BMUAvatars.svg(g);

        // Re-resolve handles
        advisorSvg = avatarSvgHost.querySelector('#avatarSvg');
        mouthShape = avatarSvgHost.querySelector('#avMouth');
        mouthInner = avatarSvgHost.querySelector('#avMouthInner');
        mouthUpper = avatarSvgHost.querySelector('#avMouthUpper');
        mouthLower = avatarSvgHost.querySelector('#avMouthLower');
        mouthCavity= avatarSvgHost.querySelector('#avMouthCavity');
        mouthTeeth = avatarSvgHost.querySelector('#avMouthTeeth');
        browL      = avatarSvgHost.querySelector('#avBrowL');
        browR      = avatarSvgHost.querySelector('#avBrowR');
        lidL       = avatarSvgHost.querySelector('#avLidL');
        lidR       = avatarSvgHost.querySelector('#avLidR');
        pupilL     = avatarSvgHost.querySelector('#avPupilL');
        pupilR     = avatarSvgHost.querySelector('#avPupilR');
        headG      = avatarSvgHost.querySelector('#avHead');
        handL      = avatarSvgHost.querySelector('#avHandL');
        handR      = avatarSvgHost.querySelector('#avHandR');
        browAnchors = null;

        const stage = document.getElementById('avatarStage');
        if (stage) {
            stage.dataset.avatarMode = 'svg';
            stage.dataset.advisorGender = g;
        }
        if (advisorName) advisorName.textContent = 'Dr. Tari';
        if (welcomeName) welcomeName.textContent = 'Dr. Tari';

        // Reset everything to neutral / idle
        setMouthOpenness(0);
        setExpression('neutral');
        setAvatarState(currentState || 'idle', advisorStatus.querySelector('.label')?.textContent || 'Ready');
        syncMobileLayoutVars();
    }

    /** Save the chosen avatar both locally and on the server. */
    async function saveAdvisorGender(gender) {
        const g = gender === 'male' ? 'male' : 'female';
        localStorage.setItem('bmu_advisor_gender', g);
        try {
            const u = JSON.parse(localStorage.getItem('bmu_user') || 'null');
            if (u) { u.advisorGender = g; localStorage.setItem('bmu_user', JSON.stringify(u)); }
        } catch (_) { /* ignore */ }
        applyAvatar(g);
        try {
            await fetch('/api/users/advisor-preference', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ gender: g })
            });
        } catch (_) { /* non-fatal */ }
    }

    // Initial paint
    applyAvatar(getAdvisorGender());

    // ---------- Blinks ----------
    // Animate the eyelids by stretching their height from 0 -> full -> 0
    // over ~140ms. Using width/height instead of a CSS class because the
    // lid rectangles are inside the SVG and don't get a transform origin
    // that survives re-render.
    function blink() {
        if (!lidL || !lidR) return;
        // Clamp to non-negative; the previous version sometimes called
        // grow() with a tiny negative number (rounding error when t ≥ 1)
        // which the SVG <rect> rejects with a console error.
        const grow = (h) => {
            const v = Math.max(0, h);
            lidL.setAttribute('height', v);
            lidR.setAttribute('height', v);
        };
        const FULL = 16;
        let t = 0;
        const start = performance.now();
        const step = (now) => {
            t = (now - start) / 140;
            if (t < 0.5)      grow(FULL * (t * 2));
            else if (t < 1)   grow(FULL * (2 - t * 2));
            else { grow(0); return; }   // hard reset, no further frames
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }
    setInterval(() => { if (Math.random() < 0.85) blink(); }, 4200);

    // ---------- Subtle gaze drift ----------
    // Move the pupils a couple of pixels every few seconds so the eyes
    // feel alive instead of staring through the user.
    setInterval(() => {
        if (!pupilL || !pupilR) return;
        const dx = (Math.random() - 0.5) * 4;
        const dy = (Math.random() - 0.5) * 2;
        for (const p of [pupilL, pupilR]) {
            p.setAttribute('transform', `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`);
        }
    }, 3500);

    // ---------- Mouth shape ----------
    // Drives the four mouth pieces (upper lip, lower lip, cavity, teeth)
    // from a 0..1 openness level. The previous single-curve mouth was
    // visually too subtle — students reported lip-sync was hard to see.
    // Now:
    //   - upper lip rises  by up to 5px
    //   - lower lip drops  by up to 9px  (asymmetric like a real jaw)
    //   - cavity opens to follow the new lip gap (dark void in back)
    //   - teeth strip fades in at half-open (visible only when wide)
    //   - smile/concerned/neutral expressions reshape the LIP CORNERS
    //     so a smile while speaking still reads as a smile.
    function setMouthOpenness(level) {
        if (!mouthUpper || !mouthLower) return;
        const W = 16;
        const open = Math.max(0, Math.min(1, level));   // 0..1

        // Vertical lip displacement. The lower lip moves further than the
        // upper lip (the jaw drops more than the upper face).
        const upperRise = open * 5;        // px the upper lip travels UP
        const lowerDrop = open * 9;        // px the lower lip travels DOWN

        // Lip corner offset for expression. Smile pulls corners up (-3),
        // concerned pulls them down (+2.5), neutral stays flat.
        const cornerY = currentExpression === 'smile'     ? -3
                      : currentExpression === 'concerned' ?  2.5
                      : currentExpression === 'surprised' ? -1
                      : 0;

        // Upper lip: corners at (±W, cornerY), bow dipping at (0, -upperRise)
        const upperD = `M ${-W} ${cornerY} Q ${-W*0.4} ${cornerY - upperRise * 0.6} 0 ${-upperRise} ` +
                       `Q ${W*0.4} ${cornerY - upperRise * 0.6} ${W} ${cornerY} ` +
                       `Q ${W*0.4} ${cornerY - upperRise * 0.2} 0 ${-upperRise + 1.5} ` +
                       `Q ${-W*0.4} ${cornerY - upperRise * 0.2} ${-W} ${cornerY} Z`;
        mouthUpper.setAttribute('d', upperD);

        // Lower lip: corners at (±W, cornerY), curving DOWN to (0, lowerDrop)
        const lowerD = `M ${-W} ${cornerY} Q ${-W*0.4} ${cornerY + lowerDrop * 0.7} 0 ${lowerDrop} ` +
                       `Q ${W*0.4} ${cornerY + lowerDrop * 0.7} ${W} ${cornerY} ` +
                       `Q ${W*0.4} ${cornerY + lowerDrop * 0.3} 0 ${lowerDrop - 1.5} ` +
                       `Q ${-W*0.4} ${cornerY + lowerDrop * 0.3} ${-W} ${cornerY} Z`;
        mouthLower.setAttribute('d', lowerD);

        // Cavity: an oval that fills the space between lip tips. Hidden
        // when nearly closed (open<0.05) so we don't render a black line
        // when the mouth is at rest.
        if (mouthCavity) {
            if (open < 0.05) {
                mouthCavity.setAttribute('d', `M 0 0 Z`);
            } else {
                const innerW = W * 0.85;
                const top    = -upperRise * 0.85;
                const bottom =  lowerDrop * 0.85;
                mouthCavity.setAttribute('d',
                    `M ${-innerW} 0 Q 0 ${top.toFixed(1)} ${innerW} 0 Q 0 ${bottom.toFixed(1)} ${-innerW} 0 Z`);
            }
        }

        // Teeth strip: fades in from open=0.35 onwards so a wide-open
        // mouth shows a clear off-white strip across the top half of the
        // cavity. Looks like the upper teeth.
        if (mouthTeeth) {
            const teethOpacity = Math.max(0, (open - 0.35) / 0.6);   // 0..1 as open goes 0.35->0.95
            const teethW = W * 0.75;
            const teethTop = -upperRise * 0.55;
            const teethBot = -upperRise * 0.15;
            mouthTeeth.setAttribute('opacity', teethOpacity.toFixed(2));
            mouthTeeth.setAttribute('d',
                `M ${-teethW} ${teethTop.toFixed(1)} L ${teethW} ${teethTop.toFixed(1)} ` +
                `L ${teethW} ${teethBot.toFixed(1)} L ${-teethW} ${teethBot.toFixed(1)} Z`);
        }
    }

    // ---------- Brow + expression API ----------
    // Maps a high-level mood to brow + mouth shape. The chat layer calls
    // setExpression('smile') after a successful answer, 'thinking' while
    // the LLM is generating, 'concerned' for escalations, etc.
    //
    // Important: the female and male avatars have brows at slightly
    // different x-anchors. We read those anchors from the SVG's initial
    // d= attribute once per render so the same logic works for both.
    function _captureBrowAnchors() {
        if (!browL || !browR) { browAnchors = null; return; }
        // d looks like "M82 118 Q92 113 102 118". Parse the three x's of
        // each brow and the resting y.
        const parse = (path) => {
            const nums = (path.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g) || [];
            // [Mx My Qcx cy Lx Ly] — start, control, end
            return {
                x0: +nums[0], y0: +nums[1],
                cx: +nums[2], cy: +nums[3],
                x1: +nums[4], y1: +nums[5]
            };
        };
        browAnchors = {
            L: parse(browL),
            R: parse(browR),
        };
    }

    function setExpression(mood) {
        currentExpression = ['neutral','smile','concerned','thinking','surprised'].includes(mood)
            ? mood : 'neutral';
        if (!browL || !browR) return;
        if (!browAnchors) _captureBrowAnchors();
        if (!browAnchors) return;

        // For each mood we shift the resting y (DY) and the curvature (CV).
        // Positive DY = brow lower on the face (looks concerned/furrowed);
        // negative DY = brow higher (raised/surprised). CV > 0 deepens the
        // arch (worried); CV < 0 lifts the inner brow (happy).
        const moods = {
            neutral:    { dy:  0,  cv:  0,  asym: 0 },
            smile:      { dy: -2,  cv: -3,  asym: 0 },
            concerned:  { dy:  3,  cv:  3,  asym: 0 },
            thinking:   { dy:  1,  cv:  0,  asym: 3 },   // right brow lifts
            surprised:  { dy: -7,  cv: -5,  asym: 0 }
        };
        const m = moods[currentExpression];
        const renderBrow = (anchor, side) => {
            const dy = m.dy + (side === 'R' ? m.asym : 0);
            const cv = m.cv + (side === 'R' ? -m.asym * 0.6 : 0);
            const x0 = anchor.x0, x1 = anchor.x1, cx = anchor.cx;
            const yBase = anchor.y0;     // resting y
            const yCtrl = anchor.cy + cv;
            return `M${x0} ${yBase + dy} Q${cx} ${yCtrl + dy} ${x1} ${yBase + dy}`;
        };
        browL.setAttribute('d', renderBrow(browAnchors.L, 'L'));
        browR.setAttribute('d', renderBrow(browAnchors.R, 'R'));
        // Re-render the mouth so the smile/frown curve picks up.
        setMouthOpenness(0);
    }
    setExpression('neutral');

    // Expose for any future caller (auto-mood from chat replies):
    window.advisorAvatar = { setExpression, applyAvatar, getAdvisorGender };

    // ---------- API ----------
    async function api(path, opts = {}) {
        const init = {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        };
        const res = await fetch(path, init);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        return data;
    }

    // ---------- Topics ----------
    async function loadTopics() {
        try {
            const data = await api('/api/advisor/topics');
            state.topics = data.topics || [];
            renderTopics();
        } catch (err) {
            console.warn('[advisor] topics:', err.message);
        }
    }
    function renderTopics() {
        topicsScroller.innerHTML = '';
        for (const t of state.topics) {
            const btn = document.createElement('button');
            btn.className = 'topic-pill';
            btn.type = 'button';
            const icon = (t.icon || 'fa-circle-question').replace(/^fa[\s-]/, '');
            btn.innerHTML = `<i class="fa-solid ${t.icon || 'fa-circle-question'}"></i> ${escapeHtml(t.title)}`;
            btn.addEventListener('click', () => {
                // Send the topic title verbatim — the previous wrapper
                // ("Tell me about: <title>") meant the model saw a
                // re-phrased prompt and often answered something
                // tangentially related instead of the topic the student
                // actually clicked.
                questionInput.value = t.title;
                askNow();
            });
            topicsScroller.appendChild(btn);
        }
    }

    // ---------- Render bubbles ----------
    function addStudentBubble(text) {
        const el = document.createElement('article');
        el.className = 'bubble bubble--student';
        el.innerHTML = `<header>You</header><div class="bubble-body">${escapeHtml(text)}</div>`;
        transcript.appendChild(el);
        scrollToBottom();
    }

    function addAdvisorBubble() {
        const el = document.createElement('article');
        el.className = 'bubble bubble--advisor';
        el.innerHTML = `
            <header><i class="fa-solid fa-graduation-cap"></i> ${escapeHtml(window.ADVISOR_NAME || 'Dr. Tari')}</header>
            <div class="bubble-body"><span class="typewriter"></span><span class="caret"></span></div>
            <div class="action-buttons"></div>
            <div class="bubble-footer hidden">
                <button type="button" class="play-btn"><i class="fa-solid fa-volume-high"></i> Listen again</button>
                <span class="cite"></span>
            </div>`;
        transcript.appendChild(el);
        scrollToBottom();
        return {
            el,
            body:    el.querySelector('.typewriter'),
            caret:   el.querySelector('.caret'),
            actions: el.querySelector('.action-buttons'),
            footer:  el.querySelector('.bubble-footer'),
            cite:    el.querySelector('.cite'),
            playBtn: el.querySelector('.play-btn')
        };
    }

    function addAdvisorHistoryBubble(text) {
        const el = document.createElement('article');
        el.className = 'bubble bubble--advisor';
        const body = escapeHtml(text || '');
        el.innerHTML = `
            <header><i class="fa-solid fa-graduation-cap"></i> ${escapeHtml(window.ADVISOR_NAME || 'Dr. Tari')}</header>
            <div class="bubble-body">${body}</div>`;
        transcript.appendChild(el);
        return el;
    }

    function fillBubbleMeta(bubble, { citations, suggested_actions, speech_text, audio_url, message_id }) {
        if (message_id) bubble.el.dataset.messageId = String(message_id);
        if (Array.isArray(suggested_actions) && suggested_actions.length) {
            bubble.actions.innerHTML = '';
            for (const a of suggested_actions) {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = a.label;
                // Use the button's own label as the question. The previous
                // implementation routed every `open_topic:<slug>` action
                // through handleAction(), which then sent a generic
                // "Tell me more about <Topic Title>" prompt — so a button
                // labelled "400 level courses" would actually ask
                // "Tell me more about Programmes, courses & registration".
                // Special actions (escalate / external URLs) still go via
                // handleAction; everything else asks the literal label.
                b.addEventListener('click', () => {
                    if (a.action === 'escalate_to_human' ||
                        a.action === 'start_study_plan' ||
                        (typeof a.action === 'string' && a.action.startsWith('open_url:'))) {
                        handleAction(a.action);
                    } else {
                        questionInput.value = a.label;
                        askNow();
                    }
                });
                bubble.actions.appendChild(b);
            }
        }

        const msgId = Number(bubble.el.dataset.messageId || message_id || 0);
        if (msgId) {
            const fbWrap = document.createElement('div');
            fbWrap.className = 'advisor-feedback';
            fbWrap.innerHTML = `
                <button type="button" class="feedback-btn" data-helpful="1" title="Helpful">
                    <i class="fa-regular fa-thumbs-up"></i>
                </button>
                <button type="button" class="feedback-btn" data-helpful="0" title="Not helpful">
                    <i class="fa-regular fa-thumbs-down"></i>
                </button>`;
            const buttons = Array.from(fbWrap.querySelectorAll('.feedback-btn'));
            buttons.forEach(btn => {
                btn.addEventListener('click', async () => {
                    const helpful = btn.getAttribute('data-helpful') === '1';
                    const ok = await sendAdvisorFeedback(msgId, helpful);
                    if (!ok) return;
                    buttons.forEach(b => b.classList.remove('is-selected'));
                    btn.classList.add('is-selected');
                });
            });
            bubble.actions.appendChild(fbWrap);
        }

        if (!bubble.actions.children.length) {
            bubble.actions.remove();
        }

        if (Array.isArray(citations) && citations.length) {
            bubble.cite.innerHTML = `<strong>Sources:</strong> ${citations.map(c => escapeHtml(c.title || c.source || '')).join(' • ')}`;
            bubble.footer.classList.remove('hidden');
        }
        if (bubble.playBtn) {
            bubble.playBtn.addEventListener('click', async () => {
                await replayAdvisorSpeech(bubble, speech_text || '');
            });
        }
    }

    async function sendAdvisorFeedback(advisorMessageId, helpful) {
        try {
            await api('/api/advisor/feedback', {
                method: 'POST',
                body: { advisorMessageId, helpful }
            });
            toast(helpful ? 'Thanks. Marked helpful.' : 'Thanks. We will improve this answer.');
            return true;
        } catch (err) {
            toast(err.message || 'Could not save feedback', 'error');
            return false;
        }
    }

    async function replayAdvisorSpeech(bubble, speechText) {
        const spoken = String(speechText || '').trim();
        if (!spoken) return;

        if (bubble?.playBtn) {
            bubble.playBtn.disabled = true;
            bubble.playBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing voice';
        }

        try {
            setActiveResponseBubble(bubble?.el || null);
            const data = await api('/api/advisor/tts', {
                method: 'POST',
                body: {
                    text: spoken,
                    advisorGender: getAdvisorGender()
                }
            });

            const freshAudioUrl = data?.audio?.audio_url || null;
            if (freshAudioUrl) {
                await playWithLipSync(freshAudioUrl, spoken, bubble?.el || null);
            } else {
                await speakWithBrowser(spoken, bubble?.el || null);
            }
        } catch (err) {
            console.warn('[advisor] replay tts failed:', err.message);
            await speakWithBrowser(spoken, bubble?.el || null);
        } finally {
            if (bubble?.playBtn) {
                bubble.playBtn.disabled = false;
                bubble.playBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i> Listen again';
            }
        }
    }

    function renderFollowups(list) {
        followups.innerHTML = '';
        if (!Array.isArray(list) || !list.length) return;
        for (const q of list) {
            const chip = document.createElement('button');
            chip.className = 'followup-chip';
            chip.type = 'button';
            chip.textContent = q;
            chip.addEventListener('click', () => {
                questionInput.value = q;
                askNow();
            });
            followups.appendChild(chip);
        }
    }

    function handleAction(action) {
        if (!action) return;
        if (action === 'escalate_to_human') {
            openEscalation();
        } else if (action === 'start_study_plan') {
            toast('Study plans coming soon.');
        } else if (action.startsWith('open_topic:')) {
            // Send the topic title literally so the LLM (or FAQ cache)
            // answers about that topic specifically. We no longer wrap
            // it as "Tell me more about ..." — the wrapper led the model
            // away from the precise topic the student selected.
            const slug = action.slice('open_topic:'.length);
            const topic = state.topics.find(t => t.slug === slug);
            if (topic) {
                questionInput.value = topic.title;
                askNow();
            }
        } else if (action.startsWith('open_url:')) {
            const url = action.slice('open_url:'.length);
            if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
        }
    }

    function formatHistoryTime(value) {
        if (!value) return '';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    async function loadHistoryList(force = false) {
        if (!state.token) return;
        if (state.loadingHistory) return;
        if (state.historyLoaded && !force) return;
        state.loadingHistory = true;
        historyList.innerHTML = '<p class="muted">Loading conversations…</p>';
        try {
            const data = await api(`/api/advisor/history?limit=20${localSessionsQuery()}`);
            const list = Array.isArray(data.conversations) ? data.conversations : [];
            state.historyLoaded = true;

            if (!list.length) {
                historyList.innerHTML = '<p class="muted">No conversations yet. Ask your first question to start one.</p>';
                return;
            }

            historyList.innerHTML = '';
            for (const c of list) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'item';
                item.style.width = '100%';
                item.style.textAlign = 'left';
                item.style.background = 'transparent';
                const active = state.sessionToken && c.sessionToken === state.sessionToken;
                if (active) item.style.borderColor = 'var(--accent)';
                item.innerHTML = `
                    <div class="title">${escapeHtml(c.title || 'Conversation')}</div>
                    <div class="when">${escapeHtml(formatHistoryTime(c.lastActiveAt || c.createdAt))}${c.messageCount ? ` • ${c.messageCount} msgs` : ''}</div>
                    ${c.preview ? `<div class="when">${escapeHtml(String(c.preview).slice(0, 100))}</div>` : ''}
                `;
                item.addEventListener('click', () => openHistoryConversation(c.sessionToken));
                historyList.appendChild(item);
            }
        } catch (err) {
            historyList.innerHTML = '<p class="muted">Could not load conversation history.</p>';
        } finally {
            state.loadingHistory = false;
        }
    }

    async function openHistoryConversation(sessionToken) {
        if (!sessionToken) return;
        stopCurrentAudio();
        followups.innerHTML = '';
        setAvatarState('thinking', 'Loading conversation');
        try {
            const data = await api(`/api/advisor/history/${encodeURIComponent(sessionToken)}/messages?limit=120${localSessionsQuery()}`);
            const messages = Array.isArray(data.messages) ? data.messages : [];

            transcript.innerHTML = '';
            for (const m of messages) {
                if (m.role === 'student') {
                    addStudentBubble(m.text || '');
                } else if (m.role === 'advisor') {
                    addAdvisorHistoryBubble(m.display_markdown || m.speech_text || m.text || '');
                }
            }

            state.sessionToken = sessionToken;
            localStorage.setItem('bmu_advisor_session', sessionToken);
            rememberSessionToken(sessionToken);
            await loadHistoryList(true);
            setAvatarState('idle', 'Ready');
            scrollToBottom();
        } catch (err) {
            setAvatarState('idle', 'Ready');
            toast(err.message || 'Could not open this conversation.', 'error');
        }
    }

    // ---------- Typewriter + lip-sync ----------
    function visemeFromChar(ch) {
        const c = String(ch || '').toLowerCase();
        if (!c) return 0;
        if ('ao'.includes(c)) return 0.95;
        if ('e'.includes(c)) return 0.85;
        if ('iuy'.includes(c)) return 0.62;
        if ('mbp'.includes(c)) return 0.14; // lips closed
        if ('fv'.includes(c)) return 0.32;
        if ('w'.includes(c)) return 0.42;
        if ('lr'.includes(c)) return 0.52;
        if ('tdnsz'.includes(c)) return 0.45;
        if ('kgcqxjh'.includes(c)) return 0.56;
        if (/\d/.test(c)) return 0.58;
        return 0.5;
    }

    function estimateSyllables(word) {
        const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!w) return 1;
        const groups = w.match(/[aeiouy]+/g);
        return Math.max(1, groups ? groups.length : 1);
    }

    function createVisemeTimeline(text, durationSec) {
        const src = String(text || '').trim();
        if (!src || !Number.isFinite(durationSec) || durationSec <= 0) {
            return () => 0;
        }

        const tokens = src.match(/[A-Za-z0-9']+|[.,!?;:]/g) || [];
        if (!tokens.length) return () => 0;

        const weighted = tokens.map((tok) => {
            if (/^[.,!?;:]$/.test(tok)) {
                return {
                    type: 'pause',
                    token: tok,
                    chars: [],
                    weight: /[.!?]/.test(tok) ? 1.3 : 0.75
                };
            }
            const syll = estimateSyllables(tok);
            const chars = tok.toLowerCase().split('');
            return {
                type: 'word',
                token: tok,
                chars,
                weight: Math.max(1, syll) + Math.min(0.6, tok.length * 0.03)
            };
        });

        const totalWeight = weighted.reduce((a, b) => a + b.weight, 0) || 1;
        let cursor = 0;
        for (const item of weighted) {
            const span = (item.weight / totalWeight) * durationSec;
            item.start = cursor;
            item.end = cursor + span;
            cursor += span;
        }

        return (t) => {
            const now = Math.max(0, Math.min(durationSec, t));
            const item = weighted.find(it => now >= it.start && now <= it.end) || weighted[weighted.length - 1];
            if (!item || item.type === 'pause' || !item.chars.length) return 0;

            const span = Math.max(0.001, item.end - item.start);
            const p = Math.max(0, Math.min(0.999, (now - item.start) / span));
            const idx = Math.min(item.chars.length - 1, Math.floor(p * item.chars.length));
            const base = visemeFromChar(item.chars[idx]);
            // Open in the middle of each word, close near boundaries.
            const envelope = Math.pow(Math.sin(Math.PI * p), 0.75);
            return Math.max(0, Math.min(1, base * (0.25 + envelope * 0.95)));
        };
    }

    /**
     * Play audioUrl while updating mouth from amplitude.
     * Returns the actual duration in ms when finished, or 0 if aborted.
     */
    async function playWithLipSync(audioUrl, spokenText = '', bubbleEl = null) {
        return new Promise((resolve) => {
            try {
                if (bubbleEl) setActiveResponseBubble(bubbleEl);
                stopCurrentAudio();
                const audio = new Audio(audioUrl);
                audio.crossOrigin = 'anonymous';
                audio.volume = state.ttsMuted ? 0 : 1;
                state.currentAudio = audio;

                if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const src = state.audioCtx.createMediaElementSource(audio);
                const analyser = state.audioCtx.createAnalyser();
                analyser.fftSize = 256;
                src.connect(analyser); analyser.connect(state.audioCtx.destination);
                const data = new Uint8Array(analyser.frequencyBinCount);
                let visemeAtTime = () => 0;

                audio.addEventListener('loadedmetadata', () => {
                    const dur = Number(audio.duration);
                    if (Number.isFinite(dur) && dur > 0) {
                        visemeAtTime = createVisemeTimeline(spokenText, dur);
                    }
                });

                let raf;
                let smoothLevel = 0;
                const tick = () => {
                    analyser.getByteFrequencyData(data);
                    let low = 0;
                    let high = 0;
                    const len = Math.min(96, data.length);
                    for (let i = 3; i < len; i++) {
                        if (i < 20) low += data[i];
                        else high += data[i];
                    }

                    // Audio envelope: broad energy + consonant edge energy.
                    const lowNorm = low / (20 * 255);
                    const highNorm = high / (Math.max(1, len - 20) * 255);
                    const audioLevel = Math.min(1, Math.max(0, lowNorm * 1.9 + highNorm * 0.9));

                    // Text-driven viseme at current playback time.
                    const visemeLevel = visemeAtTime(audio.currentTime || 0);

                    // Blend: audio keeps rhythm honest, viseme gives clear
                    // articulation shape so the mouth reads as real speech.
                    const target = Math.min(1, Math.max(0, audioLevel * 0.58 + visemeLevel * 0.62));
                    const alpha = target > smoothLevel ? 0.52 : 0.24;
                    smoothLevel = smoothLevel + (target - smoothLevel) * alpha;
                    setMouthOpenness(smoothLevel);
                    raf = requestAnimationFrame(tick);
                };

                audio.addEventListener('play', () => { setAvatarState('speaking', 'Speaking'); tick(); });
                audio.addEventListener('pause', () => {
                    if (!audio.ended) setAvatarState('idle', 'Paused');
                });
                audio.addEventListener('ended', () => {
                    cancelAnimationFrame(raf); setMouthOpenness(0); setAvatarState('idle', 'Ready');
                    state.ttsPaused = false;
                    const dur = audio.duration && isFinite(audio.duration) ? audio.duration * 1000 : 0;
                    resolve(dur);
                });
                audio.addEventListener('error', () => { cancelAnimationFrame(raf); setMouthOpenness(0); resolve(0); });
                audio.play().catch(() => resolve(0));
            } catch (err) {
                console.warn('[advisor] audio playback failed:', err.message);
                resolve(0);
            }
        });
    }

    function stopCurrentAudio() {
        if (state.currentAudio) {
            try { state.currentAudio.pause(); } catch (_) {}
            try { state.currentAudio.currentTime = 0; } catch (_) {}
            state.currentAudio = null;
        }
        if (state.activeUtterance) {
            try { state.activeUtterance.stopPulse(); } catch (_) {}
            state.activeUtterance = null;
        }
        try { window.speechSynthesis?.cancel(); } catch (_) {}
        state.ttsPaused = false;
        setMouthOpenness(0);
        if (avatarPauseBtn) {
            avatarPauseBtn.setAttribute('aria-pressed', 'false');
            avatarPauseBtn.classList.remove('is-active');
            avatarPauseBtn.title = 'Pause advisor speech';
            avatarPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        }
    }

    function applyMuteState() {
        if (state.currentAudio) {
            state.currentAudio.volume = state.ttsMuted ? 0 : 1;
        }
        if (avatarMuteBtn) {
            avatarMuteBtn.setAttribute('aria-pressed', state.ttsMuted ? 'true' : 'false');
            avatarMuteBtn.classList.toggle('is-active', state.ttsMuted);
            avatarMuteBtn.title = state.ttsMuted ? 'Unmute advisor' : 'Mute advisor';
            avatarMuteBtn.innerHTML = state.ttsMuted
                ? '<i class="fa-solid fa-volume-xmark"></i>'
                : '<i class="fa-solid fa-volume-high"></i>';
        }
    }

    function togglePauseSpeech() {
        if (state.currentAudio) {
            if (state.currentAudio.paused) {
                state.currentAudio.play().catch(() => {});
                state.ttsPaused = false;
            } else {
                state.currentAudio.pause();
                state.ttsPaused = true;
            }
        } else if (window.speechSynthesis?.speaking) {
            if (window.speechSynthesis.paused) {
                try { window.speechSynthesis.resume(); } catch (_) {}
                state.ttsPaused = false;
                setAvatarState('speaking', 'Speaking');
            } else {
                try { window.speechSynthesis.pause(); } catch (_) {
                    try { window.speechSynthesis.cancel(); } catch (_) {}
                }
                state.ttsPaused = true;
                setAvatarState('idle', 'Paused');
            }
        } else {
            return;
        }

        if (avatarPauseBtn) {
            const paused = state.ttsPaused;
            avatarPauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
            avatarPauseBtn.classList.toggle('is-active', paused);
            avatarPauseBtn.title = paused ? 'Resume advisor speech' : 'Pause advisor speech';
            avatarPauseBtn.innerHTML = paused
                ? '<i class="fa-solid fa-play"></i>'
                : '<i class="fa-solid fa-pause"></i>';
        }
    }

    /** Pick a browser SpeechSynthesis voice that matches the user's
     *  chosen advisor gender. We can't fully trust the .gender field
     *  (it's missing on most platforms) so we score by voice name first
     *  and fall back to language-only matching.
     *
     *  Returns null when no acceptable voice is loaded yet — caller
     *  should let the engine pick its default.
     */
    function pickBrowserVoice(gender) {
        if (!window.speechSynthesis) return null;
        const voices = speechSynthesis.getVoices() || [];
        if (!voices.length) return null;

        const wantMale = gender === 'male';

        // Names that strongly suggest a given gender across Windows /
        // macOS / iOS / Android / Chrome remote voices. The lists are
        // generous — anything that matches gets a strong bias so we
        // don't accidentally pick a female voice for the male advisor.
        const FEMALE_HINTS = /\b(samantha|karen|moira|tessa|fiona|vicki|allison|ava|susan|zira|hazel|catherine|libby|aria|jenny|sonia|natasha|joanna|salli|kendra|kimberly|amy|emma|nicole|raveena|ezinne|female)\b/i;
        const MALE_HINTS   = /\b(daniel|alex|fred|tom|david|mark|ryan|james|guy|matthew|brian|joey|justin|aaron|abeo|onyema|oliver|arthur|george|liam|noah|ethan|connor|albert|male)\b/i;

        const enVoices = voices.filter(v => /^en[-_]/i.test(v.lang) || v.lang === 'en');

        const score = (v) => {
            let s = 0;
            const name = (v.name || '').toLowerCase();
            const lang = (v.lang || '').toLowerCase();
            const g    = (v.gender || '').toLowerCase();

            // Strong, decisive bias from the name.
            if ( wantMale && MALE_HINTS.test(name))   s += 200;
            if ( wantMale && FEMALE_HINTS.test(name)) s -= 200;
            if (!wantMale && FEMALE_HINTS.test(name)) s += 200;
            if (!wantMale && MALE_HINTS.test(name))   s -= 200;

            // Honour the explicit .gender field when the platform reports it.
            if ( wantMale && g === 'male')   s += 60;
            if (!wantMale && g === 'female') s += 60;
            if ( wantMale && g === 'female') s -= 60;
            if (!wantMale && g === 'male')   s -= 60;

            // Locale preference: en-NG > en-GB > en-US > anything en
            if (lang.startsWith('en-ng')) s += 8;
            else if (lang.startsWith('en-gb')) s += 6;
            else if (lang.startsWith('en-us')) s += 4;
            else if (lang.startsWith('en'))    s += 2;

            // Local voices tend to be lower-latency.
            if (v.localService) s += 1;
            return s;
        };

        const ranked = enVoices.slice().sort((a, b) => score(b) - score(a));
        const top    = ranked[0] || null;
        // If the top score is negative for a wanted gender, that means no
        // voice of that gender exists on this device. Return null so the
        // caller falls back to the engine default rather than picking a
        // wrong-gender voice.
        if (top && score(top) <= 0) return null;
        return top;
    }

    /** Fallback TTS using the browser's SpeechSynthesis API. Returns duration estimate.
     *
     *  As of 2026 this is also the PRIMARY path on production (TTSMaker
     *  is opt-in via TTS_PROVIDER=ttsmaker). Browser TTS is free, runs
     *  on-device, and ships with clearly-gendered voices on all major
     *  platforms — solving both the cost concern at student scale and
     *  the wrong-gender voice problem from the previous TTSMaker setup.
     */
    function speakWithBrowser(text, bubbleEl = null) {
        return new Promise(resolve => {
            if (!window.speechSynthesis) return resolve(0);
            try {
                if (bubbleEl) setActiveResponseBubble(bubbleEl);
                // Cancel any in-flight speech first so we don't end up with
                // two utterances overlapping (which is also why the mouth
                // appeared to keep moving — the previous utterance's pulse
                // loop kept firing while a new utterance started).
                try { window.speechSynthesis.cancel(); } catch (_) {}

                const cleaned = humanizeForSpeech(text);
                const u = new SpeechSynthesisUtterance(cleaned);
                const gender = (typeof getAdvisorGender === 'function') ? getAdvisorGender() : 'female';
                const v = pickBrowserVoice(gender);
                if (v) u.voice = v;
                u.lang = (v && v.lang) || 'en-NG';
                u.rate = 1.02;
                u.pitch = gender === 'male' ? 0.85 : 1.10;
                u.volume = state.ttsMuted ? 0 : 1;
                console.info('[advisor] browser TTS voice:', v ? `${v.name} (${v.lang})` : 'default', '| gender wanted:', gender);

                // Drive lip-sync during browser TTS. Since we cannot read
                // browser TTS audio samples directly, combine a text-timed
                // viseme timeline with boundary pulses from the engine.
                let pulseRaf = null;
                let pulseTimer = null;
                let stopped = false;
                let lastOpen = 0;
                let boundaryBoost = 0;       // bumped on every onboundary
                const startedAt = performance.now();
                const estDurationSec = Math.max(1.4, (cleaned.length * 0.065) / Math.max(0.6, u.rate || 1));
                const visemeAtTime = createVisemeTimeline(cleaned, estDurationSec);

                const animate = () => {
                    if (stopped) return;
                    const t = (performance.now() - startedAt) / 1000;
                    const viseme = visemeAtTime(t);
                    const syllWave = 0.18 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 4.7));
                    // boundaryBoost decays back to 0 over ~250 ms.
                    boundaryBoost = Math.max(0, boundaryBoost - 0.065);
                    const target = Math.min(1, Math.max(0, viseme * 0.82 + syllWave + boundaryBoost));
                    lastOpen = lastOpen + (target - lastOpen) * 0.38;
                    setMouthOpenness(lastOpen);
                    pulseRaf = requestAnimationFrame(animate);
                };

                const stopPulse = () => {
                    stopped = true;
                    if (pulseRaf) cancelAnimationFrame(pulseRaf);
                    if (pulseTimer) clearTimeout(pulseTimer);
                    pulseRaf = pulseTimer = null;
                    lastOpen = 0;
                    setMouthOpenness(0);
                };

                u.onstart = () => {
                    setAvatarState('speaking', 'Speaking');
                    animate();
                };
                // Each word boundary briefly opens the mouth wider so the
                // motion correlates with actual speech rather than just
                // running on a metronome.
                u.onboundary = (ev) => {
                    if (stopped) return;
                    const ch = cleaned[(ev && Number.isFinite(ev.charIndex)) ? ev.charIndex : 0] || '';
                    boundaryBoost = Math.max(boundaryBoost, 0.22 + visemeFromChar(ch) * 0.58);
                };
                u.onend = () => {
                    stopPulse();
                    state.ttsPaused = false;
                    setAvatarState('idle', 'Ready');
                    resolve(Math.max(1500, cleaned.length * 70));
                };
                u.onerror = () => {
                    stopPulse();
                    state.ttsPaused = false;
                    setAvatarState('idle', 'Ready');
                    resolve(0);
                };

                // Track this utterance so an external stop (mic re-arm,
                // page navigation, etc) can also halt the pulse.
                state.activeUtterance = { stopPulse, utter: u };
                window.speechSynthesis.speak(u);
            } catch (_) { resolve(0); }
        });
    }

    // Preload voices: most browsers populate getVoices() asynchronously.
    if (window.speechSynthesis) {
        try { speechSynthesis.getVoices(); } catch (_) { /* ignore */ }
        speechSynthesis.addEventListener?.('voiceschanged', () => {
            try { speechSynthesis.getVoices(); } catch (_) {}
        });
    }

    // ---------- Ask flow (streaming) ----------
    async function askNow() {
        const q = questionInput.value.trim();
        if (!q) return;
        questionInput.value = '';
        sendBtn.disabled = true;
        followups.innerHTML = '';
        addStudentBubble(q);
        setAvatarState('thinking', 'Thinking');
        setExpression('thinking');

        const bubble = addAdvisorBubble();
        setActiveResponseBubble(bubble.el);
        let speechText = '';
        let audioUrl = null;
        let audioStarted = false;
        let final = null;

        try {
            const res = await fetch('/api/advisor/ask/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    question: q,
                    sessionToken: state.sessionToken,
                    voiceEnabled: true,
                    inputMode: 'text',
                    advisorGender: getAdvisorGender()
                })
            });
            if (!res.ok || !res.body) {
                // Surface friendly 429 quota errors instead of a generic
                // "HTTP 429" toast, since these are expected end-user states.
                if (res.status === 429) {
                    let msg = 'You have reached your usage limit. Please try again later.';
                    let code = '';
                    let limit = null;
                    let used = null;
                    try {
                        const j = await res.json();
                        if (j?.error) msg = j.error;
                        code = String(j?.code || '');
                        limit = Number.isFinite(Number(j?.limit)) ? Number(j.limit) : null;
                        used = Number.isFinite(Number(j?.used)) ? Number(j.used) : null;
                    } catch (_) { /* ignore */ }
                    bubble.body.textContent = msg;
                    if (bubble.caret) bubble.caret.remove();
                    setAvatarState('idle', 'Limit reached');
                    showUsageOverlay({
                        title: code === 'MONTHLY_LIMIT_REACHED' ? 'Monthly Limit Reached' : 'Daily Limit Reached',
                        body: msg,
                        hints: [
                            (limit !== null && used !== null) ? `Used: ${used} of ${limit}` : 'Your quota has been exhausted for this window.',
                            code === 'MONTHLY_LIMIT_REACHED'
                                ? 'Your monthly prompt quota resets on the 1st day of next month.'
                                : 'Your daily prompt quota resets after midnight.',
                            'You can still browse conversation history while waiting for reset.'
                        ]
                    });
                    return;
                }
                throw new Error(`HTTP ${res.status}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                // Parse SSE events separated by blank lines.
                let blockEnd;
                while ((blockEnd = buffer.indexOf('\n\n')) >= 0) {
                    const block = buffer.slice(0, blockEnd);
                    buffer = buffer.slice(blockEnd + 2);
                    if (!block.trim() || block.startsWith(':')) continue; // heartbeat / comment

                    let event = 'message';
                    let dataStr = '';
                    for (const line of block.split('\n')) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
                    }
                    let data;
                    try { data = JSON.parse(dataStr); } catch (_) { continue; }

                    if (event === 'session') {
                        if (data.sessionToken && data.sessionToken !== state.sessionToken) {
                            state.sessionToken = data.sessionToken;
                            localStorage.setItem('bmu_advisor_session', data.sessionToken);
                        }
                        if (data.sessionToken) rememberSessionToken(data.sessionToken);
                    } else if (event === 'speech_ready') {
                        speechText = data.speech_text || '';
                        // Avatar status hint: voice is being prepared.
                        setAvatarState('thinking', 'Generating voice');
                    } else if (event === 'token') {
                        bubble.body.textContent += (data.text || '');
                        scrollToBottom();
                    } else if (event === 'audio') {
                        if (data.audio_url) {
                            audioUrl = data.audio_url;
                            // Start playback immediately — runs in parallel with continued typing.
                            if (!audioStarted) {
                                audioStarted = true;
                                playWithLipSync(audioUrl, speechText || '', bubble.el);
                            }
                        } else if (data.use_browser_fallback && speechText && !audioStarted) {
                            audioStarted = true;
                            speakWithBrowser(speechText, bubble.el);
                        }
                    } else if (event === 'done') {
                        final = data;
                    } else if (event === 'error') {
                        throw new Error(data.error || 'stream error');
                    }
                }
            }

            bubble.caret.remove();

            if (final) {
                // Replace the streamed-in raw text with the server-cleaned
                // display_markdown — that version has had vocatives and
                // residual markdown symbols (** ## etc.) stripped, so the
                // user sees a tidy final answer even when intermediate
                // tokens contained formatting characters.
                if (final.reply?.display_markdown) {
                    bubble.body.textContent = final.reply.display_markdown;
                }
                fillBubbleMeta(bubble, {
                    citations:         final.reply?.citations || [],
                    suggested_actions: final.reply?.suggested_actions || [],
                    speech_text:       final.reply?.speech_text || speechText,
                    audio_url:         final.audio?.audio_url || audioUrl,
                    message_id:        final.messageId || final.message_id || null
                });
                renderFollowups(final.reply?.follow_up_questions);
                if (final.reply?.needs_escalation) addEscalationHint();

                // Pick a mood for the avatar based on the reply content.
                // Heuristic-only (no extra tokens needed): escalation =>
                // concerned; otherwise look at the speech text for cues.
                const mood = pickMood({
                    needsEscalation: !!final.reply?.needs_escalation,
                    speech: final.reply?.speech_text || ''
                });
                setExpression(mood);
                // Drop back to neutral after a few seconds so the avatar
                // doesn't keep grinning forever.
                clearTimeout(window._avMoodTimer);
                window._avMoodTimer = setTimeout(() => setExpression('neutral'), 6000);
            }
        } catch (err) {
            console.error('[advisor] stream error:', err);
            bubble.caret.remove();
            if (!bubble.body.textContent) {
                bubble.body.textContent = "I couldn't reach the advisor service. Please try again in a moment.";
            }
            toast(err.message || 'Could not reach the advisor.', 'error');
            setAvatarState('idle', 'Ready');
        } finally {
            sendBtn.disabled = false;
            if (!audioStarted) setAvatarState('idle', 'Ready');
            if (state.token && state.historyLoaded) {
                loadHistoryList(true).catch(() => {});
            }
            // Refresh the quota badge — usage went up by one (or stayed
            // the same if the call failed before recordUsage ran).
            if (typeof window.refreshAdvisorQuota === 'function') {
                window.refreshAdvisorQuota();
            }
        }
    }

    function addEscalationHint() {
        const el = document.createElement('article');
        el.className = 'bubble bubble--advisor';
        el.innerHTML = `
            <header><i class="fa-solid fa-headset"></i> Escalation</header>
            <div class="bubble-body">If this needs a human, I can pass your question to the Academic Advisor desk.</div>
            <div class="action-buttons"><button type="button">Talk to a human advisor</button></div>`;
        el.querySelector('button').addEventListener('click', openEscalation);
        transcript.appendChild(el);
        scrollToBottom();
    }

    // ---------- Voice input ----------
    function hasWebSpeech() {
        return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    // Server-side STT capability is only known after /api/advisor/health
    // resolves at boot. Until we know, assume it's available (avoids
    // hiding the mic on the very first frame for the common case).
    let serverSttAvailable = true;

    /** Update the mic button to reflect what speech-to-text actually works
     *  in this browser. If neither browser Web Speech API nor server
     *  Whisper is reachable, the button is disabled with a tooltip that
     *  tells the user to type or switch browsers — far friendlier than the
     *  "Server-side STT not configured" raw error students were getting on
     *  Firefox today. */
    function updateMicAvailability() {
        if (!micBtn) return;
        const browserOk = hasWebSpeech();
        const canVoice  = browserOk || serverSttAvailable;
        if (canVoice) {
            micBtn.disabled = false;
            micBtn.classList.remove('mic-btn--disabled');
            micBtn.title = browserOk
                ? 'Speak your question'
                : 'Speak your question (server transcription)';
        } else {
            micBtn.disabled = true;
            micBtn.classList.add('mic-btn--disabled');
            micBtn.title = 'Voice input is not supported in this browser. Please type your question, or switch to Chrome / Edge.';
            micBtn.setAttribute('aria-label', micBtn.title);
        }
    }

    let recognition = null;
    function startListening() {
        if (state.recording) return;
        // Hard-stop the early misleading error: if neither path can work,
        // bail out with a friendly toast rather than starting a recording
        // we know will fail at upload time.
        if (!hasWebSpeech() && !serverSttAvailable) {
            toast('Voice input is not supported in this browser. Please type your question, or use Chrome / Edge.', 'error');
            return;
        }
        setAvatarState('listening', 'Listening');
        if (hasWebSpeech()) {
            const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
            recognition = new Rec();
            recognition.lang = 'en-NG';
            recognition.interimResults = true;
            recognition.continuous = false;
            let buffer = '';
            recognition.onresult = (ev) => {
                let interim = '';
                for (let i = ev.resultIndex; i < ev.results.length; i++) {
                    const t = ev.results[i][0].transcript;
                    if (ev.results[i].isFinal) buffer += t; else interim += t;
                }
                questionInput.value = (buffer + ' ' + interim).trim();
            };
            recognition.onerror = (e) => {
                console.warn('[advisor] speech error:', e.error);
                toast('Mic error — using server transcription.', 'error');
                stopListening();
                startServerRecording();
            };
            recognition.onend = () => { state.recording = false; micBtn.setAttribute('aria-pressed', 'false'); setAvatarState('idle', 'Ready'); if (questionInput.value.trim()) askNow(); };
            try { recognition.start(); state.recording = true; micBtn.setAttribute('aria-pressed', 'true'); }
            catch (err) { console.warn(err); }
        } else {
            startServerRecording();
        }
    }

    async function startServerRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            const chunks = [];
            recorder.ondataavailable = (e) => e.data && chunks.push(e.data);
            recorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                state.recording = false; micBtn.setAttribute('aria-pressed', 'false');
                setAvatarState('thinking', 'Transcribing');
                const blob = new Blob(chunks, { type: 'audio/webm' });
                const form = new FormData();
                form.append('audio', blob, 'voice.webm');
                form.append('language', 'en');
                try {
                    const res = await fetch('/api/advisor/stt', { method: 'POST', headers: authHeaders(), body: form });
                    const data = await res.json();
                    if (data?.success && data.text) {
                        questionInput.value = data.text;
                        askNow();
                    } else if (res.status === 503 || /not configured/i.test(data?.error || '')) {
                        // The server told us its Whisper credential is
                        // missing. Translate into a human message and
                        // disable the mic so we don't loop the user.
                        serverSttAvailable = false;
                        updateMicAvailability();
                        toast('Voice input is not supported in this browser. Please type your question, or use Chrome / Edge.', 'error');
                        setAvatarState('idle', 'Ready');
                    } else {
                        toast(data?.error || 'Could not transcribe audio.', 'error');
                        setAvatarState('idle', 'Ready');
                    }
                } catch (err) {
                    toast('Transcription failed.', 'error');
                    setAvatarState('idle', 'Ready');
                }
            };
            recorder.start();
            state.mediaRecorder = recorder;
            state.recording = true;
            micBtn.setAttribute('aria-pressed', 'true');
        } catch (err) {
            console.warn('[advisor] getUserMedia failed:', err.message);
            toast('Microphone access denied.', 'error');
            setAvatarState('idle', 'Ready');
        }
    }

    function stopListening() {
        if (recognition) { try { recognition.stop(); } catch (_) {} }
        if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
            try { state.mediaRecorder.stop(); } catch (_) {}
        }
        state.recording = false;
        micBtn.setAttribute('aria-pressed', 'false');
    }

    micBtn.addEventListener('click', () => {
        if (state.recording) stopListening(); else startListening();
    });

    if (avatarMuteBtn) {
        avatarMuteBtn.addEventListener('click', () => {
            state.ttsMuted = !state.ttsMuted;
            localStorage.setItem('bmu_tts_muted', state.ttsMuted ? '1' : '0');
            applyMuteState();
            toast(state.ttsMuted ? 'Advisor speech muted' : 'Advisor speech unmuted');
        });
        applyMuteState();
    }

    if (avatarPauseBtn) {
        avatarPauseBtn.addEventListener('click', () => {
            togglePauseSpeech();
        });
    }

    // ---------- Avatar quick-toggle ----------
    if (avatarToggleBtn) {
        avatarToggleBtn.addEventListener('click', async () => {
            const next = getAdvisorGender() === 'male' ? 'female' : 'male';
            await saveAdvisorGender(next);
            toast(`Switched to ${next === 'male' ? 'male' : 'female'} advisor`);
        });
    }

    // ---------- Escalation ----------
    function openEscalation() {
        if (typeof escalateDlg.showModal === 'function') {
            escalateDlg.showModal();
        } else {
            escalateDlg.setAttribute('open', '');
        }
    }
    document.getElementById('escalateForm').addEventListener('submit', async (ev) => {
        if (ev.submitter && ev.submitter.value === 'cancel') return;
        ev.preventDefault();
        const form = ev.currentTarget;
        const fd = new FormData(form);
        const payload = {
            subject:      fd.get('subject'),
            message:      fd.get('message'),
            contactEmail: fd.get('contactEmail') || null,
            contactPhone: fd.get('contactPhone') || null,
            sessionToken: state.sessionToken
        };
        try {
            const data = await api('/api/advisor/escalate', { method: 'POST', body: payload });
            toast(`Sent to ${data.assignedTo}. Reference: #${data.escalationId}`);
            escalateDlg.close();
            form.reset();
        } catch (err) {
            toast(err.message || 'Could not send your message.', 'error');
        }
    });

    // ---------- History sidebar ----------
    historyToggle?.addEventListener('click', async () => {
        historyPane.classList.toggle('hidden');
        if (!historyPane.classList.contains('hidden')) await loadHistoryList();
    });
    historyClose?.addEventListener('click', () => historyPane.classList.add('hidden'));
    if (state.token) {
        historyToggle?.classList.remove('hidden');
        historyPane.classList.remove('hidden');
        loadHistoryList().catch(() => {});
    }

    // ---------- Form ----------
    composer.addEventListener('submit', (ev) => { ev.preventDefault(); askNow(); });

    // ---------- Handbook (FAQ) browser ----------
    // State for the open dialog: which category filter is active and the
    // last search term (so refreshing one doesn't clobber the other).
    const handbook = { categories: [], activeCategoryId: null, lastQuery: '', searchTimer: null };

    function openHandbook() {
        if (typeof handbookDlg.showModal === 'function') handbookDlg.showModal();
        else handbookDlg.setAttribute('open', '');
        if (!handbook.categories.length) loadHandbookCategories();
        else if (!handbookResults.dataset.touched) showHandbookPopular();
    }
    function closeHandbook() {
        if (typeof handbookDlg.close === 'function') handbookDlg.close();
        else handbookDlg.removeAttribute('open');
    }
    handbookBtn?.addEventListener('click', openHandbook);
    handbookClose?.addEventListener('click', closeHandbook);
    handbookDlg?.addEventListener('cancel', closeHandbook); // Esc key

    async function loadHandbookCategories() {
        try {
            const data = await api('/api/faq/categories');
            handbook.categories = data.categories || [];
            renderHandbookCategories();
            showHandbookPopular();
        } catch (err) {
            // FAQ tables may not be migrated yet, or no admin has generated any
            // Q&A. Show a friendly hint instead of an error toast.
            handbookCategories.innerHTML = '';
            handbookResults.innerHTML = `<p class="empty">The handbook FAQ index isn't ready yet. An admin can generate it from the Admin portal.</p>`;
            console.warn('[advisor] FAQ categories failed:', err.message);
        }
    }

    function renderHandbookCategories() {
        handbookCategories.innerHTML = '';
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'cat-chip' + (handbook.activeCategoryId === null ? ' active' : '');
        all.innerHTML = `<i class="fa-solid fa-fire"></i> Popular`;
        all.addEventListener('click', () => { handbook.activeCategoryId = null; renderHandbookCategories(); showHandbookPopular(); });
        handbookCategories.appendChild(all);

        for (const c of handbook.categories) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'cat-chip' + (handbook.activeCategoryId === c.id ? ' active' : '');
            const count = (c.qa_count ?? c.qaCount ?? 0);
            chip.innerHTML = `<i class="${escapeHtml(c.icon || 'fa-solid fa-folder')}"></i> ${escapeHtml(c.name)}<span class="count">${count}</span>`;
            chip.addEventListener('click', () => {
                handbook.activeCategoryId = c.id;
                renderHandbookCategories();
                showHandbookCategory(c.id);
            });
            handbookCategories.appendChild(chip);
        }
    }

    function setHandbookLoading() {
        handbookResults.dataset.touched = '1';
        handbookResults.innerHTML = `<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
    }

    async function showHandbookPopular() {
        setHandbookLoading();
        try {
            const data = await api('/api/faq/popular?limit=15');
            renderHandbookList(data.faqs || []);
        } catch (err) {
            handbookResults.innerHTML = `<p class="empty">No popular questions yet.</p>`;
        }
    }
    async function showHandbookCategory(categoryId) {
        setHandbookLoading();
        try {
            const data = await api(`/api/faq/category/${categoryId}?limit=50`);
            renderHandbookList(data.faqs || []);
        } catch (err) {
            handbookResults.innerHTML = `<p class="empty">No questions in this topic yet.</p>`;
        }
    }
    async function runHandbookSearch(q) {
        setHandbookLoading();
        try {
            const data = await api(`/api/faq/search?q=${encodeURIComponent(q)}&limit=20`);
            renderHandbookList(data.results || [], { query: q });
        } catch (err) {
            handbookResults.innerHTML = `<p class="empty">No matches for "${escapeHtml(q)}".</p>`;
        }
    }

    handbookSearch?.addEventListener('input', (ev) => {
        const q = ev.target.value.trim();
        clearTimeout(handbook.searchTimer);
        if (!q) {
            handbook.searchTimer = setTimeout(() => {
                if (handbook.activeCategoryId === null) showHandbookPopular();
                else showHandbookCategory(handbook.activeCategoryId);
            }, 250);
            return;
        }
        if (q.length < 2) return;
        handbook.searchTimer = setTimeout(() => runHandbookSearch(q), 300);
    });

    function renderHandbookList(faqs, { query: q } = {}) {
        if (!faqs.length) {
            handbookResults.innerHTML = q
                ? `<p class="empty">No handbook questions match "${escapeHtml(q)}". Try asking the advisor directly.</p>`
                : `<p class="empty">No questions in this topic yet.</p>`;
            return;
        }
        handbookResults.innerHTML = '';
        for (const faq of faqs) {
            const det = document.createElement('details');
            det.className = 'faq';
            const sources = parseSources(faq.answer_sources);
            det.innerHTML = `
                <summary>${escapeHtml(faq.question || '')}</summary>
                <div class="answer">${escapeHtml(faq.answer || '')}</div>
                ${sources.length ? `<div class="sources"><strong>Source:</strong> ${sources.map(s => escapeHtml(s.title || s.document_title || s)).join(' • ')}</div>` : ''}
                <div class="actions">
                    <button type="button" data-action="ask">Ask the advisor about this</button>
                    <button type="button" data-action="helpful" title="Mark as helpful"><i class="fa-regular fa-thumbs-up"></i></button>
                    <button type="button" data-action="not-helpful" title="Mark as unhelpful"><i class="fa-regular fa-thumbs-down"></i></button>
                </div>`;
            det.querySelector('[data-action="ask"]').addEventListener('click', () => {
                closeHandbook();
                questionInput.value = faq.question;
                askNow();
            });
            det.querySelector('[data-action="helpful"]').addEventListener('click', () => sendFaqFeedback(faq.id, true));
            det.querySelector('[data-action="not-helpful"]').addEventListener('click', () => sendFaqFeedback(faq.id, false));
            handbookResults.appendChild(det);
        }
    }
    function parseSources(raw) {
        if (!raw) return [];
        if (Array.isArray(raw)) return raw;
        try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; }
    }
    async function sendFaqFeedback(id, helpful) {
        try {
            await api(`/api/faq/item/${id}/feedback`, { method: 'POST', body: { helpful } });
            toast(helpful ? 'Thanks for the feedback!' : 'Noted — we\'ll improve this.');
        } catch (err) { /* silent */ }
    }

    // ---------- Admin link (only shown to admins) ----------
    // We don't have a /api/advisor/me endpoint yet, so probe an admin-only
    // endpoint cheaply and reveal the link only if it returns 200.
    (async () => {
        if (!state.token) return;
        try {
            await api('/api/admin/stats');
            adminLink?.classList.remove('hidden');
        } catch (_) { /* not an admin; leave hidden */ }
    })();

    // ---------- Helpers ----------
    function scrollToBottom() { transcript.scrollTop = transcript.scrollHeight; }
    function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    /** Pick a mood for the avatar from a finished reply. */
    function pickMood({ needsEscalation, speech }) {
        if (needsEscalation) return 'concerned';
        const s = String(speech || '').toLowerCase();
        if (/\b(congratulations|well done|great|excellent|nice|welcome|happy|good (job|news))\b/.test(s)) return 'smile';
        if (/\b(sorry|unfortunately|cannot|can't|trouble|problem|fail(ed)?)\b/.test(s)) return 'concerned';
        if (/\?\s*$/.test(s.trim())) return 'thinking';
        if (/\b(here|sure|certainly|absolutely)\b/.test(s)) return 'smile';
        return 'neutral';
    }

    // -----------------------------------------------------------------
    // Speech-text humaniser.
    //
    // The browser's SpeechSynthesis engine reads tokens literally. So
    // "₦50,000" comes out as "N five comma zero zero zero" and "100 level"
    // becomes "one zero zero level". We rewrite the most common BMU
    // patterns into spoken-form before sending to the engine:
    //   * "₦600,000"  -> "six hundred thousand naira"
    //   * "N1,230,000" -> "one million two hundred and thirty thousand naira"
    //   * "100 level" -> "one hundred level"
    //   * "BMU"       -> "B M U" (still spelt, but with spaces so the
    //                    voice doesn't try to pronounce "bmu")
    // -----------------------------------------------------------------
    const ONES = ['', 'one','two','three','four','five','six','seven','eight','nine','ten',
                  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
    const TENS = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

    function _belowThousand(n) {
        if (n === 0) return '';
        if (n < 20) return ONES[n];
        if (n < 100) {
            const t = Math.floor(n / 10), o = n % 10;
            return TENS[t] + (o ? ' ' + ONES[o] : '');
        }
        const h = Math.floor(n / 100), rest = n % 100;
        return ONES[h] + ' hundred' + (rest ? ' and ' + _belowThousand(rest) : '');
    }
    function numberToWords(num) {
        const n = Math.trunc(num);
        if (n === 0) return 'zero';
        if (n < 0)  return 'minus ' + numberToWords(-n);
        if (n > 999_999_999_999) return String(n);   // too big — let TTS handle it
        const parts = [];
        const billions  = Math.floor(n / 1_000_000_000);
        const millions  = Math.floor((n % 1_000_000_000) / 1_000_000);
        const thousands = Math.floor((n % 1_000_000) / 1_000);
        const hundreds  = n % 1_000;
        if (billions)  parts.push(_belowThousand(billions)  + ' billion');
        if (millions)  parts.push(_belowThousand(millions)  + ' million');
        if (thousands) parts.push(_belowThousand(thousands) + ' thousand');
        if (hundreds)  parts.push(_belowThousand(hundreds));
        return parts.join(' ');
    }

    /** Convert a numeric string with optional commas + decimal into spoken
     *  English. e.g. "1,230,000" -> "one million two hundred and thirty
     *  thousand"; "2.5"  -> "two point five"; "0.85" -> "zero point eight five". */
    function speakNumeric(raw) {
        const s = String(raw).replace(/,/g, '');
        if (!/^\d+(\.\d+)?$/.test(s)) return raw;
        const [intPart, fracPart] = s.split('.');
        let out = numberToWords(parseInt(intPart, 10) || 0);
        if (fracPart) {
            // "0.85" -> "zero point eight five" (digit-by-digit so "2.5m"
            // doesn't become "two point five hundred").
            out += ' point ' + fracPart.split('').map(d => ONES[+d] || 'zero').join(' ');
        }
        return out;
    }

    function humanizeForSpeech(text) {
        if (!text) return '';
        let s = String(text);

        // Currency: ₦, NGN, N (when followed by digits), $, USD
        s = s.replace(/[₦]\s?(\d[\d,]*(?:\.\d+)?)/g, (_, n) => speakNumeric(n) + ' naira');
        s = s.replace(/\bNGN\s?(\d[\d,]*(?:\.\d+)?)/gi, (_, n) => speakNumeric(n) + ' naira');
        // "N50,000" or "N 50,000" — only when the N has no preceding letter
        // (so "BMU N..." still reads N as a letter; here we look for a word
        // boundary AND a digit right after).
        s = s.replace(/(^|[\s(])N\s?(\d[\d,]*(?:\.\d+)?)/g, (_, pre, n) => `${pre}${speakNumeric(n)} naira`);
        s = s.replace(/[$]\s?(\d[\d,]*(?:\.\d+)?)/g, (_, n) => speakNumeric(n) + ' US dollars');

        // Abbreviated millions / thousands: "2.5m", "600k", "1.23m naira"
        s = s.replace(/\b(\d+(?:\.\d+)?)\s?m\b/gi,
            (_, n) => speakNumeric((parseFloat(n) * 1_000_000).toString()));
        s = s.replace(/\b(\d+(?:\.\d+)?)\s?k\b/gi,
            (_, n) => speakNumeric((parseFloat(n) * 1_000).toString()));

        // "100 level", "200 level", etc — make sure the number is read
        // as a word, not "one zero zero".
        s = s.replace(/\b(\d{3})\s?level\b/gi, (_, n) => `${speakNumeric(n)} level`);

        // Standalone numbers with commas — "1,234,567" -> words.
        s = s.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, m => speakNumeric(m));

        // Acronyms: spell them out so the voice doesn't try to pronounce
        // them as words. Restrict to the BMU vocabulary so we don't break
        // ordinary capitalised words.
        // NUC is handled separately as "N.U.C" so it is read continuously
        // as letters without long inter-letter silence.
        s = s.replace(/\bNUC\b/g, 'N.U.C');

        const ACRONYMS = ['BMU', 'MBBS', 'BNSc', 'BMLS', 'CCMAS', 'GPA', 'MDCN', 'CGPA', 'NYSC', 'HOD'];
        for (const a of ACRONYMS) {
            const re = new RegExp('\\b' + a + '\\b', 'g');
            s = s.replace(re, a.split('').join(' '));
        }
        // Hyphenated acronym compounds should be spoken cleanly.
        s = s.replace(/\bN\.U\.C\s*-\s*(?=[A-Za-z])/g, 'N.U.C ');
        s = s.replace(/\b([A-Z](?:\s+[A-Z]){1,7})\s*-\s*(?=[A-Za-z])/g, '$1 ');

        // Collapse whitespace.
        return s.replace(/\s+/g, ' ').trim();
    }

    // Expose for the (rare) caller that wants to reuse it.
    window._humanizeForSpeech = humanizeForSpeech;

    // ---------- Boot ----------
    (async () => {
        // Establish provider availability before wiring the mic, so Firefox
        // users (no Web Speech API) and any deployment without a Whisper
        // key get a disabled mic + a clear tooltip instead of a confusing
        // raw server error after recording.
        try {
            const h = await api('/api/advisor/health');
            console.info('[advisor] providers:', h.providers);
            serverSttAvailable = Boolean(h?.providers?.stt);
        } catch (_) {
            // Health check failed; assume server STT is unavailable so we
            // err on the side of clearly-disabled UI rather than a hopeful
            // mic that returns 503 mid-record.
            serverSttAvailable = false;
        }
        updateMicAvailability();
        loadTopics();

        // Fetch persona name (optional — server doesn't yet expose it; use defaults)
        const personaName = window.ADVISOR_NAME || 'Dr. Tari';
        advisorName.textContent = personaName;
        welcomeName.textContent = personaName;

        // -------------------------------------------------------------------
        // Auth UI: replace the static "Sign in" button with a sign-out
        // control showing the signed-in user's first name. The auth gate at
        // the top of this IIFE has already redirected unauthenticated
        // visitors to /login, so by this point a user must exist.
        // -------------------------------------------------------------------
        let user = null;
        try { user = JSON.parse(localStorage.getItem('bmu_user') || 'null'); } catch (_) {}
        if (!user) {
            // Fall back to /api/users/me if we somehow didn't cache the user.
            try { const me = await api('/api/users/me'); user = me?.user || null; }
            catch (_) { /* leave null */ }
        }
        const authSlot = document.getElementById('authSlot');
        if (authSlot) {
            const name = (user?.firstName || user?.first_name || user?.email || 'You').toString().split(' ')[0];
            // Hide quota for superadmin (they're unlimited and don't need to
            // see "0 / -1"); render a placeholder we'll fill from the API.
            const showQuota = user?.role !== 'superadmin';
            authSlot.innerHTML = `
                ${showQuota ? '<span id="quotaBadge" class="quota-badge" title="Loading usage…"><i class="fa-solid fa-gauge"></i> <span class="q-text">…</span></span>' : ''}
                <span class="link-muted" title="${escapeHtml(user?.email || '')}">
                    <i class="fa-solid fa-user"></i> ${escapeHtml(name)}
                </span>
                <button id="themeToggleBtn" class="icon-btn" title="Toggle light/dark theme" aria-label="Toggle theme">
                    <i class="fa-solid fa-moon"></i>
                </button>
                <button id="logoutBtn" class="btn btn-ghost" title="Sign out">
                    <i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out
                </button>
            `;
            document.getElementById('logoutBtn').addEventListener('click', async () => {
                try { await api('/api/users/logout', { method: 'POST' }); } catch (_) {}
                localStorage.removeItem('bmu_token');
                localStorage.removeItem('bmu_user');
                sessionStorage.removeItem('bmu_token');
                location.replace('/');
            });


        syncMobileLayoutVars();
        setTimeout(syncMobileLayoutVars, 200);
            // Pull live quota and refresh the badge.

    window.addEventListener('resize', syncMobileLayoutVars, { passive: true });
            if (showQuota) {
                await refreshQuotaBadge();
                maybeShowUsageIntro(user);
                // Refresh after each ask completes (askNow updates the cached
                // quota via this same call).
                window.refreshAdvisorQuota = refreshQuotaBadge;
            }
        }

        async function refreshQuotaBadge() {
            const badge = document.getElementById('quotaBadge');
            if (!badge) return;
            try {
                const u = await api('/api/advisor/usage');
                state.usage = u;
                if (u?.anonymous) { badge.remove(); return; }
                const day = u.day || {};
                const month = u.month || {};
                const fmt = (used, limit) => Number(limit) === -1 ? '∞' : `${used}/${limit}`;
                badge.innerHTML = `<i class="fa-solid fa-gauge"></i> Today ${fmt(day.used, day.limit)} · Month ${fmt(month.used, month.limit)}`;
                // Visually warn when within 1 of either limit.
                const nearDay = Number(day.limit) !== -1 && day.used >= day.limit - 1;
                const nearMonth = Number(month.limit) !== -1 && month.used >= month.limit - 1;
                badge.classList.toggle('quota-warn', nearDay || nearMonth);
            } catch (_) { /* leave placeholder */ }
        }

        // If the user came here from a topic tile (?q=…), pre-fill and ask.
        const presetQ = new URLSearchParams(location.search).get('q');
        if (presetQ) {
            try {
                history.replaceState(null, '', '/advisor');  // clean the URL
                questionInput.value = presetQ;
                setTimeout(askNow, 400);
            } catch (_) { /* non-fatal */ }
        }
    })();
})();
