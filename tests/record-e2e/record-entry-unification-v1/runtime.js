const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { createControlledNetwork } = require('../record-confirm-interaction-v1/controlled-network');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE } = require('../record-confirm-interaction-v1/fixtures');
const { inputEvent, tick, waitForParseIdle } = require('../record-confirm-interaction-v1/page-actions');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../runner/constants');
const { createFakeVoice } = require('../runner/create-fake-voice');
const { createFakeWx } = require('../runner/create-fake-wx');
const { installFrozenClock } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const {
  collectParserObservationSince,
  parserObservationCursor
} = require('../runner/observed-ai-parser');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { VOICE_ORDER_TEXT, multiSuccessResponse } = require('./fixtures');

const DASHBOARD_JS = path.join(ROOT, 'pages/dashboard/dashboard.js');
const DASHBOARD_WXML = path.join(ROOT, 'pages/dashboard/dashboard.wxml');
const INPUT_JS = path.join(ROOT, 'pages/input/input.js');
const SHARED_VOICE = createFakeVoice(VOICE_ORDER_TEXT);
const STATE_KEYS = [
  'customers', 'quotations', 'orders', 'receivables', 'paymentRecords',
  'todos', 'orderProgress', 'pendingNotes', 'aiParseLogs', 'dunningRecords',
  'dunningTemplates'
];

function stateCounts(state = {}) {
  return STATE_KEYS.reduce((output, key) => {
    output[key] = Array.isArray(state[key]) ? state[key].length : 0;
    return output;
  }, {});
}

function diffCounts(before, after) {
  return STATE_KEYS.reduce((output, key) => {
    output[key] = Number(after[key] || 0) - Number(before[key] || 0);
    return output;
  }, {});
}

function allZero(value = {}) {
  return Object.values(value).every((entry) => Number(entry || 0) === 0);
}

function cloneForAudit(value, depth = 0) {
  if (depth > 8) return '<depth-limit>';
  if (typeof value === 'function') return '<function>';
  if (Array.isArray(value)) return value.map((entry) => cloneForAudit(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((output, key) => {
      output[key] = cloneForAudit(value[key], depth + 1);
      return output;
    }, {});
  }
  return value;
}

function localRequireSpecifiers(source) {
  return Array.from(source.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)).map((match) => match[2]);
}

function resolveLocalModule(fromFile, specifier) {
  try {
    return createRequire(fromFile).resolve(specifier);
  } catch (error) {
    return '';
  }
}

function installHandoffObserver() {
  const dashboardSource = fs.readFileSync(DASHBOARD_JS, 'utf8');
  const inputSource = fs.readFileSync(INPUT_JS, 'utf8');
  const dashboardModules = new Set(localRequireSpecifiers(dashboardSource)
    .map((specifier) => resolveLocalModule(DASHBOARD_JS, specifier)).filter(Boolean));
  const inputModules = new Set(localRequireSpecifiers(inputSource)
    .map((specifier) => resolveLocalModule(INPUT_JS, specifier)).filter(Boolean));
  const candidates = new Set(Array.from(dashboardModules).filter((filename) => inputModules.has(filename)));
  const calls = [];
  const rawCalls = [];
  const originals = [];
  const modules = [];
  candidates.forEach((filename) => {
    let exported;
    try {
      exported = require(filename);
    } catch (error) {
      return;
    }
    if (!exported || typeof exported !== 'object') return;
    const exportedFunctionKeys = Object.keys(exported).filter((key) => typeof exported[key] === 'function');
    const hasPublisher = exportedFunctionKeys.some((key) => /publish|offer|create.*handoff|set.*handoff/i.test(key));
    const hasConsumer = exportedFunctionKeys.some((key) => /consume|take.*handoff/i.test(key));
    const handoffModule = /handoff|entry[^/]*transfer|transfer[^/]*entry/i.test(filename);
    if (!handoffModule && !(hasPublisher && hasConsumer)) return;
    const functionKeys = exportedFunctionKeys.filter((key) => (
      typeof exported[key] === 'function'
      && /handoff|publish|consume|invalidate|revoke|transfer|offer/i.test(key)
    ));
    if (!functionKeys.length) return;
    modules.push(path.relative(ROOT, filename));
    functionKeys.forEach((key) => {
      const original = exported[key];
      originals.push({ exported, key, original });
      exported[key] = (...args) => {
        let result;
        let error = null;
        try {
          result = original(...args);
          return result;
        } catch (caught) {
          error = caught;
          throw caught;
        } finally {
          const publishResults = rawCalls.filter((entry) => /publish|offer|create.*handoff|set.*handoff/i.test(entry.key));
          const matchesPublishResultIndices = publishResults.reduce((output, entry, index) => {
            const resultCandidates = [entry.result];
            if (entry.result && typeof entry.result === 'object') {
              resultCandidates.push(entry.result.handle, entry.result.token, entry.result.handoffHandle);
            }
            if (args.some((arg) => resultCandidates.some((candidate) => candidate !== undefined && arg === candidate))) {
              output.push(index);
            }
            return output;
          }, []);
          const recorded = {
            args: cloneForAudit(args),
            error: error ? { code: error.code || '', message: error.message } : null,
            key,
            matchesPublishResultIndices,
            module: path.relative(ROOT, filename),
            result: cloneForAudit(result)
          };
          calls.push(recorded);
          rawCalls.push({ args, key, result });
        }
      };
    });
  });
  return {
    audit() {
      return {
        calls: cloneForAudit(calls),
        modules: modules.slice().sort(),
        publishCalls: cloneForAudit(calls.filter((entry) => /publish|offer|create.*handoff|set.*handoff/i.test(entry.key))),
        consumeCalls: cloneForAudit(calls.filter((entry) => /consume|take.*handoff/i.test(entry.key))),
        invalidateCalls: cloneForAudit(calls.filter((entry) => /invalidate|revoke|clear.*handoff/i.test(entry.key)))
      };
    },
    restore() {
      originals.reverse().forEach(({ exported, key, original }) => { exported[key] = original; });
    }
  };
}

function createNavigationController(wx, mode = 'SUCCESS') {
  const originalSwitchTab = wx.switchTab;
  const events = [];
  wx.switchTab = (payload = {}) => {
    const event = {
      fail: typeof payload.fail === 'function' ? payload.fail : null,
      mode,
      settled: false,
      success: typeof payload.success === 'function' ? payload.success : null,
      type: 'SWITCH_TAB',
      url: String(payload.url || '')
    };
    events.push(event);
    if (mode === 'SUCCESS') {
      event.settled = true;
      if (event.success) event.success({});
    } else if (mode === 'FAIL') {
      event.settled = true;
      if (event.fail) event.fail({ errMsg: 'switchTab:fail controlled navigation failure' });
    } else if (mode === 'THROW') {
      event.settled = true;
      throw Object.assign(new Error('controlled switchTab throw'), { code: 'CONTROLLED_NAVIGATION_THROW' });
    }
  };
  function settle(index, outcome) {
    const event = events[index];
    if (!event) return false;
    event.settled = true;
    if (outcome === 'FAIL') {
      if (event.fail) event.fail({ errMsg: 'switchTab:fail controlled late failure' });
    } else if (event.success) event.success({});
    return true;
  }
  return {
    audit() {
      return events.map((entry) => ({ mode: entry.mode, settled: entry.settled, type: entry.type, url: entry.url }));
    },
    inputEvents() { return events.filter((entry) => entry.url === '/pages/input/input'); },
    restore() { wx.switchTab = originalSwitchTab; },
    settle,
    settleAll(outcome = 'SUCCESS') {
      events.forEach((entry, index) => settle(index, outcome));
    }
  };
}

function extractDashboardBindings() {
  const source = fs.readFileSync(DASHBOARD_WXML, 'utf8');
  const bindingBefore = (marker, tagStart) => {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return '';
    const openIndex = source.lastIndexOf(tagStart, markerIndex);
    if (openIndex < 0) return '';
    const openTag = source.slice(openIndex, source.indexOf('>', openIndex) + 1);
    return (openTag.match(/bindtap="([^"]+)"/) || [])[1] || '';
  };
  const composerSource = Array.from(source.matchAll(/<(?:input|textarea)\b[^>]*>/g))
    .map((match) => match[0])
    .find((tag) => /class="[^"]*composer-input[^"]*"/.test(tag)) || '';
  return {
    composerInput: (composerSource.match(/bindinput="([^"]+)"/) || [])[1] || '',
    composerSubmit: (composerSource.match(/bindconfirm="([^"]+)"/) || [])[1] || '',
    query: bindingBefore('<text>问一句</text>', '<view class="quick-button"'),
    records: bindingBefore('全部记录', '<view class="section-link"'),
    paste: (source.match(/bindtap="(pasteClipboard)"/) || [])[1] || '',
    oldConfirmModalPresent: /wx:if="\{\{parseResult\}\}"[^>]*class="confirm-modal"/.test(source),
    oldDeepBindingPresent: /bindtap="requestDeepReview"/.test(source),
    oldFormalSaveBindingPresent: /bindtap="confirmQuickSave"/.test(source),
    oldPendingSaveBindingPresent: /bindtap="savePendingFromConfirm"/.test(source),
    voiceTouchBindingsPresent: ['startVoice', 'moveVoice', 'stopVoice', 'cancelVoice']
      .every((name) => source.includes(`="${name}"`))
  };
}

async function waitUntil(predicate, label, limit = 240) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return true;
    await tick();
  }
  const error = new Error(`Timed out while waiting for ${label}`);
  error.code = 'CONTRACT_WAIT_TIMEOUT';
  throw error;
}

async function settlePage(page) {
  await tick();
  if (page.data && page.data.parsing === true) await waitForParseIdle(page);
  await tick();
}

function createEntryHarness(options = {}) {
  const restoreClock = installFrozenClock(NOW_INSTANT, options.caseId || 'record-entry-unification-v1');
  const network = createControlledNetwork({
    mode: options.networkMode || 'SUCCESS',
    response: options.response || multiSuccessResponse()
  });
  network.guardHostNetwork();
  const initialState = safeClone(options.initialState || createInitialState());
  const fakeWx = createFakeWx({
    clipboardText: options.clipboardText || '',
    initialEntries: {
      [BUSINESS_STORAGE_KEY]: initialState,
      huoxiaoling_ai_auth_session_v1: {
        token: 'REDACTED_CONTROLLED_TOKEN',
        expiresAt: '2027-08-05T12:00:00.000Z'
      }
    },
    network
  });
  const navigation = createNavigationController(fakeWx.wx, options.navigationMode || 'SUCCESS');
  const app = {
    globalData: {
      userId: 'entry-contract-user',
      apiBaseUrl: 'memory://record-entry-unification',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse',
      aiTranscribeEndpoint: '',
      recordStorageRecoveryLocked: false,
      recordStorageStartupStatus: ''
    }
  };
  global.wx = fakeWx.wx;
  global.getApp = () => app;
  global.requirePlugin = (name) => (name === 'WechatSI' ? SHARED_VOICE.plugin : null);
  const handoffObserver = installHandoffObserver();
  const spec = {
    ai: { profile: 'CONTROLLED_REAL_FIXTURE' },
    caseId: options.caseId || 'record-entry-unification-v1',
    clock: { businessDate: BUSINESS_DATE, nowInstant: NOW_INSTANT, timezone: TIMEZONE },
    input: { originalText: options.text || '' },
    initialState: { state: initialState }
  };
  const dashboard = loadProductionPage('HOME_QUICK', { fakeWx }, spec, { runLifecycle: false });
  const input = loadProductionPage('FULL_PAGE', { fakeWx }, spec, { runLifecycle: false });
  let dashboardShown = false;
  let inputLoaded = false;
  let inputShown = false;
  let disposed = false;

  if (typeof dashboard.page.onShow === 'function') {
    dashboard.page.onShow();
    dashboardShown = true;
  }

  async function showInput(optionsForLoad = {}) {
    if (!inputLoaded && typeof input.page.onLoad === 'function') {
      input.page.onLoad(safeClone(optionsForLoad));
      inputLoaded = true;
    }
    if (typeof input.page.onShow === 'function') input.page.onShow();
    inputShown = true;
    await settlePage(input.page);
    return input.page.data;
  }

  async function followInputNavigation() {
    if (!navigation.inputEvents().length) return { navigated: false };
    if (dashboardShown && typeof dashboard.page.onHide === 'function') dashboard.page.onHide();
    await showInput();
    return { navigated: true };
  }

  function readState() {
    return fakeWx.getValue(BUSINESS_STORAGE_KEY) || createInitialState();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (inputShown && typeof input.page.onUnload === 'function') input.page.onUnload();
      if (dashboardShown && typeof dashboard.page.onUnload === 'function') dashboard.page.onUnload();
    } finally {
      handoffObserver.restore();
      navigation.restore();
      network.restoreHostNetwork();
      restoreClock();
      delete global.wx;
      delete global.getApp;
      delete global.requirePlugin;
      delete global.Page;
      delete global.App;
    }
  }

  return {
    app,
    dashboard,
    dispose,
    fakeWx,
    followInputNavigation,
    handoffObserver,
    input,
    navigation,
    network,
    readState,
    showInput,
    stateBefore: stateCounts(initialState),
    stateSnapshotBefore: safeClone(initialState)
  };
}

async function invokeDashboardSource(harness, source, text) {
  const bindings = extractDashboardBindings();
  const page = harness.dashboard.page;
  const parserCursor = parserObservationCursor();
  const beforeVoiceAudit = SHARED_VOICE.audit();
  const beforeVoiceEventCount = (beforeVoiceAudit.events || []).length;
  let invoked = false;
  if (source === 'typed') {
    if (bindings.composerInput && typeof page[bindings.composerInput] === 'function') {
      page[bindings.composerInput](inputEvent(text));
      invoked = true;
    }
    if (bindings.composerSubmit && typeof page[bindings.composerSubmit] === 'function') {
      page[bindings.composerSubmit]();
      invoked = invoked && true;
    } else invoked = false;
  } else if (source === 'paste') {
    harness.fakeWx.setClipboardText(text);
    if (bindings.paste && typeof page[bindings.paste] === 'function') {
      page[bindings.paste]();
      invoked = true;
    }
  } else if (source === 'voice') {
    if (typeof page.beginVoiceRecognition === 'function') {
      page.beginVoiceRecognition();
      invoked = true;
      const beforeFinal = Number(beforeVoiceAudit.finalCallbackInvocationCount || 0);
      await waitUntil(
        () => Number(SHARED_VOICE.audit().finalCallbackInvocationCount || 0) > beforeFinal,
        'voice final callback'
      );
    }
  }
  await settlePage(page);
  const afterVoiceAudit = SHARED_VOICE.audit();
  const parserObservation = collectParserObservationSince(parserCursor);
  return {
    bindings,
    invoked,
    parserObservation: {
      hybridInvocationCount: parserObservation.hybridInvocations.length,
      rawInvocationCount: parserObservation.rawInvocationCount,
      rootPageMethods: parserObservation.hybridInvocations.map((entry) => (
        entry.callerAction || ''
      )),
      surfaces: parserObservation.hybridInvocations.map((entry) => entry.surface || '')
    },
    voiceGestureCalls: ['startVoice', 'moveVoice', 'stopVoice', 'cancelVoice'].reduce((output, key) => {
      output[key] = Number(harness.dashboard.evidence.pageMethodCalls[key] || 0);
      return output;
    }, {}),
    voiceAudit: Object.assign({}, afterVoiceAudit, {
      events: (afterVoiceAudit.events || []).slice(beforeVoiceEventCount),
      finalCallbackInvocationCount: Number(afterVoiceAudit.finalCallbackInvocationCount || 0)
        - Number(beforeVoiceAudit.finalCallbackInvocationCount || 0),
      partialCallbackInvocationCount: Number(afterVoiceAudit.partialCallbackInvocationCount || 0)
        - Number(beforeVoiceAudit.partialCallbackInvocationCount || 0)
    })
  };
}

async function runDirectInput(text, options = {}) {
  const harness = createEntryHarness(Object.assign({}, options, { text }));
  await harness.showInput();
  const source = String(options.source || 'typed');
  if (source === 'paste') {
    harness.fakeWx.setClipboardText(text);
    harness.input.page.readClipboardToInput();
    await waitUntil(() => String(harness.input.page.data.source || '') === 'paste', 'direct paste capture');
  } else if (source === 'voice') {
    const beforeFinal = Number(SHARED_VOICE.audit().finalCallbackInvocationCount || 0);
    harness.input.page.startVoice();
    await waitUntil(
      () => Number(SHARED_VOICE.audit().finalCallbackInvocationCount || 0) > beforeFinal,
      'direct voice final'
    );
  } else {
    harness.input.page.onTextInput(inputEvent(text));
    harness.input.page.runParse();
  }
  await settlePage(harness.input.page);
  return harness;
}

function routeOf(page) {
  const result = page.data.parseResult || {};
  const route = result.parse_route || {};
  return String(route.client_route || route.semantic_decision || route.decision || '');
}

function normalizeItems(fields = {}) {
  const items = Array.isArray(fields.items) && fields.items.length ? fields.items : [fields];
  return items.filter(Boolean).map((item) => ({
    productName: String(item.productName || ''),
    calculatedAmount: String(item.calculatedAmount || ''),
    dueDate: String(item.dueDate || ''),
    itemKeyPresent: Boolean(item.confirmationItemKey || item.itemKey),
    priceUnit: String(item.priceUnit || ''),
    quantity: String(item.quantity || ''),
    remark: String(item.remark || ''),
    spec: String(item.spec || ''),
    totalAmount: String(item.totalAmount || item.amount || ''),
    unit: String(item.unit || ''),
    unitPrice: String(item.unitPrice || '')
  }));
}

function semanticProjection(page) {
  const result = page && page.data && page.data.parseResult || null;
  if (!result) return null;
  const fields = page.data.fields || result.fields || {};
  const target = page.data.activeQuestion && page.data.activeQuestion.target || {};
  const safety = result.final_parse_safety || {};
  return {
    activeQuestionTarget: {
      field: String(target.field || ''),
      fieldPath: String(target.fieldPath || ''),
      itemKeyPresent: Boolean(target.itemKey)
    },
    amount: String(fields.amount || fields.totalAmount || ''),
    calculatedAmount: String(fields.calculatedAmount || ''),
    blockers: (page.data.preflightBlockingReasons || []).slice().sort(),
    conversationPhase: String(page.data.conversationPhase || ''),
    customerName: String(fields.customerName || ''),
    dueDate: String(fields.dueDate || fields.deliveryDate || ''),
    formalReady: page.data.showFormalSaveButton === true && page.data.disableFormalSave !== true,
    intent: String(result.intent || ''),
    items: normalizeItems(fields),
    low: (result.low_confidence_fields || []).slice().sort(),
    missing: (result.missing_fields || []).slice().sort(),
    operation: String(result.operation || ''),
    originalText: String(result.original_text || result.originalText || ''),
    phone: String(fields.phone || ''),
    route: routeOf(page),
    safetyStatus: String(safety.status || ''),
    safetyRiskCodes: (safety.risk_codes || []).slice().sort(),
    totalAmount: String(fields.totalAmount || fields.amount || '')
  };
}

function dashboardAuthorityEvidence(harness) {
  const page = harness.dashboard.page;
  const evidence = harness.dashboard.evidence;
  return {
    business: safeClone(evidence.productionBusinessCalls),
    deepCalls: Number(evidence.pageMethodCalls.requestDeepReview || 0),
    formalCalls: Number(evidence.pageMethodCalls.confirmQuickSave || 0),
    hasOldModalState: Boolean(page.data.parseResult),
    oldDeepVisible: page.data.showDeepReviewButton === true,
    pendingCalls: Number(evidence.pageMethodCalls.savePendingFromConfirm || 0),
    quickParseCalls: Number(evidence.pageMethodCalls.runQuickParse || 0),
    storageSaveCalls: Number(evidence.productionStorageCalls.saveState || 0)
  };
}

function inputAuthorityEvidence(harness) {
  const evidence = harness.input.evidence;
  return {
    business: safeClone(evidence.productionBusinessCalls),
    runParseCalls: Number(evidence.pageMethodCalls.runParse || 0),
    storageSaveCalls: Number(evidence.productionStorageCalls.saveState || 0)
  };
}

function storageTransferWrites(harness) {
  const audit = harness.fakeWx.audit();
  return (audit.storageEvents || []).filter((entry) => (
    entry.operation === 'SET'
    && entry.key !== 'huoxiaoling_ai_auth_session_v1'
  ));
}

function businessSemanticHash(page) {
  return stableHash(semanticProjection(page), 'record-entry-unification-semantic-v1');
}

module.exports = {
  allZero,
  businessSemanticHash,
  createEntryHarness,
  dashboardAuthorityEvidence,
  diffCounts,
  extractDashboardBindings,
  inputAuthorityEvidence,
  invokeDashboardSource,
  routeOf,
  runDirectInput,
  semanticProjection,
  settlePage,
  stateCounts,
  storageTransferWrites,
  waitUntil
};
