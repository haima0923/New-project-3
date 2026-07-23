const { STORAGE_TARGET_KINDS } = require('./record-storage-adapter-contract');
const {
  gatewayError,
  registerTrustedGateway,
  validateGatewayShape
} = require('./record-storage-gateway-registry');
const {
  RECORD_STORAGE_RUNTIME_TEST_KEYS,
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST,
  readWechatRuntimeEnvironment
} = require('./record-storage-runtime-test-contract');
const { safeClone, stableHash } = require('./record-state-diff');

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

function createWxRuntimeTestStorageGateway(options = {}) {
  const wxApi = typeof globalThis !== 'undefined' ? globalThis.wx : null;
  validateGatewayShape(wxApi);
  const environment = readWechatRuntimeEnvironment(wxApi);
  if (!environment.isDevtoolsDevelop) {
    const error = gatewayError('隔离微信Storage测试只能在开发者工具develop环境创建。');
    error.code = 'WX_RUNTIME_TEST_ENVIRONMENT_FORBIDDEN';
    throw error;
  }
  if (typeof wxApi.getStorageInfoSync !== 'function') {
    const error = gatewayError('隔离微信Storage测试需要getStorageInfoSync。');
    error.code = 'WX_RUNTIME_TEST_STORAGE_INFO_UNAVAILABLE';
    throw error;
  }
  const allowedKeys = new Set(RECORD_STORAGE_RUNTIME_TEST_KEY_LIST);
  const trace = [];
  let sequence = 0;
  const capacityHeadroomBytes = Number.isFinite(Number(options.capacityHeadroomBytes))
    ? Math.max(0, Number(options.capacityHeadroomBytes))
    : null;

  function record(operation, key, details = {}) {
    sequence += 1;
    trace.push({
      sequence,
      operation: String(operation || ''),
      key: String(key || ''),
      success: details.success !== false,
      sizeBytes: Number.isFinite(Number(details.sizeBytes)) ? Number(details.sizeBytes) : null,
      revision: Number.isInteger(details.revision) ? details.revision : null,
      fingerprint: String(details.fingerprint || ''),
      errorCode: String(details.errorCode || '')
    });
  }

  function assertAllowedKey(operation, key) {
    const normalized = String(key || '');
    if (!allowedKeys.has(normalized)) {
      record(`DENIED_${operation}`, normalized, {
        success: false,
        errorCode: 'RUNTIME_TEST_STORAGE_KEY_FORBIDDEN'
      });
      const error = gatewayError('隔离微信Storage Gateway拒绝非白名单key。');
      error.code = 'RUNTIME_TEST_STORAGE_KEY_FORBIDDEN';
      throw error;
    }
    return normalized;
  }

  function summarizeStoredValue(value) {
    if (value === undefined || value === null || value === '') {
      return { revision: null, fingerprint: '' };
    }
    let revision = null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const control = value.__hxlRecordStorageV1;
      const candidate = control && control.storageRevision !== undefined
        ? control.storageRevision
        : (value.targetRevision !== undefined ? value.targetRevision : value.baseRevision);
      if (Number.isInteger(Number(candidate))) revision = Number(candidate);
    }
    return {
      revision,
      fingerprint: stableHash(value, 'wx-runtime-storage-entry-v1')
    };
  }

  function storageInfo() {
    try {
      const raw = wxApi.getStorageInfoSync() || {};
      const currentSizeKb = Number(raw.currentSize);
      const limitSizeKb = Number(raw.limitSize);
      record('INFO', '', {
        sizeBytes: Number.isFinite(currentSizeKb) ? currentSizeKb * 1024 : null
      });
      return {
        capacityConfirmed: Number.isFinite(currentSizeKb) && Number.isFinite(limitSizeKb),
        currentSizeBytes: Number.isFinite(currentSizeKb) ? currentSizeKb * 1024 : null,
        limitSizeBytes: Number.isFinite(limitSizeKb) ? limitSizeKb * 1024 : null,
        isolatedKeysPresent: Array.isArray(raw.keys)
          ? raw.keys.filter((key) => allowedKeys.has(String(key))).map(String).sort()
          : [],
        sourceUnit: 'WX_KILOBYTES'
      };
    } catch (error) {
      record('INFO', '', { success: false, errorCode: error && error.code });
      throw error;
    }
  }

  const gateway = {
    getStorageSync(key) {
      const normalized = assertAllowedKey('GET', key);
      try {
        const value = wxApi.getStorageSync(normalized);
        record('GET', normalized, Object.assign(
          { sizeBytes: utf8ByteLength(value) },
          summarizeStoredValue(value)
        ));
        return value;
      } catch (error) {
        record('GET', normalized, { success: false, errorCode: error && error.code });
        throw error;
      }
    },
    setStorageSync(key, value) {
      const normalized = assertAllowedKey('SET', key);
      try {
        const result = wxApi.setStorageSync(normalized, value);
        record('SET', normalized, Object.assign(
          { sizeBytes: utf8ByteLength(value) },
          summarizeStoredValue(value)
        ));
        return result;
      } catch (error) {
        record('SET', normalized, {
          success: false,
          sizeBytes: utf8ByteLength(value),
          errorCode: error && error.code
        });
        throw error;
      }
    },
    removeStorageSync(key) {
      const normalized = assertAllowedKey('REMOVE', key);
      try {
        const result = wxApi.removeStorageSync(normalized);
        record('REMOVE', normalized);
        return result;
      } catch (error) {
        record('REMOVE', normalized, { success: false, errorCode: error && error.code });
        throw error;
      }
    },
    listStorageKeysSync() {
      return storageInfo().isolatedKeysPresent;
    },
    hasStorageKeySync(key) {
      const normalized = assertAllowedKey('GET', key);
      return storageInfo().isolatedKeysPresent.includes(normalized);
    },
    getCapacityInfo() {
      const info = storageInfo();
      if (capacityHeadroomBytes !== null && info.capacityConfirmed) {
        info.limitSizeBytes = Math.min(
          info.limitSizeBytes,
          info.currentSizeBytes + capacityHeadroomBytes
        );
        info.capacitySource = 'WX_WITH_TEST_HEADROOM_LIMIT';
      } else {
        info.capacitySource = 'WX_REPORTED';
      }
      delete info.isolatedKeysPresent;
      return info;
    },
    estimateEntryBytes(key, value) {
      const normalized = assertAllowedKey('SET', key);
      return utf8ByteLength(normalized) + utf8ByteLength(value);
    },
    getRuntimeTrace() {
      return safeClone(trace);
    },
    resetRuntimeTrace() {
      trace.splice(0, trace.length);
      sequence = 0;
    }
  };

  return registerTrustedGateway(gateway, {
    gatewayKind: STORAGE_TARGET_KINDS.WX_ISOLATED_TEST,
    canTouchRealStorage: true,
    runtimeTestOnly: true,
    source: 'WX_DEVTOOLS_ISOLATED_TEST',
    transactionStorageKeys: {
      primary: RECORD_STORAGE_RUNTIME_TEST_KEYS.primary,
      journal: RECORD_STORAGE_RUNTIME_TEST_KEYS.journal,
      backup: RECORD_STORAGE_RUNTIME_TEST_KEYS.backup
    },
    allowedStorageKeys: RECORD_STORAGE_RUNTIME_TEST_KEY_LIST
  });
}

module.exports = {
  createWxRuntimeTestStorageGateway
};
