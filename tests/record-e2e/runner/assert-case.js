const {
  isCollectionDiffEmpty,
  safeClone,
  stableSerialize
} = require('../../../utils/record-state-diff');
const { baseLane, finalizeLane, missingExecutionEvidence } = require('./lane-state');
const {
  RAW_PARSER_STATUSES,
  expectedOutcome,
  expectedProposal,
  expectedRawParser,
  expectedSemanticResult,
  observationContract,
  rawParserObservationErrors
} = require('./observation-semantics');

function enforceLaneResultCompleteness(testCase, evidence) {
  const expected = testCase.execution.lanes || [];
  const actual = evidence.laneResults || [];
  const expectedSet = new Set(expected);
  expected.forEach((laneName) => {
    const matches = actual.filter((lane) => lane && lane.lane === laneName);
    if (matches.length === 1) return;
    if (!matches.length) {
      const missing = baseLane(laneName);
      missingExecutionEvidence(missing, ['REQUIRED_LANE_RESULT_MISSING']);
      actual.push(missing);
      return;
    }
    matches.forEach((lane) => {
      missingExecutionEvidence(lane, ['DUPLICATE_LANE_RESULT']);
    });
  });
  actual
    .filter((lane) => lane && !expectedSet.has(lane.lane))
    .forEach((lane) => {
      missingExecutionEvidence(lane, ['UNEXPECTED_LANE_RESULT']);
    });
  evidence.laneResults = actual;
}

function semanticEqual(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return stableSerialize(left) === stableSerialize(right);
}

function getPath(target, path) {
  if (!path) return target;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cursor = target;
  for (const part of parts) {
    if (cursor === null || cursor === undefined
      || !Object.prototype.hasOwnProperty.call(Object(cursor), part)) {
      return { found: false, value: undefined };
    }
    cursor = cursor[part];
  }
  return { found: true, value: cursor };
}

function normalizeCodes(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(String))).sort();
}

function createCollector() {
  const assertions = [];
  function check(layer, name, actual, expected, options = {}) {
    const pass = options.compare
      ? options.compare(actual, expected)
      : semanticEqual(actual, expected);
    assertions.push({
      actual: safeClone(actual),
      expected: safeClone(expected),
      layer,
      name,
      pass
    });
    return pass;
  }
  return { assertions, check };
}

function resultFromEvidence(testCase, evidence) {
  return evidence.observationSemantics && evidence.observationSemantics.proposal || {};
}

function requireObservationEvidence(evidence) {
  const observation = evidence && evidence.observationSemantics;
  const missing = [];
  if (!observation || observation.contractVersion
    !== 'record-e2e-observation-semantics-v1') {
    missing.push('OBSERVATION_CONTRACT');
  }
  if (!observation || !observation.rawParser) {
    missing.push('RAW_PARSER');
  } else {
    missing.push(...rawParserObservationErrors(observation.rawParser));
  }
  if (!observation || !observation.semanticResult
    || !observation.semanticResult.source) {
    missing.push('SEMANTIC_RESULT');
  }
  if (!observation || !observation.proposal || !observation.proposal.source) {
    missing.push('PROPOSAL');
  }
  if (!observation || !observation.outcome
    || observation.outcome.source !== 'STATE_DIFF_AND_COMMIT') {
    missing.push('OUTCOME');
  }
  if (missing.length) {
    throw Object.assign(new Error(
      `Observation semantics evidence missing: ${missing.join(',')}`
    ), {
      code: 'LANE_EXECUTION_EVIDENCE_MISSING',
      missingEvidence: missing
    });
  }
}

const RESULT_FIELD_ALIASES = Object.freeze({
  depositAmount: 'depositAmount',
  orderDeliveryDate: 'dueDate',
  paymentDate: 'dueDate',
  receivableAmount: 'amount',
  receivableDueDate: 'dueDate',
  todoRemindDate: 'dueDate'
});

function assertExpectedResult(testCase, evidence, collector) {
  const expected = expectedProposal(testCase);
  const actual = resultFromEvidence(testCase, evidence);
  const expectedContract = observationContract(testCase);
  if (expectedContract) {
    collector.check(
      'PROPOSAL',
      'source',
      actual.source,
      expectedContract.proposal.source
    );
    collector.check(
      'PROPOSAL',
      'operationSource',
      actual.operationSource,
      expectedContract.proposal.operationSource
    );
  }
  collector.check('PROPOSAL', 'businessType', actual.businessType, expected.businessType);
  collector.check('PROPOSAL', 'operation', actual.operation, expected.operation);
  collector.check(
    'PROPOSAL',
    'originalText',
    actual.originalText || '',
    expected.originalText
  );
  Object.keys(expected.fields || {}).forEach((field) => {
    const actualPath = getPath(actual.fields || {}, RESULT_FIELD_ALIASES[field] || field);
    collector.check('PROPOSAL', `fields.${field}`, actualPath.value, expected.fields[field]);
  });
  (expected.absentFields || []).forEach((field) => {
    const actualPath = getPath(actual.fields || {}, field);
    collector.check(
      'PROPOSAL',
      `absentFields.${field}`,
      actualPath.found && actualPath.value !== '' && actualPath.value !== null,
      false
    );
  });
  const actualItems = actual.items || actual.fields && actual.fields.items || [];
  collector.check('PROPOSAL', 'items.length', actualItems.length, (expected.items || []).length);
  (expected.items || []).forEach((item, index) => {
    Object.keys(item).forEach((field) => {
      collector.check('PROPOSAL', `items[${index}].${field}`,
        actualItems[index] && actualItems[index][field], item[field]);
    });
  });
  Object.keys(expected.allowedValues || {}).forEach((path) => {
    const fieldPath = getPath(actual.fields || {}, path);
    const value = fieldPath.found ? fieldPath.value : getPath(actual, path).value;
    collector.check('PROPOSAL', `allowedValues.${path}`, value, expected.allowedValues[path], {
      compare: (actualValue, allowed) => (
        Array.isArray(allowed) && allowed.some((item) => semanticEqual(actualValue, item))
      )
    });
  });
}

function assertObservationSemantics(testCase, evidence, collector) {
  const actual = evidence.observationSemantics || {};
  const raw = actual.rawParser || {};
  const initialCanonicalResults = raw.summary
    && raw.summary.canonicalLocalResults
    && raw.summary.canonicalLocalResults.filter((item) => item.phase === 'INITIAL_PARSE')
    || [];
  const directRawResults = raw.summary && raw.summary.directRawResults || [];
  const rawResult = initialCanonicalResults.length === 1
    ? initialCanonicalResults[0].resultSummary || {}
    : (directRawResults.length === 1
      ? directRawResults[0].resultSummary || {}
      : {});
  const semantic = actual.semanticResult || {};
  const outcome = actual.outcome || {};
  collector.check(
    'RAW_PARSER',
    'evidencePresent',
    rawParserObservationErrors(raw).length === 0,
    true
  );
  const rawExpected = expectedRawParser(testCase);
  if (rawExpected && rawExpected.assertionScope === 'REQUIRED') {
    collector.check(
      'RAW_PARSER',
      'requiredInvocation',
      raw.status,
      RAW_PARSER_STATUSES.INVOKED
    );
    collector.check(
      'RAW_PARSER',
      'requiredCanonicalResult',
      Boolean(Object.keys(rawResult).length),
      true
    );
    ['intent', 'businessType', 'operation'].forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(rawExpected, field)) return;
      collector.check('RAW_PARSER', field, rawResult[field], rawExpected[field]);
    });
  } else if (rawExpected
    && rawExpected.assertionScope === 'NOT_APPLICABLE_BY_PRODUCTION_PATH') {
    collector.check(
      'RAW_PARSER',
      'notApplicableByProductionPath',
      raw.status,
      RAW_PARSER_STATUSES.NOT_INVOKED
    );
  }
  const expectedSemantic = expectedSemanticResult(testCase);
  collector.check(
    'SEMANTIC_RESULT',
    'businessType',
    semantic.businessType,
    expectedSemantic.businessType
  );
  collector.check(
    'SEMANTIC_RESULT',
    'effectiveOperation',
    semantic.effectiveOperation,
    expectedSemantic.effectiveOperation
  );
  if (expectedSemantic.source) {
    collector.check(
      'SEMANTIC_RESULT',
      'source',
      semantic.source,
      expectedSemantic.source
    );
  }
  const expectedFinal = expectedOutcome(testCase);
  ['disposition', 'persistedRecordType', 'formalSaveSucceeded', 'pendingSaveSucceeded']
    .forEach((field) => {
      collector.check('OUTCOME', field, outcome[field], expectedFinal[field]);
    });
  collector.check(
    'OUTCOME',
    'actualSource',
    outcome.source,
    'STATE_DIFF_AND_COMMIT'
  );
}

function entryCounts(entry = {}) {
  return {
    createdCount: (entry.created || []).length,
    updatedCount: (entry.updated || []).length,
    deletedCount: (entry.deleted || []).length
  };
}

function changedRecord(entry, change, index = 0) {
  if (!entry) return undefined;
  if (change === 'CREATED') return (entry.created || [])[index];
  if (change === 'DELETED') return (entry.deleted || [])[index];
  if (change === 'UPDATED') {
    const update = (entry.updated || [])[index];
    return update && update.after;
  }
  return undefined;
}

function assertFieldAssertion(diff, assertion, collector, layerName) {
  const entry = diff[assertion.collection];
  const record = changedRecord(entry, assertion.change, assertion.index || 0);
  const actualPath = getPath(record, assertion.path);
  let pass;
  if (assertion.assert === 'ABSENT') {
    pass = !actualPath.found || actualPath.value === undefined || actualPath.value === null;
  } else if (assertion.assert === 'NOT_CONTAINS') {
    pass = actualPath.found && !String(actualPath.value || '').includes(String(assertion.value));
  } else if (assertion.assert === 'CONTAINS') {
    pass = actualPath.found && String(actualPath.value || '').includes(String(assertion.value));
  } else {
    pass = actualPath.found && semanticEqual(actualPath.value, assertion.value);
  }
  collector.assertions.push({
    actual: safeClone(actualPath.value),
    expected: safeClone(assertion.value),
    layer: layerName,
    name: `${assertion.collection}.${assertion.change}.${assertion.path}.${assertion.assert}`,
    pass
  });
}

function assertDiffContract(contract, diff, collector, layerName) {
  Object.keys(contract.collections || {}).forEach((collection) => {
    const actualCounts = entryCounts(diff[collection]);
    const expectedCounts = contract.collections[collection];
    Object.keys(expectedCounts).forEach((key) => {
      collector.check(layerName, `${collection}.${key}`, actualCounts[key], expectedCounts[key]);
    });
  });
  (contract.mustRemainUnchanged || []).forEach((collection) => {
    collector.check(
      layerName,
      `${collection}.mustRemainUnchanged`,
      isCollectionDiffEmpty({ [collection]: diff[collection] || {} }),
      true
    );
  });
  (contract.fieldAssertions || []).forEach((assertion) => {
    assertFieldAssertion(diff, assertion, collector, layerName);
  });
  (contract.relationAssertions || []).forEach((assertion) => {
    const source = changedRecord(
      diff[assertion.fromCollection],
      assertion.change || 'CREATED',
      assertion.index || 0
    );
    const actualId = getPath(source, assertion.fromPath).value;
    if (assertion.toId !== undefined) {
      collector.check(
        layerName,
        `${assertion.fromCollection}.${assertion.fromPath}->${assertion.toCollection}`,
        actualId,
        assertion.toId
      );
    } else {
      const target = diff[assertion.toCollection] || {};
      const changedIds = []
        .concat(target.created || [])
        .concat((target.updated || []).map((item) => item.after))
        .map((item) => item && item.id)
        .filter(Boolean);
      collector.check(
        layerName,
        `${assertion.fromCollection}.${assertion.fromPath}->${assertion.toCollection}`,
        changedIds.includes(actualId),
        true
      );
    }
  });
}

function assertProductionLayers(testCase, evidence, collector) {
  const expected = testCase.expected;
  const page = evidence.pageDerivationEvidence || evidence.pageEvidence || {};
  const snapshot = page.afterEdits || {};
  const actualPreflight = evidence.preflightEvidence;
  const actualProductionObservation = evidence.productionObservation;
  collector.check('ROUTE', 'route', evidence.routeEvidence.actualRoute, expected.route, {
    compare: (actual, wanted) => {
      const allowed = expected.allowedRoutes || [];
      return semanticEqual(actual, wanted)
        || allowed.some((item) => semanticEqual(actual, item));
    }
  });
  if (expected.route === 'NO_RECORD') {
    const noRecord = evidence.noRecordEvidence || {};
    collector.check('ROUTE', 'noRecordEligible', noRecord.noRecordEligible, true);
    collector.check('ROUTE', 'noRecordAsyncWorkCompleted', noRecord.asyncWorkCompleted, true);
    collector.check('ROUTE', 'noRecordBusinessEvidenceCount', noRecord.businessEvidenceCount, 0);
    collector.check('ROUTE', 'noRecordStructuredBusinessFieldCount', noRecord.structuredBusinessFieldCount, 0);
    collector.check('ROUTE', 'noRecordRelationEvidenceCount', noRecord.relationEvidenceCount, 0);
    collector.check('ROUTE', 'noRecordAIRequestCount', noRecord.AIRequestCount, 0);
    collector.check('OUTCOME', 'noRecordPendingSaveAttemptCount', noRecord.pendingSaveAttemptCount, 0);
    collector.check('OUTCOME', 'noRecordPendingSavedCount', noRecord.pendingSavedCount, 0);
    collector.check('OUTCOME', 'noRecordFormalSaveAttemptCount', noRecord.formalSaveAttemptCount, 0);
    collector.check('OUTCOME', 'noRecordBusinessStateDiffIsZero', noRecord.businessStateDiffIsZero, true);
    collector.check('OUTCOME', 'noRecordOutcomeDisposition', noRecord.outcomeDisposition, 'NO_RECORD');
    collector.check('OUTCOME', 'noRecordPersistedRecordType', noRecord.persistedRecordType, null);
  }
  collector.check(
    'PREFLIGHT',
    'domainCanSaveFormal',
    actualPreflight.domainCanSaveFormal,
    expected.preflight.domainCanSaveFormal
  );
  collector.check(
    'PREFLIGHT',
    'domainCanSavePending',
    actualPreflight.domainCanSavePending,
    expected.preflight.domainCanSavePending
  );
  (expected.confirmation.requiredFields || []).forEach((path) => {
    const actualPath = path === 'items'
      ? { found: Array.isArray(snapshot.items) && snapshot.items.length > 0 }
      : (path === 'originalText'
        ? {
          found: Boolean(
            snapshot.originalInput
            || snapshot.parseResult && (
              snapshot.parseResult.original_text
              || snapshot.parseResult.originalText
            )
          )
        }
        : getPath(snapshot.fields || {}, RESULT_FIELD_ALIASES[path] || path));
    collector.check(
      'CONFIRMATION',
      `requiredFields.${path}.modeled`,
      actualPath.found || (snapshot.missingFields || []).includes(RESULT_FIELD_ALIASES[path] || path),
      true
    );
  });
  const pageEditConsistency = page.pageEditConsistency;
  if (pageEditConsistency && pageEditConsistency.checks.length) {
    collector.check(
      'CONFIRMATION',
      'pageEditConsistency',
      pageEditConsistency.consistent,
      true
    );
  }
  collector.check(
    'PREFLIGHT',
    'blockingCodes',
    normalizeCodes(actualPreflight.blockingCodes),
    normalizeCodes(expected.preflight.blockingCodes)
  );
  collector.check(
    'CONFIRMATION',
    'missingFields',
    normalizeCodes(snapshot.missingFields),
    normalizeCodes(expected.confirmation.missingFields)
  );
  collector.check(
    'CONFIRMATION',
    'conflictFields',
    normalizeCodes(snapshot.conflictFields),
    normalizeCodes(expected.confirmation.conflictFields)
  );
  Object.keys(expected.productionObservation || {}).forEach((key) => {
    collector.check(
      'PRODUCTION_OBSERVATION',
      key,
      actualProductionObservation[key],
      expected.productionObservation[key],
      {
        compare: key === 'blockingCodes'
          ? (actual, wanted) => semanticEqual(normalizeCodes(actual), normalizeCodes(wanted))
          : undefined
      }
    );
  });
  const requiredCapabilities = testCase.interaction.requiredCapabilities || [];
  requiredCapabilities.forEach((capability) => {
    collector.check(
      'SURFACE',
      `requiredCapability.${capability}`,
      Boolean(evidence.surfaceEvidence.availableCapabilities[capability]),
      true
    );
  });
  (evidence.surfaceEvidence.selectionTargets || [])
    .filter((target) => target.requiredByContract)
    .forEach((target) => {
      const deliberatelyMissing = (
        target.selectionKind === 'orderId'
        && expected.preflight.blockingCodes.includes('ORDER_TARGET_NOT_FOUND')
      ) || (
        target.selectionKind === 'quotationId'
        && expected.preflight.blockingCodes.includes('QUOTATION_TARGET_NOT_FOUND')
      );
      collector.check(
        'SURFACE',
        `fixtureSelectionTarget.${target.selectionKind}.${target.selectedId}`,
        target.fixtureTargetExists,
        !deliberatelyMissing
      );
    });
  const selectedSurface = testCase.input.entrySurface === 'HOME_QUICK'
    ? expected.surface.home
    : expected.surface.fullPage;
  if (testCase.input.entrySurface !== 'HEADLESS') {
    const missingCapabilities = evidence.surfaceEvidence.missingCapabilities || [];
    const actualStatus = missingCapabilities.length
      ? 'BLOCKED'
      : (snapshot.requiresFullPage
        ? 'REQUIRES_FULL_PAGE'
        : (snapshot.effectiveCanSaveFormal ? 'CAN_COMPLETE' : 'BLOCKED'));
    collector.check('SURFACE', 'status', actualStatus, selectedSurface.status);
    collector.check(
      'SURFACE',
      'surfaceCanCompleteFormal',
      snapshot.surfaceCanCompleteFormal,
      selectedSurface.surfaceCanCompleteFormal
    );
    collector.check(
      'SURFACE',
      'effectiveCanSaveFormal',
      snapshot.effectiveCanSaveFormal,
      selectedSurface.effectiveCanSaveFormal
    );
  }
}

function assertLaneSpecific(testCase, evidence, collector) {
  const expected = testCase.expected;
  const proposalExpected = expectedProposal(testCase);
  if (testCase.execution.lanes.includes('RELATION_REFERENCE_TAMPER_GUARD')) {
    const actual = evidence.relationReferenceTamperEvidence || {};
    const contract = expected.relationReferenceTamper || {};
    const injectedId = testCase.execution.relationReferenceTamper
      && testCase.execution.relationReferenceTamper.injectedId;
    const rejected = actual.rejectedQuotationReferences || [];
    collector.check('RELATION_TAMPER', 'present', Boolean(
      evidence.relationReferenceTamperEvidence
    ), true);
    collector.check(
      'RELATION_TAMPER',
      'sourceDraft',
      actual.sourceDraft,
      'EXPLICIT_SECURITY_TEST_DRAFT'
    );
    collector.check(
      'RELATION_TAMPER',
      'injectedRelation.id',
      actual.injectedRelation && actual.injectedRelation.id,
      injectedId
    );
    collector.check(
      'RELATION_TAMPER',
      'injectedRelation.targetPath',
      actual.injectedRelation && actual.injectedRelation.targetPath,
      'fields.quotationId'
    );
    collector.check(
      'RELATION_TAMPER',
      'mutationPaths',
      actual.mutationPaths,
      ['fields.quotationId']
    );
    const injectedDraft = actual.draftAfterInjection || {};
    collector.check(
      'RELATION_TAMPER',
      'draft.businessType',
      injectedDraft.intent,
      proposalExpected.businessType
    );
    collector.check(
      'RELATION_TAMPER',
      'draft.operation',
      injectedDraft.operation,
      proposalExpected.operation
    );
    collector.check(
      'RELATION_TAMPER',
      'draft.originalText',
      injectedDraft.original_text || injectedDraft.originalText || '',
      proposalExpected.originalText
    );
    Object.keys(proposalExpected.fields || {}).forEach((field) => {
      const actualPath = getPath(
        injectedDraft.fields || {},
        RESULT_FIELD_ALIASES[field] || field
      );
      collector.check(
        'RELATION_TAMPER',
        `draft.fields.${field}`,
        actualPath.value,
        proposalExpected.fields[field]
      );
    });
    collector.check(
      'RELATION_TAMPER',
      'domainCanSaveFormal',
      actual.domainCanSaveFormal,
      contract.domainCanSaveFormal
    );
    collector.check(
      'RELATION_TAMPER',
      'blockingCodes',
      normalizeCodes(actual.blockingCodes),
      normalizeCodes(contract.blockingCodes)
    );
    collector.check(
      'RELATION_TAMPER',
      'injectedReferenceExcludedFromSafeCandidates',
      actual.injectedReferenceExcludedFromSafeCandidates,
      contract.injectedReferenceExcludedFromSafeCandidates
    );
    collector.check(
      'RELATION_TAMPER',
      'rejectedReferencePresent',
      rejected.some((item) => String(item.quotationId || '') === String(injectedId || '')),
      true
    );
    collector.check(
      'RELATION_TAMPER',
      'saveAttempted',
      actual.saveAttempted,
      contract.saveAttempted
    );
    collector.check('RELATION_TAMPER', 'pageSelectionMethodCalled',
      actual.pageSelectionMethodCalled, false);
    collector.check('RELATION_TAMPER', 'pageMethodInvocationCount',
      actual.pageMethodInvocationCount, 0);
    collector.check('RELATION_TAMPER', 'businessSaveCalled',
      actual.businessSaveCalled, false);
    collector.check('RELATION_TAMPER', 'businessSaveAttemptCount',
      actual.businessSaveAttemptCount, 0);
    collector.check('RELATION_TAMPER', 'storageSaveAttemptCount',
      actual.storageSaveAttemptCount, 0);
    collector.check('RELATION_TAMPER', 'storageWriteCount',
      actual.storageWriteCount, 0);
    collector.check('RELATION_TAMPER', 'transactionBeginCount',
      actual.transactionBeginCount, 0);
    collector.check('RELATION_TAMPER', 'activityAuditPerformed',
      actual.activityAudit && actual.activityAudit.auditPerformed, true);
    collector.check('RELATION_TAMPER', 'instrumentationPresent',
      actual.activityAudit && actual.activityAudit.instrumentationPresent, true);
    collector.check('RELATION_TAMPER', 'stateUnchanged', actual.stateUnchanged, true);
    collector.check(
      'RELATION_TAMPER',
      'businessDiffEmpty',
      isCollectionDiffEmpty(actual.businessDiff || {}),
      contract.formalBusinessDiff === 'ZERO_SIDE_EFFECTS'
    );
    collector.check(
      'RELATION_TAMPER',
      'preflightFingerprintPresent',
      Boolean(actual.preflightAfterInjection
        && actual.preflightAfterInjection.preflightFingerprint),
      true
    );
  }
  if (expected.isolatedExecution.enabled) {
    const isolated = evidence.isolatedCommitEvidence;
    collector.check('ISOLATED_COMMIT', 'present', Boolean(isolated), true);
    if (isolated) {
      collector.check('ISOLATED_COMMIT', 'marker', isolated.marker, expected.isolatedExecution.marker);
      collector.check(
        'ISOLATED_COMMIT',
        'status',
        isolated.committed
          ? (expected.isolatedExecution.action === 'SAVE_PENDING'
            ? 'TEST_ONLY_PENDING_COMMITTED'
            : 'TEST_ONLY_ISOLATED_COMMITTED')
          : 'BLOCKED',
        expected.isolatedExecution.status
      );
      if (isolated.prepared && isolated.prepared.businessHashBefore) {
        collector.check(
          'ISOLATED_COMMIT',
          'pageBusinessHashPreserved',
          isolated.prepared.businessHashAfter,
          isolated.prepared.businessHashBefore
        );
      }
    }
    if (expected.save) {
      collector.check(
        'ISOLATED_COMMIT',
        'save.action',
        expected.isolatedExecution.action,
        expected.save.action
      );
      collector.check(
        'ISOLATED_COMMIT',
        'save.status',
        isolated && isolated.committed
          ? (expected.isolatedExecution.action === 'SAVE_PENDING'
            ? 'PENDING_COMMITTED'
            : 'FORMAL_COMMITTED')
          : 'BLOCKED',
        expected.save.status
      );
    }
  }
  if (testCase.execution.lanes.includes('TRANSACTION_EXACT_REPLAY')) {
    const actual = evidence.transactionReplayEvidence || {};
    const contract = expected.transactionExactReplay;
    if (actual.notExecuted) {
      collector.check('TRANSACTION_REPLAY', 'executed', false, true);
    } else {
      collector.check('TRANSACTION_REPLAY', 'status',
        actual.replay && actual.replay.status, contract.replayStatus);
      collector.check('TRANSACTION_REPLAY', 'sameIdentity', actual.sameIdentity, true);
      collector.check('TRANSACTION_REPLAY', 'revisionDelta', actual.revisionDelta,
        contract.revisionDeltaOnReplay);
      collector.check('TRANSACTION_REPLAY', 'receiptCountDelta',
        actual.receiptCountDelta, contract.receiptCountDeltaOnReplay);
      collector.check('TRANSACTION_REPLAY', 'pageSaveAttempts',
        actual.pageSaveAttempts, contract.pageSaveAttempts);
      collector.check('TRANSACTION_REPLAY', 'replayPageSaveAttempts',
        actual.replayPageSaveAttempts, 0);
      collector.check('TRANSACTION_REPLAY', 'businessBundleEqual',
        actual.businessBundleEqual, true);
      collector.check('TRANSACTION_REPLAY', 'firstStatus',
        actual.firstStatus, contract.firstCommitStatus);
      collector.check('TRANSACTION_REPLAY', 'firstCommitSucceeded',
        actual.firstCommitSucceeded, true);
      collector.check('TRANSACTION_REPLAY', 'firstIdempotentReplay',
        actual.firstIdempotentReplay, false);
      collector.check('TRANSACTION_REPLAY', 'idempotentReplay',
        actual.replay && actual.replay.idempotentReplay, contract.idempotentReplay);
      collector.check('TRANSACTION_REPLAY', 'receiptSemanticEqual',
        actual.receiptSemanticEqual, true);
      collector.check('TRANSACTION_REPLAY', 'receiptIdentityEqual',
        actual.receiptIdentityEqual, true);
      collector.check('TRANSACTION_REPLAY', 'currentControlMatchesFirst',
        actual.currentControlMatchesFirst, true);
      collector.check('TRANSACTION_REPLAY', 'materialUnchanged',
        actual.materialUnchanged, true);
      collector.check('TRANSACTION_REPLAY', 'targetFingerprintEqual',
        actual.targetFingerprintEqual, true);
      collector.check('TRANSACTION_REPLAY', 'gatewayWrites',
        actual.replayStats && actual.replayStats.writes, 0);
      collector.check('TRANSACTION_REPLAY', 'gatewayRemovals',
        actual.replayStats && actual.replayStats.removals, 0);
      collector.check('TRANSACTION_REPLAY', 'journalCount', actual.journalCount, 0);
      collector.check('TRANSACTION_REPLAY', 'backupCount', actual.backupCount, 0);
    }
  }
  if (testCase.execution.lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD')) {
    const actual = evidence.duplicateTriggerEvidence || {};
    const contract = expected.pageDuplicateTrigger;
    [
      'triggerAttempts',
      'pageSaveHandlerAttempts',
      'transactionCommitAttempts',
      'secondTriggerStatus',
      'transactionExactReplay'
    ].forEach((key) => collector.check('DUPLICATE_TRIGGER', key, actual[key], contract[key]));
    collector.check('DUPLICATE_TRIGGER', 'sameUserAction', true, contract.sameUserAction);
    collector.check('DUPLICATE_TRIGGER', 'pageHandlerInvocationCount',
      actual.pageHandlerInvocationCount, contract.triggerAttempts);
    collector.check('DUPLICATE_TRIGGER', 'legacyBusinessAttemptCount',
      actual.legacyBusinessAttemptCount, 1);
    collector.check('DUPLICATE_TRIGGER', 'transactionBeginCount',
      actual.transactionBeginCount, contract.transactionCommitAttempts);
    collector.check('DUPLICATE_TRIGGER', 'storageSaveAttemptCount',
      actual.storageSaveAttemptCount, 1);
    collector.check(
      'DUPLICATE_TRIGGER',
      'transactionJournalWriteCount',
      actual.transactionJournalWriteCount > 0,
      true
    );
    collector.check('DUPLICATE_TRIGGER', 'committedReceiptCount',
      actual.committedReceiptCount, 1);
    collector.check('DUPLICATE_TRIGGER', 'financialRecordCount',
      actual.financialRecordCount, 1);
    collector.check('DUPLICATE_TRIGGER', 'revisionDelta',
      actual.revisionDelta, contract.expectedRevisionDelta);
    collector.check('DUPLICATE_TRIGGER', 'additionalBusinessDiff',
      actual.additionalBusinessDiffEmpty, contract.additionalBusinessDiff === 'EMPTY');
    collector.check('DUPLICATE_TRIGGER', 'providerWasNeverSetToReal',
      actual.testOnlyIdentitySeam && actual.testOnlyIdentitySeam.providerWasNeverSetToReal, true);
  }
  if (testCase.execution.lanes.includes('RESTART_PERSISTENCE')) {
    const restart = evidence.restartEvidence || {};
    if (restart.notExecuted) {
      collector.check('RESTART', 'executed', false, true);
    } else {
    collector.check('RESTART', 'newRuntimeInstance', restart.newRuntimeInstance, true);
    collector.check('RESTART', 'attemptCount', restart.attemptCount, expected.restart.attempts);
    collector.check('RESTART', 'equalToPostSave', restart.equalToPostSave, true);
    collector.check('RESTART', 'recordCountStable', restart.recordCountStable,
      expected.restart.recordCountStable);
    collector.check('RESTART', 'revisionDelta', restart.revisionDelta, 0);
    collector.check('RESTART', 'receiptCountDelta', restart.receiptCountDelta, 0);
    collector.check('RESTART', 'receiptPersisted', restart.receiptPersisted, true);
    collector.check('RESTART', 'receiptSemanticEqual', restart.receiptSemanticEqual, true);
    collector.check('RESTART', 'startupPrimaryWrites', restart.startupPrimaryWrites, 0);
    collector.check('RESTART', 'startupJournalWrites', restart.startupJournalWrites, 0);
    collector.check('RESTART', 'startupBackupWrites', restart.startupBackupWrites, 0);
    collector.check('RESTART', 'journalCount', restart.journalCount, 0);
    collector.check('RESTART', 'backupCount', restart.backupCount, 0);
    collector.check('RESTART', 'startupRecoveryStatus', restart.startupRecoveryStatus, 'CLEAN');
    collector.check(
      'RESTART',
      'additionalBusinessDiff',
      restart.additionalDiff
        ? isCollectionDiffEmpty(restart.additionalDiff.businessDiff)
        : false,
      true
    );
    }
  }
  if (testCase.execution.lanes.includes('CONCURRENT_BASE_REVISION')) {
    const concurrent = evidence.concurrentEvidence || {};
    const contract = expected.concurrentBaseRevision || {};
    collector.check('CONCURRENT', 'baseFingerprintEqual', concurrent.baseFingerprintEqual, true);
    collector.check('CONCURRENT', 'firstCommitted', concurrent.committedA, true);
    collector.check('CONCURRENT', 'firstStatus', concurrent.commitAStatus, 'COMMITTED');
    collector.check('CONCURRENT', 'firstReceiptPresent', concurrent.commitAReceiptPresent, true);
    collector.check('CONCURRENT', 'secondCommitted', concurrent.committedB, false);
    collector.check('CONCURRENT', 'secondCommitAttempted',
      concurrent.secondCommitAttempted, true);
    collector.check('CONCURRENT', 'sameBaseRevision',
      concurrent.baseRevisionA, concurrent.baseRevisionB);
    collector.check('CONCURRENT', 'firstCommitPrimaryWrites',
      concurrent.firstCommitPrimaryWrites, 1);
    collector.check('CONCURRENT', 'secondCommitPrimaryWrites',
      concurrent.secondCommitPrimaryWrites, 0);
    collector.check('CONCURRENT', 'secondCommitAllWrites',
      concurrent.secondCommitAllWrites, 0);
    collector.check('CONCURRENT', 'secondCommitJournalWrites',
      concurrent.secondCommitJournalWrites, 0);
    collector.check('CONCURRENT', 'secondCommitBackupWrites',
      concurrent.secondCommitBackupWrites, 0);
    collector.check('CONCURRENT', 'secondCommitRevisionDelta',
      concurrent.secondCommitRevisionDelta, 0);
    collector.check('CONCURRENT', 'secondCommitReceiptCountDelta',
      concurrent.secondCommitReceiptCountDelta, 0);
    collector.check('CONCURRENT', 'staleDetected', concurrent.staleDetected, true);
    collector.check('CONCURRENT', 'pageADataPreserved', concurrent.pageADataPreserved, true);
    collector.check('CONCURRENT', 'pageBDataWritten', concurrent.pageBDataWritten, false);
    if (contract.secondCommitStatus) {
      collector.check(
        'CONCURRENT',
        'secondCommitStatus',
        concurrent.errorB && concurrent.errorB.code || concurrent.commitB && concurrent.commitB.status,
        contract.secondCommitStatus,
        {
          compare: (actual, wanted) => (
            (wanted === 'REVISION_MISMATCH' && actual === 'LEGACY_SAVE_STALE')
            || actual === wanted
          )
        }
      );
    }
  }
}

const STAGE_ORDER = [
  'INPUT',
  'RAW_PARSER',
  'ROUTE',
  'SEMANTIC_RESULT',
  'PROPOSAL',
  'PAGE_DERIVATION',
  'PREFLIGHT',
  'CONFIRMATION',
  'PRODUCTION_OBSERVATION',
  'SURFACE',
  'RELATION_TAMPER',
  'ISOLATED_COMMIT',
  'TRANSACTION_REPLAY',
  'DUPLICATE_TRIGGER',
  'CONCURRENT',
  'STATE_DIFF',
  'OUTCOME',
  'RESTART'
];

function failureStageFor(assertion, testCase) {
  if (assertion.layer === 'RAW_PARSER') {
    return 'LOCAL_PARSE_ERROR';
  }
  if (assertion.layer === 'SEMANTIC_RESULT' || assertion.layer === 'PROPOSAL') {
    return testCase.ai.profile === 'LOCAL_ONLY' ? 'LOCAL_PARSE_ERROR' : 'AI_NORMALIZE_ERROR';
  }
  return {
    INPUT: 'INPUT_EVENT_ERROR',
    ROUTE: 'ROUTE_ERROR',
    PREFLIGHT: 'PREFLIGHT_ERROR',
    CONFIRMATION: 'CONFIRMATION_ERROR',
    PRODUCTION_OBSERVATION: 'PREFLIGHT_ERROR',
    SURFACE: 'SURFACE_ERROR',
    RELATION_TAMPER: 'PREFLIGHT_ERROR',
    ISOLATED_COMMIT: 'LEGACY_BUSINESS_ERROR',
    TRANSACTION_REPLAY: 'STORAGE_TRANSACTION_ERROR',
    DUPLICATE_TRIGGER: 'SAVE_DECISION_ERROR',
    CONCURRENT: 'STORAGE_TRANSACTION_ERROR',
    STATE_DIFF: 'STATE_DIFF_ERROR',
    OUTCOME: 'SAVE_DECISION_ERROR',
    RESTART: 'RESTART_PERSISTENCE_ERROR'
  }[assertion.layer] || 'STATE_DIFF_ERROR';
}

function assertCase(testCase, evidence, options = {}) {
  enforceLaneResultCompleteness(testCase, evidence);
  requireObservationEvidence(evidence);
  const collector = createCollector();
  if (testCase.input.channel === 'TYPED_TEXT' && testCase.input.entrySurface !== 'HEADLESS') {
    collector.check(
      'INPUT',
      'typedPageText',
      evidence.actualInput.pageText,
      testCase.input.originalText
    );
  }
  assertObservationSemantics(testCase, evidence, collector);
  assertExpectedResult(testCase, evidence, collector);
  assertProductionLayers(testCase, evidence, collector);
  if (testCase.execution.lanes.includes('PAGE_CONFIRMED_DRAFT_DERIVATION')) {
    collector.check(
      'PAGE_DERIVATION',
      'pageDraftDerived',
      Boolean(evidence.pageDerivationEvidence && evidence.pageDerivationEvidence.afterEdits),
      true
    );
  }
  assertLaneSpecific(testCase, evidence, collector);
  const hasSurfaceGap = (evidence.surfaceEvidence.missingCapabilities || []).length > 0;
  if (hasSurfaceGap) {
    collector.check(
      'SURFACE',
      'formalBusinessDiffEmpty',
      isCollectionDiffEmpty(evidence.businessDiff),
      true
    );
  } else {
    assertDiffContract(testCase.expected.stateDiff.business, evidence.businessDiff, collector, 'STATE_DIFF');
    assertDiffContract(testCase.expected.stateDiff.full, evidence.fullDiff, collector, 'STATE_DIFF');
  }

  if (options.mutateExpectedSentinel) {
    collector.check('STATE_DIFF', 'selfTest.wrongExpectedCount',
      (evidence.businessDiff.orders && evidence.businessDiff.orders.created || []).length,
      999);
  }
  const failures = collector.assertions.filter((item) => !item.pass);
  failures.sort((a, b) => STAGE_ORDER.indexOf(a.layer) - STAGE_ORDER.indexOf(b.layer));
  const first = failures[0] || null;
  const laneByName = new Map((evidence.laneResults || []).map((item) => [item.lane, item]));
  const observationName = testCase.execution.lanes.includes('HEADLESS_PRODUCTION_OBSERVATION')
    ? 'HEADLESS_PRODUCTION_OBSERVATION'
    : 'PAGE_PRODUCTION_OBSERVATION';
  const layerLane = {
    INPUT: observationName,
    ROUTE: observationName,
    RAW_PARSER: observationName,
    SEMANTIC_RESULT: observationName,
    PROPOSAL: (
      testCase.execution.lanes.includes('PAGE_CONFIRMED_DRAFT_DERIVATION')
        ? 'PAGE_CONFIRMED_DRAFT_DERIVATION'
        : observationName
    ),
    PREFLIGHT: observationName,
    CONFIRMATION: (
      testCase.execution.lanes.includes('PAGE_CONFIRMED_DRAFT_DERIVATION')
        ? 'PAGE_CONFIRMED_DRAFT_DERIVATION'
        : observationName
    ),
    PAGE_DERIVATION: 'PAGE_CONFIRMED_DRAFT_DERIVATION',
    PRODUCTION_OBSERVATION: observationName,
    SURFACE: observationName,
    RELATION_TAMPER: 'RELATION_REFERENCE_TAMPER_GUARD',
    ISOLATED_COMMIT: 'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
    STATE_DIFF: testCase.execution.lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')
      ? 'TEST_ONLY_ISOLATED_LEGACY_COMMIT'
      : observationName,
    OUTCOME: testCase.execution.lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')
      ? 'TEST_ONLY_ISOLATED_LEGACY_COMMIT'
      : observationName,
    TRANSACTION_REPLAY: 'TRANSACTION_EXACT_REPLAY',
    DUPLICATE_TRIGGER: 'PAGE_DUPLICATE_TRIGGER_GUARD',
    CONCURRENT: 'CONCURRENT_BASE_REVISION',
    RESTART: 'RESTART_PERSISTENCE'
  };
  collector.assertions.forEach((assertion) => {
    const lane = laneByName.get(layerLane[assertion.layer]);
    if (!lane) return;
    lane.assertions = lane.assertions || [];
    lane.assertions.push(assertion);
    if (!assertion.pass && !['RUNNER_ERROR', 'BLOCKED'].includes(lane.status)) {
      lane.status = 'CASE_FAIL';
      lane.failureStage = lane.failureStage || failureStageFor(assertion, testCase);
      lane.failureCode = lane.failureCode || `ASSERTION_FAILED:${assertion.name}`;
    }
  });
  (evidence.laneResults || []).forEach((lane) => {
    const lifecycleExecutionSucceeded = Boolean(
      lane.planned
      && lane.preconditionsChecked
      && lane.preconditionsPassed
      && lane.started
      && lane.primaryActionAttempted
      && lane.primaryActionSucceeded
      && lane.completionEvidencePresent
    );
    lane.executionStatus = lifecycleExecutionSucceeded
      ? 'PASS'
      : (lane.status === 'RUNNER_ERROR'
        ? 'RUNNER_ERROR'
        : (lane.status === 'BLOCKED' ? 'BLOCKED' : 'NOT_COMPLETED'));
    lane.assertionStatus = (lane.assertions || []).some((assertion) => !assertion.pass)
      ? 'FAIL'
      : 'PASS';
  });
  (evidence.laneResults || []).forEach(finalizeLane);
  const runnerLane = (evidence.laneResults || []).find((item) => item.status === 'RUNNER_ERROR');
  const blockedLane = (evidence.laneResults || []).find((item) => item.status === 'BLOCKED');
  const caseFailLane = (evidence.laneResults || []).find((item) => item.status === 'CASE_FAIL');
  let primary = first;
  const surfaceLane = (evidence.laneResults || []).find((item) => (
    item.failureCode === 'REQUIRED_PAGE_CAPABILITY_MISSING'
  ));
  const editSyncFailure = failures.find((item) => (
    item.layer === 'CONFIRMATION' && item.name === 'pageEditConsistency'
  ));
  if (surfaceLane) {
    primary = {
      layer: 'SURFACE',
      name: 'requiredCapability',
      failureCode: 'REQUIRED_PAGE_CAPABILITY_MISSING'
    };
  } else if (editSyncFailure) {
    primary = editSyncFailure;
  }
  const secondaryFindings = failures
    .filter((item) => item !== primary)
    .map((item) => ({
      failureCode: `ASSERTION_FAILED:${item.name}`,
      failureStage: failureStageFor(item, testCase),
      layer: item.layer,
      name: item.name
    }));
  const caseStatus = runnerLane
    ? 'RUNNER_ERROR'
    : (blockedLane
      ? 'BLOCKED'
      : (caseFailLane || failures.length ? 'CASE_FAIL' : 'PASS'));
  const lifecycleFailure = runnerLane || blockedLane;
  return {
    assertions: collector.assertions,
    caseStatus,
    failedAssertionCount: failures.length,
    failureCode: lifecycleFailure
      ? lifecycleFailure.failureCode
      : (surfaceLane
        ? 'REQUIRED_PAGE_CAPABILITY_MISSING'
        : (primary ? `ASSERTION_FAILED:${primary.name}` : '')),
    failureStage: lifecycleFailure
      ? lifecycleFailure.failureStage
      : (surfaceLane
        ? 'SURFACE_ERROR'
        : (primary ? failureStageFor(primary, testCase) : '')),
    primaryFailure: caseStatus === 'PASS' ? null : {
      code: lifecycleFailure
        ? lifecycleFailure.failureCode
        : (surfaceLane
          ? 'REQUIRED_PAGE_CAPABILITY_MISSING'
          : (primary ? `ASSERTION_FAILED:${primary.name}` : '')),
      layer: lifecycleFailure
        ? lifecycleFailure.failureStage
        : (surfaceLane ? 'SURFACE' : (primary && primary.layer || '')),
      name: lifecycleFailure
        ? lifecycleFailure.failureCode
        : (surfaceLane ? 'requiredCapability' : (primary && primary.name || '')),
      stage: lifecycleFailure
        ? lifecycleFailure.failureStage
        : (surfaceLane
          ? 'SURFACE_ERROR'
          : (primary ? failureStageFor(primary, testCase) : ''))
    },
    secondaryFindings,
    passedAssertionCount: collector.assertions.length - failures.length
  };
}

module.exports = {
  assertCase,
  failureStageFor,
  getPath,
  requireObservationEvidence,
  semanticEqual
};
