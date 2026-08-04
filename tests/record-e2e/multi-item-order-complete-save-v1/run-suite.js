const { safeClone } = require('../../../utils/record-state-diff');
const { cases } = require('./contract-cases');
const { executeCase } = require('./execute-case');

function summarize(results) {
  const summary = {
    PASS: 0,
    CASE_FAIL: 0,
    RUNNER_ERROR: 0,
    BLOCKED: 0,
    SURFACE_ERROR: 0,
    expectedRedDetected: 0,
    redNowPassing: 0,
    greenControlFailures: 0,
    executed: results.length
  };
  results.forEach((result) => {
    if (Object.prototype.hasOwnProperty.call(summary, result.caseStatus)) summary[result.caseStatus] += 1;
    if (result.surfaceError) summary.SURFACE_ERROR += 1;
    if (result.contractKind === 'RED' && result.caseStatus === 'CASE_FAIL') summary.expectedRedDetected += 1;
    if (result.contractKind === 'RED' && result.caseStatus === 'PASS') summary.redNowPassing += 1;
    if (result.contractKind === 'GREEN_CONTROL' && result.caseStatus !== 'PASS') summary.greenControlFailures += 1;
  });
  return summary;
}

function selectCases(options = {}) {
  if (!options.caseId) return cases;
  const selected = cases.filter((item) => item.caseId === options.caseId);
  if (!selected.length) {
    throw Object.assign(new Error(`Unknown multi-item-order case: ${options.caseId}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  return selected;
}

function runMultiItemOrderContract(options = {}) {
  const selected = selectCases(options);
  const repeat = Math.max(1, Number(options.repeat || 1));
  if (!Number.isInteger(repeat)) {
    throw Object.assign(new Error('repeat must be a positive integer'), { code: 'TEST_DATA_ERROR' });
  }
  const attempts = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const results = selected.map((testCase) => executeCase(testCase));
    attempts.push({ attempt, results, summary: summarize(results) });
  }
  const determinism = { stable: true, comparedAttempts: repeat, mismatches: [] };
  if (attempts.length > 1) {
    const baseline = new Map(attempts[0].results.map((item) => [item.caseId, item.semanticFingerprint || `${item.caseStatus}:${item.error && item.error.code}`]));
    attempts.slice(1).forEach((attempt) => {
      attempt.results.forEach((item) => {
        const fingerprint = item.semanticFingerprint || `${item.caseStatus}:${item.error && item.error.code}`;
        if (baseline.get(item.caseId) !== fingerprint) determinism.mismatches.push({ attempt: attempt.attempt, caseId: item.caseId });
      });
    });
    determinism.stable = determinism.mismatches.length === 0;
  }
  return {
    clusterId: 'multi-item-order-complete-save-v1',
    includeInCoreCount: false,
    exactActiveCaseCount: cases.length,
    selectedCaseCount: selected.length,
    attempts: safeClone(attempts),
    determinism,
    evidenceBoundary: {
      localParser: '真实本地 parser',
      controlledAi: '受控 fixture，只验证 merge/safety，不是 REAL AI',
      fakeProviderPage: '本专项不冒充生产保存；由现有核心 MULTI case 分层观察',
      isolatedCommit: '本专项 GREEN 只证明 business 条件式能力，不冒充生产页面链路',
      realAi: 'NOT_RUN',
      pageVm: 'NOT_RUN_IN_THIS_MINIMAL_CONTRACT',
      realWxml: 'NOT_RUN'
    }
  };
}

module.exports = {
  runMultiItemOrderContract,
  selectCases,
  summarize
};
