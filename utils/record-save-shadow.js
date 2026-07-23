const { SHADOW_DIFFERENCE_TYPES } = require('./record-storage-adapter-contract');
const {
  createStateDiff,
  normalizeDomainState,
  safeClone,
  stableSerialize
} = require('./record-state-diff');

const RELATION_FIELDS = new Set([
  'customerId', 'quotationId', 'orderId', 'receivableId', 'convertedOrderId', 'mergedInto'
]);
const TIME_FIELD_PATTERN = /(^|\.)(createdAt|updatedAt|completedAt|convertedAt|actualShipDate|lastDunningDate)$/;

const LEGACY_PAGE_LIFECYCLE_INVENTORY = Object.freeze([
  { id: 'app-launch-initialize', entry: 'onLaunch initializeState', callers: ['app'], sourceFiles: ['app.js'], phase1e1Support: 'OUT_OF_SCOPE', migrationPhase: 'STORAGE_COORDINATION', writeBehavior: 'ALWAYS_REPLACE_BUNDLE' },
  { id: 'record-formal', entry: 'saveConfirmedDraft', callers: ['pages/input', 'pages/dashboard'], sourceFiles: ['pages/input/input.js', 'pages/dashboard/dashboard.js'], phase1e1Support: 'REPRESENTATIVE_ALLOWED_PATHS', migrationPhase: '1E.2B_MAIN', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'record-pending', entry: 'savePendingNote', callers: ['pages/input', 'pages/dashboard'], sourceFiles: ['pages/input/input.js', 'pages/dashboard/dashboard.js'], phase1e1Support: 'REPRESENTATIVE_PATHS', migrationPhase: '1E.2B_MAIN', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'editing-pending-update', entry: 'page-local pending update', callers: ['pages/input'], sourceFiles: ['pages/input/input.js'], phase1e1Support: 'NONE', migrationPhase: '1E.2B_PENDING', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'editing-pending-convert', entry: 'page-local pending conversion marker', callers: ['pages/input'], sourceFiles: ['pages/input/input.js'], phase1e1Support: 'NONE', migrationPhase: '1E.2B_PENDING', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'quotation-convert', entry: 'convertQuotationToOrder', callers: ['pages/quotations'], sourceFiles: ['pages/quotations/quotations.js'], phase1e1Support: 'BOUNDARY_ONLY', migrationPhase: 'LIFECYCLE_ORDER', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'order-generate-receivable', entry: 'generateReceivableFromOrder', callers: ['pages/orders', 'pages/finance'], sourceFiles: ['pages/orders/orders.js', 'pages/finance/finance.js'], phase1e1Support: 'BOUNDARY_ONLY', migrationPhase: 'LIFECYCLE_FINANCE', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'direct-payment', entry: 'recordPayment', callers: ['pages/receivables', 'pages/finance'], sourceFiles: ['pages/receivables/receivables.js', 'pages/finance/finance.js'], phase1e1Support: 'SIMILAR_DATA_ONLY', migrationPhase: 'LIFECYCLE_FINANCE', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'direct-dunning', entry: 'recordDunning', callers: ['pages/receivables', 'pages/finance'], sourceFiles: ['pages/receivables/receivables.js', 'pages/finance/finance.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_FINANCE', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'order-status', entry: 'updateOrderStatus', callers: ['pages/orders'], sourceFiles: ['pages/orders/orders.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_ORDER', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'order-delivery', entry: 'setOrderDeliveryDate', callers: ['pages/orders'], sourceFiles: ['pages/orders/orders.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_ORDER', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'todo-complete', entry: 'completeTodo', callers: ['pages/todos'], sourceFiles: ['pages/todos/todos.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_LOW_RISK', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'pending-ignore', entry: 'page-local pending ignore', callers: ['pages/pending'], sourceFiles: ['pages/pending/pending.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_LOW_RISK', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'soft-delete', entry: 'softDeleteRecord', callers: ['pages/records'], sourceFiles: ['pages/records/records.js'], variants: ['quotation', 'order', 'receivable', 'payment', 'todo', 'pending'], phase1e1Support: 'BOUNDARY_ONLY', migrationPhase: 'LIFECYCLE_DELETE', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'customer-merge', entry: 'mergeCustomer', callers: ['pages/customer'], sourceFiles: ['pages/customer/customer.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_CUSTOMER', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'customer-review', entry: 'markDuplicateCustomerReviewed', callers: ['pages/customer'], sourceFiles: ['pages/customer/customer.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_CUSTOMER', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'product-catalog-auto-migration', entry: 'ensureProductCatalog', callers: ['pages/profile'], sourceFiles: ['pages/profile/profile.js'], phase1e1Support: 'AUTO_LEARNING_ONLY', migrationPhase: 'LIFECYCLE_CATALOG', writeBehavior: 'CONDITIONAL_PAGE_REPLACES_BUNDLE' },
  { id: 'product-catalog-manual-save', entry: 'saveManualCatalogItem', callers: ['pages/profile'], sourceFiles: ['pages/profile/profile.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_CATALOG', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'product-catalog-manual-delete', entry: 'removeCatalogItem', callers: ['pages/profile'], sourceFiles: ['pages/profile/profile.js'], phase1e1Support: 'NONE', migrationPhase: 'LIFECYCLE_CATALOG', writeBehavior: 'PAGE_REPLACES_BUNDLE' },
  { id: 'onboarding-meta', entry: 'updateState(meta)', callers: ['pages/onboarding'], sourceFiles: ['pages/onboarding/onboarding.js'], phase1e1Support: 'OUT_OF_SCOPE', migrationPhase: 'STORAGE_COORDINATION', writeBehavior: 'UPDATE_STATE_REPLACES_BUNDLE' }
]);

const LEGACY_BUSINESS_BUNDLE_WRITE_SITES = Object.freeze([
  { sourceFile: 'app.js', callKind: 'initializeState', occurrence: 1, lifecycleIds: ['app-launch-initialize'] },
  { sourceFile: 'pages/pending/pending.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['pending-ignore'] },
  { sourceFile: 'pages/customer/customer.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['customer-merge'] },
  { sourceFile: 'pages/customer/customer.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['customer-review'] },
  { sourceFile: 'pages/onboarding/onboarding.js', callKind: 'updateState', occurrence: 1, lifecycleIds: ['onboarding-meta'] },
  { sourceFile: 'pages/todos/todos.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['todo-complete'] },
  { sourceFile: 'pages/records/records.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['soft-delete'] },
  { sourceFile: 'pages/receivables/receivables.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['direct-payment'] },
  { sourceFile: 'pages/receivables/receivables.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['direct-dunning'] },
  { sourceFile: 'pages/dashboard/dashboard.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['record-formal'] },
  { sourceFile: 'pages/dashboard/dashboard.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['record-pending'] },
  { sourceFile: 'pages/orders/orders.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['order-status'] },
  { sourceFile: 'pages/orders/orders.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['order-delivery'] },
  { sourceFile: 'pages/orders/orders.js', callKind: 'saveState', occurrence: 3, lifecycleIds: ['order-generate-receivable'] },
  { sourceFile: 'pages/finance/finance.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['direct-payment'] },
  { sourceFile: 'pages/finance/finance.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['direct-dunning'] },
  { sourceFile: 'pages/finance/finance.js', callKind: 'saveState', occurrence: 3, lifecycleIds: ['order-generate-receivable'] },
  { sourceFile: 'pages/quotations/quotations.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['quotation-convert'] },
  { sourceFile: 'pages/profile/profile.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['product-catalog-auto-migration'] },
  { sourceFile: 'pages/profile/profile.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['product-catalog-manual-save'] },
  { sourceFile: 'pages/profile/profile.js', callKind: 'saveState', occurrence: 3, lifecycleIds: ['product-catalog-manual-delete'] },
  { sourceFile: 'pages/input/input.js', callKind: 'saveState', occurrence: 1, lifecycleIds: ['record-formal', 'editing-pending-update', 'editing-pending-convert'] },
  { sourceFile: 'pages/input/input.js', callKind: 'saveState', occurrence: 2, lifecycleIds: ['record-pending', 'editing-pending-update'] }
]);

function diffHasChanges(entry = {}) {
  return Boolean((entry.created || []).length
    || (entry.updated || []).length
    || (entry.deleted || []).length
    || entry.orderChanged === true);
}

function classifyEntry(collection, entry) {
  const types = new Set();
  if (!diffHasChanges(entry)) return [];
  if (collection === 'productCatalog') types.add(SHADOW_DIFFERENCE_TYPES.PRODUCT_CATALOG_DIFFERENCE);
  if (['aiParseLogs', 'operationLogs'].includes(collection)) {
    types.add(SHADOW_DIFFERENCE_TYPES.LOGGING_DIFFERENCE);
  }
  if (entry.orderChanged === true) types.add(SHADOW_DIFFERENCE_TYPES.ORDERING_ONLY);
  (entry.updated || []).forEach((update) => {
    (update.changedFields || []).forEach((path) => {
      const last = String(path).split('.').pop().replace(/\[.*$/, '');
      if (RELATION_FIELDS.has(last)) types.add(SHADOW_DIFFERENCE_TYPES.RELATION_DIFFERENCE);
      if (last === 'id') types.add(SHADOW_DIFFERENCE_TYPES.ID_DIFFERENCE);
      if (TIME_FIELD_PATTERN.test(String(path))) types.add(SHADOW_DIFFERENCE_TYPES.TIME_DIFFERENCE);
    });
  });
  if (['customers', 'quotations', 'orders', 'receivables', 'payments', 'todos', 'pendingNotes'].includes(collection)) {
    types.add(SHADOW_DIFFERENCE_TYPES.BUSINESS_DATA_DIFFERENCE);
  } else if (!types.size) {
    types.add(SHADOW_DIFFERENCE_TYPES.LEGACY_HIDDEN_SIDE_EFFECT);
  }
  return Array.from(types).sort();
}

function compareRecordSaveShadowStates(input = {}) {
  const legacyState = normalizeDomainState(input.legacyState || {});
  const sharedState = normalizeDomainState(input.sharedState || {});
  const fullDiff = createStateDiff(legacyState, sharedState);
  const differences = Object.keys(fullDiff.fullDiff).sort().reduce((result, collection) => {
    const entry = fullDiff.fullDiff[collection];
    if (!diffHasChanges(entry)) return result;
    result.push({
      collection,
      types: classifyEntry(collection, entry),
      diff: safeClone(entry)
    });
    return result;
  }, []);
  const equivalent = stableSerialize(legacyState) === stableSerialize(sharedState);
  return {
    schemaVersion: 'record-save-shadow-comparison-v1',
    equivalent,
    businessDifferences: differences.filter((item) => (
      item.types.includes(SHADOW_DIFFERENCE_TYPES.BUSINESS_DATA_DIFFERENCE)
      || item.types.includes(SHADOW_DIFFERENCE_TYPES.RELATION_DIFFERENCE)
    )),
    fullDifferences: differences,
    allowedDifferences: safeClone(input.allowedDifferences || []),
    mismatchOwner: equivalent ? null : String(input.mismatchOwner || 'UNCLASSIFIED'),
    stateDiff: fullDiff
  };
}

module.exports = {
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES,
  LEGACY_PAGE_LIFECYCLE_INVENTORY,
  classifyEntry,
  compareRecordSaveShadowStates,
  diffHasChanges
};
