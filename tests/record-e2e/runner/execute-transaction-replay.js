const { safeClone, stableHash, stableSerialize } = require('../../../utils/record-state-diff');
const { createPersistentRecordTransactionManager } = require('../../../utils/record-storage-transaction');
const { stripRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');

function executeTransactionReplay(isolatedEvidence, spec) {
  const first = isolatedEvidence && isolatedEvidence.commitResult;
  const receipt = first && first.receipt;
  const gateway = isolatedEvidence && isolatedEvidence.gateway;
  if (!first || !receipt || !gateway) {
    throw Object.assign(new Error('Exact replay requires a completed first isolated commit'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const beforeEntries = gateway.getEntries();
  const beforeStats = gateway.getStats();
  const beforeBundle = beforeEntries[BUSINESS_STORAGE_KEY];
  const beforeControl = beforeBundle && beforeBundle.__hxlRecordStorageV1 || {};
  const beforeReceiptCount = (beforeControl.recentReceipts || []).length;
  const transactionInput = {
    baseFingerprint: first.baseFingerprint,
    baseRevision: first.baseRevision,
    committedAt: receipt.committedAt,
    idempotencyKey: receipt.idempotencyKey,
    planHash: receipt.planHash,
    planId: receipt.planId,
    riskLevel: receipt.riskLevel,
    targetBundle: stripRecordStorageControl(safeClone(beforeBundle)),
    transactionId: receipt.transactionId,
    writerSource: 'INPUT_FORMAL'
  };
  const capturedMaterial = safeClone(transactionInput);
  const capturedIdentity = {
    baseFingerprint: capturedMaterial.baseFingerprint,
    baseRevision: capturedMaterial.baseRevision,
    idempotencyKey: capturedMaterial.idempotencyKey,
    planHash: capturedMaterial.planHash,
    planId: capturedMaterial.planId,
    targetBundleFingerprint: first.targetBundleFingerprint,
    targetRevision: first.targetRevision,
    transactionId: capturedMaterial.transactionId
  };
  const manager = createPersistentRecordTransactionManager({
    gateway,
    mode: 'TRANSACTION_PREVIEW',
    clock: { now: () => new Date(spec.clock.nowInstant) }
  });
  const replay = manager.commitBundle(safeClone(capturedMaterial));
  const afterEntries = gateway.getEntries();
  const afterStats = gateway.getStats();
  const afterBundle = afterEntries[BUSINESS_STORAGE_KEY];
  const afterControl = afterBundle && afterBundle.__hxlRecordStorageV1 || {};
  const afterReceiptCount = (afterControl.recentReceipts || []).length;
  const replayStats = {
    reads: afterStats.reads - beforeStats.reads,
    writes: afterStats.writes - beforeStats.writes,
    removals: afterStats.removals - beforeStats.removals,
    events: afterStats.events.slice(beforeStats.events.length)
  };
  const returnedIdentity = {
    baseFingerprint: first.baseFingerprint,
    baseRevision: first.baseRevision,
    idempotencyKey: replay.receipt && replay.receipt.idempotencyKey,
    planHash: replay.receipt && replay.receipt.planHash,
    planId: replay.receipt && replay.receipt.planId,
    targetBundleFingerprint: first.targetBundleFingerprint,
    targetRevision: replay.receipt && replay.receipt.committedRevision,
    transactionId: replay.receipt && replay.receipt.transactionId
  };
  return {
    businessBundleEqual: stableSerialize(stripRecordStorageControl(beforeBundle))
      === stableSerialize(stripRecordStorageControl(afterBundle)),
    capturedIdentity,
    returnedIdentity,
    exactMaterialFingerprint: stableHash(capturedMaterial, 'exact-replay-material-v1'),
    firstStatus: first.status,
    firstCommitSucceeded: first.commitSucceeded === true,
    firstIdempotentReplay: first.idempotentReplay === true,
    journalCount: Object.prototype.hasOwnProperty.call(afterEntries, RECORD_STORAGE_JOURNAL_KEY) ? 1 : 0,
    backupCount: Object.prototype.hasOwnProperty.call(afterEntries, RECORD_STORAGE_BACKUP_KEY) ? 1 : 0,
    replayStats,
    receiptCountDelta: afterReceiptCount - beforeReceiptCount,
    receiptSemanticEqual: stableSerialize(replay.receipt) === stableSerialize(receipt),
    replay,
    revisionDelta: Number(afterControl.storageRevision || 0)
      - Number(beforeControl.storageRevision || 0),
    sameIdentity: stableSerialize(capturedIdentity) === stableSerialize(returnedIdentity),
    targetFingerprintEqual: first.targetFingerprint === receipt.committedFingerprint
  };
}

module.exports = {
  executeTransactionReplay
};
