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

async function resolveReply(question) {
    const fast = await advisorStreamService._buildFastIntentReply(question);
    if (fast) return fast;
    return bmuLawService.buildLawReply(question);
}

async function main() {
    const highRisk = cases.filter(item => /^(principal-officer|fees|mbbs-admission|mbbs-duration|handbook|bmu-law|cutoff|registration)/.test(item.name));
    const failures = [];
    for (const item of highRisk) {
        const reply = await resolveReply(item.question);
        const citations = Array.isArray(reply?.citations) ? reply.citations : [];
        if (!reply || !citations.length) {
            failures.push({ name: item.name, question: item.question });
        }
    }
    assert(!failures.length, `High-risk replies missing citations: ${failures.map(f => f.name).join(', ')}`);
    console.log(JSON.stringify({
        success: true,
        checked: 'High-risk advisor replies include evidence metadata',
        count: highRisk.length
    }, null, 2));
}

main().then(() => {
    if (pool) pool.end(() => process.exit(0));
    else process.exit(0);
}).catch(error => {
    console.error(error.message || error);
    if (pool) pool.end(() => process.exit(1));
    else process.exit(1);
});
