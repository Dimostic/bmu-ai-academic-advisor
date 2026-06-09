/**
 * Seed FAQ Script - Generate Q&A pairs from existing documents
 * Run with: node server/scripts/seedFAQ.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const faqService = require('../services/faqService');
const Document = require('../models/Document');
const { query } = require('../../config/db');

async function seedFAQ() {
    console.log('🚀 Starting FAQ generation...\n');

    try {
        // Get all processed documents
        const documents = await query(`
            SELECT id, title, category 
            FROM documents 
            WHERE is_active = TRUE AND embedding_status = 'completed'
        `);

        console.log(`📚 Found ${documents.length} processed documents\n`);

        for (const doc of documents) {
            console.log(`\n📄 Processing: ${doc.title}`);
            console.log('   Generating Q&A pairs... (this may take 1-2 minutes)');

            try {
                const result = await faqService.generateQAFromDocument(doc.id, {
                    maxQuestions: 15,
                    userId: 1 // System/admin user
                });

                if (result.success) {
                    console.log(`   ✅ Generated ${result.questionsGenerated} Q&A pairs`);
                } else {
                    console.log(`   ❌ Failed: ${result.error}`);
                }
            } catch (err) {
                console.log(`   ❌ Error: ${err.message}`);
            }
        }

        // Show summary
        const [stats] = await query(`
            SELECT COUNT(*) as total FROM cached_qa WHERE is_active = TRUE
        `);
        
        console.log(`\n\n✅ FAQ Generation Complete!`);
        console.log(`   Total Q&A pairs: ${stats.total}`);

        // Show by category
        const categoryStats = await query(`
            SELECT fc.name, COUNT(cq.id) as count
            FROM faq_categories fc
            LEFT JOIN cached_qa cq ON cq.category_id = fc.id AND cq.is_active = TRUE
            GROUP BY fc.id
            ORDER BY fc.display_order
        `);

        console.log('\n   By Category:');
        for (const cat of categoryStats) {
            console.log(`   - ${cat.name}: ${cat.count} questions`);
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

seedFAQ();
