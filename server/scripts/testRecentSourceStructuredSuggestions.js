const recentSourceService = require('../services/bmuRecentSourceService');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function findSuggestion(suggestions, table, predicate) {
    return suggestions.find(item => item.table === table && predicate(item.record || {}));
}

function main() {
    const notice = `
        Bayelsa Medical University (BMU) 2026/2027 Admissions Cutoff Marks and Application Details

        The general public is hereby informed that the admission process for the 2026/2027 academic session is ongoing.

        Cutoff Marks:
        - Medicine and Surgery (MBBS): Merit - 279
        - Pharmacy (Pharm.D): Merit - 238
        - Nursing Science (B.NSc): Merit - 234
        - Medical Laboratory Sciences (BMLS): Merit - 223
        - Optometry (O.D) : Merit - 203
        - Radiography & Radiation Sciences : Merit - 228
        - Physiotheraphy : Merit - 205
        - Community / Public Health : Merit - 170
        - Other Programs: 150

        Eligibility Criteria:
        1. Unified Tertiary Matriculation Examination (UTME): Minimum score of 150 in the 2026 UTME.
        2. Age Requirement: Must be 16 years and above.
        3. O'Level Requirements: At least five (5) credits in SSCE or its equivalent, including English Language, Biology, Chemistry, Physics, and Mathematics.

        Application Process:
        - create an account
        - verify the account
        - login, search for the program of choice
        - click on apply, fill application form, upload required documents
        - update application
        - pay application fee.

        For further inquiries
        - Phone: +234-703-451-9975

        Mr. Jones Igene
        Admissions Officer
    `;

    const suggestions = recentSourceService.buildStructuredSuggestions({
        id: 41,
        title: 'BMU 2026/2027 Admissions Cutoff Marks and Application Details',
        source_name: 'BMU Facebook',
        source_type: 'social_facebook',
        source_url: 'https://www.facebook.com/BMUYenagoa',
        authority_type: 'institution',
        fact_text: notice
    });

    const cutoffs = suggestions.filter(item => item.table === 'academic_admission_cutoffs');
    assert(cutoffs.length >= 9, `Expected at least 9 cutoff suggestions, got ${cutoffs.length}`);

    const mbbs = findSuggestion(suggestions, 'academic_admission_cutoffs', record => record.programme === 'Medicine and Surgery (MBBS)');
    assert(mbbs, 'Expected MBBS cutoff suggestion');
    assert(Number(mbbs.record.merit_cutoff) === 279, 'Expected MBBS cutoff to be 279');
    assert(mbbs.record.admission_cycle === '2026/2027', 'Expected admission cycle to be 2026/2027');
    assert(/16 years/i.test(mbbs.record.eligibility_text || ''), 'Expected age eligibility to be preserved');
    assert(/English Language/i.test(mbbs.record.eligibility_text || ''), 'Expected O Level subjects to be preserved');

    const physiotherapy = findSuggestion(suggestions, 'academic_admission_cutoffs', record => record.programme === 'Physiotherapy');
    assert(physiotherapy, 'Expected Physiotheraphy typo to map to Physiotherapy');
    assert(Number(physiotherapy.record.merit_cutoff) === 205, 'Expected Physiotherapy cutoff to be 205');

    const application = findSuggestion(suggestions, 'academic_registration_requirements', record => record.requirement_type === 'online_application');
    assert(application, 'Expected online application requirement suggestion');
    assert(/create an account/i.test(application.record.requirement_text || ''), 'Expected create-account step');
    assert(/pay application fee/i.test(application.record.requirement_text || ''), 'Expected payment step');
    assert(/admissions\/apply/i.test(application.record.portal_url || ''), 'Expected admissions apply portal fallback');

    const eligibility = findSuggestion(suggestions, 'academic_registration_requirements', record => record.requirement_type === 'admission_eligibility');
    assert(eligibility, 'Expected admission eligibility requirement suggestion');
    assert(/Minimum score of 150/i.test(eligibility.record.requirement_text || ''), 'Expected UTME minimum score');

    console.log(JSON.stringify({
        success: true,
        suggestions: suggestions.length,
        cutoffs: cutoffs.length,
        checked: 'Recent BMU notices produce promotable admission cutoff and registration rows'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
