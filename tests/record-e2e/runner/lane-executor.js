const {
  createStateDiff,
  isCollectionDiffEmpty,
  safeClone,
  stableHash
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
const {
  executeRelationReferenceTamper
} = require('./execute-relation-reference-tamper');
const { executeTransactionReplay } = require('./execute-transaction-replay');
const { executedLane, preconditionFailedLane } = require('./lane-state');
const {
  invokeResolvedPageAction,
  resolvePageAction
} = require('./page-action-registry');
const { assertIsolationAudit } = require('./assert-isolation-audit');
const {
  actualOutcome,
  canonicalSemanticResult,
  compactRelationReferences,
  proposalFromDraft
} = require('./observation-semantics');
const {
  parserInstrumentationAudit
} = require('./observed-ai-parser');
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
    requiredCapabilitiesSatisfied: capabilitiesSatisfied,
    businessType: businessPreflight.businessType,
    operation: businessPreflight.operation,
    preflightFingerprint: businessPreflight.preflightFingerprint,
    preflightInputRelationReferences: compactRelationReferences(
      draft.relation_references
    ),
    requiredSelections: safeClone(businessPreflight.requiredSelections || [])
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
    parserObservation: safeClone(
      observation.parserObservation || (
        observation.driver
        && observation.driver.evidence.parserObservation
      ) || null
    ),
    productionPathObservation: safeClone(
      observation.productionPathObservation || (
        observation.driver
        && observation.driver.evidence.productionPathObservation
      ) || null
    ),
    route: observation.route,
    transportIdentityAdaptation: observation.transportIdentityAdaptation || null
  };
}

function buildRouteEvidence(observation, rawParser) {
  const parseResult = observation && observation.afterEdits
    && observation.afterEdits.parseResult || {};
  const route = parseResult.parse_route || {};
  const aiFallback = parseResult.ai_fallback || {};
  const hybridInvocations = rawParser && rawParser.hybridInvocations || [];
  const parserCollectionCompleted = Boolean(
    rawParser
    && rawParser.collectionCompleted === true
    && rawParser.validationCompleted === true
  );
  return {
    actualRoute: observation && observation.route || route.decision || null,
    productionRoute: String(route.decision || '').toUpperCase() || null,
    semanticRoute: String(route.semantic_decision || route.decision || '').toUpperCase() || null,
    noRecordEligible: Object.prototype.hasOwnProperty.call(
      route,
      'no_record_eligible'
    ) ? route.no_record_eligible === true : null,
    noRecordEligibilityReasonCodes: safeClone(
      route.no_record_eligibility_reason_codes || []
    ),
    noRecordEligibilityExclusions: safeClone(
      route.no_record_eligibility_exclusions || []
    ),
    businessEvidenceCount: Number(route.business_evidence_count || 0),
    structuredBusinessFieldCount: Number(route.structured_business_field_count || 0),
    relationEvidenceCount: Number(route.relation_evidence_count || 0),
    asyncWorkCompleted: parserCollectionCompleted,
    safeLocalReceivableEligible: Object.prototype.hasOwnProperty.call(
      route,
      'safe_local_receivable_eligible'
    ) ? route.safe_local_receivable_eligible === true : null,
    safeLocalReceivableReasonCodes: safeClone(
      route.safe_local_receivable_reason_codes || []
    ),
    receivableRiskExclusions: safeClone(
      route.receivable_risk_exclusions || []
    ),
    AIRequestCount: aiFallback.attempted === true ? 1 : 0,
    deepReviewAvailable: route.deep_review_available === true,
    deepReviewRequested: hybridInvocations.some((item) => (
      item && item.phase === 'DEEP_REVIEW'
    )),
    evidenceSource: 'ACTUAL_PARSE_ROUTE'
  };
}

function buildNoRecordEvidence({
  businessDiff,
  isolated,
  outcome,
  rawParser,
  requestedSaveAction,
  routeEvidence
} = {}) {
  const pendingCreated = businessDiff && businessDiff.pendingNotes
    && businessDiff.pendingNotes.created || [];
  const committed = isolated && isolated.committed === true;
  return {
    AIRequestCount: routeEvidence.AIRequestCount,
    actualRoute: routeEvidence.actualRoute,
    asyncWorkCompleted: routeEvidence.asyncWorkCompleted,
    businessEvidenceCount: routeEvidence.businessEvidenceCount,
    businessStateDiffIsZero: isCollectionDiffEmpty(businessDiff || {}),
    formalSaveAttemptCount: requestedSaveAction === 'SAVE_FORMAL' ? 1 : 0,
    formalSaveSucceeded: outcome.formalSaveSucceeded === true,
    noRecordEligible: routeEvidence.noRecordEligible,
    noRecordEligibilityExclusions: safeClone(
      routeEvidence.noRecordEligibilityExclusions || []
    ),
    noRecordEligibilityReasonCodes: safeClone(
      routeEvidence.noRecordEligibilityReasonCodes || []
    ),
    outcomeDisposition: outcome.disposition,
    pendingSaveAttemptCount: requestedSaveAction === 'SAVE_PENDING' ? 1 : 0,
    pendingSaveSucceeded: outcome.pendingSaveSucceeded === true,
    pendingSavedCount: pendingCreated.length,
    persistedRecordType: outcome.persistedRecordType,
    productionRoute: routeEvidence.productionRoute,
    relationEvidenceCount: routeEvidence.relationEvidenceCount,
    semanticRoute: routeEvidence.semanticRoute,
    storageCommitOccurred: committed,
    structuredBusinessFieldCount: routeEvidence.structuredBusinessFieldCount
  };
}

function buildReceivableOrderGateEvidence(observation, isolated) {
  const before = observation && observation.beforeEdits || {};
  const after = observation && observation.afterEdits || {};
  const selection = observation && observation.interaction
    && observation.interaction.evidence
    && (observation.interaction.evidence.selections || [])
      .find((item) => item && item.kind === 'orderId') || null;
  return {
    methodName: selection && selection.method || '',
    methodInvocationDelta: selection && selection.methodInvocationDelta || 0,
    postSelectionPreflight: safeClone(
      selection && selection.postSelectionPreflight || {
        blockingCodes: after.blockingCodes || [],
        domainCanSaveFormal: after.domainCanSaveFormal === true,
        effectiveCanSaveFormal: after.effectiveCanSaveFormal === true,
        fingerprint: after.preflightFingerprint || '',
        orderSelectionConfirmed: after.orderSelectionConfirmed === true,
        requiredSelections: after.requiredSelections || [],
        selectedOrderId: after.selectedOrderId || ''
      }
    ),
    preSelectionPreflight: safeClone(
      selection && selection.preSelectionPreflight || {
        blockingCodes: before.blockingCodes || [],
        domainCanSaveFormal: before.domainCanSaveFormal === true,
        effectiveCanSaveFormal: before.effectiveCanSaveFormal === true,
        fingerprint: before.preflightFingerprint || '',
        orderSelectionConfirmed: before.orderSelectionConfirmed === true,
        requiredSelections: before.requiredSelections || [],
        selectedOrderId: before.selectedOrderId || ''
      }
    ),
    savePreflightEvidence: safeClone(
      isolated && isolated.savePreflightEvidence || null
    )
  };
}

function buildRelationEvidence(rawParser, confirmationDraft, productionObservation) {
  const hybridInvocations = rawParser && rawParser.hybridInvocations || [];
  const rawStages = hybridInvocations.flatMap((hybrid) => (
    (hybrid.rawInvocations || []).map((raw) => ({
      hybridInvocationId: hybrid.hybridInvocationId,
      rawInvocationId: raw.rawInvocationId,
      relationReferences: compactRelationReferences(
        raw.resultSummary && raw.resultSummary.relationReferences
      )
    }))
  )).filter((stage) => stage.relationReferences.order);
  const hybridStages = hybridInvocations.map((hybrid) => ({
    hybridInvocationId: hybrid.hybridInvocationId,
    phase: hybrid.phase,
    relationReferences: compactRelationReferences(
      hybrid.resultSummary && hybrid.resultSummary.relationReferences
    )
  })).filter((stage) => stage.relationReferences.order);
  const confirmationReferences = compactRelationReferences(
    confirmationDraft && confirmationDraft.relation_references
  );
  const preflightInputReferences = compactRelationReferences(
    productionObservation && productionObservation.preflightInputRelationReferences
  );
  const order = preflightInputReferences.order
    || confirmationReferences.order
    || hybridStages[0] && hybridStages[0].relationReferences.order
    || rawStages[0] && rawStages[0].relationReferences.order
    || null;
  const allReferences = []
    .concat(rawStages.map((stage) => stage.relationReferences.order))
    .concat(hybridStages.map((stage) => stage.relationReferences.order))
    .concat(confirmationReferences.order || [])
    .concat(preflightInputReferences.order || []);
  if (order) {
    const stageMissing = rawStages.length === 0
      || hybridStages.length !== hybridInvocations.length
      || !confirmationReferences.order
      || !preflightInputReferences.order;
    if (stageMissing) {
      throw Object.assign(new Error(
        'Structured order relation evidence did not reach every production stage'
      ), {
        code: 'RELATION_EVIDENCE_PROPAGATION_MISSING'
      });
    }
    const expectedFingerprint = stableHash(order, 'relation-evidence-propagation-v1');
    const mismatch = allReferences.some((reference) => (
      stableHash(reference, 'relation-evidence-propagation-v1') !== expectedFingerprint
    ));
    if (mismatch) {
      throw Object.assign(new Error(
        'Structured order relation evidence changed between production stages'
      ), {
        code: 'RELATION_EVIDENCE_PROPAGATION_MISMATCH'
      });
    }
  }
  const propagationStages = [];
  if (rawStages.length) propagationStages.push('RAW_PARSER');
  if (hybridStages.length) propagationStages.push('HYBRID_RESULT');
  if (confirmationReferences.order) propagationStages.push('CONFIRMATION_DRAFT');
  if (preflightInputReferences.order) propagationStages.push('PREFLIGHT_INPUT');
  return {
    relationEvidenceSource: order && order.evidenceSource || null,
    relationEvidenceKind: order && order.kind || null,
    relationEvidenceSourceSpan: order ? safeClone(order.sourceSpan) : null,
    relationEvidenceRequiresResolution: order
      ? order.requiresResolution === true
      : null,
    relationEvidenceResolvedId: order ? order.resolvedEntityId : null,
    relationEvidencePropagationStages: propagationStages,
    stages: {
      rawParser: rawStages,
      hybridResult: hybridStages,
      confirmationDraft: confirmationReferences,
      preflightInput: preflightInputReferences
    }
  };
}

function countValues(value = {}) {
  return Object.values(value).reduce((sum, item) => (
    sum + (Number.isFinite(Number(item)) ? Number(item) : 0)
  ), 0);
}

function captureRelationTamperActivity(runtime, observation) {
  const driverEvidence = observation && observation.driver
    && observation.driver.evidence || {};
  const rawState = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || {};
  const fakeWxAudit = runtime.fakeWx.audit();
  const storage = require('../../../utils/storage');
  const infrastructure = storage.getRecordStorageInfrastructureStatus();
  return {
    businessSaveCalls: countValues(driverEvidence.productionBusinessCalls),
    pageMethodCalls: countValues(driverEvidence.pageMethodCalls),
    pagePrimaryActionCalls: countValues(
      driverEvidence.pagePrimaryActionCalls
        && driverEvidence.pagePrimaryActionCalls.byMethod
    ),
    pageQuotationSelectionCalls: Number(
      driverEvidence.pageMethodCalls
        && driverEvidence.pageMethodCalls.changeQuotation || 0
    ),
    instrumentationPresent: Boolean(
      driverEvidence.pageMethodCalls
      && driverEvidence.pagePrimaryActionCalls
      && driverEvidence.productionBusinessCalls
      && driverEvidence.productionStorageCalls
      && fakeWxAudit.auditPerformed === true
      && Array.isArray(fakeWxAudit.storageEvents)
      && Array.isArray(infrastructure.monitorEvents)
    ),
    rawState: safeClone(rawState),
    state: stripRecordStorageControl(rawState),
    storageEvents: safeClone(fakeWxAudit.storageEvents || []),
    storageSaveCalls: countValues(driverEvidence.productionStorageCalls),
    transactionDecisionCount: (infrastructure.monitorEvents || [])
      .filter((event) => event.type === 'LEGACY_WRITE_DECISION').length
  };
}

function completeRelationTamperActivity(runtime, observation, before, relationTamper, direct) {
  const after = captureRelationTamperActivity(runtime, observation);
  const diff = createStateDiff(before.state, after.state);
  const newStorageEvents = after.storageEvents.slice(before.storageEvents.length);
  const storageWriteCount = newStorageEvents.filter((event) => (
    event.operation === 'SET' || event.operation === 'REMOVE'
  )).length;
  const pageMethodInvocationCount = after.pageMethodCalls - before.pageMethodCalls;
  const pagePrimaryActionCount = after.pagePrimaryActionCalls - before.pagePrimaryActionCalls;
  const pageSelectionMethodInvocationCount = after.pageQuotationSelectionCalls
    - before.pageQuotationSelectionCalls;
  const businessSaveAttemptCount = after.businessSaveCalls - before.businessSaveCalls
    + direct.businessSaveCalls;
  const storageSaveAttemptCount = after.storageSaveCalls - before.storageSaveCalls
    + direct.storageSaveCalls;
  const transactionBeginCount = after.transactionDecisionCount
    - before.transactionDecisionCount;
  const saveAttempted = pagePrimaryActionCount > 0
    || businessSaveAttemptCount > 0
    || storageSaveAttemptCount > 0
    || transactionBeginCount > 0
    || storageWriteCount > 0;
  return Object.assign(relationTamper, {
    activityAudit: {
      auditPerformed: true,
      businessSaveAttemptCount,
      pageMethodInvocationCount,
      pagePrimaryActionCount,
      pageSelectionMethodInvocationCount,
      instrumentationPresent: before.instrumentationPresent
        && after.instrumentationPresent
        && direct.instrumentationPresent !== false,
      storageSaveAttemptCount,
      storageWriteCount,
      transactionBeginCount
    },
    businessDiff: diff.businessDiff,
    businessSaveAttemptCount,
    businessSaveCalled: businessSaveAttemptCount > 0,
    completionEvidencePresent: Boolean(
      relationTamper.preflightAfterInjection
      && relationTamper.preflightAfterInjection.preflightFingerprint
    ),
    fullDiff: diff.fullDiff,
    pageMethodInvocationCount,
    pageSelectionMethodCalled: pageSelectionMethodInvocationCount > 0,
    saveAttempted,
    stateFingerprintAfter: stableHash(after.state, 'relation-tamper-state-v1'),
    stateFingerprintBefore: stableHash(before.state, 'relation-tamper-state-v1'),
    stateUnchanged: isCollectionDiffEmpty(diff.fullDiff),
    storageSaveAttemptCount,
    storageWriteCount,
    transactionBeginCount
  });
}

function runActualPendingPageSave(spec, observation, runtime) {
  const driver = observation.driver;
  const actionResolution = resolvePageAction({
    availablePageMethods: driver && driver.page,
    entrySurface: driver && driver.surface,
    inputChannel: spec.input.channel,
    requestedAction: spec.interaction.requestedSaveAction
  });
  const before = safeClone(spec.initialState.state);
  const actionInvocation = invokeResolvedPageAction(driver.page, actionResolution, {
    readMethodCount: () => Number(
      driver.evidence.pageMethodCalls[actionResolution.resolvedMethodName] || 0
    )
  });
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
    pageActionEvidence: {
      invocation: safeClone(actionInvocation.invocationEvidence),
      resolution: safeClone(actionResolution.resolutionEvidence)
    },
    pageMethod: actionResolution.resolvedMethodName,
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
  const actionResolution = resolvePageAction({
    availablePageMethods: driver && driver.page,
    entrySurface: driver && driver.surface,
    inputChannel: spec.input.channel,
    requestedAction: 'SAVE_FORMAL'
  });
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
  const beforeCalls = Number(
    driver.evidence.pageMethodCalls[actionResolution.resolvedMethodName] || 0
  );
  const beforeEligibleCalls = Number(driver.evidence.pagePrimaryActionCalls.saveFormal || 0);
  const beforeBusiness = Number(driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
  const beforeStorage = Number(driver.evidence.productionStorageCalls.saveState || 0);
  const productionStorage = require('../../../utils/storage');
  const beforeMonitorEvents = (
    productionStorage.getRecordStorageInfrastructureStatus().monitorEvents || []
  );
  const beforeStorageEvents = runtime.fakeWx.audit().storageEvents.length;
  const beforeRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const beforeState = stripRecordStorageControl(beforeRaw);
  const beforeRevision = beforeRaw && beforeRaw.__hxlRecordStorageV1
    ? Number(beforeRaw.__hxlRecordStorageV1.storageRevision || 0)
    : 0;
  const beforeReceiptCount = beforeRaw && beforeRaw.__hxlRecordStorageV1
    ? (beforeRaw.__hxlRecordStorageV1.recentReceipts || []).length
    : 0;
  const firstActionInvocation = invokeResolvedPageAction(driver.page, actionResolution, {
    readMethodCount: () => Number(
      driver.evidence.pageMethodCalls[actionResolution.resolvedMethodName] || 0
    )
  });
  const afterFirstRaw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state;
  const afterFirstState = stripRecordStorageControl(afterFirstRaw);
  const secondActionInvocation = invokeResolvedPageAction(driver.page, actionResolution, {
    readMethodCount: () => Number(
      driver.evidence.pageMethodCalls[actionResolution.resolvedMethodName] || 0
    )
  });
  const afterCalls = Number(
    driver.evidence.pageMethodCalls[actionResolution.resolvedMethodName] || 0
  );
  const afterEligibleCalls = Number(driver.evidence.pagePrimaryActionCalls.saveFormal || 0);
  const afterBusiness = Number(driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
  const afterStorage = Number(driver.evidence.productionStorageCalls.saveState || 0);
  const afterMonitorEvents = (
    productionStorage.getRecordStorageInfrastructureStatus().monitorEvents || []
  );
  const transactionDecisionCount = afterMonitorEvents
    .slice(beforeMonitorEvents.length)
    .filter((event) => event.type === 'LEGACY_WRITE_DECISION').length;
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
    actionResolutionEvidence: safeClone(actionResolution.resolutionEvidence),
    actionInvocationEvidence: [
      safeClone(firstActionInvocation.invocationEvidence),
      safeClone(secondActionInvocation.invocationEvidence)
    ],
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
    transactionBeginCount: transactionDecisionCount,
    transactionCommitAttempts: transactionDecisionCount,
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
  const runtimeStateBefore = stripRecordStorageControl(
    runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || spec.initialState.state
  );
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
  runtime.parserObservationEvidence = {
    observations: [observation, draftObservation]
      .filter((item, index, values) => item && values.indexOf(item) === index)
      .map((item) => ({
        parserObservation: safeClone(item.parserObservation || null),
        productionPathObservation: safeClone(item.productionPathObservation || null)
      })),
    parserObservation: safeClone(observation.parserObservation || null),
    productionPathObservation: safeClone(
      observation.productionPathObservation || null
    )
  };
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

  let relationTamper = null;
  if (lanes.includes('RELATION_REFERENCE_TAMPER_GUARD')) {
    const relationObservation = draftObservation || observation;
    const latestState = stripRecordStorageControl(
      runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || runtimeStateBefore
    );
    const activityBefore = captureRelationTamperActivity(
      runtime,
      relationObservation
    );
    const directActivity = { businessSaveCalls: 0, storageSaveCalls: 0 };
    directActivity.instrumentationPresent = !(
      options.hooks && options.hooks.relationTamperDropInstrumentation
    );
    const business = require('../../../utils/business');
    const storage = require('../../../utils/storage');
    const originalBusinessSave = business.saveConfirmedDraft;
    const originalStorageSave = storage.saveState;
    business.saveConfirmedDraft = (...args) => {
      directActivity.businessSaveCalls += 1;
      return originalBusinessSave(...args);
    };
    storage.saveState = (...args) => {
      directActivity.storageSaveCalls += 1;
      return originalStorageSave(...args);
    };
    try {
      relationTamper = executeRelationReferenceTamper(spec, latestState);
      if (options.hooks && options.hooks.relationTamperInvokePageMethod
        && relationObservation.driver
        && typeof relationObservation.driver.page.onShow === 'function') {
        relationObservation.driver.page.onShow();
      }
      if (options.hooks && options.hooks.relationTamperInvokeBusinessSave) {
        business.saveConfirmedDraft(
          safeClone(latestState),
          safeClone(relationTamper.draftAfterInjection)
        );
      }
      if (options.hooks && options.hooks.relationTamperMutateStorage) {
        const leaked = safeClone(
          runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || latestState
        );
        leaked.orders = (leaked.orders || []).concat({
          id: `self-test-relation-tamper-leak:${spec.caseId}`
        });
        runtime.fakeWx.wx.setStorageSync(BUSINESS_STORAGE_KEY, leaked);
      }
    } finally {
      business.saveConfirmedDraft = originalBusinessSave;
      storage.saveState = originalStorageSave;
    }
    relationTamper = completeRelationTamperActivity(
      runtime,
      relationObservation,
      activityBefore,
      relationTamper,
      directActivity
    );
    const instrumentationMissing = relationTamper.activityAudit
      .instrumentationPresent !== true;
    const forbiddenActivity = relationTamper.saveAttempted
      || relationTamper.pageMethodInvocationCount > 0
      || relationTamper.businessSaveAttemptCount > 0
      || relationTamper.storageSaveAttemptCount > 0
      || relationTamper.storageWriteCount > 0
      || relationTamper.transactionBeginCount > 0
      || relationTamper.stateUnchanged !== true;
    laneResults.push(executedLane(
      'RELATION_REFERENCE_TAMPER_GUARD',
      {
        activityAudit: safeClone(relationTamper.activityAudit),
        blockingCodes: safeClone(relationTamper.blockingCodes),
        domainCanSaveFormal: relationTamper.domainCanSaveFormal,
        injectedRelation: safeClone(relationTamper.injectedRelation),
        saveAttempted: relationTamper.saveAttempted,
        stateUnchanged: relationTamper.stateUnchanged
      },
      instrumentationMissing || forbiddenActivity
        ? {
          completionEvidencePresent: relationTamper.completionEvidencePresent === true,
          failureCode: instrumentationMissing
            ? 'ISOLATION_AUDIT_NOT_EXECUTED'
            : 'RELATION_TAMPER_FORBIDDEN_ACTIVITY',
          failureStage: 'AUTOMATION_DRIVER_ERROR',
          primaryActionSucceeded: false,
          status: 'RUNNER_ERROR'
        }
        : {
          completionEvidencePresent: relationTamper.completionEvidencePresent === true,
          primaryActionSucceeded: relationTamper.completionEvidencePresent === true
        }
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
      secondObservation.afterEdits.parseResult,
      { registerGateway: runtime.registerGateway }
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
      ? executedLane('TEST_ONLY_ISOLATED_LEGACY_COMMIT', {
        committed: true,
        marker: isolated.marker,
        status: concurrent.commitA && concurrent.commitA.status || ''
      })
      : preconditionFailedLane(
        'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
        {
          committed: false,
          reason: concurrent.reason || 'FIRST_COMMIT_NOT_COMPLETED'
        },
        'BUSINESS_SAFETY_BLOCKED',
        'PREFLIGHT_ERROR'
      ));
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
      isolated = executeIsolatedLegacyCommit(spec, sourceDraft, Object.assign(
        {},
        options.hooks || {},
        { registerGateway: runtime.registerGateway }
      ));
    }
    if (!surfaceGap) {
      laneResults.push(executedLane('TEST_ONLY_ISOLATED_LEGACY_COMMIT', {
          committed: Boolean(isolated && isolated.committed),
          marker: isolated && isolated.marker,
          reason: isolated && isolated.reason || ''
        }));
    }
  }
  if (observationPublic.pageEditConsistency) {
    const businessRecord = isolated && isolated.businessResult
      ? isolated.businessResult.record
      : null;
    const persistedRecord = isolated && isolated.committed === true
      && businessRecord
      && businessRecord.id
      ? Object.values(isolated.stateAfter || {})
        .filter((value) => Array.isArray(value))
        .reduce((found, collection) => (
          found || collection.find((record) => (
            record && record.id === businessRecord.id
          )) || null
        ), null)
      : null;
    observationPublic.pageEditConsistency.finalLegacyDraft = safeClone(
      isolated && isolated.prepared && isolated.prepared.draft
        ? isolated.prepared.draft
        : sourceDraft
    );
    observationPublic.pageEditConsistency.finalSavedRecord = safeClone(persistedRecord);
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
      replay.pageSaveAttempts = Number(
        sourceObservation.driver
        && sourceObservation.driver.evidence.pageMethodCalls.saveFormal || 0
      );
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

  if (options.hooks && options.hooks.mutateSurfaceBusinessStorage
    && surfaceGap) {
    const raw = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || {};
    raw.orders = (raw.orders || []).concat({
      id: `self-test-surface-leak:${spec.caseId}`,
      originalText: spec.input.originalText
    });
    runtime.fakeWx.wx.setStorageSync(BUSINESS_STORAGE_KEY, raw);
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
  const runtimeStateAfter = stripRecordStorageControl(
    runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY) || runtimeStateBefore
  );
  const runtimeStateDiff = createStateDiff(runtimeStateBefore, runtimeStateAfter);
  const stateDiff = isolated && isolated.diff
    ? isolated.diff
    : runtimeStateDiff;
  const surfaceDependentLane = laneResults.find((lane) => (
    lane.lane === 'TEST_ONLY_ISOLATED_LEGACY_COMMIT'
    && lane.failureCode === 'UPSTREAM_PAGE_CAPABILITY_MISSING'
  ));
  if (surfaceDependentLane) {
    surfaceDependentLane.evidence = Object.assign({}, surfaceDependentLane.evidence, {
      zeroSideEffects: isCollectionDiffEmpty(runtimeStateDiff.businessDiff),
      runtimeBusinessDiff: runtimeStateDiff.businessDiff
    });
  }
  const semanticResult = canonicalSemanticResult({
    businessType: primaryProductionObservation.businessType,
    operation: primaryProductionObservation.operation
  }, {
    route: observation.route
  });
  const proposal = proposalFromDraft(
    sourceDraft,
    semanticResult,
    sourceObservation.afterEdits.surface
  );
  const outcome = actualOutcome({
    businessDiff: stateDiff.businessDiff,
    isolatedCommitEvidence: isolated,
    requestedSaveAction: spec.interaction.requestedSaveAction,
    route: observation.route
  });
  const rawParserInstrumentation = parserInstrumentationAudit();
  if (rawParserInstrumentation.orphanRawInvocationCount !== 0
    || rawParserInstrumentation.uncorrelatedInvocationCount !== 0
    || rawParserInstrumentation.shadowParserInvocationCount !== 0) {
    throw Object.assign(new Error('Parser instrumentation found unparented raw calls'), {
      code: 'RAW_PARSER_EVIDENCE_MISSING',
      rawParserInstrumentation
    });
  }
  const rawParser = safeClone(observationPublic.parserObservation);
  if (!rawParser) {
    throw Object.assign(new Error('Parser invocation graph evidence is missing'), {
      code: 'RAW_PARSER_EVIDENCE_MISSING'
    });
  }
  if (rawParser.status === 'RAW_PARSER_EVIDENCE_MISSING') {
    throw Object.assign(new Error(
      rawParser.errors && rawParser.errors[0] && rawParser.errors[0].code
        || 'Raw parser observation evidence is missing'
    ), {
      code: 'RAW_PARSER_EVIDENCE_MISSING',
      rawParser
    });
  }
  if ((rawParser.shadowParserInvocations || []).length !== 0) {
    throw Object.assign(new Error('Shadow parser invocation detected'), {
      code: 'SHADOW_PARSER_INVOCATION_DETECTED',
      rawParser
    });
  }
  const observationSemantics = {
    contractVersion: 'record-e2e-observation-semantics-v1',
    outcome,
    proposal,
    rawParser,
    semanticResult
  };
  const relationEvidence = buildRelationEvidence(
    rawParser,
    sourceDraft,
    primaryProductionObservation
  );
  const routeEvidence = buildRouteEvidence(sourceObservation, rawParser);
  const noRecordEvidence = buildNoRecordEvidence({
    businessDiff: stateDiff.businessDiff,
    isolated,
    outcome,
    rawParser,
    requestedSaveAction: spec.interaction.requestedSaveAction,
    routeEvidence
  });
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
    noRecordEvidence,
    observationSemantics,
    parserObservation: rawParser,
    rawParserInstrumentation,
    hostFilesystemAudit: audit.hostFilesystemAudit,
    pageDerivationEvidence: draftPublic,
    pageEvidence: observationPublic,
    preflightEvidence: {
      blockingCodes: primaryProductionObservation.businessBlockingCodes,
      businessType: primaryProductionObservation.businessType,
      domainCanSaveFormal: primaryProductionObservation.domainCanSaveFormal,
      domainCanSavePending: primaryProductionObservation.domainCanSavePending,
      operation: primaryProductionObservation.operation,
      preflightFingerprint: primaryProductionObservation.preflightFingerprint,
      requiredSelections: primaryProductionObservation.requiredSelections
    },
    productionObservation: primaryProductionObservation,
    receivableOrderGateEvidence: buildReceivableOrderGateEvidence(
      sourceObservation,
      isolated
    ),
    relationEvidence,
    relationReferenceTamperEvidence: relationTamper,
    restartEvidence: restart,
    restartRequest,
    routeEvidence,
    storageAudit: audit.storageAudit,
    finalTransactionAudit,
    surfaceEvidence: {
      availableCapabilities: observation.driver
        ? observation.driver.availableCapabilities
        : {},
      missingCapabilities: observation.missingCapabilities,
      pageCandidateIds: safeClone(observation.afterEdits.candidateIds || {}),
      selectionTargets: safeClone(plan.selectionTargets || [])
    },
    transactionReplayEvidence: replay,
    duplicateTriggerEvidence: duplicate,
    voiceAudit: audit.voiceAudit
  };
}

module.exports = {
  buildNoRecordEvidence,
  buildRelationEvidence,
  buildReceivableOrderGateEvidence,
  deriveProductionObservation,
  executeLanes,
  productionEligibility
};
