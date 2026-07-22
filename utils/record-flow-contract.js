const CORE_CONTRACT_VERSION = 'record-shared-core-v1';
const CORE_IMPLEMENTATION_VERSION = 'record-flow-phase1c-v1';
const TARGET_TRACE_SCHEMA_VERSION = 'record-trace-v1';
const TRACE_SCHEMA_VERSION = 'record-trace-phase1c-v1';

function freezeEnum(values) {
  return Object.freeze(values.reduce((result, value) => {
    result[value] = value;
    return result;
  }, {}));
}

const FLOW_MODES = freezeEnum([
  'PRODUCTION_ROUTING',
  'LOCAL_ONLY',
  'AI_ONLY'
]);

const PRODUCTION_ROUTES = freezeEnum([
  'LOCAL',
  'PENDING',
  'AI_STANDARD',
  'AI_DEEP',
  'UNKNOWN'
]);

const EXECUTION_PATHS = freezeEnum([
  'LOCAL_ONLY',
  'AI_ONLY_STANDARD',
  'AI_ONLY_DEEP',
  'PRODUCTION_LOCAL',
  'PRODUCTION_PENDING',
  'PRODUCTION_STANDARD',
  'PRODUCTION_DEEP',
  'NOT_EXECUTED',
  'UNKNOWN'
]);

const RESULT_SCOPES = freezeEnum([
  'LOCAL_ONLY_RESULT',
  'AI_ONLY_RESULT',
  'PRODUCTION_RESULT',
  'NOT_AVAILABLE',
  'UNKNOWN'
]);

const AI_REQUEST_STATUSES = freezeEnum([
  'NOT_REQUESTED',
  'DECIDED',
  'REQUESTING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'SKIPPED',
  'UNKNOWN'
]);

const AI_OUTCOMES = freezeEnum([
  'NOT_REQUESTED',
  'USED',
  'RETURNED_UNCERTAIN',
  'FAILED',
  'TIMED_OUT',
  'MOCK_USED',
  'INVALID_RESPONSE',
  'EMPTY_BUSINESS_RESULT',
  'SKIPPED_NO_ENDPOINT',
  'UNKNOWN'
]);

const ADOPTION_STATUSES = freezeEnum([
  'ADOPTED',
  'PARTIALLY_ADOPTED',
  'NOT_ADOPTED',
  'NOT_APPLICABLE',
  'UNKNOWN'
]);

const PROVIDER_KINDS = freezeEnum([
  'NONE',
  'REAL',
  'MOCK',
  'FAKE',
  'REPLAY',
  'UNKNOWN'
]);

const LOCAL_SAFETY_STATUSES = freezeEnum([
  'SAFE_LOCAL',
  'NEEDS_AI',
  'NEEDS_USER_CONFIRM',
  'NO_RECORD',
  'UNKNOWN'
]);

const FORMAL_SAVE_STATUSES = freezeEnum([
  'ALLOWED',
  'BLOCKED',
  'UNKNOWN'
]);

const TRACE_STAGE_STATUSES = freezeEnum([
  'NOT_STARTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED'
]);

const RECORD_FLOW_ERROR_CODES = freezeEnum([
  'INPUT_INVALID',
  'MODE_INVALID',
  'UNSUPPORTED_FLOW_MODE',
  'AI_ADAPTER_REQUIRED',
  'AI_ADAPTER_FORBIDDEN',
  'AI_ADAPTER_IDENTITY_INVALID',
  'AI_ADAPTER_CAPABILITY_MISSING',
  'AI_CALLED_IN_LOCAL_ONLY',
  'AI_ONLY_LOCAL_DRAFT_LEAK',
  'AI_ONLY_LOCAL_RESULT_LEAK',
  'REPLAY_METADATA_INVALID',
  'MODE_RESULT_SCOPE_MISMATCH',
  'AI_TIMEOUT',
  'AI_PROVIDER_FAILED',
  'AI_ENDPOINT_MISSING',
  'AI_NETWORK_ERROR',
  'AUTH_REQUIRED',
  'AUTH_FORBIDDEN',
  'RATE_LIMITED',
  'MOCK_NOT_TRUSTED',
  'ROUTE_CONTRACT_VIOLATION',
  'SAFETY_BLOCKED',
  // Phase 1A internal stage failures retained until later contract layers exist.
  'LOCAL_PARSE_FAILED',
  'ROUTE_FAILED',
  'AI_CALL_FAILED',
  'AI_RESPONSE_INVALID',
  'AI_RESPONSE_EMPTY_BUSINESS',
  'MERGE_FAILED',
  'FINAL_SAFETY_FAILED',
  'INVALID_BUSINESS_DATE',
  'UNSUPPORTED_BUSINESS_TIMEZONE',
  'INVALID_NOW_INSTANT',
  'BUSINESS_DATE_MISMATCH',
  'CLOCK_INVALID_RESULT',
  'CLOCK_MOVED_BACKWARD',
  'ID_GENERATOR_INVALID_RESULT'
]);

const RECORD_FLOW_ERROR_CODE_ALIASES = Object.freeze({
  ai_adapter_missing: 'AI_ADAPTER_REQUIRED',
  ai_adapter_required: 'AI_ADAPTER_REQUIRED',
  ai_endpoint_missing: 'AI_ENDPOINT_MISSING',
  ai_total_timeout: 'AI_TIMEOUT',
  ai_fast_timeout: 'AI_TIMEOUT',
  ai_deep_timeout: 'AI_TIMEOUT',
  ai_provider_timeout: 'AI_TIMEOUT',
  ai_standard_timeout: 'AI_TIMEOUT',
  ai_timeout: 'AI_TIMEOUT',
  network_error: 'AI_NETWORK_ERROR',
  network_request_failed: 'AI_NETWORK_ERROR',
  ai_network_error: 'AI_NETWORK_ERROR',
  ai_provider_unavailable: 'AI_PROVIDER_FAILED',
  ai_provider_failed: 'AI_PROVIDER_FAILED',
  ai_call_failed: 'AI_PROVIDER_FAILED',
  auth_required: 'AUTH_REQUIRED',
  auth_session_expired: 'AUTH_REQUIRED',
  auth_session_not_ready: 'AUTH_REQUIRED',
  auth_forbidden: 'AUTH_FORBIDDEN',
  rate_limited: 'RATE_LIMITED',
  ai_response_invalid: 'AI_RESPONSE_INVALID',
  ai_response_empty_business: 'AI_RESPONSE_EMPTY_BUSINESS'
});

function normalizeEnum(value, enumObject, aliases = {}, unknownValue = 'UNKNOWN') {
  if (value === undefined || value === null || value === '') return enumObject[unknownValue] || unknownValue;
  const raw = String(value).trim();
  if (Object.prototype.hasOwnProperty.call(enumObject, raw)) return enumObject[raw];
  const upper = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(enumObject, upper)) return enumObject[upper];
  const alias = aliases[raw.toLowerCase()];
  return alias && Object.prototype.hasOwnProperty.call(enumObject, alias)
    ? enumObject[alias]
    : (enumObject[unknownValue] || unknownValue);
}

function normalizeFlowMode(value) {
  return normalizeEnum(value, FLOW_MODES);
}

function normalizeProductionRoute(value) {
  return normalizeEnum(value, PRODUCTION_ROUTES, {
    local: 'LOCAL',
    pending: 'PENDING',
    ai_standard: 'AI_STANDARD',
    ai_deep: 'AI_DEEP'
  });
}

function normalizeExecutionPath(value) {
  return normalizeEnum(value, EXECUTION_PATHS, {
    local_only: 'LOCAL_ONLY',
    ai_only_standard: 'AI_ONLY_STANDARD',
    ai_only_deep: 'AI_ONLY_DEEP',
    production_local: 'PRODUCTION_LOCAL',
    production_pending: 'PRODUCTION_PENDING',
    production_standard: 'PRODUCTION_STANDARD',
    production_deep: 'PRODUCTION_DEEP',
    local: 'PRODUCTION_LOCAL',
    pending: 'PRODUCTION_PENDING',
    ai_standard: 'PRODUCTION_STANDARD',
    ai_deep: 'PRODUCTION_DEEP',
    not_executed: 'NOT_EXECUTED'
  });
}

function normalizeResultScope(value) {
  return normalizeEnum(value, RESULT_SCOPES, {
    local_only_result: 'LOCAL_ONLY_RESULT',
    ai_only_result: 'AI_ONLY_RESULT',
    production_result: 'PRODUCTION_RESULT',
    not_available: 'NOT_AVAILABLE'
  });
}

function normalizeAiRequestStatus(value) {
  return normalizeEnum(value, AI_REQUEST_STATUSES, {
    not_requested: 'NOT_REQUESTED',
    decided: 'DECIDED',
    requested: 'REQUESTING',
    requesting: 'REQUESTING',
    succeeded: 'SUCCEEDED',
    failed: 'FAILED',
    timed_out: 'TIMED_OUT',
    skipped: 'SKIPPED',
    skipped_no_endpoint: 'SKIPPED'
  });
}

function normalizeAiOutcome(value) {
  const aliases = {
    not_requested: 'NOT_REQUESTED',
    used: 'USED',
    returned_uncertain: 'RETURNED_UNCERTAIN',
    failed: 'FAILED',
    timed_out: 'TIMED_OUT',
    mock_used: 'MOCK_USED',
    invalid_response: 'INVALID_RESPONSE',
    ai_response_invalid: 'INVALID_RESPONSE',
    empty_business_result: 'EMPTY_BUSINESS_RESULT',
    ai_response_empty_business: 'EMPTY_BUSINESS_RESULT',
    skipped_no_endpoint: 'SKIPPED_NO_ENDPOINT'
  };
  return normalizeEnum(value, AI_OUTCOMES, aliases);
}

function normalizeAdoptionStatus(value) {
  return normalizeEnum(value, ADOPTION_STATUSES, {
    adopted: 'ADOPTED',
    partially_adopted: 'PARTIALLY_ADOPTED',
    not_adopted: 'NOT_ADOPTED',
    not_applicable: 'NOT_APPLICABLE'
  });
}

// Provider identity is trusted only when it comes from an adapter descriptor.
// Values such as "server", model names, or response success flags are deliberately unknown.
function normalizeProviderKind(value) {
  return normalizeEnum(value, PROVIDER_KINDS, {
    none: 'NONE',
    real: 'REAL',
    mock: 'MOCK',
    fake: 'FAKE',
    replay: 'REPLAY'
  });
}

function normalizeSafetyStatus(value) {
  return normalizeEnum(value, LOCAL_SAFETY_STATUSES, {
    safe_local: 'SAFE_LOCAL',
    needs_ai: 'NEEDS_AI',
    needs_user_confirm: 'NEEDS_USER_CONFIRM',
    no_record: 'NO_RECORD'
  });
}

function normalizeRecordFlowErrorCode(value) {
  if (value === undefined || value === null || value === '') return '';
  const raw = String(value).trim();
  const alias = RECORD_FLOW_ERROR_CODE_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (Object.prototype.hasOwnProperty.call(RECORD_FLOW_ERROR_CODES, raw)) return raw;
  const upper = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(RECORD_FLOW_ERROR_CODES, upper)) return upper;
  return RECORD_FLOW_ERROR_CODES.AI_PROVIDER_FAILED;
}

function normalizeWithRaw(value, normalizer) {
  return {
    rawValue: value === undefined ? null : value,
    normalizedValue: normalizer(value)
  };
}

module.exports = {
  ADOPTION_STATUSES,
  AI_OUTCOMES,
  AI_REQUEST_STATUSES,
  CORE_CONTRACT_VERSION,
  CORE_IMPLEMENTATION_VERSION,
  EXECUTION_PATHS,
  FLOW_MODES,
  FORMAL_SAVE_STATUSES,
  LOCAL_SAFETY_STATUSES,
  PRODUCTION_ROUTES,
  PROVIDER_KINDS,
  RECORD_FLOW_ERROR_CODES,
  RESULT_SCOPES,
  TRACE_SCHEMA_VERSION,
  TARGET_TRACE_SCHEMA_VERSION,
  TRACE_STAGE_STATUSES,
  normalizeAdoptionStatus,
  normalizeAiOutcome,
  normalizeAiRequestStatus,
  normalizeExecutionPath,
  normalizeFlowMode,
  normalizeProductionRoute,
  normalizeProviderKind,
  normalizeResultScope,
  normalizeRecordFlowErrorCode,
  normalizeSafetyStatus,
  normalizeWithRaw
};
