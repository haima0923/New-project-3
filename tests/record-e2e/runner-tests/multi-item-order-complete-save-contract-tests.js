#!/usr/bin/env node
const assert = require('assert');
const manifest = require('../multi-item-order-complete-save-v1/manifest.json');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE } = require('../multi-item-order-complete-save-v1/clock');
const { cases } = require('../multi-item-order-complete-save-v1/contract-cases');
const { classifyAssertions } = require('../multi-item-order-complete-save-v1/execute-case');
const { runMultiItemOrderContract, summarize } = require('../multi-item-order-complete-save-v1/run-suite');

function main() {
  const gates = [];
  function pass(name, condition) {
    assert.strictEqual(Boolean(condition), true, name);
    gates.push(name);
  }

  pass('合同数量与 ID 唯一', cases.length === 10 && new Set(cases.map((item) => item.caseId)).size === 10);
  pass('RED 与 GREEN 数量冻结', cases.filter((item) => item.contractKind === 'RED').length === 7
    && cases.filter((item) => item.contractKind === 'GREEN_CONTROL').length === 3);
  pass('统一时钟与 manifest 一致', BUSINESS_DATE === manifest.clock.businessDate
    && NOW_INSTANT === manifest.clock.nowInstant && TIMEZONE === manifest.clock.timezone);
  pass('每题都有生产位置和基线口径', cases.every((item) => item.productionLocations.length > 0
    && ['CASE_FAIL', 'PASS'].includes(item.baselineExpectation)));
  pass('断言分类不是无条件失败', classifyAssertions([{ pass: true }]) === 'PASS'
    && classifyAssertions([{ pass: true }, { pass: false }]) === 'CASE_FAIL');
  const synthetic = summarize([
    { caseStatus: 'CASE_FAIL', contractKind: 'RED', surfaceError: false },
    { caseStatus: 'PASS', contractKind: 'GREEN_CONTROL', surfaceError: false }
  ]);
  pass('摘要区分 RED 与 GREEN', synthetic.expectedRedDetected === 1
    && synthetic.greenControlFailures === 0 && synthetic.SURFACE_ERROR === 0);

  const run = runMultiItemOrderContract({ repeat: 2 });
  const results = run.attempts[0].results;
  pass('真实执行没有 Runner 或 Surface 误报', results.every((item) => !['RUNNER_ERROR', 'SURFACE_ERROR', 'BLOCKED'].includes(item.caseStatus)));
  pass('GREEN 控制组全部通过', results.filter((item) => item.contractKind === 'GREEN_CONTROL').every((item) => item.caseStatus === 'PASS'));
  pass('失败都有首个断言和生产位置', results.filter((item) => item.caseStatus === 'CASE_FAIL').every((item) => item.firstFailure && item.productionLocations.length > 0));
  pass('状态由真实断言机械派生', results.every((item) => item.caseStatus === classifyAssertions(item.assertions)));
  pass('重复运行语义稳定', run.determinism.stable && run.determinism.mismatches.length === 0);
  pass('Provider 与 Surface 边界显式报告', run.evidenceBoundary.realAi === 'NOT_RUN'
    && run.evidenceBoundary.realWxml === 'NOT_RUN'
    && /不是 REAL AI/.test(run.evidenceBoundary.controlledAi));

  console.log(`Multi-item contract runner self-test: ${gates.length}/${gates.length} PASS`);
  gates.forEach((name) => console.log(`PASS ${name}`));
  console.log('RUNNER_ERROR=0 BLOCKED=0 SURFACE_ERROR=0');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`${error.code || 'RUNNER_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
