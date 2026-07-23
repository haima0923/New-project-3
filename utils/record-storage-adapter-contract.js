const RECORD_STORAGE_ADAPTER_SCHEMA_VERSION = 'record-storage-adapter-v1';
const RECORD_STORAGE_SNAPSHOT_SCHEMA_VERSION = 'record-storage-snapshot-v1';
const RECORD_STORAGE_PREVIEW_SCHEMA_VERSION = 'record-storage-preview-v1';

const LEGACY_BUSINESS_STORAGE_KEY = 'yiwu_boss_ai_assistant_v1';

const RECORD_TRANSACTION_STORAGE_KEYS = Object.freeze({
  journal: `${LEGACY_BUSINESS_STORAGE_KEY}__txn_journal_v1`,
  backup: `${LEGACY_BUSINESS_STORAGE_KEY}__txn_backup_v1`
});

const KNOWN_NON_BUSINESS_STORAGE_KEYS = Object.freeze({
  huoxiaoling_ai_auth_session_v1: 'USER_IDENTITY',
  pending_to_edit: 'PAGE_NAVIGATION',
  record_to_edit: 'PAGE_NAVIGATION',
  force_text_input: 'PAGE_PREFERENCE',
  draft_to_input: 'PAGE_DRAFT_TRANSFER',
  finance_segment: 'PAGE_NAVIGATION'
});

const KNOWN_NON_BUSINESS_STORAGE_TOPOLOGY = Object.freeze([
  Object.freeze({ key: 'huoxiaoling_ai_auth_session_v1', category: 'USER_IDENTITY', producers: ['utils/api-client.js'], consumers: ['utils/api-client.js'] }),
  Object.freeze({ key: 'pending_to_edit', category: 'PAGE_NAVIGATION', producers: ['pages/pending/pending.js'], consumers: ['pages/input/input.js'] }),
  Object.freeze({ key: 'record_to_edit', category: 'PAGE_NAVIGATION', producers: ['pages/orders/orders.js', 'pages/record-detail/record-detail.js'], consumers: ['pages/input/input.js'] }),
  Object.freeze({ key: 'force_text_input', category: 'PAGE_PREFERENCE', producers: ['pages/dashboard/dashboard.js'], consumers: ['pages/input/input.js'] }),
  Object.freeze({ key: 'draft_to_input', category: 'PAGE_DRAFT_TRANSFER', producers: ['pages/dashboard/dashboard.js'], consumers: ['pages/input/input.js'] }),
  Object.freeze({ key: 'finance_segment', category: 'PAGE_NAVIGATION', producers: ['pages/dashboard/dashboard.js'], consumers: ['pages/finance/finance.js'] })
]);

const STORAGE_TARGET_KINDS = Object.freeze({
  MEMORY: 'MEMORY',
  WX_LEGACY: 'WX_LEGACY',
  WX_TRANSACTIONAL: 'WX_TRANSACTIONAL',
  FAKE: 'FAKE',
  SHADOW: 'SHADOW'
});

const STORAGE_MIGRATION_MODES = Object.freeze({
  LEGACY_ONLY: 'LEGACY_ONLY',
  SHADOW_COMPARE: 'SHADOW_COMPARE',
  SHARED_COMMIT: 'SHARED_COMMIT'
});

const STORAGE_ATOMICITY_STRATEGIES = Object.freeze({
  SINGLE_BUNDLE_REPLACE_UNVERIFIED: 'SINGLE_BUNDLE_REPLACE_UNVERIFIED',
  MEMORY_ATOMIC_SWAP: 'MEMORY_ATOMIC_SWAP',
  MULTI_KEY_NOT_SUPPORTED: 'MULTI_KEY_NOT_SUPPORTED'
});

const STORAGE_ADAPTER_ERROR_CODES = Object.freeze({
  STORAGE_ADAPTER_INVALID: 'STORAGE_ADAPTER_INVALID',
  STORAGE_ADAPTER_IDENTITY_INVALID: 'STORAGE_ADAPTER_IDENTITY_INVALID',
  STORAGE_GATEWAY_INVALID: 'STORAGE_GATEWAY_INVALID',
  STORAGE_SNAPSHOT_INVALID: 'STORAGE_SNAPSHOT_INVALID',
  STORAGE_SNAPSHOT_UNTRUSTED: 'STORAGE_SNAPSHOT_UNTRUSTED',
  STORAGE_SNAPSHOT_STALE: 'STORAGE_SNAPSHOT_STALE',
  STORAGE_BUSINESS_BUNDLE_INVALID: 'STORAGE_BUSINESS_BUNDLE_INVALID',
  STORAGE_PREVIEW_FAILED: 'STORAGE_PREVIEW_FAILED',
  STORAGE_PREVIEW_STALE_PLAN: 'STORAGE_PREVIEW_STALE_PLAN',
  SHARED_PRODUCTION_COMMIT_DISABLED: 'SHARED_PRODUCTION_COMMIT_DISABLED',
  STORAGE_MIGRATION_MODE_INVALID: 'STORAGE_MIGRATION_MODE_INVALID',
  STORAGE_MIGRATION_MODE_FORBIDDEN: 'STORAGE_MIGRATION_MODE_FORBIDDEN'
});

const SHADOW_DIFFERENCE_TYPES = Object.freeze({
  SAVE_PLAN_MISSING_OPERATION: 'SAVE_PLAN_MISSING_OPERATION',
  LEGACY_HIDDEN_SIDE_EFFECT: 'LEGACY_HIDDEN_SIDE_EFFECT',
  STATE_PROJECTION_ERROR: 'STATE_PROJECTION_ERROR',
  ID_DIFFERENCE: 'ID_DIFFERENCE',
  TIME_DIFFERENCE: 'TIME_DIFFERENCE',
  ORDERING_ONLY: 'ORDERING_ONLY',
  LOGGING_DIFFERENCE: 'LOGGING_DIFFERENCE',
  PRODUCT_CATALOG_DIFFERENCE: 'PRODUCT_CATALOG_DIFFERENCE',
  RELATION_DIFFERENCE: 'RELATION_DIFFERENCE',
  BUSINESS_DATA_DIFFERENCE: 'BUSINESS_DATA_DIFFERENCE',
  TEST_FIXTURE_ERROR: 'TEST_FIXTURE_ERROR'
});

function normalizeStorageTargetKind(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return STORAGE_TARGET_KINDS[normalized] || null;
}

function normalizeStorageMigrationMode(value) {
  if (value === undefined || value === null || value === '') return STORAGE_MIGRATION_MODES.LEGACY_ONLY;
  const normalized = String(value).trim().toUpperCase();
  return STORAGE_MIGRATION_MODES[normalized] || null;
}

module.exports = {
  KNOWN_NON_BUSINESS_STORAGE_KEYS,
  KNOWN_NON_BUSINESS_STORAGE_TOPOLOGY,
  LEGACY_BUSINESS_STORAGE_KEY,
  RECORD_TRANSACTION_STORAGE_KEYS,
  RECORD_STORAGE_ADAPTER_SCHEMA_VERSION,
  RECORD_STORAGE_PREVIEW_SCHEMA_VERSION,
  RECORD_STORAGE_SNAPSHOT_SCHEMA_VERSION,
  SHADOW_DIFFERENCE_TYPES,
  STORAGE_ADAPTER_ERROR_CODES,
  STORAGE_ATOMICITY_STRATEGIES,
  STORAGE_MIGRATION_MODES,
  STORAGE_TARGET_KINDS,
  normalizeStorageMigrationMode,
  normalizeStorageTargetKind
};
