#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const advisorStreamService = require('../services/advisorStreamService');
const bmuLawService = require('../services/bmuLawService');

let pool = null;
try { ({ pool } = require('../../config/db')); }
catch (_) { pool = null; }

const REPRESENTATIVE_PROGRAMMES = [
    'Medicine and Surgery',
    'Nursing Science',
    'Medical Laboratory Science',
    'Radiography and Radiation Sciences',
    'Community Health Science'
];

function addCase(cases, question, origin, type = 'follow_up') {
    const q = String(question || '').trim();
    if (!q) return;
    const key = q.toLowerCase();
    if (cases.some(item => item.key === key)) return;
    cases.push({ key, question: q, origin, type });
}

function textFromReply(reply) {
    return `${reply?.display_markdown || ''}\n${reply?.speech_text || ''}\n${JSON.stringify(reply?.citations || [])}`.toLowerCase();
}

async function resolveReply(question) {
    const fast = await advisorStreamService._buildFastIntentReply(question);
    if (fast) return fast;
    return bmuLawService.buildLawReply(question);
}

function withTimeout(promise, fallback, timeoutMs = 8000) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
    ]);
}

function expectedRouteFailure(question, reply) {
    const q = String(question || '').toLowerCase();
    const topic = String(reply?.topic_slug || reply?._source || '').toLowerCase();
    const text = textFromReply(reply);

    if (/\bfee|fees|tuition\b/i.test(q)) {
        if (!topic.includes('fee')) return 'fee suggestion did not route to the fee answer path';
        if (/\bbmu law\b|section 4|powers of the university/.test(text)) return 'fee suggestion produced a BMU Law answer';
    }

    if (/\b(principal officer|vice chancellor|vc|bursar|registrar|librarian|chancellor|pro[-\s]?chancellor)\b/i.test(q)) {
        if (!/(principal_officer|chancellor|visitor)/.test(topic)) return 'officer suggestion did not route to officer records';
    }

    if (/\bcourses?\b|\bcourse units?\b|\bby level\b/i.test(q)) {
        if (!/(course|programme|program|student_handbook|mbbs)/.test(topic)) return 'course suggestion did not route to course or programme records';
    }

    if (/\badmission\b|\brequirements?\b/i.test(q) && !/\bhostel\b/i.test(q)) {
        if (reply && !/(admission|requirement|programme|program|mbbs|student_handbook|ccmas|structured)/.test(topic + text)) {
            return 'admission/requirement suggestion did not route to a relevant answer';
        }
    }

    return null;
}

async function main() {
    const cases = [];

    addCase(cases, 'What programmes are offered at BMU?', 'greeting suggested action', 'suggested_action');
    addCase(cases, 'What are current BMU fees by programme?', 'greeting suggested action', 'suggested_action');
    addCase(cases, 'What are the admission requirements for Medicine and Surgery?', 'greeting follow-up');
    addCase(cases, 'What is the current BMU tuition fee for Nursing Science?', 'greeting follow-up');
    addCase(cases, 'What is BMU student academic workload and credit load?', 'greeting follow-up');
    addCase(cases, 'What is BMU student academic workload and credit load?', 'help suggested action', 'suggested_action');
    addCase(cases, 'What programmes are offered at BMU?', 'help suggested action', 'suggested_action');
    addCase(cases, 'What is BMU reassessment policy after results are published?', 'help follow-up');
    addCase(cases, 'What are BMU registration requirements for new students?', 'help follow-up');
    addCase(cases, 'What is the 100 level MBBS non-indigene fee?', 'fee summary follow-up');
    addCase(cases, 'What is the 300 level Community Health indigene fee?', 'fee summary follow-up');
    addCase(cases, 'What are the admission requirements for Medicine and Surgery?', 'grounded fallback follow-up');
    addCase(cases, 'Can you explain the BMU fee structure in more detail?', 'grounded fallback follow-up');

    for (const programme of REPRESENTATIVE_PROGRAMMES) {
        addCase(cases, `Show current fees for ${programme}`, 'programme overview generated follow-up');
        addCase(cases, `Show courses for ${programme} by level`, 'programme overview generated follow-up');
    }

    const results = [];
    let failed = 0;

    for (const item of cases) {
        let ok = false;
        let routeFailure = null;
        let reply = null;
        let error = null;

        try {
            ok = await withTimeout(advisorStreamService._isRetrievableQuestion(item.question), false);
            reply = await withTimeout(resolveReply(item.question), null);
            routeFailure = expectedRouteFailure(item.question, reply);
            if (routeFailure) ok = false;
        } catch (err) {
            error = err.message || String(err);
            ok = false;
        }

        if (!ok) failed += 1;
        results.push({
            ok,
            question: item.question,
            origin: item.origin,
            type: item.type,
            topic_slug: reply?.topic_slug || null,
            source: reply?._source || null,
            failure: routeFailure || error || null
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
