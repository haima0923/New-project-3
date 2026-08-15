const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { readRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');
const { createFakeWx } = require('../runner/create-fake-wx');
const { installFrozenClock } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { createControlledNetwork } = require('../record-confirm-interaction-v1/controlled-network');
const {
  BUSINESS_DATE,
  NOW_INSTANT,
  TIMEZONE
} = require('../record-confirm-interaction-v1/fixtures');
const {
  editField,
  submitOriginalText
} = require('../record-confirm-interaction-v1/page-actions');
const { createHoldHarness } = require('../record-hold-to-talk-v1/runtime');

const ROOT = path.resolve(__dirname, '../../..');
const INPUT_WXML = path.join(ROOT, 'pages/input/input.wxml');
const ORDER_TEXT = '真机保存测试水杯137个每个5元8月15日交';

function openingTags(source, tagName) {
  const output = [];
  const marker = `<${tagName}`;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    let quote = '';
    let end = start + marker.length;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        output.push(source.slice(start, end + 1));
        end += 1;
        break;
      }
    }
    cursor = Math.max(end, start + marker.length);
  }
  return output;
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`));
  return match ? match[2] : '';
}

function formalSaveWxmlContract() {
  const source = fs.readFileSync(INPUT_WXML, 'utf8');
  const button = openingTags(source, 'button').find((tag) => (
    attr(tag, 'class').split(/\s+/).includes('formal-save-button')
  )) || '';
  return {
    buttonFound: Boolean(button),
    disabledExpression: attr(button, 'disabled'),
    handler: attr(button, 'bindtap'),
    hiddenExpression: attr(button, 'hidden'),
    wxIfExpression: attr(button, 'wx:if')
  };
}

function createDirectHarness(options = {}) {
  const restoreClock = installFrozenClock(NOW_INSTANT, options.caseId || 'record-save-hang-v1');
  const network = createControlledNetwork({ mode: 'SUCCESS', response: {} });
  network.guardHostNetwork();
  const initialState = safeClone(options.initialState || createInitialState());
  const fakeWx = createFakeWx({
    clipboardText: ORDER_TEXT,
    initialEntries: {
      [BUSINESS_STORAGE_KEY]: initialState,
      huoxiaoling_ai_auth_session_v1: {
        token: 'REDACTED_CONTROLLED_TOKEN',
        expiresAt: '2027-08-05T12:00:00.000Z'
      }
    },
    network
  });
  const app = {
    globalData: {
      userId: 'save-hang-contract-user',
      apiBaseUrl: 'memory://record-save-hang',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse',
      aiTranscribeEndpoint: '',
      recordStorageRecoveryLocked: false,
      recordStorageStartupStatus: ''
    }
  };
  global.wx = fakeWx.wx;
  global.getApp = () => app;
  global.requirePlugin = () => null;
  const spec = {
    ai: { profile: 'CONTROLLED_REAL_FIXTURE' },
    caseId: options.caseId || 'record-save-hang-v1',
    clock: { businessDate: BUSINESS_DATE, nowInstant: NOW_INSTANT, timezone: TIMEZONE },
    input: { originalText: ORDER_TEXT },
    initialState: { state: initialState }
  };
  const driver = loadProductionPage('FULL_PAGE', { fakeWx }, spec, {
    instrumentation: options.instrumentation || null,
    runLifecycle: false
  });
  let disposed = false;
  return {
    app,
    driver,
    fakeWx,
    network,
    page: driver.page,
    dispose() {
      if (disposed) return;
      disposed = true;
      network.restoreHostNetwork();
      restoreClock();
      delete global.wx;
      delete global.getApp;
      delete global.requirePlugin;
      delete global.Page;
      delete global.App;
    },
    readState() {
      return fakeWx.getValue(BUSINESS_STORAGE_KEY) || createInitialState();
    }
  };
}

async function prepareExactConfirmation(page) {
  await submitOriginalText(page, ORDER_TEXT);
  return completeExactConfirmation(page);
}

function completeExactConfirmation(page) {
  editField(page, 'customerName', '王总');
  const item = (page.data.confirmItems || [])[0] || {};
  page.updateItemField({
    currentTarget: {
      dataset: {
        field: 'unitPrice',
        index: 0,
        itemKey: item.itemKey || item.confirmationItemKey || ''
      }
    },
    detail: { value: '5' }
  });
  return confirmationIdentity(page);
}

function confirmationIdentity(page) {
  const result = page.data.parseResult || {};
  const context = result.client_confirmation_context || {};
  return {
    confirmationSessionId: String(context.confirmationSessionId || ''),
    draftRevision: String(context.draftRevision || ''),
    operation: String(result.operation || ''),
    originalText: String(result.original_text || ''),
    requestId: String(context.requestId || '')
  };
}

function dispatchFormalSave(page) {
  const contract = formalSaveWxmlContract();
  if (!contract.handler || typeof page[contract.handler] !== 'function') {
    const error = new Error('Real formal save WXML handler is unavailable');
    error.code = 'AUTOMATION_DRIVER_ERROR';
    throw error;
  }
  return page[contract.handler]();
}

function storageSummary(rawState = {}) {
  const orders = Array.isArray(rawState.orders) ? rawState.orders : [];
  const matching = orders.filter((order) => String(order.originalText || '') === ORDER_TEXT);
  const control = readRecordStorageControl(rawState) || {};
  const order = matching[0] || null;
  return {
    allOrderCount: orders.length,
    amount: String(order && order.totalAmount || ''),
    customerIdPresent: Boolean(order && order.customerId),
    dueDate: String(order && order.requiredDeliveryDate || ''),
    itemCount: order && Array.isArray(order.items) ? order.items.length : 0,
    matchingOrderCount: matching.length,
    operationIdPresent: Boolean(order && (order.operationId || order.operation_id)),
    productName: String(order && order.productName || ''),
    quantity: String(order && order.quantity || ''),
    recordIdPresent: Boolean(order && order.id),
    storagePlanIdPresent: Boolean(control.lastCommittedPlanId),
    storageRevision: Number(control.storageRevision || 0),
    storageTransactionIdPresent: Boolean(control.lastCommittedTransactionId),
    unitPrice: String(order && order.unitPrice || '')
  };
}

function pageSaveSummary(page, evidence, rawState, thrownError = null) {
  return {
    businessCalls: Number(evidence.productionBusinessCalls.saveConfirmedDraft || 0),
    errorCode: String(thrownError && (thrownError.code || thrownError.message) || ''),
    lock: page.savingInProgress === true,
    page: {
      conversationPhase: String(page.data.conversationPhase || ''),
      parseResultPresent: Boolean(page.data.parseResult),
      progressDetail: String(page.data.parseProgressDetail || ''),
      progressTitle: String(page.data.parseProgressTitle || ''),
      saving: page.data.saving === true,
      showParseProgress: page.data.showParseProgress === true
    },
    state: storageSummary(rawState),
    storageCalls: Number(evidence.productionStorageCalls.saveState || 0)
  };
}

async function createVoicePrepared(origin, caseId) {
  const harness = createHoldHarness({ caseId, origin });
  const dispatch = origin === 'dashboard'
    ? harness.dispatchHero
    : harness.dispatchTab;
  dispatch('start', harness.touch.touchStart());
  harness.voice.emitStart();
  // A voice final is legal only after the production provider has started and
  // the frozen post-onStart readiness window has elapsed. The former 260 ms
  // helper released a pre-ready gesture and then falsely blamed save flow.
  harness.scheduler.advanceBy(700);
  dispatch('end', harness.touch.touchEnd());
  harness.voice.emitFinal(undefined, ORDER_TEXT);
  const followed = await harness.followInput();
  if (!followed) {
    harness.dispose();
    const error = new Error('Voice final did not navigate to Input');
    error.code = 'AUTOMATION_DRIVER_ERROR';
    throw error;
  }
  const identity = completeExactConfirmation(harness.input.page);
  return { harness, identity };
}

function businessProjection(summary) {
  return {
    amount: summary.state.amount,
    dueDate: summary.state.dueDate,
    itemCount: summary.state.itemCount,
    matchingOrderCount: summary.state.matchingOrderCount,
    productName: summary.state.productName,
    quantity: summary.state.quantity,
    unitPrice: summary.state.unitPrice
  };
}

module.exports = {
  BUSINESS_STORAGE_KEY,
  ORDER_TEXT,
  businessProjection,
  completeExactConfirmation,
  confirmationIdentity,
  createDirectHarness,
  createVoicePrepared,
  dispatchFormalSave,
  formalSaveWxmlContract,
  pageSaveSummary,
  prepareExactConfirmation,
  storageSummary
};
