#!/usr/bin/env node

const assert = require('assert');
const { parseInput } = require('../utils/parser');
const { evaluateRecordDomainPreflight } = require('../utils/record-domain-preflight');

const BUSINESS_DATE = '2026-07-15';
const EMPTY_STATE = {
  customers: [],
  quotations: [],
  orders: [],
  receivables: [],
  paymentRecords: [],
  todos: [],
  pendingNotes: []
};

function parse(text) {
  return parseInput({
    text,
    source: 'typed',
    context: 'home',
    state: EMPTY_STATE,
    businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai',
    nowInstant: '2026-07-15T02:00:00.000Z'
  });
}

function assertOriginalText(result, text) {
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
}

function assertNoIsolatedChuOrderSignal(result, text) {
  const evidence = result.intent_evidence || {};
  const allOrderSignals = []
    .concat(evidence.orderPositiveSignals || [])
    .concat(evidence.orderEntitySignals || [])
    .concat(evidence.orderDeliverySignals || []);
  allOrderSignals.forEach((signal) => {
    assert.notStrictEqual(signal.sourceText, '出', `${text}: isolated 出 evidence`);
    assert.strictEqual(
      text.slice(signal.sourceSpan.start, signal.sourceSpan.end),
      signal.sourceText,
      `${text}: source span`
    );
  });
}

function assertNotOrder(text) {
  const result = parse(text);
  assert.notStrictEqual(result.intent, 'order', `${text}: must not become order`);
  assert.notStrictEqual(result.operation, 'create_order', `${text}: raw operation`);
  assertNoIsolatedChuOrderSignal(result, text);
  assertOriginalText(result, text);
  return result;
}

function assertUnknownNoRecord(text) {
  const result = assertNotOrder(text);
  assert.strictEqual(result.intent, 'unknown', `${text}: unknown`);
  assert.strictEqual(result.operation, '', `${text}: raw operation`);
  [
    'customerName',
    'productName',
    'quantity',
    'unitPrice',
    'amount',
    'dueDate'
  ].forEach((field) => {
    assert.strictEqual(result.fields[field] || '', '', `${text}: ${field}`);
  });
  const preflight = evaluateRecordDomainPreflight({
    finalResult: result,
    initialState: EMPTY_STATE,
    skipFinalSafety: true
  });
  assert.strictEqual(preflight.businessType, 'unknown', `${text}: preflight businessType`);
  assert.notStrictEqual(preflight.operation, 'create_order', `${text}: semantic order operation`);
  assert.strictEqual(preflight.domainCanSaveFormal, false, `${text}: formal save`);
  return result;
}

function assertOrder(text, expectedSignal) {
  const result = parse(text);
  assert.strictEqual(result.intent, 'order', `${text}: order`);
  assertOriginalText(result, text);
  const evidence = result.intent_evidence || {};
  const signals = []
    .concat(evidence.orderPositiveSignals || [])
    .concat(evidence.orderEntitySignals || [])
    .concat(evidence.orderDeliverySignals || []);
  const signal = signals.find((item) => item.sourceText === expectedSignal);
  assert(signal, `${text}: phrase-level order evidence ${expectedSignal}`);
  assert.strictEqual(
    text.slice(signal.sourceSpan.start, signal.sourceSpan.end),
    expectedSignal,
    `${text}: phrase source span`
  );
  assertNoIsolatedChuOrderSignal(result, text);
  return result;
}

const amb005Text = '今天天气不错，晚点出去走走';
const amb005 = assertUnknownNoRecord(amb005Text);
assert.deepStrictEqual(amb005.intent_evidence.orderPositiveSignals, []);
assert.deepStrictEqual(amb005.intent_evidence.orderEntitySignals, []);
assert.deepStrictEqual(amb005.intent_evidence.orderDeliverySignals, []);
assert.strictEqual(amb005.intent_evidence.scores.order, 0);
assert.strictEqual(amb005.intent_evidence.winningIntent, 'unknown');

const ordinaryNonBusiness = [
  '出去',
  '我先出去了',
  '今天出门',
  '明天出差',
  '出现一个问题',
  '系统出错了',
  '这事出了问题',
  '文件发出去了',
  '拿出去',
  '说出去了'
];
ordinaryNonBusiness.forEach(assertNotOrder);

const commercialNonOrders = [
  '报价出了吗',
  '报价单已经出了',
  '货款打出去了',
  '这批货已经出库',
  '今天准备出货',
  '样品已经出了',
  '出口报价',
  '文件发给客户了',
  '王总水杯100个，5元一个，周五不出',
  '王总水杯100个，5元一个，周五先不出',
  '王总水杯100个，5元一个，周五不能出',
  '王总水杯100个，5元一个，周五还没出',
  '王总水杯100个，5元一个，周五没法出',
  '王总水杯100个，5元一个，周五无法出',
  '王总水杯100个，5元一个，周五来不及出'
];
commercialNonOrders.forEach(assertNotOrder);

[
  ['王总下单500个', '下单'],
  ['王总正式下单', '下单'],
  ['订货300套', '订货'],
  ['新订单500个', '订单'],
  ['这单改到下周交', ''],
  ['给王总做500个礼品盒', ''],
  ['王总正式下单水杯100个、杯垫200个，8月1日交', '下单'],
  ['出口订单500个', '订单']
].forEach(([text, signal]) => {
  const result = parse(text);
  assert.strictEqual(result.intent, 'order', `${text}: order protection`);
  assertNoIsolatedChuOrderSignal(result, text);
  assertOriginalText(result, text);
  if (signal) {
    const evidence = result.intent_evidence || {};
    const signals = []
      .concat(evidence.orderPositiveSignals || [])
      .concat(evidence.orderEntitySignals || []);
    assert(signals.some((item) => item.sourceText === signal), `${text}: ${signal} evidence`);
  }
});

const multiItemOutbound = assertOrder(
  '黄老板五金挂件3000个，钥匙扣2000个，1.5元一个，周五出',
  '周五出'
);
assert.strictEqual(multiItemOutbound.fields.items.length, 2);
assert.deepStrictEqual(
  multiItemOutbound.fields.items.map((item) => item.productName),
  ['五金挂件', '钥匙扣']
);
assertOrder('周姐礼品盒500套，3.8元一套，后天上午出', '后天上午出');
assertOrder('黄老板五金挂件3000个，1.5元一个，这周六能出', '周六能出');

[
  ['报价已经出了，现在正式下单水杯100个，5元一个，8月1日交', 'order'],
  ['货已经出库，客户又下单500个水杯，5元一个，8月1日交', 'order'],
  ['文件发出去后，王总确认下单水杯100个，5元一个，8月1日交', 'order'],
  ['订单出了问题，需要改交期', 'order'],
  ['报价出错了，重新报价', 'quotation']
].forEach(([text, intent]) => {
  const result = parse(text);
  assert.strictEqual(result.intent, intent, `${text}: mixed context`);
  assertNoIsolatedChuOrderSignal(result, text);
  assertOriginalText(result, text);
});
assertNotOrder('货款打出去后记录付款');

[
  '给王总出500个',
  '明天出一批',
  '先出300个',
  '周五出去走走'
].forEach(assertNotOrder);

const unknownMeaningfulDate = parse('周五再看');
assert.strictEqual(unknownMeaningfulDate.intent, 'unknown');
assert.strictEqual(unknownMeaningfulDate.fields.dueDate, '2026-07-17');

[
  ['给郑老板报挂件3000个，1块5一个，还没下单', 'quotation'],
  ['王总收纳盒这单还有8000元待收，7月25日收', 'receivable'],
  ['王总今天付了600元，这是零散款，不关联旧订单', 'payment'],
  ['王总收纳盒订单收到2000元定金', 'payment']
].forEach(([text, intent]) => {
  const result = parse(text);
  assert.strictEqual(result.intent, intent, `${text}: adjacent parser protection`);
  assertNoIsolatedChuOrderSignal(result, text);
  assertOriginalText(result, text);
});

console.log([
  'Order signal boundary parser tests passed:',
  `ordinary-non-business=${ordinaryNonBusiness.length + 1}`,
  `commercial-non-order=${commercialNonOrders.length}`,
  'explicit-order=8',
  'contextual-outbound=3',
  'mixed-context=6',
  'ambiguous-oral=4',
  'unknown-date-protection=1',
  'adjacent-parser-protection=4'
].join(' '));
