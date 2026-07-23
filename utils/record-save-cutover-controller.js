const {
  RECORD_SAVE_CUTOVER_CONFIG_SCHEMA_VERSION,
  RECORD_SAVE_CUTOVER_DECISION_SCHEMA_VERSION,
  RECORD_SAVE_CUTOVER_EVIDENCE_SCHEMA_VERSION,
  RECORD_SAVE_CUTOVER_ENVIRONMENTS,
  RECORD_SAVE_CUTOVER_ERROR_CODES,
  RECORD_SAVE_CUTOVER_MODES,
  RECORD_SAVE_CUTOVER_MONITOR_EVENTS,
  RECORD_SAVE_CUTOVER_SOURCE_KINDS,
  RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS,
  RECORD_SAVE_FALLBACK_POLICIES,
  RECORD_SAVE_FALLBACK_STAGES,
  RECORD_SAVE_PRIMARY_PATHS,
  RECORD_SAVE_RECOVERY_LOCK_REASONS,
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS,
  RECORD_SAVE_SHADOW_PATHS,
  normalizeCutoverEnvironment,
  normalizeCutoverMode,
  normalizeCutoverSourceKind,
  normalizeFallbackStage
} = require('./record-save-cutover-contract');
const { SAVE_PLAN_SCHEMA_VERSION } = require('./record-save-plan-contract');
const { validatePlanShape } = require('./record-save-commit');
const {
  RECORD_STORAGE_COORDINATOR_MODES,
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('./record-storage-transaction-contract');
const { isTrustedRecordStorageCoordinator } = require('./record-storage-coordinator');
const { STORAGE_TARGET_KINDS } = require('./record-storage-adapter-contract');
const { safeClone, stableHash } = require('./record-state-diff');
const { sanitizeRecordSaveCutoverPayload } = require('./record-save-cutover-monitor');

const TRUSTED_CONFIG_PROVIDERS = new WeakMap();
const TRUSTED_RESOLVED_CONFIGS = new WeakSet();
const TRUSTED_CUTOVER_TARGETS = new WeakMap();
const TRUSTED_CUTOVER_EVIDENCE = new WeakMap();
const TRUSTED_CUTOVER_FALLBACK_OUTCOMES = new WeakMap();
const SHARED_MODES = new Set([
  RECORD_SAVE_CUTOVER_MODES.SHARED_CANARY,
  RECORD_SAVE_CUTOVER_MODES.SHARED_PRIMARY
]);
const SAFE_SHADOW_LEVELS = new Set([
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.NO_DIFFERENCE,
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.NON_BUSINESS_METADATA_ONLY,
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.ORDERING_ONLY,
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.LOGGING_ONLY
]);
const FINANCIAL_COLLECTIONS = new Set([
  'receivables', 'payments', 'paymentRecords', 'dunningRecords'
]);
const VALID_TRANSACTION_STATES = new Set(Object.values(RECORD_STORAGE_TRANSACTION_STATES));
const VALID_RECOVERY_STATES = new Set(Object.values(RECORD_STORAGE_RECOVERY_STATES));

function issue(code, details = {}) {
  return {
    code,
    details: safeClone(details)
  };
}

function monitoringEvent(type, payload = {}) {
  return {
    type,
    payload: sanitizeRecordSaveCutoverPayload(payload)
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.keys(value).forEach((key) => deepFreeze(value[key], seen));
  return Object.freeze(value);
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))).sort();
}

function normalizedRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizedMonitoringPolicy(value = {}) {
  const requestedMax = Number(value.maxEvents);
  return {
    enabled: value.enabled === true,
    remoteUploadEnabled: false,
    maxEvents: Number.isInteger(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, 512)
      : 128
  };
}

function normalizedFallbackPolicy(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(RECORD_SAVE_FALLBACK_POLICIES, normalized)
    ? RECORD_SAVE_FALLBACK_POLICIES[normalized]
    : RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK;
}

function registerResolvedConfig(config) {
  const frozen = deepFreeze(config);
  TRUSTED_RESOLVED_CONFIGS.add(frozen);
  return frozen;
}

function normalizedConfig(raw = {}, identity = {}) {
  const sourceKind = normalizeCutoverSourceKind(identity.sourceKind);
  return {
    schemaVersion: RECORD_SAVE_CUTOVER_CONFIG_SCHEMA_VERSION,
    configVersion: String(raw.configVersion || identity.configVersion || 'missing'),
    sourceKind,
    issuedAt: String(raw.issuedAt || ''),
    expiresAt: String(raw.expiresAt || ''),
    requestedMode: normalizeCutoverMode(raw.requestedMode, RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY),
    effectiveMode: RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY,
    allowedBuildVersions: uniqueStrings(raw.allowedBuildVersions),
    allowedBuildFlavors: uniqueStrings(raw.allowedBuildFlavors),
    allowedStorageSchemaVersions: uniqueStrings(raw.allowedStorageSchemaVersions),
    allowedTransactionProtocolVersions: uniqueStrings(raw.allowedTransactionProtocolVersions),
    minimumCoordinatorVersion: String(
      raw.minimumCoordinatorVersion || RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.coordinator
    ),
    minimumTransactionVersion: String(
      raw.minimumTransactionVersion || RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.transactionProtocol
    ),
    minimumStorageSchemaVersion: String(
      raw.minimumStorageSchemaVersion || RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.storageSchema
    ),
    cohortPolicy: safeClone(raw.cohortPolicy || { kind: 'NONE' }),
    operationAllowlist: uniqueStrings(raw.operationAllowlist),
    businessTypeAllowlist: uniqueStrings(raw.businessTypeAllowlist),
    shadowSampleRate: normalizedRate(raw.shadowSampleRate),
    canarySampleRate: normalizedRate(raw.canarySampleRate),
    killSwitch: raw.killSwitch === true,
    recoveryLock: raw.recoveryLock === true,
    fallbackPolicy: normalizedFallbackPolicy(raw.fallbackPolicy),
    monitoringPolicy: normalizedMonitoringPolicy(raw.monitoringPolicy),
    trusted: false,
    trustFailureReason: ''
  };
}

function registerConfigProvider(provider, identity) {
  TRUSTED_CONFIG_PROVIDERS.set(provider, Object.freeze(safeClone(identity)));
  return Object.freeze(provider);
}

function createBuildStaticRecordSaveCutoverConfigProvider(options = {}) {
  const config = Object.freeze({
    configVersion: String(options.configVersion || 'build-static-legacy-v1'),
    requestedMode: RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY,
    killSwitch: true,
    recoveryLock: false,
    fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
    monitoringPolicy: {
      enabled: options.monitoringEnabled === true,
      remoteUploadEnabled: false,
      maxEvents: 128
    }
  });
  return registerConfigProvider({
    getConfig() {
      return safeClone(config);
    }
  }, {
    sourceKind: RECORD_SAVE_CUTOVER_SOURCE_KINDS.BUILD_STATIC,
    configVersion: config.configVersion,
    productionAllowed: true,
    testOnly: false
  });
}

function createTestRecordSaveCutoverConfigProvider(config = {}, options = {}) {
  const sourceKind = normalizeCutoverSourceKind(
    options.sourceKind,
    RECORD_SAVE_CUTOVER_SOURCE_KINDS.FAKE_TEST
  );
  if (![RECORD_SAVE_CUTOVER_SOURCE_KINDS.FAKE_TEST, RECORD_SAVE_CUTOVER_SOURCE_KINDS.LOCAL_TEST]
    .includes(sourceKind)) {
    throw Object.assign(new Error('测试切换配置来源无效。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_INVALID
    });
  }
  const frozenConfig = Object.freeze(safeClone(config));
  return registerConfigProvider({
    getConfig() {
      return safeClone(frozenConfig);
    }
  }, {
    sourceKind,
    configVersion: String(config.configVersion || 'test-config-v1'),
    productionAllowed: false,
    testOnly: true
  });
}

const DEFAULT_BUILD_STATIC_PROVIDER = createBuildStaticRecordSaveCutoverConfigProvider();

function validInstant(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveTrustedRecordSaveCutoverConfig(context = {}) {
  const environment = normalizeCutoverEnvironment(context.environment);
  const provider = context.provider || DEFAULT_BUILD_STATIC_PROVIDER;
  const identity = TRUSTED_CONFIG_PROVIDERS.get(provider);
  if (!identity || typeof provider.getConfig !== 'function') {
    const output = normalizedConfig({}, {
      sourceKind: RECORD_SAVE_CUTOVER_SOURCE_KINDS.UNTRUSTED,
      configVersion: 'untrusted'
    });
    output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_UNTRUSTED;
    return registerResolvedConfig(output);
  }

  let raw;
  try {
    raw = provider.getConfig({
      environment,
      appVersion: String(context.appVersion || ''),
      buildFlavor: String(context.buildFlavor || '')
    });
  } catch (error) {
    const output = normalizedConfig({}, identity);
    output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_INVALID;
    return registerResolvedConfig(output);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const output = normalizedConfig({}, identity);
    output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_MISSING;
    return registerResolvedConfig(output);
  }

  const output = normalizedConfig(raw, identity);
  const now = validInstant(context.nowInstant) || new Date();
  const issuedAt = validInstant(output.issuedAt);
  const expiresAt = validInstant(output.expiresAt);
  if ((output.issuedAt && !issuedAt) || (output.expiresAt && !expiresAt)) {
    output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_INVALID;
    return registerResolvedConfig(output);
  }
  if (issuedAt && issuedAt.getTime() > now.getTime()) {
    output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_INVALID;
    return registerResolvedConfig(output);
  }
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_EXPIRED;
    return registerResolvedConfig(output);
  }

  output.trusted = true;
  if (environment === RECORD_SAVE_CUTOVER_ENVIRONMENTS.PRODUCTION) {
    output.effectiveMode = RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY;
    if (output.requestedMode !== RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY) {
      output.trustFailureReason = RECORD_SAVE_CUTOVER_ERROR_CODES.PRODUCTION_SHARED_HARD_DISABLED;
    }
  } else if (identity.testOnly === true) {
    output.effectiveMode = output.requestedMode;
  } else {
    output.effectiveMode = RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY;
  }
  if (output.killSwitch) output.effectiveMode = RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY;
  if (output.recoveryLock) output.effectiveMode = RECORD_SAVE_CUTOVER_MODES.RECOVERY_LOCKED;
  return registerResolvedConfig(output);
}

function createIsolatedRecordSaveCutoverEvidence(options = {}) {
  const sourceKind = normalizeCutoverSourceKind(
    options.sourceKind,
    RECORD_SAVE_CUTOVER_SOURCE_KINDS.FAKE_TEST
  );
  if (![RECORD_SAVE_CUTOVER_SOURCE_KINDS.FAKE_TEST, RECORD_SAVE_CUTOVER_SOURCE_KINDS.LOCAL_TEST]
    .includes(sourceKind)) {
    throw Object.assign(new Error('受控切换资格证据来源无效。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_EVIDENCE_UNTRUSTED
    });
  }
  const appVersion = String(options.appVersion || '').trim();
  const buildFlavor = String(options.buildFlavor || '').trim();
  if (!appVersion || !buildFlavor) {
    throw Object.assign(new Error('受控切换资格证据缺少构建身份。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_EVIDENCE_UNTRUSTED
    });
  }
  const recoveryState = String(
    options.recoveryState || RECORD_STORAGE_RECOVERY_STATES.CLEAN
  ).trim().toUpperCase();
  const transactionState = String(
    options.transactionState || RECORD_STORAGE_TRANSACTION_STATES.CLEAN
  ).trim().toUpperCase();
  if (!VALID_RECOVERY_STATES.has(recoveryState)
    || !VALID_TRANSACTION_STATES.has(transactionState)) {
    throw Object.assign(new Error('受控切换资格证据包含非法事务或恢复状态。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_EVIDENCE_UNTRUSTED
    });
  }
  const facts = deepFreeze({
    schemaVersion: RECORD_SAVE_CUTOVER_EVIDENCE_SCHEMA_VERSION,
    sourceKind,
    isolatedTestOnly: true,
    appVersion,
    buildFlavor,
    releaseA: {
      verified: options.releaseAVerified === true,
      oldWritersRetired: options.oldWritersRetired === true,
      transactionalLegacyFallbackReady: options.transactionalLegacyFallbackReady === true,
      minimumCoordinatorVersion: String(
        options.minimumCoordinatorVersion || RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.coordinator
      )
    },
    cohort: {
      eligible: options.cohortEligible === true,
      policyKind: String(options.cohortPolicyKind || 'NONE'),
      sampleAccepted: options.canarySampleAccepted === true,
      shadowSampleAccepted: options.shadowSampleAccepted === true
    },
    transaction: {
      recoveryState,
      transactionState,
      readbackVerified: options.readbackVerified === true,
      receiptConsistent: options.receiptConsistent === true,
      transactionMetadataValid: options.transactionMetadataValid === true,
      transactionMaterialsResolved: options.transactionMaterialsResolved === true,
      materialsContradictory: options.materialsContradictory === true,
      transactionMaterialCorrupt: options.transactionMaterialCorrupt === true
    }
  });
  const evidence = Object.freeze({
    getIdentity() {
      return safeClone(facts);
    }
  });
  TRUSTED_CUTOVER_EVIDENCE.set(evidence, facts);
  return evidence;
}

function getTrustedCutoverEvidence(evidence) {
  const facts = TRUSTED_CUTOVER_EVIDENCE.get(evidence);
  return facts ? safeClone(facts) : null;
}

function createIsolatedRecordSaveFallbackOutcome(options = {}) {
  const writerCoordinator = options.writerCoordinator;
  const coordinatorIdentity = writerCoordinator && typeof writerCoordinator.getIdentity === 'function'
    ? writerCoordinator.getIdentity()
    : null;
  if (!isTrustedRecordStorageCoordinator(writerCoordinator)
    || !coordinatorIdentity
    || coordinatorIdentity.mode !== RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW) {
    throw Object.assign(new Error('回退结果必须绑定可信事务预演Coordinator。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.LEGACY_FALLBACK_UNSAFE
    });
  }
  const stage = normalizeFallbackStage(options.stage, null);
  const recoveryState = String(
    options.recoveryState || RECORD_STORAGE_RECOVERY_STATES.CLEAN
  ).trim().toUpperCase();
  const transactionState = String(
    options.transactionState || RECORD_STORAGE_TRANSACTION_STATES.CLEAN
  ).trim().toUpperCase();
  if (!stage
    || !VALID_RECOVERY_STATES.has(recoveryState)
    || !VALID_TRANSACTION_STATES.has(transactionState)) {
    throw Object.assign(new Error('回退结果的阶段或事务状态无效。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.LEGACY_FALLBACK_UNSAFE
    });
  }
  const facts = deepFreeze({
    schemaVersion: 'record-save-cutover-fallback-outcome-v1',
    isolatedTestOnly: true,
    stage,
    recoveryState,
    transactionState,
    stateMatchesBase: options.stateMatchesBase === true,
    revisionMatchesBase: options.revisionMatchesBase === true,
    fingerprintMatchesBase: options.fingerprintMatchesBase === true,
    successReceiptExists: options.successReceiptExists === true,
    latestStateReread: options.latestStateReread === true,
    legacyPreflightRevalidated: options.legacyPreflightRevalidated === true,
    duplicateRiskAbsent: options.duplicateRiskAbsent === true,
    mainBundleMayHaveChanged: options.mainBundleMayHaveChanged === true,
    transactionStatusAmbiguous: options.transactionStatusAmbiguous === true,
    receiptStatusAmbiguous: options.receiptStatusAmbiguous === true,
    financialInvariantFailed: options.financialInvariantFailed === true
  });
  const outcome = Object.freeze({
    getIdentity() {
      return safeClone(facts);
    }
  });
  TRUSTED_CUTOVER_FALLBACK_OUTCOMES.set(outcome, Object.freeze({
    facts,
    writerCoordinator
  }));
  return outcome;
}

function getTrustedCutoverFallbackOutcome(outcome, writerCoordinator) {
  const registration = TRUSTED_CUTOVER_FALLBACK_OUTCOMES.get(outcome);
  if (!registration || registration.writerCoordinator !== writerCoordinator) return null;
  return safeClone(registration.facts);
}

function createIsolatedRecordSaveCutoverTarget(options = {}) {
  const targetKind = String(options.targetKind || STORAGE_TARGET_KINDS.MEMORY).trim().toUpperCase();
  if (![STORAGE_TARGET_KINDS.MEMORY, STORAGE_TARGET_KINDS.FAKE, STORAGE_TARGET_KINDS.WX_ISOLATED_TEST]
    .includes(targetKind)) {
    throw Object.assign(new Error('受控切换隔离目标无效。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.STORAGE_TARGET_UNTRUSTED
    });
  }
  const writerCoordinator = options.writerCoordinator;
  const coordinatorIdentity = writerCoordinator && typeof writerCoordinator.getIdentity === 'function'
    ? writerCoordinator.getIdentity()
    : null;
  if (!isTrustedRecordStorageCoordinator(writerCoordinator)
    || !coordinatorIdentity
    || coordinatorIdentity.mode !== RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW) {
    throw Object.assign(new Error('隔离存储目标必须绑定可信事务预演Coordinator。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.STORAGE_TARGET_COORDINATOR_MISMATCH
    });
  }
  if (String(coordinatorIdentity.gatewayKind || '').trim().toUpperCase() !== targetKind) {
    throw Object.assign(new Error('隔离存储目标类型与Coordinator实际Gateway不一致。'), {
      code: RECORD_SAVE_CUTOVER_ERROR_CODES.STORAGE_TARGET_COORDINATOR_MISMATCH
    });
  }
  const target = Object.freeze({
    getIdentity() {
      return {
        schemaVersion: 'record-save-cutover-target-v1',
        targetKind,
        isolatedTestOnly: true,
        canTouchRealBusinessStorage: false,
        coordinatorSchemaVersion: coordinatorIdentity.schemaVersion,
        coordinatorGatewayKind: coordinatorIdentity.gatewayKind,
        storageSchemaVersion: String(
          options.storageSchemaVersion || RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.storageSchema
        ),
        transactionProtocolVersion: String(
          options.transactionProtocolVersion
          || RECORD_SAVE_CUTOVER_VERSION_REQUIREMENTS.transactionProtocol
        )
      };
    }
  });
  TRUSTED_CUTOVER_TARGETS.set(target, Object.freeze({
    identity: deepFreeze(target.getIdentity()),
    writerCoordinator
  }));
  return target;
}

function getTrustedCutoverTargetIdentity(target) {
  const registration = TRUSTED_CUTOVER_TARGETS.get(target);
  return registration ? safeClone(registration.identity) : null;
}

function classifyRecordSaveShadowDifference(comparison = {}) {
  const differences = Array.isArray(comparison.fullDifferences) ? comparison.fullDifferences : [];
  if (comparison && comparison.equivalent === true && differences.length === 0) {
    return {
      classification: RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.NO_DIFFERENCE,
      blocksShared: false,
      reasons: []
    };
  }
  if (comparison && comparison.equivalent === true && differences.length > 0) {
    return {
      classification: RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.UNKNOWN,
      blocksShared: true,
      reasons: ['CONTRADICTORY_COMPARISON_RESULT']
    };
  }
  if (!differences.length) {
    return {
      classification: RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.UNKNOWN,
      blocksShared: true,
      reasons: ['MISSING_COMPARISON_DETAILS']
    };
  }
  const types = new Set();
  const collections = new Set();
  differences.forEach((entry) => {
    collections.add(String(entry.collection || ''));
    (Array.isArray(entry.types) ? entry.types : [])
      .map((type) => String(type || '').trim())
      .filter(Boolean)
      .forEach((type) => types.add(type));
  });
  let classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.UNKNOWN;
  if (types.size === 0) {
    classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.UNKNOWN;
  } else if (types.has('RELATION_DIFFERENCE')) {
    classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.RELATION_DIFFERENCE;
  } else if (Array.from(collections).some((collection) => FINANCIAL_COLLECTIONS.has(collection))) {
    classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.FINANCIAL_DIFFERENCE;
  } else if (types.has('SAVE_PLAN_MISSING_OPERATION') || types.has('STATE_PROJECTION_ERROR')) {
    classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.DATA_LOSS;
  } else if (types.has('BUSINESS_DATA_DIFFERENCE')
    || types.has('PRODUCT_CATALOG_DIFFERENCE')
    || types.has('LEGACY_HIDDEN_SIDE_EFFECT')) {
    classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.BUSINESS_STATE_DIFFERENCE;
  } else if (types.size === 1 && types.has('ORDERING_ONLY')) {
    classification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.ORDERING_ONLY;
  } else if (Array.from(types).every((type) => ['LOGGING_DIFFERENCE', 'TIME_DIFFERENCE', 'ID_DIFFERENCE']
    .includes(type))) {
    classification = types.has('LOGGING_DIFFERENCE')
      ? RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.LOGGING_ONLY
      : RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.NON_BUSINESS_METADATA_ONLY;
  }
  return {
    classification,
    blocksShared: !SAFE_SHADOW_LEVELS.has(classification),
    reasons: Array.from(types).sort()
  };
}

function evaluateRecordSaveRecoveryLock(input = {}) {
  const reasons = [];
  if (input.configRecoveryLock === true) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.CONFIG_RECOVERY_LOCK);
  }
  const recoveryState = String(input.recoveryState || '').trim().toUpperCase();
  const transactionState = String(input.transactionState || '').trim().toUpperCase();
  if ((recoveryState && !VALID_RECOVERY_STATES.has(recoveryState))
    || (transactionState && !VALID_TRANSACTION_STATES.has(transactionState))) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.TRANSACTION_METADATA_INVALID);
  }
  if (recoveryState === RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.RECOVERY_REQUIRED);
  }
  if (transactionState === RECORD_STORAGE_TRANSACTION_STATES.COMMIT_OUTCOME_UNKNOWN) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.COMMIT_OUTCOME_UNKNOWN);
  }
  if (transactionState === RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.COMMITTED_CLEANUP_PENDING);
  }
  if ([
    RECORD_STORAGE_TRANSACTION_STATES.PREPARED,
    RECORD_STORAGE_TRANSACTION_STATES.MAIN_WRITE_STARTED
  ].includes(transactionState)) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.JOURNAL_OR_BACKUP_UNRESOLVED);
  }
  if (transactionState === RECORD_STORAGE_TRANSACTION_STATES.RECOVERY_REQUIRED) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.RECOVERY_REQUIRED);
  }
  if (input.materialsContradictory === true) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.MATERIALS_CONTRADICTORY);
  }
  if (input.readbackVerified === false) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.READBACK_UNCERTAIN);
  }
  if (input.receiptConsistent === false) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.RECEIPT_CONFLICT);
  }
  if (input.transactionMetadataValid === false) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.TRANSACTION_METADATA_INVALID);
  }
  if (input.transactionMaterialCorrupt === true) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.TRANSACTION_MATERIAL_CORRUPT);
  }
  if (input.transactionMaterialsResolved === false) {
    reasons.push(RECORD_SAVE_RECOVERY_LOCK_REASONS.JOURNAL_OR_BACKUP_UNRESOLVED);
  }
  const uniqueReasons = uniqueStrings(reasons);
  return {
    active: uniqueReasons.length > 0,
    effectiveMode: uniqueReasons.length
      ? RECORD_SAVE_CUTOVER_MODES.RECOVERY_LOCKED
      : null,
    reasons: uniqueReasons,
    legacyWritesBlocked: uniqueReasons.length > 0,
    sharedWritesBlocked: uniqueReasons.length > 0,
    killSwitchCanBypass: false
  };
}

function evaluateLegacySaveEligibility(input = {}, recoveryLock = evaluateRecordSaveRecoveryLock(input)) {
  const blockingReasons = [];
  if (recoveryLock.active) blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.RECOVERY_LOCKED));
  if (input.legacyPreflightAllowed !== true || input.legacyConfirmationAllowed !== true) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.PREFLIGHT_NOT_ELIGIBLE));
  }
  const revision = Number(input.stateRevision || 0);
  const evidence = getTrustedCutoverEvidence(input.cutoverEvidence);
  const transactionalLegacyWriterReady = evidence
    && evidence.releaseA
    && evidence.releaseA.transactionalLegacyFallbackReady === true;
  if (revision > 0 && !transactionalLegacyWriterReady) {
    blockingReasons.push(issue(
      RECORD_SAVE_CUTOVER_ERROR_CODES.TRANSACTIONAL_LEGACY_FALLBACK_REQUIRED,
      { revision }
    ));
  }
  return {
    eligible: blockingReasons.length === 0,
    blockingReasons,
    pathKind: revision > 0 ? 'TRANSACTIONAL_LEGACY' : 'LEGACY_PASSTHROUGH'
  };
}

function validConfirmationAndPlan(input, blockingReasons) {
  const preflight = input.preflight || {};
  const confirmation = input.confirmation || {};
  const plan = input.savePlan || {};
  if (preflight.domainCanSaveFormal !== true || !preflight.preflightFingerprint) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.PREFLIGHT_NOT_ELIGIBLE));
  }
  if (!confirmation.confirmationId
    || !Number.isInteger(confirmation.revision)
    || confirmation.revision < 1
    || !confirmation.contentHash
    || (confirmation.domain || {}).domainCanSaveFormal !== true) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.CONFIRMATION_BINDING_INVALID));
  }
  if (plan.schemaVersion !== SAVE_PLAN_SCHEMA_VERSION
    || plan.blocked === true
    || !plan.planId
    || !plan.planHash
    || !Array.isArray(plan.operations)
    || plan.action !== 'SAVE_FORMAL') {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.SAVE_PLAN_INVALID));
    return;
  }
  try {
    validatePlanShape(plan);
  } catch (error) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.SAVE_PLAN_INVALID, {
      validationCode: String(error && error.code || 'SAVE_PLAN_INVALID')
    }));
    return;
  }
  if (plan.confirmationId !== confirmation.confirmationId
    || plan.confirmationRevision !== confirmation.revision
    || plan.confirmationContentHash !== confirmation.contentHash
    || plan.preflightFingerprint !== preflight.preflightFingerprint) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.CONFIRMATION_BINDING_INVALID));
  }
  if (Number(plan.sourceStateVersion) !== Number(input.stateRevision)
    || String(plan.sourceStateFingerprint || '') !== String(input.stateFingerprint || '')) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.STATE_BINDING_MISMATCH));
  }
}

function getAuthoritativeCutoverFacts(input = {}) {
  const evidence = getTrustedCutoverEvidence(input.cutoverEvidence);
  if (!evidence) return { evidence: null, transactionFacts: input };
  const transaction = evidence.transaction || {};
  const inputRecoveryState = String(input.recoveryState || '').trim().toUpperCase();
  const inputTransactionState = String(input.transactionState || '').trim().toUpperCase();
  const recoveryStateMismatch = Boolean(
    inputRecoveryState && inputRecoveryState !== transaction.recoveryState
  );
  const transactionStateMismatch = Boolean(
    inputTransactionState && inputTransactionState !== transaction.transactionState
  );
  return {
    evidence,
    transactionFacts: {
      recoveryState: transaction.recoveryState,
      transactionState: transaction.transactionState,
      readbackVerified: transaction.readbackVerified === true && input.readbackVerified !== false,
      receiptConsistent: transaction.receiptConsistent === true && input.receiptConsistent !== false,
      transactionMetadataValid: transaction.transactionMetadataValid === true
        && input.transactionMetadataValid !== false
        && !recoveryStateMismatch
        && !transactionStateMismatch,
      transactionMaterialsResolved: transaction.transactionMaterialsResolved === true
        && input.transactionMaterialsResolved !== false,
      materialsContradictory: transaction.materialsContradictory !== false
        || input.materialsContradictory === true,
      transactionMaterialCorrupt: transaction.transactionMaterialCorrupt !== false
        || input.transactionMaterialCorrupt === true,
      configRecoveryLock: input.configRecoveryLock === true
    }
  };
}

function evaluateSharedSaveEligibility(input = {}) {
  const config = input.trustedConfig || {};
  const mode = normalizeCutoverMode(config.effectiveMode, RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY);
  const previewOnly = mode === RECORD_SAVE_CUTOVER_MODES.SHADOW_PREVIEW;
  const blockingReasons = [];
  const warnings = [];
  if (!TRUSTED_RESOLVED_CONFIGS.has(config) || config.trusted !== true) {
    blockingReasons.push(issue(
      config.trustFailureReason || RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_CONFIG_UNTRUSTED
    ));
  }
  if (!previewOnly && !SHARED_MODES.has(mode)) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.SHARED_PRODUCTION_COMMIT_DISABLED));
  }

  const environment = normalizeCutoverEnvironment(input.environment);
  if (environment === RECORD_SAVE_CUTOVER_ENVIRONMENTS.PRODUCTION) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.PRODUCTION_SHARED_HARD_DISABLED));
  }
  const authoritative = getAuthoritativeCutoverFacts(Object.assign({}, input, {
    configRecoveryLock: config.effectiveMode === RECORD_SAVE_CUTOVER_MODES.RECOVERY_LOCKED
      || config.recoveryLock === true
  }));
  const evidence = authoritative.evidence;
  if (!evidence || evidence.isolatedTestOnly !== true) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.CUTOVER_EVIDENCE_UNTRUSTED));
  }
  const allowedBuildVersions = Array.isArray(config.allowedBuildVersions)
    ? config.allowedBuildVersions
    : [];
  const allowedBuildFlavors = Array.isArray(config.allowedBuildFlavors)
    ? config.allowedBuildFlavors
    : [];
  const allowedStorageSchemaVersions = Array.isArray(config.allowedStorageSchemaVersions)
    ? config.allowedStorageSchemaVersions
    : [];
  const allowedTransactionProtocolVersions = Array.isArray(config.allowedTransactionProtocolVersions)
    ? config.allowedTransactionProtocolVersions
    : [];
  const businessTypeAllowlist = Array.isArray(config.businessTypeAllowlist)
    ? config.businessTypeAllowlist
    : [];
  const operationAllowlist = Array.isArray(config.operationAllowlist)
    ? config.operationAllowlist
    : [];
  const appVersion = String(evidence && evidence.appVersion || '');
  const buildFlavor = String(evidence && evidence.buildFlavor || '');
  if (allowedBuildVersions.length
    && !allowedBuildVersions.includes(appVersion)) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.BUILD_VERSION_NOT_ALLOWED));
  } else if (!allowedBuildVersions.length && !previewOnly) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.BUILD_VERSION_NOT_ALLOWED));
  }
  if (!allowedBuildFlavors.length
    || !allowedBuildFlavors.includes(buildFlavor)) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.BUILD_FLAVOR_NOT_ALLOWED));
  }

  const targetRegistration = TRUSTED_CUTOVER_TARGETS.get(input.storageTarget);
  const targetIdentity = targetRegistration && safeClone(targetRegistration.identity);
  if (!targetIdentity) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.STORAGE_TARGET_UNTRUSTED));
  } else {
    if (targetIdentity.canTouchRealBusinessStorage !== false || targetIdentity.isolatedTestOnly !== true) {
      blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.REAL_STORAGE_TARGET_FORBIDDEN));
    }
    if (!allowedStorageSchemaVersions.includes(targetIdentity.storageSchemaVersion)
      || targetIdentity.storageSchemaVersion !== config.minimumStorageSchemaVersion) {
      blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.STORAGE_SCHEMA_NOT_ALLOWED));
    }
    if (!allowedTransactionProtocolVersions.includes(targetIdentity.transactionProtocolVersion)
      || targetIdentity.transactionProtocolVersion !== config.minimumTransactionVersion) {
      blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.TRANSACTION_PROTOCOL_NOT_ALLOWED));
    }
  }

  const coordinator = input.writerCoordinator;
  const coordinatorIdentity = coordinator && typeof coordinator.getIdentity === 'function'
    ? coordinator.getIdentity()
    : null;
  if (!isTrustedRecordStorageCoordinator(coordinator)
    || !coordinatorIdentity
    || coordinatorIdentity.mode !== RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.WRITER_COORDINATOR_NOT_READY));
  } else if (String(coordinatorIdentity.schemaVersion || '') !== config.minimumCoordinatorVersion
    || (targetIdentity
      && String(targetIdentity.coordinatorSchemaVersion || '') !== config.minimumCoordinatorVersion)) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.WRITER_COORDINATOR_NOT_READY));
  }
  if (targetRegistration && targetRegistration.writerCoordinator !== coordinator) {
    blockingReasons.push(issue(
      RECORD_SAVE_CUTOVER_ERROR_CODES.STORAGE_TARGET_COORDINATOR_MISMATCH
    ));
  }

  const transactionFacts = authoritative.transactionFacts || {};
  const recoveryEvidenceComplete = evidence
    && transactionFacts.recoveryState === RECORD_STORAGE_RECOVERY_STATES.CLEAN
    && transactionFacts.transactionState === RECORD_STORAGE_TRANSACTION_STATES.CLEAN
    && transactionFacts.readbackVerified === true
    && transactionFacts.receiptConsistent === true
    && transactionFacts.transactionMetadataValid === true
    && transactionFacts.transactionMaterialsResolved === true
    && transactionFacts.materialsContradictory === false
    && transactionFacts.transactionMaterialCorrupt === false;
  if (!recoveryEvidenceComplete) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.RECOVERY_EVIDENCE_INCOMPLETE));
  }
  const recoveryLock = evaluateRecordSaveRecoveryLock(transactionFacts);
  if (recoveryLock.active) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.RECOVERY_LOCKED, {
      reasons: recoveryLock.reasons
    }));
  }
  if (!businessTypeAllowlist.length
    || !businessTypeAllowlist.includes(String(input.businessType || ''))) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.BUSINESS_TYPE_NOT_ALLOWED));
  }
  if (!operationAllowlist.length
    || !operationAllowlist.includes(String(input.operation || ''))) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.OPERATION_NOT_ALLOWED));
  }

  validConfirmationAndPlan(input, blockingReasons);
  const providerKind = String(input.providerKind || '').trim().toUpperCase();
  const localProductionResult = providerKind === 'NONE'
    && String(input.productionRoute || '').trim().toUpperCase() === 'LOCAL'
    && input.aiRequiredByProductionRoute === false
    && String(input.aiOutcome || '').trim().toUpperCase() === 'NOT_REQUESTED';
  if (providerKind !== 'REAL' && !localProductionResult) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.PROVIDER_NOT_COMMITTABLE));
  }
  if (String(input.resultScope || '') !== 'PRODUCTION_RESULT') {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.RESULT_SCOPE_NOT_COMMITTABLE));
  }

  const shadow = classifyRecordSaveShadowDifference(input.shadowComparison || {});
  if (shadow.blocksShared) {
    blockingReasons.push(issue(
      input.shadowComparison
        ? RECORD_SAVE_CUTOVER_ERROR_CODES.SHADOW_DIFFERENCE_BLOCKING
        : RECORD_SAVE_CUTOVER_ERROR_CODES.SHADOW_BASELINE_REQUIRED,
      { classification: shadow.classification }
    ));
  }

  const releaseA = evidence && evidence.releaseA || {};
  const cohort = evidence && evidence.cohort || {};
  if (previewOnly
    && (cohort.shadowSampleAccepted !== true
      || Number(config.shadowSampleRate || 0) <= 0)) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.SHADOW_SAMPLE_NOT_SELECTED));
  }
  const configCohortPolicy = String(
    config.cohortPolicy && config.cohortPolicy.kind || 'NONE'
  ).trim().toUpperCase();
  const evidenceCohortPolicy = String(cohort.policyKind || 'NONE').trim().toUpperCase();
  if (mode === RECORD_SAVE_CUTOVER_MODES.SHARED_CANARY
    && (cohort.eligible !== true
      || cohort.sampleAccepted !== true
      || evidenceCohortPolicy === 'NONE'
      || configCohortPolicy === 'NONE'
      || evidenceCohortPolicy !== configCohortPolicy
      || Number(config.canarySampleRate || 0) <= 0)) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.CANARY_COHORT_NOT_ELIGIBLE));
  }
  if (!previewOnly && releaseA.verified !== true) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.RELEASE_A_COVERAGE_UNVERIFIED));
  }
  if (!previewOnly && releaseA.oldWritersRetired !== true) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.OLD_WRITER_EXIT_UNVERIFIED));
  }
  if (!previewOnly && releaseA.transactionalLegacyFallbackReady !== true) {
    blockingReasons.push(issue(
      RECORD_SAVE_CUTOVER_ERROR_CODES.TRANSACTIONAL_LEGACY_FALLBACK_REQUIRED
    ));
  }
  if (releaseA.minimumCoordinatorVersion
    && releaseA.minimumCoordinatorVersion !== config.minimumCoordinatorVersion) {
    blockingReasons.push(issue(RECORD_SAVE_CUTOVER_ERROR_CODES.WRITER_COORDINATOR_NOT_READY));
  }

  if (previewOnly) warnings.push(issue('SHADOW_PREVIEW_NEVER_COMMITS_REAL_STORAGE'));
  return {
    eligible: blockingReasons.length === 0,
    requestedMode: config.requestedMode || RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY,
    effectiveMode: mode,
    previewOnly,
    blockingReasons,
    warnings,
    shadowClassification: shadow.classification,
    targetKind: targetIdentity && targetIdentity.targetKind || 'NONE',
    monitoringTags: sanitizeRecordSaveCutoverPayload({
      configVersion: String(config.configVersion || ''),
      appVersion,
      businessType: String(input.businessType || ''),
      operation: String(input.operation || '')
    })
  };
}

function resolveRecordSaveFallbackPolicy(input = {}) {
  const stage = normalizeFallbackStage(input.stage, null);
  const legacyEligible = input.legacyEligible === true;
  const noFallbackStages = new Set([
    RECORD_SAVE_FALLBACK_STAGES.BACKUP_WRITTEN,
    RECORD_SAVE_FALLBACK_STAGES.BEFORE_JOURNAL,
    RECORD_SAVE_FALLBACK_STAGES.MAIN_BUNDLE_MAY_HAVE_CHANGED,
    RECORD_SAVE_FALLBACK_STAGES.READBACK_UNCERTAIN,
    RECORD_SAVE_FALLBACK_STAGES.RECEIPT_UNCERTAIN,
    RECORD_SAVE_FALLBACK_STAGES.RECOVERY_REQUIRED,
    RECORD_SAVE_FALLBACK_STAGES.SHARED_COMMITTED,
    RECORD_SAVE_FALLBACK_STAGES.STALE_SNAPSHOT,
    RECORD_SAVE_FALLBACK_STAGES.PLAN_COLLISION,
    RECORD_SAVE_FALLBACK_STAGES.FINANCIAL_INVARIANT_FAILED
  ]);
  if (!stage
    || noFallbackStages.has(stage)
    || input.mainBundleMayHaveChanged === true
    || input.transactionStatusAmbiguous === true
    || input.receiptStatusAmbiguous === true
    || input.financialInvariantFailed === true) {
    return {
      policy: RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
      allowedNow: false,
      stage,
      requiresLatestStateRead: true,
      requiresRebuild: true,
      reason: stage ? 'PERSISTENCE_OR_BUSINESS_OUTCOME_NOT_PROVEN_SAFE' : 'FALLBACK_STAGE_UNKNOWN'
    };
  }
  if (stage === RECORD_SAVE_FALLBACK_STAGES.JOURNAL_PREPARED) {
    const verifiedRollback = input.recoveryState === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK
      && input.stateMatchesBase === true
      && input.revisionMatchesBase === true
      && input.fingerprintMatchesBase === true
      && input.successReceiptExists !== true
      && input.legacyPreflightRevalidated === true
      && input.duplicateRiskAbsent === true;
    return {
      policy: verifiedRollback
        ? RECORD_SAVE_FALLBACK_POLICIES.VERIFIED_ROLLBACK_FALLBACK
        : RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
      allowedNow: verifiedRollback && legacyEligible && input.latestStateReread === true,
      stage,
      requiresLatestStateRead: true,
      requiresRebuild: true,
      reason: verifiedRollback ? 'VERIFIED_BASE_ROLLBACK' : 'ROLLBACK_NOT_VERIFIED'
    };
  }
  const preWriteSafe = [
    RECORD_SAVE_FALLBACK_STAGES.BEFORE_CONFIRMATION,
    RECORD_SAVE_FALLBACK_STAGES.SHARED_ELIGIBILITY,
    RECORD_SAVE_FALLBACK_STAGES.BEFORE_SAVE_PLAN,
    RECORD_SAVE_FALLBACK_STAGES.BEFORE_TRANSACTION_MATERIALS
  ].includes(stage);
  return {
    policy: preWriteSafe
      ? RECORD_SAVE_FALLBACK_POLICIES.PRE_WRITE_FALLBACK
      : RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
    allowedNow: preWriteSafe
      && legacyEligible
      && input.latestStateReread === true
      && input.legacyPreflightRevalidated === true
      && input.duplicateRiskAbsent === true,
    stage,
    requiresLatestStateRead: true,
    requiresRebuild: true,
    reason: preWriteSafe ? 'NO_PERSISTENCE_TOUCHED' : 'FALLBACK_STAGE_UNKNOWN'
  };
}

function resolveNoFallbackBarrier(input = {}) {
  const trustedFallbackFacts = input.trustedFallbackFacts;
  let fallback = trustedFallbackFacts
    ? resolveRecordSaveFallbackPolicy(Object.assign({}, trustedFallbackFacts, {
      legacyEligible: input.legacyEligible
    }))
    : null;
  if (fallback && fallback.allowedNow === true) {
    const configuredPolicy = normalizedFallbackPolicy(input.configuredFallbackPolicy);
    const factsMatch = String(trustedFallbackFacts.transactionState || '')
      === String(input.transactionState || '')
      && String(trustedFallbackFacts.recoveryState || '')
        === String(input.recoveryState || '');
    if (configuredPolicy !== fallback.policy || !factsMatch) {
      fallback = Object.assign({}, fallback, {
        allowedNow: false,
        reason: configuredPolicy !== fallback.policy
          ? 'FALLBACK_POLICY_NOT_ALLOWED_BY_CONFIG'
          : 'FALLBACK_OUTCOME_STATE_MISMATCH'
      });
    }
  }
  const transactionState = String(input.transactionState || '').trim().toUpperCase();
  const recoveryState = String(input.recoveryState || '').trim().toUpperCase();
  const terminalTransaction = [
    RECORD_STORAGE_TRANSACTION_STATES.COMMITTED,
    RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED,
    RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING,
    RECORD_STORAGE_TRANSACTION_STATES.COMMIT_OUTCOME_UNKNOWN,
    RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT,
    RECORD_STORAGE_TRANSACTION_STATES.RECOVERY_REQUIRED
  ].includes(transactionState);
  const terminalRecovery = recoveryState === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_COMMITTED
    || recoveryState === RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED;
  const verifiedRollback = Boolean(
    fallback
    && fallback.allowedNow === true
    && fallback.policy === RECORD_SAVE_FALLBACK_POLICIES.VERIFIED_ROLLBACK_FALLBACK
    && recoveryState === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK
    && [
      RECORD_STORAGE_TRANSACTION_STATES.CLEAN,
      RECORD_STORAGE_TRANSACTION_STATES.ROLLED_BACK
    ].includes(transactionState)
  );
  const nonCleanTransaction = Boolean(
    transactionState && transactionState !== RECORD_STORAGE_TRANSACTION_STATES.CLEAN
  );
  const nonCleanRecovery = Boolean(
    recoveryState && recoveryState !== RECORD_STORAGE_RECOVERY_STATES.CLEAN
  );
  const unsafeNonCleanState = (nonCleanTransaction || nonCleanRecovery) && !verifiedRollback;
  const ambiguous = input.mainBundleMayHaveChanged === true
    || input.transactionStatusAmbiguous === true
    || input.receiptStatusAmbiguous === true
    || input.financialInvariantFailed === true;
  return {
    active: terminalTransaction
      || terminalRecovery
      || unsafeNonCleanState
      || ambiguous
      || input.untrustedFallbackAttempt === true
      || Boolean(fallback && fallback.allowedNow !== true),
    fallback,
    terminalTransaction,
    terminalRecovery,
    unsafeNonCleanState,
    ambiguous
  };
}

function resolveRecordSaveExecutionDecision(input = {}) {
  const environment = normalizeCutoverEnvironment(input.environment);
  const evidence = getTrustedCutoverEvidence(input.cutoverEvidence);
  const config = resolveTrustedRecordSaveCutoverConfig({
    environment,
    provider: input.configProvider,
    nowInstant: input.nowInstant,
    appVersion: evidence && evidence.appVersion || '',
    buildFlavor: evidence && evidence.buildFlavor || ''
  });
  const monitoringEnabled = Boolean(
    config.monitoringPolicy && config.monitoringPolicy.enabled === true
  );
  const authoritative = getAuthoritativeCutoverFacts(Object.assign({}, input, {
    configRecoveryLock: config.effectiveMode === RECORD_SAVE_CUTOVER_MODES.RECOVERY_LOCKED
      || config.recoveryLock === true
  }));
  const factInput = Object.assign({}, input, authoritative.transactionFacts);
  const trustedFallbackFacts = getTrustedCutoverFallbackOutcome(
    input.fallbackOutcome,
    input.writerCoordinator
  );
  const untrustedFallbackAttempt = Boolean(
    (input.fallbackOutcome && !trustedFallbackFacts)
    || (!trustedFallbackFacts
      && Object.prototype.hasOwnProperty.call(input, 'fallbackStage')
      && input.fallbackStage !== undefined
      && input.fallbackStage !== null
      && input.fallbackStage !== '')
  );
  const recoveryLock = evaluateRecordSaveRecoveryLock(factInput);
  const legacyEligibility = evaluateLegacySaveEligibility(factInput, recoveryLock);
  if (recoveryLock.active) {
    return {
      schemaVersion: RECORD_SAVE_CUTOVER_DECISION_SCHEMA_VERSION,
      decisionId: stableHash({
        mode: RECORD_SAVE_CUTOVER_MODES.RECOVERY_LOCKED,
        reasons: recoveryLock.reasons,
        configVersion: config.configVersion
      }, 'cutover-decision-v1'),
      requestedMode: config.requestedMode,
      effectiveMode: RECORD_SAVE_CUTOVER_MODES.RECOVERY_LOCKED,
      primaryPath: RECORD_SAVE_PRIMARY_PATHS.BLOCKED,
      shadowPath: RECORD_SAVE_SHADOW_PATHS.NONE,
      sharedEligibility: { eligible: false, blockingReasons: [issue('RECOVERY_LOCKED')] },
      legacyEligibility,
      fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
      fallbackAllowedNow: false,
      storageTarget: 'NONE',
      requiresRecovery: true,
      monitoringEnabled,
      monitoringEvents: [monitoringEvent(
        RECORD_SAVE_CUTOVER_MONITOR_EVENTS.RECOVERY_LOCKED,
        { errorCode: recoveryLock.reasons[0] || 'RECOVERY_LOCKED' }
      )],
      decisionReason: 'RECOVERY_LOCKED'
    };
  }
  const noFallbackBarrier = resolveNoFallbackBarrier(Object.assign({}, factInput, {
    legacyEligible: legacyEligibility.eligible,
    trustedFallbackFacts,
    configuredFallbackPolicy: config.fallbackPolicy,
    untrustedFallbackAttempt
  }));
  if (noFallbackBarrier.active) {
    return {
      schemaVersion: RECORD_SAVE_CUTOVER_DECISION_SCHEMA_VERSION,
      decisionId: stableHash({
        mode: config.effectiveMode,
        stage: trustedFallbackFacts && trustedFallbackFacts.stage || '',
        transactionState: factInput.transactionState || '',
        recoveryState: factInput.recoveryState || '',
        configVersion: config.configVersion
      }, 'cutover-decision-v1'),
      requestedMode: config.requestedMode,
      effectiveMode: config.effectiveMode,
      primaryPath: RECORD_SAVE_PRIMARY_PATHS.BLOCKED,
      shadowPath: RECORD_SAVE_SHADOW_PATHS.NONE,
      sharedEligibility: {
        eligible: false,
        blockingReasons: [issue(RECORD_SAVE_CUTOVER_ERROR_CODES.LEGACY_FALLBACK_UNSAFE)]
      },
      legacyEligibility: Object.assign({}, legacyEligibility, { eligible: false }),
      fallbackPolicy: RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK,
      fallbackAllowedNow: false,
      storageTarget: 'NONE',
      requiresRecovery: noFallbackBarrier.ambiguous || noFallbackBarrier.terminalRecovery,
      monitoringEnabled,
      monitoringEvents: [monitoringEvent(
        factInput.transactionState === RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT
          ? RECORD_SAVE_CUTOVER_MONITOR_EVENTS.STALE_SNAPSHOT
          : RECORD_SAVE_CUTOVER_MONITOR_EVENTS.CUTOVER_DECISION,
        { errorCode: 'LEGACY_FALLBACK_UNSAFE' }
      )],
      decisionReason: 'NO_FALLBACK_BARRIER'
    };
  }

  const sharedEligibility = evaluateSharedSaveEligibility(Object.assign({}, input, {
    environment,
    trustedConfig: config
  }));
  const mode = config.effectiveMode;
  let primaryPath = RECORD_SAVE_PRIMARY_PATHS.BLOCKED;
  let shadowPath = RECORD_SAVE_SHADOW_PATHS.NONE;
  let fallbackPolicy = RECORD_SAVE_FALLBACK_POLICIES.NO_FALLBACK;
  let fallbackAllowedNow = false;
  let decisionReason = 'NO_SAFE_PATH';
  if (noFallbackBarrier.fallback && noFallbackBarrier.fallback.allowedNow === true) {
    primaryPath = RECORD_SAVE_PRIMARY_PATHS.LEGACY;
    fallbackPolicy = noFallbackBarrier.fallback.policy;
    fallbackAllowedNow = true;
    decisionReason = fallbackPolicy === RECORD_SAVE_FALLBACK_POLICIES.VERIFIED_ROLLBACK_FALLBACK
      ? 'VERIFIED_ROLLBACK_FALLBACK'
      : 'SAFE_PRE_WRITE_FALLBACK';
  } else if (mode === RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY) {
    primaryPath = legacyEligibility.eligible
      ? RECORD_SAVE_PRIMARY_PATHS.LEGACY
      : RECORD_SAVE_PRIMARY_PATHS.BLOCKED;
    decisionReason = legacyEligibility.eligible ? 'LEGACY_ONLY_CONFIG' : 'LEGACY_NOT_ELIGIBLE';
  } else if (mode === RECORD_SAVE_CUTOVER_MODES.SHADOW_PREVIEW) {
    primaryPath = legacyEligibility.eligible
      ? RECORD_SAVE_PRIMARY_PATHS.LEGACY
      : RECORD_SAVE_PRIMARY_PATHS.BLOCKED;
    shadowPath = sharedEligibility.eligible
      ? RECORD_SAVE_SHADOW_PATHS.SHARED_PREVIEW
      : RECORD_SAVE_SHADOW_PATHS.NONE;
    decisionReason = sharedEligibility.eligible
      ? 'LEGACY_PRIMARY_SHARED_PREVIEW'
      : 'SHADOW_PREVIEW_INELIGIBLE';
  } else if (SHARED_MODES.has(mode) && sharedEligibility.eligible) {
    primaryPath = RECORD_SAVE_PRIMARY_PATHS.SHARED;
    shadowPath = RECORD_SAVE_SHADOW_PATHS.LEGACY_SIMULATION;
    decisionReason = 'ISOLATED_SHARED_ELIGIBLE';
  } else if (SHARED_MODES.has(mode)) {
    primaryPath = RECORD_SAVE_PRIMARY_PATHS.BLOCKED;
    decisionReason = 'SHARED_INELIGIBLE_BLOCKED';
  }

  const monitorType = primaryPath === RECORD_SAVE_PRIMARY_PATHS.SHARED
    ? RECORD_SAVE_CUTOVER_MONITOR_EVENTS.SHARED_ELIGIBLE
    : (sharedEligibility.eligible
      ? RECORD_SAVE_CUTOVER_MONITOR_EVENTS.CUTOVER_DECISION
      : RECORD_SAVE_CUTOVER_MONITOR_EVENTS.SHARED_INELIGIBLE);
  return {
    schemaVersion: RECORD_SAVE_CUTOVER_DECISION_SCHEMA_VERSION,
    decisionId: stableHash({
      configVersion: config.configVersion,
      requestedMode: config.requestedMode,
      effectiveMode: mode,
      primaryPath,
      shadowPath,
      planHash: input.savePlan && input.savePlan.planHash || '',
      revision: Number(input.stateRevision || 0)
    }, 'cutover-decision-v1'),
    requestedMode: config.requestedMode,
    effectiveMode: mode,
    primaryPath,
    shadowPath,
    sharedEligibility,
    legacyEligibility,
    fallbackPolicy,
    fallbackAllowedNow,
    storageTarget: sharedEligibility.targetKind,
    requiresRecovery: false,
    monitoringEnabled,
    monitoringEvents: [monitoringEvent(
      config.killSwitch
        ? RECORD_SAVE_CUTOVER_MONITOR_EVENTS.KILL_SWITCH_APPLIED
        : monitorType,
      {
        appVersion: String(evidence && evidence.appVersion || ''),
        configVersion: config.configVersion,
        executionMode: mode,
        businessType: String(input.businessType || ''),
        operation: String(input.operation || ''),
        errorCode: sharedEligibility.blockingReasons[0]
          ? sharedEligibility.blockingReasons[0].code
          : '',
        revision: Number(input.stateRevision || 0),
        planHash: input.savePlan && input.savePlan.planHash || ''
      }
    )],
    decisionReason
  };
}

function createRecordSaveCutoverController(options = {}) {
  const environment = normalizeCutoverEnvironment(options.environment);
  const configProvider = options.configProvider || DEFAULT_BUILD_STATIC_PROVIDER;
  const monitor = options.monitor || null;
  return Object.freeze({
    decide(input = {}) {
      const decision = resolveRecordSaveExecutionDecision(Object.assign({}, input, {
        environment,
        configProvider
      }));
      if (decision.monitoringEnabled === true
        && monitor
        && typeof monitor.record === 'function') {
        decision.monitoringEvents.forEach((event) => monitor.record(event.type, event.payload));
      }
      return safeClone(decision);
    },
    getControlIdentity() {
      return {
        schemaVersion: 'record-save-cutover-controller-v1',
        environment,
        productionSharedCommitEnabled: false,
        realUserCanaryEnabled: false,
        remoteKillSwitchAvailable: false
      };
    }
  });
}

module.exports = {
  classifyRecordSaveShadowDifference,
  createBuildStaticRecordSaveCutoverConfigProvider,
  createIsolatedRecordSaveCutoverEvidence,
  createIsolatedRecordSaveFallbackOutcome,
  createIsolatedRecordSaveCutoverTarget,
  createRecordSaveCutoverController,
  createTestRecordSaveCutoverConfigProvider,
  evaluateLegacySaveEligibility,
  evaluateRecordSaveRecoveryLock,
  evaluateSharedSaveEligibility,
  getTrustedCutoverEvidence,
  getTrustedCutoverFallbackOutcome,
  getTrustedCutoverTargetIdentity,
  resolveRecordSaveExecutionDecision,
  resolveRecordSaveFallbackPolicy,
  resolveTrustedRecordSaveCutoverConfig
};
