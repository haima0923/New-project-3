#!/usr/bin/env node
const { runSuite } = require('./run-suite');

function parseRepeat(argv) {
  const index = argv.indexOf('--repeat');
  if (index < 0) return 2;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 2) {
    const error = new Error('--repeat must be an integer >= 2');
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  return value;
}

async function main() {
  const repeat = parseRepeat(process.argv.slice(2));
  const report = await runSuite(repeat);
  report.results.forEach((entry) => {
    const detail = entry.status === 'RUNNER_ERROR'
      ? `${entry.error.code}:${entry.error.message}`
      : (entry.firstFailure || 'ALL_CHECKS_PASS');
    process.stdout.write(`${entry.id} ${entry.status} ${detail}\n`);
  });
  process.stdout.write(`CONTRACT_GATE=${report.gate}\n`);
  process.stdout.write(`ROUNDS=${report.repeat}\n`);
  process.stdout.write(`DETERMINISM=${report.unstable.length ? 'UNSTABLE' : 'STABLE'}\n`);
  process.stdout.write(`PASS=${report.passCount}\n`);
  process.stdout.write(`CASE_FAIL=${report.failCount}\n`);
  process.stdout.write(`RUNNER_ERROR=${report.runnerErrorCount}\n`);
  if (report.drift.length) process.stdout.write(`BASELINE_DRIFT=${report.drift.join(',')}\n`);
  if (report.greenFailures.length) process.stdout.write(`GREEN_FAILURE=${report.greenFailures.join(',')}\n`);
  if (report.unstable.length) process.stdout.write(`UNSTABLE_CASES=${report.unstable.join(',')}\n`);
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  process.stderr.write(`HOLD_RUNNER_FATAL ${error.code || 'UNEXPECTED'} ${error.message}\n`);
  process.exitCode = 2;
});
