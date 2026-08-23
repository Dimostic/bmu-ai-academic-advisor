#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query, pool } = require('../../config/db');

const REQUIRED_TABLES = [
    'structured_facts',
    'academic_programmes',
    'academic_courses',
    'academic_fees',
    'academic_calendar_events',
    'academic_officers',
    'academic_rules'
];

const CRITICAL_ROLES = [
    'Vice-Chancellor',
    'Registrar',
    'Bursar',
    'University Librarian',
    'Pro-Chancellor / Chairman of Governing Council'
];

const MIN_ACTIVE_COURSES = parseInt(process.env.STRUCTURED_QUALITY_MIN_ACTIVE_COURSES || '1400', 10);
const MAX_INVALID_CODES = parseInt(process.env.STRUCTURED_QUALITY_MAX_INVALID_CODES || '25', 10);
const MAX_UNIT_CONFLICTS = parseInt(process.env.STRUCTURED_QUALITY_MAX_UNIT_CONFLICTS || '10', 10);

function normalise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
        const rows = await query(`SELECT COUNT(*) AS total FROM ${table}`);
        counts[table] = Number(rows?.[0]?.total || 0);
    }
    return counts;
}

async function main() {
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

    const programmeGapRows = await query(`
        SELECT p.programme,
               COUNT(DISTINCT c.id) AS course_count,
               COUNT(DISTINCT f.id) AS fee_count,
               COUNT(DISTINCT r.id) AS rule_count
        FROM academic_programmes p
        LEFT JOIN academic_courses c
          ON c.status = 'active' AND LOWER(c.programme) = LOWER(p.programme)
        LEFT JOIN academic_fees f
          ON f.status = 'active' AND LOWER(f.programme) = LOWER(p.programme)
        LEFT JOIN academic_rules r
          ON r.status = 'active' AND LOWER(r.programme) = LOWER(p.programme)
        WHERE p.status = 'active'
          AND COALESCE(p.programme, '') <> ''
        GROUP BY p.programme
        ORDER BY p.programme
        LIMIT 500
    `);
    const programmeGaps = programmeGapRows
        .map(row => ({
            programme: row.programme,
            courseCount: Number(row.course_count || 0),
            feeCount: Number(row.fee_count || 0),
            ruleCount: Number(row.rule_count || 0),
            gaps: [
                Number(row.course_count || 0) ? null : 'no courses',
                Number(row.fee_count || 0) ? null : 'no fees',
                Number(row.rule_count || 0) ? null : 'no requirements'
            ].filter(Boolean)
        }))
        .filter(row => row.gaps.length);

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
            totalChecked: programmeGapRows.length,
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
