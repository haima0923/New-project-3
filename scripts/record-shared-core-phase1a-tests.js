const assert = require('assert');
const crypto = require('crypto');
const {
  ADOPTION_STATUSES,
  AI_OUTCOMES,
  AI_REQUEST_STATUSES,
  EXECUTION_PATHS,
  FLOW_MODES,
  LOCAL_SAFETY_STATUSES,
  PRODUCTION_ROUTES,
  PROVIDER_KINDS,
  TRACE_SCHEMA_VERSION,
  normalizeAiOutcome,
  normalizeExecutionPath,
  normalizeProductionRoute,
  normalizeProviderKind,
  normalizeRecordFlowErrorCode,
  normalizeSafetyStatus
} = require('../utils/record-flow-contract');
const {
  createFakeAiAdapter,
  createMockAiAdapter,
  createNoAiAdapter,
  createReplayAiAdapter,
  runRecordFlow
} = require('../utils/record-flow-core');
const { createExistingHybridAiAdapter } = require('../utils/record-flow-ai-adapters');
const {
  parseHybridInput
} = require('../utils/ai-parser');
const { prewarmAiAuth } = require('../utils/api-client');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { isFormalReady } = require('../utils/business');

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

function toLegacyPayload(input) {
  return {
    text: input.extractedText || input.originalText,
    rawText: input.originalText,
    extractedText: input.extractedText || '',
    source: input.inputSource === 'chat' ? 'paste' : input.inputSource,
    context: input.context || 'home',
    reviewMode: input.reviewMode || 'standard',
    businessDate: input.businessDate,
    businessTimezone: input.businessTimezone,
    state: JSON.parse(JSON.stringify(input.initialState || {})),
    rawMessages: JSON.parse(JSON.stringify(input.rawMessages || [])),
    pasteMeta: input.pasteMeta || null
  };
}

async function withLegacyFakeWechat(aiResponse, run, requestCapture) {
  const oldWx = global.wx;
  const oldGetApp = global.getApp;
  const storage = {};
  global.getApp = () => ({ globalData: {
    apiBaseUrl: 'https://phase1a-legacy.test',
    aiAuthEnabled: true,
    aiParseEndpoint: '/api/ai/parse'
  } });
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    removeStorageSync(key) { delete storage[key]; },
    login(options) { options.success({ code: 'phase1a-login-code' }); },
    request(options) {
      if (options.url.endsWith('/api/auth/wechat-login')) {
        options.success({ statusCode: 200, data: { token: 'phase1a-test-token', expiresAt: '2099-01-01T00:00:00.000Z' } });
        return;
      }
      if (aiResponse instanceof Error) {
        options.fail({ errMsg: aiResponse.code === 'AI_TOTAL_TIMEOUT' ? 'request:fail timeout' : 'request:fail network' });
        return;
      }
      if (Array.isArray(requestCapture)) requestCapture.push(JSON.parse(JSON.stringify(options.data || {})));
      options.success({ statusCode: 200, data: aiResponse });
    }
  };
  try {
    await prewarmAiAuth();
    return await run();
  } finally {
    if (oldWx === undefined) delete global.wx;
    else global.wx = oldWx;
    if (oldGetApp === undefined) delete global.getApp;
    else global.getApp = oldGetApp;
  }
}

async function oldFlowFromOriginal(input, aiResponse) {
  const run = () => parseHybridInput(toLegacyPayload(input)).then(applyFinalParseSafety);
  return aiResponse === undefined ? run() : withLegacyFakeWechat(aiResponse, run);
}

function comparable(result) {
  return {
    intent: result.intent,
    fields: result.fields,
    items: (result.fields || {}).items || [],
    missing_fields: result.missing_fields || [],
    low_confidence_fields: result.low_confidence_fields || [],
    field_conflicts: result.field_conflicts || [],
    safety: (result.final_parse_safety || {}).status || '',
    productionRoute: (result.parse_route || {}).decision || '',
    aiOutcome: (result.ai_fallback || {}).status || '',
    formal_save_blocked: Boolean(result.formal_save_blocked),
    canSaveFormal: isFormalReady(result),
    originalText: result.original_text
  };
}

function stableComparableForBaseline(result) {
  const value = comparable(result);
  delete value.canSaveFormal;
  if (value.fields) delete value.fields.quoteDate;
  function sortKeys(current) {
    if (Array.isArray(current)) return current.map(sortKeys);
    if (!current || typeof current !== 'object') return current;
    return Object.keys(current).sort().reduce((output, key) => {
      output[key] = sortKeys(current[key]);
      return output;
    }, {});
  }
  return sortKeys(value);
}

function baselineComparableHash(result) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableComparableForBaseline(result)))
    .digest('hex');
}

function assertEquivalent(oldResult, newOutput, label) {
  const actual = comparable(newOutput.result);
  const expected = comparable(oldResult);
  assert.deepStrictEqual(actual, expected, `${label} 新旧关键结果必须等价`);
  assert.strictEqual(newOutput.result.originalText, newOutput.trace.input.originalText, `${label} 严格原文应一致`);
  assert.strictEqual(newOutput.saveEligibility.allowed, expected.canSaveFormal, `${label} 保存资格必须沿用旧闸门`);
}

const validStandardResult = {
  provider: 'server',
  model: 'fake-standard-model',
  intent: 'order',
  fields: {
    customerName: '王总',
    productName: '水杯',
    quantity: '5',
    unit: '个',
    unitPrice: '5.5',
    priceUnit: '个',
    remark: 'PHASE1A_STANDARD_UNIQUE'
  },
  field_evidence: {
    customerName: ['王总'],
    productName: ['水悲'],
    quantity: ['5个'],
    unitPrice: ['五块五']
  },
  missing_fields: [],
  low_confidence_fields: [],
  field_conflicts: []
};

const validDeepResult = {
  provider: 'server',
  model: 'fake-deep-model',
  intent: 'order',
  fields: {
    customerName: '王总',
    productName: '水杯',
    quantity: '100',
    unit: '个',
    unitPrice: '5.5',
    priceUnit: '个',
    items: [
      { productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', priceUnit: '个' },
      { productName: '礼品盒', quantity: '200', unit: '个', unitPrice: '3', priceUnit: '个' }
    ]
  },
  field_evidence: {
    customerName: ['王总'],
    items: ['水杯100个；礼品盒200个']
  },
  missing_fields: [],
  low_confidence_fields: [],
  field_conflicts: []
};

const validFormallyReadyStandardResult = Object.assign({}, validStandardResult, {
  fields: Object.assign({}, validStandardResult.fields, { productName: '水悲' }),
  field_evidence: Object.assign({}, validStandardResult.field_evidence, { productName: ['水悲'] })
});

test('状态枚举兼容旧值且未知值不降级为安全值', () => {
  assert.strictEqual(normalizeProductionRoute('local'), PRODUCTION_ROUTES.LOCAL);
  assert.strictEqual(normalizeProductionRoute('AI_DEEP'), PRODUCTION_ROUTES.AI_DEEP);
  assert.strictEqual(normalizeProductionRoute('totally-new-route'), PRODUCTION_ROUTES.UNKNOWN);
  assert.strictEqual(normalizeExecutionPath('local'), EXECUTION_PATHS.PRODUCTION_LOCAL);
  assert.strictEqual(normalizeExecutionPath('pending'), EXECUTION_PATHS.PRODUCTION_PENDING);
  assert.strictEqual(normalizeExecutionPath('ai_standard'), EXECUTION_PATHS.PRODUCTION_STANDARD);
  assert.strictEqual(normalizeExecutionPath('ai_deep'), EXECUTION_PATHS.PRODUCTION_DEEP);
  assert.strictEqual(normalizeAiOutcome('mock_used'), AI_OUTCOMES.MOCK_USED);
  assert.strictEqual(normalizeAiOutcome('AI_RESPONSE_EMPTY_BUSINESS'), AI_OUTCOMES.EMPTY_BUSINESS_RESULT);
  assert.strictEqual(normalizeSafetyStatus('SAFE_LOCAL'), LOCAL_SAFETY_STATUSES.SAFE_LOCAL);
  assert.strictEqual(normalizeSafetyStatus('maybe-safe'), LOCAL_SAFETY_STATUSES.UNKNOWN);
  assert.strictEqual(normalizeRecordFlowErrorCode('AI_TOTAL_TIMEOUT'), 'AI_TIMEOUT');
  assert.strictEqual(normalizeRecordFlowErrorCode('AI_DEEP_TIMEOUT'), 'AI_TIMEOUT');
  assert.strictEqual(normalizeRecordFlowErrorCode('AI_PROVIDER_TIMEOUT'), 'AI_TIMEOUT');
  assert.strictEqual(normalizeRecordFlowErrorCode('NETWORK_ERROR'), 'AI_NETWORK_ERROR');
  assert.strictEqual(normalizeRecordFlowErrorCode('NETWORK_REQUEST_FAILED'), 'AI_NETWORK_ERROR');
  assert.strictEqual(normalizeRecordFlowErrorCode('AUTH_SESSION_EXPIRED'), 'AUTH_REQUIRED');
  assert.strictEqual(normalizeRecordFlowErrorCode('AUTH_SESSION_NOT_READY'), 'AUTH_REQUIRED');
  assert.strictEqual(normalizeRecordFlowErrorCode('AI_CALL_FAILED'), 'AI_PROVIDER_FAILED');
});

test('providerKind只能来自可信adapter枚举，响应标签不能伪造REAL', () => {
  assert.strictEqual(normalizeProviderKind('REAL'), PROVIDER_KINDS.REAL);
  assert.strictEqual(normalizeProviderKind('mock'), PROVIDER_KINDS.MOCK);
  assert.strictEqual(normalizeProviderKind('fake'), PROVIDER_KINDS.FAKE);
  assert.strictEqual(normalizeProviderKind('server'), PROVIDER_KINDS.UNKNOWN);
  assert.strictEqual(normalizeProviderKind('success'), PROVIDER_KINDS.UNKNOWN);
});

test('fake工厂和未注册adapter都不能伪造REAL身份', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const fake = createFakeAiAdapter(() => validStandardResult, { providerKind: PROVIDER_KINDS.REAL });
  const fakeOutput = await runRecordFlow(input, { aiAdapter: fake });
  assert.strictEqual(fakeOutput.trace.ai.providerKind, PROVIDER_KINDS.FAKE);
  assert.strictEqual(fakeOutput.saveEligibility.canCommitToRealStorage, false);

  const forged = {
    descriptor: { providerKind: PROVIDER_KINDS.REAL, provider: 'forged' },
    execute: async () => ({ rawResult: validStandardResult })
  };
  const forgedOutput = await runRecordFlow(input, { aiAdapter: forged });
  assert.strictEqual(forgedOutput.trace.ai.providerKind, PROVIDER_KINDS.UNKNOWN);
  assert.strictEqual(forgedOutput.saveEligibility.canCommitToRealStorage, false);
});

test('Phase 1C启用LOCAL_ONLY和AI_ONLY后仍不会偷换成生产结果', async () => {
  const localOnly = await runRecordFlow(baseInput('王总订水杯100个', {
    mode: FLOW_MODES.LOCAL_ONLY
  }), { aiAdapter: createNoAiAdapter() });
  assert(localOnly.result);
  assert.strictEqual(localOnly.resultScope, 'LOCAL_ONLY_RESULT');
  assert.strictEqual(localOnly.trace.routing.executionPath, EXECUTION_PATHS.LOCAL_ONLY);
  assert.strictEqual(localOnly.eligibility.productionEligibilityResolved, false);

  const aiOnly = await runRecordFlow(baseInput('王总订水杯100个', {
    mode: FLOW_MODES.AI_ONLY
  }));
  assert(aiOnly.result);
  assert.strictEqual(aiOnly.resultScope, 'AI_ONLY_RESULT');
  assert.strictEqual(aiOnly.trace.routing.executionPath, EXECUTION_PATHS.AI_ONLY_STANDARD);
  assert.strictEqual(aiOnly.errors[0].code, 'AI_ADAPTER_REQUIRED');
  assert.strictEqual(aiOnly.eligibility.productionEligibilityResolved, false);
});

test('trace严格保留原文、可序列化、脱敏且运行间隔离', async () => {
  const originalText = '  王总订水杯100个\n明天交  ';
  const first = await runRecordFlow(baseInput(originalText, {
    runId: 'trace-run-1',
    initialState: { apiKey: 'super-secret-value' }
  }), { aiAdapter: createNoAiAdapter() });
  const second = await runRecordFlow(baseInput('明天提醒我催王总', { runId: 'trace-run-2' }), {
    aiAdapter: createNoAiAdapter()
  });
  assert.strictEqual(first.trace.schemaVersion, TRACE_SCHEMA_VERSION);
  assert.strictEqual(first.trace.input.originalText, originalText);
  assert.notStrictEqual(first.trace.input.originalText, first.trace.input.normalizedText);
  assert.notStrictEqual(first.trace.runId, second.trace.runId);
  first.trace.errors.push({ code: 'TEST_ONLY' });
  assert.strictEqual(second.trace.errors.length, 0);
  const serialized = JSON.stringify(first.trace);
  assert(serialized.includes('trace-run-1'));
  assert(!serialized.includes('super-secret-value'));
  assert(!serialized.includes('_startedAtMs'));
  assert(first.trace.timing.startedAt && first.trace.timing.finishedAt);
  assert(Array.isArray(first.trace.errors) && Array.isArray(first.trace.warnings));
  assert.strictEqual(first.trace.dataHandling.persistencePolicy, 'MEMORY_ONLY');
  assert.strictEqual(first.trace.dataHandling.mustRedactBeforePersistence, true);
});

test('trace真实经过的AI原始凭证字段和错误文字会脱敏', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const rawWithSecret = Object.assign({}, validStandardResult, {
    metadata: {
      'x-api-key': 'raw-secret-value',
      clientSecret: 'client-secret-value'
    }
  });
  const output = await runRecordFlow(input, { aiAdapter: createFakeAiAdapter(() => rawWithSecret) });
  const serialized = JSON.stringify(output.trace);
  assert(!serialized.includes('raw-secret-value'));
  assert(!serialized.includes('client-secret-value'));
  assert(serialized.includes('[REDACTED]'));

  const failed = await runRecordFlow(input, { aiAdapter: createFakeAiAdapter(() => {
    const error = new Error('Authorization: Bearer secret-bearer-token');
    error.code = 'AI_NETWORK_ERROR';
    throw error;
  }) });
  assert(!JSON.stringify(failed.trace).includes('secret-bearer-token'));
});

test('未知inputSource和context会fail closed并保留raw值', async () => {
  const unknownSource = await runRecordFlow(baseInput('王总订水杯100个', { inputSource: 'desktop-magic' }));
  assert.strictEqual(unknownSource.errors[0].code, 'INPUT_INVALID');
  assert.strictEqual(unknownSource.trace.inputSource, 'unknown');
  assert.strictEqual(unknownSource.trace.inputSourceRaw, 'desktop-magic');
  assert.strictEqual(unknownSource.confirmationSummary.canCommitToMemory, false);
  assert.strictEqual(unknownSource.confirmationSummary.canCommitToRealStorage, false);
  assert.strictEqual(unknownSource.confirmationSummary.commitScope, 'BLOCKED');
  const unknownContext = await runRecordFlow(baseInput('王总订水杯100个', { context: 'secret-page' }));
  assert.strictEqual(unknownContext.errors[0].code, 'INPUT_INVALID');
  assert.strictEqual(unknownContext.trace.contextRaw, 'secret-page');
  assert.strictEqual(unknownContext.confirmationSummary.commitScope, 'BLOCKED');
});

test('local路径从原文调用真实parser且AI调用0次', async () => {
  const input = baseInput('王总订礼品盒500个，单价3.8元，下周五交');
  const noAi = createNoAiAdapter();
  const output = await runRecordFlow(input, { aiAdapter: noAi });
  assert.strictEqual(output.trace.routing.productionRoute, PRODUCTION_ROUTES.LOCAL);
  assert.strictEqual(output.trace.routing.executionPath, EXECUTION_PATHS.PRODUCTION_LOCAL);
  assert.strictEqual(output.trace.ai.requested, false);
  assert.strictEqual(noAi.getCallCount(), 0);
  assert.strictEqual(output.result.intent, 'order');
  assert.strictEqual(output.result.originalText, input.originalText);
  assertEquivalent(await oldFlowFromOriginal(input), output, '简单订单');
});

test('pending复杂内容保留深度核对入口且不会自动调用AI', async () => {
  const cases = [
    baseInput('王总水杯100个，5块5一个，改成后天交'),
    baseInput('王总还欠5000元'),
    baseInput('还是上次的价格，王总礼品盒再做500个'),
    baseInput('[王总] 水杯按上次做\n[我] 那批月底交', {
      inputSource: 'chat',
      extractedText: '王总水杯按上次做，那批月底交',
      rawMessages: [{ sender: '王总', text: '水杯按上次做' }, { sender: '我', text: '那批月底交' }]
    })
  ];
  for (const input of cases) {
    const noAi = createNoAiAdapter();
    const output = await runRecordFlow(input, { aiAdapter: noAi });
    assert.strictEqual(output.trace.routing.productionRoute, PRODUCTION_ROUTES.PENDING);
    assert.strictEqual(output.trace.routing.executionPath, EXECUTION_PATHS.PRODUCTION_PENDING);
    assert.strictEqual(output.trace.ai.requested, false);
    assert.strictEqual(noAi.getCallCount(), 0);
    assert.strictEqual(output.saveEligibility.allowed, false);
  }
});

test('standard fake AI只调用一次并沿用现有合并逻辑', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const adapter = createFakeAiAdapter(() => validStandardResult);
  const output = await runRecordFlow(input, { aiAdapter: adapter });
  assert.strictEqual(output.trace.routing.productionRoute, PRODUCTION_ROUTES.AI_STANDARD);
  assert.strictEqual(output.trace.routing.executionPath, EXECUTION_PATHS.PRODUCTION_STANDARD);
  assert.strictEqual(adapter.getCallCount(), 1);
  assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.FAKE);
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.USED);
  assert.strictEqual(output.trace.ai.requestStatus, AI_REQUEST_STATUSES.SUCCEEDED);
  assert.strictEqual(output.trace.ai.requiredByRoute, true);
  assert.strictEqual(output.trace.ai.adapterInvoked, true);
  assert.strictEqual(output.trace.ai.requestStarted, true);
  assert.strictEqual(output.trace.ai.responseReceived, true);
  assert.strictEqual(output.trace.merge.adoptionStatus, ADOPTION_STATUSES.NOT_APPLICABLE);
  assert.strictEqual(output.trace.merge.adoptionStatusResolved, false);
  assert.strictEqual(output.result.fields.remark, 'PHASE1A_STANDARD_UNIQUE');
  assert.deepStrictEqual(output.trace.ai.rawResult, validStandardResult);
  assert.strictEqual(output.trace.ai.normalizedResult, null);
  assert.strictEqual(output.trace.ai.normalizationAvailable, false);
  assert.strictEqual(output.saveEligibility.commitScope, 'BLOCKED');
  assert.strictEqual(output.saveEligibility.canCommitToRealStorage, false);
  assertEquivalent(await oldFlowFromOriginal(input, validStandardResult), output, 'standard AI');
});

test('adapter只收到最小请求且不能修改核心本地草稿或initialState', async () => {
  const initialState = { customers: [{ id: 'secret-customer', name: '不应整库传入' }], orders: [] };
  const before = JSON.stringify(initialState);
  let requestKeys = [];
  const adapter = createFakeAiAdapter((request) => {
    requestKeys = Object.keys(request);
    assert(!Object.prototype.hasOwnProperty.call(request, 'initialState'));
    assert(!Object.prototype.hasOwnProperty.call(request, 'preparedStage'));
    assert(!Object.prototype.hasOwnProperty.call(request, 'legacyPayload'));
    request.localDraft.fields.customerName = '被adapter篡改';
    return validStandardResult;
  });
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice', initialState
  }), { aiAdapter: adapter });
  assert(requestKeys.includes('localDraft') && requestKeys.includes('businessContext'));
  assert.strictEqual(JSON.stringify(initialState), before);
  assert.strictEqual(output.trace.local.result.fields.customerName, '王总');
  assert.notStrictEqual(output.result.fields.customerName, '被adapter篡改');
});

test('deep fake AI只在reviewMode=deep执行并保留多商品', async () => {
  const input = baseInput('王总水杯100个5块5一个，礼品盒200个3块一个，改成后天交', { reviewMode: 'deep' });
  const adapter = createFakeAiAdapter((context) => {
    assert.strictEqual(context.reviewMode, 'deep');
    return validDeepResult;
  });
  const output = await runRecordFlow(input, { aiAdapter: adapter });
  assert.strictEqual(output.trace.routing.productionRoute, PRODUCTION_ROUTES.AI_DEEP);
  assert.strictEqual(output.trace.routing.executionPath, EXECUTION_PATHS.PRODUCTION_DEEP);
  assert.strictEqual(adapter.getCallCount(), 1);
  assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.FAKE);
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.USED);
  assert.strictEqual(output.result.fields.items.length, 2);
  assertEquivalent(await oldFlowFromOriginal(input, validDeepResult), output, 'deep AI');
});

test('聊天deep路径保留pasteMeta消息、顺序和选择结果', async () => {
  const pasteMeta = {
    rawMessages: [
      { index: 0, speaker: '王总', time: '', content: '水杯100个，五块一个' },
      { index: 1, speaker: '我', time: '', content: '礼品盒200个，三块一个，后天交' }
    ],
    selectedMessages: [0, 1],
    structuredDraft: { customerName: '王总' }
  };
  let captured;
  const adapter = createFakeAiAdapter((request) => {
    captured = request;
    return validDeepResult;
  });
  const input = baseInput('[王总] 水杯100个，五块一个\n[我] 礼品盒200个，三块一个，后天交', {
    inputSource: 'chat',
    extractedText: '王总水杯100个五块一个，礼品盒200个三块一个，后天交',
    reviewMode: 'deep',
    pasteMeta
  });
  const output = await runRecordFlow(input, { aiAdapter: adapter });
  assert.strictEqual(output.trace.routing.executionPath, EXECUTION_PATHS.PRODUCTION_DEEP);
  assert.strictEqual(adapter.getCallCount(), 1);
  assert.deepStrictEqual(captured.rawMessages, pasteMeta.rawMessages);
  assert.deepStrictEqual(captured.selectedMessages, pasteMeta.selectedMessages);
  assert.deepStrictEqual(captured.pasteMeta, pasteMeta);
  assert.strictEqual(output.result.fields.items.length, 2);
});

test('现有微信adapter的离线请求保留聊天pasteMeta且不连接生产', async () => {
  const pasteMeta = {
    rawMessages: [
      { index: 0, speaker: '王总', time: '', content: '水杯100个，五块一个' },
      { index: 1, speaker: '我', time: '', content: '礼品盒200个，三块一个，2026年8月1日交' }
    ],
    selectedMessages: [0, 1]
  };
  const input = baseInput('[王总] 水杯100个，五块一个\n[我] 礼品盒200个，三块一个，2026年8月1日交', {
    inputSource: 'chat',
    extractedText: '王总水杯100个五块一个，礼品盒200个三块一个，2026年8月1日交',
    reviewMode: 'deep',
    pasteMeta
  });
  const captures = [];
  const output = await withLegacyFakeWechat(validDeepResult, () => runRecordFlow(input, {
    aiAdapter: createExistingHybridAiAdapter()
  }), captures);
  assert.strictEqual(captures.length, 1);
  assert.deepStrictEqual(captures[0].rawMessages, pasteMeta.rawMessages);
  assert.deepStrictEqual(captures[0].pasteMeta, pasteMeta);
  assert.strictEqual(captures[0].businessDate, '2026-07-22');
  assert.strictEqual(captures[0].businessTimezone, 'Asia/Shanghai');
  assert.strictEqual(captures[0].requestId, output.trace.ai.requestId);
  assert(!Object.prototype.hasOwnProperty.call(captures[0], 'nowInstant'), '仅固定businessDate时不得伪造精确nowInstant');
  assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.REAL);
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.USED);
  assert.strictEqual(output.result.fields.items.length, 2);
});

test('空业务JSON在standard和deep均保持P0阻断', async () => {
  const emptyResults = [
    {},
    { fields: {} },
    { intent: '' },
    { intent: 'unknown', fields: {} },
    { items: [] },
    { provider: 'server', model: 'metadata-only' },
    { missing_fields: [], low_confidence_fields: [], field_conflicts: [] },
    { fields: { customerName: ' ', amount: '' } }
  ];
  const routes = [
    baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' }),
    baseInput('王总水杯100个5块5一个，礼品盒200个3块一个，改成后天交', { reviewMode: 'deep' })
  ];
  for (const input of routes) {
    for (const empty of emptyResults) {
      const adapter = createFakeAiAdapter(() => empty);
      const output = await runRecordFlow(input, { aiAdapter: adapter });
      assert.strictEqual(adapter.getCallCount(), 1);
      assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.EMPTY_BUSINESS_RESULT);
      assert.strictEqual(output.trace.ai.requestStatus, AI_REQUEST_STATUSES.SUCCEEDED);
      assert.strictEqual(output.trace.ai.responseReceived, true);
      assert.strictEqual(output.trace.ai.businessResultValid, false);
      assert.notStrictEqual((output.result.ai_fallback || {}).status, 'used');
      assert.strictEqual(output.saveEligibility.allowed, false);
      assert.strictEqual(output.confirmationSummary.canSaveFormal, false);
      assert.strictEqual(output.result.originalText, input.originalText);
    }
  }
});

test('有效不确定、明确不记录和缺字段结果不会被误判为空', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const validSafetyResults = [
    { intent: 'unknown', decision: 'needs_user_confirm', reason: '信息不足，需要老板确认客户', missing_fields: ['customerName'] },
    { intent: 'unknown', no_record: true, decision: 'no_record', reason: '这不是一笔可记录业务' },
    { intent: 'order', fields: { productName: '水杯' }, missing_fields: ['customerName', 'quantity'] }
  ];
  for (const aiResult of validSafetyResults) {
    const output = await runRecordFlow(input, { aiAdapter: createFakeAiAdapter(() => aiResult) });
    assert.strictEqual(output.trace.ai.businessResultValid, true);
    assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.RETURNED_UNCERTAIN);
    assert.strictEqual(output.trace.merge.adoptionStatus, ADOPTION_STATUSES.NOT_ADOPTED);
    assert.strictEqual(output.saveEligibility.allowed, false);
    assert.notStrictEqual(output.trace.ai.outcome, AI_OUTCOMES.EMPTY_BUSINESS_RESULT);
  }
});

test('hybridResult包装不能绕过统一空业务P0检查', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const forged = {
    hybridResult: {
      intent: 'order',
      fields: { customerName: '王总', productName: '水悲', quantity: '5' },
      ai_fallback: { status: 'used', attempted: true, business_result_valid: true }
    }
  };
  const output = await runRecordFlow(input, { aiAdapter: createFakeAiAdapter(() => forged) });
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.EMPTY_BUSINESS_RESULT);
  assert.notStrictEqual(output.result.ai_fallback.status, 'used');
  assert.strictEqual(output.saveEligibility.allowed, false);
});

test('失败、超时、无效响应和无endpoint不会假成功或解锁保存', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const failures = [
    { code: 'AUTH_REQUIRED', statusCode: 401, expected: AI_OUTCOMES.FAILED, canonical: 'AUTH_REQUIRED' },
    { code: 'AUTH_REQUIRED', statusCode: 403, expected: AI_OUTCOMES.FAILED, canonical: 'AUTH_REQUIRED' },
    { code: 'AUTH_SESSION_EXPIRED', expected: AI_OUTCOMES.FAILED, canonical: 'AUTH_REQUIRED' },
    { code: 'AUTH_SESSION_NOT_READY', expected: AI_OUTCOMES.FAILED, canonical: 'AUTH_REQUIRED' },
    { code: 'AI_PROVIDER_UNAVAILABLE', statusCode: 500, expected: AI_OUTCOMES.FAILED, canonical: 'AI_PROVIDER_FAILED' },
    { code: 'NETWORK_ERROR', expected: AI_OUTCOMES.FAILED, canonical: 'AI_NETWORK_ERROR' },
    { code: 'NETWORK_REQUEST_FAILED', expected: AI_OUTCOMES.FAILED, canonical: 'AI_NETWORK_ERROR' },
    { code: 'AI_TOTAL_TIMEOUT', expected: AI_OUTCOMES.TIMED_OUT, canonical: 'AI_TIMEOUT' },
    { code: 'AI_DEEP_TIMEOUT', expected: AI_OUTCOMES.TIMED_OUT, canonical: 'AI_TIMEOUT' },
    { code: 'AI_PROVIDER_TIMEOUT', expected: AI_OUTCOMES.TIMED_OUT, canonical: 'AI_TIMEOUT' },
    { code: 'AI_RESPONSE_INVALID', expected: AI_OUTCOMES.INVALID_RESPONSE, canonical: 'AI_RESPONSE_INVALID' },
    { code: '', expected: AI_OUTCOMES.FAILED, canonical: 'AI_PROVIDER_FAILED', raw: 'AI_CALL_FAILED' },
    { code: 'AI_ADAPTER_MISSING', expected: AI_OUTCOMES.SKIPPED_NO_ENDPOINT, canonical: 'AI_ADAPTER_REQUIRED', raw: 'AI_ADAPTER_REQUIRED' }
  ];
  for (const item of failures) {
    const adapter = item.code === 'AI_ADAPTER_MISSING'
      ? undefined
      : createFakeAiAdapter(() => {
        const error = new Error(item.code);
        if (item.code) error.code = item.code;
        error.statusCode = item.statusCode;
        throw error;
      });
    const output = await runRecordFlow(input, { aiAdapter: adapter });
    assert.strictEqual(output.trace.ai.outcome, item.expected, item.code);
    assert.notStrictEqual((output.result.ai_fallback || {}).status, 'used', item.code);
    assert.strictEqual(output.saveEligibility.allowed, false, item.code);
    assert.strictEqual(output.confirmationSummary.canSaveFormal, false, item.code);
    if (adapter) assert.strictEqual(adapter.getCallCount(), 1, item.code);
    else assert.strictEqual(output.trace.ai.adapterInvoked, false, item.code);
    assert.strictEqual(output.trace.ai.errorCode, item.canonical, item.code || 'no-code');
    assert.strictEqual(output.trace.ai.errorCodeRaw, item.raw || item.code, item.code || 'no-code');
  }
});

test('adapter返回的events不能改写核心已观察到的调用事实', async () => {
  const adapter = createFakeAiAdapter(() => ({
    rawResult: validStandardResult,
    events: { adapterInvoked: false, requestStarted: false, responseReceived: false }
  }));
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice'
  }), { aiAdapter: adapter });
  assert.strictEqual(adapter.getCallCount(), 1);
  assert.strictEqual(output.trace.ai.adapterInvoked, true);
  assert.strictEqual(output.trace.ai.requestStarted, true);
  assert.strictEqual(output.trace.ai.responseReceived, true);
  assert.strictEqual(output.trace.ai.requestState, AI_REQUEST_STATUSES.SUCCEEDED);
});

test('MOCK身份不能被返回JSON伪装成真实AI成功', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  const adapter = createMockAiAdapter(() => Object.assign({}, validStandardResult, {
    provider: 'server',
    success: true
  }), { provider: 'registered-mock' });
  const output = await runRecordFlow(input, { aiAdapter: adapter });
  assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.MOCK);
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.MOCK_USED);
  assert.strictEqual(output.result.ai_fallback.status, 'mock_used');
  assert.strictEqual(output.saveEligibility.allowed, false);
  assert.strictEqual(adapter.getCallCount(), 1);
});

test('MOCK失败和超时必须保留失败类型，不能变成MOCK_USED', async () => {
  for (const item of [
    { code: 'AI_PROVIDER_FAILED', outcome: AI_OUTCOMES.FAILED },
    { code: 'AI_TOTAL_TIMEOUT', outcome: AI_OUTCOMES.TIMED_OUT }
  ]) {
    const adapter = createMockAiAdapter(() => {
      const error = new Error(item.code);
      error.code = item.code;
      throw error;
    });
    const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
      inputSource: 'voice'
    }), { aiAdapter: adapter });
    assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.MOCK);
    assert.strictEqual(output.trace.ai.outcome, item.outcome);
    assert.notStrictEqual(output.trace.ai.outcome, AI_OUTCOMES.MOCK_USED);
    assert.strictEqual(output.saveEligibility.allowed, false);
    assert.strictEqual(adapter.getCallCount(), 1);
  }
});

test('现有微信兼容adapter在离线环境保持SKIPPED事件，不触发provider', async () => {
  const adapter = createExistingHybridAiAdapter();
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice'
  }), { aiAdapter: adapter });
  assert.strictEqual(output.trace.ai.outcome, AI_OUTCOMES.SKIPPED_NO_ENDPOINT);
  assert.strictEqual(output.trace.ai.requestState, AI_REQUEST_STATUSES.SKIPPED);
  assert.strictEqual(output.trace.ai.providerKind, PROVIDER_KINDS.REAL);
  assert.strictEqual(output.trace.ai.adapterInvoked, false);
  assert.strictEqual(output.trace.ai.requestStarted, false);
  assert.strictEqual(output.trace.ai.responseReceived, false);
  assert.strictEqual(output.trace.timing.stages.ai.status, 'SKIPPED');
  assert.strictEqual(output.trace.timing.stages.merge.status, 'SKIPPED');
  assert.strictEqual(output.saveEligibility.allowed, false);
});

test('通用调用方不能注册REAL，生产模式REPLAY不能取得保存资格', async () => {
  const input = baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' });
  assert.strictEqual(require('../utils/record-flow-core').createRegisteredAiAdapter, undefined);
  const replay = createReplayAiAdapter(async () => ({ rawResult: validFormallyReadyStandardResult }));
  const replayOutput = await runRecordFlow(input, { aiAdapter: replay });
  assert.strictEqual(replayOutput.saveEligibility.domainCanSaveFormal, false);
  assert.strictEqual(replayOutput.saveEligibility.canCommitToRealStorage, false);
  assert.strictEqual(replayOutput.saveEligibility.commitScope, 'BLOCKED');
  assert.strictEqual(replayOutput.confirmationSummary.canCommitToRealStorage, false);
  assert.strictEqual(replayOutput.confirmationSummary.commitScope, 'BLOCKED');
});

test('八类合成题的新旧入口关键结果等价', async () => {
  const timeout = new Error('timeout');
  timeout.code = 'AI_TOTAL_TIMEOUT';
  const cases = [
    { title: '简单订单', input: baseInput('王总订礼品盒500个，单价3.8元，下周五交'), expected: { intent: 'order', route: 'local', ai: 'not_requested' } },
    { title: '简单报价', input: baseInput('给李总报水杯100个，每个5元'), expected: { intent: 'quotation', route: 'local', ai: 'not_requested' } },
    { title: '待收款', input: baseInput('王总还欠5000元'), expected: { intent: 'receivable', route: 'pending', ai: 'not_requested' } },
    { title: '收款', input: baseInput('今天收到李总3000元'), expected: { intent: 'payment', route: 'pending', ai: 'not_requested' } },
    { title: '提醒', input: baseInput('明天提醒我催王总'), expected: { intent: 'todo', route: 'local', ai: 'not_requested' } },
    { title: '缺字段', input: baseInput('帮我记一笔订单'), expected: { intent: 'order', route: 'pending', ai: 'not_requested' } },
    { title: 'NO_RECORD', input: baseInput('这是一句普通闲聊'), expected: { intent: 'unknown', route: 'pending', ai: 'not_requested' } },
    { title: 'AI失败', input: baseInput('王总要订5个水悲，五块五一个，明天交', { inputSource: 'voice' }), ai: timeout, expected: { intent: 'order', route: 'ai_standard', ai: 'timed_out' } }
  ];
  for (const item of cases) {
    const adapter = item.ai
      ? createFakeAiAdapter(() => { throw item.ai; })
      : createNoAiAdapter();
    const output = await runRecordFlow(item.input, { aiAdapter: adapter });
    const oldResult = await oldFlowFromOriginal(item.input, item.ai);
    assertEquivalent(oldResult, output, item.title);
    assert.strictEqual(oldResult.intent, item.expected.intent, `${item.title} 冻结intent`);
    assert.strictEqual((oldResult.parse_route || {}).decision, item.expected.route, `${item.title} 冻结route`);
    assert.strictEqual((oldResult.ai_fallback || {}).status, item.expected.ai, `${item.title} 冻结AI状态`);
  }
});

test('起始HEAD冻结的十一类完整关键结果金样本保持不变', async () => {
  // Hashes were generated from public parseHybridInput() at the immutable Phase 1A
  // start HEAD 3608a1281d52b8bfa4594b998cbd27d33f17d563. quoteDate is omitted
  // because Phase 1B will inject the business clock; every other comparable field,
  // item, missing/low-confidence/conflict list, safety, route, AI outcome and
  // strict legacy original is covered.
  const timeout = new Error('timeout');
  timeout.code = 'AI_TOTAL_TIMEOUT';
  const cases = [
    { name: 'local_order', input: baseInput('王总订礼品盒500个，单价3.8元'), hash: '2567cce0fdab70d7156c1569e6dda131c3408e4d61539a702a6f29828f3e3675', allowed: false },
    { name: 'local_quote', input: baseInput('给李总报水杯100个，每个5元'), hash: '0c3acab97fd075a898d0753d2a89f5973c51d0d1caebb414d883b06f84182e1e', allowed: true },
    { name: 'pending_receivable', input: baseInput('王总还欠5000元'), hash: 'bfb248aa786c0d3346ad9a7cd063f31ff3ca0650aa160303aa2195fd1a744979', allowed: false },
    { name: 'pending_payment', input: baseInput('2026年8月1日收到李总3000元'), hash: '65791ab5dea3231d13950f2b9bdc0a94e35476736eb9bd867336d6d4bffa7e1e', allowed: false },
    { name: 'local_todo', input: baseInput('2026年8月1日提醒我催王总'), hash: '8c3e66ed1493a159ec3b092cc881e058ae2c29d9545b9490d06a4e17fd76d841', allowed: true },
    { name: 'missing', input: baseInput('帮我记一笔订单'), hash: '8e6e1492d86691ee14c099fcbf25de418a2ddbf14499ff09b32f5f5e73cb83fd', allowed: false },
    { name: 'no_record', input: baseInput('这是一句普通闲聊'), hash: 'b14d380a8ed093ab38313663a894de5713414e3046b08b7bddc3e5ff96ce4cfe', allowed: false },
    { name: 'standard', input: baseInput('王总要订5个水悲，五块五一个，2026年8月1日交', { inputSource: 'voice' }), ai: validStandardResult, hash: '3a4fda5db9e18b31ed7910bf3cbbe732eae5059227f31a9d65560089f00820e5', allowed: false },
    { name: 'deep', input: baseInput('王总水杯100个5块5一个，礼品盒200个3块一个，2026年8月1日交', { reviewMode: 'deep' }), ai: validDeepResult, hash: '8ab5b66e57982d64f0486c2ae2b0cf7c98bc1c21a420914e23aa4629e70293b5', allowed: false },
    { name: 'failure', input: baseInput('王总要订5个水悲，五块五一个，2026年8月1日交', { inputSource: 'voice' }), ai: timeout, hash: '6befc8f386e1911914e0dee430836a35cc3310128d7d8ba99fc45d785a94c550', allowed: false },
    { name: 'history', input: baseInput('还是上次的价格，王总礼品盒再做500个'), hash: 'def6151de27cc0d759c19f5183c18a9dc268a6f2e6d0483d576f592bffdbe099', allowed: false }
  ];
  for (const item of cases) {
    const adapter = item.ai instanceof Error
      ? createFakeAiAdapter(() => { throw item.ai; })
      : (item.ai ? createFakeAiAdapter(() => item.ai) : createNoAiAdapter());
    const output = await runRecordFlow(item.input, { aiAdapter: adapter });
    assert.strictEqual(baselineComparableHash(output.result), item.hash, `${item.name} 与起始HEAD金样本不一致`);
    assert.strictEqual(output.saveEligibility.allowed, item.allowed, `${item.name} 保存资格改变`);
  }
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
  console.log(`Phase 1A shared core tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main();
