/**
 * Builds the system prompt for the academic advisor persona and helpers for
 * coercing the LLM's reply into the structured JSON shape the UI needs.
 *
 * Returned schema:
 *   {
 *     "speech_text":        short spoken summary (max ~600 chars, no markdown)
 *     "display_markdown":   richer written reply (markdown OK)
 *     "topic_slug":         one of the seeded topic slugs, or null
 *     "citations":          [{ title, source, snippet? }]
 *     "suggested_actions":  [{ label, action }]            (UI buttons)
 *     "follow_up_questions":[ "short text", ... ]          (chips)
 *     "needs_escalation":   true|false
 *     "confidence":         0..1
 *   }
 */

const ADVISOR_NAME  = process.env.ADVISOR_NAME  || 'Dr. Tari';
const ADVISOR_TITLE = process.env.ADVISOR_TITLE || 'BMU Academic Advisor';
const SPEECH_MAX    = parseInt(process.env.ADVISOR_SPEECH_MAX_CHARS || '600', 10);

const TOPIC_SLUGS = [
    'programmes', 'calendar', 'grading', 'fees', 'hostel',
    'welfare', 'library', 'conduct', 'career'
];

/** Build the system prompt used for every advisor turn. */
function buildSystemPrompt({ studentContext = null, ragContext = '' } = {}) {
    const studentBlock = studentContext
        ? `STUDENT PROFILE:
- Name: ${studentContext.full_name || 'unknown'}
- Matric: ${studentContext.matric_no || 'unknown'}
- Programme: ${studentContext.programme_name || studentContext.programme_code || 'unknown'}
- Level: ${studentContext.level || 'unknown'}
- Session: ${studentContext.current_session || 'unknown'}
You may address the student by first name and tailor the advice to their level/programme.`
        : `The student is not logged in; do not invent personal details. If a question requires personal data (GPA, registration status, fees), ask them to sign in.`;

    const knowledgeBlock = ragContext && ragContext.trim().length > 0
        ? `RELEVANT BMU INFORMATION (use this as the source of truth; cite the document titles):
${ragContext.trim()}`
        : `No specific BMU documents matched this question. Use only widely accepted, general academic-advising knowledge. If the question is BMU-specific and you don't know, say so plainly and offer to escalate to a human advisor.`;

    return `You are ${ADVISOR_NAME}, the ${ADVISOR_TITLE} for Bayelsa Medical University (BMU), Yenagoa, Nigeria.

Your audience is BMU students (mostly undergraduate, including MBBS, BNSc and BMLS programmes). Be warm, encouraging, plain-spoken, and brief. Use Nigerian English where natural. Never invent BMU-specific facts.

${studentBlock}

${knowledgeBlock}

TOPIC TAGS — pick ONE slug from this list for "topic_slug", or null if none fit:
${TOPIC_SLUGS.join(', ')}

OUTPUT FORMAT — reply with a SINGLE JSON object and nothing else. The schema is:
{
  "speech_text":         string,   // short spoken summary, plain text, <= ${SPEECH_MAX} chars
  "display_markdown":    string,   // richer written reply in markdown
  "topic_slug":          string|null,
  "citations":           [ { "title": string, "source": string, "snippet": string } ],
  "suggested_actions":   [ { "label": string, "action": string } ],
  "follow_up_questions": [ string, ... ],         // 2-4 short prompts
  "needs_escalation":    boolean,
  "confidence":          number                    // 0..1
}

RULES:
- "speech_text" must be conversational and concise (one short paragraph). The avatar will read this aloud while the typewriter shows "display_markdown".
- "display_markdown" may use headings, bullet lists, and bold; keep it under ~500 words.
- "citations" must only reference documents that appeared in the RELEVANT BMU INFORMATION section above. Empty array is fine.
- "suggested_actions" map to UI buttons. Supported "action" values: "open_topic:<slug>", "start_study_plan", "escalate_to_human", "open_url:<https-url>".
- Set "needs_escalation": true when the question is outside scope (medical/legal/personal counselling), or when you lack reliable information.
- Do NOT wrap the JSON in markdown code fences. Output raw JSON only.`;
}

/** Build the user message containing the actual question + light history. */
function buildUserPrompt(question, history = []) {
    const recent = history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n');
    if (!recent) return question;
    return `Recent conversation (most recent last):\n${recent}\n\nCurrent question:\n${question}`;
}

/**
 * Coerce the LLM reply into our schema. Tolerates markdown-fenced JSON and
 * mild malformations by falling back to a plain-text answer.
 */
function parseAdvisorReply(rawContent, originalQuestion) {
    const text = (rawContent || '').trim();

    // Strip markdown code fences if the model added them despite instructions.
    const stripped = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();

    let parsed = null;
    try { parsed = JSON.parse(stripped); } catch (_) { /* fall through */ }

    // If JSON parse failed, attempt to grab the largest {...} block.
    if (!parsed) {
        const match = stripped.match(/\{[\s\S]*\}/);
        if (match) {
            try { parsed = JSON.parse(match[0]); } catch (_) { /* ignored */ }
        }
    }

    if (!parsed || typeof parsed !== 'object') {
        // Last-resort fallback: present the raw text as both spoken and written.
        return {
            speech_text: truncate(text || `I could not generate a structured reply. Could you rephrase the question?`, SPEECH_MAX),
            display_markdown: text || 'I could not generate a reply just now. Please try again.',
            topic_slug: null,
            citations: [],
            suggested_actions: [],
            follow_up_questions: [],
            needs_escalation: !text,
            confidence: 0.2,
            _parse_error: true
        };
    }

    // Normalise fields and clamp speech length.
    return {
        speech_text:         truncate(strOrEmpty(parsed.speech_text || parsed.display_markdown || originalQuestion), SPEECH_MAX),
        display_markdown:    strOrEmpty(parsed.display_markdown || parsed.speech_text),
        topic_slug:          TOPIC_SLUGS.includes(parsed.topic_slug) ? parsed.topic_slug : null,
        citations:           Array.isArray(parsed.citations) ? parsed.citations.slice(0, 8) : [],
        suggested_actions:   Array.isArray(parsed.suggested_actions) ? parsed.suggested_actions.slice(0, 6) : [],
        follow_up_questions: Array.isArray(parsed.follow_up_questions) ? parsed.follow_up_questions.slice(0, 4) : [],
        needs_escalation:    Boolean(parsed.needs_escalation),
        confidence:          clamp01(parsed.confidence)
    };
}

function strOrEmpty(v) { return typeof v === 'string' ? v.trim() : ''; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5; }

module.exports = {
    ADVISOR_NAME,
    ADVISOR_TITLE,
    TOPIC_SLUGS,
    buildSystemPrompt,
    buildUserPrompt,
    parseAdvisorReply
};
