const fs = require('fs');
const path = require('path');
const { parseInput } = require('../utils/parser');
const { parseHybridInput } = require('../utils/ai-parser');
const { prewarmAiAuth } = require('../utils/api-client');
const { buildParseEvidence } = require('../utils/parse-evidence');
const { saveConfirmedDraft, savePendingNote } = require('../utils/business');
const { createInitialState } = require('../utils/storage');
const { answerQuery } = require('../utils/query');
const { today } = require('../utils/date');

const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'boss-spoken-v1.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const failures = [];
const successes = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function getItems(fields = {}) {
  if (Array.isArray(fields.items) && fields.items.length) return fields.items;
  if (fields.productName || fields.quantity || fields.unitPrice) {
    return [{
      productName: fields.productName || '',
      quantity: fields.quantity || '',
      unitPrice: fields.unitPrice || ''
    }];
  }
  return [];
}

function linesContain(answer, text) {
  return [answer.title].concat(answer.lines || []).join('\n').includes(String(text));
}

function recordResult(step, id, input, checks) {
  const failed = checks.filter((item) => !item.pass).map((item) => item.message);
  const record = { step, id, input, failed };
  if (failed.length) failures.push(record);
  else successes.push(record);
  const marker = failed.length ? 'FAIL' : 'PASS';
  console.log(`[${marker}] ${step} · ${id}`);
  if (input) console.log(`  题目：${input}`);
  failed.forEach((message) => console.log(`  问题：${message}`));
}

function checkExpected(result, expected = {}) {
  const fields = result.fields || {};
  const items = getItems(fields);
  const firstItem = items[0] || {};
  const checks = [];
  const equalNumber = (actual, expectedValue) => Math.abs(asNumber(actual) - Number(expectedValue)) < 0.0001;
  if (expected.intent) checks.push({ pass: result.intent === expected.intent, message: `业务类型应为 ${expected.intent}，实际为 ${result.intent || '空'}` });
  if (expected.customer) checks.push({ pass: String(fields.customerName || '').includes(expected.customer), message: `客户应包含“${expected.customer}”，实际为“${fields.customerName || '空'}”` });
  if (expected.customerEmpty) checks.push({ pass: !fields.customerName, message: `不应猜出客户，实际猜成“${fields.customerName || '空'}”` });
  if (expected.product) checks.push({ pass: items.some((item) => String(item.productName || '').includes(expected.product)), message: `商品应包含“${expected.product}”，实际为“${items.map((item) => item.productName || '').join('、') || '空'}”` });
  if (expected.quantity !== undefined) checks.push({ pass: equalNumber(firstItem.quantity || fields.quantity, expected.quantity), message: `数量应为 ${expected.quantity}，实际为 ${firstItem.quantity || fields.quantity || '空'}` });
  if (expected.unitPrice !== undefined) checks.push({ pass: equalNumber(firstItem.unitPrice || fields.unitPrice, expected.unitPrice), message: `单价应为 ${expected.unitPrice}，实际为 ${firstItem.unitPrice || fields.unitPrice || '空'}` });
  if (expected.amount !== undefined) checks.push({ pass: equalNumber(fields.amount, expected.amount), message: `金额应为 ${expected.amount}，实际为 ${fields.amount || '空'}` });
  if (expected.paymentAmount !== undefined) checks.push({ pass: equalNumber(fields.paymentAmount, expected.paymentAmount), message: `本次收款应为 ${expected.paymentAmount}，实际为 ${fields.paymentAmount || '空'}` });
  if (expected.itemCount !== undefined) checks.push({ pass: items.length === expected.itemCount, message: `商品数量应为 ${expected.itemCount} 件，实际为 ${items.length} 件（${items.map((item) => item.productName || '空').join('、')}）` });
  if (expected.mustBlock) {
    const safety = result.local_parse_safety || {};
    const blocked = safety.status !== 'SAFE_LOCAL'
      || (result.missing_fields || []).length > 0
      || (result.low_confidence_fields || []).length > 0
      || (result.field_conflicts || []).length > 0;
    checks.push({ pass: blocked, message: '内容不清楚或有风险时，必须阻止直接保存或引导待整理' });
  }
  checks.push({ pass: String(result.original_text || '') === String(result.__input || ''), message: '原始输入没有被完整保留' });
  return checks;
}

async function runRouteEvidenceTests() {
  console.log('\n第 1 步：核对实际路径（模拟微信登录、AI 成功与失败）');
  const originalWx = global.wx;
  const originalGetApp = global.getApp;
  const requests = [];
  const storage = {};
  try {
    global.getApp = () => ({ globalData: {
      apiBaseUrl: 'https://example.test',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse'
    } });
    global.wx = {
      getStorageSync: (key) => storage[key],
      setStorageSync: (key, value) => { storage[key] = value; },
      removeStorageSync: (key) => { delete storage[key]; },
      login: ({ success }) => success({ code: 'test-login-code' }),
      request: (options) => {
        requests.push(options.url);
        if (options.url.endsWith('/api/auth/wechat-login')) {
          options.success({ statusCode: 200, data: { token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' } });
          return;
        }
        options.success({ statusCode: 200, data: {
          provider: 'real-ai-test-double',
          intent: 'order',
          fields: { productName: '椅子', quantity: '5', unit: '个', unitPrice: '20', dueDate: '2026-07-19' }
        } });
      }
    };
    await prewarmAiAuth();
    const success = await parseHybridInput({
      text: '李姐要订5个椅孑，20元一个，周日交', source: 'voice', context: 'home', state: { customers: [] }
    });
    const successEvidence = buildParseEvidence(success);
    recordResult('第1步', 'voice-ai-success', '李姐要订5个椅孑，20元一个，周日交', [
      { pass: requests.some((url) => url.endsWith('/api/auth/wechat-login')), message: '没有先完成微信登录验证' },
      { pass: requests.some((url) => url.endsWith('/api/ai/parse')), message: '没有向 AI 解析地址发请求' },
      { pass: success.ai_fallback.status === 'used', message: `AI 应为已成功返回，实际为 ${success.ai_fallback.status}` },
      { pass: successEvidence.aiStatusText === 'AI 已成功返回结果', message: '凭证没有清楚显示 AI 成功返回' }
    ]);

    global.wx.request = (options) => {
      if (options.url.endsWith('/api/auth/wechat-login')) {
        options.success({ statusCode: 200, data: { token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' } });
        return;
      }
      options.fail({ errMsg: 'request:fail timeout' });
    };
    const failed = await parseHybridInput({
      text: '李姐要订5个椅孑，20元一个，周日交', source: 'voice', context: 'home', state: { customers: [] }
    });
    const failedEvidence = buildParseEvidence(failed);
    recordResult('第1步', 'voice-ai-timeout', '李姐要订5个椅孑，20元一个，周日交', [
      { pass: failed.ai_fallback.status === 'failed', message: `AI 超时时应显示失败，实际为 ${failed.ai_fallback.status}` },
      { pass: failed.ai_fallback.attempted === true, message: '凭证没有记录“已经尝试调用 AI”' },
      { pass: String(failed.ai_fallback.reason || '').includes('超时'), message: `失败原因应说明超时，实际为“${failed.ai_fallback.reason || ''}”` },
      { pass: failedEvidence.aiStatusText === '智能快速核对未完成', message: '凭证没有清楚显示智能核对未完成' }
    ]);
  } finally {
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
    if (originalGetApp === undefined) delete global.getApp;
    else global.getApp = originalGetApp;
  }
}

function runFieldAndSpeechTests() {
  console.log('\n第 2、3 步：逐字段核对真实口语、错别字、语序和本地口语');
  fixtures.forEach((fixture) => {
    const result = parseInput({ text: fixture.input, source: fixture.source, context: 'home', state: { customers: [] } });
    result.__input = fixture.input;
    recordResult('第2/3步', `${fixture.group} / ${fixture.id}`, fixture.input, checkExpected(result, fixture.expect));
  });
}

function runConfirmationStructureTests() {
  console.log('\n第 4 步：确认卡是否带有可验证凭证（代码结构检查，不能代替真机点击）');
  const dashboardWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'dashboard', 'dashboard.wxml'), 'utf8');
  const inputWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'input', 'input.wxml'), 'utf8');
  const dashboardJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'dashboard', 'dashboard.js'), 'utf8');
  const inputJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'input', 'input.js'), 'utf8');
  recordResult('第4步', 'confirmation-evidence-structure', '', [
    { pass: dashboardWxml.includes('本次整理说明') && dashboardWxml.includes('parse-evidence-status'), message: '首页确认卡没有展示识别过程凭证' },
    { pass: inputWxml.includes('本次整理说明') && inputWxml.includes('parse-evidence-status'), message: '完整记一笔确认卡没有展示识别过程凭证' },
    { pass: dashboardJs.includes('toggleParseEvidence') && inputJs.includes('toggleParseEvidence'), message: '识别过程没有可展开查看的操作' },
    { pass: dashboardWxml.includes('showParseEvidence') && inputWxml.includes('showParseEvidence'), message: '识别过程应默认收起，避免挤压底部按钮' },
    {
      pass: (() => {
        const evidence = buildParseEvidence({
          intent: 'unknown',
          fields: {},
          local_parse_safety: { reason_texts: ['intent缺失'] }
        });
        return !evidence.checkText.includes('intent') && evidence.checkText.includes('报价、订单、收款还是提醒');
      })(),
      message: '识别凭证把内部技术词显示给了用户，应该用普通语言说明'
    }
  ]);
}

function confirmedDraft(intent, fields, originalText) {
  return {
    intent,
    operation: '',
    source: 'typed',
    original_text: originalText,
    fields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'dueDate']
  };
}

function runSaveAndQueryTests() {
  console.log('\n第 5 步：保存后核对记录与“问一句”');
  const state = createInitialState();
  const quote = confirmedDraft('quotation', {
    customerName: '王总', productName: '保温杯', quantity: '100', unit: '个', unitPrice: '20', amount: '2000', dueDate: today()
  }, '王总保温杯100个，20元一个，先报个价');
  const order = confirmedDraft('order', {
    customerName: '李总', productName: '纸袋', quantity: '500', unit: '个', unitPrice: '1.2', amount: '600', dueDate: today()
  }, '李总订纸袋500个，1.2元一个，今天交');
  const receivable = confirmedDraft('receivable', {
    customerName: '周姐', amount: '3000', dueDate: today()
  }, '周姐还欠3000元，今天收');
  const quoteSaved = saveConfirmedDraft(state, quote);
  const orderSaved = saveConfirmedDraft(state, order);
  const receivableSaved = saveConfirmedDraft(state, receivable);
  const zhou = state.customers.find((item) => item.name === '周姐');
  const receivableRecord = state.receivables.find((item) => item.customerId === zhou.id);
  const payment = confirmedDraft('payment', {
    customerName: '周姐', customerId: zhou.id, paymentAmount: '1000', receivableId: receivableRecord.id, receivableSelectionConfirmed: true
  }, '周姐刚打了1000，算到那笔货款里');
  const paymentSaved = saveConfirmedDraft(state, payment);
  const pending = savePendingNote(state, {
    intent: 'unknown', source: 'voice', original_text: '王总报价五百个二十块，另外周姐打了两千', fields: {}, missing_fields: ['intent'], low_confidence_fields: [], field_conflicts: []
  }, '一句话里有多笔业务，待确认');
  const quoteAnswer = answerQuery('王总上次报价是多少', state);
  const orderAnswer = answerQuery('李总订单怎么样', state);
  const receivableAnswer = answerQuery('周姐还欠多少', state);
  const pendingAnswer = answerQuery('有几条待整理', state);
  const serialized = JSON.stringify(state);
  recordResult('第5步', 'save-and-query', '', [
    { pass: quoteSaved.type === 'quotation' && state.quotations.length === 1, message: '报价没有正确保存为一条报价记录' },
    { pass: orderSaved.type === 'order' && state.orders.length === 1, message: '订单没有正确保存为一条订单记录' },
    { pass: receivableSaved.type === 'receivable' && state.receivables.length === 1, message: '待收款没有正确保存' },
    { pass: paymentSaved.type === 'payment' && state.paymentRecords.length === 1, message: '收款没有正确保存' },
    { pass: Number(receivableRecord.paidAmount) === 1000, message: `收款后已收金额应为1000，实际为${receivableRecord.paidAmount || 0}` },
    { pass: linesContain(quoteAnswer, '20'), message: `问报价没有查到20元：${JSON.stringify(quoteAnswer)}` },
    { pass: linesContain(orderAnswer, '纸袋'), message: `问订单没有查到纸袋：${JSON.stringify(orderAnswer)}` },
    { pass: linesContain(receivableAnswer, '2000'), message: `问欠款没有查到剩余2000：${JSON.stringify(receivableAnswer)}` },
    { pass: linesContain(pendingAnswer, '待整理'), message: `问待整理没有查到刚保存的待整理记录：${JSON.stringify(pendingAnswer)}` },
    { pass: pending && !serialized.includes('本次识别过程') && !serialized.includes('AI 已成功返回结果'), message: '识别凭证不应被写进业务记录、待整理或查询数据' }
  ]);
}

async function main() {
  console.log(`五步测试开始：${fixtures.length} 条真实用户表达题目`);
  await runRouteEvidenceTests();
  runFieldAndSpeechTests();
  runConfirmationStructureTests();
  runSaveAndQueryTests();
  console.log('\n五步测试摘要');
  console.log(`- 通过项：${successes.length}`);
  console.log(`- 失败项：${failures.length}`);
  console.log('- 真机缺口：微信语音真实转写、已登录 AI 请求、长卡片按钮可点、弱网，仍必须在体验版完成。');
  if (failures.length) {
    console.log('\n结论：自动测试未通过。失败题目和字段已逐条列出，不能用通过数量掩盖这些问题。');
    process.exitCode = 1;
  } else {
    console.log('\n结论：自动测试通过，但仍不代表真机体验版可以上线。');
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
