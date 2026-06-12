/**
 * Text-to-speech service for the academic advisor.
 *
 * Free-first strategy:
 *   1. TTSMaker API v2 (https://api.ttsmaker.com/v2/create-tts-order) — primary.
 *   2. Browser `speechSynthesis` — final fallback. The server cannot synthesise
 *      this; we simply tell the client to do it locally.
 *
 * Performance: results are cached in the `tts_audio_cache` table by a
 * (text_hash, voice_id, audio_speed) tuple. TTSMaker's hosted audio URLs are
 * valid for ~24h, so repeat questions reuse the existing URL until it expires.
 *
 * Lip-sync is computed client-side from the audio waveform using the Web Audio
 * API, so no provider-specific viseme metadata is required.
 */
const axios = require('axios');
const crypto = require('crypto');
const { query } = require('../../config/db');

const TTSMAKER_BASE = 'https://api.ttsmaker.com/v2';
const PROVIDER      = (process.env.TTS_PROVIDER || 'ttsmaker').toLowerCase();
const ENABLED       = process.env.ENABLE_VOICE_RESPONSES !== 'false';
const CACHE_SAFETY_MS = 5 * 60 * 1000; // treat URLs that expire in <5 min as miss

function isTtsmakerConfigured() {
    return Boolean(process.env.TTSMAKER_TTS_API_KEY) &&
           process.env.TTSMAKER_TTS_ENABLED !== '0';
}

function getVoiceId(gender) {
    // Per-gender overrides:
    //   TTSMAKER_TTS_VOICE_ID_FEMALE  (defaults to TTSMAKER_TTS_VOICE_ID or 2522)
    //   TTSMAKER_TTS_VOICE_ID_MALE    (defaults to 2528)
    // If only the legacy TTSMAKER_TTS_VOICE_ID is set, female keeps it and
    // male falls back to a different sensible TTSMaker English-male voice.
    const legacy = process.env.TTSMAKER_TTS_VOICE_ID || '2522';
    const female = process.env.TTSMAKER_TTS_VOICE_ID_FEMALE || legacy;
    const male   = process.env.TTSMAKER_TTS_VOICE_ID_MALE   || '2528';
    const id = gender === 'male' ? male : female;
    return parseInt(id, 10);
}

function getSpeed() {
    const v = parseFloat(process.env.TTSMAKER_TTS_AUDIO_SPEED || '1.15');
    if (!Number.isFinite(v)) return 1.0;
    return Math.max(0.5, Math.min(2.0, v));
}

function _hash(text, voiceId, speed) {
    const norm = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
    return crypto
        .createHash('sha256')
        .update(`${norm}|${voiceId}|${speed.toFixed(2)}`)
        .digest('hex');
}

async function _readCache(text, voiceId, speed) {
    try {
        const hash = _hash(text, voiceId, speed);
        const safeNow = new Date(Date.now() + CACHE_SAFETY_MS);
        const rows = await query(
            `SELECT audio_url, backup_url, provider, expires_at
             FROM tts_audio_cache
             WHERE text_hash=? AND voice_id=? AND audio_speed=? AND expires_at > ?
             LIMIT 1`,
            [hash, voiceId, speed, safeNow]
        );
        if (!rows[0]) return null;
        // Best-effort hit count update (don't await)
        query(
            `UPDATE tts_audio_cache SET hit_count = hit_count + 1, last_hit_at = NOW()
             WHERE text_hash=? AND voice_id=? AND audio_speed=?`,
            [hash, voiceId, speed]
        ).catch(() => { /* ignore */ });
        return rows[0];
    } catch (err) {
        console.warn('[ttsService] cache read failed:', err.message);
        return null;
    }
}

async function _writeCache({ text, voiceId, speed, audioUrl, backupUrl, provider, expiresAtTs }) {
    try {
        const hash = _hash(text, voiceId, speed);
        const preview = String(text).slice(0, 240);
        // TTSMaker returns a unix timestamp; fall back to 24h if missing.
        const expiresAt = expiresAtTs
            ? new Date(expiresAtTs * 1000)
            : new Date(Date.now() + 24 * 3600 * 1000);
        await query(
            `INSERT INTO tts_audio_cache
             (text_hash, voice_id, audio_speed, text_preview, audio_url, backup_url, provider, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                audio_url=VALUES(audio_url),
                backup_url=VALUES(backup_url),
                expires_at=VALUES(expires_at),
                provider=VALUES(provider)`,
            [hash, voiceId, speed, preview, audioUrl, backupUrl || null, provider, expiresAt]
        );
    } catch (err) {
        console.warn('[ttsService] cache write failed:', err.message);
    }
}

/**
 * Synthesise speech for `text`.
 * @param {string} text
 * @param {object} [opts]
 * @param {'male'|'female'} [opts.gender]   per-user voice preference
 * @returns {Promise<{provider:string, audioUrl?:string, audioBackupUrl?:string, useBrowserFallback?:boolean, error?:string, fromCache?:boolean, quota?:object}>}
 */
async function synthesise(text, opts = {}) {
    if (!ENABLED || !text || !text.trim()) {
        return { provider: 'none', useBrowserFallback: true };
    }

    const gender = (opts && opts.gender === 'male') ? 'male' : 'female';

    // Edge TTS path — Microsoft's free neural voices. Preferred over
    // browser TTS when the operator wants a uniform "BMU voice" across
    // every device.
    if (PROVIDER === 'edge') {
        try {
            const edge = require('./edgeTtsService');
            if (edge.isConfigured()) {
                const r = await edge.synthesiseToFile(text, { gender });
                return {
                    provider: 'edge',
                    audioUrl: r.audioUrl,
                    fromCache: !!r.fromCache,
                    voice: r.voice
                };
            }
        } catch (err) {
            console.warn('[ttsService] edge tts failed, falling back to browser:', err.message);
            return { provider: 'browser', useBrowserFallback: true, error: err.message };
        }
        return { provider: 'browser', useBrowserFallback: true };
    }

    if (PROVIDER === 'browser' || !isTtsmakerConfigured()) {
        return { provider: 'browser', useBrowserFallback: true };
    }

    const voiceId = getVoiceId(gender);
    const speed = getSpeed();

    // 1. Cache lookup
    const cached = await _readCache(text, voiceId, speed);
    if (cached?.audio_url) {
        return {
            provider: cached.provider || 'ttsmaker',
            audioUrl: cached.audio_url,
            audioBackupUrl: cached.backup_url || null,
            fromCache: true
        };
    }

    // 2. TTSMaker call
    try {
        const body = {
            api_key:                  process.env.TTSMAKER_TTS_API_KEY,
            text:                     text.trim().slice(0, 19_500),
            voice_id:                 voiceId,
            audio_format:             'mp3',
            audio_speed:              speed,
            audio_volume:             1.0,
            audio_pitch:              1.0,
            audio_high_quality:       0,
            text_paragraph_pause_time: 200,
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

        if (data?.error_code === 0 && data?.audio_download_url) {
            await _writeCache({
                text, voiceId, speed,
                audioUrl: data.audio_download_url,
                backupUrl: data.audio_download_backup_url || null,
                provider: 'ttsmaker',
                expiresAtTs: data.audio_file_expiration_timestamp || null
            });
            return {
                provider: 'ttsmaker',
                audioUrl: data.audio_download_url,
                audioBackupUrl: data.audio_download_backup_url || null,
                expiresAt: data.audio_file_expiration_timestamp || null,
                quota: data.account_status || null,
                fromCache: false
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
