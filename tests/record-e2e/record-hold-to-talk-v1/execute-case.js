const { stableHash } = require('../../../utils/record-state-diff');
const { createHoldHarness, flushAsync } = require('./runtime');
const { point } = require('./gesture-runtime');
const { extractVoiceBindings } = require('./tab-runtime');

const TRANSCRIPT = '王总周三交500个5元';

function check(code, pass, actual) {
  return { code, pass: pass === true, actual };
}

function allZeroAuthority(audit) {
  return Object.values(audit.dashboardAuthority || {}).every((value) => Number(value || 0) === 0);
}

function inputNavigations(audit) {
  return (audit.navigation || []).filter((entry) => entry.url === '/pages/input/input');
}

function validVoicePayload(payload) {
  return payload
    && JSON.stringify(Object.keys(payload).sort()) === JSON.stringify([
      'autoParse', 'originSurface', 'originalText', 'source'
    ])
    && payload.autoParse === true
    && payload.originSurface === 'HOME_QUICK'
    && payload.originalText === TRANSCRIPT
    && payload.source === 'voice';
}

function dashboardNavigations(audit) {
  return (audit.navigation || []).filter((entry) => entry.url === '/pages/dashboard/dashboard');
}

function shortPromptSnapshot(harness) {
  const audit = harness.audit();
  return {
    overlayVisible: harness.dashboard.page.data.voiceOverlayVisible === true,
    tip: String(harness.dashboard.page.data.voiceTip || ''),
    uiTitles: (audit.ui || []).map((event) => String(event.title || ''))
  };
}

function shortPromptObserved(before, after, options = {}) {
  const newUiTitles = after.uiTitles.slice(before.uiTitles.length);
  if (newUiTitles.includes('请按住说话')) return true;
  return options.allowDashboardTip === true
    && after.tip === '请按住说话'
    && after.tip !== before.tip;
}

function activeHero(harness, event) {
  harness.dispatchHero('start', event || harness.touch.touchStart());
  harness.scheduler.advanceBy(260);
  harness.voice.emitStart();
}

function releaseHero(harness, event) {
  harness.dispatchHero('end', event || harness.touch.touchEnd());
}

async function completeHero(harness, transcript = TRANSCRIPT) {
  activeHero(harness);
  releaseHero(harness);
  harness.voice.emitFinal(undefined, transcript);
  await harness.followInput();
  return harness.audit();
}

function startTabAtThreshold(harness) {
  harness.dispatchTab('start', harness.touch.touchStart());
  harness.scheduler.advanceBy(260);
}

function semanticInput(audit) {
  const projection = Object.assign({}, audit.input);
  delete projection.runParseCount;
  delete projection.writerCalls;
  return projection;
}

async function withHarness(options, action) {
  const harness = createHoldHarness(options);
  try {
    return await action(harness);
  } finally {
    harness.dispose();
  }
}

async function p0Hold001() {
  return withHarness({ caseId: 'P0-HOLD-001' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.dashboard.page.onHide();
    harness.scheduler.advanceBy(261);
    if (harness.voice.audit().startCount) {
      harness.voice.emitStart();
      harness.voice.emitFinal(undefined, TRANSCRIPT);
    }
    const audit = harness.audit();
    return [
      check('HIDDEN_TIMER_PROVIDER_ZERO', audit.voice.manager.startCount === 0, audit.voice.manager),
      check('HIDDEN_TIMER_HANDOFF_ZERO', audit.handoff.publishCount === 0, audit.handoff),
      check('HIDDEN_TIMER_NAV_ZERO', inputNavigations(audit).length === 0, audit.navigation),
      check('HIDDEN_TIMER_PARSE_ZERO', audit.parser.hybridCount === 0, audit.parser),
      check('HIDDEN_TIMER_MUTATION_ZERO', !audit.businessMutation
        && allZeroAuthority(audit)
        && audit.storageMutations.length === 0, {
        authority: audit.dashboardAuthority,
        storageMutations: audit.storageMutations
      })
    ];
  });
}

async function p0Hold002() {
  return withHarness({ caseId: 'P0-HOLD-002' }, async (harness) => {
    activeHero(harness);
    harness.dashboard.page.onHide();
    harness.voice.emitStart();
    harness.voice.emitFinal(0, TRANSCRIPT);
    const auditAfterLate = harness.audit();
    const dataAfterLate = safeVoiceData(harness);
    harness.dashboard.page.onShow();
    harness.dispatchHero('start', harness.touch.touchStart(2, 210, 410));
    harness.scheduler.advanceBy(260);
    const audit = harness.audit();
    return [
      check('ACTIVE_HIDE_UI_IDLE', dataAfterLate.recording === false
        && dataAfterLate.overlay === false, dataAfterLate),
      check('ACTIVE_HIDE_SESSION_CANCELLED', !auditAfterLate.voice.session || auditAfterLate.voice.session.status === 'CANCELLED', auditAfterLate.voice.session),
      check('ACTIVE_HIDE_LATE_ZERO', auditAfterLate.handoff.publishCount === 0
        && inputNavigations(auditAfterLate).length === 0
        && auditAfterLate.parser.hybridCount === 0, auditAfterLate),
      check('ACTIVE_HIDE_ONSHOW_REUSABLE', audit.voice.manager.startCount === 2
        && harness.dashboard.page.data.voiceRecording === true
        && harness.dashboard.page.data.voiceOverlayVisible === true, {
        data: safeVoiceData(harness),
        manager: audit.voice.manager
      }),
      check('ACTIVE_HIDE_MUTATION_ZERO', !audit.businessMutation
        && allZeroAuthority(audit)
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function tab001() {
  return withHarness({ caseId: 'TAB-001', origin: 'records' }, async (harness) => {
    harness.dispatchTab('start', harness.touch.touchStart());
    const atStart = harness.audit();
    harness.scheduler.advanceBy(260);
    const atThreshold = harness.audit();
    return [
      check('TAB_NO_DASHBOARD_NAV_AT_START', dashboardNavigations(atStart).length === 0, atStart.navigation),
      check('TAB_NO_DASHBOARD_NAV_AT_THRESHOLD', dashboardNavigations(atThreshold).length === 0, atThreshold.navigation),
      check('TAB_OWNS_PROVIDER_START', atThreshold.voice.manager.startCount === 1, atThreshold.voice.manager)
    ];
  });
}

async function tab002() {
  const matrix = [];
  for (const milliseconds of [259, 260, 261]) {
    matrix.push(await withHarness({ caseId: `TAB-002-${milliseconds}`, origin: 'records' }, async (harness) => {
      harness.dispatchTab('start', harness.touch.touchStart());
      harness.scheduler.advanceBy(milliseconds);
      return { milliseconds, startCount: harness.voice.audit().startCount };
    }));
  }
  const release = await withHarness({ caseId: 'TAB-002-RELEASE', origin: 'records' }, async (harness) => {
    startTabAtThreshold(harness);
    if (harness.voice.audit().startCount) harness.voice.emitStart();
    harness.dispatchTab('end', harness.touch.touchEnd());
    return harness.audit();
  });
  return [
    check('TAB_THRESHOLD_259_ZERO', matrix[0].startCount === 0, matrix),
    check('TAB_ONE_GESTURE_START_ONCE', matrix[1].startCount === 1, matrix),
    check('TAB_THRESHOLD_261_STILL_ONCE', matrix[2].startCount === 1, matrix),
    check('TAB_FIRST_RELEASE_STOP_ONCE', release.voice.manager.stopCount === 1, release.voice.manager),
    check('TAB_NO_SECOND_ACTION_OR_DASHBOARD', dashboardNavigations(release).length === 0, release.navigation)
  ];
}

async function tab003() {
  return withHarness({ caseId: 'TAB-003', origin: 'records', text: TRANSCRIPT }, async (harness) => {
    startTabAtThreshold(harness);
    if (harness.voice.audit().startCount) harness.voice.emitStart();
    harness.dispatchTab('end', harness.touch.touchEnd());
    if (harness.voice.audit().startCount) harness.voice.emitFinal(undefined, TRANSCRIPT);
    await harness.followInput();
    harness.input.page.onShow();
    await harness.settlePage(harness.input.page);
    const audit = harness.audit();
    return [
      check('TAB_DIRECT_INPUT_NAV_ONLY', dashboardNavigations(audit).length === 0
        && inputNavigations(audit).length === 1, audit.navigation),
      check('TAB_FINAL_HANDOFF_ONCE', audit.handoff.publishCount === 1
        && validVoicePayload(audit.handoff.publishPayloads[0]), audit.handoff),
      check('TAB_DASHBOARD_AUTHORITY_ZERO', allZeroAuthority(audit), audit.dashboardAuthority),
      check('TAB_INPUT_WRITER_ZERO', Object.values(audit.input.writerCalls).every((value) => value === 0)
        && !audit.businessMutation, audit.input.writerCalls),
      check('TAB_INPUT_CONVERSATION_ONCE', audit.handoff.consumeCount === 1
        && audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1
        && audit.parser.surfaces[0] === 'FULL_PAGE'
        && audit.input.conversationPhase === 'CLARIFYING'
        && audit.input.activeQuestionField === 'productName', audit.input)
    ];
  });
}

async function tab004() {
  return withHarness({ caseId: 'TAB-004', origin: 'records' }, async (harness) => {
    startTabAtThreshold(harness);
    if (harness.voice.audit().startCount) harness.voice.emitStart();
    harness.dispatchTab('move', harness.touch.touchMove([point(1, 200, 340)]));
    harness.dispatchTab('end', harness.touch.touchEnd(1, 200, 340));
    if (harness.voice.audit().startCount) harness.voice.emitFinal(undefined, TRANSCRIPT);
    const audit = harness.audit();
    return [
      check('TAB_VERTICAL_CANCELLED', audit.voice.session && audit.voice.session.status === 'CANCELLED', audit.voice.session),
      check('TAB_CANCEL_NO_HANDOFF', audit.handoff.publishCount === 0 && inputNavigations(audit).length === 0, audit),
      check('TAB_CANCEL_NO_DASHBOARD_NAV', dashboardNavigations(audit).length === 0, audit.navigation),
      check('TAB_CANCEL_MUTATION_ZERO', !audit.businessMutation
        && allZeroAuthority(audit)
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function tab005() {
  return withHarness({ caseId: 'TAB-005', origin: 'records' }, async (harness) => {
    const promptBefore = shortPromptSnapshot(harness);
    harness.dispatchTab('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(259);
    harness.dispatchTab('end', harness.touch.touchEnd());
    harness.scheduler.advanceBy(200);
    const audit = harness.audit();
    const promptAfter = shortPromptSnapshot(harness);
    return [
      check('TAB_SHORT_PROVIDER_ZERO', audit.voice.manager.startCount === 0, audit.voice.manager),
      check('TAB_SHORT_PROMPT', shortPromptObserved(promptBefore, promptAfter, { allowDashboardTip: false }), { promptBefore, promptAfter }),
      check('TAB_SHORT_STAYS_ORIGIN', audit.navigation.length === 0, audit.navigation),
      check('TAB_SHORT_SIDE_EFFECT_ZERO', audit.handoff.publishCount === 0
        && !audit.businessMutation
        && allZeroAuthority(audit)
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function tab006() {
  return withHarness({ caseId: 'TAB-006', origin: 'records' }, async (harness) => {
    startTabAtThreshold(harness);
    if (harness.voice.audit().startCount) harness.voice.emitStart();
    harness.dispatchTab('cancel', harness.touch.touchCancel());
    if (harness.voice.audit().startCount) harness.voice.emitFinal(undefined, TRANSCRIPT);
    const audit = harness.audit();
    return [
      check('TAB_TOUCHCANCEL_CANCELLED', !audit.voice.session || audit.voice.session.status === 'CANCELLED', audit.voice.session),
      check('TAB_TOUCHCANCEL_IDLE', harness.dashboard.page.data.voiceRecording === false
        && harness.dashboard.page.data.voiceOverlayVisible === false, harness.dashboard.page.data),
      check('TAB_TOUCHCANCEL_NO_NAV', audit.navigation.length === 0, audit.navigation),
      check('TAB_TOUCHCANCEL_NO_HANDOFF', audit.handoff.publishCount === 0, audit.handoff),
      check('TAB_TOUCHCANCEL_MUTATION_ZERO', !audit.businessMutation
        && allZeroAuthority(audit)
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function hold001() {
  return withHarness({ caseId: 'HOLD-001' }, async (harness) => {
    const promptBefore = shortPromptSnapshot(harness);
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(259);
    harness.dispatchHero('end', harness.touch.touchEnd());
    harness.scheduler.advanceBy(10);
    const audit = harness.audit();
    const promptAfter = shortPromptSnapshot(harness);
    return [
      check('HERO_SHORT_PROVIDER_ZERO', audit.voice.manager.startCount === 0, audit.voice.manager),
      check('HERO_SHORT_HANDOFF_ZERO', audit.handoff.publishCount === 0, audit.handoff),
      check('HERO_SHORT_PROMPT', shortPromptObserved(promptBefore, promptAfter, {
        allowDashboardTip: harness.bindings.dashboardTipProjected === true
      }), { bindings: harness.bindings, promptBefore, promptAfter }),
      check('HERO_SHORT_MUTATION_ZERO', !audit.businessMutation
        && allZeroAuthority(audit)
        && audit.storageMutations.length === 0, audit)
    ];
  });
}

async function hold002() {
  const evidence = [];
  for (const milliseconds of [259, 260, 261]) {
    evidence.push(await withHarness({ caseId: `HOLD-002-${milliseconds}` }, async (harness) => {
      harness.dispatchHero('start', harness.touch.touchStart());
      harness.scheduler.advanceBy(milliseconds);
      return { milliseconds, startCount: harness.voice.audit().startCount };
    }));
  }
  return [
    check('THRESHOLD_259_NOT_STARTED', evidence[0].startCount === 0, evidence),
    check('THRESHOLD_260_STARTED_ONCE', evidence[1].startCount === 1, evidence),
    check('THRESHOLD_261_STILL_ONCE', evidence[2].startCount === 1, evidence)
  ];
}

async function hold003() {
  return withHarness({ caseId: 'HOLD-003', text: TRANSCRIPT }, async (harness) => {
    await completeHero(harness);
    harness.input.page.onShow();
    await harness.settlePage(harness.input.page);
    const audit = harness.audit();
    return [
      check('HERO_ONE_GESTURE_START_STOP', audit.voice.manager.startCount === 1 && audit.voice.manager.stopCount === 1, audit.voice.manager),
      check('HERO_REAL_VOICE_SESSION_ID', audit.voice.manager.sessionIds.length === 1
        && /^voice-session-\d+$/.test(audit.voice.manager.sessionIds[0]), audit.voice.manager),
      check('HERO_ONE_FINAL_HANDOFF', audit.handoff.publishCount === 1
        && validVoicePayload(audit.handoff.publishPayloads[0])
        && inputNavigations(audit).length === 1, audit),
      check('HERO_INPUT_PARSE_ONCE', audit.handoff.consumeCount === 1
        && audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1
        && audit.parser.surfaces[0] === 'FULL_PAGE', audit.input),
      check('HERO_DASHBOARD_AUTHORITY_ZERO', allZeroAuthority(audit) && !audit.businessMutation, audit.dashboardAuthority),
      check('HERO_INPUT_WRITER_ZERO', Object.values(audit.input.writerCalls).every((value) => value === 0), audit.input.writerCalls)
    ];
  });
}

async function hold004() {
  const positions = [
    { label: 'BELOW', x: 200, y: 346, cancel: false },
    { label: 'EXACT', x: 200, y: 345, cancel: false },
    { label: 'PURE', x: 200, y: 344, cancel: true },
    { label: 'LEFT', x: 140, y: 344, cancel: true },
    { label: 'RIGHT', x: 260, y: 344, cancel: true }
  ];
  const evidence = [];
  for (const origin of ['hero', 'tab']) {
    for (const position of positions) {
      evidence.push(await withHarness({ caseId: `HOLD-004-${origin}-${position.label}`, origin: 'dashboard' }, async (harness) => {
      if (origin === 'hero') activeHero(harness);
      else {
        harness.dispatchTab('start', harness.touch.touchStart());
        harness.scheduler.advanceBy(260);
        harness.voice.emitStart();
      }
      if (origin === 'hero') {
        harness.dispatchHero('move', harness.touch.touchMove([point(1, position.x, position.y)]));
      } else {
        harness.dispatchTab('move', harness.touch.touchMove([point(1, position.x, position.y)]));
      }
      const gesture = String(harness.dashboard.page.data.voiceGesture || '');
      if (origin === 'hero') harness.dispatchHero('end', harness.touch.touchEnd(1, position.x, position.y));
      else harness.dispatchTab('end', harness.touch.touchEnd(1, position.x, position.y));
      const audit = harness.audit();
      return Object.assign({}, position, {
        gesture,
        navigation: audit.navigation,
        origin,
        terminalStatus: String(audit.voice.session && audit.voice.session.status || '')
      });
      }));
    }
  }
  return evidence.map((entry) => check(
    `${entry.origin === 'hero' ? 'VERTICAL' : 'TAB_VERTICAL'}_${entry.label}`,
    entry.cancel
      ? (entry.origin === 'tab' || entry.gesture === 'cancel')
        && entry.terminalStatus === 'CANCELLED'
        && entry.navigation.length === 0
      : (entry.origin === 'tab' || entry.gesture === 'send')
        && entry.terminalStatus === 'STOP_REQUESTED',
    evidence
  ));
}

async function hold005() {
  const run = (origin) => withHarness({ caseId: `HOLD-005-${origin}`, origin: 'dashboard' }, async (harness) => {
    if (origin === 'hero') activeHero(harness);
    else {
      harness.dispatchTab('start', harness.touch.touchStart());
      harness.scheduler.advanceBy(260);
      harness.voice.emitStart();
    }
    const dispatch = (kind, event) => (origin === 'hero'
      ? harness.dispatchHero(kind, event)
      : harness.dispatchTab(kind, event));
    dispatch('move', harness.touch.touchMove([point(1, 200, 340)]));
    const cancelled = origin === 'hero'
      ? harness.dashboard.page.data.voiceGesture === 'cancel'
      : null;
    dispatch('move', harness.touch.touchMove([point(1, 200, 346)]));
    const restored = origin === 'hero'
      ? harness.dashboard.page.data.voiceGesture === 'send'
      : null;
    dispatch('end', harness.touch.touchEnd(1, 200, 346));
    const audit = harness.audit();
    return { audit, cancelled, origin, restored };
  });
  const hero = await run('hero');
  const tab = await run('tab');
  return [
    check('SLIDE_BACK_ENTERED_CANCEL', hero.cancelled, hero),
    check('SLIDE_BACK_RESTORED_SEND', hero.restored, hero),
    check('SLIDE_BACK_STOPPED_ONCE', hero.audit.voice.manager.stopCount === 1
      && hero.audit.voice.session && hero.audit.voice.session.status === 'STOP_REQUESTED', hero.audit.voice),
    check('TAB_SLIDE_BACK_RESTORED_SEND', tab.audit.voice.manager.stopCount === 1
      && tab.audit.voice.session && tab.audit.voice.session.status === 'STOP_REQUESTED', tab.audit.voice)
  ];
}

async function touchIdentityScenario(origin) {
  return withHarness({ caseId: `HOLD-006-${origin}`, origin: 'dashboard' }, async (harness) => {
    const start = harness.touch.touchStart(1, 200, 400, [point(2, 300, 400)]);
    if (origin === 'hero') harness.dispatchHero('start', start);
    else harness.dispatchTab('start', start);
    harness.scheduler.advanceBy(260);
    harness.voice.emitStart();
    const reordered = harness.touch.touchMove([point(2, 100, 300), point(1, 200, 400)]);
    if (origin === 'hero') harness.dispatchHero('move', reordered);
    else harness.dispatchTab('move', reordered);
    const gestureAfterSecond = origin === 'hero'
      ? harness.dashboard.page.data.voiceGesture
      : null;
    const secondEnd = harness.touch.touchEnd(2, 100, 300, [point(1, 200, 400)]);
    if (origin === 'hero') harness.dispatchHero('end', secondEnd);
    else harness.dispatchTab('end', secondEnd);
    const afterSecond = harness.audit();
    const ownerEnd = harness.touch.touchEnd(1, 200, 400);
    if (origin === 'hero') harness.dispatchHero('end', ownerEnd);
    else harness.dispatchTab('end', ownerEnd);
    const afterOwner = harness.audit();
    return {
      afterOwner,
      afterSecond,
      gestureAfterSecond,
      origin
    };
  });
}

async function hold006() {
  const hero = await touchIdentityScenario('hero');
  const tab = await touchIdentityScenario('tab');
  const zeroHero = await withHarness({ caseId: 'HOLD-006-ZERO-HERO' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart(1, 0, 0));
    harness.scheduler.advanceBy(260);
    harness.voice.emitStart();
    harness.dispatchHero('move', harness.touch.touchMove([point(1, 0, -60)]));
    harness.dispatchHero('end', harness.touch.touchEnd(1, 0, -60));
    const audit = harness.audit();
    return { terminalStatus: String(audit.voice.session && audit.voice.session.status || '') };
  });
  const zeroTab = await withHarness({ caseId: 'HOLD-006-ZERO-TAB', origin: 'dashboard' }, async (harness) => {
    harness.dispatchTab('start', harness.touch.touchStart(1, 0, 0));
    harness.scheduler.advanceBy(260);
    harness.voice.emitStart();
    harness.dispatchTab('move', harness.touch.touchMove([point(1, 0, -60)]));
    harness.dispatchTab('end', harness.touch.touchEnd(1, 0, -60));
    const audit = harness.audit();
    return { terminalStatus: String(audit.voice.session && audit.voice.session.status || '') };
  });
  return [
    check('HERO_SECOND_TOUCH_NO_GESTURE_CHANGE', hero.gestureAfterSecond === 'send', hero),
    check('HERO_SECOND_TOUCH_NO_TERMINAL', hero.afterSecond.voice.manager.stopCount === 0
      && hero.afterSecond.voice.session && !['CANCELLED', 'STOP_REQUESTED'].includes(hero.afterSecond.voice.session.status), hero.afterSecond.voice),
    check('TAB_SECOND_TOUCH_NO_TERMINAL', tab.afterSecond.voice.manager.stopCount === 0
      && tab.afterSecond.voice.session && !['CANCELLED', 'STOP_REQUESTED'].includes(tab.afterSecond.voice.session.status), tab.afterSecond.voice),
    check('HERO_OWNER_TOUCH_ENDS_ONCE', hero.afterOwner.voice.manager.stopCount === 1
      && hero.afterOwner.voice.session && hero.afterOwner.voice.session.status === 'STOP_REQUESTED', hero.afterOwner.voice),
    check('TAB_OWNER_TOUCH_ENDS_ONCE', tab.afterOwner.voice.manager.stopCount === 1
      && tab.afterOwner.voice.session && tab.afterOwner.voice.session.status === 'STOP_REQUESTED', tab.afterOwner.voice),
    check('HERO_ZERO_COORDINATE_CANCEL', zeroHero.terminalStatus === 'CANCELLED', zeroHero),
    check('TAB_ZERO_COORDINATE_CANCEL', zeroTab.terminalStatus === 'CANCELLED', zeroTab)
  ];
}

async function hold007() {
  const quick = await withHarness({ caseId: 'HOLD-007-QUICK' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(100);
    harness.dispatchHero('end', harness.touch.touchEnd());
    harness.scheduler.advanceBy(300);
    return harness.audit();
  });
  const hidden = await withHarness({ caseId: 'HOLD-007-HIDE' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.dashboard.page.onHide();
    harness.scheduler.advanceBy(300);
    return harness.audit();
  });
  const detached = await withHarness({ caseId: 'HOLD-007-DETACHED', origin: 'records' }, async (harness) => {
    harness.dispatchTab('start', harness.touch.touchStart());
    harness.tab.__detach();
    harness.scheduler.advanceBy(400);
    return harness.audit();
  });
  const unloaded = await withHarness({ caseId: 'HOLD-007-UNLOAD' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.dashboard.page.onUnload();
    harness.scheduler.advanceBy(300);
    return harness.audit();
  });
  const activeUnload = await withHarness({ caseId: 'HOLD-007-ACTIVE-UNLOAD' }, async (harness) => {
    activeHero(harness);
    harness.dashboard.page.onUnload();
    harness.voice.emitFinal(0, TRANSCRIPT, 2);
    return harness.audit();
  });
  return [
    check('QUICK_RELEASE_TIMER_DEAD', quick.voice.manager.startCount === 0, quick.voice),
    check('HIDE_TIMER_DEAD', hidden.voice.manager.startCount === 0, hidden.voice),
    check('DETACHED_TIMER_DEAD', detached.voice.manager.startCount === 0, detached.voice),
    check('UNLOAD_TIMER_DEAD', unloaded.voice.manager.startCount === 0, unloaded.voice),
    check('ACTIVE_UNLOAD_LATE_FINAL_ZERO', activeUnload.handoff.publishCount === 0
      && inputNavigations(activeUnload).length === 0, activeUnload)
  ];
}

async function hold008() {
  const release = await withHarness({ caseId: 'HOLD-008-RELEASE', permissionMode: 'PENDING' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(260);
    harness.dispatchHero('end', harness.touch.touchEnd());
    harness.permission.releaseGranted();
    return harness.audit();
  });
  const hidden = await withHarness({ caseId: 'HOLD-008-HIDE', permissionMode: 'PENDING' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(260);
    harness.dashboard.page.onHide();
    harness.permission.releaseGranted();
    return { audit: harness.audit(), data: safeVoiceData(harness) };
  });
  const authorize = await withHarness({ caseId: 'HOLD-008-AUTHORIZE', permissionMode: 'PENDING' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(260);
    harness.dispatchHero('end', harness.touch.touchEnd());
    const enteredAuthorize = harness.permission.releaseNeedsAuthorize();
    const pending = harness.permission.audit();
    const released = harness.permission.releaseGranted();
    return { audit: harness.audit(), enteredAuthorize, pending, released };
  });
  const authorizeDenied = await withHarness({ caseId: 'HOLD-008-AUTHORIZE-DENIED', permissionMode: 'PENDING' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(260);
    harness.dispatchHero('end', harness.touch.touchEnd());
    const enteredAuthorize = harness.permission.releaseNeedsAuthorize();
    const pending = harness.permission.audit();
    const denied = harness.permission.releaseDenied();
    return { audit: harness.audit(), denied, enteredAuthorize, pending, voiceData: safeVoiceData(harness) };
  });
  return [
    check('PERMISSION_AFTER_RELEASE_NO_START', release.voice.manager.startCount === 0, release.voice),
    check('PERMISSION_AFTER_HIDE_NO_START', hidden.audit.voice.manager.startCount === 0, hidden),
    check('PERMISSION_AFTER_HIDE_IDLE', hidden.data.recording === false && hidden.data.overlay === false, hidden.data),
    check('AUTHORIZE_PATH_WAS_REAL', authorize.enteredAuthorize === true
      && authorize.pending.pendingAuthorizations === 1
      && authorize.released === true, authorize),
    check('AUTHORIZE_AFTER_RELEASE_NO_START', authorize.audit.voice.manager.startCount === 0, authorize.audit.voice),
    check('AUTHORIZE_DENIAL_PATH_WAS_REAL', authorizeDenied.enteredAuthorize === true
      && authorizeDenied.pending.pendingAuthorizations === 1
      && authorizeDenied.denied === true, authorizeDenied),
    check('AUTHORIZE_DENIAL_NO_START', authorizeDenied.audit.voice.manager.startCount === 0
      && authorizeDenied.voiceData.recording === false
      && authorizeDenied.voiceData.overlay === false, authorizeDenied)
  ];
}

function safeVoiceData(harness) {
  return {
    mode: String(harness.dashboard.page.data.voiceOverlayMode || ''),
    overlay: harness.dashboard.page.data.voiceOverlayVisible === true,
    recording: harness.dashboard.page.data.voiceRecording === true,
    title: String(harness.dashboard.page.data.voiceOverlayTitle || '')
  };
}

async function hold009() {
  const released = await withHarness({ caseId: 'HOLD-009-RELEASED', permissionMode: 'PENDING' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(260);
    harness.dispatchHero('end', harness.touch.touchEnd());
    const before = safeVoiceData(harness);
    harness.permission.releaseGranted();
    harness.voice.emitStart();
    const after = safeVoiceData(harness);
    const audit = harness.audit();
    return { after, audit, before, permission: harness.permission.audit() };
  });
  const cancelled = await withHarness({ caseId: 'HOLD-009-CANCELLED', permissionMode: 'PENDING' }, async (harness) => {
    harness.dispatchHero('start', harness.touch.touchStart());
    harness.scheduler.advanceBy(260);
    harness.dispatchHero('move', harness.touch.touchMove([point(1, 140, 340)]));
    const beforeStart = {
      gesture: harness.dashboard.page.data.voiceGesture,
      subtitle: harness.dashboard.page.data.voiceOverlaySubtitle,
      title: harness.dashboard.page.data.voiceOverlayTitle
    };
    harness.permission.releaseGranted();
    harness.voice.emitStart();
    const afterStart = {
      gesture: harness.dashboard.page.data.voiceGesture,
      subtitle: harness.dashboard.page.data.voiceOverlaySubtitle,
      title: harness.dashboard.page.data.voiceOverlayTitle
    };
    harness.dispatchHero('end', harness.touch.touchEnd(1, 140, 340));
    harness.voice.emitFinal(0, TRANSCRIPT, 2);
    return { afterStart, audit: harness.audit(), beforeStart };
  });
  return [
    check('LATE_ONSTART_NOT_LISTENING', released.after.mode !== 'listening'
      && !/正在听|松开发送|松开取消/.test(`${released.after.title}`), released),
    check('LATE_ONSTART_NOT_ACTIVE', released.after.recording === false, released),
    check('LATE_ONSTART_PROVIDER_STOP_ONCE', released.audit.voice.manager.stopCount === 1, released.audit.voice.manager),
    check('LATE_ONSTART_PERMISSION_RESOLVED', released.permission.pendingSettings === 0, released.permission),
    check('CANCEL_INTENT_VISIBLE_BEFORE_START', cancelled.beforeStart.gesture === 'cancel'
      && /取消/.test(`${cancelled.beforeStart.title} ${cancelled.beforeStart.subtitle}`), cancelled.beforeStart),
    check('CANCEL_INTENT_SURVIVES_LATE_START', cancelled.afterStart.gesture === 'cancel'
      && /取消/.test(`${cancelled.afterStart.title} ${cancelled.afterStart.subtitle}`), cancelled.afterStart),
    check('CANCEL_AFTER_LATE_START_ZERO_HANDOFF', cancelled.audit.voice.manager.stopCount === 1
      && cancelled.audit.handoff.publishCount === 0
      && inputNavigations(cancelled.audit).length === 0, cancelled.audit)
  ];
}

async function hold010() {
  return withHarness({ caseId: 'HOLD-010' }, async (harness) => {
    activeHero(harness);
    releaseHero(harness);
    releaseHero(harness);
    const audit = harness.audit();
    const stopRequests = (audit.voice.session && audit.voice.session.audit || [])
      .filter((event) => event.type === 'STOP_REQUESTED').length;
    return [
      check('PROVIDER_STOP_EXACTLY_ONCE', audit.voice.manager.stopCount === 1, audit.voice.manager),
      check('STOP_REQUEST_EXACTLY_ONCE', stopRequests === 1, audit.voice.session)
    ];
  });
}

async function hold011() {
  return withHarness({ caseId: 'HOLD-011' }, async (harness) => {
    activeHero(harness);
    releaseHero(harness);
    harness.voice.emitFinal(0, TRANSCRIPT, 2);
    harness.voice.emitFinal(0, TRANSCRIPT, 3);
    await harness.followInput();
    const audit = harness.audit();
    return [
      check('DUPLICATE_FINAL_HANDOFF_ONCE', audit.handoff.publishCount === 1, audit.handoff),
      check('DUPLICATE_FINAL_HANDOFF_ALLOWLIST', validVoicePayload(audit.handoff.publishPayloads[0]), audit.handoff),
      check('DUPLICATE_FINAL_NAV_ONCE', inputNavigations(audit).length === 1, audit.navigation),
      check('DUPLICATE_FINAL_PARSE_ONCE', audit.input.runParseCount === 1, audit.input),
      check('FINAL_ACCEPTED_ONCE', audit.voice.session && audit.voice.session.acceptedFinalCount === 1, audit.voice.session)
    ];
  });
}

async function hold012() {
  const lateOnly = await withHarness({ caseId: 'HOLD-012-LATE' }, async (harness) => {
    activeHero(harness);
    harness.dispatchHero('move', harness.touch.touchMove([point(1, 140, 340)]));
    releaseHero(harness, harness.touch.touchEnd(1, 140, 340));
    harness.voice.emitFinal(0, TRANSCRIPT, 2);
    const audit = harness.audit();
    return audit;
  });
  const newVoice = await withHarness({ caseId: 'HOLD-012-NEW' }, async (harness) => {
    activeHero(harness);
    harness.dispatchHero('move', harness.touch.touchMove([point(1, 140, 340)]));
    releaseHero(harness, harness.touch.touchEnd(1, 140, 340));
    harness.dispatchHero('start', harness.touch.touchStart(2, 220, 420));
    harness.scheduler.advanceBy(260);
    const beforeOldFinal = harness.audit();
    harness.voice.emitFinal(0, '旧语音A', 2);
    const afterOldFinal = harness.audit();
    harness.voice.emitStart(1);
    harness.dispatchHero('end', harness.touch.touchEnd(2, 220, 420));
    harness.voice.emitFinal(1, '新语音B', 2);
    const afterNewFinal = harness.audit();
    return { afterNewFinal, afterOldFinal, beforeOldFinal };
  });
  return [
    check('CANCELLED_FINAL_REJECTED', lateOnly.handoff.publishCount === 0
      && inputNavigations(lateOnly).length === 0, lateOnly),
    check('CANCELLED_SESSION_TERMINAL', lateOnly.voice.session && lateOnly.voice.session.status === 'CANCELLED', lateOnly.voice.session),
    check('NEW_VOICE_WAITS_FOR_OLD_RELEASE', newVoice.beforeOldFinal.voice.manager.startCount === 1, newVoice.beforeOldFinal.voice.manager),
    check('OLD_FINAL_DOES_NOT_PUBLISH', newVoice.afterOldFinal.handoff.publishCount === 0, newVoice.afterOldFinal.handoff),
    check('NEW_FINAL_ONLY_PUBLISHES_B', newVoice.afterNewFinal.handoff.publishCount === 1
      && newVoice.afterNewFinal.handoff.publishPayloads[0].originalText === '新语音B', newVoice.afterNewFinal.handoff)
  ];
}

async function staleManualScenario(source) {
  return withHarness({ caseId: `HOLD-013-${source}`, clipboardText: '手工B' }, async (harness) => {
    activeHero(harness);
    releaseHero(harness);
    if (source === 'typed') {
      harness.dashboard.page.onComposerInput({ detail: { value: '手工B' } });
    } else {
      harness.fakeWx.setClipboardText('手工B');
      harness.dashboard.page.pasteClipboard();
      await flushAsync();
    }
    const beforeFinal = harness.audit();
    harness.voice.emitFinal(0, TRANSCRIPT, 2);
    const afterFinal = harness.audit();
    return {
      afterFinal,
      beforeFinal,
      composerText: String(harness.dashboard.page.data.composerText || ''),
      source
    };
  });
}

async function hold013() {
  const typed = await staleManualScenario('typed');
  const paste = await staleManualScenario('paste');
  return [
    check('TYPED_INVALIDATES_OLD_FINAL', typed.afterFinal.handoff.publishCount === typed.beforeFinal.handoff.publishCount
      && typed.composerText === '手工B', typed),
    check('PASTE_INVALIDATES_OLD_FINAL', paste.afterFinal.handoff.publishCount === paste.beforeFinal.handoff.publishCount
      && paste.afterFinal.handoff.publishPayloads.slice(-1)[0]
      && paste.afterFinal.handoff.publishPayloads.slice(-1)[0].originalText === '手工B'
      && paste.composerText === '手工B', paste)
  ];
}

async function hold014() {
  return withHarness({ caseId: 'HOLD-014' }, async (harness) => {
    activeHero(harness);
    releaseHero(harness);
    harness.dispatchHero('start', harness.touch.touchStart(2, 210, 410));
    harness.scheduler.advanceBy(300);
    const beforeFinal = harness.audit();
    harness.voice.emitFinal(0, TRANSCRIPT, 2);
    const afterFinal = harness.audit();
    return [
      check('FINALIZING_NO_CONCURRENT_PROVIDER', beforeFinal.voice.manager.startCount === 1, beforeFinal.voice.manager),
      check('FINALIZING_POLICY_DETERMINISTIC', afterFinal.handoff.publishCount === 1
        && afterFinal.voice.manager.sessionIds.length === 1, afterFinal)
    ];
  });
}

async function hold015() {
  return withHarness({ caseId: 'HOLD-015' }, async (harness) => {
    activeHero(harness);
    releaseHero(harness);
    const before = {
      overlayVisible: harness.dashboard.page.data.voiceOverlayVisible === true,
      tip: harness.dashboard.page.data.voiceTip,
      title: harness.dashboard.page.data.voiceOverlayTitle,
      uiTitles: harness.audit().ui.map((event) => String(event.title || ''))
    };
    harness.dispatchHero('start', harness.touch.touchStart(2, 210, 410));
    const after = {
      overlayVisible: harness.dashboard.page.data.voiceOverlayVisible === true,
      tip: harness.dashboard.page.data.voiceTip,
      title: harness.dashboard.page.data.voiceOverlayTitle,
      uiTitles: harness.audit().ui.map((event) => String(event.title || ''))
    };
    const audit = harness.audit();
    const newMessages = after.uiTitles.slice(before.uiTitles.length);
    if (harness.bindings.dashboardTipProjected === true && after.tip !== before.tip) {
      newMessages.push(after.tip);
    }
    if (after.overlayVisible && after.title !== before.title) newMessages.push(after.title);
    return [
      check('FINALIZING_REPRESS_NO_PROVIDER', audit.voice.manager.startCount === 1, audit.voice.manager),
      check('FINALIZING_REPRESS_FEEDBACK', newMessages.some((message) => (
        /上一条正在整理|请稍候|请等上一条|稍等上一条/.test(message)
      )), { after, before, newMessages })
    ];
  });
}

async function hold016() {
  return withHarness({ caseId: 'HOLD-016' }, async (harness) => {
    activeHero(harness);
    releaseHero(harness);
    harness.voice.emitFinal(0, '   ', 2);
    const audit = harness.audit();
    return [
      check('EMPTY_FINAL_NO_HANDOFF', audit.handoff.publishCount === 0, audit.handoff),
      check('EMPTY_FINAL_NO_INPUT', inputNavigations(audit).length === 0 && audit.parser.hybridCount === 0, audit),
      check('EMPTY_FINAL_IDLE', harness.dashboard.page.data.voiceRecording === false
        && harness.dashboard.page.data.voiceOverlayVisible === false, safeVoiceData(harness)),
      check('EMPTY_FINAL_NO_MUTATION', !audit.businessMutation && allZeroAuthority(audit), audit.dashboardAuthority)
    ];
  });
}

async function hold017() {
  const heroOwner = await withHarness({ caseId: 'HOLD-017-HERO', origin: 'dashboard' }, async (harness) => {
    activeHero(harness);
    harness.dispatchTab('start', harness.touch.touchStart(2, 300, 400));
    harness.dispatchTab('end', harness.touch.touchEnd(2, 300, 400));
    const afterForeignEnd = harness.audit();
    releaseHero(harness);
    const afterOwnerEnd = harness.audit();
    return { afterForeignEnd, afterOwnerEnd };
  });
  const tabOwner = await withHarness({ caseId: 'HOLD-017-TAB', origin: 'records' }, async (harness) => {
    harness.dispatchTab('start', harness.touch.touchStart(1, 200, 400));
    harness.scheduler.advanceBy(380);
    harness.voice.emitStart();
    harness.dispatchHero('start', harness.touch.touchStart(2, 300, 400));
    harness.dispatchHero('end', harness.touch.touchEnd(2, 300, 400));
    const afterForeignEnd = harness.audit();
    harness.dispatchTab('end', harness.touch.touchEnd(1, 200, 400));
    const afterOwnerEnd = harness.audit();
    return { afterForeignEnd, afterOwnerEnd };
  });
  const heroForeignCancel = await withHarness({ caseId: 'HOLD-017-HERO-CANCEL', origin: 'dashboard' }, async (harness) => {
    activeHero(harness);
    harness.dispatchTab('cancel', harness.touch.touchCancel(2, 300, 400, [point(1, 200, 400)]));
    return harness.audit();
  });
  const tabForeignCancel = await withHarness({ caseId: 'HOLD-017-TAB-CANCEL', origin: 'records' }, async (harness) => {
    harness.dispatchTab('start', harness.touch.touchStart(1, 200, 400));
    harness.scheduler.advanceBy(380);
    harness.voice.emitStart();
    harness.dispatchHero('cancel', harness.touch.touchCancel(2, 300, 400, [point(1, 200, 400)]));
    return harness.audit();
  });
  return [
    check('TAB_CANNOT_END_HERO_OWNER', heroOwner.afterForeignEnd.voice.manager.stopCount === 0
      && heroOwner.afterForeignEnd.voice.session
      && !['STOP_REQUESTED', 'CANCELLED'].includes(heroOwner.afterForeignEnd.voice.session.status), heroOwner.afterForeignEnd.voice),
    check('HERO_CANNOT_END_TAB_OWNER', tabOwner.afterForeignEnd.voice.manager.stopCount === 0
      && tabOwner.afterForeignEnd.voice.session
      && !['STOP_REQUESTED', 'CANCELLED'].includes(tabOwner.afterForeignEnd.voice.session.status), tabOwner.afterForeignEnd.voice),
    check('TAB_CANNOT_CANCEL_HERO_OWNER', heroForeignCancel.voice.manager.stopCount === 0
      && heroForeignCancel.voice.session && heroForeignCancel.voice.session.status !== 'CANCELLED', heroForeignCancel.voice),
    check('HERO_CANNOT_CANCEL_TAB_OWNER', tabForeignCancel.voice.manager.stopCount === 0
      && tabForeignCancel.voice.session && tabForeignCancel.voice.session.status !== 'CANCELLED', tabForeignCancel.voice),
    check('SYSTEM_ACTIVE_SESSION_MAX_ONE', heroOwner.afterOwnerEnd.voice.manager.startCount === 1
      && tabOwner.afterOwnerEnd.voice.manager.startCount === 1, { hero: heroOwner.afterOwnerEnd.voice.manager, tab: tabOwner.afterOwnerEnd.voice.manager }),
    check('EACH_OWNER_RELEASE_STOPS_ONCE', heroOwner.afterOwnerEnd.voice.manager.stopCount === 1
      && tabOwner.afterOwnerEnd.voice.manager.stopCount === 1, { hero: heroOwner.afterOwnerEnd.voice.manager, tab: tabOwner.afterOwnerEnd.voice.manager })
  ];
}

async function finalFrom(origin) {
  return withHarness({ caseId: `HOLD-018-${origin}`, origin, text: TRANSCRIPT }, async (harness) => {
    if (origin === 'dashboard') {
      await completeHero(harness);
    } else {
      harness.dispatchTab('start', harness.touch.touchStart());
      harness.scheduler.advanceBy(380);
      harness.voice.emitStart();
      harness.dispatchTab('end', harness.touch.touchEnd());
      harness.voice.emitFinal(undefined, TRANSCRIPT, 2);
      await harness.followInput();
    }
    const audit = harness.audit();
    return { audit, semantic: semanticInput(audit) };
  });
}

async function hold018() {
  const hero = await finalFrom('dashboard');
  const tab = await finalFrom('records');
  return [
    check('TWO_ENTRY_SEMANTIC_EQUAL', stableHash(hero.semantic) === stableHash(tab.semantic), { hero: hero.semantic, tab: tab.semantic }),
    check('TWO_ENTRY_ORIGINAL_EXACT', hero.semantic.originalText === TRANSCRIPT && tab.semantic.originalText === TRANSCRIPT, { hero: hero.semantic, tab: tab.semantic }),
    check('TWO_ENTRY_VOICE_SOURCE', hero.semantic.source === 'voice' && tab.semantic.source === 'voice', { hero: hero.semantic, tab: tab.semantic }),
    check('TWO_ENTRY_NO_AUTO_SAVE', !hero.audit.businessMutation && !tab.audit.businessMutation
      && allZeroAuthority(hero.audit) && allZeroAuthority(tab.audit), { hero: hero.audit.dashboardAuthority, tab: tab.audit.dashboardAuthority })
  ];
}

const EXECUTORS = {
  'P0-HOLD-001': p0Hold001,
  'P0-HOLD-002': p0Hold002,
  'TAB-001': tab001,
  'TAB-002': tab002,
  'TAB-003': tab003,
  'TAB-004': tab004,
  'TAB-005': tab005,
  'TAB-006': tab006,
  'HOLD-001': hold001,
  'HOLD-002': hold002,
  'HOLD-003': hold003,
  'HOLD-004': hold004,
  'HOLD-005': hold005,
  'HOLD-006': hold006,
  'HOLD-007': hold007,
  'HOLD-008': hold008,
  'HOLD-009': hold009,
  'HOLD-010': hold010,
  'HOLD-011': hold011,
  'HOLD-012': hold012,
  'HOLD-013': hold013,
  'HOLD-014': hold014,
  'HOLD-015': hold015,
  'HOLD-016': hold016,
  'HOLD-017': hold017,
  'HOLD-018': hold018
};

async function executeCase(contract) {
  const executor = EXECUTORS[contract.id];
  if (!executor) {
    const error = new Error(`Missing executor for ${contract.id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  const bindings = extractVoiceBindings();
  const checks = [
    check('STATIC_HERO_TOUCH_BINDINGS', ['start', 'move', 'end', 'cancel']
      .every((key) => Boolean(bindings.dashboard[key])) && !bindings.dashboard.tap, bindings.dashboard),
    check('STATIC_HERO_SHORT_TIP_PROJECTED', bindings.dashboardTipProjected === true, bindings),
    check('STATIC_TAB_TOUCH_BINDINGS', ['start', 'move', 'end', 'cancel']
      .every((key) => Boolean(bindings.tab[key]))
      && ['', 'noop'].includes(bindings.tab.tap), bindings.tab)
  ].concat(await executor());
  const firstFailure = checks.find((entry) => !entry.pass) || null;
  return {
    checks,
    firstFailure: firstFailure ? firstFailure.code : '',
    id: contract.id,
    status: firstFailure ? 'CASE_FAIL' : 'PASS'
  };
}

module.exports = {
  EXECUTORS,
  TRANSCRIPT,
  executeCase
};
