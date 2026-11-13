#!/usr/bin/env node
const assert = require('assert');
const { parseInput } = require('../utils/parser');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { normalizeAiResult } = require('../utils/ai-parser');
const { evaluateRecordDomainPreflight } = require('../utils/record-domain-preflight');
const { safeClone } = require('../utils/record-state-diff');
const clock = { businessDate: '2026-07-15', businessTimezone: 'Asia/Shanghai', nowInstant: '2026-07-15T02:00:00.000Z' };
let total = 0, passed = 0;
function check(name, run) {
  total += 1;
  try { run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}
function parse(text) {
  const r = parseInput(Object.assign({ text, state: {}, context: 'input' }, clock));
  assert.strictEqual(r.original_text, text);
  return r;
}
function noFormal(r) {
  assert.strictEqual(evaluateRecordDomainPreflight({ finalResult: r, initialState: {}, skipFinalSafety: true }).domainCanSaveFormal, false);
}
for (const [product, unit] of [['三角架', '个'], ['六角螺丝', '个'], ['八角桌', '个'], ['三角支架', '个'],
  ['三件套', '套'], ['四件套工具', '套'], ['两件套礼盒', '套']]) {
  check(`明确名称、采购数量与单价：${product}`, () => {
    const r = parse(`王总下单${product}500${unit}，每${unit}6元，下周五交`);
    assert.strictEqual(r.fields.productName, product);
    assert.strictEqual(r.fields.quantity, '500');
    assert.strictEqual(r.fields.unitPrice, '6');
    assert.strictEqual(r.fields.amount, '3000');
    assert.strictEqual(r.fields.items.length, 1);
    assert.strictEqual(r.fields.items[0].productName, product);
    assert.strictEqual(r.fields.items[0].quantity, '500');
    assert.deepStrictEqual(r.low_confidence_fields, []);
    assert.strictEqual(evaluateRecordDomainPreflight({ finalResult: r, initialState: {}, skipFinalSafety: true }).domainCanSaveFormal, true);
  });
}
for (const [product, count, expected] of [['三件套', '五百', '500'], ['四件套工具', '两百', '200'], ['两件套礼盒', '100', '100']]) {
  check(`名称内的件不参与采购数量：${product}${count}套`, () => {
    const r = parse(`王总下单${product}${count}套六元一套下周五交`);
    assert.strictEqual(r.fields.productName, product);
    assert.strictEqual(r.fields.quantity, expected);
    assert.strictEqual(r.fields.items[0].quantity, expected);
    assert.strictEqual(r.fields.amount, String(Number(expected) * 6));
  });
}
for (const product of ['三件套', '四件套工具', '两件套礼盒']) {
  check(`缺采购数量不能拿名称里的数量补：${product}`, () => {
    const r = parse(`王总下单${product}每套6元下周五交`);
    assert.strictEqual(r.fields.productName, product);
    assert.strictEqual(r.fields.quantity, '');
    assert.strictEqual(r.fields.amount, '');
    assert(r.missing_fields.includes('quantity'));
    noFormal(r);
  });
}
for (const product of ['三角架', '六角螺丝']) {
  check(`没说单价不能从名称里的角换算：${product}`, () => {
    const r = parse(`王总下单${product}500个，下周五交`);
    assert.strictEqual(r.fields.productName, product);
    assert.strictEqual(r.fields.unitPrice, '');
    assert.strictEqual(r.fields.amount, '');
  });
}
for (const price of ['三角', '三角钱', '三角一个', '三角每个', '5元一个', '5元水杯', '五块五', '元一个', '三个']) {
  check(`价格或数量仍不能冒充商品：${price}`, () => {
    const r = safeClone(parse('王总下单礼品盒500个，每个6元，下周五交'));
    r.original_text = `王总下单${price}500个，每个6元，下周五交`;
    r.fields.productName = price;
    r.fields.items[0].productName = price;
    const checked = applyFinalParseSafety(r, clock);
    const invalid = checked.final_parse_safety.field_validations.invalid_fields;
    assert(invalid.includes('productName'), '错误名称仍须被校验拒绝');
    noFormal(checked);
  });
}
check('普通采购三件商品仍是数量3', () => {
  const r = parse('王总下单礼品盒三件，每件6元，下周五交');
  assert.strictEqual(r.fields.quantity, '3');
  assert.strictEqual(r.fields.productName, '礼品盒');
});
check('多商品不能因名称内数字多拆一条', () => {
  const r = parse('王总下单三件套500套，每套6元；三角架100个，每个5元；下周五交');
  assert.strictEqual(r.fields.items.length, 2);
  assert.deepStrictEqual(r.fields.items.map(i => [i.productName, i.quantity, i.unitPrice]), [
    ['三件套', '500', '6'], ['三角架', '100', '5']
  ]);
});
check('商品名称合法不授权AI替换原商品', () => {
  const local = parse('王总下单礼品盒500个，每个6元，下周五交');
  const changed = safeClone(local.fields);
  changed.productName = '三角架';
  changed.items[0].productName = '三角架';
  const r = normalizeAiResult(local, { provider: 'controlled-real-fixture', intent: 'order', fields: changed,
    missing_fields: [], low_confidence_fields: [], field_conflicts: [], confidence: 0.99 }, Object.assign({ providerKind: 'REAL' }, clock));
  const safeOriginal = r.fields.productName === '礼品盒' && r.fields.items[0].productName === '礼品盒';
  if (!safeOriginal) noFormal(r);
});
check('名称修复不清除总金额冲突', () => {
  const r = parse('王总下单三件套500套，每套6元，总价4000元，下周五交');
  assert(r.field_conflicts.some(c => c.field === 'amount'));
  noFormal(r);
});
for (const [text, product] of [['王总三件套要500套，每套6元，下周五交', '三件套'],
  ['王总三角架要500个，每个6元，下周五交', '三角架'],
  ['王总要500套三件套，每套6元，下周五交', '三件套']]) {
  check(`动作和数量不混进名称：${text}`, () => {
    const r = parse(text);
    assert.strictEqual(r.fields.productName, product);
    assert.strictEqual(r.fields.items[0].productName, product);
    assert.strictEqual(r.fields.quantity, '500');
    assert.strictEqual(r.fields.amount, '3000');
  });
}
for (const [priceText, dateText] of [['3元', '8月15日'], ['六元', '八月十五日'], ['3元', '2026年8月15日']]) {
  check(`日期不参与价格小数：${priceText}${dateText}`, () => {
    const r = parse(`王总下单四件套工具100套每套${priceText}${dateText}交`);
    assert.strictEqual(r.fields.productName, '四件套工具');
    assert.strictEqual(r.fields.unitPrice, priceText === '六元' ? '6' : '3');
    assert.strictEqual(r.fields.amount, priceText === '六元' ? '600' : '300');
  });
}
check('真正的口语小数价3元8不被删除', () => {
  const r = parse('王总下单三件套100套，3元8一套，下周五交');
  assert.strictEqual(r.fields.unitPrice, '3.8');
  assert.strictEqual(r.fields.amount, '380');
});
console.log(`Numeric product names: ${passed}/${total} passed`);
