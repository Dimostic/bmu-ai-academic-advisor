#!/usr/bin/env node

const courseCatalogService = require('../services/courseCatalogService');

let pool = null;
try { ({ pool } = require('../../config/db')); }
catch (_) { pool = null; }

const MIN_EXPECTED_ROWS = parseInt(process.env.COURSE_DQ_MIN_ROWS || '1400', 10);
const MAX_KNOWN_INVALID_CODES = parseInt(process.env.COURSE_DQ_MAX_INVALID_CODES || '3', 10);

const KNOWN_INVALID_CODE_SIGNATURES = new Set([
    'CHEMISTRY|400|FIRST|BMU-CSC 411 / 309|Artificial Intelligence in Chemistry',
    'HUMAN ANATOMY|400|SECOND|BMU-ANA|Human Morphology and Forensic',
    'PUBLIC HEALTH|300|FIRST|BMU-309|Biostatistics II (Data Analysis)'
]);

const EXPECTED_LEVEL_COVERAGE = {
    'MEDICINE AND SURGERY': ['100', '200', '300', '400', '500', '600'],
    'MEDICAL LABORATORY SCIENCE': ['100', '200', '300', '400', '500'],
    'NURSING SCIENCE': ['200', '300', '400', '500'],
    'COMMUNITY HEALTH SCIENCES': ['200', '300', '400', '500'],
    'PUBLIC HEALTH': ['200', '300', '400'],
    'PHARMACY': ['100'],
    'DOCTOR OF PHARMACY': ['200'],
    'OPTOMETRY': ['200', '300', '400', '500', '600'],
    'PHYSIOTHERAPY': ['200', '300', '400', '500', '600'],
    'RADIOGRAPHY & RADIATION SCIENCE': ['200', '300', '400', '500'],
    'HEALTH INFORMATION MANAGEMENT': ['200', '300', '400', '500'],
    'DENTAL TECHNOLOGY': ['200', '300', '400', '500'],
    'NUTRITION & DIETETICS': ['200', '300', '400', '500'],
    'BIOCHEMISTRY': ['200', '300', '400'],
    'BIOLOGY': ['200', '300', '400'],
    'CHEMISTRY': ['200', '300', '400'],
    'COMPUTER SCIENCE': ['200', '300', '400'],
    'HUMAN ANATOMY': ['200', '300', '400'],
    'HUMAN PHYSIOLOGY': ['200', '300', '400'],
    'MATHEMATICS': ['200', '300', '400'],
    'MICROBIOLOGY': ['200', '300', '400'],
    'PHYSICS WITH ELECTRONICS': ['200', '300', '400']
};

function closePoolAndExit(code) {
    if (!pool || typeof pool.end !== 'function') {
        process.exit(code);
        return;
    }
    pool.end(() => process.exit(code));
}

function isCleanCourseCode(value) {
    return /^(?:BMU-)?[A-Z]{2,4}\s*\d{3}[A-Z]?$/i.test(String(value || '').trim());
}

function rowSignature(row) {
    return [
        row.programme,
        row.level,
        row.semester,
        row.courseCode,
        row.courseTitle
    ].map(value => String(value || '').trim()).join('|');
}

function sourceCounts(rows) {
    return rows.reduce((counts, row) => {
        const key = String(row.sourceTitle || 'Unknown source').trim() || 'Unknown source';
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function programmeCoverage(rows) {
    const coverage = new Map();
    for (const row of rows) {
        const programme = String(row.programme || '').trim();
        const level = String(row.level || '').trim();
        if (!programme || !level) continue;
        if (!coverage.has(programme)) coverage.set(programme, new Set());
        coverage.get(programme).add(level);
    }

    return [...coverage.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([programme, levels]) => ({
            programme,
            levels: [...levels].sort((a, b) => Number(a) - Number(b))
        }));
}

function coverageWarnings(coverage) {
    const byProgramme = new Map(coverage.map(item => [item.programme, new Set(item.levels)]));
    const warnings = [];

    for (const [programme, expectedLevels] of Object.entries(EXPECTED_LEVEL_COVERAGE)) {
        const actual = byProgramme.get(programme);
        if (!actual) {
            warnings.push({
                type: 'missing_programme',
                programme,
                message: `${programme} has no structured course rows`
            });
            continue;
        }
        const missing = expectedLevels.filter(level => !actual.has(level));
        if (missing.length) {
            warnings.push({
                type: 'missing_expected_levels',
                programme,
                missing,
                actual: [...actual].sort((a, b) => Number(a) - Number(b)),
                message: `${programme} is missing expected level(s): ${missing.join(', ')}`
            });
        }
    }

    return warnings;
}

async function main() {
    const rows = await courseCatalogService.loadCatalog();
    const invalidRows = rows.filter(row => !isCleanCourseCode(row.courseCode));
    const invalidSignatures = new Set(invalidRows.map(rowSignature));
    const uniqueInvalidRows = [...invalidSignatures].map(signature => (
        invalidRows.find(row => rowSignature(row) === signature)
    ));
    const unknownInvalidRows = uniqueInvalidRows.filter(row => !KNOWN_INVALID_CODE_SIGNATURES.has(rowSignature(row)));
    const coverage = programmeCoverage(rows);
    const warnings = coverageWarnings(coverage);
    const failures = [];
    const duplicateCourseRows = rows.length - new Set(rows.map(rowSignature)).size;

    if (rows.length < MIN_EXPECTED_ROWS) {
        failures.push(`Course catalog row count dropped below ${MIN_EXPECTED_ROWS}: ${rows.length}`);
    }
    if (uniqueInvalidRows.length > MAX_KNOWN_INVALID_CODES) {
        failures.push(`Unique invalid course-code count exceeded baseline ${MAX_KNOWN_INVALID_CODES}: ${uniqueInvalidRows.length}`);
    }
    if (unknownInvalidRows.length) {
        failures.push(`Found ${unknownInvalidRows.length} unknown invalid course-code row(s)`);
    }
    if (duplicateCourseRows > 0) {
        warnings.push({
            type: 'duplicate_course_rows',
            count: duplicateCourseRows,
            message: `${duplicateCourseRows} duplicate course row(s) are present after catalog loading. Review ingestion/source duplication.`
        });
    }

    console.log(JSON.stringify({
        ok: failures.length === 0,
        rows: rows.length,
        programmes: coverage.length,
        sources: sourceCounts(rows),
        invalidCourseCodes: {
            ok: uniqueInvalidRows.length <= MAX_KNOWN_INVALID_CODES && unknownInvalidRows.length === 0,
            count: invalidRows.length,
            uniqueCount: uniqueInvalidRows.length,
            knownBaseline: MAX_KNOWN_INVALID_CODES,
            rows: invalidRows.map(row => ({
                known: KNOWN_INVALID_CODE_SIGNATURES.has(rowSignature(row)),
                programme: row.programme,
                level: row.level,
                semester: row.semester,
                courseCode: row.courseCode,
                courseTitle: row.courseTitle,
                sourceTitle: row.sourceTitle
            }))
        },
        levelCoverage: coverage,
        warnings,
        failures
    }, null, 2));

    closePoolAndExit(failures.length === 0 ? 0 : 1);
}

main().catch(error => {
    console.error(error.message || error);
    closePoolAndExit(1);
});
