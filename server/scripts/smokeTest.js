#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENV_PATH = path.join(__dirname, '../../.env');
require('dotenv').config({ path: ENV_PATH });

const REQUIRED_VARS = ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_NAME'];
const RECOMMENDED_VARS = ['DEEPSEEK_API_KEY', 'OLLAMA_URL', 'OLLAMA_EMBEDDING_MODEL'];
const ALLOW_DB_SKIP = /^(1|true|yes)$/i.test(String(process.env.SMOKE_TEST_ALLOW_DB_SKIP || ''));

function checkEnvVar(key, required) {
    const value = process.env[key];
    if (!value) {
        const label = required ? 'MISSING' : 'WARN';
        console.log(`  ${label}: ${key}`);
        return required;
    }
    console.log(`  OK: ${key}`);
    return false;
}

async function checkHealth(url) {
    const response = await axios.get(url, { timeout: 5000 });
    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
        throw new Error(`Health check failed with status ${response.status}`);
    }
    if (typeof response.data === 'object' && response.data !== null) {
        if (response.data.success === false) {
            throw new Error('Health check returned success=false');
        }
    }
}

async function checkDatabase() {
    const { pool, query } = require('../../config/db');
    try {
        const rows = await query('SELECT 1 AS ok');
        if (Number(rows?.[0]?.ok || 0) !== 1) {
            throw new Error('Database probe returned an unexpected result');
        }
    } finally {
        if (pool && typeof pool.end === 'function') {
            await new Promise(resolve => pool.end(resolve));
        }
    }
}

async function main() {
    console.log('========================================');
    console.log('  BMU AI Academic Advisor - Smoke Test');
    console.log('========================================\n');

    if (!fs.existsSync(ENV_PATH)) {
        console.log('  WARN: .env file not found at', ENV_PATH);
    }

    console.log('\n[1] Environment variables');
    let hasFailure = false;
    REQUIRED_VARS.forEach((key) => {
        if (checkEnvVar(key, true)) hasFailure = true;
    });
    RECOMMENDED_VARS.forEach((key) => {
        checkEnvVar(key, false);
    });

    console.log('\n[2] Database connectivity');
    if (ALLOW_DB_SKIP) {
        console.log('  SKIP: SMOKE_TEST_ALLOW_DB_SKIP is enabled');
    } else {
        try {
            await checkDatabase();
            console.log('  OK: MySQL connection passed');
        } catch (error) {
            console.log('  ERROR:', error.message);
            hasFailure = true;
        }
    }

    console.log('\n[3] Health endpoint');
    const healthUrl = process.env.SMOKE_TEST_URL;
    if (!healthUrl) {
        console.log('  SKIP: Set SMOKE_TEST_URL to run an HTTP health check');
    } else {
        try {
            await checkHealth(healthUrl);
            console.log('  OK: Health check passed');
        } catch (error) {
            console.log('  ERROR:', error.message);
            hasFailure = true;
        }
    }

    console.log('\n========================================');
    console.log(hasFailure ? '  Smoke test failed' : '  Smoke test passed');
    console.log('========================================\n');

    if (hasFailure) process.exit(1);
}

main().catch((error) => {
    console.error('Smoke test error:', error.message);
    process.exit(1);
});
