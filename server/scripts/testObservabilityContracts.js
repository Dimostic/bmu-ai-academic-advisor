#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    const advisor = read('server/services/advisorStreamService.js');
    const adminRoutes = read('server/routes/adminRoutes.js');
    const quality = read('server/services/responseQualityService.js');
    const client = read('client/advisor.js');

    [
        '_metrics',
        '_trackOutcome',
        'p95LatencyMs',
        'faqCacheHits',
        'fastIntentHits',
        'llmCalls',
        'errorRatePct'
    ].forEach(fragment => assert(advisor.includes(fragment), `Advisor service missing observability marker: ${fragment}`));

    [
        '/metrics/retrieval',
        '/metrics/faq',
        '/metrics/performance',
        '/advisor/health-overview',
        '/advisor/quality-summary',
        '/advisor/quality-trend'
    ].forEach(fragment => assert(adminRoutes.includes(fragment), `Admin routes missing metrics endpoint: ${fragment}`));

    [
        'advisor_response_quality',
        'feedback',
        'cache'
    ].forEach(fragment => assert(quality.toLowerCase().includes(fragment), `Response quality service missing marker: ${fragment}`));

    assert(client.includes('BMUAdvisorVoiceState'), 'Client must expose voice-state diagnostics');
    assert(client.includes('lastApiEndpoint'), 'Client voice diagnostics must include last API endpoint');
    assert(client.includes('lastAskInputMode'), 'Client voice diagnostics must include input mode');

    console.log(JSON.stringify({
        success: true,
        checked: 'Advisor observability contracts'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
