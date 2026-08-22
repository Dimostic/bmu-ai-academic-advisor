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

const EXTENDED_QUESTIONS = [
    ...DEFAULT_QUESTIONS,
    'What courses are in 200 level community health sciences?',
    'List 500 level community health courses',
    'Show 500 level Nursing courses',
    'What are 200 level PharmD courses?',
    'Show 100 level Pharmacy courses',
    'Show 500 level optometry courses',
    'List 600 level physiotherapy courses',
    'Show 400 level radiography and radiation science courses',
    'What courses are in 500 level health information management?',
    'Show 300 level healthcare administration and hospital management courses',
    'List 500 level nutrition and dietetics courses',
    'Show 400 level physics with electronics courses',
    'What are 300 level microbiology courses?',
    'Show 400 level biochemistry first semester courses',
    'What courses are in 300 level computer science second semester?',
    'Show 200 level Human Anatomy courses',
    'Show 400 level Human Physiology courses',
    'List 300 level dental technology courses',
    'Tell me about OPT611',
    'Tell me about BMU NSC 421',
    'What courses are in 200 level public health?',
    'What courses are 300 level MLS students taking?'
];

const EXPECTED_SNIPPETS = new Map([
    ['What courses do 300 level MLS students take?', '300 level Medical Laboratory Science has 18 displayed course entries'],
    ['Show 600 level MBBS courses', '600 level Medicine and Surgery has 38 displayed course entries'],
    ['Tell me about MED 602', 'MED 602, Metabolic and Endocrine Medicine'],
    ['Tell me about MLS 313', 'MLS 313, Basic Hematology'],
    ['Show 400 level radiography and radiation science courses', '400 level Radiography & Radiation Science has 15 displayed course entries'],
    ['Show 400 level physics with electronics courses', '400 level Physics with Electronics has 18 displayed course entries'],
    ['Tell me about OPT611', 'I found 2 matching BMU course entries: OPT 611']
]);

async function main() {
    const questions = process.argv.slice(2);
    if (questions.includes('--coverage')) {
        const rows = await courseCatalogService.loadCatalog();
        const programmes = new Map();
        for (const row of rows) {
            if (!programmes.has(row.programme)) programmes.set(row.programme, new Set());
            programmes.get(row.programme).add(row.level);
        }
        console.log(JSON.stringify({
            ok: true,
            rows: rows.length,
            programmes: [...programmes.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([programme, levels]) => ({
                    programme,
                    levels: [...levels].sort((a, b) => Number(a) - Number(b))
                }))
        }, null, 2));
        return;
    }

    const list = questions.includes('--extended')
        ? EXTENDED_QUESTIONS
        : questions.length
            ? questions
            : DEFAULT_QUESTIONS;
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
