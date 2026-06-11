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
    const advisorSvg    = $('avatarSvg');
    const mouthShape    = $('mouthShape');
    const advisorName   = $('advisorName');
    const welcomeName   = $('welcomeName');
    const toastHost     = $('toastHost');

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
        topics: [],
        token: sessionStorage.getItem('bmu_token') || localStorage.getItem('bmu_token') || null,
        recording: false,
        mediaRecorder: null,
        audioCtx: null,
        currentAudio: null,
        currentLottie: null
    };

    function authHeaders() {
        return state.token ? { Authorization: `Bearer ${state.token}` } : {};
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
    function setAvatarState(stateName, label) {
        advisorStatus.dataset.state = stateName;
        advisorStatus.querySelector('.label').textContent = label || stateName;
        advisorSvg.classList.toggle('listening', stateName === 'listening');
    }
    function blink() {
        advisorSvg.classList.add('blink');
        setTimeout(() => advisorSvg.classList.remove('blink'), 140);
    }
    setInterval(blink, 4200);

    function setMouthOpenness(level) {
        // level: 0..1
        const ry = 2 + Math.max(0, Math.min(1, level)) * 11;
        const rx = 14 - Math.max(0, Math.min(1, level)) * 3;
        mouthShape.setAttribute('ry', ry.toFixed(1));
        mouthShape.setAttribute('rx', rx.toFixed(1));
    }
    setMouthOpenness(0);

    // ---------- Optional Lottie ----------
    window.loadLottieCharacter = function (url, opts = {}) {
        if (typeof lottie === 'undefined') {
            console.warn('[advisor] lottie-web not loaded yet');
            return;
        }
        const host = document.createElement('div');
        host.className = 'lottie-host';
        const stage = document.getElementById('avatarStage');
        advisorSvg.style.display = 'none';
        stage.appendChild(host);
        state.currentLottie = lottie.loadAnimation({
            container: host, renderer: 'svg', loop: true, autoplay: true, path: url, ...opts
        });
        toast('Lottie avatar loaded.');
    };

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

    function fillBubbleMeta(bubble, { citations, suggested_actions, speech_text, audio_url }) {
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
        } else {
            bubble.actions.remove();
        }
        if (Array.isArray(citations) && citations.length) {
            bubble.cite.innerHTML = `<strong>Sources:</strong> ${citations.map(c => escapeHtml(c.title || c.source || '')).join(' • ')}`;
            bubble.footer.classList.remove('hidden');
        }
        if (bubble.playBtn) {
            bubble.playBtn.addEventListener('click', () => {
                if (audio_url) playWithLipSync(audio_url);
                else if (speech_text) speakWithBrowser(speech_text);
            });
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

    // ---------- Typewriter + lip-sync ----------
    /**
     * Play audioUrl while updating mouth from amplitude.
     * Returns the actual duration in ms when finished, or 0 if aborted.
     */
    async function playWithLipSync(audioUrl) {
        return new Promise((resolve) => {
            try {
                stopCurrentAudio();
                const audio = new Audio(audioUrl);
                audio.crossOrigin = 'anonymous';
                state.currentAudio = audio;

                if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const src = state.audioCtx.createMediaElementSource(audio);
                const analyser = state.audioCtx.createAnalyser();
                analyser.fftSize = 256;
                src.connect(analyser); analyser.connect(state.audioCtx.destination);
                const data = new Uint8Array(analyser.frequencyBinCount);

                let raf;
                const tick = () => {
                    analyser.getByteFrequencyData(data);
                    let sum = 0; const len = Math.min(64, data.length);
                    for (let i = 4; i < len; i++) sum += data[i];
                    const level = Math.min(1, sum / (len * 110));
                    setMouthOpenness(level);
                    raf = requestAnimationFrame(tick);
                };

                audio.addEventListener('play', () => { setAvatarState('talking', 'Speaking'); tick(); });
                audio.addEventListener('ended', () => {
                    cancelAnimationFrame(raf); setMouthOpenness(0); setAvatarState('idle', 'Ready');
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
            state.currentAudio = null;
        }
        try { window.speechSynthesis?.cancel(); } catch (_) {}
    }

    /** Fallback TTS using the browser's SpeechSynthesis API. Returns duration estimate. */
    function speakWithBrowser(text) {
        return new Promise(resolve => {
            if (!window.speechSynthesis) return resolve(0);
            try {
                const u = new SpeechSynthesisUtterance(text);
                u.lang = 'en-NG';
                u.rate = 1.02;
                u.pitch = 1.0;
                // Roughly drive the mouth from amplitude proxy (word boundaries)
                let opening = 0;
                let raf;
                u.onstart = () => {
                    setAvatarState('talking', 'Speaking');
                    const pulse = () => {
                        opening = opening > 0.05 ? 0 : 0.7;
                        setMouthOpenness(opening);
                        raf = requestAnimationFrame(() => setTimeout(pulse, 110));
                    };
                    pulse();
                };
                u.onboundary = () => { opening = 0.7; setMouthOpenness(opening); };
                u.onend = () => {
                    cancelAnimationFrame(raf); setMouthOpenness(0); setAvatarState('idle', 'Ready');
                    // Estimate: ~14 chars/sec speaking rate
                    resolve(Math.max(1500, text.length * 70));
                };
                window.speechSynthesis.speak(u);
            } catch (_) { resolve(0); }
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

        const bubble = addAdvisorBubble();
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
                    inputMode: 'text'
                })
            });
            if (!res.ok || !res.body) {
                // Surface friendly 429 quota errors instead of a generic
                // "HTTP 429" toast, since these are expected end-user states.
                if (res.status === 429) {
                    let msg = 'You have reached your usage limit. Please try again later.';
                    try {
                        const j = await res.json();
                        if (j?.error) msg = j.error;
                    } catch (_) { /* ignore */ }
                    bubble.body.textContent = msg;
                    if (bubble.caret) bubble.caret.remove();
                    setAvatarState('idle', 'Limit reached');
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
                                playWithLipSync(audioUrl);
                            }
                        } else if (data.use_browser_fallback && speechText && !audioStarted) {
                            audioStarted = true;
                            speakWithBrowser(speechText);
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
                    audio_url:         final.audio?.audio_url || audioUrl
                });
                renderFollowups(final.reply?.follow_up_questions);
                if (final.reply?.needs_escalation) addEscalationHint();
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

    let recognition = null;
    function startListening() {
        if (state.recording) return;
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
    historyToggle?.addEventListener('click', () => historyPane.classList.toggle('hidden'));
    historyClose?.addEventListener('click', () => historyPane.classList.add('hidden'));
    if (state.token) {
        historyToggle?.classList.remove('hidden');
        historyPane.classList.remove('hidden');
        // (History list endpoint not yet implemented — placeholder.)
        historyList.innerHTML = '<p class="muted">Your recent conversations will appear here in a future update.</p>';
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

    // ---------- Boot ----------
    (async () => {
        // Health check (non-blocking)
        try {
            const h = await api('/api/advisor/health');
            console.info('[advisor] providers:', h.providers);
        } catch (_) {}
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

            // Pull live quota and refresh the badge.
            if (showQuota) {
                refreshQuotaBadge();
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
