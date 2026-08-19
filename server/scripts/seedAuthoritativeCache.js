/**
 * Seed verified authoritative Q&A entries into cached_qa.
 *
 * The source of truth remains the app's deterministic fast-answer services:
 * officers/profile facts, fee tables, student handbook policies, BMU Law, and
 * the BMU student courses catalogue. This script promotes those answers into
 * the FAQ cache so repeated tested questions short-circuit before the LLM/RAG
 * path while staying refreshable after source corrections.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const advisorStreamService = require('../services/advisorStreamService');
const courseCatalogService = require('../services/courseCatalogService');
const bmuLawService = require('../services/bmuLawService');

const EMBEDDINGS_ENABLED = process.env.SEED_AUTHORITATIVE_EMBEDDINGS !== 'false';
const QA_TYPE = 'authoritative_seed';
const DRY_RUN = process.argv.includes('--dry-run');

let db = null;
let aiService = null;
let faqService = null;

function getDb() {
    if (!db) db = require('../../config/db');
    return db;
}

function getAiService() {
    if (!aiService) aiService = require('../services/aiService');
    return aiService;
}

function getFaqService() {
    if (!faqService) faqService = require('../services/faqService');
    return faqService;
}

const PROGRAMMES = [
    'Medicine and Surgery',
    'MBBS',
    'Dentistry',
    'Nursing Science',
    'Pharmacy',
    'Medical Laboratory Science',
    'Optometry',
    'Physiotherapy',
    'Radiography',
    'Community Health',
    'Public Health',
    'Health Information Management',
    'Health Care Administration and Hospital Management',
    'Human Nutrition and Dietetics',
    'Biochemistry',
    'Human Anatomy',
    'Human Physiology',
    'Biology',
    'Chemistry',
    'Mathematics',
    'Microbiology',
    'Physics',
    'Statistics',
    'Computer Science',
    'Human Nutrition',
    'Dental Technology'
];

const OFFICER_QUESTIONS = [
    ['Who is the Vice-Chancellor of BMU?', ['Who is the VC of BMU?', 'Name the current Vice Chancellor of Bayelsa Medical University']],
    ['Who is the Bursar of BMU?', ['Who is the bossar of BMU?', 'Who is the bossa of BMU?', 'Name the current Bursar of Bayelsa Medical University']],
    ['Who is the Pro-Chancellor of BMU?', ['Who is the Chairman of the Governing Council of BMU?', 'Who chairs BMU Governing Council?']],
    ['Who is the Registrar of BMU?', ['Name the current Registrar of Bayelsa Medical University']],
    ['Who is the University Librarian of BMU?', ['Name the current University Librarian of Bayelsa Medical University']],
    ['Who are the principal officers of BMU?', ['List the principal officers of Bayelsa Medical University']],
    ['Who is the Visitor to BMU?', ['Who is the Governor visitor to Bayelsa Medical University?']]
];

const HANDBOOK_QUESTIONS = [
    ['What is the normal credit load for BMU students?', ['How many credit units can I register per semester?', 'What is BMU student academic workload?']],
    ['What is a credit unit according to the BMU Students Handbook?', ['Define credit unit in BMU', 'Meaning of credit unit in the student handbook']],
    ['How can a BMU student request reassessment of examination results?', ['What is the reassessment fee in BMU?', 'Can I appeal a BMU exam result?']]
];

const GENERAL_QUESTIONS = [
    ['Tell me about BMU', ['What is Bayelsa Medical University?', 'Give me an overview of BMU']],
    ['What programmes offered at BMU?', ['What programmes are offered at BMU?', 'List BMU programmes offered', 'What courses are offered at Bayelsa Medical University?']],
    ['What are the admission requirements for MBBS at BMU?', ['What are the entry requirements for Medicine and Surgery at BMU?', 'What are the UTME and Direct Entry requirements for MBBS?', 'Admission requirements for Medicine and Surgery']],
    ['How long is MBBS at BMU for UTME and Direct Entry?', ['What is the duration of Medicine and Surgery at BMU?', 'How many years is MBBS?']]
];

const LAW_QUESTIONS = [
    ['What law established BMU?', ['Under what law was Bayelsa Medical University established?']],
    ['What is BMU corporate status under the law?', ['Can BMU sue and be sued?', 'Can BMU own property?']],
    ['Where is BMU main campus under the law?', ['Can BMU establish other campuses?']],
    ['What are the vision and mission of BMU under the law?', ['What type of institution is BMU under the law?']],
    ['What are the powers of BMU under the law?', ['Can BMU award degrees and charge fees under the law?']],
    ['What bodies are part of BMU under Section 5?', ['What are the principal offices listed in BMU Law?']],
    ['What are the functions of the Chancellor and Pro-Chancellor under BMU Law?', ['Who chairs Council meetings under BMU Law?']],
    ['What are the functions of the Vice-Chancellor under BMU Law?', ['Is the Vice-Chancellor Chairman of Senate?']],
    ['What are the functions of Council under BMU Law?', ['Who controls BMU policy, finances and property?']],
    ['What are the functions of Senate under BMU Law?', ['Who controls BMU teaching, admission and examinations?']],
    ['How are BMU statutes made?', ['What majority is needed to make BMU statutes?']],
    ['How can BMU statutes be proved in court?', ['Who can certify a true copy of BMU statutes?']],
    ['Who is the Visitor of BMU under the law?', ['How often should visitation happen at BMU?']],
    ['How can certain Council members be removed under BMU Law?', ['Who removes a BMU Council member?']],
    ['How are BMU staff disciplined or removed under the law?', ['Can the Vice-Chancellor suspend BMU staff?']],
    ['How can a BMU examiner be removed?', ['Who removes examiners under BMU Law?']],
    ['What disciplinary measures can BMU apply to students under the law?', ['Can a BMU student appeal rustication or expulsion?']],
    ['What does BMU Law say about discrimination?', ['Does BMU Law prohibit discrimination?']],
    ['Can BMU dispose of land without Governor consent?', ['What is the 21 year land exception under BMU Law?']],
    ['Who determines quorum and procedure for BMU bodies?', ['How is quorum decided under BMU Law?']],
    ['Can BMU bodies appoint committees with non-members?', ['Can a BMU committee include outsiders?']],
    ['Who authenticates the BMU seal?', ['What does Section 23 say about personal interest?']],
    ['What notice is required before suing BMU?', ['How many months notice before legal action against BMU?']],
    ['What is the retirement age for BMU academic staff?', ['Does the 35 year rule apply to BMU academic staff?']],
    ['What pension provision applies to BMU professors?', ['What does BMU Law say about professor retirement benefits?']],
    ['Who appoints the Vice-Chancellor under BMU Law?', ['How long does the BMU Vice-Chancellor serve?']],
    ['What is the role of the Bursar as chief financial officer under BMU Law?', ['Is the Bursar the Chief Financial Officer?']],
    ['What is the role of the Registrar as chief administrative officer under BMU Law?', ['Is the Registrar secretary to Council and Senate?']],
    ['What is the role of the University Librarian under the First Schedule of BMU Law?', ['Who coordinates BMU library services?']],
    ['Who appoints the Pro-Chancellor under BMU Law?', ['How long is the first term of the Pro-Chancellor?']],
    ['Who appoints the Chancellor under BMU Law?', ['How long does the Chancellor hold office?']]
];

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function normaliseQuestion(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatAnswer(reply) {
    return String(reply?.display_markdown || reply?.speech_text || '').trim();
}

function sourcesFrom(reply, fallbackTitle) {
    const sources = asArray(reply?.citations);
    if (sources.length) return sources;
    return [{ title: fallbackTitle || 'BMU authoritative advisor source', source: reply?.topic_slug || 'authoritative seed' }];
}

function isFeeSeedQuestion(question) {
    return /(fee|fees|tuition|how\s+much|payable)/i.test(String(question || ''));
}

function replyUsesFeeStructure(reply) {
    const hay = `${reply?.display_markdown || ''}\n${reply?.speech_text || ''}\n${JSON.stringify(reply?.citations || [])}`.toLowerCase();
    return /bmu fee structures? new\.docx|official\s+total\s+payable|indigene\s+total\s+payable|non[-\s]?indigene\s+total\s+payable/i.test(hay);
}

async function generateEmbedding(question) {
    if (!EMBEDDINGS_ENABLED) return null;
    try {
        return await getAiService().generateEmbedding(question, true);
    } catch (err) {
        console.warn(`[seedAuthoritativeCache] embedding skipped for "${question.slice(0, 80)}": ${err.message}`);
        return null;
    }
}

async function upsertEntry({ question, variations = [], answer, sources = [], confidence = 0.99 }) {
    const { query } = getDb();
    const cleanQuestion = normaliseQuestion(question);
    const cleanAnswer = String(answer || '').trim();
    if (!cleanQuestion || !cleanAnswer) return { mode: 'skipped' };

    const embedding = await generateEmbedding(cleanQuestion);
    const existing = await query(
        'SELECT id FROM cached_qa WHERE question = ? LIMIT 1',
        [cleanQuestion]
    );

    const params = [
        JSON.stringify(variations.map(normaliseQuestion).filter(Boolean)),
        cleanAnswer,
        JSON.stringify(sources),
        embedding ? JSON.stringify(embedding) : null,
        confidence
    ];

    if (existing.length) {
        const id = existing[0].id;
        await query(
            `UPDATE cached_qa
             SET question_variations = ?,
                 answer = ?,
                 answer_sources = ?,
                 embedding = COALESCE(?, embedding),
                 confidence_score = ?,
                 qa_type = ?,
                 is_verified = 1,
                 verified_at = NOW(),
                 is_active = 1,
                 updated_at = NOW()
             WHERE id = ?`,
            [...params, QA_TYPE, id]
        );
        return { mode: 'refreshed', id };
    }

    const result = await query(
        `INSERT INTO cached_qa
            (document_id, category_id, question, question_variations, answer,
             answer_sources, embedding, confidence_score, qa_type, is_verified,
             verified_at, is_active)
         VALUES
            (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), 1)`,
        [cleanQuestion, ...params, QA_TYPE]
    );
    return { mode: 'created', id: result.insertId };
}

async function addFastIntentQuestion(entries, item, fallbackTitle) {
    const [question, variations = []] = item;
    const staticDiagnosis = advisorStreamService._diagnoseStaticQuestion(question);
    let reply = staticDiagnosis?.staticAnswer
        ? {
            display_markdown: staticDiagnosis.staticAnswer,
            speech_text: staticDiagnosis.staticAnswer.replace(/[*_`|#-]/g, ' ').replace(/\s+/g, ' ').trim(),
            topic_slug: staticDiagnosis.staticTopic,
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            confidence: 0.99
        }
        : null;

    if (!reply) reply = await advisorStreamService._buildFastIntentReply(question);
    if (!reply) reply = bmuLawService.buildLawReply(question);
    if (isFeeSeedQuestion(question) && !replyUsesFeeStructure(reply)) {
        return;
    }
    const answer = formatAnswer(reply);
    if (!answer) {
        console.warn(`[seedAuthoritativeCache] no fast answer for "${question}"`);
        return;
    }
    entries.push({
        question,
        variations,
        answer,
        sources: sourcesFrom(reply, fallbackTitle),
        confidence: Number(reply.confidence || 0.99)
    });
}

function feeQuestions() {
    const entries = [];
    const levels = [
        '100 level',
        '200 Direct Entry',
        '200 level',
        '300 level',
        '400 level',
        '500 level',
        '600 level'
    ];
    for (const programme of PROGRAMMES) {
        entries.push([`What are the fees for ${programme} at BMU?`, [`Show ${programme} fee table`, `How much is ${programme} at BMU?`]]);
        for (const level of levels) {
            for (const category of ['indigene', 'non-indigene']) {
                entries.push([
                    `What is the fee for ${level} ${programme} ${category} at BMU?`,
                    [
                        `How much does ${category} pay for ${programme} ${level}?`,
                        `${programme} ${level} ${category} fees`
                    ]
                ]);
            }
        }
    }
    return entries;
}

async function courseQuestions() {
    const rows = await courseCatalogService.loadCatalog();
    const byProgrammeLevel = new Map();
    for (const row of rows) {
        const key = `${row.programme}|${row.level}`;
        if (!byProgrammeLevel.has(key)) byProgrammeLevel.set(key, row);
    }

    return [...byProgrammeLevel.values()]
        .sort((a, b) => String(a.programme).localeCompare(String(b.programme)) || Number(a.level) - Number(b.level))
        .map(row => {
            const programme = row.programme
                .toLowerCase()
                .replace(/\b\w/g, ch => ch.toUpperCase())
                .replace(/\bAnd\b/g, 'and');
            return [
                `What courses are offered in ${programme} at ${row.level} level student courses?`,
                [
                    `What courses are offered in ${programme} at ${row.level} level?`,
                    `Show ${row.level} level ${programme} courses`,
                    `List ${programme} ${row.level} level courses`
                ]
            ];
        });
}

async function buildEntries() {
    const entries = [];

    for (const item of OFFICER_QUESTIONS) await addFastIntentQuestion(entries, item, 'BMU Brief Institutional Profile (May 2025)');
    for (const item of HANDBOOK_QUESTIONS) await addFastIntentQuestion(entries, item, "Students' Handbook 2026");
    for (const item of GENERAL_QUESTIONS) await addFastIntentQuestion(entries, item, 'BMU authoritative advisor source');
    for (const item of LAW_QUESTIONS) await addFastIntentQuestion(entries, item, 'BMU Law cleaned.docx');
    for (const item of feeQuestions()) await addFastIntentQuestion(entries, item, 'bmu fee structures new.docx');
    for (const item of await courseQuestions()) await addFastIntentQuestion(entries, item, 'student courses.docx');

    const seen = new Set();
    return entries.filter(entry => {
        const key = normaliseQuestion(entry.question).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function deactivateMalformedSeedRows() {
    const { query } = getDb();
    const result = await query(
        `UPDATE cached_qa
         SET is_active = 0,
             updated_at = NOW()
         WHERE qa_type = ?
           AND is_active = 1
           AND (
                question LIKE '% level level %'
                OR (
                    (LOWER(question) LIKE '%fee%' OR LOWER(question) LIKE '%tuition%' OR LOWER(question) LIKE '%how much%')
                    AND (
                        LOWER(answer) LIKE '%bayelsa medical university yenagoa law%'
                        OR LOWER(answer_sources) LIKE '%bmu law%'
                        OR LOWER(answer_sources) LIKE '%bayelsa medical university yenagoa law%'
                    )
                )
           )`,
        [QA_TYPE]
    );
    return Number(result?.affectedRows || 0);
}

async function main() {
    const entries = await buildEntries();
    if (DRY_RUN) {
        const topics = entries.reduce((acc, entry) => {
            const source = entry.sources?.[0]?.title || 'Unknown';
            acc[source] = (acc[source] || 0) + 1;
            return acc;
        }, {});
        console.log(`[seedAuthoritativeCache] dry run: ${entries.length} entries`);
        for (const [source, count] of Object.entries(topics).sort()) {
            console.log(`  ${count} ${source}`);
        }
        process.exit(0);
        return;
    }

    let created = 0;
    let refreshed = 0;
    let skipped = 0;
    const deactivated = await deactivateMalformedSeedRows();

    console.log(`[seedAuthoritativeCache] seeding ${entries.length} authoritative entries...`);

    for (const entry of entries) {
        const result = await upsertEntry(entry);
        if (result.mode === 'created') created += 1;
        else if (result.mode === 'refreshed') refreshed += 1;
        else skipped += 1;
    }

    try {
        const service = getFaqService();
        if (service && typeof service.invalidateEmbeddingsCache === 'function') {
            service.invalidateEmbeddingsCache();
        }
    } catch (_) {}

    console.log(`[seedAuthoritativeCache] done: ${created} created, ${refreshed} refreshed, ${skipped} skipped, ${deactivated} malformed deactivated`);
    getDb().pool.end();
    process.exit(0);
}

main().catch(err => {
    console.error('[seedAuthoritativeCache] failed:', err);
    try { if (db?.pool) db.pool.end(); } catch (_) {}
    process.exit(1);
});
