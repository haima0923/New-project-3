const {
  FAILURE_OWNERSHIPS,
  OWNERSHIP_CONFIDENCES
} = require('./constants');

const OBSERVABILITY_COLLECTIONS = new Set([
  'aiParseLogs',
  'operationLogs'
]);
const FORMAL_COLLECTIONS = new Set([
  'customers',
  'orders',
  'payments',
  'quotations',
  'receivables',
  'todos'
]);
const SELECTION_CAPABILITIES = new Set([
  'SELECT_CUSTOMER',
  'SELECT_DEPOSIT_ORDER',
  'SELECT_ORDER',
  'SELECT_QUOTATION',
  'SELECT_RECEIVABLE'
]);
function failedAssertions(result) {
  return (result.assertions || []).filter((assertion) => assertion.pass === false);
}

function failedNames(result) {
  return failedAssertions(result).map((assertion) => assertion.name);
}

function laneResult(result, laneName) {
  return (result.laneResults || []).find((lane) => lane.lane === laneName) || null;
}

function ownership(ownershipName, confidence, evidence) {
  if (!FAILURE_OWNERSHIPS.includes(ownershipName)) {
    throw Object.assign(new Error(`Unknown failure ownership ${ownershipName}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  if (!OWNERSHIP_CONFIDENCES.includes(confidence)) {
    throw Object.assign(new Error(`Unknown ownership confidence ${confidence}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  return {
    failureOwnership: ownershipName,
    ownershipConfidence: confidence,
    ownershipEvidence: evidence
  };
}

function exactReplayIsSemanticallyHealthy(result) {
  const replay = result.transactionReplayEvidence || {};
  return Boolean(
    replay.firstStatus === 'COMMITTED'
    && replay.firstCommitSucceeded === true
    && replay.replay
    && replay.replay.status === 'ALREADY_COMMITTED'
    && replay.sameIdentity === true
    && replay.materialUnchanged === true
    && replay.currentControlMatchesFirst === true
    && replay.receiptSemanticEqual === true
    && replay.targetFingerprintEqual === true
    && replay.firstIdempotentReplay === false
    && replay.revisionDelta === 0
    && replay.receiptCountDelta === 0
    && replay.businessBundleEqual === true
    && replay.replayStats
    && replay.replayStats.writes === 0
    && replay.replayStats.removals === 0
    && replay.journalCount === 0
    && replay.backupCount === 0
  );
}

function concurrentCasIsSemanticallyHealthy(result) {
  const concurrent = result.concurrentEvidence || {};
  return Boolean(
    concurrent.baseFingerprintEqual === true
    && concurrent.commitAStatus === 'COMMITTED'
    && concurrent.committedA === true
    && concurrent.committedB === false
    && concurrent.commitAReceiptPresent === true
    && concurrent.firstCommitPrimaryWrites === 1
    && concurrent.secondCommitAttempted === true
    && concurrent.staleDetected === true
    && concurrent.secondCommitAllWrites === 0
    && concurrent.secondCommitPrimaryWrites === 0
    && concurrent.secondCommitJournalWrites === 0
    && concurrent.secondCommitBackupWrites === 0
    && concurrent.secondCommitRevisionDelta === 0
    && concurrent.secondCommitReceiptCountDelta === 0
    && concurrent.pageADataPreserved === true
    && concurrent.pageBDataWritten === false
  );
}

function formalBusinessDiffIsEmpty(result) {
  return ['customers', 'orders', 'payments', 'quotations', 'receivables', 'todos']
    .every((collection) => {
      const diff = result.businessDiff && result.businessDiff[collection] || {};
      return (diff.created || []).length === 0
        && (diff.updated || []).length === 0
        && (diff.deleted || []).length === 0;
    });
}

function missingCapabilityOwnership(result) {
  const missing = result.surfaceEvidence && result.surfaceEvidence.missingCapabilities || [];
  if (!missing.length || result.failureCode !== 'REQUIRED_PAGE_CAPABILITY_MISSING') return null;
  const targets = result.surfaceEvidence.selectionTargets || [];
  const available = result.surfaceEvidence.availableCapabilities || {};
  const driver = result.pageEvidence && result.pageEvidence.pageDriverEvidence || {};
  const probes = driver.capabilityProbes || {};
  const interactionFailures = result.interactionEvidence
    && result.interactionEvidence.failures || [];
  const productionCalls = driver.productionBusinessCalls || {};
  const pageCalls = driver.pagePrimaryActionCalls || {};
  const capabilityEvidenceComplete = missing.every((capability) => {
    if (available[capability] !== false) return false;
    const probe = probes[capability] || {};
    if (probe.methodType !== 'undefined') return false;
    const matching = targets.filter((target) => target.capability === capability);
    if (!SELECTION_CAPABILITIES.has(capability)) {
      return interactionFailures.some((failure) => (
        failure.reason === 'MISSING_PAGE_CAPABILITY'
      ));
    }
    return matching.length > 0
      && matching.every((target) => (
        target.fixtureTargetExists === true
        && interactionFailures.some((failure) => (
          failure.reason === 'MISSING_PAGE_CAPABILITY'
          && failure.selectedId === target.selectedId
        ))
      ));
  });
  const surfaceLane = laneResult(result, 'PAGE_PRODUCTION_OBSERVATION');
  const isolated = result.isolatedCommitEvidence || {};
  const noSaveSideEffects = (
    Number(pageCalls.saveFormal || 0) === 0
    && Number(productionCalls.saveConfirmedDraft || 0) === 0
    && Number(driver.productionStorageCalls
      && driver.productionStorageCalls.saveState || 0) === 0
    && isolated.committed !== true
    && formalBusinessDiffIsEmpty(result)
  );
  if (!capabilityEvidenceComplete || !noSaveSideEffects) {
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
      capabilityEvidenceComplete,
      missingCapabilities: missing.slice().sort(),
      noSaveSideEffects,
      reason: 'CAPABILITY_GAP_EVIDENCE_INCOMPLETE'
    });
  }
  return ownership('CONFIRMED_PRODUCT_CAPABILITY_GAP', 'HIGH', {
    availableCapabilities: Object.fromEntries(missing.map((capability) => [
      capability,
      available[capability]
    ])),
    businessDiffZero: formalBusinessDiffIsEmpty(result),
    capabilityEvidenceComplete,
    fixtureTargetsExist: capabilityEvidenceComplete,
    missingCapabilities: missing.slice().sort(),
    noPageOrBusinessSaveAttempt: noSaveSideEffects,
    pageLaneFailureCode: surfaceLane && surfaceLane.failureCode || '',
    saveSucceeded: false
  });
}

function observabilityOnlyFailure(result) {
  const names = failedNames(result);
  if (!names.length) return false;
  const stateNames = names.filter((name) => (
    /^([A-Za-z]+)\.(?:createdCount|updatedCount|deletedCount)/.test(name)
  ));
  return stateNames.length > 0 && names.every((name) => {
    const root = String(name).split('.')[0];
    return OBSERVABILITY_COLLECTIONS.has(root);
  });
}

function formalStateFailure(result) {
  return failedNames(result).some((name) => FORMAL_COLLECTIONS.has(String(name).split('.')[0]));
}

function aiRequestWasExecuted(result) {
  return Boolean((result.networkAudit && result.networkAudit.events || []).some((event) => (
    /\/api\/ai\/parse(?:\/deep)?$/.test(String(event.path || event.url || ''))
  )));
}

function initialCanonicalRawResult(result) {
  const raw = result && result.observationSemantics
    && result.observationSemantics.rawParser || {};
  const matches = raw.summary && raw.summary.canonicalLocalResults
    && raw.summary.canonicalLocalResults.filter((item) => item.phase === 'INITIAL_PARSE')
    || [];
  return matches.length === 1 ? matches[0].resultSummary || {} : {};
}

function classifyFailureOwnership(testCase, result) {
  if (!result || result.caseStatus === 'PASS') {
    return {
      failureOwnership: '',
      ownershipConfidence: '',
      ownershipEvidence: {}
    };
  }
  if (result.caseStatus !== 'CASE_FAIL') {
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'HIGH', {
      reason: 'RUNNER_OR_CONTRACT_EXECUTION_NOT_A_PRODUCT_RESULT',
      status: result.caseStatus
    });
  }

  const capability = missingCapabilityOwnership(result);
  if (capability) return capability;

  const rawParserContract = testCase.expected.rawParser
    || testCase.expected.observationSemantics
      && testCase.expected.observationSemantics.rawParser
    || null;
  if (rawParserContract && rawParserContract.assertionScope === 'REQUIRED') {
    const rawFailures = failedAssertions(result).filter((assertion) => (
      assertion.layer === 'RAW_PARSER' && assertion.name !== 'evidencePresent'
    ));
    if (rawFailures.length) {
      return ownership('CONFIRMED_LOCAL_PARSER_DEFECT', 'HIGH', {
        actualRawParser: result.observationSemantics
          && result.observationSemantics.rawParser || null,
        actualRoute: result.routeEvidence && result.routeEvidence.actualRoute || '',
        expectedRawParser: rawParserContract,
        failedRawAssertions: rawFailures.map((assertion) => assertion.name),
        reason: 'EXPLICIT_RAW_PARSER_CONTRACT_MISMATCH'
      });
    }
  }

  if (testCase.caseId === 'REC-E2E-REL-008') {
    return ownership('CONFIRMED_OPERATION_MAPPING_DEFECT', 'HIGH', {
      actualRawParser: result.observationSemantics
        && result.observationSemantics.rawParser || null,
      actualSemanticResult: result.observationSemantics
        && result.observationSemantics.semanticResult || null,
      expectedBusinessType: testCase.expected.result.businessType,
      expectedOperation: testCase.expected.result.operation,
      reason: 'READ_ONLY_CLUSTER_4A_CONFIRMED_QUOTATION_TO_ORDER_MAPPING_DEFECT',
      tamperGuardLaneStatus: laneResult(result, 'RELATION_REFERENCE_TAMPER_GUARD')
        && laneResult(result, 'RELATION_REFERENCE_TAMPER_GUARD').status || ''
    });
  }

  if (testCase.caseId === 'REC-E2E-VOICE-004') {
    return ownership('CONFIRMED_ROUTE_DEFECT', 'HIGH', {
      actualRoute: result.routeEvidence && result.routeEvidence.actualRoute || '',
      expectedRoute: testCase.expected.route,
      reason: 'READ_ONLY_CLUSTER_4A_CONFIRMED_VOICE_ROUTE_DIFFERENCE'
    });
  }

  if (testCase.caseId === 'REC-E2E-VOICE-006') {
    return ownership('OBSERVABILITY_EXPECTATION_MISMATCH', 'MEDIUM', {
      actualRawParser: result.observationSemantics
        && result.observationSemantics.rawParser || null,
      actualSemanticResult: result.observationSemantics
        && result.observationSemantics.semanticResult || null,
      reason: 'READ_ONLY_CLUSTER_4A_VOICE_ASYNC_OBSERVATION_BOUNDARY'
    });
  }

  if (testCase.caseId === 'REC-E2E-AMB-011') {
    return ownership('TEST_CONTRACT_MISMATCH_CANDIDATE', 'MEDIUM', {
      actualRoute: result.routeEvidence && result.routeEvidence.actualRoute || '',
      expectedRoute: testCase.expected.route,
      reason: 'READ_ONLY_CLUSTER_4A_TIMEOUT_CONTRACT_BOUNDARY'
    });
  }

  if (testCase.caseId === 'REC-E2E-PAGE-008') {
    const raw = result.observationSemantics && result.observationSemantics.rawParser || {};
    const rawResult = initialCanonicalRawResult(result);
    const semantic = result.observationSemantics
      && result.observationSemantics.semanticResult || {};
    const preflightCodes = result.preflightEvidence
      && result.preflightEvidence.blockingCodes || [];
    const editConsistency = result.pageEvidence
      && result.pageEvidence.pageEditConsistency || {};
    if (raw.status === 'RAW_PARSER_INVOKED'
      && rawResult.businessType === 'order'
      && rawResult.operation === null
      && semantic.businessType === 'order'
      && semantic.effectiveOperation === 'create_order'
      && preflightCodes.includes('MISSING_REQUIRED_FIELD')
      && editConsistency.consistent === true
      && formalBusinessDiffIsEmpty(result)) {
      return ownership('TEST_CONTRACT_MISMATCH_CANDIDATE', 'HIGH', {
        actualRawParser: raw,
        actualSemanticResult: semantic,
        actualRoute: result.routeEvidence && result.routeEvidence.actualRoute || '',
        editConsistency: true,
        formalBusinessDiffZero: true,
        missingRequiredFieldBlocked: true,
        reason: 'RAW_NULL_OPERATION_FIXED_AS_OBSERVATION; DUE_DATE_CONTRACT_STILL_BLOCKS'
      });
    }
  }

  if (result.entrySurface === 'HOME_QUICK'
    && result.pageEvidence
    && result.pageEvidence.pageEditConsistency
    && result.pageEvidence.pageEditConsistency.consistent === false) {
    return ownership('CONFIRMED_CONFIRMATION_DEFECT', 'HIGH', {
      businessSideEffects: !formalBusinessDiffIsEmpty(result),
      downstreamFinalStateEvaluation: 'SUPPRESSED_BY_PREFLIGHT',
      editChecks: result.pageEvidence.pageEditConsistency.checks,
      pagePreflightBlockingCodes: result.preflightEvidence
        && result.preflightEvidence.blockingCodes || [],
      productCodePath: 'pages/dashboard/dashboard.js:updateConfirmField'
    });
  }

  if (testCase.caseId === 'REC-E2E-PERSIST-003' && exactReplayIsSemanticallyHealthy(result)) {
    return ownership('TEST_CONTRACT_MISMATCH_CANDIDATE', 'HIGH', {
      actualPageSaveAttempts: result.transactionReplayEvidence.pageSaveAttempts,
      exactReplayLaneStatus: laneResult(result, 'TRANSACTION_EXACT_REPLAY')
        && laneResult(result, 'TRANSACTION_EXACT_REPLAY').status,
      firstCommitStatus: result.transactionReplayEvidence.firstStatus,
      replayStatus: result.transactionReplayEvidence.replay.status,
      semanticDeltasZero: true,
      exoneratedSubsystems: ['TRANSACTION_EXACT_REPLAY', 'RESTART_PERSISTENCE'],
      secondaryOwnershipFindings: failedNames(result)
        .filter((name) => name.startsWith('operationLogs.'))
        .map((name) => ({
          assertion: name,
          ownership: 'OBSERVABILITY_EXPECTATION_MISMATCH'
        }))
    });
  }

  if (testCase.caseId === 'REC-E2E-PERSIST-004'
    && concurrentCasIsSemanticallyHealthy(result)
    && failedNames(result).every((name) => name.startsWith('operationLogs.'))) {
    return ownership('EXPECTED_MAPPING_MISMATCH_CANDIDATE', 'HIGH', {
      actualOperationLogCreatedCount: (
        result.fullDiff.operationLogs && result.fullDiff.operationLogs.created || []
      ).length,
      casLaneStatus: laneResult(result, 'CONCURRENT_BASE_REVISION')
        && laneResult(result, 'CONCURRENT_BASE_REVISION').status,
      firstCommitStatus: result.concurrentEvidence.commitAStatus,
      secondCommitStatus: result.concurrentEvidence.commitB
        && result.concurrentEvidence.commitB.legacyStatus || '',
      staleWriteDeltasZero: true,
      exoneratedSubsystems: ['CONCURRENT_BASE_REVISION', 'RESTART_PERSISTENCE']
    });
  }

  if (testCase.caseId === 'REC-E2E-FIN-014') {
    const duplicate = result.duplicateTriggerEvidence || {};
    const duplicateHealthy = Boolean(
      duplicate.pageHandlerInvocationCount === 2
      && duplicate.legacyBusinessAttemptCount === 1
      && duplicate.transactionBeginCount === 1
      && duplicate.committedReceiptCount === 1
      && duplicate.financialRecordCount === 1
      && duplicate.revisionDelta === 1
      && duplicate.completionEvidencePresent === true
    );
    if (duplicateHealthy) {
      return ownership('TEST_CONTRACT_MISMATCH_CANDIDATE', 'HIGH', {
        duplicateTriggerLaneStatus: laneResult(result, 'PAGE_DUPLICATE_TRIGGER_GUARD')
          && laneResult(result, 'PAGE_DUPLICATE_TRIGGER_GUARD').status,
        exoneratedSubsystems: ['PAGE_DUPLICATE_TRIGGER_GUARD'],
        providerClassification: result.productionObservation
          && result.productionObservation.providerClassification || '',
        productionEligibility: result.productionObservation
          && result.productionObservation.productionEligibility || '',
        secondaryOwnershipFindings: failedNames(result)
          .filter((name) => name.startsWith('payments.') || name.startsWith('operationLogs.'))
          .map((name) => ({
            assertion: name,
            ownership: name.startsWith('operationLogs.')
              ? 'OBSERVABILITY_EXPECTATION_MISMATCH'
              : 'EXPECTED_MAPPING_MISMATCH_CANDIDATE'
          }))
      });
    }
  }

  if (/FIXTURE|TARGET_NOT_FOUND|TEST_DATA/.test(String(result.failureCode || ''))) {
    return ownership('FIXTURE_DATA_ERROR_CANDIDATE', 'MEDIUM', {
      failureCode: result.failureCode,
      failureStage: result.failureStage
    });
  }

  if (observabilityOnlyFailure(result)) {
    return ownership('OBSERVABILITY_EXPECTATION_MISMATCH', 'HIGH', {
      failedAssertions: failedNames(result),
      formalBusinessAssertionsFailed: false
    });
  }

  if (result.failureStage === 'LOCAL_PARSE_ERROR') {
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
      actualRoute: result.routeEvidence && result.routeEvidence.actualRoute || '',
      failedSemanticAssertions: failedAssertions(result)
        .filter((assertion) => (
          assertion.layer === 'RAW_PARSER'
          || assertion.layer === 'SEMANTIC_RESULT'
          || assertion.layer === 'PROPOSAL'
        ))
        .map((assertion) => assertion.name),
      inputReachedProductionMethod: Boolean(
        result.actualInput && result.actualInput.pageText === testCase.input.originalText
        || testCase.input.entrySurface === 'HEADLESS'
      ),
      reason: 'EXPECTED_ONLY_PARSE_DIFFERENCE_REQUIRES_INDEPENDENT_CONTRACT_REVIEW'
    });
  }

  if (result.failureStage === 'AI_NORMALIZE_ERROR') {
    if (aiRequestWasExecuted(result)) {
      return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
        aiProfile: testCase.ai.profile,
        fixtureKind: result.aiEvidence && result.aiEvidence.fixtureKind || '',
        failedSemanticAssertions: failedAssertions(result)
          .filter((assertion) => (
            assertion.layer === 'SEMANTIC_RESULT'
            || assertion.layer === 'PROPOSAL'
          ))
          .map((assertion) => assertion.name),
        fakeAiRequestExecuted: true,
        reason: 'EXPECTED_ONLY_AI_DIFFERENCE_REQUIRES_FIXTURE_AND_NORMALIZER_REVIEW'
      });
    }
    if (result.routeEvidence && result.routeEvidence.actualRoute !== testCase.expected.route) {
      return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
        actualRoute: result.routeEvidence.actualRoute,
        expectedRoute: testCase.expected.route,
        fakeAiRequestExecuted: false,
        firstResultDifference: failedNames(result)[0] || '',
        reason: 'ROUTE_DIFFERENCE_REQUIRES_PRODUCT_CONTRACT_REVIEW'
      });
    }
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
      aiProfile: testCase.ai.profile,
      fakeAiRequestExecuted: false,
      failedAssertions: failedNames(result)
    });
  }

  if (result.failureStage === 'ROUTE_ERROR') {
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
      actualRoute: result.routeEvidence && result.routeEvidence.actualRoute || '',
      expectedRoute: testCase.expected.route,
      reason: 'EXPECTED_ONLY_ROUTE_DIFFERENCE_REQUIRES_PRODUCT_CONTRACT_REVIEW'
    });
  }

  if (result.failureStage === 'PREFLIGHT_ERROR') {
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
      actualBlockingCodes: result.preflightEvidence
        && result.preflightEvidence.blockingCodes || [],
      actualDomainCanSaveFormal: result.preflightEvidence
        && result.preflightEvidence.domainCanSaveFormal,
      expectedBlockingCodes: testCase.expected.preflight.blockingCodes,
      expectedDomainCanSaveFormal: testCase.expected.preflight.domainCanSaveFormal,
      reason: 'EXPECTED_ONLY_PREFLIGHT_DIFFERENCE_REQUIRES_RULE_EVIDENCE_REVIEW'
    });
  }

  if (result.failureStage === 'CONFIRMATION_ERROR') {
    return ownership('CONFIRMED_CONFIRMATION_DEFECT', 'MEDIUM', {
      failedConfirmationAssertions: failedAssertions(result)
        .filter((assertion) => assertion.layer === 'CONFIRMATION')
        .map((assertion) => assertion.name)
    });
  }

  if (result.failureStage === 'LEGACY_BUSINESS_ERROR'
    || (result.failureStage === 'STATE_DIFF_ERROR' && formalStateFailure(result))) {
    return ownership('CONFIRMED_LEGACY_BUSINESS_DEFECT', 'MEDIUM', {
      failedStateAssertions: failedAssertions(result)
        .filter((assertion) => assertion.layer === 'STATE_DIFF'
          || assertion.layer === 'ISOLATED_COMMIT')
        .map((assertion) => assertion.name),
      isolatedCommitLaneStatus: laneResult(result, 'TEST_ONLY_ISOLATED_LEGACY_COMMIT')
        && laneResult(result, 'TEST_ONLY_ISOLATED_LEGACY_COMMIT').status || ''
    });
  }

  if (result.failureStage === 'STORAGE_TRANSACTION_ERROR') {
    return ownership('CONFIRMED_STORAGE_DEFECT', 'MEDIUM', {
      failedTransactionAssertions: failedAssertions(result)
        .filter((assertion) => assertion.layer === 'TRANSACTION_REPLAY'
          || assertion.layer === 'CONCURRENT')
        .map((assertion) => assertion.name)
    });
  }

  if (result.failureStage === 'SURFACE_ERROR') {
    return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
      failedSurfaceAssertions: failedAssertions(result)
        .filter((assertion) => assertion.layer === 'SURFACE')
        .map((assertion) => assertion.name),
      missingCapabilities: result.surfaceEvidence
        && result.surfaceEvidence.missingCapabilities || [],
      reason: 'SURFACE_STATUS_DIFFERENCE_REQUIRES_INDEPENDENT_PRODUCT_EVIDENCE'
    });
  }

  if (result.failureStage === 'STATE_DIFF_ERROR') {
    return ownership('EXPECTED_MAPPING_MISMATCH_CANDIDATE', 'LOW', {
      failedStateAssertions: failedAssertions(result)
        .filter((assertion) => assertion.layer === 'STATE_DIFF')
        .map((assertion) => assertion.name)
    });
  }

  return ownership('UNCLASSIFIED_REQUIRES_REVIEW', 'LOW', {
    failedAssertions: failedNames(result),
    failureCode: result.failureCode,
    failureStage: result.failureStage
  });
}

module.exports = {
  classifyFailureOwnership,
  concurrentCasIsSemanticallyHealthy,
  exactReplayIsSemanticallyHealthy,
  failedAssertions
};
