#!/usr/bin/env node
const assert = require('assert');
const { stableHash } = require('../../../utils/record-state-diff');
const { assertCase } = require('../runner/assert-case');
const { buildExecutionPlan } = require('../runner/build-execution-plan');
const { createFakeNetwork } = require('../runner/create-fake-network');
const { assertFakeWxApi } = require('../runner/create-fake-wx');
const { loadCorpus } = require('../runner/load-corpus');
const { runCaseWorker } = require('../runner/module-isolation');
const { normalizeRunResult } = require('../runner/normalize-run-result');
const { executeOne } = require('../runner/run-suite');

const corpus = loadCorpus();

function bundle(caseId) {
  const testCase = corpus.byId.get(caseId);
  if (!testCase) throw new Error(`Missing self-test case ${caseId}`);
  return {
    testCase,
    ...buildExecutionPlan(testCase, corpus.fixtureResolver)
  };
}

async function worker(caseId, options = {}) {
  const item = bundle(caseId);
  return runCaseWorker({
    attempt: options.attempt || 1,
    hooks: options.hooks || {},
    plan: item.plan,
    spec: item.workerSpec
  });
}

async function modifiedWorker(caseId, mutate) {
  const item = bundle(caseId);
  mutate(item.workerSpec, item.plan);
  return runCaseWorker({
    attempt: 1,
    plan: item.plan,
    spec: item.workerSpec
  });
}

async function expectWorkerError(caseId, hooks, code) {
  const item = bundle(caseId);
  let caught = null;
  try {
    await runCaseWorker({
      attempt: 1,
      hooks,
      plan: item.plan,
      spec: item.workerSpec
    });
  } catch (error) {
    caught = error;
  }
  assert(caught, `${caseId} should have produced a worker error`);
  assert.strictEqual(caught.code, code);
}

const tests = [
  {
    name: 'wrong-expected-sentinel-fails',
    async run() {
      const item = bundle('REC-E2E-FIN-001');
      const evidence = await worker(item.testCase.caseId);
      const result = assertCase(item.testCase, evidence, { mutateExpectedSentinel: true });
      const sentinel = result.assertions.find((entry) => entry.name === 'selfTest.wrongExpectedCount');
      assert(sentinel && sentinel.pass === false);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
    }
  },
  {
    name: 'missing-save-entry-detected',
    async run() {
      const item = bundle('REC-E2E-DATE-007');
      const evidence = await runCaseWorker({
        attempt: 1,
        hooks: { skipSaveEntry: true },
        plan: item.plan,
        spec: item.workerSpec
      });
      assert.strictEqual(evidence.isolatedCommitEvidence.reason, 'SAVE_ENTRY_SKIPPED');
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
    }
  },
  {
    name: 'unknown-network-route-blocked',
    async run() {
      const network = createFakeNetwork({});
      let caught = null;
      network.request({
        url: 'memory://record-e2e/api/unknown',
        fail(error) { caught = error; }
      });
      assert(caught);
      assert.strictEqual(caught.code, 'AUTOMATION_NETWORK_GUARD_ERROR');
      assert.strictEqual(network.audit().guardErrors, 1);
      assert.strictEqual(network.audit().realNetworkRequests, 0);
    }
  },
  {
    name: 'host-storage-api-blocked',
    async run() {
      assert.throws(
        () => assertFakeWxApi({}),
        (error) => error.code === 'AUTOMATION_STORAGE_GUARD_ERROR'
      );
    }
  },
  {
    name: 'case-state-does-not-pollute-next-worker',
    async run() {
      const first = await worker('REC-E2E-DATE-007', { attempt: 1 });
      const second = await worker('REC-E2E-DATE-007', { attempt: 2 });
      assert.strictEqual(
        first.executionPlan.stateFixtureFingerprint,
        second.executionPlan.stateFixtureFingerprint
      );
      assert.strictEqual(
        stableHash(first.businessDiff, 'selftest-diff'),
        stableHash(second.businessDiff, 'selftest-diff')
      );
      assert.notStrictEqual(first.runtimeEvidence.pid, second.runtimeEvidence.pid);
    }
  },
  {
    name: 'fixture-object-remains-unchanged',
    async run() {
      const evidence = await worker('REC-E2E-FIN-001');
      assert.strictEqual(evidence.fixtureMutationAudit.unchanged, true);
    }
  },
  {
    name: 'missing-page-capability-is-product-surface-failure',
    async run() {
      const item = bundle('REC-E2E-BASIC-010');
      const result = await executeOne(item);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      const pageLane = result.laneResults.find((lane) => lane.lane === 'PAGE_PRODUCTION_OBSERVATION');
      assert(pageLane);
      assert.strictEqual(pageLane.status, 'CASE_FAIL');
      assert.strictEqual(pageLane.failureStage, 'SURFACE_ERROR');
      assert(result.surfaceEvidence.missingCapabilities.includes('SELECT_ORDER'));
      assert.strictEqual(result.businessDiff.orders.created.length, 0);
    }
  },
  {
    name: 'driver-skipping-existing-page-method-is-runner-error',
    async run() {
      await expectWorkerError(
        'REC-E2E-PAGE-008',
        { skipPageEditMethod: true },
        'AUTOMATION_DRIVER_ERROR'
      );
    }
  },
  {
    name: 'fake-provider-blocked-in-production-but-safe-isolated-commit-runs',
    async run() {
      const evidence = await worker('REC-E2E-FIN-001');
      assert.strictEqual(
        evidence.productionObservation.productionEligibility,
        'BLOCKED_NON_REAL_PROVIDER'
      );
      assert.strictEqual(evidence.isolatedCommitEvidence.committed, true);
      assert.strictEqual(evidence.isolatedCommitEvidence.marker, 'TEST_ONLY_ISOLATED_COMMIT');
    }
  },
  {
    name: 'business-safety-block-cannot-be-bypassed',
    async run() {
      const evidence = await modifiedWorker('REC-E2E-FIN-003', (spec, plan) => {
        spec.execution.lanes.push('TEST_ONLY_ISOLATED_LEGACY_COMMIT');
        plan.lanes.push('TEST_ONLY_ISOLATED_LEGACY_COMMIT');
        spec.interaction.requestedSaveAction = 'SAVE_FORMAL';
      });
      assert(evidence.isolatedCommitEvidence);
      assert.strictEqual(evidence.isolatedCommitEvidence.committed, false);
      assert.strictEqual(evidence.isolatedCommitEvidence.reason, 'BUSINESS_SAFETY_BLOCKED');
      assert(
        evidence.isolatedCommitEvidence.prepared.blockingCodes.includes(
          'RECEIVABLE_PAYMENT_INVALID'
        )
      );
    }
  },
  {
    name: 'exact-replay-does-not-call-page-save-twice',
    async run() {
      const evidence = await modifiedWorker('REC-E2E-DATE-007', (spec, plan) => {
        spec.execution.lanes.push('TRANSACTION_EXACT_REPLAY');
        plan.lanes.push('TRANSACTION_EXACT_REPLAY');
      });
      assert.strictEqual(evidence.transactionReplayEvidence.replay.status, 'ALREADY_COMMITTED');
      assert.strictEqual(evidence.transactionReplayEvidence.pageSaveAttempts, 1);
      assert.strictEqual(evidence.transactionReplayEvidence.revisionDelta, 0);
      assert.strictEqual(evidence.transactionReplayEvidence.businessBundleEqual, true);
    }
  },
  {
    name: 'direct-page-data-edit-is-rejected',
    async run() {
      await expectWorkerError(
        'REC-E2E-PAGE-008',
        { directAssignEdit: true },
        'AUTOMATION_DRIVER_ERROR'
      );
    }
  },
  {
    name: 'restart-uses-a-new-worker-runtime',
    async run() {
      const evidence = await modifiedWorker('REC-E2E-DATE-007', (spec, plan) => {
        spec.execution.lanes.push('RESTART_PERSISTENCE');
        plan.lanes.push('RESTART_PERSISTENCE');
      });
      assert.strictEqual(evidence.restartEvidence.newRuntimeInstance, true);
      assert.strictEqual(evidence.restartEvidence.equalToPostSave, true);
      assert.notStrictEqual(
        evidence.restartEvidence.primaryBootId,
        evidence.restartEvidence.restartBootId
      );
    }
  },
  {
    name: 'fixed-clock-ignores-host-current-date',
    async run() {
      const first = await worker('REC-E2E-DATE-007', { attempt: 1 });
      const second = await worker('REC-E2E-DATE-007', { attempt: 2 });
      assert.strictEqual(
        normalizeRunResult(first).fingerprint,
        normalizeRunResult(second).fingerprint
      );
      const result = first.pageEvidence.afterEdits.parseResult;
      assert.strictEqual(result.fields.dueDate, '2026-07-25');
    }
  },
  {
    name: 'concurrent-base-cas-preserves-first-writer',
    async run() {
      const evidence = await modifiedWorker('REC-E2E-DATE-007', (spec, plan) => {
        spec.execution.lanes.push('CONCURRENT_BASE_REVISION');
        plan.lanes.push('CONCURRENT_BASE_REVISION');
        spec.interaction.sequence = [{
          step: 'PREPARE',
          actor: 'PAGE_B',
          input: {
            originalText: '李姐订200套饭盒，4元一套，明天交'
          }
        }];
      });
      assert.strictEqual(evidence.concurrentEvidence.committedA, true);
      assert.strictEqual(evidence.concurrentEvidence.committedB, false);
      assert.strictEqual(evidence.concurrentEvidence.staleDetected, true);
      assert.strictEqual(evidence.concurrentEvidence.pageADataPreserved, true);
      assert.strictEqual(evidence.concurrentEvidence.pageBDataWritten, false);
    }
  }
];

async function main() {
  const results = [];
  for (const test of tests) {
    try {
      await test.run();
      results.push({ name: test.name, status: 'PASS' });
      console.log(`PASS ${test.name}`);
    } catch (error) {
      results.push({
        name: test.name,
        status: 'FAIL',
        error: error.message
      });
      console.error(`FAIL ${test.name}: ${error.message}`);
    }
  }
  const failed = results.filter((item) => item.status === 'FAIL');
  console.log(`Runner self-tests: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  tests
};
