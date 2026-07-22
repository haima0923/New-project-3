const CONFIRMATION_SCHEMA_VERSION = 'record-confirmation-phase1d-v1';

function freezeEnum(values) {
  return Object.freeze(values.reduce((result, value) => {
    result[value] = value;
    return result;
  }, {}));
}

const FIELD_ROLES = freezeEnum([
  'IDENTITY',
  'PRODUCT',
  'QUANTITY',
  'PRICE',
  'AMOUNT',
  'DATE',
  'RELATION',
  'REMARK',
  'SYSTEM'
]);

const FIELD_VISIBILITIES = freezeEnum([
  'MUST_SHOW',
  'RECOMMENDED',
  'OPTIONAL',
  'HIDDEN'
]);

const RISK_LEVELS = freezeEnum([
  'NONE',
  'INFO',
  'WARNING',
  'DANGEROUS',
  'ZERO_TOLERANCE'
]);

const FIELD_SOURCES = freezeEnum([
  'LOCAL',
  'AI',
  'HISTORY',
  'USER',
  'DERIVED',
  'DEFAULT',
  'UNKNOWN'
]);

const SURFACE_TYPES = freezeEnum([
  'FULL_PAGE',
  'HOME_QUICK',
  'HEADLESS_TEST',
  'CUSTOM',
  'UNKNOWN'
]);

const CONFIRMATION_STATUSES = freezeEnum([
  'READY_FORMAL',
  'PENDING_ONLY',
  'BLOCKED',
  'NO_RESULT'
]);

const ACTION_TYPES = freezeEnum([
  'SAVE_FORMAL',
  'SAVE_PENDING',
  'OPEN_FULL_PAGE',
  'RUN_DEEP_REVIEW',
  'EDIT_FIELDS',
  'SELECT_CUSTOMER',
  'SELECT_ORDER',
  'SELECT_QUOTATION',
  'SELECT_RECEIVABLE',
  'CONFIRM_CUSTOMER_HISTORY',
  'CHANGE_BUSINESS_TYPE',
  'CANCEL'
]);

const SURFACE_CAPABILITY_NAMES = freezeEnum([
  'EDIT_BASIC_FIELDS',
  'EDIT_ALL_FIELDS',
  'EDIT_ITEMS',
  'SELECT_CUSTOMER',
  'SELECT_ORDER',
  'SELECT_QUOTATION',
  'SELECT_RECEIVABLE',
  'RUN_DEEP_REVIEW',
  'CHANGE_BUSINESS_TYPE',
  'SHOW_ORIGINAL_TEXT',
  'HANDLE_COMPLEX_CONFIRMATION',
  'COMMIT_FORMAL',
  'COMMIT_PENDING'
]);

const capabilityPropertyByName = Object.freeze({
  EDIT_BASIC_FIELDS: 'canEditBasicFields',
  EDIT_ALL_FIELDS: 'canEditAllFields',
  EDIT_ITEMS: 'canEditItems',
  SELECT_CUSTOMER: 'canSelectCustomer',
  SELECT_ORDER: 'canSelectOrder',
  SELECT_QUOTATION: 'canSelectQuotation',
  SELECT_RECEIVABLE: 'canSelectReceivable',
  RUN_DEEP_REVIEW: 'canRunDeepReview',
  CHANGE_BUSINESS_TYPE: 'canChangeBusinessType',
  SHOW_ORIGINAL_TEXT: 'canShowOriginalText',
  HANDLE_COMPLEX_CONFIRMATION: 'canHandleComplexConfirmation',
  COMMIT_FORMAL: 'canCommitFormal',
  COMMIT_PENDING: 'canCommitPending'
});

const capabilityProperties = Object.freeze(Object.values(capabilityPropertyByName));

function makeSurfaceCapabilities(surfaceType, enabled = {}) {
  const result = { surfaceType };
  capabilityProperties.forEach((property) => {
    result[property] = enabled[property] === true;
  });
  return Object.freeze(result);
}

const FULL_PAGE_CAPABILITIES = makeSurfaceCapabilities(SURFACE_TYPES.FULL_PAGE, {
  canEditBasicFields: true,
  canEditAllFields: true,
  canEditItems: true,
  canSelectCustomer: true,
  canSelectOrder: true,
  canSelectQuotation: true,
  canSelectReceivable: true,
  canRunDeepReview: true,
  canChangeBusinessType: true,
  canShowOriginalText: true,
  canHandleComplexConfirmation: true,
  canCommitFormal: true,
  canCommitPending: true
});

const HOME_QUICK_CAPABILITIES = makeSurfaceCapabilities(SURFACE_TYPES.HOME_QUICK, {
  canEditBasicFields: true,
  canRunDeepReview: true,
  canShowOriginalText: true,
  canCommitFormal: true,
  canCommitPending: true
});

const HEADLESS_TEST_CAPABILITIES = makeSurfaceCapabilities(SURFACE_TYPES.HEADLESS_TEST, {
  canEditBasicFields: true,
  canEditAllFields: true,
  canEditItems: true,
  canSelectCustomer: true,
  canSelectOrder: true,
  canSelectQuotation: true,
  canSelectReceivable: true,
  canRunDeepReview: true,
  canChangeBusinessType: true,
  canShowOriginalText: true,
  canHandleComplexConfirmation: true,
  canCommitFormal: true,
  canCommitPending: true
});

const emptyCapabilities = makeSurfaceCapabilities(SURFACE_TYPES.CUSTOM, {});

const surfacePresets = Object.freeze({
  [SURFACE_TYPES.FULL_PAGE]: FULL_PAGE_CAPABILITIES,
  [SURFACE_TYPES.HOME_QUICK]: HOME_QUICK_CAPABILITIES,
  [SURFACE_TYPES.HEADLESS_TEST]: HEADLESS_TEST_CAPABILITIES
});

function cloneSurfaceCapabilities(value) {
  const result = { surfaceType: value.surfaceType };
  capabilityProperties.forEach((property) => {
    result[property] = value[property] === true;
  });
  return result;
}

function normalizeSurfaceCapabilities(value) {
  if (value === undefined || value === null || value === '') {
    return cloneSurfaceCapabilities(HEADLESS_TEST_CAPABILITIES);
  }
  if (typeof value === 'string') {
    const normalized = String(value).trim().toUpperCase();
    return cloneSurfaceCapabilities(surfacePresets[normalized] || emptyCapabilities);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return cloneSurfaceCapabilities(emptyCapabilities);
  }
  const requestedType = String(value.surfaceType || value.preset || SURFACE_TYPES.CUSTOM).trim().toUpperCase();
  const base = surfacePresets[requestedType] || emptyCapabilities;
  const result = cloneSurfaceCapabilities(base);
  result.surfaceType = surfacePresets[requestedType] ? requestedType : SURFACE_TYPES.CUSTOM;
  capabilityProperties.forEach((property) => {
    if (Object.prototype.hasOwnProperty.call(value, property)) result[property] = value[property] === true;
  });
  return result;
}

function hasSurfaceCapability(capabilities, capabilityName) {
  const property = capabilityPropertyByName[capabilityName];
  return Boolean(property && capabilities && capabilities[property] === true);
}

const FIELD_CATALOG = Object.freeze({
  businessType: { label: '业务类型', role: FIELD_ROLES.SYSTEM },
  originalText: { label: '原始内容', role: FIELD_ROLES.SYSTEM },
  customerName: { label: '客户称呼', role: FIELD_ROLES.IDENTITY },
  phone: { label: '手机号', role: FIELD_ROLES.IDENTITY },
  customerId: { label: '关联客户', role: FIELD_ROLES.RELATION },
  todoTitle: { label: '提醒事项', role: FIELD_ROLES.REMARK },
  productName: { label: '商品名称', role: FIELD_ROLES.PRODUCT },
  spec: { label: '规格', role: FIELD_ROLES.PRODUCT },
  quantity: { label: '数量', role: FIELD_ROLES.QUANTITY },
  unit: { label: '单位', role: FIELD_ROLES.QUANTITY },
  unitPrice: { label: '单价', role: FIELD_ROLES.PRICE },
  priceUnit: { label: '计价单位', role: FIELD_ROLES.PRICE },
  totalAmount: { label: '总金额', role: FIELD_ROLES.AMOUNT },
  receivableAmount: { label: '待收金额', role: FIELD_ROLES.AMOUNT },
  paymentAmount: { label: '本次收款', role: FIELD_ROLES.AMOUNT },
  depositAmount: { label: '定金金额', role: FIELD_ROLES.AMOUNT },
  remainingAmount: { label: '剩余待收', role: FIELD_ROLES.AMOUNT },
  quoteFollowupDate: { label: '跟进日期', role: FIELD_ROLES.DATE },
  orderDeliveryDate: { label: '交期', role: FIELD_ROLES.DATE },
  receivableDueDate: { label: '预计收款日期', role: FIELD_ROLES.DATE },
  paymentDate: { label: '收款日期', role: FIELD_ROLES.DATE },
  todoRemindDate: { label: '提醒日期', role: FIELD_ROLES.DATE },
  itemDeliveryDate: { label: '商品交期', role: FIELD_ROLES.DATE },
  itemRemark: { label: '商品备注', role: FIELD_ROLES.REMARK },
  quotationId: { label: '关联报价', role: FIELD_ROLES.RELATION },
  orderId: { label: '关联订单', role: FIELD_ROLES.RELATION },
  receivableId: { label: '关联待收款', role: FIELD_ROLES.RELATION },
  remark: { label: '备注', role: FIELD_ROLES.REMARK }
});

function freezePolicy(policy) {
  return Object.freeze({
    required: Object.freeze((policy.required || []).slice()),
    requiredAnyOf: Object.freeze((policy.requiredAnyOf || []).map((group) => Object.freeze(group.slice()))),
    recommended: Object.freeze((policy.recommended || []).slice()),
    optional: Object.freeze((policy.optional || []).slice())
  });
}

// Confirmation display policy follows docs/RECORD_CONFIRM_CARD_SPEC.md. It is
// not a second save gate: actual missing/low/conflict facts still come from the
// parser and final safety result.
const BUSINESS_FIELD_POLICIES = Object.freeze({
  quotation: freezePolicy({
    required: ['customerName', 'productName'],
    recommended: ['quantity', 'unitPrice', 'totalAmount', 'quoteFollowupDate'],
    optional: ['phone', 'spec', 'unit', 'remark', 'quotationId']
  }),
  order: freezePolicy({
    required: ['customerName', 'productName'],
    recommended: ['quantity', 'unitPrice', 'totalAmount', 'orderDeliveryDate', 'depositAmount'],
    optional: ['phone', 'spec', 'unit', 'remark', 'quotationId', 'orderId']
  }),
  receivable: freezePolicy({
    required: ['customerName', 'receivableAmount'],
    recommended: ['receivableDueDate'],
    optional: ['phone', 'orderId', 'remark']
  }),
  payment: freezePolicy({
    required: ['customerName', 'paymentAmount'],
    optional: ['phone', 'receivableId', 'paymentDate', 'remainingAmount', 'remark']
  }),
  order_deposit: freezePolicy({
    required: ['customerName', 'depositAmount'],
    optional: ['productName', 'orderId', 'remark']
  }),
  todo: freezePolicy({
    required: ['todoTitle', 'todoRemindDate'],
    recommended: ['customerName', 'productName'],
    optional: ['quantity', 'unit', 'totalAmount', 'remark']
  }),
  dunning: freezePolicy({
    required: ['todoRemindDate'],
    requiredAnyOf: [['todoTitle', 'customerName']],
    optional: ['receivableId', 'receivableAmount', 'remark']
  }),
  pending: freezePolicy({ required: ['originalText'] })
});

// Existing full-page confirmation falls back from intent to these create
// operations when the parser only emits an intent for a new record. Keeping the
// mapping here gives the domain model one platform-neutral compatibility rule.
const DEFAULT_OPERATION_BY_INTENT = Object.freeze({
  quotation: 'create_quotation',
  order: 'create_order',
  receivable: 'create_receivable',
  payment: 'record_payment',
  dunning: 'create_todo',
  todo: 'create_todo',
  unknown: 'pending'
});

function resolveConfirmationOperation(result = {}) {
  return result.operation || DEFAULT_OPERATION_BY_INTENT[result.intent] || 'pending';
}

function getConfirmationFieldPolicy(businessType, todoType) {
  if (businessType === 'todo' && todoType === 'dunning') return BUSINESS_FIELD_POLICIES.dunning;
  return BUSINESS_FIELD_POLICIES[businessType] || BUSINESS_FIELD_POLICIES.pending;
}

module.exports = {
  ACTION_TYPES,
  BUSINESS_FIELD_POLICIES,
  CONFIRMATION_SCHEMA_VERSION,
  CONFIRMATION_STATUSES,
  DEFAULT_OPERATION_BY_INTENT,
  FIELD_CATALOG,
  FIELD_ROLES,
  FIELD_SOURCES,
  FIELD_VISIBILITIES,
  FULL_PAGE_CAPABILITIES,
  HEADLESS_TEST_CAPABILITIES,
  HOME_QUICK_CAPABILITIES,
  RISK_LEVELS,
  SURFACE_CAPABILITY_NAMES,
  SURFACE_TYPES,
  capabilityPropertyByName,
  getConfirmationFieldPolicy,
  hasSurfaceCapability,
  normalizeSurfaceCapabilities,
  resolveConfirmationOperation
};
