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
    console.log(JSON.stringify({ ok: true, admissionCycle: CYCLE, cutoffs, registration }, null, 2));
    pool.end(() => process.exit(0));
}

main().catch(error => {
    console.error(error.message || error);
    if (pool) pool.end(() => process.exit(1));
    else process.exit(1);
});
