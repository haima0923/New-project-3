const {
  ADOPTION_STATUSES,
  AI_OUTCOMES,
  AI_REQUEST_STATUSES,
  EXECUTION_PATHS,
  FLOW_MODES,
  LOCAL_SAFETY_STATUSES,
  PRODUCTION_ROUTES,
  PROVIDER_KINDS,
  TARGET_TRACE_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION,
  TRACE_STAGE_STATUSES
} = require('./record-flow-contract');

const STAGE_NAMES = ['input', 'local', 'routing', 'ai', 'merge', 'final'];
const SENSITIVE_KEYS = new Set([
  'apikey', 'xapikey', 'accesstoken', 'refreshtoken', 'token', 'cookie', 'setcookie',
  'authorization', 'secret', 'clientsecret', 'password', 'privatekey', 'credential', 'credentials'
]);

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function sanitizeCredentialText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function getNowValue(clock) {
  let value;
  if (typeof clock === 'function') value = clock();
  else if (clock && typeof clock.now === 'function') value = clock.now();
  else if (clock && typeof clock.nowInstant === 'function') value = clock.nowInstant();
  else value = Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number(value);
}

function takeTime(clock) {
  const candidate = getNowValue(clock);
  const milliseconds = Number.isFinite(candidate) ? candidate : Date.now();
  return { milliseconds, instant: new Date(milliseconds).toISOString() };
}

function safeClone(value, seen = new WeakSet(), key = '') {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') return key === 'originalText' ? value : sanitizeCredentialText(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      code: value.code || '',
      message: sanitizeCredentialText(value.message || '')
    };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const cloned = value.map((item) => safeClone(item, seen, ''));
    seen.delete(value);
    return cloned;
  }
  const cloned = {};
  Object.keys(value).forEach((childKey) => {
    cloned[childKey] = safeClone(value[childKey], seen, childKey);
  });
  seen.delete(value);
  return cloned;
}

function makeRunId(idGenerator, startedAtMs) {
  if (typeof idGenerator === 'function') return String(idGenerator('record-flow-run'));
  if (idGenerator && typeof idGenerator.next === 'function') return String(idGenerator.next('record-flow-run'));
  return `record-flow-${startedAtMs}-${Math.random().toString(36).slice(2, 10)}`;
}

function createStageMap() {
  return STAGE_NAMES.reduce((result, stage) => {
    result[stage] = {
      status: TRACE_STAGE_STATUSES.NOT_STARTED,
      startedAt: null,
      finishedAt: null,
      latencyMs: null
    };
    return result;
  }, {});
}

function createRecordFlowTrace(input = {}, dependencies = {}) {
  const started = takeTime(dependencies.clock);
  const originalText = typeof input.originalText === 'string' ? input.originalText : '';
  const pasteMessages = input.pasteMeta && (
    (Array.isArray(input.pasteMeta.rawMessages) && input.pasteMeta.rawMessages)
    || (Array.isArray(input.pasteMeta.messages) && input.pasteMeta.messages)
  );
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    targetSchemaVersion: TARGET_TRACE_SCHEMA_VERSION,
    runId: input.runId || makeRunId(dependencies.idGenerator, started.milliseconds),
    caseId: input.caseId || '',
    mode: input.mode || FLOW_MODES.PRODUCTION_ROUTING,
    modeRaw: input.modeRaw === undefined ? (input.mode || null) : input.modeRaw,
    context: input.context || 'home',
    contextRaw: input.contextRaw === undefined ? (input.context || null) : input.contextRaw,
    inputSource: input.inputSource || 'typed',
    inputSourceRaw: input.inputSourceRaw === undefined ? (input.inputSource || null) : input.inputSourceRaw,
    input: {
      originalText,
      normalizedText: input.normalizedText || '',
      extractedText: input.extractedText || '',
      rawMessagesCount: Array.isArray(input.rawMessages) && input.rawMessages.length
        ? input.rawMessages.length
        : (pasteMessages || []).length
    },
    dataHandling: {
      persistencePolicy: 'MEMORY_ONLY',
      containsBusinessContent: true,
      mustRedactBeforePersistence: true
    },
    timing: {
      startedAt: started.instant,
      finishedAt: null,
      latencyMs: null,
      stages: createStageMap()
    },
    local: {
      result: null,
      confidence: null,
      warnings: [],
      safety: LOCAL_SAFETY_STATUSES.UNKNOWN,
      safetyRaw: null,
      errors: []
    },
    routing: {
      productionRoute: PRODUCTION_ROUTES.UNKNOWN,
      productionRouteRaw: null,
      executionPath: EXECUTION_PATHS.NOT_EXECUTED,
      routeReasons: [],
      deepReviewAvailable: false
    },
    ai: {
      requiredByRoute: false,
      adapterInvoked: false,
      requestStarted: false,
      responseReceived: false,
      requested: false,
      requestState: AI_REQUEST_STATUSES.NOT_REQUESTED,
      requestStatus: AI_REQUEST_STATUSES.NOT_REQUESTED,
      outcome: AI_OUTCOMES.NOT_REQUESTED,
      outcomeRaw: null,
      providerKind: PROVIDER_KINDS.NONE,
      providerKindRaw: null,
      provider: '',
      model: '',
      modelTier: '',
      requestId: '',
      latencyMs: null,
      businessResultValid: null,
      errorCode: '',
      errorCodeRaw: '',
      errorMessage: '',
      rawResult: null,
      normalizedResult: null,
      normalizationAvailable: false
    },
    merge: {
      performed: false,
      result: null,
      conflicts: [],
      adoptionStatus: ADOPTION_STATUSES.NOT_APPLICABLE,
      adoptionStatusResolved: true
    },
    final: {
      result: null,
      safety: LOCAL_SAFETY_STATUSES.UNKNOWN,
      formalSaveBlocked: null,
      saveAllowed: false,
      saveBlockedReasons: []
    },
    confirmation: {
      available: false,
      canSaveFormal: false,
      canSavePending: false,
      needsDeepReview: false,
      needsFullPage: null
    },
    errors: [],
    warnings: []
  };
}

function startTraceStage(trace, stage, clock) {
  if (!trace || !trace.timing || !trace.timing.stages[stage]) return trace;
  const now = takeTime(clock);
  trace.timing.stages[stage] = {
    status: TRACE_STAGE_STATUSES.RUNNING,
    startedAt: now.instant,
    finishedAt: null,
    latencyMs: null,
    _startedAtMs: now.milliseconds
  };
  return trace;
}

function finishTraceStage(trace, stage, status, clock) {
  if (!trace || !trace.timing || !trace.timing.stages[stage]) return trace;
  const now = takeTime(clock);
  const current = trace.timing.stages[stage];
  const startedAtMs = Number.isFinite(current._startedAtMs)
    ? current._startedAtMs
    : Date.parse(current.startedAt || now.instant);
  trace.timing.stages[stage] = {
    status,
    startedAt: current.startedAt || now.instant,
    finishedAt: now.instant,
    latencyMs: Math.max(0, now.milliseconds - startedAtMs)
  };
  return trace;
}

function completeTraceStage(trace, stage, clock) {
  return finishTraceStage(trace, stage, TRACE_STAGE_STATUSES.SUCCEEDED, clock);
}

function failTraceStage(trace, stage, clock) {
  return finishTraceStage(trace, stage, TRACE_STAGE_STATUSES.FAILED, clock);
}

function skipTraceStage(trace, stage, clock) {
  return finishTraceStage(trace, stage, TRACE_STAGE_STATUSES.SKIPPED, clock);
}

function finalizeRecordFlowTrace(trace, dependencies = {}) {
  const finished = takeTime(dependencies.clock);
  const startedAtMs = Date.parse(trace.timing.startedAt);
  trace.timing.finishedAt = finished.instant;
  trace.timing.latencyMs = Math.max(0, finished.milliseconds - startedAtMs);
  return safeClone(trace);
}

module.exports = {
  completeTraceStage,
  createRecordFlowTrace,
  failTraceStage,
  finalizeRecordFlowTrace,
  safeClone,
  skipTraceStage,
  startTraceStage
};
