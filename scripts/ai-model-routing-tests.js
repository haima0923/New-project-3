const assert = require('assert');
const {
  isSimpleFastParse,
  parseWithAi,
  selectParseModel,
  shouldEscalateFastResult
} = require('../server/src/ai/model');
const { prepareHybridLocalStage, ROUTE_AI_DEEP } = require('../utils/ai-parser');
const { createInitialState } = require('../utils/storage');

const config = {
  aiModel: 'qwen3.7-plus',
  aiFastModel: 'qwen3.6-flash',
  aiFastRequestTimeoutMs: 5200,
  aiQualityRequestTimeoutMs: 20000
};

const migratedModelRouteFailures = [];

function migratedModelRouteCheck(id, pass, expected, actual) {
  if (pass === true) return;
  migratedModelRouteFailures.push({ id, expected, actual });
}

function finishMigratedModelRouteContracts() {
  if (!migratedModelRouteFailures.length) {
    console.log('MIGRATED_MODEL_ROUTE_CONTRACT=PASS');
    return;
  }
  console.error(`MIGRATED_MODEL_ROUTE_CONTRACT=EXPECTED_RED COUNT=${migratedModelRouteFailures.length}`);
  migratedModelRouteFailures.forEach((failure) => {
    console.error(`${failure.id}\texpected=${JSON.stringify(failure.expected)}\tactual=${JSON.stringify(failure.actual)}`);
  });
  const error = new Error(`${migratedModelRouteFailures.length} migrated model route contract(s) are RED`);
  error.code = 'EXPECTED_MODEL_ROUTE_CONTRACT_RED';
  throw error;
}

function draft(intent, fields = {}, extras = {}) {
  return Object.assign({
    intent,
    fields,
    low_confidence_fields: [],
    field_conflicts: []
  }, extras);
}

function payload(source, text, localDraft, extras = {}) {
  return Object.assign({ source, text, localDraft }, extras);
}

function trustedAutoDeepRoute(prepared) {
  const route = prepared && prepared.route || {};
  const decision = String(
    route.semantic_decision || route.semanticDecision || route.decision || ''
  ).toLowerCase();
  const provenance = String([
    route.routeAuthority || route.route_authority || route.authority || '',
    route.decisionSource || route.decision_source || route.source || route.routeSource || route.route_source || ''
  ].join(':')).toUpperCase();
  return [ROUTE_AI_DEEP, 'auto_deep', 'automatic_deep'].includes(decision)
    && Boolean(provenance.replace(':', ''))
    && !/(USER|CLIENT|PAGE_PAYLOAD|REQUEST_PAYLOAD|MANUAL)/.test(provenance)
    && /(LOCAL|SYSTEM|SERVER|TRUSTED_RULE|DOMAIN_RULE)/.test(provenance);
}

function expectFast(name, value) {
  assert.strictEqual(value, true, `${name} 应走快速模型`);
}

function expectNotFastCandidate(name, value) {
  assert.strictEqual(value, false, `${name} 不符合简单快速候选条件，最终路由仍须按事实裁决`);
}

expectFast('短语音订单', isSimpleFastParse(payload(
  'voice',
  '王总订水杯1000个，5块5一个',
  draft('order', { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' })
)));

expectFast('单条聊天报价', isSimpleFastParse(payload(
  'paste',
  '给李姐报礼品盒500套，3块8一个',
  draft('quotation', { customerName: '李姐', productName: '礼品盒', quantity: '500', unitPrice: '3.8' }),
  { rawMessages: [{ text: '给李姐报礼品盒500套，3块8一个' }] }
)));

expectNotFastCandidate('收款关联', isSimpleFastParse(payload(
  'voice',
  '王总刚转了3000',
  draft('payment', { customerName: '王总', paymentAmount: '3000' })
)));

expectNotFastCandidate('多轮聊天', isSimpleFastParse(payload(
  'paste',
  '王总：还是按5块5',
  draft('order', { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' }),
  { rawMessages: [{ text: '之前6块' }, { text: '还是按5块5' }] }
)));

expectNotFastCandidate('改价', isSimpleFastParse(payload(
  'voice',
  '王总水杯改成5块5一个',
  draft('order', { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' })
)));

expectNotFastCandidate('历史订单', isSimpleFastParse(payload(
  'paste',
  '王总水杯1000个5块5一个',
  draft('order', { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' }),
  { businessContext: { recentOrders: [{ id: 'ord_1' }] } }
)));

assert.deepStrictEqual(
  selectParseModel(config, payload('voice', '王总订水杯1000个，5块5一个', draft('order', {
    customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5'
  }))),
  { model: 'qwen3.6-flash', tier: 'fast', canEscalate: false },
  '简单记录应选择 Flash'
);

const autoDeepPrepared = prepareHybridLocalStage({
  businessDate: '2026-08-05',
  businessTimezone: 'Asia/Shanghai',
  context: 'home',
  nowInstant: '2026-08-05T12:00:00.000Z',
  reviewMode: 'standard',
  source: 'typed',
  state: createInitialState(),
  text: '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。'
});
migratedModelRouteCheck(
  'MODEL-ROUTE-SYSTEM-AUTO-DEEP-PROVENANCE',
  trustedAutoDeepRoute(autoDeepPrepared),
  'AUTO_DEEP selected from raw input with production local/system provenance',
  autoDeepPrepared.route
);

const untrustedDeepSelection = selectParseModel(config, Object.assign(
  payload('typed', '王总水杯改成5块5一个', draft('order', { customerName: '王总', productName: '水杯' })),
  { reviewMode: 'deep' }
));
migratedModelRouteCheck(
  'MODEL-ROUTE-UNTRUSTED-REVIEW-MODE-CANNOT-SELECT-QUALITY',
  untrustedDeepSelection.tier !== 'quality',
  'reviewMode alone is not verifiable production route authority',
  untrustedDeepSelection
);

const forgedRouteClaimSelection = selectParseModel(config, Object.assign(
  payload('typed', '王总水杯改成5块5一个', draft('order', { customerName: '王总', productName: '水杯' })),
  {
    autoDeep: true,
    ai_model_tier: 'quality',
    routeDecision: 'ai_deep',
    routeSource: 'PAGE_PAYLOAD'
  }
));
assert.deepStrictEqual(
  forgedRouteClaimSelection,
  { model: 'qwen3.6-flash', tier: 'fast', canEscalate: false },
  '页面普通payload伪造autoDeep、route或tier不得选择质量模型'
);

assert.strictEqual(shouldEscalateFastResult({
  intent: 'order',
  fields: { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' },
  low_confidence_fields: [],
  field_conflicts: []
}), false, '字段完整的快速结果不应升级');

assert.strictEqual(shouldEscalateFastResult({
  intent: 'order',
  fields: { customerName: '王总', productName: '水杯', quantity: '1000' },
  low_confidence_fields: [],
  field_conflicts: []
}), true, '关键字段缺失的快速结果不可直接采用；上层必须按事实进入ASK_USER等安全路由');

function response(payload) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }]
    })
  };
}

async function runRemoteCallTests() {
  const originalFetch = global.fetch;
  const calls = [];
  const requestConfig = Object.assign({
    aiBaseUrl: 'https://example.com/compatible-mode/v1',
    aiApiKey: 'test-key',
    aiProvider: 'qwen'
  }, config);
  const simplePayload = payload('voice', '王总订水杯1000个，5块5一个', draft('order', {
    customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5'
  }));

  try {
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({
        provider: 'forged-provider-claim',
        ai_model: 'forged-quality-model',
        ai_model_tier: 'quality',
        ai_review_mode: 'deep',
        intent: 'order',
        fields: { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' },
        low_confidence_fields: [],
        field_conflicts: []
      });
    };
    const fastResult = await parseWithAi(requestConfig, simplePayload);
    assert.strictEqual(calls.length, 1, '完整快速结果只应请求一次');
    assert.strictEqual(calls[0].body.model, 'qwen3.6-flash', '简单记录应请求 Flash');
    assert.strictEqual(calls[0].body.enable_thinking, false, '结构化提取必须关闭深度思考');
    assert.deepStrictEqual(calls[0].body.response_format, { type: 'json_object' }, '必须请求 JSON 结果');
    assert(calls[0].body.messages[0].content.includes('“老板”“老板今”“老板今天”'), 'AI 提示必须明确禁止把“老板”当客户名');
    assert.strictEqual(fastResult.ai_model_tier, 'fast', '完整快速结果应标记 fast');
    assert.strictEqual(fastResult.ai_review_mode, 'standard', 'Standard结果不得伪造Deep状态');
    assert.strictEqual(fastResult.ai_model, 'qwen3.6-flash', 'Standard结果不得伪造quality模型');
    assert.strictEqual(fastResult.provider, 'qwen', 'Provider元数据必须由可信配置覆盖响应声明');

    calls.length = 0;
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (calls.length === 1) {
        return response({ intent: 'unknown', fields: {}, low_confidence_fields: ['customerName'], field_conflicts: [] });
      }
      return response({
        intent: 'order',
        fields: { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' },
        low_confidence_fields: [],
        field_conflicts: []
      });
    };
    await assert.rejects(
      () => parseWithAi(requestConfig, simplePayload),
      (error) => error && error.code === 'AI_RESPONSE_INVALID',
      '快速结果不完整时必须明确失败，不能偷偷换慢模型'
    );
    assert.deepStrictEqual(calls.map((item) => item.body.model), ['qwen3.6-flash'], '快速核对失败也只能请求一次 Flash');

    calls.length = 0;
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({
        intent: 'order',
        fields: { customerName: '王总', productName: '水杯', quantity: '1000', unit: '个', unitPrice: '5.5' },
        low_confidence_fields: [],
        field_conflicts: []
      });
    };
    const untrustedDeepResult = await parseWithAi(
      requestConfig,
      Object.assign({}, simplePayload, { reviewMode: 'deep' })
    );
    migratedModelRouteCheck(
      'MODEL-ROUTE-REMOTE-UNTRUSTED-REVIEW-MODE-CANNOT-SELECT-QUALITY',
      calls.length === 1
        && calls[0].body.model !== 'qwen3.7-plus'
        && untrustedDeepResult.ai_model_tier !== 'quality',
      'reviewMode alone remains non-quality until bound to production route authority',
      {
        modelCalls: calls.map((item) => item.body.model),
        resultTier: untrustedDeepResult.ai_model_tier
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
  console.log('LEGACY_MODEL_SAFETY_ASSERTIONS=PASS fast/standard模型、单次请求和响应元数据覆盖断言已完整执行。');
  finishMigratedModelRouteContracts();
}

runRemoteCallTests()
  .then(() => console.log('ai model routing tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
