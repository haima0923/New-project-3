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

function parse(text, state = EMPTY_STATE) {
  return parseInput({
    text,
    source: 'typed',
    context: 'input',
    state,
    businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai',
    nowInstant: '2026-07-15T02:00:00.000Z'
  });
}

function assertIntent(text, expectedIntent, message = '') {
  const result = parse(text);
  assert.strictEqual(result.intent, expectedIntent, message || text);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return result;
}

function assertNotPayment(text) {
  const result = parse(text);
  assert.notStrictEqual(result.intent, 'payment', text);
  assert.strictEqual(result.fields.paymentAmount, '', `${text}: must not invent payment amount`);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return result;
}

function assertPaymentBlockedWithoutAmount(text) {
  const state = {
    ...EMPTY_STATE,
    customers: [{ id: 'cus-wang', name: '王总' }]
  };
  const result = assertIntent(text, 'payment');
  assert.strictEqual(result.fields.paymentAmount, '', `${text}: paymentAmount`);
  const preflight = evaluateRecordDomainPreflight({
    finalResult: result,
    initialState: state,
    skipFinalSafety: true
  });
  assert.strictEqual(preflight.domainCanSaveFormal, false, `${text}: formal save must stay blocked`);
  assert(preflight.blockingIssues.some((issue) => issue.code === 'MISSING_REQUIRED_FIELD'), `${text}: missing payment amount block`);
  return result;
}

const completedPayments = [
  ['收到王总货款5000元', '5000'],
  ['王总这单付了3000元', '3000'],
  ['客户刚打款8000元', '8000'],
  ['王总转过来2000元', '2000'],
  ['王总今天付了三千元', '3000'],
  ['今天收到李总3000元', '3000'],
  ['周姐刚打了两千元', '2000'],
  ['周姐刚微信打了两千，顶在上回礼盒款里', '2000'],
  ['周姐打了两千，哪笔我也说不准', '2000'],
  ['王总微信打了5000元', '5000'],
  ['王总给了5000元', '5000'],
  ['王总还了5000元', '5000'],
  ['王总已付5000元', '5000'],
  ['王总转账5000元', '5000'],
  ['王总微信转账5000元', '5000'],
  ['王总刚转5000元', '5000'],
  ['收到一笔5000元货款', '5000'],
  ['收到订单款5000元', '5000']
];

completedPayments.forEach(([text, amount]) => {
  const result = assertIntent(text, 'payment');
  assert.strictEqual(result.fields.paymentAmount, amount, `${text}: paymentAmount`);
});
assert.strictEqual(parse('收到王总货款5000元').fields.customerName, '王总');
assert.strictEqual(parse('今天收到李总3000元').fields.customerName, '李总');
assert.strictEqual(parse('客户刚打款8000元').fields.customerName, '');

[
  ['王总7月15日已到账5000元', '5000'],
  ['王总7月15日到账了5000元', '5000'],
  ['王总5000元已到账', '5000'],
  ['昨天没到账，今天到账5000元', '5000'],
  ['昨天没到账今天到账5000元', '5000'],
  ['收到货了，今天又收到500元', '500']
].forEach(([text, amount]) => {
  const result = assertIntent(text, 'payment');
  assert.strictEqual(result.fields.paymentAmount, amount, `${text}: paymentAmount`);
  if (text === '昨天没到账，今天到账5000元' || text === '收到货了，今天又收到500元') {
    assert.strictEqual(result.fields.customerName, '', `${text}: must not invent customer`);
  }
});

[
  '尾款已经到账',
  '这单的钱收了'
].forEach((text) => {
  const result = assertIntent(text, 'payment');
  assert(result.missing_fields.includes('paymentAmount'), `${text}: missing payment amount`);
});

const basic012 = assertIntent('王总今天付了600元，这是零散款，不关联旧订单', 'payment');
assert.strictEqual(basic012.fields.customerName, '王总');
assert.strictEqual(basic012.fields.paymentAmount, '600');
assert.strictEqual(basic012.operation, '');
assert.strictEqual(basic012.mixed_business, false);
assert(!basic012.formal_save_blocked);
const basic012Preflight = evaluateRecordDomainPreflight({
  finalResult: basic012,
  initialState: EMPTY_STATE,
  skipFinalSafety: true
});
assert.strictEqual(basic012Preflight.operation, 'record_payment');

const page003 = assertIntent('王总那笔只剩4000元，完整页强行收4500元', 'payment');
assert.strictEqual(page003.fields.customerName, '王总');
assert.strictEqual(page003.fields.paymentAmount, '4500');
assert.strictEqual(page003.fields.remainingAmount, '4000');
assert.strictEqual(page003.operation, '');
assert.strictEqual(page003.mixed_business, false);
const page003Preflight = evaluateRecordDomainPreflight({
  finalResult: page003,
  initialState: EMPTY_STATE,
  skipFinalSafety: true
});
assert.strictEqual(page003Preflight.operation, 'record_payment');

const restartPayment = assertIntent('王总这笔待收今天付了1000元，保存后重开确认', 'payment');
assert.strictEqual(restartPayment.fields.paymentAmount, '1000');

[
  '还有8000元待收',
  '客户还欠3000元',
  '尾款没付',
  '货款未到账500元',
  '等客户付款',
  '尾款没收',
  '王总收纳盒这单还有8000元待收，7月25日收'
].forEach(assertNotPayment);

const basic010 = parse('王总收纳盒这单还有8000元待收，7月25日收');
assert.strictEqual(basic010.intent, 'unknown', 'BASIC-010 must remain visible for its own receivable parser fix');

[
  '王总收纳盒这单收到2000元定金',
  '订金到账3000元',
  '预付款已收2000元',
  '王总收纳盒订单一次付定金10000元',
  '王总收纳盒订单再记7月8日定金2000元'
].forEach((text) => {
  const result = assertIntent(text, 'payment');
  assert.strictEqual(result.operation, 'record_order_deposit', text);
});

const orderWithDeposit = assertIntent(
  '孙老板订1000个卡套，5元一个，已付定金1000元，7月28日交',
  'order'
);
assert.strictEqual(orderWithDeposit.fields.depositAmount, '1000');

[
  '收到货',
  '收到消息',
  '收到报价',
  '王总打了500个电话',
  '王总还了500件货',
  '王总给了500件样品',
  '收纳盒',
  '收货地址',
  '付款方式是什么',
  '准备付款',
  '计划明天打款500元',
  '等客户付款',
  '客户没付款',
  '转文件',
  '转报价',
  '转订单',
  '把文件转给王总'
].forEach(assertNotPayment);

[
  '王总收到500个杯子',
  '王总收了100箱货',
  '王总文件转了3次',
  '王总订单转了2次',
  '王总收到3件快递',
  '王总收到一批货500件',
  '王总收到编号500的订单',
  '王总500个杯子已经到账'
].forEach(assertNotPayment);

const paymentCountOnly = assertNotPayment('王总刚打款3笔');
const paymentCountOnlyPreflight = evaluateRecordDomainPreflight({
  finalResult: paymentCountOnly,
  initialState: {
    ...EMPTY_STATE,
    customers: [{ id: 'cus-wang', name: '王总' }]
  },
  skipFinalSafety: true
});
assert.strictEqual(paymentCountOnlyPreflight.domainCanSaveFormal, false);
assertPaymentBlockedWithoutAmount('王总订单500个款项已到账');

const vaguePayment = assertPaymentBlockedWithoutAmount('今天收了一点钱');
assert.strictEqual(vaguePayment.fields.customerName, '');

[
  '王总下单水杯100个，5元一个，8月1日交',
  '那单改成8月2日交',
  '王总水杯100个，5元一个，8月1日交'
].forEach((text) => assertIntent(text, 'order'));

assertNotPayment('这单5000元');

const chatOrder = assertIntent('王总：水杯要100个，5块5一个\n我：收到，后天交', 'order');
assert.strictEqual(chatOrder.mixed_business, false, 'chat acknowledgement must not become payment');

const actualMixedBusiness = parse('王总那单交期改到8月2日，另外付了500元');
assert.strictEqual(actualMixedBusiness.mixed_business, true, 'two real business actions must remain mixed');
const paymentConfirmationOnly = parse('王总付了500元，收款确认了');
assert.strictEqual(paymentConfirmationOnly.intent, 'payment');
assert.strictEqual(
  paymentConfirmationOnly.mixed_business,
  false,
  'payment confirmation wording must not invent an order action'
);
[
  '王总付了500元，订单生产了',
  '王总付了500元，另外订单生产100个',
  '王总付了500元，另外订单开工',
  '王总付了500元，另外订单排产',
  '王总付了500元，另外返单100个'
].forEach((text) => {
  assert.strictEqual(parse(text).mixed_business, true, `${text}: two real business actions must remain mixed`);
});

console.log([
  'Payment parser intent tests passed:',
  `completed=${completedPayments.length + 10}`,
  'receivable-protection=7',
  'deposit-protection=6',
  'non-financial-protection=28',
  'order-protection=10'
].join(' '));
