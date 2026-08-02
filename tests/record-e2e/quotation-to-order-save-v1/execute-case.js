const {
  getStateFingerprint,
  safeClone,
  stableHash,
  stableSerialize
} = require('../../../utils/record-state-diff');
const { stripRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_CONTROL_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { beginConversion, invokeConfirm } = require('./page-actions');
const { createRuntimeSpec } = require('./load-contract');
const { executeQuotationRestart } = require('./execute-restart');

function controlFacts(entries = {}) {
  const bundle = entries[BUSINESS_STORAGE_KEY] || {};
  const control = bundle[RECORD_STORAGE_CONTROL_KEY] || {};
  return {
    backupPresent: Object.prototype.hasOwnProperty.call(entries, RECORD_STORAGE_BACKUP_KEY),
    journalPresent: Object.prototype.hasOwnProperty.call(entries, RECORD_STORAGE_JOURNAL_KEY),
    receiptCount: (control.recentReceipts || []).length,
    revision: Number(control.storageRevision || 0)
  };
}

function uiEvents(runtime) {
  return runtime.fakeWx.audit().uiEvents || [];
}

function hasToast(events, title, icon) {
  return events.some((event) => event.type === 'TOAST'
    && (!title || event.title === title)
    && (!icon || event.icon === icon));
}

function orderFor(state, quotationId) {
  return (state.orders || []).find((item) => item.quotationId === quotationId) || null;
}

function ordersFor(state, quotationId) {
  return (state.orders || []).filter((item) => item.quotationId === quotationId);
}

function quotationFor(state, quotationId) {
  return (state.quotations || []).find((item) => item.id === quotationId) || null;
}

function same(value, expected) {
  return stableSerialize(value) === stableSerialize(expected);
}

function assertion(name, pass, detail) {
  return { detail: String(detail || ''), name, pass: pass === true };
}

function addCommonSuccessAssertions(assertions, evidence) {
  const order = orderFor(evidence.finalState, evidence.testCase.quotationId);
  const quote = quotationFor(evidence.finalState, evidence.testCase.quotationId);
  assertions.push(assertion('页面调用真实转换函数一次', evidence.conversionCalls === 1, `actual=${evidence.conversionCalls}`));
  assertions.push(assertion('页面调用真实 saveState 一次', evidence.saveCalls === 1, `actual=${evidence.saveCalls}`));
  assertions.push(assertion('真实存储只有一张来源订单', ordersFor(evidence.finalState, evidence.testCase.quotationId).length === 1, `actual=${ordersFor(evidence.finalState, evidence.testCase.quotationId).length}`));
  assertions.push(assertion('报价与订单双向关系一致', Boolean(order && quote && quote.convertedOrderId === order.id && order.quotationId === quote.id), 'quotation.convertedOrderId <-> order.quotationId'));
  assertions.push(assertion('页面显示转换成功', hasToast(evidence.uiEvents, '已转订单', 'success'), 'expected success toast'));
  assertions.push(assertion('一次版本变化', evidence.controlAfter.revision - evidence.controlBefore.revision === 1, `${evidence.controlBefore.revision}->${evidence.controlAfter.revision}`));
  assertions.push(assertion('一次收据变化', evidence.controlAfter.receiptCount - evidence.controlBefore.receiptCount === 1, `${evidence.controlBefore.receiptCount}->${evidence.controlAfter.receiptCount}`));
}

function unchangedBusiness(evidence) {
  return getStateFingerprint(evidence.beforeState) === getStateFingerprint(evidence.finalState);
}

function noCommitChange(evidence) {
  return evidence.controlAfter.revision === evidence.controlBefore.revision
    && evidence.controlAfter.receiptCount === evidence.controlBefore.receiptCount;
}

function scopeCollectionsUnchanged(before, after) {
  return [
    'customers', 'receivables', 'paymentRecords', 'dunningRecords',
    'todos', 'pendingNotes', 'aiParseLogs', 'operationLogs', 'deletedRecords'
  ].every((key) => same(before[key] || [], after[key] || []));
}

function assertEvidence(evidence) {
  const { testCase } = evidence;
  const assertions = [];
  const order = orderFor(evidence.finalState, testCase.quotationId);
  const quote = quotationFor(evidence.finalState, testCase.quotationId);
  const sourceQuote = quotationFor(evidence.beforeState, testCase.quotationId);
  const profile = testCase.expectedProfile;

  if ([
    'CLEAN_SINGLE', 'CLEAN_MULTI', 'ITEMS_EXACT', 'DELIVERY', 'ORIGINAL_TEXT',
    'QUOTE_LINK', 'ORDER_LINK', 'BIDIRECTIONAL', 'READBACK', 'RESTART_PERSISTENCE',
    'LEGACY_SINGLE', 'SCOPE_BOUNDARY'
  ].includes(profile)) addCommonSuccessAssertions(assertions, evidence);

  if (profile === 'CLEAN_SINGLE') {
    assertions.push(assertion('订单完整继承单商品', Boolean(order && order.items && order.items.length === 1), 'items.length=1'));
  } else if (profile === 'CLEAN_MULTI') {
    assertions.push(assertion('订单完整继承两项商品', Boolean(order && order.items && order.items.length === 2), 'items.length=2'));
  } else if (profile === 'ITEMS_EXACT') {
    assertions.push(assertion('items 字段与顺序完全保持', Boolean(order && sourceQuote && same(order.items, sourceQuote.items)), 'deep equality'));
    assertions.push(assertion('顶层兼容字段等于第一项', Boolean(order && order.items && ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'].every((key) => order[key] === order.items[0][key])), 'legacy top-level fields'));
    assertions.push(assertion('订单总金额保持报价总金额', Boolean(order && sourceQuote && order.totalAmount === sourceQuote.totalAmount), 'totalAmount'));
  } else if (profile === 'DELIVERY') {
    assertions.push(assertion('用户选择交期完整保存', Boolean(order && order.requiredDeliveryDate === testCase.deliveryDate && order.expectedShipDate === testCase.deliveryDate), testCase.deliveryDate));
  } else if (profile === 'ORIGINAL_TEXT') {
    assertions.push(assertion('订单 originalText 等于来源报价原文', Boolean(order && sourceQuote && order.originalText === sourceQuote.originalText), 'source quotation originalText'));
  } else if (profile === 'QUOTE_LINK') {
    assertions.push(assertion('报价回写 convertedOrderId、状态和时间', Boolean(quote && quote.convertedOrderId === order.id && quote.convertedAt && quote.status === '已转订单'), 'quotation backwrite'));
  } else if (profile === 'ORDER_LINK') {
    assertions.push(assertion('订单 quotationId 指向来源报价', Boolean(order && order.quotationId === testCase.quotationId), testCase.quotationId));
  } else if (profile === 'BIDIRECTIONAL') {
    assertions.push(assertion('来源关系目标唯一', ordersFor(evidence.finalState, testCase.quotationId).length === 1, 'exactly one relation target'));
  } else if (profile === 'READBACK') {
    assertions.push(assertion('断言使用真实 getState 重读', evidence.explicitReadCount >= 1, `actual=${evidence.explicitReadCount}`));
    assertions.push(assertion('重读数据保留多商品和原文', Boolean(order && sourceQuote && same(order.items, sourceQuote.items) && order.originalText === sourceQuote.originalText), 'persisted readback'));
  } else if (profile === 'RESTART_PERSISTENCE') {
    const restartOrder = evidence.restart && orderFor(evidence.restart.state, testCase.quotationId);
    const restartQuote = evidence.restart && quotationFor(evidence.restart.state, testCase.quotationId);
    assertions.push(assertion('应用重启使用新进程', Boolean(evidence.restart && evidence.restart.newProcess), 'child process'));
    assertions.push(assertion('重启后双向关系保持', Boolean(restartOrder && restartQuote && restartQuote.convertedOrderId === restartOrder.id), 'restart readback'));
    assertions.push(assertion('重启未产生第二订单', Boolean(evidence.restart && ordersFor(evidence.restart.state, testCase.quotationId).length === 1), 'one order after restart'));
  } else if (profile === 'LEGACY_SINGLE') {
    assertions.push(assertion('旧顶层字段生成唯一 items[0]', Boolean(order && order.items && order.items.length === 1 && ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount'].every((key) => order.items[0][key] === sourceQuote[key])), 'legacy fallback'));
  } else if (profile === 'SCOPE_BOUNDARY') {
    assertions.push(assertion('范围外集合完全不变', scopeCollectionsUnchanged(evidence.beforeState, evidence.finalState), 'customers/financial/todo/pending/log collections'));
    assertions.push(assertion('没有自动待收款、收款、定金、待办或待整理', (evidence.finalState.receivables || []).length === 0 && (evidence.finalState.paymentRecords || []).length === 0 && (evidence.finalState.todos || []).length === 0 && (evidence.finalState.pendingNotes || []).length === 0, 'out-of-scope collections empty'));
    assertions.push(assertion('商品目录副作用被精确观测', (evidence.finalState.productCatalog || []).length === 2, `actual=${(evidence.finalState.productCatalog || []).length}`));
  } else if (profile === 'REJECT_NOT_FOUND') {
    assertions.push(assertion('不存在报价不正式保存', evidence.saveCalls === 0, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('不存在报价零业务变化', unchangedBusiness(evidence), 'business fingerprint'));
    assertions.push(assertion('不存在报价零版本零收据', noCommitChange(evidence), 'control unchanged'));
    assertions.push(assertion('不存在报价无成功提示', !hasToast(evidence.uiEvents, '已转订单', 'success'), 'no success toast'));
  } else if (profile === 'REJECT_ID_SWAP') {
    assertions.push(assertion('事件 ID 与页面选择不一致时零转换', evidence.conversionCalls === 0, `actual=${evidence.conversionCalls}`));
    assertions.push(assertion('事件 ID 被替换时零保存', evidence.saveCalls === 0, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('两张报价均保持不变', unchangedBusiness(evidence), 'business fingerprint'));
  } else if (profile === 'REJECT_CUSTOMER' || profile === 'REJECT_INELIGIBLE' || profile === 'REJECT_AMOUNT_CONFLICT') {
    assertions.push(assertion('不合法报价在转换前拒绝', evidence.conversionCalls === 0, `actual=${evidence.conversionCalls}`));
    assertions.push(assertion('不合法报价零保存', evidence.saveCalls === 0, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('不合法报价零业务变化', unchangedBusiness(evidence), 'business fingerprint'));
    assertions.push(assertion('不合法报价零正式提交', noCommitChange(evidence), 'control unchanged'));
  } else if (profile === 'REPLAY_IDEMPOTENT') {
    assertions.push(assertion('重放返回已有订单', evidence.conversionResultOrderId === 'q2o-order-existing', evidence.conversionResultOrderId));
    assertions.push(assertion('完整关系重放零保存', evidence.saveCalls === 0, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('完整关系重放零业务变化', unchangedBusiness(evidence), 'all business timestamps unchanged'));
    assertions.push(assertion('完整关系重放零版本零收据', noCommitChange(evidence), 'control unchanged'));
  } else if (profile === 'DIRTY_DANGLING' || profile === 'DIRTY_WRONG_TARGET') {
    assertions.push(assertion('脏关系明确显示数据冲突', evidence.uiEvents.some((event) => String(event.title || '').includes('冲突') || String(event.content || '').includes('冲突')), 'explicit conflict UI'));
    assertions.push(assertion('脏关系零新增零保存', evidence.saveCalls === 0 && unchangedBusiness(evidence), `saveCalls=${evidence.saveCalls}`));
    assertions.push(assertion('脏关系零正式提交', noCommitChange(evidence), 'control unchanged'));
  } else if (profile === 'DIRTY_REVERSE_ONLY') {
    assertions.push(assertion('反向脏关系在转换前拒绝', evidence.conversionCalls === 0, `actual=${evidence.conversionCalls}`));
    assertions.push(assertion('反向脏关系零保存零变化', evidence.saveCalls === 0 && unchangedBusiness(evidence), `saveCalls=${evidence.saveCalls}`));
    assertions.push(assertion('同报价订单数量保持原值', ordersFor(evidence.finalState, testCase.quotationId).length === ordersFor(evidence.beforeState, testCase.quotationId).length, `${ordersFor(evidence.beforeState, testCase.quotationId).length}->${ordersFor(evidence.finalState, testCase.quotationId).length}`));
  } else if (profile === 'DOUBLE_CLICK') {
    assertions.push(assertion('连续双击只调用一次真实转换', evidence.conversionCalls === 1, `actual=${evidence.conversionCalls}`));
    assertions.push(assertion('连续双击只调用一次正式保存', evidence.saveCalls === 1, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('连续双击只有一张订单和一条进度', ordersFor(evidence.finalState, testCase.quotationId).length === 1 && (evidence.finalState.orderProgress || []).length === 1, 'one order/progress'));
    assertions.push(assertion('连续双击只有一次版本和收据变化', evidence.controlAfter.revision - evidence.controlBefore.revision === 1 && evidence.controlAfter.receiptCount - evidence.controlBefore.receiptCount === 1, 'one commit'));
  } else if (profile === 'PAGE_RELOAD_IDEMPOTENT') {
    assertions.push(assertion('新页面从存储显示已转订单', Boolean(evidence.reload && evidence.reload.pageConverted), 'page reload'));
    assertions.push(assertion('页面重开再次点击不进入确认', Boolean(evidence.reload && evidence.reload.panelOpened === false), 'panel remains closed'));
    assertions.push(assertion('页面重开累计一次保存一张订单', evidence.saveCalls === 1 && ordersFor(evidence.finalState, testCase.quotationId).length === 1, `saveCalls=${evidence.saveCalls}`));
  } else if (profile === 'APP_RESTART_IDEMPOTENT') {
    assertions.push(assertion('重启使用新进程', Boolean(evidence.restart && evidence.restart.newProcess), 'child process'));
    assertions.push(assertion('重启页显示已转订单且不进入确认', Boolean(evidence.restart && evidence.restart.retryEvidence && evidence.restart.retryEvidence.pageConverted && evidence.restart.retryEvidence.panelOpened === false), 'restart page state'));
    assertions.push(assertion('重启后零转换零保存', Boolean(evidence.restart && evidence.restart.retryEvidence && evidence.restart.retryEvidence.conversionCalls === 0 && evidence.restart.retryEvidence.saveCalls === 0), 'restart action calls'));
    assertions.push(assertion('重启后仍只有一张订单', Boolean(evidence.restart && ordersFor(evidence.restart.state, testCase.quotationId).length === 1), 'one persisted order'));
  } else if (profile === 'CONCURRENT_ONE_COMMIT') {
    assertions.push(assertion('两个旧快照都执行真实订单构造', evidence.conversionCalls === 2, `actual=${evidence.conversionCalls}`));
    assertions.push(assertion('两个旧快照均尝试正式保存', evidence.saveCalls === 2, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('最多一个正式保存成功', evidence.successfulSaveCalls === 1, `actual=${evidence.successfulSaveCalls}`));
    assertions.push(assertion('第二旧快照明确被拒绝', Boolean(evidence.concurrentSecondError), evidence.concurrentSecondError && evidence.concurrentSecondError.code));
    assertions.push(assertion('并发最终一张订单一次提交', ordersFor(evidence.finalState, testCase.quotationId).length === 1 && evidence.controlAfter.revision - evidence.controlBefore.revision === 1 && evidence.controlAfter.receiptCount - evidence.controlBefore.receiptCount === 1, 'one order/revision/receipt'));
  } else if (profile === 'PRIMARY_WRITE_ROLLBACK') {
    assertions.push(assertion('主写前故障实际命中', evidence.faultEvents.length === 1, `actual=${evidence.faultEvents.length}`));
    assertions.push(assertion('主写前故障有一次保存尝试且没有成功', evidence.saveCalls === 1 && evidence.successfulSaveCalls === 0, `${evidence.saveCalls}/${evidence.successfulSaveCalls}`));
    assertions.push(assertion('主写前故障恢复完整旧业务状态', unchangedBusiness(evidence), 'business fingerprint'));
    assertions.push(assertion('主写前故障零版本零收据', noCommitChange(evidence), 'control unchanged'));
    assertions.push(assertion('主写前故障最终无日志备份和成功提示', !evidence.controlAfter.journalPresent && !evidence.controlAfter.backupPresent && !hasToast(evidence.uiEvents, '已转订单', 'success'), 'clean rollback'));
  } else if (profile === 'BACKWRITE_BOUNDARY_ATOMICITY') {
    const transient = evidence.transientStateOnError || {};
    assertions.push(assertion('使用真实转换函数命中测试内存回写故障', evidence.conversionCalls === 1 && evidence.actionError && evidence.actionError.code === 'TEST_QUOTATION_BACKWRITE_FAULT', evidence.actionError && evidence.actionError.code));
    assertions.push(assertion('异常前临时状态已经构造订单', (transient.orders || []).length === (evidence.beforeState.orders || []).length + 1, `${(evidence.beforeState.orders || []).length}->${(transient.orders || []).length}`));
    assertions.push(assertion('回写异常前正式保存调用为零', evidence.saveCalls === 0, `actual=${evidence.saveCalls}`));
    assertions.push(assertion('回写异常后持久化保持旧状态', unchangedBusiness(evidence) && noCommitChange(evidence), 'persistent state/control unchanged'));
    assertions.push(assertion('回写异常没有成功提示', !hasToast(evidence.uiEvents, '已转订单', 'success'), 'no success toast'));
  } else if (profile === 'SAVE_FAILURE_NO_SUCCESS') {
    assertions.push(assertion('真实转换已执行且 saveState 调用边界故障命中', evidence.conversionCalls === 1 && evidence.saveCalls === 1 && evidence.actionError && evidence.actionError.code === 'TEST_SAVE_CALL_FAULT', evidence.actionError && evidence.actionError.code));
    assertions.push(assertion('保存调用故障后持久化保持旧状态', unchangedBusiness(evidence) && noCommitChange(evidence), 'persistent state/control unchanged'));
    assertions.push(assertion('保存失败后没有业务成功提示', !hasToast(evidence.uiEvents, '已转订单', 'success'), 'no success toast'));
  }

  assertions.push(assertion('测试结束无真实网络调用', evidence.isolationAudit.realNetworkRequests === 0 && evidence.isolationAudit.networkGuardErrors === 0, JSON.stringify(evidence.isolationAudit)));
  assertions.push(assertion('测试结束无宿主文件写入', evidence.isolationAudit.hostFilesystemWrites === 0, `actual=${evidence.isolationAudit.hostFilesystemWrites}`));
  const failed = assertions.filter((item) => !item.pass);
  return {
    assertions,
    caseStatus: failed.length ? 'CASE_FAIL' : 'PASS',
    failureStage: failed.length ? 'BUSINESS_CONTRACT_ERROR' : '',
    failureReason: failed.length ? failed[0].name : ''
  };
}

function instrumentationFor(testCase) {
  if (testCase.scenario === 'BACKWRITE_BOUNDARY_FAULT') {
    return {
      afterGetState(state, readCount) {
        if (readCount !== 2) return;
        const quote = quotationFor(state, testCase.quotationId);
        if (!quote) return;
        let status = quote.status;
        Object.defineProperty(quote, 'status', {
          configurable: true,
          enumerable: true,
          get() { return status; },
          set() {
            const error = new Error('Injected quotation backwrite fault after transient order construction');
            error.code = 'TEST_QUOTATION_BACKWRITE_FAULT';
            throw error;
          }
        });
      }
    };
  }
  if (testCase.scenario === 'SAVE_CALL_FAULT') {
    return {
      beforeSaveState() {
        const error = new Error('Injected page saveState call fault');
        error.code = 'TEST_SAVE_CALL_FAULT';
        throw error;
      }
    };
  }
  return null;
}

function shouldExpectPageError(testCase) {
  return ['PRIMARY_WRITE_FAULT', 'BACKWRITE_BOUNDARY_FAULT', 'SAVE_CALL_FAULT'].includes(testCase.scenario);
}

function runPageAttempt(runtime, spec, testCase, options = {}) {
  const driver = loadProductionPage('QUOTATION_LIST', runtime, spec, {
    quotationInstrumentation: options.instrumentation || null
  });
  const startId = options.startId || testCase.quotationId;
  const confirmId = options.confirmId || testCase.confirmQuotationId || testCase.quotationId;
  let opened = false;
  if (options.forceReplay) {
    driver.page.setData({ convertingQuotationId: startId, conversionDeliveryDate: testCase.deliveryDate });
    opened = true;
  } else {
    opened = beginConversion(driver.page, startId, testCase.deliveryDate);
  }
  let actionError = null;
  if (opened || options.forceConfirm) {
    try {
      invokeConfirm(driver, confirmId);
    } catch (error) {
      if (!shouldExpectPageError(testCase)) throw error;
      actionError = { code: error.code || 'PAGE_ACTION_ERROR', message: error.message };
    }
  }
  return { actionError, driver, opened };
}

async function executeQuotationToOrderCase(testCase, attempt = 1) {
  const spec = createRuntimeSpec(testCase);
  const storageFailureSchedule = testCase.scenario === 'PRIMARY_WRITE_FAULT' ? [{
    errorCode: 'TEST_PRIMARY_WRITE_FAULT',
    key: BUSINESS_STORAGE_KEY,
    message: 'Injected primary business bundle write failure',
    mode: 'THROW_BEFORE',
    occurrence: 1,
    operation: 'SET'
  }] : [];
  const runtime = createCaseRuntime(spec, { attempt, storageFailureSchedule });
  let result = null;
  try {
    const storage = require('../../../utils/storage');
    const business = require('../../../utils/business');
    const beforeState = storage.getState({ writerSource: 'Q2O_CASE_INITIAL_READ' });
    const controlBefore = controlFacts(runtime.fakeWx.getEntries());
    let conversionCalls = 0;
    let saveCalls = 0;
    let successfulSaveCalls = 0;
    let conversionResultOrderId = '';
    let actionError = null;
    let transientStateOnError = null;
    let reload = null;
    let restart = null;
    let concurrentSecondError = null;
    let explicitReadCount = 0;
    let pageUiEvents = [];

    if (testCase.scenario === 'CONCURRENT_SNAPSHOTS') {
      const snapshotA = storage.getState({ writerSource: 'Q2O_CONCURRENT_A_READ' });
      const snapshotB = storage.getState({ writerSource: 'Q2O_CONCURRENT_B_READ' });
      business.convertQuotationToOrder(snapshotA, testCase.quotationId, { requiredDeliveryDate: testCase.deliveryDate });
      business.convertQuotationToOrder(snapshotB, testCase.quotationId, { requiredDeliveryDate: testCase.deliveryDate });
      conversionCalls = 2;
      saveCalls = 1;
      storage.saveState(snapshotA, { writerSource: 'QUOTATION_CONVERT' });
      successfulSaveCalls = 1;
      saveCalls += 1;
      try {
        storage.saveState(snapshotB, { writerSource: 'QUOTATION_CONVERT' });
        successfulSaveCalls += 1;
      } catch (error) {
        concurrentSecondError = { code: error.code || 'CONCURRENT_SAVE_ERROR', message: error.message };
      }
    } else {
      let pageRun;
      if (testCase.scenario === 'MISSING_QUOTATION') {
        pageRun = runPageAttempt(runtime, spec, testCase, { forceConfirm: true });
      } else if (testCase.scenario === 'EVENT_ID_SWAP') {
        pageRun = runPageAttempt(runtime, spec, testCase, {
          confirmId: testCase.confirmQuotationId,
          startId: testCase.quotationId
        });
      } else if (testCase.scenario === 'FORCED_REPLAY') {
        pageRun = runPageAttempt(runtime, spec, testCase, { forceReplay: true });
      } else if (testCase.scenario === 'NORMAL_EXISTING_CLICK') {
        pageRun = runPageAttempt(runtime, spec, testCase);
      } else {
        pageRun = runPageAttempt(runtime, spec, testCase, {
          instrumentation: instrumentationFor(testCase)
        });
      }
      const firstEvidence = pageRun.driver.evidence;
      conversionCalls = firstEvidence.productionBusinessCalls.convertQuotationToOrder;
      saveCalls = firstEvidence.productionStorageCalls.saveState;
      successfulSaveCalls = firstEvidence.storageCallLog.filter((entry) => entry.method === 'saveState' && !entry.error).length;
      actionError = pageRun.actionError;
      const conversionLog = firstEvidence.conversionCallLog[0] || {};
      conversionResultOrderId = conversionLog.resultOrderId || '';
      transientStateOnError = conversionLog.transientStateOnError || null;

      if (testCase.scenario === 'DOUBLE_CONFIRM') {
        try {
          invokeConfirm(pageRun.driver, testCase.quotationId);
        } catch (error) {
          throw error;
        }
        conversionCalls = firstEvidence.productionBusinessCalls.convertQuotationToOrder;
        saveCalls = firstEvidence.productionStorageCalls.saveState;
        successfulSaveCalls = firstEvidence.storageCallLog.filter((entry) => entry.method === 'saveState' && !entry.error).length;
      }
      if (testCase.scenario === 'PAGE_RELOAD_RETRY') {
        const secondDriver = loadProductionPage('QUOTATION_LIST', runtime, spec);
        const panelOpened = beginConversion(secondDriver.page, testCase.quotationId, testCase.deliveryDate);
        reload = {
          panelOpened,
          pageConverted: Boolean((secondDriver.page.data.quotations || []).find((item) => (
            item.id === testCase.quotationId && item.isConverted
          ))),
          saveCalls: secondDriver.evidence.productionStorageCalls.saveState
        };
        conversionCalls += secondDriver.evidence.productionBusinessCalls.convertQuotationToOrder;
        saveCalls += secondDriver.evidence.productionStorageCalls.saveState;
        successfulSaveCalls += secondDriver.evidence.storageCallLog.filter((entry) => entry.method === 'saveState' && !entry.error).length;
      }
      pageUiEvents = uiEvents(runtime);
    }

    let finalState = storage.getState({ writerSource: 'Q2O_CASE_FINAL_READ' });
    explicitReadCount += 1;
    if (testCase.scenario === 'RESTART_READ' || testCase.scenario === 'APP_RESTART_RETRY') {
      restart = await executeQuotationRestart(spec, runtime.fakeWx.getEntries(), {
        action: testCase.scenario === 'APP_RESTART_RETRY' ? {
          deliveryDate: testCase.deliveryDate,
          quotationId: testCase.quotationId
        } : null,
        attempt
      });
      if (testCase.scenario === 'APP_RESTART_RETRY') finalState = safeClone(restart.state);
    }
    const entriesAfter = runtime.fakeWx.getEntries();
    const runtimeAudit = runtime.audit();
    const controlAfter = controlFacts(entriesAfter);
    result = {
      actionError,
      concurrentSecondError,
      controlAfter,
      controlBefore,
      conversionCalls,
      conversionResultOrderId,
      explicitReadCount,
      faultEvents: safeClone(runtimeAudit.storageAudit.faultEvents || []),
      finalState: stripRecordStorageControl(finalState),
      isolationAudit: {
        hostFilesystemWrites: runtimeAudit.hostFilesystemAudit.hostFilesystemStorageCalls || 0,
        networkGuardErrors: runtimeAudit.networkAudit.guardErrors || 0,
        realNetworkRequests: runtimeAudit.networkAudit.realNetworkRequests || 0
      },
      reload,
      restart: restart ? {
        newProcess: restart.newProcess,
        retryEvidence: safeClone(restart.retryEvidence),
        state: stripRecordStorageControl(restart.state)
      } : null,
      saveCalls,
      successfulSaveCalls,
      testCase: safeClone(testCase),
      transientStateOnError: transientStateOnError ? stripRecordStorageControl(transientStateOnError) : null,
      uiEvents: pageUiEvents.length ? pageUiEvents : safeClone(runtimeAudit.storageAudit.uiEvents || []),
      beforeState: stripRecordStorageControl(beforeState)
    };
    const assertionResult = assertEvidence(result);
    return Object.assign(result, assertionResult, {
      semanticFingerprint: stableHash({
        assertions: assertionResult.assertions.map((item) => ({ name: item.name, pass: item.pass })),
        caseStatus: assertionResult.caseStatus,
        conversionCalls,
        failureStage: assertionResult.failureStage,
        saveCalls,
        successfulSaveCalls
      }, 'q2o-result-v1')
    });
  } finally {
    runtime.dispose();
  }
}

module.exports = {
  assertEvidence,
  controlFacts,
  executeQuotationToOrderCase,
  orderFor,
  ordersFor,
  quotationFor
};
