const {
  createStateDiff,
  getStateFingerprint,
  isCollectionDiffEmpty,
  safeClone
} = require('../../../utils/record-state-diff');
const { stripRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');
const { assertIsolationAudit } = require('./assert-isolation-audit');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const { executeRestart } = require('./execute-restart');

function controlFromEntries(entries) {
  return entries && entries[BUSINESS_STORAGE_KEY]
    && entries[BUSINESS_STORAGE_KEY].__hxlRecordStorageV1 || {};
}

function countBusinessChanges(diff) {
  return Object.values(diff.businessDiff || {}).reduce((sum, entry) => (
    sum
    + (entry.created || []).length
    + (entry.updated || []).length
    + (entry.deleted || []).length
  ), 0);
}

function assertRestartRuntimeBoundary(result, prior) {
  if (!result || !result.workerExitAudit
    || result.workerExitAudit.exitObserved !== true
    || result.workerExitAudit.exitCode !== 0
    || result.restartBootId === prior.bootId
    || result.restartPid === prior.pid
    || result.newRuntimeInstance !== true) {
    throw Object.assign(new Error('Restart did not cross a verified worker runtime boundary'), {
      code: 'LANE_EXECUTION_EVIDENCE_MISSING'
    });
  }
  return true;
}

async function completeRestartInParent(evidence, spec, plan, attempt) {
  if (!spec.execution.lanes.includes('RESTART_PERSISTENCE')) return evidence;
  const request = evidence.restartRequest;
  const lane = (evidence.laneResults || []).find((item) => item.lane === 'RESTART_PERSISTENCE');
  if (!request || !lane || request.priorCommit.status !== 'COMMITTED'
    || !request.priorCommit.receipt) {
    return evidence;
  }
  const saveDiff = createStateDiff(spec.initialState.state, request.postSaveState);
  if (countBusinessChanges(saveDiff) === 0) {
    throw Object.assign(new Error('Restart save precondition has no identifiable business change'), {
      code: 'LANE_EXECUTION_EVIDENCE_MISSING'
    });
  }
  const restartCount = Math.max(
    1,
    (plan.interactionSteps || []).filter((step) => step.step === 'RESTART').length
  );
  const attempts = [];
  let entries = safeClone(request.entries);
  let previousBootId = request.primaryBootId;
  let previousPid = request.primaryPid;
  for (let index = 0; index < restartCount; index += 1) {
    const result = await executeRestart(
      spec,
      entries,
      previousBootId,
      previousPid,
      (attempt || 1) * 100 + index + 1
    );
    assertIsolationAudit(result.audit);
    assertRestartRuntimeBoundary(result, {
      bootId: previousBootId,
      pid: previousPid
    });
    if (Object.prototype.hasOwnProperty.call(result.storageEntries, RECORD_STORAGE_JOURNAL_KEY)
      || Object.prototype.hasOwnProperty.call(result.storageEntries, RECORD_STORAGE_BACKUP_KEY)) {
      throw Object.assign(new Error('Restart left Journal or Backup material'), {
        code: 'CLEANUP_ERROR'
      });
    }
    attempts.push(result);
    entries = result.storageEntries;
    previousBootId = result.restartBootId;
    previousPid = result.restartPid;
  }
  const final = attempts[attempts.length - 1];
  const finalState = stripRecordStorageControl(entries[BUSINESS_STORAGE_KEY] || {});
  const additionalDiff = createStateDiff(request.postSaveState, finalState);
  const beforeControl = controlFromEntries(request.entries);
  const afterControl = controlFromEntries(entries);
  const restartEvidence = Object.assign({}, final, {
    additionalDiff,
    attemptCount: attempts.length,
    attempts: attempts.map((item) => ({
      audit: item.audit,
      bootId: item.restartBootId,
      newRuntimeInstance: item.newRuntimeInstance,
      pid: item.restartPid,
      workerExitAudit: item.workerExitAudit
    })),
    equalToPostSave: getStateFingerprint(finalState)
      === getStateFingerprint(request.postSaveState),
    journalCount: 0,
    backupCount: 0,
    recordCountStable: isCollectionDiffEmpty(additionalDiff.businessDiff),
    receiptCountDelta: (afterControl.recentReceipts || []).length
      - (beforeControl.recentReceipts || []).length,
    revisionDelta: Number(afterControl.storageRevision || 0)
      - Number(beforeControl.storageRevision || 0),
    startupRecoveryStatus: final.status && final.status.lastStartupResult
      && final.status.lastStartupResult.status || ''
  });
  evidence.restartEvidence = restartEvidence;
  delete evidence.restartRequest;
  Object.assign(lane, {
    preconditionsChecked: true,
    preconditionsPassed: true,
    started: true,
    primaryActionAttempted: true,
    primaryActionSucceeded: attempts.length === restartCount
      && attempts.every((item) => item.newRuntimeInstance),
    completionEvidencePresent: restartEvidence.equalToPostSave
      && restartEvidence.workerExitAudit.exitObserved,
    evidence: {
      attemptCount: restartEvidence.attemptCount,
      equalToPostSave: restartEvidence.equalToPostSave,
      newRuntimeInstance: restartEvidence.newRuntimeInstance,
      workerExitObserved: restartEvidence.workerExitAudit.exitObserved
    },
    failureCode: '',
    failureStage: '',
    status: 'PENDING_ASSERTIONS'
  });
  return evidence;
}

module.exports = {
  assertRestartRuntimeBoundary,
  completeRestartInParent,
  controlFromEntries,
  countBusinessChanges
};
