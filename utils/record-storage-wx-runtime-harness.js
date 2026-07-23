const { STORAGE_MIGRATION_MODES } = require('./record-storage-adapter-contract');
const { createRecordStorageCoordinator } = require('./record-storage-coordinator');
const { createWxRuntimeTestStorageGateway } = require('./record-storage-runtime-test-gateway');
const {
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('./record-storage-transaction-contract');
const { createPersistentRecordTransactionManager } = require('./record-storage-transaction');
const {
  getRecordStorageBusinessFingerprint,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('./record-storage-state-projector');
const { safeClone, stableHash, stableSerialize } = require('./record-state-diff');
const {
  RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS,
  RECORD_STORAGE_RUNTIME_TEST_KEYS,
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST,
  RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION,
  RECORD_STORAGE_RUNTIME_TEST_STATUSES,
  readWechatRuntimeEnvironment
} = require('./record-storage-runtime-test-contract');

const FIXED_COMMIT_TIME = '2026-07-23T08:00:00.000Z';
const SENSITIVE_SENTINEL = 'SENSITIVE_RUNTIME_SENTINEL_MUST_NOT_LEAK';

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createSyntheticBundle(variant = 'DEFAULT') {
  const base = {
    meta: {
      runtimeSynthetic: true,
      legacyUnknownMeta: 'preserve-me'
    },
    customers: [],
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    dunningRecords: [],
    todos: [],
    orderProgress: [],
    pendingNotes: [],
    aiParseLogs: [],
    dunningTemplates: [],
    productCatalog: [],
    operationLogs: [],
    deletedRecords: [],
    runtimeUnknownTopLevel: {
      marker: 'preserve-me',
      sensitiveProbe: SENSITIVE_SENTINEL
    }
  };
  if (variant === 'NO_META') delete base.meta;
  if (variant === 'MISSING_OPTIONAL') {
    delete base.productCatalog;
    delete base.operationLogs;
    delete base.deletedRecords;
  }
  if (variant === 'LARGE') base.runtimePadding = 'x'.repeat(32 * 1024);
  return base;
}

function buildTargetBundle(source, marker) {
  const target = stripRecordStorageControl(safeClone(source || {}));
  target.meta = Object.assign({}, target.meta || {}, {
    runtimeSynthetic: true,
    runtimeTransactionMarker: String(marker || 'target')
  });
  return target;
}

function buildTransactionInput(snapshot, suffix, targetBundle, overrides = {}) {
  const normalized = String(suffix || 'case').replace(/[^A-Za-z0-9_-]/g, '_');
  return Object.assign({
    transactionId: `runtime_txn_${normalized}`,
    planId: `runtime_plan_${normalized}`,
    planHash: `runtime_hash_${normalized}`,
    idempotencyKey: `runtime_idempotency_${normalized}`,
    baseRevision: snapshot.revision,
    baseFingerprint: snapshot.businessFingerprint,
    targetBundle: safeClone(targetBundle),
    committedAt: FIXED_COMMIT_TIME,
    writerSource: 'WX_RUNTIME_TEST',
    riskLevel: 'NORMAL'
  }, overrides);
}

function firstErrorCode(value) {
  if (value && Array.isArray(value.errors) && value.errors[0]) {
    return String(value.errors[0].code || '');
  }
  return String(value && value.code || '');
}

function caseResult(caseId, status, facts = {}) {
  const allowed = [
    'errorCode', 'baseRevision', 'targetRevision', 'revision', 'fingerprint',
    'previousFingerprint', 'peakBytes', 'limitSizeBytes', 'currentSizeBytes',
    'targetSizeBytes', 'journalSizeBytes', 'backupSizeBytes', 'receiptCount',
    'writes', 'reads', 'removals', 'requiresReload', 'scenario', 'recoveryStatus',
    'secondRecoveryStatus', 'keysRemaining', 'unknownFieldsPreserved',
    'optionalCollectionsPreserved', 'queueStatuses', 'collisionStatus',
    'isolatedKeysPresent', 'environment', 'bootChanged', 'materialsPreserved',
    'mainStateVerified', 'receiptStable', 'markersPreserved', 'writerRecovered',
    'writerBlocked', 'forbiddenAccessCount', 'realBusinessKey', 'bootCount', 'suiteRunId'
  ];
  const output = {
    schemaVersion: RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION,
    caseId: String(caseId),
    status: Object.values(RECORD_STORAGE_RUNTIME_TEST_STATUSES).includes(status)
      ? status
      : RECORD_STORAGE_RUNTIME_TEST_STATUSES.FAIL
  };
  allowed.forEach((key) => {
    if (facts[key] !== undefined) output[key] = safeClone(facts[key]);
  });
  return output;
}

function assertNoSensitiveResult(result) {
  const serialized = JSON.stringify(result);
  const forbidden = [SENSITIVE_SENTINEL, 'originalText', 'customerName', 'totalAmount'];
  if (forbidden.some((item) => serialized.includes(item))) {
    throw runtimeError('WX_RUNTIME_TEST_RESULT_LEAK', '运行时测试结果包含禁止字段。');
  }
  return result;
}

function createRecordStorageWxRuntimeHarness(options = {}) {
  const wxApi = typeof globalThis !== 'undefined' ? globalThis.wx : null;
  const environment = readWechatRuntimeEnvironment(wxApi);
  const runtimeStorageGuard = options.runtimeStorageGuard;
  if (!environment.isDevtoolsDevelop
    || options.authorizedLaunch !== true
    || !runtimeStorageGuard
    || typeof runtimeStorageGuard.getAuditSummary !== 'function'
    || typeof runtimeStorageGuard.isActive !== 'function'
    || runtimeStorageGuard.isActive() !== true) {
    throw runtimeError(
      'WX_RUNTIME_TEST_LAUNCH_FORBIDDEN',
      '微信Storage运行时测试未通过独立Mini Program启动守卫。'
    );
  }
  const bootId = `wxruntime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const gateway = createWxRuntimeTestStorageGateway();

  function manager(gatewayOptions) {
    const selected = gatewayOptions
      ? createWxRuntimeTestStorageGateway(gatewayOptions)
      : gateway;
    return {
      gateway: selected,
      transaction: createPersistentRecordTransactionManager({
        gateway: selected,
        mode: 'TRANSACTION_PREVIEW'
      })
    };
  }

  function keyExists(key, selectedGateway = gateway) {
    return selectedGateway.hasStorageKeySync(key) === true;
  }

  function resetScenarioStorage() {
    [
      RECORD_STORAGE_RUNTIME_TEST_KEYS.primary,
      RECORD_STORAGE_RUNTIME_TEST_KEYS.journal,
      RECORD_STORAGE_RUNTIME_TEST_KEYS.backup
    ].forEach((key) => {
      if (keyExists(key)) gateway.removeStorageSync(key);
    });
    return [
      RECORD_STORAGE_RUNTIME_TEST_KEYS.primary,
      RECORD_STORAGE_RUNTIME_TEST_KEYS.journal,
      RECORD_STORAGE_RUNTIME_TEST_KEYS.backup
    ].filter((key) => keyExists(key));
  }

  function cleanIsolatedStorage() {
    const session = readHarnessState();
    const auditBeforeCleanup = aggregateStorageAudit(session);
    RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.forEach((key) => {
      if (keyExists(key)) gateway.removeStorageSync(key);
    });
    const remaining = RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.filter((key) => keyExists(key));
    const cleanAudit = isStorageAuditClean(auditBeforeCleanup);
    return caseResult('isolated-cleanup', remaining.length || !cleanAudit ? 'FAIL' : 'PASS', {
      keysRemaining: remaining.length,
      isolatedKeysPresent: remaining,
      forbiddenAccessCount: auditBeforeCleanup.forbiddenAccessCount,
      realBusinessKey: auditBeforeCleanup.realBusinessKey,
      bootCount: auditBeforeCleanup.bootCount,
      suiteRunId: session && session.suiteRunId || bootId
    });
  }

  function readHarnessState() {
    if (!keyExists(RECORD_STORAGE_RUNTIME_TEST_KEYS.receipts)) return null;
    const value = gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.receipts);
    return value && typeof value === 'object' && !Array.isArray(value) ? safeClone(value) : null;
  }

  function writeHarnessState(value) {
    const existing = readHarnessState() || {};
    const auditByBoot = Object.assign(
      {},
      existing.auditByBoot || {},
      value.auditByBoot || {}
    );
    auditByBoot[bootId] = runtimeStorageGuard.getAuditSummary();
    const state = {
      schemaVersion: RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION,
      suiteRunId: String(value.suiteRunId || existing.suiteRunId || bootId),
      scenario: String(value.scenario || existing.scenario || ''),
      stage: String(value.stage || existing.stage || ''),
      preparedBootId: String(value.preparedBootId || existing.preparedBootId || bootId),
      expectedRevision: Number.isInteger(value.expectedRevision)
        ? value.expectedRevision
        : (Number.isInteger(existing.expectedRevision) ? existing.expectedRevision : null),
      expectedFingerprint: String(value.expectedFingerprint || existing.expectedFingerprint || ''),
      lastStatus: String(value.lastStatus || existing.lastStatus || ''),
      auditByBoot
    };
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.receipts, state);
    return state;
  }

  function aggregateStorageAudit(session) {
    const byBoot = Object.assign({}, session && session.auditByBoot || {});
    byBoot[bootId] = runtimeStorageGuard.getAuditSummary();
    const output = {
      forbiddenAccessCount: 0,
      realBusinessKey: { reads: 0, writes: 0, removals: 0 },
      bootCount: Object.keys(byBoot).length,
      suiteRunId: String(session && session.suiteRunId || bootId)
    };
    Object.values(byBoot).forEach((entry) => {
      output.forbiddenAccessCount += Number(entry && entry.forbiddenAccessCount) || 0;
      output.realBusinessKey.reads += Number(entry && entry.realBusinessKey && entry.realBusinessKey.reads) || 0;
      output.realBusinessKey.writes += Number(entry && entry.realBusinessKey && entry.realBusinessKey.writes) || 0;
      output.realBusinessKey.removals += Number(entry && entry.realBusinessKey && entry.realBusinessKey.removals) || 0;
    });
    return output;
  }

  function isStorageAuditClean(audit) {
    return audit
      && audit.forbiddenAccessCount === 0
      && audit.realBusinessKey.reads === 0
      && audit.realBusinessKey.writes === 0
      && audit.realBusinessKey.removals === 0;
  }

  function summarizeGatewayTrace(selectedGateway = gateway) {
    const trace = selectedGateway.getRuntimeTrace();
    return {
      reads: trace.filter((entry) => entry.operation === 'GET').length,
      writes: trace.filter((entry) => entry.operation === 'SET').length,
      removals: trace.filter((entry) => entry.operation === 'REMOVE').length,
      isolatedKeysPresent: selectedGateway.listStorageKeysSync()
    };
  }

  function primarySummary(selectedGateway = gateway) {
    if (!keyExists(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, selectedGateway)) {
      return { revision: 0, fingerprint: '', receiptCount: 0 };
    }
    const bundle = selectedGateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
    const control = readRecordStorageControl(bundle);
    return {
      revision: control ? control.storageRevision : 0,
      fingerprint: getRecordStorageBusinessFingerprint(bundle),
      receiptCount: control ? (control.recentReceipts || []).length : 0
    };
  }

  function primaryStorageSummary(selectedGateway = gateway) {
    if (!keyExists(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, selectedGateway)) {
      return { revision: null, fingerprint: '', receiptCount: null, integrityValid: false };
    }
    try {
      return Object.assign(primarySummary(selectedGateway), { integrityValid: true });
    } catch (error) {
      const raw = selectedGateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
      return {
        revision: null,
        fingerprint: stableHash(raw, 'runtime-primary-opaque-v1'),
        receiptCount: null,
        integrityValid: false
      };
    }
  }

  function storageMaterialSummary(key, selectedGateway = gateway) {
    if (!keyExists(key, selectedGateway)) return { exists: false, fingerprint: '' };
    return {
      exists: true,
      fingerprint: stableHash(selectedGateway.getStorageSync(key), 'runtime-material-opaque-v1')
    };
  }

  function runBasicStorageCase() {
    resetScenarioStorage();
    gateway.resetRuntimeTrace();
    const initial = createSyntheticBundle('DEFAULT');
    const before = stableSerialize(initial);
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, initial);
    const readback = gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
    const capacity = gateway.getCapacityInfo();
    const same = stableSerialize(readback) === before;
    const unknownPreserved = readback.runtimeUnknownTopLevel
      && readback.runtimeUnknownTopLevel.marker === 'preserve-me';
    gateway.removeStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
    const removed = !keyExists(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
    const trace = summarizeGatewayTrace();
    return caseResult('basic-write-read-remove', same && unknownPreserved && removed ? 'PASS' : 'FAIL', {
      currentSizeBytes: capacity.currentSizeBytes,
      limitSizeBytes: capacity.limitSizeBytes,
      targetSizeBytes: JSON.stringify(initial).length,
      reads: trace.reads,
      writes: trace.writes,
      removals: trace.removals,
      unknownFieldsPreserved: Boolean(unknownPreserved)
    });
  }

  function commitSyntheticCase(caseId, variant) {
    resetScenarioStorage();
    const base = createSyntheticBundle(variant);
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const snapshot = runtime.transaction.readTransactionSnapshot();
    const target = buildTargetBundle(base, caseId);
    const result = runtime.transaction.commitBundle(buildTransactionInput(snapshot, caseId, target));
    const readback = gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
    const actual = stripRecordStorageControl(readback);
    const optionalStable = variant !== 'MISSING_OPTIONAL'
      || (!Object.prototype.hasOwnProperty.call(actual, 'operationLogs')
        && !Object.prototype.hasOwnProperty.call(actual, 'deletedRecords'));
    const targetStable = stableSerialize(actual) === stableSerialize(target);
    return caseResult(caseId, result.status === 'COMMITTED' && targetStable && optionalStable ? 'PASS' : 'FAIL', {
      errorCode: firstErrorCode(result),
      baseRevision: result.baseRevision,
      targetRevision: result.targetRevision,
      fingerprint: result.targetFingerprint,
      peakBytes: result.capacity && result.capacity.peakBytes,
      limitSizeBytes: result.capacity && result.capacity.limitSizeBytes,
      unknownFieldsPreserved: targetStable,
      optionalCollectionsPreserved: optionalStable
    });
  }

  function runNormalCasCase() {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const firstSnapshot = runtime.transaction.readTransactionSnapshot();
    const firstTarget = buildTargetBundle(base, 'revision-1');
    const first = runtime.transaction.commitBundle(buildTransactionInput(firstSnapshot, 'revision_1', firstTarget));
    const secondSnapshot = runtime.transaction.readTransactionSnapshot();
    const secondTarget = buildTargetBundle(secondSnapshot.bundle, 'revision-2');
    const second = runtime.transaction.commitBundle(buildTransactionInput(secondSnapshot, 'revision_2', secondTarget));
    const final = primarySummary();
    const clean = !keyExists(RECORD_STORAGE_RUNTIME_TEST_KEYS.journal)
      && !keyExists(RECORD_STORAGE_RUNTIME_TEST_KEYS.backup);
    return caseResult('normal-cas', first.status === 'COMMITTED'
      && second.status === 'COMMITTED'
      && final.revision === 2
      && clean ? 'PASS' : 'FAIL', {
      revision: final.revision,
      fingerprint: final.fingerprint,
      receiptCount: final.receiptCount,
      targetRevision: second.targetRevision
    });
  }

  function runStaleWriterCase() {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const seedSnapshot = runtime.transaction.readTransactionSnapshot();
    runtime.transaction.commitBundle(buildTransactionInput(
      seedSnapshot,
      'stale_seed',
      buildTargetBundle(base, 'seed')
    ));
    const writerA = runtime.transaction.readTransactionSnapshot();
    const writerB = safeClone(writerA);
    const targetA = buildTargetBundle(writerA.bundle, 'writer-a');
    const resultA = runtime.transaction.commitBundle(buildTransactionInput(
      writerA,
      'stale_a',
      targetA
    ));
    gateway.resetRuntimeTrace();
    const resultB = runtime.transaction.commitBundle(buildTransactionInput(
      writerB,
      'stale_b',
      buildTargetBundle(writerB.bundle, 'writer-b')
    ));
    const final = primarySummary();
    const finalBundle = stripRecordStorageControl(
      gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary)
    );
    const mainStateVerified = final.fingerprint === getRecordStorageBusinessFingerprint(targetA)
      && finalBundle.meta.runtimeTransactionMarker === 'writer-a';
    const trace = summarizeGatewayTrace();
    return caseResult('stale-writer', resultA.status === 'COMMITTED'
      && resultB.status === 'STALE_STORAGE_SNAPSHOT'
      && final.revision === 2
      && mainStateVerified
      && trace.writes === 0 ? 'PASS' : 'FAIL', {
      errorCode: firstErrorCode(resultB),
      revision: final.revision,
      writes: trace.writes,
      mainStateVerified
    });
  }

  function runUnrelatedHarnessKeyCase() {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const snapshot = runtime.transaction.readTransactionSnapshot();
    writeHarnessState({ scenario: 'UNRELATED_KEY', stage: 'CHANGED' });
    const result = runtime.transaction.commitBundle(buildTransactionInput(
      snapshot,
      'unrelated_key',
      buildTargetBundle(base, 'unrelated-key')
    ));
    return caseResult('unrelated-test-key', result.status === 'COMMITTED' ? 'PASS' : 'FAIL', {
      errorCode: firstErrorCode(result),
      targetRevision: result.targetRevision
    });
  }

  function runPlanCollisionCase() {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const snapshot = runtime.transaction.readTransactionSnapshot();
    const target = buildTargetBundle(base, 'collision-first');
    const input = buildTransactionInput(snapshot, 'collision', target);
    const first = runtime.transaction.commitBundle(input);
    const collision = runtime.transaction.commitBundle(Object.assign({}, input, {
      planHash: 'runtime_hash_collision_changed',
      idempotencyKey: 'runtime_idempotency_collision_changed',
      targetBundle: buildTargetBundle(base, 'collision-second')
    }));
    return caseResult('plan-id-collision', first.status === 'COMMITTED'
      && firstErrorCode(collision) === 'SAVE_PLAN_ID_COLLISION' ? 'PASS' : 'FAIL', {
      collisionStatus: collision.status,
      errorCode: firstErrorCode(collision),
      revision: primarySummary().revision
    });
  }

  function runCapacityCase() {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const limitedRuntime = manager({ capacityHeadroomBytes: 1 });
    const snapshot = limitedRuntime.transaction.readTransactionSnapshot();
    limitedRuntime.gateway.resetRuntimeTrace();
    const result = limitedRuntime.transaction.commitBundle(buildTransactionInput(
      snapshot,
      'capacity_block',
      buildTargetBundle(base, 'capacity-block')
    ));
    const trace = summarizeGatewayTrace(limitedRuntime.gateway);
    const errorCode = firstErrorCode(result);
    return caseResult('capacity-preflight', errorCode === 'STORAGE_CAPACITY_INSUFFICIENT'
      && trace.writes === 0 ? 'PASS' : 'FAIL', {
      errorCode,
      writes: trace.writes,
      currentSizeBytes: limitedRuntime.gateway.getCapacityInfo().currentSizeBytes,
      limitSizeBytes: limitedRuntime.gateway.getCapacityInfo().limitSizeBytes
    });
  }

  async function runWriterQueueCase() {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const coordinator = createRecordStorageCoordinator({
      gateway,
      mode: 'TRANSACTION_PREVIEW'
    });
    function queuedInput(snapshot, suffix) {
      const target = buildTargetBundle(snapshot.bundle, `queue-${suffix}`);
      target.runtimeQueueMarkers = Array.isArray(target.runtimeQueueMarkers)
        ? target.runtimeQueueMarkers.concat([suffix])
        : [suffix];
      return buildTransactionInput(snapshot, `queue_${suffix}`, target);
    }
    const queue = ['one', 'two', 'three'].map((suffix) => coordinator.enqueueTransaction((snapshot) => (
      queuedInput(snapshot, suffix)
    )));
    const results = await Promise.all(queue);
    let injectedFailure = '';
    try {
      await coordinator.enqueueTransaction(() => {
        throw runtimeError('WX_RUNTIME_TEST_QUEUE_INJECTED_FAILURE', '合成队列失败。');
      });
    } catch (error) {
      injectedFailure = String(error && error.code || '');
    }
    const afterFailure = await coordinator.enqueueTransaction((snapshot) => (
      queuedInput(snapshot, 'after-failure')
    ));
    const final = primarySummary();
    const finalBundle = stripRecordStorageControl(
      gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary)
    );
    const statuses = results.map((entry) => entry.status).concat([afterFailure.status]);
    const expectedMarkers = ['one', 'two', 'three', 'after-failure'];
    const markersPreserved = stableSerialize(finalBundle.runtimeQueueMarkers) === stableSerialize(expectedMarkers);
    return caseResult('writer-queue', statuses.every((status) => status === 'COMMITTED')
      && final.revision === 4
      && injectedFailure === 'WX_RUNTIME_TEST_QUEUE_INJECTED_FAILURE'
      && markersPreserved ? 'PASS' : 'FAIL', {
      revision: final.revision,
      queueStatuses: statuses,
      errorCode: injectedFailure,
      markersPreserved,
      writerRecovered: afterFailure.status === 'COMMITTED'
    });
  }

  function runReadbackAnomalyCase(caseId, mutation) {
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const snapshot = runtime.transaction.readTransactionSnapshot();
    const result = runtime.transaction.commitBundle(
      buildTransactionInput(snapshot, `anomaly_${caseId}`, buildTargetBundle(base, caseId)),
      {
        onCheckpoint(name) {
          if (name !== 'AFTER_MAIN_WRITE') return;
          const current = gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
          gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, mutation(safeClone(current)));
        }
      }
    );
    const recoveryStatus = result.recovery && result.recovery.status;
    const expectedRolledBack = caseId === 'corrupt-value';
    const primary = expectedRolledBack ? primarySummary() : primaryStorageSummary();
    const materialState = {
      journal: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.journal),
      backup: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.backup)
    };
    let mainStateVerified = false;
    let materialsPreserved = false;
    let secondStatus = '';
    if (expectedRolledBack) {
      mainStateVerified = primary.revision === snapshot.revision
        && primary.fingerprint === snapshot.businessFingerprint;
      materialsPreserved = materialState.journal.exists === false
        && materialState.backup.exists === false;
      secondStatus = runtime.transaction.recover().status;
    } else {
      const beforeSecond = {
        revision: primary.revision,
        fingerprint: primary.fingerprint,
        materialState
      };
      const second = runtime.transaction.recover();
      const afterSecond = primaryStorageSummary();
      secondStatus = second.status;
      mainStateVerified = beforeSecond.revision === afterSecond.revision
        && beforeSecond.fingerprint === afterSecond.fingerprint;
      const journalAfter = storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.journal);
      const backupAfter = storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.backup);
      materialsPreserved = beforeSecond.materialState.journal.exists === true
        && beforeSecond.materialState.backup.exists === true
        && journalAfter.exists === true
        && backupAfter.exists === true
        && beforeSecond.materialState.journal.fingerprint === journalAfter.fingerprint
        && beforeSecond.materialState.backup.fingerprint === backupAfter.fingerprint;
    }
    const commitWasRejected = result.status !== RECORD_STORAGE_TRANSACTION_STATES.COMMITTED
      && result.status !== RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED;
    const passed = commitWasRejected && (expectedRolledBack
      ? recoveryStatus === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK
        && secondStatus === RECORD_STORAGE_RECOVERY_STATES.CLEAN
        && mainStateVerified
        && materialsPreserved
      : recoveryStatus === RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED
        && secondStatus === RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED
        && mainStateVerified
        && materialsPreserved);
    const output = caseResult(`readback-${caseId}`, passed ? 'PASS' : 'FAIL', {
      errorCode: firstErrorCode(result),
      recoveryStatus,
      secondRecoveryStatus: secondStatus,
      revision: primary.revision,
      fingerprint: primary.fingerprint,
      mainStateVerified,
      materialsPreserved
    });
    resetScenarioStorage();
    return output;
  }

  async function runNonReloadSuite() {
    writeHarnessState({
      suiteRunId: readHarnessState() && readHarnessState().suiteRunId || bootId,
      scenario: 'NON_RELOAD',
      stage: 'RUNNING',
      preparedBootId: bootId,
      lastStatus: 'RUNNING'
    });
    const cases = [
      runBasicStorageCase(),
      commitSyntheticCase('legacy-no-meta', 'NO_META'),
      commitSyntheticCase('legacy-unknown-meta', 'DEFAULT'),
      commitSyntheticCase('legacy-missing-optional', 'MISSING_OPTIONAL'),
      commitSyntheticCase('legacy-large-bundle', 'LARGE'),
      runNormalCasCase(),
      runStaleWriterCase(),
      runUnrelatedHarnessKeyCase(),
      runPlanCollisionCase(),
      runCapacityCase(),
      await runWriterQueueCase(),
      runReadbackAnomalyCase('corrupt-value', () => '{corrupt-json'),
      runReadbackAnomalyCase('fingerprint-mismatch', (bundle) => {
        bundle.meta.runtimeTransactionMarker = 'tampered';
        return bundle;
      }),
      runReadbackAnomalyCase('transaction-mismatch', (bundle) => {
        bundle.__hxlRecordStorageV1.lastCommittedTransactionId = 'runtime_txn_wrong';
        return bundle;
      }),
      runReadbackAnomalyCase('required-collection-missing', (bundle) => {
        delete bundle.customers;
        return bundle;
      })
    ];
    const storageAudit = aggregateStorageAudit(readHarnessState());
    const auditClean = isStorageAuditClean(storageAudit);
    writeHarnessState({
      scenario: 'NON_RELOAD',
      stage: cases.every((entry) => entry.status === 'PASS') && auditClean ? 'VERIFIED' : 'FAILED',
      preparedBootId: bootId,
      lastStatus: cases.every((entry) => entry.status === 'PASS') && auditClean ? 'PASS' : 'FAIL'
    });
    const result = {
      schemaVersion: RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION,
      suite: 'WX_RUNTIME_NON_RELOAD',
      status: cases.every((entry) => entry.status === 'PASS') && auditClean ? 'PASS' : 'FAIL',
      passed: cases.filter((entry) => entry.status === 'PASS').length,
      failed: cases.filter((entry) => entry.status === 'FAIL').length + (auditClean ? 0 : 1),
      cases,
      productionMode: STORAGE_MIGRATION_MODES.LEGACY_ONLY,
      sharedCommitEnabled: false,
      storageAudit
    };
    return assertNoSensitiveResult(result);
  }

  function prepareRecoveryScenario(scenario) {
    if (!Object.values(RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS).includes(scenario)) {
      return caseResult('prepare-recovery', 'FAIL', { errorCode: 'WX_RUNTIME_TEST_SCENARIO_INVALID' });
    }
    resetScenarioStorage();
    const base = createSyntheticBundle();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, base);
    const runtime = manager();
    const snapshot = runtime.transaction.readTransactionSnapshot();
    const target = buildTargetBundle(base, `recovery-${scenario.toLowerCase()}`);
    const input = buildTransactionInput(snapshot, `recovery_${scenario.toLowerCase()}`, target);
    const expectedRevision = scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.MAIN_WRITTEN
      || scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.IDEMPOTENCY ? 1 : 0;
    const expectedFingerprint = scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.MAIN_WRITTEN
      || scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.IDEMPOTENCY
      ? getRecordStorageBusinessFingerprint(target)
      : getRecordStorageBusinessFingerprint(base);

    writeHarnessState({
      scenario,
      stage: 'PREPARING_RELOAD_SCENARIO',
      preparedBootId: bootId,
      expectedRevision,
      expectedFingerprint,
      lastStatus: 'PREPARING'
    });

    if (scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.IDEMPOTENCY) {
      const committed = runtime.transaction.commitBundle(input);
      writeHarnessState({
        scenario,
        stage: 'COMMITTED_RELOAD_REQUIRED',
        preparedBootId: bootId,
        expectedRevision,
        expectedFingerprint,
        lastStatus: committed.status
      });
      return caseResult('prepare-idempotency-reload', committed.status === 'COMMITTED' ? 'PASS' : 'FAIL', {
        scenario,
        requiresReload: true,
        targetRevision: committed.targetRevision,
        fingerprint: committed.targetFingerprint
      });
    }

    const crashAt = scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.PREPARED
      ? 'AFTER_JOURNAL_WRITE'
      : 'AFTER_MAIN_WRITE';
    let crashCode = '';
    try {
      runtime.transaction.commitBundle(input, { crashAt });
    } catch (error) {
      crashCode = String(error && error.code || '');
    }
    if (scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.PRIMARY_CORRUPT) {
      gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, '{corrupt-json');
    }
    if (scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.CONTRADICTORY) {
      gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, {
        meta: { runtimeSynthetic: true, contradictory: true },
        customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
        dunningRecords: [], todos: [], orderProgress: [], pendingNotes: [], aiParseLogs: [],
        dunningTemplates: []
      });
    }
    writeHarnessState({
      scenario,
      stage: 'RECOVERY_RELOAD_REQUIRED',
      preparedBootId: bootId,
      expectedRevision,
      expectedFingerprint,
      lastStatus: crashCode
    });
    return caseResult('prepare-recovery', crashCode === 'SIMULATED_PROCESS_CRASH' ? 'PASS' : 'FAIL', {
      errorCode: crashCode,
      scenario,
      requiresReload: true,
      isolatedKeysPresent: gateway.listStorageKeysSync()
    });
  }

  function resumeRecoveryScenario() {
    const session = readHarnessState();
    if (!session || !session.scenario) {
      return caseResult('resume-recovery', 'BLOCKED', { errorCode: 'WX_RUNTIME_TEST_SESSION_MISSING' });
    }
    if (session.preparedBootId === bootId) {
      return caseResult('resume-recovery', 'BLOCKED', {
        errorCode: 'WX_RUNTIME_TEST_REAL_RELOAD_REQUIRED',
        scenario: session.scenario,
        bootChanged: false
      });
    }
    const runtime = manager();
    if (session.scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.IDEMPOTENCY) {
      const base = createSyntheticBundle();
      const fakeSnapshot = {
        revision: 0,
        businessFingerprint: getRecordStorageBusinessFingerprint(base)
      };
      const target = buildTargetBundle(base, 'recovery-idempotency');
      const before = primarySummary();
      gateway.resetRuntimeTrace();
      const replay = runtime.transaction.commitBundle(buildTransactionInput(
        fakeSnapshot,
        'recovery_idempotency',
        target
      ));
      const after = primarySummary();
      const collision = runtime.transaction.commitBundle(Object.assign(
        {},
        buildTransactionInput(fakeSnapshot, 'recovery_idempotency', target),
        { planHash: 'runtime_hash_recovery_idempotency_changed' }
      ));
      const replayTrace = summarizeGatewayTrace();
      const storageAudit = aggregateStorageAudit(session);
      const pass = replay.status === 'ALREADY_COMMITTED'
        && before.revision === after.revision
        && before.fingerprint === after.fingerprint
        && before.receiptCount === after.receiptCount
        && after.revision === session.expectedRevision
        && after.fingerprint === session.expectedFingerprint
        && replayTrace.writes === 0
        && replayTrace.removals === 0
        && firstErrorCode(collision) === 'SAVE_PLAN_ID_COLLISION'
        && isStorageAuditClean(storageAudit);
      writeHarnessState(Object.assign({}, session, { stage: 'VERIFIED', lastStatus: replay.status }));
      return caseResult('resume-idempotency', pass ? 'PASS' : 'FAIL', {
        scenario: session.scenario,
        recoveryStatus: replay.status,
        collisionStatus: collision.status,
        errorCode: firstErrorCode(collision),
        revision: after.revision,
        fingerprint: after.fingerprint,
        writes: replayTrace.writes,
        removals: replayTrace.removals,
        receiptStable: before.receiptCount === after.receiptCount,
        forbiddenAccessCount: storageAudit.forbiddenAccessCount,
        realBusinessKey: storageAudit.realBusinessKey,
        mainStateVerified: after.revision === session.expectedRevision
          && after.fingerprint === session.expectedFingerprint,
        bootChanged: true
      });
    }

    const beforeRecovery = primaryStorageSummary();
    const beforeMaterials = {
      primary: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary),
      journal: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.journal),
      backup: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.backup)
    };
    const recovery = runtime.transaction.recover();
    const afterRecovery = primarySummary();
    const afterMaterials = {
      primary: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary),
      journal: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.journal),
      backup: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.backup)
    };
    const second = runtime.transaction.recover();
    const afterSecond = primarySummary();
    const afterSecondMaterials = {
      primary: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary),
      journal: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.journal),
      backup: storageMaterialSummary(RECORD_STORAGE_RUNTIME_TEST_KEYS.backup)
    };
    const expected = {
      PREPARED: RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK,
      MAIN_WRITTEN: RECORD_STORAGE_RECOVERY_STATES.RECOVERED_COMMITTED,
      PRIMARY_CORRUPT: RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK,
      CONTRADICTORY: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED
    }[session.scenario];
    const expectedSecond = session.scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.CONTRADICTORY
      ? RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED
      : RECORD_STORAGE_RECOVERY_STATES.CLEAN;
    const contradictory = session.scenario === RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.CONTRADICTORY;
    const mainStateVerified = contradictory
      ? beforeRecovery.revision === afterRecovery.revision
        && beforeRecovery.fingerprint === afterRecovery.fingerprint
        && afterRecovery.revision === afterSecond.revision
        && afterRecovery.fingerprint === afterSecond.fingerprint
      : afterRecovery.revision === session.expectedRevision
        && afterRecovery.fingerprint === session.expectedFingerprint
        && afterSecond.revision === afterRecovery.revision
        && afterSecond.fingerprint === afterRecovery.fingerprint;
    const materialsPreserved = contradictory
      ? beforeMaterials.primary.exists && beforeMaterials.journal.exists && beforeMaterials.backup.exists
        && afterMaterials.primary.exists && afterMaterials.journal.exists && afterMaterials.backup.exists
        && afterSecondMaterials.primary.exists
        && afterSecondMaterials.journal.exists
        && afterSecondMaterials.backup.exists
        && beforeMaterials.primary.fingerprint === afterMaterials.primary.fingerprint
        && afterMaterials.primary.fingerprint === afterSecondMaterials.primary.fingerprint
        && beforeMaterials.journal.fingerprint === afterMaterials.journal.fingerprint
        && afterMaterials.journal.fingerprint === afterSecondMaterials.journal.fingerprint
        && beforeMaterials.backup.fingerprint === afterMaterials.backup.fingerprint
        && afterMaterials.backup.fingerprint === afterSecondMaterials.backup.fingerprint
      : afterMaterials.primary.exists && !afterMaterials.journal.exists && !afterMaterials.backup.exists
        && afterSecondMaterials.primary.exists
        && !afterSecondMaterials.journal.exists
        && !afterSecondMaterials.backup.exists;
    const receiptStable = afterRecovery.receiptCount === afterSecond.receiptCount
      && (session.scenario !== RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.MAIN_WRITTEN
        || afterRecovery.receiptCount >= 1);
    let writerBlocked = true;
    if (contradictory) {
      gateway.resetRuntimeTrace();
      const blocked = runtime.transaction.commitBundle(buildTransactionInput(
        {
          revision: afterSecond.revision,
          businessFingerprint: afterSecond.fingerprint
        },
        'recovery_blocked_writer',
        buildTargetBundle(
          gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary),
          'must-not-commit'
        )
      ));
      const blockedTrace = summarizeGatewayTrace();
      writerBlocked = firstErrorCode(blocked) === 'STORAGE_RECOVERY_REQUIRED'
        && blockedTrace.writes === 0
        && blockedTrace.removals === 0;
    }
    const storageAudit = aggregateStorageAudit(session);
    const pass = recovery.status === expected
      && second.status === expectedSecond
      && mainStateVerified
      && materialsPreserved
      && receiptStable
      && writerBlocked
      && isStorageAuditClean(storageAudit);
    writeHarnessState(Object.assign({}, session, {
      stage: pass ? 'VERIFIED' : 'FAILED',
      lastStatus: recovery.status
    }));
    return caseResult('resume-recovery', pass ? 'PASS' : 'FAIL', {
      scenario: session.scenario,
      recoveryStatus: recovery.status,
      secondRecoveryStatus: second.status,
      errorCode: firstErrorCode(recovery),
      isolatedKeysPresent: gateway.listStorageKeysSync(),
      revision: afterRecovery.revision,
      fingerprint: afterRecovery.fingerprint,
      mainStateVerified,
      materialsPreserved,
      receiptStable,
      writerBlocked,
      forbiddenAccessCount: storageAudit.forbiddenAccessCount,
      realBusinessKey: storageAudit.realBusinessKey,
      bootChanged: true
    });
  }

  function getRuntimeStatus() {
    const capacity = gateway.getCapacityInfo();
    const trace = summarizeGatewayTrace();
    const primary = primarySummary();
    const session = readHarnessState();
    const result = {
      schemaVersion: RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION,
      bootId,
      environment,
      productionMode: STORAGE_MIGRATION_MODES.LEGACY_ONLY,
      sharedCommitEnabled: false,
      revision: primary.revision,
      fingerprint: primary.fingerprint,
      receiptCount: primary.receiptCount,
      capacity: {
        currentSizeBytes: capacity.currentSizeBytes,
        limitSizeBytes: capacity.limitSizeBytes,
        capacityConfirmed: capacity.capacityConfirmed === true
      },
      trace,
      storageAudit: aggregateStorageAudit(session),
      harness: session
    };
    return assertNoSensitiveResult(result);
  }

  return Object.freeze({
    bootId,
    cleanIsolatedStorage,
    getRuntimeStatus,
    prepareRecoveryScenario,
    resumeRecoveryScenario,
    runNonReloadSuite
  });
}

module.exports = {
  SENSITIVE_SENTINEL,
  buildTargetBundle,
  buildTransactionInput,
  caseResult,
  createRecordStorageWxRuntimeHarness,
  createSyntheticBundle
};
