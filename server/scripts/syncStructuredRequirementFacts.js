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
        const programme = String(value.programme || value.program || '').trim() || null;
        const rowJson = JSON.stringify({
            ...value,
            rule_type: ruleType,
            requirement_category: category,
            subject,
            programme,
            requirement_text: requirementText
        });
        const recordHash = hash(`academic_rules|structured_fact|${row.id}`);

        await query(`
            INSERT INTO academic_rules
                (record_hash, source_fact_id, rule_type, requirement_category, subject, programme,
                 entry_mode, level_label, semester_label, requirement_text, minimum_value,
                 authority_type, scope_label, currentness_label, source_path, raw_text, row_json, status)
            VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
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
