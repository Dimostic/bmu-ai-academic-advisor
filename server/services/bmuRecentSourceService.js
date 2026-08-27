const crypto = require('crypto');
const { query } = require('../../config/db');
const documentLabService = require('./documentLabService');

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
    const blockParts = cleaned
        .split(/\n{2,}/)
        .map(item => compact(item, 1400))
        .filter(item => item.length >= 50 && KEYWORD_RE.test(item));
    const sentenceParts = cleaned
        .replace(/\n+/g, ' ')
        .split(/(?<=[.!?])\s+| {2,}/)
        .map(item => compact(item, 1000))
        .filter(item => item.length >= 50 && KEYWORD_RE.test(item));
    const parts = [...blockParts, ...sentenceParts];
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
    return { recordHash, inserted: result.affectedRows === 1 };
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
               first_seen_at, last_seen_at, approved_at
        FROM bmu_recent_facts
        ORDER BY FIELD(status, 'pending', 'approved', 'rejected', 'inactive'), last_seen_at DESC, id DESC
        LIMIT 80
    `);
    return { sources, counts, facts };
}

async function setFactStatus(id, status, adminUserId, notes = '') {
    await ensureSchema();
    const allowed = new Set(['approved', 'rejected', 'inactive', 'pending']);
    if (!allowed.has(status)) throw new Error('Invalid recent fact status');
    const fields = ['status = ?', 'admin_notes = ?', 'updated_at = NOW()'];
    const params = [status, notes || null];
    if (status === 'approved') {
        fields.push('approved_by = ?', 'approved_at = NOW()', 'rejected_by = NULL', 'rejected_at = NULL');
        params.push(adminUserId || null);
    } else if (status === 'rejected') {
        fields.push('rejected_by = ?', 'rejected_at = NOW()');
        params.push(adminUserId || null);
    }
    params.push(id);
    await query(`UPDATE bmu_recent_facts SET ${fields.join(', ')} WHERE id = ?`, params);
}

async function findApprovedRecentFacts(question, { limit = 6 } = {}) {
    await ensureSchema();
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
    const where = ["status = 'approved'"];
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
        ORDER BY authority_rank DESC, last_seen_at DESC, id DESC
        LIMIT ?
    `, [...params, Math.max(1, Math.min(12, limit))]);
}

module.exports = {
    ensureSchema,
    checkSources,
    getSummary,
    setFactStatus,
    findApprovedRecentFacts,
    classify,
    _internal: {
        splitCandidateTexts,
        stripHtml,
        detectProgramme,
        detectSession,
        detectDateLabel
    }
};
