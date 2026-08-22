#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const advisorStreamService = require('../services/advisorStreamService');
const bmuLawService = require('../services/bmuLawService');
let pool = null;
try { ({ pool } = require('../../config/db')); }
catch (_) { pool = null; }

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function textFromReply(reply) {
    return `${reply?.display_markdown || ''}\n${reply?.speech_text || ''}\n${JSON.stringify(reply?.citations || [])}`.toLowerCase();
}

const cases = [
    {
        name: 'principal-officer-vc',
        question: 'Who is the Vice-Chancellor of BMU?',
        mustContain: ['dimie ogoina', 'vice-chancellor']
    },
    {
        name: 'principal-officer-bursar',
        question: 'Who is the Bursar of BMU?',
        mustContain: ['ebipuado ombu', 'bursar']
    },
    {
        name: 'principal-officer-pro-chancellor',
        question: 'Who is the Chairman of the Governing Council of BMU?',
        mustContain: ['tarila tebepah', 'governing council']
    },
    {
        name: 'fees-community-health',
        question: 'What is the fee for 100 level Community Health Science non-indigene at BMU?',
        mustContain: ['community health', '415,000', 'non-indigene']
    },
    {
        name: 'fees-mbbs-non-indigene',
        question: 'What is the fee for 100 level MBBS non-indigene at BMU?',
        mustContain: ['medicine', '1,230,000', 'non-indigene']
    },
    {
        name: 'courses-mls-300',
        question: 'Show 300 level Medical Laboratory Science first semester courses',
        mustContain: ['mls 313', 'basic hematology', 'all courses for bmu.xlsx']
    },
    {
        name: 'courses-mbbs-600',
        question: 'Show 600 level MBBS courses',
        mustContain: ['med 602', 'college of medicine bmu prospectus-new.docx']
    },
    {
        name: 'bmu-law-visitor',
        question: 'Who is the Visitor of BMU under the law?',
        mustContain: ['visitor', 'governor']
    },
    {
        name: 'bmu-law-bursar-role',
        question: 'What is the role of the Bursar as chief financial officer under BMU Law?',
        mustContain: ['bursar', 'financial']
    }
];

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
        const ok = Boolean(reply) && missing.length === 0;
        if (!ok) failed += 1;
        results.push({
            name: item.name,
            ok,
            source: reply?.source || reply?.topic_slug || 'none',
            missing
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
