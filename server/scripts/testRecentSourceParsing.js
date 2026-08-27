const recentSourceService = require('../services/bmuRecentSourceService');

const {
    splitCandidateTexts,
    stripHtml,
    detectProgramme,
    detectSession
} = recentSourceService._internal;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    const html = `
        <article>
            <h1>Bayelsa Medical University 2026/2027 Admissions Cutoff Marks and Application Details</h1>
            <p>The admission process for the 2026/2027 academic session is ongoing.</p>
            <ul>
                <li>Medicine and Surgery (MBBS): Merit - 279</li>
                <li>Pharmacy (Pharm.D): Merit - 238</li>
                <li>Nursing Science (B.NSc): Merit - 234</li>
                <li>Medical Laboratory Sciences (BMLS): Merit - 223</li>
                <li>Other Programs: 150</li>
            </ul>
            <p>Application process: create an account, verify the account, log in, search for the programme, apply, upload documents and pay the application fee.</p>
        </article>
    `;
    const text = stripHtml(html);
    const candidates = splitCandidateTexts(text);
    const joined = candidates.join('\n');

    assert(candidates.length >= 2, 'Expected multiple candidate facts from BMU-style notice');
    assert(/2026\/2027/.test(joined), 'Expected admission session to be preserved');
    assert(/Medicine and Surgery/i.test(joined), 'Expected MBBS cutoff line to be preserved');
    assert(/279/.test(joined), 'Expected MBBS cutoff mark to be preserved');
    assert(/application process/i.test(joined), 'Expected application process fact to be preserved');
    assert(detectSession(joined) === '2026/2027', 'Expected session detection to work');
    assert(detectProgramme('Medicine and Surgery MBBS cutoff 279') === 'Medicine and Surgery (MBBS)', 'Expected programme detection to work');

    console.log(JSON.stringify({
        success: true,
        candidates: candidates.length,
        checked: 'BMU recent-source parsing preserves sessions, cutoffs and application flow'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
