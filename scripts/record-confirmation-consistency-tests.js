#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { withFixedTestClock } = require('./lib/fixed-test-clock');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { createInitialState } = require('../utils/storage');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const clone = (value) => JSON.parse(JSON.stringify(value));
const options = { businessDate: '2026-07-22' };

function order(overrides = {}) {
  return Object.assign({
    intent: 'order', operation: 'create_order', source: 'typed',
    original_text: '王总订礼品盒100个每个10元，2026年8月1日交',
    fields: {
      customerName: '王总', productName: '礼品盒', quantity: '100', unit: '个',
      unitPrice: '10', priceUnit: '个', amount: '1000', dueDate: '2026-08-01',
      items: [{ productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' }]
    },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  }, clone(overrides));
}

function confirmation(draft) {
  const file = path.resolve(__dirname, '../pages/input/input.js');
  const sandbox = { require: createRequire(file), console, Date: global.Date, Page() {}, wx: {}, result: null };
  vm.runInNewContext(`${fs.readFileSync(file, 'utf8')}\nresult = buildConfirmationState;`, sandbox);
  return sandbox.result(createInitialState(), draft, draft.intent, draft.fields);
}

function identitySnapshot(result) {
  return clone({
    originalText: result.original_text, fields: result.fields,
    manualItems: result.manual_item_fields, proofs: result.user_manual_edits,
    missing: result.missing_fields, low: result.low_confidence_fields, conflicts: result.field_conflicts
  });
}

test('空人工确认集合不会在重复核对时新增商品身份', () => {
  const first = applyFinalParseSafety(order(), options);
  assert.strictEqual(first.fields.items[0].confirmationItemKey, undefined);
  let current = first;
  for (let index = 0; index < 4; index += 1) {
    current = applyFinalParseSafety(current, options);
    assert.deepStrictEqual(identitySnapshot(current), identitySnapshot(first));
  }
});

test('同名多商品重复核对不改身份、顺序或金额', () => {
  const draft = order();
  draft.fields.items.push({ productName: '礼品盒', spec: '大号', quantity: '20', unit: '个', unitPrice: '15', priceUnit: '个', totalAmount: '300' });
  draft.fields.amount = '1300';
  draft.original_text = '王总订礼品盒100个每个10元，大号礼品盒20个每个15元，2026年8月1日交';
  const first = applyFinalParseSafety(draft, options);
  assert.deepStrictEqual(identitySnapshot(applyFinalParseSafety(first, options)), identitySnapshot(first));
});

test('已有商品身份与真实人工字段在重复核对中保持稳定', () => {
  for (const suppliedKey of ['', 'existing-confirmed-item']) {
    const draft = order({ manual_fields: ['quantity'] });
    if (suppliedKey) draft.fields.items[0].confirmationItemKey = suppliedKey;
    const first = applyFinalParseSafety(draft, options);
    assert(first.fields.items[0].confirmationItemKey);
    if (suppliedKey) assert.strictEqual(first.fields.items[0].confirmationItemKey, suppliedKey);
    assert.deepStrictEqual(identitySnapshot(applyFinalParseSafety(first, options)), identitySnapshot(first));
  }
});

test('最终核对不修改调用方草稿或原话', () => {
  const draft = order({ manual_item_fields: [] });
  const before = clone(draft);
  const checked = applyFinalParseSafety(draft, options);
  assert.deepStrictEqual(draft, before);
  assert.strictEqual(checked.original_text, before.original_text);
  assert.strictEqual(checked.fields.amount, '1000');
});

test('明确订单清理过时的缺类型标记，缺交期仍保留', () => {
  const draft = order({ missing_fields: ['intent', 'dueDate'] });
  delete draft.fields.dueDate;
  draft.original_text = '王总订礼品盒100个每个10元';
  const checked = applyFinalParseSafety(draft, options);
  assert(!checked.missing_fields.includes('intent'));
  assert(checked.missing_fields.includes('dueDate'));
});

test('未确定、混合业务及业务类型冲突仍要求确认类型', () => {
  const cases = [
    order({ intent: 'unknown', operation: 'pending', missing_fields: ['intent'] }),
    order({ mixed_business: true, missing_fields: ['intent'] }),
    order({ missing_fields: ['intent'], low_confidence_fields: ['intent'] }),
    order({ missing_fields: ['intent'], field_conflicts: [{ field: 'intent', values: ['order', 'payment'] }] })
  ];
  cases.forEach((draft) => assert(applyFinalParseSafety(draft, options).missing_fields.includes('intent')));
});

test('AI明确表示类型未确定时不能凭其非空类型清除风险', () => {
  const draft = order({
    missing_fields: ['intent'],
    ai_fallback: { status: 'returned_uncertain', needed: true },
    ai_business_validity: { kind: 'uncertain' }
  });
  assert(applyFinalParseSafety(draft, options).missing_fields.includes('intent'));
});

test('闲聊只显示无需记录，仍禁止正式保存及待整理', () => {
  for (const originalText of ['今天天气不错，晚点出去走走', '今天天气不错，晚点出去走走。\n'.repeat(1000)]) {
    const view = confirmation({
      intent: 'unknown', operation: 'pending', fields: {}, original_text: originalText,
      source: 'typed', missing_fields: ['intent'], low_confidence_fields: [], field_conflicts: [],
      parse_route: { decision: 'no_record', no_record_eligible: true }
    });
    assert.strictEqual(view.isNoRecord, true);
    assert.strictEqual(view.showSurfaceGlobalRisk, false);
    assert.strictEqual(view.surfaceGlobalRiskText, '');
    assert.strictEqual(view.showFormalSaveButton, false);
    assert.strictEqual(view.showPendingButton, false);
    assert.strictEqual(view.surfaceOriginalText, originalText);
    assert.strictEqual(view.surfaceConfirmTitle, '这条无需记录');
  }
});

test('订单确认卡只提示真正缺少的交期，不重复追问业务类型', () => {
  const draft = order({ missing_fields: ['intent', 'dueDate'] });
  delete draft.fields.dueDate;
  draft.original_text = '王总订礼品盒100个每个10元';
  const view = confirmation(draft);
  assert(!view.parseResult.missing_fields.includes('intent'));
  assert(view.parseResult.missing_fields.includes('dueDate'));
  assert(!String(view.surfaceGlobalRiskText).includes('业务类型'));
  assert.strictEqual(view.disableFormalSave, true);
});

test('无需记录的观察保留内部风险，错误提示或保存入口不能被报告隐藏', () => {
  const { pageSnapshot } = require('../tests/record-e2e/runner/execute-page-observation');
  const data = {
    parseResult: { intent: 'unknown', fields: {}, missing_fields: ['intent'] },
    isNoRecord: true, showSurfaceGlobalRisk: false,
    showFormalSaveButton: false, showPendingButton: false, showDeepReviewButton: false
  };
  const driver = { surface: 'FULL_PAGE', page: { data } };
  let snapshot = pageSnapshot(driver);
  assert.deepStrictEqual(snapshot.rawMissingFields, ['intent']);
  assert.deepStrictEqual(snapshot.missingFields, []);
  data.showSurfaceGlobalRisk = true;
  assert.deepStrictEqual(pageSnapshot(driver).missingFields, ['intent']);
  data.showSurfaceGlobalRisk = false;
  data.showFormalSaveButton = true;
  assert.deepStrictEqual(pageSnapshot(driver).missingFields, ['intent']);
});

test('去除过时类型提示不能使失败或模拟AI取得正式保存资格', () => {
  for (const fallback of [
    { status: 'failed', attempted: true, business_result_valid: false },
    { status: 'used', attempted: true, business_result_valid: true, provider_kind: 'FAKE' }
  ]) {
    const view = confirmation(order({
      missing_fields: ['intent'], ai_fallback: fallback,
      parse_route: { decision: 'ai_standard' }
    }));
    assert.strictEqual(view.domainCanSaveFormal, false);
    assert.strictEqual(view.disableFormalSave, true);
  }
});

async function main() {
  let passed = 0;
  for (const current of tests) {
    try {
      await withFixedTestClock('2026-07-22T02:00:00.000Z', 'Asia/Shanghai', current.run);
      passed += 1;
      console.log(`PASS ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}: ${error.message}`);
    }
  }
  console.log(`Confirmation consistency: ${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
