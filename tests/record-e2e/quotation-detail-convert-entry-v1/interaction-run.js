#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getDashboard } = require('../../../utils/business');
const { buildAllRecords } = require('../../../utils/home-workbench');
const { safeClone } = require('../../../utils/record-state-diff');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../runner/constants');
const { invokeConfirm } = require('../quotation-to-order-save-v1/page-actions');
const { loadQuotationPage, loadRecordDetailPage, loadRecordsPage } = require('./page-driver');
const { withContext } = require('./run');

const recordsTemplate = fs.readFileSync(path.join(ROOT, 'pages/records/records.wxml'), 'utf8');
const recordsStyle = fs.readFileSync(path.join(ROOT, 'pages/records/records.wxss'), 'utf8');
const quotationTemplate = fs.readFileSync(path.join(ROOT, 'pages/quotations/quotations.wxml'), 'utf8');

function persistedState(runtime) {
  return runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
}

function quotationRecord(page, quotationId) {
  return page.data.records.find((item) => (
    item.type === 'quotation' && (item.sourceId || item.id) === quotationId
  ));
}

function orderRecord(page, orderId) {
  return page.data.records.find((item) => (
    item.type === 'order' && (item.sourceId || item.id) === orderId
  ));
}

function swipe(page, record, dx) {
  const dataset = {
    id: record.sourceId || record.id,
    key: record.swipeKey,
    type: record.type
  };
  page.recordTouchStart({
    currentTarget: { dataset },
    touches: [{ clientX: 180, clientY: 100 }]
  });
  page.recordTouchEnd({
    changedTouches: [{ clientX: 180 + dx, clientY: 102 }],
    currentTarget: { dataset }
  });
}

function cancelEvent(quotationId) {
  return { currentTarget: { dataset: { id: quotationId, type: 'quotation' } } };
}

function conversionEvent(quotationId) {
  return { currentTarget: { dataset: { id: quotationId } } };
}

function uiEvents(runtime) {
  return runtime.fakeWx.audit().uiEvents;
}

function navigationEvents(runtime) {
  return runtime.fakeWx.audit().navigationEvents;
}

function activeCanceledMutation(state) {
  const quotation = state.quotations[0];
  quotation.status = '已取消';
  quotation.cancelledAt = '2026-07-14T02:00:00.000Z';
  quotation.updatedAt = '2026-07-14T02:00:00.000Z';
}

function assertMethod(page, name) {
  assert.strictEqual(typeof page[name], 'function', `${name} must be a real page method`);
}

function runCase(q2oCaseId, caseId, callback, options) {
  return withContext(q2oCaseId, caseId, callback, options);
}

const cases = [
  {
    caseId: 'REC-E2E-QI-001',
    title: '正常未转报价左滑提供取消报价和转订单',
    run: async () => {
      await runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-001', ({ runtime, testCase }) => {
        const driver = loadRecordsPage(runtime);
        const record = quotationRecord(driver.page, testCase.quotationId);
        assert.ok(record);
        assert.strictEqual(record.canCancelQuotation, true);
        assert.strictEqual(record.canConvertToOrder, true);
        assert.strictEqual(record.canViewConvertedOrder, false);
        assertMethod(driver.page, 'openQuotationConversion');
        driver.page.openQuotationConversion(cancelEvent(testCase.quotationId));
        const navigation = navigationEvents(runtime).slice(-1)[0];
        assert.strictEqual(
          navigation.url,
          `/pages/quotations/quotations?quotationId=${testCase.quotationId}&action=convert`
        );
        assert.strictEqual(driver.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
        assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      });
      for (const sourceCaseId of ['REC-E2E-Q2O-015', 'REC-E2E-Q2O-021']) {
        await runCase(sourceCaseId, 'REC-E2E-QI-001', ({ runtime, testCase }) => {
          const driver = loadRecordsPage(runtime);
          const record = quotationRecord(driver.page, testCase.quotationId);
          assert.strictEqual(record.canCancelQuotation, true);
          assert.strictEqual(record.canConvertToOrder, false);
          assert.strictEqual(record.canViewConvertedOrder, false);
        });
      }
    }
  },
  {
    caseId: 'REC-E2E-QI-002',
    title: '点击取消报价弹出明确二次确认',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-002', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      const modal = uiEvents(runtime).find((item) => item.type === 'MODAL');
      assert.ok(modal);
      assert.strictEqual(modal.title, '确认取消这张报价？');
      assert.strictEqual(modal.content, '取消后会保留报价记录，但不能再转为订单，也不会继续提醒跟进。');
    }, { modalResponse: { confirm: false, cancel: true } })
  },
  {
    caseId: 'REC-E2E-QI-003',
    title: '放弃取消确认时零变化零保存',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-003', ({ runtime, testCase }) => {
      const before = persistedState(runtime);
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.deepStrictEqual(persistedState(runtime), before);
      assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      assert.strictEqual(driver.evidence.productionBusinessCalls.softDeleteRecord, 0);
    }, { modalResponse: { confirm: false, cancel: true } })
  },
  {
    caseId: 'REC-E2E-QI-004',
    title: '确认取消后报价仍保留',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-004', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.ok(persistedState(runtime).quotations.some((item) => item.id === testCase.quotationId));
    })
  },
  {
    caseId: 'REC-E2E-QI-005',
    title: '取消状态和时间准确写入',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-005', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      const quotation = persistedState(runtime).quotations.find((item) => item.id === testCase.quotationId);
      assert.strictEqual(quotation.status, '已取消');
      assert.strictEqual(quotation.cancelledAt, '2026-07-15T02:00:00.000Z');
      assert.strictEqual(quotation.updatedAt, '2026-07-15T02:00:00.000Z');
    })
  },
  {
    caseId: 'REC-E2E-QI-006',
    title: '取消保留原客户商品金额备注和原文',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-006', ({ runtime, testCase }) => {
      const before = safeClone(testCase.initialState.state.quotations[0]);
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      const after = persistedState(runtime).quotations[0];
      ['customerId', 'productName', 'quantity', 'unit', 'unitPrice', 'totalAmount', 'remark', 'originalText', 'items']
        .forEach((field) => assert.deepStrictEqual(after[field], before[field], field));
    })
  },
  {
    caseId: 'REC-E2E-QI-007',
    title: '取消不产生删除墓碑',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-007', ({ runtime, testCase }) => {
      const before = persistedState(runtime).deletedRecords;
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.deepStrictEqual(persistedState(runtime).deletedRecords, before);
      assert.strictEqual(driver.evidence.productionBusinessCalls.softDeleteRecord, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-008',
    title: '取消不创建订单',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-008', ({ runtime, testCase }) => {
      const before = persistedState(runtime).orders;
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.deepStrictEqual(persistedState(runtime).orders, before);
      assert.strictEqual(driver.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-009',
    title: '取消不创建范围外业务记录',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-009', ({ runtime, testCase }) => {
      const before = persistedState(runtime);
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      const after = persistedState(runtime);
      ['customers', 'receivables', 'paymentRecords', 'todos', 'pendingNotes', 'orderProgress']
        .forEach((field) => assert.deepStrictEqual(after[field], before[field], field));
    })
  },
  {
    caseId: 'REC-E2E-QI-010',
    title: '取消只进行一次正式保存',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-010', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.strictEqual(driver.evidence.productionBusinessCalls.cancelQuotation, 1);
      assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 1);
    })
  },
  {
    caseId: 'REC-E2E-QI-011',
    title: '重复取消零新增零保存',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-011', ({ runtime, testCase }) => {
      const first = loadRecordsPage(runtime);
      assertMethod(first.page, 'requestCancelQuotation');
      first.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      const afterFirst = persistedState(runtime);
      const second = loadRecordsPage(runtime);
      assertMethod(second.page, 'requestCancelQuotation');
      second.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.deepStrictEqual(persistedState(runtime), afterFirst);
      assert.strictEqual(second.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-012',
    title: '已取消报价不再显示转订单',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-012', ({ runtime, spec, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      assert.strictEqual(record.status, '已取消');
      assert.strictEqual(record.canCancelQuotation, false);
      assert.strictEqual(record.canConvertToOrder, false);
      assert.strictEqual(record.canViewConvertedOrder, false);
      const quotationPage = loadQuotationPage(runtime, spec, {
        action: 'convert',
        quotationId: testCase.quotationId
      });
      assert.strictEqual(quotationPage.page.data.convertingQuotationId, '');
      assert.strictEqual(quotationPage.evidence.productionBusinessCalls.convertQuotationToOrder, 0);
      assert.strictEqual(quotationPage.evidence.productionStorageCalls.saveState, 0);
    }, { mutateState: activeCanceledMutation })
  },
  {
    caseId: 'REC-E2E-QI-013',
    title: '已取消报价不再进入跟进提醒',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-013', ({ runtime, testCase }) => {
      const state = persistedState(runtime);
      assert.strictEqual(getDashboard(state).quoteFollowups.some((item) => item.id === testCase.quotationId), false);
    }, { mutateState: activeCanceledMutation })
  },
  {
    caseId: 'REC-E2E-QI-014',
    title: '已取消报价仍在报价历史',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-014', ({ runtime, testCase }) => {
      const state = persistedState(runtime);
      assert.ok(state.quotations.some((item) => item.id === testCase.quotationId));
      assert.ok(buildAllRecords(state, 'quotation').some((item) => item.id === testCase.quotationId));
    }, { mutateState: activeCanceledMutation })
  },
  {
    caseId: 'REC-E2E-QI-015',
    title: '已转报价不能取消',
    run: () => runCase('REC-E2E-Q2O-017', 'REC-E2E-QI-015', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      assert.strictEqual(record.canCancelQuotation, false);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-016',
    title: '关系异常报价不能用取消掩盖冲突',
    run: () => runCase('REC-E2E-Q2O-018', 'REC-E2E-QI-016', ({ runtime, testCase }) => {
      const before = persistedState(runtime);
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      assert.strictEqual(record.hasQuotationOrderConflict, true);
      assert.strictEqual(record.canCancelQuotation, false);
      assertMethod(driver.page, 'requestCancelQuotation');
      driver.page.requestCancelQuotation(cancelEvent(testCase.quotationId));
      assert.deepStrictEqual(persistedState(runtime), before);
      assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-017',
    title: '报价只有向左滑才打开操作',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-017', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      swipe(driver.page, record, -90);
      assert.strictEqual(driver.page.data.openSwipeKey, record.swipeKey);
      swipe(driver.page, record, 90);
      assert.strictEqual(driver.page.data.openSwipeKey, '');
    })
  },
  {
    caseId: 'REC-E2E-QI-018',
    title: '报价操作区位于卡片右侧',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-018', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      swipe(driver.page, record, -90);
      assert.strictEqual(driver.page.data.openSwipeKey, record.swipeKey);
      assert.match(recordsTemplate, /record-swipe-actions-quotation/);
      assert.match(recordsStyle, /record-swipe-actions-quotation[\s\S]*right:\s*0/);
    })
  },
  {
    caseId: 'REC-E2E-QI-019',
    title: '报价卡片向左移动',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-019', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      swipe(driver.page, record, -90);
      assert.strictEqual(driver.page.data.openSwipeKey, record.swipeKey);
      assert.match(recordsStyle, /record-card-swiped-quotation[\s\S]*translateX\(-/);
    })
  },
  {
    caseId: 'REC-E2E-QI-020',
    title: '报价侧滑不再出现删除',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-020', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      swipe(driver.page, record, -90);
      assert.strictEqual(driver.evidence.productionBusinessCalls.softDeleteRecord, 0);
      assert.match(recordsTemplate, /wx:if="\{\{item\.type === 'quotation'/);
      assert.match(recordsTemplate, /wx:else[\s\S]*catchtap="deleteRecord"/);
    })
  },
  {
    caseId: 'REC-E2E-QI-021',
    title: '已转报价只提供查看订单',
    run: () => runCase('REC-E2E-Q2O-017', 'REC-E2E-QI-021', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      assert.strictEqual(record.canCancelQuotation, false);
      assert.strictEqual(record.canConvertToOrder, false);
      assert.strictEqual(record.canViewConvertedOrder, true);
      assert.strictEqual(record.relatedOrderId, 'q2o-order-existing');
    })
  },
  {
    caseId: 'REC-E2E-QI-022',
    title: '查看订单打开准确关联订单',
    run: () => runCase('REC-E2E-Q2O-017', 'REC-E2E-QI-022', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      assertMethod(driver.page, 'openQuotationOrder');
      driver.page.openQuotationOrder(cancelEvent(testCase.quotationId));
      const navigation = navigationEvents(runtime).slice(-1)[0];
      assert.strictEqual(navigation.type, 'NAVIGATE_TO');
      assert.strictEqual(navigation.url, '/pages/record-detail/record-detail?type=order&id=q2o-order-existing');
    })
  },
  {
    caseId: 'REC-E2E-QI-023',
    title: '已取消报价没有危险操作',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-023', ({ runtime, testCase }) => {
      const driver = loadRecordsPage(runtime);
      const record = quotationRecord(driver.page, testCase.quotationId);
      assert.strictEqual(record.hasQuotationSwipeActions, false);
      swipe(driver.page, record, -90);
      assert.strictEqual(driver.page.data.openSwipeKey, '');
    }, { mutateState: activeCanceledMutation })
  },
  {
    caseId: 'REC-E2E-QI-024',
    title: '报价筛选后每张卡片 swipeKey 稳定唯一',
    run: () => runCase('REC-E2E-Q2O-014', 'REC-E2E-QI-024', ({ runtime }) => {
      const driver = loadRecordsPage(runtime);
      driver.page.setFilter('quotation');
      const keys = driver.page.data.records.map((item) => item.swipeKey);
      assert.strictEqual(keys.length, 2);
      assert.strictEqual(new Set(keys).size, 2);
      assert.ok(keys.every((key) => /^quotation:/.test(key)));
      const firstKeys = keys.slice();
      driver.page.setFilter('quotation');
      assert.deepStrictEqual(driver.page.data.records.map((item) => item.swipeKey), firstKeys);
    })
  },
  {
    caseId: 'REC-E2E-QI-025',
    title: '其他记录类型保持原右滑和删除行为',
    run: () => runCase('REC-E2E-Q2O-017', 'REC-E2E-QI-025', ({ runtime }) => {
      const driver = loadRecordsPage(runtime);
      const record = orderRecord(driver.page, 'q2o-order-existing');
      assert.ok(record);
      swipe(driver.page, record, 90);
      assert.strictEqual(driver.page.data.openSwipeKey, record.swipeKey);
      swipe(driver.page, record, -90);
      assert.strictEqual(driver.page.data.openSwipeKey, '');
      assertMethod(driver.page, 'deleteRecord');
      assert.match(recordsTemplate, /wx:else[\s\S]*catchtap="deleteRecord"/);
    })
  },
  {
    caseId: 'REC-E2E-QI-026',
    title: '详情入口只自动调用一次 startConvert',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-026', ({ runtime, spec, testCase }) => {
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assert.strictEqual(driver.evidence.pageMethodCalls.startConvert, 1);
      assert.strictEqual(driver.page.data.convertingQuotationId, testCase.quotationId);
    })
  },
  {
    caseId: 'REC-E2E-QI-027',
    title: '目标报价不在第一项时仍正确聚焦',
    run: () => runCase('REC-E2E-Q2O-014', 'REC-E2E-QI-027', ({ runtime, spec }) => {
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: 'q2o-quote-b' });
      assert.strictEqual(driver.page.data.convertingQuotationId, 'q2o-quote-b');
      assert.strictEqual(driver.page.data.quotations[0].id, 'q2o-quote-b');
      assert.strictEqual(driver.page.data.quotations.length, 1);
    })
  },
  {
    caseId: 'REC-E2E-QI-028',
    title: '进入转换页后日期选择立即可见',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-028', ({ runtime, spec, testCase }) => {
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assert.ok(Array.isArray(driver.page.data.conversionDateOptions));
      assert.ok(driver.page.data.conversionDateOptions.length >= 30);
      assert.match(quotationTemplate, /conversion-date-options/);
    })
  },
  {
    caseId: 'REC-E2E-QI-029',
    title: '日期选择不需要第二次点击转订单',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-029', ({ runtime, spec, testCase }) => {
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assertMethod(driver.page, 'selectConversionDeliveryDate');
      driver.page.selectConversionDeliveryDate(conversionEvent(testCase.deliveryDate));
      assert.strictEqual(driver.page.data.conversionDeliveryDate, testCase.deliveryDate);
      assert.strictEqual(driver.evidence.pageMethodCalls.startConvert, 1);
    })
  },
  {
    caseId: 'REC-E2E-QI-030',
    title: '交期选择不再依赖需要再次点击的原生 picker',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-030', ({ runtime, spec, testCase }) => {
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assert.strictEqual(driver.page.data.convertingQuotationId, testCase.quotationId);
      assert.doesNotMatch(quotationTemplate, /<picker mode="date" value="\{\{conversionDeliveryDate\}\}"/);
      assert.match(quotationTemplate, /bindtap="selectConversionDeliveryDate"/);
    })
  },
  {
    caseId: 'REC-E2E-QI-031',
    title: '取消交期零新增零保存并返回详情',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-031', ({ runtime, spec, testCase }) => {
      const before = persistedState(runtime);
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assertMethod(driver.page, 'cancelConversionFlow');
      driver.page.cancelConversionFlow();
      assert.deepStrictEqual(persistedState(runtime), before);
      assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 0);
      assert.strictEqual(driver.evidence.navigationBackEvents.length, 1);
    })
  },
  {
    caseId: 'REC-E2E-QI-032',
    title: '确认转单只生成一张订单',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-032', ({ runtime, spec, testCase }) => {
      const beforeCount = persistedState(runtime).orders.length;
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assertMethod(driver.page, 'selectConversionDeliveryDate');
      driver.page.selectConversionDeliveryDate(conversionEvent(testCase.deliveryDate));
      invokeConfirm(driver, testCase.quotationId);
      assert.strictEqual(persistedState(runtime).orders.length, beforeCount + 1);
      assert.strictEqual(driver.evidence.productionStorageCalls.saveState, 1);
      assert.strictEqual(driver.evidence.navigationBackEvents.length, 1);
    })
  },
  {
    caseId: 'REC-E2E-QI-033',
    title: '转换返回详情后显示查看订单',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-033', ({ runtime, spec, testCase }) => {
      const detail = loadRecordDetailPage(runtime, { id: testCase.quotationId, type: 'quotation' });
      const driver = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assertMethod(driver.page, 'selectConversionDeliveryDate');
      driver.page.selectConversionDeliveryDate(conversionEvent(testCase.deliveryDate));
      invokeConfirm(driver, testCase.quotationId);
      detail.page.onShow();
      assert.strictEqual(detail.page.data.detail.canConvertToOrder, false);
      assert.strictEqual(detail.page.data.detail.canViewConvertedOrder, true);
      assert.ok(detail.page.data.detail.relatedOrderId);
    })
  },
  {
    caseId: 'REC-E2E-QI-034',
    title: '重复操作仍只有同一张来源订单',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-034', ({ runtime, spec, testCase }) => {
      const first = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assertMethod(first.page, 'selectConversionDeliveryDate');
      first.page.selectConversionDeliveryDate(conversionEvent(testCase.deliveryDate));
      invokeConfirm(first, testCase.quotationId);
      const orderId = persistedState(runtime).quotations[0].convertedOrderId;
      const count = persistedState(runtime).orders.length;
      const second = loadQuotationPage(runtime, spec, { action: 'convert', quotationId: testCase.quotationId });
      assert.strictEqual(second.page.data.convertingQuotationId, '');
      assert.strictEqual(persistedState(runtime).orders.length, count);
      assert.strictEqual(persistedState(runtime).quotations[0].convertedOrderId, orderId);
      assert.strictEqual(second.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-035',
    title: '详情页不直接调用 saveState',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-035', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, { id: testCase.quotationId, type: 'quotation' });
      detail.page.openQuotationConversion();
      assert.strictEqual(detail.evidence.productionStorageCalls.saveState, 0);
    })
  },
  {
    caseId: 'REC-E2E-QI-036',
    title: '详情页不直接调用 convertQuotationToOrder',
    run: () => runCase('REC-E2E-Q2O-001', 'REC-E2E-QI-036', ({ runtime, testCase }) => {
      const detail = loadRecordDetailPage(runtime, { id: testCase.quotationId, type: 'quotation' });
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
  console.log('Cluster: quotation-real-entry-interactions-v1');
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

module.exports = { cases, main, parseArgs, runAttempt };
