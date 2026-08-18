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
const ADVISOR_PHASE2_GROUNDED_MODE = process.env.ADVISOR_PHASE2_GROUNDED_MODE === 'true' || process.env.ADVISOR_PHASE2_GROUNDED_MODE === '1';
const ADVISOR_MIN_GROUNDED_CONFIDENCE = parseFloat(process.env.ADVISOR_MIN_GROUNDED_CONFIDENCE || '0.55');
const ADVISOR_MIN_CITATIONS = parseInt(process.env.ADVISOR_MIN_CITATIONS || '1', 10);

let retrievalService = null;
try { retrievalService = require('./retrievalService'); }
catch (err) { console.warn('[advisorService] retrievalService unavailable:', err.message); }

const { query } = require('../../config/db');

const OFFICE_HOLDER_DOC_TITLE = '%profile of bmu%';
const BMU_PRINCIPAL_OFFICERS = [
    { position: 'Vice-Chancellor', name: 'Prof. Dimie Ogoina', note: 'appointed October 2024' },
    { position: 'Deputy Vice-Chancellor Administration', name: 'Prof. Ebi Aloysius Lihah', note: '' },
    { position: 'Deputy Vice-Chancellor Academic', name: 'Prof. Godwill Ziriki', note: 'in charge of Sampou campus' },
    { position: 'Registrar', name: 'Dr. (Mrs) Felicia Akusu', note: '' },
    { position: 'Bursar', name: 'Dr Ebipiado Ombu', note: '' },
    { position: 'University Librarian', name: 'Dr. Abraham Etebu', note: '' }
];
const BMU_VISITOR = {
    role: 'Visitor to the University',
    name: 'Senator Douye Diri',
    office: 'Governor of Bayelsa State'
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
    ['COMMUNITY HEALTH', /\bcommunity\s+health\b/i],
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
    const isIdentityQuestion = /(who\s+is|who\s+heads|who\s+leads|name\s+of|what\s+is\s+the\s+name|current|currently|tell\s+me\s+about|which\s+person|who\s+serves\s+as|\bname\b)/i.test(q);
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
    if (/vice[-\s]?chancellor|vice\s+(?:counsell?or|cancellor|cancel(?:l)?or)|(?:^|\W)v\s*c(?:\W|$)|(^|\W)vc(\W|$)|wise\s+chancellor|first\s+chancellor/i.test(q)) return 'Vice-Chancellor';
    if (/registrar|registerer/i.test(q)) return 'Registrar';
    if (/bursar/i.test(q)) return 'Bursar';
    if (/\b(?:boss|bossa|bosa|busa|bussa|bursah)\b/i.test(q)) return 'Bursar';
    if (/university\s+librarian|\blibrarian\b/i.test(q)) return 'University Librarian';
    return null;
}

function _isGovernorVisitorQuestion(question) {
    const q = String(question || '').toLowerCase();
    return /(governor|visitor\s+(?:to|of)\s+(?:the\s+)?(?:university|bmu|bayelsa\s+medical\s+university)|bayelsa\s+state)/i.test(q)
        && /(who\s+is|name\s+of|current|serves\s+as|visitor)/i.test(q);
}

function _buildPrincipalOfficersReply() {
    const rows = BMU_PRINCIPAL_OFFICERS.map(({ position, name, note }) => ({
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
        speech_text: BMU_PRINCIPAL_OFFICERS.map(({ position, name }) => `${position}: ${name}`).join('; ') + '.',
        display_markdown: `Based on the BMU Brief Institutional Profile (May 2025), the principal officers are:\n\n${table}\n\nAlso listed in the same profile: Governing Council Chair, Prof. Tarila Tebepah; and Visitor to the University, Senator Douye Diri.`,
        topic_slug: 'bmu_principal_officers',
        citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence: 0.99
    };
}

function _buildPrincipalOfficerReply(position) {
    const officer = BMU_PRINCIPAL_OFFICERS.find(item => item.position === position);
    if (!officer) return null;
    const note = officer.note ? `, ${officer.note}` : '';
    return {
        speech_text: `The ${officer.position} of Bayelsa Medical University is ${officer.name}${note}.`,
        display_markdown: `The **${officer.position}** of Bayelsa Medical University is **${officer.name}**${note}.`,
        topic_slug: 'bmu_principal_officer',
        citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
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

function _isAboutBmuOverviewQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    return /^(?:tell\s+me\s+about|what\s+is|describe|introduce|give\s+me\s+an\s+overview\s+of)\s+(?:bmu|bayelsa\s+medical\s+university)\??$/i.test(q)
        || /^(?:about|overview\s+of)\s+(?:bmu|bayelsa\s+medical\s+university)\??$/i.test(q);
}

function _isDepartmentHeadIdentityQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    return /(who\s+heads|who\s+leads|who\s+is\s+(?:the\s+)?head|name\s+of\s+(?:the\s+)?head|current\s+head|\bhod\b)/i.test(q)
        && /(department|head\s+of\s+department|\bhod\b)/i.test(q);
}

function _buildDepartmentHeadSafeReply() {
    return {
        speech_text: 'I do not currently have a verified current name for a specific BMU Head of Department in the records available to me. Please specify the department, and I can check the available BMU documents.',
        display_markdown: "I don't currently have a verified current name for a specific **Head of Department** in the records available to me.\n\nBMU departments are headed by **Heads of Department (HODs)**, but these appointments can change. Please specify the department, and I can check the available BMU documents for that department.",
        topic_slug: 'department_head_current_name_unavailable',
        citations: [],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: true,
        confidence: 0.72
    };
}

function _isMbbsDurationQuestion(question) {
    const q = String(question || '').trim().toLowerCase();
    if (/(fee|fees|tuition|cost|payment|payable|levy|indigene|non[-\s]?indigene)/i.test(q)) return false;
    return /(mbbs|mbchb|medicine\s+and\s+surgery|\bmedicine\b)/i.test(q)
        && /(how\s+long|duration|years?|academic\s+sessions?|utme|direct\s+entry|five[-\s]?year|six[-\s]?year)/i.test(q);
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
        confidence: 0.99
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
            confidence: 0.99
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
        confidence: 0.99
    };
}

function _buildMedicineFeeReply(question) {
    return _buildProgrammeFeeReply(question);
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
            confidence: 0.99
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
            confidence: 0.99
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
        confidence: 0.99
    };
}

async function _buildCommonStaticReply(question) {
    const q = String(question || '').trim().toLowerCase();
    if (!q) return null;

    if (_isDepartmentHeadIdentityQuestion(q)) return _buildDepartmentHeadSafeReply();
    const programmeFeeReply = _buildProgrammeFeeReply(q);
    if (programmeFeeReply) return programmeFeeReply;
    const courseCatalogReply = await courseCatalogService.buildCourseListReply(q);
    if (courseCatalogReply) return courseCatalogReply;
    const lawReply = bmuLawService.buildLawReply(q);
    if (lawReply) return lawReply;
    if (_isMbbsDurationQuestion(q)) return _buildMbbsDurationReply();

    const handbookPolicyReply = _buildHandbookAcademicPolicyReply(q);
    if (handbookPolicyReply) return handbookPolicyReply;

    if (_isAboutBmuOverviewQuestion(q)) {
        return {
            speech_text: 'Bayelsa Medical University, BMU, is a Bayelsa State medical university in Yenagoa focused on training health professionals through medicine, nursing, medical laboratory science, public health and related health-science programmes.',
            display_markdown: 'Bayelsa Medical University (BMU) is a Bayelsa State medical university in Yenagoa focused on training health professionals through medicine, nursing, medical laboratory science, public health, and related health-science programmes.\n\nYou can ask me next about BMU programmes, fees, admission requirements, hostels, exams, or student rules.',
            topic_slug: 'about_bmu',
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.95
        };
    }

    if (/(courses?\s+offered|programmes?\s+offered|programs?\s+offered|list\s+(?:the\s+)?(?:courses?|programmes?|programs?)|how\s+many\s+(?:courses?|programmes?|programs?))/i.test(q)
        && /\bbmu\b|bayelsa\s+medical\s+university/i.test(q)) {
        return {
            speech_text: 'BMU offers health-science programmes including Medicine and Surgery, Nursing Science, Medical Laboratory Science, Public Health, Anatomy, Physiology and Biochemistry. For exact course units, ask by programme and level.',
            display_markdown: 'BMU offers health-science programmes including **Medicine and Surgery, Nursing Science, Medical Laboratory Science, Public Health, Anatomy, Physiology, and Biochemistry**, with related course units varying by programme and level.\n\nFor exact course-unit lists, ask something specific like: **What courses are offered in Medicine and Surgery at 100 level?**',
            topic_slug: 'programmes',
            citations: [{ title: 'BMU Brief Institutional Profile (May 2025)', source: 'BMU profile excerpt' }],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: false,
            confidence: 0.92
        };
    }

    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))(\b|[!.,?\s])/.test(q)) {
        return {
            speech_text: 'Hello. I am Dr Tari, your BMU academic advisor. Ask me about programmes, fees, courses, exams, or student policies.',
            display_markdown: 'Hello. I am Dr Tari, your BMU Academic Advisor. Ask me about programmes, fees, courses, exams, hostel, or student policies.',
            topic_slug: null,
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
            confidence: 0.95
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
            confidence: 0.92
        };
    }

    return null;
}

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
                const candidate = _normalizePersonName(raw);
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
        // Remove profile metadata notes that can trail names.
        .replace(/\((?:appointed|inaugurated|since|effective|acting)[^)]*\)/ig, ' ')
        // Keep title qualifiers e.g. Dr. (Mrs) -> Dr. Mrs
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

        // Fees should anchor to BMU fee structure.
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
        'Vice-Chancellor': /^\s*[-•]?\s*(?:current\s+)?vice[-\s]?chancellor\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Registrar': /^\s*[-•]?\s*registrar\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Bursar': /^\s*[-•]?\s*bursar\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Dean': /^\s*[-•]?\s*dean\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Chancellor': /^\s*[-•]?\s*chancellor\s*[:\-]\s*([^\n\r;]{3,220})/im,
        'Librarian': /^\s*[-•]?\s*(?:university\s+)?librarian\s*[:\-]\s*([^\n\r;]{3,220})/im
    };
    const loosePatterns = {
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

    return {
        grounded_mode: true,
        fallback_reason: reason,
        retrieval_confidence: retrievalConfidence,
        override: {
            speech_text: 'I have some BMU information, but I am not fully confident enough to give a definitive answer on this point yet. Please ask a more specific question or check the official BMU guidance.',
            display_markdown: 'I have some BMU information, but I am not fully confident enough to give a definitive answer on this point yet.\n\nPlease ask a more specific question or check the official BMU guidance.',
            topic_slug: null,
            citations: citations.slice(0, 2),
            suggested_actions: [
                { label: 'Ask a more specific BMU question', action: 'escalate_to_human' },
                { label: 'Show me BMU programme information', action: 'open_topic:programmes' }
            ],
            follow_up_questions: [
                'What is the current BMU admission requirement for my course?',
                'Can you explain the BMU fee structure in more detail?'
            ],
            needs_escalation: false,
            confidence: Math.min(parsedConfidence || 0.5, ADVISOR_MIN_GROUNDED_CONFIDENCE - 0.05)
        }
    };
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
    const requestedPrincipalOfficerRole = _detectPrincipalOfficerRole(trimmed);
    const isPrincipalOfficersQuestion = _isPrincipalOfficersQuestion(trimmed);
    const isGovernorVisitorQuestion = _isGovernorVisitorQuestion(trimmed);

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

    const explicitLawReply = bmuLawService.buildLawReply(trimmed);
    if (explicitLawReply) {
        return await _persistAndPackage({
            conversation,
            parsed: explicitLawReply,
            llmUsage: null,
            voiceEnabled,
            startedAt,
            advisorGender,
            questionText: trimmed,
            ragContext: ''
        });
    }

    const commonStaticReply = !isOfficeHolderIdentity && !requestedPrincipalOfficerRole && !isPrincipalOfficersQuestion && !isGovernorVisitorQuestion
        ? await _buildCommonStaticReply(trimmed)
        : null;
    if (commonStaticReply) {
        return await _persistAndPackage({
            conversation,
            parsed: commonStaticReply,
            llmUsage: null,
            voiceEnabled,
            startedAt,
            advisorGender,
            questionText: trimmed,
            ragContext: ''
        });
    }

    // 2b. FAQ-cache short-circuit. If we already have a curated/auto-
    // generated answer for a semantically equivalent question, serve it
    // without paying the LLM round-trip.
    if (faqService && !isOfficeHolderIdentity && !isPrincipalOfficersQuestion && !isGovernorVisitorQuestion) {
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

    if (requestedPrincipalOfficerRole || isPrincipalOfficersQuestion) {
        const parsed = requestedPrincipalOfficerRole
            ? _buildPrincipalOfficerReply(requestedPrincipalOfficerRole)
            : _buildPrincipalOfficersReply();
        return await _persistAndPackage({
            conversation, parsed, llmUsage: null, voiceEnabled, startedAt, advisorGender,
            questionText: trimmed,
            ragContext: ''
        });
    }

    if (isGovernorVisitorQuestion) {
        const parsed = _buildGovernorVisitorReply();
        return await _persistAndPackage({
            conversation, parsed, llmUsage: null, voiceEnabled, startedAt, advisorGender,
            questionText: trimmed,
            ragContext: ''
        });
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
    const groundedState = _buildGroundedFallback(trimmed, parsed, ragContext);
    const safeParsed = groundedState.override
        ? { ...parsed, ...groundedState.override, confidence: groundedState.override.confidence }
        : parsed;
    return await _persistAndPackage({
        conversation, parsed: safeParsed, llmUsage: llmResult.usage, voiceEnabled, startedAt, advisorGender,
        questionText: trimmed,
        ragContext,
        groundedState
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
    ragContext = '',
    groundedState = { grounded_mode: false, fallback_reason: null, retrieval_confidence: 0 }
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
            confidence:          parsed.confidence,
            grounded_mode:      groundedState.grounded_mode,
            fallback_reason:     groundedState.fallback_reason,
            retrieval_confidence: groundedState.retrieval_confidence
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
    };
}

module.exports = { ask };
