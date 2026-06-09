/**
 * Quick streaming smoke test for /api/advisor/ask/stream.
 * Usage: node server/scripts/streamTest.js "What programmes does BMU offer?"
 */
const http = require('http');

const question = process.argv.slice(2).join(' ') || 'What programmes does BMU offer and how do I register?';

function run(label) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ question, voiceEnabled: true, inputMode: 'text' });
        const req = http.request({
            host: '127.0.0.1', port: 3000, path: '/api/advisor/ask/stream', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            console.log(`\n=== ${label} (HTTP ${res.statusCode}) ===`);
            const start = Date.now();
            let buf = '';
            let firstTokenAt = null;
            let speechReadyAt = null;
            let audioAt = null;
            let totalTokens = 0;
            let charsTyped = 0;
            let final = null;

            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    if (!block.trim() || block.startsWith(':')) continue;
                    let event = 'message', data = '';
                    for (const line of block.split('\n')) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) data += line.slice(5).trim();
                    }
                    let payload; try { payload = JSON.parse(data); } catch { continue; }
                    const t = ((Date.now() - start) / 1000).toFixed(2);
                    if (event === 'session') {
                        console.log(`  [+${t}s] session`);
                    } else if (event === 'speech_ready') {
                        speechReadyAt = t;
                        console.log(`  [+${t}s] speech_ready (${payload.speech_text?.length || 0} chars)`);
                    } else if (event === 'token') {
                        if (!firstTokenAt) {
                            firstTokenAt = t;
                            console.log(`  [+${t}s] FIRST TOKEN`);
                        }
                        totalTokens++;
                        charsTyped += (payload.text || '').length;
                    } else if (event === 'audio') {
                        audioAt = t;
                        console.log(`  [+${t}s] audio  provider=${payload.provider} from_cache=${payload.from_cache} ${payload.audio_url ? payload.audio_url.slice(0, 60) + '...' : '(fallback)'}`);
                    } else if (event === 'done') {
                        console.log(`  [+${t}s] done   topic=${payload.reply?.topic_slug} latency_ms=${payload.meta?.latency_ms} from_cache=${payload.audio?.from_cache}`);
                        final = payload;
                    } else if (event === 'error') {
                        console.log(`  [+${t}s] ERROR: ${payload.error}`);
                    }
                }
            });
            res.on('end', () => {
                console.log(`  Summary: ${totalTokens} token events, ${charsTyped} chars typed, total ${((Date.now() - start) / 1000).toFixed(2)}s`);
                console.log(`  Speech: "${final?.reply?.speech_text?.slice(0, 120)}..."`);
                resolve(final);
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    try {
        await run('Pass 1 (cold)');
        console.log('\n--- now expecting cache hit on TTS ---');
        await run('Pass 2 (cache)');
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
    }
})();
