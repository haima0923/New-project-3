#!/usr/bin/env node

const assert = require('assert');
const rootBusiness = require('../utils/business');
const serverBusiness = require('../server/utils/business');
const rootKind = require('../utils/payment-kind');
const serverKind = require('../server/utils/payment-kind');
const { buildFinanceViewModel } = require('../utils/finance');
const { buildRecentRecords } = require('../utils/home-workbench');
const { buildRecordDetail } = require('../utils/record-detail');
const { getReceivablePaymentIssue } = require('../utils/record-domain-preflight');

delete global.wx;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function stateWithReceivable(overrides = {}) {
  const customerId = overrides.customerId || 'cus-1';
  const orderId = Object.prototype.hasOwnProperty.call(overrides, 'orderId')
    ? overrides.orderId
    : 'ord-1';
  return {
    customers: [{ id: customerId, name: '王总', mergedInto: '' }],
    quotations: [],
    orders: orderId ? [{ id: orderId, customerId, status: '已发货', totalAmount: '5000' }] : [],
    receivables: [{
      id: 'rec-1', customerId, orderId, amount: overrides.amount || '5000',
      paidAmount: overrides.paidAmount || '1000', status: overrides.status || '部分收款',
      source: overrides.source || (orderId ? 'order' : 'manual'), originalText: '原待收'
    }],
    paymentRecords: [],
    todos: [],
    pendingNotes: [],
    orderProgress: [],
    aiParseLogs: [],
    operationLogs: [],
    dunningRecords: [],
    deletedRecords: [],
    productCatalog: []
  };
}

function assertPayment(engine, amount, expected, overrides = {}, options = {}) {
  const state = stateWithReceivable(overrides);
  const payment = engine.recordPayment(state, 'rec-1', amount, options);
  assert(payment, `${expected.label}: payment should save`);
  assert.strictEqual(payment.kind, expected.kind, `${expected.label}: kind`);
  assert.strictEqual(Number(state.receivables[0].paidAmount), expected.paidAmount, `${expected.label}: paidAmount`);
  assert.strictEqual(state.receivables[0].status, expected.status, `${expected.label}: status`);
  assert.strictEqual(state.paymentRecords.length, 1, `${expected.label}: payment count`);
  return { payment, state };
}

test('纯函数以整数分区分部分收款、最后一笔与超额', () => {
  const partial = rootKind.deriveReceivablePaymentKind({
    paymentAmount: '1600', remainingBefore: '4000', isLinkedReceivable: true
  });
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.kind, 'partial_payment');
  assert.strictEqual(partial.remainingAfter, 2400);
  assert.strictEqual(partial.classificationReason, 'PAYMENT_BELOW_REMAINING_BALANCE');

  const final = rootKind.deriveReceivablePaymentKind({
    paymentAmount: '4000', remainingBefore: '4000', isLinkedReceivable: true
  });
  assert.strictEqual(final.kind, 'final_payment');
  assert.strictEqual(final.remainingAfterCents, 0);
  assert.strictEqual(final.classificationReason, 'PAYMENT_EQUALS_REMAINING_BALANCE');

  const over = rootKind.deriveReceivablePaymentKind({
    paymentAmount: '4000.01', remainingBefore: '4000', isLinkedReceivable: true
  });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.errorCode, 'PAYMENT_EXCEEDS_REMAINING');
});

test('金额规范化覆盖零值、负数、0.01、两位小数和典型浮点输入', () => {
  const invalid = [
    ['0', 'PAYMENT_AMOUNT_NON_POSITIVE'],
    ['-0.01', 'PAYMENT_AMOUNT_NON_POSITIVE'],
    ['bad', 'PAYMENT_AMOUNT_INVALID']
  ];
  invalid.forEach(([paymentAmount, errorCode]) => {
    const result = rootKind.deriveReceivablePaymentKind({
      paymentAmount, remainingBefore: '1', isLinkedReceivable: true
    });
    assert.strictEqual(result.errorCode, errorCode, paymentAmount);
  });
  assert.strictEqual(rootKind.normalizeMoneyToCents('0.01').cents, 1);
  assert.strictEqual(rootKind.normalizeMoneyToCents('10.25').cents, 1025);
  assert.strictEqual(rootKind.normalizeMoneyToCents(0.1 + 0.2).cents, 30);
  const floatingFinal = rootKind.deriveReceivablePaymentKind({
    paymentAmount: 0.1 + 0.2,
    remainingBefore: '0.30',
    isLinkedReceivable: true
  });
  assert.strictEqual(floatingFinal.kind, 'final_payment');
  const centFinal = rootKind.deriveReceivablePaymentKind({
    paymentAmount: '0.01', remainingBefore: '0.01', isLinkedReceivable: true
  });
  assert.strictEqual(centFinal.kind, 'final_payment');
  assert.strictEqual(getReceivablePaymentIssue({
    amount: '0.30', paidAmount: '0.10', status: '部分收款'
  }, '0.20'), '');
});

test('无关联、已结清和脏历史余额均返回明确错误', () => {
  assert.strictEqual(rootKind.deriveReceivablePaymentKind({
    paymentAmount: '1', remainingBefore: '2', isLinkedReceivable: false
  }).errorCode, 'RECEIVABLE_LINK_REQUIRED');
  assert.strictEqual(rootKind.deriveReceivablePaymentKind({
    paymentAmount: '1', remainingBefore: '0', isLinkedReceivable: true
  }).errorCode, 'RECEIVABLE_ALREADY_SETTLED');
  assert.strictEqual(rootKind.getReceivableRemainingBalance('100', '101').valid, false);
  assert.strictEqual(rootKind.getReceivableRemainingBalance('bad', '1').valid, false);
});

test('Legacy与server普通关联待收均按余额分类且忽略普通kind覆写', () => {
  [rootBusiness, serverBusiness].forEach((engine, index) => {
    const label = index === 0 ? 'legacy' : 'server';
    assertPayment(engine, '1600', {
      label: `${label}-partial`, kind: 'partial_payment', paidAmount: 2600, status: '部分收款'
    }, {}, { kind: 'final_payment' });
    assertPayment(engine, '4000', {
      label: `${label}-final`, kind: 'final_payment', paidAmount: 5000, status: '已结清'
    });
    assertPayment(engine, '1600', {
      label: `${label}-manual-receivable`, kind: 'partial_payment', paidAmount: 2600, status: '部分收款'
    }, { orderId: '' });
    assertPayment(engine, '1600', {
      label: `${label}-legacy-source-receivable`, kind: 'partial_payment', paidAmount: 2600, status: '部分收款'
    }, { source: 'legacy' });
    assertPayment(engine, '0.20', {
      label: `${label}-decimal-final`, kind: 'final_payment', paidAmount: 0.3, status: '已结清'
    }, { amount: '0.30', paidAmount: '0.10', orderId: '' });
  });
});

test('Legacy与server未关联普通收款继续保存为unlinked_payment', () => {
  [rootBusiness, serverBusiness].forEach((engine, index) => {
    const state = stateWithReceivable();
    state.receivables = [];
    state.orders = [];
    const saved = engine.saveConfirmedDraft(state, {
      intent: 'payment',
      operation: 'record_payment',
      original_text: '赵总今天付了50元，不关联待收',
      fields: {
        customerName: '赵总',
        paymentAmount: '50',
        remark: '未关联收款'
      }
    });
    assert(saved && saved.record, index === 0 ? 'legacy unlinked' : 'server unlinked');
    assert.strictEqual(saved.record.kind, 'unlinked_payment');
    assert.strictEqual(saved.record.receivableId, '');
    assert.strictEqual(state.paymentRecords.length, 1);
    assert.strictEqual(state.aiParseLogs.length, 1);
  });
});

test('真实订单定金链保持deposit，导出函数的kind和purpose伪造均无效', () => {
  [rootBusiness, serverBusiness].forEach((engine, index) => {
    const label = index === 0 ? 'legacy' : 'server';
    const depositState = stateWithReceivable();
    const saved = engine.saveConfirmedDraft(depositState, {
      intent: 'payment',
      operation: 'record_order_deposit',
      original_text: '王总这单收到定金300元',
      fields: {
        customerId: 'cus-1', customerName: '王总', orderId: 'ord-1',
        orderSelectionConfirmed: true, paymentAmount: '300', depositAmount: '300',
        productName: '礼品盒'
      }
    });
    assert(saved && saved.type === 'order_deposit', `${label}-trusted-deposit`);
    assert.strictEqual(depositState.paymentRecords[0].kind, 'deposit');
    assert.strictEqual(Number(depositState.receivables[0].paidAmount), 1300);
    assertPayment(engine, '300', {
      label: `${label}-untrusted-deposit`, kind: 'partial_payment', paidAmount: 1300, status: '部分收款'
    }, {}, {
      internalPaymentPurpose: Symbol('INTERNAL_ORDER_DEPOSIT_PAYMENT'),
      kind: 'deposit',
      paymentPurpose: 'ORDER_DEPOSIT'
    });
  });
});

test('Legacy与server对超额、零值、负数和脏历史均零副作用拒绝', () => {
  [rootBusiness, serverBusiness].forEach((engine) => {
    [
      ['4000.01', {}],
      ['0', {}],
      ['-1', {}],
      ['1', { amount: '100', paidAmount: '101' }]
    ].forEach(([amount, overrides]) => {
      const state = stateWithReceivable(overrides);
      const before = clone(state);
      assert.strictEqual(engine.recordPayment(state, 'rec-1', amount), null);
      assert.deepStrictEqual(state, before);
    });
  });
});

test('根与server纯分类镜像在完整边界矩阵中一致', () => {
  const cases = [
    { paymentAmount: '1600', remainingBefore: '4000', isLinkedReceivable: true },
    { paymentAmount: '4000', remainingBefore: '4000', isLinkedReceivable: true },
    { paymentAmount: '4000.01', remainingBefore: '4000', isLinkedReceivable: true },
    { paymentAmount: '0.01', remainingBefore: '0.02', isLinkedReceivable: true },
    { paymentAmount: 0.1 + 0.2, remainingBefore: '0.30', isLinkedReceivable: true },
    { paymentAmount: '1', remainingBefore: '2', isLinkedReceivable: false },
    { paymentAmount: 'bad', remainingBefore: '2', isLinkedReceivable: true }
  ];
  cases.forEach((input) => assert.deepStrictEqual(
    serverKind.deriveReceivablePaymentKind(input),
    rootKind.deriveReceivablePaymentKind(input)
  ));
});

test('partial_payment显示完整且历史kind继续只读兼容', () => {
  const state = stateWithReceivable();
  state.paymentRecords = [
    ['p-partial', 'partial_payment'],
    ['p-final', 'final_payment'],
    ['p-receivable', 'receivable_payment'],
    ['p-legacy', 'legacy_payment'],
    ['p-payment', 'payment'],
    ['p-unlinked', 'unlinked_payment'],
    ['p-deposit', 'deposit'],
    ['p-unlinked-deposit', 'unlinked_deposit']
  ].map(([id, kind], index) => ({
    id, kind, customerId: 'cus-1', receivableId: kind === 'unlinked_payment' ? '' : 'rec-1',
    orderId: kind === 'deposit' ? 'ord-1' : '', amount: String(index + 1),
    paidAt: '2026-07-31', createdAt: `2026-07-31T00:00:0${index}.000Z`, originalText: id
  }));
  const financeRows = buildFinanceViewModel(state).paymentRows;
  const labels = Object.fromEntries(financeRows.map((item) => [item.kind, item.kindLabel]));
  assert.strictEqual(labels.partial_payment, '部分收款');
  ['final_payment', 'receivable_payment', 'legacy_payment', 'payment', 'unlinked_payment', 'deposit', 'unlinked_deposit']
    .forEach((kind) => assert(labels[kind], `${kind} must remain readable`));
  const detail = buildRecordDetail(state, 'payment', 'p-partial');
  assert(detail.fields.some((item) => item.label === '类型' && item.value === '部分收款'));
  const recent = buildRecentRecords(state, 20).find((item) => item.id === 'p-partial');
  assert(recent && recent.summary.includes('部分收款'));
});

let passed = 0;
tests.forEach(({ name, fn }) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
});

if (!process.exitCode) console.log(`Payment kind balance: ${passed}/${tests.length} passed`);
