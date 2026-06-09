/**
 * Text-to-speech service for the academic advisor.
 *
 * Free-first strategy:
 *   1. TTSMaker (configured via TTSMAKER_TTS_API_KEY) — primary.
 *   2. Browser `speechSynthesis` — final fallback. The server cannot synthesise
 *      this; we simply tell the client to do it locally.
 *
 * Lip-sync is computed client-side from the audio waveform using the Web Audio
 * API, so no provider-specific viseme metadata is required.
 */
const axios = require('axios');

const TTSMAKER_BASE = 'https://api.ttsmaker.com/v1';
const PROVIDER      = (process.env.TTS_PROVIDER || 'ttsmaker').toLowerCase();
const ENABLED       = process.env.ENABLE_VOICE_RESPONSES !== 'false';

function isTtsmakerConfigured() {
    return Boolean(process.env.TTSMAKER_TTS_API_KEY) &&
           process.env.TTSMAKER_TTS_ENABLED !== '0';
}

/**
 * Synthesise speech for `text`.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @returns {Promise<{provider:string, audioUrl?:string, useBrowserFallback?:boolean, error?:string}>}
 */
async function synthesise(text, opts = {}) {
    if (!ENABLED || !text || !text.trim()) {
        return { provider: 'none', useBrowserFallback: true };
    }

    if (PROVIDER === 'browser' || !isTtsmakerConfigured()) {
        return { provider: 'browser', useBrowserFallback: true };
    }

    try {
        const voiceId = parseInt(process.env.TTSMAKER_TTS_VOICE_ID || '2522', 10);
        const body = {
            token: process.env.TTSMAKER_TTS_API_KEY,
            text: text.trim(),
            voice_id: voiceId,
            audio_format: 'mp3',
            audio_speed: 1.0,
            audio_volume: 0,
            text_paragraph_pause_time: 300
        };

        const { data } = await axios.post(
            `${TTSMAKER_BASE}/create-tts-order`,
            body,
            { timeout: 30_000, headers: { 'Content-Type': 'application/json' } }
        );

        if (data?.error_code === 'SUCCESS' && data?.audio_file_url) {
            return {
                provider: 'ttsmaker',
                audioUrl: data.audio_file_url,
                durationSeconds: data.audio_file_duration_seconds || null
            };
        }

        console.warn('[ttsService] TTSMaker non-success:', data?.error_code, data?.error_details);
        return {
            provider: 'browser',
            useBrowserFallback: true,
            error: data?.error_details || data?.error_code || 'TTSMaker failed'
        };
    } catch (err) {
        console.error('[ttsService] TTSMaker request failed:', err.message);
        return {
            provider: 'browser',
            useBrowserFallback: true,
            error: err.message
        };
    }
}

module.exports = {
    synthesise,
    isConfigured: isTtsmakerConfigured
};
