const { LEGACY_BUSINESS_STORAGE_KEY: STORAGE_KEY } = require('./record-storage-adapter-contract');
const { createWxStorageGateway } = require('./record-storage-gateways');
const { createRecordStorageReleaseAMonitor } = require('./record-storage-release-monitor');
const {
  createLegacyReleaseARecordStorageCoordinator
} = require('./record-storage-transaction');
const { maskPhone, simpleFingerprint } = require('./customer-identity');

let RELEASE_A_STORAGE_FACADE = null;

function createInitialState() {
  return {
    meta: {
      onboarded: false,
      industry: '',
      userId: 'local-user',
      createdAt: new Date().toISOString()
    },
    customers: [],
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    dunningRecords: [],
    todos: [],
    orderProgress: [],
    pendingNotes: [],
    aiParseLogs: [],
    dunningTemplates: [
      {
        id: 'polite',
        name: '客气提醒',
        content: '{customer}好，之前那笔{amount}的款这两天方便安排一下不？'
      },
      {
        id: 'direct',
        name: '直接催促',
        content: '{customer}，那笔{amount}的款已经到期了，麻烦尽快安排一下。'
      }
    ]
  };
}

function createReleaseAStorageFacade(options = {}) {
  const monitor = options.monitor || createRecordStorageReleaseAMonitor(options.monitorOptions);
  const coordinator = createLegacyReleaseARecordStorageCoordinator(
    Object.assign({}, options, { monitor })
  );
  return Object.freeze({
    getIdentity() {
      return coordinator.getIdentity();
    },
    getMonitorEvents() {
      return monitor.getEvents();
    },
    getMonitorPolicy() {
      return monitor.getPolicy();
    },
    getState(readOptions) {
      return coordinator.readState(createInitialState, readOptions);
    },
    saveState(state, writeOptions) {
      return coordinator.writeLegacyState(state, writeOptions);
    },
    updateState(mutator, writeOptions) {
      return coordinator.updateLegacyState(createInitialState, mutator, writeOptions);
    },
    initializeState(writeOptions) {
      return coordinator.initializeLegacyState(createInitialState, writeOptions);
    },
    prepareRecordStorageInfrastructure(startupOptions) {
      return coordinator.startLegacyStorageInfrastructure(createInitialState, startupOptions);
    },
    getLastWriteResult() {
      return coordinator.getLastLegacyWriteResult();
    },
    getLastStartupResult() {
      return coordinator.getLastStartupResult();
    },
    isRecoveryLocked() {
      return coordinator.isRecoveryLocked();
    }
  });
}

function getReleaseAStorageFacade() {
  if (!RELEASE_A_STORAGE_FACADE) {
    RELEASE_A_STORAGE_FACADE = createReleaseAStorageFacade({
      gateway: createWxStorageGateway()
    });
  }
  return RELEASE_A_STORAGE_FACADE;
}

function getState(options) {
  return getReleaseAStorageFacade().getState(options);
}

function saveState(state, options) {
  return getReleaseAStorageFacade().saveState(state, options);
}

function updateState(mutator, options) {
  return getReleaseAStorageFacade().updateState(mutator, options);
}

function initializeState(options) {
  return getReleaseAStorageFacade().initializeState(options);
}

function prepareRecordStorageInfrastructure(options) {
  return getReleaseAStorageFacade().prepareRecordStorageInfrastructure(options);
}

function getRecordStorageInfrastructureStatus() {
  const facade = getReleaseAStorageFacade();
  return {
    identity: facade.getIdentity(),
    recoveryLocked: facade.isRecoveryLocked(),
    lastWriteResult: facade.getLastWriteResult(),
    lastStartupResult: facade.getLastStartupResult(),
    monitorPolicy: facade.getMonitorPolicy(),
    monitorEvents: facade.getMonitorEvents()
  };
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCustomer(raw = {}) {
  const phone = String(raw.phone || '').replace(/\s+/g, '');
  return {
    id: raw.id || generateId('cus'),
    userId: raw.userId || 'local-user',
    name: raw.name || raw.customerName || '未命名客户',
    phoneMasked: maskPhone(phone),
    phoneFingerprint: simpleFingerprint(phone),
    company: raw.company || '',
    region: raw.region || '',
    wechatRemark: raw.wechatRemark || '',
    duplicateReviewed: Boolean(raw.duplicateReviewed),
    mergedInto: raw.mergedInto || '',
    tags: raw.tags || [],
    isTemporary: !phone,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTradeAt: raw.lastTradeAt || ''
  };
}

function getCustomerDisplay(customer) {
  if (!customer) return '未关联客户';
  const label = customer.company
    || customer.region
    || (customer.phoneMasked ? `尾号${customer.phoneMasked.slice(-4)}` : '')
    || customer.wechatRemark
    || '临时客户';
  return `${customer.name}（${label}）`;
}

module.exports = {
  STORAGE_KEY,
  createReleaseAStorageFacade,
  createInitialState,
  generateId,
  getCustomerDisplay,
  getRecordStorageInfrastructureStatus,
  getState,
  initializeState,
  maskPhone,
  normalizeCustomer,
  prepareRecordStorageInfrastructure,
  saveState,
  simpleFingerprint,
  updateState
};
