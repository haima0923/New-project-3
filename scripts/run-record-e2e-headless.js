#!/usr/bin/env node
const { buildPlanOnly, runSuite } = require('../tests/record-e2e/runner/run-suite');
const { loadCorpus } = require('../tests/record-e2e/runner/load-corpus');

function parseArgs(argv) {
  const options = {
    caseId: '',
    json: false,
    list: false,
    planOnly: false,
    repeat: 1,
    smoke: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--smoke') options.smoke = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--plan-only') options.planOnly = true;
    else if (arg === '--case-id') options.caseId = argv[++index] || '';
    else if (arg === '--repeat') options.repeat = Number(argv[++index] || 1);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw Object.assign(new Error(`Unknown argument: ${arg}`), { code: 'TEST_DATA_ERROR' });
  }
  if (options.caseId && options.smoke) {
    throw Object.assign(new Error('--case-id and --smoke cannot be combined'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-record-e2e-headless.js --smoke [--repeat N] [--json]',
    '  node scripts/run-record-e2e-headless.js --case-id CASE_ID [--repeat N] [--json]',
    '  node scripts/run-record-e2e-headless.js --plan-only [--json]',
    '  node scripts/run-record-e2e-headless.js --list [--json]'
  ].join('\n');
}

function printSummary(run) {
  console.log(`ACTIVE corpus: ${run.corpus.active}`);
  console.log(`Selected: ${run.selectedCaseIds.length}`);
  run.attempts.forEach((attempt) => {
    const summary = attempt.summary;
    console.log(
      `Attempt ${attempt.attempt}: PASS=${summary.PASS} CASE_FAIL=${summary.CASE_FAIL}`
      + ` RUNNER_ERROR=${summary.RUNNER_ERROR} BLOCKED=${summary.BLOCKED}`
    );
    attempt.results.forEach((result) => {
      console.log(
        `${result.caseStatus.padEnd(12)} ${result.caseId}`
        + `${result.failureStage ? ` ${result.failureStage}` : ''}`
      );
    });
  });
  console.log(
    `Determinism: ${run.determinism.stable ? 'STABLE' : 'MISMATCH'}`
    + ` (${run.determinism.comparedAttempts} attempt(s))`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.smoke && !options.caseId && !options.planOnly && !options.list)) {
    console.log(usage());
    return;
  }
  const corpus = loadCorpus();
  if (options.list) {
    const value = corpus.activeCases.map((item) => ({
      caseId: item.caseId,
      category: item.category,
      lanes: item.execution.lanes,
      riskLevel: item.riskLevel
    }));
    console.log(options.json ? JSON.stringify(value, null, 2) : value.map((item) => item.caseId).join('\n'));
    return;
  }
  if (options.planOnly) {
    const result = buildPlanOnly({ corpus });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.generated} / ${result.active} execution plan generated`);
      console.log(`Runner contract blocked = ${result.blocked}`);
    }
    return;
  }
  const run = await runSuite({
    caseId: options.caseId,
    corpus,
    repeat: options.repeat,
    smoke: options.smoke
  });
  if (options.json) console.log(JSON.stringify(run, null, 2));
  else printSummary(run);
  const finalSummary = run.attempts[run.attempts.length - 1].summary;
  if (finalSummary.RUNNER_ERROR || finalSummary.BLOCKED || !run.determinism.stable) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
  process.exitCode = 2;
});

module.exports = {
  main,
  parseArgs
};
