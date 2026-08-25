#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { query, pool } = require('../../config/db');
const tts = require('../services/ttsService');

function argValue(name, fallback = null) {
    const prefix = `--${name}=`;
    const found = process.argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

function speechFromAnswer(answer) {
    const text = String(answer || '').trim();
    if (!text) return '';
    const firstParagraph = text
        .split(/\n{2,}/)
        .map(part => part.trim())
        .find(Boolean);
    return (firstParagraph || text).replace(/\s+/g, ' ').slice(0, 600);
}

async function closeDbPool() {
    if (pool && typeof pool.end === 'function') {
        await new Promise(resolve => pool.end(resolve));
    }
}

async function main() {
    const limit = Math.max(1, Math.min(500, parseInt(argValue('limit', '50'), 10) || 50));
    const qaType = argValue('qa-type', '');
    const genderArg = String(argValue('gender', 'female')).toLowerCase();
    const dryRun = hasFlag('dry-run');
    const genders = genderArg === 'both' ? ['female', 'male'] : [genderArg === 'male' ? 'male' : 'female'];

    await tts.ensureAudioArchiveSchema();

    const params = [];
    let where = 'WHERE is_active = 1 AND answer IS NOT NULL AND TRIM(answer) <> \'\'';
    if (qaType) {
        where += ' AND qa_type = ?';
        params.push(qaType);
    }
    params.push(limit);

    const rows = await query(
        `SELECT id, question, answer, qa_type, is_verified, usage_count, updated_at
         FROM cached_qa
         ${where}
         ORDER BY is_verified DESC, usage_count DESC, updated_at DESC, id DESC
         LIMIT ?`,
        params
    );

    console.log(`[archiveCommonAnswerAudio] Found ${rows.length} cached answers; genders=${genders.join(', ')}; dryRun=${dryRun}`);
    let archived = 0;
    let skipped = 0;

    for (const row of rows) {
        const speech = speechFromAnswer(row.answer);
        if (!speech) {
            skipped += 1;
            continue;
        }

        for (const gender of genders) {
            if (dryRun) {
                console.log(`[dry-run] cached_qa:${row.id} ${gender} "${row.question.slice(0, 80)}"`);
                continue;
            }
            const audio = await tts.synthesise(speech, {
                gender,
                archive: true,
                sourceType: 'cached_qa',
                sourceId: row.id
            });
            if (audio?.audioUrl && audio.archived !== false) {
                archived += 1;
                console.log(`[archived] cached_qa:${row.id} ${gender} ${audio.fromCache ? 'hit' : 'new'} ${audio.audioUrl}`);
            } else {
                skipped += 1;
                console.log(`[skip] cached_qa:${row.id} ${gender} provider=${audio?.provider || 'none'} error=${audio?.error || ''}`);
            }
        }
    }

    console.log(`[archiveCommonAnswerAudio] Done. archived_or_hit=${archived}; skipped=${skipped}`);
}

main()
    .catch(err => {
        console.error('[archiveCommonAnswerAudio] Failed:', err.message);
        process.exitCode = 1;
    })
    .finally(closeDbPool);
