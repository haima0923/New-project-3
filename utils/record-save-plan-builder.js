const { addDays } = require('./date');
const { normalizeUnit, unitsMatch } = require('./units');
const { maskPhone, simpleFingerprint } = require('./customer-identity');
const { getDraftTotalAmount } = require('./business');
const {
  businessDateFromInstant,
  normalizeBusinessDate,
  normalizeBusinessTimezone,
  normalizeNowInstant
} = require('./record-flow-runtime');
const {
  buildRecordConfirmation
} = require('./record-confirmation-builder');
const {
  evaluateRecordDomainPreflight,
  getTrustedRecordFlowContext
} = require('./record-domain-preflight');
const {
  COLLECTION_BY_ENTITY,
  COMMIT_TARGET_POLICIES,
  ENTITY_BY_COLLECTION,
  SAVE_ACTIONS,
  SAVE_PLAN_SCHEMA_VERSION,
  isTemporaryRecordId,
  isTemporaryReferencePath,
  normalizeSaveAction
} = require('./record-save-plan-contract');
const {
  FULL_COLLECTIONS,
  createEmptyStateDiff,
  createStateDiff,
  getStateFingerprint,
  normalizeDomainState,
  safeClone,
  stableHash,
  stableSerialize
} = require('./record-state-diff');

const TEMP_PREFIX_BY_COLLECTION = Object.freeze({
  customers: 'customer', quotations: 'quotation', orders: 'order', receivables: 'receivable',
  paymentRecords: 'payment', todos: 'todo', pendingNotes: 'pending', orderProgress: 'progress',
  aiParseLogs: 'parse-log', operationLogs: 'operation-log', productCatalog: 'product',
  dunningRecords: 'dunning', deletedRecords: 'deleted'
});

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
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

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function uniqueTexts(values) {
  return (values || []).map((value) => String(value || '').trim()).filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function readClock(clock) {
  let value;
  if (typeof clock === 'function') value = clock();
  else if (clock && typeof clock.now === 'function') value = clock.now();
  else value = new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error('clock没有返回有效时间。');
    error.code = 'CLOCK_INVALID_RESULT';
    throw error;
  }
  return date.toISOString();
}

function nextInjectedId(idGenerator, scope) {
  let value;
  if (typeof idGenerator === 'function') value = idGenerator(scope);
  else if (idGenerator && typeof idGenerator.next === 'function') value = idGenerator.next(scope);
  else value = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const normalized = String(value || '').trim();
  if (!normalized) {
    const error = new Error(`idGenerator没有为${scope}返回有效ID。`);
    error.code = 'ID_GENERATOR_INVALID_RESULT';
    throw error;
  }
  return normalized;
}

function createTemporaryIdFactory() {
  const counts = {};
  return (collection) => {
    const prefix = TEMP_PREFIX_BY_COLLECTION[collection] || collection || 'record';
    counts[prefix] = Number(counts[prefix] || 0) + 1;
    return `temp:${prefix}:${counts[prefix]}`;
  };
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
  if (!hasValue(next.totalAmount)
    && Number.isFinite(Number(next.quantity))
    && Number.isFinite(Number(next.unitPrice))
    && unitsMatch(next.unit, next.priceUnit)) {
    next.totalAmount = formatMoney(Number(next.quantity) * Number(next.unitPrice));
  }
  return next;
}

function hasLineItemValue(item = {}) {
  return ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'itemDeliveryDate', 'itemRemark']
    .some((field) => hasValue(item[field]));
}

function getItemsFromFields(fields = {}) {
  const items = (Array.isArray(fields.items) ? fields.items : [])
    .map(normalizeLineItem)
    .filter(hasLineItemValue);
  if (items.length) return items;
  const legacy = normalizeLineItem(fields);
  return hasLineItemValue(legacy) ? [legacy] : [];
}

function getLegacyFields(items, fields) {
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

function getOriginalText(result = {}) {
  const fields = result.fields || {};
  return result.original_text || result.originalText || fields.originalText || fields.original_text || '';
}

function getReceivableSource(result = {}) {
  const fields = result.fields || {};
  if (fields.orderId) return 'order';
  if (/以前|之前|老账|旧账|历史|原来|早就|去年|上个月/.test(getOriginalText(result))) return 'legacy';
  return 'manual';
}

function findById(state, collection, id) {
  return (state[collection] || []).find((item) => String(item.id || '') === String(id || '')) || null;
}

function prepend(state, collection, record) {
  if (!Array.isArray(state[collection])) state[collection] = [];
  state[collection].unshift(record);
  return record;
}

function buildCustomerRecord(fields, runtime, id) {
  const phone = String(fields.phone || '').replace(/\s+/g, '');
  const hasDiscriminator = Boolean(phone || fields.company || fields.region || fields.customerNote || fields.wechatRemark);
  return {
    id,
    userId: 'local-user',
    name: fields.customerName || '临时客户',
    phoneMasked: maskPhone(phone),
    phoneFingerprint: simpleFingerprint(phone),
    company: fields.company || '',
    region: fields.region || '',
    wechatRemark: fields.wechatRemark || fields.customerNote || (hasDiscriminator ? '' : runtime.duplicateCustomerRemark),
    duplicateReviewed: false,
    mergedInto: '',
    tags: [],
    isTemporary: !phone,
    createdAt: runtime.nowInstant,
    updatedAt: runtime.nowInstant,
    lastTradeAt: runtime.businessDate
  };
}

function resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, options = {}) {
  const resolvedId = (preflight.resolvedRelations || {}).customerId || fields.customerId || '';
  let customer = resolvedId ? findById(state, 'customers', resolvedId) : null;
  if (customer) {
    if (options.touch !== false) {
      customer.updatedAt = runtime.nowInstant;
      customer.lastTradeAt = runtime.businessDate;
    }
    return customer;
  }
  if (!fields.customerName && options.required !== true) return null;
  const sameNameCount = (state.customers || []).filter((item) => normalizeName(item.name) === normalizeName(fields.customerName)).length;
  runtime.duplicateCustomerRemark = `临时客户${sameNameCount + 1}`;
  customer = buildCustomerRecord(fields, runtime, nextTempId('customers'));
  prepend(state, 'customers', customer);
  return customer;
}

function normalizeSpecEntries(specs) {
  return (specs || []).map((spec) => {
    if (typeof spec === 'string') return { name: String(spec).trim(), useCount: 0, lastUsedAt: '' };
    return { name: String(spec.name || spec.spec || '').trim(), useCount: Number(spec.useCount || 0), lastUsedAt: spec.lastUsedAt || '' };
  }).filter((item) => item.name);
}

function mergeCatalogSpec(item, specName, usedAt, incrementUse) {
  const name = String(specName || '').trim();
  if (!name) return;
  item.specs = normalizeSpecEntries(item.specs);
  let spec = item.specs.find((entry) => normalizeName(entry.name) === normalizeName(name));
  if (!spec) {
    spec = { name, useCount: 0, lastUsedAt: '' };
    item.specs.push(spec);
  }
  if (incrementUse) spec.useCount += 1;
  spec.lastUsedAt = usedAt;
  item.specs.sort((left, right) => right.useCount - left.useCount || String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)));
}

function upsertCatalog(state, data, runtime, nextTempId, incrementUse) {
  const productName = String(data.productName || '').trim();
  if (!productName) return null;
  let item = (state.productCatalog || []).find((entry) => (
    entry.normalizedName === normalizeName(productName) || normalizeName(entry.productName) === normalizeName(productName)
  ));
  if (!item) {
    item = {
      id: nextTempId('productCatalog'), userId: (state.meta && state.meta.userId) || 'local-user',
      productName, normalizedName: normalizeName(productName), specs: [], units: [], priceUnits: [],
      lastUnitPrice: '', useCount: 0, sourceTypes: [], createdAt: data.usedAt,
      updatedAt: data.usedAt, lastUsedAt: data.usedAt
    };
    state.productCatalog.push(item);
  }
  item.productName = productName;
  item.normalizedName = normalizeName(productName);
  mergeCatalogSpec(item, data.spec, data.usedAt, incrementUse);
  item.units = uniqueTexts([].concat(item.units || [], normalizeUnit(data.unit || '')));
  item.priceUnits = uniqueTexts([].concat(item.priceUnits || [], normalizeUnit(data.priceUnit || '')));
  if (hasValue(data.unitPrice)) item.lastUnitPrice = String(data.unitPrice);
  if (data.sourceType) item.sourceTypes = uniqueTexts([].concat(item.sourceTypes || [], data.sourceType));
  if (incrementUse) item.useCount = Number(item.useCount || 0) + 1;
  item.lastUsedAt = data.usedAt;
  item.updatedAt = runtime.nowInstant;
  state.productCatalog.sort((left, right) => Number(right.useCount || 0) - Number(left.useCount || 0)
    || String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || '')));
  return item;
}

function learnCatalog(state, record, sourceType, runtime, nextTempId, incrementUse = true) {
  const items = Array.isArray(record.items) && record.items.length
    ? record.items
    : getItemsFromFields(record);
  items.forEach((item) => upsertCatalog(state, {
    productName: item.productName, spec: item.spec, unit: item.unit, priceUnit: item.priceUnit,
    unitPrice: item.unitPrice, sourceType, usedAt: record.updatedAt || record.createdAt || runtime.nowInstant
  }, runtime, nextTempId, incrementUse));
}

function ensureCatalog(state, sourceState, runtime, nextTempId) {
  if (Array.isArray(sourceState.productCatalog)) return;
  state.productCatalog = [];
  const history = []
    .concat((state.quotations || []).map((record) => ({ record, sourceType: 'quotation' })))
    .concat((state.orders || []).map((record) => ({ record, sourceType: 'order' })))
    .sort((left, right) => String(left.record.createdAt || left.record.updatedAt || '')
      .localeCompare(String(right.record.createdAt || right.record.updatedAt || '')));
  history.forEach((entry) => learnCatalog(state, entry.record, entry.sourceType, runtime, nextTempId, true));
}

function appendParseLog(state, result, action, runtime, nextTempId) {
  prepend(state, 'aiParseLogs', {
    id: nextTempId('aiParseLogs'),
    userId: 'local-user',
    inputSource: result.source,
    originalText: getOriginalText(result),
    parseResult: safeClone(result),
    action,
    createdAt: runtime.nowInstant
  });
  state.aiParseLogs.splice(100);
}

function appendOperationLog(state, action, recordType, recordId, before, after, summary, runtime, nextTempId) {
  prepend(state, 'operationLogs', {
    id: nextTempId('operationLogs'), action, recordType, recordId, summary: summary || '',
    before: before ? safeClone(before) : null, after: after ? safeClone(after) : null,
    createdAt: runtime.nowInstant
  });
}

function createPayment(state, data, runtime, nextTempId) {
  return prepend(state, 'paymentRecords', {
    id: nextTempId('paymentRecords'), userId: 'local-user', customerId: data.customerId,
    orderId: data.orderId || '', receivableId: data.receivableId || '', kind: data.kind || 'receivable_payment',
    amount: String(data.amount || ''), paidAt: runtime.businessDate, remark: data.remark || '',
    originalText: data.originalText || '', createdAt: runtime.nowInstant
  });
}

function applyPaymentToReceivable(state, receivable, amount, options, runtime, nextTempId) {
  const paid = toMoney(receivable.paidAmount) + toMoney(amount);
  receivable.paidAmount = String(paid);
  receivable.status = paid >= toMoney(receivable.amount) ? '已结清' : '部分收款';
  receivable.updatedAt = runtime.nowInstant;
  return createPayment(state, {
    customerId: receivable.customerId,
    orderId: receivable.orderId || '',
    receivableId: receivable.id,
    amount: toMoney(amount),
    kind: options.kind || (receivable.orderId ? 'final_payment' : 'receivable_payment'),
    originalText: options.originalText,
    remark: options.remark
  }, runtime, nextTempId);
}

function simulateFormalSave(sourceState, finalResult, preflight, runtime, nextTempId) {
  const state = normalizeDomainState(sourceState);
  const fields = safeClone(finalResult.fields || {});
  const originalText = getOriginalText(finalResult);
  const operation = finalResult.operation || '';
  const intent = finalResult.intent || 'unknown';

  if (operation === 'update_quotation') {
    ensureCatalog(state, sourceState, runtime, nextTempId);
    const quotation = findById(state, 'quotations', fields.quotationId);
    const items = getItemsFromFields(fields);
    const legacy = getLegacyFields(items, fields);
    if (items.length) quotation.items = items;
    ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'].forEach((key) => {
      if (legacy[key]) quotation[key] = legacy[key];
    });
    const total = getDraftTotalAmount(fields, items);
    if (total) quotation.totalAmount = total;
    if (fields.paymentMethod) quotation.paymentMethod = fields.paymentMethod;
    if (fields.followupDays) quotation.followupDays = fields.followupDays;
    if (fields.dueDate) quotation.deliveryDate = fields.dueDate;
    if (fields.quoteDate) quotation.quoteDate = fields.quoteDate;
    if (fields.remark) quotation.remark = fields.remark;
    if (originalText) quotation.originalText = originalText;
    quotation.updatedAt = runtime.nowInstant;
    learnCatalog(state, quotation, 'quotation', runtime, nextTempId, false);
    appendParseLog(state, finalResult, 'update_quotation', runtime, nextTempId);
    return state;
  }

  if (operation === 'update_order') {
    ensureCatalog(state, sourceState, runtime, nextTempId);
    const order = findById(state, 'orders', fields.orderId);
    const before = safeClone(order);
    const directEdit = finalResult.edit_mode === 'direct_order';
    if (fields.quotationId || directEdit) order.quotationId = fields.quotationId || '';
    const items = getItemsFromFields(fields);
    const legacy = getLegacyFields(items, fields);
    if (items.length || directEdit) order.items = items;
    ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'].forEach((key) => {
      if (legacy[key] || directEdit) order[key] = legacy[key] || '';
    });
    const total = getDraftTotalAmount(fields, items);
    if (total || directEdit) order.totalAmount = total || '';
    if (fields.paymentMethod || directEdit) order.paymentMethod = fields.paymentMethod || '';
    if (fields.dueDate || directEdit) {
      order.requiredDeliveryDate = fields.dueDate || '';
      order.expectedShipDate = fields.dueDate || '';
    }
    if (fields.remark || directEdit) order.remark = fields.remark || '';
    if (originalText) order.originalText = originalText;
    order.updatedAt = runtime.nowInstant;
    prepend(state, 'orderProgress', {
      id: nextTempId('orderProgress'), orderId: order.id, status: order.status,
      note: '由记一笔更新订单', createdAt: runtime.nowInstant
    });
    appendParseLog(state, finalResult, 'update_order', runtime, nextTempId);
    learnCatalog(state, order, 'order', runtime, nextTempId, false);
    appendOperationLog(
      state, 'update_order', 'order', order.id, before, order,
      directEdit ? '主动修改订单内容' : '由记一笔更新订单', runtime, nextTempId
    );
    return state;
  }

  if (intent === 'quotation') {
    ensureCatalog(state, sourceState, runtime, nextTempId);
    const customer = resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, { required: true });
    const items = getItemsFromFields(fields);
    const legacy = getLegacyFields(items, fields);
    const quotation = {
      id: nextTempId('quotations'), userId: 'local-user', customerId: customer.id,
      productName: legacy.productName, spec: legacy.spec, quantity: legacy.quantity, unit: legacy.unit,
      unitPrice: legacy.unitPrice, priceUnit: legacy.priceUnit, totalAmount: getDraftTotalAmount(fields, items),
      items, originalText, paymentMethod: fields.paymentMethod || '', followupDays: fields.followupDays || '',
      deliveryDate: fields.dueDate || '', quoteDate: fields.quoteDate || runtime.businessDate,
      validUntil: addDays(runtime.businessDate, 7), status: '待确认', remark: fields.remark || '',
      createdAt: runtime.nowInstant, updatedAt: runtime.nowInstant
    };
    prepend(state, 'quotations', quotation);
    learnCatalog(state, quotation, 'quotation', runtime, nextTempId, true);
    appendParseLog(state, finalResult, 'save_quotation', runtime, nextTempId);
    return state;
  }

  if (intent === 'order') {
    ensureCatalog(state, sourceState, runtime, nextTempId);
    const customer = resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, { required: true });
    const items = getItemsFromFields(fields);
    const legacy = getLegacyFields(items, fields);
    const order = {
      id: nextTempId('orders'), userId: 'local-user', customerId: customer.id,
      quotationId: fields.quotationId || '', productName: legacy.productName, spec: legacy.spec,
      quantity: legacy.quantity, unit: legacy.unit, unitPrice: legacy.unitPrice, priceUnit: legacy.priceUnit,
      totalAmount: getDraftTotalAmount(fields, items), items, originalText, paymentMethod: fields.paymentMethod || '',
      orderDate: runtime.businessDate, requiredDeliveryDate: fields.dueDate || '', expectedShipDate: fields.dueDate || '',
      actualShipDate: '', status: '待生产', logisticsInfo: '', remark: fields.remark || '',
      createdAt: runtime.nowInstant, updatedAt: runtime.nowInstant
    };
    prepend(state, 'orders', order);
    if (fields.quotationId) {
      const quotation = findById(state, 'quotations', fields.quotationId);
      quotation.status = '已转订单';
      quotation.convertedOrderId = order.id;
      quotation.convertedAt = quotation.convertedAt || runtime.nowInstant;
      quotation.updatedAt = runtime.nowInstant;
    }
    learnCatalog(state, order, 'order', runtime, nextTempId, true);
    prepend(state, 'orderProgress', {
      id: nextTempId('orderProgress'), orderId: order.id, status: order.status,
      note: '创建订单', createdAt: runtime.nowInstant
    });
    const depositAmount = toMoney(fields.depositAmount || fields.paymentAmount);
    if (depositAmount > 0) {
      createPayment(state, {
        customerId: customer.id, orderId: order.id, amount: depositAmount, kind: 'deposit',
        originalText, remark: fields.remark || finalResult.original_text || '订单定金'
      }, runtime, nextTempId);
      order.paymentMethod = order.paymentMethod || '预付';
      order.updatedAt = runtime.nowInstant;
      prepend(state, 'orderProgress', {
        id: nextTempId('orderProgress'), orderId: order.id, status: order.status,
        note: `记录定金 ${formatMoney(depositAmount)} 元`, createdAt: runtime.nowInstant
      });
      appendParseLog(state, Object.assign({}, finalResult, {
        fields: Object.assign({}, fields, { paymentAmount: fields.depositAmount || fields.paymentAmount, paymentKind: 'deposit' })
      }), 'save_order_deposit', runtime, nextTempId);
    }
    appendParseLog(state, finalResult, 'save_order', runtime, nextTempId);
    return state;
  }

  if (operation === 'record_order_deposit') {
    const orderId = fields.orderId || (preflight.resolvedRelations || {}).orderId || '';
    const order = orderId ? findById(state, 'orders', orderId) : null;
    let customer = order ? findById(state, 'customers', order.customerId) : null;
    if (!customer) customer = resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, { required: true, touch: !fields.customerId });
    const amount = toMoney(fields.paymentAmount || fields.depositAmount || fields.amount);
    if (!order) {
      createPayment(state, {
        customerId: customer.id, amount, kind: 'unlinked_deposit', originalText,
        remark: fields.remark || finalResult.original_text || '未关联订单定金'
      }, runtime, nextTempId);
      appendParseLog(state, finalResult, 'save_unlinked_order_deposit', runtime, nextTempId);
      return state;
    }
    const linkedReceivable = (state.receivables || []).find((item) => item.orderId === order.id) || null;
    if (linkedReceivable) {
      applyPaymentToReceivable(state, linkedReceivable, amount, {
        kind: 'deposit', originalText, remark: fields.remark || finalResult.original_text || '订单定金'
      }, runtime, nextTempId);
    } else {
      createPayment(state, {
        customerId: order.customerId, orderId: order.id, amount, kind: 'deposit', originalText,
        remark: fields.remark || finalResult.original_text || '订单定金'
      }, runtime, nextTempId);
    }
    order.paymentMethod = order.paymentMethod || '预付';
    order.updatedAt = runtime.nowInstant;
    prepend(state, 'orderProgress', {
      id: nextTempId('orderProgress'), orderId: order.id, status: order.status,
      note: `记录定金 ${formatMoney(amount)} 元`, createdAt: runtime.nowInstant
    });
    appendParseLog(state, finalResult, 'save_order_deposit', runtime, nextTempId);
    return state;
  }

  if (intent === 'receivable' || operation === 'create_receivable_with_payment') {
    const customer = resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, { required: true });
    const amount = fields.amount || '';
    const paymentAmount = operation === 'create_receivable_with_payment'
      ? toMoney(fields.paymentAmount || fields.amount || '')
      : 0;
    const receivable = {
      id: nextTempId('receivables'), userId: 'local-user', customerId: customer.id,
      orderId: fields.orderId || '', amount, dueDate: fields.dueDate || '',
      status: paymentAmount <= 0 ? '待收' : (paymentAmount >= toMoney(amount) ? '已结清' : '部分收款'),
      source: getReceivableSource(finalResult), paidAmount: String(paymentAmount), dunningCount: 0,
      lastDunningDate: '', originalText, remark: fields.remark || '',
      createdAt: runtime.nowInstant, updatedAt: runtime.nowInstant
    };
    prepend(state, 'receivables', receivable);
    if (paymentAmount > 0) {
      createPayment(state, {
        customerId: customer.id, orderId: fields.orderId || '', receivableId: receivable.id,
        amount: paymentAmount,
        kind: getReceivableSource(finalResult) === 'legacy' ? 'legacy_payment' : (fields.orderId ? 'final_payment' : 'receivable_payment'),
        originalText, remark: fields.remark || '由记一笔新建应收时记录'
      }, runtime, nextTempId);
    }
    appendParseLog(
      state, finalResult,
      operation === 'create_receivable_with_payment' ? 'save_receivable_with_payment' : 'save_receivable',
      runtime, nextTempId
    );
    return state;
  }

  if (intent === 'payment') {
    const receivableId = fields.receivableId || (preflight.resolvedRelations || {}).receivableId || '';
    const receivable = receivableId ? findById(state, 'receivables', receivableId) : null;
    const amount = toMoney(fields.paymentAmount || fields.amount);
    if (receivable) {
      applyPaymentToReceivable(state, receivable, amount, {
        kind: receivable.orderId ? 'final_payment' : 'receivable_payment', originalText, remark: fields.remark || ''
      }, runtime, nextTempId);
      appendParseLog(state, finalResult, 'save_payment', runtime, nextTempId);
      return state;
    }
    const customer = resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, { required: true });
    createPayment(state, {
      customerId: customer.id, amount, kind: 'unlinked_payment', originalText,
      remark: fields.remark || '未关联收款'
    }, runtime, nextTempId);
    appendParseLog(state, finalResult, 'save_unlinked_payment', runtime, nextTempId);
    return state;
  }

  if (intent === 'todo' || intent === 'dunning' || operation === 'create_todo') {
    const customer = (fields.customerName || fields.customerId || fields.phone)
      ? resolveCustomerForWrite(state, fields, preflight, runtime, nextTempId, { required: false })
      : null;
    prepend(state, 'todos', {
      id: nextTempId('todos'), userId: 'local-user', customerId: customer ? customer.id : '',
      title: fields.todoTitle || fields.remark || finalResult.original_text || '待办提醒',
      productName: fields.productName || '', quantity: fields.quantity || '', unit: fields.unit || '',
      unitPrice: fields.unitPrice || '', amount: fields.amount || '', receivableId: fields.receivableId || '',
      todoType: fields.todoType || (intent === 'dunning' ? 'dunning' : ''), remindDate: fields.dueDate || '',
      status: '待办', originalText, remark: fields.remark || finalResult.original_text || '',
      createdAt: runtime.nowInstant, updatedAt: runtime.nowInstant, completedAt: ''
    });
    appendParseLog(state, finalResult, 'save_todo', runtime, nextTempId);
    return state;
  }

  throw Object.assign(new Error(`SavePlan暂不支持operation=${operation}, intent=${intent}`), {
    code: 'SAVE_PLAN_OPERATION_UNSUPPORTED'
  });
}

function simulatePendingSave(sourceState, finalResult, runtime, nextTempId, reason) {
  const state = normalizeDomainState(sourceState);
  prepend(state, 'pendingNotes', {
    id: nextTempId('pendingNotes'), userId: 'local-user', originalText: getOriginalText(finalResult),
    guessedIntent: finalResult.intent, guessedFields: safeClone(finalResult.fields || {}),
    missingFields: safeClone(finalResult.missing_fields || []),
    lowConfidenceFields: safeClone(finalResult.low_confidence_fields || []),
    fieldConflicts: safeClone(finalResult.field_conflicts || []), source: finalResult.source,
    reason: reason || '用户选择稍后整理', status: '待整理',
    createdAt: runtime.nowInstant, updatedAt: runtime.nowInstant
  });
  return state;
}

function findTempReferences(value, path = '', result = []) {
  if (typeof value === 'string' && isTemporaryRecordId(value) && isTemporaryReferencePath(path)) {
    result.push({ path, value });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findTempReferences(item, `${path}[${index}]`, result));
  } else if (value && typeof value === 'object') {
    Object.keys(value).sort().forEach((key) => findTempReferences(value[key], path ? `${path}.${key}` : key, result));
  }
  return result;
}

function buildOperations(stateBefore, stateAfter) {
  const operations = [];
  let operationCounter = 0;
  Object.values(FULL_COLLECTIONS).forEach((collection) => {
    const entityType = ENTITY_BY_COLLECTION[collection];
    const beforeList = stateBefore[collection] || [];
    const afterList = stateAfter[collection] || [];
    const beforeMap = new Map(beforeList.map((item) => [String(item.id), item]));
    const afterMap = new Map(afterList.map((item) => [String(item.id), item]));
    afterList.forEach((record, orderIndex) => {
      const id = String(record.id || '');
      const before = beforeMap.get(id);
      if (before && stableSerialize(before) === stableSerialize(record)) return;
      operationCounter += 1;
      const isNew = !before;
      operations.push({
        operationId: `operation:${operationCounter}`,
        type: isNew ? `CREATE_${entityType}` : `UPDATE_${entityType}`,
        entityType,
        action: isNew
          ? (['AI_PARSE_LOG', 'ORDER_PROGRESS', 'OPERATION_LOG'].includes(entityType) ? 'APPEND' : 'CREATE')
          : (entityType === 'PRODUCT_CATALOG' ? 'UPSERT' : 'UPDATE'),
        targetId: isNew ? '' : id,
        temporaryId: isNew && isTemporaryRecordId(id) ? id : '',
        payload: safeClone(record),
        preconditions: before ? [{
          type: 'TARGET_FINGERPRINT',
          targetId: id,
          expectedFingerprint: stableHash(before, 'record1')
        }] : [{ type: 'TARGET_ABSENT', targetId: id }],
        dependsOn: [],
        relationUpdates: [],
        collection,
        orderIndex
      });
    });
    beforeList.forEach((record) => {
      const id = String(record.id || '');
      if (afterMap.has(id)) return;
      operationCounter += 1;
      operations.push({
        operationId: `operation:${operationCounter}`,
        type: `DELETE_${entityType}`,
        entityType,
        action: 'DELETE',
        targetId: id,
        temporaryId: '',
        payload: null,
        preconditions: [{ type: 'TARGET_FINGERPRINT', targetId: id, expectedFingerprint: stableHash(record, 'record1') }],
        dependsOn: [], relationUpdates: [], collection, orderIndex: -1
      });
    });
  });

  const producerByTempId = operations.reduce((map, operation) => {
    if (operation.temporaryId) map[operation.temporaryId] = operation.operationId;
    return map;
  }, {});
  operations.forEach((operation) => {
    const references = findTempReferences(operation.payload);
    operation.relationUpdates = references.filter((reference) => reference.value !== operation.temporaryId);
    operation.dependsOn = Array.from(new Set(operation.relationUpdates
      .map((reference) => producerByTempId[reference.value])
      .filter(Boolean))).sort();
  });
  return operations;
}

function getPlanHashPayload(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    action: plan.action,
    mode: plan.mode,
    resultScope: plan.resultScope,
    confirmationId: plan.confirmationId,
    confirmationRevision: plan.confirmationRevision,
    confirmationContentHash: plan.confirmationContentHash,
    preflightFingerprint: plan.preflightFingerprint,
    sourceStateVersion: plan.sourceStateVersion,
    sourceStateFingerprint: plan.sourceStateFingerprint,
    originalText: plan.originalText,
    businessType: plan.businessType,
    operation: plan.operation,
    operations: plan.operations,
    dependencies: plan.dependencies,
    preconditions: plan.preconditions,
    collectionOrders: plan.collectionOrders,
    expectedBusinessDiff: plan.expectedBusinessDiff,
    expectedFullDiff: plan.expectedFullDiff,
    commitTargetPolicy: plan.commitTargetPolicy,
    blocked: plan.blocked,
    blockingIssues: plan.blockingIssues,
    warnings: plan.warnings
  };
}

function computePlanHash(plan) {
  return stableHash(getPlanHashPayload(plan), 'plan1');
}

function buildBlockedPlan(base, issues) {
  const emptyDiff = createEmptyStateDiff(base.initialState);
  const plan = {
    schemaVersion: SAVE_PLAN_SCHEMA_VERSION,
    planId: base.planId,
    planHash: '',
    idempotencyKey: '',
    action: base.action,
    mode: base.mode,
    resultScope: base.resultScope,
    confirmationId: base.confirmation.confirmationId || '',
    confirmationRevision: base.confirmation.revision || 0,
    confirmationContentHash: base.confirmation.contentHash || '',
    preflightFingerprint: base.preflightFingerprint || '',
    sourceStateVersion: base.sourceStateVersion,
    sourceStateFingerprint: base.sourceStateFingerprint,
    originalText: base.originalText,
    businessType: base.confirmation.businessType || 'pending',
    operation: base.confirmation.operation || 'pending',
    operations: [],
    dependencies: [],
    preconditions: base.preconditions,
    collectionOrders: {},
    expectedBusinessDiff: emptyDiff.businessDiff,
    expectedFullDiff: emptyDiff.fullDiff,
    commitTargetPolicy: COMMIT_TARGET_POLICIES.BLOCKED,
    blocked: true,
    blockingIssues: safeClone(issues || []),
    warnings: [],
    createdAt: base.createdAt
  };
  plan.planHash = computePlanHash(plan);
  plan.idempotencyKey = `record-save:${plan.planHash}`;
  return plan;
}

function issue(code, details = {}) {
  return Object.assign({ code, messageKey: `RECORD_SAVE_PLAN_${code}`, source: 'SAVE_PLAN' }, details);
}

function rebuildConfirmationForBinding(input, preflight) {
  const confirmation = input.confirmation || {};
  const domain = confirmation.domain || {};
  return buildRecordConfirmation({
    mode: input.mode,
    resultScope: input.resultScope,
    productionRoute: confirmation.productionRoute || '',
    executionPath: confirmation.executionPath || '',
    finalResult: input.finalResult,
    finalSafety: input.finalResult && input.finalResult.final_parse_safety,
    saveEligibility: {
      allowed: domain.domainCanSaveFormal === true,
      domainCanSaveFormal: domain.domainCanSaveFormal === true,
      canCommitToMemory: domain.canCommitToMemory === true,
      canCommitToRealStorage: domain.canCommitToRealStorage === true,
      commitScope: domain.commitScope || 'BLOCKED',
      blockedReasons: domain.domainBlockingReasons || [],
      aiResultResolved: domain.aiResultResolved === true
    },
    aiOutcome: (preflight.aiChecks || {}).outcome,
    providerKind: (preflight.aiChecks || {}).providerKind,
    originalText: confirmation.originalText || getOriginalText(input.finalResult),
    normalizedText: confirmation.normalizedText || '',
    inputSource: confirmation.inputSource || 'typed',
    businessDate: input.businessDate || confirmation.businessDate || '',
    businessTimezone: input.businessTimezone || confirmation.businessTimezone || '',
    initialState: input.initialState,
    surfaceCapabilities: confirmation.surface && confirmation.surface.capabilities,
    confirmationId: confirmation.confirmationId,
    deepReviewAvailable: domain.domainNeedsDeepReview === true,
    traceReference: confirmation.sourceReferences || {}
  });
}

function prepareRecordSavePlan(input = {}, dependencies = {}) {
  const initialState = input.initialState && typeof input.initialState === 'object' ? input.initialState : {};
  const initialSnapshot = normalizeDomainState(initialState);
  const sourceStateVersion = Number.isInteger(input.sourceStateVersion) && input.sourceStateVersion > 0
    ? input.sourceStateVersion
    : 1;
  const createdAt = input.nowInstant ? normalizeNowInstant(input.nowInstant) : readClock(dependencies.clock);
  const businessTimezone = normalizeBusinessTimezone(input.businessTimezone);
  const businessDate = input.businessDate
    ? normalizeBusinessDate(input.businessDate)
    : businessDateFromInstant(createdAt, businessTimezone);
  if (input.businessDate && input.nowInstant
    && businessDateFromInstant(createdAt, businessTimezone) !== businessDate) {
    const error = new Error('businessDate与nowInstant在业务时区中不一致。');
    error.code = 'BUSINESS_DATE_MISMATCH';
    throw error;
  }
  const action = normalizeSaveAction(input.action);
  const confirmation = input.confirmation && typeof input.confirmation === 'object' ? input.confirmation : {};
  const finalResult = input.finalResult && typeof input.finalResult === 'object' ? safeClone(input.finalResult) : {};
  const flowContext = getTrustedRecordFlowContext(finalResult);
  const mode = input.mode || confirmation.mode || flowContext.mode || 'PRODUCTION_ROUTING';
  const resultScope = input.resultScope || confirmation.resultScope || flowContext.resultScope || 'PRODUCTION_RESULT';
  const originalText = confirmation.originalText || getOriginalText(finalResult);
  const planId = nextInjectedId(dependencies.idGenerator, 'save_plan');
  const sourceStateFingerprint = getStateFingerprint(initialSnapshot);
  const runtime = { nowInstant: createdAt, businessDate, duplicateCustomerRemark: '' };
  const preconditions = [{ type: 'STATE_VERSION', expected: sourceStateVersion }, {
    type: 'STATE_FINGERPRINT', expected: sourceStateFingerprint
  }];
  const evaluatedPreflight = evaluateRecordDomainPreflight({
    mode,
    resultScope,
    operation: confirmation.operation || finalResult.operation,
    businessType: confirmation.businessType || finalResult.intent,
    finalResult,
    originalText,
    initialState,
    aiOutcome: flowContext.aiOutcome || (finalResult.ai_fallback || {}).status || 'not_requested',
    providerKind: flowContext.providerKind || (finalResult.ai_fallback || {}).provider_kind || 'NONE'
  });
  const base = {
    action, mode, resultScope, confirmation, initialState: initialSnapshot, sourceStateVersion,
    sourceStateFingerprint, originalText, planId, createdAt, preconditions,
    preflightFingerprint: evaluatedPreflight.preflightFingerprint
  };
  const issues = [];
  if (!action) issues.push(issue('INVALID_SAVE_ACTION'));
  if (!confirmation.confirmationId || !confirmation.contentHash || !confirmation.preflightFingerprint) {
    issues.push(issue('CONFIRMATION_BINDING_MISMATCH'));
  }
  if (confirmation.preflightFingerprint !== evaluatedPreflight.preflightFingerprint
    || (input.preflight && input.preflight.preflightFingerprint !== evaluatedPreflight.preflightFingerprint)) {
    issues.push(issue('PREFLIGHT_BINDING_MISMATCH'));
  }
  if (confirmation.contentHash) {
    const rebuilt = rebuildConfirmationForBinding(input, evaluatedPreflight);
    if (rebuilt.contentHash !== confirmation.contentHash) issues.push(issue('CONFIRMATION_BINDING_MISMATCH'));
  }
  if (!originalText) issues.push(issue('ORIGINAL_TEXT_REQUIRED'));

  if (action === SAVE_ACTIONS.SAVE_FORMAL) {
    if (mode !== 'PRODUCTION_ROUTING' || resultScope !== 'PRODUCTION_RESULT') {
      issues.push(issue('MODE_NOT_COMMITTABLE', { mode, resultScope }));
    }
    if (evaluatedPreflight.domainCanSaveFormal !== true || (confirmation.domain || {}).domainCanSaveFormal !== true) {
      issues.push(issue('FORMAL_SAVE_BLOCKED'));
    }
    const providerKind = String((evaluatedPreflight.aiChecks || {}).providerKind || 'NONE').toUpperCase();
    if (['MOCK', 'FAKE', 'REPLAY'].includes(providerKind)) {
      issues.push(issue('PROVIDER_NOT_COMMITTABLE', { providerKind }));
    }
  }
  if (issues.length) return buildBlockedPlan(base, issues.concat(evaluatedPreflight.blockingIssues || []));

  const nextTempId = createTemporaryIdFactory();
  let stateAfter;
  if (action === SAVE_ACTIONS.SAVE_PENDING) {
    stateAfter = simulatePendingSave(
      initialState, finalResult, runtime, nextTempId,
      input.pendingReason || '用户选择稍后整理'
    );
  } else {
    stateAfter = simulateFormalSave(initialState, finalResult, evaluatedPreflight, runtime, nextTempId);
  }
  const operations = buildOperations(initialSnapshot, stateAfter);
  const diff = createStateDiff(initialSnapshot, stateAfter);
  const collectionOrders = Object.values(FULL_COLLECTIONS).reduce((result, collection) => {
    result[collection] = (stateAfter[collection] || []).map((item) => String(item.id || ''));
    return result;
  }, {});
  const plan = {
    schemaVersion: SAVE_PLAN_SCHEMA_VERSION,
    planId,
    planHash: '',
    idempotencyKey: '',
    action,
    mode,
    resultScope,
    confirmationId: confirmation.confirmationId,
    confirmationRevision: confirmation.revision,
    confirmationContentHash: confirmation.contentHash,
    preflightFingerprint: evaluatedPreflight.preflightFingerprint,
    sourceStateVersion,
    sourceStateFingerprint,
    originalText,
    businessType: confirmation.businessType || finalResult.intent || 'unknown',
    operation: confirmation.operation || finalResult.operation || '',
    operations,
    dependencies: operations.flatMap((operation) => operation.dependsOn.map((dependency) => ({
      operationId: operation.operationId,
      dependsOn: dependency
    }))),
    preconditions,
    collectionOrders,
    expectedBusinessDiff: diff.businessDiff,
    expectedFullDiff: diff.fullDiff,
    commitTargetPolicy: mode === 'PRODUCTION_ROUTING'
      ? COMMIT_TARGET_POLICIES.REAL_OR_MEMORY
      : COMMIT_TARGET_POLICIES.MEMORY_ONLY,
    blocked: false,
    blockingIssues: [],
    warnings: safeClone(evaluatedPreflight.warnings || []),
    createdAt
  };
  plan.planHash = computePlanHash(plan);
  plan.idempotencyKey = `record-save:${plan.planHash}`;
  return plan;
}

module.exports = {
  computePlanHash,
  getPlanHashPayload,
  prepareRecordSavePlan
};
