#!/usr/bin/env node

/*
 * `--live-ai` must use the real parseHybridInput path. Controlled stubs remain
 * available only in non-live suites; live and stub modes are intentionally
 * mutually exclusive so a failed request cannot be rewritten as `used`.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const { analyzeClipboardText, getPasteMeta, isWechatChatText } = require('../utils/clipboard-chat');
const { normalizeAiResult, parseHybridInput: realParseHybridInput } = require('../utils/ai-parser');
const { parseInput } = require('../utils/parser');
const { createInitialState } = require('../utils/storage');

const ROOT = path.resolve(__dirname, '..');
const STORAGE_KEY = 'yiwu_boss_ai_assistant_v1';
const AI_PARSER_PATH = require.resolve('../utils/ai-parser');

const FORMAL_KEYS = [
  'customers',
  'quotations',
  'orders',
  'receivables',
  'paymentRecords',
  'todos',
  'orderProgress'
];

const COUNT_KEYS = FORMAL_KEYS.concat(['pendingNotes', 'aiParseLogs']);

const ENTRY_CONFIG = {
  input: {
    label: '完整记一笔',
    page: 'pages/input/input.js',
    disabledKey: 'disableFormalSave',
    saveMethod: 'saveFormal',
    pendingMethod: 'savePending',
    warningFields: ['customerMatchText', 'customerMatchWarningText', 'warningMissingText', 'warningLowText', 'parseAssistText']
  },
  dashboard: {
    label: '首页快记',
    page: 'pages/dashboard/dashboard.js',
    disabledKey: 'disableQuickSave',
    saveMethod: 'confirmQuickSave',
    pendingMethod: 'savePendingFromConfirm',
    warningFields: ['warningText', 'voiceTip']
  }
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return Array.from(new Set((values || []).filter((item) => item !== undefined && item !== null && item !== '')));
}

function toText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return String(Math.round(number * 100) / 100);
}

function todayPlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildBaseState(seed = {}) {
  const state = Object.assign(createInitialState(), clone(seed));
  COUNT_KEYS.forEach((key) => {
    if (!Array.isArray(state[key])) state[key] = [];
  });
  return state;
}

function buildStateWithReceivable(customerName = '王总', amount = 5000) {
  const state = buildBaseState();
  const customer = {
    id: `cus_${customerName}`,
    userId: 'local-user',
    name: customerName,
    phoneMasked: '',
    phoneFingerprint: '',
    company: '',
    region: '',
    wechatRemark: '',
    duplicateReviewed: false,
    mergedInto: '',
    tags: [],
    isTemporary: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTradeAt: ''
  };
  state.customers.push(customer);
  state.receivables.push({
    id: `rec_${customerName}`,
    userId: 'local-user',
    customerId: customer.id,
    amount: String(amount),
    paidAmount: '0',
    dueDate: todayPlus(7),
    status: '待收',
    source: 'legacy',
    originalText: `${customerName}还欠${amount}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return state;
}

function buildStateWithQuotation(customerName = '王总') {
  const state = buildBaseState();
  const customer = {
    id: `cus_quote_${customerName}`,
    userId: 'local-user',
    name: customerName,
    phoneMasked: '',
    phoneFingerprint: '',
    company: '',
    region: '',
    wechatRemark: '',
    duplicateReviewed: false,
    mergedInto: '',
    tags: [],
    isTemporary: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTradeAt: ''
  };
  state.customers.push(customer);
  state.quotations.push({
    id: `quo_${customerName}`,
    userId: 'local-user',
    customerId: customer.id,
    productName: '礼品盒',
    quantity: '500',
    unit: '套',
    unitPrice: '3.8',
    totalAmount: '1900',
    deliveryDate: todayPlus(7),
    status: '待跟进',
    originalText: `${customerName}报价礼品盒500套3.8`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return state;
}

function buildStateWithOrder(customerName = '王总') {
  const state = buildBaseState();
  const customer = {
    id: `cus_order_${customerName}`,
    userId: 'local-user',
    name: customerName,
    phoneMasked: '',
    phoneFingerprint: '',
    company: '',
    region: '',
    wechatRemark: '',
    duplicateReviewed: false,
    mergedInto: '',
    tags: [],
    isTemporary: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTradeAt: ''
  };
  state.customers.push(customer);
  state.orders.push({
    id: `ord_${customerName}`,
    userId: 'local-user',
    customerId: customer.id,
    productName: '礼品盒',
    quantity: '500',
    unit: '套',
    unitPrice: '3.8',
    totalAmount: '1900',
    items: [{ productName: '礼品盒', quantity: '500', unit: '套', unitPrice: '3.8', totalAmount: '1900' }],
    requiredDeliveryDate: todayPlus(7),
    status: '待生产',
    originalText: `${customerName}下单礼品盒500套3.8`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return state;
}

function getCounts(state) {
  const counts = {};
  COUNT_KEYS.forEach((key) => {
    counts[key] = Array.isArray(state[key]) ? state[key].length : 0;
  });
  return counts;
}

function diffCounts(before, after) {
  const diff = {};
  COUNT_KEYS.forEach((key) => {
    diff[key] = (after[key] || 0) - (before[key] || 0);
  });
  return diff;
}

function formalDeltaTotal(diff) {
  return FORMAL_KEYS.reduce((sum, key) => sum + Math.max(0, diff[key] || 0), 0);
}

function getFormalRecordIds(state) {
  return FORMAL_KEYS.reduce((result, key) => {
    result[key] = (state[key] || [])
      .map((record) => record && record.id)
      .filter(Boolean);
    return result;
  }, {});
}

function getLatestFormalRecord(state, delta = {}, beforeIds = {}) {
  const deltaCandidates = [
    ['orders', 'order'],
    ['quotations', 'quotation'],
    ['receivables', 'receivable'],
    ['paymentRecords', 'payment'],
    ['todos', 'todo']
  ];
  const changed = deltaCandidates.find(([key]) => (delta[key] || 0) > 0);
  if (changed) {
    const [key, type] = changed;
    const records = state[key] || [];
    const oldIds = new Set(beforeIds[key] || []);
    const created = records.find((record) => record && record.id && !oldIds.has(record.id));
    return { type: created ? type : '', record: created || null };
  }
  return { type: '', record: null };
}

function requestWithNode(options) {
  const target = new URL(options.url);
  const transport = target.protocol === 'https:' ? https : http;
  const body = JSON.stringify(options.data || {});
  const requestOptions = {
    method: options.method || 'POST',
    headers: Object.assign({
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }, options.header || {}),
    timeout: options.timeout || 12000
  };

  const req = transport.request(target, requestOptions, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      let data = raw;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (error) {
        data = raw;
      }
      if (typeof options.success === 'function') {
        options.success({ statusCode: res.statusCode, data });
      }
    });
  });

  req.on('timeout', () => {
    req.destroy(new Error('request timeout'));
  });
  req.on('error', (error) => {
    if (typeof options.fail === 'function') options.fail(error);
  });
  req.write(body);
  req.end();
}

function createWxHarness({ initialState, apiBaseUrl = '', clipboardText = '', requestHandler = null } = {}) {
  const storage = {
    [STORAGE_KEY]: clone(initialState || buildBaseState())
  };
  const events = {
    toasts: [],
    navigation: [],
    requests: []
  };
  const wx = {
    getStorageSync(key) {
      return clone(storage[key]);
    },
    setStorageSync(key, value) {
      storage[key] = clone(value);
    },
    removeStorageSync(key) {
      delete storage[key];
    },
    showToast(options = {}) {
      events.toasts.push(clone(options));
    },
    switchTab(options = {}) {
      events.navigation.push(Object.assign({ type: 'switchTab' }, clone(options)));
    },
    navigateTo(options = {}) {
      events.navigation.push(Object.assign({ type: 'navigateTo' }, clone(options)));
    },
    redirectTo(options = {}) {
      events.navigation.push(Object.assign({ type: 'redirectTo' }, clone(options)));
    },
    getClipboardData(options = {}) {
      if (typeof options.success === 'function') options.success({ data: clipboardText });
    },
    setClipboardData(options = {}) {
      clipboardText = options.data || '';
      if (typeof options.success === 'function') options.success({});
    },
    getRecorderManager() {
      return {
        onStop() {},
        onError() {},
        start() {},
        stop() {}
      };
    },
    getSetting(options = {}) {
      if (typeof options.success === 'function') options.success({ authSetting: { 'scope.record': true } });
    },
    authorize(options = {}) {
      if (typeof options.success === 'function') options.success({});
    },
    vibrateShort() {},
    request(options = {}) {
      events.requests.push({
        url: options.url,
        data: clone(options.data || {})
      });
      if (typeof requestHandler === 'function') {
        try {
          requestHandler(options, events);
        } catch (error) {
          if (typeof options.fail === 'function') options.fail(error);
        }
        return;
      }
      if (!apiBaseUrl) {
        if (typeof options.fail === 'function') options.fail(new Error('API base URL is not configured'));
        return;
      }
      requestWithNode(options);
    }
  };

  return {
    wx,
    events,
    storage,
    getState() {
      return clone(storage[STORAGE_KEY] || buildBaseState());
    }
  };
}

function installGlobals(harness, apiBaseUrl = '') {
  global.wx = harness.wx;
  global.getApp = () => ({
    globalData: {
      apiBaseUrl,
      aiParseEndpoint: '/api/ai/parse',
      aiTranscribeEndpoint: ''
    }
  });
  global.requirePlugin = () => null;
}

function applyDataPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => {
    const value = patch[key];
    if (!key.includes('.')) {
      target[key] = value;
      return;
    }
    const parts = key.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  });
}

function instantiatePage(definition) {
  if (!definition) throw new Error('Page definition was not captured');
  const page = {
    data: clone(definition.data || {}),
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
    page[key] = typeof definition[key] === 'function'
      ? definition[key].bind(page)
      : clone(definition[key]);
  });
  return page;
}

function loadPage(entry, harness, hybridStub, apiBaseUrl) {
  const config = ENTRY_CONFIG[entry];
  const pagePath = path.join(ROOT, config.page);
  const code = fs.readFileSync(pagePath, 'utf8');
  const pageRequire = createRequire(pagePath);
  const aiParserModule = require(AI_PARSER_PATH);
  const originalHybrid = aiParserModule.parseHybridInput;
  let pageDefinition = null;

  if (hybridStub) aiParserModule.parseHybridInput = hybridStub;
  installGlobals(harness, apiBaseUrl);
  try {
    const sandbox = {
      console,
      require: pageRequire,
      module: { exports: {} },
      exports: {},
      wx: harness.wx,
      getApp: global.getApp,
      requirePlugin: global.requirePlugin,
      Page(definition) {
        pageDefinition = definition;
      },
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object
    };
    vm.runInNewContext(code, sandbox, { filename: pagePath });
  } finally {
    aiParserModule.parseHybridInput = originalHybrid;
  }

  return instantiatePage(pageDefinition);
}

function flushAsync() {
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(resolve));
  });
}

function waitForParseCompletion(page, options = {}) {
  const timeoutMs = Number(options.parseWaitTimeoutMs || 30000);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (!page.data || page.data.parsing !== true) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const error = new Error(`Page parse did not settle within ${timeoutMs}ms`);
        error.code = 'FLOW_PARSE_TIMEOUT';
        reject(error);
        return;
      }
      setTimeout(poll, 10);
    };
    setImmediate(poll);
  });
}

function getCaseInputForParser(testCase) {
  if (testCase.source === 'paste' || isWechatChatText(testCase.input)) {
    const analysis = analyzeClipboardText(testCase.input);
    if (analysis.status === 'ok') {
      return {
        text: analysis.extractedText,
        rawText: analysis.rawText,
        extractedText: analysis.extractedText,
        pasteMeta: getPasteMeta(analysis),
        source: 'paste'
      };
    }
  }
  return {
    text: testCase.input,
    rawText: testCase.input,
    extractedText: '',
    pasteMeta: null,
    source: testCase.source || 'typed'
  };
}

function buildLocalParserEvidence(testCase, state) {
  const payload = getCaseInputForParser(testCase);
  return parseInput({
    text: payload.text,
    source: payload.source,
    context: 'home',
    state,
    rawText: payload.rawText,
    extractedText: payload.extractedText,
    pasteMeta: payload.pasteMeta
  });
}

function getFieldsFromPage(page) {
  if (page.data.fields) return page.data.fields;
  if (page.data.parseResult && page.data.parseResult.fields) return page.data.parseResult.fields;
  return {};
}

function getParseResultFromPage(page) {
  return page.data.parseResult || null;
}

function getItems(fields = {}) {
  if (Array.isArray(fields.items) && fields.items.length) return fields.items;
  if (fields.productName || fields.quantity || fields.unitPrice || fields.amount) {
    return [{
      productName: fields.productName || '',
      quantity: fields.quantity || '',
      unit: fields.unit || '',
      unitPrice: fields.unitPrice || '',
      amount: fields.amount || '',
      dueDate: fields.dueDate || ''
    }];
  }
  return [];
}

function getWarningText(entry, page, events) {
  const fields = ENTRY_CONFIG[entry].warningFields;
  const pageText = fields.map((field) => page.data[field]).filter(Boolean).join('\n');
  const toastText = (events.toasts || []).map((item) => item.title || '').filter(Boolean).join('\n');
  return [pageText, toastText].filter(Boolean).join('\n');
}

function getButtonDisabled(entry, page) {
  return Boolean(page.data[ENTRY_CONFIG[entry].disabledKey]);
}

function runPageParse(entry, page, testCase) {
  if (entry === 'input') {
    if (testCase.source === 'paste' || isWechatChatText(testCase.input)) {
      if (typeof page.onTextInput === 'function') {
        page.onTextInput({ detail: { value: testCase.input } });
      } else {
        page.setData({ source: 'paste', text: testCase.input });
      }
    } else {
      page.setData({
        source: testCase.source || 'typed',
        text: testCase.input
      });
    }
    page.runParse(testCase.reviewMode || 'standard');
    return;
  }

  if (entry === 'dashboard') {
    if (testCase.source === 'voice') {
      page.runQuickParse(testCase.input, 'voice', null, testCase.reviewMode || 'standard');
      return;
    }
    if (testCase.source === 'paste') {
      const analysis = analyzeClipboardText(testCase.input);
      if (analysis.status === 'ok') {
        page.runQuickParse(analysis.extractedText, 'paste', analysis, testCase.reviewMode || 'standard');
      } else {
        page.setData({ composerText: testCase.input });
        page.submitComposer();
      }
      return;
    }
    page.setData({ composerText: testCase.input });
    if (testCase.reviewMode === 'deep') {
      page.runQuickParse(testCase.input, 'typed', null, 'deep');
    } else {
      page.submitComposer();
    }
  }
}

function runEdit(entry, page, edit) {
  if (entry === 'input') {
    if (edit.itemIndex !== undefined && typeof page.updateItemField === 'function') {
      page.updateItemField({
        currentTarget: { dataset: { index: edit.itemIndex, field: edit.field } },
        detail: { value: edit.value }
      });
      return;
    }
    if (edit.field === 'dueDate' && typeof page.changeDateField === 'function') {
      page.changeDateField({
        currentTarget: { dataset: { field: edit.field } },
        detail: { value: edit.value }
      });
      return;
    }
    page.updateField({
      currentTarget: { dataset: { field: edit.field } },
      detail: { value: edit.value }
    });
    return;
  }

  if (edit.field === 'dueDate' && typeof page.changeConfirmDate === 'function') {
    page.changeConfirmDate({
      currentTarget: { dataset: { field: edit.field } },
      detail: { value: edit.value }
    });
    return;
  }
  page.updateConfirmField({
    currentTarget: { dataset: { field: edit.field } },
    detail: { value: edit.value }
  });
}

function defaultAiFieldsForCase(testCase) {
  const fields = Object.assign({}, testCase.aiFields || {});
  if (testCase.id.includes('yuan')) {
    return Object.assign({
      customerName: '元',
      productName: '礼品盒',
      quantity: '517',
      unit: '套',
      unitPrice: '3.8',
      amount: normalizeMoney(517 * 3.8),
      dueDate: todayPlus(4),
      items: [{
        productName: '礼品盒',
        quantity: '517',
        unit: '套',
        unitPrice: '3.8',
        amount: normalizeMoney(517 * 3.8),
        dueDate: todayPlus(4)
      }]
    }, fields);
  }
  if (testCase.id.includes('multi') || testCase.input.includes('饭盒')) {
    return Object.assign({
      customerName: '王总',
      productName: '礼品盒',
      quantity: '517',
      unit: '套',
      unitPrice: '3.8',
      amount: normalizeMoney(517 * 3.8 + 319 * 8.5),
      dueDate: todayPlus(4),
      items: [
        {
          productName: '礼品盒',
          quantity: '517',
          unit: '套',
          unitPrice: '3.8',
          amount: normalizeMoney(517 * 3.8),
          dueDate: todayPlus(4)
        },
        {
          productName: '饭盒',
          quantity: '319',
          unit: '个',
          unitPrice: '8.5',
          amount: normalizeMoney(319 * 8.5),
          dueDate: todayPlus(4)
        }
      ]
    }, fields);
  }
  return Object.assign({
    customerName: '王总',
    productName: '水杯',
    quantity: '100',
    unit: '个',
    unitPrice: '5.5',
    amount: '550',
    dueDate: todayPlus(4),
    items: [{
      productName: '水杯',
      quantity: '100',
      unit: '个',
      unitPrice: '5.5',
      amount: '550',
      dueDate: todayPlus(4)
    }]
  }, fields);
}

function buildHybridStub(testCase) {
  const scenario = testCase.aiScenario || '';
  // 非真机门禁不允许把“没有连上 AI”当成已整理成功。
  // 对普通用例，若本地正确判断需要 AI，就用本地草稿作为受控的“AI 已返回”联调结果；
  // failed / timeout / skipped 等场景仍显式走失败分支，专门验证不能误存。
  if (!scenario && testCase.expect && testCase.expect.allowFormalSave === false) return null;
  if (!scenario || scenario === 'real') {
    return async function defaultHybridStub(payload) {
      const localResult = await realParseHybridInput(payload);
      const route = (localResult.parse_route || {}).decision;
      if (!['ai_standard', 'ai_deep'].includes(route)) return localResult;
      return normalizeAiResult(localResult, {
        provider: 'server',
        intent: localResult.intent || 'unknown',
        fields: localResult.fields || {},
        missing_fields: localResult.missing_fields || [],
        low_confidence_fields: localResult.low_confidence_fields || [],
        field_conflicts: localResult.field_conflicts || []
      });
    };
  }

  return async function hybridStub(payload) {
    const localResult = await realParseHybridInput(payload);
    if (scenario === 'failed' || scenario === 'timeout' || scenario === 'skipped_no_endpoint' || scenario === 'not_requested') {
      const status = scenario === 'timeout' ? 'timed_out' : scenario;
      return Object.assign({}, localResult, {
        ai_fallback: Object.assign({}, localResult.ai_fallback || {}, {
          needed: scenario !== 'not_requested',
          status,
          attempted: !['not_requested', 'skipped_no_endpoint'].includes(scenario),
          business_result_valid: false
        })
      });
    }

    const provider = scenario === 'mock_used' ? 'mock' : 'server';
    const aiResult = {
      provider,
      intent: testCase.aiIntent || testCase.expect.intent || localResult.intent || 'order',
      fields: scenario === 'used_local' ? localResult.fields : defaultAiFieldsForCase(testCase),
      missing_fields: testCase.aiMissingFields || [],
      low_confidence_fields: testCase.aiLowConfidenceFields || [],
      field_conflicts: testCase.aiFieldConflicts || [],
      intent_candidates: [testCase.aiIntent || testCase.expect.intent || localResult.intent || 'order']
    };
    return normalizeAiResult(localResult, aiResult);
  };
}

function assertIncludes(haystack, needle, message, failures) {
  if (!String(haystack || '').includes(needle)) failures.push(message);
}

function assertNotIncludes(haystack, needle, message, failures) {
  if (String(haystack || '').includes(needle)) failures.push(message);
}

function evaluateExpectations(testCase, entry, evidence) {
  const failures = [];
  const expect = Object.assign({}, testCase.expect || {}, ((testCase.expectByEntry || {})[entry] || {}));
  const fields = evidence.finalFields || {};
  const parseResult = evidence.parseResult || {};
  const items = getItems(fields);
  const warning = evidence.warningText || '';
  const formalDeltas = evidence.saveDelta || {};
  const formalSaved = formalDeltaTotal(formalDeltas) > 0;

  if (expect.intent && parseResult.intent !== expect.intent) {
    failures.push(`intent expected ${expect.intent}, got ${parseResult.intent || ''}`);
  }
  if (expect.customerName && fields.customerName !== expect.customerName) {
    failures.push(`customerName expected ${expect.customerName}, got ${fields.customerName || ''}`);
  }
  if (expect.customerIncludes && !String(fields.customerName || '').includes(expect.customerIncludes)) {
    failures.push(`customerName should include ${expect.customerIncludes}, got ${fields.customerName || ''}`);
  }
  (expect.customerNotIn || []).forEach((value) => {
    if (fields.customerName === value) failures.push(`customerName must not be ${value}`);
  });
  if (expect.productIncludes && !items.some((item) => String(item.productName || '').includes(expect.productIncludes))) {
    failures.push(`items should include product ${expect.productIncludes}, got ${items.map((item) => item.productName).join('|')}`);
  }
  (expect.productNotIncludes || []).forEach((value) => {
    if (items.some((item) => String(item.productName || '').includes(value))) {
      failures.push(`productName must not include ${value}`);
    }
  });
  if (expect.itemsMin !== undefined && items.length < expect.itemsMin) {
    failures.push(`items length expected >= ${expect.itemsMin}, got ${items.length}`);
  }
  (expect.missingNotIncludes || []).forEach((field) => {
    if ((parseResult.missing_fields || []).includes(field)) failures.push(`missing_fields must not include ${field}`);
  });
  (expect.lowNotIncludes || []).forEach((field) => {
    if ((parseResult.low_confidence_fields || []).includes(field)) failures.push(`low_confidence_fields must not include ${field}`);
  });
  (expect.missingIncludes || []).forEach((field) => {
    if (!(parseResult.missing_fields || []).includes(field)) failures.push(`missing_fields should include ${field}`);
  });
  (expect.lowIncludes || []).forEach((field) => {
    if (!(parseResult.low_confidence_fields || []).includes(field)) failures.push(`low_confidence_fields should include ${field}`);
  });
  if (expect.allowFormalSave !== undefined) {
    const actualAllow = !evidence.buttonDisabled;
    if (actualAllow !== expect.allowFormalSave) {
      failures.push(`button allow expected ${expect.allowFormalSave}, got ${actualAllow}`);
    }
    if (expect.allowFormalSave && !formalSaved) {
      failures.push(`formal save should create a formal record, delta=${JSON.stringify(formalDeltas)}`);
    }
    if (!expect.allowFormalSave && formalSaved) {
      failures.push(`blocked case created formal records, delta=${JSON.stringify(formalDeltas)}`);
    }
  }
  if (expect.recordType && evidence.savedRecordType !== expect.recordType) {
    failures.push(`saved record type expected ${expect.recordType}, got ${evidence.savedRecordType || ''}`);
  }
  if (expect.formalDeltaKey && (formalDeltas[expect.formalDeltaKey] || 0) < 1) {
    failures.push(`${expect.formalDeltaKey} should increase, delta=${JSON.stringify(formalDeltas)}`);
  }
  if (expect.pendingAfterPending && (evidence.pendingDeltaAfterPending || 0) !== 1) {
    failures.push(`pending action should add exactly one pending note, got ${evidence.pendingDeltaAfterPending}`);
  }
  if (expect.noPendingOnSave && (formalDeltas.pendingNotes || 0) !== 0) {
    failures.push(`formal save attempt should not create pending note, delta=${JSON.stringify(formalDeltas)}`);
  }
  if (expect.originalIncludes) {
    const preservedText = [
      evidence.savedOriginalText,
      evidence.pendingOriginalText,
      parseResult.original_text
    ].filter(Boolean).join('\n');
    assertIncludes(preservedText, expect.originalIncludes, `original text should include ${expect.originalIncludes}`, failures);
  }
  (expect.warningIncludes || []).forEach((value) => {
    assertIncludes(warning, value, `warning should include ${value}, got ${warning}`, failures);
  });
  (expect.warningNotIncludes || []).forEach((value) => {
    assertNotIncludes(warning, value, `warning should not include ${value}, got ${warning}`, failures);
  });
  if (expect.aiStatus && evidence.aiStatus !== expect.aiStatus) {
    failures.push(`ai status expected ${expect.aiStatus}, got ${evidence.aiStatus}`);
  }
  if (expect.reloadKeepsRecord && !evidence.reloadRecordFound) {
    failures.push('saved record was not found after re-entry');
  }
  if (expect.doubleClickNoDuplicate && evidence.doubleClickFormalDelta > 1) {
    failures.push(`double click created duplicate formal records, delta=${evidence.doubleClickFormalDelta}`);
  }
  if (expect.requireFullInput && !evidence.showContinueInput) {
    failures.push('should guide this record to the complete input page before saving');
  }

  return failures.map((message) => `${ENTRY_CONFIG[entry].label}: ${message}`);
}

function evidenceSummary(evidence) {
  const fields = evidence.finalFields || {};
  const parseResult = evidence.parseResult || {};
  return {
    rawText: evidence.rawText,
    localCustomerName: evidence.localFields.customerName || '',
    localItems: getItems(evidence.localFields).map((item) => item.productName || '').join('|'),
    intent: parseResult.intent || '',
    recordType: evidence.savedRecordType || '',
    aiStatus: evidence.aiStatus || '',
    finalCustomerName: fields.customerName || '',
    finalItems: getItems(fields),
    missingFields: parseResult.missing_fields || [],
    lowConfidenceFields: parseResult.low_confidence_fields || [],
    fieldConflicts: parseResult.field_conflicts || [],
    buttonDisabled: evidence.buttonDisabled,
    warningText: evidence.warningText || '',
    saveDelta: evidence.saveDelta,
    pendingDeltaAfterPending: evidence.pendingDeltaAfterPending,
    savedOriginalText: evidence.savedOriginalText || '',
    pendingOriginalText: evidence.pendingOriginalText || ''
  };
}

async function runOneFlow(testCase, entry, options = {}) {
  const initialState = typeof testCase.initialState === 'function'
    ? testCase.initialState()
    : buildBaseState(testCase.initialState || {});
  const harness = createWxHarness({
    initialState,
    apiBaseUrl: options.liveAi ? options.apiBaseUrl : '',
    clipboardText: testCase.source === 'paste' ? testCase.input : '',
    requestHandler: options.requestHandler || null
  });
  installGlobals(harness, options.liveAi ? options.apiBaseUrl : '');
  const hybridStub = options.liveAi ? null : buildHybridStub(testCase);
  const page = loadPage(entry, harness, hybridStub, options.liveAi ? options.apiBaseUrl : '');
  if (typeof page.onLoad === 'function') page.onLoad({});
  if (typeof page.onShow === 'function') page.onShow();

  const localParser = buildLocalParserEvidence(testCase, initialState);
  const beforeCounts = getCounts(harness.getState());
  runPageParse(entry, page, testCase);
  await waitForParseCompletion(page, options);

  for (const edit of (testCase.edits || [])) {
    runEdit(entry, page, edit);
    await flushAsync();
  }

  const parseResult = getParseResultFromPage(page) || {};
  const finalFields = clone(getFieldsFromPage(page));
  const buttonDisabled = getButtonDisabled(entry, page);
  // 必须在点击“打开完整记一笔”或“存待整理”之前取证；这些动作会关闭
  // 首页确认卡。旧脚本在动作之后读取，曾把“已经正确提示过”误报成没提示。
  const showContinueInputBeforeAction = Boolean(page.data.showContinueInput);
  const entryExpect = Object.assign({}, testCase.expect || {}, ((testCase.expectByEntry || {})[entry] || {}));
  if (entryExpect.requireFullInput && typeof page.continueInput === 'function') {
    page.continueInput();
    await flushAsync();
  }
  const saveMethod = ENTRY_CONFIG[entry].saveMethod;
  const beforeSaveCounts = getCounts(harness.getState());
  const beforeSaveFormalIds = getFormalRecordIds(harness.getState());
  if (typeof page[saveMethod] === 'function') {
    page[saveMethod]();
    await flushAsync();
  }
  if (testCase.doubleClick && typeof page[saveMethod] === 'function') {
    const afterFirstSaveCounts = getCounts(harness.getState());
    page[saveMethod]();
    await flushAsync();
    testCase.__doubleClickDelta = formalDeltaTotal(diffCounts(afterFirstSaveCounts, getCounts(harness.getState())));
  }

  const afterSaveState = harness.getState();
  const afterSaveCounts = getCounts(afterSaveState);
  const saveDelta = diffCounts(beforeSaveCounts, afterSaveCounts);
  const latestFormal = getLatestFormalRecord(afterSaveState, saveDelta, beforeSaveFormalIds);

  let pendingDeltaAfterPending = 0;
  let pendingOriginalText = '';
  if (testCase.expect && testCase.expect.pendingAfterPending) {
    const beforePendingCounts = getCounts(harness.getState());
    const pendingMethod = ENTRY_CONFIG[entry].pendingMethod;
    if (typeof page[pendingMethod] === 'function') {
      page[pendingMethod]();
      await flushAsync();
    }
    const afterPendingState = harness.getState();
    pendingDeltaAfterPending = (getCounts(afterPendingState).pendingNotes || 0) - (beforePendingCounts.pendingNotes || 0);
    pendingOriginalText = ((afterPendingState.pendingNotes || [])[0] || {}).originalText || '';
  }

  const reloadedPage = loadPage(entry, harness, hybridStub, options.liveAi ? options.apiBaseUrl : '');
  if (typeof reloadedPage.onLoad === 'function') reloadedPage.onLoad({});
  if (typeof reloadedPage.onShow === 'function') reloadedPage.onShow();
  const reloadState = harness.getState();
  const savedOriginalText = latestFormal.record
    ? (latestFormal.record.originalText || latestFormal.record.remark || '')
    : '';
  const reloadRecordFound = latestFormal.record
    ? Object.values(reloadState)
      .filter(Array.isArray)
      .some((records) => records.some((record) => record && record.id === latestFormal.record.id))
    : false;

  const evidence = {
    id: testCase.id,
    title: testCase.title,
    entry,
    rawText: testCase.input,
    source: testCase.source || 'typed',
    localFields: clone(localParser.fields || {}),
    localSafetyCode: localParser.local_parse_safety && localParser.local_parse_safety.status,
    parseResult: clone(parseResult),
    finalFields,
    aiStatus: parseResult.ai_fallback && parseResult.ai_fallback.status,
    aiFailureCode: (parseResult.ai_fallback && parseResult.ai_fallback.code) || '',
    aiBusinessResultValid: Boolean(parseResult.ai_fallback && parseResult.ai_fallback.business_result_valid),
    aiProvider: parseResult.provider || '',
    hybridStubInjected: Boolean(hybridStub),
    buttonDisabled,
    showContinueInput: showContinueInputBeforeAction,
    warningText: getWarningText(entry, page, harness.events),
    beforeCounts,
    saveDelta,
    savedRecordType: latestFormal.type,
    savedOriginalText,
    pendingDeltaAfterPending,
    pendingOriginalText,
    reloadRecordFound,
    doubleClickFormalDelta: testCase.__doubleClickDelta || 0,
    requestCount: harness.events.requests.length
  };
  evidence.allowEntryDifference = Boolean(testCase.allowEntryDifference);
  evidence.failures = evaluateExpectations(testCase, entry, evidence);
  return evidence;
}

function createOrderCase(id, input, customerName, productName, options = {}) {
  return Object.assign({
    id,
    title: options.title || input,
    input,
    source: options.source || 'typed',
    entries: options.entries || ['input', 'dashboard'],
    allowEntryDifference: Boolean(options.allowEntryDifference),
    expectByEntry: options.expectByEntry || {},
    expect: Object.assign({
      intent: 'order',
      customerName,
      productIncludes: productName,
      allowFormalSave: true,
      recordType: 'order',
      formalDeltaKey: 'orders',
      noPendingOnSave: true,
      originalIncludes: input.slice(0, Math.min(8, input.length)),
      reloadKeepsRecord: true,
      missingNotIncludes: ['phone'],
      warningNotIncludes: ['手机号', '电话']
    }, options.expect || {})
  }, options.extra || {});
}

function createBlockedCase(id, input, options = {}) {
  return Object.assign({
    id,
    title: options.title || input,
    input,
    source: options.source || 'typed',
    entries: options.entries || ['input', 'dashboard'],
    allowEntryDifference: Boolean(options.allowEntryDifference),
    expectByEntry: options.expectByEntry || {},
    expect: Object.assign({
      allowFormalSave: false,
      noPendingOnSave: true,
      pendingAfterPending: true,
      originalIncludes: input.slice(0, Math.min(8, input.length))
    }, options.expect || {})
  }, options.extra || {});
}

function buildHardGateCases() {
  const manual = [
    createBlockedCase('boss-yuan-no-customer', '下单礼品盒517套3.8元下周五交', {
      title: '不能把“元”当客户正式保存',
      expect: {
        intent: 'order',
        customerNotIn: ['元'],
        productIncludes: '礼品盒',
        warningNotIncludes: ['手机号', '电话', '元（', '元 ·']
      }
    }),
    createBlockedCase('boss-yuan-ai-failed', '下单礼品盒517套3.8元下周五交', {
      title: 'NEEDS_AI + failed 必须安全阻断',
      extra: { aiScenario: 'failed' },
      expect: {
        customerNotIn: ['元'],
        productIncludes: '礼品盒',
        warningNotIncludes: ['手机号', '电话']
      }
    }),
    createBlockedCase('boss-yuan-ai-skipped', '下单礼品盒517套3.8元下周五交', {
      title: 'NEEDS_AI + skipped_no_endpoint 必须安全阻断',
      extra: { aiScenario: 'skipped_no_endpoint' },
      expect: {
        customerNotIn: ['元'],
        productIncludes: '礼品盒',
        warningNotIncludes: ['手机号', '电话']
      }
    }),
    createOrderCase(
      'boss-multi-wang-local',
      '王总下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；下周五交。',
      '王总',
      '礼品盒',
      {
        title: '多商品订单必须先完成深度核对，首页不允许只保存第一件',
        allowEntryDifference: true,
        expect: {
          itemsMin: 2,
          lowNotIncludes: ['customerName'],
          missingNotIncludes: ['phone'],
          allowFormalSave: false,
          recordType: '',
          formalDeltaKey: '',
          reloadKeepsRecord: false,
          pendingAfterPending: true
        },
        expectByEntry: {
          dashboard: { allowFormalSave: false, recordType: '', formalDeltaKey: '', reloadKeepsRecord: false, pendingAfterPending: false, requireFullInput: true }
        }
      }
    ),
    createOrderCase(
      'boss-multi-wang-ai-stale-low',
      '王总下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；下周五交。',
      '王总',
      '礼品盒',
      {
        title: 'AI used 后王总不能被旧低置信误拦；多商品仍去完整页确认',
        extra: { aiScenario: 'used', aiLowConfidenceFields: ['customerName'] },
        allowEntryDifference: true,
        expect: {
          itemsMin: 2,
          lowNotIncludes: ['customerName'],
          missingNotIncludes: ['phone'],
          allowFormalSave: false,
          recordType: '',
          formalDeltaKey: '',
          reloadKeepsRecord: false,
          pendingAfterPending: true
        },
        expectByEntry: {
          dashboard: { allowFormalSave: false, recordType: '', formalDeltaKey: '', reloadKeepsRecord: false, pendingAfterPending: false, requireFullInput: true }
        }
      }
    ),
    createOrderCase(
      'boss-multi-wang-ai-missing-phone',
      '王总下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；下周五交。',
      '王总',
      '礼品盒',
      {
        title: '手机号为空不能阻断清楚多商品订单',
        extra: { aiScenario: 'used', aiMissingFields: ['phone'] },
        allowEntryDifference: true,
        expect: {
          itemsMin: 2,
          missingNotIncludes: ['phone'],
          warningNotIncludes: ['手机号', '电话'],
          allowFormalSave: false,
          recordType: '',
          formalDeltaKey: '',
          reloadKeepsRecord: false,
          pendingAfterPending: true
        },
        expectByEntry: {
          dashboard: { allowFormalSave: false, recordType: '', formalDeltaKey: '', reloadKeepsRecord: false, pendingAfterPending: false, requireFullInput: true }
        }
      }
    ),
    createBlockedCase('ai-used-invalid-yuan', '下单礼品盒517套3.8元下周五交', {
      title: 'AI used 返回“元”也必须二次安全拦截',
      extra: { aiScenario: 'used' },
      expect: {
        intent: 'order',
        customerNotIn: ['元'],
        productIncludes: '礼品盒'
      }
    }),
    createBlockedCase('ai-mock-used-not-trusted', '下单礼品盒517套3.8元下周五交', {
      title: 'mock_used 不能当成真实可信 AI 结果',
      extra: { aiScenario: 'mock_used' },
      expect: {
        aiStatus: 'mock_used',
        customerNotIn: ['元']
      }
    }),
    createBlockedCase('ai-timeout-invalid-yuan', '下单礼品盒517套3.8元下周五交', {
      title: 'AI timeout 时不能保存高风险本地猜测',
      extra: { aiScenario: 'timeout' },
      expect: { aiStatus: 'timed_out', customerNotIn: ['元'] }
    }),
    createOrderCase('single-clear-order', '王总订水杯100个，5.5一个，下周五交', '王总', '水杯'),
    createOrderCase('single-clear-order-no-phone', '李老板订包装袋300个，0.9一个，月底交', '李老板', '包装袋'),
    createOrderCase('valid-chenjie', '陈姐下单钥匙扣800个，1.2元一个，周三交', '陈姐', '钥匙扣'),
    createOrderCase('valid-laowang', '老王要拖鞋500双，2.8一双，三天后交', '老王', '拖鞋'),
    createOrderCase('valid-zhangzong', '张总下单杯子500个5元，下周五交', '张总', '杯子'),
    createOrderCase('clear-multi-two-dates', '张总下单杯子500个5元周三交，饭盒300个8元周五交', '张总', '杯子', {
      allowEntryDifference: true,
      expect: {
        itemsMin: 2,
        productNotIncludes: ['周三交', '周五交'],
        allowFormalSave: false,
        recordType: '',
        formalDeltaKey: '',
        reloadKeepsRecord: false,
        pendingAfterPending: true
      },
      expectByEntry: {
        dashboard: { allowFormalSave: false, recordType: '', formalDeltaKey: '', reloadKeepsRecord: false, pendingAfterPending: false, requireFullInput: true }
      }
    }),
    createBlockedCase('missing-customer', '礼品盒500套3.8元下周五交', {
      expect: { productIncludes: '礼品盒', customerNotIn: ['元', '套'] }
    }),
    createBlockedCase('missing-quantity', '王总订水杯，5.5一个，下周五交', {
      title: '订单缺数量时不能正式保存，也不能虚构数量',
      expect: { intent: 'order', customerName: '王总', productIncludes: '水杯', missingIncludes: ['quantity'] }
    }),
    createBlockedCase('missing-price', '王总订水杯100个，下周五交', {
      title: '订单缺单价时不能正式保存，也不能虚构单价',
      expect: { intent: 'order', customerName: '王总', productIncludes: '水杯', missingIncludes: ['unitPrice'] }
    }),
    createBlockedCase('missing-price-and-date', '李老板订水杯100个', {
      title: '订单缺单价和交期时不能正式保存',
      expect: { intent: 'order', customerName: '李老板', productIncludes: '水杯', missingIncludes: ['unitPrice', 'dueDate'] }
    }),
    createBlockedCase('missing-date', '王总订水杯100个，5.5一个', {
      title: '订单交期没说时不得猜日期，也不能正式保存',
      expect: { intent: 'order', customerName: '王总', productIncludes: '水杯', missingIncludes: ['dueDate'] }
    }),
    createBlockedCase('only-total-price', '王总礼品盒一批总价1964.6元，下周五交', {
      title: '只有总价但缺单价时先确认，不能伪造单价',
      expect: { intent: 'order', customerName: '王总', productIncludes: '礼品盒', missingIncludes: ['unitPrice'] }
    }),
    createBlockedCase('invalid-customer-kehu', '客户下单水杯100个5.5元下周五交', {
      expect: { customerNotIn: ['客户'] }
    }),
    createBlockedCase('invalid-customer-today', '今天下单水杯100个5.5元下周五交', {
      expect: { customerNotIn: ['今天'] }
    }),
    createBlockedCase('invalid-customer-unit', '个下单水杯100个5.5元下周五交', {
      expect: { customerNotIn: ['个'] }
    }),
    createOrderCase('quotation-clear', '给王总报礼品盒500套，3.8元一套', '王总', '礼品盒', {
      expect: {
        intent: 'quotation',
        recordType: 'quotation',
        formalDeltaKey: 'quotations'
      }
    }),
    createBlockedCase('quotation-missing-customer', '报礼品盒500套，3.8元一套', {
      expect: { intent: 'quotation', productIncludes: '礼品盒' }
    }),
    createOrderCase('existing-quotation-order', '王总确认礼品盒500套，3.8元一套，下周五交，正式下单', '王总', '礼品盒', {
      extra: { initialState: () => buildStateWithQuotation('王总') },
      expect: {
        intent: 'order',
        recordType: 'order',
        formalDeltaKey: 'orders',
        noPendingOnSave: true
      }
    }),
    createBlockedCase('receivable-clear', '王总还欠礼品盒尾款1964.6元，月底结', {
      expect: {
        intent: 'receivable',
        customerName: '王总',
        productIncludes: '',
        pendingAfterPending: true
      }
    }),
    createBlockedCase('payment-with-receivable', '王总今天付了2000元', {
      extra: { initialState: () => buildStateWithReceivable('王总', 5000) },
      expect: {
        intent: 'payment',
        customerName: '王总',
        pendingAfterPending: false
      },
      expectByEntry: {
        input: { lowIncludes: ['receivableId'] },
        dashboard: { requireFullInput: true }
      }
    }),
    createBlockedCase('existing-order-deposit', '王总礼品盒这单收到定金500元', {
      extra: { initialState: () => buildStateWithOrder('王总') },
      expect: {
        intent: 'payment',
        customerName: '王总',
        pendingAfterPending: false
      },
      expectByEntry: {
        input: { lowIncludes: ['orderId'] },
        dashboard: { requireFullInput: true }
      }
    }),
    createBlockedCase('payment-over-remaining', '王总今天付了6000元', {
      extra: { initialState: () => buildStateWithReceivable('王总', 5000) },
      expect: { intent: 'payment', customerName: '王总', pendingAfterPending: false },
      expectByEntry: {
        input: { lowIncludes: ['receivableId'] },
        dashboard: { requireFullInput: true }
      }
    }),
    createBlockedCase('price-change-chat-conflict', [
      '王总 09:10',
      '水杯1000个多少钱',
      '我 09:12',
      '30一个',
      '王总 09:14',
      '贵了，25一个可以吗',
      '我 09:15',
      '可以，就25一个，先做1000个，月底交'
    ].join('\n'), {
      source: 'paste',
      expect: {
        customerName: '王总',
        productIncludes: '水杯',
        originalIncludes: '30一个'
      }
    }),
    createBlockedCase('no-business-chat', [
      '王总 09:10',
      '今天在吗',
      '我 09:11',
      '在的',
      '王总 09:12',
      '晚点说'
    ].join('\n'), {
      source: 'paste',
      expect: {
        pendingAfterPending: true,
        originalIncludes: '今天在吗'
      }
    }),
    createOrderCase('voice-transcribed-order', '周姐订纸袋2000个，1.2一个，下周一交', '周姐', '纸袋', {
      title: '语音已转成清楚文字后，与手打文字使用同一套事实检查',
      source: 'voice',
      expect: { customerName: '周姐', productIncludes: '纸袋' }
    }),
    createOrderCase('manual-fix-invalid-customer', '下单礼品盒517套3.8元下周五交', '王总', '礼品盒', {
      title: '被拦截后手动补客户应重新检查并允许',
      extra: { edits: [{ field: 'customerName', value: '王总' }] }
    }),
    createOrderCase('manual-fix-product', '王总周三交500个5元', '王总', '水杯', {
      title: '被拦截后手动修商品应重新检查',
      entries: ['input'],
      extra: { edits: [{ itemIndex: 0, field: 'productName', value: '水杯' }] },
      expect: {
        customerName: '王总',
        productIncludes: '水杯',
        lowNotIncludes: ['productName']
      }
    }),
    createOrderCase('double-click-no-duplicate', '王总订水杯100个，5.5一个，下周五交', '王总', '水杯', {
      title: '连续点击不能重复生成正式记录',
      extra: { doubleClick: true },
      expect: { doubleClickNoDuplicate: true }
    }),
    createBlockedCase('paste-clear-order', [
      '李老板 10:01',
      '礼品盒500套给我按3.8做',
      '我 10:02',
      '好的，下周五交',
      '李老板 10:03',
      '可以，就这样下单'
    ].join('\n'), {
      title: '业务聊天没有可用 AI 结果时不能直接正式保存',
      source: 'paste',
      expect: { intent: 'order', customerName: '李老板', productIncludes: '礼品盒', itemsMin: 1, originalIncludes: '礼品盒500套' }
    })
  ];

  const customers = ['王总', '李老板', '陈姐', '张总', '周姐', '刘老板', '老王', '赵总', '孙总', '吴总', '钱总', '郑老板', '黄姐', '许总', '马总', '丁老板'];
  const products = ['礼品盒', '水杯', '饭盒', '包装袋', '钥匙扣', '拖鞋', '挂件', '卡通杯', '纸袋', '勺子', '玩具车', '手提袋', '发夹', '杯垫', '笔袋', '收纳盒'];
  const units = ['套', '个', '个', '个', '个', '双', '个', '个', '个', '把', '个', '个', '个', '个', '个', '个'];
  const prices = ['3.8', '5.5', '8.5', '0.9', '1.2', '2.8', '1.5', '6', '0.6', '0.35', '4.2', '1.1', '0.8', '0.5', '2.3', '7.6'];
  const dates = ['下周五交', '月底交', '周三交', '明天交', '三天后交', '下周一交', '周六交', '下个月5号交', '后天交', '周四交', '月底前交', '下周三交', '明早交', '五天后交', '本周五交', '月底出货'];
  const generated = customers.map((customer, index) => createOrderCase(
    `generated-clear-order-${index + 1}`,
    `${customer}下单${products[index]}${(index + 1) * 100}${units[index]}，${prices[index]}元一个，${dates[index]}`,
    customer,
    products[index]
  ));

  const cases = manual.concat(generated);
  if (cases.length < 50) {
    throw new Error(`hard gate cases should be at least 50, got ${cases.length}`);
  }
  return cases.slice(0, 50);
}

function buildExtendedCases() {
  const customers = ['王总', '李老板', '陈姐', '张总', '周姐', '刘老板', '老王', '赵总', '孙总', '吴总'];
  const products = ['礼品盒', '水杯', '饭盒', '包装袋', '钥匙扣', '拖鞋', '挂件', '卡通杯', '纸袋', '勺子'];
  const units = ['套', '个', '个', '个', '个', '双', '个', '个', '个', '把'];
  const quantities = [100, 300, 500, 800, 1000];
  const prices = [0.35, 0.9, 1.2, 3.8, 5.5, 8.5];
  const dates = ['下周五交', '月底交', '周三交', '明天交', '三天后交', '下周一交'];
  const cases = [];

  customers.forEach((customer, customerIndex) => {
    products.forEach((product, productIndex) => {
      const quantity = quantities[(customerIndex + productIndex) % quantities.length];
      const price = prices[(customerIndex + productIndex) % prices.length];
      const unit = units[productIndex];
      const date = dates[(customerIndex + productIndex) % dates.length];
      if (cases.length < 60) {
        cases.push(createOrderCase(
          `extended-typed-order-${cases.length + 1}`,
          `${customer}下单${product}${quantity}${unit}，${price}元一个，${date}`,
          customer,
          product
        ));
      }
      if (cases.length < 100) {
        cases.push(createOrderCase(
          `extended-quote-${cases.length + 1}`,
          `给${customer}报${product}${quantity}${unit}，${price}元一个`,
          customer,
          product,
          {
            expect: {
              intent: 'quotation',
              recordType: 'quotation',
              formalDeltaKey: 'quotations'
            }
          }
        ));
      }
      if (cases.length < 135) {
        cases.push(createOrderCase(
          `extended-missing-${cases.length + 1}`,
          `${customer}要${product}${quantity}${unit}，${date}`,
          customer,
          product,
          {
            title: '缺单价订单只能先存待整理，不能生成正式订单',
            expect: {
              missingIncludes: ['unitPrice'],
              allowFormalSave: false,
              recordType: '',
              formalDeltaKey: '',
              reloadKeepsRecord: false,
              pendingAfterPending: true,
              originalIncludes: product
            }
          }
        ));
      }
      if (cases.length < 165) {
        const input = `${customer}还欠${product}尾款${quantity * price}元，月底结`;
        cases.push({
          id: `extended-receivable-${cases.length + 1}`,
          title: '待收款记录不强制要求商品名',
          input,
          source: 'typed',
          entries: ['input', 'dashboard'],
          expect: {
            customerName: customer,
            intent: 'receivable',
            recordType: '',
            formalDeltaKey: '',
            allowFormalSave: false,
            noPendingOnSave: true,
            pendingAfterPending: true,
            originalIncludes: customer,
            reloadKeepsRecord: false,
            missingNotIncludes: ['phone'],
            warningNotIncludes: ['手机号', '电话']
          }
        });
      }
      if (cases.length < 200) {
        const input = [
          `${customer} 09:10`,
          `${product}${quantity}${unit}多少钱`,
          `我 09:12`,
          `${price}一个`,
          `${customer} 09:15`,
          `可以，先做${quantity}${unit}，${date}`
        ].join('\n');
        cases.push(createOrderCase(
          `extended-paste-chat-${cases.length + 1}`,
          input,
          customer,
          product,
          {
            source: 'paste',
            extra: { aiScenario: 'used_local' },
            expect: {
              intent: 'order',
              recordType: '',
              formalDeltaKey: '',
              allowFormalSave: false,
              originalIncludes: product,
              noPendingOnSave: true,
              pendingAfterPending: true,
              reloadKeepsRecord: false,
              missingNotIncludes: ['phone'],
              warningNotIncludes: ['手机号', '电话'],
              aiStatus: 'used'
            }
          }
        ));
      }
    });
  });

  return cases.slice(0, 200);
}

function buildSentenceMatrixCases() {
  const customers = ['王总', '李老板', '陈姐', '张总', '周姐', '刘老板', '赵总', '孙总', '吴总', '钱总'];
  const products = ['礼品盒', '水杯', '饭盒', '包装袋', '钥匙扣', '拖鞋', '挂件', '纸袋', '杯垫', '收纳盒'];
  const units = ['套', '个', '个', '个', '个', '双', '个', '个', '个', '个'];
  const quantities = [100, 300, 500, 800, 1200];
  const prices = [0.8, 1.2, 2.5, 3.8, 5.5];
  const dates = ['明天交', '后天交', '周三交', '下周一交', '月底交'];
  const orderTemplates = [
    ({ customer, product, quantity, unit, price, date }) => `${customer}下单${product}${quantity}${unit}，${price}元一个，${date}`,
    ({ customer, product, quantity, unit, price, date }) => `${customer}订${product}${quantity}${unit}，${price}一个，${date}`,
    ({ customer, product, quantity, unit, price, date }) => `${customer}要${product}${quantity}${unit}，单价${price}元，${date}`
  ];
  const quoteTemplates = [
    ({ customer, product, quantity, unit, price }) => `给${customer}报${product}${quantity}${unit}，${price}元一个`,
    ({ customer, product, quantity, unit, price }) => `${product}${quantity}${unit}报给${customer}，单价${price}元`,
    ({ customer, product, quantity, unit, price }) => `${customer}问${product}${quantity}${unit}多少钱，报${price}元一个`
  ];
  const cases = [];

  for (let index = 0; index < 1000; index += 1) {
    const customerIndex = index % customers.length;
    const productIndex = Math.floor(index / customers.length) % products.length;
    const quantityIndex = Math.floor(index / (customers.length * products.length)) % quantities.length;
    const priceIndex = Math.floor(index / (customers.length * products.length * quantities.length)) % prices.length;
    const dateIndex = (index + customerIndex + productIndex) % dates.length;
    const values = {
      customer: customers[customerIndex],
      product: products[productIndex],
      quantity: quantities[quantityIndex],
      unit: units[productIndex],
      price: prices[priceIndex],
      date: dates[dateIndex]
    };
    const templateIndex = Math.floor(index / 100) % orderTemplates.length;
    const isQuotation = index % 4 === 3;
    const input = isQuotation
      ? quoteTemplates[templateIndex](values)
      : orderTemplates[templateIndex](values);
    cases.push(createOrderCase(
      `matrix-${index + 1}`,
      input,
      values.customer,
      values.product,
      isQuotation ? {
        expect: {
          intent: 'quotation',
          recordType: 'quotation',
          formalDeltaKey: 'quotations'
        }
      } : {}
    ));
  }
  return cases;
}

function buildLiveAiCases() {
  return buildHardGateCases()
    .filter((item) => !item.aiScenario)
    .slice(0, 30)
    .map((item) => Object.assign({}, item, {
      id: `live-${item.id}`,
      aiScenario: 'real'
    }));
}

function parseArgs(argv) {
  const options = {
    suite: 'gate',
    entries: ['input', 'dashboard'],
    verbose: false,
    quiet: false,
    liveAi: false,
    apiBaseUrl: process.env.HUOXIAOLING_API_BASE_URL || ''
  };
  argv.forEach((arg) => {
    if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length);
    if (arg.startsWith('--entry=')) options.entries = arg.slice('--entry='.length).split(',').filter(Boolean);
    if (arg === '--verbose') options.verbose = true;
    if (arg === '--quiet') options.quiet = true;
    if (arg === '--live-ai') options.liveAi = true;
    if (arg.startsWith('--api-base-url=')) options.apiBaseUrl = arg.slice('--api-base-url='.length).replace(/\/$/, '');
  });
  return options;
}

function selectCases(options) {
  if (options.suite === 'gate') return buildHardGateCases();
  if (options.suite === 'extended') return buildExtendedCases();
  if (options.suite === 'matrix') return buildSentenceMatrixCases();
  if (options.suite === 'all') return buildHardGateCases().concat(buildExtendedCases()).concat(buildSentenceMatrixCases());
  if (options.suite === 'live') return buildLiveAiCases();
  throw new Error(`Unknown suite: ${options.suite}`);
}

function printEvidence(result, verbose) {
  if (result.quiet) return;
  if (!verbose && !result.failures.length) return;
  const status = result.failures.length ? 'FAIL' : 'PASS';
  const summary = evidenceSummary(result);
  console.log(`\n[${status}] ${result.id} / ${ENTRY_CONFIG[result.entry].label}`);
  console.log(JSON.stringify(summary, null, 2));
  if (result.failures.length) {
    result.failures.forEach((failure) => console.log(`  - ${failure}`));
  }
}

function checkEntryConsistency(results) {
  const failures = [];
  const byCase = new Map();
  results.forEach((result) => {
    if (!byCase.has(result.id)) byCase.set(result.id, []);
    byCase.get(result.id).push(result);
  });
  byCase.forEach((items, id) => {
    const input = items.find((item) => item.entry === 'input');
    const dashboard = items.find((item) => item.entry === 'dashboard');
    if (!input || !dashboard) return;
    if (!input.allowEntryDifference && !dashboard.allowEntryDifference && input.buttonDisabled !== dashboard.buttonDisabled) {
      failures.push(`${id}: 完整记一笔与首页快记按钮结论不一致 input=${!input.buttonDisabled}, dashboard=${!dashboard.buttonDisabled}`);
    }
    const inputIntent = input.parseResult && input.parseResult.intent;
    const dashboardIntent = dashboard.parseResult && dashboard.parseResult.intent;
    if (inputIntent !== dashboardIntent) {
      failures.push(`${id}: 完整记一笔与首页快记 intent 不一致 input=${inputIntent}, dashboard=${dashboardIntent}`);
    }
  });
  return failures;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.suite === 'live' || options.liveAi) {
    options.liveAi = true;
    if (!options.apiBaseUrl) {
      console.log('[SKIP] 真实 AI 联调需要设置 HUOXIAOLING_API_BASE_URL 或 --api-base-url=...');
      process.exit(0);
    }
  }

  const cases = selectCases(options);
  const results = [];
  console.log(`记一笔测试门禁开始：suite=${options.suite}, cases=${cases.length}, entries=${options.entries.join(',')}, liveAi=${options.liveAi}`);

  for (const testCase of cases) {
    const entries = (testCase.entries || options.entries).filter((entry) => options.entries.includes(entry));
    for (const entry of entries) {
      const result = await runOneFlow(testCase, entry, options);
      result.quiet = options.quiet;
      results.push(result);
      printEvidence(result, options.verbose);
    }
  }

  const assertionFailures = results.flatMap((result) => result.failures.map((failure) => `${result.id}: ${failure}`));
  const consistencyFailures = checkEntryConsistency(results);
  const failures = assertionFailures.concat(consistencyFailures);
  const failedEntries = results.filter((result) => result.failures.length).length;

  console.log('\n记一笔测试门禁摘要');
  console.log(`- cases: ${cases.length}`);
  console.log(`- entry runs: ${results.length}`);
  console.log(`- failed entry runs: ${failedEntries}`);
  console.log(`- consistency failures: ${consistencyFailures.length}`);
  console.log(`- total failures: ${failures.length}`);
  if (consistencyFailures.length) {
    console.log('\n入口一致性失败：');
    consistencyFailures.forEach((failure) => console.log(`  - ${failure}`));
  }
  if (failures.length) {
    const evidenceHint = options.quiet
      ? '请去掉 --quiet 查看逐案例证据'
      : '请从上面的逐案例证据修复';
    console.log(`\n结论：当前记一笔门禁未通过。${evidenceHint}，不要用总通过数掩盖关键失败。`);
    process.exit(1);
  }
  console.log('\n结论：当前记一笔门禁通过。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  buildHybridStub,
  createWxHarness,
  loadPage,
  runOneFlow
};
