const extractor = require('../services/ccmasProgrammeExtractorService');

function parseDocumentIds() {
    const arg = process.argv.find(item => item.startsWith('--document-ids='));
    if (!arg) return null;
    return arg
        .split('=')[1]
        .split(',')
        .map(value => Number(value.trim()))
        .filter(value => Number.isInteger(value) && value > 0);
}

(async () => {
    const documentIds = parseDocumentIds();
    const results = await extractor.extractAll({ documentIds });
    console.log('[CCMAS extractor] Completed');
    for (const result of results) {
        console.log(JSON.stringify(result));
    }
    process.exit(0);
})().catch(error => {
    console.error('[CCMAS extractor] Failed:', error);
    process.exit(1);
});
