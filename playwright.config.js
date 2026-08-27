// Optional visual smoke tests for BMU AI Academic Advisor.
// Run with: npm run test:visual-mobile

module.exports = {
    testDir: './tests',
    timeout: 30000,
    retries: 0,
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        {
            name: 'android-tablet-landscape',
            use: {
                viewport: { width: 1024, height: 472 },
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 1.25,
                userAgent: 'Mozilla/5.0 (Linux; Android 15; CM11000Plus) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Safari/537.36'
            }
        },
        {
            name: 'mobile-portrait',
            use: {
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 2
            }
        },
        {
            name: 'desktop-landscape',
            use: {
                viewport: { width: 1440, height: 820 }
            }
        }
    ]
};
