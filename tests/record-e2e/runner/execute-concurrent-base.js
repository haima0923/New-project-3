const { saveConfirmedDraft } = require('../../../utils/business');
const { createStateDiff, getStateFingerprint, safeClone } = require('../../../utils/record-state-diff');
const { createFakeStorageGateway } = require('../../../utils/record-storage-gateways');
const { createReleaseAStorageFacade } = require('../../../utils/storage');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const { prepareLegacyDraft, storageAudit } = require('./execute-isolated-legacy-commit');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');

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

function executeConcurrentBase(spec, draftA, draftB, options = {}) {
  const gateway = createFakeStorageGateway({
    [BUSINESS_STORAGE_KEY]: safeClone(spec.initialState.state)
  });
  if (typeof options.registerGateway === 'function') {
    options.registerGateway('CONCURRENT_BASE', gateway);
  }
  const facade = createReleaseAStorageFacade({
    clock: makeClock(spec.clock.nowInstant),
    gateway
  });
  const pageAState = facade.getState({ writerSource: 'INPUT_FORMAL' });
  const pageBState = facade.getState({ writerSource: 'INPUT_FORMAL' });
  const initialEntries = gateway.getEntries();
  const initialControl = initialEntries[BUSINESS_STORAGE_KEY]
    && initialEntries[BUSINESS_STORAGE_KEY].__hxlRecordStorageV1 || {};
  const sharedBaseRevision = Number(initialControl.storageRevision || 0);
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
  const beforeAStats = gateway.getStats();
  facade.saveState(pageAState, saveOptions(spec, 'page-a'));
  const commitA = facade.getLastWriteResult();
  const afterAStats = gateway.getStats();
  const beforeBEntries = gateway.getEntries();
  const beforeBControl = beforeBEntries[BUSINESS_STORAGE_KEY]
    && beforeBEntries[BUSINESS_STORAGE_KEY].__hxlRecordStorageV1 || {};
  let commitB = null;
  let errorB = null;
  let secondCommitAttempted = false;
  const beforeBStats = gateway.getStats();
  try {
    secondCommitAttempted = true;
    facade.saveState(pageBState, saveOptions(spec, 'page-b'));
    commitB = facade.getLastWriteResult();
  } catch (error) {
    errorB = {
      code: error.code || 'STORAGE_TRANSACTION_ERROR',
      message: error.message
    };
    commitB = facade.getLastWriteResult();
  }
  const afterBStats = gateway.getStats();
  const afterBEntries = gateway.getEntries();
  const afterBControl = afterBEntries[BUSINESS_STORAGE_KEY]
    && afterBEntries[BUSINESS_STORAGE_KEY].__hxlRecordStorageV1 || {};
  const after = facade.getState({ writerSource: 'INPUT_FORMAL' });
  const eventsA = afterAStats.events.slice(beforeAStats.events.length);
  const eventsB = afterBStats.events.slice(beforeBStats.events.length);
  return {
    baseFingerprintEqual: baseFingerprintA === baseFingerprintB,
    baseRevisionA: sharedBaseRevision,
    baseRevisionB: sharedBaseRevision,
    businessA,
    businessB,
    commitA,
    commitB,
    commitAReceiptPresent: Boolean(commitA && commitA.receipt),
    commitAStatus: commitA && commitA.status || '',
    committedA: Boolean(commitA && commitA.commitSucceeded),
    committedB: Boolean(commitB && commitB.commitSucceeded),
    diff: createStateDiff(initial, after),
    errorB,
    firstCommitPrimaryWrites: eventsA.filter((item) => (
      item.type === 'SET' && item.key === BUSINESS_STORAGE_KEY
    )).length,
    gateway,
    marker: 'CONCURRENT_BASE_REVISION',
    pageADataPreserved: Boolean(
      businessA && businessA.record && (after.orders || []).some((item) => item.id === businessA.record.id)
    ),
    pageBDataWritten: Boolean(
      businessB && businessB.record && (after.orders || []).some((item) => item.id === businessB.record.id)
    ),
    secondCommitAttempted,
    secondCommitAllWrites: afterBStats.writes - beforeBStats.writes,
    secondCommitBackupWrites: eventsB.filter((item) => (
      item.type === 'SET' && item.key === RECORD_STORAGE_BACKUP_KEY
    )).length,
    secondCommitJournalWrites: eventsB.filter((item) => (
      item.type === 'SET' && item.key === RECORD_STORAGE_JOURNAL_KEY
    )).length,
    secondCommitPrimaryWrites: eventsB.filter((item) => (
      item.type === 'SET' && item.key === BUSINESS_STORAGE_KEY
    )).length,
    secondCommitReceiptCountDelta: (afterBControl.recentReceipts || []).length
      - (beforeBControl.recentReceipts || []).length,
    secondCommitRevisionDelta: Number(afterBControl.storageRevision || 0)
      - Number(beforeBControl.storageRevision || 0),
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
