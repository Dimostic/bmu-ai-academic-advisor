const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { query } = require('../../config/db');
const AuditTrail = require('../models/AuditTrail');
const Document = require('../models/Document');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const Advisor = require('../models/Advisor');
const advisorStreamService = require('../services/advisorStreamService');
const responseQualityService = require('../services/responseQualityService');
const documentLabService = require('../services/documentLabService');
const emailService = (() => {
    try { return require('../services/emailService'); }
    catch (_) { return null; }
})();
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();
const structuredUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: parseInt(process.env.STRUCTURED_IMPORT_MAX_FILE_SIZE || '8388608', 10) }
});

const STRUCTURED_TABLES = {
    structured_facts: {
        label: 'Structured facts',
        description: 'General approved facts used by retrieval for exact answers.',
        columns: ['fact_type', 'subject', 'predicate_name', 'value_json', 'human_text', 'authority_type', 'scope_label', 'source_path', 'status', 'currentness_label', 'authority_rank'],
        required: ['fact_type', 'human_text'],
        textColumns: ['fact_type', 'subject', 'predicate_name', 'authority_type', 'scope_label', 'source_path', 'status', 'currentness_label'],
        jsonColumns: ['value_json'],
        numericColumns: ['authority_rank'],
        defaults: { status: 'active', currentness_label: 'current', authority_rank: 85 },
        search: ['fact_type', 'subject', 'predicate_name', 'human_text', 'source_path']
    },
    academic_programmes: {
        label: 'Programmes',
        description: 'Programme, faculty, department, duration and entry-mode facts.',
        columns: ['programme', 'faculty', 'department', 'degree', 'duration_years', 'entry_mode', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'row_json', 'status'],
        required: ['programme'],
        textColumns: ['programme', 'faculty', 'department', 'degree', 'entry_mode', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'status'],
        jsonColumns: ['row_json'],
        numericColumns: ['duration_years'],
        defaults: { status: 'active', authority_type: 'institution' },
        search: ['programme', 'faculty', 'department', 'degree', 'entry_mode', 'source_path', 'raw_text']
    },
    academic_courses: {
        label: 'Courses',
        description: 'Course records by programme, level, semester, code, title and credit units.',
        columns: ['programme', 'level_label', 'semester_label', 'course_code', 'course_title', 'credit_units', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'row_json', 'status'],
        required: ['programme', 'course_title'],
        textColumns: ['programme', 'level_label', 'semester_label', 'course_code', 'course_title', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'status'],
        jsonColumns: ['row_json'],
        numericColumns: ['credit_units'],
        defaults: { status: 'active', authority_type: 'institution' },
        search: ['programme', 'level_label', 'semester_label', 'course_code', 'course_title', 'source_path', 'raw_text']
    },
    academic_fees: {
        label: 'Fees',
        description: 'Approved fee values by programme, category, session and student category.',
        columns: ['programme', 'fee_category', 'amount_label', 'amount_value', 'session_label', 'student_category', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'row_json', 'status'],
        required: ['programme', 'fee_category', 'amount_label'],
        textColumns: ['programme', 'fee_category', 'amount_label', 'session_label', 'student_category', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'status'],
        jsonColumns: ['row_json'],
        numericColumns: ['amount_value'],
        defaults: { status: 'active', authority_type: 'institution' },
        search: ['programme', 'fee_category', 'amount_label', 'session_label', 'student_category', 'source_path', 'raw_text']
    },
    academic_calendar_events: {
        label: 'Calendar',
        description: 'Academic calendar events and date labels.',
        columns: ['event_title', 'event_date_label', 'session_label', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'row_json', 'status'],
        required: ['event_title'],
        textColumns: ['event_title', 'event_date_label', 'session_label', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'status'],
        jsonColumns: ['row_json'],
        numericColumns: [],
        defaults: { status: 'active', authority_type: 'institution' },
        search: ['event_title', 'event_date_label', 'session_label', 'source_path', 'raw_text']
    },
    academic_officers: {
        label: 'Officers',
        description: 'Current office-holder records such as VC, Bursar, Registrar and Council roles.',
        columns: ['office', 'officer_name', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'row_json', 'status'],
        required: ['office'],
        textColumns: ['office', 'officer_name', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'status'],
        jsonColumns: ['row_json'],
        numericColumns: [],
        defaults: { status: 'active', authority_type: 'institution' },
        search: ['office', 'officer_name', 'source_path', 'raw_text']
    },
    academic_rules: {
        label: 'Rules',
        description: 'Academic rules such as admission, graduation, progression and examination policies.',
        columns: ['rule_type', 'subject', 'programme', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'row_json', 'status'],
        required: ['rule_type', 'raw_text'],
        textColumns: ['rule_type', 'subject', 'programme', 'authority_type', 'scope_label', 'source_path', 'raw_text', 'status'],
        jsonColumns: ['row_json'],
        numericColumns: [],
        defaults: { status: 'active', authority_type: 'institution' },
        search: ['rule_type', 'subject', 'programme', 'source_path', 'raw_text']
    }
};

/** Tell the FAQ service to re-read the cached_qa table on the next
 *  question. Without this, newly-promoted Q&As don't appear in the
 *  in-memory embeddings index until the existing 5-minute TTL expires.
 *  Called from every endpoint that creates, updates, or deletes a
 *  cached_qa row. Fail-safe: if the FAQ service isn't loaded for any
 *  reason, swallow the error rather than blocking the admin action. */
function _invalidateFAQCache() {
    try {
        const faqService = require('../services/faqService');
        if (typeof faqService.invalidateEmbeddingsCache === 'function') {
            faqService.invalidateEmbeddingsCache();
        }
    } catch (err) {
        console.warn('[adminRoutes] invalidateEmbeddingsCache failed:', err.message);
    }
}

function _normalizeEscalationEmail(raw) {
    let e = String(raw || '').trim().toLowerCase();
    e = e.replace(/,\s*ng$/i, '.ng').replace(/\s+/g, '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
    return e;
}

async function _resolveAdvisorEscalationEmail() {
    const fromEnv = _normalizeEscalationEmail(process.env.ADVISOR_ESCALATION_EMAIL || '');
    if (fromEnv) return fromEnv;
    try {
        const rows = await query(
            `SELECT email
             FROM human_advisors
             WHERE is_active = TRUE
               AND is_available = TRUE
               AND email IS NOT NULL
             ORDER BY id ASC
             LIMIT 1`
        );
        const fromTable = _normalizeEscalationEmail(rows?.[0]?.email || '');
        if (fromTable) return fromTable;
    } catch (_) { /* ignore */ }
    return 'advisor@bmu.edu.ng';
}

function _csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function _invalidateStructuredLookupCache() {
    try {
        const retrievalService = require('../services/retrievalService');
        if (typeof retrievalService.clearCache === 'function') {
            retrievalService.clearCache('all');
        }
    } catch (err) {
        console.warn('[adminRoutes] structured lookup cache invalidation failed:', err.message);
    }
    _invalidateFAQCache();
}

let evalSchemaReady = false;
async function _ensureEvaluationSchema() {
    if (evalSchemaReady) return true;
    await query(`
        CREATE TABLE IF NOT EXISTS advisor_eval_tests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            question TEXT NOT NULL,
            topic VARCHAR(120) NULL,
            risk_level VARCHAR(40) NOT NULL DEFAULT 'high',
            expected_terms_json LONGTEXT NULL,
            forbidden_terms_json LONGTEXT NULL,
            source_hint VARCHAR(255) NULL,
            min_confidence DECIMAL(6,4) NOT NULL DEFAULT 0.1200,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            last_status VARCHAR(40) NULL,
            last_score DECIMAL(6,4) NULL,
            last_result_json LONGTEXT NULL,
            last_run_at TIMESTAMP NULL,
            created_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_eval_active (is_active),
            INDEX idx_eval_topic (topic),
            INDEX idx_eval_status (last_status)
        ) ENGINE=InnoDB
    `);
    evalSchemaReady = true;
    return true;
}

function _jsonArray(value) {
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return [];
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed.map(v => String(v || '').trim()).filter(Boolean);
        } catch (_) {
            return text.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean);
        }
    }
    return [];
}

function _shapeEvalTest(row) {
    return {
        id: row.id,
        question: row.question,
        topic: row.topic,
        riskLevel: row.risk_level,
        expectedTerms: _jsonArray(row.expected_terms_json),
        forbiddenTerms: _jsonArray(row.forbidden_terms_json),
        sourceHint: row.source_hint,
        minConfidence: Number(row.min_confidence || 0),
        isActive: Boolean(row.is_active),
        lastStatus: row.last_status,
        lastScore: row.last_score === null || row.last_score === undefined ? null : Number(row.last_score),
        lastResult: (() => { try { return row.last_result_json ? JSON.parse(row.last_result_json) : null; } catch (_) { return null; } })(),
        lastRunAt: row.last_run_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function _structuredTableConfig(name) {
    const key = String(name || '').trim();
    return STRUCTURED_TABLES[key] ? { name: key, ...STRUCTURED_TABLES[key] } : null;
}

function _recordHash(table, record) {
    const raw = [table, ...Object.keys(record).sort().map(k => `${k}:${record[k] ?? ''}`)].join('|').toLowerCase();
    return crypto.createHash('sha1').update(raw).digest('hex');
}

function _normaliseHeader(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function _coerceStructuredValue(config, column, value) {
    if (value === undefined || value === '') {
        return config.defaults && Object.prototype.hasOwnProperty.call(config.defaults, column)
            ? config.defaults[column]
            : null;
    }
    if (config.numericColumns.includes(column)) {
        const n = Number(String(value).replace(/[^\d.-]/g, ''));
        return Number.isFinite(n) ? n : null;
    }
    if (config.jsonColumns.includes(column)) {
        if (typeof value === 'object') return JSON.stringify(value);
        const text = String(value || '').trim();
        if (!text) return null;
        try { return JSON.stringify(JSON.parse(text)); }
        catch (_) { return text; }
    }
    return String(value ?? '').trim() || null;
}

function _shapeStructuredRow(config, row) {
    const shaped = {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
    for (const column of config.columns) {
        shaped[column] = row[column];
    }
    if (row.record_hash) shaped.record_hash = row.record_hash;
    return shaped;
}

function _structuredTemplateRows(configName, config) {
    const base = Object.fromEntries(config.columns.map(column => [column, config.defaults?.[column] ?? '']));
    if (configName === 'academic_officers') {
        return [{ ...base, office: 'Vice-Chancellor', officer_name: 'Prof. Dimie Ogoina', source_path: 'BMU Brief Institutional Profile (May 2025)', raw_text: 'Vice-Chancellor: Prof. Dimie Ogoina.' }];
    }
    if (configName === 'academic_fees') {
        return [{ ...base, programme: 'Medicine and Surgery (MBBS)', fee_category: 'official_total_payable', amount_label: 'N1,230,000', amount_value: 1230000, student_category: 'non-indigene', source_path: 'bmu fee structures new.docx' }];
    }
    if (configName === 'academic_courses') {
        return [{ ...base, programme: 'Medical Laboratory Science', level_label: '300 level', semester_label: 'First semester', course_code: 'MLS 313', course_title: 'Basic Hematology', credit_units: 2, source_path: 'ALL COURSES FOR BMU.xlsx' }];
    }
    if (configName === 'academic_rules') {
        return [{ ...base, rule_type: 'graduation_requirement', subject: 'Graduation requirements', programme: 'Medical Laboratory Science', raw_text: 'Enter the exact approved rule text here.', source_path: 'Approved source document' }];
    }
    if (configName === 'structured_facts') {
        return [{ ...base, fact_type: 'principal_officer', subject: 'Vice-Chancellor', predicate_name: 'office_holder', value_json: '{"office":"Vice-Chancellor","officer_name":"Prof. Dimie Ogoina"}', human_text: 'The Vice-Chancellor of BMU is Prof. Dimie Ogoina.', source_path: 'BMU Brief Institutional Profile (May 2025)' }];
    }
    return [base];
}

async function _upsertStructuredRecord(tableName, config, input) {
    const id = parseInt(input.id, 10);
    const record = {};
    for (const column of config.columns) {
        record[column] = _coerceStructuredValue(config, column, input[column]);
    }

    const missing = config.required.filter(column => !record[column]);
    if (missing.length) {
        throw new Error(`Missing required column(s): ${missing.join(', ')}`);
    }

    if (id) {
        const assignments = config.columns.map(column => `${column} = ?`).join(', ');
        await query(
            `UPDATE ${tableName}
             SET ${assignments}, updated_at = NOW()
             WHERE id = ?`,
            [...config.columns.map(column => record[column]), id]
        );
        return { mode: 'updated', id };
    }

    const columns = [...config.columns];
    const values = config.columns.map(column => record[column]);
    if (tableName !== 'structured_facts') {
        columns.unshift('record_hash');
        values.unshift(_recordHash(tableName, record));
    }
    const duplicateUpdate = tableName === 'structured_facts'
        ? ''
        : ` ON DUPLICATE KEY UPDATE ${config.columns.map(column => `${column} = VALUES(${column})`).join(', ')}, updated_at = NOW()`;
    const result = await query(
        `INSERT INTO ${tableName} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})${duplicateUpdate}`,
        values
    );
    return { mode: 'created', id: result?.insertId || null };
}

function _parseStructuredWorkbook(file) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
}

function _parseJsonObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function _extractOfficerNameFromText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const afterColon = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
    const match = afterColon.match(/\b(?:Prof\.?|Professor|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Barr\.?)\s*(?:\([^)]+\)\s*)?[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,5}/);
    return String(match?.[0] || afterColon)
        .replace(/[.;,\s]+$/g, '')
        .trim();
}

async function _syncPrincipalOfficerRecord(tableName, record) {
    if (!record || (tableName !== 'structured_facts' && tableName !== 'academic_officers')) return;

    let office = '';
    let officerName = '';
    let sourcePath = record.source_path || 'BMU Brief Institutional Profile (May 2025)';
    let rawText = '';
    let value = {};

    if (tableName === 'structured_facts') {
        if (record.fact_type !== 'principal_officer' && record.predicate_name !== 'office_holder') return;
        value = _parseJsonObject(record.value_json);
        office = String(value.office || record.subject || '').trim();
        officerName = _extractOfficerNameFromText(record.human_text) || String(value.officer_name || value.name || '').trim();
        if (!office || !officerName) return;
        value = { ...value, office, officer_name: officerName };
        rawText = record.human_text || `${office}: ${officerName}.`;
    } else {
        office = String(record.office || '').trim();
        officerName = String(record.officer_name || '').trim();
        if (!office || !officerName) return;
        rawText = record.raw_text || `${office}: ${officerName}.`;
        value = _parseJsonObject(record.row_json);
        value = { ...value, office, officer_name: officerName };
    }

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
        [officerName, sourcePath, rawText, JSON.stringify(value), office]
    );
    if (!Number(updated?.affectedRows || 0)) {
        const officerHash = _recordHash('academic_officers', {
            office,
            officer_name: officerName,
            source_path: sourcePath
        });
        await query(
            `INSERT INTO academic_officers
                (record_hash, office, officer_name, authority_type, scope_label, source_path, raw_text, row_json, status)
             VALUES
                (?, ?, ?, 'institution', 'BMU current principal officers', ?, ?, ?, 'active')`,
            [officerHash, office, officerName, sourcePath, rawText, JSON.stringify(value)]
        );
    }

    await query(
        `UPDATE structured_facts
         SET human_text = ?,
             value_json = ?,
             status = 'active',
             updated_at = NOW()
         WHERE fact_type = 'principal_officer'
           AND (subject = ? OR JSON_UNQUOTE(JSON_EXTRACT(value_json, '$.office')) = ?)`,
        [`${office}: ${officerName}.`, JSON.stringify(value), office, office]
    );
}

async function _runEvaluationTest(row) {
    const retrievalService = require('../services/retrievalService');
    const expectedTerms = _jsonArray(row.expected_terms_json);
    const forbiddenTerms = _jsonArray(row.forbidden_terms_json);
    const result = await retrievalService.retrieve(row.question, {
        limit: 8,
        includeMetadata: true,
        skipCache: true
    });
    const haystack = `${result.context || ''}\n${(result.chunks || []).map(c => c.content || '').join('\n')}`.toLowerCase();
    const foundExpected = expectedTerms.filter(term => haystack.includes(term.toLowerCase()));
    const missingExpected = expectedTerms.filter(term => !haystack.includes(term.toLowerCase()));
    const foundForbidden = forbiddenTerms.filter(term => haystack.includes(term.toLowerCase()));
    const confidence = Number(result.confidence || 0);
    const minConfidence = Number(row.min_confidence || 0.12);
    const hasEvidence = Boolean((result.chunks || []).length || String(result.context || '').trim());
    const hasHighRiskPolicy = Boolean(result.metadata?.highRiskPolicy?.isHighRisk);
    const expectedPass = missingExpected.length === 0;
    const forbiddenPass = foundForbidden.length === 0;
    const confidencePass = confidence >= minConfidence;
    const passed = hasEvidence && expectedPass && forbiddenPass && confidencePass;
    const scoreParts = [
        expectedTerms.length ? foundExpected.length / expectedTerms.length : 1,
        forbiddenTerms.length ? (forbiddenTerms.length - foundForbidden.length) / forbiddenTerms.length : 1,
        confidencePass ? 1 : Math.max(0, confidence / Math.max(minConfidence, 0.001)),
        hasEvidence ? 1 : 0
    ];
    const score = scoreParts.reduce((sum, v) => sum + v, 0) / scoreParts.length;
    return {
        status: passed ? 'passed' : 'failed',
        score: Number(score.toFixed(4)),
        confidence,
        minConfidence,
        hasEvidence,
        hasHighRiskPolicy,
        expectedTerms,
        foundExpected,
        missingExpected,
        forbiddenTerms,
        foundForbidden,
        structuredFacts: result.metadata?.structuredFacts || 0,
        structuredTables: result.metadata?.structuredTables || 0,
        sourcePolicy: result.metadata?.sourcePolicy || null,
        sources: (result.sources || []).slice(0, 6).map(s => ({
            documentId: s.documentId,
            title: s.title,
            category: s.category
        })),
        preview: String(result.context || '').slice(0, 1600)
    };
}

// Get dashboard statistics
router.get('/dashboard', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // User statistics
        const userStats = await query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
                SUM(CASE WHEN role = 'superadmin' THEN 1 ELSE 0 END) as superadmins,
                SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as new_this_week
            FROM users WHERE is_active = TRUE
        `);

        // Document statistics
        const docStats = await Document.getStats();

        // Chat statistics
        const chatStats = await query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(DISTINCT session_id) as total_sessions,
                SUM(tokens_used) as total_tokens
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);

        // Recent activity
        const recentActivity = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as message_count
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);

        res.json({
            success: true,
            dashboard: {
                users: userStats[0],
                documents: docStats,
                chat: chatStats[0],
                recentActivity
            }
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch dashboard data'
        });
    }
});

// Alias for /dashboard - some clients call /stats
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // User statistics
        const userStats = await query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
                SUM(CASE WHEN role = 'superadmin' THEN 1 ELSE 0 END) as superadmins
            FROM users WHERE is_active = TRUE
        `);

        // Document statistics  
        const docStats = await Document.getStats();

        // Chat statistics
        const chatStats = await query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(DISTINCT session_id) as total_sessions
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);

        res.json({
            success: true,
            stats: {
                totalUsers: parseInt(userStats[0]?.total) || 0,
                totalDocuments: docStats?.total || 0,
                trainedDocuments: docStats?.trained || 0,
                totalSessions: parseInt(chatStats[0]?.total_sessions) || 0,
                totalMessages: parseInt(chatStats[0]?.total_messages) || 0
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics'
        });
    }
});

// Alias for /audit-trail - some clients call /audit  
router.get('/audit', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50, search } = req.query;

        const result = await AuditTrail.getAll(parseInt(page), parseInt(limit), {
            search
        });

        res.json({
            success: true,
            logs: result.logs || result.items || [],
            pagination: result.pagination || { page: parseInt(page), total: result.total || 0 }
        });

    } catch (error) {
        console.error('Audit error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch audit logs'
        });
    }
});

// Get audit trail
router.get('/audit-trail', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50, userId, action, startDate, endDate, search } = req.query;

        const result = await AuditTrail.getAll(parseInt(page), parseInt(limit), {
            userId: userId ? parseInt(userId) : null,
            action,
            startDate,
            endDate,
            search
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        console.error('Audit trail error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch audit trail'
        });
    }
});

// Get escalations with email delivery visibility for admin follow-up
router.get('/escalations', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 100, search = '', status = '', emailStatus = '' } = req.query;
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
        const offset = (pageNum - 1) * limitNum;

        const result = await Advisor.listEscalations({
            limit: limitNum,
            offset,
            search: String(search || '').trim(),
            status: String(status || '').trim(),
            emailStatus: String(emailStatus || '').trim()
        });

        const items = (result.rows || []).map(r => {
            const deliveryError = typeof r.response_message === 'string' && r.response_message.startsWith('[EMAIL_ERROR]')
                ? r.response_message.replace(/^\[EMAIL_ERROR\]\s*/i, '')
                : null;
            return {
                id: r.id,
                subject: r.subject,
                message: r.message,
                contactEmail: r.contact_email,
                contactPhone: r.contact_phone,
                status: r.status,
                priority: r.priority,
                assignedEmail: r.assigned_email,
                emailSentAt: r.email_sent_at,
                emailStatus: r.email_sent_at ? 'sent' : (deliveryError ? 'failed' : 'pending'),
                emailError: deliveryError,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                conversationId: r.conversation_id,
                student: {
                    id: r.student_id,
                    name: r.student_name,
                    matricNo: r.matric_no
                }
            };
        });

        res.json({
            success: true,
            escalations: items,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: Number(result.total || 0),
                totalPages: Math.max(1, Math.ceil(Number(result.total || 0) / limitNum))
            }
        });
    } catch (error) {
        console.error('Escalations list error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch escalations'
        });
    }
});

// Export escalations as CSV for audit/compliance follow-up
router.get('/escalations/export.csv', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { search = '', status = '', emailStatus = '' } = req.query;
        const result = await Advisor.listEscalations({
            limit: 5000,
            offset: 0,
            search: String(search || '').trim(),
            status: String(status || '').trim(),
            emailStatus: String(emailStatus || '').trim()
        });

        const headers = [
            'id', 'created_at', 'student_name', 'matric_no', 'contact_email',
            'subject', 'message', 'status', 'priority', 'assigned_email',
            'email_sent_at', 'email_status', 'email_error'
        ];

        const lines = [headers.join(',')];
        for (const r of result.rows || []) {
            const deliveryError = typeof r.response_message === 'string' && r.response_message.startsWith('[EMAIL_ERROR]')
                ? r.response_message.replace(/^\[EMAIL_ERROR\]\s*/i, '')
                : '';
            const emailStatusValue = r.email_sent_at ? 'sent' : (deliveryError ? 'failed' : 'pending');
            const row = [
                r.id,
                r.created_at,
                r.student_name || '',
                r.matric_no || '',
                r.contact_email || '',
                r.subject || '',
                r.message || '',
                r.status || '',
                r.priority || '',
                r.assigned_email || '',
                r.email_sent_at || '',
                emailStatusValue,
                deliveryError
            ].map(_csvEscape).join(',');
            lines.push(row);
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="escalations-${stamp}.csv"`);
        res.send(lines.join('\n'));
    } catch (error) {
        console.error('Escalation CSV export error:', error);
        res.status(500).json({ success: false, error: 'Failed to export escalations' });
    }
});

// Retry email delivery for a specific escalation
router.post('/escalations/:id/retry-email', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid escalation id' });

        const rows = await query(
            `SELECT e.*, s.full_name AS student_name, s.matric_no
             FROM escalations e
             LEFT JOIN students s ON s.id = e.student_id
             WHERE e.id = ?
             LIMIT 1`,
            [id]
        );
        const esc = rows[0];
        if (!esc) return res.status(404).json({ success: false, error: 'Escalation not found' });

        const advisorEmail = await _resolveAdvisorEscalationEmail();
        if (!emailService || process.env.EMAIL_ENABLED !== 'true') {
            await Advisor.markEscalationEmailFailed(id, advisorEmail, process.env.EMAIL_ENABLED === 'true' ? 'email service unavailable' : 'EMAIL_ENABLED is false');
            return res.status(400).json({ success: false, error: 'Email service is not enabled' });
        }

        await emailService.sendMail({
            to: advisorEmail,
            subject: `[BMU Advisor] Escalation: ${esc.subject}`,
            text: `A student has escalated a question.\n\nFrom: ${esc.student_name || 'Anonymous'} (${esc.contact_email || 'no email'})\nMatric: ${esc.matric_no || 'n/a'}\nPriority: ${esc.priority || 'normal'}\nSubmitted at: ${esc.created_at || new Date().toISOString()}\n\nSubject:\n${esc.subject}\n\nMessage:\n${esc.message}\n\nReply to: ${esc.contact_email || 'unknown'}`
        });

        await Advisor.markEscalationEmailed(id, advisorEmail);
        await AuditTrail.log({
            userId: req.user.id,
            action: 'ESCALATION_EMAIL_RETRIED',
            entityType: 'escalation',
            entityId: id,
            details: { to: advisorEmail },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({ success: true, message: `Escalation email sent to ${advisorEmail}` });
    } catch (error) {
        console.error('Retry escalation email error:', error);
        try {
            const id = parseInt(req.params.id, 10);
            if (id) {
                const to = await _resolveAdvisorEscalationEmail();
                await Advisor.markEscalationEmailFailed(id, to, error.message || 'retry failed');
            }
        } catch (_) { /* ignore */ }
        res.status(500).json({ success: false, error: `Could not resend escalation email: ${error.message || 'unknown error'}` });
    }
});

// Update escalation workflow status (open -> in_progress -> resolved -> closed)
router.put('/escalations/:id/status', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const nextStatus = String(req.body?.status || '').trim();
        const responseMessage = String(req.body?.responseMessage || '').trim();
        if (!id) return res.status(400).json({ success: false, error: 'Invalid escalation id' });
        if (!['open', 'in_progress', 'resolved', 'closed'].includes(nextStatus)) {
            return res.status(400).json({ success: false, error: 'Invalid escalation status' });
        }

        const rows = await query(`SELECT id, status FROM escalations WHERE id = ? LIMIT 1`, [id]);
        const current = rows[0];
        if (!current) return res.status(404).json({ success: false, error: 'Escalation not found' });

        await query(
            `UPDATE escalations
             SET status = ?,
                 response_message = CASE WHEN ? <> '' THEN ? ELSE response_message END,
                 resolved_at = CASE WHEN ? IN ('resolved','closed') THEN CURRENT_TIMESTAMP ELSE resolved_at END
             WHERE id = ?`,
            [nextStatus, responseMessage, responseMessage, nextStatus, id]
        );

        await AuditTrail.log({
            userId: req.user.id,
            action: 'ESCALATION_STATUS_UPDATED',
            entityType: 'escalation',
            entityId: id,
            details: { from: current.status, to: nextStatus },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({ success: true, message: 'Escalation status updated' });
    } catch (error) {
        console.error('Escalation status update error:', error);
        res.status(500).json({ success: false, error: 'Failed to update escalation status' });
    }
});

// ======================== USER MANAGEMENT ========================

// Get all users (admin)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, role } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let whereClause = '1=1';
        const params = [];
        
        if (search) {
            whereClause += ' AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam);
        }
        
        if (status === 'active') {
            whereClause += ' AND is_active = TRUE AND is_verified = TRUE AND is_approved = TRUE';
        } else if (status === 'pending') {
            whereClause += ' AND (is_verified = FALSE OR is_approved = FALSE)';
        } else if (status === 'inactive') {
            whereClause += ' AND is_active = FALSE';
        }
        
        if (role) {
            whereClause += ' AND role = ?';
            params.push(role);
        }
        
        // Get total count
        const countResult = await query(`SELECT COUNT(*) as total FROM users WHERE ${whereClause}`, params);
        const total = countResult[0]?.total || 0;
        
        // Get users - include the prompt-usage counters so the admin UI
        // can show how many prompts each user has burned this day/month.
        // The columns may not exist in older deployments, so guard with
        // information_schema.
        const cols = await query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
        );
        const colSet = new Set((cols || []).map(c => c.COLUMN_NAME));
        const optional = [
            'monthly_prompt_limit', 'monthly_prompt_count',
            'daily_prompt_limit',   'daily_prompt_count',
            'matric_no', 'last_login'
        ].filter(c => colSet.has(c));

        const selectCols = [
            'id', 'email', 'first_name', 'last_name', 'role',
            'department', 'phone',
            'is_active', 'is_verified', 'is_approved',
            'created_at', 'updated_at',
            ...optional
        ];

        const users = await query(`
            SELECT ${selectCols.join(', ')}
            FROM users
            WHERE ${whereClause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);
        
        res.json({
            success: true,
            users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch users: ' + error.message
        });
    }
});

// Create a user from the admin form. Skips email verification (admin
// vouches for the address) and sets must_change_password=1 so the new
// user is forced to choose their own password on first login.
router.post('/users', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const {
            email, password, firstName, lastName,
            role = 'staff', department = null, phone = null, matricNo = null
        } = req.body || {};

        // Basic validation (re-uses the same constraints as self-registration).
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' });
        }
        if (!firstName || !lastName) {
            return res.status(400).json({ success: false, error: 'First and last name are required' });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
        }
        if (!['student', 'staff', 'admin', 'superadmin'].includes(role)) {
            return res.status(400).json({ success: false, error: 'Invalid role' });
        }

        const existing = await User.findByEmailAny(email);
        if (existing) {
            return res.status(409).json({ success: false, error: 'A user with that email already exists' });
        }

        const userId = await User.adminCreate({
            email, password, firstName, lastName, role, department, phone, matricNo
        });

        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_CREATED_BY_ADMIN',
            entityType: 'user',
            entityId: userId,
            details: { email, role, by: req.user.email },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.status(201).json({
            success: true,
            userId,
            message: `Account created for ${email}. The user must change their password on first login.`
        });
    } catch (error) {
        console.error('Admin user-create error:', error);
        res.status(500).json({ success: false, error: 'Could not create user' });
    }
});
router.put('/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        
        await query('UPDATE users SET is_active = ? WHERE id = ?', [isActive, id]);
        
        await AuditTrail.log({
            userId: req.user.id,
            action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
            entityType: 'user',
            entityId: id,
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: isActive ? 'User activated' : 'User deactivated'
        });
    } catch (error) {
        console.error('Update user status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update user status'
        });
    }
});

// Update user role - Enhanced with proper permission checks
router.put('/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        const requestingUser = req.user;
        
        if (!['staff', 'admin', 'superadmin'].includes(role)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid role'
            });
        }
        
        // Prevent changing own role
        if (parseInt(id) === requestingUser.id) {
            return res.status(400).json({
                success: false,
                error: 'Cannot change your own role'
            });
        }
        
        // Get target user
        const targetUser = await User.findById(id);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        // Permission checks based on requesting user's role
        if (requestingUser.role === 'admin') {
            // Admins cannot:
            // - Set anyone as superadmin
            // - Change superadmin's role
            // - Change other admin's role (only superadmin can)
            if (role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can assign superadmin role'
                });
            }
            if (targetUser.role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Cannot modify superadmin users'
                });
            }
            if (targetUser.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can change admin roles'
                });
            }
        }
        // Superadmins can do anything
        
        const oldRole = targetUser.role;
        await query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        
        await AuditTrail.log({
            userId: requestingUser.id,
            action: 'USER_ROLE_CHANGED',
            entityType: 'user',
            entityId: id,
            details: { oldRole, newRole: role },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User role updated'
        });
    } catch (error) {
        console.error('Update user role error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update user role'
        });
    }
});

// Get a user's prompt quota and usage (superadmin only)
router.get('/users/:id/prompt-quota', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user id' });
        }

        const quota = await User.getPromptQuota(userId);
        if (!quota) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, quota });
    } catch (error) {
        console.error('Get prompt quota error:', error);
        return res.status(500).json({ success: false, error: 'Failed to fetch prompt quota' });
    }
});

// Update a user's prompt limits (superadmin only)
router.put('/users/:id/prompt-limits', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const dailyRaw = req.body?.dailyPromptLimit;
        const monthlyRaw = req.body?.monthlyPromptLimit;

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user id' });
        }

        const updates = {};
        if (dailyRaw !== undefined) {
            const v = parseInt(dailyRaw, 10);
            if (!Number.isInteger(v) || v < -1) {
                return res.status(400).json({ success: false, error: 'dailyPromptLimit must be -1 or greater' });
            }
            updates.dailyPromptLimit = v;
        }

        if (monthlyRaw !== undefined) {
            const v = parseInt(monthlyRaw, 10);
            if (!Number.isInteger(v) || v < -1) {
                return res.status(400).json({ success: false, error: 'monthlyPromptLimit must be -1 or greater' });
            }
            updates.monthlyPromptLimit = v;
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, error: 'Provide dailyPromptLimit and/or monthlyPromptLimit' });
        }

        const ok = await User.updatePromptLimits(userId, updates);
        if (!ok) {
            return res.status(404).json({ success: false, error: 'User not found or no changes made' });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_PROMPT_LIMITS_UPDATED',
            entityType: 'user',
            entityId: userId,
            details: updates,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        const quota = await User.getPromptQuota(userId);
        return res.json({ success: true, message: 'Prompt limits updated', quota });
    } catch (error) {
        console.error('Update prompt limits error:', error);
        return res.status(500).json({ success: false, error: 'Failed to update prompt limits' });
    }
});

// Delete user - with proper permission checks
router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const requestingUser = req.user;
        
        // Prevent deleting self
        if (parseInt(id) === requestingUser.id) {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete your own account'
            });
        }
        
        // Get target user
        const targetUser = await User.findById(id);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        // Permission checks
        if (requestingUser.role === 'admin') {
            // Admins cannot delete superadmins or other admins
            if (targetUser.role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Cannot delete superadmin users'
                });
            }
            if (targetUser.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can delete admin users'
                });
            }
        }
        // Superadmins can delete anyone except themselves
        
        // Soft delete - just deactivate and anonymize
        await query(`
            UPDATE users SET 
                is_active = FALSE, 
                email = CONCAT('deleted_', id, '_', email),
                first_name = 'Deleted',
                last_name = 'User'
            WHERE id = ?
        `, [id]);
        
        await AuditTrail.log({
            userId: requestingUser.id,
            action: 'USER_DELETED',
            entityType: 'user',
            entityId: id,
            details: { deletedUserRole: targetUser.role, deletedUserEmail: targetUser.email },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete user'
        });
    }
});

// Reset user password (admin only) - since email is disabled
router.post('/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;
        const requestingUser = req.user;
        
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 8 characters long'
            });
        }
        
        // Prevent resetting own password through this endpoint
        if (parseInt(id) === requestingUser.id) {
            return res.status(400).json({
                success: false,
                error: 'Use the profile page to change your own password'
            });
        }
        
        // Get target user
        const targetUser = await User.findByIdAny(id);
        if (!targetUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        // Permission checks
        if (requestingUser.role === 'admin') {
            // Admins cannot reset superadmin or other admin passwords
            if (targetUser.role === 'superadmin') {
                return res.status(403).json({
                    success: false,
                    error: 'Cannot reset superadmin password'
                });
            }
            if (targetUser.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Only superadmins can reset admin passwords'
                });
            }
        }
        
        // Reset the password
        await User.updatePassword(id, newPassword);
        
        await AuditTrail.log({
            userId: requestingUser.id,
            action: 'USER_PASSWORD_RESET',
            entityType: 'user',
            entityId: id,
            details: { resetBy: requestingUser.email, targetEmail: targetUser.email },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: `Password reset successfully for ${targetUser.email}`
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset password'
        });
    }
});

// Approve user (admin and superadmin can approve)
router.post('/users/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        await query('UPDATE users SET is_approved = TRUE, is_active = TRUE WHERE id = ?', [id]);
        
        // Send approval email
        try {
            const emailService = require('../services/emailService');
            const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            const loginUrl = `${baseUrl}/#/login`;
            
            await emailService.sendApprovalEmail({
                to: user.email,
                userName: user.first_name || user.email,
                loginUrl
            });
        } catch (emailErr) {
            console.error('Failed to send approval email:', emailErr);
        }
        
        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_APPROVED',
            entityType: 'user',
            entityId: id,
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User approved successfully'
        });
    } catch (error) {
        console.error('Approve user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to approve user'
        });
    }
});

// Reject user (admin and superadmin can reject)
router.post('/users/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        await query('UPDATE users SET is_active = FALSE WHERE id = ?', [id]);
        
        // Send rejection email
        try {
            const emailService = require('../services/emailService');
            await emailService.sendRejectionEmail({
                to: user.email,
                userName: user.first_name || user.email,
                reason: reason || 'Your registration request was not approved.'
            });
        } catch (emailErr) {
            console.error('Failed to send rejection email:', emailErr);
        }
        
        await AuditTrail.log({
            userId: req.user.id,
            action: 'USER_REJECTED',
            entityType: 'user',
            entityId: id,
            details: { reason },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: 'User rejected'
        });
    } catch (error) {
        console.error('Reject user error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reject user'
        });
    }
});

// Get system settings (superadmin only)
router.get('/settings', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const settings = await query(`
            SELECT setting_key, setting_value, setting_type, description, is_public
            FROM system_settings
            ORDER BY setting_key
        `);

        res.json({
            success: true,
            settings
        });

    } catch (error) {
        console.error('Settings error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch settings'
        });
    }
});

// Update system setting (superadmin only)
router.put('/settings/:key', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        const result = await query(
            'UPDATE system_settings SET setting_value = ?, updated_by = ?, updated_at = NOW() WHERE setting_key = ?',
            [value, req.user.id, key]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: 'Setting not found'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'SETTING_UPDATED',
            entityType: 'system_setting',
            details: { key, value },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Setting updated successfully'
        });

    } catch (error) {
        console.error('Update setting error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update setting'
        });
    }
});

// Get analytics data
router.get('/analytics', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);

        // Daily message counts
        const dailyMessages = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN sender = 'user' THEN 1 ELSE 0 END) as user_messages,
                SUM(CASE WHEN sender = 'assistant' THEN 1 ELSE 0 END) as ai_messages,
                AVG(response_time_ms) as avg_response_time,
                SUM(tokens_used) as tokens_used
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [daysInt]);

        // User registrations
        const userRegistrations = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as new_users
            FROM users
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [daysInt]);

        // Top active users with token usage
        const topUsers = await query(`
            SELECT 
                u.id,
                u.email,
                u.first_name,
                u.last_name,
                COUNT(cm.id) as message_count,
                COALESCE(SUM(cm.tokens_used), 0) as total_tokens
            FROM users u
            JOIN chat_messages cm ON u.id = cm.user_id
            WHERE cm.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY u.id
            ORDER BY message_count DESC
            LIMIT 10
        `, [daysInt]);

        // Document categories
        const documentCategories = await Document.getCategoryStats();

        // Feedback summary
        const feedbackStats = await ChatMessage.getFeedbackStats();

        // Platform usage
        const platformUsage = await query(`
            SELECT 
                cs.platform,
                COUNT(DISTINCT cs.id) as sessions,
                COUNT(cm.id) as messages
            FROM chat_sessions cs
            LEFT JOIN chat_messages cm ON cs.id = cm.session_id
            WHERE cs.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY cs.platform
        `, [daysInt]);

        res.json({
            success: true,
            analytics: {
                period: `${daysInt} days`,
                dailyMessages,
                userRegistrations,
                topUsers,
                documentCategories,
                feedbackStats,
                platformUsage
            }
        });

    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch analytics'
        });
    }
});

// Get token usage analytics (by model and user)
router.get('/analytics/tokens', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

        // Token usage by model (current month)
        const byModel = await query(`
            SELECT 
                model_id,
                COUNT(*) as request_count,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                AVG(total_tokens) as avg_tokens_per_request
            FROM usage_logs
            WHERE month_year = ?
            GROUP BY model_id
            ORDER BY total_tokens DESC
        `, [currentMonth]);

        // Token usage by user (current month, top 20)
        const byUser = await query(`
            SELECT 
                u.id as user_id,
                u.email,
                CONCAT(u.first_name, ' ', u.last_name) as user_name,
                u.role,
                u.monthly_prompt_count,
                u.monthly_prompt_limit,
                COUNT(ul.id) as request_count,
                COALESCE(SUM(ul.total_tokens), 0) as total_tokens,
                COALESCE(SUM(ul.prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(ul.completion_tokens), 0) as completion_tokens
            FROM users u
            LEFT JOIN usage_logs ul ON u.id = ul.user_id AND ul.month_year = ?
            WHERE u.is_active = TRUE
            GROUP BY u.id, u.email, u.first_name, u.last_name, u.role, u.monthly_prompt_count, u.monthly_prompt_limit
            ORDER BY total_tokens DESC
            LIMIT 20
        `, [currentMonth]);

        // Daily token usage trend
        const dailyTrend = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as requests,
                SUM(total_tokens) as tokens
            FROM usage_logs
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [daysInt]);

        // Overall totals for current month
        const monthlyTotals = await query(`
            SELECT 
                COUNT(*) as total_requests,
                COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens
            FROM usage_logs
            WHERE month_year = ?
        `, [currentMonth]);

        res.json({
            success: true,
            tokenUsage: {
                period: currentMonth,
                byModel,
                byUser,
                dailyTrend,
                monthlyTotals: monthlyTotals[0] || {}
            }
        });

    } catch (error) {
        console.error('Token analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token analytics'
        });
    }
});

// Get action summary
router.get('/action-stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const stats = await AuditTrail.getActionStats(parseInt(days));

        res.json({
            success: true,
            actionStats: stats
        });

    } catch (error) {
        console.error('Action stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch action statistics'
        });
    }
});

// System health check
router.get('/health', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // Check database connection
        const dbCheck = await query('SELECT 1 as result');
        const dbStatus = dbCheck[0]?.result === 1;

        // Get uptime and memory usage
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();

        // Check AI provider configuration (DeepSeek)
        const apiKeyConfigured = !!process.env.DEEPSEEK_API_KEY;

        res.json({
            success: true,
            health: {
                status: 'operational',
                database: dbStatus ? 'connected' : 'disconnected',
                apiKey: apiKeyConfigured ? 'configured' : 'not configured',
                uptime: Math.floor(uptime),
                memory: {
                    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
                    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB'
                },
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            success: false,
            health: {
                status: 'degraded',
                error: error.message
            }
        });
    }
});

// ======================== METRICS ENDPOINTS ========================

// Get retrieval service metrics
router.get('/metrics/retrieval', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        const metrics = aiService.getRetrievalMetrics();
        
        res.json({
            success: true,
            metrics,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Retrieval metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch retrieval metrics'
        });
    }
});

// Get Elasticsearch metrics
router.get('/metrics/elasticsearch', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const elasticsearchService = require('../services/elasticsearchService');
        const stats = await elasticsearchService.getStats();
        const isAvailable = await elasticsearchService.isAvailable();
        
        res.json({
            success: true,
            elasticsearch: {
                available: isAvailable,
                ...stats
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Elasticsearch metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch Elasticsearch metrics'
        });
    }
});

// Get FAQ cache metrics
router.get('/metrics/faq', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // NOTE: column is `last_used_at` in the academic-advisor schema (was
        // `last_used` in the legacy assistant DB).
        const stats = await query(`
            SELECT 
                COUNT(*) as total_faqs,
                COUNT(DISTINCT document_id) as documents_with_faqs,
                AVG(confidence_score) as avg_confidence,
                SUM(usage_count) as total_usage,
                MAX(last_used_at) as last_used_at
            FROM cached_qa
        `);
        
        // Get by document breakdown
        const byDocument = await query(`
            SELECT 
                d.title,
                d.id as document_id,
                COUNT(*) as faq_count,
                AVG(cq.confidence_score) as avg_confidence,
                SUM(cq.usage_count) as total_usage
            FROM cached_qa cq
            JOIN documents d ON cq.document_id = d.id
            GROUP BY d.id, d.title
            ORDER BY faq_count DESC
        `);
        
        res.json({
            success: true,
            faq: {
                ...stats[0],
                byDocument
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('FAQ metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch FAQ metrics'
        });
    }
});

// Get combined system performance metrics
router.get('/metrics/performance', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        const elasticsearchService = require('../services/elasticsearchService');
        
        // Retrieval metrics
        const retrievalMetrics = aiService.getRetrievalMetrics();
        
        // ES status
        const esAvailable = await elasticsearchService.isAvailable();
        const esStats = esAvailable ? await elasticsearchService.getStats() : null;
        
        // FAQ stats
        const faqStats = await query(`
            SELECT COUNT(*) as total, SUM(usage_count) as hits FROM cached_qa
        `);
        
        // Recent chat performance (last 24h)
        const chatPerf = await query(`
            SELECT 
                COUNT(*) as messages_24h,
                AVG(response_time_ms) as avg_response_time_ms,
                MAX(response_time_ms) as max_response_time_ms,
                MIN(response_time_ms) as min_response_time_ms
            FROM chat_messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND sender = 'assistant'
        `);
        
        // Vector store stats
        const vectorStats = await query(`
            SELECT COUNT(*) as total_chunks, COUNT(DISTINCT document_id) as documents
            FROM document_chunks WHERE embedding IS NOT NULL
        `);
        
        res.json({
            success: true,
            performance: {
                retrieval: retrievalMetrics,
                elasticsearch: {
                    available: esAvailable,
                    documentCount: esStats?.documentCount || 0,
                    indexSize: esStats?.indexSizeHuman || 'N/A'
                },
                faq: {
                    totalCached: faqStats[0]?.total || 0,
                    totalHits: faqStats[0]?.hits || 0
                },
                chat: chatPerf[0] || {},
                vectorStore: vectorStats[0] || {}
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Performance metrics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch performance metrics'
        });
    }
});

// Clear retrieval caches (admin only)
router.post('/cache/clear', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        const { type = 'all' } = req.body; // all, query, context, document
        
        aiService.clearRetrievalCache();
        
        // Log the action
        const AuditTrail = require('../models/AuditTrail');
        await AuditTrail.log({
            userId: req.user.id,
            action: 'CACHE_CLEARED',
            details: { type },
            ipAddress: req.ip
        });
        
        res.json({
            success: true,
            message: `Cache cleared: ${type}`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Cache clear error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear cache'
        });
    }
});

// Rebuild Elasticsearch index (superadmin only)
router.post('/elasticsearch/rebuild', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const elasticsearchService = require('../services/elasticsearchService');
        
        const isAvailable = await elasticsearchService.isAvailable();
        if (!isAvailable) {
            return res.status(503).json({
                success: false,
                error: 'Elasticsearch is not available'
            });
        }
        
        // Start rebuild (this can take a while)
        res.json({
            success: true,
            message: 'Index rebuild started. Check logs for progress.',
            timestamp: new Date().toISOString()
        });
        
        // Run rebuild asynchronously
        elasticsearchService.rebuildIndex().then(result => {
            console.log('[Admin] Elasticsearch rebuild completed:', result);
        }).catch(err => {
            console.error('[Admin] Elasticsearch rebuild failed:', err);
        });
        
    } catch (error) {
        console.error('ES rebuild error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start index rebuild'
        });
    }
});

// Data cleanup (superadmin only)
router.post('/cleanup', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { cleanAuditDays = 365, cleanChatDays = 365, cleanExportDays = 7 } = req.body;

        const results = {
            auditRecords: await AuditTrail.cleanOldRecords(cleanAuditDays),
            chatMessages: await ChatMessage.cleanOldMessages(cleanChatDays)
        };

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DATA_CLEANUP',
            details: results,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Cleanup completed',
            results
        });

    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to perform cleanup'
        });
    }
});

// Get cache statistics and health
router.get('/cache/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const aiService = require('../services/aiService');
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            // Cache service not available
        }

        const stats = {
            aiService: aiService.getResponseCacheStats(),
            timestamp: new Date().toISOString()
        };

        if (cacheService) {
            stats.redis = cacheService.getStats();
            stats.health = await cacheService.healthCheck();
        }

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Cache stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get cache statistics'
        });
    }
});

// Clear cache (specific namespace or all)
router.post('/cache/clear', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { namespace } = req.body; // 'faq', 'embedding', 'response', 'retrieval', or 'all'
        
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        if (namespace === 'all') {
            await cacheService.clearAll();
        } else if (namespace) {
            await cacheService.clearNamespace(namespace);
        } else {
            return res.status(400).json({
                success: false,
                error: 'Please specify namespace or "all"'
            });
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CACHE_CLEARED',
            details: { namespace },
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: `Cache cleared: ${namespace}`
        });
    } catch (error) {
        console.error('Cache clear error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear cache'
        });
    }
});

// Trigger cache warming manually
router.post('/cache/warm', authenticateToken, requireAdmin, async (req, res) => {
    try {
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        // Run cache warming
        const result = await cacheService.warmCache();

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CACHE_WARMED',
            details: result,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Cache warming completed',
            result
        });
    } catch (error) {
        console.error('Cache warming error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to warm cache'
        });
    }
});

// Get cache warming status
router.get('/cache/warmup-status', authenticateToken, requireAdmin, async (req, res) => {
    try {
        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        res.json({
            success: true,
            warmup: cacheService.getWarmupStatus()
        });
    } catch (error) {
        console.error('Cache warmup status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get warmup status'
        });
    }
});

// Add custom queries to warmup list
router.post('/cache/warmup-queries', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { queries } = req.body;
        
        if (!queries || !Array.isArray(queries)) {
            return res.status(400).json({
                success: false,
                error: 'Please provide an array of queries'
            });
        }

        let cacheService;
        try {
            cacheService = require('../services/cacheService');
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Cache service not available'
            });
        }

        cacheService.addWarmupQueries(queries);

        res.json({
            success: true,
            message: `Added ${queries.length} queries to warmup list`,
            warmup: cacheService.getWarmupStatus()
        });
    } catch (error) {
        console.error('Add warmup queries error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add warmup queries'
        });
    }
});

async function _promoteAdvisorMessageToCache({ advisorId, question, answer, categoryId, qaType, adminUserId, ipAddress, userAgent }) {
    const arows = await query(
        `SELECT id, conversation_id, text AS advisor_text,
                display_markdown, speech_text, citations_json
         FROM advisor_messages
         WHERE id = ? AND role = 'advisor' LIMIT 1`,
        [advisorId]
    );
    const a = arows[0];
    if (!a) {
        const err = new Error('Advisor message not found');
        err.status = 404;
        throw err;
    }

    let q = String(question || '').trim();
    if (!q) {
        const srows = await query(
            `SELECT text FROM advisor_messages
             WHERE conversation_id = ? AND role = 'student' AND id < ?
             ORDER BY id DESC LIMIT 1`,
            [a.conversation_id, a.id]
        );
        q = String(srows[0]?.text || '').trim();
    }
    if (!q) {
        const err = new Error('No preceding student question found; supply question to override.');
        err.status = 400;
        throw err;
    }

    let ans = String(answer || '').trim();
    if (!ans) ans = String(a.display_markdown || a.speech_text || a.advisor_text || '').trim();
    if (!ans || ans.length < 8) {
        const err = new Error('Answer is empty or too short to cache.');
        err.status = 400;
        throw err;
    }

    const existingRows = await query(
        `SELECT id FROM cached_qa WHERE is_active = 1 AND question = ? LIMIT 1`,
        [q]
    );

    let answerSources = [];
    try { answerSources = a.citations_json ? JSON.parse(a.citations_json) : []; }
    catch (_) { answerSources = []; }

    let embedding = null;
    try {
        const aiService = require('../services/aiService');
        embedding = await aiService.generateEmbedding(q, true);
    } catch (err) {
        console.warn('[promote-qa] embedding failed:', err.message);
    }

    const CachedQA = require('../models/CachedQA');
    if (existingRows.length) {
        const id = existingRows[0].id;
        await query(
            `UPDATE cached_qa
             SET answer            = ?,
                 answer_sources    = ?,
                 embedding         = ?,
                 confidence_score  = 1.0,
                 is_active         = 1,
                 is_verified       = 1,
                 verified_by       = ?,
                 verified_at       = NOW(),
                 qa_type           = ?,
                 updated_at        = NOW()
             WHERE id = ?`,
            [
                ans,
                JSON.stringify(answerSources),
                embedding ? JSON.stringify(embedding) : null,
                adminUserId,
                qaType || 'curated',
                id
            ]
        );
        await AuditTrail.log({
            userId: adminUserId,
            action: 'PROMOTE_ADVISOR_QA',
            entityType: 'cached_qa',
            entityId: id,
            details: { advisorMessageId: advisorId, mode: 'refreshed' },
            ipAddress,
            userAgent
        });
        _invalidateFAQCache();
        return { mode: 'refreshed', cachedQaId: id };
    }

    const newId = await CachedQA.create({
        documentId: null,
        categoryId: categoryId || null,
        question: q,
        questionVariations: [],
        answer: ans,
        answerSources,
        embedding,
        confidenceScore: 1.0,
        createdBy: adminUserId,
        qaType: qaType || 'curated'
    });

    try {
        await query(
            `UPDATE cached_qa SET is_verified = 1, verified_by = ?, verified_at = NOW() WHERE id = ?`,
            [adminUserId, newId]
        );
    } catch (_) { /* ignore */ }

    await AuditTrail.log({
        userId: adminUserId,
        action: 'PROMOTE_ADVISOR_QA',
        entityType: 'cached_qa',
        entityId: newId,
        details: { advisorMessageId: advisorId, mode: 'created' },
        ipAddress,
        userAgent
    });
    _invalidateFAQCache();
    return { mode: 'created', cachedQaId: newId };
}

// ============================================================================
// FAQ Curation — review recent advisor Q&A turns and promote them into the
// `cached_qa` table so they short-circuit the LLM next time the same (or
// semantically similar) question is asked.
//
// Workflow:
//   GET    /admin/advisor/recent-qa      — recent advisor turns + cache hit?
//   POST   /admin/advisor/promote/:id    — turn an advisor_messages row into a
//                                          cached_qa entry (with embedding)
//   DELETE /admin/cached-qa/:id          — deactivate (soft-delete) a cache
//                                          entry curated earlier
// ============================================================================

// List the most recent advisor reply turns paired with the immediately-
// preceding student question, so an admin can decide what to promote.
router.get('/advisor/recent-qa', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const limit  = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const minScore = Number.isFinite(Number(req.query.minScore)) ? Number(req.query.minScore) : null;
        const maxScore = Number.isFinite(Number(req.query.maxScore)) ? Number(req.query.maxScore) : null;
        const onlyLow = String(req.query.onlyLow || '').trim() === '1';

        try { await responseQualityService.ensureTable(); } catch (_) { /* ignore */ }

        const where = ['a.role = \'advisor\''];
        const params = [];
        if (onlyLow) where.push('(rq.overall_score IS NULL OR rq.overall_score < 0.70)');
        if (minScore !== null) {
            where.push('rq.overall_score >= ?');
            params.push(Math.max(0, Math.min(1, minScore)));
        }
        if (maxScore !== null) {
            where.push('rq.overall_score <= ?');
            params.push(Math.max(0, Math.min(1, maxScore)));
        }
        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        // Pair each advisor row with its most-recent earlier student row in
        // the same conversation. We sort by the advisor row's id descending.
        const rows = await query(`
            SELECT
                a.id              AS advisor_message_id,
                a.conversation_id,
                a.created_at,
                a.text            AS advisor_text,
                a.display_markdown,
                a.speech_text,
                a.tokens_in, a.tokens_out, a.latency_ms,
                a.citations_json,
                                rq.addressed_score,
                                rq.grounding_score,
                                rq.citation_score,
                                rq.completeness_score,
                                rq.overall_score,
                                rq.auto_cache_eligible,
                                rq.auto_cached,
                                rq.auto_cached_qa_id,
                                rq.score_version,
                                 rq.feedback_score,
                                 rq.helpful_count,
                                 rq.not_helpful_count,
                                 rq.admin_cache_decision,
                                 rq.admin_cache_user_id,
                                 rq.admin_cache_decided_at,
                (SELECT s.text
                   FROM advisor_messages s
                   WHERE s.conversation_id = a.conversation_id
                     AND s.role = 'student'
                     AND s.id < a.id
                   ORDER BY s.id DESC LIMIT 1)        AS question_text,
                (SELECT q.id FROM cached_qa q
                   WHERE q.is_active = 1
                     AND q.question = (SELECT s2.text
                                         FROM advisor_messages s2
                                         WHERE s2.conversation_id = a.conversation_id
                                           AND s2.role = 'student'
                                           AND s2.id < a.id
                                         ORDER BY s2.id DESC LIMIT 1)
                   LIMIT 1)                            AS existing_cache_id
            FROM advisor_messages a
                        LEFT JOIN advisor_response_quality rq ON rq.advisor_message_id = a.id
                        ${whereClause}
            ORDER BY a.id DESC
            LIMIT ? OFFSET ?
                `, [...params, limit, offset]);

        // Drop rows that have no preceding student question (would be useless
        // to cache).
        const items = rows.filter(r => r.question_text && r.question_text.trim().length > 2);

        res.json({ success: true, items });
    } catch (err) {
        console.error('Recent advisor Q&A error:', err);
        res.status(500).json({ success: false, error: 'Could not load recent Q&A' });
    }
});

// Quick quality overview for admin curation workflow
router.get('/advisor/quality-summary', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await responseQualityService.ensureTable();
        const rows = await query(`
            SELECT
                COUNT(*) AS total_scored,
                AVG(overall_score) AS avg_overall,
                SUM(CASE WHEN overall_score < 0.70 THEN 1 ELSE 0 END) AS low_quality,
                SUM(CASE WHEN auto_cache_eligible = 1 THEN 1 ELSE 0 END) AS eligible_for_auto_cache,
                SUM(CASE WHEN auto_cached = 1 THEN 1 ELSE 0 END) AS auto_cached_count,
                SUM(COALESCE(helpful_count, 0)) AS helpful_votes,
                SUM(COALESCE(not_helpful_count, 0)) AS unhelpful_votes
            FROM advisor_response_quality
        `);
        res.json({ success: true, summary: rows[0] || {} });
    } catch (err) {
        console.error('Advisor quality summary error:', err);
        res.status(500).json({ success: false, error: 'Could not load quality summary' });
    }
});

// Combined operational health view for advisor service, response quality, and SLO state.
router.get('/advisor/health-overview', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const metrics = typeof advisorStreamService.getStreamMetrics === 'function'
            ? advisorStreamService.getStreamMetrics()
            : {};

        await responseQualityService.ensureTable();
        const qualityRows = await query(`
            SELECT
                COUNT(*) AS total_scored,
                AVG(overall_score) AS avg_overall,
                SUM(CASE WHEN overall_score < 0.70 THEN 1 ELSE 0 END) AS low_quality,
                SUM(CASE WHEN auto_cache_eligible = 1 THEN 1 ELSE 0 END) AS eligible_for_auto_cache,
                SUM(CASE WHEN auto_cached = 1 THEN 1 ELSE 0 END) AS auto_cached_count,
                SUM(COALESCE(helpful_count, 0)) AS helpful_votes,
                SUM(COALESCE(not_helpful_count, 0)) AS unhelpful_votes
            FROM advisor_response_quality
        `);

        res.json({
            success: true,
            generated_at: new Date().toISOString(),
            health: {
                providers: {
                    llm: Boolean(process.env.DEEPSEEK_API_KEY),
                    tts: Boolean(process.env.AZURE_SPEECH_KEY || process.env.EDGE_TTS_API_KEY || process.env.TTS_PROVIDER),
                    stt: Boolean(process.env.OPENAI_API_KEY || process.env.AZURE_SPEECH_KEY),
                    rag: process.env.ENABLE_RAG !== 'false'
                },
                metrics
            },
            quality: qualityRows[0] || {}
        });
    } catch (err) {
        console.error('Advisor health overview error:', err);
        res.status(500).json({ success: false, error: 'Could not load advisor health overview' });
    }
});

router.post('/advisor/test-alert', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const status = String(req.body?.status || 'warning').trim().toLowerCase();
        if (!['warning', 'alert'].includes(status)) {
            return res.status(400).json({ success: false, error: 'status must be warning or alert' });
        }

        const metrics = typeof advisorStreamService.getStreamMetrics === 'function'
            ? advisorStreamService.getStreamMetrics()
            : {};

        const result = typeof advisorStreamService.triggerSloAlert === 'function'
            ? await advisorStreamService.triggerSloAlert({
                status,
                p95: Number(req.body?.p95 ?? metrics.p95LatencyMs ?? 0),
                errorRatePct: Number(req.body?.errorRatePct ?? metrics.errorRatePct ?? 0)
            })
            : { success: false, error: 'SLO alert trigger not available' };

        res.json({ success: true, alert: result });
    } catch (err) {
        console.error('Advisor test alert error:', err);
        res.status(500).json({ success: false, error: err.message || 'Could not send test alert' });
    }
});

router.get('/advisor/quality-export', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await responseQualityService.ensureTable();
        const limit = Math.max(1, Math.min(5000, parseInt(req.query?.limit, 10) || 500));
        const rows = await query(`
            SELECT
                advisor_message_id,
                conversation_id,
                addressed_score,
                grounding_score,
                citation_score,
                completeness_score,
                overall_score,
                auto_cache_eligible,
                auto_cached,
                helpful_count,
                not_helpful_count,
                feedback_score,
                admin_cache_decision,
                created_at
            FROM advisor_response_quality
            ORDER BY advisor_message_id DESC
            LIMIT ?
        `, [limit]);

        const columns = [
            'advisor_message_id',
            'conversation_id',
            'addressed_score',
            'grounding_score',
            'citation_score',
            'completeness_score',
            'overall_score',
            'auto_cache_eligible',
            'auto_cached',
            'helpful_count',
            'not_helpful_count',
            'feedback_score',
            'admin_cache_decision',
            'created_at'
        ];

        const csvRows = [columns.join(',')];
        for (const row of rows) {
            const values = columns.map((col) => {
                const value = row[col] ?? '';
                const str = String(value).replace(/\r?\n/g, ' ');
                return /[",]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
            });
            csvRows.push(values.join(','));
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="advisor-quality-export.csv"');
        return res.send(csvRows.join('\n'));
    } catch (err) {
        console.error('Advisor quality export error:', err);
        return res.status(500).json({ success: false, error: 'Could not export advisor quality report' });
    }
});

router.get('/advisor/quality-trend', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await responseQualityService.ensureTable();
        const days = Math.max(7, Math.min(30, parseInt(req.query?.days, 10) || 14));
        const rows = await query(`
            SELECT
                DATE(created_at) AS day,
                COUNT(*) AS total_scored,
                AVG(overall_score) AS avg_overall,
                SUM(CASE WHEN overall_score < 0.70 THEN 1 ELSE 0 END) AS low_quality,
                SUM(CASE WHEN auto_cache_eligible = 1 THEN 1 ELSE 0 END) AS eligible_for_auto_cache
            FROM advisor_response_quality
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY day DESC
        `, [days]);

        res.json({
            success: true,
            rangeDays: days,
            trend: rows.map(r => ({
                day: r.day,
                total_scored: Number(r.total_scored || 0),
                avg_overall: Number(r.avg_overall || 0),
                low_quality: Number(r.low_quality || 0),
                eligible_for_auto_cache: Number(r.eligible_for_auto_cache || 0)
            }))
        });
    } catch (err) {
        console.error('Advisor quality trend error:', err);
        res.status(500).json({ success: false, error: 'Could not load advisor quality trend' });
    }
});

// Promote an advisor reply into the FAQ cache. Generates the question
// embedding via the existing embedding service so the FAQ similarity search
// will pick it up.
router.post('/advisor/promote/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const advisorId = parseInt(req.params.id, 10);
        if (!advisorId) return res.status(400).json({ success: false, error: 'Invalid id' });

        // Optional overrides
        let { question, answer, categoryId, qaType } = req.body || {};
        const result = await _promoteAdvisorMessageToCache({
            advisorId,
            question,
            answer,
            categoryId,
            qaType,
            adminUserId: req.user.id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });
        try {
            await responseQualityService.setAdminCacheDecision({ advisorMessageId: advisorId, decision: 'approved', adminUserId: req.user.id });
        } catch (_) { /* ignore */ }
        res.json({ success: true, mode: result.mode, cachedQaId: result.cachedQaId });
    } catch (err) {
        console.error('Promote advisor Q&A error:', err);
        res.status(err.status || 500).json({ success: false, error: err.message || 'Could not promote Q&A' });
    }
});

// Admin decision on score-driven caching for a specific advisor reply.
// approve => force promote/refresh in cache; block => prevent auto-cache use.
router.post('/advisor/quality/:id/decision', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const advisorId = parseInt(req.params.id, 10);
        const decision = String(req.body?.decision || '').trim().toLowerCase();
        if (!advisorId) return res.status(400).json({ success: false, error: 'Invalid advisor message id' });
        if (!['approved', 'blocked', 'none'].includes(decision)) {
            return res.status(400).json({ success: false, error: 'decision must be approved, blocked, or none' });
        }

        let promoted = null;
        if (decision === 'approved') {
            promoted = await _promoteAdvisorMessageToCache({
                advisorId,
                question: req.body?.question,
                answer: req.body?.answer,
                categoryId: req.body?.categoryId,
                qaType: 'curated',
                adminUserId: req.user.id,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent']
            });
        }

        await responseQualityService.setAdminCacheDecision({
            advisorMessageId: advisorId,
            decision,
            adminUserId: req.user.id
        });

        if (decision === 'blocked') {
            const rows = await query(
                `SELECT auto_cached_qa_id FROM advisor_response_quality WHERE advisor_message_id = ? LIMIT 1`,
                [advisorId]
            );
            const cachedId = Number(rows?.[0]?.auto_cached_qa_id || 0);
            if (cachedId) {
                await query(`UPDATE cached_qa SET is_active = 0 WHERE id = ?`, [cachedId]);
                await query(
                    `UPDATE advisor_response_quality
                     SET auto_cached = 0,
                         auto_cached_qa_id = NULL
                     WHERE advisor_message_id = ?`,
                    [advisorId]
                );
                _invalidateFAQCache();
            }
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'ADVISOR_CACHE_DECISION',
            entityType: 'advisor_message',
            entityId: advisorId,
            details: { decision, promotedCachedQaId: promoted?.cachedQaId || null },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        return res.json({
            success: true,
            decision,
            promoted: promoted ? { mode: promoted.mode, cachedQaId: promoted.cachedQaId } : null
        });
    } catch (err) {
        console.error('Advisor cache decision error:', err);
        res.status(err.status || 500).json({ success: false, error: err.message || 'Could not save decision' });
    }
});

// Soft-delete a cached_qa entry.
router.delete('/cached-qa/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
        const CachedQA = require('../models/CachedQA');
        await CachedQA.deactivate(id);
        _invalidateFAQCache();

        await AuditTrail.log({
            userId: req.user.id,
            action: 'DELETE_CACHED_QA',
            entityType: 'cached_qa',
            entityId: id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete cached_qa error:', err);
        res.status(500).json({ success: false, error: 'Could not delete cache entry' });
    }
});

// ----------------------------------------------------------------------------
// AI text-cleanup helper.
//
// Runs the question + answer through the LLM with a strict "edit-only"
// instruction: fix grammar, spelling, clarity, but keep all factual content
// EXACTLY as supplied. Returns {question, answer} the admin can review,
// optionally tweak further, then save.
//
// Body:  { question: string, answer: string }
// 200:   { success, question, answer, changed: boolean }
// ----------------------------------------------------------------------------
router.post('/advisor/cleanup-text', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const question = String(req.body?.question || '').trim();
        const answer   = String(req.body?.answer   || '').trim();
        if (!question || !answer) {
            return res.status(400).json({ success: false, error: 'question and answer are required' });
        }

        const llm = require('../services/llmClient');
        const persona = require('../services/advisorPersonaService');

        const sys = `You are a careful copy-editor. The user will give you a Q&A pair for a Bayelsa Medical University FAQ. Your ONLY job is to:
1. Fix spelling, grammar, punctuation and capitalisation.
2. Tighten wording for clarity and brevity.
3. Make sentences flow naturally.

You MUST NOT:
- Add new facts, figures, dates, names, numbers, or claims.
- Remove or alter any factual content (numbers, names, dates, requirements, fee amounts).
- Add markdown formatting symbols (no **, ##, backticks, etc.).
- Add salutations, vocatives, or filler ("My dear student", "I hope this helps", etc.).

Return STRICT JSON only, with this shape:
{"question":"<edited question>","answer":"<edited answer>"}
No prose before or after the JSON.`;

        const user = `Edit this for clarity, grammar and language. Keep ALL facts identical.

QUESTION:
${question}

ANSWER:
${answer}`;

        let edited = { question, answer };
        let changed = false;
        try {
            const r = await llm.chat(
                [
                    { role: 'system', content: sys },
                    { role: 'user',   content: user }
                ],
                { jsonMode: true, maxTokens: 1024, temperature: 0.2, timeoutMs: 30_000 }
            );
            const parsed = JSON.parse(r.content || '{}');
            const eq = persona.scrubAll(String(parsed.question || '').trim());
            const ea = persona.scrubAll(String(parsed.answer || '').trim());
            if (eq && ea) {
                edited = { question: eq, answer: ea };
                changed = (eq !== question) || (ea !== answer);
            }
        } catch (err) {
            console.warn('[cleanup-text] LLM call failed, returning original:', err.message);
        }

        res.json({ success: true, ...edited, changed });
    } catch (err) {
        console.error('cleanup-text error:', err);
        res.status(500).json({ success: false, error: 'Cleanup failed' });
    }
});

// ----------------------------------------------------------------------------
// Create a cached_qa entry directly from an admin form (no advisor message
// to promote — the admin types both fields). Generates the embedding so the
// new row is reachable by semantic search.
//
// Body:  { question: string, answer: string, categoryId?: number,
//          documentId?: number, qaType?: string }
// 201:   { success, cachedQaId, mode: 'created' | 'refreshed' }
// ----------------------------------------------------------------------------
router.post('/cached-qa', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const persona = require('../services/advisorPersonaService');
        const aiService = require('../services/aiService');
        const CachedQA = require('../models/CachedQA');

        const question  = persona.scrubAll(String(req.body?.question || '').trim());
        const answer    = persona.scrubAll(String(req.body?.answer   || '').trim());
        const categoryId = req.body?.categoryId ? parseInt(req.body.categoryId, 10) : null;
        const documentId = req.body?.documentId ? parseInt(req.body.documentId, 10) : null;
        const qaType    = (req.body?.qaType || 'curated').slice(0, 50);

        if (!question || question.length < 5) {
            return res.status(400).json({ success: false, error: 'Question is too short' });
        }
        if (!answer || answer.length < 8) {
            return res.status(400).json({ success: false, error: 'Answer is too short' });
        }

        // De-dupe: refresh any existing active row with the exact same question.
        const existingRows = await query(
            `SELECT id FROM cached_qa WHERE is_active = 1 AND question = ? LIMIT 1`,
            [question]
        );

        let embedding = null;
        try {
            embedding = await aiService.generateEmbedding(question, true);
        } catch (err) {
            console.warn('[create cached-qa] embedding failed:', err.message);
        }

        if (existingRows.length) {
            const id = existingRows[0].id;
            await query(
                `UPDATE cached_qa
                 SET answer            = ?,
                     embedding         = ?,
                     category_id       = COALESCE(?, category_id),
                     document_id       = COALESCE(?, document_id),
                     confidence_score  = 1.0,
                     is_active         = 1,
                     is_verified       = 1,
                     verified_by       = ?,
                     verified_at       = NOW(),
                     qa_type           = ?,
                     updated_at        = NOW()
                 WHERE id = ?`,
                [
                    answer,
                    embedding ? JSON.stringify(embedding) : null,
                    categoryId, documentId,
                    req.user.id,
                    qaType,
                    id
                ]
            );
            await AuditTrail.log({
                userId: req.user.id,
                action: 'CREATE_CACHED_QA',
                entityType: 'cached_qa',
                entityId: id,
                details: { mode: 'refreshed', qaType },
                ipAddress: req.ip,
                userAgent: req.headers['user-agent']
            });
            _invalidateFAQCache();
            return res.json({ success: true, mode: 'refreshed', cachedQaId: id });
        }

        const newId = await CachedQA.create({
            documentId,
            categoryId,
            question,
            questionVariations: [],
            answer,
            answerSources: [],
            embedding,
            confidenceScore: 1.0,
            createdBy: req.user.id,
            qaType
        });

        try {
            await query(
                `UPDATE cached_qa SET is_verified = 1, verified_by = ?, verified_at = NOW() WHERE id = ?`,
                [req.user.id, newId]
            );
        } catch (_) { /* ignore if columns absent */ }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'CREATE_CACHED_QA',
            entityType: 'cached_qa',
            entityId: newId,
            details: { mode: 'created', qaType },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });
        _invalidateFAQCache();

        res.status(201).json({ success: true, mode: 'created', cachedQaId: newId });
    } catch (err) {
        console.error('Create cached_qa error:', err);
        res.status(500).json({ success: false, error: 'Could not create Q&A' });
    }
});

router.get('/evaluation/tests', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await _ensureEvaluationSchema();
        const includeInactive = String(req.query.includeInactive || '') === '1';
        const rows = await query(`
            SELECT * FROM advisor_eval_tests
            ${includeInactive ? '' : 'WHERE is_active = TRUE'}
            ORDER BY is_active DESC, last_status = 'failed' DESC, updated_at DESC, id DESC
            LIMIT ?
        `, [Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200))]);
        const tests = rows.map(_shapeEvalTest);
        const summary = {
            total: tests.length,
            active: tests.filter(t => t.isActive).length,
            passed: tests.filter(t => t.lastStatus === 'passed').length,
            failed: tests.filter(t => t.lastStatus === 'failed').length,
            neverRun: tests.filter(t => !t.lastStatus).length
        };
        res.json({ success: true, tests, summary });
    } catch (error) {
        console.error('Evaluation tests list error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not list evaluation tests' });
    }
});

router.post('/evaluation/tests', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await _ensureEvaluationSchema();
        const question = String(req.body?.question || '').trim();
        if (question.length < 6) return res.status(400).json({ success: false, error: 'Question is required' });
        const expectedTerms = _jsonArray(req.body?.expectedTerms || req.body?.expected_terms);
        const forbiddenTerms = _jsonArray(req.body?.forbiddenTerms || req.body?.forbidden_terms);
        const result = await query(`
            INSERT INTO advisor_eval_tests
                (question, topic, risk_level, expected_terms_json, forbidden_terms_json, source_hint, min_confidence, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            question,
            String(req.body?.topic || '').trim() || null,
            String(req.body?.riskLevel || 'high').trim() || 'high',
            JSON.stringify(expectedTerms),
            JSON.stringify(forbiddenTerms),
            String(req.body?.sourceHint || '').trim() || null,
            Math.max(0, Math.min(1, Number(req.body?.minConfidence ?? 0.12))),
            req.user.id
        ]);
        await AuditTrail.log({
            userId: req.user.id,
            action: 'ADVISOR_EVAL_TEST_CREATED',
            entityType: 'advisor_eval_test',
            entityId: result.insertId,
            details: { topic: req.body?.topic || null },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });
        const rows = await query('SELECT * FROM advisor_eval_tests WHERE id = ?', [result.insertId]);
        res.status(201).json({ success: true, test: _shapeEvalTest(rows[0]) });
    } catch (error) {
        console.error('Evaluation test create error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not create evaluation test' });
    }
});

router.put('/evaluation/tests/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await _ensureEvaluationSchema();
        const rows = await query('SELECT * FROM advisor_eval_tests WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, error: 'Evaluation test not found' });
        await query(`
            UPDATE advisor_eval_tests
            SET question = ?, topic = ?, risk_level = ?, expected_terms_json = ?, forbidden_terms_json = ?,
                source_hint = ?, min_confidence = ?, is_active = ?, updated_at = NOW()
            WHERE id = ?
        `, [
            String(req.body?.question ?? rows[0].question).trim(),
            String(req.body?.topic ?? rows[0].topic ?? '').trim() || null,
            String(req.body?.riskLevel ?? rows[0].risk_level ?? 'high').trim() || 'high',
            JSON.stringify(_jsonArray(req.body?.expectedTerms ?? rows[0].expected_terms_json)),
            JSON.stringify(_jsonArray(req.body?.forbiddenTerms ?? rows[0].forbidden_terms_json)),
            String(req.body?.sourceHint ?? rows[0].source_hint ?? '').trim() || null,
            Math.max(0, Math.min(1, Number(req.body?.minConfidence ?? rows[0].min_confidence ?? 0.12))),
            req.body?.isActive === undefined ? Boolean(rows[0].is_active) : req.body.isActive === true,
            req.params.id
        ]);
        const updated = await query('SELECT * FROM advisor_eval_tests WHERE id = ?', [req.params.id]);
        res.json({ success: true, test: _shapeEvalTest(updated[0]) });
    } catch (error) {
        console.error('Evaluation test update error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not update evaluation test' });
    }
});

router.delete('/evaluation/tests/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await _ensureEvaluationSchema();
        await query('UPDATE advisor_eval_tests SET is_active = FALSE, updated_at = NOW() WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Evaluation test archive error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not archive evaluation test' });
    }
});

router.post('/evaluation/tests/:id/run', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await _ensureEvaluationSchema();
        const rows = await query('SELECT * FROM advisor_eval_tests WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, error: 'Evaluation test not found' });
        const result = await _runEvaluationTest(rows[0]);
        await query(`
            UPDATE advisor_eval_tests
            SET last_status = ?, last_score = ?, last_result_json = ?, last_run_at = NOW(), updated_at = NOW()
            WHERE id = ?
        `, [result.status, result.score, JSON.stringify(result), req.params.id]);
        res.json({ success: true, result });
    } catch (error) {
        console.error('Evaluation test run error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not run evaluation test' });
    }
});

router.post('/evaluation/run-all', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await _ensureEvaluationSchema();
        const rows = await query('SELECT * FROM advisor_eval_tests WHERE is_active = TRUE ORDER BY id ASC LIMIT ?', [
            Math.max(1, Math.min(100, parseInt(req.body?.limit, 10) || 50))
        ]);
        const results = [];
        for (const row of rows) {
            const result = await _runEvaluationTest(row);
            await query(`
                UPDATE advisor_eval_tests
                SET last_status = ?, last_score = ?, last_result_json = ?, last_run_at = NOW(), updated_at = NOW()
                WHERE id = ?
            `, [result.status, result.score, JSON.stringify(result), row.id]);
            results.push({ id: row.id, question: row.question, ...result });
        }
        res.json({
            success: true,
            total: results.length,
            passed: results.filter(r => r.status === 'passed').length,
            failed: results.filter(r => r.status === 'failed').length,
            results
        });
    } catch (error) {
        console.error('Evaluation run-all error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not run evaluation tests' });
    }
});

router.get('/structured-records/tables', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await documentLabService.ensureSchema();
        const tables = [];
        for (const [name, config] of Object.entries(STRUCTURED_TABLES)) {
            let count = 0;
            try {
                const rows = await query(`SELECT COUNT(*) AS count FROM ${name}`);
                count = Number(rows?.[0]?.count || 0);
            } catch (_) {}
            tables.push({
                name,
                label: config.label,
                description: config.description,
                columns: config.columns,
                required: config.required,
                count
            });
        }
        res.json({ success: true, tables });
    } catch (error) {
        console.error('Structured records table list error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not list structured tables' });
    }
});

router.get('/structured-records/:table', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await documentLabService.ensureSchema();
        const config = _structuredTableConfig(req.params.table);
        if (!config) return res.status(404).json({ success: false, error: 'Unknown structured table' });

        const limit = Math.max(1, Math.min(300, parseInt(req.query.limit, 10) || 100));
        const q = String(req.query.q || '').trim();
        let where = '';
        const params = [];
        if (q) {
            where = `WHERE ${config.search.map(column => `${column} LIKE ?`).join(' OR ')}`;
            params.push(...config.search.map(() => `%${q}%`));
        }

        const rows = await query(
            `SELECT * FROM ${config.name} ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
            [...params, limit]
        );
        res.json({
            success: true,
            table: {
                name: config.name,
                label: config.label,
                description: config.description,
                columns: config.columns,
                required: config.required
            },
            records: rows.map(row => _shapeStructuredRow(config, row))
        });
    } catch (error) {
        console.error('Structured records list error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not list structured records' });
    }
});

router.get('/structured-records/:table/template', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const config = _structuredTableConfig(req.params.table);
        if (!config) return res.status(404).json({ success: false, error: 'Unknown structured table' });

        const rows = _structuredTemplateRows(config.name, config);
        const instructions = [
            { field: 'Table', value: config.label },
            { field: 'Required columns', value: config.required.join(', ') },
            { field: 'Notes', value: 'Leave id blank to create a new record. Add an id value to update an existing record. Keep status as active for production use.' }
        ];
        const workbook = XLSX.utils.book_new();
        const templateRows = rows.map(row => ({ id: '', ...row }));
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(templateRows, { header: ['id', ...config.columns] }), 'Records');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(instructions), 'Instructions');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${config.name}_template.xlsx"`);
        res.send(buffer);
    } catch (error) {
        console.error('Structured records template error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not create template' });
    }
});

router.post('/structured-records/:table', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await documentLabService.ensureSchema();
        const config = _structuredTableConfig(req.params.table);
        if (!config) return res.status(404).json({ success: false, error: 'Unknown structured table' });
        const result = await _upsertStructuredRecord(config.name, config, req.body || {});
        await _syncPrincipalOfficerRecord(config.name, req.body || {});
        await AuditTrail.log({
            userId: req.user.id,
            action: 'STRUCTURED_RECORD_CREATED',
            entityType: config.name,
            entityId: result.id ? parseInt(result.id, 10) : null,
            details: { table: config.name },
            ipAddress: req.ip
        });
        _invalidateStructuredLookupCache();
        res.json({ success: true, message: 'Structured record created', result });
    } catch (error) {
        console.error('Structured records create error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not create structured record' });
    }
});

router.put('/structured-records/:table/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await documentLabService.ensureSchema();
        const config = _structuredTableConfig(req.params.table);
        if (!config) return res.status(404).json({ success: false, error: 'Unknown structured table' });
        const record = { ...req.body, id: req.params.id };
        const result = await _upsertStructuredRecord(config.name, config, record);
        await _syncPrincipalOfficerRecord(config.name, record);
        await AuditTrail.log({
            userId: req.user.id,
            action: 'STRUCTURED_RECORD_UPDATED',
            entityType: config.name,
            entityId: parseInt(req.params.id, 10),
            details: { table: config.name },
            ipAddress: req.ip
        });
        _invalidateStructuredLookupCache();
        res.json({ success: true, message: 'Structured record updated', result });
    } catch (error) {
        console.error('Structured records update error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not update structured record' });
    }
});

router.delete('/structured-records/:table/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await documentLabService.ensureSchema();
        const config = _structuredTableConfig(req.params.table);
        if (!config) return res.status(404).json({ success: false, error: 'Unknown structured table' });
        if (!config.columns.includes('status')) {
            return res.status(400).json({ success: false, error: 'This structured table does not support archiving' });
        }
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Valid record id is required' });

        await query(
            `UPDATE ${config.name}
             SET status = 'inactive', updated_at = NOW()
             WHERE id = ?`,
            [id]
        );
        await AuditTrail.log({
            userId: req.user.id,
            action: 'STRUCTURED_RECORD_ARCHIVED',
            entityType: config.name,
            entityId: id,
            details: { table: config.name },
            ipAddress: req.ip
        });
        _invalidateStructuredLookupCache();
        res.json({ success: true, message: 'Structured record archived' });
    } catch (error) {
        console.error('Structured records archive error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not archive structured record' });
    }
});

router.post('/structured-records/:table/import', authenticateToken, requireAdmin, structuredUpload.single('file'), async (req, res) => {
    try {
        await documentLabService.ensureSchema();
        const config = _structuredTableConfig(req.params.table);
        if (!config) return res.status(404).json({ success: false, error: 'Unknown structured table' });
        if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Import file is required' });

        const rawRows = _parseStructuredWorkbook(req.file);
        let created = 0;
        let updated = 0;
        const errors = [];
        for (let i = 0; i < rawRows.length; i += 1) {
            const source = rawRows[i] || {};
            const normalized = {};
            for (const [key, value] of Object.entries(source)) {
                normalized[_normaliseHeader(key)] = value;
            }
            try {
                const result = await _upsertStructuredRecord(config.name, config, normalized);
                await _syncPrincipalOfficerRecord(config.name, normalized);
                if (result.mode === 'updated') updated += 1;
                else created += 1;
            } catch (error) {
                errors.push({ row: i + 2, error: error.message });
            }
        }

        await AuditTrail.log({
            userId: req.user.id,
            action: 'STRUCTURED_RECORDS_IMPORTED',
            entityType: config.name,
            details: { table: config.name, created, updated, errors: errors.length, fileName: req.file.originalname },
            ipAddress: req.ip
        });
        _invalidateStructuredLookupCache();
        res.json({
            success: true,
            message: `Imported ${created + updated} record(s) into ${config.label}`,
            created,
            updated,
            failed: errors.length,
            errors: errors.slice(0, 30)
        });
    } catch (error) {
        console.error('Structured records import error:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not import structured records' });
    }
});

module.exports = router;
