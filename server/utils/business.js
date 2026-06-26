const { addDays, diffDays, today } = require('./date');
const { generateId, getCustomerDisplay, normalizeCustomer, simpleFingerprint } = require('./storage');

function getCustomerById(state, id) {
  return (state.customers || []).find((customer) => customer.id === id);
}

function findOrCreateCustomer(state, fields) {
  const phoneFingerprint = simpleFingerprint(fields.phone);
  let customer = null;
  if (phoneFingerprint) {
    customer = state.customers.find((item) => item.phoneFingerprint === phoneFingerprint);
  }
  if (!customer && fields.customerId) {
    customer = getCustomerById(state, fields.customerId);
  }
  if (!customer && fields.customerName) {
    customer = state.customers.find((item) => item.name === fields.customerName && !item.phoneFingerprint);
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
    region: fields.region || ''
  });
  created.lastTradeAt = today();
  state.customers.unshift(created);
  return created;
}

function isFormalReady(parseResult) {
  return !parseResult.missing_fields.length && !parseResult.low_confidence_fields.length && parseResult.intent !== 'unknown';
}

function savePendingNote(state, parseResult, reason = '信息不完整，需要稍后整理') {
  const note = {
    id: generateId('pending'),
    userId: 'local-user',
    originalText: parseResult.original_text,
    guessedIntent: parseResult.intent,
    guessedFields: parseResult.fields,
    missingFields: parseResult.missing_fields,
    lowConfidenceFields: parseResult.low_confidence_fields,
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
  state.aiParseLogs.unshift({
    id: generateId('log'),
    userId: 'local-user',
    inputSource: parseResult.source,
    originalText: parseResult.original_text,
    parseResult,
    action,
    createdAt: new Date().toISOString()
  });
}

function saveQuotation(state, parseResult) {
  const fields = parseResult.fields;
  const customer = findOrCreateCustomer(state, fields);
  const quotation = {
    id: generateId('quo'),
    userId: 'local-user',
    customerId: customer.id,
    productName: fields.productName,
    spec: fields.spec || '',
    quantity: fields.quantity || '',
    unit: fields.unit || '',
    unitPrice: fields.unitPrice || '',
    totalAmount: fields.amount || '',
    paymentMethod: fields.paymentMethod || '',
    followupDays: fields.followupDays || '',
    deliveryDate: fields.dueDate || addDays(today(), 2),
    quoteDate: fields.quoteDate || today(),
    validUntil: addDays(today(), 7),
    status: '待确认',
    remark: fields.remark || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.quotations.unshift(quotation);
  appendParseLog(state, parseResult, 'save_quotation');
  return quotation;
}

function saveOrder(state, parseResult) {
  const fields = parseResult.fields;
  const customer = findOrCreateCustomer(state, fields);
  const order = {
    id: generateId('ord'),
    userId: 'local-user',
    customerId: customer.id,
    quotationId: fields.quotationId || '',
    productName: fields.productName,
    spec: fields.spec || '',
    quantity: fields.quantity || '',
    unit: fields.unit || '',
    unitPrice: fields.unitPrice || '',
    totalAmount: fields.amount || '',
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
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: '创建订单',
    createdAt: new Date().toISOString()
  });
  appendParseLog(state, parseResult, 'save_order');
  return order;
}

function saveReceivable(state, parseResult) {
  const fields = parseResult.fields;
  const customer = findOrCreateCustomer(state, fields);
  const receivable = {
    id: generateId('rec'),
    userId: 'local-user',
    customerId: customer.id,
    orderId: fields.orderId || '',
    amount: fields.amount || '',
    dueDate: fields.dueDate || '',
    status: '待收',
    paidAmount: '0',
    dunningCount: 0,
    lastDunningDate: '',
    remark: fields.remark || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.receivables.unshift(receivable);
  appendParseLog(state, parseResult, 'save_receivable');
  return receivable;
}

function savePayment(state, parseResult) {
  const fields = parseResult.fields;
  const customer = findOrCreateCustomer(state, fields);
  const activeReceivable = state.receivables.find((item) => item.customerId === customer.id && !['已结清', '坏账'].includes(item.status));
  const payment = {
    id: generateId('pay'),
    userId: 'local-user',
    customerId: customer.id,
    receivableId: activeReceivable ? activeReceivable.id : '',
    amount: fields.amount || '',
    paidAt: today(),
    remark: fields.remark || '',
    createdAt: new Date().toISOString()
  };
  state.paymentRecords.unshift(payment);
  if (activeReceivable) {
    const paid = Number(activeReceivable.paidAmount || 0) + Number(fields.amount || 0);
    activeReceivable.paidAmount = String(paid);
    activeReceivable.status = paid >= Number(activeReceivable.amount || 0) ? '已结清' : '部分收款';
    activeReceivable.updatedAt = new Date().toISOString();
  }
  appendParseLog(state, parseResult, 'save_payment');
  return payment;
}

function saveTodo(state, parseResult) {
  const fields = parseResult.fields || {};
  state.todos = state.todos || [];
  let customer = null;
  if (fields.customerName || fields.customerId || fields.phone) {
    customer = findOrCreateCustomer(state, fields);
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
    remindDate: fields.dueDate || '',
    status: '待办',
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
  if (!isFormalReady(parseResult)) {
    appendParseLog(state, parseResult, 'save_pending');
    return { type: 'pending', record: savePendingNote(state, parseResult) };
  }
  if (parseResult.intent === 'quotation') return { type: 'quotation', record: saveQuotation(state, parseResult) };
  if (parseResult.intent === 'order') return { type: 'order', record: saveOrder(state, parseResult) };
  if (parseResult.intent === 'receivable') return { type: 'receivable', record: saveReceivable(state, parseResult) };
  if (parseResult.intent === 'payment') return { type: 'payment', record: savePayment(state, parseResult) };
  if (parseResult.intent === 'todo') return { type: 'todo', record: saveTodo(state, parseResult) };
  appendParseLog(state, parseResult, 'save_pending');
  return { type: 'pending', record: savePendingNote(state, parseResult) };
}

function convertQuotationToOrder(state, quotationId) {
  const quotation = state.quotations.find((item) => item.id === quotationId);
  if (!quotation) return null;
  const order = {
    id: generateId('ord'),
    userId: quotation.userId,
    customerId: quotation.customerId,
    quotationId: quotation.id,
    productName: quotation.productName,
    spec: quotation.spec,
    quantity: quotation.quantity,
    unit: quotation.unit,
    unitPrice: quotation.unitPrice,
    totalAmount: quotation.totalAmount,
    paymentMethod: quotation.paymentMethod,
    orderDate: today(),
    requiredDeliveryDate: '',
    expectedShipDate: '',
    actualShipDate: '',
    status: '待生产',
    logisticsInfo: '',
    remark: `由报价 ${quotation.id} 转入`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  quotation.status = '已下单';
  quotation.updatedAt = new Date().toISOString();
  state.orders.unshift(order);
  state.orderProgress.unshift({
    id: generateId('prog'),
    orderId: order.id,
    status: order.status,
    note: '报价转订单',
    createdAt: new Date().toISOString()
  });
  return order;
}

function generateReceivableFromOrder(state, orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return null;
  const existing = state.receivables.find((item) => item.orderId === orderId);
  if (existing) return existing;
  const receivable = {
    id: generateId('rec'),
    userId: order.userId,
    customerId: order.customerId,
    orderId: order.id,
    amount: order.totalAmount || '0',
    dueDate: order.requiredDeliveryDate || today(),
    status: '待收',
    paidAmount: '0',
    dunningCount: 0,
    lastDunningDate: '',
    remark: `由订单 ${order.id} 生成`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.receivables.unshift(receivable);
  return receivable;
}

function updateOrderStatus(state, orderId, status) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return null;
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

function recordPayment(state, receivableId, amount) {
  const receivable = state.receivables.find((item) => item.id === receivableId);
  if (!receivable) return null;
  const paymentAmount = Number(amount || 0);
  const paid = Number(receivable.paidAmount || 0) + paymentAmount;
  receivable.paidAmount = String(paid);
  receivable.status = paid >= Number(receivable.amount || 0) ? '已结清' : '部分收款';
  receivable.updatedAt = new Date().toISOString();
  const payment = {
    id: generateId('pay'),
    userId: receivable.userId,
    customerId: receivable.customerId,
    receivableId: receivable.id,
    amount: String(paymentAmount),
    paidAt: today(),
    remark: '',
    createdAt: new Date().toISOString()
  };
  state.paymentRecords.unshift(payment);
  return payment;
}

function generateDunningMessage(state, receivableId, tone = 'polite') {
  const receivable = state.receivables.find((item) => item.id === receivableId);
  if (!receivable) return '';
  const customer = getCustomerById(state, receivable.customerId);
  const template = state.dunningTemplates.find((item) => item.id === tone) || state.dunningTemplates[0];
  return template.content
    .replace('{customer}', customer ? customer.name : '老板')
    .replace('{amount}', `${receivable.amount || 0}元`);
}

function recordDunning(state, receivableId, message) {
  const receivable = state.receivables.find((item) => item.id === receivableId);
  if (!receivable) return null;
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
  completeTodo,
  convertQuotationToOrder,
  decorateRecords,
  generateDunningMessage,
  generateReceivableFromOrder,
  getCustomerById,
  getDashboard,
  recordDunning,
  recordPayment,
  saveConfirmedDraft,
  savePendingNote,
  updateOrderStatus
};
