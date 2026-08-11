const fs = require('fs');
const path = require('path');
const { createTranscriptFingerprint } = require('../../../utils/voice-recognition');
const { createHoldHarness } = require('../record-hold-to-talk-v1/runtime');
const { point } = require('../record-hold-to-talk-v1/gesture-runtime');

const ROOT = path.resolve(__dirname, '../../..');
const TRANSCRIPT = '冯总订水杯137个，每个5元，8月15日交';
const OTHER_TRANSCRIPT = '李总订礼品盒517套，每套3.8元，下周五交';
const STABILIZATION_MS = 700;

function check(code, pass, actual) {
  return { code, pass: pass === true, actual };
}

function inputNavigations(audit) {
  return (audit.navigation || []).filter((entry) => entry.url === '/pages/input/input');
}

function dashboardNavigations(audit) {
  return (audit.navigation || []).filter((entry) => entry.url === '/pages/dashboard/dashboard');
}

function allZeroDashboardAuthority(audit) {
  return Object.values(audit.dashboardAuthority || {}).every((value) => Number(value || 0) === 0);
}

function exactHandoff(payload, text = TRANSCRIPT) {
  return payload
    && JSON.stringify(Object.keys(payload).sort()) === JSON.stringify([
      'autoParse', 'originSurface', 'originalText', 'source'
    ])
    && payload.autoParse === true
    && payload.originSurface === 'HOME_QUICK'
    && payload.originalText === text
    && payload.source === 'voice';
}

function surface(harness, origin = 'hero') {
  if (origin === 'tab') {
    return {
      gesture: String(harness.tab.data.centerVoiceGesture || ''),
      mode: String(harness.tab.data.centerVoiceOverlayMode || ''),
      overlay: harness.tab.data.centerVoiceOverlayVisible === true,
      phase: String(harness.tab.data.centerVoicePhase || ''),
      recording: harness.tab.data.centerVoiceRecording === true,
      subtitle: String(harness.tab.data.centerVoiceOverlaySubtitle || ''),
      title: String(harness.tab.data.centerVoiceOverlayTitle || '')
    };
  }
  return {
    gesture: String(harness.dashboard.page.data.voiceGesture || ''),
    mode: String(harness.dashboard.page.data.voiceOverlayMode || ''),
    overlay: harness.dashboard.page.data.voiceOverlayVisible === true,
    phase: String(harness.dashboard.page.data.voiceCapturePhase || ''),
    recording: harness.dashboard.page.data.voiceRecording === true,
    subtitle: String(harness.dashboard.page.data.voiceOverlaySubtitle || ''),
    title: String(harness.dashboard.page.data.voiceOverlayTitle || '')
  };
}

function isPreparing(view) {
  const copy = `${view.title}|${view.subtitle}`;
  return view.overlay
    && view.recording
    && view.mode === 'preparing'
    && /准备中/.test(copy)
    && !/我在听|松开发送/.test(copy);
}

function isStabilizing(view) {
  return view.phase === 'POST_ONSTART_STABILIZING' && isPreparing(view);
}

function isListening(view) {
  const copy = `${view.title}|${view.subtitle}`;
  return view.phase === 'READY_RECORDING'
    && view.overlay
    && view.recording
    && view.mode === 'listening'
    && /我在听/.test(copy)
    && /松开发送/.test(copy);
}

function start(harness, origin = 'hero', identifier = 1) {
  const event = harness.touch.touchStart(identifier, 200, 400);
  return origin === 'tab'
    ? harness.dispatchTab('start', event)
    : harness.dispatchHero('start', event);
}

function move(harness, origin, identifier, y) {
  const event = harness.touch.touchMove([point(identifier, 200, y)]);
  return origin === 'tab'
    ? harness.dispatchTab('move', event)
    : harness.dispatchHero('move', event);
}

function end(harness, origin = 'hero', identifier = 1, y = 400) {
  const event = harness.touch.touchEnd(identifier, 200, y);
  return origin === 'tab'
    ? harness.dispatchTab('end', event)
    : harness.dispatchHero('end', event);
}

function cancel(harness, origin = 'hero', identifier = 1, y = 400) {
  const event = harness.touch.touchCancel(identifier, 200, y);
  return origin === 'tab'
    ? harness.dispatchTab('cancel', event)
    : harness.dispatchHero('cancel', event);
}

function installRuntimeProbe(harness) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalDateNow = Date.now;
  const originalVibrateShort = harness.fakeWx.wx.vibrateShort;
  const originalUploadFile = harness.fakeWx.wx.uploadFile;
  const originalRequest = harness.fakeWx.wx.request;
  const baseNow = originalDateNow();
  const timers = [];
  const vibrations = [];
  const uploads = [];
  const requests = [];

  Date.now = () => baseNow + harness.scheduler.now();
  global.setTimeout = (callback, delay = 0, ...args) => {
    const record = {
      callback,
      cancelled: false,
      createdAt: harness.scheduler.now(),
      delay: Math.max(0, Number(delay) || 0),
      handle: null,
      invoked: 0
    };
    record.dueAt = record.createdAt + record.delay;
    record.handle = originalSetTimeout((...callbackArgs) => {
      record.invoked += 1;
      return callback(...callbackArgs);
    }, delay, ...args);
    timers.push(record);
    return record.handle;
  };
  global.clearTimeout = (handle) => {
    const record = timers.find((entry) => entry.handle === handle);
    if (record) record.cancelled = true;
    return originalClearTimeout(handle);
  };
  harness.fakeWx.wx.vibrateShort = (options = {}) => {
    vibrations.push({ type: String(options.type || '') });
    if (typeof originalVibrateShort === 'function') return originalVibrateShort(options);
    return undefined;
  };
  harness.fakeWx.wx.uploadFile = (options = {}) => {
    uploads.push({
      filePath: String(options.filePath || ''),
      url: String(options.url || '')
    });
    if (typeof options.fail === 'function') options.fail({ errMsg: 'diagnostic upload blocked' });
  };
  harness.fakeWx.wx.request = (options = {}) => {
    requests.push({ url: String(options.url || '') });
    return originalRequest(options);
  };

  return {
    readyTimers() { return timers.filter((entry) => entry.delay === STABILIZATION_MS); },
    timerView(record) {
      if (!record) return null;
      return {
        cancelled: record.cancelled,
        delay: record.delay,
        dueAt: record.dueAt,
        invoked: record.invoked
      };
    },
    invokeAtDue(record) {
      if (!record) return false;
      const remaining = Math.max(0, record.dueAt - harness.scheduler.now());
      if (remaining) harness.scheduler.advanceBy(remaining);
      record.invoked += 1;
      record.callback();
      return true;
    },
    uploadCount() { return uploads.length; },
    uploads() { return uploads.slice(); },
    externalAsrRequests() {
      return requests.filter((entry) => /transcrib|speech|\basr\b/i.test(entry.url));
    },
    vibrationCount() { return vibrations.length; },
    restore() {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      Date.now = originalDateNow;
      harness.fakeWx.wx.vibrateShort = originalVibrateShort;
      if (originalUploadFile === undefined) delete harness.fakeWx.wx.uploadFile;
      else harness.fakeWx.wx.uploadFile = originalUploadFile;
      harness.fakeWx.wx.request = originalRequest;
    }
  };
}

async function withHarness(options, action) {
  const harness = createHoldHarness(options);
  const probe = installRuntimeProbe(harness);
  try {
    return await action(harness, probe);
  } finally {
    probe.restore();
    harness.dispose();
  }
}

function waterSourceAudit() {
  const dashboardWxml = fs.readFileSync(path.join(ROOT, 'pages/dashboard/dashboard.wxml'), 'utf8');
  const dashboardWxss = fs.readFileSync(path.join(ROOT, 'pages/dashboard/dashboard.wxss'), 'utf8');
  const tabWxml = fs.readFileSync(path.join(ROOT, 'custom-tab-bar/index.wxml'), 'utf8');
  const tabWxss = fs.readFileSync(path.join(ROOT, 'custom-tab-bar/index.wxss'), 'utf8');
  const dashboardHook = /voice-readiness-fill/.test(dashboardWxml);
  const tabHook = /voice-readiness-fill/.test(tabWxml);
  const combinedStyle = `${dashboardWxss}\n${tabWxss}`;
  return {
    animationEndIsAuthority: /bindanimationend\s*=/.test(`${dashboardWxml}\n${tabWxml}`),
    bottomFill: /voice-readiness-fill[\s\S]{0,1200}(translateY|bottom|clip-path|mask)/.test(combinedStyle),
    dashboardHook,
    duration700: /voice-readiness-fill[\s\S]{0,1600}(700ms|0\.7s)/.test(combinedStyle),
    tabHook
  };
}

function externalAsrSourceAudit() {
  const productionFiles = [];
  function collect(directory) {
    fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).forEach((entry) => {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(relative);
      else if (entry.isFile() && entry.name.endsWith('.js')) productionFiles.push(relative);
    });
  }
  ['pages', 'custom-tab-bar', 'utils'].forEach(collect);
  productionFiles.push('app.js');
  const offenders = [];
  productionFiles.forEach((file) => {
    if (file === 'utils/transcribe.js') return;
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (/transcribeVoice|require\([^)]*transcribe|\/api\/ai\/transcribe|wx\.uploadFile/.test(source)) {
      offenders.push(file);
    }
  });
  return {
    appEndpointEmpty: /aiTranscribeEndpoint\s*:\s*['"]{2}/.test(
      fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
    ),
    involvedCallers: offenders
  };
}

async function wx001() {
  return withHarness({ caseId: 'WXVOICE-READY-001' }, async (harness, probe) => {
    const accepted = start(harness);
    const view = surface(harness);
    const audit = harness.audit();
    return [
      check('WX001.REAL_HERO_WXML_HANDLER', accepted === true
        && harness.bindings.dashboard.start === 'startVoice', harness.bindings.dashboard),
      check('WX001.WECHATSI_MANAGER_START_ONCE', audit.voice.manager.startCount === 1, audit.voice.manager),
      check('WX001.TOUCHSTART_PREPARING_VISIBLE', isPreparing(view), view),
      check('WX001.NO_HAPTIC_BEFORE_PROVIDER_START', probe.vibrationCount() === 0, probe.vibrationCount()),
      check('WX001.ZERO_BUSINESS_AUTHORITY', audit.handoff.publishCount === 0
        && inputNavigations(audit).length === 0
        && allZeroDashboardAuthority(audit)
        && !audit.businessMutation
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function wx002() {
  return withHarness({ caseId: 'WXVOICE-READY-002' }, async (harness, probe) => {
    start(harness);
    harness.scheduler.advanceBy(2000);
    const view = surface(harness);
    const readyTimers = probe.readyTimers();
    const audit = harness.audit();
    return [
      check('WX002.PRE_ONSTART_STAYS_PREPARING_AT_2000MS', isPreparing(view), view),
      check('WX002.PRE_ONSTART_READY_TIMER_ZERO', readyTimers.length === 0,
        readyTimers.map((entry) => probe.timerView(entry))),
      check('WX002.PRE_ONSTART_HAPTIC_ZERO', probe.vibrationCount() === 0, probe.vibrationCount()),
      check('WX002.PRE_ONSTART_AUTHORITY_ZERO', audit.handoff.publishCount === 0
        && inputNavigations(audit).length === 0
        && audit.parser.hybridCount === 0, audit)
    ];
  });
}

async function wx003() {
  return withHarness({ caseId: 'WXVOICE-READY-003' }, async (harness, probe) => {
    start(harness);
    harness.voice.emitStart();
    const atStart = surface(harness);
    const timers = probe.readyTimers();
    harness.scheduler.advanceBy(699);
    const at699 = surface(harness);
    return [
      check('WX003.PROVIDER_ONSTART_ENTERS_STABILIZING', isStabilizing(atStart), atStart),
      check('WX003.PROVIDER_ONSTART_ARMS_ONE_700MS_TIMER', timers.length === 1,
        timers.map((entry) => probe.timerView(entry))),
      check('WX003.ONSTART_PLUS_699_NOT_LISTENING', isStabilizing(at699), at699),
      check('WX003.ONSTART_PLUS_699_HAPTIC_ZERO', probe.vibrationCount() === 0, probe.vibrationCount())
    ];
  });
}

async function wx004() {
  return withHarness({ caseId: 'WXVOICE-READY-004' }, async (harness, probe) => {
    start(harness);
    harness.voice.emitStart();
    harness.scheduler.advanceBy(700);
    const view = surface(harness);
    const water = waterSourceAudit();
    return [
      check('WX004.WATER_FILL_SOURCE_PRESENT', water.dashboardHook
        && water.tabHook
        && water.duration700
        && water.bottomFill
        && !water.animationEndIsAuthority, water),
      check('WX004.ONSTART_PLUS_700_READY', isListening(view), view),
      check('WX004.HAPTIC_EXACTLY_ONCE', probe.vibrationCount() === 1, probe.vibrationCount()),
      check('WX004.READINESS_TIMER_CONSUMED', probe.readyTimers().length === 1
        && probe.readyTimers()[0].invoked === 1, probe.readyTimers().map((entry) => probe.timerView(entry)))
    ];
  });
}

async function wx005() {
  return withHarness({ caseId: 'WXVOICE-READY-005', text: TRANSCRIPT }, async (harness, probe) => {
    start(harness);
    harness.voice.emitStart();
    harness.scheduler.advanceBy(300);
    end(harness);
    harness.voice.emitFinal(undefined, TRANSCRIPT);
    await harness.followInput();
    const audit = harness.audit();
    return [
      check('WX005.RELEASE_BEFORE_700_DISCARDS_SESSION', audit.voice.session
        && audit.voice.session.status === 'CANCELLED'
        && audit.voice.session.acceptedFinalCount === 0, audit.voice.session),
      check('WX005.EARLY_RELEASE_HAPTIC_ZERO', probe.vibrationCount() === 0, probe.vibrationCount()),
      check('WX005.EARLY_RELEASE_HANDOFF_INPUT_ZERO', audit.handoff.publishCount === 0
        && inputNavigations(audit).length === 0
        && audit.input.runParseCount === 0
        && audit.parser.hybridCount === 0, audit),
      check('WX005.EARLY_RELEASE_BUSINESS_ZERO', allZeroDashboardAuthority(audit)
        && !audit.businessMutation
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function wx006() {
  return withHarness({ caseId: 'WXVOICE-READY-006', text: TRANSCRIPT }, async (harness, probe) => {
    start(harness);
    const entered = move(harness, 'hero', 1, 340);
    const cancelled = surface(harness);
    move(harness, 'hero', 1, 400);
    const restored = surface(harness);
    move(harness, 'hero', 1, 340);
    harness.voice.emitStart();
    harness.scheduler.advanceBy(700);
    const afterTimer = surface(harness);
    end(harness, 'hero', 1, 340);
    harness.voice.emitFinal(undefined, TRANSCRIPT);
    const audit = harness.audit();
    return [
      check('WX006.PREPARING_VERTICAL_CANCEL_VISIBLE', entered === true
        && cancelled.gesture === 'cancel'
        && /松手取消/.test(`${cancelled.title}|${cancelled.subtitle}`), cancelled),
      check('WX006.PREPARING_SLIDE_BACK_RESTORES_PREPARING', restored.gesture === 'send'
        && isPreparing(restored), restored),
      check('WX006.CANCELLED_PREPARING_NEVER_READY', afterTimer.gesture === 'cancel'
        && afterTimer.phase !== 'READY_RECORDING'
        && probe.vibrationCount() === 0, { afterTimer, vibrations: probe.vibrationCount() }),
      check('WX006.CANCELLED_PREPARING_ZERO_AUTHORITY', audit.handoff.publishCount === 0
        && inputNavigations(audit).length === 0
        && audit.voice.session && audit.voice.session.acceptedFinalCount === 0, audit)
    ];
  });
}

async function wx007() {
  return withHarness({ caseId: 'WXVOICE-READY-007', text: TRANSCRIPT }, async (harness) => {
    start(harness);
    harness.voice.emitStart();
    harness.scheduler.advanceBy(700);
    move(harness, 'hero', 1, 340);
    const cancelled = surface(harness);
    move(harness, 'hero', 1, 400);
    const restored = surface(harness);
    move(harness, 'hero', 1, 340);
    end(harness, 'hero', 1, 340);
    harness.voice.emitFinal(undefined, TRANSCRIPT);
    const audit = harness.audit();
    return [
      check('WX007.READY_VERTICAL_CANCEL_VISIBLE', cancelled.phase === 'CANCEL_PENDING'
        && cancelled.gesture === 'cancel'
        && /松手取消/.test(`${cancelled.title}|${cancelled.subtitle}`), cancelled),
      check('WX007.READY_SLIDE_BACK_RESTORES_LISTENING', restored.phase === 'READY_RECORDING'
        && restored.gesture === 'send', restored),
      check('WX007.CANCELLED_FINAL_ZERO', audit.voice.session
        && audit.voice.session.status === 'CANCELLED'
        && audit.voice.session.acceptedFinalCount === 0
        && audit.handoff.publishCount === 0
        && inputNavigations(audit).length === 0, audit)
    ];
  });
}

async function lifecycleScenario(kind) {
  return withHarness({ caseId: `WXVOICE-READY-008-${kind}`, origin: kind === 'detach' ? 'records' : 'dashboard' },
    async (harness, probe) => {
      const origin = kind === 'detach' ? 'tab' : 'hero';
      start(harness, origin);
      harness.voice.emitStart();
      const timer = probe.readyTimers()[0] || null;
      harness.scheduler.advanceBy(300);
      if (kind === 'hide') harness.dashboard.page.onHide();
      else if (kind === 'unload') harness.dashboard.page.onUnload();
      else harness.tab.__detach();
      const cancelledAfterLifecycle = timer && timer.cancelled === true;
      if (timer) probe.invokeAtDue(timer);
      harness.voice.emitFinal(undefined, TRANSCRIPT);
      const audit = harness.audit();
      return {
        audit,
        cancelledAfterLifecycle,
        kind,
        timer: probe.timerView(timer),
        vibrations: probe.vibrationCount(),
        view: surface(harness, origin)
      };
    });
}

async function wx008() {
  const results = [];
  for (const kind of ['hide', 'unload', 'detach']) results.push(await lifecycleScenario(kind));
  return [
    check('WX008.READINESS_TIMER_ARMED_BEFORE_LIFECYCLE', results.every((entry) => entry.timer), results),
    check('WX008.LIFECYCLE_CLEARS_READINESS_TIMER', results.every((entry) => entry.cancelledAfterLifecycle), results),
    check('WX008.LATE_TIMER_FINAL_ZERO_AUTHORITY', results.every((entry) => (
      entry.vibrations === 0
      && entry.audit.handoff.publishCount === 0
      && inputNavigations(entry.audit).length === 0
      && entry.audit.voice.session
      && entry.audit.voice.session.status === 'CANCELLED'
    )), results)
  ];
}

async function wx009() {
  return withHarness({ caseId: 'WXVOICE-READY-009', origin: 'dashboard', text: OTHER_TRANSCRIPT }, async (harness, probe) => {
    start(harness, 'hero', 1);
    harness.voice.emitStart(0);
    const timerA = probe.readyTimers()[0] || null;
    if (!timerA) {
      return [check('WX009.A_TIMER_CAPTURED', false, probe.readyTimers().map((entry) => probe.timerView(entry)))];
    }
    cancel(harness, 'hero', 1);
    harness.voice.emitFinal(0, TRANSCRIPT);
    harness.scheduler.advanceBy(300);
    start(harness, 'tab', 2);
    harness.voice.emitStart(1);
    const beforeStale = surface(harness, 'tab');
    probe.invokeAtDue(timerA);
    const afterStale = surface(harness, 'tab');
    const auditAfterStale = harness.audit();
    const vibrationAfterStale = probe.vibrationCount();
    harness.scheduler.advanceBy(300);
    const readyB = surface(harness, 'tab');
    end(harness, 'tab', 2);
    harness.voice.emitFinal(1, OTHER_TRANSCRIPT);
    await harness.followInput();
    const audit = harness.audit();
    return [
      check('WX009.A_TIMER_CAPTURED', timerA.delay === 700, probe.timerView(timerA)),
      check('WX009.A_TIMER_WAS_REVOKED', timerA.cancelled === true, probe.timerView(timerA)),
      check('WX009.STALE_A_TIMER_CANNOT_AUTHORIZE_B', isStabilizing(beforeStale)
        && isStabilizing(afterStale)
        && vibrationAfterStale === 0
        && auditAfterStale.handoff.publishCount === 0, {
        beforeStale,
        afterStale,
        auditAfterStale,
        vibrationAfterStale
      }),
      check('WX009.B_OWN_TIMER_AUTHORIZES_B', isListening(readyB), readyB),
      check('WX009.B_FINAL_ONLY', audit.handoff.publishCount === 1
        && exactHandoff(audit.handoff.publishPayloads[0], OTHER_TRANSCRIPT)
        && audit.input.originalText === OTHER_TRANSCRIPT, audit)
    ];
  });
}

async function wx010() {
  return withHarness({ caseId: 'WXVOICE-READY-010', text: OTHER_TRANSCRIPT }, async (harness) => {
    start(harness, 'hero', 1);
    harness.voice.emitStart(0);
    harness.scheduler.advanceBy(700);
    cancel(harness, 'hero', 1);
    start(harness, 'tab', 2);
    const waiting = harness.audit();
    harness.voice.emitFinal(0, TRANSCRIPT);
    const afterA = harness.audit();
    harness.voice.emitStart(1);
    harness.scheduler.advanceBy(700);
    end(harness, 'tab', 2);
    harness.voice.emitFinal(1, OTHER_TRANSCRIPT);
    await harness.followInput();
    const audit = harness.audit();
    return [
      check('WX010.B_WAITS_FOR_A_PROVIDER_TERMINAL', waiting.voice.manager.startCount === 1, waiting.voice.manager),
      check('WX010.A_STALE_FINAL_HANDOFF_ZERO', afterA.handoff.publishCount === 0
        && inputNavigations(afterA).length === 0
        && afterA.voice.manager.startCount === 2, afterA),
      check('WX010.B_FINAL_ONLY', audit.handoff.publishCount === 1
        && exactHandoff(audit.handoff.publishPayloads[0], OTHER_TRANSCRIPT)
        && inputNavigations(audit).length === 1
        && audit.input.originalText === OTHER_TRANSCRIPT, audit)
    ];
  });
}

async function completeNormal(harness, transcript = TRANSCRIPT) {
  start(harness, 'hero', 1);
  harness.voice.emitStart(0);
  harness.scheduler.advanceBy(700);
  harness.voice.emitPartial(0, '冯总订水杯');
  end(harness, 'hero', 1);
  harness.voice.emitFinal(0, transcript);
  harness.voice.emitFinal(0, `${transcript}重复`);
  await harness.followInput();
  harness.input.page.onShow();
  await harness.settlePage(harness.input.page);
  return harness.audit();
}

async function wx011() {
  return withHarness({ caseId: 'WXVOICE-READY-011', text: TRANSCRIPT }, async (harness) => {
    const audit = await completeNormal(harness);
    return [
      check('WX011.WECHATSI_START_STOP_ONCE', audit.voice.manager.startCount === 1
        && audit.voice.manager.stopCount === 1, audit.voice.manager),
      check('WX011.FINAL_ACCEPTED_EXACTLY_ONCE', audit.voice.session
        && audit.voice.session.status === 'COMPLETED'
        && audit.voice.session.acceptedFinalCount === 1
        && audit.voice.session.finalCallbackInvocationCount === 2, audit.voice.session),
      check('WX011.R1B_HANDOFF_ONCE', audit.handoff.publishCount === 1
        && exactHandoff(audit.handoff.publishPayloads[0])
        && inputNavigations(audit).length === 1, audit),
      check('WX011.INPUT_CONVERSATION_PARSE_ONCE', audit.handoff.consumeCount === 1
        && audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1
        && audit.parser.surfaces[0] === 'FULL_PAGE', audit.input),
      check('WX011.ZERO_DIRECT_SAVE_AUTHORITY', allZeroDashboardAuthority(audit)
        && Object.values(audit.input.writerCalls).every((value) => value === 0)
        && !audit.businessMutation, audit)
    ];
  });
}

async function parityScenario(origin) {
  return withHarness({ caseId: `WXVOICE-READY-012-${origin}`, origin: origin === 'tab' ? 'records' : 'dashboard' },
    async (harness, probe) => {
      start(harness, origin);
      const immediate = surface(harness, origin);
      harness.voice.emitStart();
      harness.scheduler.advanceBy(699);
      const at699 = surface(harness, origin);
      const vibrationAt699 = probe.vibrationCount();
      harness.scheduler.advanceBy(1);
      const at700 = surface(harness, origin);
      return { at699, at700, immediate, origin, vibrationAt699, vibrationAt700: probe.vibrationCount() };
    });
}

async function wx012() {
  const hero = await parityScenario('hero');
  const tab = await parityScenario('tab');
  return [
    check('WX012.HERO_699_STABILIZING', isStabilizing(hero.at699)
      && hero.vibrationAt699 === 0, hero),
    check('WX012.TAB_699_STABILIZING', isStabilizing(tab.at699)
      && tab.vibrationAt699 === 0, tab),
    check('WX012.HERO_TAB_700_LISTENING', isListening(hero.at700)
      && isListening(tab.at700)
      && hero.vibrationAt700 === 1
      && tab.vibrationAt700 === 1, { hero, tab }),
    check('WX012.HERO_TAB_STATE_PARITY', JSON.stringify(hero.at699) === JSON.stringify(tab.at699)
      && JSON.stringify(hero.at700) === JSON.stringify(tab.at700), { hero, tab })
  ];
}

async function wx013() {
  return withHarness({ caseId: 'WXVOICE-READY-013', text: TRANSCRIPT }, async (harness, probe) => {
    const source = externalAsrSourceAudit();
    const audit = await completeNormal(harness);
    return [
      check('WX013.INVOLVED_PRODUCTION_EXTERNAL_ASR_CALLERS_ZERO', source.involvedCallers.length === 0, source),
      check('WX013.EXTERNAL_ASR_ENDPOINT_DISABLED', source.appEndpointEmpty, source),
      check('WX013.AUDIO_UPLOAD_CALLS_ZERO', probe.uploadCount() === 0, probe.uploads()),
      check('WX013.EXTERNAL_ASR_REQUESTS_ZERO', probe.externalAsrRequests().length === 0,
        probe.externalAsrRequests()),
      check('WX013.WECHATSI_FINAL_STILL_CLOSES_FLOW', audit.voice.session
        && audit.voice.session.acceptedFinalCount === 1
        && audit.handoff.publishCount === 1
        && audit.input.runParseCount === 1, audit)
    ];
  });
}

async function wx014() {
  return withHarness({ caseId: 'WXVOICE-READY-014', text: TRANSCRIPT }, async (harness) => {
    const audit = await completeNormal(harness, TRANSCRIPT);
    const page = harness.input.page.data;
    const evidence = audit.voice.session && audit.voice.session.evidence || {};
    const providerTranscriptExact = evidence.transcriptLength === TRANSCRIPT.length
      && evidence.transcriptFingerprint === createTranscriptFingerprint(
        audit.voice.session.sessionId,
        TRANSCRIPT
      );
    const handoffText = String(audit.handoff.publishPayloads[0] && audit.handoff.publishPayloads[0].originalText || '');
    return [
      check('WX014.PROVIDER_ACCEPTED_FINAL_EXACT', providerTranscriptExact
        && audit.voice.session.acceptedFinalCount === 1, audit.voice.session),
      check('WX014.CONTROLLER_HANDOFF_EXACT', handoffText === TRANSCRIPT
        && exactHandoff(audit.handoff.publishPayloads[0]), audit.handoff),
      check('WX014.INPUT_RAW_TEXT_EXACT', String(page.text || '') === TRANSCRIPT, page.text),
      check('WX014.INPUT_PARSE_ORIGINAL_EXACT', String(page.parseResult && page.parseResult.original_text || '') === TRANSCRIPT,
        page.parseResult && page.parseResult.original_text),
      check('WX014.VIEW_ORIGINAL_VALUE_EXACT', String(page.surfaceOriginalText || '') === TRANSCRIPT, page.surfaceOriginalText),
      check('WX014.NO_SECOND_STRING_TRANSFORM', providerTranscriptExact && [handoffText, page.text,
        page.parseResult && page.parseResult.original_text, page.surfaceOriginalText]
        .every((value) => String(value || '') === TRANSCRIPT), {
        handoffText,
        inputText: page.text,
        parseOriginal: page.parseResult && page.parseResult.original_text,
        providerTranscriptExact,
        surfaceOriginalText: page.surfaceOriginalText
      })
    ];
  });
}

const EXECUTORS = Object.freeze({
  'WXVOICE-READY-001': wx001,
  'WXVOICE-READY-002': wx002,
  'WXVOICE-READY-003': wx003,
  'WXVOICE-READY-004': wx004,
  'WXVOICE-READY-005': wx005,
  'WXVOICE-READY-006': wx006,
  'WXVOICE-READY-007': wx007,
  'WXVOICE-READY-008': wx008,
  'WXVOICE-READY-009': wx009,
  'WXVOICE-READY-010': wx010,
  'WXVOICE-READY-011': wx011,
  'WXVOICE-READY-012': wx012,
  'WXVOICE-READY-013': wx013,
  'WXVOICE-READY-014': wx014
});

async function executeCase(contract) {
  const executor = EXECUTORS[contract.id];
  if (!executor) {
    const error = new Error(`No executor registered for ${contract.id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  const checks = await executor();
  const firstFailure = (checks.find((entry) => !entry.pass) || {}).code || '';
  return {
    checks,
    firstFailure,
    id: contract.id,
    status: firstFailure ? 'CASE_FAIL' : 'PASS'
  };
}

module.exports = { executeCase };
