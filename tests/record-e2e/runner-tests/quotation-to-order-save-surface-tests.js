const assert = require('assert');
const { getStateFingerprint } = require('../../../utils/record-state-diff');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { beginConversion, invokeConfirm } = require('../quotation-to-order-save-v1/page-actions');
const { executeQuotationRestart } = require('../quotation-to-order-save-v1/execute-restart');
const { createRuntimeSpec, loadContract } = require('../quotation-to-order-save-v1/load-contract');

async function main() {
  const testCase = loadContract().cases.find((item) => item.caseId === 'REC-E2E-Q2O-001');
  const spec = createRuntimeSpec(testCase);
  const runtime = createCaseRuntime(spec, { attempt: 1 });
  const gates = [];
  const pass = (name, condition) => {
    assert.strictEqual(Boolean(condition), true, name);
    gates.push(name);
  };
  try {
    const storage = require('../../../utils/storage');
    const driver = loadProductionPage('QUOTATION_LIST', runtime, spec);
    pass('加载报价列表真实页面逻辑', driver.evidence.pagePath === 'pages/quotations/quotations.js'
      && driver.page.data.quotations.some((item) => item.id === testCase.quotationId));

    const opened = beginConversion(driver.page, testCase.quotationId, testCase.deliveryDate);
    pass('调用 startConvert', opened && driver.evidence.pageMethodCalls.startConvert === 1);
    pass('设置用户选择的交期', driver.page.data.conversionDeliveryDate === testCase.deliveryDate
      && driver.evidence.pageMethodCalls.changeConversionDeliveryDate === 1);

    invokeConfirm(driver, testCase.quotationId);
    pass('调用真实 confirmConvert', driver.evidence.pageMethodCalls.confirmConvert === 1);
    pass('捕获真实 convertQuotationToOrder 返回', driver.evidence.productionBusinessCalls.convertQuotationToOrder === 1
      && driver.evidence.conversionCallLog[0].resultOrderId);
    pass('捕获 saveState 次数参数和结果', driver.evidence.productionStorageCalls.saveState === 1
      && driver.evidence.storageCallLog.some((item) => item.method === 'saveState'
        && item.options.writerSource === 'QUOTATION_CONVERT' && !item.error));
    const auditAfterSave = runtime.fakeWx.audit();
    pass('捕获页面提示', auditAfterSave.uiEvents.some((item) => item.type === 'TOAST'
      && item.title === '已转订单' && item.icon === 'success'));

    const readback = storage.getState({ writerSource: 'Q2O_GATE_A_READBACK' });
    const order = readback.orders.find((item) => item.quotationId === testCase.quotationId);
    const quote = readback.quotations.find((item) => item.id === testCase.quotationId);
    pass('从真实隔离存储重新读取', Boolean(order && quote && quote.convertedOrderId === order.id));

    const reloaded = loadProductionPage('QUOTATION_LIST', runtime, spec);
    pass('模拟页面重新加载', reloaded.page.data.quotations.some((item) => (
      item.id === testCase.quotationId && item.isConverted
    )));

    const restarted = await executeQuotationRestart(spec, runtime.fakeWx.getEntries(), { attempt: 1 });
    pass('模拟应用重启恢复', restarted.newProcess
      && getStateFingerprint(restarted.state) === getStateFingerprint(readback));

    const finalAudit = runtime.audit();
    assert.strictEqual(finalAudit.networkAudit.realNetworkRequests, 0);
    assert.strictEqual(finalAudit.networkAudit.guardErrors, 0);
    assert.strictEqual(finalAudit.hostFilesystemAudit.hostFilesystemStorageCalls, 0);
    assert.strictEqual(finalAudit.storageAudit.journalPresent, false);
    assert.strictEqual(finalAudit.storageAudit.backupPresent, false);
    console.log(`Gate A: ${gates.length}/10 PASS`);
    gates.forEach((name) => console.log(`PASS ${name}`));
    console.log('RUNNER_ERROR=0 BLOCKED=0 SURFACE_ERROR=0');
  } finally {
    runtime.dispose();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
