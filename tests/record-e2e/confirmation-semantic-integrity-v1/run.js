#!/usr/bin/env node
const { runSuite } = require('./run-suite');

function repeatFrom(argv) {
  const index = argv.indexOf('--repeat');
  return index < 0 ? 2 : Number(argv[index + 1] || 2);
}

function printHuman(report) {
  console.log(`CONTRACT_GATE=${report.gate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.determinism.stable ? 'STABLE' : 'UNSTABLE'}`);
  Object.entries(report.totals).forEach(([key, value]) => console.log(`${key}=${value}`));
  console.log(`TAXONOMY=${JSON.stringify(report.taxonomy)}`);
  report.results.forEach((item) => {
    const first = item.firstFailure ? `${item.firstFailure.taxonomy}|${item.firstFailure.code}` : '-';
    console.log(`${item.id}\t${item.status}\t${item.category}\tFIRST=${first}`);
  });
}

async function main() {
  const report = await runSuite({ repeat: repeatFrom(process.argv.slice(2)) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exitCode = report.gate === 'PASS' ? 0 : (report.gate === 'EXPECTED_RED' ? 1 : 2);
}

main().catch((error) => {
  console.error(`RUNNER_FATAL=${error.code || 'RUNNER_FATAL'} ${error.message}`);
  process.exitCode = 2;
});
