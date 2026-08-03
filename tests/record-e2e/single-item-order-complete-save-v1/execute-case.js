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
const { createFakeStorageGateway } = require('../../../utils/record-storage-gateways');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { executeTransactionReplay } = require('../runner/execute-transaction-replay');
const { collectParserObservationSince } = require('../runner/observed-ai-parser');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { enterAndParse, invokeFormalSave } = require('./page-actions');
const { createRuntimeSpec } = require('./load-contract');
const { executeOrderRestart } = require('./execute-restart');

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

function compactCommit(result) {
  if (!result) return null;
  return {
    commitSucceeded: result.commitSucceeded === true,
    idempotentReplay: result.idempotentReplay === true,
    legacyStatus: result.legacyStatus || '',
    status: result.status || '',
    baseRevision: Number(result.baseRevision || 0),
    targetRevision: Number(result.targetRevision || 0),
    receipt: result.receipt ? {
      committedRevision: result.receipt.committedRevision,
      idempotencyKey: result.receipt.idempotencyKey,
      planHash: result.receipt.planHash,
      planId: result.receipt.planId,
      transactionId: result.receipt.transactionId
    } : null
  };
}

function stateSummary(state, targetOrderId) {
  const targetOrder = (state.orders || []).find((item) => item.id === targetOrderId) || null;
  const customer = targetOrder
    ? (state.customers || []).find((item) => item.id === targetOrder.customerId) || null
    : null;
  return {
    counts: Object.fromEntries([
      'customers', 'quotations', 'orders', 'receivables', 'paymentRecords',
      'dunningRecords', 'todos', 'orderProgress', 'pendingNotes',
      'aiParseLogs', 'operationLogs', 'productCatalog', 'deletedRecords'
    ].map((key) => [key, (state[key] || []).length])),
    customer: safeClone(customer),
    parseLogs: (state.aiParseLogs || []).map((item) => ({
      action: item.action || '', id: item.id || '', originalText: item.originalText || ''
    })),
    progress: (state.orderProgress || []).map((item) => ({
      id: item.id || '', note: item.note || '', orderId: item.orderId || '', status: item.status || ''
    })),
    targetOrder: safeClone(targetOrder)
  };
}

function confirmationFields(parseResult) {
  const fields = parseResult && parseResult.fields || {};
  return {
    customerName: fields.customerName || '',
    dueDate: fields.dueDate || '',
    items: safeClone(fields.items || []),
    productName: fields.productName || '',
    quantity: fields.quantity || '',
    totalAmount: fields.totalAmount || fields.amount || '',
    unit: fields.unit || '',
    unitPrice: fields.unitPrice || ''
  };
}

function compactListOrder(order) {
  if (!order) return null;
  return {
    customerDisplay: order.customerDisplay || '',
    id: order.id || '',
    itemsSummary: order.itemsSummary || '',
    originalText: order.originalTextForDisplay || order.originalText || '',
    quantitySummary: order.quantitySummary || '',
    requiredDeliveryDate: order.requiredDeliveryDate || '',
    status: order.status || '',
    totalAmountDisplay: order.totalAmountDisplay || ''
  };
}

function compactDetail(detail) {
  if (!detail) return null;
  return {
    customerId: detail.customerId || '',
    fields: safeClone(detail.fields || []),
    id: detail.id || '',
    items: safeClone(detail.items || []),
    originalText: detail.originalText || '',
    record: safeClone(detail.record || null),
    status: detail.status || '',
    title: detail.title || '',
    type: detail.type || ''
  };
}

function pageInstrumentation(testCase) {
  if (testCase.scenario === 'BUSINESS_RETURN_ERROR') {
    return {
      invokeSaveConfirmedDraft() {
        return {
          type: 'error',
          code: 'TEST_BUSINESS_SAVE_REJECTED',
          error: '测试注入：业务保存明确拒绝',
          noMutation: true
        };
      }
    };
  }
  return null;
}

function storageFailureSchedule(testCase) {
  if (testCase.scenario === 'PRIMARY_WRITE_FAULT') {
    return [{
      errorCode: 'TEST_PRIMARY_WRITE_FAULT',
      key: BUSINESS_STORAGE_KEY,
      message: 'Injected primary business bundle write failure',
      mode: 'THROW_BEFORE',
      occurrence: 1,
      operation: 'SET'
    }];
  }
  if (testCase.scenario === 'READBACK_FAULT') {
    return [{
      errorCode: 'TEST_PRIMARY_READBACK_CORRUPT',
      key: BUSINESS_STORAGE_KEY,
      message: 'Injected corrupt read after primary write',
      mode: 'RETURN_CORRUPT_AFTER_NEXT_SET',
      operation: 'GET'
    }];
  }
  return [];
}

function newOrderFrom(beforeState, finalState) {
  const beforeIds = new Set((beforeState.orders || []).map((item) => item.id));
  return (finalState.orders || []).find((item) => !beforeIds.has(item.id)) || null;
}

function uiHasSuccess(events) {
  return (events || []).some((item) => item.type === 'TOAST'
    && item.icon === 'success'
    && String(item.title || '').includes('已保存'));
}

function assertion(name, pass, detail, stage = 'BUSINESS_CONTRACT_ERROR') {
  return { detail: String(detail || ''), name, pass: pass === true, stage };
}

function same(a, b) {
  return stableSerialize(a) === stableSerialize(b);
}

function fieldValue(detail, label) {
  const found = detail && (detail.fields || []).find((item) => item.label === label);
  return found && found.value || '';
}

function buildAssertions(context) {
  const {
    testCase, beforeState, finalState, targetOrder, targetCustomer, confirmation,
    listOrder, detail, controlBefore, controlAfter, pageEvidence, uiEvents,
    successfulSaveCalls, saveStateCalls, actionError, restart, reload,
    transactionReplay, concurrent, faultEvents, reportDistinction
  } = context;
  const number = Number(testCase.caseId.slice(-3));
  const assertions = [];
  const failureScenario = ['PRIMARY_WRITE_FAULT', 'BUSINESS_RETURN_ERROR', 'NO_PAGE_ACTION']
    .includes(testCase.scenario);
  const concurrencyScenario = testCase.scenario === 'CONCURRENT_SNAPSHOTS';
  const normalSuccess = !failureScenario && !concurrencyScenario;

  assertions.push(assertion('真实页面本地解析完成', Boolean(context.parseResult), 'parseResult', 'PARSE_CONTRACT_ERROR'));
  assertions.push(assertion('解析路由为本地且人工智能零调用', context.parseRoute === 'local' && context.aiCallCount === 0, `${context.parseRoute}/${context.aiCallCount}`, 'PARSE_CONTRACT_ERROR'));
  assertions.push(assertion('原始 Parser 自动识别交期', context.rawParserDueDate === testCase.sample.dueDate, `${context.rawParserDueDate}/${testCase.sample.dueDate}`, 'PARSE_CONTRACT_ERROR'));
  assertions.push(assertion('Hybrid 保留 Parser 交期', context.hybridDueDate === testCase.sample.dueDate && context.parseResultDueDate === testCase.sample.dueDate, `${context.hybridDueDate}/${context.parseResultDueDate}/${testCase.sample.dueDate}`, 'PARSE_CONTRACT_ERROR'));
  assertions.push(assertion('确认态是单商品普通订单', Boolean(context.parseResult && context.parseResult.intent === 'order' && confirmation.items.length === 1), `intent=${context.parseResult && context.parseResult.intent};items=${confirmation.items.length}`, 'CONFIRMATION_CONTRACT_ERROR'));
  assertions.push(assertion('页面确认卡自动显示交期', context.pageConfirmationDueDate === testCase.sample.dueDate && confirmation.dueDate === testCase.sample.dueDate, `${context.pageConfirmationDueDate}/${confirmation.dueDate}/${testCase.sample.dueDate}`, 'CONFIRMATION_CONTRACT_ERROR'));
  assertions.push(assertion('测试未操作日期控件', Number(pageEvidence.pageMethodCalls.changeConfirmDate || 0) === 0 && Number(pageEvidence.pageMethodCalls.changeDateField || 0) === 0, JSON.stringify(pageEvidence.pageMethodCalls), 'CONFIRMATION_CONTRACT_ERROR'));

  if (normalSuccess) {
    assertions.push(assertion('页面正式保存动作有效执行一次', pageEvidence.pagePrimaryActionCalls.saveFormal === 1, pageEvidence.pagePrimaryActionCalls.saveFormal, 'PAGE_SAVE_CONTRACT_ERROR'));
    assertions.push(assertion('真实业务构造返回订单', context.businessSaveCalls === 1 && context.businessResult && context.businessResult.type === 'order', `${context.businessSaveCalls}/${context.businessResult && context.businessResult.type}`, 'PAGE_SAVE_CONTRACT_ERROR'));
    assertions.push(assertion('真实 saveState 成功一次', saveStateCalls === 1 && successfulSaveCalls === 1, `${saveStateCalls}/${successfulSaveCalls}`, 'STORAGE_CONTRACT_ERROR'));
    assertions.push(assertion('正式提交只新增一张订单', Boolean(targetOrder && (finalState.orders || []).length === (beforeState.orders || []).length + 1), `orders=${(beforeState.orders || []).length}->${(finalState.orders || []).length}`, 'PERSISTENCE_CONTRACT_ERROR'));
    assertions.push(assertion('版本和收据只增加一次', controlAfter.revision - controlBefore.revision === 1 && controlAfter.receiptCount - controlBefore.receiptCount === 1, `${controlBefore.revision}/${controlBefore.receiptCount}->${controlAfter.revision}/${controlAfter.receiptCount}`, 'STORAGE_CONTRACT_ERROR'));
    assertions.push(assertion('页面显示业务成功', uiHasSuccess(uiEvents), JSON.stringify(uiEvents), 'PAGE_RESULT_CONTRACT_ERROR'));
    assertions.push(assertion('真实列表和详情读取同一订单', Boolean(listOrder && detail && targetOrder && listOrder.id === targetOrder.id && detail.id === targetOrder.id), targetOrder && targetOrder.id, 'READBACK_CONTRACT_ERROR'));
    assertions.push(assertion('重读订单交期与确认卡一致', Boolean(targetOrder && targetOrder.requiredDeliveryDate === testCase.sample.dueDate && targetOrder.expectedShipDate === testCase.sample.dueDate), targetOrder && `${targetOrder.requiredDeliveryDate}/${targetOrder.expectedShipDate}`, 'PERSISTENCE_CONTRACT_ERROR'));
  }

  if ([1, 10].includes(number)) {
    assertions.push(assertion('新客户订单完整保存', Boolean(targetOrder && targetCustomer && targetCustomer.name === testCase.sample.customerName), targetCustomer && targetCustomer.name));
  } else if ([2, 11].includes(number)) {
    assertions.push(assertion('已有客户被复用且未重复新增', Boolean(targetOrder && targetOrder.customerId === 'sio-customer-li' && (finalState.customers || []).length === 1), targetOrder && targetOrder.customerId));
  } else if ([3, 14].includes(number)) {
    const method = testCase.entrySurface === 'HOME_QUICK' ? 'confirmQuickSave' : 'saveFormal';
    assertions.push(assertion('真实页面保存方法调用一次', pageEvidence.pageMethodCalls[method] === 1, pageEvidence.pageMethodCalls[method]));
  } else if ([4, 15].includes(number)) {
    const saveLog = pageEvidence.storageCallLog.find((item) => item.method === 'saveState');
    assertions.push(assertion('saveState 来源与入口一致', Boolean(saveLog && saveLog.options.writerSource === (testCase.entrySurface === 'HOME_QUICK' ? 'DASHBOARD_FORMAL' : 'INPUT_FORMAL')), saveLog && saveLog.options.writerSource));
  } else if (number === 5) {
    assertions.push(assertion('目标订单增量严格为一', (finalState.orders || []).length - (beforeState.orders || []).length === 1, (finalState.orders || []).length));
  } else if (number === 6) {
    assertions.push(assertion('新建或复用客户符合唯一关系', Boolean(targetOrder && targetCustomer && (finalState.customers || []).filter((item) => item.name === testCase.sample.customerName).length === 1), targetOrder && targetOrder.customerId));
  } else if (number === 7) {
    const catalog = (finalState.productCatalog || []).filter((item) => item.productName === testCase.sample.productName);
    assertions.push(assertion('商品目录只学习当前商品一次', catalog.length === 1 && Number(catalog[0].useCount) === 1, JSON.stringify(catalog)));
  } else if (number === 8) {
    assertions.push(assertion('成功 Toast 精确可观测', uiHasSuccess(uiEvents), JSON.stringify(uiEvents)));
  } else if (number === 9) {
    assertions.push(assertion('断言基于正式保存后的 getState 重读', context.explicitReadCount >= 1 && Boolean(targetOrder), context.explicitReadCount));
  } else if ([12, 13].includes(number)) {
    assertions.push(assertion('确认态字段与最终订单一致', Boolean(targetOrder
      && targetOrder.customerId === targetCustomer.id
      && targetOrder.productName === confirmation.productName
      && String(targetOrder.quantity) === String(confirmation.quantity)
      && String(targetOrder.unitPrice) === String(confirmation.unitPrice)
      && String(targetOrder.totalAmount) === String(confirmation.totalAmount)
      && targetOrder.requiredDeliveryDate === confirmation.dueDate), JSON.stringify(confirmation)));
  } else if (number === 16) {
    assertions.push(assertion('customerId 指向正确持久化客户', Boolean(targetOrder && targetCustomer && targetOrder.customerId === targetCustomer.id && targetCustomer.name === testCase.sample.customerName), targetOrder && targetOrder.customerId));
  } else if (number === 17) {
    assertions.push(assertion('items 恰好一项', Boolean(targetOrder && targetOrder.items && targetOrder.items.length === 1), targetOrder && targetOrder.items && targetOrder.items.length));
  } else if (number === 18) {
    const item = targetOrder && targetOrder.items && targetOrder.items[0];
    assertions.push(assertion('单商品五项字段及小计正确', Boolean(item
      && item.productName === testCase.sample.productName
      && String(item.quantity) === testCase.sample.quantity
      && item.unit === testCase.sample.unit
      && String(item.unitPrice) === testCase.sample.unitPrice
      && String(item.totalAmount) === testCase.sample.totalAmount), JSON.stringify(item)));
  } else if (number === 19) {
    const item = targetOrder && targetOrder.items && targetOrder.items[0];
    assertions.push(assertion('顶层兼容字段与第一项一致', Boolean(item && ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'].every((key) => targetOrder[key] === item[key])), JSON.stringify(item)));
  } else if (number === 20) {
    assertions.push(assertion('订单总额准确', Boolean(targetOrder && String(targetOrder.totalAmount) === testCase.sample.totalAmount), targetOrder && targetOrder.totalAmount));
  } else if (number === 21) {
    assertions.push(assertion('两个交期字段均准确', Boolean(targetOrder && targetOrder.requiredDeliveryDate === testCase.sample.dueDate && targetOrder.expectedShipDate === testCase.sample.dueDate), targetOrder && `${targetOrder.requiredDeliveryDate}/${targetOrder.expectedShipDate}`));
  } else if (number === 22) {
    assertions.push(assertion('普通订单初始状态为待生产', Boolean(targetOrder && targetOrder.status === '待生产'), targetOrder && targetOrder.status));
  } else if (number === 23) {
    assertions.push(assertion('originalText 原样保留', Boolean(targetOrder && targetOrder.originalText === testCase.sample.input), targetOrder && targetOrder.originalText));
  } else if (number === 24) {
    assertions.push(assertion('创建更新时间使用冻结时钟', Boolean(targetOrder && targetOrder.createdAt === testCase.clock.nowInstant && targetOrder.updatedAt === testCase.clock.nowInstant), targetOrder && `${targetOrder.createdAt}/${targetOrder.updatedAt}`));
  } else if (number === 25) {
    const created = (finalState.orderProgress || []).filter((item) => targetOrder && item.orderId === targetOrder.id);
    assertions.push(assertion('只新增一条创建订单进度', created.length === 1 && created[0].note === '创建订单', JSON.stringify(created)));
  } else if (number === 26) {
    const logs = (finalState.aiParseLogs || []).filter((item) => item.originalText === testCase.sample.input);
    assertions.push(assertion('只新增一条 save_order 解析日志', logs.length === 1 && logs[0].action === 'save_order', JSON.stringify(logs.map((item) => item.action))));
  } else if (number >= 27 && number <= 32) {
    const key = { 27: 'quotations', 28: 'receivables', 29: 'paymentRecords', 30: 'paymentRecords', 31: 'todos', 32: 'pendingNotes' }[number];
    assertions.push(assertion(`${key} 范围外集合不变`, same(beforeState[key] || [], finalState[key] || []), `${(beforeState[key] || []).length}->${(finalState[key] || []).length}`));
    if (number === 30) {
      assertions.push(assertion('没有任何定金类收款', !(finalState.paymentRecords || []).some((item) => item.kind === 'deposit' || item.paymentKind === 'deposit'), 'no deposit'));
    }
  } else if (number === 33) {
    const oldCustomerBefore = (beforeState.customers || []).find((item) => item.id === 'sio-unrelated-customer');
    const oldCustomerAfter = (finalState.customers || []).find((item) => item.id === 'sio-unrelated-customer');
    const oldOrderBefore = (beforeState.orders || []).find((item) => item.id === 'sio-unrelated-order');
    const oldOrderAfter = (finalState.orders || []).find((item) => item.id === 'sio-unrelated-order');
    assertions.push(assertion('无关客户和旧订单逐字段不变', same(oldCustomerBefore, oldCustomerAfter) && same(oldOrderBefore, oldOrderAfter), 'unrelated records'));
  } else if (number === 34) {
    assertions.push(assertion('订单列表包含新订单', Boolean(listOrder && targetOrder && listOrder.id === targetOrder.id), listOrder && listOrder.id));
  } else if (number === 35) {
    assertions.push(assertion('列表显示客户商品金额交期状态', Boolean(listOrder
      && String(listOrder.customerDisplay || '').includes(testCase.sample.customerName)
      && listOrder.itemsSummary === testCase.sample.productName
      && listOrder.totalAmountDisplay === `¥${testCase.sample.totalAmount}`
      && listOrder.requiredDeliveryDate === testCase.sample.dueDate
      && listOrder.status === '待生产'), JSON.stringify(compactListOrder(listOrder))));
  } else if (number === 36) {
    assertions.push(assertion('订单详情真实打开', Boolean(detail && detail.type === 'order' && detail.id === targetOrder.id), detail && detail.id));
  } else if (number === 37) {
    assertions.push(assertion('详情 record 等于持久化订单', Boolean(detail && targetOrder && same(detail.record, targetOrder)), 'detail.record'));
  } else if (number === 38) {
    assertions.push(assertion('详情原文和持久化原文一致', Boolean(detail && targetOrder && detail.originalText === targetOrder.originalText), detail && detail.originalText));
  } else if (number === 39) {
    assertions.push(assertion('页面重开仍为同一张订单', Boolean(reload && reload.orderCount === (beforeState.orders || []).length + 1 && reload.listOrderId === targetOrder.id && reload.detailOrderId === targetOrder.id), JSON.stringify(reload)));
  } else if (number >= 40 && number <= 42) {
    assertions.push(assertion('应用重启使用新进程并读到同一订单', Boolean(restart && restart.newProcess && restart.order && targetOrder && restart.order.id === targetOrder.id), restart && restart.order && restart.order.id));
    if (number === 41) assertions.push(assertion('重启不新增订单', restart.orderCount === (finalState.orders || []).length, restart.orderCount));
    if (number === 42) assertions.push(assertion('重启不增加版本或收据', restart.controlAfterLaunch.revision === restart.controlBeforeLaunch.revision && restart.controlAfterLaunch.receiptCount === restart.controlBeforeLaunch.receiptCount, JSON.stringify(restart)));
  } else if (number === 43) {
    const method = testCase.entrySurface === 'HOME_QUICK' ? 'confirmQuickSave' : 'saveFormal';
    assertions.push(assertion('连续点击只有一次有效正式保存', pageEvidence.pageMethodCalls[method] === 2 && pageEvidence.pagePrimaryActionCalls.saveFormal === 1 && context.businessSaveCalls === 1 && saveStateCalls === 1 && (finalState.orders || []).length === 1, JSON.stringify({ methods: pageEvidence.pageMethodCalls[method], primary: pageEvidence.pagePrimaryActionCalls.saveFormal, business: context.businessSaveCalls, saves: saveStateCalls })));
  } else if (number === 44) {
    assertions.push(assertion('精确事务重放是幂等回执', Boolean(transactionReplay && transactionReplay.replay && transactionReplay.replay.idempotentReplay === true && transactionReplay.revisionDelta === 0 && transactionReplay.receiptCountDelta === 0 && transactionReplay.businessBundleEqual), JSON.stringify(transactionReplay)));
  } else if (number === 45) {
    assertions.push(assertion('两个旧快照最多一个成功', Boolean(concurrent && concurrent.saveCalls === 2 && concurrent.successfulSaveCalls === 1 && concurrent.secondError), JSON.stringify(concurrent)));
  } else if (number === 46) {
    assertions.push(assertion('旧快照被拒且未覆盖首个订单', Boolean(concurrent && concurrent.firstOrderId && targetOrder && targetOrder.id === concurrent.firstOrderId && !concurrent.secondOrderPersisted), JSON.stringify(concurrent)));
  } else if (number === 48) {
    assertions.push(assertion('主写后损坏读回故障真实命中', faultEvents.length === 1 && faultEvents[0].mode === 'RETURN_CORRUPT_AFTER_NEXT_SET', JSON.stringify(faultEvents), 'STORAGE_CONTRACT_ERROR'));
    assertions.push(assertion('事务恢复确认一次完整新状态', Boolean(targetOrder
      && successfulSaveCalls === 1
      && controlAfter.revision - controlBefore.revision === 1
      && controlAfter.receiptCount - controlBefore.receiptCount === 1
      && !controlAfter.journalPresent
      && !controlAfter.backupPresent), JSON.stringify({ targetOrder: targetOrder && targetOrder.id, successfulSaveCalls, controlAfter }), 'RECOVERY_CONTRACT_ERROR'));
    assertions.push(assertion('恢复后不存在半截业务关系', Boolean(targetOrder && targetCustomer
      && (finalState.orderProgress || []).filter((item) => item.orderId === targetOrder.id).length === 1
      && (finalState.aiParseLogs || []).filter((item) => item.originalText === testCase.sample.input).length === 1), targetOrder && targetOrder.id, 'RECOVERY_CONTRACT_ERROR'));
  } else if (number >= 47 && number <= 53) {
    assertions.push(assertion('存储故障已真实命中', faultEvents.length === 1, JSON.stringify(faultEvents), 'STORAGE_CONTRACT_ERROR'));
    assertions.push(assertion('故障后持久化业务状态完整不变', getStateFingerprint(beforeState) === getStateFingerprint(finalState), `${getStateFingerprint(beforeState)} / ${getStateFingerprint(finalState)}`, 'ROLLBACK_CONTRACT_ERROR'));
    assertions.push(assertion('故障没有成功提交和成功提示', successfulSaveCalls === 0 && !uiHasSuccess(uiEvents), `${successfulSaveCalls}/${JSON.stringify(uiEvents)}`, 'ROLLBACK_CONTRACT_ERROR'));
    if (number === 49) assertions.push(assertion('没有半张订单', (finalState.orders || []).length === (beforeState.orders || []).length, (finalState.orders || []).length));
    if (number === 50) assertions.push(assertion('没有孤立客户', (finalState.customers || []).length === (beforeState.customers || []).length, (finalState.customers || []).length));
    if (number === 51) assertions.push(assertion('没有错误进度或解析日志', same(beforeState.orderProgress || [], finalState.orderProgress || []) && same(beforeState.aiParseLogs || [], finalState.aiParseLogs || []), 'progress/logs'));
    if (number === 52) assertions.push(assertion('页面无任何业务成功 Toast', !uiHasSuccess(uiEvents), JSON.stringify(uiEvents)));
    if (number === 53) assertions.push(assertion('故障清理日志备份且零版本收据', !controlAfter.journalPresent && !controlAfter.backupPresent && controlAfter.revision === controlBefore.revision && controlAfter.receiptCount === controlBefore.receiptCount, JSON.stringify(controlAfter)));
  } else if (number === 54) {
    assertions.push(assertion('未执行页面保存时零业务零存储提交', pageEvidence.pagePrimaryActionCalls.saveFormal === 0 && context.businessSaveCalls === 0 && saveStateCalls === 0 && getStateFingerprint(beforeState) === getStateFingerprint(finalState), JSON.stringify(reportDistinction)));
    assertions.push(assertion('报告没有把未执行动作标成页面成功', reportDistinction.pageFormalSave === false && reportDistinction.realStorageCommit === false && reportDistinction.readbackContainsTarget === false, JSON.stringify(reportDistinction)));
  } else if (number === 55) {
    assertions.push(assertion('业务返回失败后零 saveState 零持久化', context.businessSaveCalls === 1 && context.businessResult && context.businessResult.type === 'error' && saveStateCalls === 0 && getStateFingerprint(beforeState) === getStateFingerprint(finalState), JSON.stringify(context.businessResult)));
    assertions.push(assertion('业务失败没有错误成功提示', !uiHasSuccess(uiEvents), JSON.stringify(uiEvents)));
  } else if (number === 56) {
    assertions.push(assertion('报告四类保存事实互不混淆', reportDistinction.pageFormalSave === true && reportDistinction.testOnlyIsolatedCommit === false && reportDistinction.realStorageCommit === true && reportDistinction.readbackContainsTarget === true, JSON.stringify(reportDistinction)));
  }

  assertions.push(assertion('测试未访问真实网络或宿主文件', context.isolation.realNetworkRequests === 0 && context.isolation.networkGuardErrors === 0 && context.isolation.hostFilesystemWrites === 0, JSON.stringify(context.isolation), 'ISOLATION_CONTRACT_ERROR'));
  if (actionError && !['PRIMARY_WRITE_FAULT', 'READBACK_FAULT'].includes(testCase.scenario)) {
    assertions.push(assertion('正常页面动作不得抛异常', false, `${actionError.code}:${actionError.message}`, 'PAGE_SAVE_CONTRACT_ERROR'));
  }
  return assertions;
}

async function executeConcurrentScenario(storage, parseResult) {
  const business = require('../../../utils/business');
  const snapshotA = storage.getState({ writerSource: 'SIO_CONCURRENT_A_READ' });
  const snapshotB = storage.getState({ writerSource: 'SIO_CONCURRENT_B_READ' });
  const resultA = business.saveConfirmedDraft(snapshotA, safeClone(parseResult));
  const resultB = business.saveConfirmedDraft(snapshotB, safeClone(parseResult));
  let saveCalls = 1;
  let successfulSaveCalls = 1;
  storage.saveState(snapshotA, { writerSource: 'INPUT_FORMAL' });
  let secondError = null;
  saveCalls += 1;
  try {
    storage.saveState(snapshotB, { writerSource: 'INPUT_FORMAL' });
    successfulSaveCalls += 1;
  } catch (error) {
    secondError = { code: error.code || 'STALE_SAVE_ERROR', message: error.message };
  }
  const final = storage.getState({ writerSource: 'SIO_CONCURRENT_FINAL_READ' });
  return {
    final,
    firstOrderId: resultA && resultA.record && resultA.record.id || '',
    secondError,
    secondOrderId: resultB && resultB.record && resultB.record.id || '',
    secondOrderPersisted: Boolean(resultB && resultB.record && (final.orders || []).some((item) => item.id === resultB.record.id)),
    saveCalls,
    successfulSaveCalls
  };
}

async function executeSingleItemOrderCase(testCase, attempt = 1) {
  const spec = createRuntimeSpec(testCase);
  const runtime = createCaseRuntime(spec, {
    attempt,
    storageFailureSchedule: storageFailureSchedule(testCase)
  });
  try {
    const storage = require('../../../utils/storage');
    const beforeState = stripRecordStorageControl(storage.getState({ writerSource: 'SIO_INITIAL_READ' }));
    const controlBefore = controlFacts(runtime.fakeWx.getEntries());
    const driver = loadProductionPage(testCase.entrySurface, runtime, spec, {
      instrumentation: pageInstrumentation(testCase)
    });
    const parseResult = await enterAndParse(driver, testCase.sample.input);
    const confirmation = confirmationFields(parseResult);
    const parserObservation = collectParserObservationSince(driver.evidence.parserObservationCursor);
    const primaryHybridObservation = parserObservation.hybridInvocations[0] || null;
    const primaryRawObservation = primaryHybridObservation
      && (primaryHybridObservation.rawInvocations || []).find((item) => item.role === 'HYBRID_PRIMARY_LOCAL_PARSE')
      || null;
    const rawParserDueDate = primaryRawObservation && primaryRawObservation.resultSummary
      && primaryRawObservation.resultSummary.dueDate || '';
    const hybridDueDate = primaryHybridObservation && primaryHybridObservation.resultSummary
      && primaryHybridObservation.resultSummary.dueDate || '';
    const parseResultDueDate = parseResult && parseResult.fields && parseResult.fields.dueDate || '';
    const pageConfirmationDueDate = testCase.entrySurface === 'HOME_QUICK'
      ? ((driver.page.data.confirmFields || []).find((item) => item.field === 'dueDate') || {}).value || ''
      : driver.page.data.fields && driver.page.data.fields.dueDate || '';
    const parseRoute = parseResult && parseResult.parse_route && parseResult.parse_route.decision || '';
    let actionError = null;
    let concurrent = null;
    let transactionReplay = null;
    let pageActionInvocations = 0;

    if (testCase.scenario === 'CONCURRENT_SNAPSHOTS') {
      concurrent = await executeConcurrentScenario(storage, parseResult);
    } else if (testCase.scenario !== 'NO_PAGE_ACTION') {
      try {
        invokeFormalSave(driver);
        pageActionInvocations += 1;
      } catch (error) {
        actionError = { code: error.code || 'PAGE_ACTION_ERROR', message: error.message };
      }
      if (testCase.scenario === 'DOUBLE_CLICK') {
        try {
          invokeFormalSave(driver);
          pageActionInvocations += 1;
        } catch (error) {
          actionError = actionError || { code: error.code || 'PAGE_ACTION_ERROR', message: error.message };
        }
      }
    }

    let explicitReadCount = 0;
    let finalState;
    try {
      finalState = stripRecordStorageControl(storage.getState({ writerSource: 'SIO_FINAL_READ' }));
      explicitReadCount += 1;
    } catch (error) {
      actionError = actionError || { code: error.code || 'STORAGE_READ_ERROR', message: error.message };
      finalState = safeClone(beforeState);
    }
    if (concurrent) finalState = stripRecordStorageControl(concurrent.final);
    const targetOrder = newOrderFrom(beforeState, finalState);
    const targetCustomer = targetOrder
      ? (finalState.customers || []).find((item) => item.id === targetOrder.customerId) || null
      : null;

    let listOrder = null;
    let detail = null;
    if (targetOrder) {
      const listDriver = loadProductionPage('ORDER_LIST', runtime, spec);
      listOrder = (listDriver.page.data.orders || []).find((item) => item.id === targetOrder.id) || null;
      const detailDriver = loadProductionPage('RECORD_DETAIL', runtime, spec, {
        onLoadOptions: { type: 'order', id: targetOrder.id }
      });
      detail = detailDriver.page.data.detail || null;
    }

    let reload = null;
    if (testCase.scenario === 'PAGE_RELOAD' && targetOrder) {
      const reloadList = loadProductionPage('ORDER_LIST', runtime, spec);
      const reloadDetail = loadProductionPage('RECORD_DETAIL', runtime, spec, {
        onLoadOptions: { type: 'order', id: targetOrder.id }
      });
      reload = {
        detailOrderId: reloadDetail.page.data.detail && reloadDetail.page.data.detail.id || '',
        listOrderId: (reloadList.page.data.orders || []).find((item) => item.id === targetOrder.id) && targetOrder.id || '',
        orderCount: (reloadList.page.data.orders || []).length
      };
    }

    const storageStatus = storage.getRecordStorageInfrastructureStatus();
    const firstCommitResult = storageStatus.lastWriteResult;
    if (testCase.scenario === 'EXACT_TRANSACTION_REPLAY' && firstCommitResult) {
      const replayGateway = createFakeStorageGateway(runtime.fakeWx.getEntries());
      transactionReplay = executeTransactionReplay({
        commitResult: safeClone(firstCommitResult),
        gateway: replayGateway
      }, spec);
    }

    let restart = null;
    if (testCase.scenario === 'APP_RESTART' && targetOrder) {
      restart = await executeOrderRestart(spec, runtime.fakeWx.getEntries(), targetOrder.id, attempt);
    }

    const runtimeAudit = runtime.audit();
    const entriesAfter = runtime.fakeWx.getEntries();
    const controlAfter = controlFacts(entriesAfter);
    const businessEntry = driver.evidence.businessCallLog[0] || null;
    const businessResult = businessEntry && businessEntry.result || null;
    const storageEntries = driver.evidence.storageCallLog.filter((item) => item.method === 'saveState');
    const pageSaveStateCalls = driver.evidence.productionStorageCalls.saveState;
    const directSaveStateCalls = concurrent ? concurrent.saveCalls : 0;
    const saveStateCalls = pageSaveStateCalls + directSaveStateCalls;
    const pageSuccessfulSaveCalls = storageEntries.filter((item) => !item.error).length;
    const successfulSaveCalls = pageSuccessfulSaveCalls + (concurrent ? concurrent.successfulSaveCalls : 0);
    const aiCallCount = (runtimeAudit.networkAudit.events || []).filter((item) => item.path === '/api/ai/parse' || item.path === '/api/ai/parse/deep').length;
    const uiEvents = safeClone(runtimeAudit.storageAudit.uiEvents || []);
    const reportDistinction = {
      pageFormalSave: driver.evidence.pagePrimaryActionCalls.saveFormal === 1,
      pageActionInvocations,
      realStorageCommit: successfulSaveCalls > 0,
      readbackContainsTarget: Boolean(targetOrder),
      testOnlyIsolatedCommit: Boolean(transactionReplay || concurrent),
      transactionReplayExecuted: Boolean(transactionReplay)
    };
    const context = {
      actionError,
      aiCallCount,
      beforeState,
      businessResult,
      businessSaveCalls: driver.evidence.productionBusinessCalls.saveConfirmedDraft,
      confirmation,
      concurrent,
      controlAfter,
      controlBefore,
      detail,
      explicitReadCount,
      faultEvents: safeClone(runtimeAudit.storageAudit.faultEvents || []),
      finalState,
      isolation: {
        hostFilesystemWrites: runtimeAudit.hostFilesystemAudit.hostFilesystemStorageCalls || 0,
        networkGuardErrors: runtimeAudit.networkAudit.guardErrors || 0,
        realNetworkRequests: runtimeAudit.networkAudit.realNetworkRequests || 0
      },
      listOrder,
      pageEvidence: driver.evidence,
      pageConfirmationDueDate,
      parseResult,
      parseResultDueDate,
      parseRoute,
      rawParserDueDate,
      reload,
      reportDistinction,
      restart,
      saveStateCalls,
      successfulSaveCalls,
      targetCustomer,
      targetOrder,
      testCase,
      transactionReplay,
      uiEvents,
      hybridDueDate
    };
    const assertions = buildAssertions(context);
    const failed = assertions.filter((item) => !item.pass);
    const caseStatus = failed.length ? 'CASE_FAIL' : 'PASS';
    const result = {
      actionError,
      aiCallCount,
      assertions,
      businessConstructionResult: safeClone(businessResult),
      businessSaveCalls: context.businessSaveCalls,
      caseId: testCase.caseId,
      caseStatus,
      commitResult: compactCommit(firstCommitResult),
      confirmationFields: confirmation,
      contract: safeClone(testCase.contract),
      control: {
        after: controlAfter,
        before: controlBefore,
        receiptDelta: controlAfter.receiptCount - controlBefore.receiptCount,
        revisionDelta: controlAfter.revision - controlBefore.revision
      },
      entrySurface: testCase.entrySurface,
      failureReason: failed.length ? failed[0].name : '',
      failureStage: failed.length ? failed[0].stage : '',
      finalPersistentState: stateSummary(finalState, targetOrder && targetOrder.id),
      initialPersistentState: stateSummary(beforeState, ''),
      isolation: context.isolation,
      listResult: compactListOrder(listOrder),
      detailResult: compactDetail(detail),
      mustNotExist: safeClone(testCase.contract.mustNotExist),
      pageFormalSaveCalls: driver.evidence.pagePrimaryActionCalls.saveFormal,
      pageMethodCalls: safeClone(driver.evidence.pageMethodCalls),
      parseRoute,
      parserObservation: {
        hybridDueDate,
        hybridInvocationCount: parserObservation.hybridInvocations.length,
        pageConfirmationDueDate,
        parseResultDueDate,
        rawParserDueDate,
        rawInvocationCount: parserObservation.rawInvocationCount,
        status: parserObservation.status
      },
      productionGap: testCase.contract.productionGap,
      reload: safeClone(reload),
      reportDistinction,
      restart: restart ? {
        controlAfterLaunch: restart.controlAfterLaunch,
        controlBeforeLaunch: restart.controlBeforeLaunch,
        detailOrderId: restart.detail && restart.detail.id || '',
        listOrderId: restart.listOrder && restart.listOrder.id || '',
        newProcess: restart.newProcess,
        order: safeClone(restart.order),
        orderCount: restart.orderCount
      } : { executed: false },
      saveStateCalls,
      saveStateLog: safeClone(storageEntries),
      scenario: testCase.scenario,
      successfulSaveCalls,
      transactionReplay: transactionReplay ? {
        businessBundleEqual: transactionReplay.businessBundleEqual,
        idempotentReplay: transactionReplay.replay && transactionReplay.replay.idempotentReplay === true,
        receiptCountDelta: transactionReplay.receiptCountDelta,
        revisionDelta: transactionReplay.revisionDelta,
        sameIdentity: transactionReplay.sameIdentity
      } : { executed: false },
      concurrent: concurrent ? {
        firstOrderId: concurrent.firstOrderId,
        secondError: concurrent.secondError,
        secondOrderId: concurrent.secondOrderId,
        secondOrderPersisted: concurrent.secondOrderPersisted,
        saveCalls: concurrent.saveCalls,
        successfulSaveCalls: concurrent.successfulSaveCalls
      } : { executed: false },
      uiEvents,
      surfaceError: false
    };
    result.semanticFingerprint = stableHash({
      assertions: assertions.map((item) => ({ name: item.name, pass: item.pass })),
      caseStatus,
      failureReason: result.failureReason,
      failureStage: result.failureStage,
      pageFormalSaveCalls: result.pageFormalSaveCalls,
      saveStateCalls,
      successfulSaveCalls
    }, 'single-item-order-result-v1');
    return result;
  } finally {
    runtime.dispose();
  }
}

module.exports = { executeSingleItemOrderCase };
