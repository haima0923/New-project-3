#!/usr/bin/env node
const { stableHash } = require('../../../utils/record-state-diff');
const { parseInput } = require('../../../utils/parser');
const { runWorker, summarize } = require('../single-item-order-complete-save-v1/run-suite');
const manifest = require('./manifest.json');
const { cases } = require('./contract-cases');

function parseArgs(argv) {
  const options = { repeat: 1, caseId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repeat') options.repeat = Number(argv[++index]);
    else if (argv[index] === '--case-id') options.caseId = String(argv[++index] || '');
    else if (argv[index] === '--json') options.json = true;
    else if (argv[index] === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer');
  return options;
}

function assertManifest() {
  if (manifest.schemaVersion !== 'order-date-whitespace-contract-v1') throw new Error('Unsupported whitespace date manifest');
  if (cases.length !== manifest.exactActiveCaseCount) throw new Error(`Expected ${manifest.exactActiveCaseCount} whitespace date cases`);
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) throw new Error('Duplicate whitespace date case ID');
}

function runWordSplitSafetyGuard() {
  const input = '赵老板定了 300 个杯垫，每个 2 元，下 周 五交';
  const result = parseInput({
    text: input,
    source: 'typed',
    context: 'home',
    state: { customers: [], orders: [], quotations: [], receivables: [] },
    businessDate: '2026-08-03',
    businessTimezone: 'Asia/Shanghai',
    nowInstant: '2026-08-03T02:00:00.000Z'
  });
  return {
    caseId: 'REC-E2E-ODW-SAFETY-001',
    caseStatus: result.fields && result.fields.dueDate ? 'CASE_FAIL' : 'PASS',
    dueDate: result.fields && result.fields.dueDate || '',
    input,
    rule: '不得通过删除任意词内空白把“下 周 五”识别为日期'
  };
}

async function runSuite(options) {
  assertManifest();
  let selected = cases;
  if (options.caseId) {
    selected = selected.filter((item) => item.caseId === options.caseId);
    if (!selected.length) throw new Error(`Unknown whitespace date case: ${options.caseId}`);
  }
  const attempts = [];
  for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
    const results = [];
    for (const testCase of selected) results.push(await runWorker(testCase, attempt));
    attempts.push({ attempt, results, summary: summarize(results) });
  }
  const fingerprints = attempts.map((attempt) => stableHash(
    attempt.results.map((item) => ({
      caseId: item.caseId,
      caseStatus: item.caseStatus,
      failureReason: item.failureReason,
      failureStage: item.failureStage,
      parserObservation: item.parserObservation
    })),
    'order-date-whitespace-attempt-v1'
  ));
  return {
    attempts,
    determinism: {
      stable: fingerprints.every((item) => item === fingerprints[0]),
      fingerprints
    },
    safetyGuard: runWordSplitSafetyGuard()
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tests/record-e2e/order-date-whitespace-v1/run.js [--repeat N] [--case-id ID] [--json]');
    return;
  }
  const report = await runSuite(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Cluster: ${manifest.clusterId}`);
    console.log(`Cases: ${report.attempts[0].results.length} (included in core count: false)`);
    report.attempts.forEach((attempt) => {
      console.log(`Attempt ${attempt.attempt}: PASS=${attempt.summary.PASS} CASE_FAIL=${attempt.summary.CASE_FAIL} RUNNER_ERROR=${attempt.summary.RUNNER_ERROR} BLOCKED=${attempt.summary.BLOCKED} SURFACE_ERROR=${attempt.summary.SURFACE_ERROR}`);
      attempt.results.forEach((item) => {
        const observation = item.parserObservation || {};
        console.log(`${item.caseStatus.padEnd(12)} ${item.caseId} raw=${observation.rawParserDueDate || '-'} hybrid=${observation.hybridDueDate || '-'} page=${observation.pageConfirmationDueDate || '-'} saved=${item.finalPersistentState && item.finalPersistentState.targetOrder && item.finalPersistentState.targetOrder.requiredDeliveryDate || '-'}`);
      });
    });
    console.log(`${report.safetyGuard.caseStatus.padEnd(12)} ${report.safetyGuard.caseId} dueDate=${report.safetyGuard.dueDate || '-'}`);
    console.log(`Determinism: ${report.determinism.stable ? 'STABLE' : 'MISMATCH'}`);
  }
  const last = report.attempts[report.attempts.length - 1].summary;
  if (!report.determinism.stable || report.safetyGuard.caseStatus !== 'PASS'
    || last.CASE_FAIL || last.RUNNER_ERROR || last.BLOCKED || last.SURFACE_ERROR) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { runSuite };
