const { STORAGE_TARGET_KINDS } = require('./record-storage-adapter-contract');
const { safeClone } = require('./record-state-diff');

const TRUSTED_GATEWAYS = new WeakMap();

function gatewayError(message) {
  const error = new Error(message);
  error.code = 'STORAGE_GATEWAY_INVALID';
  return error;
}

function validateGatewayShape(gateway) {
  if (!gateway || typeof gateway !== 'object'
    || typeof gateway.getStorageSync !== 'function'
    || typeof gateway.setStorageSync !== 'function'
    || typeof gateway.removeStorageSync !== 'function') {
    throw gatewayError('Storage gateway合同不完整。');
  }
}

function registerGateway(gateway, descriptor) {
  validateGatewayShape(gateway);
  TRUSTED_GATEWAYS.set(gateway, Object.freeze(Object.assign({}, descriptor)));
  return Object.freeze(gateway);
}

function getTrustedGatewayIdentity(gateway) {
  const descriptor = TRUSTED_GATEWAYS.get(gateway);
  return descriptor ? safeClone(descriptor) : null;
}

function createWxStorageGateway() {
  if (arguments.length > 0) {
    throw gatewayError('微信Storage gateway只能在平台组合根绑定真实wx。');
  }
  const wxApi = typeof globalThis !== 'undefined' ? globalThis.wx : null;
  validateGatewayShape(wxApi);
  const gateway = {
    getStorageSync(key) { return wxApi.getStorageSync(key); },
    setStorageSync(key, value) { return wxApi.setStorageSync(key, value); },
    removeStorageSync(key) { return wxApi.removeStorageSync(key); },
    listStorageKeysSync() {
      if (typeof wxApi.getStorageInfoSync !== 'function') return null;
      const result = wxApi.getStorageInfoSync();
      return result && Array.isArray(result.keys) ? result.keys.slice() : null;
    },
    hasStorageKeySync(key) {
      if (typeof wxApi.getStorageInfoSync !== 'function') return null;
      const result = wxApi.getStorageInfoSync();
      return Boolean(result && Array.isArray(result.keys) && result.keys.includes(String(key)));
    },
    getCapacityInfo() {
      if (typeof wxApi.getStorageInfoSync !== 'function') {
        return { capacityConfirmed: false };
      }
      const result = wxApi.getStorageInfoSync() || {};
      const currentSizeKb = Number(result.currentSize);
      const limitSizeKb = Number(result.limitSize);
      return {
        capacityConfirmed: Number.isFinite(currentSizeKb) && Number.isFinite(limitSizeKb),
        currentSizeBytes: Number.isFinite(currentSizeKb) ? currentSizeKb * 1024 : null,
        limitSizeBytes: Number.isFinite(limitSizeKb) ? limitSizeKb * 1024 : null,
        sourceUnit: 'WX_KILOBYTES'
      };
    }
  };
  return registerGateway(gateway, {
    gatewayKind: STORAGE_TARGET_KINDS.WX_LEGACY,
    canTouchRealStorage: true,
    source: 'WX_API'
  });
}

function normalizeFailureInjection(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    phase: String(value.phase || ''),
    key: String(value.key || ''),
    code: String(value.code || 'FAKE_STORAGE_INJECTED_FAILURE')
  };
}

function utf8ByteLength(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') return 0;
  let bytes = 0;
  for (const symbol of text) {
    const code = symbol.codePointAt(0);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function normalizeFailureSchedule(value) {
  return (Array.isArray(value) ? value : []).map((entry, index) => ({
    id: String(entry && entry.id || `fault-${index + 1}`),
    operation: String(entry && entry.operation || '').toUpperCase(),
    key: String(entry && entry.key || ''),
    occurrence: Math.max(1, Number(entry && entry.occurrence) || 1),
    effect: String(entry && entry.effect || 'THROW_BEFORE').toUpperCase(),
    code: String(entry && entry.code || 'FAKE_STORAGE_INJECTED_FAILURE'),
    once: entry && entry.once !== false,
    used: false
  }));
}

function createFakeStorageGateway(initialEntries = {}, options = {}) {
  let entries = safeClone(initialEntries || {});
  let failure = normalizeFailureInjection(options.failureInjection);
  let failureSchedule = normalizeFailureSchedule(options.failureSchedule);
  let capacityBytes = Number.isFinite(Number(options.capacityBytes))
    ? Math.max(0, Number(options.capacityBytes))
    : 50 * 1024 * 1024;
  let capacityConfirmed = options.capacityConfirmed !== false;
  const absentValue = Object.prototype.hasOwnProperty.call(options, 'absentValue')
    ? safeClone(options.absentValue)
    : undefined;
  const events = [];
  let reads = 0;
  let writes = 0;
  let removals = 0;
  const operationCounts = new Map();

  function maybeFail(phase, key) {
    if (!failure || failure.phase !== phase) return;
    if (failure.key && failure.key !== String(key || '')) return;
    const error = new Error(failure.code);
    error.code = failure.code;
    throw error;
  }

  function nextScheduledFault(operation, key) {
    const counterKey = `${operation}:${String(key)}`;
    const count = (operationCounts.get(counterKey) || 0) + 1;
    operationCounts.set(counterKey, count);
    return failureSchedule.find((item) => (
      (!item.used || !item.once)
      && item.operation === operation
      && (!item.key || item.key === String(key))
      && item.occurrence === count
    )) || null;
  }

  function markFaultUsed(fault) {
    if (fault && fault.once) fault.used = true;
  }

  function throwFault(fault) {
    markFaultUsed(fault);
    const error = new Error(fault.code);
    error.code = fault.code;
    throw error;
  }

  function corruptValue(value, truncate) {
    const text = JSON.stringify(value);
    return truncate
      ? String(text || '').slice(0, Math.max(1, Math.floor(String(text || '').length / 2)))
      : '{corrupt-json';
  }

  function currentUsageBytes(nextEntries = entries) {
    return Object.keys(nextEntries).reduce((sum, key) => (
      sum + utf8ByteLength(String(key)) + utf8ByteLength(nextEntries[key])
    ), 0);
  }

  const gateway = {
    getStorageSync(key) {
      maybeFail('BEFORE_GET', key);
      reads += 1;
      events.push({ type: 'GET', key: String(key) });
      const fault = nextScheduledFault('GET', key);
      if (fault && fault.effect === 'THROW_BEFORE') throwFault(fault);
      const value = Object.prototype.hasOwnProperty.call(entries, key)
        ? safeClone(entries[key])
        : safeClone(absentValue);
      if (fault && fault.effect === 'RETURN_CORRUPT') {
        markFaultUsed(fault);
        return '{corrupt-read';
      }
      if (fault && fault.effect === 'RETURN_UNDEFINED') {
        markFaultUsed(fault);
        return undefined;
      }
      if (fault && fault.effect === 'THROW_AFTER') throwFault(fault);
      maybeFail('AFTER_GET', key);
      return value;
    },
    setStorageSync(key, value) {
      maybeFail('BEFORE_SET', key);
      writes += 1;
      events.push({ type: 'SET', key: String(key) });
      const fault = nextScheduledFault('SET', key);
      if (fault && ['THROW_BEFORE', 'QUOTA_REJECT'].includes(fault.effect)) throwFault(fault);
      const candidate = Object.assign({}, entries, { [key]: safeClone(value) });
      if (capacityConfirmed && currentUsageBytes(candidate) > capacityBytes) {
        const error = new Error('FAKE_STORAGE_CAPACITY_EXCEEDED');
        error.code = 'FAKE_STORAGE_CAPACITY_EXCEEDED';
        throw error;
      }
      const legacyNoop = failure && failure.phase === 'SILENT_NOOP'
        && (!failure.key || failure.key === String(key));
      const scheduledNoop = fault && fault.effect === 'SILENT_NOOP';
      if (!legacyNoop && !scheduledNoop) {
        if (fault && fault.effect === 'CORRUPT_VALUE') entries[key] = corruptValue(value, false);
        else if (fault && fault.effect === 'TRUNCATE_VALUE') entries[key] = corruptValue(value, true);
        else entries[key] = safeClone(value);
      }
      if (fault && ['SILENT_NOOP', 'CORRUPT_VALUE', 'TRUNCATE_VALUE'].includes(fault.effect)) markFaultUsed(fault);
      if (fault && fault.effect === 'APPLY_THEN_THROW') throwFault(fault);
      maybeFail('AFTER_SET', key);
      return undefined;
    },
    removeStorageSync(key) {
      maybeFail('BEFORE_REMOVE', key);
      removals += 1;
      events.push({ type: 'REMOVE', key: String(key) });
      const fault = nextScheduledFault('REMOVE', key);
      if (fault && fault.effect === 'THROW_BEFORE') throwFault(fault);
      if (!fault || fault.effect !== 'SILENT_NOOP') delete entries[key];
      if (fault && fault.effect === 'SILENT_NOOP') markFaultUsed(fault);
      if (fault && fault.effect === 'APPLY_THEN_THROW') throwFault(fault);
      maybeFail('AFTER_REMOVE', key);
      return undefined;
    },
    listStorageKeysSync() { return Object.keys(entries).sort(); },
    hasStorageKeySync(key) { return Object.prototype.hasOwnProperty.call(entries, String(key)); },
    getStats() { return { reads, writes, removals, events: safeClone(events) }; },
    getEntries() { return safeClone(entries); },
    getStorageInfoSync() {
      return {
        keys: Object.keys(entries).sort(),
        currentSizeBytes: currentUsageBytes(),
        limitSizeBytes: capacityBytes,
        capacityConfirmed
      };
    },
    getCapacityInfo() { return this.getStorageInfoSync(); },
    replaceEntriesForRestart(value) { entries = safeClone(value || {}); },
    setCapacity(value, confirmed = true) {
      capacityBytes = Math.max(0, Number(value) || 0);
      capacityConfirmed = confirmed === true;
    },
    setFailureSchedule(value) {
      failureSchedule = normalizeFailureSchedule(value);
      operationCounts.clear();
    },
    clearFailureSchedule() {
      failureSchedule = [];
      operationCounts.clear();
    },
    mutateEntry(key, value) { entries[String(key)] = safeClone(value); },
    setFailureInjection(value) { failure = normalizeFailureInjection(value); },
    clearFailureInjection() { failure = null; }
  };
  return registerGateway(gateway, {
    gatewayKind: STORAGE_TARGET_KINDS.FAKE,
    canTouchRealStorage: false,
    source: 'IN_MEMORY_FAKE'
  });
}

module.exports = {
  createFakeStorageGateway,
  createWxStorageGateway,
  getTrustedGatewayIdentity,
  utf8ByteLength
};
