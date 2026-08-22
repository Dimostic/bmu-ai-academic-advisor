const courseCatalogService = require('../services/courseCatalogService');
let pool = null;
try { ({ pool } = require('../../config/db')); }
catch (_) { pool = null; }

const DEFAULT_QUESTIONS = [
    'Show 300 level medical laboratory science courses',
    'What courses do 300 level MLS students take?',
    'Show 300 level Medical Laboratory Science first semester courses',
    'What are the courses for 300 level medical laboratory science second semester?',
    'Show 400 level nursing science courses',
    'Show 100 level community health science courses',
    'Show 200 level public health courses',
    'Show 600 level MBBS courses',
    'Tell me about MED 602',
    'Tell me about MLS 313',
    'Show 500 level pharmacy courses',
    'Show 100 level computer science courses'
];

const EXPECTED_SNIPPETS = new Map([
    ['What courses do 300 level MLS students take?', '300 level Medical Laboratory Science has 18 displayed course entries'],
    ['Show 600 level MBBS courses', '600 level Medicine and Surgery has 38 displayed course entries'],
    ['Tell me about MED 602', 'MED 602, Metabolic and Endocrine Medicine'],
    ['Tell me about MLS 313', 'MLS 313, Basic Hematology']
]);

async function main() {
    const questions = process.argv.slice(2);
    const list = questions.length ? questions : DEFAULT_QUESTIONS;
    const results = [];

    for (const question of list) {
        const reply = await courseCatalogService.buildCourseListReply(question);
        results.push({
            question,
            matched: Boolean(reply),
            source: reply?._source || null,
            confidence: reply?.confidence || null,
            speech: reply?.speech_text || null,
            citations: reply?.citations?.map(c => c.title || c.source).filter(Boolean) || []
        });
    }

    for (const result of results) {
        if (!result.matched) throw new Error(`No structured course reply for: ${result.question}`);
        const expected = EXPECTED_SNIPPETS.get(result.question);
        if (expected && !String(result.speech || '').includes(expected)) {
            throw new Error(`Unexpected reply for "${result.question}". Expected speech to include: ${expected}. Got: ${result.speech}`);
        }
        if (/\bdoes not list do 300\b/i.test(result.speech || '')) {
            throw new Error(`False course-code detection still present for: ${result.question}`);
        }
    }

    console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
}

function closePoolAndExit(code) {
    if (!pool) {
        process.exit(code);
        return;
    }
    pool.end(() => process.exit(code));
}

main()
    .then(() => closePoolAndExit(0))
    .catch(error => {
        console.error(error.message || error);
        closePoolAndExit(1);
    });
