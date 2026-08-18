const path = require('path');

let mammoth = null;
try { mammoth = require('mammoth'); }
catch (_) { /* optional dependency in some test contexts */ }

const SOURCE_TITLE = 'student courses.docx';
const SOURCE_PATH = path.join(__dirname, '../../sources', SOURCE_TITLE);

let _catalogPromise = null;

const PROGRAMME_ALIASES = [
    ['MEDICAL LABORATORY SCIENCE', /\bmedical\s+laborator(?:y|ies)\s+science\b|\bmedical\s+lab(?:oratory)?\b|\bbmls\b|\bmls\b/i],
    ['HEALTH INFORMATION MANAGEMENT', /\bhealth\s+information\s+management\b|\bhim\b/i],
    ['HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT', /\b(?:health\s+care|healthcare)\s+administration\b|\bhospital\s+management\b/i],
    ['HUMAN NUTRITION & DIETETICS', /\bhuman\s+nutrition\s+(?:and|&)\s+dietetics\b|\bnutrition\s+(?:and|&)\s+dietetics\b|\bdietetics\b/i],
    ['DENTAL TECHNOLOGY', /\bdental\s+technology\b/i],
    ['NURSING SCIENCE', /\bnursing(?:\s+science)?\b|\bbnsc\b/i],
    ['COMMUNITY HEALTH', /\bcommunity\s+health\b/i],
    ['PUBLIC HEALTH', /\bpublic\s+health\b/i],
    ['HUMAN PHYSIOLOGY', /\bhuman\s+physiology\b|\bphysiology\b/i],
    ['HUMAN ANATOMY', /\bhuman\s+anatomy\b|\banatomy\b/i],
    ['COMPUTER SCIENCE', /\bcomputer\s+science\b/i],
    ['HUMAN NUTRITION', /\bhuman\s+nutrition\b/i],
    ['MEDICINE AND SURGERY', /\bmbbs\b|\bmbchb\b|\bmedicine\s+and\s+surgery\b|\bmed\s+and\s+surg\b|\bmedicine\b/i],
    ['DENTISTRY', /\bdentistry\b|\bbds\b|\bbchd\b/i],
    ['PHARMACY', /\bpharmacy\b|\bpharmd\b|\bb\.?\s*pharm\b/i],
    ['OPTOMETRY', /\boptometry\b/i],
    ['PHYSIOTHERAPY', /\bphysiotherapy\b/i],
    ['RADIOGRAPHY', /\bradiography\b/i],
    ['BIOCHEMISTRY', /\bbiochemistry\b/i],
    ['BIOLOGY', /\bbiology\b/i],
    ['CHEMISTRY', /\bchemistry\b/i],
    ['MATHEMATICS', /\bmathematics\b|\bmaths?\b/i],
    ['MICROBIOLOGY', /\bmicrobiology\b/i],
    ['PHYSICS', /\bphysics\b/i],
    ['STATISTICS', /\bstatistics\b/i]
];

function cleanCell(html) {
    return String(html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function normaliseProgramme(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

function detectProgramme(question) {
    const q = String(question || '').trim();
    const match = PROGRAMME_ALIASES.find(([, pattern]) => pattern.test(q));
    return match ? match[0] : null;
}

function detectLevel(question) {
    const match = String(question || '').match(/\b(100|200|300|400|500|600)\s*(?:level|lvl)?\b/i);
    return match ? match[1] : null;
}

function detectSemester(question) {
    const q = String(question || '').toLowerCase();
    if (/\bfirst\s+semester\b|\bsemester\s+1\b|\b1st\s+semester\b/.test(q)) return 'FIRST';
    if (/\bsecond\s+semester\b|\bsemester\s+2\b|\b2nd\s+semester\b/.test(q)) return 'SECOND';
    return null;
}

function isCourseListQuestion(question) {
    const q = String(question || '');
    return /\b(course|courses|curriculum|course\s+list|subjects?)\b/i.test(q)
        && Boolean(detectProgramme(q))
        && Boolean(detectLevel(q));
}

async function loadCatalog() {
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = (async () => {
        if (!mammoth) return [];
        const result = await mammoth.convertToHtml({ path: SOURCE_PATH });
        const rows = [];
        const tableRows = [...String(result.value || '').matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
        for (const rowMatch of tableRows) {
            const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => cleanCell(cell[1]));
            if (cells.length < 9 || !/^\d+$/.test(cells[0])) continue;
            const [sn, faculty, department, programmeCell, courseCode, courseTitle, level, semester, category] = cells;
            if (!courseCode || !courseTitle || !/^\d{3}$/.test(level || '')) continue;
            const programme = normaliseProgramme(programmeCell || department);
            rows.push({
                sn: Number(sn),
                faculty,
                department: normaliseProgramme(department),
                programme,
                courseCode: courseCode.replace(/\s+/g, ' ').trim(),
                courseTitle: courseTitle.replace(/\s+/g, ' ').trim(),
                level,
                semester: normaliseProgramme(semester),
                category: normaliseProgramme(category)
            });
        }
        return rows;
    })().catch(error => {
        _catalogPromise = null;
        console.warn('[courseCatalogService] failed to load student courses:', error.message);
        return [];
    });
    return _catalogPromise;
}

function formatSemester(value) {
    if (value === 'FIRST') return 'First';
    if (value === 'SECOND') return 'Second';
    return value || '';
}

function formatProgramme(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b\w/g, ch => ch.toUpperCase())
        .replace(/\bAnd\b/g, 'and')
        .replace(/\bBmu\b/g, 'BMU');
}

async function buildCourseListReply(question) {
    if (!isCourseListQuestion(question)) return null;
    const programme = detectProgramme(question);
    const level = detectLevel(question);
    const semester = detectSemester(question);
    const rows = (await loadCatalog())
        .filter(row => row.level === level && row.programme === programme && (!semester || row.semester === semester))
        .sort((a, b) => {
            const sem = String(a.semester).localeCompare(String(b.semester));
            return sem || a.sn - b.sn;
        });

    if (!rows.length) return null;

    const tableRows = rows.map(row => `| ${formatSemester(row.semester)} | ${row.courseCode} | ${row.courseTitle} | ${row.category || ''} |`);
    const table = [
        '| Semester | Course code | Course title | Category |',
        '| --- | --- | --- | --- |',
        ...tableRows
    ].join('\n');
    const displayProgramme = formatProgramme(programme);
    const semesterScope = semester ? `, ${formatSemester(semester)} semester` : '';
    const codes = rows.map(row => row.courseCode).join(', ');

    return {
        speech_text: `According to the BMU student courses document, ${level} level ${displayProgramme}${semesterScope} has ${rows.length} listed courses: ${codes}.`,
        display_markdown: `According to **${SOURCE_TITLE}**, **${level} level ${displayProgramme}**${semesterScope} has **${rows.length} listed courses**:\n\n${table}\n\nThis is the BMU-specific student course list. Credit units are not shown in this source table.`,
        topic_slug: 'bmu_student_courses',
        citations: [{ title: SOURCE_TITLE, source: `${displayProgramme} ${level} level course list` }],
        suggested_actions: [],
        follow_up_questions: [
            `Show ${level} level ${displayProgramme} first semester courses`,
            `Show ${level} level ${displayProgramme} second semester courses`
        ],
        needs_escalation: false,
        confidence: 0.99,
        _source: 'student_courses_catalog'
    };
}

module.exports = {
    buildCourseListReply,
    loadCatalog,
    _detectProgramme: detectProgramme,
    _detectLevel: detectLevel
};
