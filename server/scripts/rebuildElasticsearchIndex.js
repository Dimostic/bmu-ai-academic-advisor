#!/usr/bin/env node
/**
 * Rebuild Elasticsearch Index from Database
 * 
 * This script rebuilds the Elasticsearch index with all document chunks
 * from the database. Useful after initial setup or to fix index issues.
 * 
 * Usage:
 *   node server/scripts/rebuildElasticsearchIndex.js
 */

require('dotenv').config();

const elasticsearchService = require('../services/elasticsearchService');
const { query } = require('../../config/db');

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('   Elasticsearch Index Rebuild');
    console.log('   ' + new Date().toISOString());
    console.log('═'.repeat(70));
    
    // Check if Elasticsearch is available
    const isAvailable = await elasticsearchService.isAvailable();
    console.log(`\nElasticsearch status: ${isAvailable ? '✅ Available' : '❌ Not available'}`);
    
    if (!isAvailable) {
        console.log('\nPlease ensure:');
        console.log('  1. Elasticsearch is running: systemctl status elasticsearch');
        console.log('  2. ELASTICSEARCH_ENABLED=true in .env');
        console.log('  3. ELASTICSEARCH_URL is correct (default: http://localhost:9200)');
        process.exit(1);
    }
    
    // Get current stats
    const statsBefore = await elasticsearchService.getStats();
    console.log(`\nCurrent index status:`);
    console.log(`  Documents: ${statsBefore.documentCount || 0}`);
    console.log(`  Size: ${statsBefore.indexSizeHuman || 'N/A'}`);
    
    // Rebuild index
    console.log('\nRebuilding index from database...');
    const result = await elasticsearchService.rebuildIndex();
    
    if (result.success) {
        console.log('\n✅ Index rebuild complete!');
        console.log(`  Total chunks processed: ${result.total || 0}`);
        console.log(`  Successfully indexed: ${result.indexed || 0}`);
        console.log(`  Errors: ${result.errors || 0}`);
        
        // Get new stats
        const statsAfter = await elasticsearchService.getStats();
        console.log(`\nNew index status:`);
        console.log(`  Documents: ${statsAfter.documentCount || 0}`);
        console.log(`  Size: ${statsAfter.indexSizeHuman || 'N/A'}`);
    } else {
        console.log('\n❌ Index rebuild failed:', result.error);
        process.exit(1);
    }
    
    console.log('\n' + '═'.repeat(70));
    console.log('   Completed');
    console.log('═'.repeat(70) + '\n');
    
    process.exit(0);
}

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
