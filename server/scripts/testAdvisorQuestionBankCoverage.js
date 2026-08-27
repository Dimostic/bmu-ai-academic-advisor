#!/usr/bin/env node

const questionBank = require('./advisorGoldenQuestionBank');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    assert(Array.isArray(questionBank), 'Question bank must export an array');
    assert(questionBank.length >= 300, `Expected at least 300 broad evaluation questions, got ${questionBank.length}`);

    const ids = new Set();
    const categories = new Map();
    for (const item of questionBank) {
        assert(item.id && typeof item.id === 'string', 'Every question needs a stable id');
        assert(!ids.has(item.id), `Duplicate question id: ${item.id}`);
        ids.add(item.id);
        assert(item.question && item.question.length >= 12, `Question ${item.id} is too short`);
        assert(Array.isArray(item.sourcePriority) && item.sourcePriority.length, `Question ${item.id} needs sourcePriority`);
        categories.set(item.category, (categories.get(item.category) || 0) + 1);
    }

    [
        'programme',
        'student_handbook',
        'fees',
        'officers',
        'admissions',
        'courses',
        'bmu_law',
        'recent_sources'
    ].forEach(category => {
        assert(categories.has(category), `Missing question category: ${category}`);
    });

    const highRisk = questionBank.filter(item => item.risk === 'high').length;
    assert(highRisk >= 180, `Expected at least 180 high-risk academic/admin questions, got ${highRisk}`);

    console.log(JSON.stringify({
        success: true,
        checked: 'Broad advisor evaluation question bank',
        count: questionBank.length,
        highRisk,
        categories: Object.fromEntries(categories)
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
