#!/usr/bin/env node

const recentSourceService = require('../services/bmuRecentSourceService');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    const admissionsExpiry = recentSourceService.inferRecentFactExpiry({
        category: 'admissions',
        session_label: '2026/2027',
        fact_text: 'BMU 2026/2027 admissions cutoff marks are now available.'
    });
    assert(admissionsExpiry === '2027-09-30 23:59:59', `Expected session-based expiry, got ${admissionsExpiry}`);

    const registrationExpiry = recentSourceService.inferRecentFactExpiry({
        category: 'registration',
        fact_text: 'Returning student registration for the 2026/2027 session is open.'
    });
    assert(registrationExpiry === '2027-09-30 23:59:59', `Expected detected-session expiry, got ${registrationExpiry}`);

    const generalExpiry = recentSourceService.inferRecentFactExpiry({
        category: 'general',
        fact_text: 'BMU public notice'
    });
    assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(generalExpiry), 'Expected generated MySQL datetime for general facts');

    console.log(JSON.stringify({
        success: true,
        checked: 'Recent BMU facts receive review/expiry windows'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
