const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const {
  buildSelectionTargets,
  validateExecutionPlanPreconditions
} = require('./validate-plan-preconditions');
const {
  deriveEditMode,
  lookupPageAction
} = require('./page-action-registry');

function expectedLayerNames(lanes) {
  const names = ['observationSemantics', 'productionObservation'];
  if (lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')) names.push('isolatedExecution');
  if (lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD')) names.push('pageDuplicateTrigger');
  if (lanes.includes('RELATION_REFERENCE_TAMPER_GUARD')) names.push('relationReferenceTamper');
  if (lanes.includes('TRANSACTION_EXACT_REPLAY')) names.push('transactionExactReplay');
  if (lanes.includes('RESTART_PERSISTENCE')) names.push('restart');
  if (lanes.includes('CONCURRENT_BASE_REVISION')) names.push('concurrentBaseRevision');
  return names;
}

function buildWorkerSpec(testCase, resolved) {
  return safeClone({
    caseId: testCase.caseId,
    title: testCase.title,
    riskLevel: testCase.riskLevel,
    category: testCase.category,
    execution: testCase.execution,
    executionProfiles: testCase.executionProfiles,
    input: testCase.input,
    clock: testCase.clock,
    initialState: {
      fixtureRef: resolved.initial.fixtureRef,
      state: resolved.initial.state,
      fingerprint: resolved.initial.fingerprint
    },
    ai: testCase.ai,
    aiFixture: resolved.ai,
    interaction: testCase.interaction
  });
}

function buildExecutionPlan(testCase, fixtureResolver) {
  const initial = fixtureResolver.resolveInitialState(testCase.initialState);
  const ai = fixtureResolver.resolveAiFixture(testCase.ai);
  const contractErrors = validateExecutionPlanPreconditions(testCase, initial.state);
  if (contractErrors.length) {
    throw Object.assign(
      new Error(`${testCase.caseId} execution plan precondition failed: ${contractErrors.join(', ')}`),
      {
        code: 'TEST_DATA_ERROR',
        failureCode: contractErrors[0],
        contractErrors
      }
    );
  }
  const lanes = safeClone(testCase.execution.lanes);
  const requestedAction = testCase.interaction.requestedSaveAction;
  const editMode = deriveEditMode(testCase.input.channel);
  const pageMethodRequired = requestedAction === 'SAVE_PENDING'
    || lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD');
  const actionSurface = testCase.execution.draftSourceSurface
    || testCase.execution.observationSurface
    || testCase.input.entrySurface;
  let pageActionPlan = {
    actionSurface,
    editMode,
    requestedAction,
    strategy: requestedAction === 'DO_NOT_SAVE'
      ? 'NO_INVOCATION'
      : 'TEST_ONLY_ISOLATED_LEGACY_DIRECT'
  };
  if (pageMethodRequired) {
    const registered = lookupPageAction({
      editMode,
      entrySurface: actionSurface,
      inputChannel: testCase.input.channel,
      requestedAction
    });
    pageActionPlan = Object.assign(pageActionPlan, {
      registryKey: registered.key,
      resolvedMethodName: registered.entry.methodName,
      semanticAction: registered.entry.semanticAction,
      strategy: lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD')
        ? 'PAGE_METHOD_DUPLICATE_TRIGGER'
        : 'PAGE_METHOD'
    });
  }
  const plan = {
    schemaVersion: 'record-e2e-execution-plan-v1',
    caseId: testCase.caseId,
    workerId: `worker:${testCase.caseId}`,
    entrySurface: testCase.input.entrySurface,
    inputChannel: testCase.input.channel,
    lanes,
    requiredCapabilities: safeClone(testCase.interaction.requiredCapabilities || []),
    selectionTargets: buildSelectionTargets(testCase, initial.state),
    clock: safeClone(testCase.clock),
    stateFixtureRef: initial.fixtureRef,
    stateFixtureFingerprint: initial.fingerprint,
    aiFixtureRef: testCase.ai.fixtureRef || null,
    interactionSteps: safeClone(testCase.interaction.sequence || []),
    pageActionPlan,
    relationReferenceTamper: safeClone(testCase.execution.relationReferenceTamper || null),
    expectedLayers: expectedLayerNames(lanes)
  };
  plan.planFingerprint = stableHash(plan, 'record-e2e-execution-plan-v1');
  return {
    plan,
    workerSpec: buildWorkerSpec(testCase, { ai, initial })
  };
}

function buildAllExecutionPlans(corpus) {
  return corpus.activeCases.map((testCase) => ({
    testCase,
    ...buildExecutionPlan(testCase, corpus.fixtureResolver)
  }));
}

module.exports = {
  buildAllExecutionPlans,
  buildExecutionPlan
};
