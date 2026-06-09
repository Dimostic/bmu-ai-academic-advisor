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

function isConfigured() {
    return Boolean(process.env.GROQ_API_KEY);
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

    return {
        provider: 'groq',
        text: (data?.text || '').trim(),
        durationSeconds: data?.duration || null
    };
}

module.exports = { transcribe, isConfigured };
