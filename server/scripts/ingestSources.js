/**
 * BMU Academic Content Ingestion
 * ================================
 *
 * Walks `sources/` and registers each file in the `documents` table:
 *   1. Copies the file into `uploads/documents/<uuid><ext>` (matches the
 *      runtime path convention).
 *   2. Inserts a `documents` row owned by the default superadmin.
 *   3. Extracts plain text via the inherited DocumentProcessor (PDF/DOCX/XLSX
 *      supported out of the box; .doc requires LibreOffice and is skipped
 *      with a warning if the converter isn't installed).
 *   4. Saves text via Document.updateContentText so FULLTEXT search works.
 *   5. Tries to chunk + embed via Ollama. If the embedding service is
 *      unreachable we DON'T fail the whole ingestion — the document is
 *      marked `pending` and an --embed-only run can finish it later.
 *
 * Re-running is idempotent: a file whose original name already exists in
 * `documents.title` is skipped unless `--force` is passed.
 *
 * Usage:
 *   node server/scripts/ingestSources.js              # full ingestion
 *   node server/scripts/ingestSources.js --extract-only  # text only, no embeddings
 *   node server/scripts/ingestSources.js --embed-only    # embeddings for pending docs
 *   node server/scripts/ingestSources.js --force         # re-ingest existing
 *   node server/scripts/ingestSources.js --status        # report current state
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { query } = require('../../config/db');
const Document = require('../models/Document');
const User = require('../models/User');
const documentProcessor = require('../services/documentProcessor');

const SOURCES_DIR = path.join(__dirname, '../../sources');
const UPLOADS_DIR = path.join(__dirname, '../../uploads/documents');
const SUPERADMIN_EMAIL = 'bmuapps@bmu.edu.ng';

// Filename → { category, tags, topic_hint } mapping. Best-effort; the LLM
// still grounds answers via FULLTEXT/RAG so this is mostly metadata.
const CATEGORY_RULES = [
    { match: /quick.?facts|cheat.?sheet/i,        category: 'general',       tags: ['authoritative', 'reference', 'cheat-sheet'] },
    { match: /calendar|timetable/i,                category: 'academic',      tags: ['calendar', 'dates'] },
    { match: /fees|payment|bursary|scholarship/i, category: 'administrative', tags: ['fees', 'payments'] },
    { match: /law|act|conduct|disciplin/i,        category: 'legal',          tags: ['conduct', 'legal'] },
    { match: /career|prospect/i,                   category: 'academic',       tags: ['career'] },
    { match: /handbook|prospectus/i,               category: 'academic',       tags: ['handbook', 'students'] },
    { match: /ccmas|guideline|mdcn|nuc/i,          category: 'regulation',     tags: ['curriculum', 'standards'] },
    { match: /course|programme/i,                  category: 'academic',       tags: ['programmes', 'courses'] },
    { match: /profile|brief/i,                     category: 'general',        tags: ['about'] }
];

function pickCategoryFor(name) {
    for (const r of CATEGORY_RULES) if (r.match.test(name)) return r;
    return { category: 'academic', tags: ['general'] };
}

function logHeader(text) {
    const bar = '─'.repeat(Math.max(text.length + 4, 60));
    console.log(`\n${bar}\n  ${text}\n${bar}`);
}

async function getSuperadminId() {
    const u = await User.findByEmail(SUPERADMIN_EMAIL);
    if (!u) throw new Error(`Superadmin ${SUPERADMIN_EMAIL} not found. Run npm run setup-db first.`);
    return u.id;
}

async function ensureDirs() {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}

async function listSources() {
    if (!fs.existsSync(SOURCES_DIR)) {
        throw new Error(`Sources directory not found: ${SOURCES_DIR}`);
    }
    const files = await fsp.readdir(SOURCES_DIR, { withFileTypes: true });
    return files
        .filter(d => d.isFile()
            && !d.name.startsWith('.')
            // Skip Microsoft Office owner-lock files (created while a file is
            // open in Word/Excel). They are 162-byte stubs that look like
            // real .docx/.xlsx files but are not valid zip archives, so
            // mammoth/xlsx fail with a "central directory" error and leave
            // a useless `failed` row in the documents table.
            && !d.name.startsWith('~$')
            // Word also leaves orphan ~WRL####.tmp recovery files in the
            // working directory after a crash; skip those too.
            && !/^~WRL\d+\.tmp$/i.test(d.name))
        .map(d => ({
            name: d.name,
            ext: path.extname(d.name).toLowerCase(),
            srcPath: path.join(SOURCES_DIR, d.name)
        }));
}

async function findExistingDoc(title) {
    const rows = await query(
        `SELECT id, embedding_status FROM documents WHERE title = ? AND is_active = TRUE LIMIT 1`,
        [title]
    );
    return rows[0] || null;
}

async function copyToUploads(srcPath, ext) {
    const uuid = crypto.randomUUID();
    const target = path.join(UPLOADS_DIR, `${uuid}${ext}`);
    await fsp.copyFile(srcPath, target);
    return target;
}

async function safeExtractText(filePath, ext) {
    try {
        return await documentProcessor.extractText(filePath, ext);
    } catch (err) {
        return { _error: err.message };
    }
}

/**
 * Some BMU spreadsheets store text with deliberate character-spacing for
 * visual styling — cell values come out as `B A Y E L S A   M E D I C A L`
 * or `3 7 0 , 0 0 0 . 0 0`. That breaks FULLTEXT matching ("MBBS" never
 * matches "M B B S") and makes numbers unreadable for the LLM.
 *
 * This is a two-pass normaliser:
 *   1. Collapse runs of 4+ single alphanumeric chars separated by single
 *      spaces back into a word ("M E D I C I N E" → "MEDICINE").
 *   2. Glue digits and punctuation back together inside numbers
 *      ("3 7 0 , 0 0 0 . 0 0" → "370,000.00") by collapsing single-character
 *      tokens that are digits or "."/"," with surrounding whitespace.
 */
function normaliseSpacedLetters(text) {
    if (!text) return text;
    let out = text;
    // Pass 1: collapse alpha runs (existing behaviour).
    out = out.replace(
        /(?:\b[A-Za-z0-9])(?:[\t ][A-Za-z0-9]){3,}\b/g,
        m => m.replace(/[\t ]/g, '')
    );
    // Pass 2: collapse number runs with embedded punctuation. Pattern: a
    // single digit, then 2+ repetitions of (space + (digit|,|.)). Captures
    // amounts like "3 7 0 , 0 0 0 . 0 0" and "5 , 0 0 0".
    out = out.replace(
        /\d(?:[\t ][\d,.])+(?:[\t ]\d)?/g,
        m => m.replace(/[\t ]/g, '')
    );
    return out;
}

async function safeEmbedChunks(documentId, text) {
    // Mirrors documentProcessor.processDocument() chunk loop, but tolerates
    // embedding failures so a flaky network doesn't poison the row.
    const aiService = require('../services/aiService');
    const DocumentChunk = require('../models/DocumentChunk');
    const vectorStore = require('../services/vectorStore');

    const chunkSize = Number(process.env.RAG_CHUNK_SIZE || 1000);
    const overlap  = Number(process.env.RAG_CHUNK_OVERLAP || 150);
    const chunks = await documentProcessor.chunkText(text, chunkSize, overlap);

    await DocumentChunk.deleteByDocumentId(documentId);

    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i];
        try {
            const embedding = await aiService.generateEmbedding(content);
            await DocumentChunk.insertChunk({ documentId, chunkIndex: i, content, embedding });
            try { await vectorStore.addChunk({ documentId, chunkIndex: i, content, embedding }); }
            catch (vsErr) { console.warn(`    [vector] chunk ${i}: ${vsErr.message}`); }
            embedded++;
            if (embedded % 5 === 0) process.stdout.write(`    ${embedded}/${chunks.length} chunks embedded\r`);
        } catch (err) {
            // Stop on first embedding failure — it's almost certainly the
            // embedding service being unreachable, no point hammering it.
            console.log(`    Embedding failed at chunk ${i}/${chunks.length}: ${err.message}`);
            return { embedded, total: chunks.length, error: err.message };
        }
    }
    if (embedded > 0) process.stdout.write(`    ${embedded}/${chunks.length} chunks embedded \n`);
    return { embedded, total: chunks.length };
}

async function ingestOne(file, opts = { force: false, extractOnly: false }) {
    const { name, ext, srcPath } = file;

    // 1. Skip unsupported extensions early
    const supported = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.rtf', '.md'];
    if (!supported.includes(ext)) {
        console.log(`  ⏭️  Skipping ${name} (unsupported extension ${ext})`);
        return { status: 'skipped', reason: 'unsupported' };
    }

    // 2. Idempotency: skip if already ingested unless --force
    const existing = await findExistingDoc(name);
    if (existing && !opts.force) {
        console.log(`  ✓  ${name} (already ingested, embedding_status=${existing.embedding_status}; --force to re-do)`);
        return { status: 'exists', documentId: existing.id, embedding_status: existing.embedding_status };
    }

    // 3. Copy into uploads/
    let copiedPath;
    try {
        copiedPath = await copyToUploads(srcPath, ext);
    } catch (err) {
        console.log(`  ❌ Copy failed for ${name}: ${err.message}`);
        return { status: 'failed', reason: 'copy', error: err.message };
    }

    // 4. Insert documents row
    const stat = await fsp.stat(copiedPath);
    const cat = pickCategoryFor(name);
    const documentId = await Document.create({
        title: name,
        description: `Imported from sources/ — ${cat.tags.join(', ')}`,
        fileName: path.basename(copiedPath),
        filePath: copiedPath,
        fileType: ext.replace('.', ''),
        fileSize: stat.size,
        category: cat.category,
        tags: cat.tags,
        uploadedBy: opts.uploaderId
    });
    await Document.updateEmbeddingStatus(documentId, 'processing');
    console.log(`  📄 ${name} → document #${documentId} [${cat.category}/${cat.tags.join(',')}]`);

    // 5. Extract text
    const extracted = await safeExtractText(copiedPath, ext);
    if (extracted?._error) {
        // Most likely cause: .doc without LibreOffice. Don't fail catastrophically.
        console.log(`     Extraction failed: ${extracted._error}`);
        await Document.updateEmbeddingStatus(documentId, 'failed');
        return { status: 'failed', documentId, reason: 'extract', error: extracted._error };
    }
    const text = normaliseSpacedLetters(String(extracted || '').trim());
    if (!text) {
        console.log(`     Extracted empty text; marking failed`);
        await Document.updateEmbeddingStatus(documentId, 'failed');
        return { status: 'failed', documentId, reason: 'empty_text' };
    }
    await Document.updateContentText(documentId, text);
    console.log(`     Text extracted (${text.length.toLocaleString()} chars)`);

    if (opts.extractOnly) {
        await Document.updateEmbeddingStatus(documentId, 'pending');
        return { status: 'pending', documentId, textLength: text.length };
    }

    // 6. Try embedding
    const emb = await safeEmbedChunks(documentId, text);
    if (emb.error) {
        await Document.updateEmbeddingStatus(documentId, 'pending');
        return { status: 'pending', documentId, textLength: text.length, embedding_error: emb.error };
    }
    await Document.updateEmbeddingStatus(documentId, 'completed', `doc_${documentId}`);
    return { status: 'completed', documentId, textLength: text.length, chunks: emb.total };
}

async function embedPending() {
    const rows = await query(
        `SELECT id, title FROM documents
         WHERE embedding_status IN ('pending','failed') AND is_active = TRUE
         ORDER BY id`
    );
    if (!rows.length) {
        console.log('  Nothing to embed — all documents are completed or in progress.');
        return;
    }
    console.log(`  Embedding ${rows.length} pending document(s)...`);
    for (const r of rows) {
        console.log(`\n  • ${r.title} (#${r.id})`);
        const text = (await query(`SELECT content_text FROM documents WHERE id = ?`, [r.id]))[0]?.content_text || '';
        if (!text) {
            console.log(`    No text content; skipping (re-ingest with --force).`);
            continue;
        }
        const emb = await safeEmbedChunks(r.id, text);
        if (emb.error) {
            console.log(`    Stopped: ${emb.error}`);
            console.log(`    (run again later when the embedding service is reachable)`);
            return;
        }
        await Document.updateEmbeddingStatus(r.id, 'completed', `doc_${r.id}`);
        console.log(`    ✅ ${emb.total} chunks indexed`);
    }
}

async function normaliseExistingContent() {
    const rows = await query(
        `SELECT id, title, content_text FROM documents WHERE is_active = TRUE AND content_text IS NOT NULL`
    );
    let touched = 0;
    for (const r of rows) {
        const before = r.content_text.length;
        const after = normaliseSpacedLetters(r.content_text);
        if (after.length !== before) {
            await Document.updateContentText(r.id, after);
            console.log(`  ✏️  ${r.title}  ${before} → ${after.length} chars`);
            touched++;
        }
    }
    console.log(`  ${touched} document(s) re-normalised, ${rows.length - touched} unchanged.`);
}

async function showStatus() {    const rows = await query(`
        SELECT embedding_status, COUNT(*) AS n, SUM(file_size) AS bytes
        FROM documents
        WHERE is_active = TRUE
        GROUP BY embedding_status
    `);
    const total = (await query(`SELECT COUNT(*) AS n FROM documents WHERE is_active=TRUE`))[0].n;
    console.log(`  Documents in DB: ${total}`);
    for (const r of rows) {
        console.log(`    ${r.embedding_status.padEnd(12)} ${String(r.n).padStart(3)} docs, ${(r.bytes/1024/1024).toFixed(2)} MB`);
    }
    const chunkCount = (await query(`SELECT COUNT(*) AS n FROM document_chunks`))[0].n;
    console.log(`  Chunks indexed: ${chunkCount}`);
    const sources = fs.existsSync(SOURCES_DIR) ? (await fsp.readdir(SOURCES_DIR)).filter(f => !f.startsWith('.')).length : 0;
    console.log(`  Files in sources/: ${sources}`);
}

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const extractOnly = args.includes('--extract-only');
    const embedOnly = args.includes('--embed-only');
    const statusOnly = args.includes('--status');
    const normaliseOnly = args.includes('--normalise');

    if (statusOnly) {
        logHeader('Ingestion status');
        await showStatus();
        process.exit(0);
    }

    if (normaliseOnly) {
        logHeader('Re-normalising character-spaced text in existing documents');
        await normaliseExistingContent();
        process.exit(0);
    }

    if (embedOnly) {
        logHeader('Embedding pending documents');
        await embedPending();
        await showStatus();
        process.exit(0);
    }

    logHeader(extractOnly ? 'Ingesting sources/ (text only)' : 'Ingesting sources/ (text + embeddings)');
    await ensureDirs();
    const uploaderId = await getSuperadminId();
    const files = await listSources();
    console.log(`  ${files.length} files found in sources/\n`);

    const results = [];
    for (const f of files) {
        const r = await ingestOne(f, { force, extractOnly, uploaderId });
        results.push({ name: f.name, ...r });
    }

    logHeader('Summary');
    const by = (s) => results.filter(r => r.status === s).length;
    console.log(`  ✅ completed:  ${by('completed')}`);
    console.log(`  ⏳ pending:    ${by('pending')} (text in DB; embeddings deferred)`);
    console.log(`  ✓  exists:     ${by('exists')}`);
    console.log(`  ❌ failed:     ${by('failed')}`);
    console.log(`  ⏭️  skipped:    ${by('skipped')}`);

    if (by('pending') > 0 && !extractOnly) {
        console.log(`\n  ℹ️  Embedding service was unreachable for some chunks.`);
        console.log(`     Run again later: node server/scripts/ingestSources.js --embed-only`);
    }

    await showStatus();
    process.exit(0);
}

main().catch(err => {
    console.error('\nFATAL:', err);
    process.exit(1);
});
