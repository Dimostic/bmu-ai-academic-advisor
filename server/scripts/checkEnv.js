#!/usr/bin/env node
/**
 * checkEnv.js - Diagnose .env configuration for Ollama/AI chat
 * Usage: node server/scripts/checkEnv.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENV_PATH = path.resolve(__dirname, '../../.env');

const REQUIRED_OLLAMA_VARS = {
    AI_MODEL: 'ollama/llama3',
    OLLAMA_URL: 'http://127.0.0.1:11434',
    EMBEDDING_PROVIDER: 'ollama',
    EMBEDDING_DIM: '768',
    OLLAMA_EMBEDDING_MODEL: 'nomic-embed-text'
};

function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            env[key] = value;
        }
    }
    return env;
}

async function testOllama(url) {
    try {
        const response = await axios.get(url + '/api/tags', { timeout: 5000 });
        return { ok: true, models: response.data.models || [] };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

async function testOllamaChat(url, model) {
    try {
        const response = await axios.post(
            url + '/api/chat',
            {
                model: model,
                messages: [{ role: 'user', content: 'Say hello' }],
                stream: false,
                options: { num_predict: 10 }
            },
            { timeout: 30000 }
        );
        return { ok: true, response: response.data?.message?.content };
    } catch (error) {
        return { ok: false, error: error.response?.data?.error || error.message };
    }
}

async function testOllamaEmbeddings(url, model) {
    try {
        const response = await axios.post(
            url + '/api/embeddings',
            { model: model, prompt: 'test' },
            { timeout: 10000 }
        );
        const embedding = response.data?.embedding;
        return { ok: Array.isArray(embedding) && embedding.length > 0, dim: embedding?.length || 0 };
    } catch (error) {
        return { ok: false, error: error.response?.data?.error || error.message };
    }
}

async function main() {
    console.log('========================================');
    console.log('  BMU AI Agent - Environment Checker');
    console.log('========================================\n');
    
    console.log('[1] Checking .env file at:', ENV_PATH);
    if (!fs.existsSync(ENV_PATH)) {
        console.log('    ERROR: .env file NOT FOUND');
        return;
    }
    console.log('    OK: .env file exists\n');
    
    console.log('[2] Checking environment variables...');
    const env = parseEnvFile(ENV_PATH);
    
    for (const [key, expectedValue] of Object.entries(REQUIRED_OLLAMA_VARS)) {
        const currentValue = env[key];
        if (!currentValue) {
            console.log('    MISSING:', key, '(expected:', expectedValue + ')');
        } else if (key === 'AI_MODEL' && !currentValue.startsWith('ollama/')) {
            console.log('    WARN:', key + '=' + currentValue, '(should start with "ollama/")');
        } else {
            console.log('    OK:', key + '=' + currentValue);
        }
    }
    console.log('');
    
    const ollamaUrl = env.OLLAMA_URL || REQUIRED_OLLAMA_VARS.OLLAMA_URL;
    console.log('[3] Testing Ollama connectivity at', ollamaUrl + '...');
    const ollamaTest = await testOllama(ollamaUrl);
    
    if (!ollamaTest.ok) {
        console.log('    ERROR: Cannot connect to Ollama:', ollamaTest.error);
        console.log('    TIP: Make sure Ollama is running: systemctl status ollama');
        return;
    }
    
    console.log('    OK: Ollama is running');
    console.log('    Models:', ollamaTest.models.map(m => m.name).join(', ') + '\n');
    
    const chatModel = (env.AI_MODEL || REQUIRED_OLLAMA_VARS.AI_MODEL).replace('ollama/', '');
    console.log('[4] Testing chat model:', chatModel + '...');
    
    const modelExists = ollamaTest.models.some(m => m.name === chatModel || m.name.startsWith(chatModel + ':'));
    
    if (!modelExists) {
        console.log('    ERROR: Model "' + chatModel + '" not found in Ollama');
        console.log('    TIP: Pull it with: ollama pull', chatModel);
        const llama3Models = ollamaTest.models.filter(m => m.name.includes('llama3'));
        if (llama3Models.length > 0) {
            console.log('    Available llama3 models:', llama3Models.map(m => m.name).join(', '));
        }
    } else {
        const chatTest = await testOllamaChat(ollamaUrl, chatModel);
        if (chatTest.ok) {
            console.log('    OK: Chat works! Response: "' + chatTest.response + '"');
        } else {
            console.log('    ERROR: Chat test failed:', chatTest.error);
        }
    }
    console.log('');
    
    const embeddingModel = env.OLLAMA_EMBEDDING_MODEL || REQUIRED_OLLAMA_VARS.OLLAMA_EMBEDDING_MODEL;
    console.log('[5] Testing embedding model:', embeddingModel + '...');
    
    const embeddingModelExists = ollamaTest.models.some(m => m.name === embeddingModel || m.name.startsWith(embeddingModel + ':'));
    
    if (!embeddingModelExists) {
        console.log('    ERROR: Embedding model "' + embeddingModel + '" not found');
        console.log('    TIP: Pull it with: ollama pull', embeddingModel);
    } else {
        const embTest = await testOllamaEmbeddings(ollamaUrl, embeddingModel);
        if (embTest.ok) {
            console.log('    OK: Embeddings work! Dimension:', embTest.dim);
            const configuredDim = parseInt(env.EMBEDDING_DIM || REQUIRED_OLLAMA_VARS.EMBEDDING_DIM);
            if (configuredDim !== embTest.dim) {
                console.log('    WARN: EMBEDDING_DIM=' + configuredDim + ' but actual is', embTest.dim);
            }
        } else {
            console.log('    ERROR: Embedding test failed:', embTest.error);
        }
    }
    console.log('');
    
    console.log('========================================');
    console.log('  Summary');
    console.log('========================================');
    console.log('  Ollama URL:     ', ollamaUrl);
    console.log('  Chat Model:     ', chatModel);
    console.log('  Embedding Model:', embeddingModel);
    console.log('========================================\n');
}

main().catch(err => {
    console.error('Script error:', err.message);
    process.exit(1);
});
