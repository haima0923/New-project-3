const {
  LEGACY_BUSINESS_STORAGE_KEY,
  STORAGE_TARGET_KINDS
} = require('./record-storage-adapter-contract');
const { getTrustedGatewayIdentity } = require('./record-storage-gateway-registry');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_BACKUP_SCHEMA_VERSION,
  RECORD_STORAGE_CONTROL_KEY,
  RECORD_STORAGE_CONTROL_SCHEMA_VERSION,
  RECORD_STORAGE_COORDINATOR_MODES,
  RECORD_STORAGE_JOURNAL_KEY,
  RECORD_STORAGE_JOURNAL_SCHEMA_VERSION,
  RECORD_STORAGE_RECEIPT_POLICY,
  RECORD_STORAGE_RECEIPT_SCHEMA_VERSION,
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_ERRORS,
  RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('./record-storage-transaction-contract');
const {
  composeRecordStorageBundle,
  getRecordStorageBusinessFingerprint,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('./record-storage-state-projector');
const { safeClone, stableHash, stableSerialize } = require('./record-state-diff');

const HIGH_RISK_LEVELS = new Set(['DANGEROUS', 'ZERO_TOLERANCE', 'FINANCIAL']);
const LEGACY_RELEASE_A_TRANSACTION_AUTHORITY = Object.freeze({});
const TRUSTED_TRANSACTION_MANAGERS = new WeakMap();

function utf8ByteLength(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') return 0;
  let bytes = 0;
  for (const symbol of text) {
    const code = symbol.codePointAt(0);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function makeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = safeClone(details);
  return error;
}

function makeIssue(error) {
  return {
    code: error && error.code || RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
    message: error && error.message || '持久化事务失败。',
    details: safeClone(error && error.details || {})
  };
}

function assertPlainSerializable(value, path = '$', seen = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
      `事务值不可序列化：${path}`
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
      `事务值包含非有限数值：${path}`
    );
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
      `事务值包含循环引用：${path}`
    );
  }
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
      `事务值包含Symbol键：${path}`
    );
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
          `事务值包含稀疏数组：${path}[${index}]`
        );
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw makeError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
        `事务值必须为纯对象：${path}`
      );
    }
  }
  const enumerableKeys = Object.keys(value);
  const ownNames = Object.getOwnPropertyNames(value);
  if (ownNames.some((key) => key !== 'length' && !enumerableKeys.includes(key))) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
      `事务值包含不可枚举字段：${path}`
    );
  }
  enumerableKeys.forEach((key) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw makeError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
        `事务值包含危险键：${path}.${key}`
      );
    }
    assertPlainSerializable(value[key], `${path}.${key}`, seen);
  });
  seen.delete(value);
}

function strictClone(value) {
  assertPlainSerializable(value);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID,
      '事务值无法完整序列化。'
    );
  }
  return JSON.parse(serialized);
}

function bundleFingerprint(bundle) {
  return stableHash(strictClone(bundle), 'bundle1');
}

function defaultControl() {
  return {
    schemaVersion: RECORD_STORAGE_CONTROL_SCHEMA_VERSION,
    storageSchemaVersion: 1,
    storageRevision: 0,
    lastCommittedTransactionId: '',
    lastCommittedPlanId: '',
    lastCommittedPlanHash: '',
    lastCommittedStateFingerprint: '',
    lastCommittedAt: '',
    recentReceipts: [],
    receiptTombstones: [],
    controlFingerprint: ''
  };
}

function normalizeControl(bundle) {
  const control = readRecordStorageControl(bundle);
  return control || defaultControl();
}

function receiptMatch(control, query) {
  const normalized = typeof query === 'object' && query
    ? query
    : { planId: String(query || '') };
  const matches = (entry) => entry && (
    (normalized.planId && entry.planId === normalized.planId)
    || (normalized.planHash && entry.planHash === normalized.planHash)
    || (normalized.idempotencyKey && entry.idempotencyKey === normalized.idempotencyKey)
  );
  const recent = (control.recentReceipts || []).find(matches);
  if (recent) return safeClone(recent);
  const tombstone = (control.receiptTombstones || []).find(matches);
  return tombstone ? safeClone(tombstone) : null;
}

function boundedReceiptLists(control, receipt) {
  const currentRecent = (Array.isArray(control.recentReceipts) ? control.recentReceipts : [])
    .filter((entry) => entry
      && entry.planId !== receipt.planId
      && entry.planHash !== receipt.planHash
      && entry.idempotencyKey !== receipt.idempotencyKey);
  const recentCandidate = currentRecent.concat([receipt]);
  const highRisk = recentCandidate.filter((entry) => HIGH_RISK_LEVELS.has(entry.riskLevel)).slice(-RECORD_STORAGE_RECEIPT_POLICY.minHighRiskReceipts);
  const highIds = new Set(highRisk.map((entry) => entry.planId));
  const ordinarySlots = Math.max(0, RECORD_STORAGE_RECEIPT_POLICY.maxRecentReceipts - highRisk.length);
  const ordinary = recentCandidate.filter((entry) => !highIds.has(entry.planId)).slice(-ordinarySlots);
  const recentReceipts = ordinary.concat(highRisk)
    .sort((left, right) => Number(left.committedRevision || 0) - Number(right.committedRevision || 0))
    .slice(-RECORD_STORAGE_RECEIPT_POLICY.maxRecentReceipts);

  const tombstone = {
    schemaVersion: RECORD_STORAGE_RECEIPT_SCHEMA_VERSION,
    planId: receipt.planId,
    planHash: receipt.planHash,
    idempotencyKey: receipt.idempotencyKey,
    transactionId: receipt.transactionId,
    committedRevision: receipt.committedRevision,
    committedFingerprint: receipt.committedFingerprint,
    riskLevel: receipt.riskLevel
  };
  const candidateTombstones = (Array.isArray(control.receiptTombstones) ? control.receiptTombstones : [])
    .filter((entry) => entry
      && entry.planId !== receipt.planId
      && entry.planHash !== receipt.planHash
      && entry.idempotencyKey !== receipt.idempotencyKey)
    .concat([tombstone]);
  const highTombstones = candidateTombstones.filter((entry) => HIGH_RISK_LEVELS.has(entry.riskLevel))
    .slice(-RECORD_STORAGE_RECEIPT_POLICY.minHighRiskReceipts);
  const highTombstoneIds = new Set(highTombstones.map((entry) => entry.planId));
  const normalTombstones = candidateTombstones.filter((entry) => !highTombstoneIds.has(entry.planId))
    .slice(-(RECORD_STORAGE_RECEIPT_POLICY.maxTombstones - highTombstones.length));
  const receiptTombstones = normalTombstones.concat(highTombstones)
    .sort((left, right) => Number(left.committedRevision || 0) - Number(right.committedRevision || 0))
    .slice(-RECORD_STORAGE_RECEIPT_POLICY.maxTombstones);
  return { recentReceipts, receiptTombstones };
}

function hasCommittedControlIntegrity(bundle) {
  try {
    const persisted = readRecordStorageControl(bundle);
    if (!persisted) return true;
    if (persisted.storageRevision === 0) {
      return !persisted.lastCommittedTransactionId
        && !persisted.lastCommittedPlanId
        && !persisted.lastCommittedPlanHash
        && !persisted.lastCommittedStateFingerprint;
    }
    const businessFingerprint = getRecordStorageBusinessFingerprint(bundle);
    const receipt = receiptMatch(persisted, {
      planId: persisted.lastCommittedPlanId,
      planHash: persisted.lastCommittedPlanHash
    });
    return Boolean(
      persisted.lastCommittedTransactionId
      && persisted.lastCommittedPlanId
      && persisted.lastCommittedPlanHash
      && persisted.lastCommittedStateFingerprint === businessFingerprint
      && receipt
      && receipt.planId === persisted.lastCommittedPlanId
      && receipt.planHash === persisted.lastCommittedPlanHash
      && receipt.transactionId === persisted.lastCommittedTransactionId
      && receipt.committedRevision === persisted.storageRevision
      && receipt.committedFingerprint === businessFingerprint
    );
  } catch (error) {
    return false;
  }
}

function verifyBundle(bundle, expected = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return false;
  try {
    if (!hasCommittedControlIntegrity(bundle)) return false;
    const control = normalizeControl(bundle);
    if (expected.revision !== undefined && control.storageRevision !== expected.revision) return false;
    if (expected.transactionId && control.lastCommittedTransactionId !== expected.transactionId) return false;
    if (expected.planId && control.lastCommittedPlanId !== expected.planId) return false;
    if (expected.planHash && control.lastCommittedPlanHash !== expected.planHash) return false;
    if (expected.businessFingerprint && getRecordStorageBusinessFingerprint(bundle) !== expected.businessFingerprint) return false;
    if (expected.controlStateFingerprint
      && control.lastCommittedStateFingerprint !== expected.controlStateFingerprint) return false;
    if (expected.bundleFingerprint && bundleFingerprint(bundle) !== expected.bundleFingerprint) return false;
    if (expected.receiptHash) {
      const receipt = receiptMatch(control, {
        planId: expected.planId,
        planHash: expected.planHash,
        idempotencyKey: expected.idempotencyKey
      });
      if (!receipt || stableHash(receipt, 'receipt1') !== expected.receiptHash) return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function readMaybe(gateway, key) {
  const value = gateway.getStorageSync(key);
  if (value === '' && typeof gateway.hasStorageKeySync === 'function'
    && gateway.hasStorageKeySync(key) === false) {
    return null;
  }
  return value === null || value === undefined ? null : value;
}

function verifyStoredValue(gateway, key, expected) {
  const actual = readMaybe(gateway, key);
  return actual !== null && stableSerialize(actual) === stableSerialize(expected);
}

function removeAndVerify(gateway, key) {
  gateway.removeStorageSync(key);
  if (readMaybe(gateway, key) !== null) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CLEANUP_PENDING,
      `事务临时key清理后仍然存在：${key}`
    );
  }
}

function cleanup(gateway, storageKeys) {
  const errors = [];
  try { removeAndVerify(gateway, storageKeys.journal); } catch (error) {
    errors.push(makeIssue(error));
    return errors;
  }
  try { removeAndVerify(gateway, storageKeys.backup); } catch (error) { errors.push(makeIssue(error)); }
  return errors;
}

function validateIdentifier(value, field) {
  const normalized = String(value || '');
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(normalized)) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_ID_INVALID,
      `${field}格式或长度无效。`
    );
  }
  return normalized;
}

function resolveIdempotencyKey(input) {
  return validateIdentifier(input.idempotencyKey || input.planHash, 'idempotencyKey');
}

function validateTransactionInput(input) {
  const required = [
    'transactionId',
    'planId',
    'planHash',
    'baseRevision',
    'baseFingerprint',
    'targetBundle',
    'committedAt'
  ];
  required.forEach((key) => {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      throw makeError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
        `事务输入缺少${key}。`
      );
    }
  });
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
    throw makeError(RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_REVISION_INVALID, 'baseRevision必须是非负整数。');
  }
  validateIdentifier(input.transactionId, 'transactionId');
  validateIdentifier(input.planId, 'planId');
  validateIdentifier(input.planHash, 'planHash');
  validateIdentifier(input.baseFingerprint, 'baseFingerprint');
  if (input.idempotencyKey !== undefined) validateIdentifier(input.idempotencyKey, 'idempotencyKey');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(input.committedAt))
    || !Number.isFinite(Date.parse(String(input.committedAt)))
    || String(input.committedAt).length > 40) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
      'committedAt必须是有效ISO时刻。'
    );
  }
  const riskLevel = String(input.riskLevel || 'NORMAL');
  if (!['NORMAL', 'IMPORTANT', 'DANGEROUS', 'ZERO_TOLERANCE', 'FINANCIAL'].includes(riskLevel)) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
      'riskLevel不受支持。'
    );
  }
  if (input.writerSource !== undefined) validateIdentifier(input.writerSource, 'writerSource');
  if (Object.prototype.hasOwnProperty.call(input.targetBundle, RECORD_STORAGE_CONTROL_KEY)) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CONTROL_NAMESPACE_COLLISION,
      '调用方不得直接提供持久化控制命名空间。'
    );
  }
  strictClone(input.targetBundle);
}

function checkCapacity(gateway, payloads) {
  if (typeof gateway.getCapacityInfo !== 'function') {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_NOT_CONFIRMED,
      'Storage gateway无法确认容量。'
    );
  }
  const info = gateway.getCapacityInfo();
  if (!info || info.capacityConfirmed !== true || !Number.isFinite(Number(info.limitSizeBytes))) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_NOT_CONFIRMED,
      'Storage容量未确认。'
    );
  }
  const beforeMainBytes = Number(info.currentSizeBytes || 0)
    + Number(payloads.backupBytes || 0)
    + Number(payloads.journalBytes || 0);
  const afterMainBytes = beforeMainBytes
    - Number(payloads.oldPrimaryBytes || 0)
    + Number(payloads.newPrimaryBytes || 0);
  const peakBytes = Math.max(beforeMainBytes, afterMainBytes);
  if (peakBytes > Number(info.limitSizeBytes)) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_INSUFFICIENT,
      'Storage容量不足，事务在覆盖主Bundle前被阻断。',
      { peakBytes, limitSizeBytes: Number(info.limitSizeBytes) }
    );
  }
  return { peakBytes, limitSizeBytes: Number(info.limitSizeBytes) };
}

function resolveTransactionStorageKeys(gatewayIdentity) {
  const candidate = gatewayIdentity && gatewayIdentity.transactionStorageKeys || {
    primary: LEGACY_BUSINESS_STORAGE_KEY,
    journal: RECORD_STORAGE_JOURNAL_KEY,
    backup: RECORD_STORAGE_BACKUP_KEY
  };
  const output = {
    primary: String(candidate.primary || ''),
    journal: String(candidate.journal || ''),
    backup: String(candidate.backup || '')
  };
  const values = Object.values(output);
  if (values.some((value) => !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) || new Set(values).size !== 3) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      '可信Gateway的事务Storage key无效。'
    );
  }
  return Object.freeze(output);
}

function estimateEntryBytes(gateway, key, value) {
  if (gateway && typeof gateway.estimateEntryBytes === 'function') {
    const estimated = Number(gateway.estimateEntryBytes(key, value));
    if (Number.isFinite(estimated) && estimated >= 0) return estimated;
  }
  return utf8ByteLength(key) + utf8ByteLength(value);
}

function checkpoint(options, name, context) {
  if (typeof options.onCheckpoint === 'function') options.onCheckpoint(name, safeClone(context));
  if (options.crashAt === name) {
    const error = makeError('SIMULATED_PROCESS_CRASH', `模拟进程在${name}崩溃。`, { checkpoint: name });
    error.simulatedCrash = true;
    throw error;
  }
}

function recordFingerprint(record, fingerprintField, prefix) {
  const copy = strictClone(record);
  delete copy[fingerprintField];
  return stableHash(copy, prefix);
}

function sealRecord(record, fingerprintField, prefix) {
  const output = strictClone(record);
  output[fingerprintField] = recordFingerprint(output, fingerprintField, prefix);
  return output;
}

function verifySealedRecord(record, fingerprintField, prefix) {
  return Boolean(record && typeof record === 'object' && !Array.isArray(record)
    && typeof record[fingerprintField] === 'string'
    && record[fingerprintField] === recordFingerprint(record, fingerprintField, prefix));
}

function createTransactionManager(options = {}, authority = null) {
  const gateway = options.gateway;
  const gatewayIdentity = getTrustedGatewayIdentity(gateway);
  const isFake = gatewayIdentity
    && gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.FAKE
    && gatewayIdentity.canTouchRealStorage === false;
  const isIsolatedWxRuntimeTest = gatewayIdentity
    && gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.WX_ISOLATED_TEST
    && gatewayIdentity.canTouchRealStorage === true
    && gatewayIdentity.runtimeTestOnly === true;
  const isLegacyReleaseA = authority === LEGACY_RELEASE_A_TRANSACTION_AUTHORITY
    && options.mode === RECORD_STORAGE_COORDINATOR_MODES.LEGACY_ONLY
    && gatewayIdentity
    && (
      isFake
      || isIsolatedWxRuntimeTest
      || (gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.WX_LEGACY
        && gatewayIdentity.canTouchRealStorage === true)
    );
  if (!isFake && !isIsolatedWxRuntimeTest && !isLegacyReleaseA) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      '持久化事务只允许受保护Fake、微信开发者工具隔离测试Gateway或Release A Legacy生产协调器。'
    );
  }
  if (options.mode !== RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW && !isLegacyReleaseA) {
    throw makeError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      '生产共享Commit仍禁用；事务只能显式运行于TRANSACTION_PREVIEW。'
    );
  }
  const storageKeys = resolveTransactionStorageKeys(gatewayIdentity);
  let active = false;

  function readPrimary() {
    const stored = readMaybe(gateway, storageKeys.primary);
    const bundle = stored === null ? {} : stored;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw makeError(RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED, '主业务Bundle不可解析。');
    }
    strictClone(bundle);
    if (!hasCommittedControlIntegrity(bundle)) {
      throw makeError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
        '主业务Bundle持久化控制与业务指纹不一致。'
      );
    }
    const control = normalizeControl(bundle);
    return {
      bundle: strictClone(bundle),
      control,
      revision: control.storageRevision,
      businessFingerprint: getRecordStorageBusinessFingerprint(bundle),
      bundleFingerprint: bundleFingerprint(bundle)
    };
  }

  function getPersistentReceipt(planId) {
    const current = readPrimary();
    return receiptMatch(current.control, planId);
  }

  function recover(recoveryOptions = {}) {
    let journal;
    let backup;
    let primary;
    try {
      journal = readMaybe(gateway, storageKeys.journal);
      backup = readMaybe(gateway, storageKeys.backup);
      primary = readMaybe(gateway, storageKeys.primary);
    } catch (error) {
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_COMMIT_OUTCOME_UNKNOWN,
          '恢复时无法读取完整事务材料。',
          { cause: error && error.code || error && error.message }
        ))]
      };
    }

    if (!journal) {
      if (!backup) {
        if (primary !== null) {
          try {
            if (!primary || typeof primary !== 'object' || Array.isArray(primary)) throw new Error('invalid-primary');
            strictClone(primary);
            normalizeControl(primary);
            if (!hasCommittedControlIntegrity(primary)) throw new Error('invalid-control-integrity');
          } catch (error) {
            return {
              schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
              status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
              writeBlocked: true,
              errors: [makeIssue(makeError(
                RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
                '干净拓扑下主业务Bundle损坏或控制版本不受支持。'
              ))]
            };
          }
        }
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: RECORD_STORAGE_RECOVERY_STATES.CLEAN,
          writeBlocked: false,
          cleanupErrors: []
        };
      }
      let primaryControl = null;
      try { primaryControl = normalizeControl(primary); } catch (ignored) { primaryControl = null; }
      const backupSealed = verifySealedRecord(backup, 'backupFingerprint', 'backup1');
      const primaryIsCommittedTarget = backupSealed
        && backup.schemaVersion === RECORD_STORAGE_BACKUP_SCHEMA_VERSION
        && primaryControl
        && verifyBundle(primary, {
          revision: backup.targetRevision,
          transactionId: backup.transactionId,
          planId: backup.planId,
          planHash: backup.planHash,
          idempotencyKey: backup.idempotencyKey,
          businessFingerprint: backup.targetFingerprint,
          controlStateFingerprint: backup.targetFingerprint,
          bundleFingerprint: backup.targetBundleFingerprint,
          receiptHash: backup.receiptHash
        });
      if (primaryIsCommittedTarget) {
        const cleanupErrors = cleanup(gateway, storageKeys);
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: cleanupErrors.length
            ? RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING
            : RECORD_STORAGE_RECOVERY_STATES.RECOVERED_COMMITTED,
          writeBlocked: cleanupErrors.length > 0,
          transactionId: backup.transactionId,
          planId: backup.planId,
          cleanupErrors
        };
      }
      if (backupSealed
        && backup.schemaVersion === RECORD_STORAGE_BACKUP_SCHEMA_VERSION
        && verifyBundle(primary, { bundleFingerprint: backup.bundleFingerprint })) {
        const cleanupErrors = cleanup(gateway, storageKeys);
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: cleanupErrors.length ? RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED : RECORD_STORAGE_RECOVERY_STATES.CLEAN,
          writeBlocked: cleanupErrors.length > 0,
          cleanupErrors
        };
      }
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
          '存在无Journal的Backup，无法安全判断主Bundle来源。'
        ))]
      };
    }

    if (!journal || journal.schemaVersion !== RECORD_STORAGE_JOURNAL_SCHEMA_VERSION
      || !verifySealedRecord(journal, 'journalFingerprint', 'journal1')
      || ![RECORD_STORAGE_TRANSACTION_STATES.PREPARED, RECORD_STORAGE_TRANSACTION_STATES.MAIN_WRITE_STARTED].includes(journal.status)) {
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_JOURNAL_CORRUPT,
          '事务Journal损坏或状态未知。'
        ))]
      };
    }
    const expectedNew = {
      revision: journal.targetRevision,
      transactionId: journal.transactionId,
      planId: journal.planId,
      planHash: journal.planHash,
      businessFingerprint: journal.targetFingerprint,
      controlStateFingerprint: journal.targetFingerprint,
      bundleFingerprint: journal.targetBundleFingerprint,
      receiptHash: journal.receiptHash,
      idempotencyKey: journal.idempotencyKey
    };
    if (verifyBundle(primary, expectedNew)) {
      const cleanupErrors = cleanup(gateway, storageKeys);
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: cleanupErrors.length
          ? RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING
          : RECORD_STORAGE_RECOVERY_STATES.RECOVERED_COMMITTED,
        writeBlocked: cleanupErrors.length > 0,
        transactionId: journal.transactionId,
        planId: journal.planId,
        cleanupErrors
      };
    }

    const backupValid = backup
      && backup.schemaVersion === RECORD_STORAGE_BACKUP_SCHEMA_VERSION
      && verifySealedRecord(backup, 'backupFingerprint', 'backup1')
      && backup.backupFingerprint === journal.backupFingerprint
      && backup.transactionId === journal.transactionId
      && backup.planId === journal.planId
      && backup.planHash === journal.planHash
      && backup.idempotencyKey === journal.idempotencyKey
      && backup.baseRevision === journal.baseRevision
      && backup.baseFingerprint === journal.baseFingerprint
      && backup.bundleFingerprint === journal.baseBundleFingerprint
      && backup.targetRevision === journal.targetRevision
      && backup.targetFingerprint === journal.targetFingerprint
      && backup.targetBundleFingerprint === journal.targetBundleFingerprint
      && backup.receiptHash === journal.receiptHash
      && verifyBundle(backup.bundle, {
        revision: journal.baseRevision,
        businessFingerprint: journal.baseFingerprint,
        bundleFingerprint: backup.bundleFingerprint
      });
    const primaryIsOld = backupValid && verifyBundle(primary, {
      businessFingerprint: journal.baseFingerprint,
      bundleFingerprint: backup.bundleFingerprint
    });
    if (primaryIsOld) {
      const cleanupErrors = cleanup(gateway, storageKeys);
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: cleanupErrors.length ? RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED : RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK,
        writeBlocked: cleanupErrors.length > 0,
        transactionId: journal.transactionId,
        cleanupErrors
      };
    }
    if (!backupValid || journal.status !== RECORD_STORAGE_TRANSACTION_STATES.MAIN_WRITE_STARTED) {
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_BACKUP_CORRUPT,
          '主Bundle不是明确旧/新状态，且Backup不可用。'
        ))]
      };
    }
    let primaryIsStructurallyValidBundle = false;
    try {
      primaryIsStructurallyValidBundle = Boolean(primary && typeof primary === 'object' && !Array.isArray(primary));
      if (primaryIsStructurallyValidBundle) strictClone(primary);
    } catch (error) {
      primaryIsStructurallyValidBundle = false;
    }
    if (primaryIsStructurallyValidBundle) {
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        transactionId: journal.transactionId,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_COMMIT_OUTCOME_UNKNOWN,
          '主写入窗口出现合法但非旧态/目标态的Bundle；为避免覆盖外部新数据，必须人工确认。'
        ))]
      };
    }
    try {
      gateway.setStorageSync(storageKeys.primary, backup.bundle);
      const restored = readMaybe(gateway, storageKeys.primary);
      if (!verifyBundle(restored, {
        businessFingerprint: journal.baseFingerprint,
        bundleFingerprint: backup.bundleFingerprint
      })) {
        throw makeError(RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RESTORE_FAILED, 'Backup恢复后读回不一致。');
      }
      const cleanupErrors = cleanup(gateway, storageKeys);
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: cleanupErrors.length ? RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED : RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK,
        writeBlocked: cleanupErrors.length > 0,
        transactionId: journal.transactionId,
        cleanupErrors
      };
    } catch (error) {
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RESTORE_FAILED,
          '无法从Backup恢复主业务Bundle。',
          { cause: error && error.code || error && error.message }
        ))]
      };
    }
  }

  function commitBundle(input = {}, commitOptions = {}) {
    if (active) {
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_TRANSACTION_STATES.FAILED,
        commitSucceeded: false,
        errors: [makeIssue(makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_REENTRANT,
          '同一事务管理器不允许重入。'
        ))]
      };
    }
    active = true;
    let mainWriteAttempted = false;
    try {
      validateTransactionInput(input);
      const recovery = recover(commitOptions);
      if (recovery.writeBlocked) {
        throw makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
          '存在未解决的持久化事务，禁止新写入。',
          { recoveryStatus: recovery.status }
        );
      }
      const idempotencyKey = resolveIdempotencyKey(input);
      const current = readPrimary();
      const targetBusinessBundle = stripRecordStorageControl(strictClone(input.targetBundle));
      const targetFingerprint = getRecordStorageBusinessFingerprint(targetBusinessBundle);
      const existingReceipt = receiptMatch(current.control, {
        planId: input.planId,
        planHash: input.planHash,
        idempotencyKey
      });
      if (existingReceipt) {
        const exactReplay = existingReceipt.planId === input.planId
          && existingReceipt.planHash === input.planHash
          && existingReceipt.idempotencyKey === idempotencyKey
          && existingReceipt.committedFingerprint === targetFingerprint;
        if (!exactReplay) {
          throw makeError(
            RECORD_STORAGE_TRANSACTION_ERRORS.SAVE_PLAN_ID_COLLISION,
            'planId、planHash或幂等键已绑定到不同事务内容。'
          );
        }
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED,
          commitSucceeded: true,
          idempotentReplay: true,
          receipt: existingReceipt,
          errors: []
        };
      }
      if (current.revision !== input.baseRevision || current.businessFingerprint !== input.baseFingerprint) {
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT,
          commitSucceeded: false,
          errors: [makeIssue(makeError(
            RECORD_STORAGE_TRANSACTION_ERRORS.STALE_STORAGE_SNAPSHOT,
            '事务基线revision或fingerprint已过期。',
            {
              expectedRevision: input.baseRevision,
              currentRevision: current.revision,
              expectedFingerprint: input.baseFingerprint,
              currentFingerprint: current.businessFingerprint
            }
          ))]
        };
      }
      const targetRevision = current.revision + 1;
      const now = String(input.committedAt || commitOptions.committedAt || '');
      checkpoint(commitOptions, 'BEFORE_RECEIPT_PREPARE', { transactionId: input.transactionId });
      const receipt = {
        schemaVersion: RECORD_STORAGE_RECEIPT_SCHEMA_VERSION,
        planId: String(input.planId),
        planHash: String(input.planHash),
        idempotencyKey,
        transactionId: String(input.transactionId),
        committedRevision: targetRevision,
        committedFingerprint: targetFingerprint,
        committedAt: now,
        riskLevel: String(input.riskLevel || 'NORMAL')
      };
      const receiptHash = stableHash(receipt, 'receipt1');
      const bounded = boundedReceiptLists(current.control, receipt);
      const targetControl = sealRecord(Object.assign({}, current.control, {
        schemaVersion: RECORD_STORAGE_CONTROL_SCHEMA_VERSION,
        storageSchemaVersion: 1,
        storageRevision: targetRevision,
        lastCommittedTransactionId: String(input.transactionId),
        lastCommittedPlanId: String(input.planId),
        lastCommittedPlanHash: String(input.planHash),
        lastCommittedStateFingerprint: targetFingerprint,
        lastCommittedAt: now,
        recentReceipts: bounded.recentReceipts,
        receiptTombstones: bounded.receiptTombstones
      }), 'controlFingerprint', 'control1');
      const targetBundle = composeRecordStorageBundle(targetBusinessBundle, targetControl);
      const targetBundleFingerprint = bundleFingerprint(targetBundle);
      const backup = sealRecord({
        schemaVersion: RECORD_STORAGE_BACKUP_SCHEMA_VERSION,
        transactionId: String(input.transactionId),
        planId: String(input.planId),
        planHash: String(input.planHash),
        idempotencyKey,
        baseRevision: current.revision,
        baseFingerprint: current.businessFingerprint,
        bundleFingerprint: current.bundleFingerprint,
        targetRevision,
        targetFingerprint,
        targetBundleFingerprint,
        receiptHash,
        bundle: current.bundle
      }, 'backupFingerprint', 'backup1');
      const preparedJournal = sealRecord({
        schemaVersion: RECORD_STORAGE_JOURNAL_SCHEMA_VERSION,
        transactionId: String(input.transactionId),
        planId: String(input.planId),
        planHash: String(input.planHash),
        idempotencyKey,
        baseRevision: current.revision,
        baseFingerprint: current.businessFingerprint,
        baseBundleFingerprint: current.bundleFingerprint,
        backupFingerprint: backup.backupFingerprint,
        targetRevision,
        targetFingerprint,
        targetBundleFingerprint,
        receiptHash,
        status: RECORD_STORAGE_TRANSACTION_STATES.PREPARED,
        createdAt: now,
        writerSource: String(input.writerSource || (isLegacyReleaseA
          ? 'LEGACY_RELEASE_A'
          : 'TEST_TRANSACTION_PREVIEW'))
      }, 'journalFingerprint', 'journal1');
      const mainWriteStartedJournal = sealRecord(Object.assign({}, preparedJournal, {
        status: RECORD_STORAGE_TRANSACTION_STATES.MAIN_WRITE_STARTED
      }), 'journalFingerprint', 'journal1');
      const capacity = checkCapacity(gateway, {
        oldPrimaryBytes: estimateEntryBytes(gateway, storageKeys.primary, current.bundle),
        newPrimaryBytes: estimateEntryBytes(gateway, storageKeys.primary, targetBundle),
        backupBytes: estimateEntryBytes(gateway, storageKeys.backup, backup),
        journalBytes: Math.max(
          estimateEntryBytes(gateway, storageKeys.journal, preparedJournal),
          estimateEntryBytes(gateway, storageKeys.journal, mainWriteStartedJournal)
        )
      });

      checkpoint(commitOptions, 'BEFORE_BACKUP_WRITE', { transactionId: input.transactionId });
      gateway.setStorageSync(storageKeys.backup, backup);
      if (!verifyStoredValue(gateway, storageKeys.backup, backup)) {
        throw makeError(RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_BACKUP_WRITE_FAILED, 'Backup写后读回不一致。');
      }
      checkpoint(commitOptions, 'AFTER_BACKUP_WRITE', { transactionId: input.transactionId });
      checkpoint(commitOptions, 'BEFORE_JOURNAL_WRITE', { transactionId: input.transactionId });
      gateway.setStorageSync(storageKeys.journal, preparedJournal);
      if (!verifyStoredValue(gateway, storageKeys.journal, preparedJournal)) {
        throw makeError(RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_JOURNAL_WRITE_FAILED, 'Journal写后读回不一致。');
      }
      checkpoint(commitOptions, 'AFTER_JOURNAL_WRITE', { transactionId: input.transactionId });

      const cas = readPrimary();
      if (cas.revision !== current.revision || cas.businessFingerprint !== current.businessFingerprint
        || cas.bundleFingerprint !== current.bundleFingerprint) {
        throw makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STALE_STORAGE_SNAPSHOT,
          '写主Bundle前CAS发现并发变化。'
        );
      }
      gateway.setStorageSync(storageKeys.journal, mainWriteStartedJournal);
      if (!verifyStoredValue(gateway, storageKeys.journal, mainWriteStartedJournal)) {
        throw makeError(RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_JOURNAL_WRITE_FAILED, '主写入许可Journal写后读回不一致。');
      }
      checkpoint(commitOptions, 'BEFORE_MAIN_WRITE', { transactionId: input.transactionId });
      const finalCas = readPrimary();
      if (finalCas.revision !== current.revision
        || finalCas.businessFingerprint !== current.businessFingerprint
        || finalCas.bundleFingerprint !== current.bundleFingerprint) {
        throw makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STALE_STORAGE_SNAPSHOT,
          '主写入前最终CAS发现并发变化。'
        );
      }
      mainWriteAttempted = true;
      gateway.setStorageSync(storageKeys.primary, targetBundle);
      checkpoint(commitOptions, 'AFTER_MAIN_WRITE', { transactionId: input.transactionId });
      checkpoint(commitOptions, 'BEFORE_READBACK', { transactionId: input.transactionId });
      const readback = readMaybe(gateway, storageKeys.primary);
      if (!verifyBundle(readback, {
        revision: targetRevision,
        transactionId: input.transactionId,
        planId: input.planId,
        planHash: input.planHash,
        idempotencyKey,
        businessFingerprint: targetFingerprint,
        controlStateFingerprint: targetFingerprint,
        bundleFingerprint: targetBundleFingerprint,
        receiptHash
      })) {
        throw makeError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_PRIMARY_READBACK_MISMATCH,
          '主业务Bundle写后读回校验失败。'
        );
      }
      checkpoint(commitOptions, 'AFTER_READBACK', { transactionId: input.transactionId });
      checkpoint(commitOptions, 'BEFORE_JOURNAL_CLEANUP', { transactionId: input.transactionId });
      removeAndVerify(gateway, storageKeys.journal);
      checkpoint(commitOptions, 'BEFORE_BACKUP_CLEANUP', { transactionId: input.transactionId });
      removeAndVerify(gateway, storageKeys.backup);
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: RECORD_STORAGE_TRANSACTION_STATES.COMMITTED,
        commitSucceeded: true,
        idempotentReplay: false,
        baseRevision: current.revision,
        targetRevision,
        baseFingerprint: current.businessFingerprint,
        targetFingerprint,
        targetBundleFingerprint,
        receipt: safeClone(receipt),
        capacity,
        errors: []
      };
    } catch (error) {
      if (error && error.simulatedCrash) throw error;
      if (error && error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STALE_STORAGE_SNAPSHOT
        && mainWriteAttempted === false) {
        const cleanupErrors = cleanup(gateway, storageKeys);
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: cleanupErrors.length
            ? RECORD_STORAGE_TRANSACTION_STATES.RECOVERY_REQUIRED
            : RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT,
          commitSucceeded: false,
          writeBlocked: cleanupErrors.length > 0,
          cleanupErrors,
          errors: [makeIssue(error)]
        };
      }
      const recovery = recover(commitOptions);
      const recoveredCommitted = recovery.status === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_COMMITTED
        || recovery.status === RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING;
      if (recoveredCommitted) {
        let receipt = null;
        try { receipt = getPersistentReceipt(input.planId); } catch (ignored) { receipt = null; }
        return {
          schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
          status: recovery.status,
          commitSucceeded: true,
          idempotentReplay: false,
          receipt,
          recovery,
          warnings: [makeIssue(error)],
          errors: []
        };
      }
      const unknown = mainWriteAttempted && recovery.status === RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED;
      return {
        schemaVersion: RECORD_STORAGE_TRANSACTION_SCHEMA_VERSION,
        status: unknown
          ? RECORD_STORAGE_TRANSACTION_STATES.COMMIT_OUTCOME_UNKNOWN
          : (recovery.status === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK
            ? RECORD_STORAGE_TRANSACTION_STATES.ROLLED_BACK
            : RECORD_STORAGE_TRANSACTION_STATES.FAILED),
        commitSucceeded: false,
        recovery,
        errors: [makeIssue(error)]
      };
    } finally {
      active = false;
    }
  }

  const manager = Object.freeze({
    commitBundle,
    getPersistentReceipt,
    readTransactionSnapshot: readPrimary,
    recover
  });
  TRUSTED_TRANSACTION_MANAGERS.set(manager, Object.freeze({
    gateway,
    gatewayKind: gatewayIdentity && gatewayIdentity.gatewayKind || 'UNKNOWN',
    legacyReleaseA: isLegacyReleaseA,
    mode: options.mode
  }));
  return manager;
}

function createPersistentRecordTransactionManager(options = {}) {
  return createTransactionManager(options);
}

function getTrustedRecordStorageTransactionManagerIdentity(manager) {
  const identity = TRUSTED_TRANSACTION_MANAGERS.get(manager);
  return identity ? Object.assign({}, identity) : null;
}

function createLegacyReleaseARecordStorageCoordinator(options = {}) {
  const transactionManager = createTransactionManager(
    Object.assign({}, options, { mode: RECORD_STORAGE_COORDINATOR_MODES.LEGACY_ONLY }),
    LEGACY_RELEASE_A_TRANSACTION_AUTHORITY
  );
  // 延迟加载避免 transaction/coordinator 初始化循环。低层 Legacy manager 不导出；
  // 平台组合根只能取得完整 Coordinator，不能绕过上下文、锁、来源和监测。
  const {
    createReleaseARecordStorageCoordinatorFromTransactionManager
  } = require('./record-storage-coordinator');
  return createReleaseARecordStorageCoordinatorFromTransactionManager(
    options,
    transactionManager
  );
}

function recoverRecordStorageTransaction(input = {}) {
  const manager = createPersistentRecordTransactionManager(input);
  return manager.recover(input);
}

module.exports = {
  assertPlainSerializable,
  bundleFingerprint,
  createLegacyReleaseARecordStorageCoordinator,
  createPersistentRecordTransactionManager,
  defaultControl,
  getTrustedRecordStorageTransactionManagerIdentity,
  recoverRecordStorageTransaction,
  strictClone,
  verifyBundle
};
