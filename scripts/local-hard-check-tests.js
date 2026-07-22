const assert = require('assert');
const { parseChineseDateDetail } = require('../utils/date');
const { parseInput } = require('../utils/parser');
const { normalizeAiResult } = require('../utils/ai-parser');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const {
  generateReceivableFromOrder,
  saveConfirmedDraft,
  updateOrderStatus
} = require('../utils/business');

function emptyState(customers = []) {
  return {
    customers: customers.slice(),
    quotations: [],
    orders: [],
    orderProgress: [],
    receivables: [],
    paymentRecords: [],
    todos: [],
    pendingNotes: [],
    aiParseLogs: []
  };
}

function customer(id, name) {
  return { id, name, phone: '', mergedInto: '', updatedAt: '', lastTradeAt: '' };
}

function parse(text, state = emptyState()) {
  return parseInput({ text, source: 'typed', context: 'home', state });
}

const results = [];
function check(name, fn) {
  fn();
  results.push({ name, result: '通过' });
}

const baseMonday = new Date(2026, 6, 20);

check('日期：本周五属于当前自然周', () => {
  assert.equal(parseChineseDateDetail('本周五交', baseMonday).date, '2026-07-24');
});

check('日期：下周五属于下一自然周', () => {
  assert.equal(parseChineseDateDetail('下周五交', baseMonday).date, '2026-07-31');
});

check('日期：下周五下午仍能识别具体日期', () => {
  assert.equal(parseChineseDateDetail('下周五下午交', baseMonday).date, '2026-07-31');
});

check('日期：“下个礼拜五”不能误解为本周五', () => {
  const baseTuesday = new Date(2026, 6, 14);
  assert.equal(parseChineseDateDetail('下个礼拜五交', baseTuesday).date, '2026-07-24');
});

check('日期：下周交没有星期几，不能猜日期', () => {
  const detail = parseChineseDateDetail('下周交', baseMonday);
  assert.equal(detail.date, '');
  assert.equal(detail.ambiguous, true);
});

check('日期：只有下午，不能猜成今天', () => {
  const detail = parseChineseDateDetail('下午交', baseMonday);
  assert.equal(detail.date, '');
  assert.equal(detail.ambiguous, true);
});

check('日期：2026-02-30 是无效日期，不能自动滚到三月', () => {
  const detail = parseChineseDateDetail('2026-02-30交', baseMonday);
  assert.equal(detail.date, '');
  assert.equal(detail.invalid, true);
});

check('日期：义乌常见说法“明朝”识别为明天', () => {
  assert.equal(parseChineseDateDetail('明朝交', baseMonday).date, '2026-07-21');
});

check('日期：新订单交期早于今天时必须确认，不能直接保存', () => {
  const state = emptyState();
  const result = parse('王总订水杯100个，5元一个，2020年1月1日交', state);
  const saved = saveConfirmedDraft(state, result);
  assert(result.low_confidence_fields.includes('dueDate'));
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
});

check('日期：明确的未来交期会原样进入最终订单', () => {
  const state = emptyState();
  const parsed = parse('陈总订杯垫10个，10元一个，后天交', state);
  const saved = saveConfirmedDraft(state, parsed);
  assert.equal(saved.type, 'order');
  assert.equal(saved.record.requiredDeliveryDate, parsed.fields.dueDate);
});

check('金额：原话总价90，机器计算100，两份数据都保留', () => {
  const result = parse('陈总订杯垫10个，10元一个，总价90元，后天交');
  assert.equal(result.fields.statedAmount, '90');
  assert.equal(result.fields.calculatedAmount, '100');
  assert.equal(result.fields.amount, '90');
  assert(result.field_conflicts.some((item) => item.field === 'amount'));
});

check('金额：未人工确认矛盾前，不能生成正式订单', () => {
  const state = emptyState();
  const saved = saveConfirmedDraft(state, parse('陈总订杯垫10个，10元一个，总价90元，后天交', state));
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
});

check('金额：老板确认总价90后，最终订单保存90，不是100', () => {
  const state = emptyState();
  const parsed = parse('陈总订杯垫10个，10元一个，总价90元，后天交', state);
  const confirmed = applyFinalParseSafety(Object.assign({}, parsed, { manual_fields: ['amount'] }));
  const saved = saveConfirmedDraft(state, confirmed);
  assert.equal(saved.type, 'order');
  assert.equal(saved.record.totalAmount, '90');
  assert.equal(saved.record.items[0].totalAmount, '100');
});

check('金额：原话没说总价时，才使用数量×单价100', () => {
  const state = emptyState();
  const parsed = parse('陈总订杯垫10个，10元一个，后天交', state);
  const saved = saveConfirmedDraft(state, parsed);
  assert.equal(saved.type, 'order');
  assert.equal(saved.record.totalAmount, '100');
});

check('AI：AI即使返回100，也不能覆盖原话总价90', () => {
  const local = parse('陈总订杯垫10个，10元一个，总价90元，后天交');
  const merged = normalizeAiResult(local, {
    provider: 'server',
    intent: 'order',
    fields: {
      customerName: '陈总',
      productName: '杯垫',
      quantity: '10',
      unit: '个',
      unitPrice: '10',
      amount: '100',
      totalAmount: '100',
      statedAmount: '100'
    },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert.equal(merged.fields.statedAmount, '90');
  assert.equal(merged.fields.amount, '90');
  assert.equal(merged.fields.calculatedAmount, '100');
  assert(merged.field_conflicts.some((item) => item.field === 'amount'));
});

check('取消：一句“取消订单”不能新建或修改正式记录', () => {
  const state = emptyState([customer('cus_chen', '陈总')]);
  state.orders.push({ id: 'ord_1', customerId: 'cus_chen', status: '待生产', totalAmount: '100' });
  const result = parse('取消陈总刚才的杯垫订单', state);
  const saved = saveConfirmedDraft(state, result);
  assert.equal(result.formal_save_blocked, true);
  assert.equal(result.ai_fallback.needed, false);
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders[0].status, '待生产');
});

check('取消：“不用做”即使带齐订单字段也不能新建订单', () => {
  const state = emptyState();
  const result = parse('王总水杯500个20元一个不用做，下周五交', state);
  const saved = saveConfirmedDraft(state, result);
  assert.equal(result.formal_save_blocked, true);
  assert.equal(result.ai_fallback.needed, false);
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
});

check('多业务：订单和另一客户收款混在一句里，必须拆开', () => {
  const state = emptyState();
  const result = parse('陈总杯垫10个10元一个后天交，另外收到王总3000元', state);
  const saved = saveConfirmedDraft(state, result);
  assert.equal(result.mixed_business, true);
  assert.equal(result.formal_save_blocked, true);
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
  assert.equal(state.paymentRecords.length, 0);
});

check('多业务：没有“另外”二字的订单加收款也必须拆开', () => {
  const state = emptyState();
  const local = parse('王总订水杯300个，20元一个，后天交，刚转来1000元尾款', state);
  const aiMerged = normalizeAiResult(local, {
    provider: 'server',
    intent: 'payment',
    fields: { customerName: '王总', paymentAmount: '1000', amount: '1000' },
    missing_fields: [],
    low_confidence_fields: []
  });
  const saved = saveConfirmedDraft(state, aiMerged);
  assert.equal(local.mixed_business, true);
  assert.equal(aiMerged.formal_save_blocked, true);
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
  assert.equal(state.paymentRecords.length, 0);
});

check('深度核对：还没完成时，不能绕过页面直接保存', () => {
  const state = emptyState();
  const result = parse('陈总订杯垫10个，10元一个，后天交', state);
  result.parse_route = { decision: 'pending', deep_review_available: true };
  result.ai_fallback = { status: 'not_requested' };
  const saved = saveConfirmedDraft(state, result);
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
});

check('跨客户：王总的待收款不能关联到陈总的订单', () => {
  const state = emptyState([customer('cus_chen', '陈总'), customer('cus_wang', '王总')]);
  state.orders.push({ id: 'ord_chen', customerId: 'cus_chen', status: '待生产', totalAmount: '1000' });
  const saved = saveConfirmedDraft(state, {
    intent: 'receivable',
    operation: 'create_receivable',
    source: 'typed',
    original_text: '王总欠1000元',
    fields: { customerId: 'cus_wang', customerName: '王总', orderId: 'ord_chen', amount: '1000' },
    missing_fields: [],
    low_confidence_fields: [],
    manual_fields: ['customerName', 'amount', 'orderId']
  });
  assert.equal(saved.type, 'pending');
  assert.equal(state.receivables.length, 0);
});

check('跨客户：不能用一句更新把陈总订单改到王总名下', () => {
  const state = emptyState([customer('cus_chen', '陈总'), customer('cus_wang', '王总')]);
  state.orders.push({
    id: 'ord_chen', customerId: 'cus_chen', productName: '杯垫', quantity: '10', unit: '个',
    unitPrice: '10', totalAmount: '100', requiredDeliveryDate: '2026-07-21', status: '待生产'
  });
  const saved = saveConfirmedDraft(state, {
    intent: 'order',
    operation: 'update_order',
    source: 'typed',
    original_text: '王总杯垫10个10元一个后天交，更新订单',
    fields: {
      orderId: 'ord_chen', customerId: 'cus_wang', customerName: '王总', productName: '杯垫',
      quantity: '10', unit: '个', unitPrice: '10', amount: '100', dueDate: '2026-07-21'
    },
    missing_fields: [],
    low_confidence_fields: [],
    manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'dueDate']
  });
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders[0].customerId, 'cus_chen');
});

check('跨客户：王总订单不能挂到陈总报价', () => {
  const state = emptyState([customer('cus_chen', '陈总'), customer('cus_wang', '王总')]);
  state.quotations.push({ id: 'quo_chen', customerId: 'cus_chen', status: '待确认' });
  const saved = saveConfirmedDraft(state, {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: '王总订杯垫10个10元一个后天交',
    fields: {
      quotationId: 'quo_chen', customerId: 'cus_wang', customerName: '王总', productName: '杯垫',
      quantity: '10', unit: '个', unitPrice: '10', amount: '100', dueDate: '2026-07-21'
    },
    missing_fields: [],
    low_confidence_fields: [],
    manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'dueDate', 'quotationId']
  });
  assert.equal(saved.type, 'pending');
  assert.equal(state.orders.length, 0);
});

check('待收：同一订单已经有待收时不能重复新建第二笔', () => {
  const state = emptyState([customer('cus_chen', '陈总')]);
  state.orders.push({ id: 'ord_chen', customerId: 'cus_chen', status: '待生产', totalAmount: '1000' });
  state.receivables.push({ id: 'rec_old', orderId: 'ord_chen', customerId: 'cus_chen', amount: '1000', paidAmount: '0', status: '待收' });
  const saved = saveConfirmedDraft(state, {
    intent: 'receivable',
    operation: 'create_receivable',
    source: 'typed',
    original_text: '陈总这单待收1000元',
    fields: { customerId: 'cus_chen', customerName: '陈总', orderId: 'ord_chen', amount: '1000' },
    missing_fields: [],
    low_confidence_fields: [],
    manual_fields: ['customerName', 'orderId', 'amount']
  });
  assert.equal(saved.type, 'pending');
  assert.equal(state.receivables.length, 1);
});

check('定金：旧数据里订单与待收客户错挂时必须阻止继续核销', () => {
  const state = emptyState([customer('cus_chen', '陈总'), customer('cus_wang', '王总')]);
  state.orders.push({ id: 'ord_chen', customerId: 'cus_chen', status: '待生产', totalAmount: '1000', productName: '杯垫' });
  state.receivables.push({ id: 'rec_dirty', orderId: 'ord_chen', customerId: 'cus_wang', amount: '1000', paidAmount: '0', status: '待收' });
  const saved = saveConfirmedDraft(state, {
    intent: 'payment',
    operation: 'record_order_deposit',
    source: 'typed',
    original_text: '陈总杯垫这单收到定金200元',
    fields: {
      customerId: 'cus_chen', customerName: '陈总', orderId: 'ord_chen', productName: '杯垫',
      paymentAmount: '200', paymentKind: 'deposit', orderSelectionConfirmed: true
    },
    missing_fields: [],
    low_confidence_fields: [],
    manual_fields: ['customerName', 'orderId', 'productName', 'paymentAmount']
  });
  assert.equal(saved.type, 'pending');
  assert.equal(state.paymentRecords.length, 0);
  assert.equal(state.receivables[0].paidAmount, '0');
});

check('取消订单：已有定金或收款时，不能只改一个状态就取消', () => {
  const state = emptyState([customer('cus_chen', '陈总')]);
  state.orders.push({ id: 'ord_money', customerId: 'cus_chen', status: '待生产', totalAmount: '1000' });
  state.paymentRecords.push({ id: 'pay_1', orderId: 'ord_money', customerId: 'cus_chen', amount: '200', kind: 'deposit' });
  assert.equal(updateOrderStatus(state, 'ord_money', '已取消'), null);
  assert.equal(state.orders[0].status, '待生产');
});

check('取消订单：没有资金记录时，老板在订单页可明确手动取消', () => {
  const state = emptyState([customer('cus_chen', '陈总')]);
  state.orders.push({ id: 'ord_clean', customerId: 'cus_chen', status: '待生产', totalAmount: '1000' });
  assert(updateOrderStatus(state, 'ord_clean', '已取消'));
  assert.equal(state.orders[0].status, '已取消');
});

check('已取消订单：不能再生成待收款', () => {
  const state = emptyState([customer('cus_chen', '陈总')]);
  state.orders.push({ id: 'ord_cancelled', customerId: 'cus_chen', status: '已取消', totalAmount: '1000' });
  assert.equal(generateReceivableFromOrder(state, 'ord_cancelled'), null);
  assert.equal(state.receivables.length, 0);
});

console.log(JSON.stringify({
  suite: '本地硬检查与最终保存闭环',
  passed: results.length,
  failed: 0,
  results
}, null, 2));
