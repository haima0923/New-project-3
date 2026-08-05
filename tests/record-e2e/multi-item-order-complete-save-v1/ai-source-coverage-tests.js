#!/usr/bin/env node

const assert = require('assert');
const { normalizeAiResult } = require('../../../utils/ai-parser');
const { saveConfirmedDraft } = require('../../../utils/business');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { parseInput } = require('../../../utils/parser');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const { safeClone } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE, withFrozenClock } = require('./clock');

const tests = [];

function test(caseId, title, fn) {
  tests.push({ caseId, title, fn });
}

function parseText(text) {
  return parseInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'record',
    state: createInitialState(),
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function normalizeSingleItemAi(local) {
  const first = safeClone((local.fields.items || [])[0] || {});
  assert(first.productName, '控制样例必须先由 Local 识别第一件商品');
  return normalizeAiResult(local, {
    provider: 'controlled-real-fixture',
    intent: 'order',
    fields: Object.assign({}, safeClone(local.fields), {
      productName: first.productName,
      quantity: first.quantity,
      unit: first.unit,
      unitPrice: first.unitPrice,
      priceUnit: first.priceUnit,
      totalAmount: first.totalAmount,
      amount: first.totalAmount,
      items: [first]
    }),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.95
  }, {
    providerKind: 'REAL',
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function reviewAndPreflight(text) {
  const local = parseText(text);
  const merged = normalizeSingleItemAi(local);
  const reviewed = applyFinalParseSafety(merged, { businessDate: BUSINESS_DATE });
  const state = createInitialState();
  const domain = evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation: 'create_order',
    businessType: 'order',
    finalResult: reviewed,
    originalText: text,
    initialState: state,
    aiOutcome: (reviewed.ai_fallback || {}).status || 'not_requested',
    providerKind: (reviewed.ai_fallback || {}).provider_kind || 'NONE',
    businessDate: BUSINESS_DATE,
    skipFinalSafety: true
  });
  return { reviewed, domain, state };
}

function reviewAiAddedSpec(text, spec) {
  const parsed = parseText(text);
  const first = safeClone((parsed.fields.items || [])[0] || {});
  assert(first.productName, '规格控制样例必须先识别第一件商品');
  const local = Object.assign({}, parsed, {
    fields: Object.assign({}, safeClone(parsed.fields), {
      items: [first],
      productName: first.productName,
      quantity: first.quantity,
      unit: first.unit,
      unitPrice: first.unitPrice,
      priceUnit: first.priceUnit,
      amount: first.totalAmount,
      totalAmount: first.totalAmount,
      calculatedAmount: first.totalAmount
    })
  });
  const second = {
    productName: '饭盒',
    spec,
    quantity: '20',
    unit: '个',
    unitPrice: '4',
    priceUnit: '个',
    totalAmount: '80'
  };
  const merged = normalizeAiResult(local, {
    provider: 'controlled-real-fixture',
    intent: 'order',
    fields: Object.assign({}, safeClone(local.fields), {
      items: [first, second],
      amount: '110',
      totalAmount: '110',
      calculatedAmount: '110'
    }),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.99
  }, {
    providerKind: 'REAL',
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
  return applyFinalParseSafety(merged, { businessDate: BUSINESS_DATE });
}

function reviewNamedSingleItem(text, productName, spec = '') {
  const local = parseText(text);
  const item = {
    productName,
    spec,
    quantity: '100',
    unit: '套',
    unitPrice: '3',
    priceUnit: '套',
    totalAmount: '300'
  };
  const merged = normalizeAiResult(local, {
    provider: 'controlled-real-fixture',
    intent: 'order',
    fields: Object.assign({}, safeClone(local.fields), {
      productName,
      quantity: '100',
      unit: '套',
      unitPrice: '3',
      priceUnit: '套',
      amount: '300',
      totalAmount: '300',
      calculatedAmount: '300',
      items: [item]
    }),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.99
  }, {
    providerKind: 'REAL',
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
  return applyFinalParseSafety(merged, { businessDate: BUSINESS_DATE });
}

function assertUncoveredItemBlocked(text, expectedProduct) {
  const { reviewed, domain, state } = reviewAndPreflight(text);
  const conflict = (reviewed.field_conflicts || []).find((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  ));
  assert(conflict, '原文明示但未进入 items[] 的候选商品必须产生结构性冲突');
  assert((conflict.values || []).some((value) => String(value).includes(expectedProduct)));
  assert.strictEqual(domain.domainCanSaveFormal, false);
  const before = JSON.stringify(state);
  const saved = saveConfirmedDraft(state, safeClone(reviewed));
  assert.strictEqual(saved.type, 'error');
  assert.strictEqual(saved.blocked, true);
  assert.strictEqual(JSON.stringify(state), before);
}

function assertNoSourceCoverageConflict(text) {
  const { reviewed } = reviewAndPreflight(text);
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
}

test('SCOV-001', '未知第二商品逗号加数量晚点确认必须阻断', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；星云棒，数量晚点确认；8月15日交货。',
    '星云棒'
  );
});

test('SCOV-002', '未知第二商品单价稍后确认必须阻断', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；月河片：单价稍后确认；8月15日交货。',
    '月河片'
  );
});

test('SCOV-003', '未知第二商品紧邻数量待定必须阻断', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；云岚件数量待定；8月15日交货。',
    '云岚件'
  );
});

test('SCOV-004', '单商品加交期控制不产生虚假第二商品', () => {
  const { reviewed } = reviewAndPreflight(
    '王总下单：水杯10个，每个3元；8月15日交货。'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

test('SCOV-005', '同一语句内已覆盖商品不能掩盖未知第二商品', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元，星云棒数量待定；8月15日交货。',
    '星云棒'
  );
});

test('SCOV-006', '包装加厚是商品要求而不是第二商品', () => {
  const { reviewed } = reviewAndPreflight(
    '王总下单：水杯10个，每个3元；包装加厚；8月15日交货。'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

test('SCOV-007', '贴防伪标是加工要求而不是第二商品', () => {
  const { reviewed } = reviewAndPreflight(
    '王总下单：水杯10个，每个3元；贴防伪标；8月15日交货。'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

[
  ['SCOV-008', '逗号分隔裸数量不是第二商品', '王总下单：水杯，10个，每个3元；8月15日交货。'],
  ['SCOV-009', '逗号分隔数量字段不是第二商品', '王总下单：水杯，数量10个，单价3元；8月15日交货。'],
  ['SCOV-010', '逗号分隔共计数量不是第二商品', '王总下单：水杯，共10个，3元一个；8月15日交货。']
].forEach(([caseId, title, text]) => {
  test(caseId, title, () => {
    assertNoSourceCoverageConflict(text);
  });
});

[
  ['SCOV-011', '显式另加包装盒不能被当成包装要求', '王总下单：水杯10个，每个3元；另加包装盒；8月15日交货。', '包装盒'],
  ['SCOV-012', '显式另加标签纸不能被当成贴标要求', '王总下单：水杯10个，每个3元；另加标签纸；8月15日交货。', '标签纸'],
  ['SCOV-013', '水杯不能用子串覆盖水杯盖', '王总下单：水杯10个，每个3元；另加水杯盖；8月15日交货。', '水杯盖'],
  ['SCOV-014', '饭盒不能用子串覆盖饭盒盖', '王总下单：饭盒10个，每个3元；另加饭盒盖；8月15日交货。', '饭盒盖'],
  ['SCOV-015', '礼品盒不能用子串覆盖礼品盒内衬', '王总下单：礼品盒10个，每个3元；另加礼品盒内衬；8月15日交货。', '礼品盒内衬']
].forEach(([caseId, title, text, product]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(text, product));
});

[
  ['SCOV-016', '单价为小数是价格片段', '王总下单：水杯100个，单价为3.8元；8月15日交货。'],
  ['SCOV-017', '食品级是商品规格片段', '王总下单：水杯，食品级，100个，每个3元；8月15日交货。'],
  ['SCOV-018', '304不锈钢是商品规格片段', '王总下单：水杯，304不锈钢，100个，每个3元；8月15日交货。'],
  ['SCOV-019', '每箱换算数量不是第二商品', '王总下单：水杯120个，每箱12个，每个3元；8月15日交货。'],
  ['SCOV-020', '每盒换算数量不是第二商品', '王总下单：水杯100个，每盒10个，每个3元；8月15日交货。']
].forEach(([caseId, title, text]) => {
  test(caseId, title, () => assertNoSourceCoverageConflict(text));
});

[
  ['SCOV-021', 'AI新增商品的食品级规格有逐项原文证据时可用', '食品级'],
  ['SCOV-022', 'AI新增商品的304不锈钢规格有逐项原文证据时可用', '304不锈钢']
].forEach(([caseId, title, spec]) => {
  test(caseId, title, () => {
    const reviewed = reviewAiAddedSpec(
      `王总下单：水杯10个，每个3元；饭盒${spec}20个，每个4元；8月15日交货。`,
      spec
    );
    assert.strictEqual(reviewed.fields.items.length, 2);
    assert(!(reviewed.field_conflicts || []).some((entry) => (
      entry.field === 'items' && entry.itemIndex === 1
    )));
  });
});

[
  ['SCOV-023', '三件套商品名内的件不是独立数量', '三件套'],
  ['SCOV-024', '四件套工具商品名内的件不是独立数量', '四件套工具'],
  ['SCOV-025', '两件套礼盒商品名内的件不是独立数量', '两件套礼盒']
].forEach(([caseId, title, productName]) => {
  test(caseId, title, () => {
    const reviewed = reviewNamedSingleItem(
      `王总下单：${productName}100套，每套3元；8月15日交货。`,
      productName
    );
    assert(!(reviewed.field_conflicts || []).some((entry) => (
      entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
    )));
  });
});

[
  [
    'SCOV-026',
    '括号规格加片单位的第二商品不能静默丢失',
    '王总下单：水杯10个，每个3元；钢板（大号）20片，单价4元；8月15日交货。',
    '钢板'
  ],
  [
    'SCOV-027',
    '括号规格加枚单位的第二商品不能静默丢失',
    '王总下单：水杯10个，每个3元；螺丝（M8）20枚，单价4元；8月15日交货。',
    '螺丝'
  ]
].forEach(([caseId, title, text, productName]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(text, productName));
});

[
  ['SCOV-028', '前置大号规格与商品名是同一商品', '王总下单：大号水杯，10个，每个3元；8月15日交货。'],
  ['SCOV-029', '前置颜色规格与商品名是同一商品', '王总下单：红色水杯，10个，每个3元；8月15日交货。']
].forEach(([caseId, title, text]) => {
  test(caseId, title, () => assertNoSourceCoverageConflict(text));
});

test('SCOV-030', 'AI 有证据的前置材质规格与商品名是同一商品', () => {
  const reviewed = reviewNamedSingleItem(
    '王总下单：食品级饭盒，100套，每套3元；8月15日交货。',
    '饭盒',
    '食品级'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

function main() {
  let passed = 0;
  let failed = 0;
  tests.forEach((entry) => {
    try {
      withFrozenClock(entry.caseId, entry.fn);
      passed += 1;
      console.log(`PASS ${entry.caseId} ${entry.title}`);
    } catch (error) {
      failed += 1;
      console.log(`CASE_FAIL ${entry.caseId} ${entry.title}`);
      console.log(`${error.name}: ${error.message}`);
    }
  });
  console.log(`AI source coverage gate: PASS=${passed} CASE_FAIL=${failed} RUNNER_ERROR=0`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
