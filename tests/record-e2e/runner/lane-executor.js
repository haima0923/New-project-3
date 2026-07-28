const {
  createStateDiff,
  isCollectionDiffEmpty,
  safeClone
} = require('../../../utils/record-state-diff');
const { stripRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const { executeConcurrentBase } = require('./execute-concurrent-base');
const { executeHeadlessObservation } = require('./execute-headless-observation');
const {
  evaluateDraftPreflight,
  executeIsolatedLegacyCommit,
  prepareLegacyDraft
} = require('./execute-isolated-legacy-commit');
const { executePageObservation } = require('./execute-page-observation');
const { executeTransactionReplay } = require('./execute-transaction-replay');
const { executedLane, preconditionFailedLane } = require('./lane-state');
const { assertIsolationAudit } = require('./assert-isolation-audit');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');

const PROVIDER_BLOCK = 'UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION';

function blockingCodes(preflight) {
  return (preflight && preflight.blockingIssues || []).map((item) => item.code);
}

function productionEligibility(route, codes) {
  if (route === 'NO_RECORD') return 'NO_RECORD';
  if (codes.length === 1 && codes[0] === PROVIDER_BLOCK) return 'BLOCKED_NON_REAL_PROVIDER';
  if (codes.length) return 'BLOCKED_BUSINESS_SAFETY';
  return 'ELIGIBLE_LOCAL';
}

function observationLane(spec) {
  return spec.execution.lanes.includes('HEADLESS_PRODUCTION_OBSERVATION')
    ? 'HEADLESS_PRODUCTION_OBSERVATION'
    : 'PAGE_PRODUCTION_OBSERVATION';
}

function deriveProductionObservation(spec, observation) {
  const draft = observation.afterEdits.parseResult || {};
  const preflight = evaluateDraftPreflight(draft, spec.initialState.state);
  const codes = blockingCodes(preflight);
  const prepared = prepareLegacyDraft(draft, spec.initialState.state, spec.ai.profile);
  const businessPreflight = prepared.executionPreflight || preflight;
  const businessCodes = blockingCodes(businessPreflight)
    .filter((code) => code !== PROVIDER_BLOCK);
  const isHeadless = observation.afterEdits.surface === 'HEADLESS';
  const capabilitiesSatisfied = observation.missingCapabilities.length === 0;
  const pageFormalSaveAllowed = isHeadless
    ? null
    : (
      observation.afterEdits.effectiveCanSaveFormal === true
      && capabilitiesSatisfied
    );
  return {
    blockingCodes: codes,
    businessBlockingCodes: businessCodes,
    domainCanSaveFormal: businessPreflight.domainCanSaveFormal === true,
    domainCanSavePending: businessPreflight.domainCanSavePending === true,
    pageFormalSaveAllowed,
    productionEligibility: productionEligibility(observation.route, codes),
    providerClassification: spec.ai.profile === 'LOCAL_ONLY'
      ? 'TEST_LOCAL_ONLY'
      : (spec.ai.profile === 'REPLAY' ? 'NON_REAL_REPLAY' : 'NON_REAL_FAKE'),
    requiredCapabilitiesSatisfied: capabilitiesSatisfied
  };
}

function publicObservation(observation) {
  return {
    actualInput: observation.actualInput,
    afterEdits: observation.afterEdits,
    beforeEdits: observation.beforeEdits,
    inputBefore: observation.inputBefore,
    interaction: observation.interaction,
    pageEditConsistency: observation.pageEditConsistency || null,
    missingCapabilities: observation.missingCapabilities,
    pageDriverEvidence: observation.driver && observation.driver.evidence || null,
    route: observation.route,
    transportIdentityAdaptation: observation.transportIdentityAdaptation || null
  };
}

function runActualPendingPageSave(spec, observation, runtime) {
  const driver = observation.driver;
  if (!driver || typeof driver.page.savePending !== 'function') {
    throw Object.assign(new Error('Production pending-save page method missing'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const before = safeClone(spec.initialState.state);
  driver.page.savePending();
  const raw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || before;
  const after = stripRecordStorageControl(raw);
  const storage = require('../../../utils/storage');
  const infrastructure = storage.getRecordStorageInfrastructureStatus();
  return {
    commitResult: infrastructure.lastWriteResult,
    committed: Boolean(
      infrastructure.lastWriteResult && infrastructure.lastWriteResult.commitSucceeded
    ),
    diff: createStateDiff(before, after),
    marker: 'TEST_ONLY_ISOLATED_COMMIT',
    pageMethod: 'savePending',
    prepared: {
      allowed: true,
      source: 'PAGE_DERIVED_CONFIRMED_DRAFT'
    },
    stateAfter: safeClone(after),
    stateBefore: before,
    storageAudit: {
      entries: runtime.fakeWx.getEntries(),
      revision: raw && raw.__hxlRecordStorageV1
        ? Number(raw.__hxlRecordStorageV1.storageRevision || 0)
        : 0,
      transactionStatus: infrastructure.lastWriteResult
        && infrastructure.lastWriteResult.status || ''
    }
  };
}

async function runDuplicateTrigger(spec, observation, isolated, runtime) {
  const driver = observation.driver;
  if (!driver || typeof driver.page.saveFormal !== 'function') {
    throw Object.assign(new Error('Production formal-save page method missing'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const prepared = prepareLegacyDraft(
    observation.afterEdits.parseResult || {},
    spec.initialState.state,
    spec.ai.profile
  );
  if (!prepared.allowed || !prepared.identityBypass) {
    throw Object.assign(new Error('Duplicate trigger requires safe test-only provider identity seam'), {
      code: 'LANE_EXECUTION_EVIDENCE_MISSING'
    });
  }
  driver.page.setData({
    parseResult: safeClone(prepared.draft),
    fields: safeClone(prepared.draft.fields || {}),
    intent: prepared.draft.intent
  });
  const beforeCalls = Number(driver.evidence.pageMethodCalls.saveFormal || 0);
  const beforeEligibleCalls = Number(driver.evidence.pagePrimaryActionCalls.saveFormal || 0);
  const beforeBusiness = Number(driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
  const beforeStorage = Number(driver.evidence.productionStorageCalls.saveState || 0);
  const beforeStorageEvents = runtime.fakeWx.audit().storageEvents.length;
  const beforeRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const beforeState = stripRecordStorageControl(beforeRaw);
  const beforeRevision = beforeRaw && beforeRaw.__hxlRecordStorageV1
    ? Number(beforeRaw.__hxlRecordStorageV1.storageRevision || 0)
    : 0;
  const beforeReceiptCount = beforeRaw && beforeRaw.__hxlRecordStorageV1
    ? (beforeRaw.__hxlRecordStorageV1.recentReceipts || []).length
    : 0;
  driver.page.saveFormal();
  const afterFirstRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const afterFirstState = stripRecordStorageControl(afterFirstRaw);
  driver.page.saveFormal();
  const afterCalls = Number(driver.evidence.pageMethodCalls.saveFormal || 0);
  const afterEligibleCalls = Number(driver.evidence.pagePrimaryActionCalls.saveFormal || 0);
  const afterBusiness = Number(driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
  const afterStorage = Number(driver.evidence.productionStorageCalls.saveState || 0);
  const afterStorageAudit = runtime.fakeWx.audit();
  const transactionEvents = afterStorageAudit.storageEvents.slice(beforeStorageEvents);
  const afterRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const afterState = stripRecordStorageControl(afterRaw);
  const afterRevision = afterRaw && afterRaw.__hxlRecordStorageV1
    ? Number(afterRaw.__hxlRecordStorageV1.storageRevision || 0)
    : 0;
  const afterReceiptCount = afterRaw && afterRaw.__hxlRecordStorageV1
    ? (afterRaw.__hxlRecordStorageV1.recentReceipts || []).length
    : 0;
  const pageTriggerDiff = createStateDiff(beforeState, afterState);
  const transactionBeginCount = transactionEvents.filter((event) => (
    event.operation === 'SET' && /__txn_journal_v1$/.test(event.key)
  )).length;
  const additionalBusinessDiff = createStateDiff(afterFirstState, afterState);
  const financialRecordCount = (afterState.paymentRecords || []).length
    - (beforeState.paymentRecords || []).length;
  return {
    additionalBusinessDiff: additionalBusinessDiff.businessDiff,
    additionalBusinessDiffEmpty: isCollectionDiffEmpty(additionalBusinessDiff.businessDiff),
    isolatedCommitCount: isolated && isolated.committed ? 1 : 0,
    isolatedCommitExcludedFromPageTriggerMetrics: true,
    pageTriggerBusinessDiff: pageTriggerDiff.businessDiff,
    committedReceiptCount: afterReceiptCount - beforeReceiptCount,
    completionEvidencePresent: [
      afterCalls - beforeCalls,
      afterEligibleCalls - beforeEligibleCalls,
      afterBusiness - beforeBusiness,
      afterStorage - beforeStorage,
      transactionBeginCount,
      afterReceiptCount - beforeReceiptCount,
      financialRecordCount
    ].every(Number.isFinite),
    financialRecordCount,
    legacyBusinessAttemptCount: afterBusiness - beforeBusiness,
    pageHandlerInvocationCount: afterCalls - beforeCalls,
    pageSaveHandlerAttempts: afterEligibleCalls - beforeEligibleCalls,
    productionBusinessSaveAttempts: afterBusiness - beforeBusiness,
    secondTriggerStatus: afterEligibleCalls - beforeEligibleCalls === 1
      ? 'SECOND_TRIGGER_SUPPRESSED'
      : 'SECOND_TRIGGER_REACHED_HANDLER',
    storageSaveAttemptCount: afterStorage - beforeStorage,
    testOnlyIdentitySeam: {
      businessHashEqual: prepared.businessHashBefore === prepared.businessHashAfter,
      marker: prepared.identityBypass.marker,
      providerWasNeverSetToReal: prepared.identityBypass.providerWasNeverSetToReal
    },
    transactionBeginCount: afterStorage - beforeStorage,
    transactionCommitAttempts: afterStorage - beforeStorage,
    transactionJournalWriteCount: transactionBeginCount,
    revisionDelta: afterRevision - beforeRevision,
    transactionExactReplay: false,
    triggerAttempts: 2
  };
}

function findConcurrentInput(spec) {
  const step = (spec.interaction.sequence || []).find((item) => (
    item && item.actor === 'PAGE_B' && item.input && item.input.originalText
  ));
  if (!step) {
    throw Object.assign(new Error('Concurrent lane has no PAGE_B input'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  return String(step.input.originalText);
}

async function executeLanes(runtime, spec, plan, options = {}) {
  const lanes = spec.execution.lanes;
  let observation;
  let draftObservation;
  if (lanes.includes('HEADLESS_PRODUCTION_OBSERVATION')) {
    observation = await executeHeadlessObservation(spec);
    if (lanes.includes('PAGE_CONFIRMED_DRAFT_DERIVATION')) {
      draftObservation = await executePageObservation(runtime, spec, {
        hooks: options.hooks,
        surface: spec.execution.draftSourceSurface || 'FULL_PAGE'
      });
    }
  } else {
    observation = await executePageObservation(runtime, spec, {
      hooks: options.hooks,
      surface: spec.execution.observationSurface || spec.input.entrySurface
    });
    draftObservation = observation;
  }
  const primaryProductionObservation = deriveProductionObservation(spec, observation);
  const driverFailures = []
    .concat(observation.interaction && observation.interaction.failures || [])
    .concat(draftObservation && draftObservation !== observation
      ? (draftObservation.interaction && draftObservation.interaction.failures || [])
      : []);
  const driverBypass = driverFailures.find((item) => item.reason === 'DRIVER_METHOD_SKIPPED');
  if (driverBypass) {
    throw Object.assign(new Error(`Runner skipped an existing page edit method: ${driverBypass.field}`), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const observationPublic = publicObservation(observation);
  const draftPublic = draftObservation && draftObservation !== observation
    ? publicObservation(draftObservation)
    : null;
  const laneResults = [executedLane(observationLane(spec), {
      missingCapabilities: safeClone(observation.missingCapabilities),
      productionObservation: safeClone(primaryProductionObservation)
    }, observation.missingCapabilities.length ? {
      failureCode: 'REQUIRED_PAGE_CAPABILITY_MISSING',
      failureStage: 'SURFACE_ERROR',
      status: 'CASE_FAIL'
    } : {})];
  if (draftObservation && draftObservation !== observation) {
    laneResults.push(executedLane(
      'PAGE_CONFIRMED_DRAFT_DERIVATION',
      { pageDraftDerived: true },
      draftObservation.missingCapabilities.length ? {
        failureCode: 'REQUIRED_PAGE_CAPABILITY_MISSING',
        failureStage: 'SURFACE_ERROR',
        status: 'CASE_FAIL'
      } : {}
    ));
  }

  let isolated = null;
  let concurrent = null;
  const sourceObservation = draftObservation || observation;
  const sourceDraft = sourceObservation.afterEdits.parseResult || {};
  const surfaceGap = sourceObservation.missingCapabilities.length > 0;
  if (lanes.includes('CONCURRENT_BASE_REVISION') && !surfaceGap) {
    const secondSpec = safeClone(spec);
    secondSpec.input.originalText = findConcurrentInput(spec);
    secondSpec.input.clipboardText = undefined;
    secondSpec.input.voiceTranscript = undefined;
    secondSpec.interaction.userEdits = [];
    secondSpec.interaction.userSelections = [];
    secondSpec.interaction.requiredCapabilities = [];
    const secondObservation = await executePageObservation(runtime, secondSpec, {
      hooks: options.hooks,
      surface: spec.execution.draftSourceSurface || 'FULL_PAGE'
    });
    concurrent = executeConcurrentBase(
      spec,
      sourceDraft,
      secondObservation.afterEdits.parseResult
    );
    isolated = {
      businessResult: concurrent.businessA,
      commitResult: concurrent.commitA,
      committed: concurrent.committedA,
      diff: concurrent.diff,
      gateway: concurrent.gateway,
      marker: 'TEST_ONLY_ISOLATED_COMMIT',
      prepared: concurrent.preparedA,
      stateAfter: concurrent.stateAfter,
      stateBefore: concurrent.stateBefore,
      storageAudit: concurrent.storageAudit
    };
    laneResults.push(concurrent.committedA
      ? executedLane('CONCURRENT_BASE_REVISION', {
        pageADataPreserved: concurrent.pageADataPreserved,
        staleDetected: concurrent.staleDetected,
        secondCommitAttempted: concurrent.secondCommitAttempted
      })
      : preconditionFailedLane(
        'CONCURRENT_BASE_REVISION',
        {
          firstCommitSucceeded: false,
          reason: concurrent.reason || 'FIRST_COMMIT_NOT_COMPLETED',
          secondCommitAttempted: concurrent.secondCommitAttempted === true
        },
        'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED',
        'PREFLIGHT_ERROR'
      ));
  } else if (lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')) {
    if (surfaceGap) {
      laneResults.push(preconditionFailedLane(
        'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
        { zeroSideEffects: true },
        'UPSTREAM_PAGE_CAPABILITY_MISSING',
        'SURFACE_ERROR'
      ));
    } else if (spec.interaction.requestedSaveAction === 'SAVE_PENDING') {
      isolated = runActualPendingPageSave(spec, sourceObservation, runtime);
    } else {
      isolated = executeIsolatedLegacyCommit(spec, sourceDraft, options.hooks || {});
    }
    if (!surfaceGap) {
      laneResults.push(executedLane('TEST_ONLY_ISOLATED_LEGACY_COMMIT', {
          committed: Boolean(isolated && isolated.committed),
          marker: isolated && isolated.marker,
          reason: isolated && isolated.reason || ''
        }));
    }
  }

  let duplicate = null;
  if (lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD')) {
    duplicate = await runDuplicateTrigger(spec, sourceObservation, isolated, runtime);
    laneResults.push(executedLane(
      'PAGE_DUPLICATE_TRIGGER_GUARD',
      safeClone(duplicate),
      {
        primaryActionSucceeded: duplicate.completionEvidencePresent === true,
        completionEvidencePresent: duplicate.completionEvidencePresent === true
      }
    ));
  }

  let replay = null;
  if (lanes.includes('TRANSACTION_EXACT_REPLAY')) {
    replay = isolated && isolated.committed
      ? executeTransactionReplay(isolated, spec)
      : {
        notExecuted: true,
        reason: 'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED'
      };
    if (!replay.notExecuted) {
      replay.pageSaveAttempts = (
        spec.interaction.requestedSaveAction === 'SAVE_FORMAL'
        && isolated.committed
      ) ? 1 : 0;
      replay.replayPageSaveAttempts = 0;
    }
    laneResults.push(replay.notExecuted
      ? preconditionFailedLane(
        'TRANSACTION_EXACT_REPLAY',
        { reason: replay.reason },
        'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED',
        'PREFLIGHT_ERROR'
      )
      : executedLane('TRANSACTION_EXACT_REPLAY', {
        replayStatus: replay.replay && replay.replay.status,
        sameIdentity: replay.sameIdentity
      }));
  }

  let restart = null;
  let restartRequest = null;
  if (lanes.includes('RESTART_PERSISTENCE')) {
    if (!isolated || !isolated.gateway || !isolated.committed
      || !isolated.commitResult || isolated.commitResult.status !== 'COMMITTED') {
      restart = {
        notExecuted: true,
        reason: 'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED'
      };
      laneResults.push(preconditionFailedLane(
        'RESTART_PERSISTENCE',
        safeClone(restart),
        'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED',
        'PREFLIGHT_ERROR'
      ));
    } else {
      restartRequest = {
        entries: isolated.gateway.getEntries(),
        postSaveState: safeClone(isolated.stateAfter),
        priorCommit: {
          receipt: safeClone(isolated.commitResult.receipt),
          status: isolated.commitResult.status,
          revision: isolated.storageAudit.revision
        },
        primaryBootId: runtime.bootId,
        primaryPid: process.pid
      };
      laneResults.push(Object.assign(
        preconditionFailedLane(
          'RESTART_PERSISTENCE',
          { awaitingParentWorkerExit: true },
          'RESTART_PENDING_PARENT_EXECUTION',
          'RESTART_PERSISTENCE_ERROR'
        ),
        {
          preconditionsPassed: true,
          status: 'PLANNED'
        }
      ));
    }
  }

  const audit = runtime.audit();
  if (options.hooks && options.hooks.skipNetworkAudit) delete audit.networkAudit;
  if (options.hooks && options.hooks.skipStorageAudit) delete audit.storageAudit;
  assertIsolationAudit(audit);
  if (options.hooks && options.hooks.leaveJournalMaterial
    && isolated && isolated.gateway) {
    isolated.gateway.mutateEntry(RECORD_STORAGE_JOURNAL_KEY, {
      caseId: spec.caseId,
      marker: 'SELF_TEST_ORPHAN_JOURNAL'
    });
  }
  const finalGatewayEntries = isolated && isolated.gateway
    ? isolated.gateway.getEntries()
    : {};
  const finalTransactionAudit = {
    backupCount: Object.prototype.hasOwnProperty.call(
      finalGatewayEntries,
      RECORD_STORAGE_BACKUP_KEY
    ) ? 1 : 0,
    journalCount: Object.prototype.hasOwnProperty.call(
      finalGatewayEntries,
      RECORD_STORAGE_JOURNAL_KEY
    ) ? 1 : 0
  };
  if (audit.storageAudit.journalPresent
    || audit.storageAudit.backupPresent
    || finalTransactionAudit.journalCount
    || finalTransactionAudit.backupCount) {
    throw Object.assign(new Error('Runner cleanup left Journal or Backup material behind'), {
      code: 'CLEANUP_ERROR'
    });
  }
  const stateDiff = isolated && isolated.diff
    ? isolated.diff
    : createStateDiff(spec.initialState.state, spec.initialState.state);
  return {
    actualInput: observationPublic.actualInput,
    aiEvidence: {
      profile: spec.ai.profile,
      fixtureKind: spec.aiFixture && spec.aiFixture.kind || null,
      transportIdentityAdaptation: observationPublic.transportIdentityAdaptation
        || draftPublic && draftPublic.transportIdentityAdaptation || null
    },
    businessDiff: stateDiff.businessDiff,
    concurrentEvidence: concurrent,
    fullDiff: stateDiff.fullDiff,
    inputEvidence: observationPublic.actualInput,
    interactionEvidence: sourceObservation.interaction,
    isolatedCommitEvidence: isolated,
    laneResults,
    networkAudit: audit.networkAudit,
    hostFilesystemAudit: audit.hostFilesystemAudit,
    pageDerivationEvidence: draftPublic,
    pageEvidence: observationPublic,
    preflightEvidence: {
      blockingCodes: primaryProductionObservation.businessBlockingCodes,
      domainCanSaveFormal: primaryProductionObservation.domainCanSaveFormal,
      domainCanSavePending: primaryProductionObservation.domainCanSavePending
    },
    productionObservation: primaryProductionObservation,
    restartEvidence: restart,
    restartRequest,
    routeEvidence: { actualRoute: observation.route },
    storageAudit: audit.storageAudit,
    finalTransactionAudit,
    surfaceEvidence: {
      availableCapabilities: observation.driver
        ? observation.driver.availableCapabilities
        : {},
      missingCapabilities: observation.missingCapabilities
    },
    transactionReplayEvidence: replay,
    duplicateTriggerEvidence: duplicate,
    voiceAudit: audit.voiceAudit
  };
}

module.exports = {
  deriveProductionObservation,
  executeLanes,
  productionEligibility
};
