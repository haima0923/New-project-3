/*
 * 1,490 题“记一笔”发布前测试。
 *
 * 默认只跑本地规则和“是否该请求 AI”的判断，不伪装成真实 AI 测试。
 * 输出一份可搜索 HTML：题目、正确答案、本地实际结果、路由判断和结论都能看到。
 *
 * 真正请求线上 AI 必须使用单独的真实 AI 执行器，并明确记录服务端 provider、请求结果和费用。
 */

const fs = require('fs');
const path = require('path');
const { parseInput } = require('../utils/parser');
const { parseHybridInput } = require('../utils/ai-parser');
const { applyLocalParseSafety, applyFinalParseSafety, SAFE_LOCAL, NO_RECORD } = require('../utils/parse-safety');
const { saveConfirmedDraft, savePendingNote } = require('../utils/business');
const { createInitialState } = require('../utils/storage');
const { corpus } = require('../test-fixtures/release-parse-corpus-v2');

const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'reports', 'release-parse-corpus-v2');
const jsonPath = path.join(reportDir, 'local-and-route-results.json');
const htmlPath = path.join(reportDir, 'local-and-route-results.html');

function compact(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function sameNumber(actual, expected) {
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.00001;
}

function fieldValue(fields, name) {
  return fields && fields[name] !== undefined && fields[name] !== null ? fields[name] : '';
}

function getItems(fields = {}) {
  if (Array.isArray(fields.items) && fields.items.length) return fields.items;
  if (fields.productName || fields.quantity || fields.unitPrice) {
    return [{ productName: fields.productName || '', quantity: fields.quantity || '', unitPrice: fields.unitPrice || '' }];
  }
  return [];
}

function toPlainResult(result = {}, safety = {}) {
  const fields = result.fields || {};
  const items = getItems(fields);
  return {
    businessType: result.intent || '没有判断出来',
    customer: fields.customerName || '',
    product: fields.productName || '',
    products: items.map((item) => item.productName || '').filter(Boolean),
    quantity: fields.quantity || (items[0] && items[0].quantity) || '',
    unitPrice: fields.unitPrice || (items[0] && items[0].unitPrice) || '',
    amount: fields.amount || '',
    paymentAmount: fields.paymentAmount || '',
    dueDate: fields.dueDate || '',
    missing: result.missing_fields || [],
    lowConfidence: result.low_confidence_fields || [],
    safety: safety.status || '',
    safetyReasons: safety.reason_texts || []
  };
}

function expectedSummary(expected = {}) {
  const bits = [];
  if (expected.intent) bits.push(`业务：${expected.intent}`);
  if (expected.customer) bits.push(`客户：${expected.customer}`);
  if (expected.customerAbsent) bits.push('客户：必须留空，不能猜');
  if (expected.product) bits.push(`商品：${expected.product}`);
  if (expected.products) bits.push(`商品：${expected.products.join('、')}`);
  if (expected.quantity) bits.push(`数量：${expected.quantity}`);
  if (expected.unitPrice) bits.push(`单价：${expected.unitPrice}`);
  if (expected.amount) bits.push(`金额：${expected.amount}`);
  if (expected.paymentAmount) bits.push(`本次收款/定金：${expected.paymentAmount}`);
  if (expected.itemCount !== undefined) bits.push(`商品件数：${expected.itemCount}`);
  if (expected.forbiddenCustomers && expected.forbiddenCustomers.length) bits.push(`不能写成客户：${expected.forbiddenCustomers.join('、')}`);
  if (expected.forbiddenProducts && expected.forbiddenProducts.length) bits.push(`不能出现商品：${expected.forbiddenProducts.join('、')}`);
  if (expected.route) bits.push(`应该走：${routeLabel(expected.route)}`);
  if (expected.mustBlock) bits.push('必须要求老板确认，不能直接存');
  if (expected.requiresManualProductConfirmation) bits.push('商品名必须由老板点选或手改确认；确认前不能正式保存');
  if (expected.requiresDeepReview) bits.push('首次不得等待慢模型；必须显示“深度核对”入口');
  if (expected.noRecord) bits.push('不能生成业务记录');
  if (expected.mustBlockOnAiFailure) bits.push('AI 失败时必须不能正式保存');
  return bits.join('；') || '必须要求确认，不能猜测';
}

function routeLabel(route) {
  const labels = {
    local: '本地规则即可整理',
    ai_standard: '请 AI 再核对',
    ai_deep: '请 AI 深度整理',
    pending: '待整理，不能强行记录'
  };
  return labels[route] || route || '未定义';
}

function actualRoute(hybridResult, safety) {
  const route = (hybridResult && hybridResult.parse_route) || {};
  if (['pending', 'local', 'ai_standard', 'ai_deep'].includes(route.decision)) return route.decision;
  if (safety.status === NO_RECORD) return 'pending';
  const status = (((hybridResult || {}).ai_fallback) || {}).status;
  if (status === 'not_requested') return 'local';
  if (status === 'skipped_no_endpoint' || status === 'failed' || status === 'used' || status === 'mock_used') return 'ai_standard';
  return 'unknown';
}

function expectedRouteMatches(expectedRoute, actual) {
  return expectedRoute === actual;
}

function buildEmptySaveState() {
  return createInitialState();
}

function buildCorpusPasteMeta(testCase = {}) {
  if (testCase.source !== 'paste') return null;
  const rawMessages = Array.isArray(testCase.rawMessages) ? testCase.rawMessages : [];
  const customerNameFromChat = rawMessages
    .map((message) => String(message.speaker || '').trim())
    .find((speaker) => speaker && !/^(?:我|自己|本人|老板|客服|系统)$/.test(speaker)) || '';
  return {
    rawMessages,
    messageCount: rawMessages.length,
    customerNameFromChat,
    speakerName: customerNameFromChat
  };
}

async function simulateAiFailure(payload, failureMode) {
  const originalWx = global.wx;
  const originalGetApp = global.getApp;
  const storage = {};
  try {
    global.getApp = () => ({ globalData: {
      apiBaseUrl: 'https://ai-test.invalid',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse'
    } });
    global.wx = {
      getStorageSync(key) { return storage[key]; },
      setStorageSync(key, value) { storage[key] = value; },
      removeStorageSync(key) { delete storage[key]; },
      login(options) {
        if (failureMode === 'login_failed') {
          options.fail({ errMsg: 'login:fail simulated' });
          return;
        }
        options.success({ code: 'release-test-code' });
      },
      request(options) {
        if (options.url.endsWith('/api/auth/wechat-login')) {
          options.success({
            statusCode: 200,
            data: { token: 'release-test-token', expiresAt: '2099-01-01T00:00:00.000Z' }
          });
          return;
        }
        if (failureMode === 'timeout') {
          options.fail({ errMsg: 'request:fail timeout' });
          return;
        }
        if (failureMode === 'network') {
          options.fail({ errMsg: 'request:fail network error' });
          return;
        }
        if (failureMode === 'server_500') {
          options.success({ statusCode: 500, data: { error: 'AI_PARSE_FAILED' } });
          return;
        }
        // 空响应代表服务没有给出可用 JSON，不能被当作 AI 成功。
        options.success({ statusCode: 200, data: null });
      }
    };
    return await parseHybridInput(payload);
  } finally {
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
    if (originalGetApp === undefined) delete global.getApp;
    else global.getApp = originalGetApp;
  }
}

function evaluateCase(testCase, local, hybrid, safety) {
  const expected = testCase.expected || {};
  const fields = local.fields || {};
  const items = getItems(fields);
  const failures = [];
  const include = (actual, value) => compact(actual).includes(compact(value));
  const check = (pass, reason) => { if (!pass) failures.push(reason); };
  const route = actualRoute(hybrid, safety);

  if (expected.intent) check(local.intent === expected.intent, `业务类型应是“${expected.intent}”，实际是“${local.intent || '空'}”`);
  if (expected.customer) check(include(fields.customerName, expected.customer), `客户应是“${expected.customer}”，实际是“${fields.customerName || '空'}”`);
  if (expected.customerAbsent) check(!fields.customerName, `客户原文没有说清，不能猜；实际写成“${fields.customerName || '空'}”`);
  if (expected.product) check(items.some((item) => include(item.productName, expected.product)), `商品应含“${expected.product}”，实际是“${items.map((item) => item.productName || '').join('、') || '空'}”`);
  if (expected.products) {
    expected.products.forEach((product) => check(items.some((item) => include(item.productName, product)), `多商品中应有“${product}”，实际是“${items.map((item) => item.productName || '').join('、') || '空'}”`));
  }
  if (expected.forbiddenCustomers) {
    expected.forbiddenCustomers.forEach((customer) => check(!include(fields.customerName, customer), `不能把原文写成客户“${customer}”，实际是“${fields.customerName || '空'}”`));
  }
  if (expected.forbiddenProducts) {
    expected.forbiddenProducts.forEach((product) => check(!items.some((item) => include(item.productName, product)), `不能凭空出现商品“${product}”，实际是“${items.map((item) => item.productName || '').join('、') || '空'}”`));
  }
  if (expected.quantity) check(sameNumber(fieldValue(fields, 'quantity') || (items[0] || {}).quantity, expected.quantity), `数量应是“${expected.quantity}”，实际是“${fieldValue(fields, 'quantity') || (items[0] || {}).quantity || '空'}”`);
  if (expected.unitPrice) check(sameNumber(fieldValue(fields, 'unitPrice') || (items[0] || {}).unitPrice, expected.unitPrice), `单价应是“${expected.unitPrice}”，实际是“${fieldValue(fields, 'unitPrice') || (items[0] || {}).unitPrice || '空'}”`);
  if (expected.amount) check(sameNumber(fields.amount, expected.amount), `金额应是“${expected.amount}”，实际是“${fields.amount || '空'}”`);
  if (expected.paymentAmount) check(sameNumber(fields.paymentAmount || fields.depositAmount, expected.paymentAmount), `本次收款/定金应是“${expected.paymentAmount}”，实际是“${fields.paymentAmount || fields.depositAmount || '空'}”`);
  const requiredItemCount = expected.itemCount !== undefined
    ? expected.itemCount
    : (expected.product && !expected.products ? 1 : undefined);
  if (requiredItemCount !== undefined) check(items.length === requiredItemCount, `商品应为 ${requiredItemCount} 件，实际为 ${items.length} 件（${items.map((item) => item.productName || '空').join('、')}）`);
  if (expected.mustBlock) check(safety.status !== SAFE_LOCAL, '内容有缺失或风险时，系统应该要求确认或待整理，却被判成可直接整理');
  if (expected.requiresManualProductConfirmation) {
    const aiStatus = (((hybrid || {}).ai_fallback) || {}).status;
    check(route === 'local', '已有明确商品建议时应走本地确认，不能额外等待 AI');
    check(aiStatus === 'not_requested', `已有明确商品建议时不应请求 AI，实际状态是“${aiStatus || '空'}”`);
    check((local.low_confidence_fields || []).includes('productName'), '商品名称建议必须明确标为待确认');
    check(Boolean((hybrid.field_suggestions || {}).productName), '确认卡必须展示商品名称建议');
    const beforeConfirmState = buildEmptySaveState();
    const beforeConfirmSnapshot = JSON.stringify(beforeConfirmState);
    const beforeConfirmSaved = saveConfirmedDraft(beforeConfirmState, hybrid);
    check(beforeConfirmSaved.type === 'error', `未确认商品名称前正式保存必须阻断，实际是“${beforeConfirmSaved.type}”`);
    check(JSON.stringify(beforeConfirmState) === beforeConfirmSnapshot, '未确认商品名称时正式保存必须零 mutation');
    const explicitPending = savePendingNote(beforeConfirmState, hybrid, beforeConfirmSaved.error || '用户明确选择稍后整理');
    check(Boolean(explicitPending) && beforeConfirmState.pendingNotes.length === 1, '只有显式保存待整理才新增 pending');
    const manuallyConfirmed = applyFinalParseSafety(
      Object.assign({}, hybrid, { manual_fields: ['productName'] }),
      { businessDate: testCase.businessDate }
    );
    const afterConfirmState = buildEmptySaveState();
    const afterConfirmSaved = saveConfirmedDraft(afterConfirmState, manuallyConfirmed);
    check(afterConfirmSaved.type === hybrid.intent, `老板确认商品名称后应保存为“${hybrid.intent}”，实际是“${afterConfirmSaved.type}”`);
  }
  if (expected.requiresDeepReview) {
    check(Boolean((hybrid.parse_route || {}).deep_review_available), '高风险内容首次必须显示“深度核对”入口，不能自动等待慢模型');
  }
  if (expected.noRecord) check(safety.status === NO_RECORD || local.intent === 'unknown', `这不是一笔明确业务，应该待整理；实际业务类型是“${local.intent || '空'}”`);
  if (expected.route) check(expectedRouteMatches(expected.route, route), `应该走“${routeLabel(expected.route)}”，实际路由是“${routeLabel(route)}”`);
  if (expected.mustBlockOnAiFailure) {
    const aiStatus = (((hybrid || {}).ai_fallback) || {}).status;
    check(aiStatus === 'failed', `AI 模拟失败时必须明确标记失败，实际状态是“${aiStatus || '空'}”`);
    check(safety.status !== SAFE_LOCAL, 'AI 没有成功返回时，本地安全判断不能把这条内容当成可直接整理');
    const state = buildEmptySaveState();
    const stateBefore = JSON.stringify(state);
    const saved = saveConfirmedDraft(state, hybrid);
    check(saved.type === 'error', `AI 模拟失败后正式保存必须阻断，实际是“${saved.type}”`);
    check(JSON.stringify(state) === stateBefore, 'AI 模拟失败后正式保存必须零 mutation');
    check(state.orders.length === 0 && state.quotations.length === 0 && state.receivables.length === 0 && state.paymentRecords.length === 0, 'AI 模拟失败后不能生成任何正式业务记录');
  }
  check(compact(local.original_text) === compact(testCase.originalText), '原始输入没有被完整保留');

  return {
    pass: failures.length === 0,
    failures,
    actualRoute: route,
    actual: toPlainResult(local, safety),
    aiStatus: (((hybrid || {}).ai_fallback) || {}).status || '未记录',
    aiReason: ((((hybrid || {}).ai_fallback) || {}).reason) || ''
  };
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function categorySummary(results) {
  const grouped = {};
  results.forEach((result) => {
    const group = grouped[result.category] || { category: result.category, total: 0, passed: 0, failed: 0, criticalFailed: 0 };
    group.total += 1;
    if (result.pass) group.passed += 1;
    else {
      group.failed += 1;
      if (result.severity === 'critical') group.criticalFailed += 1;
    }
    grouped[result.category] = group;
  });
  return Object.values(grouped);
}

function renderHtml(results, generatedAt) {
  const total = results.length;
  const passed = results.filter((item) => item.pass).length;
  const failed = total - passed;
  const critical = results.filter((item) => !item.pass && item.severity === 'critical').length;
  const groups = categorySummary(results);
  const rows = results.map((item) => {
    const outcome = item.pass ? '通过' : '不通过';
    const reason = item.pass ? '本地识别、分流和（如适用）AI 失败后的保存保护符合这道题的要求。' : item.failures.join('；');
    const actual = item.actual;
    const actualText = [
      `业务：${actual.businessType}`,
      `客户：${actual.customer || '空'}`,
      `商品：${actual.products.join('、') || '空'}`,
      `数量：${actual.quantity || '空'}`,
      `单价：${actual.unitPrice || '空'}`,
      `金额：${actual.amount || '空'}`,
      `本次收款：${actual.paymentAmount || '空'}`,
      `交期：${actual.dueDate || '空'}`,
      `本地判断：${actual.safety || '空'}`,
      actual.safetyReasons.length ? `需要确认：${actual.safetyReasons.join('；')}` : ''
    ].filter(Boolean).join('；');
    return `<details class="case ${item.pass ? 'pass' : 'fail'}"><summary><b>${esc(item.id)}</b> · ${esc(item.category)} · <span>${outcome}</span> · ${esc(item.input)}</summary><dl><dt>老板输入</dt><dd>${esc(item.input)}</dd><dt>正确应该怎样</dt><dd>${esc(expectedSummary(item.expected))}</dd><dt>本地实际识别</dt><dd>${esc(actualText)}</dd><dt>本次是否该请求 AI</dt><dd>应当：${esc(routeLabel(item.expected.route))}；当前本地判断：${esc(routeLabel(item.actualRoute))}。<br>本次报告没有请求线上 AI；当前状态：${esc(item.aiStatus)}${item.aiReason ? `（${esc(item.aiReason)}）` : ''}</dd><dt>结论</dt><dd>${esc(reason)}</dd></dl></details>`;
  }).join('\n');
  const groupRows = groups.map((group) => `<tr><td>${esc(group.category)}</td><td>${group.total}</td><td>${group.passed}</td><td>${group.failed}</td><td>${group.criticalFailed}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>货小玲 1,490 题本地与路由测试结果</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f5f7fb;color:#1f2d3d;line-height:1.6}main{max-width:1100px;margin:auto;padding:28px 18px 50px}h1{font-size:26px;line-height:1.3}.note{background:#fff4de;border-left:4px solid #ef9f20;padding:14px 16px;border-radius:8px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.stat{background:#fff;border-radius:12px;padding:14px 18px;min-width:130px;box-shadow:0 2px 8px #243b5312}.stat b{display:block;font-size:25px}.bad{color:#c23a2b}table{width:100%;border-collapse:collapse;background:#fff;margin:20px 0}td,th{padding:9px;border:1px solid #e2e8f0;text-align:left}th{background:#eef5ff}details{background:#fff;border:1px solid #e5eaf2;border-radius:10px;padding:12px 14px;margin:10px 0}details.fail{border-left:5px solid #d84b40}details.pass{border-left:5px solid #38a169}summary{cursor:pointer}summary span{font-weight:700}dl{margin:12px 0 0}dt{font-weight:700;color:#346aa5;margin-top:9px}dd{margin:2px 0;white-space:pre-wrap;word-break:break-word}.filter{position:sticky;top:0;padding:10px 0;background:#f5f7fb}.filter input{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:11px;font-size:15px}</style></head><body><main><h1>货小玲：1,490 道“记一笔”本地识别与路由测试</h1><p>生成时间：${esc(generatedAt)}</p><div class="note"><b>这份结果逐题验证本地识别、三种处理路线，以及 AI 模拟失败后正式保存是否阻断、是否只有用户明确选择才保存为待整理。</b><br>没有调用线上 AI，因此绝不把这里的通过数说成“AI 已通过”。后续真实 AI 测试必须单独显示 AI 的实际回答、最终确认卡、保存结果和等待时间。</div><section class="stats"><div class="stat"><b>${total}</b>总题数</div><div class="stat"><b>${passed}</b>本地/路由通过</div><div class="stat"><b class="bad">${failed}</b>本地/路由不通过</div><div class="stat"><b class="bad">${critical}</b>严重不通过</div></section><h2>分类汇总</h2><table><thead><tr><th>分类</th><th>题数</th><th>通过</th><th>不通过</th><th>严重不通过</th></tr></thead><tbody>${groupRows}</tbody></table><h2>逐题对照</h2><div class="filter"><input id="query" placeholder="输入编号、分类、题目或结果关键词，例如：老板今、块钱、错别字"></div><div id="cases">${rows}</div></main><script>document.getElementById('query').addEventListener('input',function(e){var q=e.target.value.toLowerCase();document.querySelectorAll('.case').forEach(function(x){x.style.display=x.innerText.toLowerCase().includes(q)?'block':'none'})})</script></body></html>`;
}

async function main() {
  const results = [];
  for (const testCase of corpus) {
    const payload = {
      text: testCase.input,
      rawText: testCase.originalText,
      source: testCase.source,
      context: 'home',
      state: { customers: [], quotations: [], orders: [], receivables: [] },
      rawMessages: testCase.rawMessages,
      pasteMeta: buildCorpusPasteMeta(testCase),
      businessDate: testCase.businessDate,
      businessTimezone: testCase.businessTimezone
    };
    const parsed = parseInput(payload);
    const local = applyLocalParseSafety(parsed, {
      normalizedText: payload.rawText,
      originalText: payload.rawText,
      source: payload.source,
      businessDate: payload.businessDate,
      businessTimezone: payload.businessTimezone
    });
    const safety = local.local_parse_safety;
    if (!safety || !safety.status) {
      throw new Error(`${testCase.id} 没有拿到本地安全判断，测试不能继续给出结论`);
    }
    const hybrid = testCase.failureMode
      ? await simulateAiFailure(payload, testCase.failureMode)
      : await parseHybridInput(payload);
    const judged = evaluateCase(testCase, local, hybrid, safety);
    results.push(Object.assign({}, testCase, judged));
  }
  fs.mkdirSync(reportDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    scope: '验证本地证据门、四种处理结果（本地、一次快速 AI、需要深度核对、待整理）和 AI 模拟失败后的保存保护；没有请求线上 AI，也没有验证真实录音转文字或真机页面。',
    total: results.length,
    uniqueInputs: new Set(results.map((item) => `${item.source}|${item.input}`)).size,
    passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length,
    criticalFailed: results.filter((item) => !item.pass && item.severity === 'critical').length,
    categories: categorySummary(results),
    cases: results
  };
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(htmlPath, renderHtml(results, generatedAt));
  console.log(`题库：${report.total} 题（不同输入：${report.uniqueInputs} 道）`);
  console.log(`本地/路由通过：${report.passed} 题`);
  console.log(`本地/路由不通过：${report.failed} 题（其中严重：${report.criticalFailed} 题）`);
  console.log(`逐题报告：${htmlPath}`);
  console.log('说明：本次没有请求线上 AI，也没有将本地结果冒充 AI 结果；AI 失败保护使用本地模拟失败逐题验证。');
  if (report.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
