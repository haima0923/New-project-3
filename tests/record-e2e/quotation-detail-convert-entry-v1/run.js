#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { ROOT } = require('../runner/constants');
const { beginConversion, invokeConfirm } = require('../quotation-to-order-save-v1/page-actions');
const { createRuntimeSpec, loadContract } = require('../quotation-to-order-save-v1/load-contract');
const { loadQuotationPage, loadRecordDetailPage } = require('./page-driver');

const contractCases = new Map(loadContract().cases.map((item) => [item.caseId, item]));
const detailTemplate = fs.readFileSync(
  path.join(ROOT, 'pages/record-detail/record-detail.wxml'),
  'utf8'
);

function createContext(q2oCaseId, entryCaseId, options = {}) {
  const sourceCase = contractCases.get(q2oCaseId);
  if (!sourceCase) throw new Error(`Missing Q2O fixture source: ${q2oCaseId}`);
  const testCase = Object.assign({}, safeClone(sourceCase), { caseId: entryCaseId });
  if (typeof options.mutateState === 'function') {
    options.mutateState(testCase.initialState.state);
  }
  const spec = createRuntimeSpec(testCase);
  return {
    runtime: createCaseRuntime(spec, {
      attempt: options.attempt || 1,
      modalResponse: options.modalResponse
    }),
    spec,
    testCase
  };
}

function quotationDetailOptions(quotationId) {
  return { id: quotationId, type: 'quotation' };
}

function navigationEvents(runtime) {
  return runtime.fakeWx.audit().navigationEvents;
}

function lastNavigation(runtime) {
  const events = navigationEvents(runtime);
  return events[events.length - 1] || null;
}

async function withContext(q2oCaseId, entryCaseId, callback, options = {}) {
  const context = createContext(q2oCaseId, entryCaseId, options);
  try {
    await callback(context);
    const audit = context.runtime.audit();
    assert.strictEqual(audit.networkAudit.realNetworkRequests, 0);
    assert.strictEqual(audit.networkAudit.guardErrors, 0);
    assert.strictEqual(audit.hostFilesystemAudit.hostFilesystemStorageCalls, 0);
  } finally {
    context.runtime.dispose();
  }
}

const cases = [
  {
    caseId: 'REC-E2E-QDCE-001',
    title: '合法未转报价详情显示转为订单状态',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-001', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(detail.page.data.detail.canConvertToOrder, true);
      assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, false);
      assert.strictEqual(detail.page.data.detail.quotationConversionMessage, '');
      assert.ok(detailTemplate.includes('bindtap="openQuotationConversion">转为订单</button>'));
      assert.ok(detailTemplate.includes("detail.type === 'quotation' && detail.canConvertToOrder"));
    })
  },
  {
    caseId: 'REC-E2E-QDCE-002',
    title: '点击详情入口进入真实报价页面',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-002', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(typeof detail.page.openQuotationConversion, 'function');
      detail.page.openQuotationConversion();
      assert.strictEqual(lastNavigation(runtime).type, 'NAVIGATE_TO');
      assert.match(lastNavigation(runtime).url, /^\/pages\/quotations\/quotations\?/);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-003',
    title: '详情导航只携带正确报价编号和动作',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-003', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(typeof detail.page.openQuotationConversion, 'function');
      detail.page.openQuotationConversion();
      const url = new URL(lastNavigation(runtime).url, 'https://mini-program.local');
      assert.strictEqual(url.pathname, '/pages/quotations/quotations');
      assert.strictEqual(url.searchParams.get('quotationId'), testCase.quotationId);
      assert.strictEqual(url.searchParams.get('action'), 'convert');
      assert.strictEqual(url.searchParams.size, 2);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-004',
    title: '报价页面按参数重新读取真实存储',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-004', ({ runtime, spec, testCase }) => {
      const page = loadQuotationPage(runtime, spec, {
        action: 'convert',
        quotationId: testCase.quotationId
      });
      assert.ok(page.evidence.productionStorageReads.getState >= 1);
      assert.ok(page.page.data.quotations.some((item) => item.id === testCase.quotationId));
    })
  },
  {
    caseId: 'REC-E2E-QDCE-005',
    title: '报价页面自动锁定并打开现有转单流程',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-005', ({ runtime, spec, testCase }) => {
      const page = loadQuotationPage(runtime, spec, {
        action: 'convert',
        quotationId: testCase.quotationId
      });
      assert.strictEqual(page.evidence.pageMethodCalls.startConvert, 1);
      assert.strictEqual(page.page.data.convertingQuotationId, testCase.quotationId);
      assert.strictEqual(page.page.data.conversionDeliveryDate, '');
    })
  },
  {
    caseId: 'REC-E2E-QDCE-006',
    title: '错误或不存在报价编号不打开转换',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-006', ({ runtime, spec }) => {
      const missing = loadQuotationPage(runtime, spec, {
        action: 'convert',
        quotationId: 'quotation-does-not-exist'
      });
      assert.strictEqual(missing.page.data.convertingQuotationId, '');
      assert.strictEqual(missing.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
      assert.strictEqual(missing.evidence.productionStorageCalls.saveState, 0);
      const wrongAction = loadQuotationPage(runtime, spec, {
        action: 'view',
        quotationId: 'q2o-quote-single'
      });
      assert.strictEqual(wrongAction.page.data.convertingQuotationId, '');
      assert.strictEqual(wrongAction.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
      assert.strictEqual(wrongAction.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-007',
    title: '已转报价详情只提供查看已有订单',
    run: () => withContext('REC-E2E-Q2O-017', 'REC-E2E-QDCE-007', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, true);
      assert.strictEqual(detail.page.data.detail.relatedOrderId, 'q2o-order-existing');
      detail.page.openOrder();
      assert.strictEqual(
        lastNavigation(runtime).url,
        '/pages/record-detail/record-detail?type=order&id=q2o-order-existing'
      );
      assert.ok(detailTemplate.includes('bindtap="openOrder">查看订单</button>'));
    })
  },
  {
    caseId: 'REC-E2E-QDCE-008',
    title: '已转报价不再显示转单状态',
    run: () => withContext('REC-E2E-Q2O-017', 'REC-E2E-QDCE-008', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(detail.page.data.detail.canConvertToOrder, false);
      assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, true);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-009',
    title: '脏关系显示明确关系异常状态',
    run: async () => {
      for (const sourceCaseId of ['REC-E2E-Q2O-018', 'REC-E2E-Q2O-019', 'REC-E2E-Q2O-020']) {
        await withContext(sourceCaseId, 'REC-E2E-QDCE-009', ({ runtime, testCase }) => {
          const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
          assert.strictEqual(detail.page.data.detail.hasQuotationOrderConflict, true);
          assert.strictEqual(detail.page.data.detail.canConvertToOrder, false);
          assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, false);
          assert.strictEqual(detail.page.data.detail.relatedOrderId, '');
          assert.strictEqual(detail.page.data.detail.status, '关系异常');
          assert.strictEqual(
            detail.page.data.detail.quotationConversionMessage,
            '报价与订单关系异常，暂不能转换'
          );
          assert.ok(detailTemplate.includes('{{detail.quotationConversionMessage}}'));
        });
      }
    }
  },
  {
    caseId: 'REC-E2E-QDCE-010',
    title: '脏关系不能从详情进入转换流程',
    run: () => withContext('REC-E2E-Q2O-018', 'REC-E2E-QDCE-010', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(typeof detail.page.openQuotationConversion, 'function');
      detail.page.openQuotationConversion();
      assert.strictEqual(navigationEvents(runtime).length, 0);
      assert.strictEqual(detail.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
      assert.strictEqual(detail.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-011',
    title: '作废或不可转换报价不显示可用转单状态',
    run: async () => {
      for (const sourceCaseId of ['REC-E2E-Q2O-015', 'REC-E2E-Q2O-016', 'REC-E2E-Q2O-021']) {
        await withContext(sourceCaseId, 'REC-E2E-QDCE-011', ({ runtime, testCase }) => {
          const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
          assert.strictEqual(detail.page.data.detail.canConvertToOrder, false);
          assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, false);
          assert.strictEqual(detail.page.data.detail.hasQuotationOrderConflict, false);
          assert.strictEqual(detail.page.data.detail.quotationConversionMessage, '该报价暂不能转为订单');
        });
      }
    }
  },
  {
    caseId: 'REC-E2E-QDCE-012',
    title: '转换完成返回详情后刷新为查看订单',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-012', ({ runtime, spec, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(typeof detail.page.openQuotationConversion, 'function');
      detail.page.openQuotationConversion();
      const quotationPage = loadQuotationPage(runtime, spec, {
        action: 'convert',
        quotationId: testCase.quotationId
      });
      assert.strictEqual(quotationPage.page.data.convertingQuotationId, testCase.quotationId);
      beginConversion(quotationPage.page, testCase.quotationId, testCase.deliveryDate);
      invokeConfirm(quotationPage, testCase.quotationId);
      detail.page.onShow();
      assert.strictEqual(detail.page.data.detail.canConvertToOrder, false);
      assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, true);
      assert.ok(detail.page.data.detail.relatedOrderId);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-013',
    title: '详情入口不直接调用正式保存',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-013', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(typeof detail.page.openQuotationConversion, 'function');
      detail.page.openQuotationConversion();
      assert.strictEqual(detail.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QDCE-014',
    title: '详情入口不直接调用报价转订单函数',
    run: () => withContext('REC-E2E-Q2O-001', 'REC-E2E-QDCE-014', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, quotationDetailOptions(testCase.quotationId));
      assert.strictEqual(typeof detail.page.openQuotationConversion, 'function');
      detail.page.openQuotationConversion();
      assert.strictEqual(detail.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
    })
  }
];

function parseArgs(argv) {
  const options = { repeat: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repeat') options.repeat = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw new Error('--repeat must be a positive integer');
  }
  return options;
}

async function runAttempt(attempt) {
  const results = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
      results.push({ caseId: testCase.caseId, caseStatus: 'PASS', failureReason: '', title: testCase.title });
    } catch (error) {
      const caseStatus = error && error.name === 'AssertionError' ? 'CASE_FAIL' : 'RUNNER_ERROR';
      results.push({
        caseId: testCase.caseId,
        caseStatus,
        failureReason: error && error.message || String(error),
        title: testCase.title
      });
    }
  }
  const summary = { PASS: 0, CASE_FAIL: 0, RUNNER_ERROR: 0, BLOCKED: 0, SURFACE_ERROR: 0 };
  results.forEach((result) => { summary[result.caseStatus] += 1; });
  return { attempt, results, summary };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const attempts = [];
  for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
    attempts.push(await runAttempt(attempt));
  }
  console.log('Cluster: quotation-detail-convert-entry-v1');
  console.log(`Cases: ${cases.length} (included in core count: false)`);
  attempts.forEach((attempt) => {
    const summary = attempt.summary;
    console.log(`Attempt ${attempt.attempt}: PASS=${summary.PASS} CASE_FAIL=${summary.CASE_FAIL} RUNNER_ERROR=${summary.RUNNER_ERROR} BLOCKED=${summary.BLOCKED} SURFACE_ERROR=${summary.SURFACE_ERROR}`);
    attempt.results.forEach((result) => {
      console.log(`${result.caseStatus.padEnd(12)} ${result.caseId}${result.failureReason ? ` ${result.failureReason}` : ''}`);
    });
  });
  const fingerprints = attempts.map((attempt) => JSON.stringify(
    attempt.results.map((result) => [result.caseId, result.caseStatus, result.failureReason])
  ));
  const stable = fingerprints.every((item) => item === fingerprints[0]);
  console.log(`Determinism: ${stable ? 'STABLE' : 'MISMATCH'}`);
  const last = attempts[attempts.length - 1].summary;
  if (!stable || last.CASE_FAIL || last.RUNNER_ERROR || last.BLOCKED || last.SURFACE_ERROR) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  cases,
  createContext,
  main,
  navigationEvents,
  parseArgs,
  runAttempt,
  withContext
};
