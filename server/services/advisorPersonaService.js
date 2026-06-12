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
    // Pull the user's first name if we have one (logged-in user). When the
    // route only had a `users` row (no student record) we still set
    // `first_name` so the model can address them by name occasionally.
    const firstName = studentContext?.first_name
        || (studentContext?.full_name || '').trim().split(/\s+/)[0]
        || null;

    const studentBlock = studentContext
        ? `STUDENT PROFILE:
- First name: ${firstName || 'unknown'}
- Full name: ${studentContext.full_name || 'unknown'}
- Matric: ${studentContext.matric_no || 'unknown'}
- Programme: ${studentContext.programme_name || studentContext.programme_code || 'unknown'}
- Level: ${studentContext.level || 'unknown'}
- Session: ${studentContext.current_session || 'unknown'}

ADDRESSING THE STUDENT:
- Use the student's first name SPARINGLY: at most once per reply, and only on roughly one in three replies. Most replies should not address them by name at all.
- Look at the recent conversation history below: if the previous advisor reply already used the student's first name, do NOT use it again this turn.
- NEVER use familial, pidgin, or generic vocatives. Forbidden: "my brother", "my sister", "my friend", "my dear", "bro", "sis", "bestie", "oga", "abeg", "guy", "comrade".
- A neutral opening with no salutation is preferred. If you do open with a name, just use the first name on its own (e.g. "${firstName || 'Aisha'}, ").`
        : `The student is not logged in; do not invent personal details about THIS student.

ADDRESSING THE STUDENT:
- Do NOT use any vocative (no "my brother", "my sister", "my friend", "my dear", "bro", "sis", "bestie", "oga", "abeg", "guy", "comrade", etc.).
- Open replies neutrally — go straight to the answer.

IMPORTANT distinction:
  - PUBLIC information (fee schedules, course lists, programme requirements, deadlines, policies, calendar, hostel rules, etc.) — answer directly from RELEVANT BMU INFORMATION below.
  - PERSONAL information (the student's own GPA / outstanding fee balance / registration status / transcript / hostel allocation) — ask them to sign in or contact the relevant office.

If a topic is in RELEVANT BMU INFORMATION, USE IT. Do not redirect students to a portal or office for facts the documents already contain.`;

    const knowledgeBlock = ragContext && ragContext.trim().length > 0
        ? `RELEVANT BMU INFORMATION (use this as the source of truth; cite document titles in [META].citations):
${ragContext.trim()}`
        : `No specific BMU documents matched this question. Use only widely accepted, general academic-advising knowledge. If the question is BMU-specific and you don't know, say so plainly and offer to escalate to a human advisor.`;

    return `You are ${ADVISOR_NAME}, the ${ADVISOR_TITLE} for Bayelsa Medical University (BMU), Yenagoa, Nigeria.

Your audience is BMU students (mostly undergraduate, including MBBS, BNSc and BMLS programmes). Be warm, encouraging, plain-spoken, and brief. Use Nigerian English where natural.

CRITICAL ANTI-HALLUCINATION RULES — read carefully:
  1. NEVER invent numbers, dates, fees, course codes, names of people, or
     other specific facts. If a number is not in the RELEVANT BMU
     INFORMATION below, do NOT make one up — say you don't have that
     specific number and suggest the Bursary / Registry.
  2. When you DO answer with numbers, quote them character-for-character
     from the document. Do not round, do not "tidy" them, do not convert
     between currencies. The fee tables in the documents are
     authoritative; if they say 600,000 you must say 600,000 — not
     1,200,000 or 750,000 or anything else.
  3. Fees in BMU documents are in Nigerian Naira (NGN) unless the
     document says otherwise.
  4. If you cannot find a number for the EXACT level + indigene/non-indigene
     combination the user asked about, give the closest one you can find
     and clearly say which level/category it applies to.
  5. Do NOT invent BMU faculties or departments. Use faculty/department
      names exactly as written in RELEVANT BMU INFORMATION.
  6. Important BMU naming guardrail: do NOT claim there is a "Faculty of
      Nursing Science" unless the retrieved context explicitly states that.
      In BMU materials, Nursing Science is typically presented as a programme.

${studentBlock}

${knowledgeBlock}

PROGRAMME VOCABULARY — these are all the SAME thing inside BMU documents.
Treat the words on the LEFT as equivalent to the canonical names on the
RIGHT when you read RELEVANT BMU INFORMATION above. If a document only
spells the right-hand name, you may still answer questions phrased with
the left-hand synonyms. NEVER refuse a question simply because the user
used a different synonym for the same programme.

  - "Medicine and Surgery"  =  "MBBS"  =  "MEDICINE" (the programme name in BMU fee tables)
  - "Med & Surg"            =  "MBBS"
  - "Bachelor of Medicine"  =  "MBBS"
  - "Medical doctor course" =  "MBBS"
  - "MBBS"                  =  what the BMU fee structure document calls "TABLE 1: MEDICINE"
                             (Faculty of Clinical Sciences). When the document
                             shows a table titled "MEDICINE" it IS the MBBS
                             programme — quote those numbers when asked about
                             MBBS, Medicine, or Medicine and Surgery.
  - "BDS" / "Dentistry"     =  "TABLE 2: DENTISTRY" / "Faculty of Dental Science"
  - "Nursing" / "BNSc"      =  "Nursing Science" / "TABLE 3: NURSING SCIENCE"
  - "Pharmacy" / "Pharm.D"  =  "Pharmacy and Pharmaceutical Sciences"
  - "BMLS" / "Med Lab"      =  "Medical Laboratory Science"
  - "Optometry" / "OD"      =  "Optometry / Vision Sciences"
  - "Physiotherapy" / "BPT" =  "Physiotherapy / Physical Therapy"
  - "Radiography"           =  "Radiography / Medical Imaging"
  - "Public Health" / "BPH" =  "Public Health"
  - "100 level" / "year 1"  =  "100 level" (first year of any programme)
  - "Indigene"              =  resident of Bayelsa State (typically lower fee)
  - "Non-indigene"          =  not resident of Bayelsa State (typically higher fee)

When the user asks about fees, courses, requirements, or anything else
for a programme by ANY synonym above, search RELEVANT BMU INFORMATION
for the canonical name and answer in whichever phrasing the user used.
If the relevant fee/programme TABLE is in the context, READ THE NUMBERS
FROM THE TABLE and quote them in your answer; do not say the document
"does not include" the information when in fact a labelled table or
section for the same programme is present under one of these synonyms.

IMPORTANT FEE INSTRUCTION:
When the student asks about fees, tuition, costs, payments, scholarships,
or financial matters, you MUST include the specific fee amounts from RELEVANT
BMU INFORMATION in your answer. If financial information is provided below,
use it. Do NOT say "I do not have fee information" if fee tables or cost
data appear in RELEVANT BMU INFORMATION. Students need real numbers, not
deflection to offices.

OUTPUT FORMAT — your reply MUST be exactly three sections, in this order, separated by blank lines. Output the section markers literally on their own line. Do NOT wrap any section in markdown code fences.

[SPEECH]
A short, conversational spoken summary in PLAIN TEXT only. ABSOLUTELY no markdown symbols of any kind: no asterisks (* or **), no hash signs (#), no underscores, no backticks, no square brackets, no bullet markers, no numbered lists. One short paragraph of natural sentences. Maximum ${SPEECH_MAX} characters. The avatar will read this aloud, so write it the way you would speak it — never include the word "asterisk" or "hash" either.

[ANSWER]
A richer written answer for the on-screen panel. Use plain prose with short paragraphs. You MAY use a simple "- " bullet list when a list genuinely helps. Do NOT use heading markers (#, ##, ###), do NOT use bold/italic markers (**, __, *, _), do NOT use code fences or backticks. Keep it under ~500 words. The student sees this typed out as you write it.

[META]
A SINGLE JSON object on one or more lines, with these keys:
  "topic_slug":          one of [${TOPIC_SLUGS.map(s => `"${s}"`).join(', ')}] or null
  "citations":           array of { "title": string, "source": string, "snippet"?: string }
                         only reference docs from RELEVANT BMU INFORMATION above; empty array OK
  "suggested_actions":   array of { "label": string, "action": string }
                         action ∈ "open_topic:<slug>" | "start_study_plan" | "escalate_to_human" | "open_url:<https-url>"
                         IMPORTANT: the "label" is what the student sees AND what gets sent
                         back to you verbatim when they click. So write each label as a
                         complete, specific question they would actually want answered next
                         (e.g. "What courses do 400 level MBBS students take?"), NOT a short
                         topic name. Keep labels under 80 characters.
                         Only include a suggested action if you can answer that label
                         from RELEVANT BMU INFORMATION right now.
  "follow_up_questions": array of 2-4 short prompt strings the student might tap next.
                         Same rule: each one is sent verbatim when clicked, so write them
                         as complete questions, not topics.
                         Only include follow-ups that are answerable from the same
                         retrieved BMU context. If unsure, return fewer follow-ups.
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
        const cleaned = scrubAll(text || '');
        return {
            speech_text: truncate(cleaned || `I could not generate a structured reply. Could you rephrase the question?`, SPEECH_MAX),
            display_markdown: cleaned || 'I could not generate a reply just now. Please try again.',
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
        speech_text:         truncate(scrubAll(speechText || displayMd), SPEECH_MAX),
        display_markdown:    scrubAll(displayMd || speechText),
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
    let answerSoFar = text.slice(answerStart, answerEnd);

    // While the [META] marker has NOT yet appeared, the model may be in the
    // middle of typing it. Hold back the trailing characters that could be a
    // prefix of "[META]" so we don't briefly leak "[ME" / "[" into the
    // typewriter panel before the next chunk arrives.
    if (mIdx < 0) {
        const hb = partialMetaTailLength(answerSoFar);
        if (hb > 0) answerSoFar = answerSoFar.slice(0, answerSoFar.length - hb);
    }

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

// ---------------------------------------------------------------------------
// Output scrubbing.
//
// Even with explicit "no markdown" instructions, DeepSeek occasionally
// emits **bold** / ### Headings / `code` and casual vocatives like "My
// brother,". We strip those out belt-and-braces so the typewriter and TTS
// receive clean text.
//
// `scrubMarkdown`  — used for both [SPEECH] and the [ANSWER] panel since the
//                    client renders the answer with `textContent` (not a
//                    markdown renderer). It removes formatting *symbols* but
//                    keeps the surrounding letters / numbers intact.
// `scrubVocatives` — strips disallowed openers / interjections so we never
//                    say "my brother" / "abeg" etc., regardless of locale.
// `scrubAll`       — convenience wrapper that does both, plus tidies up
//                    leftover punctuation (e.g. "  ,  " → ", ").
// ---------------------------------------------------------------------------

function scrubMarkdown(text) {
    if (!text) return text;
    let s = String(text);
    // Code fences and inline code → keep the inner text only.
    s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');
    s = s.replace(/`([^`\n]+)`/g, '$1');
    // Bold / italic — strip the wrapping symbols, keep the content.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    s = s.replace(/__([^_\n]+)__/g, '$1');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=$|[^*\w])/g, '$1$2');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=$|[^_\w])/g, '$1$2');
    // Strikethrough.
    s = s.replace(/~~([^~\n]+)~~/g, '$1');
    // Heading markers at the start of a line.
    s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
    // Blockquote markers at the start of a line.
    s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
    // Markdown links [text](url) → text.
    s = s.replace(/\[([^\]\n]+)\]\((?:https?:\/\/|mailto:|\/)[^\s)]+\)/g, '$1');
    // Stray asterisks / hashes that survived (single chars, not followed by
    // word boundary). Keep `#1` etc. so we don't mangle things like "#1 in
    // Bayelsa".
    s = s.replace(/\*+/g, '');
    s = s.replace(/(^|\s)#{2,6}(?=\s)/g, '$1');
    return s;
}

// Disallowed openers / interjections. We anchor on word boundaries so we
// don't accidentally maul "brotherhood" or "abegail".
const VOCATIVE_RE = new RegExp(
    '(?:^|(?<=[\\s\\.\\?\\!,;:—\\-]))' +
    '(?:my\\s+(?:brother|sister|friend|dear|guy|love|people)|' +
        'bros|sis|bestie|oga|abeg|comrade|chief)' +
    '(?=[\\s\\.\\?\\!,;:—\\-]|$)',
    'gi'
);

function scrubVocatives(text) {
    if (!text) return text;
    let s = String(text)
        .replace(VOCATIVE_RE, '')
        // Tidy up any "  ," / " ." left behind, plus stray double-spaces.
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ');
    // Strip leading punctuation/whitespace exposed by vocative removal
    // ("My brother, the fees..." → ", the fees..." → "the fees...").
    s = s.replace(/^[\s,.;:!?\-—]+/, '');
    // Capitalise the first letter if our removal exposed a lowercase opener.
    s = s.replace(/^([a-z])/, (m, c) => c.toUpperCase());
    return s.trim();
}

function scrubAll(text) {
    return scrubVocatives(scrubMarkdown(text));
}

/**
 * If the trailing characters of `text` could be a partial match for the
 * literal string "[META]" (or any longer marker we use), return how many
 * tail characters to hold back from the streamed [ANSWER] output.
 *
 * Example:
 *   text = "...help.\n\n[ME"   → returns 3   (3 chars are a prefix of "[META]")
 *   text = "...help."          → returns 0
 *   text = "...help.\n\n["     → returns 1
 *
 * This prevents the UI from briefly flashing "[ME" before the second chunk
 * carrying "TA]" arrives and the section detector finally trips.
 */
function partialMetaTailLength(text) {
    if (!text) return 0;
    const META = '[META]';
    const max = Math.min(META.length - 1, text.length);
    for (let len = max; len > 0; len--) {
        if (META.startsWith(text.slice(text.length - len))) return len;
    }
    return 0;
}

module.exports = {
    ADVISOR_NAME,
    ADVISOR_TITLE,
    TOPIC_SLUGS,
    buildSystemPrompt,
    buildUserPrompt,
    parseAdvisorReply,
    streamScan,
    scrubAll,
    scrubMarkdown,
    scrubVocatives
};
