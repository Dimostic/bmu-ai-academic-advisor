const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../config/db');
const Document = require('../models/Document');
const documentProcessor = require('./documentProcessor');
const documentQualityService = require('./documentQualityService');

const LAB_DIR = path.join(__dirname, '../../uploads/document-lab');
const PROMOTED_DIR = path.join(LAB_DIR, 'promoted');
const DEFAULT_TARGET_CHARS = 12000;
const DOCUMENT_CATEGORIES = new Set(['policy', 'regulation', 'academic', 'administrative', 'legal', 'general']);
const ACADEMIC_CHUNK_TARGET = 2200;
const PROGRAMME_ALIASES = [
    ['MBBS', /\b(mbbs|medicine and surgery|medicine)\b/i],
    ['BDS', /\b(bds|dentistry|dental surgery)\b/i],
    ['Nursing', /\b(nursing|bnsc)\b/i],
    ['Medical Laboratory Science', /\b(medical laboratory science|bmls)\b/i],
    ['Pharmacy', /\b(pharmacy|pharmd|doctor of pharmacy|b\.?pharm)\b/i],
    ['Physiotherapy', /\b(physiotherapy|medical rehabilitation)\b/i],
    ['Radiography', /\b(radiography|radiation science)\b/i],
    ['Optometry', /\b(optometry)\b/i],
    ['Human Anatomy', /\b(human anatomy|anatomy)\b/i],
    ['Human Physiology', /\b(human physiology|physiology)\b/i],
    ['Biochemistry', /\b(biochemistry)\b/i],
    ['Public Health', /\b(public health)\b/i],
    ['Microbiology', /\b(microbiology)\b/i],
    ['Computer Science', /\b(computer science)\b/i],
    ['Mathematics', /\b(mathematics)\b/i],
    ['Statistics', /\b(statistics)\b/i],
    ['Physics', /\b(physics)\b/i],
    ['Chemistry', /\b(chemistry)\b/i],
    ['Biology', /\b(biology|biological sciences)\b/i],
    ['Environmental Management and Toxicology', /\b(environmental management|toxicology)\b/i],
    ['Economics', /\b(economics)\b/i],
    ['Political Science', /\b(political science)\b/i],
    ['Sociology', /\b(sociology)\b/i],
    ['Psychology', /\b(psychology)\b/i],
    ['Mass Communication', /\b(mass communication)\b/i],
    ['Accounting', /\b(accounting)\b/i],
    ['Business Administration', /\b(business administration)\b/i],
    ['Public Administration', /\b(public administration)\b/i],
    ['Law', /\b(law|ll\.?b)\b/i]
];
let schemaEnsured = false;
const NORMALIZED_TABLES = [
    'academic_programmes',
    'academic_courses',
    'academic_fees',
    'academic_calendar_events',
    'academic_officers',
    'academic_rules'
];

function stableHash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function compactText(value, maxLength = 1200) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function objectText(value) {
    if (!value) return '';
    if (typeof value === 'string') return compactText(value);
    if (Array.isArray(value)) return compactText(value.join(' | '));
    return compactText(Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined && String(item).trim() !== '')
        .map(([key, item]) => `${key}: ${item}`)
        .join(' | '));
}

function findField(record, patterns) {
    if (!record || typeof record !== 'object') return null;
    for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined || String(value).trim() === '') continue;
        const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (patterns.some(pattern => pattern.test(normalizedKey))) return String(value).trim();
    }
    return null;
}

function detectProgramme(text) {
    const haystack = String(text || '');
    const match = PROGRAMME_ALIASES.find(([, re]) => re.test(haystack));
    return match ? match[0] : null;
}

function extractCourseCode(text) {
    const match = String(text || '').match(/\b([A-Z]{2,5})\s*[- ]?\s*(\d{3})\b/i);
    return match ? `${match[1].toUpperCase()} ${match[2]}` : null;
}

function extractCourseUnits(text) {
    const match = String(text || '').match(/\b([1-9])\s*(?:credit\s*)?units?\b/i);
    return match ? Number(match[1]) : null;
}

function extractDurationYears(text) {
    const value = String(text || '').toLowerCase();
    const direct = value.match(/\b([1-9])\s*(?:year|years|yr|yrs)\b/);
    if (direct) return Number(direct[1]);
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const word = value.match(/\b(one|two|three|four|five|six|seven)\s*(?:year|years)\b/);
    return word ? words[word[1]] : null;
}

function extractMoney(text) {
    const match = String(text || '').match(/(?:\u20a6|NGN|N)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
    if (!match) return { amountLabel: null, amountValue: null };
    return {
        amountLabel: match[0].trim(),
        amountValue: Number(match[1].replace(/,/g, '')) || null
    };
}

function extractDateLabel(text) {
    const value = String(text || '');
    const dateMatch = value.match(/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/i)
        || value.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/)
        || value.match(/\b20\d{2}[/-]\d{2}[/-]\d{2}\b/);
    return dateMatch ? dateMatch[0] : null;
}

function inferRuleType(text, fallback = 'general') {
    const value = String(text || '').toLowerCase();
    if (/\b(admission|entry requirement|eligibility|utme|direct entry|o'?level|waec|neco)\b/.test(value)) return 'admission';
    if (/\b(fee|fees|tuition|payment|charges|levy)\b/.test(value)) return 'fees';
    if (/\b(deadline|calendar|resumption|registration date|exam date)\b/.test(value)) return 'calendar';
    if (/\b(progression|probation|withdrawal|repeat|carry over|cgpa|gpa)\b/.test(value)) return 'progression';
    if (/\b(graduation|graduate)\b/.test(value)) return 'graduation';
    if (/\b(exam|examination|pass mark|grade)\b/.test(value)) return 'examination';
    if (/\b(transfer|accreditation|mdcn|nuc)\b/.test(value)) return 'regulation';
    if (/\b(course|unit|semester|level)\b/.test(value)) return 'course';
    if (/\b(vc|vice chancellor|registrar|bursar|librarian|officer)\b/.test(value)) return 'officer';
    return fallback || 'general';
}

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function cleanTitle(value, fallback = 'Document') {
    return String(value || fallback).trim().replace(/\s+/g, ' ').slice(0, 255);
}

function isImageFile(filePath) {
    return /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(filePath || '');
}

function escapeMarkdownCell(value) {
    return String(value || '').trim().replace(/\|/g, '\\|');
}

function normalizeTableLikeLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let convertedTables = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const next = (lines[i + 1] || '').trim();
        const tableish = trimmed && (/	/.test(trimmed) || /\S\s{3,}\S/.test(trimmed));
        const nextTableish = next && (/	/.test(next) || /\S\s{3,}\S/.test(next));

        if (!tableish || !nextTableish) {
            out.push(line);
            continue;
        }

        const tableRows = [];
        while (i < lines.length) {
            const row = (lines[i] || '').trim();
            if (!row || !(/	/.test(row) || /\S\s{3,}\S/.test(row))) break;
            const cells = row.split(/	+|\s{3,}/).map(escapeMarkdownCell).filter(Boolean);
            if (cells.length < 2) break;
            tableRows.push(cells);
            i++;
        }
        i--;

        if (tableRows.length < 2) {
            out.push(line);
            continue;
        }

        const width = Math.max(...tableRows.map(r => r.length));
        const padded = tableRows.map(r => {
            const copy = r.slice();
            while (copy.length < width) copy.push('');
            return copy;
        });
        out.push('| ' + padded[0].join(' | ') + ' |');
        out.push('| ' + padded[0].map(() => '---').join(' | ') + ' |');
        for (const row of padded.slice(1)) out.push('| ' + row.join(' | ') + ' |');
        convertedTables++;
    }

    return { text: out.join('\n'), convertedTables };
}

function markdownClean(text, title) {
    const normalized = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
    const withTables = normalizeTableLikeLines(normalized);
    const body = withTables.text.trim();
    const heading = `# ${cleanTitle(title)}\n\n`;
    return {
        markdown: body.startsWith('#') ? body : heading + body,
        convertedTables: withTables.convertedTables
    };
}

function detectIssue(review) {
    const warnings = (review?.warnings || []).join(' ').toLowerCase();
    const metrics = review?.metrics || {};
    if (!metrics.textChars || metrics.textChars < 300 || review?.status === 'reject') return 'needs_readable_source';
    if (/low text density|ocr|scanned/.test(warnings)) return 'needs_ocr_cleanup';
    if ((metrics.estimatedChunks || 0) > 500) return 'needs_splitting';
    if ((metrics.tableSignals || 0) > 15 || /table-like/.test(warnings)) return 'needs_table_cleanup';
    if (/few clear headings/.test(warnings)) return 'needs_structure_cleanup';
    if (review?.status === 'ready') return 'ready_for_approval';
    return 'needs_review';
}

function buildRecommendations(issueType, review, tableCount) {
    const recommendations = [...(review?.recommendations || [])];
    if (issueType === 'needs_readable_source') {
        recommendations.unshift('Ask for a readable digital file or OCR-ready scan before ingestion.');
    }
    if (issueType === 'needs_splitting') {
        recommendations.unshift('Split into smaller approved parts before sending to Documents.');
    }
    if (issueType === 'needs_table_cleanup') {
        recommendations.unshift('Review converted Markdown tables before approval.');
    }
    if (tableCount > 0) {
        recommendations.unshift(`${tableCount} table-like block(s) were converted to Markdown table format.`);
    }
    return Array.from(new Set(recommendations)).slice(0, 12);
}

function splitByHeadings(markdown, title, targetChars = DEFAULT_TARGET_CHARS) {
    const text = String(markdown || '').trim();
    if (!text) return [];

    const lines = text.split('\n');
    const sections = [];
    let currentTitle = cleanTitle(title);
    let current = [];

    for (const line of lines) {
        const heading = line.match(/^(#{1,3})\s+(.{4,120})$/);
        if (heading && current.join('\n').length > 800) {
            sections.push({ title: currentTitle, content: current.join('\n').trim() });
            current = [];
            currentTitle = cleanTitle(heading[2], title);
        }
        current.push(line);
    }
    if (current.join('\n').trim()) sections.push({ title: currentTitle, content: current.join('\n').trim() });

    const chunks = [];
    let buffer = [];
    let bufferTitle = sections[0]?.title || cleanTitle(title);
    let bufferLen = 0;

    for (const section of sections) {
        if (bufferLen && bufferLen + section.content.length > targetChars) {
            chunks.push({ title: bufferTitle, content: buffer.join('\n\n').trim() });
            buffer = [];
            bufferLen = 0;
            bufferTitle = section.title;
        }
        if (section.content.length > targetChars * 1.4) {
            if (bufferLen) {
                chunks.push({ title: bufferTitle, content: buffer.join('\n\n').trim() });
                buffer = [];
                bufferLen = 0;
            }
            const paragraphs = splitContentUnits(section.content, targetChars);
            let part = [];
            let partLen = 0;
            let partNo = 1;
            for (const paragraph of paragraphs) {
                if (partLen >= 800 && partLen + paragraph.length > targetChars) {
                    chunks.push({ title: `${section.title} - Part ${partNo++}`, content: part.join('\n\n').trim() });
                    part = [];
                    partLen = 0;
                }
                part.push(paragraph);
                partLen += paragraph.length + 2;
            }
            if (part.length) chunks.push({ title: `${section.title} - Part ${partNo}`, content: part.join('\n\n').trim() });
            continue;
        }
        buffer.push(section.content);
        bufferLen += section.content.length + 2;
    }

    if (buffer.length) chunks.push({ title: bufferTitle, content: buffer.join('\n\n').trim() });
    const merged = mergeThinSplitChunks(expandOversizeChunks(chunks, targetChars), title);
    return merged.length ? merged : [{ title: cleanTitle(title), content: text }];
}

function splitContentUnits(content, targetChars = DEFAULT_TARGET_CHARS) {
    const text = String(content || '').trim();
    if (!text) return [];

    const paragraphUnits = text.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
    if (paragraphUnits.length > 1 && paragraphUnits.some(x => x.length < targetChars * 1.2)) {
        return flattenOversizeUnits(paragraphUnits, targetChars);
    }

    const lineUnits = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (lineUnits.length > 6) {
        return flattenOversizeUnits(lineUnits, targetChars);
    }

    const sentenceUnits = text
        .split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)
        .map(x => x.trim())
        .filter(Boolean);
    if (sentenceUnits.length > 6) {
        return flattenOversizeUnits(sentenceUnits, targetChars);
    }

    return hardSplitText(text, targetChars);
}

function flattenOversizeUnits(units, targetChars) {
    const out = [];
    for (const unit of units) {
        if (unit.length > targetChars * 1.25) out.push(...hardSplitText(unit, targetChars));
        else out.push(unit);
    }
    return out;
}

function hardSplitText(text, targetChars = DEFAULT_TARGET_CHARS) {
    const value = String(text || '').trim();
    if (!value) return [];
    const chunks = [];
    let remaining = value;
    while (remaining.length > targetChars) {
        const minCut = Math.floor(targetChars * 0.65);
        const maxCut = Math.min(remaining.length, Math.floor(targetChars * 1.05));
        let cut = remaining.lastIndexOf('\n', maxCut);
        if (cut < minCut) cut = remaining.lastIndexOf('. ', maxCut);
        if (cut < minCut) cut = remaining.lastIndexOf('; ', maxCut);
        if (cut < minCut) cut = remaining.lastIndexOf(' ', maxCut);
        if (cut < minCut) cut = targetChars;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function expandOversizeChunks(chunks, targetChars = DEFAULT_TARGET_CHARS) {
    const expanded = [];
    for (const chunk of chunks || []) {
        const content = String(chunk?.content || '').trim();
        if (!content) continue;
        if (content.length <= targetChars * 1.35) {
            expanded.push(chunk);
            continue;
        }
        const pieces = splitContentUnits(content, targetChars);
        pieces.forEach((piece, index) => {
            expanded.push({
                title: `${cleanTitle(chunk.title)} - Part ${index + 1}`,
                content: piece
            });
        });
    }
    return expanded;
}

function isThinSplitChunk(chunk) {
    const content = String(chunk?.content || '').trim();
    if (content.length < 350) return true;
    const withoutHeadings = content
        .split(/\r?\n/)
        .filter(line => !/^#{1,6}\s+/.test(line.trim()))
        .join('\n')
        .trim();
    return withoutHeadings.length < 180;
}

function mergeThinSplitChunks(chunks, fallbackTitle) {
    const source = (chunks || [])
        .filter(chunk => String(chunk?.content || '').trim())
        .map(chunk => ({
            title: cleanTitle(chunk.title || fallbackTitle),
            content: String(chunk.content || '').trim()
        }));
    if (source.length <= 1) return source;

    const merged = [];
    for (const chunk of source) {
        if (isThinSplitChunk(chunk)) {
            const next = source[source.indexOf(chunk) + 1];
            if (next) {
                next.content = `${chunk.content}\n\n${next.content}`.trim();
                if (!next.title || next.title === cleanTitle(fallbackTitle)) {
                    next.title = chunk.title;
                }
                continue;
            }
            if (merged.length) {
                const previous = merged[merged.length - 1];
                previous.content = `${previous.content}\n\n${chunk.content}`.trim();
                continue;
            }
        }
        merged.push(chunk);
    }

    return merged.map((chunk, index) => ({
        title: chunk.title || `${cleanTitle(fallbackTitle)} - Part ${index + 1}`,
        content: chunk.content
    }));
}

function uniqueLines(lines, limit = 80) {
    const seen = new Set();
    const out = [];
    for (const line of lines || []) {
        const cleaned = String(line || '').replace(/\s+/g, ' ').trim();
        if (cleaned.length < 8) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= limit) break;
    }
    return out;
}

function bulletLines(lines) {
    return lines.length ? lines.map(line => `- ${line}`).join('\n') : '- No clear matching lines detected.';
}

function extractMarkdownTables(text, limit = 8) {
    const lines = String(text || '').split(/\r?\n/);
    const tables = [];
    let current = [];
    for (const line of lines) {
        if (/^\s*\|.+\|\s*$/.test(line)) {
            current.push(line.trim());
            continue;
        }
        if (current.length >= 2) tables.push(current.join('\n'));
        current = [];
        if (tables.length >= limit) break;
    }
    if (current.length >= 2 && tables.length < limit) tables.push(current.join('\n'));
    return tables;
}

function extractHeadings(text, limit = 60) {
    const headings = String(text || '').split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^#{1,4}\s+/.test(line) || /^[A-Z][A-Z0-9 ,.'&()/:-]{8,}$/.test(line))
        .map(line => line.replace(/^#{1,4}\s+/, ''));
    return uniqueLines(headings, limit);
}

function selectDigestLines(text, regex, limit = 80) {
    const lines = String(text || '').split(/\r?\n/)
        .map(line => line.replace(/^[-*]\s+/, '').trim())
        .filter(line => line.length >= 10 && line.length <= 420)
        .filter(line => regex.test(line));
    return uniqueLines(lines, limit);
}

function extractCourseCreditLines(text) {
    return selectDigestLines(
        text,
        /\b([A-Z]{2,5}\s*\d{3}[A-Z]?|credit units?|units?|course code|course title|semester|level|programme|department)\b/i,
        120
    );
}

function buildStructuredDigest(markdown, title) {
    const text = String(markdown || '').trim();
    const headings = extractHeadings(text);
    const tables = extractMarkdownTables(text);
    const keyFacts = selectDigestLines(text, /\b(BMU|Bayelsa Medical University|vision|mission|motto|established|located|college|faculty|department|programme|principal officer|registrar|bursar|librarian|vice[- ]chancellor)\b/i, 70);
    const requirements = selectDigestLines(text, /\b(requirements?|admission|eligib|entry|UTME|JAMB|direct entry|O'?level|SSCE|WAEC|NECO|credit pass|five credits?|minimum|qualification|criteria)\b/i, 100);
    const courses = extractCourseCreditLines(text);
    const fees = selectDigestLines(text, /\b(fees?|tuition|payment|charge|levy|acceptance|accommodation|hostel|Naira|NGN|₦|\bN\s?\d|amount|cost)\b/i, 80);
    const dates = selectDigestLines(text, /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|20\d{2}|January|February|March|April|May|June|July|August|September|October|November|December|semester|session|deadline|resumption|examination|registration)\b/i, 80);
    const policies = selectDigestLines(text, /\b(policy|shall|must|required|prohibited|approved|senate|council|regulation|discipline|withdrawal|probation|graduation|CGPA|GPA|pass mark|carry.?over|repeat)\b/i, 100);

    const sections = [
        `# Structured Digest - ${cleanTitle(title)}`,
        [
            '## Admin Verification Note',
            '- This digest is a structured companion for AI ingestion.',
            '- It groups exact source lines and converted table blocks; it should be reviewed by an admin before promotion.',
            '- Do not treat this as replacing the original document. Keep the source document as provenance.'
        ].join('\n'),
        ['## Detected Source Outline', bulletLines(headings)].join('\n\n'),
        ['## Key Facts And Institutional Information', bulletLines(keyFacts)].join('\n\n'),
        ['## Programmes, Courses, Levels, And Credits', bulletLines(courses)].join('\n\n'),
        ['## Admission, Eligibility, And Requirements', bulletLines(requirements)].join('\n\n'),
        ['## Fees, Payments, And Charges', bulletLines(fees)].join('\n\n'),
        ['## Dates, Sessions, Calendar, And Deadlines', bulletLines(dates)].join('\n\n'),
        ['## Policies, Rules, Progression, And Academic Decisions', bulletLines(policies)].join('\n\n')
    ];

    if (tables.length) {
        sections.push([
            '## Detected Tables Converted To Markdown',
            tables.map((table, index) => `### Table ${index + 1}\n\n${table}`).join('\n\n')
        ].join('\n\n'));
    }

    const digest = sections.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim();
    return {
        digest,
        metrics: {
            headings: headings.length,
            keyFacts: keyFacts.length,
            requirements: requirements.length,
            courses: courses.length,
            fees: fees.length,
            dates: dates.length,
            policies: policies.length,
            tables: tables.length
        }
    };
}

function stripMarkdownTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
}

function parseMarkdownTable(table) {
    const lines = String(table || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const dataLines = lines.filter(line => !stripMarkdownTableSeparator(line));
    if (dataLines.length < 2) return [];
    const split = line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    const headers = split(dataLines[0]).map((h, i) => h || `column_${i + 1}`);
    return dataLines.slice(1).map(line => {
        const cells = split(line);
        const row = {};
        headers.forEach((header, index) => {
            row[header] = cells[index] || '';
        });
        return row;
    }).filter(row => Object.values(row).some(Boolean));
}

function normalizeProgrammeName(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const q = text.toLowerCase();
    const found = PROGRAMME_ALIASES.find(([, re]) => re.test(text));
    if (found) return found[0];
    if (/\bprogramme\b|\bprogram\b|\bdegree\b/.test(q)) return text.replace(/^#+\s*/, '').slice(0, 120);
    return '';
}

function classifyAcademicDocument(title, markdown) {
    const name = String(title || '').toLowerCase();
    const sample = String(markdown || '').slice(0, 6000).toLowerCase();
    const haystack = `${name}\n${sample}`;
    if (/mdcn|medical and dental council/.test(haystack)) {
        return { family: 'professional_regulation', authorityType: 'professional_regulator', discipline: 'Medicine and Dentistry', recipe: 'mdcn_guideline' };
    }
    if (/ccmas|core curriculum.*minimum academic standards|nuc/.test(haystack)) {
        if (/medicine.*dentistry|dentistry.*medicine|mbbs|bds/.test(haystack)) {
            return { family: 'ccmas', authorityType: 'regulator', discipline: 'Medicine and Dentistry', recipe: 'medicine_dentistry_ccmas' };
        }
        if (/pharmacy|pharmaceutical sciences|pharmd/.test(haystack)) {
            return { family: 'ccmas', authorityType: 'regulator', discipline: 'Pharmacy and Pharmaceutical Sciences', recipe: 'pharmacy_ccmas' };
        }
        if (/basic medical sciences|human anatomy|human physiology/.test(haystack)) {
            return { family: 'ccmas', authorityType: 'regulator', discipline: 'Basic Medical Sciences', recipe: 'basic_medical_sciences_ccmas' };
        }
        if (/allied health|nursing|medical laboratory|physiotherapy|radiography/.test(haystack)) {
            return { family: 'ccmas', authorityType: 'regulator', discipline: 'Allied Health Sciences', recipe: 'allied_health_ccmas' };
        }
        if (/social sciences|economics|political science|sociology/.test(haystack)) {
            return { family: 'ccmas', authorityType: 'regulator', discipline: 'Social Sciences', recipe: 'social_sciences_ccmas' };
        }
        if (/sciences|computer science|microbiology|biochemistry|physics|chemistry/.test(haystack)) {
            return { family: 'ccmas', authorityType: 'regulator', discipline: 'Sciences', recipe: 'sciences_ccmas' };
        }
        return { family: 'ccmas', authorityType: 'regulator', discipline: '', recipe: 'generic_ccmas' };
    }
    if (/calendar|session|semester/.test(name)) return { family: 'academic_calendar', authorityType: 'institution', discipline: '', recipe: 'calendar' };
    if (/fee|tuition|charges/.test(name)) return { family: 'fees', authorityType: 'institution', discipline: '', recipe: 'fees' };
    if (/handbook|prospectus|profile|quick facts|career/.test(name)) return { family: 'institutional', authorityType: 'institution', discipline: '', recipe: 'institutional' };
    return { family: 'general_academic', authorityType: 'institution', discipline: '', recipe: 'generic' };
}

function isBoilerplateHeading(line) {
    return /\b(contents?|table of contents|foreword|preface|acknowledg|committee|contributors?|reviewers?|copyright|isbn|publication|nuc management|list of participants|definitions and acronyms)\b/i.test(line || '');
}

function isBoilerplateLine(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    if (/^\d+$/.test(text)) return true;
    if (/^(page|pg)\s+\d+/i.test(text)) return true;
    if (/^(©|copyright|isbn|all rights reserved)/i.test(text)) return true;
    return false;
}

function detectAcademicSection(title) {
    const q = String(title || '').toLowerCase();
    if (/admission|entry|eligib|graduation requirement/.test(q)) return 'admission_requirements';
    if (/course structure|course content|course description|learning outcome/.test(q)) return 'course_content';
    if (/duration/.test(q)) return 'programme_duration';
    if (/minimum academic standard|staffing|laborator|facility|library/.test(q)) return 'minimum_academic_standards';
    if (/philosophy|objective|overview|unique feature|employability|21st century/.test(q)) return 'programme_overview';
    if (/examination|professional|progression|probation|withdraw|graduation/.test(q)) return 'academic_policy';
    return 'general_section';
}

function inferFactType(text) {
    const q = String(text || '').toLowerCase();
    if (/duration|six[- ]year|five[- ]year|\b6 years?\b|\b5 years?\b/.test(q)) return 'programme_duration';
    if (/admission|entry|utme|direct entry|o'?level|ssce|waec|neco|credit pass/.test(q)) return 'admission_rule';
    if (/course code|credit units?|semester|level|[a-z]{2,5}\s*\d{3}/i.test(text)) return 'course_rule';
    if (/graduation|probation|withdraw|cgpa|gpa|professional examination/.test(q)) return 'progression_or_graduation_rule';
    if (/fee|tuition|payment|charge|levy|₦|naira|ngn/.test(q)) return 'fee_rule';
    return 'academic_fact';
}

function extractDurationYears(text) {
    const q = String(text || '');
    const numeric = q.match(/\b([1-9])\s*years?\b/i);
    if (numeric) return Number(numeric[1]);
    if (/six[- ]year/i.test(q)) return 6;
    if (/five[- ]year/i.test(q)) return 5;
    return null;
}

function academicFactFromLine(line, context) {
    const text = String(line || '').replace(/\s+/g, ' ').trim();
    if (text.length < 12 || text.length > 600) return null;
    const type = inferFactType(text);
    if (type === 'academic_fact' && !/\b(shall|must|required|programme|course|duration|admission|graduation|credit|semester|level)\b/i.test(text)) {
        return null;
    }
    const programme = context.programme || normalizeProgrammeName(text) || null;
    const value = {
        programme,
        section: context.section || null,
        subsection: context.subsection || null,
        text
    };
    const durationYears = extractDurationYears(text);
    if (durationYears) value.duration_years = durationYears;
    const entryMode = text.match(/\b(UTME|Direct Entry|DE)\b/i)?.[1];
    if (entryMode) value.entry_mode = /direct|de/i.test(entryMode) ? 'Direct Entry' : 'UTME';
    return {
        factType: type,
        subject: programme || context.section || context.documentTitle,
        predicate: type,
        value,
        humanText: text,
        authorityType: context.authorityType || (/ccmas|nuc/i.test(context.documentTitle) ? 'regulator' : 'institution'),
        scope: context.scope || (/ccmas|nuc/i.test(context.documentTitle) ? 'NUC national minimum' : 'BMU institutional source'),
        sourcePath: context.path
    };
}

function isProgrammeHeading(headingText, programme) {
    if (!programme) return false;
    const h = String(headingText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const p = String(programme || '').toLowerCase();
    return /\b(programme|program|department of|b\.?sc|bachelor|ll\.?b|mbbs|bds|bnsc|bmls|pharmd|b\.?pharm)\b/i.test(headingText)
        || h === p
        || h.startsWith(`${p} `);
}

function academicTableRecordFromMarkdown(tableMarkdown, context, index) {
    const rows = parseMarkdownTable(tableMarkdown);
    if (!rows.length) return null;
    const headers = Object.keys(rows[0] || {});
    const programme = context.programme || normalizeProgrammeName(`${context.section || ''} ${context.subsection || ''}`) || null;
    const tableType = inferFactType(`${headers.join(' ')} ${rows.slice(0, 3).map(row => Object.values(row).join(' ')).join(' ')}`);
    return {
        title: `${context.subsection || context.section || programme || context.documentTitle} - Table ${index + 1}`,
        tableType,
        programme,
        section: context.section || null,
        sourcePath: context.path,
        markdown: tableMarkdown.trim(),
        rows,
        metadata: {
            headers,
            rowCount: rows.length,
            discipline: context.discipline || null,
            programme,
            section: context.section || null,
            subsection: context.subsection || null
        }
    };
}

function buildAcademicParse(markdown, title) {
    const text = String(markdown || '').trim();
    const documentTitle = cleanTitle(title);
    const documentClass = classifyAcademicDocument(documentTitle, text);
    const lines = text.split(/\r?\n/);
    const nodes = [];
    const facts = [];
    const tableRecords = [];
    let current = {
        discipline: '',
        programme: '',
        section: '',
        subsection: '',
        path: documentTitle,
        suppress: false
    };
    if (documentClass.discipline) current.discipline = documentClass.discipline;
    let buffer = [];
    let order = 1;

    const flushBuffer = () => {
        const content = buffer.join('\n').trim();
        buffer = [];
        if (!content) return;
        const sectionType = detectAcademicSection(current.subsection || current.section);
        const units = splitContentUnits(content, ACADEMIC_CHUNK_TARGET);
        units.forEach((unit, index) => {
            if (!unit.trim()) return;
            const pathParts = [documentTitle, current.discipline, current.programme, current.section, current.subsection]
                .filter(Boolean);
            const pathText = pathParts.join(' -> ');
            const node = {
                nodeType: 'child_chunk',
                title: `${current.subsection || current.section || current.programme || documentTitle}${units.length > 1 ? ` - Part ${index + 1}` : ''}`,
                path: pathText,
                parentPath: pathParts.slice(0, -1).join(' -> ') || documentTitle,
                parentSummary: pathParts.slice(0, -1).join(' -> '),
                content: unit,
                metadata: {
                    discipline: current.discipline || null,
                    programme: current.programme || null,
                    section: current.section || null,
                    subsection: current.subsection || null,
                    sectionType,
                    documentClass,
                    recommendedTokens: sectionType === 'course_content' ? 'one course or logical course group' : 'logical section only'
                },
                indexable: true,
                sortOrder: order++
            };
            nodes.push(node);
            unit.split(/\r?\n|(?<=[.!?])\s+/)
                .map(line => academicFactFromLine(line, {
                    ...current,
                    documentTitle,
                    path: pathText,
                    authorityType: documentClass.authorityType,
                    scope: documentClass.family === 'ccmas' ? 'NUC national minimum' : (documentClass.family === 'professional_regulation' ? 'Professional regulatory requirement' : 'BMU institutional source')
                }))
                .filter(Boolean)
                .forEach(fact => facts.push(fact));
        });

        extractMarkdownTables(content, 50).forEach((table, tableIndex) => {
            const record = academicTableRecordFromMarkdown(table, {
                ...current,
                documentTitle,
                authorityType: documentClass.authorityType,
                scope: documentClass.family === 'ccmas' ? 'NUC national minimum' : (documentClass.family === 'professional_regulation' ? 'Professional regulatory requirement' : 'BMU institutional source'),
                path: [documentTitle, current.discipline, current.programme, current.section, current.subsection]
                    .filter(Boolean)
                    .join(' -> ')
            }, tableRecords.length + tableIndex);
            if (!record) return;
            tableRecords.push(record);
            record.rows.forEach(row => {
                const rowText = Object.entries(row).map(([key, value]) => `${key}: ${value}`).join('; ');
                const fact = academicFactFromLine(rowText, {
                    ...current,
                    documentTitle,
                    path: record.sourcePath
                });
                if (fact) {
                    fact.value.table_row = row;
                    fact.value.table_title = record.title;
                    fact.humanText = rowText;
                    facts.push(fact);
                }
            });
        });
    };

    nodes.push({
        nodeType: 'document',
        title: documentTitle,
        path: documentTitle,
        parentPath: null,
        parentSummary: '',
        content: `Document source: ${documentTitle}`,
        metadata: { documentTitle, documentClass },
        indexable: false,
        sortOrder: 0
    });

    for (const rawLine of lines) {
        const line = rawLine.trim();
        const heading = line.match(/^(#{1,4})\s+(.{3,160})$/) || (/^[A-Z][A-Z0-9 ,.'&()/:-]{8,}$/.test(line) ? ['', '##', line] : null);
        if (heading) {
            flushBuffer();
            const level = heading[1].length || 2;
            const headingText = cleanTitle(heading[2]);
            if (isBoilerplateHeading(headingText)) {
                current.suppress = true;
                current.section = headingText;
                current.subsection = '';
                continue;
            }
            current.suppress = false;
            const programme = normalizeProgrammeName(headingText);
            if (isProgrammeHeading(headingText, programme)) {
                current.programme = programme;
                current.section = '';
                current.subsection = '';
            } else if (level <= 2) {
                current.section = headingText;
                current.subsection = '';
            } else {
                current.subsection = headingText;
            }
            if (/medicine|dentistry|allied health|basic medical sciences|social sciences|sciences/i.test(headingText) && !programme) {
                current.discipline = headingText;
            }
            current.path = [documentTitle, current.discipline, current.programme, current.section, current.subsection]
                .filter(Boolean)
                .join(' -> ');
            const parentPath = programme
                ? [documentTitle, current.discipline].filter(Boolean).join(' -> ')
                : (level <= 2
                    ? [documentTitle, current.discipline, current.programme].filter(Boolean).join(' -> ')
                    : [documentTitle, current.discipline, current.programme, current.section].filter(Boolean).join(' -> '));
            nodes.push({
                nodeType: programme ? 'programme_parent' : (level <= 2 ? 'section_parent' : 'subsection_parent'),
                title: headingText,
                path: current.path,
                parentPath: parentPath && parentPath !== current.path ? parentPath : documentTitle,
                parentSummary: [documentTitle, current.discipline, current.programme].filter(Boolean).join(' -> '),
                content: headingText,
                metadata: {
                    discipline: current.discipline || null,
                    programme: current.programme || null,
                    section: current.section || null,
                    subsection: current.subsection || null,
                    sectionType: detectAcademicSection(headingText),
                    documentClass
                },
                indexable: false,
                sortOrder: order++
            });
            continue;
        }
        if (current.suppress || isBoilerplateLine(line)) continue;
        if (stripMarkdownTableSeparator(line)) {
            buffer.push(rawLine);
            continue;
        }
        buffer.push(rawLine);
    }
    flushBuffer();

    return {
        nodes,
        facts,
        tables: tableRecords,
        stats: {
            nodes: nodes.length,
            childChunks: nodes.filter(n => n.nodeType === 'child_chunk').length,
            programmes: new Set(nodes.map(n => n.metadata?.programme).filter(Boolean)).size,
            facts: facts.length,
            tables: tableRecords.length,
            documentClass
        }
    };
}

class DocumentLabService {
    async ensureDirs() {
        await fs.mkdir(LAB_DIR, { recursive: true });
        await fs.mkdir(PROMOTED_DIR, { recursive: true });
    }

    async ensureSchema() {
        if (schemaEnsured) return true;
        await this.ensureDirs();
        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                source_document_id INT NULL,
                title VARCHAR(255) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                file_path VARCHAR(500) NOT NULL,
                file_type VARCHAR(50) NOT NULL,
                file_size INT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'needs_review',
                issue_type VARCHAR(60) NOT NULL DEFAULT 'needs_review',
                extracted_text LONGTEXT NULL,
                repaired_text LONGTEXT NULL,
                review_status VARCHAR(32) NULL,
                review_score DECIMAL(5,2) NULL,
                review_json LONGTEXT NULL,
                recommendations_json LONGTEXT NULL,
                uploaded_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_lab_status (status),
                INDEX idx_lab_issue (issue_type),
                INDEX idx_lab_source_document (source_document_id)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_outputs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                job_id INT NOT NULL,
                title VARCHAR(255) NOT NULL,
                output_type VARCHAR(50) NOT NULL DEFAULT 'cleaned_markdown',
                content_markdown LONGTEXT NOT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'draft',
                readiness_status VARCHAR(32) NULL,
                readiness_score DECIMAL(5,2) NULL,
                readiness_json LONGTEXT NULL,
                sort_order INT NOT NULL DEFAULT 0,
                promoted_document_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_lab_output_job (job_id),
                INDEX idx_lab_output_status (status),
                CONSTRAINT fk_lab_outputs_job FOREIGN KEY (job_id) REFERENCES document_lab_jobs(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_nodes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                job_id INT NOT NULL,
                parent_id INT NULL,
                node_type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                hierarchy_path TEXT,
                parent_summary TEXT,
                content LONGTEXT,
                metadata_json LONGTEXT NULL,
                indexable BOOLEAN DEFAULT TRUE,
                sort_order INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_lab_nodes_job (job_id),
                INDEX idx_lab_nodes_type (node_type),
                INDEX idx_lab_nodes_indexable (indexable),
                CONSTRAINT fk_lab_nodes_job FOREIGN KEY (job_id) REFERENCES document_lab_jobs(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_facts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                job_id INT NOT NULL,
                node_id INT NULL,
                fact_type VARCHAR(80) NOT NULL,
                subject VARCHAR(255) NULL,
                predicate_name VARCHAR(120) NULL,
                value_json LONGTEXT NULL,
                human_text TEXT NOT NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'draft',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_lab_facts_job (job_id),
                INDEX idx_lab_facts_type (fact_type),
                INDEX idx_lab_facts_status (status),
                CONSTRAINT fk_lab_facts_job FOREIGN KEY (job_id) REFERENCES document_lab_jobs(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS document_lab_tables (
                id INT AUTO_INCREMENT PRIMARY KEY,
                job_id INT NOT NULL,
                node_id INT NULL,
                title VARCHAR(255) NOT NULL,
                table_type VARCHAR(80) NULL,
                programme VARCHAR(255) NULL,
                section_label VARCHAR(255) NULL,
                source_path TEXT NULL,
                markdown LONGTEXT NOT NULL,
                rows_json LONGTEXT NOT NULL,
                metadata_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'draft',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_lab_tables_job (job_id),
                INDEX idx_lab_tables_status (status),
                INDEX idx_lab_tables_type (table_type),
                CONSTRAINT fk_lab_tables_job FOREIGN KEY (job_id) REFERENCES document_lab_jobs(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS structured_facts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lab_fact_id INT NULL,
                source_document_id INT NULL,
                fact_type VARCHAR(80) NOT NULL,
                subject VARCHAR(255) NULL,
                predicate_name VARCHAR(120) NULL,
                value_json LONGTEXT NULL,
                human_text TEXT NOT NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                currentness_label VARCHAR(80) NOT NULL DEFAULT 'current',
                authority_rank INT NOT NULL DEFAULT 70,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_structured_facts_type (fact_type),
                INDEX idx_structured_facts_status (status),
                INDEX idx_structured_facts_subject (subject),
                FULLTEXT INDEX ft_structured_facts (subject, human_text, source_path)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS structured_tables (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lab_table_id INT NULL,
                source_document_id INT NULL,
                title VARCHAR(255) NOT NULL,
                table_type VARCHAR(80) NULL,
                programme VARCHAR(255) NULL,
                section_label VARCHAR(255) NULL,
                source_path TEXT NULL,
                markdown LONGTEXT NOT NULL,
                rows_json LONGTEXT NOT NULL,
                metadata_json LONGTEXT NULL,
                authority_rank INT NOT NULL DEFAULT 70,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                currentness_label VARCHAR(80) NOT NULL DEFAULT 'current',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_structured_tables_status (status),
                INDEX idx_structured_tables_type (table_type),
                INDEX idx_structured_tables_programme (programme),
                FULLTEXT INDEX ft_structured_tables (title, programme, section_label, source_path)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS academic_programmes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                record_hash CHAR(40) NOT NULL,
                source_fact_id INT NULL,
                source_table_id INT NULL,
                source_document_id INT NULL,
                programme VARCHAR(255) NOT NULL,
                faculty VARCHAR(255) NULL,
                department VARCHAR(255) NULL,
                degree VARCHAR(120) NULL,
                duration_years DECIMAL(4,1) NULL,
                entry_mode VARCHAR(120) NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                raw_text TEXT NULL,
                row_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_academic_programmes_hash (record_hash),
                INDEX idx_academic_programmes_status (status),
                INDEX idx_academic_programmes_programme (programme),
                INDEX idx_academic_programmes_source_fact (source_fact_id),
                INDEX idx_academic_programmes_source_table (source_table_id)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS academic_courses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                record_hash CHAR(40) NOT NULL,
                source_fact_id INT NULL,
                source_table_id INT NULL,
                source_document_id INT NULL,
                programme VARCHAR(255) NULL,
                level_label VARCHAR(80) NULL,
                semester_label VARCHAR(80) NULL,
                course_code VARCHAR(40) NULL,
                course_title VARCHAR(255) NULL,
                credit_units DECIMAL(4,1) NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                raw_text TEXT NULL,
                row_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_academic_courses_hash (record_hash),
                INDEX idx_academic_courses_status (status),
                INDEX idx_academic_courses_code (course_code),
                INDEX idx_academic_courses_programme (programme)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS academic_fees (
                id INT AUTO_INCREMENT PRIMARY KEY,
                record_hash CHAR(40) NOT NULL,
                source_fact_id INT NULL,
                source_table_id INT NULL,
                source_document_id INT NULL,
                programme VARCHAR(255) NULL,
                fee_category VARCHAR(255) NULL,
                amount_label VARCHAR(80) NULL,
                amount_value DECIMAL(14,2) NULL,
                session_label VARCHAR(80) NULL,
                student_category VARCHAR(160) NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                raw_text TEXT NULL,
                row_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_academic_fees_hash (record_hash),
                INDEX idx_academic_fees_status (status),
                INDEX idx_academic_fees_programme (programme),
                INDEX idx_academic_fees_category (fee_category)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS academic_calendar_events (
                id INT AUTO_INCREMENT PRIMARY KEY,
                record_hash CHAR(40) NOT NULL,
                source_fact_id INT NULL,
                source_table_id INT NULL,
                source_document_id INT NULL,
                event_title VARCHAR(255) NOT NULL,
                event_date_label VARCHAR(160) NULL,
                session_label VARCHAR(80) NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                raw_text TEXT NULL,
                row_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_academic_calendar_hash (record_hash),
                INDEX idx_academic_calendar_status (status),
                INDEX idx_academic_calendar_title (event_title)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS academic_officers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                record_hash CHAR(40) NOT NULL,
                source_fact_id INT NULL,
                source_table_id INT NULL,
                source_document_id INT NULL,
                office VARCHAR(160) NOT NULL,
                officer_name VARCHAR(255) NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                raw_text TEXT NULL,
                row_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_academic_officers_hash (record_hash),
                INDEX idx_academic_officers_status (status),
                INDEX idx_academic_officers_office (office),
                INDEX idx_academic_officers_name (officer_name)
            ) ENGINE=InnoDB
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS academic_rules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                record_hash CHAR(40) NOT NULL,
                source_fact_id INT NULL,
                source_table_id INT NULL,
                source_document_id INT NULL,
                rule_type VARCHAR(80) NOT NULL,
                subject VARCHAR(255) NULL,
                programme VARCHAR(255) NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                raw_text TEXT NOT NULL,
                row_json LONGTEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_academic_rules_hash (record_hash),
                INDEX idx_academic_rules_status (status),
                INDEX idx_academic_rules_type (rule_type),
                INDEX idx_academic_rules_programme (programme),
                INDEX idx_academic_rules_subject (subject)
            ) ENGINE=InnoDB
        `);

        schemaEnsured = true;
        return true;
    }

    async listJobs(limit = 100) {
        await this.ensureSchema();
        const rows = await query(`
            SELECT j.*,
                   (SELECT COUNT(*) FROM document_lab_outputs o WHERE o.job_id = j.id) AS output_count,
                   (SELECT COUNT(*) FROM document_lab_outputs o WHERE o.job_id = j.id AND o.status = 'promoted') AS promoted_count
            FROM document_lab_jobs j
            ORDER BY j.updated_at DESC
            LIMIT ?
        `, [Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300)]);
        return rows.map(row => this._shapeJob(row));
    }

    async getJob(jobId) {
        await this.ensureSchema();
        const jobs = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = jobs[0];
        if (!job) return null;
        const outputs = await query('SELECT * FROM document_lab_outputs WHERE job_id = ? ORDER BY sort_order ASC, id ASC', [jobId]);
        const facts = await query('SELECT * FROM document_lab_facts WHERE job_id = ? ORDER BY status ASC, fact_type ASC, id ASC LIMIT 500', [jobId]);
        const tables = await query('SELECT * FROM document_lab_tables WHERE job_id = ? ORDER BY status ASC, table_type ASC, id ASC LIMIT 200', [jobId]);
        return {
            ...this._shapeJob(job),
            outputs: outputs.map(output => this._shapeOutput(output)),
            facts: facts.map(fact => this._shapeFact(fact)),
            tables: tables.map(table => this._shapeTable(table))
        };
    }

    async createFromUpload(file, userId, metadata = {}) {
        await this.ensureSchema();
        const title = cleanTitle(metadata.title || file.originalname);
        const result = await query(`
            INSERT INTO document_lab_jobs
                (title, file_name, file_path, file_type, file_size, uploaded_by, status, issue_type)
            VALUES (?, ?, ?, ?, ?, ?, 'needs_review', 'needs_review')
        `, [
            title,
            file.originalname,
            file.path,
            path.extname(file.originalname).toLowerCase(),
            file.size,
            userId || null
        ]);
        return this.analyzeJob(result.insertId, { prepareOutputs: true });
    }

    async createFromDocument(documentId, userId) {
        await this.ensureSchema();
        const doc = await Document.findById(documentId);
        if (!doc) throw new Error('Document not found');
        const result = await query(`
            INSERT INTO document_lab_jobs
                (source_document_id, title, file_name, file_path, file_type, file_size, extracted_text, uploaded_by, status, issue_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', 'needs_review')
        `, [
            doc.id,
            cleanTitle(doc.title || doc.file_name),
            doc.file_name,
            doc.file_path,
            doc.file_type,
            doc.file_size,
            doc.content_text || null,
            userId || null
        ]);
        return this.analyzeJob(result.insertId, { prepareOutputs: true });
    }

    async importFlaggedDocuments(userId, options = {}) {
        await this.ensureSchema();
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 25, 1), 100);
        const includeUnreviewed = options.includeUnreviewed === true;
        const params = [];
        let where = `
            d.is_active = TRUE
            AND NOT EXISTS (
                SELECT 1 FROM document_lab_jobs j
                WHERE j.source_document_id = d.id
            )
            AND (
                d.ai_review_status IN ('needs_cleanup', 'needs_splitting', 'reject')
                OR (d.ai_review_score IS NOT NULL AND d.ai_review_score < 70)
        `;
        if (includeUnreviewed) {
            where += " OR d.ai_review_status IS NULL OR d.ai_review_status = 'not_reviewed'";
        }
        where += ')';
        params.push(limit);

        const docs = await query(`
            SELECT d.id, d.title, d.ai_review_status, d.ai_review_score
            FROM documents d
            WHERE ${where}
            ORDER BY
                CASE
                    WHEN d.ai_review_status = 'reject' THEN 0
                    WHEN d.ai_review_status = 'needs_cleanup' THEN 1
                    WHEN d.ai_review_status = 'needs_splitting' THEN 2
                    WHEN d.ai_review_score IS NULL THEN 3
                    ELSE 4
                END,
                d.ai_review_score ASC,
                d.updated_at DESC
            LIMIT ?
        `, params);

        const results = [];
        for (const doc of docs) {
            try {
                const job = await this.createFromDocument(doc.id, userId);
                results.push({ success: true, documentId: doc.id, title: doc.title, jobId: job.id, issueType: job.issueType });
            } catch (error) {
                results.push({ success: false, documentId: doc.id, title: doc.title, error: error.message });
            }
        }

        return {
            imported: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results
        };
    }

    async analyzeJob(jobId, options = {}) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');

        let extractedText = job.extracted_text || '';
        let extractionError = null;
        if (!String(extractedText).trim()) {
            try {
                extractedText = await this.extractReadableText(job.file_path);
            } catch (error) {
                extractionError = error.message;
                extractedText = '';
            }
        }

        let review;
        if (extractedText.trim()) {
            review = await documentQualityService.reviewText(extractedText, {
                title: job.title,
                fileType: job.file_type,
                fileSize: job.file_size
            });
        } else {
            review = {
                status: 'reject',
                score: 0,
                file: { title: job.title, fileType: job.file_type, fileSize: job.file_size },
                metrics: { textChars: 0, estimatedChunks: 0, tableSignals: 0 },
                scores: { extraction: 0, structure: 0, categorization: 0, embedding: 0, authority: 0 },
                suggestedCategory: 'general',
                suggestedTags: [],
                suggestedAuthorityRank: 50,
                suggestedAuthorityLabel: 'Standard',
                warnings: [extractionError || 'No readable text could be extracted.'],
                recommendations: ['Ask the document owner for a readable PDF, Word file, or clean OCR scan.'],
                preview: ''
            };
        }

        const cleaned = markdownClean(extractedText, job.title);
        const issueType = detectIssue(review);
        const recommendations = buildRecommendations(issueType, review, cleaned.convertedTables);
        const status = issueType === 'ready_for_approval' ? 'ready_for_approval' : 'needs_repair';

        await query(`
            UPDATE document_lab_jobs
            SET extracted_text = ?,
                repaired_text = ?,
                status = ?,
                issue_type = ?,
                review_status = ?,
                review_score = ?,
                review_json = ?,
                recommendations_json = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [
            extractedText || null,
            cleaned.markdown || null,
            status,
            issueType,
            review.status,
            review.score,
            JSON.stringify(review),
            JSON.stringify(recommendations),
            jobId
        ]);

        if (options.prepareOutputs !== false && extractedText.trim()) {
            const existing = await query('SELECT COUNT(*) AS count FROM document_lab_outputs WHERE job_id = ?', [jobId]);
            if (!existing[0].count) {
                await this.prepareOutputs(jobId);
            }
        }

        return this.getJob(jobId);
    }

    async extractReadableText(filePath) {
        if (isImageFile(filePath)) {
            try {
                return execFileSync('tesseract', [filePath, 'stdout', '-l', 'eng'], {
                    timeout: 120000,
                    maxBuffer: 20 * 1024 * 1024
                }).toString();
            } catch (error) {
                throw new Error('Image OCR failed or Tesseract is not available.');
            }
        }
        return documentProcessor.extractText(filePath);
    }

    async prepareOutputs(jobId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        if (!String(job.repaired_text || '').trim()) {
            throw new Error('No cleaned text is available for this job.');
        }

        await query("DELETE FROM document_lab_outputs WHERE job_id = ? AND status IN ('draft', 'needs_review', 'approved')", [jobId]);

        const review = safeJson(job.review_json, {});
        const shouldSplit = (review?.metrics?.estimatedChunks || 0) > 500 || job.issue_type === 'needs_splitting';
        const parts = shouldSplit
            ? splitByHeadings(job.repaired_text, job.title)
            : [{ title: job.title, content: job.repaired_text }];

        let order = 1;
        for (const part of parts) {
            const title = parts.length > 1 ? `${cleanTitle(job.title)} - ${cleanTitle(part.title)}`
                : cleanTitle(part.title || job.title);
            const outputType = parts.length > 1 ? 'split_part' : 'cleaned_markdown';
            const readiness = await documentQualityService.reviewText(part.content, {
                title,
                fileType: '.md',
                fileSize: Buffer.byteLength(part.content, 'utf8')
            });
            await query(`
                INSERT INTO document_lab_outputs
                    (job_id, title, output_type, content_markdown, status, readiness_status, readiness_score, readiness_json, sort_order)
                VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
            `, [
                jobId,
                title.slice(0, 255),
                outputType,
                part.content,
                readiness.status,
                readiness.score,
                JSON.stringify(readiness),
                order++
            ]);
        }

        return this.getJob(jobId);
    }

    async buildSplitPlan(jobId, options = {}) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        if (!String(job.repaired_text || '').trim()) {
            throw new Error('No cleaned text is available for this job.');
        }

        const review = safeJson(job.review_json, {});
        const targetChars = Math.min(Math.max(parseInt(options.targetChars, 10) || DEFAULT_TARGET_CHARS, 4000), 30000);
        const shouldSplit = (review?.metrics?.estimatedChunks || 0) > 500 || job.issue_type === 'needs_splitting';
        let rawParts = shouldSplit
            ? splitByHeadings(job.repaired_text, job.title, targetChars)
            : [{ title: job.title, content: job.repaired_text }];
        if (shouldSplit && rawParts.length <= 1 && String(job.repaired_text || '').length > targetChars) {
            rawParts = splitByHeadings(job.repaired_text, job.title, Math.max(4500, Math.floor(targetChars * 0.55)));
        }

        const parts = [];
        let order = 1;
        for (const part of rawParts) {
            const title = rawParts.length > 1
                ? `${cleanTitle(job.title)} - ${cleanTitle(part.title)}`
                : cleanTitle(part.title || job.title);
            const readiness = await documentQualityService.reviewText(part.content, {
                title,
                fileType: '.md',
                fileSize: Buffer.byteLength(part.content, 'utf8')
            });
            parts.push({
                clientId: `part-${order}`,
                sortOrder: order,
                title: title.slice(0, 255),
                contentMarkdown: part.content,
                charCount: part.content.length,
                estimatedChunks: readiness.metrics?.estimatedChunks || 0,
                readinessStatus: readiness.status,
                readinessScore: readiness.score,
                readiness
            });
            order++;
        }

        return {
            jobId: job.id,
            title: job.title,
            issueType: job.issue_type,
            targetChars,
            strategy: shouldSplit ? 'heading_and_size_split' : 'single_cleaned_output',
            partCount: parts.length,
            parts
        };
    }

    async createOutputsFromPlan(jobId, parts = []) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        if (!Array.isArray(parts) || !parts.length) {
            throw new Error('No approved split parts were submitted.');
        }

        await query("DELETE FROM document_lab_outputs WHERE job_id = ? AND status IN ('draft', 'needs_review', 'approved')", [jobId]);
        let order = 1;
        for (const part of parts) {
            const title = cleanTitle(part.title || `${job.title} - Part ${order}`);
            const content = String(part.contentMarkdown || '').trim();
            if (!content) continue;
            const readiness = await documentQualityService.reviewText(content, {
                title,
                fileType: '.md',
                fileSize: Buffer.byteLength(content, 'utf8')
            });
            await query(`
                INSERT INTO document_lab_outputs
                    (job_id, title, output_type, content_markdown, status, readiness_status, readiness_score, readiness_json, sort_order)
                VALUES (?, ?, 'split_part', ?, 'draft', ?, ?, ?, ?)
            `, [
                jobId,
                title.slice(0, 255),
                content,
                readiness.status,
                readiness.score,
                JSON.stringify(readiness),
                order++
            ]);
        }

        if (order === 1) throw new Error('No non-empty approved parts were submitted.');
        await query("UPDATE document_lab_jobs SET status = 'ready_for_approval', updated_at = NOW() WHERE id = ?", [jobId]);
        return this.getJob(jobId);
    }

    async createStructuredDigest(jobId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        const sourceText = String(job.repaired_text || job.extracted_text || '').trim();
        if (!sourceText) throw new Error('No cleaned text is available for structured digest generation.');

        const built = buildStructuredDigest(sourceText, job.title);
        const title = `${cleanTitle(job.title)} - Structured Digest`;
        const readiness = await documentQualityService.reviewText(built.digest, {
            title,
            fileType: '.md',
            fileSize: Buffer.byteLength(built.digest, 'utf8')
        });

        await query("DELETE FROM document_lab_outputs WHERE job_id = ? AND output_type = 'structured_digest' AND status IN ('draft', 'needs_review', 'approved')", [jobId]);
        const maxOrder = await query('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM document_lab_outputs WHERE job_id = ?', [jobId]);
        await query(`
            INSERT INTO document_lab_outputs
                (job_id, title, output_type, content_markdown, status, readiness_status, readiness_score, readiness_json, sort_order)
            VALUES (?, ?, 'structured_digest', ?, 'draft', ?, ?, ?, ?)
        `, [
            jobId,
            title.slice(0, 255),
            built.digest,
            readiness.status,
            readiness.score,
            JSON.stringify({
                ...readiness,
                digestMetrics: built.metrics
            }),
            Number(maxOrder[0]?.max_order || 0) + 1
        ]);

        await query("UPDATE document_lab_jobs SET status = 'ready_for_approval', updated_at = NOW() WHERE id = ?", [jobId]);
        return this.getJob(jobId);
    }

    async createAcademicParse(jobId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = rows[0];
        if (!job) throw new Error('Lab job not found');
        const sourceText = String(job.repaired_text || job.extracted_text || '').trim();
        if (!sourceText) throw new Error('No cleaned text is available for academic parsing.');

        const parsed = buildAcademicParse(sourceText, job.title);
        await query('DELETE FROM document_lab_nodes WHERE job_id = ?', [jobId]);
        await query('DELETE FROM document_lab_facts WHERE job_id = ?', [jobId]);
        await query('DELETE FROM document_lab_tables WHERE job_id = ?', [jobId]);
        await query("DELETE FROM document_lab_outputs WHERE job_id = ? AND output_type = 'academic_chunk' AND status IN ('draft', 'needs_review', 'approved')", [jobId]);

        const nodeIds = new Map();
        for (const node of parsed.nodes) {
            const parentId = node.parentPath ? nodeIds.get(node.parentPath) || null : null;
            const result = await query(`
                INSERT INTO document_lab_nodes
                    (job_id, parent_id, node_type, title, hierarchy_path, parent_summary, content, metadata_json, indexable, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                jobId,
                parentId,
                node.nodeType,
                node.title,
                node.path,
                node.parentSummary,
                node.content,
                JSON.stringify(node.metadata || {}),
                node.indexable ? 1 : 0,
                node.sortOrder
            ]);
            if (!nodeIds.has(node.path)) nodeIds.set(node.path, result.insertId);
            nodeIds.set(node.path + '|' + node.sortOrder, result.insertId);

            if (node.nodeType === 'child_chunk' && node.indexable) {
                const content = `Parent context: ${node.parentSummary || node.path}\n\n${node.content}`;
                const readiness = await documentQualityService.reviewText(content, {
                    title: node.title,
                    fileType: '.md',
                    fileSize: Buffer.byteLength(content, 'utf8')
                });
                await query(`
                    INSERT INTO document_lab_outputs
                        (job_id, title, output_type, content_markdown, status, readiness_status, readiness_score, readiness_json, sort_order)
                    VALUES (?, ?, 'academic_chunk', ?, 'draft', ?, ?, ?, ?)
                `, [
                    jobId,
                    node.title.slice(0, 255),
                    content,
                    readiness.status,
                    readiness.score,
                    JSON.stringify(readiness),
                    node.sortOrder
                ]);
            }
        }

        for (const tableRecord of parsed.tables.slice(0, 500)) {
            const nodeId = tableRecord.sourcePath ? nodeIds.get(tableRecord.sourcePath) || null : null;
            await query(`
                INSERT INTO document_lab_tables
                    (job_id, node_id, title, table_type, programme, section_label, source_path, markdown, rows_json, metadata_json, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
            `, [
                jobId,
                nodeId,
                tableRecord.title.slice(0, 255),
                tableRecord.tableType || null,
                tableRecord.programme || null,
                tableRecord.section || null,
                tableRecord.sourcePath || null,
                tableRecord.markdown,
                JSON.stringify(tableRecord.rows || []),
                JSON.stringify(tableRecord.metadata || {})
            ]);
        }

        for (const fact of parsed.facts.slice(0, 2000)) {
            await query(`
                INSERT INTO document_lab_facts
                    (job_id, node_id, fact_type, subject, predicate_name, value_json, human_text, authority_type, scope_label, source_path, status)
                VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
            `, [
                jobId,
                fact.factType,
                fact.subject || null,
                fact.predicate || null,
                JSON.stringify(fact.value || {}),
                fact.humanText,
                fact.authorityType || null,
                fact.scope || null,
                fact.sourcePath || null
            ]);
        }

        const recommendations = safeJson(job.recommendations_json, []);
        recommendations.unshift(`Academic parse created ${parsed.stats.childChunks} hierarchy-safe chunk(s), ${parsed.stats.tables} structured table(s), and ${parsed.stats.facts} draft structured fact(s).`);
        await query(
            "UPDATE document_lab_jobs SET status = 'ready_for_approval', recommendations_json = ?, updated_at = NOW() WHERE id = ?",
            [JSON.stringify(Array.from(new Set(recommendations)).slice(0, 12)), jobId]
        );
        return {
            ...(await this.getJob(jobId)),
            academicParse: parsed.stats
        };
    }

    async approveAcademicFacts(jobId) {
        await this.ensureSchema();
        const jobRows = await query('SELECT * FROM document_lab_jobs WHERE id = ?', [jobId]);
        const job = jobRows[0];
        if (!job) throw new Error('Lab job not found');
        const facts = await query("SELECT * FROM document_lab_facts WHERE job_id = ? AND status = 'draft'", [jobId]);
        const tables = await query("SELECT * FROM document_lab_tables WHERE job_id = ? AND status = 'draft'", [jobId]);
        let approved = 0;
        for (const fact of facts) {
            await this._approveFactRow(fact, job);
            approved++;
        }
        let approvedTables = 0;
        for (const tableRecord of tables) {
            await this._approveTableRow(tableRecord, job);
            approvedTables++;
        }
        return { approved, approvedTables };
    }

    async updateFact(factId, updates = {}) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_facts WHERE id = ?', [factId]);
        const fact = rows[0];
        if (!fact) throw new Error('Lab fact not found');
        if (fact.status === 'approved') throw new Error('Approved facts cannot be edited. Regenerate the academic parse to revise.');

        let valueJson = fact.value_json;
        if (typeof updates.valueJson === 'string') {
            JSON.parse(updates.valueJson || '{}');
            valueJson = updates.valueJson;
        } else if (updates.value && typeof updates.value === 'object') {
            valueJson = JSON.stringify(updates.value);
        }

        await query(`
            UPDATE document_lab_facts
            SET fact_type = ?, subject = ?, predicate_name = ?, value_json = ?, human_text = ?,
                authority_type = ?, scope_label = ?, source_path = ?, status = ?, updated_at = NOW()
            WHERE id = ?
        `, [
            cleanTitle(updates.factType || fact.fact_type).slice(0, 80),
            updates.subject ?? fact.subject,
            updates.predicate ?? fact.predicate_name,
            valueJson,
            String(updates.humanText ?? fact.human_text).trim(),
            updates.authorityType ?? fact.authority_type,
            updates.scope ?? fact.scope_label,
            updates.sourcePath ?? fact.source_path,
            updates.status && ['draft', 'rejected'].includes(updates.status) ? updates.status : fact.status,
            factId
        ]);
        const updated = await query('SELECT * FROM document_lab_facts WHERE id = ?', [factId]);
        return this._shapeFact(updated[0]);
    }

    async updateTable(tableId, updates = {}) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_tables WHERE id = ?', [tableId]);
        const table = rows[0];
        if (!table) throw new Error('Lab table not found');
        if (table.status === 'approved') throw new Error('Approved tables cannot be edited. Regenerate the academic parse to revise.');

        let rowsJson = table.rows_json;
        if (typeof updates.rowsJson === 'string') {
            JSON.parse(updates.rowsJson || '[]');
            rowsJson = updates.rowsJson;
        } else if (Array.isArray(updates.rows)) {
            rowsJson = JSON.stringify(updates.rows);
        }

        await query(`
            UPDATE document_lab_tables
            SET title = ?, table_type = ?, programme = ?, section_label = ?, source_path = ?,
                markdown = ?, rows_json = ?, status = ?, updated_at = NOW()
            WHERE id = ?
        `, [
            cleanTitle(updates.title || table.title).slice(0, 255),
            updates.tableType ?? table.table_type,
            updates.programme ?? table.programme,
            updates.section ?? table.section_label,
            updates.sourcePath ?? table.source_path,
            String(updates.markdown ?? table.markdown).trim(),
            rowsJson,
            updates.status && ['draft', 'rejected'].includes(updates.status) ? updates.status : table.status,
            tableId
        ]);
        const updated = await query('SELECT * FROM document_lab_tables WHERE id = ?', [tableId]);
        return this._shapeTable(updated[0]);
    }

    async approveFact(factId) {
        await this.ensureSchema();
        const rows = await query(`
            SELECT f.*, j.source_document_id, j.title AS job_title
            FROM document_lab_facts f
            JOIN document_lab_jobs j ON j.id = f.job_id
            WHERE f.id = ?
        `, [factId]);
        const fact = rows[0];
        if (!fact) throw new Error('Lab fact not found');
        if (fact.status === 'approved') return { approved: 0, fact: this._shapeFact(fact) };
        if (fact.status === 'rejected') throw new Error('Rejected facts must be restored to draft before approval.');
        await this._approveFactRow(fact, { source_document_id: fact.source_document_id, title: fact.job_title });
        const updated = await query('SELECT * FROM document_lab_facts WHERE id = ?', [factId]);
        return { approved: 1, fact: this._shapeFact(updated[0]) };
    }

    async approveTable(tableId) {
        await this.ensureSchema();
        const rows = await query(`
            SELECT t.*, j.source_document_id, j.title AS job_title
            FROM document_lab_tables t
            JOIN document_lab_jobs j ON j.id = t.job_id
            WHERE t.id = ?
        `, [tableId]);
        const table = rows[0];
        if (!table) throw new Error('Lab table not found');
        if (table.status === 'approved') return { approvedTables: 0, table: this._shapeTable(table) };
        if (table.status === 'rejected') throw new Error('Rejected tables must be restored to draft before approval.');
        await this._approveTableRow(table, { source_document_id: table.source_document_id, title: table.job_title });
        const updated = await query('SELECT * FROM document_lab_tables WHERE id = ?', [tableId]);
        return { approvedTables: 1, table: this._shapeTable(updated[0]) };
    }

    async setFactStatus(factId, status) {
        await this.ensureSchema();
        if (!['draft', 'rejected'].includes(status)) throw new Error('Unsupported fact status');
        await query("UPDATE document_lab_facts SET status = ?, updated_at = NOW() WHERE id = ? AND status <> 'approved'", [status, factId]);
        const rows = await query('SELECT * FROM document_lab_facts WHERE id = ?', [factId]);
        if (!rows[0]) throw new Error('Lab fact not found');
        return this._shapeFact(rows[0]);
    }

    async setTableStatus(tableId, status) {
        await this.ensureSchema();
        if (!['draft', 'rejected'].includes(status)) throw new Error('Unsupported table status');
        await query("UPDATE document_lab_tables SET status = ?, updated_at = NOW() WHERE id = ? AND status <> 'approved'", [status, tableId]);
        const rows = await query('SELECT * FROM document_lab_tables WHERE id = ?', [tableId]);
        if (!rows[0]) throw new Error('Lab table not found');
        return this._shapeTable(rows[0]);
    }

    async getNormalizedAcademicStats() {
        await this.ensureSchema();
        const counts = {};
        for (const tableName of NORMALIZED_TABLES) {
            const rows = await query(`SELECT COUNT(*) AS count FROM ${tableName} WHERE status = 'active'`);
            counts[tableName] = Number(rows?.[0]?.count || 0);
        }
        const factRows = await query("SELECT COUNT(*) AS count FROM structured_facts WHERE status = 'active'");
        const tableRows = await query("SELECT COUNT(*) AS count FROM structured_tables WHERE status = 'active'");
        return {
            structuredFacts: Number(factRows?.[0]?.count || 0),
            structuredTables: Number(tableRows?.[0]?.count || 0),
            normalizedTotal: Object.values(counts).reduce((sum, count) => sum + count, 0),
            counts
        };
    }

    async backfillNormalizedAcademicRecords(options = {}) {
        await this.ensureSchema();
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 250);
        const afterFactId = Math.max(parseInt(options.afterFactId, 10) || 0, 0);
        const afterTableId = Math.max(parseInt(options.afterTableId, 10) || 0, 0);
        const facts = await query(`
            SELECT *, id AS structured_fact_id
            FROM structured_facts
            WHERE status = 'active'
              AND id > ?
            ORDER BY id ASC
            LIMIT ?
        `, [afterFactId, limit]);
        const tables = await query(`
            SELECT *, id AS structured_table_id
            FROM structured_tables
            WHERE status = 'active'
              AND id > ?
            ORDER BY id ASC
            LIMIT ?
        `, [afterTableId, limit]);

        let normalizedFacts = 0;
        let normalizedTables = 0;
        let lastFactId = afterFactId;
        let lastTableId = afterTableId;
        for (const fact of facts || []) {
            normalizedFacts += await this._syncNormalizedFromFact(fact);
            lastFactId = Math.max(lastFactId, Number(fact.id || fact.structured_fact_id || 0));
        }
        for (const tableRecord of tables || []) {
            normalizedTables += await this._syncNormalizedFromTable(tableRecord);
            lastTableId = Math.max(lastTableId, Number(tableRecord.id || tableRecord.structured_table_id || 0));
        }

        return {
            factsScanned: facts.length,
            tablesScanned: tables.length,
            normalizedFacts,
            normalizedTables,
            afterFactId: lastFactId,
            afterTableId: lastTableId,
            done: facts.length < limit && tables.length < limit
        };
    }

    async _approveFactRow(fact, job) {
        const result = await query(`
            INSERT INTO structured_facts
                (lab_fact_id, source_document_id, fact_type, subject, predicate_name, value_json, human_text, authority_type, scope_label, source_path, status, authority_rank)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `, [
            fact.id,
            job.source_document_id || null,
            fact.fact_type,
            fact.subject,
            fact.predicate_name,
            fact.value_json,
            fact.human_text,
            fact.authority_type,
            fact.scope_label,
            fact.source_path,
            fact.authority_type === 'regulator' ? 75 : 85
        ]);
        await this._syncNormalizedFromFact({
            ...fact,
            structured_fact_id: result.insertId,
            source_document_id: job.source_document_id || null
        });
        await query("UPDATE document_lab_facts SET status = 'approved', updated_at = NOW() WHERE id = ?", [fact.id]);
    }

    async _approveTableRow(tableRecord, job) {
        const result = await query(`
            INSERT INTO structured_tables
                (lab_table_id, source_document_id, title, table_type, programme, section_label, source_path, markdown, rows_json, metadata_json, authority_rank, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `, [
            tableRecord.id,
            job.source_document_id || null,
            tableRecord.title,
            tableRecord.table_type,
            tableRecord.programme,
            tableRecord.section_label,
            tableRecord.source_path,
            tableRecord.markdown,
            tableRecord.rows_json,
            tableRecord.metadata_json,
            /ccmas|nuc/i.test(job.title || '') ? 75 : 85
        ]);
        await this._syncNormalizedFromTable({
            ...tableRecord,
            structured_table_id: result.insertId,
            source_document_id: job.source_document_id || null,
            authority_type: /ccmas|nuc/i.test(job.title || '') ? 'regulator' : 'institution'
        });
        await query("UPDATE document_lab_tables SET status = 'approved', updated_at = NOW() WHERE id = ?", [tableRecord.id]);
    }

    async _syncNormalizedFromFact(fact) {
        const text = compactText(fact.human_text || objectText(safeJson(fact.value_json, {})), 1800);
        if (!text) return 0;

        const factType = String(fact.fact_type || '').toLowerCase();
        const subject = compactText(fact.subject || '', 255) || null;
        const programme = detectProgramme(`${subject || ''} ${text}`);
        const authorityType = fact.authority_type || null;
        const scopeLabel = fact.scope_label || null;
        const sourcePath = fact.source_path || null;
        const sourceDocumentId = fact.source_document_id || null;
        const sourceFactId = fact.structured_fact_id || null;
        let inserted = 0;

        const durationYears = extractDurationYears(text);
        if (durationYears && (programme || /duration|programme/.test(factType + ' ' + text.toLowerCase()))) {
            await this._upsertNormalized('academic_programmes', {
                source_fact_id: sourceFactId,
                source_document_id: sourceDocumentId,
                programme: programme || subject || 'Unspecified programme',
                duration_years: durationYears,
                entry_mode: findField(safeJson(fact.value_json, {}), [/entry/, /mode/]),
                authority_type: authorityType,
                scope_label: scopeLabel,
                source_path: sourcePath,
                raw_text: text
            });
            inserted++;
        }

        const courseCode = extractCourseCode(text);
        if (courseCode || factType.includes('course')) {
            await this._upsertNormalized('academic_courses', {
                source_fact_id: sourceFactId,
                source_document_id: sourceDocumentId,
                programme,
                course_code: courseCode,
                course_title: subject && subject !== courseCode ? subject : null,
                credit_units: extractCourseUnits(text),
                authority_type: authorityType,
                scope_label: scopeLabel,
                source_path: sourcePath,
                raw_text: text
            });
            inserted++;
        }

        const money = extractMoney(text);
        if (money.amountLabel || factType.includes('fee')) {
            await this._upsertNormalized('academic_fees', {
                source_fact_id: sourceFactId,
                source_document_id: sourceDocumentId,
                programme,
                fee_category: subject || inferRuleType(text, 'fees'),
                amount_label: money.amountLabel,
                amount_value: money.amountValue,
                session_label: (text.match(/\b20\d{2}\s*\/\s*20\d{2}\b/) || [null])[0],
                authority_type: authorityType,
                scope_label: scopeLabel,
                source_path: sourcePath,
                raw_text: text
            });
            inserted++;
        }

        const dateLabel = extractDateLabel(text);
        if (dateLabel || factType.includes('calendar') || factType.includes('deadline')) {
            await this._upsertNormalized('academic_calendar_events', {
                source_fact_id: sourceFactId,
                source_document_id: sourceDocumentId,
                event_title: subject || compactText(text, 140),
                event_date_label: dateLabel,
                session_label: (text.match(/\b20\d{2}\s*\/\s*20\d{2}\b/) || [null])[0],
                authority_type: authorityType,
                scope_label: scopeLabel,
                source_path: sourcePath,
                raw_text: text
            });
            inserted++;
        }

        if (/\b(vc|vice chancellor|registrar|bursar|librarian|principal officer|officer)\b/i.test(`${subject || ''} ${text}`) || factType.includes('officer')) {
            await this._upsertNormalized('academic_officers', {
                source_fact_id: sourceFactId,
                source_document_id: sourceDocumentId,
                office: subject || compactText((text.match(/\b(?:vice chancellor|registrar|bursar|librarian|principal officer)\b/i) || ['Officer'])[0], 160),
                officer_name: findField(safeJson(fact.value_json, {}), [/name/, /officer/]) || (text.match(/\b(?:Prof\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}/) || [null])[0],
                authority_type: authorityType,
                scope_label: scopeLabel,
                source_path: sourcePath,
                raw_text: text
            });
            inserted++;
        }

        const ruleType = inferRuleType(`${factType} ${text}`, null);
        if (ruleType && ruleType !== 'officer') {
            await this._upsertNormalized('academic_rules', {
                source_fact_id: sourceFactId,
                source_document_id: sourceDocumentId,
                rule_type: ruleType,
                subject,
                programme,
                authority_type: authorityType,
                scope_label: scopeLabel,
                source_path: sourcePath,
                raw_text: text
            });
            inserted++;
        }

        return inserted;
    }

    async _syncNormalizedFromTable(tableRecord) {
        const rows = safeJson(tableRecord.rows_json, []);
        const sourceTableId = tableRecord.structured_table_id || null;
        const sourceDocumentId = tableRecord.source_document_id || null;
        const authorityType = tableRecord.authority_type || null;
        const scopeLabel = tableRecord.section_label || null;
        const sourcePath = tableRecord.source_path || null;
        const baseProgramme = tableRecord.programme || detectProgramme(`${tableRecord.title || ''} ${tableRecord.section_label || ''}`);
        let inserted = 0;

        for (const row of Array.isArray(rows) ? rows.slice(0, 300) : []) {
            const text = objectText(row);
            if (!text) continue;
            const programme = findField(row, [/programme/, /program/]) || baseProgramme || detectProgramme(text);
            const courseCode = findField(row, [/course code/, /^code$/]) || extractCourseCode(text);
            const title = findField(row, [/course title/, /^title$/, /course/]);
            const unitLabel = findField(row, [/unit/, /credit/]);
            const money = extractMoney(text);
            const dateLabel = findField(row, [/date/, /deadline/]) || extractDateLabel(text);
            const durationYears = extractDurationYears(text);
            const rowJson = JSON.stringify(row);

            if (courseCode || /\bcourse\b/i.test(`${tableRecord.table_type || ''} ${tableRecord.title || ''}`)) {
                await this._upsertNormalized('academic_courses', {
                    source_table_id: sourceTableId,
                    source_document_id: sourceDocumentId,
                    programme,
                    level_label: findField(row, [/level/]),
                    semester_label: findField(row, [/semester/]),
                    course_code: courseCode,
                    course_title: title && title !== courseCode ? title : null,
                    credit_units: unitLabel ? Number(String(unitLabel).match(/\d+(?:\.\d+)?/)?.[0]) || extractCourseUnits(text) : extractCourseUnits(text),
                    authority_type: authorityType,
                    scope_label: scopeLabel,
                    source_path: sourcePath,
                    raw_text: text,
                    row_json: rowJson
                });
                inserted++;
            }

            if (money.amountLabel || /\bfee|tuition|charge|levy\b/i.test(`${tableRecord.table_type || ''} ${tableRecord.title || ''} ${text}`)) {
                await this._upsertNormalized('academic_fees', {
                    source_table_id: sourceTableId,
                    source_document_id: sourceDocumentId,
                    programme,
                    fee_category: findField(row, [/fee/, /category/, /item/, /description/]) || tableRecord.title,
                    amount_label: money.amountLabel || findField(row, [/amount/, /cost/, /charge/]),
                    amount_value: money.amountValue,
                    session_label: findField(row, [/session/]) || (text.match(/\b20\d{2}\s*\/\s*20\d{2}\b/) || [null])[0],
                    student_category: findField(row, [/student/, /category/, /level/]),
                    authority_type: authorityType,
                    scope_label: scopeLabel,
                    source_path: sourcePath,
                    raw_text: text,
                    row_json: rowJson
                });
                inserted++;
            }

            if (durationYears && programme) {
                await this._upsertNormalized('academic_programmes', {
                    source_table_id: sourceTableId,
                    source_document_id: sourceDocumentId,
                    programme,
                    duration_years: durationYears,
                    entry_mode: findField(row, [/entry/, /mode/]),
                    authority_type: authorityType,
                    scope_label: scopeLabel,
                    source_path: sourcePath,
                    raw_text: text,
                    row_json: rowJson
                });
                inserted++;
            }

            if (dateLabel || /\bcalendar|deadline|resumption|registration\b/i.test(`${tableRecord.table_type || ''} ${tableRecord.title || ''} ${text}`)) {
                await this._upsertNormalized('academic_calendar_events', {
                    source_table_id: sourceTableId,
                    source_document_id: sourceDocumentId,
                    event_title: findField(row, [/event/, /activity/, /description/]) || tableRecord.title,
                    event_date_label: dateLabel,
                    session_label: findField(row, [/session/]),
                    authority_type: authorityType,
                    scope_label: scopeLabel,
                    source_path: sourcePath,
                    raw_text: text,
                    row_json: rowJson
                });
                inserted++;
            }

            if (/\b(vc|vice chancellor|registrar|bursar|librarian|principal officer|officer)\b/i.test(`${tableRecord.title || ''} ${text}`)) {
                await this._upsertNormalized('academic_officers', {
                    source_table_id: sourceTableId,
                    source_document_id: sourceDocumentId,
                    office: findField(row, [/office/, /position/, /designation/, /role/]) || tableRecord.title,
                    officer_name: findField(row, [/name/, /officer/]),
                    authority_type: authorityType,
                    scope_label: scopeLabel,
                    source_path: sourcePath,
                    raw_text: text,
                    row_json: rowJson
                });
                inserted++;
            }

            const ruleType = inferRuleType(`${tableRecord.table_type || ''} ${tableRecord.title || ''} ${text}`, null);
            if (ruleType && !['course', 'fees', 'calendar', 'officer'].includes(ruleType)) {
                await this._upsertNormalized('academic_rules', {
                    source_table_id: sourceTableId,
                    source_document_id: sourceDocumentId,
                    rule_type: ruleType,
                    subject: tableRecord.title,
                    programme,
                    authority_type: authorityType,
                    scope_label: scopeLabel,
                    source_path: sourcePath,
                    raw_text: text,
                    row_json: rowJson
                });
                inserted++;
            }
        }

        return inserted;
    }

    async _upsertNormalized(tableName, fields) {
        const allowed = new Set([
            ...NORMALIZED_TABLES
        ]);
        if (!allowed.has(tableName)) throw new Error('Unsupported normalized academic table');
        const cleaned = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
        cleaned.record_hash = stableHash(`${tableName}|${cleaned.source_fact_id || ''}|${cleaned.source_table_id || ''}|${cleaned.raw_text || ''}|${cleaned.row_json || ''}`);
        const columns = Object.keys(cleaned);
        const placeholders = columns.map(() => '?').join(', ');
        const updates = columns
            .filter(column => column !== 'record_hash')
            .map(column => `${column} = VALUES(${column})`)
            .concat("status = 'active'", 'updated_at = NOW()')
            .join(', ');
        await query(`
            INSERT INTO ${tableName} (${columns.join(', ')})
            VALUES (${placeholders})
            ON DUPLICATE KEY UPDATE ${updates}
        `, columns.map(column => cleaned[column]));
    }

    async updateOutput(outputId, updates = {}) {
        await this.ensureSchema();
        const fields = [];
        const values = [];
        if (typeof updates.title === 'string') {
            fields.push('title = ?');
            values.push(cleanTitle(updates.title));
        }
        if (typeof updates.contentMarkdown === 'string') {
            fields.push('content_markdown = ?');
            values.push(updates.contentMarkdown);
        }
        if (typeof updates.status === 'string') {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (!fields.length) throw new Error('No output updates provided');
        values.push(outputId);
        await query(`UPDATE document_lab_outputs SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, values);
        return this.reviewOutput(outputId);
    }

    async reviewOutput(outputId) {
        await this.ensureSchema();
        const rows = await query('SELECT * FROM document_lab_outputs WHERE id = ?', [outputId]);
        const output = rows[0];
        if (!output) throw new Error('Lab output not found');
        const readiness = await documentQualityService.reviewText(output.content_markdown, {
            title: output.title,
            fileType: '.md',
            fileSize: Buffer.byteLength(output.content_markdown || '', 'utf8')
        });
        await query(`
            UPDATE document_lab_outputs
            SET readiness_status = ?, readiness_score = ?, readiness_json = ?, updated_at = NOW()
            WHERE id = ?
        `, [readiness.status, readiness.score, JSON.stringify(readiness), outputId]);
        return this._shapeOutput({ ...output, readiness_status: readiness.status, readiness_score: readiness.score, readiness_json: JSON.stringify(readiness) });
    }

    async promoteOutput(outputId, userId, options = {}) {
        await this.ensureSchema();
        const rows = await query(`
            SELECT o.*, j.source_document_id, j.file_name AS source_file_name
            FROM document_lab_outputs o
            JOIN document_lab_jobs j ON j.id = o.job_id
            WHERE o.id = ?
        `, [outputId]);
        const output = rows[0];
        if (!output) throw new Error('Lab output not found');

        const readiness = safeJson(output.readiness_json, null) || await documentQualityService.reviewText(output.content_markdown, {
            title: output.title,
            fileType: '.md',
            fileSize: Buffer.byteLength(output.content_markdown || '', 'utf8')
        });
        if (!options.force && !['ready', 'ready_with_warnings'].includes(readiness.status)) {
            throw new Error('Output is not ready for promotion. Review or clean it first.');
        }

        await this.ensureDirs();
        const fileName = `${uuidv4()}.md`;
        const filePath = path.join(PROMOTED_DIR, fileName);
        await fs.writeFile(filePath, output.content_markdown, 'utf8');
        const docId = await Document.create({
            title: output.title,
            description: `Promoted from Document Lab output #${output.id}`,
            fileName,
            filePath,
            fileType: '.md',
            fileSize: Buffer.byteLength(output.content_markdown || '', 'utf8'),
            category: DOCUMENT_CATEGORIES.has(readiness.suggestedCategory) ? readiness.suggestedCategory : 'general',
            tags: readiness.suggestedTags || [],
            uploadedBy: userId || null
        });
        await Document.updateContentText(docId, output.content_markdown);
        await documentQualityService.saveReview(docId, readiness);
        await query(
            "UPDATE document_lab_outputs SET status = 'promoted', promoted_document_id = ?, updated_at = NOW() WHERE id = ?",
            [docId, outputId]
        );
        await query("UPDATE document_lab_jobs SET status = 'promoted', updated_at = NOW() WHERE id = ?", [output.job_id]);
        return { documentId: docId, output: await this.reviewOutput(outputId) };
    }

    _shapeJob(row) {
        return {
            id: row.id,
            sourceDocumentId: row.source_document_id,
            title: row.title,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            status: row.status,
            issueType: row.issue_type,
            reviewStatus: row.review_status,
            reviewScore: row.review_score,
            review: safeJson(row.review_json, null),
            recommendations: safeJson(row.recommendations_json, []),
            outputCount: Number(row.output_count || 0),
            promotedCount: Number(row.promoted_count || 0),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    _shapeOutput(row) {
        return {
            id: row.id,
            jobId: row.job_id,
            title: row.title,
            outputType: row.output_type,
            contentMarkdown: row.content_markdown,
            status: row.status,
            readinessStatus: row.readiness_status,
            readinessScore: row.readiness_score,
            readiness: safeJson(row.readiness_json, null),
            sortOrder: row.sort_order,
            promotedDocumentId: row.promoted_document_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    _shapeFact(row) {
        return {
            id: row.id,
            jobId: row.job_id,
            nodeId: row.node_id,
            factType: row.fact_type,
            subject: row.subject,
            predicate: row.predicate_name,
            value: safeJson(row.value_json, {}),
            valueJson: row.value_json,
            humanText: row.human_text,
            authorityType: row.authority_type,
            scope: row.scope_label,
            sourcePath: row.source_path,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    _shapeTable(row) {
        return {
            id: row.id,
            jobId: row.job_id,
            nodeId: row.node_id,
            title: row.title,
            tableType: row.table_type,
            programme: row.programme,
            section: row.section_label,
            sourcePath: row.source_path,
            markdown: row.markdown,
            rows: safeJson(row.rows_json, []),
            rowsJson: row.rows_json,
            metadata: safeJson(row.metadata_json, {}),
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = new DocumentLabService();
