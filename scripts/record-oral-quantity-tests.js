#!/usr/bin/env node
// Fixed-clock local parser tests. No real AI or user storage.
const assert = require('assert');
const { parseInput } = require('../utils/parser');
const { evaluateRecordDomainPreflight } = require('../utils/record-domain-preflight');
let total = 0;
let passed = 0;
function check(name, run) {
  total += 1;
  try { run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}
function parse(text, options = {}) {
  const r = parseInput(Object.assign({ text, state: {}, context: 'input', businessDate: '2026-07-15',
    nowInstant: '2026-07-15T02:00:00.000Z' }, options));
  assert.strictEqual(r.original_text, options.rawText || text);
  return r;
}
function assertItem(r, product, quantity, unitPrice, unit = '个') {
  assert.strictEqual(r.fields.productName, product);
  assert.strictEqual(r.fields.quantity, quantity);
  assert.strictEqual(r.fields.unitPrice, unitPrice);
  assert.strictEqual(r.fields.unit, unit);
  assert.strictEqual(r.fields.items.length, 1);
  const item = r.fields.items[0];
  assert.strictEqual(item.productName, product);
  assert.strictEqual(item.quantity, quantity);
  assert.strictEqual(item.unitPrice, unitPrice);
  assert.strictEqual(item.unit, unit);
  const amount = String(Number(quantity) * Number(unitPrice));
  assert.strictEqual(r.fields.amount, amount);
  assert.strictEqual(item.totalAmount, amount);
}
for (const [quantityText, quantity] of [['一千', '1000'], ['两千', '2000'], ['一千五百', '1500'],
  ['五百', '500'], ['二十', '20'], ['1000', '1000'], ['一百二十', '120']]) {
  check(`商品在前，数量${quantityText}后紧接价格`, () => {
    const r = parse(`孙老板卡套${quantityText}个五元一个下礼拜五交`);
    assertItem(r, '卡套', quantity, '5');
    assert.strictEqual(r.fields.customerName, '孙老板');
    assert.strictEqual(r.fields.dueDate, '2026-07-24');
    assert.deepStrictEqual(r.missing_fields, []);
    assert.deepStrictEqual(r.low_confidence_fields, []);
  });
}
for (const [price, expected] of [['五块钱', '5'], ['五块五', '5.5'], ['三块八', '3.8'], ['5元', '5'], ['五元', '5']]) {
  check(`计价用的一个不能吞掉商品：${price}`, () => {
    assertItem(parse(`孙老板下单卡套一千个${price}一个下周五交`), '卡套', '1000', expected);
  });
}
for (const product of ['帆布袋', '文件袋', '一次性餐盒', '八音盒', '三角架']) {
  check(`不靠商品词表识别：${product}`, () => {
    const r = parse(`王总下单${product}五百个六元一个下周五交`);
    assertItem(r, product, '500', '6');
    assert.strictEqual(r.fields.customerName, '王总');
  });
}
for (const text of ['孙老板一千个卡套五元一个下礼拜五交', '孙老板卡套一千个，五元一个，下礼拜五交',
  '孙老板卡套1000个5元一个下礼拜五交']) {
  check(`倒装、标点与阿拉伯数字兼容：${text}`, () => {
    assertItem(parse(text), '卡套', '1000', '5');
  });
}
check('缺客户：计价用的一个不能冒充客户', () => {
  const r = parse('卡套一千个五元一个下礼拜五交');
  assertItem(r, '卡套', '1000', '5');
  assert.strictEqual(r.fields.customerName, '');
  assert(r.missing_fields.includes('customerName'));
  assert.strictEqual(evaluateRecordDomainPreflight({ finalResult: r, initialState: {}, skipFinalSafety: true }).domainCanSaveFormal, false);
});
check('缺商品：不把价格或交期当商品', () => {
  const r = parse('孙老板一千个五元一个下礼拜五交');
  assert.strictEqual(r.fields.productName, '');
  assert(r.missing_fields.includes('productName'));
});
check('缺交期：不自动填日期', () => {
  const r = parse('孙老板下单卡套一千个五元一个');
  assertItem(r, '卡套', '1000', '5');
  assert.strictEqual(r.fields.dueDate, '');
  assert(r.missing_fields.includes('dueDate'));
});
check('没说价格：不补造金额', () => {
  const r = parse('孙老板下单卡套一千个下周五交');
  assert.strictEqual(r.fields.unitPrice, '');
  assert.strictEqual(r.fields.amount, '');
});
check('商品名称含数量短语：三件套不得拆成商品三', () => {
  const r = parse('王总三件套五百套六元一套下周五交');
  assert.strictEqual(r.fields.productName, '三件套');
  assert.strictEqual(r.fields.quantity, '500');
  assert.strictEqual(r.fields.items[0].quantity, '500');
  assert.strictEqual(r.fields.amount, '3000');
});
check('总金额冲突继续保留', () => {
  const r = parse('孙老板下单卡套一千个五元一个，总价六千元，下周五交');
  assert(r.field_conflicts.some(c => c.field === 'amount'));
});
for (const text of ['先别记一单孙老板卡套一千个五元一个下周五交',
  '孙老板先不要做卡套一千个五元一个下周五交', '记一单卡套一千个五元一个但还没下单']) {
  check(`否定和冲突不能正式保存：${text}`, () => {
    const r = parse(text);
    assert.strictEqual(evaluateRecordDomainPreflight({ finalResult: r, initialState: {}, skipFinalSafety: true }).domainCanSaveFormal, false);
  });
}
check('粘贴原聊天与识别文本保留', () => {
  const text = '孙老板卡套一千个五元一个下礼拜五交';
  const rawText = `孙老板：${text}`;
  const r = parse(text, { source: 'paste', rawText, extractedText: text });
  assertItem(r, '卡套', '1000', '5');
  assert.strictEqual(r.raw_text, rawText);
  assert.strictEqual(r.extracted_text, text);
});
for (const [text, intent] of [['孙老板还欠五千元下周五收', 'receivable'],
  ['孙老板付了五千元', 'payment'], ['给孙老板报价卡套一千个五元一个', 'quotation'],
  ['今天天气不错，晚点出去走走', 'unknown']]) {
  check(`邻近业务保护：${text}`, () => assert.strictEqual(parse(text).intent, intent));
}
console.log(`Oral quantity parser: ${passed}/${total} passed`);
