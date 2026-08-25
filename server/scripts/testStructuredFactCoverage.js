#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query, pool } = require('../../config/db');

const REQUIRED_OFFICERS = [
    {
        name: 'vice-chancellor',
        officePatterns: ['vice chancellor', 'vice-chancellor'],
        nameFragments: ['dimie', 'ogoina']
    },
    {
        name: 'bursar',
        officePatterns: ['bursar'],
        nameFragments: ['ebipuado', 'ombu']
    },
    {
        name: 'registrar',
        officePatterns: ['registrar'],
        nameFragments: ['felicia', 'akusu']
    },
    {
        name: 'pro-chancellor / governing council chairman',
        officePatterns: ['pro chancellor', 'pro-chancellor', 'governing council'],
        nameFragments: ['tarila', 'tebepah']
    },
    {
        name: 'university librarian',
        officePatterns: ['librarian'],
        nameFragments: ['abraham', 'etebu']
    }
];

const REQUIRED_FEES = [
    {
        name: '100 level MBBS non-indigene',
        programmePatterns: ['medicine', 'mbbs'],
        categoryPatterns: ['non-indigene', 'non indigene'],
        textPatterns: ['100'],
        amountFragments: ['1,230,000', '1230000']
    },
    {
        name: '100 level Community Health non-indigene',
        programmePatterns: ['community health'],
        categoryPatterns: ['non-indigene', 'non indigene'],
        textPatterns: ['100'],
        amountFragments: ['415,000', '415000']
    },
    {
        name: '300 level Community Health indigene',
        programmePatterns: ['community health'],
        categoryPatterns: ['indigene'],
        textPatterns: ['300'],
        amountFragments: ['455,000', '455000']
    },
    {
        name: '200 Direct Entry Nursing non-indigene',
        programmePatterns: ['nursing'],
        categoryPatterns: ['non-indigene', 'non indigene'],
        textPatterns: ['200', 'direct entry'],
        amountFragments: ['950,000', '950000']
    }
];

const REQUIRED_ADMISSION_CUTOFFS = [
    {
        name: '2026/2027 MBBS cutoff',
        programmePatterns: ['medicine', 'mbbs'],
        cyclePatterns: ['2026/2027'],
        amountFragments: ['279']
    },
    {
        name: '2026/2027 Pharmacy cutoff',
        programmePatterns: ['pharmacy'],
        cyclePatterns: ['2026/2027'],
        amountFragments: ['238']
    },
    {
        name: '2026/2027 Nursing cutoff',
        programmePatterns: ['nursing'],
        cyclePatterns: ['2026/2027'],
        amountFragments: ['234']
    },
    {
        name: '2026/2027 other programmes cutoff',
        programmePatterns: ['other'],
        cyclePatterns: ['2026/2027'],
        amountFragments: ['150']
    }
];

const REQUIRED_REGISTRATION_REQUIREMENTS = [
    {
        name: 'new student online application flow',
        categoryPatterns: ['applicant', 'new student'],
        typePatterns: ['online application'],
        textPatterns: ['create an account', 'verify', 'upload', 'application fee']
    },
    {
        name: 'new student admission eligibility',
        categoryPatterns: ['new student'],
        typePatterns: ['admission eligibility'],
        textPatterns: ['150', '16', 'o level', 'english language', 'biology', 'chemistry', 'physics', 'mathematics']
    }
];

function normalise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/₦/g, 'n')
        .replace(/[^a-z0-9,]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function containsAny(haystack, fragments) {
    return fragments.some(fragment => haystack.includes(normalise(fragment)));
}

function containsAll(haystack, fragments) {
    return fragments.every(fragment => haystack.includes(normalise(fragment)));
}

async function checkOfficers() {
    const rows = await query(`
        SELECT office, officer_name, source_path, scope_label
        FROM academic_officers
        WHERE status = 'active'
    `);
    return REQUIRED_OFFICERS.map(required => {
        const match = rows.find(row => {
            const office = normalise(row.office);
            const name = normalise(row.officer_name);
            return containsAny(office, required.officePatterns)
                && containsAll(name, required.nameFragments);
        });
        return {
            name: required.name,
            ok: Boolean(match),
            matched: match ? `${match.office}: ${match.officer_name}` : null
        };
    });
}

async function checkFees() {
    const rows = await query(`
        SELECT programme, fee_category, amount_label, amount_value, student_category, raw_text, row_json, source_path
        FROM academic_fees
        WHERE status = 'active'
    `);
    return REQUIRED_FEES.map(required => {
        const match = rows.find(row => {
            const programme = normalise(row.programme);
            const category = normalise(`${row.student_category || ''} ${row.fee_category || ''} ${row.raw_text || ''} ${row.row_json || ''}`);
            const text = normalise(`${row.programme || ''} ${row.fee_category || ''} ${row.student_category || ''} ${row.raw_text || ''} ${row.row_json || ''}`);
            const amount = normalise(`${row.amount_label || ''} ${row.amount_value || ''}`);
            return containsAny(programme, required.programmePatterns)
                && containsAny(category, required.categoryPatterns)
                && containsAll(text, required.textPatterns)
                && containsAny(amount, required.amountFragments);
        });
        return {
            name: required.name,
            ok: Boolean(match),
            matched: match ? `${match.programme}: ${match.student_category || match.fee_category} ${match.amount_label || match.amount_value}` : null
        };
    });
}

async function checkAdmissionCutoffs() {
    const rows = await query(`
        SELECT programme, admission_cycle, merit_cutoff, cutoff_label, eligibility_text, application_process, source_path
        FROM academic_admission_cutoffs
        WHERE status = 'active'
    `);
    return REQUIRED_ADMISSION_CUTOFFS.map(required => {
        const match = rows.find(row => {
            const programme = normalise(row.programme);
            const cycle = normalise(row.admission_cycle);
            const amount = normalise(`${row.merit_cutoff || ''} ${row.cutoff_label || ''}`);
            return containsAny(programme, required.programmePatterns)
                && containsAny(cycle, required.cyclePatterns)
                && containsAny(amount, required.amountFragments);
        });
        return {
            name: required.name,
            ok: Boolean(match),
            matched: match ? `${match.programme}: ${match.admission_cycle} ${match.cutoff_label || match.merit_cutoff}` : null
        };
    });
}

async function checkRegistrationRequirements() {
    const rows = await query(`
        SELECT student_category, requirement_type, requirement_text, portal_url, source_path
        FROM academic_registration_requirements
        WHERE status = 'active'
    `);
    return REQUIRED_REGISTRATION_REQUIREMENTS.map(required => {
        const match = rows.find(row => {
            const category = normalise(row.student_category);
            const type = normalise(row.requirement_type);
            const text = normalise(`${row.requirement_text || ''} ${row.portal_url || ''}`);
            return containsAny(category, required.categoryPatterns)
                && containsAny(type, required.typePatterns)
                && containsAll(text, required.textPatterns);
        });
        return {
            name: required.name,
            ok: Boolean(match),
            matched: match ? `${match.student_category}: ${match.requirement_type}` : null
        };
    });
}

async function main() {
    const [officers, fees, admissionCutoffs, registrationRequirements] = await Promise.all([
        checkOfficers(),
        checkFees(),
        checkAdmissionCutoffs(),
        checkRegistrationRequirements()
    ]);
    const results = { officers, fees, admissionCutoffs, registrationRequirements };
    const failed = [...officers, ...fees, ...admissionCutoffs, ...registrationRequirements].filter(item => !item.ok);

    console.log(JSON.stringify({
        ok: failed.length === 0,
        checked: officers.length + fees.length + admissionCutoffs.length + registrationRequirements.length,
        failed: failed.length,
        results
    }, null, 2));

    if (pool && typeof pool.end === 'function') {
        pool.end(() => process.exit(failed.length ? 1 : 0));
    } else {
        process.exit(failed.length ? 1 : 0);
    }
}

main().catch(error => {
    console.error(error.message || error);
    if (pool && typeof pool.end === 'function') {
        pool.end(() => process.exit(1));
    } else {
        process.exit(1);
    }
});
