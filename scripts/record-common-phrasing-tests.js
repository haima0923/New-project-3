#!/usr/bin/env node
const assert = require('assert');
const { parseInput } = require('../utils/parser');
const { evaluateRecordDomainPreflight } = require('../utils/record-domain-preflight');

let passed = 0;
let total = 0;
function parse(text, options = {}) {
  const result = parseInput(Object.assign({ text, state: {}, context: 'input',
    businessDate: '2026-07-15', nowInstant: '2026-07-15T02:00:00.000Z' }, options));
  assert.strictEqual(result.original_text, options.rawText || text);
  const evidence = result.intent_evidence || {};
  for (const signal of [].concat(evidence.orderPositiveSignals || [], evidence.quotationPositiveSignals || [])) {
    assert.strictEqual(text.slice(signal.sourceSpan.start, signal.sourceSpan.end), signal.sourceText,
      '指令处理后，识别依据仍须对应原句位置');
  }
  return result;
}
function check(name, run) {
  total += 1;
  try { run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}

for (const prefix of ['记一单', '帮我记一单', '请记一单', '麻烦记一单', '给我记一单', '请帮我记一单', '麻烦帮我记一单',
  '记个订单', '记一个订单', '记一笔订单', '记一下订单', '记下订单']) {
  check(`${prefix}：缺客户、缺交期不能瞎补`, () => {
    const r = parse(`${prefix}帆布袋500个，6元一个`);
    assert.strictEqual(r.intent, 'order');
    assert.strictEqual(r.fields.customerName, '');
    assert.strictEqual(r.fields.productName, '帆布袋');
    assert.strictEqual(r.fields.items[0].productName, '帆布袋');
    assert.strictEqual(r.fields.quantity, '500');
    assert.strictEqual(r.fields.amount, '3000');
    assert(r.missing_fields.includes('customerName'));
    assert(r.missing_fields.includes('dueDate'));
    assert.strictEqual(evaluateRecordDomainPreflight({ finalResult: r, initialState: {},
      skipFinalSafety: true }).domainCanSaveFormal, false);
  });
}
for (const prefix of ['给王总记一单', '帮我给王总记一单', '王总记个订单']) {
  check(`${prefix}：保留真实客户`, () => {
    const r = parse(`${prefix}帆布袋500个，6元一个，8月15日交`);
    assert.strictEqual(r.intent, 'order');
    assert.strictEqual(r.fields.customerName, '王总');
    assert.strictEqual(r.fields.items[0].productName, '帆布袋');
    assert.strictEqual(r.fields.dueDate, '2026-08-15');
  });
}
for (const prefix of ['记一下报价', '记个报价', '帮我记一笔报价']) {
  check(`${prefix}：指令不能变成客户`, () => {
    const r = parse(`${prefix}，帆布袋500个，6元一个`);
    assert.strictEqual(r.intent, 'quotation');
    assert.strictEqual(r.fields.customerName, '');
    assert.strictEqual(r.fields.items[0].productName, '帆布袋');
    assert(r.missing_fields.includes('customerName'));
  });
}
for (const prefix of ['记一笔', '记一下', '帮我记下']) {
  check(`${prefix}：不能仅凭记账指令猜业务类型`, () => {
    const r = parse(`${prefix}帆布袋500个，6元一个`);
    assert.strictEqual(r.intent, 'unknown');
    assert.strictEqual(r.fields.productName, '帆布袋');
    assert.strictEqual(r.fields.customerName, '');
    assert(r.missing_fields.includes('intent'));
  });
}
for (const prefix of ['不要', '先别', '不用', '暂时不', '先不要', '帮我先别']) {
  check(`${prefix}记一单：不创建订单`, () => {
    const r = parse(`${prefix}记一单，王总帆布袋500个，6元一个，8月15日交`);
    assert.strictEqual(r.intent, 'unknown');
    assert.strictEqual(r.formal_save_blocked, true);
    assert.strictEqual(r.fields.items, undefined);
    assert.strictEqual(evaluateRecordDomainPreflight({ finalResult: r, initialState: {},
      skipFinalSafety: true }).domainCanSaveFormal, false);
  });
}
for (const product of ['记事本', '记忆棉', '单据夹', '备忘录']) {
  check(`${product}：真实商品名不误删`, () => {
    const r = parse(`王总下单${product}500个，6元一个，8月15日交`);
    assert.strictEqual(r.fields.items[0].productName, product);
    assert.strictEqual(r.fields.customerName, '王总');
  });
}
for (const prefix of ['要不要', '能不能', '如果', '准备', '打算']) {
  check(`${prefix}记一单：未确定的请求不能正式保存`, () => {
    const r = parse(`${prefix}记一单，王总帆布袋500个，6元一个，8月15日交`);
    assert.strictEqual(r.intent, 'unknown');
    assert.strictEqual(r.formal_save_blocked, true);
  });
}
for (const text of ['记一单，王总帆布袋500个，6元一个，8月15日交，还没下单',
  '记一下报价，王总帆布袋500个，单价6元，暂时不报价']) {
  check(`${text}：指令不覆盖后续否定事实`, () => {
    const r = parse(text);
    assert.strictEqual(r.intent, 'unknown');
    assert.strictEqual(r.formal_save_blocked, true);
  });
}
check('明确重新肯定下单：不被前一段否定吞掉', () => {
  const r = parse('记一单，王总之前还没下单，现在下单帆布袋500个，6元一个，8月15日交');
  assert.strictEqual(r.intent, 'order');
  assert.strictEqual(r.fields.customerName, '王总');
});
for (const text of ['记一单是什么意思', '要不要记一单', '如果记一单', '', '今天天气不错，晚点出去走走']) {
  check(`${text || '空输入'}：不新增指令订单依据`, () => {
    const r = parse(text);
    assert.notStrictEqual(r.intent, 'order');
    assert(!(r.intent_evidence.orderPositiveSignals || []).some((signal) => /记一单/.test(signal.sourceText)));
  });
}
check('粘贴提取内容：原聊天与识别文本分别保留', () => {
  const text = '记一单帆布袋500个，6元一个，8月15日交';
  const rawText = `老板：${text}`;
  const r = parse(text, { source: 'paste', rawText, extractedText: text });
  assert.strictEqual(r.fields.items[0].productName, '帆布袋');
  assert.strictEqual(r.extracted_text, text);
  assert.strictEqual(r.raw_text, rawText);
});
check('复杂关联原话：不删除既有订单指代', () => {
  const r = parse('记一笔，王总这单还欠3000元，8月15日收');
  assert.strictEqual(r.intent, 'receivable');
  assert(r.relation_references.order.requiresResolution);
  assert.strictEqual(r.relation_references.order.resolvedEntityId, null);
  assert.strictEqual(r.fields.orderId || '', '');
});
console.log(`Common phrasing parser: ${passed}/${total} passed`);
