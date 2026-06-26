const STORAGE_KEY = 'yiwu_boss_ai_assistant_v1';

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
  const state = wx.getStorageSync(STORAGE_KEY);
  if (!state) return createInitialState();
  return Object.assign(createInitialState(), state);
}

function saveState(state) {
  wx.setStorageSync(STORAGE_KEY, state);
  return state;
}

function updateState(mutator) {
  const state = getState();
  const nextState = mutator(state) || state;
  saveState(nextState);
  return nextState;
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function simpleFingerprint(value) {
  const source = String(value || '').replace(/\s+/g, '');
  if (!source) return '';
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash) + source.charCodeAt(i);
    hash &= 0xffffffff;
  }
  return `fp_${Math.abs(hash)}`;
}

function maskPhone(phone) {
  const source = String(phone || '').replace(/\s+/g, '');
  if (!source) return '';
  if (source.length < 7) return source;
  return `${source.slice(0, 3)}****${source.slice(-4)}`;
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
  createInitialState,
  generateId,
  getCustomerDisplay,
  getState,
  maskPhone,
  normalizeCustomer,
  saveState,
  simpleFingerprint,
  updateState
};
