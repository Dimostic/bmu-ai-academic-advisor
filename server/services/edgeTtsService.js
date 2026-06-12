/**
 * Edge TTS — synthesise speech using Microsoft Edge's free neural voices.
 *
 * Uses the same WebSocket protocol the Edge browser's "Read Aloud"
 * feature talks to. Voices are high-quality (en-US Aria, en-NG Ezinne /
 * Abeo, en-GB Sonia, etc) and the service is free at our scale —
 * Microsoft rate-limits at the IP level but a single VPS serving a
 * student cohort is well below the threshold.
 *
 * Output is an MP3; we save it under uploads/audio/<sha>.mp3 and
 * return the public URL so the existing TTS audio cache schema still
 * works (the `audio_url` column just points at our own server now).
 *
 *   advisorService → ttsService → (TTS_PROVIDER==='edge') → edgeTtsService
 *
 * Voices map (env overridable):
 *   EDGE_TTS_VOICE_FEMALE   default en-NG-EzinneNeural
 *   EDGE_TTS_VOICE_MALE     default en-NG-AbeoNeural
 *
 * Both use natural Nigerian English; we fall back to en-US Aria/Guy if
 * the en-NG voices ever stop being served.
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const AUDIO_DIR = path.join(__dirname, '../../uploads/audio');
const AUDIO_BASE_URL = '/uploads/audio'; // mounted by app.js
const FALLBACK_FEMALE = 'en-US-AriaNeural';
const FALLBACK_MALE   = 'en-US-GuyNeural';

function voiceFor(gender) {
    if (gender === 'male') {
        return process.env.EDGE_TTS_VOICE_MALE || 'en-NG-AbeoNeural';
    }
    return process.env.EDGE_TTS_VOICE_FEMALE || 'en-NG-EzinneNeural';
}

async function _ensureDir() {
    await fsp.mkdir(AUDIO_DIR, { recursive: true });
}

function _hash(text, voice, rate, pitch) {
    return crypto.createHash('sha256')
        .update(`edge|${voice}|${rate}|${pitch}|${text}`)
        .digest('hex');
}

/**
 * Synthesise `text` to MP3 using Edge TTS. Returns the public URL of
 * the resulting file. Caches by SHA so subsequent identical requests
 * are free.
 *
 * Implementation note: the msedge-tts v2 `toFile()` insists on writing
 * to `<dir>/audio.mp3`. We bypass it and use `toStream()` directly so we
 * can control the output filename (and write atomically via .tmp).
 *
 * @param {string} text   Plain text to speak (already humanised)
 * @param {object} [opts]
 * @param {'male'|'female'} [opts.gender='female']
 * @param {string} [opts.rate='+5%']         e.g. '+10%' or '-5%'
 * @param {string} [opts.pitch='+0Hz']       e.g. '+2Hz'
 * @param {string} [opts.voice]              Override the gender map
 */
async function synthesiseToFile(text, opts = {}) {
    const gender = opts.gender === 'male' ? 'male' : 'female';
    const rate   = opts.rate  || (process.env.EDGE_TTS_RATE  || '+5%');
    const pitch  = opts.pitch || (process.env.EDGE_TTS_PITCH || '+0Hz');
    let voice    = opts.voice || voiceFor(gender);

    if (!text || !text.trim()) throw new Error('Empty text');
    await _ensureDir();

    const id = _hash(text, voice, rate, pitch).slice(0, 32);
    const filePath = path.join(AUDIO_DIR, `${id}.mp3`);
    const tmpPath  = `${filePath}.tmp`;
    const url = `${AUDIO_BASE_URL}/${id}.mp3`;

    // Cache hit
    try {
        const st = await fsp.stat(filePath);
        if (st.size > 0) return { audioUrl: url, voice, fromCache: true };
    } catch (_) { /* generate */ }

    // Try preferred voice; on metadata error fall back to the en-US default
    // (msedge-tts throws inside setMetadata if the voice id is wrong).
    const tts = new MsEdgeTTS();
    try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    } catch (err) {
        const fb = gender === 'male' ? FALLBACK_MALE : FALLBACK_FEMALE;
        console.warn(`[edgeTts] voice ${voice} unavailable, using ${fb}:`, err.message);
        voice = fb;
        await tts.setMetadata(fb, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    }

    // Stream straight to our chosen filename, then atomic-rename.
    const { audioStream } = tts.toStream(text, { rate, pitch });
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        let bytes = 0;
        audioStream.on('data',  chunk => { bytes += chunk.length; });
        audioStream.on('error', err => { try { out.close(); } catch (_){}; reject(err); });
        audioStream.pipe(out);
        out.on('error', reject);
        out.on('close', () => {
            if (bytes <= 0) {
                try { fs.unlinkSync(tmpPath); } catch (_){}
                return reject(new Error('Edge TTS produced no audio'));
            }
            resolve();
        });
    });

    try { await fsp.rename(tmpPath, filePath); }
    catch (err) {
        // If rename failed, ensure tmp is cleaned up.
        try { await fsp.unlink(tmpPath); } catch (_){}
        throw err;
    }

    try { tts.close(); } catch (_) { /* ignore */ }

    return { audioUrl: url, voice, fromCache: false };
}

function isConfigured() {
    return process.env.EDGE_TTS_DISABLED !== 'true';
}

module.exports = { synthesiseToFile, isConfigured, voiceFor };
