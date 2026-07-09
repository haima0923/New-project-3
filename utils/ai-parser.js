const { formatDate, parseChineseDate } = require('./date');
const { parseInput } = require('./parser');
const { getApiBaseUrl, requestJson } = require('./api-client');
const { normalizeBusinessText } = require('./text-normalize');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const { applyLocalParseSafety } = require('./parse-safety');

const AI_PARSE_TIMEOUT_MS = 30000;
const validIntents = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'query', 'unknown'];
const activeReceivableStatuses = ['待收', '部分收款'];

function unwrapAiResult(result) {
  if (!result || typeof result !== 'object') return {};
  if (result.data && typeof result.data === 'object') return unwrapAiResult(result.data);
  if (result.result && typeof result.result === 'object') return unwrapAiResult(result.result);
  return result;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function toStringArray(value) {
  return toArray(value)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return item.intent || item.type || item.value || item.name || item.label || '';
    })
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return toStringArray(values).filter((item, index, array) => array.indexOf(item) === index);
}

function getPayloadRawMessages(payload = {}) {
  const pasteMeta = payload.pasteMeta || {};
  const candidates = payload.rawMessages || pasteMeta.rawMessages || pasteMeta.messages || [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((message, index) => ({
      index: message.index !== undefined ? message.index : index,
      speaker: String(message.speaker || '').trim(),
      time: String(message.time || '').trim(),
      content: String(message.content || message.text || '').trim()
    }))
    .filter((message) => message.content);
}

function isMultiMessagePaste(payload = {}) {
  if (payload.source !== 'paste') return false;
  const rawMessages = getPayloadRawMessages(payload);
  const messageCount = rawMessages.length || Number((payload.pasteMeta && payload.pasteMeta.messageCount) || 0);
  return messageCount > 1;
}

function parseMessageUnitPriceCandidates(content) {
  const normalized = normalizeBusinessText(content).trim();
  const candidates = [];
  const chunk = numberPattern();
  const push = (value, flags = {}) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number >= 1000) return;
    const clean = toCleanNumber(number);
    if (!clean) return;
    candidates.push(Object.assign({ value: clean, content }, flags));
  };

  const notBut = normalized.match(new RegExp(`(?:不是|不对)\\s*(${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:是|改成|应为)\\s*(${chunk})`));
  if (notBut) {
    push(parseChineseNumber(notBut[1]), { superseded: true });
    push(parseChineseNumber(notBut[2]), { final: true });
  }

  const changed = normalized.match(new RegExp(`(?:价格|单价|报价|价)[^，,。；;]{0,16}?(?:改成|改为|改|成|为)\\s*(${chunk})`));
  if (changed) push(parseChineseNumber(changed[1]), { final: true });

  const superseded = normalized.match(new RegExp(`(${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:别用|作废|写错|不要)`));
  if (superseded) push(parseChineseNumber(superseded[1]), { superseded: true });

  const parsed = parseInput({
    text: content,
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const value = parsed && parsed.fields ? parsed.fields.unitPrice : '';
  if (value) push(value, {});
  const bare = normalized.match(new RegExp(`^(${numberPattern()})(?:元|块)?$`));
  if (bare) push(parseChineseNumber(bare[1]), {});

  const seen = {};
  return candidates.filter((item) => {
    const key = `${item.value}:${item.superseded ? 'old' : 'current'}:${item.final ? 'final' : ''}`;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function parseMessageUnitPrice(content) {
  const candidates = parseMessageUnitPriceCandidates(content);
  const final = candidates.filter((item) => !item.superseded).slice(-1)[0];
  return final ? final.value : '';
}

function getMessageUnitPriceCandidates(rawMessages) {
  return rawMessages
    .flatMap((message) => parseMessageUnitPriceCandidates(message.content).map((candidate) => ({
      index: message.index,
      speaker: message.speaker,
      content: message.content,
      value: candidate.value,
      final: candidate.final,
      superseded: candidate.superseded
    })))
    .filter((item) => item.value);
}

function parseMessageQuantity(content) {
  const parsed = parseInput({
    text: content,
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const value = parsed && parsed.fields ? parsed.fields.quantity : '';
  return value ? String(value) : '';
}

function getMessageQuantityCandidates(rawMessages) {
  return rawMessages
    .map((message) => ({
      index: message.index,
      speaker: message.speaker,
      content: message.content,
      value: parseMessageQuantity(message.content),
      final: /最后|最终|一共|总共|合计|改成|改为|确认|不对/.test(normalizeBusinessText(message.content))
    }))
    .filter((item) => item.value);
}

function buildFieldConflict(field, values, rawMessages, label) {
  const uniqueValues = uniqueStrings(values);
  if (uniqueValues.length <= 1) return null;
  return {
    field,
    values: uniqueValues,
    message: `${label}出现多个候选：${uniqueValues.join('、')}，需要确认最终以哪一个为准。`,
    evidence: rawMessages
      .filter((message) => uniqueValues.some((value) => String(message.content || '').includes(value)))
      .map((message) => ({
        messageIndex: message.index,
        speaker: message.speaker,
        text: message.content
      }))
  };
}

function extractLocalFieldConflicts(payload) {
  const rawMessages = getPayloadRawMessages(payload);
  if (!rawMessages.length) return [];
  const unitPrices = getMessageUnitPriceCandidates(rawMessages).map((item) => item.value);
  const quantities = getMessageQuantityCandidates(rawMessages).map((item) => item.value);
  const hasPriceCorrectionSignal = rawMessages.some((message) => /价格|单价|报价|价|少了逗号|写错|不是|不对|别用/.test(normalizeBusinessText(message.content || '')));
  const priceConflict = buildFieldConflict('unitPrice', unitPrices, rawMessages, '单价')
    || (hasPriceCorrectionSignal && unitPrices.length ? {
      field: 'unitPrice',
      values: uniqueStrings(unitPrices),
      message: '单价出现纠错或作废表达，需要确认最终单价。',
      evidence: rawMessages.map((message) => ({ messageIndex: message.index, speaker: message.speaker, text: message.content }))
    } : null);
  const quantityConflict = buildFieldConflict('quantity', quantities, rawMessages, '数量');
  return [priceConflict, quantityConflict].filter(Boolean);
}

function applyLatestLocalUnitPrice(next, payload, fieldConflicts) {
  const candidates = getMessageUnitPriceCandidates(getPayloadRawMessages(payload));
  if (!candidates.length || !next.fields) return next;
  const hasConflict = fieldConflicts.some((item) => item.field === 'unitPrice');
  if (!hasConflict && next.fields.unitPrice) return next;
  const currentCandidates = candidates.filter((item) => !item.superseded);
  const latest = currentCandidates.slice().reverse().find((item) => item.final) || currentCandidates[currentCandidates.length - 1] || candidates[candidates.length - 1];
  if (!latest || !latest.value || !next.fields) return next;
  const fields = Object.assign({}, next.fields, {
    unitPrice: latest.value
  });
  const amount = calculateAmount(fields.quantity, fields.unitPrice);
  if (amount) fields.amount = amount;
  return Object.assign({}, next, {
    fields,
    field_sources: Object.assign({}, next.field_sources || {}, {
      unitPrice: 'rule:latest_conversation_unit_price',
      amount: amount ? 'rule:quantity_times_latest_unit_price' : ((next.field_sources || {}).amount || '')
    })
  });
}

function applyLatestLocalQuantity(next, payload, fieldConflicts) {
  const candidates = getMessageQuantityCandidates(getPayloadRawMessages(payload));
  if (!candidates.length || !next.fields) return next;
  const hasConflict = fieldConflicts.some((item) => item.field === 'quantity');
  if (!hasConflict && next.fields.quantity) return next;
  const latest = candidates.slice().reverse().find((item) => item.final) || candidates[candidates.length - 1];
  if (!latest || !latest.value) return next;
  const fields = Object.assign({}, next.fields, {
    quantity: latest.value
  });
  const amount = calculateAmount(fields.quantity, fields.unitPrice);
  if (amount) fields.amount = amount;
  return Object.assign({}, next, {
    fields,
    field_sources: Object.assign({}, next.field_sources || {}, {
      quantity: 'rule:latest_conversation_quantity',
      amount: amount ? 'rule:latest_quantity_times_unit_price' : ((next.field_sources || {}).amount || '')
    })
  });
}

function extractRemarkItemsFromMessages(payload) {
  const rawMessages = getPayloadRawMessages(payload);
  if (!rawMessages.length) return [];
  const requirementPattern = /(颜色|色差|深一点|浅一点|淡一点|不要太深|不要太浅|包装|外箱|内盒|贴纸|标签|logo|LOGO|图案|材质|尺寸|规格|加急|交期|唛头|印字|印刷|备注|要求|透明度|隔板|插头|欧规|裁边|箱规|磁吸|边缘|袋口|盖子|带盖|黑色|红色|偏黄|太厚|太松|太紧|刮手|剩余|还剩|后面还有)/i;
  return rawMessages
    .filter((message) => requirementPattern.test(message.content))
    .map((message) => ({
      messageIndex: message.index,
      speaker: message.speaker,
      text: message.content
    }));
}

function buildRemarkFromItems(remarkItems) {
  const items = (remarkItems || [])
    .map((item) => String(item.text || item || '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  const normalizedItems = items
    .map((item) => normalizeBusinessText(item).trim().replace(/[,，]{2,}/g, '，').replace(/,/g, '，'))
    .filter((item, index, array) => item && array.indexOf(item) === index);
  const normalizedText = normalizedItems.length && normalizedItems.join('；') !== items.join('；')
    ? `；规范化要求：${normalizedItems.join('；')}`
    : '';
  return `客户要求：${items.join('；')}${normalizedText}`;
}

function attachConversationReview(localResult, payload) {
  if (!getPayloadRawMessages(payload).length) return localResult;
  const fieldConflicts = extractLocalFieldConflicts(payload);
  const remarkItems = extractRemarkItemsFromMessages(payload);
  const conflictFields = fieldConflicts.map((item) => item.field).filter(Boolean);
  let next = Object.assign({}, localResult, {
    raw_messages: getPayloadRawMessages(payload),
    field_conflicts: fieldConflicts,
    remark_items: remarkItems,
    low_confidence_fields: uniqueStrings([].concat(localResult.low_confidence_fields || [], conflictFields))
  });
  next = applyLatestLocalUnitPrice(next, payload, fieldConflicts);
  next = applyLatestLocalQuantity(next, payload, fieldConflicts);
  if (remarkItems.length && next.fields && !String(next.fields.remark || '').startsWith('客户要求：')) {
    next.fields = Object.assign({}, next.fields, {
      remark: [buildRemarkFromItems(remarkItems), next.fields.remark || next.original_text || ''].filter(Boolean).join('\n\n原始聊天：\n')
    });
  }
  return next;
}

function markAiNeeded(localResult) {
  return Object.assign({}, localResult, {
    ai_fallback: Object.assign({}, localResult.ai_fallback || {}, {
      needed: true
    })
  });
}

function hasPackagingRequirementSignal(source) {
  const text = String(source || '');
  return /包装(?!袋|盒|纸)|包装[^，,。；;\n]{0,12}(?:改成|改为|改|换成|怎么|如何|做|要求|确认|彩盒|外箱|内盒)|客户问[^，,。；;\n]{0,12}包装/.test(text);
}

function shouldForceAi(payload, localResult) {
  if (payload.source === 'paste' || payload.source === 'voice') return true;
  if (isMultiMessagePaste(payload)) return true;
  const source = String(payload.text || localResult.original_text || '');
  return /(改成|算了|还是|就按|贵了|便宜|换成|确认价|最终|颜色|logo|LOGO|特殊|要求|备注)/.test(source)
    || hasPackagingRequirementSignal(source);
}

function getByPath(source, path) {
  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return current[key];
  }, source);
}

function pickFirst(source, paths) {
  for (let i = 0; i < paths.length; i += 1) {
    const value = getByPath(source, paths[i]);
    if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') return value;
  }
  return '';
}

function normalizeAiItem(item = {}) {
  if (!item || typeof item !== 'object') return null;
  const quantity = pickFirst(item, ['quantity', 'qty', 'product.quantity', 'item.quantity']);
  const unitPrice = pickFirst(item, ['unitPrice', 'unit_price', 'price.unitPrice', 'price.unit_price', 'price.perUnit', 'price.per_unit', 'unitAmount']);
  const mapped = {
    productName: pickFirst(item, ['productName', 'product_name', 'product.name', 'product', 'itemName', 'item_name', 'item.name', 'goodsName', 'goods_name', 'name']),
    spec: pickFirst(item, ['spec', 'specification', 'product.spec', 'product.specification']),
    quantity,
    unit: pickFirst(item, ['unit', 'product.unit', 'item.unit']),
    unitPrice,
    totalAmount: pickFirst(item, ['totalAmount', 'total_amount', 'amount', 'price.amount', 'price.totalAmount']),
    itemDeliveryDate: normalizeDateValue(pickFirst(item, ['itemDeliveryDate', 'item_delivery_date', 'deliveryDate', 'delivery_date', 'dueDate', 'due_date'])),
    itemRemark: pickFirst(item, ['itemRemark', 'item_remark', 'remark', 'note', 'memo'])
  };
  if (!mapped.totalAmount && quantity && unitPrice) mapped.totalAmount = calculateAmount(quantity, unitPrice);
  const compact = {};
  Object.keys(mapped).forEach((key) => {
    if (mapped[key] !== undefined && mapped[key] !== null && mapped[key] !== '') compact[key] = mapped[key];
  });
  return compact.productName || compact.quantity || compact.unitPrice || compact.totalAmount ? compact : null;
}

function normalizeAiItems(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeAiItem)
    .filter(Boolean);
}

function getItemsTotal(items = []) {
  if (!items.length || items.some((item) => !item.totalAmount)) return '';
  const total = items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  return toCleanNumber(total);
}

function normalizeDateValue(value) {
  if (!value) return '';
  const source = String(value).trim();
  const numeric = source.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (numeric) {
    return formatDate(new Date(Number(numeric[1]), Number(numeric[2]) - 1, Number(numeric[3])));
  }
  const parsed = parseChineseDate(source);
  return parsed || source;
}

function normalizeFields(fields = {}) {
  const items = normalizeAiItems(fields.items || fields.lineItems || fields.line_items || fields.products || fields.goods);
  const mapped = {
    customerId: pickFirst(fields, ['customerId', 'customer_id', 'customer.id', 'client.id']),
    customerName: pickFirst(fields, ['customerName', 'customer_name', 'customer.name', 'customer', 'clientName', 'client_name', 'client.name']),
    phone: pickFirst(fields, ['phone', 'mobile', 'customer.phone', 'client.phone']),
    company: pickFirst(fields, ['company', 'customer.company', 'client.company']),
    region: pickFirst(fields, ['region', 'customer.region', 'client.region']),
    todoTitle: pickFirst(fields, ['todoTitle', 'todo_title', 'taskTitle', 'task_title', 'reminderTitle', 'reminder_title', 'title']),
    followupDays: pickFirst(fields, ['followupDays', 'followup_days', 'followUpDays', 'follow_up_days']),
    productName: pickFirst(fields, ['productName', 'product_name', 'product.name', 'product', 'itemName', 'item_name', 'item.name', 'goodsName', 'goods_name']),
    spec: pickFirst(fields, ['spec', 'specification', 'product.spec', 'product.specification']),
    quantity: pickFirst(fields, ['quantity', 'qty', 'product.quantity', 'item.quantity']),
    unit: pickFirst(fields, ['unit', 'product.unit', 'item.unit']),
    unitPrice: pickFirst(fields, ['unitPrice', 'unit_price', 'price.unitPrice', 'price.unit_price', 'price.perUnit', 'price.per_unit', 'unitAmount']),
    paymentAmount: pickFirst(fields, ['paymentAmount', 'payment_amount', 'paidAmount', 'paid_amount', 'receivedAmount', 'received_amount', 'collectionAmount', 'collection_amount', 'payment.amount']),
    depositAmount: pickFirst(fields, ['depositAmount', 'deposit_amount', 'deposit', 'deposit.amount', 'advanceAmount', 'advance_amount', 'prepaidAmount', 'prepaid_amount']),
    amount: pickFirst(fields, ['amount', 'totalAmount', 'total_amount', 'totalPrice', 'total_price', 'price.amount', 'price.totalAmount', 'money.amount', 'receivable.amount', 'payment.amount']),
    totalAmount: pickFirst(fields, ['totalAmount', 'total_amount', 'totalPrice', 'total_price', 'price.totalAmount']),
    remainingAmount: pickFirst(fields, ['remainingAmount', 'remaining_amount', 'leftAmount', 'left_amount', 'unpaidAmount', 'unpaid_amount', 'balance', 'balanceAmount', 'balance_amount', 'payment.remainingAmount']),
    paymentMethod: pickFirst(fields, ['paymentMethod', 'payment_method', 'payment.method']),
    paymentKind: pickFirst(fields, ['paymentKind', 'payment_kind', 'kind', 'payment.kind']),
    dueDate: normalizeDateValue(pickFirst(fields, ['dueDate', 'due_date', 'remindDate', 'remind_date', 'reminderDate', 'reminder_date', 'deliveryDate', 'delivery_date', 'requiredDeliveryDate', 'required_delivery_date', 'date.dueDate', 'date.remindDate', 'date.deliveryDate'])),
    quoteDate: normalizeDateValue(pickFirst(fields, ['quoteDate', 'quote_date', 'date.quoteDate'])),
    orderId: pickFirst(fields, ['orderId', 'order_id', 'order.id']),
    quotationId: pickFirst(fields, ['quotationId', 'quotation_id', 'quotation.id']),
    remark: pickFirst(fields, ['remark', 'note', 'memo'])
  };
  if (items.length) {
    const first = items[0] || {};
    const itemsTotal = getItemsTotal(items);
    mapped.items = items;
    mapped.productName = mapped.productName || first.productName || '';
    mapped.spec = mapped.spec || first.spec || '';
    mapped.quantity = mapped.quantity || first.quantity || '';
    mapped.unit = mapped.unit || first.unit || '';
    mapped.unitPrice = mapped.unitPrice || first.unitPrice || '';
    mapped.amount = mapped.amount || itemsTotal || first.totalAmount || '';
    mapped.totalAmount = mapped.totalAmount || itemsTotal || mapped.amount || '';
  }
  const compact = {};
  Object.keys(mapped).forEach((key) => {
    if (mapped[key] !== undefined && mapped[key] !== null && mapped[key] !== '') compact[key] = mapped[key];
  });
  return compact;
}

function compactBusinessContext(state = {}) {
  const customers = state.customers || [];
  const customerNameById = customers.reduce((map, customer) => {
    if (customer && customer.id) map[customer.id] = customer.name || '';
    return map;
  }, {});
  const recentCustomers = customers.slice(0, 30).map((customer) => ({
    id: customer.id,
    name: customer.name,
    company: customer.company || '',
    region: customer.region || '',
    lastTradeAt: customer.lastTradeAt || ''
  }));
  const recentQuotations = (state.quotations || []).slice(0, 30).map((quotation) => ({
    id: quotation.id,
    customerId: quotation.customerId,
    customerName: customerNameById[quotation.customerId] || '',
    productName: quotation.productName || '',
    spec: quotation.spec || '',
    quantity: quotation.quantity || '',
    unit: quotation.unit || '',
    unitPrice: quotation.unitPrice || '',
    totalAmount: quotation.totalAmount || '',
    deliveryDate: quotation.deliveryDate || '',
    quoteDate: quotation.quoteDate || '',
    status: quotation.status || ''
  }));
  const recentOrders = (state.orders || []).slice(0, 30).map((order) => ({
    id: order.id,
    customerId: order.customerId,
    customerName: customerNameById[order.customerId] || '',
    productName: order.productName || '',
    spec: order.spec || '',
    quantity: order.quantity || '',
    unit: order.unit || '',
    unitPrice: order.unitPrice || '',
    totalAmount: order.totalAmount || '',
    requiredDeliveryDate: order.requiredDeliveryDate || '',
    status: order.status || ''
  }));
  const recentReceivables = (state.receivables || []).slice(0, 30).map((receivable) => ({
    id: receivable.id,
    customerId: receivable.customerId,
    customerName: customerNameById[receivable.customerId] || '',
    orderId: receivable.orderId || '',
    amount: receivable.amount || '',
    paidAmount: receivable.paidAmount || '',
    dueDate: receivable.dueDate || '',
    status: receivable.status || ''
  }));
  const recentPaymentRecords = (state.paymentRecords || []).slice(0, 30).map((payment) => ({
    id: payment.id,
    customerId: payment.customerId,
    customerName: customerNameById[payment.customerId] || '',
    orderId: payment.orderId || '',
    receivableId: payment.receivableId || '',
    kind: payment.kind || payment.paymentKind || '',
    amount: payment.amount || '',
    paidAt: payment.paidAt || '',
    remark: payment.remark || ''
  }));
  return {
    recentCustomers,
    recentQuotations,
    recentOrders,
    recentReceivables,
    recentPaymentRecords
  };
}

function getContextPolicy(text, localResult = {}) {
  const source = String(text || localResult.original_text || '');
  const intent = localResult.intent || 'unknown';
  const fields = localResult.fields || {};
  const hasLineItems = Array.isArray(fields.items) && fields.items.length > 0;
  const hasNewOrderProductInfo = Boolean(fields.productName && (fields.quantity || fields.unitPrice || fields.dueDate || fields.totalAmount || fields.amount));
  const isNewOrderWithDeposit = /定金|订金|预付|预付款/.test(source)
    && intent === 'order'
    && (hasLineItems || hasNewOrderProductInfo);
  if (/改|改成|延期|提前|那单|那笔|上次那笔|改价|改数量/.test(source)) return 'record_update';
  if (
    intent === 'receivable'
    && /应收|欠|欠款|还差|尾款|货款|记账|月结|月底结|月底给|未结清应收/.test(source)
    && !/还我|还了|刚?转了|到账|付了|付款|收了|已收|先打|结清了|已结清/.test(source)
  ) {
    return 'none';
  }
  if (isNewOrderWithDeposit) return 'none';
  if (/定金|订金|预付|预付款/.test(source) && (intent === 'payment' || fields.paymentKind === 'deposit' || fields.depositAmount)) return 'order_deposit';
  if (intent === 'payment' || /还我|还了|还剩|剩下|剩余|结清|到账|转了|付了|收了|未收|没收/.test(source)) return 'receivable_history';

  const needsHistoryPrice = /上次|上图|原价|还是|按上次|照旧|老价/.test(source);
  const repeatOrder = /补|返单|再来|追加/.test(source);
  const quoteOrOrder = ['quotation', 'order'].includes(intent);
  if (quoteOrOrder && (needsHistoryPrice || (repeatOrder && (!fields.unitPrice || !fields.dueDate || !fields.productName)))) {
    return 'customer_history';
  }
  return 'none';
}

function getAiParseEndpoint() {
  if (typeof getApp !== 'function') return '/api/ai/parse';
  const app = getApp();
  const globalData = app && app.globalData ? app.globalData : {};
  return globalData.aiParseEndpoint || '/api/ai/parse';
}

function originalContainsName(originalText, name) {
  const source = String(originalText || '');
  const current = String(name || '');
  if (!source || !current) return false;
  const compactName = current.replace(/总$/, '');
  return source.includes(current) || (compactName.length >= 2 && source.includes(compactName));
}

function extractMentionedCustomerName(text, localResult = {}) {
  const source = String(text || localResult.original_text || '');
  const localName = localResult.fields && localResult.fields.customerName;
  if (localName && originalContainsName(source, localName)) return localName;
  if (localName) return localName;
  const direct = source.match(/([\u4e00-\u9fa5A-Za-z]{1,8}(?:总|老板|经理|姐|哥|先生|女士))/);
  if (direct) return direct[1];
  const oldName = source.match(/(老[\u4e00-\u9fa5]{1,2})/);
  return oldName ? oldName[1] : '';
}

function customerMatchesMention(customer, mentionedName) {
  if (!customer || !mentionedName) return false;
  const customerName = String(customer.name || '');
  const source = String(mentionedName || '');
  const customerCompact = customerName.replace(/总$/, '');
  const sourceCompact = source.replace(/总$/, '');
  return customerName === source
    || customerName.includes(source)
    || source.includes(customerName)
    || (customerCompact.length >= 2 && source.includes(customerCompact))
    || (sourceCompact.length >= 2 && customerName.includes(sourceCompact));
}

function mapCustomerNameById(customers) {
  return (customers || []).reduce((map, customer) => {
    if (customer && customer.id) map[customer.id] = customer.name || '';
    return map;
  }, {});
}

function formatScopedCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    company: customer.company || '',
    region: customer.region || '',
    lastTradeAt: customer.lastTradeAt || ''
  };
}

function findScopedHistory(state = {}, mentionedCustomerName, policy) {
  const customers = state.customers || [];
  const matchedCustomers = customers.filter((customer) => customerMatchesMention(customer, mentionedCustomerName));
  const matchedCustomerIds = matchedCustomers.map((customer) => customer.id).filter(Boolean);
  const customerIdSet = matchedCustomerIds.reduce((set, id) => {
    set[id] = true;
    return set;
  }, {});
  const customerNameById = mapCustomerNameById(customers);

  const scopedQuotations = (state.quotations || [])
    .filter((quotation) => customerIdSet[quotation.customerId])
    .slice(0, 20)
    .map((quotation) => ({
      id: quotation.id,
      customerId: quotation.customerId,
      customerName: customerNameById[quotation.customerId] || '',
      productName: quotation.productName || '',
      spec: quotation.spec || '',
      quantity: quotation.quantity || '',
      unit: quotation.unit || '',
      unitPrice: quotation.unitPrice || '',
      totalAmount: quotation.totalAmount || '',
      deliveryDate: quotation.deliveryDate || '',
      quoteDate: quotation.quoteDate || '',
      status: quotation.status || ''
    }));
  const scopedOrders = (state.orders || [])
    .filter((order) => customerIdSet[order.customerId])
    .slice(0, 20)
    .map((order) => ({
      id: order.id,
      customerId: order.customerId,
      customerName: customerNameById[order.customerId] || '',
      productName: order.productName || '',
      spec: order.spec || '',
      quantity: order.quantity || '',
      unit: order.unit || '',
      unitPrice: order.unitPrice || '',
      totalAmount: order.totalAmount || '',
      requiredDeliveryDate: order.requiredDeliveryDate || '',
      orderDate: order.orderDate || '',
      status: order.status || ''
    }));
  const scopedReceivables = (state.receivables || [])
    .filter((receivable) => customerIdSet[receivable.customerId])
    .filter((receivable) => policy !== 'receivable_history' || activeReceivableStatuses.includes(receivable.status))
    .slice(0, 20)
    .map((receivable) => ({
      id: receivable.id,
      customerId: receivable.customerId,
      customerName: customerNameById[receivable.customerId] || '',
      orderId: receivable.orderId || '',
      amount: receivable.amount || '',
      paidAmount: receivable.paidAmount || '',
      dueDate: receivable.dueDate || '',
      status: receivable.status || ''
    }));
  const scopedPaymentRecords = (state.paymentRecords || [])
    .filter((payment) => customerIdSet[payment.customerId])
    .slice(0, 20)
    .map((payment) => ({
      id: payment.id,
      customerId: payment.customerId,
      orderId: payment.orderId || '',
      receivableId: payment.receivableId || '',
      kind: payment.kind || payment.paymentKind || '',
      amount: payment.amount || '',
      paidAt: payment.paidAt || '',
      remark: payment.remark || ''
    }));

  const found = policy === 'customer_history'
    ? Boolean(scopedQuotations.length || scopedOrders.length)
    : (policy === 'receivable_history'
      ? Boolean(scopedReceivables.length)
      : (policy === 'order_deposit'
        ? Boolean(scopedOrders.length)
        : (policy === 'record_update' ? Boolean(scopedQuotations.length || scopedOrders.length) : false)));

  return {
    mentionedCustomerName,
    customers: matchedCustomers.map(formatScopedCustomer),
    businessContext: found ? {
      recentCustomers: matchedCustomers.map(formatScopedCustomer),
      recentQuotations: scopedQuotations,
      recentOrders: scopedOrders,
      recentReceivables: scopedReceivables,
      recentPaymentRecords: scopedPaymentRecords
    } : {},
    found
  };
}

function buildHistoryWarning(policy, scopedHistory, localResult = {}) {
  if (policy === 'none' || scopedHistory.found) return '';
  const name = scopedHistory.mentionedCustomerName || '这个客户';
  const fields = localResult.fields || {};
  if (policy === 'customer_history') {
    return `没有找到${name}的历史订单/报价，已按新订单草稿处理。请补齐单价、交期等信息后再确认。`;
  }
  if (policy === 'receivable_history') {
    const paymentAmount = Number(fields.paymentAmount || 0);
    const remainingAmount = Number(fields.remainingAmount || 0);
    if (paymentAmount > 0 && remainingAmount > 0) {
      return `没有找到${name}未结清应收。可新建一笔应收总额${paymentAmount + remainingAmount}元，并记录已收${paymentAmount}元。`;
    }
    return `没有找到${name}未结清应收。请确认是新建应收并记录收款，还是先存到待整理。`;
  }
  if (policy === 'order_deposit') {
    return `没有找到${name}可关联的进行中订单。定金不能直接生成应收，建议先存到待整理或补充是哪一单。`;
  }
  return `没有找到${name}可匹配的历史订单/报价，请补充更多信息或先存到待整理。`;
}

function getSuggestedOperation(policy, scopedHistory) {
  if (policy === 'customer_history' && !scopedHistory.found) return 'create_order';
  if (policy === 'receivable_history' && !scopedHistory.found) return 'create_receivable_with_payment';
  if (policy === 'order_deposit') return scopedHistory.found ? 'record_order_deposit' : 'pending';
  if (policy === 'record_update' && !scopedHistory.found) return 'pending';
  return '';
}

function attachHistoryInfo(localResult, policy, scopedHistory) {
  const historyStatus = policy === 'none' ? 'not_required' : (scopedHistory.found ? 'found' : 'not_found');
  return applyCustomerHistoryDefaults(Object.assign({}, localResult, {
    context_policy: policy,
    history_status: historyStatus,
    history_warning_text: buildHistoryWarning(policy, scopedHistory, localResult),
    suggested_operation: getSuggestedOperation(policy, scopedHistory)
  }), policy, scopedHistory);
}

function buildAiRequestPayload(payload, localResult, scopedHistory) {
  const requestPayload = {
    text: payload.text,
    source: payload.source,
    context: payload.context,
    rawText: payload.rawText || localResult.original_text || '',
    extractedText: payload.extractedText || payload.text || '',
    rawMessages: getPayloadRawMessages(payload),
    pasteMeta: payload.pasteMeta || null,
    localDraft: {
      intent: localResult.intent || 'unknown',
      operation: localResult.operation || '',
      fields: localResult.fields || {},
      missing_fields: localResult.missing_fields || [],
      low_confidence_fields: localResult.low_confidence_fields || [],
      field_conflicts: localResult.field_conflicts || [],
      remark_items: localResult.remark_items || [],
      field_sources: localResult.field_sources || {},
      local_parse_safety: localResult.local_parse_safety || null,
      unsafe_reasons: localResult.unsafe_reasons || []
    }
  };
  if (localResult.history_status === 'found') {
    requestPayload.customerCandidates = scopedHistory.customers;
    requestPayload.businessContext = scopedHistory.businessContext;
  }
  return requestPayload;
}

function hasFieldValue(fields, field) {
  return fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function toCleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function calculateAmount(quantity, unitPrice) {
  if (!quantity || !unitPrice) return '';
  const quantityNumber = Number(quantity);
  const unitPriceNumber = Number(unitPrice);
  if (!Number.isFinite(quantityNumber) || !Number.isFinite(unitPriceNumber)) return '';
  return toCleanNumber(quantityNumber * unitPriceNumber);
}

function normalizeProductText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function productMatches(inputProduct, historyProduct) {
  const input = normalizeProductText(inputProduct);
  const history = normalizeProductText(historyProduct);
  if (!input || !history) return false;
  return input === history || input.includes(history) || history.includes(input);
}

function getHistoryRecordDate(record) {
  return record.orderDate || record.quoteDate || record.createdAt || record.requiredDeliveryDate || record.deliveryDate || '';
}

function byRecentRecord(left, right) {
  return String(getHistoryRecordDate(right)).localeCompare(String(getHistoryRecordDate(left)));
}

function getHistoryRecords(scopedHistory, productName) {
  const businessContext = scopedHistory.businessContext || {};
  const orders = (businessContext.recentOrders || [])
    .filter((order) => productMatches(productName, order.productName))
    .map((order) => Object.assign({ historyType: 'order' }, order));
  const quotations = (businessContext.recentQuotations || [])
    .filter((quotation) => productMatches(productName, quotation.productName))
    .map((quotation) => Object.assign({ historyType: 'quotation' }, quotation));
  return {
    orders: orders.sort(byRecentRecord),
    priceRecords: orders.concat(quotations).filter((record) => hasFieldValue(record, 'unitPrice')).sort(byRecentRecord)
  };
}

function getHistorySource(record, field) {
  return `history:${record.historyType}:${record.id}:${field}`;
}

function buildHistoryDefaultWarning(fields, defaultedFields) {
  const parts = [];
  if (defaultedFields.includes('unitPrice')) parts.push(`单价 ${fields.unitPrice}`);
  if (defaultedFields.includes('dueDate')) parts.push(`交期 ${fields.dueDate}`);
  if (!parts.length) return '';
  const customerName = fields.customerName || '这个客户';
  const productName = fields.productName || '这个产品';
  return `已按${customerName}上次${productName}记录默认填入：${parts.join('、')}。请重点确认，不对可以直接修改。`;
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function mergeRemarkItems(localItems, aiItems) {
  const source = [].concat(toArray(aiItems), toArray(localItems));
  const seen = {};
  return source.filter((item) => {
    const text = typeof item === 'string' ? item : String((item && item.text) || '').trim();
    if (!text || seen[text]) return false;
    seen[text] = true;
    return true;
  });
}

function hasExplicitQuotationSignal(source) {
  const text = String(source || '');
  return /报价|报架|报个价|报一下价|报下价|问价|要个价格|先报|一起报|报给客户/.test(text)
    || /给[^，,。；;\n]{1,16}报(?!销)/.test(text)
    || /报(?!销)[^，,。；;\n]{0,12}(?:\d|一|二|两|三|四|五|六|七|八|九|十|百|千|万|w|W)/.test(text);
}

function hasClearProductFields(fields = {}) {
  const items = Array.isArray(fields.items) ? fields.items : [];
  return items.some((item) => item && (item.productName || item.quantity || item.unitPrice))
    || Boolean(fields.productName && (fields.quantity || fields.unitPrice || fields.amount || fields.totalAmount));
}

function hasNoLocalFieldRisk(localResult) {
  return !toArray(localResult.missing_fields).length
    && !toArray(localResult.low_confidence_fields).length
    && !toArray(localResult.field_conflicts).length;
}

function shouldProtectLocalQuotationIntent(localResult) {
  if (!localResult || localResult.intent !== 'quotation') return false;
  const safety = localResult.local_parse_safety || {};
  const localIntentIsSafe = safety.status === 'SAFE_LOCAL'
    || (safety.status === 'NEEDS_AI' && hasNoLocalFieldRisk(localResult));
  if (!localIntentIsSafe) return false;
  const text = localResult.original_text || '';
  return hasExplicitQuotationSignal(text) && hasClearProductFields(localResult.fields || {});
}

function mergeAiIntent(localResult, normalized) {
  const aiIntent = validIntents.includes(normalized.intent) ? normalized.intent : '';
  if (aiIntent && !(shouldProtectLocalQuotationIntent(localResult) && aiIntent !== localResult.intent)) return aiIntent;
  return localResult.intent;
}

function getConflictFields(conflicts) {
  return toArray(conflicts)
    .map((item) => (typeof item === 'string' ? item : item && item.field))
    .filter(Boolean);
}

function applyPostAiConsistency(result, normalized) {
  const fields = Object.assign({}, result.fields || {});
  const fieldSources = Object.assign({}, result.field_sources || {});
  const itemsTotal = getItemsTotal(fields.items || []);
  if (itemsTotal) {
    fields.amount = itemsTotal;
    fields.totalAmount = itemsTotal;
    fieldSources.amount = fieldSources.amount || 'computed:items_total';
    fieldSources.totalAmount = fieldSources.totalAmount || fieldSources.amount;
  } else if (hasFieldValue(fields, 'quantity') && hasFieldValue(fields, 'unitPrice')) {
    const amount = calculateAmount(fields.quantity, fields.unitPrice);
    if (amount) {
      fields.amount = amount;
      fields.totalAmount = fields.totalAmount || amount;
      fieldSources.amount = fieldSources.amount || 'computed:quantity*unitPrice';
    }
  }
  if ((fields.paymentKind === 'deposit' || fields.depositAmount) && !fields.paymentAmount && fields.depositAmount) {
    fields.paymentAmount = fields.depositAmount;
    fieldSources.paymentAmount = fieldSources.paymentAmount || fieldSources.depositAmount || 'computed:depositAmount';
  }
  const hasAiConflicts = normalized.field_conflicts !== undefined || normalized.fieldConflicts !== undefined;
  const supersededFacts = toArray(normalized.superseded_facts || normalized.supersededFacts || result.superseded_facts);
  const fieldConflicts = hasAiConflicts
    ? toArray(normalized.field_conflicts || normalized.fieldConflicts)
    : (supersededFacts.length ? [] : toArray(result.field_conflicts));
  const conflictFields = getConflictFields(fieldConflicts);
  return Object.assign({}, result, {
    fields,
    field_sources: fieldSources,
    field_conflicts: fieldConflicts,
    superseded_facts: supersededFacts,
    low_confidence_fields: uniqueStrings([].concat(result.low_confidence_fields || [], conflictFields))
  });
}

function applyCustomerHistoryDefaults(localResult, policy, scopedHistory) {
  if (policy !== 'customer_history' || !scopedHistory.found) return localResult;
  const fields = Object.assign({}, localResult.fields || {});
  if (!fields.productName) return localResult;

  const history = getHistoryRecords(scopedHistory, fields.productName);
  const priceRecord = history.priceRecords[0];
  const deliveryRecord = history.orders.find((order) => hasFieldValue(order, 'requiredDeliveryDate'));
  const defaultedFields = [];
  const fieldSources = Object.assign({}, localResult.field_sources || {});

  if (!hasFieldValue(fields, 'unitPrice') && priceRecord && hasFieldValue(priceRecord, 'unitPrice')) {
    fields.unitPrice = priceRecord.unitPrice;
    fieldSources.unitPrice = getHistorySource(priceRecord, 'unitPrice');
    defaultedFields.push('unitPrice');
    if (!hasFieldValue(fields, 'unit') && hasFieldValue(priceRecord, 'unit')) {
      fields.unit = priceRecord.unit;
      fieldSources.unit = getHistorySource(priceRecord, 'unit');
    }
  }

  if (!hasFieldValue(fields, 'dueDate') && deliveryRecord && hasFieldValue(deliveryRecord, 'requiredDeliveryDate')) {
    fields.dueDate = deliveryRecord.requiredDeliveryDate;
    fieldSources.dueDate = getHistorySource(deliveryRecord, 'requiredDeliveryDate');
    defaultedFields.push('dueDate');
  }

  if (!defaultedFields.length) return localResult;

  if (hasFieldValue(fields, 'quantity') && hasFieldValue(fields, 'unitPrice')) {
    const amount = calculateAmount(fields.quantity, fields.unitPrice);
    if (amount && !hasFieldValue(fields, 'amount')) {
      fields.amount = amount;
      fieldSources.amount = 'computed:quantity*history_unitPrice';
    }
  }

  return Object.assign({}, localResult, {
    fields,
    field_sources: fieldSources,
    missing_fields: (localResult.missing_fields || []).filter((field) => !defaultedFields.includes(field)),
    low_confidence_fields: (localResult.low_confidence_fields || []).filter((field) => !defaultedFields.includes(field)),
    history_defaulted_fields: defaultedFields,
    history_default_warning_text: buildHistoryDefaultWarning(fields, defaultedFields)
  });
}

function protectLocalFacts(localResult, fields) {
  const nextFields = Object.assign({}, fields);
  const localFields = localResult.fields || {};
  const originalText = localResult.original_text || '';
  const aiCustomerName = nextFields.customerName;
  const aiRemark = String(nextFields.remark || '').trim();
  const localRequirementRemark = buildRemarkFromItems(localResult.remark_items || []);

  if (
    localFields.customerName
    && originalContainsName(originalText, localFields.customerName)
    && (!nextFields.customerName || !originalContainsName(originalText, nextFields.customerName))
  ) {
    nextFields.customerName = localFields.customerName;
    if (aiCustomerName && aiCustomerName !== localFields.customerName) delete nextFields.customerId;
  }

  if (localResult.history_status === 'not_found') {
    if (localResult.context_policy === 'customer_history') {
      delete nextFields.orderId;
      delete nextFields.quotationId;
      if (!localFields.unitPrice) {
        delete nextFields.unitPrice;
        if (!localFields.amount) delete nextFields.amount;
      }
      if (!localFields.dueDate) delete nextFields.dueDate;
    }
    if (localResult.context_policy === 'receivable_history') {
      delete nextFields.receivableId;
    }
  }

  nextFields.remark = aiRemark || localRequirementRemark || localFields.remark || originalText;
  return nextFields;
}

function normalizeAiResult(localResult, aiResult) {
  const normalized = unwrapAiResult(aiResult);
  const aiFields = normalizeFields(normalized.fields || normalized);
  const intent = mergeAiIntent(localResult, normalized);
  let merged = Object.assign({}, localResult, normalized, {
    intent
  });
  merged.id = normalized.id || localResult.id;
  merged.source = localResult.source;
  merged.original_text = localResult.original_text;
  merged.fields = protectLocalFacts(localResult, Object.assign({}, localResult.fields, aiFields));
  merged.missing_fields = toStringArray(normalized.missing_fields || normalized.missingFields)
    .filter((field) => !hasFieldValue(merged.fields, field));
  merged.low_confidence_fields = toArray(normalized.low_confidence_fields || normalized.lowConfidenceFields);
  merged.customer_candidates = toArray(normalized.customer_candidates || normalized.customerCandidates);
  merged.computed_fields = toArray(normalized.computed_fields || normalized.computedFields || localResult.computed_fields);
  merged.computed_tips = toArray(normalized.computed_tips || normalized.computedTips || localResult.computed_tips);
  merged.field_sources = Object.assign(
    {},
    localResult.field_sources,
    normalized.field_sources || normalized.fieldSources || {}
  );
  merged.field_evidence = normalizeObject(normalized.field_evidence || normalized.fieldEvidence, localResult.field_evidence || {});
  merged.remark_items = mergeRemarkItems(localResult.remark_items, normalized.remark_items || normalized.remarkItems);
  merged.intent_candidates = toStringArray(
    normalized.intent_candidates || normalized.intentCandidates || localResult.intent_candidates || intent
  );
  merged.confidence = normalized.confidence !== undefined ? normalized.confidence : localResult.confidence;
  merged.confirm_message = normalized.confirm_message || normalized.confirmMessage || localResult.confirm_message || '我识别成下面这样，你确认后再保存。';
  merged.ai_fallback = {
    needed: true,
    status: normalized.provider === 'mock' ? 'mock_used' : 'used'
  };
  merged.provider = normalized.provider || 'server';
  merged.context_policy = localResult.context_policy || 'none';
  merged.history_status = localResult.history_status || 'not_required';
  merged.history_warning_text = localResult.history_warning_text || '';
  merged.history_defaulted_fields = localResult.history_defaulted_fields || [];
  merged.history_default_warning_text = localResult.history_default_warning_text || '';
  merged.suggested_operation = localResult.suggested_operation || '';
  merged.raw_messages = localResult.raw_messages || [];
  merged = applyPostAiConsistency(merged, normalized);
  return merged;
}

function withAiStatus(localResult, status) {
  const result = Object.assign({}, localResult);
  result.ai_fallback = Object.assign({}, localResult.ai_fallback, { status });
  return result;
}

function parseHybridInput(payload) {
  const localParsedResult = parseInput(payload);
  const policy = getContextPolicy(payload.text, localParsedResult);
  const mentionedCustomerName = extractMentionedCustomerName(payload.text, localParsedResult);
  const scopedHistory = findScopedHistory(payload.state || {}, mentionedCustomerName, policy);
  const localReviewedResult = applyLocalParseSafety(
    attachConversationReview(attachHistoryInfo(localParsedResult, policy, scopedHistory), payload),
    {
      normalizedText: payload.rawText || payload.text || localParsedResult.original_text || '',
      originalText: payload.rawText || localParsedResult.original_text || '',
      source: payload.source || localParsedResult.source
    }
  );
  const forceAi = shouldForceAi(payload, localReviewedResult);
  const localResult = forceAi ? markAiNeeded(localReviewedResult) : localReviewedResult;
  if (!forceAi && policy === 'none' && (!localResult.ai_fallback || localResult.ai_fallback.needed === false)) {
    return Promise.resolve(withAiStatus(localResult, 'not_requested'));
  }
  if (typeof wx === 'undefined' || !getApiBaseUrl()) {
    return Promise.resolve(withAiStatus(localResult, 'skipped_no_endpoint'));
  }

  return requestJson(getAiParseEndpoint(), buildAiRequestPayload(payload, localResult, scopedHistory), AI_PARSE_TIMEOUT_MS)
    .then((aiResult) => normalizeAiResult(localResult, aiResult))
    .catch(() => withAiStatus(localResult, 'failed'));
}

module.exports = {
  buildAiRequestPayload,
  compactBusinessContext,
  extractMentionedCustomerName,
  findScopedHistory,
  getContextPolicy,
  normalizeAiResult,
  parseHybridInput
};
