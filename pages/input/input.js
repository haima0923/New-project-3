const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('../../utils/constants');
const { findCustomerMatches, getOrderDepositAmount, saveConfirmedDraft, savePendingNote } = require('../../utils/business');
const { parseHybridInput } = require('../../utils/ai-parser');
const { addDays, diffDays, today } = require('../../utils/date');
const { describeFields: describeVisibleFields, getFieldLabel, getVisibleFields } = require('../../utils/display');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const { applyFinalParseSafety } = require('../../utils/parse-safety');
const { getCustomerDisplay, getState, saveState } = require('../../utils/storage');
const {
  analyzeClipboardText,
  buildNoBusinessPasteResult,
  getClipboardDiagnostics,
  getClipboardDisplayText,
  getPasteMeta,
  getSingleMessagePasteTip,
  isSingleMessageClipboard,
  isWechatChatText
} = require('../../utils/clipboard-chat');

const intentOptions = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'unknown'];
const NEW_CUSTOMER_OPTION_ID = '__new_customer__';
const DEFAULT_QUOTATION_FOLLOWUP_DAYS = 2;
const FOLLOWUP_DAY_VALUES = Array.from({ length: 30 }, (_, index) => index + 1);
const FOLLOWUP_DAY_RANGE = FOLLOWUP_DAY_VALUES.map((days) => `${days} 天`);
const intentRange = intentOptions.map((item) => INTENT_LABELS[item]);
const requiredFields = {
  create_quotation: ['customerName', 'productName'],
  create_order: ['customerName', 'productName'],
  update_quotation: ['quotationId'],
  update_order: ['orderId'],
  create_receivable: ['customerName', 'amount'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount'],
  record_payment: ['customerName', 'paymentAmount'],
  record_order_deposit: ['customerName', 'paymentAmount'],
  create_todo: ['todoTitle', 'dueDate'],
  quotation: ['customerName', 'productName'],
  order: ['customerName', 'productName'],
  receivable: ['customerName', 'amount'],
  payment: ['customerName', 'paymentAmount'],
  dunning: ['customerName', 'dueDate'],
  todo: ['todoTitle', 'dueDate'],
  unknown: ['intent']
};
const warningFieldsByOperation = {
  create_quotation: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice'],
  create_order: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'depositAmount', 'paymentAmount'],
  update_quotation: ['quotationId', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  update_order: ['orderId', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  create_receivable: ['customerName', 'amount'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount', 'remainingAmount'],
  record_payment: ['customerName', 'paymentAmount'],
  record_order_deposit: ['customerName', 'paymentAmount', 'depositAmount'],
  create_todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  pending: ['intent'],
  quotation: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice'],
  order: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'depositAmount', 'paymentAmount'],
  receivable: ['customerName', 'amount'],
  payment: ['customerName', 'paymentAmount', 'depositAmount', 'remainingAmount'],
  dunning: ['customerName'],
  todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  unknown: ['intent']
};
const activeReceivableStatuses = ['待收', '部分收款'];
const activeOrderStatuses = ['待生产', '生产中', '待发货', '已发货'];
const resolvedAiFallbackStatuses = ['used'];
const operationByIntent = {
  quotation: 'create_quotation',
  order: 'create_order',
  receivable: 'create_receivable',
  payment: 'record_payment',
  dunning: 'create_todo',
  todo: 'create_todo',
  unknown: 'pending'
};
const operationTitles = {
  create_quotation: '保存为报价',
  create_order: '保存为订单',
  update_quotation: '更新报价',
  update_order: '更新订单',
  create_receivable: '保存为待收款 / 欠款',
  create_receivable_with_payment: '新建待收款并记录本次收款',
  record_payment: '记录收款',
  record_order_deposit: '记录订单定金',
  create_todo: '保存为待办提醒',
  pending: '待整理记录'
};
const fieldLabels = {
  intent: '业务类型',
  customerName: '客户称呼',
  phone: '手机号',
  todoTitle: '待办事项',
  orderId: '匹配订单',
  quotationId: '匹配报价',
  receivableId: '匹配待收款 / 欠款',
  productName: '产品/规格',
  quantity: '数量',
  unit: '单位',
  unitPrice: '单价',
  amount: '金额/总价',
  depositAmount: '定金金额',
  paymentAmount: '本次收款',
  remainingAmount: '剩余金额',
  dueDate: '日期',
  remark: '备注'
};

const sourceButtonConfig = {
  typed: {
    typedClass: 'segment active',
    pasteClass: 'segment',
    voiceClass: 'segment',
    showPaste: false,
    showVoice: false
  },
  paste: {
    typedClass: 'segment',
    pasteClass: 'segment active',
    voiceClass: 'segment',
    showPaste: true,
    showVoice: false
  },
  voice: {
    typedClass: 'segment',
    pasteClass: 'segment',
    voiceClass: 'segment active',
    showPaste: false,
    showVoice: true
  }
};

function hasFieldValue(fields, field) {
  return fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function getMissing(intent, fields, operation) {
  return (requiredFields[operation] || requiredFields[intent] || []).filter((field) => !hasFieldValue(fields, field));
}

function uniqueFields(fields) {
  return (fields || []).filter((field, index, array) => field && array.indexOf(field) === index);
}

function markManualField(parseResult, field) {
  return Object.assign({}, parseResult, {
    manual_fields: uniqueFields([].concat(parseResult.manual_fields || [], field))
  });
}

function getSavedRecordId(saved = {}) {
  const record = saved.record || {};
  return record.id
    || (record.order && record.order.id)
    || (record.receivable && record.receivable.id)
    || (record.payment && record.payment.id)
    || '';
}

function updatePendingNote(state, pendingId, parseResult, reason) {
  const note = (state.pendingNotes || []).find((item) => item.id === pendingId && item.status === '待整理');
  if (!note) return null;
  note.originalText = parseResult.original_text || note.originalText || '';
  note.guessedIntent = parseResult.intent;
  note.guessedFields = parseResult.fields || {};
  note.missingFields = parseResult.missing_fields || [];
  note.lowConfidenceFields = parseResult.low_confidence_fields || [];
  note.fieldConflicts = parseResult.field_conflicts || [];
  note.source = parseResult.source || note.source || 'typed';
  note.reason = reason || note.reason || '信息不完整，需要稍后整理';
  note.updatedAt = new Date().toISOString();
  return note;
}

function markPendingNoteConverted(state, pendingId, saved) {
  if (!pendingId || !saved || saved.type === 'pending') return;
  const note = (state.pendingNotes || []).find((item) => item.id === pendingId && item.status === '待整理');
  if (!note) return;
  note.status = '已转正式记录';
  note.convertedRecordType = saved.type;
  note.convertedRecordId = getSavedRecordId(saved);
  note.updatedAt = new Date().toISOString();
}

function getWarningFields(intent, operation) {
  return warningFieldsByOperation[operation] || warningFieldsByOperation[intent] || requiredFields[operation] || requiredFields[intent] || [];
}

function filterRelevantWarningFields(fields, intent, operation) {
  const allowed = getWarningFields(intent, operation);
  return uniqueFields(fields).filter((field) => allowed.includes(field));
}

function mergeMissing(intent, fields, aiMissingFields, operation) {
  const required = requiredFields[operation] || requiredFields[intent] || [];
  const stillMissing = uniqueFields(aiMissingFields || [])
    .filter((field) => required.includes(field))
    .filter((field) => !hasFieldValue(fields, field));
  return uniqueFields([].concat(stillMissing, getMissing(intent, fields, operation)));
}

function describeFields(fields) {
  return uniqueFields(fields).map((field) => getFieldLabel(field)).join('、');
}

function getFieldFlagMap(fields) {
  return uniqueFields(fields).reduce((map, field) => {
    map[field] = true;
    return map;
  }, {});
}

function getWarningState(missingFields, lowConfidenceFields, currentFields) {
  const missing = getVisibleFields(missingFields, currentFields);
  const low = getVisibleFields(lowConfidenceFields, {});
  return {
    showWarning: Boolean(missing.length || low.length),
    warningMissingText: describeVisibleFields(missing, {}),
    warningLowText: describeVisibleFields(low, {})
  };
}

function getFormalSaveSafetyBlockText(parseResult = {}) {
  const safety = parseResult.local_parse_safety || {};
  const aiFallback = parseResult.ai_fallback || {};
  const aiStatus = aiFallback.status || 'not_requested';
  const hasFinalFieldIssue = Boolean(
    (parseResult.missing_fields || []).length
    || (parseResult.low_confidence_fields || []).length
    || (parseResult.field_conflicts || []).length
  );
  const sourceNeedsAiResult = ['paste', 'voice'].includes(parseResult.source);
  if (safety.status === 'NEEDS_AI' && !resolvedAiFallbackStatuses.includes(aiStatus)) {
    if (!sourceNeedsAiResult && !hasFinalFieldIssue) return '';
    if (aiStatus === 'failed') return 'AI 解析暂不可用，这条先存到待整理更安全。';
    if (aiStatus === 'skipped_no_endpoint') return '这条需要 AI 判断，当前没有可用 AI 结果，先存到待整理。';
    return '这条需要 AI 或人工重点核对，先存到待整理。';
  }
  if (safety.status === 'NO_RECORD') return '没有识别到可直接保存的业务记录。';
  return '';
}

function getMetaText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  return String(item.message || item.text || item.reason || '').trim();
}

function formatFieldConflicts(conflicts) {
  return (conflicts || [])
    .map((item) => {
      if (!item || typeof item !== 'object') return getMetaText(item);
      const label = getFieldLabel(item.field || '');
      const values = Array.isArray(item.values) ? item.values.join('、') : '';
      return item.message || `${label}${values ? `有多个候选：${values}` : '不确定'}，请确认。`;
    })
    .filter(Boolean);
}

function formatSupersededFacts(facts) {
  return (facts || [])
    .map((item) => {
      if (!item || typeof item !== 'object') return getMetaText(item);
      const label = getFieldLabel(item.field || '');
      const oldValue = item.oldValue || item.old_value || item.value || '';
      const newValue = item.newValue || item.new_value || '';
      const reason = item.reason || item.message || '';
      return [label && oldValue ? `${label} ${oldValue}` : oldValue, newValue ? `已改为 ${newValue}` : '', reason].filter(Boolean).join('，');
    })
    .filter(Boolean);
}

function formatRemarkItems(items) {
  return (items || [])
    .map(getMetaText)
    .filter(Boolean);
}

function hasConfirmItemValue(item) {
  return ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'totalAmount', 'itemDeliveryDate', 'itemRemark']
    .some((field) => hasFieldValue(item, field));
}

function normalizeConfirmItem(item = {}) {
  return {
    productName: item.productName || item.product_name || item.name || '',
    spec: item.spec || '',
    quantity: item.quantity || '',
    unit: item.unit || '',
    unitPrice: item.unitPrice || item.unit_price || '',
    totalAmount: item.totalAmount || item.total_amount || item.amount || '',
    itemDeliveryDate: item.itemDeliveryDate || item.deliveryDate || item.dueDate || '',
    itemRemark: item.itemRemark || item.remark || ''
  };
}

function buildItemFromLegacyFields(fields = {}) {
  const item = normalizeConfirmItem({
    productName: fields.productName,
    spec: fields.spec,
    quantity: fields.quantity,
    unit: fields.unit,
    unitPrice: fields.unitPrice,
    totalAmount: fields.totalAmount || fields.amount,
    itemDeliveryDate: fields.itemDeliveryDate,
    itemRemark: fields.itemRemark
  });
  return hasConfirmItemValue(item) ? item : null;
}

function normalizeConfirmItems(fields = {}, options = {}) {
  const sourceItems = Array.isArray(fields.items) ? fields.items : [];
  const items = sourceItems
    .map(normalizeConfirmItem)
    .filter(hasConfirmItemValue);
  if (!items.length) {
    const legacyItem = buildItemFromLegacyFields(fields);
    if (legacyItem) items.push(legacyItem);
  }
  if (!items.length && options.ensureFirst) items.push(normalizeConfirmItem());
  return items;
}

function hasMoneyValue(value) {
  if (!hasFieldValue({ value }, 'value')) return false;
  return Number.isFinite(Number(value));
}

function formatMoneyValue(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function calculateConfirmItemsTotalAmount(items = []) {
  if (!items.length) return '';
  if (!items.every((item) => hasMoneyValue(item.totalAmount))) return '';
  return formatMoneyValue(items.reduce((sum, item) => sum + Number(item.totalAmount), 0));
}

function syncFirstItemToLegacyFields(fields = {}) {
  const next = Object.assign({}, fields);
  const items = normalizeConfirmItems(next, { ensureFirst: true });
  const first = items[0] || {};
  const firstItemTotal = items.length <= 1 ? first.totalAmount : '';
  const totalAmount = calculateConfirmItemsTotalAmount(items) || next.totalAmount || next.amount || firstItemTotal || '';
  next.items = items;
  next.productName = first.productName || '';
  next.spec = first.spec || '';
  next.quantity = first.quantity || '';
  next.unit = first.unit || '';
  next.unitPrice = first.unitPrice || '';
  next.amount = totalAmount;
  next.totalAmount = totalAmount;
  return next;
}

function buildConfirmItemCards(fields = {}, intent) {
  return normalizeConfirmItems(fields, { ensureFirst: true }).map((item, index) => Object.assign({}, item, {
    itemKey: `${index}-${item.productName || 'item'}`,
    indexLabel: `商品${index + 1}`,
    showItemDeliveryDate: intent === 'order' && Boolean(item.itemDeliveryDate)
  }));
}

function formatLocalParseSafety(safety) {
  if (!safety || safety.status === 'SAFE_LOCAL') return [];
  const statusText = {
    NEEDS_AI: '本地规则判断这条需要 AI 解析或人工重点核对。',
    NEEDS_USER_CONFIRM: '本地规则只生成草稿，需要补齐或确认字段。',
    NO_RECORD: '本地规则没有识别到可直接保存的业务记录。'
  }[safety.status] || '本地规则结果需要确认。';
  return uniqueFields([statusText].concat(safety.reason_texts || [])).slice(0, 6);
}

function toMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function formatMoney(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function buildOrderAmountSummary(fields = {}) {
  const totalAmount = fields.totalAmount || fields.amount;
  if (!hasMoneyValue(totalAmount)) return [];
  const depositAmount = hasMoneyValue(fields.depositAmount)
    ? fields.depositAmount
    : (fields.paymentKind === 'deposit' && hasMoneyValue(fields.paymentAmount) ? fields.paymentAmount : '');
  const itemCount = normalizeConfirmItems(fields).length;
  const lines = [{
    label: itemCount > 1 ? '商品合计' : '整单金额',
    value: `${formatMoney(totalAmount)}元`
  }];
  if (hasMoneyValue(depositAmount)) {
    lines.push({
      label: '定金',
      value: `${formatMoney(depositAmount)}元`
    });
    lines.push({
      label: '待收尾款',
      value: `${formatMoney(Math.max(0, toMoney(totalAmount) - toMoney(depositAmount)))}元`
    });
  }
  return lines;
}

function getRemainingAmount(receivable) {
  return Math.max(0, toMoney(receivable.amount) - toMoney(receivable.paidAmount));
}

function includesCustomerName(customer, keyword) {
  if (!customer || !keyword) return false;
  const customerName = String(customer.name || '');
  const source = String(keyword || '');
  return customerName.includes(source)
    || source.includes(customerName)
    || source.includes(customerName.replace(/总$/, ''));
}

function findCustomerForFields(state, fields) {
  const customers = state.customers || [];
  if (fields.customerId) {
    const byId = customers.find((customer) => customer.id === fields.customerId);
    if (byId && (!fields.customerName || includesCustomerName(byId, fields.customerName))) return byId;
  }
  if (!fields.customerName) return null;
  return customers.find((customer) => includesCustomerName(customer, fields.customerName)) || null;
}

function getCustomerNameById(state, customerId) {
  const customer = (state.customers || []).find((item) => item.id === customerId);
  return customer ? customer.name : '';
}

function getCustomerById(state, customerId) {
  return (state.customers || []).find((item) => item.id === customerId && !item.mergedInto);
}

function customerNeedsMatch(operation) {
  return ['create_quotation', 'create_order', 'create_receivable', 'create_receivable_with_payment', 'record_payment', 'record_order_deposit', 'create_todo'].includes(operation);
}

function hasCustomerDiscriminator(fields) {
  return Boolean(fields.phone || fields.company || fields.region || fields.customerNote || fields.wechatRemark);
}

function emptyCustomerMatchState(fields) {
  return {
    fields,
    showCustomerMatchBox: false,
    showCustomerPicker: false,
    showCustomerDisambiguationField: false,
    showCustomerHistoryConfirm: false,
    customerMatchText: '',
    customerMatchWarningText: '',
    customerHistoryTitle: '',
    customerHistoryLines: [],
    customerMatchRange: [],
    customerMatchOptions: [],
    selectedCustomerIndex: -1,
    selectedCustomerLabel: '',
    customerMatchBlocksSave: false
  };
}

function getCustomerBusinessHistory(state, customerId, operation) {
  if (!customerId) return { title: '', lines: [], requiresConfirm: false };
  const quotations = (state.quotations || []).filter((item) => item.customerId === customerId);
  const orders = (state.orders || []).filter((item) => item.customerId === customerId);
  const receivables = (state.receivables || []).filter((item) => item.customerId === customerId && !['已结清', '坏账'].includes(item.status));
  if (operation === 'create_order' && orders.length) {
    return {
      title: `这个客户已有 ${orders.length} 笔订单`,
      lines: orders.slice(0, 3).map((item) => `${item.productName || '未填产品'}，${item.quantity || '-'}${item.unit || ''}，交期 ${item.requiredDeliveryDate || '-'}`),
      requiresConfirm: true
    };
  }
  if (operation === 'create_quotation' && quotations.length) {
    return {
      title: `这个客户已有 ${quotations.length} 条报价`,
      lines: quotations.slice(0, 3).map((item) => `${item.productName || '未填产品'}，报价 ${item.totalAmount || '-'}元，状态 ${item.status || '-'}`),
      requiresConfirm: true
    };
  }
  if (operation === 'create_receivable' && receivables.length) {
    return {
      title: `这个客户已有 ${receivables.length} 笔未结清待收款 / 欠款`,
      lines: receivables.slice(0, 3).map((item) => `待收 ${item.amount || '-'}元，到期 ${item.dueDate || '-'}`),
      requiresConfirm: true
    };
  }
  return { title: '', lines: [], requiresConfirm: false };
}

function withCustomerHistoryState(baseState, state, fields, operation) {
  const nextState = Object.assign({}, baseState);
  if (fields.forceNewCustomer) {
    nextState.showCustomerHistoryConfirm = false;
    nextState.customerHistoryTitle = '';
    nextState.customerHistoryLines = [];
    return nextState;
  }
  const history = getCustomerBusinessHistory(state, fields.customerId, operation);
  if (!history.requiresConfirm) return nextState;
  nextState.customerHistoryTitle = history.title;
  nextState.customerHistoryLines = history.lines;
  if (!fields.customerHistoryConfirmed) {
    nextState.showCustomerHistoryConfirm = true;
    nextState.customerMatchWarningText = `${history.title}。请确认这是新增一笔业务，不是要整理旧记录。`;
    nextState.customerMatchBlocksSave = true;
  }
  return nextState;
}

function buildCustomerMatchState(state, fields, operation) {
  const nextFields = Object.assign({}, fields);
  if (!customerNeedsMatch(operation) || !nextFields.customerName) {
    return emptyCustomerMatchState(nextFields);
  }

  const matches = findCustomerMatches(state, nextFields);
  const selectedCustomer = nextFields.customerId ? getCustomerById(state, nextFields.customerId) : null;
  if (selectedCustomer && nextFields.customerName && !includesCustomerName(selectedCustomer, nextFields.customerName)) {
    delete nextFields.customerId;
  }

  if (matches.length === 1 && !nextFields.forceNewCustomer && !nextFields.customerId) {
    nextFields.customerId = matches[0].id;
  }

  if (matches.length === 1 && !nextFields.forceNewCustomer) {
    return withCustomerHistoryState(Object.assign(emptyCustomerMatchState(nextFields), {
      showCustomerMatchBox: true,
      customerMatchText: `已匹配已有客户：${getCustomerDisplay(matches[0])}`
    }), state, nextFields, operation);
  }

  if (matches.length <= 1 && !nextFields.forceNewCustomer) {
    return emptyCustomerMatchState(nextFields);
  }

  const customerMatchOptions = matches.map((customer, index) => ({
    id: customer.id,
    label: `${getCustomerDisplay(customer)} · 第${index + 1}个`
  })).concat({
    id: NEW_CUSTOMER_OPTION_ID,
    label: `新建另一个${nextFields.customerName}`
  });
  const selectedCustomerIndex = nextFields.forceNewCustomer
    ? customerMatchOptions.length - 1
    : customerMatchOptions.findIndex((option) => option.id === nextFields.customerId);
  const creatingNew = selectedCustomerIndex === customerMatchOptions.length - 1;
  const needsDiscriminator = creatingNew && !hasCustomerDiscriminator(nextFields);
  let customerMatchWarningText = '';
  if (selectedCustomerIndex < 0) {
    customerMatchWarningText = `系统里有多个${nextFields.customerName}，请选择这笔业务关联哪一个客户，或者新建一个客户。`;
  } else if (needsDiscriminator) {
    customerMatchWarningText = '如果这是另一个新客户，请补手机号或客户区分备注，避免以后两个客户看不出来。';
  }

  return withCustomerHistoryState({
    fields: nextFields,
    showCustomerMatchBox: true,
    showCustomerPicker: true,
    showCustomerDisambiguationField: creatingNew,
    showCustomerHistoryConfirm: false,
    customerMatchText: `找到 ${matches.length} 个同名客户，请确认这笔业务属于谁。`,
    customerMatchWarningText,
    customerHistoryTitle: '',
    customerHistoryLines: [],
    customerMatchRange: customerMatchOptions.map((option) => option.label),
    customerMatchOptions,
    selectedCustomerIndex,
    selectedCustomerLabel: selectedCustomerIndex >= 0 ? customerMatchOptions[selectedCustomerIndex].label : '',
    customerMatchBlocksSave: Boolean(customerMatchWarningText)
  }, state, nextFields, operation);
}

function mergePresentFields(base, patch) {
  const merged = Object.assign({}, base);
  Object.keys(patch || {}).forEach((key) => {
    if (hasFieldValue(patch, key)) merged[key] = patch[key];
  });
  return merged;
}

function hydrateQuotationFields(state, fields) {
  if (!fields.quotationId) return null;
  const quotation = (state.quotations || []).find((item) => item.id === fields.quotationId);
  if (!quotation) return null;
  return mergePresentFields({
    quotationId: quotation.id,
    customerId: quotation.customerId,
    customerName: getCustomerNameById(state, quotation.customerId),
    productName: quotation.productName || '',
    spec: quotation.spec || '',
    quantity: quotation.quantity || '',
    unit: quotation.unit || '',
    unitPrice: quotation.unitPrice || '',
    amount: quotation.totalAmount || '',
    followupDays: quotation.followupDays || '',
    dueDate: quotation.deliveryDate || '',
    quoteDate: quotation.quoteDate || '',
    remark: quotation.remark || ''
  }, fields);
}

function hydrateOrderFields(state, fields) {
  if (!fields.orderId) return null;
  const order = (state.orders || []).find((item) => item.id === fields.orderId);
  if (!order) return null;
  return mergePresentFields({
    orderId: order.id,
    quotationId: order.quotationId || '',
    customerId: order.customerId,
    customerName: getCustomerNameById(state, order.customerId),
    productName: order.productName || '',
    spec: order.spec || '',
    quantity: order.quantity || '',
    unit: order.unit || '',
    unitPrice: order.unitPrice || '',
    amount: order.totalAmount || '',
    dueDate: order.requiredDeliveryDate || '',
    remark: order.remark || ''
  }, fields);
}

function normalizeFollowupDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_QUOTATION_FOLLOWUP_DAYS;
  return Math.min(FOLLOWUP_DAY_VALUES[FOLLOWUP_DAY_VALUES.length - 1], Math.max(1, Math.round(number)));
}

function getFollowupDayIndex(value) {
  const days = normalizeFollowupDays(value);
  const index = FOLLOWUP_DAY_VALUES.indexOf(days);
  return index >= 0 ? index : DEFAULT_QUOTATION_FOLLOWUP_DAYS - 1;
}

function ensureQuotationFollowupFields(fields, operation) {
  if (!['create_quotation', 'update_quotation'].includes(operation)) return fields;
  const nextFields = Object.assign({}, fields);
  const hasTypedDays = hasFieldValue(nextFields, 'followupDays');
  if (hasTypedDays) {
    const days = normalizeFollowupDays(nextFields.followupDays);
    nextFields.followupDays = String(days);
    nextFields.dueDate = addDays(today(), days);
    return nextFields;
  }
  if (nextFields.dueDate) {
    const days = diffDays(nextFields.dueDate, today());
    nextFields.followupDays = String(days > 0 ? days : '');
    return nextFields;
  }
  return nextFields;
}

function formatReceivableOption(receivable) {
  return `待收${formatMoney(receivable.amount)}元，剩余${formatMoney(receivable.remainingAmount)}元，到期${receivable.dueDate || '-'}`;
}

function productMatches(inputProduct, orderProduct) {
  const input = String(inputProduct || '').replace(/\s+/g, '');
  const current = String(orderProduct || '').replace(/\s+/g, '');
  if (!input || !current) return true;
  return input === current || input.includes(current) || current.includes(input);
}

function getOrderRemainingSettlement(state, order) {
  return Math.max(0, toMoney(order.totalAmount) - getOrderDepositAmount(state, order.id));
}

function formatOrderOption(state, order) {
  return `${order.productName || '未填产品'}，${order.status || '-'}，交期${order.requiredDeliveryDate || '-'}，待收尾款${formatMoney(getOrderRemainingSettlement(state, order))}元`;
}

function getFieldVisibility(intent, operation, fields = {}) {
  const quoteOrOrder = ['quotation', 'order'].includes(intent);
  const todo = ['todo', 'dunning'].includes(intent);
  const createReceivable = operation === 'create_receivable';
  const recordPayment = operation === 'record_payment';
  const recordOrderDeposit = operation === 'record_order_deposit';
  const quoteOperation = ['create_quotation', 'update_quotation'].includes(operation);
  const editableBusiness = operation !== 'pending' && intent !== 'unknown';
  const todoHasProductInfo = todo && Boolean(fields.productName || fields.quantity || fields.unit || fields.unitPrice || fields.amount);
  return {
    showCustomerFields: editableBusiness,
    showPhoneField: ['create_quotation', 'create_order', 'update_quotation', 'update_order', 'create_receivable', 'create_receivable_with_payment', 'record_payment', 'record_order_deposit'].includes(operation),
    showTodoTitleField: todo,
    showFollowupDaysField: quoteOperation,
    showItemList: quoteOrOrder,
    showProductField: recordOrderDeposit || todoHasProductInfo,
    showQuantityFields: todo && Boolean(fields.quantity || fields.unit),
    showPriceFields: todo && Boolean(fields.unitPrice || fields.amount),
    showAmountField: createReceivable,
    showPaymentAmountField: recordPayment || recordOrderDeposit || (intent === 'order' && Boolean(fields.paymentAmount || fields.depositAmount)),
    showRemainingAmountField: false,
    showDueDateField: ['create_order', 'update_order', 'create_receivable', 'create_todo'].includes(operation),
    showRemarkField: editableBusiness,
    showGenericDraft: !editableBusiness
  };
}

function getGuessedSummary(fields) {
  return Object.keys(fields || {})
    .filter((field) => field !== 'intent' && fields[field] && getFieldLabel(field) !== field)
    .map((field) => `${getFieldLabel(field)}：${fields[field]}`);
}

function normalizePaymentMissing(missingFields, fields, operation) {
  return filterRelevantWarningFields((missingFields || [])
    .map((field) => (field === 'amount' && operation === 'record_payment' ? 'paymentAmount' : field))
    .filter((field) => {
      if (['create_receivable_with_payment', 'record_payment'].includes(operation) && field === 'receivableId') return false;
      return !hasFieldValue(fields, field);
    }), 'payment', operation);
}

function normalizeOrderDepositMissing(missingFields, fields) {
  return filterRelevantWarningFields((missingFields || [])
    .map((field) => (field === 'depositAmount' ? 'paymentAmount' : field))
    .filter((field) => field !== 'orderId' && !hasFieldValue(fields, field)), 'payment', 'record_order_deposit');
}

function buildOrderDepositState(state, fields, aiMissingFields, lowConfidenceFields) {
  const nextFields = Object.assign({}, fields);
  const low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'depositAmount' ? 'paymentAmount' : field))
    .filter((field) => field !== 'orderId');
  if (!hasFieldValue(nextFields, 'paymentAmount') && hasFieldValue(nextFields, 'depositAmount')) {
    nextFields.paymentAmount = nextFields.depositAmount;
  }
  if (!hasFieldValue(nextFields, 'depositAmount') && hasFieldValue(nextFields, 'paymentAmount')) {
    nextFields.depositAmount = nextFields.paymentAmount;
  }

  const customer = findCustomerForFields(state, nextFields);
  if (customer) nextFields.customerId = customer.id;
  const hasReceivableOrderMap = (state.receivables || []).reduce((map, receivable) => {
    if (receivable.orderId) map[receivable.orderId] = true;
    return map;
  }, {});
  const orders = customer
    ? (state.orders || [])
      .filter((item) => item.customerId === customer.id)
      .filter((item) => activeOrderStatuses.includes(item.status))
      .filter((item) => !hasReceivableOrderMap[item.id])
      .filter((item) => productMatches(nextFields.productName, item.productName))
    : [];

  const existingSelected = orders.find((item) => item.id === nextFields.orderId);
  if (!existingSelected && orders.length === 1) nextFields.orderId = orders[0].id;
  const selected = orders.find((item) => item.id === nextFields.orderId) || null;
  const selectedIndex = selected ? orders.findIndex((item) => item.id === selected.id) : -1;
  const orderOptions = orders.map((item) => ({
    id: item.id,
    label: formatOrderOption(state, item)
  }));
  const orderRange = orderOptions.map((item) => item.label);
  const paymentAmount = toMoney(nextFields.paymentAmount);
  const orderDepositPreview = [];
  let orderDepositWarningText = '';

  if (!orders.length) {
    orderDepositWarningText = customer
      ? '没有找到可关联订单，确认后会先保存为未关联订单定金，不会挂错订单。'
      : '请先确认客户；确认后可先保存为未关联订单定金。';
  } else if (!selected) {
    orderDepositWarningText = '这个客户有多笔进行中订单；选择后会挂到该订单，不选择则保存为未关联订单定金。';
  } else {
    const paidBefore = getOrderDepositAmount(state, selected.id);
    const paidAfter = toMoney(paidBefore + paymentAmount);
    const remainingAfter = Math.max(0, toMoney(toMoney(selected.totalAmount) - paidAfter));
    orderDepositPreview.push(`匹配订单：${selected.productName || '未填产品'}，交期${selected.requiredDeliveryDate || '-'}`);
    orderDepositPreview.push(`订单金额：${formatMoney(selected.totalAmount)}元`);
    orderDepositPreview.push(`定金前：已收${formatMoney(paidBefore)}元，待收尾款${formatMoney(getOrderRemainingSettlement(state, selected))}元`);
    orderDepositPreview.push(`本次定金：${formatMoney(paymentAmount)}元`);
    orderDepositPreview.push(`保存后：已收定金${formatMoney(paidAfter)}元，待收尾款${formatMoney(remainingAfter)}元`);
    if (paymentAmount > getOrderRemainingSettlement(state, selected)) {
      low.push('paymentAmount');
      orderDepositWarningText = '本次定金大于订单剩余待结算金额，请确认是否录错。';
    }
  }

  const missing = uniqueFields(normalizeOrderDepositMissing(aiMissingFields, nextFields)
    .concat(getMissing('payment', nextFields, 'record_order_deposit')));

  return {
    fields: nextFields,
    operation: 'record_order_deposit',
    missingFields: missing,
    lowConfidenceFields: uniqueFields(low),
    orderDepositPreview,
    orderDepositWarningText,
    orderOptions,
    orderRange,
    selectedOrderIndex: selectedIndex,
    selectedOrderLabel: selectedIndex >= 0 ? orderRange[selectedIndex] : ''
  };
}

function buildPaymentState(state, fields, aiMissingFields, lowConfidenceFields) {
  const nextFields = Object.assign({}, fields);
  const low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'amount' ? 'paymentAmount' : field))
    .filter((field) => field !== 'receivableId');
  const hadPaymentAmount = hasFieldValue(nextFields, 'paymentAmount');
  if (!hadPaymentAmount && hasFieldValue(nextFields, 'amount')) {
    nextFields.paymentAmount = nextFields.amount;
  }
  const customer = findCustomerForFields(state, nextFields);
  const receivables = customer
    ? (state.receivables || [])
      .filter((item) => item.customerId === customer.id && activeReceivableStatuses.includes(item.status))
      .map((item) => Object.assign({}, item, {
        remainingAmount: getRemainingAmount(item)
      }))
    : [];

  if (customer) {
    nextFields.customerId = customer.id;
  }

  const existingSelected = receivables.find((item) => item.id === nextFields.receivableId);
  if (!existingSelected && receivables.length === 1) {
    nextFields.receivableId = receivables[0].id;
  }

  const selected = receivables.find((item) => item.id === nextFields.receivableId) || null;
  const paymentAmount = toMoney(nextFields.paymentAmount);
  const selectedIndex = selected ? receivables.findIndex((item) => item.id === selected.id) : -1;
  const receivableOptions = receivables.map((item) => ({
    id: item.id,
    label: formatReceivableOption(item)
  }));
  const receivableRange = receivableOptions.map((item) => item.label);
  const paymentPreview = [];
  const newReceivablePreview = [];
  let paymentWarningText = '';
  let newReceivableWarningText = '';
  let operation = 'record_payment';

  if (!receivables.length) {
    delete nextFields.receivableId;
    paymentPreview.push('没有匹配到旧待收款 / 欠款，将保存为未关联收款，不会自动核销或新建欠款。');
    if (paymentAmount > 0) paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
  } else if (!selected) {
    paymentWarningText = '这个客户有多笔未结清待收款 / 欠款；选择后会核销对应记录，不选择则保存为未关联收款。';
  } else {
    const paidBefore = toMoney(selected.paidAmount);
    const remainingBefore = getRemainingAmount(selected);
    const paidAfter = toMoney(paidBefore + paymentAmount);
    const remainingAfter = Math.max(0, toMoney(toMoney(selected.amount) - paidAfter));
    const statusAfter = remainingAfter <= 0 ? '已结清' : '部分收款';
    paymentPreview.push(`匹配待收款：待收${formatMoney(selected.amount)}元，到期${selected.dueDate || '-'}`);
    paymentPreview.push(`收款前：已收${formatMoney(paidBefore)}元，剩余${formatMoney(remainingBefore)}元`);
    paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
    paymentPreview.push(`收款后：已收${formatMoney(paidAfter)}元，剩余${formatMoney(remainingAfter)}元`);
    paymentPreview.push(`保存后状态：${statusAfter}`);

    if (paymentAmount > remainingBefore) {
      low.push('paymentAmount');
      paymentWarningText = '本次收款金额大于当前剩余金额，请确认是否录错。';
    }

    if (nextFields.remainingAmount) {
      const expectedRemaining = toMoney(nextFields.remainingAmount);
      if (Math.abs(expectedRemaining - remainingAfter) > 0.01) {
        low.push('remainingAmount');
        paymentWarningText = `原话说还剩${formatMoney(expectedRemaining)}元，但系统计算保存后剩${formatMoney(remainingAfter)}元。`;
      }
    }
  }

  const missing = uniqueFields(normalizePaymentMissing(aiMissingFields, nextFields, operation)
    .concat(getMissing('payment', nextFields, operation)));

  return {
    fields: nextFields,
    operation,
    missingFields: missing,
    lowConfidenceFields: uniqueFields(low),
    paymentPreview,
    paymentWarningText,
    newReceivablePreview,
    newReceivableWarningText,
    receivableOptions,
    receivableRange,
    selectedReceivableIndex: selectedIndex,
    selectedReceivableLabel: selectedIndex >= 0 ? receivableRange[selectedIndex] : ''
  };
}

function buildConfirmationState(state, parseResult, intent, fields) {
  let operation = operationByIntent[intent] || 'pending';
  let nextFields = Object.assign({}, fields);
  let missingFields = [];
  let lowConfidenceFields = uniqueFields(parseResult.low_confidence_fields || []);
  let paymentState = {
    paymentPreview: [],
    paymentWarningText: '',
    newReceivablePreview: [],
    newReceivableWarningText: '',
    receivableOptions: [],
    receivableRange: [],
    selectedReceivableIndex: -1
  };
  let orderDepositState = {
    orderDepositPreview: [],
    orderDepositWarningText: '',
    orderOptions: [],
    orderRange: [],
    selectedOrderIndex: -1
  };
  let customerMatchState = emptyCustomerMatchState(nextFields);

  if (intent === 'dunning') {
    nextFields.todoType = 'dunning';
    if (!nextFields.todoTitle && nextFields.customerName) nextFields.todoTitle = `催${nextFields.customerName}款`;
  }

  if (intent === 'quotation' && nextFields.quotationId) {
    const hydrated = hydrateQuotationFields(state, nextFields);
    if (hydrated) {
      operation = 'update_quotation';
      nextFields = hydrated;
    } else {
      lowConfidenceFields.push('quotationId');
    }
  }

  nextFields = ensureQuotationFollowupFields(nextFields, operation);

  if (intent === 'order' && nextFields.orderId) {
    const hydrated = hydrateOrderFields(state, nextFields);
    if (hydrated) {
      operation = 'update_order';
      nextFields = hydrated;
    } else {
      lowConfidenceFields.push('orderId');
    }
  }

  if (['quotation', 'order'].includes(intent)) {
    nextFields = syncFirstItemToLegacyFields(nextFields);
  }

  const isOrderDeposit = parseResult.operation === 'record_order_deposit'
    || nextFields.paymentKind === 'deposit'
    || nextFields.depositAmount;

  if (intent === 'payment' && isOrderDeposit) {
    orderDepositState = buildOrderDepositState(state, nextFields, parseResult.missing_fields || [], lowConfidenceFields);
    operation = orderDepositState.operation;
    nextFields = orderDepositState.fields;
    missingFields = orderDepositState.missingFields;
    lowConfidenceFields = orderDepositState.lowConfidenceFields;
  } else if (intent === 'payment') {
    paymentState = buildPaymentState(state, nextFields, parseResult.missing_fields || [], lowConfidenceFields);
    operation = paymentState.operation;
    nextFields = paymentState.fields;
    missingFields = paymentState.missingFields;
    lowConfidenceFields = paymentState.lowConfidenceFields;
  } else {
    missingFields = mergeMissing(intent, nextFields, parseResult.missing_fields || [], operation);
  }

  customerMatchState = buildCustomerMatchState(state, nextFields, operation);
  nextFields = customerMatchState.fields;

  missingFields = getVisibleFields(filterRelevantWarningFields(uniqueFields(missingFields), intent, operation), nextFields);
  lowConfidenceFields = filterRelevantWarningFields(uniqueFields(lowConfidenceFields), intent, operation);

  let visibility = getFieldVisibility(intent, operation, nextFields);
  let normalizedParseResult = Object.assign({}, parseResult, {
    intent,
    fields: nextFields,
    operation,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields
  });
  normalizedParseResult = applyFinalParseSafety(normalizedParseResult);
  nextFields = normalizedParseResult.fields || nextFields;
  customerMatchState = buildCustomerMatchState(state, nextFields, operation);
  nextFields = customerMatchState.fields;
  normalizedParseResult = Object.assign({}, normalizedParseResult, {
    fields: nextFields
  });
  visibility = getFieldVisibility(intent, operation, nextFields);
  missingFields = normalizedParseResult.missing_fields || [];
  lowConfidenceFields = normalizedParseResult.low_confidence_fields || [];
  const warningState = getWarningState(missingFields, lowConfidenceFields, nextFields);
  const fieldConflictLines = formatFieldConflicts(normalizedParseResult.field_conflicts || []);
  const supersededFactLines = formatSupersededFacts(normalizedParseResult.superseded_facts || []);
  const remarkItemLines = formatRemarkItems(normalizedParseResult.remark_items || []);
  const confirmItems = ['quotation', 'order'].includes(intent) ? buildConfirmItemCards(nextFields, intent) : [];
  const orderAmountSummaryLines = intent === 'order' ? buildOrderAmountSummary(nextFields) : [];
  const localParseSafetyLines = formatLocalParseSafety(normalizedParseResult.local_parse_safety);
  const safetyBlockText = getFormalSaveSafetyBlockText(normalizedParseResult);
  const finalWarningState = safetyBlockText
    ? Object.assign({}, warningState, {
      showWarning: true,
      warningLowText: warningState.warningLowText || safetyBlockText
    })
    : warningState;
  const canFormalSave = !missingFields.length
    && !lowConfidenceFields.length
    && !fieldConflictLines.length
    && !customerMatchState.customerMatchBlocksSave
    && !safetyBlockText
    && intent !== 'unknown';
  const historyDefaultedFields = uniqueFields(normalizedParseResult.history_defaulted_fields || []);

  return Object.assign({
    parseResult: normalizedParseResult,
    fields: nextFields,
    confirmItems,
    operation,
    operationTitle: operationTitles[operation],
    amountLabel: operation === 'create_receivable_with_payment' ? '待收总额' : (intent === 'receivable' ? '待收金额' : '金额/总价'),
    paymentAmountLabel: operation === 'record_order_deposit'
      ? '本次定金'
      : (intent === 'order' && (nextFields.depositAmount || nextFields.paymentKind === 'deposit') ? '定金金额' : '本次收款'),
    dueDateLabel: ['todo', 'dunning'].includes(intent) ? '提醒日期' : (['receivable', 'payment'].includes(intent) ? '到期日' : (intent === 'quotation' ? '跟进日期' : '交期')),
    selectedFollowupDayIndex: getFollowupDayIndex(nextFields.followupDays),
    followupWarningText: nextFields.dueDate
      ? `已设置跟进日期：${nextFields.dueDate}。`
      : '跟进日期可选；未填写时不会自动补日期。',
    guessedSummary: getGuessedSummary(nextFields),
    historyWarningText: normalizedParseResult.history_warning_text || '',
    showHistoryWarning: Boolean(normalizedParseResult.history_warning_text),
    historyDefaultWarningText: normalizedParseResult.history_default_warning_text || '',
    showHistoryDefaultWarning: Boolean(normalizedParseResult.history_default_warning_text),
    fieldConflictLines,
    showFieldConflicts: Boolean(fieldConflictLines.length),
    orderAmountSummaryLines,
    showOrderAmountSummary: Boolean(orderAmountSummaryLines.length),
    localParseSafetyLines,
    showLocalParseSafety: Boolean(localParseSafetyLines.length),
    supersededFactLines,
    showSupersededFacts: Boolean(supersededFactLines.length),
    remarkItemLines,
    showRemarkItems: Boolean(remarkItemLines.length),
    historyDefaultFieldMap: getFieldFlagMap(historyDefaultedFields),
    formalButtonText: canFormalSave ? '确认保存' : '补齐后保存',
    disableFormalSave: !canFormalSave,
    showPaymentConfirm: operation === 'record_payment',
    showNewReceivableWithPayment: operation === 'create_receivable_with_payment',
    showReceivablePicker: operation === 'record_payment' && paymentState.receivableOptions.length > 1,
    showOrderDepositConfirm: operation === 'record_order_deposit',
    showOrderPicker: operation === 'record_order_deposit' && orderDepositState.orderOptions.length > 1
  }, visibility, finalWarningState, paymentState, orderDepositState, customerMatchState);
}

function getSourceState(source) {
  const config = sourceButtonConfig[source] || sourceButtonConfig.typed;
  return {
    typedClass: config.typedClass,
    pasteClass: config.pasteClass,
    voiceClass: config.voiceClass,
    showPaste: config.showPaste,
    showVoice: config.showVoice
  };
}

function getEmptyConfirmationData() {
  return {
    text: '',
    parseResult: null,
    fields: {},
    confirmItems: [],
    intent: 'unknown',
    operation: 'pending',
    operationTitle: operationTitles.pending,
    amountLabel: '金额/总价',
    paymentAmountLabel: '本次收款',
    dueDateLabel: '日期',
    intentLabel: INTENT_LABELS.unknown,
    showComputedTips: false,
    showHistoryWarning: false,
    showHistoryDefaultWarning: false,
    showFieldConflicts: false,
    showOrderAmountSummary: false,
    showLocalParseSafety: false,
    showSupersededFacts: false,
    showRemarkItems: false,
    showWarning: false,
    showCustomerFields: false,
    showPhoneField: false,
    showTodoTitleField: false,
    showFollowupDaysField: false,
    showItemList: false,
    showProductField: false,
    showQuantityFields: false,
    showPriceFields: false,
    showAmountField: false,
    showPaymentAmountField: false,
    showRemainingAmountField: false,
    showDueDateField: false,
    showRemarkField: false,
    showGenericDraft: false,
    showPaymentConfirm: false,
    showNewReceivableWithPayment: false,
    showReceivablePicker: false,
    showOrderDepositConfirm: false,
    showOrderPicker: false,
    warningMissingText: '',
    warningLowText: '',
    fieldConflictLines: [],
    orderAmountSummaryLines: [],
    localParseSafetyLines: [],
    supersededFactLines: [],
    remarkItemLines: [],
    historyWarningText: '',
    historyDefaultWarningText: '',
    historyDefaultFieldMap: {},
    followupWarningText: '',
    followupDayRange: FOLLOWUP_DAY_RANGE,
    selectedFollowupDayIndex: DEFAULT_QUOTATION_FOLLOWUP_DAYS - 1,
    formalButtonText: '确认保存',
    disableFormalSave: false,
    guessedSummary: [],
    paymentPreview: [],
    paymentWarningText: '',
    newReceivablePreview: [],
    newReceivableWarningText: '',
    receivableOptions: [],
    receivableRange: [],
    selectedReceivableIndex: -1,
    selectedReceivableLabel: '',
    orderDepositPreview: [],
    orderDepositWarningText: '',
    orderOptions: [],
    orderRange: [],
    selectedOrderIndex: -1,
    selectedOrderLabel: '',
    showCustomerMatchBox: false,
    showCustomerPicker: false,
    showCustomerDisambiguationField: false,
    customerMatchText: '',
    customerMatchWarningText: '',
    customerHistoryTitle: '',
    customerHistoryLines: [],
    showCustomerHistoryConfirm: false,
    customerMatchRange: [],
    customerMatchOptions: [],
    selectedCustomerIndex: -1,
    selectedCustomerLabel: '',
    customerMatchBlocksSave: false,
    pasteAnalysis: null,
    editingPendingId: '',
    computedTips: []
  };
}

function refreshTabBarSelected(page) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.updateSelected === 'function') {
    tabBar.updateSelected();
  }
}

Page({
  data: {
    source: 'typed',
    sourceLabels: INPUT_SOURCE_LABELS,
    text: '',
    parseResult: null,
    fields: {},
    confirmItems: [],
    intent: 'unknown',
    operation: 'pending',
    operationTitle: operationTitles.pending,
    amountLabel: '金额/总价',
    paymentAmountLabel: '本次收款',
    dueDateLabel: '日期',
    intentOptions,
    intentRange,
    intentLabel: INTENT_LABELS.unknown,
    intentLabels: INTENT_LABELS,
    sourceLabel: INPUT_SOURCE_LABELS.typed,
    voiceRecording: false,
    voiceTip: '按住录音，松开后可接入后端语音转文字；当前也可以手动校对文字。',
    voiceButtonClass: 'secondary-button',
    voiceButtonText: '按住说一句',
    parsing: false,
    parseButtonText: '识别成确认卡片',
    parseAssistText: '',
    pasteAnalysis: null,
    editingPendingId: '',
    intentCandidatesText: '',
    typedClass: 'segment active',
    pasteClass: 'segment',
    voiceClass: 'segment',
    showPaste: false,
    showVoice: false,
    showComputedTips: false,
    showHistoryWarning: false,
    showHistoryDefaultWarning: false,
    showOrderAmountSummary: false,
    showWarning: false,
    showCustomerFields: false,
    showPhoneField: false,
    showTodoTitleField: false,
    showFollowupDaysField: false,
    showItemList: false,
    showProductField: false,
    showQuantityFields: false,
    showPriceFields: false,
    showAmountField: false,
    showPaymentAmountField: false,
    showRemainingAmountField: false,
    showDueDateField: false,
    showRemarkField: false,
    showGenericDraft: false,
    showPaymentConfirm: false,
    showNewReceivableWithPayment: false,
    showReceivablePicker: false,
    warningMissingText: '',
    warningLowText: '',
    orderAmountSummaryLines: [],
    historyWarningText: '',
    historyDefaultWarningText: '',
    historyDefaultFieldMap: {},
    followupWarningText: '',
    followupDayRange: FOLLOWUP_DAY_RANGE,
    selectedFollowupDayIndex: DEFAULT_QUOTATION_FOLLOWUP_DAYS - 1,
    formalButtonText: '确认保存',
    disableFormalSave: false,
    guessedSummary: [],
    paymentPreview: [],
    paymentWarningText: '',
    newReceivablePreview: [],
    newReceivableWarningText: '',
    receivableOptions: [],
    receivableRange: [],
    selectedReceivableIndex: -1,
    selectedReceivableLabel: '',
    showCustomerMatchBox: false,
    showCustomerPicker: false,
    showCustomerDisambiguationField: false,
    customerMatchText: '',
    customerMatchWarningText: '',
    customerHistoryTitle: '',
    customerHistoryLines: [],
    showCustomerHistoryConfirm: false,
    customerMatchRange: [],
    customerMatchOptions: [],
    selectedCustomerIndex: -1,
    selectedCustomerLabel: '',
    customerMatchBlocksSave: false,
    computedTips: []
  },

  onLoad(options) {
    if (options.pendingId) {
      this.loadPendingForEdit(options.pendingId);
    }
    this.setupRecorder();
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    const pendingId = wx.getStorageSync('pending_to_edit');
    if (pendingId) {
      wx.removeStorageSync('pending_to_edit');
      this.loadPendingForEdit(pendingId);
      return;
    }
    const forceTextInput = wx.getStorageSync('force_text_input');
    if (forceTextInput) {
      wx.removeStorageSync('force_text_input');
      this.setData(Object.assign(getEmptyConfirmationData(), {
        source: 'typed',
        sourceLabel: INPUT_SOURCE_LABELS.typed,
        parseButtonText: '识别成确认卡片',
        parseAssistText: ''
      }, getSourceState('typed')));
      return;
    }
    const draft = wx.getStorageSync('draft_to_input');
    if (draft && draft.text) {
      wx.removeStorageSync('draft_to_input');
      const source = draft.source || 'typed';
      this.setData(Object.assign(getEmptyConfirmationData(), {
        text: draft.text,
        source,
        sourceLabel: INPUT_SOURCE_LABELS[source] || INPUT_SOURCE_LABELS.typed,
        parseButtonText: '识别成确认卡片',
        parseAssistText: ''
      }, getSourceState(source)));
    }
  },

  loadPendingForEdit(pendingId) {
    const state = getState();
    const note = state.pendingNotes.find((item) => item.id === pendingId);
    if (note) {
      const source = note.source || 'typed';
      this.setData(Object.assign(getEmptyConfirmationData(), {
        text: note.originalText,
        source,
        sourceLabel: INPUT_SOURCE_LABELS[source],
        editingPendingId: pendingId
      }, getSourceState(source)));
    }
  },

  setupRecorder() {
    if (!wx.getRecorderManager) return;
    const recorder = wx.getRecorderManager();
    recorder.onStop((res) => {
      this.setData({
        voiceRecording: false,
        voiceButtonClass: 'secondary-button',
        voiceButtonText: '按住说一句',
        voiceTip: `录音已保存：${res.tempFilePath ? '待语音转文字' : '未获得录音文件'}。请检查下方文字后再识别。`
      });
    });
    recorder.onError(() => {
      this.setData({
        voiceRecording: false,
        voiceButtonClass: 'secondary-button',
        voiceButtonText: '按住说一句',
        voiceTip: '录音失败，可以切换到手动输入或粘贴聊天。'
      });
    });
    this.recorder = recorder;
  },

  setSource(event) {
    const source = event.currentTarget.dataset.source;
    this.setData(Object.assign({
      source,
      sourceLabel: INPUT_SOURCE_LABELS[source],
      parseResult: null
    }, getSourceState(source)));
  },

  onTextInput(event) {
    const text = event.detail.value;
    if (isWechatChatText(text)) {
      const analysis = analyzeClipboardText(text);
      const diagnosticText = getClipboardDiagnostics(analysis);
      this.setData(Object.assign({
        source: 'paste',
        sourceLabel: INPUT_SOURCE_LABELS.paste,
        text,
        pasteAnalysis: analysis,
        parseAssistText: [diagnosticText, analysis.warning].filter(Boolean).join('\n')
      }, getSourceState('paste')));
      return;
    }
    this.setData({ text, pasteAnalysis: null });
  },

  readClipboardToInput(options = {}) {
    const append = Boolean(options.append);
    wx.getClipboardData({
      success: (res) => {
        const analysis = analyzeClipboardText(res.data || '');
        if (!analysis.rawText) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }
        const displayText = getClipboardDisplayText(analysis);
        const currentText = append ? String(this.data.text || '').trim() : '';
        const nextText = currentText && displayText
          ? `${currentText}\n\n${displayText}`
          : displayText;
        const nextAnalysis = append ? analyzeClipboardText(nextText) : analysis;
        const singleMessage = isSingleMessageClipboard(analysis);
        const diagnosticText = getClipboardDiagnostics(nextAnalysis);
        const assistText = singleMessage
          ? `${diagnosticText}\n${getSingleMessagePasteTip()}`
          : [diagnosticText, nextAnalysis.warning].filter(Boolean).join('\n');
        this.setData(Object.assign({
          source: 'paste',
          sourceLabel: INPUT_SOURCE_LABELS.paste,
          text: nextText,
          pasteAnalysis: nextAnalysis,
          parseAssistText: assistText
        }, getSourceState('paste')), () => {
          if (nextAnalysis.status === 'ok') {
            this.runParse();
            return;
          }
          if (singleMessage) {
            wx.showToast({ title: '只读到1条消息', icon: 'none' });
            return;
          }
          this.showNoBusinessPaste(nextAnalysis);
        });
      }
    });
  },

  pasteClipboard() {
    this.readClipboardToInput({ append: false });
  },

  appendClipboard() {
    this.readClipboardToInput({ append: true });
  },

  showNoBusinessPaste(analysis) {
    const parseResult = buildNoBusinessPasteResult(analysis);
    const state = getState();
    const confirmationState = buildConfirmationState(state, parseResult, parseResult.intent, parseResult.fields);
    this.setData(Object.assign({}, confirmationState, {
      source: 'paste',
      sourceLabel: INPUT_SOURCE_LABELS.paste,
      intent: confirmationState.parseResult.intent,
      intentLabel: INTENT_LABELS[confirmationState.parseResult.intent],
      parseAssistText: analysis.warning || '没有识别到可保存的业务内容。',
      intentCandidatesText: '',
      parsing: false,
      parseButtonText: '识别成确认卡片',
      pasteAnalysis: analysis
    }, getSourceState('paste')));
  },

  startVoice() {
    if (!this.recorder) {
      wx.showToast({ title: '当前环境不支持录音', icon: 'none' });
      return;
    }
    this.setData(Object.assign({
      source: 'voice',
      sourceLabel: INPUT_SOURCE_LABELS.voice,
      voiceRecording: true,
      voiceButtonClass: 'danger-button',
      voiceButtonText: '松开结束',
      voiceTip: '正在录音，松开结束。'
    }, getSourceState('voice')));
    this.recorder.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    });
  },

  stopVoice() {
    if (this.recorder && this.data.voiceRecording) {
      this.recorder.stop();
    }
  },

  runParse() {
    let text = this.data.text.trim();
    let pasteAnalysis = null;
    let source = this.data.source;
    if (text && (this.data.source === 'paste' || isWechatChatText(text))) {
      pasteAnalysis = this.data.pasteAnalysis && (
        this.data.pasteAnalysis.rawText === this.data.text
        || this.data.pasteAnalysis.extractedText === this.data.text
      )
        ? this.data.pasteAnalysis
        : analyzeClipboardText(this.data.text);
      if (pasteAnalysis.status !== 'ok') {
        this.showNoBusinessPaste(pasteAnalysis);
        return;
      }
      text = pasteAnalysis.extractedText;
      source = 'paste';
    }
    if (!this.data.text.trim()) {
      wx.showToast({ title: '先输入一句话或粘贴聊天', icon: 'none' });
      return;
    }
    this.setData({
      parsing: true,
      parseButtonText: '正在识别',
      parseAssistText: '正在识别，请稍等。'
    });
    const state = getState();
    const payload = {
      text,
      source,
      context: 'home',
      state
    };
    if (pasteAnalysis) {
      payload.rawText = pasteAnalysis.rawText;
      payload.extractedText = pasteAnalysis.extractedText;
      payload.pasteMeta = getPasteMeta(pasteAnalysis);
    }
    parseHybridInput(payload)
      .then((parseResult) => {
      const confirmationState = buildConfirmationState(state, parseResult, parseResult.intent, parseResult.fields);
      const aiStatus = (parseResult.ai_fallback && parseResult.ai_fallback.status) || 'not_requested';
      const safetyStatus = parseResult.local_parse_safety && parseResult.local_parse_safety.status;
      const aiStatusText = (safetyStatus === 'NEEDS_AI' && ['failed', 'skipped_no_endpoint'].includes(aiStatus))
        ? '这条内容需要 AI 判断最终信息；当前 AI 暂不可用，请重点核对安全提示里的字段，或先存到待整理。'
        : (safetyStatus === 'NEEDS_USER_CONFIRM'
          ? '本地规则已生成草稿，但有字段需要你补齐或确认。'
          : {
        not_requested: '本地高频规则已完成识别。',
        skipped_no_endpoint: '本地规则先完成识别；这类输入以后可接真实 AI 继续增强。',
        mock_used: '已通过测试后端 mock 识别，结果仍需你确认。',
        used: '已调用 AI 解析，结果仍需你确认。',
        failed: 'AI 解析暂不可用，已使用本地规则结果。'
      }[aiStatus]);
      this.setData(Object.assign({}, confirmationState, {
        intent: confirmationState.parseResult.intent,
        intentLabel: INTENT_LABELS[confirmationState.parseResult.intent],
        sourceLabel: INPUT_SOURCE_LABELS[confirmationState.parseResult.source],
        parseAssistText: aiStatusText,
        intentCandidatesText: (confirmationState.parseResult.intent_candidates || [])
          .map((item) => INTENT_LABELS[item] || item)
          .join(' / '),
        parsing: false,
        parseButtonText: '识别成确认卡片',
        showComputedTips: Boolean(confirmationState.parseResult.computed_tips && confirmationState.parseResult.computed_tips.length),
        computedTips: confirmationState.parseResult.computed_tips || []
      }));
      })
      .catch(() => {
      this.setData({
        parsing: false,
        parseButtonText: '识别成确认卡片',
        parseAssistText: ''
      });
      wx.showToast({ title: '识别失败，请稍后再试', icon: 'none' });
      });
  },

  changeIntent(event) {
    const intent = intentOptions[Number(event.detail.value)];
    if (!this.data.parseResult) {
      this.setData({
        intent,
        intentLabel: INTENT_LABELS[intent]
      });
      return;
    }
    const state = getState();
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, intent, this.data.fields);
    this.setData(Object.assign({}, confirmationState, {
      intent,
      intentLabel: INTENT_LABELS[intent]
    }));
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field;
    const patch = {};
    patch[`fields.${field}`] = event.detail.value;
    if (this.data.parseResult) {
      const nextFields = Object.assign({}, this.data.fields, {
        [field]: event.detail.value
      });
      if (['customerName', 'phone'].includes(field)) {
        delete nextFields.customerId;
        delete nextFields.receivableId;
        delete nextFields.orderId;
        delete nextFields.customerHistoryConfirmed;
        if (field === 'customerName') delete nextFields.forceNewCustomer;
      }
      if (field === 'productName') delete nextFields.orderId;
      const baseResult = Object.assign({}, markManualField(this.data.parseResult, field), {
        missing_fields: [],
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      const state = getState();
      Object.assign(patch, buildConfirmationState(state, baseResult, this.data.intent, nextFields));
    }
    this.setData(patch);
  },

  updateItemField(event) {
    if (!this.data.parseResult) return;
    const index = Number(event.currentTarget.dataset.index || 0);
    const field = event.currentTarget.dataset.field;
    const items = normalizeConfirmItems(this.data.fields, { ensureFirst: true });
    if (!items[index] || !field) return;
    items[index] = Object.assign({}, items[index], {
      [field]: event.detail.value
    });
    const fields = syncFirstItemToLegacyFields(Object.assign({}, this.data.fields, {
      items
    }));
    if (field === 'productName') delete fields.orderId;
    const baseResult = Object.assign({}, markManualField(this.data.parseResult, field), {
      missing_fields: [],
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((item) => item !== field)
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  changeFollowupDays(event) {
    if (!this.data.parseResult) return;
    const days = FOLLOWUP_DAY_VALUES[Number(event.detail.value)] || DEFAULT_QUOTATION_FOLLOWUP_DAYS;
    const fields = Object.assign({}, this.data.fields, {
      followupDays: String(days)
    });
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((item) => !['followupDays', 'dueDate'].includes(item))
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  changeDateField(event) {
    const field = event.currentTarget.dataset.field || 'dueDate';
    const value = event.detail.value;
    const patch = {};
    patch[`fields.${field}`] = value;
    if (this.data.parseResult) {
      const nextFields = Object.assign({}, this.data.fields, {
        [field]: value
      });
      const baseResult = Object.assign({}, markManualField(this.data.parseResult, field), {
        missing_fields: [],
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      const state = getState();
      Object.assign(patch, buildConfirmationState(state, baseResult, this.data.intent, nextFields));
    }
    this.setData(patch);
  },

  changeCustomerMatch(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.customerMatchOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = Object.assign({}, this.data.fields);
    if (selected.id === NEW_CUSTOMER_OPTION_ID) {
      delete fields.customerId;
      fields.forceNewCustomer = true;
    } else {
      fields.customerId = selected.id;
      delete fields.forceNewCustomer;
    }
    delete fields.customerHistoryConfirmed;
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  confirmCustomerHistory() {
    if (!this.data.parseResult) return;
    const fields = Object.assign({}, this.data.fields, {
      customerHistoryConfirmed: true
    });
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  createNewCustomerOrder() {
    if (!this.data.parseResult) return;
    const fields = Object.assign({}, this.data.fields);
    delete fields.customerId;
    delete fields.receivableId;
    delete fields.customerHistoryConfirmed;
    fields.forceNewCustomer = true;
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
    wx.showToast({
      title: '建议更换客户称呼，或补手机号/备注来区分客户',
      icon: 'none'
    });
  },

  changeReceivable(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.receivableOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = Object.assign({}, this.data.fields, {
      receivableId: selected.id
    });
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  changeOrderDeposit(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.orderOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = Object.assign({}, this.data.fields, {
      orderId: selected.id
    });
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  returnToInput() {
    if (!this.data.parseResult) return;
    const source = this.data.source || 'typed';
    this.setData(Object.assign(getEmptyConfirmationData(), {
      text: this.data.text,
      source,
      sourceLabel: INPUT_SOURCE_LABELS[source] || INPUT_SOURCE_LABELS.typed,
      editingPendingId: this.data.editingPendingId,
      parseAssistText: '已返回原内容，可修改后重新识别。'
    }, getSourceState(source)));
  },

  saveFormal() {
    if (!this.data.parseResult) return;
    const state = getState();
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, this.data.intent, this.data.fields);
    if (confirmationState.disableFormalSave) {
      const missingText = confirmationState.customerMatchWarningText
        || (confirmationState.showFieldConflicts ? '先确认聊天里的冲突信息' : '')
        || confirmationState.warningMissingText
        || confirmationState.warningLowText
        || '关键信息';
      this.setData(confirmationState);
      wx.showToast({
        title: missingText.startsWith('系统里') || missingText.startsWith('如果这是') || missingText.startsWith('这个客户')
          ? missingText
          : `请先补齐${missingText}`,
        icon: 'none'
      });
      return;
    }
    const result = confirmationState.parseResult;
    const saved = saveConfirmedDraft(state, result);
    if (saved.type === 'pending' && this.data.editingPendingId) {
      const original = updatePendingNote(state, this.data.editingPendingId, result, (saved.record && saved.record.reason) || '信息仍不完整，需要稍后整理');
      if (original && saved.record && saved.record.id && saved.record.id !== original.id) {
        state.pendingNotes = (state.pendingNotes || []).filter((item) => item.id !== saved.record.id);
      }
    } else {
      markPendingNoteConverted(state, this.data.editingPendingId, saved);
    }
    saveState(state);
    wx.showToast({
      title: saved.type === 'pending' ? '已存到待整理' : '已保存',
      icon: 'success'
    });
    this.setData(getEmptyConfirmationData());
  },

  savePending() {
    if (!this.data.parseResult) return;
    const state = getState();
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, this.data.intent, this.data.fields);
    const reason = confirmationState.parseResult.history_warning_text || '用户选择稍后整理';
    const existingPending = updatePendingNote(state, this.data.editingPendingId, confirmationState.parseResult, reason);
    if (!existingPending) savePendingNote(state, confirmationState.parseResult, reason);
    saveState(state);
    wx.showToast({ title: '已存到待整理', icon: 'success' });
    this.setData(getEmptyConfirmationData());
  }
});
