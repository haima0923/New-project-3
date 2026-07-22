const assert = require('assert');
const { parseHybridInput, normalizeAiResult, getAiFailureReason } = require('../utils/ai-parser');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { buildParseEvidence } = require('../utils/parse-evidence');
const { saveConfirmedDraft } = require('../utils/business');
const { parseWithAi } = require('../server/src/ai/model');

function emptyState() {
  return {
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
    todos: [], pendingNotes: [], aiParseLogs: []
  };
}

async function testMixedBusinessCannotBeDowngraded() {
  const text = '王总，杯垫500个，九毛一个，另外周姐刚打了3000';
  const local = await parseHybridInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'home',
    state: emptyState()
  });
  const merged = normalizeAiResult(local, {
    provider: 'test-ai',
    intent: 'quotation',
    fields: { customerName: '王总', productName: '杯垫', quantity: '500', unit: '个', unitPrice: '0.9' },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    intent_candidates: ['quotation', 'payment']
  });
  assert(merged.field_conflicts.some((item) => item.field === 'customerName'), '多个客户的本地风险不能被 AI 空数组清掉');
  assert(merged.field_conflicts.some((item) => item.field === 'intent'), '多笔业务必须明确提示拆开记录');
  assert(merged.low_confidence_fields.includes('intent'), '多业务必须保持为不确定状态');
  assert(merged.missing_fields.includes('intent'), '多业务不能伪装成一笔完整记录');
  const saved = saveConfirmedDraft(emptyState(), merged);
  assert.strictEqual(saved.type, 'pending', '多业务 AI 结果不能直接保存为报价/订单/收款');
}

function testAiMustShowResolutionEvidence() {
  const local = {
    intent: 'order',
    source: 'paste',
    original_text: '王总水杯1000个，之前30一个，后面确认25一个',
    fields: { customerName: '王总', productName: '水杯', quantity: '1000', unit: '个', unitPrice: '25' },
    missing_fields: [],
    low_confidence_fields: ['unitPrice'],
    field_conflicts: [{ field: 'unitPrice', values: ['30', '25'] }],
    local_parse_safety: { status: 'NEEDS_AI' }
  };
  const withoutEvidence = normalizeAiResult(local, {
    intent: 'order', fields: local.fields, missing_fields: [], low_confidence_fields: [], field_conflicts: []
  });
  assert(withoutEvidence.field_conflicts.some((item) => item.field === 'unitPrice'), 'AI 未给解决依据时不能清除价格冲突');
  const resolved = normalizeAiResult(local, {
    intent: 'order', fields: local.fields, missing_fields: [], low_confidence_fields: [], field_conflicts: [],
    superseded_facts: [{ field: 'unitPrice', oldValue: '30', newValue: '25', reason: '后面确认' }],
    field_evidence: { unitPrice: [{ messageIndex: 1, text: '后面确认25一个' }] }
  });
  assert(!resolved.field_conflicts.length, '有替代记录和原话证据时可以清除已解决的单字段冲突');
}

function testCollapsedItemsAreBlocked() {
  const local = {
    intent: 'order',
    source: 'typed',
    original_text: '王总订杯垫300个九毛一个，礼品盒200个三块八一个，后天交',
    fields: {
      customerName: '王总',
      productName: '杯垫', quantity: '300', unit: '个', unitPrice: '0.9',
      items: [
        { productName: '杯垫', quantity: '300', unit: '个', unitPrice: '0.9', totalAmount: '270' },
        { productName: '礼品盒', quantity: '200', unit: '个', unitPrice: '3.8', totalAmount: '760' }
      ]
    },
    missing_fields: [], low_confidence_fields: [], field_conflicts: [],
    local_parse_safety: { status: 'NEEDS_AI' }
  };
  const merged = normalizeAiResult(local, {
    intent: 'order',
    fields: { customerName: '王总', productName: '杯垫,礼品盒', quantity: '300,200', unit: '个,个', unitPrice: '0.9,3.8' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  });
  assert.strictEqual(merged.fields.items.length, 2, 'AI 拼接多商品时不能覆盖本地已拆出的明细');
  assert(merged.field_conflicts.some((item) => item.field === 'items'), 'AI 拼接多商品必须被拦住');
  assert(merged.low_confidence_fields.includes('items'), '多商品结构异常必须要求逐项确认');
}

async function testProductTranscriptionNeedsConfirmation() {
  const text = '王总订水怀100个，5块5一个，明天交';
  const result = await parseHybridInput({
    text,
    rawText: text,
    source: 'voice',
    context: 'home',
    state: emptyState()
  });
  const final = applyFinalParseSafety(result);
  assert(result.field_suggestions && result.field_suggestions.productName, '常见转写错误必须给出商品名称确认提示');
  assert.strictEqual(result.parse_route.decision, 'local', '已有明确商品建议时应由老板确认，不能额外等待 AI');
  assert.strictEqual(result.ai_fallback.status, 'not_requested', '明确商品建议不能发起无效 AI 请求');
  assert(result.low_confidence_fields.includes('productName'), '商品名转写错误不能当作已确认');
  assert(final.low_confidence_fields.includes('productName'), '进入确认页后商品名提醒不能被自动清掉');

  const anotherText = '王总订礼品和5套，三块八一个，明天交';
  const another = await parseHybridInput({
    text: anotherText,
    rawText: anotherText,
    source: 'voice',
    context: 'home',
    state: emptyState()
  });
  assert.strictEqual(another.fields.productName, '礼品盒', '“礼品和”必须先整理为礼品盒候选');
  assert.strictEqual(another.parse_route.decision, 'local', '已有明确商品候选时不能额外等待 AI');
  assert(another.low_confidence_fields.includes('productName'), '“礼品和”也必须要求老板确认，不能悄悄保存');
}

function testReturnedUncertainIsNotReportedAsNoResponse() {
  const reason = getAiFailureReason({ code: 'AI_RESPONSE_INVALID' });
  assert(reason.includes('AI 已返回'), 'AI 返回但内容不完整时必须如实说明已返回');
  const evidence = buildParseEvidence({
    ai_fallback: { status: 'returned_uncertain', attempted: true, reason },
    fields: {}, parse_route: { label: '请 AI 再核对' }
  });
  assert.strictEqual(evidence.aiStatusText, 'AI 已返回，但不够确定', '确认卡不能把无效回答说成 AI 没有返回');
}

async function testNextMonthDateHasDirectEvidence() {
  const text = '赵总下单卡通杯800个，6元一个，下个月5号交';
  const result = await parseHybridInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'home',
    state: emptyState()
  });
  assert(result.fields.dueDate, '“下个月5号”必须解析为交期');
  assert(!result.low_confidence_fields.includes('dueDate'), '原话明确有“下个月5号”时不能误报交期不确定');
}

async function testServerDeepContractRejectsCollapsedItems() {
  const originalFetch = global.fetch;
  const calls = [];
  const config = {
    aiBaseUrl: 'https://example.test/v1',
    aiApiKey: 'test-key',
    aiProvider: 'qwen',
    aiModel: 'quality-model',
    aiFastModel: 'fast-model',
    aiFastRequestTimeoutMs: 5200,
    aiQualityRequestTimeoutMs: 20000
  };
  try {
    global.fetch = async (url, options) => {
      calls.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          intent: 'order',
          fields: { productName: '杯垫,礼品盒', quantity: '300,200', unitPrice: '0.9,3.8' },
          missing_fields: [], low_confidence_fields: [], field_conflicts: []
        }) } }] })
      };
    };
    const result = await parseWithAi(config, {
      reviewMode: 'deep', source: 'typed', text: '两件商品', localDraft: { intent: 'order', fields: {} }
    });
    assert(calls[0].messages[0].content.includes('fields.items必须是逐项数组'), '深度 AI 提示必须强制逐项商品数组');
    assert(calls[0].messages[1].content.includes('"items":[]'), '深度 AI 返回结构必须包含 items 数组');
    assert(result.field_conflicts.some((item) => item.field === 'items'), '服务端也要拦住多商品被拼成一条的返回');
  } finally {
    global.fetch = originalFetch;
  }
}

Promise.resolve()
  .then(testMixedBusinessCannotBeDowngraded)
  .then(testAiMustShowResolutionEvidence)
  .then(testCollapsedItemsAreBlocked)
  .then(testProductTranscriptionNeedsConfirmation)
  .then(testReturnedUncertainIsNotReportedAsNoResponse)
  .then(testNextMonthDateHasDirectEvidence)
  .then(testServerDeepContractRejectsCollapsedItems)
  .then(() => console.log('真实 AI 风险回归测试通过：多业务、冲突证据、多商品、商品转写、日期证据、服务端合同。'))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
