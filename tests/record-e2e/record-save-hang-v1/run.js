#!/usr/bin/env node
const { runSuite } = require('./run-suite');

function repeatArg(argv) {
  const index = argv.indexOf('--repeat');
  if (index < 0) return 2;
  return Math.max(2, Number(argv[index + 1]) || 2);
}

runSuite(repeatArg(process.argv.slice(2))).then((report) => {
  report.results.forEach((item) => {
    const error = item.error ? ` ERROR=${item.error.code}:${item.error.message}` : '';
    console.log(`${item.id} ${item.status} FIRST_FAILURE=${item.firstFailure || '-'}${error}`);
  });
  console.log(`CONTRACT_GATE=${report.gate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`PASS=${report.pass}`);
  console.log(`CASE_FAIL=${report.caseFail}`);
  console.log(`RUNNER_ERROR=${report.runnerError}`);
  console.log(`DETERMINISM=${report.determinism}`);
  console.log(`BASELINE_DRIFT=${report.drift.length ? report.drift.join(',') : 'NONE'}`);
  if (report.gate === 'PASS') process.exitCode = 0;
  else if (report.gate === 'EXPECTED_RED') process.exitCode = 1;
  else process.exitCode = 2;
}).catch((error) => {
  console.error(`SAVE_HANG_RUNNER_ERROR ${error.code || 'RUNNER_ERROR'} ${error.message}`);
  process.exitCode = 2;
});
