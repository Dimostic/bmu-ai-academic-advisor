#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const qualityService = require('../services/responseQualityService');

const benchCases = [
  {
    name: 'fee-structure',
    question: 'How much is the tuition fee for MBBS?',
    answer: 'The MBBS tuition fee is charged according to the approved fee structure for the current session. Students should check the official BMU fee schedule and payment portal for the exact amount for their programme.',
    context: 'MBBS fee schedule and payment policy approved by the university fee committee and published in the student handbook.',
    citations: ['fee_schedule', 'student_handbook'],
    expectedMinScore: 0.58,
    needsEscalation: false
  },
  {
    name: 'programme-policy',
    question: 'What happens if a student fails a course and must repeat?',
    answer: 'A student who fails a course may be required to repeat the course or satisfy the academic regulations for carry-over and progression. The exact requirement depends on the university policy and the student’s programme progression rules.',
    context: 'Academic progression and repeat policy for BMU programmes, including carry-over, repeated courses, and progression standards.',
    citations: ['academic_policy', 'programme_regulations'],
    expectedMinScore: 0.55,
    needsEscalation: false
  },
  {
    name: 'uncertain-answer',
    question: 'Who is the Vice Chancellor of Bayelsa Medical University?',
    answer: 'I am not fully certain about the current Vice Chancellor appointment details. Please check the university portal or the registrar’s office for the most recent official information.',
    context: 'Official university leadership and governance records are published on the BMU portal and registrar announcements.',
    citations: ['university_governance'],
    expectedMinScore: 0.45,
    needsEscalation: false
  }
];

function printCase(result) {
  const score = Number(result.metrics.overall_score || 0);
  const pass = score >= result.expectedMinScore;
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${result.name}`);
  console.log(`  overall=${score.toFixed(3)} threshold=${result.expectedMinScore.toFixed(2)}`);
  console.log(`  addressed=${(result.metrics.addressed_score || 0).toFixed(3)} grounding=${(result.metrics.grounding_score || 0).toFixed(3)} citations=${(result.metrics.citation_score || 0).toFixed(3)}`);
  console.log(`  auto_cache=${result.autoCacheEligible ? 'eligible' : 'not-eligible'}`);
}

async function main() {
  console.log('========================================');
  console.log('  Advisor Benchmark Suite');
  console.log('========================================');

  let failed = 0;

  for (const item of benchCases) {
    try {
      const result = qualityService.evaluate({
        questionText: item.question,
        answerText: item.answer,
        ragContext: item.context,
        citations: item.citations,
        needsEscalation: item.needsEscalation
      });

      const autoCacheEligible = result.metrics.overall_score >= 0.84
        && result.metrics.addressed_score >= 0.72
        && result.metrics.grounding_score >= 0.62;

      printCase({ ...item, metrics: result.metrics, autoCacheEligible });

      if (Number(result.metrics.overall_score || 0) < item.expectedMinScore) {
        failed += 1;
      }
    } catch (error) {
      console.log(`\n[ERROR] ${item.name}: ${error.message}`);
      failed += 1;
    }
  }

  console.log('\n========================================');
  console.log(failed === 0 ? '  Benchmark suite passed' : `  Benchmark suite failed (${failed} case(s))`);
  console.log('========================================\n');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
