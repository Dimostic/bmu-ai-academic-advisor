/**
 * Speech-to-text fallback for the academic advisor.
 *
 * The primary STT path is the browser's Web Speech API (free, on-device).
 * This server-side service is only invoked when the client uploads an audio
 * blob (e.g. Firefox / Safari iOS / file upload). It calls Groq's hosted
 * Whisper, which has a generous free tier (~14,400 requests/day).
 */
const axios = require('axios');
const FormData = require('form-data');

const GROQ_BASE  = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const SILENCE_ARTEFACT_RE = /^(?:do\s+you\s+translate|do\s+not\s+translate|please\s+translate|translate(?:\s+this)?|thank\s+you\s+for\s+watching|thanks\s+for\s+watching|subscribe(?:\s+to\s+my\s+channel)?|you\s+you|hello\s+hello|uh\s+huh|mm\s+hmm|hmm)\s*[\.\?!]*$/i;
const ADVISOR_INTENT_RE = /\b(?:bmu|bayelsa|medical|university|course|courses|programme|program|fees?|admission|student|handbook|ccmas|aspire|vc|vice\s+chancellor|chancellor|bursar|registrar|officer|calendar|hostel|graduation|credit|level|semester|department|faculty|law|who|what|when|where|why|how|tell|show|list|name|explain|give|check|can|could|should|does|do|is|are)\b/i;

function isConfigured() {
    return Boolean(process.env.GROQ_API_KEY);
}

function assessTranscriptQuality(text) {
    const value = String(text || '').trim();
    if (!value) {
        return { ok: false, reason: 'empty' };
    }
    if (SILENCE_ARTEFACT_RE.test(value)) {
        return { ok: false, reason: 'silence_artefact' };
    }
    const letters = value.match(/\p{L}/gu) || [];
    if (!letters.length) {
        return { ok: false, reason: 'no_letters' };
    }
    const latinLetters = value.match(/\p{Script=Latin}/gu) || [];
    const combiningMarks = value.match(/\p{M}/gu) || [];
    const asciiLetters = value.match(/[A-Za-z]/g) || [];
    const latinRatio = latinLetters.length / Math.max(1, letters.length);
    const asciiRatio = asciiLetters.length / Math.max(1, letters.length);
    const markRatio = combiningMarks.length / Math.max(1, letters.length);

    if (latinRatio < 0.92) return { ok: false, reason: 'non_latin_script', latinRatio, asciiRatio, markRatio };
    if (markRatio > 0.02) return { ok: false, reason: 'too_many_tone_marks', latinRatio, asciiRatio, markRatio };
    if (asciiRatio < 0.82) return { ok: false, reason: 'low_ascii_ratio', latinRatio, asciiRatio, markRatio };
    if (value.length > 24 && !ADVISOR_INTENT_RE.test(value)) {
        return { ok: false, reason: 'no_advisor_intent', latinRatio, asciiRatio, markRatio };
    }
    return { ok: true, reason: null, latinRatio, asciiRatio, markRatio };
}

/**
 * Transcribe an audio buffer with Groq Whisper.
 * @param {Buffer} audioBuffer
 * @param {object} [opts]
 * @param {string} [opts.filename='audio.webm']
 * @param {string} [opts.mimetype='audio/webm']
 * @param {string} [opts.language='en']
 * @returns {Promise<{provider:string, text:string, durationSeconds?:number}>}
 */
async function transcribe(audioBuffer, opts = {}) {
    if (!isConfigured()) {
        throw new Error('GROQ_API_KEY is not configured');
    }
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        throw new Error('Empty or invalid audio buffer');
    }

    const {
        filename = 'audio.webm',
        mimetype = 'audio/webm',
        language = 'en'
    } = opts;

    const form = new FormData();
    form.append('file', audioBuffer, { filename, contentType: mimetype });
    form.append('model', GROQ_MODEL);
    form.append('language', language);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('prompt', 'Transcribe the user as English or Nigerian English only. Do not translate. Expected BMU academic advisor questions may mention BMU, Bayelsa Medical University, courses, fees, admission, VC, vice chancellor, Prof. Dimie Ogoina, bursar, Dr Ebipuado Ombu, registrar, or student handbook.');

    const { data } = await axios.post(
        `${GROQ_BASE}/audio/transcriptions`,
        form,
        {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`
            },
            maxBodyLength: 25 * 1024 * 1024,
            timeout: 60_000
        }
    );

    const text = (data?.text || '').trim();
    const quality = assessTranscriptQuality(text);
    return {
        provider: 'groq',
        text,
        durationSeconds: data?.duration || null,
        transcriptOk: quality.ok,
        transcriptQuality: quality
    };
}

module.exports = { transcribe, isConfigured, assessTranscriptQuality };
