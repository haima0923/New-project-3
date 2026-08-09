#!/usr/bin/env node

const { runSuite } = require('./run-suite');

async function main() {
  const repeatIndex = process.argv.indexOf('--repeat');
  const report = await runSuite(repeatIndex >= 0 ? process.argv[repeatIndex + 1] : 2);
  const counts = report.results.reduce((output, result) => {
    output[result.status] = Number(output[result.status] || 0) + 1;
    return output;
  }, { CASE_FAIL: 0, PASS: 0, RUNNER_ERROR: 0 });
  console.log(`CONTRACT_GATE=${report.contractGate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.determinism}`);
  console.log(`PASS=${counts.PASS} CASE_FAIL=${counts.CASE_FAIL} RUNNER_ERROR=${counts.RUNNER_ERROR}`);
  console.log('EVIDENCE=STATIC_WXML+RENDERED_WXML+PAGE_VM');
  console.log('REAL_WXML=NOT_RUN_THIS_PHASE');
  report.results.forEach((result) => {
    console.log(`${result.id}\t${result.status}\tFIRST=${result.firstFailure ? result.firstFailure.code : '-'}`);
  });
  if (report.baselineDrift.length) console.log(`BASELINE_DRIFT=${JSON.stringify(report.baselineDrift)}`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.contractGate === 'PASS' ? 0
    : (report.contractGate === 'EXPECTED_RED' ? 1 : 2);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RUNNER_FATAL=${error.code || 'RUNNER_FATAL'} ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { main };
