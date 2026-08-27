const crypto = require('crypto');
const { query, pool } = require('../../config/db');
const documentLabService = require('../services/documentLabService');

function hash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function parseJson(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function normalise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function categoryFromText(text, fallback = '') {
    const value = `${fallback || ''} ${text || ''}`.toLowerCase();
    if (/\b(admission|entry requirement|eligibility|utme|direct entry|o'?level|waec|neco|jamb)\b/.test(value)) return 'admission';
    if (/\b(graduation|graduate|minimum credit|credit units|project|research)\b/.test(value)) return 'graduation';
    if (/\b(progression|probation|withdrawal|carry over|cgpa|gpa)\b/.test(value)) return 'progression';
    if (/\b(exam|examination|pass mark|grade|professional examination)\b/.test(value)) return 'examination';
    if (/\b(course registration|registration)\b/.test(value)) return 'course_registration';
    if (/\b(transfer|readmission|re-admission)\b/.test(value)) return 'transfer';
    if (/\b(accreditation|mdcn|nuc|professional body|regulation)\b/.test(value)) return 'regulation';
    return fallback || 'general';
}

function ruleTypeFromCategory(category) {
    const map = {
        admission: 'admission_requirement',
        graduation: 'graduation_requirement',
        progression: 'progression_rule',
        examination: 'examination_rule',
        course_registration: 'course_registration_rule',
        transfer: 'transfer_rule',
        regulation: 'professional_requirement'
    };
    return map[String(category || '').toLowerCase()] || 'programme_requirement';
}

const DETAIL_FIELDS = [
    'required_subjects',
    'minimum_grades',
    'olevel_sittings_rule',
    'jamb_subjects',
    'post_utme_rule',
    'special_conditions',
    'minimum_credit_units',
    'required_courses',
    'elective_requirements',
    'cgpa_requirement',
    'clinical_posting_requirement',
    'project_requirement',
    'professional_exam_requirement',
    'duration_limits',
    'approval_condition'
];

const KNOWN_PROGRAMME_KEYS = [
    'medicine and surgery',
    'dentistry',
    'nursing science',
    'medical laboratory science',
    'pharmacy',
    'doctor of pharmacy',
    'physiotherapy',
    'radiography and radiation science',
    'radiography and radiation sciences',
    'optometry',
    'community health',
    'community health sciences',
    'public health',
    'health information management',
    'health care administration and hospital management',
    'nutrition and dietetics',
    'human nutrition and dietetics',
    'dental technology',
    'human anatomy',
    'human physiology',
    'biochemistry',
    'biology',
    'chemistry',
    'computer science',
    'mathematics',
    'microbiology',
    'physics with electronics',
    'physics'
];

function programmeFromFact(row, value, subject) {
    const explicit = String(value.programme || value.program || '').trim();
    if (explicit) return explicit;
    const subjectText = String(subject || row.subject || '').trim();
    if (!subjectText) return null;
    const key = normalise(subjectText);
    if (KNOWN_PROGRAMME_KEYS.some(item => key === item || key.includes(item))) return subjectText;
    return null;
}

async function main() {
    await documentLabService.ensureSchema();
    const rows = await query(`
        SELECT *
        FROM structured_facts
        WHERE status = 'active'
          AND (
            fact_type REGEXP 'requirement|admission|graduation|progression|examination|transfer|regulation'
            OR predicate_name REGEXP 'requirement|rule'
            OR subject REGEXP 'requirement|admission|graduation|progression|examination|transfer|regulation'
            OR human_text REGEXP 'requirement|admission|graduation|progression|examination|transfer|regulation'
          )
        ORDER BY id ASC
    `);

    let synced = 0;
    for (const row of rows) {
        const value = parseJson(row.value_json);
        const haystack = `${row.fact_type || ''} ${row.predicate_name || ''} ${row.subject || ''} ${row.human_text || ''}`;
        const category = categoryFromText(haystack, value.requirement_category || '');
        const ruleType = value.rule_type || ruleTypeFromCategory(category);
        const requirementText = String(value.requirement_text || row.human_text || '').trim();
        if (!requirementText) continue;

        const subject = String(row.subject || value.subject || category || 'Programme requirement').trim();
        const programme = programmeFromFact(row, value, subject);
        const rowJson = JSON.stringify({
            ...value,
            rule_type: ruleType,
            requirement_category: category,
            subject,
            programme,
            requirement_text: requirementText,
            ...Object.fromEntries(DETAIL_FIELDS.map(field => [field, value[field] || null]))
        });
        const recordHash = hash(`academic_rules|structured_fact|${row.id}`);

        await query(`
            INSERT INTO academic_rules
                 (record_hash, source_fact_id, rule_type, requirement_category, subject, programme,
                 entry_mode, level_label, semester_label, requirement_text, minimum_value,
                 required_subjects, minimum_grades, olevel_sittings_rule, jamb_subjects,
                 post_utme_rule, special_conditions, minimum_credit_units, required_courses,
                 elective_requirements, cgpa_requirement, clinical_posting_requirement,
                 project_requirement, professional_exam_requirement, duration_limits,
                 approval_condition,
                 authority_type, scope_label, currentness_label, source_path, raw_text, row_json, status)
            VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
            ON DUPLICATE KEY UPDATE
                rule_type = VALUES(rule_type),
                requirement_category = VALUES(requirement_category),
                subject = VALUES(subject),
                programme = VALUES(programme),
                entry_mode = VALUES(entry_mode),
                level_label = VALUES(level_label),
                semester_label = VALUES(semester_label),
                requirement_text = VALUES(requirement_text),
                minimum_value = VALUES(minimum_value),
                required_subjects = VALUES(required_subjects),
                minimum_grades = VALUES(minimum_grades),
                olevel_sittings_rule = VALUES(olevel_sittings_rule),
                jamb_subjects = VALUES(jamb_subjects),
                post_utme_rule = VALUES(post_utme_rule),
                special_conditions = VALUES(special_conditions),
                minimum_credit_units = VALUES(minimum_credit_units),
                required_courses = VALUES(required_courses),
                elective_requirements = VALUES(elective_requirements),
                cgpa_requirement = VALUES(cgpa_requirement),
                clinical_posting_requirement = VALUES(clinical_posting_requirement),
                project_requirement = VALUES(project_requirement),
                professional_exam_requirement = VALUES(professional_exam_requirement),
                duration_limits = VALUES(duration_limits),
                approval_condition = VALUES(approval_condition),
                authority_type = VALUES(authority_type),
                scope_label = VALUES(scope_label),
                currentness_label = VALUES(currentness_label),
                source_path = VALUES(source_path),
                raw_text = VALUES(raw_text),
                row_json = VALUES(row_json),
                status = 'active',
                updated_at = NOW()
        `, [
            recordHash,
            row.id,
            ruleType,
            category,
            subject,
            programme,
            value.entry_mode || null,
            value.level_label || null,
            value.semester_label || null,
            requirementText,
            value.minimum_value || null,
            ...DETAIL_FIELDS.map(field => value[field] || null),
            row.authority_type || value.authority_type || null,
            row.scope_label || value.scope_label || null,
            row.currentness_label || value.currentness_label || 'current',
            row.source_path || value.source_path || null,
            requirementText,
            rowJson
        ]);
        synced++;
    }

    console.log(JSON.stringify({ ok: true, scanned: rows.length, synced }, null, 2));
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        try {
            pool.end(() => process.exit(process.exitCode || 0));
        } catch (_) {
            process.exit(process.exitCode || 0);
        }
    });
