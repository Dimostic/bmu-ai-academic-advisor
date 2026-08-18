const SOURCE_TITLE = 'BMU Law cleaned.docx';
const LAW_TITLE = 'Bayelsa Medical University Yenagoa Law, 2018';

function hasLawScope(question) {
    const q = String(question || '');
    if (/\b(bmu\s+law|bayelsa\s+medical\s+university(?:\s+yenagoa)?\s+law|enabling\s+law|university\s+law|under\s+the\s+law|according\s+to\s+the\s+law|statute|statutes|section\s+\d+|what\s+law)\b/i.test(q)) {
        return true;
    }
    if (/\b(functions?|roles?|appoints?|appointed|appointment|remove|removed|removal|tenure|term|listed|principal|disputes?|resolves?|controls?|chairs?|chairman|meetings?|delegate|delegation|certify|certified|true\s+copy|visitation|disciplin\w*|suspend|misconduct|rusticat\w*|expel|expelled|expulsion|appeal|discrimination|discriminate|quorum|committee|seal|notice|retir\w*|retirement|pension|award|degree|certificate|honorary|fees?|manpower|speciali[sz]ed|proceedings?|vacanc\w*|personal\s+interest|cause\s+of\s+action|commissioner|governor|graduate|prescribed|teacher|undergraduate|acquire|open|create|scholarships?|medals?|expenditure|first\s+schedule)\b/i.test(q)
        && /\b(bmu|chancellors?|pro[-\s]?chancellors?|vice[-\s]?chancellors?|vc|dvc|council|senate|staff|student|examiner|professors?|academic\s+staff|bodies|university|registrar|bursar|librarian)\b/i.test(q)) {
        return true;
    }
    if (/\bdiscrimination\b/i.test(q)) return true;
    if (/\b(visitation|notice\s+of\s+action|personal\s+interest|proceedings?|vacanc\w*)\b/i.test(q)) return true;
    if (/\bcommittee\b/i.test(q) && /\b(property|expenditure)\b/i.test(q)) return true;
    return /\bbmu\b/i.test(q)
        && /\b(establish|body\s+corporate|sue|main\s+campus|vision|mission|manpower|powers?|award|degree|certificate|honorary|fees?|speciali[sz]ed|principal\s+officers?|chancellor|vice[-\s]?chancellor|dvc|visitor|council|senate|disciplin|misconduct|rusticat|expel|discrimination|land|quorum|committee|seal|notice|retir|pension|appoint|remove|removal|acquire|open|create|scholarships?|medals?|expenditure|registrar|bursar|librarian)\b/i.test(q);
}

function reply({ speech, markdown, section, confidence = 0.99 }) {
    return {
        speech_text: speech,
        display_markdown: markdown,
        topic_slug: 'bmu_law',
        citations: [{ title: SOURCE_TITLE, source: section }],
        suggested_actions: [],
        follow_up_questions: [],
        needs_escalation: false,
        confidence,
        _source: 'bmu_law_exact'
    };
}

function buildLawReply(question) {
    const q = String(question || '').trim().toLowerCase();
    if (!q || !hasLawScope(q)) return null;

    if (/(what\s+law|law\s+establish|establish(?:ed|ment)|short\s+title|citation)/i.test(q)) {
        return reply({
            section: 'Section 28 - Short Title and Citation; Section 1 - Establishment',
            speech: `Bayelsa Medical University was established by the ${LAW_TITLE}.`,
            markdown: `Bayelsa Medical University was established under **Section 1** of the **${LAW_TITLE}**.\n\nThe Law may be cited as the **${LAW_TITLE}**.`
        });
    }

    if (/(legal\s+personality|body\s+corporate|sue\s+and\s+be\s+sued|corporate\s+name|perpetual\s+succession|common\s+seal|acquire.*property|immovable\s+property|property\s+powers?)/i.test(q)) {
        return reply({
            section: 'Section 1 - Establishment and Incorporation',
            speech: 'Section 1 establishes BMU as a body corporate with perpetual succession and a common seal. It can sue and be sued, and may acquire, hold and dispose of movable and immovable property for its functions.',
            markdown: `Under **Section 1** of the **${LAW_TITLE}**, BMU is a **body corporate** with **perpetual succession** and a **common seal**.\n\nIt can **sue and be sued** in its corporate name, and may **acquire, hold and dispose of movable and immovable property** for its functions under the Law.`
        });
    }

    if (/(where|location|campus|main\s+campus|other\s+campuses|open\s+campuses)/i.test(q) && !/notice\s+of\s+action/i.test(q)) {
        return reply({
            section: 'Section 2 - Location of the University',
            speech: 'Section 2 says the main campus is at Imgbi Road, Amarata-Yenagoa. The University may also establish other campuses within Bayelsa State for smooth running of its programmes.',
            markdown: `Under **Section 2** of the **${LAW_TITLE}**:\n\n- The main campus is located at **Imgbi Road, Amarata-Yenagoa**.\n- The University may establish **other campuses within the State** for the smooth running of its programmes.`
        });
    }

    if (/\b(vision|mission|manpower|partner|partnership|health\s+needs|health\s+technology|public\s+benefit|meant\s+to\s+become)\b/i.test(q)) {
        return reply({
            section: 'Section 3 - The Vision and Mission of the University',
            speech: 'Section 3 gives BMU a vision of being a leading internationally recognized medical institution and a mission to provide scientific, technological and professional training in medical sciences, identify health needs, and support sustainable development.',
            markdown: `Under **Section 3** of the **${LAW_TITLE}**:\n\n- BMU's vision is to be a **leading internationally recognized medical institution** training professionally competent personnel in medicine and related health disciplines.\n- Its mission includes providing **scientific, technological and professional training in medical sciences**, identifying health needs and challenges, and supporting sustainable development.\n- The mission also includes manpower development in **medicine, health technology and basic applied sciences**, public benefit from research, health-care database development, and partnerships with relevant institutions.`
        });
    }

    if (/(finance\s+and\s+general\s+purposes|committee.*controls?.*(property|expenditure)|(property|expenditure).*committee)/i.test(q)) {
        return reply({
            section: 'Section 8 - Functions of the Council',
            speech: 'Section 8 provides for a Finance and General Purposes Committee, which exercises control over the property and expenditure of the University, subject to Council directions.',
            markdown: `Under **Section 8** of the **${LAW_TITLE}**, the **Finance and General Purposes Committee** exercises control over the University's **property and expenditure**, subject to the directions of **Council**.`
        });
    }

    if (/(who\s+awards?.*degrees?|degrees?.*awarded)|(appoints?.*(internal|external).*examiners?)|(internal|external).*examiners?/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 gives Senate control of courses and examinations, including appointing internal and external examiners, and awarding degrees and other prescribed qualifications.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, **Senate** controls courses and examinations, including appointment of **internal and external examiners**, and awards **degrees and other prescribed qualifications**.`
        });
    }

    if (/(committee|committees|co-opt|coopt|joint\s+meetings?|delegate.*award.*degree|award.*degree.*committee|council\s+committees?)/i.test(q)) {
        return reply({
            section: 'Section 22 - Appointment of Committees',
            speech: 'Section 22 allows University bodies to appoint committees, including committees that need not consist only of members of the appointing body, and permits co-opted members. It does not allow Senate to delegate the award of degrees to a committee.',
            markdown: `Under **Section 22** of the **${LAW_TITLE}**, University bodies may appoint committees, including committees that need not consist exclusively of their own members. A committee may also co-opt members, subject to the Law, statutes and regulations.\n\nThe section does **not** allow **Senate** to delegate the **award of degrees** to a committee. The Pro-Chancellor and Vice-Chancellor are members of Council committees except a committee of inquiry into conduct.`
        });
    }

    if (/(power|powers|facult|college|school|schools|institute|institutes|department|award|degree|certificate|honorary|fees?|speciali[sz]ed\s+health|research|scholarships?|medals?)|(power|powers).*(discipline|welfare)/i.test(q)
        && !/(student|disciplinary\s+measures)/i.test(q)) {
        return reply({
            section: 'Section 4 - Powers of the University',
            speech: 'Section 4 gives BMU powers including establishing colleges, faculties, schools and departments; appointing staff; awarding degrees, diplomas, certificates, scholarships, medals and honorary degrees; charging fees; providing discipline and welfare; and providing specialized health services and research.',
            markdown: `Under **Section 4** of the **${LAW_TITLE}**, BMU may, among other powers:\n\n- establish **colleges, faculties, schools, departments, centres and other teaching/research units**;\n- institute academic and administrative posts and make appointments;\n- award **degrees, diplomas, certificates, academic titles and other distinctions**;\n- award **fellowships, scholarships, medals**, honorary degrees and fellowships;\n- demand and receive fees as determined, subject to Governing Council directives;\n- provide for discipline and welfare; and\n- provide specialized health services and medical research.`
        });
    }

    if (/(appoint|appointment|remove|removal|tenure|term).*(deputy\s+vice[-\s]?chancellor|dvc)|(deputy\s+vice[-\s]?chancellor|dvc).*(appoint|appointment|remove|removal|tenure|term)/i.test(q)) {
        return reply({
            section: 'First Schedule - Appointment of Deputy Vice-Chancellors',
            speech: 'Under the First Schedule, the two Deputy Vice-Chancellors are appointed and removed by Council on the recommendation of Senate, after which the Visitor is notified. They hold office for one term of five years.',
            markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, there are two Deputy Vice-Chancellors. They are appointed and removed by **Council** on the recommendation of **Senate**, after which the **Visitor** is notified.\n\nThey hold office for **one term of five years**.`
        });
    }

    if (/(principal\s+officers?|constitution.*officers?|deputy\s+vice[-\s]?chancellors?|dvc|listed\s+as\s+a\s+principal)/i.test(q)) {
        return reply({
            section: 'Section 5 - Constitution and Principal Officers; First Schedule',
            speech: 'Section 5 lists the University as consisting of a Chancellor, Pro-Chancellor, Vice-Chancellor, Deputy Vice-Chancellor Administration, Deputy Vice-Chancellor Academic, Council, Senate, Congregation, Convocation, campuses, colleges, faculties, schools and other members prescribed by statute.',
            markdown: `Under **Section 5** of the **${LAW_TITLE}**, the University includes:\n\n- **Chancellor**;\n- **Pro-Chancellor**;\n- **Vice-Chancellor**;\n- **Deputy Vice-Chancellor Administration**;\n- **Deputy Vice-Chancellor Academic**;\n- **Council**, **Senate**, **Congregation** and **Convocation**; and\n- the campuses, colleges, faculties, schools, institutes, centres, graduates, undergraduates and other members recognized by statute.\n\nThe **First Schedule** gives further provisions on the principal officers.`
        });
    }

    if (/(pro[-\s]?chancellor).*(function|role|preside|chair|chairs|chairman|council|convocation|congregation)|(function|role|preside|chair|chairs|chairman).*(pro[-\s]?chancellor)|chairs?.*council.*meetings?|\bchancellor\b.*(function|role|preside|chair|chairs|chairman|convocation|congregation)|(function|role|preside|chair|chairs|chairman).*\bchancellor\b/i.test(q)
        && !/vice[-\s]?chancellor|deputy\s+vice[-\s]?chancellor|\bvc\b/i.test(q)) {
        return reply({
            section: 'Section 6 - Functions of the Chancellor, Pro-Chancellor and Chairman of Council',
            speech: 'Section 6 says the Chancellor takes precedence and presides at Congregation or Convocation when degrees are conferred. The Pro-Chancellor takes precedence after the Chancellor, except where the Vice-Chancellor acts as Chairman of Congregation or Convocation, and chairs Council meetings when present.',
            markdown: `Under **Section 6** of the **${LAW_TITLE}**:\n\n- The **Chancellor** takes precedence over other University members and, when present, presides at meetings of **Congregation or Convocation** held for conferring degrees.\n- The **Pro-Chancellor** chairs meetings of the **Council** when present, subject to the precedence rules in the section.`
        });
    }

    if (/(visitor|visitation|visitations?)/i.test(q)) {
        return reply({
            section: 'Section 14 - The Visitor of the University',
            speech: 'Section 14 states that the Governor is the Visitor of the University, visitation should occur as circumstances require and not less than once every four years, and University bodies must provide the facilities and assistance needed for the visitation.',
            markdown: `Under **Section 14** of the **${LAW_TITLE}**:\n\n- The **Governor** is the **Visitor of the University**.\n- The Visitor should conduct, or direct, a visitation **as circumstances require, not less than once every four years**.\n- University bodies and persons must provide required **facilities and assistance** and give effect to lawful visitation instructions.`
        });
    }

    if (/(vice[-\s]?chancellor|\bvc\b).*(function|role|power|duty|chairman)|(function|role|power|duty|chairman).*(vice[-\s]?chancellor|\bvc\b)/i.test(q)
        && !/(disciplin|misconduct|student|suspend)/i.test(q)) {
        return reply({
            section: 'Section 7 - Functions of the Vice-Chancellor',
            speech: 'Section 7 makes the Vice-Chancellor the Chief Executive Academic Officer, ex-officio Chairman of Senate, and the officer responsible for directing the activities of the University, with power to delegate functions to senior staff.',
            markdown: `Under **Section 7** of the **${LAW_TITLE}**, the Vice-Chancellor:\n\n- takes precedence over other University members, subject to the offices named in the Law;\n- directs the activities of the University;\n- is the **Chief Executive Academic Officer** of the University;\n- is the **ex-officio Chairman of Senate**; and\n- may delegate assigned functions to senior members of staff.`
        });
    }

    if (/(council).*(control|function|role|policy|finance|property|governing)|(control|function|role|policy|finance|property|governing).*(council)|policy.*finance.*property|controls?.*(bmu|university).*(finances?|property)/i.test(q)) {
        return reply({
            section: 'Section 8 - Functions of the Council',
            speech: 'Section 8 states that Council is the governing body and has general control and superintendence of the policy, finances and property of the University.',
            markdown: `Under **Section 8** of the **${LAW_TITLE}**, the **Council** is the governing body of the University and has general control and superintendence of the University's **policy, finances, and property**.`
        });
    }

    if (/(senate).*(control|function|role|teaching|admission|discipline|student)|(control|function|role|teaching|admission|discipline|student).*(senate)|teaching.*admission.*discipline|control.*admission.*student.*discipline/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 gives Senate general control over teaching, admission where no other enactment provides otherwise, discipline of students, and promotion of research.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, Senate generally organizes and controls:\n\n- **teaching** in the University;\n- **admission**, where no other enactment provides otherwise;\n- **discipline of students**; and\n- promotion of **research**.`
        });
    }

    if (/(make\s+statutes|power.*statutes|statutes?.*(purpose|made|approved|proved|proof|meaning|construction|dispute|cover|originate)|(meaning|construction|dispute|resolve|resolved|resolves|originate).*statutes?|two[-\s]?thirds|certificate.*(vice[-\s]?chancellor|registrar)|certif(?:y|ied).*statute|true\s+copy|chancellor.*meaning)/i.test(q)) {
        if (/\b(proved|proof|court|certificate|certify|certified|true\s+copy)\b/i.test(q)) {
            return reply({
                section: 'Section 12 - Proof of Statutes',
                speech: 'Section 12 says a statute may be proved in court by producing a copy certified as a true copy by the Vice-Chancellor or Registrar.',
                markdown: `Under **Section 12** of the **${LAW_TITLE}**, a statute may be proved in court by producing a copy bearing a certificate, apparently signed by the **Vice-Chancellor or Registrar**, that it is a true copy of a University statute.`
            });
        }
        if (/(meaning|construction|dispute|resolves?|resolved|binding|chancellor)/i.test(q)) {
            return reply({
                section: 'Section 13 - Construction of Statutes',
                speech: 'Section 13 says doubts or disputes about the meaning of a statute may be referred to the Chancellor, whose decision is binding on University authorities, staff and students, subject to court jurisdiction on validity.',
                markdown: `Under **Section 13** of the **${LAW_TITLE}**, a doubt or dispute about the meaning of a statute may be referred to the **Chancellor**.\n\nThe Chancellor's decision is binding on University authorities, staff and students, subject to a court of competent jurisdiction deciding whether a provision is void or ultra vires.`
            });
        }
        if (/(how|mode|approved|two[-\s]?thirds|originate|council|senate)/i.test(q)) {
            return reply({
                section: 'Section 11 - Mode of exercising power to make Statutes',
                speech: 'Section 11 says a proposed statute must be approved by not less than two-thirds of members present and voting in Senate and in Council. A proposed statute may originate in either Senate or Council.',
                markdown: `Under **Section 11** of the **${LAW_TITLE}**, a proposed statute does not become law unless approved by:\n\n- **Senate**, by not less than **two-thirds** of members present and voting; and\n- **Council**, by not less than **two-thirds** of members present and voting.\n\nA proposed statute may originate in either **Senate** or **Council**.`
            });
        }
        return reply({
            section: 'Section 10 - Power of the University to make Statutes',
            speech: 'Section 10 allows BMU to make statutes on the composition and powers of University authorities, student admission, discipline and welfare, academic or non-academic classification, and other matters authorized by the Law.',
            markdown: `Under **Section 10** of the **${LAW_TITLE}**, BMU may make statutes for matters such as:\n\n- the composition and constitution of University authorities;\n- powers and duties of University authorities;\n- student admission, discipline and welfare;\n- determining whether a matter is academic or non-academic; and\n- other matters authorized or required by the Law.`
        });
    }

    if (/(disciplin|misconduct|rusticat|expel|expelled|expulsion|appeal)/i.test(q) && /(student|vc|vice[-\s]?chancellor|expel|expelled|expulsion|appeal)/i.test(q)) {
        if (/appeal|expulsion|expel|rusticat/i.test(q)) {
            return reply({
                section: 'Section 18 - Disciplinary Measure Against Misconduct of a Student',
                speech: 'Yes. Under Section 18, where a student is rusticated or expelled, the student may appeal to Council within the prescribed period. The appeal does not stop the direction from operating until it is finally determined.',
                markdown: `Yes. Under **Section 18** of the **${LAW_TITLE}**, where a student is **rusticated or expelled**, the student may appeal to the **Council** within the prescribed period.\n\nThe Law also states that bringing the appeal **does not affect the operation of the direction** until the appeal is finally determined.`
            });
        }
        return reply({
            section: 'Section 18 - Disciplinary Measure Against Misconduct of a Student',
            speech: 'Under Section 18, the Vice-Chancellor may restrict the student from activities or facilities, restrict the student activities, rusticate the student, or expel the student.',
            markdown: `Under **Section 18** of the **${LAW_TITLE}**, where it appears to the Vice-Chancellor that a student is guilty of misconduct, the VC may direct that the student:\n\n- may not participate in specified University activities or use specified facilities for a stated period;\n- has activities restricted for a stated period;\n- be **rusticated** for a stated period; or\n- be **expelled** from the University.`
        });
    }

    if (/(academic|administrative|technical|professional|staff).*(disciplin|remove|removal|suspend|terminate|good\s+cause)|(disciplin|remove|removal|suspend|terminate|good\s+cause).*(academic|administrative|technical|professional|staff)|(vice[-\s]?chancellor|\bvc\b).*(suspend).*staff/i.test(q)) {
        return reply({
            section: 'Section 16 - Discipline and Removal of Academic, Administrative and Technical Staff',
            speech: 'Section 16 gives Council the removal process for academic, administrative, technical or professional staff, including notice, opportunity to make representations, possible joint Council and Senate investigation, and written instrument of removal. The Vice-Chancellor may suspend staff for misconduct prejudicial to the University, and must report it to Council.',
            markdown: `Under **Section 16** of the **${LAW_TITLE}**, where removal of academic, administrative, technical or professional staff is being considered, Council must give notice of the reasons and allow representations. If requested within one month by the person or by three Council members, a joint **Council and Senate** committee investigates and reports.\n\nThe **Vice-Chancellor** may suspend a staff member for misconduct considered prejudicial to the University's interest, but the suspension must be reported to **Council**.`
        });
    }

    if (/(examiner|examiners).*(remove|removal|appoint|replacement|heard)|(remove|removal|appoint|replacement|heard).*(examiner|examiners)/i.test(q)) {
        return reply({
            section: 'Section 17 - Removal of Examiners',
            speech: 'Section 17 says that on Senate recommendation, the Vice-Chancellor may remove an examiner after giving the examiner an opportunity to make representations, and may appoint another examiner in the removed examiner place.',
            markdown: `Under **Section 17** of the **${LAW_TITLE}**, on the recommendation of **Senate**, the **Vice-Chancellor** may remove an examiner after giving the examiner an opportunity to make representations in person. The VC may also appoint an appropriate replacement examiner on Senate's recommendation.`
        });
    }

    if (/(remove|removal).*(council\s+member|member\s+of\s+council)|(council\s+member|member\s+of\s+council|council\s+members?).*(remove|removal|removed)/i.test(q)) {
        return reply({
            section: 'Section 15 - Removal of Certain Members of Council',
            speech: 'Section 15 says Council may recommend removal of certain Council members through the Commissioner to the Governor, and if the Governor approves, removal may be directed.',
            markdown: `Under **Section 15** of the **${LAW_TITLE}**, where Council considers that a Council member, other than the Pro-Chancellor or Vice-Chancellor, should be removed, Council makes a recommendation through the **Commissioner** to the **Governor**. If the Governor approves, removal may be directed.`
        });
    }

    if (/(discrimination|discriminate|race|religion|sex|ethnic|place\s+of\s+birth|family\s+origin|political|physical\s+disability)/i.test(q)) {
        return reply({
            section: 'Section 19 - Exclusion of Discrimination',
            speech: 'Section 19 prohibits requiring or treating a person differently on grounds including race, ethnic grounds, sex, place of birth, family origin, religious or political persuasion, or physical disability, for student status, degree holding, appointment, employment or membership of a University body.',
            markdown: `Under **Section 19** of the **${LAW_TITLE}**, a person must not be required to satisfy requirements, or be treated differently, because of **race or ethnic grounds, sex, place of birth, family origin, religious or political persuasion, or physical disability** as a condition of being or continuing as a student, degree holder, employee/appointee, or member of a University body.`
        });
    }

    if (/(dispose|disposal|charge|land|lease|tenancy|governor.*consent)/i.test(q)) {
        return reply({
            section: 'Section 20 - Restriction on Disposal of Land by University',
            speech: 'Section 20 says BMU may not dispose of or charge land or an interest in land without the prior written consent of the State Governor, except for leases or tenancies at rack-rent not exceeding twenty-one years or residential leases or tenancies to University members.',
            markdown: `Under **Section 20** of the **${LAW_TITLE}**, BMU must not dispose of, or charge, land or an interest in land except with the **prior written consent** of the **State Governor**.\n\nThe consent requirement does not apply to a lease or tenancy at rack-rent for a term not exceeding **twenty-one years**, or to a residential lease/tenancy to a member of the University.`
        });
    }

    if (/(quorum|procedure).*(bod|bodies|university)|(bod(?:y|ies)|university).*(quorum|procedure)|who\s+determines.*(quorum|procedure)/i.test(q)) {
        return reply({
            section: 'Section 21 - Quorum and Procedure of Bodies',
            speech: 'Section 21 says that unless statutes or regulations provide otherwise, the quorum and procedure of a body established by the Law are determined by that body.',
            markdown: `Under **Section 21** of the **${LAW_TITLE}**, except as otherwise provided by statute or regulation, the **quorum and procedure** of a body established by the Law are determined by that body.`
        });
    }

    if (/(committee|committees|co-opt|joint\s+meetings?)/i.test(q)) {
        return reply({
            section: 'Section 22 - Appointment of Committees',
            speech: 'Section 22 allows bodies established by the Law to appoint committees, including committees that need not consist only of members of that body, and to authorize committees to exercise functions or co-opt members.',
            markdown: `Under **Section 22** of the **${LAW_TITLE}**, a body established by the Law may appoint committees, which need not consist exclusively of members of that body. It may authorize a committee to exercise functions on its behalf and may allow co-opted members, subject to the Law, statutes and regulations.`
        });
    }

    if (/(sue|suing|suit|legal\s+action|notice\s+of\s+action|notice)/i.test(q)) {
        return reply({
            section: 'Section 24 - Notice of Action against the Authority',
            speech: 'Section 24 requires three months written notice before suing BMU or its officers for acts done under the Law. The notice must state the cause of action, the intending plaintiff name and place of abode, and the relief claimed, and be delivered to the Registrar office or relevant abode.',
            markdown: `Under **Section 24** of the **${LAW_TITLE}**, a person must wait until after **three months** from delivery of a **written notice** before instituting a suit against the University or covered officers for acts done under the Law.\n\nThe notice must state:\n\n- the **cause of action**;\n- the intending plaintiff's **name and place of abode**; and\n- the **relief claimed**.\n\nIt should be delivered at the **Office of the Registrar** or at the relevant person's place of abode.`
        });
    }

    if (/(seal|document|contract|instrument|proceedings?|vacanc\w*|personal\s+interest|conflict\s+of\s+interest|stamp|administrative\s+provisions)/i.test(q)) {
        return reply({
            section: 'Section 23 - Miscellaneous Administrative Provisions',
            speech: 'Section 23 covers administrative matters including the University seal, authentication by the Pro-Chancellor, Vice-Chancellor, Registrar or other authorized person, receiving sealed documents in evidence, validity of proceedings despite vacancies, and disclosure of personal interest.',
            markdown: `**Section 23** of the **${LAW_TITLE}** covers miscellaneous administrative matters, including:\n\n- the University seal and authentication by the **Pro-Chancellor, Vice-Chancellor, Registrar**, or other authorized person;\n- receiving sealed University documents in **evidence**;\n- contracts or instruments made by persons authorized by Council;\n- validity of proceedings despite **vacancies**;\n- disclosure of **personal interest** by members of University bodies; and\n- service of notices or instruments.`
        });
    }

    if (/(pension|allowance|benefits?|fifteen\s+years|15\s+years|professors?.*pension|pension.*professors?)/i.test(q) && /professor|retirement\s+benefits|pension/i.test(q)) {
        return reply({
            section: 'Section 26 - Special Provision relating to Pension of Professors',
            speech: 'Section 26 provides for pension and allowances for a professor who retires after serving at least fifteen years as a professor in the University or continuously in State service up to retiring age, subject to the conditions in the section and Council determination of qualifying benefits.',
            markdown: `Under **Section 26** of the **${LAW_TITLE}**, a professor who retires after serving a minimum of **fifteen years** as a professor in the University, or continuously in State service up to retiring age under the stated conditions, is entitled to pension and such other allowances as **Council** may determine as qualifying retirement benefits.`
        });
    }

    if (/(retir|retirement|retiring\s+age|academic\s+staff|professors?)/i.test(q)) {
        return reply({
            section: 'Section 25 - Retiring Age of Academic Staff',
            speech: 'Section 25 sets the compulsory retiring age of academic staff at sixty-five years. A professor may elect to retire at seventy years by written notice.',
            markdown: `Under **Section 25** of the **${LAW_TITLE}**:\n\n- The compulsory retiring age of academic staff is **sixty-five years**.\n- A **professor** may elect to retire at **seventy years** by giving written notice to the University.\n- The public-service rule requiring retirement after thirty-five years does not apply to academic staff of the University.`
        });
    }

    if (/(commissioner|governor|graduate|misconduct|prescribed|professor|property|regulation|senate|state|teacher|undergraduate).*(\bmean\b|definition)|\bdefine\b|what\s+does\s+.+\s+\bmean\b|interpretation/i.test(q)) {
        const definitions = [
            ['commissioner', 'Commissioner means the State Commissioner charged with responsibility for Education.'],
            ['governor', 'Governor means the Governor of Bayelsa State of Nigeria.'],
            ['graduate', 'Graduate means a person on whom a degree, other than an honorary degree, has been conferred by the University.'],
            ['misconduct', 'Misconduct means improper behaviour according to the status and regulations of the University.'],
            ['prescribed', 'Prescribed means prescribed by Statute or Regulations.'],
            ['professor', 'Professor means a person designated as a professor of the University or by Regulations.'],
            ['property', 'Property or Properties includes rights, liabilities and obligations.'],
            ['regulation', 'Regulation means regulations made by the Senate or Council.'],
            ['senate', 'Senate means the Senate of the University established pursuant to Section 5(1)(g).'],
            ['state', 'State means Bayelsa State of Nigeria.'],
            ['teacher', 'Teacher means a member of the teaching or research staff of the University.'],
            ['undergraduate', 'Undergraduate means a person in statu-pupillari at the University, other than a graduate or a prescribed excluded description.']
        ];
        const hit = definitions.find(([term]) => new RegExp(`\\b${term}\\b`, 'i').test(q));
        if (hit) {
            return reply({
                section: 'Section 27 - Interpretation',
                speech: `Under Section 27, ${hit[1]}`,
                markdown: `Under **Section 27** of the **${LAW_TITLE}**: **${hit[1]}**`
            });
        }
        return reply({
            section: 'Section 27 - Interpretation',
            speech: 'Section 27 defines key terms used in the Law, including Commissioner, Governor, Graduate, Misconduct, Prescribed, Professor, Property, Regulation, Senate, State, Statute, Teacher, Undergraduate and the University.',
            markdown: `**Section 27** of the **${LAW_TITLE}** defines key terms used in the Law, including **Commissioner, Governor, Graduate, Misconduct, Prescribed, Professor, Property, Regulation, Senate, State, Statute, Teacher, Undergraduate**, and **the University**.`
        });
    }

    if (/(appoints?|appointed|appointment|remove|removed|removal|tenure|term).*(vice[-\s]?chancellor|\bvc\b)|(vice[-\s]?chancellor|\bvc\b).*(appoints?|appointed|appointment|remove|removed|removal|tenure|term)/i.test(q)) {
        return reply({
            section: 'First Schedule - Appointment and Removal of Vice-Chancellor',
            speech: 'Under the First Schedule, the Vice-Chancellor is appointed by the Governor on the recommendation of a joint selection committee of Senate and Council. The VC holds office for five years with no second term.',
            markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Vice-Chancellor** is appointed by the **Governor**, acting on the recommendation of a **joint selection committee of Senate and Council**.\n\nThe Schedule also states that the Vice-Chancellor holds office for **five years**, with **no second term**.`
        });
    }

    if (/(registrar|bursar|librarian).*(first\s+schedule|do|role|function|responsible|chief)|first\s+schedule.*(registrar|bursar|librarian)/i.test(q)) {
        if (/bursar/i.test(q)) {
            return reply({
                section: 'First Schedule - Bursar',
                speech: 'Under the First Schedule, the Bursar is the Chief Financial Officer and is responsible to the Vice-Chancellor for day-to-day administration and control of the University financial affairs.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Bursar** is the **Chief Financial Officer** of the University and is responsible to the **Vice-Chancellor** for day-to-day administration and control of the University's financial affairs.`
            });
        }
        if (/librarian/i.test(q)) {
            return reply({
                section: 'First Schedule - University Librarian',
                speech: 'Under the First Schedule, the University Librarian is responsible to the Vice-Chancellor for the University Library and coordination of library services.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **University Librarian** is responsible to the **Vice-Chancellor** for the **University Library** and for coordinating library services.`
            });
        }
        return reply({
            section: 'First Schedule - Registrar',
            speech: 'Under the First Schedule, the Registrar is the Chief Administrative Officer and Secretary to Council, Senate, Congregation and Convocation.',
            markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Registrar** is the **Chief Administrative Officer** of the University and serves as Secretary to **Council, Senate, Congregation and Convocation**.`
        });
    }

    if (/(appoints?|appointed|appointment|remove|removed|removal).*(chancellor)|chancellor.*(appoints?|appointed|appointment|remove|removed|removal)/i.test(q)) {
        if (/pro[-\s]?chancellor/i.test(q)) {
            return reply({
                section: 'First Schedule - Appointment of Pro-Chancellor',
                speech: 'Under the First Schedule, the Pro-Chancellor is appointed or removed by the Governor.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Pro-Chancellor** is appointed or removed by the **Governor**.`
            });
        }
        return reply({
            section: 'First Schedule - Appointment of Chancellor',
            speech: 'Under the First Schedule, the Chancellor is appointed by the Governor and holds office for five years.',
            markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Chancellor** is appointed by the **Governor** and holds office for **five years**.`
        });
    }

    return null;
}

module.exports = { buildLawReply };
