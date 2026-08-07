#!/usr/bin/env node

const assert = require('assert');
const { buildExecutionPlan } = require('../runner/build-execution-plan');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadCorpus } = require('../runner/load-corpus');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { normalizeAiResult } = require('../../../utils/ai-parser');
const { isFormalReady, saveConfirmedDraft } = require('../../../utils/business');
const {
  applyFinalParseSafety,
  collectUserResolvableAiRisks,
  evaluateUserResolvedAiState
} = require('../../../utils/parse-safety');
const { parseInput } = require('../../../utils/parser');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const { safeClone } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const {
  answerQuestion,
  submitOriginalText
} = require('../record-confirm-interaction-v1/page-actions');
const { createPageHarness } = require('../record-confirm-interaction-v1/runtime');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE, withFrozenClock } = require('./clock');

const tests = [];
const FIRST_ITEM_ALIASES = [
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'itemDeliveryDate', 'itemRemark'
];
const corpus = loadCorpus();
const pageCase = corpus.byId.get('REC-E2E-MULTI-001');
assert(pageCase, 'Missing REC-E2E-MULTI-001 page fixture');
const pagePlan = buildExecutionPlan(pageCase, corpus.fixtureResolver);

function test(caseId, title, fn) {
  tests.push({ async: false, caseId, title, fn });
}

function testAsync(caseId, title, fn) {
  tests.push({ async: true, caseId, title, fn });
}

function parseText(text) {
  return parseInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'record',
    state: createInitialState(),
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function normalizeControlledAi(local, fields, overrides = {}) {
  return normalizeAiResult(local, Object.assign({
    provider: 'controlled-fixture',
    intent: local.intent,
    fields: safeClone(fields),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.99,
    confirm_message: '受控 REAL 路由 Fixture：只验证生产 merge/safety，不代表真实 AI 输出。'
  }, safeClone(overrides)), {
    providerKind: 'REAL',
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function review(result) {
  return applyFinalParseSafety(result, { businessDate: BUSINESS_DATE });
}

function preflight(result, state = createInitialState()) {
  return evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation: result.operation,
    businessType: result.intent,
    finalResult: result,
    originalText: result.original_text,
    initialState: state,
    aiOutcome: (result.ai_fallback || {}).status || 'not_requested',
    providerKind: (result.ai_fallback || {}).provider_kind || 'NONE',
    businessDate: BUSINESS_DATE,
    skipFinalSafety: true
  });
}

function stateCounts(state) {
  return {
    customers: (state.customers || []).length,
    orders: (state.orders || []).length,
    orderProgress: (state.orderProgress || []).length,
    pendingNotes: (state.pendingNotes || []).length,
    aiParseLogs: (state.aiParseLogs || []).length,
    receivables: (state.receivables || []).length,
    paymentRecords: (state.paymentRecords || []).length,
    quotations: (state.quotations || []).length,
    todos: (state.todos || []).length
  };
}

function assertFormalZeroMutation(draft) {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const saved = saveConfirmedDraft(state, safeClone(draft));
  assert.strictEqual(saved.type, 'error');
  assert.strictEqual(saved.blocked, true);
  assert.strictEqual(JSON.stringify(state), before);
  assert.deepStrictEqual(stateCounts(state), {
    customers: 0,
    orders: 0,
    orderProgress: 0,
    pendingNotes: 0,
    aiParseLogs: 0,
    receivables: 0,
    paymentRecords: 0,
    quotations: 0,
    todos: 0
  });
  return saved;
}

function withInputPage(run) {
  const runtime = createCaseRuntime(safeClone(pagePlan.workerSpec), { attempt: 1 });
  try {
    const driver = loadProductionPage('FULL_PAGE', runtime, pagePlan.workerSpec, {
      runLifecycle: false
    });
    return run({ driver, page: driver.page, runtime });
  } finally {
    runtime.dispose();
  }
}

function installDraft(page, draft) {
  page.setData({
    fields: safeClone(draft.fields),
    intent: draft.intent,
    parseResult: safeClone(draft)
  });
}

function editItem(page, index, field, value) {
  page.updateItemField({
    currentTarget: { dataset: { index, field } },
    detail: { value }
  });
  return page.data.parseResult;
}

function manualItemFields(result) {
  return Array.isArray(result && result.manual_item_fields)
    ? result.manual_item_fields
    : [];
}

function assertManualItem(result, itemKey, field, expected = true) {
  const found = manualItemFields(result).some((item) => item
    && item.itemKey === itemKey
    && item.field === field);
  assert.strictEqual(found, expected, `${itemKey}.${field} manual provenance`);
}

function itemKey(item) {
  return item && item.confirmationItemKey;
}

function hasItemRisk(result, expected) {
  return (result.field_conflicts || []).some((conflict) => {
    if (!conflict || conflict.field !== 'items') return false;
    if (expected.itemKey && conflict.itemKey !== expected.itemKey) return false;
    if (expected.itemField && conflict.itemField !== expected.itemField) return false;
    if (expected.itemIndex !== undefined && conflict.itemIndex !== expected.itemIndex) return false;
    return true;
  });
}

function buildLocalOneAiTwo(options = {}) {
  const text = options.text
    || '宏达包装厂下单：礼品盒100套，每套3.8元；饭盒每个8.5元；8月15日交货。';
  const local = parseText(text);
  const first = safeClone((local.fields.items || [])[0]);
  assert(first, 'Local fixture must include the first item');
  const localFields = Object.assign({}, safeClone(local.fields), {
    items: [first],
    productName: first.productName,
    quantity: first.quantity,
    unit: first.unit,
    unitPrice: first.unitPrice,
    priceUnit: first.priceUnit,
    amount: first.totalAmount,
    totalAmount: first.totalAmount,
    calculatedAmount: first.totalAmount
  });
  const restricted = Object.assign({}, local, {
    fields: localFields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  const second = Object.assign({
    productName: '饭盒',
    quantity: '319',
    unit: '个',
    unitPrice: '8.5',
    priceUnit: '个',
    totalAmount: '2711.5'
  }, safeClone(options.second || {}));
  const aiFields = Object.assign({}, safeClone(localFields), {
    items: [first, second],
    amount: options.amount || '3091.5',
    totalAmount: options.amount || '3091.5',
    calculatedAmount: options.amount || '3091.5'
  });
  return {
    local: restricted,
    merged: normalizeControlledAi(restricted, aiFields),
    text
  };
}

function completePageDraft(items, options = {}) {
  const total = items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  return {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: options.originalText
      || '王总下单：礼品盒10套，每套3元；饭盒20个，每个5元；8月15日交货。',
    parse_route: { decision: 'local' },
    ai_fallback: { status: 'not_requested', attempted: false, needed: false },
    fields: {
      customerName: '王总',
      dueDate: '2026-08-15',
      amount: String(total),
      totalAmount: String(total),
      calculatedAmount: String(total),
      items: safeClone(items)
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: safeClone(options.fieldConflicts || []),
    manual_fields: []
  };
}

test('MIP-001', '商品1编辑不能为商品2背书', () => {
  const fixture = buildLocalOneAiTwo();
  withInputPage(({ page }) => {
    installDraft(page, fixture.merged);
    const edited = editItem(page, 0, 'productName', '礼品盒');
    const items = edited.fields.items;
    assert(itemKey(items[0]));
    assert(itemKey(items[1]));
    assertManualItem(edited, itemKey(items[0]), 'productName');
    assertManualItem(edited, itemKey(items[1]), 'quantity', false);

    const reviewed = review(edited);
    assert(hasItemRisk(reviewed, { itemKey: itemKey(items[1]), itemField: 'quantity' }));
    assert.strictEqual(preflight(reviewed).domainCanSaveFormal, false);
    assertFormalZeroMutation(reviewed);
  });
});

test('MIP-002', '商品2精确编辑只确认对应字段', () => {
  const draft = completePageDraft([
    { confirmationItemKey: 'item-large', productName: '礼品盒', spec: '大号', quantity: '10', unit: '套', unitPrice: '3', priceUnit: '套', totalAmount: '30' },
    { confirmationItemKey: 'item-small', productName: '饭盒', spec: '小号', quantity: '20', unit: '个', unitPrice: '5', priceUnit: '个', totalAmount: '100' }
  ], {
    fieldConflicts: [
      { field: 'items', itemKey: 'item-large', itemIndex: 0, itemField: 'productName', fieldPath: 'items[0].productName', message: '商品1名称待确认' },
      { field: 'items', itemKey: 'item-small', itemIndex: 1, itemField: 'quantity', fieldPath: 'items[1].quantity', message: '商品2数量待确认' },
      { field: 'items', itemKey: 'item-small', itemIndex: 1, itemField: 'unitPrice', fieldPath: 'items[1].unitPrice', message: '商品2单价待确认' }
    ]
  });
  withInputPage(({ page }) => {
    installDraft(page, draft);
    const edited = editItem(page, 1, 'quantity', '21');
    assertManualItem(edited, 'item-small', 'quantity');
    assertManualItem(edited, 'item-small', 'unitPrice', false);
    assertManualItem(edited, 'item-large', 'productName', false);
    const reviewed = review(edited);
    assert(!hasItemRisk(reviewed, { itemKey: 'item-small', itemField: 'quantity' }));
    assert(hasItemRisk(reviewed, { itemKey: 'item-small', itemField: 'unitPrice' }));
    assert(hasItemRisk(reviewed, { itemKey: 'item-large', itemField: 'productName' }));
  });
});

test('MIP-003', '同名商品不能串用人工确认', () => {
  const draft = completePageDraft([
    { confirmationItemKey: 'gift-large', productName: '礼品盒', spec: '大号', quantity: '10', unit: '套', unitPrice: '3', priceUnit: '套', totalAmount: '30' },
    { confirmationItemKey: 'gift-small', productName: '礼品盒', spec: '小号', quantity: '20', unit: '套', unitPrice: '4', priceUnit: '套', totalAmount: '80' }
  ]);
  withInputPage(({ page }) => {
    installDraft(page, draft);
    const edited = editItem(page, 0, 'productName', '礼品盒');
    assertManualItem(edited, 'gift-large', 'productName');
    assertManualItem(edited, 'gift-small', 'productName', false);
  });
});

test('MIP-004', '删除商品后manual来源不能漂移', () => {
  const draft = completePageDraft([
    { confirmationItemKey: 'delete-me', productName: '礼品盒', spec: '大号', quantity: '10', unit: '套', unitPrice: '3', priceUnit: '套', totalAmount: '30' },
    { confirmationItemKey: 'keep-me', productName: '饭盒', spec: '小号', quantity: '20', unit: '个', unitPrice: '5', priceUnit: '个', totalAmount: '100' }
  ]);
  withInputPage(({ page }) => {
    installDraft(page, draft);
    editItem(page, 0, 'productName', '礼品盒');
    page.removeConfirmItem({ currentTarget: { dataset: { index: 0 } } });
    const result = page.data.parseResult;
    assert.strictEqual(result.fields.items.length, 1);
    assert.strictEqual(itemKey(result.fields.items[0]), 'keep-me');
    assert.strictEqual(manualItemFields(result).some((item) => item.itemKey === 'delete-me'), false);
    assertManualItem(result, 'keep-me', 'productName', false);
  });
});

testAsync('MIP-005', '真实 signed proof 在纯商品重排后继续绑定稳定商品身份', async () => {
  const text = '王总下单：大号礼品盒100个，每个3元；小号礼品盒每个2元；8月15日交货。';
  const harness = createPageHarness({
    caseId: 'MIP-005',
    networkMode: 'DEFERRED',
    text
  });
  const stateBefore = JSON.stringify(harness.readState());
  try {
    await submitOriginalText(harness.page, text);
    const question = safeClone(harness.page.data.activeQuestion || null);
    assert(question && question.target, '真实页面必须生成商品级问题');
    assert.strictEqual(question.target.field, 'quantity');
    assert(question.target.itemKey, '真实问题必须绑定稳定 confirmationItemKey');

    const answer = await answerQuestion(harness.page, '200');
    assert.strictEqual(answer.supported, true, '必须通过真实页面回答 handler 生成 proof');
    const before = review(safeClone(harness.page.data.parseResult));
    const beforeItems = before.fields.items || [];
    const beforeKeys = beforeItems.map(itemKey);
    const beforeProofs = before.user_manual_edits || [];
    const beforeProof = beforeProofs[0] || {};
    const beforeRisks = collectUserResolvableAiRisks(before, before.fields)
      .map((risk) => risk.riskId).sort();
    const beforeResolution = evaluateUserResolvedAiState(before);
    const beforeFormalReady = isFormalReady(before, harness.readState());
    const beforeContext = safeClone(before.client_confirmation_context || {});
    const beforeAiRevision = Number(before.ai_resolution_revision || 0);

    assert.strictEqual(beforeItems.length, 2);
    assert(beforeKeys.every(Boolean));
    assert.strictEqual(new Set(beforeKeys).size, 2);
    assert.strictEqual(beforeItems[0].productName, '礼品盒');
    assert.strictEqual(beforeItems[1].productName, '礼品盒');
    assert.notStrictEqual(beforeItems[0].spec, beforeItems[1].spec);
    assert.strictEqual(beforeProofs.length, 1);
    assert.strictEqual(beforeProof.source, 'USER_ASSISTANT_ANSWER');
    assert.strictEqual(beforeProof.itemKey, question.target.itemKey);
    assert.strictEqual(beforeProof.field, 'quantity');
    assert(beforeProof.signature, '重排前 proof 必须带生产签名');
    assert.strictEqual(beforeResolution.status, 'MANUAL_RESOLUTION_COMPLETE');

    const reordered = safeClone(before);
    reordered.fields.items = reordered.fields.items.slice().reverse();
    const first = reordered.fields.items[0];
    FIRST_ITEM_ALIASES.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(first, field)) reordered.fields[field] = first[field];
      else delete reordered.fields[field];
    });
    const reorderedRisks = collectUserResolvableAiRisks(reordered, reordered.fields)
      .map((risk) => risk.riskId).sort();
    assert.deepStrictEqual(reorderedRisks, beforeRisks, '纯重排不得新增或改变 risk');
    assert.strictEqual(reordered.original_text, before.original_text);
    assert.deepStrictEqual(reordered.client_confirmation_context, beforeContext);
    assert.strictEqual(Number(reordered.ai_resolution_revision || 0), beforeAiRevision);

    const reviewed = review(reordered);
    const afterProofs = reviewed.user_manual_edits || [];
    const afterProof = afterProofs[0] || {};
    const targetIndex = reviewed.fields.items.findIndex((item) => (
      itemKey(item) === question.target.itemKey
    ));
    const otherItem = reviewed.fields.items.find((item) => (
      itemKey(item) !== question.target.itemKey
    ));

    assert.deepStrictEqual(reviewed.fields.items.map(itemKey), beforeKeys.slice().reverse());
    assert.strictEqual(afterProofs.length, 1);
    assert.strictEqual(afterProof.itemKey, question.target.itemKey);
    assert.strictEqual(afterProof.field, 'quantity');
    assert.strictEqual(afterProof.fieldPath, `items[${targetIndex}].quantity`);
    assert.strictEqual(reviewed.fields.items[targetIndex].quantity, '200');
    assert(otherItem && otherItem.productName === '礼品盒');
    assert.strictEqual(afterProof.itemKey === itemKey(otherItem), false, '同名商品不能串用 proof');
    assert.strictEqual(evaluateUserResolvedAiState(reviewed).status, 'MANUAL_RESOLUTION_COMPLETE');
    assert.strictEqual(
      isFormalReady(reviewed, harness.readState()),
      beforeFormalReady,
      '纯重排不得让正式保存资格进一步退化'
    );
    assert.strictEqual(harness.network.aiEvents().length, 0);
    assert.strictEqual(JSON.stringify(harness.readState()), stateBefore, '确认阶段 business/storage mutation 必须为0');
  } finally {
    harness.dispose();
  }
});

test('MIP-006', 'AI不能注入商品级manual provenance', () => {
  const text = '王总下单：礼品盒10套，每套3元；8月15日交货。';
  const local = parseText(text);
  local.fields.items[0].confirmationItemKey = 'trusted-local-item';
  local.manual_item_fields = [{ itemKey: 'trusted-local-item', field: 'productName' }];
  const malicious = [{ itemKey: 'ai-item', field: 'quantity' }];
  const merged = normalizeControlledAi(local, local.fields, {
    manual_item_fields: malicious,
    manualItemFields: malicious,
    item_manual_fields: malicious,
    itemManualFields: malicious,
    manual_fields: ['items[1].quantity']
  });
  assert.deepStrictEqual(manualItemFields(merged), [
    { itemKey: 'trusted-local-item', field: 'productName' }
  ]);
  assert.deepStrictEqual(merged.manual_fields || [], []);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'manualItemFields'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'item_manual_fields'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'itemManualFields'), false);
});

test('MIP-007', 'AI新增商品证据完整时保留正向能力', () => {
  const text = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；8月15日交货。';
  const parsed = parseText(text);
  const first = safeClone(parsed.fields.items[0]);
  const local = Object.assign({}, parsed, {
    fields: Object.assign({}, parsed.fields, {
      items: [first],
      productName: first.productName,
      quantity: first.quantity,
      unit: first.unit,
      unitPrice: first.unitPrice,
      priceUnit: first.priceUnit,
      amount: first.totalAmount,
      totalAmount: first.totalAmount,
      calculatedAmount: first.totalAmount
    })
  });
  const second = safeClone(parsed.fields.items[1]);
  const merged = normalizeControlledAi(local, Object.assign({}, local.fields, {
    items: [first, second],
    amount: '4676.1',
    totalAmount: '4676.1',
    calculatedAmount: '4676.1'
  }));
  const reviewed = review(merged);
  assert.strictEqual(reviewed.fields.items.length, 2);
  assert.strictEqual(reviewed.fields.items[1].productName, '饭盒');
  assert.strictEqual(reviewed.fields.items[1].quantity, '319');
  assert.strictEqual(manualItemFields(reviewed).length, 0);
  assert.strictEqual(hasItemRisk(reviewed, { itemIndex: 1 }), false);
  assert.strictEqual(preflight(reviewed).domainCanSaveFormal, true);
  const state = createInitialState();
  const saved = saveConfirmedDraft(state, safeClone(reviewed));
  assert.strictEqual(saved.type, 'order');
  assert.strictEqual(saved.record.items.length, 2);
});

test('MIP-008', 'AI新增商品无来源事实产生精确风险', () => {
  const fixture = buildLocalOneAiTwo({
    text: '宏达包装厂下单：礼品盒100套，每套3.8元；饭盒；8月15日交货。'
  });
  const reviewed = review(fixture.merged);
  const second = reviewed.fields.items[1];
  assert.strictEqual(second.productName, '饭盒');
  assert.strictEqual(second.quantity, '319');
  assert(hasItemRisk(reviewed, { itemKey: itemKey(second), itemField: 'quantity' }));
  assert(hasItemRisk(reviewed, { itemKey: itemKey(second), itemField: 'unitPrice' }));
  assert.strictEqual(preflight(reviewed).domainCanSaveFormal, false);
  assertFormalZeroMutation(reviewed);
});

test('MIP-009', 'AI新增商品身份不明确时fail-closed', () => {
  const text = '王总下单：礼品盒大号和礼品盒大号，8月15日交货。';
  const parsed = parseText(text);
  const localItem = { productName: '礼品盒', spec: '大号' };
  const local = Object.assign({}, parsed, {
    intent: 'order',
    operation: 'create_order',
    fields: Object.assign({}, parsed.fields, {
      customerName: '王总',
      dueDate: '2026-08-15',
      items: [localItem],
      productName: '礼品盒',
      spec: '大号'
    }),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  const merged = normalizeControlledAi(local, Object.assign({}, local.fields, {
    items: [
      { productName: '礼品盒', spec: '大号', quantity: '10', unit: '套', unitPrice: '3', priceUnit: '套', totalAmount: '30' },
      { productName: '礼品盒', spec: '大号', quantity: '20', unit: '套', unitPrice: '4', priceUnit: '套', totalAmount: '80' }
    ],
    amount: '110',
    totalAmount: '110',
    calculatedAmount: '110'
  }));
  const reviewed = review(merged);
  assert(hasItemRisk(reviewed, { itemField: 'identity' }));
  assert.strictEqual(preflight(reviewed).domainCanSaveFormal, false);
  assertFormalZeroMutation(reviewed);
});

test('MIP-010', '单商品旧manual_fields兼容到唯一item', () => {
  const text = '王总下单：礼品盒10套，每套3元；8月15日交货。';
  const local = parseText(text);
  local.low_confidence_fields = ['productName'];
  local.field_conflicts = [{ field: 'productName', values: ['礼品盒'], message: '请确认商品名' }];
  local.manual_fields = ['productName'];
  const reviewed = review(local);
  assert.strictEqual(reviewed.fields.items.length, 1);
  assert(itemKey(reviewed.fields.items[0]));
  assertManualItem(reviewed, itemKey(reviewed.fields.items[0]), 'productName');
  assert.strictEqual((reviewed.low_confidence_fields || []).includes('productName'), false);
  assert.strictEqual((reviewed.field_conflicts || []).some((item) => item.field === 'productName'), false);
});

test('MIP-011', '顶层manual字段继续正常', () => {
  const text = '陈总订杯垫10个，10元一个，总价90元，8月15日交货。';
  const local = parseText(text);
  const reviewed = review(Object.assign({}, local, { manual_fields: ['amount'] }));
  const state = createInitialState();
  const saved = saveConfirmedDraft(state, reviewed);
  assert.strictEqual(saved.type, 'order');
  assert.strictEqual(String(saved.record.totalAmount), '90');
  assert.strictEqual(String(saved.record.items[0].totalAmount), '100');
});

test('MIP-012', '恶意manual类型安全忽略且不抛异常', () => {
  const text = '王总下单：礼品盒10套，每套3元。';
  const malformedTopLevel = ['dueDate', { dueDate: true }, 123];
  malformedTopLevel.forEach((manualFields) => {
    const local = parseText(text);
    local.fields.dueDate = '2026-08-15';
    local.low_confidence_fields = ['dueDate'];
    local.manual_fields = manualFields;
    const reviewed = review(local);
    assert((reviewed.low_confidence_fields || []).includes('dueDate'));
  });

  const mixed = parseText(text);
  mixed.fields.dueDate = '2026-08-15';
  mixed.low_confidence_fields = ['dueDate'];
  mixed.manual_fields = [null, {}, 123, 'dueDate'];
  const mixedReviewed = review(mixed);
  assert.strictEqual((mixedReviewed.low_confidence_fields || []).includes('dueDate'), false);

  [
    'items[0].quantity',
    { itemKey: 'only-item', field: 'quantity' },
    123,
    [null, {}, 123, { itemKey: '', field: 'quantity' }]
  ].forEach((manualItemValue) => {
    const local = parseText('王总下单：礼品盒10套，每套3元；8月15日交货。');
    local.fields.items[0].confirmationItemKey = 'only-item';
    local.field_conflicts = [{
      field: 'items',
      itemKey: 'only-item',
      itemIndex: 0,
      itemField: 'quantity',
      fieldPath: 'items[0].quantity',
      message: '数量待确认'
    }];
    local.manual_item_fields = manualItemValue;
    const reviewed = review(local);
    assert(hasItemRisk(reviewed, { itemKey: 'only-item', itemField: 'quantity' }));
  });
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const item of tests) {
    try {
      if (item.async) await item.fn();
      else withFrozenClock(item.caseId, item.fn);
      passed += 1;
      console.log(`PASS ${item.caseId} ${item.title}`);
    } catch (error) {
      failed += 1;
      console.log(`CASE_FAIL ${item.caseId} ${item.title}`);
      console.log(`${error.name}: ${error.message}`);
    }
  }
  console.log(`Manual item provenance gate: PASS=${passed} CASE_FAIL=${failed} RUNNER_ERROR=0`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
