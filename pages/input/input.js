const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('../../utils/constants');
const { buildOrderEditDraft, findCustomerMatches, getItemsSummary, getOrderDepositAmount, getRecordItems, saveConfirmedDraft, savePendingNote } = require('../../utils/business');
const { parseHybridInput } = require('../../utils/ai-parser');
const { prewarmAiAuth } = require('../../utils/api-client');
const { buildParseEvidence } = require('../../utils/parse-evidence');
const { addDays, diffDays, today } = require('../../utils/date');
const { describeFields: describeVisibleFields, getFieldLabel, getVisibleFields } = require('../../utils/display');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const { applyFinalParseSafety } = require('../../utils/parse-safety');
const { evaluateRecordDomainPreflight, getCustomerNameMatchKind, getTrustedRecordFlowContext } = require('../../utils/record-domain-preflight');
const { getCatalogCheck, getProductSuggestions, getSpecSuggestions } = require('../../utils/product-catalog');
const { getCustomerDisplay, getState, saveState } = require('../../utils/storage');
const { startVoiceRecognition, stopVoiceRecognition } = require('../../utils/voice-recognition');
const { normalizeUnit, unitsMatch } = require('../../utils/units');
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
const UNLINKED_RECEIVABLE_OPTION_ID = '__unlinked_receivable__';
const UNLINKED_ORDER_OPTION_ID = '__unlinked_order__';
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
  create_quotation: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'],
  create_order: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'depositAmount', 'paymentAmount'],
  update_quotation: ['quotationId', 'customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'dueDate'],
  update_order: ['orderId', 'customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'dueDate'],
  create_receivable: ['customerName', 'amount'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount', 'remainingAmount'],
  record_payment: ['customerName', 'receivableId', 'paymentAmount'],
  record_order_deposit: ['customerName', 'orderId', 'paymentAmount', 'depositAmount'],
  create_todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  pending: ['intent'],
  quotation: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'],
  order: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'depositAmount', 'paymentAmount'],
  receivable: ['customerName', 'amount'],
  payment: ['customerName', 'paymentAmount', 'depositAmount', 'remainingAmount'],
  dunning: ['customerName'],
  todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  unknown: ['intent']
};
const activeReceivableStatuses = ['待收', '部分收款'];
const activeOrderStatuses = ['待生产', '生产中', '待发货', '已发货'];
function hasResolvedAiFallback(parseResult = {}) {
  const aiFallback = parseResult.ai_fallback || {};
  return aiFallback.status === 'used' && aiFallback.business_result_valid === true;
}
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
  const route = parseResult.parse_route || {};
  if (route.deep_review_available) return '这条内容需要深度核对；未核对前不能直接保存。';
  if ((safety.status === 'NEEDS_AI' || ['ai_standard', 'ai_deep'].includes(route.decision))
    && !hasResolvedAiFallback(parseResult)) {
    if (aiStatus === 'timed_out') return '智能核对等待超时，这条先放待整理。';
    if (aiStatus === 'returned_uncertain') return '智能核对没有给出可采用的业务结果，这条先放待整理。';
    if (aiStatus === 'failed') return '智能快速核对没有完成，这条先放待整理。';
    if (aiStatus === 'skipped_no_endpoint') return '这条信息需要你多看一眼，确认后再保存。';
    return '这条信息有几处需要你确认，拿不准可以先放待整理。';
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
  return ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'itemDeliveryDate', 'itemRemark']
    .some((field) => hasFieldValue(item, field));
}

function normalizeConfirmItem(item = {}) {
  return {
    productName: item.productName || item.product_name || item.name || '',
    spec: item.spec || '',
    quantity: item.quantity || '',
    unit: normalizeUnit(item.unit || ''),
    unitPrice: item.unitPrice || item.unit_price || '',
    priceUnit: normalizeUnit(item.priceUnit || item.price_unit || item.unitPriceUnit || item.unit_price_unit || ''),
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
    priceUnit: fields.priceUnit,
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

function syncFirstItemToLegacyFields(fields = {}, options = {}) {
  const next = Object.assign({}, fields);
  const items = normalizeConfirmItems(next, { ensureFirst: true });
  const first = items[0] || {};
  const firstItemTotal = items.length <= 1 ? first.totalAmount : '';
  const calculatedAmount = calculateConfirmItemsTotalAmount(items) || firstItemTotal || '';
  // 老板原话里明确说出的总价，或者在确认卡里亲手改过的金额，优先级必须
  // 高于“数量 × 单价”的机器计算值。计算值只作为核对依据，不能在确认页
  // 悄悄把“总价 90”重新覆盖成 100。
  const preserveConfirmedAmount = hasFieldValue(next, 'statedAmount') || options.preserveConfirmedAmount === true;
  const confirmedAmount = preserveConfirmedAmount
    ? (next.amount || next.totalAmount || next.statedAmount || calculatedAmount || '')
    : (calculatedAmount || next.amount || next.totalAmount || '');
  next.items = items;
  next.productName = first.productName || '';
  next.spec = first.spec || '';
  next.quantity = first.quantity || '';
  next.unit = first.unit || '';
  next.unitPrice = first.unitPrice || '';
  next.priceUnit = first.priceUnit || '';
  next.calculatedAmount = calculatedAmount || next.calculatedAmount || '';
  next.amount = confirmedAmount;
  next.totalAmount = confirmedAmount;
  return next;
}

function buildConfirmItemCards(fields = {}, intent, state = {}) {
  const items = normalizeConfirmItems(fields, { ensureFirst: true });
  return items.map((item, index) => {
    const check = getCatalogCheck(state, item.productName, item.spec);
    const productSuggestions = check.item || item.productName
      ? []
      : getProductSuggestions(state, '', 6);
    const specSuggestions = check.item
      ? getSpecSuggestions(state, item.productName, '', 8)
      : [];
    return Object.assign({}, item, {
      itemKey: `${index}-${item.productName || 'item'}`,
      indexLabel: `商品${index + 1}`,
      canRemove: items.length > 1,
      showItemDeliveryDate: intent === 'order' && Boolean(item.itemDeliveryDate),
      catalogHint: check.hint,
      catalogHintClass: ['known_product', 'known_spec'].includes(check.status) ? 'catalog-check-known' : 'catalog-check-new',
      productSuggestions,
      showProductCatalogSuggestions: productSuggestions.length > 0,
      specSuggestions,
      showSpecCatalogSuggestions: specSuggestions.length > 0
    });
  });
}

function formatLocalParseSafety(safety) {
  if (!safety || safety.status === 'SAFE_LOCAL') return [];
  const statusText = {
    NEEDS_AI: '这条信息比较复杂，请重点核对下面内容。',
    NEEDS_USER_CONFIRM: '有些信息还需要你补齐或确认。',
    NO_RECORD: '暂时没有整理成可直接保存的记录。'
  }[safety.status] || '这条记录需要你确认。';
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
      lines: orders.slice(0, 3).map((item) => `${getItemsSummary(item) || '未填产品'}，交期 ${item.requiredDeliveryDate || '-'}`),
      requiresConfirm: true
    };
  }
  if (operation === 'create_quotation' && quotations.length) {
    return {
      title: `这个客户已有 ${quotations.length} 条报价`,
      lines: quotations.slice(0, 3).map((item) => `${getItemsSummary(item) || '未填产品'}，报价 ${item.totalAmount || '-'}元，状态 ${item.status || '-'}`),
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
    nextState.showCustomerHistoryConfirm = false;
    nextState.customerMatchWarningText = `${history.title}。当前内容会按新增业务保存；若原话指旧记录，请改为选择旧记录。`;
    // 单纯存在历史业务不是保存风险；更新或历史指代由统一领域预检判断。
    nextState.customerMatchBlocksSave = false;
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
  const uniqueMatchKind = matches.length === 1
    ? getCustomerNameMatchKind(matches[0], nextFields.customerName)
    : 'NONE';
  if (selectedCustomer && nextFields.customerName && !includesCustomerName(selectedCustomer, nextFields.customerName)) {
    delete nextFields.customerId;
  }

  if (matches.length === 1 && uniqueMatchKind === 'EXACT'
    && !nextFields.forceNewCustomer && !nextFields.customerId) {
    nextFields.customerId = matches[0].id;
  }

  if (matches.length === 1 && !nextFields.forceNewCustomer
    && (uniqueMatchKind === 'EXACT' || nextFields.customerSelectionConfirmed === true)) {
    return withCustomerHistoryState(Object.assign(emptyCustomerMatchState(nextFields), {
      showCustomerMatchBox: true,
      customerMatchText: `已匹配已有客户：${getCustomerDisplay(matches[0])}`
    }), state, nextFields, operation);
  }

  if (matches.length === 0 && !nextFields.forceNewCustomer) {
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
    customerMatchText: matches.length === 1
      ? `找到称呼相近的客户：${getCustomerDisplay(matches[0])}，请确认是否为同一人。`
      : `找到 ${matches.length} 个同名或近似客户，请确认这笔业务属于谁。`,
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
    priceUnit: quotation.priceUnit || '',
    items: getRecordItems(quotation),
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
    priceUnit: order.priceUnit || '',
    items: getRecordItems(order),
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
  const receivable = (state.receivables || []).find((item) => item.orderId === order.id);
  if (receivable) {
    return Math.max(0, toMoney(receivable.amount) - toMoney(receivable.paidAmount));
  }
  return Math.max(0, toMoney(order.totalAmount) - getOrderDepositAmount(state, order.id));
}

function formatOrderOption(state, order) {
  return `${order.productName || '未填产品'}，${order.status || '-'}，交期${order.requiredDeliveryDate || '-'}，待收尾款${formatMoney(getOrderRemainingSettlement(state, order))}元`;
}

function emptyGenericOrderSelectionState(fields) {
  return {
    fields,
    orderCandidates: [],
    orderOptions: [],
    orderRange: [],
    selectedOrderId: fields.orderId || '',
    selectedOrder: null,
    selectedOrderIndex: -1,
    selectedOrderLabel: '',
    orderSelectionRequired: false,
    orderSelectionReason: '',
    orderSelectionBaseFields: null,
    showGenericOrderSelection: false,
    showGenericOrderPicker: false
  };
}

function buildOrderCandidateProjection(state, order) {
  const items = getRecordItems(order);
  return {
    id: order.id,
    orderId: order.id,
    customerId: order.customerId,
    customerDisplayName: getCustomerNameById(state, order.customerId) || '未命名客户',
    productSummary: getItemsSummary(order) || order.productName || '未填产品',
    itemCount: items.length || (order.productName ? 1 : 0),
    orderAmount: order.totalAmount || '',
    status: order.status || '',
    dueDate: order.requiredDeliveryDate || '',
    createdAt: order.createdAt || ''
  };
}

function buildGenericOrderSelectionState(state, fields, operation, domainPreflight) {
  const nextFields = Object.assign({}, fields);
  if (operation === 'record_order_deposit') return emptyGenericOrderSelectionState(nextFields);

  const preflightCandidates = (((domainPreflight || {}).candidates || {}).orderCandidates || []);
  const allowedIds = new Set(preflightCandidates.map((item) => String(item.id || '')).filter(Boolean));
  const orderCandidates = (state.orders || [])
    .filter((order) => allowedIds.has(String(order.id || '')))
    .filter((order) => activeOrderStatuses.includes(order.status))
    .map((order) => buildOrderCandidateProjection(state, order));
  const selectedOrderId = String(nextFields.orderId || '');
  const selectedOrder = orderCandidates.find((item) => item.id === selectedOrderId) || null;
  const requiredSelections = (domainPreflight && domainPreflight.requiredSelections) || [];
  const blockingIssues = (domainPreflight && domainPreflight.blockingIssues) || [];
  const orderSelectionRequired = requiredSelections.includes('orderId');
  const orderActionRequired = blockingIssues.some((item) => item.requiredAction === 'SELECT_ORDER');
  const operationSupportsOptionalOrder = ['create_receivable', 'create_receivable_with_payment'].includes(operation);
  const showGenericOrderSelection = orderSelectionRequired
    || orderActionRequired
    || Boolean(selectedOrderId)
    || (operationSupportsOptionalOrder && orderCandidates.length > 0);
  let orderSelectionReason = '';
  if (orderSelectionRequired) {
    orderSelectionReason = orderCandidates.length > 1
      ? '找到多笔可关联订单，请选择原话指的是哪一单。'
      : '请确认这笔业务关联哪一张订单。';
  } else if (orderActionRequired) {
    orderSelectionReason = '当前订单关系不安全，请重新选择同一客户的有效订单。';
  } else if (operationSupportsOptionalOrder) {
    orderSelectionReason = '如果这笔待收属于已有订单，可以在这里关联；不关联不会自动猜订单。';
  }
  if (showGenericOrderSelection && !orderCandidates.length) {
    orderSelectionReason = '没有找到可选择的同客户有效订单，当前不能完成订单关联。';
  }
  const orderOptions = orderCandidates.map((item) => ({
    id: item.id,
    label: `${item.customerDisplayName} · ${item.productSummary} · ${item.status || '-'} · 交期${item.dueDate || '-'}`
  }));
  const selectedOrderIndex = orderOptions.findIndex((item) => item.id === selectedOrderId);

  return {
    fields: nextFields,
    orderCandidates,
    orderOptions,
    orderRange: orderOptions.map((item) => item.label),
    selectedOrderId,
    selectedOrder,
    selectedOrderIndex,
    selectedOrderLabel: selectedOrderIndex >= 0 ? orderOptions[selectedOrderIndex].label : '',
    orderSelectionRequired,
    orderSelectionReason,
    orderSelectionBaseFields: null,
    showGenericOrderSelection,
    showGenericOrderPicker: orderOptions.length > 0
  };
}

function copyOrderSelectionBaseFields(fields) {
  const base = Object.assign({}, fields);
  if (Array.isArray(fields.items)) {
    base.items = fields.items.map((item) => Object.assign({}, item));
  }
  delete base.orderId;
  delete base.orderSelectionConfirmed;
  return base;
}

function retainOrderCandidateChoices(state, confirmationState, priorCandidates, selectedId) {
  const currentCustomerId = String((confirmationState.fields || {}).customerId || '');
  const retained = (priorCandidates || [])
    .map((candidate) => (state.orders || []).find((order) => order.id === candidate.id))
    .filter(Boolean)
    .filter((order) => activeOrderStatuses.includes(order.status))
    .filter((order) => !currentCustomerId || order.customerId === currentCustomerId)
    .map((order) => buildOrderCandidateProjection(state, order));
  if (!retained.length) return confirmationState;
  const orderOptions = retained.map((item) => ({
    id: item.id,
    label: `${item.customerDisplayName} · ${item.productSummary} · ${item.status || '-'} · 交期${item.dueDate || '-'}`
  }));
  const selectedOrderIndex = orderOptions.findIndex((item) => item.id === selectedId);
  return Object.assign({}, confirmationState, {
    orderCandidates: retained,
    orderOptions,
    orderRange: orderOptions.map((item) => item.label),
    selectedOrderId: selectedId,
    selectedOrder: retained.find((item) => item.id === selectedId) || null,
    selectedOrderIndex,
    selectedOrderLabel: selectedOrderIndex >= 0 ? orderOptions[selectedOrderIndex].label : '',
    showGenericOrderSelection: true,
    showGenericOrderPicker: true
  });
}

function rebuildAfterGenericOrderFieldEdit(state, pageData, baseResult, intent, nextBaseFields) {
  const selectedId = String(pageData.selectedOrderId || '');
  if (!selectedId || !pageData.orderSelectionBaseFields) {
    return buildConfirmationState(state, baseResult, intent, nextBaseFields);
  }
  const baseFields = copyOrderSelectionBaseFields(nextBaseFields);
  const fields = Object.assign({}, baseFields, {
    orderId: selectedId,
    orderSelectionConfirmed: true
  });
  const confirmationState = retainOrderCandidateChoices(
    state,
    buildConfirmationState(state, baseResult, intent, fields),
    pageData.orderCandidates,
    selectedId
  );
  confirmationState.orderSelectionBaseFields = baseFields;
  return confirmationState;
}

function buildGenericQuotationSelectionState(fields, operation, domainPreflight) {
  const nextFields = Object.assign({}, fields);
  const preflightCandidates = (((domainPreflight || {}).candidates || {})
    .quotationSelectionCandidates || []);
  const quotationCandidates = preflightCandidates.map((item) => ({
    id: String(item.id || item.quotationId || ''),
    quotationId: String(item.quotationId || item.id || ''),
    customerId: String(item.customerId || ''),
    customerDisplayName: String(item.customerDisplayName || ''),
    productSummary: String(item.productSummary || ''),
    itemCount: Number(item.itemCount || 0),
    quotationAmount: item.quotationAmount || '',
    status: String(item.status || ''),
    quoteDate: String(item.quoteDate || ''),
    validUntil: String(item.validUntil || ''),
    createdAt: String(item.createdAt || '')
  })).filter((item) => item.id);
  const selectedQuotationId = String(nextFields.quotationId || '');
  const selectedQuotation = quotationCandidates
    .find((item) => item.id === selectedQuotationId) || null;
  const requiredSelections = (domainPreflight && domainPreflight.requiredSelections) || [];
  const blockingIssues = (domainPreflight && domainPreflight.blockingIssues) || [];
  const quotationSelectionRequired = requiredSelections.includes('quotationId');
  const quotationActionRequired = blockingIssues
    .some((item) => item.requiredAction === 'SELECT_QUOTATION');
  const operationSupportsQuotation = ['update_quotation', 'create_order'].includes(operation);
  const showGenericQuotationSelection = operationSupportsQuotation && (
    quotationSelectionRequired
    || quotationActionRequired
    || Boolean(selectedQuotationId)
  );
  let quotationSelectionReason = '';
  if (quotationSelectionRequired) {
    quotationSelectionReason = quotationCandidates.length > 1
      ? '找到多张可用报价，请选择原话指的是哪一张。'
      : '请确认这次业务关联哪一张报价。';
  } else if (quotationActionRequired) {
    quotationSelectionReason = '当前报价关系不安全，请重新选择同一客户的有效报价。';
  } else if (selectedQuotationId) {
    quotationSelectionReason = '已关联报价；如需更换，请重新选择。';
  }
  if (showGenericQuotationSelection && !quotationCandidates.length) {
    quotationSelectionReason = '没有找到可选择的同客户有效报价，当前不能完成报价关联。';
  }
  const quotationOptions = quotationCandidates.map((item) => ({
    id: item.id,
    label: `${item.customerDisplayName} · ${item.productSummary || '未填产品'} · ${item.status || '-'} · 报价${item.quotationAmount || '-'}元`
  }));
  const selectedQuotationIndex = quotationOptions
    .findIndex((item) => item.id === selectedQuotationId);

  return {
    fields: nextFields,
    quotationCandidates,
    quotationOptions,
    quotationRange: quotationOptions.map((item) => item.label),
    selectedQuotationId,
    selectedQuotation,
    selectedQuotationIndex,
    selectedQuotationLabel: selectedQuotationIndex >= 0
      ? quotationOptions[selectedQuotationIndex].label
      : '',
    quotationSelectionRequired,
    quotationSelectionReason,
    quotationSelectionConfirmed: Boolean(
      selectedQuotation && nextFields.quotationSelectionConfirmed === true
    ),
    quotationSelectionBaseFields: null,
    showGenericQuotationSelection,
    showGenericQuotationPicker: quotationOptions.length > 0
  };
}

function copyQuotationSelectionBaseFields(fields) {
  const base = Object.assign({}, fields);
  if (Array.isArray(fields.items)) {
    base.items = fields.items.map((item) => Object.assign({}, item));
  }
  delete base.quotationId;
  delete base.quotationSelectionConfirmed;
  return base;
}

function mergeQuotationSelectionDraftFields(state, baseFields, quotationId) {
  const selectedId = String(quotationId || '');
  const historicalFields = hydrateQuotationFields(state, {
    quotationId: selectedId
  });
  const patchFields = copyQuotationSelectionBaseFields(baseFields || {});
  if (!historicalFields) {
    return Object.assign({}, patchFields, {
      quotationId: selectedId,
      quotationSelectionConfirmed: true
    });
  }

  const historicalItems = normalizeConfirmItems(historicalFields);
  const patchItems = Array.isArray(patchFields.items)
    ? patchFields.items.map(normalizeConfirmItem)
    : [];
  const itemCount = Math.max(historicalItems.length, patchItems.length);
  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const historicalItem = historicalItems[index] || {};
    const patchItem = patchItems[index] || {};
    const item = mergePresentFields(historicalItem, patchItem);
    if (hasConfirmItemValue(item)) items.push(item);
  }

  const merged = mergePresentFields(historicalFields, patchFields);
  if (items.length) merged.items = items;
  merged.quotationId = selectedId;
  merged.quotationSelectionConfirmed = true;
  return merged;
}

function rebuildAfterQuotationFieldEdit(state, pageData, baseResult, intent, nextBaseFields) {
  const selectedId = String(pageData.selectedQuotationId || '');
  if (!selectedId || !pageData.quotationSelectionBaseFields) {
    return buildConfirmationState(state, baseResult, intent, nextBaseFields);
  }
  const baseFields = copyQuotationSelectionBaseFields(nextBaseFields);
  const fields = mergeQuotationSelectionDraftFields(state, baseFields, selectedId);
  const confirmationState = buildConfirmationState(state, baseResult, intent, fields);
  const stillSafe = (confirmationState.quotationCandidates || [])
    .some((item) => item.id === selectedId);
  if (!stillSafe) {
    return buildConfirmationState(state, baseResult, intent, baseFields);
  }
  confirmationState.quotationSelectionBaseFields = baseFields;
  return confirmationState;
}

function getFieldVisibility(intent, operation, fields = {}) {
  const quoteOrOrder = ['quotation', 'order'].includes(intent);
  const todo = ['todo', 'dunning'].includes(intent);
  const createReceivable = operation === 'create_receivable';
  const recordPayment = ['record_payment', 'create_receivable_with_payment'].includes(operation);
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
    showRemainingAmountField: operation === 'create_receivable_with_payment',
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
  let low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'depositAmount' ? 'paymentAmount' : field));
  const explicitlyUnlinked = nextFields.orderId === UNLINKED_ORDER_OPTION_ID
    || nextFields.allowUnlinkedOrderDeposit === true;
  const orderSelectionConfirmed = nextFields.orderSelectionConfirmed === true;
  if (nextFields.orderId === UNLINKED_ORDER_OPTION_ID) {
    delete nextFields.orderId;
    nextFields.allowUnlinkedOrderDeposit = true;
  }
  if (!hasFieldValue(nextFields, 'paymentAmount') && hasFieldValue(nextFields, 'depositAmount')) {
    nextFields.paymentAmount = nextFields.depositAmount;
  }
  if (!hasFieldValue(nextFields, 'depositAmount') && hasFieldValue(nextFields, 'paymentAmount')) {
    nextFields.depositAmount = nextFields.paymentAmount;
  }

  const customer = findCustomerForFields(state, nextFields);
  if (customer) {
    nextFields.customerId = customer.id;
    if (explicitlyUnlinked) nextFields.unlinkedOrderDepositCustomerId = customer.id;
  }
  const orders = customer
    ? (state.orders || [])
      .filter((item) => item.customerId === customer.id)
      .filter((item) => activeOrderStatuses.includes(item.status))
      .filter((item) => productMatches(nextFields.productName, item.productName))
    : [];

  const selected = orders.find((item) => item.id === nextFields.orderId) || null;
  if (!explicitlyUnlinked && nextFields.orderId && !selected) {
    delete nextFields.orderId;
    delete nextFields.orderSelectionConfirmed;
  }
  const matchedOrderOptions = orders.map((item) => ({
    id: item.id,
    label: formatOrderOption(state, item)
  }));
  const orderOptions = orders.length
    ? [{ id: UNLINKED_ORDER_OPTION_ID, label: '不关联订单（仅记一笔定金）' }].concat(matchedOrderOptions)
    : matchedOrderOptions;
  const orderRange = orderOptions.map((item) => item.label);
  const selectedIndex = explicitlyUnlinked
    ? orderOptions.findIndex((item) => item.id === UNLINKED_ORDER_OPTION_ID)
    : orderOptions.findIndex((item) => selected && item.id === selected.id);
  const paymentAmount = toMoney(nextFields.paymentAmount);
  const orderDepositPreview = [];
  let orderDepositWarningText = '';

  if (explicitlyUnlinked) {
    low = low.filter((field) => field !== 'orderId');
    delete nextFields.orderId;
    orderDepositPreview.push(`本次定金：${formatMoney(paymentAmount)}元`);
    orderDepositPreview.push('将仅记录一笔未关联订单定金，不会挂到任何订单或自动核销。');
    orderDepositWarningText = '已明确选择不关联订单；后续如需核对，请在记录详情中查看原始内容。';
  } else if (!orders.length) {
    delete nextFields.unlinkedOrderDepositCustomerId;
    orderDepositWarningText = customer
      ? '没有找到可关联订单，确认后会先保存为未关联订单定金，不会挂错订单。'
      : '请先确认客户；确认后可先保存为未关联订单定金。';
  } else if (!selected || !orderSelectionConfirmed) {
    delete nextFields.unlinkedOrderDepositCustomerId;
    low.push('orderId');
    orderDepositWarningText = selected
      ? '已匹配到订单；请在下方点选确认，或选择不关联订单。'
      : (orders.length === 1
        ? '已找到一笔可关联订单；请确认定金属于这单，或选择不关联订单。'
        : '这个客户有多笔进行中订单；请先选择定金属于哪一单，避免挂错订单。');
  } else {
    delete nextFields.unlinkedOrderDepositCustomerId;
    low = low.filter((field) => field !== 'orderId');
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

function buildPaymentState(state, fields, aiMissingFields, lowConfidenceFields, suggestedOperation) {
  const nextFields = Object.assign({}, fields);
  const low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'amount' ? 'paymentAmount' : field))
    .filter((field) => field !== 'receivableId');
  const explicitlyUnlinked = nextFields.receivableId === UNLINKED_RECEIVABLE_OPTION_ID
    || nextFields.allowUnlinkedPayment === true;
  const receivableSelectionConfirmed = nextFields.receivableSelectionConfirmed === true;
  if (nextFields.receivableId === UNLINKED_RECEIVABLE_OPTION_ID) {
    delete nextFields.receivableId;
    nextFields.allowUnlinkedPayment = true;
  }
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
    if (explicitlyUnlinked) nextFields.unlinkedPaymentCustomerId = customer.id;
  }

  const selected = receivables.find((item) => item.id === nextFields.receivableId) || null;
  const paymentAmount = toMoney(nextFields.paymentAmount);
  const matchedReceivableOptions = receivables.map((item) => ({
    id: item.id,
    label: formatReceivableOption(item)
  }));
  const receivableOptions = receivables.length
    ? [{ id: UNLINKED_RECEIVABLE_OPTION_ID, label: '不关联本次收款（仅记一笔收款）' }].concat(matchedReceivableOptions)
    : matchedReceivableOptions;
  const receivableRange = receivableOptions.map((item) => item.label);
  const selectedIndex = explicitlyUnlinked
    ? receivableOptions.findIndex((item) => item.id === UNLINKED_RECEIVABLE_OPTION_ID)
    : receivableOptions.findIndex((item) => selected && item.id === selected.id);
  const paymentPreview = [];
  const newReceivablePreview = [];
  let paymentWarningText = '';
  let newReceivableWarningText = '';
  let operation = 'record_payment';
  const remainingAmount = toMoney(nextFields.remainingAmount);
  const shouldCreateReceivableWithPayment = suggestedOperation === 'create_receivable_with_payment'
    && !receivables.length
    && paymentAmount > 0
    && remainingAmount > 0;

  if (shouldCreateReceivableWithPayment) {
    operation = 'create_receivable_with_payment';
    nextFields.amount = String(toMoney(paymentAmount + remainingAmount));
    delete nextFields.receivableId;
    newReceivablePreview.push(`将新建待收总额：${formatMoney(nextFields.amount)}元`);
    newReceivablePreview.push(`本次已收：${formatMoney(paymentAmount)}元`);
    newReceivablePreview.push(`还差：${formatMoney(remainingAmount)}元`);
    newReceivableWarningText = '这笔没有匹配到旧待收；确认后会新建待收并记录本次收款。';
  } else if (explicitlyUnlinked) {
    delete nextFields.receivableId;
    paymentPreview.push('将仅记录一笔未关联收款，不会核销任何待收款 / 欠款。');
    if (paymentAmount > 0) paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
    paymentWarningText = '已明确选择不关联；后续如需核对，请在记录详情中查看原始内容。';
  } else if (!receivables.length) {
    delete nextFields.unlinkedPaymentCustomerId;
    delete nextFields.receivableId;
    paymentPreview.push('没有匹配到旧待收款 / 欠款，将保存为未关联收款，不会自动核销或新建欠款。');
    if (paymentAmount > 0) paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
  } else if (!selected || !receivableSelectionConfirmed) {
    delete nextFields.unlinkedPaymentCustomerId;
    low.push('receivableId');
    paymentWarningText = selected
      ? '已匹配到待收款 / 欠款；请在下方点选确认，或选择不关联本次收款。'
      : (receivables.length === 1
        ? '已找到一笔可关联待收款 / 欠款；请确认是否核销，或选择不关联本次收款。'
        : '这个客户有多笔未结清待收款 / 欠款；选择后会核销对应记录，不选择则保存为未关联收款。');
  } else {
    delete nextFields.unlinkedPaymentCustomerId;
    const selectedLow = low.filter((field) => field !== 'receivableId');
    low.length = 0;
    low.push(...selectedLow);
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
  let operation = ['update_order', 'update_quotation'].includes(parseResult.operation)
    ? parseResult.operation
    : (operationByIntent[intent] || 'pending');
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
    nextFields = syncFirstItemToLegacyFields(nextFields, {
      preserveConfirmedAmount: (parseResult.manual_fields || []).includes('amount')
    });
  }

  if (intent === 'order' && operation === 'create_order') {
    const totalAmount = toMoney(nextFields.totalAmount || nextFields.amount);
    const depositAmount = toMoney(nextFields.depositAmount || nextFields.paymentAmount);
    if (depositAmount > 0 && (totalAmount <= 0 || depositAmount > totalAmount)) {
      lowConfidenceFields.push('depositAmount');
    }
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
    paymentState = buildPaymentState(
      state,
      nextFields,
      parseResult.missing_fields || [],
      lowConfidenceFields,
      parseResult.suggested_operation
    );
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
  const confirmItems = ['quotation', 'order'].includes(intent) ? buildConfirmItemCards(nextFields, intent, state) : [];
  const orderAmountSummaryLines = intent === 'order' ? buildOrderAmountSummary(nextFields) : [];
  const localParseSafetyLines = formatLocalParseSafety(normalizedParseResult.local_parse_safety);
  const safetyBlockText = getFormalSaveSafetyBlockText(normalizedParseResult);
  const productSuggestion = (normalizedParseResult.field_suggestions || {}).productName || {};
  const finalWarningState = safetyBlockText
    ? Object.assign({}, warningState, {
      showWarning: true,
      warningLowText: warningState.warningLowText || safetyBlockText
    })
    : warningState;
  const flowContext = getTrustedRecordFlowContext(normalizedParseResult);
  const domainPreflight = evaluateRecordDomainPreflight({
    mode: flowContext.mode || 'PRODUCTION_ROUTING',
    resultScope: flowContext.resultScope || 'PRODUCTION_RESULT',
    operation,
    businessType: intent,
    finalResult: normalizedParseResult,
    originalText: normalizedParseResult.original_text || '',
    initialState: state,
    aiOutcome: flowContext.aiOutcome || (normalizedParseResult.ai_fallback || {}).status || 'not_requested',
    providerKind: flowContext.providerKind || (normalizedParseResult.ai_fallback || {}).provider_kind || 'NONE',
    skipFinalSafety: true
  });
  const genericOrderSelectionState = buildGenericOrderSelectionState(
    state,
    nextFields,
    operation,
    domainPreflight
  );
  const genericQuotationSelectionState = buildGenericQuotationSelectionState(
    nextFields,
    operation,
    domainPreflight
  );
  const orderSelectionState = operation === 'record_order_deposit'
    ? Object.assign({}, orderDepositState, {
      orderCandidates: [],
      selectedOrderId: nextFields.orderId || '',
      selectedOrder: null,
      orderSelectionRequired: false,
      orderSelectionReason: '',
      orderSelectionBaseFields: null,
      showGenericOrderSelection: false,
      showGenericOrderPicker: false
    })
    : Object.assign({}, orderDepositState, genericOrderSelectionState);
  const canFormalSave = domainPreflight.domainCanSaveFormal === true;
  const historyDefaultedFields = uniqueFields(normalizedParseResult.history_defaulted_fields || []);

  return Object.assign({
    parseResult: normalizedParseResult,
    parseEvidence: buildParseEvidence(normalizedParseResult),
    showParseEvidence: false,
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
    domainCanSaveFormal: domainPreflight.domainCanSaveFormal,
    domainCanSavePending: domainPreflight.domainCanSavePending,
    domainPreflight,
    preflightFingerprint: domainPreflight.preflightFingerprint,
    preflightBlockingReasons: domainPreflight.blockingIssues.map((item) => item.code),
    fieldConflictLines,
    showFieldConflicts: Boolean(fieldConflictLines.length),
    orderAmountSummaryLines,
    showOrderAmountSummary: Boolean(orderAmountSummaryLines.length),
    localParseSafetyLines,
    showLocalParseSafety: Boolean(localParseSafetyLines.length),
    productSuggestionText: productSuggestion.text || '',
    productSuggestionValue: productSuggestion.value || '',
    showProductSuggestion: Boolean(productSuggestion.text && productSuggestion.value),
    supersededFactLines,
    showSupersededFacts: Boolean(supersededFactLines.length),
    remarkItemLines,
    showRemarkItems: Boolean(remarkItemLines.length),
    historyDefaultFieldMap: getFieldFlagMap(historyDefaultedFields),
    formalButtonText: canFormalSave
      ? (operation === 'update_order' ? '确认更新订单' : '确认保存')
      : (operation === 'update_order' ? '补齐后更新' : '补齐后保存'),
    disableFormalSave: !canFormalSave,
    showPaymentConfirm: operation === 'record_payment',
    showNewReceivableWithPayment: operation === 'create_receivable_with_payment',
    showReceivablePicker: operation === 'record_payment' && paymentState.receivableOptions.length > 1,
    showOrderDepositConfirm: operation === 'record_order_deposit',
    showOrderPicker: operation === 'record_order_deposit' && orderDepositState.orderOptions.length > 1,
    showDeepReviewButton: Boolean((normalizedParseResult.parse_route || {}).deep_review_available)
  }, visibility, finalWarningState, paymentState, orderSelectionState,
  genericQuotationSelectionState, customerMatchState);
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
    parseEvidence: null,
    showParseEvidence: false,
    showDeepReviewButton: false,
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
    selectedOrderId: '',
    selectedOrder: null,
    orderCandidates: [],
    orderSelectionRequired: false,
    orderSelectionReason: '',
    orderSelectionBaseFields: null,
    showGenericOrderSelection: false,
    showGenericOrderPicker: false,
    quotationOptions: [],
    quotationRange: [],
    selectedQuotationIndex: -1,
    selectedQuotationLabel: '',
    selectedQuotationId: '',
    selectedQuotation: null,
    quotationCandidates: [],
    quotationSelectionRequired: false,
    quotationSelectionReason: '',
    quotationSelectionConfirmed: false,
    quotationSelectionBaseFields: null,
    showGenericQuotationSelection: false,
    showGenericQuotationPicker: false,
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

function clearParseProgress(page) {
  (page.parseProgressTimers || []).forEach((timer) => clearTimeout(timer));
  page.parseProgressTimers = [];
  if (page.parseProgressRevealTimer) clearTimeout(page.parseProgressRevealTimer);
  page.parseProgressRevealTimer = null;
}

function startParseProgress(page, source) {
  clearParseProgress(page);
  const copy = source === 'paste'
    ? [
      ['正在整理聊天内容', '先找出客户、产品和最终说法'],
      ['正在核对前后说法', '避免把旧价格或旧数量记进去'],
      ['聊天内容比较复杂，正在复核关键内容', '请稍等，确认前不会自动保存'],
      ['网络有点慢，正在继续整理', '当前内容还留在输入框，可继续等待']
    ]
    : [
      ['正在整理这条记录', '先核对客户、金额和交期'],
      ['正在核对关键信息', '避免把金额或数量记错'],
      ['内容比较复杂，正在复核', '请稍等，确认前不会自动保存'],
      ['网络有点慢，正在继续整理', '当前内容还留在输入框，可继续等待']
    ];
  const show = () => page.setData({
    showParseProgress: true,
    parseProgressTitle: copy[0][0],
    parseProgressDetail: copy[0][1]
  });
  page.parseProgressRevealTimer = setTimeout(show, 180);
  [2600, 7600, 15000].forEach((delay, index) => {
    page.parseProgressTimers.push(setTimeout(() => {
      if (!page.data.parsing) return;
      page.setData({
        parseProgressTitle: copy[index + 1][0],
        parseProgressDetail: copy[index + 1][1]
      });
    }, delay));
  });
}

function finishParseProgress(page) {
  clearParseProgress(page);
  page.setData({ showParseProgress: false });
}

Page({
  data: {
    source: 'typed',
    sourceLabels: INPUT_SOURCE_LABELS,
    text: '',
    parseResult: null,
    parseEvidence: null,
    showParseEvidence: false,
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
    voiceTip: '按住说出客户、产品和金额；松开后我会先转成文字给你确认。',
    voiceButtonClass: 'voice-button-idle',
    voiceButtonText: '按住说一句',
    parsing: false,
    parseButtonText: '生成确认卡',
    parseAssistText: '',
    showParseProgress: false,
    parseProgressTitle: '',
    parseProgressDetail: '',
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
    orderDepositPreview: [],
    orderDepositWarningText: '',
    orderOptions: [],
    orderRange: [],
    selectedOrderIndex: -1,
    selectedOrderLabel: '',
    selectedOrderId: '',
    selectedOrder: null,
    orderCandidates: [],
    orderSelectionRequired: false,
    orderSelectionReason: '',
    orderSelectionBaseFields: null,
    showGenericOrderSelection: false,
    showGenericOrderPicker: false,
    quotationOptions: [],
    quotationRange: [],
    selectedQuotationIndex: -1,
    selectedQuotationLabel: '',
    selectedQuotationId: '',
    selectedQuotation: null,
    quotationCandidates: [],
    quotationSelectionRequired: false,
    quotationSelectionReason: '',
    quotationSelectionConfirmed: false,
    quotationSelectionBaseFields: null,
    showGenericQuotationSelection: false,
    showGenericQuotationPicker: false,
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
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    // 页面一出现就准备登录；普通快速核对不会在 8 秒内临时等待登录。
    prewarmAiAuth();
    const pendingId = wx.getStorageSync('pending_to_edit');
    if (pendingId) {
      wx.removeStorageSync('pending_to_edit');
      this.loadPendingForEdit(pendingId);
      return;
    }
    const recordToEdit = wx.getStorageSync('record_to_edit');
    if (recordToEdit && recordToEdit.type === 'order' && recordToEdit.id) {
      wx.removeStorageSync('record_to_edit');
      this.loadOrderForEdit(recordToEdit.id);
      return;
    }
    const forceTextInput = wx.getStorageSync('force_text_input');
    if (forceTextInput) {
      wx.removeStorageSync('force_text_input');
      this.setData(Object.assign(getEmptyConfirmationData(), {
        source: 'typed',
        sourceLabel: INPUT_SOURCE_LABELS.typed,
        parseButtonText: '生成确认卡',
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
        parseButtonText: '生成确认卡',
        parseAssistText: ''
      }, getSourceState(source)));
    }
  },

  onHide() {
    this.cancelVoice();
    finishParseProgress(this);
  },

  onUnload() {
    clearParseProgress(this);
    if (this.data.voiceRecording) {
      this.voiceCancelled = true;
      stopVoiceRecognition();
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
    if (String(text || '').trim()) prewarmAiAuth();
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
      parseButtonText: '生成确认卡',
      pasteAnalysis: analysis
    }, getSourceState('paste')));
  },

  startVoice() {
    if (this.data.voiceRecording) return;
    // 录音期间预先完成登录；失败不打断录音，真正解析时会给出明确原因。
    prewarmAiAuth();
    this.voiceCancelled = false;
    this.setData(Object.assign({
      source: 'voice',
      sourceLabel: INPUT_SOURCE_LABELS.voice,
      voiceRecording: true,
      voiceButtonClass: 'voice-button-recording',
      voiceButtonText: '松开结束',
      voiceTip: '正在听，请说清客户、产品、数量或金额。',
      parseAssistText: ''
    }, getSourceState('voice')));

    startVoiceRecognition({
      duration: 60000,
      lang: 'zh_CN',
      onRecognize: (result) => {
        const partialText = String((result && result.text) || '').trim();
        if (!this.data.voiceRecording || !partialText) return;
        this.setData({ voiceTip: `正在听：${partialText}` });
      },
      onStop: () => {
        if (this.voiceCancelled) return;
        this.setData({
          voiceRecording: false,
          voiceButtonClass: 'voice-button-idle',
          voiceButtonText: '正在整理…',
          voiceTip: '已收到，正在转成文字。'
        });
      },
      onResult: (result) => {
        const text = String((result && result.text) || '').trim();
        if (this.voiceCancelled) {
          this.setData({
            voiceRecording: false,
            voiceButtonClass: 'voice-button-idle',
            voiceButtonText: '按住说一句',
            voiceTip: '已取消，可以再按住说一次。'
          });
          return;
        }
        this.setData(Object.assign({
          text,
          source: 'voice',
          sourceLabel: INPUT_SOURCE_LABELS.voice,
          voiceRecording: false,
          voiceButtonClass: 'voice-button-idle',
          voiceButtonText: '按住说一句',
          voiceTip: '已转成文字，正在整理成确认卡。',
          pasteAnalysis: null
        }, getSourceState('voice')), () => this.runParse());
      },
      onError: (error) => {
        this.setData({
          voiceRecording: false,
          voiceButtonClass: 'voice-button-idle',
          voiceButtonText: '按住说一句',
          voiceTip: (error && error.message) || '没有听清楚，请再说一次。'
        });
      }
    });
  },

  loadOrderForEdit(orderId) {
    const state = getState();
    const parseResult = buildOrderEditDraft(state, orderId);
    if (!parseResult) {
      wx.showToast({ title: '没有找到这笔订单', icon: 'none' });
      return;
    }
    const confirmationState = buildConfirmationState(state, parseResult, 'order', parseResult.fields);
    this.setData(Object.assign({}, getEmptyConfirmationData(), confirmationState, {
      text: parseResult.original_text || '',
      source: 'typed',
      sourceLabel: INPUT_SOURCE_LABELS.typed,
      intent: 'order',
      intentLabel: INTENT_LABELS.order,
      formalButtonText: confirmationState.disableFormalSave ? '补齐后更新' : '确认更新订单',
      parseAssistText: '正在修改这笔订单。保存后会记录修改日志，原始内容仍会保留。'
    }, getSourceState('typed')));
  },

  stopVoice() {
    if (!this.data.voiceRecording) return;
    stopVoiceRecognition();
  },

  cancelVoice() {
    if (!this.data.voiceRecording) return;
    this.voiceCancelled = true;
    stopVoiceRecognition();
    this.setData({
      voiceRecording: false,
      voiceButtonClass: 'voice-button-idle',
      voiceButtonText: '按住说一句',
      voiceTip: '已取消，可以再按住说一次。'
    });
  },

  runParse(reviewMode = 'standard') {
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
    startParseProgress(this, source);
    const state = getState();
    const payload = {
      text,
      source,
      context: 'home',
      state,
      reviewMode
    };
    if (pasteAnalysis) {
      payload.rawText = pasteAnalysis.rawText;
      payload.extractedText = pasteAnalysis.extractedText;
      payload.pasteMeta = getPasteMeta(pasteAnalysis);
    }
    parseHybridInput(payload)
      .then((parseResult) => {
      finishParseProgress(this);
      const confirmationState = buildConfirmationState(state, parseResult, parseResult.intent, parseResult.fields);
      const aiStatus = (parseResult.ai_fallback && parseResult.ai_fallback.status) || 'not_requested';
      const safetyStatus = parseResult.local_parse_safety && parseResult.local_parse_safety.status;
      const deepReviewAvailable = Boolean((parseResult.parse_route || {}).deep_review_available);
      const aiStatusText = deepReviewAvailable
          ? '这条内容需要深度核对；未点击前不会自动等待慢速 AI。'
        : (safetyStatus === 'NEEDS_AI' && ['failed', 'timed_out', 'returned_uncertain', 'skipped_no_endpoint'].includes(aiStatus))
          ? '这条内容比较复杂，请重点核对带提示的字段，拿不准就先放待整理。'
        : (safetyStatus === 'NEEDS_USER_CONFIRM'
          ? '我先帮你整理成草稿了，还有几项需要你确认。'
          : {
        not_requested: '已整理好，请确认后保存。',
        skipped_no_endpoint: '已整理出一张草稿，请确认后保存。',
        mock_used: '已整理出一张草稿，请确认后保存。',
        used: '已整理出一张草稿，请确认后保存。',
        failed: '暂时没能自动整理完整，请核对后再保存。',
        timed_out: '智能核对等待超时，这条不能直接保存。',
        returned_uncertain: '智能核对没有给出可采用的业务结果，这条不能直接保存。'
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
        parseButtonText: '生成确认卡',
        showComputedTips: Boolean(confirmationState.parseResult.computed_tips && confirmationState.parseResult.computed_tips.length),
        computedTips: confirmationState.parseResult.computed_tips || []
      }));
      })
      .catch(() => {
      finishParseProgress(this);
      this.setData({
        parsing: false,
        parseButtonText: '生成确认卡',
        parseAssistText: ''
      });
      wx.showToast({ title: '识别失败，请稍后再试', icon: 'none' });
      });
  },

  requestDeepReview() {
    if (!this.data.parseResult || !((this.data.parseResult.parse_route || {}).deep_review_available)) return;
    this.runParse('deep');
  },

  toggleParseEvidence() {
    this.setData({ showParseEvidence: !this.data.showParseEvidence });
  },

  closeConfirmCard() {
    const text = this.data.text;
    const source = this.data.source;
    clearParseProgress(this);
    this.setData(Object.assign(getEmptyConfirmationData(), {
      text,
      source,
      sourceLabel: INPUT_SOURCE_LABELS[source] || INPUT_SOURCE_LABELS.typed,
      parseButtonText: '生成确认卡',
      parseAssistText: text ? '已关闭确认卡，原内容还在输入框里。' : ''
    }, getSourceState(source)));
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
    const intentChanged = intent !== this.data.intent;
    const baseResult = Object.assign({}, this.data.parseResult, {
      operation: intentChanged
        ? (operationByIntent[intent] || 'pending')
        : this.data.parseResult.operation,
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const fields = this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : (this.data.orderSelectionBaseFields
        ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
        : Object.assign({}, this.data.fields));
    delete fields.quotationId;
    delete fields.quotationSelectionConfirmed;
    const confirmationState = buildConfirmationState(state, baseResult, intent, fields);
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
      const hasGenericQuotationSelection = Boolean(
        this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
      );
      const hasGenericOrderSelection = Boolean(
        this.data.selectedOrderId && this.data.orderSelectionBaseFields
      );
      const fieldInvalidatesOrderSelection = ['customerName', 'phone', 'productName'].includes(field);
      const fieldInvalidatesQuotationSelection = ['customerName', 'phone'].includes(field);
      const sourceFields = hasGenericQuotationSelection
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : (hasGenericOrderSelection
          ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
          : this.data.fields);
      const nextFields = Object.assign({}, sourceFields, {
        [field]: event.detail.value
      });
      if (['customerName', 'phone'].includes(field)) {
        delete nextFields.customerId;
        delete nextFields.receivableId;
        delete nextFields.orderId;
        delete nextFields.allowUnlinkedPayment;
        delete nextFields.allowUnlinkedOrderDeposit;
        delete nextFields.unlinkedPaymentCustomerId;
        delete nextFields.unlinkedOrderDepositCustomerId;
        delete nextFields.receivableSelectionConfirmed;
        delete nextFields.orderSelectionConfirmed;
        delete nextFields.quotationId;
        delete nextFields.quotationSelectionConfirmed;
        delete nextFields.customerHistoryConfirmed;
        delete nextFields.customerSelectionConfirmed;
        if (field === 'customerName') delete nextFields.forceNewCustomer;
      }
      if (field === 'productName') {
        delete nextFields.orderId;
        delete nextFields.allowUnlinkedOrderDeposit;
        delete nextFields.unlinkedOrderDepositCustomerId;
        delete nextFields.orderSelectionConfirmed;
      }
      const baseResult = Object.assign({}, markManualField(this.data.parseResult, field), {
        missing_fields: [],
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      const state = getState();
      Object.assign(
        patch,
        hasGenericQuotationSelection && !fieldInvalidatesQuotationSelection
          ? rebuildAfterQuotationFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : (hasGenericOrderSelection && !fieldInvalidatesOrderSelection
          ? rebuildAfterGenericOrderFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : buildConfirmationState(state, baseResult, this.data.intent, nextFields))
      );
    }
    this.setData(patch);
  },

  updateItemField(event) {
    if (!this.data.parseResult) return;
    const index = Number(event.currentTarget.dataset.index || 0);
    const field = event.currentTarget.dataset.field;
    const sourceFields = this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : this.data.fields;
    const items = normalizeConfirmItems(sourceFields, { ensureFirst: true });
    if (!items[index] || !field) return;
    const value = ['unit', 'priceUnit'].includes(field) ? normalizeUnit(event.detail.value) : event.detail.value;
    items[index] = Object.assign({}, items[index], {
      [field]: value
    });
    const manualFields = this.data.parseResult.manual_fields || [];
    if (['quantity', 'unit', 'unitPrice', 'priceUnit'].includes(field)
      && !manualFields.includes('totalAmount')
      && hasMoneyValue(items[index].quantity)
      && hasMoneyValue(items[index].unitPrice)) {
      items[index].totalAmount = unitsMatch(items[index].unit, items[index].priceUnit)
        ? formatMoneyValue(Number(items[index].quantity) * Number(items[index].unitPrice))
        : '';
    }
    const fields = syncFirstItemToLegacyFields(Object.assign({}, sourceFields, {
      items
    }), {
      preserveConfirmedAmount: manualFields.includes('amount')
    });
    if (field === 'productName') {
      delete fields.orderId;
      delete fields.allowUnlinkedOrderDeposit;
      delete fields.orderSelectionConfirmed;
    }
    let manualResult = markManualField(this.data.parseResult, field);
    if (['unit', 'priceUnit'].includes(field)) manualResult = markManualField(manualResult, 'priceUnit');
    // 数量单位和计价单位不同的时候不自动换算；如果老板手工填写了该规格小计，
    // 这表示他已经确认了金额，可以解除单位不一致的阻断提示。
    if (field === 'totalAmount' && hasMoneyValue(value)) {
      manualResult = markManualField(manualResult, 'priceUnit');
    }
    const baseResult = Object.assign({}, manualResult, {
      missing_fields: [],
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((item) => item !== field && !(['unit', 'totalAmount'].includes(field) && item === 'priceUnit')),
      field_conflicts: (this.data.parseResult.field_conflicts || [])
        .filter((item) => !(item && item.field === 'priceUnit' && ['unit', 'priceUnit', 'totalAmount'].includes(field)))
    });
    const state = getState();
    this.setData(
      this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
        ? rebuildAfterQuotationFieldEdit(
          state,
          this.data,
          baseResult,
          this.data.intent,
          fields
        )
        : buildConfirmationState(state, baseResult, this.data.intent, fields)
    );
  },

  changeFollowupDays(event) {
    if (!this.data.parseResult) return;
    const days = FOLLOWUP_DAY_VALUES[Number(event.detail.value)] || DEFAULT_QUOTATION_FOLLOWUP_DAYS;
    const sourceFields = this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : this.data.fields;
    const fields = Object.assign({}, sourceFields, {
      followupDays: String(days)
    });
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((item) => !['followupDays', 'dueDate'].includes(item))
    });
    const state = getState();
    this.setData(
      this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
        ? rebuildAfterQuotationFieldEdit(
          state,
          this.data,
          baseResult,
          this.data.intent,
          fields
        )
        : buildConfirmationState(state, baseResult, this.data.intent, fields)
    );
  },

  changeDateField(event) {
    const field = event.currentTarget.dataset.field || 'dueDate';
    const value = event.detail.value;
    const patch = {};
    patch[`fields.${field}`] = value;
    if (this.data.parseResult) {
      const hasGenericQuotationSelection = Boolean(
        this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
      );
      const hasGenericOrderSelection = Boolean(
        this.data.selectedOrderId && this.data.orderSelectionBaseFields
      );
      const sourceFields = hasGenericQuotationSelection
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : (hasGenericOrderSelection
          ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
          : this.data.fields);
      const nextFields = Object.assign({}, sourceFields, {
        [field]: value
      });
      const baseResult = Object.assign({}, markManualField(this.data.parseResult, field), {
        missing_fields: [],
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      const state = getState();
      Object.assign(
        patch,
        hasGenericQuotationSelection
          ? rebuildAfterQuotationFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : (hasGenericOrderSelection
          ? rebuildAfterGenericOrderFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : buildConfirmationState(state, baseResult, this.data.intent, nextFields))
      );
    }
    this.setData(patch);
  },

  changeCustomerMatch(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.customerMatchOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = Object.assign({}, this.data.fields);
    delete fields.receivableId;
    delete fields.orderId;
    delete fields.quotationId;
    delete fields.allowUnlinkedPayment;
    delete fields.allowUnlinkedOrderDeposit;
    delete fields.unlinkedPaymentCustomerId;
    delete fields.unlinkedOrderDepositCustomerId;
    delete fields.receivableSelectionConfirmed;
    delete fields.orderSelectionConfirmed;
    delete fields.quotationSelectionConfirmed;
    if (selected.id === NEW_CUSTOMER_OPTION_ID) {
      delete fields.customerId;
      delete fields.customerSelectionConfirmed;
      fields.forceNewCustomer = true;
    } else {
      fields.customerId = selected.id;
      fields.customerSelectionConfirmed = true;
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
    delete fields.orderId;
    delete fields.quotationId;
    delete fields.allowUnlinkedPayment;
    delete fields.allowUnlinkedOrderDeposit;
    delete fields.unlinkedPaymentCustomerId;
    delete fields.unlinkedOrderDepositCustomerId;
    delete fields.receivableSelectionConfirmed;
    delete fields.orderSelectionConfirmed;
    delete fields.quotationSelectionConfirmed;
    delete fields.customerHistoryConfirmed;
    delete fields.customerSelectionConfirmed;
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
    if (selected.id === UNLINKED_RECEIVABLE_OPTION_ID) {
      delete fields.receivableSelectionConfirmed;
    } else {
      delete fields.allowUnlinkedPayment;
      delete fields.unlinkedPaymentCustomerId;
      fields.receivableSelectionConfirmed = true;
    }
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
    if (selected.id === UNLINKED_ORDER_OPTION_ID) {
      delete fields.orderSelectionConfirmed;
    } else {
      delete fields.allowUnlinkedOrderDeposit;
      delete fields.unlinkedOrderDepositCustomerId;
      fields.orderSelectionConfirmed = true;
    }
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  applyOrderSelection(orderId) {
    if (!this.data.parseResult) return false;
    const selectedId = String(orderId || '');
    const operationAllowsGenericOrder = [
      'update_order',
      'create_receivable',
      'create_receivable_with_payment'
    ].includes(this.data.operation);
    if (!operationAllowsGenericOrder
      || !this.data.showGenericOrderSelection
      || !this.data.showGenericOrderPicker) {
      wx.showToast({ title: '当前不需要选择订单', icon: 'none' });
      return false;
    }
    const projected = (this.data.orderCandidates || []).find((item) => item.id === selectedId);
    const state = getState();
    const liveOrder = (state.orders || []).find((item) => item.id === selectedId);
    const currentCustomerId = String((this.data.fields || {}).customerId || '');
    const valid = Boolean(
      projected
      && liveOrder
      && activeOrderStatuses.includes(liveOrder.status)
      && (!currentCustomerId || liveOrder.customerId === currentCustomerId)
    );
    if (!valid) {
      const baseResult = Object.assign({}, this.data.parseResult, {
        missing_fields: this.data.parseResult.missing_fields || [],
        low_confidence_fields: this.data.parseResult.low_confidence_fields || []
      });
      this.setData(buildConfirmationState(state, baseResult, this.data.intent, this.data.fields));
      wx.showToast({ title: '这张订单已不可选，请重新确认', icon: 'none' });
      return false;
    }
    const baseFields = this.data.orderSelectionBaseFields
      ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
      : copyOrderSelectionBaseFields(this.data.fields);
    const fields = Object.assign({}, baseFields, {
      orderId: liveOrder.id,
      orderSelectionConfirmed: true
    });
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((field) => field !== 'orderId'),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((field) => field !== 'orderId')
    });
    const confirmationState = retainOrderCandidateChoices(
      state,
      buildConfirmationState(state, baseResult, this.data.intent, fields),
      this.data.orderCandidates,
      liveOrder.id
    );
    confirmationState.orderSelectionBaseFields = baseFields;
    this.setData(confirmationState);
    return true;
  },

  changeOrder(event) {
    const selected = (this.data.orderOptions || [])[Number(event.detail.value)];
    if (!selected) return false;
    return this.applyOrderSelection(selected.id);
  },

  selectOrderCandidate(event) {
    return this.applyOrderSelection(event.currentTarget.dataset.orderId);
  },

  clearOrderSelection() {
    if (!this.data.parseResult) return;
    const fields = this.data.orderSelectionBaseFields
      ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
      : Object.assign({}, this.data.fields);
    delete fields.orderId;
    delete fields.orderSelectionConfirmed;
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    this.setData(buildConfirmationState(getState(), baseResult, this.data.intent, fields));
  },

  applyQuotationSelection(quotationId) {
    if (!this.data.parseResult) return false;
    const selectedId = String(quotationId || '');
    if (!['update_quotation', 'create_order'].includes(this.data.operation)
      || !this.data.showGenericQuotationSelection
      || !this.data.showGenericQuotationPicker) {
      wx.showToast({ title: '当前不需要选择报价', icon: 'none' });
      return false;
    }
    const state = getState();
    const baseFields = this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : copyQuotationSelectionBaseFields(this.data.fields);
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((field) => field !== 'quotationId'),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((field) => field !== 'quotationId')
    });
    const freshSelectionState = buildConfirmationState(
      state,
      baseResult,
      this.data.intent,
      baseFields
    );
    const freshCandidate = (freshSelectionState.quotationCandidates || [])
      .find((item) => item.id === selectedId);
    if (!freshCandidate) {
      const currentSelectedId = String(this.data.selectedQuotationId || '');
      const currentStillSafe = (freshSelectionState.quotationCandidates || [])
        .some((item) => item.id === currentSelectedId);
      if (currentStillSafe) {
        const retainedState = buildConfirmationState(
          state,
          baseResult,
          this.data.intent,
          mergeQuotationSelectionDraftFields(state, baseFields, currentSelectedId)
        );
        retainedState.quotationSelectionBaseFields = baseFields;
        this.setData(retainedState);
      } else {
        this.setData(freshSelectionState);
      }
      wx.showToast({ title: '这张报价已不可选，请重新确认', icon: 'none' });
      return false;
    }
    const fields = mergeQuotationSelectionDraftFields(
      state,
      baseFields,
      freshCandidate.id
    );
    const confirmationState = buildConfirmationState(
      state,
      baseResult,
      this.data.intent,
      fields
    );
    const accepted = (confirmationState.quotationCandidates || [])
      .some((item) => item.id === selectedId)
      && String((confirmationState.fields || {}).quotationId || '') === selectedId;
    if (!accepted) {
      this.setData(freshSelectionState);
      wx.showToast({ title: '这张报价已不可选，请重新确认', icon: 'none' });
      return false;
    }
    confirmationState.quotationSelectionBaseFields = baseFields;
    confirmationState.quotationSelectionConfirmed = true;
    this.setData(confirmationState);
    return true;
  },

  changeQuotation(event) {
    const selected = (this.data.quotationOptions || [])[Number(event.detail.value)];
    if (!selected) return false;
    return this.applyQuotationSelection(selected.id);
  },

  selectQuotationCandidate(event) {
    return this.applyQuotationSelection(event.currentTarget.dataset.quotationId);
  },

  clearQuotationSelection() {
    if (!this.data.parseResult) return false;
    const fields = this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : copyQuotationSelectionBaseFields(this.data.fields);
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    this.setData(buildConfirmationState(
      getState(),
      baseResult,
      this.data.intent,
      fields
    ));
    return true;
  },

  addConfirmItem() {
    if (!this.data.parseResult) return;
    const items = normalizeConfirmItems(this.data.fields, { ensureFirst: true });
    const previous = items[items.length - 1] || {};
    items.push(normalizeConfirmItem({
      productName: previous.productName || '',
      unit: previous.unit || '',
      unitPrice: previous.unitPrice || '',
      priceUnit: previous.priceUnit || previous.unit || ''
    }));
    const fields = syncFirstItemToLegacyFields(Object.assign({}, this.data.fields, { items }));
    const baseResult = markManualField(this.data.parseResult, 'items');
    this.setData(buildConfirmationState(getState(), baseResult, this.data.intent, fields));
  },

  removeConfirmItem(event) {
    if (!this.data.parseResult) return;
    const index = Number(event.currentTarget.dataset.index || 0);
    const items = normalizeConfirmItems(this.data.fields, { ensureFirst: true });
    if (items.length <= 1 || !items[index]) return;
    items.splice(index, 1);
    const fields = syncFirstItemToLegacyFields(Object.assign({}, this.data.fields, { items }));
    const baseResult = markManualField(this.data.parseResult, 'items');
    this.setData(buildConfirmationState(getState(), baseResult, this.data.intent, fields));
  },

  applyProductSuggestion(event) {
    const value = event.currentTarget.dataset.value;
    if (!this.data.parseResult || !value) return;
    const items = normalizeConfirmItems(this.data.fields, { ensureFirst: false });
    if (items.length) {
      this.updateItemField({
        currentTarget: { dataset: { index: 0, field: 'productName' } },
        detail: { value }
      });
      return;
    }
    this.updateField({
      currentTarget: { dataset: { field: 'productName' } },
      detail: { value }
    });
  },

  applyCatalogProduct(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    this.updateItemField({
      currentTarget: { dataset: { index, field: 'productName' } },
      detail: { value }
    });
  },

  applyCatalogSpec(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    this.updateItemField({
      currentTarget: { dataset: { index, field: 'spec' } },
      detail: { value }
    });
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
    if (saved.type === 'error') {
      wx.showToast({ title: saved.error || '订单没有更新，请核对后重试', icon: 'none' });
      return;
    }
    if (saved.type === 'pending' && this.data.editingPendingId) {
      const original = updatePendingNote(state, this.data.editingPendingId, result, (saved.record && saved.record.reason) || '信息仍不完整，需要稍后整理');
      if (original && saved.record && saved.record.id && saved.record.id !== original.id) {
        state.pendingNotes = (state.pendingNotes || []).filter((item) => item.id !== saved.record.id);
      }
    } else {
      markPendingNoteConverted(state, this.data.editingPendingId, saved);
    }
    saveState(state, { writerSource: 'INPUT_FORMAL' });
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
    saveState(state, { writerSource: 'INPUT_PENDING' });
    wx.showToast({ title: '已存到待整理', icon: 'success' });
    this.setData(getEmptyConfirmationData());
  }
});
