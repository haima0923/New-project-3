const { stableHash } = require('./record-state-diff');

const VOICE_EVIDENCE_VERSION = 'voice-completion-evidence-v1';
const VOICE_FINAL_STATUS = 'COMPLETED';
const VOICE_TERMINAL_STATUSES = Object.freeze([
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'TIMED_OUT',
  'SUPERSEDED'
]);

let recognitionManager = null;
let activeSession = null;
let providerBoundSession = null;
let sessionSequence = 0;

function normalizeRecognizedText(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return '';
  if (/^(未识别语音|未识别到语音|没有识别到语音|无法识别语音|语音识别失败)$/.test(cleanText)) return '';
  return cleanText;
}

function readTextWithSource(payload, path = '') {
  if (!payload) return { sourceField: '', text: '' };
  if (typeof payload === 'string') {
    return {
      sourceField: path || 'payload',
      text: normalizeRecognizedText(payload)
    };
  }
  if (Array.isArray(payload)) {
    const parts = payload
      .map((item, index) => readTextWithSource(item, `${path || 'payload'}[${index}]`))
      .filter((item) => item.text);
    return {
      sourceField: parts.map((item) => item.sourceField).join('+'),
      text: normalizeRecognizedText(parts.map((item) => item.text).join(''))
    };
  }
  if (typeof payload !== 'object') {
    return {
      sourceField: path || 'payload',
      text: normalizeRecognizedText(payload)
    };
  }

  const fields = [
    'result',
    'text',
    'content',
    'recognitionResult',
    'recognizeResult',
    'voiceText',
    'transcription',
    'translateResult'
  ];

  for (const field of fields) {
    const value = readTextWithSource(payload[field], path ? `${path}.${field}` : field);
    if (value.text) return value;
  }

  const nestedFields = ['detail', 'data', 'res'];
  for (const field of nestedFields) {
    const value = readTextWithSource(payload[field], path ? `${path}.${field}` : field);
    if (value.text) return value;
  }

  return { sourceField: '', text: '' };
}

function readTextFromPayload(payload) {
  return readTextWithSource(payload).text;
}

function getPluginManager() {
  if (recognitionManager) return recognitionManager;
  if (typeof requirePlugin !== 'function') return null;
  try {
    const plugin = requirePlugin('WechatSI');
    if (!plugin || typeof plugin.getRecordRecognitionManager !== 'function') return null;
    recognitionManager = plugin.getRecordRecognitionManager();
    return recognitionManager;
  } catch (error) {
    return null;
  }
}

function isVoiceRecognitionAvailable() {
  return Boolean(getPluginManager());
}

function getMessage(error, fallback) {
  if (!error) return fallback;
  return error.msg || error.message || fallback;
}

function isTerminalStatus(status) {
  return VOICE_TERMINAL_STATUSES.includes(status);
}

function isCurrentSession(session) {
  return Boolean(
    session
    && activeSession
    && session.sessionId === activeSession.sessionId
  );
}

function nextEventSequence(session) {
  session.eventSequence += 1;
  return session.eventSequence;
}

function appendAudit(session, type, details = {}) {
  if (!session) return;
  const event = Object.assign({
    sequence: nextEventSequence(session),
    type
  }, details);
  session.audit.push(event);
  if (session.audit.length > 40) session.audit.splice(0, session.audit.length - 40);
}

function clearSessionTimeout(session) {
  if (!session || !session.timeoutHandle) return;
  clearTimeout(session.timeoutHandle);
  session.timeoutHandle = null;
}

function setTerminalStatus(session, status, reasonCode) {
  if (!session || isTerminalStatus(session.status)) return false;
  session.status = status;
  session.terminalReasonCode = reasonCode || status;
  session.completedAt = new Date().toISOString();
  clearSessionTimeout(session);
  appendAudit(session, status, { reasonCode: session.terminalReasonCode });
  return true;
}

function emitSessionError(session, error, fallback, status = 'FAILED') {
  if (!session || !setTerminalStatus(session, status, getMessage(error, fallback))) return;
  session.bindingStatus = 'INVALIDATED';
  notifySessionError(session, error, fallback, status);
}

function notifySessionError(session, error, fallback, status = 'FAILED') {
  if (!session) return;
  const handler = session.handlers.onError;
  if (typeof handler === 'function') {
    handler({
      sessionId: session.sessionId,
      status: status.toLowerCase(),
      message: getMessage(error, fallback || '语音识别失败，请改用打字或粘贴。')
    });
  }
}

function createTranscriptFingerprint(sessionId, text) {
  const transcript = normalizeRecognizedText(text);
  if (!sessionId || !transcript) return '';
  return stableHash({
    sessionId: String(sessionId),
    transcript
  }, 'voice-transcript-v1');
}

function buildCompletionEvidence(session, transcript, sourceField, payload) {
  const provider = payload && payload.synthetic === true ? 'fake-wechat-si' : 'wechat-si';
  return Object.freeze({
    version: VOICE_EVIDENCE_VERSION,
    status: VOICE_FINAL_STATUS,
    isFinal: true,
    source: 'VOICE_TRANSCRIPT',
    provider,
    sessionId: session.sessionId,
    utteranceId: `${session.sessionId}:utterance-1`,
    resultSequence: session.acceptedFinalSequence,
    callbackName: 'onStop',
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    transcriptFingerprint: createTranscriptFingerprint(session.sessionId, transcript),
    transcriptLength: transcript.length,
    transcriptSourceField: sourceField || 'onStop',
    evidenceSource: payload && payload.synthetic === true
      ? 'FAKE_VOICE_FINAL_CALLBACK'
      : 'VOICE_PROVIDER_FINAL_CALLBACK'
  });
}

function compactSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    status: session.status,
    bindingStatus: session.bindingStatus,
    eventSequence: session.eventSequence,
    partialCallbackCount: session.partialCallbackCount,
    finalCallbackInvocationCount: session.finalCallbackInvocationCount,
    acceptedFinalCount: session.acceptedFinalCount,
    acceptedFinalSequence: session.acceptedFinalSequence,
    staleSessionRejectedCount: session.staleSessionRejectedCount,
    providerStarted: session.providerStarted,
    providerTerminalObserved: session.providerTerminalObserved,
    stopRequested: session.stopRequested,
    waitingForProviderRelease: session.waitingForProviderRelease,
    terminalReasonCode: session.terminalReasonCode,
    evidence: session.evidence ? Object.assign({}, session.evidence) : null,
    audit: session.audit.map((event) => Object.assign({}, event))
  };
}

function getVoiceRecognitionAudit() {
  return compactSession(activeSession);
}

function validateVoiceCompletionEvidence(evidence, transcript, options = {}) {
  const source = String(options.inputChannel || options.source || 'voice').toLowerCase();
  const normalizedTranscript = normalizeRecognizedText(transcript);
  const reasons = [];
  const current = activeSession;
  if (!evidence || typeof evidence !== 'object') reasons.push('VOICE_EVIDENCE_MISSING');
  if (!['voice', 'voice_transcript'].includes(source)) reasons.push('NON_VOICE_INPUT_CHANNEL');
  if (!normalizedTranscript) reasons.push('VOICE_TRANSCRIPT_EMPTY');
  if (evidence && evidence.version !== VOICE_EVIDENCE_VERSION) reasons.push('VOICE_EVIDENCE_VERSION_INVALID');
  if (evidence && (evidence.status !== VOICE_FINAL_STATUS || evidence.isFinal !== true)) {
    reasons.push('VOICE_EVIDENCE_NOT_FINAL');
  }
  if (!current || !evidence || current.sessionId !== evidence.sessionId) {
    reasons.push('VOICE_SESSION_NOT_CURRENT');
  } else {
    if (current.status !== VOICE_FINAL_STATUS) reasons.push('VOICE_SESSION_NOT_COMPLETED');
    if (current.bindingStatus !== 'BOUND') reasons.push('VOICE_BINDING_INVALIDATED');
    if (current.acceptedFinalCount !== 1) reasons.push('VOICE_FINAL_NOT_EXACTLY_ONCE');
    if (current.finalTranscript !== normalizedTranscript) reasons.push('VOICE_TRANSCRIPT_CHANGED');
    if (current.evidence !== evidence
      && JSON.stringify(current.evidence || null) !== JSON.stringify(evidence || null)) {
      reasons.push('VOICE_EVIDENCE_NOT_SESSION_ISSUED');
    }
  }
  const expectedFingerprint = evidence
    ? createTranscriptFingerprint(evidence.sessionId, normalizedTranscript)
    : '';
  if (evidence && (
    !evidence.transcriptFingerprint
    || evidence.transcriptFingerprint !== expectedFingerprint
  )) {
    reasons.push('VOICE_TRANSCRIPT_FINGERPRINT_MISMATCH');
  }
  return {
    evidence: reasons.length === 0 ? Object.assign({}, evidence) : null,
    expectedFingerprint,
    fingerprintMatched: reasons.length === 0,
    valid: reasons.length === 0,
    reasons: Array.from(new Set(reasons))
  };
}

function invalidateVoiceCompletionEvidence(evidence, reasonCode = 'MANUAL_EDIT_AFTER_VOICE') {
  if (!activeSession || !evidence || activeSession.sessionId !== evidence.sessionId) {
    return false;
  }
  if (activeSession.bindingStatus === 'INVALIDATED') return true;
  activeSession.bindingStatus = 'INVALIDATED';
  activeSession.bindingInvalidationReason = reasonCode;
  appendAudit(activeSession, 'BINDING_INVALIDATED', { reasonCode });
  return true;
}

function classifyErrorStatus(payload) {
  const code = String(payload && (payload.code || payload.errCode) || '').toLowerCase();
  const message = String(payload && (payload.msg || payload.message || payload.errMsg) || '').toLowerCase();
  return /timeout|timed_out|超时/.test(`${code} ${message}`) ? 'TIMED_OUT' : 'FAILED';
}

function acceptProviderSequence(session, payload, eventType) {
  if (!payload || typeof payload !== 'object'
    || !Object.prototype.hasOwnProperty.call(payload, 'resultSequence')) {
    return true;
  }
  const sequence = Number(payload.resultSequence);
  if (!Number.isInteger(sequence) || sequence <= session.lastProviderSequence) {
    appendAudit(session, 'PROVIDER_SEQUENCE_REJECTED', {
      eventType,
      sequence: Number.isFinite(sequence) ? sequence : null
    });
    return false;
  }
  session.lastProviderSequence = sequence;
  return true;
}

function handleSessionTimeout(session) {
  if (!isCurrentSession(session) || isTerminalStatus(session.status)) return;
  setTerminalStatus(session, 'TIMED_OUT', 'VOICE_SESSION_TIMED_OUT');
  session.bindingStatus = 'INVALIDATED';
  notifySessionError(session, null, '语音识别等待超时，请重新说一遍。', 'TIMED_OUT');
  if (session.providerStarted && recognitionManager && typeof recognitionManager.stop === 'function') {
    try {
      recognitionManager.stop();
    } catch (error) {
      appendAudit(session, 'TIMEOUT_STOP_FAILED');
    }
  }
}

function armSessionTimeout(session, duration) {
  if (!session || session.timeoutHandle) return;
  const waitMs = Math.max(1000, Number(duration || 60000) + 5000);
  session.timeoutHandle = setTimeout(() => handleSessionTimeout(session), waitMs);
  if (session.timeoutHandle && typeof session.timeoutHandle.unref === 'function') {
    session.timeoutHandle.unref();
  }
}

function releaseProviderSession(session, terminalEvent) {
  if (!session || providerBoundSession !== session) return false;
  session.providerTerminalObserved = true;
  appendAudit(session, 'PROVIDER_TERMINAL_OBSERVED', {
    terminalEvent: terminalEvent || ''
  });
  providerBoundSession = null;
  const waiting = activeSession;
  if (
    waiting
    && waiting !== session
    && waiting.waitingForProviderRelease
    && !isTerminalStatus(waiting.status)
  ) {
    waiting.waitingForProviderRelease = false;
    appendAudit(waiting, 'PROVIDER_LEASE_ACQUIRED_AFTER_WAIT');
    beginSessionStart(waiting);
  }
  return true;
}

function bindManager(manager, session) {
  manager.onStart = (payload) => {
    if (providerBoundSession !== session) {
      appendAudit(session, 'UNBOUND_START_IGNORED');
      return;
    }
    if (!isCurrentSession(session) || isTerminalStatus(session.status)) {
      appendAudit(session, 'STALE_START_IGNORED');
      session.providerStarted = true;
      if (typeof manager.stop === 'function') {
        try {
          manager.stop();
        } catch (error) {
          appendAudit(session, 'STALE_START_STOP_FAILED');
        }
      }
      return;
    }
    session.providerStarted = true;
    session.status = session.stopRequested ? 'STOP_REQUESTED' : 'PARTIAL';
    appendAudit(session, 'PROVIDER_STARTED');
    if (typeof session.handlers.onStart === 'function') {
      session.handlers.onStart({
        provider: 'wechat-si',
        sessionId: session.sessionId,
        status: session.status
      });
    }
    if (session.stopRequested && typeof manager.stop === 'function') {
      try {
        manager.stop();
      } catch (error) {
        emitSessionError(session, error, '语音识别结束失败，请改用打字或粘贴。');
      }
    }
  };

  manager.onRecognize = (payload) => {
    if (providerBoundSession !== session) {
      appendAudit(session, 'UNBOUND_PARTIAL_IGNORED');
      return;
    }
    if (!isCurrentSession(session) || isTerminalStatus(session.status)) {
      appendAudit(session, 'STALE_PARTIAL_IGNORED');
      return;
    }
    if (!acceptProviderSequence(session, payload, 'PARTIAL')) return;
    const partialText = readTextFromPayload(payload);
    if (!partialText || partialText === session.latestPartialText) {
      appendAudit(session, 'DUPLICATE_OR_EMPTY_PARTIAL_IGNORED');
      return;
    }
    session.latestPartialText = partialText;
    session.partialCallbackCount += 1;
    session.status = session.stopRequested ? 'STOP_REQUESTED' : 'PARTIAL';
    appendAudit(session, 'PARTIAL_ACCEPTED');
    if (typeof session.handlers.onRecognize === 'function') {
      session.handlers.onRecognize({
        text: partialText,
        provider: payload && payload.synthetic === true ? 'fake-wechat-si' : 'wechat-si',
        sessionId: session.sessionId,
        status: 'partial'
      });
    }
  };

  manager.onStop = (payload) => {
    session.finalCallbackInvocationCount += 1;
    if (providerBoundSession !== session) {
      appendAudit(session, 'UNBOUND_FINAL_IGNORED');
      return;
    }
    if (!session.providerStarted) {
      session.staleSessionRejectedCount += 1;
      appendAudit(session, 'FINAL_BEFORE_PROVIDER_START_REJECTED');
      return;
    }
    if (isTerminalStatus(session.status)) {
      appendAudit(session, session.status === 'COMPLETED'
        ? 'DUPLICATE_FINAL_IGNORED'
        : 'FINAL_AFTER_TERMINAL_IGNORED');
      releaseProviderSession(session, 'onStop');
      return;
    }
    if (!isCurrentSession(session)) {
      session.staleSessionRejectedCount += 1;
      appendAudit(session, 'STALE_FINAL_IGNORED');
      releaseProviderSession(session, 'onStop');
      return;
    }
    if (!acceptProviderSequence(session, payload, 'FINAL')) return;
    const finalResult = readTextWithSource(payload);
    if (!finalResult.text) {
      if (typeof session.handlers.onStop === 'function') {
        session.handlers.onStop({
          provider: 'wechat-si',
          sessionId: session.sessionId,
          status: 'failed'
        });
      }
      emitSessionError(session, null, '没有听清楚，请重新按住说一遍。');
      releaseProviderSession(session, 'onStop');
      return;
    }
    session.acceptedFinalCount = 1;
    session.acceptedFinalSequence = nextEventSequence(session);
    session.finalTranscript = finalResult.text;
    session.status = VOICE_FINAL_STATUS;
    session.terminalReasonCode = 'VOICE_PROVIDER_FINAL_CALLBACK';
    session.completedAt = new Date().toISOString();
    session.bindingStatus = 'BOUND';
    clearSessionTimeout(session);
    session.evidence = buildCompletionEvidence(
      session,
      finalResult.text,
      finalResult.sourceField,
      payload
    );
    session.audit.push({
      sequence: session.acceptedFinalSequence,
      type: 'FINAL_ACCEPTED'
    });
    releaseProviderSession(session, 'onStop');
    if (typeof session.handlers.onStop === 'function') {
      session.handlers.onStop({
        provider: session.evidence.provider,
        sessionId: session.sessionId,
        status: 'completed'
      });
    }
    if (typeof session.handlers.onResult === 'function') {
      session.handlers.onResult({
        text: finalResult.text,
        confidence: 0,
        provider: session.evidence.provider,
        status: 'ok',
        voiceCompletionEvidence: Object.assign({}, session.evidence)
      });
    }
  };

  manager.onError = (payload) => {
    if (providerBoundSession !== session) {
      appendAudit(session, 'UNBOUND_ERROR_IGNORED');
      return;
    }
    if (!isCurrentSession(session) || isTerminalStatus(session.status)) {
      appendAudit(session, 'ERROR_AFTER_TERMINAL_IGNORED');
      releaseProviderSession(session, 'onError');
      return;
    }
    emitSessionError(
      session,
      payload,
      '语音识别失败，请改用打字或粘贴。',
      classifyErrorStatus(payload)
    );
    releaseProviderSession(session, 'onError');
  };
}

function startManager(manager, session, options) {
  if (!isCurrentSession(session) || isTerminalStatus(session.status)) return;
  if (providerBoundSession && providerBoundSession !== session) {
    session.waitingForProviderRelease = true;
    appendAudit(session, 'WAITING_FOR_PROVIDER_RELEASE');
    armSessionTimeout(session, options.duration);
    return;
  }
  providerBoundSession = session;
  bindManager(manager, session);
  armSessionTimeout(session, options.duration);
  try {
    const managerOptions = {
      duration: options.duration || 60000,
      lang: options.lang || 'zh_CN'
    };
    if (manager.__recordVoiceFake === true) {
      managerOptions.recordVoiceSessionId = session.sessionId;
    }
    manager.start(managerOptions);
  } catch (error) {
    emitSessionError(session, error, '语音识别启动失败，请改用打字或粘贴。');
    releaseProviderSession(session, 'startError');
  }
}

function supersedeActiveSession() {
  if (!activeSession || isTerminalStatus(activeSession.status)) return;
  const previous = activeSession;
  setTerminalStatus(previous, 'SUPERSEDED', 'NEW_VOICE_SESSION_STARTED');
  previous.bindingStatus = 'INVALIDATED';
  if (
    providerBoundSession === previous
    && recognitionManager
    && typeof recognitionManager.stop === 'function'
  ) {
    try {
      recognitionManager.stop();
    } catch (error) {
      appendAudit(previous, 'SUPERSEDE_STOP_FAILED');
    }
  }
}

function createSession(options) {
  sessionSequence += 1;
  return {
    sessionId: `voice-session-${sessionSequence}`,
    status: 'START_REQUESTED',
    bindingStatus: 'UNBOUND',
    bindingInvalidationReason: '',
    handlers: options,
    eventSequence: 0,
    lastProviderSequence: 0,
    partialCallbackCount: 0,
    finalCallbackInvocationCount: 0,
    acceptedFinalCount: 0,
    acceptedFinalSequence: 0,
    staleSessionRejectedCount: 0,
    latestPartialText: '',
    finalTranscript: '',
    providerStarted: false,
    providerTerminalObserved: false,
    stopRequested: false,
    waitingForProviderRelease: false,
    startOptions: options,
    startedAt: new Date().toISOString(),
    completedAt: '',
    terminalReasonCode: '',
    evidence: null,
    timeoutHandle: null,
    audit: []
  };
}

function beginSessionStart(session) {
  if (!session || !isCurrentSession(session) || isTerminalStatus(session.status)) return false;
  const options = session.startOptions || {};
  const manager = getPluginManager();
  if (!manager) {
    emitSessionError(session, null, '当前小程序还没配置语音识别，请改用打字或粘贴。');
    return false;
  }

  const start = () => {
    if (!isCurrentSession(session) || isTerminalStatus(session.status)) return;
    startManager(manager, session, options);
  };

  if (typeof wx === 'undefined' || typeof wx.getSetting !== 'function') {
    start();
    return true;
  }

  wx.getSetting({
    success: (res) => {
      if (!isCurrentSession(session) || isTerminalStatus(session.status)) return;
      const authSetting = (res && res.authSetting) || {};
      if (authSetting['scope.record'] === false) {
        emitSessionError(session, null, '请先在微信设置里打开麦克风权限。');
        return;
      }
      if (authSetting['scope.record']) {
        start();
        return;
      }
      wx.authorize({
        scope: 'scope.record',
        success: start,
        fail: () => emitSessionError(session, null, '没有麦克风权限，请改用打字或粘贴。')
      });
    },
    fail: start
  });

  return true;
}

function startVoiceRecognition(options = {}) {
  supersedeActiveSession();
  const session = createSession(options);
  activeSession = session;
  appendAudit(session, 'SESSION_CREATED');
  if (typeof options.onSession === 'function') {
    options.onSession({
      sessionId: session.sessionId,
      status: session.status
    });
  }
  if (providerBoundSession && !providerBoundSession.providerTerminalObserved) {
    session.waitingForProviderRelease = true;
    appendAudit(session, 'WAITING_FOR_PROVIDER_RELEASE');
    armSessionTimeout(session, options.duration);
    return true;
  }
  return beginSessionStart(session);
}

function stopVoiceRecognition() {
  const session = activeSession;
  const manager = getPluginManager();
  if (!session || isTerminalStatus(session.status) || !manager || typeof manager.stop !== 'function') {
    return false;
  }
  session.stopRequested = true;
  session.status = 'STOP_REQUESTED';
  appendAudit(session, 'STOP_REQUESTED');
  if (!session.providerStarted) return true;
  try {
    manager.stop();
    return true;
  } catch (error) {
    emitSessionError(session, error, '语音识别结束失败，请改用打字或粘贴。');
    return false;
  }
}

function cancelVoiceRecognition(reasonCode = 'USER_CANCELLED') {
  const session = activeSession;
  if (!session || isTerminalStatus(session.status)) return false;
  const manager = getPluginManager();
  const providerStarted = session.providerStarted;
  setTerminalStatus(session, 'CANCELLED', reasonCode);
  session.bindingStatus = 'INVALIDATED';
  if (providerStarted && manager && typeof manager.stop === 'function') {
    try {
      manager.stop();
    } catch (error) {
      appendAudit(session, 'CANCEL_STOP_FAILED');
    }
  }
  return true;
}

module.exports = {
  VOICE_EVIDENCE_VERSION,
  cancelVoiceRecognition,
  createTranscriptFingerprint,
  getVoiceRecognitionAudit,
  invalidateVoiceCompletionEvidence,
  isVoiceRecognitionAvailable,
  normalizeRecognizedText,
  startVoiceRecognition,
  stopVoiceRecognition,
  validateVoiceCompletionEvidence
};
