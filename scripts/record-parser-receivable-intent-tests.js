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

function assertIntent(text, intent) {
  const result = parse(text);
  assert.strictEqual(result.intent, intent, text);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return result;
}

function assertNotReceivable(text) {
  const result = parse(text);
  assert.notStrictEqual(result.intent, 'receivable', text);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return result;
}

function run() {
  const explicitReceivables = [
    ['还有8000元待收', '8000'],
    ['客户还欠3000元', '3000'],
    ['余款5000元未收', '5000'],
    ['尾款还有2000元', '2000'],
    ['客户尚欠货款6000元', '6000'],
    ['应收款还有4000元', '4000'],
    ['货款未收500元', '500'],
    ['还有八千元待收', '8000'],
    ['还欠三千元', '3000'],
    ['王总这单还有8000元待收', '8000'],
    ['王总收纳盒这单还有8000元待收，7月25日收', '8000']
  ];
  explicitReceivables.forEach(([text, amount]) => {
    const result = assertIntent(text, 'receivable');
    assert.strictEqual(result.fields.amount, amount, `${text}: amount`);
    assert.strictEqual(result.fields.paymentAmount, '', `${text}: paymentAmount`);
  });

  [
    '余款还没收',
    '尾款尚未付',
    '这笔待收款还没到账'
  ].forEach((text) => {
    const result = assertIntent(text, 'receivable');
    assert.strictEqual(result.fields.amount, '', `${text}: missing amount`);
    assert(result.missing_fields.includes('amount'), `${text}: amount must remain missing`);
  });

  const target = assertIntent(
    '王总收纳盒这单还有8000元待收，7月25日收',
    'receivable'
  );
  assert.strictEqual(target.fields.customerName, '王总');
  assert.strictEqual(target.fields.productName, '收纳盒');
  assert.strictEqual(target.fields.amount, '8000');
  assert.strictEqual(target.fields.dueDate, '2026-07-25');
  assert.strictEqual(target.fields.orderId, undefined);
  assert.strictEqual(target.operation, '');
  assert.strictEqual(target.mixed_business, false);

  const targetState = {
    ...EMPTY_STATE,
    customers: [{ id: 'cus-syn-a', name: '王总' }],
    orders: [{
      id: 'ord-active-a',
      customerId: 'cus-syn-a',
      productName: '收纳盒',
      status: '生产中',
      totalAmount: 10000
    }]
  };
  const beforeSelection = evaluateRecordDomainPreflight({
    finalResult: target,
    initialState: targetState,
    skipFinalSafety: true
  });
  assert.strictEqual(beforeSelection.operation, 'create_receivable');
  assert.strictEqual(beforeSelection.domainCanSaveFormal, false);
  assert.deepStrictEqual(beforeSelection.requiredSelections, ['orderId']);
  assert(beforeSelection.blockingIssues.some(
    (item) => item.code === 'ORDER_SELECTION_REQUIRED'
  ));
  assert.deepStrictEqual(
    beforeSelection.candidates.orderCandidates.map((item) => item.id),
    ['ord-active-a']
  );
  assert.strictEqual(target.fields.orderId, undefined, 'preflight must not auto-select an order');

  [
    '王总今天付了600元，这是零散款，不关联旧订单',
    '王总那笔只剩4000元，完整页强行收4500元',
    '收到王总货款5000元',
    '尾款已经到账',
    '王总这笔待收今天付了1000元'
  ].forEach((text) => assertIntent(text, 'payment'));

  [
    '提醒我7月25日催王总付款',
    '明天催一下刘姐的尾款',
    '别忘了收王总尾款',
    '下周提醒我收货款'
  ].forEach((text) => {
    const result = parse(text);
    assert(['dunning', 'todo'].includes(result.intent), text);
  });

  [
    '王总收纳盒这单收到2000元定金',
    '定金还有3000元没付',
    '订金到账3000元',
    '预付款待收2000元'
  ].forEach((text) => assertNotReceivable(text));

  [
    '这单总金额8000元',
    '王总下单8000元',
    '订单货值还有8000元',
    '这单做5000元',
    '王总下单水杯100个，5元一个，8月1日交',
    '那单改成8月2日交'
  ].forEach((text) => assertNotReceivable(text));

  [
    '待收货',
    '待收样品',
    '待收文件',
    '待收3笔',
    '待收500个收纳盒',
    '7月25日待收',
    '收纳盒',
    '收货地址',
    '收货人',
    '收到货',
    '收到报价'
  ].forEach((text) => {
    const result = assertNotReceivable(text);
    assert.strictEqual(result.fields.amount || '', '', `${text}: must not invent amount`);
  });

  const mixed = parse('还有8000元待收，另外付了1000元');
  assert.strictEqual(mixed.mixed_business, true);
  assert.strictEqual(mixed.formal_save_blocked, true);

  console.log([
    'Receivable parser intent tests passed:',
    `explicit=${explicitReceivables.length}`,
    'missing-amount=3',
    'payment-protection=5',
    'reminder-protection=4',
    'deposit-protection=4',
    'order-protection=6',
    'non-financial-protection=11',
    'mixed-protection=1'
  ].join(' '));
}

if (require.main === module) run();

module.exports = { run };
