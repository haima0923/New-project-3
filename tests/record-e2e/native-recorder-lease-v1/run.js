#!/usr/bin/env node
const { runSuite } = require('./run-suite');

function repeatArg(argv) {
  const index = argv.indexOf('--repeat');
  if (index < 0) return 2;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value >= 2 ? value : 2;
}

const summary = runSuite(repeatArg(process.argv.slice(2)));
summary.results.forEach((entry) => {
  console.log(`${entry.id} ${entry.status} FIRST=${entry.firstFailure || '-'}`);
});
console.log(`CONTRACT_GATE=${summary.gate}`);
console.log(`ROUNDS=${summary.repeat}`);
console.log(`DETERMINISM=${summary.unstable.length ? 'UNSTABLE' : 'STABLE'}`);
console.log(`PASS=${summary.pass}`);
console.log(`CASE_FAIL=${summary.caseFail}`);
console.log(`RUNNER_ERROR=${summary.runnerError}`);
console.log(`BASELINE_PROFILE=${summary.profile}`);
if (summary.baselineDrift.length) console.log(`BASELINE_DRIFT=${summary.baselineDrift.join(',')}`);
if (summary.unstable.length) console.log(`UNSTABLE=${summary.unstable.join(',')}`);

if (summary.gate === 'HARNESS_FAILURE' || summary.gate === 'CONTRACT_DRIFT') process.exitCode = 2;
else if (summary.gate === 'EXPECTED_RED') process.exitCode = 1;
