const assert = require('assert');
const { parseInput } = require('../utils/parser');
const { saveConfirmedDraft } = require('../utils/business');
const {
  parseHybridInput,
  requestWithDeadline,
  ROUTE_AI_STANDARD,
  ROUTE_AI_DEEP,
  ROUTE_LOCAL,
  ROUTE_PENDING
} = require('../utils/ai-parser');
const { buildParseEvidence } = require('../utils/parse-evidence');
const { prewarmAiAuth } = require('../utils/api-client');

function payload(text, source) {
  return {
    text,
    source,
    context: 'home',
    state: { customers: [], quotations: [], orders: [], receivables: [] }
  };
}

function assertTrace(result, label) {
  assert(result.parse_route && result.parse_route.decision, `${label} 缺少明确处理方式`);
  assert(result.parse_trace && result.parse_trace.route, `${label} 缺少识别过程凭证`);
  assert(Number.isFinite(result.parse_trace.localDurationMs), `${label} 没有记录本地耗时`);
  assert(Number.isFinite(result.parse_trace.totalDurationMs), `${label} 没有记录总耗时`);
  assert(result.parse_trace.localDraft, `${label} 没有记录本地先整理的结果`);
}

function buildEmptyState() {
  return {
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
    todos: [], pendingNotes: [], aiParseLogs: []
  };
}

function withFakeWechat(mode, run) {
  const oldWx = global.wx;
  const oldGetApp = global.getApp;
  const storage = {};
  global.getApp = () => ({ globalData: {
    apiBaseUrl: 'https://example.test',
    aiAuthEnabled: true,
    aiParseEndpoint: '/api/ai/parse'
  } });
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    removeStorageSync(key) { delete storage[key]; },
    login(options) { options.success({ code: 'route-test-code' }); },
    request(options) {
      if (options.url.endsWith('/api/auth/wechat-login')) {
        options.success({ statusCode: 200, data: { token: 'route-test-token', expiresAt: '2099-01-01T00:00:00.000Z' } });
        return;
      }
      if (mode === 'timeout') {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      options.success({
        statusCode: 200,
        data: {
          provider: 'real-ai-test-double',
          ai_model_tier: 'quality',
          intent: 'order',
          fields: { customerName: '王总', productName: '水杯', quantity: '5', unit: '个', unitPrice: '5.5', dueDate: '2026-07-20' }
        }
      });
    }
  };
  return Promise.resolve()
    .then(() => prewarmAiAuth())
    .then(run)
    .finally(() => {
      if (oldWx === undefined) delete global.wx;
      else global.wx = oldWx;
      if (oldGetApp === undefined) delete global.getApp;
      else global.getApp = oldGetApp;
    });
}

async function main() {
  const screenshotLocal = parseInput({
    text: '老板今天要订5个椅子，20块钱一个。这周日交货',
    source: 'voice',
    state: { customers: [] }
  });
  assert.strictEqual(screenshotLocal.fields.customerName, '', '“老板今天”不是客户名，客户必须留空');
  assert.strictEqual(screenshotLocal.fields.productName, '椅子', '原句商品必须是椅子');
  assert.strictEqual(screenshotLocal.fields.quantity, '5', '原句数量必须是 5');
  assert.strictEqual(screenshotLocal.fields.unitPrice, '20', '“20块钱一个”必须识别为单价 20');
  assert.strictEqual(screenshotLocal.fields.items.length, 1, '单商品不能凭空多出“块钱”');
  assert.strictEqual(screenshotLocal.fields.items[0].productName, '椅子', '单商品名称必须是椅子');

  const local = await parseHybridInput(payload('王总订水杯100个，5块5一个，明天交', 'typed'));
  assert.strictEqual(local.parse_route.decision, ROUTE_LOCAL, '清楚的手打订单应走本地快速整理');
  assert.strictEqual(local.ai_fallback.status, 'not_requested', '本地快速整理不应等待 AI');
  assertTrace(local, '本地快速整理');
  const localEvidence = buildParseEvidence(local);
  assert.strictEqual(localEvidence.routeLabel, '本地快速整理', '凭证应显示本地快速整理');
  assert(localEvidence.totalDurationText, '凭证应显示总耗时');

  const clearVoice = await parseHybridInput(payload('王总订水杯100个，5块5一个，明天交', 'voice'));
  assert.strictEqual(clearVoice.parse_route.decision, ROUTE_LOCAL, '清楚的语音转写文字应与手打文字同路由');
  assert.strictEqual(clearVoice.ai_fallback.status, 'not_requested', '清楚的语音转写文字不应因为来源而等待 AI');

  const suggestedProduct = await withFakeWechat('success', () => parseHybridInput(payload(
    '王总那个礼合要5套，三块八一套，下周三拿',
    'voice'
  )));
  assert.strictEqual(suggestedProduct.parse_route.decision, ROUTE_LOCAL, '明确的商品转写提示应直接交给老板确认，不能让 AI 再猜一次');
  assert.strictEqual(suggestedProduct.ai_fallback.status, 'not_requested', '商品名已有明确建议时不应浪费等待时间请求 AI');
  assertTrace(suggestedProduct, '商品名称确认提示');
  assert(suggestedProduct.field_suggestions && suggestedProduct.field_suggestions.productName, '确认卡必须展示商品名称建议');
  assert.strictEqual(suggestedProduct.fields.customerName, '王总', '本地整理仍必须保留原文已经明确的客户');
  assert.strictEqual(suggestedProduct.fields.items.length, 1, '商品名称确认提示不能把单商品拆坏');
  assert.strictEqual(suggestedProduct.fields.unitPrice, '3.8', '商品名称确认提示不能改变已明确的单价');
  const suggestedProductEvidence = buildParseEvidence(suggestedProduct);
  assert.strictEqual(suggestedProductEvidence.routeLabel, '本地快速整理', '凭证应说明本次没有请求 AI');

  const aiChecked = await withFakeWechat('success', () => parseHybridInput(payload(
    '王总要订5个水悲，五块五一个，明天交',
    'voice'
  )));
  assert.strictEqual(aiChecked.parse_route.decision, ROUTE_AI_STANDARD, '不认识的商品转写应请求一次快速 AI 再核对');
  assert.strictEqual(aiChecked.ai_fallback.status, 'used', 'AI 成功返回时必须明确记录成功');
  assertTrace(aiChecked, 'AI 再核对');
  assert(aiChecked.parse_trace.aiDraft && aiChecked.parse_trace.aiDraft.productName === '水杯', '凭证应记录 AI 单独回答了什么');
  assert(aiChecked.parse_trace.aiDurationMs >= 0, 'AI 成功时应记录联网整理等待时间');
  assert.strictEqual(aiChecked.fields.customerName, '王总', 'AI 不能覆盖原文已经明确的客户');
  assert.strictEqual(aiChecked.fields.items.length, 1, 'AI 合并后仍必须只有一件商品');
  assert.strictEqual(aiChecked.fields.unitPrice, '5.5', 'AI 合并后单价仍必须是 5.5');
  const aiCheckedEvidence = buildParseEvidence(aiChecked);
  assert.strictEqual(aiCheckedEvidence.routeLabel, '请 AI 再核对', '凭证应说明本次是 AI 再核对');
  assert(aiCheckedEvidence.aiSummary.includes('水杯'), '凭证应展示 AI 回答的关键字段');

  const failed = await withFakeWechat('timeout', () => parseHybridInput(payload(
    '王总要订5个水悲，五块五一个，明天交',
    'voice'
  )));
  assert.strictEqual(failed.ai_fallback.status, 'timed_out', 'AI 超时必须与其他失败状态区分');
  assertTrace(failed, 'AI 超时');
  assert(failed.parse_trace.aiDurationMs >= 0, 'AI 超时时也应记录已经等了多久');
  const failedEvidence = buildParseEvidence(failed);
  assert.strictEqual(failedEvidence.aiStatusText, '智能核对等待超时', '凭证不能把超时说成成功');

  const deepDefault = await parseHybridInput(payload('王总水杯100个，5块5一个，改成后天交', 'typed'));
  assert.strictEqual(deepDefault.parse_route.decision, ROUTE_PENDING, '改价内容首次必须不联网等待慢模型');
  assert.strictEqual(deepDefault.parse_route.deep_review_available, true, '改价内容必须明确给出深度核对入口');
  assert.strictEqual(deepDefault.ai_fallback.attempted, false, '未点击深度核对时不得调用 AI');
  const deepUsed = await withFakeWechat('success', () => parseHybridInput(Object.assign(
    payload('王总水杯100个，5块5一个，改成后天交', 'typed'),
    { reviewMode: 'deep' }
  )));
  assert.strictEqual(deepUsed.parse_route.decision, ROUTE_AI_DEEP, '只有用户主动点击后才允许走深度核对');

  const failedButComplete = Object.assign({}, failed, {
    intent: 'order',
    fields: { customerName: '王总', productName: '椅子', quantity: '5', unit: '个', unitPrice: '20', amount: '100' },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  const blockedState = buildEmptyState();
  const blockedSave = saveConfirmedDraft(blockedState, failedButComplete);
  assert.strictEqual(blockedSave.type, 'pending', 'AI 失败后，即使字段看起来齐全，也不能直接正式保存');
  assert.strictEqual(blockedState.orders.length, 0, 'AI 失败后不能生成正式订单');
  assert(blockedSave.record.reason.includes('联网整理没有成功'), '待整理原因必须告诉老板为什么不能直接保存');

  let deadlineError = null;
  const deadlineStartedAt = Date.now();
  try {
    await requestWithDeadline(new Promise(() => {}), 20);
  } catch (error) {
    deadlineError = error;
  }
  assert(deadlineError && deadlineError.code === 'AI_TOTAL_TIMEOUT', '总等待上限必须能主动结束等待');
  assert(Date.now() - deadlineStartedAt < 500, '总等待上限测试不应卡住');

  console.log('识别、合并、保存和等待时间测试通过：原句字段正确、AI 不会保留“老板今”、AI 失败不能正式保存、超时可结束。');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
