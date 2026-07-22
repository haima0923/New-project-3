const assert = require('assert');
const {
  isSimpleFastParse,
  parseWithAi,
  selectParseModel,
  shouldEscalateFastResult
} = require('../server/src/ai/model');

const config = {
  aiModel: 'qwen3.7-plus',
  aiFastModel: 'qwen3.6-flash',
  aiFastRequestTimeoutMs: 5200,
  aiQualityRequestTimeoutMs: 20000
};

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

function expectFast(name, value) {
  assert.strictEqual(value, true, `${name} 应走快速模型`);
}

function expectQuality(name, value) {
  assert.strictEqual(value, false, `${name} 应走质量模型`);
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

expectQuality('收款关联', isSimpleFastParse(payload(
  'voice',
  '王总刚转了3000',
  draft('payment', { customerName: '王总', paymentAmount: '3000' })
)));

expectQuality('多轮聊天', isSimpleFastParse(payload(
  'paste',
  '王总：还是按5块5',
  draft('order', { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' }),
  { rawMessages: [{ text: '之前6块' }, { text: '还是按5块5' }] }
)));

expectQuality('改价', isSimpleFastParse(payload(
  'voice',
  '王总水杯改成5块5一个',
  draft('order', { customerName: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' })
)));

expectQuality('历史订单', isSimpleFastParse(payload(
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

assert.deepStrictEqual(
  selectParseModel(config, Object.assign(
    payload('typed', '王总水杯改成5块5一个', draft('order', { customerName: '王总', productName: '水杯' })),
    { reviewMode: 'deep' }
  )),
  { model: 'qwen3.7-plus', tier: 'quality', canEscalate: false },
  '只有明确的深度核对才可选择质量模型'
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
}), true, '关键字段缺失的快速结果必须升级');

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
    const deepResult = await parseWithAi(requestConfig, Object.assign({}, simplePayload, { reviewMode: 'deep' }));
    assert.deepStrictEqual(calls.map((item) => item.body.model), ['qwen3.7-plus'], '质量模型只能由主动深度核对调用');
    assert.strictEqual(deepResult.ai_model_tier, 'quality', '深度核对结果应标记 quality');
  } finally {
    global.fetch = originalFetch;
  }
}

runRemoteCallTests()
  .then(() => console.log('ai model routing tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
