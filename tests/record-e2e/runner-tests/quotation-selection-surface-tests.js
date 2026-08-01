#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildExecutionPlan } = require('../runner/build-execution-plan');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../runner/constants');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadCorpus } = require('../runner/load-corpus');
const { loadProductionPage } = require('../runner/page-vm-driver');

const corpus = loadCorpus();

function bundle() {
  const testCase = corpus.byId.get('REC-E2E-REL-010');
  assert(testCase, 'Missing quotation selection fixture Case');
  return {
    testCase,
    ...buildExecutionPlan(testCase, corpus.fixtureResolver)
  };
}

function withPage(run) {
  const item = bundle();
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

function prepareConfirmation(page, parseResult, intentIndex = 0) {
  page.setData({
    fields: parseResult.fields,
    intent: parseResult.intent,
    parseResult
  });
  page.changeIntent({ detail: { value: intentIndex } });
  page.setData(page.data);
}

function quotationDraft(fields = {}) {
  return {
    intent: 'quotation',
    operation: 'update_quotation',
    source: 'typed',
    original_text: '把王总上次报价改成16元一套',
    parse_route: { decision: 'local' },
    fields: Object.assign({
      customerId: 'cus-syn-a',
      customerName: '王总',
      unitPrice: '16'
    }, fields),
    missing_fields: [],
    low_confidence_fields: []
  };
}

function quotationConversionOrderDraft(options = {}) {
  const sourceText = options.sourceText || '王总那个保温杯报价';
  const originalText = `${sourceText}再转成订单`;
  const conversionText = '报价再转成订单';
  const normalizedReference = options.normalizedReference || '王总:保温杯:QUOTATION';
  return {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: originalText,
    parse_route: { decision: 'local' },
    fields: Object.assign({
      customerId: 'cus-syn-a',
      customerName: '王总',
      productName: options.productName === undefined ? '保温杯' : options.productName,
      dueDate: '2026-07-30'
    }, options.fields || {}),
    intent_evidence: {
      quotationToOrderConversionSignals: [{
        kind: 'QUOTATION_TO_ORDER_CONVERSION',
        direction: 'QUOTATION_TO_ORDER',
        explicit: true,
        confidence: 0.99,
        evidenceSource: 'LOCAL_PARSER',
        sourceField: 'ORIGINAL_TEXT',
        sourceText: conversionText,
        sourceSpan: {
          start: originalText.indexOf(conversionText),
          end: originalText.indexOf(conversionText) + conversionText.length
        }
      }]
    },
    relation_references: {
      quotation: {
        entityType: 'QUOTATION',
        kind: 'EXPLICIT_QUOTATION_NAMED_REFERENCE',
        explicit: true,
        requiresResolution: true,
        sourceText,
        sourceSpan: { start: 0, end: sourceText.length },
        confidence: 0.97,
        normalizedReference,
        resolvedEntityId: null,
        evidenceSource: 'LOCAL_PARSER',
        sourceField: 'ORIGINAL_TEXT'
      }
    },
    missing_fields: [],
    low_confidence_fields: []
  };
}

function replaceState(runtime, mutate) {
  const state = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
  mutate(state);
  runtime.fakeWx.wx.setStorageSync(BUSINESS_STORAGE_KEY, state);
}

function candidateIds(page) {
  return Array.from(page.data.quotationCandidates || [], (item) => item.id);
}

const tests = [
  {
    name: 'full-page-exposes-real-select-quotation-capability',
    run() {
      withPage(({ driver, page }) => {
        assert.strictEqual(driver.availableCapabilities.SELECT_QUOTATION, true);
        assert.strictEqual(typeof page.changeQuotation, 'function');
        assert.strictEqual(typeof page.selectQuotationCandidate, 'function');
        assert.strictEqual(typeof page.clearQuotationSelection, 'function');
      });
    }
  },
  {
    name: 'required-update-shows-two-safe-candidates-without-auto-selection',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(page.data.operation, 'update_quotation');
        assert.strictEqual(page.data.quotationSelectionRequired, true);
        assert.strictEqual(page.data.showGenericQuotationSelection, true);
        assert.strictEqual(page.data.showGenericQuotationPicker, true);
        assert.deepStrictEqual(candidateIds(page), ['quo-syn-a-1', 'quo-syn-a-2']);
        assert.strictEqual(page.data.selectedQuotationId, '');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
      });
    }
  },
  {
    name: 'real-page-method-selects-quotation-and-recomputes-preflight',
    run() {
      withPage(({ driver, page }) => {
        prepareConfirmation(page, quotationDraft());
        const fingerprintBefore = page.data.preflightFingerprint;
        const accepted = page.changeQuotation({ detail: { value: 1 } });
        assert.strictEqual(accepted, true);
        assert.strictEqual(page.data.selectedQuotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.fields.quotationSelectionConfirmed, true);
        assert.strictEqual(page.data.quotationSelectionConfirmed, true);
        assert.strictEqual(page.data.preflightFingerprint === fingerprintBefore, false);
        assert.strictEqual(
          page.data.preflightBlockingReasons.includes('QUOTATION_TARGET_REQUIRED'),
          false
        );
        assert.strictEqual(driver.evidence.pageMethodCalls.changeQuotation, 1);
        assert.strictEqual(driver.evidence.pageMethodCalls.applyQuotationSelection, 1);
      });
    }
  },
  {
    name: 'page-binds-only-safe-preflight-projection',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        assert.deepStrictEqual(
          Object.keys(page.data.quotationCandidates[0]).sort(),
          [
            'convertedOrderId', 'createdAt', 'customerDisplayName', 'customerId', 'id', 'itemCount',
            'productSummary', 'quotationAmount', 'quotationId', 'quoteDate',
            'selectionBlockingCodes', 'selectionEligible', 'status', 'validUntil'
          ].sort()
        );
        assert.strictEqual(page.data.quotationCandidates[0].selectionEligible, true);
        assert.deepStrictEqual(page.data.quotationCandidates[0].selectionBlockingCodes, []);
        assert.strictEqual(
          page.data.quotationCandidates[0].originalText,
          undefined
        );
      });
    }
  },
  {
    name: 'clear-selection-restores-required-block',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        assert.strictEqual(page.clearQuotationSelection(), true);
        assert.strictEqual(page.data.selectedQuotationId, '');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.strictEqual(page.data.quotationSelectionRequired, true);
        assert(page.data.preflightBlockingReasons.includes('QUOTATION_TARGET_REQUIRED'));
      });
    }
  },
  {
    name: 'user-can-reselect-a-different-safe-quotation',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        page.changeQuotation({ detail: { value: 1 } });
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.selectedQuotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.selectedQuotation.id, 'quo-syn-a-2');
      });
    }
  },
  {
    name: 'customer-text-edit-clears-old-quotation-selection',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        page.updateField({
          currentTarget: { dataset: { field: 'customerName' } },
          detail: { value: '另一位客户' }
        });
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.strictEqual(page.data.selectedQuotationId, '');
      });
    }
  },
  {
    name: 'customer-picker-change-clears-old-quotation-selection',
    run() {
      withPage(({ page, runtime }) => {
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), true);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        replaceState(runtime, (state) => {
          state.customers.push({
            id: 'cus-syn-b',
            name: '王总',
            createdAt: '2026-07-01T00:00:00.000Z'
          });
          state.quotations.push({
            id: 'quo-syn-b-1',
            customerId: 'cus-syn-b',
            productName: '围裙',
            quantity: 80,
            unit: '件',
            unitPrice: 12,
            totalAmount: 960,
            items: [{
              productName: '围裙',
              quantity: 80,
              unit: '件',
              unitPrice: 12,
              totalAmount: 960
            }],
            status: '待确认',
            quoteDate: '2026-07-13',
            createdAt: '2026-07-13T02:00:00.000Z'
          });
        });
        page.setData({
          customerMatchOptions: [{ id: 'cus-syn-b', label: '王总 · 第2个' }]
        });
        page.changeCustomerMatch({ detail: { value: 0 } });
        assert.strictEqual(page.data.fields.customerId, 'cus-syn-b');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.deepStrictEqual(candidateIds(page), ['quo-syn-b-1']);
        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), true);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-b-1');
        assert.strictEqual(page.data.fields.productName, '围裙');
        assert.strictEqual(page.data.fields.items[0].productName, '围裙');
      });
    }
  },
  {
    name: 'selected-multi-item-quotation-allows-editing-second-item',
    run() {
      withPage(({ page, runtime }) => {
        replaceState(runtime, (state) => {
          state.quotations[0].items = [
            {
              productName: '保温杯',
              quantity: 300,
              unit: '个',
              unitPrice: 18,
              totalAmount: 5400
            },
            {
              productName: '杯盖',
              quantity: 40,
              unit: '个',
              unitPrice: 2,
              totalAmount: 80
            }
          ];
        });
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), true);
        assert.strictEqual(page.data.fields.items.length, 2);
        page.updateItemField({
          currentTarget: { dataset: { index: 1, field: 'quantity' } },
          detail: { value: 55 }
        });
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        assert.strictEqual(page.data.fields.items[1].productName, '杯盖');
        assert.strictEqual(page.data.fields.items[1].quantity, 55);
        assert.strictEqual(page.data.fields.items[1].totalAmount, '110');
      });
    }
  },
  {
    name: 'remove-historical-item-is-scoped-to-current-quotation-on-reselect',
    run() {
      withPage(({ page, runtime }) => {
        replaceState(runtime, (state) => {
          state.quotations[0].items = [
            {
              productName: '保温杯',
              quantity: 300,
              unit: '个',
              unitPrice: 18,
              totalAmount: 5400
            },
            {
              productName: '杯盖',
              quantity: 40,
              unit: '个',
              unitPrice: 2,
              totalAmount: 80
            }
          ];
          state.quotations[1].items = [
            {
              productName: '饭盒',
              quantity: 200,
              unit: '套',
              unitPrice: 15,
              totalAmount: 3000
            },
            {
              productName: '饭盒盖',
              quantity: 200,
              unit: '个',
              unitPrice: 1,
              totalAmount: 200
            }
          ];
        });
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        page.removeConfirmItem({
          currentTarget: { dataset: { index: 1 } }
        });
        assert.strictEqual(page.data.fields.items.length, 1);
        assert.strictEqual(page.changeQuotation({ detail: { value: 1 } }), true);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.fields.productName, '饭盒');
        assert.strictEqual(page.data.fields.items[0].productName, '饭盒');
        assert.strictEqual(page.data.fields.items.length, 2);
        assert.strictEqual(page.data.fields.items[1].productName, '饭盒盖');
        assert.strictEqual(
          page.data.fields.items.some((item) => item.productName === '保温杯'),
          false
        );
      });
    }
  },
  {
    name: 'added-item-is-scoped-to-current-quotation-and-cleared-on-cancel',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        page.addConfirmItem();
        assert.strictEqual(page.data.fields.items.length, 2);
        assert.strictEqual(page.changeQuotation({ detail: { value: 1 } }), true);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.fields.items.length, 1);
        assert.strictEqual(page.data.fields.items[0].productName, '饭盒');
        page.changeQuotation({ detail: { value: 0 } });
        page.addConfirmItem();
        assert.strictEqual(page.clearQuotationSelection(), true);
        assert.strictEqual(
          (page.data.fields.items || []).some((item) => item.productName === '保温杯'),
          false
        );
      });
    }
  },
  {
    name: 'intent-change-clears-old-quotation-selection',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        page.changeIntent({ detail: { value: 1 } });
        assert.strictEqual(page.data.intent, 'order');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.strictEqual(page.data.showGenericQuotationSelection, false);
      });
    }
  },
  {
    name: 'field-edit-revalidates-and-keeps-safe-selection',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        const before = page.data.preflightFingerprint;
        page.updateField({
          currentTarget: { dataset: { field: 'remark' } },
          detail: { value: '客户已确认新价' }
        });
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        assert.strictEqual(page.data.fields.remark, '客户已确认新价');
        assert.notStrictEqual(page.data.preflightFingerprint, before);
      });
    }
  },
  {
    name: 'forged-cross-customer-id-is-rejected',
    run() {
      withPage(({ page, runtime }) => {
        replaceState(runtime, (state) => {
          state.customers.push({ id: 'cus-other', name: '李姐' });
          state.quotations.push({
            id: 'quo-other',
            customerId: 'cus-other',
            productName: '钥匙扣',
            status: '待确认'
          });
        });
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), true);
        const accepted = page.selectQuotationCandidate({
          currentTarget: { dataset: { quotationId: 'quo-other' } }
        });
        assert.strictEqual(accepted, false);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        assert.strictEqual(page.data.selectedQuotationId, 'quo-syn-a-1');
        assert.strictEqual(candidateIds(page).includes('quo-other'), false);
      });
    }
  },
  {
    name: 'forged-converted-id-is-rejected',
    run() {
      withPage(({ page, runtime }) => {
        replaceState(runtime, (state) => {
          state.quotations[0].status = '已转订单';
          state.quotations[0].convertedOrderId = 'ord-converted';
        });
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(candidateIds(page).includes('quo-syn-a-1'), false);
        assert.strictEqual(page.applyQuotationSelection('quo-syn-a-1'), false);
      });
    }
  },
  {
    name: 'forged-deleted-id-is-rejected',
    run() {
      withPage(({ page, runtime }) => {
        replaceState(runtime, (state) => {
          state.deletedRecords = [{
            id: 'del-quo-syn-a-1',
            recordId: 'quo-syn-a-1',
            recordType: 'quotation'
          }];
        });
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(candidateIds(page).includes('quo-syn-a-1'), false);
        assert.strictEqual(page.applyQuotationSelection('quo-syn-a-1'), false);
      });
    }
  },
  {
    name: 'forged-inactive-id-is-rejected',
    run() {
      withPage(({ page, runtime }) => {
        replaceState(runtime, (state) => {
          state.quotations[0].status = '已失效';
        });
        prepareConfirmation(page, quotationDraft());
        assert.strictEqual(candidateIds(page).includes('quo-syn-a-1'), false);
        assert.strictEqual(page.applyQuotationSelection('quo-syn-a-1'), false);
      });
    }
  },
  {
    name: 'quotation-converted-after-display-is-rejected-on-selection',
    run() {
      withPage(({ page, runtime }) => {
        prepareConfirmation(page, quotationDraft());
        replaceState(runtime, (state) => {
          state.quotations[0].status = '已转订单';
          state.quotations[0].convertedOrderId = 'ord-converted';
        });
        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), false);
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.strictEqual(candidateIds(page).includes('quo-syn-a-1'), false);
      });
    }
  },
  {
    name: 'quotation-converted-after-selection-is-blocked-at-save',
    run() {
      withPage(({ driver, page, runtime }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        replaceState(runtime, (state) => {
          state.quotations[0].status = '已转订单';
          state.quotations[0].convertedOrderId = 'ord-converted';
        });
        page.saveFormal();
        assert.strictEqual(page.data.disableFormalSave, true);
        assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
        assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      });
    }
  },
  {
    name: 'quotation-deleted-after-selection-is-blocked-at-save',
    run() {
      withPage(({ driver, page, runtime }) => {
        prepareConfirmation(page, quotationDraft());
        page.changeQuotation({ detail: { value: 0 } });
        replaceState(runtime, (state) => {
          state.quotations = state.quotations.filter((item) => item.id !== 'quo-syn-a-1');
        });
        page.saveFormal();
        assert.strictEqual(page.data.disableFormalSave, true);
        assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
        assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      });
    }
  },
  {
    name: 'explicit-new-quotation-does-not-show-history-picker',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, Object.assign(quotationDraft(), {
          operation: 'create_quotation',
          original_text: '给王总新报保温杯300个，18元一个',
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            productName: '保温杯'
          }
        }));
        assert.strictEqual(page.data.operation, 'create_quotation');
        assert.strictEqual(page.data.showGenericQuotationSelection, false);
      });
    }
  },
  {
    name: 'explicit-new-order-is-not-forced-to-select-history-quotation',
    run() {
      withPage(({ page }) => {
        page.setData({
          fields: {
            customerId: 'cus-syn-a',
            customerName: '王总',
            productName: '新款饭盒',
            dueDate: '2026-07-30'
          },
          intent: 'order',
          parseResult: {
            intent: 'order',
            operation: 'create_order',
            source: 'typed',
            original_text: '王总新下一单新款饭盒，7月30日交',
            parse_route: { decision: 'local' },
            fields: {
              customerId: 'cus-syn-a',
              customerName: '王总',
              productName: '新款饭盒',
              dueDate: '2026-07-30'
            },
            missing_fields: [],
            low_confidence_fields: []
          }
        });
        page.changeIntent({ detail: { value: 1 } });
        assert.strictEqual(page.data.operation, 'create_order');
        assert.strictEqual(page.data.showGenericQuotationSelection, false);
        assert.strictEqual(page.data.selectedQuotationId, '');
      });
    }
  },
  {
    name: 'explicit-conversion-unique-safe-quotation-requires-real-page-selection',
    run() {
      withPage(({ driver, page }) => {
        prepareConfirmation(page, quotationConversionOrderDraft(), 1);
        assert.strictEqual(page.data.operation, 'create_order');
        assert.strictEqual(page.data.quotationSelectionRequired, true);
        assert.strictEqual(page.data.showGenericQuotationSelection, true);
        assert.deepStrictEqual(candidateIds(page), ['quo-syn-a-1']);
        assert.strictEqual(page.data.selectedQuotationId, '');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.strictEqual(page.data.quotationSelectionConfirmed, false);
        assert(page.data.preflightBlockingReasons.includes('QUOTATION_TARGET_REQUIRED'));

        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), true);
        assert.strictEqual(page.data.selectedQuotationId, 'quo-syn-a-1');
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        assert.strictEqual(page.data.fields.quotationSelectionConfirmed, true);
        assert.strictEqual(page.data.quotationSelectionConfirmed, true);
        assert.strictEqual(
          page.data.preflightBlockingReasons.includes('QUOTATION_TARGET_REQUIRED'),
          false
        );
        assert.strictEqual(driver.evidence.pageMethodCalls.changeQuotation, 1);
        assert.strictEqual(driver.evidence.pageMethodCalls.applyQuotationSelection, 1);
      });
    }
  },
  {
    name: 'explicit-conversion-multiple-safe-quotations-never-auto-select-and-can-reselect',
    run() {
      withPage(({ page }) => {
        prepareConfirmation(page, quotationConversionOrderDraft({
          sourceText: '王总的报价',
          normalizedReference: '王总:QUOTATION',
          productName: ''
        }), 1);
        assert.strictEqual(page.data.quotationSelectionRequired, true);
        assert.deepStrictEqual(candidateIds(page), ['quo-syn-a-1', 'quo-syn-a-2']);
        assert.strictEqual(page.data.selectedQuotationId, '');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);

        assert.strictEqual(page.changeQuotation({ detail: { value: 1 } }), true);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-2');
        assert.strictEqual(page.data.fields.quotationSelectionConfirmed, true);
        assert.strictEqual(page.clearQuotationSelection(), true);
        assert.strictEqual(page.data.selectedQuotationId, '');
        assert.strictEqual(Boolean(page.data.fields.quotationId), false);
        assert.strictEqual(page.data.quotationSelectionConfirmed, false);
        assert(page.data.preflightBlockingReasons.includes('QUOTATION_TARGET_REQUIRED'));

        assert.strictEqual(page.changeQuotation({ detail: { value: 0 } }), true);
        assert.strictEqual(page.data.fields.quotationId, 'quo-syn-a-1');
        assert.strictEqual(page.data.fields.quotationSelectionConfirmed, true);
      });
    }
  },
  {
    name: 'wxml-binds-quotation-picker-without-changing-home',
    run() {
      const inputWxml = fs.readFileSync(path.join(ROOT, 'pages/input/input.wxml'), 'utf8');
      const dashboardJs = fs.readFileSync(path.join(ROOT, 'pages/dashboard/dashboard.js'), 'utf8');
      assert(inputWxml.includes('bindchange="changeQuotation"'));
      assert(inputWxml.includes('bindtap="clearQuotationSelection"'));
      assert.strictEqual(dashboardJs.includes('changeQuotation(event)'), false);
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
  console.log(`Quotation selection surface tests: ${passed}/${tests.length} passed`);
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
