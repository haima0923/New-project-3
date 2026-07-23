const REAL_BUSINESS_STORAGE_KEY = 'yiwu_boss_ai_assistant_v1';
const GUARD_ERROR_CODE = 'RUNTIME_TEST_STORAGE_KEY_FORBIDDEN';
const RECORD_STORAGE_RUNTIME_TEST_KEY_LIST = Object.freeze([
  'huoxiaoling_record_txn_runtime_test_v1',
  'huoxiaoling_record_txn_runtime_journal_v1',
  'huoxiaoling_record_txn_runtime_backup_v1',
  'huoxiaoling_record_txn_runtime_receipts_v1'
]);

function installRuntimeStorageGuard(wxApi) {
  if (!wxApi || typeof wxApi !== 'object') {
    const error = new Error('独立运行时测试缺少wx API。');
    error.code = 'RUNTIME_TEST_WX_UNAVAILABLE';
    throw error;
  }
  const system = typeof wxApi.getSystemInfoSync === 'function'
    ? wxApi.getSystemInfoSync() || {}
    : {};
  const account = typeof wxApi.getAccountInfoSync === 'function'
    ? wxApi.getAccountInfoSync() || {}
    : {};
  const miniProgram = account.miniProgram || {};
  if (system.platform !== 'devtools' || miniProgram.envVersion !== 'develop') {
    const error = new Error('独立运行时测试只允许微信开发者工具develop环境。');
    error.code = 'RUNTIME_TEST_ENVIRONMENT_FORBIDDEN';
    throw error;
  }

  const allowed = new Set(RECORD_STORAGE_RUNTIME_TEST_KEY_LIST);
  const trace = [];
  let sequence = 0;
  const original = {
    getStorageSync: wxApi.getStorageSync.bind(wxApi),
    setStorageSync: wxApi.setStorageSync.bind(wxApi),
    removeStorageSync: wxApi.removeStorageSync.bind(wxApi),
    getStorageInfoSync: wxApi.getStorageInfoSync.bind(wxApi)
  };

  function record(operation, key, success, errorCode) {
    sequence += 1;
    trace.push({
      sequence,
      operation,
      key: String(key || ''),
      success: success !== false,
      errorCode: String(errorCode || '')
    });
  }

  function requireAllowed(operation, key) {
    const normalized = String(key || '');
    if (!allowed.has(normalized)) {
      record(operation, normalized, false, GUARD_ERROR_CODE);
      const error = new Error(`隔离运行时拒绝Storage key：${normalized}`);
      error.code = GUARD_ERROR_CODE;
      throw error;
    }
    return normalized;
  }

  wxApi.getStorageSync = function guardedGetStorageSync(key) {
    const normalized = requireAllowed('GET', key);
    try {
      const value = original.getStorageSync(normalized);
      record('GET', normalized, true);
      return value;
    } catch (error) {
      record('GET', normalized, false, error && error.code);
      throw error;
    }
  };
  wxApi.setStorageSync = function guardedSetStorageSync(key, value) {
    const normalized = requireAllowed('SET', key);
    try {
      const result = original.setStorageSync(normalized, value);
      record('SET', normalized, true);
      return result;
    } catch (error) {
      record('SET', normalized, false, error && error.code);
      throw error;
    }
  };
  wxApi.removeStorageSync = function guardedRemoveStorageSync(key) {
    const normalized = requireAllowed('REMOVE', key);
    try {
      const result = original.removeStorageSync(normalized);
      record('REMOVE', normalized, true);
      return result;
    } catch (error) {
      record('REMOVE', normalized, false, error && error.code);
      throw error;
    }
  };
  wxApi.getStorageInfoSync = function guardedGetStorageInfoSync() {
    try {
      const result = original.getStorageInfoSync() || {};
      record('INFO', '', true);
      return Object.assign({}, result, {
        keys: Array.isArray(result.keys)
          ? result.keys.filter((key) => allowed.has(String(key))).map(String).sort()
          : []
      });
    } catch (error) {
      record('INFO', '', false, error && error.code);
      throw error;
    }
  };

  function getAuditSummary() {
    const byOperation = { GET: 0, SET: 0, REMOVE: 0, INFO: 0 };
    const forbiddenByOperation = { GET: 0, SET: 0, REMOVE: 0 };
    const realBusinessKey = { reads: 0, writes: 0, removals: 0 };
    trace.forEach((entry) => {
      if (Object.prototype.hasOwnProperty.call(byOperation, entry.operation)) {
        byOperation[entry.operation] += 1;
      }
      if (entry.errorCode === GUARD_ERROR_CODE
        && Object.prototype.hasOwnProperty.call(forbiddenByOperation, entry.operation)) {
        forbiddenByOperation[entry.operation] += 1;
      }
      if (entry.key === REAL_BUSINESS_STORAGE_KEY) {
        if (entry.operation === 'GET') realBusinessKey.reads += 1;
        if (entry.operation === 'SET') realBusinessKey.writes += 1;
        if (entry.operation === 'REMOVE') realBusinessKey.removals += 1;
      }
    });
    return {
      totalCalls: trace.length,
      byOperation,
      forbiddenByOperation,
      forbiddenAccessCount: Object.values(forbiddenByOperation).reduce((sum, value) => sum + value, 0),
      realBusinessKey
    };
  }

  return Object.freeze({
    getAuditSummary,
    getTrace() {
      return trace.map((entry) => Object.assign({}, entry));
    },
    isActive() {
      return wxApi.getStorageSync.name === 'guardedGetStorageSync'
        && wxApi.setStorageSync.name === 'guardedSetStorageSync'
        && wxApi.removeStorageSync.name === 'guardedRemoveStorageSync';
    }
  });
}

module.exports = {
  GUARD_ERROR_CODE,
  REAL_BUSINESS_STORAGE_KEY,
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST,
  installRuntimeStorageGuard
};
