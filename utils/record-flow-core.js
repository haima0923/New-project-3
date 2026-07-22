const {
  ADOPTION_STATUSES,
  AI_OUTCOMES,
  AI_REQUEST_STATUSES,
  CORE_CONTRACT_VERSION,
  CORE_IMPLEMENTATION_VERSION,
  EXECUTION_PATHS,
  FLOW_MODES,
  FORMAL_SAVE_STATUSES,
  PRODUCTION_ROUTES,
  PROVIDER_KINDS,
  RECORD_FLOW_ERROR_CODES,
  RESULT_SCOPES,
  TRACE_SCHEMA_VERSION,
  normalizeAiOutcome,
  normalizeFlowMode,
  normalizeProductionRoute,
  normalizeProviderKind,
  normalizeRecordFlowErrorCode,
  normalizeSafetyStatus
} = require('./record-flow-contract');
const {
  completeTraceStage,
  createRecordFlowTrace,
  failTraceStage,
  finalizeRecordFlowTrace,
  safeClone,
  skipTraceStage,
  startTraceStage
} = require('./record-flow-trace');
const {
  finishHybridWithoutAi,
  getAiBusinessResultValidity,
  getAiFailureReason,
  getAiFailureStatus,
  normalizeAiBusinessResult,
  normalizeAiResult,
  prepareHybridLocalStage,
  ROUTE_AI_DEEP,
  ROUTE_AI_STANDARD,
  ROUTE_LOCAL,
  ROUTE_PENDING,
  withAiStatus
} = require('./ai-parser');
const { applyFinalParseSafety } = require('./parse-safety');
const { getUnresolvedAiReason, isFormalReady } = require('./business');
const { normalizeBusinessText } = require('./text-normalize');
const {
  getExistingHybridAiAdapterDescriptor,
  getExistingHybridTransportEvents
} = require('./record-flow-ai-adapters');
const {
  DEFAULT_BUSINESS_TIMEZONE,
  resolveRecordFlowRuntime
} = require('./record-flow-runtime');

const trustedAdapterDescriptors = new WeakMap();

function cloneInputValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeInputSource(value) {
  const source = String(value || 'typed').trim().toLowerCase();
  if (source === 'paste') return 'chat';
  if (['typed', 'voice', 'chat', 'imported', 'test'].includes(source)) return source;
  return 'unknown';
}

function toLegacyInputSource(value) {
  const source = normalizeInputSource(value);
  if (source === 'chat') return 'paste';
  if (source === 'imported' || source === 'test') return 'typed';
  return source;
}

function createFlowError(code, stage, message, details = {}) {
  const canonicalCode = normalizeRecordFlowErrorCode(code);
  return Object.assign({
    code: canonicalCode,
    codeRaw: code || '',
    stage,
    message: message || code,
    retryable: false,
    blocksFormalSave: true
  }, safeClone(details));
}

function getExecutionPath(route) {
  const mapping = {
    [ROUTE_LOCAL]: EXECUTION_PATHS.PRODUCTION_LOCAL,
    [ROUTE_PENDING]: EXECUTION_PATHS.PRODUCTION_PENDING,
    [ROUTE_AI_STANDARD]: EXECUTION_PATHS.PRODUCTION_STANDARD,
    [ROUTE_AI_DEEP]: EXECUTION_PATHS.PRODUCTION_DEEP
  };
  return mapping[route] || EXECUTION_PATHS.UNKNOWN;
}

function getAiOutcome(result, errorCode, providerKind) {
  const code = String(errorCode || '').toUpperCase();
  if (code === 'AI_RESPONSE_EMPTY_BUSINESS') return AI_OUTCOMES.EMPTY_BUSINESS_RESULT;
  if (code === 'AI_RESPONSE_INVALID') return AI_OUTCOMES.INVALID_RESPONSE;
  const legacyOutcome = normalizeAiOutcome(result && result.ai_fallback && result.ai_fallback.status);
  if ([
    AI_OUTCOMES.FAILED,
    AI_OUTCOMES.TIMED_OUT,
    AI_OUTCOMES.INVALID_RESPONSE,
    AI_OUTCOMES.EMPTY_BUSINESS_RESULT,
    AI_OUTCOMES.SKIPPED_NO_ENDPOINT
  ].includes(legacyOutcome)) return legacyOutcome;
  if (providerKind === PROVIDER_KINDS.MOCK && legacyOutcome === AI_OUTCOMES.USED) return AI_OUTCOMES.MOCK_USED;
  return legacyOutcome;
}

function getAiRequestStatus(outcome, events = {}) {
  if (outcome === AI_OUTCOMES.NOT_REQUESTED) return AI_REQUEST_STATUSES.NOT_REQUESTED;
  if (outcome === AI_OUTCOMES.TIMED_OUT) return AI_REQUEST_STATUSES.TIMED_OUT;
  if (outcome === AI_OUTCOMES.SKIPPED_NO_ENDPOINT) return AI_REQUEST_STATUSES.SKIPPED;
  if (outcome === AI_OUTCOMES.FAILED) {
    return AI_REQUEST_STATUSES.FAILED;
  }
  if ([
    AI_OUTCOMES.USED,
    AI_OUTCOMES.RETURNED_UNCERTAIN,
    AI_OUTCOMES.MOCK_USED,
    AI_OUTCOMES.INVALID_RESPONSE,
    AI_OUTCOMES.EMPTY_BUSINESS_RESULT
  ].includes(outcome)) {
    return events.responseReceived === true
      ? AI_REQUEST_STATUSES.SUCCEEDED
      : AI_REQUEST_STATUSES.FAILED;
  }
  return AI_REQUEST_STATUSES.UNKNOWN;
}

function getAdoptionStatus(result, aiRequested) {
  if (!aiRequested) {
    return { status: ADOPTION_STATUSES.NOT_APPLICABLE, resolved: true };
  }
  const fallback = (result && result.ai_fallback) || {};
  if (fallback.status === 'used' && fallback.business_result_valid === true) {
    // The legacy production normalizer merges and protects fields in one step.
    // Until field-level provenance exists, claiming full or partial adoption
    // would be a guess and would corrupt layer attribution.
    return { status: ADOPTION_STATUSES.NOT_APPLICABLE, resolved: false };
  }
  if (['failed', 'timed_out', 'mock_used', 'skipped_no_endpoint'].includes(fallback.status)
    || fallback.business_result_valid === false) {
    return { status: ADOPTION_STATUSES.NOT_ADOPTED, resolved: true };
  }
  // An explicit uncertain conclusion can tighten safety, but does not contribute
  // a reliable business field in the current facade.
  return { status: ADOPTION_STATUSES.NOT_ADOPTED, resolved: true };
}

function buildSaveEligibility(result, options = {}) {
  if (!result) {
    return {
      allowed: false,
      domainCanSaveFormal: false,
      canCommitToMemory: false,
      canCommitToRealStorage: false,
      commitScope: 'BLOCKED',
      status: FORMAL_SAVE_STATUSES.BLOCKED,
      blockedReasons: ['没有可保存的解析结果。'],
      formalSaveBlocked: true,
      aiResultResolved: false
    };
  }
  const reasons = [];
  const missing = Array.isArray(result.missing_fields) ? result.missing_fields : [];
  const low = Array.isArray(result.low_confidence_fields) ? result.low_confidence_fields : [];
  const conflicts = Array.isArray(result.field_conflicts) ? result.field_conflicts : [];
  if (missing.length) reasons.push(`缺少字段：${missing.join('、')}`);
  if (low.length) reasons.push(`需要确认字段：${low.join('、')}`);
  if (conflicts.length) reasons.push('字段之间存在冲突。');
  if (result.formal_save_blocked) reasons.push(result.block_reason || '当前结果明确禁止正式保存。');
  if (result.mixed_business) reasons.push('原文包含多项业务，尚未拆分确认。');
  if (result.requires_existing_record) reasons.push('需要先选择要更新的原业务记录。');
  if (result.intent === 'unknown') reasons.push('业务类型尚未确定。');
  const unresolvedAiReason = getUnresolvedAiReason(result);
  if (unresolvedAiReason) reasons.push(unresolvedAiReason);
  const allowed = isFormalReady(result);
  if (!allowed && !reasons.length) reasons.push('未通过现有正式保存安全闸门。');
  const providerKind = normalizeProviderKind(options.providerKind || PROVIDER_KINDS.NONE);
  const aiRequested = options.aiRequested === true;
  const canCommitToMemory = allowed && providerKind !== PROVIDER_KINDS.MOCK;
  const trustedRealAi = providerKind === PROVIDER_KINDS.REAL;
  const canCommitToRealStorage = allowed && (!aiRequested || trustedRealAi);
  const commitScope = !allowed || providerKind === PROVIDER_KINDS.MOCK
    ? 'BLOCKED'
    : (canCommitToRealStorage ? 'REAL_OR_MEMORY' : 'MEMORY_ONLY');
  if (allowed && aiRequested && !trustedRealAi) {
    reasons.push(providerKind === PROVIDER_KINDS.MOCK
      ? '模拟 AI 结果不能写入正式存储。'
      : '当前 AI adapter 不是已注册的真实 provider，只能用于内存态验证。');
  }
  return {
    allowed,
    domainCanSaveFormal: allowed,
    canCommitToMemory,
    canCommitToRealStorage,
    commitScope,
    status: allowed ? FORMAL_SAVE_STATUSES.ALLOWED : FORMAL_SAVE_STATUSES.BLOCKED,
    blockedReasons: Array.from(new Set(reasons.filter(Boolean))),
    formalSaveBlocked: Boolean(result.formal_save_blocked),
    aiResultResolved: !unresolvedAiReason
  };
}

function buildConfirmationSummary(result, route, saveEligibility) {
  if (!result) {
    return {
      canSaveFormal: false,
      canCommitToMemory: false,
      canCommitToRealStorage: false,
      commitScope: 'BLOCKED',
      canSavePending: false,
      needsUserConfirmation: false,
      needsAdditionalFieldConfirmation: false,
      requiresExplicitSaveAction: false,
      needsDeepReview: false,
      needsFullPage: null,
      requiredFields: null,
      missingRequiredFields: [],
      missingFields: [],
      warnings: []
    };
  }
  const missingFields = Array.isArray(result.missing_fields) ? result.missing_fields.slice() : [];
  const lowFields = Array.isArray(result.low_confidence_fields) ? result.low_confidence_fields.slice() : [];
  const conflicts = Array.isArray(result.field_conflicts) ? result.field_conflicts : [];
  const warnings = Array.from(new Set([].concat(
    result.unsafe_reasons || [],
    route && route.reasons ? route.reasons : [],
    saveEligibility.blockedReasons || []
  ).filter(Boolean)));
  return {
    canSaveFormal: saveEligibility.domainCanSaveFormal,
    canCommitToMemory: saveEligibility.canCommitToMemory,
    canCommitToRealStorage: saveEligibility.canCommitToRealStorage,
    commitScope: saveEligibility.commitScope,
    canSavePending: true,
    // All formal saves still require the boss to click. The additional flag below
    // describes field/risk review and must not be read as auto-save permission.
    needsUserConfirmation: true,
    needsAdditionalFieldConfirmation: !saveEligibility.domainCanSaveFormal
      || missingFields.length > 0 || lowFields.length > 0 || conflicts.length > 0,
    requiresExplicitSaveAction: true,
    needsDeepReview: Boolean(route && route.deep_review_available),
    // The shared full-page navigation rule is intentionally not part of Phase 1B.
    needsFullPage: null,
    // The unified per-intent required-field catalogue belongs to a later phase.
    requiredFields: null,
    missingRequiredFields: missingFields.slice(),
    missingFields,
    warnings
  };
}

function registerAiAdapter(execute, descriptor, inspectors = {}) {
  const trustedDescriptor = Object.freeze({
    adapterId: descriptor.adapterId || '',
    adapterName: descriptor.adapterName || descriptor.adapterId || '',
    providerKind: normalizeProviderKind(descriptor.providerKind),
    provider: descriptor.provider || '',
    model: descriptor.model || '',
    modelTier: descriptor.modelTier || '',
    networkAccess: descriptor.networkAccess === true,
    supportsStandard: descriptor.supportsStandard !== false,
    supportsDeep: descriptor.supportsDeep !== false,
    supportsAbort: descriptor.supportsAbort === true,
    supportsUsage: descriptor.supportsUsage === true,
    referenceMetadata: safeClone(descriptor.referenceMetadata || {})
  });
  const parse = function parse(request, hooks = {}) {
    if (typeof hooks.onRequestStarted === 'function') hooks.onRequestStarted();
    return Promise.resolve()
      .then(() => execute(request, hooks))
      .then((response) => {
        if (typeof hooks.onResponseReceived === 'function') hooks.onResponseReceived();
        return response;
      })
      .catch((error) => {
        if (error && /timeout|超时/i.test(`${error.code || ''} ${error.message || ''}`)) {
          if (typeof hooks.onTimeout === 'function') hooks.onTimeout(error);
        } else if (typeof hooks.onTransportError === 'function') {
          hooks.onTransportError(error);
        }
        throw error;
      });
  };
  const adapter = Object.freeze(Object.assign({
    execute: parse,
    parse,
    getIdentity() { return safeClone(trustedDescriptor); }
  }, inspectors, { descriptor: trustedDescriptor }));
  trustedAdapterDescriptors.set(adapter, trustedDescriptor);
  return adapter;
}

function normalizeAdapterHandlerResponse(value) {
  if (value && typeof value === 'object' && (
    Object.prototype.hasOwnProperty.call(value, 'rawResult')
    || Object.prototype.hasOwnProperty.call(value, 'parsedResult')
    || Object.prototype.hasOwnProperty.call(value, 'rawText')
    || value.ok === false
  )) return value;
  return { rawResult: value };
}

function createFakeAiAdapter(handler, descriptorOverrides = {}) {
  const calls = [];
  const descriptor = {
    adapterId: descriptorOverrides.adapterId || 'phase1a-fake',
    providerKind: PROVIDER_KINDS.FAKE,
    provider: descriptorOverrides.provider || 'phase1a-fake',
    model: descriptorOverrides.model || 'deterministic-fake',
    modelTier: descriptorOverrides.modelTier || 'test',
    networkAccess: false,
    supportsStandard: descriptorOverrides.supportsStandard !== false,
    supportsDeep: descriptorOverrides.supportsDeep !== false
  };
  return registerAiAdapter(
    function execute(context) {
      calls.push(safeClone(context));
      return Promise.resolve()
        .then(() => (typeof handler === 'function' ? handler(context) : handler))
        .then(normalizeAdapterHandlerResponse);
    },
    descriptor,
    {
    getCallCount() { return calls.length; },
    getCalls() { return safeClone(calls); }
    }
  );
}

function createMockAiAdapter(handler, descriptorOverrides = {}) {
  const calls = [];
  return registerAiAdapter(
    function execute(context) {
      calls.push(safeClone(context));
      return Promise.resolve()
        .then(() => (typeof handler === 'function' ? handler(context) : handler))
        .then(normalizeAdapterHandlerResponse);
    },
    {
      adapterId: descriptorOverrides.adapterId || 'phase1a-mock',
      providerKind: PROVIDER_KINDS.MOCK,
      provider: descriptorOverrides.provider || 'registered-mock',
      model: descriptorOverrides.model || 'mock',
      modelTier: descriptorOverrides.modelTier || 'test',
      networkAccess: false,
      supportsStandard: descriptorOverrides.supportsStandard !== false,
      supportsDeep: descriptorOverrides.supportsDeep !== false
    },
    {
      getCallCount() { return calls.length; },
      getCalls() { return safeClone(calls); }
    }
  );
}

function createReplayAiAdapter(handler, descriptorOverrides = {}) {
  if (descriptorOverrides.referenceMetadata !== undefined
    && (!descriptorOverrides.referenceMetadata
      || typeof descriptorOverrides.referenceMetadata !== 'object'
      || Array.isArray(descriptorOverrides.referenceMetadata))) {
    const error = new Error('REPLAY referenceMetadata must be an object when provided');
    error.code = RECORD_FLOW_ERROR_CODES.REPLAY_METADATA_INVALID;
    throw error;
  }
  const calls = [];
  return registerAiAdapter(
    function execute(context) {
      calls.push(safeClone(context));
      return Promise.resolve()
        .then(() => (typeof handler === 'function' ? handler(context) : handler))
        .then(normalizeAdapterHandlerResponse);
    },
    {
      adapterId: descriptorOverrides.adapterId || 'phase1a-replay',
      providerKind: PROVIDER_KINDS.REPLAY,
      provider: descriptorOverrides.provider || 'fixture-replay',
      model: descriptorOverrides.model || 'replay',
      modelTier: descriptorOverrides.modelTier || 'test',
      networkAccess: false,
      supportsStandard: descriptorOverrides.supportsStandard !== false,
      supportsDeep: descriptorOverrides.supportsDeep !== false,
      referenceMetadata: descriptorOverrides.referenceMetadata || {}
    },
    {
      getCallCount() { return calls.length; },
      getCalls() { return safeClone(calls); }
    }
  );
}

function createNoAiAdapter() {
  let callCount = 0;
  return registerAiAdapter(
    function execute() {
      callCount += 1;
      const error = new Error('AI adapter must not be called on this route');
      error.code = RECORD_FLOW_ERROR_CODES.AI_CALLED_IN_LOCAL_ONLY;
      throw error;
    },
    {
      adapterId: 'no-ai',
      adapterName: 'fail-on-ai-call',
      providerKind: PROVIDER_KINDS.NONE,
      networkAccess: false,
      supportsStandard: false,
      supportsDeep: false
    },
    {
    getCallCount() { return callCount; }
    }
  );
}

function buildLegacyPayload(input, originalText, runtime) {
  const extractedText = typeof input.extractedText === 'string' ? input.extractedText : '';
  return {
    text: extractedText || originalText,
    rawText: originalText,
    extractedText,
    source: toLegacyInputSource(input.inputSource),
    context: input.context || 'home',
    reviewMode: input.reviewMode === 'deep' ? 'deep' : 'standard',
    businessDate: runtime.businessDate,
    businessTimezone: runtime.businessTimezone,
    nowInstant: runtime.nowInstant,
    state: cloneInputValue(input.initialState || {}),
    rawMessages: cloneInputValue(input.rawMessages || []),
    pasteMeta: cloneInputValue(input.pasteMeta || null)
  };
}

function setTraceAiMetadata(trace, adapter, response) {
  const descriptor = trustedAdapterDescriptors.get(adapter)
    || getExistingHybridAiAdapterDescriptor(adapter)
    || {};
  trace.ai.providerKindRaw = descriptor.providerKind || null;
  trace.ai.providerKind = normalizeProviderKind(descriptor.providerKind);
  trace.ai.adapterName = descriptor.adapterName || descriptor.adapterId || '';
  trace.ai.provider = descriptor.provider || (response && response.provider) || '';
  trace.ai.model = descriptor.model || (response && response.model) || '';
  trace.ai.modelTier = descriptor.modelTier || (response && response.modelTier) || '';
  trace.ai.referenceMetadata = descriptor.providerKind === PROVIDER_KINDS.REPLAY
    ? safeClone(descriptor.referenceMetadata || {})
    : null;
  trace.ai.usage = response && response.usage ? safeClone(response.usage) : null;
  trace.ai.serverRequestId = (response && response.serverRequestId) || '';
  trace.ai.providerRequestId = (response && response.providerRequestId) || '';
  return descriptor;
}

function getTrustedAiAdapterDescriptor(adapter) {
  return trustedAdapterDescriptors.get(adapter)
    || getExistingHybridAiAdapterDescriptor(adapter)
    || null;
}

function getAdapterParseFunction(adapter) {
  if (!adapter) return null;
  if (typeof adapter.parse === 'function') return adapter.parse.bind(adapter);
  if (typeof adapter.execute === 'function') return adapter.execute.bind(adapter);
  return null;
}

function setAiRequestState(trace, state) {
  trace.ai.requestState = state;
  trace.ai.requestStatus = state;
}

function finalizeAiMeasurement(trace) {
  trace.ai.countsAsRealAiCall = trace.ai.adapterInvoked === true
    && trace.ai.providerKind === PROVIDER_KINDS.REAL;
  if (trace.ai.providerKind === PROVIDER_KINDS.REPLAY) {
    trace.ai.latencyMs = null;
    trace.ai.latencyAvailable = false;
    trace.ai.latencySource = 'NOT_APPLICABLE_REPLAY';
    trace.ai.costAvailable = false;
    return;
  }
  if (trace.ai.adapterInvoked) {
    trace.ai.latencyMs = trace.timing.stages.ai.latencyMs;
    trace.ai.latencyAvailable = true;
    trace.ai.latencySource = 'CORE_OBSERVED';
  } else {
    trace.ai.latencyMs = null;
    trace.ai.latencyAvailable = false;
    trace.ai.latencySource = 'NOT_APPLICABLE';
  }
  trace.ai.costAvailable = false;
}

function buildAiAdapterRequest(input, prepared, trace, normalizedText, runtime, requestId, options = {}) {
  const aiOnly = options.aiOnly === true;
  const pasteMeta = cloneInputValue(input.pasteMeta || null);
  const pasteMessages = pasteMeta && (
    (Array.isArray(pasteMeta.rawMessages) && pasteMeta.rawMessages)
    || (Array.isArray(pasteMeta.messages) && pasteMeta.messages)
  );
  const rawMessages = Array.isArray(input.rawMessages) && input.rawMessages.length
    ? input.rawMessages
    : (pasteMessages || []);
  return {
    requestId,
    mode: trace.mode,
    reviewMode: input.reviewMode === 'deep' ? 'deep' : 'standard',
    originalText: trace.input.originalText,
    normalizedText,
    extractedText: input.extractedText || '',
    inputSource: trace.inputSource,
    legacyInputSource: toLegacyInputSource(input.inputSource),
    context: input.context || 'home',
    businessDate: runtime.businessDate,
    businessTimezone: runtime.businessTimezone,
    nowInstant: runtime.nowInstant,
    localDraft: aiOnly ? null : cloneInputValue(prepared.localResult),
    localDraftPolicy: aiOnly ? 'OMIT' : 'PRODUCTION_MERGE',
    businessContext: aiOnly
      ? cloneInputValue(input.businessContext || input.initialState || {})
      : cloneInputValue((prepared.scopedHistory || {}).businessContext || {}),
    customerCandidates: aiOnly
      ? cloneInputValue(input.historyCandidates || input.customerCandidates || [])
      : cloneInputValue((prepared.scopedHistory || {}).customers || []),
    rawMessages: cloneInputValue(rawMessages),
    selectedMessages: cloneInputValue(input.selectedMessages || (pasteMeta && pasteMeta.selectedMessages) || []),
    pasteMeta,
    requiredOutputShape: options.reviewMode === 'deep' || (!aiOnly && prepared.route.decision === ROUTE_AI_DEEP)
      ? 'record-deep-legacy-v1'
      : 'record-standard-legacy-v1',
    deadlineMs: null,
    productionRoute: aiOnly ? null : trace.routing.productionRoute,
    executionPath: trace.routing.executionPath,
    routeDecision: aiOnly ? null : cloneInputValue(prepared.route),
    localDurationMs: aiOnly ? 0 : prepared.localDurationMs,
    traceContext: { runId: trace.runId, traceId: trace.traceId, caseId: trace.caseId }
  };
}

function buildRuntimeFailureOutput(input, error, dependencies = {}) {
  const originalText = typeof input.originalText === 'string' ? input.originalText : '';
  const modeRaw = input.mode || FLOW_MODES.PRODUCTION_ROUTING;
  const mode = normalizeFlowMode(modeRaw);
  const resultScope = getResultScopeForMode(mode);
  const inputSourceRaw = input.inputSource || 'typed';
  const flowError = createFlowError(
    (error && error.code) || RECORD_FLOW_ERROR_CODES.INPUT_INVALID,
    'input',
    error && error.message ? error.message : '运行时间上下文无效。'
  );
  const trace = createRecordFlowTrace({
    runId: input.runId || '',
    traceId: input.traceId || '',
    caseId: input.caseId || '',
    mode,
    modeRaw,
    resultScope,
    context: input.context || 'home',
    inputSource: normalizeInputSource(inputSourceRaw),
    inputSourceRaw,
    originalText,
    normalizedText: normalizeBusinessText(originalText).trim(),
    businessTimezone: input.businessTimezone || DEFAULT_BUSINESS_TIMEZONE,
    businessDate: input.businessDate || '',
    nowInstant: null,
    nowInstantResolved: false,
    clockSource: dependenciesSource(dependencies.clock),
    idGeneratorSource: dependenciesSource(dependencies.idGenerator)
  }, { skipClockRead: true });
  trace.errors = [flowError];
  trace.timing.stages.input.status = 'FAILED';
  return buildFlowOutput({
    mode,
    resultScope,
    trace,
    errors: [flowError]
  });
}

function dependenciesSource(value) {
  if (!value) return 'SYSTEM';
  return value.source === 'FIXED_TEST' ? 'FIXED_TEST' : 'INJECTED';
}

function getResultScopeForMode(mode) {
  if (mode === FLOW_MODES.LOCAL_ONLY) return RESULT_SCOPES.LOCAL_ONLY_RESULT;
  if (mode === FLOW_MODES.AI_ONLY) return RESULT_SCOPES.AI_ONLY_RESULT;
  if (mode === FLOW_MODES.PRODUCTION_ROUTING) return RESULT_SCOPES.PRODUCTION_RESULT;
  return RESULT_SCOPES.NOT_AVAILABLE;
}

function getExecutionPathForMode(mode, routeDecision, reviewMode) {
  if (mode === FLOW_MODES.LOCAL_ONLY) return EXECUTION_PATHS.LOCAL_ONLY;
  if (mode === FLOW_MODES.AI_ONLY) {
    return reviewMode === 'deep' ? EXECUTION_PATHS.AI_ONLY_DEEP : EXECUTION_PATHS.AI_ONLY_STANDARD;
  }
  return getExecutionPath(routeDecision);
}

function routeRequiresAi(routeDecision) {
  return routeDecision === ROUTE_AI_STANDARD || routeDecision === ROUTE_AI_DEEP;
}

function buildEligibilityEnvelope(mode, modeEligibility, productionEligibility, productionEligibilityResolved) {
  return {
    modeEligibility: safeClone(modeEligibility),
    productionEligibility: productionEligibilityResolved ? safeClone(productionEligibility) : null,
    productionEligibilityResolved: productionEligibilityResolved === true
  };
}

function buildModeSaveEligibility(result, mode, options = {}) {
  const eligibility = buildSaveEligibility(result, options);
  if (mode === FLOW_MODES.PRODUCTION_ROUTING) return eligibility;
  return Object.assign({}, eligibility, {
    canCommitToRealStorage: false,
    commitScope: eligibility.canCommitToMemory ? 'MEMORY_ONLY' : 'BLOCKED',
    blockedReasons: Array.from(new Set([].concat(
      eligibility.blockedReasons || [],
      eligibility.allowed ? `${mode} 结果仅用于隔离测试，不能直接写入正式存储。` : []
    )))
  });
}

function buildFlowOutput(options = {}) {
  const mode = options.mode || FLOW_MODES.PRODUCTION_ROUTING;
  const resultScope = options.resultScope || getResultScopeForMode(mode);
  const result = options.result ? safeClone(options.result) : null;
  const modeEligibility = options.modeEligibility || buildSaveEligibility(null);
  const eligibility = buildEligibilityEnvelope(
    mode,
    modeEligibility,
    options.productionEligibility || null,
    options.productionEligibilityResolved === true
  );
  return {
    schemaVersion: CORE_IMPLEMENTATION_VERSION,
    coreContractVersion: CORE_CONTRACT_VERSION,
    traceSchemaVersion: TRACE_SCHEMA_VERSION,
    mode,
    productionRoute: options.productionRoute || PRODUCTION_ROUTES.UNKNOWN,
    executionPath: options.executionPath || EXECUTION_PATHS.NOT_EXECUTED,
    resultScope,
    result,
    results: {
      finalResult: result,
      localResult: mode === FLOW_MODES.LOCAL_ONLY ? result : safeClone(options.localResult || null),
      aiOnlyResult: mode === FLOW_MODES.AI_ONLY ? result : null,
      productionResult: mode === FLOW_MODES.PRODUCTION_ROUTING ? result : safeClone(options.productionResult || null)
    },
    trace: safeClone(options.trace),
    confirmationSummary: safeClone(options.confirmationSummary
      || buildConfirmationSummary(null, null, buildSaveEligibility(null))),
    saveEligibility: safeClone(modeEligibility),
    eligibility,
    errors: safeClone(options.errors || [])
  };
}

async function runRecordFlow(input = {}, dependencies = {}) {
  let runtime;
  try {
    runtime = resolveRecordFlowRuntime(input, dependencies);
  } catch (error) {
    return buildRuntimeFailureOutput(input, error, dependencies);
  }
  const originalText = typeof input.originalText === 'string' ? input.originalText : '';
  const modeRaw = input.mode || FLOW_MODES.PRODUCTION_ROUTING;
  const mode = normalizeFlowMode(modeRaw);
  const resultScope = getResultScopeForMode(mode);
  const inputSourceRaw = input.inputSource || 'typed';
  const inputSource = normalizeInputSource(inputSourceRaw);
  const contextRaw = input.context || 'home';
  const normalizedText = normalizeBusinessText(
    typeof input.extractedText === 'string' && input.extractedText ? input.extractedText : originalText
  ).trim();
  const traceClock = runtime.clock;
  const trace = createRecordFlowTrace(Object.assign({}, input, {
    runId: runtime.runId,
    traceId: runtime.traceId,
    mode,
    modeRaw,
    resultScope,
    originalText,
    normalizedText,
    inputSource,
    inputSourceRaw,
    context: contextRaw,
    contextRaw,
    businessTimezone: runtime.businessTimezone,
    businessDate: runtime.businessDate,
    nowInstant: runtime.nowInstant,
    nowInstantResolved: runtime.nowInstantResolved,
    clockSource: runtime.clockSource,
    idGeneratorSource: runtime.idGeneratorSource
  }), {
    clock: traceClock,
    initialTimeSample: runtime.initialTimeSample
  });
  const errors = [];
  let result = null;
  let route = null;
  let shadowLocalFailed = false;

  startTraceStage(trace, 'input', traceClock);
  if (!originalText.trim()) {
    errors.push(createFlowError(RECORD_FLOW_ERROR_CODES.INPUT_INVALID, 'input', 'originalText 不能为空。'));
    trace.errors = errors.slice();
    failTraceStage(trace, 'input', traceClock);
    ['local', 'routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, traceClock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({ mode, resultScope, trace: finalizedTrace, errors: finalizedTrace.errors });
  }
  if (inputSource === 'unknown' || !['home', 'record'].includes(contextRaw)) {
    errors.push(createFlowError(
      RECORD_FLOW_ERROR_CODES.INPUT_INVALID,
      'input',
      inputSource === 'unknown' ? 'inputSource 不在允许范围内。' : 'context 不在允许范围内。'
    ));
    trace.errors = errors.slice();
    failTraceStage(trace, 'input', traceClock);
    ['local', 'routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, traceClock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({ mode, resultScope, trace: finalizedTrace, errors: finalizedTrace.errors });
  }
  completeTraceStage(trace, 'input', traceClock);

  if (![FLOW_MODES.PRODUCTION_ROUTING, FLOW_MODES.LOCAL_ONLY, FLOW_MODES.AI_ONLY].includes(mode)) {
    errors.push(createFlowError(
      RECORD_FLOW_ERROR_CODES.UNSUPPORTED_FLOW_MODE,
      'input',
      `不支持运行模式：${modeRaw}。`
    ));
    trace.errors = errors.slice();
    ['local', 'routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, traceClock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({ mode, resultScope, trace: finalizedTrace, errors: finalizedTrace.errors });
  }

  let legacyPayload;
  let prepared;
  startTraceStage(trace, 'local', traceClock);
  trace.local.executed = true;
  trace.local.shadowOnly = mode === FLOW_MODES.AI_ONLY;
  try {
    legacyPayload = buildLegacyPayload(input, originalText, runtime);
    prepared = prepareHybridLocalStage(legacyPayload);
    trace.local.result = safeClone(prepared.localResult);
    trace.local.confidence = prepared.localResult.confidence === undefined ? null : prepared.localResult.confidence;
    trace.local.warnings = safeClone(prepared.localResult.unsafe_reasons || []);
    trace.local.safetyRaw = ((prepared.localResult.local_parse_safety || {}).status) || null;
    trace.local.safety = normalizeSafetyStatus(trace.local.safetyRaw);
    completeTraceStage(trace, 'local', traceClock);
  } catch (error) {
    const flowError = createFlowError(
      RECORD_FLOW_ERROR_CODES.LOCAL_PARSE_FAILED,
      'local',
      error && error.message ? error.message : '本地解析失败。',
      mode === FLOW_MODES.AI_ONLY ? { blocksFormalSave: false, shadowOnly: true } : {}
    );
    errors.push(flowError);
    trace.local.errors.push(flowError);
    trace.errors = errors.slice();
    failTraceStage(trace, 'local', traceClock);
    if (mode === FLOW_MODES.AI_ONLY) {
      shadowLocalFailed = true;
      prepared = null;
    } else {
    ['routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, traceClock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({ mode, resultScope, trace: finalizedTrace, errors: finalizedTrace.errors });
    }
  }

  startTraceStage(trace, 'routing', traceClock);
  route = (prepared && prepared.route) || {};
  trace.routing.productionRouteRaw = route.decision || null;
  trace.routing.productionRoute = normalizeProductionRoute(route.decision);
  trace.routing.executionPath = getExecutionPathForMode(mode, route.decision, input.reviewMode);
  trace.routing.routeReasons = safeClone(route.reasons || []);
  trace.routing.deepReviewAvailable = Boolean(route.deep_review_available);
  if ((trace.routing.productionRoute === PRODUCTION_ROUTES.UNKNOWN && mode !== FLOW_MODES.AI_ONLY)
    || trace.routing.executionPath === EXECUTION_PATHS.UNKNOWN) {
    const routeError = createFlowError(
      RECORD_FLOW_ERROR_CODES.ROUTE_CONTRACT_VIOLATION,
      'routing',
      '现有路由返回了共享合同无法识别的值。',
      { routeRaw: route.decision || null }
    );
    errors.push(routeError);
    trace.errors = errors.slice();
    failTraceStage(trace, 'routing', traceClock);
    ['ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, traceClock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({
      mode,
      resultScope,
      productionRoute: trace.routing.productionRoute,
      executionPath: trace.routing.executionPath,
      trace: finalizedTrace,
      errors: finalizedTrace.errors
    });
  }
  trace.ai.requiredByRoute = routeRequiresAi(route.decision);
  trace.ai.requiredByProductionRoute = trace.ai.requiredByRoute;
  trace.ai.requiredByExecutionMode = mode === FLOW_MODES.AI_ONLY
    || (mode === FLOW_MODES.PRODUCTION_ROUTING && trace.ai.requiredByRoute);
  if (shadowLocalFailed) skipTraceStage(trace, 'routing', traceClock);
  else completeTraceStage(trace, 'routing', traceClock);

  const productionLocalResult = prepared ? finishHybridWithoutAi(prepared) : null;
  if (mode === FLOW_MODES.LOCAL_ONLY) {
    result = productionLocalResult || withAiStatus(prepared.localResult, 'not_requested', {
      attempted: false,
      reason: 'LOCAL_ONLY 模式只运行本地解析，不调用 AI。',
      businessResultValid: false
    });
    trace.ai.skippedReason = 'MODE_LOCAL_ONLY';
    trace.ai.providerKind = PROVIDER_KINDS.NONE;
    trace.ai.outcomeRaw = 'not_requested';
    trace.ai.outcome = AI_OUTCOMES.NOT_REQUESTED;
    setAiRequestState(trace, AI_REQUEST_STATUSES.NOT_REQUESTED);
    trace.merge.reason = 'LOCAL_ONLY_NO_AI_MERGE';
    skipTraceStage(trace, 'ai', traceClock);
    finalizeAiMeasurement(trace);
    skipTraceStage(trace, 'merge', traceClock);
  } else if (mode === FLOW_MODES.PRODUCTION_ROUTING && productionLocalResult) {
    result = productionLocalResult;
    trace.ai.skippedReason = route.decision === ROUTE_PENDING ? 'PRODUCTION_PENDING' : 'PRODUCTION_LOCAL';
    trace.ai.outcomeRaw = ((result.ai_fallback || {}).status) || 'not_requested';
    trace.ai.outcome = getAiOutcome(result, '', PROVIDER_KINDS.NONE);
    trace.merge.reason = 'PRODUCTION_ROUTE_DID_NOT_CALL_AI';
    skipTraceStage(trace, 'ai', traceClock);
    finalizeAiMeasurement(trace);
    skipTraceStage(trace, 'merge', traceClock);
  } else {
    const aiOnly = mode === FLOW_MODES.AI_ONLY;
    const aiAdapter = dependencies.aiAdapter;
    const adapterDescriptor = getTrustedAiAdapterDescriptor(aiAdapter);
    const adapterParse = getAdapterParseFunction(aiAdapter);
    trace.ai.requested = false;
    setAiRequestState(trace, AI_REQUEST_STATUSES.DECIDED);
    setTraceAiMetadata(trace, aiAdapter, null);
    startTraceStage(trace, 'ai', traceClock);
    let adapterPreflightError = null;
    if (!aiAdapter || !adapterParse) {
      adapterPreflightError = new Error('AI adapter is required for this execution path');
      adapterPreflightError.code = RECORD_FLOW_ERROR_CODES.AI_ADAPTER_REQUIRED;
    } else if (!adapterDescriptor || adapterDescriptor.providerKind === PROVIDER_KINDS.UNKNOWN) {
      adapterPreflightError = new Error('AI adapter identity is not registered by a trusted factory');
      adapterPreflightError.code = RECORD_FLOW_ERROR_CODES.AI_ADAPTER_IDENTITY_INVALID;
    } else if (adapterDescriptor.providerKind === PROVIDER_KINDS.NONE) {
      adapterPreflightError = new Error('The no-AI adapter is forbidden on an AI execution path');
      adapterPreflightError.code = RECORD_FLOW_ERROR_CODES.AI_ADAPTER_FORBIDDEN;
    } else {
      const needsDeep = trace.routing.executionPath === EXECUTION_PATHS.AI_ONLY_DEEP
        || trace.routing.executionPath === EXECUTION_PATHS.PRODUCTION_DEEP;
      if ((needsDeep && adapterDescriptor.supportsDeep !== true)
        || (!needsDeep && adapterDescriptor.supportsStandard !== true)) {
        adapterPreflightError = new Error(`AI adapter does not support ${needsDeep ? 'deep' : 'standard'} parsing`);
        adapterPreflightError.code = RECORD_FLOW_ERROR_CODES.AI_ADAPTER_CAPABILITY_MISSING;
      }
    }

    if (adapterPreflightError) {
      const status = adapterPreflightError.code === RECORD_FLOW_ERROR_CODES.AI_ADAPTER_REQUIRED
        ? 'skipped_no_endpoint'
        : 'failed';
      const baseResult = aiOnly ? {
        intent: 'unknown',
        operation: '',
        fields: {},
        missing_fields: [],
        low_confidence_fields: ['intent'],
        field_conflicts: [],
        formal_save_blocked: true,
        block_reason: 'AI_ONLY 没有得到可用的 AI 结果。',
        original_text: originalText,
        source: toLegacyInputSource(input.inputSource),
        ai_fallback: { needed: true }
      } : prepared.localResult;
      result = withAiStatus(baseResult, status, {
        attempted: false,
        reason: adapterPreflightError.message,
        code: adapterPreflightError.code,
        businessResultValid: false
      });
      errors.push(createFlowError(adapterPreflightError.code, 'ai', adapterPreflightError.message));
      trace.ai.errorCode = adapterPreflightError.code;
      trace.ai.errorCodeRaw = adapterPreflightError.code;
      trace.ai.errorMessage = adapterPreflightError.message;
      trace.ai.outcome = status === 'skipped_no_endpoint'
        ? AI_OUTCOMES.SKIPPED_NO_ENDPOINT
        : AI_OUTCOMES.FAILED;
      trace.ai.outcomeRaw = status;
      setAiRequestState(trace, status === 'skipped_no_endpoint'
        ? AI_REQUEST_STATUSES.SKIPPED
        : AI_REQUEST_STATUSES.FAILED);
      if (trace.ai.requestState === AI_REQUEST_STATUSES.SKIPPED) skipTraceStage(trace, 'ai', traceClock);
      else failTraceStage(trace, 'ai', traceClock);
      finalizeAiMeasurement(trace);
      trace.merge.reason = aiOnly ? 'AI_ONLY_NO_MERGE' : 'AI_PREFLIGHT_FAILED';
      skipTraceStage(trace, 'merge', traceClock);
      trace.merge.adoptionStatus = aiOnly
        ? ADOPTION_STATUSES.NOT_APPLICABLE
        : ADOPTION_STATUSES.NOT_ADOPTED;
      trace.merge.adoptionStatusResolved = true;
    } else {
      let response = null;
      let mergeStarted = false;
      try {
        const requestId = runtime.nextId('ai_request');
        trace.ai.requestId = requestId;
        trace.ai.adapterInvoked = true;
        trace.ai.adapterCallCount = 1;
        trace.ai.requestStarted = true;
        trace.ai.requested = true;
        setAiRequestState(trace, AI_REQUEST_STATUSES.REQUESTING);
        const request = buildAiAdapterRequest(
          input,
          prepared,
          trace,
          normalizedText,
          runtime,
          requestId,
          { aiOnly, reviewMode: input.reviewMode === 'deep' ? 'deep' : 'standard' }
        );
        if (aiOnly && request.localDraft !== null) {
          const leakError = new Error('AI_ONLY adapter request contains a local draft');
          leakError.code = RECORD_FLOW_ERROR_CODES.AI_ONLY_LOCAL_DRAFT_LEAK;
          throw leakError;
        }
        const transportEvents = { requestStarted: false, responseReceived: false, timedOut: false };
        response = await adapterParse(request, {
          onRequestStarted() { transportEvents.requestStarted = true; },
          onResponseReceived() { transportEvents.responseReceived = true; },
          onTransportError(error) {
            transportEvents.responseReceived = Boolean(error && error.statusCode);
          },
          onTimeout() { transportEvents.timedOut = true; }
        });
        trace.ai.requestStarted = trace.ai.requestStarted || transportEvents.requestStarted;
        trace.ai.responseReceived = true;
        const trustedEvents = getExistingHybridTransportEvents(response);
        if (trustedEvents) Object.assign(trace.ai, trustedEvents);
        setTraceAiMetadata(trace, aiAdapter, response);
        if (response && response.ok === false) {
          const responseError = new Error(
            (response.error && response.error.message) || 'AI adapter returned a structured failure'
          );
          responseError.code = (response.error && response.error.code) || RECORD_FLOW_ERROR_CODES.AI_CALL_FAILED;
          responseError.statusCode = response.error && response.error.httpStatus;
          responseError.retryable = Boolean(response.error && response.error.retryable);
          throw responseError;
        }
        let rawResult;
        if (response && Object.prototype.hasOwnProperty.call(response, 'parsedBusinessResult')) {
          rawResult = response.parsedBusinessResult;
        } else if (response && Object.prototype.hasOwnProperty.call(response, 'parsedResult')) {
          rawResult = response.parsedResult;
        } else if (response && Object.prototype.hasOwnProperty.call(response, 'rawResult')) {
          rawResult = response.rawResult;
        } else if (response && typeof response.rawText === 'string') {
          try {
            rawResult = JSON.parse(response.rawText);
          } catch (error) {
            const invalidError = new Error('AI adapter returned non-JSON rawText');
            invalidError.code = RECORD_FLOW_ERROR_CODES.AI_RESPONSE_INVALID;
            throw invalidError;
          }
        } else {
          rawResult = response;
        }
        if (typeof rawResult === 'string') {
          try {
            rawResult = JSON.parse(rawResult);
          } catch (error) {
            const invalidError = new Error('AI adapter returned a non-JSON business result');
            invalidError.code = RECORD_FLOW_ERROR_CODES.AI_RESPONSE_INVALID;
            throw invalidError;
          }
        }
        trace.ai.rawText = response && typeof response.rawText === 'string' ? response.rawText : '';
        trace.ai.parsedResult = safeClone(rawResult);
        trace.ai.rawResult = safeClone(rawResult);
        const validity = getAiBusinessResultValidity(rawResult);
        trace.ai.businessResultValid = validity.valid;
        if (aiOnly) {
          result = normalizeAiBusinessResult(rawResult, {
            businessDate: runtime.businessDate,
            businessTimezone: runtime.businessTimezone,
            nowInstant: runtime.nowInstant,
            originalText,
            source: toLegacyInputSource(input.inputSource),
            rawMessages: input.rawMessages,
            providerKind: trace.ai.providerKind
          });
          trace.ai.normalizedResult = safeClone(result);
          trace.ai.normalizationAvailable = true;
          trace.merge.reason = 'AI_ONLY_NO_LOCAL_MERGE';
          trace.merge.adoptionStatus = ADOPTION_STATUSES.NOT_APPLICABLE;
          trace.merge.adoptionStatusResolved = true;
          skipTraceStage(trace, 'merge', traceClock);
        } else {
          trace.ai.normalizedResult = null;
          trace.ai.normalizationAvailable = false;
          startTraceStage(trace, 'merge', traceClock);
          mergeStarted = true;
          result = normalizeAiResult(prepared.localResult, rawResult, {
            businessDate: runtime.businessDate,
            businessTimezone: runtime.businessTimezone,
            nowInstant: runtime.nowInstant
          });
          if (trace.ai.providerKind === PROVIDER_KINDS.MOCK
            && ((result.ai_fallback || {}).status) !== 'mock_used') {
            result = withAiStatus(result, 'mock_used', {
              attempted: true,
              reason: '调用方注册的是模拟 AI adapter，结果不能作为真实 AI 成功使用。',
              code: '',
              businessResultValid: Boolean(result.ai_fallback && result.ai_fallback.business_result_valid)
            });
          }
          trace.merge.performed = true;
          trace.merge.reason = 'PRODUCTION_LOCAL_AI_MERGE';
          trace.merge.result = safeClone(result);
          trace.merge.conflicts = safeClone((result && result.field_conflicts) || []);
          completeTraceStage(trace, 'merge', traceClock);
        }
      } catch (error) {
        const noEndpoint = error && error.code === RECORD_FLOW_ERROR_CODES.AI_ENDPOINT_MISSING;
        const preflightFailure = error && [
          RECORD_FLOW_ERROR_CODES.ID_GENERATOR_INVALID_RESULT,
          RECORD_FLOW_ERROR_CODES.AI_ONLY_LOCAL_DRAFT_LEAK
        ].includes(error.code);
        const legacyStatus = noEndpoint ? 'skipped_no_endpoint' : getAiFailureStatus(error);
        const trustedEvents = getExistingHybridTransportEvents(error);
        if (trustedEvents) Object.assign(trace.ai, trustedEvents);
        trace.ai.serverRequestId = (error && error.serverRequestId) || '';
        trace.ai.providerRequestId = (error && error.providerRequestId) || '';
        const baseResult = aiOnly ? {
          intent: 'unknown',
          operation: '',
          fields: {},
          missing_fields: [],
          low_confidence_fields: ['intent'],
          field_conflicts: [],
          formal_save_blocked: true,
          block_reason: 'AI_ONLY 没有得到可用的 AI 结果。',
          original_text: originalText,
          source: toLegacyInputSource(input.inputSource),
          ai_fallback: { needed: true }
        } : prepared.localResult;
        result = withAiStatus(baseResult, legacyStatus, {
          attempted: !noEndpoint && !preflightFailure,
          reason: noEndpoint ? (error.reason || '没有配置 AI 服务地址，无法发起 AI 请求。') : getAiFailureReason(error),
          code: error && error.code,
          businessResultValid: false
        });
        const errorCodeRaw = (error && error.code) || RECORD_FLOW_ERROR_CODES.AI_CALL_FAILED;
        const errorCode = normalizeRecordFlowErrorCode(errorCodeRaw);
        errors.push(createFlowError(errorCodeRaw, 'ai', error && error.message ? error.message : 'AI 调用失败。', {
          statusCode: error && error.statusCode,
          retryable: Boolean(error && error.retryable)
        }));
        if (!trustedEvents) {
          trace.ai.responseReceived = trace.ai.responseReceived || Boolean(error && (
            error.statusCode
            || ['AI_RESPONSE_INVALID', 'AI_RESPONSE_EMPTY_BUSINESS'].includes(error.code)
          ));
        }
        trace.ai.businessResultValid = false;
        trace.ai.errorCode = errorCode;
        trace.ai.errorCodeRaw = errorCodeRaw;
        trace.ai.errorMessage = (error && error.message) || 'AI 调用失败。';
        if (mergeStarted) failTraceStage(trace, 'merge', traceClock);
        else skipTraceStage(trace, 'merge', traceClock);
        trace.merge.reason = aiOnly ? 'AI_ONLY_NO_MERGE' : 'AI_FAILED_BEFORE_MERGE';
      }
      const aiFallback = (result && result.ai_fallback) || {};
      trace.ai.requested = aiFallback.attempted === true;
      trace.ai.outcomeRaw = aiFallback.status || null;
      trace.ai.outcome = getAiOutcome(result, trace.ai.errorCode, trace.ai.providerKind);
      setAiRequestState(trace, getAiRequestStatus(trace.ai.outcome, trace.ai));
      if (trace.ai.requestState === AI_REQUEST_STATUSES.SUCCEEDED) completeTraceStage(trace, 'ai', traceClock);
      else if (trace.ai.requestState === AI_REQUEST_STATUSES.SKIPPED) skipTraceStage(trace, 'ai', traceClock);
      else failTraceStage(trace, 'ai', traceClock);
      finalizeAiMeasurement(trace);
      if (!aiOnly) {
        const adoption = getAdoptionStatus(result, true);
        trace.merge.adoptionStatus = adoption.status;
        trace.merge.adoptionStatusResolved = adoption.resolved;
      }
    }
  }

  startTraceStage(trace, 'final', traceClock);
  let finalResult = null;
  try {
    finalResult = applyFinalParseSafety(result || {}, { businessDate: runtime.businessDate });
    finalResult = Object.assign({}, finalResult, { originalText });
    result = finalResult;
    const saveEligibility = buildModeSaveEligibility(finalResult, mode, {
      providerKind: trace.ai.providerKind,
      aiRequested: trace.ai.requiredByExecutionMode
    });
    const confirmationSummary = buildConfirmationSummary(
      finalResult,
      mode === FLOW_MODES.AI_ONLY ? null : route,
      saveEligibility
    );
    trace.final.result = safeClone(finalResult);
    trace.final.safety = normalizeSafetyStatus((finalResult.final_parse_safety || {}).status);
    trace.final.formalSaveBlocked = Boolean(finalResult.formal_save_blocked);
    trace.final.saveAllowed = saveEligibility.allowed;
    trace.final.saveBlockedReasons = safeClone(saveEligibility.blockedReasons);
    trace.confirmation.available = true;
    trace.confirmation.canSaveFormal = confirmationSummary.canSaveFormal;
    trace.confirmation.canSavePending = confirmationSummary.canSavePending;
    trace.confirmation.needsDeepReview = confirmationSummary.needsDeepReview;
    trace.confirmation.needsFullPage = confirmationSummary.needsFullPage;
    let productionEligibility = null;
    let productionEligibilityResolved = false;
    let productionResult = null;
    if (mode === FLOW_MODES.PRODUCTION_ROUTING) {
      productionEligibility = saveEligibility;
      productionEligibilityResolved = true;
      productionResult = finalResult;
    } else if (mode === FLOW_MODES.LOCAL_ONLY && route.decision === ROUTE_LOCAL) {
      productionEligibility = buildSaveEligibility(finalResult, {
        providerKind: PROVIDER_KINDS.NONE,
        aiRequested: false
      });
      productionEligibilityResolved = true;
      productionResult = finalResult;
    }
    trace.resultScope = resultScope;
    trace.eligibility = buildEligibilityEnvelope(
      mode,
      saveEligibility,
      productionEligibility,
      productionEligibilityResolved
    );
    trace.errors = errors.slice();
    completeTraceStage(trace, 'final', traceClock);
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({
      mode,
      resultScope,
      productionRoute: trace.routing.productionRoute,
      executionPath: trace.routing.executionPath,
      result: finalResult,
      localResult: prepared && prepared.localResult,
      productionResult,
      trace: finalizedTrace,
      confirmationSummary,
      modeEligibility: saveEligibility,
      productionEligibility,
      productionEligibilityResolved,
      errors
    });
  } catch (error) {
    errors.push(createFlowError(
      RECORD_FLOW_ERROR_CODES.FINAL_SAFETY_FAILED,
      'final',
      error && error.message ? error.message : '最终安全检查失败。'
    ));
    trace.errors = errors.slice();
    failTraceStage(trace, 'final', traceClock);
    const finalizedTrace = finalizeRecordFlowTrace(trace, { clock: traceClock });
    return buildFlowOutput({
      mode,
      resultScope,
      productionRoute: trace.routing.productionRoute,
      executionPath: trace.routing.executionPath,
      result: finalResult,
      localResult: prepared && prepared.localResult,
      trace: finalizedTrace,
      errors
    });
  }
}

module.exports = {
  buildConfirmationSummary,
  buildSaveEligibility,
  createFakeAiAdapter,
  createMockAiAdapter,
  createNoAiAdapter,
  createReplayAiAdapter,
  normalizeInputSource,
  runRecordFlow,
  toLegacyInputSource
};
