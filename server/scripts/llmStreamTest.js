// Standalone test of llmClient.streamChat
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const llm = require('../services/llmClient');

(async () => {
    console.log('Calling streamChat...');
    const start = Date.now();
    try {
        let i = 0;
        for await (const ev of llm.streamChat([
            { role: 'system', content: 'You are a friendly assistant.' },
            { role: 'user', content: 'Say hello in one short sentence.' }
        ])) {
            const t = ((Date.now() - start) / 1000).toFixed(2);
            i++;
            if (ev.delta) console.log(`[+${t}s] delta #${i}: ${JSON.stringify(ev.delta)}`);
            if (ev.done)  console.log(`[+${t}s] done. usage=${JSON.stringify(ev.usage)}`);
        }
        console.log(`Total: ${i} events in ${(Date.now() - start)/1000}s`);
    } catch (err) {
        console.error('FAILED:', err.message);
        if (err.response) console.error('status:', err.response.status, 'data:', err.response.data);
    }
})();
