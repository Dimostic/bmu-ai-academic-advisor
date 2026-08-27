#!/usr/bin/env node

const { spawnSync } = require('child_process');

function main() {
    try {
        require.resolve('@playwright/test');
    } catch (_) {
        console.log(JSON.stringify({
            success: true,
            skipped: true,
            reason: '@playwright/test is not installed. Install it and run `npx playwright install chromium` to enable mobile visual checks.'
        }, null, 2));
        return;
    }

    const result = spawnSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['playwright', 'test', '--config=playwright.config.js'],
        { stdio: 'inherit' }
    );
    if (result.error) {
        console.log(JSON.stringify({
            success: true,
            skipped: true,
            reason: `Playwright is installed, but the local command launcher could not start npx: ${result.error.message || result.error}`
        }, null, 2));
        return;
    }
    if (result.status === 0) {
        console.log(JSON.stringify({
            success: true,
            checked: 'Optional Playwright mobile/tablet visual tests'
        }, null, 2));
    }
    process.exit(result.status || 0);
}

main();
