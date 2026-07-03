const INTENT_DRAFT_LABELS = {
  quotation: '报价草稿',
  order: '订单草稿',
  receivable: '待收款 / 欠款草稿',
  payment: '收款草稿',
  dunning: '催款草稿',
  todo: '待办提醒草稿',
  query: '查询',
  unknown: '待判断'
};

const FIELD_LABELS = {
  intent: '业务类型',
  customerName: '客户称呼',
  phone: '手机号',
  todoTitle: '待办事项',
  productName: '产品/规格',
  quantity: '数量',
  unit: '单位',
  unitPrice: '单价',
  amount: '金额/总价',
  paymentAmount: '本次收款',
  depositAmount: '定金金额',
  remainingAmount: '剩余金额',
  dueDate: '日期',
  quoteDate: '报价日期',
  remark: '备注'
};

const INTERNAL_FIELDS = [
  'customerId',
  'quotationId',
  'orderId',
  'receivableId',
  'spec',
  'paymentMethod',
  'paymentKind',
  'computed_fields',
  'computed_tips',
  'field_sources',
  'field_evidence',
  'field_conflicts',
  'superseded_facts',
  'remark_items',
  'raw_messages',
  'customer_candidates',
  'intent_candidates',
  'ai_fallback',
  'provider',
  'context_policy',
  'history_status',
  'history_warning_text',
  'history_defaulted_fields',
  'history_default_warning_text',
  'suggested_operation'
];

const FIELD_ORDER = [
  'customerName',
  'todoTitle',
  'productName',
  'quantity',
  'unit',
  'unitPrice',
  'amount',
  'depositAmount',
  'paymentAmount',
  'remainingAmount',
  'dueDate',
  'phone',
  'remark',
  'intent',
  'quoteDate'
];

function uniqueFields(fields) {
  return (fields || []).filter((field, index, array) => field && array.indexOf(field) === index);
}

function hasFieldValue(fields, field) {
  return fields && fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function isVisibleField(field) {
  return field && !INTERNAL_FIELDS.includes(field) && Boolean(FIELD_LABELS[field]);
}

function getFieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

function getIntentDraftLabel(intent) {
  return INTENT_DRAFT_LABELS[intent] || INTENT_DRAFT_LABELS.unknown;
}

function getVisibleFields(fields, currentValues = {}) {
  return uniqueFields(fields)
    .filter((field) => isVisibleField(field) && !hasFieldValue(currentValues, field))
    .sort((left, right) => {
      const leftIndex = FIELD_ORDER.includes(left) ? FIELD_ORDER.indexOf(left) : FIELD_ORDER.length;
      const rightIndex = FIELD_ORDER.includes(right) ? FIELD_ORDER.indexOf(right) : FIELD_ORDER.length;
      return leftIndex - rightIndex;
    });
}

function describeFields(fields, currentValues = {}) {
  return getVisibleFields(fields, currentValues)
    .map(getFieldLabel)
    .join('、');
}

function getMissingText(fields, currentValues = {}) {
  const text = describeFields(fields, currentValues);
  return text || '无';
}

function getPendingReasonText(note) {
  if (!note) return '信息还不完整，需要稍后整理';
  const genericReasons = ['信息不完整，需要稍后整理', '用户选择稍后整理'];
  if (note.reason && !genericReasons.includes(note.reason)) return note.reason;
  if (note.guessedIntent === 'order') return '这条订单还缺关键信息，补齐后就能保存。';
  if (note.guessedIntent === 'quotation') return '这条报价还缺关键信息，补齐后就能保存。';
  if (note.guessedIntent === 'receivable') return '这条待收款 / 欠款还缺关键信息，补齐后就能保存。';
  if (note.guessedIntent === 'payment') return '这条收款还需要确认旧账或金额。';
  if (note.guessedIntent === 'todo') return '这条待办提醒还缺提醒日期或事项，补齐后就能保存。';
  return '信息还不完整，需要稍后整理。';
}

module.exports = {
  describeFields,
  getFieldLabel,
  getIntentDraftLabel,
  getMissingText,
  getPendingReasonText,
  getVisibleFields,
  hasFieldValue,
  isVisibleField
};
