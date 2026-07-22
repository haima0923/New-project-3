const {
  getStateFingerprint,
  normalizeDomainState,
  safeClone,
  stableHash
} = require('./record-state-diff');
const {
  KNOWN_NON_BUSINESS_STORAGE_KEYS,
  LEGACY_BUSINESS_STORAGE_KEY,
  RECORD_STORAGE_SNAPSHOT_SCHEMA_VERSION,
  STORAGE_ATOMICITY_STRATEGIES
} = require('./record-storage-adapter-contract');

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
  const domainState = normalizeDomainState(rawBusinessBundle);
  const presentKeys = Object.keys(input).sort();
  const excludedKeys = presentKeys.filter((key) => KNOWN_NON_BUSINESS_STORAGE_KEYS[key]);
  const unknownKeys = presentKeys.filter((key) => (
    key !== LEGACY_BUSINESS_STORAGE_KEY && !KNOWN_NON_BUSINESS_STORAGE_KEYS[key]
  ));
  const storageStateVersion = hasBusinessBundle ? 1 : 0;
  const storageStateFingerprint = getStateFingerprint(domainState);
  return {
    schemaVersion: RECORD_STORAGE_SNAPSHOT_SCHEMA_VERSION,
    businessStorageKey: LEGACY_BUSINESS_STORAGE_KEY,
    businessBundlePresent: hasBusinessBundle,
    businessBundle: safeClone(rawBusinessBundle),
    domainState,
    storageStateVersion,
    storageStateVersionResolved: false,
    storageStateVersionSource: hasBusinessBundle ? 'LEGACY_BUNDLE_PRESENT' : 'LEGACY_BUNDLE_ABSENT',
    storageStateFingerprint,
    storageSnapshotFingerprint: stableHash({
      businessStorageKey: LEGACY_BUSINESS_STORAGE_KEY,
      domainState
    }, 'storage1'),
    atomicityStrategy: STORAGE_ATOMICITY_STRATEGIES.SINGLE_BUNDLE_REPLACE_UNVERIFIED,
    topology: {
      presentKeys,
      projectedKeys: hasBusinessBundle ? [LEGACY_BUSINESS_STORAGE_KEY] : [],
      excludedKeys,
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
  const keys = Array.from(new Set(Object.keys(previous).concat(Object.keys(next)))).sort();
  keys.forEach((key) => {
    const mustExist = LEGACY_CORE_TOP_LEVEL_KEYS.includes(key);
    const existed = Object.prototype.hasOwnProperty.call(previous, key);
    const value = next[key];
    const meaningfulArray = Array.isArray(value) && value.length > 0;
    const meaningfulValue = !Array.isArray(value) && value !== undefined;
    if (mustExist || existed || meaningfulArray || meaningfulValue) output[key] = safeClone(value);
  });
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
  projectDomainStateToLegacyBusinessBundle,
  projectLegacyStorageEntries
};
