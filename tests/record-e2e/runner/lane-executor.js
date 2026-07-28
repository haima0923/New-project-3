const {
  createStateDiff,
  getStateFingerprint,
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
const { executeRestart } = require('./execute-restart');
const { executeTransactionReplay } = require('./execute-transaction-replay');

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
  const beforeCalls = Number(driver.evidence.pageMethodCalls.saveFormal || 0);
  const beforeBusiness = Number(driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
  const beforeRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const beforeState = stripRecordStorageControl(beforeRaw);
  const beforeRevision = beforeRaw && beforeRaw.__hxlRecordStorageV1
    ? Number(beforeRaw.__hxlRecordStorageV1.storageRevision || 0)
    : 0;
  driver.page.saveFormal();
  driver.page.saveFormal();
  const afterCalls = Number(driver.evidence.pageMethodCalls.saveFormal || 0);
  const afterBusiness = Number(driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
  const afterRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const afterState = stripRecordStorageControl(afterRaw);
  const afterRevision = afterRaw && afterRaw.__hxlRecordStorageV1
    ? Number(afterRaw.__hxlRecordStorageV1.storageRevision || 0)
    : 0;
  const pageTriggerDiff = createStateDiff(beforeState, afterState);
  return {
    additionalBusinessDiffEmpty: isCollectionDiffEmpty(pageTriggerDiff.businessDiff),
    isolatedCommitCount: isolated && isolated.committed ? 1 : 0,
    isolatedCommitExcludedFromPageTriggerMetrics: true,
    pageTriggerBusinessDiff: pageTriggerDiff.businessDiff,
    pageSaveHandlerAttempts: afterCalls - beforeCalls,
    productionBusinessSaveAttempts: afterBusiness - beforeBusiness,
    secondTriggerStatus: afterCalls - beforeCalls === 1
      ? 'SECOND_TRIGGER_SUPPRESSED'
      : 'SECOND_TRIGGER_REACHED_HANDLER',
    transactionCommitAttempts: afterRevision - beforeRevision,
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
  const laneResults = [{
    assertions: [],
    evidence: {
      missingCapabilities: safeClone(observation.missingCapabilities),
      productionObservation: safeClone(primaryProductionObservation)
    },
    failureCode: observation.missingCapabilities.length ? 'PAGE_CAPABILITY_MISSING' : '',
    failureStage: observation.missingCapabilities.length ? 'SURFACE_ERROR' : '',
    lane: observationLane(spec),
    status: observation.missingCapabilities.length ? 'CASE_FAIL' : 'PASS'
  }];
  if (draftObservation && draftObservation !== observation) {
    laneResults.push({
      assertions: [],
      evidence: { pageDraftDerived: true },
      failureCode: draftObservation.missingCapabilities.length ? 'PAGE_CAPABILITY_MISSING' : '',
      failureStage: draftObservation.missingCapabilities.length ? 'SURFACE_ERROR' : '',
      lane: 'PAGE_CONFIRMED_DRAFT_DERIVATION',
      status: draftObservation.missingCapabilities.length ? 'CASE_FAIL' : 'PASS'
    });
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
    laneResults.push({
      assertions: [],
      evidence: {
        pageADataPreserved: concurrent.pageADataPreserved,
        staleDetected: concurrent.staleDetected
      },
      failureCode: '',
      failureStage: '',
      lane: 'CONCURRENT_BASE_REVISION',
      status: 'PASS'
    });
  } else if (lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')) {
    if (surfaceGap) {
      laneResults.push({
        assertions: [],
        evidence: { zeroSideEffects: true },
        failureCode: 'UPSTREAM_PAGE_CAPABILITY_MISSING',
        failureStage: 'SURFACE_ERROR',
        lane: 'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
        status: 'CASE_FAIL'
      });
    } else if (spec.interaction.requestedSaveAction === 'SAVE_PENDING') {
      isolated = runActualPendingPageSave(spec, sourceObservation, runtime);
    } else {
      isolated = executeIsolatedLegacyCommit(spec, sourceDraft, options.hooks || {});
    }
    if (!surfaceGap) {
      laneResults.push({
        assertions: [],
        evidence: {
          committed: Boolean(isolated && isolated.committed),
          marker: isolated && isolated.marker,
          reason: isolated && isolated.reason || ''
        },
        failureCode: '',
        failureStage: '',
        lane: 'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
        status: 'PASS'
      });
    }
  }

  let duplicate = null;
  if (lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD')) {
    duplicate = await runDuplicateTrigger(spec, sourceObservation, isolated, runtime);
    laneResults.push({
      assertions: [],
      evidence: safeClone(duplicate),
      failureCode: '',
      failureStage: '',
      lane: 'PAGE_DUPLICATE_TRIGGER_GUARD',
      status: 'PASS'
    });
  }

  let replay = null;
  if (lanes.includes('TRANSACTION_EXACT_REPLAY')) {
    replay = isolated && isolated.committed
      ? executeTransactionReplay(isolated, spec)
      : {
        notExecuted: true,
        reason: 'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED'
      };
    laneResults.push({
      assertions: [],
      evidence: {
        replayStatus: replay.replay && replay.replay.status,
        sameIdentity: replay.sameIdentity
      },
      failureCode: replay.notExecuted ? 'UPSTREAM_ISOLATED_COMMIT_NOT_COMPLETED' : '',
      failureStage: replay.notExecuted ? 'PREFLIGHT_ERROR' : '',
      lane: 'TRANSACTION_EXACT_REPLAY',
      status: replay.notExecuted ? 'CASE_FAIL' : 'PASS'
    });
  }

  let restart = null;
  if (lanes.includes('RESTART_PERSISTENCE')) {
    if (!isolated || !isolated.gateway) {
      restart = {
        notExecuted: true,
        reason: 'UPSTREAM_ISOLATED_STORE_NOT_AVAILABLE'
      };
      laneResults.push({
        assertions: [],
        evidence: safeClone(restart),
        failureCode: 'UPSTREAM_ISOLATED_STORE_NOT_AVAILABLE',
        failureStage: 'PREFLIGHT_ERROR',
        lane: 'RESTART_PERSISTENCE',
        status: 'CASE_FAIL'
      });
    } else {
      restart = await executeRestart(
        spec,
        isolated.gateway.getEntries(),
        runtime.bootId,
        options.attempt || 1
      );
      restart.postSaveFingerprint = getStateFingerprint(isolated.stateAfter);
      restart.equalToPostSave = restart.stateFingerprint === restart.postSaveFingerprint;
      restart.additionalDiff = createStateDiff(isolated.stateAfter, restart.state);
      laneResults.push({
        assertions: [],
        evidence: {
          equalToPostSave: restart.equalToPostSave,
          newRuntimeInstance: restart.newRuntimeInstance
        },
        failureCode: '',
        failureStage: '',
        lane: 'RESTART_PERSISTENCE',
        status: 'PASS'
      });
    }
  }

  const audit = runtime.audit();
  if (audit.networkAudit.realNetworkRequests !== 0 || audit.networkAudit.guardErrors !== 0) {
    throw Object.assign(new Error('Network Guard detected a forbidden request'), {
      code: 'AUTOMATION_NETWORK_GUARD_ERROR'
    });
  }
  if (audit.storageAudit.realWxStorageCalls !== 0) {
    throw Object.assign(new Error('Runner touched real or host wx Storage'), {
      code: 'AUTOMATION_STORAGE_GUARD_ERROR'
    });
  }
  const isolatedStorageAudit = isolated && isolated.storageAudit || {};
  if (audit.storageAudit.journalPresent
    || audit.storageAudit.backupPresent
    || isolatedStorageAudit.journalPresent
    || isolatedStorageAudit.backupPresent) {
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
    pageDerivationEvidence: draftPublic,
    pageEvidence: observationPublic,
    preflightEvidence: {
      blockingCodes: primaryProductionObservation.businessBlockingCodes,
      domainCanSaveFormal: primaryProductionObservation.domainCanSaveFormal,
      domainCanSavePending: primaryProductionObservation.domainCanSavePending
    },
    productionObservation: primaryProductionObservation,
    restartEvidence: restart,
    routeEvidence: { actualRoute: observation.route },
    storageAudit: audit.storageAudit,
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
