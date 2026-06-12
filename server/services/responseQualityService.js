const { query } = require('../../config/db');

let CachedQA = null;
let aiService = null;
let faqService = null;
try { CachedQA = require('../models/CachedQA'); } catch (_) { /* optional */ }
try { aiService = require('./aiService'); } catch (_) { /* optional */ }
try { faqService = require('./faqService'); } catch (_) { /* optional */ }

const SCORE_VERSION = 'heuristic_v1';
const AUTO_CACHE_ENABLED = process.env.AUTO_CACHE_BY_SCORE !== 'false';
const AUTO_CACHE_MIN_OVERALL = Number(process.env.AUTO_CACHE_MIN_OVERALL || 0.84);
const AUTO_CACHE_MIN_ADDRESSED = Number(process.env.AUTO_CACHE_MIN_ADDRESSED || 0.72);
const AUTO_CACHE_MIN_GROUNDED = Number(process.env.AUTO_CACHE_MIN_GROUNDED || 0.62);

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'for', 'of', 'in', 'on', 'at',
    'and', 'or', 'with', 'as', 'by', 'from', 'that', 'this', 'these', 'those', 'it',
    'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
    'how', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'your', 'you', 'we',
    'our', 'their', 'they', 'i', 'me', 'my', 'mine', 'about', 'into', 'than', 'then'
]);

function _clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function _round4(n) {
    return Math.round(_clamp01(n) * 10000) / 10000;
}

function _tokens(text) {
    const raw = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
    return raw.filter(t => !STOP_WORDS.has(t));
}

function _coverage(queryTokens, textTokens) {
    if (!queryTokens.length) return 0.5;
    const hay = new Set(textTokens);
    let hit = 0;
    for (const q of queryTokens) {
        if (hay.has(q)) {
            hit++;
            continue;
        }
        // Tiny stemming tolerance.
        const stem = q.replace(/(ing|ed|es|s)$/i, '');
        if (stem && hay.has(stem)) hit++;
    }
    return hit / queryTokens.length;
}

function _looksComplete(answer) {
    const a = String(answer || '').trim();
    if (a.length < 20) return 0.15;
    const hasEndPunct = /[.!?]$/.test(a);
    const sentenceCount = (a.match(/[.!?](\s|$)/g) || []).length;
    if (hasEndPunct && sentenceCount >= 1) return 1;
    if (sentenceCount >= 1) return 0.8;
    return 0.55;
}

function evaluate({ questionText, answerText, ragContext = '', citations = [], needsEscalation = false }) {
    const q = String(questionText || '').trim();
    const a = String(answerText || '').trim();
    const ctx = String(ragContext || '');

    const qTokens = _tokens(q);
    const aTokens = _tokens(a);
    const cTokens = _tokens(ctx);

    let addressed = _coverage(qTokens, aTokens);
    // Penalize obviously non-answer replies for identity questions.
    if (/^\s*who\s+is\b/i.test(q) && !/\bis\b/i.test(a)) addressed *= 0.7;

    let grounded = 0.5;
    if (ctx.trim()) {
        grounded = _coverage(aTokens.slice(0, 80), cTokens);
    }

    const citationScore = Array.isArray(citations) && citations.length > 0 ? 1 : 0.35;
    const completenessScore = _looksComplete(a);

    let overall = (addressed * 0.45) + (grounded * 0.35) + (citationScore * 0.1) + (completenessScore * 0.1);

    if (needsEscalation) {
        // Don't auto-promote escalatory/uncertain replies.
        overall = Math.min(overall, 0.6);
    }

    const metrics = {
        addressed_score: _round4(addressed),
        grounding_score: _round4(grounded),
        citation_score: _round4(citationScore),
        completeness_score: _round4(completenessScore),
        overall_score: _round4(overall),
        score_version: SCORE_VERSION
    };

    const autoCacheEligible = (
        AUTO_CACHE_ENABLED &&
        !needsEscalation &&
        metrics.overall_score >= AUTO_CACHE_MIN_OVERALL &&
        metrics.addressed_score >= AUTO_CACHE_MIN_ADDRESSED &&
        metrics.grounding_score >= AUTO_CACHE_MIN_GROUNDED &&
        a.length >= 30 &&
        a.length <= 2500
    );

    return { metrics, autoCacheEligible };
}

async function ensureTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS advisor_response_quality (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            advisor_message_id BIGINT UNSIGNED NOT NULL,
            conversation_id BIGINT UNSIGNED NULL,
            question_text TEXT NULL,
            answer_text MEDIUMTEXT NULL,
            addressed_score DECIMAL(5,4) NULL,
            grounding_score DECIMAL(5,4) NULL,
            citation_score DECIMAL(5,4) NULL,
            completeness_score DECIMAL(5,4) NULL,
            overall_score DECIMAL(5,4) NULL,
            score_version VARCHAR(32) NOT NULL DEFAULT 'heuristic_v1',
            feedback_score DECIMAL(5,4) NULL,
            helpful_count INT UNSIGNED NOT NULL DEFAULT 0,
            not_helpful_count INT UNSIGNED NOT NULL DEFAULT 0,
            admin_cache_decision VARCHAR(16) NOT NULL DEFAULT 'none',
            admin_cache_user_id BIGINT UNSIGNED NULL,
            admin_cache_decided_at TIMESTAMP NULL,
            auto_cache_eligible TINYINT(1) NOT NULL DEFAULT 0,
            auto_cached TINYINT(1) NOT NULL DEFAULT 0,
            auto_cached_qa_id BIGINT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_advisor_message_id (advisor_message_id),
            KEY idx_overall_score (overall_score),
            KEY idx_auto_cache (auto_cache_eligible, auto_cached)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS advisor_response_feedback (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            advisor_message_id BIGINT UNSIGNED NOT NULL,
            user_id BIGINT UNSIGNED NULL,
            helpful TINYINT(1) NOT NULL,
            comment VARCHAR(500) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_msg_user (advisor_message_id, user_id),
            KEY idx_msg_helpful (advisor_message_id, helpful)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Backward-compatible upgrades for already-existing deployments.
    const alters = [
        `ALTER TABLE advisor_response_quality ADD COLUMN feedback_score DECIMAL(5,4) NULL`,
        `ALTER TABLE advisor_response_quality ADD COLUMN helpful_count INT UNSIGNED NOT NULL DEFAULT 0`,
        `ALTER TABLE advisor_response_quality ADD COLUMN not_helpful_count INT UNSIGNED NOT NULL DEFAULT 0`,
        `ALTER TABLE advisor_response_quality ADD COLUMN admin_cache_decision VARCHAR(16) NOT NULL DEFAULT 'none'`,
        `ALTER TABLE advisor_response_quality ADD COLUMN admin_cache_user_id BIGINT UNSIGNED NULL`,
        `ALTER TABLE advisor_response_quality ADD COLUMN admin_cache_decided_at TIMESTAMP NULL`
    ];
    for (const sql of alters) {
        try { await query(sql); }
        catch (err) {
            // Ignore duplicate-column errors on environments already migrated.
            if (!err || (err.code !== 'ER_DUP_FIELDNAME' && err.errno !== 1060)) throw err;
        }
    }
}

async function saveAssessment({
    advisorMessageId,
    conversationId,
    questionText,
    answerText,
    metrics,
    autoCacheEligible
}) {
    await ensureTable();
    await query(
        `INSERT INTO advisor_response_quality
            (advisor_message_id, conversation_id, question_text, answer_text,
             addressed_score, grounding_score, citation_score, completeness_score,
             overall_score, score_version, auto_cache_eligible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             conversation_id = VALUES(conversation_id),
             question_text = VALUES(question_text),
             answer_text = VALUES(answer_text),
             addressed_score = VALUES(addressed_score),
             grounding_score = VALUES(grounding_score),
             citation_score = VALUES(citation_score),
             completeness_score = VALUES(completeness_score),
             overall_score = VALUES(overall_score),
             score_version = VALUES(score_version),
             auto_cache_eligible = VALUES(auto_cache_eligible),
             updated_at = CURRENT_TIMESTAMP`,
        [
            advisorMessageId,
            conversationId || null,
            String(questionText || '').slice(0, 3000),
            String(answerText || '').slice(0, 12000),
            metrics.addressed_score,
            metrics.grounding_score,
            metrics.citation_score,
            metrics.completeness_score,
            metrics.overall_score,
            metrics.score_version,
            autoCacheEligible ? 1 : 0
        ]
    );
}

async function _autoCacheIfEligible({ questionText, answerText, citations, metrics }) {
    if (!AUTO_CACHE_ENABLED || !CachedQA) return { autoCached: false, cachedQaId: null };

    const question = String(questionText || '').trim();
    const answer = String(answerText || '').trim();
    if (!question || !answer) return { autoCached: false, cachedQaId: null };

    const existingRows = await query(
        `SELECT id FROM cached_qa WHERE is_active = 1 AND question = ? LIMIT 1`,
        [question]
    );

    let embedding = null;
    if (aiService && typeof aiService.generateEmbedding === 'function') {
        try { embedding = await aiService.generateEmbedding(question, true); }
        catch (_) { /* optional */ }
    }

    let cachedQaId = null;
    if (existingRows.length) {
        cachedQaId = existingRows[0].id;
        await query(
            `UPDATE cached_qa
             SET answer = ?,
                 answer_sources = ?,
                 embedding = COALESCE(?, embedding),
                 confidence_score = ?,
                 qa_type = 'auto_scored',
                 is_active = 1,
                 updated_at = NOW()
             WHERE id = ?`,
            [
                answer,
                JSON.stringify(Array.isArray(citations) ? citations : []),
                embedding ? JSON.stringify(embedding) : null,
                metrics.overall_score,
                cachedQaId
            ]
        );
    } else {
        cachedQaId = await CachedQA.create({
            documentId: null,
            categoryId: null,
            question,
            questionVariations: [],
            answer,
            answerSources: Array.isArray(citations) ? citations : [],
            embedding,
            confidenceScore: metrics.overall_score,
            createdBy: null,
            qaType: 'auto_scored'
        });
    }

    try {
        if (faqService && typeof faqService.invalidateEmbeddingsCache === 'function') {
            faqService.invalidateEmbeddingsCache();
        }
    } catch (_) { /* ignore */ }

    return { autoCached: Boolean(cachedQaId), cachedQaId };
}

async function assessAndMaybeCache({
    advisorMessageId,
    conversationId,
    questionText,
    answerText,
    ragContext,
    citations,
    needsEscalation
}) {
    await ensureTable();
    const { metrics, autoCacheEligible } = evaluate({
        questionText,
        answerText,
        ragContext,
        citations,
        needsEscalation
    });

    const decisionRows = await query(
        `SELECT admin_cache_decision
         FROM advisor_response_quality
         WHERE advisor_message_id = ?
         LIMIT 1`,
        [advisorMessageId]
    );
    const adminDecision = String(decisionRows?.[0]?.admin_cache_decision || 'none').toLowerCase();
    const shouldForceCache = adminDecision === 'approved';
    const shouldBlockCache = adminDecision === 'blocked';
    const effectiveAutoCacheEligible = shouldBlockCache ? false : (autoCacheEligible || shouldForceCache);

    await saveAssessment({
        advisorMessageId,
        conversationId,
        questionText,
        answerText,
        metrics,
        autoCacheEligible: effectiveAutoCacheEligible
    });

    let autoCached = false;
    let cachedQaId = null;

    if (effectiveAutoCacheEligible) {
        const r = await _autoCacheIfEligible({ questionText, answerText, citations, metrics });
        autoCached = r.autoCached;
        cachedQaId = r.cachedQaId;
        if (autoCached && cachedQaId) {
            await query(
                `UPDATE advisor_response_quality
                 SET auto_cached = 1,
                     auto_cached_qa_id = ?
                 WHERE advisor_message_id = ?`,
                [cachedQaId, advisorMessageId]
            );
        }
    }

    return {
        metrics,
        autoCacheEligible: effectiveAutoCacheEligible,
        autoCached,
        cachedQaId,
        adminDecision
    };
}

async function _recomputeFeedbackAggregate(advisorMessageId) {
    await ensureTable();
    const rows = await query(
        `SELECT
            SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS helpful_count,
            SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END) AS not_helpful_count
         FROM advisor_response_feedback
         WHERE advisor_message_id = ?`,
        [advisorMessageId]
    );
    const helpful = Number(rows?.[0]?.helpful_count || 0);
    const notHelpful = Number(rows?.[0]?.not_helpful_count || 0);
    const total = helpful + notHelpful;
    const feedbackScore = total > 0 ? helpful / total : null;

    await query(
        `UPDATE advisor_response_quality
         SET helpful_count = ?,
             not_helpful_count = ?,
             feedback_score = ?
         WHERE advisor_message_id = ?`,
        [helpful, notHelpful, feedbackScore, advisorMessageId]
    );

    return { helpful_count: helpful, not_helpful_count: notHelpful, feedback_score: feedbackScore };
}

async function recordFeedback({ advisorMessageId, userId = null, helpful, comment = null }) {
    await ensureTable();
    const aid = parseInt(advisorMessageId, 10);
    if (!aid) throw new Error('Invalid advisor message id');

    // Ensure quality row exists even if feedback arrives before scoring.
    await query(
        `INSERT INTO advisor_response_quality (advisor_message_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE advisor_message_id = VALUES(advisor_message_id)`,
        [aid]
    );

    await query(
        `INSERT INTO advisor_response_feedback
            (advisor_message_id, user_id, helpful, comment)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            helpful = VALUES(helpful),
            comment = VALUES(comment),
            updated_at = CURRENT_TIMESTAMP`,
        [aid, userId || null, helpful ? 1 : 0, comment ? String(comment).slice(0, 500) : null]
    );

    return await _recomputeFeedbackAggregate(aid);
}

async function setAdminCacheDecision({ advisorMessageId, decision, adminUserId }) {
    await ensureTable();
    const aid = parseInt(advisorMessageId, 10);
    if (!aid) throw new Error('Invalid advisor message id');
    const d = ['none', 'approved', 'blocked'].includes(String(decision || ''))
        ? String(decision)
        : 'none';

    await query(
        `INSERT INTO advisor_response_quality
            (advisor_message_id, admin_cache_decision, admin_cache_user_id, admin_cache_decided_at)
         VALUES
            (?, ?, ?, CASE WHEN ? = 'none' THEN NULL ELSE CURRENT_TIMESTAMP END)
         ON DUPLICATE KEY UPDATE
            admin_cache_decision = VALUES(admin_cache_decision),
            admin_cache_user_id = VALUES(admin_cache_user_id),
            admin_cache_decided_at = CASE WHEN VALUES(admin_cache_decision) = 'none' THEN NULL ELSE CURRENT_TIMESTAMP END,
            auto_cache_eligible = CASE WHEN VALUES(admin_cache_decision) = 'blocked' THEN 0 ELSE auto_cache_eligible END`,
        [aid, d, adminUserId || null, d]
    );

    return { advisorMessageId: aid, decision: d };
}

module.exports = {
    ensureTable,
    evaluate,
    assessAndMaybeCache,
    recordFeedback,
    setAdminCacheDecision
};
