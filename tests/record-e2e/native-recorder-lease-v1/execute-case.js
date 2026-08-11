const { safeClone } = require('../../../utils/record-state-diff');
const { proveControlledCallbackSnapshots } = require('./recorder-runtime');
const {
  audioPayload,
  cancel,
  controllerSource,
  end,
  extractBindings,
  functionBody,
  snapshot,
  start,
  withHarness
} = require('./runtime');

function check(code, pass, actual) {
  return { actual: safeClone(actual), code, pass: pass === true };
}

function zeroAuthority(value) {
  return value.handoffCount === 0
    && !value.navigation.includes('/pages/input/input')
    && value.businessMutation === false
    && value.legacyStartCount === 0
    && value.storageMutationCount === 0;
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

function lease001() {
  return withHarness({ caseId: 'LEASE-001' }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitStart(0);
    end(harness, 'hero', 1);
    harness.recorder.emitStop(0, audioPayload('A'));
    const afterA = snapshot(harness);
    const bAccepted = start(harness, 'hero', 2);
    const afterB = snapshot(harness);
    return [
      check('LEASE001.A_AUDIO_BOUND_TO_A', afterA.phase === 'AUDIO_READY'
        && afterA.audio && afterA.audio.tempFilePath === audioPayload('A').tempFilePath, afterA),
      check('LEASE001.B_STARTS_ONLY_AFTER_A_SETTLED', bAccepted === true
        && afterB.recorder.startCount === 2 && afterB.phase === 'PREPARING', afterB)
    ];
  });
}

function lease002() {
  return withHarness({ caseId: 'LEASE-002' }, (harness) => {
    start(harness, 'hero', 1);
    cancel(harness, 'hero', 1);
    const bAcceptedWhilePending = start(harness, 'hero', 2);
    const pending = snapshot(harness);
    harness.recorder.emitStart(0);
    const afterLateStart = snapshot(harness);
    harness.recorder.emitStop(0, audioPayload('A'));
    const bAcceptedAfterSettle = start(harness, 'hero', 3);
    const settled = snapshot(harness);
    return [
      check('LEASE002.B_BLOCKED_WHILE_A_PENDING', bAcceptedWhilePending === false
        && pending.recorder.startCount === 1, pending),
      check('LEASE002.A_LATE_START_ZERO_READY', afterLateStart.vibrationCount === 0
        && afterLateStart.phase === 'IDLE', afterLateStart),
      check('LEASE002.B_ALLOWED_AFTER_A_SETTLED', bAcceptedAfterSettle === true
        && settled.recorder.startCount === 2 && settled.phase === 'PREPARING', settled)
    ];
  });
}

function lease003() {
  return withHarness({ caseId: 'LEASE-003' }, (harness) => {
    start(harness, 'hero', 1);
    cancel(harness, 'hero', 1);
    const bAccepted = start(harness, 'hero', 2);
    const before = snapshot(harness);
    harness.recorder.emitStart(0);
    const after = snapshot(harness);
    const bAcceptedWhileTerminalPending = start(harness, 'tab', 3);
    const terminalPending = snapshot(harness);
    harness.recorder.emitStop(0, audioPayload('A'));
    const bAcceptedAfterSettle = start(harness, 'hero', 4);
    const settled = snapshot(harness);
    return [
      check('LEASE003.B_CANNOT_EXIST_WHILE_A_LEASE_PENDING', bAccepted === false
        && before.recorder.startCount === 1, before),
      check('LEASE003.STALE_ONSTART_CANNOT_READY_B', after.phase === 'IDLE'
        && after.captureId === '' && after.vibrationCount === 0, { after, before }),
      check('LEASE003.STALE_ONSTART_ZERO_VIBRATION', after.vibrationCount === before.vibrationCount, { after, before }),
      check('LEASE003.LATE_START_CLEANUP_STILL_BLOCKS_B', bAcceptedWhileTerminalPending === false
        && terminalPending.recorder.startCount === 1
        && terminalPending.recorder.stopCount === 1
        && terminalPending.audio === null, terminalPending),
      check('LEASE003.B_STARTS_AFTER_A_TERMINAL', bAcceptedAfterSettle === true
        && settled.phase === 'PREPARING' && settled.recorder.startCount === 2, settled)
    ];
  });
}

function lease004() {
  return withHarness({ caseId: 'LEASE-004' }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitError(0, 'operateRecorder:fail A terminal');
    const bAccepted = start(harness, 'hero', 2);
    if (bAccepted) {
      harness.recorder.emitStart(1);
      end(harness, 'hero', 2);
    }
    harness.recorder.emitStop(0, audioPayload('A'));
    const afterAStop = snapshot(harness);
    harness.scheduler.advanceBy(1600);
    harness.dashboard.page.onHide();
    harness.dashboard.page.onShow();
    const cAccepted = start(harness, 'hero', 3);
    const poisoned = snapshot(harness);
    return [
      check('LEASE004.FILE_A_NEVER_BINDS_B', !(afterAStop.phase === 'AUDIO_READY'
        && afterAStop.audio
        && afterAStop.audio.tempFilePath === audioPayload('A').tempFilePath), afterAStop),
      check('LEASE004.ERROR_EPOCH_BLOCKS_B_NATIVE_START', bAccepted === false
        && afterAStop.recorder.startCount === 1, afterAStop),
      check('LEASE004.LATE_TERMINAL_CANNOT_CLEAR_ERROR_EPOCH', cAccepted === false
        && poisoned.recorder.startCount === 1
        && /DESYNC|DRAIN|ERROR/.test(poisoned.phase), poisoned),
      check('LEASE004.FILE_A_METADATA_NEVER_PROJECTS_AS_B', !afterAStop.audio || !(
        afterAStop.audio.tempFilePath === audioPayload('A').tempFilePath
        && afterAStop.audio.duration === audioPayload('A').duration
        && afterAStop.audio.fileSize === audioPayload('A').fileSize
        && afterAStop.captureId
      ), afterAStop)
    ];
  });
}

function lease005() {
  return withHarness({ caseId: 'LEASE-005' }, (harness) => {
    start(harness, 'hero', 1);
    cancel(harness, 'hero', 1);
    const before = snapshot(harness);
    const accepted = start(harness, 'tab', 2);
    const after = snapshot(harness);
    return [
      check('LEASE005.ACTIVE_NATIVE_LEASE_BLOCKS_B_START', accepted === false
        && before.recorder.startCount === 1 && after.recorder.startCount === 1, { after, before }),
      check('LEASE005.B_INTENT_ZERO_AUTHORITY', zeroAuthority(after), after)
    ];
  });
}

function lease006() {
  return withHarness({ caseId: 'LEASE-006' }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitStart(0);
    harness.recorder.emitStart(0);
    end(harness, 'hero', 1);
    harness.recorder.emitStop(0, audioPayload('A'));
    harness.recorder.emitStop(0, audioPayload('A'));
    const afterA = snapshot(harness);
    const bAccepted = start(harness, 'hero', 2);
    harness.recorder.emitStart(1);
    end(harness, 'hero', 2);
    harness.recorder.emitStop(1, audioPayload('B'));
    const final = snapshot(harness);
    return [
      check('LEASE006.A_DUPLICATES_SETTLE_ONCE', afterA.phase === 'AUDIO_READY'
        && afterA.vibrationCount === 1
        && afterA.audio && afterA.audio.tempFilePath === audioPayload('A').tempFilePath, afterA),
      check('LEASE006.B_STARTS_AFTER_A_DUPLICATES_SETTLED', bAccepted === true
        && final.recorder.startCount === 2, final),
      check('LEASE006.B_FINAL_OWN_AUDIO', final.audio
        && final.audio.tempFilePath === audioPayload('B').tempFilePath
        && final.audio.duration === audioPayload('B').duration
        && final.audio.fileSize === audioPayload('B').fileSize, final)
    ];
  });
}

function lease007() {
  return withHarness({ caseId: 'LEASE-007' }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitStop(0, audioPayload('A'));
    const afterEarlyStop = snapshot(harness);
    harness.recorder.emitStart(0);
    const afterLateStart = snapshot(harness);
    return [
      check('LEASE007.EARLY_STOP_FAILS_CLOSED_NOT_PREPARING', afterEarlyStop.phase !== 'PREPARING', afterEarlyStop),
      check('LEASE007.LATE_START_ZERO_READY', afterLateStart.phase !== 'READY_RECORDING'
        && afterLateStart.vibrationCount === 0, afterLateStart),
      check('LEASE007.ZERO_AUTHORITY', zeroAuthority(afterLateStart), afterLateStart)
    ];
  });
}

function lease008() {
  return withHarness({ caseId: 'LEASE-008' }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitStop(0, audioPayload('A'));
    const desync = snapshot(harness);
    const bAcceptedAfterEarlyStop = start(harness, 'hero', 2);
    harness.recorder.emitStart(0);
    const cleanupPending = snapshot(harness);
    const bAcceptedWhileCleanupPending = start(harness, 'tab', 3);
    harness.recorder.emitStart(0);
    const duplicateLateStart = snapshot(harness);
    harness.recorder.emitStop(0, audioPayload('A-CLEANUP'));
    const drained = snapshot(harness);
    const cAccepted = start(harness, 'hero', 4);
    harness.recorder.emitStart(1);
    const cReady = snapshot(harness);
    end(harness, 'hero', 4);
    harness.recorder.emitStop(1, audioPayload('C'));
    const recovered = snapshot(harness);
    return [
      check('LEASE008.EARLY_STOP_ENTERS_DESYNC', /DESYNC|DRAIN|ERROR/.test(desync.phase)
        && desync.audio === null, desync),
      check('LEASE008.EARLY_STOP_BLOCKS_B_START', bAcceptedAfterEarlyStop === false
        && cleanupPending.recorder.startCount === 1, cleanupPending),
      check('LEASE008.LATE_START_REQUIRES_CLEANUP_TERMINAL', /DESYNC|DRAIN|ERROR/.test(cleanupPending.phase)
        && cleanupPending.recorder.stopCount === 1
        && cleanupPending.audio === null, cleanupPending),
      check('LEASE008.CLEANUP_PENDING_BLOCKS_B_AND_STOPS_ONCE', bAcceptedWhileCleanupPending === false
        && duplicateLateStart.recorder.startCount === 1
        && duplicateLateStart.recorder.stopCount === 1
        && duplicateLateStart.audio === null, duplicateLateStart),
      check('LEASE008.CLEANUP_TERMINAL_REACHES_IDLE', drained.phase === 'IDLE'
        && drained.captureId === '' && drained.vibrationCount === 0
        && drained.audio === null, drained),
      check('LEASE008.RECOVERY_ALLOWS_C_START', cAccepted === true
        && cReady.recorder.startCount === 2, cReady),
      check('LEASE008.C_OWN_CALLBACKS_COMPLETE', cReady.phase === 'READY_RECORDING'
        && recovered.phase === 'AUDIO_READY'
        && recovered.audio && recovered.audio.tempFilePath === audioPayload('C').tempFilePath
        && recovered.audio.duration === audioPayload('C').duration
        && recovered.audio.fileSize === audioPayload('C').fileSize,
      { cReady, recovered }),
      check('LEASE008.RECOVERY_ZERO_STALE_AUTHORITY', zeroAuthority(recovered), recovered)
    ];
  });
}

function lease009() {
  const poisoned = withHarness({ caseId: 'LEASE-009-POISON' }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitError(0, 'operateRecorder:fail A terminal');
    const bAccepted = start(harness, 'hero', 2);
    harness.scheduler.advanceBy(100);
    harness.scheduler.advanceBy(500);
    harness.scheduler.advanceBy(1000);
    harness.dashboard.page.onHide();
    harness.dashboard.page.onShow();
    harness.tab.__detach();
    harness.tab.__attach();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0, audioPayload('A-LATE'));
    harness.recorder.emitError(0, 'operateRecorder:fail A late error');
    const afterLifecycleAccepted = start(harness, 'hero', 3);
    const tabAccepted = start(harness, 'tab', 4);
    harness.dashboard.page.onUnload();
    const tabAcceptedAfterSourceOwnerRelease = start(harness, 'tab', 5);
    return {
      afterLifecycleAccepted,
      bAccepted,
      state: snapshot(harness),
      tabAccepted,
      tabAcceptedAfterSourceOwnerRelease
    };
  });
  const newProcess = withHarness({ caseId: 'LEASE-009-NEW-PROCESS' }, (harness) => {
    const cAccepted = start(harness, 'hero', 3);
    harness.recorder.emitStart(0);
    const ready = snapshot(harness);
    end(harness, 'hero', 3);
    harness.recorder.emitStop(0, audioPayload('C'));
    return { cAccepted, ready, state: snapshot(harness) };
  });
  return [
    check('LEASE009.ERROR_POISONS_CURRENT_NATIVE_EPOCH', poisoned.bAccepted === false
      && poisoned.afterLifecycleAccepted === false
      && poisoned.tabAccepted === false
      && poisoned.tabAcceptedAfterSourceOwnerRelease === false
      && poisoned.state.recorder.startCount === 1
      && /DESYNC|DRAIN|ERROR/.test(poisoned.state.phase), poisoned),
    check('LEASE009.NEW_PROCESS_RECOVERS_DETERMINISTICALLY', newProcess.cAccepted === true
      && newProcess.ready.phase === 'READY_RECORDING'
      && newProcess.state.phase === 'AUDIO_READY'
      && newProcess.state.audio
      && newProcess.state.audio.tempFilePath === audioPayload('C').tempFilePath, newProcess),
    check('LEASE009.ERROR_ZERO_AUTHORITY', zeroAuthority(poisoned.state)
      && zeroAuthority(newProcess.state), { newProcess, poisoned })
  ];
}

function lease010() {
  return withHarness({ caseId: 'LEASE-010' }, (harness) => {
    start(harness, 'hero', 1);
    harness.dashboard.page.onHide();
    const tabAcceptedBeforeSettle = start(harness, 'tab', 2);
    const pending = snapshot(harness);
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0, audioPayload('A'));
    const tabAcceptedAfterSettle = start(harness, 'tab', 3);
    const settled = snapshot(harness);
    return [
      check('LEASE010.LIFECYCLE_INVALIDATES_USER_NOT_NATIVE_LEASE', tabAcceptedBeforeSettle === false
        && pending.recorder.startCount === 1, pending),
      check('LEASE010.NEXT_OWNER_AFTER_SETTLE', tabAcceptedAfterSettle === true
        && settled.recorder.startCount === 2 && settled.surface === 'CUSTOM_TAB_CENTER', settled)
    ];
  });
}

function lease011() {
  return withHarness({ caseId: 'LEASE-011' }, (harness) => {
    start(harness, 'hero', 1);
    const state = snapshot(harness);
    const leaseId = String(state.nativeLeaseId || state.audio && state.audio.nativeLeaseId || '');
    return [
      check('LEASE011.USER_CAPTURE_ID_PRESENT', Boolean(state.captureId), state),
      check('LEASE011.NATIVE_LEASE_ID_PRESENT_AND_DISTINCT', Boolean(leaseId)
        && leaseId !== state.captureId, { captureId: state.captureId, leaseId }),
      check('LEASE011.OWNER_SURFACE_DISTINCT', state.surface === 'DASHBOARD_HERO', state.surface)
    ];
  });
}

function lease012() {
  return withHarness({ caseId: 'LEASE-012' }, (harness) => {
    start(harness, 'hero', 1);
    const beforeStart = snapshot(harness);
    harness.recorder.emitStart(0);
    const ready = snapshot(harness);
    end(harness, 'hero', 1);
    harness.recorder.emitStop(0, audioPayload('A'));
    const audioReady = snapshot(harness);
    return [
      check('LEASE012.NATIVE_LEASE_ID_STABLE', Boolean(beforeStart.nativeLeaseId)
        && beforeStart.nativeLeaseId === ready.nativeLeaseId
        && beforeStart.captureId === ready.captureId
        && beforeStart.nativeLeaseId !== beforeStart.captureId,
      { beforeStart, ready }),
      check('LEASE012.AUDIO_READY_REQUIRES_DUAL_IDENTITY', audioReady.phase === 'AUDIO_READY'
        && audioReady.audio
        && audioReady.audio.captureId === beforeStart.captureId
        && audioReady.audio.nativeLeaseId === beforeStart.nativeLeaseId, audioReady),
      check('LEASE012.AUDIO_METADATA_BOUND_TO_SAME_LEASE', audioReady.audio
        && audioReady.audio.tempFilePath === audioPayload('A').tempFilePath
        && audioReady.audio.duration === audioPayload('A').duration
        && audioReady.audio.fileSize === audioPayload('A').fileSize, audioReady),
      check('LEASE012.ZERO_WRONG_FILE_AUTHORITY', zeroAuthority(audioReady), audioReady)
    ];
  });
}

function lease013() {
  return withHarness({ caseId: 'LEASE-013' }, (harness) => {
    start(harness, 'hero', 1);
    const before = snapshot(harness);
    const accepted = start(harness, 'tab', 2);
    const after = snapshot(harness);
    return [
      check('LEASE013.B_INTENT_DOES_NOT_STEAL_A', accepted === false
        && after.captureId === before.captureId
        && after.surface === before.surface
        && after.recorder.startCount === 1, { after, before })
    ];
  });
}

function lease014() {
  const source = controllerSource();
  const bodies = ['handleRecorderStart', 'handleRecorderStop', 'handleRecorderError']
    .map((name) => ({ body: functionBody(source, name), name }));
  return [
    check('LEASE014.CALLBACKS_RESOLVE_NATIVE_LEASE', source.length > 0
      && bodies.every((entry) => /(native\w*lease|resolveNative|attribut)/i.test(entry.body)), bodies),
    check('LEASE014.CALLBACKS_DO_NOT_DEFAULT_TO_ACTIVE_CAPTURE', bodies.every((entry) => (
      !/const\s+capture\s*=\s*activeCapture/.test(entry.body)
    )), bodies)
  ];
}

function lease015() {
  return withHarness({ caseId: 'LEASE-015', origin: 'records' }, (harness) => {
    start(harness, 'hero', 1);
    const tabAcceptedWhileA = start(harness, 'tab', 2);
    const pending = snapshot(harness);
    cancel(harness, 'hero', 1);
    harness.recorder.emitStop(0, audioPayload('A'));
    const tabAcceptedAfterA = start(harness, 'tab', 3);
    const settled = snapshot(harness);
    return [
      check('LEASE015.HERO_TAB_SHARE_ONE_NATIVE_LEASE', tabAcceptedWhileA === false
        && pending.recorder.startCount === 1, pending),
      check('LEASE015.TAB_STARTS_AFTER_HERO_SETTLES', tabAcceptedAfterA === true
        && settled.recorder.startCount === 2, settled)
    ];
  });
}

function stopFailureScenario(caseId, mode) {
  return withHarness({ caseId }, (harness) => {
    start(harness, 'hero', 1);
    harness.recorder.emitStart(0);
    if (mode === 'THROW') {
      harness.recorder.manager.stop = () => {
        throw new Error('operateRecorder:fail controlled stop throw');
      };
    } else {
      harness.recorder.manager.stop = undefined;
    }
    end(harness, 'hero', 1);
    const bAccepted = start(harness, 'hero', 2);
    harness.scheduler.advanceBy(100);
    harness.scheduler.advanceBy(500);
    harness.scheduler.advanceBy(1000);
    harness.dashboard.page.onHide();
    harness.dashboard.page.onShow();
    harness.tab.__detach();
    harness.tab.__attach();
    harness.recorder.emitStart(0);
    harness.recorder.emitStop(0, audioPayload(`${caseId}-LATE`));
    harness.recorder.emitError(0, `operateRecorder:fail ${caseId} late`);
    const cAccepted = start(harness, 'hero', 3);
    const tabAccepted = start(harness, 'tab', 4);
    harness.dashboard.page.onUnload();
    const tabAcceptedAfterSourceOwnerRelease = start(harness, 'tab', 5);
    return {
      bAccepted,
      cAccepted,
      state: snapshot(harness),
      tabAccepted,
      tabAcceptedAfterSourceOwnerRelease
    };
  });
}

function freshProcessAudioScenario(caseId) {
  return withHarness({ caseId }, (harness) => {
    const accepted = start(harness, 'hero', 9);
    harness.recorder.emitStart(0);
    const ready = snapshot(harness);
    end(harness, 'hero', 9);
    harness.recorder.emitStop(0, audioPayload('C'));
    return { accepted, ready, state: snapshot(harness) };
  });
}

function lease016() {
  const staleStart = withHarness({ caseId: 'LEASE-016-START' }, (harness) => {
    start(harness, 'hero', 1);
    cancel(harness, 'hero', 1);
    const bAccepted = start(harness, 'hero', 2);
    const before = snapshot(harness);
    harness.recorder.emitStart(0);
    const after = snapshot(harness);
    harness.recorder.emitStop(0, audioPayload('A'));
    return { after, bAccepted, before };
  });
  const stopThrow = stopFailureScenario('LEASE-016-STOP-THROW', 'THROW');
  const stopMissing = stopFailureScenario('LEASE-016-STOP-MISSING', 'MISSING');
  const throwNewProcess = freshProcessAudioScenario('LEASE-016-THROW-NEW-PROCESS');
  const missingNewProcess = freshProcessAudioScenario('LEASE-016-MISSING-NEW-PROCESS');
  const callbackControl = proveControlledCallbackSnapshots();
  const bindings = extractBindings();
  return [
    check('LEASE016.PENDING_A_BLOCKS_B_AND_STALE_START', staleStart.bAccepted === false
      && staleStart.after.phase === 'IDLE'
      && staleStart.after.vibrationCount === staleStart.before.vibrationCount, staleStart),
    check('LEASE016.STOP_THROW_QUARANTINES_NATIVE_EPOCH', stopThrow.bAccepted === false
      && stopThrow.cAccepted === false
      && stopThrow.tabAccepted === false
      && stopThrow.tabAcceptedAfterSourceOwnerRelease === false
      && stopThrow.state.recorder.startCount === 1
      && /DESYNC|DRAIN|ERROR/.test(stopThrow.state.phase)
      && zeroAuthority(stopThrow.state), stopThrow),
    check('LEASE016.STOP_MISSING_QUARANTINES_NATIVE_EPOCH', stopMissing.bAccepted === false
      && stopMissing.cAccepted === false
      && stopMissing.tabAccepted === false
      && stopMissing.tabAcceptedAfterSourceOwnerRelease === false
      && stopMissing.state.recorder.startCount === 1
      && /DESYNC|DRAIN|ERROR/.test(stopMissing.state.phase)
      && zeroAuthority(stopMissing.state), stopMissing),
    check('LEASE016.STOP_FAILURE_NEW_PROCESS_RECOVERS', [throwNewProcess, missingNewProcess].every((probe) => (
      probe.accepted === true
      && probe.ready.phase === 'READY_RECORDING'
      && probe.state.phase === 'AUDIO_READY'
      && probe.state.audio
      && probe.state.audio.tempFilePath === audioPayload('C').tempFilePath
      && zeroAuthority(probe.state)
    )), { missingNewProcess, throwNewProcess }),
    check('LEASE016.HARNESS_CALLBACK_INDEX_CONTROL', callbackControl.startCount === 2
      && callbackControl.events.join(',') === 'A_START,A_STOP,A_ERROR,B_START,B_STOP,B_ERROR', callbackControl),
    check('LEASE016.REAL_WXML_BINDINGS_PRESENT', Boolean(bindings.hero.start)
      && Boolean(bindings.hero.end) && Boolean(bindings.tab.start) && Boolean(bindings.tab.end), bindings)
  ];
}

function greenLease001() {
  const callbackControl = proveControlledCallbackSnapshots();
  return [
    check('GREEN_LEASE001.CONTROLLED_CALLBACK_SNAPSHOTS', callbackControl.startCount === 2
      && callbackControl.events.join(',') === 'A_START,A_STOP,A_ERROR,B_START,B_STOP,B_ERROR', callbackControl)
  ];
}

function greenLease002() {
  const bindings = extractBindings();
  return [
    check('GREEN_LEASE002.REAL_WXML_BINDINGS', ['start', 'move', 'end', 'cancel'].every((eventName) => (
      Boolean(bindings.hero[eventName]) && Boolean(bindings.tab[eventName])
    )), bindings)
  ];
}

function greenLease003() {
  const a = audioPayload('A');
  const b = audioPayload('B');
  return [
    check('GREEN_LEASE003.METADATA_FIXTURE_SENSITIVE', a.tempFilePath !== b.tempFilePath
      && a.duration !== b.duration && a.fileSize !== b.fileSize, { a, b })
  ];
}

const EXECUTORS = Object.freeze({
  'LEASE-001': lease001,
  'LEASE-002': lease002,
  'LEASE-003': lease003,
  'LEASE-004': lease004,
  'LEASE-005': lease005,
  'LEASE-006': lease006,
  'LEASE-007': lease007,
  'LEASE-008': lease008,
  'LEASE-009': lease009,
  'LEASE-010': lease010,
  'LEASE-011': lease011,
  'LEASE-012': lease012,
  'LEASE-013': lease013,
  'LEASE-014': lease014,
  'LEASE-015': lease015,
  'LEASE-016': lease016,
  'GREEN-LEASE-001': greenLease001,
  'GREEN-LEASE-002': greenLease002,
  'GREEN-LEASE-003': greenLease003
});

function executeCase(contract) {
  const executor = EXECUTORS[contract.id];
  if (!executor) throw Object.assign(new Error(`Missing executor for ${contract.id}`), {
    code: 'RUNNER_EXECUTOR_MISSING'
  });
  if (!controllerSource() && !contract.id.startsWith('GREEN-')) {
    return result(contract, [check('NATIVE_LEASE_CAPABILITY_PRESENT', false, {
      controller: 'MISSING_FROM_PARENT_PRODUCTION'
    })]);
  }
  return result(contract, executor());
}

module.exports = { executeCase };
