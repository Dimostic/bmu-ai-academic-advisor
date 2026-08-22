const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Import routes
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');
const documentRoutes = require('./routes/documentRoutes');
const documentLabRoutes = require('./routes/documentLabRoutes');
const exportRoutes = require('./routes/exportRoutes');
const adminRoutes = require('./routes/adminRoutes');
const ragRoutes = require('./routes/ragRoutes');
const faqRoutes = require('./routes/faqRoutes');
const vcReportRoutes = require('./routes/vcReportRoutes');
const vcDocumentRoutes = require('./routes/vcDocumentRoutes');
const advisorRoutes = require('./routes/advisorRoutes');
const { authenticateToken, requireAdmin } = require('./middleware/auth');
const { uploadDocument, handleUploadError } = require('./middleware/upload');

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCES_DIR = path.join(__dirname, '../sources');
const CALENDAR_OVERRIDES_FILE = path.join(SOURCES_DIR, 'academic-calendar-overrides.json');

const EMPTY_CALENDAR_CONFIG = {
    version: 2,
    customEntries: [],
    editedDocumentEntries: {},
    deletedDocumentEntryIds: [],
    hideDocumentEntries: false,
    sessionLabel: ''
};

function buildPublicationRecord(name, stat) {
    const ext = path.extname(name).slice(1).toLowerCase();
    const previewable = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
    const normalized = name.toLowerCase();
    const yearMatches = normalized.match(/20\d{2}/g) || [];
    const newestYear = yearMatches.length ? Number(yearMatches[yearMatches.length - 1]) : 0;

    return {
        name,
        ext,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        previewable,
        newestYear,
        viewUrl: `/api/publications/file?name=${encodeURIComponent(name)}`,
        downloadUrl: `/api/publications/file?name=${encodeURIComponent(name)}&download=1`
    };
}

function makeStableEntryId(prefix, activity, startDate, endDate) {
    const raw = `${prefix}|${activity}|${startDate}|${endDate || ''}`;
    return Buffer.from(raw, 'utf8').toString('base64').replace(/[+/=]/g, '').slice(0, 20);
}

function inferSemester(activity, startDateIso) {
    const text = String(activity || '').toLowerCase();
    if (/second\s+semester/.test(text)) return 'second';
    if (/first\s+semester/.test(text)) return 'first';

    const start = new Date(startDateIso);
    if (Number.isNaN(start.getTime())) return 'first';
    const month = start.getMonth() + 1;
    return (month >= 10 || month <= 3) ? 'first' : 'second';
}

function formatShortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function validateSemester(value) {
    const normalized = String(value || '').toLowerCase().trim();
    if (normalized === 'first' || normalized === 'second') return normalized;
    return null;
}

async function readCalendarOverrides() {
    try {
        const raw = await fs.promises.readFile(CALENDAR_OVERRIDES_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        // Backward compatible with earlier array-only storage.
        if (Array.isArray(parsed)) {
            return {
                ...EMPTY_CALENDAR_CONFIG,
                customEntries: parsed
                    .filter(item => item && item.id && item.activity && item.startDate)
                    .map(item => normalizeOverrideEntry(item))
            };
        }

        if (!parsed || typeof parsed !== 'object') {
            return { ...EMPTY_CALENDAR_CONFIG };
        }

        const customEntries = Array.isArray(parsed.customEntries)
            ? parsed.customEntries.filter(item => item && item.id && item.activity && item.startDate).map(item => normalizeOverrideEntry(item))
            : [];

        const editedDocumentEntries = {};
        if (parsed.editedDocumentEntries && typeof parsed.editedDocumentEntries === 'object') {
            for (const [id, value] of Object.entries(parsed.editedDocumentEntries)) {
                if (!id || !value || !value.activity || !value.startDate) continue;
                editedDocumentEntries[id] = {
                    activity: normalizeText(value.activity),
                    startDate: new Date(value.startDate).toISOString(),
                    endDate: value.endDate ? new Date(value.endDate).toISOString() : null,
                    semester: validateSemester(value.semester) || inferSemester(value.activity, value.startDate),
                    session: normalizeText(value.session || '')
                };
            }
        }

        const deletedDocumentEntryIds = Array.isArray(parsed.deletedDocumentEntryIds)
            ? parsed.deletedDocumentEntryIds.map(id => String(id)).filter(Boolean)
            : [];

        return {
            version: 2,
            customEntries,
            editedDocumentEntries,
            deletedDocumentEntryIds,
            hideDocumentEntries: !!parsed.hideDocumentEntries,
            sessionLabel: normalizeText(parsed.sessionLabel || '')
        };
    } catch (error) {
        if (error.code === 'ENOENT') return { ...EMPTY_CALENDAR_CONFIG };
        throw error;
    }
}

function normalizeOverrideEntry(item) {
    return {
        id: String(item.id),
        activity: normalizeText(item.activity),
        startDate: new Date(item.startDate).toISOString(),
        endDate: item.endDate ? new Date(item.endDate).toISOString() : null,
        semester: validateSemester(item.semester) || inferSemester(item.activity, item.startDate),
        session: normalizeText(item.session || ''),
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
    };
}

async function writeCalendarOverrides(config) {
    const payload = JSON.stringify({
        version: 2,
        customEntries: config.customEntries || [],
        editedDocumentEntries: config.editedDocumentEntries || {},
        deletedDocumentEntryIds: config.deletedDocumentEntryIds || [],
        hideDocumentEntries: !!config.hideDocumentEntries,
        sessionLabel: normalizeText(config.sessionLabel || '')
    }, null, 2);
    await fs.promises.writeFile(CALENDAR_OVERRIDES_FILE, payload, 'utf8');
}

function parseAdminDateInput(raw, fieldName) {
    const parsed = new Date(String(raw || '').trim());
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return parsed.toISOString();
}

function formatCalendarEntry(entry, source) {
    const start = new Date(entry.startDate);
    const end = entry.endDate ? new Date(entry.endDate) : null;
    return {
        id: entry.id,
        source,
        editable: true,
        activity: entry.activity,
        semester: validateSemester(entry.semester) || inferSemester(entry.activity, entry.startDate),
        session: normalizeText(entry.session || ''),
        startDate: entry.startDate,
        endDate: entry.endDate,
        startLabel: formatShortDate(entry.startDate),
        endLabel: entry.endDate ? formatShortDate(entry.endDate) : '',
        dateLabel: end
            ? `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} - ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
            : start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
        monthKey: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
        monthLabel: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    };
}

function mergeCalendarEntries(parsedEntries, config) {
    const deletedDocIds = new Set(config.deletedDocumentEntryIds || []);
    const edits = config.editedDocumentEntries || {};

    const fromDocRaw = parsedEntries.map(item => {
        const id = `doc_${makeStableEntryId('doc', item.activity, item.startDate, item.endDate)}`;
        return { ...item, id, semester: inferSemester(item.activity, item.startDate), session: normalizeText(config.sessionLabel || '') };
    });

    const fromDoc = config.hideDocumentEntries
        ? []
        : fromDocRaw
            .filter(item => !deletedDocIds.has(item.id))
            .map(item => {
                const patched = edits[item.id]
                    ? {
                        ...item,
                        activity: normalizeText(edits[item.id].activity || item.activity),
                        startDate: edits[item.id].startDate || item.startDate,
                        endDate: edits[item.id].endDate === undefined ? item.endDate : edits[item.id].endDate,
                        semester: validateSemester(edits[item.id].semester) || item.semester,
                        session: normalizeText(edits[item.id].session || item.session || '')
                    }
                    : item;
                return formatCalendarEntry(patched, 'document');
            });

    const fromAdmin = (config.customEntries || []).map(item => {
        const semester = validateSemester(item.semester) || inferSemester(item.activity, item.startDate);
        return formatCalendarEntry({ ...item, semester }, 'admin');
    });

    const merged = [...fromDoc, ...fromAdmin];
    merged.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    return merged;
}

function buildCurrentMonthCalendar(entries) {
    const now = new Date();
    const year = now.getFullYear();
    const monthIndex = now.getMonth();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const byDay = {};

    for (let day = 1; day <= daysInMonth; day += 1) {
        byDay[day] = [];
    }

    for (const entry of entries) {
        const start = new Date(entry.startDate);
        const end = entry.endDate ? new Date(entry.endDate) : new Date(entry.startDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;

        const startClamp = new Date(Math.max(start.getTime(), new Date(year, monthIndex, 1).getTime()));
        const endClamp = new Date(Math.min(end.getTime(), new Date(year, monthIndex, daysInMonth, 23, 59, 59).getTime()));
        if (endClamp < startClamp) continue;

        const cursor = new Date(startClamp.getFullYear(), startClamp.getMonth(), startClamp.getDate());
        while (cursor <= endClamp) {
            if (cursor.getMonth() === monthIndex && cursor.getFullYear() === year) {
                const day = cursor.getDate();
                byDay[day].push({
                    id: entry.id,
                    activity: entry.activity,
                    semester: entry.semester,
                    startLabel: entry.startLabel,
                    endLabel: entry.endLabel
                });
            }
            cursor.setDate(cursor.getDate() + 1);
        }
    }

    return {
        year,
        month: monthIndex + 1,
        monthLabel: new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        firstWeekday: new Date(year, monthIndex, 1).getDay(),
        daysInMonth,
        byDay
    };
}

function normalizeSessionLabel(value) {
    const text = normalizeText(value || '');
    if (!text) return '';
    const slash = text.match(/\b(20\d{2})\s*[\/\-]\s*(20\d{2})\b/);
    if (slash) return `${slash[1]}/${slash[2]}`;
    const pair = text.match(/\b(20\d{2})\b.*\b(20\d{2})\b/);
    if (pair) return `${pair[1]}/${pair[2]}`;
    return text;
}

function detectSessionFromFilename(name) {
    const text = String(name || '');
    const match = text.match(/(20\d{2})\D+(20\d{2})/);
    if (!match) return '';
    return `${match[1]}/${match[2]}`;
}

function parseDateForImport(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const d = new Date(`${value}T00:00:00`);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    const slashDmy = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (slashDmy) {
        let year = Number(slashDmy[3]);
        if (year < 100) year += 2000;
        const date = new Date(year, Number(slashDmy[2]) - 1, Number(slashDmy[1]));
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseSemesterForImport(raw, activity, startDate) {
    const val = validateSemester(raw);
    if (val) return val;
    return inferSemester(activity, startDate);
}

function parseImportedRowsFromWorkbook(filePath) {
    const workbook = XLSX.readFile(filePath, { cellDates: false });
    const rows = [];
    let sessionLabel = '';

    workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const sheetSemester = /second/i.test(sheetName) ? 'second' : (/first/i.test(sheetName) ? 'first' : null);

        for (const row of jsonRows) {
            const activity = normalizeText(
                row.Activity || row.activity || row['Activities'] || row['activities'] || row['Event'] || row['event'] || ''
            );
            const startRaw = row['Start Date'] || row['Start'] || row.start || row.startDate || row['Date Start'] || '';
            const endRaw = row['End Date'] || row['End'] || row.end || row.endDate || row['Date End'] || '';
            const sessionRaw = row['Academic Session'] || row['Session'] || row.session || '';
            const semesterRaw = row['Semester'] || row.semester || sheetSemester || '';
            if (!activity) continue;

            const startDate = parseDateForImport(startRaw);
            if (!startDate) continue;
            const endDate = endRaw ? parseDateForImport(endRaw) : null;
            const semester = parseSemesterForImport(semesterRaw, activity, startDate);
            const session = normalizeSessionLabel(sessionRaw || sessionLabel);
            if (session && !sessionLabel) sessionLabel = session;

            rows.push({ activity, startDate, endDate, semester, session });
        }
    });

    return { rows, sessionLabel };
}

function extractTextFromTag(fragment, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const out = [];
    let m;
    while ((m = regex.exec(fragment)) !== null) {
        out.push(normalizeText(String(m[1]).replace(/<[^>]+>/g, ' ')));
    }
    return out;
}

async function parseImportedRowsFromDocx(filePath) {
    const html = await mammoth.convertToHtml({ path: filePath });
    const safeHtml = String(html.value || '');
    const rowMatches = safeHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const rows = [];
    let sessionLabel = '';
    let currentSemester = null;

    const semesterHint = stripHtmlTags(safeHtml.slice(0, 5000));
    if (/202\d\s*[\/\-]\s*202\d/.test(semesterHint)) {
        sessionLabel = normalizeSessionLabel(semesterHint.match(/20\d{2}\s*[\/\-]\s*20\d{2}/)?.[0] || '');
    }

    for (const row of rowMatches) {
        const cells = extractTextFromTag(row, 'td').concat(extractTextFromTag(row, 'th')).filter(Boolean);
        if (!cells.length) continue;

        const merged = cells.join(' ').toLowerCase();
        if (/first\s+semester/.test(merged)) currentSemester = 'first';
        if (/second\s+semester/.test(merged)) currentSemester = 'second';

        if (cells.length < 3) continue;
        const maybeActivity = normalizeText(cells[1] || cells[0]);
        const maybeStart = cells[2] || cells[1] || '';
        const maybeEnd = cells[3] || '';
        if (!maybeActivity || /^activities?$/i.test(maybeActivity)) continue;

        const startDate = parseDateForImport(maybeStart);
        if (!startDate) continue;
        const endDate = maybeEnd ? parseDateForImport(maybeEnd) : null;

        const sessionInRow = normalizeSessionLabel(cells.find(v => /20\d{2}\s*[\/\-]\s*20\d{2}/.test(v)) || '');
        if (sessionInRow && !sessionLabel) sessionLabel = sessionInRow;

        rows.push({
            activity: maybeActivity,
            startDate,
            endDate,
            semester: parseSemesterForImport(cells.find(v => /semester/i.test(v)) || currentSemester || '', maybeActivity, startDate),
            session: sessionInRow || sessionLabel
        });
    }

    return { rows, sessionLabel };
}

async function parseImportedCalendarFile(filePath, originalName) {
    const ext = path.extname(String(originalName || filePath)).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
        return parseImportedRowsFromWorkbook(filePath);
    }
    if (ext === '.docx') {
        return parseImportedRowsFromDocx(filePath);
    }
    throw new Error('Unsupported import format. Use .xlsx, .xls, .csv, or .docx');
}

function createTemplateWorkbookBuffer() {
    const workbook = XLSX.utils.book_new();
    const headers = ['Serial Number', 'Activity', 'Start Date', 'End Date', 'Academic Session', 'Semester'];
    const firstRows = [
        headers,
        [1, 'Arrival of Newly Admitted Students', '2026-10-12', '2026-10-12', '2026/2027', 'first'],
        [2, 'Registration and Course Enrolment', '2026-10-12', '2026-10-20', '2026/2027', 'first']
    ];
    const secondRows = [
        headers,
        [1, 'Resumption - Second Semester', '2027-04-07', '2027-04-07', '2026/2027', 'second'],
        [2, 'Second Semester Examinations', '2027-06-29', '2027-07-10', '2026/2027', 'second']
    ];

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(firstRows), 'First Semester');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(secondRows), 'Second Semester');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function pickLatestPublication(list, pattern) {
    const matches = list.filter(item => pattern.test(item.name));
    if (!matches.length) return null;
    matches.sort((a, b) => {
        if (b.newestYear !== a.newestYear) return b.newestYear - a.newestYear;
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });
    return matches[0];
}

const DATE_MONTHS_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_EXPR_PATTERN = `(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${DATE_MONTHS_PATTERN}(?:,?\\s+\\d{2,4})?|${DATE_MONTHS_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{2,4})?)`;

function parseDateCandidate(raw, fallbackYear) {
    if (!raw) return null;
    const cleaned = String(raw)
        .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
        .replace(/[,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const slash = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (slash) {
        let year = Number(slash[3]);
        if (year < 100) year += 2000;
        const day = Number(slash[1]);
        const month = Number(slash[2]);
        const d = new Date(year, month - 1, day);
        if (!Number.isNaN(d.getTime())) return d;
    }

    const hasExplicitYear = /\b(19|20)\d{2}\b/.test(cleaned);
    const cleanedNoWeekday = cleaned.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/i, '');

    if (!hasExplicitYear && fallbackYear) {
        if (/^[A-Za-z]+\s+\d{1,2}$/.test(cleanedNoWeekday) || /^\d{1,2}\s+[A-Za-z]+$/.test(cleanedNoWeekday)) {
            const withYear = new Date(`${cleanedNoWeekday} ${fallbackYear}`);
            if (!Number.isNaN(withYear.getTime())) return withYear;
        }
    }

    let parsed = new Date(cleaned);
    if (!Number.isNaN(parsed.getTime())) {
        if (!hasExplicitYear && fallbackYear && parsed.getFullYear() < 2010) {
            const corrected = new Date(parsed);
            corrected.setFullYear(fallbackYear);
            return corrected;
        }
        return parsed;
    }

    if (/^[A-Za-z]+\s+\d{1,2}$/.test(cleaned) && fallbackYear) {
        parsed = new Date(`${cleaned} ${fallbackYear}`);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    if (/^\d{1,2}\s+[A-Za-z]+$/.test(cleaned) && fallbackYear) {
        parsed = new Date(`${cleaned} ${fallbackYear}`);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    return null;
}

function toDateLabel(start, end) {
    const format = { month: 'short', day: 'numeric', year: 'numeric' };
    if (end) {
        return `${start.toLocaleDateString(undefined, format)} - ${end.toLocaleDateString(undefined, format)}`;
    }
    return start.toLocaleDateString(undefined, format);
}

function createCalendarEntry(activity, start, end) {
    return {
        activity,
        startDate: start.toISOString(),
        endDate: end ? end.toISOString() : null,
        dateLabel: toDateLabel(start, end),
        monthKey: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
        monthLabel: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    };
}

function extractMonthYearTokens(raw) {
    const monthMatch = String(raw || '').match(new RegExp(DATE_MONTHS_PATTERN, 'i'));
    const yearMatch = String(raw || '').match(/\b(20\d{2}|19\d{2})\b/);
    return {
        month: monthMatch ? monthMatch[0] : null,
        year: yearMatch ? yearMatch[1] : null
    };
}

function pickBestDateToken(raw) {
    const text = String(raw || '');
    const tokens = text.match(new RegExp(DATE_EXPR_PATTERN, 'ig')) || [];
    if (!tokens.length) return null;

    const withYear = tokens.filter(token => /\b(19|20)\d{2}\b/.test(token));
    const pool = withYear.length ? withYear : tokens;
    pool.sort((a, b) => b.length - a.length);
    return pool[0];
}

function resolvePartialDate(raw, referenceRaw, fallbackYear) {
    const cleaned = normalizeText(raw);
    const ref = normalizeText(referenceRaw);
    if (!cleaned) return null;

    const dayOnly = cleaned.match(/^(\d{1,2})(?:st|nd|rd|th)?$/i);
    if (dayOnly) {
        const refTokens = extractMonthYearTokens(ref);
        if (!refTokens.month) return null;
        return parseDateCandidate(`${dayOnly[1]} ${refTokens.month} ${refTokens.year || fallbackYear}`, fallbackYear);
    }

    const dayMonth = cleaned.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${DATE_MONTHS_PATTERN})$`, 'i'));
    if (dayMonth) {
        const refTokens = extractMonthYearTokens(ref);
        return parseDateCandidate(`${dayMonth[1]} ${dayMonth[2]} ${refTokens.year || fallbackYear}`, fallbackYear);
    }

    return null;
}

function extractDateRangeFromText(rawText, fallbackYear) {
    const text = normalizeText(String(rawText || '').replace(/\.$/, ''));
    if (!text) return null;

    const rangeMatch = text.match(/^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/i);
    if (rangeMatch) {
        const startRaw = normalizeText(rangeMatch[1]);
        const endRaw = normalizeText(rangeMatch[2]);

        const endToken = pickBestDateToken(endRaw) || endRaw;
        const startToken = pickBestDateToken(startRaw) || startRaw;

        let start = parseDateCandidate(startToken, fallbackYear) || resolvePartialDate(startToken, endToken, fallbackYear);
        let end = parseDateCandidate(endToken, fallbackYear) || resolvePartialDate(endToken, startToken, fallbackYear);

        if (start && end) return { start, end };
        if (start && !end) return { start, end: null };
    }

    const singleToken = pickBestDateToken(text) || text;
    const single = parseDateCandidate(singleToken, fallbackYear);
    if (single) return { start: single, end: null };

    return null;
}

function isLikelyDateLine(line) {
    const text = normalizeText(line);
    if (!text) return false;
    if (new RegExp(DATE_EXPR_PATTERN, 'i').test(text)) return true;
    if (/\b\d{1,2}(?:st|nd|rd|th)?\s*(?:-|–|—|to)\s*\d{1,2}(?:st|nd|rd|th)?\b/i.test(text)) return true;
    if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text) && /\d/.test(text)) return true;
    return false;
}

function isIgnorableCalendarLine(line) {
    const text = normalizeText(line).toLowerCase();
    return !text || /^(s\/?n|activities|dates|first semester|second semester|first semester highlights|second semester rundown)$/i.test(text);
}

function buildEntryFromActivityAndDate(activityText, dateText, fallbackYear) {
    const activity = normalizeActivityText(activityText);
    if (!activity || activity.length < 3) return null;
    const dateRange = extractDateRangeFromText(dateText, fallbackYear);
    if (!dateRange || !dateRange.start) return null;
    return createCalendarEntry(activity, dateRange.start, dateRange.end);
}

function normalizeActivityText(value) {
    let text = normalizeText(value);
    if (!text) return text;

    // Keep primary activity sentence; drop trailing operational notes.
    const sentences = text.split(/\.\s+/).map(part => normalizeText(part)).filter(Boolean);
    if (sentences.length > 1) {
        const second = sentences[1].toLowerCase();
        if (/^(after\s+which|portal\s+will|note\b|n\.b\.|nb\b|penalty\b|deadline\b)/i.test(second)) {
            text = sentences[0];
        }
    }

    // Insert missing spaces in common glued tokens from DOCX extraction.
    text = text
        .replace(/\s+portal\s+will\b.*$/i, '')
        .replace(/(\d{2,3}[A-Z])(Students\b)/g, '$1 $2')
        .replace(/\(for\s*\(for\b/gi, '(for ')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return text;
}

function isIgnorableActivityText(activity) {
    const text = normalizeText(activity).toLowerCase();
    if (!text) return true;
    if (/^(s\/?n|activities|dates)$/.test(text)) return true;
    if (/^s\/?n\s*[:\-]/.test(text)) return true;
    if (/activities\s*[-:|]+\s*dates/.test(text)) return true;
    return false;
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function stripHtmlTags(value) {
    return normalizeText(decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')));
}

function collectDocxHtmlLines(html) {
    const lines = [];
    const safeHtml = String(html || '');

    const rowMatches = safeHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rowMatches) {
        const cells = [];
        const cellMatches = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
        for (const cell of cellMatches) {
            const text = stripHtmlTags(cell);
            if (text) cells.push(text);
        }
        if (!cells.length) continue;
        if (cells.length >= 2) {
            lines.push(`${cells[0]} :: ${cells.slice(1).join(' - ')}`);
        } else {
            lines.push(cells[0]);
        }
    }

    const listMatches = safeHtml.match(/<li[\s\S]*?<\/li>/gi) || [];
    for (const li of listMatches) {
        const text = stripHtmlTags(li);
        if (text) lines.push(text);
    }

    const paragraphMatches = safeHtml.match(/<p[\s\S]*?<\/p>/gi) || [];
    for (const p of paragraphMatches) {
        const text = stripHtmlTags(p);
        if (text) lines.push(text);
    }

    return lines;
}

function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const key = normalizeText(value).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(normalizeText(value));
    }
    return out;
}

function extractEntryFromLine(line, fallbackYear) {
    const dateExpr = DATE_EXPR_PATTERN;
    const rangeExpr = `(${dateExpr})(?:\\s*(?:-|–|—|to)\\s*(${dateExpr}))?`;

    const p1 = new RegExp(`^(.+?)\\s*(?::|\\-|–|—|::)\\s*${rangeExpr}$`, 'i');
    const p2 = new RegExp(`^${rangeExpr}\\s*(?::|\\-|–|—|::)\\s*(.+)$`, 'i');
    const p3 = new RegExp(`^${rangeExpr}\\s+(.+)$`, 'i');
    const p4 = new RegExp(`^(.+?)\\s+(?:on|by|from)\\s+${rangeExpr}$`, 'i');

    let activity = null;
    let startRaw = null;
    let endRaw = null;

    let m = line.match(p1);
    if (m) {
        activity = m[1].trim();
        startRaw = m[2]?.trim();
        endRaw = m[3]?.trim() || null;
    }

    if (!activity) {
        m = line.match(p2);
        if (m) {
            startRaw = m[1]?.trim();
            endRaw = m[2]?.trim() || null;
            activity = m[3]?.trim() || '';
        }
    }

    if (!activity) {
        m = line.match(p3);
        if (m) {
            startRaw = m[1]?.trim();
            endRaw = m[2]?.trim() || null;
            activity = m[3]?.trim() || '';
        }
    }

    if (!activity) {
        m = line.match(p4);
        if (m) {
            activity = m[1]?.trim() || '';
            startRaw = m[2]?.trim();
            endRaw = m[3]?.trim() || null;
        }
    }

    if (!activity || !startRaw) return null;
    activity = normalizeActivityText(activity);
    if (activity.length < 3) return null;

    const dateRange = extractDateRangeFromText(endRaw ? `${startRaw} - ${endRaw}` : startRaw, fallbackYear);
    if (!dateRange || !dateRange.start) return null;
    return createCalendarEntry(activity, dateRange.start, dateRange.end);
}

function splitCandidateLines(line) {
    const normalized = normalizeText(line);
    if (!normalized) return [];
    const chunks = normalized
        .split(/\s+(?:\||•|;|\u2022)\s+/)
        .map(part => normalizeText(part))
        .filter(Boolean);
    return chunks.length ? chunks : [normalized];
}

async function parseAcademicCalendarEntries(calendarFile) {
    const filePath = path.join(SOURCES_DIR, calendarFile.name);
    const ext = String(calendarFile.ext || '').toLowerCase();
    let lines = [];

    if (ext === 'docx') {
        try {
            const mammoth = require('mammoth');
            const out = await mammoth.extractRawText({ path: filePath });
            const rawLines = String(out.value || '').split(/\r?\n/).map(l => normalizeText(l)).filter(Boolean);
            const htmlOut = await mammoth.convertToHtml({ path: filePath });
            const htmlLines = collectDocxHtmlLines(htmlOut.value || '');
            lines = uniqueStrings([...rawLines, ...htmlLines]);
        } catch (err) {
            console.warn('Could not parse DOCX calendar:', err.message);
        }
    }

    const fallbackYear = calendarFile.newestYear || new Date().getFullYear();
    const parsed = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isIgnorableCalendarLine(line)) continue;

        const candidates = splitCandidateLines(line);
        let consumedNextLine = false;

        for (const candidate of candidates) {
            const entry = extractEntryFromLine(candidate, fallbackYear);
            if (entry) {
                parsed.push(entry);
                continue;
            }

            if (isLikelyDateLine(candidate)) continue;

            const nextLine = lines[i + 1];
            if (nextLine && isLikelyDateLine(nextLine)) {
                const paired = buildEntryFromActivityAndDate(candidate, nextLine, fallbackYear);
                if (paired) {
                    parsed.push(paired);
                    consumedNextLine = true;
                }
            }
        }

        if (consumedNextLine) i += 1;
    }

    // Deduplicate noisy repeated lines in extracted text.
    const seen = new Set();
    const unique = parsed.filter((item) => {
        if (isIgnorableActivityText(item.activity)) return false;
        const key = `${item.activity}__${item.startDate}__${item.endDate || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    unique.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    return unique;
}

// Trust nginx reverse proxy (required for correct client IP + express-rate-limit behind proxy)
if (process.env.NODE_ENV === 'production') {
    // 1 hop: nginx -> node
    app.set('trust proxy', 1);
}

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            // Allow unsafe-inline for scripts to support onclick handlers in dynamically generated HTML
            // and the Lottie CDN used by the advisor page (optional avatar).
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            // Allow unsafe-inline for styles to support dynamic document content from mammoth
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            // Allow TTSMaker audio URLs + data/blob for in-page audio playback.
            // TTSMaker rotates host suffixes (ttsmaker-vip-file.com, ttsmaker-file*.com,
            // and the *.ttsmaker.com / *.ttsmaker.net domains), so we whitelist the
            // family with broad wildcards.
            mediaSrc: [
                "'self'", "data:", "blob:",
                "https://*.ttsmaker.com",
                "https://*.ttsmaker.net",
                "https://*.ttsmaker-file.com",
                "https://*.ttsmaker-file2.com",
                "https://*.ttsmaker-vip-file.com"
            ],
            // Same-origin fetch + WebSockets + external stylesheet/script fetches by the service worker / advisor page.
            connectSrc: ["'self'", "ws:", "wss:", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        },
    },
    crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://bmu.edu.ng', 'https://agent.bmu.edu.ng'] 
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting - general API
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200, // Increased from 100
    message: {
        success: false,
        error: 'Too many requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for certain paths
    skip: (req) => {
        // Don't rate limit export downloads (auth is checked separately)
        return req.path.includes('/exports/download/');
    }
});

// Stricter rate limit for auth routes to prevent brute force
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 login attempts per 15 minutes
    message: {
        success: false,
        error: 'Too many login attempts, please try again in 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);
app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve icon/logo from project root BEFORE express.static (otherwise SPA fallback/static ordering can return HTML)
app.get('/bmulogo.png', (req, res) => {
    res.type('png');
    res.sendFile(path.join(__dirname, '../bmulogo.png'));
});

// Page routes — explicit routes registered BEFORE express.static so they win
// over any same-name file in client/. The actual auth gating is enforced on
// the API side; the client also redirects to /login when no token exists.
//
//   /          -> public marketing landing (with FAQ teaser)
//   /login     -> sign-in form
//   /register  -> account creation form (auto-approves @bmu.edu.ng)
//   /advisor   -> the talking advisor (login required client-side)
//   /admin     -> advisor-styled admin portal (admin role required client-side)
//   /legacy    -> the inherited assistant SPA (kept for backwards compat)
function sendNoStorePage(res, filePath) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.sendFile(filePath);
}

app.get(['/', '/landing'], (req, res) => {
    res.sendFile(path.join(__dirname, '../client/landing.html'));
});
app.get('/login', (req, res) => {
    sendNoStorePage(res, path.join(__dirname, '../client/login.html'));
});
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/register.html'));
});
app.get('/academic-calendar', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/calendar-yearbook.html'));
});
app.get('/calendar-yearbook', (req, res) => {
    res.redirect(302, '/academic-calendar');
});
app.get('/advisor', (req, res) => {
    sendNoStorePage(res, path.join(__dirname, '../client/advisor.html'));
});
app.get('/admin', (req, res) => {
    sendNoStorePage(res, path.join(__dirname, '../client/admin.html'));
});
app.get('/handbook', (req, res) => {
    sendNoStorePage(res, path.join(__dirname, '../client/handbook.html'));
});
app.get('/change-password', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/change-password.html'));
});
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/reset-password.html'));
});
app.get('/verify-email', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/verify-email.html'));
});
app.get(['/legacy', '/legacy/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Serve static files (client)
app.use(express.static(path.join(__dirname, '../client'), {
    etag: true,
    lastModified: true,
    immutable: false,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
        // Ensure correct MIME types for PWA assets
        if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
        }
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        }
        if (
            filePath.endsWith(`${path.sep}advisor.js`) ||
            filePath.endsWith('/advisor.js') ||
            filePath.endsWith(`${path.sep}sw.js`) ||
            filePath.endsWith('/sw.js')
        ) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        if (filePath.endsWith('.png')) {
            res.setHeader('Content-Type', 'image/png');
        }
        if (filePath.endsWith('.ico')) {
            res.setHeader('Content-Type', 'image/x-icon');
        }
        // Prevent MIME sniffing issues in some browsers
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// Explicit static routes for icons/images referenced by manifest and HTML
app.get(['/bmulogo.png'], (req, res) => {
    res.type('png');
    res.sendFile(path.join(__dirname, '../bmulogo.png'));
});

// Serve generated MP3 files (Edge TTS / cached audio). The directory is
// created on demand by edgeTtsService when the first synthesis runs.
app.use('/uploads/audio',
    express.static(path.join(__dirname, '../uploads/audio'), {
        maxAge: '7d',
        setHeaders(res, filePath) {
            if (filePath.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            }
        }
    }));

// Ensure PWA assets are served (avoid SPA fallback edge cases)
app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, '../client/sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, '../client/manifest.webmanifest'));
});

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// Academic calendar feed.
// Reads from /sources on every request so admins can upload the new
// session calendar and have it appear automatically.
app.get('/api/publications/academic-calendar', async (req, res) => {
    try {
        const dirItems = await fs.promises.readdir(SOURCES_DIR, { withFileTypes: true });
        const fileNames = dirItems.filter(d => d.isFile()).map(d => d.name);

        const fileStats = await Promise.all(fileNames.map(async (name) => {
            const stat = await fs.promises.stat(path.join(SOURCES_DIR, name));
            return buildPublicationRecord(name, stat);
        }));

        const calendar = pickLatestPublication(
            fileStats,
            /(academic\s*)?calendar|sessional\s*calendar/i
        );
        const parsedEntries = calendar ? await parseAcademicCalendarEntries(calendar) : [];
        const config = await readCalendarOverrides();
        const entries = mergeCalendarEntries(parsedEntries, config);
        const firstSemesterEntries = entries.filter(item => item.semester === 'first');
        const secondSemesterEntries = entries.filter(item => item.semester === 'second');
        const currentMonthCalendar = buildCurrentMonthCalendar(entries);

        res.json({
            success: true,
            calendar,
            entries,
            firstSemesterEntries,
            secondSemesterEntries,
            currentMonthCalendar,
            sessionLabel: normalizeSessionLabel(config.sessionLabel || detectSessionFromFilename(calendar?.name || '')),
            totalFiles: fileStats.length,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Academic calendar listing error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Could not load academic calendar.'
        });
    }
});

app.post('/api/publications/academic-calendar/entries', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const activity = normalizeText(req.body?.activity);
        if (!activity || activity.length < 3) {
            return res.status(400).json({ success: false, error: 'Activity is required' });
        }

        const startDate = parseAdminDateInput(req.body?.startDate, 'start date');
        const endDate = req.body?.endDate ? parseAdminDateInput(req.body?.endDate, 'end date') : null;
        if (endDate && new Date(endDate) < new Date(startDate)) {
            return res.status(400).json({ success: false, error: 'End date cannot be before start date' });
        }

        const semester = validateSemester(req.body?.semester) || inferSemester(activity, startDate);
        const config = await readCalendarOverrides();
        const id = `adm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        const now = new Date().toISOString();

        const created = {
            id,
            activity,
            startDate,
            endDate,
            semester,
            session: normalizeSessionLabel(req.body?.session || config.sessionLabel || ''),
            createdAt: now,
            updatedAt: now
        };

        config.customEntries.push(created);
        if (created.session && !config.sessionLabel) config.sessionLabel = created.session;
        await writeCalendarOverrides(config);

        res.status(201).json({
            success: true,
            entry: formatCalendarEntry(created, 'admin')
        });
    } catch (error) {
        res.status(500).json({ success: false, error: `Could not add calendar entry: ${error.message}` });
    }
});

app.put('/api/publications/academic-calendar/entries/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const config = await readCalendarOverrides();
        const customIndex = config.customEntries.findIndex(item => item.id === id);

        let existing = null;
        let mode = null;
        if (customIndex >= 0) {
            existing = config.customEntries[customIndex];
            mode = 'custom';
        } else if (id.startsWith('doc_')) {
            existing = config.editedDocumentEntries[id] || null;
            mode = 'document';
        } else {
            return res.status(404).json({ success: false, error: 'Entry not found' });
        }

        const activity = req.body?.activity ? normalizeText(req.body.activity) : existing.activity;
        if (!activity || activity.length < 3) {
            return res.status(400).json({ success: false, error: 'Activity is required' });
        }

        const startDate = req.body?.startDate
            ? parseAdminDateInput(req.body.startDate, 'start date')
            : (existing?.startDate || null);
        if (!startDate) {
            return res.status(400).json({ success: false, error: 'Start date is required when editing document entries' });
        }

        const endDate = req.body?.endDate === ''
            ? null
            : (req.body?.endDate ? parseAdminDateInput(req.body.endDate, 'end date') : (existing?.endDate || null));
        if (endDate && new Date(endDate) < new Date(startDate)) {
            return res.status(400).json({ success: false, error: 'End date cannot be before start date' });
        }

        const semester = validateSemester(req.body?.semester) || inferSemester(activity, startDate);
        const session = normalizeSessionLabel(req.body?.session || existing?.session || config.sessionLabel || '');
        const updated = {
            ...(existing || {}),
            id,
            activity,
            startDate,
            endDate,
            semester,
            session,
            updatedAt: new Date().toISOString()
        };

        if (mode === 'custom') {
            config.customEntries[customIndex] = updated;
        } else {
            config.editedDocumentEntries[id] = {
                activity,
                startDate,
                endDate,
                semester,
                session
            };
            config.deletedDocumentEntryIds = config.deletedDocumentEntryIds.filter(x => x !== id);
        }

        if (session && !config.sessionLabel) config.sessionLabel = session;
        await writeCalendarOverrides(config);

        res.json({ success: true, entry: formatCalendarEntry(updated, mode === 'custom' ? 'admin' : 'document') });
    } catch (error) {
        res.status(500).json({ success: false, error: `Could not update calendar entry: ${error.message}` });
    }
});

app.delete('/api/publications/academic-calendar/entries/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const config = await readCalendarOverrides();

        const beforeCustom = config.customEntries.length;
        config.customEntries = config.customEntries.filter(item => item.id !== id);
        const removedCustom = beforeCustom !== config.customEntries.length;

        let removed = removedCustom;
        if (!removed && id.startsWith('doc_')) {
            if (!config.deletedDocumentEntryIds.includes(id)) {
                config.deletedDocumentEntryIds.push(id);
            }
            delete config.editedDocumentEntries[id];
            removed = true;
        }

        if (!removed) {
            return res.status(404).json({ success: false, error: 'Entry not found' });
        }

        await writeCalendarOverrides(config);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: `Could not delete calendar entry: ${error.message}` });
    }
});

app.get('/api/publications/academic-calendar/template', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const fileBuffer = createTemplateWorkbookBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="academic-calendar-template.xlsx"');
        res.send(fileBuffer);
    } catch (error) {
        res.status(500).json({ success: false, error: `Could not generate template: ${error.message}` });
    }
});

app.post('/api/publications/academic-calendar/import', authenticateToken, requireAdmin, uploadDocument.single('file'), handleUploadError, async (req, res) => {
    let uploadedPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        uploadedPath = req.file.path;
        const mode = String(req.body?.mode || 'replace').toLowerCase(); // replace | merge
        const parsed = await parseImportedCalendarFile(uploadedPath, req.file.originalname);
        if (!parsed.rows.length) {
            return res.status(400).json({ success: false, error: 'No valid calendar rows found in uploaded file' });
        }

        const config = await readCalendarOverrides();
        const sessionLabel = normalizeSessionLabel(req.body?.session || parsed.sessionLabel || config.sessionLabel || detectSessionFromFilename(req.file.originalname));

        const now = new Date().toISOString();
        const importedEntries = parsed.rows.map((row, idx) => ({
            id: `adm_imp_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
            activity: normalizeText(row.activity),
            startDate: row.startDate,
            endDate: row.endDate || null,
            semester: validateSemester(row.semester) || inferSemester(row.activity, row.startDate),
            session: normalizeSessionLabel(row.session || sessionLabel),
            createdAt: now,
            updatedAt: now
        }));

        if (mode === 'replace') {
            config.customEntries = importedEntries;
            config.editedDocumentEntries = {};
            config.deletedDocumentEntryIds = [];
            config.hideDocumentEntries = true;
        } else {
            config.customEntries = [...config.customEntries, ...importedEntries];
        }

        if (sessionLabel) config.sessionLabel = sessionLabel;
        await writeCalendarOverrides(config);

        res.json({
            success: true,
            importedCount: importedEntries.length,
            mode,
            sessionLabel: config.sessionLabel,
            hideDocumentEntries: config.hideDocumentEntries
        });
    } catch (error) {
        res.status(500).json({ success: false, error: `Could not import calendar file: ${error.message}` });
    } finally {
        if (uploadedPath) {
            fs.promises.unlink(uploadedPath).catch(() => null);
        }
    }
});

// Safe file-serving endpoint restricted to /sources.
app.get('/api/publications/file', async (req, res) => {
    try {
        const requestedName = String(req.query.name || '').trim();
        const safeName = path.basename(requestedName);
        if (!safeName || safeName !== requestedName) {
            return res.status(400).json({ success: false, error: 'Invalid file name' });
        }

        const fullPath = path.join(SOURCES_DIR, safeName);
        await fs.promises.access(fullPath, fs.constants.R_OK);

        if (String(req.query.download || '') === '1') {
            return res.download(fullPath, safeName);
        }
        res.sendFile(fullPath);
    } catch (error) {
        res.status(404).json({ success: false, error: 'File not found' });
    }
});

// API Routes
app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/document-lab', documentLabRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/faq', faqRoutes);
app.use('/api/vc-reports', vcReportRoutes);
app.use('/api/vc-documents', vcDocumentRoutes);
app.use('/api/advisor', advisorRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'operational',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Public settings endpoint
app.get('/api/settings/public', async (req, res) => {
    try {
        const { query } = require('../config/db');
        const settings = await query(`
            SELECT setting_key, setting_value
            FROM system_settings
            WHERE is_public = TRUE
        `);
        
        const settingsObject = {};
        settings.forEach(s => {
            settingsObject[s.setting_key] = s.setting_value;
        });
        
        res.json({
            success: true,
            settings: settingsObject
        });
    } catch (error) {
        res.json({
            success: true,
            settings: {
                app_name: 'BMU AI Academic Advisor',
                university_name: 'Bayelsa Medical University',
                university_motto: 'Service to God and Humanity'
            }
        });
    }
});

// Serve frontend for all other non-API routes (SPA support).
// Primary page routes are mounted earlier (before express.static). The
// catch-all below covers deep links and unknown paths.
app.get('*', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    if (req.path === '/uploads' || req.path.startsWith('/uploads/')) return next();
    if (path.extname(req.path)) return next();
    if (req.path.startsWith('/legacy/')) {
        return res.sendFile(path.join(__dirname, '../client/index.html'));
    }
    if (req.path.startsWith('/admin'))    return sendNoStorePage(res, path.join(__dirname, '../client/admin.html'));
    if (req.path.startsWith('/advisor'))  return sendNoStorePage(res, path.join(__dirname, '../client/advisor.html'));
    if (req.path.startsWith('/login'))    return sendNoStorePage(res, path.join(__dirname, '../client/login.html'));
    if (req.path.startsWith('/register')) return res.sendFile(path.join(__dirname, '../client/register.html'));
    if (req.path.startsWith('/academic-calendar')) return res.sendFile(path.join(__dirname, '../client/calendar-yearbook.html'));
    if (req.path.startsWith('/calendar-yearbook')) return res.redirect(302, '/academic-calendar');
    if (req.path.startsWith('/reset-password')) return res.sendFile(path.join(__dirname, '../client/reset-password.html'));
    if (req.path.startsWith('/verify-email')) return res.sendFile(path.join(__dirname, '../client/verify-email.html'));
    // Default: marketing landing.
    res.sendFile(path.join(__dirname, '../client/landing.html'));
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' 
            ? 'An unexpected error occurred' 
            : err.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║          🏥 BMU AI Agent Server Started                  ║
║                                                          ║
║   Bayelsa Medical University Policy Assistant            ║
║                                                          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║   🌐 Server: http://localhost:${PORT}                      ║
║   📚 API:    http://localhost:${PORT}/api                  ║
║   🔧 Mode:   ${process.env.NODE_ENV || 'development'}                           ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);

    // Start cache warming after server is ready
    try {
        const cacheService = require('./services/cacheService');
        cacheService.startCacheWarming({
            intervalMs: 30 * 60 * 1000,  // Every 30 minutes
            popularFAQLimit: 50           // Top 50 FAQs
        });
    } catch (err) {
        console.warn('[App] Cache warming initialization skipped:', err.message);
    }

    // Ensure document review/ranking columns exist before admins upload or
    // retrieval uses authority metadata.
    try {
        const documentQualityService = require('./services/documentQualityService');
        await documentQualityService.ensureSchema();
        console.log('[App] Document AI review schema ready');
    } catch (err) {
        console.warn('[App] Document AI review schema setup skipped:', err.message);
    }

    try {
        const documentLabService = require('./services/documentLabService');
        await documentLabService.ensureSchema();
        console.log('[App] Document Lab schema ready');
    } catch (err) {
        console.warn('[App] Document Lab schema setup skipped:', err.message);
    }

    // Sync FAISS vector index with database on startup
    // This prevents issues where documents are in DB but missing from search index
    try {
        const vectorStore = require('./services/vectorStore');
        const syncResult = await vectorStore.syncWithDatabase();
        if (syncResult.rebuilt) {
            console.log(`[App] ✅ Vector index rebuilt: ${syncResult.chunks} chunks indexed`);
        }
    } catch (err) {
        console.warn('[App] Vector index sync skipped:', err.message);
    }
});

module.exports = app;
