#!/usr/bin/env node
/**
 * Generate FAQs for all documents in the database
 * 
 * This script processes documents in phases to avoid timeouts and API rate limits.
 * Run with: node server/scripts/generateAllFAQs.js
 * 
 * Options:
 *   --doc-id=N     Process only document ID N
 *   --phase=NAME   Run only specific phase (foundational, procedural, quantitative, role_specific, scenario, compliance)
 *   --regenerate   Clear existing Q&A before generating
 *   --simple       Use simple FAQ generation (faster, fewer questions)
 *   --max-chunks=N Maximum number of content chunks to process (default: 5)
 */

require('dotenv').config();

const faqService = require('../services/faqService');
const Document = require('../models/Document');
const { query } = require('../../config/db');
const aiService = require('../services/aiService');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    docId: null,
    phase: null,
    regenerate: false,
    simple: false,
    maxChunks: 5
};

args.forEach(arg => {
    if (arg.startsWith('--doc-id=')) {
        options.docId = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--phase=')) {
        options.phase = arg.split('=')[1];
    } else if (arg === '--regenerate') {
        options.regenerate = true;
    } else if (arg === '--simple') {
        options.simple = true;
    } else if (arg.startsWith('--max-chunks=')) {
        options.maxChunks = parseInt(arg.split('=')[1], 10);
    }
});

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDocumentFAQCount(docId) {
    const result = await query(
        'SELECT COUNT(*) as count FROM cached_qa WHERE document_id = ?',
        [docId]
    );
    return result[0]?.count || 0;
}

/**
 * Simple FAQ generation - directly generates Q&A with smaller prompts
 * This is faster and works better with local Ollama models
 */
async function generateSimpleFAQs(doc) {
    const docId = doc.id;
    const title = doc.title || doc.file_name || 'Document ' + docId;
    const category = doc.category || 'general';
    
    // Get document content from chunks
    const chunks = await query(
        'SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT ?',
        [docId, options.maxChunks]
    );
    
    if (!chunks || chunks.length === 0) {
        console.log('   No content chunks found for document');
        return { generated: 0, errors: ['No content chunks'] };
    }
    
    const content = chunks.map(c => c.content).join('\n\n').substring(0, 12000);
    console.log('   Content length: ' + content.length + ' chars from ' + chunks.length + ' chunks');
    
    const prompt = `Generate FAQ questions and answers from this Bayelsa Medical University document.

DOCUMENT: "${title}"
CATEGORY: ${category}

CONTENT:
${content}

TASK: Create 10-15 FAQ items covering:
1. Key definitions and terms
2. Eligibility requirements
3. Procedures and processes
4. Important numbers (dates, amounts, limits)
5. Rights and responsibilities

OUTPUT FORMAT - Return JSON object with "items" array:
{"items":[
  {"question":"What is...?","answer":"According to Section X, ...","type":"definitional"},
  {"question":"How do I...?","answer":"To apply, you must...","type":"procedural"},
  {"question":"What is the deadline for...?","answer":"The deadline is...","type":"quantitative"}
]}

Important: Return ONLY the JSON object, no other text.`;

    console.log('   Calling AI to generate FAQs...');
    
    try {
        const axios = require('axios');
        const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
        const model = process.env.OLLAMA_CHAT_MODEL || 'llama3.2:3b'; // Use faster model
        
        const response = await axios.post(
            `${ollamaUrl}/api/generate`,
            {
                model: model,
                prompt: prompt,
                stream: false,
                format: 'json',
                options: {
                    temperature: 0.3,
                    num_predict: 2048
                }
            },
            { timeout: 300000 } // 5 minute timeout
        );
        
        const aiResponse = response.data?.response || '';
        console.log('   AI response length: ' + aiResponse.length + ' chars');
        
        // Parse JSON
        let qaItems = [];
        try {
            let jsonStr = aiResponse;
            
            // Try to extract from markdown code block first
            const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1].trim();
            
            // Parse the JSON
            let parsed = JSON.parse(jsonStr);
            
            // Handle various response formats
            if (Array.isArray(parsed)) {
                qaItems = parsed;
            } else if (parsed && typeof parsed === 'object') {
                // Check if it's a single FAQ item (has question and answer)
                if (parsed.question && parsed.answer) {
                    qaItems = [parsed];
                } else {
                    // Look for array in common keys
                    const arrayKeys = ['FAQs', 'faqs', 'questions', 'items', 'data', 'qa', 'QA', 'q_and_a', 'faq_items'];
                    for (const key of arrayKeys) {
                        if (Array.isArray(parsed[key])) {
                            qaItems = parsed[key];
                            break;
                        }
                    }
                    // If still empty, try to find any array value
                    if (qaItems.length === 0) {
                        for (const value of Object.values(parsed)) {
                            if (Array.isArray(value) && value.length > 0) {
                                qaItems = value;
                                break;
                            }
                        }
                    }
                }
            }
        } catch (parseError) {
            console.error('   Failed to parse AI response:', parseError.message);
            console.log('   Raw response:', aiResponse.substring(0, 500));
            return { generated: 0, errors: ['Parse error'] };
        }
        
        if (!Array.isArray(qaItems) || qaItems.length === 0) {
            console.log('   No Q&A items parsed from response');
            console.log('   Raw response preview:', aiResponse.substring(0, 300));
            return { generated: 0, errors: ['No items'] };
        }
        
        console.log('   Parsed ' + qaItems.length + ' Q&A items, saving to database...');
        
        // Save to database
        let savedCount = 0;
        for (const item of qaItems) {
            if (!item.question || !item.answer) continue;
            
            try {
                // Generate embedding for the question
                const embedding = await aiService.generateEmbedding(item.question, true);
                const embeddingJson = embedding ? JSON.stringify(embedding) : null;
                
                await query(`
                    INSERT INTO cached_qa 
                    (document_id, question, question_variations, answer, answer_sources, qa_type, embedding, confidence_score, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                `, [
                    docId,
                    item.question,
                    JSON.stringify(item.variations || []),
                    item.answer,
                    JSON.stringify(item.sources || item.source || []),
                    item.type || 'general',
                    embeddingJson,
                    0.85
                ]);
                savedCount++;
            } catch (saveError) {
                console.error('   Failed to save Q&A:', saveError.message);
            }
        }
        
        console.log('   Saved ' + savedCount + ' Q&A pairs');
        return { generated: savedCount, errors: [] };
        
    } catch (error) {
        console.error('   AI call failed:', error.message);
        return { generated: 0, errors: [error.message] };
    }
}

async function generateFAQsForDocument(doc, phaseFilter = null) {
    const docId = doc.id;
    const title = doc.title || doc.file_name || 'Document ' + docId;
    
    console.log('\n' + '='.repeat(60));
    console.log('Processing: ' + title + ' (ID: ' + docId + ')');
    console.log('='.repeat(60));
    
    const existingCount = await getDocumentFAQCount(docId);
    console.log('   Existing FAQs: ' + existingCount);
    
    if (options.regenerate) {
        console.log('   Clearing existing FAQs (--regenerate flag)');
        await query('DELETE FROM cached_qa WHERE document_id = ?', [docId]);
    }
    
    try {
        let result;
        
        if (options.simple) {
            // Use simple, faster FAQ generation
            console.log('   Using simple FAQ generation (faster)...');
            result = await generateSimpleFAQs(doc);
        } else if (phaseFilter) {
            // Run single phase
            console.log('   Running phase: ' + phaseFilter);
            result = await faqService.regenerateForDocument(docId, [phaseFilter]);
            console.log('   Generated ' + result.generated + ' Q&As in phase ' + phaseFilter);
        } else {
            // Run all phases with auto-generation
            console.log('   Running all phases...');
            result = await faqService.autoGenerateForDocument(docId);
            console.log('   Generated ' + result.generated + ' Q&As total (' + (result.duplicatesSkipped || 0) + ' duplicates skipped)');
        }
        
        const newCount = await getDocumentFAQCount(docId);
        console.log('   Total FAQs now: ' + newCount);
        
        return { success: true, docId, generated: newCount - (options.regenerate ? 0 : existingCount) };
    } catch (error) {
        console.error('   Error: ' + error.message);
        return { success: false, docId, error: error.message };
    }
}

async function main() {
    console.log('\n' + '='.repeat(70));
    console.log('   BMU AI Agent - FAQ Generator');
    console.log('   ' + new Date().toISOString());
    console.log('='.repeat(70));
    
    if (options.docId) {
        console.log('\nMode: Single document (ID: ' + options.docId + ')');
    } else {
        console.log('\nMode: All documents');
    }
    
    if (options.simple) {
        console.log('Generation mode: Simple (faster, uses llama3.2:3b)');
    }
    
    if (options.phase) {
        console.log('Phase filter: ' + options.phase);
    }
    
    if (options.regenerate) {
        console.log('⚠️  Regenerate mode: Will clear existing FAQs before generating');
    }
    
    try {
        let documents;
        
        if (options.docId) {
            // Get single document
            const doc = await Document.findById(options.docId);
            if (!doc) {
                console.error(`\n❌ Document ID ${options.docId} not found`);
                process.exit(1);
            }
            documents = [doc];
        } else {
            // Get all documents
            const result = await query(
                'SELECT * FROM documents WHERE embedding_status = ? ORDER BY id',
                ['completed']
            );
            documents = result || [];
            
            if (!documents.length) {
                // Fallback: get all documents regardless of status
                const allDocs = await query('SELECT * FROM documents ORDER BY id');
                documents = allDocs || [];
            }
        }
        
        console.log(`\n📚 Found ${documents.length} document(s) to process`);
        
        const results = {
            successful: [],
            failed: [],
            totalGenerated: 0
        };
        
        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            console.log(`\n[${i + 1}/${documents.length}] Processing...`);
            
            const result = await generateFAQsForDocument(doc, options.phase);
            
            if (result.success) {
                results.successful.push(result);
                results.totalGenerated += result.generated || 0;
            } else {
                results.failed.push(result);
            }
            
            // Add delay between documents to avoid rate limiting
            if (i < documents.length - 1) {
                console.log(`   ⏳ Waiting 5 seconds before next document...`);
                await sleep(5000);
            }
        }
        
        // Summary
        console.log('\n' + '═'.repeat(70));
        console.log('   SUMMARY');
        console.log('═'.repeat(70));
        console.log(`   ✅ Successful: ${results.successful.length} document(s)`);
        console.log(`   ❌ Failed: ${results.failed.length} document(s)`);
        console.log(`   📊 Total new FAQs generated: ${results.totalGenerated}`);
        
        if (results.failed.length > 0) {
            console.log('\n   Failed documents:');
            results.failed.forEach(f => {
                console.log(`     - Document ${f.docId}: ${f.error}`);
            });
        }
        
        // Get final counts
        console.log('\n   Final FAQ counts by document:');
        for (const doc of documents) {
            const count = await getDocumentFAQCount(doc.id);
            console.log(`     - ${doc.title || doc.file_name}: ${count} FAQs`);
        }
        
        console.log('\n' + '═'.repeat(70));
        console.log('   Completed at: ' + new Date().toISOString());
        console.log('═'.repeat(70) + '\n');
        
    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    }
    
    process.exit(0);
}

main();
