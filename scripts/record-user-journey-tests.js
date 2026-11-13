#!/usr/bin/env node
// Page methods + isolated wx storage + controlled transport; not a real AI/device test.
const assert = require('assert');
const { createPageHarness } = require('../tests/record-e2e/record-confirm-interaction-v1/runtime');
const { answerQuestion, submitOriginalText, tick } = require('../tests/record-e2e/record-confirm-interaction-v1/page-actions');
const { loadProductionPage, waitForPageParse } = require('../tests/record-e2e/runner/page-vm-driver');
const { createInitialState } = require('../utils/storage');
const { safeClone } = require('../utils/record-state-diff');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { BUSINESS_STORAGE_KEY } = require('../tests/record-e2e/runner/constants');
const { createEntryHarness, invokeDashboardSource } = require('../tests/record-e2e/record-entry-unification-v1/runtime');
const { parseChineseDateDetail } = require('../utils/date');
const { evaluateUserResolvedAiState } = require('../utils/parse-safety');
const { answerQuery } = require('../utils/query');
const { installFrozenClock } = require('../tests/record-e2e/runner/create-case-runtime');
const serverDates = require('../server/utils/date');
const clientDates = require('../utils/date');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const SIMPLE_ORDER = '王总订水杯100个，每个5元，8月15日交';
const MISSING_CUSTOMER = '下单：帆布袋500个，6元一个，8月15日交';

async function withPage(text, run, options = {}) {
  const h = createPageHarness(Object.assign({ text, caseId: 'user-journey' }, options));
  const before = safeClone(h.readState());
  try {
    await run(h, before);
    assert.strictEqual(h.network.audit().realNetworkRequests, 0);
  } catch (error) {
    const d = h.page.data, r = d.parseResult || {};
    error.journeyEvidence = {
      phase: d.conversationPhase, question: d.activeQuestion && d.activeQuestion.target,
      fields: d.fields, missing: r.missing_fields, low: r.low_confidence_fields,
      conflicts: (r.field_conflicts || []).map((c) => ({ field: c.field, itemField: c.itemField, code: c.code })),
      route: r.parse_route, ai: r.ai_fallback,
      blocking: d.domainPreflight && d.domainPreflight.blockingIssues.map((issue) => issue.code)
    };
    throw error;
  } finally { h.dispose(); }
}

function unchanged(h, before) {
  assert.deepStrictEqual(h.readState(), before, '确认前不应写入任何业务内容');
  assert.strictEqual(h.driver.evidence.productionStorageCalls.saveState, 0);
}

function question(h, field) {
  const q = h.page.data.activeQuestion;
  assert(q && q.target.field === field, `应追问${field}，实际${q && q.target.field || h.page.data.conversationPhase}`);
  assert.strictEqual(h.page.data.conversationPhase, 'CLARIFYING');
  assert.strictEqual(h.page.data.assistantQuestions.length, 1);
  assert.strictEqual(h.page.data.disableFormalSave, true);
  return safeClone(q);
}

function readDetail(h, type, record) {
  const list = loadProductionPage('RECORD_LIST', { fakeWx: h.fakeWx }, {
    caseId: 'journey-records-readback', ai: { profile: 'LOCAL_ONLY' }
  });
  assert(list.page.data.records.some((item) => item.type === type && (item.sourceId || item.id) === record.id),
    '保存后的记录应在实际记录页中可见');
  const driver = loadProductionPage('RECORD_DETAIL', { fakeWx: h.fakeWx }, {
    caseId: 'journey-readback', ai: { profile: 'LOCAL_ONLY' }
  }, { onLoadOptions: { type, id: record.id } });
  const detail = driver.page.data.detail;
  assert.strictEqual(driver.page.data.notFound, false);
  assert.strictEqual(detail.record.id, record.id);
  assert.strictEqual(detail.originalText, record.originalText);
  assert.strictEqual(detail.customerId, type === 'pending' ? '' : record.customerId);
  return detail;
}

async function saveAndRead(h, type, collection, text, expectedCount = 1) {
  assert.strictEqual(h.page.data.conversationPhase, 'CONFIRMING');
  assert.strictEqual(h.page.data.disableFormalSave, false, JSON.stringify(h.page.data.domainBlockingLines));
  await Promise.resolve(h.page.saveFormal());
  await tick();
  const state = h.readState();
  assert.strictEqual(state[collection].length, expectedCount);
  const record = state[collection][0];
  assert.strictEqual(record.originalText, text);
  readDetail(h, type, record);
  const snapshot = safeClone(state);
  await Promise.resolve(h.page.saveFormal());
  await tick();
  assert.deepStrictEqual(h.readState(), snapshot, '重复点击不能重复保存');
  assert.strictEqual(h.driver.evidence.productionBusinessCalls.saveConfirmedDraft, 1);
  assert.strictEqual(h.driver.evidence.productionStorageCalls.saveState, 1);
  return { record, state };
}

for (const [name, text, type, collection] of [
  ['明确订单', SIMPLE_ORDER, 'order', 'orders'],
  ['明确报价', '给王总报价水杯100个，每个5元', 'quotation', 'quotations'],
  ['明确待收款', '王总还欠3000元，8月15日收', 'receivable', 'receivables']
]) {
  test(`${name}：输入后确认、一次保存、详情重读`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    assert.strictEqual(h.network.aiEvents().length, 0);
    const saved = await saveAndRead(h, type, collection, text);
    if (type === 'receivable') {
      assert.strictEqual(saved.record.amount, '3000');
      assert.strictEqual(saved.record.dueDate, '2026-08-15');
    } else {
      assert.strictEqual(saved.record.totalAmount, '500');
      assert.strictEqual(saved.record.items[0].productName, '水杯');
      assert.strictEqual(saved.record.items[0].quantity, '100');
      assert.strictEqual(saved.record.items[0].unitPrice, '5');
    }
    if (type === 'order') {
      assert.strictEqual(saved.record.totalAmount, '500');
      const list = loadProductionPage('ORDER_LIST', { fakeWx: h.fakeWx }, { caseId: 'journey-list', ai: { profile: 'LOCAL_ONLY' } });
      assert(list.page.data.orders.some((record) => record.id === saved.record.id));
    }
  }));
}

for (const [type, text, collection] of [
  ['order', MISSING_CUSTOMER, 'orders'],
  ['quotation', '报价：帆布袋500个，6元一个', 'quotations']
]) {
  test(`${type}只缺客户：问清称呼后可确认保存，原话保留`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    question(h, 'customerName');
    unchanged(h, before);
    await Promise.resolve(h.page.saveFormal());
    unchanged(h, before);
    await answerQuestion(h.page, '张总');
    assert.strictEqual(h.page.data.fields.customerName, '张总');
    unchanged(h, before);
    const saved = await saveAndRead(h, type, collection, text);
    assert.strictEqual(saved.state.customers[0].name, '张总');
    assert.strictEqual(saved.record.items[0].productName, '帆布袋');
    assert.strictEqual(saved.record.totalAmount, '3000');
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

test('只缺商品：回答后保存，不能让AI猜商品', () => withPage('王总要500个，单价6元，8月15日交', async (h, before) => {
  const text = '王总要500个，单价6元，8月15日交';
  await submitOriginalText(h.page, text);
  question(h, 'productName');
  await answerQuestion(h.page, '帆布袋');
  unchanged(h, before);
  const { record } = await saveAndRead(h, 'order', 'orders', text);
  assert.strictEqual(record.items[0].productName, '帆布袋');
  assert.strictEqual(record.totalAmount, '3000');
  assert.strictEqual(h.network.aiEvents().length, 0);
}));

test('只缺交期：回答日期后保存，原话与交期分别保留', () => withPage('王总订水杯100个，每个5元', async (h, before) => {
  const text = '王总订水杯100个，每个5元';
  await submitOriginalText(h.page, text);
  question(h, 'dueDate');
  await answerQuestion(h.page, '2026年8月15日');
  unchanged(h, before);
  const { record } = await saveAndRead(h, 'order', 'orders', text);
  assert.strictEqual(record.requiredDeliveryDate, '2026-08-15');
  assert.strictEqual(h.network.aiEvents().length, 0);
}));

async function answerOnSurface(page, value) {
  const q = safeClone(page.data.activeQuestion);
  assert(q, '可见页面应有当前问题');
  page.updateAssistantAnswer({ detail: { value } });
  const result = await Promise.resolve(page.submitAssistantAnswer({ currentTarget: { dataset: {
    questionId: q.questionId, revision: q.draftRevision, originalTextFingerprint: q.originalTextFingerprint,
    field: q.target.field, fieldPath: q.target.fieldPath, itemKey: q.target.itemKey
  } } }));
  await tick();
  return result;
}

for (const answer of ['5天后', '5天之后', '五天之后', '5天以后']) {
  test(`相对交期${answer}：正常日期补答、原话保留且不联网`, () => withPage('孙总定了椅子80把，289一把', async (h, before) => {
    await submitOriginalText(h.page, '孙总定了椅子80把，289一把');
    question(h, 'dueDate');
    const result = await answerOnSurface(h.page, answer);
    assert.strictEqual(result.accepted, true, result.code);
    assert.strictEqual(h.page.data.conversationPhase, 'CONFIRMING');
    assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
    assert.strictEqual(h.page.data.fields.amount, '23120');
    assert.strictEqual(h.page.data.fields.customerName, '孙总');
    assert.strictEqual(h.page.data.parseResult.original_text, '孙总定了椅子80把，289一把');
    assert.strictEqual(evaluateUserResolvedAiState(h.page.data.parseResult).trustedEditCount, 1);
    unchanged(h, before);
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

test('首页原样案例：交期后具体确认计价单位，保存一次并回查', async () => {
  const text = '孙总定了椅子80个，289一把';
  const entry = createEntryHarness({ caseId: 'relative-delivery-home' });
  const h = Object.assign({}, entry, { page: entry.input.page, driver: entry.input });
  const before = safeClone(h.readState());
  try {
    await invokeDashboardSource(entry, 'typed', text);
    await entry.followInputNavigation();
    const dateQuestion = question(h, 'dueDate');
    const result = await answerOnSurface(h.page, '5天之后');
    assert.strictEqual(result.accepted, true, result.code);
    const unitQuestion = question(h, 'priceUnit');
    assert(unitQuestion.target.itemKey, '计价单位问题必须绑定具体商品');
    assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
    assert.strictEqual(evaluateUserResolvedAiState(h.page.data.parseResult).trustedEditCount, 1);
    assert.strictEqual(h.page.data.fields.amount || '', '', '未确认单位前不能猜金额');
    unchanged(h, before);
    const replay = h.page.answerAssistantQuestion({ detail: {
      questionId: dateQuestion.questionId, draftRevision: dateQuestion.draftRevision,
      originalTextFingerprint: dateQuestion.originalTextFingerprint,
      target: dateQuestion.target, value: '1天后'
    } });
    assert.strictEqual(replay.accepted, false, '旧日期问题不能替代当前单位问题');
    assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
    for (const invalid of ['把', '箱', '万个', '万把', '万箱', '万kg', '个，数量改1']) {
      const rejected = await answerOnSurface(h.page, invalid);
      assert.strictEqual(rejected.accepted, false, invalid);
      assert.strictEqual(h.page.data.activeQuestion.questionId, unitQuestion.questionId);
      assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
      assert.strictEqual(h.page.data.fields.amount || '', '');
      assert.strictEqual(evaluateUserResolvedAiState(h.page.data.parseResult).trustedEditCount, 1);
      unchanged(h, before);
    }
    const confirmed = await answerOnSurface(h.page, '个');
    assert.strictEqual(confirmed.accepted, true, confirmed.code);
    assert.strictEqual(h.page.data.conversationPhase, 'CONFIRMING');
    assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
    assert.strictEqual(h.page.data.fields.amount, '23120');
    assert.strictEqual(evaluateUserResolvedAiState(h.page.data.parseResult).trustedEditCount, 2);
    unchanged(h, before);
    const { record, state } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.requiredDeliveryDate, '2026-08-10');
    assert.strictEqual(record.totalAmount, '23120');
    assert.strictEqual(record.items[0].quantity, '80');
    assert.strictEqual(record.items[0].unitPrice, '289');
    const resultQuery = answerQuery('孙总订单怎么样', state);
    assert(resultQuery.lines.join('\n').includes('椅子'), JSON.stringify(resultQuery));
    assert.strictEqual(h.network.aiEvents().length, 0);
    assert.strictEqual(h.network.audit().realNetworkRequests, 0);
  } finally { entry.dispose(); }
});

test('相对交期整段校验：无效和夹带改价不消耗问题，随后仍可正常补答', () => withPage('孙总定了椅子80把，289一把', async (h, before) => {
  await submitOriginalText(h.page, '孙总定了椅子80把，289一把');
  const q = question(h, 'dueDate');
  for (const invalid of ['下周', '5号', '5天之后左右', '5天之后，单价改1元', '5天之后或6天之后', '-1天之后', '负五天之后', '1.5天之后', '999999999999999999天之后', '999999999999999999周后']) {
    const result = await answerOnSurface(h.page, invalid);
    assert.strictEqual(result.accepted, false, invalid);
    assert.strictEqual(h.page.data.activeQuestion.questionId, q.questionId);
    assert.strictEqual(h.page.data.fields.dueDate || '', '');
    unchanged(h, before);
  }
  assert.strictEqual((await answerOnSurface(h.page, '五天之后')).accepted, true);
  assert.strictEqual(h.page.data.fields.unitPrice, '289');
  assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
  unchanged(h, before);
}));

test('相对日期共享语法：跨月跨年，并以明确业务日为基准', () => {
  for (const [base, expected] of [['2026-11-13', '2026-11-18'], ['2026-11-29', '2026-12-04'], ['2026-12-29', '2027-01-03']]) {
    for (const answer of ['5天后', '五天之后', '5 天之后', '5天以后']) {
      const detail = parseChineseDateDetail(answer, base);
      assert.strictEqual(detail.date, expected, base + '/' + answer);
      assert.strictEqual(detail.matchedText, answer);
      assert.strictEqual(detail.ambiguous, false);
      assert.strictEqual(detail.invalid, false);
    }
  }
  for (const invalid of ['-5天之后', '负五天之后', '1.5天之后', '999999999999999999天之后', '1e3天之后']) {
    const detail = parseChineseDateDetail(`孙总椅子80把，289一把，${invalid}交货`, '2026-11-13');
    assert.strictEqual(detail.date, '', invalid);
    assert.strictEqual(detail.invalid, true, invalid);
  }
});

test('跨午夜补交期仍使用问题绑定日期，不改按回答日计算', () => withPage('孙总定了椅子80把，289一把', async (h, before) => {
  await submitOriginalText(h.page, '孙总定了椅子80把，289一把');
  const q = question(h, 'dueDate');
  assert.strictEqual(q.businessDate, '2026-08-05');
  const restoreLaterClock = installFrozenClock('2026-08-06T00:01:00+08:00', 'relative-answer-next-day');
  try {
    assert.strictEqual((await answerOnSurface(h.page, '5天之后')).accepted, true);
    assert.strictEqual(h.page.data.fields.dueDate, '2026-08-10');
    const proof = h.page.data.parseResult.user_manual_edits.find(p => p.field === 'dueDate');
    assert.strictEqual(proof.questionBusinessDate, '2026-08-05');
    assert.strictEqual(h.page.data.conversationPhase, 'CONFIRMING');
    unchanged(h, before);
  } finally { restoreLaterClock(); }
}));

const COMMON_DELIVERY_ANSWERS = [
  ['11月底', '2026-11-30'], ['十一月底', '2026-11-30'],
  ['12月底', '2026-12-31'], ['本月底', '2026-08-31'],
  ['这个月末', '2026-08-31'], ['下月底', '2026-09-30'],
  ['下个月底', '2026-09-30'], ['下下个月底', '2026-10-31'],
  ['半个月后', '2026-08-20'], ['半月之后', '2026-08-20'],
  ['3周之后', '2026-08-26'], ['三周以后', '2026-08-26'],
  ['两个星期以后', '2026-08-19'], ['20天后', '2026-08-25'],
  ['一个月后', '2026-09-05'], ['两个月之后', '2026-10-05'],
  ['11月30号', '2026-11-30'], ['十一月三十日', '2026-11-30'],
  ['二〇二六年十一月三十号', '2026-11-30'], ['明年二月底', '2027-02-28'],
  ['11月底交货', '2026-11-30'], ['交期是下个月底', '2026-09-30'], ['定在半个月后。', '2026-08-20'],
  ['明年的11月底', '2027-11-30'], ['2027年的11月30号', '2027-11-30'],
  ['12月的月底', '2026-12-31'], ['下个月的月底', '2026-09-30']
];

for (const [answer, expected] of COMMON_DELIVERY_ANSWERS) {
  test(`常见交期${answer}：补答、保存、详情及查询日期一致`, () => withPage('孙总定了椅子80把，289一把', async (h, before) => {
    const text = '孙总定了椅子80把，289一把';
    await submitOriginalText(h.page, text);
    const q = question(h, 'dueDate');
    const result = await answerOnSurface(h.page, answer);
    assert.strictEqual(result.accepted, true, result.code);
    assert.strictEqual(h.page.data.conversationPhase, 'CONFIRMING');
    assert.strictEqual(h.page.data.fields.dueDate, expected);
    assert.strictEqual(h.page.data.fields.amount, '23120');
    assert.strictEqual(h.page.data.parseResult.original_text, text);
    const proof = h.page.data.parseResult.user_manual_edits.find(p => p.field === 'dueDate');
    assert(proof && proof.questionBusinessDate === q.businessDate, '日期证明仍绑定原问题业务日');
    unchanged(h, before);
    const { record, state } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.requiredDeliveryDate, expected);
    const resultQuery = answerQuery('孙总订单怎么样', state);
    assert(resultQuery.lines.join('\n').includes(expected), JSON.stringify(resultQuery));
    assert(resultQuery.lines.join('\n').includes('椅子'), JSON.stringify(resultQuery));
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

for (const [phrase, expected] of [
  ['十一月底', '2026-11-30'], ['下个月底', '2026-09-30'],
  ['半个月后', '2026-08-20'], ['3周之后', '2026-08-26'], ['11月30号', '2026-11-30']
]) {
  test(`原话直接带交期${phrase}：首次解析可保存并读回`, () => withPage('', async (h, before) => {
    const text = `孙总定了椅子80把，289一把，${phrase}交货`;
    await submitOriginalText(h.page, text);
    assert.strictEqual(h.page.data.conversationPhase, 'CONFIRMING');
    assert.strictEqual(h.page.data.fields.dueDate, expected);
    unchanged(h, before);
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.requiredDeliveryDate, expected);
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

test('常见日期共享语法：前后台同结果，月份限定及跨年闰年不丢失', () => {
  const cases = COMMON_DELIVERY_ANSWERS.filter(([phrase]) => !/交货|交期是|定在/.test(phrase))
    .map(([phrase, expected]) => ['2026-08-05', phrase, expected]).concat([
    ['2026-11-13', '11月底', '2026-11-30'], ['2026-11-13', '12月底', '2026-12-31'],
    ['2026-11-13', '下个月底', '2026-12-31'], ['2026-11-13', '20天之后', '2026-12-03'],
    ['2026-11-13', '半个月以后', '2026-11-28'], ['2026-11-13', '三周后', '2026-12-04'],
    ['2026-12-05', '下个月底', '2027-01-31'], ['2026-12-20', '3周之后', '2027-01-10'],
    ['2026-01-31', '半个月后', '2026-02-15'], ['2026-01-31', '一个月后', '2026-02-28'],
    ['2028-01-31', '一个月后', '2028-02-29'], ['2026-12-31', '两个月后', '2027-02-28'],
    ['2026-11-13', '2028年2月底', '2028-02-29'], ['2026-11-13', '2027年2月末', '2027-02-28'],
    ['2026-11-13', '明年一月底', '2027-01-31'], ['2026-11-13', '今年一月底', '2026-01-31'],
    ['2028-02-10', '20天后', '2028-03-01'], ['2027-02-10', '20天后', '2027-03-02'],
    ['2026-11-13', '下周五', '2026-11-20'], ['2026-11-13', '下下周五', '2026-11-27'],
    ['2026-11-13', '上周五', '2026-11-06'], ['2026-11-13', '11 / 30', '2026-11-30'],
    ['2026-11-13', '2026 年 11 月 30 号', '2026-11-30'], ['2026-11-13', '下个月二十号', '2026-12-20'],
    ['2026-11-13', '明年十一月三十号', '2027-11-30']
  ]);
  for (const [base, phrase, expected] of cases) {
    const detail = clientDates.parseChineseDateDetail(phrase, base);
    assert.strictEqual(detail.date, expected, base + '/' + phrase);
    assert.strictEqual(detail.matchedText, phrase, phrase);
    assert.strictEqual(detail.invalid, false, phrase);
    assert.strictEqual(detail.ambiguous, false, phrase);
    assert.deepStrictEqual(serverDates.parseChineseDateDetail(phrase, base), detail, '前后台：' + phrase);
    assert.strictEqual(serverDates.parseChineseDate(phrase, base), expected);
  }
});

test('无效或不明确日期不截尾当成其他日期，前后台一致', () => {
  for (const phrase of [
    '13月底', '0月底', '-1月底', '1.5月底', '2027年2月29号', '11月31号', '2026年13月末',
    '-3周之后', '负三周后', '1.5周之后', '1e3周后', '999999999999999999周后',
    '999999999999999999个月后', '一个半月后', '几周后', '两三周后', '三五天后',
    '下个月', '下周', '下周末', '周末', '20号', '月中', '20个工作日后',
    '11月底左右', '明天或后天', '11月底或12月底', '不是11月30日', '二〇天后',
    '半月后（按工作日）', '一年半月后', '一年两个月后', '一个月三周后', '三个月20天后'
  ]) {
    const detail = clientDates.parseChineseDateDetail(phrase, '2026-11-13');
    assert.strictEqual(clientDates.parseChineseDate(phrase, '2026-11-13'), '', phrase);
    assert.strictEqual(detail.date, '', phrase);
    assert.deepStrictEqual(serverDates.parseChineseDateDetail(phrase, '2026-11-13'), detail, phrase);
  }
});

for (const phrase of ['11月底左右', '明天或后天', '11月底或12月底', '不是11月30日', '20天后（按工作日）']) {
  test(`原话不明确交期${phrase}也不能直接定日期`, () => withPage('', async (h, before) => {
    await submitOriginalText(h.page, `孙总定了椅子80把，289一把，${phrase}交货`);
    assert.strictEqual(h.page.data.fields.dueDate || '', '', phrase);
    assert.strictEqual(h.page.data.disableFormalSave, true);
    unchanged(h, before);
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

test('月底等无效补答保留问题和原字段，随后仍可正常作答', () => withPage('孙总定了椅子80把，289一把', async (h, before) => {
  await submitOriginalText(h.page, '孙总定了椅子80把，289一把');
  const q = question(h, 'dueDate');
  for (const phrase of ['下个月', '11月底左右', '11月31号', '13月底', '2027年2月29号',
    '11月底或12月底', '不是11月30日', '11月底，单价改1元', '差不多20天后',
    '一个半月后', '三五天后', '20个工作日后', '交期不是11月底',
    '11月底左右交', '11月底或12月1日交', '11月底交货，单价改1元', '11月底交货？', '下周五下午交']) {
    const response = await answerOnSurface(h.page, phrase);
    assert.strictEqual(response.accepted, false, phrase);
    assert.strictEqual(h.page.data.activeQuestion.questionId, q.questionId);
    assert.strictEqual(h.page.data.fields.dueDate || '', '');
    assert.strictEqual(h.page.data.fields.unitPrice, '289');
    assert.strictEqual(evaluateUserResolvedAiState(h.page.data.parseResult).trustedEditCount, 0);
    unchanged(h, before);
  }
  assert.strictEqual((await answerOnSurface(h.page, '十一月底')).accepted, true);
  assert.strictEqual(h.page.data.fields.dueDate, '2026-11-30');
  unchanged(h, before);
}));

for (const text of [
  '孙总定了椅子80个，289一把，8月15日交，定金100元',
  '孙总定了椅子80个，289一把，8月15日交，外箱印logo',
  '孙总定了椅子80个，289一把；水杯2个，5元一个，8月15日交',
  '不要记录孙总定了椅子80个，289一把，8月15日交'
]) {
  test(`单位补问不替代资金、多商品或特殊要求核对：${text}`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    assert.notStrictEqual(h.page.data.activeQuestion && h.page.data.activeQuestion.target.field, 'priceUnit');
    assert.notStrictEqual((h.page.data.parseResult.parse_route || {}).decision, 'local');
    assert.strictEqual(h.page.data.disableFormalSave, true);
    unchanged(h, before);
  }));
}

test('缺客户和交期：一次只问一个，未补齐前不能保存', () => withPage('下单：帆布袋500个，6元一个', async (h, before) => {
  const text = '下单：帆布袋500个，6元一个';
  await submitOriginalText(h.page, text);
  question(h, 'customerName');
  await answerQuestion(h.page, '张总');
  question(h, 'dueDate');
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
  await answerQuestion(h.page, '2026年8月15日');
  await saveAndRead(h, 'order', 'orders', text);
}));

test('原话修改后旧问题的回答不能落到新订单', () => withPage(MISSING_CUSTOMER, async (h, before) => {
  await submitOriginalText(h.page, MISSING_CUSTOMER);
  const old = question(h, 'customerName');
  await submitOriginalText(h.page, SIMPLE_ORDER);
  const response = await h.page.answerAssistantQuestion({ detail: {
    questionId: old.questionId, draftRevision: old.draftRevision,
    originalTextFingerprint: old.originalTextFingerprint, target: old.target, value: '张总'
  } });
  assert.strictEqual(response.accepted, false);
  assert.strictEqual(h.page.data.fields.customerName, '王总');
  unchanged(h, before);
}));

test('空输入与闲聊不产生业务或待整理记录', () => withPage('', async (h, before) => {
  await submitOriginalText(h.page, '   ');
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
  await submitOriginalText(h.page, '今天天气不错，晚点出去走走');
  assert.strictEqual(h.page.data.isNoRecord, true);
  await Promise.resolve(h.page.saveFormal());
  await Promise.resolve(h.page.savePending());
  unchanged(h, before);
}));

test('金额冲突时先问总额，未确认不能保存', () => withPage('王总订水杯100个，每个5元，总价600元，8月15日交', async (h, before) => {
  await submitOriginalText(h.page, '王总订水杯100个，每个5元，总价600元，8月15日交');
  question(h, 'amount');
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
}));

for (const mode of ['TIMEOUT', 'HTTP_500', 'EMPTY_PAYLOAD']) {
  test(`智能核对${mode}：保留原话、阻止保存、可返回修改`, () => withPage('王总今天付了300元', async (h, before) => {
    const text = '王总今天付了300元';
    await submitOriginalText(h.page, text);
    assert.strictEqual(h.network.aiEvents().length, 1);
    assert.strictEqual(h.page.data.conversationPhase, 'SAFE_BLOCKED');
    assert.strictEqual(h.page.data.parseResult.original_text, text);
    await Promise.resolve(h.page.saveFormal());
    unchanged(h, before);
    h.page.returnToInput();
    assert.strictEqual(h.page.data.text, text);
    unchanged(h, before);
  }, { networkMode: mode }));
}

function financialState() {
  const state = createInitialState();
  state.customers.push({ id: 'journey-wang', name: '王总', userId: 'local-user' });
  state.receivables.push({ id: 'journey-rec', customerId: 'journey-wang', amount: '1000', paidAmount: '200', status: '部分收款', source: 'manual', orderId: '' });
  return state;
}

function paymentResponse(overrides = {}) {
  return Object.assign({
    provider: 'controlled-transport-fixture', intent: 'payment', operation: 'record_payment',
    fields: { customerName: '王总', paymentAmount: '300', dueDate: '2026-08-05' },
    low_confidence_fields: ['receivableId'], missing_fields: [], field_conflicts: [], confidence: 0.99
  }, safeClone(overrides));
}

function selectReceivable(h, predicate = (option) => option.id === 'journey-rec') {
  const index = h.page.data.receivableOptions.findIndex(predicate);
  assert(index >= 0, '页面应提供对应的用户选择');
  return h.page.changeReceivable({ detail: { value: index } });
}

test('受控收款成功：亲自选待收后才可保存，余额与详情正确', () => withPage('王总今天付了300元', async (h, before) => {
  const text = '王总今天付了300元';
  await submitOriginalText(h.page, text);
  assert.strictEqual(h.page.data.disableFormalSave, true);
  unchanged(h, before);
  const index = h.page.data.receivableOptions.findIndex((option) => option.id === 'journey-rec');
  assert(index >= 0);
  h.page.changeReceivable({ detail: { value: index } });
  unchanged(h, before);
  const { record, state } = await saveAndRead(h, 'payment', 'paymentRecords', text);
  assert.strictEqual(record.receivableId, 'journey-rec');
  assert.strictEqual(record.kind, 'partial_payment');
  assert.strictEqual(record.amount, '300');
  assert.strictEqual(record.customerId, 'journey-wang');
  assert.strictEqual(record.paidAt, '2026-08-05');
  assert.strictEqual(state.receivables[0].paidAmount, '500');
}, { initialState: financialState(), response: paymentResponse() }));

test('明确不关联待收：仅记收款，原待收余额不变', () => withPage('王总今天付了300元', async (h, before) => {
  const text = '王总今天付了300元';
  await submitOriginalText(h.page, text);
  selectReceivable(h, (option) => option.label.includes('不关联'));
  unchanged(h, before);
  const { record, state } = await saveAndRead(h, 'payment', 'paymentRecords', text);
  assert.strictEqual(record.kind, 'unlinked_payment');
  assert.strictEqual(record.receivableId, '');
  assert.strictEqual(state.receivables[0].paidAmount, '200');
}, { initialState: financialState(), response: paymentResponse() }));

test('智能建议不代替亲自确认，重复点选不增加确认或业务记录', () => withPage('王总今天付了300元', async (h, before) => {
  await submitOriginalText(h.page, '王总今天付了300元');
  assert.strictEqual(h.page.data.fields.receivableId, undefined);
  assert.strictEqual(h.page.data.disableFormalSave, true);
  selectReceivable(h);
  const proofCount = h.page.data.parseResult.user_manual_edits.length;
  assert.strictEqual(proofCount, 1);
  selectReceivable(h);
  assert.strictEqual(h.page.data.parseResult.user_manual_edits.length, proofCount);
  unchanged(h, before);
  const { state } = await saveAndRead(h, 'payment', 'paymentRecords', '王总今天付了300元');
  assert.strictEqual(state.receivables[0].paidAmount, '500');
}, { initialState: financialState(), response: paymentResponse({
  fields: { customerName: '王总', paymentAmount: '300', dueDate: '2026-08-05', receivableId: 'journey-rec' }
}) }));

test('选待收不能同时清除仍不确定的收款金额', () => withPage('王总今天付了300元', async (h, before) => {
  await submitOriginalText(h.page, '王总今天付了300元');
  selectReceivable(h);
  assert.strictEqual(h.page.data.disableFormalSave, true);
  assert(h.page.data.parseResult.low_confidence_fields.includes('paymentAmount'));
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
}, { initialState: financialState(), response: paymentResponse({ low_confidence_fields: ['receivableId', 'paymentAmount'] }) }));

test('待收确认不能授权超额收款', () => withPage('王总今天付了900元', async (h, before) => {
  await submitOriginalText(h.page, '王总今天付了900元');
  selectReceivable(h);
  assert.strictEqual(h.page.data.fields.paymentAmount, '900');
  assert.strictEqual(h.page.data.disableFormalSave, true);
  assert(h.page.data.domainPreflight.blockingIssues.some((issue) => issue.code === 'RECEIVABLE_PAYMENT_INVALID'));
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
}, { initialState: financialState(), response: paymentResponse({
  fields: { customerName: '王总', paymentAmount: '900', dueDate: '2026-08-05' }
}) }));

for (const change of ['settled', 'foreignCustomer']) {
  test(`待收在其他页面${change}后，旧选项不能继续确认`, () => withPage('王总今天付了300元', async (h) => {
    await submitOriginalText(h.page, '王总今天付了300元');
    const concurrent = h.readState();
    if (change === 'settled') {
      concurrent.receivables[0].status = '已结清';
      concurrent.receivables[0].paidAmount = '1000';
    } else {
      concurrent.customers.push({ id: 'journey-li', name: '李总', userId: 'local-user' });
      concurrent.receivables[0].customerId = 'journey-li';
    }
    // Isolated fixture mutation simulates another page's newer persisted state.
    h.fakeWx.wx.setStorageSync(BUSINESS_STORAGE_KEY, concurrent);
    assert.strictEqual(selectReceivable(h), false);
    await Promise.resolve(h.page.saveFormal());
    unchanged(h, concurrent);
    assert.strictEqual((h.page.data.parseResult.user_manual_edits || []).length, 0);
  }, { initialState: financialState(), response: paymentResponse() }));
}

test('普通对象伪造已选待收不能替代真实确认', () => withPage('王总今天付了300元', async (h, before) => {
  await submitOriginalText(h.page, '王总今天付了300元');
  const forged = safeClone(h.page.data.parseResult);
  forged.fields.receivableId = 'journey-rec';
  forged.fields.receivableSelectionConfirmed = true;
  forged.manual_fields = ['receivableId'];
  const checked = applyFinalParseSafety(forged, { businessDate: '2026-08-05' });
  assert.strictEqual(checked.user_resolution.allRisksResolved, false);
  assert(checked.low_confidence_fields.includes('receivableId'));
  unchanged(h, before);
}, { initialState: financialState(), response: paymentResponse() }));

test('真实待收确认的凭据不能复制到另一金额或客户', () => withPage('王总今天付了300元', async (h, before) => {
  await submitOriginalText(h.page, '王总今天付了300元');
  selectReceivable(h);
  const draft = h.page.data.parseResult;
  assert.strictEqual(draft.user_resolution.allRisksResolved, true);
  for (const [field, value] of [['paymentAmount', '1'], ['customerId', 'journey-li']]) {
    const forged = safeClone(draft);
    forged.fields[field] = value;
    const checked = applyFinalParseSafety(forged, { businessDate: '2026-08-05' });
    assert.strictEqual(checked.user_manual_edits.length, 0);
    assert.strictEqual(checked.user_resolution.allRisksResolved, false);
  }
  unchanged(h, before);
}, { initialState: financialState(), response: paymentResponse() }));

test('空回答不消耗当前问题，不补造客户', () => withPage(MISSING_CUSTOMER, async (h, before) => {
  await submitOriginalText(h.page, MISSING_CUSTOMER);
  const old = question(h, 'customerName');
  await answerQuestion(h.page, '   ');
  assert.strictEqual(h.page.data.activeQuestion.questionId, old.questionId);
  assert.strictEqual(h.page.data.fields.customerName, '');
  unchanged(h, before);
}));

test('含定金的复杂订单缺客户时继续专项核对，失败不能直接保存', () => withPage('下单：帆布袋500个，6元一个，8月15日交，收到定金300元', async (h, before) => {
  const text = '下单：帆布袋500个，6元一个，8月15日交，收到定金300元';
  await submitOriginalText(h.page, text);
  assert.strictEqual(h.page.data.conversationPhase, 'SAFE_BLOCKED');
  assert.strictEqual(h.network.aiEvents().length, 1);
  assert.strictEqual(h.page.data.parseResult.original_text, text);
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
}, { networkMode: 'HTTP_500' }));

test('补充的客户同名时保留人工区分要求', () => withPage(MISSING_CUSTOMER, async (h, before) => {
  await submitOriginalText(h.page, MISSING_CUSTOMER);
  await answerQuestion(h.page, '王总');
  assert.strictEqual(h.page.data.customerMatchBlocksSave, true);
  assert.strictEqual(h.page.data.disableFormalSave, true);
  await Promise.resolve(h.page.saveFormal());
  unchanged(h, before);
}, { initialState: Object.assign(createInitialState(), { customers: [
  { id: 'wang-a', name: '王总', wechatRemark: '一厂' },
  { id: 'wang-b', name: '王总', wechatRemark: '二厂' }
] }) }));

test('长输入保留原话后仍可保存并从详情重读', () => {
  const text = SIMPLE_ORDER + '\n' + ' '.repeat(2000);
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    await saveAndRead(h, 'order', 'orders', text);
  });
});

for (const [text, type, collection, answers] of [
  ['记一单帆布袋500个，6元一个，8月15日交', 'order', 'orders', [['customerName', '张总']]],
  ['请帮我记一单帆布袋500个，6元一个，8月15日交', 'order', 'orders', [['customerName', '张总']]],
  ['给王总记一单帆布袋500个，6元一个，8月15日交', 'order', 'orders', []],
  ['帮我记一单，王总要帆布袋500个，6元一个，8月15日交', 'order', 'orders', []],
  ['记个订单，帆布袋500个，6元一个，8月15日交', 'order', 'orders', [['customerName', '张总']]],
  ['记一下报价，帆布袋500个，6元一个', 'quotation', 'quotations', [['customerName', '张总']]],
  ['帮我记一单帆布袋500个，单价6元', 'order', 'orders', [['customerName', '张总'], ['dueDate', '8月15日']]],
  ['记一笔：给王总报价帆布袋500个，每个6元', 'quotation', 'quotations', []]
]) {
  test(`常用说法完整保存：${text}`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    for (const [field, answer] of answers) {
      question(h, field);
      await answerQuestion(h.page, answer);
      unchanged(h, before);
    }
    const { record, state } = await saveAndRead(h, type, collection, text);
    assert.strictEqual(record.items[0].productName, '帆布袋');
    assert.strictEqual(record.totalAmount, '3000');
    assert.strictEqual(state.customers[0].name, answers.length ? '张总' : '王总');
    if (type === 'order') assert.strictEqual(record.requiredDeliveryDate, '2026-08-15');
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}
for (const text of ['先别记一单，王总帆布袋500个，6元一个，8月15日交',
  '不要记一单帆布袋500个，6元一个', '记一笔帆布袋500个，6元一个',
  '要不要记一单，王总帆布袋500个，6元一个，8月15日交',
  '记一单，王总帆布袋500个，6元一个，8月15日交，还没下单',
  '记一下报价，王总帆布袋500个，单价6元，暂时不报价']) {
  test(`否定或模糊指令不能正式保存：${text}`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    assert.strictEqual(h.page.data.disableFormalSave, true);
    await Promise.resolve(h.page.saveFormal());
    unchanged(h, before);
    assert.strictEqual(h.page.data.parseResult.original_text, text);
  }));
}

for (const [text, customerAnswer, blocked] of [
  ['给王总记一单帆布袋500个，6元一个，8月15日交', '', false],
  ['记一单帆布袋500个，6元一个，8月15日交', '张总', false],
  ['先别记一单，王总帆布袋500个，6元一个，8月15日交', '', true]
]) {
  test(`首页输入转完整页：${text}`, () => withPage(text, async (h, before) => {
    const home = loadProductionPage('HOME_QUICK', { fakeWx: h.fakeWx }, {
      caseId: 'common-phrasing-home', ai: { profile: 'LOCAL_ONLY' }
    }, { runLifecycle: false });
    home.page.onComposerInput({ detail: { value: text } });
    home.page.submitComposer();
    unchanged(h, before);
    h.page.onShow();
    await waitForPageParse(h.page);
    assert.strictEqual(h.page.data.text, text);
    unchanged(h, before);
    if (blocked) {
      assert.strictEqual(h.page.data.disableFormalSave, true);
      await Promise.resolve(h.page.saveFormal());
      unchanged(h, before);
      return;
    }
    if (customerAnswer) {
      question(h, 'customerName');
      await answerQuestion(h.page, customerAnswer);
    }
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items[0].productName, '帆布袋');
    assert.strictEqual(record.totalAmount, '3000');
    assert.strictEqual(record.requiredDeliveryDate, '2026-08-15');
  }));
}

test('缺客户时主动存待整理：保留原话和干净商品名，不创建客户或订单', () => {
  const text = '记一单帆布袋500个，6元一个，8月15日交';
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    question(h, 'customerName');
    unchanged(h, before);
    await Promise.resolve(h.page.savePending());
    await tick();
    const state = h.readState();
    assert.strictEqual(state.pendingNotes.length, 1);
    assert.strictEqual(state.customers.length, 0);
    assert.strictEqual(state.orders.length, 0);
    const record = state.pendingNotes[0];
    assert.strictEqual(record.originalText, text);
    assert.strictEqual(record.guessedFields.productName, '帆布袋');
    assert.strictEqual(record.guessedFields.items[0].productName, '帆布袋');
    assert.strictEqual(record.guessedFields.amount, '3000');
    readDetail(h, 'pending', record);
    assert.strictEqual(h.driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
    assert.strictEqual(h.driver.evidence.productionStorageCalls.saveState, 1);
  });
});

for (const [text, product, quantity, price, due, answers] of [
  ['孙老板卡套一千个五元一个下礼拜五交', '卡套', '1000', '5', '2026-08-14', []],
  ['孙老板下单卡套一千个5元一个8月15日交', '卡套', '1000', '5', '2026-08-15', []],
  ['孙老板一千个卡套五元一个下礼拜五交', '卡套', '1000', '5', '2026-08-14', []],
  ['孙老板卡套一千五百个五元一个下礼拜五交', '卡套', '1500', '5', '2026-08-14', []],
  ['孙老板卡套一千个五块五一个下礼拜五交', '卡套', '1000', '5.5', '2026-08-14', []],
  ['王总下单一次性餐盒五百个六元一个8月15日交', '一次性餐盒', '500', '6', '2026-08-15', []],
  ['卡套一千个五元一个下礼拜五交', '卡套', '1000', '5', '2026-08-14', [['customerName', '孙老板']]],
  ['孙老板下单卡套一千个五元一个', '卡套', '1000', '5', '2026-08-15', [['dueDate', '8月15日']]],
  ['孙老板一千个五元一个下礼拜五交', '卡套', '1000', '5', '2026-08-14', [['productName', '卡套']]]
]) {
  test(`无标点口语保存和详情重读：${text}`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    for (const [field, answer] of answers) {
      question(h, field);
      await answerQuestion(h.page, answer);
      unchanged(h, before);
    }
    const { record, state } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items.length, 1);
    assert.strictEqual(record.items[0].productName, product);
    assert.strictEqual(record.items[0].quantity, quantity);
    assert.strictEqual(record.items[0].unitPrice, price);
    assert.strictEqual(record.totalAmount, String(Number(quantity) * Number(price)));
    assert.strictEqual(record.requiredDeliveryDate, due);
    assert.strictEqual(state.customers[0].name, text.startsWith('王总') ? '王总' : '孙老板');
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

test('三角架可直接确认保存：名称不被当成三角钱', () => {
  const text = '王总下单三角架五百个六元一个8月15日交';
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items[0].productName, '三角架');
    assert.strictEqual(record.items[0].quantity, '500');
    assert.strictEqual(record.items[0].unitPrice, '6');
    assert.strictEqual(record.totalAmount, '3000');
  });
});

for (const [product, unit, text, answers] of [
  ['三件套', '套', '王总三件套五百套六元一套下周五交', []],
  ['四件套工具', '套', '王总下单四件套工具500套，每套6元，8月15日交', []],
  ['两件套礼盒', '套', '王总下单两件套礼盒500套，每套6元，8月15日交', []],
  ['六角螺丝', '个', '王总下单六角螺丝500个，每个6元，8月15日交', []],
  ['三件套', '套', '王总三件套要500套，每套6元，下周五交', []],
  ['三角架', '个', '王总三角架要500个，每个6元，下周五交', []],
  ['三件套', '套', '王总下单三件套每套6元下周五交', [['quantity', '500'], ['unit', '套']]],
  ['三件套', '套', '赵姐下单三件套，每套6元，明天交', [['quantity', '500'], ['unit', '套']]],
  ['三角架', '个', '王总下单三角架500个，8月15日交', [['unitPrice', '6']]]
]) {
  test(`数字商品名完整链路：${text}`, () => withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    for (const [field, answer] of answers) {
      question(h, field);
      await answerQuestion(h.page, answer);
      unchanged(h, before);
    }
    assert.strictEqual(h.page.data.confirmItems[0].totalAmount, '3000', '确认卡应在保存前显示该项金额');
    assert.strictEqual(h.page.data.fields.amount, '3000', '确认卡应在保存前显示总金额');
    assert.strictEqual(h.page.data.showOrderAmountSummary, true, '总金额不能等保存后才补算');
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items.length, 1);
    assert.strictEqual(record.items[0].productName, product);
    assert.strictEqual(record.items[0].quantity, '500');
    assert.strictEqual(record.items[0].unit, unit);
    assert.strictEqual(record.items[0].unitPrice, '6');
    assert.strictEqual(record.totalAmount, '3000');
    assert.strictEqual(h.network.aiEvents().length, 0);
  }));
}

test('补答数量与单位不做换算：计价单位冲突时金额留空', () => withPage('赵姐下单三件套，每个6元，明天交', async (h, before) => {
  await submitOriginalText(h.page, '赵姐下单三件套，每个6元，明天交');
  question(h, 'quantity');
  await answerQuestion(h.page, '500');
  question(h, 'unit');
  await answerQuestion(h.page, '套');
  const item = h.page.data.confirmItems[0];
  assert.strictEqual(item.unit, '套');
  assert.strictEqual(item.priceUnit, '个');
  assert.strictEqual(item.totalAmount, '');
  assert.strictEqual(h.page.data.fields.amount, '');
  assert.strictEqual(h.page.data.disableFormalSave, true);
  unchanged(h, before);
}));

test('补答后保留原话总价，计算价不同则继续核对', () => withPage('赵姐下单三件套，每套6元，总价2800元，明天交', async (h, before) => {
  await submitOriginalText(h.page, '赵姐下单三件套，每套6元，总价2800元，明天交');
  await answerQuestion(h.page, '500');
  await answerQuestion(h.page, '套');
  assert.strictEqual(h.page.data.confirmItems[0].totalAmount, '3000');
  assert.strictEqual(h.page.data.fields.amount, '2800');
  assert.strictEqual(h.page.data.fields.statedAmount, '2800');
  assert.strictEqual(h.page.data.fields.calculatedAmount, '3000');
  question(h, 'amount');
  unchanged(h, before);
}));

test('补答不覆盖真实编辑handler确认的单项金额', () => withPage('赵姐下单三件套，每套6元，明天交', async (h, before) => {
  await submitOriginalText(h.page, '赵姐下单三件套，每套6元，明天交');
  const target = question(h, 'quantity').target;
  // Handler boundary only: this does not claim the hidden card is clickable during a question.
  h.page.updateItemField({
    currentTarget: { dataset: { index: target.itemIndex, itemKey: target.itemKey, field: 'totalAmount' } },
    detail: { value: '2800' }
  });
  await answerQuestion(h.page, '500');
  await answerQuestion(h.page, '套');
  assert.strictEqual(h.page.data.confirmItems[0].totalAmount, '2800');
  assert.strictEqual(h.page.data.fields.amount, '2800');
  assert.strictEqual(h.page.data.disableFormalSave, true);
  unchanged(h, before);
}));

test('多商品补答只重算目标项，其他商品保持原样', () => {
  const text = '王总下单：大号礼品盒100个，每个3元；小号礼品盒每个2元；8月15日交货';
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    assert.strictEqual(question(h, 'quantity').target.itemIndex, 1);
    const first = safeClone(h.page.data.fields.items[0]);
    await answerQuestion(h.page, '200');
    assert.deepStrictEqual(h.page.data.fields.items[0], first);
    assert.strictEqual(h.page.data.confirmItems[0].totalAmount, '300');
    assert.strictEqual(h.page.data.confirmItems[1].totalAmount, '400');
    assert.strictEqual(h.page.data.fields.amount, '700');
    // The existing multi-item route may remain blocked; this checks derivation, not delivery.
    unchanged(h, before);
  });
});

test('用户可亲自补三角架商品名，原话与人工补充分别保留', () => {
  const text = '王总下单500个，每个6元，8月15日交';
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    question(h, 'productName');
    unchanged(h, before);
    await answerQuestion(h.page, '三角架');
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items[0].productName, '三角架');
    assert.strictEqual(record.totalAmount, '3000');
  });
});
test('三件套报价：名称和采购数量在保存详情中一致', () => {
  const text = '给王总报价三件套500套，每套6元';
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    const { record } = await saveAndRead(h, 'quotation', 'quotations', text);
    assert.strictEqual(record.items[0].productName, '三件套');
    assert.strictEqual(record.items[0].quantity, '500');
    assert.strictEqual(record.totalAmount, '3000');
  });
});
test('首页录入三件套转完整页后保存和详情重读', () => {
  const text = '王总三件套五百套六元一套下周五交';
  return withPage(text, async (h, before) => {
    const home = loadProductionPage('HOME_QUICK', { fakeWx: h.fakeWx }, {
      caseId: 'numeric-product-home', ai: { profile: 'LOCAL_ONLY' }
    }, { runLifecycle: false });
    home.page.onComposerInput({ detail: { value: text } });
    home.page.submitComposer();
    unchanged(h, before);
    h.page.onShow();
    await waitForPageParse(h.page);
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items[0].productName, '三件套');
    assert.strictEqual(record.items[0].quantity, '500');
    assert.strictEqual(record.totalAmount, '3000');
  });
});

test('价格与日期紧连时按3元保存，不把8月当小数', () => {
  const text = '王总下单四件套工具100套每套3元8月15日交';
  return withPage(text, async (h, before) => {
    await submitOriginalText(h.page, text);
    unchanged(h, before);
    const { record } = await saveAndRead(h, 'order', 'orders', text);
    assert.strictEqual(record.items[0].productName, '四件套工具');
    assert.strictEqual(record.items[0].unitPrice, '3');
    assert.strictEqual(record.totalAmount, '300');
    assert.strictEqual(record.requiredDeliveryDate, '2026-08-15');
  });
});

async function main() {
  const repeatIndex = process.argv.indexOf('--repeat');
  const rounds = repeatIndex >= 0 ? Number(process.argv[repeatIndex + 1]) : 1;
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 2, 'repeat must be 1 or 2');
  const outcomes = [];
  for (let round = 1; round <= rounds; round += 1) {
    const statuses = [];
    for (const current of tests) {
      try { await current.run(); statuses.push(true); console.log(`PASS ${current.name}`); }
      catch (error) {
        statuses.push(false);
        console.error(`FAIL ${current.name}: ${error.message}`);
        if (process.argv.includes('--diagnostic')) console.error(JSON.stringify(error.journeyEvidence || {}));
      }
    }
    outcomes.push(statuses);
    console.log(`User journey round ${round}: ${statuses.filter(Boolean).length}/${tests.length} passed`);
  }
  assert(outcomes.every((statuses) => JSON.stringify(statuses) === JSON.stringify(outcomes[0])), 'Journey result drift');
  if (outcomes.some((statuses) => statuses.some((passed) => !passed))) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
