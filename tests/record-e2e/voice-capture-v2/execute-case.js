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
  harness.recorder.emitStart(0);
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
    harness.recorder.emitStart(0);
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
    harness.recorder.emitStart(0);
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
    harness.recorder.emitStart(0);
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
    harness.recorder.emitStart(0);
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
    harness.recorder.emitStart(0);
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
    harness.dispatch('hero', 'cancel', harness.touch.touchEnd(1, 200, 400));
    dispatchStart(harness, 'hero', 2);
    harness.recorder.emitStart(1);
    harness.recorder.emitStop(0, { tempFilePath: 'wxfile://stale-a.mp3' });
    const afterStale = harness.audit();
    dispatchEnd(harness, 'hero', 2);
    harness.recorder.emitStop(1, { tempFilePath: 'wxfile://current-b.mp3' });
    const final = harness.audit();
    return [
      check('STALE_RECORDER_CALLBACK_IGNORED', afterStale.view.phase === 'READY_RECORDING'
        && final.view.phase === 'AUDIO_READY', { afterStale, final }),
      check('STALE_CALLBACK_ZERO_AUTHORITY', zeroAuthority(final), final)
    ];
  });
}

function vcap017() {
  return withHarness({ caseId: 'VCAP-017' }, (harness) => {
    dispatchStart(harness);
    harness.recorder.emitStart(0);
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
    harness.recorder.emitStart(0);
    const audit = harness.audit();
    return [
      check('ONSTART_READY_VIBRATE_ONCE', audit.view.phase === 'READY_RECORDING'
        && audit.vibrationCount === 1, audit),
      check('READY_VISIBLE_COPY', /可以说了/.test(audit.view.title)
        && /松开发送/.test(audit.view.subtitle), audit.view)
    ];
  });
}

function vcap021() {
  return withHarness({ caseId: 'VCAP-021' }, (harness) => {
    dispatchStart(harness);
    harness.recorder.emitStart(0);
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
  return withHarness({ caseId: 'VCAP-022' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    harness.recorder.emitError(0, 'operateRecorder:fail controlled start');
    const afterError = harness.audit();
    dispatchStart(harness, 'hero', 2);
    const retry = harness.audit();
    return [
      check('START_ERROR_RECOVERS_IDLE', afterError.view.phase === 'IDLE'
        && retry.recorder.startCount === 2, { afterError, retry }),
      check('START_ERROR_VISIBLE', hasText(afterError, /录音.*失败|请重试/), afterError)
    ];
  });
}

function vcap023() {
  return withHarness({ caseId: 'VCAP-023' }, (harness) => {
    dispatchStart(harness, 'hero', 1);
    harness.recorder.emitStart(0);
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
    check('DEVICE_WARMUP_VERDICT_FROZEN', source.includes('DEVICE_RECORDER_WARMUP_REQUIRED')
      && source.includes('DEVICE_COVERAGE_PENDING'), source)
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
