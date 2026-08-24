#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const advisorStreamService = require('../services/advisorStreamService');
const bmuLawService = require('../services/bmuLawService');
const cases = require('./advisorGoldenCases');
let pool = null;
try { ({ pool } = require('../../config/db')); }
catch (_) { pool = null; }

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function textFromReply(reply) {
    return `${reply?.display_markdown || ''}\n${reply?.speech_text || ''}\n${JSON.stringify(reply?.citations || [])}`.toLowerCase();
}

async function resolveReply(question) {
    const fast = await advisorStreamService._buildFastIntentReply(question);
    if (fast) return fast;
    return bmuLawService.buildLawReply(question);
}

async function main() {
    const results = [];
    let failed = 0;

    for (const item of cases) {
        const reply = await resolveReply(item.question);
        const text = textFromReply(reply);
        const missing = item.mustContain.filter(fragment => !text.includes(fragment.toLowerCase()));
        const forbidden = (item.mustNotContain || []).filter(fragment => text.includes(fragment.toLowerCase()));
        const ok = Boolean(reply) && missing.length === 0 && forbidden.length === 0;
        if (!ok) failed += 1;
        results.push({
            name: item.name,
            ok,
            question: item.question,
            source: reply?.source || reply?.topic_slug || 'none',
            missing,
            forbidden
        });
    }

    console.log(JSON.stringify({
        ok: failed === 0,
        count: cases.length,
        failed,
        results
    }, null, 2));

    if (pool) pool.end(() => process.exit(failed === 0 ? 0 : 1));
    else process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
    console.error(error.message || error);
    if (pool) pool.end(() => process.exit(1));
    else process.exit(1);
});
