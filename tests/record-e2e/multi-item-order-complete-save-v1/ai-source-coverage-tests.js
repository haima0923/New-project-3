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
