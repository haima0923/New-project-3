const { addDays, diffDays, today } = require('./date');
const { applyFinalParseSafety } = require('./parse-safety');
const { ensureProductCatalog, learnProductCatalogFromRecord } = require('./product-catalog');
const {
  ACTIVE_ORDER_STATUSES: activeOrderStatuses,
  ACTIVE_RECEIVABLE_STATUSES: activeReceivableStatuses,
  calculateOrderDepositAmount,
  calculateOrderRemainingSettlement,
  customerNameMatches,
  evaluateRecordDomainPreflight,
  findCustomerMatches,
  getReceivablePaymentIssue,
  getReceivableRemainingAmount,
  getTrustedRecordFlowContext,
  orderMatchesProduct
} = require('./record-domain-preflight');
const { generateId, getCustomerDisplay, normalizeCustomer } = require('./storage');
const { normalizeUnit, unitsMatch } = require('./units');

const depositKinds = ['deposit'];
const recordCollections = {
  quotation: 'quotations',
  order: 'orders',
  receivable: 'receivables',
  payment: 'paymentRecords',
  todo: 'todos',
  pending: 'pendingNotes'
};

function cloneRecord(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function appendOperationLog(state, action, recordType, recordId, details = {}) {
  state.operationLogs = state.operationLogs || [];
  const log = {
    id: generateId('op'),
    action,
    recordType,
    recordId,
    summary: details.summary || '',
    before: details.before ? cloneRecord(details.before) : null,
    after: details.after ? cloneRecord(details.after) : null,
    createdAt: new Date().toISOString()
  };
  state.operationLogs.unshift(log);
  return log;
}

function archiveDeletedRecord(state, recordType, record, related = {}) {
  state.deletedRecords = state.deletedRecords || [];
  const deletedAt = new Date().toISOString();
  const archive = {
    id: generateId('del'),
    recordType,
    recordId: record.id,
    deletedAt,
    record: cloneRecord(record),
    related: cloneRecord(related)
  };
  state.deletedRecords.unshift(archive);
  return archive;
}

function toMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function hasMoneyValue(value) {
  if (!hasValue(value)) return false;
  return Number.isFinite(Number(value));
}

function formatMoneyValue(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function hasLineItemValue(item = {}) {
  return ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'itemDeliveryDate', 'itemRemark']
    .some((field) => hasValue(item[field]));
}

function normalizeLineItem(item = {}) {
  const next = {
    productName: item.productName || item.product_name || item.name || '',
    spec: item.spec || '',
    quantity: item.quantity || '',
    unit: normalizeUnit(item.unit || ''),
    unitPrice: item.unitPrice || item.unit_price || '',
    priceUnit: normalizeUnit(item.priceUnit || item.price_unit || item.unitPriceUnit || item.unit_price_unit || ''),
    totalAmount: item.totalAmount || item.total_amount || item.amount || '',
    itemDeliveryDate: item.itemDeliveryDate || item.item_delivery_date || item.deliveryDate || item.dueDate || '',
    itemRemark: item.itemRemark || item.item_remark || item.remark || ''
  };
  if (!hasMoneyValue(next.totalAmount)
    && hasMoneyValue(next.quantity)
    && hasMoneyValue(next.unitPrice)
    && unitsMatch(next.unit, next.priceUnit)) {
    next.totalAmount = formatMoneyValue(Number(next.quantity) * Number(next.unitPrice));
  }
  return next;
}

function getLegacyItemFromRecord(record = {}) {
  return normalizeLineItem({
    productName: record.productName,
    spec: record.spec,
    quantity: record.quantity,
    unit: record.unit,
    unitPrice: record.unitPrice,
    priceUnit: record.priceUnit,
    totalAmount: record.totalAmount,
    itemDeliveryDate: record.itemDeliveryDate,
    itemRemark: record.itemRemark
  });
}

function getRecordItems(record = {}) {
  const sourceItems = Array.isArray(record.items) ? record.items : [];
  const items = sourceItems
    .map(normalizeLineItem)
    .filter(hasLineItemValue);
  if (items.length) return items;
  const legacyItem = getLegacyItemFromRecord(record);
  return hasLineItemValue(legacyItem) ? [legacyItem] : [];
}

function normalizeLineItemsFromFields(fields = {}) {
  const sourceItems = Array.isArray(fields.items) ? fields.items : [];
  const items = sourceItems
    .map(normalizeLineItem)
    .filter(hasLineItemValue);
  if (items.length) return items;
  const legacyItem = getLegacyItemFromRecord(fields);
  return hasLineItemValue(legacyItem) ? [legacyItem] : [];
}

function calculateItemsTotalAmount(items = []) {
  if (!items.length) return '';
  const normalizedItems = items.map(normalizeLineItem);
  if (!normalizedItems.every((item) => hasMoneyValue(item.totalAmount))) return '';
  return formatMoneyValue(normalizedItems.reduce((sum, item) => sum + Number(item.totalAmount), 0));
}

function buildLegacyFieldsFromFirstItem(items = [], fields = {}) {
  const first = items[0] || {};
  return {
    productName: first.productName || fields.productName || '',
    spec: first.spec || fields.spec || '',
    quantity: first.quantity || fields.quantity || '',
    unit: first.unit || fields.unit || '',
    unitPrice: first.unitPrice || fields.unitPrice || '',
    priceUnit: first.priceUnit || fields.priceUnit || ''
  };
}

function getDraftTotalAmount(fields = {}, items = []) {
  const firstItemTotal = items.length <= 1 && items[0] ? items[0].totalAmount : '';
  // 最终保存必须尊重老板原话中的总价或确认卡里的人工修改。
  // 商品明细计算值只能在没有明确总价时补位，不能反向覆盖确认结果。
  return fields.amount
    || fields.totalAmount
    || fields.statedAmount
    || calculateItemsTotalAmount(items)
    || firstItemTotal
    || fields.calculatedAmount
    || '';
}

function getOriginalTextFromDraft(parseResult = {}) {
  const fields = parseResult.fields || {};
  return parseResult.original_text || fields.originalText || fields.original_text || '';
}

function getItemsSummary(record = {}) {
  const items = getRecordItems(record);
  const names = items.map((item) => item.productName).filter(Boolean);
  if (!items.length) return record.productName || '未填产品';
  if (items.length === 1) {
    const item = items[0];
    return [item.productName || record.productName || '未填产品', item.spec].filter(Boolean).join(' · ');
  }
  const uniqueNames = names.filter((name, index, array) => array.indexOf(name) === index);
  if (uniqueNames.length === 1) {
    const variants = items
      .map((item) => [item.spec, item.quantity || item.unit ? `${item.quantity || '-'}${item.unit || ''}` : ''].filter(Boolean).join(''))
      .filter(Boolean);
    return variants.length
      ? `${uniqueNames[0]} · ${variants.slice(0, 3).join('、')}${variants.length > 3 ? `等${variants.length}种` : ''}`
      : `${uniqueNames[0]} · ${items.length}项`;
  }
  if (uniqueNames.length <= 3) return uniqueNames.join('、');
  return `${uniqueNames[0] || record.productName || '多商品'}等${uniqueNames.length}款`;
}

function buildOrderEditDraft(state, orderId) {
  const order = (state.orders || []).find((item) => item.id === orderId);
  if (!order) return null;
  const customer = getCustomerById(state, order.customerId);
  const items = getRecordItems(order);
  return {
    intent: 'order',
    operation: 'update_order',
    edit_mode: 'direct_order',
    source: 'typed',
    original_text: order.originalText || '',
    fields: {
      orderId: order.id,
      customerId: order.customerId || '',
      customerName: customer ? customer.name : '',
      quotationId: order.quotationId || '',
      productName: order.productName || '',
      spec: order.spec || '',
      quantity: order.quantity || '',
      unit: normalizeUnit(order.unit || ''),
      unitPrice: order.unitPrice || '',
      priceUnit: normalizeUnit(order.priceUnit || ''),
      amount: order.totalAmount || '',
      totalAmount: order.totalAmount || '',
      items,
      dueDate: order.requiredDeliveryDate || '',
      paymentMethod: order.paymentMethod || '',
      remark: order.remark || ''
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    // 这是用户主动打开的编辑卡，卡上的内容来自已保存订单，不再按原始聊天重新猜。
    // 金额先不标成“手工输入”，这样用户改数量/单价时仍能自动重算；只有亲手改小计后才锁定。
    manual_fields: ['orderId', 'customerId', 'customerName'],
    confidence: 1
  };
}

function softDeleteRecord(state, recordType, recordId) {
  const collectionName = recordCollections[recordType];
  const collection = collectionName ? (state[collectionName] || []) : [];
  const index = collection.findIndex((item) => item.id === recordId);
  if (!collectionName || index < 0) return { ok: false, error: '没有找到这条记录，可能已经删除。' };
  const record = collection[index];
  const related = {};

  if (recordType === 'quotation') {
    const linkedOrder = (state.orders || []).find((item) => item.quotationId === record.id || item.id === record.convertedOrderId);
    if (linkedOrder) return { ok: false, error: '这条报价已经转成订单，不能单独删除。可以到订单里查看或取消。' };
  }

  if (recordType === 'order') {
    const linkedPayments = (state.paymentRecords || []).filter((item) => item.orderId === record.id);
    const linkedReceivables = (state.receivables || []).filter((item) => item.orderId === record.id);
    if (linkedPayments.length || linkedReceivables.length) {
      return { ok: false, error: '这笔订单已有定金、收款或待收，不能直接删除。可以把订单进度改为“已取消”。' };
    }
    const progress = (state.orderProgress || []).filter((item) => item.orderId === record.id);
    if (progress.length) {
      related.orderProgress = progress;
      state.orderProgress = (state.orderProgress || []).filter((item) => item.orderId !== record.id);
    }
    const quotation = (state.quotations || []).find((item) => item.id === record.quotationId);
    if (quotation) {
      related.quotationBefore = cloneRecord(quotation);
      quotation.status = '待确认';
      quotation.convertedOrderId = '';
      quotation.convertedAt = '';
      quotation.updatedAt = new Date().toISOString();
      related.quotationAfter = cloneRecord(quotation);
    }
  }

  if (recordType === 'receivable') {
    const linkedPayments = (state.paymentRecords || []).filter((item) => item.receivableId === record.id);
    if (toMoney(record.paidAmount) > 0 || linkedPayments.length) {
      return { ok: false, error: '这笔待收已经有收款记录，不能直接删除。请先核对对应收款。' };
    }
  }

  if (recordType === 'payment' && record.receivableId) {
    const receivable = (state.receivables || []).find((item) => item.id === record.receivableId);
    if (receivable) {
      related.receivableBefore = cloneRecord(receivable);
      const nextPaidAmount = Math.max(0, toMoney(receivable.paidAmount) - toMoney(record.amount));
      const amount = toMoney(receivable.amount);
      receivable.paidAmount = formatMoneyValue(nextPaidAmount);
      receivable.status = nextPaidAmount <= 0 ? '待收' : (nextPaidAmount >= amount ? '已结清' : '部分收款');
      receivable.updatedAt = new Date().toISOString();
      related.receivableAfter = cloneRecord(receivable);
    }
  }

  collection.splice(index, 1);
  const archive = archiveDeletedRecord(state, recordType, record, related);
  appendOperationLog(state, 'delete_record', recordType, record.id, {
    summary: `删除${({ quotation: '报价', order: '订单', receivable: '待收款', payment: '收款', todo: '提醒', pending: '待整理' })[recordType] || '记录'}`,
    before: record,
    after: { archivedId: archive.id, deletedAt: archive.deletedAt }
  });
  return { ok: true, record: cloneRecord(record), archive };
}

function getReceivableRemaining(receivable) {
  return getReceivableRemainingAmount(receivable);
}

function getPaymentAmount(fields) {
  return fields.paymentAmount || fields.amount || '';
}

function getOrderDepositAmount(state, orderId) {
  return calculateOrderDepositAmount(state, orderId);
}

function getOrderRemainingSettlement(state, order) {
  return calculateOrderRemainingSettlement(state, order);
}

function createPaymentRecord(state, {
  customerId,
  orderId = '',
  receivableId = '',
  amount = '',
  kind = 'receivable_payment',
  remark = '',
  originalText = '',
  paidAt = today()
}) {
  const payment = {
    id: generateId('pay'),
    userId: 'local-user',
    customerId,
    orderId,
    receivableId,
    kind,
    amount: String(amount || ''),
    paidAt,
    remark,
    originalText: originalText || '',
    createdAt: new Date().toISOString()
  };
  state.paymentRecords.unshift(payment);
  return payment;
}

function getReceivableSourceFromDraft(parseResult) {
  const fields = parseResult.fields || {};
  if (fields.orderId) return 'order';
  if (/以前|之前|老账|旧账|历史|原来|早就|去年|上个月/.test(parseResult.original_text || '')) return 'legacy';
  return 'manual';
}

function getCustomerById(state, id) {
  return (state.customers || []).find((customer) => customer.id === id && !customer.mergedInto);
}

function getRecordCustomerLinkError(state, record, fields = {}, recordLabel = '这条记录') {
  const currentCustomer = record ? getCustomerById(state, record.customerId) : null;
  if (!record || !currentCustomer) {
    return { error: `${recordLabel}关联的客户不存在，请先核对原记录。`, field: 'customerId' };
  }
  if (fields.customerId && fields.customerId !== record.customerId) {
    return { error: `选择的客户与${recordLabel}原客户不一致，不能直接改到另一个客户名下。`, field: 'customerId' };
  }
  if (fields.customerName && !customerNameMatches(currentCustomer, fields.customerName)) {
    return { error: `输入的客户与${recordLabel}原客户不一致，请先核对原记录。`, field: 'customerName' };
  }
  return null;
}

function getReceivableOrderLinkError(state, fields = {}) {
  if (!fields.orderId) return null;
  const order = (state.orders || []).find((item) => item.id === fields.orderId);
  if (!order) return { error: '选择的订单不存在，请重新选择。', field: 'orderId' };
  if (order.status === '已取消') {
    return { error: '已取消的订单不能再生成待收款。', field: 'orderId' };
  }
  const customerError = getRecordCustomerLinkError(state, order, fields, '这笔订单');
  if (customerError) return { error: customerError.error, field: 'orderId' };
  const linkedReceivables = (state.receivables || []).filter((item) => item.orderId === order.id);
  if (linkedReceivables.some((item) => item.customerId !== order.customerId)) {
    return { error: '这笔订单已有客户不一致的待收记录，请先人工核对旧数据。', field: 'orderId' };
  }
  if (linkedReceivables.length) {
    return { error: '这笔订单已经有待收款，请到原待收记录中处理。', field: 'orderId' };
  }
  return null;
}

function getOrderQuotationLinkError(state, fields = {}, expectedCustomerId = '') {
  if (!fields.quotationId) return null;
  const quotation = (state.quotations || []).find((item) => item.id === fields.quotationId);
  if (!quotation) return { error: '选择的报价不存在，请重新选择。', field: 'quotationId' };
  if (expectedCustomerId && quotation.customerId !== expectedCustomerId) {
    return { error: '选择的报价不属于这笔订单的客户，请重新选择。', field: 'quotationId' };
  }
  const customerError = getRecordCustomerLinkError(state, quotation, fields, '这笔报价');
  if (customerError) return { error: customerError.error, field: 'quotationId' };
  return null;
}

function hasCustomerDiscriminator(fields = {}) {
  return Boolean(fields.phone || fields.company || fields.region || fields.customerNote || fields.wechatRemark);
}

function getNextDuplicateRemark(state, customerName) {
  const index = findCustomerMatches(state, { customerName }).length + 1;
  return `临时客户${index}`;
}

function findOrCreateCustomer(state, fields) {
  let customer = null;
  if (fields.customerId) {
    const byId = getCustomerById(state, fields.customerId);
    if (customerNameMatches(byId, fields.customerName)) {
      customer = byId;
    }
  }
  if (!customer && fields.forceNewCustomer) {
    customer = null;
  } else if (!customer) {
    const matches = findCustomerMatches(state, fields);
    if (matches.length === 1) customer = matches[0];
    if (matches.length > 1) return null;
  }
  if (customer) {
    customer.updatedAt = new Date().toISOString();
    customer.lastTradeAt = today();
    return customer;
  }
  const created = normalizeCustomer({
    name: fields.customerName || '临时客户',
    phone: fields.phone || '',
    company: fields.company || '',
    region: fields.region || '',
    wechatRemark: fields.wechatRemark || fields.customerNote || (hasCustomerDiscriminator(fields) ? '' : getNextDuplicateRemark(state, fields.customerName))
  });
  created.lastTradeAt = today();
  state.customers.unshift(created);
  return created;
}

function findOrderForDeposit(state, fields = {}, customer = null) {
  const orders = state.orders || [];
  if (fields.orderId) {
    return orders.find((item) => (
      item.id === fields.orderId
      && activeOrderStatuses.includes(item.status)
      && (!customer || item.customerId === customer.id)
    )) || null;
  }
  const customerId = fields.customerId || (customer && customer.id);
  if (!customerId) return null;
  const candidates = orders
    .filter((item) => item.customerId === customerId && activeOrderStatuses.includes(item.status))
    .filter((item) => orderMatchesProduct(item, fields.productName));
  return candidates.length === 1 ? candidates[0] : null;
}

function saveOrderDeposit(state, parseResult, explicitOrder = null, explicitCustomer = null) {
  const fields = parseResult.fields || {};
  const originalText = getOriginalTextFromDraft(parseResult);
  const paymentAmount = toMoney(getPaymentAmount(fields));
  if (paymentAmount <= 0) return null;
  let customer = explicitCustomer;
  if (!customer && fields.customerId) customer = getCustomerById(state, fields.customerId);
  if (!customer && fields.customerName) customer = findOrCreateCustomer(state, fields);
  if (!customer) return null;
  const candidateOrders = (state.orders || [])
    .filter((item) => item.customerId === customer.id && activeOrderStatuses.includes(item.status))
    .filter((item) => orderMatchesProduct(item, fields.productName));
  if (fields.orderId && !findOrderForDeposit(state, fields, customer)) {
    return {
      error: '选择的订单不存在、已结束，或不属于当前客户，请重新选择。',
      field: 'orderId'
    };
  }
  if (fields.orderId && !explicitOrder && fields.orderSelectionConfirmed !== true) {
    return {
      error: '请在确认卡中确认这笔定金属于哪一单，或选择不关联订单。',
      field: 'orderId'
    };
  }
  if (!fields.orderId && !explicitOrder && candidateOrders.length && (
    fields.allowUnlinkedOrderDeposit !== true
    || fields.unlinkedOrderDepositCustomerId !== customer.id
  )) {
    return {
        error: '这个客户有可关联订单，请选择定金属于哪一单，或明确记为未关联订单定金。',
      field: 'orderId'
    };
  }
  const order = explicitOrder || findOrderForDeposit(state, fields, customer);
  if (!order) {
    const payment = createPaymentRecord(state, {
      customerId: customer.id,
      orderId: '',
      receivableId: '',
      amount: paymentAmount,
      kind: 'unlinked_deposit',
      originalText,
      remark: fields.remark || parseResult.original_text || '未关联订单定金'
    });
    appendParseLog(state, parseResult, 'save_unlinked_order_deposit');
    return { order: null, payment };
  }

  const linkedReceivables = (state.receivables || []).filter((item) => item.orderId === order.id);
  if (linkedReceivables.length > 1 || linkedReceivables.some((item) => item.customerId !== order.customerId)) {
    return {
      error: '这笔订单的待收关联不一致，请先人工核对旧数据，不能继续记定金。',
      field: 'orderId'
    };
  }

  const remaining = getOrderRemainingSettlement(state, order);
  if (paymentAmount > remaining) {
    return {
      error: `本次定金不能超过该订单还差的 ${formatMoneyValue(remaining)} 元`,
      field: 'paymentAmount'
    };
  }

  const linkedReceivable = (state.receivables || []).find((item) => item.orderId === order.id);
  const payment = linkedReceivable
    ? recordPayment(state, linkedReceivable.id, paymentAmount, {
      kind: 'deposit',
      originalText,
      remark: fields.remark || parseResult.original_text || '订单定金'
    })
    : createPaymentRecord(state, {
      customerId: order.customerId,
      orderId: order.id,
      receivableId: '',
      amount: paymentAmount,
      kind: 'deposit',
      originalText,
      remark: fields.remark || parseResult.original_text || '订单定金'
    });
  if (!payment) {
    return {
      error: '这笔订单的待收款已结清，不能再记录定金',
      field: 'paymentAmount'
    };
  }
  order.paymentMethod = order.paymentMethod || '预付';
  order.updatedAt = new Date().toISOString();
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: `记录定金 ${payment.amount} 元`,
    createdAt: new Date().toISOString()
  });
  appendParseLog(state, parseResult, 'save_order_deposit');
  return { order, payment };
}

function mergeCustomer(state, keepCustomerId, mergeCustomerId) {
  if (!keepCustomerId || !mergeCustomerId || keepCustomerId === mergeCustomerId) return null;
  const keep = getCustomerById(state, keepCustomerId);
  const source = getCustomerById(state, mergeCustomerId);
  if (!keep || !source) return null;
  ['quotations', 'orders', 'receivables', 'paymentRecords', 'todos'].forEach((collection) => {
    (state[collection] || []).forEach((record) => {
      if (record.customerId === mergeCustomerId) record.customerId = keepCustomerId;
    });
  });
  source.mergedInto = keepCustomerId;
  source.updatedAt = new Date().toISOString();
  keep.updatedAt = new Date().toISOString();
  keep.lastTradeAt = today();
  return keep;
}

function markDuplicateCustomerReviewed(state, customerId) {
  const customer = getCustomerById(state, customerId);
  if (!customer) return null;
  customer.duplicateReviewed = true;
  if (!customer.company && !customer.region && !customer.phoneMasked && !customer.wechatRemark) {
    customer.wechatRemark = getNextDuplicateRemark(state, customer.name);
  }
  customer.updatedAt = new Date().toISOString();
  return customer;
}

function isFormalReady(parseResult, initialState = {}) {
  const reviewed = applyFinalParseSafety(parseResult || {});
  const flowContext = getTrustedRecordFlowContext(reviewed);
  return evaluateRecordDomainPreflight({
    mode: flowContext.mode || 'PRODUCTION_ROUTING',
    resultScope: flowContext.resultScope || 'PRODUCTION_RESULT',
    operation: reviewed.operation,
    businessType: reviewed.intent,
    finalResult: reviewed,
    originalText: getOriginalTextFromDraft(reviewed),
    initialState,
    aiOutcome: flowContext.aiOutcome || (reviewed.ai_fallback || {}).status || 'not_requested',
    providerKind: flowContext.providerKind || (reviewed.ai_fallback || {}).provider_kind || 'NONE',
    skipFinalSafety: true
  }).domainCanSaveFormal;
}

function hasUnresolvedAiResult(parseResult = {}) {
  const routeInfo = parseResult.parse_route || {};
  const route = routeInfo.decision;
  const aiFallback = parseResult.ai_fallback || {};
  const aiStatus = aiFallback.status || 'not_requested';
  const hasVerifiedAiResult = aiStatus === 'used' && aiFallback.business_result_valid === true;
  // 只要本次明确选择了 AI 整理，AI 没有真正返回结果就不能把草稿直接变成正式订单/报价/账款。
  // 页面按钮之外再拦一次，防止以后新增入口时绕过保护。
  return (['ai_standard', 'ai_deep'].includes(route) || routeInfo.deep_review_available === true)
    && !hasVerifiedAiResult;
}

function getUnresolvedAiReason(parseResult = {}) {
  if (!hasUnresolvedAiResult(parseResult)) return '';
  const aiStatus = ((parseResult.ai_fallback || {}).status || 'not_requested');
  if (aiStatus === 'timed_out') return '联网整理等待超时，这条内容先存到待整理，不能直接记成正式业务。';
  if (aiStatus === 'returned_uncertain') return '联网整理没有给出可采用的业务结果，这条内容先存到待整理。';
  if (aiStatus === 'failed') return '联网整理没有成功返回，这条内容先存到待整理，不能直接记成正式业务。';
  if (aiStatus === 'skipped_no_endpoint') return '本次没有连上智能整理服务，这条内容先存到待整理，不能直接记成正式业务。';
  if (aiStatus === 'mock_used') return '本次拿到的是模拟整理结果，不能直接记成正式业务。';
  return '这条内容本应由智能整理复核，结果尚未返回，先存到待整理。';
}

function savePendingNote(state, parseResult, reason = '信息不完整，需要稍后整理') {
  const originalText = getOriginalTextFromDraft(parseResult);
  const note = {
    id: generateId('pending'),
    userId: 'local-user',
    originalText,
    guessedIntent: parseResult.intent,
    guessedFields: parseResult.fields,
    missingFields: parseResult.missing_fields,
    lowConfidenceFields: parseResult.low_confidence_fields,
    fieldConflicts: parseResult.field_conflicts || [],
    source: parseResult.source,
    reason,
    status: '待整理',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.pendingNotes.unshift(note);
  return note;
}

function appendParseLog(state, parseResult, action) {
  state.aiParseLogs = state.aiParseLogs || [];
  state.aiParseLogs.unshift({
    id: generateId('log'),
    userId: 'local-user',
    inputSource: parseResult.source,
    originalText: getOriginalTextFromDraft(parseResult),
    parseResult,
    action,
    createdAt: new Date().toISOString()
  });
  // 诊断记录只保留最近 100 条，避免长期占满手机本地空间。
  state.aiParseLogs.splice(100);
}

function saveQuotation(state, parseResult) {
  ensureProductCatalog(state);
  const fields = parseResult.fields || {};
  const customer = findOrCreateCustomer(state, fields);
  if (!customer) return null;
  const items = normalizeLineItemsFromFields(fields);
  const legacyFields = buildLegacyFieldsFromFirstItem(items, fields);
  const quotation = {
    id: generateId('quo'),
    userId: 'local-user',
    customerId: customer.id,
    productName: legacyFields.productName,
    spec: legacyFields.spec,
    quantity: legacyFields.quantity,
    unit: legacyFields.unit,
    unitPrice: legacyFields.unitPrice,
    priceUnit: legacyFields.priceUnit,
    totalAmount: getDraftTotalAmount(fields, items),
    items,
    originalText: getOriginalTextFromDraft(parseResult),
    paymentMethod: fields.paymentMethod || '',
    followupDays: fields.followupDays || '',
    deliveryDate: fields.dueDate || '',
    quoteDate: fields.quoteDate || today(),
    validUntil: addDays(today(), 7),
    status: '待确认',
    remark: fields.remark || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.quotations.unshift(quotation);
  learnProductCatalogFromRecord(state, quotation, 'quotation', { skipEnsure: true });
  appendParseLog(state, parseResult, 'save_quotation');
  return quotation;
}

function updateQuotationFromDraft(state, parseResult) {
  ensureProductCatalog(state);
  const fields = parseResult.fields || {};
  const quotation = state.quotations.find((item) => item.id === fields.quotationId);
  if (!quotation) return null;
  const customerLinkError = getRecordCustomerLinkError(state, quotation, fields, '这笔报价');
  if (customerLinkError) return customerLinkError;
  if (Array.isArray(fields.items) || fields.productName || fields.spec || fields.quantity || fields.unit || fields.unitPrice || fields.priceUnit || fields.amount || fields.totalAmount) {
    const items = normalizeLineItemsFromFields(fields);
    const legacyFields = buildLegacyFieldsFromFirstItem(items, fields);
    if (items.length) quotation.items = items;
    if (legacyFields.productName) quotation.productName = legacyFields.productName;
    if (legacyFields.spec) quotation.spec = legacyFields.spec;
    if (legacyFields.quantity) quotation.quantity = legacyFields.quantity;
    if (legacyFields.unit) quotation.unit = legacyFields.unit;
    if (legacyFields.unitPrice) quotation.unitPrice = legacyFields.unitPrice;
    if (legacyFields.priceUnit) quotation.priceUnit = legacyFields.priceUnit;
    const totalAmount = getDraftTotalAmount(fields, items);
    if (totalAmount) quotation.totalAmount = totalAmount;
  }
  if (fields.paymentMethod) quotation.paymentMethod = fields.paymentMethod;
  if (fields.followupDays) quotation.followupDays = fields.followupDays;
  if (fields.dueDate) quotation.deliveryDate = fields.dueDate;
  if (fields.quoteDate) quotation.quoteDate = fields.quoteDate;
  if (fields.remark) quotation.remark = fields.remark;
  if (getOriginalTextFromDraft(parseResult)) quotation.originalText = getOriginalTextFromDraft(parseResult);
  quotation.updatedAt = new Date().toISOString();
  learnProductCatalogFromRecord(state, quotation, 'quotation', { skipEnsure: true, incrementUse: false });
  appendParseLog(state, parseResult, 'update_quotation');
  return quotation;
}

function saveOrder(state, parseResult) {
  ensureProductCatalog(state);
  const fields = parseResult.fields || {};
  const quotationLinkError = getOrderQuotationLinkError(state, fields);
  if (quotationLinkError) return quotationLinkError;
  const items = normalizeLineItemsFromFields(fields);
  const draftTotalAmount = getDraftTotalAmount(fields, items);
  const totalAmount = toMoney(draftTotalAmount);
  const depositAmount = toMoney(fields.depositAmount || fields.paymentAmount);
  if (depositAmount > 0 && totalAmount <= 0) {
    return { error: '订单总价不明确，不能直接记录定金。', field: 'depositAmount' };
  }
  if (depositAmount > totalAmount) {
    return {
      error: `定金不能超过订单总价 ${formatMoneyValue(totalAmount)} 元。`,
      field: 'depositAmount'
    };
  }
  const customer = findOrCreateCustomer(state, fields);
  if (!customer) return null;
  if (fields.quotationId) {
    const quotation = (state.quotations || []).find((item) => item.id === fields.quotationId);
    if (!quotation || quotation.customerId !== customer.id) {
      return { error: '选择的报价不属于当前客户，请重新选择。', field: 'quotationId' };
    }
  }
  const legacyFields = buildLegacyFieldsFromFirstItem(items, fields);
  const order = {
    id: generateId('ord'),
    userId: 'local-user',
    customerId: customer.id,
    quotationId: fields.quotationId || '',
    productName: legacyFields.productName,
    spec: legacyFields.spec,
    quantity: legacyFields.quantity,
    unit: legacyFields.unit,
    unitPrice: legacyFields.unitPrice,
    priceUnit: legacyFields.priceUnit,
    totalAmount: draftTotalAmount,
    items,
    originalText: getOriginalTextFromDraft(parseResult),
    paymentMethod: fields.paymentMethod || '',
    orderDate: today(),
    requiredDeliveryDate: fields.dueDate || '',
    expectedShipDate: fields.dueDate || '',
    actualShipDate: '',
    status: '待生产',
    logisticsInfo: '',
    remark: fields.remark || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.orders.unshift(order);
  if (fields.quotationId) {
    const quotation = (state.quotations || []).find((item) => item.id === fields.quotationId);
    markQuotationConverted(quotation, order, order.createdAt);
  }
  learnProductCatalogFromRecord(state, order, 'order', { skipEnsure: true });
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: '创建订单',
    createdAt: new Date().toISOString()
  });
  if (toMoney(fields.depositAmount || fields.paymentAmount) > 0) {
    saveOrderDeposit(state, Object.assign({}, parseResult, {
      fields: Object.assign({}, fields, {
        paymentAmount: fields.depositAmount || fields.paymentAmount,
        paymentKind: 'deposit'
      })
    }), order, customer);
  }
  appendParseLog(state, parseResult, 'save_order');
  return order;
}

function updateOrderFromDraft(state, parseResult) {
  ensureProductCatalog(state);
  const fields = parseResult.fields || {};
  const order = state.orders.find((item) => item.id === fields.orderId);
  if (!order) return null;
  const before = cloneRecord(order);
  const directEdit = parseResult.edit_mode === 'direct_order';
  const customerLinkError = getRecordCustomerLinkError(state, order, fields, '这笔订单');
  if (customerLinkError) return customerLinkError;
  const quotationLinkError = getOrderQuotationLinkError(state, fields, order.customerId);
  if (quotationLinkError) return quotationLinkError;
  if (fields.quotationId || directEdit) order.quotationId = fields.quotationId || '';
  if (Array.isArray(fields.items) || fields.productName || fields.spec || fields.quantity || fields.unit || fields.unitPrice || fields.priceUnit || fields.amount || fields.totalAmount) {
    const items = normalizeLineItemsFromFields(fields);
    const legacyFields = buildLegacyFieldsFromFirstItem(items, fields);
    const totalAmount = getDraftTotalAmount(fields, items);
    const hasFinancialLinks = (state.paymentRecords || []).some((item) => item.orderId === order.id)
      || (state.receivables || []).some((item) => item.orderId === order.id);
    const totalChanged = directEdit
      ? String(totalAmount || '') !== String(order.totalAmount || '')
      : (hasMoneyValue(totalAmount) && toMoney(totalAmount) !== toMoney(order.totalAmount));
    if (hasFinancialLinks && totalChanged) {
      return { error: '这笔订单已有定金、收款或待收，不能直接修改订单总额。其他内容仍可修改。', field: 'amount' };
    }
    if (items.length || directEdit) order.items = items;
    if (legacyFields.productName || directEdit) order.productName = legacyFields.productName || '';
    if (legacyFields.spec || directEdit) order.spec = legacyFields.spec || '';
    if (legacyFields.quantity || directEdit) order.quantity = legacyFields.quantity || '';
    if (legacyFields.unit || directEdit) order.unit = legacyFields.unit || '';
    if (legacyFields.unitPrice || directEdit) order.unitPrice = legacyFields.unitPrice || '';
    if (legacyFields.priceUnit || directEdit) order.priceUnit = legacyFields.priceUnit || '';
    if (totalAmount || directEdit) order.totalAmount = totalAmount || '';
  }
  if (fields.paymentMethod || directEdit) order.paymentMethod = fields.paymentMethod || '';
  if (fields.dueDate || directEdit) {
    order.requiredDeliveryDate = fields.dueDate || '';
    order.expectedShipDate = fields.dueDate || '';
  }
  if (fields.remark || directEdit) order.remark = fields.remark || '';
  if (getOriginalTextFromDraft(parseResult)) order.originalText = getOriginalTextFromDraft(parseResult);
  order.updatedAt = new Date().toISOString();
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: '由记一笔更新订单',
    createdAt: new Date().toISOString()
  });
  appendParseLog(state, parseResult, 'update_order');
  learnProductCatalogFromRecord(state, order, 'order', { skipEnsure: true, incrementUse: false });
  appendOperationLog(state, 'update_order', 'order', order.id, {
    summary: directEdit ? '主动修改订单内容' : '由记一笔更新订单',
    before,
    after: order
  });
  return order;
}

function saveReceivable(state, parseResult) {
  const fields = parseResult.fields;
  const orderLinkError = getReceivableOrderLinkError(state, fields);
  if (orderLinkError) return orderLinkError;
  const customer = findOrCreateCustomer(state, fields);
  if (!customer) return null;
  if (fields.orderId) {
    const order = (state.orders || []).find((item) => item.id === fields.orderId);
    if (!order || order.customerId !== customer.id) {
      return { error: '这笔待收款与所选订单的客户不一致，请重新选择。', field: 'orderId' };
    }
  }
  const originalText = getOriginalTextFromDraft(parseResult);
  const receivable = {
    id: generateId('rec'),
    userId: 'local-user',
    customerId: customer.id,
    orderId: fields.orderId || '',
    amount: fields.amount || '',
    dueDate: fields.dueDate || '',
    status: '待收',
    source: getReceivableSourceFromDraft(parseResult),
    paidAmount: '0',
    dunningCount: 0,
    lastDunningDate: '',
    originalText,
    remark: fields.remark || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.receivables.unshift(receivable);
  appendParseLog(state, parseResult, 'save_receivable');
  return receivable;
}

function saveReceivableWithPayment(state, parseResult) {
  const fields = parseResult.fields;
  const orderLinkError = getReceivableOrderLinkError(state, fields);
  if (orderLinkError) return orderLinkError;
  const customer = findOrCreateCustomer(state, fields);
  if (!customer) return null;
  if (fields.orderId) {
    const order = (state.orders || []).find((item) => item.id === fields.orderId);
    if (!order || order.customerId !== customer.id) {
      return { error: '这笔待收款与所选订单的客户不一致，请重新选择。', field: 'orderId' };
    }
  }
  const originalText = getOriginalTextFromDraft(parseResult);
  const totalAmount = toMoney(fields.amount);
  const paymentAmount = toMoney(getPaymentAmount(fields));
  const receivable = {
    id: generateId('rec'),
    userId: 'local-user',
    customerId: customer.id,
    orderId: fields.orderId || '',
    amount: fields.amount || '',
    dueDate: fields.dueDate || '',
    status: paymentAmount <= 0 ? '待收' : (paymentAmount >= totalAmount ? '已结清' : '部分收款'),
    source: getReceivableSourceFromDraft(parseResult),
    paidAmount: String(paymentAmount),
    dunningCount: 0,
    lastDunningDate: '',
    originalText,
    remark: fields.remark || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.receivables.unshift(receivable);

  let payment = null;
  if (paymentAmount > 0) {
    payment = createPaymentRecord(state, {
      customerId: customer.id,
      orderId: fields.orderId || '',
      receivableId: receivable.id,
      amount: paymentAmount,
      kind: getReceivableSourceFromDraft(parseResult) === 'legacy'
        ? 'legacy_payment'
        : (fields.orderId ? 'final_payment' : 'receivable_payment'),
      originalText,
      remark: fields.remark || '由记一笔新建应收时记录'
    });
  }

  appendParseLog(state, parseResult, 'save_receivable_with_payment');
  return { receivable, payment };
}

function savePayment(state, parseResult) {
  const fields = parseResult.fields;
  const originalText = getOriginalTextFromDraft(parseResult);
  const selectedReceivable = (state.receivables || []).find((item) => item.id === fields.receivableId);
  const activeReceivable = state.receivables.find((item) => (
    item.id === fields.receivableId && activeReceivableStatuses.includes(item.status)
  ));
  const paymentAmount = getPaymentAmount(fields);
  if (fields.receivableId && !activeReceivable) {
    return {
      error: selectedReceivable
        ? '选择的待收款已结清，不能再继续核销。'
        : '选择的待收款不存在，请重新选择。',
      field: 'receivableId'
    };
  }
  if (activeReceivable && fields.customerId && activeReceivable.customerId !== fields.customerId) {
    return {
      error: '选择的待收款不属于当前客户，请重新选择。',
      field: 'receivableId'
    };
  }
  if (activeReceivable && fields.receivableSelectionConfirmed !== true) {
    return {
      error: '请在确认卡中确认本次收哪一笔，或选择不关联本次收款。',
      field: 'receivableId'
    };
  }
  if (activeReceivable && fields.customerName) {
    const receivableCustomer = getCustomerById(state, activeReceivable.customerId);
    if (!customerNameMatches(receivableCustomer, fields.customerName)) {
      return {
        error: '选择的待收款与当前客户不一致，请重新选择。',
        field: 'receivableId'
      };
    }
  }
  if (!activeReceivable) {
    const customer = findOrCreateCustomer(state, fields);
    if (!customer || toMoney(paymentAmount) <= 0) return null;
    const candidates = (state.receivables || [])
      .filter((item) => item.customerId === customer.id && activeReceivableStatuses.includes(item.status));
    if (candidates.length && (
      fields.allowUnlinkedPayment !== true
      || fields.unlinkedPaymentCustomerId !== customer.id
    )) {
      return {
        error: '这个客户有可关联待收款，请选择本次收哪一笔，或明确记为未关联收款。',
        field: 'receivableId'
      };
    }
    const payment = createPaymentRecord(state, {
      customerId: customer.id,
      amount: paymentAmount,
      kind: 'unlinked_payment',
      originalText,
      remark: fields.remark || '未关联收款'
    });
    appendParseLog(state, parseResult, 'save_unlinked_payment');
    return payment;
  }
  const payment = recordPayment(state, activeReceivable.id, paymentAmount, {
    kind: activeReceivable.orderId ? 'final_payment' : 'receivable_payment',
    originalText,
    remark: fields.remark || ''
  });
  if (!payment) return null;
  appendParseLog(state, parseResult, 'save_payment');
  return payment;
}

function saveTodo(state, parseResult) {
  const fields = parseResult.fields || {};
  const originalText = getOriginalTextFromDraft(parseResult);
  state.todos = state.todos || [];
  let customer = null;
  if (fields.customerName || fields.customerId || fields.phone) {
    customer = findOrCreateCustomer(state, fields);
    if (!customer) return null;
  }
  const todo = {
    id: generateId('todo'),
    userId: 'local-user',
    customerId: customer ? customer.id : '',
    title: fields.todoTitle || fields.remark || parseResult.original_text || '待办提醒',
    productName: fields.productName || '',
    quantity: fields.quantity || '',
    unit: fields.unit || '',
    unitPrice: fields.unitPrice || '',
    amount: fields.amount || '',
    receivableId: fields.receivableId || '',
    todoType: fields.todoType || (parseResult.intent === 'dunning' ? 'dunning' : ''),
    remindDate: fields.dueDate || '',
    status: '待办',
    originalText,
    remark: fields.remark || parseResult.original_text || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: ''
  };
  state.todos.unshift(todo);
  appendParseLog(state, parseResult, 'save_todo');
  return todo;
}

function saveConfirmedDraft(state, parseResult) {
  parseResult = applyFinalParseSafety(parseResult || {});
  const flowContext = getTrustedRecordFlowContext(parseResult);
  const preflight = evaluateRecordDomainPreflight({
    mode: flowContext.mode || 'PRODUCTION_ROUTING',
    resultScope: flowContext.resultScope || 'PRODUCTION_RESULT',
    operation: parseResult.operation,
    businessType: parseResult.intent,
    finalResult: parseResult,
    originalText: getOriginalTextFromDraft(parseResult),
    initialState: state,
    aiOutcome: flowContext.aiOutcome || (parseResult.ai_fallback || {}).status || 'not_requested',
    providerKind: flowContext.providerKind || (parseResult.ai_fallback || {}).provider_kind || 'NONE',
    skipFinalSafety: true
  });
  if (!preflight.domainCanSaveFormal) {
    const firstIssue = preflight.blockingIssues[0] || {};
    const preflightReason = getUnresolvedAiReason(parseResult)
      || (firstIssue.code === 'ORDER_TOTAL_UPDATE_WITH_FINANCIAL_LINKS'
        ? '这笔订单已有定金、收款或待收，不能直接修改订单总额。其他内容仍可修改。'
        : '')
      || (firstIssue.messageParams && firstIssue.messageParams.reason)
      || firstIssue.messageKey
      || '信息不完整，需要稍后整理';
    if (parseResult.edit_mode === 'direct_order') {
      return {
        type: 'error',
        error: preflightReason,
        field: firstIssue.field || '',
        preflight
      };
    }
    appendParseLog(state, parseResult, 'save_pending');
    return {
      type: 'pending',
      record: savePendingNote(state, parseResult, preflightReason),
      preflight
    };
  }
  const saveResult = (() => {
  if (parseResult.operation === 'update_quotation') {
    const record = updateQuotationFromDraft(state, parseResult);
    if (record && !record.error) return { type: 'quotation', record };
    if (record && record.error) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: Array.from(new Set(
          (parseResult.low_confidence_fields || []).concat(record.field ? [record.field] : [])
        ))
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult, record.error) };
    }
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['quotationId'] })) };
  }
  if (parseResult.operation === 'update_order') {
    const record = updateOrderFromDraft(state, parseResult);
    if (record && !record.error) return { type: 'order', record };
    if (record && record.error) {
      if (parseResult.edit_mode === 'direct_order') {
        return { type: 'error', error: record.error, field: record.field || '' };
      }
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: Array.from(new Set(
          (parseResult.low_confidence_fields || []).concat(record.field ? [record.field] : [])
        ))
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult, record.error) };
    }
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['orderId'] })) };
  }
  if (parseResult.intent === 'quotation') {
    const record = saveQuotation(state, parseResult);
    if (record) return { type: 'quotation', record };
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '有多个同名客户，需要先确认关联哪一个客户') };
  }
  if (parseResult.intent === 'order') {
    const record = saveOrder(state, parseResult);
    if (record && !record.error) return { type: 'order', record };
    if (record && record.error) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: Array.from(new Set(
          (parseResult.low_confidence_fields || []).concat(record.field ? [record.field] : [])
        ))
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult, record.error) };
    }
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '有多个同名客户，需要先确认关联哪一个客户') };
  }
  if (parseResult.operation === 'record_order_deposit') {
    const record = saveOrderDeposit(state, parseResult);
    if (record && !record.error) return { type: 'order_deposit', record };
    const nextResult = Object.assign({}, parseResult, {
      low_confidence_fields: Array.from(new Set(
        (parseResult.low_confidence_fields || []).concat(record && record.field ? [record.field] : [])
      ))
    });
    appendParseLog(state, nextResult, 'save_pending');
    return {
      type: 'pending',
      record: savePendingNote(state, nextResult, (record && record.error) || '没有找到可关联的唯一订单，先存到待整理')
    };
  }
  if (parseResult.intent === 'receivable') {
    const record = saveReceivable(state, parseResult);
    if (record && !record.error) return { type: 'receivable', record };
    if (record && record.error) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: Array.from(new Set(
          (parseResult.low_confidence_fields || []).concat(record.field ? [record.field] : [])
        ))
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult, record.error) };
    }
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '有多个同名客户，需要先确认关联哪一个客户') };
  }
  if (parseResult.intent === 'todo') {
    const record = saveTodo(state, parseResult);
    if (record) return { type: 'todo', record };
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '有多个同名客户，需要先确认关联哪一个客户') };
  }
  if (parseResult.intent === 'dunning') {
    const record = saveTodo(state, parseResult);
    if (record) return { type: 'todo', record };
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '有多个同名客户，需要先确认关联哪一个客户') };
  }
  if (parseResult.operation === 'create_receivable_with_payment') {
    const fields = parseResult.fields || {};
    const totalAmount = toMoney(fields.amount);
    const paymentAmount = toMoney(getPaymentAmount(fields));
    if (paymentAmount > totalAmount) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: ['paymentAmount']
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult) };
    }
    const record = saveReceivableWithPayment(state, parseResult);
    if (record && !record.error) return { type: 'receivable_with_payment', record };
    if (record && record.error) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: Array.from(new Set(
          (parseResult.low_confidence_fields || []).concat(record.field ? [record.field] : [])
        ))
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult, record.error) };
    }
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '有多个同名客户，需要先确认关联哪一个客户') };
  }
  if (parseResult.intent === 'payment') {
    const fields = parseResult.fields || {};
    const activeReceivable = state.receivables.find((item) => (
      item.id === fields.receivableId && activeReceivableStatuses.includes(item.status)
    ));
    const paymentAmount = toMoney(getPaymentAmount(fields));
    if (activeReceivable && paymentAmount > getReceivableRemaining(activeReceivable)) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: ['paymentAmount']
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult) };
    }
    const record = savePayment(state, parseResult);
    if (record && !record.error) return { type: 'payment', record };
    if (record && record.error) {
      const nextResult = Object.assign({}, parseResult, {
        low_confidence_fields: Array.from(new Set(
          (parseResult.low_confidence_fields || []).concat(record.field ? [record.field] : [])
        ))
      });
      appendParseLog(state, nextResult, 'save_pending');
      return { type: 'pending', record: savePendingNote(state, nextResult, record.error) };
    }
    return { type: 'pending', record: savePendingNote(state, Object.assign({}, parseResult, { missing_fields: ['customerId'] }), '缺少可确认的客户，先存到待整理') };
  }
  appendParseLog(state, parseResult, 'save_pending');
  return { type: 'pending', record: savePendingNote(state, parseResult) };
  })();
  return Object.assign({}, saveResult, { preflight });
}

function isQuotationConverted(quotation = {}) {
  return Boolean(quotation.convertedOrderId)
    || ['converted', 'ordered', '已转订单', '已下单'].includes(String(quotation.status || ''));
}

function findConvertedOrder(state, quotation = {}) {
  if (!quotation) return null;
  return (state.orders || []).find((item) => (
    (quotation.convertedOrderId && item.id === quotation.convertedOrderId)
    || item.quotationId === quotation.id
  )) || null;
}

function markQuotationConverted(quotation, order, convertedAt) {
  if (!quotation || !order) return;
  quotation.status = '已转订单';
  quotation.convertedOrderId = order.id;
  quotation.convertedAt = quotation.convertedAt || convertedAt;
  quotation.updatedAt = convertedAt;
}

function convertQuotationToOrder(state, quotationId, options = {}) {
  ensureProductCatalog(state);
  const quotation = state.quotations.find((item) => item.id === quotationId);
  if (!quotation) return null;
  const existingOrder = findConvertedOrder(state, quotation);
  const now = new Date().toISOString();
  const requiredDeliveryDate = String(options.requiredDeliveryDate || '').trim();
  if (isQuotationConverted(quotation)) {
    if (existingOrder && requiredDeliveryDate && !existingOrder.requiredDeliveryDate) {
      existingOrder.requiredDeliveryDate = requiredDeliveryDate;
      existingOrder.expectedShipDate = requiredDeliveryDate;
      existingOrder.updatedAt = now;
      state.orderProgress.unshift({
        id: generateId('prog'),
        orderId: existingOrder.id,
        status: existingOrder.status,
        note: `补充交期：${requiredDeliveryDate}`,
        createdAt: now
      });
    }
    if (existingOrder) markQuotationConverted(quotation, existingOrder, now);
    return existingOrder;
  }
  const items = getRecordItems(quotation);
  const legacyFields = buildLegacyFieldsFromFirstItem(items, quotation);
  const order = {
    id: generateId('ord'),
    userId: quotation.userId,
    customerId: quotation.customerId,
    quotationId: quotation.id,
    productName: legacyFields.productName,
    spec: legacyFields.spec,
    quantity: legacyFields.quantity,
    unit: legacyFields.unit,
    unitPrice: legacyFields.unitPrice,
    priceUnit: legacyFields.priceUnit,
    totalAmount: quotation.totalAmount,
    items,
    originalText: quotation.originalText || '',
    paymentMethod: quotation.paymentMethod,
    orderDate: today(),
    requiredDeliveryDate,
    expectedShipDate: requiredDeliveryDate,
    actualShipDate: '',
    status: '待生产',
    logisticsInfo: '',
    remark: `由报价 ${quotation.id} 转入`,
    createdAt: now,
    updatedAt: now
  };
  state.orders.unshift(order);
  learnProductCatalogFromRecord(state, order, 'order', { skipEnsure: true });
  markQuotationConverted(quotation, order, now);
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: '报价转订单',
    createdAt: now
  });
  return order;
}

function generateReceivableFromOrder(state, orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order || order.status === '已取消') return null;
  const existing = state.receivables.find((item) => item.orderId === orderId);
  if (existing) return existing.customerId === order.customerId ? existing : null;
  const depositAmount = getOrderDepositAmount(state, orderId);
  const totalAmount = toMoney(order.totalAmount || '0');
  const paidAmount = Math.min(depositAmount, totalAmount);
  const receivable = {
    id: generateId('rec'),
    userId: order.userId,
    customerId: order.customerId,
    orderId: order.id,
    amount: order.totalAmount || '0',
    dueDate: order.requiredDeliveryDate || '',
    status: paidAmount <= 0 ? '待收' : (paidAmount >= totalAmount ? '已结清' : '部分收款'),
    source: 'order',
    paidAmount: String(paidAmount),
    dunningCount: 0,
    lastDunningDate: '',
    remark: `由订单 ${order.id} 生成`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.receivables.unshift(receivable);
  (state.paymentRecords || []).forEach((payment) => {
    if (payment.orderId === orderId && depositKinds.includes(payment.kind || payment.paymentKind) && !payment.receivableId) {
      payment.receivableId = receivable.id;
    }
  });
  return receivable;
}

function updateOrderStatus(state, orderId, status) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return null;
  const before = cloneRecord(order);
  if (status === '已取消') {
    const hasMoneyRecord = (state.paymentRecords || []).some((item) => item.orderId === orderId)
      || (state.receivables || []).some((item) => item.orderId === orderId);
    // 已经发生定金、收款或待收款时，取消不是简单改一个状态。
    // 这里先阻止自动改账，后续必须通过专门的退款/冲销确认流程处理。
    if (hasMoneyRecord) return null;
  }
  order.status = status;
  order.updatedAt = new Date().toISOString();
  if (status === '已发货') order.actualShipDate = today();
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status,
    note: '手动更新进度',
    createdAt: new Date().toISOString()
  });
  appendOperationLog(state, 'update_order_status', 'order', order.id, {
    summary: `订单进度：${before.status || '-'} → ${status}`,
    before,
    after: order
  });
  return order;
}

function setOrderDeliveryDate(state, orderId, requiredDeliveryDate) {
  const order = state.orders.find((item) => item.id === orderId);
  const date = String(requiredDeliveryDate || '').trim();
  if (!order || !date) return null;
  const before = cloneRecord(order);
  order.requiredDeliveryDate = date;
  order.expectedShipDate = date;
  order.updatedAt = new Date().toISOString();
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: `更新交期：${date}`,
    createdAt: new Date().toISOString()
  });
  appendOperationLog(state, 'update_order_delivery_date', 'order', order.id, {
    summary: `订单交期：${before.requiredDeliveryDate || '未设置'} → ${date}`,
    before,
    after: order
  });
  return order;
}

function completeTodo(state, todoId) {
  const todo = (state.todos || []).find((item) => item.id === todoId);
  if (!todo) return null;
  todo.status = '已完成';
  todo.completedAt = new Date().toISOString();
  todo.updatedAt = new Date().toISOString();
  return todo;
}

function getReceivablePaymentError(receivable, amount) {
  return getReceivablePaymentIssue(receivable, amount);
}

function recordPayment(state, receivableId, amount, options = {}) {
  const receivable = state.receivables.find((item) => item.id === receivableId);
  if (getReceivablePaymentError(receivable, amount)) return null;
  if (receivable.orderId) {
    const order = (state.orders || []).find((item) => item.id === receivable.orderId);
    if (!order || order.customerId !== receivable.customerId) return null;
  }
  const paymentAmount = toMoney(amount);
  const paid = toMoney(receivable.paidAmount) + paymentAmount;
  receivable.paidAmount = String(paid);
  receivable.status = paid >= toMoney(receivable.amount) ? '已结清' : '部分收款';
  receivable.updatedAt = new Date().toISOString();
  const payment = createPaymentRecord(state, {
    customerId: receivable.customerId,
    orderId: receivable.orderId || '',
    receivableId: receivable.id,
    amount: paymentAmount,
    kind: options.kind || (receivable.orderId ? 'final_payment' : 'receivable_payment'),
    originalText: options.originalText || '',
    remark: options.remark || ''
  });
  return payment;
}

function generateDunningMessage(state, receivableId, tone = 'polite') {
  const receivable = state.receivables.find((item) => item.id === receivableId);
  if (!receivable || !activeReceivableStatuses.includes(receivable.status)) return '';
  const customer = getCustomerById(state, receivable.customerId);
  const templates = state.dunningTemplates || [];
  const template = templates.find((item) => item.id === tone) || templates[0];
  if (!template || !template.content) return '';
  return template.content
    .replace('{customer}', customer ? customer.name : '老板')
    .replace('{amount}', `${formatMoneyValue(getReceivableRemaining(receivable))}元`);
}

function recordDunning(state, receivableId, message) {
  const receivable = state.receivables.find((item) => item.id === receivableId);
  if (!receivable || !activeReceivableStatuses.includes(receivable.status) || !message) return null;
  receivable.dunningCount = Number(receivable.dunningCount || 0) + 1;
  receivable.lastDunningDate = today();
  receivable.updatedAt = new Date().toISOString();
  const record = {
    id: generateId('dun'),
    receivableId,
    method: '微信复制',
    message,
    createdAt: new Date().toISOString(),
    note: ''
  };
  state.dunningRecords.unshift(record);
  return record;
}

function getDashboard(state) {
  const current = today();
  const activeReceivables = state.receivables.filter((item) => !['已结清', '坏账'].includes(item.status));
  const dueToday = activeReceivables.filter((item) => item.dueDate === current);
  const overdue = activeReceivables.filter((item) => item.dueDate && diffDays(item.dueDate, current) < 0);
  const deliverySoon = state.orders.filter((item) => {
    if (['已完成', '已取消'].includes(item.status) || !item.requiredDeliveryDate) return false;
    const days = diffDays(item.requiredDeliveryDate, current);
    return days <= 3;
  });
  const quoteFollowups = state.quotations.filter((item) => {
    if (item.status !== '待确认') return false;
    if (item.deliveryDate) return diffDays(item.deliveryDate, current) <= 0;
    return diffDays(current, item.quoteDate) >= 3;
  });
  const pendingNotes = state.pendingNotes.filter((item) => item.status === '待整理');
  const activeTodos = (state.todos || []).filter((item) => item.status !== '已完成');
  const todoDueToday = activeTodos.filter((item) => item.remindDate === current);
  const todoOverdue = activeTodos.filter((item) => item.remindDate && diffDays(item.remindDate, current) < 0);
  const todoTomorrow = activeTodos.filter((item) => item.remindDate && diffDays(item.remindDate, current) === 1);
  return {
    totalThings: dueToday.length + overdue.length + deliverySoon.length + quoteFollowups.length + pendingNotes.length + activeTodos.length,
    dueToday,
    overdue,
    deliverySoon,
    quoteFollowups,
    pendingNotes,
    todoActive: activeTodos,
    todoDueToday,
    todoOverdue,
    todoTomorrow
  };
}

function decorateRecords(state, records) {
  return records.map((record) => {
    const customer = getCustomerById(state, record.customerId);
    return Object.assign({}, record, {
      customer,
      customerDisplay: getCustomerDisplay(customer)
    });
  });
}

module.exports = {
  activeOrderStatuses,
  activeReceivableStatuses,
  appendOperationLog,
  buildOrderEditDraft,
  completeTodo,
  convertQuotationToOrder,
  decorateRecords,
  findCustomerMatches,
  generateDunningMessage,
  generateReceivableFromOrder,
  getCustomerById,
  getDashboard,
  getUnresolvedAiReason,
  getReceivablePaymentError,
  getItemsSummary,
  getDraftTotalAmount,
  markDuplicateCustomerReviewed,
  mergeCustomer,
  orderMatchesProduct,
  recordDunning,
  recordPayment,
  getRecordItems,
  saveConfirmedDraft,
  savePendingNote,
  softDeleteRecord,
  getOrderDepositAmount,
  getOrderRemainingSettlement,
  isFormalReady,
  setOrderDeliveryDate,
  updateOrderStatus
};
