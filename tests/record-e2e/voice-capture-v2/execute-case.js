const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');
const { ROOT } = require('../runner/constants');
const { createControlledRecorderManager } = require('./recorder-runtime');
const { createVcapHarness, extractBindings } = require('./runtime');

const POC_ROOT = path.join(ROOT, 'tests/diagnostic/voice-capture-v2-poc');
const EVIDENCE_PATH = path.join(POC_ROOT, 'REAL_DEVICE_EVIDENCE.md');
const PHRASE = '冯总订水杯137个，每个5元，8月15日交';

function check(code, pass, actual) {
  return { actual: safeClone(actual), code, pass: pass === true };
}

function result(contract, checks) {
  const first = checks.find((entry) => !entry.pass);
  return {
    checks,
    firstFailure: first ? first.code : '',
    id: contract.id,
    status: first ? 'CASE_FAIL' : 'PASS'
  };
}

function zeroAuthority(audit) {
  return audit.handoff.publishCount === 0
    && audit.navigation.filter((entry) => entry.url === '/pages/input/input').length === 0
    && audit.businessMutation === false
    && audit.dashboardCalls.quickParse === 0
    && audit.dashboardCalls.deep === 0
    && audit.dashboardCalls.formal === 0
    && audit.dashboardCalls.pending === 0
    && audit.dashboardCalls.saveConfirmed === 0
    && audit.dashboardCalls.savePending === 0
    && audit.dashboardCalls.saveState === 0;
}

function hasText(audit, pattern) {
  const visible = [audit.view.tip, audit.view.title, audit.view.subtitle]
    .concat(audit.ui.map((entry) => entry.title || entry.content || ''))
    .join('|');
  return pattern.test(visible);
}

function dispatchStart(harness, surface = 'hero', identifier = 1) {
  return harness.dispatch(surface, 'start', harness.touch.touchStart(identifier, 200, 400));
}

function dispatchEnd(harness, surface = 'hero', identifier = 1) {
  return harness.dispatch(surface, 'end', harness.touch.touchEnd(identifier, 200, 400));
}

function emitStartAndReachReady(harness, recorderIndex = 0) {
  harness.recorder.emitStart(recorderIndex);
  harness.scheduler.advanceBy(700);
  return harness.audit();
}

function withHarness(options, callback) {
  const harness = createVcapHarness(options);
  try {
    return callback(harness);
  } finally {
    harness.dispose();
  }
}

function vcap001() {
  return withHarness({ caseId: 'VCAP-001' }, (harness) => {
    dispatchStart(harness);
    const audit = harness.audit();
    return [
      check('TOUCHSTART_NATIVE_RECORDER_START_ONCE', audit.recorder.startCount === 1, audit),
      check('TOUCHSTART_PHASE_PREPARING', audit.view.phase === 'PREPARING', audit.view),
      check('TOUCHSTART_ZERO_BUSINESS_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap002() {
  const hero = withHarness({ caseId: 'VCAP-002-HERO' }, (harness) => {
    dispatchStart(harness, 'hero');
    return harness.audit();
  });
  const tab = withHarness({ caseId: 'VCAP-002-TAB', origin: 'records' }, (harness) => {
    dispatchStart(harness, 'tab');
    return harness.audit();
  });
  return [
    check('HERO_TAB_IMMEDIATE_CAPTURE_EQUAL', hero.recorder.startCount === 1
      && tab.recorder.startCount === 1, { hero, tab }),
    check('HERO_TAB_PREPARING_EQUAL', hero.view.phase === 'PREPARING'
      && tab.view.phase === 'PREPARING', { hero: hero.view, tab: tab.view }),
    check('TAB_NO_DASHBOARD_HOP', !tab.navigation.some((entry) => (
      entry.url === '/pages/dashboard/dashboard'
    )), tab.navigation)
  ];
}

function vcap003() {
  return withHarness({ caseId: 'VCAP-003' }, (harness) => {
    dispatchStart(harness);
    harness.scheduler.advanceBy(100);
    dispatchEnd(harness);
    const afterRelease = harness.audit();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0);
    const afterLate = harness.audit();
    return [
      check('SHORT_TAP_STARTED_CAPTURE', afterRelease.recorder.startCount === 1, afterRelease.recorder),
      check('SHORT_TAP_DISCARD_STOP_ONCE', afterRelease.recorder.stopCount === 1, afterRelease.recorder),
      check('SHORT_TAP_VISIBLE_PROMPT', hasText(afterRelease, /请等震动后再说|请按住说话/), afterRelease.view),
      check('SHORT_TAP_ZERO_AUTHORITY', zeroAuthority(afterLate), afterLate)
    ];
  });
}

function completeReadyRecording(harness, surface = 'hero') {
  dispatchStart(harness, surface);
  emitStartAndReachReady(harness, 0);
  dispatchEnd(harness, surface);
  harness.recorder.emitStop(0, {
    duration: 2400,
    fileSize: 16384,
    tempFilePath: 'wxfile://vcap-ready.mp3'
  });
  return harness.audit();
}

function vcap004() {
  return withHarness({ caseId: 'VCAP-004' }, (harness) => {
    const audit = completeReadyRecording(harness);
    return [
      check('READY_RELEASE_AUDIO_READY', audit.recorder.startCount === 1
        && audit.recorder.stopCount === 1
        && audit.view.phase === 'AUDIO_READY', audit),
      check('AUDIO_READY_NO_TRANSCRIPT_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap005() {
  return withHarness({ caseId: 'VCAP-005' }, (harness) => {
    dispatchStart(harness);
    harness.dashboard.page.onHide();
    const afterHide = harness.audit();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0);
    const afterLate = harness.audit();
    return [
      check('PRE_READY_HIDE_CANCELLED', afterHide.recorder.startCount === 1
        && afterHide.recorder.stopCount === 1
        && afterHide.view.phase === 'IDLE', afterHide),
      check('PRE_READY_HIDE_LATE_CALLBACK_ZERO', zeroAuthority(afterLate)
        && afterLate.vibrationCount === 0, afterLate)
    ];
  });
}

function vcap006() {
  return withHarness({ caseId: 'VCAP-006', permissionMode: 'FIRST_AUTH' }, (harness) => {
    dispatchStart(harness);
    harness.permission.releaseGranted();
    const afterGrant = harness.audit();
    dispatchEnd(harness);
    dispatchStart(harness, 'hero', 2);
    const nextGesture = harness.audit();
    return [
      check('FIRST_AUTH_REQUIRES_REPRESS', afterGrant.recorder.startCount === 0
        && nextGesture.recorder.startCount === 1, { afterGrant, nextGesture }),
      check('FIRST_AUTH_VISIBLE_RETRY', hasText(afterGrant, /麦克风已开启.*重新按住说话/), afterGrant),
      check('FIRST_AUTH_ZERO_AUTHORITY', zeroAuthority(afterGrant), afterGrant)
    ];
  });
}

function vcap007() {
  return withHarness({ caseId: 'VCAP-007' }, (harness) => {
    dispatchStart(harness);
    emitStartAndReachReady(harness, 0);
    harness.dispatch('hero', 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 340)
    ]));
    dispatchEnd(harness);
    harness.recorder.emitStop(0);
    const audit = harness.audit();
    return [
      check('VERTICAL_CANCEL_DISCARDS_AUDIO', audit.recorder.stopCount === 1
        && audit.view.phase === 'IDLE', audit),
      check('VERTICAL_CANCEL_ZERO_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap008() {
  return withHarness({ caseId: 'VCAP-008' }, (harness) => {
    dispatchStart(harness);
    emitStartAndReachReady(harness, 0);
    harness.dispatch('hero', 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 340)
    ]));
    harness.dispatch('hero', 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 390)
    ]));
    dispatchEnd(harness);
    harness.recorder.emitStop(0);
    const audit = harness.audit();
    return [
      check('SLIDE_BACK_AUDIO_READY', audit.recorder.stopCount === 1
        && audit.view.phase === 'AUDIO_READY', audit),
      check('SLIDE_BACK_ZERO_BUSINESS_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap009() {
  return withHarness({ caseId: 'VCAP-009' }, (harness) => {
    dispatchStart(harness);
    harness.dispatch('hero', 'cancel', harness.touch.touchEnd(1, 200, 400));
    const beforeLate = harness.audit();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0);
    const afterLate = harness.audit();
    return [
      check('PREPARING_TOUCHCANCEL_DISCARDS', beforeLate.recorder.startCount === 1
        && beforeLate.recorder.stopCount === 1
        && beforeLate.view.phase === 'IDLE', beforeLate),
      check('TOUCHCANCEL_LATE_ZERO', zeroAuthority(afterLate)
        && afterLate.vibrationCount === 0, afterLate)
    ];
  });
}

function vcap010() {
  const preparing = withHarness({ caseId: 'VCAP-010-PREPARING' }, (harness) => {
    dispatchStart(harness);
    harness.dashboard.page.onUnload();
    harness.recorder.emitStart(0);
    return harness.audit();
  });
  const ready = withHarness({ caseId: 'VCAP-010-READY', origin: 'records' }, (harness) => {
    dispatchStart(harness, 'tab');
    emitStartAndReachReady(harness, 0);
    harness.tab.__detach();
    harness.recorder.emitStop(0);
    return harness.audit();
  });
  return [
    check('LIFECYCLE_INVALIDATES_ALL_PHASES', preparing.view.phase === 'IDLE'
      && ready.view.phase === 'IDLE'
      && preparing.recorder.stopCount === 1
      && ready.recorder.stopCount === 1, { preparing, ready }),
    check('LIFECYCLE_LATE_ZERO_AUTHORITY', zeroAuthority(preparing)
      && zeroAuthority(ready), { preparing, ready })
  ];
}

function vcap011() {
  return withHarness({ caseId: 'VCAP-011', permissionMode: 'DENIED' }, (harness) => {
    dispatchStart(harness);
    const audit = harness.audit();
    return [
      check('PERMISSION_DENIED_ZERO_CAPTURE', audit.recorder.startCount === 0
        && audit.view.phase === 'IDLE'
        && audit.vibrationCount === 0, audit),
      check('PERMISSION_DENIED_VISIBLE', hasText(audit, /麦克风|授权|权限/), audit),
      check('PERMISSION_DENIED_ZERO_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap012() {
  return withHarness({ caseId: 'VCAP-012' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    harness.dispatch('hero', 'end', harness.touch.touchEnd(2, 210, 400, [
      harness.touch.point(1, 200, 400)
    ]));
    const afterForeign = harness.audit();
    dispatchEnd(harness, 'hero', 1);
    const afterOwner = harness.audit();
    return [
      check('TOUCH_IDENTITY_OWNER_ONLY', afterForeign.recorder.stopCount === 0
        && afterOwner.recorder.stopCount === 1, { afterForeign, afterOwner }),
      check('TOUCH_IDENTITY_ZERO_AUTHORITY', zeroAuthority(afterOwner), afterOwner)
    ];
  });
}

function vcap013() {
  const capture = (surface, origin) => withHarness({ caseId: `VCAP-013-${surface}`, origin }, (harness) => {
    dispatchStart(harness, surface);
    emitStartAndReachReady(harness, 0);
    return harness.audit();
  });
  const hero = capture('hero', 'dashboard');
  const tab = capture('tab', 'records');
  return [
    check('HERO_TAB_READY_SEMANTICS_EQUAL', hero.recorder.startCount === 1
      && tab.recorder.startCount === 1
      && hero.view.phase === 'READY_RECORDING'
      && tab.view.phase === 'READY_RECORDING'
      && hero.vibrationCount === 1
      && tab.vibrationCount === 1, { hero, tab }),
    check('HERO_TAB_RECORDER_OPTIONS_EQUAL', JSON.stringify(hero.recorder.options)
      === JSON.stringify(tab.recorder.options), { hero: hero.recorder, tab: tab.recorder })
  ];
}

function vcap014() {
  return withHarness({ caseId: 'VCAP-014' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    dispatchStart(harness, 'tab', 2);
    harness.dispatch('tab', 'end', harness.touch.touchEnd(2, 200, 400));
    const afterForeign = harness.audit();
    dispatchEnd(harness, 'hero', 1);
    const audit = harness.audit();
    return [
      check('SINGLE_OWNER_RECORDER_START_ONCE', audit.recorder.startCount === 1
        && afterForeign.recorder.stopCount === 0
        && audit.recorder.stopCount === 1, { afterForeign, audit }),
      check('SINGLE_OWNER_ZERO_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap015() {
  return withHarness({ caseId: 'VCAP-015' }, (harness) => {
    dispatchStart(harness);
    emitStartAndReachReady(harness, 0);
    dispatchEnd(harness);
    dispatchEnd(harness);
    harness.dispatch('hero', 'cancel', harness.touch.touchEnd(1, 200, 400));
    harness.recorder.emitStop(0);
    harness.recorder.emitStop(0);
    const audit = harness.audit();
    return [
      check('RECORDER_TERMINAL_EXACTLY_ONCE', audit.recorder.stopCount === 1
        && audit.view.phase === 'AUDIO_READY', audit),
      check('RECORDER_FINAL_ZERO_HANDOFF', zeroAuthority(audit), audit)
    ];
  });
}

function vcap016() {
  return withHarness({ caseId: 'VCAP-016' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    emitStartAndReachReady(harness, 0);
    const aReady = harness.audit();
    dispatchEnd(harness, 'hero', 1);
    const aFinalizing = harness.audit();
    const bAcceptedWhileAStopping = dispatchStart(harness, 'hero', 2);
    const bBlocked = harness.audit();
    harness.recorder.emitStop(0, {
      duration: 1111,
      fileSize: 11111,
      tempFilePath: 'wxfile://file-a.mp3'
    });
    const aSettled = harness.audit();
    const bAcceptedAfterASettled = dispatchStart(harness, 'hero', 3);
    emitStartAndReachReady(harness, 1);
    const bReady = harness.audit();
    dispatchEnd(harness, 'hero', 3);
    harness.recorder.emitStop(1, {
      duration: 2222,
      fileSize: 22222,
      tempFilePath: 'wxfile://file-b.mp3'
    });
    const final = harness.audit();
    const audioA = aSettled.controller.audio || {};
    const audioB = final.controller.audio || {};
    return [
      check('VCAP016.A_STOP_PENDING_BLOCKS_B_NATIVE_START', aReady.view.phase === 'READY_RECORDING'
        && aFinalizing.view.phase === 'FINALIZING_AUDIO'
        && aFinalizing.recorder.stopCount === 1
        && bAcceptedWhileAStopping === false
        && bBlocked.recorder.startCount === 1
        && bBlocked.view.phase === 'FINALIZING_AUDIO'
        && !bBlocked.controller.audio, { aFinalizing, bBlocked }),
      check('VCAP016.B_REQUIRES_NEW_USER_GESTURE_AFTER_A_TERMINAL', aSettled.view.phase === 'AUDIO_READY'
        && audioA.tempFilePath === 'wxfile://file-a.mp3'
        && bAcceptedAfterASettled === true
        && bReady.view.phase === 'READY_RECORDING'
        && bReady.recorder.startCount === 2
        && bReady.vibrationCount === aReady.vibrationCount + 1,
      { aReady, aSettled, bReady }),
      check('VCAP016.B_AUDIO_READY_OWNS_B_FILE_AND_IDS', final.view.phase === 'AUDIO_READY'
        && Boolean(audioB.captureId)
        && Boolean(audioB.nativeLeaseId)
        && audioB.captureId !== audioA.captureId
        && audioB.nativeLeaseId !== audioA.nativeLeaseId
        && audioB.tempFilePath === 'wxfile://file-b.mp3'
        && Number(audioB.duration) === 2222
        && Number(audioB.fileSize) === 22222
        && audioB.tempFilePath !== audioA.tempFilePath, { audioA, audioB }),
      check('VCAP016.SERIAL_CAPTURE_ZERO_BUSINESS_AUTHORITY', zeroAuthority(final)
        && final.storageMutations.length === 0, final)
    ];
  });
}

function vcap017() {
  return withHarness({ caseId: 'VCAP-017' }, (harness) => {
    dispatchStart(harness);
    emitStartAndReachReady(harness, 0);
    dispatchEnd(harness);
    harness.recorder.emitStop(0, {
      duration: 5729.857921600342,
      fileSize: 34301,
      tempFilePath: 'wxfile://vcap-metadata.mp3'
    });
    const audit = harness.audit();
    const audio = audit.controller.audio || {};
    return [
      check('AUDIO_METADATA_CAPTURE_BOUND', audio.tempFilePath === 'wxfile://vcap-metadata.mp3'
        && Number(audio.duration) === 5729.857921600342
        && Number(audio.fileSize) === 34301
        && Boolean(audio.captureId)
        && Number.isFinite(Number(audio.startedAt))
        && Number.isFinite(Number(audio.readyAt))
        && Number.isFinite(Number(audio.endedAt)), audit.controller),
      check('AUDIO_METADATA_NOT_STORED', audit.storageMutations.length === 0
        && zeroAuthority(audit), audit)
    ];
  });
}

function vcap018() {
  return withHarness({ caseId: 'VCAP-018' }, (harness) => {
    dispatchStart(harness);
    harness.scheduler.advanceBy(260);
    const audit = harness.audit();
    return [
      check('QUALIFICATION_TIMER_NOT_READY_AUTHORITY', audit.recorder.startCount === 1
        && audit.view.phase === 'PREPARING'
        && audit.vibrationCount === 0, audit),
      check('QUALIFICATION_TIMER_ZERO_AUTHORITY', zeroAuthority(audit), audit)
    ];
  });
}

function vcap019() {
  return withHarness({ caseId: 'VCAP-019' }, (harness) => {
    dispatchStart(harness);
    const audit = harness.audit();
    return [
      check('PREPARING_VISIBLE_NOT_SEND', audit.view.phase === 'PREPARING'
        && /准备/.test([audit.view.title, audit.view.subtitle, audit.view.tip].join('|'))
        && !/松开发送|可以说了/.test([audit.view.title, audit.view.subtitle].join('|')), audit.view),
      check('PREPARING_NO_VIBRATION', audit.vibrationCount === 0, audit.vibrationCount)
    ];
  });
}

function vcap020() {
  return withHarness({ caseId: 'VCAP-020' }, (harness) => {
    dispatchStart(harness);
    harness.recorder.emitStart(0);
    const afterOnStart = harness.audit();
    harness.recorder.emitStart(0);
    harness.scheduler.advanceBy(699);
    const beforeBoundary = harness.audit();
    harness.scheduler.advanceBy(1);
    const atBoundary = harness.audit();
    return [
      check('ONSTART_ALONE_NOT_READY', afterOnStart.view.phase === 'POST_ONSTART_STABILIZING'
        && afterOnStart.vibrationCount === 0, afterOnStart),
      check('ONSTART_699MS_NOT_READY', beforeBoundary.view.phase === 'POST_ONSTART_STABILIZING'
        && beforeBoundary.vibrationCount === 0, beforeBoundary),
      check('ONSTART_700MS_READY_VIBRATE_ONCE', atBoundary.view.phase === 'READY_RECORDING'
        && atBoundary.vibrationCount === 1, atBoundary),
      check('READY_VISIBLE_COPY', /可以说了/.test(atBoundary.view.title)
        && /松开发送/.test(atBoundary.view.subtitle), atBoundary.view)
    ];
  });
}

function vcap021() {
  return withHarness({ caseId: 'VCAP-021' }, (harness) => {
    dispatchStart(harness);
    emitStartAndReachReady(harness, 0);
    dispatchEnd(harness);
    const audit = harness.audit();
    return [
      check('FINALIZING_AUDIO_COPY', audit.view.phase === 'FINALIZING_AUDIO'
        && /处理录音|正在生成录音/.test([audit.view.title, audit.view.subtitle].join('|'))
        && !/识别/.test([audit.view.title, audit.view.subtitle].join('|')), audit.view),
      check('FINALIZING_STOP_ONCE', audit.recorder.stopCount === 1, audit.recorder)
    ];
  });
}

function vcap022() {
  const poisoned = withHarness({ caseId: 'VCAP-022-POISONED' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    harness.recorder.emitStart(0);
    harness.recorder.emitError(0, 'operateRecorder:fail controlled start');
    const afterError = harness.audit();
    const heroAcceptedImmediately = dispatchStart(harness, 'hero', 2);
    const tabAcceptedImmediately = dispatchStart(harness, 'tab', 3);
    harness.scheduler.advanceBy(100);
    harness.scheduler.advanceBy(500);
    harness.scheduler.advanceBy(1000);
    harness.dashboard.page.onHide();
    harness.dashboard.page.onShow();
    harness.tab.__detach();
    harness.tab.__attach();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0, {
      duration: 1111,
      fileSize: 11111,
      tempFilePath: 'wxfile://poisoned-a.mp3'
    });
    harness.recorder.emitError(0, 'operateRecorder:fail late poisoned callback');
    const heroAcceptedAfterLifecycle = dispatchStart(harness, 'hero', 4);
    const tabAcceptedAfterLifecycle = dispatchStart(harness, 'tab', 5);
    harness.dashboard.page.onUnload();
    const tabAcceptedAfterSourceOwnerRelease = dispatchStart(harness, 'tab', 6);
    return {
      afterError,
      heroAcceptedAfterLifecycle,
      heroAcceptedImmediately,
      state: harness.audit(),
      tabAcceptedAfterLifecycle,
      tabAcceptedAfterSourceOwnerRelease,
      tabAcceptedImmediately
    };
  });
  const newProcess = withHarness({ caseId: 'VCAP-022-NEW-PROCESS' }, (harness) => {
    const cAccepted = dispatchStart(harness, 'hero', 7);
    emitStartAndReachReady(harness, 0);
    const cReady = harness.audit();
    dispatchEnd(harness, 'hero', 7);
    harness.recorder.emitStop(0, {
      duration: 3333,
      fileSize: 33333,
      tempFilePath: 'wxfile://file-c.mp3'
    });
    return { cAccepted, cReady, final: harness.audit() };
  });
  const audioC = newProcess.final.controller.audio || {};
  return [
    check('VCAP022.RECORDER_ERROR_POISONS_CURRENT_PROCESS', /ERROR|POISON|DESYNC|DRAIN/.test(
      poisoned.afterError.view.phase
    )
      && poisoned.heroAcceptedImmediately === false
      && poisoned.tabAcceptedImmediately === false
      && poisoned.heroAcceptedAfterLifecycle === false
      && poisoned.tabAcceptedAfterLifecycle === false
      && poisoned.tabAcceptedAfterSourceOwnerRelease === false
      && poisoned.state.recorder.startCount === 1
      && !poisoned.state.controller.audio, poisoned),
    check('VCAP022.POISON_IS_NOT_TIMER_OR_LIFECYCLE_RECOVERY', /ERROR|POISON|DESYNC|DRAIN/.test(
      poisoned.state.view.phase
    ) && poisoned.state.recorder.startCount === 1, poisoned.state),
    check('VCAP022.POISONED_UI_REQUIRES_PROCESS_RESTART', hasText(
      poisoned.afterError,
      /录音.*(暂时不可用|失败).*重新(进入|打开).*小程序|重新进入小程序/
    ), poisoned.afterError),
    check('VCAP022.ERROR_ZERO_AUDIO_AND_AUTHORITY', zeroAuthority(poisoned.state)
      && poisoned.state.storageMutations.length === 0
      && poisoned.state.businessMutation === false, poisoned.state),
    check('VCAP022.NEW_PROCESS_RECOVERS_FULL_AUDIO_PATH', newProcess.cAccepted === true
      && newProcess.cReady.view.phase === 'READY_RECORDING'
      && newProcess.cReady.vibrationCount === 1
      && newProcess.final.view.phase === 'AUDIO_READY'
      && Boolean(audioC.captureId)
      && Boolean(audioC.nativeLeaseId)
      && audioC.tempFilePath === 'wxfile://file-c.mp3'
      && Number(audioC.duration) === 3333
      && Number(audioC.fileSize) === 33333, newProcess),
    check('VCAP022.NEW_PROCESS_ZERO_BUSINESS_AUTHORITY', zeroAuthority(newProcess.final)
      && newProcess.final.storageMutations.length === 0, newProcess.final)
  ];
}

function vcap023() {
  return withHarness({ caseId: 'VCAP-023' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    emitStartAndReachReady(harness, 0);
    dispatchEnd(harness, 'hero', 1);
    harness.recorder.emitStop(0, { tempFilePath: '' });
    const afterMissingPath = harness.audit();
    dispatchStart(harness, 'hero', 2);
    const retry = harness.audit();
    return [
      check('STOP_ERROR_OR_NO_PATH_RECOVERS', afterMissingPath.view.phase === 'IDLE'
        && retry.recorder.startCount === 2, { afterMissingPath, retry }),
      check('NO_PATH_ZERO_AUTHORITY', zeroAuthority(afterMissingPath), afterMissingPath)
    ];
  });
}

function vcap024() {
  const source = fs.readFileSync(EVIDENCE_PATH, 'utf8');
  return [
    check('REAL_DEVICE_EVIDENCE_A_EXACT', /realReadyDelay`: `662ms`/.test(source)
      && /pressDuration`: `6234ms`/.test(source)
      && /reportedDuration`: `5729\.857921600342ms`/.test(source)
      && /fileSize`: `34301 bytes`/.test(source)
      && /原音开头实际听到：`总订水杯137个`/.test(source), source),
    check('REAL_DEVICE_EVIDENCE_B_EXACT', /realReadyDelay`: `377ms`/.test(source)
      && /pressDuration`: `9197ms`/.test(source)
      && /reportedDuration`: `8978\.640794754028ms`/.test(source)
      && /fileSize`: `53520 bytes`/.test(source)
      && /原音开头实际听到：`冯总订水杯137个`/.test(source), source),
    check('REAL_DEVICE_G_H_700MS_EXACT', /约611ms/.test(source)
      && /约704ms/.test(source)
      && /约328ms/.test(source)
      && /约702ms/.test(source)
      && /POST_ONSTART_STABILIZATION_SUPPORTED/.test(source)
      && /HAPTIC_ALLOWED/.test(source), source),
    check('SECOND_IPHONE_H_EXACT', /第二台 iPhone TEST-H（最终验收成功 run）/.test(source)
      && /约170ms/.test(source)
      && /约8756ms/.test(source)
      && /约8745ms/.test(source)
      && /约10\.8ms/.test(source)
      && /52436 bytes/.test(source)
      && /原音开头实际听到：`冯总订水杯137个`/.test(source), source),
    check('DEVICE_COVERAGE_MINIMUM_PASS_FROZEN', source.includes(
      'DEVICE_COVERAGE_MINIMUM_PASS = PASS'
    ) && source.includes('ANDROID_COVERAGE = PENDING'), source),
    check('ANDROID_COVERAGE_NOT_OVERCLAIMED', /当前证据仅覆盖两台 iPhone/.test(source)
      && /不能表述为跨平台完成/.test(source), source)
  ];
}

function ready001() {
  return withHarness({ caseId: 'VCAP-READY-001' }, (harness) => {
    dispatchStart(harness);
    const afterTouchStart = harness.audit();
    harness.scheduler.advanceBy(260);
    const afterLegacyThreshold = harness.audit();
    harness.scheduler.advanceBy(740);
    const afterTouchStart1000 = harness.audit();
    harness.scheduler.advanceBy(1000);
    const afterTouchStart2000 = harness.audit();
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const afterOnStart = harness.audit();
    harness.recorder.emitFrame(0, { frameBuffer: new ArrayBuffer(1024) });
    const afterFirstFrame = harness.audit();
    harness.recorder.emitFrame(0, { frameBuffer: new ArrayBuffer(1024) });
    harness.recorder.emitFrame(0, { frameBuffer: new ArrayBuffer(1024) });
    const afterThirdFrame = harness.audit();
    for (let index = 3; index < 32; index += 1) {
      harness.recorder.emitFrame(0, { frameBuffer: new ArrayBuffer(1024) });
    }
    const afterFrameBurst = harness.audit();
    harness.scheduler.advanceBy(699);
    const at699 = harness.audit();
    const timerSnapshots = harness.scheduler.snapshotsAfter(checkpoint);
    return [
      check('READY001.ONSTART_699MS_NOT_READY', at699.view.phase === 'POST_ONSTART_STABILIZING'
        && at699.vibrationCount === 0, at699),
      check('READY001.OLD_READY_AUTHORITIES_REJECTED', afterTouchStart.view.phase === 'PREPARING'
        && afterLegacyThreshold.view.phase === 'PREPARING'
        && afterTouchStart1000.view.phase === 'PREPARING'
        && afterTouchStart1000.vibrationCount === 0
        && afterTouchStart2000.view.phase === 'PREPARING'
        && afterTouchStart2000.vibrationCount === 0
        && afterOnStart.view.phase === 'POST_ONSTART_STABILIZING'
        && at699.view.phase === 'POST_ONSTART_STABILIZING', {
        afterLegacyThreshold,
        afterOnStart,
        afterTouchStart,
        afterTouchStart1000,
        afterTouchStart2000,
        at699
      }),
      check('READY001.ARBITRARY_FRAME_BURST_HAS_ZERO_READY_AUTHORITY', [
        afterFirstFrame,
        afterThirdFrame,
        afterFrameBurst
      ].every((entry) => entry.view.phase === 'POST_ONSTART_STABILIZING'
        && entry.vibrationCount === 0), {
        afterFirstFrame,
        afterFrameBurst,
        afterThirdFrame
      }),
      check('READY001.ONE_700MS_TIMER_FROM_LEGAL_ONSTART', timerSnapshots.length === 1
        && timerSnapshots[0].dueAt - harness.scheduler.now() === 1, timerSnapshots)
    ];
  });
}

function ready002() {
  return withHarness({ caseId: 'VCAP-READY-002' }, (harness) => {
    dispatchStart(harness);
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    harness.scheduler.advanceBy(699);
    const beforeBoundary = harness.audit();
    harness.scheduler.advanceBy(1);
    const atBoundary = harness.audit();
    const timerSnapshots = harness.scheduler.snapshotsAfter(checkpoint);
    return [
      check('READY002.BEFORE_700MS_NOT_READY', beforeBoundary.view.phase === 'POST_ONSTART_STABILIZING'
        && beforeBoundary.vibrationCount === 0, beforeBoundary),
      check('READY002.EXACT_700MS_READY', atBoundary.view.phase === 'READY_RECORDING'
        && atBoundary.vibrationCount === 1, atBoundary),
      check('READY002.TIMER_BOUNDARY_EXACT', timerSnapshots.length === 1
        && Number(timerSnapshots[0].dueAt) === 700, timerSnapshots)
    ];
  });
}

function ready003() {
  return withHarness({ caseId: 'VCAP-READY-003' }, (harness) => {
    dispatchStart(harness);
    const firstCheckpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const firstTimers = harness.scheduler.snapshotsAfter(firstCheckpoint);
    harness.scheduler.advanceBy(300);
    const duplicateCheckpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const duplicateTimers = harness.scheduler.snapshotsAfter(duplicateCheckpoint);
    harness.scheduler.advanceBy(399);
    const at699 = harness.audit();
    harness.scheduler.advanceBy(1);
    const at700 = harness.audit();
    harness.scheduler.advanceBy(700);
    const final = harness.audit();
    return [
      check('READY003.DUPLICATE_ONSTART_DOES_NOT_RESTART_TIMER', firstTimers.length === 1
        && duplicateTimers.length === 0
        && at699.view.phase === 'POST_ONSTART_STABILIZING'
        && at699.vibrationCount === 0, { at699, duplicateTimers, firstTimers }),
      check('READY003.READY_AND_HAPTIC_EXACTLY_ONCE', at700.view.phase === 'READY_RECORDING'
        && at700.vibrationCount === 1
        && final.view.phase === 'READY_RECORDING'
        && final.vibrationCount === 1, { at700, final })
    ];
  });
}

function ready004() {
  return withHarness({ caseId: 'VCAP-READY-004' }, (harness) => {
    dispatchStart(harness);
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timer = harness.scheduler.snapshotsAfter(checkpoint)[0] || null;
    harness.scheduler.advanceBy(300);
    const beforeRelease = harness.audit();
    dispatchEnd(harness);
    const afterRelease = harness.audit();
    harness.scheduler.invokeSnapshotAtDue(timer);
    harness.recorder.emitStop(0, {
      duration: 1111,
      fileSize: 11111,
      tempFilePath: 'wxfile://pre-ready-a.mp3'
    });
    const final = harness.audit();
    return [
      check('READY004.PRE_READY_RELEASE_INVALIDATES_TIMER', Boolean(timer)
        && timer.cancelled === true
        && beforeRelease.view.phase === 'POST_ONSTART_STABILIZING'
        && beforeRelease.vibrationCount === 0
        && afterRelease.recorder.stopCount === 1
        && afterRelease.vibrationCount === 0, { afterRelease, beforeRelease, timer }),
      check('READY004.CLEARED_TIMER_ZERO_READY', final.view.phase !== 'READY_RECORDING'
        && final.vibrationCount === 0
        && !final.controller.audio, final),
      check('READY004.PRE_READY_FILE_ZERO_AUTHORITY', zeroAuthority(final)
        && final.storageMutations.length === 0, final)
    ];
  });
}

function ready005() {
  const runPreparingSwipeCancel = (surface) => withHarness({
    caseId: `VCAP-READY-005-PREPARING-${surface.toUpperCase()}`,
    origin: surface === 'tab' ? 'records' : 'dashboard'
  }, (harness) => {
    dispatchStart(harness, surface);
    const beforeMove = harness.audit();
    const moveAccepted = harness.dispatch(surface, 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 340)
    ]));
    const afterMove = harness.audit();
    const slideBackBeforeStartAccepted = harness.dispatch(surface, 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 400)
    ]));
    const afterSlideBackBeforeStart = harness.audit();
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timersAfterStart = harness.scheduler.snapshotsAfter(checkpoint);
    const pendingAfterStart = harness.scheduler.pendingCount();
    const afterStart = harness.audit();
    const slideBackAfterStartAccepted = harness.dispatch(surface, 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 400)
    ]));
    const afterSlideBackAfterStart = harness.audit();
    harness.scheduler.advanceBy(700);
    const afterDue = harness.audit();
    dispatchEnd(harness, surface);
    const afterCancel = harness.audit();
    harness.recorder.emitStop(0, {
      duration: 1211,
      fileSize: 12111,
      tempFilePath: `wxfile://preparing-cancelled-${surface}.mp3`
    });
    return {
      afterCancel,
      afterDue,
      afterMove,
      afterSlideBackAfterStart,
      afterSlideBackBeforeStart,
      afterStart,
      beforeMove,
      final: harness.audit(),
      moveAccepted,
      pendingAfterStart,
      slideBackAfterStartAccepted,
      slideBackBeforeStartAccepted,
      timersAfterStart
    };
  });
  const heroPreparing = runPreparingSwipeCancel('hero');
  const tabPreparing = runPreparingSwipeCancel('tab');
  const stabilizing = withHarness({ caseId: 'VCAP-READY-005-STABILIZING' }, (harness) => {
    dispatchStart(harness);
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timer = harness.scheduler.snapshotsAfter(checkpoint)[0] || null;
    harness.scheduler.advanceBy(300);
    const beforeMove = harness.audit();
    const moveAccepted = harness.dispatch('hero', 'move', harness.touch.touchMove([
      harness.touch.point(1, 200, 340)
    ]));
    const afterMove = harness.audit();
    harness.scheduler.invokeSnapshotAtDue(timer);
    const afterDue = harness.audit();
    dispatchEnd(harness);
    const afterCancel = harness.audit();
    harness.recorder.emitStop(0, {
      duration: 1222,
      fileSize: 12222,
      tempFilePath: 'wxfile://cancelled-before-ready.mp3'
    });
    const final = harness.audit();
    return {
      afterCancel,
      afterDue,
      afterMove,
      beforeMove,
      final,
      moveAccepted,
      timer
    };
  });
  return [
    check('READY005.STABILIZING_SWIPE_CANCEL_ZERO_READY', Boolean(stabilizing.timer)
      && stabilizing.timer.cancelled === true
      && stabilizing.moveAccepted === true
      && stabilizing.beforeMove.view.phase === 'POST_ONSTART_STABILIZING'
      && (stabilizing.afterMove.view.gesture === 'cancel'
        || stabilizing.afterMove.view.phase === 'CANCEL_PENDING'
        || stabilizing.afterMove.view.phase === 'IDLE')
      && stabilizing.afterDue.view.phase !== 'READY_RECORDING'
      && stabilizing.afterDue.vibrationCount === 0
      && stabilizing.afterCancel.vibrationCount === 0
      && stabilizing.afterCancel.recorder.stopCount === 1, stabilizing),
    check('READY005.PREPARING_SWIPE_CANCEL_ZERO_READY_BOTH_SURFACES', [
      heroPreparing,
      tabPreparing
    ].every((entry) => entry.moveAccepted === true
      && entry.slideBackBeforeStartAccepted === true
      && entry.slideBackAfterStartAccepted === true
      && entry.beforeMove.view.phase === 'PREPARING'
      && entry.afterMove.controller.gesture === 'cancel'
      && entry.afterSlideBackBeforeStart.controller.gesture === 'cancel'
      && entry.afterStart.controller.phase === 'POST_ONSTART_STABILIZING'
      && entry.afterStart.controller.gesture === 'cancel'
      && entry.afterSlideBackAfterStart.controller.gesture === 'cancel'
      && entry.timersAfterStart.length === 0
      && entry.pendingAfterStart === 0
      && entry.afterDue.controller.phase !== 'READY_RECORDING'
      && entry.afterDue.vibrationCount === 0
      && entry.afterCancel.recorder.stopCount === 1
      && entry.final.view.phase !== 'READY_RECORDING'
      && !entry.final.controller.audio
      && zeroAuthority(entry.final)), { heroPreparing, tabPreparing }),
    check('READY005.CANCELLED_TIMER_AND_FILE_DISCARDED', stabilizing.final.vibrationCount === 0
      && stabilizing.final.view.phase !== 'READY_RECORDING'
      && !stabilizing.final.controller.audio
      && zeroAuthority(stabilizing.final), stabilizing.final)
  ];
}

function ready006() {
  const runLifecycle = (kind) => withHarness({
    caseId: `VCAP-READY-006-${kind}`,
    origin: kind === 'DETACH' ? 'records' : 'dashboard'
  }, (harness) => {
    const surface = kind === 'DETACH' ? 'tab' : 'hero';
    dispatchStart(harness, surface);
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timer = harness.scheduler.snapshotsAfter(checkpoint)[0] || null;
    harness.scheduler.advanceBy(300);
    if (kind === 'HIDE') harness.dashboard.page.onHide();
    if (kind === 'UNLOAD') harness.dashboard.page.onUnload();
    if (kind === 'DETACH') harness.tab.__detach();
    const afterLifecycle = harness.audit();
    harness.scheduler.invokeSnapshotAtDue(timer);
    harness.recorder.emitStop(0);
    return { afterLifecycle, final: harness.audit(), timer };
  });
  const hide = runLifecycle('HIDE');
  const unload = runLifecycle('UNLOAD');
  const detach = runLifecycle('DETACH');
  return [
    check('READY006.LIFECYCLE_REVOKES_STABILIZATION', [hide, unload, detach].every((entry) => (
      Boolean(entry.timer)
      && entry.timer.cancelled === true
      && entry.afterLifecycle.view.phase === 'IDLE'
      && entry.afterLifecycle.recorder.stopCount === 1
      && entry.afterLifecycle.vibrationCount === 0
    )), { detach, hide, unload }),
    check('READY006.LIFECYCLE_STALE_TIMER_ZERO_AUTHORITY', [hide, unload, detach].every((entry) => (
      entry.final.vibrationCount === 0
      && entry.final.view.phase !== 'READY_RECORDING'
      && !entry.final.controller.audio
      && zeroAuthority(entry.final)
    )), { detach, hide, unload })
  ];
}

function ready007() {
  const poisoned = withHarness({ caseId: 'VCAP-READY-007-POISON' }, (harness) => {
    dispatchStart(harness);
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timer = harness.scheduler.snapshotsAfter(checkpoint)[0] || null;
    harness.scheduler.advanceBy(300);
    harness.recorder.emitError(0, 'operateRecorder:fail poison during stabilization');
    const afterPoison = harness.audit();
    harness.scheduler.invokeSnapshotAtDue(timer);
    harness.scheduler.advanceBy(1000);
    return { afterPoison, final: harness.audit(), timer };
  });
  const desync = withHarness({ caseId: 'VCAP-READY-007-DESYNC' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    harness.recorder.emitStop(0, { tempFilePath: 'wxfile://early-stop.mp3' });
    const afterEarlyStop = harness.audit();
    const bAccepted = dispatchStart(harness, 'tab', 2);
    harness.recorder.emitStart(0);
    const cleanupPending = harness.audit();
    harness.scheduler.advanceBy(1000);
    harness.recorder.emitStop(0);
    return { afterEarlyStop, bAccepted, cleanupPending, final: harness.audit() };
  });
  return [
    check('READY007.POISON_REVOKES_STABILIZATION_TIMER', Boolean(poisoned.timer)
      && poisoned.timer.cancelled === true
      && poisoned.afterPoison.vibrationCount === 0
      && poisoned.final.vibrationCount === 0
      && poisoned.final.view.phase !== 'READY_RECORDING', poisoned),
    check('READY007.DESYNC_NEVER_GAINS_READY_AUTHORITY', desync.bAccepted === false
      && desync.afterEarlyStop.vibrationCount === 0
      && desync.cleanupPending.vibrationCount === 0
      && desync.final.vibrationCount === 0
      && !desync.final.controller.audio, desync),
    check('READY007.NATIVE_FAILURE_ZERO_BUSINESS_AUTHORITY', zeroAuthority(poisoned.final)
      && zeroAuthority(desync.final), { desync, poisoned })
  ];
}

function ready008() {
  return withHarness({ caseId: 'VCAP-READY-008' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    const aCheckpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timerA = harness.scheduler.snapshotsAfter(aCheckpoint)[0] || null;
    harness.scheduler.advanceBy(300);
    dispatchEnd(harness, 'hero', 1);
    harness.recorder.emitStop(0, {
      duration: 1111,
      fileSize: 11111,
      tempFilePath: 'wxfile://stale-a.mp3'
    });
    const aSettled = harness.audit();

    dispatchStart(harness, 'hero', 2);
    const bCheckpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(1);
    const timerB = harness.scheduler.snapshotsAfter(bCheckpoint)[0] || null;
    const bBeforeStale = harness.audit();
    harness.scheduler.invokeSnapshotAtDue(timerA);
    const bAfterStale = harness.audit();
    harness.scheduler.advanceBy(Math.max(0, Number(timerB && timerB.dueAt)
      - harness.scheduler.now()));
    const bReady = harness.audit();
    dispatchEnd(harness, 'hero', 2);
    harness.recorder.emitStop(1, {
      duration: 2222,
      fileSize: 22222,
      tempFilePath: 'wxfile://fresh-b.mp3'
    });
    const final = harness.audit();
    const audioB = final.controller.audio || {};
    return [
      check('READY008.STALE_A_TIMER_CANNOT_AUTHORIZE_B', Boolean(timerA)
        && Boolean(timerB)
        && timerA.cancelled === true
        && !aSettled.controller.audio
        && bBeforeStale.view.phase === 'POST_ONSTART_STABILIZING'
        && bBeforeStale.vibrationCount === 0
        && bAfterStale.view.phase === 'POST_ONSTART_STABILIZING'
        && bAfterStale.vibrationCount === 0
        && bAfterStale.controller.captureId === bBeforeStale.controller.captureId
        && bAfterStale.controller.nativeLeaseId === bBeforeStale.controller.nativeLeaseId,
      { aSettled, bAfterStale, bBeforeStale, timerA, timerB }),
      check('READY008.ONLY_B_TIMER_AUTHORIZES_B', bReady.view.phase === 'READY_RECORDING'
        && bReady.vibrationCount === 1, bReady),
      check('READY008.B_AUDIO_OWNS_B_IDENTITIES', final.view.phase === 'AUDIO_READY'
        && audioB.tempFilePath === 'wxfile://fresh-b.mp3'
        && audioB.captureId === bReady.controller.captureId
        && audioB.nativeLeaseId === bReady.controller.nativeLeaseId
        && zeroAuthority(final), { audioB, bReady, final })
    ];
  });
}

function ready009() {
  return withHarness({ caseId: 'VCAP-READY-009', vibrationThrows: true }, (harness) => {
    dispatchStart(harness);
    harness.recorder.emitStart(0);
    harness.scheduler.advanceBy(700);
    const afterReady = harness.audit();
    harness.recorder.emitStart(0);
    harness.scheduler.advanceBy(700);
    const afterDuplicate = harness.audit();
    dispatchEnd(harness);
    harness.recorder.emitStop(0, {
      duration: 2900,
      fileSize: 17400,
      tempFilePath: 'wxfile://haptic-throw.mp3'
    });
    const final = harness.audit();
    return [
      check('READY009.HAPTIC_THROW_DOES_NOT_REVOKE_READY', afterReady.view.phase === 'READY_RECORDING'
        && afterReady.vibrationCount === 1, afterReady),
      check('READY009.HAPTIC_ATTEMPT_EXACTLY_ONCE', afterDuplicate.view.phase === 'READY_RECORDING'
        && afterDuplicate.vibrationCount === 1, afterDuplicate),
      check('READY009.HAPTIC_FAILURE_AUDIO_PATH_SURVIVES', final.view.phase === 'AUDIO_READY'
        && final.recorder.stopCount === 1
        && Boolean(final.controller.audio)
        && zeroAuthority(final), final)
    ];
  });
}

function ready010() {
  return withHarness({ caseId: 'VCAP-READY-010' }, (harness) => {
    dispatchStart(harness);
    harness.recorder.emitStart(0);
    harness.scheduler.advanceBy(700);
    const ready = harness.audit();
    dispatchEnd(harness);
    dispatchEnd(harness);
    harness.dispatch('hero', 'cancel', harness.touch.touchEnd(1, 200, 400));
    const finalizing = harness.audit();
    harness.recorder.emitStop(0, {
      duration: 3333,
      fileSize: 33333,
      tempFilePath: 'wxfile://ready-010.mp3'
    });
    const final = harness.audit();
    const audio = final.controller.audio || {};
    return [
      check('READY010.READY_RELEASE_STOP_EXACTLY_ONCE', ready.view.phase === 'READY_RECORDING'
        && ready.vibrationCount === 1
        && finalizing.view.phase === 'FINALIZING_AUDIO'
        && finalizing.recorder.stopCount === 1, { finalizing, ready }),
      check('READY010.AUDIO_READY_DOUBLE_IDENTITY', final.view.phase === 'AUDIO_READY'
        && audio.captureId === ready.controller.captureId
        && audio.nativeLeaseId === ready.controller.nativeLeaseId
        && audio.tempFilePath === 'wxfile://ready-010.mp3'
        && Number(audio.duration) === 3333
        && Number(audio.fileSize) === 33333, { audio, ready }),
      check('READY010.ZERO_BUSINESS_AUTHORITY', zeroAuthority(final)
        && final.storageMutations.length === 0, final)
    ];
  });
}

function ready011() {
  const preparing = withHarness({ caseId: 'VCAP-READY-011-PREPARING' }, (harness) => {
    dispatchStart(harness);
    dispatchEnd(harness);
    const afterRelease = harness.audit();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0, {
      duration: 900,
      fileSize: 9000,
      tempFilePath: 'wxfile://preparing-discard.mp3'
    });
    return { afterRelease, final: harness.audit() };
  });
  const stabilizing = withHarness({ caseId: 'VCAP-READY-011-STABILIZING' }, (harness) => {
    dispatchStart(harness);
    const checkpoint = harness.scheduler.checkpoint();
    harness.recorder.emitStart(0);
    const timer = harness.scheduler.snapshotsAfter(checkpoint)[0] || null;
    harness.scheduler.advanceBy(699);
    const beforeRelease = harness.audit();
    dispatchEnd(harness);
    const afterRelease = harness.audit();
    harness.scheduler.invokeSnapshotAtDue(timer);
    harness.recorder.emitStop(0, {
      duration: 1999,
      fileSize: 19999,
      tempFilePath: 'wxfile://stabilizing-discard.mp3'
    });
    return { afterRelease, beforeRelease, final: harness.audit(), timer };
  });
  return [
    check('READY011.STABILIZING_RELEASE_DISCARDS_VALID_NATIVE_FILE', Boolean(stabilizing.timer)
      && stabilizing.timer.cancelled === true
      && stabilizing.beforeRelease.view.phase === 'POST_ONSTART_STABILIZING'
      && stabilizing.afterRelease.vibrationCount === 0
      && stabilizing.afterRelease.recorder.stopCount === 1
      && !stabilizing.final.controller.audio
      && stabilizing.final.view.phase !== 'AUDIO_READY', stabilizing),
    check('READY011.PREPARING_RELEASE_DISCARDS_VALID_NATIVE_FILE', preparing.afterRelease.recorder.stopCount === 1
      && preparing.afterRelease.vibrationCount === 0
      && !preparing.final.controller.audio
      && preparing.final.view.phase !== 'AUDIO_READY', preparing),
    check('READY011.VISIBLE_WAIT_FOR_HAPTIC_PROMPT', hasText(preparing.afterRelease, /请等震动后再说/)
      && hasText(stabilizing.afterRelease, /请等震动后再说/), { preparing, stabilizing }),
    check('READY011.PRE_READY_ZERO_AUTHORITY', zeroAuthority(preparing.final)
      && zeroAuthority(stabilizing.final), { preparing, stabilizing })
  ];
}

function ready012() {
  const capture = (surface, origin) => withHarness({
    caseId: `VCAP-READY-012-${surface}`,
    origin
  }, (harness) => {
    dispatchStart(harness, surface);
    harness.recorder.emitStart(0);
    const afterOnStart = harness.audit();
    harness.scheduler.advanceBy(699);
    const at699 = harness.audit();
    harness.scheduler.advanceBy(1);
    const at700 = harness.audit();
    return { afterOnStart, at699, at700 };
  });
  const hero = capture('hero', 'dashboard');
  const tab = capture('tab', 'records');
  return [
    check('READY012.HERO_TAB_699MS_NOT_READY', hero.afterOnStart.view.phase === 'POST_ONSTART_STABILIZING'
      && tab.afterOnStart.view.phase === 'POST_ONSTART_STABILIZING'
      && hero.at699.view.phase === 'POST_ONSTART_STABILIZING'
      && tab.at699.view.phase === 'POST_ONSTART_STABILIZING'
      && hero.at699.vibrationCount === 0
      && tab.at699.vibrationCount === 0, { hero, tab }),
    check('READY012.HERO_TAB_700MS_READY_EQUAL', hero.at700.view.phase === 'READY_RECORDING'
      && tab.at700.view.phase === 'READY_RECORDING'
      && hero.at700.vibrationCount === 1
      && tab.at700.vibrationCount === 1
      && JSON.stringify(hero.at700.recorder.options) === JSON.stringify(tab.at700.recorder.options),
    { hero, tab })
  ];
}

function green001() {
  const recorder = createControlledRecorderManager();
  const events = [];
  recorder.manager.onStart(() => events.push('START'));
  recorder.manager.onStop((payload) => events.push(`STOP:${payload.tempFilePath}`));
  recorder.manager.start({ format: 'mp3', sampleRate: 16000 });
  recorder.emitStart(0);
  recorder.manager.stop();
  recorder.emitStop(0, { tempFilePath: 'wxfile://green.mp3' });
  const audit = recorder.audit();
  return [check('CONTROLLED_RECORDER_SELF_TEST', audit.startCount === 1
    && audit.stopCount === 1
    && events.join('|') === 'START|STOP:wxfile://green.mp3', { audit, events })];
}

function green002() {
  const bindings = extractBindings();
  const files = fs.readdirSync(POC_ROOT, { recursive: true })
    .filter((entry) => /\.(js|json|md|wxml|wxss)$/.test(entry))
    .map((entry) => path.join(POC_ROOT, entry));
  const source = files.map((filename) => fs.readFileSync(filename, 'utf8')).join('\n');
  const javascriptSource = files.filter((filename) => filename.endsWith('.js'))
    .map((filename) => fs.readFileSync(filename, 'utf8')).join('\n');
  return [
    check('REAL_WXML_TOUCH_BINDINGS_PRESENT', ['start', 'move', 'end', 'cancel'].every((key) => (
      Boolean(bindings.hero[key]) && Boolean(bindings.tab[key])
    )), bindings),
    check('POC_DIAGNOSTIC_ISOLATED', source.includes('DIAGNOSTIC_ONLY')
      && javascriptSource.includes('getRecorderManager')
      && !/requirePlugin|getRecordRecognitionManager|parseHybridInput|saveConfirmedDraft/.test(
        javascriptSource
      ), {
      fileCount: files.length,
      phrase: PHRASE
    })
  ];
}

function green003() {
  return withHarness({ caseId: 'GREEN-VCAP-003' }, (harness) => {
    const audit = harness.audit();
    return [check('PAGE_COMPONENT_VM_ZERO_MUTATION_SMOKE', audit.recorder.startCount === 0
      && zeroAuthority(audit)
      && audit.storageMutations.length === 0, audit)];
  });
}

const EXECUTORS = {
  'VCAP-001': vcap001,
  'VCAP-002': vcap002,
  'VCAP-003': vcap003,
  'VCAP-004': vcap004,
  'VCAP-005': vcap005,
  'VCAP-006': vcap006,
  'VCAP-007': vcap007,
  'VCAP-008': vcap008,
  'VCAP-009': vcap009,
  'VCAP-010': vcap010,
  'VCAP-011': vcap011,
  'VCAP-012': vcap012,
  'VCAP-013': vcap013,
  'VCAP-014': vcap014,
  'VCAP-015': vcap015,
  'VCAP-016': vcap016,
  'VCAP-017': vcap017,
  'VCAP-018': vcap018,
  'VCAP-019': vcap019,
  'VCAP-020': vcap020,
  'VCAP-021': vcap021,
  'VCAP-022': vcap022,
  'VCAP-023': vcap023,
  'VCAP-024': vcap024,
  'VCAP-READY-001': ready001,
  'VCAP-READY-002': ready002,
  'VCAP-READY-003': ready003,
  'VCAP-READY-004': ready004,
  'VCAP-READY-005': ready005,
  'VCAP-READY-006': ready006,
  'VCAP-READY-007': ready007,
  'VCAP-READY-008': ready008,
  'VCAP-READY-009': ready009,
  'VCAP-READY-010': ready010,
  'VCAP-READY-011': ready011,
  'VCAP-READY-012': ready012,
  'GREEN-VCAP-001': green001,
  'GREEN-VCAP-002': green002,
  'GREEN-VCAP-003': green003
};

async function executeCase(contract) {
  const executor = EXECUTORS[contract.id];
  if (!executor) throw Object.assign(new Error(`Unknown VCAP case ${contract.id}`), {
    code: 'TEST_DATA_ERROR'
  });
  return result(contract, await executor());
}

module.exports = { check, executeCase };
