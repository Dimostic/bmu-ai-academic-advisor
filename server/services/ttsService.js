/**
 * Text-to-speech service for the academic advisor.
 *
 * Free-first strategy:
 *   1. TTSMaker API v2 (https://api.ttsmaker.com/v2/create-tts-order) — primary.
 *   2. Browser `speechSynthesis` — final fallback. The server cannot synthesise
 *      this; we simply tell the client to do it locally.
 *
 * Lip-sync is computed client-side from the audio waveform using the Web Audio
 * API, so no provider-specific viseme metadata is required.
 *
 * Note: TTSMaker requires a Pro or Studio subscription on their account; the
 * Lite tier does not expose the API, and the public demo key only accepts a
 * fixed test sentence. If your key is rejected, the service degrades to the
 * browser fallback automatically.
 */
const axios = require('axios');

const TTSMAKER_BASE = 'https://api.ttsmaker.com/v2';
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
 * @returns {Promise<{provider:string, audioUrl?:string, useBrowserFallback?:boolean, error?:string, durationSeconds?:number, quota?:object}>}
 */
async function synthesise(text, opts = {}) {
    void opts; // reserved for future per-call overrides
    if (!ENABLED || !text || !text.trim()) {
        return { provider: 'none', useBrowserFallback: true };
    }

    if (PROVIDER === 'browser' || !isTtsmakerConfigured()) {
        return { provider: 'browser', useBrowserFallback: true };
    }

    try {
        const voiceId = parseInt(process.env.TTSMAKER_TTS_VOICE_ID || '147', 10);
        const body = {
            api_key:                  process.env.TTSMAKER_TTS_API_KEY,
            text:                     text.trim().slice(0, 19_500),
            voice_id:                 voiceId,
            audio_format:             'mp3',
            audio_speed:              1.0,
            audio_volume:             1.0,
            audio_pitch:              1.0,
            audio_high_quality:       0,
            text_paragraph_pause_time: 300,
            emotion_style_key:        '',
            emotion_intensity:        1
        };

        const { data } = await axios.post(
            `${TTSMAKER_BASE}/create-tts-order`,
            body,
            {
                timeout: 30_000,
                headers: { 'Content-Type': 'application/json', accept: 'application/json' }
            }
        );

        // v2 responds with error_code === 0 on success, audio_download_url for the file.
        if (data?.error_code === 0 && data?.audio_download_url) {
            return {
                provider: 'ttsmaker',
                audioUrl: data.audio_download_url,
                audioBackupUrl: data.audio_download_backup_url || null,
                expiresAt: data.audio_file_expiration_timestamp || null,
                quota: data.account_status || null
            };
        }

        const errSummary = data?.error_summary || data?.msg || `error_code=${data?.error_code}`;
        console.warn('[ttsService] TTSMaker non-success:', errSummary);
        return { provider: 'browser', useBrowserFallback: true, error: errSummary };
    } catch (err) {
        const respData = err.response?.data;
        const detail = respData?.error_summary || respData?.msg || err.message;
        console.error('[ttsService] TTSMaker request failed:', detail);
        return { provider: 'browser', useBrowserFallback: true, error: detail };
    }
}

/**
 * Check the current API key + account quota. Useful for /api/advisor/health.
 */
async function checkQuota() {
    if (!isTtsmakerConfigured()) return { ok: false, error: 'not_configured' };
    try {
        const { data } = await axios.get(
            `${TTSMAKER_BASE}/get-token-status`,
            { params: { api_key: process.env.TTSMAKER_TTS_API_KEY }, timeout: 10_000 }
        );
        if (data?.error_code === 0) {
            return { ok: true, isDemoKey: data.is_demo_key, account: data.account_status };
        }
        return { ok: false, error: data?.error_summary || data?.msg };
    } catch (err) {
        return { ok: false, error: err.response?.data?.error_summary || err.message };
    }
}

module.exports = {
    synthesise,
    checkQuota,
    isConfigured: isTtsmakerConfigured
};
