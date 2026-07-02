const { decorateRecords, getDashboard, getOrderDepositAmount, getOrderRemainingSettlement } = require('./business');
const { diffDays, today } = require('./date');

function toMoneyText(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function shortCustomerName(value) {
  return String(value || '客户').replace(/（.*$/, '');
}

function shortText(value, maxLength) {
  const source = String(value || '');
  if (source.length <= maxLength) return source;
  return `${source.slice(0, maxLength)}...`;
}

const recordTypeMeta = {
  quotation: { label: '报价', icon: '报' },
  order: { label: '订单', icon: '单' },
  receivable: { label: '应收', icon: '应' },
  payment: { label: '收款', icon: '收' },
  todo: { label: '提醒', icon: '提' },
  pending: { label: '待整理', icon: '整' },
  log: { label: '记录', icon: '记' }
};

function getRecordTypeMeta(type) {
  return recordTypeMeta[type] || recordTypeMeta.log;
}

function getPaymentKindLabel(kind) {
  return {
    deposit: '定金',
    final_payment: '尾款',
    receivable_payment: '收款',
    legacy_payment: '历史收款'
  }[kind] || '收款';
}

function withRecordTypeMeta(record) {
  const meta = getRecordTypeMeta(record.type);
  return Object.assign({}, record, {
    typeLabel: meta.label,
    typeIcon: meta.icon
  });
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const current = today();
  const day = date.toISOString().slice(0, 10);
  const time = date.toTimeString().slice(0, 5);
  return day === current ? time : `${day.slice(5)} ${time}`;
}

function buildReceivableTask(item, overdue) {
  const meta = getRecordTypeMeta('receivable');
  const days = item.dueDate ? diffDays(item.dueDate, today()) : 0;
  return {
    id: `receivable-${item.id}`,
    sourceId: item.id,
    type: 'receivable',
    priority: overdue ? 10 : 20,
    icon: meta.icon,
    tone: overdue ? 'danger' : 'success',
    title: `${shortCustomerName(item.customerDisplay)}待收款`,
    badge: overdue ? `逾期${Math.abs(days)}天` : '今天到期',
    company: item.customer && item.customer.company ? item.customer.company : shortCustomerName(item.customerDisplay),
    detail: `尾款 ¥${toMoneyText(item.remainingAmount || item.amount)}`,
    actionLabel: '去处理'
  };
}

function buildOrderTask(item, state) {
  const meta = getRecordTypeMeta('order');
  const days = item.requiredDeliveryDate ? diffDays(item.requiredDeliveryDate, today()) : 0;
  const depositAmount = getOrderDepositAmount(state, item.id);
  const remainingSettlement = getOrderRemainingSettlement(state, item);
  const detail = depositAmount > 0
    ? `待收尾款 ¥${toMoneyText(remainingSettlement)}`
    : `交货期：${item.requiredDeliveryDate || '-'}`;
  return {
    id: `order-${item.id}`,
    sourceId: item.id,
    type: 'order',
    priority: days < 0 ? 30 : 40 + days,
    icon: meta.icon,
    tone: days <= 0 ? 'warning' : 'blue',
    title: `${item.productName || '订单'}交期`,
    badge: days < 0 ? `逾期${Math.abs(days)}天` : (days === 0 ? '今天交货' : `${days}天后到期`),
    company: shortCustomerName(item.customerDisplay),
    detail,
    actionLabel: '去查看'
  };
}

function buildQuotationTask(item) {
  const meta = getRecordTypeMeta('quotation');
  const days = item.quoteDate ? diffDays(today(), item.quoteDate) : 0;
  return {
    id: `quotation-${item.id}`,
    sourceId: item.id,
    type: 'quotation',
    priority: 50 + Math.max(0, 7 - days),
    icon: meta.icon,
    tone: 'purple',
    title: `${shortCustomerName(item.customerDisplay)}报价跟进`,
    badge: days > 0 ? `${days}天未跟进` : '待跟进',
    company: item.customer && item.customer.company ? item.customer.company : shortCustomerName(item.customerDisplay),
    detail: `报价单：${item.productName || item.id}`,
    actionLabel: '去跟进'
  };
}

function buildTodoTask(item, overdue) {
  const meta = getRecordTypeMeta('todo');
  return {
    id: `todo-${item.id}`,
    sourceId: item.id,
    type: 'todo',
    priority: overdue ? 60 : 70,
    icon: meta.icon,
    tone: overdue ? 'danger' : 'blue',
    title: item.title || '待办提醒',
    badge: overdue ? '已逾期' : '今天提醒',
    company: shortCustomerName(item.customerDisplay || ''),
    detail: item.remark ? shortText(item.remark, 22) : `提醒日：${item.remindDate || '-'}`,
    actionLabel: '去处理'
  };
}

function buildPendingTask(item) {
  const meta = getRecordTypeMeta('pending');
  return {
    id: `pending-${item.id}`,
    sourceId: item.id,
    type: 'pending',
    priority: 80,
    icon: meta.icon,
    tone: 'gray',
    title: '待整理记录',
    badge: '需补充',
    company: '',
    detail: shortText(item.originalText || item.reason || '有一条记录需要补齐', 28),
    actionLabel: '去整理'
  };
}

function buildTodayTasks(state, limit = 3) {
  const summary = getDashboard(state);
  const overdue = decorateRecords(state, summary.overdue || []).map((item) => buildReceivableTask(item, true));
  const dueToday = decorateRecords(state, summary.dueToday || []).map((item) => buildReceivableTask(item, false));
  const orders = decorateRecords(state, summary.deliverySoon || []).map((item) => buildOrderTask(item, state));
  const quotations = decorateRecords(state, summary.quoteFollowups || []).map(buildQuotationTask);
  const todoOverdue = decorateRecords(state, summary.todoOverdue || []).map((item) => buildTodoTask(item, true));
  const todoDueToday = decorateRecords(state, summary.todoDueToday || []).map((item) => buildTodoTask(item, false));
  const pending = (summary.pendingNotes || []).map(buildPendingTask);

  return overdue
    .concat(dueToday, orders, quotations, todoOverdue, todoDueToday, pending)
    .sort((left, right) => left.priority - right.priority)
    .slice(0, limit);
}

function buildTodayTaskRecords(state) {
  return buildTodayTasks(state, Number.MAX_SAFE_INTEGER).map((task, index) => withRecordTypeMeta({
    id: task.id,
    sourceId: task.sourceId,
    type: task.type,
    title: task.title,
    summary: [task.badge, task.company, task.detail].filter(Boolean).join(' · '),
    time: task.actionLabel,
    createdAt: String(100000 - index).padStart(6, '0')
  }));
}

function buildRecordItem(type, item, state) {
  if (type === 'quotation') {
    const decorated = decorateRecords(state, [item])[0];
    return withRecordTypeMeta({
      id: item.id,
      type,
      title: `${shortCustomerName(decorated.customerDisplay)} · ${item.productName || '未填产品'}`,
      summary: `报价 ¥${toMoneyText(item.totalAmount)}，状态 ${item.status || '-'}`,
      time: formatDateTime(item.createdAt || item.quoteDate),
      createdAt: item.createdAt || item.quoteDate || ''
    });
  }
  if (type === 'order') {
    const decorated = decorateRecords(state, [item])[0];
    const depositAmount = getOrderDepositAmount(state, item.id);
    const remainingSettlement = getOrderRemainingSettlement(state, item);
    const moneyPart = depositAmount > 0
      ? `已收定金 ¥${toMoneyText(depositAmount)}，待收尾款 ¥${toMoneyText(remainingSettlement)}`
      : `状态 ${item.status || '-'}`;
    return withRecordTypeMeta({
      id: item.id,
      type,
      title: `${shortCustomerName(decorated.customerDisplay)} · ${item.productName || '未填产品'}`,
      summary: `交期 ${item.requiredDeliveryDate || '-'}，${moneyPart}`,
      time: formatDateTime(item.createdAt || item.orderDate),
      createdAt: item.createdAt || item.orderDate || ''
    });
  }
  if (type === 'receivable') {
    const decorated = decorateRecords(state, [item])[0];
    return withRecordTypeMeta({
      id: item.id,
      type,
      title: `${shortCustomerName(decorated.customerDisplay)} · 应收 ¥${toMoneyText(item.amount)}`,
      summary: `剩余 ¥${toMoneyText(Number(item.amount || 0) - Number(item.paidAmount || 0))}，到期 ${item.dueDate || '-'}`,
      time: formatDateTime(item.createdAt || item.dueDate),
      createdAt: item.createdAt || item.dueDate || ''
    });
  }
  if (type === 'payment') {
    const receivable = (state.receivables || []).find((record) => record.id === item.receivableId) || {};
    const decorated = receivable.id
      ? decorateRecords(state, [receivable])[0]
      : decorateRecords(state, [item])[0];
    const kindLabel = getPaymentKindLabel(item.kind || item.paymentKind || (item.orderId ? 'deposit' : 'receivable_payment'));
    return withRecordTypeMeta({
      id: item.id,
      type,
      title: `${shortCustomerName(decorated.customerDisplay)} · ${kindLabel} ¥${toMoneyText(item.amount)}`,
      summary: `类型：${kindLabel}${item.orderId ? ' · 关联订单' : ''}`,
      time: formatDateTime(item.createdAt || item.paymentDate),
      createdAt: item.createdAt || item.paymentDate || ''
    });
  }
  if (type === 'todo') {
    const decorated = decorateRecords(state, [item])[0];
    return withRecordTypeMeta({
      id: item.id,
      type,
      title: item.title || '待办提醒',
      summary: `${shortCustomerName(decorated.customerDisplay || '')} ${item.remindDate || '未设置日期'} ${item.status || ''}`.trim(),
      time: formatDateTime(item.createdAt || item.remindDate),
      createdAt: item.createdAt || item.remindDate || ''
    });
  }
  if (type === 'pending') {
    return withRecordTypeMeta({
      id: item.id,
      type,
      title: shortText(item.originalText || '待整理记录', 24),
      summary: item.reason || '信息不完整，需要稍后整理',
      time: formatDateTime(item.createdAt),
      createdAt: item.createdAt || ''
    });
  }
  return withRecordTypeMeta({
    id: item.id,
    type: 'log',
    title: shortText(item.originalText || '记了一笔', 24),
    summary: item.action || '',
    time: formatDateTime(item.createdAt),
    createdAt: item.createdAt || ''
  });
}

function buildAllRecords(state, filterType = 'all') {
  const records = []
    .concat((state.quotations || []).map((item) => buildRecordItem('quotation', item, state)))
    .concat((state.orders || []).map((item) => buildRecordItem('order', item, state)))
    .concat((state.receivables || []).map((item) => buildRecordItem('receivable', item, state)))
    .concat((state.paymentRecords || []).map((item) => buildRecordItem('payment', item, state)))
    .concat((state.todos || []).map((item) => buildRecordItem('todo', item, state)))
    .concat((state.pendingNotes || []).map((item) => buildRecordItem('pending', item, state)));

  const filtered = filterType === 'all' ? records : records.filter((item) => item.type === filterType);
  return filtered.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function buildRecentRecords(state, limit = 3) {
  const logs = (state.aiParseLogs || []).slice(0, limit).map((item) => buildRecordItem('log', item, state));
  if (logs.length) return logs;
  return buildAllRecords(state, 'all').slice(0, limit);
}

module.exports = {
  buildAllRecords,
  buildRecentRecords,
  buildTodayTaskRecords,
  buildTodayTasks,
  formatDateTime,
  shortText
};
