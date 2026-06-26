const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('../../utils/constants');
const { findCustomerMatches, saveConfirmedDraft, savePendingNote } = require('../../utils/business');
const { parseHybridInput } = require('../../utils/ai-parser');
const { addDays, diffDays, today } = require('../../utils/date');
const { describeFields: describeVisibleFields, getFieldLabel, getVisibleFields } = require('../../utils/display');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const { getCustomerDisplay, getState, saveState } = require('../../utils/storage');

const intentOptions = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'unknown'];
const NEW_CUSTOMER_OPTION_ID = '__new_customer__';
const DEFAULT_QUOTATION_FOLLOWUP_DAYS = 2;
const FOLLOWUP_DAY_VALUES = Array.from({ length: 30 }, (_, index) => index + 1);
const FOLLOWUP_DAY_RANGE = FOLLOWUP_DAY_VALUES.map((days) => `${days} 天`);
const intentRange = intentOptions.map((item) => INTENT_LABELS[item]);
const requiredFields = {
  create_quotation: ['customerName', 'productName'],
  create_order: ['customerName', 'productName', 'dueDate'],
  update_quotation: ['quotationId'],
  update_order: ['orderId'],
  create_receivable: ['customerName', 'amount', 'dueDate'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount', 'dueDate'],
  record_payment: ['customerName', 'paymentAmount', 'receivableId'],
  create_todo: ['todoTitle', 'dueDate'],
  quotation: ['customerName', 'productName'],
  order: ['customerName', 'productName', 'dueDate'],
  receivable: ['customerName', 'amount', 'dueDate'],
  payment: ['customerName', 'paymentAmount', 'receivableId'],
  dunning: ['customerName'],
  todo: ['todoTitle', 'dueDate'],
  unknown: ['intent']
};
const warningFieldsByOperation = {
  create_quotation: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  create_order: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  update_quotation: ['quotationId', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  update_order: ['orderId', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  create_receivable: ['customerName', 'amount', 'dueDate'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount', 'remainingAmount', 'dueDate'],
  record_payment: ['customerName', 'paymentAmount', 'remainingAmount', 'receivableId'],
  create_todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  pending: ['intent'],
  quotation: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  order: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  receivable: ['customerName', 'amount', 'dueDate'],
  payment: ['customerName', 'paymentAmount', 'remainingAmount', 'receivableId'],
  dunning: ['customerName'],
  todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  unknown: ['intent']
};
const activeReceivableStatuses = ['待收', '部分收款'];
const operationByIntent = {
  quotation: 'create_quotation',
  order: 'create_order',
  receivable: 'create_receivable',
  payment: 'record_payment',
  dunning: 'pending',
  todo: 'create_todo',
  unknown: 'pending'
};
const operationTitles = {
  create_quotation: '保存为报价',
  create_order: '保存为订单',
  update_quotation: '更新报价',
  update_order: '更新订单',
  create_receivable: '保存为应收款',
  create_receivable_with_payment: '新建应收并记录已收',
  record_payment: '记录收款',
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
  receivableId: '匹配应收款',
  productName: '产品/规格',
  quantity: '数量',
  unit: '单位',
  unitPrice: '单价',
  amount: '金额/总价',
  paymentAmount: '已收金额',
  remainingAmount: '剩余金额',
  dueDate: '交期/到期日',
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

function getWarningFields(intent, operation) {
  return warningFieldsByOperation[operation] || warningFieldsByOperation[intent] || requiredFields[operation] || requiredFields[intent] || [];
}

function filterRelevantWarningFields(fields, intent, operation) {
  const allowed = getWarningFields(intent, operation);
  return uniqueFields(fields).filter((field) => allowed.includes(field));
}

function mergeMissing(intent, fields, aiMissingFields, operation) {
  const stillMissing = filterRelevantWarningFields(aiMissingFields || [], intent, operation)
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
  const low = getVisibleFields(lowConfidenceFields, currentFields);
  return {
    showWarning: Boolean(missing.length || low.length),
    warningMissingText: describeVisibleFields(missing, {}),
    warningLowText: describeVisibleFields(low, {})
  };
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
  return ['create_quotation', 'create_order', 'create_receivable', 'create_receivable_with_payment', 'record_payment', 'create_todo'].includes(operation);
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
      title: `这个客户已有 ${receivables.length} 笔未结清应收`,
      lines: receivables.slice(0, 3).map((item) => `应收 ${item.amount || '-'}元，到期 ${item.dueDate || '-'}`),
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
    nextFields.followupDays = String(days > 0 ? days : DEFAULT_QUOTATION_FOLLOWUP_DAYS);
    if (days <= 0) nextFields.dueDate = addDays(today(), DEFAULT_QUOTATION_FOLLOWUP_DAYS);
    return nextFields;
  }
  nextFields.followupDays = String(DEFAULT_QUOTATION_FOLLOWUP_DAYS);
  nextFields.dueDate = addDays(today(), DEFAULT_QUOTATION_FOLLOWUP_DAYS);
  return nextFields;
}

function formatReceivableOption(receivable) {
  return `应收${formatMoney(receivable.amount)}元，剩余${formatMoney(receivable.remainingAmount)}元，到期${receivable.dueDate || '-'}`;
}

function getFieldVisibility(intent, operation, fields = {}) {
  const quoteOrOrder = ['quotation', 'order'].includes(intent);
  const todo = intent === 'todo';
  const createReceivable = operation === 'create_receivable';
  const createReceivableWithPayment = operation === 'create_receivable_with_payment';
  const recordPayment = operation === 'record_payment';
  const quoteOperation = ['create_quotation', 'update_quotation'].includes(operation);
  const editableBusiness = operation !== 'pending' && intent !== 'unknown';
  const todoHasProductInfo = todo && Boolean(fields.productName || fields.quantity || fields.unit || fields.unitPrice || fields.amount);
  return {
    showCustomerFields: editableBusiness,
    showPhoneField: ['create_quotation', 'create_order', 'update_quotation', 'update_order', 'create_receivable', 'create_receivable_with_payment', 'record_payment'].includes(operation),
    showTodoTitleField: todo,
    showFollowupDaysField: quoteOperation,
    showProductField: quoteOrOrder || todoHasProductInfo,
    showQuantityFields: quoteOrOrder || (todo && Boolean(fields.quantity || fields.unit)),
    showPriceFields: quoteOrOrder || (todo && Boolean(fields.unitPrice || fields.amount)),
    showAmountField: quoteOrOrder || createReceivable || createReceivableWithPayment,
    showPaymentAmountField: recordPayment || createReceivableWithPayment,
    showRemainingAmountField: createReceivableWithPayment,
    showDueDateField: ['create_order', 'update_order', 'create_receivable', 'create_receivable_with_payment', 'create_todo'].includes(operation),
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
      if (operation === 'create_receivable_with_payment' && field === 'receivableId') return false;
      return !hasFieldValue(fields, field);
    }), 'payment', operation);
}

function buildPaymentState(state, fields, aiMissingFields, lowConfidenceFields) {
  const nextFields = Object.assign({}, fields);
  const low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'amount' ? 'paymentAmount' : field));
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
    operation = 'create_receivable_with_payment';
    delete nextFields.receivableId;

    if (hasFieldValue(nextFields, 'remainingAmount') && hasFieldValue(nextFields, 'paymentAmount')) {
      nextFields.amount = formatMoney(toMoney(nextFields.paymentAmount) + toMoney(nextFields.remainingAmount));
    } else if (!hadPaymentAmount && hasFieldValue(nextFields, 'amount')) {
      nextFields.amount = '';
    }

    const totalAmount = toMoney(nextFields.amount);
    const remainingAfter = Math.max(0, toMoney(totalAmount - paymentAmount));
    const statusAfter = totalAmount > 0 && remainingAfter <= 0 ? '已结清' : '部分收款';
    newReceivablePreview.push('没有匹配到旧应收款，将按一笔新的应收款处理。');
    if (totalAmount > 0) newReceivablePreview.push(`应收总额：${formatMoney(totalAmount)}元`);
    if (paymentAmount > 0) newReceivablePreview.push(`已收金额：${formatMoney(paymentAmount)}元`);
    if (totalAmount > 0 || hasFieldValue(nextFields, 'remainingAmount')) {
      newReceivablePreview.push(`保存后剩余：${formatMoney(hasFieldValue(nextFields, 'remainingAmount') ? nextFields.remainingAmount : remainingAfter)}元`);
    }
    if (nextFields.dueDate) newReceivablePreview.push(`到期日：${nextFields.dueDate}`);
    if (totalAmount > 0 || paymentAmount > 0) newReceivablePreview.push(`保存后状态：${statusAfter}`);
    newReceivableWarningText = '这不是直接改旧账，请补齐应收总额和到期日后再确认。';

    if (totalAmount > 0 && paymentAmount > totalAmount) {
      low.push('paymentAmount');
      newReceivableWarningText = '已收金额大于应收总额，请确认金额是否录错。';
    }

    if (hasFieldValue(nextFields, 'remainingAmount') && totalAmount > 0) {
      const expectedRemaining = toMoney(nextFields.remainingAmount);
      if (Math.abs(expectedRemaining - remainingAfter) > 0.01) {
        low.push('remainingAmount');
        newReceivableWarningText = `原话说还剩${formatMoney(expectedRemaining)}元，但系统计算保存后剩${formatMoney(remainingAfter)}元。`;
      }
    }
  } else if (!selected) {
    paymentWarningText = '这个客户有多笔未结清应收款，请先选择本次收的是哪一笔。';
  } else {
    const paidBefore = toMoney(selected.paidAmount);
    const remainingBefore = getRemainingAmount(selected);
    const paidAfter = toMoney(paidBefore + paymentAmount);
    const remainingAfter = Math.max(0, toMoney(toMoney(selected.amount) - paidAfter));
    const statusAfter = remainingAfter <= 0 ? '已结清' : '部分收款';
    paymentPreview.push(`匹配应收款：应收${formatMoney(selected.amount)}元，到期${selected.dueDate || '-'}`);
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
  let customerMatchState = emptyCustomerMatchState(nextFields);

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

  if (intent === 'payment') {
    paymentState = buildPaymentState(state, nextFields, parseResult.missing_fields || [], lowConfidenceFields);
    operation = paymentState.operation;
    nextFields = paymentState.fields;
    missingFields = paymentState.missingFields;
    lowConfidenceFields = paymentState.lowConfidenceFields;
  } else {
    missingFields = mergeMissing(intent, nextFields, parseResult.missing_fields || [], operation);
  }

  if (parseResult.context_policy === 'customer_history' && parseResult.history_status === 'not_found') {
    if (!hasFieldValue(nextFields, 'unitPrice')) missingFields.push('unitPrice');
    if (!hasFieldValue(nextFields, 'dueDate')) missingFields.push('dueDate');
    lowConfidenceFields = uniqueFields(lowConfidenceFields).filter((field) => !['unitPrice', 'dueDate'].includes(field));
  }

  customerMatchState = buildCustomerMatchState(state, nextFields, operation);
  nextFields = customerMatchState.fields;

  missingFields = getVisibleFields(filterRelevantWarningFields(uniqueFields(missingFields), intent, operation), nextFields);
  lowConfidenceFields = getVisibleFields(filterRelevantWarningFields(uniqueFields(lowConfidenceFields), intent, operation), nextFields);

  const visibility = getFieldVisibility(intent, operation, nextFields);
  const normalizedParseResult = Object.assign({}, parseResult, {
    intent,
    fields: nextFields,
    operation,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields
  });
  const warningState = getWarningState(missingFields, lowConfidenceFields, nextFields);
  const canFormalSave = !missingFields.length && !lowConfidenceFields.length && !customerMatchState.customerMatchBlocksSave && intent !== 'unknown';
  const historyDefaultedFields = uniqueFields(normalizedParseResult.history_defaulted_fields || []);

  return Object.assign({
    parseResult: normalizedParseResult,
    fields: nextFields,
    operation,
    operationTitle: operationTitles[operation],
    amountLabel: operation === 'create_receivable_with_payment' ? '应收总额' : (intent === 'receivable' ? '应收金额' : '金额/总价'),
    paymentAmountLabel: operation === 'record_payment' ? '本次收款' : '已收金额',
    dueDateLabel: intent === 'todo' ? '提醒日期' : (['receivable', 'payment'].includes(intent) ? '到期日' : (intent === 'quotation' ? '跟进日期' : '交期/到期日')),
    selectedFollowupDayIndex: getFollowupDayIndex(nextFields.followupDays),
    followupWarningText: ['create_quotation', 'update_quotation'].includes(operation)
      ? `默认 ${nextFields.followupDays || DEFAULT_QUOTATION_FOLLOWUP_DAYS} 天后跟进，日期 ${nextFields.dueDate}。请确认这个提醒时间。`
      : '',
    guessedSummary: getGuessedSummary(nextFields),
    historyWarningText: normalizedParseResult.history_warning_text || '',
    showHistoryWarning: Boolean(normalizedParseResult.history_warning_text),
    historyDefaultWarningText: normalizedParseResult.history_default_warning_text || '',
    showHistoryDefaultWarning: Boolean(normalizedParseResult.history_default_warning_text),
    historyDefaultFieldMap: getFieldFlagMap(historyDefaultedFields),
    formalButtonText: canFormalSave ? '确认保存' : '补齐后保存',
    disableFormalSave: !canFormalSave,
    showPaymentConfirm: operation === 'record_payment',
    showNewReceivableWithPayment: operation === 'create_receivable_with_payment',
    showReceivablePicker: operation === 'record_payment' && paymentState.receivableOptions.length > 1
  }, visibility, warningState, paymentState, customerMatchState);
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
    intent: 'unknown',
    operation: 'pending',
    operationTitle: operationTitles.pending,
    amountLabel: '金额/总价',
    paymentAmountLabel: '已收金额',
    dueDateLabel: '交期/到期日',
    intentLabel: INTENT_LABELS.unknown,
    showComputedTips: false,
    showHistoryWarning: false,
    showHistoryDefaultWarning: false,
    showWarning: false,
    showCustomerFields: false,
    showPhoneField: false,
    showTodoTitleField: false,
    showFollowupDaysField: false,
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
  };
}

Page({
  data: {
    source: 'typed',
    sourceLabels: INPUT_SOURCE_LABELS,
    text: '',
    parseResult: null,
    fields: {},
    intent: 'unknown',
    operation: 'pending',
    operationTitle: operationTitles.pending,
    amountLabel: '金额/总价',
    paymentAmountLabel: '已收金额',
    dueDateLabel: '交期/到期日',
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
    intentCandidatesText: '',
    typedClass: 'segment active',
    pasteClass: 'segment',
    voiceClass: 'segment',
    showPaste: false,
    showVoice: false,
    showComputedTips: false,
    showHistoryWarning: false,
    showHistoryDefaultWarning: false,
    showWarning: false,
    showCustomerFields: false,
    showPhoneField: false,
    showTodoTitleField: false,
    showFollowupDaysField: false,
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
    requestOrderFilterReset();
    const pendingId = wx.getStorageSync('pending_to_edit');
    if (pendingId) {
      wx.removeStorageSync('pending_to_edit');
      this.loadPendingForEdit(pendingId);
    }
  },

  loadPendingForEdit(pendingId) {
    const state = getState();
    const note = state.pendingNotes.find((item) => item.id === pendingId);
    if (note) {
      const source = note.source || 'typed';
      this.setData(Object.assign({
        text: note.originalText,
        source,
        sourceLabel: INPUT_SOURCE_LABELS[source]
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
    this.setData({ text: event.detail.value });
  },

  pasteClipboard() {
    wx.getClipboardData({
      success: (res) => {
        this.setData(Object.assign({
          source: 'paste',
          sourceLabel: INPUT_SOURCE_LABELS.paste,
          text: res.data || ''
        }, getSourceState('paste')));
      }
    });
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
    parseHybridInput({
        text: this.data.text,
        source: this.data.source,
        context: 'home',
        state
      })
      .then((parseResult) => {
      const confirmationState = buildConfirmationState(state, parseResult, parseResult.intent, parseResult.fields);
      const aiStatusText = {
        not_requested: '本地高频规则已完成识别。',
        skipped_no_endpoint: '本地规则先完成识别；这类输入以后可接真实 AI 继续增强。',
        mock_used: '已通过测试后端 mock 识别，结果仍需你确认。',
        used: '已调用 AI 解析，结果仍需你确认。',
        failed: 'AI 解析暂不可用，已使用本地规则结果。'
      }[(parseResult.ai_fallback && parseResult.ai_fallback.status) || 'not_requested'];
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
        delete nextFields.customerHistoryConfirmed;
        if (field === 'customerName') delete nextFields.forceNewCustomer;
      }
      const baseResult = Object.assign({}, this.data.parseResult, {
        missing_fields: [],
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      const state = getState();
      Object.assign(patch, buildConfirmationState(state, baseResult, this.data.intent, nextFields));
    }
    this.setData(patch);
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
      const baseResult = Object.assign({}, this.data.parseResult, {
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

  saveFormal() {
    if (!this.data.parseResult) return;
    const state = getState();
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, this.data.intent, this.data.fields);
    if (confirmationState.disableFormalSave) {
      const missingText = confirmationState.customerMatchWarningText || confirmationState.warningMissingText || confirmationState.warningLowText || '关键信息';
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
      missing_fields: [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, this.data.intent, this.data.fields);
    savePendingNote(state, confirmationState.parseResult, confirmationState.parseResult.history_warning_text || '用户选择稍后整理');
    saveState(state);
    wx.showToast({ title: '已存到待整理', icon: 'success' });
    this.setData(getEmptyConfirmationData());
  }
});
