const { createControlledNetwork } = require('./controlled-network');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE } = require('./fixtures');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');
const { createFakeWx } = require('../runner/create-fake-wx');
const { installFrozenClock } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { safeClone } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');

const STATE_KEYS = [
  'customers',
  'quotations',
  'orders',
  'receivables',
  'paymentRecords',
  'todos',
  'orderProgress',
  'pendingNotes',
  'aiParseLogs',
  'dunningRecords',
  'dunningTemplates'
];

function stateCounts(state = {}) {
  return STATE_KEYS.reduce((output, key) => {
    output[key] = Array.isArray(state[key]) ? state[key].length : 0;
    return output;
  }, {});
}

function diffCounts(before, after) {
  return STATE_KEYS.reduce((output, key) => {
    output[key] = Number(after[key] || 0) - Number(before[key] || 0);
    return output;
  }, {});
}

function createPageHarness(options = {}) {
  const restoreClock = installFrozenClock(NOW_INSTANT, options.caseId || 'record-confirm-interaction');
  const network = createControlledNetwork({
    mode: options.networkMode || 'SUCCESS',
    response: options.response || {},
    responseFactory: options.responseFactory
  });
  network.guardHostNetwork();
  const initialState = safeClone(options.initialState || createInitialState());
  const fakeWx = createFakeWx({
    clipboardText: options.text || '',
    initialEntries: {
      [BUSINESS_STORAGE_KEY]: initialState,
      huoxiaoling_ai_auth_session_v1: {
        token: 'REDACTED_CONTROLLED_TOKEN',
        expiresAt: '2027-08-05T12:00:00.000Z'
      }
    },
    network
  });
  const app = {
    globalData: {
      userId: 'contract-user',
      apiBaseUrl: 'memory://record-confirm-interaction',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse',
      aiTranscribeEndpoint: '',
      recordStorageRecoveryLocked: false,
      recordStorageStartupStatus: ''
    }
  };
  global.wx = fakeWx.wx;
  global.getApp = () => app;
  global.requirePlugin = () => null;
  const spec = {
    ai: { profile: 'CONTROLLED_REAL_FIXTURE' },
    caseId: options.caseId || 'record-confirm-interaction',
    clock: {
      businessDate: BUSINESS_DATE,
      nowInstant: NOW_INSTANT,
      timezone: TIMEZONE
    },
    input: { originalText: options.text || '' },
    initialState: { state: initialState }
  };
  const driver = loadProductionPage('FULL_PAGE', { fakeWx }, spec, { runLifecycle: false });
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    network.restoreHostNetwork();
    restoreClock();
    delete global.wx;
    delete global.getApp;
    delete global.requirePlugin;
    delete global.Page;
    delete global.App;
  }

  return {
    app,
    dispose,
    driver,
    fakeWx,
    network,
    page: driver.page,
    readState() {
      return fakeWx.getValue(BUSINESS_STORAGE_KEY) || createInitialState();
    }
  };
}

module.exports = {
  STATE_KEYS,
  createPageHarness,
  diffCounts,
  stateCounts
};
