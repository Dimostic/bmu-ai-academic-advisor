/**
 * LangChain Service for BMU AI Agent
 * 
 * Provides LangChain-powered features:
 * - Better text splitting (RecursiveCharacterTextSplitter)
 * - Conversation memory management
 * - RetrievalQA chains
 * - Document loaders
 * - Embeddings integration with Ollama
 */

const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { Document: LCDocument } = require('@langchain/core/documents');
const { OllamaEmbeddings } = require('@langchain/ollama');
const { ChatOllama } = require('@langchain/ollama');
const { PromptTemplate, ChatPromptTemplate } = require('@langchain/core/prompts');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence, RunnablePassthrough } = require('@langchain/core/runnables');
const { BufferMemory, ConversationSummaryMemory } = require('langchain/memory');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');

class LangChainService {
    constructor() {
        this.ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        this.embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
        this.chatModel = process.env.AI_MODEL?.replace('ollama/', '') || 'mistral:7b';
        
        // Initialize embeddings
        this.embeddings = new OllamaEmbeddings({
            baseUrl: this.ollamaUrl,
            model: this.embeddingModel,
        });
        
        // Initialize chat model
        this.llm = new ChatOllama({
            baseUrl: this.ollamaUrl,
            model: this.chatModel,
            temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,
        });
        
        // Text splitter for document processing
        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
            separators: ['\n\n', '\n', '. ', ', ', ' ', ''],
        });
        
        // Conversation memories (keyed by session ID)
        this._memories = new Map();
        this._memoryMaxSize = 100;
        
        console.log('[LangChainService] Initialized with Ollama:', {
            url: this.ollamaUrl,
            embeddingModel: this.embeddingModel,
            chatModel: this.chatModel
        });
    }

    /**
     * Split text into chunks using LangChain's RecursiveCharacterTextSplitter
     * Better than simple chunking - respects sentence boundaries
     */
    async splitText(text, options = {}) {
        const {
            chunkSize = 1000,
            chunkOverlap = 200
        } = options;
        
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize,
            chunkOverlap,
            separators: ['\n\n', '\n', '. ', ', ', ' ', ''],
        });
        
        const chunks = await splitter.splitText(text);
        return chunks;
    }

    /**
     * Split documents with metadata preservation
     */
    async splitDocuments(documents) {
        const lcDocs = documents.map(doc => new LCDocument({
            pageContent: doc.content || doc.text || '',
            metadata: {
                documentId: doc.id,
                title: doc.title,
                category: doc.category,
                ...doc.metadata
            }
        }));
        
        const splitDocs = await this.textSplitter.splitDocuments(lcDocs);
        
        return splitDocs.map((doc, idx) => ({
            content: doc.pageContent,
            metadata: doc.metadata,
            chunkIndex: idx
        }));
    }

    /**
     * Generate embeddings using LangChain's Ollama integration
     */
    async generateEmbedding(text) {
        try {
            const embedding = await this.embeddings.embedQuery(text);
            return embedding;
        } catch (error) {
            console.error('[LangChainService] Embedding error:', error.message);
            throw error;
        }
    }

    /**
     * Generate embeddings for multiple texts (batched)
     */
    async generateEmbeddings(texts) {
        try {
            const embeddings = await this.embeddings.embedDocuments(texts);
            return embeddings;
        } catch (error) {
            console.error('[LangChainService] Batch embedding error:', error.message);
            throw error;
        }
    }

    /**
     * Get or create conversation memory for a session
     */
    getMemory(sessionId) {
        if (!this._memories.has(sessionId)) {
            // Evict oldest if at capacity
            if (this._memories.size >= this._memoryMaxSize) {
                const oldestKey = this._memories.keys().next().value;
                this._memories.delete(oldestKey);
            }
            
            this._memories.set(sessionId, new BufferMemory({
                returnMessages: true,
                memoryKey: 'chat_history',
                inputKey: 'question',
                outputKey: 'answer'
            }));
        }
        return this._memories.get(sessionId);
    }

    /**
     * Add message to conversation memory
     */
    async addToMemory(sessionId, userMessage, aiResponse) {
        const memory = this.getMemory(sessionId);
        await memory.saveContext(
            { question: userMessage },
            { answer: aiResponse }
        );
    }

    /**
     * Get conversation history from memory
     */
    async getHistory(sessionId) {
        const memory = this.getMemory(sessionId);
        const history = await memory.loadMemoryVariables({});
        return history.chat_history || [];
    }

    /**
     * Clear conversation memory for a session
     */
    clearMemory(sessionId) {
        this._memories.delete(sessionId);
    }

    /**
     * Create a RAG chain for question answering
     */
    createRAGChain(systemPrompt) {
        const prompt = ChatPromptTemplate.fromMessages([
            ['system', systemPrompt || `You are a helpful AI assistant for Bayelsa Medical University.
Answer questions based on the provided context. If the context doesn't contain
relevant information, say so and provide general guidance.

Context:
{context}`],
            ['human', '{question}']
        ]);
        
        const chain = RunnableSequence.from([
            {
                context: (input) => input.context || '',
                question: (input) => input.question
            },
            prompt,
            this.llm,
            new StringOutputParser()
        ]);
        
        return chain;
    }

    /**
     * Create a conversational RAG chain with memory
     */
    createConversationalChain(systemPrompt) {
        const prompt = ChatPromptTemplate.fromMessages([
            ['system', systemPrompt || `You are a helpful AI assistant for Bayelsa Medical University.
Use the conversation history and context to provide accurate, helpful responses.

Context from documents:
{context}

Conversation history:
{chat_history}`],
            ['human', '{question}']
        ]);
        
        const chain = RunnableSequence.from([
            {
                context: (input) => input.context || '',
                chat_history: (input) => this._formatHistory(input.history || []),
                question: (input) => input.question
            },
            prompt,
            this.llm,
            new StringOutputParser()
        ]);
        
        return chain;
    }

    /**
     * Format chat history for prompt
     */
    _formatHistory(history) {
        if (!history || history.length === 0) return 'No previous conversation.';
        
        return history.map(msg => {
            if (msg instanceof HumanMessage || msg.type === 'human') {
                return `Human: ${msg.content}`;
            } else if (msg instanceof AIMessage || msg.type === 'ai') {
                return `Assistant: ${msg.content}`;
            }
            return '';
        }).filter(Boolean).join('\n');
    }

    /**
     * Run a RAG query with context
     */
    async query(question, context, options = {}) {
        const {
            sessionId,
            systemPrompt,
            includeHistory = true
        } = options;
        
        try {
            let chain;
            let input = { question, context };
            
            if (sessionId && includeHistory) {
                // Use conversational chain with memory
                chain = this.createConversationalChain(systemPrompt);
                const history = await this.getHistory(sessionId);
                input.history = history;
            } else {
                // Use simple RAG chain
                chain = this.createRAGChain(systemPrompt);
            }
            
            const response = await chain.invoke(input);
            
            // Save to memory if session provided
            if (sessionId) {
                await this.addToMemory(sessionId, question, response);
            }
            
            return {
                success: true,
                response,
                fromLangChain: true
            };
        } catch (error) {
            console.error('[LangChainService] Query error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Summarize a long text
     */
    async summarize(text, maxLength = 500) {
        const prompt = PromptTemplate.fromTemplate(
            `Summarize the following text in {maxLength} characters or less. 
Be concise but capture the key points.

Text:
{text}

Summary:`
        );
        
        const chain = RunnableSequence.from([
            prompt,
            this.llm,
            new StringOutputParser()
        ]);
        
        try {
            const summary = await chain.invoke({ text, maxLength });
            return summary;
        } catch (error) {
            console.error('[LangChainService] Summarize error:', error.message);
            throw error;
        }
    }

    /**
     * Extract key information from a document
     */
    async extractKeyInfo(text, documentType = 'policy') {
        const prompt = PromptTemplate.fromTemplate(
            `Analyze this {documentType} document and extract:
1. Main topics (comma-separated)
2. Key policies or rules mentioned
3. Important dates or deadlines
4. Target audience
5. Brief summary (2-3 sentences)

Document:
{text}

Provide the response in JSON format with keys: topics, policies, dates, audience, summary`
        );
        
        const chain = RunnableSequence.from([
            prompt,
            this.llm,
            new StringOutputParser()
        ]);
        
        try {
            const result = await chain.invoke({ text: text.substring(0, 6000), documentType });
            
            // Try to parse as JSON
            try {
                return JSON.parse(result);
            } catch {
                return { raw: result };
            }
        } catch (error) {
            console.error('[LangChainService] Extract error:', error.message);
            throw error;
        }
    }

    /**
     * Generate follow-up questions based on conversation
     */
    async generateFollowUpQuestions(context, count = 3) {
        const prompt = PromptTemplate.fromTemplate(
            `Based on this conversation about Bayelsa Medical University policies:

{context}

Generate exactly {count} relevant follow-up questions the user might want to ask.
Return only the questions, one per line, without numbering or bullets.`
        );
        
        const chain = RunnableSequence.from([
            prompt,
            this.llm,
            new StringOutputParser()
        ]);
        
        try {
            const result = await chain.invoke({ context, count });
            return result.split('\n').filter(q => q.trim()).slice(0, count);
        } catch (error) {
            console.error('[LangChainService] Follow-up questions error:', error.message);
            return [];
        }
    }

    /**
     * Rewrite/expand a query for better retrieval
     */
    async expandQuery(query) {
        const prompt = PromptTemplate.fromTemplate(
            `Given this search query about university policies: "{query}"

Generate 3 alternative phrasings or related queries that might help find relevant information.
Return only the queries, one per line.`
        );
        
        const chain = RunnableSequence.from([
            prompt,
            this.llm,
            new StringOutputParser()
        ]);
        
        try {
            const result = await chain.invoke({ query });
            const expansions = result.split('\n').filter(q => q.trim());
            return [query, ...expansions];
        } catch (error) {
            console.error('[LangChainService] Query expansion error:', error.message);
            return [query];
        }
    }

    /**
     * Get service status and statistics
     */
    getStats() {
        return {
            initialized: true,
            ollamaUrl: this.ollamaUrl,
            embeddingModel: this.embeddingModel,
            chatModel: this.chatModel,
            activeMemories: this._memories.size,
            memoryMaxSize: this._memoryMaxSize
        };
    }
}

// Export singleton instance
module.exports = new LangChainService();
