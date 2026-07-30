const { stableHash } = require('../../../utils/record-state-diff');
const { CASE_STATUSES, LANE_STATUSES } = require('./constants');

function integrityError(failureCode, message, detail = {}) {
  return Object.assign(new Error(message), {
    code: 'RUNNER_ERROR',
    failureCode,
    detail
  });
}

function exactUniqueSet(values, expected, failureCode, label) {
  const actualValues = values.filter(Boolean);
  const actualSet = new Set(actualValues);
  const expectedSet = new Set(expected);
  const duplicates = actualValues.filter((value, index) => actualValues.indexOf(value) !== index);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actualValues.filter((value) => !expectedSet.has(value));
  if (duplicates.length || missing.length || unexpected.length
    || actualValues.length !== expected.length) {
    throw integrityError(failureCode, `${label} set mismatch`, {
      actualCount: actualValues.length,
      duplicates: Array.from(new Set(duplicates)).sort(),
      expectedCount: expected.length,
      missing: missing.sort(),
      unexpected: Array.from(new Set(unexpected)).sort()
    });
  }
}

function assertAuditZero(value, label, failureCode) {
  if (value !== 0) {
    throw integrityError(failureCode, `${label} must be zero`, {
      actual: value,
      expected: 0
    });
  }
}

function assertWorkerAudit(audit, label) {
  if (!audit || audit.exitObserved !== true || audit.exitCode !== 0
    || audit.ipcClosed !== true) {
    throw integrityError('WORKER_EXIT_AUDIT_FAILED', `${label} worker exit audit failed`, {
      audit
    });
  }
}

function assertRuntimeIsolation(result) {
  const network = result.networkAudit;
  if (!network || network.auditPerformed !== true || network.guardInstalled !== true) {
    throw integrityError(
      'ISOLATION_AUDIT_NOT_EXECUTED',
      `${result.caseId} network audit was not executed`
    );
  }
  assertAuditZero(
    network.realNetworkRequests,
    `${result.caseId}.realNetworkRequests`,
    'AUTOMATION_NETWORK_GUARD_ERROR'
  );
  assertAuditZero(
    network.unknownFakeRouteRequests,
    `${result.caseId}.unknownFakeRouteRequests`,
    'AUTOMATION_NETWORK_GUARD_ERROR'
  );

  const storage = result.storageAudit;
  if (!storage || storage.auditPerformed !== true
    || storage.fakeWxBrandVerifiedStart !== true
    || storage.fakeWxBrandVerifiedEnd !== true) {
    throw integrityError(
      'ISOLATION_AUDIT_NOT_EXECUTED',
      `${result.caseId} storage audit was not executed`
    );
  }
  assertAuditZero(
    storage.realWxStorageCalls,
    `${result.caseId}.realWxStorageCalls`,
    'AUTOMATION_STORAGE_GUARD_ERROR'
  );

  const host = result.hostFilesystemAudit;
  if (!host || host.auditPerformed !== true || host.guardInstalled !== true) {
    throw integrityError(
      'ISOLATION_AUDIT_NOT_EXECUTED',
      `${result.caseId} host filesystem audit was not executed`
    );
  }
  assertAuditZero(
    host.hostFilesystemStorageCalls,
    `${result.caseId}.hostFilesystemStorageCalls`,
    'AUTOMATION_STORAGE_GUARD_ERROR'
  );

  if (!result.fixtureMutationAudit || result.fixtureMutationAudit.unchanged !== true
    || result.fixtureMutationAudit.beforeFingerprint
      !== result.fixtureMutationAudit.afterFingerprint) {
    throw integrityError(
      'AUTOMATION_FIXTURE_MUTATION_ERROR',
      `${result.caseId} fixture fingerprint changed`
    );
  }
  if (!result.runtimeEvidence
    || result.runtimeEvidence.workerIsolation !== 'DEDICATED_CHILD_PROCESS') {
    throw integrityError(
      'CROSS_CASE_ISOLATION_ERROR',
      `${result.caseId} did not use a dedicated child process`
    );
  }
  assertWorkerAudit(result.workerExitAudit, result.caseId);
  const completion = result.isolationAuditCompletion;
  if (!completion
    || completion.networkAuditCompleted !== true
    || completion.storageAuditCompleted !== true
    || completion.fixtureAuditCompleted !== true
    || completion.workerCleanupCompleted !== true
    || completion.journalBackupAuditCompleted !== true) {
    throw integrityError(
      'ISOLATION_AUDIT_NOT_EXECUTED',
      `${result.caseId} isolation audit completion evidence missing`,
      { completion }
    );
  }

  const raw = result.observationSemantics && result.observationSemantics.rawParser;
  if (!raw || raw.status === 'RAW_PARSER_EVIDENCE_MISSING'
    || raw.validationCompleted !== true
    || (raw.errors || []).length) {
    throw integrityError(
      'RAW_PARSER_EVIDENCE_MISSING',
      `${result.caseId} raw parser evidence missing`,
      { raw }
    );
  }
  assertAuditZero(
    (raw.shadowParserInvocations || []).length,
    `${result.caseId}.shadowParserInvocationCount`,
    'SHADOW_PARSER_INVOCATION_DETECTED'
  );
  assertAuditZero(
    (raw.orphanRawInvocations || []).length,
    `${result.caseId}.orphanRawInvocationCount`,
    'ORPHAN_RAW_INVOCATION_DETECTED'
  );
  assertAuditZero(
    Number(raw.uncorrelatedInvocationCount || 0),
    `${result.caseId}.uncorrelatedInvocationCount`,
    'UNCORRELATED_RAW_INVOCATION_DETECTED'
  );

  const transaction = result.finalTransactionAudit;
  if (!transaction
    || !Number.isInteger(transaction.journalCount)
    || !Number.isInteger(transaction.backupCount)) {
    throw integrityError(
      'TRANSACTION_CLEANUP_AUDIT_NOT_EXECUTED',
      `${result.caseId} transaction cleanup audit was not executed`
    );
  }
  assertAuditZero(
    transaction.journalCount,
    `${result.caseId}.journalCount`,
    'CLEANUP_ERROR'
  );
  assertAuditZero(
    transaction.backupCount,
    `${result.caseId}.backupCount`,
    'CLEANUP_ERROR'
  );

  (result.restartEvidence && result.restartEvidence.attempts || []).forEach((attempt, index) => {
    assertWorkerAudit(attempt.workerExitAudit, `${result.caseId}.restart[${index}]`);
    const audit = attempt.audit || {};
    if (!audit.networkAudit || !audit.storageAudit || !audit.hostFilesystemAudit) {
      throw integrityError(
        'ISOLATION_AUDIT_NOT_EXECUTED',
        `${result.caseId}.restart[${index}] isolation audit missing`
      );
    }
    assertAuditZero(
      audit.networkAudit.realNetworkRequests,
      `${result.caseId}.restart[${index}].realNetworkRequests`,
      'AUTOMATION_NETWORK_GUARD_ERROR'
    );
    assertAuditZero(
      audit.networkAudit.unknownFakeRouteRequests,
      `${result.caseId}.restart[${index}].unknownFakeRouteRequests`,
      'AUTOMATION_NETWORK_GUARD_ERROR'
    );
    assertAuditZero(
      audit.storageAudit.realWxStorageCalls,
      `${result.caseId}.restart[${index}].realWxStorageCalls`,
      'AUTOMATION_STORAGE_GUARD_ERROR'
    );
    assertAuditZero(
      audit.hostFilesystemAudit.hostFilesystemStorageCalls,
      `${result.caseId}.restart[${index}].hostFilesystemStorageCalls`,
      'AUTOMATION_STORAGE_GUARD_ERROR'
    );
  });
}

function assertLaneSet(item, result) {
  const expectedLanes = item.testCase.execution.lanes.slice().sort();
  const lanes = result.laneResults || [];
  exactUniqueSet(
    lanes.map((lane) => lane && lane.lane),
    expectedLanes,
    'FULL_CORPUS_LANE_SET_MISMATCH',
    `${result.caseId} Lane`
  );
  lanes.forEach((lane) => {
    if (!LANE_STATUSES.includes(lane.status)) {
      throw integrityError(
        'FULL_CORPUS_LANE_NON_TERMINAL',
        `${result.caseId}/${lane.lane} has non-terminal status ${lane.status}`
      );
    }
  });
}

function assertFullAttemptIntegrity(attempt, plans) {
  const expectedIds = plans.map((item) => item.testCase.caseId);
  exactUniqueSet(
    (attempt.results || []).map((result) => result.caseId),
    expectedIds,
    'FULL_CORPUS_CASE_SET_MISMATCH',
    `Attempt ${attempt.attempt} Case`
  );
  const byId = new Map(plans.map((item) => [item.testCase.caseId, item]));
  attempt.results.forEach((result) => {
    if (!CASE_STATUSES.includes(result.caseStatus)) {
      throw integrityError(
        'FULL_CORPUS_CASE_NON_TERMINAL',
        `${result.caseId} has non-terminal status ${result.caseStatus}`
      );
    }
    if (result.caseStatus === 'RUNNER_ERROR' || result.caseStatus === 'BLOCKED') {
      throw integrityError(
        'FULL_CORPUS_EXECUTION_NOT_CLEAN',
        `${result.caseId} ended as ${result.caseStatus}`,
        { failureCode: result.failureCode, failureStage: result.failureStage }
      );
    }
    assertLaneSet(byId.get(result.caseId), result);
    assertRuntimeIsolation(result);
    const noRecord = result.noRecordEvidence || {};
    if (noRecord.actualProductionRoute === 'NO_RECORD'
      || noRecord.outcomeDisposition === 'NO_RECORD') {
      [
        ['domainCanSaveFormal', noRecord.domainCanSaveFormal],
        ['domainCanSavePending', noRecord.domainCanSavePending],
        ['effectiveCanSaveFormal', noRecord.effectiveCanSaveFormal],
        ['effectiveCanSavePending', noRecord.effectiveCanSavePending],
        ['formalSaveVisible', noRecord.formalSaveVisible],
        ['pendingSaveVisible', noRecord.pendingSaveVisible],
        ['deepReviewVisible', noRecord.deepReviewVisible],
        ['formalSaveSucceeded', noRecord.formalSaveSucceeded],
        ['pendingSaveSucceeded', noRecord.pendingSaveSucceeded]
      ].forEach(([field, value]) => {
        if (value !== false) {
          throw integrityError(
            'NO_RECORD_PERSISTENCE_GATE_ERROR',
            `${result.caseId}.${field} must be false`,
            { noRecord }
          );
        }
      });
      [
        'businessFormalAttemptCount',
        'businessPendingAttemptCount',
        'storageSaveAttemptCount',
        'transactionBeginCount',
        'receiptCount',
        'pendingSavedCount'
      ].forEach((field) => assertAuditZero(
        Number(noRecord[field] || 0),
        `${result.caseId}.${field}`,
        'NO_RECORD_PERSISTENCE_GATE_ERROR'
      ));
    }
  });
  const noRecordResults = attempt.results.filter((result) => {
    const evidence = result.noRecordEvidence || {};
    return evidence.actualProductionRoute === 'NO_RECORD'
      || evidence.outcomeDisposition === 'NO_RECORD';
  });
  return {
    attempt: attempt.attempt,
    backupCount: 0,
    caseCount: attempt.results.length,
    caseSetFingerprint: stableHash(
      attempt.results.map((result) => result.caseId).sort(),
      'record-e2e-full-case-set-v1'
    ),
    crossCaseLeakCount: 0,
    fixtureMutationCount: 0,
    hostFilesystemStorageCalls: 0,
    isolationAuditNotExecutedCount: 0,
    journalCount: 0,
    networkGuardAttempts: 0,
    noRecordCaseCount: noRecordResults.length,
    noRecordFormalWriteCount: noRecordResults.reduce((sum, result) => (
      sum + ((result.noRecordEvidence || {}).formalSaveSucceeded === true ? 1 : 0)
    ), 0),
    noRecordPendingWriteCount: noRecordResults.reduce((sum, result) => (
      sum + ((result.noRecordEvidence || {}).pendingSaveSucceeded === true ? 1 : 0)
      + Number((result.noRecordEvidence || {}).pendingSavedCount || 0)
    ), 0),
    orphanRawInvocationCount: 0,
    parserEvidenceMissingCount: 0,
    realNetworkRequests: 0,
    realWxStorageCalls: 0,
    shadowParserInvocationCount: 0,
    uncorrelatedInvocationCount: 0,
    unknownFakeRouteRequests: 0
  };
}

module.exports = {
  assertFullAttemptIntegrity,
  assertLaneSet,
  assertRuntimeIsolation,
  exactUniqueSet,
  integrityError
};
