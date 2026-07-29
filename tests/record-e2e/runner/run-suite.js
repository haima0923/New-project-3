const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');
const { assertCase } = require('./assert-case');
const { buildAllExecutionPlans } = require('./build-execution-plan');
const { classifyFailureOwnership } = require('./classify-failure-ownership');
const { classifyWorkerError } = require('./classify-result');
const { completeRestartInParent } = require('./complete-restart-in-parent');
const { CORPUS_ROOT } = require('./constants');
const { assertFullAttemptIntegrity, exactUniqueSet } = require('./full-run-integrity');
const { loadCorpus } = require('./load-corpus');
const { runCaseWorker } = require('./module-isolation');
const { findChangedPaths, normalizeRunResult } = require('./normalize-run-result');
const { expectedProposal } = require('./observation-semantics');

function loadSmokeManifest() {
  const manifestPath = path.join(CORPUS_ROOT, 'runner-smoke/smoke-manifest-v1.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.caseIds) || manifest.caseIds.length !== 24) {
    throw Object.assign(new Error('Smoke manifest must contain exactly 24 case IDs'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  if (new Set(manifest.caseIds).size !== manifest.caseIds.length) {
    throw Object.assign(new Error('Smoke manifest contains duplicate case IDs'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  return manifest;
}

function selectPlans(corpus, options = {}) {
  let all = buildAllExecutionPlans(corpus);
  if (options.risk) {
    all = all.filter((item) => item.testCase.riskLevel === options.risk);
  }
  if (options.category) {
    all = all.filter((item) => item.testCase.category === options.category);
  }
  if (options.caseId) {
    const selected = all.filter((item) => item.testCase.caseId === options.caseId);
    if (!selected.length) {
      throw Object.assign(new Error(`Unknown ACTIVE case: ${options.caseId}`), {
        code: 'TEST_DATA_ERROR'
      });
    }
    return selected;
  }
  if (options.smoke) {
    const manifest = loadSmokeManifest();
    return manifest.caseIds.map((caseId) => {
      const selected = all.find((item) => item.testCase.caseId === caseId);
      if (!selected) {
        throw Object.assign(new Error(`Smoke case is not ACTIVE: ${caseId}`), {
          code: 'TEST_DATA_ERROR'
        });
      }
      return selected;
    });
  }
  return all;
}

async function executeOne(item, options = {}) {
  const proposalExpected = expectedProposal(item.testCase);
  const metadata = {
    aiProfile: item.testCase.ai.profile,
    businessType: proposalExpected.businessType,
    category: item.testCase.category,
    entrySurface: item.testCase.input.entrySurface,
    executionLanes: item.testCase.execution.lanes.slice(),
    expectedRoute: item.testCase.expected.route,
    inputChannel: item.testCase.input.channel,
    requiredCapabilities: (item.testCase.interaction.requiredCapabilities || []).slice(),
    riskLevel: item.testCase.riskLevel
  };
  try {
    const evidence = await runCaseWorker({
      attempt: options.attempt || 1,
      hooks: options.hooks || {},
      plan: item.plan,
      spec: item.workerSpec
    }, { timeoutMs: options.timeoutMs });
    if (!evidence.workerExitAudit || evidence.workerExitAudit.exitObserved !== true) {
      throw Object.assign(new Error('Primary Case worker exit was not observed'), {
        code: 'LANE_EXECUTION_EVIDENCE_MISSING'
      });
    }
    await completeRestartInParent(
      evidence,
      item.workerSpec,
      item.plan,
      options.attempt || 1
    );
    const assertionResult = assertCase(item.testCase, evidence, options.assertionOptions || {});
    const result = Object.assign({}, evidence, assertionResult, metadata, {
      caseId: item.testCase.caseId
    });
    return Object.assign(result, classifyFailureOwnership(item.testCase, result));
  } catch (error) {
    const finalAudit = error.finalAudit || {};
    return Object.assign({
      assertions: [],
      caseId: item.testCase.caseId,
      error: {
        code: error.code || 'AUTOMATION_DRIVER_ERROR',
        message: error.message,
        workerStack: error.workerStack || ''
      }
    }, metadata, finalAudit, {
      workerExitAudit: error.workerExitAudit || null
    }, classifyWorkerError(error), {
      failureOwnership: 'UNCLASSIFIED_REQUIRES_REVIEW',
      ownershipConfidence: 'HIGH',
      ownershipEvidence: {
        reason: 'RUNNER_OR_CONTRACT_EXECUTION_NOT_A_PRODUCT_RESULT'
      }
    });
  }
}

function summarize(results) {
  const summary = {
    BLOCKED: 0,
    CASE_FAIL: 0,
    PASS: 0,
    RUNNER_ERROR: 0,
    executed: results.length,
    byFailureStage: {},
    byLane: {},
    byOwnership: {},
    byRisk: {}
  };
  results.forEach((result) => {
    summary[result.caseStatus] = (summary[result.caseStatus] || 0) + 1;
    const risk = result.riskLevel || 'UNKNOWN';
    summary.byRisk[risk] = summary.byRisk[risk] || {
      BLOCKED: 0, CASE_FAIL: 0, PASS: 0, RUNNER_ERROR: 0
    };
    summary.byRisk[risk][result.caseStatus] += 1;
    if (result.failureStage) {
      summary.byFailureStage[result.failureStage]
        = (summary.byFailureStage[result.failureStage] || 0) + 1;
    }
    if (result.failureOwnership) {
      summary.byOwnership[result.failureOwnership]
        = (summary.byOwnership[result.failureOwnership] || 0) + 1;
    }
    (result.laneResults || []).forEach((lane) => {
      summary.byLane[lane.lane] = summary.byLane[lane.lane] || {
        CASE_FAIL: 0, PASS: 0, RUNNER_ERROR: 0, BLOCKED: 0
      };
      summary.byLane[lane.lane][lane.status] += 1;
    });
  });
  return summary;
}

async function runSuite(options = {}) {
  const corpus = options.corpus || loadCorpus();
  const plans = selectPlans(corpus, options);
  const repeat = Math.max(1, Number(options.repeat || 1));
  const attempts = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const results = [];
    for (const item of plans) {
      // A fresh child process is mandatory per case. Sequential parent scheduling
      // also keeps evidence ordering deterministic and prevents accidental sharing.
      results.push(await executeOne(item, Object.assign({}, options, { attempt })));
    }
    attempts.push({
      attempt,
      results,
      summary: summarize(results)
    });
    if (options.fullCorpus) {
      attempts[attempts.length - 1].integrity = assertFullAttemptIntegrity(
        attempts[attempts.length - 1],
        plans
      );
    }
  }
  const determinism = {
    comparedAttempts: repeat,
    mismatches: [],
    stable: true
  };
  if (attempts.length > 1) {
    const baselineIds = attempts[0].results.map((result) => result.caseId);
    const baseline = new Map(attempts[0].results.map((result) => {
      const normalized = normalizeRunResult(result);
      return [result.caseId, normalized];
    }));
    attempts.slice(1).forEach((attempt) => {
      try {
        exactUniqueSet(
          attempt.results.map((result) => result.caseId),
          baselineIds,
          'DETERMINISM_CASE_SET_MISMATCH',
          `Attempt ${attempt.attempt} determinism Case`
        );
      } catch (error) {
        determinism.mismatches.push({
          attempt: attempt.attempt,
          caseId: '',
          failureCode: error.failureCode,
          detail: error.detail
        });
      }
      attempt.results.forEach((result) => {
        const normalized = normalizeRunResult(result);
        const baselineResult = baseline.get(result.caseId);
        if (!baselineResult || baselineResult.fingerprint !== normalized.fingerprint) {
          determinism.mismatches.push({
            attempt: attempt.attempt,
            caseId: result.caseId,
            baseline: baselineResult && baselineResult.fingerprint || '',
            actual: normalized.fingerprint,
            changedPaths: baselineResult
              ? findChangedPaths(baselineResult.semantic, normalized.semantic)
              : ['$']
          });
        }
      });
    });
    determinism.stable = determinism.mismatches.length === 0;
  }
  return {
    corpus: {
      active: corpus.activeCases.length,
      fingerprint: corpus.corpusFingerprint
    },
    determinism,
    attempts,
    selectedCaseIds: plans.map((item) => item.testCase.caseId)
  };
}

function buildPlanOnly(options = {}) {
  const corpus = options.corpus || loadCorpus();
  const plans = buildAllExecutionPlans(corpus);
  return {
    active: corpus.activeCases.length,
    blocked: 0,
    generated: plans.length,
    plans: plans.map((item) => safeClone(item.plan))
  };
}

module.exports = {
  buildPlanOnly,
  executeOne,
  loadSmokeManifest,
  runSuite,
  selectPlans,
  summarize
};
