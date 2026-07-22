const assert = require('assert');
const benchmark = require('../test-fixtures/real-ai-comparison-v1.json');
const { scoreResult } = require('./lib/real-ai-comparison-score');
const { buildWeekDateHints } = require('./lib/real-ai-comparison-prompts');

function idealResult(testCase) {
  const expected = testCase.expected || {};
  const fields = Object.assign({}, expected.fields || {});
  Object.entries(expected.allowedValues || {}).forEach(([field, values]) => {
    fields[field] = values[0];
  });
  (expected.requiredNonEmpty || []).forEach((field) => { fields[field] = fields[field] || '已填写'; });
  Object.entries(expected.optionalExactOrUncertain || {}).forEach(([field, value]) => { fields[field] = value; });
  (expected.mustBeEmpty || []).forEach((field) => { fields[field] = ''; });
  if (expected.items) fields.items = expected.items;
  const low = (expected.mustMarkUncertain || []).slice();
  if (expected.mustMarkAnyRisk && !low.length) low.push('intent');
  const intents = (expected.requiredIntentCandidates || []).slice();
  return {
    intent: expected.intent || (expected.allowedIntents || [])[0] || 'unknown',
    fields,
    missing_fields: [],
    low_confidence_fields: low,
    field_conflicts: [],
    intent_candidates: intents,
    superseded_facts: expected.requiredSupersededValue ? [{ value: expected.requiredSupersededValue }] : [],
    field_evidence: {}
  };
}

assert.strictEqual(benchmark.cases.length, 40, '题库必须恰好有40道题');
assert.strictEqual(new Set(benchmark.cases.map((item) => item.id)).size, 40, '题号必须唯一');
assert.strictEqual(benchmark.cases.filter((item) => item.split === 'development').length, 24, '开发题必须24道');
assert.strictEqual(benchmark.cases.filter((item) => item.split === 'holdout').length, 8, '锁定题必须8道');
assert.strictEqual(benchmark.cases.filter((item) => item.split === 'final_holdout').length, 8, '最终未见题必须8道');
const dateHints = buildWeekDateHints('2026-07-20');
assert(dateHints.includes('本周五=2026-07-24'), '本周五日期表错误');
assert(dateHints.includes('下周五=2026-07-31'), '下周五日期表错误');

benchmark.cases.forEach((testCase) => {
  const scored = scoreResult(testCase, idealResult(testCase), null);
  assert.strictEqual(scored.accepted, true, `${testCase.id} 的标准答案必须能通过判分器：${JSON.stringify(scored.checks.filter((item) => !item.pass))}`);
});

const bossCase = benchmark.cases.find((item) => item.id === 'C01');
const unsafeBoss = idealResult(bossCase);
unsafeBoss.fields.customerName = '老板今';
unsafeBoss.low_confidence_fields = [];
const unsafeScore = scoreResult(bossCase, unsafeBoss, null);
assert.strictEqual(unsafeScore.accepted, false, '把老板今当客户必须失败');
assert.strictEqual(unsafeScore.classification, 'unsafe_wrong', '把老板今当客户必须归为危险错误');

const multiCase = benchmark.cases.find((item) => item.id === 'G01');
const collapsed = idealResult(multiCase);
collapsed.fields.items = [];
collapsed.fields.productName = '杯垫、礼品盒';
const collapsedScore = scoreResult(multiCase, collapsed, null);
assert.strictEqual(collapsedScore.accepted, false, '多商品合并为一行必须失败');

console.log('真实AI对比实验合同测试通过：40道题、24/8/8分组、危险误识别和多商品判分均有效。');
