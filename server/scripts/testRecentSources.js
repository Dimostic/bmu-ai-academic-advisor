#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query, pool } = require('../../config/db');
const bmuRecentSourceService = require('../services/bmuRecentSourceService');
const advisorStreamService = require('../services/advisorStreamService');

function closePoolAndExit(code) {
    if (pool && typeof pool.end === 'function') {
        pool.end(() => process.exit(code));
        return;
    }
    process.exit(code);
}

async function main() {
    await bmuRecentSourceService.ensureSchema();

    const sources = await query(`
        SELECT id, source_name, source_url
        FROM bmu_recent_sources
        ORDER BY source_rank DESC, id ASC
    `);
    if (sources.length < 4) {
        throw new Error(`Expected at least 4 seeded BMU recent sources, found ${sources.length}`);
    }

    const source = sources.find(row => String(row.source_url || '').includes('bmu.edu.ng')) || sources[0];
    const testHash = `test_recent_${Date.now()}`;
    const factText = 'BMU 2099/2100 admission update: test-only cut-off mark for Medicine and Surgery is 299.';

    try {
        await query(`
            INSERT INTO bmu_recent_facts
                (record_hash, source_id, source_name, source_type, source_url, title, category,
                 fact_text, session_label, programme, authority_type, authority_rank, confidence,
                 status, currentness_label, approved_at)
            VALUES (?, ?, ?, 'website', ?, 'Test BMU admission notice', 'admissions',
                    ?, '2099/2100', 'Medicine and Surgery (MBBS)', 'institution', 100, 0.99,
                    'approved', 'recent', NOW())
        `, [testHash, source.id, source.source_name, source.source_url, factText]);

        const facts = await bmuRecentSourceService.findApprovedRecentFacts(
            'What is the latest BMU admission update for Medicine and Surgery 2099/2100?',
            { limit: 3 }
        );
        if (!facts.some(row => row.record_hash === testHash)) {
            throw new Error('Approved recent fact lookup did not return the seeded test fact');
        }

        const reply = await advisorStreamService._buildRecentBmuFactsReply(
            'What is the latest BMU admission update for Medicine and Surgery 2099/2100?'
        );
        if (!reply || !String(reply.display_markdown || '').includes('299')) {
            throw new Error('Advisor recent-fact fast path did not use the approved test fact');
        }

        console.log(JSON.stringify({
            ok: true,
            checked: 'bmu recent sources schema and approved-fact advisor path',
            seededSources: sources.length,
            matchedFacts: facts.length
        }, null, 2));
    } finally {
        await query('DELETE FROM bmu_recent_facts WHERE record_hash = ?', [testHash]);
    }
}

main().then(() => closePoolAndExit(0)).catch(error => {
    console.error(error.message || error);
    closePoolAndExit(1);
});
