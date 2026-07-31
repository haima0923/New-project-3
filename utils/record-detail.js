const {
  decorateRecords,
  getItemsSummary,
  getOrderDepositAmount,
  getOrderRemainingSettlement,
  getRecordItems
} = require('./business');

const TYPE_LABELS = {
  quotation: '报价详情',
  order: '订单详情',
  receivable: '待收款详情',
  payment: '收款详情',
  todo: '提醒详情',
  pending: '待整理详情'
};

const COLLECTION_BY_TYPE = {
  quotation: 'quotations',
  order: 'orders',
  receivable: 'receivables',
  payment: 'paymentRecords',
  todo: 'todos',
  pending: 'pendingNotes'
};

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function money(value) {
  if (!hasValue(value)) return '未填写';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${Number(number.toFixed(2))} 元`;
}

function quantity(value, unit) {
  if (!hasValue(value) && !hasValue(unit)) return '未填写';
  return `${hasValue(value) ? value : '-'}${unit || ''}`;
}

function text(value, fallback = '未填写') {
  return hasValue(value) ? String(value) : fallback;
}

function field(label, value, options = {}) {
  return {
    label,
    value: text(value, options.fallback)
  };
}

function getRecord(state, type, id) {
  const collection = COLLECTION_BY_TYPE[type];
  if (!collection || !id) return null;
  return (state[collection] || []).find((item) => item.id === id) || null;
}

function getCustomerName(state, record) {
  if (!record || !record.customerId) return '未关联客户';
  const decorated = decorateRecords(state, [record])[0];
  return decorated && decorated.customerDisplay ? decorated.customerDisplay : '未关联客户';
}

function getExistingCustomerId(state, record) {
  if (!record || !record.customerId) return '';
  return (state.customers || []).some((customer) => customer.id === record.customerId && !customer.mergedInto)
    ? record.customerId
    : '';
}

function getPaymentKindLabel(kind) {
  return {
    deposit: '订单定金',
    partial_payment: '部分收款',
    final_payment: '尾款',
    receivable_payment: '待收回款',
    legacy_payment: '历史欠款回款',
    unlinked_payment: '未关联收款',
    unlinked_deposit: '未关联订单定金'
  }[kind] || '收款';
}

function getSourceLabel(record = {}) {
  return {
    order: '由订单生成',
    legacy: '历史欠款',
    manual: '手动记录'
  }[record.source] || (record.orderId ? '由订单生成' : '未注明');
}

function buildItems(record) {
  return getRecordItems(record).map((item, index) => ({
    key: `${record.id || 'record'}-${index}`,
    title: item.productName || '未填写商品',
    spec: item.spec || '',
    quantityText: quantity(item.quantity, item.unit),
    unitPriceText: hasValue(item.unitPrice)
      ? `${money(item.unitPrice)} / ${item.priceUnit || item.unit || '单位'}`
      : '未填写',
    totalAmountText: money(item.totalAmount),
    deliveryDate: item.itemDeliveryDate || '',
    remark: item.itemRemark || ''
  }));
}

function buildQuotationDetail(state, record) {
  return {
    title: getItemsSummary(record) || '报价',
    status: record.status || '状态未知',
    customerId: getExistingCustomerId(state, record),
    relatedOrderId: record.convertedOrderId || '',
    fields: [
      field('客户', getCustomerName(state, record)),
      field('报价日期', record.quoteDate),
      field('跟进日期', record.deliveryDate, { fallback: '未设置' }),
      field('报价总额', money(record.totalAmount)),
      field('付款方式', record.paymentMethod, { fallback: '未填写' }),
      field('备注', record.remark, { fallback: '无' })
    ],
    items: buildItems(record)
  };
}

function buildOrderDetail(state, record) {
  const depositAmount = getOrderDepositAmount(state, record.id);
  const remainingAmount = hasValue(record.totalAmount) && Number.isFinite(Number(record.totalAmount))
    ? getOrderRemainingSettlement(state, record)
    : null;
  return {
    title: getItemsSummary(record) || '订单',
    status: record.status || '状态未知',
    customerId: getExistingCustomerId(state, record),
    relatedOrderId: '',
    fields: [
      field('客户', getCustomerName(state, record)),
      field('下单日期', record.orderDate),
      field('交期', record.requiredDeliveryDate, { fallback: '未设置' }),
      field('预计发货', record.expectedShipDate, { fallback: '未设置' }),
      field('实际发货', record.actualShipDate, { fallback: '尚未发货' }),
      field('订单总额', money(record.totalAmount)),
      field('已收定金', money(depositAmount)),
      field('还差尾款', money(remainingAmount)),
      field('付款方式', record.paymentMethod, { fallback: '未填写' }),
      field('物流信息', record.logisticsInfo, { fallback: '未填写' }),
      field('备注', record.remark, { fallback: '无' })
    ],
    items: buildItems(record)
  };
}

function buildReceivableDetail(state, record) {
  const hasAmount = hasValue(record.amount) && Number.isFinite(Number(record.amount));
  const hasPaidAmount = hasValue(record.paidAmount) && Number.isFinite(Number(record.paidAmount));
  const paidAmount = hasPaidAmount ? Number(record.paidAmount) : null;
  const amount = hasAmount ? Number(record.amount) : null;
  const remainingAmount = hasAmount && hasPaidAmount ? Math.max(0, amount - paidAmount) : null;
  return {
    title: `${getCustomerName(state, record)}待收款`,
    status: record.status || '状态未知',
    customerId: getExistingCustomerId(state, record),
    relatedOrderId: record.orderId || '',
    fields: [
      field('客户', getCustomerName(state, record)),
      field('待收总额', money(record.amount)),
      field('已经收到', money(record.paidAmount)),
      field('还差', money(remainingAmount)),
      field('预计收款日', record.dueDate, { fallback: '未设置' }),
      field('来源', getSourceLabel(record)),
      field('已催款', `${Number(record.dunningCount || 0)} 次`),
      field('最近催款', record.lastDunningDate, { fallback: '无' }),
      field('备注', record.remark, { fallback: '无' })
    ],
    items: []
  };
}

function buildPaymentDetail(state, record) {
  const receivable = (state.receivables || []).find((item) => item.id === record.receivableId) || null;
  const relatedOrderId = record.orderId || (receivable && receivable.orderId) || '';
  const kind = record.kind || record.paymentKind || '';
  return {
    title: `${getCustomerName(state, record)}收款`,
    status: getPaymentKindLabel(kind),
    customerId: getExistingCustomerId(state, record),
    relatedOrderId,
    fields: [
      field('客户', getCustomerName(state, record)),
      field('本次收款', money(record.amount)),
      field('收款日期', record.paidAt || String(record.createdAt || '').slice(0, 10)),
      field('类型', getPaymentKindLabel(kind)),
      field('关联待收', receivable ? '已关联' : (record.receivableId ? '关联记录已不存在' : '未关联')),
      field('备注', record.remark, { fallback: '无' })
    ],
    items: []
  };
}

function buildTodoDetail(state, record) {
  return {
    title: record.title || '提醒',
    status: record.status || '状态未知',
    customerId: getExistingCustomerId(state, record),
    relatedOrderId: '',
    fields: [
      field('提醒日期', record.remindDate, { fallback: '未设置' }),
      field('客户', getCustomerName(state, record)),
      field('商品', record.productName, { fallback: '未填写' }),
      field('数量', quantity(record.quantity, record.unit)),
      field('金额', money(record.amount)),
      field('备注', record.remark, { fallback: '无' })
    ],
    items: []
  };
}

function buildPendingDetail(state, record) {
  const fields = record.guessedFields || {};
  return {
    title: '待整理记录',
    status: record.status || '待整理',
    customerId: '',
    relatedOrderId: '',
    fields: [
      field('暂定类型', record.guessedIntent || '不确定'),
      field('暂定客户', fields.customerName, { fallback: '未识别' }),
      field('暂定商品', fields.productName, { fallback: '未识别' }),
      field('需要补充', (record.missingFields || []).concat(record.lowConfidenceFields || []).join('、'), { fallback: '请核对原始内容' }),
      field('原因', record.reason, { fallback: '信息不完整，需要补充' })
    ],
    items: buildItems(fields)
  };
}

function buildRecordDetail(state = {}, type, id) {
  const record = getRecord(state, type, id);
  if (!record) return null;
  const builders = {
    quotation: buildQuotationDetail,
    order: buildOrderDetail,
    receivable: buildReceivableDetail,
    payment: buildPaymentDetail,
    todo: buildTodoDetail,
    pending: buildPendingDetail
  };
  const detail = builders[type](state, record);
  return Object.assign({}, detail, {
    id,
    type,
    typeLabel: TYPE_LABELS[type] || '记录详情',
    originalText: record.originalText || record.original_text || '',
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    record
  });
}

function getRecordDetailUrl(type, id) {
  if (!COLLECTION_BY_TYPE[type] || !id) return '';
  return `/pages/record-detail/record-detail?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
}

module.exports = {
  buildRecordDetail,
  getRecord,
  getRecordDetailUrl
};
