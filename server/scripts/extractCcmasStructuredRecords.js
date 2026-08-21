const extractor = require('../services/ccmasStructuredRecordExtractorService');

(async () => {
    const result = await extractor.extractAll();
    console.log('[CCMAS structured extractor] Completed');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
})().catch(error => {
    console.error('[CCMAS structured extractor] Failed:', error);
    process.exit(1);
});
