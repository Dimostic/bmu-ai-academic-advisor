// Basic training/indexing script for BMU AI Agent
//
// Current system uses DB full-text search (Document.searchByContent).
// This script processes all pending documents (extracts text) so they become searchable.
//
// Usage:
//   npm run train
//
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const documentProcessor = require('./documentProcessor');

async function main() {
    console.log('BMU AI Agent: Training/Indexing Started');
    try {
        const result = await documentProcessor.processAllPending();
        console.log('Training/Indexing Completed');
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    } catch (err) {
        console.error('Training/Indexing Failed:', err.message);
        process.exit(1);
    }
}

main();
