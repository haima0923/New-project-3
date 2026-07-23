const {
  RECORD_STORAGE_LEGACY_SAVE_STATUSES,
  RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS,
  RECORD_STORAGE_RELEASE_A_MONITOR_POLICY,
  RECORD_STORAGE_RELEASE_A_MONITOR_SCHEMA_VERSION,
  normalizeLegacyWriterSource
} = require('./record-storage-release-contract');
const {
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_ERRORS,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('./record-storage-transaction-contract');
const { safeClone } = require('./record-state-diff');

const ALLOWED_MONITOR_STATUSES = new Set([
  ...Object.values(RECORD_STORAGE_LEGACY_SAVE_STATUSES),
  ...Object.values(RECORD_STORAGE_RECOVERY_STATES),
  ...Object.values(RECORD_STORAGE_TRANSACTION_STATES),
  'TRANSACTIONAL_LEGACY',
  'SYNCHRONOUS_CRITICAL_SECTION',
  'UNKNOWN'
]);
const ALLOWED_MONITOR_ERROR_CODES = new Set([
  ...Object.values(RECORD_STORAGE_TRANSACTION_ERRORS),
  'UNCLASSIFIED_TECHNICAL_ERROR'
]);

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sanitizeEnum(value, allowedValues, fallback) {
  const normalized = String(value || '').trim().toUpperCase();
  return allowedValues.has(normalized) ? normalized : fallback;
}

function sanitizeReleaseAMonitorPayload(payload = {}) {
  return {
    writerSource: normalizeLegacyWriterSource(payload.writerSource) || 'RELEASE_A_TEST',
    status: sanitizeEnum(payload.status, ALLOWED_MONITOR_STATUSES, 'UNKNOWN'),
    errorCode: payload.errorCode
      ? sanitizeEnum(
        payload.errorCode,
        ALLOWED_MONITOR_ERROR_CODES,
        'UNCLASSIFIED_TECHNICAL_ERROR'
      )
      : '',
    revision: finiteNonNegative(payload.revision),
    queueDelayMs: finiteNonNegative(payload.queueDelayMs)
  };
}

function createRecordStorageReleaseAMonitor(options = {}) {
  const clock = options.clock && typeof options.clock.now === 'function'
    ? options.clock
    : { now: () => new Date() };
  const requestedMax = Number(options.maxEvents);
  const maxEvents = Number.isInteger(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, 512)
    : RECORD_STORAGE_RELEASE_A_MONITOR_POLICY.maxEvents;
  let sequence = 0;
  let events = [];

  return Object.freeze({
    record(type, payload = {}) {
      const normalizedType = RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS[
        String(type || '').trim().toUpperCase()
      ];
      if (!normalizedType) return null;
      sequence += 1;
      const now = clock.now();
      const occurredAt = now instanceof Date && !Number.isNaN(now.getTime())
        ? now.toISOString()
        : '';
      const event = Object.assign({
        schemaVersion: RECORD_STORAGE_RELEASE_A_MONITOR_SCHEMA_VERSION,
        sequence,
        type: normalizedType,
        occurredAt
      }, sanitizeReleaseAMonitorPayload(payload));
      events.push(event);
      if (events.length > maxEvents) events = events.slice(-maxEvents);
      return safeClone(event);
    },
    getEvents() {
      return safeClone(events);
    },
    clear() {
      events = [];
    },
    getPolicy() {
      return Object.assign({}, RECORD_STORAGE_RELEASE_A_MONITOR_POLICY, { maxEvents });
    }
  });
}

module.exports = {
  createRecordStorageReleaseAMonitor,
  sanitizeReleaseAMonitorPayload
};
