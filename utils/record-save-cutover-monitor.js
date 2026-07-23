const {
  RECORD_SAVE_CUTOVER_ERROR_CODES,
  RECORD_SAVE_CUTOVER_MONITOR_EVENTS,
  RECORD_SAVE_CUTOVER_MONITOR_POLICY,
  RECORD_SAVE_CUTOVER_MONITOR_SCHEMA_VERSION,
  RECORD_SAVE_CUTOVER_MODES,
  RECORD_SAVE_RECOVERY_LOCK_REASONS,
  RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS
} = require('./record-save-cutover-contract');
const {
  RECORD_STORAGE_TRANSACTION_ERRORS,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('./record-storage-transaction-contract');
const { safeClone, stableHash } = require('./record-state-diff');

const ALLOWED_EVENT_FIELDS = Object.freeze([
  'appVersion',
  'configVersion',
  'configVersionFingerprint',
  'executionMode',
  'businessType',
  'operation',
  'errorCode',
  'revision',
  'transactionState',
  'diffClassification',
  'latencyMs',
  'createdCount',
  'updatedCount',
  'deletedCount',
  'planHash',
  'planHashPrefix'
]);

const TECHNICAL_BUSINESS_TYPES = new Set([
  'quotation',
  'order',
  'receivable',
  'payment',
  'order_deposit',
  'todo',
  'dunning',
  'pending',
  'unknown'
]);
const TECHNICAL_OPERATIONS = new Set([
  'create_quotation',
  'update_quotation',
  'create_order',
  'update_order',
  'create_receivable',
  'create_receivable_with_payment',
  'record_payment',
  'record_order_deposit',
  'create_todo',
  'update_todo',
  'pending'
]);
const TECHNICAL_ERROR_CODES = new Set([
  ...Object.values(RECORD_SAVE_CUTOVER_ERROR_CODES),
  ...Object.values(RECORD_SAVE_CUTOVER_MONITOR_EVENTS),
  ...Object.values(RECORD_SAVE_RECOVERY_LOCK_REASONS),
  ...Object.values(RECORD_STORAGE_TRANSACTION_ERRORS),
  'CUTOVER_MONITOR_EVENT_INVALID',
  'UNCLASSIFIED_TECHNICAL_ERROR'
]);

function boundedText(value, maxLength) {
  return String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, maxLength);
}

function technicalEnum(value, values, fallback = '') {
  const normalized = String(value || '').trim();
  return values.has(normalized) ? normalized : fallback;
}

function sanitizedAppVersion(value) {
  const normalized = String(value || '').trim();
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,20})?$/.test(normalized)
    ? normalized
    : 'unknown';
}

function configVersionFingerprint(value) {
  const normalized = String(value || '').trim();
  return normalized ? stableHash(normalized, 'cfg1').slice(0, 17) : '';
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sanitizeRecordSaveCutoverPayload(payload = {}) {
  const sanitized = {};
  ALLOWED_EVENT_FIELDS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
    if (['revision', 'latencyMs', 'createdCount', 'updatedCount', 'deletedCount'].includes(key)) {
      sanitized[key] = finiteNonNegative(payload[key]);
      return;
    }
    if (key === 'diffClassification') {
      sanitized.diffClassification = RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS[
        String(payload[key] || '').trim().toUpperCase()
      ] || RECORD_SAVE_SHADOW_DIFFERENCE_LEVELS.UNKNOWN;
      return;
    }
    if (key === 'executionMode') {
      sanitized.executionMode = RECORD_SAVE_CUTOVER_MODES[
        String(payload[key] || '').trim().toUpperCase()
      ] || RECORD_SAVE_CUTOVER_MODES.LEGACY_ONLY;
      return;
    }
    if (key === 'businessType') {
      sanitized.businessType = technicalEnum(payload[key], TECHNICAL_BUSINESS_TYPES, 'unknown');
      return;
    }
    if (key === 'operation') {
      sanitized.operation = technicalEnum(payload[key], TECHNICAL_OPERATIONS, 'unknown');
      return;
    }
    if (key === 'errorCode') {
      sanitized.errorCode = technicalEnum(
        payload[key],
        TECHNICAL_ERROR_CODES,
        'UNCLASSIFIED_TECHNICAL_ERROR'
      );
      return;
    }
    if (key === 'transactionState') {
      sanitized.transactionState = RECORD_STORAGE_TRANSACTION_STATES[
        String(payload[key] || '').trim().toUpperCase()
      ] || 'UNKNOWN';
      return;
    }
    if (key === 'appVersion') {
      sanitized.appVersion = sanitizedAppVersion(payload[key]);
      return;
    }
    if (key === 'configVersion') {
      sanitized.configVersionFingerprint = configVersionFingerprint(payload[key]);
      return;
    }
    if (key === 'configVersionFingerprint') {
      const fingerprint = String(payload[key] || '').trim();
      sanitized.configVersionFingerprint = /^cfg1_[a-f0-9]{12}$/i.test(fingerprint)
        ? fingerprint.toLowerCase()
        : '';
      return;
    }
    if (key === 'planHash') {
      const hash = String(payload.planHash || '').trim();
      const matched = hash.match(/^(plan1_)?([a-f0-9]{12,})$/i);
      sanitized.planHashPrefix = matched
        ? `${matched[1] || ''}${matched[2].slice(0, RECORD_SAVE_CUTOVER_MONITOR_POLICY.planHashPrefixLength)}`
        : '';
      return;
    }
    if (key === 'planHashPrefix') {
      const prefix = String(payload[key] || '').trim();
      sanitized.planHashPrefix = /^(plan1_)?[a-f0-9]{12}$/i.test(prefix)
        ? prefix.toLowerCase()
        : '';
      return;
    }
    sanitized[key] = boundedText(payload[key], RECORD_SAVE_CUTOVER_MONITOR_POLICY.maxVersionLength);
  });
  return sanitized;
}

function sanitizeRecordSaveCutoverEvent(type, payload = {}, options = {}) {
  const normalizedType = RECORD_SAVE_CUTOVER_MONITOR_EVENTS[String(type || '').trim().toUpperCase()];
  if (!normalizedType) {
    const error = new Error('共享保存切换监测事件类型无效。');
    error.code = 'CUTOVER_MONITOR_EVENT_INVALID';
    throw error;
  }
  const event = Object.assign({
    schemaVersion: RECORD_SAVE_CUTOVER_MONITOR_SCHEMA_VERSION,
    sequence: Number.isInteger(options.sequence) && options.sequence > 0 ? options.sequence : 1,
    type: normalizedType,
    occurredAt: String(options.occurredAt || '')
  }, sanitizeRecordSaveCutoverPayload(payload));
  return event;
}

function createRecordSaveCutoverMonitor(options = {}) {
  const requestedMax = Number(options.maxEvents);
  const maxEvents = Number.isInteger(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, 512)
    : RECORD_SAVE_CUTOVER_MONITOR_POLICY.maxEvents;
  const clock = options.clock && typeof options.clock.now === 'function'
    ? options.clock
    : { now: () => new Date() };
  let sequence = 0;
  let events = [];

  return Object.freeze({
    record(type, payload = {}) {
      sequence += 1;
      const now = clock.now();
      const occurredAt = now instanceof Date && !Number.isNaN(now.getTime())
        ? now.toISOString()
        : '';
      const event = sanitizeRecordSaveCutoverEvent(type, payload, { sequence, occurredAt });
      events.push(event);
      if (events.length > maxEvents) events = events.slice(events.length - maxEvents);
      return safeClone(event);
    },
    getEvents() {
      return safeClone(events);
    },
    clear() {
      events = [];
    },
    getPolicy() {
      return {
        schemaVersion: RECORD_SAVE_CUTOVER_MONITOR_SCHEMA_VERSION,
        maxEvents,
        remoteUploadEnabled: false,
        storagePersistenceEnabled: false,
        allowedFields: ALLOWED_EVENT_FIELDS.slice()
      };
    }
  });
}

module.exports = {
  ALLOWED_EVENT_FIELDS,
  createRecordSaveCutoverMonitor,
  sanitizeRecordSaveCutoverEvent,
  sanitizeRecordSaveCutoverPayload
};
