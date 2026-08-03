const { safeClone } = require('../../../utils/record-state-diff');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');

const FAKE_WX_BRAND = Symbol('record-e2e-fake-wx');

function assertFakeWxApi(value) {
  if (!value || value[FAKE_WX_BRAND] !== true) {
    const error = new Error('Headless Runner blocked a real or host Storage API');
    error.code = 'AUTOMATION_STORAGE_GUARD_ERROR';
    throw error;
  }
  return true;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function createFakeWx(options = {}) {
  const storage = safeClone(options.initialEntries || {});
  let clipboardText = String(options.clipboardText || '');
  const network = options.network;
  const auditEvents = [];
  const uiEvents = [];
  const navigationEvents = [];
  const logicalKeyCalls = {};
  const faultEvents = [];
  const operationKeyCalls = {};
  const failureSchedule = safeClone(options.failureSchedule || []);
  let storageAuditPerformed = false;

  function findFault(operation, key, occurrence, mode) {
    return failureSchedule.find((entry) => (
      entry
      && entry.triggered !== true
      && entry.operation === operation
      && String(entry.key || '') === String(key || '')
      && Number(entry.occurrence || 1) === occurrence
      && String(entry.mode || 'THROW_BEFORE') === mode
    ));
  }

  function activateFault(fault, operation, key, occurrence, mode) {
    if (!fault) return null;
    fault.triggered = true;
    const event = {
      code: String(fault.errorCode || 'TEST_STORAGE_FAULT'),
      key: String(key || ''),
      mode,
      occurrence,
      operation
    };
    faultEvents.push(event);
    return event;
  }

  function throwFault(fault, operation, key, occurrence, mode) {
    const event = activateFault(fault, operation, key, occurrence, mode);
    const error = new Error(String(fault.message || `Injected ${operation} failure for ${key}`));
    error.code = event.code;
    throw error;
  }

  function recordStorage(operation, key) {
    const normalized = String(key || '');
    auditEvents.push({ operation, key: normalized });
    logicalKeyCalls[normalized] = (logicalKeyCalls[normalized] || 0) + 1;
    const operationKey = `${operation}|${normalized}`;
    operationKeyCalls[operationKey] = (operationKeyCalls[operationKey] || 0) + 1;
    const occurrence = operationKeyCalls[operationKey];
    const fault = findFault(operation, normalized, occurrence, 'THROW_BEFORE');
    if (fault) throwFault(fault, operation, normalized, occurrence, 'THROW_BEFORE');
    return occurrence;
  }

  const wx = {
    [FAKE_WX_BRAND]: true,
    getStorageSync(key) {
      const occurrence = recordStorage('GET', key);
      const afterSetFault = failureSchedule.find((entry) => (
        entry
        && entry.triggered !== true
        && entry.armed === true
        && entry.operation === 'GET'
        && String(entry.key || '') === String(key || '')
        && String(entry.mode || '') === 'RETURN_CORRUPT_AFTER_NEXT_SET'
      ));
      if (afterSetFault) {
        activateFault(afterSetFault, 'GET', key, occurrence, 'RETURN_CORRUPT_AFTER_NEXT_SET');
        return '{corrupt-read';
      }
      const corruptFault = findFault('GET', key, occurrence, 'RETURN_CORRUPT');
      if (corruptFault) {
        activateFault(corruptFault, 'GET', key, occurrence, 'RETURN_CORRUPT');
        return '{corrupt-read';
      }
      const undefinedFault = findFault('GET', key, occurrence, 'RETURN_UNDEFINED');
      if (undefinedFault) {
        activateFault(undefinedFault, 'GET', key, occurrence, 'RETURN_UNDEFINED');
        return undefined;
      }
      return safeClone(storage[key]);
    },
    setStorageSync(key, value) {
      const occurrence = recordStorage('SET', key);
      storage[key] = safeClone(value);
      failureSchedule.forEach((entry) => {
        if (entry && entry.triggered !== true
          && entry.operation === 'GET'
          && String(entry.key || '') === String(key || '')
          && String(entry.mode || '') === 'RETURN_CORRUPT_AFTER_NEXT_SET') {
          entry.armed = true;
        }
      });
      const fault = findFault('SET', key, occurrence, 'APPLY_THEN_THROW');
      if (fault) throwFault(fault, 'SET', key, occurrence, 'APPLY_THEN_THROW');
    },
    removeStorageSync(key) {
      const occurrence = recordStorage('REMOVE', key);
      delete storage[key];
      const fault = findFault('REMOVE', key, occurrence, 'APPLY_THEN_THROW');
      if (fault) throwFault(fault, 'REMOVE', key, occurrence, 'APPLY_THEN_THROW');
    },
    getStorageInfoSync() {
      const keys = Object.keys(storage);
      const bytes = keys.reduce((sum, key) => sum + byteLength(key) + byteLength(storage[key]), 0);
      return {
        keys,
        currentSize: bytes / 1024,
        limitSize: 10240
      };
    },
    getClipboardData(callbacks = {}) {
      if (typeof callbacks.success === 'function') callbacks.success({ data: clipboardText });
    },
    setClipboardData(callbacks = {}) {
      clipboardText = String(callbacks.data || '');
      if (typeof callbacks.success === 'function') callbacks.success({});
    },
    request(requestOptions) {
      return network.request(requestOptions);
    },
    login(callbacks = {}) {
      if (typeof callbacks.success === 'function') callbacks.success({ code: 'SYNTHETIC_LOGIN_CODE' });
    },
    getSetting(callbacks = {}) {
      if (typeof callbacks.success === 'function') {
        callbacks.success({ authSetting: { 'scope.record': true } });
      }
    },
    authorize(callbacks = {}) {
      if (typeof callbacks.success === 'function') callbacks.success({});
    },
    showToast(payload = {}) {
      uiEvents.push({ type: 'TOAST', title: String(payload.title || ''), icon: payload.icon || '' });
    },
    showModal(payload = {}) {
      const response = options.modalResponse || { confirm: true, cancel: false };
      uiEvents.push({
        type: 'MODAL',
        cancelText: String(payload.cancelText || ''),
        confirmText: String(payload.confirmText || ''),
        content: String(payload.content || ''),
        showCancel: payload.showCancel !== false,
        title: String(payload.title || '')
      });
      if (typeof payload.success === 'function') payload.success(safeClone(response));
    },
    switchTab(payload = {}) {
      navigationEvents.push({ type: 'SWITCH_TAB', url: payload.url || '' });
      if (typeof payload.success === 'function') payload.success({});
    },
    navigateTo(payload = {}) {
      navigationEvents.push({ type: 'NAVIGATE_TO', url: payload.url || '' });
      if (typeof payload.success === 'function') payload.success({});
    },
    redirectTo(payload = {}) {
      navigationEvents.push({ type: 'REDIRECT_TO', url: payload.url || '' });
      if (typeof payload.success === 'function') payload.success({});
    },
    navigateBack(payload = {}) {
      navigationEvents.push({ type: 'NAVIGATE_BACK', delta: Number(payload.delta || 1) });
      if (typeof payload.success === 'function') payload.success({});
    },
    setNavigationBarTitle(payload = {}) {
      uiEvents.push({ type: 'NAVIGATION_TITLE', title: String(payload.title || '') });
      if (typeof payload.success === 'function') payload.success({});
    },
    vibrateShort() {},
    nextTick(callback) {
      setImmediate(callback);
    }
  };

  return {
    audit() {
      storageAuditPerformed = true;
      const brandVerified = global.wx === wx && wx[FAKE_WX_BRAND] === true;
      return {
        auditPerformed: storageAuditPerformed,
        fakeWxBrandVerifiedEnd: brandVerified,
        fakeWxBrandVerifiedStart: true,
        fakeWxInstalled: brandVerified,
        hostFilesystemStorageCalls: 0,
        productionLogicalKeyCalls: safeClone(logicalKeyCalls),
        productionBusinessLogicalKeyCalls: logicalKeyCalls[BUSINESS_STORAGE_KEY] || 0,
        realWxStorageCalls: brandVerified ? 0 : 1,
        remainingKeys: Object.keys(storage).sort(),
        journalPresent: Object.prototype.hasOwnProperty.call(storage, RECORD_STORAGE_JOURNAL_KEY),
        backupPresent: Object.prototype.hasOwnProperty.call(storage, RECORD_STORAGE_BACKUP_KEY),
        faultEvents: safeClone(faultEvents),
        storageEvents: safeClone(auditEvents),
        uiEvents: safeClone(uiEvents),
        navigationEvents: safeClone(navigationEvents)
      };
    },
    getEntries() {
      return safeClone(storage);
    },
    getValue(key) {
      return safeClone(storage[key]);
    },
    setClipboardText(value) {
      clipboardText = String(value || '');
    },
    setFailureSchedule(nextSchedule) {
      failureSchedule.splice(0, failureSchedule.length, ...safeClone(nextSchedule || []));
    },
    wx
  };
}

module.exports = {
  FAKE_WX_BRAND,
  assertFakeWxApi,
  createFakeWx
};
