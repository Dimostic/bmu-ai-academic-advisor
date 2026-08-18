const SOURCE_TITLE = 'BMU Law cleaned.docx';
const LAW_TITLE = 'Bayelsa Medical University Yenagoa Law, 2018';

function hasLawScope(question) {
    return /\b(bmu\s+law|bayelsa\s+medical\s+university\s+yenagoa\s+law|university\s+law|under\s+the\s+law|according\s+to\s+the\s+law)\b/i.test(String(question || ''));
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
            markdown: `Bayelsa Medical University was established under the **${LAW_TITLE}**.\n\nThe Law may be cited as the **${LAW_TITLE}**.`
        });
    }

    if (/(where|location|campus|main\s+campus|other\s+campuses)/i.test(q)) {
        return reply({
            section: 'Section 2 - Location of the University',
            speech: 'Section 2 says the main campus is at Imgbi Road, Amarata-Yenagoa. The University may also establish other campuses within Bayelsa State for smooth running of its programmes.',
            markdown: `Under **Section 2** of the **${LAW_TITLE}**:\n\n- The main campus is located at **Imgbi Road, Amarata-Yenagoa**.\n- The University may establish **other campuses within the State** for the smooth running of its programmes.`
        });
    }

    if (/(visitor|visitation|visitations?)/i.test(q)) {
        return reply({
            section: 'Section 14 - The Visitor of the University',
            speech: 'Section 14 states that the Governor is the Visitor of the University, and visitation should occur as circumstances require, not less than once every four years.',
            markdown: `Under **Section 14** of the **${LAW_TITLE}**:\n\n- The **Governor** is the **Visitor of the University**.\n- The Visitor should conduct, or direct, a visitation **as circumstances require, not less than once every four years**.`
        });
    }

    if (/(vice[-\s]?chancellor|\bvc\b).*(function|role|power|duty)|function|role|power|duty.*(vice[-\s]?chancellor|\bvc\b)/i.test(q)) {
        return reply({
            section: 'Section 7 - Functions of the Vice-Chancellor',
            speech: 'Section 7 makes the Vice-Chancellor the Chief Executive Academic Officer, ex-officio Chairman of Senate, and the officer responsible for directing the activities of the University, with power to delegate functions to senior staff.',
            markdown: `Under **Section 7** of the **${LAW_TITLE}**, the Vice-Chancellor:\n\n- takes precedence over other University members, subject to the offices named in the Law;\n- directs the activities of the University;\n- is the **Chief Executive Academic Officer** of the University;\n- is the **ex-officio Chairman of Senate**; and\n- may delegate assigned functions to senior members of staff.`
        });
    }

    if (/(council).*(control|function|policy|finance|property|governing)|policy.*finance.*property/i.test(q)) {
        return reply({
            section: 'Section 8 - Functions of the Council',
            speech: 'Section 8 states that Council is the governing body and has general control and superintendence of the policy, finances and property of the University.',
            markdown: `Under **Section 8** of the **${LAW_TITLE}**, the **Council** is the governing body of the University and has general control and superintendence of the University's **policy, finances, and property**.`
        });
    }

    if (/(senate).*(control|function|teaching|admission|discipline|student)|teaching.*admission.*discipline/i.test(q)) {
        return reply({
            section: 'Section 9 - Functions of the Senate',
            speech: 'Section 9 gives Senate general control over teaching, admission where no other enactment provides otherwise, discipline of students, and promotion of research.',
            markdown: `Under **Section 9** of the **${LAW_TITLE}**, Senate generally organizes and controls:\n\n- **teaching** in the University;\n- **admission**, where no other enactment provides otherwise;\n- **discipline of students**; and\n- promotion of **research**.`
        });
    }

    if (/(disciplin|misconduct|rusticat|expel|expulsion|appeal)/i.test(q) && /(student|vc|vice[-\s]?chancellor|expel|expulsion|appeal)/i.test(q)) {
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

    if (/(sue|suing|suit|legal\s+action|notice\s+of\s+action|notice)/i.test(q)) {
        return reply({
            section: 'Section 24 - Notice of Action against the Authority',
            speech: 'Section 24 requires three months written notice before suing BMU or its officers for acts done under the Law. The notice must state the cause of action, the intending plaintiff name and place of abode, and the relief claimed, and be delivered to the Registrar office or relevant abode.',
            markdown: `Under **Section 24** of the **${LAW_TITLE}**, a person must wait until after **three months** from delivery of a **written notice** before instituting a suit against the University or covered officers for acts done under the Law.\n\nThe notice must state:\n\n- the **cause of action**;\n- the intending plaintiff's **name and place of abode**; and\n- the **relief claimed**.\n\nIt should be delivered at the **Office of the Registrar** or at the relevant person's place of abode.`
        });
    }

    if (/(retir|retirement|retiring\s+age|academic\s+staff|professor)/i.test(q)) {
        return reply({
            section: 'Section 25 - Retiring Age of Academic Staff',
            speech: 'Section 25 sets the compulsory retiring age of academic staff at sixty-five years. A professor may elect to retire at seventy years by written notice.',
            markdown: `Under **Section 25** of the **${LAW_TITLE}**:\n\n- The compulsory retiring age of academic staff is **sixty-five years**.\n- A **professor** may elect to retire at **seventy years** by giving written notice to the University.\n- The public-service rule requiring retirement after thirty-five years does not apply to academic staff of the University.`
        });
    }

    if (/(appoint|appointment|remove|removal).*(vice[-\s]?chancellor|\bvc\b)|(vice[-\s]?chancellor|\bvc\b).*(appoint|appointment|remove|removal|term)/i.test(q)) {
        return reply({
            section: 'First Schedule - Appointment and Removal of Vice-Chancellor',
            speech: 'Under the First Schedule, the Vice-Chancellor is appointed by the Governor on the recommendation of a joint selection committee of Senate and Council. The VC holds office for five years with no second term.',
            markdown: `Under the **First Schedule** of the **${LAW_TITLE}**, the **Vice-Chancellor** is appointed by the **Governor**, acting on the recommendation of a **joint selection committee of Senate and Council**.\n\nThe Schedule also states that the Vice-Chancellor holds office for **five years**, with **no second term**.`
        });
    }

    if (/(appoint|appointment|remove|removal).*(chancellor)|chancellor.*(appoint|appointment|remove|removal)/i.test(q)) {
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
