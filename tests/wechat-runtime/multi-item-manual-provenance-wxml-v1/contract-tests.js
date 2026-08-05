#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildExecutionPlan } = require('../../record-e2e/runner/build-execution-plan');
const { createCaseRuntime } = require('../../record-e2e/runner/create-case-runtime');
const { loadCorpus } = require('../../record-e2e/runner/load-corpus');
const { loadProductionPage } = require('../../record-e2e/runner/page-vm-driver');
const { safeClone } = require('../../../utils/record-state-diff');
const { withFrozenClock } = require('../../record-e2e/multi-item-order-complete-save-v1/clock');

const ROOT = path.resolve(__dirname, '../../..');
const WXML = fs.readFileSync(path.join(ROOT, 'pages/input/input.wxml'), 'utf8');
const tests = [];
const corpus = loadCorpus();
const pageCase = corpus.byId.get('REC-E2E-MULTI-001');
assert(pageCase, 'Missing REC-E2E-MULTI-001 page fixture');
const pagePlan = buildExecutionPlan(pageCase, corpus.fixtureResolver);

function test(caseId, title, fn) {
  tests.push({ caseId, title, fn });
}

function item(itemKey, productName, spec, quantity, unitPrice) {
  return {
    confirmationItemKey: itemKey,
    productName,
    spec,
    quantity: String(quantity),
    unit: '个',
    unitPrice: String(unitPrice),
    priceUnit: '个',
    totalAmount: String(Number(quantity) * Number(unitPrice))
  };
}

function orderDraft(items, options = {}) {
  const total = items.reduce((sum, current) => sum + Number(current.totalAmount || 0), 0);
  return {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: options.originalText
      || '王总下单：礼品盒10个，每个3元；饭盒20个，每个5元；8月15日交货。',
    parse_route: { decision: 'local' },
    ai_fallback: { status: 'not_requested', attempted: false, needed: false },
    fields: {
      customerName: '王总',
      dueDate: '2026-08-15',
      productName: items[0] && items[0].productName || '',
      quantity: items[0] && items[0].quantity || '',
      unit: items[0] && items[0].unit || '',
      unitPrice: items[0] && items[0].unitPrice || '',
      priceUnit: items[0] && items[0].priceUnit || '',
      amount: String(total),
      totalAmount: String(total),
      calculatedAmount: String(total),
      items: safeClone(items)
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: safeClone(options.conflicts || []),
    manual_fields: [],
    manual_item_fields: []
  };
}

function withPage(run) {
  const runtime = createCaseRuntime(safeClone(pagePlan.workerSpec), { attempt: 1 });
  try {
    const driver = loadProductionPage('FULL_PAGE', runtime, pagePlan.workerSpec, {
      runLifecycle: false
    });
    return run({ driver, page: driver.page, runtime });
  } finally {
    runtime.dispose();
  }
}

function install(page, draft) {
  page.setData({
    fields: safeClone(draft.fields),
    intent: draft.intent,
    operation: draft.operation,
    parseResult: safeClone(draft),
    disableFormalSave: false
  });
}

function edit(page, index, field, value, itemKey = '') {
  page.updateItemField({
    currentTarget: { dataset: { index, itemKey, field } },
    detail: { value }
  });
}

function remove(page, index, itemKey = '') {
  page.removeConfirmItem({ currentTarget: { dataset: { index, itemKey } } });
}

function keys(page) {
  return (page.data.confirmItems || []).map((entry) => entry.itemKey);
}

function manualEntries(page) {
  return Array.isArray((page.data.parseResult || {}).manual_item_fields)
    ? page.data.parseResult.manual_item_fields
    : [];
}

test('WXML-001', '稳定key不依赖index或商品名', () => {
  assert(/wx:for="\{\{confirmItems\}\}"[^>]*wx:key="itemKey"/.test(WXML));
  assert(!/wx:for="\{\{confirmItems\}\}"[^>]*wx:key="(?:index|productName|itemIndex)"/.test(WXML));
  assert(/class="confirm-item-card"[^>]*data-item-key="\{\{item\.itemKey\}\}"/.test(WXML));
  withPage(({ page }) => {
    install(page, orderDraft([
      item('same-large', '礼品盒', '大号', 10, 3),
      item('same-small', '礼品盒', '小号', 20, 4)
    ]));
    edit(page, 0, 'quantity', '11', 'same-large');
    assert.deepStrictEqual(keys(page), ['same-large', 'same-small']);
  });
});

test('WXML-002', '编辑商品1不影响商品2', () => {
  withPage(({ page }) => {
    install(page, orderDraft([
      item('edit-a', '礼品盒', '大号', 10, 3),
      item('edit-b', '饭盒', '小号', 20, 5)
    ]));
    edit(page, 0, 'quantity', '12', 'edit-a');
    assert.strictEqual(page.data.fields.items[0].quantity, '12');
    assert.strictEqual(page.data.fields.items[1].quantity, '20');
    assert(manualEntries(page).some((entry) => entry.itemKey === 'edit-a' && entry.field === 'quantity'));
    assert(!manualEntries(page).some((entry) => entry.itemKey === 'edit-b' && entry.field === 'quantity'));
  });
});

test('WXML-003', '删除商品1后原商品2不串位', () => {
  withPage(({ page }) => {
    install(page, orderDraft([
      item('remove-a', '礼品盒', '大号', 10, 3),
      item('remove-b', '饭盒', '小号', 20, 5)
    ]));
    edit(page, 0, 'productName', '礼品盒彩盒', 'remove-a');
    remove(page, 0, 'remove-a');
    assert.deepStrictEqual(keys(page), ['remove-b']);
    assert.strictEqual(page.data.fields.items[0].productName, '饭盒');
    assert.strictEqual(page.data.fields.items[0].quantity, '20');
    assert(!manualEntries(page).some((entry) => entry.itemKey === 'remove-a'));
  });
});

test('WXML-004', '新增商品获得新key且不继承旧状态', () => {
  withPage(({ page }) => {
    install(page, orderDraft([item('existing-item', '水杯', '大号', 10, 3)]));
    edit(page, 0, 'productName', '保温杯', 'existing-item');
    page.addConfirmItem();
    const currentKeys = keys(page);
    assert.strictEqual(currentKeys.length, 2);
    assert.strictEqual(new Set(currentKeys).size, 2);
    assert.notStrictEqual(currentKeys[1], 'existing-item');
    assert(!manualEntries(page).some((entry) => entry.itemKey === currentKeys[1]));
    assert.strictEqual(page.data.fields.items[1].quantity, '');
  });
});

test('WXML-005', '同名不同规格保持独立节点', () => {
  withPage(({ page }) => {
    install(page, orderDraft([
      item('gift-large', '礼品盒', '大号', 10, 3),
      item('gift-small', '礼品盒', '小号', 20, 4)
    ]));
    edit(page, 1, 'spec', '迷你号', 'gift-small');
    assert.strictEqual(page.data.fields.items[0].spec, '大号');
    assert.strictEqual(page.data.fields.items[1].spec, '迷你号');
    assert.deepStrictEqual(keys(page), ['gift-large', 'gift-small']);
  });
});

test('WXML-006', '合法重排后provenance跟随身份', () => {
  withPage(({ page }) => {
    const draft = orderDraft([
      item('reorder-a', '礼品盒', '大号', 10, 3),
      item('reorder-b', '饭盒', '小号', 20, 5)
    ]);
    install(page, draft);
    edit(page, 0, 'quantity', '11', 'reorder-a');
    const current = safeClone(page.data.parseResult);
    const reorderedItems = [safeClone(current.fields.items[1]), safeClone(current.fields.items[0])];
    page.setData({
      fields: Object.assign({}, safeClone(current.fields), { items: reorderedItems }),
      parseResult: Object.assign({}, current, {
        fields: Object.assign({}, safeClone(current.fields), { items: reorderedItems })
      }),
      confirmItems: [safeClone(page.data.confirmItems[1]), safeClone(page.data.confirmItems[0])]
    });
    assert.deepStrictEqual(keys(page), ['reorder-b', 'reorder-a']);
    assert(manualEntries(page).some((entry) => entry.itemKey === 'reorder-a' && entry.field === 'quantity'));
    assert(!manualEntries(page).some((entry) => entry.itemKey === 'reorder-b' && entry.field === 'quantity'));
  });
});

test('WXML-007', '阻断原因真实绑定到确认卡且按钮禁用', () => {
  assert(/wx:if="\{\{showDomainBlocking\}\}"[^>]*class="[^"]*domain-blocking-box/.test(WXML));
  assert(/wx:for="\{\{domainBlockingLines\}\}"/.test(WXML));
  withPage(({ driver, page }) => {
    install(page, orderDraft([item('risk-source', '水杯', '大号', 10, 3)], {
      originalText: '王总订水杯10个，3元一个，8月15日交货。'
    }));
    page.addConfirmItem();
    const added = page.data.fields.items[1];
    const issue = (page.data.domainPreflight.blockingIssues || []).find((entry) => (
      entry.code === 'ORDER_ITEM_QUANTITY_REQUIRED'
    ));
    assert(issue);
    assert.strictEqual(issue.itemKey, added.confirmationItemKey);
    assert.strictEqual(issue.itemField, 'quantity');
    assert.strictEqual(page.data.disableFormalSave, true);
    assert.strictEqual(page.data.showDomainBlocking, true);
    assert((page.data.domainBlockingLines || []).some((line) => /商品2/.test(line) && /数量/.test(line)));
    page.saveFormal();
    assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
    assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
  });
});

test('WXML-008', '补齐对应字段后提示消失且按钮恢复', () => {
  withPage(({ page }) => {
    install(page, orderDraft([item('recover-source', '水杯', '大号', 10, 3)], {
      originalText: '王总订水杯10个，3元一个，8月15日交货。'
    }));
    page.addConfirmItem();
    const addedKey = page.data.fields.items[1].confirmationItemKey;
    assert.strictEqual(page.data.disableFormalSave, true);
    edit(page, 1, 'quantity', '20', addedKey);
    assert.strictEqual(page.data.fields.items[1].confirmationItemKey, addedKey);
    assert(manualEntries(page).some((entry) => entry.itemKey === addedKey && entry.field === 'quantity'));
    assert(!(page.data.preflightBlockingReasons || []).includes('ORDER_ITEM_QUANTITY_REQUIRED'));
    assert(!(page.data.domainBlockingLines || []).some((line) => /商品2/.test(line) && /数量/.test(line)));
    assert.strictEqual(
      page.data.disableFormalSave,
      false,
      JSON.stringify({
        reasons: page.data.preflightBlockingReasons,
        issues: (page.data.domainPreflight || {}).blockingIssues,
        fields: page.data.fields
      })
    );
  });
});

test('WXML-009', '删除重排后阻断提示使用当前商品序号', () => {
  withPage(({ page }) => {
    install(page, orderDraft([
      item('warning-a', '礼品盒', '大号', 10, 3),
      item('warning-b', '候选饭盒', '小号', 20, 5)
    ], {
      conflicts: [{
        code: 'AI_MATCHED_ITEM_FIELD_UNSUPPORTED',
        field: 'items',
        itemKey: 'warning-b',
        itemIndex: 1,
        itemField: 'productName',
        fieldPath: 'items[1].productName',
        values: ['候选饭盒'],
        message: '商品2名称待确认。'
      }]
    }));
    remove(page, 0, 'warning-a');
    assert.deepStrictEqual(keys(page), ['warning-b']);
    assert((page.data.domainBlockingLines || []).some((line) => (
      /商品1/.test(line) && /产品\/规格/.test(line) && /名称待确认/.test(line)
    )));
    assert(!(page.data.domainBlockingLines || []).some((line) => /商品2/.test(line)));
    assert.strictEqual(page.data.disableFormalSave, true);
  });
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
  console.log(`Multi-item provenance WXML contract: PASS=${passed} CASE_FAIL=${failed} RUNNER_ERROR=0`);
  console.log('EVIDENCE_LEVEL=STATIC_SOURCE+PAGE_VM; REAL_WXML_NOT_EXECUTED');
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
