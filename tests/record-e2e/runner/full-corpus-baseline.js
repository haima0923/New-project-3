const { stableHash } = require('../../../utils/record-state-diff');
const { buildAllExecutionPlans } = require('./build-execution-plan');
const { clusterFailures } = require('./cluster-failures');
const {
  assertLaneSet,
  assertRuntimeIsolation,
  exactUniqueSet,
  integrityError
} = require('./full-run-integrity');
const { loadCorpus } = require('./load-corpus');
const { findChangedPaths, normalizeRunResult } = require('./normalize-run-result');
const { runSuite, executeOne } = require('./run-suite');

function emptyStatusCounts() {
  return { BLOCKED: 0, CASE_FAIL: 0, PASS: 0, RUNNER_ERROR: 0 };
}

function addDimension(target, key, status) {
  const normalized = String(key === undefined || key === null || key === '' ? 'NONE' : key);
  target[normalized] = target[normalized] || emptyStatusCounts();
  target[normalized][status] += 1;
}

function summarizeDimensions(results) {
  const dimensions = {
    aiProfile: {},
    businessType: {},
    category: {},
    entrySurface: {},
    expectedRoute: {},
    failureCode: {},
    failureOwnership: {},
    inputChannel: {},
    primaryFailureStage: {},
    requiredCapability: {},
    riskLevel: {}
  };
  const executionLane = {};
  results.forEach((result) => {
    addDimension(dimensions.aiProfile, result.aiProfile, result.caseStatus);
    addDimension(dimensions.businessType, result.businessType, result.caseStatus);
    addDimension(dimensions.category, result.category, result.caseStatus);
    addDimension(dimensions.entrySurface, result.entrySurface, result.caseStatus);
    addDimension(dimensions.expectedRoute, result.expectedRoute, result.caseStatus);
    addDimension(dimensions.inputChannel, result.inputChannel, result.caseStatus);
    addDimension(dimensions.riskLevel, result.riskLevel, result.caseStatus);
    if (result.caseStatus !== 'PASS') {
      addDimension(dimensions.failureCode, result.failureCode, result.caseStatus);
      addDimension(dimensions.failureOwnership, result.failureOwnership, result.caseStatus);
      addDimension(dimensions.primaryFailureStage, result.failureStage, result.caseStatus);
    }
    const capabilities = result.requiredCapabilities && result.requiredCapabilities.length
      ? result.requiredCapabilities
      : ['NONE'];
    capabilities.forEach((capability) => (
      addDimension(dimensions.requiredCapability, capability, result.caseStatus)
    ));
    (result.laneResults || []).forEach((lane) => {
      executionLane[lane.lane] = executionLane[lane.lane] || {
        BLOCKED: 0,
        CASE_FAIL: 0,
        PASS: 0,
        RUNNER_ERROR: 0,
        assertionFail: 0,
        executionPass: 0
      };
      executionLane[lane.lane][lane.status] += 1;
      if (lane.executionStatus === 'PASS') executionLane[lane.lane].executionPass += 1;
      if (lane.assertionStatus === 'FAIL') executionLane[lane.lane].assertionFail += 1;
    });
  });
  return Object.assign(dimensions, { executionLane });
}

function planFingerprint(plans) {
  return stableHash(plans.map((item) => ({
    caseId: item.testCase.caseId,
    planFingerprint: item.plan.planFingerprint
  })).sort((left, right) => left.caseId.localeCompare(right.caseId)),
  'record-e2e-full-plan-set-v1');
}

function compareResultOrThrow(baseline, rerun, label) {
  const expected = normalizeRunResult(baseline);
  const actual = normalizeRunResult(rerun);
  if (expected.fingerprint !== actual.fingerprint) {
    const changedPaths = findChangedPaths(expected.semantic, actual.semantic);
    const parserGraphDrift = changedPaths.some((changedPath) => (
      changedPath.startsWith('observationSemantics.rawParser')
      || changedPath.startsWith('parserObservation')
    ));
    throw integrityError(
      parserGraphDrift
        ? 'PARSER_INVOCATION_GRAPH_DETERMINISM_MISMATCH'
        : 'DETERMINISM_MISMATCH',
      `${label} semantic result drifted`, {
      actual: actual.fingerprint,
      baseline: expected.fingerprint,
      caseId: baseline.caseId,
      changedPaths
    });
  }
  return {
    caseId: baseline.caseId,
    failureOwnership: baseline.failureOwnership,
    failureStage: baseline.failureStage,
    fingerprint: expected.fingerprint,
    status: baseline.caseStatus
  };
}

function chooseP1Sample(results) {
  const candidates = results
    .filter((result) => result.riskLevel === 'P1' && result.caseStatus === 'CASE_FAIL')
    .slice()
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  const selected = new Map();
  ['failureStage', 'failureOwnership', 'category'].forEach((dimension) => {
    const seen = new Set();
    candidates.forEach((result) => {
      const value = result[dimension] || 'NONE';
      if (seen.has(value)) return;
      seen.add(value);
      selected.set(result.caseId, result);
    });
  });
  candidates.forEach((result) => {
    if (selected.size < Math.min(10, candidates.length)) {
      selected.set(result.caseId, result);
    }
  });
  return Array.from(selected.values()).sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function assertRerunCoverage(expectedResults, reruns, label) {
  exactUniqueSet(
    reruns.map((item) => item.caseId),
    expectedResults.map((item) => item.caseId),
    'RERUN_COVERAGE_ERROR',
    label
  );
}

function assertP1SampleCoverage(allP1Failures, sample) {
  if (!allP1Failures.length) return;
  const expectedMinimum = Math.min(10, allP1Failures.length);
  if (sample.length < expectedMinimum) {
    throw integrityError(
      'P1_SAMPLE_COVERAGE_ERROR',
      `P1 sample must contain at least ${expectedMinimum} Case(s)`
    );
  }
  ['failureStage', 'failureOwnership', 'category'].forEach((dimension) => {
    const expected = new Set(allP1Failures.map((result) => result[dimension] || 'NONE'));
    const actual = new Set(sample.map((result) => result[dimension] || 'NONE'));
    const missing = Array.from(expected).filter((value) => !actual.has(value));
    if (missing.length) {
      throw integrityError(
        'P1_SAMPLE_COVERAGE_ERROR',
        `P1 sample misses ${dimension}: ${missing.join(', ')}`
      );
    }
  });
}

async function rerunCases(baselineResults, plans, options = {}) {
  const byPlan = new Map(plans.map((item) => [item.testCase.caseId, item]));
  const reruns = [];
  for (const baseline of baselineResults) {
    const item = byPlan.get(baseline.caseId);
    if (!item) {
      throw integrityError(
        'FULL_CORPUS_CASE_SET_MISMATCH',
        `No execution plan for rerun ${baseline.caseId}`
      );
    }
    const actual = await executeOne(item, {
      attempt: 1,
      timeoutMs: options.timeoutMs
    });
    assertLaneSet(item, actual);
    assertRuntimeIsolation(actual);
    reruns.push(compareResultOrThrow(baseline, actual, `Single-case rerun ${baseline.caseId}`));
  }
  return reruns;
}

function compactCaseResult(result) {
  return {
    actualInput: result.actualInput,
    aiEvidence: result.aiEvidence,
    aiProfile: result.aiProfile,
    assertions: result.assertions,
    businessDiff: result.businessDiff,
    businessType: result.businessType,
    caseId: result.caseId,
    caseStatus: result.caseStatus,
    category: result.category,
    clock: result.clock,
    concurrentEvidence: result.concurrentEvidence,
    duplicateTriggerEvidence: result.duplicateTriggerEvidence,
    entrySurface: result.entrySurface,
    failureCode: result.failureCode,
    failureOwnership: result.failureOwnership,
    failureStage: result.failureStage,
    fullDiff: result.fullDiff,
    initialStateFingerprint: result.executionPlan && result.executionPlan.stateFixtureFingerprint,
    inputChannel: result.inputChannel,
    isolatedCommitEvidence: result.isolatedCommitEvidence,
    laneResults: result.laneResults,
    networkAudit: result.networkAudit,
    observationSemantics: result.observationSemantics,
    ownershipConfidence: result.ownershipConfidence,
    ownershipEvidence: result.ownershipEvidence,
    pageEvidence: result.pageEvidence,
    preflightEvidence: result.preflightEvidence,
    primaryFailure: result.primaryFailure,
    productionObservation: result.productionObservation,
    requiredCapabilities: result.requiredCapabilities,
    restartEvidence: result.restartEvidence,
    riskLevel: result.riskLevel,
    routeEvidence: result.routeEvidence,
    secondaryFindings: result.secondaryFindings,
    storageAudit: result.storageAudit,
    surfaceEvidence: result.surfaceEvidence,
    transactionReplayEvidence: result.transactionReplayEvidence
  };
}

function filterResults(results, filters = {}) {
  return results.filter((result) => (
    (!filters.risk || result.riskLevel === filters.risk)
    && (!filters.category || result.category === filters.category)
    && (!filters.failureStage || result.failureStage === filters.failureStage)
    && (!filters.ownership || result.failureOwnership === filters.ownership)
  ));
}

async function runFullCorpusBaseline(options = {}) {
  if (Number(options.repeat) !== 2) {
    throw Object.assign(new Error('Full corpus baseline requires --repeat 2 exactly'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const corpusBefore = options.corpus || loadCorpus();
  const plans = buildAllExecutionPlans(corpusBefore);
  if (plans.length !== 120) {
    throw integrityError(
      'FULL_CORPUS_CASE_SET_MISMATCH',
      `Expected 120 execution plans, got ${plans.length}`
    );
  }
  const plansBefore = planFingerprint(plans);
  const run = await runSuite({
    corpus: corpusBefore,
    fullCorpus: true,
    repeat: 2,
    timeoutMs: options.timeoutMs
  });
  if (!run.determinism.stable) {
    const parserGraphDrift = run.determinism.mismatches.some((mismatch) => (
      mismatch.failureCode === 'PARSER_INVOCATION_GRAPH_DETERMINISM_MISMATCH'
    ));
    throw integrityError(
      parserGraphDrift
        ? 'PARSER_INVOCATION_GRAPH_DETERMINISM_MISMATCH'
        : 'DETERMINISM_MISMATCH',
      'Full corpus attempts were not deterministic', {
      mismatches: run.determinism.mismatches
    });
  }
  const corpusAfter = loadCorpus();
  const plansAfter = planFingerprint(buildAllExecutionPlans(corpusAfter));
  if (corpusBefore.corpusFingerprint !== corpusAfter.corpusFingerprint
    || plansBefore !== plansAfter) {
    throw integrityError('CORPUS_MUTATION_ERROR', 'Corpus or plan fingerprint changed during run', {
      corpusAfter: corpusAfter.corpusFingerprint,
      corpusBefore: corpusBefore.corpusFingerprint,
      plansAfter,
      plansBefore
    });
  }
  const baselineResults = run.attempts[0].results;
  const p0Failures = baselineResults.filter((result) => (
    result.riskLevel === 'P0' && result.caseStatus === 'CASE_FAIL'
  ));
  const allP1Failures = baselineResults.filter((result) => (
    result.riskLevel === 'P1' && result.caseStatus === 'CASE_FAIL'
  ));
  const p1Sample = chooseP1Sample(baselineResults);
  assertP1SampleCoverage(allP1Failures, p1Sample);
  const p0Reruns = await rerunCases(p0Failures, plans, options);
  const p1Reruns = await rerunCases(p1Sample, plans, options);
  assertRerunCoverage(p0Failures, p0Reruns, 'P0 rerun');
  assertRerunCoverage(p1Sample, p1Reruns, 'P1 rerun');
  const failureClusters = clusterFailures(baselineResults);
  const visibleResults = filterResults(baselineResults, options.filters || {});
  return {
    baselineVersion: 'record-e2e-full-corpus-v1',
    caseResults: visibleResults.map(compactCaseResult),
    clusters: failureClusters,
    corpus: {
      active: corpusBefore.activeCases.length,
      fingerprintAfter: corpusAfter.corpusFingerprint,
      fingerprintBefore: corpusBefore.corpusFingerprint,
      planFingerprintAfter: plansAfter,
      planFingerprintBefore: plansBefore
    },
    determinism: run.determinism,
    dimensions: summarizeDimensions(baselineResults),
    filters: options.filters || {},
    hardGates: run.attempts.map((attempt) => attempt.integrity),
    p0Reruns,
    p1Reruns,
    reportViewCount: visibleResults.length,
    run,
    summary: run.attempts[0].summary
  };
}

module.exports = {
  assertP1SampleCoverage,
  assertRerunCoverage,
  chooseP1Sample,
  compactCaseResult,
  compareResultOrThrow,
  filterResults,
  planFingerprint,
  rerunCases,
  runFullCorpusBaseline,
  summarizeDimensions
};
