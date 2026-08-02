const path = require('path');
const { fork } = require('child_process');
const { safeClone } = require('../../../utils/record-state-diff');
const { loadContract } = require('./load-contract');

const SURFACE_ERROR_CODES = new Set([
  'AUTOMATION_DRIVER_ERROR',
  'PAGE_ACTION_MAPPING_MISSING',
  'PAGE_ACTION_METHOD_MISSING',
  'PAGE_ACTION_INVOCATION_MISMATCH'
]);

function runWorker(testCase, attempt) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'case-worker.js'), [], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1' }),
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let response = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        caseId: testCase.caseId,
        caseStatus: 'RUNNER_ERROR',
        error: { code: 'AUTOMATION_DRIVER_ERROR', message: 'Quotation case worker timed out' },
        failureStage: 'RUNNER_ERROR',
        productionGap: testCase.contract.productionGap,
        surfaceError: true
      });
    }, 15000);
    child.once('message', (message) => {
      if (settled) return;
      response = message;
      if (child.connected) child.disconnect();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        caseId: testCase.caseId,
        caseStatus: 'RUNNER_ERROR',
        error: { code: error.code || 'AUTOMATION_DRIVER_ERROR', message: error.message },
        failureStage: 'RUNNER_ERROR',
        productionGap: testCase.contract.productionGap,
        surfaceError: true
      });
    });
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!response || response.ok !== true || exitCode !== 0) {
        const error = response && response.error || {
          code: 'AUTOMATION_DRIVER_ERROR',
          message: `Quotation case worker exited ${exitCode}/${signal || 'no-signal'}`
        };
        resolve({
          caseId: testCase.caseId,
          caseStatus: 'RUNNER_ERROR',
          error: safeClone(error),
          failureStage: 'RUNNER_ERROR',
          productionGap: testCase.contract.productionGap,
          surfaceError: SURFACE_ERROR_CODES.has(error.code)
        });
        return;
      }
      resolve(Object.assign({}, response.result, {
        caseId: testCase.caseId,
        productionGap: testCase.contract.productionGap,
        surfaceError: false,
        workerExitAudit: { exitCode, exitObserved: true, signal: signal || '' }
      }));
    });
    child.send({ attempt, testCase: safeClone(testCase) });
  });
}

function summarize(results) {
  const summary = {
    BLOCKED: 0,
    CASE_FAIL: 0,
    PASS: 0,
    RUNNER_ERROR: 0,
    SURFACE_ERROR: 0,
    executed: results.length
  };
  results.forEach((result) => {
    summary[result.caseStatus] += 1;
    if (result.surfaceError) summary.SURFACE_ERROR += 1;
  });
  return summary;
}

async function runQuotationToOrderSuite(options = {}) {
  const contract = loadContract();
  let selected = contract.cases;
  if (options.caseId) {
    selected = selected.filter((item) => item.caseId === options.caseId);
    if (!selected.length) throw Object.assign(new Error(`Unknown quotation-to-order case: ${options.caseId}`), { code: 'TEST_DATA_ERROR' });
  }
  const repeat = Math.max(1, Number(options.repeat || 1));
  const attempts = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const results = [];
    for (const testCase of selected) {
      results.push(await runWorker(testCase, attempt));
    }
    attempts.push({ attempt, results, summary: summarize(results) });
  }
  const determinism = { comparedAttempts: repeat, mismatches: [], stable: true };
  if (attempts.length > 1) {
    const baseline = new Map(attempts[0].results.map((item) => [item.caseId, item.semanticFingerprint || `${item.caseStatus}:${item.error && item.error.code}`]));
    attempts.slice(1).forEach((attempt) => {
      attempt.results.forEach((item) => {
        const fingerprint = item.semanticFingerprint || `${item.caseStatus}:${item.error && item.error.code}`;
        if (baseline.get(item.caseId) !== fingerprint) {
          determinism.mismatches.push({ attempt: attempt.attempt, caseId: item.caseId });
        }
      });
    });
    determinism.stable = determinism.mismatches.length === 0;
  }
  return {
    attempts,
    clusterId: contract.manifest.clusterId,
    determinism,
    exactActiveCaseCount: contract.manifest.exactActiveCaseCount,
    includeInCoreCount: contract.manifest.includeInCoreCount
  };
}

module.exports = { runQuotationToOrderSuite, runWorker, summarize };
