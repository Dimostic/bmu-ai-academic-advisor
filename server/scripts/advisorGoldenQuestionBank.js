const programmes = [
    'Medicine and Surgery',
    'Dentistry',
    'Pharmacy',
    'Nursing Science',
    'Medical Laboratory Science',
    'Optometry',
    'Radiography and Radiation Science',
    'Physiotherapy',
    'Community Health Science',
    'Public Health',
    'Human Anatomy',
    'Human Physiology',
    'Computer Science',
    'Mathematics',
    'Physics',
    'Chemistry',
    'Biology',
    'Sociology'
];

const handbookTopics = [
    'credit load',
    'credit unit',
    'course registration',
    'late registration',
    'add and drop',
    'examination eligibility',
    'continuous assessment',
    'GPA calculation',
    'CGPA calculation',
    'probation',
    'withdrawal',
    'carry-over courses',
    'reassessment of results',
    'graduation requirements',
    'student discipline',
    'matriculation',
    'deferment',
    'transfer',
    'library use',
    'hostel conduct',
    'student identity cards',
    'medical fitness',
    'course adviser responsibilities',
    'SIWES',
    'academic misconduct'
];

const officers = [
    ['Vice-Chancellor', 'VC'],
    ['Deputy Vice-Chancellor', 'DVC'],
    ['Registrar', 'registrar'],
    ['Bursar', 'chief financial officer'],
    ['University Librarian', 'liberian'],
    ['Pro-Chancellor', 'chairman of governing council'],
    ['Chancellor', 'chancellor'],
    ['Admissions Officer', 'admission officer']
];

const lawTopics = [
    'Visitor of the University',
    'object of the University',
    'powers of the University',
    'Governing Council membership',
    'Senate functions',
    'Bursar role',
    'Registrar role',
    'pre-action notice',
    'student discipline under the law',
    'appointment of principal officers',
    'convocation',
    'common seal'
];

function push(out, category, risk, sourcePriority, question) {
    out.push({
        id: `${category}-${out.length + 1}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
        category,
        risk,
        sourcePriority,
        question
    });
}

function buildQuestionBank() {
    const out = [];

    for (const programme of programmes) {
        [
            `What are the admission requirements for ${programme}?`,
            `What are the graduation requirements for ${programme}?`,
            `How long does ${programme} take at BMU?`,
            `What courses are listed for 300 level ${programme}?`,
            `What are the BMU fees for ${programme}?`,
            `What regulatory or professional body applies to ${programme}?`,
            `Can a direct entry student apply for ${programme}?`,
            `Which faculty or college houses ${programme}?`
        ].forEach(question => push(out, 'programme', 'high', ['structured_facts', 'student_handbook', 'ccmas'], question));
    }

    for (const topic of handbookTopics) {
        [
            `What does the student handbook say about ${topic}?`,
            `Summarise BMU rules on ${topic} for a student.`,
            `What should a student do if there is a problem with ${topic}?`,
            `Is there a deadline or approval requirement for ${topic}?`
        ].forEach(question => push(out, 'student_handbook', 'high', ['student_handbook', 'structured_facts'], question));
    }

    for (const programme of programmes.slice(0, 14)) {
        [
            `What is the 100 level indigene fee for ${programme}?`,
            `What is the 100 level non-indigene fee for ${programme}?`,
            `Show the fee table for ${programme}.`,
            `What source supports the current fee for ${programme}?`
        ].forEach(question => push(out, 'fees', 'high', ['structured_facts', 'fee_structure'], question));
    }

    for (const [office, alias] of officers) {
        [
            `Who is the ${office} of BMU?`,
            `What is the name of the BMU ${alias}?`,
            `Give the current BMU ${office} with source.`,
            `Is the BMU ${office} position occupied?`
        ].forEach(question => push(out, 'officers', office === 'Chancellor' ? 'high' : 'medium', ['structured_facts', 'profile'], question));
    }

    for (const programme of programmes.slice(0, 12)) {
        [
            `What is the current admission cutoff for ${programme}?`,
            `What was the 2026/2027 merit cutoff for ${programme}?`,
            `What is the UTME eligibility for ${programme}?`,
            `How do I apply for ${programme} at BMU?`,
            `What current source supports the admission requirement for ${programme}?`
        ].forEach(question => push(out, 'admissions', 'high', ['academic_admission_cutoffs', 'bmu_recent_facts', 'student_handbook', 'ccmas'], question));
    }

    for (const programme of programmes.slice(0, 15)) {
        ['100 level', '200 level', '300 level', '400 level'].forEach(level => {
            push(out, 'courses', 'medium', ['academic_courses', 'student_courses', 'ccmas'], `Which courses are listed for ${level} ${programme}?`);
        });
    }

    for (const topic of lawTopics) {
        [
            `What does BMU Law say about ${topic}?`,
            `Explain ${topic} under the Bayelsa Medical University Law.`,
            `Give the source for BMU Law information about ${topic}.`
        ].forEach(question => push(out, 'bmu_law', 'medium', ['bmu_law'], question));
    }

    [
        'What is the latest BMU admissions notice?',
        'Are there current registration instructions for new students?',
        'Are there current registration instructions for returning students?',
        'What latest BMU notice affects fees?',
        'What latest BMU notice affects admission screening?',
        'What latest BMU notice affects academic calendar dates?',
        'What current BMU source supports this answer?',
        'If no current BMU source exists, what should the advisor say?'
    ].forEach(question => push(out, 'recent_sources', 'high', ['bmu_recent_facts', 'structured_facts'], question));

    return out;
}

module.exports = buildQuestionBank();
