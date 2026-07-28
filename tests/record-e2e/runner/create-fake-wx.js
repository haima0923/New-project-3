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

  function recordStorage(operation, key) {
    const normalized = String(key || '');
    auditEvents.push({ operation, key: normalized });
    logicalKeyCalls[normalized] = (logicalKeyCalls[normalized] || 0) + 1;
  }

  const wx = {
    [FAKE_WX_BRAND]: true,
    getStorageSync(key) {
      recordStorage('GET', key);
      return safeClone(storage[key]);
    },
    setStorageSync(key, value) {
      recordStorage('SET', key);
      storage[key] = safeClone(value);
    },
    removeStorageSync(key) {
      recordStorage('REMOVE', key);
      delete storage[key];
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
      uiEvents.push({ type: 'MODAL', title: String(payload.title || '') });
      if (typeof payload.success === 'function') payload.success({ confirm: true, cancel: false });
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
    vibrateShort() {},
    nextTick(callback) {
      setImmediate(callback);
    }
  };

  return {
    audit() {
      return {
        fakeWxInstalled: wx[FAKE_WX_BRAND] === true,
        productionLogicalKeyCalls: safeClone(logicalKeyCalls),
        productionBusinessLogicalKeyCalls: logicalKeyCalls[BUSINESS_STORAGE_KEY] || 0,
        realWxStorageCalls: 0,
        remainingKeys: Object.keys(storage).sort(),
        journalPresent: Object.prototype.hasOwnProperty.call(storage, RECORD_STORAGE_JOURNAL_KEY),
        backupPresent: Object.prototype.hasOwnProperty.call(storage, RECORD_STORAGE_BACKUP_KEY),
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
    wx
  };
}

module.exports = {
  FAKE_WX_BRAND,
  assertFakeWxApi,
  createFakeWx
};
