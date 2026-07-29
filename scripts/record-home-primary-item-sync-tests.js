#!/usr/bin/env node
const assert = require('assert');
const { buildExecutionPlan } = require('../tests/record-e2e/runner/build-execution-plan');
const { BUSINESS_STORAGE_KEY } = require('../tests/record-e2e/runner/constants');
const { createCaseRuntime } = require('../tests/record-e2e/runner/create-case-runtime');
const { loadCorpus } = require('../tests/record-e2e/runner/load-corpus');
const { loadProductionPage } = require('../tests/record-e2e/runner/page-vm-driver');
const { executeOne } = require('../tests/record-e2e/runner/run-suite');
const { safeClone } = require('../utils/record-state-diff');

const corpus = loadCorpus();
const page008 = corpus.byId.get('REC-E2E-PAGE-008');
assert(page008, 'Missing REC-E2E-PAGE-008');
const planBundle = buildExecutionPlan(page008, corpus.fixtureResolver);

function baseDraft(options = {}) {
  const fields = Object.assign({
    amount: '600',
    calculatedAmount: '600',
    customerName: '赵姐',
    items: [{
      itemDeliveryDate: '',
      itemRemark: '',
      priceUnit: '个',
      productName: '帆布袋',
      quantity: '100',
      spec: '',
      totalAmount: '600',
      unit: '个',
      unitPrice: '6'
    }],
    priceUnit: '个',
    productName: '帆布袋',
    quantity: '100',
    statedAmount: '',
    totalAmount: '600',
    unit: '个',
    unitPrice: '6'
  }, options.fields || {});
  return {
    ai_fallback: options.aiFallback || {
      attempted: false,
      business_result_valid: false,
      needed: false,
      status: 'not_requested'
    },
    field_conflicts: [],
    fields,
    intent: options.intent || 'quotation',
    low_confidence_fields: [],
    manual_fields: [],
    missing_fields: [],
    operation: options.operation || 'create_quotation',
    original_text: options.originalText || '给赵姐报100个帆布袋，6元一个',
    parse_route: options.parseRoute || { decision: 'local' },
    source: 'typed'
  };
}

function withHomePage(run, options = {}) {
  const workerSpec = safeClone(planBundle.workerSpec);
  if (options.initialState) workerSpec.initialState.state = safeClone(options.initialState);
  const runtime = createCaseRuntime(workerSpec, { attempt: options.attempt || 1 });
  try {
    const driver = loadProductionPage('HOME_QUICK', runtime, workerSpec, {
      runLifecycle: false
    });
    return run({ driver, page: driver.page, runtime, workerSpec });
  } finally {
    runtime.dispose();
  }
}

function installDraft(page, draft) {
  page.setData({
    composerText: draft.original_text,
    parseResult: safeClone(draft)
  });
}

function edit(page, field, value) {
  page.updateConfirmField({
    currentTarget: { dataset: { field } },
    detail: { value }
  });
  return page.data.parseResult;
}

function item(result) {
  return result.fields.items[0];
}

function assertProjection(result, field, expected) {
  const itemField = field === 'amount' ? 'totalAmount' : field;
  assert.strictEqual(String(result.fields[field]), String(expected));
  assert.strictEqual(String(item(result)[itemField]), String(expected));
}

const tests = [
  {
    name: 'product-name-edit-is-atomic',
    run() {
      withHomePage(({ page }) => {
        const draft = baseDraft();
        installDraft(page, draft);
        const result = edit(page, 'productName', '保温袋');
        assertProjection(result, 'productName', '保温袋');
        assert.strictEqual(result.original_text, draft.original_text);
      });
    }
  },
  {
    name: 'quantity-edit-recomputes-derived-amount',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft());
        const result = edit(page, 'quantity', '150');
        assertProjection(result, 'quantity', '150');
        assertProjection(result, 'amount', '900');
        assert.strictEqual(result.fields.calculatedAmount, '900');
      });
    }
  },
  {
    name: 'unit-edit-uses-existing-unit-normalizer',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft({
          fields: {
            amount: '600',
            calculatedAmount: '600',
            customerName: '赵姐',
            items: [{
              priceUnit: '公斤',
              productName: '帆布袋',
              quantity: '100',
              totalAmount: '600',
              unit: '公斤',
              unitPrice: '6'
            }],
            priceUnit: '公斤',
            productName: '帆布袋',
            quantity: '100',
            totalAmount: '600',
            unit: '公斤',
            unitPrice: '6'
          }
        }));
        const result = edit(page, 'unit', 'kg');
        assertProjection(result, 'unit', '公斤');
        assertProjection(result, 'amount', '600');
      });
    }
  },
  {
    name: 'unit-price-edit-recomputes-derived-amount',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft());
        const result = edit(page, 'unitPrice', '8');
        assertProjection(result, 'unitPrice', '8');
        assertProjection(result, 'amount', '800');
      });
    }
  },
  {
    name: 'sequential-primary-edits-remain-synchronized',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft());
        edit(page, 'productName', '保温袋');
        edit(page, 'quantity', '150');
        const result = edit(page, 'unitPrice', '8');
        assertProjection(result, 'productName', '保温袋');
        assertProjection(result, 'quantity', '150');
        assertProjection(result, 'unitPrice', '8');
        assertProjection(result, 'amount', '1200');
      });
    }
  },
  {
    name: 'manual-amount-remains-authoritative',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft());
        edit(page, 'amount', '700');
        edit(page, 'quantity', '150');
        const result = edit(page, 'unitPrice', '8');
        assertProjection(result, 'amount', '700');
        assert.strictEqual(result.fields.calculatedAmount, '1200');
        assert(result.manual_fields.includes('amount'));
      });
    }
  },
  {
    name: 'stated-amount-remains-authoritative',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft({
          fields: {
            amount: '550',
            calculatedAmount: '600',
            customerName: '赵姐',
            items: [{
              priceUnit: '个',
              productName: '帆布袋',
              quantity: '100',
              totalAmount: '550',
              unit: '个',
              unitPrice: '6'
            }],
            priceUnit: '个',
            productName: '帆布袋',
            quantity: '100',
            statedAmount: '550',
            totalAmount: '550',
            unit: '个',
            unitPrice: '6'
          }
        }));
        const result = edit(page, 'quantity', '150');
        assertProjection(result, 'amount', '550');
        assert.strictEqual(result.fields.calculatedAmount, '900');
      });
    }
  },
  {
    name: 'manual-confirmation-marks-only-edited-field',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft());
        const result = edit(page, 'quantity', '150');
        assert.deepStrictEqual(Array.from(result.manual_fields), ['quantity']);
      });
    }
  },
  {
    name: 'original-text-survives-all-edits',
    run() {
      withHomePage(({ page }) => {
        const draft = baseDraft();
        installDraft(page, draft);
        edit(page, 'productName', '保温袋');
        edit(page, 'quantity', '150');
        const result = edit(page, 'unitPrice', '8');
        assert.strictEqual(result.original_text, draft.original_text);
      });
    }
  },
  {
    name: 'multi-item-home-edit-is-rejected-without-data-loss',
    run() {
      withHomePage(({ page }) => {
        const draft = baseDraft();
        draft.fields.items.push({
          priceUnit: '个',
          productName: '纸袋',
          quantity: '20',
          totalAmount: '40',
          unit: '个',
          unitPrice: '2'
        });
        installDraft(page, draft);
        page.updateConfirmField({
          currentTarget: { dataset: { field: 'productName' } },
          detail: { value: '保温袋' }
        });
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(page.data.parseResult.fields.items)),
          draft.fields.items
        );
        assert.strictEqual(page.data.requiresFullPage, true);
      });
    }
  },
  {
    name: 'non-item-business-does-not-create-items',
    run() {
      withHomePage(({ page }) => {
        const draft = baseDraft({
          intent: 'receivable',
          operation: 'create_receivable',
          originalText: '赵姐还有800元待收'
        });
        draft.fields = {
          amount: '800',
          customerName: '赵姐'
        };
        installDraft(page, draft);
        const result = edit(page, 'amount', '900');
        assert.strictEqual(result.fields.amount, '900');
        assert.strictEqual(Array.isArray(result.fields.items), false);
      });
    }
  },
  {
    name: 'invalid-quantity-remains-blocked',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft());
        const result = edit(page, 'quantity', '-1');
        assertProjection(result, 'quantity', '-1');
        assertProjection(result, 'amount', '');
        assert.strictEqual(page.data.disableQuickSave, true);
        assert(page.data.homePrimaryItemConsistencyIssues.includes('quantity:invalid'));
      });
    }
  },
  {
    name: 'save-gate-blocks-inconsistent-primary-item',
    run() {
      withHomePage(({ driver, page }) => {
        const draft = baseDraft();
        draft.fields.productName = '保温袋';
        installDraft(page, draft);
        page.confirmQuickSave();
        assert.strictEqual(page.data.homePrimaryItemConsistent, false);
        assert.deepStrictEqual(
          Array.from(page.data.homePrimaryItemConsistencyIssues),
          ['productName']
        );
        assert.strictEqual(driver.evidence.productionBusinessCalls.saveConfirmedDraft, 0);
        assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      });
    }
  },
  {
    name: 'fake-provider-policy-is-not-relaxed',
    run() {
      withHomePage(({ page }) => {
        installDraft(page, baseDraft({
          aiFallback: {
            attempted: true,
            business_result_valid: true,
            needed: true,
            provider_kind: 'FAKE',
            status: 'used'
          },
          parseRoute: { decision: 'ai_standard' }
        }));
        const result = edit(page, 'quantity', '150');
        assertProjection(result, 'quantity', '150');
        assert.strictEqual(page.data.domainCanSaveFormal, false);
        assert(page.data.preflightBlockingReasons.includes('UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION'));
      });
    }
  },
  {
    name: 'saved-single-item-survives-new-runtime',
    run() {
      let persistedState;
      let firstBootId;
      withHomePage(({ page, runtime }) => {
        const draft = baseDraft({
          originalText: '给赵姐报帆布袋和保温袋，100个，6元一个'
        });
        installDraft(page, draft);
        edit(page, 'productName', '保温袋');
        edit(page, 'quantity', '150');
        edit(page, 'unitPrice', '8');
        page.confirmQuickSave();
        persistedState = safeClone(runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY));
        firstBootId = runtime.bootId;
        assert.strictEqual(persistedState.quotations.length, 1);
        assert.strictEqual(persistedState.quotations[0].productName, '保温袋');
        assert.strictEqual(String(persistedState.quotations[0].items[0].quantity), '150');
        assert.strictEqual(String(persistedState.quotations[0].totalAmount), '1200');
      });
      withHomePage(({ runtime }) => {
        assert.notStrictEqual(runtime.bootId, firstBootId);
        const restarted = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
        assert.strictEqual(restarted.quotations.length, 1);
        assert.strictEqual(restarted.quotations[0].items[0].productName, '保温袋');
        assert.strictEqual(String(restarted.quotations[0].items[0].unitPrice), '8');
        assert.strictEqual(
          restarted.quotations[0].originalText,
          '给赵姐报帆布袋和保温袋，100个，6元一个'
        );
      }, { attempt: 2, initialState: persistedState });
    }
  },
  {
    name: 'runner-records-stepwise-edit-and-final-draft-evidence',
    async run() {
      const result = await executeOne({
        testCase: page008,
        ...planBundle
      }, { attempt: 1 });
      const consistency = result.pageEvidence.pageEditConsistency;
      assert.strictEqual(consistency.consistent, true);
      assert.strictEqual(consistency.editTrace.length, 3);
      assert.strictEqual(consistency.checks.every((check) => (
        check.methodInvokedOnce
        && check.originalTextPreserved
        && check.itemCountPreserved
        && check.derivedAmountSynchronized
      )), true);
      assert.strictEqual(
        consistency.editTrace[2].topLevelAfterEachEdit.amount,
        '1200'
      );
      assert.strictEqual(
        consistency.editTrace[2].itemAfterEachEdit.totalAmount,
        '1200'
      );
      assert.strictEqual(
        consistency.finalLegacyDraft.fields.items[0].productName,
        '保温袋'
      );
      assert.strictEqual(consistency.finalSavedRecord, null);

      const unitAliasCase = safeClone(page008);
      unitAliasCase.interaction.userEdits = [{
        scope: 'FIELD',
        field: 'unit',
        value: 'kg'
      }];
      const unitAliasBundle = buildExecutionPlan(unitAliasCase, corpus.fixtureResolver);
      const unitAliasResult = await executeOne({
        testCase: unitAliasCase,
        ...unitAliasBundle
      }, { attempt: 1 });
      const unitCheck = unitAliasResult.pageEvidence.pageEditConsistency.checks[0];
      assert.strictEqual(unitCheck.requestedValue, 'kg');
      assert.strictEqual(unitCheck.normalizedRequestedValue, '公斤');
      assert.strictEqual(unitCheck.topValue, '公斤');
      assert.strictEqual(unitCheck.itemValue, '公斤');
      assert.strictEqual(unitCheck.synchronized, true);
    }
  }
];

async function main() {
  let passed = 0;
  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`PASS ${test.name}`);
    } catch (error) {
      console.error(`FAIL ${test.name}`);
      throw error;
    }
  }
  console.log(`record home primary item sync tests: ${passed}/${tests.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
