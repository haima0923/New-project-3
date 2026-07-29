#!/usr/bin/env node

const assert = require('assert');
const {
  ADOPTION_STATUSES,
  AI_OUTCOMES,
  AI_REQUEST_STATUSES,
  EXECUTION_PATHS,
  FLOW_MODES,
  PRODUCTION_ROUTES,
  PROVIDER_KINDS,
  RESULT_SCOPES
} = require('../utils/record-flow-contract');
const {
  createFakeAiAdapter,
  createMockAiAdapter,
  createNoAiAdapter,
  createReplayAiAdapter,
  runRecordFlow
} = require('../utils/record-flow-core');

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
    fields: Object.assign({
      customerName: '王总',
      productName: '水悲',
      quantity: '5',
      unit: '个',
      unitPrice: '5.5',
      priceUnit: '个',
      dueDate: '2026-07-23',
      remark: 'PHASE1C_AI_UNIQUE'
    }, fields),
    field_evidence: {
      customerName: ['王总'],
      productName: ['水悲'],
      quantity: ['5个'],
      unitPrice: ['五块五'],
      dueDate: ['明天']
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  }, extras);
}

function validDeepOrder() {
  return validAiOrder({
    customerName: '王总',
    productName: '水杯',
    quantity: '100',
    unitPrice: '5.5',
    items: [
      { productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', priceUnit: '个' },
      { productName: '礼品盒', quantity: '200', unit: '个', unitPrice: '3', priceUnit: '个' }
    ]
  }, {
    field_evidence: {
      customerName: ['王总'],
      productName: ['水杯'],
      items: ['水杯100个；礼品盒200个']
    }
  });
}

test('mode默认兼容生产、旧小写可用且显式非法值失败', async () => {
  const defaultMode = await runRecordFlow(baseInput('明天提醒我催王总', { mode: undefined }), {
    aiAdapter: createNoAiAdapter()
  });
  assert.strictEqual(defaultMode.mode, FLOW_MODES.PRODUCTION_ROUTING);
  assert.strictEqual(defaultMode.resultScope, RESULT_SCOPES.PRODUCTION_RESULT);

  const localAlias = await runRecordFlow(baseInput('明天提醒我催王总', { mode: 'local_only' }), {
    aiAdapter: createNoAiAdapter()
  });
  assert.strictEqual(localAlias.mode, FLOW_MODES.LOCAL_ONLY);
  assert.strictEqual(localAlias.executionPath, EXECUTION_PATHS.LOCAL_ONLY);

  const invalid = await runRecordFlow(baseInput('明天提醒我催王总', { mode: 'magic_mode' }));
  assert.strictEqual(invalid.result, null);
  assert.strictEqual(invalid.errors[0].code, 'UNSUPPORTED_FLOW_MODE');
  assert.strictEqual(invalid.executionPath, EXECUTION_PATHS.NOT_EXECUTED);
});

test('LOCAL_ONLY跨LOCAL STANDARD DEEP PENDING路线始终零AI调用', async () => {
  const cases = [
    ['明天提醒我催王总', 'standard', PRODUCTION_ROUTES.LOCAL],
    ['王总要订5个水悲，五块五一个，明天交', 'standard', PRODUCTION_ROUTES.AI_STANDARD],
    ['王总水杯100个5块5一个，礼品盒200个3块一个，改成后天交', 'deep', PRODUCTION_ROUTES.AI_DEEP],
    ['还是上次的价格，王总礼品盒再做500个', 'standard', PRODUCTION_ROUTES.PENDING],
    ['王总还欠5000元', 'standard', PRODUCTION_ROUTES.LOCAL]
  ];
  for (const [text, reviewMode, expectedRoute] of cases) {
    const adapter = createNoAiAdapter();
    const output = await runRecordFlow(baseInput(text, {
      mode: FLOW_MODES.LOCAL_ONLY,
      reviewMode
    }), { aiAdapter: adapter });
    assert.strictEqual(output.productionRoute, expectedRoute, text);
    assert.strictEqual(output.executionPath, EXECUTION_PATHS.LOCAL_ONLY, text);
    assert.strictEqual(adapter.getCallCount(), 0, text);
    assert.strictEqual(output.trace.ai.adapterInvoked, false, text);
    assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.NOT_REQUESTED, text);
    assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.NONE, text);
    assert.strictEqual(output.trace.ai.requiredByProductionRoute,
      [PRODUCTION_ROUTES.AI_STANDARD, PRODUCTION_ROUTES.AI_DEEP].includes(expectedRoute), text);
    assert.strictEqual(output.trace.ai.requiredByExecutionMode, false, text);
    assert.strictEqual(output.resultScope, RESULT_SCOPES.LOCAL_ONLY_RESULT, text);
    assert.strictEqual(output.result.originalText, text, text);
  }
});

test('AI_ONLY请求不含localDraft且本地route不决定standard或deep', async () => {
  let standardRequest;
  const standard = createFakeAiAdapter((request) => {
    standardRequest = request;
    return validAiOrder();
  });
  const standardOutput = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.AI_ONLY,
    reviewMode: 'standard'
  }), { aiAdapter: standard });
  assert.strictEqual(standardOutput.productionRoute, PRODUCTION_ROUTES.LOCAL);
  assert.strictEqual(standardOutput.executionPath, EXECUTION_PATHS.AI_ONLY_STANDARD);
  assert.strictEqual(standardRequest.localDraft, null);
  assert.strictEqual(standardRequest.localDraftPolicy, 'OMIT');
  assert.strictEqual(standardRequest.routeDecision, null);
  assert.strictEqual(standardRequest.productionRoute, null);
  assert.strictEqual(standardRequest.executionPath, EXECUTION_PATHS.AI_ONLY_STANDARD);
  assert.strictEqual(standardRequest.mode, FLOW_MODES.AI_ONLY);
  assert.strictEqual(standardRequest.reviewMode, 'standard');

  let deepRequest;
  const deep = createFakeAiAdapter((request) => {
    deepRequest = request;
    return validDeepOrder();
  });
  const deepOutput = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.AI_ONLY,
    reviewMode: 'deep'
  }), { aiAdapter: deep });
  assert.strictEqual(deepOutput.productionRoute, PRODUCTION_ROUTES.LOCAL);
  assert.strictEqual(deepOutput.executionPath, EXECUTION_PATHS.AI_ONLY_DEEP);
  assert.strictEqual(deepRequest.localDraft, null);
  assert.strictEqual(deepRequest.productionRoute, null);
  assert.strictEqual(deepRequest.executionPath, EXECUTION_PATHS.AI_ONLY_DEEP);
  assert.strictEqual(deepRequest.requiredOutputShape, 'record-deep-legacy-v1');
});

test('AI_ONLY最终字段不被本地客户商品数量金额修正', async () => {
  const input = baseInput('王总订红色礼品盒500个，3.8元一个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  });
  const adapter = createFakeAiAdapter(() => validAiOrder({
    customerName: '李总',
    productName: '杯垫',
    quantity: '300',
    unitPrice: '2.5',
    dueDate: '2026-07-23'
  }, {
    field_evidence: {
      customerName: ['李总'],
      productName: ['杯垫'],
      quantity: ['300'],
      unitPrice: ['2.5'],
      dueDate: ['明天']
    }
  }));
  const output = await runRecordFlow(input, { aiAdapter: adapter });
  assert.strictEqual(output.trace.local.shadowOnly, true);
  assert.strictEqual(output.trace.local.result.fields.customerName, '王总');
  assert.notStrictEqual(output.result.fields.customerName, '王总');
  assert.strictEqual(output.result.fields.productName, '杯垫');
  assert.strictEqual(output.result.fields.quantity, '300');
  assert.strictEqual(output.result.fields.unitPrice, '2.5');
  assert.strictEqual(output.trace.merge.performed, false);
  assert.strictEqual(output.trace.merge.adoptionStatus, ADOPTION_STATUSES.NOT_APPLICABLE);
  assert.strictEqual(output.resultScope, RESULT_SCOPES.AI_ONLY_RESULT);
});

test('AI_ONLY缺客户或金额时本地明确字段也不能补入', async () => {
  const output = await runRecordFlow(baseInput('王总订礼品盒500个，3.8元一个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => ({
    intent: 'order',
    fields: { productName: '礼品盒', quantity: '500', unit: '个', dueDate: '2026-07-23' },
    missing_fields: ['customerName', 'unitPrice'],
    low_confidence_fields: [],
    field_conflicts: []
  })) });
  assert.strictEqual(output.result.fields.customerName, undefined);
  assert.strictEqual(output.result.fields.unitPrice, undefined);
  assert(output.result.missing_fields.includes('customerName'));
  assert(output.result.missing_fields.includes('unitPrice'));
  assert.strictEqual(output.saveEligibility.allowed, false);
});

test('AI_ONLY确认摘要不读取影子productionRoute的警告或深度核对状态', async () => {
  const aiResult = {
    intent: 'unknown',
    decision: 'needs_user_confirm',
    reason: 'AI需要用户确认目标记录',
    missing_fields: ['orderId']
  };
  const localRouteInput = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => aiResult) });
  const pendingRouteInput = await runRecordFlow(baseInput('还是上次的价格，王总礼品盒再做500个', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => aiResult) });
  assert.notStrictEqual(localRouteInput.productionRoute, pendingRouteInput.productionRoute);
  for (const reason of localRouteInput.trace.routing.routeReasons) {
    assert.strictEqual(localRouteInput.confirmationSummary.warnings.includes(reason), false);
  }
  for (const reason of pendingRouteInput.trace.routing.routeReasons) {
    assert.strictEqual(pendingRouteInput.confirmationSummary.warnings.includes(reason), false);
  }
  assert.strictEqual(localRouteInput.confirmationSummary.needsDeepReview, false);
  assert.strictEqual(pendingRouteInput.confirmationSummary.needsDeepReview, false);
});

test('AI_ONLY影子本地阶段失败仍按reviewMode调用AI', async () => {
  const adapter = createFakeAiAdapter(() => validAiOrder());
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    mode: FLOW_MODES.AI_ONLY,
    initialState: { unsupportedForJsonClone: BigInt(1) },
    businessContext: {}
  }), { aiAdapter: adapter });
  assert.strictEqual(output.trace.local.executed, true);
  assert.strictEqual(output.trace.local.shadowOnly, true);
  assert.strictEqual(output.trace.local.errors[0].code, 'LOCAL_PARSE_FAILED');
  assert.strictEqual(output.trace.local.errors[0].blocksFormalSave, false);
  assert.strictEqual(output.trace.local.errors[0].shadowOnly, true);
  assert.strictEqual(output.productionRoute, PRODUCTION_ROUTES.UNKNOWN);
  assert.strictEqual(output.executionPath, EXECUTION_PATHS.AI_ONLY_STANDARD);
  assert.strictEqual(adapter.getCallCount(), 1);
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.USED);
  assert.strictEqual(output.result.fields.productName, '水悲');
});

test('AI_ONLY有效不确定、NO_RECORD和deep多商品不被空结果规则误伤', async () => {
  const uncertain = await runRecordFlow(baseInput('王总那批货还是照旧', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => ({
    intent: 'unknown',
    decision: 'needs_user_confirm',
    reason: '无法确定是哪一批货',
    missing_fields: ['orderId']
  })) });
  assert.strictEqual(uncertain.trace.ai.outcome, AI_OUTCOMES.RETURNED_UNCERTAIN);
  assert.strictEqual(uncertain.saveEligibility.allowed, false);

  const noRecord = await runRecordFlow(baseInput('今天天气不错', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => ({
    intent: 'unknown',
    no_record: true,
    reason: '这不是可记录的业务内容'
  })) });
  assert.strictEqual(noRecord.trace.ai.outcome, AI_OUTCOMES.RETURNED_UNCERTAIN);
  assert.strictEqual(noRecord.result.formal_save_blocked, true);

  const deep = await runRecordFlow(baseInput('王总水杯100个，礼品盒200个', {
    mode: FLOW_MODES.AI_ONLY,
    reviewMode: 'deep'
  }), { aiAdapter: createFakeAiAdapter(() => validDeepOrder()) });
  assert.strictEqual(deep.result.fields.items.length, 2);
  assert.strictEqual(deep.executionPath, EXECUTION_PATHS.AI_ONLY_DEEP);
});

test('AI_ONLY空业务、非JSON、鉴权、服务端、网络和超时失败均不放行', async () => {
  const scenarios = [
    [{}, AI_OUTCOMES.EMPTY_BUSINESS_RESULT, 'AI_RESPONSE_EMPTY_BUSINESS'],
    ['not-json', AI_OUTCOMES.INVALID_RESPONSE, 'AI_RESPONSE_INVALID'],
    [() => { const error = new Error('timeout'); error.code = 'AI_TIMEOUT'; throw error; }, AI_OUTCOMES.TIMED_OUT, 'AI_TIMEOUT'],
    [() => { const error = new Error('unauthorized'); error.code = 'AUTH_REQUIRED'; error.statusCode = 401; throw error; }, AI_OUTCOMES.FAILED, 'AUTH_REQUIRED'],
    [{ ok: false, error: { code: 'AUTH_FORBIDDEN', message: 'forbidden', httpStatus: 403 } }, AI_OUTCOMES.FAILED, 'AUTH_FORBIDDEN'],
    [() => { const error = new Error('server failed'); error.code = 'AI_PROVIDER_FAILED'; error.statusCode = 500; throw error; }, AI_OUTCOMES.FAILED, 'AI_PROVIDER_FAILED'],
    [() => { const error = new Error('network failed'); error.code = 'AI_NETWORK_ERROR'; throw error; }, AI_OUTCOMES.FAILED, 'AI_NETWORK_ERROR']
  ];
  for (const [scenario, outcome, code] of scenarios) {
    const adapter = createFakeAiAdapter(typeof scenario === 'function' ? scenario : () => scenario);
    const output = await runRecordFlow(baseInput('王总订礼品盒500个，明天交', {
      mode: FLOW_MODES.AI_ONLY
    }), { aiAdapter: adapter });
    assert.strictEqual(adapter.getCallCount(), 1);
    assert.strictEqual(output.trace.ai.outcome, outcome);
    assert.strictEqual(output.trace.ai.errorCode, code);
    assert.notStrictEqual(output.trace.ai.outcome, AI_OUTCOMES.USED);
    assert.strictEqual(output.saveEligibility.allowed, false);
    assert.strictEqual(output.eligibility.productionEligibilityResolved, false);
  }
});

test('缺失、无身份和不支持deep的adapter明确失败且不降级', async () => {
  const missing = await runRecordFlow(baseInput('王总订礼品盒500个', {
    mode: FLOW_MODES.AI_ONLY
  }));
  assert.strictEqual(missing.errors[0].code, 'AI_ADAPTER_REQUIRED');
  assert.strictEqual(missing.trace.ai.adapterInvoked, false);

  let forgedCalls = 0;
  const forged = {
    descriptor: { providerKind: 'REAL' },
    parse() { forgedCalls += 1; return Promise.resolve({ rawResult: validAiOrder() }); }
  };
  const invalidIdentity = await runRecordFlow(baseInput('王总订礼品盒500个', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: forged });
  assert.strictEqual(invalidIdentity.errors[0].code, 'AI_ADAPTER_IDENTITY_INVALID');
  assert.strictEqual(forgedCalls, 0);
  assert.strictEqual(invalidIdentity.trace.ai.providerKind, PROVIDER_KINDS.UNKNOWN);

  const shallow = createFakeAiAdapter(() => validDeepOrder(), { supportsDeep: false });
  const unsupportedDeep = await runRecordFlow(baseInput('王总水杯100个，礼品盒200个', {
    mode: FLOW_MODES.AI_ONLY,
    reviewMode: 'deep'
  }), { aiAdapter: shallow });
  assert.strictEqual(unsupportedDeep.errors[0].code, 'AI_ADAPTER_CAPABILITY_MISSING');
  assert.strictEqual(shallow.getCallCount(), 0);
  assert.strictEqual(unsupportedDeep.executionPath, EXECUTION_PATHS.AI_ONLY_DEEP);
});

test('FAKE MOCK REPLAY身份不能被返回JSON伪造成REAL', async () => {
  const forgedPayload = Object.assign(validAiOrder(), { providerKind: 'REAL', provider: 'real-looking' });
  const fake = createFakeAiAdapter(() => forgedPayload, { provider: 'fake-source' });
  const fakeOutput = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: fake });
  assert.strictEqual(fakeOutput.trace.ai.providerKind, PROVIDER_KINDS.FAKE);
  assert.strictEqual(fakeOutput.trace.ai.outcome, AI_OUTCOMES.USED);
  assert.strictEqual(fakeOutput.saveEligibility.canCommitToRealStorage, false);

  const mock = createMockAiAdapter(() => forgedPayload);
  const mockOutput = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: mock });
  assert.strictEqual(mockOutput.trace.ai.providerKind, PROVIDER_KINDS.MOCK);
  assert.strictEqual(mockOutput.trace.ai.outcome, AI_OUTCOMES.MOCK_USED);
  assert.strictEqual(mockOutput.saveEligibility.canCommitToMemory, false);
  assert.strictEqual(mockOutput.saveEligibility.canCommitToRealStorage, false);
  assert.strictEqual(mockOutput.saveEligibility.commitScope, 'BLOCKED');
  assert.strictEqual(mockOutput.confirmationSummary.canCommitToMemory, false);

  const replay = createReplayAiAdapter(() => forgedPayload, {
    referenceMetadata: { model: 'synthetic-reference', promptVersion: 'fixture-v1' }
  });
  const replayOutput = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: replay });
  assert.strictEqual(replayOutput.trace.ai.providerKind, PROVIDER_KINDS.REPLAY);
  assert.deepStrictEqual(replayOutput.trace.ai.referenceMetadata, {
    model: 'synthetic-reference', promptVersion: 'fixture-v1'
  });
  assert.strictEqual(replayOutput.saveEligibility.canCommitToRealStorage, false);
  assert.strictEqual(replayOutput.trace.ai.latencyMs, null);
  assert.strictEqual(replayOutput.trace.ai.latencyAvailable, false);
  assert.strictEqual(replayOutput.trace.ai.latencySource, 'NOT_APPLICABLE_REPLAY');
  assert.strictEqual(replayOutput.trace.ai.countsAsRealAiCall, false);
  assert.strictEqual(replayOutput.trace.ai.costAvailable, false);
  assert.throws(() => createReplayAiAdapter(() => forgedPayload, { referenceMetadata: 'bad' }), (error) => (
    error.code === 'REPLAY_METADATA_INVALID'
  ));
});

test('模型返回对象不能伪造transport事件和adapter调用事实', async () => {
  const adapter = createFakeAiAdapter(() => ({
    rawResult: validAiOrder(),
    events: { adapterInvoked: false, requestStarted: false, responseReceived: false },
    providerKind: 'REAL'
  }));
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: adapter });
  assert.strictEqual(output.trace.ai.adapterInvoked, true);
  assert.strictEqual(output.trace.ai.requestStarted, true);
  assert.strictEqual(output.trace.ai.responseReceived, true);
  assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.FAKE);
  assert.strictEqual(adapter.getCallCount(), 1);
});

test('PRODUCTION_ROUTING继续保持local pending standard deep和P0状态', async () => {
  const localAdapter = createNoAiAdapter();
  const local = await runRecordFlow(baseInput('明天提醒我催王总'), { aiAdapter: localAdapter });
  assert.strictEqual(local.productionRoute, PRODUCTION_ROUTES.LOCAL);
  assert.strictEqual(local.executionPath, EXECUTION_PATHS.PRODUCTION_LOCAL);
  assert.strictEqual(localAdapter.getCallCount(), 0);

  const pendingAdapter = createNoAiAdapter();
  const pending = await runRecordFlow(baseInput('还是上次的价格，王总礼品盒再做500个'), {
    aiAdapter: pendingAdapter
  });
  assert.strictEqual(pending.productionRoute, PRODUCTION_ROUTES.PENDING);
  assert.strictEqual(pending.executionPath, EXECUTION_PATHS.PRODUCTION_PENDING);
  assert.strictEqual(pendingAdapter.getCallCount(), 0);

  const standardAdapter = createFakeAiAdapter(() => validAiOrder());
  const standard = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice'
  }), { aiAdapter: standardAdapter });
  assert.strictEqual(standard.productionRoute, PRODUCTION_ROUTES.AI_STANDARD);
  assert.strictEqual(standard.executionPath, EXECUTION_PATHS.PRODUCTION_STANDARD);
  assert.strictEqual(standard.trace.merge.performed, true);
  assert.strictEqual(standard.trace.merge.adoptionStatus, ADOPTION_STATUSES.NOT_APPLICABLE);
  assert.strictEqual(standard.trace.merge.adoptionStatusResolved, false);
  assert.strictEqual(standardAdapter.getCallCount(), 1);

  const deepAdapter = createFakeAiAdapter(() => validDeepOrder());
  const deep = await runRecordFlow(baseInput(
    '王总水杯100个5块5一个，礼品盒200个3块一个，改成后天交',
    { reviewMode: 'deep' }
  ), { aiAdapter: deepAdapter });
  assert.strictEqual(deep.productionRoute, PRODUCTION_ROUTES.AI_DEEP);
  assert.strictEqual(deep.executionPath, EXECUTION_PATHS.PRODUCTION_DEEP);
  assert.strictEqual(deep.result.fields.items.length, 2);

  const empty = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交'), {
    aiAdapter: createFakeAiAdapter(() => ({}))
  });
  assert.strictEqual(empty.trace.ai.outcome, AI_OUTCOMES.EMPTY_BUSINESS_RESULT);
  assert.strictEqual(empty.saveEligibility.allowed, false);

  const mock = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交'), {
    aiAdapter: createMockAiAdapter(() => validAiOrder())
  });
  assert.strictEqual(mock.trace.ai.outcome, AI_OUTCOMES.MOCK_USED);
  assert.strictEqual(mock.saveEligibility.canCommitToRealStorage, false);

  const timedOut = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交'), {
    aiAdapter: createFakeAiAdapter(() => { const error = new Error('timeout'); error.code = 'AI_TIMEOUT'; throw error; })
  });
  assert.strictEqual(timedOut.trace.ai.outcome, AI_OUTCOMES.TIMED_OUT);
  assert.strictEqual(timedOut.saveEligibility.allowed, false);

  const unauthorized = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交'), {
    aiAdapter: createFakeAiAdapter(() => {
      const error = new Error('unauthorized');
      error.code = 'AUTH_REQUIRED';
      error.statusCode = 401;
      throw error;
    })
  });
  assert.strictEqual(unauthorized.trace.ai.outcome, AI_OUTCOMES.FAILED);
  assert.strictEqual(unauthorized.trace.ai.errorCode, 'AUTH_REQUIRED');

  const chatPending = await runRecordFlow(baseInput('[王总] 水杯按上次做\n[我] 那批月底交', {
    inputSource: 'chat',
    extractedText: '王总水杯按上次做，那批月底交',
    rawMessages: [{ speaker: '王总', content: '水杯按上次做' }, { speaker: '我', content: '那批月底交' }]
  }), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(chatPending.productionRoute, PRODUCTION_ROUTES.PENDING);
  assert.strictEqual(chatPending.trace.ai.adapterCallCount, 0);
});

test('三种模式resultScope和eligibility含义互不混淆', async () => {
  const local = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.LOCAL_ONLY
  }), { aiAdapter: createNoAiAdapter() });
  assert.strictEqual(local.resultScope, RESULT_SCOPES.LOCAL_ONLY_RESULT);
  assert(local.results.localResult);
  assert.strictEqual(local.results.aiOnlyResult, null);

  const ai = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: createFakeAiAdapter(() => validAiOrder()) });
  assert.strictEqual(ai.resultScope, RESULT_SCOPES.AI_ONLY_RESULT);
  assert(ai.results.aiOnlyResult);
  assert.strictEqual(ai.results.productionResult, null);
  assert.strictEqual(ai.eligibility.productionEligibilityResolved, false);

  const production = await runRecordFlow(baseInput('明天提醒我催王总'), {
    aiAdapter: createNoAiAdapter()
  });
  assert.strictEqual(production.resultScope, RESULT_SCOPES.PRODUCTION_RESULT);
  assert(production.results.productionResult);
  assert.strictEqual(production.eligibility.productionEligibilityResolved, true);
});

test('连续运行三种模式不会共享trace、结果或adapter计数', async () => {
  const localAdapter = createNoAiAdapter();
  const aiAdapter = createFakeAiAdapter(() => validAiOrder());
  const productionAdapter = createNoAiAdapter();
  const local = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.LOCAL_ONLY,
    caseId: 'phase1c-local'
  }), { aiAdapter: localAdapter });
  const ai = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.AI_ONLY,
    caseId: 'phase1c-ai'
  }), { aiAdapter });
  const production = await runRecordFlow(baseInput('明天提醒我催王总', {
    caseId: 'phase1c-production'
  }), { aiAdapter: productionAdapter });
  assert.strictEqual(localAdapter.getCallCount(), 0);
  assert.strictEqual(aiAdapter.getCallCount(), 1);
  assert.strictEqual(productionAdapter.getCallCount(), 0);
  assert.strictEqual(local.trace.ai.adapterCallCount, 0);
  assert.strictEqual(ai.trace.ai.adapterCallCount, 1);
  assert.strictEqual(production.trace.ai.adapterCallCount, 0);
  assert.notStrictEqual(local.trace.runId, ai.trace.runId);
  assert.notStrictEqual(ai.trace.runId, production.trace.runId);
  local.trace.errors.push({ code: 'TEST_MUTATION' });
  assert.strictEqual(ai.trace.errors.some((item) => item.code === 'TEST_MUTATION'), false);
  assert.strictEqual(production.mode, FLOW_MODES.PRODUCTION_ROUTING);
});

test('复用同一个adapter跨三种模式仍只在AI_ONLY调用一次', async () => {
  const shared = createFakeAiAdapter(() => validAiOrder());
  const local = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.LOCAL_ONLY
  }), { aiAdapter: shared });
  const ai = await runRecordFlow(baseInput('明天提醒我催王总', {
    mode: FLOW_MODES.AI_ONLY
  }), { aiAdapter: shared });
  const production = await runRecordFlow(baseInput('明天提醒我催王总'), { aiAdapter: shared });
  assert.strictEqual(shared.getCallCount(), 1);
  assert.strictEqual(local.trace.ai.adapterCallCount, 0);
  assert.strictEqual(ai.trace.ai.adapterCallCount, 1);
  assert.strictEqual(production.trace.ai.adapterCallCount, 0);
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
  console.log(`Phase 1C shared core tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
