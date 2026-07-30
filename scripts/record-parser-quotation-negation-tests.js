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

function assertIntent(text, expectedIntent) {
  const result = parse(text);
  assert.strictEqual(result.intent, expectedIntent, text);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return result;
}

function assertNotQuotation(text) {
  const result = parse(text);
  assert.notStrictEqual(result.intent, 'quotation', `${text}: negated order must not invent quotation`);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return result;
}

function spansOverlap(left, right) {
  return left.sourceSpan.start < right.sourceSpan.end
    && right.sourceSpan.start < left.sourceSpan.end;
}

function assertNoOverlappingOrderEvidence(result, text) {
  const evidence = result.intent_evidence || {};
  (evidence.orderNegationSignals || []).forEach((negative) => {
    (evidence.reaffirmedOrderSignals || []).forEach((reaffirmed) => {
      assert.strictEqual(
        spansOverlap(negative, reaffirmed),
        false,
        `${text}: negated order span must not also be reaffirmed`
      );
    });
  });
}

function assertNegationEvidence(result, sourceText) {
  const evidence = result.intent_evidence || {};
  const signal = (evidence.orderNegationSignals || []).find((item) => item.sourceText === sourceText);
  assert(signal, `${sourceText}: order negation evidence`);
  assert.strictEqual(
    result.original_text.slice(signal.sourceSpan.start, signal.sourceSpan.end),
    sourceText,
    `${sourceText}: source span`
  );
  return signal;
}

function assertNoFormalOrder(text) {
  const result = assertNotQuotation(text);
  assert.notStrictEqual(result.intent, 'order', `${text}: negated order must not create an order candidate`);
  const preflight = evaluateRecordDomainPreflight({
    finalResult: result,
    initialState: EMPTY_STATE,
    skipFinalSafety: true
  });
  assert.strictEqual(preflight.businessType, 'unknown', `${text}: preflight businessType`);
  assert.strictEqual(preflight.domainCanSaveFormal, false, `${text}: formal save`);
  return result;
}

const basic006Text = '给郑老板报挂件3000个，1块5一个，还没下单';
const basic006 = assertIntent(basic006Text, 'quotation');
assert.strictEqual(basic006.operation, '');
assert.strictEqual(basic006.fields.customerName, '郑老板');
assert.strictEqual(basic006.fields.productName, '挂件');
assert.strictEqual(basic006.fields.quantity, '3000');
assert.strictEqual(basic006.fields.unit, '个');
assert.strictEqual(basic006.fields.unitPrice, '1.5');
assert.strictEqual(basic006.fields.amount, '4500');
assert.strictEqual(basic006.fields.dueDate, '');
assert.strictEqual(basic006.intent_evidence.winningIntent, 'quotation');
assert.strictEqual(
  basic006.intent_evidence.winningReason,
  'EXPLICIT_QUOTATION_WITH_NEGATED_ORDER_ACTION'
);
assert.strictEqual(basic006.intent_evidence.orderNegationApplied, true);
assertNegationEvidence(basic006, '还没下单');
assert(
  basic006.intent_evidence.quotationPositiveSignals.some((item) => (
    item.kind === 'QUOTATION_CONTEXTUAL_REPORT_WITH_QUANTITY_AND_PRICE'
    && item.sourceText === '报'
  )),
  'BASIC-006 must retain independent quotation evidence'
);
const basic006Preflight = evaluateRecordDomainPreflight({
  finalResult: basic006,
  initialState: EMPTY_STATE,
  skipFinalSafety: true
});
assert.strictEqual(basic006Preflight.operation, 'create_quotation');

[
  '王总还没下单水杯100个，5元一个，先报价',
  '王总尚未下单水杯100个，先出报价单',
  '王总没有下单水杯100个，客户先问价格',
  '王总不是下单水杯100个，先报个价',
  '王总先报价，确认后再下单',
  '给郑老板报挂件3000个，1块5一个，尚未下单',
  '给郑老板报挂件3000个，1块5一个，还没有正式下单'
].forEach((text) => {
  const result = assertIntent(text, 'quotation');
  assert((result.intent_evidence.quotationPositiveSignals || []).length > 0, `${text}: quote evidence`);
});

[
  '王总已经下单水杯100个，5元一个，8月1日交',
  '王总现在正式下单水杯100个，5元一个，8月1日交',
  '王总明天下单水杯100个，5元一个，8月1日交',
  '王总之前没下单，这次正式下单水杯100个，5元一个，8月1日交',
  '王总不是不下单，是现在就下单水杯100个，5元一个，8月1日交',
  '王总不是没下单，是现在就下单水杯100个，5元一个，8月1日交',
  '王总并非未下单，已经下单水杯100个，5元一个，8月1日交',
  '王总不是没有下单，现在正式下单水杯100个，5元一个，8月1日交',
  '王总还没下单，但先做水杯100个，5元一个，8月1日交',
  '王总正式下单水杯100个、杯垫200个，8月1日交'
].forEach((text) => {
  const result = assertIntent(text, 'order');
  assertNoOverlappingOrderEvidence(result, text);
});

const correctedOrder = assertIntent(
  '王总虽然还没下单，但现在确认下单水杯100个，5元一个，8月1日交',
  'order'
);
assert((correctedOrder.intent_evidence.orderNegationSignals || []).length > 0);
assert((correctedOrder.intent_evidence.reaffirmedOrderSignals || []).length > 0);
assert.strictEqual(correctedOrder.intent_evidence.orderNegationApplied, false);

assertIntent(
  '王总报价已确认，现在下单水杯100个，5元一个，8月1日交',
  'order'
);
assertIntent(
  '王总不是报价，是正式订单，水杯100个，5元一个，8月1日交',
  'order'
);

[
  '客户还没下单',
  '客户暂时不下单',
  '客户不下单了',
  '客户还没有下单记录',
  '客户等通知再下单',
  '客户不一定做',
  '客户不要记订单',
  '客户不报价，也还没下单',
  '客户先不报价，等通知',
  '报废水杯100个，每个5元',
  '报告水杯100个成本5元'
].forEach(assertNotQuotation);

[
  '王总没有下单水杯100个，5元一个，8月1日交',
  '王总还没下单水杯100个，5元一个，8月1日交',
  '王总没有正式下单水杯100个，5元一个，8月1日交',
  '王总还没正式下单水杯100个，5元一个，8月1日交',
  '王总并未正式下单水杯100个，5元一个，8月1日交',
  '王总尚未确认下单水杯100个，5元一个，8月1日交',
  '王总后来不要下单了，水杯100个，5元一个，8月1日交',
  '王总之后别下单了，水杯100个，5元一个，8月1日交',
  '王总随后没再下单了，水杯100个，5元一个，8月1日交',
  '王总后面拒绝下单了，水杯100个，5元一个，8月1日交',
  '王总后来不再下单了，水杯100个，5元一个，8月1日交',
  '王总后面拒绝再下单了，水杯100个，5元一个，8月1日交',
  '王总未下单水杯100个，5元一个，8月1日交',
  '王总没订货水杯100个，5元一个，8月1日交',
  '王总没有要货水杯100个，5元一个，8月1日交'
].forEach((text) => {
  const result = assertNoFormalOrder(text);
  assertNoOverlappingOrderEvidence(result, text);
});

const laterOrder = assertIntent(
  '王总先报水杯100个，5元一个，还没下单；后来客户下单了，8月1日交',
  'order'
);
assert((laterOrder.intent_evidence.orderNegationSignals || []).length > 0);
assert((laterOrder.intent_evidence.orderPositiveSignals || []).length > 0);
assertNoOverlappingOrderEvidence(laterOrder, laterOrder.original_text);

const paymentAfterNegatedOrder = parse('王总还没下单，另外今天收了500元');
assert.notStrictEqual(paymentAfterNegatedOrder.intent, 'order');
assert.notStrictEqual(paymentAfterNegatedOrder.intent, 'quotation');

[
  '王总下单后需要更新报价',
  '王总报价单已经发出',
  '王总问上次报价是多少？'
].forEach((text) => {
  const result = parse(text);
  assert.strictEqual(
    (result.intent_evidence.orderNegationSignals || []).length,
    0,
    `${text}: no order-negation evidence`
  );
  assert.strictEqual(result.original_text, text);
});

console.log([
  'Quotation negation parser tests passed:',
  'quotation-with-negated-order=8',
  'order-protection=13',
  'no-quotation-protection=11',
  'negated-order-zero-formal-save=15',
  'cross-business-protection=4'
].join(' '));
