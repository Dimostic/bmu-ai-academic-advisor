/**
 * One-off seed script: pre-populate the FAQ cache with verbatim BMU fee
 * tables for every programme × level × indigene/non-indigene combination
 * the documents cover. This is the most reliable fix for the model's
 * tendency to hallucinate numbers when the chunked text is hard to
 * parse (e.g. PDF tables flattened into a digit-soup).
 *
 * Run once after deploying:
 *   ssh bmu-server 'cd /var/www/bmu-ai-academic-advisor && node server/scripts/seedFeesFaqs.js'
 *
 * Idempotent — uses POST /api/admin/cached-qa which refreshes any
 * existing row with the same question.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');

const API_BASE  = process.env.SEED_API_BASE || 'http://127.0.0.1:3002';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'bmuapps@bmu.edu.ng';
const ADMIN_PASS  = process.env.SEED_ADMIN_PASS  || 'Admin@123';

// Source: bmu fee structures new.docx, transcribed from the row format
// "<level><tuition><dev><total>" e.g. "100370,00050,000600,000".
// Only Medicine table at this point — extend the array below for other
// programmes (DENTISTRY, NURSING, PHARMACY, BMLS, etc).
const MEDICINE_FEES = {
    indigene: {
        100: { tuition: 370000, dev: 50000, total: 600000 },
        '200_DE': { tuition: 370000, dev: 50000, total: 730000 },
        200: { tuition: 370000, dev: 50000, total: 730000 },
        300: { tuition: 100000, dev: 50000, total: 475000 },
        400: { tuition: 100000, dev: 50000, total: 510000 },
        500: { tuition: 100000, dev: 50000, total: 510000 },
        600: { tuition: 100000, dev: 50000, total: 540000 }
    },
    non_indigene: {
        100: { tuition: 970000, dev: 50000, total: 1230000 },
        '200_DE': { tuition: 970000, dev: 50000, total: 1360000 },
        200: { tuition: 970000, dev: 50000, total: 1360000 },
        300: { tuition: 500000, dev: 50000, total: 1015000 },
        400: { tuition: 550000, dev: 50000, total: 1110000 },
        500: { tuition: 550000, dev: 50000, total: 1090000 },
        600: { tuition: 600000, dev: 50000, total: 1195000 }
    }
};

const NOTE = ' Plus one-time Acceptance Fee of 50,000 (new students only) and optional Accommodation Fee of 100,000 per session. All amounts in Nigerian Naira.';

function buildEntries() {
    const entries = [];
    for (const [category, levels] of Object.entries(MEDICINE_FEES)) {
        const indigeneText = category === 'indigene' ? 'indigene' : 'non-indigene';
        for (const [level, fee] of Object.entries(levels)) {
            const lvlLabel = String(level).includes('DE') ? '200 Direct Entry' : `${level} level`;
            const programmes = ['Medicine and Surgery', 'MBBS'];
            for (const p of programmes) {
                entries.push({
                    question: `What is the fee for ${lvlLabel} ${p} ${indigeneText} at BMU?`,
                    answer: `For ${lvlLabel} ${p} (${indigeneText}) at Bayelsa Medical University, the total payable per session is ${fee.total.toLocaleString()} Naira. This includes tuition of ${fee.tuition.toLocaleString()} Naira and development levy of ${fee.dev.toLocaleString()} Naira.${NOTE}`
                });
            }
        }
    }
    return entries;
}

async function main() {
    console.log('[seedFees] logging in as admin...');
    const login = await axios.post(`${API_BASE}/api/users/login`,
        { email: ADMIN_EMAIL, password: ADMIN_PASS },
        { timeout: 15000 }
    );
    const token = login.data?.token;
    if (!token) throw new Error('Login failed — no token returned');
    console.log('[seedFees] token acquired, len', token.length);

    const entries = buildEntries();
    console.log(`[seedFees] seeding ${entries.length} entries...`);

    let created = 0, refreshed = 0, failed = 0;
    for (const e of entries) {
        try {
            const r = await axios.post(`${API_BASE}/api/admin/cached-qa`, e, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 30000
            });
            if (r.data?.mode === 'created') created++;
            else if (r.data?.mode === 'refreshed') refreshed++;
            console.log(`  ${r.data?.mode || '?'}  id=${r.data?.cachedQaId}  q="${e.question.slice(0, 80)}"`);
        } catch (err) {
            failed++;
            console.error(`  FAILED  q="${e.question.slice(0, 80)}"  → ${err.response?.data?.error || err.message}`);
        }
    }
    console.log(`\n[seedFees] done: ${created} created, ${refreshed} refreshed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
