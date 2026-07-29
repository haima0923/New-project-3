#!/usr/bin/env node
const assert = require('assert');
const {
  assertActionInvocation,
  invokeResolvedPageAction,
  lookupPageAction,
  resolvePageAction,
  resolvePageSelection
} = require('../runner/page-action-registry');
const { assertRuntimeIsolation } = require('../runner/full-run-integrity');
const { buildExecutionPlan } = require('../runner/build-execution-plan');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadCorpus } = require('../runner/load-corpus');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { runCaseWorker } = require('../runner/module-isolation');
const { executeOne } = require('../runner/run-suite');

const corpus = loadCorpus();

function bundle(caseId) {
  const testCase = corpus.byId.get(caseId);
  assert(testCase, `Missing Case ${caseId}`);
  return {
    testCase,
    ...buildExecutionPlan(testCase, corpus.fixtureResolver)
  };
}

function withProductionPage(caseId, surface, run) {
  const item = bundle(caseId);
  const runtime = createCaseRuntime(item.workerSpec, { attempt: 1 });
  try {
    const driver = loadProductionPage(surface, runtime, item.workerSpec, {
      runLifecycle: false
    });
    return run(driver, item);
  } finally {
    runtime.dispose();
  }
}

function resolveReal(caseId, surface, requestedAction, inputChannel = 'TYPED_TEXT') {
  return withProductionPage(caseId, surface, (driver) => resolvePageAction({
    availablePageMethods: driver.page,
    entrySurface: surface,
    inputChannel,
    requestedAction
  }));
}

const tests = [
  {
    name: 'full-page-select-quotation-maps-to-real-handler',
    run() {
      const result = withProductionPage(
        'REC-E2E-REL-010',
        'FULL_PAGE',
        (driver) => resolvePageSelection({
          availablePageMethods: driver.page,
          capability: 'SELECT_QUOTATION',
          entrySurface: 'FULL_PAGE',
          selectionKind: 'quotationId'
        })
      );
      assert.strictEqual(result.resolvedMethodName, 'changeQuotation');
      assert.strictEqual(result.optionsKey, 'quotationOptions');
      assert.strictEqual(result.resolutionEvidence.source, 'CENTRAL_PAGE_CAPABILITY_REGISTRY');
    }
  },
  {
    name: 'home-quick-save-pending-maps-to-real-dashboard-handler',
    run() {
      const result = resolveReal(
        'REC-E2E-BASIC-019',
        'HOME_QUICK',
        'SAVE_PENDING'
      );
      assert.strictEqual(result.resolvedMethodName, 'savePendingFromConfirm');
      assert.strictEqual(result.resolutionEvidence.methodType, 'function');
    }
  },
  {
    name: 'full-page-save-pending-maps-to-real-input-handler',
    run() {
      const result = resolveReal('REC-E2E-AMB-001', 'FULL_PAGE', 'SAVE_PENDING');
      assert.strictEqual(result.resolvedMethodName, 'savePending');
      assert.strictEqual(result.resolutionEvidence.methodType, 'function');
    }
  },
  {
    name: 'home-quick-save-formal-maps-to-confirm-quick-save',
    run() {
      const result = resolveReal('REC-E2E-BASIC-001', 'HOME_QUICK', 'SAVE_FORMAL');
      assert.strictEqual(result.resolvedMethodName, 'confirmQuickSave');
    }
  },
  {
    name: 'full-page-save-formal-maps-to-save-formal',
    run() {
      const result = resolveReal('REC-E2E-FIN-001', 'FULL_PAGE', 'SAVE_FORMAL');
      assert.strictEqual(result.resolvedMethodName, 'saveFormal');
    }
  },
  {
    name: 'pending-edit-retains-full-page-save-pending-handler',
    run() {
      const result = resolveReal(
        'REC-E2E-BASIC-020',
        'FULL_PAGE',
        'SAVE_PENDING',
        'PENDING_EDIT'
      );
      assert.strictEqual(result.resolutionEvidence.editMode, 'PENDING_EDIT');
      assert.strictEqual(result.resolvedMethodName, 'savePending');
    }
  },
  {
    name: 'history-edit-update-is-registered-but-not-corpus-covered',
    run() {
      const result = resolveReal(
        'REC-E2E-FIN-001',
        'FULL_PAGE',
        'SAVE_FORMAL',
        'HISTORY_EDIT'
      );
      assert.strictEqual(result.resolutionEvidence.requestedAction, 'UPDATE');
      assert.strictEqual(result.resolvedMethodName, 'saveFormal');
      assert.strictEqual(
        corpus.activeCases.filter((item) => item.input.channel === 'HISTORY_EDIT').length,
        0
      );
    }
  },
  {
    name: 'home-page-never-falls-back-to-full-page-pending-method',
    run() {
      assert.throws(
        () => resolvePageAction({
          availablePageMethods: { savePending() {} },
          entrySurface: 'HOME_QUICK',
          inputChannel: 'TYPED_TEXT',
          requestedAction: 'SAVE_PENDING'
        }),
        (error) => (
          error.code === 'AUTOMATION_DRIVER_ERROR'
          && error.failureCode === 'PAGE_ACTION_METHOD_MISSING'
        )
      );
    }
  },
  {
    name: 'missing-action-mapping-has-no-fallback',
    run() {
      assert.throws(
        () => lookupPageAction({
          entrySurface: 'HOME_QUICK',
          inputChannel: 'TYPED_TEXT',
          requestedAction: 'DO_NOT_SAVE'
        }),
        (error) => (
          error.code === 'AUTOMATION_DRIVER_ERROR'
          && error.failureCode === 'PAGE_ACTION_MAPPING_MISSING'
        )
      );
    }
  },
  {
    name: 'invocation-evidence-names-the-method-that-really-ran',
    run() {
      let calls = 0;
      const page = {
        savePendingFromConfirm() { calls += 1; }
      };
      const resolution = resolvePageAction({
        availablePageMethods: page,
        entrySurface: 'HOME_QUICK',
        inputChannel: 'TYPED_TEXT',
        requestedAction: 'SAVE_PENDING'
      });
      const actual = invokeResolvedPageAction(page, resolution, {
        readMethodCount: () => calls
      });
      assert.strictEqual(actual.invocationEvidence.actualMethodName, 'savePendingFromConfirm');
      assert.strictEqual(actual.invocationEvidence.methodInvocationDelta, 1);
    }
  },
  {
    name: 'wrong-method-success-cannot-satisfy-invocation-evidence',
    run() {
      const resolution = {
        resolvedMethodName: 'savePendingFromConfirm',
        resolutionEvidence: {}
      };
      assert.throws(
        () => assertActionInvocation(resolution, {
          actualMethodName: 'savePending',
          attempted: true,
          completed: true,
          resolvedMethodName: 'savePending'
        }),
        (error) => error.failureCode === 'PAGE_ACTION_INVOCATION_MISMATCH'
      );
    }
  },
  {
    name: 'basic-019-old-cross-surface-mapping-is-regression-locked',
    async run() {
      const result = await executeOne(bundle('REC-E2E-BASIC-019'));
      assert.notStrictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.notStrictEqual(result.caseStatus, 'BLOCKED');
      assertRuntimeIsolation(result);
      assert(result.isolatedCommitEvidence);
      assert.strictEqual(result.isolatedCommitEvidence.pageMethod, 'savePendingFromConfirm');
      assert.strictEqual(
        result.isolatedCommitEvidence.pageActionEvidence.invocation.actualMethodName,
        'savePendingFromConfirm'
      );
      assert.strictEqual(
        result.pageEvidence.pageDriverEvidence.pageMethodCalls.savePendingFromConfirm,
        1
      );
      assert.strictEqual(
        Number(result.pageEvidence.pageDriverEvidence.pageMethodCalls.savePending || 0),
        0
      );
      assert.strictEqual(result.isolatedCommitEvidence.committed, true);
      assert.strictEqual(result.isolatedCommitEvidence.commitResult.status, 'COMMITTED');
      assert.strictEqual(
        result.pageEvidence.pageDriverEvidence.productionBusinessCalls.savePendingNote,
        1
      );
      assert.strictEqual(
        result.pageEvidence.pageDriverEvidence.productionStorageCalls.saveState,
        1
      );
      assert.strictEqual(result.businessDiff.pendingNotes.created.length, 1);
      ['customers', 'orders', 'quotations', 'receivables', 'payments', 'todos']
        .forEach((collection) => {
          const diff = result.businessDiff[collection] || {};
          assert.strictEqual((diff.created || []).length, 0);
          assert.strictEqual((diff.updated || []).length, 0);
          assert.strictEqual((diff.deleted || []).length, 0);
        });
    }
  },
  {
    name: 'basic-019-mapping-does-not-use-case-id',
    run() {
      const first = lookupPageAction({
        caseId: 'REC-E2E-BASIC-019',
        entrySurface: 'HOME_QUICK',
        inputChannel: 'TYPED_TEXT',
        requestedAction: 'SAVE_PENDING'
      });
      const second = lookupPageAction({
        caseId: 'SYNTHETIC-OTHER-ID',
        entrySurface: 'HOME_QUICK',
        inputChannel: 'TYPED_TEXT',
        requestedAction: 'SAVE_PENDING'
      });
      assert.strictEqual(first.key, second.key);
      assert.strictEqual(first.entry.methodName, second.entry.methodName);
    }
  },
  {
    name: 'driver-error-still-returns-hard-isolation-audit',
    async run() {
      const item = bundle('REC-E2E-PAGE-008');
      let error = null;
      try {
        await runCaseWorker({
          attempt: 1,
          hooks: { skipPageEditMethod: true },
          plan: item.plan,
          spec: item.workerSpec
        });
      } catch (caught) {
        error = caught;
      }
      assert(error);
      assert.strictEqual(error.code, 'AUTOMATION_DRIVER_ERROR');
      assert(error.finalAudit);
      assert.strictEqual(error.finalAudit.networkAudit.realNetworkRequests, 0);
      assert.strictEqual(error.finalAudit.networkAudit.unknownFakeRouteRequests, 0);
      assert.strictEqual(error.finalAudit.storageAudit.realWxStorageCalls, 0);
      assert.strictEqual(error.finalAudit.hostFilesystemAudit.hostFilesystemStorageCalls, 0);
      assert.strictEqual(error.finalAudit.fixtureMutationAudit.unchanged, true);
      assert.strictEqual(error.finalAudit.finalTransactionAudit.journalCount, 0);
      assert.strictEqual(error.finalAudit.finalTransactionAudit.backupCount, 0);
      assert.strictEqual(error.workerExitAudit.exitObserved, true);
    }
  }
];

async function main() {
  let passed = 0;
  for (const test of tests) {
    await test.run();
    passed += 1;
    console.log(`PASS ${test.name}`);
  }
  console.log(`Page action registry self-tests: ${passed}/${tests.length} passed`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  tests
};
