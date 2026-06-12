/**
 * Edge TTS — synthesise speech using Microsoft Edge's free neural voices.
 *
 * Uses the same WebSocket protocol the Edge browser's "Read Aloud"
 * feature talks to. Voices are high-quality (en-US Aria, en-NG Ezinne /
 * Abeo, en-GB Sonia, etc) and the service is free at our scale —
 * Microsoft rate-limits at the IP level but a single VPS serving a
 * student cohort is well below the threshold.
 *
 * Output is an MP3 buffer; we save it under uploads/audio/<sha>.mp3 and
 * return the public URL so the existing TTS audio cache schema still
 * works (the `audio_url` column just points at our own server now).
 *
 *   advisorService → ttsService → (TTS_PROVIDER==='edge') → edgeTtsService
 *
 * Voices map (env overridable):
 *   EDGE_TTS_VOICE_FEMALE   default en-NG-EzinneNeural
 *   EDGE_TTS_VOICE_MALE     default en-NG-AbeoNeural
 *
 * Both use natural Nigerian English; fall back to Aria/Guy if the
 * en-NG voices ever go missing.
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs').promises;
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
    await fs.mkdir(AUDIO_DIR, { recursive: true });
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
 * @param {string} text   Plain text to speak (already humanised)
 * @param {object} [opts]
 * @param {'male'|'female'} [opts.gender='female']
 * @param {string} [opts.rate='+0%']         e.g. '+10%' or '-5%'
 * @param {string} [opts.pitch='+0Hz']       e.g. '+2Hz'
 * @param {string} [opts.voice]              Override the gender map
 */
async function synthesiseToFile(text, opts = {}) {
    const gender = opts.gender === 'male' ? 'male' : 'female';
    const voice  = opts.voice || voiceFor(gender);
    const rate   = opts.rate  || (process.env.EDGE_TTS_RATE  || '+5%');
    const pitch  = opts.pitch || (process.env.EDGE_TTS_PITCH || '+0Hz');

    if (!text || !text.trim()) {
        throw new Error('Empty text');
    }
    await _ensureDir();
    const id = _hash(text, voice, rate, pitch).slice(0, 32);
    const filePath = path.join(AUDIO_DIR, `${id}.mp3`);
    const url = `${AUDIO_BASE_URL}/${id}.mp3`;

    // Cache hit
    try {
        await fs.access(filePath);
        return { audioUrl: url, voice, fromCache: true };
    } catch (_) { /* generate */ }

    const tts = new MsEdgeTTS();
    try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    } catch (err) {
        console.warn(`[edgeTts] voice ${voice} failed metadata; falling back:`, err.message);
        const fb = gender === 'male' ? FALLBACK_MALE : FALLBACK_FEMALE;
        await tts.setMetadata(fb, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    }

    // toFile returns { audioFilePath } — the lib writes to a temp path
    // and we then rename to our deterministic cache path.
    const result = await tts.toFile(filePath, text, { rate, pitch });
    // Some library versions return a Promise that resolves once the
    // websocket closes; others return immediately. Either way the file
    // is on disk after `await`.
    void result;

    // Verify the file landed
    try { await fs.access(filePath); }
    catch (err) { throw new Error('Edge TTS did not produce a file'); }

    return { audioUrl: url, voice, fromCache: false };
}

function isConfigured() {
    // Edge TTS needs no key — only outbound WebSocket access. Treat as
    // always available unless explicitly disabled.
    return process.env.EDGE_TTS_DISABLED !== 'true';
}

module.exports = { synthesiseToFile, isConfigured, voiceFor };
