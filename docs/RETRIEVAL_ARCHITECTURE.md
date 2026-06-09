# BMU AI Assistant - Enhanced Retrieval Architecture

## Overview

This document describes the enhanced document retrieval and chat system architecture for the BMU AI Assistant. The system is designed to provide fast, accurate responses to user queries about Bayelsa Medical University policies and procedures.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER QUERY                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       QUERY PROCESSOR                                    │
│  • Normalization                                                         │
│  • Intent Detection (definitional, procedural, quantitative, etc.)      │
│  • Query Expansion (synonyms, related terms)                            │
│  • Context Integration (conversation history)                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
│  FAQ CACHE   │ │   VECTOR     │ │     KEYWORD          │
│  (Fastest)   │ │   SEARCH     │ │     SEARCH           │
│              │ │  (FAISS +    │ │  (Elasticsearch/     │
│ Similarity   │ │   Ollama     │ │   MySQL FULLTEXT)    │
│  Matching    │ │  Embeddings) │ │                      │
└──────────────┘ └──────────────┘ └──────────────────────┘
        │               │                   │
        │               └─────────┬─────────┘
        │                         │
        │                         ▼
        │         ┌───────────────────────────────┐
        │         │       HYBRID MERGER           │
        │         │  • Weighted score combination │
        │         │  • Deduplication              │
        │         │  • Min relevance filtering    │
        │         └───────────────────────────────┘
        │                         │
        │                         ▼
        │         ┌───────────────────────────────┐
        │         │        RE-RANKER              │
        │         │  • Cross-encoder scoring      │
        │         │  • Term coverage analysis     │
        │         │  • Position-based scoring     │
        │         └───────────────────────────────┘
        │                         │
        │                         ▼
        │         ┌───────────────────────────────┐
        │         │    CONTEXT COMPRESSOR         │
        │         │  • Length optimization        │
        │         │  • Relevant sentence priority │
        │         │  • Source attribution         │
        │         └───────────────────────────────┘
        │                         │
        └────────────┬────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         LLM RESPONSE GENERATOR                          │
│                    (Ollama Mistral/Llama or DeepSeek)                   │
│  • System prompt with context                                           │
│  • Conversation history (limited for speed)                             │
│  • Response generation                                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER RESPONSE                                   │
│  • Answer text                                                          │
│  • Source references                                                    │
│  • Confidence score                                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Retrieval Service (`retrievalService.js`)

The main orchestrator for document retrieval, implementing LangChain-style patterns:

**Features:**
- Hybrid search combining semantic and keyword matching
- Query expansion with BMU-specific synonyms
- Multi-level caching (query, context, document metadata)
- Re-ranking for improved relevance
- Context compression for efficient LLM token usage

**Configuration (Environment Variables):**
```bash
RETRIEVAL_TOP_K=10            # Initial candidates to retrieve
RERANK_TOP_K=5               # Final results after re-ranking
MIN_RELEVANCE_SCORE=0.3      # Minimum score threshold
SEMANTIC_WEIGHT=0.7          # Weight for vector search
KEYWORD_WEIGHT=0.3           # Weight for keyword search
MAX_CONTEXT_LENGTH=4000      # Max chars for LLM context
ENABLE_QUERY_EXPANSION=true  # Enable synonym expansion
ENABLE_HYBRID_SEARCH=true    # Enable keyword + semantic
ENABLE_RERANKING=true        # Enable re-ranking step
```

### 2. Elasticsearch Service (`elasticsearchService.js`)

Optional high-performance search backend:

**Features:**
- Custom analyzers optimized for university documents
- Edge n-gram for autocomplete-style matching
- Hybrid search with dense vectors
- Bulk indexing support
- Automatic index management

**Setup:**
```bash
# Install Elasticsearch (Docker)
docker run -d \
  --name elasticsearch \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  elasticsearch:8.11.0

# Configure environment
ELASTICSEARCH_ENABLED=true
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=bmu_documents

# Rebuild index from database
node server/scripts/rebuildElasticsearchIndex.js
```

### 3. FAQ Cache System (`faqService.js`)

Pre-computed Q&A pairs for instant responses:

**Features:**
- Semantic similarity matching
- Phased Q&A generation (foundational, procedural, quantitative, etc.)
- Automatic embedding generation
- Usage tracking and analytics

**Generation:**
```bash
# Generate FAQs for all documents
node server/scripts/generateAllFAQs.js --simple --max-chunks=10

# Regenerate for specific document
node server/scripts/generateAllFAQs.js --doc-id=1 --regenerate
```

### 4. Vector Store (`vectorStore.js`)

FAISS-based vector similarity search:

**Features:**
- Normalized vectors for cosine similarity
- Persistent storage
- Efficient KNN search
- Automatic index rebuilding

## Performance Optimizations

### 1. Caching Strategy

```
Layer 1: FAQ Cache (Fastest - ~50ms)
   └── Exact/near-exact question matches
   └── Pre-computed answers with embeddings

Layer 2: Query Cache (Fast - ~100ms)
   └── Recent query embeddings
   └── LRU eviction policy

Layer 3: Context Cache (Medium - ~200ms)
   └── Retrieved context for similar queries
   └── TTL-based expiration

Layer 4: Document Cache (Medium - ~150ms)
   └── Document metadata
   └── Reduces database queries
```

### 2. Model Optimizations

**Ollama Settings for Speed:**
```javascript
{
    num_predict: 512,      // Limit output tokens
    num_ctx: 2048,         // Smaller context window
    temperature: 0.7,      // Balanced creativity
    top_k: 40,
    top_p: 0.9,
    repeat_penalty: 1.1
}
```

**Model Selection:**
- `llama3.2:3b` - Fastest, good for simple queries
- `mistral:7b` - Balanced speed/quality (recommended)
- `llama3.1:8b` - Highest quality, slower
- `deepseek-chat` - Cloud API, fast but requires internet

### 3. Response Time Targets

| Operation | Target | Acceptable |
|-----------|--------|------------|
| FAQ Cache Hit | < 100ms | < 200ms |
| Vector Search | < 300ms | < 500ms |
| Keyword Search | < 200ms | < 400ms |
| Re-ranking | < 100ms | < 200ms |
| LLM Response | < 3s | < 5s |
| **End-to-End** | **< 4s** | **< 6s** |

## API Endpoints

### Chat Message
```
POST /api/chat/message
{
  "message": "How do I apply for leave?",
  "sessionToken": "...",
  "model": "mistral:7b"  // Optional model selection
}
```

### Retrieval Metrics
```
GET /api/admin/retrieval/metrics
Response: {
  "totalQueries": 150,
  "cacheHitRate": "45%",
  "avgRetrievalTime": 180,
  "avgReRankTime": 45
}
```

## Testing

### Performance Test Suite
```bash
# Run all tests
node server/scripts/performanceTest.js --queries=20 --iterations=3

# Test specific component
node server/scripts/performanceTest.js --test=retrieval --verbose

# Options:
#   --queries=N      Number of test queries (default: 10)
#   --iterations=N   Number of iterations (default: 3)
#   --test=TYPE      Test type: all, retrieval, faq, llm, embedding
#   --verbose        Show detailed results
```

### Key Performance Indicators (KPIs)

1. **Retrieval Latency** - Time to find relevant documents
   - Target: P95 < 500ms

2. **FAQ Cache Hit Rate** - Percentage of queries answered from cache
   - Target: > 30%

3. **End-to-End Response Time** - Total time from query to response
   - Target: P95 < 5 seconds

4. **Relevance Score** - Quality of retrieved documents
   - Target: Top result > 0.5 relevance

5. **User Satisfaction** - Based on feedback ratings
   - Target: > 4.0 average rating

## Monitoring

### Metrics Collection
```javascript
// Get retrieval metrics
const metrics = retrievalService.getMetrics();
console.log({
  totalQueries: metrics.totalQueries,
  cacheHitRate: metrics.cacheHitRate,
  avgRetrievalTime: metrics.avgRetrievalTime
});
```

### Health Checks
```bash
# Check Elasticsearch status
curl http://localhost:9200/_cluster/health

# Check Ollama status
curl http://localhost:11434/api/tags
```

## Troubleshooting

### Slow Responses
1. Check if FAQ cache is enabled and populated
2. Verify Ollama models are loaded (warmup)
3. Review context length (reduce if too long)
4. Check Elasticsearch connection (if enabled)

### Poor Relevance
1. Run FAQ generation with more content: `--max-chunks=15`
2. Lower MIN_RELEVANCE_SCORE threshold
3. Increase RETRIEVAL_TOP_K for more candidates
4. Review query expansion terms

### High Memory Usage
1. Reduce cache sizes in configuration
2. Lower embedding cache max size
3. Consider using smaller embedding model

## Future Improvements

1. **Cross-Encoder Re-ranking** - Use dedicated re-ranking model
2. **Query Understanding** - Better intent classification with ML
3. **Streaming Responses** - Real-time token streaming
4. **Multi-modal** - Support for image queries
5. **Personalization** - User-specific ranking adjustments

## File Structure

```
server/
├── services/
│   ├── aiService.js           # Main AI/LLM service
│   ├── retrievalService.js    # Enhanced retrieval pipeline
│   ├── elasticsearchService.js # Optional ES backend
│   ├── faqService.js          # FAQ caching system
│   ├── vectorStore.js         # FAISS vector store
│   └── documentProcessor.js   # Document ingestion
├── scripts/
│   ├── generateAllFAQs.js     # FAQ generation
│   └── performanceTest.js     # Performance testing
└── routes/
    └── chatRoutes.js          # Chat API endpoints
```

## Version History

- **v2.0** - Enhanced retrieval with LangChain patterns, Elasticsearch support
- **v1.5** - FAQ caching system, multi-model support
- **v1.0** - Basic RAG with FAISS vector search
