#!/usr/bin/env node
/**
 * Performance Testing Script for BMU AI Agent
 * 
 * Tests and measures:
 * 1. Retrieval latency
 * 2. LLM response time
 * 3. FAQ cache hit rates
 * 4. End-to-end response time
 * 
 * Usage:
 *   node server/scripts/performanceTest.js [--queries=N] [--iterations=N] [--verbose]
 */

require('dotenv').config();

const { query } = require('../../config/db');
const aiService = require('../services/aiService');
const retrievalService = require('../services/retrievalService');
const faqService = require('../services/faqService');
const vectorStore = require('../services/vectorStore');

// Test queries covering different types
const TEST_QUERIES = [
    // Definitional
    "What is academic staff?",
    "Who is the Chancellor of BMU?",
    "What does tenure mean?",
    
    // Procedural
    "How do I apply for annual leave?",
    "What is the process for promotion?",
    "How to submit a grievance?",
    
    // Eligibility
    "Am I eligible for housing allowance?",
    "What are the requirements for admission?",
    "Who can apply for study leave?",
    
    // Quantitative
    "How many days of annual leave am I entitled to?",
    "What is the probation period for new staff?",
    "What is the retirement age?",
    
    // Policy
    "What is the disciplinary policy?",
    "Explain the examination regulations",
    "What are the rules for staff conduct?",
    
    // Complex
    "Can a senior lecturer on probation apply for sabbatical leave?",
    "What happens if I exceed my sick leave days?",
    "How is salary calculated for part-time staff?"
];

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    queries: 10,
    iterations: 3,
    verbose: false,
    testType: 'all' // all, retrieval, llm, faq
};

args.forEach(arg => {
    if (arg.startsWith('--queries=')) {
        options.queries = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--iterations=')) {
        options.iterations = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--verbose') {
        options.verbose = true;
    } else if (arg.startsWith('--test=')) {
        options.testType = arg.split('=')[1];
    }
});

// Performance metrics storage
const metrics = {
    retrieval: {
        times: [],
        cacheHits: 0,
        cacheMisses: 0,
        avgChunksReturned: 0
    },
    faq: {
        times: [],
        hits: 0,
        misses: 0
    },
    llm: {
        times: [],
        tokensGenerated: 0
    },
    endToEnd: {
        times: []
    }
};

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Test retrieval performance
 */
async function testRetrieval(queries) {
    console.log('\n📊 Testing Retrieval Performance...');
    console.log('=' .repeat(60));
    
    const results = [];
    
    for (const queryText of queries) {
        const start = Date.now();
        
        try {
            const result = await retrievalService.retrieve(queryText, {
                limit: 5,
                skipCache: false
            });
            
            const elapsed = Date.now() - start;
            
            results.push({
                query: queryText,
                time: elapsed,
                chunksReturned: result.chunks?.length || 0,
                confidence: result.confidence,
                fromCache: result.fromCache || false,
                type: result.type
            });
            
            metrics.retrieval.times.push(elapsed);
            
            if (result.fromCache) {
                metrics.retrieval.cacheHits++;
            } else {
                metrics.retrieval.cacheMisses++;
            }
            
            if (options.verbose) {
                console.log(`  ✓ "${queryText.substring(0, 40)}..." - ${elapsed}ms (${result.chunks?.length || 0} chunks)`);
            }
            
        } catch (error) {
            console.error(`  ✗ "${queryText.substring(0, 40)}..." - Error: ${error.message}`);
            results.push({ query: queryText, time: -1, error: error.message });
        }
        
        // Small delay between queries
        await sleep(100);
    }
    
    // Calculate statistics
    const validTimes = results.filter(r => r.time >= 0).map(r => r.time);
    const avgTime = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    const minTime = Math.min(...validTimes);
    const maxTime = Math.max(...validTimes);
    const p95Time = validTimes.sort((a, b) => a - b)[Math.floor(validTimes.length * 0.95)] || maxTime;
    
    metrics.retrieval.avgChunksReturned = results.reduce((a, r) => a + (r.chunksReturned || 0), 0) / results.length;
    
    console.log('\n📈 Retrieval Results:');
    console.log(`  Average: ${avgTime.toFixed(2)}ms`);
    console.log(`  Min: ${minTime}ms`);
    console.log(`  Max: ${maxTime}ms`);
    console.log(`  P95: ${p95Time}ms`);
    console.log(`  Cache Hits: ${metrics.retrieval.cacheHits}/${queries.length}`);
    console.log(`  Avg Chunks: ${metrics.retrieval.avgChunksReturned.toFixed(1)}`);
    
    return results;
}

/**
 * Test FAQ cache performance
 */
async function testFAQCache(queries) {
    console.log('\n📊 Testing FAQ Cache Performance...');
    console.log('='.repeat(60));
    
    const results = [];
    
    for (const queryText of queries) {
        const start = Date.now();
        
        try {
            const result = await faqService.findSimilarQuestion(queryText);
            const elapsed = Date.now() - start;
            
            results.push({
                query: queryText,
                time: elapsed,
                hit: !!result?.cachedQA,
                similarity: result?.similarityScore || 0
            });
            
            metrics.faq.times.push(elapsed);
            
            if (result?.cachedQA) {
                metrics.faq.hits++;
                if (options.verbose) {
                    console.log(`  ✓ "${queryText.substring(0, 40)}..." - HIT (${(result.similarityScore * 100).toFixed(1)}%) ${elapsed}ms`);
                }
            } else {
                metrics.faq.misses++;
                if (options.verbose) {
                    console.log(`  ○ "${queryText.substring(0, 40)}..." - MISS ${elapsed}ms`);
                }
            }
            
        } catch (error) {
            console.error(`  ✗ "${queryText.substring(0, 40)}..." - Error: ${error.message}`);
            results.push({ query: queryText, time: -1, error: error.message });
        }
        
        await sleep(50);
    }
    
    const validTimes = results.filter(r => r.time >= 0).map(r => r.time);
    const avgTime = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    
    console.log('\n📈 FAQ Cache Results:');
    console.log(`  Average Lookup: ${avgTime.toFixed(2)}ms`);
    console.log(`  Hit Rate: ${((metrics.faq.hits / queries.length) * 100).toFixed(1)}%`);
    console.log(`  Hits: ${metrics.faq.hits}, Misses: ${metrics.faq.misses}`);
    
    return results;
}

/**
 * Test LLM response generation
 */
async function testLLMResponse(queries) {
    console.log('\n📊 Testing LLM Response Performance...');
    console.log('='.repeat(60));
    
    const results = [];
    // Use fewer queries for LLM test (expensive)
    const testQueries = queries.slice(0, Math.min(5, queries.length));
    
    for (const queryText of testQueries) {
        const start = Date.now();
        
        try {
            // Get context first
            const retrieval = await retrievalService.retrieve(queryText, { limit: 3 });
            
            const llmStart = Date.now();
            
            // Generate response
            const response = await aiService.generateResponse(queryText, [], {
                context: retrieval.context,
                maxTokens: 512
            });
            
            const llmTime = Date.now() - llmStart;
            const totalTime = Date.now() - start;
            
            results.push({
                query: queryText,
                llmTime,
                totalTime,
                responseLength: response?.content?.length || 0
            });
            
            metrics.llm.times.push(llmTime);
            metrics.endToEnd.times.push(totalTime);
            
            if (options.verbose) {
                console.log(`  ✓ "${queryText.substring(0, 40)}..." - LLM: ${llmTime}ms, Total: ${totalTime}ms`);
            }
            
        } catch (error) {
            console.error(`  ✗ "${queryText.substring(0, 40)}..." - Error: ${error.message}`);
            results.push({ query: queryText, llmTime: -1, totalTime: -1, error: error.message });
        }
        
        // Delay between LLM calls to avoid rate limiting
        await sleep(1000);
    }
    
    const validLLMTimes = results.filter(r => r.llmTime >= 0).map(r => r.llmTime);
    const validTotalTimes = results.filter(r => r.totalTime >= 0).map(r => r.totalTime);
    
    const avgLLM = validLLMTimes.reduce((a, b) => a + b, 0) / validLLMTimes.length;
    const avgTotal = validTotalTimes.reduce((a, b) => a + b, 0) / validTotalTimes.length;
    
    console.log('\n📈 LLM Response Results:');
    console.log(`  Average LLM Time: ${avgLLM.toFixed(2)}ms`);
    console.log(`  Average End-to-End: ${avgTotal.toFixed(2)}ms`);
    console.log(`  Min LLM: ${Math.min(...validLLMTimes)}ms`);
    console.log(`  Max LLM: ${Math.max(...validLLMTimes)}ms`);
    
    return results;
}

/**
 * Test embedding generation performance
 */
async function testEmbeddings(queries) {
    console.log('\n📊 Testing Embedding Generation Performance...');
    console.log('='.repeat(60));
    
    const results = [];
    const testQueries = queries.slice(0, Math.min(10, queries.length));
    
    for (const queryText of testQueries) {
        // Test without cache
        const startNoCache = Date.now();
        try {
            await aiService.generateEmbedding(queryText, false);
            const elapsedNoCache = Date.now() - startNoCache;
            
            // Test with cache (second call)
            const startWithCache = Date.now();
            await aiService.generateEmbedding(queryText, true);
            const elapsedWithCache = Date.now() - startWithCache;
            
            results.push({
                query: queryText,
                noCacheTime: elapsedNoCache,
                withCacheTime: elapsedWithCache
            });
            
            if (options.verbose) {
                console.log(`  ✓ "${queryText.substring(0, 40)}..." - NoCache: ${elapsedNoCache}ms, WithCache: ${elapsedWithCache}ms`);
            }
            
        } catch (error) {
            console.error(`  ✗ "${queryText.substring(0, 40)}..." - Error: ${error.message}`);
        }
        
        await sleep(100);
    }
    
    const avgNoCache = results.reduce((a, r) => a + r.noCacheTime, 0) / results.length;
    const avgWithCache = results.reduce((a, r) => a + r.withCacheTime, 0) / results.length;
    
    console.log('\n📈 Embedding Results:');
    console.log(`  Average (no cache): ${avgNoCache.toFixed(2)}ms`);
    console.log(`  Average (with cache): ${avgWithCache.toFixed(2)}ms`);
    console.log(`  Cache Speedup: ${(avgNoCache / avgWithCache).toFixed(1)}x`);
    
    return results;
}

/**
 * Generate performance report
 */
function generateReport() {
    console.log('\n');
    console.log('═'.repeat(70));
    console.log('   PERFORMANCE TEST REPORT');
    console.log('═'.repeat(70));
    console.log(`   Date: ${new Date().toISOString()}`);
    console.log(`   Queries Tested: ${options.queries}`);
    console.log(`   Iterations: ${options.iterations}`);
    console.log('');
    
    // Retrieval Metrics
    if (metrics.retrieval.times.length > 0) {
        const avgRetrieval = metrics.retrieval.times.reduce((a, b) => a + b, 0) / metrics.retrieval.times.length;
        const cacheHitRate = metrics.retrieval.cacheHits / (metrics.retrieval.cacheHits + metrics.retrieval.cacheMisses) * 100;
        
        console.log('   📁 RETRIEVAL PERFORMANCE');
        console.log('   ─'.repeat(30));
        console.log(`   Average Latency:      ${avgRetrieval.toFixed(2)}ms`);
        console.log(`   Cache Hit Rate:       ${cacheHitRate.toFixed(1)}%`);
        console.log(`   Avg Chunks Returned:  ${metrics.retrieval.avgChunksReturned.toFixed(1)}`);
        console.log('');
    }
    
    // FAQ Metrics
    if (metrics.faq.times.length > 0) {
        const avgFaq = metrics.faq.times.reduce((a, b) => a + b, 0) / metrics.faq.times.length;
        const faqHitRate = metrics.faq.hits / (metrics.faq.hits + metrics.faq.misses) * 100;
        
        console.log('   ❓ FAQ CACHE PERFORMANCE');
        console.log('   ─'.repeat(30));
        console.log(`   Average Lookup:       ${avgFaq.toFixed(2)}ms`);
        console.log(`   Hit Rate:             ${faqHitRate.toFixed(1)}%`);
        console.log('');
    }
    
    // LLM Metrics
    if (metrics.llm.times.length > 0) {
        const avgLLM = metrics.llm.times.reduce((a, b) => a + b, 0) / metrics.llm.times.length;
        
        console.log('   🤖 LLM RESPONSE PERFORMANCE');
        console.log('   ─'.repeat(30));
        console.log(`   Average Response:     ${avgLLM.toFixed(2)}ms`);
        console.log('');
    }
    
    // End-to-End Metrics
    if (metrics.endToEnd.times.length > 0) {
        const avgE2E = metrics.endToEnd.times.reduce((a, b) => a + b, 0) / metrics.endToEnd.times.length;
        
        console.log('   ⏱️  END-TO-END PERFORMANCE');
        console.log('   ─'.repeat(30));
        console.log(`   Average Total:        ${avgE2E.toFixed(2)}ms`);
        console.log('');
    }
    
    // KPIs Assessment
    console.log('   📋 KPI ASSESSMENT');
    console.log('   ─'.repeat(30));
    
    const kpis = [
        { name: 'Retrieval < 500ms', target: 500, actual: metrics.retrieval.times.length > 0 ? metrics.retrieval.times.reduce((a, b) => a + b, 0) / metrics.retrieval.times.length : 0 },
        { name: 'FAQ Lookup < 100ms', target: 100, actual: metrics.faq.times.length > 0 ? metrics.faq.times.reduce((a, b) => a + b, 0) / metrics.faq.times.length : 0 },
        { name: 'FAQ Hit Rate > 30%', target: 30, actual: metrics.faq.hits / (metrics.faq.hits + metrics.faq.misses || 1) * 100, isPercent: true },
        { name: 'End-to-End < 5s', target: 5000, actual: metrics.endToEnd.times.length > 0 ? metrics.endToEnd.times.reduce((a, b) => a + b, 0) / metrics.endToEnd.times.length : 0 }
    ];
    
    for (const kpi of kpis) {
        if (kpi.actual === 0) continue;
        const passed = kpi.isPercent ? kpi.actual >= kpi.target : kpi.actual <= kpi.target;
        const status = passed ? '✅' : '❌';
        const value = kpi.isPercent ? `${kpi.actual.toFixed(1)}%` : `${kpi.actual.toFixed(0)}ms`;
        console.log(`   ${status} ${kpi.name}: ${value}`);
    }
    
    console.log('');
    console.log('═'.repeat(70));
    console.log('');
}

async function main() {
    console.log('\n');
    console.log('═'.repeat(70));
    console.log('   BMU AI Agent - Performance Test Suite');
    console.log('═'.repeat(70));
    console.log(`   Configuration:`);
    console.log(`     Queries: ${options.queries}`);
    console.log(`     Iterations: ${options.iterations}`);
    console.log(`     Test Type: ${options.testType}`);
    console.log(`     Verbose: ${options.verbose}`);
    console.log('');
    
    try {
        // Select test queries
        const selectedQueries = TEST_QUERIES.slice(0, options.queries);
        
        // Run tests based on type
        for (let i = 0; i < options.iterations; i++) {
            if (options.iterations > 1) {
                console.log(`\n🔄 Iteration ${i + 1}/${options.iterations}`);
            }
            
            if (options.testType === 'all' || options.testType === 'embedding') {
                await testEmbeddings(selectedQueries);
            }
            
            if (options.testType === 'all' || options.testType === 'faq') {
                await testFAQCache(selectedQueries);
            }
            
            if (options.testType === 'all' || options.testType === 'retrieval') {
                await testRetrieval(selectedQueries);
            }
            
            if (options.testType === 'all' || options.testType === 'llm') {
                await testLLMResponse(selectedQueries);
            }
        }
        
        // Generate final report
        generateReport();
        
    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    }
    
    process.exit(0);
}

main();
