const {
  getStateFingerprint,
  normalizeDomainState,
  safeClone,
  stableHash
} = require('./record-state-diff');
const {
  KNOWN_NON_BUSINESS_STORAGE_KEYS,
  LEGACY_BUSINESS_STORAGE_KEY,
  RECORD_TRANSACTION_STORAGE_KEYS,
  RECORD_STORAGE_SNAPSHOT_SCHEMA_VERSION,
  STORAGE_ATOMICITY_STRATEGIES
} = require('./record-storage-adapter-contract');
const {
  RECORD_STORAGE_CONTROL_KEY,
  RECORD_STORAGE_CONTROL_SCHEMA_VERSION,
  RECORD_STORAGE_RECEIPT_SCHEMA_VERSION,
  RECORD_STORAGE_TRANSACTION_ERRORS
} = require('./record-storage-transaction-contract');

const LEGACY_BUSINESS_STATE_PATHS = Object.freeze([
  { path: 'meta', dataType: 'object', category: 'BUSINESS_PROFILE', core: false, rebuildable: false },
  { path: 'customers', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'quotations', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'orders', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'receivables', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'paymentRecords', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'todos', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'pendingNotes', dataType: 'array', category: 'BUSINESS_STATE', core: true, rebuildable: false },
  { path: 'orderProgress', dataType: 'array', category: 'DERIVED_AUDIT_STATE', core: false, rebuildable: false },
  { path: 'aiParseLogs', dataType: 'array', category: 'LOG_STATE', core: false, rebuildable: false },
  { path: 'operationLogs', dataType: 'array', category: 'LOG_STATE', core: false, rebuildable: false },
  { path: 'productCatalog', dataType: 'array', category: 'MIXED_INDEX_AND_USER_STATE', core: false, rebuildable: false },
  { path: 'dunningRecords', dataType: 'array', category: 'BUSINESS_AUDIT_STATE', core: false, rebuildable: false },
  { path: 'dunningTemplates', dataType: 'array', category: 'BUSINESS_CONFIG', core: false, rebuildable: true },
  { path: 'deletedRecords', dataType: 'array', category: 'BUSINESS_AUDIT_STATE', core: false, rebuildable: false }
]);

const LEGACY_CORE_TOP_LEVEL_KEYS = Object.freeze([
  'meta',
  'customers',
  'quotations',
  'orders',
  'receivables',
  'paymentRecords',
  'dunningRecords',
  'todos',
  'orderProgress',
  'pendingNotes',
  'aiParseLogs',
  'dunningTemplates'
]);

function validEntries(entries) {
  return entries && typeof entries === 'object' && !Array.isArray(entries);
}

function transactionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readRecordStorageControl(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
  if (!Object.prototype.hasOwnProperty.call(bundle, RECORD_STORAGE_CONTROL_KEY)) return null;
  const control = bundle[RECORD_STORAGE_CONTROL_KEY];
  if (!control || typeof control !== 'object' || Array.isArray(control)) {
    throw transactionError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CONTROL_NAMESPACE_COLLISION,
      '业务Bundle保留控制命名空间被旧数据占用。'
    );
  }
  if (control.schemaVersion !== RECORD_STORAGE_CONTROL_SCHEMA_VERSION) {
    throw transactionError(
      RECORD_STORAGE_TRANSACTION_ERRORS.UNSUPPORTED_STORAGE_SCHEMA,
      '业务Bundle持久化控制版本不受支持。'
    );
  }
  if (!Number.isInteger(control.storageRevision) || control.storageRevision < 0) {
    throw transactionError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_REVISION_INVALID,
      '业务Bundle持久化revision无效。'
    );
  }
  if (control.storageSchemaVersion !== undefined
    && (!Number.isInteger(control.storageSchemaVersion) || control.storageSchemaVersion < 1)) {
    throw transactionError(
      RECORD_STORAGE_TRANSACTION_ERRORS.UNSUPPORTED_STORAGE_SCHEMA,
      '业务Bundle持久化storage schema无效。'
    );
  }
  const stringFields = [
    'lastCommittedTransactionId',
    'lastCommittedPlanId',
    'lastCommittedPlanHash',
    'lastCommittedStateFingerprint',
    'lastCommittedAt'
  ];
  if (stringFields.some((field) => control[field] !== undefined && typeof control[field] !== 'string')) {
    throw transactionError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
      '业务Bundle持久化控制字段无效。'
    );
  }
  ['recentReceipts', 'receiptTombstones'].forEach((field) => {
    if (control[field] !== undefined && !Array.isArray(control[field])) {
      throw transactionError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
        `业务Bundle持久化${field}无效。`
      );
    }
    (control[field] || []).forEach((receipt) => {
      const valid = receipt
        && typeof receipt === 'object'
        && !Array.isArray(receipt)
        && receipt.schemaVersion === RECORD_STORAGE_RECEIPT_SCHEMA_VERSION
        && typeof receipt.planId === 'string'
        && typeof receipt.planHash === 'string'
        && typeof receipt.idempotencyKey === 'string'
        && typeof receipt.transactionId === 'string'
        && Number.isInteger(receipt.committedRevision)
        && receipt.committedRevision > 0
        && typeof receipt.committedFingerprint === 'string';
      if (!valid) {
        throw transactionError(
          RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
          `业务Bundle持久化${field}条目无效。`
        );
      }
    });
  });
  if (control.storageRevision > 0) {
    const fingerprinted = safeClone(control);
    delete fingerprinted.controlFingerprint;
    if (typeof control.controlFingerprint !== 'string'
      || control.controlFingerprint !== stableHash(fingerprinted, 'control1')) {
      throw transactionError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_RECOVERY_REQUIRED,
        '业务Bundle持久化控制账本指纹无效。'
      );
    }
  }
  return safeClone(control);
}

function stripRecordStorageControl(bundle) {
  const output = safeClone(bundle || {});
  if (output && typeof output === 'object') delete output[RECORD_STORAGE_CONTROL_KEY];
  return output;
}

function composeRecordStorageBundle(domainState, control) {
  const output = stripRecordStorageControl(domainState);
  if (control !== undefined && control !== null) {
    readRecordStorageControl({ [RECORD_STORAGE_CONTROL_KEY]: control });
    output[RECORD_STORAGE_CONTROL_KEY] = safeClone(control);
  }
  return output;
}

function getRecordStorageBusinessFingerprint(bundle) {
  return getStateFingerprint(stripRecordStorageControl(bundle));
}

function projectLegacyStorageEntries(entries = {}, options = {}) {
  if (!validEntries(entries)) {
    const error = new Error('Storage快照必须是key-value对象。');
    error.code = 'STORAGE_SNAPSHOT_INVALID';
    throw error;
  }
  const input = safeClone(entries);
  const hasBusinessBundle = Object.prototype.hasOwnProperty.call(input, LEGACY_BUSINESS_STORAGE_KEY)
    && input[LEGACY_BUSINESS_STORAGE_KEY] !== undefined
    && input[LEGACY_BUSINESS_STORAGE_KEY] !== null
    && input[LEGACY_BUSINESS_STORAGE_KEY] !== '';
  const rawBusinessBundle = hasBusinessBundle
    ? input[LEGACY_BUSINESS_STORAGE_KEY]
    : safeClone(options.defaultBusinessState || {});
  if (!rawBusinessBundle || typeof rawBusinessBundle !== 'object' || Array.isArray(rawBusinessBundle)) {
    const error = new Error('旧Storage业务bundle不是对象。');
    error.code = 'STORAGE_BUSINESS_BUNDLE_INVALID';
    throw error;
  }
  const storageControl = readRecordStorageControl(rawBusinessBundle);
  const businessBundleWithoutControl = stripRecordStorageControl(rawBusinessBundle);
  const domainState = normalizeDomainState(businessBundleWithoutControl);
  const presentKeys = Object.keys(input).sort();
  const excludedKeys = presentKeys.filter((key) => KNOWN_NON_BUSINESS_STORAGE_KEYS[key]);
  const transactionKeys = presentKeys.filter((key) => Object.values(RECORD_TRANSACTION_STORAGE_KEYS).includes(key));
  const unknownKeys = presentKeys.filter((key) => (
    key !== LEGACY_BUSINESS_STORAGE_KEY
    && !KNOWN_NON_BUSINESS_STORAGE_KEYS[key]
    && !Object.values(RECORD_TRANSACTION_STORAGE_KEYS).includes(key)
  ));
  const storageStateVersion = hasBusinessBundle ? 1 : 0;
  const storageStateFingerprint = getStateFingerprint(domainState);
  const persistentRevision = storageControl ? storageControl.storageRevision : 0;
  return {
    schemaVersion: RECORD_STORAGE_SNAPSHOT_SCHEMA_VERSION,
    businessStorageKey: LEGACY_BUSINESS_STORAGE_KEY,
    businessBundlePresent: hasBusinessBundle,
    businessBundle: safeClone(rawBusinessBundle),
    businessBundleWithoutControl,
    storageControl,
    domainState,
    storageStateVersion,
    storageStateVersionResolved: false,
    storageStateVersionSource: hasBusinessBundle ? 'LEGACY_BUNDLE_PRESENT' : 'LEGACY_BUNDLE_ABSENT',
    storageStateFingerprint,
    persistentRevision,
    persistentRevisionResolved: Boolean(storageControl),
    storageSnapshotFingerprint: stableHash({
      businessStorageKey: LEGACY_BUSINESS_STORAGE_KEY,
      domainState,
      storageControl
    }, 'storage1'),
    atomicityStrategy: STORAGE_ATOMICITY_STRATEGIES.SINGLE_BUNDLE_REPLACE_UNVERIFIED,
    topology: {
      presentKeys,
      projectedKeys: hasBusinessBundle ? [LEGACY_BUSINESS_STORAGE_KEY] : [],
      excludedKeys,
      transactionKeys,
      excludedKeyCategories: excludedKeys.reduce((result, key) => {
        result[key] = KNOWN_NON_BUSINESS_STORAGE_KEYS[key];
        return result;
      }, {}),
      unknownKeys
    }
  };
}

function projectDomainStateToLegacyBusinessBundle(domainState, snapshot = {}) {
  const next = normalizeDomainState(domainState);
  const previous = snapshot.businessBundle && typeof snapshot.businessBundle === 'object'
    ? snapshot.businessBundle
    : {};
  const output = {};
  const keys = Array.from(new Set(Object.keys(previous).concat(Object.keys(next))))
    .filter((key) => key !== RECORD_STORAGE_CONTROL_KEY)
    .sort();
  keys.forEach((key) => {
    const mustExist = LEGACY_CORE_TOP_LEVEL_KEYS.includes(key);
    const existed = Object.prototype.hasOwnProperty.call(previous, key);
    const value = next[key];
    const meaningfulArray = Array.isArray(value) && value.length > 0;
    const meaningfulValue = !Array.isArray(value) && value !== undefined;
    if (mustExist || existed || meaningfulArray || meaningfulValue) output[key] = safeClone(value);
  });
  if (snapshot.storageControl) output[RECORD_STORAGE_CONTROL_KEY] = safeClone(snapshot.storageControl);
  return output;
}

function buildLegacyStorageWrites(domainState, snapshot) {
  return [{
    key: LEGACY_BUSINESS_STORAGE_KEY,
    strategy: 'REPLACE',
    value: projectDomainStateToLegacyBusinessBundle(domainState, snapshot)
  }];
}

module.exports = {
  KNOWN_NON_BUSINESS_STORAGE_KEYS,
  LEGACY_BUSINESS_STATE_PATHS,
  LEGACY_BUSINESS_STORAGE_KEY,
  LEGACY_CORE_TOP_LEVEL_KEYS,
  buildLegacyStorageWrites,
  composeRecordStorageBundle,
  getRecordStorageBusinessFingerprint,
  projectDomainStateToLegacyBusinessBundle,
  projectLegacyStorageEntries,
  readRecordStorageControl,
  stripRecordStorageControl
};
