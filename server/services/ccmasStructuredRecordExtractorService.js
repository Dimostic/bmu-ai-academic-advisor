const crypto = require('crypto');
const { query } = require('../../config/db');

const GENERATED_BY = 'ccmas_structured_record_extractor_v1';

function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function hash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function ensureSentence(value, max = 700) {
    const text = clean(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3).trim()}...`;
}

function toMarkdownTable(rows, columns) {
    if (!rows.length) return '';
    const headers = columns.map(col => col.label);
    const line = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map(row => `| ${columns.map(col => clean(row[col.key] ?? '')).join(' | ')} |`);
    return [line, sep, ...body].join('\n');
}

function detectDurationFacts(section) {
    const text = clean(section.content);
    const rows = [];
    const push = (entryMode, years, evidence) => {
        if (!years || years < 1 || years > 8) return;
        rows.push({
            programme: section.programme_name,
            degree: section.degree,
            rule_type: 'programme_duration',
            entry_mode: entryMode,
            duration_years: years,
            scope: section.scope_label || 'NUC CCMAS national minimum',
            evidence: ensureSentence(evidence, 320)
        });
    };

    let match = text.match(/run\s+for\s+(\d+)\s+years?\s+for\s+(?:unified tertiary matriculation examination\s+)?(?:utme|entry)\s+[^.]{0,140}?\s+and\s+(\d+)\s+years?\s+for\s+direct entry/i);
    if (match) {
        push('UTME', Number(match[1]), match[0]);
        push('Direct Entry', Number(match[2]), match[0]);
    }

    match = text.match(/(\d+)[-\s]?year\s+(?:degree\s+)?programme/i);
    if (match && /utme|unified tertiary matriculation/i.test(text.slice(Math.max(0, match.index - 120), match.index + 220))) {
        push('UTME', Number(match[1]), text.slice(Math.max(0, match.index - 80), match.index + 220));
    }

    match = text.match(/direct entry[^.]{0,180}?(\d+)\s+years?/i);
    if (match) push('Direct Entry', Number(match[1]), match[0]);

    return rows;
}

function detectRuleFacts(section) {
    const text = clean(section.content);
    const facts = [];
    const passMark = text.match(/pass mark (?:for [^.]{0,80}? )?is\s+(\d{2})%/i);
    if (passMark) {
        facts.push({
            fact_type: 'graduation_requirement',
            predicate_name: 'core_course_pass_mark',
            value: { percent: Number(passMark[1]) },
            text: `For ${section.programme_name}, the CCMAS states that the pass mark for core courses is ${passMark[1]}%.`
        });
    }

    const unclassified = /degree is (?:an?\s+)?unclassified degree|degree is unclassified/i.test(text);
    if (unclassified) {
        facts.push({
            fact_type: 'graduation_requirement',
            predicate_name: 'degree_classification',
            value: { classification: 'unclassified' },
            text: `For ${section.programme_name}, the CCMAS states that the degree is unclassified.`
        });
    }

    const creditMatches = Array.from(text.matchAll(/(\d{2,3})\s+credit units?\s+for\s+([^.;,]+)/ig));
    for (const m of creditMatches) {
        facts.push({
            fact_type: 'graduation_requirement',
            predicate_name: 'minimum_credit_units',
            value: { credit_units: Number(m[1]), applies_to: clean(m[2]) },
            text: `For ${section.programme_name}, the CCMAS states a minimum of ${m[1]} credit units for ${clean(m[2])}.`
        });
    }

    if (/admission/i.test(section.section_key)) {
        facts.push({
            fact_type: 'admission_requirement',
            predicate_name: 'admission_requirements_summary',
            value: { summary: ensureSentence(text, 1200) },
            text: `${section.programme_name} admission requirements: ${ensureSentence(text, 900)}`
        });
    }

    if (/graduation/i.test(section.section_key)) {
        facts.push({
            fact_type: 'graduation_requirement',
            predicate_name: 'graduation_requirements_summary',
            value: { summary: ensureSentence(text, 1200) },
            text: `${section.programme_name} graduation requirements: ${ensureSentence(text, 900)}`
        });
    }

    return facts;
}

function extractCourseRows(section) {
    const text = clean(section.content);
    const rows = [];
    const courseRe = /\b((?:BMU[-\s])?[A-Z]{2,4}[-\s]?\d{3})\s+([A-Z][A-Za-z0-9&,.:'()\/\-\s]{3,120}?)\s+(\d{1,2})\s+([CE])\b/g;
    let match;
    while ((match = courseRe.exec(text)) !== null) {
        const title = clean(match[2]).replace(/\b(?:LH|PH)\s*$/i, '').trim();
        if (!title || /^(level|course code|course title|status)$/i.test(title)) continue;
        rows.push({
            programme: section.programme_name,
            degree: section.degree,
            course_code: match[1].replace(/\s+/, '-').toUpperCase(),
            course_title: title,
            units: Number(match[3]),
            status: match[4] === 'C' ? 'Compulsory' : 'Elective',
            level: inferNearbyLevel(text, match.index),
            semester: inferNearbySemester(text, match.index),
            scope: section.scope_label || 'NUC CCMAS national minimum'
        });
    }

    const seen = new Set();
    return rows.filter(row => {
        const key = `${row.course_code}|${row.course_title}|${row.level || ''}|${row.semester || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 450);
}

function inferNearbyLevel(text, index) {
    const nearby = text.slice(Math.max(0, index - 280), index + 80);
    const m = nearby.match(/(\d{3})\s+Level/i);
    return m ? `${m[1]} Level` : null;
}

function inferNearbySemester(text, index) {
    const nearby = text.slice(Math.max(0, index - 220), index + 80);
    if (/\bfirst semester\b/i.test(nearby)) return 'First Semester';
    if (/\bsecond semester\b/i.test(nearby)) return 'Second Semester';
    return null;
}

function extractCourseDescriptionRows(section) {
    const text = clean(section.content);
    const rows = [];
    const re = /\b((?:BMU[-\s])?[A-Z]{2,4}[-\s]?\d{3})\s*:\s*([^()]{3,120}?)\s*\((\d{1,2})\s+Units?\s+([CE])/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = Math.min(text.length, start + 1200);
        const excerpt = text.slice(start, end);
        rows.push({
            programme: section.programme_name,
            degree: section.degree,
            course_code: match[1].replace(/\s+/, '-').toUpperCase(),
            course_title: clean(match[2]),
            units: Number(match[3]),
            status: match[4] === 'C' ? 'Compulsory' : 'Elective',
            description: ensureSentence(excerpt, 900),
            scope: section.scope_label || 'NUC CCMAS national minimum'
        });
    }
    return rows.slice(0, 350);
}

class CcmasStructuredRecordExtractorService {
    async ensureSchema() {
        await query(`
            CREATE TABLE IF NOT EXISTS structured_facts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lab_fact_id INT NULL,
                source_document_id INT NULL,
                fact_type VARCHAR(80) NOT NULL,
                subject VARCHAR(255) NULL,
                predicate_name VARCHAR(120) NULL,
                value_json LONGTEXT NULL,
                human_text TEXT NOT NULL,
                authority_type VARCHAR(80) NULL,
                scope_label VARCHAR(160) NULL,
                source_path TEXT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                currentness_label VARCHAR(80) NOT NULL DEFAULT 'current',
                authority_rank INT NOT NULL DEFAULT 70,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_structured_facts_type (fact_type),
                INDEX idx_structured_facts_status (status),
                INDEX idx_structured_facts_subject (subject),
                FULLTEXT INDEX ft_structured_facts (subject, human_text, source_path)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS structured_tables (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lab_table_id INT NULL,
                source_document_id INT NULL,
                title VARCHAR(255) NOT NULL,
                table_type VARCHAR(80) NULL,
                programme VARCHAR(255) NULL,
                section_label VARCHAR(255) NULL,
                source_path TEXT NULL,
                markdown LONGTEXT NOT NULL,
                rows_json LONGTEXT NOT NULL,
                metadata_json LONGTEXT NULL,
                authority_rank INT NOT NULL DEFAULT 70,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                currentness_label VARCHAR(80) NOT NULL DEFAULT 'current',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_structured_tables_status (status),
                INDEX idx_structured_tables_type (table_type),
                INDEX idx_structured_tables_programme (programme),
                FULLTEXT INDEX ft_structured_tables (title, programme, section_label, source_path)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    async extractAll() {
        await this.ensureSchema();
        await this._deactivatePrevious();
        const sections = await query(`
            SELECT *
            FROM ccmas_programme_sections
            WHERE status = 'active'
            ORDER BY document_id ASC, programme_code ASC, section_key ASC
        `);
        let facts = 0;
        let tables = 0;
        for (const section of sections || []) {
            facts += await this._extractFacts(section);
            tables += await this._extractTables(section);
        }
        return { sectionsScanned: sections.length, factsUpserted: facts, tablesUpserted: tables };
    }

    async _deactivatePrevious() {
        await query(`
            UPDATE structured_facts
            SET status = 'inactive'
            WHERE predicate_name LIKE 'ccmas_%'
               OR (
                    source_path LIKE '% > % > %'
                    AND source_path REGEXP 'CCMAS|Allied Health|Medicine and Dentistry|Pharmacy|Basic Medical Sciences|Sciences|Social Sciences'
               )
        `);
        await query(`
            UPDATE structured_tables
            SET status = 'inactive'
            WHERE metadata_json LIKE ?
        `, [`%"generated_by":"${GENERATED_BY}"%`]);
    }

    async _extractFacts(section) {
        const factRows = [];
        for (const row of detectDurationFacts(section)) {
            factRows.push({
                fact_type: 'programme_duration',
                predicate_name: `ccmas_programme_duration_${String(row.entry_mode).toLowerCase().replace(/\s+/g, '_')}`,
                value: row,
                text: `${section.programme_name} duration (${row.entry_mode}): ${row.duration_years} years. ${row.evidence}`
            });
        }
        factRows.push(...detectRuleFacts(section).map(item => ({
            ...item,
            predicate_name: `ccmas_${item.predicate_name}`
        })));

        let count = 0;
        for (const fact of factRows) {
            await query(`
                INSERT INTO structured_facts
                    (source_document_id, fact_type, subject, predicate_name, value_json, human_text,
                     authority_type, scope_label, source_path, status, currentness_label, authority_rank)
                VALUES (?, ?, ?, ?, ?, ?, 'regulator', ?, ?, 'active', 'current', 90)
            `, [
                section.document_id,
                fact.fact_type,
                section.programme_name,
                fact.predicate_name,
                JSON.stringify({ ...fact.value, generated_by: GENERATED_BY, record_hash: hash(`${section.id}|${fact.predicate_name}|${fact.text}`) }),
                fact.text,
                section.scope_label || 'NUC CCMAS national minimum',
                section.source_path
            ]);
            count++;
        }
        return count;
    }

    async _extractTables(section) {
        const tables = [];
        if (section.section_key === 'global_course_structure') {
            const rows = extractCourseRows(section);
            if (rows.length) {
                tables.push({
                    title: `${section.programme_name} Course Structure`,
                    table_type: 'course_structure',
                    rows,
                    markdown: toMarkdownTable(rows.slice(0, 80), [
                        { key: 'level', label: 'Level' },
                        { key: 'semester', label: 'Semester' },
                        { key: 'course_code', label: 'Course Code' },
                        { key: 'course_title', label: 'Course Title' },
                        { key: 'units', label: 'Units' },
                        { key: 'status', label: 'Status' }
                    ])
                });
            }
        }

        if (section.section_key === 'course_contents_learning_outcomes') {
            const rows = extractCourseDescriptionRows(section);
            if (rows.length) {
                tables.push({
                    title: `${section.programme_name} Course Descriptions`,
                    table_type: 'course_descriptions',
                    rows,
                    markdown: toMarkdownTable(rows.slice(0, 60), [
                        { key: 'course_code', label: 'Course Code' },
                        { key: 'course_title', label: 'Course Title' },
                        { key: 'units', label: 'Units' },
                        { key: 'status', label: 'Status' },
                        { key: 'description', label: 'Description' }
                    ])
                });
            }
        }

        let count = 0;
        for (const table of tables) {
            await query(`
                INSERT INTO structured_tables
                    (source_document_id, title, table_type, programme, section_label, source_path,
                     markdown, rows_json, metadata_json, authority_rank, status, currentness_label)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 90, 'active', 'current')
            `, [
                section.document_id,
                table.title,
                table.table_type,
                section.programme_name,
                section.section_title,
                section.source_path,
                table.markdown,
                JSON.stringify(table.rows),
                JSON.stringify({
                    generated_by: GENERATED_BY,
                    ccmas_section_id: section.id,
                    programme_code: section.programme_code,
                    degree: section.degree,
                    row_count: table.rows.length
                })
            ]);
            count++;
        }
        return count;
    }
}

module.exports = new CcmasStructuredRecordExtractorService();
