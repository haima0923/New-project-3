const SAVE_PLAN_SCHEMA_VERSION = 'record-save-plan-v1';
const COMMIT_RECEIPT_SCHEMA_VERSION = 'record-save-commit-receipt-v1';

function freezeEnum(values) {
  return Object.freeze(values.reduce((result, value) => {
    result[value] = value;
    return result;
  }, {}));
}

const SAVE_ACTIONS = freezeEnum(['SAVE_FORMAL', 'SAVE_PENDING']);
const COMMIT_TARGET_POLICIES = freezeEnum(['REAL_OR_MEMORY', 'MEMORY_ONLY', 'BLOCKED']);
const OPERATION_ACTIONS = freezeEnum(['CREATE', 'UPDATE', 'UPSERT', 'APPEND', 'LINK', 'DELETE']);
const ENTITY_TYPES = freezeEnum([
  'CUSTOMER',
  'QUOTATION',
  'ORDER',
  'RECEIVABLE',
  'PAYMENT',
  'TODO',
  'PENDING_NOTE',
  'ORDER_PROGRESS',
  'AI_PARSE_LOG',
  'OPERATION_LOG',
  'PRODUCT_CATALOG',
  'DUNNING_RECORD',
  'DELETED_RECORD'
]);
const COMMIT_STATUSES = freezeEnum([
  'COMMITTED',
  'ALREADY_COMMITTED',
  'BLOCKED',
  'STALE_PLAN',
  'ROLLED_BACK',
  'FAILED'
]);

const TEMPORARY_ID_PATTERN = /^temp:(customer|quotation|order|receivable|payment|todo|pending|progress|parse-log|operation-log|product|dunning|deleted):[1-9]\d*$/;

const COLLECTION_BY_ENTITY = Object.freeze({
  CUSTOMER: 'customers',
  QUOTATION: 'quotations',
  ORDER: 'orders',
  RECEIVABLE: 'receivables',
  PAYMENT: 'paymentRecords',
  TODO: 'todos',
  PENDING_NOTE: 'pendingNotes',
  ORDER_PROGRESS: 'orderProgress',
  AI_PARSE_LOG: 'aiParseLogs',
  OPERATION_LOG: 'operationLogs',
  PRODUCT_CATALOG: 'productCatalog',
  DUNNING_RECORD: 'dunningRecords',
  DELETED_RECORD: 'deletedRecords'
});

const ENTITY_BY_COLLECTION = Object.freeze(Object.keys(COLLECTION_BY_ENTITY).reduce((result, entityType) => {
  result[COLLECTION_BY_ENTITY[entityType]] = entityType;
  return result;
}, {}));

const SAVE_PLAN_ERROR_CODES = freezeEnum([
  'INVALID_SAVE_ACTION',
  'CONFIRMATION_BINDING_MISMATCH',
  'PREFLIGHT_BINDING_MISMATCH',
  'FORMAL_SAVE_BLOCKED',
  'MODE_NOT_COMMITTABLE',
  'PROVIDER_NOT_COMMITTABLE',
  'ORIGINAL_TEXT_REQUIRED',
  'SAVE_PLAN_INVALID',
  'SAVE_PLAN_HASH_MISMATCH',
  'SAVE_PLAN_ID_COLLISION',
  'SAVE_PLAN_IDEMPOTENCY_COLLISION',
  'SAVE_PLAN_AUTHORIZATION_INVALID',
  'STALE_SAVE_PLAN',
  'SAVE_PLAN_OPERATION_INVALID',
  'SAVE_PLAN_DEPENDENCY_INVALID',
  'SAVE_PLAN_DEPENDENCY_CYCLE',
  'SAVE_PLAN_TEMP_REFERENCE_INVALID',
  'SAVE_PLAN_TARGET_INVALID',
  'SAVE_PLAN_OPERATION_FAILED',
  'SAVE_PLAN_INVARIANT_FAILED',
  'SAVE_PLAN_EXPECTED_DIFF_MISMATCH',
  'BUSINESS_ID_INVALID'
]);

function normalizeSaveAction(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return SAVE_ACTIONS[normalized] || '';
}

function isTemporaryRecordId(value) {
  return TEMPORARY_ID_PATTERN.test(String(value || ''));
}

function isTemporaryReferencePath(path) {
  const normalized = String(path || '').replace(/\[\d+\]$/g, '');
  if (normalized.startsWith('collectionOrders.')) return true;
  const key = normalized.split('.').pop() || '';
  return key === 'id'
    || key === 'temporaryId'
    || key === 'targetId'
    || key === 'value'
    || key === 'beforeOrder'
    || key === 'afterOrder'
    || key === 'relatedRecordIds'
    || /Id$/.test(key);
}

module.exports = {
  COLLECTION_BY_ENTITY,
  COMMIT_RECEIPT_SCHEMA_VERSION,
  COMMIT_STATUSES,
  COMMIT_TARGET_POLICIES,
  ENTITY_BY_COLLECTION,
  ENTITY_TYPES,
  OPERATION_ACTIONS,
  SAVE_ACTIONS,
  SAVE_PLAN_ERROR_CODES,
  SAVE_PLAN_SCHEMA_VERSION,
  TEMPORARY_ID_PATTERN,
  isTemporaryRecordId,
  isTemporaryReferencePath,
  normalizeSaveAction
};
