const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../runner/constants');
const { createFakeWx } = require('../runner/create-fake-wx');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { createVirtualScheduler, point, touchEnd, touchMove, touchStart } = require('./gesture-runtime');
const {
  createControlledRecorderManager,
  createLegacyWechatSiManager,
  createPermissionController
} = require('./recorder-runtime');

const DASHBOARD_JS = path.join(ROOT, 'pages/dashboard/dashboard.js');
const DASHBOARD_WXML = path.join(ROOT, 'pages/dashboard/dashboard.wxml');
const TAB_JS = path.join(ROOT, 'custom-tab-bar/index.js');
const TAB_WXML = path.join(ROOT, 'custom-tab-bar/index.wxml');
const HANDOFF_PATH = path.join(ROOT, 'utils/record-entry-handoff.js');
const CONTROLLER_PATH = path.join(ROOT, 'utils/hold-to-talk-controller.js');
const VOICE_PATH = path.join(ROOT, 'utils/voice-recognition.js');

function attributesOfTag(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = source.lastIndexOf('<', markerIndex);
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if ((character === '"' || character === "'") && source[index - 1] !== '\\') {
      quote = quote === character ? '' : (quote || character);
    }
    if (character === '>' && !quote) return source.slice(start, index + 1);
  }
  return '';
}

function binding(tag, attribute) {
  const match = tag.match(new RegExp(`${attribute}=["']([^"']+)["']`));
  return match ? match[1] : '';
}

function extractBindings() {
  const dashboardSource = fs.readFileSync(DASHBOARD_WXML, 'utf8');
  const tabSource = fs.readFileSync(TAB_WXML, 'utf8');
  const heroTag = attributesOfTag(dashboardSource, 'class="hero-wave ');
  const tabTag = attributesOfTag(tabSource, 'class="tab-item tab-item-center');
  const read = (tag) => ({
    cancel: binding(tag, 'bindtouchcancel'),
    end: binding(tag, 'bindtouchend'),
    move: binding(tag, 'bindtouchmove'),
    start: binding(tag, 'bindtouchstart')
  });
  return { hero: read(heroTag), tab: read(tabTag) };
}

function loadCustomTab(fakeWx) {
  const source = fs.readFileSync(TAB_JS, 'utf8');
  const componentRequire = createRequire(TAB_JS);
  let definition = null;
  vm.runInNewContext(source, {
    Array,
    Boolean,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    clearInterval,
    clearTimeout,
    console,
    Component(value) { definition = value; },
    getCurrentPages: global.getCurrentPages,
    require: componentRequire,
    setInterval,
    setTimeout,
    wx: fakeWx.wx
  }, { filename: TAB_JS });
  if (!definition) throw Object.assign(new Error('Custom tab Component not captured'), {
    code: 'AUTOMATION_DRIVER_ERROR'
  });
  const component = {
    data: safeClone(definition.data || {}),
    setData(patch, callback) {
      Object.assign(this.data, patch || {});
      if (typeof callback === 'function') callback.call(this);
    }
  };
  Object.keys(definition.methods || {}).forEach((key) => {
    component[key] = (...args) => definition.methods[key].apply(component, args);
  });
  component.__attach = () => {
    const method = definition.lifetimes && definition.lifetimes.attached;
    if (typeof method === 'function') method.call(component);
  };
  component.__detach = () => {
    const method = definition.lifetimes && definition.lifetimes.detached;
    if (typeof method === 'function') method.call(component);
  };
  component.__pageHide = () => {
    const method = definition.pageLifetimes && definition.pageLifetimes.hide;
    if (typeof method === 'function') method.call(component);
  };
  component.__attach();
  return component;
}

function installHandoffObserver() {
  if (!fs.existsSync(HANDOFF_PATH)) return {
    audit: () => ({ publishCount: 0, payloads: [] }),
    restore() {}
  };
  const handoff = require(HANDOFF_PATH);
  if (typeof handoff.hasPendingRecordEntryHandoff === 'function'
    && typeof handoff.consumeRecordEntryHandoff === 'function') {
    while (handoff.hasPendingRecordEntryHandoff()) handoff.consumeRecordEntryHandoff();
  }
  const originals = {};
  const calls = [];
  Object.keys(handoff).forEach((key) => {
    if (typeof handoff[key] !== 'function') return;
    originals[key] = handoff[key];
    handoff[key] = (...args) => {
      const result = originals[key](...args);
      calls.push({ args, key, result });
      return result;
    };
  });
  return {
    audit() {
      const publish = calls.filter((entry) => /publish/i.test(entry.key));
      return {
        payloads: publish.map((entry) => safeClone(entry.args[0] || {})),
        publishCount: publish.length
      };
    },
    restore() {
      Object.keys(originals).forEach((key) => { handoff[key] = originals[key]; });
      if (typeof handoff.hasPendingRecordEntryHandoff === 'function'
        && typeof handoff.consumeRecordEntryHandoff === 'function') {
        while (handoff.hasPendingRecordEntryHandoff()) handoff.consumeRecordEntryHandoff();
      }
    }
  };
}

function controllerState() {
  if (!fs.existsSync(CONTROLLER_PATH)) return { phase: 'UNAVAILABLE' };
  try {
    const controller = require(CONTROLLER_PATH);
    return typeof controller.getHoldToTalkState === 'function'
      ? safeClone(controller.getHoldToTalkState())
      : { phase: 'UNAVAILABLE' };
  } catch (error) {
    return { phase: 'UNAVAILABLE' };
  }
}

function purgeVoiceModules() {
  [CONTROLLER_PATH, VOICE_PATH].forEach((filename) => {
    try { delete require.cache[require.resolve(filename)]; } catch (error) { /* optional */ }
  });
}

function createVcapHarness(options = {}) {
  const scheduler = createVirtualScheduler();
  const recorder = createControlledRecorderManager();
  const legacyVoice = createLegacyWechatSiManager();
  const initialState = createInitialState();
  const fakeWx = createFakeWx({
    initialEntries: { [BUSINESS_STORAGE_KEY]: safeClone(initialState) },
    network: { request() { throw Object.assign(new Error('Network forbidden in VCAP'), {
      code: 'UNEXPECTED_NETWORK'
    }); } }
  });
  const permission = createPermissionController(fakeWx.wx, options.permissionMode || 'GRANTED');
  const vibrationEvents = [];
  fakeWx.wx.getRecorderManager = () => recorder.manager;
  fakeWx.wx.vibrateShort = (payload = {}) => {
    vibrationEvents.push({ type: String(payload.type || '') });
    if (typeof payload.success === 'function') payload.success({});
  };
  const app = { globalData: { userId: 'vcap-contract-user', apiBaseUrl: 'memory://vcap' } };
  let currentPage = null;
  global.wx = fakeWx.wx;
  global.getApp = () => app;
  global.requirePlugin = () => legacyVoice.plugin;
  global.getCurrentPages = () => [currentPage].filter(Boolean);
  purgeVoiceModules();
  const handoff = installHandoffObserver();
  const spec = {
    ai: { profile: 'LOCAL_ONLY' },
    caseId: options.caseId || 'VCAP',
    clock: {
      businessDate: '2026-08-10',
      nowInstant: '2026-08-10T12:00:00.000Z',
      timezone: 'Asia/Shanghai'
    },
    input: { originalText: '' },
    initialState: { state: initialState }
  };
  const dashboard = loadProductionPage('HOME_QUICK', { fakeWx }, spec, { runLifecycle: false });
  dashboard.page.route = 'pages/dashboard/dashboard';
  const recordsPage = { route: 'pages/records/records' };
  currentPage = options.origin === 'records' ? recordsPage : dashboard.page;
  const tab = loadCustomTab(fakeWx);
  const bindings = extractBindings();
  const stateBefore = stableHash(fakeWx.getValue(BUSINESS_STORAGE_KEY) || {}, 'vcap-state-before');

  function dispatch(surface, kind, event) {
    const target = surface === 'tab' ? tab : dashboard.page;
    const method = bindings[surface][kind];
    if (!method || typeof target[method] !== 'function') {
      throw Object.assign(new Error(`${surface}.${kind} WXML handler missing`), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    return target[method](event);
  }

  function audit() {
    const wxAudit = fakeWx.audit();
    const businessAfter = stableHash(fakeWx.getValue(BUSINESS_STORAGE_KEY) || {}, 'vcap-state-before');
    const recorderAudit = recorder.audit();
    return {
      businessMutation: stateBefore !== businessAfter,
      controller: controllerState(),
      dashboardCalls: {
        deep: Number(dashboard.evidence.pageMethodCalls.requestDeepReview || 0),
        formal: Number(dashboard.evidence.pageMethodCalls.confirmQuickSave || 0),
        pending: Number(dashboard.evidence.pageMethodCalls.savePendingFromConfirm || 0),
        quickParse: Number(dashboard.evidence.pageMethodCalls.runQuickParse || 0),
        saveConfirmed: Number(dashboard.evidence.productionBusinessCalls.saveConfirmedDraft || 0),
        savePending: Number(dashboard.evidence.productionBusinessCalls.savePendingNote || 0),
        saveState: Number(dashboard.evidence.productionStorageCalls.saveState || 0)
      },
      handoff: handoff.audit(),
      legacyVoice: legacyVoice.audit(),
      navigation: safeClone(wxAudit.navigationEvents || []),
      recorder: recorderAudit,
      storageMutations: (wxAudit.storageEvents || []).filter((event) => (
        event.operation === 'SET' || event.operation === 'REMOVE'
      )),
      ui: safeClone(wxAudit.uiEvents || []),
      vibrationCount: vibrationEvents.length,
      view: {
        gesture: String(dashboard.page.data.voiceGesture || tab.data.voiceGesture || ''),
        overlay: dashboard.page.data.voiceOverlayVisible === true
          || tab.data.voiceOverlayVisible === true,
        phase: String(controllerState().phase || ''),
        subtitle: String(dashboard.page.data.voiceOverlaySubtitle
          || tab.data.voiceOverlaySubtitle || ''),
        tip: String(dashboard.page.data.voiceTip || tab.data.voiceTip || ''),
        title: String(dashboard.page.data.voiceOverlayTitle
          || tab.data.voiceOverlayTitle || '')
      }
    };
  }

  function dispose() {
    try {
      if (typeof dashboard.page.onUnload === 'function') dashboard.page.onUnload();
      tab.__detach();
    } finally {
      handoff.restore();
      permission.restore();
      scheduler.restore();
      purgeVoiceModules();
      delete global.wx;
      delete global.getApp;
      delete global.getCurrentPages;
      delete global.requirePlugin;
    }
  }

  return {
    audit,
    bindings,
    dashboard,
    dispatch,
    dispose,
    permission,
    recorder,
    scheduler,
    tab,
    touch: { point, touchEnd, touchMove, touchStart }
  };
}

module.exports = {
  CONTROLLER_PATH,
  DASHBOARD_WXML,
  TAB_WXML,
  createVcapHarness,
  extractBindings
};
