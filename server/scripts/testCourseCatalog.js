const courseCatalogService = require('../services/courseCatalogService');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function findRows(rows, predicate) {
    return rows.filter(predicate);
}

async function main() {
    const rows = await courseCatalogService.loadCatalog();
    assert(rows.length >= 1400, `Expected at least 1400 active course rows, found ${rows.length}`);

    const mls313 = rows.find(row => row.programme === 'MEDICAL LABORATORY SCIENCE' && row.courseCode === 'MLS 313');
    assert(mls313, 'MLS 313 should be available for Medical Laboratory Science');
    assert(mls313.sourceTitle === 'ALL COURSES FOR BMU.xlsx', `MLS 313 should come from ALL COURSES FOR BMU.xlsx, found ${mls313.sourceTitle}`);
    assert(Number(mls313.creditUnits) === 2, `MLS 313 should have 2 units, found ${mls313.creditUnits}`);

    const mls302 = rows.find(row => row.programme === 'MEDICAL LABORATORY SCIENCE' && row.courseCode === 'MLS 302');
    assert(!mls302, 'MLS 302 should not be presented as a BMU Medical Laboratory Science course');

    const mls300 = findRows(rows, row => row.programme === 'MEDICAL LABORATORY SCIENCE' && row.level === '300');
    assert(mls300.length === 18, `300 level Medical Laboratory Science should have 18 rows, found ${mls300.length}`);

    const med602 = rows.find(row => row.programme === 'MEDICINE AND SURGERY' && row.courseCode === 'MED 602');
    assert(med602, 'MED 602 should be available for Medicine and Surgery');
    assert(med602.sourceTitle === 'COLLEGE OF MEDICINE BMU PROSPECTUS-new.docx', `MED 602 should come from the College Prospectus, found ${med602.sourceTitle}`);
    assert(Number(med602.creditUnits) === 2, `MED 602 should have 2 units, found ${med602.creditUnits}`);

    const mbbs600 = findRows(rows, row => row.programme === 'MEDICINE AND SURGERY' && row.level === '600');
    assert(mbbs600.length === 38, `600 level Medicine and Surgery should have 38 rows, found ${mbbs600.length}`);

    const sourceCounts = rows.reduce((counts, row) => {
        counts[row.sourceTitle] = (counts[row.sourceTitle] || 0) + 1;
        return counts;
    }, {});

    console.log(JSON.stringify({
        ok: true,
        rows: rows.length,
        sourceCounts,
        checks: {
            mls313: `${mls313.courseTitle} (${mls313.creditUnits} units)`,
            mls300Rows: mls300.length,
            med602: `${med602.courseTitle} (${med602.creditUnits} units)`,
            mbbs600Rows: mbbs600.length
        }
    }, null, 2));
}

main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
});
