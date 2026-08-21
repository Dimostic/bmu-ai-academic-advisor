const crypto = require('crypto');
const { query, pool } = require('../../config/db');
const courseCatalogService = require('../services/courseCatalogService');

const SOURCE_TITLE = 'student courses.docx';

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

async function findSourceDocumentId() {
    const rows = await query(
        `SELECT id FROM documents WHERE LOWER(title) = LOWER(?) OR LOWER(title) LIKE '%student courses%' ORDER BY id DESC LIMIT 1`,
        [SOURCE_TITLE]
    );
    return rows[0]?.id || null;
}

async function upsertCourse(row, sourceDocumentId) {
    const payload = {
        source: SOURCE_TITLE,
        sn: row.sn,
        faculty: row.faculty,
        department: row.department,
        programme: row.programme,
        level: row.level,
        semester: row.semester,
        courseCode: row.courseCode,
        courseTitle: row.courseTitle,
        category: row.category
    };
    const recordHash = stableHash(JSON.stringify(payload));
    const rawText = sourceText(row);
    await query(`
        INSERT INTO academic_courses (
            record_hash, source_document_id, programme, level_label, semester_label,
            course_code, course_title, credit_units, authority_type, scope_label,
            source_path, raw_text, row_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active')
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
        'institutional',
        'BMU student course catalogue',
        SOURCE_TITLE,
        rawText,
        JSON.stringify(payload)
    ]);
}

async function main() {
    await ensureTable();
    const sourceDocumentId = await findSourceDocumentId();
    const rows = await courseCatalogService.loadCatalog();

    await query(
        `UPDATE academic_courses SET status = 'inactive' WHERE source_path = ?`,
        [SOURCE_TITLE]
    );

    let upserted = 0;
    for (const row of rows) {
        await upsertCourse(row, sourceDocumentId);
        upserted++;
    }

    const programmeSummary = {};
    for (const row of rows) {
        const key = row.programme || 'UNKNOWN';
        programmeSummary[key] ||= {};
        programmeSummary[key][row.level || 'unknown'] = (programmeSummary[key][row.level || 'unknown'] || 0) + 1;
    }

    console.log(JSON.stringify({
        source: SOURCE_TITLE,
        sourceDocumentId,
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
