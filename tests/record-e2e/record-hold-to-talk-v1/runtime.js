const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { createInitialState } = require('../../../utils/storage');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');
const { createFakeWx } = require('../runner/create-fake-wx');
const { installFrozenClock } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const {
  collectParserObservationSince,
  parserObservationCursor
} = require('../runner/observed-ai-parser');
const { createControlledNetwork } = require('../record-confirm-interaction-v1/controlled-network');
const {
  BUSINESS_DATE,
  NOW_INSTANT,
  TIMEZONE
} = require('../record-confirm-interaction-v1/fixtures');
const { createVirtualScheduler, touchCancel, touchEnd, touchMove, touchStart } = require('./gesture-runtime');
const { extractVoiceBindings, loadCustomTabComponent } = require('./tab-runtime');
const { createControlledVoiceManager, createPermissionController } = require('./voice-runtime');

const HANDOFF_PATH = require.resolve('../../../utils/record-entry-handoff');
const VOICE_PATH = require.resolve('../../../utils/voice-recognition');
const DASHBOARD_PATH = require.resolve('../../../pages/dashboard/dashboard.js');
const TAB_PATH = require.resolve('../../../custom-tab-bar/index.js');

function holdControllerCandidates() {
  const files = [DASHBOARD_PATH, TAB_PATH];
  const candidates = new Set();
  files.forEach((filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const localRequire = createRequire(filename);
    Array.from(source.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)).forEach((match) => {
      try {
        const resolved = localRequire.resolve(match[2]);
        if (/hold[-_]?to[-_]?talk|voice[-_]?gesture|voice[-_]?capture|voice[-_]?controller/i.test(path.basename(resolved))) {
          candidates.add(resolved);
        }
      } catch (error) {
        // A missing future optional controller is not a runner error on the current baseline.
      }
    });
  });
  const recommended = path.join(path.dirname(VOICE_PATH), 'hold-to-talk-controller.js');
  if (fs.existsSync(recommended)) candidates.add(require.resolve(recommended));
  return Array.from(candidates);
}

function purgeHoldControllerCache() {
  holdControllerCandidates().forEach((filename) => { delete require.cache[filename]; });
}

function flushAsync(rounds = 8) {
  let chain = Promise.resolve();
  for (let index = 0; index < rounds; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

async function settlePage(page, rounds = 40) {
  for (let index = 0; index < rounds; index += 1) {
    await flushAsync(1);
    if (!page.data || page.data.parsing !== true) {
      await flushAsync(2);
      return;
    }
  }
  const error = new Error('Input page parse did not settle');
  error.code = 'CONTRACT_WAIT_TIMEOUT';
  throw error;
}

function stateFingerprint(fakeWx) {
  return stableHash(fakeWx.getValue(BUSINESS_STORAGE_KEY) || {}, 'hold-state-v1');
}

function routeOf(result = {}) {
  const route = result.parse_route || {};
  return String(route.client_route || route.semantic_decision || route.decision || '');
}

function normalizeItems(fields = {}) {
  const items = Array.isArray(fields.items) && fields.items.length ? fields.items : [fields];
  return items.filter(Boolean).map((item) => ({
    amount: String(item.totalAmount || item.amount || ''),
    dueDate: String(item.dueDate || ''),
    priceUnit: String(item.priceUnit || ''),
    productName: String(item.productName || ''),
    quantity: String(item.quantity || ''),
    spec: String(item.spec || ''),
    unit: String(item.unit || ''),
    unitPrice: String(item.unitPrice || '')
  }));
}

function installHandoffObserver() {
  const handoff = require(HANDOFF_PATH);
  while (handoff.hasPendingRecordEntryHandoff()) handoff.consumeRecordEntryHandoff();
  const calls = [];
  const originals = {};
  Object.keys(handoff).forEach((key) => {
    if (typeof handoff[key] !== 'function') return;
    originals[key] = handoff[key];
    handoff[key] = (...args) => {
      const result = originals[key](...args);
      calls.push({ key, args, result });
      return result;
    };
  });
  return {
    audit() {
      const select = (pattern) => calls.filter((entry) => pattern.test(entry.key));
      const publishEntries = select(/publish/i);
      const consumeEntries = select(/consume/i);
      const publishedEvidence = publishEntries[0]
        && publishEntries[0].args[0]
        && publishEntries[0].args[0].voiceCompletionEvidence;
      const consumedEvidence = consumeEntries[0]
        && consumeEntries[0].result
        && consumeEntries[0].result.voiceCompletionEvidence;
      return {
        consumeCount: consumeEntries.length,
        consumeEvidenceAudit: {
          aliasesPublishInput: Boolean(consumedEvidence && consumedEvidence === publishedEvidence),
          frozen: Boolean(consumedEvidence && Object.isFrozen(consumedEvidence))
        },
        consumePayloads: consumeEntries.map((entry) => safeClone(entry.result || null)),
        invalidateCount: select(/invalidate/i).length,
        publishCount: publishEntries.length,
        publishPayloads: publishEntries.map((entry) => safeClone(entry.args[0] || {}))
      };
    },
    restore() {
      Object.keys(originals).forEach((key) => { handoff[key] = originals[key]; });
      while (handoff.hasPendingRecordEntryHandoff()) handoff.consumeRecordEntryHandoff();
    }
  };
}

function createNavigationController(wx, getPages) {
  const original = wx.switchTab;
  const events = [];
  wx.switchTab = (payload = {}) => {
    const event = { type: 'SWITCH_TAB', url: String(payload.url || '') };
    events.push(event);
    if (event.url === '/pages/dashboard/dashboard') getPages().activateDashboard();
    if (typeof payload.success === 'function') payload.success({});
  };
  return {
    audit() { return safeClone(events); },
    restore() { wx.switchTab = original; }
  };
}

function createHoldHarness(options = {}) {
  const restoreClock = installFrozenClock(NOW_INSTANT, options.caseId || 'record-hold-to-talk-v1');
  const scheduler = createVirtualScheduler();
  const initialState = createInitialState();
  const network = createControlledNetwork({ mode: 'SUCCESS', response: {} });
  network.guardHostNetwork();
  const fakeWx = createFakeWx({
    clipboardText: options.clipboardText || '',
    initialEntries: {
      [BUSINESS_STORAGE_KEY]: safeClone(initialState),
      huoxiaoling_ai_auth_session_v1: {
        token: 'REDACTED_CONTROLLED_TOKEN',
        expiresAt: '2027-08-05T12:00:00.000Z'
      }
    },
    network
  });
  const permission = createPermissionController(fakeWx.wx, options.permissionMode || 'GRANTED');
  const voice = createControlledVoiceManager();
  const app = {
    globalData: {
      userId: 'hold-contract-user',
      apiBaseUrl: 'memory://record-hold-to-talk',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse',
      aiTranscribeEndpoint: '',
      recordStorageRecoveryLocked: false,
      recordStorageStartupStatus: ''
    }
  };
  let dashboardShown = false;
  let inputLoaded = false;
  let inputShown = false;
  let currentPage = null;
  let disposed = false;

  global.wx = fakeWx.wx;
  global.getApp = () => app;
  global.requirePlugin = (name) => (name === 'WechatSI' ? voice.plugin : null);
  delete require.cache[VOICE_PATH];
  purgeHoldControllerCache();
  const handoffObserver = installHandoffObserver();
  const spec = {
    ai: { profile: 'CONTROLLED_REAL_FIXTURE' },
    caseId: options.caseId || 'record-hold-to-talk-v1',
    clock: { businessDate: BUSINESS_DATE, nowInstant: NOW_INSTANT, timezone: TIMEZONE },
    input: { originalText: options.text || '' },
    initialState: { state: initialState }
  };
  const dashboard = loadProductionPage('HOME_QUICK', { fakeWx }, spec, { runLifecycle: false });
  const input = loadProductionPage('FULL_PAGE', { fakeWx }, spec, { runLifecycle: false });
  dashboard.page.route = 'pages/dashboard/dashboard';
  input.page.route = 'pages/input/input';
  const recordsPage = { route: 'pages/records/records' };

  function showDashboard() {
    currentPage = dashboard.page;
    if (!dashboardShown && typeof dashboard.page.onShow === 'function') {
      dashboard.page.onShow();
      dashboardShown = true;
    }
  }

  function setOrigin(origin) {
    if (origin === 'dashboard') showDashboard();
    else currentPage = recordsPage;
  }
  setOrigin(options.origin || 'dashboard');
  global.getCurrentPages = () => [currentPage].filter(Boolean);

  const navigation = createNavigationController(fakeWx.wx, () => ({
    activateDashboard: showDashboard
  }));
  const tab = loadCustomTabComponent(fakeWx);
  const bindings = extractVoiceBindings();
  const parserCursor = parserObservationCursor();
  const stateBeforeHash = stateFingerprint(fakeWx);

  function dispatchHero(kind, event) {
    const handler = bindings.dashboard[kind];
    if (!handler || typeof dashboard.page[handler] !== 'function') {
      const error = new Error(`Dashboard WXML handler missing for ${kind}`);
      error.code = 'AUTOMATION_DRIVER_ERROR';
      throw error;
    }
    return dashboard.page[handler](event);
  }

  function dispatchTab(kind, event) {
    const handler = bindings.tab[kind];
    if (!handler || typeof tab[handler] !== 'function') {
      const error = new Error(`Custom tab WXML handler missing for ${kind}`);
      error.code = 'AUTOMATION_DRIVER_ERROR';
      throw error;
    }
    return tab[handler](event);
  }

  async function followInput() {
    const hasInputNavigation = navigation.audit().some((event) => event.url === '/pages/input/input');
    if (!hasInputNavigation) return false;
    if (currentPage === dashboard.page && typeof dashboard.page.onHide === 'function') {
      dashboard.page.onHide();
      dashboardShown = false;
    }
    currentPage = input.page;
    if (!inputLoaded && typeof input.page.onLoad === 'function') {
      input.page.onLoad({});
      inputLoaded = true;
    }
    if (typeof input.page.onShow === 'function') input.page.onShow();
    inputShown = true;
    await settlePage(input.page);
    return true;
  }

  function voiceAudit() {
    const voiceModule = require(VOICE_PATH);
    return {
      manager: voice.audit(),
      session: safeClone(voiceModule.getVoiceRecognitionAudit())
    };
  }

  function audit() {
    const parser = collectParserObservationSince(parserCursor);
    const wxAudit = fakeWx.audit();
    const parseResult = input.page.data.parseResult || {};
    const fields = input.page.data.fields || parseResult.fields || {};
    const safety = parseResult.final_parse_safety || {};
    return {
      bindings: safeClone(bindings),
      businessMutation: stateBeforeHash !== stateFingerprint(fakeWx),
      dashboardAuthority: {
        deep: Number(dashboard.evidence.pageMethodCalls.requestDeepReview || 0),
        formal: Number(dashboard.evidence.pageMethodCalls.confirmQuickSave || 0),
        pending: Number(dashboard.evidence.pageMethodCalls.savePendingFromConfirm || 0),
        quickParse: Number(dashboard.evidence.pageMethodCalls.runQuickParse || 0),
        saveConfirmed: Number(dashboard.evidence.productionBusinessCalls.saveConfirmedDraft || 0),
        savePending: Number(dashboard.evidence.productionBusinessCalls.savePendingNote || 0),
        saveState: Number(dashboard.evidence.productionStorageCalls.saveState || 0)
      },
      handoff: handoffObserver.audit(),
      input: {
        activeQuestionField: String(input.page.data.activeQuestion && input.page.data.activeQuestion.target && input.page.data.activeQuestion.target.field || ''),
        amount: String(fields.amount || fields.totalAmount || ''),
        blockers: (input.page.data.preflightBlockingReasons || []).slice().sort(),
        conversationPhase: String(input.page.data.conversationPhase || ''),
        customerName: String(fields.customerName || ''),
        dueDate: String(fields.dueDate || fields.deliveryDate || ''),
        formalReady: input.page.data.showFormalSaveButton === true
          && input.page.data.disableFormalSave !== true,
        intent: String(parseResult.intent || ''),
        items: normalizeItems(fields),
        low: (parseResult.low_confidence_fields || []).slice().sort(),
        missing: (parseResult.missing_fields || []).slice().sort(),
        operation: String(parseResult.operation || ''),
        originalText: String(input.page.data.parseResult && input.page.data.parseResult.original_text || ''),
        route: routeOf(parseResult),
        runParseCount: Number(input.evidence.pageMethodCalls.runParse || 0),
        safetyRiskCodes: (safety.risk_codes || []).slice().sort(),
        safetyStatus: String(safety.status || ''),
        source: String(input.page.data.source || ''),
        text: String(input.page.data.text || ''),
        writerCalls: {
          saveConfirmed: Number(input.evidence.productionBusinessCalls.saveConfirmedDraft || 0),
          savePending: Number(input.evidence.productionBusinessCalls.savePendingNote || 0),
          saveState: Number(input.evidence.productionStorageCalls.saveState || 0)
        }
      },
      navigation: navigation.audit(),
      parser: {
        hybridCount: parser.hybridInvocations.length,
        surfaces: parser.hybridInvocations.map((entry) => String(entry.surface || '')),
        sources: parser.hybridInvocations.map((entry) => String(entry.payload && entry.payload.source || '')),
        voiceInputEvidence: parser.hybridInvocations.map((entry) => safeClone(entry.voiceInputEvidence || {}))
      },
      storageMutations: (wxAudit.storageEvents || []).filter((event) => (
        ['SET', 'REMOVE'].includes(event.operation)
        && event.key !== 'huoxiaoling_ai_auth_session_v1'
      )),
      ui: wxAudit.uiEvents || [],
      voice: voiceAudit()
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (inputShown && typeof input.page.onUnload === 'function') input.page.onUnload();
      if (dashboardShown && typeof dashboard.page.onUnload === 'function') dashboard.page.onUnload();
      tab.__detach();
    } finally {
      handoffObserver.restore();
      navigation.restore();
      permission.restore();
      network.restoreHostNetwork();
      scheduler.restore();
      restoreClock();
      delete require.cache[VOICE_PATH];
      purgeHoldControllerCache();
      delete global.wx;
      delete global.getApp;
      delete global.getCurrentPages;
      delete global.requirePlugin;
    }
  }

  return {
    app,
    audit,
    bindings,
    dashboard,
    dispatchHero,
    dispatchTab,
    dispose,
    fakeWx,
    followInput,
    input,
    navigation,
    permission,
    scheduler,
    settlePage,
    tab,
    touch: { touchCancel, touchEnd, touchMove, touchStart },
    voice
  };
}

module.exports = {
  createHoldHarness,
  flushAsync,
  settlePage,
  stateFingerprint
};
