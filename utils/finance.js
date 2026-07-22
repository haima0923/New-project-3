const { decorateRecords, getOrderDepositAmount, getOrderRemainingSettlement } = require('./business');
const { diffDays, today } = require('./date');

const activeReceivableStatuses = ['待收', '部分收款'];
const activeOrderStatuses = ['待生产', '生产中', '待发货', '已发货'];
const productionOrderStatuses = ['待生产', '生产中', '待发货'];

function toMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function formatMoney(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function isSameMonth(date, monthPrefix) {
  return Boolean(date && String(date).slice(0, 7) === monthPrefix);
}

function getRemainingAmount(receivable) {
  return Math.max(0, toMoney(receivable.amount) - toMoney(receivable.paidAmount));
}

function getReceivableSource(receivable) {
  if (receivable.source) return receivable.source;
  if (receivable.orderId) return 'order';
  return 'manual';
}

function getSourceLabel(source) {
  return {
    order: '订单待收',
    legacy: '历史待收',
    manual: '手动待收'
  }[source] || '待收款';
}

function getPaymentKindLabel(kind) {
  return {
    deposit: '定金',
    final_payment: '尾款',
    receivable_payment: '待收回款',
    legacy_payment: '历史欠款回款',
    unlinked_payment: '待核对收款',
    unlinked_deposit: '待核对定金'
  }[kind] || '收款';
}

function hasReceivableForOrder(state, orderId) {
  return (state.receivables || []).some((item) => item.orderId === orderId);
}

function getOrderTitle(order) {
  return order.productName || order.spec || '未填产品';
}

function getDecoratedOrders(state, orders) {
  return decorateRecords(state, orders || []);
}

function getActiveReceivables(state) {
  return decorateRecords(state, state.receivables || [])
    .filter((item) => activeReceivableStatuses.includes(item.status))
    .map((item) => {
      const source = getReceivableSource(item);
      const order = (state.orders || []).find((record) => record.id === item.orderId) || null;
      const remainingAmount = getRemainingAmount(item);
      const overdueDays = item.dueDate ? Math.max(0, -diffDays(item.dueDate, today())) : 0;
      return Object.assign({}, item, {
        source,
        sourceLabel: getSourceLabel(source),
        orderProductName: order ? getOrderTitle(order) : '',
        paidAmountText: formatMoney(item.paidAmount),
        remainingAmount,
        remainingAmountText: formatMoney(remainingAmount),
        amountText: formatMoney(item.amount),
        overdueDays,
        isOverdue: overdueDays > 0
      });
    });
}

function buildPaymentRows(state) {
  const receivablesById = (state.receivables || []).reduce((map, item) => {
    map[item.id] = item;
    return map;
  }, {});
  const ordersById = (state.orders || []).reduce((map, item) => {
    map[item.id] = item;
    return map;
  }, {});
  return decorateRecords(state, state.paymentRecords || [])
    .map((item) => {
      const receivable = receivablesById[item.receivableId] || {};
      const order = item.orderId ? ordersById[item.orderId] : (receivable.orderId ? ordersById[receivable.orderId] : null);
      const kind = item.kind || item.paymentKind || (item.orderId ? 'deposit' : 'receivable_payment');
      return Object.assign({}, item, {
        kind,
        kindLabel: getPaymentKindLabel(kind),
        amountText: formatMoney(item.amount),
        paidAtText: item.paidAt || String(item.createdAt || '').slice(0, 10) || '-',
        receivableAmountText: receivable.amount ? formatMoney(receivable.amount) : '',
        orderProductName: order ? getOrderTitle(order) : '',
        sourceLabel: getPaymentKindLabel(kind)
      });
    })
    .sort((left, right) => String(right.paidAt || right.createdAt || '').localeCompare(String(left.paidAt || left.createdAt || '')));
}

function buildSettlementRows(state) {
  return getDecoratedOrders(state, state.orders || [])
    .filter((item) => activeOrderStatuses.includes(item.status))
    .filter((item) => !hasReceivableForOrder(state, item.id))
    .map((item) => {
      const depositAmount = getOrderDepositAmount(state, item.id);
      const remainingSettlementAmount = getOrderRemainingSettlement(state, item);
      return Object.assign({}, item, {
        depositAmount,
        remainingSettlementAmount,
        amountText: formatMoney(item.totalAmount),
        depositAmountText: formatMoney(depositAmount),
        remainingSettlementText: formatMoney(remainingSettlementAmount),
        quantityText: `${item.quantity || '-'}${item.unit || ''}`,
        productTitle: getOrderTitle(item),
        isShipped: item.status === '已发货'
      });
    })
    .sort((left, right) => String(left.requiredDeliveryDate || '9999-12-31').localeCompare(String(right.requiredDeliveryDate || '9999-12-31')));
}

function buildFinanceViewModel(state) {
  const safeState = state || {};
  const current = today();
  const monthPrefix = current.slice(0, 7);
  const activeReceivables = getActiveReceivables(safeState);
  const paymentRows = buildPaymentRows(safeState);
  const settlementRows = buildSettlementRows(safeState);
  const productionOrders = settlementRows.filter((item) => productionOrderStatuses.includes(item.status));
  const shippedPendingOrders = settlementRows.filter((item) => item.status === '已发货');
  const overdueRows = activeReceivables.filter((item) => item.isOverdue);
  const monthlyReceivableAmount = activeReceivables
    .filter((item) => isSameMonth(item.dueDate, monthPrefix))
    .reduce((sum, item) => sum + item.remainingAmount, 0);
  const monthlyPayments = (safeState.paymentRecords || [])
    .filter((item) => isSameMonth(item.paidAt || item.createdAt, monthPrefix));
  const monthlyPaymentAmount = monthlyPayments
    .reduce((sum, item) => sum + toMoney(item.amount), 0);
  const monthlyUnlinkedPayments = monthlyPayments
    .filter((item) => ['unlinked_payment', 'unlinked_deposit'].includes(item.kind || item.paymentKind));
  const monthlyUnlinkedPaymentAmount = monthlyUnlinkedPayments
    .reduce((sum, item) => sum + toMoney(item.amount), 0);
  const overdueAmount = overdueRows.reduce((sum, item) => sum + item.remainingAmount, 0);
  const productionSettlementAmount = productionOrders.reduce((sum, item) => sum + toMoney(item.remainingSettlementAmount), 0);
  const productionOrderCount = productionOrders.length;
  const shippedPendingAmount = shippedPendingOrders.reduce((sum, item) => sum + toMoney(item.remainingSettlementAmount), 0);
  const partialRemainingAmount = activeReceivables
    .filter((item) => item.status === '部分收款')
    .reduce((sum, item) => sum + item.remainingAmount, 0);
  const settledThisMonthCount = (safeState.receivables || [])
    .filter((item) => item.status === '已结清' && isSameMonth(item.updatedAt || item.dueDate, monthPrefix))
    .length;

  return {
    summary: {
      monthlyReceivableAmount,
      monthlyReceivableText: formatMoney(monthlyReceivableAmount),
      monthlyPaymentAmount,
      monthlyPaymentText: formatMoney(monthlyPaymentAmount),
      monthlyPaymentHint: monthlyUnlinkedPayments.length
        ? `其中 ${formatMoney(monthlyUnlinkedPaymentAmount)} 元待核对`
        : '含订单定金',
      overdueAmount,
      overdueText: formatMoney(overdueAmount),
      productionSettlementAmount,
      productionSettlementText: formatMoney(productionSettlementAmount)
    },
    stats: {
      productionOrderCount,
      productionOrderCountText: String(productionOrderCount),
      shippedPendingAmount,
      shippedPendingText: formatMoney(shippedPendingAmount),
      partialRemainingAmount,
      partialRemainingText: formatMoney(partialRemainingAmount),
      settledThisMonthCount
    },
    receivableRows: activeReceivables.sort((left, right) => {
      if (left.isOverdue !== right.isOverdue) return left.isOverdue ? -1 : 1;
      return String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31'));
    }),
    paymentRows,
    settlementRows,
    overdueRows: overdueRows.sort((left, right) => right.overdueDays - left.overdueDays)
  };
}

module.exports = {
  buildFinanceViewModel,
  formatMoney,
  getReceivableSource,
  getRemainingAmount
};
