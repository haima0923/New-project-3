const recordEntryHandoff = require('./record-entry-handoff');
const {
  cancelVoiceRecognition,
  getVoiceRecognitionAudit,
  startVoiceRecognition,
  stopVoiceRecognition
} = require('./voice-recognition');

// DEAD_COMPAT: retained only for callers that still display the former hold
// threshold. Recorder V2 never uses a timer to start capture or grant READY.
const HOLD_DELAY_MS = 260;
const POST_PROVIDER_ONSTART_STABILIZATION_MS = 700;
const POST_ONSTART_STABILIZATION_MS = POST_PROVIDER_ONSTART_STABILIZATION_MS;
const CANCEL_DISTANCE_PX = 55;
const INPUT_PAGE_URL = '/pages/input/input';
const RECORDER_OPTIONS = Object.freeze({
  audioSource: 'auto',
  duration: 60000,
  encodeBitRate: 48000,
  format: 'mp3',
  numberOfChannels: 1,
  sampleRate: 16000
});

const PHASES = Object.freeze({
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  POST_ONSTART_STABILIZING: 'POST_ONSTART_STABILIZING',
  READY_RECORDING: 'READY_RECORDING',
  CANCEL_PENDING: 'CANCEL_PENDING',
  FINALIZING_AUDIO: 'FINALIZING_AUDIO',
  AUDIO_READY: 'AUDIO_READY',
  NATIVE_DESYNC: 'NATIVE_DESYNC',
  NATIVE_ERROR_POISONED: 'NATIVE_ERROR_POISONED'
});

const NATIVE_STATES = Object.freeze({
  START_PENDING: 'START_PENDING',
  STARTED: 'STARTED',
  STOP_PENDING: 'STOP_PENDING',
  DESYNC: 'DESYNC',
  DESYNC_STOP_PENDING: 'DESYNC_STOP_PENDING',
  POISONED: 'POISONED',
  SETTLED: 'SETTLED'
});

const PERMISSION = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  GRANTED: 'GRANTED',
  NEEDS_AUTHORIZATION: 'NEEDS_AUTHORIZATION',
  DENIED: 'DENIED'
});

const CAPTURE_MODES = Object.freeze({
  NATIVE_RECORDER: 'NATIVE_RECORDER',
  WECHATSI: 'WECHATSI'
});
const WECHATSI_TERMINAL_STATUSES = Object.freeze([
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'SUPERSEDED',
  'TIMED_OUT'
]);

const owners = new Map();
let activeCapture = null;
let captureSequence = 0;
let nativeLeaseSequence = 0;
let stabilizationGenerationSequence = 0;
let permissionProbeSequence = 0;
let permissionState = PERMISSION.UNKNOWN;
let recorderManager = null;
let recorderEventsBound = false;
let nativeRecorderLease = null;
let legacyCompatibilitySession = null;

function now() {
  return Date.now();
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function touchIdentifier(touch) {
  if (!touch || touch.identifier === undefined || touch.identifier === null) return null;
  return touch.identifier;
}

function firstTouch(event) {
  const changedTouches = event && Array.isArray(event.changedTouches) ? event.changedTouches : [];
  if (changedTouches[0]) return changedTouches[0];
  const touches = event && Array.isArray(event.touches) ? event.touches : [];
  return touches[0] || null;
}

function touchByIdentifier(event, collection, identifier) {
  const touches = event && Array.isArray(event[collection]) ? event[collection] : [];
  return touches.find((touch) => touchIdentifier(touch) === identifier) || null;
}

function ownerFor(capture) {
  return capture ? owners.get(capture.ownerToken) || null : null;
}

function isCurrentCapture(capture) {
  return Boolean(capture && activeCapture === capture && capture.valid === true);
}

function cleanAudioPayload(payload = {}) {
  const duration = Number(payload.duration);
  const fileSize = Number(payload.fileSize);
  const tempFilePath = String(payload.tempFilePath || '');
  if (!tempFilePath || !Number.isFinite(duration) || duration <= 0
    || !Number.isFinite(fileSize) || fileSize <= 0) return null;
  return {
    duration,
    fileSize,
    tempFilePath
  };
}

function surfaceSnapshot(capture, phaseOverride) {
  const phase = phaseOverride || capture && capture.phase || PHASES.IDLE;
  if (phase === PHASES.IDLE) {
    return Object.freeze({
      gesture: 'send',
      overlayHint: '',
      overlayMode: 'idle',
      overlaySubtitle: '',
      overlayTitle: '',
      overlayVisible: false,
      phase,
      recording: false,
      voiceTip: ''
    });
  }
  if ([PHASES.PREPARING, PHASES.POST_ONSTART_STABILIZING].includes(phase)) {
    const cancelling = Boolean(capture && capture.gesture === 'cancel');
    return Object.freeze({
      gesture: cancelling ? 'cancel' : 'send',
      overlayHint: '',
      overlayMode: 'preparing',
      overlaySubtitle: cancelling ? '这次不会发送' : '请等震动后再说',
      overlayTitle: cancelling ? '松手取消' : '准备中…',
      overlayVisible: true,
      phase,
      recording: true,
      voiceTip: cancelling
        ? '松手取消本次录音。'
        : '麦克风准备中，请等震动后再说。'
    });
  }
  if (phase === PHASES.FINALIZING_AUDIO) {
    const isWechatSi = Boolean(capture && capture.captureMode === CAPTURE_MODES.WECHATSI);
    return Object.freeze({
      gesture: 'send',
      overlayHint: '',
      overlayMode: 'processing',
      overlaySubtitle: isWechatSi ? '正在整理你刚才说的话' : '正在生成原始录音文件',
      overlayTitle: isWechatSi ? '小玲正在听写…' : '正在处理录音…',
      overlayVisible: true,
      phase,
      recording: false,
      voiceTip: isWechatSi ? '小玲正在听写…' : '录音已结束，正在生成原始录音。'
    });
  }
  if (phase === PHASES.AUDIO_READY) {
    return Object.freeze({
      gesture: 'send',
      overlayHint: '',
      overlayMode: 'complete',
      overlaySubtitle: '',
      overlayTitle: '',
      overlayVisible: false,
      phase,
      recording: false,
      voiceTip: '录音已完成'
    });
  }
  if ([PHASES.NATIVE_DESYNC, PHASES.NATIVE_ERROR_POISONED].includes(phase)) {
    return Object.freeze({
      gesture: 'send',
      overlayHint: '',
      overlayMode: 'error',
      overlaySubtitle: '',
      overlayTitle: '',
      overlayVisible: false,
      phase,
      recording: false,
      voiceTip: phase === PHASES.NATIVE_DESYNC
        ? '录音器状态异常；若未恢复，请关闭后重新打开小程序。'
        : '录音功能暂时不可用，请重新进入小程序。'
    });
  }
  if (![PHASES.READY_RECORDING, PHASES.CANCEL_PENDING].includes(phase)) {
    return surfaceSnapshot(null, PHASES.IDLE);
  }
  const cancelling = phase === PHASES.CANCEL_PENDING;
  const isWechatSi = Boolean(capture && capture.captureMode === CAPTURE_MODES.WECHATSI);
  const readyTitle = isWechatSi ? '我在听' : '可以说了';
  return Object.freeze({
    gesture: cancelling ? 'cancel' : 'send',
    overlayHint: cancelling ? '松手取消本次录音' : '上滑取消',
    overlayMode: 'listening',
    overlaySubtitle: cancelling ? '这次不会发送' : '松开发送',
    overlayTitle: cancelling ? '松手取消' : readyTitle,
    overlayVisible: true,
    phase,
    recording: true,
    voiceTip: cancelling
      ? '松手取消本次录音。'
      : `${readyTitle}，松开发送。`
  });
}

function projectOwner(owner, snapshot) {
  if (!owner || typeof owner.project !== 'function') return;
  owner.project(snapshot);
}

function projectCapture(capture) {
  if (!isCurrentCapture(capture)) return;
  projectOwner(ownerFor(capture), surfaceSnapshot(capture));
}

function projectIdle(owner) {
  projectOwner(owner, surfaceSnapshot(null, PHASES.IDLE));
}

function showMessage(owner, message, options = {}) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) return;
  if (owner && typeof owner.message === 'function') owner.message(cleanMessage, options);
  if (options.toast !== false && typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
    wx.showToast({ title: cleanMessage, icon: 'none' });
  }
}

function vibrateReadyOnce(capture) {
  if (!capture || capture.readyVibrated) return false;
  capture.readyVibrated = true;
  if (typeof wx === 'undefined' || typeof wx.vibrateShort !== 'function') return true;
  try {
    wx.vibrateShort({ type: 'medium' });
  } catch (error) {
    // READY is owned by the post-onStart stabilization gate. Haptic failure
    // must never revoke the already-established capture authority.
  }
  return true;
}

function revokeStabilizationTimer(capture) {
  if (!capture) return false;
  const timer = capture.stabilizationTimer;
  capture.stabilizationTimer = null;
  capture.stabilizationGeneration = 0;
  if (timer !== null && timer !== undefined) clearTimeout(timer);
  return Boolean(timer);
}

function startNativeStabilizationTimer(capture, lease) {
  if (!capture || !lease) return false;
  revokeStabilizationTimer(capture);
  stabilizationGenerationSequence += 1;
  const generation = stabilizationGenerationSequence;
  const capturedCaptureId = capture.captureId;
  const capturedLeaseId = lease.leaseId;
  const capturedOwnerToken = capture.ownerToken;
  capture.stabilizationGeneration = generation;
  const timer = setTimeout(() => {
    if (activeCapture !== capture
      || !isCurrentCapture(capture)
      || capture.captureId !== capturedCaptureId
      || capture.ownerToken !== capturedOwnerToken
      || capture.nativeLeaseId !== capturedLeaseId
      || capture.stabilizationGeneration !== generation
      || capture.stabilizationTimer !== timer
      || capture.phase !== PHASES.POST_ONSTART_STABILIZING
      || !capture.pressActive
      || capture.discard
      || capture.stopIssued
      || capture.gesture === 'cancel'
      || !owners.has(capturedOwnerToken)
      || nativeRecorderLease !== lease
      || lease.boundCapture !== capture
      || lease.boundCaptureId !== capturedCaptureId
      || lease.boundOwnerToken !== capturedOwnerToken
      || lease.leaseId !== capturedLeaseId
      || lease.nativeState !== NATIVE_STATES.STARTED
      || !lease.startSeen
      || lease.stopRequested
      || lease.discard
      || lease.terminalSeen) return;
    capture.stabilizationTimer = null;
    capture.stabilizationGeneration = 0;
    capture.readyAt = now();
    capture.phase = PHASES.READY_RECORDING;
    vibrateReadyOnce(capture);
    projectCapture(capture);
  }, POST_PROVIDER_ONSTART_STABILIZATION_MS);
  capture.stabilizationTimer = timer;
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}

function currentWechatSiSessionMatches(capture, expectedSessionId) {
  if (!capture || capture.captureMode !== CAPTURE_MODES.WECHATSI) return false;
  const audit = getVoiceRecognitionAudit();
  return Boolean(audit
    && audit.sessionId === expectedSessionId
    && capture.voiceSessionId === expectedSessionId
    && !WECHATSI_TERMINAL_STATUSES.includes(audit.status));
}

function ownsCurrentWechatSiSession(capture) {
  const expectedSessionId = String(capture && capture.voiceSessionId || '');
  return Boolean(expectedSessionId
    && currentWechatSiSessionMatches(capture, expectedSessionId));
}

function hasNonTerminalWechatSiSession() {
  const audit = getVoiceRecognitionAudit();
  return Boolean(audit
    && audit.sessionId
    && !WECHATSI_TERMINAL_STATUSES.includes(audit.status));
}

function authorizeWechatSiReady(capture, expectedSessionId) {
  if (!isCurrentCapture(capture)
    || capture.phase !== PHASES.POST_ONSTART_STABILIZING
    || !capture.pressActive
    || capture.discard
    || capture.stopIssued
    || capture.gesture === 'cancel'
    || !owners.has(capture.ownerToken)
    || !currentWechatSiSessionMatches(capture, expectedSessionId)) return false;
  capture.stabilizationElapsed = true;
  capture.readyAt = now();
  capture.phase = PHASES.READY_RECORDING;
  vibrateReadyOnce(capture);
  projectCapture(capture);
  return true;
}

function startWechatSiStabilizationTimer(capture, providerStart = {}) {
  if (!capture) return false;
  const expectedSessionId = String(providerStart.sessionId || capture.voiceSessionId || '');
  if (!expectedSessionId || !currentWechatSiSessionMatches(capture, expectedSessionId)) return false;
  revokeStabilizationTimer(capture);
  stabilizationGenerationSequence += 1;
  const generation = stabilizationGenerationSequence;
  const capturedCaptureId = capture.captureId;
  const capturedOwnerToken = capture.ownerToken;
  capture.stabilizationElapsed = false;
  capture.stabilizationGeneration = generation;
  const timer = setTimeout(() => {
    if (activeCapture !== capture
      || !isCurrentCapture(capture)
      || capture.captureId !== capturedCaptureId
      || capture.ownerToken !== capturedOwnerToken
      || capture.voiceSessionId !== expectedSessionId
      || capture.stabilizationGeneration !== generation
      || capture.stabilizationTimer !== timer
      || capture.phase !== PHASES.POST_ONSTART_STABILIZING
      || !capture.pressActive
      || capture.discard
      || capture.stopIssued
      || !owners.has(capturedOwnerToken)
      || !currentWechatSiSessionMatches(capture, expectedSessionId)) return;
    capture.stabilizationTimer = null;
    capture.stabilizationGeneration = 0;
    capture.stabilizationElapsed = true;
    if (capture.gesture === 'cancel') return;
    authorizeWechatSiReady(capture, expectedSessionId);
  }, POST_PROVIDER_ONSTART_STABILIZATION_MS);
  capture.stabilizationTimer = timer;
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}

function resetCapture(capture, options = {}) {
  if (!capture) return;
  revokeStabilizationTimer(capture);
  capture.valid = false;
  capture.pressActive = false;
  capture.terminalReasonCode = String(options.reasonCode || capture.terminalReasonCode || '');
  const owner = ownerFor(capture);
  if (activeCapture === capture) activeCapture = null;
  if (options.project !== false) projectIdle(owner);
  if (options.message) showMessage(owner, options.message, options);
}

function hasPendingNativeRecorderLease() {
  return Boolean(nativeRecorderLease
    && nativeRecorderLease.nativeState !== NATIVE_STATES.SETTLED);
}

function nativeRecorderBusyMessage() {
  if (!nativeRecorderLease) return '上一条录音正在结束，请稍候';
  if (nativeRecorderLease.nativeState === NATIVE_STATES.POISONED) {
    return '录音功能暂时不可用，请重新进入小程序';
  }
  if ([NATIVE_STATES.DESYNC,
    NATIVE_STATES.DESYNC_STOP_PENDING].includes(nativeRecorderLease.nativeState)) {
    return '录音器状态异常，请关闭后重新打开小程序';
  }
  return '上一条录音正在结束，请稍候';
}

function boundCaptureForLease(lease) {
  if (!lease || !lease.boundCapture) return null;
  const capture = lease.boundCapture;
  if (capture.captureId !== lease.boundCaptureId
    || capture.ownerToken !== lease.boundOwnerToken
    || capture.nativeLeaseId !== lease.leaseId) return null;
  return capture;
}

function createNativeRecorderLease(capture) {
  if (!capture || hasPendingNativeRecorderLease()) return null;
  nativeLeaseSequence += 1;
  const lease = {
    boundCapture: capture,
    boundCaptureId: capture.captureId,
    boundOwnerToken: capture.ownerToken,
    cleanupRequested: false,
    discard: false,
    leaseId: `native-recorder-lease-${nativeLeaseSequence}`,
    nativeState: NATIVE_STATES.START_PENDING,
    poisonReason: '',
    startIssued: true,
    startSeen: false,
    stopRequested: false,
    terminalSeen: false,
    unexpectedTerminalSeen: false
  };
  capture.nativeLeaseId = lease.leaseId;
  nativeRecorderLease = lease;
  return lease;
}

function settleNativeRecorderLease(lease, reasonCode) {
  if (!lease || nativeRecorderLease !== lease
    || lease.nativeState === NATIVE_STATES.POISONED
    || lease.nativeState === NATIVE_STATES.SETTLED) return false;
  revokeStabilizationTimer(boundCaptureForLease(lease));
  lease.terminalSeen = true;
  lease.settleReason = String(reasonCode || 'NATIVE_TERMINAL_SETTLED');
  lease.nativeState = NATIVE_STATES.SETTLED;
  nativeRecorderLease = null;
  return true;
}

function poisonNativeRecorderLease(lease, reasonCode, message) {
  if (!lease || nativeRecorderLease !== lease) return false;
  revokeStabilizationTimer(boundCaptureForLease(lease));
  lease.discard = true;
  lease.poisonReason = String(reasonCode || 'NATIVE_RECORDER_POISONED');
  lease.nativeState = NATIVE_STATES.POISONED;
  const capture = boundCaptureForLease(lease);
  if (capture) {
    capture.discard = true;
    capture.phase = PHASES.NATIVE_ERROR_POISONED;
    if (isCurrentCapture(capture)) {
      resetCapture(capture, {
        message: message || '录音功能暂时不可用，请重新进入小程序。',
        reasonCode: lease.poisonReason
      });
    }
  }
  return true;
}

function requestNativeRecorderStopOnce(lease, options = {}) {
  if (!lease || nativeRecorderLease !== lease
    || lease.nativeState === NATIVE_STATES.POISONED
    || lease.nativeState === NATIVE_STATES.SETTLED) return false;
  revokeStabilizationTimer(boundCaptureForLease(lease));
  if (lease.stopRequested) return false;
  lease.stopRequested = true;
  lease.cleanupRequested = options.cleanup === true || lease.discard;
  if (lease.cleanupRequested) lease.discard = true;
  lease.nativeState = lease.nativeState === NATIVE_STATES.DESYNC
    ? NATIVE_STATES.DESYNC_STOP_PENDING
    : NATIVE_STATES.STOP_PENDING;
  const capture = boundCaptureForLease(lease);
  if (capture) capture.stopIssued = true;
  const manager = getRecorderManager();
  if (!manager || typeof manager.stop !== 'function') {
    poisonNativeRecorderLease(
      lease,
      'RECORDER_STOP_UNAVAILABLE',
      '当前暂时不能完成录音，请重新进入小程序。'
    );
    return false;
  }
  try {
    manager.stop();
    return true;
  } catch (error) {
    poisonNativeRecorderLease(
      lease,
      'RECORDER_STOP_FAILED',
      '录音没有正常结束，请重新进入小程序。'
    );
    return false;
  }
}

function handleRecorderStart() {
  const lease = nativeRecorderLease;
  if (!lease || lease.nativeState === NATIVE_STATES.POISONED
    || lease.nativeState === NATIVE_STATES.SETTLED || lease.startSeen) return;
  lease.startSeen = true;
  const capture = boundCaptureForLease(lease);
  if (lease.nativeState === NATIVE_STATES.DESYNC) {
    lease.discard = true;
    requestNativeRecorderStopOnce(lease, { cleanup: true });
    return;
  }
  if (lease.nativeState === NATIVE_STATES.DESYNC_STOP_PENDING
    || lease.nativeState === NATIVE_STATES.STOP_PENDING) return;
  if (lease.nativeState !== NATIVE_STATES.START_PENDING) {
    poisonNativeRecorderLease(lease, 'RECORDER_START_ORDER_INVALID');
    return;
  }
  lease.nativeState = NATIVE_STATES.STARTED;
  if (!capture || !isCurrentCapture(capture)
    || capture.captureMode !== CAPTURE_MODES.NATIVE_RECORDER
    || capture.phase !== PHASES.PREPARING
    || !capture.pressActive
    || capture.discard
    || !owners.has(lease.boundOwnerToken)) {
    lease.discard = true;
    requestNativeRecorderStopOnce(lease, { cleanup: true });
    return;
  }
  capture.recorderOnStartAt = now();
  capture.readyAt = null;
  capture.phase = PHASES.POST_ONSTART_STABILIZING;
  if (capture.gesture === 'cancel') {
    // A swipe that happened before the native onStart callback is already a
    // terminal user intent. Keep recording ownership until touchend so the
    // native lease can settle normally, but never arm READY for this capture.
    revokeStabilizationTimer(capture);
    projectCapture(capture);
    return;
  }
  if (!startNativeStabilizationTimer(capture, lease)) {
    lease.discard = true;
    requestNativeRecorderStopOnce(lease, { cleanup: true });
    resetCapture(capture, {
      message: '录音准备失败，请重新按住说话。',
      reasonCode: 'RECORDER_STABILIZATION_START_FAILED'
    });
    return;
  }
  projectCapture(capture);
}

function handleRecorderStop(payload) {
  const lease = nativeRecorderLease;
  if (!lease || lease.nativeState === NATIVE_STATES.POISONED
    || lease.nativeState === NATIVE_STATES.SETTLED || lease.terminalSeen) return;
  const capture = boundCaptureForLease(lease);
  if (!lease.startSeen) {
    lease.discard = true;
    lease.unexpectedTerminalSeen = true;
    lease.stopRequested = false;
    lease.nativeState = NATIVE_STATES.DESYNC;
    if (capture) {
      capture.discard = true;
      capture.pressActive = false;
      capture.stopIssued = false;
      capture.phase = PHASES.NATIVE_DESYNC;
      projectCapture(capture);
    }
    return;
  }
  if (lease.nativeState === NATIVE_STATES.DESYNC_STOP_PENDING) {
    settleNativeRecorderLease(lease, 'NATIVE_DESYNC_CLEANUP_TERMINAL');
    if (capture && isCurrentCapture(capture)) {
      resetCapture(capture, { reasonCode: 'NATIVE_DESYNC_RECOVERED' });
    }
    return;
  }
  if (lease.nativeState !== NATIVE_STATES.STOP_PENDING) {
    poisonNativeRecorderLease(lease, 'RECORDER_TERMINAL_ORDER_INVALID');
    return;
  }
  const validAudioTarget = capture
    && isCurrentCapture(capture)
    && capture.phase === PHASES.FINALIZING_AUDIO
    && capture.captureId === lease.boundCaptureId
    && capture.ownerToken === lease.boundOwnerToken
    && capture.nativeLeaseId === lease.leaseId
    && capture.readyAt
    && !capture.discard
    && !lease.discard
    && owners.has(lease.boundOwnerToken);
  const cleanAudio = validAudioTarget ? cleanAudioPayload(payload) : null;
  if (capture) capture.recorderOnStopAt = now();
  settleNativeRecorderLease(lease, validAudioTarget
    ? 'NATIVE_AUDIO_TERMINAL'
    : 'NATIVE_DISCARDED_TERMINAL');
  if (!validAudioTarget) {
    if (capture && isCurrentCapture(capture)) {
      resetCapture(capture, { reasonCode: 'NATIVE_TERMINAL_DISCARDED' });
    }
    return;
  }
  if (!cleanAudio) {
    resetCapture(capture, {
      message: '录音文件没有生成，请重新按住说话。',
      reasonCode: 'RECORDER_AUDIO_INVALID'
    });
    return;
  }
  capture.audio = Object.freeze({
    captureId: capture.captureId,
    nativeLeaseId: lease.leaseId,
    duration: cleanAudio.duration,
    endedAt: capture.touchEndAt,
    fileSize: cleanAudio.fileSize,
    readyAt: capture.readyAt,
    recorderOnStopAt: capture.recorderOnStopAt,
    startedAt: capture.recorderStartCalledAt,
    tempFilePath: cleanAudio.tempFilePath,
    touchStartAt: capture.touchStartAt
  });
  capture.phase = PHASES.AUDIO_READY;
  projectCapture(capture);
  const owner = ownerFor(capture);
  if (owner && typeof owner.audioReady === 'function') owner.audioReady(capture.audio);
}

function handleRecorderError(error) {
  const lease = nativeRecorderLease;
  if (!lease || lease.nativeState === NATIVE_STATES.POISONED
    || lease.nativeState === NATIVE_STATES.SETTLED) return;
  const message = String(error && (error.errMsg || error.message) || '录音失败');
  poisonNativeRecorderLease(
    lease,
    'RECORDER_ERROR_POISONED',
    message.includes('录音')
      ? `${message}，请重新进入小程序。`
      : '录音失败，请重新进入小程序。'
  );
}

function getRecorderManager() {
  if (recorderManager) return recorderManager;
  if (typeof wx === 'undefined' || typeof wx.getRecorderManager !== 'function') return null;
  recorderManager = wx.getRecorderManager();
  if (!recorderManager || recorderEventsBound) return recorderManager;
  recorderEventsBound = true;
  recorderManager.onStart(handleRecorderStart);
  recorderManager.onStop(handleRecorderStop);
  recorderManager.onError(handleRecorderError);
  return recorderManager;
}

function issueRecorderStopOnce(capture) {
  if (!capture || !capture.recorderRequested) return false;
  const lease = nativeRecorderLease;
  if (!lease || lease.boundCaptureId !== capture.captureId
    || lease.boundOwnerToken !== capture.ownerToken
    || lease.leaseId !== capture.nativeLeaseId) return false;
  return requestNativeRecorderStopOnce(lease, { cleanup: capture.discard === true });
}

function issueCaptureStopOnce(capture) {
  if (!capture || capture.stopIssued) return false;
  if (capture.captureMode === CAPTURE_MODES.NATIVE_RECORDER) return issueRecorderStopOnce(capture);
  if (capture.captureMode !== CAPTURE_MODES.WECHATSI || !capture.legacyRequested || capture.cancelIssued) {
    return false;
  }
  if (!ownsCurrentWechatSiSession(capture)) {
    capture.discard = true;
    resetCapture(capture, { reasonCode: 'WECHATSI_SESSION_REPLACED_BEFORE_STOP' });
    return false;
  }
  capture.stopIssued = true;
  return stopVoiceRecognition();
}

function cancelCapture(capture, reasonCode, options = {}) {
  if (!capture) return false;
  revokeStabilizationTimer(capture);
  capture.discard = true;
  capture.pressActive = false;
  if (capture.captureMode === CAPTURE_MODES.NATIVE_RECORDER) issueRecorderStopOnce(capture);
  if (capture.captureMode === CAPTURE_MODES.WECHATSI
    && capture.legacyRequested
    && !capture.cancelIssued
    && !capture.stopIssued) {
    capture.cancelIssued = true;
    if (ownsCurrentWechatSiSession(capture)) {
      cancelVoiceRecognition(reasonCode || 'HOLD_TO_TALK_CANCELLED');
    }
  }
  resetCapture(capture, Object.assign({}, options, { reasonCode }));
  return true;
}

function refreshPermissionState() {
  if (typeof wx === 'undefined' || typeof wx.getSetting !== 'function') return;
  permissionProbeSequence += 1;
  const probe = permissionProbeSequence;
  wx.getSetting({
    success: (result) => {
      if (probe !== permissionProbeSequence) return;
      const settings = result && result.authSetting || {};
      permissionState = settings['scope.record'] === true
        ? PERMISSION.GRANTED
        : PERMISSION.NEEDS_AUTHORIZATION;
    },
    fail: () => {
      if (probe === permissionProbeSequence) permissionState = PERMISSION.UNKNOWN;
    }
  });
}

function finishPermissionGesture(capture, granted) {
  if (!isCurrentCapture(capture)) return;
  permissionState = granted ? PERMISSION.GRANTED : PERMISSION.DENIED;
  resetCapture(capture, {
    message: granted
      ? '麦克风已开启，请重新按住说话'
      : '请先在微信设置里打开麦克风权限。',
    reasonCode: granted
      ? 'MICROPHONE_PERMISSION_GRANTED_FOR_NEXT_GESTURE'
      : 'MICROPHONE_PERMISSION_DENIED'
  });
}

function authorizeForNextGesture(capture) {
  if (!isCurrentCapture(capture)) return false;
  capture.permissionEpoch += 1;
  const epoch = capture.permissionEpoch;
  const grant = () => {
    permissionState = PERMISSION.GRANTED;
    if (!isCurrentCapture(capture) || capture.permissionEpoch !== epoch) return;
    finishPermissionGesture(capture, true);
  };
  const reject = () => {
    permissionState = PERMISSION.DENIED;
    if (!isCurrentCapture(capture) || capture.permissionEpoch !== epoch) return;
    finishPermissionGesture(capture, false);
  };
  const requestAuthorize = () => {
    if (typeof wx === 'undefined' || typeof wx.authorize !== 'function') {
      reject();
      return;
    }
    wx.authorize({ scope: 'scope.record', success: grant, fail: reject });
  };
  if (permissionState === PERMISSION.NEEDS_AUTHORIZATION
    || permissionState === PERMISSION.DENIED) {
    requestAuthorize();
    return true;
  }
  if (typeof wx === 'undefined' || typeof wx.getSetting !== 'function') {
    requestAuthorize();
    return true;
  }
  wx.getSetting({
    success: (result) => {
      if (!isCurrentCapture(capture) || capture.permissionEpoch !== epoch) return;
      const settings = result && result.authSetting || {};
      if (settings['scope.record'] === true) grant();
      else requestAuthorize();
    },
    fail: reject
  });
  return true;
}

function startNativeRecorder(capture) {
  if (!isCurrentCapture(capture) || !capture.pressActive || permissionState !== PERMISSION.GRANTED) {
    return false;
  }
  if (hasPendingNativeRecorderLease()) return false;
  const manager = getRecorderManager();
  if (!manager || typeof manager.start !== 'function') return false;
  capture.captureMode = CAPTURE_MODES.NATIVE_RECORDER;
  capture.recorderRequested = true;
  capture.recorderStartCalledAt = now();
  const lease = createNativeRecorderLease(capture);
  if (!lease) return false;
  const owner = ownerFor(capture);
  if (owner && typeof owner.startRequested === 'function') owner.startRequested();
  try {
    manager.start(RECORDER_OPTIONS);
    return true;
  } catch (error) {
    settleNativeRecorderLease(lease, 'RECORDER_START_CALL_FAILED');
    resetCapture(capture, {
      message: '录音启动失败，请重新按住说话。',
      reasonCode: 'RECORDER_START_FAILED'
    });
    return false;
  }
}

function startWechatSiForCapture(capture) {
  if (!isCurrentCapture(capture) || !capture.pressActive) return false;
  const owner = ownerFor(capture);
  if (!owner) return false;
  capture.captureMode = CAPTURE_MODES.WECHATSI;
  capture.legacyRequested = true;
  if (typeof owner.startRequested === 'function') owner.startRequested();
  const started = startVoiceRecognition({
    duration: 60000,
    lang: 'zh_CN',
    onSession: (session) => {
      if (!isCurrentCapture(capture)) return;
      capture.voiceSessionId = String(session && session.sessionId || '');
    },
    onStart: (providerStart) => {
      if (!isCurrentCapture(capture)
        || capture.captureMode !== CAPTURE_MODES.WECHATSI
        || !capture.pressActive
        || capture.discard
        || String(providerStart && providerStart.sessionId || '') !== capture.voiceSessionId) return;
      capture.providerOnStartAt = now();
      capture.readyAt = null;
      capture.phase = PHASES.POST_ONSTART_STABILIZING;
      if (!startWechatSiStabilizationTimer(capture, providerStart)) {
        cancelCapture(capture, 'WECHATSI_STABILIZATION_START_FAILED', {
          message: '语音准备失败，请重新按住说话。'
        });
        return;
      }
      projectCapture(capture);
    },
    onStop: () => {
      if (!isCurrentCapture(capture)
        || capture.discard
        || !capture.stopIssued
        || capture.phase !== PHASES.FINALIZING_AUDIO) return;
      projectCapture(capture);
    },
    onRecognize: (partial) => {
      if (!isCurrentCapture(capture) || capture.phase !== PHASES.READY_RECORDING) return;
      const text = String(partial && partial.text || '').trim();
      if (text && owner && typeof owner.partial === 'function') owner.partial(text);
    },
    onResult: (result) => {
      if (!isCurrentCapture(capture)
        || capture.discard
        || !capture.stopIssued
        || capture.phase !== PHASES.FINALIZING_AUDIO) return;
      resetCapture(capture);
      publishLegacyTranscript(owner, result && result.text);
    },
    onError: (error) => {
      if (!isCurrentCapture(capture)) return;
      resetCapture(capture, {
        message: error && error.message || '语音识别失败，请改用打字或粘贴。',
        reasonCode: 'WECHATSI_VOICE_ERROR'
      });
    }
  });
  if (!started) {
    resetCapture(capture, {
      message: '当前暂时不能使用语音，请改用打字或粘贴。',
      reasonCode: 'WECHATSI_VOICE_START_FAILED'
    });
  }
  return started;
}

function isNodeHeadlessCompatibilityRuntime() {
  return typeof process !== 'undefined'
    && process
    && process.versions
    && Boolean(process.versions.node);
}

function publishLegacyTranscript(owner, transcript) {
  const text = String(transcript || '').trim();
  if (!text) {
    showMessage(owner, '没有听清楚，请再说一次或改用打字。');
    return;
  }
  if (owner && typeof owner.transcript === 'function') owner.transcript(text);
  let handle = null;
  try {
    handle = recordEntryHandoff.publishRecordEntryHandoff({
      autoParse: true,
      originSurface: 'HOME_QUICK',
      originalText: text,
      source: 'voice'
    });
    wx.switchTab({
      url: INPUT_PAGE_URL,
      fail: () => {
        if (!recordEntryHandoff.invalidateRecordEntryHandoff(handle)) return;
        showMessage(owner, '没能打开记一笔，请再试一次。');
      }
    });
  } catch (error) {
    if (handle) recordEntryHandoff.invalidateRecordEntryHandoff(handle);
    showMessage(owner, '没能打开记一笔，请再试一次。');
  }
}

function startLegacyCompatibility(ownerToken) {
  const owner = owners.get(ownerToken);
  if (!owner || legacyCompatibilitySession) return false;
  const session = { ownerToken, valid: true };
  legacyCompatibilitySession = session;
  if (typeof owner.startRequested === 'function') owner.startRequested();
  const finish = () => {
    if (legacyCompatibilitySession === session) legacyCompatibilitySession = null;
  };
  const started = startVoiceRecognition({
    duration: 60000,
    lang: 'zh_CN',
    onResult: (result) => {
      if (!session.valid) return;
      session.valid = false;
      finish();
      publishLegacyTranscript(owner, result && result.text);
    },
    onError: (error) => {
      if (!session.valid) return;
      session.valid = false;
      finish();
      showMessage(owner, error && error.message || '语音识别失败，请改用打字或粘贴。');
    }
  });
  if (!started) {
    session.valid = false;
    finish();
  }
  return started;
}

function registerHoldToTalkOwner(options = {}) {
  const token = Object.freeze({});
  owners.set(token, {
    audioReady: typeof options.audioReady === 'function' ? options.audioReady : null,
    message: typeof options.message === 'function' ? options.message : null,
    partial: typeof options.partial === 'function' ? options.partial : null,
    project: typeof options.project === 'function' ? options.project : null,
    startRequested: typeof options.startRequested === 'function' ? options.startRequested : null,
    surface: String(options.surface || ''),
    transcript: typeof options.transcript === 'function' ? options.transcript : null
  });
  refreshPermissionState();
  return token;
}

function releaseHoldToTalkOwner(ownerToken, reasonCode = 'HOLD_OWNER_DETACHED') {
  const owner = owners.get(ownerToken);
  if (!owner) return false;
  if (activeCapture && activeCapture.ownerToken === ownerToken) {
    cancelCapture(activeCapture, reasonCode);
  }
  if (legacyCompatibilitySession && legacyCompatibilitySession.ownerToken === ownerToken) {
    legacyCompatibilitySession.valid = false;
    legacyCompatibilitySession = null;
    cancelVoiceRecognition(reasonCode);
  }
  owners.delete(ownerToken);
  return true;
}

function newCapture(ownerToken, event) {
  const owner = owners.get(ownerToken);
  if (!owner) return null;
  const touch = firstTouch(event);
  const identifier = touchIdentifier(touch);
  const startX = finiteCoordinate(touch && touch.clientX);
  const startY = finiteCoordinate(touch && touch.clientY);
  if (identifier === null || startX === null || startY === null) return null;
  captureSequence += 1;
  return {
    audio: null,
    cancelIssued: false,
    captureId: `voice-capture-v2-${captureSequence}`,
    captureMode: '',
    discard: false,
    gesture: 'send',
    ownerToken,
    permissionEpoch: 0,
    phase: PHASES.PREPARING,
    pressActive: true,
    providerOnStartAt: null,
    readyAt: null,
    readyVibrated: false,
    recorderOnStartAt: null,
    recorderOnStopAt: null,
    recorderRequested: false,
    recorderStartCalledAt: null,
    legacyRequested: false,
    nativeLeaseId: '',
    startX,
    startY,
    stabilizationGeneration: 0,
    stabilizationElapsed: false,
    stabilizationTimer: null,
    stopIssued: false,
    terminalReasonCode: '',
    touchEndAt: null,
    touchIdentifier: identifier,
    touchStartAt: now(),
    valid: true
  };
}

function beginHold(ownerToken, event) {
  const owner = owners.get(ownerToken);
  if (!owner) return false;
  if (activeCapture && activeCapture.phase === PHASES.AUDIO_READY) resetCapture(activeCapture);
  if (activeCapture) {
    showMessage(owner, [PHASES.NATIVE_DESYNC,
      PHASES.NATIVE_ERROR_POISONED].includes(activeCapture.phase)
      ? nativeRecorderBusyMessage()
      : (activeCapture.phase === PHASES.FINALIZING_AUDIO
        ? '上一条正在处理录音'
        : '正在录音，请先完成上一条'));
    return false;
  }
  if (hasNonTerminalWechatSiSession()) {
    showMessage(owner, '正在录音，请先完成上一条');
    return false;
  }
  if (hasPendingNativeRecorderLease()) {
    showMessage(owner, nativeRecorderBusyMessage());
    return false;
  }
  const capture = newCapture(ownerToken, event);
  if (!capture) return false;
  activeCapture = capture;
  projectCapture(capture);
  if (permissionState !== PERMISSION.GRANTED) {
    authorizeForNextGesture(capture);
    return true;
  }
  // RecorderManager V2 remains available to its isolated Node contract suite,
  // but the real Hero/Custom Tab product gesture selects WechatSI exclusively.
  // A single touch can never start both providers.
  if (isNodeHeadlessCompatibilityRuntime()
    && typeof wx !== 'undefined'
    && typeof wx.getRecorderManager === 'function') {
    if (startNativeRecorder(capture)) return true;
    resetCapture(capture, {
      message: '当前暂时不能录音，请稍后再试。',
      reasonCode: 'NATIVE_RECORDER_COMPATIBILITY_START_FAILED'
    });
    return false;
  }
  return startWechatSiForCapture(capture);
}

function beginHoldImmediately(ownerToken) {
  return startLegacyCompatibility(ownerToken);
}

function moveHold(ownerToken, event) {
  const capture = activeCapture;
  if (!isCurrentCapture(capture)
    || capture.ownerToken !== ownerToken
    || !capture.pressActive
    || ![PHASES.PREPARING, PHASES.POST_ONSTART_STABILIZING,
      PHASES.READY_RECORDING, PHASES.CANCEL_PENDING].includes(capture.phase)) return false;
  const touch = touchByIdentifier(event, 'touches', capture.touchIdentifier);
  const currentY = finiteCoordinate(touch && touch.clientY);
  if (currentY === null) return false;
  const cancel = capture.startY - currentY > CANCEL_DISTANCE_PX;
  if ([PHASES.PREPARING, PHASES.POST_ONSTART_STABILIZING].includes(capture.phase)) {
    if (capture.captureMode === CAPTURE_MODES.NATIVE_RECORDER) {
      if (capture.gesture === 'cancel') return true;
      if (!cancel) return true;
      capture.gesture = 'cancel';
      revokeStabilizationTimer(capture);
      projectCapture(capture);
      return true;
    }
    const nextGesture = cancel ? 'cancel' : 'send';
    if (capture.gesture === nextGesture) return true;
    capture.gesture = nextGesture;
    projectCapture(capture);
    if (nextGesture === 'send'
      && capture.phase === PHASES.POST_ONSTART_STABILIZING
      && capture.stabilizationElapsed) {
      authorizeWechatSiReady(capture, capture.voiceSessionId);
    }
    return true;
  }
  if (capture.phase === PHASES.CANCEL_PENDING && !capture.readyAt) return true;
  const nextPhase = cancel ? PHASES.CANCEL_PENDING : PHASES.READY_RECORDING;
  if (capture.phase === nextPhase) return true;
  capture.gesture = cancel ? 'cancel' : 'send';
  capture.phase = nextPhase;
  projectCapture(capture);
  return true;
}

function endHold(ownerToken, event) {
  const capture = activeCapture;
  if (!isCurrentCapture(capture) || capture.ownerToken !== ownerToken || !capture.pressActive) {
    return false;
  }
  if (!touchByIdentifier(event, 'changedTouches', capture.touchIdentifier)) return false;
  capture.pressActive = false;
  capture.touchEndAt = now();
  if ([PHASES.PREPARING, PHASES.POST_ONSTART_STABILIZING].includes(capture.phase)) {
    if (capture.gesture === 'cancel') {
      return cancelCapture(capture, 'HOLD_TO_TALK_SWIPE_CANCELLED');
    }
    return cancelCapture(capture, 'RECORDER_RELEASED_BEFORE_READY', {
      message: '请等震动后再说'
    });
  }
  if (capture.phase === PHASES.CANCEL_PENDING) {
    return cancelCapture(capture, 'HOLD_TO_TALK_SWIPE_CANCELLED');
  }
  if (capture.phase !== PHASES.READY_RECORDING) return false;
  capture.phase = PHASES.FINALIZING_AUDIO;
  issueCaptureStopOnce(capture);
  projectCapture(capture);
  return true;
}

function cancelHold(ownerToken, event, reasonCode = 'HOLD_TO_TALK_TOUCH_CANCELLED') {
  const capture = activeCapture;
  if (!isCurrentCapture(capture) || capture.ownerToken !== ownerToken || !capture.pressActive) {
    return false;
  }
  if (event && !touchByIdentifier(event, 'changedTouches', capture.touchIdentifier)) return false;
  capture.touchEndAt = now();
  return cancelCapture(capture, reasonCode);
}

function invalidateHoldToTalk(ownerToken, reasonCode = 'HOLD_TO_TALK_INVALIDATED') {
  const capture = activeCapture;
  if (!isCurrentCapture(capture)) return false;
  if (ownerToken && capture.ownerToken !== ownerToken) return false;
  return cancelCapture(capture, reasonCode);
}

function invalidateActiveHoldToTalk(reasonCode = 'HOLD_TO_TALK_REPLACED_BY_INPUT') {
  let changed = invalidateHoldToTalk(null, reasonCode);
  if (legacyCompatibilitySession) {
    legacyCompatibilitySession.valid = false;
    legacyCompatibilitySession = null;
    cancelVoiceRecognition(reasonCode);
    changed = true;
  }
  return changed;
}

function getHoldToTalkState() {
  if (!activeCapture) {
    if (nativeRecorderLease && nativeRecorderLease.nativeState === NATIVE_STATES.POISONED) {
      return Object.freeze({
        nativeLeaseId: nativeRecorderLease.leaseId,
        phase: PHASES.NATIVE_ERROR_POISONED
      });
    }
    if (nativeRecorderLease && [NATIVE_STATES.DESYNC,
      NATIVE_STATES.DESYNC_STOP_PENDING].includes(nativeRecorderLease.nativeState)) {
      return Object.freeze({
        nativeLeaseId: nativeRecorderLease.leaseId,
        phase: PHASES.NATIVE_DESYNC
      });
    }
    return Object.freeze({ phase: PHASES.IDLE });
  }
  const audio = activeCapture.audio && Object.freeze({
    captureId: activeCapture.audio.captureId,
    nativeLeaseId: activeCapture.audio.nativeLeaseId,
    duration: activeCapture.audio.duration,
    endedAt: 0,
    fileSize: activeCapture.audio.fileSize,
    readyAt: 0,
    recorderOnStopAt: 0,
    startedAt: 0,
    tempFilePath: activeCapture.audio.tempFilePath,
    touchStartAt: 0
  });
  return Object.freeze({
    // The controller retains absolute event timestamps internally. The public
    // diagnostic snapshot exposes capture-relative offsets so contract output
    // is deterministic and cannot be mistaken for business time authority.
    audio,
    captureMode: activeCapture.captureMode,
    captureId: activeCapture.captureId,
    gesture: activeCapture.gesture,
    gestureQualified: [PHASES.READY_RECORDING, PHASES.CANCEL_PENDING,
      PHASES.FINALIZING_AUDIO, PHASES.AUDIO_READY].includes(activeCapture.phase),
    nativeLeaseId: activeCapture.nativeLeaseId,
    phase: activeCapture.phase,
    pressActive: activeCapture.pressActive,
    recorderRequested: activeCapture.recorderRequested,
    surface: ownerFor(activeCapture) && ownerFor(activeCapture).surface || '',
    touchIdentifier: activeCapture.touchIdentifier
  });
}

module.exports = {
  CAPTURE_MODES,
  CANCEL_DISTANCE_PX,
  HOLD_DELAY_MS,
  POST_PROVIDER_ONSTART_STABILIZATION_MS,
  POST_ONSTART_STABILIZATION_MS,
  PHASES,
  RECORDER_OPTIONS,
  beginHold,
  beginHoldImmediately,
  cancelHold,
  endHold,
  getHoldToTalkState,
  invalidateActiveHoldToTalk,
  invalidateHoldToTalk,
  moveHold,
  registerHoldToTalkOwner,
  releaseHoldToTalkOwner
};
