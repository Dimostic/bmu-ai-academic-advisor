module.exports = [
    {
        name: 'principal-officer-vc',
        question: 'Who is the Vice-Chancellor of BMU?',
        mustContain: ['dimie ogoina', 'vice-chancellor']
    },
    {
        name: 'principal-officer-vc-name-variant',
        question: 'Who is Prof Dimie Ogoina?',
        mustContain: ['dimie ogoina', 'vice-chancellor']
    },
    {
        name: 'principal-officer-vc-followup-style',
        question: 'I am talking about the VC, who is the person?',
        mustContain: ['dimie ogoina', 'vice-chancellor']
    },
    {
        name: 'principal-officer-bursar',
        question: 'Who is the Bursar of BMU?',
        mustContain: ['ebipuado ombu', 'bursar']
    },
    {
        name: 'principal-officer-bursar-accent-boss',
        question: 'Who is the bossar of BMU?',
        mustContain: ['ebipuado ombu', 'bursar']
    },
    {
        name: 'principal-officer-pro-chancellor',
        question: 'Who is the Chairman of the Governing Council of BMU?',
        mustContain: ['tarila tebepah', 'governing council']
    },
    {
        name: 'principal-officer-registrar',
        question: 'Who is the Registrar of BMU?',
        mustContain: ['felicia akusu', 'registrar']
    },
    {
        name: 'principal-officer-librarian',
        question: 'Who is the University Librarian?',
        mustContain: ['abraham etebu', 'librarian']
    },
    {
        name: 'fees-community-health',
        question: 'What is the fee for 100 level Community Health Science non-indigene at BMU?',
        mustContain: ['community health', '415,000', 'non-indigene']
    },
    {
        name: 'fees-community-health-indigene-300',
        question: 'How much is 300 level Community Health indigene fee?',
        mustContain: ['community health', '455,000', 'indigene']
    },
    {
        name: 'fees-mbbs-non-indigene',
        question: 'What is the fee for 100 level MBBS non-indigene at BMU?',
        mustContain: ['medicine', '1,230,000', 'non-indigene']
    },
    {
        name: 'fees-nursing-200-de',
        question: 'What is the Direct Entry 200 level Nursing Science fee for non-indigene?',
        mustContain: ['nursing', '950,000', 'non-indigene']
    },
    {
        name: 'fees-pharmacy-400-indigene',
        question: 'How much does a 400 level Pharmacy indigene pay?',
        mustContain: ['pharmacy', '490,000', 'indigene']
    },
    {
        name: 'fees-mls-600-non-indigene',
        question: 'Tell me the 600 level Medical Laboratory Science non-indigene fee',
        mustContain: ['medical laboratory', '940,000', 'non-indigene']
    },
    {
        name: 'fees-computer-science-table',
        question: 'Show BMU Computer Science fees',
        mustContain: ['computer science', '148,000', '300,000']
    },
    {
        name: 'courses-mls-300',
        question: 'Show 300 level Medical Laboratory Science first semester courses',
        mustContain: ['mls 313', 'basic hematology', 'all courses for bmu.xlsx']
    },
    {
        name: 'courses-mbbs-600',
        question: 'Show 600 level MBBS courses',
        mustContain: ['med 602', 'college of medicine bmu prospectus-new.docx']
    },
    {
        name: 'courses-community-health-100',
        question: 'Show 100 level community health science courses',
        mustContain: ['community health', '100 level']
    },
    {
        name: 'courses-public-health-200',
        question: 'What courses are in 200 level public health?',
        mustContain: ['public health', '200 level']
    },
    {
        name: 'mbbs-admission-requirements',
        question: 'What are the admission requirements for MBBS?',
        mustContain: ['medicine and surgery', 'physics', 'chemistry', 'biology', 'one sitting']
    },
    {
        name: 'mbbs-admission-not-sciences-ccmas',
        question: 'Admission requirements for medicine and surgery direct entry',
        mustContain: ['direct entry', 'medicine and dentistry ccmas', 'jamb']
    },
    {
        name: 'mbbs-duration',
        question: 'How many years is MBBS for UTME and direct entry?',
        mustContain: ['utme', 'six-year', 'direct entry', 'five-year']
    },
    {
        name: 'handbook-credit-load',
        question: 'What is the normal credit load for a BMU student?',
        mustContain: ['15 to 24', '9 units', '30 units', 'senate']
    },
    {
        name: 'handbook-credit-unit',
        question: 'What is the definition of a credit unit?',
        mustContain: ['one course credit unit', '1 hour', 'practical']
    },
    {
        name: 'handbook-reassessment',
        question: 'How can a student appeal or request reassessment of result?',
        mustContain: ['two weeks', 'n2,000', 'senate']
    },
    {
        name: 'bmu-law-visitor',
        question: 'Who is the Visitor of BMU under the law?',
        mustContain: ['visitor', 'governor']
    },
    {
        name: 'bmu-law-bursar-role',
        question: 'What is the role of the Bursar as chief financial officer under BMU Law?',
        mustContain: ['bursar', 'financial']
    },
    {
        name: 'bmu-law-pre-action-notice',
        question: 'What does BMU Law say about pre-action notice before suing the university?',
        mustContain: ['notice']
    },
    {
        name: 'about-bmu',
        question: 'Tell me about BMU',
        mustContain: ['bayelsa medical university', 'yenagoa']
    },
    {
        name: 'hello-greeting',
        question: 'hello',
        mustContain: ['dr tari', 'bmu academic advisor']
    }
];
