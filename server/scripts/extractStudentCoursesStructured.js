const crypto = require('crypto');
const { query, pool } = require('../../config/db');
const courseCatalogService = require('../services/courseCatalogService');

const LEGACY_SOURCE_TITLE = 'student courses.docx';
const UPDATED_SOURCE_TITLE = 'ALL COURSES FOR BMU.xlsx';
const MBBS_SOURCE_TITLE = 'COLLEGE OF MEDICINE BMU PROSPECTUS-new.docx';
const COURSE_SOURCES = [LEGACY_SOURCE_TITLE, UPDATED_SOURCE_TITLE, MBBS_SOURCE_TITLE];

function stableHash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function sourceText(row) {
    return [
        row.programme,
        row.level ? `${row.level} level` : null,
        row.semester ? `${row.semester} semester` : null,
        row.courseCode,
        row.courseTitle,
        row.creditUnits != null ? `${row.creditUnits} unit${Number(row.creditUnits) === 1 ? '' : 's'}` : null,
        row.category
    ].filter(Boolean).join(' | ');
}

async function ensureTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS academic_courses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            record_hash CHAR(40) NOT NULL,
            source_fact_id INT NULL,
            source_table_id INT NULL,
            source_document_id INT NULL,
            programme VARCHAR(255) NULL,
            level_label VARCHAR(80) NULL,
            semester_label VARCHAR(80) NULL,
            course_code VARCHAR(40) NULL,
            course_title VARCHAR(255) NULL,
            credit_units DECIMAL(4,1) NULL,
            authority_type VARCHAR(80) NULL,
            scope_label VARCHAR(160) NULL,
            source_path TEXT NULL,
            raw_text TEXT NULL,
            row_json LONGTEXT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_academic_courses_hash (record_hash),
            INDEX idx_academic_courses_status (status),
            INDEX idx_academic_courses_code (course_code),
            INDEX idx_academic_courses_programme (programme)
        ) ENGINE=InnoDB
    `);
}

async function findSourceDocumentId(sourceTitle) {
    const sourceLike = sourceTitle === UPDATED_SOURCE_TITLE
        ? '%all courses for bmu%'
        : sourceTitle === MBBS_SOURCE_TITLE
            ? '%college of medicine%bmu%prospectus%'
            : '%student courses%';
    const rows = await query(
        `SELECT id FROM documents WHERE LOWER(title) = LOWER(?) OR LOWER(title) LIKE ? ORDER BY id DESC LIMIT 1`,
        [sourceTitle, sourceLike]
    );
    return rows[0]?.id || null;
}

function scopeLabel(row) {
    if (row.sourceTitle === UPDATED_SOURCE_TITLE) return 'BMU updated course catalogue';
    if (row.sourceTitle === MBBS_SOURCE_TITLE) return 'BMU College of Medicine prospectus';
    return 'BMU student course catalogue';
}

async function upsertCourse(row, sourceDocumentId) {
    const sourceTitle = row.sourceTitle || LEGACY_SOURCE_TITLE;
    const payload = {
        source: sourceTitle,
        sn: row.sn,
        faculty: row.faculty,
        department: row.department,
        programme: row.programme,
        level: row.level,
        semester: row.semester,
        courseCode: row.courseCode,
        courseTitle: row.courseTitle,
        creditUnits: row.creditUnits ?? null,
        category: row.category
    };
    const recordHash = stableHash(JSON.stringify(payload));
    const rawText = sourceText(row);
    await query(`
        INSERT INTO academic_courses (
            record_hash, source_document_id, programme, level_label, semester_label,
            course_code, course_title, credit_units, authority_type, scope_label,
            source_path, raw_text, row_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON DUPLICATE KEY UPDATE
            source_document_id = VALUES(source_document_id),
            programme = VALUES(programme),
            level_label = VALUES(level_label),
            semester_label = VALUES(semester_label),
            course_code = VALUES(course_code),
            course_title = VALUES(course_title),
            credit_units = VALUES(credit_units),
            authority_type = VALUES(authority_type),
            scope_label = VALUES(scope_label),
            source_path = VALUES(source_path),
            raw_text = VALUES(raw_text),
            row_json = VALUES(row_json),
            status = 'active'
    `, [
        recordHash,
        sourceDocumentId,
        row.programme,
        row.level ? `${row.level} Level` : null,
        row.semester || null,
        row.courseCode,
        row.courseTitle,
        row.creditUnits ?? null,
        'institutional',
        scopeLabel(row),
        sourceTitle,
        rawText,
        JSON.stringify(payload)
    ]);
}

async function main() {
    await ensureTable();
    const sourceDocumentIds = {};
    for (const sourceTitle of COURSE_SOURCES) {
        sourceDocumentIds[sourceTitle] = await findSourceDocumentId(sourceTitle);
    }
    const rows = await courseCatalogService.loadCatalog();

    await query(
        `UPDATE academic_courses SET status = 'inactive' WHERE source_path IN (?, ?, ?)`,
        COURSE_SOURCES
    );

    let upserted = 0;
    for (const row of rows) {
        await upsertCourse(row, sourceDocumentIds[row.sourceTitle || LEGACY_SOURCE_TITLE] || null);
        upserted++;
    }

    const programmeSummary = {};
    const sourceSummary = {};
    for (const row of rows) {
        const key = row.programme || 'UNKNOWN';
        programmeSummary[key] ||= {};
        programmeSummary[key][row.level || 'unknown'] = (programmeSummary[key][row.level || 'unknown'] || 0) + 1;
        sourceSummary[row.sourceTitle || LEGACY_SOURCE_TITLE] = (sourceSummary[row.sourceTitle || LEGACY_SOURCE_TITLE] || 0) + 1;
    }

    console.log(JSON.stringify({
        sources: sourceSummary,
        sourceDocumentIds,
        rowsParsed: rows.length,
        rowsUpserted: upserted,
        programmes: programmeSummary
    }, null, 2));
}

main()
    .then(() => pool.end())
    .catch(error => {
        console.error(error);
        pool.end();
        process.exit(1);
    });
