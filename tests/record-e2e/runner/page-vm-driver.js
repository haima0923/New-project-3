const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { PAGE_PATHS, ROOT } = require('./constants');

const AI_PARSER_PATH = require.resolve('../../../utils/ai-parser');
const BUSINESS_PATH = require.resolve('../../../utils/business');

function applyDataPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => {
    const value = patch[key];
    if (!key.includes('.')) {
      target[key] = value;
      return;
    }
    const parts = key.split('.');
    let cursor = target;
    parts.slice(0, -1).forEach((part) => {
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    });
    cursor[parts[parts.length - 1]] = value;
  });
}

function businessDraftPayload(result = {}) {
  return {
    fields: safeClone(result.fields || {}),
    intent: result.intent || '',
    operation: result.operation || '',
    originalText: result.original_text || result.originalText || '',
    source: result.source || ''
  };
}

function createTransportIdentityAdapter(original, profile, evidence) {
  return async function transportIdentityAdapter(payload) {
    const result = await original(payload);
    if (!['FAKE_STANDARD', 'FAKE_DEEP', 'REPLAY'].includes(profile)) return result;
    const fallback = result && result.ai_fallback || {};
    if (fallback.status !== 'used' || fallback.business_result_valid !== true) return result;
    const beforeHash = stableHash(businessDraftPayload(result), 'page-draft-business-v1');
    const providerKind = profile === 'REPLAY' ? 'REPLAY' : 'FAKE';
    const adapted = Object.assign({}, result, {
      ai_fallback: Object.assign({}, fallback, { provider_kind: providerKind })
    });
    const afterHash = stableHash(businessDraftPayload(adapted), 'page-draft-business-v1');
    evidence.transportIdentityAdaptations.push({
      marker: 'TEST_ONLY_TRANSPORT_IDENTITY_ADAPTATION',
      from: String(fallback.provider_kind || 'REAL'),
      to: providerKind,
      status: fallback.status,
      businessHashBefore: beforeHash,
      businessHashAfter: afterHash,
      businessHashEqual: beforeHash === afterHash
    });
    return adapted;
  };
}

function instantiatePage(definition, evidence) {
  if (!definition) {
    throw Object.assign(new Error('Page definition was not captured'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const page = {
    data: safeClone(definition.data || {}),
    setData(patch, callback) {
      applyDataPatch(this.data, patch || {});
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

function detectCapabilities(surface, page) {
  const full = surface === 'FULL_PAGE';
  return {
    SELECT_CUSTOMER: full && typeof page.changeCustomerMatch === 'function',
    SELECT_ORDER: false,
    SELECT_QUOTATION: false,
    SELECT_RECEIVABLE: full && typeof page.changeReceivable === 'function',
    SELECT_DEPOSIT_ORDER: full && typeof page.changeOrderDeposit === 'function',
    EDIT_CONFIRMATION_FIELD: full
      ? typeof page.updateField === 'function'
      : typeof page.updateConfirmField === 'function',
    EDIT_PRIMARY_ITEM: full
      ? typeof page.updateItemField === 'function'
      : typeof page.updateConfirmField === 'function',
    EDIT_ADDITIONAL_ITEM: full && typeof page.updateItemField === 'function'
  };
}

function loadProductionPage(surface, runtime, spec, options = {}) {
  const relativePath = PAGE_PATHS[surface];
  if (!relativePath) {
    throw Object.assign(new Error(`Unsupported page surface: ${surface}`), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const pagePath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(pagePath, 'utf8');
  const pageRequire = createRequire(pagePath);
  const evidence = {
    pagePath: relativePath,
    pageMethodCalls: {},
    productionBusinessCalls: {
      saveConfirmedDraft: 0,
      savePendingNote: 0
    },
    transportIdentityAdaptations: []
  };
  const aiParser = require(AI_PARSER_PATH);
  const business = require(BUSINESS_PATH);
  const originalHybrid = aiParser.parseHybridInput;
  const originalSaveConfirmed = business.saveConfirmedDraft;
  const originalSavePending = business.savePendingNote;
  aiParser.parseHybridInput = createTransportIdentityAdapter(
    originalHybrid,
    spec.ai.profile,
    evidence
  );
  business.saveConfirmedDraft = (...args) => {
    evidence.productionBusinessCalls.saveConfirmedDraft += 1;
    return originalSaveConfirmed(...args);
  };
  business.savePendingNote = (...args) => {
    evidence.productionBusinessCalls.savePendingNote += 1;
    return originalSavePending(...args);
  };
  let definition = null;
  try {
    const sandbox = {
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
      getApp: global.getApp,
      module: { exports: {} },
      exports: {},
      Page(value) { definition = value; },
      require: pageRequire,
      requirePlugin: global.requirePlugin,
      setInterval,
      setTimeout,
      wx: runtime.fakeWx.wx
    };
    vm.runInNewContext(code, sandbox, { filename: pagePath });
  } finally {
    aiParser.parseHybridInput = originalHybrid;
    business.saveConfirmedDraft = originalSaveConfirmed;
    business.savePendingNote = originalSavePending;
  }
  const page = instantiatePage(definition, evidence);
  const availableCapabilities = detectCapabilities(surface, page);
  evidence.availableCapabilities = safeClone(availableCapabilities);
  if (options.runLifecycle !== false) {
    if (typeof page.onLoad === 'function') {
      // PENDING_EDIT deliberately enters through the production hand-off key and
      // onShow() path. Passing pendingId here as well would load it twice.
      page.onLoad({});
    }
    if (typeof page.onShow === 'function') page.onShow();
  }
  return {
    availableCapabilities,
    evidence,
    page,
    surface
  };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

async function waitForPageParse(page, timeoutMs = 3000) {
  const started = Date.now();
  while (page.data && page.data.parsing === true) {
    if (Date.now() - started > timeoutMs) {
      throw Object.assign(new Error('Page parse did not settle'), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushAsync();
}

module.exports = {
  businessDraftPayload,
  detectCapabilities,
  flushAsync,
  loadProductionPage,
  waitForPageParse
};
