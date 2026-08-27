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

const crypto = require('crypto');
const path = require('path');
const mammoth = require('mammoth');
const advisorStreamService = require('../services/advisorStreamService');
const courseCatalogService = require('../services/courseCatalogService');
const bmuLawService = require('../services/bmuLawService');
const documentLabService = require('../services/documentLabService');

const EMBEDDINGS_ENABLED = process.env.SEED_AUTHORITATIVE_EMBEDDINGS !== 'false';
const QA_TYPE = 'authoritative_seed';
const DRY_RUN = process.argv.includes('--dry-run');
const STRUCTURED_ONLY = process.argv.includes('--structured-only');

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
    'Community Health Science',
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
    ['Who is the University Librarian of BMU?', ['Name the current University Librarian of Bayelsa Medical University', 'Who is the Liberian of BMU?', 'Who is the Librian of BMU?', 'Who is the head of library at BMU?', 'Who is the BMU library officer?']],
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
    ['What is the role of the University Librarian under the First Schedule of BMU Law?', ['Who coordinates BMU library services?', 'What does the BMU Liberian do?', 'What is the role of the head of library under BMU Law?']],
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

function recordHash(parts) {
    return crypto
        .createHash('sha1')
        .update(parts.map(part => String(part ?? '').trim().toLowerCase()).join('|'))
        .digest('hex');
}

function amountValue(label) {
    const numeric = String(label || '').replace(/[^\d.]/g, '');
    const value = Number(numeric);
    return Number.isFinite(value) ? value : null;
}

function normaliseLevelLabel(value) {
    const raw = String(value || '').trim();
    return /^\d+$/.test(raw) ? `${raw} level` : raw;
}

function normaliseSemesterLabel(value) {
    const raw = String(value || '').trim();
    if (/^first$/i.test(raw)) return 'First semester';
    if (/^second$/i.test(raw)) return 'Second semester';
    return raw;
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

async function upsertStructuredFact({ factType, subject, predicateName, value, humanText, authorityType, scopeLabel, sourcePath, authorityRank = 90 }) {
    const { query } = getDb();
    const existing = await query(
        `SELECT id FROM structured_facts
         WHERE fact_type = ?
           AND subject = ?
           AND predicate_name = ?
           AND source_path = ?
         LIMIT 1`,
        [factType, subject, predicateName, sourcePath]
    );

    const params = [
        JSON.stringify(value ?? {}),
        humanText,
        authorityType,
        scopeLabel,
        sourcePath,
        authorityRank
    ];

    if (existing.length) {
        await query(
            `UPDATE structured_facts
             SET value_json = ?,
                 human_text = ?,
                 authority_type = ?,
                 scope_label = ?,
                 source_path = ?,
                 status = 'active',
                 currentness_label = 'current',
                 authority_rank = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [...params, existing[0].id]
        );
        return 'refreshed';
    }

    await query(
        `INSERT INTO structured_facts
            (fact_type, subject, predicate_name, value_json, human_text,
             authority_type, scope_label, source_path, status, currentness_label, authority_rank)
         VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'current', ?)`,
        [factType, subject, predicateName, ...params]
    );
    return 'created';
}

async function upsertAcademicOfficer({ office, officerName, note = '', sourcePath = 'BMU Brief Institutional Profile (May 2025)' }) {
    const { query } = getDb();
    const rawText = note
        ? `${office}: ${officerName} (${note}).`
        : `${office}: ${officerName}.`;
    const row = {
        office,
        officer_name: officerName,
        note
    };
    const updated = await query(
        `UPDATE academic_officers
         SET officer_name = ?,
             authority_type = 'institution',
             scope_label = 'BMU current principal officers',
             source_path = ?,
             raw_text = ?,
             row_json = ?,
             status = 'active',
             updated_at = NOW()
         WHERE office = ?`,
        [officerName, sourcePath, rawText, JSON.stringify(row), office]
    );
    if (Number(updated?.affectedRows || 0)) return;

    const hash = recordHash(['academic_officers', office, officerName, sourcePath]);
    await query(
        `INSERT INTO academic_officers
            (record_hash, office, officer_name, authority_type, scope_label, source_path, raw_text, row_json, status)
         VALUES
            (?, ?, ?, 'institution', 'BMU current principal officers', ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
            officer_name = VALUES(officer_name),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active',
            updated_at = NOW()`,
        [hash, office, officerName, sourcePath, rawText, JSON.stringify(row)]
    );
}

async function upsertAcademicFee({ programme, levelKey, studentCategory, amount, table, sourcePath = 'bmu fee structures new.docx' }) {
    const { query } = getDb();
    const levelLabel = levelKey === '200_de' ? '200 Direct Entry' : `${levelKey} level`;
    const rawText = `${programme} ${levelLabel} ${studentCategory} official total payable: N${amount}.`;
    const row = {
        programme,
        level: levelLabel,
        student_category: studentCategory,
        amount_label: `N${amount}`,
        table
    };
    const hash = recordHash(['academic_fees', programme, levelLabel, studentCategory, amount, sourcePath]);
    await query(
        `INSERT INTO academic_fees
            (record_hash, programme, fee_category, amount_label, amount_value, session_label,
             student_category, authority_type, scope_label, source_path, raw_text, row_json, status)
         VALUES
            (?, ?, 'official_total_payable', ?, ?, NULL, ?, 'institution', ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
            programme = VALUES(programme),
            fee_category = VALUES(fee_category),
            amount_label = VALUES(amount_label),
            amount_value = VALUES(amount_value),
            student_category = VALUES(student_category),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active',
            updated_at = NOW()`,
        [hash, programme, `N${amount}`, amountValue(amount), studentCategory, table, sourcePath, rawText, JSON.stringify(row)]
    );
}

async function upsertAcademicProgramme({ programme, faculty = '', department = '', degree = '', durationYears = null, entryMode = '', sourcePath = 'BMU structured seed', rawText = '' }) {
    const { query } = getDb();
    const row = { programme, faculty, department, degree, durationYears, entryMode };
    const hash = recordHash(['academic_programmes', programme, faculty, department, degree, durationYears, entryMode, sourcePath]);
    await query(
        `INSERT INTO academic_programmes
            (record_hash, programme, faculty, department, degree, duration_years, entry_mode,
             authority_type, scope_label, source_path, raw_text, row_json, status)
         VALUES
            (?, ?, ?, ?, ?, ?, ?, 'institution', 'BMU programme catalogue', ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
            programme = VALUES(programme),
            faculty = VALUES(faculty),
            department = VALUES(department),
            degree = VALUES(degree),
            duration_years = VALUES(duration_years),
            entry_mode = VALUES(entry_mode),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active',
            updated_at = NOW()`,
        [hash, programme, faculty || null, department || null, degree || null, durationYears, entryMode || null, sourcePath, rawText || `${programme} is listed in the BMU programme/course sources.`, JSON.stringify(row)]
    );
}

async function upsertAcademicCourse(row) {
    const { query } = getDb();
    const programme = row.programmeDisplay || row.programme || '';
    const levelLabel = normaliseLevelLabel(row.level);
    const semesterLabel = normaliseSemesterLabel(row.semester);
    const courseCode = row.courseCode || '';
    const courseTitle = row.courseTitle || '';
    const sourcePath = row.sourceTitle || 'BMU course catalogue';
    const rawText = `${courseCode ? `${courseCode}: ` : ''}${courseTitle}${programme ? ` (${programme}` : ''}${levelLabel ? `, ${levelLabel}` : ''}${semesterLabel ? `, ${semesterLabel}` : ''}${programme ? ')' : ''}.`;
    const payload = {
        programme,
        level_label: levelLabel,
        semester_label: semesterLabel,
        course_code: courseCode,
        course_title: courseTitle,
        credit_units: row.creditUnits ?? null,
        source_path: sourcePath
    };
    const hash = recordHash(['academic_courses', programme, levelLabel, semesterLabel, courseCode, courseTitle, row.creditUnits, sourcePath]);
    await query(
        `INSERT INTO academic_courses
            (record_hash, programme, level_label, semester_label, course_code, course_title, credit_units,
             authority_type, scope_label, source_path, raw_text, row_json, status)
         VALUES
            (?, ?, ?, ?, ?, ?, ?, 'institution', 'BMU course catalogue', ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
            programme = VALUES(programme),
            level_label = VALUES(level_label),
            semester_label = VALUES(semester_label),
            course_code = VALUES(course_code),
            course_title = VALUES(course_title),
            credit_units = VALUES(credit_units),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active',
            updated_at = NOW()`,
        [hash, programme || null, levelLabel || null, semesterLabel || null, courseCode || null, courseTitle || null, row.creditUnits ?? null, sourcePath, rawText, JSON.stringify(payload)]
    );
}

async function upsertCalendarEvent({ title, dateLabel, semesterLabel, sessionLabel = '2025/2026', sourcePath = 'ACADEMIC CALENDAR 2025_2026.docx' }) {
    const { query } = getDb();
    const rawText = `${semesterLabel ? `${semesterLabel}: ` : ''}${title}${dateLabel ? ` - ${dateLabel}` : ''}.`;
    const payload = { event_title: title, event_date_label: dateLabel, semester_label: semesterLabel, session_label: sessionLabel };
    const hash = recordHash(['academic_calendar_events', title, dateLabel, semesterLabel, sessionLabel, sourcePath]);
    await query(
        `INSERT INTO academic_calendar_events
            (record_hash, event_title, event_date_label, session_label, authority_type,
             scope_label, source_path, raw_text, row_json, status)
         VALUES
            (?, ?, ?, ?, 'institution', 'BMU academic calendar', ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
            event_title = VALUES(event_title),
            event_date_label = VALUES(event_date_label),
            session_label = VALUES(session_label),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active',
            updated_at = NOW()`,
        [hash, title, dateLabel || null, sessionLabel, sourcePath, rawText, JSON.stringify(payload)]
    );
}

async function seedAcademicCoursesAndProgrammes() {
    const rows = await courseCatalogService.loadCatalog();
    let programmes = 0;
    const programmeMap = new Map();

    for (const row of rows) {
        const programme = row.programmeDisplay || row.programme;
        if (programme && !programmeMap.has(String(programme).toLowerCase())) {
            programmeMap.set(String(programme).toLowerCase(), {
                programme,
                sourcePath: row.sourceTitle || 'BMU course catalogue',
                rawText: `${programme} appears in ${row.sourceTitle || 'the BMU course catalogue'}.`
            });
        }
    }

    const staticFacts = advisorStreamService._staticFacts || {};
    for (const fee of Object.values(staticFacts.PROGRAMME_FEES || {})) {
        const programme = fee.display;
        if (programme && !programmeMap.has(String(programme).toLowerCase())) {
            programmeMap.set(String(programme).toLowerCase(), {
                programme,
                sourcePath: 'bmu fee structures new.docx',
                rawText: `${programme} appears in the BMU fee structure.`
            });
        }
    }

    for (const programme of programmeMap.values()) {
        await upsertAcademicProgramme(programme);
        programmes += 1;
    }

    return { courseRowsRead: rows.length, programmes };
}

async function seedAcademicCalendar() {
    const filePath = path.join(__dirname, '../../sources/ACADEMIC CALENDAR 2025_2026.docx');
    let text = '';
    try {
        const result = await mammoth.extractRawText({ path: filePath });
        text = String(result.value || '');
    } catch (err) {
        console.warn('[seedAuthoritativeCache] calendar extraction skipped:', err.message);
        return { calendarEvents: 0 };
    }

    const relevant = text.split(/First Semester highlights/i)[0] || text;
    const lines = relevant
        .split(/\r?\n/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter(line => !/^(bayelsa medical university|imgbi road|academic calendar|s\/n|activities|dates)$/i.test(line));

    let semester = '';
    let pendingTitle = '';
    let calendarEvents = 0;
    const dateStart = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

    for (const line of lines) {
        if (/^first semester$/i.test(line)) {
            semester = 'First semester';
            pendingTitle = '';
            continue;
        }
        if (/^second semester$/i.test(line)) {
            semester = 'Second semester';
            pendingTitle = '';
            continue;
        }
        if (!semester) continue;
        if (dateStart.test(line)) {
            if (pendingTitle) {
                await upsertCalendarEvent({ title: pendingTitle, dateLabel: line, semesterLabel: semester });
                calendarEvents += 1;
                pendingTitle = '';
            }
            continue;
        }
        if (/^\d+$/.test(line)) continue;
        pendingTitle = pendingTitle ? `${pendingTitle} ${line}` : line;
    }

    return { calendarEvents };
}

async function seedStructuredAuthorityRecords() {
    await documentLabService.ensureSchema();

    let factsCreated = 0;
    let factsRefreshed = 0;
    let officers = 0;
    let fees = 0;
    const staticFacts = advisorStreamService._staticFacts || {};

    for (const officer of asArray(staticFacts.BMU_PRINCIPAL_OFFICERS)) {
        const humanText = officer.note
            ? `${officer.position}: ${officer.name} (${officer.note}).`
            : `${officer.position}: ${officer.name}.`;
        const mode = await upsertStructuredFact({
            factType: 'principal_officer',
            subject: officer.position,
            predicateName: 'office_holder',
            value: {
                office: officer.position,
                officer_name: officer.name,
                note: officer.note || '',
                aliases: officer.aliases || []
            },
            humanText,
            authorityType: 'institution',
            scopeLabel: 'BMU current principal officers',
            sourcePath: 'BMU Brief Institutional Profile (May 2025)',
            authorityRank: 95
        });
        if (mode === 'created') factsCreated += 1; else factsRefreshed += 1;
        await upsertAcademicOfficer({ office: officer.position, officerName: officer.name, note: officer.note });
        officers += 1;
    }

    if (staticFacts.BMU_VISITOR) {
        const visitor = staticFacts.BMU_VISITOR;
        const mode = await upsertStructuredFact({
            factType: 'principal_officer',
            subject: visitor.role,
            predicateName: 'office_holder',
            value: visitor,
            humanText: `${visitor.role}: ${visitor.name}, ${visitor.office}.`,
            authorityType: 'institution',
            scopeLabel: 'BMU current principal officers',
            sourcePath: 'BMU Brief Institutional Profile (May 2025)',
            authorityRank: 95
        });
        if (mode === 'created') factsCreated += 1; else factsRefreshed += 1;
        await upsertAcademicOfficer({ office: visitor.role, officerName: visitor.name, note: visitor.office });
        officers += 1;
    }

    for (const fee of Object.values(staticFacts.PROGRAMME_FEES || {})) {
        for (const [levelKey, amount] of Object.entries(fee.indigene || {})) {
            await upsertAcademicFee({
                programme: fee.display,
                levelKey,
                studentCategory: 'indigene',
                amount,
                table: fee.table
            });
            fees += 1;
        }
        for (const [levelKey, amount] of Object.entries(fee.non_indigene || {})) {
            await upsertAcademicFee({
                programme: fee.display,
                levelKey,
                studentCategory: 'non-indigene',
                amount,
                table: fee.table
            });
            fees += 1;
        }
    }

    const academic = await seedAcademicCoursesAndProgrammes();
    const calendar = await seedAcademicCalendar();

    return {
        factsCreated,
        factsRefreshed,
        officers,
        fees,
        programmes: academic.programmes,
        courseRowsRead: academic.courseRowsRead,
        calendarEvents: calendar.calendarEvents
    };
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
    if (STRUCTURED_ONLY) {
        const structured = await seedStructuredAuthorityRecords();
        console.log(`[seedAuthoritativeCache] structured-only: ${structured.factsCreated} facts created, ${structured.factsRefreshed} facts refreshed, ${structured.officers} officers, ${structured.fees} fees, ${structured.programmes} programmes, ${structured.courseRowsRead} course catalogue rows read, ${structured.calendarEvents} calendar events upserted`);
        getDb().pool.end();
        process.exit(0);
        return;
    }

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
    const structured = await seedStructuredAuthorityRecords();

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
    console.log(`[seedAuthoritativeCache] structured: ${structured.factsCreated} facts created, ${structured.factsRefreshed} facts refreshed, ${structured.officers} officers, ${structured.fees} fees, ${structured.programmes} programmes, ${structured.courseRowsRead} course catalogue rows read, ${structured.calendarEvents} calendar events upserted`);
    getDb().pool.end();
    process.exit(0);
}

main().catch(err => {
    console.error('[seedAuthoritativeCache] failed:', err);
    try { if (db?.pool) db.pool.end(); } catch (_) {}
    process.exit(1);
});
