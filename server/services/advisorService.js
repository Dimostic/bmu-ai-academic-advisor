/**
 * Academic-advisor orchestrator.
 *
 * Flow:
 *   1. Look up / create the student's conversation.
 *   2. Pull recent message history + (optionally) RAG context from BMU docs.
 *   3. Call the LLM with the advisor persona + structured-output system prompt.
 *   4. Parse the structured reply; persist both the student question and the
 *      advisor reply (including suggested actions, citations, follow-ups).
 *   5. Generate TTS audio for `speech_text` (TTSMaker or browser fallback).
 *
 * Returns a single payload the frontend can render directly.
 */
const Advisor = require('../models/Advisor');
const llm = require('./llmClient');
const persona = require('./advisorPersonaService');
const tts = require('./ttsService');
const responseQualityService = require('./responseQualityService');

let faqService = null;
try { faqService = require('./faqService'); }
catch (_) { /* optional */ }

const HISTORY_TURNS = parseInt(process.env.ADVISOR_HISTORY_TURNS || '8', 10);
const RAG_ENABLED   = process.env.ENABLE_RAG !== 'false';
const RAG_TIMEOUT_MS = parseInt(process.env.ADVISOR_RAG_TIMEOUT_MS || '4000', 10);
const KEYWORD_FALLBACK_LIMIT = parseInt(process.env.ADVISOR_KEYWORD_FALLBACK_LIMIT || '4', 10);
const PRIMARY_SOURCE_PATTERN = (process.env.ADVISOR_PRIMARY_SOURCE_PATTERN || 'quick facts').toLowerCase();
const PRIMARY_SOURCE_BOOST   = parseFloat(process.env.ADVISOR_PRIMARY_SOURCE_BOOST || '1.20');
const SUGGESTION_MIN_CONFIDENCE = parseFloat(process.env.ADVISOR_SUGGESTION_MIN_CONFIDENCE || '0.30');

let retrievalService = null;
try { retrievalService = require('./retrievalService'); }
catch (err) { console.warn('[advisorService] retrievalService unavailable:', err.message); }

const { query } = require('../../config/db');

const OFFICE_HOLDER_DOC_TITLE = '%profile of bmu%';

async function _getProfileDocumentContent() {
    try {
        const rows = await query(
            `SELECT id, title, category, content_text
             FROM documents
             WHERE is_active = TRUE
               AND content_text IS NOT NULL
               AND LOWER(title) LIKE ?
             ORDER BY id DESC
             LIMIT 1`,
            [OFFICE_HOLDER_DOC_TITLE]
        );

        return rows[0] || null;
    } catch (err) {
        console.warn('[advisorService] _getProfileDocumentContent error:', err.message);
        return null;
    }
}

function _extractOfficeHolderFromProfileDoc(roleLabel, profileText) {
    const text = String(profileText || '').replace(/<[^>]+>/g, ' ');
    if (!text.trim()) return null;

    const normalizedRole = String(roleLabel || '').trim().toLowerCase();
    const rolePatterns = {
        'registrar': /^\s*registrar\s*[:\-]\s*([^\r\n]{3,160})/im,
        'vice-chancellor': /^\s*vice[-\s]?chancellor\s*[:\-]\s*([^\r\n]{3,160})/im,
        'bursar': /^\s*bursar\s*[:\-]\s*([^\r\n]{3,160})/im,
        'dean': /^\s*dean\s*[:\-]\s*([^\r\n]{3,160})/im,
        'chancellor': /^\s*chancellor\s*[:\-]\s*([^\r\n]{3,160})/im,
        'librarian': /^\s*(?:university\s+)?librarian\s*[:\-]\s*([^\r\n]{3,160})/im
    };

    const re = rolePatterns[normalizedRole];
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (re) {
        const line = lines.find(entry => re.test(entry));
        if (line) {
            const match = line.match(re);
            if (match && match[1]) {
                const raw = String(match[1]).replace(/\s+/g, ' ').trim();
                const candidate = raw.replace(/[,;.]+$/, '').trim();
                if (candidate) return candidate;
            }
        }
    }

    const roleTokenMap = {
        'vice-chancellor': /vice[-\s]?chancellor|\bvc\b/i,
        'registrar': /\bregistrar\b/i,
        'bursar': /\bbursar\b/i,
        'dean': /\bdean\b/i,
        'chancellor': /\bchancellor\b/i,
        'librarian': /university\s+librarian|\blibrarian\b/i
    };
    const roleToken = roleTokenMap[normalizedRole];
    if (!roleToken) return null;

    const nameLike = /\b(?:prof(?:essor)?\.?|dr\.?|mr\.?|mrs\.?|ms\.?|miss|pharm\.?|arc\.?|engr\.?|chief|alh\.?|pastor)\b/i;
    const obviousNoise = /^(role|office|position|designation|department|faculty|school|unit)\b/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!roleToken.test(line)) continue;

        const sameLine = line
            .replace(roleToken, '')
            .replace(/^\s*[:\-–]+\s*/, '')
            .trim()
            .replace(/[,;.]+$/, '')
            .trim();

        if (sameLine && !obviousNoise.test(sameLine) && /[a-z]/i.test(sameLine)) {
            if (sameLine.length >= 4 && (nameLike.test(sameLine) || /^[A-Z][A-Za-z\s.'-]{3,}$/.test(sameLine))) {
                return sameLine;
            }
        }

        for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
            const nextLine = String(lines[j] || '').trim().replace(/[,;.]+$/, '').trim();
            if (!nextLine || obviousNoise.test(nextLine)) continue;
            if (nameLike.test(nextLine) || /^[A-Z][A-Za-z\s.'-]{3,}$/.test(nextLine)) {
                return nextLine;
            }
        }
    }

    return null;
}

function _isSpecificProgrammeCourseQuery(question) {
    const q = String(question || '').toLowerCase();
    if (!/(course|courses|curriculum|units?)/i.test(q)) return false;

    // Generic "courses offered at BMU" should map to programme listings.
    if (/(all\s+courses|courses\s+offered|offer\w*\s+courses|list\s+courses)/i.test(q)
        && !/(in|for|under|within)\s+(the\s+)?(department|faculty|school|programme|program|discipline)/i.test(q)) {
        return false;
    }

    // Specific scope (department/faculty/programme/discipline/level) means
    // student-course level listing is expected.
    if (/(in|for|under|within)\s+(the\s+)?(department|faculty|school|programme|program|discipline)/i.test(q)) return true;
    if (/\b(100|200|300|400|500|600)\s*level\b/i.test(q)) return true;
    if (/\b(medicine|nursing|pharmacy|anatomy|physiology|biochemistry|medical\s+laboratory|mls|public\s+health|radiography|dentistry)\b/i.test(q)) return true;

    return false;
}

async function _resolvePriorityDocumentIds(question) {
    try {
        const q = String(question || '').toLowerCase();
        const patterns = [];
        const isSpecificCourseQuery = _isSpecificProgrammeCourseQuery(q);
        const isGenericCoursesAsProgrammes = /(course|courses)/i.test(q) && !isSpecificCourseQuery;

        // Fees should anchor to BMU fee structure.
        if (/(fee|fees|tuition|cost|payment|indigene|non[-\s]?indigene)/i.test(q)) {
            patterns.push('%fee structure%');
            patterns.push('%fees%');
        }
        // Only specific discipline/programme course queries should anchor to Student Courses doc.
        if (isSpecificCourseQuery || /(department|departments|faculty|faculties)/i.test(q)) {
            patterns.push('%student courses%');
            patterns.push('%course%');
        }
        // "Courses offered" and "programmes" are treated as synonyms by default.
        if (/(programme|programmes|program|profile|about bmu|bmu profile)/i.test(q) || isGenericCoursesAsProgrammes) {
            patterns.push('%brief profile%');
            patterns.push('%profile%');
            patterns.push('%programme%');
            patterns.push('%programmes%');
        }
        // Office-holder identity questions should prioritize profile/governance docs.
        if (/(who\s+is|name\s+of|current)/i.test(q) && /(registrar|vice[-\s]?chancellor|\bvc\b|bursar|dean|chancellor)/i.test(q)) {
            patterns.push('%profile of bmu%');
            patterns.push('%profile%');
            patterns.push('%management%');
            patterns.push('%principal officers%');
            patterns.push('%governance%');
            patterns.push('%quick facts%');
        }

        const unique = [...new Set(patterns)];
        if (!unique.length) return [];

        const where = unique.map(() => 'LOWER(title) LIKE ?').join(' OR ');
        const rows = await query(
            `SELECT id, title
             FROM documents
             WHERE is_active = TRUE
               AND (${where})
             ORDER BY id DESC
             LIMIT 12`,
            unique
        );

        return rows.map(r => r.id).filter(Boolean);
    } catch (err) {
        console.warn('[advisorService] priority document lookup failed:', err.message);
        return [];
    }
}

function _isOfficeHolderIdentityQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /(who\s+is|name\s+of|current)/i.test(q)
    && /(registrar|vice[-\s]?chancellor|\bvc\b|bursar|dean|chancellor|librarian|university\s+librarian)/i.test(q);
}

async function _getOfficeHolderDocumentContext(question) {
    try {
        const q = String(question || '').toLowerCase();
        const roleLabel = _detectOfficeRoleLabel(q);
        const roleNeedleMap = {
            'Vice-Chancellor': /vice[-\s]?chancellor|\bvc\b/i,
            'Registrar': /\bregistrar\b/i,
            'Bursar': /\bbursar\b/i,
            'Dean': /\bdean\b/i,
            'Chancellor': /\bchancellor\b/i,
            'Librarian': /university\s+librarian|\blibrarian\b/i
        };
        const needle = roleNeedleMap[roleLabel];

        const profileDoc = await _getProfileDocumentContent();
        const docCandidates = [];
        if (profileDoc) docCandidates.push(profileDoc);

        // Broaden the search beyond one title, because officer sections can
        // live in profile/governance docs with different names.
        const rows = await query(
            `SELECT id, title, category, content_text
             FROM documents
             WHERE is_active = TRUE
               AND content_text IS NOT NULL
               AND (
                    LOWER(title) LIKE '%profile%'
                 OR LOWER(title) LIKE '%brief%'
                 OR LOWER(title) LIKE '%management%'
                 OR LOWER(title) LIKE '%principal%'
                 OR LOWER(title) LIKE '%governance%'
               )
             ORDER BY id DESC
             LIMIT 20`
        );
        for (const row of rows) {
            if (!docCandidates.some(d => d.id === row.id)) docCandidates.push(row);
        }

        for (const doc of docCandidates) {
            const roleName = _extractOfficeHolderFromProfileDoc(roleLabel, doc.content_text);
            if (roleName) {
                return `--- ${doc.title || 'Profile of BMU'} (${doc.category || 'general'}) ---\n${roleLabel}: ${roleName}`;
            }
        }

        const snippetDoc = docCandidates[0];
        if (!snippetDoc) return '';
        const fullText = String(snippetDoc.content_text || '').replace(/<[^>]+>/g, ' ');
        if (needle && fullText) {
            const lower = fullText.toLowerCase();
            const roleText = String(needle).replace(/^\//, '').replace(/\/[a-z]*$/i, '');
            const roleWords = roleText
                .split('|')
                .map(s => s.replace(/[^a-z\s-]/gi, '').trim())
                .filter(Boolean)
                .sort((a, b) => b.length - a.length);

            let idx = -1;
            for (const w of roleWords) {
                idx = lower.indexOf(w.toLowerCase());
                if (idx >= 0) break;
            }

            if (idx >= 0) {
                const start = Math.max(0, idx - 400);
                const end = Math.min(fullText.length, idx + 1800);
                const snippet = fullText.slice(start, end).trim();
                if (snippet) {
                    return `--- ${snippetDoc.title || 'Profile of BMU'} (${snippetDoc.category || 'general'}) ---\n${snippet}`;
                }
            }
        }

        return `--- ${snippetDoc.title || 'Profile of BMU'} (${snippetDoc.category || 'general'}) ---\n${fullText.slice(0, 2400).trim()}`;
    } catch (err) {
        console.warn('[advisorService] _getOfficeHolderDocumentContext error:', err.message);
        return '';
    }
}

function _detectOfficeRoleLabel(question) {
    const q = String(question || '').toLowerCase();
    if (/vice[-\s]?chancellor|\bvc\b/.test(q)) return 'Vice-Chancellor';
    if (/registrar/.test(q)) return 'Registrar';
    if (/bursar/.test(q)) return 'Bursar';
    if (/dean/.test(q)) return 'Dean';
    if (/chancellor/.test(q)) return 'Chancellor';
    if (/librarian|university\s+librarian/.test(q)) return 'Librarian';
    return 'office holder';
}

function _extractRoleNameFromContext(roleLabel, ragContext) {
    const text = String(ragContext || '');
    if (!text.trim()) return null;

    const patterns = {
        'Vice-Chancellor': /^\s*(?:current\s+)?vice[-\s]?chancellor\s*[:\-]\s*([^\n\r;]{3,120})/im,
        'Registrar': /^\s*registrar\s*[:\-]\s*([^\n\r;]{3,120})/im,
        'Bursar': /^\s*bursar\s*[:\-]\s*([^\n\r;]{3,120})/im,
        'Dean': /^\s*dean\s*[:\-]\s*([^\n\r;]{3,120})/im,
        'Chancellor': /^\s*chancellor\s*[:\-]\s*([^\n\r;]{3,120})/im,
        'Librarian': /^\s*(?:university\s+)?librarian\s*[:\-]\s*([^\n\r;]{3,120})/im
    };

    const re = patterns[roleLabel];
    if (!re) return null;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const line = lines.find(entry => re.test(entry));
    if (!line) return null;
    const m = line.match(re);
    if (!m || !m[1]) return null;

    const candidate = String(m[1]).replace(/\s+/g, ' ').trim().replace(/[,;.]+$/, '').trim();
    if (candidate.length < 4) return null;
    if (!/[a-z]/i.test(candidate)) return null;
    return candidate;
}

function _extractCitationsFromContext(ragContext) {
    const text = String(ragContext || '');
    const titles = [...text.matchAll(/---\s*(.+?)\s*\([^\)]*\)\s*---/g)]
        .map(m => String(m[1] || '').trim())
        .filter(Boolean);
    return [...new Set(titles)].slice(0, 3).map(title => ({ title, source: 'BMU document context' }));
}

function _buildOfficeHolderSafeReply(question, ragContext) {
    const roleLabel = _detectOfficeRoleLabel(question);
    const extractedName = _extractRoleNameFromContext(roleLabel, ragContext);
    const citations = _extractCitationsFromContext(ragContext);

    if (extractedName) {
        const answer = `The ${roleLabel} of Bayelsa Medical University (BMU) is ${extractedName}.`;
        return {
            speech_text: answer,
            display_markdown: answer,
            topic_slug: null,
            citations,
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.92
        };
    }

    if (roleLabel === 'Registrar') {
        return {
            speech_text: 'The registrar information I have is not verified from the BMU profile document right now. Please check the official profile document or ask me to search that document directly.',
            display_markdown: 'The registrar information I have is not verified from the BMU profile document right now.\n\nPlease check the official profile document or ask me to search that document directly.',
            topic_slug: null,
            citations,
            suggested_actions: [{ label: 'Search the BMU profile document', action: 'search_profile_doc' }],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.4
        };
    }

    return {
        speech_text: `I do not have a verified BMU document line naming the current ${roleLabel.toLowerCase()} right now. I can connect you to a human advisor for confirmation.`,
        display_markdown: `I do not have a verified BMU document line naming the current ${roleLabel.toLowerCase()} right now.\n\nI can connect you to a human advisor for confirmation.`,
        topic_slug: null,
        citations,
        suggested_actions: [{ label: 'Connect me to a human advisor', action: 'escalate_to_human' }],
        follow_up_questions: [],
        needs_escalation: true,
        confidence: 0.35
    };
}

function _mergeContexts(parts) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        if (!part || typeof part !== 'string') continue;
        for (const block of part.split(/\n\n+/g)) {
            const b = block.trim();
            if (b.length < 20) continue;
            if (seen.has(b)) continue;
            seen.add(b);
            out.push(b);
        }
    }
    return out.join('\n\n').slice(0, 12000);
}

function _isAlwaysAllowedAction(action) {
    return action === 'escalate_to_human'
        || action === 'start_study_plan'
        || (typeof action === 'string' && action.startsWith('open_url:'));
}

async function _isRetrievableQuestion(text) {
    if (!retrievalService) return true;
    const q = String(text || '').trim();
    if (!q || q.length < 5) return false;
    try {
        const r = await retrievalService.retrieve(q, { limit: 1, skipCache: true });
        return Boolean(r?.context) && Number(r?.confidence || 0) >= SUGGESTION_MIN_CONFIDENCE;
    } catch (_) {
        return false;
    }
}

async function _sanitizeInteractiveSuggestions(parsed) {
    if (!parsed) return parsed;

    const actions = Array.isArray(parsed.suggested_actions) ? parsed.suggested_actions : [];
    const followups = Array.isArray(parsed.follow_up_questions) ? parsed.follow_up_questions : [];

    const actionChecks = await Promise.all(actions.map(async (a) => {
        if (!a || typeof a.label !== 'string') return null;
        if (_isAlwaysAllowedAction(a.action)) return a;
        const ok = await _isRetrievableQuestion(a.label);
        return ok ? a : null;
    }));

    const followChecks = await Promise.all(followups.map(async (q) => {
        const ok = await _isRetrievableQuestion(q);
        return ok ? q : null;
    }));

    return {
        ...parsed,
        suggested_actions: actionChecks.filter(Boolean).slice(0, 6),
        follow_up_questions: followChecks.filter(Boolean).slice(0, 4)
    };
}

async function _keywordFallback(question) {
    try {
        const q = String(question).slice(0, 200);
        // Boost the Students' Handbook so it wins ties; see
        // advisorStreamService._keywordFallback for the rationale.
        const titleLike = `%${PRIMARY_SOURCE_PATTERN}%`;
        const rows = await query(
            `SELECT id, title, category, content_text,
                    ((MATCH(title, description) AGAINST(? IN NATURAL LANGUAGE MODE) * 5)
                  +   MATCH(title, description, content_text) AGAINST(? IN NATURAL LANGUAGE MODE))
                  *  CASE WHEN LOWER(title) LIKE ? THEN ? ELSE 1 END
                    AS score,
                    CASE WHEN LOWER(title) LIKE ? THEN 1 ELSE 0 END AS is_primary
             FROM documents
             WHERE is_active = TRUE AND content_text IS NOT NULL
             HAVING score > 0
             ORDER BY is_primary DESC, score DESC LIMIT ?`,
            [q, q, titleLike, PRIMARY_SOURCE_BOOST, titleLike, KEYWORD_FALLBACK_LIMIT]
        );
        if (!rows.length) return '';
        const SNIPPET_BEFORE = 200, SNIPPET_AFTER = 1600, WINDOW = SNIPPET_BEFORE + SNIPPET_AFTER, STEP = 400;
        const stopwords = new Set(['what','when','where','which','about','their','this','that','with','have','been','they','will','into','from','your','there','these','those','please','tell','should','would','could']);
        const terms = [...new Set((q.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter(w => !stopwords.has(w)))];
        const snippetFor = text => {
            const lower = text.toLowerCase();
            if (!terms.length) return text.slice(0, WINDOW);
            let bestOffset = 0, bestScore = -1;
            for (let off = 0; off < lower.length; off += STEP) {
                const slice = lower.slice(off, off + WINDOW);
                let hits = 0;
                for (const t of terms) if (slice.includes(t)) hits++;
                if (hits > bestScore) { bestScore = hits; bestOffset = off; }
            }
            if (bestScore <= 0) return text.slice(0, WINDOW);
            const start = Math.max(0, bestOffset - SNIPPET_BEFORE);
            const end = Math.min(text.length, bestOffset + WINDOW);
            return (start > 0 ? '… ' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? ' …' : '');
        };
        return rows.map(r =>
            `--- ${r.title} (${r.category || 'general'}) ---\n${snippetFor(r.content_text || '')}`
        ).join('\n\n');
    } catch (err) {
        console.warn('[advisorService] keyword fallback failed:', err.message);
        return '';
    }
}

/**
 * Force retrieval of fee/financial documents for fee-related questions.
 * Searches by content keywords to guarantee financial information is included.
 */
async function _getFeeDocumentContext(question) {
    try {
        // Search for documents containing financial keywords
        const financialKeywords = ['fee', 'fees', 'tuition', 'payment', 'scholarship', 
                                   'bursary', 'bursar', 'finance', 'cost', 'charge', 
                                   'levy', 'tariff', 'financial', 'indigene', 'non-indigene',
                                   'programme fee', 'course fee', 'acceptance fee'];
        
        // Build a FULLTEXT search that looks for any financial keyword
        const searchQuery = financialKeywords.join(' ');
        
        const docs = await query(
            `SELECT id, title, category, content_text
             FROM documents
             WHERE is_active = TRUE
               AND content_text IS NOT NULL
               AND (
                   MATCH(content_text) AGAINST(? IN BOOLEAN MODE)
                   OR MATCH(title) AGAINST(? IN BOOLEAN MODE)
                   OR MATCH(description) AGAINST(? IN BOOLEAN MODE)
               )
             ORDER BY 
               CASE 
                 WHEN LOWER(title) LIKE '%fee%' THEN 0
                 WHEN LOWER(title) LIKE '%tuition%' THEN 1
                 WHEN LOWER(description) LIKE '%fee%' THEN 2
                 ELSE 3
               END,
               LENGTH(content_text) DESC
             LIMIT 6`,
            [searchQuery, searchQuery, searchQuery]
        );
        
        if (!docs.length) {
            console.warn('[advisorService] No fee documents found in database for fee question');
            return '';
        }
        
        console.log(`[advisorService] Found ${docs.length} fee documents`);
        
        // Extract relevant snippets from fee documents
        const context = docs.map(doc => {
            // Get the first 2000 chars of content, prioritizing sections with fee info
            let snippet = doc.content_text || '';
            
            // Try to find sections about specific programmes or fee tables
            const lines = snippet.split('\n');
            let result = [];
            let foundFeeSection = false;
            
            for (const line of lines) {
                if (/(fee|tuition|cost|programme|level|indigene|non[\s-]?indigene|table|medicine|nursing|pharmacy|bmbs)/i.test(line)) {
                    foundFeeSection = true;
                }
                if (foundFeeSection) {
                    result.push(line);
                    if (result.join('\n').length > 2500) break;
                }
            }
            
            const extractedSnippet = result.length > 0 
                ? result.join('\n') 
                : snippet.slice(0, 2000);
            
            return `--- ${doc.title || 'Financial Information'} (${doc.category || 'financial'}) ---\n${extractedSnippet.trim()}`;
        }).join('\n\n');
        
        return context.slice(0, 8000); // Limit total context size
    } catch (err) {
        console.warn('[advisorService] _getFeeDocumentContext error:', err.message);
        return '';
    }
}

/**
 * Fetch supporting BMU document context via the existing retrievalService.
 * Returns "" when RAG is disabled or no relevant chunks were found.
 */
async function _fetchRagContext(question) {
    if (!RAG_ENABLED || !question || question.length < 3) return '';

    if (_isOfficeHolderIdentityQuestion(question)) {
        try {
            const leadershipContext = await _getOfficeHolderDocumentContext(question);
            if (leadershipContext) {
                console.log(`[advisorService] Office-holder identity question: using focused leadership retrieval (${leadershipContext.length} chars)`);
                return leadershipContext;
            }
        } catch (err) {
            console.warn('[advisorService] Focused office-holder retrieval failed:', err.message);
        }
    }

    // For fee-related questions, force a direct database search to guarantee
    // fee documents are included even if title patterns don't match exactly.
    const isFeeQuestion = /(fee|fees|tuition|cost|payment|scholarship|financial|bursar|indigene|non[\s-]?indigene)/i.test(question);
    if (isFeeQuestion) {
        try {
            const feeContext = await _getFeeDocumentContext(question);
            if (feeContext) {
                console.log(`[advisorService] Fee question detected: using forced financial document retrieval (${feeContext.length} chars)`);
                return feeContext;
            }
        } catch (err) {
            console.warn('[advisorService] Forced fee document search failed:', err.message);
            // Continue to normal RAG flow if forced search fails
        }
    }

    if (!retrievalService) return await _keywordFallback(question);

    const priorityDocIds = await _resolvePriorityDocumentIds(question);
    const timed = (promise) => Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(''), RAG_TIMEOUT_MS))
    ]);

    const [generalCtx, priorityCtx] = await Promise.all([
        timed(
            retrievalService.retrieve(question, { limit: 5 })
                .then(r => r?.context || '')
                .catch(err => {
                    console.warn('[advisorService] general RAG retrieve failed:', err.message);
                    return '';
                })
        ),
        priorityDocIds.length
            ? timed(
                retrievalService.retrieve(question, { limit: 5, documentIds: priorityDocIds, skipCache: true })
                    .then(r => r?.context || '')
                    .catch(err => {
                        console.warn('[advisorService] priority RAG retrieve failed:', err.message);
                        return '';
                    })
            )
            : Promise.resolve('')
    ]);

    const merged = _mergeContexts([priorityCtx, generalCtx]);
    if (merged) return merged;

    return await _keywordFallback(question);
}

async function _resolveConversation({ sessionToken, studentId, voiceEnabled }) {
    if (sessionToken) {
        const existing = await Advisor.getConversationByToken(sessionToken);
        if (existing) return existing;
    }

    return await Advisor.createConversation({
        studentId,
        voiceEnabled: voiceEnabled !== false
    });
}

/**
 * Build the recent-history array passed to the LLM.
 * Reverses to chronological order and trims to HISTORY_TURNS items.
 */
async function _buildHistory(conversationId) {
    const rows = await Advisor.getRecentMessages(conversationId, HISTORY_TURNS * 2);
    return rows.reverse().map(r => ({
        role: r.role === 'advisor' ? 'assistant' : 'student',
        text: r.role === 'advisor'
            ? (r.speech_text || r.text || '').slice(0, 400)
            : (r.text || '').slice(0, 400)
    }));
}

/**
 * Public entry point used by /api/advisor/ask.
 *
 * @param {object} params
 * @param {string} params.question            the student's text or transcript
 * @param {string} [params.inputMode='text']  'text' | 'voice'
 * @param {string} [params.sessionToken]      conversation id (uuid)
 * @param {object} [params.student]           student row from `students` table
 * @param {boolean}[params.voiceEnabled=true] generate TTS?
 * @returns {Promise<object>}
 */
async function ask({ question, inputMode = 'text', sessionToken, student = null, voiceEnabled = true, advisorGender = 'female' }) {
    const startedAt = Date.now();
    if (!question || typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required');
    }
    const trimmed = question.trim().slice(0, 4000);
    const isOfficeHolderIdentity = _isOfficeHolderIdentityQuestion(trimmed);

    // 1. Conversation
    const conversation = await _resolveConversation({
        sessionToken,
        studentId: student?.id || null,
        voiceEnabled
    });

    // 2. Persist student turn (so any failure below still leaves a record)
    await Advisor.addMessage({
        conversationId: conversation.id,
        role: 'student',
        inputMode,
        text: trimmed
    });

    // 2b. FAQ-cache short-circuit. If we already have a curated/auto-
    // generated answer for a semantically equivalent question, serve it
    // without paying the LLM round-trip.
    if (faqService && !isOfficeHolderIdentity) {
        try {
            const cached = await faqService.getCachedResponse(trimmed, {
                userId: student?.user_id || null,
                sessionId: conversation.id
            });
            if (cached?.content) {
                console.log(`[advisorService] FAQ cache hit: cached_qa_id=${cached.cachedQaId} (${(cached.cacheConfidence * 100).toFixed(1)}%)`);
                const cachedAnswer = persona.scrubAll(cached.content);
                const cachedSpeech = persona.scrubAll(
                    (cachedAnswer.split('\n').find(l => l.trim()) || cachedAnswer).slice(0, 600)
                );
                let citations = [];
                if (Array.isArray(cached.sources)) citations = cached.sources;
                else if (typeof cached.sources === 'string') {
                    try { citations = JSON.parse(cached.sources || '[]'); } catch (_) { citations = []; }
                }
                const parsed = {
                    speech_text: cachedSpeech,
                    display_markdown: cachedAnswer,
                    topic_slug: null,
                    citations,
                    suggested_actions: [],
                    follow_up_questions: [],
                    needs_escalation: false,
                    confidence: cached.cacheConfidence || 0.95
                };
                const result = await _persistAndPackage({
                    conversation, parsed, llmUsage: null, voiceEnabled, startedAt, advisorGender,
                    questionText: trimmed,
                    ragContext: ''
                });
                result.meta.source = 'faq_cache';
                result.meta.cached_qa_id = cached.cachedQaId;
                result.meta.similarity = cached.cacheConfidence;
                return result;
            }
        } catch (err) {
            console.warn('[advisorService] FAQ cache lookup failed:', err.message);
        }
    }

    // 3. Context: history + RAG
    const [history, ragContext] = await Promise.all([
        _buildHistory(conversation.id),
        _fetchRagContext(trimmed)
    ]);

    if (isOfficeHolderIdentity) {
        const parsed = _buildOfficeHolderSafeReply(trimmed, ragContext);
        return await _persistAndPackage({
            conversation, parsed, llmUsage: null, voiceEnabled, startedAt, advisorGender,
            questionText: trimmed,
            ragContext
        });
    }

    // 4. LLM call
    const messages = [
        { role: 'system', content: persona.buildSystemPrompt({ studentContext: student, ragContext, question: trimmed }) },
        { role: 'user',   content: persona.buildUserPrompt(trimmed, history) }
    ];

    let llmResult;
    try {
        // Persona returns a delimited [SPEECH] / [ANSWER] / [META] format, not raw
        // JSON, so we don't request response_format=json_object here.
        llmResult = await llm.chat(messages);
    } catch (err) {
        console.error('[advisorService] LLM error:', err.message);
        const fallback = {
            speech_text: "I'm having trouble reaching my knowledge service right now. Please try again in a moment, or I can connect you with a human advisor.",
            display_markdown: "**I'm temporarily unable to answer.** Please try again in a moment.\n\n_If the issue persists, you can request to speak with a human advisor._",
            topic_slug: null, citations: [], suggested_actions: [{ label: 'Talk to a human advisor', action: 'escalate_to_human' }],
            follow_up_questions: [], needs_escalation: true, confidence: 0
        };
        return await _persistAndPackage({
            conversation, parsed: fallback, llmUsage: null, voiceEnabled,
            startedAt, errorMsg: err.message, advisorGender,
            questionText: trimmed,
            ragContext
        });
    }

    // 5. Parse + persist + TTS
    const parsedRaw = persona.parseAdvisorReply(llmResult.content, trimmed);
    const parsed = await _sanitizeInteractiveSuggestions(parsedRaw);
    return await _persistAndPackage({
        conversation, parsed, llmUsage: llmResult.usage, voiceEnabled, startedAt, advisorGender,
        questionText: trimmed,
        ragContext
    });
}

async function _persistAndPackage({
    conversation,
    parsed,
    llmUsage,
    voiceEnabled,
    startedAt,
    errorMsg = null,
    advisorGender = 'female',
    questionText = '',
    ragContext = ''
}) {
    // Resolve topic id for tagging
    let topicId = null;
    if (parsed.topic_slug) {
        const topic = await Advisor.findTopicBySlug(parsed.topic_slug);
        topicId = topic?.id || null;
    }

    // TTS
    let audio = { provider: 'none', useBrowserFallback: true };
    if (voiceEnabled !== false && conversation.voice_enabled) {
        audio = await tts.synthesise(parsed.speech_text, { gender: advisorGender });
    }

    // Persist advisor turn
    const messageId = await Advisor.addMessage({
        conversationId: conversation.id,
        role: 'advisor',
        inputMode: 'text',
        text: parsed.display_markdown || parsed.speech_text,
        speechText: parsed.speech_text,
        displayMarkdown: parsed.display_markdown,
        audioUrl: audio.audioUrl || null,
        citationsJson: JSON.stringify(parsed.citations || []),
        suggestedActionsJson: JSON.stringify(parsed.suggested_actions || []),
        followUpsJson: JSON.stringify(parsed.follow_up_questions || []),
        topicId,
        latencyMs: Date.now() - startedAt,
        tokensIn:  llmUsage?.prompt_tokens || null,
        tokensOut: llmUsage?.completion_tokens || null
    });

    let quality = null;
    try {
        quality = await responseQualityService.assessAndMaybeCache({
            advisorMessageId: messageId,
            conversationId: conversation.id,
            questionText,
            answerText: parsed.display_markdown || parsed.speech_text,
            ragContext,
            citations: parsed.citations || [],
            needsEscalation: Boolean(parsed.needs_escalation)
        });
    } catch (err) {
        console.warn('[advisorService] response quality scoring failed:', err.message);
    }

    await Advisor.touchConversation(conversation.id, topicId);

    return {
        success: true,
        sessionToken: conversation.session_token,
        conversationId: conversation.id,
        messageId,
        reply: {
            speech_text:         parsed.speech_text,
            display_markdown:    parsed.display_markdown,
            topic_slug:          parsed.topic_slug,
            citations:           parsed.citations,
            suggested_actions:   parsed.suggested_actions,
            follow_up_questions: parsed.follow_up_questions,
            needs_escalation:    parsed.needs_escalation,
            confidence:          parsed.confidence
        },
        audio: {
            provider:           audio.provider,
            audio_url:          audio.audioUrl || null,
            use_browser_fallback: Boolean(audio.useBrowserFallback)
        },
        meta: {
            latency_ms: Date.now() - startedAt,
            tokens_in:  llmUsage?.prompt_tokens || null,
            tokens_out: llmUsage?.completion_tokens || null,
            error:      errorMsg,
            quality:    quality ? {
                overall: quality.metrics?.overall_score || null,
                addressed: quality.metrics?.addressed_score || null,
                grounded: quality.metrics?.grounding_score || null,
                auto_cache_eligible: Boolean(quality.autoCacheEligible),
                auto_cached: Boolean(quality.autoCached),
                auto_cached_qa_id: quality.cachedQaId || null
            } : null
        }
    };
}

module.exports = { ask };
