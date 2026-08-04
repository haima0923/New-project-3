#!/usr/bin/env node
const { runMultiItemOrderContract } = require('./run-suite');

function parseArgs(argv) {
  const options = { caseId: '', json: false, repeat: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--case-id') options.caseId = argv[++index] || '';
    else if (arg === '--repeat') options.repeat = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw Object.assign(new Error(`Unknown argument: ${arg}`), { code: 'TEST_DATA_ERROR' });
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw Object.assign(new Error('--repeat must be a positive integer'), { code: 'TEST_DATA_ERROR' });
  }
  return options;
}

function printRun(run) {
  console.log(`Cluster: ${run.clusterId}`);
  console.log(`Cases: ${run.selectedCaseCount}/${run.exactActiveCaseCount} (included in core count: ${run.includeInCoreCount})`);
  run.attempts.forEach((attempt) => {
    const summary = attempt.summary;
    console.log(`Attempt ${attempt.attempt}: PASS=${summary.PASS} CASE_FAIL=${summary.CASE_FAIL} RUNNER_ERROR=${summary.RUNNER_ERROR} BLOCKED=${summary.BLOCKED} SURFACE_ERROR=${summary.SURFACE_ERROR} EXPECTED_RED_DETECTED=${summary.expectedRedDetected} GREEN_CONTROL_FAILURE=${summary.greenControlFailures}`);
    attempt.results.forEach((result) => {
      const baselineLabel = result.contractKind === 'RED' && result.caseStatus === 'CASE_FAIL'
        ? ' EXPECTED_RED_BASELINE'
        : '';
      const failure = result.firstFailure ? ` first=${result.firstFailure.name}` : '';
      const error = result.error ? ` ${result.error.code}: ${result.error.message}` : '';
      console.log(`${result.caseStatus.padEnd(12)} ${result.caseId}${baselineLabel}${failure}${error}`);
    });
  });
  console.log(`Determinism: ${run.determinism.stable ? 'STABLE' : 'MISMATCH'}`);
  console.log('Evidence: Local=REAL_SOURCE ControlledAI=NOT_REAL FakeProvider=SEPARATE_CORE_OBSERVATION IsolatedCommit=NOT_PRODUCTION REAL_AI=NOT_RUN PageVM=NOT_RUN RealWXML=NOT_RUN');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tests/record-e2e/multi-item-order-complete-save-v1/run.js [--repeat N] [--case-id ID] [--json]');
    return;
  }
  const run = runMultiItemOrderContract(options);
  if (options.json) console.log(JSON.stringify(run, null, 2));
  else printRun(run);
  const last = run.attempts[run.attempts.length - 1].summary;
  if (last.RUNNER_ERROR || last.BLOCKED || last.SURFACE_ERROR || !run.determinism.stable) process.exitCode = 2;
  else if (last.CASE_FAIL) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { main, parseArgs, printRun };
