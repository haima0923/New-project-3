const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const CORPUS_ROOT = path.join(ROOT, 'tests/record-e2e');
const BUSINESS_STORAGE_KEY = 'yiwu_boss_ai_assistant_v1';
const ALLOWED_NETWORK_PATHS = Object.freeze([
  '/api/auth/wechat-login',
  '/api/ai/parse',
  '/api/ai/parse/deep'
]);
const BUSINESS_COLLECTIONS = Object.freeze([
  'customers',
  'quotations',
  'orders',
  'receivables',
  'paymentRecords',
  'todos',
  'pendingNotes',
  'productCatalog',
  'operationLogs',
  'aiParseLogs'
]);
const FORMAL_COLLECTIONS = Object.freeze([
  'customers',
  'quotations',
  'orders',
  'receivables',
  'paymentRecords',
  'todos'
]);
const PAGE_PATHS = Object.freeze({
  HOME_QUICK: 'pages/dashboard/dashboard.js',
  FULL_PAGE: 'pages/input/input.js'
});
const OBSERVATION_LANES = Object.freeze([
  'PAGE_PRODUCTION_OBSERVATION',
  'HEADLESS_PRODUCTION_OBSERVATION'
]);
const CASE_STATUSES = Object.freeze(['PASS', 'CASE_FAIL', 'RUNNER_ERROR', 'BLOCKED']);
const LANE_STATUSES = Object.freeze(['PASS', 'CASE_FAIL', 'RUNNER_ERROR', 'BLOCKED']);

module.exports = {
  ALLOWED_NETWORK_PATHS,
  BUSINESS_COLLECTIONS,
  BUSINESS_STORAGE_KEY,
  CASE_STATUSES,
  CORPUS_ROOT,
  FORMAL_COLLECTIONS,
  LANE_STATUSES,
  OBSERVATION_LANES,
  PAGE_PATHS,
  ROOT
};
