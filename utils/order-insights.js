const { diffDays, today } = require('./date');

const ORDER_SORT_OPTIONS = [
  { key: 'orderDateDesc', label: '下单时间：最新在前' },
  { key: 'orderDateAsc', label: '下单时间：最早在前' },
  { key: 'amountDesc', label: '订单金额：从高到低' },
  { key: 'amountAsc', label: '订单金额：从低到高' },
  { key: 'deliveryAsc', label: '交期：最近在前' },
  { key: 'deliveryDesc', label: '交期：最晚在前' },
  { key: 'shipDateDesc', label: '发货时间：最新在前' },
  { key: 'shipDateAsc', label: '发货时间：最早在前' },
  { key: 'paymentDateDesc', label: '收款时间：最新在前' },
  { key: 'paymentDateAsc', label: '收款时间：最早在前' }
];

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function toMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function formatMoney(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function getPaymentDate(payment = {}) {
  return String(payment.paidAt || payment.createdAt || '').slice(0, 10);
}

function getOrderIdForPayment(payment, receivablesById) {
  if (payment.orderId) return payment.orderId;
  const receivable = receivablesById[payment.receivableId] || null;
  return receivable ? receivable.orderId || '' : '';
}

function buildOrderPaymentMap(state = {}) {
  const receivablesById = (state.receivables || []).reduce((map, item) => {
    map[item.id] = item;
    return map;
  }, {});
  return (state.paymentRecords || []).reduce((map, payment) => {
    const orderId = getOrderIdForPayment(payment, receivablesById);
    if (!orderId) return map;
    const date = getPaymentDate(payment);
    if (!map[orderId]) map[orderId] = { receivedAmount: 0, paymentDates: [] };
    map[orderId].receivedAmount += toMoney(payment.amount);
    if (date) map[orderId].paymentDates.push(date);
    return map;
  }, {});
}

function withOrderPaymentSummary(state, order) {
  const summary = buildOrderPaymentMap(state)[order.id] || { receivedAmount: 0, paymentDates: [] };
  const paymentDates = summary.paymentDates.slice().sort();
  return Object.assign({}, order, {
    receivedAmount: Number(summary.receivedAmount.toFixed(2)),
    receivedAmountText: formatMoney(summary.receivedAmount),
    firstPaymentDate: paymentDates[0] || '',
    lastPaymentDate: paymentDates[paymentDates.length - 1] || '',
    hasPayment: paymentDates.length > 0 || summary.receivedAmount > 0
  });
}

function enrichOrdersWithPayments(state, orders) {
  const paymentMap = buildOrderPaymentMap(state);
  return (orders || []).map((order) => {
    const summary = paymentMap[order.id] || { receivedAmount: 0, paymentDates: [] };
    const paymentDates = summary.paymentDates.slice().sort();
    return Object.assign({}, order, {
      receivedAmount: Number(summary.receivedAmount.toFixed(2)),
      receivedAmountText: formatMoney(summary.receivedAmount),
      firstPaymentDate: paymentDates[0] || '',
      lastPaymentDate: paymentDates[paymentDates.length - 1] || '',
      hasPayment: paymentDates.length > 0 || summary.receivedAmount > 0
    });
  });
}

function textIncludes(value, keyword) {
  if (!keyword) return true;
  return String(value || '').includes(String(keyword || '').trim());
}

function getItemsSearchText(item) {
  return (item.displayItems || item.items || [])
    .map((lineItem) => [
      lineItem.productName,
      lineItem.spec,
      lineItem.quantity,
      lineItem.unit,
      lineItem.unitPrice,
      lineItem.priceUnit,
      lineItem.totalAmount
    ].filter(Boolean).join(' '))
    .join(' ');
}

function isDeliverySoonOrder(item) {
  if (!item || !item.requiredDeliveryDate || ['已完成', '已取消'].includes(item.status)) return false;
  return diffDays(item.requiredDeliveryDate, today()) <= 3;
}

function hasOrderFilters(filters = {}) {
  return Boolean(filters.preset || filters.keyword || filters.customer || filters.product || filters.status
    || filters.minAmount || filters.maxAmount || filters.orderDate || filters.dueDate || filters.shipDate || filters.paymentDate);
}

function hasAdvancedOrderFilters(filters = {}) {
  return Boolean(filters.preset || filters.customer || filters.product || filters.status || filters.minAmount || filters.maxAmount
    || filters.orderDate || filters.dueDate || filters.shipDate || filters.paymentDate);
}

function filterOrders(orders, filters = {}) {
  const minAmount = hasValue(filters.minAmount) ? Number(filters.minAmount) : null;
  const maxAmount = hasValue(filters.maxAmount) ? Number(filters.maxAmount) : null;
  return (orders || []).filter((item) => {
    if (filters.preset === 'deliverySoon' && !isDeliverySoonOrder(item)) return false;
    const customerText = [item.customerDisplay, item.customer && item.customer.name].filter(Boolean).join(' ');
    const productText = [item.itemsSummary, item.productName, item.spec, getItemsSearchText(item)].filter(Boolean).join(' ');
    const searchableText = `${customerText} ${productText}`;
    const amount = Number(item.totalAmount);
    if (filters.status && item.status !== filters.status) return false;
    if (Number.isFinite(minAmount) && (!Number.isFinite(amount) || amount < minAmount)) return false;
    if (Number.isFinite(maxAmount) && (!Number.isFinite(amount) || amount > maxAmount)) return false;
    if (filters.orderDate && item.orderDate !== filters.orderDate) return false;
    if (filters.dueDate && item.requiredDeliveryDate !== filters.dueDate) return false;
    if (filters.shipDate && item.actualShipDate !== filters.shipDate) return false;
    if (filters.paymentDate && item.lastPaymentDate !== filters.paymentDate) return false;
    return textIncludes(searchableText, filters.keyword)
      && textIncludes(customerText, filters.customer)
      && textIncludes(productText, filters.product);
  });
}

function compareMissingLast(left, right, direction, valueGetter) {
  const leftValue = valueGetter(left);
  const rightValue = valueGetter(right);
  const leftMissing = leftValue === '' || leftValue === undefined || leftValue === null || Number.isNaN(leftValue);
  const rightMissing = rightValue === '' || rightValue === undefined || rightValue === null || Number.isNaN(rightValue);
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (leftValue === rightValue) return 0;
  return (leftValue < rightValue ? -1 : 1) * direction;
}

function sortOrders(orders, sortKey = 'orderDateDesc') {
  const source = (orders || []).slice();
  const sorters = {
    orderDateDesc: (a, b) => compareMissingLast(a, b, -1, (item) => String(item.orderDate || item.createdAt || '')),
    orderDateAsc: (a, b) => compareMissingLast(a, b, 1, (item) => String(item.orderDate || item.createdAt || '')),
    amountDesc: (a, b) => compareMissingLast(a, b, -1, (item) => hasValue(item.totalAmount) ? Number(item.totalAmount) : NaN),
    amountAsc: (a, b) => compareMissingLast(a, b, 1, (item) => hasValue(item.totalAmount) ? Number(item.totalAmount) : NaN),
    deliveryAsc: (a, b) => compareMissingLast(a, b, 1, (item) => String(item.requiredDeliveryDate || '')),
    deliveryDesc: (a, b) => compareMissingLast(a, b, -1, (item) => String(item.requiredDeliveryDate || '')),
    shipDateDesc: (a, b) => compareMissingLast(a, b, -1, (item) => String(item.actualShipDate || '')),
    shipDateAsc: (a, b) => compareMissingLast(a, b, 1, (item) => String(item.actualShipDate || '')),
    paymentDateDesc: (a, b) => compareMissingLast(a, b, -1, (item) => String(item.lastPaymentDate || '')),
    paymentDateAsc: (a, b) => compareMissingLast(a, b, 1, (item) => String(item.lastPaymentDate || ''))
  };
  return source.sort(sorters[sortKey] || sorters.orderDateDesc);
}

function buildCustomerOrderStats(orders) {
  const map = {};
  (orders || []).forEach((order) => {
    const customerId = order.customerId || '__unlinked__';
    const customerName = (order.customer && order.customer.name)
      || String(order.customerDisplay || '').replace(/（.*$/, '')
      || '未关联客户';
    if (!map[customerId]) {
      map[customerId] = {
        customerId,
        customerName,
        orderCount: 0,
        orderAmount: 0,
        receivedAmount: 0
      };
    }
    map[customerId].orderCount += 1;
    map[customerId].orderAmount += toMoney(order.totalAmount);
    map[customerId].receivedAmount += toMoney(order.receivedAmount);
  });
  return Object.values(map)
    .map((item) => Object.assign({}, item, {
      orderAmount: Number(item.orderAmount.toFixed(2)),
      receivedAmount: Number(item.receivedAmount.toFixed(2)),
      orderAmountText: formatMoney(item.orderAmount),
      receivedAmountText: formatMoney(item.receivedAmount)
    }))
    .sort((left, right) => right.orderAmount - left.orderAmount || right.orderCount - left.orderCount);
}

module.exports = {
  ORDER_SORT_OPTIONS,
  buildCustomerOrderStats,
  buildOrderPaymentMap,
  enrichOrdersWithPayments,
  filterOrders,
  hasAdvancedOrderFilters,
  hasOrderFilters,
  sortOrders,
  withOrderPaymentSummary
};
