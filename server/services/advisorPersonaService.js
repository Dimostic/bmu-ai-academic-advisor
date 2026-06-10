/**
 * Builds the system prompt for the academic advisor persona and helpers for
 * coercing the LLM's reply into the structured shape the UI needs.
 *
 * Output format the model emits — chosen to be streaming-friendly so the UI
 * can begin typing the answer the moment the [ANSWER] block opens, in
 * parallel with TTS for the [SPEECH] block:
 *
 *   [SPEECH]
 *   <one-paragraph spoken summary, plain text, <= ADVISOR_SPEECH_MAX_CHARS>
 *
 *   [ANSWER]
 *   <richer markdown answer for the typewriter panel>
 *
 *   [META]
 *   {"topic_slug":"...","citations":[...],"suggested_actions":[...],
 *    "follow_up_questions":[...],"needs_escalation":false,"confidence":0.9}
 *
 * Parsed schema (matches what the route returns):
 *   {
 *     speech_text, display_markdown, topic_slug, citations,
 *     suggested_actions, follow_up_questions, needs_escalation, confidence
 *   }
 */

const ADVISOR_NAME  = process.env.ADVISOR_NAME  || 'Dr. Tari';
const ADVISOR_TITLE = process.env.ADVISOR_TITLE || 'BMU Academic Advisor';
const SPEECH_MAX    = parseInt(process.env.ADVISOR_SPEECH_MAX_CHARS || '600', 10);

const TOPIC_SLUGS = [
    'programmes', 'calendar', 'grading', 'fees', 'hostel',
    'welfare', 'library', 'conduct', 'career'
];

const SECTION_RE = {
    speech: /\[SPEECH\][ \t]*\r?\n?/i,
    answer: /\[ANSWER\][ \t]*\r?\n?/i,
    meta:   /\[META\][ \t]*\r?\n?/i
};

/** Build the system prompt used for every advisor turn. */
function buildSystemPrompt({ studentContext = null, ragContext = '' } = {}) {
    const studentBlock = studentContext
        ? `STUDENT PROFILE:
- Name: ${studentContext.full_name || 'unknown'}
- Matric: ${studentContext.matric_no || 'unknown'}
- Programme: ${studentContext.programme_name || studentContext.programme_code || 'unknown'}
- Level: ${studentContext.level || 'unknown'}
- Session: ${studentContext.current_session || 'unknown'}
You may address the student by first name and tailor advice to their level/programme.`
        : `The student is not logged in; do not invent personal details about THIS student.

IMPORTANT distinction:
  - PUBLIC information (fee schedules, course lists, programme requirements, deadlines, policies, calendar, hostel rules, etc.) — answer directly from RELEVANT BMU INFORMATION below.
  - PERSONAL information (the student's own GPA / outstanding fee balance / registration status / transcript / hostel allocation) — ask them to sign in or contact the relevant office.

If a topic is in RELEVANT BMU INFORMATION, USE IT. Do not redirect students to a portal or office for facts the documents already contain.`;

    const knowledgeBlock = ragContext && ragContext.trim().length > 0
        ? `RELEVANT BMU INFORMATION (use this as the source of truth; cite document titles in [META].citations):
${ragContext.trim()}`
        : `No specific BMU documents matched this question. Use only widely accepted, general academic-advising knowledge. If the question is BMU-specific and you don't know, say so plainly and offer to escalate to a human advisor.`;

    return `You are ${ADVISOR_NAME}, the ${ADVISOR_TITLE} for Bayelsa Medical University (BMU), Yenagoa, Nigeria.

Your audience is BMU students (mostly undergraduate, including MBBS, BNSc and BMLS programmes). Be warm, encouraging, plain-spoken, and brief. Use Nigerian English where natural. Never invent BMU-specific facts.

${studentBlock}

${knowledgeBlock}

OUTPUT FORMAT — your reply MUST be exactly three sections, in this order, separated by blank lines. Output the section markers literally on their own line. Do NOT wrap any section in markdown code fences.

[SPEECH]
A short, conversational spoken summary in plain text (no markdown, no lists). One short paragraph. Maximum ${SPEECH_MAX} characters. The avatar will read this aloud.

[ANSWER]
A richer written answer in markdown — headings, bullet lists and bold are welcome. Keep it under ~500 words. The student sees this typed out as you write it.

[META]
A SINGLE JSON object on one or more lines, with these keys:
  "topic_slug":          one of [${TOPIC_SLUGS.map(s => `"${s}"`).join(', ')}] or null
  "citations":           array of { "title": string, "source": string, "snippet"?: string }
                         only reference docs from RELEVANT BMU INFORMATION above; empty array OK
  "suggested_actions":   array of { "label": string, "action": string }
                         action ∈ "open_topic:<slug>" | "start_study_plan" | "escalate_to_human" | "open_url:<https-url>"
  "follow_up_questions": array of 2-4 short prompt strings the student might tap next
  "needs_escalation":    true when the question is outside scope (medical/legal/personal counselling) or you lack reliable info
  "confidence":          number in [0,1]

Rules:
- ALWAYS emit all three sections in this exact order.
- Never put markdown inside [SPEECH] and never put plain spoken commentary inside [META].
- The closing of [META] is the end of your reply.`;
}

/** Build the user message containing the actual question + light history. */
function buildUserPrompt(question, history = []) {
    const recent = history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n');
    if (!recent) return question;
    return `Recent conversation (most recent last):\n${recent}\n\nCurrent question:\n${question}`;
}

/**
 * Parse the model's full reply (delimited format above) into the structured
 * shape the API returns. Tolerant of: missing sections, extra prose before
 * [SPEECH], code-fenced JSON in [META], and trailing commas in [META].
 */
function parseAdvisorReply(rawContent, originalQuestion) {
    const text = (rawContent || '').replace(/\r\n/g, '\n').trim();

    // Locate the three section markers.
    const speechIdx = text.search(SECTION_RE.speech);
    const answerIdx = text.search(SECTION_RE.answer);
    const metaIdx   = text.search(SECTION_RE.meta);

    const after = (idx, re) => {
        if (idx < 0) return -1;
        return idx + text.slice(idx).match(re)[0].length;
    };

    const speechStart = after(speechIdx, SECTION_RE.speech);
    const answerStart = after(answerIdx, SECTION_RE.answer);
    const metaStart   = after(metaIdx,   SECTION_RE.meta);

    let speechText = '';
    let displayMd = '';
    let metaRaw = '';

    if (speechIdx >= 0) {
        const end = answerIdx >= 0 ? answerIdx : (metaIdx >= 0 ? metaIdx : text.length);
        speechText = text.slice(speechStart, end).trim();
    }
    if (answerIdx >= 0) {
        const end = metaIdx >= 0 ? metaIdx : text.length;
        displayMd = text.slice(answerStart, end).trim();
    }
    if (metaIdx >= 0) {
        metaRaw = text.slice(metaStart).trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
    }

    // Fallback: model didn't follow the format at all → use the whole text.
    if (!speechText && !displayMd) {
        return {
            speech_text: truncate(text || `I could not generate a structured reply. Could you rephrase the question?`, SPEECH_MAX),
            display_markdown: text || 'I could not generate a reply just now. Please try again.',
            topic_slug: null, citations: [], suggested_actions: [], follow_up_questions: [],
            needs_escalation: !text, confidence: 0.2,
            _parse_error: true
        };
    }

    let meta = {};
    if (metaRaw) {
        try { meta = JSON.parse(metaRaw); }
        catch (_) {
            // Try to extract the largest {...} block.
            const m = metaRaw.match(/\{[\s\S]*\}/);
            if (m) { try { meta = JSON.parse(m[0]); } catch (_) { /* ignore */ } }
        }
    }

    return {
        speech_text:         truncate(speechText || displayMd, SPEECH_MAX),
        display_markdown:    displayMd || speechText,
        topic_slug:          TOPIC_SLUGS.includes(meta.topic_slug) ? meta.topic_slug : null,
        citations:           Array.isArray(meta.citations) ? meta.citations.slice(0, 8) : [],
        suggested_actions:   Array.isArray(meta.suggested_actions) ? meta.suggested_actions.slice(0, 6) : [],
        follow_up_questions: Array.isArray(meta.follow_up_questions) ? meta.follow_up_questions.slice(0, 4) : [],
        needs_escalation:    Boolean(meta.needs_escalation),
        confidence:          clamp01(meta.confidence)
    };
}

/**
 * Streaming-section detector. Maintains state across chunks; returns the
 * latest (mode, newAnswerText, completedSpeech) tuple given the cumulative
 * accumulated buffer.
 *
 * The streaming route uses this to:
 *   - emit `speech_ready` as soon as [ANSWER] appears (speech is now final)
 *   - emit `token` events with the new ANSWER text since the last call
 *   - know when the buffer has rolled into the [META] section (no more tokens)
 *
 * @param {string} accumulated  full buffered content from the LLM stream so far
 * @param {number} lastAnswerEmitted  number of [ANSWER] characters already sent
 * @returns {{
 *     mode: 'preamble'|'speech'|'answer'|'meta',
 *     speech: string|null,         // populated when speech section is final
 *     newAnswer: string,           // characters to emit as a `token` event now
 *     totalAnswer: number          // total [ANSWER] characters available so far
 * }}
 */
function streamScan(accumulated, lastAnswerEmitted = 0) {
    const text = accumulated || '';
    const sIdx = text.search(SECTION_RE.speech);
    const aIdx = text.search(SECTION_RE.answer);
    const mIdx = text.search(SECTION_RE.meta);

    if (sIdx < 0) {
        return { mode: 'preamble', speech: null, newAnswer: '', totalAnswer: 0 };
    }

    if (aIdx < 0) {
        // Still accumulating speech. Don't emit anything yet — speech is finalised
        // when [ANSWER] appears.
        return { mode: 'speech', speech: null, newAnswer: '', totalAnswer: 0 };
    }

    // [ANSWER] has appeared → speech is now complete.
    const speechStart = sIdx + text.slice(sIdx).match(SECTION_RE.speech)[0].length;
    const speech = text.slice(speechStart, aIdx).trim();

    const answerStart = aIdx + text.slice(aIdx).match(SECTION_RE.answer)[0].length;
    const answerEnd   = mIdx >= 0 ? mIdx : text.length;
    const answerSoFar = text.slice(answerStart, answerEnd);

    const newAnswer = answerSoFar.length > lastAnswerEmitted
        ? answerSoFar.slice(lastAnswerEmitted)
        : '';

    return {
        mode: mIdx >= 0 ? 'meta' : 'answer',
        speech,
        newAnswer,
        totalAnswer: answerSoFar.length
    };
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5; }

module.exports = {
    ADVISOR_NAME,
    ADVISOR_TITLE,
    TOPIC_SLUGS,
    buildSystemPrompt,
    buildUserPrompt,
    parseAdvisorReply,
    streamScan
};
