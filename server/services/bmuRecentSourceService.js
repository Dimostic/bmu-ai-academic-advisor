const crypto = require('crypto');
const { query } = require('../../config/db');
const documentLabService = require('./documentLabService');

let recentFactsSchemaPatchEnsured = false;

const DEFAULT_SOURCES = [
    {
        source_name: 'BMU Official Website',
        source_type: 'website',
        source_url: 'https://bmu.edu.ng/',
        authority_type: 'institution',
        source_rank: 100,
        check_frequency_hours: 12,
        notes: 'Official Bayelsa Medical University website. Use for public notices, admissions, news and portals.'
    },
    {
        source_name: 'BMU Facebook',
        source_type: 'social_facebook',
        source_url: 'https://www.facebook.com/BMUYenagoa',
        authority_type: 'institution_social',
        source_rank: 82,
        check_frequency_hours: 12,
        notes: 'Official Facebook page. Social pages can block automated access; verify facts before approval.'
    },
    {
        source_name: 'BMU Instagram',
        source_type: 'social_instagram',
        source_url: 'https://www.instagram.com/bmuyenagoa.official/',
        authority_type: 'institution_social',
        source_rank: 78,
        check_frequency_hours: 12,
        notes: 'Official Instagram page. Captions may require manual review if the platform blocks automated fetch.'
    },
    {
        source_name: 'BMU LinkedIn',
        source_type: 'social_linkedin',
        source_url: 'https://www.linkedin.com/in/bayelsa-medical-university-4a0629195/',
        authority_type: 'institution_social',
        source_rank: 72,
        check_frequency_hours: 24,
        notes: 'BMU LinkedIn profile. Treat as supplementary unless an announcement is clearly official.'
    }
];

const KEYWORD_RE = /\b(admission|admissions|apply|application|cut\s*off|cutoff|cut-off|utme|jamb|fee|fees|tuition|registration|register|deadline|resumption|calendar|semester|session|programme|program|course|scholarship|screening|matriculation|convocation|orientation|accreditation|notice|announcement|202[0-9]\/202[0-9]|202[0-9])\b/i;
const APPLICATION_PORTAL_FALLBACK = 'https://bmu.edu.ng/accounts/login/?next=/admissions/apply/';
const ADMISSIONS_PAGE_FALLBACK = 'https://bmu.edu.ng/admissions/';

const CUTOFF_PROGRAMME_ALIASES = [
    { programme: 'Medicine and Surgery (MBBS)', aliases: ['medicine and surgery mbbs', 'medicine and surgery', 'mbbs', 'medicine surgery'] },
    { programme: 'Pharmacy (Pharm.D)', aliases: ['pharmacy pharm d', 'pharmacy pharmd', 'pharm d', 'pharmd', 'pharmacy'] },
    { programme: 'Nursing Science (B.NSc)', aliases: ['nursing science b nsc', 'nursing science bnsc', 'bnsc', 'nursing science', 'nursing'] },
    { programme: 'Medical Laboratory Sciences (BMLS)', aliases: ['medical laboratory sciences bmls', 'medical laboratory science bmls', 'medical laboratory sciences', 'medical laboratory science', 'bmls', 'med lab'] },
    { programme: 'Optometry (O.D)', aliases: ['optometry o d', 'optometry od', 'optometry'] },
    { programme: 'Radiography & Radiation Sciences', aliases: ['radiography and radiation sciences', 'radiography radiation sciences', 'radiography and radiation science', 'radiography'] },
    { programme: 'Physiotherapy', aliases: ['physiotheraphy', 'physiotherapy'] },
    { programme: 'Community / Public Health', aliases: ['community public health', 'community and public health', 'community health', 'public health'] },
    { programme: 'Other Programs', aliases: ['other programs', 'other programmes', 'other program', 'other programme'] }
];

const PROMOTABLE_STRUCTURED_TABLES = {
    academic_admission_cutoffs: [
        'source_fact_id', 'programme', 'admission_cycle', 'entry_mode', 'merit_cutoff',
        'cutoff_label', 'eligibility_text', 'application_process', 'contact_text',
        'authority_type', 'scope_label', 'currentness_label', 'source_path',
        'raw_text', 'row_json', 'status'
    ],
    academic_registration_requirements: [
        'source_fact_id', 'student_category', 'programme', 'level_label',
        'semester_label', 'session_label', 'requirement_type', 'requirement_text',
        'deadline_label', 'portal_url', 'authority_type', 'scope_label',
        'currentness_label', 'source_path', 'raw_text', 'row_json', 'status'
    ]
};

function hash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function compact(value, max = 1200) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function normaliseKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\bprogramme\b/g, 'program')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function canonicalCutoffProgramme(value) {
    const key = normaliseKey(value);
    if (!key) return null;
    for (const item of CUTOFF_PROGRAMME_ALIASES) {
        if (item.aliases.some(alias => key === normaliseKey(alias) || key.includes(normaliseKey(alias)))) {
            return item.programme;
        }
    }
    return compact(value, 120);
}

function sourcePathForFact(fact) {
    const title = compact(fact?.title || '', 220);
    const source = compact(fact?.source_url || fact?.source_name || fact?.source_type || '', 300);
    if (title && source) return `${title} (${source})`;
    return title || source || 'BMU recent source';
}

function extractSection(text, startRe, stopRe) {
    const value = normaliseRecentText(text, 22000);
    const start = value.search(startRe);
    if (start < 0) return '';
    const sliced = value.slice(start);
    const stop = sliced.slice(1).search(stopRe);
    return compact(stop >= 0 ? sliced.slice(0, stop + 1) : sliced, 1800);
}

function cleanNoticeListText(value, max = 1000) {
    return compact(String(value || '')
        .replace(/^[^:]{0,80}:\s*/i, '')
        .replace(/\s*(?:^|\n)\s*[-*\u2022]\s*/g, '; ')
        .replace(/\s*(?:^|\n)\s*\d+[\).]\s*/g, '; ')
        .replace(/\s+;/g, ';')
        .replace(/(?:;\s*){2,}/g, '; ')
        .replace(/^;\s*/, '')
        .replace(/\s+/g, ' '), max);
}

function extractEligibilityText(text) {
    const section = extractSection(text, /\beligibility\s+criteria\b/i, /\b(application\s+process|for\s+further|thank\s+you|cut\s*off\s+marks?)\b/i);
    if (section) return cleanNoticeListText(section, 1000);
    const lines = normaliseRecentText(text, 22000)
        .split(/\n+/)
        .map(line => cleanNoticeListText(line, 500))
        .filter(line => /\b(minimum score|utme|jamb|age|16 years|o'?level|ssce|credits?|english language|biology|chemistry|physics|mathematics)\b/i.test(line));
    return compact([...new Set(lines)].join('; '), 1000);
}

function extractApplicationProcess(text) {
    const section = extractSection(text, /\b(application\s+process|application\s+flow|how\s+to\s+apply)\b/i, /\b(for\s+further|thank\s+you|cut\s*off\s+marks?|eligibility\s+criteria)\b/i);
    if (section) return cleanNoticeListText(section, 1200);
    const lines = normaliseRecentText(text, 22000)
        .split(/\n+/)
        .map(line => cleanNoticeListText(line, 500))
        .filter(line => /\b(create an account|verify|login|log in|programme of choice|click on apply|fill application|upload|required documents|application fee|pay)\b/i.test(line));
    return compact([...new Set(lines)].join('; '), 1200);
}

function extractContactText(text) {
    const value = normaliseRecentText(text, 22000);
    const phone = value.match(/\+?\d[\d\s-]{7,}\d/)?.[0];
    const officer = value.match(/\b(?:Prof\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}\s+Admissions\s+Officer\b/i)?.[0]
        || value.match(/\b(?:Prof\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}\b(?=[\s\S]{0,80}\bAdmissions\s+Officer\b)/i)?.[0];
    const pieces = [];
    if (phone) pieces.push(`Phone: ${compact(phone, 40)}`);
    if (officer) pieces.push(`Admissions Officer: ${compact(officer.replace(/\s+Admissions\s+Officer\b/i, ''), 120)}`);
    return pieces.join('. ');
}

function extractPortalUrl(text, fact = {}) {
    const value = String(text || '');
    const inlineUrl = value.match(/https?:\/\/[^\s)]+/i)?.[0];
    if (inlineUrl && /apply|admission|portal|login/i.test(inlineUrl)) return inlineUrl;
    if (/\b(create an account|verify|login|log in|click on apply|application fee)\b/i.test(value)) return APPLICATION_PORTAL_FALLBACK;
    const sourceUrl = String(fact.source_url || '').match(/https?:\/\/[^\s)]+/i)?.[0];
    if (sourceUrl && /apply|admission|portal|login/i.test(sourceUrl)) return sourceUrl;
    return ADMISSIONS_PAGE_FALLBACK;
}

function extractCutoffRows(text) {
    const value = normaliseRecentText(text, 22000).replace(/[–—]/g, '-');
    const patterns = [
        /\b(Medicine\s+and\s+Surgery\s*\(?MBBS\)?|MBBS|Pharmacy\s*\(?Pharm\.?\s*D\)?|Pharm\.?\s*D|Nursing\s+Science\s*\(?B\.?\s*NSc\)?|Medical\s+Laborator(?:y|ies)\s+Sciences?\s*\(?BMLS\)?|Optometry\s*\(?O\.?\s*D\)?|Radiography\s*(?:&|and)?\s*Radiation\s+Sciences?|Physiother(?:a|e)phy|Community\s*\/\s*Public\s+Health|Community\s+(?:\/\s*)?Public\s+Health|Community\s+Health|Public\s+Health|Other\s+Programs?|Other\s+Programmes?)\s*(?::|-)\s*(?:Merit\s*(?::|-)\s*)?(\d{3})\b/gi,
        /\b(Medicine\s+and\s+Surgery|Pharmacy|Nursing\s+Science|Medical\s+Laboratory\s+Sciences?|Optometry|Radiography(?:\s+and\s+Radiation\s+Sciences?)?|Physiother(?:a|e)phy|Community\s+Health|Public\s+Health)\b[\s\S]{0,50}?\bcut\s*off\s*(?:mark)?\s*(?:is|:|-)?\s*(\d{3})\b/gi
    ];
    const rows = [];
    const seen = new Set();
    for (const pattern of patterns) {
        for (const match of value.matchAll(pattern)) {
            const programme = canonicalCutoffProgramme(match[1]);
            const cutoff = Number(match[2]);
            if (!programme || !cutoff || cutoff < 100 || cutoff > 400) continue;
            const key = `${programme}|${cutoff}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ programme, cutoff, rawLabel: compact(match[0], 180) });
        }
    }
    return rows;
}

function structuredRecordHash(table, record) {
    if (table === 'academic_admission_cutoffs') {
        return hash([
            table,
            record.programme,
            record.admission_cycle,
            record.merit_cutoff,
            record.source_path
        ].map(value => String(value ?? '')).join('|'));
    }
    if (table === 'academic_registration_requirements') {
        return hash([
            table,
            record.student_category,
            record.session_label,
            record.requirement_type,
            record.requirement_text,
            record.source_path
        ].map(value => String(value ?? '')).join('|'));
    }
    return hash([table, ...Object.keys(record).sort().map(key => `${key}:${record[key] ?? ''}`)].join('|').toLowerCase());
}

function buildStructuredSuggestions(factOrText = {}) {
    const fact = typeof factOrText === 'string' ? { fact_text: factOrText } : (factOrText || {});
    const text = normaliseRecentText([fact.title, fact.fact_text].filter(Boolean).join('\n'), 22000);
    if (!text) return [];

    const session = detectSession(text) || fact.session_label || '';
    const sourcePath = sourcePathForFact(fact);
    const eligibilityText = extractEligibilityText(text);
    const applicationProcess = extractApplicationProcess(text);
    const contactText = extractContactText(text);
    const portalUrl = extractPortalUrl(text, fact);
    const rawText = compact(text, 1800);
    const suggestions = [];

    for (const row of extractCutoffRows(text)) {
        const record = {
            source_fact_id: fact.id || null,
            programme: row.programme,
            admission_cycle: session || 'current admission cycle',
            entry_mode: 'UTME',
            merit_cutoff: row.cutoff,
            cutoff_label: `Merit - ${row.cutoff}`,
            eligibility_text: eligibilityText || null,
            application_process: applicationProcess || null,
            contact_text: contactText || null,
            authority_type: fact.authority_type || 'institution',
            scope_label: 'BMU admissions',
            currentness_label: 'current',
            source_path: sourcePath,
            raw_text: rawText,
            row_json: JSON.stringify({
                source_fact_id: fact.id || null,
                recent_fact_title: fact.title || null,
                source_url: fact.source_url || null,
                extracted_from: 'bmu_recent_facts',
                raw_cutoff_label: row.rawLabel
            }),
            status: 'active'
        };
        suggestions.push({
            table: 'academic_admission_cutoffs',
            tableLabel: 'Admission cutoffs',
            title: `${row.programme} cutoff`,
            summary: `${row.programme}: ${record.cutoff_label}${session ? ` for ${session}` : ''}`,
            confidence: eligibilityText || applicationProcess ? 0.92 : 0.86,
            reviewNotes: [
                'Confirm the admission cycle/session before promotion.',
                'Cutoff marks are high-risk and should remain tied to this source.'
            ],
            record
        });
    }

    if (applicationProcess) {
        const record = {
            source_fact_id: fact.id || null,
            student_category: 'applicant / new student',
            programme: null,
            level_label: null,
            semester_label: null,
            session_label: session || null,
            requirement_type: 'online_application',
            requirement_text: applicationProcess,
            deadline_label: null,
            portal_url: portalUrl,
            authority_type: fact.authority_type || 'institution',
            scope_label: 'BMU registration/admissions process',
            currentness_label: 'current',
            source_path: sourcePath,
            raw_text: rawText,
            row_json: JSON.stringify({
                source_fact_id: fact.id || null,
                recent_fact_title: fact.title || null,
                source_url: fact.source_url || null,
                extracted_from: 'bmu_recent_facts'
            }),
            status: 'active'
        };
        suggestions.push({
            table: 'academic_registration_requirements',
            tableLabel: 'Registration requirements',
            title: 'New applicant online application flow',
            summary: applicationProcess,
            confidence: 0.88,
            reviewNotes: [
                'Confirm that this is still the current application flow.',
                'Add semester or deadline details later if BMU publishes them.'
            ],
            record
        });
    }

    if (eligibilityText) {
        const record = {
            source_fact_id: fact.id || null,
            student_category: 'applicant / new student',
            programme: fact.programme || null,
            level_label: null,
            semester_label: null,
            session_label: session || null,
            requirement_type: 'admission_eligibility',
            requirement_text: eligibilityText,
            deadline_label: null,
            portal_url: ADMISSIONS_PAGE_FALLBACK,
            authority_type: fact.authority_type || 'institution',
            scope_label: 'BMU admissions eligibility',
            currentness_label: 'current',
            source_path: sourcePath,
            raw_text: rawText,
            row_json: JSON.stringify({
                source_fact_id: fact.id || null,
                recent_fact_title: fact.title || null,
                source_url: fact.source_url || null,
                extracted_from: 'bmu_recent_facts'
            }),
            status: 'active'
        };
        suggestions.push({
            table: 'academic_registration_requirements',
            tableLabel: 'Registration requirements',
            title: 'Applicant admission eligibility',
            summary: eligibilityText,
            confidence: 0.86,
            reviewNotes: [
                'Eligibility rules are high-risk. Confirm exact wording before promotion.'
            ],
            record
        });
    }

    return suggestions.map((suggestion, index) => ({
        ...suggestion,
        index,
        id: hash(`${suggestion.table}|${structuredRecordHash(suggestion.table, suggestion.record)}`)
    }));
}

async function getRecentFact(id) {
    await ensureSchema();
    const rows = await query(`
        SELECT *
        FROM bmu_recent_facts
        WHERE id = ?
        LIMIT 1
    `, [id]);
    return rows?.[0] || null;
}

async function upsertStructuredSuggestionRecord(suggestion) {
    const table = suggestion?.table;
    const columns = PROMOTABLE_STRUCTURED_TABLES[table];
    if (!columns) throw new Error('This suggestion cannot be promoted to a structured table');

    const record = suggestion.record || {};
    const insertColumns = ['record_hash', ...columns];
    const recordHash = structuredRecordHash(table, record);
    const values = [recordHash, ...columns.map(column => record[column] ?? null)];
    const updates = columns
        .map(column => `${column} = VALUES(${column})`)
        .concat("status = 'active'", 'updated_at = NOW()')
        .join(', ');
    const result = await query(`
        INSERT INTO ${table} (${insertColumns.join(', ')})
        VALUES (${insertColumns.map(() => '?').join(', ')})
        ON DUPLICATE KEY UPDATE ${updates}
    `, values);
    const rows = await query(`SELECT id FROM ${table} WHERE record_hash = ? LIMIT 1`, [recordHash]);
    return {
        table,
        recordHash,
        recordId: rows?.[0]?.id || result?.insertId || null
    };
}

async function promoteStructuredSuggestions(factId, { suggestionIndex = null, all = false, adminUserId = null } = {}) {
    await ensureSchema();
    const fact = await getRecentFact(factId);
    if (!fact) throw new Error('Recent fact not found');
    const suggestions = buildStructuredSuggestions(fact);
    if (!suggestions.length) throw new Error('No structured suggestions were detected for this recent fact');

    const hasIndex = suggestionIndex !== null
        && suggestionIndex !== undefined
        && String(suggestionIndex).trim() !== ''
        && Number.isInteger(Number(suggestionIndex));
    const selected = all
        ? suggestions
        : (hasIndex ? [suggestions[Number(suggestionIndex)]].filter(Boolean) : []);
    if (!selected.length) throw new Error('Structured suggestion not found');

    const promoted = [];
    for (const suggestion of selected) {
        const result = await upsertStructuredSuggestionRecord(suggestion);
        promoted.push({ ...result, suggestion });
    }

    const note = compact([
        fact.admin_notes || '',
        `Promoted ${promoted.length} structured record(s): ${promoted.map(item => `${item.table}#${item.recordId || item.recordHash}`).join(', ')}`
    ].filter(Boolean).join('\n'), 1800);
    const expiresAt = inferRecentFactExpiry(fact);
    await query(`
        UPDATE bmu_recent_facts
        SET status = 'approved',
            approved_by = COALESCE(approved_by, ?),
            approved_at = COALESCE(approved_at, NOW()),
            currentness_label = 'current',
            expires_at = COALESCE(expires_at, ?),
            admin_notes = ?,
            updated_at = NOW()
        WHERE id = ?
    `, [adminUserId || null, expiresAt, note, factId]);
    await supersedeOlderRecentFacts(factId);

    return {
        factId,
        promotedCount: promoted.length,
        promoted
    };
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<meta[^>]+>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function normaliseRecentText(value, max = 18000) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max);
}

function extractTitle(html, fallback) {
    const og = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (og) return compact(og[1], 180);
    const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return compact(title?.[1] || fallback || 'BMU source', 180);
}

function classify(text) {
    const value = String(text || '').toLowerCase();
    if (/\b(cut\s*off|cutoff|cut-off|utme|jamb|admission|admissions|apply|application|screening)\b/.test(value)) return 'admissions';
    if (/\b(fee|fees|tuition|payment|charges)\b/.test(value)) return 'fees';
    if (/\b(register|registration|clearance|portal)\b/.test(value)) return 'registration';
    if (/\b(calendar|deadline|resumption|semester|session|orientation|matriculation|convocation)\b/.test(value)) return 'calendar';
    if (/\b(programme|program|course|department|faculty)\b/.test(value)) return 'programmes';
    return 'general';
}

function detectSession(text) {
    const match = String(text || '').match(/\b(20\d{2})\s*\/\s*(20\d{2})\b/);
    return match ? `${match[1]}/${match[2]}` : null;
}

function formatMysqlDateTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function inferRecentFactExpiry(factOrText = {}) {
    const fact = typeof factOrText === 'string' ? { fact_text: factOrText } : (factOrText || {});
    const text = [fact.title, fact.fact_text, fact.session_label].filter(Boolean).join('\n');
    const category = fact.category || classify(text);
    const session = fact.session_label || detectSession(text);
    const sessionMatch = String(session || '').match(/\b(20\d{2})\s*\/\s*(20\d{2})\b/);
    if (sessionMatch && /admissions?|registration|calendar|fees|programmes/.test(category)) {
        return `${sessionMatch[2]}-09-30 23:59:59`;
    }

    const now = new Date();
    const daysByCategory = {
        admissions: 395,
        registration: 220,
        calendar: 220,
        fees: 545,
        programmes: 730,
        general: 365
    };
    const days = daysByCategory[category] || 365;
    return formatMysqlDateTime(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));
}

function detectDateLabel(text) {
    const value = String(text || '');
    const match = value.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}\b/i)
        || value.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/i)
        || value.match(/\b20\d{2}[/-]\d{1,2}[/-]\d{1,2}\b/)
        || value.match(/\b\d{1,2}[/-]\d{1,2}[/-]20\d{2}\b/);
    return match ? compact(match[0], 120) : null;
}

function detectProgramme(text) {
    const value = String(text || '').toLowerCase();
    const pairs = [
        ['Medicine and Surgery (MBBS)', /\b(mbbs|medicine and surgery|medicine)\b/],
        ['Pharmacy (Pharm.D)', /\b(pharmacy|pharm\.?d|doctor of pharmacy)\b/],
        ['Nursing Science', /\bnursing\b/],
        ['Medical Laboratory Science', /\b(medical laboratory|bmls|med lab)\b/],
        ['Optometry', /\boptometry\b/],
        ['Radiography and Radiation Sciences', /\bradiography\b/],
        ['Physiotherapy', /\bphysiotherapy\b/],
        ['Community/Public Health', /\b(community health|public health)\b/]
    ];
    const hit = pairs.find(([, re]) => re.test(value));
    return hit ? hit[0] : null;
}

function splitCandidateTexts(text) {
    const cleaned = normaliseRecentText(text, 18000);
    const lineParts = [];
    let activeHeading = '';
    for (const rawLine of cleaned.split(/\n+/)) {
        const line = compact(rawLine.replace(/^[\-*\u2022]\s*/, '').replace(/^\d+[\).]\s*/, ''), 900);
        if (!line) continue;
        const looksLikeHeading = line.length <= 120
            && /^(cut\s*off|cutoff|eligibility|application|registration|fees?|deadline|calendar|requirements?|process|programme|program)/i.test(line);
        if (looksLikeHeading) {
            activeHeading = line.replace(/:$/, '');
            continue;
        }
        const isFactLine = line.length >= 18
            && line.length <= 900
            && (KEYWORD_RE.test(line) || /\b(?:merit|minimum|score|credit|years?|semester|session|fee|pay|apply|verify|login)\b/i.test(line))
            && (/\d/.test(line) || KEYWORD_RE.test(line));
        if (isFactLine) {
            lineParts.push(activeHeading ? `${activeHeading}: ${line}` : line);
        }
    }
    const blockParts = cleaned
        .split(/\n{2,}/)
        .map(item => compact(item, 1400))
        .filter(item => item.length >= 50 && KEYWORD_RE.test(item));
    const sentenceParts = cleaned
        .replace(/\n+/g, ' ')
        .split(/(?<=[.!?])\s+| {2,}/)
        .map(item => compact(item, 1000))
        .filter(item => item.length >= 50 && KEYWORD_RE.test(item));
    const parts = [...lineParts, ...blockParts, ...sentenceParts];
    const merged = [];
    const seen = new Set();
    for (const part of parts) {
        const key = part.toLowerCase().slice(0, 260);
        if (seen.has(key)) continue;
        seen.add(key);
        const prev = merged[merged.length - 1] || '';
        if (prev && prev.length < 260 && classify(prev) === classify(part)) {
            merged[merged.length - 1] = compact(`${prev} ${part}`, 1200);
        } else {
            merged.push(part);
        }
        if (merged.length >= 25) break;
    }
    return merged;
}

async function ensureSchema() {
    await documentLabService.ensureSchema();
    await ensureRecentFactsSchemaPatch();
    for (const source of DEFAULT_SOURCES) {
        const sourceHash = hash(`${source.source_name}|${source.source_url}`);
        await query(`
            INSERT INTO bmu_recent_sources
                (source_name, source_type, source_url, authority_type, source_rank, check_frequency_hours, notes, last_content_hash, status)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active'
            WHERE NOT EXISTS (
                SELECT 1 FROM bmu_recent_sources WHERE source_url = ? LIMIT 1
            )
        `, [
            source.source_name,
            source.source_type,
            source.source_url,
            source.authority_type,
            source.source_rank,
            source.check_frequency_hours,
            source.notes,
            sourceHash,
            source.source_url
        ]);
    }
}

async function ensureRecentFactsSchemaPatch() {
    if (recentFactsSchemaPatchEnsured) return;
    const requiredColumns = [
        ['expires_at', 'expires_at DATETIME NULL AFTER currentness_label'],
        ['superseded_by', 'superseded_by INT NULL AFTER expires_at']
    ];
    for (const [column, ddl] of requiredColumns) {
        const rows = await query('SHOW COLUMNS FROM bmu_recent_facts LIKE ?', [column]);
        if (!rows.length) {
            await query(`ALTER TABLE bmu_recent_facts ADD COLUMN ${ddl}`);
        }
    }

    const requiredIndexes = [
        ['idx_bmu_recent_facts_currentness', 'ALTER TABLE bmu_recent_facts ADD INDEX idx_bmu_recent_facts_currentness (currentness_label)'],
        ['idx_bmu_recent_facts_expiry', 'ALTER TABLE bmu_recent_facts ADD INDEX idx_bmu_recent_facts_expiry (expires_at)']
    ];
    for (const [indexName, ddl] of requiredIndexes) {
        const rows = await query('SHOW INDEX FROM bmu_recent_facts WHERE Key_name = ?', [indexName]);
        if (!rows.length) {
            await query(ddl);
        }
    }
    recentFactsSchemaPatchEnsured = true;
}

async function fetchText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parseInt(process.env.BMU_RECENT_FETCH_TIMEOUT_MS || '12000', 10));
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'BMUAcademicAdvisorBot/1.0 (+https://advisor.bmuaiagent.mehetti.com)',
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
            }
        });
        const body = await res.text();
        return {
            ok: res.ok,
            status: res.status,
            html: body,
            text: stripHtml(body)
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function upsertFact(source, title, factText, raw = {}) {
    const category = classify(factText);
    const recordHash = hash([
        source.source_url,
        category,
        compact(factText, 420).toLowerCase()
    ].join('|'));
    const params = [
        recordHash,
        source.id,
        source.source_name,
        source.source_type,
        source.source_url,
        title,
        category,
        factText,
        detectDateLabel(factText),
        detectSession(factText),
        detectProgramme(factText),
        source.authority_type || 'institution',
        Number(source.source_rank || 80),
        category === 'general' ? 0.62 : 0.74,
        JSON.stringify(raw || {})
    ];
    const result = await query(`
        INSERT INTO bmu_recent_facts
            (record_hash, source_id, source_name, source_type, source_url, title, category,
             fact_text, detected_date_label, session_label, programme, authority_type,
             authority_rank, confidence, raw_json, status, currentness_label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'recent')
        ON DUPLICATE KEY UPDATE
            last_seen_at = NOW(),
            source_name = VALUES(source_name),
            source_type = VALUES(source_type),
            source_url = VALUES(source_url),
            title = VALUES(title),
            raw_json = VALUES(raw_json),
            updated_at = NOW()
    `, params);
    const rows = await query(`
        SELECT id, status
        FROM bmu_recent_facts
        WHERE record_hash = ?
        LIMIT 1
    `, [recordHash]);
    return {
        recordHash,
        id: rows?.[0]?.id || null,
        status: rows?.[0]?.status || 'pending',
        inserted: result.affectedRows === 1,
        updated: result.affectedRows !== 1
    };
}

async function ingestText({
    text,
    title = '',
    sourceId = null,
    sourceName = '',
    sourceType = 'manual_paste',
    sourceUrl = '',
    authorityType = 'institution',
    sourceRank = 88
} = {}) {
    await ensureSchema();
    const cleaned = normaliseRecentText(text, 22000);
    if (cleaned.length < 40) {
        throw new Error('Paste enough official BMU notice text to extract candidate facts');
    }

    let source = null;
    if (sourceId) {
        const rows = await query(`
            SELECT *
            FROM bmu_recent_sources
            WHERE id = ?
            LIMIT 1
        `, [sourceId]);
        source = rows?.[0] || null;
        if (!source) throw new Error('Recent source not found');
        if (sourceUrl) {
            source = { ...source, source_url: sourceUrl };
        }
    } else {
        source = {
            id: null,
            source_name: sourceName || 'Admin pasted BMU notice',
            source_type: sourceType || 'manual_paste',
            source_url: sourceUrl || 'admin://recent-source-paste',
            authority_type: authorityType || 'institution',
            source_rank: Number(sourceRank || 88)
        };
    }

    const sourceTitle = compact(title || source.source_name || 'BMU pasted notice', 180);
    const candidates = splitCandidateTexts(cleaned);
    const facts = [];
    for (const factText of candidates) {
        facts.push(await upsertFact(source, sourceTitle, factText, {
            sourceTitle,
            ingestMode: 'manual_paste'
        }));
    }

    if (source.id) {
        await query(`
            UPDATE bmu_recent_sources
            SET last_checked_at = NOW(),
                last_status = 'manual_ingest',
                last_error = NULL,
                last_content_hash = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [hash(cleaned), source.id]);
    }

    return {
        detected: candidates.length,
        inserted: facts.filter(item => item.inserted).length,
        updated: facts.filter(item => item.updated).length,
        facts
    };
}

async function checkSource(source) {
    try {
        const fetched = await fetchText(source.source_url);
        const contentHash = hash(fetched.text);
        const title = extractTitle(fetched.html, source.source_name);
        let detected = 0;
        if (fetched.ok) {
            const candidates = splitCandidateTexts(fetched.text);
            for (const factText of candidates) {
                await upsertFact(source, title, factText, { status: fetched.status, sourceTitle: title });
                detected += 1;
            }
        }
        await query(`
            UPDATE bmu_recent_sources
            SET last_checked_at = NOW(), last_status = ?, last_error = NULL, last_content_hash = ?, updated_at = NOW()
            WHERE id = ?
        `, [fetched.ok ? 'ok' : `http_${fetched.status}`, contentHash, source.id]);
        return { sourceId: source.id, sourceName: source.source_name, ok: fetched.ok, status: fetched.status, detected };
    } catch (err) {
        await query(`
            UPDATE bmu_recent_sources
            SET last_checked_at = NOW(), last_status = 'error', last_error = ?, updated_at = NOW()
            WHERE id = ?
        `, [String(err.message || err).slice(0, 1000), source.id]);
        return { sourceId: source.id, sourceName: source.source_name, ok: false, error: err.message || 'fetch failed', detected: 0 };
    }
}

async function checkSources({ sourceId = null, dueOnly = false } = {}) {
    await ensureSchema();
    const where = ['status = ?'];
    const params = ['active'];
    if (sourceId) {
        where.push('id = ?');
        params.push(sourceId);
    }
    if (dueOnly) {
        where.push('(last_checked_at IS NULL OR last_checked_at < DATE_SUB(NOW(), INTERVAL check_frequency_hours HOUR))');
    }
    const sources = await query(`
        SELECT *
        FROM bmu_recent_sources
        WHERE ${where.join(' AND ')}
        ORDER BY source_rank DESC, id ASC
        LIMIT 20
    `, params);
    const results = [];
    for (const source of sources) {
        results.push(await checkSource(source));
    }
    return {
        checked: results.length,
        detected: results.reduce((sum, item) => sum + Number(item.detected || 0), 0),
        results
    };
}

async function getSummary() {
    await ensureSchema();
    await expireStaleRecentFacts();
    const sources = await query(`
        SELECT id, source_name, source_type, source_url, authority_type, source_rank,
               check_frequency_hours, last_checked_at, last_status, last_error, status
        FROM bmu_recent_sources
        ORDER BY source_rank DESC, id ASC
    `);
    const counts = await query(`
        SELECT status, category, COUNT(*) AS count
        FROM bmu_recent_facts
        GROUP BY status, category
        ORDER BY status, category
    `);
    const facts = await query(`
        SELECT id, title, category, fact_text, detected_date_label, session_label, programme,
               source_name, source_type, source_url, confidence, status, currentness_label,
               expires_at, superseded_by, first_seen_at, last_seen_at, approved_at
        FROM bmu_recent_facts
        ORDER BY FIELD(status, 'pending', 'approved', 'rejected', 'inactive'), last_seen_at DESC, id DESC
        LIMIT 80
    `);
    return {
        sources,
        counts,
        facts: facts.map(fact => ({
            ...fact,
            structured_suggestion_count: buildStructuredSuggestions(fact).length
        }))
    };
}

async function setFactStatus(id, status, adminUserId, notes = '') {
    await ensureSchema();
    const allowed = new Set(['approved', 'rejected', 'inactive', 'pending']);
    if (!allowed.has(status)) throw new Error('Invalid recent fact status');
    const fields = ['status = ?', 'admin_notes = ?', 'updated_at = NOW()'];
    const params = [status, notes || null];
    if (status === 'approved') {
        const fact = await getRecentFact(id);
        fields.push(
            'approved_by = ?',
            'approved_at = NOW()',
            "currentness_label = 'current'",
            'expires_at = COALESCE(expires_at, ?)',
            'rejected_by = NULL',
            'rejected_at = NULL'
        );
        params.push(adminUserId || null, inferRecentFactExpiry(fact || {}));
    } else if (status === 'rejected') {
        fields.push('rejected_by = ?', 'rejected_at = NOW()', "currentness_label = 'rejected'");
        params.push(adminUserId || null);
    } else if (status === 'inactive') {
        fields.push("currentness_label = 'superseded'");
    } else if (status === 'pending') {
        fields.push("currentness_label = 'recent'");
    }
    params.push(id);
    await query(`UPDATE bmu_recent_facts SET ${fields.join(', ')} WHERE id = ?`, params);
    if (status === 'approved') {
        await supersedeOlderRecentFacts(id);
    }
}

async function expireStaleRecentFacts() {
    await ensureSchema();
    const result = await query(`
        UPDATE bmu_recent_facts
        SET status = 'inactive',
            currentness_label = 'superseded',
            admin_notes = TRIM(CONCAT(COALESCE(admin_notes, ''), CASE WHEN admin_notes IS NULL OR admin_notes = '' THEN '' ELSE '\n' END, 'Automatically expired after its review window.')),
            updated_at = NOW()
        WHERE status = 'approved'
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
    `);
    return result?.affectedRows || 0;
}

async function supersedeOlderRecentFacts(factId) {
    const rows = await query(`
        SELECT id, category, programme, session_label
        FROM bmu_recent_facts
        WHERE id = ?
        LIMIT 1
    `, [factId]);
    const fact = rows?.[0];
    if (!fact || !/^(admissions|registration|calendar|fees)$/.test(String(fact.category || ''))) return 0;
    const sessionMatch = String(fact.session_label || '').match(/\b(20\d{2})\s*\/\s*(20\d{2})\b/);
    if (!sessionMatch) return 0;
    const sessionStart = Number(sessionMatch[1]);
    if (!Number.isFinite(sessionStart)) return 0;

    const result = await query(`
        UPDATE bmu_recent_facts
        SET status = 'inactive',
            currentness_label = 'superseded',
            superseded_by = ?,
            admin_notes = TRIM(CONCAT(COALESCE(admin_notes, ''), CASE WHEN admin_notes IS NULL OR admin_notes = '' THEN '' ELSE '\n' END, 'Superseded by newer approved recent fact #', ?)),
            updated_at = NOW()
        WHERE id <> ?
          AND status = 'approved'
          AND category = ?
          AND (programme <=> ? OR ? IS NULL)
          AND session_label REGEXP '^20[0-9]{2}/20[0-9]{2}$'
          AND CAST(SUBSTRING_INDEX(session_label, '/', 1) AS UNSIGNED) < ?
    `, [factId, factId, factId, fact.category, fact.programme || null, fact.programme || null, sessionStart]);
    return result?.affectedRows || 0;
}

async function findApprovedRecentFacts(question, { limit = 6 } = {}) {
    await ensureSchema();
    await expireStaleRecentFacts();
    const q = compact(question, 400);
    const tokens = q
        .toLowerCase()
        .replace(/[^a-z0-9\/\s-]+/g, ' ')
        .split(/\s+/)
        .filter(token => token.length >= 4)
        .slice(0, 8);
    const categoryHints = [];
    const category = classify(q);
    if (category !== 'general') categoryHints.push(category);
    const where = ["status = 'approved'", "(currentness_label IN ('current', 'recent') OR currentness_label IS NULL)", "(expires_at IS NULL OR expires_at >= NOW())"];
    const params = [];
    if (categoryHints.length) {
        where.push(`category IN (${categoryHints.map(() => '?').join(',')})`);
        params.push(...categoryHints);
    }
    if (tokens.length) {
        where.push(`(${tokens.map(() => '(title LIKE ? OR fact_text LIKE ? OR programme LIKE ? OR session_label LIKE ?)').join(' OR ')})`);
        for (const token of tokens) params.push(`%${token}%`, `%${token}%`, `%${token}%`, `%${token}%`);
    }
    return query(`
        SELECT *
        FROM bmu_recent_facts
        WHERE ${where.join(' AND ')}
        ORDER BY authority_rank DESC, expires_at DESC, last_seen_at DESC, id DESC
        LIMIT ?
    `, [...params, Math.max(1, Math.min(12, limit))]);
}

module.exports = {
    ensureSchema,
    checkSources,
    ingestText,
    getSummary,
    setFactStatus,
    findApprovedRecentFacts,
    expireStaleRecentFacts,
    supersedeOlderRecentFacts,
    getRecentFact,
    buildStructuredSuggestions,
    promoteStructuredSuggestions,
    inferRecentFactExpiry,
    classify,
    _internal: {
        splitCandidateTexts,
        stripHtml,
        detectProgramme,
        detectSession,
        detectDateLabel,
        extractCutoffRows,
        extractEligibilityText,
        extractApplicationProcess,
        inferRecentFactExpiry
    }
};
