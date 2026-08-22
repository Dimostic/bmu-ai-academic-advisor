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

const EDGE_QUESTIONS = [
    ...EXTENDED_QUESTIONS,
    'What are the units for MLS313?',
    'How many credit units is MED602?',
    'Tell me about nursing course BMU NSC421',
    'Tell me about optometry course OPT611',
    'Tell me about medicine OPT611',
    'Show 300L MLS courses',
    'List year 3 medical laboratory science courses',
    'Show level 300 MLS courses',
    'Show 3rd year nursing courses',
    'Show first semester 400 level radiography courses',
    'Show second semester 400 level radiography courses',
    'Show semester 1 500 level optometry courses',
    'Show semester 2 500 level optometry courses',
    'What levels are available for pharmacy courses?',
    'What levels are available for community health sciences?',
    'Does BMU have 100 level nursing courses?',
    'Do you have courses for 700 level MBBS?',
    'Show 200 level doctor of pharmacy courses',
    'Show 200 level pharm d courses',
    'Show 300 level health care admin courses',
    'Show 300 level hospital management courses',
    'Show 500 level HIM courses',
    'Show 400 level MLS 2nd semester courses',
    'Show 400 level MLS 1st semester courses',
    'What course is BMU-PST629?',
    'What course is BMU PST 629?',
    'What is CHS513?',
    'What is BMU-CHS521?',
    'Show courses for Public Health in 300 level',
    'Show courses for 300 level in Public Health'
];

const EXPECTED_SNIPPETS = new Map([
    ['What courses do 300 level MLS students take?', '300 level Medical Laboratory Science has 18 displayed course entries'],
    ['Show 600 level MBBS courses', '600 level Medicine and Surgery has 38 displayed course entries'],
    ['Tell me about MED 602', 'MED 602, Metabolic and Endocrine Medicine'],
    ['Tell me about MLS 313', 'MLS 313, Basic Hematology'],
    ['Show 400 level radiography and radiation science courses', '400 level Radiography & Radiation Science has 15 displayed course entries'],
    ['Show 400 level physics with electronics courses', '400 level Physics with Electronics has 18 displayed course entries'],
    ['Tell me about OPT611', 'I found 2 matching BMU course entries: OPT 611'],
    ['What are the units for MLS313?', 'MLS 313, Basic Hematology'],
    ['How many credit units is MED602?', 'MED 602, Metabolic and Endocrine Medicine'],
    ['Tell me about optometry course OPT611', 'OPT 611, Seminar in Research Topics'],
    ['Tell me about medicine OPT611', 'OPT 611, Ocular Manifestations of Systemic Diseases'],
    ['Show 300L MLS courses', '300 level Medical Laboratory Science has 18 displayed course entries'],
    ['List year 3 medical laboratory science courses', '300 level Medical Laboratory Science has 18 displayed course entries'],
    ['Show level 300 MLS courses', '300 level Medical Laboratory Science has 18 displayed course entries'],
    ['Show 3rd year nursing courses', '300 level Nursing Science'],
    ['What levels are available for pharmacy courses?', 'Pharmacy has course entries for 100 level, 200 level'],
    ['Does BMU have 100 level nursing courses?', 'does not show 100 level Nursing Science courses']
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
    if (questions.includes('--invalid-codes')) {
        const rows = await courseCatalogService.loadCatalog();
        const invalidRows = rows.filter(row => !/^(?:BMU-)?[A-Z]{2,4}\s*\d{3}[A-Z]?$/i.test(String(row.courseCode || '')));
        console.log(JSON.stringify({
            ok: true,
            count: invalidRows.length,
            rows: invalidRows.map(row => ({
                programme: row.programme,
                level: row.level,
                semester: row.semester,
                courseCode: row.courseCode,
                courseTitle: row.courseTitle,
                sourceTitle: row.sourceTitle
            }))
        }, null, 2));
        return;
    }

    const list = questions.includes('--edge')
        ? EDGE_QUESTIONS
        : questions.includes('--extended')
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
