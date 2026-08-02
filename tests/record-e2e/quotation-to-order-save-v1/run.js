#!/usr/bin/env node
const { runQuotationToOrderSuite } = require('./run-suite');

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
  console.log(`Cases: ${run.exactActiveCaseCount} (included in core count: ${run.includeInCoreCount})`);
  run.attempts.forEach((attempt) => {
    const summary = attempt.summary;
    console.log(`Attempt ${attempt.attempt}: PASS=${summary.PASS} CASE_FAIL=${summary.CASE_FAIL} RUNNER_ERROR=${summary.RUNNER_ERROR} BLOCKED=${summary.BLOCKED} SURFACE_ERROR=${summary.SURFACE_ERROR}`);
    attempt.results.forEach((result) => {
      console.log(`${result.caseStatus.padEnd(12)} ${result.caseId}${result.failureReason ? ` ${result.failureReason}` : ''}`);
    });
  });
  console.log(`Determinism: ${run.determinism.stable ? 'STABLE' : 'MISMATCH'}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tests/record-e2e/quotation-to-order-save-v1/run.js [--repeat N] [--case-id ID] [--json]');
    return;
  }
  const run = await runQuotationToOrderSuite(options);
  if (options.json) console.log(JSON.stringify(run, null, 2));
  else printRun(run);
  const last = run.attempts[run.attempts.length - 1].summary;
  if (last.RUNNER_ERROR || last.BLOCKED || last.SURFACE_ERROR || !run.determinism.stable) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { main, parseArgs, printRun };
