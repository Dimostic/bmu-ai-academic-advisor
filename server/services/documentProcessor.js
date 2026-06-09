const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const { execSync, exec } = require('child_process');
const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const aiService = require('./aiService');
const vectorStore = require('./vectorStore');

// Lazy-load LangChain for better text splitting
let _langchainService = null;
const USE_LANGCHAIN = process.env.USE_LANGCHAIN !== 'false';
function getLangChainService() {
    if (!_langchainService && USE_LANGCHAIN) {
        try {
            _langchainService = require('./langchainService');
        } catch (e) {
            console.warn('[DocumentProcessor] LangChain not available:', e.message);
        }
    }
    return _langchainService;
}

class DocumentProcessor {
    constructor() {
        // Check if OCR tools are available
        this.ocrAvailable = this._checkOcrAvailable();
        this.docConverter = this._detectDocConverter();
    }

    _checkOcrAvailable() {
        try {
            execSync('which tesseract', { stdio: 'ignore' });
            execSync('which pdftoppm', { stdio: 'ignore' });
            console.log('[DocumentProcessor] OCR tools available (tesseract + pdftoppm)');
            return true;
        } catch {
            console.log('[DocumentProcessor] OCR tools not available - scanned PDFs will not be processed');
            return false;
        }
    }

    _detectDocConverter() {
        const candidates = [
            { tool: 'soffice', type: 'libreoffice' },
            { tool: 'libreoffice', type: 'libreoffice' },
            { tool: 'antiword', type: 'antiword' },
            { tool: 'catdoc', type: 'catdoc' }
        ];

        for (const candidate of candidates) {
            try {
                execSync(`command -v ${candidate.tool}`, { stdio: 'ignore' });
                console.log(`[DocumentProcessor] DOC converter available (${candidate.tool})`);
                return candidate;
            } catch {
                // ignore
            }
        }

        console.log('[DocumentProcessor] DOC converter not available - .doc files will fail');
        return null;
    }

    _quoteShellArg(value) {
        return `"${String(value).replace(/"/g, '\\"')}"`;
    }

    async _convertDocToDocx(filePath) {
        if (!this.docConverter || this.docConverter.type !== 'libreoffice') {
            throw new Error('DOC conversion tool not available. Install LibreOffice to process .doc files.');
        }

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmu-doc-'));
        const safeFile = this._quoteShellArg(filePath);
        const safeOut = this._quoteShellArg(tempDir);

        execSync(
            `${this.docConverter.tool} --headless --convert-to docx --outdir ${safeOut} ${safeFile}`,
            { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
        );

        const baseName = path.basename(filePath, path.extname(filePath));
        let convertedPath = path.join(tempDir, `${baseName}.docx`);

        if (!fsSync.existsSync(convertedPath)) {
            const files = await fs.readdir(tempDir);
            const docxFile = files.find(file => file.toLowerCase().endsWith('.docx'));
            if (docxFile) {
                convertedPath = path.join(tempDir, docxFile);
            }
        }

        if (!fsSync.existsSync(convertedPath)) {
            throw new Error('DOC conversion failed to produce a DOCX file.');
        }

        return { convertedPath, tempDir };
    }

    async _extractDocTextWithTool(filePath, tool) {
        const safeFile = this._quoteShellArg(filePath);
        const output = execSync(`${tool} ${safeFile}`, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
        return output.toString();
    }

    async _cleanupTempDir(tempDir) {
        if (!tempDir) return;
        try {
            const files = await fs.readdir(tempDir);
            for (const file of files) {
                await fs.unlink(path.join(tempDir, file));
            }
            await fs.rmdir(tempDir);
        } catch (cleanupErr) {
            console.error('[DocumentProcessor] Cleanup error:', cleanupErr.message);
        }
    }

    _getPdfTextStats(text, pageCount, fileSizeBytes) {
        const raw = String(text || '');
        const nonWhitespaceCount = raw.replace(/\s+/g, '').length;
        const letterCount = (raw.match(/[A-Za-z]/g) || []).length;
        const digitCount = (raw.match(/[0-9]/g) || []).length;
        const pages = Math.max(1, Number(pageCount) || 1);
        const bytes = Number(fileSizeBytes) || 0;

        return {
            pageCount: pages,
            fileSizeBytes: bytes,
            fileSizeMB: bytes / (1024 * 1024),
            rawLength: raw.length,
            nonWhitespaceCount,
            letterCount,
            digitCount,
            charsPerPage: nonWhitespaceCount / pages,
            letterRatio: nonWhitespaceCount ? letterCount / nonWhitespaceCount : 0,
            digitRatio: nonWhitespaceCount ? digitCount / nonWhitespaceCount : 0,
            bytesPerChar: nonWhitespaceCount ? bytes / nonWhitespaceCount : 0
        };
    }

    _shouldOcrPdf(stats) {
        if (!stats || stats.nonWhitespaceCount === 0) {
            return { shouldOcr: true, score: 4, required: 1, largeFile: true };
        }

        const largeFile = stats.fileSizeMB >= 0.7 || stats.pageCount >= 3;
        let score = 0;

        if (stats.charsPerPage < 40) score += 1;
        if (stats.nonWhitespaceCount < 200) score += 1;
        if (stats.bytesPerChar > 2000) score += 1;
        if (stats.letterRatio < 0.35 && stats.nonWhitespaceCount > 100) score += 1;

        const required = largeFile ? 2 : 3;
        return { shouldOcr: score >= required, score, required, largeFile };
    }

    // Extract text from different file types
    async extractText(filePath, fileType) {
        try {
            const ext = path.extname(filePath).toLowerCase();
            let text = '';

            switch (ext) {
                case '.pdf':
                    text = await this.extractFromPDF(filePath);
                    break;
                case '.doc':
                case '.docx':
                    text = await this.extractFromWord(filePath);
                    break;
                case '.xls':
                case '.xlsx':
                    text = await this.extractFromExcel(filePath);
                    break;
                case '.txt':
                case '.csv':
                    text = await this.extractFromText(filePath);
                    break;
                case '.rtf':
                    text = await this.extractFromRTF(filePath);
                    break;
                default:
                    throw new Error(`Unsupported file type: ${ext}`);
            }

            return this.cleanText(text);
        } catch (error) {
            console.error('Text extraction error:', error.message);
            throw error;
        }
    }

    // Extract text from PDF (with OCR fallback for scanned documents)
    async extractFromPDF(filePath) {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);

        const stats = this._getPdfTextStats(data.text || '', data.numpages, dataBuffer.length);
        const decision = this._shouldOcrPdf(stats);

        if (!decision.shouldOcr) {
            console.log(`[DocumentProcessor] PDF text extraction OK: pages=${stats.pageCount}, chars=${stats.rawLength}, density=${stats.charsPerPage.toFixed(1)}/page, letterRatio=${stats.letterRatio.toFixed(2)}`);
            return data.text;
        }

        // Insufficient text - try OCR if available
        if (!this.ocrAvailable) {
            console.log('[DocumentProcessor] Scanned PDF detected but OCR not available');
            throw new Error('This appears to be a scanned PDF. OCR is not available on this server.');
        }

        console.log(`[DocumentProcessor] Scanned PDF detected (score ${decision.score}/${decision.required}, pages=${stats.pageCount}, chars=${stats.rawLength}, density=${stats.charsPerPage.toFixed(1)}/page, letterRatio=${stats.letterRatio.toFixed(2)}, size=${stats.fileSizeMB.toFixed(2)}MB), using OCR...`);
        return this.extractFromPDFWithOCR(filePath, data.numpages);
    }

    // Extract text from scanned PDF using OCR
    async extractFromPDFWithOCR(filePath, numPages) {
        const tempDir = path.join(path.dirname(filePath), '../temp', `ocr_${Date.now()}`);
        
        try {
            // Create temp directory
            await fs.mkdir(tempDir, { recursive: true });
            
            console.log(`[DocumentProcessor] Starting OCR for ${numPages} pages...`);
            
            // Convert PDF to images using pdftoppm
            const pdfBaseName = path.join(tempDir, 'page');
            execSync(`pdftoppm -png -r 300 "${filePath}" "${pdfBaseName}"`, { 
                timeout: 300000,  // 5 minutes timeout
                maxBuffer: 50 * 1024 * 1024  // 50MB buffer
            });
            
            // Get all generated images
            const files = await fs.readdir(tempDir);
            const imageFiles = files.filter(f => f.endsWith('.png')).sort();
            
            console.log(`[DocumentProcessor] Converted to ${imageFiles.length} images, running OCR...`);
            
            let fullText = '';
            
            // Run OCR on each page
            for (let i = 0; i < imageFiles.length; i++) {
                const imagePath = path.join(tempDir, imageFiles[i]);
                try {
                    const pageText = execSync(`tesseract "${imagePath}" stdout -l eng`, {
                        timeout: 60000,  // 1 minute per page
                        maxBuffer: 10 * 1024 * 1024
                    }).toString();
                    fullText += `\n--- Page ${i + 1} ---\n${pageText}`;
                    
                    // Log progress every 5 pages
                    if ((i + 1) % 5 === 0) {
                        console.log(`[DocumentProcessor] OCR progress: ${i + 1}/${imageFiles.length} pages`);
                    }
                } catch (ocrErr) {
                    console.error(`[DocumentProcessor] OCR failed for page ${i + 1}:`, ocrErr.message);
                }
            }
            
            console.log(`[DocumentProcessor] OCR complete: extracted ${fullText.length} chars from ${imageFiles.length} pages`);
            
            return fullText;
            
        } finally {
            // Cleanup temp directory
            try {
                const files = await fs.readdir(tempDir);
                for (const file of files) {
                    await fs.unlink(path.join(tempDir, file));
                }
                await fs.rmdir(tempDir);
            } catch (cleanupErr) {
                console.error('[DocumentProcessor] Cleanup error:', cleanupErr.message);
            }
        }
    }

    // Extract text from Word documents
    async extractFromWord(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.doc') {
            if (this.docConverter?.type === 'antiword' || this.docConverter?.type === 'catdoc') {
                return this._extractDocTextWithTool(filePath, this.docConverter.tool);
            }
            if (this.docConverter?.type === 'libreoffice') {
                const { convertedPath, tempDir } = await this._convertDocToDocx(filePath);
                try {
                    return await this.extractFromWord(convertedPath);
                } finally {
                    await this._cleanupTempDir(tempDir);
                }
            }
            throw new Error('No DOC conversion tool available. Install LibreOffice or antiword to process .doc files.');
        }
        const dataBuffer = await fs.readFile(filePath);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        return result.value;
    }

    // Extract HTML from Word documents (preserves structure)
    async extractHtmlFromWord(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.doc') {
            if (!this.docConverter || this.docConverter.type !== 'libreoffice') {
                throw new Error('DOC HTML conversion requires LibreOffice.');
            }
            const { convertedPath, tempDir } = await this._convertDocToDocx(filePath);
            try {
                return await this.extractHtmlFromWord(convertedPath);
            } finally {
                await this._cleanupTempDir(tempDir);
            }
        }
        const dataBuffer = await fs.readFile(filePath);
        const result = await mammoth.convertToHtml({ buffer: dataBuffer });
        return result.value;
    }

    // Extract text from Excel files
    async extractFromExcel(filePath) {
        const workbook = xlsx.readFile(filePath);
        let text = '';

        workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const sheetText = xlsx.utils.sheet_to_txt(sheet);
            text += `\n--- Sheet: ${sheetName} ---\n${sheetText}`;
        });

        return text;
    }

    // Extract text from plain text files
    async extractFromText(filePath) {
        return fs.readFile(filePath, 'utf8');
    }

    // Extract text from RTF (basic extraction)
    async extractFromRTF(filePath) {
        const content = await fs.readFile(filePath, 'utf8');
        // Basic RTF stripping - removes RTF control words
        return content
            .replace(/\\[a-z]+\d* ?/gi, '')
            .replace(/[{}]/g, '')
            .replace(/\\'[0-9a-f]{2}/gi, '')
            .trim();
    }

    // Clean and normalize extracted text
    cleanText(text) {
        return text
            .replace(/\r\n/g, '\n')           // Normalize line endings
            .replace(/\n{3,}/g, '\n\n')       // Remove excessive newlines
            .replace(/\s{2,}/g, ' ')          // Remove excessive spaces
            .replace(/[^\x20-\x7E\n]/g, ' ')  // Remove non-printable characters
            .trim();
    }

    _normalizeLine(line) {
        return String(line || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _isHeadingLine(line) {
        const trimmed = this._normalizeLine(line);
        if (!trimmed || trimmed.length < 3 || trimmed.length > 120) return false;
        if (/^\d+$/.test(trimmed)) return false;

        const patterns = [
            /^(CHAPTER|PART|SECTION|ARTICLE|SCHEDULE)\s+[IVXLCDM\d]+/i,
            /^(EXECUTIVE SUMMARY|SUMMARY|HIGHLIGHTS|KEY POINTS|RECOMMENDATIONS|CONCERNS|FINDINGS|BACKGROUND|INTRODUCTION|CONCLUSION|APPENDIX|ANNEX|ATTACHMENT)\b/i,
            /^[A-Z][A-Z\s,]{8,80}$/,
            /^\d+(\.\d+)*\s+[A-Z]/
        ];

        return patterns.some((pattern) => pattern.test(trimmed));
    }

    _extractHeadings(text) {
        const headings = [];
        let offset = 0;
        const lines = String(text || '').split('\n');

        for (const line of lines) {
            const trimmed = this._normalizeLine(line);
            if (trimmed && this._isHeadingLine(trimmed)) {
                headings.push({ title: trimmed, index: offset });
            }
            offset += line.length + 1;
        }

        return headings;
    }

    _injectHeadingContext(chunks, headings, fullText, overlap = 0) {
        if (!headings || headings.length === 0) return chunks;

        let cursor = 0;
        let headingIndex = 0;
        let currentHeading = null;

        return chunks.map((chunk) => {
            const chunkText = String(chunk || '');
            const snippet = chunkText.substring(0, 120);

            let chunkStart = -1;
            if (snippet) {
                const searchStart = Math.max(0, cursor - overlap);
                chunkStart = fullText.indexOf(snippet, searchStart);
                if (chunkStart === -1) {
                    chunkStart = fullText.indexOf(snippet);
                }
            }

            if (chunkStart < 0) {
                chunkStart = cursor;
            }

            cursor = Math.max(chunkStart, 0) + Math.max(1, chunkText.length - overlap);

            while (headingIndex < headings.length && headings[headingIndex].index <= chunkStart) {
                currentHeading = headings[headingIndex];
                headingIndex += 1;
            }

            const headingTitle = currentHeading?.title;
            if (!headingTitle) return chunkText;

            const trimmedChunk = chunkText.trimStart();
            if (/^Section:\s+/i.test(trimmedChunk)) return chunkText;

            const normalizedHeading = this._normalizeLine(headingTitle);
            const normalizedStart = this._normalizeLine(trimmedChunk.substring(0, normalizedHeading.length + 5));
            if (normalizedStart.startsWith(normalizedHeading)) {
                return chunkText;
            }

            return `Section: ${headingTitle}\n${chunkText}`;
        });
    }

    // Process a document for training
    async processDocument(documentId) {
        try {
            // Update status to processing
            await Document.updateEmbeddingStatus(documentId, 'processing');

            const doc = await Document.findById(documentId);
            if (!doc) {
                throw new Error('Document not found');
            }

            // Extract text
            const text = await this.extractText(doc.file_path, doc.file_type);

            if (!text || text.length < 50) {
                throw new Error('Insufficient text extracted from document');
            }

            // Extract HTML for Word documents (preserves formatting)
            let html = null;
            const ext = path.extname(doc.file_path).toLowerCase();
            if (ext === '.doc' || ext === '.docx') {
                try {
                    html = await this.extractHtmlFromWord(doc.file_path);
                    console.log(`[DocumentProcessor] Extracted HTML (${html?.length || 0} chars) for document ${documentId}`);
                } catch (htmlErr) {
                    console.error('[DocumentProcessor] HTML extraction failed:', htmlErr.message);
                }
            }

            // Update document with extracted content
            if (html) {
                await Document.updateContent(documentId, text, html);
            } else {
                await Document.updateContentText(documentId, text);
            }

            // (RAG) Chunk + embed + store in DB and FAISS
            const chunks = await this.chunkText(text, Number(process.env.RAG_CHUNK_SIZE || 1000), Number(process.env.RAG_CHUNK_OVERLAP || 150));
            await DocumentChunk.deleteByDocumentId(documentId);

            for (let i = 0; i < chunks.length; i++) {
                const content = chunks[i];
                const embedding = await aiService.generateEmbedding(content);
                await DocumentChunk.insertChunk({ documentId, chunkIndex: i, content, embedding });
                await vectorStore.addChunk({ documentId, chunkIndex: i, content, embedding });
            }

            // Update status to completed
            await Document.updateEmbeddingStatus(documentId, 'completed', `doc_${documentId}`);

            // AUTO-GENERATE FAQ: Trigger FAQ generation in background after document processing
            try {
                const faqService = require('./faqService');
                // Run FAQ generation asynchronously (don't await, let it run in background)
                faqService.autoGenerateForDocument(documentId)
                    .then(result => {
                        if (result && !result.skipped) {
                            console.log(`[DocumentProcessor] FAQ auto-generation started for document ${documentId}`);
                        }
                    })
                    .catch(faqErr => {
                        console.error(`[DocumentProcessor] FAQ auto-generation failed for document ${documentId}:`, faqErr.message);
                    });
            } catch (faqInitError) {
                console.error('[DocumentProcessor] Could not initialize FAQ service:', faqInitError.message);
            }

            return {
                success: true,
                documentId,
                textLength: text.length,
                htmlLength: html?.length || 0,
                chunksCreated: chunks.length,
                message: 'Document processed successfully. FAQ generation started in background.'
            };

        } catch (error) {
            console.error('Document processing error:', error.message);
            
            // Update status to failed
            await Document.updateEmbeddingStatus(documentId, 'failed');

            return {
                success: false,
                documentId,
                error: error.message
            };
        }
    }

    // Process all pending documents
    async processAllPending() {
        const pendingDocs = await Document.getPendingTraining();
        const results = [];

        for (const doc of pendingDocs) {
            const result = await this.processDocument(doc.id);
            results.push(result);
            
            // Small delay to prevent overwhelming the system
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return {
            processed: results.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            details: results
        };
    }

    // Chunk text for better embedding (uses LangChain if available)
    async chunkText(text, maxChunkSize = 1000, overlap = 100, options = {}) {
        const includeHeadingContext = options.includeHeadingContext !== false;
        // Try LangChain's RecursiveCharacterTextSplitter first (better quality)
        const langChain = getLangChainService();
        if (langChain) {
            try {
                let chunks = await langChain.splitText(text, {
                    chunkSize: maxChunkSize,
                    chunkOverlap: overlap
                });
                console.log(`[DocumentProcessor] LangChain split: ${chunks.length} chunks`);
                chunks = chunks.filter(chunk => chunk.length > 50);
                if (!includeHeadingContext) return chunks;

                const headings = this._extractHeadings(text);
                return this._injectHeadingContext(chunks, headings, text, overlap);
            } catch (e) {
                console.warn('[DocumentProcessor] LangChain split failed, using fallback:', e.message);
            }
        }
        
        // Fallback to simple chunking
        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = start + maxChunkSize;
            
            // Try to end at a sentence or paragraph boundary
            if (end < text.length) {
                const lastPeriod = text.lastIndexOf('.', end);
                const lastNewline = text.lastIndexOf('\n', end);
                const boundary = Math.max(lastPeriod, lastNewline);
                
                if (boundary > start + maxChunkSize / 2) {
                    end = boundary + 1;
                }
            }

            chunks.push(text.substring(start, end).trim());
            start = end - overlap;
        }

        const filtered = chunks.filter(chunk => chunk.length > 50);
        if (!includeHeadingContext) return filtered;
        const headings = this._extractHeadings(text);
        return this._injectHeadingContext(filtered, headings, text, overlap);
    }

    // Get document statistics
    async getProcessingStats() {
        return Document.getStats();
    }
}

module.exports = new DocumentProcessor();
