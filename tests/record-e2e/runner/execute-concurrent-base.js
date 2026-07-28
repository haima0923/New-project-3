const { saveConfirmedDraft } = require('../../../utils/business');
const { createStateDiff, getStateFingerprint, safeClone } = require('../../../utils/record-state-diff');
const { createFakeStorageGateway } = require('../../../utils/record-storage-gateways');
const { createReleaseAStorageFacade } = require('../../../utils/storage');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const { prepareLegacyDraft, storageAudit } = require('./execute-isolated-legacy-commit');

function makeClock(nowInstant) {
  return { now: () => new Date(nowInstant) };
}

function saveOptions(spec, suffix) {
  return {
    idempotencyKey: `e2e:${spec.caseId}:${suffix}:idempotency`,
    planId: `e2e:${spec.caseId}:${suffix}:plan`,
    transactionId: `e2e:${spec.caseId}:${suffix}:transaction`,
    writerSource: 'INPUT_FORMAL'
  };
}

function executeConcurrentBase(spec, draftA, draftB) {
  const gateway = createFakeStorageGateway({
    [BUSINESS_STORAGE_KEY]: safeClone(spec.initialState.state)
  });
  const facade = createReleaseAStorageFacade({
    clock: makeClock(spec.clock.nowInstant),
    gateway
  });
  const pageAState = facade.getState({ writerSource: 'INPUT_FORMAL' });
  const pageBState = facade.getState({ writerSource: 'INPUT_FORMAL' });
  const baseFingerprintA = getStateFingerprint(pageAState);
  const baseFingerprintB = getStateFingerprint(pageBState);
  const initial = safeClone(pageAState);
  const preparedA = prepareLegacyDraft(draftA, pageAState, spec.ai.profile);
  const preparedB = prepareLegacyDraft(draftB, pageBState, spec.ai.profile);
  if (!preparedA.allowed || !preparedB.allowed) {
    return {
      committedA: false,
      committedB: false,
      gateway,
      marker: 'CONCURRENT_BASE_REVISION',
      preparedA,
      preparedB,
      reason: 'BUSINESS_SAFETY_BLOCKED',
      stateAfter: initial,
      stateBefore: initial,
      diff: createStateDiff(initial, initial)
    };
  }

  const businessA = saveConfirmedDraft(pageAState, preparedA.draft);
  const businessB = saveConfirmedDraft(pageBState, preparedB.draft);
  facade.saveState(pageAState, saveOptions(spec, 'page-a'));
  const commitA = facade.getLastWriteResult();
  let commitB = null;
  let errorB = null;
  try {
    facade.saveState(pageBState, saveOptions(spec, 'page-b'));
    commitB = facade.getLastWriteResult();
  } catch (error) {
    errorB = {
      code: error.code || 'STORAGE_TRANSACTION_ERROR',
      message: error.message
    };
    commitB = facade.getLastWriteResult();
  }
  const after = facade.getState({ writerSource: 'INPUT_FORMAL' });
  return {
    baseFingerprintEqual: baseFingerprintA === baseFingerprintB,
    baseRevisionA: commitA && commitA.baseRevision,
    baseRevisionB: 0,
    businessA,
    businessB,
    commitA,
    commitB,
    committedA: Boolean(commitA && commitA.commitSucceeded),
    committedB: Boolean(commitB && commitB.commitSucceeded),
    diff: createStateDiff(initial, after),
    errorB,
    gateway,
    marker: 'CONCURRENT_BASE_REVISION',
    pageADataPreserved: Boolean(
      businessA && businessA.record && (after.orders || []).some((item) => item.id === businessA.record.id)
    ),
    pageBDataWritten: Boolean(
      businessB && businessB.record && (after.orders || []).some((item) => item.id === businessB.record.id)
    ),
    preparedA,
    preparedB,
    staleDetected: Boolean(errorB && /STALE/.test(errorB.code)),
    stateAfter: safeClone(after),
    stateBefore: initial,
    storageAudit: storageAudit(gateway, commitA)
  };
}

module.exports = {
  executeConcurrentBase
};
