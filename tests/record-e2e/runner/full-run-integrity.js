const { stableHash } = require('../../../utils/record-state-diff');
const {
  deriveReceivablePaymentKind,
  getReceivableRemainingBalance,
  normalizeMoneyToCents
} = require('../../../utils/payment-kind');
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

function assertClientRouteIntegrity(result) {
  const evidence = result.routeEvidence || {};
  const clientRoute = String(evidence.clientRoute || '').toUpperCase();
  if (!['FAST_LOCAL', 'ASK_USER', 'AUTO_DEEP', 'SAFE_BLOCKED'].includes(clientRoute)) {
    return;
  }
  const manualDeep = Number(evidence.manualDeepRequestCount || 0);
  const automaticDeep = Number(evidence.automaticDeepRequestCount || 0);
  const totalAi = Number(evidence.totalAiRequestCount || 0);
  const fail = (reason, detail = {}) => {
    throw integrityError(
      'CLIENT_ROUTE_INTEGRITY_MISMATCH',
      `${result.caseId} ${clientRoute} client route integrity failed: ${reason}`,
      Object.assign({ clientRoute, routeEvidence: evidence }, detail)
    );
  };

  if (manualDeep !== 0) fail('manual Deep must remain zero', { manualDeep });
  if (evidence.automaticStageMutation === true) {
    fail('automatic route stage must not mutate business state');
  }

  if (clientRoute === 'FAST_LOCAL') {
    if (automaticDeep !== 0 || totalAi !== 0) {
      fail('FAST_LOCAL must not call AI', { automaticDeep, totalAi });
    }
    return;
  }
  if (clientRoute === 'ASK_USER') {
    if (automaticDeep !== 0 || totalAi !== 0) {
      fail('ASK_USER must not call AI', { automaticDeep, totalAi });
    }
    if (evidence.formalSaveBlocked !== true) {
      fail('ASK_USER must block formal save');
    }
    if (evidence.entrySurface === 'FULL_PAGE' && !evidence.activeQuestion) {
      fail('FULL_PAGE ASK_USER must expose one active question');
    }
    return;
  }
  if (clientRoute === 'SAFE_BLOCKED') {
    if (automaticDeep !== 0 || totalAi !== 0) {
      fail('SAFE_BLOCKED must not call AI', { automaticDeep, totalAi });
    }
    if (evidence.formalSaveBlocked !== true) fail('SAFE_BLOCKED must block formal save');
    return;
  }

  const identity = evidence.requestIdentity || {};
  const missingIdentity = [
    'requestId', 'draftRevision', 'confirmationSessionId',
    'originalTextFingerprint', 'requestedRoute'
  ].filter((field) => !String(identity[field] || '').trim());
  if (automaticDeep !== 1 || totalAi !== 1
    || Number(evidence.standardAIRequestCount || 0) !== 0) {
    fail('AUTO_DEEP must issue exactly one automatic Deep request', {
      automaticDeep,
      standardAi: Number(evidence.standardAIRequestCount || 0),
      totalAi
    });
  }
  const identityRequired = evidence.entrySurface === 'FULL_PAGE';
  if ((identityRequired && missingIdentity.length)
    || String(identity.requestedRoute) !== 'AUTO_DEEP') {
    fail('AUTO_DEEP request identity is incomplete', { identity, missingIdentity });
  }
  if (evidence.safetyEvaluated !== true || evidence.preflightEvaluated !== true) {
    fail('AUTO_DEEP result must pass through safety and preflight');
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

function auditPaymentCommits(result) {
  const audit = {
    duplicatePaymentCommitCount: 0,
    overpaymentCommitCount: 0,
    paymentKindBalanceMismatchCount: 0
  };
  const effectiveOperation = String(
    result.routeEvidence && result.routeEvidence.effectiveOperation || ''
  );
  if (effectiveOperation !== 'record_payment') return audit;

  const diff = result.businessDiff || {};
  const payments = diff.payments && Array.isArray(diff.payments.created)
    ? diff.payments.created.filter((payment) => payment && payment.receivableId)
    : [];
  const receivableUpdates = diff.receivables && Array.isArray(diff.receivables.updated)
    ? diff.receivables.updated
    : [];
  audit.duplicatePaymentCommitCount = Math.max(0, payments.length - 1);

  payments.forEach((payment) => {
    const update = receivableUpdates.find((item) => (
      item && String(item.id || '') === String(payment.receivableId || '')
    ));
    if (!update || !update.before || !update.after) {
      audit.paymentKindBalanceMismatchCount += 1;
      return;
    }
    const balance = getReceivableRemainingBalance(
      update.before.amount,
      update.before.paidAmount || 0
    );
    const classification = deriveReceivablePaymentKind({
      isLinkedReceivable: true,
      paymentAmount: payment.amount,
      remainingBefore: balance.remainingAmount
    });
    if (classification.errorCode === 'PAYMENT_EXCEEDS_REMAINING') {
      audit.overpaymentCommitCount += 1;
      return;
    }
    const afterPaid = normalizeMoneyToCents(update.after.paidAmount || 0);
    const expectedPaidCents = balance.paidCents + classification.paymentAmountCents;
    const expectedStatus = classification.kind === 'final_payment' ? '已结清' : '部分收款';
    if (!balance.valid
      || !classification.ok
      || payment.kind !== classification.kind
      || !afterPaid.valid
      || afterPaid.cents !== expectedPaidCents
      || update.after.status !== expectedStatus) {
      audit.paymentKindBalanceMismatchCount += 1;
    }
  });
  return audit;
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

  const voiceEvidence = result.voiceCompletionEvidence || {};
  assertAuditZero(
    Number(voiceEvidence.duplicateVoiceStandardAIRequestCount || 0),
    `${result.caseId}.duplicateVoiceStandardAIRequestCount`,
    'DUPLICATE_VOICE_STANDARD_AI_REQUEST'
  );
  if (voiceEvidence.voiceStandardEligible === true) {
    const route = String(voiceEvidence.actualRoute || '').toUpperCase();
    const totalCount = Number(voiceEvidence.AIRequestCount || 0);
    const standardCount = Number(voiceEvidence.standardAIRequestCount || 0);
    const deepCount = Number(voiceEvidence.deepAIRequestCount || 0);
    if (route !== 'AI_STANDARD'
      || totalCount !== 1
      || standardCount !== 1
      || deepCount !== 0) {
      throw integrityError(
        'VOICE_STANDARD_AI_REQUEST_COUNT_MISMATCH',
        `${result.caseId} eligible voice standard route must request Standard AI exactly once`,
        {
          actualRoute: route || null,
          AIRequestCount: totalCount,
          deepAIRequestCount: deepCount,
          standardAIRequestCount: standardCount
        }
      );
    }
  }
  assertAuditZero(
    Number(result.voiceAudit && result.voiceAudit.staleSessionAcceptedCount || 0),
    `${result.caseId}.voiceStaleSessionAcceptedCount`,
    'VOICE_STALE_SESSION_ACCEPTED'
  );

  const routeEvidence = result.routeEvidence || {};
  assertClientRouteIntegrity(result);
  assertAuditZero(
    Number(routeEvidence.duplicateDeepReviewInvocationCount || 0),
    `${result.caseId}.duplicateDeepReviewInvocationCount`,
    'DUPLICATE_DEEP_REVIEW_INVOCATION'
  );
  assertAuditZero(
    Number(routeEvidence.duplicateDeepAIRequestCount || 0),
    `${result.caseId}.duplicateDeepAIRequestCount`,
    'DUPLICATE_DEEP_AI_REQUEST'
  );
  assertAuditZero(
    Number(routeEvidence.quotationLocalEvidenceDropCount || 0),
    `${result.caseId}.quotationLocalEvidenceDropCount`,
    'QUOTATION_LOCAL_EVIDENCE_DROPPED'
  );
  assertAuditZero(
    Number(routeEvidence.untrustedQuotationIdPromotionCount || 0),
    `${result.caseId}.untrustedQuotationIdPromotionCount`,
    'UNTRUSTED_QUOTATION_ID_PROMOTED'
  );
  [
    ['unconfirmedQuotationIdAcceptedCount', 'UNCONFIRMED_QUOTATION_ID_ACCEPTED'],
    ['aiQuotationIdPromotedCount', 'AI_QUOTATION_ID_PROMOTED'],
    ['dangerousQuotationSelectedCount', 'DANGEROUS_QUOTATION_SELECTED'],
    ['dangerousQuotationFieldInheritanceCount', 'DANGEROUS_QUOTATION_FIELD_INHERITED'],
    ['quotationAutoSelectionCount', 'QUOTATION_AUTO_SELECTED'],
    ['quotationSelectionMissingCount', 'QUOTATION_SELECTION_REQUIREMENT_MISSING']
  ].forEach(([field, code]) => {
    if (!Object.prototype.hasOwnProperty.call(routeEvidence, field)
      || !Number.isFinite(Number(routeEvidence[field]))) {
      throw integrityError(
        'QUOTATION_TRUST_AUDIT_MISSING',
        `${result.caseId}.${field} must be recorded by the actual runner`,
        { field, value: routeEvidence[field] }
      );
    }
    assertAuditZero(
      Number(routeEvidence[field]),
      `${result.caseId}.${field}`,
      code
    );
  });
  if (routeEvidence.quotationConversionDeepReviewEligible === true) {
    if (routeEvidence.clientRoute !== 'AUTO_DEEP'
      || Number(routeEvidence.automaticDeepRequestCount || 0) !== 1
      || Number(routeEvidence.manualDeepRequestCount || 0) !== 0
      || Number(routeEvidence.totalAiRequestCount || 0) !== 1) {
      throw integrityError(
        'QUOTATION_CONVERSION_AUTO_DEEP_INTEGRITY_MISMATCH',
        `${result.caseId} explicit quotation conversion must use one automatic trusted Deep request`,
        { routeEvidence }
      );
    }
  }

  const paymentAudit = auditPaymentCommits(result);
  assertAuditZero(
    paymentAudit.duplicatePaymentCommitCount,
    `${result.caseId}.duplicatePaymentCommitCount`,
    'DUPLICATE_PAYMENT_COMMIT_DETECTED'
  );
  assertAuditZero(
    paymentAudit.paymentKindBalanceMismatchCount,
    `${result.caseId}.paymentKindBalanceMismatchCount`,
    'PAYMENT_KIND_BALANCE_MISMATCH'
  );
  assertAuditZero(
    paymentAudit.overpaymentCommitCount,
    `${result.caseId}.overpaymentCommitCount`,
    'OVERPAYMENT_COMMIT_DETECTED'
  );
  // Voice completion propagation is asserted as a product boundary contract in
  // assert-case. Keeping it out of runner integrity allows the baseline to
  // report an actionable case failure instead of aborting as TEST_INFRA.

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
  const paymentAudits = attempt.results.map(auditPaymentCommits);
  return {
    attempt: attempt.attempt,
    backupCount: 0,
    caseCount: attempt.results.length,
    caseSetFingerprint: stableHash(
      attempt.results.map((result) => result.caseId).sort(),
      'record-e2e-full-case-set-v1'
    ),
    crossCaseLeakCount: 0,
    duplicatePaymentCommitCount: paymentAudits.reduce((sum, audit) => (
      sum + audit.duplicatePaymentCommitCount
    ), 0),
    duplicateDeepAIRequestCount: attempt.results.reduce((sum, result) => (
      sum + Number(
        result.routeEvidence
        && result.routeEvidence.duplicateDeepAIRequestCount
        || 0
      )
    ), 0),
    duplicateDeepReviewInvocationCount: attempt.results.reduce((sum, result) => (
      sum + Number(
        result.routeEvidence
        && result.routeEvidence.duplicateDeepReviewInvocationCount
        || 0
      )
    ), 0),
    duplicateVoiceStandardAIRequestCount: attempt.results.reduce((sum, result) => (
      sum + Number(
        result.voiceCompletionEvidence
        && result.voiceCompletionEvidence.duplicateVoiceStandardAIRequestCount
        || 0
      )
    ), 0),
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
    overpaymentCommitCount: paymentAudits.reduce((sum, audit) => (
      sum + audit.overpaymentCommitCount
    ), 0),
    parserEvidenceMissingCount: 0,
    paymentKindBalanceMismatchCount: paymentAudits.reduce((sum, audit) => (
      sum + audit.paymentKindBalanceMismatchCount
    ), 0),
    quotationLocalEvidenceDropCount: attempt.results.reduce((sum, result) => (
      sum + Number(
        result.routeEvidence
        && result.routeEvidence.quotationLocalEvidenceDropCount
        || 0
      )
    ), 0),
    realNetworkRequests: 0,
    realWxStorageCalls: 0,
    shadowParserInvocationCount: 0,
    uncorrelatedInvocationCount: 0,
    untrustedQuotationIdPromotionCount: attempt.results.reduce((sum, result) => (
      sum + Number(
        result.routeEvidence
        && result.routeEvidence.untrustedQuotationIdPromotionCount
        || 0
      )
    ), 0),
    unconfirmedQuotationIdAcceptedCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.routeEvidence
        && result.routeEvidence.unconfirmedQuotationIdAcceptedCount || 0)
    ), 0),
    aiQuotationIdPromotedCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.routeEvidence
        && result.routeEvidence.aiQuotationIdPromotedCount || 0)
    ), 0),
    dangerousQuotationSelectedCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.routeEvidence
        && result.routeEvidence.dangerousQuotationSelectedCount || 0)
    ), 0),
    dangerousQuotationFieldInheritanceCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.routeEvidence
        && result.routeEvidence.dangerousQuotationFieldInheritanceCount || 0)
    ), 0),
    quotationAutoSelectionCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.routeEvidence
        && result.routeEvidence.quotationAutoSelectionCount || 0)
    ), 0),
    quotationSelectionMissingCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.routeEvidence
        && result.routeEvidence.quotationSelectionMissingCount || 0)
    ), 0),
    unknownFakeRouteRequests: 0,
    voiceEvidenceMissingCount: attempt.results.reduce((sum, result) => {
      if (result.inputChannel !== 'VOICE_TRANSCRIPT') return sum;
      const evidence = result.voiceCompletionEvidence || {};
      return sum + Number(
        evidence.voiceCompletionEvidencePresent !== true
        || evidence.parseHybridReceivedVoiceEvidence !== true
        || evidence.voiceCompletionEvidenceStatus !== 'COMPLETED'
      );
    }, 0),
    voiceFingerprintMismatchCount: attempt.results.reduce((sum, result) => {
      if (result.inputChannel !== 'VOICE_TRANSCRIPT') return sum;
      const evidence = result.voiceCompletionEvidence || {};
      return sum + Number(
        evidence.voiceCompletionEvidencePresent === true
        && evidence.voiceFingerprintMatched !== true
      );
    }, 0),
    voiceStaleSessionAcceptedCount: attempt.results.reduce((sum, result) => (
      sum + Number(result.voiceAudit && result.voiceAudit.staleSessionAcceptedCount || 0)
    ), 0)
  };
}

module.exports = {
  auditPaymentCommits,
  assertFullAttemptIntegrity,
  assertLaneSet,
  assertRuntimeIsolation,
  exactUniqueSet,
  integrityError
};
