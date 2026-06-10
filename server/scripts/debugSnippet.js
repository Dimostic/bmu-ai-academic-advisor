// Quick diagnostic: show what keyword fallback returns for a question.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../../config/db');

(async () => {
    const q = process.argv.slice(2).join(' ') || 'What are the BMU MBBS tuition fees for new 100 level students?';
    console.log(`Question: ${q}\n`);

    const rows = await query(
        `SELECT id, title, content_text, MATCH(title,description,content_text) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
         FROM documents WHERE is_active=TRUE AND content_text IS NOT NULL
         HAVING score>0 ORDER BY score DESC LIMIT 4`,
        [q]
    );
    console.log('Top hits:');
    rows.forEach(r => console.log(`  ${r.score.toFixed(3)}  ${r.title}`));
    console.log('');

    const stopwords = new Set(['what','when','where','which','about','their','this','that','with','have','been','they','will','into','from']);
    const terms = [...new Set(q.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])].filter(w => !stopwords.has(w));
    console.log('Search terms:', terms);
    console.log('');

    for (const r of rows.slice(0, 2)) {
        const lower = r.content_text.toLowerCase();
        let best = -1, bestTerm = null;
        for (const t of terms) {
            const idx = lower.indexOf(t);
            if (idx >= 0 && (best < 0 || idx < best)) { best = idx; bestTerm = t; }
        }
        console.log(`\n--- ${r.title} ---`);
        console.log(`  first match: term="${bestTerm}" at offset ${best}`);
        if (best >= 0) {
            const start = Math.max(0, best - 200);
            const end   = Math.min(r.content_text.length, best + 1200);
            console.log(`  snippet: …${r.content_text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 1400)}…`);
        }
    }
    process.exit(0);
})();
