const SOURCE_TITLE = 'BMU Law cleaned.docx';
const LAW_TITLE = 'Bayelsa Medical University Yenagoa Law, 2018';

function hasLawScope(question) {
    const q = String(question || '');
    if (/\b(bmu\s+law|bayelsa\s+medical\s+university(?:\s+yenagoa)?\s+law|enabling\s+law|university\s+law|under\s+the\s+law|according\s+to\s+the\s+law|by\s+law|the\s+law|legally|statute|statutes|section\s+\d+|section\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[-\s]?one|twenty[-\s]?two|twenty[-\s]?three|twenty[-\s]?four|twenty[-\s]?five|twenty[-\s]?six|twenty[-\s]?seven|twenty[-\s]?eight)|what\s+law)\b/i.test(q)) {
        return true;
    }
    if (/\b(functions?|roles?|appoints?|appointed|appointment|remove|removes|removed|removal|tenure|term|listed|principal|disputes?|resolves?|controls?|chairs?|chairman|meetings?|delegate|delegation|certify|certified|true\s+copy|visitation|disciplin\w*|suspend|misconduct|rusticat\w*|expel|expelled|expulsion|appeal|discrimination|discriminate|quorum|committee|seal|notice|retir\w*|retirement|pension|award|degree|certificate|honorary|fees?|charge|manpower|speciali[sz]ed|proceedings?|vacanc\w*|personal\s+interest|cause\s+of\s+action|commissioner|governor|graduate|prescribed|teacher|undergraduate|acquire|hold|open|create|set\s+up|employ|run|scholarships?|medals?|expenditure|first\s+schedule|legal\s+status|perpetual|succession|movable|immovable|campus|place|vision|training|partnerships?|centres?|fellowships?|members?|offices?|named|presides?|congregation|directs?|activities|courses?|halls?|vote|proposed\s+statute|prove|proved|court|visitor|visits?|employee|examiners?|exception|parent\s+body|pre[-\s]?action|lecturers?|chooses?|reappointed|responsibility|secretary|financial\s+officer|financial\s+affairs|library|library\s+services?)\b/i.test(q)
        && /\b(bmu|chancellors?|pro[-\s]?chancellors?|vice[-\s]?chancellors?|vc|dvc|council|senate|staff|student|examiners?|professors?|academic\s+staff|bodies|university|registrar|bursar|librarian)\b/i.test(q)) {
        return true;
    }
    if (/\b(define|definition|meaning\s+of|incorporation|corporate\s+status|legal\s+status|continue\s+forever|perpetual\s+succession|movable\s+property|immovable\s+property|own\s+property|dispose\s+property|be\s+sued|situated|another\s+campus|sort\s+of\s+institution|research\s+benefit|health\s+care\s+database|offer\s+diplomas|list\s+as\s+bmu\s+authorities|part\s+of\s+the\s+university|precedence\s+at\s+convocation|in\s+charge\s+of\s+university\s+activities|chair\s+of\s+senate\s+by\s+office|controls?\s+admission|controls?\s+student\s+discipline|controls?\s+examinations|majority.*statute|certif(?:y|ies)\s+statutes|investigates\s+staff\s+removal|examiner\s+be\s+replaced|examiner\s+make\s+representation|mortgage\s+land|land\s+lease|body\s+create\s+a\s+committee|non\s+members|signs?\s+the\s+seal|interest\s+be\s+disclosed|months\s+before\s+suing|35\s+year\s+rule|professor\s+allowances|removes?\s+the\s+chancellor|pro\s+chancellor\s+first\s+term|vc\s+serve|bursar\s+reports|librarian\s+is\s+responsible|quorum|co-opted|pre[-\s]?action|chief\s+executive\s+academic\s+officer|chief\s+financial\s+officer|financial\s+affairs|university\s+library|library\s+services|compulsory\s+retirement|lecturer\s+retirement|visitor|visits?\s+bmu|above\s+other\s+university\s+members|presides?\s+over\s+congregation|pro\s+chancellor|governing\s+council|governing\s+body|controls?\s+finances|property\s+expenditure|teaching\s+control|controls?\s+exams?|professor\s+emeritus|student\s+welfare|academic\s+and\s+non-academic|two\s+thirds|statute\s+start|staff\s+suspension|rustication\s+goes|appeal\s+pause|land\s+disposal|residential\s+lease|regulations\s+do\s+not\s+say|committee\s+have\s+outsiders|council\s+committees|authenticate\s+seal|under\s+seal\s+evidence|conflict\s+of\s+interest|courses\s+of\s+study|halls\s+of\s+residence|honorary\s+degrees?|proposed\s+statute|21\s+year\s+land\s+exception|parent\s+body|finance\s+and\s+general\s+purposes|chooses?\s+the\s+chancellor|chancellor\s+tenure)\b/i.test(q)) return true;
    if (/\bdiscrimination\b/i.test(q)) return true;
    if (/\b(visitation|notice\s+of\s+action|pre[-\s]?action\s+notice|personal\s+interest|proceedings?|vacanc\w*)\b/i.test(q)) return true;
    if (/\bcommittee\b/i.test(q) && /\b(property|expenditure)\b/i.test(q)) return true;
    return /\bbmu\b/i.test(q)
        && /\b(establish|body\s+corporate|sue|main\s+campus|vision|mission|manpower|powers?|award|degree|certificate|honorary|fees?|charge|speciali[sz]ed|principal\s+officers?|chancellor|vice[-\s]?chancellor|dvc|visitor|council|senate|disciplin|misconduct|rusticat|expel|discrimination|land|quorum|committee|seal|notice|retir|pension|appoint|remove|removal|acquire|hold|open|create|set\s+up|scholarships?|medals?|expenditure|registrar|bursar|librarian|legal\s+status|perpetual|movable|campus|place|training|fellowships?|directs?|activities|courses?|vote|prove|court|employee|pre[-\s]?action|lecturers?|chooses?|reappointed|responsibility)\b/i.test(q);
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

    if (/(incorporation|corporate\s+status|continue\s+forever|perpetual\s+succession|own\s+(land|property)|dispose\s+property|be\s+sued)/i.test(q)) {
        return reply({
            section: 'Section 1 - Establishment and Incorporation',
            speech: 'Section 1 establishes BMU as a body corporate with perpetual succession and a common seal. It can sue and be sued, and may acquire, hold and dispose of movable and immovable property for its functions.',
            markdown: `Under **Section 1** of the **${LAW_TITLE}**, BMU is a **body corporate** with **perpetual succession** and a **common seal**.\n\nIt can **sue and be sued**, and may **acquire, hold and dispose of movable and immovable property**, including land, for its functions under the Law.`
        });
    }

    if (/(situated|another\s+campus)/i.test(q)) {
        return reply({
            section: 'Section 2 - Location of the University',
            speech: 'Section 2 places the main campus at Imgbi Road, Amarata-Yenagoa, and allows the University to establish other campuses within the State.',
            markdown: `Under **Section 2** of the **${LAW_TITLE}**, BMU's main campus is at **Imgbi Road, Amarata-Yenagoa**. The University may also establish **other campuses within the State**.`
        });
    }

    if (/(sort\s+of\s+institution|research\s+benefit|health\s+care\s+database)/i.test(q)) {
        return reply({
            section: 'Section 3 - The Vision and Mission of the University',
            speech: 'Section 3 describes BMU as a leading internationally recognized medical institution, with mission items including research for public benefit and health-care database development.',
            markdown: `Under **Section 3** of the **${LAW_TITLE}**, BMU's vision is to be a leading internationally recognized **medical institution**.\n\nIts mission includes research for **public benefit**, health needs identification, and health-care **database** development.`
        });
    }

    if (/(appoint\s+lecturers|offer\s+diplomas|provide\s+welfare\s+and\s+discipline)/i.test(q)) {
        return reply({
            section: 'Section 4 - Powers of the University',
            speech: 'Section 4 empowers BMU to institute academic posts and appointments, award diplomas and other qualifications, and provide for discipline and welfare.',
            markdown: `Under **Section 4** of the **${LAW_TITLE}**, BMU may institute academic **posts** and make appointments, award **diplomas** and other qualifications, and provide for **discipline** and **welfare**.`
        });
    }

    if (/(list\s+as\s+bmu\s+authorities|part\s+of\s+the\s+university|graduates?\s+part\s+of\s+the\s+university)/i.test(q)) {
        return reply({
            section: 'Section 5 - Constitution and Principal Officers',
            speech: 'Section 5 lists the University as including its officers, Council, Senate, Congregation, Convocation, campuses, colleges, faculties, schools, graduates, undergraduates and other members recognized by statute.',
            markdown: `Under **Section 5** of the **${LAW_TITLE}**, BMU includes **Council**, **Senate**, **Congregation**, **Convocation**, its officers, campuses, colleges, faculties and schools, as well as **graduates**, **undergraduates**, and other members recognized by statute.`
        });
    }

    if (/(precedence\s+at\s+convocation|chairs?\s+council\s+if\s+present)/i.test(q)) {
        return reply({
            section: 'Section 6 - Functions of the Chancellor, Pro-Chancellor and Chairman of Council',
            speech: 'Section 6 gives the Chancellor precedence and the role of presiding at Congregation or Convocation for conferring degrees. The Pro-Chancellor chairs Council meetings when present.',
            markdown: `Under **Section 6** of the **${LAW_TITLE}**, the **Chancellor** takes precedence and presides at **Congregation or Convocation** for conferring degrees. The **Pro-Chancellor** chairs **Council** meetings when present.`
        });
    }

    if (/(in\s+charge\s+of\s+university\s+activities|chair\s+of\s+senate\s+by\s+office)/i.test(q)) {
        return reply({
            section: 'Section 7 - Functions of the Vice-Chancellor',
            speech: 'Section 7 makes the Vice-Chancellor responsible for directing University activities and the ex-officio Chairman of Senate.',
            markdown: `Under **Section 7** of the **${LAW_TITLE}**, the **Vice-Chancellor** directs the activities of the University and is the **ex-officio Chairman of Senate**.`
        });
    }

    if (/(committee\s+handles\s+expenditure|which\s+committee\s+handles\s+expenditure)/i.test(q)) {
        return reply({
            section: 'Section 8 - Functions of the Council',
            speech: 'The Finance and General Purposes Committee controls the property and expenditure of the University, subject to Council directions.',
            markdown: `Under **Section 8** of the **${LAW_TITLE}**, the **Finance and General Purposes Committee** controls University **property and expenditure**, subject to Council directions.`
        });
    }

    if (/(controls?\s+admission|controls?\s+student\s+discipline|controls?\s+examinations|honorary\s+fellowship)/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 gives Senate control over teaching, admission, student discipline, courses, examinations, and recommendations for honorary fellowship or honorary degree.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, **Senate** controls **teaching**, **admission**, **student discipline**, courses and **examinations**. It also recommends **honorary fellowship** or honorary degree to Council.`
        });
    }

    if (/(majority.*statute|certif(?:y|ies)\s+statutes?|true\s+copies)/i.test(q)) {
        if (/certif|true\s+copies/i.test(q)) {
            return reply({
                section: 'Section 12 - Proof of Statutes',
                speech: 'Section 12 says statutes may be proved by a certified true copy signed by the Vice-Chancellor or Registrar.',
                markdown: `Under **Section 12** of the **${LAW_TITLE}**, statutes may be proved by a copy certified as true by the **Vice-Chancellor** or **Registrar**.`
            });
        }
        return reply({
            section: 'Section 11 - Mode of exercising power to make Statutes',
            speech: 'Section 11 requires approval by not less than two-thirds of members present and voting in Senate and Council.',
            markdown: `Under **Section 11** of the **${LAW_TITLE}**, a statute requires approval by not less than **two-thirds** of members present and voting in **Senate** and **Council**.`
        });
    }

    if (/(investigates\s+staff\s+removal|examiner\s+(be\s+)?replaced|examiner\s+make\s+representation)/i.test(q)) {
        if (/examiner/i.test(q)) {
            return reply({
                section: 'Section 17 - Removal of Examiners',
                speech: 'Section 17 provides that the Vice-Chancellor may remove and replace an examiner on Senate recommendation after giving the examiner an opportunity to make representations.',
                markdown: `Under **Section 17** of the **${LAW_TITLE}**, the **Vice-Chancellor** may remove and appoint a **replacement** examiner on Senate's recommendation, after giving the examiner an opportunity to make **representations**.`
            });
        }
        return reply({
            section: 'Section 16 - Discipline and Removal of Academic, Administrative and Technical Staff',
            speech: 'Section 16 provides for a joint Council and Senate committee to investigate staff removal when properly requested.',
            markdown: `Under **Section 16** of the **${LAW_TITLE}**, when staff removal is contested as provided, a joint **Council and Senate** committee investigates and reports.`
        });
    }

    if (/(mortgage\s+land|land\s+lease)/i.test(q)) {
        return reply({
            section: 'Section 20 - Restriction on Disposal of Land by University',
            speech: 'Section 20 requires prior written consent of the State Governor before BMU disposes of or charges land, except for leases or tenancies at rack-rent not exceeding twenty-one years and residential leases to University members.',
            markdown: `Under **Section 20** of the **${LAW_TITLE}**, BMU needs the **prior written consent** of the **State Governor** to dispose of or charge land.\n\nThe exception includes a lease or tenancy at rack-rent not exceeding **twenty-one years**, and a residential lease or tenancy to a University member.`
        });
    }

    if (/(body\s+create\s+a\s+committee|non\s+members)/i.test(q)) {
        return reply({
            section: 'Section 22 - Appointment of Committees',
            speech: 'Section 22 allows a University body to appoint committees, including committees that do not consist exclusively of members of that body.',
            markdown: `Under **Section 22** of the **${LAW_TITLE}**, a University body may create a committee, and the committee need **not consist exclusively** of members of that body.`
        });
    }

    if (/(signs?\s+the\s+seal|interest\s+be\s+disclosed)/i.test(q)) {
        return reply({
            section: 'Section 23 - Miscellaneous Administrative Provisions',
            speech: 'Section 23 provides for seal authentication by the Pro-Chancellor, Vice-Chancellor, Registrar or other authorized person, and requires disclosure of personal interest before voting.',
            markdown: `Under **Section 23** of the **${LAW_TITLE}**, the University seal may be authenticated by the **Pro-Chancellor**, **Vice-Chancellor**, **Registrar**, or another authorized person.\n\nA member with a **personal interest** in a matter must disclose it and must not vote on that matter.`
        });
    }

    if (/(months\s+before\s+suing|35\s+year\s+rule|professor\s+allowances|removes?\s+the\s+chancellor|pro\s+chancellor\s+first\s+term|vc\s+serve|bursar\s+reports|librarian\s+is\s+responsible)/i.test(q)) {
        if (/35\s+year/i.test(q)) {
            return reply({
                section: 'Section 25 - Retiring Age of Academic Staff',
                speech: 'Section 25 says the thirty-five year public service retirement rule does not apply to BMU academic staff.',
                markdown: `Under **Section 25** of the **${LAW_TITLE}**, the public-service retirement rule after thirty-five years **does not apply** to BMU academic staff.`
            });
        }
        if (/professor\s+allowances/i.test(q)) {
            return reply({
                section: 'Section 26 - Special Provision relating to Pension of Professors',
                speech: 'Section 26 says Council determines the pension and allowances that qualify as retirement benefits for professors under the section.',
                markdown: `Under **Section 26** of the **${LAW_TITLE}**, **Council** determines the pension and allowances qualifying as retirement benefits for professors under the section.`
            });
        }
        if (/months\s+before\s+suing/i.test(q)) {
            return reply({
                section: 'Section 24 - Notice of Action against the Authority',
                speech: 'Section 24 requires three months written notice before suing BMU or covered officers for acts done under the Law.',
                markdown: `Under **Section 24** of the **${LAW_TITLE}**, a person must give **three months** written notice before suing BMU or covered officers for acts done under the Law.`
            });
        }
        if (/removes?\s+the\s+chancellor/i.test(q)) {
            return reply({
                section: 'First Schedule - Appointment of Chancellor',
                speech: 'Under the First Schedule, the Visitor may remove the Chancellor by notice in the Gazette for misconduct or inability.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Visitor** may remove the **Chancellor** by notice in the Gazette for misconduct or inability.`
            });
        }
        if (/pro\s+chancellor\s+first\s+term/i.test(q)) {
            return reply({
                section: 'First Schedule - Appointment of Pro-Chancellor',
                speech: 'Under the First Schedule, the Pro-Chancellor holds office for four years, and may be reappointed for a second term of three years.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Pro-Chancellor** holds office for **four years**, and may be reappointed for a second term of **three years**.`
            });
        }
        if (/vc\s+serve/i.test(q)) {
            return reply({
                section: 'First Schedule - Appointment and Removal of Vice-Chancellor',
                speech: 'Under the First Schedule, the Vice-Chancellor holds office for five years, with no second term.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Vice-Chancellor** serves for **five years**, with **no second term**.`
            });
        }
        if (/bursar\s+reports/i.test(q)) {
            return reply({
                section: 'First Schedule - Bursar',
                speech: 'Under the First Schedule, the Bursar is responsible to the Vice-Chancellor for day-to-day administration and control of the University financial affairs.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Bursar** reports to the **Vice-Chancellor** for day-to-day administration and control of the University's financial affairs.`
            });
        }
        return reply({
            section: 'First Schedule - University Librarian',
            speech: 'Under the First Schedule, the University Librarian is responsible to the Vice-Chancellor for the University Library and coordination of library services.',
            markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **University Librarian** is responsible for the **University Library** and library services, under the Vice-Chancellor.`
        });
    }

    if (/(what\s+law|law\s+establish|establish(?:ed|ment)|short\s+title|citation)/i.test(q)) {
        return reply({
            section: 'Section 28 - Short Title and Citation; Section 1 - Establishment',
            speech: `Bayelsa Medical University was established by the ${LAW_TITLE}.`,
            markdown: `Bayelsa Medical University was established under **Section 1** of the **${LAW_TITLE}**.\n\nThe Law may be cited as the **${LAW_TITLE}**.`
        });
    }

    if (/(corporate\s+status|legal\s+(personality|status)|body\s+corporate|be\s+sued|sue\s+and\s+be\s+sued|corporate\s+name|perpetual\s+succession|common\s+seal|own\s+property|acquire.*property|hold.*property|movable\s+property|immovable\s+property|property\s+powers?)/i.test(q)) {
        return reply({
            section: 'Section 1 - Establishment and Incorporation',
            speech: 'Section 1 establishes BMU as a body corporate with perpetual succession and a common seal. It can sue and be sued, and may acquire, hold and dispose of movable and immovable property for its functions.',
            markdown: `Under **Section 1** of the **${LAW_TITLE}**, BMU is a **body corporate** with **perpetual succession** and a **common seal**.\n\nIt can **sue and be sued** in its corporate name, and may **acquire, hold and dispose of movable and immovable property** for its functions under the Law.`
        });
    }

    if (/(where|location|campus|main\s+campus|other\s+campuses|open\s+campuses)/i.test(q) && !/(notice\s+of\s+action|pre[-\s]?action\s+notice|appeal|rustication|expulsion)/i.test(q)) {
        return reply({
            section: 'Section 2 - Location of the University',
            speech: 'Section 2 says the main campus is at Imgbi Road, Amarata-Yenagoa. The University may also establish other campuses within Bayelsa State for smooth running of its programmes.',
            markdown: `Under **Section 2** of the **${LAW_TITLE}**:\n\n- The main campus is located at **Imgbi Road, Amarata-Yenagoa**.\n- The University may establish **other campuses within the State** for the smooth running of its programmes.`
        });
    }

    if (/\b(vision|mission|manpower|partner|partnerships?|health\s+needs|health\s+technology|public\s+benefit|meant\s+to\s+become|training)\b/i.test(q)) {
        return reply({
            section: 'Section 3 - The Vision and Mission of the University',
            speech: 'Section 3 gives BMU a vision of being a leading internationally recognized medical institution and a mission to provide scientific, technological and professional training in medical sciences, identify health needs, and support sustainable development.',
            markdown: `Under **Section 3** of the **${LAW_TITLE}**:\n\n- BMU's vision is to be a **leading internationally recognized medical institution** training professionally competent personnel in medicine and related health disciplines.\n- Its mission includes providing **scientific, technological and professional training in medical sciences**, identifying health needs and challenges, and supporting sustainable development.\n- The mission also includes manpower development in **medicine, health technology and basic applied sciences**, public benefit from research, health-care database development, and partnerships with relevant institutions.`
        });
    }

    if (/(finance\s+and\s+general\s+purposes|committee.*controls?.*(property|expenditure)|committee.*for|controls?\s+property\s+expenditure|(property|expenditure).*committee)/i.test(q)) {
        return reply({
            section: 'Section 8 - Functions of the Council',
            speech: 'Section 8 provides for a Finance and General Purposes Committee, which exercises control over the property and expenditure of the University, subject to Council directions.',
            markdown: `Under **Section 8** of the **${LAW_TITLE}**, the **Finance and General Purposes Committee** exercises control over the University's **property and expenditure**, subject to the directions of **Council**.`
        });
    }

    if (/(who\s+awards?.*degrees?|degrees?.*awarded)|(appoints?.*(internal|external).*examiners?)|(internal|external).*examiners?/i.test(q)
        && !/presides?|congregation|convocation/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 gives Senate control of courses and examinations, including appointing internal and external examiners, awarding degrees and other prescribed qualifications, recommending honorary degrees and professor emeritus, and making provision for halls of residence and student welfare.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, **Senate** controls courses and examinations, including appointment of **internal and external examiners**, and awards **degrees and other prescribed qualifications**.\n\nSection 9 also covers recommendations for **honorary degrees** and **professor emeritus**, provision for **halls of residence**, and student **welfare**.`
        });
    }

    if (/recommends?.*honorary|honorary\s+degrees?.*recommend/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 provides that Senate makes recommendations to Council for honorary fellowship, honorary degree, or the title of professor emeritus.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, **Senate** makes recommendations to **Council** for the award of **honorary fellowship**, **honorary degree**, or the title of **professor emeritus**.`
        });
    }

    if (/(committee|committees|co-opt|coopt|joint\s+meetings?|delegate.*award.*degree|award.*degree.*committee|council\s+committees?)/i.test(q)) {
        return reply({
            section: 'Section 22 - Appointment of Committees',
            speech: 'Section 22 allows University bodies to appoint committees, including committees that need not consist only of members of the appointing body, and permits co-opted members. It does not allow Senate to delegate the award of degrees to a committee.',
            markdown: `Under **Section 22** of the **${LAW_TITLE}**, University bodies may appoint committees, including committees that need not consist exclusively of their own members. A committee may also co-opt members, subject to the Law, statutes and regulations.\n\nThe section does **not** allow **Senate** to delegate the **award of degrees** to a committee. The Pro-Chancellor and Vice-Chancellor are members of Council committees except a committee of inquiry into conduct.`
        });
    }

    if (/(power|powers|facult|college|school|schools|institute|institutes|department|centres?|set\s+up|create|employ.*academic\s+staff|academic\s+staff|award|degree|certificate|honorary|fees?|charge\s+students?|speciali[sz]ed\s+health|medical\s+research|run\s+medical\s+research|research|scholarships?|medals?|fellowships?|discipline\s+members?)|(power|powers).*(discipline|welfare)/i.test(q)
        && !/(student\s+disciplin|disciplin.*student|disciplinary\s+measures|presides?|congregation|convocation|recommends?.*honorary)/i.test(q)) {
        return reply({
            section: 'Section 4 - Powers of the University',
            speech: 'Section 4 gives BMU powers including establishing colleges, faculties, schools and departments; instituting academic posts and appointing staff; awarding degrees, diplomas, certificates, scholarships, medals and honorary degrees; charging fees; providing discipline and welfare; and providing specialized health services and research.',
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

    if (/(principal\s+officers?|constitution.*officers?|members\s+of\s+the\s+university|part\s+of\s+bmu|deputy\s+vice[-\s]?chancellors?|dvc|listed\s+as\s+a\s+principal|offices?.*make\s+up|convocation.*named|section\s+five)/i.test(q)) {
        return reply({
            section: 'Section 5 - Constitution and Principal Officers; First Schedule',
            speech: 'Section 5 lists the University as consisting of a Chancellor, Pro-Chancellor, Vice-Chancellor, Deputy Vice-Chancellor Administration, Deputy Vice-Chancellor Academic, Council, Senate, Congregation, Convocation, campuses, colleges, faculties, schools and other members prescribed by statute.',
            markdown: `Under **Section 5** of the **${LAW_TITLE}**, the University includes:\n\n- **Chancellor**;\n- **Pro-Chancellor**;\n- **Vice-Chancellor**;\n- **Deputy Vice-Chancellor Administration**;\n- **Deputy Vice-Chancellor Academic**;\n- **Council**, **Senate**, **Congregation** and **Convocation**; and\n- the campuses, colleges, faculties, schools, institutes, centres, graduates, undergraduates and other members recognized by statute.\n\nThe **First Schedule** gives further provisions on the principal officers.`
        });
    }

    if (/(pro[-\s]?chancellor).*(function|role|do|preside|chair|chairs|chairman|council|convocation|congregation)|(function|role|preside|chair|chairs|chairman).*(pro[-\s]?chancellor)|chairs?.*(governing\s+)?council|above.*university\s+members|presides?.*congregation|\bchancellor\b.*(function|role|preside|chair|chairs|chairman|convocation|congregation)|(function|role|preside|chair|chairs|chairman).*\bchancellor\b/i.test(q)
        && !/vice[-\s]?chancellor|deputy\s+vice[-\s]?chancellor|\bvc\b/i.test(q)) {
        return reply({
            section: 'Section 6 - Functions of the Chancellor, Pro-Chancellor and Chairman of Council',
            speech: 'Section 6 says the Chancellor takes precedence and presides at Congregation or Convocation when degrees are conferred. The Pro-Chancellor takes precedence after the Chancellor, except where the Vice-Chancellor acts as Chairman of Congregation or Convocation, and chairs Council meetings when present.',
            markdown: `Under **Section 6** of the **${LAW_TITLE}**:\n\n- The **Chancellor** takes precedence over other University members and, when present, presides at meetings of **Congregation or Convocation** held for conferring degrees.\n- The **Pro-Chancellor** chairs meetings of the **Council** when present, subject to the precedence rules in the section.`
        });
    }

    if (/(visitor|visitation|visitations?|visits?\s+bmu)/i.test(q)) {
        return reply({
            section: 'Section 14 - The Visitor of the University',
            speech: 'Section 14 states that the Governor is the Visitor of the University, visitation should occur as circumstances require and not less than once every four years, and University bodies must provide the facilities and assistance needed for the visitation.',
            markdown: `Under **Section 14** of the **${LAW_TITLE}**:\n\n- The **Governor** is the **Visitor of the University**.\n- The Visitor should conduct, or direct, a visitation **as circumstances require, not less than once every four years**.\n- University bodies and persons must provide required **facilities and assistance** and give effect to lawful visitation instructions.`
        });
    }

    if (/(vice[-\s]?chancellor|\bvc\b).*(function|role|power|duty|chairman|directs?|activities|delegate|work)|(function|role|power|duty|chairman|directs?|chief\s+executive\s+academic\s+officer).*(vice[-\s]?chancellor|\bvc\b)|directs?.*bmu.*activities|chief\s+executive\s+academic\s+officer|vc\s+delegate\s+work/i.test(q)
        && !/(disciplin|misconduct|student|suspend)/i.test(q)) {
        return reply({
            section: 'Section 7 - Functions of the Vice-Chancellor',
            speech: 'Section 7 makes the Vice-Chancellor the Chief Executive Academic Officer, ex-officio Chairman of Senate, and the officer responsible for directing the activities of the University, with power to delegate functions to senior staff.',
            markdown: `Under **Section 7** of the **${LAW_TITLE}**, the Vice-Chancellor:\n\n- takes precedence over other University members, subject to the offices named in the Law;\n- directs the activities of the University;\n- is the **Chief Executive Academic Officer** of the University;\n- is the **ex-officio Chairman of Senate**; and\n- may delegate assigned functions to senior members of staff.`
        });
    }

    if (/(council).*(control|function|role|policy|finance|property|governing)|(control|function|role|policy|finance|property|governing).*(council)|policy.*finance.*property|controls?.*(bmu|university).*(finances?|property|policy)|controls?.*university\s+policy|governing\s+body|controls?\s+finances/i.test(q)) {
        return reply({
            section: 'Section 8 - Functions of the Council',
            speech: 'Section 8 states that Council is the governing body and has general control and superintendence of the policy, finances and property of the University.',
            markdown: `Under **Section 8** of the **${LAW_TITLE}**, the **Council** is the governing body of the University and has general control and superintendence of the University's **policy, finances, and property**.`
        });
    }

    if (/(senate).*(control|function|role|teaching|admission|discipline|student|research|halls?|honorary|welfare)|(control|function|role|teaching|admission|discipline|student|courses?|exams?|halls?|honorary|welfare).*(senate)|teaching\s+control|controls?\s+exams?|handles?\s+teaching|student\s+welfare|teaching.*admission.*discipline|control.*admission.*student.*discipline|courses?\s+of\s+study|recommends?.*honorary|professor\s+emeritus|halls?\s+of\s+residence/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 gives Senate general control over teaching, admission where no other enactment provides otherwise, discipline of students, promotion of research, examinations, awards, honorary degrees, professor emeritus, halls of residence, and student welfare.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, Senate generally organizes and controls:\n\n- **teaching** in the University;\n- **admission**, where no other enactment provides otherwise;\n- **discipline of students**;\n- promotion of **research**;\n- courses, examinations and awards; and\n- matters including **honorary degrees**, **professor emeritus**, **halls of residence**, and student **welfare**.`
        });
    }

    if (/(make\s+statutes|power.*statutes|statutes?.*(purpose|made|approved|proved|proof|prove|meaning|construction|dispute|cover|originate|regulate|decide)|regulate.*students?.*statutes?|academic\s+and\s+non-academic|two\s+thirds|(meaning|construction|dispute|resolve|resolved|resolves|originate|prove).*statutes?|two[-\s]?thirds|vote.*statute|pass.*statute|statute\s+start|proposed\s+statute|court.*statute|bad\s+statute|certificate.*(vice[-\s]?chancellor|registrar)|certif(?:y|ied).*statute|true\s+copy|chancellor.*meaning)/i.test(q)) {
        if (/\b(prove|proved|proof|certificate|certify|certified|true\s+copy)\b/i.test(q)) {
            return reply({
                section: 'Section 12 - Proof of Statutes',
                speech: 'Section 12 says a statute may be proved in court by producing a copy certified as a true copy by the Vice-Chancellor or Registrar.',
                markdown: `Under **Section 12** of the **${LAW_TITLE}**, a statute may be proved in court by producing a copy bearing a certificate, apparently signed by the **Vice-Chancellor or Registrar**, that it is a true copy of a University statute.`
            });
        }
        if (/(meaning|construction|dispute|resolves?|resolved|binding|chancellor|court|ultra\s+vires|bad\s+statute)/i.test(q)) {
            return reply({
                section: 'Section 13 - Construction of Statutes',
                speech: 'Section 13 says doubts or disputes about the meaning of a statute may be referred to the Chancellor, whose decision is binding on University authorities, staff and students, subject to court jurisdiction on validity.',
                markdown: `Under **Section 13** of the **${LAW_TITLE}**, a doubt or dispute about the meaning of a statute may be referred to the **Chancellor**.\n\nThe Chancellor's decision is binding on University authorities, staff and students, subject to a court of competent jurisdiction deciding whether a provision is void or ultra vires.`
            });
        }
        if (/(how|mode|approved|two[-\s]?thirds|originate|council|senate|vote|pass)/i.test(q)) {
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

    if (/(academic|administrative|technical|professional|staff|employee).*(disciplin|remove|removal|suspend|suspension|terminate|good\s+cause)|(disciplin|remove|removal|suspend|suspension|terminate|good\s+cause).*(academic|administrative|technical|professional|staff|employee)|staff\s+suspension|(vice[-\s]?chancellor|\bvc\b).*(suspend).*(staff|employee)/i.test(q)) {
        return reply({
            section: 'Section 16 - Discipline and Removal of Academic, Administrative and Technical Staff',
            speech: 'Section 16 gives Council the removal process for academic, administrative, technical or professional staff for good cause, including notice, opportunity to make representations, possible joint Council and Senate investigation, and written instrument of removal. The Vice-Chancellor may suspend staff for misconduct prejudicial to the University, and must report it to Council.',
            markdown: `Under **Section 16** of the **${LAW_TITLE}**, where removal of academic, administrative, technical or professional staff is being considered for **good cause**, Council must give notice of the reasons and allow representations. If requested within one month by the person or by three Council members, a joint **Council and Senate** committee investigates and reports.\n\nThe **Vice-Chancellor** may **suspend** a staff member for misconduct considered prejudicial to the University's interest, but the suspension must be reported to **Council**.`
        });
    }

    if (/(examiner|examiners).*(remove|removes|removal|appoint|replacement|heard|respond)|(remove|removes|removal|appoint|replacement|heard|respond).*(examiner|examiners)|who\s+removes\s+examiners/i.test(q)) {
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

    if (/(dispose|disposal|charge.*land|land\s+disposal|land|lease|tenancy|governor.*consent|residential\s+lease|21\s+year.*exception)/i.test(q)) {
        return reply({
            section: 'Section 20 - Restriction on Disposal of Land by University',
            speech: 'Section 20 says BMU may not dispose of or charge land or an interest in land without the prior written consent of the State Governor, except for leases or tenancies at rack-rent not exceeding twenty-one years or residential leases or tenancies to University members.',
            markdown: `Under **Section 20** of the **${LAW_TITLE}**, BMU must not dispose of, or charge, land or an interest in land except with the **prior written consent** of the **State Governor**.\n\nThe consent requirement does not apply to a lease or tenancy at rack-rent for a term not exceeding **twenty-one years**, or to a residential lease/tenancy to a member of the University.`
        });
    }

    if (/(quorum|procedure).*(bod|bodies|university|regulation)|(bod(?:y|ies)|university|regulation).*(quorum|procedure)|who\s+(determines|fixes|decides).*(quorum|procedure)|decides?.*procedure|fixes?.*quorum/i.test(q)) {
        return reply({
            section: 'Section 21 - Quorum and Procedure of Bodies',
            speech: 'Section 21 says that unless statutes or regulations provide otherwise, the quorum and procedure of a body established by the Law are determined by that body.',
            markdown: `Under **Section 21** of the **${LAW_TITLE}**, except as otherwise provided by statute or regulation, the **quorum and procedure** of a body established by the Law are determined by that body.`
        });
    }

    if (/(committee|committees|co-opt|coopt|co-opted|joint\s+meetings?|parent\s+body|outside\s+the\s+parent|committee\s+have\s+outsiders|council\s+committees)/i.test(q)) {
        return reply({
            section: 'Section 22 - Appointment of Committees',
            speech: 'Section 22 allows bodies established by the Law to appoint committees, including committees that need not consist only of members of that body, and to authorize committees to exercise functions or co-opt members.',
            markdown: `Under **Section 22** of the **${LAW_TITLE}**, a body established by the Law may appoint committees, which need not consist exclusively of members of that body. It may authorize a committee to exercise functions on its behalf and may allow co-opted members, subject to the Law, statutes and regulations.`
        });
    }

    if (/(sue|suing|suit|legal\s+action|notice\s+of\s+action|pre[-\s]?action\s+notice|notice)/i.test(q)) {
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

    if (/(retir|retirement|retiring\s+age|academic\s+staff|professors?|lecturer\s+retirement|lecturers?)/i.test(q)) {
        return reply({
            section: 'Section 25 - Retiring Age of Academic Staff',
            speech: 'Section 25 sets the compulsory retiring age of academic staff at sixty-five years. A professor may elect to retire at seventy years by written notice.',
            markdown: `Under **Section 25** of the **${LAW_TITLE}**:\n\n- The compulsory retiring age of academic staff is **sixty-five years**.\n- A **professor** may elect to retire at **seventy years** by giving written notice to the University.\n- The public-service rule requiring retirement after thirty-five years does not apply to academic staff of the University.`
        });
    }

    if (/(commissioner|governor|graduate|misconduct|prescribed|professor|property|regulation|senate|state|teacher|undergraduate).*(\bmean\b|definition)|\bdefine\b|meaning\s+of|what\s+does\s+.+\s+\bmean\b|interpretation/i.test(q)) {
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

    if (/(registrar|bursar|librarian).*(first\s+schedule|do|role|function|responsib(?:le|ility)|chief|coordinates?|secretary|manages?)|first\s+schedule.*(registrar|bursar|librarian)|chief\s+financial\s+officer|manages?.*(financial|library)|financial\s+affairs|university\s+library|coordinates?.*library\s+services?/i.test(q)) {
        if (/bursar|chief\s+financial\s+officer|financial\s+affairs/i.test(q)) {
            return reply({
                section: 'First Schedule - Bursar',
                speech: 'Under the First Schedule, the Bursar is the Chief Financial Officer and is responsible to the Vice-Chancellor for day-to-day administration and control of the University financial affairs.',
                markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Bursar** is the **Chief Financial Officer** of the University and is responsible to the **Vice-Chancellor** for day-to-day administration and control of the University's financial affairs.`
            });
        }
        if (/librarian|university\s+library|library\s+services?/i.test(q)) {
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

    if (/(appoints?|appointed|appointment|remove|removed|removal|chooses?|tenure|hold\s+office|long).*(chancellor)|chancellor.*(appoints?|appointed|appointment|remove|removed|removal|chooses?|tenure|hold\s+office|long)/i.test(q)) {
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
