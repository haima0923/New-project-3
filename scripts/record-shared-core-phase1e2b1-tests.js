#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  RECORD_SAVE_CUTOVER_ENVIRONMENTS,
  RECORD_SAVE_CUTOVER_ERROR_CODES,
  RECORD_SAVE_CUTOVER_MODES,
  RECORD_SAVE_CUTOVER_SOURCE_KINDS,
  RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS,
  RECORD_SAVE_FALLBACK_POLICIES,
  RECORD_SAVE_FALLBACK_STAGES,
  RECORD_SAVE_PRIMARY_PATHS,
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS,
  RECORD_SAVE_SHADOW_PATHS
} = require('../utils/record-save-cutover-contract');
const {
  classifyRecordSaveShadowDifference,
  createBuildStaticRecordSaveCutoverConfigProvider,
  createIsolatedRecordSaveCutoverEvidence,
  createIsolatedRecordSaveFallbackOutcome,
  createIsolatedRecordSaveCutoverTarget,
  createRecordSaveCutoverController,
  createTestRecordSaveCutoverConfigProvider,
  evaluateRecordSaveRecoveryLock,
  evaluateSharedSaveEligibility,
  resolveRecordSaveExecutionDecision,
  resolveRecordSaveFallbackPolicy,
  resolveTrustedRecordSaveCutoverConfig
} = require('../utils/record-save-cutover-controller');
const {
  createRecordSaveCutoverMonitor,
  sanitizeRecordSaveCutoverEvent
} = require('../utils/record-save-cutover-monitor');
const {
  LEGACY_BUSINESS_STORAGE_KEY,
  STORAGE_TARGET_KINDS
} = require('../utils/record-storage-adapter-contract');
const { createRecordStorageCoordinator } = require('../utils/record-storage-coordinator');
const { createFakeStorageGateway } = require('../utils/record-storage-gateways');
const { createPersistentRecordTransactionManager } = require('../utils/record-storage-transaction');
const {
  RECORD_STORAGE_CONTROL_SCHEMA_VERSION,
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('../utils/record-storage-transaction-contract');
const {
  getRecordStorageBusinessFingerprint,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('../utils/record-storage-state-projector');
const {
  compareRecordSaveShadowStates
} = require('../utils/record-save-shadow');
const { SAVE_PLAN_SCHEMA_VERSION } = require('../utils/record-save-plan-contract');
const { computePlanHash } = require('../utils/record-save-plan-builder');
const { safeClone, stableSerialize } = require('../utils/record-state-diff');
const {
  canonicalState,
  runLegacyEquivalenceWithVisitor
} = require('./record-shared-core-phase1e1-tests');

delete global.wx;

const ROOT = path.join(__dirname, '..');
const FIXED_NOW = '2026-07-23T05:00:00.000Z';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function testConfig(mode = RECORD_SAVE_CUTOVER_MODES.SHARED_CANARY, overrides = {}) {
  return Object.assign({
    configVersion: `test-${String(mode).toLowerCase()}-v1`,
    issuedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-24T00:00:00.000Z',
    requestedMode: mode,
    allowedBuildVersions: ['2.0.0-test'],
    allowedBuildFlavors: ['ISOLATED_TEST'],
    allowedStorageSchemaVersions: [RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.storageSchema],
    allowedTransactionProtocolVersions: [
      RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.transactionProtocol
    ],
    minimumCoordinatorVersion: RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.coordinator,
    minimumTransactionVersion: RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.transactionProtocol,
    minimumStorageSchemaVersion: RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.storageSchema,
    cohortPolicy: { kind: 'INTERNAL_TEST' },
    businessTypeAllowlist: ['todo'],
    operationAllowlist: ['create_todo'],
    shadowSampleRate: 1,
    canarySampleRate: 1,
    killSwitch: false,
    recoveryLock: false,
    fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
    monitoringPolicy: {
      enabled: true,
      remoteUploadEnabled: false,
      maxEvents: 8
    }
  }, clone(overrides));
}

function testProvider(mode, overrides) {
  return createTestRecordSaveCutoverConfigProvider(testConfig(mode, overrides), {
    sourceKind: RECORD_SAVE_CUTOVER_SOURCE_KINDS.FAKE_TEST
  });
}

function testEvidence(overrides = {}) {
  return createIsolatedRecordSaveCutoverEvidence(Object.assign({
    sourceKind: RECORD_SAVE_CUTOVER_SOURCE_KINDS.FAKE_TEST,
    appVersion: '2.0.0-test',
    buildFlavor: 'ISOLATED_TEST',
    releaseAVerified: true,
    oldWritersRetired: true,
    transactionalLegacyFallbackReady: true,
    minimumCoordinatorVersion: RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.coordinator,
    cohortEligible: true,
    cohortPolicyKind: 'INTERNAL_TEST',
    canarySampleAccepted: true,
    shadowSampleAccepted: true,
    recoveryState: RECORD_STORAGE_RECOVERY_STATES.CLEAN,
    transactionState: RECORD_STORAGE_TRANSACTION_STATES.CLEAN,
    readbackVerified: true,
    receiptConsistent: true,
    transactionMetadataValid: true,
    transactionMaterialsResolved: true,
    materialsContradictory: false,
    transactionMaterialCorrupt: false
  }, clone(overrides)));
}

function basePlan(overrides = {}) {
  const plan = Object.assign({
    schemaVersion: SAVE_PLAN_SCHEMA_VERSION,
    planId: 'plan-cutover-1',
    planHash: '',
    idempotencyKey: '',
    action: 'SAVE_FORMAL',
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    confirmationId: 'confirmation-cutover-1',
    confirmationRevision: 1,
    confirmationContentHash: 'confirmation-hash-1',
    preflightFingerprint: 'preflight-fingerprint-1',
    sourceStateVersion: 0,
    sourceStateFingerprint: 'state-fingerprint-0',
    originalText: '合成提醒，明天处理',
    businessType: 'todo',
    operation: 'create_todo',
    operations: [{
      operationId: 'create-todo-1',
      type: 'CREATE_TODO',
      entityType: 'TODO',
      action: 'CREATE',
      targetId: '',
      temporaryId: 'temp:todo:1',
      collection: 'todos',
      payload: {
        id: 'temp:todo:1',
        title: '合成提醒',
        dueDate: '2026-07-24',
        originalText: '合成提醒，明天处理'
      },
      preconditions: [],
      dependsOn: [],
      relationUpdates: []
    }],
    dependencies: [],
    preconditions: [
      { type: 'STATE_FINGERPRINT', expected: 'state-fingerprint-0' },
      { type: 'STATE_VERSION', expected: 0 }
    ],
    collectionOrders: { todos: ['temp:todo:1'] },
    expectedBusinessDiff: { todos: { created: [], updated: [], deleted: [] } },
    expectedFullDiff: { todos: { created: [], updated: [], deleted: [] } },
    commitTargetPolicy: 'REAL_OR_MEMORY',
    blocked: false,
    blockingIssues: [],
    warnings: [],
    createdAt: FIXED_NOW
  }, overrides);
  plan.planHash = computePlanHash(plan);
  plan.idempotencyKey = `record-save:${plan.planHash}`;
  return plan;
}

function baseEligibilityInput(options = {}) {
  const gateway = options.gateway || createFakeStorageGateway({
    [LEGACY_BUSINESS_STORAGE_KEY]: { meta: { onboarded: true }, todos: [] }
  });
  const writerCoordinator = options.writerCoordinator || createRecordStorageCoordinator({
    mode: 'TRANSACTION_PREVIEW',
    gateway
  });
  const storageTarget = options.storageTarget || createIsolatedRecordSaveCutoverTarget({
    targetKind: STORAGE_TARGET_KINDS.FAKE,
    writerCoordinator
  });
  const provider = options.configProvider || testProvider(
    options.mode || RECORD_SAVE_CUTOVER_MODES.SHARED_CANARY
  );
  const trustedConfig = resolveTrustedRecordSaveCutoverConfig({
    environment: RECORD_SAVE_CUTOVER_ENVIRONMENTS.ISOLATED_TEST,
    provider,
    nowInstant: FIXED_NOW,
    appVersion: '2.0.0-test',
    buildFlavor: 'ISOLATED_TEST'
  });
  const cutoverEvidence = options.cutoverEvidence || testEvidence(options.evidenceOverrides);
  return Object.assign({
    environment: RECORD_SAVE_CUTOVER_ENVIRONMENTS.ISOLATED_TEST,
    configProvider: provider,
    trustedConfig,
    nowInstant: FIXED_NOW,
    appVersion: '2.0.0-test',
    buildFlavor: 'ISOLATED_TEST',
    cutoverEvidence,
    storageTarget,
    writerCoordinator,
    businessType: 'todo',
    operation: 'create_todo',
    preflight: {
      domainCanSaveFormal: true,
      preflightFingerprint: 'preflight-fingerprint-1',
      aiChecks: { providerKind: 'REAL' }
    },
    confirmation: {
      confirmationId: 'confirmation-cutover-1',
      revision: 1,
      contentHash: 'confirmation-hash-1',
      domain: { domainCanSaveFormal: true }
    },
    savePlan: basePlan(),
    stateRevision: 0,
    stateFingerprint: 'state-fingerprint-0',
    providerKind: 'REAL',
    resultScope: 'PRODUCTION_RESULT',
    shadowComparison: {
      equivalent: true,
      fullDifferences: []
    },
    recoveryState: RECORD_STORAGE_RECOVERY_STATES.CLEAN,
    transactionState: RECORD_STORAGE_TRANSACTION_STATES.CLEAN,
    readbackVerified: true,
    receiptConsistent: true,
    transactionMetadataValid: true,
    transactionMaterialsResolved: true,
    legacyPreflightAllowed: true,
    legacyConfirmationAllowed: true,
    latestStateReread: true,
    legacyPreflightRevalidated: true,
    duplicateRiskAbsent: true
  }, options.overrides || {});
}

function testFallbackOutcome(input, overrides = {}) {
  return createIsolatedRecordSaveFallbackOutcome(Object.assign({
    writerCoordinator: input.writerCoordinator,
    stage: RECORD_SAVE_FALLBACK_STAGES.BEFORE_TRANSACTION_MATERIALS,
    recoveryState: RECORD_STORAGE_RECOVERY_STATES.CLEAN,
    transactionState: RECORD_STORAGE_TRANSACTION_STATES.CLEAN,
    stateMatchesBase: true,
    revisionMatchesBase: true,
    fingerprintMatchesBase: true,
    successReceiptExists: false,
    latestStateReread: true,
    legacyPreflightRevalidated: true,
    duplicateRiskAbsent: true
  }, overrides));
}

function hasCode(result, code) {
  return (result.blockingReasons || []).some((entry) => entry.code === code);
}

function oldBundle() {
  return {
    meta: { onboarded: true, unknownMeta: 'keep-meta' },
    customers: [],
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    todos: [],
    pendingNotes: [],
    orderProgress: [],
    aiParseLogs: [],
    operationLogs: [],
    productCatalog: [],
    dunningRecords: [],
    deletedRecords: [],
    unknownTopLevel: { preserved: true }
  };
}

function targetWithTodo(bundle, id) {
  const target = stripRecordStorageControl(clone(bundle));
  target.todos = (target.todos || []).concat([{
    id,
    title: `合成提醒-${id}`,
    dueDate: '2026-07-24',
    originalText: `合成原文-${id}`
  }]);
  return target;
}

function transactionInput(snapshot, target, suffix) {
  return {
    transactionId: `cutover-transaction-${suffix}`,
    planId: `cutover-plan-${suffix}`,
    planHash: `cutover-plan-hash-${suffix}`,
    idempotencyKey: `cutover-idempotency-${suffix}`,
    baseRevision: snapshot.revision,
    baseFingerprint: snapshot.businessFingerprint,
    targetBundle: target,
    committedAt: FIXED_NOW,
    writerSource: `CUTOVER_${suffix}`,
    riskLevel: 'NORMAL'
  };
}

test('可信配置只接受受保护Provider且生产始终硬钳制LEGACY_ONLY', () => {
  const build = createBuildStaticRecordSaveCutoverConfigProvider();
  const buildConfig = resolveTrustedRecordSaveCutoverConfig({
    environment: 'PRODUCTION',
    provider: build,
    nowInstant: FIXED_NOW
  });
  assert.strictEqual(buildConfig.trusted, true);
  assert.strictEqual(buildConfig.sourceKind, 'BUILD_STATIC');
  assert.strictEqual(buildConfig.effectiveMode, 'LEGACY_ONLY');

  const fake = testProvider('SHARED_CANARY');
  const isolated = resolveTrustedRecordSaveCutoverConfig({
    environment: 'ISOLATED_TEST',
    provider: testProvider('SHARED_CANARY', {
      monitoringPolicy: {
        enabled: true,
        remoteUploadEnabled: true,
        maxEvents: 9999
      }
    }),
    nowInstant: FIXED_NOW
  });
  assert.strictEqual(isolated.effectiveMode, 'SHARED_CANARY');
  assert.strictEqual(isolated.monitoringPolicy.remoteUploadEnabled, false);
  assert.strictEqual(isolated.monitoringPolicy.maxEvents, 512);
  assert.strictEqual(Object.isFrozen(isolated), true);
  assert.strictEqual(Object.isFrozen(isolated.allowedBuildVersions), true);
  assert.throws(() => isolated.allowedBuildVersions.push('forged-version'));
  const production = resolveTrustedRecordSaveCutoverConfig({
    environment: 'PRODUCTION',
    provider: fake,
    nowInstant: FIXED_NOW
  });
  assert.strictEqual(production.effectiveMode, 'LEGACY_ONLY');
  assert.strictEqual(production.trustFailureReason, 'PRODUCTION_SHARED_HARD_DISABLED');

  const forged = resolveTrustedRecordSaveCutoverConfig({
    environment: 'ISOLATED_TEST',
    provider: { getConfig: () => testConfig('SHARED_PRIMARY') },
    nowInstant: FIXED_NOW
  });
  assert.strictEqual(forged.trusted, false);
  assert.strictEqual(forged.effectiveMode, 'LEGACY_ONLY');

  const expired = resolveTrustedRecordSaveCutoverConfig({
    environment: 'ISOLATED_TEST',
    provider: testProvider('SHARED_CANARY', { expiresAt: '2026-07-22T00:00:00.000Z' }),
    nowInstant: FIXED_NOW
  });
  assert.strictEqual(expired.trusted, false);
  assert.strictEqual(expired.trustFailureReason, 'CUTOVER_CONFIG_EXPIRED');
});

test('五种模式相互隔离且普通生产入口永远不进入Shared', () => {
  const productionInput = baseEligibilityInput({
    configProvider: testProvider('SHARED_PRIMARY')
  });
  const production = resolveRecordSaveExecutionDecision(Object.assign({}, productionInput, {
    environment: 'PRODUCTION'
  }));
  assert.strictEqual(production.effectiveMode, 'LEGACY_ONLY');
  assert.strictEqual(production.primaryPath, 'LEGACY');

  const modes = [
    ['LEGACY_ONLY', 'LEGACY', 'NONE'],
    ['SHADOW_PREVIEW', 'LEGACY', 'SHARED_PREVIEW'],
    ['SHARED_CANARY', 'SHARED', 'LEGACY_SIMULATION'],
    ['SHARED_PRIMARY', 'SHARED', 'LEGACY_SIMULATION']
  ];
  modes.forEach(([mode, primaryPath, shadowPath]) => {
    const input = baseEligibilityInput({ configProvider: testProvider(mode), mode });
    const decision = resolveRecordSaveExecutionDecision(input);
    assert.strictEqual(decision.effectiveMode, mode);
    assert.strictEqual(decision.primaryPath, primaryPath);
    assert.strictEqual(decision.shadowPath, shadowPath);
  });

  const locked = resolveRecordSaveExecutionDecision(Object.assign(
    {},
    baseEligibilityInput({ configProvider: testProvider('LEGACY_ONLY', { killSwitch: true }) }),
    { recoveryState: 'RECOVERY_REQUIRED' }
  ));
  assert.strictEqual(locked.effectiveMode, 'RECOVERY_LOCKED');
  assert.strictEqual(locked.primaryPath, 'BLOCKED');
  assert.strictEqual(locked.legacyEligibility.eligible, false);
});

test('共享资格完整门禁逐项fail closed', () => {
  const cases = [
    ['CUTOVER_CONFIG_UNTRUSTED', (input) => { input.trustedConfig = clone(input.trustedConfig); input.trustedConfig.trusted = false; input.trustedConfig.trustFailureReason = 'CUTOVER_CONFIG_UNTRUSTED'; }],
    ['CUTOVER_EVIDENCE_UNTRUSTED', (input) => { input.cutoverEvidence = { getIdentity: () => ({}) }; }],
    ['BUILD_VERSION_NOT_ALLOWED', (input) => { input.cutoverEvidence = testEvidence({ appVersion: '1.0.0-old' }); }],
    ['BUILD_FLAVOR_NOT_ALLOWED', (input) => { input.cutoverEvidence = testEvidence({ buildFlavor: 'PRODUCTION' }); }],
    ['BUILD_FLAVOR_NOT_ALLOWED', (input) => { input.trustedConfig = resolveTrustedRecordSaveCutoverConfig({ environment: 'ISOLATED_TEST', provider: testProvider('SHARED_CANARY', { allowedBuildFlavors: [] }), nowInstant: FIXED_NOW }); }],
    ['STORAGE_SCHEMA_NOT_ALLOWED', (input) => { input.storageTarget = createIsolatedRecordSaveCutoverTarget({ targetKind: STORAGE_TARGET_KINDS.FAKE, storageSchemaVersion: 'old-storage', writerCoordinator: input.writerCoordinator }); }],
    ['TRANSACTION_PROTOCOL_NOT_ALLOWED', (input) => { input.storageTarget = createIsolatedRecordSaveCutoverTarget({ targetKind: STORAGE_TARGET_KINDS.FAKE, transactionProtocolVersion: 'old-transaction', writerCoordinator: input.writerCoordinator }); }],
    ['WRITER_COORDINATOR_NOT_READY', (input) => { input.writerCoordinator = {}; }],
    ['STORAGE_TARGET_COORDINATOR_MISMATCH', (input) => {
      const other = createRecordStorageCoordinator({
        mode: 'TRANSACTION_PREVIEW',
        gateway: createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: oldBundle() })
      });
      input.writerCoordinator = other;
    }],
    ['RECOVERY_LOCKED', (input) => { input.recoveryState = 'RECOVERY_REQUIRED'; }],
    ['RECOVERY_EVIDENCE_INCOMPLETE', (input) => { input.cutoverEvidence = testEvidence({ readbackVerified: false }); }],
    ['BUSINESS_TYPE_NOT_ALLOWED', (input) => { input.businessType = 'payment'; }],
    ['OPERATION_NOT_ALLOWED', (input) => { input.operation = 'record_payment'; }],
    ['PREFLIGHT_NOT_ELIGIBLE', (input) => { input.preflight.domainCanSaveFormal = false; }],
    ['CONFIRMATION_BINDING_INVALID', (input) => { input.confirmation.contentHash = ''; }],
    ['CONFIRMATION_BINDING_INVALID', (input) => { input.savePlan = basePlan({ confirmationRevision: 2 }); }],
    ['SAVE_PLAN_INVALID', (input) => { input.savePlan = Object.assign({}, input.savePlan, { idempotencyKey: '' }); }],
    ['PROVIDER_NOT_COMMITTABLE', (input) => { input.providerKind = 'FAKE'; }],
    ['PROVIDER_NOT_COMMITTABLE', (input) => { input.providerKind = 'UNKNOWN'; }],
    ['RESULT_SCOPE_NOT_COMMITTABLE', (input) => { input.resultScope = 'AI_ONLY_RESULT'; }],
    ['STATE_BINDING_MISMATCH', (input) => { input.stateFingerprint = 'changed'; }],
    ['SHADOW_DIFFERENCE_BLOCKING', (input) => { input.shadowComparison = { equivalent: false, fullDifferences: [{ collection: 'orders', types: ['BUSINESS_DATA_DIFFERENCE'] }] }; }],
    ['SHADOW_DIFFERENCE_BLOCKING', (input) => { input.shadowComparison = { equivalent: true, fullDifferences: [{ collection: 'orders', types: ['BUSINESS_DATA_DIFFERENCE'] }] }; }],
    ['CANARY_COHORT_NOT_ELIGIBLE', (input) => { input.cutoverEvidence = testEvidence({ cohortEligible: false }); }],
    ['CANARY_COHORT_NOT_ELIGIBLE', (input) => { input.cutoverEvidence = testEvidence({ canarySampleAccepted: false }); }],
    ['CANARY_COHORT_NOT_ELIGIBLE', (input) => {
      input.trustedConfig = resolveTrustedRecordSaveCutoverConfig({
        environment: 'ISOLATED_TEST',
        provider: testProvider('SHARED_CANARY', { cohortPolicy: { kind: 'INTERNAL_A' } }),
        nowInstant: FIXED_NOW
      });
      input.cutoverEvidence = testEvidence({ cohortPolicyKind: 'INTERNAL_B' });
    }],
    ['RELEASE_A_COVERAGE_UNVERIFIED', (input) => { input.cutoverEvidence = testEvidence({ releaseAVerified: false }); }],
    ['OLD_WRITER_EXIT_UNVERIFIED', (input) => { input.cutoverEvidence = testEvidence({ oldWritersRetired: false }); }],
    ['TRANSACTIONAL_LEGACY_FALLBACK_REQUIRED', (input) => { input.cutoverEvidence = testEvidence({ transactionalLegacyFallbackReady: false }); }],
    ['WRITER_COORDINATOR_NOT_READY', (input) => {
      input.trustedConfig = resolveTrustedRecordSaveCutoverConfig({
        environment: 'ISOLATED_TEST',
        provider: testProvider('SHARED_CANARY', {
          minimumCoordinatorVersion: 'record-storage-coordinator-v2'
        }),
        nowInstant: FIXED_NOW
      });
      input.cutoverEvidence = testEvidence({
        minimumCoordinatorVersion: 'record-storage-coordinator-v2'
      });
    }]
  ];
  cases.forEach(([code, mutate], index) => {
    const input = baseEligibilityInput();
    mutate(input);
    const result = evaluateSharedSaveEligibility(input);
    assert.strictEqual(result.eligible, false, `${index}:${code}`);
    assert.strictEqual(hasCode(result, code), true, `${index}:${code}:${JSON.stringify(result)}`);
  });
  assert.strictEqual(evaluateSharedSaveEligibility(baseEligibilityInput()).eligible, true);

  const shadowNotSelected = baseEligibilityInput({
    configProvider: testProvider('SHADOW_PREVIEW', { shadowSampleRate: 0 })
  });
  const shadowEligibility = evaluateSharedSaveEligibility(shadowNotSelected);
  assert.strictEqual(shadowEligibility.eligible, false);
  assert.strictEqual(hasCode(shadowEligibility, 'SHADOW_SAMPLE_NOT_SELECTED'), true);
});

test('阶段化回退矩阵只允许写前和已验证回滚两类', () => {
  const preWrite = resolveRecordSaveFallbackPolicy({
    stage: 'BEFORE_TRANSACTION_MATERIALS',
    legacyEligible: true,
    latestStateReread: true,
    legacyPreflightRevalidated: true,
    duplicateRiskAbsent: true
  });
  assert.strictEqual(preWrite.policy, 'PRE_WRITE_FALLBACK');
  assert.strictEqual(preWrite.allowedNow, true);

  const prepared = resolveRecordSaveFallbackPolicy({
    stage: 'JOURNAL_PREPARED',
    legacyEligible: true,
    recoveryState: 'RECOVERED_ROLLED_BACK',
    stateMatchesBase: true,
    revisionMatchesBase: true,
    fingerprintMatchesBase: true,
    successReceiptExists: false,
    latestStateReread: true,
    legacyPreflightRevalidated: true,
    duplicateRiskAbsent: true
  });
  assert.strictEqual(prepared.policy, 'VERIFIED_ROLLBACK_FALLBACK');
  assert.strictEqual(prepared.allowedNow, true);
  const rollbackInput = baseEligibilityInput({
    configProvider: testProvider('SHARED_CANARY', {
      fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.VERIFIED_ROLLBACK_FALLBACK
    }),
    cutoverEvidence: testEvidence({
      recoveryState: 'RECOVERED_ROLLED_BACK'
    })
  });
  delete rollbackInput.recoveryState;
  rollbackInput.fallbackOutcome = testFallbackOutcome(rollbackInput, {
    stage: 'JOURNAL_PREPARED',
    recoveryState: 'RECOVERED_ROLLED_BACK'
  });
  const throughController = resolveRecordSaveExecutionDecision(rollbackInput);
  assert.strictEqual(throughController.primaryPath, 'LEGACY');
  assert.strictEqual(throughController.fallbackPolicy, 'VERIFIED_ROLLBACK_FALLBACK');
  assert.strictEqual(throughController.fallbackAllowedNow, true);

  const forbiddenStages = [
    'BACKUP_WRITTEN',
    'BEFORE_JOURNAL',
    'MAIN_BUNDLE_MAY_HAVE_CHANGED',
    'READBACK_UNCERTAIN',
    'RECEIPT_UNCERTAIN',
    'RECOVERY_REQUIRED',
    'SHARED_COMMITTED',
    'STALE_SNAPSHOT',
    'PLAN_COLLISION',
    'FINANCIAL_INVARIANT_FAILED'
  ];
  forbiddenStages.forEach((stage) => {
    const result = resolveRecordSaveFallbackPolicy({
      stage,
      legacyEligible: true,
      latestStateReread: true,
      legacyPreflightRevalidated: true,
      duplicateRiskAbsent: true
    });
    assert.strictEqual(result.policy, 'NO_FALLBACK', stage);
    assert.strictEqual(result.allowedNow, false, stage);
  });
  ['', 'BOGUS_STAGE'].forEach((stage) => {
    const result = resolveRecordSaveFallbackPolicy({
      stage,
      legacyEligible: true,
      latestStateReread: true,
      legacyPreflightRevalidated: true,
      duplicateRiskAbsent: true
    });
    assert.strictEqual(result.policy, 'NO_FALLBACK');
    assert.strictEqual(result.allowedNow, false);
  });

  const forgedRollback = resolveRecordSaveExecutionDecision(Object.assign(
    {},
    baseEligibilityInput({
      configProvider: testProvider('SHARED_CANARY', {
        fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.VERIFIED_ROLLBACK_FALLBACK
      }),
      cutoverEvidence: testEvidence({ recoveryState: 'RECOVERED_ROLLED_BACK' })
    }),
    {
      fallbackOutcome: { getIdentity: () => ({ stage: 'JOURNAL_PREPARED' }) },
      fallbackStage: 'JOURNAL_PREPARED',
      stateMatchesBase: true,
      revisionMatchesBase: true,
      fingerprintMatchesBase: true,
      successReceiptExists: false,
      latestStateReread: true,
      legacyPreflightRevalidated: true,
      duplicateRiskAbsent: true
    }
  ));
  assert.strictEqual(forgedRollback.primaryPath, 'BLOCKED');
  assert.strictEqual(forgedRollback.fallbackAllowedNow, false);

  const noFallbackInput = baseEligibilityInput({
    configProvider: testProvider('SHARED_CANARY', {
      fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK
    })
  });
  noFallbackInput.savePlan = Object.assign({}, noFallbackInput.savePlan, {
    idempotencyKey: ''
  });
  noFallbackInput.fallbackOutcome = testFallbackOutcome(noFallbackInput);
  const noFallbackDecision = resolveRecordSaveExecutionDecision(noFallbackInput);
  assert.strictEqual(noFallbackDecision.primaryPath, 'BLOCKED');
  assert.strictEqual(noFallbackDecision.fallbackAllowedNow, false);

  const preWriteInput = baseEligibilityInput({
    configProvider: testProvider('SHARED_CANARY', {
      fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.PRE_WRITE_FALLBACK
    })
  });
  preWriteInput.savePlan = Object.assign({}, preWriteInput.savePlan, {
    idempotencyKey: ''
  });
  preWriteInput.fallbackOutcome = testFallbackOutcome(preWriteInput);
  const preWriteDecision = resolveRecordSaveExecutionDecision(preWriteInput);
  assert.strictEqual(preWriteDecision.primaryPath, 'LEGACY');
  assert.strictEqual(preWriteDecision.fallbackPolicy, 'PRE_WRITE_FALLBACK');

  assert.throws(() => testEvidence({ transactionState: 'BOGUS' }));
  assert.throws(() => testEvidence({ recoveryState: 'BOGUS' }));
  [
    { transactionState: 'BOGUS' },
    { recoveryState: 'BOGUS' },
    { transactionState: 'FAILED' },
    { transactionState: 'ROLLED_BACK' },
    { recoveryState: 'RECOVERED_ROLLED_BACK' }
  ].forEach((hazard) => {
    const blocked = resolveRecordSaveExecutionDecision(Object.assign(
      {},
      baseEligibilityInput(),
      hazard
    ));
    assert.strictEqual(blocked.primaryPath, 'BLOCKED', JSON.stringify(hazard));
    assert.strictEqual(blocked.fallbackAllowedNow, false, JSON.stringify(hazard));
  });

  const terminalEvidenceInput = baseEligibilityInput({
    configProvider: testProvider('SHARED_CANARY', {
      fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.VERIFIED_ROLLBACK_FALLBACK
    }),
    cutoverEvidence: testEvidence({
      recoveryState: 'RECOVERY_REQUIRED',
      transactionState: 'COMMITTED'
    })
  });
  terminalEvidenceInput.recoveryState = 'RECOVERED_ROLLED_BACK';
  terminalEvidenceInput.transactionState = 'ROLLED_BACK';
  terminalEvidenceInput.fallbackOutcome = testFallbackOutcome(terminalEvidenceInput, {
    stage: 'JOURNAL_PREPARED',
    recoveryState: 'RECOVERED_ROLLED_BACK',
    transactionState: 'ROLLED_BACK'
  });
  const terminalEvidenceDecision = resolveRecordSaveExecutionDecision(terminalEvidenceInput);
  assert.strictEqual(terminalEvidenceDecision.primaryPath, 'BLOCKED');
  assert.strictEqual(terminalEvidenceDecision.effectiveMode, 'RECOVERY_LOCKED');
});

test('模糊结果、已提交、stale和碰撞场景Legacy执行次数恒为0', () => {
  const stages = [
    'MAIN_BUNDLE_MAY_HAVE_CHANGED',
    'READBACK_UNCERTAIN',
    'RECEIPT_UNCERTAIN',
    'RECOVERY_REQUIRED',
    'SHARED_COMMITTED',
    'STALE_SNAPSHOT',
    'PLAN_COLLISION'
  ];
  let legacyCalls = 0;
  stages.forEach((stage) => {
    const fallback = resolveRecordSaveFallbackPolicy({
      stage,
      legacyEligible: true,
      latestStateReread: true,
      legacyPreflightRevalidated: true,
      duplicateRiskAbsent: true
    });
    if (fallback.allowedNow) legacyCalls += 1;
  });
  assert.strictEqual(legacyCalls, 0);
});

test('Shadow差异分级禁止业务、金融、关系、丢失和未知差异', () => {
  const cases = [
    [{ equivalent: true }, 'NO_DIFFERENCE', false],
    [{ equivalent: false, fullDifferences: [{ collection: 'operationLogs', types: ['LOGGING_DIFFERENCE'] }] }, 'LOGGING_ONLY', false],
    [{ equivalent: false, fullDifferences: [{ collection: 'orders', types: ['ORDERING_ONLY'] }] }, 'ORDERING_ONLY', false],
    [{ equivalent: false, fullDifferences: [{ collection: 'paymentRecords', types: ['BUSINESS_DATA_DIFFERENCE'] }] }, 'FINANCIAL_DIFFERENCE', true],
    [{ equivalent: false, fullDifferences: [{ collection: 'orders', types: ['RELATION_DIFFERENCE'] }] }, 'RELATION_DIFFERENCE', true],
    [{ equivalent: false, fullDifferences: [{ collection: 'orders', types: ['SAVE_PLAN_MISSING_OPERATION'] }] }, 'DATA_LOSS', true],
    [{ equivalent: false, fullDifferences: [] }, 'UNKNOWN', true],
    [{ equivalent: false, fullDifferences: [{ collection: 'orders', types: [] }] }, 'UNKNOWN', true],
    [{ equivalent: false, fullDifferences: [{ collection: 'orders' }] }, 'UNKNOWN', true]
  ];
  cases.forEach(([comparison, classification, blocksShared]) => {
    const result = classifyRecordSaveShadowDifference(comparison);
    assert.strictEqual(result.classification, classification);
    assert.strictEqual(result.blocksShared, blocksShared);
  });
});

test('22个既有Legacy与Shared等价场景均可作为安全Shadow基线', async () => {
  let count = 0;
  await runLegacyEquivalenceWithVisitor((entry) => {
    count += 1;
    const legacy = canonicalState(entry.legacyState, entry.initialState);
    const shared = canonicalState(entry.sharedState, entry.initialState);
    const comparison = compareRecordSaveShadowStates({
      legacyState: legacy,
      sharedState: shared
    });
    const classified = classifyRecordSaveShadowDifference(comparison);
    assert.strictEqual(comparison.equivalent, true, entry.name);
    assert.strictEqual(classified.classification, 'NO_DIFFERENCE', entry.name);
    assert.strictEqual(classified.blocksShared, false, entry.name);
  });
  assert.strictEqual(count, 22);
});

test('Legacy→Shared→事务兼容Legacy→Shared协议模拟保持revision receipt和未知字段', () => {
  const gateway = createFakeStorageGateway({
    [LEGACY_BUSINESS_STORAGE_KEY]: oldBundle()
  });
  const legacyCoordinator = createRecordStorageCoordinator({ mode: 'LEGACY_ONLY', gateway });
  const state = legacyCoordinator.readState(() => ({}));
  state.todos.push({ id: 'legacy-0', title: '旧语义提醒', originalText: '合成旧语义' });
  legacyCoordinator.writeLegacyState(state, { writerSource: 'CUTOVER_LEGACY_INITIAL' });

  const manager = createPersistentRecordTransactionManager({
    gateway,
    mode: 'TRANSACTION_PREVIEW'
  });
  const snapshots = [];
  ['shared-1', 'legacy-transactional-2', 'shared-3'].forEach((suffix) => {
    const snapshot = manager.readTransactionSnapshot();
    snapshots.push(snapshot);
    const target = targetWithTodo(snapshot.bundle, suffix);
    const receipt = manager.commitBundle(transactionInput(snapshot, target, suffix));
    assert.strictEqual(receipt.status, 'COMMITTED', suffix);
  });
  const finalSnapshot = manager.readTransactionSnapshot();
  assert.deepStrictEqual(snapshots.map((item) => item.revision), [0, 1, 2]);
  assert.strictEqual(finalSnapshot.revision, 3);
  assert.strictEqual(finalSnapshot.control.recentReceipts.length, 3);
  assert.strictEqual(finalSnapshot.bundle.unknownTopLevel.preserved, true);
  assert.strictEqual(finalSnapshot.bundle.meta.unknownMeta, 'keep-meta');
  assert.deepStrictEqual(
    finalSnapshot.bundle.todos.map((item) => item.id),
    ['legacy-0', 'shared-1', 'legacy-transactional-2', 'shared-3']
  );
  assert.strictEqual(readRecordStorageControl(finalSnapshot.bundle).schemaVersion, RECORD_STORAGE_CONTROL_SCHEMA_VERSION);
});

test('旧版本覆盖与非事务Legacy回退未证明时Shared资格明确阻断', () => {
  const oldWriter = baseEligibilityInput({
    cutoverEvidence: testEvidence({ oldWritersRetired: false })
  });
  assert.strictEqual(hasCode(
    evaluateSharedSaveEligibility(oldWriter),
    RECORD_SAVE_CUTOVER_ERROR_CODES.OLD_WRITER_EXIT_UNVERIFIED
  ), true);

  const fallbackMissing = baseEligibilityInput({
    cutoverEvidence: testEvidence({ transactionalLegacyFallbackReady: false })
  });
  assert.strictEqual(hasCode(
    evaluateSharedSaveEligibility(fallbackMissing),
    RECORD_SAVE_CUTOVER_ERROR_CODES.TRANSACTIONAL_LEGACY_FALLBACK_REQUIRED
  ), true);

  const legacyAfterShared = resolveRecordSaveExecutionDecision(Object.assign(
    {},
    baseEligibilityInput({
      configProvider: testProvider('LEGACY_ONLY'),
      cutoverEvidence: testEvidence({ transactionalLegacyFallbackReady: false })
    }),
    {
      stateRevision: 1
    }
  ));
  assert.strictEqual(legacyAfterShared.primaryPath, 'BLOCKED');
  assert.strictEqual(legacyAfterShared.legacyEligibility.pathKind, 'TRANSACTIONAL_LEGACY');
});

test('监测严格白名单脱敏且不上传不落业务Bundle', () => {
  const sensitive = {
    appVersion: '2.0.0-test',
    configVersion: 'config-v1',
    executionMode: 'SHARED_CANARY',
    businessType: 'todo',
    operation: 'create_todo',
    errorCode: 'READBACK_FAILED',
    revision: 3,
    planHash: 'plan1_abcdef0123456789abcdef0123456789',
    originalText: '王总手机号13800138000欠款8888元',
    customerName: '王总',
    phone: '13800138000',
    amount: '8888',
    productName: '礼品盒',
    payload: { secret: true },
    errorMessage: '王总8888元失败'
  };
  const event = sanitizeRecordSaveCutoverEvent('CUTOVER_DECISION', sensitive, {
    sequence: 1,
    occurredAt: FIXED_NOW
  });
  const text = JSON.stringify(event);
  ['王总', '13800138000', '8888', '礼品盒', 'secret'].forEach((value) => {
    assert.strictEqual(text.includes(value), false, value);
  });
  assert.strictEqual(event.planHashPrefix, 'plan1_abcdef012345');
  const asciiLeak = sanitizeRecordSaveCutoverEvent('CUTOVER_DECISION', {
    appVersion: 'phone13800138000',
    configVersion: 'CustomerAlice_Amount8888_ProductWidget',
    businessType: 'CustomerAlice',
    operation: 'ProductWidget',
    errorCode: 'phone13800138000',
    planHash: 'not-a-hash-secret'
  });
  assert.strictEqual(asciiLeak.businessType, 'unknown');
  assert.strictEqual(asciiLeak.operation, 'unknown');
  assert.strictEqual(asciiLeak.errorCode, 'UNCLASSIFIED_TECHNICAL_ERROR');
  assert.strictEqual(asciiLeak.planHashPrefix, '');
  assert.strictEqual(asciiLeak.appVersion, 'unknown');
  assert.strictEqual(JSON.stringify(asciiLeak).includes('13800138000'), false);
  assert.strictEqual(JSON.stringify(asciiLeak).includes('CustomerAlice'), false);
  const monitor = createRecordSaveCutoverMonitor({
    maxEvents: 2,
    clock: { now: () => new Date(FIXED_NOW) }
  });
  monitor.record('CUTOVER_DECISION', sensitive);
  monitor.record('SHARED_INELIGIBLE', sensitive);
  monitor.record('RECOVERY_LOCKED', sensitive);
  assert.strictEqual(monitor.getEvents().length, 2);
  assert.strictEqual(monitor.getPolicy().remoteUploadEnabled, false);

  const disabledMonitor = createRecordSaveCutoverMonitor({ maxEvents: 2 });
  const disabledController = createRecordSaveCutoverController({
    environment: 'PRODUCTION',
    configProvider: createBuildStaticRecordSaveCutoverConfigProvider(),
    monitor: disabledMonitor
  });
  disabledController.decide(baseEligibilityInput());
  assert.deepStrictEqual(disabledMonitor.getEvents(), []);
  assert.strictEqual(monitor.getPolicy().storagePersistenceEnabled, false);
  monitor.clear();
  assert.deepStrictEqual(monitor.getEvents(), []);
});

test('Kill Switch只影响下一笔且绝不能绕过Recovery Lock', () => {
  const killProvider = testProvider('SHARED_CANARY', { killSwitch: true });
  const nextDecision = resolveRecordSaveExecutionDecision(baseEligibilityInput({
    configProvider: killProvider
  }));
  assert.strictEqual(nextDecision.effectiveMode, 'LEGACY_ONLY');
  assert.strictEqual(nextDecision.primaryPath, 'LEGACY');

  [
    { transactionState: 'COMMITTED', fallbackStage: 'SHARED_COMMITTED' },
    { transactionState: 'STALE_STORAGE_SNAPSHOT', fallbackStage: 'STALE_SNAPSHOT' },
    { fallbackStage: 'PLAN_COLLISION' },
    { mainBundleMayHaveChanged: true },
    { receiptStatusAmbiguous: true }
  ].forEach((hazard) => {
    const blocked = resolveRecordSaveExecutionDecision(Object.assign(
      {},
      baseEligibilityInput({ configProvider: killProvider }),
      hazard
    ));
    assert.strictEqual(blocked.primaryPath, 'BLOCKED', JSON.stringify(hazard));
    assert.strictEqual(blocked.fallbackAllowedNow, false, JSON.stringify(hazard));
    assert.strictEqual(blocked.legacyEligibility.eligible, false, JSON.stringify(hazard));
  });

  const locked = resolveRecordSaveExecutionDecision(Object.assign(
    {},
    baseEligibilityInput({ configProvider: killProvider }),
    {
      transactionState: 'COMMIT_OUTCOME_UNKNOWN',
      transactionStatusAmbiguous: true
    }
  ));
  assert.strictEqual(locked.effectiveMode, 'RECOVERY_LOCKED');
  assert.strictEqual(locked.primaryPath, 'BLOCKED');
  assert.strictEqual(locked.fallbackAllowedNow, false);
  assert.strictEqual(evaluateRecordSaveRecoveryLock({
    transactionState: 'COMMITTED_CLEANUP_PENDING'
  }).active, true);
  assert.strictEqual(evaluateRecordSaveRecoveryLock({
    transactionState: 'PREPARED'
  }).active, true);

  const configLocked = resolveRecordSaveExecutionDecision(baseEligibilityInput({
    configProvider: testProvider('LEGACY_ONLY', { recoveryLock: true })
  }));
  assert.strictEqual(configLocked.effectiveMode, 'RECOVERY_LOCKED');
  assert.strictEqual(configLocked.primaryPath, 'BLOCKED');
  assert.strictEqual(configLocked.legacyEligibility.eligible, false);
});

test('生产硬关闭、页面未接入且控制器不执行保存或远程上传', () => {
  const monitor = createRecordSaveCutoverMonitor({ maxEvents: 8 });
  const controller = createRecordSaveCutoverController({
    environment: 'PRODUCTION',
    configProvider: testProvider('SHARED_PRIMARY'),
    monitor
  });
  const sensitiveInput = baseEligibilityInput();
  sensitiveInput.businessType = '客户Alice13800138000';
  sensitiveInput.operation = '金额8888';
  const decision = controller.decide(sensitiveInput);
  assert.strictEqual(decision.effectiveMode, 'LEGACY_ONLY');
  assert.notStrictEqual(decision.primaryPath, 'SHARED');
  const publicDecisionText = stableSerialize({
    monitoringEvents: decision.monitoringEvents,
    monitoringTags: decision.sharedEligibility.monitoringTags
  });
  ['Alice', '13800138000', '8888', sensitiveInput.savePlan.planHash].forEach((value) => {
    assert.strictEqual(publicDecisionText.includes(value), false, value);
  });
  assert.strictEqual(
    decision.monitoringEvents[0].payload.planHashPrefix,
    sensitiveInput.savePlan.planHash.slice(0, 'plan1_'.length + 12)
  );
  assert.deepStrictEqual(controller.getControlIdentity(), {
    schemaVersion: 'record-save-cutover-controller-v1',
    environment: 'PRODUCTION',
    productionSharedCommitEnabled: false,
    realUserCanaryEnabled: false,
    remoteKillSwitchAvailable: false
  });
  assert.strictEqual(monitor.getPolicy().remoteUploadEnabled, false);

  const storageSource = fs.readFileSync(path.join(ROOT, 'utils/storage.js'), 'utf8');
  const coordinatorSource = fs.readFileSync(path.join(ROOT, 'utils/record-storage-coordinator.js'), 'utf8');
  assert(storageSource.includes("createRecordStorageCoordinator({ mode: 'LEGACY_ONLY' })"));
  assert(coordinatorSource.includes('sharedProductionCommitEnabled: false'));
  assert(coordinatorSource.includes('SHARED_PRODUCTION_COMMIT_DISABLED'));
  ['pages/input/input.js', 'pages/dashboard/dashboard.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.strictEqual(source.includes('record-save-cutover'), false, file);
  });
  assert.strictEqual(stableSerialize(monitor.getEvents()).includes('originalText'), false);
});

async function main() {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`PASS ${item.name}`);
    } catch (error) {
      console.error(`FAIL ${item.name}`);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`Phase 1E.2B.1: ${passed}/${tests.length} passed`);
}

if (require.main === module) main();

module.exports = {
  baseEligibilityInput,
  testConfig,
  testProvider
};
