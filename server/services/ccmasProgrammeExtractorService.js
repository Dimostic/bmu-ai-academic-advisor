const crypto = require('crypto');
const { query } = require('../../config/db');

const EXTRACTION_VERSION = 'ccmas-programme-sections-v1';

const SECTION_DEFINITIONS = [
    ['overview', 'Overview', /\boverview\b/i],
    ['philosophy', 'Philosophy', /\bphilosophy\b/i],
    ['objectives', 'Objectives', /\bobjectives?\b/i],
    ['unique_features', 'Unique Features', /\bunique features?\b/i],
    ['employability_skills', 'Employability Skills', /\bemployability skills?\b/i],
    ['twenty_first_century_skills', '21st Century Skills', /\b(?:21st|2lst|st)\s+century skills?\b/i],
    ['admission_graduation_requirements', 'Admission and Graduation Requirements', /\badmissions?\s+and\s+graduation requirements?\b/i],
    ['admission_requirements', 'Admission Requirements', /\badmission requirements?\b/i],
    ['graduation_requirements', 'Graduation Requirements', /\bgraduation requirements?\b/i],
    ['global_course_structure', 'Global Course Structure', /\bglobal course structure\b/i],
    ['course_contents_learning_outcomes', 'Course Contents and Learning Outcomes', /\bcourse contents?\s+and\s+learning outcomes?\b/i],
    ['minimum_academic_standards', 'Minimum Academic Standards', /\bminimum academic standards?\b/i]
];

const PROGRAMME_CATALOG = [
    { code: 'AUD', name: 'Audiology', degree: 'B.AUD', discipline: 'Allied Health Sciences', aliases: ['B.AUD Audiology', 'Audiology'] },
    { code: 'CAM', name: 'Complementary and Alternative Medicine', degree: 'B.Sc. CAM', discipline: 'Allied Health Sciences', aliases: ['Complementary and Alternative Medicine'] },
    { code: 'DNT', name: 'Dental Technology', degree: 'B.Sc. DNT', discipline: 'Allied Health Sciences', aliases: ['Dental Technology'] },
    { code: 'DT', name: 'Dental Therapy', degree: 'B.DT', discipline: 'Allied Health Sciences', aliases: ['Dental Therapy'] },
    { code: 'EHS', name: 'Environmental Health Science', degree: 'B.EHS', discipline: 'Allied Health Sciences', aliases: ['Environmental Health Science'] },
    { code: 'HAM', name: 'Health Care Administration and Hospital Management', degree: 'B.Sc. HAM', discipline: 'Allied Health Sciences', aliases: ['Health Care Administration and Hospital Management'] },
    { code: 'HIM', name: 'Health Information Management', degree: 'B.HIM', discipline: 'Allied Health Sciences', aliases: ['Health Information Management'] },
    { code: 'ITH', name: 'Information Technology and Health Informatics', degree: 'B.Sc. ITH', discipline: 'Allied Health Sciences', aliases: ['Information Technology and Health Informatics', 'Health Informatics'] },
    { code: 'BMLS', name: 'Medical Laboratory Science', degree: 'B.MLS', discipline: 'Allied Health Sciences', aliases: ['B.MLS Medical Laboratory Science', 'BMLS Medical Laboratory Science', 'Medical Laboratory Science', 'Medical Laboratory Sciences'] },
    { code: 'BNSC', name: 'Nursing Science', degree: 'B.N.Sc', discipline: 'Allied Health Sciences', aliases: ['Nursing Science', 'Nursing Sciences'] },
    { code: 'NUT', name: 'Human Nutrition and Dietetics', degree: 'B.Sc.', discipline: 'Allied Health Sciences', aliases: ['Human Nutrition and Dietetics', 'Nutrition and Dietetics'] },
    { code: 'OT', name: 'Occupational Therapy', degree: 'B.OT', discipline: 'Allied Health Sciences', aliases: ['Occupational Therapy'] },
    { code: 'OD', name: 'Optometry', degree: 'O.D', discipline: 'Allied Health Sciences', aliases: ['Optometry'] },
    { code: 'PHA', name: 'Pharmacology', degree: 'B.Sc.', discipline: 'Allied Health Sciences', aliases: ['Pharmacology'] },
    { code: 'DPT', name: 'Physiotherapy', degree: 'DPT', discipline: 'Allied Health Sciences', aliases: ['Physiotherapy'] },
    { code: 'P&O', name: 'Prosthetics and Orthotics', degree: 'B.Sc.', discipline: 'Allied Health Sciences', aliases: ['Prosthetics and Orthotics'] },
    { code: 'PH', name: 'Public Health', degree: 'B.Sc.', discipline: 'Allied Health Sciences', aliases: ['Public Health'] },
    { code: 'BRAD', name: 'Radiography', degree: 'B.Rad', discipline: 'Allied Health Sciences', aliases: ['Radiography'] },
    { code: 'SLT', name: 'Speech-Language Therapy', degree: 'B.SLT', discipline: 'Allied Health Sciences', aliases: ['Speech-Language Therapy', 'Speech Language Therapy'] },

    { code: 'MBBS', name: 'Medicine and Surgery', degree: 'MBBS', discipline: 'Medicine and Dentistry', aliases: ['Medicine and Surgery', 'MBBS', 'Bachelor of Medicine', 'Bachelor of Surgery'] },
    { code: 'BDS', name: 'Dentistry', degree: 'BDS', discipline: 'Medicine and Dentistry', aliases: ['Dentistry', 'BDS', 'Dental Surgery'] },
    { code: 'PHARMD', name: 'Doctor of Pharmacy', degree: 'PharmD', discipline: 'Pharmacy and Pharmaceutical Sciences', aliases: ['Doctor of Pharmacy', 'PharmD', 'Pharm.D'] },
    { code: 'BPHARM', name: 'Pharmacy', degree: 'B.Pharm', discipline: 'Pharmacy and Pharmaceutical Sciences', aliases: ['B.Pharm', 'Bachelor of Pharmacy', 'Pharmacy'] },

    { code: 'ANA', name: 'Human Anatomy', degree: 'B.Sc.', discipline: 'Basic Medical Sciences', aliases: ['Human Anatomy', 'Anatomy'] },
    { code: 'PIO', name: 'Human Physiology', degree: 'B.Sc.', discipline: 'Basic Medical Sciences', aliases: ['Human Physiology', 'Physiology'] },
    { code: 'BCH', name: 'Biochemistry', degree: 'B.Sc.', discipline: 'Basic Medical Sciences', aliases: ['Biochemistry'] },

    { code: 'BIO', name: 'Biology', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Biology'] },
    { code: 'MCB', name: 'Microbiology', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Microbiology'] },
    { code: 'CHM', name: 'Chemistry', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Chemistry'] },
    { code: 'PHY', name: 'Physics', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Physics', 'Physics with Electronics'] },
    { code: 'MTH', name: 'Mathematics', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Mathematics'] },
    { code: 'STA', name: 'Statistics', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Statistics'] },
    { code: 'COS', name: 'Computer Science', degree: 'B.Sc.', discipline: 'Sciences', aliases: ['Computer Science', 'Computing Science'] },

    { code: 'ECO', name: 'Economics', degree: 'B.Sc.', discipline: 'Social Sciences', aliases: ['Economics'] },
    { code: 'SOC', name: 'Sociology', degree: 'B.Sc.', discipline: 'Social Sciences', aliases: ['Sociology'] },
    { code: 'PSY', name: 'Psychology', degree: 'B.Sc.', discipline: 'Social Sciences', aliases: ['Psychology'] }
];

function normalizeText(value) {
    return String(value || '')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function compactText(value) {
    return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function hashContent(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCcmasDocument(title) {
    return /(ccmas|allied health|medicine and dentistry|pharmacy and pharmaceutical|basic medical sciences|social sciences|sciences)/i.test(String(title || ''));
}

function programmeMatchesDocument(programme, title) {
    const t = String(title || '').toLowerCase();
    const discipline = String(programme.discipline || '').toLowerCase();
    if (discipline && t.includes(discipline)) return true;
    if (discipline === 'allied health sciences' && t.includes('allied health')) return true;
    if (discipline === 'medicine and dentistry' && t.includes('medicine and dentistry')) return true;
    if (discipline === 'pharmacy and pharmaceutical sciences' && t.includes('pharmacy')) return true;
    if (discipline === 'basic medical sciences' && t.includes('basic medical')) return true;
    if (discipline === 'social sciences' && t.includes('social sciences')) return true;
    if (discipline === 'sciences' && /\bsciences\b/i.test(t) && !/allied|basic medical|social/i.test(t)) return true;
    return false;
}

function findProgrammeAnchors(text, documentTitle) {
    const source = compactText(text);
    const anchors = [];
    for (const programme of PROGRAMME_CATALOG) {
        if (!programmeMatchesDocument(programme, documentTitle)) continue;
        for (const alias of programme.aliases || []) {
            const aliasPattern = escapeRegExp(alias).replace(/\s+/g, '\\s+');
            const re = new RegExp(`(?:^|\\b|New\\s+)(${aliasPattern})(?=\\s+(?:Overview|Philosophy|Objectives|Admission|Global Course Structure|Course Contents|Minimum Academic Standards)|\\b)`, 'ig');
            let match;
            while ((match = re.exec(source)) !== null) {
                anchors.push({
                    index: match.index + (match[0].length - match[1].length),
                    heading: match[1],
                    programme
                });
            }
        }
    }

    const deduped = [];
    anchors.sort((a, b) => a.index - b.index);
    for (const anchor of anchors) {
        const duplicate = deduped.some(item =>
            item.programme.code === anchor.programme.code && Math.abs(item.index - anchor.index) < 220
        );
        if (!duplicate) deduped.push(anchor);
    }
    return deduped;
}

function findSectionAnchors(programmeText) {
    const anchors = [];
    for (const [key, title, pattern] of SECTION_DEFINITIONS) {
        const re = new RegExp(pattern.source, 'ig');
        let match;
        while ((match = re.exec(programmeText)) !== null) {
            anchors.push({ key, title, index: match.index, heading: match[0] });
        }
    }
    anchors.sort((a, b) => a.index - b.index);

    const deduped = [];
    for (const anchor of anchors) {
        if (deduped.some(item => item.key === anchor.key && Math.abs(item.index - anchor.index) < 80)) continue;
        if (deduped.some(item => Math.abs(item.index - anchor.index) < 12)) continue;
        deduped.push(anchor);
    }
    return deduped;
}

function approximateChunkIndex(chunks, charOffset) {
    let running = 0;
    for (const chunk of chunks) {
        const len = compactText(chunk.content).length + 1;
        if (charOffset <= running + len) return Number(chunk.chunk_index ?? chunk.chunkIndex ?? 0);
        running += len;
    }
    return chunks.length ? Number(chunks[chunks.length - 1].chunk_index ?? chunks[chunks.length - 1].chunkIndex ?? 0) : null;
}

class CcmasProgrammeExtractorService {
    async ensureSchema() {
        await query(`
            CREATE TABLE IF NOT EXISTS ccmas_programme_sections (
                id INT AUTO_INCREMENT PRIMARY KEY,
                document_id INT NOT NULL,
                document_title VARCHAR(255) NOT NULL,
                discipline VARCHAR(160) NULL,
                programme_code VARCHAR(40) NOT NULL,
                programme_name VARCHAR(180) NOT NULL,
                degree VARCHAR(80) NULL,
                section_key VARCHAR(80) NOT NULL,
                section_title VARCHAR(180) NOT NULL,
                content LONGTEXT NOT NULL,
                content_hash CHAR(64) NOT NULL,
                source_path VARCHAR(500) NULL,
                authority_type VARCHAR(80) DEFAULT 'regulator',
                scope_label VARCHAR(180) DEFAULT 'NUC CCMAS national minimum',
                status VARCHAR(40) DEFAULT 'active',
                chunk_start INT NULL,
                chunk_end INT NULL,
                extraction_version VARCHAR(80) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_ccmas_programme_section (document_id, programme_code, section_key, extraction_version),
                INDEX idx_ccmas_programme (programme_name, programme_code),
                INDEX idx_ccmas_section (section_key),
                INDEX idx_ccmas_status (status),
                CONSTRAINT fk_ccmas_programme_sections_document
                    FOREIGN KEY (document_id) REFERENCES documents(id)
                    ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    async extractAll({ documentIds = null } = {}) {
        await this.ensureSchema();
        const params = [];
        let where = `d.is_active = TRUE AND d.embedding_status = 'completed'`;
        if (Array.isArray(documentIds) && documentIds.length) {
            where += ` AND d.id IN (${documentIds.map(() => '?').join(', ')})`;
            params.push(...documentIds);
        }

        const documents = await query(`
            SELECT d.id, d.title, d.category
            FROM documents d
            WHERE ${where}
            ORDER BY d.id ASC
        `, params);

        const results = [];
        for (const doc of documents || []) {
            if (!isCcmasDocument(doc.title)) continue;
            results.push(await this.extractDocument(doc.id));
        }
        return results;
    }

    async extractDocument(documentId) {
        await this.ensureSchema();
        const docs = await query('SELECT id, title FROM documents WHERE id = ? AND is_active = TRUE', [documentId]);
        const doc = docs[0];
        if (!doc) return { documentId, skipped: true, reason: 'document_not_found' };
        if (!isCcmasDocument(doc.title)) return { documentId, title: doc.title, skipped: true, reason: 'not_ccmas_like' };

        const chunks = await query(`
            SELECT chunk_index, content
            FROM document_chunks
            WHERE document_id = ?
            ORDER BY chunk_index ASC
        `, [documentId]);
        if (!chunks.length) return { documentId, title: doc.title, skipped: true, reason: 'no_chunks' };

        const fullText = chunks.map(chunk => compactText(chunk.content)).join(' ');
        const programmeAnchors = findProgrammeAnchors(fullText, doc.title);
        let sectionsUpserted = 0;
        const programmes = new Set();

        for (let i = 0; i < programmeAnchors.length; i++) {
            const anchor = programmeAnchors[i];
            const next = programmeAnchors[i + 1];
            const programmeText = fullText.slice(anchor.index, next ? next.index : fullText.length);
            if (programmeText.length < 300) continue;
            programmes.add(anchor.programme.code);

            const sectionAnchors = findSectionAnchors(programmeText);
            for (let s = 0; s < sectionAnchors.length; s++) {
                const section = sectionAnchors[s];
                const nextSection = sectionAnchors[s + 1];
                const start = section.index;
                const end = nextSection ? nextSection.index : programmeText.length;
                const content = compactText(programmeText.slice(start, end));
                if (content.length < 120) continue;

                const absoluteStart = anchor.index + start;
                const absoluteEnd = anchor.index + end;
                await this._upsertSection({
                    documentId,
                    documentTitle: doc.title,
                    programme: anchor.programme,
                    section,
                    content,
                    chunkStart: approximateChunkIndex(chunks, absoluteStart),
                    chunkEnd: approximateChunkIndex(chunks, absoluteEnd),
                });
                sectionsUpserted++;
            }
        }

        return {
            documentId,
            title: doc.title,
            programmesDetected: programmes.size,
            sectionsUpserted
        };
    }

    async _upsertSection({ documentId, documentTitle, programme, section, content, chunkStart, chunkEnd }) {
        const sourcePath = `${documentTitle} > ${programme.name} > ${section.title}`;
        await query(`
            INSERT INTO ccmas_programme_sections
                (document_id, document_title, discipline, programme_code, programme_name, degree,
                 section_key, section_title, content, content_hash, source_path,
                 authority_type, scope_label, status, chunk_start, chunk_end, extraction_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'regulator', 'NUC CCMAS national minimum', 'active', ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                document_title = VALUES(document_title),
                discipline = VALUES(discipline),
                programme_name = VALUES(programme_name),
                degree = VALUES(degree),
                section_title = VALUES(section_title),
                content = VALUES(content),
                content_hash = VALUES(content_hash),
                source_path = VALUES(source_path),
                status = 'active',
                chunk_start = VALUES(chunk_start),
                chunk_end = VALUES(chunk_end),
                updated_at = CURRENT_TIMESTAMP
        `, [
            documentId,
            documentTitle,
            programme.discipline,
            programme.code,
            programme.name,
            programme.degree,
            section.key,
            section.title,
            content,
            hashContent(content),
            sourcePath,
            chunkStart,
            chunkEnd,
            EXTRACTION_VERSION
        ]);
    }
}

module.exports = new CcmasProgrammeExtractorService();
module.exports.PROGRAMME_CATALOG = PROGRAMME_CATALOG;
module.exports.SECTION_DEFINITIONS = SECTION_DEFINITIONS;
