#!/usr/bin/env node
const { runSuite } = require('./run-suite');

function readRepeat(argv) {
  const index = argv.indexOf('--repeat');
  if (index < 0) return 2;
  return Number(argv[index + 1] || 2);
}

function printHuman(report) {
  console.log(`CONTRACT_GATE=${report.contractGate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.gates.determinismStable ? 'STABLE' : 'UNSTABLE'}`);
  console.log(`RUNNER_ERROR=${report.gates.runnerErrorCount}`);
  console.log(`GREEN_CONTROLS=${report.gates.greenControlsPass ? 'PASS' : 'FAIL'}`);
  report.results.forEach((result) => {
    const requestCount = (result.evidence.requests || []).length;
    const mutation = result.checks.find((entry) => entry.code.endsWith('STATE_ZERO_MUTATION'));
    const first = result.firstFailure ? result.firstFailure.code : '-';
    console.log(`${result.id}\t${result.status}\tFIRST=${first}\tAI=${requestCount}\tZERO_MUTATION=${mutation ? mutation.pass : 'N/A'}`);
  });
}

async function main() {
  const report = await runSuite({ repeat: readRepeat(process.argv.slice(2)) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exitCode = report.contractGate === 'HARNESS_FAILURE'
    ? 2
    : (report.contractGate === 'EXPECTED_RED' ? 1 : 0);
}

main().catch((error) => {
  console.error(`RUNNER_FATAL=${error.code || 'RUNNER_FATAL'} ${error.message}`);
  process.exitCode = 2;
});
