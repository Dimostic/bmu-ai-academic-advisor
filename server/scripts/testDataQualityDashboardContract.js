#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..', '..');
const adminRoutes = fs.readFileSync(path.join(root, 'server', 'routes', 'adminRoutes.js'), 'utf8');
const adminClient = fs.readFileSync(path.join(root, 'client', 'admin.js'), 'utf8');
const pagesCss = fs.readFileSync(path.join(root, 'client', 'pages.css'), 'utf8');

[
    '_buildStructuredQualityReadiness',
    'reviewQueue',
    'categoryHealth',
    'recentFacts',
    'approvedCurrent',
    'pendingReviewCount'
].forEach(marker => {
    assert(adminRoutes.includes(marker), `Admin quality endpoint missing ${marker}`);
});

[
    'renderQualityReadiness',
    'renderQualityHealthGrid',
    'renderQualityReviewQueue',
    'qualityActionHtml',
    'data-structured-quality-section'
].forEach(marker => {
    assert(adminClient.includes(marker), `Admin quality UI missing ${marker}`);
});

[
    '.quality-hero',
    '.quality-score-ring',
    '.quality-health-grid',
    '.quality-health-card',
    'html[data-theme="dark"] .quality-hero'
].forEach(marker => {
    assert(pagesCss.includes(marker), `Admin quality styling missing ${marker}`);
});

console.log(JSON.stringify({
    success: true,
    checked: 'Admin structured data quality dashboard contract'
}, null, 2));
