#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createInitialState } = require('../utils/storage');
const { simpleFingerprint } = require('../utils/storage');
const { saveConfirmedDraft, savePendingNote } = require('../utils/business');
const { saveConfirmedDraft: saveConfirmedDraftServer } = require('../server/utils/business');
const { normalizeAiResult } = require('../utils/ai-parser');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const {
  evaluateRecordDomainPreflight
} = require('../utils/record-domain-preflight');
const {
  buildRecordConfirmation
} = require('../utils/record-confirmation-builder');
const {
  FULL_PAGE_CAPABILITIES
} = require('../utils/record-confirmation-contract');
const {
  createFakeAiAdapter,
  createMockAiAdapter,
  createNoAiAdapter,
  createReplayAiAdapter,
  runRecordFlow
} = require('../utils/record-flow-core');
const { FLOW_MODES } = require('../utils/record-flow-contract');

delete global.wx;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateWith(overrides = {}) {
  return Object.assign(createInitialState(), {
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
    todos: [], pendingNotes: [], orderProgress: [], operationLogs: [], aiParseLogs: [],
    productCatalog: []
  }, clone(overrides));
}

function customer(id, name, overrides = {}) {
  return Object.assign({ id, name, phoneMasked: '', phoneFingerprint: '', mergedInto: '' }, overrides);
}

function order(id, customerId, overrides = {}) {
  return Object.assign({
    id, customerId, productName: '礼品盒', totalAmount: '1000', status: '待生产',
    requiredDeliveryDate: '2026-08-01', items: [{ productName: '礼品盒', quantity: '100' }]
  }, overrides);
}

function quotation(id, customerId, overrides = {}) {
  return Object.assign({ id, customerId, productName: '礼品盒', status: '待确认' }, overrides);
}

function receivable(id, customerId, overrides = {}) {
  return Object.assign({
    id, customerId, orderId: '', amount: '1000', paidAmount: '200', dueDate: '2026-08-01', status: '部分收款'
  }, overrides);
}

function result(intent, operation, fields, overrides = {}) {
  return Object.assign({
    intent,
    operation,
    fields: clone(fields || {}),
    original_text: overrides.original_text || '合成领域预检输入',
    source: 'test',
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    formal_save_blocked: false,
    mixed_business: false,
    requires_existing_record: false
  }, overrides);
}

function orderResult(fields = {}, overrides = {}) {
  return result('order', 'create_order', Object.assign({
    customerName: '王总', productName: '礼品盒', quantity: '500', unit: '个',
    unitPrice: '3.8', priceUnit: '个', amount: '1900', totalAmount: '1900',
    dueDate: '2026-08-01',
    items: [{ productName: '礼品盒', quantity: '500', unit: '个', unitPrice: '3.8', priceUnit: '个', totalAmount: '1900' }]
  }, fields), overrides);
}

function paymentResult(fields = {}, overrides = {}) {
  return result('payment', 'record_payment', Object.assign({
    customerName: '王总', paymentAmount: '300'
  }, fields), overrides);
}

function depositResult(fields = {}, overrides = {}) {
  return result('payment', 'record_order_deposit', Object.assign({
    customerName: '王总', productName: '礼品盒', depositAmount: '300', paymentKind: 'deposit'
  }, fields), overrides);
}

function explicitOrderReference(kind = 'EXPLICIT_ORDER_DEICTIC') {
  return {
    order: {
      entityType: 'ORDER',
      kind,
      explicit: true,
      requiresResolution: true,
      sourceText: kind === 'EXPLICIT_ORDER_IDENTIFIER' ? '订单号A123' : '这单',
      sourceSpan: { start: 2, end: kind === 'EXPLICIT_ORDER_IDENTIFIER' ? 9 : 4 },
      sourceField: 'ORIGINAL_TEXT',
      confidence: 0.96,
      normalizedReference: kind === 'EXPLICIT_ORDER_IDENTIFIER'
        ? 'ORDER_IDENTIFIER:A123'
        : 'THIS_ORDER',
      resolvedEntityId: null,
      evidenceSource: 'LOCAL_PARSER'
    }
  };
}

function receivableResult(fields = {}, overrides = {}) {
  return result('receivable', 'create_receivable', Object.assign({
    customerName: '王总',
    customerId: 'cus_wang',
    productName: '礼品盒',
    amount: '800',
    dueDate: '2026-08-01'
  }, fields), overrides);
}

function preflight(finalResult, initialState = stateWith(), overrides = {}) {
  return evaluateRecordDomainPreflight(Object.assign({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation: finalResult.operation,
    businessType: finalResult.intent,
    finalResult,
    originalText: finalResult.original_text,
    initialState,
    aiOutcome: ((finalResult.ai_fallback || {}).status || 'not_requested'),
    providerKind: ((finalResult.ai_fallback || {}).provider_kind || 'NONE'),
    skipFinalSafety: true
  }, overrides));
}

function issueCodes(output) {
  return output.blockingIssues.map((item) => item.code);
}

function assertDecision(name, output, allowed, expectedCode = '') {
  assert.strictEqual(output.domainCanSaveFormal, allowed, name);
  if (expectedCode) assert(issueCodes(output).includes(expectedCode), `${name}: ${expectedCode}`);
}

function loadPageFunction(relativeFile, functionName) {
  const file = path.resolve(__dirname, relativeFile);
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = {
    require: createRequire(file), console, Page: () => {}, wx: {}, result: null
  };
  vm.runInNewContext(`${code}\nresult = ${functionName};`, sandbox);
  return sandbox.result;
}

function formalCounts(state) {
  return {
    customers: (state.customers || []).length,
    quotations: (state.quotations || []).length,
    orders: (state.orders || []).length,
    receivables: (state.receivables || []).length,
    payments: (state.paymentRecords || []).length,
    todos: (state.todos || []).length
  };
}

function assertFormalDeltaZero(before, after, name) {
  const left = formalCounts(before);
  const right = formalCounts(after);
  Object.keys(left).forEach((key) => assert.strictEqual(right[key] - left[key], 0, `${name}:${key}`));
}

function assertFormalBlockedWithoutMutation(state, draft, name) {
  const before = clone(state);
  const saved = saveConfirmedDraft(state, draft);
  assert.strictEqual(saved.type, 'error', name);
  assert.strictEqual(saved.blocked, true, name);
  assert.deepStrictEqual(state, before, `${name}:state`);
  assert(saved.preflight && saved.preflight.domainCanSaveFormal === false, name);
  return saved;
}

test('领域预检纯函数稳定、可序列化、不修改输入且fingerprint随事实变化', () => {
  const state = stateWith({ customers: [customer('cus_wang', '王总')] });
  const draft = orderResult({ customerId: 'cus_wang' });
  const stateBefore = JSON.stringify(state);
  const draftBefore = JSON.stringify(draft);
  const first = preflight(draft, state);
  const second = preflight(draft, state);
  assert.deepStrictEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.strictEqual(JSON.stringify(state), stateBefore);
  assert.strictEqual(JSON.stringify(draft), draftBefore);
  assert.strictEqual(first.preflightFingerprint, second.preflightFingerprint);
  const changed = preflight(orderResult({ customerId: 'cus_wang', amount: '2000', totalAmount: '2000' }), state);
  assert.notStrictEqual(changed.preflightFingerprint, first.preflightFingerprint);
  const duplicateState = stateWith({ customers: [customer('cus_a', '王总'), customer('cus_b', '王总')] });
  const explicit = preflight(orderResult(), duplicateState, { selectedCustomerId: 'cus_b' });
  assert.strictEqual(explicit.domainCanSaveFormal, true);
  assert.strictEqual(explicit.resolvedRelations.customerId, 'cus_b');
});

test('28类决策矩阵覆盖客户、历史、关联、金额、目标和安全状态', () => {
  const wang = customer('cus_wang', '王总');
  const li = customer('cus_li', '李总');
  const base = stateWith({ customers: [wang, li] });
  const withOrder = stateWith({ customers: [wang], orders: [order('ord_1', 'cus_wang')] });
  const twoOrders = stateWith({
    customers: [wang],
    orders: [order('ord_1', 'cus_wang'), order('ord_2', 'cus_wang', { productName: '礼品盒' })]
  });
  const activeReceivable = receivable('rec_1', 'cus_wang', { orderId: 'ord_1' });
  const matrix = [
    ['新客户创建简单订单', orderResult({ customerName: '张总' }), stateWith(), true, ''],
    ['唯一已有客户没有历史业务', orderResult({ customerId: 'cus_wang' }), base, true, ''],
    ['唯一已有客户存在唯一历史订单但当前为新业务', orderResult({ customerId: 'cus_wang' }), withOrder, true, ''],
    ['同名客户需要选择', orderResult(), stateWith({ customers: [customer('c1', '王总'), customer('c2', '王总')] }), false, 'CUSTOMER_SELECTION_REQUIRED'],
    ['同一客户多个活动订单的定金不能静默选择', depositResult({ customerId: 'cus_wang' }), twoOrders, false, 'MULTIPLE_ORDER_SELECTION_REQUIRED'],
    ['订单关联其他客户报价', orderResult({ customerId: 'cus_wang', quotationId: 'quo_li' }), stateWith({ customers: [wang, li], quotations: [quotation('quo_li', 'cus_li')] }), false, 'QUOTATION_CUSTOMER_MISMATCH'],
    ['报价正向关系缺少订单反向引用', orderResult({ customerId: 'cus_wang', quotationId: 'quo_1' }), stateWith({ customers: [wang], quotations: [quotation('quo_1', 'cus_wang', { convertedOrderId: 'ord_old' })], orders: [order('ord_old', 'cus_wang')] }), false, 'QUOTATION_ORDER_RELATION_CONFLICT'],
    ['待收款与订单客户一致', result('receivable', 'create_receivable', { customerName: '王总', customerId: 'cus_wang', orderId: 'ord_1', amount: '800', dueDate: '2026-08-01' }), withOrder, true, ''],
    ['待收款与订单客户不一致', result('receivable', 'create_receivable', { customerName: '王总', customerId: 'cus_wang', orderId: 'ord_li', amount: '800', dueDate: '2026-08-01' }), stateWith({ customers: [wang, li], orders: [order('ord_li', 'cus_li')] }), false, 'ORDER_CUSTOMER_MISMATCH'],
    ['唯一待收款必须显式选择', paymentResult({ customerId: 'cus_wang' }), stateWith({ customers: [wang], receivables: [activeReceivable] }), false, 'RECEIVABLE_SELECTION_REQUIRED'],
    ['多笔待收款必须显式选择', paymentResult({ customerId: 'cus_wang' }), stateWith({ customers: [wang], receivables: [activeReceivable, receivable('rec_2', 'cus_wang')] }), false, 'MULTIPLE_RECEIVABLE_SELECTION_REQUIRED'],
    ['已结清待收款不能再次收款', paymentResult({ customerId: 'cus_wang', receivableId: 'rec_done', receivableSelectionConfirmed: true }), stateWith({ customers: [wang], receivables: [receivable('rec_done', 'cus_wang', { status: '已结清', paidAmount: '1000' })] }), false, 'RECEIVABLE_TARGET_SETTLED'],
    ['收款小于剩余金额', paymentResult({ customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true, paymentAmount: '300' }), stateWith({ customers: [wang], orders: [order('ord_1', 'cus_wang')], receivables: [activeReceivable] }), true, ''],
    ['收款等于剩余金额', paymentResult({ customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true, paymentAmount: '800' }), stateWith({ customers: [wang], orders: [order('ord_1', 'cus_wang')], receivables: [activeReceivable] }), true, ''],
    ['收款大于剩余金额', paymentResult({ customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true, paymentAmount: '801' }), stateWith({ customers: [wang], orders: [order('ord_1', 'cus_wang')], receivables: [activeReceivable] }), false, 'RECEIVABLE_PAYMENT_INVALID'],
    ['定金小于订单剩余', depositResult({ customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '300' }), withOrder, true, ''],
    ['定金等于订单剩余', depositResult({ customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '1000' }), withOrder, true, ''],
    ['定金大于订单剩余', depositResult({ customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '1001' }), withOrder, false, 'DEPOSIT_EXCEEDS_ORDER_REMAINING'],
    ['定金存在多笔关联待收款', depositResult({ customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true }), stateWith({ customers: [wang], orders: [order('ord_1', 'cus_wang')], receivables: [receivable('r1', 'cus_wang', { orderId: 'ord_1' }), receivable('r2', 'cus_wang', { orderId: 'ord_1' })] }), false, 'ORDER_RECEIVABLE_LINKS_INCONSISTENT'],
    ['更新目标不存在', result('order', 'update_order', { customerName: '王总', customerId: 'cus_wang', orderId: 'missing', productName: '礼品盒' }), base, false, 'ORDER_TARGET_NOT_FOUND'],
    ['更新目标类型错误', result('order', 'update_order', { customerName: '王总', customerId: 'cus_wang', orderId: 'quo_1', productName: '礼品盒' }), stateWith({ customers: [wang], quotations: [quotation('quo_1', 'cus_wang')] }), false, 'UPDATE_TARGET_TYPE_MISMATCH'],
    ['更新目标已完成', result('order', 'update_order', { customerName: '王总', customerId: 'cus_wang', orderId: 'ord_done', productName: '礼品盒' }), stateWith({ customers: [wang], orders: [order('ord_done', 'cus_wang', { status: '已完成' })] }), false, 'ORDER_TARGET_NOT_UPDATABLE'],
    ['多商品订单完整且可预检', orderResult({
      items: [
        { productName: '礼品盒', quantity: '500', unit: '个', unitPrice: '3.8', priceUnit: '个', totalAmount: '1900' },
        { productName: '水杯', quantity: '200', unit: '个', unitPrice: '5', priceUnit: '个', totalAmount: '1000' }
      ],
      amount: '2900', totalAmount: '2900'
    }), stateWith(), true, ''],
    ['mixed business必须阻断', orderResult({}, { mixed_business: true }), stateWith(), false, 'MIXED_BUSINESS_UNRESOLVED'],
    ['AI失败必须阻断', orderResult({}, { parse_route: { decision: 'ai_standard' }, ai_fallback: { attempted: true, status: 'failed', business_result_valid: false } }), stateWith(), false, 'AI_RESULT_UNRESOLVED'],
    ['NO_RECORD必须阻断', result('unknown', 'pending', {}, { formal_save_blocked: true }), stateWith(), false, 'NO_RECORD_OR_UNKNOWN_INTENT'],
    ['缺关键字段必须阻断', orderResult({}, { missing_fields: ['customerName'] }), stateWith(), false, 'MISSING_REQUIRED_FIELD'],
    ['历史引用没有唯一目标必须阻断', orderResult({}, { requires_existing_record: true }), stateWith(), false, 'EXISTING_TARGET_SELECTION_REQUIRED']
  ];
  assert.strictEqual(matrix.length, 28);
  matrix.forEach(([name, draft, state, allowed, code]) => assertDecision(name, preflight(draft, state), allowed, code));

  const relationConflictState = stateWith({
    customers: [wang],
    quotations: [quotation('quo_1', 'cus_wang', { convertedOrderId: 'ord_old' })],
    orders: [order('ord_old', 'cus_wang')]
  });
  const relationConflictBefore = clone(relationConflictState);
  const relationConflict = preflight(
    orderResult({
      customerId: 'cus_wang',
      quotationId: 'quo_1',
      quotationSelectionConfirmed: true
    }),
    relationConflictState
  );
  assertDecision(
    '报价正向关系缺少订单反向引用必须明确冲突',
    relationConflict,
    false,
    'QUOTATION_ORDER_RELATION_CONFLICT'
  );
  assert.strictEqual(relationConflict.domainCanSaveFormal, false);
  assert.deepStrictEqual(relationConflictState, relationConflictBefore);
  assert.strictEqual(relationConflictState.orders.length, 1);
  assert.strictEqual(relationConflictState.orderProgress.length, 0);
  assert.strictEqual(relationConflictState.quotations[0].status, '待确认');
});

test('明确订单指代的待收款在唯一、多候选及三种Evidence类型下必须选择订单', () => {
  const wang = customer('cus_wang', '王总');
  const uniqueState = stateWith({
    customers: [wang],
    orders: [order('ord_1', 'cus_wang')]
  });
  const multipleState = stateWith({
    customers: [wang],
    orders: [order('ord_1', 'cus_wang'), order('ord_2', 'cus_wang')]
  });
  [
    ['EXPLICIT_ORDER_DEICTIC', uniqueState, 'ORDER_SELECTION_REQUIRED', ['ord_1']],
    ['EXPLICIT_ORDER_DEICTIC', multipleState, 'MULTIPLE_ORDER_SELECTION_REQUIRED', ['ord_1', 'ord_2']],
    ['EXPLICIT_ORDER_IDENTIFIER', uniqueState, 'ORDER_SELECTION_REQUIRED', ['ord_1']],
    ['EXPLICIT_ORDER_NAMED_REFERENCE', uniqueState, 'ORDER_SELECTION_REQUIRED', ['ord_1']]
  ].forEach(([kind, state, code, candidateIds]) => {
    const output = preflight(receivableResult({}, {
      relation_references: explicitOrderReference(kind)
    }), state);
    assertDecision(`${kind} requires order selection`, output, false, code);
    assert.deepStrictEqual(output.requiredSelections, ['orderId']);
    assert.deepStrictEqual(output.orderReferenceGate.candidateIds, candidateIds);
    assert.strictEqual(output.orderReferenceGate.applies, true);
    assert.strictEqual(output.orderReferenceGate.resolved, false);
    assert.strictEqual(output.resolvedRelations.orderId, '');
  });
});

test('明确订单指代没有合法候选时不能降级成客户级待收款', () => {
  const output = preflight(receivableResult({}, {
    relation_references: explicitOrderReference()
  }), stateWith({ customers: [customer('cus_wang', '王总')] }));
  assertDecision('explicit reference without candidate', output, false, 'ORDER_REFERENCE_UNRESOLVED');
  assert.deepStrictEqual(output.requiredSelections, ['orderId']);
  assert.deepStrictEqual(output.candidates.orderCandidates, []);
  assert.strictEqual(output.orderReferenceGate.status, 'NO_SAFE_CANDIDATE');
  assert.strictEqual(output.resolvedRelations.orderId, '');
});

test('Preflight只消费完整可信的本地订单指代Evidence', () => {
  const state = stateWith({
    customers: [customer('cus_wang', '王总')],
    orders: [order('ord_1', 'cus_wang')]
  });
  const malformedReferences = [
    ['unknown kind', (reference) => { reference.kind = 'ORDER_REFERENCE'; }],
    ['non-local source', (reference) => { reference.evidenceSource = 'AI'; }],
    ['already resolved', (reference) => { reference.resolvedEntityId = 'ord_1'; }],
    ['missing source field', (reference) => { delete reference.sourceField; }],
    ['empty source text', (reference) => { reference.sourceText = ''; }],
    ['invalid source span', (reference) => { reference.sourceSpan.end = 99; }],
    ['missing normalized reference', (reference) => { reference.normalizedReference = ''; }],
    ['invalid confidence', (reference) => { reference.confidence = 2; }]
  ];
  malformedReferences.forEach(([name, mutate]) => {
    const relationReferences = explicitOrderReference();
    mutate(relationReferences.order);
    const output = preflight(receivableResult({}, {
      relation_references: relationReferences
    }), state);
    assertDecision(name, output, true);
    assert.deepStrictEqual(output.requiredSelections, []);
    assert.strictEqual(output.orderReferenceGate.applies, false);
    assert.strictEqual(output.orderReferenceGate.status, 'NOT_APPLICABLE');
  });
});

test('合法用户确认支持唯一选择、多候选改选，取消后恢复阻断', () => {
  const state = stateWith({
    customers: [customer('cus_wang', '王总')],
    orders: [order('ord_1', 'cus_wang'), order('ord_2', 'cus_wang')]
  });
  const base = {
    relation_references: explicitOrderReference()
  };
  const first = preflight(receivableResult({
    orderId: 'ord_1',
    orderSelectionConfirmed: true
  }, base), state);
  const second = preflight(receivableResult({
    orderId: 'ord_2',
    orderSelectionConfirmed: true
  }, base), state);
  [first, second].forEach((output) => {
    assertDecision('confirmed safe order', output, true);
    assert.deepStrictEqual(output.requiredSelections, []);
    assert.strictEqual(output.orderReferenceGate.resolved, true);
    assert.strictEqual(output.orderReferenceGate.status, 'RESOLVED');
  });
  assert.strictEqual(first.resolvedRelations.orderId, 'ord_1');
  assert.strictEqual(second.resolvedRelations.orderId, 'ord_2');

  const cancelled = preflight(receivableResult({}, base), state);
  assertDecision('cleared selection reblocks', cancelled, false, 'MULTIPLE_ORDER_SELECTION_REQUIRED');
  assert.deepStrictEqual(cancelled.requiredSelections, ['orderId']);
});

test('orderId存在但未确认、最新State删除或失效时继续阻断', () => {
  const wang = customer('cus_wang', '王总');
  const base = {
    relation_references: explicitOrderReference()
  };
  const activeState = stateWith({
    customers: [wang],
    orders: [order('ord_1', 'cus_wang')]
  });
  const unconfirmed = preflight(receivableResult({ orderId: 'ord_1' }, base), activeState);
  assertDecision(
    'selected ID without user confirmation',
    unconfirmed,
    false,
    'ORDER_SELECTION_CONFIRMATION_REQUIRED'
  );
  assert.deepStrictEqual(unconfirmed.requiredSelections, ['orderId']);

  const deletedAfterSelection = preflight(receivableResult({
    orderId: 'ord_1',
    orderSelectionConfirmed: true
  }, base), stateWith({ customers: [wang] }));
  assertDecision(
    'selected order deleted in latest state',
    deletedAfterSelection,
    false,
    'ORDER_TARGET_NOT_FOUND'
  );
  assert(issueCodes(deletedAfterSelection).includes('ORDER_REFERENCE_UNRESOLVED'));

  const inactiveAfterSelection = preflight(receivableResult({
    orderId: 'ord_1',
    orderSelectionConfirmed: true
  }, base), stateWith({
    customers: [wang],
    orders: [order('ord_1', 'cus_wang', { status: '已完成' })]
  }));
  assertDecision(
    'selected order inactive in latest state',
    inactiveAfterSelection,
    false,
    'ORDER_REFERENCE_UNRESOLVED'
  );
  assert.strictEqual(inactiveAfterSelection.orderReferenceGate.resolved, false);
});

test('普通客户级待收款不因历史订单、候选数量或商品匹配被强制关联', () => {
  const wang = customer('cus_wang', '王总');
  const states = [
    stateWith({ customers: [wang] }),
    stateWith({ customers: [wang], orders: [order('ord_1', 'cus_wang')] }),
    stateWith({
      customers: [wang],
      orders: [
        order('ord_1', 'cus_wang'),
        order('ord_2', 'cus_wang', { productName: '其他商品' })
      ]
    })
  ];
  states.forEach((state, index) => {
    const output = preflight(receivableResult({}, {
      original_text: index === 2 ? '王总礼品盒还欠800元' : '王总还欠800元'
    }), state);
    assertDecision(`customer-level receivable ${index}`, output, true);
    assert.deepStrictEqual(output.requiredSelections, []);
    assert.strictEqual(output.orderReferenceGate.applies, false);
    assert.strictEqual(output.resolvedRelations.orderId, '');
  });
  const negatedEvidenceExcluded = preflight(receivableResult({}, {
    original_text: '王总还欠800元，不关联之前订单',
    relation_references: undefined
  }), states[1]);
  assertDecision('negated order reference remains customer-level', negatedEvidenceExcluded, true);
  assert.deepStrictEqual(negatedEvidenceExcluded.requiredSelections, []);
});

test('跨客户、不存在、删除、非法状态和伪造确认均不能解除关系门禁', () => {
  const wang = customer('cus_wang', '王总');
  const li = customer('cus_li', '李总');
  const base = {
    relation_references: explicitOrderReference()
  };
  const crossCustomer = preflight(receivableResult({
    orderId: 'ord_li',
    orderSelectionConfirmed: true
  }, base), stateWith({
    customers: [wang, li],
    orders: [order('ord_li', 'cus_li')]
  }));
  assertDecision('cross-customer selected order', crossCustomer, false, 'ORDER_CUSTOMER_MISMATCH');
  assert.strictEqual(crossCustomer.orderReferenceGate.resolved, false);

  const missing = preflight(receivableResult({
    orderId: 'ord_missing',
    orderSelectionConfirmed: true
  }, base), stateWith({ customers: [wang] }));
  assertDecision('missing selected order', missing, false, 'ORDER_TARGET_NOT_FOUND');
  assert.strictEqual(missing.orderReferenceGate.resolved, false);

  const deleted = preflight(receivableResult({
    orderId: 'ord_deleted',
    orderSelectionConfirmed: true
  }, base), stateWith({
    customers: [wang],
    orders: [order('ord_deleted', 'cus_wang', {
      deletedAt: '2026-07-15T00:00:00.000Z'
    })]
  }));
  assertDecision('soft-deleted selected order', deleted, false, 'ORDER_REFERENCE_UNRESOLVED');
  assert.strictEqual(deleted.orderReferenceGate.resolved, false);

  const cancelled = preflight(receivableResult({
    orderId: 'ord_cancelled',
    orderSelectionConfirmed: true
  }, base), stateWith({
    customers: [wang],
    orders: [order('ord_cancelled', 'cus_wang', { status: '已取消' })]
  }));
  assertDecision(
    'cancelled selected order',
    cancelled,
    false,
    'CANCELLED_ORDER_RECEIVABLE_FORBIDDEN'
  );
  assert.strictEqual(cancelled.orderReferenceGate.resolved, false);

  const forgedConfirmation = preflight(receivableResult({
    orderId: 'ord_forged',
    orderSelectionConfirmed: true
  }, base), stateWith({
    customers: [wang],
    orders: [order('ord_safe', 'cus_wang')]
  }));
  assertDecision(
    'forged confirmation cannot bless non-candidate ID',
    forgedConfirmation,
    false,
    'ORDER_TARGET_NOT_FOUND'
  );
  assert(issueCodes(forgedConfirmation).includes('ORDER_REFERENCE_NOT_ELIGIBLE'));
  assert.deepStrictEqual(forgedConfirmation.requiredSelections, ['orderId']);
});

test('显式订单Evidence不会把关系门禁扩散到其他业务操作', () => {
  const wang = customer('cus_wang', '王总');
  const state = stateWith({
    customers: [wang],
    orders: [order('ord_1', 'cus_wang')]
  });
  const pairs = [
    [
      paymentResult({
        customerId: 'cus_wang',
        paymentAmount: '300',
        allowUnlinkedPayment: true,
        unlinkedPaymentCustomerId: 'cus_wang'
      }),
      paymentResult({
        customerId: 'cus_wang',
        paymentAmount: '300',
        allowUnlinkedPayment: true,
        unlinkedPaymentCustomerId: 'cus_wang'
      }, { relation_references: explicitOrderReference() })
    ],
    [
      result('payment', 'create_receivable_with_payment', {
        customerName: '王总',
        customerId: 'cus_wang',
        amount: '1000',
        paymentAmount: '300',
        dueDate: '2026-08-01'
      }),
      result('payment', 'create_receivable_with_payment', {
        customerName: '王总',
        customerId: 'cus_wang',
        amount: '1000',
        paymentAmount: '300',
        dueDate: '2026-08-01'
      }, { relation_references: explicitOrderReference() })
    ],
    [
      depositResult({ customerId: 'cus_wang' }),
      depositResult({ customerId: 'cus_wang' }, {
        relation_references: explicitOrderReference()
      })
    ],
    [
      result('dunning', 'create_todo', {
        customerName: '王总',
        customerId: 'cus_wang',
        todoTitle: '催款',
        dueDate: '2026-08-01'
      }),
      result('dunning', 'create_todo', {
        customerName: '王总',
        customerId: 'cus_wang',
        todoTitle: '催款',
        dueDate: '2026-08-01'
      }, { relation_references: explicitOrderReference() })
    ],
    [
      orderResult({ customerId: 'cus_wang' }),
      orderResult({ customerId: 'cus_wang' }, {
        relation_references: explicitOrderReference()
      })
    ],
    [
      result('order', 'update_order', {
        customerName: '王总',
        customerId: 'cus_wang',
        orderId: 'ord_1',
        productName: '礼品盒',
        dueDate: '2026-08-02'
      }),
      result('order', 'update_order', {
        customerName: '王总',
        customerId: 'cus_wang',
        orderId: 'ord_1',
        productName: '礼品盒',
        dueDate: '2026-08-02'
      }, { relation_references: explicitOrderReference() })
    ]
  ];
  pairs.forEach(([withoutEvidence, withEvidence], index) => {
    const baseOutput = preflight(withoutEvidence, state);
    const evidenceOutput = preflight(withEvidence, state);
    assert.strictEqual(evidenceOutput.orderReferenceGate.applies, false, `operation ${index}`);
    assert.deepStrictEqual(
      {
        blockingIssues: evidenceOutput.blockingIssues,
        domainCanSaveFormal: evidenceOutput.domainCanSaveFormal,
        requiredSelections: evidenceOutput.requiredSelections,
        preflightFingerprint: evidenceOutput.preflightFingerprint
      },
      {
        blockingIssues: baseOutput.blockingIssues,
        domainCanSaveFormal: baseOutput.domainCanSaveFormal,
        requiredSelections: baseOutput.requiredSelections,
        preflightFingerprint: baseOutput.preflightFingerprint
      },
      `order reference gate leaked into operation ${index}`
    );
  });
});

test('金额严格校验阻断负数、非有限值、超额与脏历史', () => {
  const wang = customer('cus_wang', '王总');
  const cases = [
    [result('receivable', 'create_receivable', { customerName: '王总', customerId: 'cus_wang', amount: '-1', dueDate: '2026-08-01' }), stateWith({ customers: [wang] }), 'RECEIVABLE_AMOUNT_INVALID'],
    [paymentResult({ customerId: 'cus_wang', paymentAmount: 'Infinity' }), stateWith({ customers: [wang] }), 'PAYMENT_AMOUNT_INVALID'],
    [depositResult({ customerId: 'cus_wang', depositAmount: '-10', allowUnlinkedOrderDeposit: true, unlinkedOrderDepositCustomerId: 'cus_wang' }), stateWith({ customers: [wang] }), 'DEPOSIT_AMOUNT_INVALID'],
    [paymentResult({ customerId: 'cus_wang', receivableId: 'dirty', receivableSelectionConfirmed: true, paymentAmount: '1' }), stateWith({ customers: [wang], receivables: [receivable('dirty', 'cus_wang', { amount: '100', paidAmount: '110' })] }), 'RECEIVABLE_HISTORY_OVERPAID']
  ];
  cases.forEach(([draft, state, code]) => assertDecision(code, preflight(draft, state), false, code));
});

test('AI P0状态和三种mode继续阻断非可信生产资格', () => {
  ['requested', 'requesting', 'unknown', 'failed', 'timed_out', 'empty_business_result', 'invalid_response', 'returned_uncertain'].forEach((status) => {
    const draft = orderResult({}, {
      parse_route: { decision: 'ai_standard' },
      ai_fallback: { attempted: true, status, business_result_valid: false }
    });
    assertDecision(status, preflight(draft), false, 'AI_RESULT_UNRESOLVED');
  });
  ['MOCK', 'FAKE', 'REPLAY'].forEach((providerKind) => {
    const output = preflight(orderResult(), stateWith(), { aiOutcome: 'USED', providerKind });
    assertDecision(providerKind, output, false, 'UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION');
  });
  ['NONE', 'UNKNOWN', 'BANANA'].forEach((providerKind) => {
    const draft = orderResult({}, {
      ai_fallback: { attempted: true, status: 'used', business_result_valid: true, provider_kind: providerKind }
    });
    assertDecision(providerKind, preflight(draft), false, 'AI_PROVIDER_IDENTITY_UNRESOLVED');
  });
  assertDecision('used missing integrity metadata', preflight(orderResult({}, {
    ai_fallback: { status: 'used' }
  })), false, 'AI_RESULT_UNRESOLVED');
  ['LOCAL_ONLY', 'AI_ONLY'].forEach((mode) => {
    const scope = mode === 'LOCAL_ONLY' ? 'LOCAL_ONLY_RESULT' : 'AI_ONLY_RESULT';
    const output = preflight(orderResult(), stateWith(), { mode, resultScope: scope });
    assertDecision(mode, output, false, 'NON_PRODUCTION_RESULT_SCOPE');
    assert.strictEqual(output.productionEligibilityResolved, false);
  });
});

test('未知operation、pending与伪造完整字段均不能取得正式资格', () => {
  assertDecision('unknown operation', preflight(orderResult({}, { operation: 'alien_operation' })), false, 'OPERATION_UNSUPPORTED');
  assertDecision('pending only', preflight(result('pending', 'pending', { originalText: '先记下这段话' }, {
    original_text: '先记下这段话'
  })), false, 'PENDING_RESULT_NOT_FORMAL');
  const unsafeConfirmation = buildRecordConfirmation({
    mode: 'PRODUCTION_ROUTING', resultScope: 'PRODUCTION_RESULT',
    finalResult: result('order', 'create_order', {}, { original_text: '只有一句空业务草稿' }),
    initialState: stateWith(), originalText: '只有一句空业务草稿',
    saveEligibility: { allowed: true, canCommitToMemory: true, canCommitToRealStorage: true },
    surfaceCapabilities: FULL_PAGE_CAPABILITIES,
    preflight: { schemaVersion: 'record-domain-preflight-v1', domainCanSaveFormal: true }
  });
  assert.strictEqual(unsafeConfirmation.domain.domainCanSaveFormal, false);
  assert(unsafeConfirmation.blockingIssues.some((item) => item.code === 'MISSING_REQUIRED_FIELD'));
});

test('客户选择同时校验强制新建、旧关系和手机号身份', () => {
  const phoneA = '13800138000';
  const phoneB = '13900139000';
  const a = customer('cus_a', '王总', { phoneFingerprint: simpleFingerprint(phoneA) });
  const b = customer('cus_b', '王总', { phoneFingerprint: simpleFingerprint(phoneB) });
  const phoneConflict = preflight(orderResult({ customerId: 'cus_a', phone: phoneB }), stateWith({ customers: [a, b] }));
  assertDecision('phone identity conflict', phoneConflict, false, 'CUSTOMER_SELECTION_INPUT_CONFLICT');

  const linkedState = stateWith({ customers: [a], orders: [order('ord_a', 'cus_a')] });
  const forceNewLinked = depositResult({
    customerName: '王总', forceNewCustomer: true, company: '新工厂',
    orderId: 'ord_a', orderSelectionConfirmed: true, depositAmount: '100'
  });
  assertDecision('force new linked old order', preflight(forceNewLinked, linkedState), false, 'ORDER_CUSTOMER_MISMATCH');
  const forceNewSelected = orderResult({
    customerId: 'cus_a', forceNewCustomer: true, company: '新工厂'
  });
  assertDecision('force new with old customer id', preflight(forceNewSelected, linkedState), false, 'NEW_CUSTOMER_EXISTING_SELECTION_CONFLICT');

  const similarState = stateWith({ customers: [customer('cus_wang', '王总')] });
  const similar = preflight(orderResult({ customerName: '王老板' }), similarState);
  assertDecision('similar customer name requires confirmation', similar, false, 'CUSTOMER_SIMILAR_NAME_CONFIRMATION_REQUIRED');
  assert.strictEqual(similar.candidates.customerCandidates.length, 1);
  const buildFull = loadPageFunction('../pages/input/input.js', 'buildConfirmationState');
  const buildHome = loadPageFunction('../pages/dashboard/dashboard.js', 'buildHomeConfirmState');
  const similarDraft = orderResult({ customerName: '王老板' });
  const full = buildFull(similarState, similarDraft, similarDraft.intent, similarDraft.fields);
  const home = buildHome(similarDraft, similarState);
  assert.strictEqual(full.domainCanSaveFormal, false);
  assert.strictEqual(full.showCustomerPicker, true);
  assert.strictEqual(home.domainCanSaveFormal, false);
  assert.strictEqual(home.disableQuickSave, true);
  assertDecision('explicitly selected similar customer', preflight(
    orderResult({ customerName: '王老板', customerId: 'cus_wang', customerSelectionConfirmed: true }), similarState
  ), true);
  [saveConfirmedDraft, saveConfirmedDraftServer].forEach((save, index) => {
    const state = stateWith({ customers: [customer('cus_wang', '王总')] });
    const draft = orderResult({
      customerName: '王老板', customerId: 'cus_wang', customerSelectionConfirmed: true
    }, { original_text: '王老板订礼品盒500个，单价3.8元，2026年8月1日交' });
    const saved = save(state, draft);
    assert.strictEqual(saved.type, 'order', `similar selected customer save ${index}`);
    assert.strictEqual(state.customers.length, 1, `similar selected customer count ${index}`);
    assert.strictEqual(saved.record.customerId, 'cus_wang', `similar selected customer relation ${index}`);
  });
});

test('报价状态和转单关系不能被更新或重复占用', () => {
  const wang = customer('cus_wang', '王总');
  const voidQuote = quotation('quo_void', 'cus_wang', { status: '已作废' });
  assertDecision('void quote create order', preflight(
    orderResult({ customerId: 'cus_wang', quotationId: 'quo_void' }),
    stateWith({ customers: [wang], quotations: [voidQuote] })
  ), false, 'QUOTATION_TARGET_NOT_ACTIVE');
  assertDecision('void quote update', preflight(
    result('quotation', 'update_quotation', { customerName: '王总', customerId: 'cus_wang', quotationId: 'quo_void', productName: '礼品盒' }),
    stateWith({ customers: [wang], quotations: [voidQuote] })
  ), false, 'QUOTATION_TARGET_NOT_UPDATABLE');

  const q1 = quotation('quo_1', 'cus_wang', { convertedOrderId: 'ord_1', status: '已转订单' });
  const linkedState = stateWith({
    customers: [wang], quotations: [q1],
    orders: [order('ord_1', 'cus_wang', { quotationId: 'quo_1' }), order('ord_2', 'cus_wang')]
  });
  assertDecision('converted quote cannot move to another order', preflight(
    result('order', 'update_order', {
      customerName: '王总', customerId: 'cus_wang', orderId: 'ord_2', quotationId: 'quo_1', productName: '礼品盒'
    }), linkedState
  ), false, 'QUOTATION_ALREADY_CONVERTED');

  assertDecision('direct update cannot detach converted quotation', preflight(result('order', 'update_order', {
    customerName: '王总', customerId: 'cus_wang', orderId: 'ord_1', quotationId: '', productName: '礼品盒'
  }, { edit_mode: 'direct_order' }), linkedState), false, 'ORDER_QUOTATION_RELATION_IMMUTABLE');

  const unlinkedOrderState = stateWith({
    customers: [wang], quotations: [quotation('quo_new', 'cus_wang')],
    orders: [order('ord_plain', 'cus_wang', { quotationId: '' })]
  });
  assertDecision('direct update cannot attach quotation without atomic conversion', preflight(result('order', 'update_order', {
    customerName: '王总', customerId: 'cus_wang', orderId: 'ord_plain', quotationId: 'quo_new', productName: '礼品盒'
  }, { edit_mode: 'direct_order' }), unlinkedOrderState), false, 'ORDER_QUOTATION_RELATION_IMMUTABLE');
});

test('每种operation只允许携带保存层会消费的关系ID', () => {
  const wang = customer('cus_wang', '王总');
  const base = stateWith({
    customers: [wang], quotations: [quotation('quo_1', 'cus_wang')],
    orders: [order('ord_1', 'cus_wang')], receivables: [receivable('rec_1', 'cus_wang', { orderId: 'ord_1' })]
  });
  const cases = [
    result('receivable', 'create_receivable', { customerName: '王总', customerId: 'cus_wang', amount: '800', dueDate: '2026-08-01', receivableId: 'rec_1' }),
    result('receivable', 'create_receivable', { customerName: '王总', customerId: 'cus_wang', amount: '800', dueDate: '2026-08-01', quotationId: 'quo_1' }),
    orderResult({ customerId: 'cus_wang', receivableId: 'rec_1' }),
    depositResult({ customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, receivableId: 'rec_1' }),
    result('todo', 'create_todo', { customerName: '王总', customerId: 'cus_wang', todoTitle: '跟进', dueDate: '2026-08-01', orderId: 'ord_1' })
  ];
  cases.forEach((draft, index) => assertDecision(
    `unsupported relation ${index + 1}`, preflight(draft, base), false, 'RELATION_NOT_SUPPORTED_FOR_OPERATION'
  ));
});

test('脏金融历史、直接清空金额和精确重复支付均阻断', () => {
  const wang = customer('cus_wang', '王总');
  const badReceivableState = stateWith({
    customers: [wang], receivables: [receivable('rec_bad', 'cus_wang', { paidAmount: 'bad' })]
  });
  assertDecision('bad paid history', preflight(paymentResult({
    customerId: 'cus_wang', receivableId: 'rec_bad', receivableSelectionConfirmed: true
  }), badReceivableState), false, 'RECEIVABLE_HISTORY_AMOUNT_INVALID');

  const badDepositState = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang')],
    paymentRecords: [{ id: 'pay_bad', customerId: 'cus_wang', orderId: 'ord_1', kind: 'deposit', amount: 'bad' }]
  });
  assertDecision('bad deposit history', preflight(depositResult({
    customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true
  }), badDepositState), false, 'ORDER_SETTLEMENT_HISTORY_INVALID');

  const directState = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang')],
    receivables: [receivable('rec_1', 'cus_wang', { orderId: 'ord_1' })]
  });
  const directClear = result('order', 'update_order', {
    customerName: '王总', customerId: 'cus_wang', orderId: 'ord_1', items: []
  }, { edit_mode: 'direct_order' });
  assertDecision('direct clear total', preflight(directClear, directState), false, 'ORDER_TOTAL_UPDATE_WITH_FINANCIAL_LINKS');

  const paymentText = '王总今天收到300元';
  const duplicatePaymentState = stateWith({
    customers: [wang], receivables: [receivable('rec_1', 'cus_wang')],
    paymentRecords: [{ id: 'pay_1', customerId: 'cus_wang', receivableId: 'rec_1', kind: 'receivable_payment', amount: '300', originalText: paymentText }]
  });
  assertDecision('exact duplicate payment', preflight(paymentResult({
    customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true, paymentAmount: '300'
  }, { original_text: paymentText }), duplicatePaymentState), false, 'POSSIBLE_DUPLICATE_PAYMENT');

  const depositText = '王总这单再记定金100元';
  const duplicateDepositState = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang')],
    paymentRecords: [{ id: 'dep_1', customerId: 'cus_wang', orderId: 'ord_1', kind: 'deposit', amount: '100', originalText: depositText }]
  });
  assertDecision('exact duplicate deposit', preflight(depositResult({
    customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '100'
  }, { original_text: depositText }), duplicateDepositState), false, 'POSSIBLE_DUPLICATE_DEPOSIT');

  const unlinkedPaymentText = '王总今天收到300元，不关联待收';
  const unlinkedPaymentState = stateWith({
    customers: [wang],
    paymentRecords: [{ id: 'pay_unlinked', customerId: 'cus_wang', kind: 'unlinked_payment', amount: '300', originalText: unlinkedPaymentText }]
  });
  assertDecision('exact duplicate unlinked payment', preflight(paymentResult({
    customerId: 'cus_wang', paymentAmount: '300', allowUnlinkedPayment: true,
    unlinkedPaymentCustomerId: 'cus_wang'
  }, { original_text: unlinkedPaymentText }), unlinkedPaymentState), false, 'POSSIBLE_DUPLICATE_PAYMENT');

  const unlinkedDepositText = '王总今天给了300元定金，不关联订单';
  const unlinkedDepositState = stateWith({
    customers: [wang],
    paymentRecords: [{ id: 'dep_unlinked', customerId: 'cus_wang', kind: 'unlinked_deposit', amount: '300', originalText: unlinkedDepositText }]
  });
  assertDecision('exact duplicate unlinked deposit', preflight(depositResult({
    customerId: 'cus_wang', depositAmount: '300', allowUnlinkedOrderDeposit: true,
    unlinkedOrderDepositCustomerId: 'cus_wang'
  }, { original_text: unlinkedDepositText }), unlinkedDepositState), false, 'POSSIBLE_DUPLICATE_DEPOSIT');
});

test('催款提醒的待收关联必须存在、客户一致且未结清', () => {
  const wang = customer('cus_wang', '王总');
  const li = customer('cus_li', '李总');
  const todo = (receivableId) => result('dunning', 'create_todo', {
    customerName: '王总', customerId: 'cus_wang', todoTitle: '催王总付款',
    dueDate: '2026-08-01', receivableId
  });
  assertDecision('cross customer dunning', preflight(todo('rec_li'), stateWith({
    customers: [wang, li], receivables: [receivable('rec_li', 'cus_li')]
  })), false, 'RECEIVABLE_CUSTOMER_MISMATCH');
  assertDecision('missing dunning receivable', preflight(
    todo('missing'), stateWith({ customers: [wang] })
  ), false, 'RECEIVABLE_TARGET_NOT_FOUND');
  assertDecision('settled dunning receivable', preflight(todo('rec_done'), stateWith({
    customers: [wang], receivables: [receivable('rec_done', 'cus_wang', { status: '已结清', paidAmount: '1000' })]
  })), false, 'RECEIVABLE_TARGET_SETTLED');
  assertDecision('active dunning receivable', preflight(todo('rec_active'), stateWith({
    customers: [wang], receivables: [receivable('rec_active', 'cus_wang')]
  })), true);
});

test('收款方向与历史汇总冲突必须在保存前阻断', () => {
  const wang = customer('cus_wang', '王总');
  assertDecision('deposit signal cannot use ordinary payment operation', preflight(paymentResult({
    customerId: 'cus_wang', paymentAmount: '300', depositAmount: '300', paymentKind: 'deposit',
    allowUnlinkedPayment: true, unlinkedPaymentCustomerId: 'cus_wang'
  }), stateWith({ customers: [wang] })), false, 'PAYMENT_DIRECTION_OPERATION_CONFLICT');
  assertDecision('ordinary payment kind cannot use deposit operation', preflight(depositResult({
    customerId: 'cus_wang', paymentKind: 'receivable_payment', allowUnlinkedOrderDeposit: true,
    unlinkedOrderDepositCustomerId: 'cus_wang'
  }), stateWith({ customers: [wang] })), false, 'PAYMENT_DIRECTION_OPERATION_CONFLICT');
  assertDecision('deposit signal cannot create ordinary receivable payment', preflight(result(
    'payment', 'create_receivable_with_payment', {
      customerName: '王总', customerId: 'cus_wang', amount: '1000', paymentAmount: '300',
      depositAmount: '300', paymentKind: 'deposit', dueDate: '2026-08-01'
    }
  ), stateWith({ customers: [wang] })), false, 'PAYMENT_DIRECTION_OPERATION_CONFLICT');
  const unsupportedKindState = stateWith({
    customers: [wang], receivables: [receivable('rec_refund', 'cus_wang', { paidAmount: '0' })]
  });
  const unsupportedKindDraft = paymentResult({
    customerId: 'cus_wang', receivableId: 'rec_refund', receivableSelectionConfirmed: true,
    paymentAmount: '300', paymentKind: 'refund'
  }, { original_text: '王总这笔退款300元' });
  assertDecision('unknown payment kind cannot settle receivable', preflight(
    unsupportedKindDraft, unsupportedKindState
  ), false, 'PAYMENT_KIND_UNSUPPORTED');
  assertFormalBlockedWithoutMutation(
    unsupportedKindState, unsupportedKindDraft, 'unsupported payment kind'
  );
  assert.strictEqual(unsupportedKindState.receivables[0].paidAmount, '0');

  const inconsistentReceivable = stateWith({
    customers: [wang],
    receivables: [receivable('rec_1', 'cus_wang', { paidAmount: '200' })],
    paymentRecords: [{ id: 'pay_1', customerId: 'cus_wang', receivableId: 'rec_1', kind: 'receivable_payment', amount: '300' }]
  });
  assertDecision('receivable summary conflicts with payment records', preflight(paymentResult({
    customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true, paymentAmount: '800'
  }), inconsistentReceivable), false, 'RECEIVABLE_SETTLEMENT_HISTORY_CONFLICT');

  const unreconciledOrder = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang')],
    paymentRecords: [{ id: 'pay_final', customerId: 'cus_wang', orderId: 'ord_1', kind: 'final_payment', amount: '800' }]
  });
  assertDecision('unreconciled order payment blocks later deposit', preflight(depositResult({
    customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '300'
  }), unreconciledOrder), false, 'ORDER_SETTLEMENT_HISTORY_CONFLICT');

  const linkedUnreconciledOrder = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang')],
    receivables: [receivable('rec_1', 'cus_wang', { orderId: 'ord_1', paidAmount: '0' })],
    paymentRecords: [{ id: 'pay_final', customerId: 'cus_wang', orderId: 'ord_1', kind: 'final_payment', amount: '800' }]
  });
  assertDecision('linked receivable does not excuse untracked order payment', preflight(depositResult({
    customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '300'
  }), linkedUnreconciledOrder), false, 'ORDER_SETTLEMENT_HISTORY_CONFLICT');

  const linkedSummaryConflict = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang')],
    receivables: [receivable('rec_1', 'cus_wang', { orderId: 'ord_1', paidAmount: '200' })],
    paymentRecords: [{ id: 'dep_1', customerId: 'cus_wang', orderId: 'ord_1', receivableId: 'rec_1', kind: 'deposit', amount: '300' }]
  });
  assertDecision('deposit also reconciles linked receivable summary', preflight(depositResult({
    customerId: 'cus_wang', orderId: 'ord_1', orderSelectionConfirmed: true, depositAmount: '300'
  }), linkedSummaryConflict), false, 'RECEIVABLE_SETTLEMENT_HISTORY_CONFLICT');

  const paymentOrderState = stateWith({
    customers: [wang], orders: [order('ord_1', 'cus_wang'), order('ord_2', 'cus_wang')],
    receivables: [receivable('rec_1', 'cus_wang', { orderId: 'ord_1', paidAmount: '0' })]
  });
  assertDecision('payment order cannot be silently dropped', preflight(paymentResult({
    customerId: 'cus_wang', orderId: 'ord_1', paymentAmount: '300', allowUnlinkedPayment: true,
    unlinkedPaymentCustomerId: 'cus_wang'
  }), paymentOrderState), false, 'PAYMENT_ORDER_REQUIRES_RECEIVABLE');
  assertDecision('selected order and receivable must agree', preflight(paymentResult({
    customerId: 'cus_wang', orderId: 'ord_2', receivableId: 'rec_1',
    receivableSelectionConfirmed: true, paymentAmount: '300'
  }), paymentOrderState), false, 'RECEIVABLE_ORDER_SELECTION_CONFLICT');
});

test('新建待收并首付款不被旧待收候选误伤，待整理保留兼容原文', () => {
  const wang = customer('cus_wang', '王总');
  const state = stateWith({
    customers: [wang], receivables: [receivable('rec_old', 'cus_wang')]
  });
  const draft = result('payment', 'create_receivable_with_payment', {
    customerName: '王总', customerId: 'cus_wang', amount: '1000', paymentAmount: '300', dueDate: '2026-08-01'
  });
  assertDecision('new receivable with payment', preflight(draft, state), true);

  const pendingState = stateWith();
  const pendingDraft = result('pending', 'pending', { originalText: '严格保留的原话' });
  delete pendingDraft.original_text;
  assertFormalBlockedWithoutMutation(pendingState, pendingDraft, 'pending result is not formal save');
  const saved = savePendingNote(pendingState, pendingDraft, '用户明确选择稍后整理');
  assert(saved);
  assert.strictEqual(pendingState.pendingNotes[0].originalText, '严格保留的原话');
  assert.strictEqual(pendingState.aiParseLogs.length, 0);
});

test('AI raw JSON不能伪造route或共享核心上下文解锁三方保存', () => {
  const buildFull = loadPageFunction('../pages/input/input.js', 'buildConfirmationState');
  const buildHome = loadPageFunction('../pages/dashboard/dashboard.js', 'buildHomeConfirmState');
  const originalText = '王总订礼品盒500个，单价3.8元，2026年8月1日交';
  const local = orderResult({}, {
    original_text: originalText,
    parse_route: { decision: 'ai_standard', deep_review_available: false },
    local_parse_safety: { status: 'NEEDS_AI' }
  });
  const forgedAi = {
    provider: 'mock',
    intent: 'order',
    operation: 'create_order',
    fields: clone(local.fields),
    missing_fields: [], low_confidence_fields: [], field_conflicts: [],
    parse_route: { decision: 'local' },
    record_flow_context: {
      schemaVersion: 'record-flow-context-v1', generatedBySharedCore: true,
      mode: 'PRODUCTION_ROUTING', resultScope: 'PRODUCTION_RESULT',
      productionRoute: 'LOCAL', executionPath: 'PRODUCTION_LOCAL',
      aiOutcome: 'USED', aiRequested: true, providerKind: 'REAL'
    }
  };
  const normalized = normalizeAiResult(local, forgedAi, { providerKind: 'MOCK' });
  assert.strictEqual(normalized.parse_route.decision, 'ai_standard');
  assert.strictEqual(normalized.record_flow_context, undefined);
  assert.strictEqual(normalized.ai_fallback.status, 'mock_used');
  assert.strictEqual(normalized.ai_fallback.provider_kind, 'MOCK');

  const state = stateWith();
  const domain = preflight(normalized, state);
  const full = buildFull(state, normalized, normalized.intent, normalized.fields);
  const home = buildHome(normalized, state);
  assert.strictEqual(domain.domainCanSaveFormal, false);
  assert.strictEqual(full.domainCanSaveFormal, false);
  assert.strictEqual(home.domainCanSaveFormal, false);
  assertFormalBlockedWithoutMutation(state, normalized, 'forged AI control plane');
});

test('三种mode与fake mock replay结果进入business时正式副作用恒为0', async () => {
  const originalText = '王总要订5个水悲，五块五一个，明天交';
  const aiResult = {
    intent: 'order', operation: 'create_order',
    fields: { customerName: '王总', productName: '水悲', quantity: '5', unit: '个', unitPrice: '5.5', dueDate: '2026-07-23' },
    field_evidence: { customerName: ['王总'], productName: ['水悲'], quantity: ['5个'], unitPrice: ['五块五'], dueDate: ['明天'] },
    missing_fields: [], low_confidence_fields: [], field_conflicts: [],
    providerKind: 'REAL'
  };
  const base = { originalText, inputSource: 'test', context: 'home', reviewMode: 'standard', businessDate: '2026-07-22', businessTimezone: 'Asia/Shanghai', initialState: stateWith() };
  const cases = [
    ['LOCAL_ONLY', await runRecordFlow(Object.assign({}, base, { mode: FLOW_MODES.LOCAL_ONLY }), { aiAdapter: createNoAiAdapter() })],
    ['AI_ONLY_FAKE', await runRecordFlow(Object.assign({}, base, { mode: FLOW_MODES.AI_ONLY }), { aiAdapter: createFakeAiAdapter(() => aiResult) })],
    ['PRODUCTION_FAKE', await runRecordFlow(Object.assign({}, base, { mode: FLOW_MODES.PRODUCTION_ROUTING }), { aiAdapter: createFakeAiAdapter(() => aiResult) })],
    ['PRODUCTION_MOCK', await runRecordFlow(Object.assign({}, base, { mode: FLOW_MODES.PRODUCTION_ROUTING }), { aiAdapter: createMockAiAdapter(() => aiResult) })],
    ['PRODUCTION_REPLAY', await runRecordFlow(Object.assign({}, base, { mode: FLOW_MODES.PRODUCTION_ROUTING }), { aiAdapter: createReplayAiAdapter(() => aiResult, { referenceMetadata: { synthetic: true } }) })]
  ];
  cases.forEach(([name, output]) => {
    assert(output.result, name);
    assert.notStrictEqual((output.result.ai_fallback || {}).provider_kind, 'REAL', `${name}: model cannot forge REAL`);
    const state = stateWith();
    const saved = assertFormalBlockedWithoutMutation(state, output.result, name);
    assert.strictEqual(saved.preflight.domainCanSaveFormal, false, name);
  });
});

test('preflight、Confirmation、完整页和首页共享同一领域结论', () => {
  const buildFull = loadPageFunction('../pages/input/input.js', 'buildConfirmationState');
  const buildHome = loadPageFunction('../pages/dashboard/dashboard.js', 'buildHomeConfirmState');
  const state = stateWith({ customers: [customer('cus_wang', '王总')] });
  const reviewed = applyFinalParseSafety(orderResult({}, {
    original_text: '王总订礼品盒500个，单价3.8元，2026年8月1日交'
  }), { businessDate: '2026-07-22' });
  const domain = preflight(reviewed, state, { skipFinalSafety: true });
  const confirmation = buildRecordConfirmation({
    mode: 'PRODUCTION_ROUTING', resultScope: 'PRODUCTION_RESULT',
    productionRoute: 'LOCAL', executionPath: 'PRODUCTION_LOCAL', finalResult: reviewed,
    finalSafety: reviewed.final_parse_safety,
    saveEligibility: { allowed: true, domainCanSaveFormal: true, canCommitToMemory: true, canCommitToRealStorage: true, blockedReasons: [] },
    originalText: reviewed.original_text, normalizedText: reviewed.original_text, inputSource: 'test',
    businessDate: '2026-07-22', businessTimezone: 'Asia/Shanghai', initialState: state,
    surfaceCapabilities: FULL_PAGE_CAPABILITIES
  });
  const full = buildFull(state, reviewed, reviewed.intent, reviewed.fields);
  const home = buildHome(reviewed, state);
  const saved = saveConfirmedDraft(stateWith({ customers: [customer('cus_wang', '王总')] }), reviewed);
  assert.strictEqual(domain.domainCanSaveFormal, true);
  assert.strictEqual(confirmation.domain.domainCanSaveFormal, domain.domainCanSaveFormal);
  assert.strictEqual(full.domainCanSaveFormal, domain.domainCanSaveFormal);
  assert.strictEqual(home.domainCanSaveFormal, domain.domainCanSaveFormal);
  assert.strictEqual(confirmation.preflightFingerprint, domain.preflightFingerprint);
  assert.strictEqual(
    full.preflightFingerprint,
    domain.preflightFingerprint,
    JSON.stringify({ domainFields: reviewed.fields, fullFields: full.parseResult && full.parseResult.fields })
  );
  assert.strictEqual(home.preflightFingerprint, domain.preflightFingerprint);
  assert.strictEqual(saved.preflight.preflightFingerprint, domain.preflightFingerprint);
});

test('金融关联下preflight、Confirmation、完整页、首页和business结论一致', () => {
  const buildFull = loadPageFunction('../pages/input/input.js', 'buildConfirmationState');
  const buildHome = loadPageFunction('../pages/dashboard/dashboard.js', 'buildHomeConfirmState');
  const buildState = () => stateWith({
    customers: [customer('cus_wang', '王总')],
    orders: [order('ord_1', 'cus_wang')],
    receivables: [receivable('rec_1', 'cus_wang', { orderId: 'ord_1' })]
  });
  [
    ['部分收款', '300', true],
    ['超额收款', '801', false]
  ].forEach(([name, amount, expected]) => {
    const state = buildState();
    const draft = applyFinalParseSafety(paymentResult({
      customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true,
      paymentAmount: amount
    }, { original_text: `王总今天收到${amount}元` }), { businessDate: '2026-07-22' });
    const domain = preflight(draft, state);
    const confirmation = buildRecordConfirmation({
      mode: 'PRODUCTION_ROUTING', resultScope: 'PRODUCTION_RESULT',
      productionRoute: 'PENDING', executionPath: 'PRODUCTION_PENDING', finalResult: draft,
      finalSafety: draft.final_parse_safety,
      saveEligibility: { allowed: true, domainCanSaveFormal: true, canCommitToMemory: true, canCommitToRealStorage: true, blockedReasons: [] },
      originalText: draft.original_text, normalizedText: draft.original_text, inputSource: 'test',
      businessDate: '2026-07-22', businessTimezone: 'Asia/Shanghai', initialState: state,
      surfaceCapabilities: FULL_PAGE_CAPABILITIES
    });
    const full = buildFull(state, draft, draft.intent, draft.fields);
    const home = buildHome(draft, state);
    const savedState = buildState();
    const savedStateBefore = clone(savedState);
    const saved = saveConfirmedDraft(savedState, draft);
    assert.strictEqual(domain.domainCanSaveFormal, expected, `${name}:preflight`);
    assert.strictEqual(confirmation.domain.domainCanSaveFormal, expected, `${name}:confirmation`);
    assert.strictEqual(full.domainCanSaveFormal, expected, `${name}:full`);
    assert.strictEqual(home.domainCanSaveFormal, expected, `${name}:home-domain`);
    assert.strictEqual(saved.preflight.domainCanSaveFormal, expected, `${name}:business`);
    assert.strictEqual(saved.type, expected ? 'payment' : 'error', `${name}:save-result`);
    if (!expected) assert.deepStrictEqual(savedState, savedStateBefore, `${name}:formal-zero-mutation`);
    assert.strictEqual(home.disableQuickSave, true, `${name}:home surface must require full page`);
  });
});

test('business阻断场景正式业务副作用恒为0且保留originalText到待整理', () => {
  const wang = customer('cus_wang', '王总');
  const li = customer('cus_li', '李总');
  const cases = [
    ['同名客户', orderResult({}, { original_text: '王总订礼品盒500个，单价3.8元，2026年8月1日交' }), stateWith({ customers: [customer('c1', '王总'), customer('c2', '王总')] })],
    ['跨客户报价', orderResult({ customerId: 'cus_wang', quotationId: 'quo_li' }, { original_text: '王总订礼品盒500个，单价3.8元，2026年8月1日交' }), stateWith({ customers: [wang, li], quotations: [quotation('quo_li', 'cus_li')] })],
    ['超额收款', paymentResult({ customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true, paymentAmount: '900' }, { original_text: '王总今天收到900元' }), stateWith({ customers: [wang], receivables: [receivable('rec_1', 'cus_wang')] })],
    ['失效更新目标', result('order', 'update_order', { customerName: '王总', customerId: 'cus_wang', orderId: 'ord_done', productName: '礼品盒' }, { original_text: '王总这单礼品盒改一下' }), stateWith({ customers: [wang], orders: [order('ord_done', 'cus_wang', { status: '已完成' })] })],
    ['强制新客户关联旧订单', depositResult({ customerName: '王总', forceNewCustomer: true, company: '新工厂', orderId: 'ord_wang', orderSelectionConfirmed: true }, { original_text: '新工厂王总给老订单定金300元' }), stateWith({ customers: [wang], orders: [order('ord_wang', 'cus_wang')] })],
    ['近似客户未确认', orderResult({ customerName: '王老板' }, { original_text: '王老板订礼品盒500个，2026年8月1日交' }), stateWith({ customers: [wang] })],
    ['催款跨客户待收', result('dunning', 'create_todo', { customerName: '王总', customerId: 'cus_wang', todoTitle: '催款', dueDate: '2026-08-01', receivableId: 'rec_li' }, { original_text: '明天催王总付款' }), stateWith({ customers: [wang, li], receivables: [receivable('rec_li', 'cus_li')] })],
    ['定金方向冲突', paymentResult({ customerId: 'cus_wang', paymentAmount: '300', depositAmount: '300', paymentKind: 'deposit', allowUnlinkedPayment: true, unlinkedPaymentCustomerId: 'cus_wang' }, { original_text: '王总给300元定金' }), stateWith({ customers: [wang] })],
    ['未知operation', orderResult({}, { operation: 'alien_operation' }) , stateWith()],
    ['AI失败', orderResult({}, { original_text: '王总订礼品盒500个，单价3.8元，2026年8月1日交', parse_route: { decision: 'ai_standard' }, ai_fallback: { attempted: true, status: 'failed', business_result_valid: false } }), stateWith()]
  ];
  cases.forEach(([name, draft, state]) => {
    const before = clone(state);
    assertFormalBlockedWithoutMutation(state, draft, name);
    assertFormalDeltaZero(before, state, name);
    const pending = savePendingNote(state, draft, '用户明确选择稍后整理');
    assert(pending, name);
    assert.strictEqual(state.pendingNotes.length, before.pendingNotes.length + 1, name);
    assert.strictEqual(state.pendingNotes[0].originalText, draft.original_text, name);
  });
});

test('business允许场景保存类型、客户、originalText和多商品正确且无额外记录', () => {
  const state = stateWith();
  const originalText = '王总订礼品盒500个每个3.8元，水杯200个每个5元，2026年8月1日交';
  const draft = orderResult({
    items: [
      { productName: '礼品盒', quantity: '500', unit: '个', unitPrice: '3.8', priceUnit: '个', totalAmount: '1900' },
      { productName: '水杯', quantity: '200', unit: '个', unitPrice: '5', priceUnit: '个', totalAmount: '1000' }
    ],
    amount: '2900', totalAmount: '2900'
  }, { original_text: originalText });
  const saved = saveConfirmedDraft(state, draft);
  assert.strictEqual(saved.type, 'order', JSON.stringify(saved.preflight && saved.preflight.blockingIssues));
  assert.strictEqual(state.customers.length, 1);
  assert.strictEqual(state.orders.length, 1);
  assert.strictEqual(state.quotations.length, 0);
  assert.strictEqual(state.receivables.length, 0);
  assert.strictEqual(state.paymentRecords.length, 0);
  assert.strictEqual(state.todos.length, 0);
  assert.strictEqual(saved.record.originalText, originalText);
  assert.strictEqual(saved.record.items.length, 2);
  assert.strictEqual(saved.record.customerId, state.customers[0].id);
});

test('不完整来源报价转订单明确拒绝且零业务变化', () => {
  const createState = () => stateWith({
    customers: [customer('cus_wang', '王总')], quotations: [quotation('quo_1', 'cus_wang')]
  });
  const draft = orderResult({
    customerId: 'cus_wang',
    quotationId: 'quo_1',
    quotationSelectionConfirmed: true
  }, {
    original_text: '王总把这份报价转成订单，2026年8月1日交',
    manual_fields: [
      'customerName', 'customerId', 'quotationId', 'quotationSelectionConfirmed',
      'productName', 'quantity', 'unitPrice', 'amount', 'dueDate'
    ]
  });
  const state = createState();
  const before = clone(state);
  const saved = saveConfirmedDraft(state, clone(draft));
  assert.strictEqual(saved.type, 'error');
  assert.strictEqual(saved.code, 'QUOTATION_ITEMS_INCOMPLETE');
  assert.strictEqual(saved.noMutation, true);
  assert.deepStrictEqual(state, before);
  assert.strictEqual(state.orders.length, 0);
  assert.strictEqual(state.orderProgress.length, 0);
  assert.strictEqual(state.quotations[0].status, '待确认');
  assert.strictEqual(Boolean(state.quotations[0].convertedOrderId), false);
});

test('business正常部分收款和正好结清均按选中关系更新，不创建错误客户', () => {
  [300, 800].forEach((amount) => {
    const state = stateWith({
      customers: [customer('cus_wang', '王总')],
      receivables: [receivable('rec_1', 'cus_wang')]
    });
    const draft = paymentResult({
      customerId: 'cus_wang', receivableId: 'rec_1', receivableSelectionConfirmed: true,
      paymentAmount: String(amount)
    }, { original_text: `王总今天收到${amount}元` });
    const saved = saveConfirmedDraft(state, draft);
    assert.strictEqual(saved.type, 'payment');
    assert.strictEqual(state.customers.length, 1);
    assert.strictEqual(state.paymentRecords.length, 1);
    assert.strictEqual(state.paymentRecords[0].receivableId, 'rec_1');
    assert.strictEqual(state.paymentRecords[0].originalText, draft.original_text);
    assert.strictEqual(state.receivables[0].status, amount === 800 ? '已结清' : '部分收款');
  });
});

async function main() {
  let passed = 0;
  const failures = [];
  for (const current of tests) {
    try {
      await current.fn();
      passed += 1;
      console.log(`PASS ${current.name}`);
    } catch (error) {
      failures.push({ name: current.name, error });
      console.error(`FAIL ${current.name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log(`Record domain preflight tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
