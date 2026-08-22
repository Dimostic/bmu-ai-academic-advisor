const retrievalService = require('../services/retrievalService');
let pool = null;
try { ({ pool } = require('../../config/db')); }
catch (_) { pool = null; }

const QUESTIONS = [
    ['Show 300L MLS courses', 'MLS 303'],
    ['List year 3 medical laboratory science courses', 'MLS 303'],
    ['Show 3rd year nursing courses', 'NSC 301'],
    ['Show semester 1 500 level optometry courses', 'OPT 501'],
    ['Show semester 2 500 level optometry courses', 'OPT 598'],
    ['Tell me about medicine OPT611', 'Ocular Manifestations of Systemic Diseases'],
    ['Tell me about optometry course OPT611', 'Seminar in Research Topics'],
    ['Does BMU have 100 level nursing courses?', 'NURSING SCIENCE']
];

function collectText(result) {
    const parts = [];
    for (const item of result?.context || []) {
        parts.push(item.text || item.content || item.rawText || '');
        if (item.metadata) parts.push(JSON.stringify(item.metadata));
    }
    if (result?.structuredContext) parts.push(result.structuredContext);
    if (result?.normalizedContext) parts.push(result.normalizedContext);
    return parts.join('\n');
}

async function main() {
    const results = [];
    for (const [question, expected] of QUESTIONS) {
        const result = await retrievalService.retrieve(question, { limit: 8 });
        const text = collectText(result);
        const matched = text.toLowerCase().includes(String(expected).toLowerCase());
        if (!matched) {
            throw new Error(`Retrieval did not include "${expected}" for "${question}".`);
        }
        results.push({
            question,
            expected,
            matched,
            contextCount: Array.isArray(result?.context) ? result.context.length : 0
        });
    }
    console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
}

function closePoolAndExit(code) {
    if (!pool) return process.exit(code);
    pool.end(() => process.exit(code));
}

main()
    .then(() => closePoolAndExit(0))
    .catch(error => {
        console.error(error.message || error);
        closePoolAndExit(1);
    });
