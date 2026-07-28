#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildExecutionPlan, buildAllExecutionPlans } = require('../runner/build-execution-plan');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../runner/constants');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadCorpus } = require('../runner/load-corpus');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { executeOne } = require('../runner/run-suite');

const corpus = loadCorpus();

function bundle(caseId) {
  const testCase = corpus.byId.get(caseId);
  assert(testCase, `Missing Case ${caseId}`);
  return {
    testCase,
    ...buildExecutionPlan(testCase, corpus.fixtureResolver)
  };
}

function withPage(caseId, run) {
  const item = bundle(caseId);
  const runtime = createCaseRuntime(item.workerSpec, { attempt: 1 });
  try {
    const driver = loadProductionPage('FULL_PAGE', runtime, item.workerSpec, {
      runLifecycle: false
    });
    return run({ driver, item, page: driver.page, runtime });
  } finally {
    runtime.dispose();
  }
}

function prepareConfirmation(page, parseResult) {
  page.setData({
    fields: parseResult.fields,
    intent: parseResult.intent,
    parseResult
  });
  const intentIndex = {
    quotation: 0,
    order: 1,
    receivable: 2,
    payment: 3,
    dunning: 4,
    todo: 5,
    unknown: 6
  }[parseResult.intent];
  page.changeIntent({ detail: { value: intentIndex } });
}

function receivableDraft(fields = {}) {
  return {
    intent: 'receivable',
    operation: 'create_receivable',
    source: 'typed',
    original_text: '王总收纳盒这单还有8000元待收，7月25日收',
    parse_route: { decision: 'local' },
    fields: Object.assign({
      amount: '8000',
      customerId: 'cus-syn-a',
      customerName: '王总',
      dueDate: '2026-07-25',
      productName: '收纳盒'
    }, fields),
    missing_fields: [],
    low_confidence_fields: []
  };
}

const tests = [
  {
    name: 'full-page-exposes-real-select-order-capability',
    run() {
      withPage('REC-E2E-BASIC-010', ({ driver, page }) => {
        assert.strictEqual(driver.availableCapabilities.SELECT_ORDER, true);
        assert.strictEqual(typeof page.changeOrder, 'function');
        assert.strictEqual(typeof page.selectOrderCandidate, 'function');
        assert.strictEqual(typeof page.clearOrderSelection, 'function');
      });
    }
  },
  {
    name: 'preflight-candidate-is-selected-through-real-page-method',
    run() {
      withPage('REC-E2E-BASIC-010', ({ driver, page }) => {
        prepareConfirmation(page, receivableDraft());
        assert.strictEqual(page.data.showGenericOrderSelection, true);
        assert.deepStrictEqual(
          Array.from(page.data.orderOptions, (item) => item.id),
          ['ord-active-a']
        );
        const fingerprintBefore = page.data.preflightFingerprint;
        const canSaveBefore = page.data.domainCanSaveFormal;
        page.changeOrder({ detail: { value: 0 } });
        assert.strictEqual(page.data.fields.orderId, 'ord-active-a');
        assert.strictEqual(page.data.selectedOrderId, 'ord-active-a');
        assert.strictEqual(page.data.fields.orderSelectionConfirmed, true);
        assert.strictEqual(page.data.parseResult.original_text, receivableDraft().original_text);
        assert.strictEqual(page.data.domainCanSaveFormal, true);
        assert.strictEqual(page.data.preflightFingerprint === fingerprintBefore, false);
        assert.strictEqual(canSaveBefore, true);
        assert.strictEqual(driver.evidence.pageMethodCalls.changeOrder, 1);
        assert.strictEqual(driver.evidence.pageMethodCalls.applyOrderSelection, 1);
      });
    }
  },
  {
    name: 'update-order-selection-hydrates-target-and-keeps-user-date',
    run() {
      withPage('REC-E2E-REL-003', ({ page }) => {
        const draft = {
          intent: 'order',
          operation: 'update_order',
          source: 'typed',
          original_text: '王总那单改成7月27日交',
          parse_route: { decision: 'local' },
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            dueDate: '2026-07-27'
          },
          missing_fields: [],
          low_confidence_fields: []
        };
        prepareConfirmation(page, draft);
        assert.strictEqual(page.data.orderSelectionRequired, true);
        assert(page.data.preflightBlockingReasons.includes('ORDER_TARGET_REQUIRED'));
        page.changeOrder({ detail: { value: 0 } });
        assert.strictEqual(page.data.operation, 'update_order');
        assert.strictEqual(page.data.fields.orderId, 'ord-syn-a-1');
        assert.strictEqual(page.data.fields.productName, '礼品盒');
        assert.strictEqual(page.data.fields.dueDate, '2026-07-27');
        assert.strictEqual(page.data.parseResult.original_text, draft.original_text);
        assert.strictEqual(page.data.preflightBlockingReasons.includes('ORDER_TARGET_REQUIRED'), false);
      });
    }
  },
  {
    name: 'cross-customer-forged-order-event-is-rejected',
    run() {
      withPage('REC-E2E-REL-009', ({ driver, page }) => {
        prepareConfirmation(page, receivableDraft({
          customerId: 'cus-cross-a',
          customerName: '王总',
          productName: ''
        }));
        assert(page.data.orderOptions.some((item) => item.id === 'ord-cross-a'));
        assert.strictEqual(page.data.orderOptions.some((item) => item.id === 'ord-cross-b'), false);
        const accepted = page.selectOrderCandidate({
          currentTarget: { dataset: { orderId: 'ord-cross-b' } }
        });
        assert.strictEqual(accepted, false);
        assert.notStrictEqual(page.data.fields.orderId, 'ord-cross-b');
        assert.strictEqual(driver.evidence.pageMethodCalls.selectOrderCandidate, 1);
        assert.strictEqual(
          driver.evidence.pageMethodCalls.applyOrderSelection,
          1
        );
      });
    }
  },
  {
    name: 'deleted-order-after-display-is-rejected-on-selection',
    run() {
      withPage('REC-E2E-BASIC-010', ({ page, runtime }) => {
        prepareConfirmation(page, receivableDraft());
        const state = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
        state.orders = [];
        runtime.fakeWx.wx.setStorageSync(BUSINESS_STORAGE_KEY, state);
        const accepted = page.changeOrder({ detail: { value: 0 } });
        assert.strictEqual(accepted, false);
        assert.notStrictEqual(page.data.fields.orderId, 'ord-active-a');
        assert.strictEqual(page.data.orderOptions.length, 0);
      });
    }
  },
  {
    name: 'deleted-order-after-selection-is-blocked-again-at-save',
    run() {
      withPage('REC-E2E-REL-003', ({ driver, page, runtime }) => {
        prepareConfirmation(page, {
          intent: 'order',
          operation: 'update_order',
          source: 'typed',
          original_text: '王总那单改成7月27日交',
          parse_route: { decision: 'local' },
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            dueDate: '2026-07-27'
          },
          missing_fields: [],
          low_confidence_fields: []
        });
        page.changeOrder({ detail: { value: 0 } });
        const state = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
        state.orders = [];
        runtime.fakeWx.wx.setStorageSync(BUSINESS_STORAGE_KEY, state);
        page.saveFormal();
        assert(page.data.preflightBlockingReasons.includes('ORDER_TARGET_NOT_FOUND'));
        assert.strictEqual(page.data.disableFormalSave, true);
        assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
        assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      });
    }
  },
  {
    name: 'clear-selection-restores-required-update-block',
    run() {
      withPage('REC-E2E-REL-003', ({ page }) => {
        prepareConfirmation(page, {
          intent: 'order',
          operation: 'update_order',
          source: 'typed',
          original_text: '王总那单改成7月27日交',
          parse_route: { decision: 'local' },
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            dueDate: '2026-07-27'
          },
          missing_fields: [],
          low_confidence_fields: []
        });
        page.changeOrder({ detail: { value: 0 } });
        assert.strictEqual(page.data.fields.orderId, 'ord-syn-a-1');
        page.clearOrderSelection();
        assert.strictEqual(Boolean(page.data.fields.orderId), false);
        assert.strictEqual(page.data.orderSelectionRequired, true);
        assert(page.data.preflightBlockingReasons.includes('ORDER_TARGET_REQUIRED'));
        assert.strictEqual(page.data.disableFormalSave, true);
      });
    }
  },
  {
    name: 'user-can-change-between-two-preflight-approved-orders',
    run() {
      withPage('REC-E2E-REL-004', ({ page }) => {
        prepareConfirmation(page, {
          intent: 'order',
          operation: 'update_order',
          source: 'typed',
          original_text: '王总那单交期改成7月31日',
          parse_route: { decision: 'local' },
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            dueDate: '2026-07-31'
          },
          missing_fields: [],
          low_confidence_fields: []
        });
        assert.deepStrictEqual(
          Array.from(page.data.orderOptions, (item) => item.id),
          ['ord-syn-a-1', 'ord-syn-a-2']
        );
        page.changeOrder({ detail: { value: 0 } });
        assert.strictEqual(page.data.fields.orderId, 'ord-syn-a-1');
        assert.strictEqual(page.data.orderOptions.length, 2);
        page.changeOrder({ detail: { value: 1 } });
        assert.strictEqual(page.data.fields.orderId, 'ord-syn-a-2');
        assert.strictEqual(page.data.fields.productName, '纸袋');
        assert.strictEqual(page.data.fields.dueDate, '2026-07-31');
      });
    }
  },
  {
    name: 'customer-edit-invalidates-old-order-selection',
    run() {
      withPage('REC-E2E-BASIC-010', ({ page }) => {
        prepareConfirmation(page, receivableDraft());
        page.changeOrder({ detail: { value: 0 } });
        assert.strictEqual(page.data.fields.orderId, 'ord-active-a');
        page.updateField({
          currentTarget: { dataset: { field: 'customerName' } },
          detail: { value: '另一位客户' }
        });
        assert.strictEqual(Boolean(page.data.fields.orderId), false);
        assert.strictEqual(Boolean(page.data.orderSelectionBaseFields), false);
        assert.strictEqual(page.data.selectedOrderId, '');
      });
    }
  },
  {
    name: 'explicit-new-order-does-not-require-old-order-selection',
    run() {
      withPage('REC-E2E-REL-003', ({ page }) => {
        const item = {
          productName: '新款礼品盒',
          quantity: '100',
          unit: '套',
          unitPrice: '5',
          priceUnit: '套',
          totalAmount: '500'
        };
        prepareConfirmation(page, {
          intent: 'order',
          operation: 'create_order',
          source: 'typed',
          original_text: '王总新下一单新款礼品盒100套，5元一套，7月27日交',
          parse_route: { decision: 'local' },
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            dueDate: '2026-07-27',
            items: [item],
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            priceUnit: item.priceUnit,
            amount: item.totalAmount,
            totalAmount: item.totalAmount
          },
          missing_fields: [],
          low_confidence_fields: []
        });
        assert.strictEqual(page.data.operation, 'create_order');
        assert.strictEqual(page.data.orderSelectionRequired, false);
        assert.strictEqual(page.data.showGenericOrderSelection, false);
      });
    }
  },
  {
    name: 'select-quotation-remains-unimplemented',
    run() {
      withPage('REC-E2E-REL-007', ({ driver, page }) => {
        assert.strictEqual(driver.availableCapabilities.SELECT_QUOTATION, false);
        assert.strictEqual(typeof page.changeQuotation, 'undefined');
      });
    }
  },
  {
    name: 'target-cases-no-longer-fail-for-missing-select-order-capability',
    async run() {
      const all = buildAllExecutionPlans(corpus);
      for (const caseId of [
        'REC-E2E-BASIC-010',
        'REC-E2E-REL-003',
        'REC-E2E-REL-009'
      ]) {
        const result = await executeOne(all.find((item) => item.testCase.caseId === caseId));
        assert.notStrictEqual(result.caseStatus, 'RUNNER_ERROR');
        assert.notStrictEqual(result.caseStatus, 'BLOCKED');
        assert.strictEqual(result.surfaceEvidence.availableCapabilities.SELECT_ORDER, true);
        assert.strictEqual(result.surfaceEvidence.missingCapabilities.includes('SELECT_ORDER'), false);
        assert.notStrictEqual(result.failureCode, 'REQUIRED_PAGE_CAPABILITY_MISSING');
      }
    }
  },
  {
    name: 'wxml-binds-generic-picker-and-home-is-unchanged',
    run() {
      const inputWxml = fs.readFileSync(path.join(ROOT, 'pages/input/input.wxml'), 'utf8');
      const dashboardJs = fs.readFileSync(path.join(ROOT, 'pages/dashboard/dashboard.js'), 'utf8');
      assert(inputWxml.includes('bindchange="changeOrder"'));
      assert(inputWxml.includes('bindtap="clearOrderSelection"'));
      assert.strictEqual(dashboardJs.includes('changeOrder(event)'), false);
    }
  }
];

async function main() {
  let passed = 0;
  for (const test of tests) {
    await test.run();
    passed += 1;
    console.log(`PASS ${test.name}`);
  }
  console.log(`Order selection surface tests: ${passed}/${tests.length} passed`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  tests
};
