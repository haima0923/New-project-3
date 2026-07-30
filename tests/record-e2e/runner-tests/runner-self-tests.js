#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { assertCase, failureStageFor } = require('../runner/assert-case');
const { assertIsolationAudit } = require('../runner/assert-isolation-audit');
const { buildExecutionPlan } = require('../runner/build-execution-plan');
const {
  assertRestartRuntimeBoundary,
  completeRestartInParent
} = require('../runner/complete-restart-in-parent');
const { createFakeNetwork } = require('../runner/create-fake-network');
const { assertFakeWxApi } = require('../runner/create-fake-wx');
const { createHostFilesystemGuard } = require('../runner/create-host-filesystem-guard');
const { executeRestart } = require('../runner/execute-restart');
const { executeTransactionReplay } = require('../runner/execute-transaction-replay');
const { routeFromResult } = require('../runner/execute-page-observation');
const { baseLane, finalizeLane } = require('../runner/lane-state');
const { loadCorpus } = require('../runner/load-corpus');
const { runCaseWorker } = require('../runner/module-isolation');
const { normalizeRunResult } = require('../runner/normalize-run-result');
const {
  actualOutcome,
  canonicalSemanticResult,
  persistedRecordsFromDiff,
  proposalFromDraft
} = require('../runner/observation-semantics');
const { executeOne } = require('../runner/run-suite');
const {
  validateExecutionPlanPreconditions
} = require('../runner/validate-plan-preconditions');

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
  return caught;
}

function initialCanonicalRawResult(evidence) {
  const raw = evidence.observationSemantics.rawParser;
  const matches = raw.summary.canonicalLocalResults
    .filter((item) => item.phase === 'INITIAL_PARSE');
  assert.strictEqual(matches.length, 1);
  return matches[0].resultSummary;
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
      const evidence = await modifiedWorker('REC-E2E-BASIC-012', (spec, plan) => {
        spec.interaction.requiredCapabilities.push('SELECT_FUTURE_RELATION');
        plan.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      });
      const pageLane = evidence.laneResults.find((lane) => (
        lane.lane === 'PAGE_PRODUCTION_OBSERVATION'
      ));
      assert(pageLane);
      assert.strictEqual(pageLane.status, 'CASE_FAIL');
      assert.strictEqual(pageLane.failureStage, 'SURFACE_ERROR');
      assert(evidence.surfaceEvidence.missingCapabilities.includes('SELECT_FUTURE_RELATION'));
      assert.strictEqual(evidence.businessDiff.orders.created.length, 0);
    }
  },
  {
    name: 'driver-skipping-existing-page-method-is-runner-error',
    async run() {
      const error = await expectWorkerError(
        'REC-E2E-PAGE-008',
        { skipPageEditMethod: true },
        'AUTOMATION_DRIVER_ERROR'
      );
      assert(error.parserObservation);
      assert.strictEqual(error.parserObservation.status, 'RAW_PARSER_INVOKED');
      assert.strictEqual(error.parserObservation.collectionCompleted, true);
      assert.strictEqual(error.finalAudit.isolationAuditCompletion.networkAuditCompleted, true);
      assert.strictEqual(error.finalAudit.isolationAuditCompletion.storageAuditCompleted, true);
    }
  },
  {
    name: 'driver-repeating-page-edit-method-is-runner-error',
    async run() {
      await expectWorkerError(
        'REC-E2E-PAGE-008',
        { repeatPageEditMethod: true },
        'AUTOMATION_DRIVER_ERROR'
      );
    }
  },
  {
    name: 'parent-and-final-audit-errors-retain-parser-graph',
    async run() {
      const error = await expectWorkerError(
        'REC-E2E-PAGE-008',
        {
          forceFinalAuditFailureAfterLaneError: true,
          skipPageEditMethod: true
        },
        'AUTOMATION_FIXTURE_MUTATION_ERROR'
      );
      assert(error.parserObservation);
      assert.strictEqual(error.parserObservation.status, 'RAW_PARSER_INVOKED');
      assert.strictEqual(error.parserObservation.collectionCompleted, true);
      assert.strictEqual(error.secondaryError.code, 'AUTOMATION_DRIVER_ERROR');
      assert.strictEqual(error.finalAudit.fixtureMutationAudit.unchanged, false);
      assert.strictEqual(error.finalAudit.isolationAuditCompletion.networkAuditCompleted, true);
      assert.strictEqual(error.finalAudit.isolationAuditCompletion.storageAuditCompleted, true);
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
    name: 'uncommitted-business-record-is-not-final-saved-record',
    async run() {
      const item = bundle('REC-E2E-PAGE-006');
      item.workerSpec.input.originalText = '钱姐要200个文件袋，每个4元，7月20日交';
      const evidence = await runCaseWorker({
        attempt: 1,
        hooks: { skipSaveEntry: true },
        plan: item.plan,
        spec: item.workerSpec
      });
      assert.strictEqual(evidence.isolatedCommitEvidence.committed, false);
      assert.strictEqual(evidence.isolatedCommitEvidence.reason, 'SAVE_ENTRY_SKIPPED');
      assert.strictEqual(evidence.isolatedCommitEvidence.diff.stateChanged, true);
      assert.strictEqual(
        evidence.pageEvidence.pageEditConsistency.finalSavedRecord,
        null
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
      assert.strictEqual(evidence.transactionReplayEvidence.pageSaveAttempts, 0);
      assert.strictEqual(evidence.transactionReplayEvidence.replayPageSaveAttempts, 0);
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
      const item = bundle('REC-E2E-PERSIST-001');
      const evidence = await executeOne(item);
      assert.strictEqual(evidence.restartEvidence.newRuntimeInstance, true);
      assert.strictEqual(evidence.restartEvidence.equalToPostSave, true);
      assert.notStrictEqual(
        evidence.restartEvidence.primaryBootId,
        evidence.restartEvidence.restartBootId
      );
      assert.notStrictEqual(
        evidence.restartEvidence.primaryPid,
        evidence.restartEvidence.restartPid
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
  },
  {
    name: 'lane-not-started-cannot-pass',
    async run() {
      const lane = baseLane('SELF_TEST');
      lane.status = 'PASS';
      lane.completionEvidencePresent = true;
      finalizeLane(lane);
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert.strictEqual(lane.failureCode, 'LANE_EXECUTION_EVIDENCE_MISSING');
    }
  },
  {
    name: 'lane-primary-action-not-attempted-cannot-pass',
    async run() {
      const lane = Object.assign(baseLane('SELF_TEST'), {
        assertionsCompleted: true,
        completed: true,
        completionEvidencePresent: true,
        planned: true,
        preconditionsChecked: true,
        preconditionsPassed: true,
        primaryActionSucceeded: true,
        started: true,
        status: 'PASS'
      });
      finalizeLane(lane);
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
    }
  },
  {
    name: 'lane-completion-evidence-is-mandatory',
    async run() {
      const lane = Object.assign(baseLane('SELF_TEST'), {
        planned: true,
        preconditionsChecked: true,
        preconditionsPassed: true,
        started: true,
        primaryActionAttempted: true,
        primaryActionSucceeded: true,
        status: 'PENDING_ASSERTIONS'
      });
      finalizeLane(lane);
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert(
        lane.evidence.missingExecutionEvidence.includes('completionEvidencePresent')
      );
    }
  },
  {
    name: 'planned-lane-cannot-leave-assertion-engine',
    async run() {
      const lane = baseLane('SELF_TEST');
      finalizeLane(lane);
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert.strictEqual(lane.failureCode, 'LANE_EXECUTION_EVIDENCE_MISSING');
    }
  },
  {
    name: 'missing-required-lane-result-is-runner-error',
    async run() {
      const item = bundle('REC-E2E-PERSIST-003');
      const evidence = await worker(item.testCase.caseId);
      evidence.laneResults = evidence.laneResults.filter((lane) => (
        lane.lane !== 'TRANSACTION_EXACT_REPLAY'
      ));
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.strictEqual(result.failureCode, 'LANE_EXECUTION_EVIDENCE_MISSING');
    }
  },
  {
    name: 'restart-does-not-run-after-first-commit-failure',
    async run() {
      const item = bundle('REC-E2E-PERSIST-003');
      const evidence = await runCaseWorker({
        attempt: 1,
        hooks: { skipSaveEntry: true },
        plan: item.plan,
        spec: item.workerSpec
      });
      const lane = evidence.laneResults.find((entry) => entry.lane === 'RESTART_PERSISTENCE');
      assert.strictEqual(evidence.restartRequest, null);
      assert.strictEqual(evidence.restartEvidence.notExecuted, true);
      assert.strictEqual(lane.preconditionsPassed, false);
      assert.notStrictEqual(lane.status, 'PASS');
    }
  },
  {
    name: 'restart-empty-state-comparison-is-rejected',
    async run() {
      const item = bundle('REC-E2E-PERSIST-003');
      const evidence = await worker(item.testCase.caseId);
      evidence.restartRequest.postSaveState = safeClone(item.workerSpec.initialState.state);
      await assert.rejects(
        () => completeRestartInParent(evidence, item.workerSpec, item.plan, 1),
        (error) => error.code === 'LANE_EXECUTION_EVIDENCE_MISSING'
      );
    }
  },
  {
    name: 'restart-same-worker-boundary-is-rejected',
    async run() {
      assert.throws(
        () => assertRestartRuntimeBoundary({
          newRuntimeInstance: false,
          restartBootId: 'same-boot',
          restartPid: 101,
          workerExitAudit: { exitCode: 0, exitObserved: true }
        }, {
          bootId: 'same-boot',
          pid: 101
        }),
        (error) => error.code === 'LANE_EXECUTION_EVIDENCE_MISSING'
      );
    }
  },
  {
    name: 'restart-worker-error-retains-hard-isolation-audit',
    async run() {
      const item = bundle('REC-E2E-PERSIST-001');
      const evidence = await worker(item.testCase.caseId);
      const request = evidence.restartRequest;
      let caught = null;
      try {
        await executeRestart(
          item.workerSpec,
          request.entries,
          request.primaryBootId,
          request.primaryPid,
          901,
          { hooks: { forceErrorAfterRuntime: true } }
        );
      } catch (error) {
        caught = error;
      }
      assert(caught);
      assert.strictEqual(caught.code, 'RESTART_PERSISTENCE_ERROR');
      assert(caught.finalAudit);
      assert.strictEqual(caught.finalAudit.networkAudit.realNetworkRequests, 0);
      assert.strictEqual(caught.finalAudit.networkAudit.unknownFakeRouteRequests, 0);
      assert.strictEqual(caught.finalAudit.storageAudit.realWxStorageCalls, 0);
      assert.strictEqual(
        caught.finalAudit.hostFilesystemAudit.hostFilesystemStorageCalls,
        0
      );
      assert.strictEqual(caught.finalAudit.fixtureMutationAudit.unchanged, true);
      assert.strictEqual(caught.finalAudit.finalTransactionAudit.journalCount, 0);
      assert.strictEqual(caught.finalAudit.finalTransactionAudit.backupCount, 0);
      assert.strictEqual(caught.workerExitAudit.exitObserved, true);
    }
  },
  {
    name: 'exact-replay-requires-first-receipt',
    async run() {
      const item = bundle('REC-E2E-PERSIST-003');
      assert.throws(
        () => executeTransactionReplay({ commitResult: {}, gateway: null }, item.workerSpec),
        (error) => error.code === 'AUTOMATION_DRIVER_ERROR'
      );
    }
  },
  {
    name: 'exact-replay-new-transaction-identity-fails',
    async run() {
      const item = bundle('REC-E2E-PERSIST-003');
      const evidence = await worker(item.testCase.caseId);
      evidence.transactionReplayEvidence.replayInputIdentity.transactionId = 'new-transaction';
      evidence.transactionReplayEvidence.sameIdentity = false;
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(
        result.assertions.some((entry) => entry.name === 'sameIdentity' && !entry.pass)
      );
    }
  },
  {
    name: 'concurrent-first-commit-failure-prevents-second-commit',
    async run() {
      const evidence = await modifiedWorker('REC-E2E-PERSIST-004', (spec) => {
        spec.initialState.state = safeClone(spec.initialState.state);
        spec.expected = safeClone(spec.expected);
        spec.ai.profile = 'LOCAL_ONLY';
        spec.input.originalText = '李姐订80个饭盒，6元一个';
      });
      assert.strictEqual(evidence.concurrentEvidence.committedA, false);
      assert.notStrictEqual(evidence.concurrentEvidence.secondCommitAttempted, true);
      const lane = evidence.laneResults.find((entry) => (
        entry.lane === 'CONCURRENT_BASE_REVISION'
      ));
      assert.notStrictEqual(lane.status, 'PASS');
    }
  },
  {
    name: 'concurrent-second-commit-attempt-evidence-is-mandatory',
    async run() {
      const item = bundle('REC-E2E-PERSIST-004');
      const evidence = await executeOne(item);
      evidence.concurrentEvidence.secondCommitAttempted = false;
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(
        result.assertions.some((entry) => (
          entry.name === 'secondCommitAttempted' && !entry.pass
        ))
      );
    }
  },
  {
    name: 'duplicate-trigger-requires-four-layer-counts',
    async run() {
      const item = bundle('REC-E2E-FIN-014');
      const evidence = await worker(item.testCase.caseId);
      delete evidence.duplicateTriggerEvidence.transactionBeginCount;
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(
        result.assertions.some((entry) => (
          entry.name === 'transactionBeginCount' && !entry.pass
        ))
      );
    }
  },
  {
    name: 'storage-save-without-transaction-decision-cannot-pass',
    async run() {
      const item = bundle('REC-E2E-FIN-014');
      const evidence = await worker(item.testCase.caseId);
      assert.strictEqual(evidence.duplicateTriggerEvidence.storageSaveAttemptCount, 1);
      evidence.duplicateTriggerEvidence.transactionBeginCount = 0;
      evidence.duplicateTriggerEvidence.transactionCommitAttempts = 0;
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(
        result.assertions.some((entry) => (
          entry.name === 'transactionBeginCount' && !entry.pass
        ))
      );
    }
  },
  {
    name: 'surface-gap-remains-primary-over-route-findings',
    async run() {
      const item = bundle('REC-E2E-BASIC-012');
      item.testCase = safeClone(item.testCase);
      item.workerSpec = safeClone(item.workerSpec);
      item.plan = safeClone(item.plan);
      item.testCase.interaction.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      item.workerSpec.interaction.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      item.plan.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      item.testCase.expected.route = 'AI_DEEP';
      const result = await executeOne(item);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert.strictEqual(result.failureStage, 'SURFACE_ERROR');
      assert.strictEqual(result.failureCode, 'REQUIRED_PAGE_CAPABILITY_MISSING');
      assert(
        (result.secondaryFindings || []).some((finding) => finding.failureStage === 'ROUTE_ERROR')
        || result.assertions.every((entry) => entry.name !== 'route' || entry.pass)
      );
    }
  },
  {
    name: 'pending-case-fixture-original-mismatch-fails-plan',
    async run() {
      const item = bundle('REC-E2E-BASIC-020');
      const altered = safeClone(item.testCase);
      altered.input.originalText = '与待整理fixture不一致的合成原文';
      const errors = validateExecutionPlanPreconditions(
        altered,
        item.workerSpec.initialState.state
      );
      assert(errors.includes('PENDING_EDIT_ORIGINAL_TEXT_MISMATCH'));
    }
  },
  {
    name: 'required-selection-target-must-exist-in-fixture',
    async run() {
      const item = bundle('REC-E2E-BASIC-010');
      const altered = safeClone(item.testCase);
      altered.interaction.userSelections[0].selectedId = 'ord-does-not-exist';
      const errors = validateExecutionPlanPreconditions(
        altered,
        item.workerSpec.initialState.state
      );
      assert(
        errors.some((code) => code.startsWith('SELECTION_TARGET_NOT_FOUND:orderId:'))
      );
    }
  },
  {
    name: 'concurrent-page-b-explicit-unit-conflict-fails-plan',
    async run() {
      const item = bundle('REC-E2E-PERSIST-004');
      const altered = safeClone(item.testCase);
      const pageB = altered.interaction.sequence.find((step) => step.actor === 'PAGE_B');
      pageB.input.originalText = '李姐订200个饭盒，4元一套，7月25日交';
      const errors = validateExecutionPlanPreconditions(
        altered,
        item.workerSpec.initialState.state
      );
      assert(errors.includes('CONCURRENT_PAGE_B_EXPLICIT_UNIT_CONFLICT'));
    }
  },
  {
    name: 'network-audit-must-execute',
    async run() {
      await expectWorkerError(
        'REC-E2E-DATE-007',
        { skipNetworkAudit: true },
        'ISOLATION_AUDIT_NOT_EXECUTED'
      );
    }
  },
  {
    name: 'storage-audit-must-execute',
    async run() {
      await expectWorkerError(
        'REC-E2E-DATE-007',
        { skipStorageAudit: true },
        'ISOLATION_AUDIT_NOT_EXECUTED'
      );
    }
  },
  {
    name: 'fixture-mutation-is-a-runner-error',
    async run() {
      await expectWorkerError(
        'REC-E2E-DATE-007',
        { mutateFixture: true },
        'AUTOMATION_FIXTURE_MUTATION_ERROR'
      );
    }
  },
  {
    name: 'journal-residue-is-a-cleanup-error',
    async run() {
      await expectWorkerError(
        'REC-E2E-DATE-007',
        { leaveJournalMaterial: true },
        'CLEANUP_ERROR'
      );
    }
  },
  {
    name: 'surface-zero-side-effect-uses-runtime-storage-diff',
    async run() {
      const item = bundle('REC-E2E-BASIC-012');
      item.testCase = safeClone(item.testCase);
      item.workerSpec = safeClone(item.workerSpec);
      item.plan = safeClone(item.plan);
      item.testCase.interaction.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      item.workerSpec.interaction.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      item.plan.requiredCapabilities.push('SELECT_FUTURE_RELATION');
      const result = await executeOne(item, {
        hooks: { mutateSurfaceBusinessStorage: true }
      });
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert.strictEqual(result.businessDiff.orders.created.length, 1);
      assert(
        result.assertions.some((entry) => (
          entry.name === 'formalBusinessDiffEmpty' && !entry.pass
        ))
      );
    }
  },
  {
    name: 'relation-tamper-uses-real-preflight-without-page-selection-or-save',
    async run() {
      for (const caseId of ['REC-E2E-REL-007', 'REC-E2E-REL-008']) {
        const evidence = await worker(caseId);
        const tamper = evidence.relationReferenceTamperEvidence;
        assert(tamper);
        assert.strictEqual(tamper.pageSelectionMethodCalled, false);
        assert.strictEqual(tamper.businessSaveCalled, false);
        assert.strictEqual(tamper.saveAttempted, false);
        assert.strictEqual(tamper.domainCanSaveFormal, false);
        assert.strictEqual(tamper.stateUnchanged, true);
        assert.strictEqual(tamper.mutationPaths.length, 1);
        assert.strictEqual(tamper.mutationPaths[0], 'fields.quotationId');
      }
    }
  },
  {
    name: 'relation-tamper-dangerous-quotation-never-becomes-safe-candidate',
    async run() {
      for (const caseId of ['REC-E2E-REL-007', 'REC-E2E-REL-008']) {
        const evidence = await worker(caseId);
        const tamper = evidence.relationReferenceTamperEvidence;
        assert.strictEqual(tamper.injectedReferenceExcludedFromSafeCandidates, true);
        assert(!tamper.candidateIds.includes(tamper.injectedRelation.id));
        assert(tamper.rejectedQuotationReferences.some((item) => (
          item.quotationId === tamper.injectedRelation.id
        )));
      }
    }
  },
  {
    name: 'relation-tamper-save-or-business-call-evidence-cannot-pass',
    async run() {
      const item = bundle('REC-E2E-REL-007');
      const evidence = await worker(item.testCase.caseId);
      evidence.relationReferenceTamperEvidence.businessSaveCalled = true;
      evidence.relationReferenceTamperEvidence.saveAttempted = true;
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(result.assertions.some((entry) => (
        entry.layer === 'RELATION_TAMPER' && entry.pass === false
      )));
    }
  },
  {
    name: 'relation-tamper-dynamic-business-call-is-detected',
    async run() {
      const item = bundle('REC-E2E-REL-007');
      const result = await executeOne(item, {
        hooks: { relationTamperInvokeBusinessSave: true }
      });
      const lane = result.laneResults.find((entry) => (
        entry.lane === 'RELATION_REFERENCE_TAMPER_GUARD'
      ));
      assert.strictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert.strictEqual(lane.failureCode, 'RELATION_TAMPER_FORBIDDEN_ACTIVITY');
      assert(result.assertions.some((entry) => (
        entry.layer === 'RELATION_TAMPER'
        && entry.name === 'businessSaveAttemptCount'
        && entry.pass === false
      )));
    }
  },
  {
    name: 'relation-tamper-dynamic-page-method-call-is-detected',
    async run() {
      const item = bundle('REC-E2E-REL-007');
      const result = await executeOne(item, {
        hooks: { relationTamperInvokePageMethod: true }
      });
      const lane = result.laneResults.find((entry) => (
        entry.lane === 'RELATION_REFERENCE_TAMPER_GUARD'
      ));
      assert.strictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert.strictEqual(lane.failureCode, 'RELATION_TAMPER_FORBIDDEN_ACTIVITY');
      assert(result.assertions.some((entry) => (
        entry.layer === 'RELATION_TAMPER'
        && entry.name === 'pageMethodInvocationCount'
        && entry.pass === false
      )));
    }
  },
  {
    name: 'relation-tamper-dynamic-storage-write-is-detected',
    async run() {
      const item = bundle('REC-E2E-REL-007');
      const result = await executeOne(item, {
        hooks: { relationTamperMutateStorage: true }
      });
      const lane = result.laneResults.find((entry) => (
        entry.lane === 'RELATION_REFERENCE_TAMPER_GUARD'
      ));
      assert.strictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert.strictEqual(lane.failureCode, 'RELATION_TAMPER_FORBIDDEN_ACTIVITY');
      assert(result.assertions.some((entry) => (
        entry.layer === 'RELATION_TAMPER'
        && entry.name === 'storageWriteCount'
        && entry.pass === false
      )));
    }
  },
  {
    name: 'relation-tamper-missing-instrumentation-is-runner-error',
    async run() {
      const item = bundle('REC-E2E-REL-007');
      const result = await executeOne(item, {
        hooks: { relationTamperDropInstrumentation: true }
      });
      const lane = result.laneResults.find((entry) => (
        entry.lane === 'RELATION_REFERENCE_TAMPER_GUARD'
      ));
      assert.strictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.strictEqual(lane.status, 'RUNNER_ERROR');
      assert.strictEqual(lane.failureCode, 'ISOLATION_AUDIT_NOT_EXECUTED');
    }
  },
  {
    name: 'raw-null-operation-with-effective-create-order-can-pass',
    async run() {
      const item = bundle('REC-E2E-BASIC-001');
      const evidence = await worker(item.testCase.caseId);
      assert.strictEqual(initialCanonicalRawResult(evidence).operation, null);
      assert.strictEqual(
        evidence.observationSemantics.semanticResult.effectiveOperation,
        'create_order'
      );
      assert.strictEqual(assertCase(item.testCase, evidence).caseStatus, 'PASS');
    }
  },
  {
    name: 'raw-null-operation-without-domain-semantic-is-not-fabricated',
    async run() {
      const semantic = canonicalSemanticResult({
        businessType: 'unknown',
        operation: 'pending'
      });
      const proposal = proposalFromDraft({
        fields: {},
        intent: 'unknown',
        operation: '',
        original_text: '王总下单'
      }, semantic, 'HEADLESS');
      assert.strictEqual(semantic.effectiveOperation, 'unresolved');
      assert.strictEqual(proposal.businessType, 'unknown');
      assert.strictEqual(proposal.operation, 'unresolved');
    }
  },
  {
    name: 'semantic-none-requires-no-record-route',
    async run() {
      const semantic = canonicalSemanticResult({
        businessType: 'unknown',
        operation: 'pending'
      }, {
        route: 'NO_RECORD'
      });
      assert.strictEqual(semantic.businessType, 'unknown');
      assert.strictEqual(semantic.effectiveOperation, 'none');
    }
  },
  {
    name: 'no-record-route-uses-the-physical-production-decision',
    run() {
      assert.strictEqual(routeFromResult({}), 'UNKNOWN');
      assert.strictEqual(routeFromResult({
        parse_route: {
          decision: 'pending',
          semantic_decision: 'no_record',
          no_record_eligible: false
        }
      }), 'PENDING');
      assert.strictEqual(routeFromResult({
        parse_route: {
          decision: 'pending',
          semantic_decision: 'no_record',
          no_record_eligible: true
        }
      }), 'PENDING');
      assert.strictEqual(routeFromResult({
        parse_route: {
          decision: 'no_record',
          semantic_decision: 'no_record',
          no_record_eligible: true
        }
      }), 'NO_RECORD');
    }
  },
  {
    name: 'dedicated-raw-parser-operation-mismatch-fails',
    async run() {
      const item = bundle('REC-E2E-BASIC-001');
      const evidence = await worker(item.testCase.caseId);
      const contract = safeClone(item.testCase);
      contract.expected.observationSemantics.rawParser = {
        assertionScope: 'REQUIRED',
        businessType: 'order',
        intent: 'order',
        operation: 'create_order'
      };
      const result = assertCase(contract, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert.strictEqual(result.failureStage, 'LOCAL_PARSE_ERROR');
      assert(result.assertions.some((entry) => (
        entry.layer === 'RAW_PARSER'
        && entry.name === 'operation'
        && entry.pass === false
      )));
    }
  },
  {
    name: 'dunning-is-canonically-projected-to-todo',
    async run() {
      const evidence = await worker('REC-E2E-BASIC-017');
      assert.strictEqual(initialCanonicalRawResult(evidence).intent, 'dunning');
      assert.strictEqual(evidence.observationSemantics.semanticResult.businessType, 'todo');
      assert.strictEqual(
        evidence.observationSemantics.semanticResult.effectiveOperation,
        'create_todo'
      );
      assert.strictEqual(
        evidence.observationSemantics.semanticResult.source,
        'DOMAIN_PREFLIGHT_ALIAS'
      );
    }
  },
  {
    name: 'proposed-order-and-final-pending-remain-separate',
    async run() {
      const evidence = await worker('REC-E2E-BASIC-019');
      assert.strictEqual(evidence.observationSemantics.proposal.businessType, 'order');
      assert.strictEqual(evidence.observationSemantics.proposal.operation, 'create_order');
      assert.strictEqual(evidence.observationSemantics.outcome.disposition, 'PENDING_NOTE');
      assert.strictEqual(
        evidence.observationSemantics.outcome.persistedRecordType,
        'pending_note'
      );
    }
  },
  {
    name: 'pending-outcome-does-not-skip-proposal-assertions',
    async run() {
      const item = bundle('REC-E2E-BASIC-019');
      const evidence = await worker(item.testCase.caseId);
      evidence.observationSemantics.proposal.originalText = 'wrong proposal text';
      const result = assertCase(item.testCase, evidence);
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(result.assertions.some((entry) => (
        entry.layer === 'PROPOSAL'
        && entry.name === 'originalText'
        && entry.pass === false
      )));
    }
  },
  {
    name: 'formal-outcome-needs-actual-formal-state-diff',
    async run() {
      const outcome = actualOutcome({
        businessDiff: {},
        isolatedCommitEvidence: { committed: true },
        requestedSaveAction: 'SAVE_FORMAL',
        route: 'LOCAL'
      });
      assert.strictEqual(outcome.disposition, 'BLOCKED');
      assert.strictEqual(outcome.formalSaveSucceeded, false);
    }
  },
  {
    name: 'pending-outcome-needs-actual-pending-state-diff',
    async run() {
      const outcome = actualOutcome({
        businessDiff: {},
        isolatedCommitEvidence: { committed: true },
        requestedSaveAction: 'SAVE_PENDING',
        route: 'PENDING'
      });
      assert.strictEqual(outcome.disposition, 'BLOCKED');
      assert.strictEqual(outcome.pendingSaveSucceeded, false);
    }
  },
  {
    name: 'pending-outcome-cannot-hide-formal-order-diff',
    async run() {
      const outcome = actualOutcome({
        businessDiff: { orders: { created: [{ id: 'ord-sentinel' }] } },
        isolatedCommitEvidence: { committed: true },
        requestedSaveAction: 'SAVE_PENDING',
        route: 'PENDING'
      });
      assert.strictEqual(outcome.disposition, 'BLOCKED');
      assert.deepStrictEqual(outcome.persistedRecordTypes, ['order']);
    }
  },
  {
    name: 'semantic-result-is-not-generated-from-expected',
    async run() {
      const item = bundle('REC-E2E-BASIC-001');
      const evidence = await worker(item.testCase.caseId);
      const contract = safeClone(item.testCase);
      contract.expected.observationSemantics.semanticResult.businessType = 'quotation';
      const result = assertCase(contract, evidence);
      assert.strictEqual(evidence.observationSemantics.semanticResult.businessType, 'order');
      assert.strictEqual(result.caseStatus, 'CASE_FAIL');
      assert(result.assertions.some((entry) => (
        entry.layer === 'SEMANTIC_RESULT'
        && entry.name === 'businessType'
        && entry.pass === false
      )));
    }
  },
  {
    name: 'persisted-record-type-comes-from-actual-state-diff',
    async run() {
      const records = persistedRecordsFromDiff({
        orders: { created: [{ id: 'ord-actual' }] },
        pendingNotes: { created: [] }
      });
      assert.deepStrictEqual(records, [{
        change: 'CREATED',
        collection: 'orders',
        id: 'ord-actual',
        recordType: 'order'
      }]);
    }
  },
  {
    name: 'ai-corrected-semantic-difference-is-not-local-parse-stage',
    async run() {
      assert.strictEqual(
        failureStageFor(
          { layer: 'PROPOSAL', name: 'businessType' },
          { ai: { profile: 'FAKE_STANDARD' } }
        ),
        'AI_NORMALIZE_ERROR'
      );
    }
  },
  {
    name: 'quotation-negation-parser-fix-remains-observable',
    async run() {
      const result = await executeOne(bundle('REC-E2E-BASIC-006'));
      const raw = initialCanonicalRawResult(result);
      assert.strictEqual(result.caseStatus, 'PASS');
      assert.strictEqual(raw.intent, 'quotation');
      assert.strictEqual(raw.operation, null);
      assert.strictEqual(
        raw.intentEvidence.winningReason,
        'EXPLICIT_QUOTATION_WITH_NEGATED_ORDER_ACTION'
      );
      assert(raw.intentEvidence.quotationPositiveSignals.length > 0);
      assert(raw.intentEvidence.orderNegationSignals.some((signal) => (
        signal.sourceText === '还没下单'
      )));
    }
  },
  {
    name: 'clear-non-business-route-advances-amb-005-past-route-contract',
    async run() {
      const result = await executeOne(bundle('REC-E2E-AMB-005'));
      const raw = initialCanonicalRawResult(result);
      assert.strictEqual(result.caseStatus, 'PASS');
      assert.strictEqual(result.failureStage, '');
      assert.notStrictEqual(result.failureOwnership, 'CONFIRMED_LOCAL_PARSER_DEFECT');
      assert.strictEqual(raw.intent, 'unknown');
      assert.strictEqual(raw.businessType, 'unknown');
      assert.strictEqual(raw.operation, null);
      assert.strictEqual(raw.intentEvidence.scores.order, 0);
      assert.deepStrictEqual(raw.intentEvidence.orderPositiveSignals, []);
      assert.deepStrictEqual(raw.intentEvidence.orderEntitySignals, []);
      assert.deepStrictEqual(raw.intentEvidence.orderDeliverySignals, []);
      assert(!result.assertions.some((entry) => (
        entry.layer === 'RAW_PARSER' && entry.pass === false
      )));
      assert.strictEqual(result.routeEvidence.actualRoute, 'NO_RECORD');
      assert.strictEqual(result.routeEvidence.productionRoute, 'NO_RECORD');
      assert.strictEqual(result.routeEvidence.semanticRoute, 'NO_RECORD');
      assert.strictEqual(result.routeEvidence.noRecordEligible, true);
      assert.deepStrictEqual(result.routeEvidence.noRecordEligibilityExclusions, []);
      assert.strictEqual(result.routeEvidence.businessEvidenceCount, 0);
      assert.strictEqual(result.routeEvidence.structuredBusinessFieldCount, 0);
      assert.strictEqual(result.routeEvidence.relationEvidenceCount, 0);
      assert.strictEqual(result.routeEvidence.asyncWorkCompleted, true);
      assert.strictEqual(result.routeEvidence.AIRequestCount, 0);
      assert.strictEqual(result.noRecordEvidence.domainCanSaveFormal, false);
      assert.strictEqual(result.noRecordEvidence.domainCanSavePending, false);
      assert.strictEqual(result.noRecordEvidence.effectiveCanSaveFormal, false);
      assert.strictEqual(result.noRecordEvidence.effectiveCanSavePending, false);
      assert.strictEqual(result.noRecordEvidence.formalSaveVisible, false);
      assert.strictEqual(result.noRecordEvidence.pendingSaveVisible, false);
      assert.strictEqual(result.noRecordEvidence.deepReviewVisible, false);
      assert.strictEqual(result.noRecordEvidence.pendingSaveAttemptCount, 0);
      assert.strictEqual(result.noRecordEvidence.pendingSavedCount, 0);
      assert.strictEqual(result.noRecordEvidence.businessStateDiffIsZero, true);
      assert.strictEqual(result.noRecordEvidence.outcomeDisposition, 'NO_RECORD');
      assert.notStrictEqual(
        result.observationSemantics.semanticResult.effectiveOperation,
        'create_order'
      );
      assert.strictEqual(
        result.observationSemantics.semanticResult.effectiveOperation,
        'none'
      );
      assert.strictEqual(
        result.observationSemantics.outcome.disposition,
        'NO_RECORD'
      );
      assert.strictEqual(result.observationSemantics.outcome.formalSaveSucceeded, false);
      assert.strictEqual(result.observationSemantics.outcome.pendingSaveSucceeded, false);
    }
  },
  {
    name: 'business-like-incomplete-cases-are-not-dropped-as-no-record',
    async run() {
      for (const caseId of [
        'REC-E2E-BASIC-019',
        'REC-E2E-BASIC-020',
        'REC-E2E-AMB-001',
        'REC-E2E-AMB-002',
        'REC-E2E-AMB-014'
      ]) {
        const result = await executeOne(bundle(caseId));
        assert.notStrictEqual(result.routeEvidence.actualRoute, 'NO_RECORD', `${caseId}不得被丢弃`);
        assert.notStrictEqual(result.routeEvidence.noRecordEligible, true, `${caseId}不得取得NO_RECORD资格`);
        assert(
          result.routeEvidence.businessEvidenceCount > 0
            || result.routeEvidence.noRecordEligible === null
            || result.routeEvidence.noRecordEligibilityExclusions.some((code) => (
              [
                'AI_POLICY_REQUIRES_REVIEW',
                'BUSINESS_FIELDS_MISSING',
                'BUSINESS_INTENT_CANDIDATE_PRESENT',
                'BUSINESS_INTENT_EVIDENCE_PRESENT',
                'LOCAL_SAFETY_NOT_NO_RECORD',
                'MULTI_MESSAGE_INPUT'
              ].includes(code)
            )),
          `${caseId}必须保留业务Evidence或明确的fail-closed排除原因`
        );
      }
    }
  },
  {
    name: 'voice-async-and-multi-message-paths-do-not-terminate-as-no-record',
    async run() {
      for (const caseId of [
        'REC-E2E-VOICE-004',
        'REC-E2E-VOICE-006',
        'REC-E2E-MULTI-009'
      ]) {
        const result = await executeOne(bundle(caseId));
        assert.notStrictEqual(result.routeEvidence.actualRoute, 'NO_RECORD', `${caseId}不得提前NO_RECORD`);
        assert.notStrictEqual(result.routeEvidence.noRecordEligible, true, `${caseId}不得取得NO_RECORD资格`);
        assert.strictEqual(result.routeEvidence.asyncWorkCompleted, true, `${caseId}必须在完整采集后判断Route`);
        assert.strictEqual(result.parserObservation.collectionCompleted, true, `${caseId}采集必须完成`);
        assert.strictEqual(result.parserObservation.validationCompleted, true, `${caseId}调用图验证必须完成`);
      }
    }
  },
  {
    name: 'safe-local-receivable-cases-use-actual-route-and-selection-evidence',
    async run() {
      for (const caseId of [
        'REC-E2E-BASIC-009',
        'REC-E2E-BASIC-010'
      ]) {
        const result = await executeOne(bundle(caseId));
        const raw = initialCanonicalRawResult(result);
        assert.strictEqual(result.routeEvidence.actualRoute, 'LOCAL');
        assert.strictEqual(result.routeEvidence.safeLocalReceivableEligible, true);
        assert.strictEqual(result.routeEvidence.AIRequestCount, 0);
        assert.strictEqual(result.routeEvidence.evidenceSource, 'ACTUAL_PARSE_ROUTE');
        assert.strictEqual(raw.intent, 'receivable');
        assert.strictEqual(raw.businessType, 'receivable');
        assert(!result.assertions.some((entry) => (
          entry.layer === 'RAW_PARSER'
          && entry.name === 'businessType'
          && entry.pass === false
        )));
      }
      const relationResult = await executeOne(bundle('REC-E2E-BASIC-010'));
      assert.strictEqual(relationResult.caseStatus, 'PASS');
      assert.deepStrictEqual(
        relationResult.interactionEvidence.evidence.selections.map((item) => ({
          applied: item.applied,
          method: item.method,
          selectedId: item.selectedId
        })),
        [{ applied: true, method: 'changeOrder', selectedId: 'ord-active-a' }]
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.methodName,
        'changeOrder'
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.methodInvocationDelta,
        1
      );
      assert.deepStrictEqual(
        relationResult.receivableOrderGateEvidence.preSelectionPreflight.requiredSelections,
        ['orderId']
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.preSelectionPreflight.domainCanSaveFormal,
        false
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.preSelectionPreflight.orderSelectionConfirmed,
        false
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.preSelectionPreflight.formalSaveInvocationCount,
        0
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.preSelectionPreflight.businessSaveInvocationCount,
        0
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.preSelectionPreflight.productionStorageWriteCount,
        0
      );
      assert.deepStrictEqual(
        relationResult.receivableOrderGateEvidence.postSelectionPreflight.requiredSelections,
        []
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.postSelectionPreflight.domainCanSaveFormal,
        true
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.postSelectionPreflight.orderSelectionConfirmed,
        true
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.postSelectionPreflight.selectedOrderId,
        'ord-active-a'
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.savePreflightEvidence.stateSource,
        'ISOLATED_GATEWAY_REREAD'
      );
      assert.strictEqual(
        relationResult.receivableOrderGateEvidence.savePreflightEvidence
          .productionPreflight.domainCanSaveFormal,
        true
      );
      const customerLevelResult = await executeOne(bundle('REC-E2E-BASIC-009'));
      assert.strictEqual(customerLevelResult.caseStatus, 'PASS');
      assert.deepStrictEqual(
        customerLevelResult.receivableOrderGateEvidence
          .preSelectionPreflight.requiredSelections,
        []
      );
      assert.strictEqual(
        customerLevelResult.receivableOrderGateEvidence
          .preSelectionPreflight.domainCanSaveFormal,
        true
      );
    }
  },
  {
    name: 'completed-payment-parser-fixes-advance-to-real-downstream-differences',
    async run() {
      for (const caseId of [
        'REC-E2E-BASIC-012',
        'REC-E2E-PAGE-003'
      ]) {
        const result = await executeOne(bundle(caseId));
        const raw = initialCanonicalRawResult(result);
        assert.strictEqual(result.caseStatus, 'CASE_FAIL');
        assert.notStrictEqual(result.failureStage, 'LOCAL_PARSE_ERROR');
        assert.notStrictEqual(result.failureOwnership, 'CONFIRMED_LOCAL_PARSER_DEFECT');
        assert.strictEqual(result.routeEvidence.actualRoute, 'AI_DEEP');
        assert.strictEqual(raw.intent, 'payment');
        assert.strictEqual(raw.businessType, 'payment');
        assert.strictEqual(raw.operation, null);
        assert(!result.assertions.some((entry) => (
          entry.layer === 'RAW_PARSER' && entry.pass === false
        )));
      }
    }
  },
  {
    name: 'page-008-raw-null-no-longer-masks-next-real-difference',
    async run() {
      const result = await executeOne(bundle('REC-E2E-PAGE-008'));
      assert.strictEqual(initialCanonicalRawResult(result).operation, null);
      assert.strictEqual(
        result.observationSemantics.semanticResult.effectiveOperation,
        'create_order'
      );
      assert.strictEqual(result.failureStage, 'ROUTE_ERROR');
      assert(!result.assertions.some((entry) => (
        entry.layer === 'RAW_PARSER' && entry.pass === false
      )));
    }
  },
  {
    name: 'proposal-projection-does-not-use-input-keywords',
    async run() {
      const semantic = canonicalSemanticResult({
        businessType: 'unknown',
        operation: 'pending'
      });
      const proposal = proposalFromDraft({
        fields: {},
        intent: 'unknown',
        operation: '',
        original_text: '下单更新报价收款'
      }, semantic, 'HEADLESS');
      assert.deepStrictEqual(
        [proposal.businessType, proposal.operation],
        ['unknown', 'unresolved']
      );
    }
  },
  {
    name: 'observation-evidence-has-independent-source-markers',
    async run() {
      const evidence = await worker('REC-E2E-BASIC-001');
      assert.strictEqual(
        evidence.observationSemantics.rawParser.productionPath.source,
        'PRODUCTION_PATH_OBSERVATION_REGISTRY'
      );
      assert.strictEqual(
        evidence.observationSemantics.rawParser.collectionCompleted,
        true
      );
      assert.strictEqual(
        evidence.observationSemantics.rawParser.validationCompleted,
        true
      );
      assert.strictEqual(
        evidence.observationSemantics.semanticResult.source,
        'DOMAIN_PREFLIGHT'
      );
      assert.strictEqual(
        evidence.observationSemantics.proposal.source,
        'PAGE_CONFIRMED_DRAFT'
      );
      assert.strictEqual(
        evidence.observationSemantics.proposal.operationSource,
        'DOMAIN_PREFLIGHT_EFFECTIVE_OPERATION'
      );
      assert.strictEqual(
        evidence.observationSemantics.outcome.source,
        'STATE_DIFF_AND_COMMIT'
      );
    }
  },
  {
    name: 'host-filesystem-guard-blocks-a-real-write-api',
    async run() {
      const guard = createHostFilesystemGuard();
      guard.install();
      try {
        assert.throws(
          () => fs.writeFileSync('/private/tmp', 'must-not-write'),
          (error) => error.code === 'AUTOMATION_STORAGE_GUARD_ERROR'
        );
        assert.strictEqual(guard.audit().hostFilesystemStorageCalls, 1);
      } finally {
        guard.restore();
      }
    }
  },
  {
    name: 'isolation-audit-rejects-host-filesystem-use',
    async run() {
      assert.throws(
        () => assertIsolationAudit({
          hostFilesystemAudit: {
            auditPerformed: true,
            guardInstalled: true,
            hostFilesystemStorageCalls: 1
          },
          networkAudit: {
            auditPerformed: true,
            guardInstalled: true,
            realNetworkRequests: 0,
            unknownFakeRouteRequests: 0
          },
          storageAudit: {
            auditPerformed: true,
            fakeWxBrandVerifiedEnd: true,
            fakeWxBrandVerifiedStart: true,
            realWxStorageCalls: 0
          }
        }),
        (error) => error.code === 'AUTOMATION_STORAGE_GUARD_ERROR'
      );
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
