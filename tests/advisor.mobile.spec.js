const { test, expect } = require('@playwright/test');

async function openGuestAdvisor(page, path = '/advisor?demo=1&layoutDebug=1') {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#avatarStage');
}

test.describe('advisor visual layout contracts', () => {
    test('full-page landscape keeps avatar and controls visible', async ({ page }) => {
        await openGuestAdvisor(page);
        const report = await page.evaluate(() => {
            const rect = id => {
                const el = document.getElementById(id) || document.querySelector(id);
                return el ? el.getBoundingClientRect().toJSON() : null;
            };
            return {
                viewport: { width: innerWidth, height: innerHeight },
                topBar: rect('.top-bar'),
                avatarStage: rect('avatarStage'),
                avatarSvg: document.querySelector('#avatarSvgHost svg')?.getBoundingClientRect().toJSON() || null,
                chatPane: rect('.chat-pane'),
                composer: rect('composer'),
                viewToggle: rect('advisorViewToggleBtn')
            };
        });

        expect(report.avatarStage).toBeTruthy();
        expect(report.avatarSvg).toBeTruthy();
        expect(report.composer).toBeTruthy();
        expect(report.viewToggle).toBeTruthy();
        expect(report.avatarSvg.top).toBeGreaterThanOrEqual(report.topBar.bottom - 2);
        expect(report.avatarSvg.bottom).toBeLessThanOrEqual(report.viewport.height + 4);
        expect(report.composer.bottom).toBeLessThanOrEqual(report.viewport.height + 16);
        expect(report.viewToggle.left).toBeGreaterThanOrEqual(0);
        expect(report.viewToggle.right).toBeLessThanOrEqual(report.viewport.width);
    });

    test('normal view does not allow response text to spill horizontally', async ({ page }) => {
        await openGuestAdvisor(page, '/advisor?demo=1&view=normal');
        await page.locator('#questionInput').fill('What are current BMU fees by programme?');
        await page.locator('#sendBtn').click();
        await page.waitForSelector('.bubble--advisor .bubble-body', { timeout: 15000 });
        const overflow = await page.evaluate(() => {
            const transcript = document.getElementById('transcript');
            return transcript ? transcript.scrollWidth - transcript.clientWidth : 0;
        });
        expect(overflow).toBeLessThanOrEqual(2);
    });
});
