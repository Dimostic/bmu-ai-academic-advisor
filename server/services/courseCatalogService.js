const path = require('path');
const fs = require('fs');

let mammoth = null;
try { mammoth = require('mammoth'); }
catch (_) { /* optional dependency in some test contexts */ }

let XLSX = null;
try { XLSX = require('xlsx'); }
catch (_) { /* optional dependency in some test contexts */ }

let dbQuery = null;
try { ({ query: dbQuery } = require('../../config/db')); }
catch (_) { /* file parsing fallback is enough in script/test contexts */ }

const LEGACY_SOURCE_TITLE = 'student courses.docx';
const UPDATED_SOURCE_TITLE = 'ALL COURSES FOR BMU.xlsx';
const MBBS_SOURCE_TITLE = 'COLLEGE OF MEDICINE BMU PROSPECTUS-new.docx';
const SOURCE_TITLE = LEGACY_SOURCE_TITLE;
const SOURCE_PATH = path.join(__dirname, '../../sources', LEGACY_SOURCE_TITLE);
const MBBS_SOURCE_PATH = path.join(__dirname, '../../sources', MBBS_SOURCE_TITLE);
const UPDATED_SOURCE_CANDIDATES = [
    path.join(__dirname, '../../sources', UPDATED_SOURCE_TITLE),
    path.join(__dirname, '../../', UPDATED_SOURCE_TITLE)
];
const MBBS_PROSPECTUS_COURSE_TABLE_RANGE = { start: 85, end: 106 };

let _catalogPromise = null;

const PROGRAMME_ALIASES = [
    ['MEDICAL LABORATORY SCIENCE', /\bmedical\s+laborator(?:y|ies)\s+science\b|\bmedical\s+lab(?:oratory)?\b|\bmed\s+lab\b|\bbmls\b|\bmls\b/i],
    ['HEALTH INFORMATION MANAGEMENT', /\bhealth\s+information\s+management\b|\bhim\b/i],
    ['HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT', /\b(?:health\s+care|healthcare)\s+administration\b|\bhospital\s+management\b/i],
    ['HUMAN NUTRITION & DIETETICS', /\bhuman\s+nutrition\s+(?:and|&)\s+dietetics\b|\bnutrition\s+(?:and|&)\s+dietetics\b|\bdietetics\b/i],
    ['DENTAL TECHNOLOGY', /\bdental\s+(?:technology|tech)\b/i],
    ['NURSING SCIENCE', /\bnursing(?:\s+science)?\b|\bbnsc\b/i],
    ['COMMUNITY HEALTH', /\bcommunity\s+health\b/i],
    ['PUBLIC HEALTH', /\bpublic\s+health\b/i],
    ['HUMAN PHYSIOLOGY', /\bhuman\s+physiology\b|\bphysiology\b/i],
    ['HUMAN ANATOMY', /\bhuman\s+anatomy\b|\banatomy\b/i],
    ['COMPUTER SCIENCE', /\bcomputer\s+science\b/i],
    ['HUMAN NUTRITION', /\bhuman\s+nutrition\b/i],
    ['MEDICINE AND SURGERY', /\bmbbs\b|\bmbchb\b|\bmedicine\s+and\s+surgery\b|\bmed\s+and\s+surg\b|\bmedicine\b/i],
    ['DENTISTRY', /\bdentistry\b|\bbds\b|\bbchd\b/i],
    ['PHARMACY', /\bpharmacy\b|\bpharm\s*d\b|\bpharmd\b|\bb\.?\s*pharm\b/i],
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

const CATALOG_PROGRAMME_EQUIVALENTS = {
    'COMMUNITY HEALTH': ['COMMUNITY HEALTH', 'COMMUNITY HEALTH SCIENCES'],
    'PHARMACY': ['PHARMACY', 'DOCTOR OF PHARMACY'],
    'RADIOGRAPHY': ['RADIOGRAPHY', 'RADIOGRAPHY & RADIATION SCIENCE'],
    'HUMAN NUTRITION & DIETETICS': ['HUMAN NUTRITION & DIETETICS', 'NUTRITION & DIETETICS'],
    'HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT': [
        'HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT',
        'HEALTH CARE ADMINISTRATION AND HOSPITAL MANAGEMENT'
    ],
    'MEDICAL LABORATORY SCIENCE': ['MEDICAL LABORATORY SCIENCE', 'MEDICAL LABORATORY SCIENCES'],
    'PHYSICS': ['PHYSICS', 'PHYSICS WITH ELECTRONICS']
};

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

function normalizeSemesterValue(value) {
    const text = String(value || '').trim().toUpperCase();
    if (/^1|FIRST|RAIN/.test(text)) return 'FIRST';
    if (/^2|SECOND|HARMATTAN/.test(text)) return 'SECOND';
    return text;
}

function normalizeLevelValue(value) {
    const digits = String(value || '').replace(/[^0-9]/g, '').trim();
    if (/^[1-7]01$/.test(digits)) return `${digits[0]}00`;
    return digits;
}

function detectProgramme(question) {
    const q = String(question || '').trim();
    const match = PROGRAMME_ALIASES.find(([, pattern]) => pattern.test(q));
    return match ? match[0] : null;
}

function detectLevel(question) {
    const match = String(question || '').match(/\b(100|200|300|400|500|600|700)\s*(?:level|lvl|l)?\b/i);
    return match ? match[1] : null;
}

function detectSemester(question) {
    const q = String(question || '').toLowerCase();
    if (/\bfirst\s+semester\b|\bsemester\s+1\b|\b1st\s+semester\b/.test(q)) return 'FIRST';
    if (/\bsecond\s+semester\b|\bsemester\s+2\b|\b2nd\s+semester\b/.test(q)) return 'SECOND';
    return null;
}

function normalizeCourseCode(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function formatCourseCodeDisplay(value) {
    let text = String(value || '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^BMU\s*[-\s]\s*/i, 'BMU-')
        .replace(/BMU-\s+/i, 'BMU-')
        .replace(/-\s+/g, '-');

    text = text.replace(/^(BMU-[A-Z]{2,4})\s*(\d{3}[A-Z]?)$/, '$1 $2');
    text = text.replace(/^([A-Z]{2,4})\s*(\d{3}[A-Z]?)$/, '$1 $2');
    return text;
}

function courseCodeMatchesLookup(rowCode, lookupCode) {
    const rowNormalized = normalizeCourseCode(rowCode);
    const lookupNormalized = normalizeCourseCode(lookupCode);
    if (rowNormalized === lookupNormalized) return true;
    return rowNormalized.replace(/([A-Z]{2,4}\d{3})[A-Z]$/, '$1') === lookupNormalized;
}

function detectCourseCode(question) {
    const blockedPrefixes = new Set([
        'AT', 'FOR', 'THE', 'AND', 'ARE', 'IS', 'IN', 'ON',
        'SHOW', 'WHAT', 'LIST', 'GIVE', 'DO', 'DOES', 'DID',
        'TAKE', 'TAKES'
    ]);
    const matches = String(question || '').toUpperCase().matchAll(/\b((?:BMU[-\s]?)?[A-Z]{2,4})[-\s]?(\d{3})\b/g);
    for (const match of matches) {
        const prefix = String(match[1] || '').replace(/[^A-Z]/g, '');
        if (!blockedPrefixes.has(prefix)) return normalizeCourseCode(match[0]);
    }
    return null;
}

function detectCourseTitlePhrase(question) {
    let q = String(question || '').toLowerCase();
    if (detectCourseCode(q)) return null;
    q = q.replace(/\b(tell me about|what is|who teaches|show me|find|course|courses|subject|subjects|in|for|the|a|an|of|bmu|student)\b/g, ' ');
    q = q.replace(/\b(100|200|300|400|500|600|700)\s*(?:level|lvl|l)?\b/g, ' ');
    q = q.replace(/[^a-z0-9\s&-]/g, ' ').replace(/\s+/g, ' ').trim();
    return q.length >= 4 ? q : null;
}

function isCourseListQuestion(question) {
    const q = String(question || '');
    const hasProgrammeAndLevel = Boolean(detectProgramme(q)) && Boolean(detectLevel(q));
    const asksForCourses = /\b(course|courses|curriculum|course\s+list|subjects?)\b/i.test(q);
    const hasSemester = Boolean(detectSemester(q));
    return hasProgrammeAndLevel && (asksForCourses || hasSemester);
}

async function loadCatalog() {
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = (async () => {
        const dbRows = await loadDbCatalog();
        return dbRows.length ? dbRows : loadSourceCatalog();
    })().catch(error => {
        _catalogPromise = null;
        console.warn('[courseCatalogService] failed to load student courses:', error.message);
        return [];
    });
    return _catalogPromise;
}

async function loadSourceCatalog() {
    const updatedRows = await loadUpdatedExcelCatalog();
    const mbbsRows = await loadMbbsProspectusCatalog();
    const legacyRows = await loadLegacyDocxCatalog();
    const updatedProgrammes = expandProgrammeSet(updatedRows.map(row => row.programme).filter(Boolean));
    return [
        ...updatedRows,
        ...mbbsRows,
        ...legacyRows.filter(row => row.programme !== 'MEDICINE AND SURGERY' && !updatedProgrammes.has(row.programme))
    ];
}

async function loadDbCatalog() {
    if (!dbQuery) return [];
    try {
        const rows = await dbQuery(`
            SELECT
                id, programme, level_label, semester_label, course_code, course_title,
                credit_units, scope_label, source_path, row_json
            FROM academic_courses
            WHERE status = 'active'
            ORDER BY programme, CAST(level_label AS UNSIGNED), semester_label, course_code, id
        `);
        return rows.map(row => {
            let payload = {};
            try { payload = row.row_json ? JSON.parse(row.row_json) : {}; }
            catch (_) { payload = {}; }

            const level = String(row.level_label || payload.level || '').match(/\d{3}/)?.[0] || '';
            return {
                sn: Number(row.id) || 0,
                faculty: payload.faculty || '',
                department: normaliseProgramme(payload.department || row.programme),
                programme: normaliseProgramme(row.programme || payload.programme),
                courseCode: formatCourseCodeDisplay(row.course_code || payload.courseCode),
                courseTitle: String(row.course_title || payload.courseTitle || '').replace(/\s+/g, ' ').trim(),
                creditUnits: row.credit_units != null ? Number(row.credit_units) : payload.creditUnits ?? null,
                level,
                semester: normalizeSemesterValue(row.semester_label || payload.semester),
                category: normaliseProgramme(payload.category || row.scope_label),
                sourceTitle: row.source_path || payload.source || SOURCE_TITLE
            };
        }).filter(row => row.programme && row.courseCode && row.courseTitle && row.level);
    } catch (error) {
        const quietCodes = new Set(['ECONNREFUSED', 'ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_ACCESS_DENIED_ERROR']);
        if (!quietCodes.has(error.code) && !/academic_courses|connect|connection/i.test(error.message || '')) {
            console.warn('[courseCatalogService] failed to read academic_courses:', error.message || error.code);
        }
        return [];
    }
}

async function loadLegacyDocxCatalog() {
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
                courseCode: formatCourseCodeDisplay(courseCode),
                courseTitle: courseTitle.replace(/\s+/g, ' ').trim(),
                creditUnits: null,
                level,
                semester: normalizeSemesterValue(semester),
                category: normaliseProgramme(category),
                sourceTitle: LEGACY_SOURCE_TITLE
            });
        }
        return rows;
}

async function loadUpdatedExcelCatalog() {
    if (!XLSX) return [];
    const sourcePath = UPDATED_SOURCE_CANDIDATES.find(candidate => fs.existsSync(candidate));
    if (!sourcePath) return [];

    const workbook = XLSX.readFile(sourcePath, { cellDates: false });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const records = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    const rows = [];

    for (const record of records) {
        const courseCode = formatCourseCodeDisplay(record.Code);
        const courseTitle = String(record.Name || '').replace(/\s+/g, ' ').trim();
        const level = normalizeLevelValue(record.Level);
        const programme = normaliseProgramme(record.Department);
        if (!courseCode && courseTitle && rows.length) {
            const previous = rows[rows.length - 1];
            const sameScope = previous
                && previous.programme === programme
                && previous.level === level
                && previous.semester === normalizeSemesterValue(record.Semester);
            if (sameScope) previous.courseTitle = `${previous.courseTitle} ${courseTitle}`.replace(/\s+/g, ' ').trim();
            continue;
        }
        if (!courseCode || !courseTitle || !/^\d{3}$/.test(level) || !programme) continue;
        if (/\b(mbbs|medicine\s+and\s+surgery)\b/i.test(programme)) continue;

        const unitMatch = String(record.Units ?? '').match(/\d+(?:\.\d+)?/);
        rows.push({
            sn: Number(record['S/N']) || rows.length + 1,
            faculty: String(record.Faculty || '').replace(/\s+/g, ' ').trim(),
            department: programme,
            programme,
            courseCode,
            courseTitle,
            creditUnits: unitMatch ? Number(unitMatch[0]) : null,
            level,
            semester: normalizeSemesterValue(record.Semester),
            category: normaliseProgramme(record['Course Type']),
            sourceTitle: UPDATED_SOURCE_TITLE
        });
    }

    return rows;
}

async function loadMbbsProspectusCatalog() {
    if (!mammoth || !fs.existsSync(MBBS_SOURCE_PATH)) return [];
    const result = await mammoth.convertToHtml({ path: MBBS_SOURCE_PATH });
    const tables = [...String(result.value || '').matchAll(/<table[\s\S]*?<\/table>/g)].map(match => match[0]);
    const rows = [];

    for (let tableIndex = MBBS_PROSPECTUS_COURSE_TABLE_RANGE.start; tableIndex <= MBBS_PROSPECTUS_COURSE_TABLE_RANGE.end; tableIndex++) {
        const table = tables[tableIndex];
        if (!table) continue;
        const tableRows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(match => match[0]);
        for (const tableRow of tableRows) {
            const cells = [...tableRow.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => cleanCell(cell[1]));
            if (cells.length < 3) continue;
            const [courseCodeRaw, courseTitleRaw, creditUnitsRaw, statusRaw] = cells;
            const courseCode = String(courseCodeRaw || '').replace(/\s+/g, ' ').trim();
            const courseTitle = String(courseTitleRaw || '').replace(/\s+/g, ' ').trim();
            if (!/^[A-Z]{2,4}\s*\d{3}[A-Z]?$/i.test(courseCode) || !courseTitle || /^total$/i.test(courseTitle)) continue;

            const numericCode = courseCode.match(/(\d{3})/)?.[1];
            const creditUnits = String(creditUnitsRaw || '').match(/\d+(?:\.\d+)?/)?.[0];
            rows.push({
                sn: rows.length + 1,
                faculty: 'COLLEGE OF MEDICINE',
                department: 'MEDICINE AND SURGERY',
                programme: 'MEDICINE AND SURGERY',
                courseCode: formatCourseCodeDisplay(courseCode),
                courseTitle,
                creditUnits: creditUnits ? Number(creditUnits) : null,
                level: numericCode ? `${numericCode[0]}00` : '',
                semester: numericCode && Number(numericCode) % 2 === 0 ? 'SECOND' : 'FIRST',
                category: normaliseProgramme(statusRaw || 'CORE'),
                sourceTitle: MBBS_SOURCE_TITLE
            });
        }
    }

    return rows;
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
        .replace(/\bOf\b/g, 'of')
        .replace(/\bWith\b/g, 'with')
        .replace(/\bBmu\b/g, 'BMU');
}

function displayProgrammeFromRows(rows, fallbackProgramme) {
    const names = [...new Set((rows || []).map(row => row.programme).filter(Boolean))];
    if (names.length === 1) return formatProgramme(names[0]);
    return formatProgramme(fallbackProgramme || names[0] || '');
}

function programmeKeysFor(programme) {
    return CATALOG_PROGRAMME_EQUIVALENTS[programme] || [programme];
}

function expandProgrammeSet(programmes) {
    const expanded = new Set();
    for (const programme of programmes) {
        expanded.add(programme);
        for (const [key, values] of Object.entries(CATALOG_PROGRAMME_EQUIVALENTS)) {
            if (key === programme || values.includes(programme)) {
                expanded.add(key);
                values.forEach(value => expanded.add(value));
            }
        }
    }
    return expanded;
}

function rowProgrammeMatches(row, programme) {
    if (!programme) return true;
    return programmeKeysFor(programme).includes(row.programme);
}

function formatCourseRowsTable(rows) {
    return [
        '| Programme | Level | Semester | Course code | Course title | Units | Category | Source |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map(row => `| ${formatProgramme(row.programme)} | ${row.level} | ${formatSemester(row.semester)} | ${row.courseCode} | ${row.courseTitle} | ${row.creditUnits ?? ''} | ${row.category || ''} | ${row.sourceTitle || SOURCE_TITLE} |`)
    ].join('\n');
}

function normalizeCourseTitle(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(i|ii|iii|iv|v)\b/g, match => match.toUpperCase())
        .replace(/\s+/g, ' ')
        .trim();
}

function mergeCourseRowsForDisplay(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.semester || ''}|${normalizeCourseCode(row.courseCode)}|${normalizeCourseTitle(row.courseTitle)}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                ...row,
                categories: new Set(row.category ? [row.category] : []),
                sourceCount: 1
            });
            continue;
        }

        const existing = grouped.get(key);
        if (row.category) existing.categories.add(row.category);
        existing.sourceCount++;
    }

    return [...grouped.values()].map(row => {
        const categories = [...row.categories].filter(Boolean).sort();
        return {
            ...row,
            category: categories.join('/'),
            duplicateCount: row.sourceCount
        };
    });
}

function formatCourseListTable(rows) {
    const tableRows = rows.map(row => {
        const note = row.duplicateCount > 1 && row.category
            ? `${row.category}; repeated ${row.duplicateCount}x`
            : row.category || '';
        return `| ${formatSemester(row.semester)} | ${row.courseCode} | ${row.courseTitle} | ${row.creditUnits ?? ''} | ${note} |`;
    });
    return [
        '| Semester | Course code | Course title | Units | Note |',
        '| --- | --- | --- | --- | --- |',
        ...tableRows
    ].join('\n');
}

function formatCourseRowSpeech(row) {
    const bits = [
        `${row.courseCode}, ${row.courseTitle}`,
        `${formatProgramme(row.programme)}`,
        `${row.level} level`,
        `${formatSemester(row.semester).toLowerCase()} semester`
    ];
    if (row.creditUnits) {
        bits.push(`${row.creditUnits} unit${Number(row.creditUnits) === 1 ? '' : 's'}`);
    }
    return bits.join(', ');
}

function summarizeCourseCodes(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.semester || ''}|${normalizeCourseCode(row.courseCode)}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                courseCode: row.courseCode,
                titles: new Set(),
                semester: row.semester
            });
        }
        grouped.get(key).titles.add(normalizeCourseTitle(row.courseTitle));
    }

    return [...grouped.values()]
        .map(item => item.titles.size > 1 ? `${item.courseCode} (${item.titles.size} title variants)` : item.courseCode)
        .join(', ');
}

function findCourseCodeTitleConflicts(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.semester || ''}|${normalizeCourseCode(row.courseCode)}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                courseCode: row.courseCode,
                semester: row.semester,
                titles: new Map()
            });
        }
        const titleKey = normalizeCourseTitle(row.courseTitle);
        if (titleKey) grouped.get(key).titles.set(titleKey, row.courseTitle);
    }

    return [...grouped.values()]
        .filter(item => item.titles.size > 1)
        .map(item => ({
            courseCode: item.courseCode,
            semester: item.semester,
            titles: [...item.titles.values()]
        }));
}

function formatConflictNote(conflicts) {
    if (!conflicts.length) return '';
    const items = conflicts.slice(0, 8).map(item => {
        const semester = item.semester ? `${formatSemester(item.semester)} semester ` : '';
        return `- ${semester}${item.courseCode}: ${item.titles.join(' / ')}`;
    }).join('\n');
    const more = conflicts.length > 8 ? `\n- ${conflicts.length - 8} more code(s) with title variants` : '';
    return `\n\n**Source data note:** Some course codes have different titles in the BMU course catalogue. I have kept those variants visible rather than merging them:\n\n${items}${more}`;
}

function nearbyCourseSuggestions(rows, normalizedCode, programme) {
    const prefix = String(normalizedCode || '').replace(/\d+$/, '');
    return rows
        .filter(row => rowProgrammeMatches(row, programme) && normalizeCourseCode(row.courseCode).startsWith(prefix))
        .sort((a, b) => a.sn - b.sn)
        .slice(0, 6)
        .map(row => `${row.courseCode} - ${row.courseTitle}`);
}

async function buildCourseLookupReply(question) {
    const q = String(question || '');
    const programme = detectProgramme(q);
    const level = detectLevel(q);
    const semester = detectSemester(q);
    const courseCode = detectCourseCode(q);
    const titlePhrase = detectCourseTitlePhrase(q);
    const isLikelyCourseLookup = /\b(course|subject|unit|units|credit|semester|level|what is|tell me about|show|find)\b/i.test(q);

    if (!courseCode && !titlePhrase) return null;
    if (!isLikelyCourseLookup && !programme && !level) return null;

    const catalog = await loadCatalog();
    let rows = [];
    if (courseCode) {
        rows = catalog.filter(row => courseCodeMatchesLookup(row.courseCode, courseCode));
    } else if (titlePhrase) {
        const terms = titlePhrase.split(/\s+/).filter(term => term.length > 2);
        if (terms.length < 1) return null;
        rows = catalog.filter(row => {
            const haystack = `${row.courseTitle} ${row.courseCode}`.toLowerCase();
            return terms.every(term => haystack.includes(term));
        });
    }

    rows = rows
        .filter(row => rowProgrammeMatches(row, programme))
        .filter(row => !level || row.level === level)
        .filter(row => !semester || row.semester === semester)
        .sort((a, b) => {
            const programmeOrder = String(a.programme).localeCompare(String(b.programme));
            const levelOrder = Number(a.level) - Number(b.level);
            const semOrder = String(a.semester).localeCompare(String(b.semester));
            return programmeOrder || levelOrder || semOrder || a.sn - b.sn;
        });

    if (!rows.length && courseCode) {
        const suggestions = nearbyCourseSuggestions(catalog, courseCode, programme);
        const programmeScope = programme ? ` for **${formatProgramme(programme)}**` : '';
        const suggestionText = suggestions.length
            ? `\n\nNearby course codes in the BMU source include:\n\n${suggestions.map(item => `- ${item}`).join('\n')}`
            : '';
        return {
            speech_text: `I checked the BMU course catalogue. It does not list ${q.match(/\b(?:BMU[-\s]?)?[A-Z]{2,4}[-\s]?\d{3}\b/i)?.[0] || courseCode}${programme ? ` for ${formatProgramme(programme)}` : ''}.`,
            display_markdown: `I checked the **BMU course catalogue**. It does **not** list **${q.match(/\b(?:BMU[-\s]?)?[A-Z]{2,4}[-\s]?\d{3}\b/i)?.[0] || courseCode}**${programmeScope}.\n\nBecause this is a BMU-specific course question, I should not present a CCMAS-only course code as BMU's exact course list unless you ask for national CCMAS guidance.${suggestionText}`,
            topic_slug: 'bmu_student_course_not_listed',
            citations: [{ title: 'BMU course catalogue', source: 'BMU course catalogue' }],
            suggested_actions: [],
            follow_up_questions: suggestions.slice(0, 2).map(item => `Tell me about ${item.split(' - ')[0]}`),
            needs_escalation: false,
            confidence: 0.95,
            _source: 'student_courses_catalog'
        };
    }

    if (!rows.length) return null;

    const visibleRows = rows.slice(0, 12);
    const table = formatCourseRowsTable(visibleRows);
    const first = rows[0];
    const sourceTitles = [...new Set(rows.map(row => row.sourceTitle || SOURCE_TITLE).filter(Boolean))];
    const sourceTitle = sourceTitles.length === 1 ? sourceTitles[0] : 'BMU course catalogue';
    const scope = rows.length === 1
        ? `${first.courseCode}, ${first.courseTitle}, is listed for ${formatProgramme(first.programme)} at ${first.level} level, ${formatSemester(first.semester).toLowerCase()} semester${first.creditUnits ? `, with ${first.creditUnits} unit${Number(first.creditUnits) === 1 ? '' : 's'}` : ''}.`
        : `I found ${rows.length} matching BMU course entries: ${rows.slice(0, 6).map(formatCourseRowSpeech).join('; ')}${rows.length > 6 ? '; and more' : ''}.`;

    return {
        speech_text: `According to ${sourceTitle}, ${scope}${rows.some(row => row.creditUnits) ? '' : ' Credit units are not shown in that source table.'}`,
        display_markdown: `According to **${sourceTitle}**, I found **${rows.length} matching BMU course entr${rows.length === 1 ? 'y' : 'ies'}**:\n\n${table}${rows.length > visibleRows.length ? `\n\nShowing the first ${visibleRows.length} matches.` : ''}\n\nThis is the BMU-specific student course list.${rows.some(row => row.creditUnits) ? '' : ' **Credit units are not shown** in this source table; CCMAS can be used only as national-minimum context where BMU-specific units are not available.'}`,
        topic_slug: 'bmu_student_course_lookup',
        citations: sourceTitles.map(title => ({ title, source: 'BMU student course catalogue' })),
        suggested_actions: [],
        follow_up_questions: [
            first ? `Show ${first.level} level ${formatProgramme(first.programme)} courses` : null,
            first ? `Show ${first.level} level ${formatProgramme(first.programme)} ${formatSemester(first.semester).toLowerCase()} semester courses` : null
        ].filter(Boolean),
        needs_escalation: false,
        confidence: 0.98,
        _source: 'student_courses_catalog'
    };
}

async function buildCourseListReply(question) {
    const lookupReply = await buildCourseLookupReply(question);
    if (lookupReply) return lookupReply;

    if (!isCourseListQuestion(question)) return null;
    const programme = detectProgramme(question);
    const level = detectLevel(question);
    const semester = detectSemester(question);
    const programmeKeys = programmeKeysFor(programme);
    const allProgrammeRows = (await loadCatalog())
        .filter(row => programmeKeys.includes(row.programme));
    const rows = (await loadCatalog())
        .filter(row => row.level === level && programmeKeys.includes(row.programme) && (!semester || row.semester === semester))
        .sort((a, b) => {
            const sem = String(a.semester).localeCompare(String(b.semester));
            return sem || a.sn - b.sn;
        });

    const displayProgramme = displayProgrammeFromRows(allProgrammeRows, programme);
    const semesterScope = semester ? `, ${formatSemester(semester)} semester` : '';

    if (!rows.length && allProgrammeRows.length) {
        const availableLevels = [...new Set(allProgrammeRows.map(row => row.level))]
            .sort((a, b) => Number(a) - Number(b));
        return {
            speech_text: `I checked the BMU course catalogue. It does not show ${level} level ${displayProgramme}${semesterScope} courses. The available levels in that source are ${availableLevels.join(', ')} level.`,
            display_markdown: `I checked the **BMU course catalogue**. It does **not** show courses for **${level} level ${displayProgramme}**${semesterScope}.\n\nAvailable level(s) for **${displayProgramme}** in that BMU source: **${availableLevels.map(item => `${item} level`).join(', ')}**.\n\nI should not substitute CCMAS/general curriculum data as BMU's exact student course list unless you ask for national CCMAS guidance separately.`,
            topic_slug: 'bmu_student_courses_not_listed',
            citations: [{ title: 'BMU course catalogue', source: `${displayProgramme} course list availability` }],
            suggested_actions: [],
            follow_up_questions: availableLevels.slice(0, 2).map(item => `Show ${item} level ${displayProgramme} courses`),
            needs_escalation: false,
            confidence: 0.94,
            _source: 'student_courses_catalog'
        };
    }

    if (!rows.length) return null;

    const displayRows = mergeCourseRowsForDisplay(rows);
    const displayProgrammeFromMatches = displayProgrammeFromRows(rows, programme);
    const table = formatCourseListTable(displayRows);
    const codes = summarizeCourseCodes(displayRows);
    const conflicts = findCourseCodeTitleConflicts(displayRows);
    const sourceTitles = [...new Set(displayRows.map(row => row.sourceTitle || SOURCE_TITLE).filter(Boolean))];
    const sourceTitle = sourceTitles.length === 1 ? sourceTitles[0] : 'BMU course catalogue';
    const conflictSpeech = conflicts.length
        ? ` ${conflicts.length} course code${conflicts.length === 1 ? ' has' : 's have'} different title variants in the source, so I kept those variants visible.`
        : '';
    const conflictNote = formatConflictNote(conflicts);
    const groupedNote = displayRows.length < rows.length
        ? ` I grouped ${rows.length} source rows into ${displayRows.length} displayed course entries where BMAS/CCMAS rows repeated the same course code and title.`
        : '';

    return {
        speech_text: `According to ${sourceTitle}, ${level} level ${displayProgrammeFromMatches}${semesterScope} has ${displayRows.length} displayed course entries: ${codes}.${groupedNote}${conflictSpeech}`,
        display_markdown: `According to **${sourceTitle}**, **${level} level ${displayProgrammeFromMatches}**${semesterScope} has **${displayRows.length} displayed course entries**.${groupedNote}\n\n${table}${conflictNote}\n\nThis is the BMU-specific student course list.${displayRows.some(row => row.creditUnits) ? '' : ' Credit units are not shown in this source table.'}`,
        topic_slug: 'bmu_student_courses',
        citations: sourceTitles.map(title => ({ title, source: `${displayProgramme} ${level} level course list` })),
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
    buildCourseLookupReply,
    loadCatalog,
    loadSourceCatalog,
    _detectProgramme: detectProgramme,
    _detectLevel: detectLevel,
    _detectCourseCode: detectCourseCode
};
