module.exports = [
    {
        name: 'principal-officer-vc',
        question: 'Who is the Vice-Chancellor of BMU?',
        mustContain: ['dimie ogoina', 'vice-chancellor'],
        mustNotContain: ['principal officers are']
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
        name: 'principal-officer-vc-misspelling',
        question: 'Who is Dimian Ogyna in BMU?',
        mustContain: ['dimie ogoina', 'vice-chancellor']
    },
    {
        name: 'principal-officer-bursar',
        question: 'Who is the Bursar of BMU?',
        mustContain: ['ebipuado ombu', 'bursar'],
        mustNotContain: ['principal officers are']
    },
    {
        name: 'principal-officer-bursar-accent-boss',
        question: 'Who is the bossar of BMU?',
        mustContain: ['ebipuado ombu', 'bursar']
    },
    {
        name: 'principal-officer-bursar-role',
        question: 'Name the chief financial officer of BMU',
        mustContain: ['ebipuado ombu', 'bursar']
    },
    {
        name: 'principal-officer-pro-chancellor',
        question: 'Who is the Chairman of the Governing Council of BMU?',
        mustContain: ['tarila tebepah', 'governing council']
    },
    {
        name: 'principal-officer-pro-chancellor-alias',
        question: 'Who is the Pro Chancellor of BMU?',
        mustContain: ['tarila tebepah', 'pro-chancellor']
    },
    {
        name: 'principal-officer-chancellor-vacant',
        question: 'Who is the Chancellor of BMU?',
        mustContain: ['no appointed chancellor'],
        mustNotContain: ['dimie ogoina']
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
        name: 'principal-officer-librarian-liberian-variant',
        question: 'Who is the Liberian of BMU?',
        mustContain: ['abraham etebu', 'librarian'],
        mustNotContain: ['principal officers are']
    },
    {
        name: 'principal-officer-librarian-head-of-library',
        question: 'Who is the head of library at BMU?',
        mustContain: ['abraham etebu', 'librarian'],
        mustNotContain: ['principal officers are']
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
        name: 'fees-dentistry-300-non-indigene',
        question: 'How much is 300 level Dentistry for non indigene?',
        mustContain: ['dentistry', '1,015,000', 'non-indigene']
    },
    {
        name: 'fees-optometry-600-non-indigene',
        question: 'What is the 600 level Optometry non-indigene fee?',
        mustContain: ['optometry', '940,000', 'non-indigene']
    },
    {
        name: 'fees-public-health-100-table',
        question: 'Show the 100 level Public Health fee table',
        mustContain: ['public health', '100 level', 'indigene', 'non-indigene']
    },
    {
        name: 'fees-health-information-management-200-de',
        question: 'Health Information Management 200 Direct Entry non-indigene fee',
        mustContain: ['health information management', '200 direct entry', 'non-indigene']
    },
    {
        name: 'fees-current-by-programme-summary',
        question: 'What are current BMU fees by programme?',
        mustContain: ['fee summary by programme', 'medicine', 'nursing', 'indigene', 'non-indigene'],
        mustNotContain: ['bayelsa medical university yenagoa law', 'section 4', 'powers']
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
        name: 'courses-mls-alias',
        question: 'What are the 300 level med lab courses?',
        mustContain: ['medical laboratory', '300 level']
    },
    {
        name: 'courses-mbbs-prospectus-source',
        question: 'Which 500 level MBBS courses are listed?',
        mustContain: ['medicine', 'college of medicine bmu prospectus-new.docx']
    },
    {
        name: 'programme-overview-radiography',
        question: 'Tell me about Radiography',
        mustContain: ['radiography and radiation science', 'admission requirements', 'fees'],
        mustNotContain: ['matching bmu course entries', 'bmu-rad 214']
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
        name: 'mbbs-admission-direct-entry-variant',
        question: 'Can I enter MBBS by DE and what subjects are required?',
        mustContain: ['direct entry', 'physics', 'chemistry', 'biology']
    },
    {
        name: 'mbbs-admission-utme-one-sitting',
        question: 'Does medicine require one sitting in WAEC or NECO?',
        mustContain: ['medicine and surgery', 'one sitting', 'physics', 'english']
    },
    {
        name: 'mbbs-duration',
        question: 'How many years is MBBS for UTME and direct entry?',
        mustContain: ['utme', 'six-year', 'direct entry', 'five-year']
    },
    {
        name: 'mbbs-duration-direct-entry',
        question: 'Is MBBS five years for direct entry students?',
        mustContain: ['direct entry', 'five-year', 'medicine and dentistry ccmas']
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
        name: 'handbook-credit-load-low-high',
        question: 'Can a BMU student register below 9 units or above 30 units?',
        mustContain: ['below 9', 'above 30', 'senate approval']
    },
    {
        name: 'handbook-credit-load-normal-range',
        question: 'How many credit units should a full-time student normally register per semester?',
        mustContain: ['15 to 24', 'per semester', 'faculty board']
    },
    {
        name: 'handbook-reassessment',
        question: 'How can a student appeal or request reassessment of result?',
        mustContain: ['two weeks', 'n2,000', 'senate']
    },
    {
        name: 'handbook-reassessment-fee',
        question: 'What is the fee for remarking or reassessment of a course result?',
        mustContain: ['n2,000', 'two weeks', 'refundable']
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
        name: 'bmu-law-university-object',
        question: 'According to BMU Law, what is the object of the university?',
        mustContain: ['university']
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
