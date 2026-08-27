#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const crypto = require('crypto');
const documentLabService = require('../services/documentLabService');
const { query, pool } = require('../../config/db');

const SOURCE_NOTICE = 'BMU 2026/2027 Admissions Cutoff Marks and Application Details';
const ADMISSIONS_PAGE = 'https://bmu.edu.ng/admissions/';
const APPLICATION_PORTAL = 'https://bmu.edu.ng/accounts/login/?next=/admissions/apply/?program=6';
const CYCLE = '2026/2027';

const eligibilityText = "UTME minimum score of 150 in the 2026 UTME; applicant must be 16 years and above; at least five O'Level credits in SSCE or equivalent, including English Language, Biology, Chemistry, Physics, and Mathematics.";
const applicationProcess = 'Create an account; verify the account; log in; search for the programme of choice; click apply; fill the application form; upload required documents; update the application; pay the application fee.';
const contactText = 'Admissions inquiries: +234-703-451-9975. Admissions Officer: Mr. Jones Igene.';

const cutoffRows = [
    ['Medicine and Surgery (MBBS)', 279],
    ['Pharmacy (Pharm.D)', 238],
    ['Nursing Science (B.NSc)', 234],
    ['Medical Laboratory Sciences (BMLS)', 223],
    ['Optometry (O.D)', 203],
    ['Radiography & Radiation Sciences', 228],
    ['Physiotherapy', 205],
    ['Community / Public Health', 170],
    ['Other Programs', 150]
];

const registrationRows = [
    {
        student_category: 'applicant / new student',
        requirement_type: 'online_application',
        requirement_text: applicationProcess,
        portal_url: APPLICATION_PORTAL,
        source_path: `${ADMISSIONS_PAGE} / ${SOURCE_NOTICE}`
    },
    {
        student_category: 'new student',
        requirement_type: 'admission_eligibility',
        requirement_text: eligibilityText,
        portal_url: ADMISSIONS_PAGE,
        source_path: SOURCE_NOTICE
    }
];

function hash(parts) {
    return crypto.createHash('sha1').update(parts.map(value => String(value ?? '')).join('|')).digest('hex');
}

function normalise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function canonicalProgrammeKey(value) {
    const text = normalise(value)
        .replace(/\bbachelor\s+of\b/g, '')
        .replace(/\bbsc\b/g, '')
        .replace(/\bb\s*sc\b/g, '')
        .replace(/\bbachelor\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '';
    if (/\bmbbs\b|\bmedicine\s+and\s+surgery\b|\bmedicine\s+surgery\b/.test(text)) return 'medicine and surgery';
    if (/\bdentistry\b|\bbds\b|\bdental\s+surgery\b/.test(text)) return 'dentistry';
    if (/\bnursing\b|\bbnsc\b/.test(text)) return 'nursing science';
    if (/\bmedical\s+laborator(?:y|ies)\s+science\b|\bbmls\b/.test(text)) return 'medical laboratory science';
    if (/\bdoctor\s+of\s+pharmacy\b|\bpharmd\b|\bpharm\s*d\b|\bpharmacy\b/.test(text)) return 'pharmacy';
    if (/\bcommunity\s+health\b/.test(text)) return 'community health sciences';
    if (/\bpublic\s+health\b/.test(text)) return 'public health';
    if (/\bradiography\b/.test(text)) return 'radiography and radiation science';
    if (/\bphysiotherapy\b/.test(text)) return 'physiotherapy';
    if (/\boptometry\b/.test(text)) return 'optometry';
    if (text === 'physics' || /\bphysics\s+with\s+electronics\b/.test(text)) return 'physics with electronics';
    if (/\bhuman\s+nutrition\b|\bnutrition\s+and\s+dietetics\b|\bnutrition\s+dietetics\b/.test(text)) return 'nutrition and dietetics';
    if (/\bhealth\s+care\s+administration\b/.test(text) && /\bhospital\s+management\b/.test(text)) return 'health care administration and hospital management';
    return text;
}

const SOURCE_LIMITED_PROGRAMME_STATUSES = new Set([
    'fee source only course catalogue not available',
    'fee only source',
    'source limited fee only',
    'source limited'
]);

const SPECIFIC_CUTOFF_TARGETS = new Map([
    ['Medicine and Surgery (MBBS)', ['medicine and surgery']],
    ['Pharmacy (Pharm.D)', ['pharmacy']],
    ['Nursing Science (B.NSc)', ['nursing science']],
    ['Medical Laboratory Sciences (BMLS)', ['medical laboratory science']],
    ['Optometry (O.D)', ['optometry']],
    ['Radiography & Radiation Sciences', ['radiography and radiation science']],
    ['Physiotherapy', ['physiotherapy']],
    ['Community / Public Health', ['community health sciences', 'public health']]
]);

function isSourceLimitedProgramme(row) {
    return SOURCE_LIMITED_PROGRAMME_STATUSES.has(normalise(row.programme_status));
}

async function seedCutoffs() {
    let count = 0;
    for (const [programme, cutoff] of cutoffRows) {
        const rawText = `${programme}: ${CYCLE} admission merit cutoff mark is ${cutoff}. ${eligibilityText} Application process: ${applicationProcess}`;
        const payload = {
            programme,
            admission_cycle: CYCLE,
            entry_mode: 'UTME',
            merit_cutoff: cutoff,
            cutoff_label: `Merit - ${cutoff}`,
            eligibility_text: eligibilityText,
            application_process: applicationProcess,
            contact_text: contactText,
            source_path: SOURCE_NOTICE
        };
        const recordHash = hash(['academic_admission_cutoffs', programme, CYCLE, cutoff, SOURCE_NOTICE]);
        await query(
            `INSERT INTO academic_admission_cutoffs
                (record_hash, programme, admission_cycle, entry_mode, merit_cutoff, cutoff_label,
                 eligibility_text, application_process, contact_text, authority_type, scope_label,
                 currentness_label, source_path, raw_text, row_json, status)
             VALUES
                (?, ?, ?, 'UTME', ?, ?, ?, ?, ?, 'institution', 'BMU admissions',
                 'current', ?, ?, ?, 'active')
             ON DUPLICATE KEY UPDATE
                merit_cutoff = VALUES(merit_cutoff),
                cutoff_label = VALUES(cutoff_label),
                eligibility_text = VALUES(eligibility_text),
                application_process = VALUES(application_process),
                contact_text = VALUES(contact_text),
                authority_type = VALUES(authority_type),
                scope_label = VALUES(scope_label),
                currentness_label = VALUES(currentness_label),
                source_path = VALUES(source_path),
                raw_text = VALUES(raw_text),
                row_json = VALUES(row_json),
                status = 'active',
                updated_at = NOW()`,
            [recordHash, programme, CYCLE, cutoff, `Merit - ${cutoff}`, eligibilityText, applicationProcess, contactText, SOURCE_NOTICE, rawText, JSON.stringify(payload)]
        );
        count += 1;
    }
    return count;
}

function aggregateRuleCounts(rows) {
    const counts = new Map();
    for (const row of rows || []) {
        const key = canonicalProgrammeKey(row.programme);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + Number(row.count || 0));
    }
    return counts;
}

function buildProgrammeMap(rows) {
    const map = new Map();
    for (const row of rows || []) {
        if (isSourceLimitedProgramme(row)) continue;
        const key = canonicalProgrammeKey(row.programme);
        if (!key || map.has(key)) continue;
        map.set(key, {
            programme: row.programme,
            programme_status: row.programme_status || null
        });
    }
    return map;
}

async function upsertAcademicAdmissionRule({ programme, sourceProgramme, cutoff, isGeneric = false }) {
    const sourcePath = `${ADMISSIONS_PAGE} / ${SOURCE_NOTICE}`;
    const subject = `${CYCLE} admission cutoff and eligibility`;
    const scopeLabel = isGeneric
        ? 'BMU admissions - Other Programs cutoff'
        : 'BMU admissions - programme cutoff';
    const requirementText = isGeneric
        ? `${programme} is covered by the BMU ${CYCLE} admissions notice under Other Programs with merit cutoff mark ${cutoff}. ${eligibilityText} Programme-specific subject combinations should be confirmed from BMU admissions where the notice does not state a separate programme rule. Application process: ${applicationProcess}`
        : `${programme} is covered by the BMU ${CYCLE} admissions notice entry "${sourceProgramme}" with merit cutoff mark ${cutoff}. ${eligibilityText} Application process: ${applicationProcess}`;
    const payload = {
        programme,
        source_programme: sourceProgramme,
        admission_cycle: CYCLE,
        entry_mode: 'UTME',
        merit_cutoff: cutoff,
        cutoff_label: `Merit - ${cutoff}`,
        eligibility_text: eligibilityText,
        application_process: applicationProcess,
        contact_text: contactText,
        source_path: sourcePath,
        source_note: isGeneric ? 'Applied from the admissions notice Other Programs category.' : 'Applied from a programme-specific admissions notice row.'
    };
    const recordHash = hash(['academic_rules', 'admission_cycle', programme, CYCLE, cutoff, sourceProgramme, SOURCE_NOTICE]);

    await query(
        `INSERT INTO academic_rules
            (record_hash, rule_type, requirement_category, subject, programme,
             entry_mode, requirement_text, minimum_value, required_subjects,
             minimum_grades, special_conditions, authority_type, scope_label,
             currentness_label, source_path, raw_text, row_json, status)
         VALUES
            (?, 'admission_requirement', 'admission', ?, ?, 'UTME', ?, ?, ?,
             ?, ?, 'institution', ?, 'current', ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
            rule_type = VALUES(rule_type),
            requirement_category = VALUES(requirement_category),
            subject = VALUES(subject),
            programme = VALUES(programme),
            entry_mode = VALUES(entry_mode),
            requirement_text = VALUES(requirement_text),
            minimum_value = VALUES(minimum_value),
            required_subjects = VALUES(required_subjects),
            minimum_grades = VALUES(minimum_grades),
            special_conditions = VALUES(special_conditions),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            currentness_label = VALUES(currentness_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active',
            updated_at = NOW()`,
        [
            recordHash,
            subject,
            programme,
            requirementText,
            `Merit cutoff mark: ${cutoff}`,
            'English Language, Biology, Chemistry, Physics, and Mathematics',
            "At least five O'Level credits in SSCE or equivalent",
            isGeneric
                ? 'Applicant must be 16 years and above. This is the admissions notice general Other Programs rule; confirm any programme-specific subjects with BMU admissions where needed.'
                : 'Applicant must be 16 years and above.',
            scopeLabel,
            sourcePath,
            requirementText,
            JSON.stringify(payload)
        ]
    );
}

async function seedAdmissionRules() {
    const programmeRows = await query(`
        SELECT programme, programme_status
        FROM academic_programmes
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
    `);
    const ruleRows = await query(`
        SELECT programme, COUNT(*) AS count
        FROM academic_rules
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
        GROUP BY programme
    `);
    const programmeMap = buildProgrammeMap(programmeRows);
    const ruleCounts = aggregateRuleCounts(ruleRows);
    const specificKeys = new Set();
    let count = 0;

    for (const [sourceProgramme, cutoff] of cutoffRows) {
        if (sourceProgramme === 'Other Programs') continue;
        const targets = SPECIFIC_CUTOFF_TARGETS.get(sourceProgramme) || [canonicalProgrammeKey(sourceProgramme)];
        for (const targetKey of targets) {
            if (!targetKey) continue;
            specificKeys.add(targetKey);
            const target = programmeMap.get(targetKey);
            if (!target) continue;
            await upsertAcademicAdmissionRule({
                programme: target.programme,
                sourceProgramme,
                cutoff
            });
            count += 1;
        }
    }

    const genericCutoff = cutoffRows.find(([programme]) => programme === 'Other Programs')?.[1];
    if (genericCutoff) {
        for (const [targetKey, target] of programmeMap.entries()) {
            if (specificKeys.has(targetKey)) continue;
            if (Number(ruleCounts.get(targetKey) || 0) > 0) continue;
            await upsertAcademicAdmissionRule({
                programme: target.programme,
                sourceProgramme: 'Other Programs',
                cutoff: genericCutoff,
                isGeneric: true
            });
            count += 1;
        }
    }

    return count;
}

async function seedRegistration() {
    let count = 0;
    for (const row of registrationRows) {
        const payload = {
            ...row,
            session_label: CYCLE,
            currentness_label: 'current'
        };
        const rawText = `${row.student_category}: ${row.requirement_type}. ${row.requirement_text}`;
        const recordHash = hash(['academic_registration_requirements', row.student_category, CYCLE, row.requirement_type, row.requirement_text, row.source_path]);
        await query(
            `INSERT INTO academic_registration_requirements
                (record_hash, student_category, programme, level_label, semester_label, session_label,
                 requirement_type, requirement_text, deadline_label, portal_url, authority_type,
                 scope_label, currentness_label, source_path, raw_text, row_json, status)
             VALUES
                (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, 'institution',
                 'BMU registration/admissions process', 'current', ?, ?, ?, 'active')
             ON DUPLICATE KEY UPDATE
                requirement_text = VALUES(requirement_text),
                portal_url = VALUES(portal_url),
                authority_type = VALUES(authority_type),
                scope_label = VALUES(scope_label),
                currentness_label = VALUES(currentness_label),
                source_path = VALUES(source_path),
                raw_text = VALUES(raw_text),
                row_json = VALUES(row_json),
                status = 'active',
                updated_at = NOW()`,
            [recordHash, row.student_category, CYCLE, row.requirement_type, row.requirement_text, row.portal_url, row.source_path, rawText, JSON.stringify(payload)]
        );
        count += 1;
    }
    return count;
}

async function main() {
    await documentLabService.ensureSchema();
    const cutoffs = await seedCutoffs();
    const registration = await seedRegistration();
    const admissionRules = await seedAdmissionRules();
    console.log(JSON.stringify({ ok: true, admissionCycle: CYCLE, cutoffs, registration, admissionRules }, null, 2));
    pool.end(() => process.exit(0));
}

main().catch(error => {
    console.error(error.message || error);
    if (pool) pool.end(() => process.exit(1));
    else process.exit(1);
});
