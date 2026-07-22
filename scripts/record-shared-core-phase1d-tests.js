#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const {
  AI_OUTCOMES,
  FLOW_MODES,
  PROVIDER_KINDS,
  RESULT_SCOPES
} = require('../utils/record-flow-contract');
const {
  FULL_PAGE_CAPABILITIES,
  HEADLESS_TEST_CAPABILITIES,
  HOME_QUICK_CAPABILITIES,
  SURFACE_TYPES
} = require('../utils/record-confirmation-contract');
const {
  buildRecordConfirmation,
  deriveConfirmationSummary
} = require('../utils/record-confirmation-builder');
const {
  buildSaveEligibility,
  createFakeAiAdapter,
  createMockAiAdapter,
  createNoAiAdapter,
  createReplayAiAdapter,
  runRecordFlow
} = require('../utils/record-flow-core');
const { applyFinalParseSafety } = require('../utils/parse-safety');

delete global.wx;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function baseInput(originalText, overrides = {}) {
  return Object.assign({
    mode: FLOW_MODES.PRODUCTION_ROUTING,
    originalText,
    inputSource: 'typed',
    context: 'home',
    reviewMode: 'standard',
    businessDate: '2026-07-22',
    businessTimezone: 'Asia/Shanghai',
    initialState: {}
  }, overrides);
}

function validAiOrder(fields = {}, extras = {}) {
  return Object.assign({
    intent: 'order',
    operation: 'create_order',
    original_text: '王总订水杯100个，每个5.5元，明天交',
    fields: Object.assign({
      customerName: '王总',
      productName: '水杯',
      quantity: '100',
      unit: '个',
      unitPrice: '5.5',
      priceUnit: '个',
      dueDate: '2026-07-23'
    }, fields),
    field_evidence: {
      customerName: ['王总'],
      productName: ['水杯'],
      quantity: ['100个'],
      unitPrice: ['5.5元'],
      dueDate: ['明天']
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  }, extras);
}

function validDeepOrder() {
  return validAiOrder({
    productName: '水杯',
    items: [
      { productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', priceUnit: '个' },
      { productName: '礼品盒', quantity: '200', unit: '个', unitPrice: '3', priceUnit: '个' }
    ]
  }, {
    original_text: '王总水杯100个每个5.5元，礼品盒200个每个3元，明天交',
    field_evidence: {
      customerName: ['王总'],
      productName: ['水杯'],
      items: ['水杯100个；礼品盒200个'],
      dueDate: ['明天']
    }
  });
}

function directConfirmation(rawResult, overrides = {}) {
  const reviewed = overrides.skipFinalSafety
    ? JSON.parse(JSON.stringify(rawResult))
    : applyFinalParseSafety(rawResult, { businessDate: '2026-07-22' });
  const saveEligibility = overrides.saveEligibility || buildSaveEligibility(reviewed, {
    providerKind: overrides.providerKind || PROVIDER_KINDS.NONE,
    aiRequested: overrides.aiRequested === true
  });
  return buildRecordConfirmation({
    mode: overrides.mode || FLOW_MODES.PRODUCTION_ROUTING,
    resultScope: overrides.resultScope || RESULT_SCOPES.PRODUCTION_RESULT,
    productionRoute: overrides.productionRoute || 'LOCAL',
    executionPath: overrides.executionPath || 'PRODUCTION_LOCAL',
    finalResult: reviewed,
    finalSafety: reviewed.final_parse_safety,
    saveEligibility,
    originalText: overrides.originalText || reviewed.originalText || reviewed.original_text || '合成确认测试原文',
    normalizedText: overrides.normalizedText || '合成确认测试原文',
    inputSource: 'test',
    businessDate: '2026-07-22',
    businessTimezone: 'Asia/Shanghai',
    initialState: overrides.initialState,
    surfaceCapabilities: overrides.surfaceCapabilities || HEADLESS_TEST_CAPABILITIES,
    candidateContext: overrides.candidateContext,
    localResult: overrides.localResult,
    previousConfirmation: overrides.previousConfirmation,
    traceReference: overrides.traceReference || { runId: 'run-phase1d', traceId: 'trace-phase1d', caseId: 'case-phase1d' }
  });
}

function actionByType(confirmation, type) {
  return confirmation.actions.find((item) => item.type === type);
}

function fieldByKey(confirmation, key) {
  return confirmation.fields.find((item) => item.key === key);
}

function loadPageFunction(relativeFile, functionName) {
  const file = path.resolve(__dirname, relativeFile);
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = {
    require: createRequire(file),
    console,
    Page: () => {},
    wx: {},
    result: null
  };
  vm.runInNewContext(`${code}\nresult = ${functionName};`, sandbox);
  return sandbox.result;
}

function emptyBusinessState(customers = []) {
  return {
    customers,
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    todos: [],
    pendingNotes: [],
    operationLogs: []
  };
}

test('Confirmation schema稳定、平台无关、可序列化且每次构建隔离', async () => {
  const inputResult = validAiOrder();
  const before = JSON.stringify(inputResult);
  const first = directConfirmation(inputResult, {
    traceReference: {
      runId: 'safe-run', traceId: 'safe-trace', caseId: 'safe-case', apiKey: 'must-not-leak'
    }
  });
  const second = directConfirmation(inputResult);
  assert.strictEqual(first.schemaVersion, 'record-confirmation-phase1d-v1');
  assert.strictEqual(typeof first.domain.domainCanSaveFormal, 'boolean');
  assert(Array.isArray(first.fields));
  assert(Array.isArray(first.items));
  assert(Array.isArray(first.blockingIssues));
  assert(Array.isArray(first.actions));
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.strictEqual(JSON.stringify(inputResult), before);
  first.fields.push({ key: 'test-mutation' });
  assert.strictEqual(second.fields.some((item) => item.key === 'test-mutation'), false);
  assert.strictEqual(JSON.stringify(first).includes('setData'), false);
  assert.strictEqual(JSON.stringify(first).includes('wx.'), false);
  assert.strictEqual(JSON.stringify(first).includes('must-not-leak'), false);
  assert.strictEqual(fieldByKey(second, 'originalText').value, inputResult.original_text);
  assert.strictEqual(fieldByKey(second, 'originalText').editable, false);
  assert.strictEqual(fieldByKey(second, 'businessType').visibility, 'MUST_SHOW');
});

test('简单订单报价提醒待收收款定金均生成统一业务确认态', async () => {
  const cases = [
    ['王总订礼品盒500个，单价3.8元，2026年8月1日交', 'order'],
    ['给李总报水杯100个，每个5元', 'quotation'],
    ['2026年8月1日提醒我催王总', 'todo'],
    ['王总还欠5000元，2026年8月1日收', 'receivable'],
    ['今天收到李总3000元', 'payment'],
    ['王总订单定金收到2000元', 'order_deposit']
  ];
  for (const [text, expectedType] of cases) {
    const output = await runRecordFlow(baseInput(text, { mode: FLOW_MODES.LOCAL_ONLY }), {
      aiAdapter: createNoAiAdapter()
    });
    assert.strictEqual(output.confirmation.businessType, expectedType, text);
    assert.strictEqual(output.confirmation.originalText, text, text);
    assert(Array.isArray(output.confirmation.requiredFields), text);
    assert(Array.isArray(output.confirmation.actions), text);
    assert.strictEqual(typeof output.confirmation.domain.domainCanSaveFormal, 'boolean', text);
    assert.strictEqual(output.confirmation.surface.surfaceType, SURFACE_TYPES.HEADLESS_TEST, text);
  }
});

test('各业务类型沿用当前确认卡字段政策且定金不重复展示收款金额', () => {
  const cases = [
    [Object.assign(validAiOrder(), { intent: 'quotation', operation: 'create_quotation' }), ['customerName', 'productName']],
    [validAiOrder(), ['customerName', 'productName']],
    [{ intent: 'receivable', operation: 'create_receivable', fields: { customerName: '王总', amount: '5000', dueDate: '2026-08-01' }, missing_fields: [], low_confidence_fields: [], field_conflicts: [] }, ['customerName', 'receivableAmount']],
    [{ intent: 'payment', operation: 'record_payment', fields: { customerName: '王总', paymentAmount: '3000' }, missing_fields: [], low_confidence_fields: [], field_conflicts: [] }, ['customerName', 'paymentAmount']],
    [{ intent: 'payment', operation: 'record_order_deposit', fields: { customerName: '王总', paymentAmount: '2000' }, missing_fields: [], low_confidence_fields: [], field_conflicts: [] }, ['customerName', 'depositAmount']],
    [{ intent: 'todo', operation: 'create_todo', fields: { todoTitle: '催王总', dueDate: '2026-08-01' }, missing_fields: [], low_confidence_fields: [], field_conflicts: [] }, ['todoTitle', 'todoRemindDate']],
    [{ intent: 'dunning', operation: 'create_todo', fields: { customerName: '王总', dueDate: '2026-08-01' }, missing_fields: [], low_confidence_fields: [], field_conflicts: [] }, ['todoRemindDate']],
    [{ intent: 'unknown', operation: 'pending', fields: {}, missing_fields: [], low_confidence_fields: [], field_conflicts: [] }, ['originalText']]
  ];
  cases.forEach(([result, expectedRequired]) => {
    const confirmation = directConfirmation(result, { skipFinalSafety: true });
    assert.deepStrictEqual(confirmation.requiredFields, expectedRequired);
  });
  const dunning = directConfirmation(cases[6][0], { skipFinalSafety: true });
  assert.deepStrictEqual(dunning.requiredFieldGroups, [['todoTitle', 'customerName']]);
  const deposit = directConfirmation(cases[4][0], { skipFinalSafety: true });
  assert(fieldByKey(deposit, 'depositAmount'));
  assert.strictEqual(Boolean(fieldByKey(deposit, 'paymentAmount')), false);
});

test('缺字段和冲突只结构化现有安全事实并阻断正式动作', () => {
  const cases = [
    [validAiOrder({ customerName: '' }, { missing_fields: ['customerName'] }), 'customerName'],
    [{ intent: 'payment', fields: { customerName: '王总' }, missing_fields: ['paymentAmount'] }, 'paymentAmount'],
    [{ intent: 'order', fields: { customerName: '王总', productName: '礼品盒' }, missing_fields: ['quantity', 'dueDate'] }, 'quantity'],
    [{ intent: 'unknown', fields: {}, missing_fields: ['intent'] }, 'businessType'],
    [validAiOrder({}, { field_conflicts: [{ field: 'amount', values: ['3000', '5000'] }] }), 'totalAmount']
  ];
  cases.forEach(([result, expectedField]) => {
    const confirmation = directConfirmation(result);
    assert.strictEqual(confirmation.domain.domainCanSaveFormal, false);
    assert.strictEqual(confirmation.surface.effectiveCanSaveFormal, false);
    assert.strictEqual(actionByType(confirmation, 'SAVE_FORMAL').enabled, false);
    assert(confirmation.blockingIssues.some((issue) => issue.field === expectedField));
    if (expectedField !== 'businessType') {
      assert(confirmation.fields.some((field) => field.key === expectedField));
    }
  });
});

test('风险字段使用结构化级别且危险字段不会因surface能力不足而隐藏', () => {
  const result = validAiOrder({ customerName: '' }, {
    missing_fields: ['customerName'],
    field_conflicts: [{ field: 'quantity', values: ['100', '500'] }]
  });
  const home = directConfirmation(result, {
    surfaceCapabilities: HOME_QUICK_CAPABILITIES,
    skipFinalSafety: true
  });
  const customer = fieldByKey(home, 'customerName');
  const quantity = fieldByKey(home, 'quantity');
  assert.strictEqual(customer.visibility, 'MUST_SHOW');
  assert.strictEqual(customer.riskLevel, 'DANGEROUS');
  assert.strictEqual(quantity.visibility, 'MUST_SHOW');
  assert.strictEqual(quantity.riskLevel, 'ZERO_TOLERANCE');
  assert.strictEqual(home.domain.domainNeedsUserConfirmation, true);
  assert.strictEqual(home.domain.domainCanSaveFormal, false);
});

test('完整多商品在FULL_PAGE和HOME_QUICK中不丢失且只产生surface差异', async () => {
  const adapter = createFakeAiAdapter(() => validDeepOrder());
  const base = baseInput('王总水杯100个，礼品盒200个，明天交', {
    mode: FLOW_MODES.AI_ONLY,
    reviewMode: 'deep'
  });
  const full = await runRecordFlow(Object.assign({}, base, { surfaceCapabilities: FULL_PAGE_CAPABILITIES }), { aiAdapter: adapter });
  const home = await runRecordFlow(Object.assign({}, base, { surfaceCapabilities: HOME_QUICK_CAPABILITIES }), {
    aiAdapter: createFakeAiAdapter(() => validDeepOrder())
  });
  assert.strictEqual(full.confirmation.items.length, 2);
  assert.strictEqual(home.confirmation.items.length, 2);
  assert.strictEqual(home.confirmation.items[1].productName, '礼品盒');
  assert.strictEqual(full.confirmation.itemConfirmations.length, 2);
  assert.strictEqual(full.confirmation.itemConfirmations[1].fields
    .find((field) => field.key === 'productName').value, '礼品盒');
  assert.strictEqual(full.confirmation.contentHash, home.confirmation.contentHash);
  assert.strictEqual(full.confirmation.domain.domainCanSaveFormal, home.confirmation.domain.domainCanSaveFormal);
  assert.strictEqual(full.confirmation.surface.surfaceCanCompleteFormal, true);
  assert.strictEqual(home.confirmation.surface.surfaceCanCompleteFormal, false);
  assert.strictEqual(home.confirmation.surface.requiresFullPage, true);
  assert(home.confirmation.surface.missingCapabilities.includes('EDIT_ITEMS'));

  const conflictedItem = directConfirmation(Object.assign(validDeepOrder(), {
    field_conflicts: [{ field: 'quantity', values: ['100', '200'] }]
  }));
  const conflictedQuantity = conflictedItem.itemConfirmations[0].fields
    .find((field) => field.key === 'quantity');
  assert.strictEqual(conflictedQuantity.hasRisk, true);
  assert.strictEqual(conflictedQuantity.riskResolved, false);
});

test('AI used uncertain failed timeout mock empty invalid replay均保持P0安全语义', async () => {
  const cases = [
    ['used', createFakeAiAdapter(() => validAiOrder()), AI_OUTCOMES.USED, false],
    ['uncertain', createFakeAiAdapter(() => ({ intent: 'unknown', decision: 'needs_user_confirm', reason: '无法可靠确定客户', missing_fields: ['customerName'] })), AI_OUTCOMES.RETURNED_UNCERTAIN, false],
    ['failed', createFakeAiAdapter(() => { const error = new Error('failed'); error.code = 'AI_PROVIDER_FAILED'; throw error; }), AI_OUTCOMES.FAILED, false],
    ['timeout', createFakeAiAdapter(() => { const error = new Error('timeout'); error.code = 'AI_TIMEOUT'; throw error; }), AI_OUTCOMES.TIMED_OUT, false],
    ['mock', createMockAiAdapter(() => validAiOrder()), AI_OUTCOMES.MOCK_USED, false],
    ['empty', createFakeAiAdapter(() => ({})), AI_OUTCOMES.EMPTY_BUSINESS_RESULT, false],
    ['invalid', createFakeAiAdapter(() => 'not-json'), AI_OUTCOMES.INVALID_RESPONSE, false],
    ['replay', createReplayAiAdapter(() => validAiOrder(), { referenceMetadata: { caseSet: 'synthetic-v1' } }), AI_OUTCOMES.USED, false]
  ];
  for (const [name, adapter, expectedOutcome, expectedDomain] of cases) {
    const output = await runRecordFlow(baseInput('王总订水杯100个，每个5.5元，明天交', {
      mode: FLOW_MODES.AI_ONLY
    }), { aiAdapter: adapter });
    assert.strictEqual(output.trace.ai.outcome, expectedOutcome, name);
    assert.strictEqual(output.confirmation.domain.domainCanSaveFormal, expectedDomain, name);
    assert.strictEqual(output.confirmation.surface.effectiveCanCommitFormal, false, name);
    assert.strictEqual(actionByType(output.confirmation, 'SAVE_FORMAL').enabled, false, name);
  }
});

test('三种mode生成不同resultScope且AI_ONLY Confirmation不继承本地字段', async () => {
  const text = '王总订红色礼品盒500个，3.8元一个，明天交';
  const local = await runRecordFlow(baseInput(text, { mode: FLOW_MODES.LOCAL_ONLY }), {
    aiAdapter: createNoAiAdapter()
  });
  const ai = await runRecordFlow(baseInput(text, { mode: FLOW_MODES.AI_ONLY }), {
    aiAdapter: createFakeAiAdapter(() => validAiOrder({ customerName: '李总', productName: '杯垫', quantity: '300', unitPrice: '2.5' }, {
      field_evidence: { customerName: ['李总'], productName: ['杯垫'], quantity: ['300'], unitPrice: ['2.5'], dueDate: ['明天'] }
    }))
  });
  const production = await runRecordFlow(baseInput('明天提醒我催王总'), {
    aiAdapter: createNoAiAdapter()
  });
  assert.strictEqual(local.confirmation.resultScope, RESULT_SCOPES.LOCAL_ONLY_RESULT);
  assert.strictEqual(ai.confirmation.resultScope, RESULT_SCOPES.AI_ONLY_RESULT);
  assert.strictEqual(production.confirmation.resultScope, RESULT_SCOPES.PRODUCTION_RESULT);
  assert.notStrictEqual(fieldByKey(ai.confirmation, 'customerName').value, '王总');
  assert.strictEqual(fieldByKey(ai.confirmation, 'productName').value, '杯垫');
  assert.strictEqual(ai.trace.local.shadowOnly, true);
  assert.strictEqual(ai.trace.merge.performed, false);
  assert.strictEqual(local.confirmation.domain.canCommitToRealStorage, false);
  assert.strictEqual(ai.confirmation.domain.canCommitToRealStorage, false);
});

test('domain与surface及真实存储资格分别保留，互不冒充', () => {
  const safeResult = validDeepOrder();
  const safeEligibility = buildSaveEligibility(applyFinalParseSafety(safeResult), {
    providerKind: PROVIDER_KINDS.NONE,
    aiRequested: false
  });
  const safeHome = directConfirmation(safeResult, {
    surfaceCapabilities: HOME_QUICK_CAPABILITIES,
    saveEligibility: safeEligibility
  });
  assert.strictEqual(safeHome.domain.domainCanSaveFormal, true);
  assert.strictEqual(safeHome.surface.surfaceCanCompleteFormal, false);
  assert.strictEqual(safeHome.surface.requiresFullPage, true);
  assert.strictEqual(safeHome.surface.effectiveCanSaveFormal, false);

  const unsafeFull = directConfirmation(validAiOrder({ customerName: '' }, { missing_fields: ['customerName'] }), {
    surfaceCapabilities: FULL_PAGE_CAPABILITIES
  });
  assert.strictEqual(unsafeFull.domain.domainCanSaveFormal, false);
  assert.strictEqual(unsafeFull.surface.surfaceCanCompleteFormal, true);
  assert.strictEqual(unsafeFull.surface.effectiveCanSaveFormal, false);
  assert.strictEqual(actionByType(unsafeFull, 'SAVE_FORMAL').enabled, false);

  const explicitSafeEligibility = {
    allowed: true,
    domainCanSaveFormal: true,
    canCommitToMemory: true,
    canCommitToRealStorage: true,
    commitScope: 'REAL_OR_MEMORY',
    blockedReasons: [],
    formalSaveBlocked: false,
    aiResultResolved: true
  };
  const combinedPayment = directConfirmation({
    intent: 'payment',
    operation: 'record_payment',
    suggested_operation: 'create_receivable_with_payment',
    fields: { customerName: '王总', paymentAmount: '2000' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  }, {
    skipFinalSafety: true,
    saveEligibility: explicitSafeEligibility,
    surfaceCapabilities: HOME_QUICK_CAPABILITIES
  });
  assert.strictEqual(combinedPayment.domain.domainCanSaveFormal, true);
  assert.strictEqual(combinedPayment.surface.surfaceCanCompleteFormal, false);
  assert.strictEqual(combinedPayment.surface.requiresFullPage, true);
  assert(combinedPayment.surface.missingCapabilities.includes('HANDLE_COMPLEX_CONFIRMATION'));

  const unitMismatch = directConfirmation(validAiOrder({
    items: [{ productName: '水杯', quantity: '1', unit: '箱', unitPrice: '5.5', priceUnit: '个' }]
  }), {
    skipFinalSafety: true,
    saveEligibility: explicitSafeEligibility,
    surfaceCapabilities: HOME_QUICK_CAPABILITIES
  });
  assert.strictEqual(unitMismatch.surface.requiresFullPage, true);
  assert(unitMismatch.surface.missingCapabilities.includes('EDIT_ITEMS'));
});

test('候选记录只表达已有事实，不伪造订单报价或待收候选', async () => {
  const state = emptyBusinessState([
    { id: 'cus_wang_1', name: '王总', phone: '13800000001', privateNote: '不得暴露' },
    { id: 'cus_wang_2', name: '王总', phone: '13800000002', privateNote: '不得暴露' }
  ]);
  const local = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，2026年8月1日交', {
    mode: FLOW_MODES.LOCAL_ONLY,
    initialState: state,
    surfaceCapabilities: HOME_QUICK_CAPABILITIES
  }), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(local.confirmation.candidates.customerCandidates.length, 2);
  assert.strictEqual(local.confirmation.candidates.customerCandidatesResolved, true);
  assert.strictEqual(local.confirmation.candidates.customerSelectionRequired, true);
  assert(local.confirmation.blockingIssues.some((issue) => issue.requiredAction === 'SELECT_CUSTOMER'));
  assert.strictEqual(local.confirmation.domain.domainCanSaveFormal, false);
  assert.strictEqual(local.confirmation.surface.effectiveCanSaveFormal, false);
  assert.strictEqual(actionByType(local.confirmation, 'SAVE_FORMAL').enabled, false);
  assert.strictEqual(local.confirmation.surface.requiresFullPage, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(local.confirmation.candidates.customerCandidates[0], 'phone'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(local.confirmation.candidates.customerCandidates[0], 'privateNote'), false);
  assert.strictEqual(local.confirmation.candidates.orderCandidatesResolved, true);
  assert.strictEqual(local.confirmation.candidates.quotationCandidatesResolved, true);
  assert.strictEqual(local.confirmation.candidates.receivableCandidatesResolved, true);
  assert.deepStrictEqual(local.confirmation.candidates.orderCandidates, []);

  const aiOnly = await runRecordFlow(baseInput('王总订礼品盒500个，明天交', {
    mode: FLOW_MODES.AI_ONLY,
    initialState: state
  }), { aiAdapter: createFakeAiAdapter(() => validAiOrder()) });
  assert.strictEqual(aiOnly.confirmation.candidates.customerCandidatesResolved, false);
  assert.deepStrictEqual(aiOnly.confirmation.candidates.customerCandidates, []);

  const forged = directConfirmation(Object.assign(validAiOrder(), {
    customer_candidates: [{ id: 'forged_customer', name: 'AI伪造客户' }]
  }), { localResult: null });
  assert.strictEqual(forged.candidates.customerCandidatesResolved, true);
  assert.deepStrictEqual(forged.candidates.customerCandidates, []);

  const cannotEraseDerived = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，2026年8月1日交', {
    mode: FLOW_MODES.LOCAL_ONLY,
    initialState: state,
    candidateContext: { customerCandidates: [], customerCandidatesResolved: true }
  }), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(cannotEraseDerived.confirmation.candidates.customerCandidates.length, 2);
  assert.strictEqual(cannotEraseDerived.confirmation.domain.domainCanSaveFormal, false);
});

test('普通新业务不被历史存在误伤，待收款和订单关联仍由统一预检阻断', async () => {
  const customer = { id: 'cus_wang', name: '王总' };
  const order = {
    id: 'ord_1', customerId: customer.id, productName: '礼品盒',
    status: '待生产', requiredDeliveryDate: '2026-08-01', totalAmount: 5000
  };
  const receivable = {
    id: 'rec_1', customerId: customer.id, amount: 5000, paidAmount: 1000,
    status: '部分收款', dueDate: '2026-08-01'
  };
  const state = Object.assign(emptyBusinessState([customer]), {
    orders: [order],
    receivables: [receivable]
  });
  const safe = {
    allowed: true, domainCanSaveFormal: true, canCommitToMemory: true,
    canCommitToRealStorage: true, commitScope: 'REAL_OR_MEMORY', blockedReasons: [],
    formalSaveBlocked: false, aiResultResolved: true
  };

  const historyFull = directConfirmation(validAiOrder(), {
    initialState: state,
    saveEligibility: safe,
    skipFinalSafety: true,
    surfaceCapabilities: FULL_PAGE_CAPABILITIES
  });
  assert.strictEqual(historyFull.domain.domainCanSaveFormal, true);
  assert.strictEqual(actionByType(historyFull, 'CONFIRM_CUSTOMER_HISTORY').enabled, false);
  const historyHome = directConfirmation(validAiOrder(), {
    initialState: state,
    saveEligibility: safe,
    skipFinalSafety: true,
    surfaceCapabilities: HOME_QUICK_CAPABILITIES
  });
  assert.strictEqual(historyHome.surface.requiresFullPage, false);
  assert.strictEqual(actionByType(historyHome, 'CONFIRM_CUSTOMER_HISTORY').enabled, false);

  const realLocalHistory = await runRecordFlow(baseInput(
    '王总订礼品盒500个，单价3.8元，2026年8月1日交',
    { initialState: state, surfaceCapabilities: FULL_PAGE_CAPABILITIES }
  ), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(realLocalHistory.result.operation, '');
  assert.strictEqual(realLocalHistory.confirmation.operation, 'create_order');
  assert.strictEqual(realLocalHistory.confirmation.domain.domainCanSaveFormal, true);

  const paymentDraft = {
    intent: 'payment', operation: 'record_payment',
    fields: { customerName: '王总', paymentAmount: '1000' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  };
  const payment = directConfirmation(paymentDraft, {
    initialState: state, saveEligibility: safe, skipFinalSafety: true
  });
  assert.strictEqual(payment.candidates.receivableCandidatesResolved, true);
  assert.strictEqual(payment.candidates.receivableCandidates.length, 1);
  assert.strictEqual(payment.candidates.receivableSelectionRequired, true);
  assert.strictEqual(payment.domain.domainCanSaveFormal, false);

  const selectedPayment = directConfirmation(Object.assign({}, paymentDraft, {
    fields: Object.assign({}, paymentDraft.fields, {
      customerId: customer.id,
      receivableId: receivable.id,
      receivableSelectionConfirmed: true
    })
  }), { initialState: state, saveEligibility: safe, skipFinalSafety: true });
  assert.strictEqual(selectedPayment.candidates.receivableSelectionRequired, false);
  assert.strictEqual(selectedPayment.domain.domainCanSaveFormal, true);

  const depositDraft = {
    intent: 'payment', operation: 'record_order_deposit',
    fields: { customerName: '王总', productName: '礼品盒', paymentAmount: '500' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  };
  const deposit = directConfirmation(depositDraft, {
    initialState: state, saveEligibility: safe, skipFinalSafety: true
  });
  assert.strictEqual(deposit.candidates.orderCandidatesResolved, true);
  assert.strictEqual(deposit.candidates.orderSelectionRequired, true);
  assert.strictEqual(deposit.domain.domainCanSaveFormal, false);

  const wrongCustomer = directConfirmation(Object.assign(validAiOrder(), {
    fields: Object.assign({}, validAiOrder().fields, { customerId: 'cus_other' })
  }), {
    initialState: Object.assign(emptyBusinessState([
      customer,
      { id: 'cus_other', name: '李总' }
    ]), { orders: [order] }),
    saveEligibility: safe,
    skipFinalSafety: true
  });
  assert.strictEqual(wrongCustomer.domain.domainCanSaveFormal, false);
  assert(wrongCustomer.blockingIssues.some((issue) => issue.code === 'CUSTOMER_SELECTION_INPUT_CONFLICT'));

  const wrongReceivable = directConfirmation(Object.assign({}, paymentDraft, {
    fields: Object.assign({}, paymentDraft.fields, {
      customerId: customer.id,
      receivableId: 'rec_other',
      receivableSelectionConfirmed: true
    })
  }), {
    initialState: Object.assign({}, state, {
      receivables: [receivable, {
        id: 'rec_other', customerId: 'cus_other', amount: 2000,
        paidAmount: 0, status: '待收', dueDate: '2026-08-01'
      }]
    }),
    saveEligibility: safe,
    skipFinalSafety: true
  });
  assert.strictEqual(wrongReceivable.domain.domainCanSaveFormal, false);
  assert(wrongReceivable.blockingIssues.some((issue) => issue.code === 'RECEIVABLE_CUSTOMER_MISMATCH'));

  const wrongOrder = directConfirmation(Object.assign({}, depositDraft, {
    fields: Object.assign({}, depositDraft.fields, {
      customerId: customer.id,
      orderId: 'ord_other',
      orderSelectionConfirmed: true
    })
  }), {
    initialState: Object.assign({}, state, {
      orders: [order, {
        id: 'ord_other', customerId: 'cus_other', productName: '礼品盒',
        status: '待生产', requiredDeliveryDate: '2026-08-01', totalAmount: 3000
      }]
    }),
    saveEligibility: safe,
    skipFinalSafety: true
  });
  assert.strictEqual(wrongOrder.domain.domainCanSaveFormal, false);
  assert(wrongOrder.blockingIssues.some((issue) => issue.code === 'ORDER_CUSTOMER_MISMATCH'));

  const overPayment = directConfirmation(Object.assign({}, paymentDraft, {
    fields: Object.assign({}, paymentDraft.fields, {
      customerId: customer.id,
      receivableId: receivable.id,
      receivableSelectionConfirmed: true,
      paymentAmount: '5000'
    })
  }), { initialState: state, saveEligibility: safe, skipFinalSafety: true });
  assert.strictEqual(overPayment.domain.domainCanSaveFormal, false);
  assert(overPayment.blockingIssues.some((issue) => issue.code === 'RECEIVABLE_PAYMENT_INVALID'));

  const nearlyPaidState = Object.assign({}, state, {
    paymentRecords: [{
      id: 'pay_old', customerId: customer.id, orderId: order.id,
      amount: 4800, kind: 'deposit'
    }]
  });
  const overDeposit = directConfirmation(Object.assign({}, depositDraft, {
    fields: Object.assign({}, depositDraft.fields, {
      customerId: customer.id,
      orderId: order.id,
      orderSelectionConfirmed: true,
      paymentAmount: '500'
    })
  }), { initialState: nearlyPaidState, saveEligibility: safe, skipFinalSafety: true });
  assert.strictEqual(overDeposit.domain.domainCanSaveFormal, false);
  assert(overDeposit.blockingIssues.some((issue) => issue.code === 'DEPOSIT_EXCEEDS_ORDER_REMAINING'));
});

test('revision和contentHash只随业务内容变化并可使后续计划失效', () => {
  const base = validAiOrder();
  const first = directConfirmation(base, { surfaceCapabilities: FULL_PAGE_CAPABILITIES });
  const differentTrace = directConfirmation(base, {
    surfaceCapabilities: HOME_QUICK_CAPABILITIES,
    traceReference: { runId: 'other-run', traceId: 'other-trace', caseId: 'other-case', startedAt: '2099-01-01' }
  });
  assert.strictEqual(first.contentHash, differentTrace.contentHash);
  const changedAmount = directConfirmation(validAiOrder({ unitPrice: '9.9' }));
  const changedItems = directConfirmation(validDeepOrder());
  const changedCustomer = directConfirmation(validAiOrder({ customerId: 'cus_selected' }));
  assert.notStrictEqual(first.contentHash, changedAmount.contentHash);
  assert.notStrictEqual(first.contentHash, changedItems.contentHash);
  assert.notStrictEqual(first.contentHash, changedCustomer.contentHash);
  const revised = directConfirmation(base, { previousConfirmation: first });
  assert.strictEqual(revised.confirmationId, first.confirmationId);
  assert.strictEqual(revised.revision, first.revision + 1);

  const candidateA = directConfirmation(base, {
    initialState: emptyBusinessState([{ id: 'cus_a', name: '王总' }])
  });
  const candidateB = directConfirmation(base, {
    initialState: emptyBusinessState([{ id: 'cus_b', name: '王总' }])
  });
  assert.notStrictEqual(candidateA.contentHash, candidateB.contentHash);
  const unlinked = directConfirmation({
    intent: 'payment', operation: 'record_payment',
    fields: { customerName: '王总', paymentAmount: '1000', allowUnlinkedPayment: true, unlinkedPaymentCustomerId: 'cus_a' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  }, { skipFinalSafety: true });
  const linked = directConfirmation({
    intent: 'payment', operation: 'record_payment',
    fields: { customerName: '王总', paymentAmount: '1000' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  }, { skipFinalSafety: true });
  assert.notStrictEqual(unlinked.contentHash, linked.contentHash);

  ['paymentMethod', 'followupDays', 'quoteDate'].forEach((key) => {
    const changed = directConfirmation(validAiOrder({ [key]: `changed-${key}` }));
    assert.notStrictEqual(first.contentHash, changed.contentHash, key);
  });
  const suggestedOperation = directConfirmation(Object.assign(validAiOrder(), {
    suggested_operation: 'create_receivable_with_payment'
  }));
  assert.notStrictEqual(first.contentHash, suggestedOperation.contentHash);

  const foreignPrevious = directConfirmation(base, {
    previousConfirmation: { schemaVersion: 'foreign-v0', confirmationId: 'foreign', revision: 99 }
  });
  assert.notStrictEqual(foreignPrevious.confirmationId, 'foreign');
  assert.strictEqual(foreignPrevious.revision, 1);
});

test('非生产mode的待整理动作不冒充真实提交且无结果仍保留严格原文', async () => {
  const local = await runRecordFlow(baseInput('还是上次的价格，王总礼品盒再做500个', {
    mode: FLOW_MODES.LOCAL_ONLY
  }), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(actionByType(local.confirmation, 'SAVE_PENDING').enabled, false);
  assert.strictEqual(local.confirmation.surface.effectiveCanCommitPending, false);

  const ai = await runRecordFlow(baseInput('王总订礼品盒500个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => validAiOrder()) });
  assert.strictEqual(actionByType(ai.confirmation, 'SAVE_PENDING').enabled, false);

  const forgedLocalCommit = directConfirmation(validAiOrder(), {
    mode: FLOW_MODES.LOCAL_ONLY,
    skipFinalSafety: true,
    saveEligibility: {
      allowed: true, domainCanSaveFormal: true, canCommitToMemory: true,
      canCommitToRealStorage: true, commitScope: 'REAL_OR_MEMORY', blockedReasons: [],
      formalSaveBlocked: false, aiResultResolved: true
    }
  });
  assert.strictEqual(forgedLocalCommit.domain.canCommitToRealStorage, false);
  assert.strictEqual(actionByType(forgedLocalCommit, 'SAVE_FORMAL').enabled, false);

  const invalid = await runRecordFlow(baseInput('  原样保留的无效模式输入  ', {
    mode: 'NOT_A_REAL_MODE'
  }), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(invalid.confirmation.originalText, '  原样保留的无效模式输入  ');
  assert.strictEqual(invalid.confirmation.status, 'NO_RESULT');
});

test('旧confirmationSummary完全由完整Confirmation派生', async () => {
  const output = await runRecordFlow(baseInput('明天提醒我催王总'), {
    aiAdapter: createNoAiAdapter()
  });
  assert.deepStrictEqual(output.confirmationSummary, deriveConfirmationSummary(output.confirmation));
  assert.strictEqual(output.trace.confirmation.confirmationId, output.confirmation.confirmationId);
  assert.strictEqual(output.trace.confirmation.contentHash, output.confirmation.contentHash);
  assert.strictEqual(output.trace.confirmation.effectiveCanSaveFormal,
    output.confirmation.surface.effectiveCanSaveFormal);
});

test('现有完整页和首页纯函数仅作事实对照且共享模型表达相同安全底线', async () => {
  const buildFull = loadPageFunction('../pages/input/input.js', 'buildConfirmationState');
  const buildHome = loadPageFunction('../pages/dashboard/dashboard.js', 'buildHomeConfirmState');
  const getFullInputConfirmationReason = loadPageFunction(
    '../pages/dashboard/dashboard.js',
    'getFullInputConfirmationReason'
  );
  const simple = await runRecordFlow(baseInput('明天提醒我催王总'), {
    aiAdapter: createNoAiAdapter()
  });
  const state = emptyBusinessState();
  const fullState = buildFull(state, simple.result, simple.result.intent, simple.result.fields);
  const homeState = buildHome(simple.result, state);
  assert.strictEqual(!fullState.disableFormalSave, simple.confirmation.domain.domainCanSaveFormal);
  assert.strictEqual(!homeState.disableQuickSave, simple.confirmation.domain.domainCanSaveFormal);

  const order = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，2026年8月1日交'), {
    aiAdapter: createNoAiAdapter()
  });
  const fullOrder = buildFull(state, order.result, order.result.intent, order.result.fields);
  const homeOrder = buildHome(order.result, state);
  assert.strictEqual(!fullOrder.disableFormalSave, order.confirmation.domain.domainCanSaveFormal);
  assert.strictEqual(!homeOrder.disableQuickSave, order.confirmation.domain.domainCanSaveFormal);

  const multi = await runRecordFlow(baseInput('王总水杯100个每个5.5元，礼品盒200个每个3元，明天交', {
    mode: FLOW_MODES.AI_ONLY,
    reviewMode: 'deep',
    surfaceCapabilities: HOME_QUICK_CAPABILITIES
  }), { aiAdapter: createFakeAiAdapter(() => validDeepOrder()) });
  const homeMulti = buildHome(multi.result, state);
  assert.strictEqual(homeMulti.showContinueInput, true);
  assert.strictEqual(multi.confirmation.surface.requiresFullPage, true);
  assert.strictEqual(multi.confirmation.items.length, 2);

  const financialResult = {
    intent: 'payment',
    operation: 'record_payment',
    suggested_operation: 'create_receivable_with_payment',
    fields: { customerName: '王总', paymentAmount: '2000' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  };
  const homeFinancialReason = getFullInputConfirmationReason(financialResult);
  const financialConfirmation = directConfirmation(financialResult, {
    skipFinalSafety: true,
    saveEligibility: {
      allowed: true, domainCanSaveFormal: true, canCommitToMemory: true,
      canCommitToRealStorage: true, commitScope: 'REAL_OR_MEMORY', blockedReasons: [],
      formalSaveBlocked: false, aiResultResolved: true
    },
    surfaceCapabilities: HOME_QUICK_CAPABILITIES
  });
  assert(homeFinancialReason);
  assert.strictEqual(financialConfirmation.surface.requiresFullPage, true);

  const missingCustomer = applyFinalParseSafety(validAiOrder({ customerName: '' }, {
    missing_fields: ['customerName']
  }));
  const fullMissing = buildFull(state, missingCustomer, missingCustomer.intent, missingCustomer.fields);
  const homeMissing = buildHome(missingCustomer, state);
  const missingConfirmation = directConfirmation(missingCustomer, { skipFinalSafety: true });
  assert.strictEqual(missingConfirmation.domain.domainCanSaveFormal, false);
  assert.strictEqual(fullMissing.disableFormalSave, true);
  assert.strictEqual(homeMissing.disableQuickSave, true);

  const pending = await runRecordFlow(baseInput('还是上次的价格，王总礼品盒再做500个'), {
    aiAdapter: createNoAiAdapter()
  });
  const fullPending = buildFull(state, pending.result, pending.result.intent, pending.result.fields);
  const homePending = buildHome(pending.result, state);
  assert.strictEqual(pending.confirmation.domain.domainCanSaveFormal, false);
  assert.strictEqual(fullPending.disableFormalSave, true);
  assert.strictEqual(homePending.disableQuickSave, true);

  const failed = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交'), {
    aiAdapter: createFakeAiAdapter(() => { const error = new Error('failed'); error.code = 'AI_PROVIDER_FAILED'; throw error; })
  });
  const fullFailed = buildFull(state, failed.result, failed.result.intent, failed.result.fields);
  const homeFailed = buildHome(failed.result, state);
  assert.strictEqual(failed.confirmation.domain.domainCanSaveFormal, false);
  assert.strictEqual(fullFailed.disableFormalSave, true);
  assert.strictEqual(homeFailed.disableQuickSave, true);
});

test('Confirmation构建与共享编排不写Storage也不改变initialState', async () => {
  const state = emptyBusinessState([{ id: 'cus_1', name: '王总' }]);
  const before = JSON.stringify(state);
  let storageWrites = 0;
  global.wx = { setStorageSync() { storageWrites += 1; } };
  const output = await runRecordFlow(baseInput('明天提醒我催王总', {
    initialState: state,
    surfaceCapabilities: HEADLESS_TEST_CAPABILITIES
  }), { aiAdapter: createNoAiAdapter() });
  delete global.wx;
  assert(output.confirmation);
  assert.strictEqual(storageWrites, 0);
  assert.strictEqual(JSON.stringify(state), before);
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
  console.log(`Phase 1D shared core tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
