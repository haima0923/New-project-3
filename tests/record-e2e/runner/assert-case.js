const {
  isCollectionDiffEmpty,
  safeClone,
  stableSerialize
} = require('../../../utils/record-state-diff');

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

function resultFromEvidence(evidence) {
  const page = evidence.pageDerivationEvidence || evidence.pageEvidence || {};
  return page.afterEdits && page.afterEdits.parseResult || {};
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
  const expected = testCase.expected.result;
  const actual = resultFromEvidence(evidence);
  collector.check('RESULT', 'businessType', actual.intent, expected.businessType);
  collector.check('RESULT', 'operation', actual.operation, expected.operation);
  collector.check(
    'RESULT',
    'originalText',
    actual.original_text || actual.originalText || '',
    expected.originalText
  );
  Object.keys(expected.fields || {}).forEach((field) => {
    const actualPath = getPath(actual.fields || {}, RESULT_FIELD_ALIASES[field] || field);
    collector.check('RESULT', `fields.${field}`, actualPath.value, expected.fields[field]);
  });
  (expected.absentFields || []).forEach((field) => {
    const actualPath = getPath(actual.fields || {}, field);
    collector.check(
      'RESULT',
      `absentFields.${field}`,
      actualPath.found && actualPath.value !== '' && actualPath.value !== null,
      false
    );
  });
  const actualItems = actual.fields && actual.fields.items || [];
  collector.check('RESULT', 'items.length', actualItems.length, (expected.items || []).length);
  (expected.items || []).forEach((item, index) => {
    Object.keys(item).forEach((field) => {
      collector.check('RESULT', `items[${index}].${field}`,
        actualItems[index] && actualItems[index][field], item[field]);
    });
  });
  Object.keys(expected.allowedValues || {}).forEach((path) => {
    const value = getPath(actual, path).value;
    collector.check('RESULT', `allowedValues.${path}`, value, expected.allowedValues[path], {
      compare: (actualValue, allowed) => (
        Array.isArray(allowed) && allowed.some((item) => semanticEqual(actualValue, item))
      )
    });
  });
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
  if (assertion.assert === 'NOT_CONTAINS') {
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
  collector.check('ROUTE', 'route', evidence.routeEvidence.actualRoute, expected.route);
  collector.check(
    'PREFLIGHT',
    'domainCanSaveFormal',
    evidence.preflightEvidence.domainCanSaveFormal,
    expected.preflight.domainCanSaveFormal
  );
  collector.check(
    'PREFLIGHT',
    'domainCanSavePending',
    evidence.preflightEvidence.domainCanSavePending,
    expected.preflight.domainCanSavePending
  );
  collector.check(
    'PREFLIGHT',
    'blockingCodes',
    normalizeCodes(evidence.preflightEvidence.blockingCodes),
    normalizeCodes(expected.preflight.blockingCodes)
  );
  const page = evidence.pageDerivationEvidence || evidence.pageEvidence || {};
  const snapshot = page.afterEdits || {};
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
      evidence.productionObservation[key],
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
}

function assertLaneSpecific(testCase, evidence, collector) {
  const expected = testCase.expected;
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
      collector.check('TRANSACTION_REPLAY', 'businessBundleEqual',
        actual.businessBundleEqual, true);
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
  }
  if (testCase.execution.lanes.includes('RESTART_PERSISTENCE')) {
    const restart = evidence.restartEvidence || {};
    if (restart.notExecuted) {
      collector.check('RESTART', 'executed', false, true);
    } else {
    collector.check('RESTART', 'newRuntimeInstance', restart.newRuntimeInstance, true);
    collector.check('RESTART', 'equalToPostSave', restart.equalToPostSave, true);
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
    collector.check('CONCURRENT', 'secondCommitted', concurrent.committedB, false);
    collector.check('CONCURRENT', 'staleDetected', concurrent.staleDetected, true);
    collector.check('CONCURRENT', 'pageADataPreserved', concurrent.pageADataPreserved, true);
    if (contract.secondCommitStatus) {
      collector.check(
        'CONCURRENT',
        'secondCommitStatus',
        concurrent.errorB && concurrent.errorB.code || concurrent.commitB && concurrent.commitB.status,
        contract.secondCommitStatus,
        {
          compare: (actual, wanted) => String(actual || '').includes(String(wanted || '').replace('LEGACY_', ''))
        }
      );
    }
  }
}

const STAGE_ORDER = [
  'INPUT',
  'ROUTE',
  'RESULT',
  'PREFLIGHT',
  'CONFIRMATION',
  'PRODUCTION_OBSERVATION',
  'SURFACE',
  'ISOLATED_COMMIT',
  'TRANSACTION_REPLAY',
  'DUPLICATE_TRIGGER',
  'CONCURRENT',
  'STATE_DIFF',
  'RESTART'
];

function failureStageFor(assertion, testCase) {
  if (assertion.layer === 'RESULT') {
    return testCase.ai.profile === 'LOCAL_ONLY' ? 'LOCAL_PARSE_ERROR' : 'AI_NORMALIZE_ERROR';
  }
  return {
    INPUT: 'INPUT_EVENT_ERROR',
    ROUTE: 'ROUTE_ERROR',
    PREFLIGHT: 'PREFLIGHT_ERROR',
    CONFIRMATION: 'CONFIRMATION_ERROR',
    PRODUCTION_OBSERVATION: 'PREFLIGHT_ERROR',
    SURFACE: 'SURFACE_ERROR',
    ISOLATED_COMMIT: 'LEGACY_BUSINESS_ERROR',
    TRANSACTION_REPLAY: 'STORAGE_TRANSACTION_ERROR',
    DUPLICATE_TRIGGER: 'SAVE_DECISION_ERROR',
    CONCURRENT: 'STORAGE_TRANSACTION_ERROR',
    STATE_DIFF: 'STATE_DIFF_ERROR',
    RESTART: 'RESTART_PERSISTENCE_ERROR'
  }[assertion.layer] || 'STATE_DIFF_ERROR';
}

function assertCase(testCase, evidence, options = {}) {
  const collector = createCollector();
  if (testCase.input.channel === 'TYPED_TEXT' && testCase.input.entrySurface !== 'HEADLESS') {
    collector.check(
      'INPUT',
      'typedPageText',
      evidence.actualInput.pageText,
      testCase.input.originalText
    );
  }
  assertExpectedResult(testCase, evidence, collector);
  assertProductionLayers(testCase, evidence, collector);
  assertLaneSpecific(testCase, evidence, collector);
  assertDiffContract(testCase.expected.stateDiff.business, evidence.businessDiff, collector, 'STATE_DIFF');
  assertDiffContract(testCase.expected.stateDiff.full, evidence.fullDiff, collector, 'STATE_DIFF');

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
    RESULT: observationName,
    PREFLIGHT: observationName,
    CONFIRMATION: observationName,
    PRODUCTION_OBSERVATION: observationName,
    SURFACE: observationName,
    ISOLATED_COMMIT: 'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
    STATE_DIFF: 'TEST_ONLY_ISOLATED_LEGACY_COMMIT',
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
  const hasRunnerLaneError = (evidence.laneResults || []).some((item) => (
    item.status === 'RUNNER_ERROR' || item.status === 'BLOCKED'
  ));
  return {
    assertions: collector.assertions,
    caseStatus: hasRunnerLaneError
      ? 'RUNNER_ERROR'
      : (failures.length ? 'CASE_FAIL' : 'PASS'),
    failedAssertionCount: failures.length,
    failureCode: first ? `ASSERTION_FAILED:${first.name}` : '',
    failureStage: first ? failureStageFor(first, testCase) : '',
    passedAssertionCount: collector.assertions.length - failures.length
  };
}

module.exports = {
  assertCase,
  getPath,
  semanticEqual
};
