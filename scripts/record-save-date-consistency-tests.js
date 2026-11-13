#!/usr/bin/env node
const assert = require('assert');
const { withFixedTestClock } = require('./lib/fixed-test-clock');
const {
  authorization, canonicalState, clone, customer, fixedClock, order, orderResult,
  prepare, receivable, result, scopedIdGenerator, stateWith, withFixedGlobals
} = require('./record-shared-core-phase1e1-tests');
const { saveConfirmedDraft } = require('../utils/business');
const { commitRecordSavePlan } = require('../utils/record-save-commit');
const { createRecordMemoryStore } = require('../utils/record-memory-store');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const wang = customer('cus-wang', '王总');
const linkedOrder = order('ord-1', wang.id);
const linkedReceivable = receivable('rec-1', wang.id, { orderId: linkedOrder.id });

function verifyBoth(raw, initial, inspect) {
  const untouched = clone({ raw, initial });
  const prepared = prepare(raw, initial);
  assert.strictEqual(prepared.savePlan.blocked, false, JSON.stringify(prepared.savePlan.blockingIssues));
  const store = createRecordMemoryStore(initial);
  const receipt = commitRecordSavePlan(prepared.savePlan, store, {
    target: 'MEMORY', clock: fixedClock(), idGenerator: scopedIdGenerator('date-test'),
    authorization: authorization(prepared.savePlan)
  });
  assert.strictEqual(receipt.status, 'COMMITTED');
  const shared = store.getState();
  const legacy = clone(initial);
  const saved = withFixedGlobals(() => saveConfirmedDraft(legacy, clone(prepared.finalResult)));
  assert.notStrictEqual(saved.type, 'error', JSON.stringify(saved));
  inspect(shared);
  inspect(legacy);
  assert.deepStrictEqual(canonicalState(shared, initial), canonicalState(legacy, initial));
  assert.deepStrictEqual({ raw, initial }, untouched, '不能修改输入草稿或原状态');
  assert.strictEqual(shared.aiParseLogs[0].originalText, raw.original_text);
}

function expectPayment(date, amount = '300', kind = null) {
  return (state) => {
    assert.strictEqual(state.paymentRecords.length, 1);
    assert.strictEqual(state.paymentRecords[0].paidAt, date);
    assert.strictEqual(state.paymentRecords[0].amount, amount);
    if (kind) assert.strictEqual(state.paymentRecords[0].kind, kind);
  };
}

function deposit(extraFields = {}) {
  return result('payment', 'record_order_deposit', Object.assign({
    customerName: '王总', customerId: wang.id, orderId: linkedOrder.id,
    orderSelectionConfirmed: true, productName: '礼品盒', paymentAmount: '300',
    depositAmount: '300', paymentKind: 'deposit'
  }, extraFields), '王总这单收到定金300元');
}

function ordinaryPayment(extraFields = {}) {
  return result('payment', 'record_payment', Object.assign({
    customerName: '王总', customerId: wang.id, paymentAmount: '300'
  }, extraFields), '王总付了300元');
}

test('新报价没有有效期时留空，不自动补七天', () => {
  verifyBoth(result('quotation', 'create_quotation', {
    customerName: '王总', productName: '礼品盒', quantity: '100', unit: '个',
    unitPrice: '10', priceUnit: '个', amount: '1000'
  }, '给王总报礼品盒100个，每个10元'), stateWith(), (state) => {
    assert.strictEqual(state.quotations[0].validUntil, '');
    assert.strictEqual(state.quotations[0].deliveryDate, '');
  });
});

test('明确的报价有效期保留，不被默认七天覆盖', () => {
  verifyBoth(result('quotation', 'create_quotation', {
    customerName: '王总', productName: '礼品盒', quantity: '100', unit: '个',
    unitPrice: '10', priceUnit: '个', amount: '1000', validUntil: '2026-08-15'
  }, '给王总报礼品盒100个，每个10元，有效到8月15日'), stateWith(), (state) => {
    assert.strictEqual(state.quotations[0].validUntil, '2026-08-15');
  });
});

for (const paymentDate of ['', '2026-07-21']) {
  test(`订单含定金：收款日期${paymentDate || '未说时留空'}，不能使用订单交期`, () => {
    verifyBoth(orderResult({ depositAmount: '300', paymentAmount: '300', paymentDate },
      '王总订礼品盒100个，每个10元，8月1日交，定金300元'), stateWith(), (state) => {
      expectPayment(paymentDate, '300', 'deposit')(state);
      assert.strictEqual(state.orders[0].requiredDeliveryDate, '2026-08-01');
      assert.strictEqual(state.paymentRecords[0].orderId, state.orders[0].id);
    });
  });

  for (const hasReceivable of [false, true]) {
    test(`已有订单定金：${hasReceivable ? '关联待收' : '无待收'}，日期${paymentDate || '留空'}`, () => {
      verifyBoth(deposit({ paymentDate }), stateWith({
        customers: [wang], orders: [linkedOrder], receivables: hasReceivable ? [linkedReceivable] : []
      }), (state) => {
        expectPayment(paymentDate, '300', 'deposit')(state);
        assert.strictEqual(state.paymentRecords[0].orderId, linkedOrder.id);
        assert.strictEqual(state.paymentRecords[0].receivableId, hasReceivable ? linkedReceivable.id : '');
        if (hasReceivable) assert.strictEqual(state.receivables[0].paidAmount, '500');
      });
    });
  }

  test(`未关联订单定金：日期${paymentDate || '留空'}`, () => {
    const raw = deposit({ orderId: '', orderSelectionConfirmed: false, paymentDate });
    verifyBoth(raw, stateWith({ customers: [wang] }), expectPayment(paymentDate, '300', 'unlinked_deposit'));
  });

  test(`新建待收并收首款：日期${paymentDate || '留空'}，不能使用预计收款日`, () => {
    verifyBoth(result('payment', 'create_receivable_with_payment', {
      customerName: '王总', customerId: wang.id, amount: '6000', paymentAmount: '4000',
      remainingAmount: '2000', dueDate: '2026-08-01', paymentDate
    }, '王总总共欠6000元，付4000元，还剩2000元，8月1日收'), stateWith({ customers: [wang] }), (state) => {
      expectPayment(paymentDate, '4000')(state);
      assert.strictEqual(state.receivables[0].dueDate, '2026-08-01');
      assert.strictEqual(state.receivables[0].paidAmount, '4000');
      assert.strictEqual(state.paymentRecords[0].receivableId, state.receivables[0].id);
    });
  });
}

test('普通未关联收款未说日期时留空', () => {
  verifyBoth(ordinaryPayment(), stateWith({ customers: [wang] }), expectPayment('', '300', 'unlinked_payment'));
});

for (const linked of [false, true]) {
  for (const paymentDate of ['', '2026-07-20']) {
    test(`普通${linked ? '关联' : '未关联'}收款兼容旧日期字段，并优先明确收款日期${paymentDate}`, () => {
      verifyBoth(ordinaryPayment(Object.assign({ dueDate: '2026-07-21', paymentDate }, linked ? {
        receivableId: linkedReceivable.id, receivableSelectionConfirmed: true
      } : {})), stateWith({
        customers: [wang], orders: linked ? [linkedOrder] : [], receivables: linked ? [linkedReceivable] : []
      }), (state) => {
        expectPayment(paymentDate || '2026-07-21', '300', linked ? 'partial_payment' : 'unlinked_payment')(state);
        if (linked) assert.strictEqual(state.receivables[0].paidAmount, '500');
      });
    });
  }
}

async function main() {
  let passed = 0;
  for (const current of tests) {
    try {
      await withFixedTestClock('2026-07-22T02:30:00.000Z', 'Asia/Shanghai', current.run);
      passed += 1;
      console.log(`PASS ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}: ${error.message}`);
    }
  }
  console.log(`Save date consistency: ${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
