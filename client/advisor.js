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
                questionInput.value = `Tell me about: ${t.title}`;
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

    function addAdvisorBubble({ speech_text, display_markdown, citations, suggested_actions }) {
        const el = document.createElement('article');
        el.className = 'bubble bubble--advisor';
        el.innerHTML = `
            <header><i class="fa-solid fa-graduation-cap"></i> Dr. Tari</header>
            <div class="bubble-body"><span class="typewriter"></span><span class="caret"></span></div>
            <div class="action-buttons"></div>
            <div class="bubble-footer hidden">
                <button type="button" class="play-btn"><i class="fa-solid fa-volume-high"></i> Listen again</button>
                <span class="cite"></span>
            </div>`;
        transcript.appendChild(el);
        scrollToBottom();

        const body = el.querySelector('.typewriter');
        const caret = el.querySelector('.caret');
        const actions = el.querySelector('.action-buttons');
        const footer = el.querySelector('.bubble-footer');
        const cite = el.querySelector('.cite');

        // Suggested action buttons
        if (Array.isArray(suggested_actions) && suggested_actions.length) {
            for (const a of suggested_actions) {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = a.label;
                b.addEventListener('click', () => handleAction(a.action));
                actions.appendChild(b);
            }
        } else {
            actions.remove();
        }

        if (Array.isArray(citations) && citations.length) {
            cite.innerHTML = `<strong>Sources:</strong> ${citations.map(c => escapeHtml(c.title || c.source || '')).join(' • ')}`;
            footer.classList.remove('hidden');
        }

        return { el, body, caret, footer };
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
            const slug = action.slice('open_topic:'.length);
            const topic = state.topics.find(t => t.slug === slug);
            if (topic) {
                questionInput.value = `Tell me more about ${topic.title}`;
                askNow();
            }
        } else if (action.startsWith('open_url:')) {
            const url = action.slice('open_url:'.length);
            if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
        }
    }

    // ---------- Typewriter + lip-sync ----------
    function typeWriter(el, text, durationMs) {
        return new Promise(resolve => {
            const chars = [...text];
            const tickMs = Math.max(8, Math.min(40, durationMs / Math.max(1, chars.length)));
            let i = 0;
            const tick = () => {
                if (i >= chars.length) { resolve(); return; }
                el.textContent += chars[i++];
                scrollToBottom();
                setTimeout(tick, tickMs);
            };
            tick();
        });
    }

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
                    // Focus on speech band (low-mid)
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

    // ---------- Ask flow ----------
    async function askNow() {
        const q = questionInput.value.trim();
        if (!q) return;
        questionInput.value = '';
        sendBtn.disabled = true;
        followups.innerHTML = '';
        addStudentBubble(q);
        setAvatarState('thinking', 'Thinking');

        try {
            const data = await api('/api/advisor/ask', {
                method: 'POST',
                body: {
                    question: q,
                    sessionToken: state.sessionToken,
                    voiceEnabled: true,
                    inputMode: 'text'
                }
            });

            if (data.sessionToken && data.sessionToken !== state.sessionToken) {
                state.sessionToken = data.sessionToken;
                localStorage.setItem('bmu_advisor_session', data.sessionToken);
            }

            const { reply, audio } = data;
            const bubble = addAdvisorBubble({
                speech_text:        reply.speech_text,
                display_markdown:   reply.display_markdown,
                citations:          reply.citations,
                suggested_actions:  reply.suggested_actions
            });

            // Speak + type in parallel; typing pace is matched to spoken duration.
            const speak = (audio?.audio_url)
                ? playWithLipSync(audio.audio_url)
                : speakWithBrowser(reply.speech_text);

            // Start with an estimated duration; corrected when audio metadata arrives.
            const typedText = (reply.display_markdown || reply.speech_text || '').toString();
            const estimatedMs = Math.max(2000, typedText.length * 25);
            const typingPromise = typeWriter(bubble.body, typedText, estimatedMs);
            const playedMs = await speak;
            await typingPromise;
            bubble.caret.remove();

            // Wire "Listen again"
            const playBtn = bubble.el.querySelector('.play-btn');
            if (playBtn) {
                playBtn.addEventListener('click', () => {
                    if (audio?.audio_url) playWithLipSync(audio.audio_url);
                    else speakWithBrowser(reply.speech_text);
                });
            }

            renderFollowups(reply.follow_up_questions);

            if (reply.needs_escalation) {
                addEscalationHint();
            }
        } catch (err) {
            console.error('[advisor] ask error:', err);
            toast(err.message || 'Could not reach the advisor.', 'error');
            setAvatarState('idle', 'Ready');
        } finally {
            sendBtn.disabled = false;
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
    })();
})();
