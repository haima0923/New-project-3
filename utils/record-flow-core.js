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
    return { status: ADOPTION_STATUSES.ADOPTED, resolved: true };
  }
  if (['failed', 'timed_out', 'mock_used', 'skipped_no_endpoint'].includes(fallback.status)
    || fallback.business_result_valid === false) {
    return { status: ADOPTION_STATUSES.NOT_ADOPTED, resolved: true };
  }
  // An explicit uncertain conclusion can tighten safety, but does not contribute
  // a reliable business field in Phase 1A.
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
    // The shared full-page navigation rule is intentionally not part of Phase 1A.
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
    providerKind: normalizeProviderKind(descriptor.providerKind),
    provider: descriptor.provider || '',
    model: descriptor.model || '',
    modelTier: descriptor.modelTier || '',
    networkAccess: descriptor.networkAccess === true
  });
  const adapter = Object.freeze(Object.assign({ execute }, inspectors, { descriptor: trustedDescriptor }));
  trustedAdapterDescriptors.set(adapter, trustedDescriptor);
  return adapter;
}

function createFakeAiAdapter(handler, descriptorOverrides = {}) {
  const calls = [];
  const descriptor = {
    adapterId: descriptorOverrides.adapterId || 'phase1a-fake',
    providerKind: PROVIDER_KINDS.FAKE,
    provider: descriptorOverrides.provider || 'phase1a-fake',
    model: descriptorOverrides.model || 'deterministic-fake',
    modelTier: descriptorOverrides.modelTier || 'test',
    networkAccess: false
  };
  return registerAiAdapter(
    function execute(context) {
      calls.push(safeClone(context));
      return Promise.resolve()
        .then(() => (typeof handler === 'function' ? handler(context) : handler))
        .then((value) => {
          if (value && Object.prototype.hasOwnProperty.call(value, 'rawResult')) return value;
          return { rawResult: value };
        });
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
        .then((value) => (value && Object.prototype.hasOwnProperty.call(value, 'rawResult')
          ? value
          : { rawResult: value }));
    },
    {
      adapterId: descriptorOverrides.adapterId || 'phase1a-mock',
      providerKind: PROVIDER_KINDS.MOCK,
      provider: descriptorOverrides.provider || 'registered-mock',
      model: descriptorOverrides.model || 'mock',
      modelTier: descriptorOverrides.modelTier || 'test',
      networkAccess: false
    },
    {
      getCallCount() { return calls.length; },
      getCalls() { return safeClone(calls); }
    }
  );
}

function createReplayAiAdapter(handler, descriptorOverrides = {}) {
  const calls = [];
  return registerAiAdapter(
    function execute(context) {
      calls.push(safeClone(context));
      return Promise.resolve()
        .then(() => (typeof handler === 'function' ? handler(context) : handler))
        .then((value) => (value && Object.prototype.hasOwnProperty.call(value, 'rawResult')
          ? value
          : { rawResult: value }));
    },
    {
      adapterId: descriptorOverrides.adapterId || 'phase1a-replay',
      providerKind: PROVIDER_KINDS.REPLAY,
      provider: descriptorOverrides.provider || 'fixture-replay',
      model: descriptorOverrides.model || 'replay',
      modelTier: descriptorOverrides.modelTier || 'test',
      networkAccess: false
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
    { adapterId: 'no-ai', providerKind: PROVIDER_KINDS.NONE, networkAccess: false },
    {
    getCallCount() { return callCount; }
    }
  );
}

function buildLegacyPayload(input, originalText) {
  const extractedText = typeof input.extractedText === 'string' ? input.extractedText : '';
  return {
    text: extractedText || originalText,
    rawText: originalText,
    extractedText,
    source: toLegacyInputSource(input.inputSource),
    context: input.context || 'home',
    reviewMode: input.reviewMode === 'deep' ? 'deep' : 'standard',
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
  trace.ai.provider = descriptor.provider || (response && response.provider) || '';
  trace.ai.model = descriptor.model || (response && response.model) || '';
  trace.ai.modelTier = descriptor.modelTier || (response && response.modelTier) || '';
  trace.ai.requestId = (response && response.requestId) || '';
  return descriptor;
}

function setAiRequestState(trace, state) {
  trace.ai.requestState = state;
  trace.ai.requestStatus = state;
}

function buildAiAdapterRequest(input, prepared, trace, normalizedText) {
  const pasteMeta = cloneInputValue(input.pasteMeta || null);
  const pasteMessages = pasteMeta && (
    (Array.isArray(pasteMeta.rawMessages) && pasteMeta.rawMessages)
    || (Array.isArray(pasteMeta.messages) && pasteMeta.messages)
  );
  const rawMessages = Array.isArray(input.rawMessages) && input.rawMessages.length
    ? input.rawMessages
    : (pasteMessages || []);
  return {
    requestId: `${trace.runId}:ai`,
    mode: trace.mode,
    reviewMode: input.reviewMode === 'deep' ? 'deep' : 'standard',
    originalText: trace.input.originalText,
    normalizedText,
    extractedText: input.extractedText || '',
    inputSource: trace.inputSource,
    legacyInputSource: toLegacyInputSource(input.inputSource),
    context: input.context || 'home',
    businessDate: input.businessDate || '',
    businessTimezone: input.businessTimezone || 'Asia/Shanghai',
    localDraft: cloneInputValue(prepared.localResult),
    businessContext: cloneInputValue((prepared.scopedHistory || {}).businessContext || {}),
    customerCandidates: cloneInputValue((prepared.scopedHistory || {}).customers || []),
    rawMessages: cloneInputValue(rawMessages),
    selectedMessages: cloneInputValue(input.selectedMessages || (pasteMeta && pasteMeta.selectedMessages) || []),
    pasteMeta,
    requiredOutputShape: prepared.route.decision === ROUTE_AI_DEEP ? 'record-deep-legacy-v1' : 'record-standard-legacy-v1',
    productionRoute: trace.routing.productionRoute,
    routeDecision: cloneInputValue(prepared.route),
    localDurationMs: prepared.localDurationMs,
    traceContext: { runId: trace.runId, caseId: trace.caseId }
  };
}

async function runRecordFlow(input = {}, dependencies = {}) {
  const originalText = typeof input.originalText === 'string' ? input.originalText : '';
  const modeRaw = input.mode || FLOW_MODES.PRODUCTION_ROUTING;
  const mode = normalizeFlowMode(modeRaw);
  const inputSourceRaw = input.inputSource || 'typed';
  const inputSource = normalizeInputSource(inputSourceRaw);
  const contextRaw = input.context || 'home';
  const normalizedText = normalizeBusinessText(
    typeof input.extractedText === 'string' && input.extractedText ? input.extractedText : originalText
  ).trim();
  const trace = createRecordFlowTrace(Object.assign({}, input, {
    mode,
    modeRaw,
    originalText,
    normalizedText,
    inputSource,
    inputSourceRaw,
    context: contextRaw,
    contextRaw
  }), dependencies);
  const errors = [];
  let result = null;
  let route = null;

  startTraceStage(trace, 'input', dependencies.clock);
  if (!originalText.trim()) {
    errors.push(createFlowError(RECORD_FLOW_ERROR_CODES.INPUT_INVALID, 'input', 'originalText 不能为空。'));
    trace.errors = errors.slice();
    failTraceStage(trace, 'input', dependencies.clock);
    ['local', 'routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, dependencies.clock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      result: null,
      trace: finalizedTrace,
      confirmationSummary: buildConfirmationSummary(null, null, buildSaveEligibility(null)),
      saveEligibility: buildSaveEligibility(null),
      errors: finalizedTrace.errors
    };
  }
  if (inputSource === 'unknown' || !['home', 'record'].includes(contextRaw)) {
    errors.push(createFlowError(
      RECORD_FLOW_ERROR_CODES.INPUT_INVALID,
      'input',
      inputSource === 'unknown' ? 'inputSource 不在允许范围内。' : 'context 不在允许范围内。'
    ));
    trace.errors = errors.slice();
    failTraceStage(trace, 'input', dependencies.clock);
    ['local', 'routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, dependencies.clock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      result: null,
      trace: finalizedTrace,
      confirmationSummary: buildConfirmationSummary(null, null, buildSaveEligibility(null)),
      saveEligibility: buildSaveEligibility(null),
      errors: finalizedTrace.errors
    };
  }
  completeTraceStage(trace, 'input', dependencies.clock);

  if (mode !== FLOW_MODES.PRODUCTION_ROUTING) {
    errors.push(createFlowError(
      RECORD_FLOW_ERROR_CODES.MODE_INVALID,
      'input',
      `Phase 1A 尚未实现 ${mode}。`
    ));
    trace.errors = errors.slice();
    ['local', 'routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, dependencies.clock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      result: null,
      trace: finalizedTrace,
      confirmationSummary: buildConfirmationSummary(null, null, buildSaveEligibility(null)),
      saveEligibility: buildSaveEligibility(null),
      errors: finalizedTrace.errors
    };
  }

  let legacyPayload;
  let prepared;
  startTraceStage(trace, 'local', dependencies.clock);
  try {
    legacyPayload = buildLegacyPayload(input, originalText);
    prepared = prepareHybridLocalStage(legacyPayload);
    trace.local.result = safeClone(prepared.localResult);
    trace.local.confidence = prepared.localResult.confidence === undefined ? null : prepared.localResult.confidence;
    trace.local.warnings = safeClone(prepared.localResult.unsafe_reasons || []);
    trace.local.safetyRaw = ((prepared.localResult.local_parse_safety || {}).status) || null;
    trace.local.safety = normalizeSafetyStatus(trace.local.safetyRaw);
    completeTraceStage(trace, 'local', dependencies.clock);
  } catch (error) {
    const flowError = createFlowError(
      RECORD_FLOW_ERROR_CODES.LOCAL_PARSE_FAILED,
      'local',
      error && error.message ? error.message : '本地解析失败。'
    );
    errors.push(flowError);
    trace.local.errors.push(flowError);
    trace.errors = errors.slice();
    failTraceStage(trace, 'local', dependencies.clock);
    ['routing', 'ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, dependencies.clock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      result: null,
      trace: finalizedTrace,
      confirmationSummary: buildConfirmationSummary(null, null, buildSaveEligibility(null)),
      saveEligibility: buildSaveEligibility(null),
      errors: finalizedTrace.errors
    };
  }

  startTraceStage(trace, 'routing', dependencies.clock);
  route = prepared.route || {};
  trace.routing.productionRouteRaw = route.decision || null;
  trace.routing.productionRoute = normalizeProductionRoute(route.decision);
  trace.routing.executionPath = getExecutionPath(route.decision);
  trace.routing.routeReasons = safeClone(route.reasons || []);
  trace.routing.deepReviewAvailable = Boolean(route.deep_review_available);
  if (trace.routing.productionRoute === PRODUCTION_ROUTES.UNKNOWN
    || trace.routing.executionPath === EXECUTION_PATHS.UNKNOWN) {
    const routeError = createFlowError(
      RECORD_FLOW_ERROR_CODES.ROUTE_CONTRACT_VIOLATION,
      'routing',
      '现有路由返回了共享合同无法识别的值。',
      { routeRaw: route.decision || null }
    );
    errors.push(routeError);
    trace.errors = errors.slice();
    failTraceStage(trace, 'routing', dependencies.clock);
    ['ai', 'merge', 'final'].forEach((stage) => skipTraceStage(trace, stage, dependencies.clock));
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      result: null,
      trace: finalizedTrace,
      confirmationSummary: buildConfirmationSummary(null, route, buildSaveEligibility(null)),
      saveEligibility: buildSaveEligibility(null),
      errors: finalizedTrace.errors
    };
  }
  completeTraceStage(trace, 'routing', dependencies.clock);

  const localOnlyResult = finishHybridWithoutAi(prepared);
  if (localOnlyResult) {
    result = localOnlyResult;
    trace.ai.outcomeRaw = ((result.ai_fallback || {}).status) || 'not_requested';
    trace.ai.outcome = getAiOutcome(result, '', PROVIDER_KINDS.NONE);
    skipTraceStage(trace, 'ai', dependencies.clock);
    skipTraceStage(trace, 'merge', dependencies.clock);
  } else {
    const aiAdapter = dependencies.aiAdapter;
    trace.ai.requiredByRoute = true;
    trace.ai.requested = false;
    setAiRequestState(trace, AI_REQUEST_STATUSES.DECIDED);
    setTraceAiMetadata(trace, aiAdapter, null);
    startTraceStage(trace, 'ai', dependencies.clock);
    if (!aiAdapter || typeof aiAdapter.execute !== 'function') {
      const missingError = new Error('AI adapter is required for this production route');
      missingError.code = RECORD_FLOW_ERROR_CODES.AI_ADAPTER_REQUIRED;
      result = withAiStatus(prepared.localResult, 'skipped_no_endpoint', {
        attempted: false,
        reason: '没有提供 AI adapter，无法完成本次联网整理。',
        code: missingError.code
      });
      errors.push(createFlowError(missingError.code, 'ai', missingError.message));
      trace.ai.errorCode = missingError.code;
      trace.ai.errorCodeRaw = missingError.code;
      trace.ai.errorMessage = missingError.message;
      trace.ai.outcome = AI_OUTCOMES.SKIPPED_NO_ENDPOINT;
      trace.ai.outcomeRaw = 'skipped_no_endpoint';
      setAiRequestState(trace, AI_REQUEST_STATUSES.SKIPPED);
      skipTraceStage(trace, 'ai', dependencies.clock);
      trace.ai.latencyMs = trace.timing.stages.ai.latencyMs;
      skipTraceStage(trace, 'merge', dependencies.clock);
      trace.merge.adoptionStatus = ADOPTION_STATUSES.NOT_ADOPTED;
      trace.merge.adoptionStatusResolved = true;
    } else {
      let response = null;
      let mergeStarted = false;
      try {
        trace.ai.adapterInvoked = true;
        trace.ai.requestStarted = true;
        trace.ai.requested = true;
        setAiRequestState(trace, AI_REQUEST_STATUSES.REQUESTING);
        response = await aiAdapter.execute(buildAiAdapterRequest(input, prepared, trace, normalizedText));
        trace.ai.responseReceived = true;
        const trustedEvents = getExistingHybridTransportEvents(response);
        if (trustedEvents) Object.assign(trace.ai, trustedEvents);
        setTraceAiMetadata(trace, aiAdapter, response);
        trace.ai.rawResult = safeClone(response && Object.prototype.hasOwnProperty.call(response, 'rawResult')
          ? response.rawResult
          : response);
        // The current legacy normalizer combines normalization and merge. Phase 1A
        // must not pretend a separate AI-normalized object already exists.
        trace.ai.normalizedResult = null;
        trace.ai.normalizationAvailable = false;
        const rawResult = response && Object.prototype.hasOwnProperty.call(response, 'rawResult')
          ? response.rawResult
          : response;
        const validity = getAiBusinessResultValidity(rawResult);
        trace.ai.businessResultValid = validity.valid;
        startTraceStage(trace, 'merge', dependencies.clock);
        mergeStarted = true;
        result = normalizeAiResult(prepared.localResult, rawResult);
        if (trace.ai.providerKind === PROVIDER_KINDS.MOCK
          && ((result.ai_fallback || {}).status) !== 'mock_used') {
          result = withAiStatus(result, 'mock_used', {
            attempted: true,
            reason: '调用方注册的是模拟 AI adapter，结果不能作为真实 AI 成功使用。',
            code: '',
            businessResultValid: Boolean(result.ai_fallback && result.ai_fallback.business_result_valid)
          });
        }
        if (trace.ai.businessResultValid === null) {
          trace.ai.businessResultValid = Boolean(result && result.ai_fallback && result.ai_fallback.business_result_valid);
        }
        trace.merge.performed = true;
        trace.merge.result = safeClone(result);
        trace.merge.conflicts = safeClone((result && result.field_conflicts) || []);
        completeTraceStage(trace, 'merge', dependencies.clock);
      } catch (error) {
        const noEndpoint = error && error.code === RECORD_FLOW_ERROR_CODES.AI_ENDPOINT_MISSING;
        const legacyStatus = noEndpoint ? 'skipped_no_endpoint' : getAiFailureStatus(error);
        const trustedEvents = getExistingHybridTransportEvents(error);
        if (trustedEvents) Object.assign(trace.ai, trustedEvents);
        result = withAiStatus(prepared.localResult, legacyStatus, {
          attempted: !noEndpoint,
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
        if (mergeStarted) failTraceStage(trace, 'merge', dependencies.clock);
        else skipTraceStage(trace, 'merge', dependencies.clock);
      }
      const aiFallback = (result && result.ai_fallback) || {};
      trace.ai.requested = aiFallback.attempted === true;
      trace.ai.outcomeRaw = aiFallback.status || null;
      trace.ai.outcome = getAiOutcome(result, trace.ai.errorCode, trace.ai.providerKind);
      setAiRequestState(trace, getAiRequestStatus(trace.ai.outcome, trace.ai));
      if (trace.ai.requestState === AI_REQUEST_STATUSES.SUCCEEDED) completeTraceStage(trace, 'ai', dependencies.clock);
      else if (trace.ai.requestState === AI_REQUEST_STATUSES.SKIPPED) skipTraceStage(trace, 'ai', dependencies.clock);
      else failTraceStage(trace, 'ai', dependencies.clock);
      trace.ai.latencyMs = trace.timing.stages.ai.latencyMs;
      const adoption = getAdoptionStatus(result, true);
      trace.merge.adoptionStatus = adoption.status;
      trace.merge.adoptionStatusResolved = adoption.resolved;
    }
  }

  startTraceStage(trace, 'final', dependencies.clock);
  let finalResult = null;
  try {
    finalResult = applyFinalParseSafety(result || {});
    finalResult = Object.assign({}, finalResult, { originalText });
    result = finalResult;
    const saveEligibility = buildSaveEligibility(finalResult, {
      providerKind: trace.ai.providerKind,
      aiRequested: trace.ai.requiredByRoute
    });
    const confirmationSummary = buildConfirmationSummary(finalResult, route, saveEligibility);
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
    trace.errors = errors.slice();
    completeTraceStage(trace, 'final', dependencies.clock);
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      result: safeClone(finalResult),
      trace: finalizedTrace,
      confirmationSummary: safeClone(confirmationSummary),
      saveEligibility: safeClone(saveEligibility),
      errors: safeClone(errors)
    };
  } catch (error) {
    errors.push(createFlowError(
      RECORD_FLOW_ERROR_CODES.FINAL_SAFETY_FAILED,
      'final',
      error && error.message ? error.message : '最终安全检查失败。'
    ));
    trace.errors = errors.slice();
    failTraceStage(trace, 'final', dependencies.clock);
    const finalizedTrace = finalizeRecordFlowTrace(trace, dependencies);
    return {
      schemaVersion: CORE_IMPLEMENTATION_VERSION,
      coreContractVersion: CORE_CONTRACT_VERSION,
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      result: finalResult ? safeClone(finalResult) : null,
      trace: finalizedTrace,
      confirmationSummary: buildConfirmationSummary(null, route, buildSaveEligibility(null)),
      saveEligibility: buildSaveEligibility(null),
      errors: safeClone(errors)
    };
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
