#!/usr/bin/env node

const assert = require('assert');
const { buildExecutionPlan } = require('../runner/build-execution-plan');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadCorpus } = require('../runner/load-corpus');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { normalizeAiResult } = require('../../../utils/ai-parser');
const { saveConfirmedDraft } = require('../../../utils/business');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { parseInput } = require('../../../utils/parser');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const { safeClone } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE, withFrozenClock } = require('./clock');

const tests = [];
const corpus = loadCorpus();
const pageCase = corpus.byId.get('REC-E2E-MULTI-001');
assert(pageCase, 'Missing REC-E2E-MULTI-001 page fixture');
const pagePlan = buildExecutionPlan(pageCase, corpus.fixtureResolver);

function test(caseId, title, fn) {
  tests.push({ caseId, title, fn });
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

function normalizeUncertain(local, overrides = {}) {
  const fields = safeClone(overrides.fields || local.fields || {});
  return normalizeAiResult(local, Object.assign({
    provider: 'controlled-real-fixture',
    intent: local.intent,
    fields,
    missing_fields: safeClone(local.missing_fields || []),
    low_confidence_fields: safeClone(local.low_confidence_fields || []),
    field_conflicts: safeClone(local.field_conflicts || []),
    confidence: 0.3,
    uncertain: true,
    confirm_message: '受控 REAL Fixture：只验证用户解决合同，不代表真实 AI 输出。'
  }, safeClone(overrides)), {
    providerKind: 'REAL',
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function manualFixProductDraft() {
  const local = parseText('王总周三交500个5元');
  const merged = normalizeUncertain(local);
  assert.strictEqual((merged.ai_fallback || {}).status, 'returned_uncertain');
  return merged;
}

function uncertainOrder(options = {}) {
  const items = safeClone(options.items || [{
    confirmationItemKey: 'urai-item-1',
    productName: '候选商品',
    spec: '',
    quantity: '500',
    unit: '个',
    unitPrice: '5',
    priceUnit: '个',
    totalAmount: '2500'
  }]);
  const amount = String(options.amount === undefined
    ? items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0)
    : options.amount);
  const low = safeClone(options.low || []);
  return {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: options.originalText || '王总周三交500个5元',
    parse_route: { decision: 'ai_standard', label: '请 AI 再核对' },
    ai_fallback: {
      needed: true,
      attempted: true,
      status: 'returned_uncertain',
      business_result_valid: true,
      provider_kind: options.providerKind || 'REAL'
    },
    fields: {
      customerName: options.customerName === undefined ? '王总' : options.customerName,
      dueDate: options.dueDate === undefined ? '2026-08-05' : options.dueDate,
      productName: items[0] && items[0].productName || '',
      quantity: items[0] && items[0].quantity || '',
      unit: items[0] && items[0].unit || '',
      unitPrice: items[0] && items[0].unitPrice || '',
      priceUnit: items[0] && items[0].priceUnit || '',
      amount,
      totalAmount: amount,
      calculatedAmount: amount,
      items
    },
    missing_fields: safeClone(options.missing || []),
    low_confidence_fields: low,
    field_conflicts: safeClone(options.conflicts || []),
    local_parse_safety: {
      status: 'NEEDS_AI',
      safe_to_auto_accept: false,
      unsafe_fields: safeClone(options.unsafe || low),
      missing_fields: safeClone(options.missing || []),
      low_confidence_fields: low,
      reason_texts: low.map((field) => `${field}需要用户确认`)
    },
    manual_fields: [],
    manual_item_fields: []
  };
}

function review(result) {
  return applyFinalParseSafety(safeClone(result), { businessDate: BUSINESS_DATE });
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
    operation: draft.operation,
    parseResult: safeClone(draft),
    disableFormalSave: true
  });
}

function editItem(page, index, field, value) {
  page.updateItemField({
    currentTarget: { dataset: { index, field } },
    detail: { value }
  });
  return page.data.parseResult;
}

function editField(page, field, value) {
  page.updateField({
    currentTarget: { dataset: { field } },
    detail: { value }
  });
  return page.data.parseResult;
}

function counts(state) {
  return {
    customers: (state.customers || []).length,
    quotations: (state.quotations || []).length,
    orders: (state.orders || []).length,
    receivables: (state.receivables || []).length,
    paymentRecords: (state.paymentRecords || []).length,
    todos: (state.todos || []).length,
    orderProgress: (state.orderProgress || []).length,
    pendingNotes: (state.pendingNotes || []).length,
    aiParseLogs: (state.aiParseLogs || []).length
  };
}

function assertZeroMutation(draft) {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const saved = saveConfirmedDraft(state, safeClone(draft));
  assert.strictEqual(saved.type, 'error');
  assert.strictEqual(saved.blocked, true);
  assert.strictEqual(JSON.stringify(state), before);
  assert.deepStrictEqual(counts(state), {
    customers: 0,
    quotations: 0,
    orders: 0,
    receivables: 0,
    paymentRecords: 0,
    todos: 0,
    orderProgress: 0,
    pendingNotes: 0,
    aiParseLogs: 0
  });
}

function hasIssue(domain, code, fieldPath = '') {
  return (domain.blockingIssues || []).some((item) => (
    item.code === code && (!fieldPath || item.fieldPath === fieldPath)
  ));
}

function resolutionStatus(result) {
  return String(((result || {}).user_resolution || {}).status || '');
}

test('URAI-001', '没有用户编辑仍然阻断', () => {
  const reviewed = review(manualFixProductDraft());
  const domain = preflight(reviewed);
  assert.strictEqual(domain.domainCanSaveFormal, false);
  assert(hasIssue(domain, 'AI_RESULT_UNRESOLVED'));
  assert.notStrictEqual(resolutionStatus(reviewed), 'MANUAL_RESOLUTION_COMPLETE');
  assertZeroMutation(reviewed);
});

test('URAI-002', '只编辑部分风险仍然阻断', () => {
  const draft = uncertainOrder({
    conflicts: [
      {
        code: 'AI_MATCHED_ITEM_FIELD_UNSUPPORTED',
        field: 'items',
        itemKey: 'urai-item-1',
        itemIndex: 0,
        itemField: 'productName',
        fieldPath: 'items[0].productName',
        values: ['候选商品'],
        message: '商品名称待用户确认。'
      },
      {
        code: 'AI_MATCHED_ITEM_FIELD_UNSUPPORTED',
        field: 'items',
        itemKey: 'urai-item-1',
        itemIndex: 0,
        itemField: 'quantity',
        fieldPath: 'items[0].quantity',
        values: ['500'],
        message: '商品数量待用户确认。'
      }
    ]
  });
  withInputPage(({ driver, page }) => {
    installDraft(page, draft);
    const edited = editItem(page, 0, 'productName', '水杯');
    assert(!(edited.field_conflicts || []).some((item) => item.itemField === 'productName'));
    assert((edited.field_conflicts || []).some((item) => item.itemField === 'quantity'));
    assert.strictEqual(page.data.disableFormalSave, true);
    page.saveFormal();
    assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
    assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
  });
});

test('URAI-003', '精确解决全部字段风险后允许保存', () => {
  withInputPage(({ driver, page, runtime }) => {
    installDraft(page, manualFixProductDraft());
    const before = safeClone(runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY));
    const edited = editItem(page, 0, 'productName', '水杯');
    assert.strictEqual(resolutionStatus(edited), 'MANUAL_RESOLUTION_COMPLETE');
    assert.strictEqual(page.data.disableFormalSave, false);
    page.saveFormal();
    const after = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
    assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 1);
    assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 1);
    assert.strictEqual((after.orders || []).length - (before.orders || []).length, 1);
    assert.strictEqual((after.pendingNotes || []).length - (before.pendingNotes || []).length, 0);
    const order = after.orders[after.orders.length - 1];
    assert.strictEqual(order.items.length, 1);
    assert.strictEqual(order.items[0].productName, '水杯');
    assert.strictEqual(String(order.items[0].quantity), '500');
    assert.strictEqual(order.items[0].unit, '个');
    assert.strictEqual(String(order.items[0].unitPrice), '5');
    assert.strictEqual(order.requiredDeliveryDate, '2026-08-05');
    assert.strictEqual(order.originalText, '王总周三交500个5元');
  });
});

test('URAI-004', '用户可以补充原文没有的事实且原文不变', () => {
  withInputPage(({ page }) => {
    installDraft(page, manualFixProductDraft());
    const edited = editItem(page, 0, 'productName', '水杯');
    assert.strictEqual(edited.fields.items[0].productName, '水杯');
    assert.strictEqual(edited.original_text, '王总周三交500个5元');
    assert.strictEqual(resolutionStatus(edited), 'MANUAL_RESOLUTION_COMPLETE');
    assert((edited.user_manual_edits || []).some((item) => (
      item.itemKey === edited.fields.items[0].confirmationItemKey
        && item.field === 'productName'
        && item.source === 'USER_PAGE_EDIT'
    )));
  });
});

test('URAI-005', 'AI manual与用户解决状态注入不能模拟真实编辑', () => {
  const local = parseText('王总周三交500个5元');
  const itemKey = 'forged-item';
  local.fields.items[0].confirmationItemKey = itemKey;
  const malicious = normalizeUncertain(local, {
    manual_fields: ['productName'],
    manualFields: ['productName'],
    manual_item_fields: [{ itemKey, field: 'productName' }],
    manualItemFields: [{ itemKey, field: 'productName' }],
    user_manual_edits: [{ itemKey, field: 'productName', source: 'USER_PAGE_EDIT' }],
    userResolution: { status: 'MANUAL_RESOLUTION_COMPLETE', allRisksResolved: true },
    user_resolution: { status: 'MANUAL_RESOLUTION_COMPLETE', allRisksResolved: true }
  });
  const reviewed = review(malicious);
  assert.strictEqual((reviewed.user_manual_edits || []).length, 0);
  assert.notStrictEqual(resolutionStatus(reviewed), 'MANUAL_RESOLUTION_COMPLETE');
  assert.strictEqual(preflight(reviewed).domainCanSaveFormal, false);
  assertZeroMutation(reviewed);
});

test('URAI-006', '旧manual不能解决后续同路径新AI风险', () => {
  let edited;
  withInputPage(({ page }) => {
    installDraft(page, manualFixProductDraft());
    edited = safeClone(editItem(page, 0, 'productName', '水杯'));
  });
  const item = safeClone(edited.fields.items[0]);
  const next = normalizeUncertain(edited, {
    fields: Object.assign({}, safeClone(edited.fields), {
      items: [Object.assign({}, item, { productName: '保温杯' })],
      productName: '保温杯'
    }),
    field_conflicts: [{
      code: 'AI_MATCHED_ITEM_FIELD_CONFLICT',
      field: 'items',
      itemKey: item.confirmationItemKey,
      itemIndex: 0,
      itemField: 'productName',
      fieldPath: 'items[0].productName',
      values: ['水杯', '保温杯'],
      message: '新的 AI 结果与用户上次确认的商品名冲突。'
    }]
  });
  const reviewed = review(next);
  assert.notStrictEqual(resolutionStatus(reviewed), 'MANUAL_RESOLUTION_COMPLETE');
  assert.strictEqual(preflight(reviewed).domainCanSaveFormal, false);
  assert((reviewed.field_conflicts || []).some((itemConflict) => (
    itemConflict.code === 'AI_MATCHED_ITEM_FIELD_CONFLICT'
  )));
});

test('URAI-007', '多商品风险必须逐项解决', () => {
  const items = [
    { confirmationItemKey: 'urai-a', productName: '候选甲', quantity: '10', unit: '个', unitPrice: '3', priceUnit: '个', totalAmount: '30' },
    { confirmationItemKey: 'urai-b', productName: '候选乙', quantity: '20', unit: '个', unitPrice: '5', priceUnit: '个', totalAmount: '100' }
  ];
  const draft = uncertainOrder({
    originalText: '王总要两种商品，8月15日交。',
    dueDate: '2026-08-15',
    items,
    conflicts: items.map((item, index) => ({
      code: 'AI_ADDED_ITEM_FIELD_UNSUPPORTED',
      field: 'items',
      itemKey: item.confirmationItemKey,
      itemIndex: index,
      itemField: 'productName',
      fieldPath: `items[${index}].productName`,
      values: [item.productName],
      message: `商品${index + 1}名称待用户确认。`
    }))
  });
  withInputPage(({ page }) => {
    installDraft(page, draft);
    editItem(page, 0, 'productName', '礼品盒');
    assert.strictEqual(page.data.disableFormalSave, true);
    assert.notStrictEqual(resolutionStatus(page.data.parseResult), 'MANUAL_RESOLUTION_COMPLETE');
    editItem(page, 1, 'productName', '饭盒');
    assert.strictEqual(resolutionStatus(page.data.parseResult), 'MANUAL_RESOLUTION_COMPLETE');
    assert.strictEqual(page.data.disableFormalSave, false);
  });
});

test('URAI-008', '结构性身份风险不能被普通字段编辑覆盖', () => {
  const draft = uncertainOrder({
    conflicts: [{
      code: 'AI_ITEM_IDENTITY_AMBIGUOUS',
      field: 'items',
      itemField: 'identity',
      fieldPath: 'items',
      values: ['localCount=1', 'aiCount=2'],
      message: '商品对应关系不明确。'
    }]
  });
  withInputPage(({ page }) => {
    installDraft(page, draft);
    const edited = editItem(page, 0, 'productName', '水杯');
    assert((edited.field_conflicts || []).some((item) => item.code === 'AI_ITEM_IDENTITY_AMBIGUOUS'));
    assert.strictEqual(page.data.disableFormalSave, true);
    assert.notStrictEqual(resolutionStatus(edited), 'MANUAL_RESOLUTION_COMPLETE');
  });
});

test('URAI-009', 'Fake Provider阻断不可由字段编辑覆盖', () => {
  const draft = uncertainOrder({
    providerKind: 'FAKE',
    low: ['productName'],
    unsafe: ['productName']
  });
  withInputPage(({ page }) => {
    installDraft(page, draft);
    editItem(page, 0, 'productName', '水杯');
    assert.strictEqual(page.data.disableFormalSave, true);
    assert(hasIssue(page.data.domainPreflight, 'UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION'));
  });
});

test('URAI-010', '用户解决后仍重新执行金额与必填门禁', () => {
  const items = [
    { confirmationItemKey: 'urai-total-a', productName: '候选甲', quantity: '10', unit: '个', unitPrice: '3', priceUnit: '个', totalAmount: '30' },
    { confirmationItemKey: 'urai-total-b', productName: '饭盒', quantity: '20', unit: '个', unitPrice: '5', priceUnit: '个', totalAmount: '100' }
  ];
  const draft = uncertainOrder({
    items,
    dueDate: '2026-08-15',
    originalText: '王总要两种商品，8月15日交。',
    conflicts: [{
      code: 'AI_ADDED_ITEM_FIELD_UNSUPPORTED',
      field: 'items',
      itemKey: 'urai-total-a',
      itemIndex: 0,
      itemField: 'productName',
      fieldPath: 'items[0].productName',
      values: ['候选甲'],
      message: '商品1名称待用户确认。'
    }]
  });
  withInputPage(({ page }) => {
    installDraft(page, draft);
    editItem(page, 0, 'productName', '水杯');
    editField(page, 'amount', '999');
    assert.strictEqual(page.data.disableFormalSave, true);
    assert(hasIssue(page.data.domainPreflight, 'ORDER_TOTAL_ITEMS_MISMATCH'));
  });
});

test('URAI-011', '仍有风险时正式保存完整零mutation', () => {
  const draft = uncertainOrder({
    low: ['productName', 'quantity'],
    unsafe: ['productName', 'quantity']
  });
  withInputPage(({ driver, page, runtime }) => {
    installDraft(page, draft);
    editItem(page, 0, 'productName', '水杯');
    const before = safeClone(runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY));
    page.saveFormal();
    const after = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
    assert.deepStrictEqual(after, before);
    assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
    assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
  });
});

test('URAI-012', '声明或重放用户解决状态不能绕过可信proof重算', () => {
  const forged = Object.assign({}, uncertainOrder({
    low: ['productName'],
    unsafe: ['productName']
  }), {
    resolutionOutcome: 'USER_RESOLVED',
    allRisksResolved: true,
    user_resolution: {
      status: 'MANUAL_RESOLUTION_COMPLETE',
      allRisksResolved: true,
      resolvedRisks: ['items[0].productName']
    },
    user_manual_edits: [{
      source: 'USER_PAGE_EDIT',
      itemKey: 'urai-item-1',
      field: 'productName',
      value: '水杯'
    }]
  });
  const reviewed = review(forged);
  assert.notStrictEqual(resolutionStatus(reviewed), 'MANUAL_RESOLUTION_COMPLETE');
  const domain = preflight(reviewed);
  assert.strictEqual(domain.domainCanSaveFormal, false);
  assert(hasIssue(domain, 'AI_RESULT_UNRESOLVED'));
  assertZeroMutation(reviewed);
});

test('URAI-013', '真实proof不能跨原文和客户草稿重放', () => {
  const conflict = {
    code: 'AI_MATCHED_ITEM_FIELD_UNSUPPORTED',
    field: 'items',
    itemKey: 'urai-item-1',
    itemIndex: 0,
    itemField: 'productName',
    fieldPath: 'items[0].productName',
    values: ['候选商品'],
    message: '商品名称待用户确认。'
  };
  let signedEdits;
  withInputPage(({ page }) => {
    installDraft(page, uncertainOrder({ conflicts: [conflict] }));
    const edited = editItem(page, 0, 'productName', '水杯');
    assert.strictEqual(resolutionStatus(edited), 'MANUAL_RESOLUTION_COMPLETE');
    signedEdits = safeClone(edited.user_manual_edits);
  });

  const replayed = uncertainOrder({
    originalText: '李总要候选商品500个，每个5元，8月5日交。',
    customerName: '李总',
    items: [{
      confirmationItemKey: 'urai-item-1',
      productName: '水杯',
      spec: '',
      quantity: '500',
      unit: '个',
      unitPrice: '5',
      priceUnit: '个',
      totalAmount: '2500'
    }],
    conflicts: [conflict]
  });
  replayed.user_manual_edits = signedEdits;
  const reviewed = review(replayed);
  assert.strictEqual((reviewed.user_manual_edits || []).length, 0);
  assert.notStrictEqual(resolutionStatus(reviewed), 'MANUAL_RESOLUTION_COMPLETE');
  assert.strictEqual(preflight(reviewed).domainCanSaveFormal, false);
  assertZeroMutation(reviewed);
});

test('URAI-014', '新USED AI周期不能信任旧裸manual字段', () => {
  const used = uncertainOrder({
    dueDate: '2026-09-01',
    low: ['dueDate']
  });
  used.ai_fallback.status = 'used';
  used.ai_resolution_revision = 2;
  used.manual_fields = ['dueDate'];
  used.user_manual_edits = [];
  assert.strictEqual((used.user_manual_edits || []).length, 0);
  const reviewedTop = review(used);
  assert((reviewedTop.low_confidence_fields || []).includes('dueDate'));
  assert.strictEqual(preflight(reviewedTop).domainCanSaveFormal, false);

  const itemDraft = uncertainOrder({
    conflicts: [{
      code: 'AI_MATCHED_ITEM_FIELD_CONFLICT',
      field: 'items',
      itemKey: 'urai-item-1',
      itemIndex: 0,
      itemField: 'productName',
      fieldPath: 'items[0].productName',
      values: ['旧商品', '候选商品'],
      message: '新 AI 周期产生了商品名冲突。'
    }]
  });
  itemDraft.ai_fallback.status = 'used';
  itemDraft.ai_resolution_revision = 2;
  itemDraft.manual_item_fields = [{ itemKey: 'urai-item-1', field: 'productName' }];
  const reviewedItem = review(itemDraft);
  assert((reviewedItem.field_conflicts || []).some((item) => (
    item.code === 'AI_MATCHED_ITEM_FIELD_CONFLICT'
  )));
  assert.strictEqual(preflight(reviewedItem).domainCanSaveFormal, false);
});

test('URAI-015', '编辑一个顶层字段不能清除其他未解决字段', () => {
  const draft = uncertainOrder({
    customerName: '',
    dueDate: '',
    missing: ['customerName', 'dueDate']
  });
  withInputPage(({ page, driver }) => {
    installDraft(page, draft);
    const edited = editField(page, 'customerName', '王总');
    assert(!(edited.missing_fields || []).includes('customerName'));
    assert((edited.missing_fields || []).includes('dueDate'));
    assert.notStrictEqual(resolutionStatus(edited), 'MANUAL_RESOLUTION_COMPLETE');
    assert.strictEqual(page.data.disableFormalSave, true);
    page.saveFormal();
    assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
    assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
  });
});

function main() {
  let passed = 0;
  let failed = 0;
  tests.forEach((item) => {
    try {
      withFrozenClock(item.caseId, item.fn);
      passed += 1;
      console.log(`PASS ${item.caseId} ${item.title}`);
    } catch (error) {
      failed += 1;
      console.log(`CASE_FAIL ${item.caseId} ${item.title}`);
      console.log(`${error.name}: ${error.message}`);
    }
  });
  console.log(`User-resolved AI state gate: PASS=${passed} CASE_FAIL=${failed} RUNNER_ERROR=0`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
