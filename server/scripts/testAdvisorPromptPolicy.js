#!/usr/bin/env node

const persona = require('../services/advisorPersonaService');

function assertIncludes(text, fragment) {
    if (!text.toLowerCase().includes(fragment.toLowerCase())) {
        throw new Error(`Prompt is missing required policy text: ${fragment}`);
    }
}

function main() {
    const prompt = persona.buildSystemPrompt({
        question: 'What are the admission requirements and fees for MBBS?',
        ragContext: ''
    });

    [
        'HIGH-RISK ACADEMIC FACT POLICY',
        'admission eligibility',
        'fees, payment conditions',
        'deadlines, academic calendar dates',
        'course registration, credit load',
        'graduation requirements',
        'no current authoritative source',
        'needs_escalation true',
        'Never fill gaps with general model knowledge'
    ].forEach(fragment => assertIncludes(prompt, fragment));

    console.log(JSON.stringify({
        ok: true,
        checked: 'advisor high-risk prompt policy'
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
