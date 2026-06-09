/**
 * Minimal DeepSeek chat client used by the academic advisor pipeline.
 *
 * Kept intentionally tiny and side-effect free so the advisor flow stays
 * independent of the inherited `aiService.js` (which is policy-assistant
 * shaped and tightly coupled to documents/FAQs/usage limits).
 */
const axios = require('axios');

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL    = process.env.DEEPSEEK_MODEL    || 'deepseek-chat';

function getApiKey() {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY is not configured');
    return key;
}

/**
 * Call DeepSeek chat completions (non-streaming).
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.jsonMode]   request response_format json_object
 * @param {number}  [opts.timeoutMs]
 * @returns {Promise<{content:string, usage:object, raw:object}>}
 */
async function chat(messages, opts = {}) {
    const {
        maxTokens   = parseInt(process.env.AI_MAX_TOKENS || '1024', 10),
        temperature = parseFloat(process.env.AI_TEMPERATURE || '0.6'),
        jsonMode    = false,
        timeoutMs   = 60_000
    } = opts;

    const payload = {
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: 0.9,
        presence_penalty: 0.1,
        frequency_penalty: 0.1
    };
    if (jsonMode) {
        payload.response_format = { type: 'json_object' };
    }

    const response = await axios.post(
        `${BASE_URL}/v1/chat/completions`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${getApiKey()}`,
                'Content-Type': 'application/json'
            },
            timeout: timeoutMs
        }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    return {
        content,
        usage: response.data?.usage || {},
        raw: response.data
    };
}

/**
 * Streaming chat. Async generator yielding {delta, done, usage} events as
 * Server-Sent Events arrive from DeepSeek.
 *
 * Usage:
 *   for await (const ev of streamChat(messages)) {
 *       if (ev.delta) accumulator += ev.delta;
 *       if (ev.done)  // ev.usage is populated
 *   }
 */
async function* streamChat(messages, opts = {}) {
    const {
        maxTokens   = parseInt(process.env.AI_MAX_TOKENS || '1024', 10),
        temperature = parseFloat(process.env.AI_TEMPERATURE || '0.6'),
        timeoutMs   = 60_000
    } = opts;

    const payload = {
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: 0.9,
        presence_penalty: 0.1,
        frequency_penalty: 0.1,
        stream: true
    };

    const response = await axios.post(
        `${BASE_URL}/v1/chat/completions`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${getApiKey()}`,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream'
            },
            timeout: timeoutMs,
            responseType: 'stream'
        }
    );

    let buffer = '';
    let usage = {};

    for await (const chunk of response.data) {
        buffer += chunk.toString('utf8');
        // SSE: events are separated by \n\n; each event has data: lines.
        let nl;
        while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLines = block
                .split('\n')
                .filter(l => l.startsWith('data:'))
                .map(l => l.slice(5).trim());
            const dataStr = dataLines.join('');
            if (!dataStr) continue;
            if (dataStr === '[DONE]') {
                yield { delta: '', done: true, usage };
                return;
            }
            try {
                const json = JSON.parse(dataStr);
                if (json.usage) usage = json.usage;
                const delta = json.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length) {
                    yield { delta, done: false };
                }
            } catch (_) { /* ignore malformed event */ }
        }
    }
    // Stream ended without explicit [DONE]
    yield { delta: '', done: true, usage };
}

module.exports = { chat, streamChat };
