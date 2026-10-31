const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

async function main() {
    const app = express();
    app.use(express.static(path.resolve(__dirname, '../../client')));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    let browser;
    const screenshotDir = path.resolve(__dirname, '../../build/admin-user-regression');
    fs.mkdirSync(screenshotDir, { recursive: true });
    try {
        browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
        for (const viewport of [{ width: 1440, height: 820 }, { width: 1024, height: 472 }]) {
            const page = await browser.newPage({ viewport, hasTouch: viewport.width === 1024 });
            page.setDefaultTimeout(8000);
            const fixtures = [
                { id: 2, email: 'student@bmu.edu.ng', first_name: 'Student', last_name: 'Fixture', role: 'student', is_verified: 0, is_approved: 0, is_active: 1 },
                { id: 3, email: 'staff@bmu.edu.ng', first_name: 'Staff', last_name: 'Fixture', role: 'staff', is_verified: 1, is_approved: 1, is_active: 1 },
                { id: 4, email: 'retry@bmu.edu.ng', first_name: 'Retry', last_name: 'Fixture', role: 'student', is_verified: 0, is_approved: 0, is_active: 1 }
            ];
            let gets = 0, activations = 0, roleChanges = 0, confirms = 0, cancel = true, failNext = false, release = null;
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            page.on('dialog', async d => { confirms++; if (cancel) await d.dismiss(); else await d.accept(); });
            await page.addInitScript(() => {
                localStorage.setItem('bmu_token', 'fixture-only');
                localStorage.setItem('bmu_user', JSON.stringify({ id: 1, role: 'superadmin', firstName: 'Fixture' }));
            });
            await page.route('**/api/**', async route => {
                const url = new URL(route.request().url()), method = route.request().method();
                const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
                if (url.pathname === '/api/admin/users' && method === 'GET') {
                    gets++;
                    if (url.searchParams.has('status')) assert.equal(url.searchParams.get('status'), 'pending');
                    return respond({ success: true, users: fixtures });
                }
                const activate = url.pathname.match(/\/users\/(\d+)\/verify-activate$/);
                if (activate) {
                    activations++;
                    if (failNext) { failNext = false; return respond({ success: false, error: 'Fixture activation failure' }, 500); }
                    if (Number(activate[1]) === 2) await new Promise(resolve => { release = resolve; });
                    Object.assign(fixtures.find(u => u.id === Number(activate[1])), { is_verified: 1, is_approved: 1 });
                    return respond({ success: true });
                }
                if (url.pathname.endsWith('/role')) {
                    roleChanges++;
                    fixtures.find(u => u.id === Number(url.pathname.split('/').at(-2))).role = route.request().postDataJSON().role;
                    return respond({ success: true });
                }
                if (url.pathname.endsWith('/status')) {
                    fixtures.find(u => u.id === Number(url.pathname.split('/').at(-2))).is_active = route.request().postDataJSON().isActive ? 1 : 0;
                }
                return respond({ success: true, overview: {}, users: {}, summary: {}, items: [], entries: [], alerts: [] });
            });
            await page.route(/https:\/\//, route => route.abort());
            await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`, { waitUntil: 'domcontentloaded' });
            // Icon fonts are intentionally offline in this fixture; preserve their click targets.
            await page.addStyleTag({ content: 'button i { display:inline-block; width:16px; height:16px; }' });
            await page.locator('[data-section="users"]').click();
            await page.locator('button[data-act="verify-activate"][data-id="2"]').waitFor();
            for (const id of ['filterPending', 'filterAll', 'filterPending', 'filterAll']) {
                const before = gets;
                await page.locator('#' + id).click();
                await page.waitForFunction(() => !!document.querySelector('select[data-id="3"]'));
                while (gets === before) await page.waitForTimeout(10);
                await page.waitForTimeout(30);
            }
            const activate = page.locator('button[data-act="verify-activate"][data-id="2"]');
            await activate.locator('i').click();
            assert.equal(confirms, 1, 'Refreshing the table must not accumulate confirmation handlers');
            assert.equal(activations, 0, 'Cancel must not activate the account');
            assert.equal(await activate.isEnabled(), true);
            cancel = false;
            await activate.click();
            while (!release) await page.waitForTimeout(10);
            assert.equal(await activate.isDisabled(), true, 'A pending action must show a disabled busy control');
            await activate.dispatchEvent('click');
            assert.equal(activations, 1, 'A repeated click must not create a second activation request');
            release();
            await page.locator('button[data-act="deactivate"][data-id="2"]').waitFor();
            assert.equal(confirms, 2);
            assert.equal(await page.locator('select[data-id="2"]').inputValue(), 'student');
            await page.locator('select[data-id="3"]').selectOption('student');
            await page.waitForTimeout(120);
            assert.equal(roleChanges, 1, 'Role changes must submit once after repeated table reloads');
            assert.equal(await page.locator('select[data-id="3"]').inputValue(), 'student');
            const retry = page.locator('button[data-act="verify-activate"][data-id="4"]');
            failNext = true;
            await retry.click();
            await page.getByText('Fixture activation failure', { exact: true }).waitFor();
            assert.equal(await retry.isEnabled(), true, 'A failed request must release the busy state');
            await retry.click();
            await page.locator('button[data-act="deactivate"][data-id="4"]').waitFor();
            assert.equal(activations, 3);
            assert.equal(confirms, 4);
            assert.deepEqual(errors, []);
            await page.screenshot({ path: path.join(screenshotDir, `users-${viewport.width}.png`), fullPage: true });
            console.log(`PASS ${viewport.width}x${viewport.height}: single confirmation/request, cancel, busy guard, student role save, failure retry.`);
            await page.close();
        }
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
