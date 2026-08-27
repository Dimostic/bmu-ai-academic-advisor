#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query, pool } = require('../../config/db');
const documentLabService = require('../services/documentLabService');

const REQUIRED_TABLES = [
    'structured_facts',
    'academic_programmes',
    'academic_courses',
    'academic_fees',
    'academic_admission_cutoffs',
    'academic_registration_requirements',
    'academic_calendar_events',
    'academic_officers',
    'academic_rules',
    'bmu_recent_sources',
    'bmu_recent_facts'
];

const STATUS_TABLES = new Set([
    'structured_facts',
    'academic_programmes',
    'academic_courses',
    'academic_fees',
    'academic_admission_cutoffs',
    'academic_registration_requirements',
    'academic_calendar_events',
    'academic_officers',
    'academic_rules',
    'bmu_recent_sources',
    'bmu_recent_facts'
]);

const CRITICAL_ROLES = [
    'Vice-Chancellor',
    'Registrar',
    'Bursar',
    'University Librarian',
    'Pro-Chancellor / Chairman of Governing Council'
];

const MIN_ACTIVE_COURSES = parseInt(process.env.STRUCTURED_QUALITY_MIN_ACTIVE_COURSES || '1400', 10);
const MAX_INVALID_CODES = parseInt(process.env.STRUCTURED_QUALITY_MAX_INVALID_CODES || '0', 10);
const MAX_UNIT_CONFLICTS = parseInt(process.env.STRUCTURED_QUALITY_MAX_UNIT_CONFLICTS || '0', 10);
const SOURCE_LIMITED_PROGRAMME_STATUSES = new Set([
    'fee source only course catalogue not available',
    'fee only source',
    'source limited fee only',
    'source limited'
]);

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
    if (/\bcommunity\s+health\b/.test(text)) return 'community health sciences';
    if (/\bhealth\s+care\s+administration\b/.test(text) && /\bhospital\s+management\b/.test(text)) return 'health care administration and hospital management';
    if (/\bhuman\s+nutrition\b|\bnutrition\s+and\s+dietetics\b|\bnutrition\s+dietetics\b/.test(text)) return 'nutrition and dietetics';
    if (/\bdoctor\s+of\s+pharmacy\b|\bpharmd\b|\bpharmacy\b/.test(text)) return 'pharmacy';
    if (text === 'physics' || /\bphysics\s+with\s+electronics\b/.test(text)) return 'physics with electronics';
    if (/\bradiography\b/.test(text)) return 'radiography and radiation science';
    return text;
}

function isSourceLimitedProgrammeStatus(value) {
    return SOURCE_LIMITED_PROGRAMME_STATUSES.has(normalise(value));
}

function aggregateProgrammeCounts(rows) {
    const counts = new Map();
    const names = new Map();
    for (const row of rows || []) {
        const key = canonicalProgrammeKey(row.programme);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + Number(row.count || 0));
        if (!names.has(key)) names.set(key, new Set());
        names.get(key).add(row.programme);
    }
    return { counts, names };
}

function aggregateProgrammeIdentities(rows) {
    const byKey = new Map();
    for (const row of rows || []) {
        const key = canonicalProgrammeKey(row.programme);
        if (!key) continue;
        const status = row.programme_status || '';
        const sourcePath = row.source_path || '';
        if (!byKey.has(key)) {
            byKey.set(key, {
                programme: row.programme,
                canonicalProgramme: key,
                programmeStatus: status,
                programmeAliases: [],
                programmeStatuses: new Set(),
                sourcePaths: new Set()
            });
        }
        const item = byKey.get(key);
        if (status) item.programmeStatuses.add(status);
        if (sourcePath) item.sourcePaths.add(sourcePath);
        if (row.programme !== item.programme && !item.programmeAliases.includes(row.programme)) {
            item.programmeAliases.push(row.programme);
        }
        if (isSourceLimitedProgrammeStatus(item.programmeStatus) && !isSourceLimitedProgrammeStatus(status)) {
            const previousProgramme = item.programme;
            item.programme = row.programme;
            item.programmeStatus = status;
            item.programmeAliases = item.programmeAliases.filter(name => name !== row.programme);
            if (previousProgramme !== item.programme && !item.programmeAliases.includes(previousProgramme)) {
                item.programmeAliases.push(previousProgramme);
            }
        }
    }
    return [...byKey.values()]
        .map(item => {
            const statuses = [...item.programmeStatuses].sort();
            return {
                programme: item.programme,
                canonicalProgramme: item.canonicalProgramme,
                programmeStatus: item.programmeStatus || null,
                programmeAliases: item.programmeAliases.sort(),
                programmeStatuses: statuses,
                sourcePaths: [...item.sourcePaths].sort(),
                sourceLimited: statuses.length > 0 && statuses.every(isSourceLimitedProgrammeStatus)
            };
        })
        .sort((a, b) => a.programme.localeCompare(b.programme));
}

function roleIsPresent(rows, role) {
    const target = normalise(role);
    return rows.some(row => {
        const office = normalise(row.office);
        return office === target
            || (target.includes('vice chancellor') && !target.includes('deputy') && office.includes('vice chancellor') && !office.includes('deputy'))
            || (target.includes('bursar') && office.includes('bursar'))
            || (target.includes('registrar') && office.includes('registrar'))
            || (target.includes('librarian') && office.includes('librarian'))
            || (target.includes('pro chancellor') && (office.includes('pro chancellor') || (office.includes('chairman') && office.includes('governing council'))));
    });
}

function closePoolAndExit(code) {
    if (pool && typeof pool.end === 'function') {
        pool.end(() => process.exit(code));
        return;
    }
    process.exit(code);
}

async function tableCounts() {
    const counts = {};
    for (const table of REQUIRED_TABLES) {
        const rows = STATUS_TABLES.has(table)
            ? await query(`SELECT COUNT(*) AS total FROM ${table} WHERE status = 'active'`)
            : await query(`SELECT COUNT(*) AS total FROM ${table}`);
        counts[table] = Number(rows?.[0]?.total || 0);
    }
    return counts;
}

async function main() {
    await documentLabService.ensureSchema();
    const counts = await tableCounts();

    const officerRows = await query(`
        SELECT office, officer_name
        FROM academic_officers
        WHERE status = 'active'
    `);
    const missingOfficerRoles = CRITICAL_ROLES.filter(role => !roleIsPresent(officerRows, role));

    const invalidCourseWhere = `
        status = 'active'
        AND COALESCE(course_code, '') <> ''
        AND course_code NOT REGEXP '^(BMU-)?[A-Z]{2,4}[[:space:]]*[0-9]{3}[A-Z]?$'
    `;
    const invalidCourseCountRows = await query(`SELECT COUNT(*) AS count FROM academic_courses WHERE ${invalidCourseWhere}`);
    const invalidCourseRows = await query(`
        SELECT programme, level_label, course_code, course_title, source_path
        FROM academic_courses
        WHERE ${invalidCourseWhere}
        ORDER BY programme, level_label, course_code
        LIMIT 25
    `);

    const activeCourseCountRows = await query(`
        SELECT COUNT(*) AS count
        FROM academic_courses
        WHERE status = 'active'
    `);

    const courseCoverageRows = await query(`
        SELECT programme,
               COUNT(*) AS course_count,
               SUM(CASE WHEN level_label LIKE '%100%' THEN 1 ELSE 0 END) AS level_100,
               SUM(CASE WHEN level_label LIKE '%200%' THEN 1 ELSE 0 END) AS level_200,
               SUM(CASE WHEN level_label LIKE '%300%' THEN 1 ELSE 0 END) AS level_300,
               SUM(CASE WHEN level_label LIKE '%400%' THEN 1 ELSE 0 END) AS level_400,
               SUM(CASE WHEN level_label LIKE '%500%' THEN 1 ELSE 0 END) AS level_500,
               SUM(CASE WHEN level_label LIKE '%600%' THEN 1 ELSE 0 END) AS level_600
        FROM academic_courses
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
        GROUP BY programme
        ORDER BY programme
    `);
    const courseCoverage = courseCoverageRows.map(row => {
        const levels = ['100', '200', '300', '400', '500', '600']
            .filter(level => Number(row[`level_${level}`] || 0) > 0);
        return {
            programme: row.programme,
            courseCount: Number(row.course_count || 0),
            levels
        };
    });

    const courseUnitConflictRows = await query(`
        SELECT
            MIN(programme) AS programme,
            MIN(level_label) AS level_label,
            MIN(semester_label) AS semester_label,
            MIN(course_code) AS course_code,
            MIN(course_title) AS course_title,
            COUNT(*) AS row_count,
            COUNT(DISTINCT COALESCE(CAST(credit_units AS CHAR), '__blank__')) AS unit_variant_count,
            GROUP_CONCAT(DISTINCT COALESCE(CAST(credit_units AS CHAR), 'blank') ORDER BY credit_units SEPARATOR ', ') AS credit_units,
            GROUP_CONCAT(id ORDER BY id SEPARATOR ',') AS record_ids,
            MIN(source_path) AS source_path
        FROM academic_courses
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
          AND COALESCE(course_code, '') <> ''
          AND COALESCE(course_title, '') <> ''
        GROUP BY
            LOWER(TRIM(programme)),
            LOWER(TRIM(level_label)),
            LOWER(TRIM(semester_label)),
            LOWER(TRIM(course_code)),
            LOWER(TRIM(course_title))
        HAVING unit_variant_count > 1
        ORDER BY programme, level_label, semester_label, course_code
        LIMIT 25
    `);

    const programmeRows = await query(`
        SELECT programme, programme_status, source_path
        FROM academic_programmes
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
        ORDER BY programme
        LIMIT 500
    `);
    const courseCountRows = await query(`
        SELECT programme, COUNT(*) AS count
        FROM academic_courses
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
        GROUP BY programme
    `);
    const feeCountRows = await query(`
        SELECT programme, COUNT(*) AS count
        FROM academic_fees
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
        GROUP BY programme
    `);
    const ruleCountRows = await query(`
        SELECT programme, COUNT(*) AS count
        FROM academic_rules
        WHERE status = 'active'
          AND COALESCE(programme, '') <> ''
        GROUP BY programme
    `);
    const courseCounts = aggregateProgrammeCounts(courseCountRows);
    const feeCounts = aggregateProgrammeCounts(feeCountRows);
    const ruleCounts = aggregateProgrammeCounts(ruleCountRows);
    const programmeIdentities = aggregateProgrammeIdentities(programmeRows);
    const programmeGapRows = programmeIdentities.map(row => {
        const key = row.canonicalProgramme;
        const linkedNames = new Set([
            ...(courseCounts.names.get(key) || []),
            ...(feeCounts.names.get(key) || []),
            ...(ruleCounts.names.get(key) || [])
        ]);
        return {
            programme: row.programme,
            canonicalProgramme: key,
            programmeStatus: row.programmeStatus,
            programmeAliases: row.programmeAliases,
            programmeStatuses: row.programmeStatuses,
            sourcePaths: row.sourcePaths,
            sourceLimited: row.sourceLimited,
            linkedProgrammeNames: [...linkedNames]
                .filter(name => name !== row.programme && !row.programmeAliases.includes(name))
                .sort(),
            course_count: courseCounts.counts.get(key) || 0,
            fee_count: feeCounts.counts.get(key) || 0,
            rule_count: ruleCounts.counts.get(key) || 0
        };
    });
    const programmeGaps = programmeGapRows
        .map(row => ({
            programme: row.programme,
            canonicalProgramme: row.canonicalProgramme,
            programmeStatus: row.programmeStatus,
            programmeAliases: row.programmeAliases,
            programmeStatuses: row.programmeStatuses,
            sourcePaths: row.sourcePaths,
            sourceLimited: row.sourceLimited,
            linkedProgrammeNames: row.linkedProgrammeNames,
            courseCount: Number(row.course_count || 0),
            feeCount: Number(row.fee_count || 0),
            ruleCount: Number(row.rule_count || 0),
            gaps: [
                Number(row.course_count || 0) ? null : 'no courses',
                Number(row.fee_count || 0) ? null : 'no fees',
                Number(row.rule_count || 0) ? null : 'no requirements'
            ].filter(Boolean)
        }))
        .filter(row => row.gaps.length && !row.sourceLimited);

    const ruleRows = await query(`
        SELECT requirement_category, COUNT(*) AS count
        FROM academic_rules
        WHERE status = 'active'
        GROUP BY requirement_category
        ORDER BY count DESC
    `);

    const activeCourseCount = Number(activeCourseCountRows?.[0]?.count || 0);
    const invalidCodeCount = Number(invalidCourseCountRows?.[0]?.count || 0);
    const unitConflictCount = courseUnitConflictRows.length;
    const failures = [];
    const warnings = [];

    if (activeCourseCount < MIN_ACTIVE_COURSES) {
        failures.push(`Active academic_courses dropped below ${MIN_ACTIVE_COURSES}: ${activeCourseCount}`);
    }
    if (missingOfficerRoles.length) {
        failures.push(`Missing active critical officer role(s): ${missingOfficerRoles.join(', ')}`);
    }
    if (invalidCodeCount > MAX_INVALID_CODES) {
        failures.push(`Invalid active course-code count exceeded ${MAX_INVALID_CODES}: ${invalidCodeCount}`);
    } else if (invalidCodeCount) {
        warnings.push(`${invalidCodeCount} active course row(s) still have non-standard course codes.`);
    }
    if (unitConflictCount > MAX_UNIT_CONFLICTS) {
        failures.push(`Course unit conflict count exceeded ${MAX_UNIT_CONFLICTS}: ${unitConflictCount}`);
    } else if (unitConflictCount) {
        warnings.push(`${unitConflictCount} course signature(s) have conflicting credit units and need admin review.`);
    }
    if (programmeGaps.length) {
        warnings.push(`${programmeGaps.length} programme(s) are missing linked courses, fees, or requirements.`);
    }

    console.log(JSON.stringify({
        ok: failures.length === 0,
        checked: 'structured records quality SQL',
        thresholds: {
            minActiveCourses: MIN_ACTIVE_COURSES,
            maxInvalidCodes: MAX_INVALID_CODES,
            maxUnitConflicts: MAX_UNIT_CONFLICTS
        },
        tableCounts: counts,
        officers: {
            totalActive: officerRows.length,
            missingCriticalRoles: missingOfficerRoles
        },
        courses: {
            activeCount: activeCourseCount,
            programmeCount: courseCoverage.length,
            invalidCodeCount,
            invalidCodeSamples: invalidCourseRows,
            unitConflictCount,
            unitConflictSamples: courseUnitConflictRows,
            coverageSamples: courseCoverage.slice(0, 30)
        },
        programmes: {
            totalChecked: programmeIdentities.length,
            sourceLimitedCount: programmeIdentities.filter(row => row.sourceLimited).length,
            sourceLimitedSamples: programmeIdentities.filter(row => row.sourceLimited).slice(0, 10),
            gapCount: programmeGaps.length,
            gapSamples: programmeGaps.slice(0, 25)
        },
        rules: {
            categories: ruleRows.map(row => ({
                category: row.requirement_category || 'uncategorised',
                count: Number(row.count || 0)
            }))
        },
        warnings,
        failures
    }, null, 2));

    closePoolAndExit(failures.length ? 1 : 0);
}

main().catch(error => {
    console.error(error.message || error);
    closePoolAndExit(1);
});
