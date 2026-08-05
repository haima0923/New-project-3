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

[
  ['SCOV-031', '括号规格加颗单位的第二商品不能静默丢失', '珠子（红色）20颗', '珠子'],
  ['SCOV-032', '括号规格加粒单位的第二商品不能静默丢失', '纽扣（红色）20粒', '纽扣'],
  ['SCOV-033', '括号规格加串单位的第二商品不能静默丢失', '手链（红色）20串', '手链'],
  ['SCOV-034', '括号规格加盘单位的第二商品不能静默丢失', '胶带（红色）20盘', '胶带'],
  ['SCOV-035', '括号规格加束单位的第二商品不能静默丢失', '花材（红色）20束', '花材']
].forEach(([caseId, title, itemText, productName]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(
    `王总下单：水杯10个，每个3元；${itemText}，单价4元；8月15日交货。`,
    productName
  ));
});

[
  ['SCOV-051', '英文货币token不是第二商品单位', '报价（含税）20USD'],
  ['SCOV-052', '英文工时token不是第二商品单位', '工时（预计）20hours']
].forEach(([caseId, title, factText]) => {
  test(caseId, title, () => assertNoSourceCoverageConflict(
    `王总下单：水杯10个，每个3元；${factText}；8月15日交货。`
  ));
});

[
  ['SCOV-053', '中文方括号规格的第二商品不能静默丢失', '珠子【红色】20颗', '珠子'],
  ['SCOV-054', '英文方括号规格的第二商品不能静默丢失', '纽扣[红色]20粒', '纽扣'],
  ['SCOV-055', '书名号规格的第二商品不能静默丢失', '手链《红色》20串', '手链']
].forEach(([caseId, title, itemText, productName]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(
    `王总下单：水杯10个，每个3元；${itemText}，单价4元；8月15日交货。`,
    productName
  ));
});

test('SCOV-056', 'AI逐项覆盖方括号规格时不误报第二商品', () => {
  const reviewed = reviewNamedSingleItem(
    '王总下单：珠子【红色】，100套，每套3元；8月15日交货。',
    '珠子',
    '红色'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

[
  ['SCOV-057', '空格规格的第二商品不能静默丢失', '珠子 红色20颗', '珠子'],
  ['SCOV-058', '中文引号规格的第二商品不能静默丢失', '纽扣“红色”20粒', '纽扣'],
  ['SCOV-059', '角引号规格的第二商品不能静默丢失', '手链「红色」20串', '手链'],
  ['SCOV-060', '带括号复数的英文计量token不能静默丢失', '胶带（红色）20pc(s)', '胶带']
].forEach(([caseId, title, itemText, productName]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(
    `王总下单：水杯10个，每个3元；${itemText}，单价4元；8月15日交货。`,
    productName
  ));
});

[
  ['SCOV-061', '英文缩写工时不是第二商品单位', '工时（预计）20hrs'],
  ['SCOV-062', '锁边米数是加工说明而非第二商品', '锁边（红线）20米'],
  ['SCOV-063', '裁剪刀数是加工说明而非第二商品', '裁剪（大号）20刀'],
  ['SCOV-064', '滴胶滴数是加工说明而非第二商品', '滴胶（透明）20滴']
].forEach(([caseId, title, factText]) => {
  test(caseId, title, () => assertNoSourceCoverageConflict(
    `王总下单：水杯10个，每个3元；${factText}；8月15日交货。`
  ));
});

test('SCOV-065', '锁边机不能因加工词被当成说明', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；锁边机（红线）20台，单价400元；8月15日交货。',
    '锁边机'
  );
});

test('SCOV-066', '显式另加裁剪服务仍是未覆盖业务项', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；另加裁剪服务（大号）20份；8月15日交货。',
    '裁剪服务'
  );
});

test('SCOV-067', 'AI逐项覆盖引号规格时不误报第二商品', () => {
  const reviewed = reviewNamedSingleItem(
    '王总下单：珠子“红色”，100套，每套3元；8月15日交货。',
    '珠子',
    '红色'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

[
  ['SCOV-068', '多token英文规格的第二商品不能静默丢失', '珠子 dark red 20pcs', '珠子'],
  ['SCOV-069', '多token中文规格的第二商品不能静默丢失', '纽扣 大号 红色 20颗', '纽扣'],
  ['SCOV-070', '型号加编号规格的第二商品不能静默丢失', '手链 型号 A1 20sets', '手链'],
  ['SCOV-071', '复合外贸计量token不能静默丢失', '胶带（红色）20pcs/set', '胶带']
].forEach(([caseId, title, itemText, productName]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(
    `王总下单：水杯10个，每个3元；${itemText}，单价4元；8月15日交货。`,
    productName
  ));
});

[
  ['SCOV-072', '质保月数不是第二商品', '质保（期限）20months'],
  ['SCOV-073', '保修年数不是第二商品', '保修（期限）2year(s)'],
  ['SCOV-074', '有效期年数不是第二商品', '有效期（预计）2yrs']
].forEach(([caseId, title, factText]) => {
  test(caseId, title, () => assertNoSourceCoverageConflict(
    `王总下单：水杯10个，每个3元；${factText}；8月15日交货。`
  ));
});

test('SCOV-075', 'AI逐项覆盖多token规格时不误报第二商品', () => {
  const reviewed = reviewNamedSingleItem(
    '王总下单：珠子 dark red，100套，每套3元；8月15日交货。',
    '珠子',
    'dark red'
  );
  assert(!(reviewed.field_conflicts || []).some((entry) => (
    entry.code === 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE'
  )));
});

test('SCOV-076', '质保卡不能因质保前缀被当成期限说明', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；质保卡（期限）20张，单价4元；8月15日交货。',
    '质保卡'
  );
});

[
  ['SCOV-036', '刻字数量是加工说明而非第二商品', '刻字（英文）20字'],
  ['SCOV-037', '激光刻字数量是加工说明而非第二商品', '激光刻字（英文）20字'],
  ['SCOV-038', '说明字数不是第二商品', '说明（包装）20字'],
  ['SCOV-039', '折扣档位不是第二商品', '折扣（已确认）8折'],
  ['SCOV-040', '优惠档位不是第二商品', '优惠（已确认）8折'],
  ['SCOV-041', '检验批次是质量要求而非第二商品', '检验（抽检）2批'],
  ['SCOV-042', '开槽数量是加工说明而非第二商品', '开槽（V型）20处'],
  ['SCOV-043', '缝线数量是加工说明而非第二商品', '缝线（红色）20道'],
  ['SCOV-044', '班次数量是排产说明而非第二商品', '班次（夜班）2班']
].forEach(([caseId, title, factText]) => {
  test(caseId, title, () => assertNoSourceCoverageConflict(
    `王总下单：水杯10个，每个3元；${factText}；8月15日交货。`
  ));
});

test('SCOV-045', '检验机不能因检验前缀被当成加工说明', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；检验机（抽检）2台，单价400元；8月15日交货。',
    '检验机'
  );
});

test('SCOV-046', '显式另加的刻字服务仍是未覆盖业务项', () => {
  assertUncoveredItemBlocked(
    '王总下单：水杯10个，每个3元；另加刻字服务（英文）20份；8月15日交货。',
    '刻字服务'
  );
});

[
  ['SCOV-047', '括号规格加小写pcs的第二商品不能静默丢失', '珠子（红色）20pcs', '珠子'],
  ['SCOV-048', '括号规格加大写PCS的第二商品不能静默丢失', '纽扣（红色）20PCS', '纽扣'],
  ['SCOV-049', '括号规格加sets的第二商品不能静默丢失', '手链（红色）20sets', '手链'],
  ['SCOV-050', '括号规格加rolls的第二商品不能静默丢失', '胶带（红色）20rolls', '胶带']
].forEach(([caseId, title, itemText, productName]) => {
  test(caseId, title, () => assertUncoveredItemBlocked(
    `王总下单：水杯10个，每个3元；${itemText}，单价4元；8月15日交货。`,
    productName
  ));
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
