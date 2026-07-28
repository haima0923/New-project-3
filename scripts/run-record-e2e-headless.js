#!/usr/bin/env node
const { buildPlanOnly, runSuite } = require('../tests/record-e2e/runner/run-suite');
const {
  runFullCorpusBaseline
} = require('../tests/record-e2e/runner/full-corpus-baseline');
const { loadCorpus } = require('../tests/record-e2e/runner/load-corpus');
const { sanitizeEvidence } = require('../tests/record-e2e/runner/sanitize-evidence');
const { writeFullReport } = require('../tests/record-e2e/runner/write-full-report');

function parseArgs(argv) {
  const options = {
    all: false,
    category: '',
    caseId: '',
    failureStage: '',
    json: false,
    list: false,
    output: '',
    ownership: '',
    planOnly: false,
    repeat: 1,
    risk: '',
    smoke: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--smoke') options.smoke = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--plan-only') options.planOnly = true;
    else if (arg === '--case-id') options.caseId = argv[++index] || '';
    else if (arg === '--category') options.category = argv[++index] || '';
    else if (arg === '--failure-stage') options.failureStage = argv[++index] || '';
    else if (arg === '--output') options.output = argv[++index] || '';
    else if (arg === '--ownership') options.ownership = argv[++index] || '';
    else if (arg === '--risk') options.risk = argv[++index] || '';
    else if (arg === '--repeat') {
      const raw = argv[++index];
      options.repeat = Number(raw);
      if (!raw || !Number.isInteger(options.repeat) || options.repeat < 1) {
        throw Object.assign(new Error('--repeat must be a positive integer'), {
          code: 'TEST_DATA_ERROR'
        });
      }
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw Object.assign(new Error(`Unknown argument: ${arg}`), { code: 'TEST_DATA_ERROR' });
  }
  const modes = [options.all, options.caseId, options.smoke, options.planOnly, options.list]
    .filter(Boolean);
  if (modes.length > 1) {
    throw Object.assign(new Error('Choose exactly one execution mode'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  if (options.output && !options.all) {
    throw Object.assign(new Error('--output is supported only with --all'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  if (options.all && options.repeat !== 2) {
    throw Object.assign(new Error('--all requires --repeat 2'), { code: 'TEST_DATA_ERROR' });
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-record-e2e-headless.js --all --repeat 2 [--json] [--output /private/tmp/report.json]',
    '  node scripts/run-record-e2e-headless.js --smoke [--repeat N] [--json]',
    '  node scripts/run-record-e2e-headless.js --case-id CASE_ID [--repeat N] [--json]',
    '  node scripts/run-record-e2e-headless.js --plan-only [--json]',
    '  node scripts/run-record-e2e-headless.js --list [--json]',
    '  Result view filters: --risk P0 --category NAME --failure-stage STAGE --ownership NAME'
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

function printFullSummary(report) {
  const summary = report.summary;
  console.log(`ACTIVE corpus: ${report.corpus.active}`);
  console.log(
    `Attempt 1: PASS=${summary.PASS} CASE_FAIL=${summary.CASE_FAIL}`
    + ` RUNNER_ERROR=${summary.RUNNER_ERROR} BLOCKED=${summary.BLOCKED}`
  );
  console.log(
    `Attempt 2: PASS=${report.run.attempts[1].summary.PASS}`
    + ` CASE_FAIL=${report.run.attempts[1].summary.CASE_FAIL}`
    + ` RUNNER_ERROR=${report.run.attempts[1].summary.RUNNER_ERROR}`
    + ` BLOCKED=${report.run.attempts[1].summary.BLOCKED}`
  );
  console.log(`Determinism: ${report.determinism.stable ? 'STABLE' : 'MISMATCH'}`);
  console.log(`P0 individual reruns: ${report.p0Reruns.length}`);
  console.log(`P1 layered reruns: ${report.p1Reruns.length}`);
  console.log(
    `Clusters: ${report.clusters.clusters.length}`
    + ` covering ${report.clusters.clusteredCaseCount}/${report.clusters.caseFailCount} CASE_FAIL`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.all && !options.smoke
    && !options.caseId && !options.planOnly && !options.list)) {
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
  if (options.all) {
    const report = await runFullCorpusBaseline({
      corpus,
      filters: {
        category: options.category,
        failureStage: options.failureStage,
        ownership: options.ownership,
        risk: options.risk
      },
      repeat: options.repeat
    });
    let output = null;
    if (options.output) output = writeFullReport(options.output, report);
    if (options.json) {
      console.log(JSON.stringify(sanitizeEvidence({
        caseResults: report.caseResults,
        clusters: report.clusters,
        corpus: report.corpus,
        determinism: report.determinism,
        dimensions: report.dimensions,
        hardGates: report.hardGates,
        output,
        p0Reruns: report.p0Reruns,
        p1Reruns: report.p1Reruns,
        summary: report.summary
      }), null, 2));
    } else {
      printFullSummary(report);
      if (output) console.log(`Sanitized report: ${output.path} (${output.bytes} bytes)`);
    }
    return;
  }
  const run = await runSuite({
    category: options.category,
    caseId: options.caseId,
    corpus,
    repeat: options.repeat,
    risk: options.risk,
    smoke: options.smoke
  });
  if (options.json) console.log(JSON.stringify(run, null, 2));
  else printSummary(run);
  const finalSummary = run.attempts[run.attempts.length - 1].summary;
  if (finalSummary.RUNNER_ERROR || finalSummary.BLOCKED || !run.determinism.stable) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  main,
  parseArgs,
  printFullSummary
};
