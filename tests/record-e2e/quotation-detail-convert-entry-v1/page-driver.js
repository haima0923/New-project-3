const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { safeClone } = require('../../../utils/record-state-diff');
const { ROOT } = require('../runner/constants');
const { loadProductionPage } = require('../runner/page-vm-driver');

const BUSINESS_PATH = require.resolve('../../../utils/business');
const STORAGE_PATH = require.resolve('../../../utils/storage');

function applyDataPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => {
    target[key] = patch[key];
  });
}

function instantiatePage(definition, evidence) {
  const page = {
    data: safeClone(definition.data || {}),
    setData(patch, callback) {
      applyDataPatch(this.data, patch);
      if (typeof callback === 'function') callback.call(this);
    },
    getTabBar() {
      return { updateSelected() {} };
    }
  };
  Object.keys(definition).forEach((key) => {
    if (key === 'data') return;
    if (typeof definition[key] !== 'function') {
      page[key] = safeClone(definition[key]);
      return;
    }
    page[key] = (...args) => {
      evidence.pageMethodCalls[key] = (evidence.pageMethodCalls[key] || 0) + 1;
      return definition[key].apply(page, args);
    };
  });
  return page;
}

function loadRecordDetailPage(runtime, options = {}) {
  const relativePath = 'pages/record-detail/record-detail.js';
  const pagePath = path.join(ROOT, relativePath);
  const pageRequire = createRequire(pagePath);
  const code = fs.readFileSync(pagePath, 'utf8');
  const evidence = {
    pageMethodCalls: {},
    pagePath: relativePath,
    productionBusinessCalls: { convertQuotationToOrder: 0 },
    productionStorageCalls: { saveState: 0 },
    productionStorageReads: { getState: 0 },
    navigationBarTitles: []
  };
  const business = require(BUSINESS_PATH);
  const storage = require(STORAGE_PATH);
  const originalConvert = business.convertQuotationToOrder;
  const originalGetState = storage.getState;
  const originalSaveState = storage.saveState;
  business.convertQuotationToOrder = (...args) => {
    evidence.productionBusinessCalls.convertQuotationToOrder += 1;
    return originalConvert(...args);
  };
  storage.getState = (...args) => {
    evidence.productionStorageReads.getState += 1;
    return originalGetState(...args);
  };
  storage.saveState = (...args) => {
    evidence.productionStorageCalls.saveState += 1;
    return originalSaveState(...args);
  };
  let definition = null;
  try {
    const pageWx = Object.assign({}, runtime.fakeWx.wx, {
      setNavigationBarTitle(payload = {}) {
        evidence.navigationBarTitles.push(String(payload.title || ''));
      }
    });
    vm.runInNewContext(code, {
      Array,
      Boolean,
      Date,
      JSON,
      Math,
      Number,
      Object,
      Promise,
      String,
      clearInterval,
      clearTimeout,
      console,
      encodeURIComponent,
      getApp: global.getApp,
      getCurrentPages: () => [],
      module: { exports: {} },
      exports: {},
      Page(value) { definition = value; },
      require: pageRequire,
      setInterval,
      setTimeout,
      wx: pageWx
    }, { filename: pagePath });
  } finally {
    business.convertQuotationToOrder = originalConvert;
    storage.getState = originalGetState;
    storage.saveState = originalSaveState;
  }
  if (!definition) {
    throw Object.assign(new Error('Record detail Page definition was not captured'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const page = instantiatePage(definition, evidence);
  if (typeof page.onLoad === 'function') page.onLoad(options);
  if (typeof page.onShow === 'function') page.onShow();
  return { evidence, page };
}

function loadQuotationPage(runtime, spec, options = {}) {
  const navigationBackEvents = [];
  runtime.fakeWx.wx.navigateBack = (payload = {}) => {
    navigationBackEvents.push({ delta: Number(payload.delta || 1), type: 'NAVIGATE_BACK' });
    if (typeof payload.success === 'function') payload.success({});
  };
  const driver = loadProductionPage('QUOTATION_LIST', runtime, spec, { runLifecycle: false });
  driver.evidence.navigationBackEvents = navigationBackEvents;
  if (typeof driver.page.onLoad === 'function') driver.page.onLoad(options);
  if (typeof driver.page.onShow === 'function') driver.page.onShow();
  return driver;
}

function loadRecordsPage(runtime, options = {}) {
  const relativePath = 'pages/records/records.js';
  const pagePath = path.join(ROOT, relativePath);
  const pageRequire = createRequire(pagePath);
  const code = fs.readFileSync(pagePath, 'utf8');
  const evidence = {
    navigationBackEvents: [],
    navigationBarTitles: [],
    pageMethodCalls: {},
    pagePath: relativePath,
    productionBusinessCalls: {
      cancelQuotation: 0,
      convertQuotationToOrder: 0,
      softDeleteRecord: 0
    },
    productionStorageCalls: { saveState: 0 },
    productionStorageReads: { getState: 0 }
  };
  const business = require(BUSINESS_PATH);
  const storage = require(STORAGE_PATH);
  const originals = {
    cancelQuotation: business.cancelQuotation,
    convertQuotationToOrder: business.convertQuotationToOrder,
    getState: storage.getState,
    saveState: storage.saveState,
    softDeleteRecord: business.softDeleteRecord
  };
  if (typeof originals.cancelQuotation === 'function') {
    business.cancelQuotation = (...args) => {
      evidence.productionBusinessCalls.cancelQuotation += 1;
      return originals.cancelQuotation(...args);
    };
  }
  business.convertQuotationToOrder = (...args) => {
    evidence.productionBusinessCalls.convertQuotationToOrder += 1;
    return originals.convertQuotationToOrder(...args);
  };
  business.softDeleteRecord = (...args) => {
    evidence.productionBusinessCalls.softDeleteRecord += 1;
    return originals.softDeleteRecord(...args);
  };
  storage.getState = (...args) => {
    evidence.productionStorageReads.getState += 1;
    return originals.getState(...args);
  };
  storage.saveState = (...args) => {
    evidence.productionStorageCalls.saveState += 1;
    return originals.saveState(...args);
  };
  let definition = null;
  try {
    const pageWx = Object.assign({}, runtime.fakeWx.wx, {
      navigateBack(payload = {}) {
        evidence.navigationBackEvents.push({ delta: Number(payload.delta || 1), type: 'NAVIGATE_BACK' });
        if (typeof payload.success === 'function') payload.success({});
      },
      setNavigationBarTitle(payload = {}) {
        evidence.navigationBarTitles.push(String(payload.title || ''));
      }
    });
    vm.runInNewContext(code, {
      Array,
      Boolean,
      Date,
      JSON,
      Math,
      Number,
      Object,
      Promise,
      String,
      clearInterval,
      clearTimeout,
      console,
      encodeURIComponent,
      getApp: global.getApp,
      getCurrentPages: () => [],
      module: { exports: {} },
      exports: {},
      Page(value) { definition = value; },
      require: pageRequire,
      setInterval,
      setTimeout,
      wx: pageWx
    }, { filename: pagePath });
  } finally {
    if (typeof originals.cancelQuotation === 'function') {
      business.cancelQuotation = originals.cancelQuotation;
    } else {
      delete business.cancelQuotation;
    }
    business.convertQuotationToOrder = originals.convertQuotationToOrder;
    business.softDeleteRecord = originals.softDeleteRecord;
    storage.getState = originals.getState;
    storage.saveState = originals.saveState;
  }
  if (!definition) {
    throw Object.assign(new Error('Records Page definition was not captured'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const page = instantiatePage(definition, evidence);
  if (options.runLifecycle !== false && typeof page.onShow === 'function') page.onShow();
  return { evidence, page };
}

module.exports = {
  loadQuotationPage,
  loadRecordDetailPage,
  loadRecordsPage
};
