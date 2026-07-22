const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Shanghai';
const SUPPORTED_BUSINESS_TIMEZONES = Object.freeze([DEFAULT_BUSINESS_TIMEZONE]);
const RUNTIME_SOURCES = Object.freeze({
  SYSTEM: 'SYSTEM',
  INJECTED: 'INJECTED',
  FIXED_TEST: 'FIXED_TEST'
});

const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_INSTANT_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/i;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function createRuntimeError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.keys(details).forEach((key) => {
    error[key] = details[key];
  });
  return error;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function isValidBusinessDate(value) {
  const match = String(value || '').match(BUSINESS_DATE_PATTERN);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizeBusinessDate(value) {
  const normalized = String(value || '').trim();
  if (!isValidBusinessDate(normalized)) {
    throw createRuntimeError('INVALID_BUSINESS_DATE', 'businessDate 必须是有效的 YYYY-MM-DD 日期。');
  }
  return normalized;
}

function normalizeBusinessTimezone(value) {
  const normalized = value === undefined || value === null || value === ''
    ? DEFAULT_BUSINESS_TIMEZONE
    : String(value).trim();
  if (!SUPPORTED_BUSINESS_TIMEZONES.includes(normalized)) {
    throw createRuntimeError(
      'UNSUPPORTED_BUSINESS_TIMEZONE',
      `Phase 1B 只支持 ${DEFAULT_BUSINESS_TIMEZONE}。`,
      { businessTimezone: normalized }
    );
  }
  return normalized;
}

function normalizeNowInstant(value) {
  let date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else {
    const source = String(value || '').trim();
    if (!source || !OFFSET_INSTANT_PATTERN.test(source)) {
      throw createRuntimeError('INVALID_NOW_INSTANT', 'nowInstant 必须是带 Z 或明确时区偏移的 ISO-8601 时刻。');
    }
    date = new Date(source);
  }
  if (!Number.isFinite(date.getTime())) {
    throw createRuntimeError('INVALID_NOW_INSTANT', 'nowInstant 不是有效时刻。');
  }
  return date.toISOString();
}

function businessDateFromInstant(nowInstant, businessTimezone = DEFAULT_BUSINESS_TIMEZONE) {
  normalizeBusinessTimezone(businessTimezone);
  const instant = normalizeNowInstant(nowInstant);
  const shanghai = new Date(Date.parse(instant) + SHANGHAI_OFFSET_MS);
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())}`;
}

const systemClock = Object.freeze({
  source: RUNTIME_SOURCES.SYSTEM,
  now() {
    return new Date();
  }
});

function getRuntimeSource(dependency, systemDependency) {
  if (!dependency || dependency === systemDependency) return RUNTIME_SOURCES.SYSTEM;
  return dependency.source === RUNTIME_SOURCES.FIXED_TEST
    ? RUNTIME_SOURCES.FIXED_TEST
    : RUNTIME_SOURCES.INJECTED;
}

function readClockSample(clock = systemClock) {
  let raw;
  if (typeof clock === 'function') raw = clock();
  else if (clock && typeof clock.now === 'function') raw = clock.now();
  else {
    throw createRuntimeError('CLOCK_INVALID_RESULT', 'clock 必须提供 now()。');
  }
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw createRuntimeError('CLOCK_INVALID_RESULT', 'clock.now() 没有返回有效时刻。');
  }
  return {
    milliseconds: date.getTime(),
    instant: date.toISOString()
  };
}

function normalizeId(value, scope) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) {
    throw createRuntimeError('ID_GENERATOR_INVALID_RESULT', `idGenerator 没有为 ${scope} 返回有效 ID。`, { scope });
  }
  return normalized;
}

function createSystemIdGenerator(seedMilliseconds) {
  let sequence = 0;
  const seed = Number.isFinite(seedMilliseconds) ? seedMilliseconds : new Date().getTime();
  const entropy = Math.random().toString(36).slice(2, 10);
  return {
    source: RUNTIME_SOURCES.SYSTEM,
    next(scope) {
      sequence += 1;
      const safeScope = String(scope || 'id').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      return `${safeScope}-${seed}-${sequence}-${entropy}`;
    }
  };
}

function callIdGenerator(idGenerator, scope) {
  if (typeof idGenerator === 'function') return idGenerator(scope);
  if (idGenerator && typeof idGenerator.next === 'function') return idGenerator.next(scope);
  throw createRuntimeError('ID_GENERATOR_INVALID_RESULT', 'idGenerator 必须提供 next(scope)。', { scope });
}

function createIdRuntime(input, dependency, seedMilliseconds) {
  const idGenerator = dependency || createSystemIdGenerator(seedMilliseconds);
  const source = getRuntimeSource(dependency, null);
  const used = new Set();

  function reserve(value, scope) {
    const id = normalizeId(value, scope);
    if (used.has(id)) {
      throw createRuntimeError('ID_GENERATOR_INVALID_RESULT', `idGenerator 为 ${scope} 返回了本次运行内的重复 ID。`, {
        scope,
        duplicateId: id
      });
    }
    used.add(id);
    return id;
  }

  function next(scope) {
    return reserve(callIdGenerator(idGenerator, scope), scope);
  }

  return {
    idGenerator,
    source,
    runId: Object.prototype.hasOwnProperty.call(input, 'runId')
      ? reserve(input.runId, 'run')
      : next('run'),
    traceId: Object.prototype.hasOwnProperty.call(input, 'traceId')
      ? reserve(input.traceId, 'trace')
      : next('trace'),
    next
  };
}

function resolveBusinessTimeContext(input = {}, dependencies = {}) {
  const clock = dependencies.clock || systemClock;
  const clockSource = getRuntimeSource(dependencies.clock, systemClock);
  // Every run validates and samples its clock exactly once before parsing. This
  // sample is reused as trace.startedAt and, when no explicit instant exists, as
  // the immutable business nowInstant.
  const initialTimeSample = readClockSample(clock);
  const businessTimezone = normalizeBusinessTimezone(input.businessTimezone);
  const hasBusinessDate = Object.prototype.hasOwnProperty.call(input, 'businessDate');
  const hasNowInstant = Object.prototype.hasOwnProperty.call(input, 'nowInstant');
  const explicitBusinessDate = hasBusinessDate ? normalizeBusinessDate(input.businessDate) : '';
  const explicitNowInstant = hasNowInstant ? normalizeNowInstant(input.nowInstant) : '';

  let nowInstant = explicitNowInstant;
  let businessDate = explicitBusinessDate;
  let nowInstantResolved = Boolean(explicitNowInstant);
  if (!hasBusinessDate && !hasNowInstant) {
    nowInstant = initialTimeSample.instant;
    nowInstantResolved = true;
    businessDate = businessDateFromInstant(nowInstant, businessTimezone);
  } else if (!hasBusinessDate) {
    businessDate = businessDateFromInstant(nowInstant, businessTimezone);
  } else if (hasNowInstant) {
    const projectedDate = businessDateFromInstant(nowInstant, businessTimezone);
    if (projectedDate !== businessDate) {
      throw createRuntimeError(
        'BUSINESS_DATE_MISMATCH',
        'businessDate 与 nowInstant 在业务时区中的日期不一致。',
        { businessDate, projectedDate, businessTimezone }
      );
    }
  } else {
    nowInstant = null;
    nowInstantResolved = false;
  }

  return {
    businessTimezone,
    businessDate,
    nowInstant,
    nowInstantResolved,
    clock,
    clockSource,
    initialTimeSample
  };
}

function resolveRecordFlowRuntime(input = {}, dependencies = {}) {
  const time = resolveBusinessTimeContext(input, dependencies);
  const ids = createIdRuntime(input, dependencies.idGenerator, time.initialTimeSample.milliseconds);
  return {
    businessTimezone: time.businessTimezone,
    businessDate: time.businessDate,
    nowInstant: time.nowInstant,
    nowInstantResolved: time.nowInstantResolved,
    clock: time.clock,
    clockSource: time.clockSource,
    idGenerator: ids.idGenerator,
    idGeneratorSource: ids.source,
    initialTimeSample: time.initialTimeSample,
    runId: ids.runId,
    traceId: ids.traceId,
    caseId: input.caseId || '',
    nextId: ids.next
  };
}

module.exports = {
  DEFAULT_BUSINESS_TIMEZONE,
  RUNTIME_SOURCES,
  SUPPORTED_BUSINESS_TIMEZONES,
  businessDateFromInstant,
  createRuntimeError,
  createSystemIdGenerator,
  isValidBusinessDate,
  normalizeBusinessDate,
  normalizeBusinessTimezone,
  normalizeNowInstant,
  readClockSample,
  resolveBusinessTimeContext,
  resolveRecordFlowRuntime,
  systemClock
};
