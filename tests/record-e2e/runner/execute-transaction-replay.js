const { safeClone, stableSerialize } = require('../../../utils/record-state-diff');
const { createPersistentRecordTransactionManager } = require('../../../utils/record-storage-transaction');
const { stripRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const { BUSINESS_STORAGE_KEY } = require('./constants');

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
  return {
    businessBundleEqual: stableSerialize(stripRecordStorageControl(beforeBundle))
      === stableSerialize(stripRecordStorageControl(afterBundle)),
    exactMaterialFingerprint: receipt.planHash,
    firstStatus: first.status,
    journalBackupAdditionalWrites: afterStats.writes - beforeStats.writes,
    pageSaveAttempts: 1,
    receiptCountDelta: afterReceiptCount - beforeReceiptCount,
    receiptSemanticEqual: stableSerialize(replay.receipt) === stableSerialize(receipt),
    replay,
    revisionDelta: Number(afterControl.storageRevision || 0)
      - Number(beforeControl.storageRevision || 0),
    sameIdentity: replay.receipt
      && replay.receipt.transactionId === receipt.transactionId
      && replay.receipt.planId === receipt.planId
      && replay.receipt.planHash === receipt.planHash
      && replay.receipt.idempotencyKey === receipt.idempotencyKey
  };
}

module.exports = {
  executeTransactionReplay
};
