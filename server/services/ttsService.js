/**
 * Text-to-speech service for the academic advisor.
 *
 * Free-first strategy:
 *   1. TTSMaker API v2 (https://api.ttsmaker.com/v2/create-tts-order) — primary.
 *   2. Browser `speechSynthesis` — final fallback. The server cannot synthesise
 *      this; we simply tell the client to do it locally.
 *
 * Performance: common/authoritative responses can be archived as local MP3s,
 * then reused permanently. Other responses still use the short-lived
 * `tts_audio_cache` table because TTSMaker's hosted audio URLs expire.
 *
 * Lip-sync is computed client-side from the audio waveform using the Web Audio
 * API, so no provider-specific viseme metadata is required.
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query } = require('../../config/db');

const TTSMAKER_BASE = 'https://api.ttsmaker.com/v2';
const PROVIDER      = (process.env.TTS_PROVIDER || 'ttsmaker').toLowerCase();
const ENABLED       = process.env.ENABLE_VOICE_RESPONSES !== 'false';
const CACHE_SAFETY_MS = 5 * 60 * 1000; // treat URLs that expire in <5 min as miss
const AUDIO_ARCHIVE_ENABLED = process.env.TTS_AUDIO_ARCHIVE_ENABLED !== 'false';
const AUDIO_ARCHIVE_DIR = process.env.TTS_AUDIO_ARCHIVE_DIR ||
    path.join(__dirname, '../storage/advisor-audio-cache');
const AUDIO_ARCHIVE_PUBLIC_BASE = (process.env.TTS_AUDIO_ARCHIVE_PUBLIC_BASE || '/advisor-audio-cache')
    .replace(/\/+$/, '');
const AUDIO_ARCHIVE_MAX_BYTES = parseInt(process.env.TTS_AUDIO_ARCHIVE_MAX_BYTES || String(12 * 1024 * 1024), 10);
let archiveSchemaReady = false;

function normalizeTextForTts(input) {
    let s = String(input || '').trim();
    if (!s) return s;

    // Force NUC to be spoken as one continuous letter-sequence.
    s = s.replace(/\bNUC\b/gi, 'N.U.C');

    // Force common BMU abbreviations to be spoken as letters.
    const ACRONYMS = ['BMU', 'MBBS', 'BNSC', 'BMLS', 'CCMAS', 'GPA', 'MDCN', 'CGPA', 'NYSC', 'HOD'];
    for (const a of ACRONYMS) {
        const re = new RegExp(`\\b${a}\\b`, 'gi');
        s = s.replace(re, a.split('').join(' '));
    }

    // If an acronym is hyphenated to a word (e.g. "N U C-approved"),
    // remove the hyphen so TTS reads "N U C approved".
    s = s.replace(/\bN\.U\.C\s*-\s*(?=[A-Za-z])/g, 'N.U.C ');
    s = s.replace(/\b([A-Z](?:\s+[A-Z]){1,7})\s*-\s*(?=[A-Za-z])/g, '$1 ');

    return s.replace(/\s+/g, ' ').trim();
}

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

function shouldArchive(opts = {}) {
    if (!AUDIO_ARCHIVE_ENABLED) return false;
    if (opts.archive === false) return false;
    if (opts.archive === true) return true;
    return ['cached_qa', 'fast_intent', 'principal_officers_reference', 'governor_visitor_reference']
        .includes(String(opts.sourceType || ''));
}

function _archiveHash(text, provider, voiceId, speed, gender) {
    const norm = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
    return crypto
        .createHash('sha256')
        .update(`${norm}|${provider}|${voiceId}|${speed.toFixed(2)}|${gender}`)
        .digest('hex');
}

async function ensureAudioArchiveSchema() {
    if (archiveSchemaReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS advisor_audio_archives (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cache_key CHAR(64) NOT NULL,
            text_hash CHAR(64) NOT NULL,
            speech_text LONGTEXT NOT NULL,
            text_preview VARCHAR(255) NULL,
            source_type VARCHAR(64) NULL,
            source_id VARCHAR(128) NULL,
            provider VARCHAR(64) NOT NULL,
            voice_id INT NOT NULL,
            audio_speed DECIMAL(4,2) NOT NULL,
            gender VARCHAR(16) NOT NULL DEFAULT 'female',
            audio_url VARCHAR(500) NOT NULL,
            file_path VARCHAR(1000) NOT NULL,
            mime_type VARCHAR(80) NOT NULL DEFAULT 'audio/mpeg',
            bytes INT UNSIGNED NULL,
            hit_count INT UNSIGNED NOT NULL DEFAULT 0,
            last_hit_at TIMESTAMP NULL DEFAULT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'active',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_audio_archive_cache_key (cache_key),
            KEY idx_audio_archive_text_hash (text_hash),
            KEY idx_audio_archive_source (source_type, source_id),
            KEY idx_audio_archive_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, []);
    archiveSchemaReady = true;
}

async function _readAudioArchive({ text, provider, voiceId, speed, gender }) {
    try {
        await ensureAudioArchiveSchema();
        const textHash = _hash(text, voiceId, speed);
        const cacheKey = _archiveHash(text, provider, voiceId, speed, gender);
        const rows = await query(
            `SELECT audio_url, provider
             FROM advisor_audio_archives
             WHERE cache_key = ? AND text_hash = ? AND status = 'active'
             LIMIT 1`,
            [cacheKey, textHash]
        );
        if (!rows[0]?.audio_url) return null;
        query(
            `UPDATE advisor_audio_archives
             SET hit_count = hit_count + 1, last_hit_at = NOW()
             WHERE cache_key = ?`,
            [cacheKey]
        ).catch(() => { /* ignore */ });
        return rows[0];
    } catch (err) {
        console.warn('[ttsService] audio archive read failed:', err.message);
        return null;
    }
}

function _extensionFromContentType(contentType, fallbackUrl) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('wav')) return 'wav';
    if (ct.includes('ogg')) return 'ogg';
    if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
    const ext = path.extname(new URL(fallbackUrl).pathname).replace('.', '').toLowerCase();
    return ['mp3', 'wav', 'ogg'].includes(ext) ? ext : 'mp3';
}

async function _writeAudioArchive({ text, provider, voiceId, speed, gender, remoteUrl, sourceType, sourceId }) {
    if (!remoteUrl || !AUDIO_ARCHIVE_ENABLED) return null;
    try {
        await ensureAudioArchiveSchema();
        const cacheKey = _archiveHash(text, provider, voiceId, speed, gender);
        const textHash = _hash(text, voiceId, speed);
        await fs.promises.mkdir(AUDIO_ARCHIVE_DIR, { recursive: true });

        const response = await axios.get(remoteUrl, {
            responseType: 'arraybuffer',
            timeout: 30_000,
            maxContentLength: AUDIO_ARCHIVE_MAX_BYTES,
            headers: { accept: 'audio/*,*/*;q=0.8' }
        });
        const contentType = String(response.headers?.['content-type'] || 'audio/mpeg').split(';')[0].trim();
        const buffer = Buffer.from(response.data || []);
        if (buffer.length < 256) throw new Error('downloaded audio was empty');
        if (!/^audio\//i.test(contentType) && !/\.mp3(?:$|\?)/i.test(remoteUrl)) {
            throw new Error(`unexpected audio content type: ${contentType || 'unknown'}`);
        }

        const ext = _extensionFromContentType(contentType, remoteUrl);
        const fileName = `${cacheKey}.${ext}`;
        const filePath = path.join(AUDIO_ARCHIVE_DIR, fileName);
        await fs.promises.writeFile(filePath, buffer);
        const audioUrl = `${AUDIO_ARCHIVE_PUBLIC_BASE}/${fileName}`;

        await query(
            `INSERT INTO advisor_audio_archives
             (cache_key, text_hash, speech_text, text_preview, source_type, source_id,
              provider, voice_id, audio_speed, gender, audio_url, file_path, mime_type, bytes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
             ON DUPLICATE KEY UPDATE
                speech_text = VALUES(speech_text),
                text_preview = VALUES(text_preview),
                source_type = COALESCE(VALUES(source_type), source_type),
                source_id = COALESCE(VALUES(source_id), source_id),
                provider = VALUES(provider),
                audio_url = VALUES(audio_url),
                file_path = VALUES(file_path),
                mime_type = VALUES(mime_type),
                bytes = VALUES(bytes),
                status = 'active'`,
            [
                cacheKey,
                textHash,
                text,
                String(text).slice(0, 240),
                sourceType || null,
                sourceId == null ? null : String(sourceId),
                provider,
                voiceId,
                speed,
                gender,
                audioUrl,
                filePath,
                contentType || 'audio/mpeg',
                buffer.length
            ]
        );
        return { provider: `${provider}_archive`, audioUrl, fromCache: false, archived: true };
    } catch (err) {
        console.warn('[ttsService] audio archive write failed:', err.message);
        return null;
    }
}

async function _writeLocalAudioArchive({ text, provider, voiceId, speed, gender, audioUrl, filePath, sourceType, sourceId, voice }) {
    if (!audioUrl || !AUDIO_ARCHIVE_ENABLED) return null;
    try {
        await ensureAudioArchiveSchema();
        const cacheKey = _archiveHash(text, provider, voiceId, speed, gender);
        const textHash = _hash(text, voiceId, speed);
        let bytes = null;
        try {
            const stat = await fs.promises.stat(filePath);
            bytes = stat.size;
        } catch (_) { /* file may be on a mounted/static path not readable here */ }
        await query(
            `INSERT INTO advisor_audio_archives
             (cache_key, text_hash, speech_text, text_preview, source_type, source_id,
              provider, voice_id, audio_speed, gender, audio_url, file_path, mime_type, bytes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audio/mpeg', ?, 'active')
             ON DUPLICATE KEY UPDATE
                speech_text = VALUES(speech_text),
                text_preview = VALUES(text_preview),
                source_type = COALESCE(VALUES(source_type), source_type),
                source_id = COALESCE(VALUES(source_id), source_id),
                provider = VALUES(provider),
                audio_url = VALUES(audio_url),
                file_path = VALUES(file_path),
                bytes = COALESCE(VALUES(bytes), bytes),
                hit_count = hit_count + 1,
                last_hit_at = NOW(),
                status = 'active'`,
            [
                cacheKey,
                textHash,
                text,
                String(text).slice(0, 240),
                sourceType || null,
                sourceId == null ? null : String(sourceId),
                voice ? `${provider}:${voice}` : provider,
                voiceId,
                speed,
                gender,
                audioUrl,
                filePath || audioUrl,
                bytes
            ]
        );
        return { provider: voice ? `${provider}:${voice}` : provider, audioUrl, fromCache: false, archived: true };
    } catch (err) {
        console.warn('[ttsService] local audio archive metadata write failed:', err.message);
        return null;
    }
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

    const normalizedText = normalizeTextForTts(text);

    const gender = (opts && opts.gender === 'male') ? 'male' : 'female';

    // Edge TTS path — Microsoft's free neural voices. Preferred over
    // browser TTS when the operator wants a uniform "BMU voice" across
    // every device.
    if (PROVIDER === 'edge') {
        try {
            const edge = require('./edgeTtsService');
            if (edge.isConfigured()) {
                const r = await edge.synthesiseToFile(normalizedText, { gender });
                if (shouldArchive(opts)) {
                    const fileName = path.basename(String(r.audioUrl || ''));
                    const filePath = fileName ? path.join(__dirname, '../../uploads/audio', fileName) : '';
                    await _writeLocalAudioArchive({
                        text: normalizedText,
                        provider: 'edge',
                        voiceId: 0,
                        speed: 1,
                        gender,
                        audioUrl: r.audioUrl,
                        filePath,
                        sourceType: opts.sourceType || null,
                        sourceId: opts.sourceId || null,
                        voice: r.voice
                    });
                }
                return {
                    provider: 'edge',
                    audioUrl: r.audioUrl,
                    fromCache: !!r.fromCache,
                    voice: r.voice,
                    archived: shouldArchive(opts)
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
    const archiveWanted = shouldArchive(opts);

    if (archiveWanted) {
        const archived = await _readAudioArchive({
            text: normalizedText,
            provider: 'ttsmaker',
            voiceId,
            speed,
            gender
        });
        if (archived?.audio_url) {
            return {
                provider: archived.provider || 'ttsmaker_archive',
                audioUrl: archived.audio_url,
                fromCache: true,
                archived: true
            };
        }
    }

    // 1. Cache lookup
    const cached = await _readCache(normalizedText, voiceId, speed);
    if (cached?.audio_url) {
        if (archiveWanted) {
            const archive = await _writeAudioArchive({
                text: normalizedText,
                provider: 'ttsmaker',
                voiceId,
                speed,
                gender,
                remoteUrl: cached.audio_url || cached.backup_url,
                sourceType: opts.sourceType || null,
                sourceId: opts.sourceId || null
            });
            if (archive?.audioUrl) {
                return {
                    provider: archive.provider,
                    audioUrl: archive.audioUrl,
                    audioBackupUrl: cached.audio_url || cached.backup_url || null,
                    fromCache: true,
                    archived: true
                };
            }
        }
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
            text:                     normalizedText.trim().slice(0, 19_500),
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
            const archive = archiveWanted
                ? await _writeAudioArchive({
                    text: normalizedText,
                    provider: 'ttsmaker',
                    voiceId,
                    speed,
                    gender,
                    remoteUrl: data.audio_download_url || data.audio_download_backup_url,
                    sourceType: opts.sourceType || null,
                    sourceId: opts.sourceId || null
                })
                : null;

            await _writeCache({
                text: normalizedText,
                voiceId,
                speed,
                audioUrl: data.audio_download_url,
                backupUrl: data.audio_download_backup_url || null,
                provider: 'ttsmaker',
                expiresAtTs: data.audio_file_expiration_timestamp || null
            });
            if (archive?.audioUrl) {
                return {
                    provider: archive.provider,
                    audioUrl: archive.audioUrl,
                    audioBackupUrl: data.audio_download_url || data.audio_download_backup_url || null,
                    expiresAt: null,
                    quota: data.account_status || null,
                    fromCache: false,
                    archived: true
                };
            }
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
    ensureAudioArchiveSchema,
    normalizeTextForTts,
    isConfigured: isTtsmakerConfigured
};
