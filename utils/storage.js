const { LEGACY_BUSINESS_STORAGE_KEY: STORAGE_KEY } = require('./record-storage-adapter-contract');
const { createRecordStorageCoordinator } = require('./record-storage-coordinator');
const { maskPhone, simpleFingerprint } = require('./customer-identity');

const LEGACY_STORAGE_COORDINATOR = createRecordStorageCoordinator({ mode: 'LEGACY_ONLY' });

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

function getState() {
  return LEGACY_STORAGE_COORDINATOR.readState(createInitialState);
}

function saveState(state, options) {
  return LEGACY_STORAGE_COORDINATOR.writeLegacyState(state, options);
}

function updateState(mutator, options) {
  return LEGACY_STORAGE_COORDINATOR.updateLegacyState(createInitialState, mutator, options);
}

function initializeState(options) {
  return LEGACY_STORAGE_COORDINATOR.initializeLegacyState(createInitialState, options);
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
  createInitialState,
  generateId,
  getCustomerDisplay,
  getState,
  initializeState,
  maskPhone,
  normalizeCustomer,
  saveState,
  simpleFingerprint,
  updateState
};
