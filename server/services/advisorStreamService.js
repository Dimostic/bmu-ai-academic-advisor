/**
 * Streaming variant of advisorService.ask.
 *
 * Differs from the non-streaming flow in three ways:
 *   1. DeepSeek is called with stream=true.
 *   2. As soon as the model emits the [ANSWER] marker, the [SPEECH] block is
 *      considered final and we kick off TTSMaker IN PARALLEL with continued
 *      streaming of [ANSWER] content. Total user-visible latency drops from
 *      "LLM + TTS" to "max(LLM, TTS)" because the typewriter starts at the
 *      first answer chunk and audio arrives concurrently.
 *   3. The route emits Server-Sent Events; the client wires those into the
 *      typewriter / audio / metadata UI.
 *
 * Events emitted (via an injected `send(event, data)` callback):
 *   - `session`        { sessionToken } — sent once, immediately
 *   - `speech_ready`   { speech_text }  — speech block is finalised
 *   - `token`          { text }         — new chunk of [ANSWER] markdown
 *   - `audio`          { provider, audio_url?, use_browser_fallback?, speech_text? }
 *   - `done`           { reply, audio, sessionToken, conversationId, messageId, meta }
 *   - `error`          { error }
 */
const Advisor = require('../models/Advisor');
const llm = require('./llmClient');
const persona = require('./advisorPersonaService');
const tts = require('./ttsService');
const responseQualityService = require('./responseQualityService');
const courseCatalogService = require('./courseCatalogService');
const bmuLawService = require('./bmuLawService');

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
const ADVISOR_FAST_INTENT_ENABLED = process.env.ADVISOR_FAST_INTENT_ENABLED !== 'false';
const ADVISOR_PHASE2_GROUNDED_MODE = process.env.ADVISOR_PHASE2_GROUNDED_MODE === 'true' || process.env.ADVISOR_PHASE2_GROUNDED_MODE === '1';
const ADVISOR_MIN_GROUNDED_CONFIDENCE = parseFloat(process.env.ADVISOR_MIN_GROUNDED_CONFIDENCE || '0.55');
const ADVISOR_MIN_CITATIONS = parseInt(process.env.ADVISOR_MIN_CITATIONS || '1', 10);
const ADVISOR_PHASE5_SLO_ENABLED = process.env.ADVISOR_PHASE5_SLO_ENABLED !== 'false';
const ADVISOR_SLO_P95_MS = parseInt(process.env.ADVISOR_SLO_P95_MS || '6000', 10);
const ADVISOR_SLO_ERROR_RATE_PCT = parseFloat(process.env.ADVISOR_SLO_ERROR_RATE_PCT || '10', 10);
const ADVISOR_ALERT_EMAIL = String(process.env.ADVISOR_ALERT_EMAIL || '').trim();
const ADVISOR_ALERT_WEBHOOK = String(process.env.ADVISOR_ALERT_WEBHOOK || '').trim();

let retrievalService = null;
try { retrievalService = require('./retrievalService'); }
catch (_) { /* missing optional service */ }

const { query } = require('../../config/db');

let emailService = null;
try { emailService = require('./emailService'); }
catch (_) { /* optional */ }

const _metrics = {
    startedAt: new Date().toISOString(),
    totalRequests: 0,
    fastIntentHits: 0,
    faqCacheHits: 0,
    llmCalls: 0,
    errors: 0,
    avgLatencyMs: 0,
    p95Window: []
};

let _lastSloStatus = 'ok';

async function _dispatchSloAlert({ status, p95, errorRatePct }) {
    const summary = `BMU advisor SLO ${status}: p95=${Math.round(p95 || 0)}ms threshold=${ADVISOR_SLO_P95_MS}ms; errorRate=${Number(errorRatePct.toFixed(2))}% threshold=${ADVISOR_SLO_ERROR_RATE_PCT}%`;

    if (ADVISOR_ALERT_WEBHOOK) {
        try {
            await fetch(ADVISOR_ALERT_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    service: 'bmu-advisor',
                    status,
                    p95LatencyMs: Math.round(p95 || 0),
                    errorRatePct: Number(errorRatePct.toFixed(2)),
                    summary,
                    generatedAt: new Date().toISOString()
                })
            });
        } catch (err) {
            console.warn('[advisorStreamService] SLO webhook alert failed:', err.message);
        }
    }

    if (ADVISOR_ALERT_EMAIL && emailService && typeof emailService.sendMail === 'function') {
        try {
            await emailService.sendMail({
                to: ADVISOR_ALERT_EMAIL,
                subject: `BMU Advisor SLO ${status.toUpperCase()}`,
                text: `${summary}\n\nPlease review the advisor health overview and inspect the latest production trend.`
            });
        } catch (err) {
            console.warn('[advisorStreamService] SLO email alert failed:', err.message);
        }
    }
}

function _getSloState({ p95, errorRatePct }) {
    if (!ADVISOR_PHASE5_SLO_ENABLED) {
        return { enabled: false, status: 'disabled', p95LatencyMs: Math.round(p95 || 0), p95ThresholdMs: ADVISOR_SLO_P95_MS, errorRatePct: Number(errorRatePct.toFixed(2)), errorRateThresholdPct: ADVISOR_SLO_ERROR_RATE_PCT, requestsInWindow: Number(_metrics.totalRequests || 0) };
    }

    let status = 'ok';
    if (p95 > ADVISOR_SLO_P95_MS || errorRatePct > ADVISOR_SLO_ERROR_RATE_PCT) {
        status = 'alert';
    } else if (p95 > ADVISOR_SLO_P95_MS * 0.8 || errorRatePct > ADVISOR_SLO_ERROR_RATE_PCT * 0.75) {
        status = 'warning';
    }

    if (status !== _lastSloStatus) {
        const level = status === 'alert' ? 'warn' : status === 'warning' ? 'warn' : 'log';
        const msg = `[advisorStreamService] SLO status changed to ${status} | p95=${Math.round(p95 || 0)}ms threshold=${ADVISOR_SLO_P95_MS}ms | errorRate=${Number(errorRatePct.toFixed(2))}% threshold=${ADVISOR_SLO_ERROR_RATE_PCT}%`;
        if (level === 'warn') console.warn(msg); else console.log(msg);
        if (status === 'warning' || status === 'alert') {
            Promise.resolve().then(() => _dispatchSloAlert({ status, p95, errorRatePct }));
        }
        _lastSloStatus = status;
    }

    return {
        enabled: true,
        status,
        p95LatencyMs: Math.round(p95 || 0),
        p95ThresholdMs: ADVISOR_SLO_P95_MS,
        errorRatePct: Number(errorRatePct.toFixed(2)),
        errorRateThresholdPct: ADVISOR_SLO_ERROR_RATE_PCT,
        requestsInWindow: Number(_metrics.totalRequests || 0)
    };
}

function _trackOutcome({ latencyMs = 0, source = 'llm', isError = false }) {
    _metrics.totalRequests += 1;
    if (source === 'fast_intent') _metrics.fastIntentHits += 1;
    if (source === 'faq_cache') _metrics.faqCacheHits += 1;
    if (source === 'llm') _metrics.llmCalls += 1;
    if (isError) _metrics.errors += 1;

    const n = _metrics.totalRequests;
    const current = Number(_metrics.avgLatencyMs || 0);
    _metrics.avgLatencyMs = Math.round(((current * (n - 1)) + Number(latencyMs || 0)) / n);
    _metrics.p95Window.push(Number(latencyMs || 0));
    if (_metrics.p95Window.length > 200) _metrics.p95Window.shift();
}

function getStreamMetrics() {
    const sample = [..._metrics.p95Window].sort((a, b) => a - b);
    const p95 = sample.length ? sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.95))] : 0;
    const total = Number(_metrics.totalRequests || 0);
    const errorRatePct = total ? (Number(_metrics.errors || 0) / total) * 100 : 0;
    const slo = _getSloState({ p95, errorRatePct });

    return {
        ..._metrics,
        p95LatencyMs: Math.round(p95 || 0),
        errorRatePct: Number(errorRatePct.toFixed(2)),
        slo
    };
}

async function triggerSloAlert({ status = 'warning', p95 = 0, errorRatePct = 0 } = {}) {
    const safeStatus = ['warning', 'alert'].includes(String(status || '').toLowerCase())
        ? String(status).toLowerCase()
        : 'warning';

    await _dispatchSloAlert({
        status: safeStatus,
        p95: Number(p95 || 0),
        errorRatePct: Number(errorRatePct || 0)
    });

    return {
        success: true,
        status: safeStatus,
        p95LatencyMs: Number(p95 || 0),
        errorRatePct: Number(errorRatePct || 0)
    };
}

const OFFICE_HOLDER_DOC_TITLE_PATTERNS = ['%profile of bmu%', '%brief profile%', '%bmu brief profile%'];
const BMU_PRINCIPAL_OFFICERS = [
    { position: 'Pro-Chancellor / Chairman of Governing Council', name: 'Prof. Tarila Tebepah', note: 'inaugurated July 2024' },
    {
        position: 'Vice-Chancellor',
        name: 'Prof. Dimie Ogoina',
        note: 'appointed October 2024',
        aliases: ['dimie ogoina', 'dimian ogyna', 'dimian ogoina', 'dimie ogyna', 'dimie ogina', 'dimian ogina']
    },
    { position: 'Deputy Vice-Chancellor Administration', name: 'Prof. Ebi Aloysius Lihah', note: '' },
    { position: 'Deputy Vice-Chancellor Academic', name: 'Prof. Godwill Ziriki', note: 'in charge of Sampou campus' },
    { position: 'Registrar', name: 'Dr. (Mrs) Felicia Akusu', note: '' },
    { position: 'Bursar', name: 'Dr Ebipuado Ombu', note: '' },
    { position: 'University Librarian', name: 'Dr. Abraham Etebu', note: '' }
];
const BMU_VISITOR = {
    role: 'Visitor to the University',
    name: 'Senator Douye Diri',
    office: 'Governor of Bayelsa State'
};
const BMU_CHANCELLOR_VACANCY = {
    speech_text: 'Bayelsa Medical University currently has no appointed Chancellor in the active BMU officer records.',
    display_markdown: 'Bayelsa Medical University currently has **no appointed Chancellor** in the active BMU officer records.',
    topic_slug: 'bmu_chancellor_vacant',
    citations: [{ title: 'BMU structured officers table / BMU Brief Institutional Profile', source: 'Approved BMU officer record' }],
    suggested_actions: [],
    follow_up_questions: [],
    needs_escalation: false,
    confidence: 0.99
};
const PROGRAMME_FEES = {
    'MEDICINE': { table: 'TABLE 1: MEDICINE', display: 'Medicine and Surgery (MBBS)', indigene: { '100': '600,000', '200_de': '730,000', '200': '730,000', '300': '475,000', '400': '510,000', '500': '510,000', '600': '540,000' }, non_indigene: { '100': '1,230,000', '200_de': '1,360,000', '200': '1,360,000', '300': '1,015,000', '400': '1,110,000', '500': '1,090,000', '600': '1,195,000' } },
    'DENTISTRY': { table: 'TABLE 2: DENTISTRY', display: 'Dentistry', indigene: { '100': '600,000', '200_de': '730,000', '200': '730,000', '300': '475,000', '400': '510,000', '500': '510,000', '600': '540,000' }, non_indigene: { '100': '1,230,000', '200_de': '1,360,000', '200': '1,360,000', '300': '1,015,000', '400': '1,110,000', '500': '1,090,000', '600': '1,195,000' } },
    'NURSING SCIENCE': { table: 'TABLE 3: NURSING SCIENCE', display: 'Nursing Science', indigene: { '100': '435,000', '200_de': '515,000', '200': '515,000', '300': '460,000', '400': '490,000', '500': '490,000', '600': '520,000' }, non_indigene: { '100': '875,000', '200_de': '950,000', '200': '950,000', '300': '790,000', '400': '845,000', '500': '875,000', '600': '945,000' } },
    'PHARMACY': { table: 'TABLE 4: PHARMACY', display: 'Pharmacy', indigene: { '100': '435,000', '200_de': '515,000', '200': '515,000', '300': '460,000', '400': '490,000', '500': '490,000', '600': '520,000' }, non_indigene: { '100': '875,000', '200_de': '950,000', '200': '950,000', '300': '790,000', '400': '845,000', '500': '875,000', '600': '945,000' } },
    'MEDICAL LABORATORY SCIENCE': { table: 'TABLE 5: MEDICAL LABORATORY SCIENCE', display: 'Medical Laboratory Science', indigene: { '100': '385,000', '200_de': '465,000', '200': '465,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '465,000', '200_de': '545,000', '200': '545,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'OPTOMETRY': { table: 'TABLE 6: OPTOMETRY', display: 'Optometry', indigene: { '100': '385,000', '200_de': '465,000', '200': '465,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '465,000', '200_de': '545,000', '200': '545,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'PHYSIOTHERAPY': { table: 'TABLE 7: PHYSIOTHERAPY', display: 'Physiotherapy', indigene: { '100': '385,000', '200_de': '465,000', '200': '465,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '465,000', '200_de': '545,000', '200': '545,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'RADIOGRAPHY': { table: 'TABLE 8: RADIOGRAPHY', display: 'Radiography', indigene: { '100': '385,000', '200_de': '465,000', '200': '465,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '465,000', '200_de': '545,000', '200': '545,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'COMMUNITY HEALTH': { table: 'TABLE 9: COMMUNITY HEALTH', display: 'Community Health', indigene: { '100': '335,000', '200_de': '415,000', '200': '415,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '415,000', '200_de': '495,000', '200': '495,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'PUBLIC HEALTH': { table: 'TABLE 10: PUBLIC HEALTH', display: 'Public Health', indigene: { '100': '335,000', '200_de': '415,000', '200': '415,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '415,000', '200_de': '495,000', '200': '495,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'HEALTH INFORMATION MANAGEMENT': { table: 'TABLE 11: HEALTH INFORMATION MANAGEMENT', display: 'Health Information Management', indigene: { '100': '335,000', '200_de': '415,000', '200': '415,000', '300': '455,000', '400': '485,000', '500': '485,000', '600': '535,000' }, non_indigene: { '100': '415,000', '200_de': '495,000', '200': '495,000', '300': '785,000', '400': '840,000', '500': '870,000', '600': '940,000' } },
    'HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT': { table: 'TABLE 12: HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT', display: 'Health Care Administration & Hospital Management', indigene: { '100': '173,000', '200_de': '218,000', '200': '218,000', '300': '348,000' }, non_indigene: { '100': '175,000', '200_de': '220,000', '200': '220,000', '300': '350,000' } },
    'HUMAN NUTRITION & DIETETICS': { table: 'TABLE 13: HUMAN NUTRITION & DIETETICS', display: 'Human Nutrition & Dietetics', indigene: { '100': '173,000', '200_de': '218,000', '200': '218,000', '300': '348,000' }, non_indigene: { '100': '175,000', '200_de': '220,000', '200': '220,000', '300': '350,000' } },
    'BIOCHEMISTRY': { table: 'TABLE 14: BIOCHEMISTRY', display: 'Biochemistry', indigene: { '100': '158,000', '200_de': '228,000', '200': '228,000', '300': '270,000', '400': '280,000' }, non_indigene: { '100': '165,000', '200_de': '235,000', '200': '235,000', '300': '530,000', '400': '560,000' } },
    'HUMAN ANATOMY': { table: 'TABLE 15: HUMAN ANATOMY', display: 'Human Anatomy', indigene: { '100': '158,000', '200_de': '228,000', '200': '228,000', '300': '270,000', '400': '280,000' }, non_indigene: { '100': '165,000', '200_de': '235,000', '200': '235,000', '300': '530,000', '400': '560,000' } },
    'HUMAN PHYSIOLOGY': { table: 'TABLE 16: HUMAN PHYSIOLOGY', display: 'Human Physiology', indigene: { '100': '158,000', '200_de': '228,000', '200': '228,000', '300': '270,000', '400': '280,000' }, non_indigene: { '100': '165,000', '200_de': '235,000', '200': '235,000', '300': '530,000', '400': '560,000' } },
    'BIOLOGY': { table: 'TABLE 17: BIOLOGY', display: 'Biology', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'CHEMISTRY': { table: 'TABLE 18: CHEMISTRY', display: 'Chemistry', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'MATHEMATICS': { table: 'TABLE 19: MATHEMATICS', display: 'Mathematics', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'MICROBIOLOGY': { table: 'TABLE 20: MICROBIOLOGY', display: 'Microbiology', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'PHYSICS': { table: 'TABLE 21: PHYSICS', display: 'Physics', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'STATISTICS': { table: 'TABLE 22: STATISTICS', display: 'Statistics', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'COMPUTER SCIENCE': { table: 'TABLE 23: COMPUTER SCIENCE', display: 'Computer Science', indigene: { '100': '148,000', '200_de': '188,000', '200': '188,000', '300': '130,000', '400': '160,000' }, non_indigene: { '100': '155,000', '200_de': '195,000', '200': '195,000', '300': '265,000', '400': '300,000' } },
    'HUMAN NUTRITION': { table: 'TABLE 24: HUMAN NUTRITION', display: 'Human Nutrition', indigene: { '100': '158,000', '200_de': '213,000', '200': '213,000', '300': '315,000', '400': '365,000' }, non_indigene: { '100': '160,000', '200_de': '205,000', '200': '205,000', '300': '660,000', '400': '760,000' } },
    'DENTAL TECHNOLOGY': { table: 'TABLE 25: DENTAL TECHNOLOGY', display: 'Dental Technology', indigene: { '100': '158,000', '200_de': '213,000', '200': '213,000', '300': '315,000', '400': '365,000' }, non_indigene: { '100': '160,000', '200_de': '205,000', '200': '205,000', '300': '660,000', '400': '760,000' } }
};

const PROGRAMME_FEE_ALIASES = [
    ['HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT', /\b(?:health\s+care|healthcare)\s+administration\b|\bhospital\s+management\b|\bhealth\s+care\s+administration\s+(?:and|&)\s+hospital\s+management\b/i],
    ['HUMAN NUTRITION & DIETETICS', /\bhuman\s+nutrition\s+(?:and|&)\s+dietetics\b|\bnutrition\s+(?:and|&)\s+dietetics\b|\bdietetics\b/i],
    ['MEDICAL LABORATORY SCIENCE', /\bmedical\s+laborator(?:y|ies)\s+science\b|\bmedical\s+lab(?:oratory)?\b|\bmed\s+lab\b|\bbmls\b|\bmls\b/i],
    ['HEALTH INFORMATION MANAGEMENT', /\bhealth\s+information\s+management\b|\bhim\b/i],
    ['DENTAL TECHNOLOGY', /\bdental\s+(?:technology|tech)\b/i],
    ['NURSING SCIENCE', /\bnursing(?:\s+science)?\b|\bbnsc\b/i],
    ['COMMUNITY HEALTH', /\bcommunity\s+health(?:\s+sciences?)?\b/i],
    ['PUBLIC HEALTH', /\bpublic\s+health\b/i],
    ['HUMAN PHYSIOLOGY', /\bhuman\s+physiology\b|\bphysiology\b/i],
    ['HUMAN ANATOMY', /\bhuman\s+anatomy\b|\banatomy\b/i],
    ['COMPUTER SCIENCE', /\bcomputer\s+science\b/i],
    ['HUMAN NUTRITION', /\bhuman\s+nutrition\b/i],
    ['MEDICINE', /\bmbbs\b|\bmbchb\b|\bmedicine\s+and\s+surgery\b|\bmed\s+and\s+surg\b|\bmedicine\b/i],
    ['DENTISTRY', /\bdentistry\b|\bbds\b|\bbchd\b/i],
    ['PHARMACY', /\bpharmacy\b|\bpharm\s*d\b|\bpharmd\b|\bb\.?\s*pharm\b/i],
    ['OPTOMETRY', /\boptometry\b/i],
    ['PHYSIOTHERAPY', /\bphysiotherapy\b/i],
    ['RADIOGRAPHY', /\bradiography\b/i],
    ['BIOCHEMISTRY', /\bbiochemistry\b/i],
    ['BIOLOGY', /\bbiology\b/i],
    ['CHEMISTRY', /\bchemistry\b/i],
    ['MATHEMATICS', /\bmathematics\b|\bmaths?\b/i],
    ['MICROBIOLOGY', /\bmicrobiology\b/i],
    ['PHYSICS', /\bphysics\b/i],
    ['STATISTICS', /\bstatistics\b/i]
];

function _isPrincipalOfficersQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /(principal\s+officers?|current\s+(?:name|names)\s+and\s+their\s+positions?|their\s+positions|who\s+are\s+the\s+principal\s+officers)/i.test(q);
}

function _detectPrincipalOfficerRole(question) {
    const q = String(question || '').toLowerCase();
    const isIdentityQuestion = /(who\s+is|who\s+heads|who\s+leads|name\s+of|what\s+is\s+the\s+name|current|currently|tell\s+me\s+about|talking\s+about|referr?ing\s+to|i\s+mean|which\s+person|who\s+serves\s+as|\bname\b)/i.test(q);
    if (!isIdentityQuestion) return null;
    if (/(who\s+heads|who\s+leads|leader\s+of|head\s+of)/i.test(q)
        && /\b(bmu|university|bayelsa\s+medical\s+university)\b/i.test(q)
        && !/(faculty|department|college|school|dean|hod|head\s+of\s+department)/i.test(q)) {
        return 'Vice-Chancellor';
    }
    if (/deputy\s+vice[-\s]?chancellor|(^|\W)dvc(\W|$)/i.test(q)) {
        if (/academic|sampou/i.test(q)) return 'Deputy Vice-Chancellor Academic';
        if (/admin|administration/i.test(q)) return 'Deputy Vice-Chancellor Administration';
        return null;
    }
    if (/pro[-\s]?chancellor|governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman)/i.test(q)) return 'Pro-Chancellor / Chairman of Governing Council';
    if (/\bchancellor\b/i.test(q) && !/(vice[-\s]?chancellor|pro[-\s]?chancellor|deputy\s+vice[-\s]?chancellor|\bvc\b)/i.test(q)) return 'Chancellor';
    if (/vice[-\s]?chancellor|vice\s+(?:counsell?or|cancellor|cancel(?:l)?or)|(?:^|\W)v\s*c(?:\W|$)|(^|\W)vc(\W|$)|wise\s+chancellor/i.test(q)) return 'Vice-Chancellor';
    if (/registrar|registerer/i.test(q)) return 'Registrar';
    if (/bursar|chief\s+financial\s+officer|financial\s+officer/i.test(q)) return 'Bursar';
    if (/\b(?:boss|bossar|bossa|bosa|busa|bussa|bursah)\b/i.test(q)) return 'Bursar';
    if (/university\s+librarian|\blibrarian\b/i.test(q)) return 'University Librarian';
    return null;
}

function _normaliseOfficerName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(?:prof(?:essor)?|dr|mrs|mr|miss|ms)\.?\b/g, ' ')
        .replace(/[^a-z]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _levenshteinDistance(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (!left) return right.length;
    if (!right) return left.length;
    const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let i = 0; i <= left.length; i++) dp[i][0] = i;
    for (let j = 0; j <= right.length; j++) dp[0][j] = j;
    for (let i = 1; i <= left.length; i++) {
        for (let j = 1; j <= right.length; j++) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[left.length][right.length];
}

function _containsFuzzyOfficerName(questionNormalised, officer) {
    const names = [officer.name, ...(officer.aliases || [])].map(_normaliseOfficerName).filter(Boolean);
    if (names.some(name => questionNormalised.includes(name))) return true;

    const tokens = questionNormalised.split(' ').filter(part => part.length > 2);
    return names.some(name => {
        const parts = name.split(' ').filter(part => part.length > 2);
        if (parts.length < 2) return false;
        return parts.every(part => tokens.some(token => {
            if (token === part || token.startsWith(part.slice(0, 3))) return true;
            const maxDistance = part.length <= 5 ? 2 : 3;
            return _levenshteinDistance(token, part) <= maxDistance;
        }));
    });
}

function _detectPrincipalOfficerByName(question, officers = BMU_PRINCIPAL_OFFICERS) {
    const q = _normaliseOfficerName(question);
    if (!q) return null;
    const isPersonLookup = /(who is|tell me about|what do you know about|identify|profile of|current role of|position of|office of|name)/i.test(String(question || ''));
    if (!isPersonLookup) return null;
    return (officers || []).find(officer => {
        const name = _normaliseOfficerName(officer.name);
        if (!name) return false;
        if (q.includes(name)) return true;
        const parts = name.split(' ').filter(part => part.length > 2);
        return (parts.length >= 2 && parts.every(part => new RegExp(`\\b${part}\\b`, 'i').test(q)))
            || _containsFuzzyOfficerName(q, officer);
    }) || null;
}

function _diagnoseStaticQuestion(question) {
    const requestedPrincipalOfficerRole = _detectPrincipalOfficerRole(question);
    const requestedPrincipalOfficerByName = _detectPrincipalOfficerByName(question);
    const isPrincipalOfficersQuestion = _isPrincipalOfficersQuestion(question);
    const isGovernorVisitorQuestion = _isGovernorVisitorQuestion(question);
    const isOfficeHolderIdentity = _isOfficeHolderIdentityQuestion(question);
    const parsed = requestedPrincipalOfficerByName
        ? _buildPrincipalOfficerPersonReply(requestedPrincipalOfficerByName)
        : requestedPrincipalOfficerRole
        ? _buildPrincipalOfficerReply(requestedPrincipalOfficerRole)
        : (isPrincipalOfficersQuestion ? _buildPrincipalOfficersReply() : (isGovernorVisitorQuestion ? _buildGovernorVisitorReply() : null));
    return {
        question,
        requestedPrincipalOfficerRole,
        requestedPrincipalOfficerByName: requestedPrincipalOfficerByName ? requestedPrincipalOfficerByName.name : null,
        isPrincipalOfficersQuestion,
        isGovernorVisitorQuestion,
        isOfficeHolderIdentity,
        staticTopic: parsed?.topic_slug || null,
        staticAnswer: parsed?.display_markdown || ''
    };
}

function _isGovernorVisitorQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /(governor|visitor\s+(?:to|of)\s+(?:the\s+)?(?:university|bmu|bayelsa\s+medical\s+university)|bayelsa\s+state)/i.test(q)
        && /(who\s+is|name\s+of|current|serves\s+as|visitor)/i.test(q);
}

function _isExplicitLawQuestion(question) {
    return /\b(bmu\s+law|bayelsa\s+medical\s+university(?:\s+yenagoa)?\s+law|university\s+law|under\s+the\s+law|according\s+to\s+the\s+law|statute|statutes|section\s+\d+|legal\s+action|suing|sue|pre[-\s]?action\s+notice|notice\s+of\s+action)\b/i.test(String(question || ''));
}

function _isAboutBmuOverviewQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    return /^(?:tell\s+me\s+about|what\s+is|describe|introduce|give\s+me\s+an\s+overview\s+of)\s+(?:bmu|bayelsa\s+medical\s+university)\??$/i.test(q)
        || /^(?:about|overview\s+of)\s+(?:bmu|bayelsa\s+medical\s+university)\??$/i.test(q);
}

const PROGRAMME_OVERVIEW_LABELS = {
    'MEDICINE AND SURGERY': 'Medicine and Surgery (MBBS)',
    'DENTISTRY': 'Dentistry',
    'NURSING SCIENCE': 'Nursing Science',
    'MEDICAL LABORATORY SCIENCE': 'Medical Laboratory Science',
    'PHARMACY': 'Pharmacy',
    'OPTOMETRY': 'Optometry',
    'PHYSIOTHERAPY': 'Physiotherapy',
    'RADIOGRAPHY': 'Radiography and Radiation Science',
    'COMMUNITY HEALTH': 'Community Health Science',
    'PUBLIC HEALTH': 'Public Health',
    'HEALTH INFORMATION MANAGEMENT': 'Health Information Management',
    'HEALTH CARE ADMINISTRATION & HOSPITAL MANAGEMENT': 'Health Care Administration and Hospital Management',
    'HUMAN NUTRITION & DIETETICS': 'Human Nutrition and Dietetics',
    'DENTAL TECHNOLOGY': 'Dental Technology',
    'HUMAN ANATOMY': 'Human Anatomy',
    'HUMAN PHYSIOLOGY': 'Human Physiology',
    'BIOCHEMISTRY': 'Biochemistry',
    'BIOLOGY': 'Biology',
    'CHEMISTRY': 'Chemistry',
    'COMPUTER SCIENCE': 'Computer Science',
    'MATHEMATICS': 'Mathematics',
    'MICROBIOLOGY': 'Microbiology',
    'PHYSICS': 'Physics with Electronics',
    'STATISTICS': 'Statistics'
};

function _formatDetectedProgramme(programme) {
    return PROGRAMME_OVERVIEW_LABELS[programme] || String(programme || '')
        .toLowerCase()
        .replace(/\b\w/g, ch => ch.toUpperCase());
}

function _isProgrammeOverviewQuestion(question) {
    const q = String(question || '').trim();
    if (!q) return false;
    if (/\b(course|courses|curriculum|subjects?|unit|units|credit|semester|level|fee|fees|tuition|admission|requirement|requirements|cut\s*off|cutoff|graduation|duration|how\s+many|list|show)\b/i.test(q)) {
        return false;
    }
    return /^(?:tell\s+me\s+about|what\s+is|describe|introduce|give\s+me\s+an\s+overview\s+of|about)\s+.+/i.test(q);
}

async function _buildProgrammeOverviewReply(question) {
    if (!_isProgrammeOverviewQuestion(question)) return null;
    const programme = courseCatalogService._detectProgramme
        ? courseCatalogService._detectProgramme(question)
        : null;
    if (!programme) return null;

    const display = _formatDetectedProgramme(programme);
    let levels = [];
    let sourceTitles = [];
    try {
        const rows = await courseCatalogService.loadCatalog();
        const normalizedProgramme = String(programme || '').toUpperCase();
        const matched = rows.filter(row => {
            const rowProgramme = String(row.programme || '').toUpperCase();
            return rowProgramme.includes(normalizedProgramme) || normalizedProgramme.includes(rowProgramme);
        });
        levels = [...new Set(matched.map(row => row.level).filter(Boolean))]
            .sort((a, b) => Number(a) - Number(b));
        sourceTitles = [...new Set(matched.map(row => row.sourceTitle).filter(Boolean))];
    } catch (_) { /* catalogue detail is optional for an overview */ }

    const levelText = levels.length
        ? ` The current BMU course catalogue has structured course entries for ${levels.map(level => `${level} level`).join(', ')}.`
        : '';
    const sourceList = sourceTitles.length ? sourceTitles : ['BMU programme/course records'];

    return {
        speech_text: `${display} is one of the programmes represented in BMU's academic advisor knowledge base. I can help with its admission requirements, fees, graduation requirements, and level-by-level course lists when you ask for those details specifically.`,
        display_markdown: `**${display}** is represented in the BMU Academic Advisor knowledge base.${levelText}\n\nFor accuracy, ask the specific detail you need, such as:\n\n- Admission requirements for ${display}\n- Current fees for ${display}\n- Graduation requirements for ${display}\n- Courses for ${display} at a particular level and semester`,
        topic_slug: 'programmes',
        citations: sourceList.map(title => ({ title, source: `${display} programme/course records` })),
        suggested_actions: [],
        follow_up_questions: [
            `Show current fees for ${display}`,
            `Show courses for ${display} by level`
        ],
        needs_escalation: false,
        confidence: 0.9,
        _source: 'programme_overview'
    };
}

function _isDepartmentHeadIdentityQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    return /(who\s+heads|who\s+leads|who\s+is\s+(?:the\s+)?head|name\s+of\s+(?:the\s+)?head|current\s+head|\bhod\b)/i.test(q)
        && /(department|head\s+of\s+department|\bhod\b)/i.test(q);
}

function _extractRequestedDepartment(question) {
    const raw = String(question || '').trim();
    const match = raw.match(/\b(?:department\s+of|hod\s+(?:of|for)|head\s+of\s+department\s+(?:of|for)?|head\s+of\s+the\s+department\s+(?:of|for)?)\s+(.+?)\s*[\?\.!]*$/i);
    if (!match) return '';
    return match[1]
        .replace(/\b(?:at|in)\s+(?:bmu|bayelsa\s+medical\s+university)\b.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, ch => ch.toUpperCase());
}

function _buildDepartmentHeadSafeReply(question = '') {
    const department = _extractRequestedDepartment(question);
    const speechScope = department ? ` for the Department of ${department}` : ' for a specific BMU Head of Department';
    const displayScope = department ? ` for the **Department of ${department}**` : ' for a specific **BMU Head of Department**';
    const speechTail = department
        ? 'Please confirm with the faculty or departmental office for the current appointment.'
        : 'Please specify the department, and I can check the available BMU documents.';
    const displayTail = department
        ? 'Please confirm the current appointment with the relevant **faculty or departmental office**, because HOD appointments can change.'
        : 'Please specify the department, and I can check the available BMU documents for that department.';
    return {
        speech_text: `I do not currently have a verified current name${speechScope} in the records available to me. ${speechTail}`,
        display_markdown: `I don't currently have a verified current name${displayScope} in the records available to me.\n\nBMU departments are headed by **Heads of Department (HODs)**. ${displayTail}`,
        topic_slug: 'department_head_current_name_unavailable',
        citations: [],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: true,
        confidence: 0.72,
        _source: 'fast_intent'
    };
}

function _isMbbsDurationQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    if (/(fee|fees|tuition|cost|payment|payable|levy|indigene|non[-\s]?indigene)/i.test(q)) return false;
    return /(mbbs|mbchb|medicine\s+and\s+surgery|\bmedicine\b)/i.test(q)
        && /(how\s+long|duration|years?|academic\s+sessions?|five[-\s]?year|six[-\s]?year)/i.test(q);
}

function _isMbbsAdmissionQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    if (/(fee|fees|tuition|cost|payment|payable|levy)/i.test(q)) return false;
    return /(mbbs|mbchb|medicine\s+and\s+surgery|\bmedicine\b)/i.test(q)
        && /(admission|admit|enter|entry|requirement|requirements|required|subjects?|eligib|utme|direct\s+entry|\bde\b|o'?level|ssce|waec|neco|jamb|post[-\s]?utme)/i.test(q);
}

function _buildMbbsAdmissionReply() {
    return {
        speech_text: 'For MBBS, the Medicine and Dentistry CCMAS gives two entry routes. Six-year UTME entry requires credit passes in Physics, Chemistry, Biology, Mathematics and English Language at SSC or equivalent at one sitting, plus acceptable UTME and post-UTME scores. Five-year Direct Entry requires relevant A-level passes in Physics, Chemistry and Biology or Zoology, or a first degree in a relevant science area, plus the same SSC credits and JAMB/post-UTME screening.',
        display_markdown: 'For **Medicine and Surgery (MBBS/MBChB)**, the **Medicine and Dentistry CCMAS 2023** gives two admission routes:\n\n**Six-Year Programme / UTME entry**\n\n- Acceptable score in the **Unified Tertiary Matriculation Examination (UTME)**.\n- Credit pass in **Physics, Chemistry, Biology, Mathematics, and English Language** at **Senior Secondary Certificate (SSC)** level or equivalent.\n- The five credit passes must be obtained **at one sitting**.\n- Candidate must also obtain an acceptable score in the university **post-UTME** process.\n\n**Five-Year Programme / Direct Entry**\n\n- Relevant **A-level passes** in **Physics, Chemistry, and Biology/Zoology**; or\n- a **first degree in a relevant science area**.\n- Direct Entry candidates must also have credit passes in **Physics, Chemistry, Biology, Mathematics, and English Language** at SSC/equivalent **at one sitting**.\n- Admission is through **JAMB**, plus the university post-UTME/screening process.\n\nThis is from the **Medicine and Dentistry CCMAS**, not the general Sciences CCMAS. BMU may still publish current cut-off marks or screening dates separately through its Admissions Office.',
        topic_slug: 'mbbs_admission_requirements',
        citations: [{ title: 'Medicine and Dentistry-CCMAS 2023-FINAL.pdf', source: 'Bachelor of Medicine and Bachelor of Surgery (MBBS/MBChB), Admission Requirements' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99,
        _source: 'fast_intent'
    };
}

function _buildMbbsDurationReply() {
    return {
        speech_text: 'For Medicine and Surgery, the six-year programme applies to UTME entry, while the five-year programme applies to Direct Entry. The Medicine and Dentistry CCMAS graduation requirement says MBBS or MBChB students undergo six or five academic sessions depending on the admission entry mode.',
        display_markdown: 'For **Medicine and Surgery (MBBS/MBChB)**:\n\n- **UTME entry:** the **Six-Year Programme** applies.\n- **Direct Entry:** the **Five-Year Programme** applies.\n\nThe Medicine and Dentistry CCMAS section on graduation requirements states that MBBS/MBChB students undergo **six (6) or five (5) academic sessions depending on the admission entry mode**. Treat the separate general duration paragraph as context, but preserve this entry-mode distinction for advisory answers.',
        topic_slug: 'mbbs_duration_by_entry_mode',
        citations: [{ title: 'Medicine and Dentistry CCMAS 2023-FINAL', source: 'Admission and Graduation Requirements' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99,
        _source: 'fast_intent'
    };
}

function _detectFeeProgramme(question) {
    const q = String(question || '').trim();
    const match = PROGRAMME_FEE_ALIASES.find(([, pattern]) => pattern.test(q));
    return match ? match[0] : null;
}

function _isProgrammeFeeQuestion(question) {
    const q = String(question || '').trim();
    return /(fee|fees|tuition|cost|payment|payable|levy|how\s+much|pay)/i.test(q) && Boolean(_detectFeeProgramme(q));
}

function _isGeneralFeeQuestion(question) {
    const q = String(question || '').trim();
    if (!/(fee|fees|tuition|cost|payment|payable|levy)/i.test(q)) return false;
    if (_detectFeeProgramme(q)) return false;
    return /\bbmu\b|bayelsa\s+medical\s+university|by\s+programme|by\s+program|all\s+programmes?|all\s+programs?|current/i.test(q);
}

function _isMedicineFeeQuestion(question) {
    return _isProgrammeFeeQuestion(question) && _detectFeeProgramme(question) === 'MEDICINE';
}

function _detectFeeLevel(question) {
    const q = String(question || '').toLowerCase();
    const level = q.match(/\b(100|200|300|400|500|600)\s*(?:level|lvl|l)?\b/);
    if (!level) return null;
    if (level[1] === '200' && /(direct\s+entry|\bde\b)/i.test(q)) return '200_de';
    return level[1];
}

function _detectFeeCategory(question) {
    const q = String(question || '').toLowerCase();
    if (/non[-\s]?indigene|non[-\s]?bayelsa|not\s+(?:an\s+)?indigene/i.test(q)) return 'non_indigene';
    if (/\bindigene|bayelsa\s+indigene/i.test(q)) return 'indigene';
    return null;
}

function _formatFeeLevel(level) {
    if (level === '200_de') return '200 Direct Entry';
    return `${level} level`;
}

function _programmeFeeRow(level, values) {
    return `| ${_formatFeeLevel(level)} | ${values.indigene} | ${values.non_indigene} |`;
}

function _parseFeeAmount(value) {
    const numeric = String(value || '').replace(/[^\d.]/g, '');
    const amount = Number(numeric);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function _formatNairaAmount(amount) {
    const numeric = _parseFeeAmount(amount);
    return numeric > 0 ? `N${numeric.toLocaleString('en-NG')}` : '';
}

function _feeAmountRange(amounts) {
    const values = [...new Set((amounts || []).map(_parseFeeAmount).filter(Boolean))].sort((a, b) => a - b);
    if (!values.length) return '';
    if (values.length === 1 || values[0] === values[values.length - 1]) return _formatNairaAmount(values[0]);
    return `${_formatNairaAmount(values[0])}-${_formatNairaAmount(values[values.length - 1])}`;
}

function _feeLevelSummary(levels) {
    const order = ['100', '200_de', '200', '300', '400', '500', '600'];
    const found = order.filter(level => levels.has(level));
    if (!found.length) return 'available levels';
    return found.map(_formatFeeLevel).join(', ');
}

function _normaliseRole(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _shapeStructuredOfficer(row) {
    const position = String(row.office || '').trim();
    const name = String(row.officer_name || '').trim();
    if (!position || !name) return null;
    const rawNote = String(row.scope_label || '').trim();
    const note = /principal\s+officers?|structured\s+officers?|officer\s+records?/i.test(rawNote)
        ? ''
        : rawNote;
    return {
        position,
        name,
        note,
        sourcePath: String(row.source_path || 'BMU structured officers table').trim()
    };
}

async function _loadStructuredPrincipalOfficers() {
    try {
        const rows = await query(
            `SELECT office, officer_name, scope_label, source_path, raw_text
             FROM academic_officers
             WHERE status = 'active'
               AND COALESCE(office, '') <> ''
               AND COALESCE(officer_name, '') <> ''
             ORDER BY updated_at DESC, id DESC
             LIMIT 100`
        );
        const seen = new Set();
        const officers = [];
        for (const row of rows || []) {
            const shaped = _shapeStructuredOfficer(row);
            if (!shaped) continue;
            const key = _normaliseRole(shaped.position);
            if (seen.has(key)) continue;
            seen.add(key);
            officers.push(shaped);
        }
        return officers;
    } catch (err) {
        console.warn('[advisorStreamService] structured officer lookup failed:', err.message);
        return [];
    }
}

async function _getPrincipalOfficersForAnswer() {
    const structured = await _loadStructuredPrincipalOfficers();
    return structured.length ? structured : BMU_PRINCIPAL_OFFICERS;
}

function _findOfficerByRole(officers, position) {
    const target = _normaliseRole(position);
    return (officers || []).find(item => {
        const role = _normaliseRole(item.position);
        return role === target
            || (target.includes('pro chancellor') && role.includes('pro chancellor'))
            || (target.includes('chairman of governing council') && role.includes('chairman') && role.includes('governing council'))
            || (target.includes('vice chancellor') && !target.includes('deputy') && role.includes('vice chancellor') && !role.includes('deputy'))
            || (target.includes('bursar') && role.includes('bursar'))
            || (target.includes('registrar') && role.includes('registrar'))
            || (target.includes('university librarian') && role.includes('librarian'))
            || (target.includes('deputy vice chancellor academic') && role.includes('deputy') && role.includes('academic'))
            || (target.includes('deputy vice chancellor administration') && role.includes('deputy') && role.includes('administration'));
    });
}

function _formatOfficerSource(officers) {
    const source = officers.find(item => item.sourcePath)?.sourcePath || 'BMU Brief Institutional Profile (May 2025)';
    return source.includes('structured') ? source : 'BMU structured officers table / BMU Brief Institutional Profile';
}

async function _buildStructuredPrincipalOfficersReply() {
    const officers = await _getPrincipalOfficersForAnswer();
    return _buildPrincipalOfficersReply(officers);
}

async function _buildStructuredPrincipalOfficerReply(position) {
    const officers = await _getPrincipalOfficersForAnswer();
    return _buildPrincipalOfficerReply(position, officers);
}

async function _buildStructuredPrincipalOfficerPersonReply(questionOrOfficer) {
    const officers = await _getPrincipalOfficersForAnswer();
    const officer = typeof questionOrOfficer === 'string'
        ? _detectPrincipalOfficerByName(questionOrOfficer, officers)
        : questionOrOfficer;
    return _buildPrincipalOfficerPersonReply(officer);
}

function _normaliseFeeProgramme(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/&/g, 'AND')
        .replace(/\bSCIENCES\b/g, 'SCIENCE')
        .replace(/\s+/g, ' ')
        .trim();
}

function _structuredFeeLevel(row) {
    const hay = [
        row.level_label,
        row.fee_category,
        row.programme,
        row.raw_text,
        row.row_json
    ].map(v => String(v || '')).join(' ');
    const match = hay.match(/\b(100|200|300|400|500|600)\s*(?:level|lvl|l)?\b/i);
    if (!match) return null;
    if (match[1] === '200' && /\b(direct\s+entry|de)\b/i.test(hay)) return '200_de';
    return match[1];
}

function _structuredFeeCategory(row) {
    const hay = `${row.student_category || ''} ${row.fee_category || ''} ${row.raw_text || ''} ${row.row_json || ''}`;
    if (/non[-\s]?indigene|non[-\s]?bayelsa/i.test(hay)) return 'non_indigene';
    if (/\bindigene|bayelsa\s+indigene/i.test(hay)) return 'indigene';
    return null;
}

function _structuredFeeAmount(row) {
    const label = String(row.amount_label || '').trim();
    if (label) return label.replace(/^N\s*/i, '').replace(/^₦\s*/, '').trim();
    const value = Number(row.amount_value || 0);
    return value > 0 ? value.toLocaleString('en-NG') : '';
}

async function _buildStructuredProgrammeFeeReply(question) {
    const programmeKey = _detectFeeProgramme(question);
    const fallbackFees = programmeKey ? PROGRAMME_FEES[programmeKey] : null;
    if (!programmeKey || !_isProgrammeFeeQuestion(question)) return null;

    const programmeNeedles = [
        programmeKey,
        fallbackFees?.display,
        programmeKey.replace(/\s+SCIENCE$/, ''),
        programmeKey.replace(/\s+&\s+/g, ' AND ')
    ].filter(Boolean);

    try {
        const where = programmeNeedles.map(() => 'UPPER(programme) LIKE ?').join(' OR ');
        const rows = await query(
            `SELECT programme, fee_category, amount_label, amount_value, session_label,
                    student_category, authority_type, scope_label, source_path, raw_text, row_json
             FROM academic_fees
             WHERE status = 'active'
               AND (${where})
             ORDER BY updated_at DESC, id DESC
             LIMIT 250`,
            programmeNeedles.map(value => `%${_normaliseFeeProgramme(value)}%`)
        );
        const records = (rows || [])
            .map(row => ({
                level: _structuredFeeLevel(row),
                category: _structuredFeeCategory(row),
                amount: _structuredFeeAmount(row),
                session: String(row.session_label || '').trim(),
                sourcePath: String(row.source_path || 'BMU structured fees table').trim()
            }))
            .filter(row => row.amount && (row.level || row.category));
        if (!records.length) return null;

        const level = _detectFeeLevel(question);
        const category = _detectFeeCategory(question);
        const display = fallbackFees?.display || programmeKey;
        const sourcePath = records.find(r => r.sourcePath)?.sourcePath || 'BMU structured fees table';
        const sourceNote = `Source: ${sourcePath}. Acceptance fee and accommodation may be separate where applicable.`;

        if (level && category) {
            const match = records.find(row => row.level === level && row.category === category);
            if (!match) return null;
            const categoryLabel = category === 'indigene' ? 'indigene' : 'non-indigene';
            return {
                speech_text: `For ${_formatFeeLevel(level)} ${display}, ${categoryLabel}, the official total payable per session is ${match.amount} naira.`,
                display_markdown: `For **${_formatFeeLevel(level)} ${display}**, **${categoryLabel}**, the official **total payable per session** is **N${match.amount}**.\n\n${sourceNote}`,
                topic_slug: 'programme_fee',
                citations: [{ title: sourcePath, source: 'Academic fees structured table' }],
                suggested_actions: [],
                follow_up_questions: [],
                needs_escalation: false,
                confidence: 0.99,
                _source: 'structured_facts'
            };
        }

        const byLevel = new Map();
        for (const row of records) {
            if (!row.level || !row.category) continue;
            const current = byLevel.get(row.level) || {};
            current[row.category] = `N${row.amount}`;
            byLevel.set(row.level, current);
        }
        const levelOrder = ['100', '200_de', '200', '300', '400', '500', '600'];
        const tableRows = levelOrder
            .filter(item => (!level || item === level) && byLevel.get(item)?.indigene && byLevel.get(item)?.non_indigene)
            .map(item => _programmeFeeRow(item, byLevel.get(item)));
        if (!tableRows.length) return null;

        const scope = level ? ` for **${_formatFeeLevel(level)}**` : '';
        const categoryHint = category ? `\n\nYou asked about **${category === 'indigene' ? 'indigene' : 'non-indigene'}** fees; the table includes both categories for comparison.` : '';
        const table = ['| Level | Indigene total payable | Non-indigene total payable |', '| --- | ---: | ---: |', ...tableRows].join('\n');
        return {
            speech_text: `Here are the official ${display} fee totals${level ? ` for ${_formatFeeLevel(level)}` : ''}.`,
            display_markdown: `Official **${display}** fee totals${scope}:\n\n${table}${categoryHint}\n\n${sourceNote}`,
            topic_slug: 'programme_fee_table',
            citations: [{ title: sourcePath, source: 'Academic fees structured table' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.99,
            _source: 'structured_facts'
        };
    } catch (err) {
        console.warn('[advisorStreamService] structured fee lookup failed:', err.message);
        return null;
    }
}

function _buildStaticAllProgrammeFeesReply() {
    const rows = Object.entries(PROGRAMME_FEES)
        .map(([, fees]) => {
            const levels = new Set([
                ...Object.keys(fees.indigene || {}),
                ...Object.keys(fees.non_indigene || {})
            ]);
            return `| ${fees.display} | ${_feeLevelSummary(levels)} | ${_feeAmountRange(Object.values(fees.indigene || {}))} | ${_feeAmountRange(Object.values(fees.non_indigene || {}))} |`;
        })
        .filter(Boolean);
    if (!rows.length) return null;
    const table = [
        '| Programme | Levels covered | Indigene total payable | Non-indigene total payable |',
        '| --- | --- | ---: | ---: |',
        ...rows
    ].join('\n');
    return {
        speech_text: 'Here is a programme-by-programme summary of the current BMU fee structure. The exact amount depends on programme, level, entry mode, and whether the student is indigene or non-indigene.',
        display_markdown: `Here is the **current BMU fee summary by programme**. Amounts are **total payable per session** and may vary by level or Direct Entry status.\n\n${table}\n\nSource: **BMU fee structures new.docx**. Acceptance fee for new students and optional accommodation may be separate where applicable. For an exact figure, ask with programme, level, and indigene or non-indigene status.`,
        topic_slug: 'programme_fee_summary',
        citations: [{ title: 'bmu fee structures new.docx', source: 'Programme fee tables' }],
        suggested_actions: [],
        follow_up_questions: [
            'What is the 100 level MBBS non-indigene fee?',
            'What is the 300 level Community Health indigene fee?'
        ],
        needs_escalation: false,
        confidence: 0.98,
        _source: 'fast_intent'
    };
}

async function _buildAllProgrammeFeesReply(question) {
    if (!_isGeneralFeeQuestion(question)) return null;
    try {
        const rows = await query(
            `SELECT programme, fee_category, amount_label, amount_value, session_label, source_path, row_json
             FROM academic_fees
             WHERE status = 'active'
             ORDER BY programme ASC, fee_category ASC, amount_value ASC
             LIMIT 5000`
        );
        const grouped = new Map();
        for (const row of rows || []) {
            const programme = String(row.programme || '').trim();
            if (!programme) continue;
            const category = _structuredFeeCategory(row);
            const level = _structuredFeeLevel(row);
            const amount = _parseFeeAmount(row.amount_value || row.amount_label);
            if (!category || !amount) continue;
            const item = grouped.get(programme) || {
                programme,
                levels: new Set(),
                indigene: [],
                non_indigene: [],
                sourcePath: String(row.source_path || 'BMU structured fees table').trim()
            };
            if (level) item.levels.add(level);
            item[category].push(amount);
            if (!item.sourcePath && row.source_path) item.sourcePath = String(row.source_path).trim();
            grouped.set(programme, item);
        }
        const summaries = [...grouped.values()]
            .filter(item => item.indigene.length || item.non_indigene.length)
            .sort((a, b) => a.programme.localeCompare(b.programme));
        if (!summaries.length) return _buildStaticAllProgrammeFeesReply();
        const tableRows = summaries.map(item => `| ${item.programme} | ${_feeLevelSummary(item.levels)} | ${_feeAmountRange(item.indigene)} | ${_feeAmountRange(item.non_indigene)} |`);
        const sourcePath = summaries.find(item => item.sourcePath)?.sourcePath || 'BMU structured fees table';
        const table = [
            '| Programme | Levels covered | Indigene total payable | Non-indigene total payable |',
            '| --- | --- | ---: | ---: |',
            ...tableRows
        ].join('\n');
        return {
            speech_text: 'Here is a programme-by-programme summary of the current BMU fee structure. The exact amount depends on programme, level, entry mode, and whether the student is indigene or non-indigene.',
            display_markdown: `Here is the **current BMU fee summary by programme**. Amounts are **total payable per session** and may vary by level or Direct Entry status.\n\n${table}\n\nSource: **${sourcePath}**. Acceptance fee for new students and optional accommodation may be separate where applicable. For an exact figure, ask with programme, level, and indigene or non-indigene status.`,
            topic_slug: 'programme_fee_summary',
            citations: [{ title: sourcePath, source: 'Academic fees structured table' }],
            suggested_actions: [],
            follow_up_questions: [
                'What is the 100 level MBBS non-indigene fee?',
                'What is the 300 level Community Health indigene fee?'
            ],
            needs_escalation: false,
            confidence: 0.99,
            _source: 'structured_facts'
        };
    } catch (err) {
        console.warn('[advisorStreamService] all-programme structured fee lookup failed:', err.message);
        return _buildStaticAllProgrammeFeesReply();
    }
}

function _buildProgrammeFeeReply(question) {
    const programmeKey = _detectFeeProgramme(question);
    const fees = programmeKey ? PROGRAMME_FEES[programmeKey] : null;
    if (!fees || !_isProgrammeFeeQuestion(question)) return null;

    const level = _detectFeeLevel(question);
    const category = _detectFeeCategory(question);
    const levelOrder = ['100', '200_de', '200', '300', '400', '500', '600'];
    const sourceNote = 'Source: BMU fee structures new.docx. Acceptance fee is N50,000 for new students only; accommodation is optional at N100,000 per session.';

    if (level && category) {
        const amount = fees[category]?.[level];
        if (!amount) return null;
        const categoryLabel = category === 'indigene' ? 'indigene' : 'non-indigene';
        return {
            speech_text: `For ${_formatFeeLevel(level)} ${fees.display}, ${categoryLabel}, the official total payable per session is ${amount} naira. Acceptance fee and optional accommodation are separate where applicable.`,
            display_markdown: `For **${_formatFeeLevel(level)} ${fees.display}**, **${categoryLabel}**, the official **total payable per session** is **N${amount}**.\n\n${sourceNote}`,
            topic_slug: 'programme_fee',
            citations: [{ title: 'bmu fee structures new.docx', source: fees.table }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.99,
            _source: 'fast_intent'
        };
    }

    const rows = levelOrder
        .filter(item => (!level || item === level) && fees.indigene[item] && fees.non_indigene[item])
        .map(item => _programmeFeeRow(item, {
            indigene: `N${fees.indigene[item]}`,
            non_indigene: `N${fees.non_indigene[item]}`
        }));
    if (!rows.length) return null;
    const table = ['| Level | Indigene total payable | Non-indigene total payable |', '| --- | ---: | ---: |', ...rows].join('\n');
    const scope = level ? ` for **${_formatFeeLevel(level)}**` : '';
    const categoryHint = category ? `\n\nYou asked about **${category === 'indigene' ? 'indigene' : 'non-indigene'}** fees; the table includes both categories for comparison.` : '';
    return {
        speech_text: `Here are the official ${fees.display} fee totals${level ? ` for ${_formatFeeLevel(level)}` : ''}. Please use the total payable values from the fee structure and do not recompute them from the displayed columns.`,
        display_markdown: `Official **${fees.display}** fee totals${scope}:\n\n${table}${categoryHint}\n\n${sourceNote}`,
        topic_slug: 'programme_fee_table',
        citations: [{ title: 'bmu fee structures new.docx', source: fees.table }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99,
        _source: 'fast_intent'
    };
}

function _buildMedicineFeeReply(question) {
    return _buildProgrammeFeeReply(question);
}

function _buildPrincipalOfficersReply(officers = BMU_PRINCIPAL_OFFICERS) {
    const rows = officers.map(({ position, name, note }) => ({
        position,
        name,
        note: note || 'Current BMU profile listing'
    }));
    const table = [
        '| Position | Current name | Notes |',
        '| --- | --- | --- |',
        ...rows.map(row => `| ${row.position} | ${row.name} | ${row.note} |`)
    ].join('\n');

    return {
        speech_text: officers.map(({ position, name }) => `${position}: ${name}`).join('; ') + '.',
        display_markdown: `Based on the active BMU principal-officer records, the principal officers are:\n\n${table}\n\nAlso listed in the BMU profile: Visitor to the University, Senator Douye Diri.`,
        topic_slug: 'bmu_principal_officers',
        citations: [{ title: _formatOfficerSource(officers), source: 'Approved BMU officer record' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99
    };
}

function _buildPrincipalOfficerReply(position, officers = BMU_PRINCIPAL_OFFICERS) {
    if (_normaliseRole(position) === 'chancellor') return BMU_CHANCELLOR_VACANCY;
    const officer = _findOfficerByRole(officers, position);
    if (!officer) return null;
    const note = officer.note ? `, ${officer.note}` : '';
    return {
        speech_text: `The ${officer.position} of Bayelsa Medical University is ${officer.name}${note}.`,
        display_markdown: `The **${officer.position}** of Bayelsa Medical University is **${officer.name}**${note}.`,
        topic_slug: 'bmu_principal_officer',
        citations: [{ title: `${officer.position} record`, source: officer.sourcePath || 'Approved BMU officer record' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99
    };
}

function _buildPrincipalOfficerPersonReply(officer) {
    if (!officer) return null;
    const note = officer.note ? `, ${officer.note}` : '';
    return {
        speech_text: `${officer.name} is the ${officer.position} of Bayelsa Medical University${note}.`,
        display_markdown: `**${officer.name}** is the **${officer.position}** of Bayelsa Medical University${note}.`,
        topic_slug: 'bmu_principal_officer',
        citations: [{ title: officer.sourcePath || 'BMU structured officers table / BMU Brief Institutional Profile', source: 'Approved BMU officer record' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99
    };
}

function _buildGovernorVisitorReply() {
    return {
        speech_text: `The Governor of Bayelsa State is ${BMU_VISITOR.name}, and he serves as the Visitor to Bayelsa Medical University (BMU).`,
        display_markdown: `The Governor of Bayelsa State is **${BMU_VISITOR.name}**, and he serves as the **Visitor to Bayelsa Medical University (BMU)**.`,
        topic_slug: 'bmu_visitor_governor',
        citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99
    };
}

function _isAdmissionCutoffQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /\b(cut\s*off|cutoff|cut-off|mark|score|merit)\b/i.test(q)
        && /\b(admission|admissions|apply|application|utme|programme|program|mbbs|medicine|pharmacy|nursing|laboratory|optometry|radiography|physio|community|public\s+health)\b/i.test(q);
}

function _normaliseAdmissionProgramme(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _admissionProgrammeMatchesQuestion(programme, question) {
    const p = _normaliseAdmissionProgramme(programme);
    const q = _normaliseAdmissionProgramme(question);
    if (!p || !q) return false;
    if (p.includes('medicine') && (/\bmbbs\b|\bmedicine\b/.test(q))) return true;
    if (p.includes('pharmacy') && /\b(pharmacy|pharmd|pharm d)\b/.test(q)) return true;
    if (p.includes('nursing') && /\bnursing\b/.test(q)) return true;
    if (p.includes('medical laboratory') && /\b(medical laboratory|med lab|mls|bmls|laboratory)\b/.test(q)) return true;
    if (p.includes('optometry') && /\boptometry\b/.test(q)) return true;
    if (p.includes('radiography') && /\bradiography\b/.test(q)) return true;
    if (p.includes('physiotherapy') && /\b(physiotherapy|physio)\b/.test(q)) return true;
    if ((p.includes('community') || p.includes('public health')) && /\b(community health|public health)\b/.test(q)) return true;
    if (p.includes('other') && /\b(other|others|general|minimum)\b/.test(q)) return true;
    return p.split(' ').filter(Boolean).some(term => term.length > 4 && q.includes(term));
}

async function _buildAdmissionCutoffReply(question) {
    if (!_isAdmissionCutoffQuestion(question)) return null;
    try {
        const rows = await query(`
            SELECT programme, admission_cycle, entry_mode, merit_cutoff, cutoff_label,
                   eligibility_text, application_process, contact_text, source_path
            FROM academic_admission_cutoffs
            WHERE status = 'active'
            ORDER BY admission_cycle DESC, merit_cutoff DESC, programme ASC
            LIMIT 100
        `);
        if (!rows?.length) return null;
        const matched = rows.filter(row => _admissionProgrammeMatchesQuestion(row.programme, question));
        const selected = matched.length ? matched : rows;
        const cycle = selected[0]?.admission_cycle || rows[0]?.admission_cycle || 'current admission cycle';
        const sourcePath = selected.find(row => row.source_path)?.source_path || 'BMU admission cutoff structured records';
        const eligibility = selected.find(row => row.eligibility_text)?.eligibility_text || '';
        const application = selected.find(row => row.application_process)?.application_process || '';
        const contact = selected.find(row => row.contact_text)?.contact_text || '';
        const tableRows = selected.map(row => `| ${row.programme} | ${row.cutoff_label || (row.merit_cutoff ? `Merit - ${Number(row.merit_cutoff).toString()}` : 'Not stated')} |`);
        const table = ['| Programme | Cutoff mark |', '| --- | ---: |', ...tableRows].join('\n');
        const single = matched.length === 1 ? matched[0] : null;
        return {
            speech_text: single
                ? `For the ${cycle} admission cycle, the merit cutoff for ${single.programme} is ${Number(single.merit_cutoff || 0).toString()}. Cutoff marks can change each admission cycle, so use the current BMU admission notice.`
                : `For the ${cycle} admission cycle, BMU cutoff marks vary by programme. Medicine and Surgery is 279, Pharmacy is 238, Nursing Science is 234, Medical Laboratory Sciences is 223, and other listed programmes have their own marks. Cutoff marks can change each admission cycle.`,
            display_markdown: `For the **${cycle} admission cycle**, the structured BMU cutoff records show:\n\n${table}${eligibility ? `\n\n**Eligibility:** ${eligibility}` : ''}${application ? `\n\n**Application process:** ${application}` : ''}${contact ? `\n\n**Further inquiries:** ${contact}` : ''}\n\nCutoff marks are **admission-cycle specific** and should be treated as current only for the stated cycle.`,
            topic_slug: 'admission_cutoff_marks',
            citations: [{ title: sourcePath, source: 'BMU admission cutoff structured table' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.99,
            _source: 'structured_facts'
        };
    } catch (err) {
        if (!/academic_admission_cutoffs/i.test(err.message || '')) {
            console.warn('[advisorStreamService] admission cutoff lookup failed:', err.message);
        }
        return null;
    }
}

function _isRegistrationRequirementQuestion(question) {
    const q = String(question || '').toLowerCase();
    if (/\b(credit\s+load|credit\s+unit|units?|academic\s+workload|below\s+9|above\s+30|senate\s+approval|faculty\s+board)\b/i.test(q)) return false;
    return /\b(register|registration|clearance|new\s+student|returning\s+student|fresh(?:er|ers)?|apply|application|admission\s+portal|upload\s+documents?|application\s+fee)\b/i.test(q)
        && /\b(student|students|bmu|bayelsa|admission|admissions|semester|session|portal|programme|program|applicant|applicants)\b/i.test(q);
}

function _registrationRowSortValue(row) {
    const type = String(row.requirement_type || '').toLowerCase();
    if (/online_application/.test(type)) return 1;
    if (/admission_eligibility/.test(type)) return 2;
    return 9;
}

async function _buildRegistrationRequirementReply(question) {
    if (!_isRegistrationRequirementQuestion(question)) return null;
    try {
        const rows = await query(`
            SELECT student_category, programme, level_label, semester_label, session_label,
                   requirement_type, requirement_text, deadline_label, portal_url,
                   source_path, currentness_label
            FROM academic_registration_requirements
            WHERE status = 'active'
            ORDER BY session_label DESC, student_category ASC, requirement_type ASC
            LIMIT 50
        `);
        if (!rows?.length) return null;
        const q = String(question || '').toLowerCase();
        const wantsReturning = /\breturning\b/.test(q);
        const wantsNew = /\b(new\s+student|fresh(?:er|ers)?|applicant|apply|application|admission)\b/.test(q);
        const scoped = rows.filter(row => {
            const category = String(row.student_category || '').toLowerCase();
            if (wantsReturning) return category.includes('returning');
            if (wantsNew) return category.includes('new') || category.includes('applicant');
            return true;
        });
        const selected = (scoped.length ? scoped : rows).sort((a, b) => _registrationRowSortValue(a) - _registrationRowSortValue(b));
        const session = selected.find(row => row.session_label)?.session_label || 'current session';
        const lines = selected.map(row => {
            const scope = [row.student_category, row.programme, row.level_label, row.semester_label].filter(Boolean).join(' / ') || 'BMU students';
            const deadline = row.deadline_label ? ` Deadline: ${row.deadline_label}.` : '';
            const portal = row.portal_url ? ` Portal: ${row.portal_url}` : '';
            return `- **${scope}**: ${row.requirement_text}${deadline}${portal}`;
        });
        const firstPortal = selected.find(row => row.portal_url)?.portal_url || '';
        const sourcePath = selected.find(row => row.source_path)?.source_path || 'BMU registration structured records';
        return {
            speech_text: `For ${session}, BMU registration and application requirements should be checked from the current structured records. For new applicants, create and verify an account, log in, choose the programme, apply, complete the form, upload the required documents, update the application, and pay the application fee. These requirements can change by session, semester, programme or level.`,
            display_markdown: `For **${session}**, the current BMU structured records show:\n\n${lines.join('\n')}${firstPortal ? `\n\n**Portal:** ${firstPortal}` : ''}\n\nRegistration requirements can change by **session, semester, programme, and level**, so admins should update this table whenever BMU issues a refined instruction.`,
            topic_slug: 'registration_requirements',
            citations: [{ title: sourcePath, source: 'BMU registration requirements structured table' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.98,
            _source: 'structured_facts'
        };
    } catch (err) {
        if (!/academic_registration_requirements/i.test(err.message || '')) {
            console.warn('[advisorStreamService] registration requirement lookup failed:', err.message);
        }
        const q = String(question || '').toLowerCase();
        if (/\b(new\s+students?|fresh(?:er|ers)?|applicant|apply|application|admission)\b/i.test(q)) {
            return {
                speech_text: 'For new BMU applicants, the current application flow is to create an account, verify the account, log in, search for the programme of choice, click apply, fill the application form, upload required documents, update the application, and pay the application fee. Registration requirements can change by session, semester, programme or level, so the latest BMU notice should be checked before acting.',
                display_markdown: '**BMU new applicant application flow**\n\n1. Create an account.\n2. Verify the account.\n3. Log in and search for the programme of choice.\n4. Click **Apply**, fill the application form, and upload required documents.\n5. Update the application.\n6. Pay the application fee.\n\nRegistration requirements can change by **session, semester, programme, and level**, so the latest BMU notice should be checked before acting.',
                topic_slug: 'registration_requirements',
                citations: [{ title: 'BMU admissions page / Admissions Office notice', source: 'New applicant application flow' }],
                suggested_actions: [],
                follow_up_questions: [],
                needs_escalation: false,
                confidence: 0.88,
                _source: 'static_registration_fallback'
            };
        }
        return null;
    }
}

async function _getProfileDocumentContent() {
    try {
        const rows = await query(
            `SELECT id, title, category, content_text
             FROM documents
             WHERE is_active = TRUE
               AND content_text IS NOT NULL
               AND (${OFFICE_HOLDER_DOC_TITLE_PATTERNS.map(() => 'LOWER(title) LIKE ?').join(' OR ')})
             ORDER BY id DESC
             LIMIT 1`,
            OFFICE_HOLDER_DOC_TITLE_PATTERNS
        );

        return rows[0] || null;
    } catch (err) {
        console.warn('[advisorStreamService] _getProfileDocumentContent error:', err.message);
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
        'pro-chancellor / chairman of governing council': /^\s*(?:pro[-\s]?chancellor\s*(?:\/|and|,)?\s*)?(?:governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman))\s*[:\-]\s*([^\r\n]{3,160})/im,
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
                const candidate = _normalizePersonName(match[1]);
                if (candidate) return candidate;
            }
        }
    }

    const roleTokenMap = {
        'vice-chancellor': /vice[-\s]?chancellor|\bvc\b/i,
        'registrar': /\bregistrar\b/i,
        'bursar': /\bbursar\b/i,
        'dean': /\bdean\b/i,
        'pro-chancellor / chairman of governing council': /pro[-\s]?chancellor|governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman)/i,
        'chancellor': /\bchancellor\b/i,
        'librarian': /university\s+librarian|\blibrarian\b/i
    };
    const roleToken = roleTokenMap[normalizedRole];
    if (!roleToken) return null;

    const nameLike = /\b(?:prof(?:essor)?\.?|dr\.?|mr\.?|mrs\.?|ms\.?|miss|pharm\.?|arc\.?|engr\.?|chief|alh\.?|pastor)\b/i;
    const obviousNoise = /^(role|office|position|designation|department|faculty|school|unit)\b/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (normalizedRole === 'chancellor' && /(?:vice|pro|deputy\s+vice)[-\s]?chancellor/i.test(line)) continue;
        if (!roleToken.test(line)) continue;

        const bulletStripped = line.replace(/^\s*[-•]\s*/, '').trim();
        const colonIndex = bulletStripped.indexOf(':');
        const sameLine = (
            colonIndex >= 0
                ? bulletStripped.slice(colonIndex + 1)
                : bulletStripped.replace(roleToken, '')
        )
            .replace(/^\s*[:\-–]+\s*/, '')
            .trim();

        if (sameLine && !obviousNoise.test(sameLine) && /[a-z]/i.test(sameLine)) {
            if (sameLine.length >= 4 && (nameLike.test(sameLine) || /^[A-Z][A-Za-z\s.'-]{3,}$/.test(sameLine))) {
                const candidate = _normalizePersonName(sameLine);
                if (candidate) return candidate;
            }
        }

        for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
            const nextLine = String(lines[j] || '').trim();
            if (!nextLine || obviousNoise.test(nextLine)) continue;
            if (nameLike.test(nextLine) || /^[A-Z][A-Za-z\s.'-]{3,}$/.test(nextLine)) {
                const candidate = _normalizePersonName(nextLine);
                if (candidate) return candidate;
            }
        }
    }

    return null;
}

function _normalizePersonName(value) {
    const text = String(value || '')
        .replace(/\((?:appointed|inaugurated|since|effective|acting)[^)]*\)/ig, ' ')
        .replace(/\((mrs|mr|ms|dr|prof)\.?\)/ig, ' $1 ')
        .replace(/\s+/g, ' ')
        .replace(/[,;.]+$/, '')
        .trim();
    if (!text) return null;
    if (text.length < 4 || text.length > 80) return null;

    const lower = text.toLowerCase();
    if (/\b(university|profile|institutional|overview|document|chapter|section|department|faculty|programme|program|name:)\b/i.test(lower)) return null;
    if (/^\d/.test(text)) return null;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 8) return null;

    const titlePrefix = /^(prof(?:essor)?\.?|dr\.?|mr\.?|mrs\.?|ms\.?|pharm\.?|arc\.?|engr\.?|alh\.?)$/i;
    const cleanWord = /^[A-Za-z][A-Za-z'.-]*$/;
    let alphaWords = 0;
    for (const w of words) {
        if (titlePrefix.test(w)) continue;
        if (!cleanWord.test(w)) return null;
        alphaWords++;
    }
    if (alphaWords < 2) return null;

    return text;
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

function _hasProgrammeSignal(question) {
    return /(mbbs|medicine|dentistry|bnsc|nursing|bmls|medical\s+laboratory|medical\s+lab|allied\s+health|pharmacy|physiotherapy|radiography|optometry|public\s+health|biochemistry|anatomy|physiology|microbiology|biology|chemistry|physics|mathematics|statistics)/i.test(String(question || ''));
}

function _isStudentHandbookFirstQuery(question) {
    const q = String(question || '').toLowerCase();
    if (_hasProgrammeSignal(q) && /(course|courses|curriculum|admission|requirement|graduat|duration|professional\s+exam|minimum\s+academic\s+standard|ccmas)/i.test(q)) {
        return false;
    }
    return /(student|students|handbook|academic\s+regulations|registration|register|attendance|semester|exam|examination|malpractice|probation|withdraw|graduation|cgpa|gpa|grade|result|reassessment|credit\s+load|academic\s+workload|credit\s+unit|hostel|hall|library|discipline|misconduct|student\s+affairs|student\s+union|club|association|demonstration|complaint|dress\s+code)/i.test(q);
}

function _isProgrammeDetailQuery(question) {
    const q = String(question || '').toLowerCase();
    return _hasProgrammeSignal(q)
        && /(course|courses|curriculum|admission|requirement|graduat|duration|level|semester|unit|units|professional\s+exam|minimum\s+academic\s+standard|ccmas)/i.test(q);
}

async function _resolvePriorityDocumentIds(question) {
    try {
        const q = String(question || '').toLowerCase();
        const patterns = [];
        const isSpecificCourseQuery = _isSpecificProgrammeCourseQuery(q);
        const isGenericCoursesAsProgrammes = /(course|courses)/i.test(q) && !isSpecificCourseQuery;
        const isHandbookFirst = _isStudentHandbookFirstQuery(q);
        const isProgrammeDetail = _isProgrammeDetailQuery(q);

        if (isHandbookFirst) {
            patterns.push('%handbook%');
            patterns.push("%students' handbook%");
            patterns.push('%student handbook%');
        }

        if (/(fee|fees|tuition|cost|payment|indigene|non[-\s]?indigene)/i.test(q)) {
            patterns.push('%fee structure%');
            patterns.push('%fees%');
        }
        if (isProgrammeDetail) {
            patterns.push('%ccmas%');
            patterns.push('%allied health%');
            patterns.push('%medicine%');
            patterns.push('%dentistry%');
            patterns.push('%pharmacy%');
            patterns.push('%sciences%');
            patterns.push('%social sciences%');
        }
        if (isSpecificCourseQuery || /(department|departments|faculty|faculties)/i.test(q)) {
            patterns.push('%student courses%');
            patterns.push('%course%');
        }
        if (/(programme|programmes|program|profile|about bmu|bmu profile)/i.test(q) || isGenericCoursesAsProgrammes) {
            patterns.push('%brief profile%');
            patterns.push('%profile%');
            patterns.push('%programme%');
            patterns.push('%programmes%');
        }
        if (/(who\s+is|name\s+of|current)/i.test(q) && /(registrar|vice[-\s]?chancellor|\bvc\b|bursar|dean|chancellor|pro[-\s]?chancellor|governing\s+council|council\s+(?:chair|chairman))/i.test(q)) {
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
            `SELECT id
             FROM documents
             WHERE is_active = TRUE
               AND (${where})
             ORDER BY id DESC
             LIMIT 12`,
            unique
        );
        return rows.map(r => r.id).filter(Boolean);
    } catch (err) {
        console.warn('[advisorStreamService] priority document lookup failed:', err.message);
        return [];
    }
}

function _isOfficeHolderIdentityQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /(who\s+is|name\s+of|current)/i.test(q)
    && /(registrar|vice[-\s]?chancellor|\bvc\b|bursar|dean|chancellor|pro[-\s]?chancellor|governing\s+council|council\s+(?:chair|chairman)|librarian|university\s+librarian)/i.test(q);
}

async function _getOfficeHolderDocumentContext(question) {
    try {
        const q = String(question || '').toLowerCase();
        const roleLabel = _detectOfficeRoleLabel(q);
        const roleNeedleMap = {
            'Pro-Chancellor / Chairman of Governing Council': /pro[-\s]?chancellor|governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman)/i,
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
        console.warn('[advisorStreamService] _getOfficeHolderDocumentContext error:', err.message);
        return '';
    }
}

function _detectOfficeRoleLabel(question) {
    const q = String(question || '').toLowerCase();
    if (/pro[-\s]?chancellor|governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman)/.test(q)) return 'Pro-Chancellor / Chairman of Governing Council';
    if (/vice[-\s]?chancellor|\bvc\b/.test(q)) return 'Vice-Chancellor';
    if (/\bchancellor\b/.test(q)) return 'Chancellor';
    if (/registrar/.test(q)) return 'Registrar';
    if (/bursar/.test(q)) return 'Bursar';
    if (/dean/.test(q)) return 'Dean';
    if (/librarian|university\s+librarian/.test(q)) return 'Librarian';
    return 'office holder';
}

function _extractRoleNameFromContext(roleLabel, ragContext) {
    const text = String(ragContext || '');
    if (!text.trim()) return null;

    const patterns = {
        'Pro-Chancellor / Chairman of Governing Council': /^\s*[-•]?\s*(?:pro[-\s]?chancellor\s*(?:\/|and|,)?\s*)?(?:governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman))\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Vice-Chancellor': /^\s*[-•]?\s*(?:current\s+)?vice[-\s]?chancellor\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Registrar': /^\s*[-•]?\s*registrar\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Bursar': /^\s*[-•]?\s*bursar\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Dean': /^\s*[-•]?\s*dean\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Chancellor': /^\s*[-•]?\s*chancellor\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Librarian': /^\s*[-•]?\s*(?:university\s+)?librarian\s*[:\-]\s*([^\n\r;]{3,220})/im
    };
    const loosePatterns = {
        'Pro-Chancellor / Chairman of Governing Council': /(?:^|\s)(?:pro[-\s]?chancellor\s*(?:\/|and|,)?\s*)?(?:governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman))\s*[:\-]\s*([^\n\r]{3,260})/i,
        'Vice-Chancellor': /(?:^|\s)(?:current\s+)?vice[-\s]?chancellor\s*[:\-]\s*([^\n\r]{3,260})/i,
        'Registrar': /(?:^|\s)registrar\s*[:\-]\s*([^\n\r]{3,260})/i,
        'Bursar': /(?:^|\s)bursar\s*[:\-]\s*([^\n\r]{3,260})/i,
        'Dean': /(?:^|\s)dean\s*[:\-]\s*([^\n\r]{3,260})/i,
        'Chancellor': /(?:^|\s)chancellor\s*[:\-]\s*([^\n\r]{3,260})/i,
        'Librarian': /(?:^|\s)(?:university\s+)?librarian\s*[:\-]\s*([^\n\r]{3,260})/i
    };

    const stopAtNextRole = (value) => String(value || '').replace(
        /\s+(?=(?:deputy\s+vice[-\s]?chancellor|vice[-\s]?chancellor|registrar|bursar|(?:university\s+)?librarian|governing\s+council|meetings?\s+schedule|principal\s+officers|senate|university\s+council)\b).*$/i,
        ''
    ).trim();

    const tryNormalize = (raw) => {
        const clipped = stopAtNextRole(raw);
        return _normalizePersonName(clipped);
    };

    const re = patterns[roleLabel];
    if (re) {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const line = lines.find(entry => re.test(entry));
        if (line) {
            const m = line.match(re);
            const candidate = tryNormalize(m && m[1]);
            if (candidate) return candidate;
        }
    }

    const loose = loosePatterns[roleLabel];
    if (loose) {
        const m = text.match(loose);
        const candidate = tryNormalize(m && m[1]);
        if (candidate) return candidate;
    }

    return null;
}

function _extractCitationsFromContext(ragContext) {
    const text = String(ragContext || '');
    const titles = [...text.matchAll(/---\s*(.+?)\s*\([^\)]*\)\s*---/g)]
        .map(m => String(m[1] || '').trim())
        .filter(Boolean);
    return [...new Set(titles)].slice(0, 3).map(title => ({ title, source: 'BMU document context' }));
}

function _extractRoleExcerptFromContext(roleLabel, ragContext) {
    const text = String(ragContext || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const patterns = {
        'Pro-Chancellor / Chairman of Governing Council': /(?:pro[-\s]?chancellor|governing\s+council\s+(?:chair|chairman)|(?:chair|chairman)\s+(?:of\s+)?(?:the\s+)?governing\s+council|council\s+(?:chair|chairman))[^\n\r]{0,220}/i,
        'Vice-Chancellor': /(?:vice[-\s]?chancellor|\bvc\b)[^\n\r]{0,220}/i,
        'Registrar': /\bregistrar\b[^\n\r]{0,220}/i,
        'Bursar': /\bbursar\b[^\n\r]{0,220}/i,
        'Dean': /\bdean\b[^\n\r]{0,220}/i,
        'Chancellor': /\bchancellor\b[^\n\r]{0,220}/i,
        'Librarian': /(?:university\s+librarian|\blibrarian\b)[^\n\r]{0,220}/i
    };

    const re = patterns[roleLabel];
    if (!re) return null;
    const m = text.match(re);
    if (!m || !m[0]) return null;

    let excerpt = String(m[0]).replace(/\s+/g, ' ').replace(/^[\s,:;\-]+|[\s,:;\-]+$/g, '').trim();
    excerpt = excerpt.replace(
        /\s+(?=(?:deputy\s+vice[-\s]?chancellor|vice[-\s]?chancellor|registrar|bursar|(?:university\s+)?librarian|governing\s+council|meetings?\s+schedule|principal\s+officers|senate|university\s+council)\b).*$/i,
        ''
    ).trim();
    if (excerpt.length < 12) return null;
    return excerpt;
}

function _buildOfficeHolderSafeReply(question, ragContext) {
    const roleLabel = _detectOfficeRoleLabel(question);
    if (roleLabel === 'Chancellor') return BMU_CHANCELLOR_VACANCY;
    const extractedName = _extractRoleNameFromContext(roleLabel, ragContext);
    const roleExcerpt = _extractRoleExcerptFromContext(roleLabel, ragContext);
    const citations = _extractCitationsFromContext(ragContext);
    const roleAction = `search_profile_doc:${roleLabel.toLowerCase().replace(/[^a-z]+/g, '_')}`;
    const roleSearchLabel = `Search the BMU profile document for ${roleLabel}`;

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

    if (roleExcerpt) {
        const answer = `From the BMU profile document, I found this ${roleLabel.toLowerCase()} excerpt: ${roleExcerpt}.`;
        return {
            speech_text: answer,
            display_markdown: `From the BMU profile document, I found this **${roleLabel.toLowerCase()}** excerpt:\n\n${roleExcerpt}`,
            topic_slug: null,
            citations,
            suggested_actions: [{ label: roleSearchLabel, action: roleAction }],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.55
        };
    }

    return {
        speech_text: `The ${roleLabel.toLowerCase()} information I have is not verified from the BMU profile document right now. Please check the official profile document or ask me to search that document directly.`,
        display_markdown: `The ${roleLabel.toLowerCase()} information I have is not verified from the BMU profile document right now.\n\nPlease check the official profile document or ask me to search that document directly.`,
        topic_slug: null,
        citations,
        suggested_actions: [{ label: roleSearchLabel, action: roleAction }],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.4
    };
}

function _mergeContexts(parts) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        if (!part || typeof part !== 'string') continue;
        for (const block of part.split(/\n\n+/g)) {
            const b = block.trim();
            if (b.length < 20 || seen.has(b)) continue;
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

function _withSuggestionTimeout(promise, fallback = null, timeoutMs = 2500) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
    ]);
}

async function _isRetrievableQuestion(text) {
    const q = String(text || '').trim();
    if (!q || q.length < 5) return false;

    if (/(courses?|course\s+unit|level)/i.test(q)) {
        if (courseCatalogService._detectProgramme && courseCatalogService._detectProgramme(q)) return true;
        try {
            const courseReply = await _withSuggestionTimeout(courseCatalogService.buildCourseListReply(q), null, 7000);
            if (courseReply?.display_markdown || courseReply?.speech_text) return true;
        } catch (_) {
            // Continue to the normal validation routes.
        }
    }

    try {
        const fast = await _withSuggestionTimeout(_buildFastIntentReply(q), null);
        if (fast) {
            const topic = String(fast.topic_slug || fast.source || '').toLowerCase();
            if ((_isGeneralFeeQuestion(q) || _isProgrammeFeeQuestion(q)) && !topic.includes('fee')) return false;
            if ((_detectPrincipalOfficerRole(q) || _isPrincipalOfficersQuestion(q)) && !topic.includes('principal_officer') && !topic.includes('chancellor')) return false;
            if (/courses?|course\s+unit|level/i.test(q) && !/(course|programme|program|mbbs|student_handbook)/i.test(topic)) return false;
            if (_isExplicitLawQuestion(q) && !/law|visitor|principal_officer/.test(topic)) return false;
            return Boolean(fast.display_markdown || fast.speech_text);
        }
    } catch (_) {
        // Fall through to retrieval if the deterministic route is unavailable.
    }

    const law = bmuLawService.buildLawReply(q);
    if (law) {
        return _isExplicitLawQuestion(q) && !_isGeneralFeeQuestion(q) && !_isProgrammeFeeQuestion(q);
    }

    if (!retrievalService) return true;
    try {
        const r = await _withSuggestionTimeout(
            retrievalService.retrieve(q, { limit: 1, skipCache: true }),
            null
        );
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

function _isLikelyFactualQuestion(question) {
    const q = String(question || '').toLowerCase();
    if (!q.trim()) return false;
    return /(what|when|where|which|who|how much|how many|fee|fees|tuition|programme|program|course|courses|requirement|requirements|deadline|admission|calendar|hostel|exam|result|policy|rules|grading)/i.test(q);
}

function _buildGroundedFallback(question, parsed, ragContext) {
    if (!ADVISOR_PHASE2_GROUNDED_MODE || !_isLikelyFactualQuestion(question)) {
        return { grounded_mode: false, fallback_reason: null, retrieval_confidence: 0, override: null };
    }

    const parsedConfidence = Number(parsed?.confidence || 0);
    const citations = Array.isArray(parsed?.citations) ? parsed.citations : [];
    const retrievalConfidence = Number((ragContext && String(ragContext).trim().length > 0) ? 0.8 : 0);
    const insufficientCitations = citations.length < ADVISOR_MIN_CITATIONS;
    const lowConfidence = parsedConfidence < ADVISOR_MIN_GROUNDED_CONFIDENCE;

    if (!insufficientCitations && !lowConfidence && retrievalConfidence > 0) {
        return { grounded_mode: true, fallback_reason: null, retrieval_confidence: retrievalConfidence, override: null };
    }

    let reason = 'insufficient_evidence';
    if (lowConfidence && insufficientCitations) reason = 'low_confidence_and_insufficient_citations';
    else if (lowConfidence) reason = 'low_confidence';
    else if (insufficientCitations) reason = 'insufficient_citations';

    const fallbackText = 'I have some BMU information, but I am not fully confident enough to give a definitive answer on this point yet. Please ask a more specific question or check the official BMU guidance.';

    return {
        grounded_mode: true,
        fallback_reason: reason,
        retrieval_confidence: retrievalConfidence,
        override: {
            speech_text: fallbackText,
            display_markdown: fallbackText,
            topic_slug: null,
            citations: citations.slice(0, 2),
            suggested_actions: [
                { label: 'Ask a more specific BMU question', action: 'escalate_to_human' },
                { label: 'Show me BMU programme information', action: 'open_topic:programmes' }
            ],
            follow_up_questions: [
                'What are the admission requirements for Medicine and Surgery?',
                'Can you explain the BMU fee structure in more detail?'
            ],
            needs_escalation: false,
            confidence: Math.min(parsedConfidence || 0.5, ADVISOR_MIN_GROUNDED_CONFIDENCE - 0.05)
        }
    };
}

function _buildHandbookAcademicPolicyReply(question) {
    const q = String(question || '').trim().toLowerCase();
    if (!q) return null;

    const isCreditUnitDefinition = /(define|definition|what\s+is|meaning\s+of).{0,40}credit\s+unit|credit\s+unit.{0,40}(define|definition|mean)/i.test(q);
    const isAcademicWorkload = /(student\s+academic\s+workload|academic\s+workload|credit\s+load|course\s+load|credit\s+units?|how\s+many\s+units|units?.{0,40}(?:register|take)|register.{0,40}units?|register\s+(?:less|more)|less\s+than\s+15|more\s+than\s+24|above\s+30|below\s+9)/i.test(q);
    const isReassessment = /(reassessment|re-assessment|remark|re-mark|results?\s+review|appeal.{0,30}results?|after\s+results?\s+(?:are\s+)?published)/i.test(q);
    if (!isCreditUnitDefinition && !isAcademicWorkload && !isReassessment) return null;

    if (isReassessment) {
        return {
            speech_text: 'According to the BMU Students Handbook, a student may request reassessment not later than two weeks after provisional results are published by the faculty. The student pays a reassessment fee of two thousand naira, refundable only if the appeal succeeds, and the report goes to Senate through the Faculty Board.',
            display_markdown: "According to the **BMU Students' Handbook 2026**, section **3.12 Request for Reassessment**:\n\n- A student may request reassessment of work in a course examination **not later than two weeks after publication of provisional results** by the faculty.\n- The student must pay a reassessment fee of **N2,000**, subject to review from time to time.\n- The reassessment begins only after evidence of payment is presented.\n- The fee is refundable **only if the appeal is successful**.\n- The reassessment report should be forwarded to **Senate through the Faculty Board** for consideration.",
            topic_slug: 'student_handbook_reassessment',
            citations: [{ title: "Students' Handbook 2026", source: 'Chapter 3: Academic Regulations, section 3.12' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.99,
            _source: 'fast_intent'
        };
    }

    const citations = [{ title: "Students' Handbook 2026", source: 'Chapter 3: Academic Regulations, sections 3.13 and 3.15' }];

    if (isCreditUnitDefinition) {
        return {
            speech_text: 'According to the BMU Students Handbook, one credit unit is one hour of lecture plus one to three hours of tutorial or discussion per week per semester, or two to three hours of practical work per week per semester.',
            display_markdown: "According to the **BMU Students' Handbook 2026**, section **3.15 Definition of Credit Unit**, one course credit unit means either:\n\n- **1 hour of lecture** plus **1 to 3 hours of tutorial/discussion** per week per semester, or\n- **2 to 3 hours of practical work** such as workshop, laboratory, or field work per week per semester.",
            topic_slug: 'student_handbook_credit_unit',
            citations,
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.99,
            _source: 'fast_intent'
        };
    }

    return {
        speech_text: 'According to the BMU Students Handbook, full-time students normally take 15 to 24 credit units per semester. Faculty Board may approve 9 to 30 units through the Head of Department. Below 9 or above 30 units requires Senate approval, and above 30 units must not add more than one course.',
        display_markdown: "According to the **BMU Students' Handbook 2026**, section **3.13 Student Academic Workload**:\n\n- Full-time students normally take **15 to 24 credit units per semester**.\n- A student may apply through the **Head of Department** to the **Faculty Board** to take less or more than that normal range, provided the load is **not less than 9 units** and **not more than 30 units**.\n- If the total load is **below 9 units** or **above 30 units**, **Senate approval** is required.\n- Where the requested load is **above 30 units**, the added unit must not translate into more than **one course**.\n\nThis is a student-handbook rule, so it should take priority over general curriculum averages.",
        topic_slug: 'student_handbook_academic_workload',
        citations,
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99,
        _source: 'fast_intent'
    };
}

function _buildPureFastIntentReply(q) {
    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))(\b|[!.,?\s])/.test(q)) {
        return {
            speech_text: 'Hello. I am Dr Tari, your BMU academic advisor. Ask me about programmes, fees, courses, exams, or student policies.',
            display_markdown: 'Hello. I am Dr Tari, your BMU Academic Advisor. Ask me about programmes, fees, courses, exams, hostel, or student policies.',
            topic_slug: 'greeting',
            citations: [],
            suggested_actions: [
                { label: 'What programmes are offered at BMU?', action: 'open_topic:programmes' },
                { label: 'What are current BMU fees by programme?', action: 'open_topic:fees' }
            ],
            follow_up_questions: [
                'What are the admission requirements for Medicine and Surgery?',
                'What is the current BMU tuition fee for Nursing Science?',
                'What is BMU student academic workload and credit load?'
            ],
            needs_escalation: false,
            confidence: 0.95,
            _source: 'fast_intent'
        };
    }

    if (/(what\s+can\s+you\s+do|help\s+me|how\s+do\s+i\s+use\s+this|how\s+to\s+use)/.test(q)) {
        return {
            speech_text: 'I can answer BMU questions on programmes, courses, fees, calendar, hostel, and student rules. You can type, tap follow ups, or use voice.',
            display_markdown: 'I can help with BMU programmes, course requirements, fees, academic calendar, hostel, and student rules.\n\nYou can type your question, use voice, or tap suggested follow-up prompts.',
            topic_slug: 'advisor_help',
            citations: [],
            suggested_actions: [
                { label: 'What is BMU student academic workload and credit load?', action: 'open_topic:conduct' },
                { label: 'What programmes are offered at BMU?', action: 'open_topic:programmes' }
            ],
            follow_up_questions: [
                'What is BMU reassessment policy after results are published?',
                'What are BMU registration requirements for new students?'
            ],
            needs_escalation: false,
            confidence: 0.92,
            _source: 'fast_intent'
        };
    }

    return null;
}

async function _buildFastIntentReply(question) {
    const q = String(question || '').trim().toLowerCase();
    if (!q) return null;

    const pureIntentReply = _buildPureFastIntentReply(q);
    if (pureIntentReply) return pureIntentReply;

    const earlyAdmissionCutoffReply = await _buildAdmissionCutoffReply(q);
    if (earlyAdmissionCutoffReply) return earlyAdmissionCutoffReply;
    const earlyAllProgrammeFeesReply = await _buildAllProgrammeFeesReply(q);
    if (earlyAllProgrammeFeesReply) return earlyAllProgrammeFeesReply;
    const earlyProgrammeFeeReply = await _buildStructuredProgrammeFeeReply(q) || _buildProgrammeFeeReply(q);
    if (earlyProgrammeFeeReply) return earlyProgrammeFeeReply;
    if (_isMbbsDurationQuestion(q)) return _buildMbbsDurationReply();
    if (_isMbbsAdmissionQuestion(q)) return _buildMbbsAdmissionReply();

    const earlyHandbookPolicyReply = _buildHandbookAcademicPolicyReply(q);
    if (earlyHandbookPolicyReply) return earlyHandbookPolicyReply;

    const earlyRegistrationRequirementReply = await _buildRegistrationRequirementReply(q);
    if (earlyRegistrationRequirementReply) return earlyRegistrationRequirementReply;

    const earlyCourseCatalogReply = await courseCatalogService.buildCourseListReply(q);
    if (earlyCourseCatalogReply) return earlyCourseCatalogReply;

    const earlyProgrammeOverviewReply = await _buildProgrammeOverviewReply(q);
    if (earlyProgrammeOverviewReply) return earlyProgrammeOverviewReply;

    if (_isAboutBmuOverviewQuestion(q)) {
        return {
            speech_text: 'Bayelsa Medical University, BMU, is a Bayelsa State medical university in Yenagoa focused on training health professionals through medicine, nursing, medical laboratory science, public health and related health-science programmes.',
            display_markdown: 'Bayelsa Medical University (BMU) is a Bayelsa State medical university in Yenagoa focused on training health professionals through medicine, nursing, medical laboratory science, public health, and related health-science programmes.\n\nYou can ask me next about BMU programmes, fees, admission requirements, hostels, exams, or student rules.',
            topic_slug: 'about_bmu',
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.95,
            _source: 'fast_intent'
        };
    }

    if (/(courses?\s+(?:are\s+)?offered|programmes?\s+(?:are\s+)?offered|programs?\s+(?:are\s+)?offered|list\s+(?:the\s+)?(?:courses?|programmes?|programs?)|how\s+many\s+(?:courses?|programmes?|programs?))/i.test(q)
        && /\bbmu\b|bayelsa\s+medical\s+university/i.test(q)) {
        return {
            speech_text: 'BMU offers health-science programmes including Medicine and Surgery, Nursing Science, Medical Laboratory Science, Public Health, Anatomy, Physiology and Biochemistry. For exact course units, ask by programme and level.',
            display_markdown: 'BMU offers health-science programmes including **Medicine and Surgery, Nursing Science, Medical Laboratory Science, Public Health, Anatomy, Physiology, and Biochemistry**, with related course units varying by programme and level.\n\nFor exact course-unit lists, ask something specific like: **What courses are offered in Medicine and Surgery at 100 level?**',
            topic_slug: 'programmes',
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.92,
            _source: 'fast_intent'
        };
    }

    const structuredOfficers = await _getPrincipalOfficersForAnswer();
    const requestedPrincipalOfficerByName = _detectPrincipalOfficerByName(q, structuredOfficers);
    if (requestedPrincipalOfficerByName) return _buildPrincipalOfficerPersonReply(requestedPrincipalOfficerByName);

    const requestedPrincipalOfficerRole = _detectPrincipalOfficerRole(q);
    if (requestedPrincipalOfficerRole) return _buildPrincipalOfficerReply(requestedPrincipalOfficerRole, structuredOfficers);

    if (_isPrincipalOfficersQuestion(q)) return _buildPrincipalOfficersReply(structuredOfficers);
    if (_isGovernorVisitorQuestion(q)) return _buildGovernorVisitorReply();

    if (_isDepartmentHeadIdentityQuestion(q)) return _buildDepartmentHeadSafeReply(q);
    const admissionCutoffReply = await _buildAdmissionCutoffReply(q);
    if (admissionCutoffReply) return admissionCutoffReply;
    const allProgrammeFeesReply = await _buildAllProgrammeFeesReply(q);
    if (allProgrammeFeesReply) return allProgrammeFeesReply;
    const programmeFeeReply = await _buildStructuredProgrammeFeeReply(q) || _buildProgrammeFeeReply(q);
    if (programmeFeeReply) return programmeFeeReply;
    if (_isMbbsDurationQuestion(q)) return _buildMbbsDurationReply();
    if (_isMbbsAdmissionQuestion(q)) return _buildMbbsAdmissionReply();

    const handbookPolicyReply = _buildHandbookAcademicPolicyReply(q);
    if (handbookPolicyReply) return handbookPolicyReply;

    const registrationRequirementReply = await _buildRegistrationRequirementReply(q);
    if (registrationRequirementReply) return registrationRequirementReply;

    const lawReply = bmuLawService.buildLawReply(q);
    if (lawReply) return lawReply;

    const courseCatalogReply = await courseCatalogService.buildCourseListReply(q);
    if (courseCatalogReply) return courseCatalogReply;

    const programmeOverviewReply = await _buildProgrammeOverviewReply(q);
    if (programmeOverviewReply) return programmeOverviewReply;

    if (_isAboutBmuOverviewQuestion(q)) {
        return {
            speech_text: 'Bayelsa Medical University, BMU, is a Bayelsa State medical university in Yenagoa focused on training health professionals through medicine, nursing, medical laboratory science, public health and related health-science programmes.',
            display_markdown: 'Bayelsa Medical University (BMU) is a Bayelsa State medical university in Yenagoa focused on training health professionals through medicine, nursing, medical laboratory science, public health, and related health-science programmes.\n\nYou can ask me next about BMU programmes, fees, admission requirements, hostels, exams, or student rules.',
            topic_slug: 'about_bmu',
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.95,
            _source: 'fast_intent'
        };
    }

    if (/(courses?\s+(?:are\s+)?offered|programmes?\s+(?:are\s+)?offered|programs?\s+(?:are\s+)?offered|list\s+(?:the\s+)?(?:courses?|programmes?|programs?)|how\s+many\s+(?:courses?|programmes?|programs?))/i.test(q)
        && /\bbmu\b|bayelsa\s+medical\s+university/i.test(q)) {
        return {
            speech_text: 'BMU offers health-science programmes including Medicine and Surgery, Nursing Science, Medical Laboratory Science, Public Health, Anatomy, Physiology and Biochemistry. For exact course units, ask by programme and level.',
            display_markdown: 'BMU offers health-science programmes including **Medicine and Surgery, Nursing Science, Medical Laboratory Science, Public Health, Anatomy, Physiology, and Biochemistry**, with related course units varying by programme and level.\n\nFor exact course-unit lists, ask something specific like: **What courses are offered in Medicine and Surgery at 100 level?**',
            topic_slug: 'programmes',
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.92,
            _source: 'fast_intent'
        };
    }

    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))(\b|[!.,?\s])/.test(q)) {
        return {
            speech_text: 'Hello. I am Dr Tari, your BMU academic advisor. Ask me about programmes, fees, courses, exams, or student policies.',
            display_markdown: 'Hello. I am Dr Tari, your BMU Academic Advisor. Ask me about programmes, fees, courses, exams, hostel, or student policies.',
            topic_slug: 'greeting',
            citations: [],
            suggested_actions: [
                { label: 'Show me BMU programmes and requirements', action: 'open_topic:programmes' },
                { label: 'What are current BMU fees by programme?', action: 'open_topic:fees' }
            ],
            follow_up_questions: [
                'What courses are offered in Medicine and Surgery?',
                'What is the current BMU tuition fee for Nursing Science?',
                'What are the exam and grading rules at BMU?'
            ],
            needs_escalation: false,
            confidence: 0.95,
            _source: 'fast_intent'
        };
    }

    if (/(what\s+can\s+you\s+do|help\s+me|how\s+do\s+i\s+use\s+this|how\s+to\s+use)/.test(q)) {
        return {
            speech_text: 'I can answer BMU questions on programmes, courses, fees, calendar, hostel, and student rules. You can type, tap follow ups, or use voice.',
            display_markdown: 'I can help with BMU programmes, course requirements, fees, academic calendar, hostel, and student rules.\n\nYou can type your question, use voice, or tap suggested follow-up prompts.',
            topic_slug: null,
            citations: [],
            suggested_actions: [
                { label: 'Show me key BMU student handbook topics', action: 'open_topic:conduct' },
                { label: 'What are BMU admission programme options?', action: 'open_topic:programmes' }
            ],
            follow_up_questions: [
                'What are BMU hostel rules for students?',
                'What is the BMU academic calendar for this session?'
            ],
            needs_escalation: false,
            confidence: 0.92,
            _source: 'fast_intent'
        };
    }

    return null;
}

/**
 * Fast keyword-only RAG fallback: a direct FULLTEXT MATCH against documents.
 *
 * Ranking: title matches are weighted 5x more than content matches so a
 * focused 60KB "Fees chart" XLSX out-scores a 1MB curriculum PDF that happens
 * to mention "students" in its director list.
 *
 * Snippet selection: rather than anchoring on the first occurrence of any
 * single query term (which often lands in boilerplate), we slide a window
 * across the document and pick the position with the most query-term hits.
 */
async function _keywordFallback(question) {
    try {
        const q = String(question).slice(0, 200);
        // Primary-source boost: when the Students' Handbook (or whichever
        // pattern is configured) matches at all, its score is multiplied by
        // PRIMARY_SOURCE_BOOST so it surfaces ahead of specialised curricula
        // / regulations that only expand on the handbook's content.
        const titleLike = `%${PRIMARY_SOURCE_PATTERN}%`;
        const rows = await query(
            `SELECT id, title, category, content_text,
                    ((MATCH(title, description) AGAINST(? IN NATURAL LANGUAGE MODE) * 5)
                  +   MATCH(title, description, content_text) AGAINST(? IN NATURAL LANGUAGE MODE))
                  *  CASE WHEN LOWER(title) LIKE ? THEN ? ELSE 1 END
                    AS score,
                    CASE WHEN LOWER(title) LIKE ? THEN 1 ELSE 0 END AS is_primary
             FROM documents
             WHERE is_active = TRUE
               AND content_text IS NOT NULL
             HAVING score > 0
             ORDER BY is_primary DESC, score DESC
             LIMIT ?`,
            [q, q, titleLike, PRIMARY_SOURCE_BOOST, titleLike, KEYWORD_FALLBACK_LIMIT]
        );
        if (!rows.length) return '';
        if (rows[0]?.is_primary) {
            console.log(`[advisorStreamService] keyword fallback: handbook chunk surfaced first (score=${Number(rows[0].score).toFixed(3)})`);
        }

        const SNIPPET_BEFORE = 200;
        const SNIPPET_AFTER  = 1600;
        const WINDOW = SNIPPET_BEFORE + SNIPPET_AFTER;
        const STEP   = 400;

        const stopwords = new Set([
            'what','when','where','which','about','their','this','that','with',
            'have','been','they','will','into','from','your','there','these',
            'those','please','tell','should','would','could'
        ]);
        const terms = [...new Set(
            (q.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter(w => !stopwords.has(w))
        )];

        const snippetFor = (text) => {
            const lower = text.toLowerCase();
            if (!terms.length) return text.slice(0, WINDOW);
            // Slide a window and pick the offset with the highest term-hit count.
            let bestOffset = 0, bestScore = -1;
            for (let off = 0; off < lower.length; off += STEP) {
                const slice = lower.slice(off, off + WINDOW);
                let hits = 0;
                for (const t of terms) if (slice.includes(t)) hits++;
                if (hits > bestScore) { bestScore = hits; bestOffset = off; }
            }
            // If nothing matched at all, fall back to the head of the doc.
            if (bestScore <= 0) return text.slice(0, WINDOW);
            const start = Math.max(0, bestOffset - SNIPPET_BEFORE);
            const end   = Math.min(text.length, bestOffset + WINDOW);
            return (start > 0 ? '… ' : '')
                + text.slice(start, end).replace(/\s+/g, ' ').trim()
                + (end < text.length ? ' …' : '');
        };

        return rows.map(r =>
            `--- ${r.title} (${r.category || 'general'}) ---\n${snippetFor(r.content_text || '')}`
        ).join('\n\n');
    } catch (err) {
        console.warn('[advisorStreamService] keyword fallback failed:', err.message);
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
            console.warn('[advisorStreamService] No fee documents found in database for fee question');
            return '';
        }
        
        console.log(`[advisorStreamService] Found ${docs.length} fee documents`);
        
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
        console.warn('[advisorStreamService] _getFeeDocumentContext error:', err.message);
        return '';
    }
}

async function _fetchRagContext(question) {
    if (!RAG_ENABLED || !question || question.length < 3) return '';

    if (_isOfficeHolderIdentityQuestion(question)) {
        try {
            const leadershipContext = await _getOfficeHolderDocumentContext(question);
            if (leadershipContext) {
                console.log(`[advisorStreamService] Office-holder identity question: using focused leadership retrieval (${leadershipContext.length} chars)`);
                return leadershipContext;
            }
        } catch (err) {
            console.warn('[advisorStreamService] Focused office-holder retrieval failed:', err.message);
        }
    }

    // For fee-related questions, force a direct database search to guarantee
    // fee documents are included even if title patterns don't match exactly.
    const isFeeQuestion = /(fee|fees|tuition|cost|payment|scholarship|financial|bursar|indigene|non[\s-]?indigene)/i.test(question);
    if (isFeeQuestion) {
        try {
            const feeContext = await _getFeeDocumentContext(question);
            if (feeContext) {
                console.log(`[advisorStreamService] Fee question detected: using forced financial document retrieval (${feeContext.length} chars)`);
                return feeContext;
            }
        } catch (err) {
            console.warn('[advisorStreamService] Forced fee document search failed:', err.message);
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
                    console.warn('[advisorStreamService] general RAG retrieve failed:', err.message);
                    return '';
                })
        ),
        priorityDocIds.length
            ? timed(
                retrievalService.retrieve(question, { limit: 5, documentIds: priorityDocIds, skipCache: true })
                    .then(r => r?.context || '')
                    .catch(err => {
                        console.warn('[advisorStreamService] priority RAG retrieve failed:', err.message);
                        return '';
                    })
            )
            : Promise.resolve('')
    ]);

    const merged = _mergeContexts([priorityCtx, generalCtx]);
    if (merged) return merged;

    console.warn('[advisorStreamService] retrieval returned empty context; falling back to FULLTEXT keyword search');
    return await _keywordFallback(question);
}

async function _resolveConversation({ sessionToken, studentId, voiceEnabled }) {
    if (sessionToken) {
        const existing = studentId
            ? await Advisor.getConversationByTokenForStudent(sessionToken, studentId)
            : await Advisor.getConversationByToken(sessionToken);
        if (existing) return existing;
    }

    return await Advisor.createConversation({
        studentId,
        voiceEnabled: voiceEnabled !== false
    });
}

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
 * @param {object} params
 * @param {string} params.question
 * @param {string} [params.inputMode]    'text' | 'voice'
 * @param {string} [params.sessionToken]
 * @param {object} [params.student]
 * @param {boolean}[params.voiceEnabled]
 * @param {'male'|'female'} [params.advisorGender]   drives TTS voice selection
 * @param {(event:string, data:object) => void} params.send  emits an SSE event
 */
async function askStream({
    question, inputMode = 'text', sessionToken, student = null,
    voiceEnabled = true, advisorGender = 'female', send
}) {
    const startedAt = Date.now();
    if (!question || typeof question !== 'string' || !question.trim()) {
        send('error', { error: 'question is required' });
        return;
    }
    const trimmed = question.trim().slice(0, 4000);
    const isOfficeHolderIdentity = _isOfficeHolderIdentityQuestion(trimmed);
    const requestedPrincipalOfficerRole = _detectPrincipalOfficerRole(trimmed);
    const requestedPrincipalOfficerByName = _detectPrincipalOfficerByName(trimmed);
    const isPrincipalOfficersQuestion = _isPrincipalOfficersQuestion(trimmed);
    const isGovernorVisitorQuestion = _isGovernorVisitorQuestion(trimmed);
    const isFeeQuestion = _isGeneralFeeQuestion(trimmed) || _isProgrammeFeeQuestion(trimmed);
    const explicitLawReply = (requestedPrincipalOfficerRole || requestedPrincipalOfficerByName || isPrincipalOfficersQuestion || isGovernorVisitorQuestion || isFeeQuestion || !_isExplicitLawQuestion(trimmed))
        ? null
        : bmuLawService.buildLawReply(trimmed);
    let fastIntentReply = explicitLawReply || ((!requestedPrincipalOfficerRole && !requestedPrincipalOfficerByName && !isPrincipalOfficersQuestion && !isGovernorVisitorQuestion && ADVISOR_FAST_INTENT_ENABLED)
        ? await _buildFastIntentReply(trimmed)
        : null);

    let conversation;
    try {
        conversation = await _resolveConversation({
            sessionToken, studentId: student?.id || null, voiceEnabled
        });
    } catch (err) {
        send('error', { error: `conversation: ${err.message}` });
        return;
    }
    send('session', { sessionToken: conversation.session_token });

    // Persist student turn early so a mid-stream failure still leaves a record.
    try {
        await Advisor.addMessage({
            conversationId: conversation.id,
            role: 'student',
            inputMode,
            text: trimmed
        });
    } catch (err) {
        console.warn('[advisorStreamService] persist student turn failed:', err.message);
    }

    if (fastIntentReply) {
        fastIntentReply = await _sanitizeInteractiveSuggestions(fastIntentReply);
        send('speech_ready', { speech_text: fastIntentReply.speech_text });
        if (fastIntentReply.display_markdown) send('token', { text: fastIntentReply.display_markdown });

        let audio = { provider: 'none', useBrowserFallback: false };
        if (voiceEnabled !== false && conversation.voice_enabled) {
            try {
                audio = await tts.synthesise(fastIntentReply.speech_text, {
                    gender: advisorGender,
                    archive: true,
                    sourceType: 'fast_intent',
                    sourceId: fastIntentReply.topic_slug || null
                });
                if (audio.audioUrl) {
                    send('audio', {
                        provider: audio.provider,
                        audio_url: audio.audioUrl,
                        from_cache: Boolean(audio.fromCache),
                        speech_text: fastIntentReply.speech_text
                    });
                } else {
                    send('audio', {
                        provider: 'browser',
                        use_browser_fallback: true,
                        speech_text: fastIntentReply.speech_text
                    });
                }
            } catch (err) {
                console.warn('[advisorStreamService] fast-intent TTS failed:', err.message);
                audio = { provider: 'browser', useBrowserFallback: true, error: err.message };
                send('audio', {
                    provider: 'browser',
                    use_browser_fallback: true,
                    speech_text: fastIntentReply.speech_text
                });
            }
        }

        let messageId = null;
        try {
            messageId = await Advisor.addMessage({
                conversationId: conversation.id,
                role: 'advisor',
                inputMode: 'text',
                text: fastIntentReply.display_markdown,
                speechText: fastIntentReply.speech_text,
                displayMarkdown: fastIntentReply.display_markdown,
                audioUrl: audio.audioUrl || null,
                citationsJson: JSON.stringify(fastIntentReply.citations || []),
                suggestedActionsJson: JSON.stringify(fastIntentReply.suggested_actions || []),
                followUpsJson: JSON.stringify(fastIntentReply.follow_up_questions || []),
                latencyMs: Date.now() - startedAt
            });
            await Advisor.touchConversation(conversation.id, null);
        } catch (err) {
            console.warn('[advisorStreamService] persist fast-intent advisor turn failed:', err.message);
        }

        send('done', {
            success: true,
            sessionToken: conversation.session_token,
            conversationId: conversation.id,
            messageId,
            reply: {
                speech_text: fastIntentReply.speech_text,
                display_markdown: fastIntentReply.display_markdown,
                topic_slug: fastIntentReply.topic_slug,
                citations: fastIntentReply.citations,
                suggested_actions: fastIntentReply.suggested_actions,
                follow_up_questions: fastIntentReply.follow_up_questions,
                needs_escalation: fastIntentReply.needs_escalation,
                confidence: fastIntentReply.confidence
            },
            audio: {
                provider: audio.provider || 'none',
                audio_url: audio.audioUrl || null,
                from_cache: Boolean(audio.fromCache),
                use_browser_fallback: Boolean(audio.useBrowserFallback)
            },
            meta: {
                latency_ms: Date.now() - startedAt,
                source: 'fast_intent',
                quality: null
            }
        });
        _trackOutcome({ latencyMs: Date.now() - startedAt, source: 'fast_intent', isError: false });
        return;
    }

    // ------------------------------------------------------------------
    // FAQ-cache short-circuit.
    //
    // If an admin has previously promoted (or auto-generated) an answer
    // for a semantically equivalent question, serve it without paying the
    // LLM round-trip. Falls through silently on any error.
    // ------------------------------------------------------------------
    if (faqService && !requestedPrincipalOfficerByName && !requestedPrincipalOfficerRole && !isOfficeHolderIdentity && !isPrincipalOfficersQuestion && !isGovernorVisitorQuestion) {
        try {
            const cached = await faqService.getCachedResponse(trimmed, {
                userId: student?.user_id || null,
                sessionId: conversation.id
            });
            if (cached?.content) {
                const cachedAnswer = persona.scrubAll(cached.content);
                const cachedSpeech = persona.scrubAll(
                    (cachedAnswer.split('\n').find(l => l.trim()) || cachedAnswer).slice(0, 600)
                );
                console.log(`[advisorStreamService] FAQ cache hit: cached_qa_id=${cached.cachedQaId} (${(cached.cacheConfidence * 100).toFixed(1)}%)`);

                // Emit speech, full answer, then audio (cache uses TTS too).
                send('speech_ready', { speech_text: cachedSpeech });
                if (cachedAnswer) send('token', { text: cachedAnswer });

                let audio = { provider: 'none' };
                if (voiceEnabled !== false && conversation.voice_enabled) {
                    try {
                        audio = await tts.synthesise(cachedSpeech, {
                            gender: advisorGender,
                            archive: true,
                            sourceType: 'cached_qa',
                            sourceId: cached.cachedQaId || null
                        });
                        if (audio.audioUrl) {
                            send('audio', {
                                provider: audio.provider,
                                audio_url: audio.audioUrl,
                                from_cache: Boolean(audio.fromCache),
                                speech_text: cachedSpeech
                            });
                        } else {
                            send('audio', {
                                provider: 'browser',
                                use_browser_fallback: true,
                                speech_text: cachedSpeech
                            });
                        }
                    } catch (err) {
                        send('audio', {
                            provider: 'browser', use_browser_fallback: true,
                            speech_text: cachedSpeech, error: err.message
                        });
                    }
                } else {
                    send('audio', { provider: 'none', use_browser_fallback: false, speech_text: cachedSpeech });
                }

                // Persist advisor turn so transcripts stay coherent.
                let citations = [];
                if (Array.isArray(cached.sources)) citations = cached.sources;
                else if (typeof cached.sources === 'string') {
                    try { citations = JSON.parse(cached.sources || '[]'); } catch (_) { citations = []; }
                }
                let messageId = null;
                try {
                    messageId = await Advisor.addMessage({
                        conversationId: conversation.id,
                        role: 'advisor',
                        inputMode: 'text',
                        text: cachedAnswer,
                        speechText: cachedSpeech,
                        displayMarkdown: cachedAnswer,
                        audioUrl: audio.audioUrl || null,
                        citationsJson: JSON.stringify(citations),
                        suggestedActionsJson: JSON.stringify([]),
                        followUpsJson: JSON.stringify([]),
                        latencyMs: Date.now() - startedAt
                    });
                    await Advisor.touchConversation(conversation.id, null);
                } catch (err) {
                    console.warn('[advisorStreamService] persist cached advisor turn failed:', err.message);
                }

                send('done', {
                    success: true,
                    sessionToken: conversation.session_token,
                    conversationId: conversation.id,
                    messageId,
                    reply: {
                        speech_text: cachedSpeech,
                        display_markdown: cachedAnswer,
                        topic_slug: null,
                        citations,
                        suggested_actions: [],
                        follow_up_questions: [],
                        needs_escalation: false,
                        confidence: cached.cacheConfidence || 0.95
                    },
                    audio: {
                        provider:             audio.provider || 'none',
                        audio_url:            audio.audioUrl || null,
                        from_cache:           Boolean(audio.fromCache),
                        use_browser_fallback: Boolean(audio.useBrowserFallback)
                    },
                    meta: {
                        latency_ms: Date.now() - startedAt,
                        source: 'faq_cache',
                        cached_qa_id: cached.cachedQaId,
                        similarity: cached.cacheConfidence,
                        quality: null
                    }
                });
                _trackOutcome({ latencyMs: Date.now() - startedAt, source: 'faq_cache', isError: false });
                return;
            }
        } catch (err) {
            console.warn('[advisorStreamService] FAQ cache lookup failed:', err.message);
        }
    }

    if (requestedPrincipalOfficerByName || requestedPrincipalOfficerRole || isPrincipalOfficersQuestion) {
        const parsed = requestedPrincipalOfficerByName
            ? await _buildStructuredPrincipalOfficerPersonReply(trimmed) || _buildPrincipalOfficerPersonReply(requestedPrincipalOfficerByName)
            : requestedPrincipalOfficerRole
            ? await _buildStructuredPrincipalOfficerReply(requestedPrincipalOfficerRole) || _buildPrincipalOfficerReply(requestedPrincipalOfficerRole)
            : await _buildStructuredPrincipalOfficersReply() || _buildPrincipalOfficersReply();
        send('speech_ready', { speech_text: parsed.speech_text });
        if (parsed.display_markdown) send('token', { text: parsed.display_markdown });

        let audio = { provider: 'none' };
        if (voiceEnabled !== false && conversation.voice_enabled) {
            try {
                audio = await tts.synthesise(parsed.speech_text, {
                    gender: advisorGender,
                    archive: true,
                    sourceType: 'principal_officers_reference',
                    sourceId: requestedPrincipalOfficerByName || requestedPrincipalOfficerRole || 'all'
                });
                if (audio.audioUrl) {
                    send('audio', {
                        provider: audio.provider,
                        audio_url: audio.audioUrl,
                        from_cache: Boolean(audio.fromCache),
                        speech_text: parsed.speech_text
                    });
                } else {
                    send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: parsed.speech_text });
                }
            } catch (err) {
                send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: parsed.speech_text, error: err.message });
            }
        } else {
            send('audio', { provider: 'none', use_browser_fallback: false, speech_text: parsed.speech_text });
        }

        let messageId = null;
        try {
            messageId = await Advisor.addMessage({
                conversationId: conversation.id,
                role: 'advisor',
                inputMode: 'text',
                text: parsed.display_markdown,
                speechText: parsed.speech_text,
                displayMarkdown: parsed.display_markdown,
                audioUrl: audio.audioUrl || null,
                citationsJson: JSON.stringify(parsed.citations || []),
                suggestedActionsJson: JSON.stringify(parsed.suggested_actions || []),
                followUpsJson: JSON.stringify(parsed.follow_up_questions || []),
                latencyMs: Date.now() - startedAt
            });
            await Advisor.touchConversation(conversation.id, null);
        } catch (err) {
            console.warn('[advisorStreamService] persist principal-officers advisor turn failed:', err.message);
        }

        send('done', {
            success: true,
            sessionToken: conversation.session_token,
            conversationId: conversation.id,
            messageId,
            reply: parsed,
            audio: {
                provider: audio.provider || 'none',
                audio_url: audio.audioUrl || null,
                from_cache: Boolean(audio.fromCache),
                use_browser_fallback: Boolean(audio.useBrowserFallback)
            },
            meta: {
                latency_ms: Date.now() - startedAt,
                source: 'principal_officers_reference',
                quality: null
            }
        });
        _trackOutcome({ latencyMs: Date.now() - startedAt, source: 'principal_officers_reference', isError: false });
        return;
    }

    if (isGovernorVisitorQuestion) {
        const parsed = _buildGovernorVisitorReply();
        send('speech_ready', { speech_text: parsed.speech_text });
        if (parsed.display_markdown) send('token', { text: parsed.display_markdown });

        let audio = { provider: 'none' };
        if (voiceEnabled !== false && conversation.voice_enabled) {
            try {
                audio = await tts.synthesise(parsed.speech_text, {
                    gender: advisorGender,
                    archive: true,
                    sourceType: 'governor_visitor_reference',
                    sourceId: 'visitor'
                });
                if (audio.audioUrl) {
                    send('audio', {
                        provider: audio.provider,
                        audio_url: audio.audioUrl,
                        from_cache: Boolean(audio.fromCache),
                        speech_text: parsed.speech_text
                    });
                } else {
                    send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: parsed.speech_text });
                }
            } catch (err) {
                send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: parsed.speech_text, error: err.message });
            }
        } else {
            send('audio', { provider: 'none', use_browser_fallback: false, speech_text: parsed.speech_text });
        }

        let messageId = null;
        try {
            messageId = await Advisor.addMessage({
                conversationId: conversation.id,
                role: 'advisor',
                inputMode: 'text',
                text: parsed.display_markdown,
                speechText: parsed.speech_text,
                displayMarkdown: parsed.display_markdown,
                audioUrl: audio.audioUrl || null,
                citationsJson: JSON.stringify(parsed.citations || []),
                suggestedActionsJson: JSON.stringify(parsed.suggested_actions || []),
                followUpsJson: JSON.stringify(parsed.follow_up_questions || []),
                latencyMs: Date.now() - startedAt
            });
            await Advisor.touchConversation(conversation.id, null);
        } catch (err) {
            console.warn('[advisorStreamService] persist governor visitor advisor turn failed:', err.message);
        }

        send('done', {
            success: true,
            sessionToken: conversation.session_token,
            conversationId: conversation.id,
            messageId,
            reply: parsed,
            audio: {
                provider: audio.provider || 'none',
                audio_url: audio.audioUrl || null,
                from_cache: Boolean(audio.fromCache),
                use_browser_fallback: Boolean(audio.useBrowserFallback)
            },
            meta: {
                latency_ms: Date.now() - startedAt,
                source: 'visitor_governor_reference',
                quality: null
            }
        });
        _trackOutcome({ latencyMs: Date.now() - startedAt, source: 'visitor_governor_reference', isError: false });
        return;
    }

    let history = [];
    let ragContext = '';
    try {
        [history, ragContext] = await Promise.all([
            _buildHistory(conversation.id),
            _fetchRagContext(trimmed)
        ]);
    } catch (err) {
        console.warn('[advisorStreamService] context build failed:', err.message);
    }
    if (ragContext) {
        console.log(`[advisorStreamService] RAG context: ${ragContext.length} chars`);
    } else {
        console.log('[advisorStreamService] RAG context: EMPTY (model will answer from training data)');
    }

    if (isOfficeHolderIdentity) {
        const parsed = _buildOfficeHolderSafeReply(trimmed, ragContext);
        send('speech_ready', { speech_text: parsed.speech_text });
        if (parsed.display_markdown) send('token', { text: parsed.display_markdown });

        let audio = { provider: 'none' };
        if (voiceEnabled !== false && conversation.voice_enabled) {
            try {
                audio = await tts.synthesise(parsed.speech_text, {
                    gender: advisorGender,
                    archive: true,
                    sourceType: 'principal_officers_reference',
                    sourceId: 'office_holder_identity'
                });
                if (audio.audioUrl) {
                    send('audio', {
                        provider: audio.provider,
                        audio_url: audio.audioUrl,
                        from_cache: Boolean(audio.fromCache),
                        speech_text: parsed.speech_text
                    });
                } else {
                    send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: parsed.speech_text });
                }
            } catch (err) {
                send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: parsed.speech_text, error: err.message });
            }
        } else {
            send('audio', { provider: 'none', use_browser_fallback: false, speech_text: parsed.speech_text });
        }

        let messageId = null;
        try {
            messageId = await Advisor.addMessage({
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
                latencyMs: Date.now() - startedAt
            });
            await Advisor.touchConversation(conversation.id, null);
        } catch (err) {
            console.warn('[advisorStreamService] persist office-holder advisor turn failed:', err.message);
        }

        send('done', {
            success: true,
            sessionToken: conversation.session_token,
            conversationId: conversation.id,
            messageId,
            reply: {
                speech_text: parsed.speech_text,
                display_markdown: parsed.display_markdown,
                topic_slug: parsed.topic_slug,
                citations: parsed.citations,
                suggested_actions: parsed.suggested_actions,
                follow_up_questions: parsed.follow_up_questions,
                needs_escalation: parsed.needs_escalation,
                confidence: parsed.confidence
            },
            audio: {
                provider: audio.provider || 'none',
                audio_url: audio.audioUrl || null,
                from_cache: Boolean(audio.fromCache),
                use_browser_fallback: Boolean(audio.useBrowserFallback)
            },
            meta: {
                latency_ms: Date.now() - startedAt,
                tokens_in: null,
                tokens_out: null,
                source: 'office_holder_guard',
                quality: null
            }
        });
        _trackOutcome({ latencyMs: Date.now() - startedAt, source: 'llm', isError: false });
        return;
    }

    const messages = [
        { role: 'system', content: persona.buildSystemPrompt({ studentContext: student, ragContext, question: trimmed }) },
        { role: 'user',   content: persona.buildUserPrompt(trimmed, history) }
    ];

    let accumulated = '';
    let lastAnswerEmitted = 0;
    let speechEmitted = null;     // the speech_text we kicked TTS for
    let ttsPromise = null;
    let llmUsage = {};
    let llmError = null;

    const startTtsIfReady = (speech) => {
        if (speechEmitted || !speech) return;
        speechEmitted = speech;
        send('speech_ready', { speech_text: speech });
        if (voiceEnabled === false || !conversation.voice_enabled) {
            send('audio', { provider: 'none', use_browser_fallback: false, speech_text: speech });
            ttsPromise = Promise.resolve({ provider: 'none' });
            return;
        }
        ttsPromise = tts.synthesise(speech, { gender: advisorGender }).then(audio => {
            if (audio.audioUrl) {
                send('audio', {
                    provider: audio.provider,
                    audio_url: audio.audioUrl,
                    backup_url: audio.audioBackupUrl || null,
                    from_cache: Boolean(audio.fromCache),
                    speech_text: speech
                });
            } else {
                send('audio', {
                    provider: 'browser',
                    use_browser_fallback: true,
                    speech_text: speech,
                    error: audio.error || null
                });
            }
            return audio;
        }).catch(err => {
            console.warn('[advisorStreamService] TTS error:', err.message);
            send('audio', { provider: 'browser', use_browser_fallback: true, speech_text: speech, error: err.message });
            return { provider: 'browser', useBrowserFallback: true };
        });
    };

    try {
        for await (const ev of llm.streamChat(messages)) {
            if (ev.usage) llmUsage = ev.usage;
            if (ev.delta) {
                accumulated += ev.delta;
                const scan = persona.streamScan(accumulated, lastAnswerEmitted);
                if (scan.speech && !speechEmitted) startTtsIfReady(scan.speech);
                if (scan.newAnswer) {
                    send('token', { text: scan.newAnswer });
                    lastAnswerEmitted = scan.totalAnswer;
                }
            }
            if (ev.done) {
                if (ev.usage) llmUsage = ev.usage;
                break;
            }
        }
    } catch (err) {
        llmError = err.message;
        console.error('[advisorStreamService] LLM stream error:', err.message);
    }

    // Final flush: maybe more answer text arrived between last scan and stream end.
    {
        const scan = persona.streamScan(accumulated, lastAnswerEmitted);
        if (scan.speech && !speechEmitted) startTtsIfReady(scan.speech);
        if (scan.newAnswer) {
            send('token', { text: scan.newAnswer });
            lastAnswerEmitted = scan.totalAnswer;
        }
    }

    let parsed;
    if (llmError && !accumulated) {
        parsed = {
            speech_text: "I'm having trouble reaching my knowledge service right now. Please try again in a moment, or I can connect you with a human advisor.",
            display_markdown: "**I'm temporarily unable to answer.** Please try again in a moment.\n\n_If the issue persists, you can request to speak with a human advisor._",
            topic_slug: null, citations: [],
            suggested_actions: [{ label: 'Talk to a human advisor', action: 'escalate_to_human' }],
            follow_up_questions: [], needs_escalation: true, confidence: 0
        };
    } else {
        parsed = persona.parseAdvisorReply(accumulated, trimmed);
    }

    parsed = await _sanitizeInteractiveSuggestions(parsed);

    const groundedState = _buildGroundedFallback(trimmed, parsed, ragContext);
    if (groundedState.override) {
        parsed = {
            ...parsed,
            ...groundedState.override,
            confidence: groundedState.override.confidence,
            citations: groundedState.override.citations || parsed.citations || []
        };
    }

    // If [SPEECH] never closed (model didn't emit [ANSWER]), kick off TTS now
    // using the parsed speech_text — better late than never.
    if (!speechEmitted && parsed.speech_text) startTtsIfReady(parsed.speech_text);

    const audio = ttsPromise ? await ttsPromise.catch(() => ({ provider: 'browser', useBrowserFallback: true })) : { provider: 'none' };

    // Resolve topic
    let topicId = null;
    if (parsed.topic_slug) {
        try {
            const t = await Advisor.findTopicBySlug(parsed.topic_slug);
            topicId = t?.id || null;
        } catch (_) { /* ignore */ }
    }

    let messageId = null;
    let quality = null;
    try {
        messageId = await Advisor.addMessage({
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

        if (messageId) {
            try {
                quality = await responseQualityService.assessAndMaybeCache({
                    advisorMessageId: messageId,
                    conversationId: conversation.id,
                    questionText: trimmed,
                    answerText: parsed.display_markdown || parsed.speech_text,
                    ragContext,
                    citations: parsed.citations || [],
                    needsEscalation: Boolean(parsed.needs_escalation)
                });
            } catch (err) {
                console.warn('[advisorStreamService] response quality scoring failed:', err.message);
            }
        }

        await Advisor.touchConversation(conversation.id, topicId);
    } catch (err) {
        console.warn('[advisorStreamService] persist advisor turn failed:', err.message);
    }

    send('done', {
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
            confidence:          parsed.confidence,
            grounded_mode:      groundedState.grounded_mode,
            fallback_reason:     groundedState.fallback_reason,
            retrieval_confidence: groundedState.retrieval_confidence
        },
        audio: {
            provider:             audio.provider,
            audio_url:            audio.audioUrl || null,
            backup_url:           audio.audioBackupUrl || null,
            from_cache:           Boolean(audio.fromCache),
            use_browser_fallback: Boolean(audio.useBrowserFallback)
        },
        meta: {
            latency_ms: Date.now() - startedAt,
            tokens_in:  llmUsage?.prompt_tokens || null,
            tokens_out: llmUsage?.completion_tokens || null,
            error:      llmError,
            grounded_mode: groundedState.grounded_mode,
            fallback_reason: groundedState.fallback_reason,
            retrieval_confidence: groundedState.retrieval_confidence,
            quality:    quality ? {
                overall: quality.metrics?.overall_score || null,
                addressed: quality.metrics?.addressed_score || null,
                grounded: quality.metrics?.grounding_score || null,
                auto_cache_eligible: Boolean(quality.autoCacheEligible),
                auto_cached: Boolean(quality.autoCached),
                auto_cached_qa_id: quality.cachedQaId || null
            } : null
        }
    });
    _trackOutcome({ latencyMs: Date.now() - startedAt, source: 'llm', isError: Boolean(llmError && !accumulated) });
}

module.exports = {
    askStream,
    getStreamMetrics,
    triggerSloAlert,
    _diagnoseStaticQuestion,
    _buildFastIntentReply,
    _isRetrievableQuestion,
    _sanitizeInteractiveSuggestions,
    _staticFacts: {
        BMU_PRINCIPAL_OFFICERS,
        BMU_VISITOR,
        PROGRAMME_FEES
    }
};
