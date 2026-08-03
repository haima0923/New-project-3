#!/usr/bin/env node
const { loadContract } = require('./load-contract');
const { runWorker } = require('./run-suite');

const PROBE_CASES = [
  'REC-E2E-SIO-001',
  'REC-E2E-SIO-010',
  'REC-E2E-SIO-039',
  'REC-E2E-SIO-040',
  'REC-E2E-SIO-043',
  'REC-E2E-SIO-044',
  'REC-E2E-SIO-045',
  'REC-E2E-SIO-047'
];

function check(name, pass, detail) {
  return { name, pass: pass === true, detail: String(detail || '') };
}

async function runSurfaceGate() {
  const contract = loadContract();
  const byId = new Map(contract.cases.map((item) => [item.caseId, item]));
  const results = {};
  for (const caseId of PROBE_CASES) results[caseId] = await runWorker(byId.get(caseId), 1);
  const home = results['REC-E2E-SIO-001'];
  const full = results['REC-E2E-SIO-010'];
  const reload = results['REC-E2E-SIO-039'];
  const restart = results['REC-E2E-SIO-040'];
  const doubleClick = results['REC-E2E-SIO-043'];
  const replay = results['REC-E2E-SIO-044'];
  const concurrent = results['REC-E2E-SIO-045'];
  const fault = results['REC-E2E-SIO-047'];
  const checks = [
    check('首页输入和解析', home.parserObservation && home.parserObservation.hybridInvocationCount === 1, home.parseRoute),
    check('首页确认态', home.confirmationFields && home.confirmationFields.items.length === 1, JSON.stringify(home.confirmationFields)),
    check('首页正式保存按钮', home.pageFormalSaveCalls === 1, home.pageFormalSaveCalls),
    check('完整页输入和解析', full.parserObservation && full.parserObservation.hybridInvocationCount === 1, full.parseRoute),
    check('完整页确认卡', full.confirmationFields && full.confirmationFields.items.length === 1, JSON.stringify(full.confirmationFields)),
    check('完整页正式保存按钮', full.pageFormalSaveCalls === 1, full.pageFormalSaveCalls),
    check('业务构造结果', home.businessConstructionResult && home.businessConstructionResult.type === 'order', home.businessConstructionResult && home.businessConstructionResult.type),
    check('saveState 次数结果和异常', Boolean(home.saveStateCalls === 1 && fault.saveStateCalls === 1 && fault.actionError), `${home.saveStateCalls}/${fault.saveStateCalls}`),
    check('revision 和 receipt', home.control && home.control.revisionDelta === 1 && home.control.receiptDelta === 1, JSON.stringify(home.control)),
    check('真实隔离存储重读', home.reportDistinction && home.reportDistinction.readbackContainsTarget, JSON.stringify(home.reportDistinction)),
    check('订单列表构造', Boolean(home.listResult && home.listResult.id), home.listResult && home.listResult.id),
    check('订单详情构造', home.detailResult && home.detailResult.type === 'order', home.detailResult && home.detailResult.id),
    check('页面重新打开', reload.reload && reload.reload.orderCount === 1, JSON.stringify(reload.reload)),
    check('新进程应用重启', restart.restart && restart.restart.newProcess, JSON.stringify(restart.restart)),
    check('连续点击', doubleClick.pageMethodCalls && doubleClick.pageMethodCalls.confirmQuickSave === 2, JSON.stringify(doubleClick.pageMethodCalls)),
    check('精确事务重放', replay.transactionReplay && replay.transactionReplay.idempotentReplay, JSON.stringify(replay.transactionReplay)),
    check('两个旧快照并发', concurrent.concurrent && concurrent.concurrent.successfulSaveCalls === 1, JSON.stringify(concurrent.concurrent)),
    check('主存储故障和回滚', fault.actionError && fault.control && fault.control.revisionDelta === 0, JSON.stringify(fault.control)),
    check('Toast 与错误提示', Boolean(home.uiEvents && home.uiEvents.length > 0 && Array.isArray(fault.uiEvents)), `${home.uiEvents && home.uiEvents.length}/${fault.uiEvents && fault.uiEvents.length}`),
    check('失败不误报业务成功', fault.reportDistinction && fault.reportDistinction.realStorageCommit === false && !fault.uiEvents.some((item) => item.icon === 'success'), JSON.stringify(fault.reportDistinction))
  ];
  const failed = checks.filter((item) => !item.pass);
  return {
    checks,
    summary: {
      PASS: checks.length - failed.length,
      CASE_FAIL: failed.length,
      RUNNER_ERROR: Object.values(results).filter((item) => item.caseStatus === 'RUNNER_ERROR').length,
      BLOCKED: 0,
      SURFACE_ERROR: Object.values(results).filter((item) => item.surfaceError).length,
      executed: checks.length
    }
  };
}

async function main() {
  const result = await runSurfaceGate();
  result.checks.forEach((item) => console.log(`${item.pass ? 'PASS' : 'CASE_FAIL'} ${item.name}${item.pass ? '' : ` ${item.detail}`}`));
  console.log(`Summary: PASS=${result.summary.PASS} CASE_FAIL=${result.summary.CASE_FAIL} RUNNER_ERROR=${result.summary.RUNNER_ERROR} BLOCKED=${result.summary.BLOCKED} SURFACE_ERROR=${result.summary.SURFACE_ERROR}`);
  if (result.summary.CASE_FAIL || result.summary.RUNNER_ERROR || result.summary.BLOCKED || result.summary.SURFACE_ERROR) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { runSurfaceGate };
