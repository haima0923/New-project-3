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
  FULL_PAGE: 'pages/input/input.js',
  QUOTATION_LIST: 'pages/quotations/quotations.js'
});
const OBSERVATION_LANES = Object.freeze([
  'PAGE_PRODUCTION_OBSERVATION',
  'HEADLESS_PRODUCTION_OBSERVATION'
]);
const CASE_STATUSES = Object.freeze(['PASS', 'CASE_FAIL', 'RUNNER_ERROR', 'BLOCKED']);
const LANE_STATUSES = Object.freeze(['PASS', 'CASE_FAIL', 'RUNNER_ERROR', 'BLOCKED']);
const FAILURE_OWNERSHIPS = Object.freeze([
  'CONFIRMED_PRODUCT_DEFECT',
  'CONFIRMED_PRODUCT_CAPABILITY_GAP',
  'CONFIRMED_PRODUCT_SAFETY_MISMATCH',
  'CONFIRMED_LOCAL_PARSER_DEFECT',
  'CONFIRMED_OPERATION_MAPPING_DEFECT',
  'CONFIRMED_PARSER_DEFECT',
  'CONFIRMED_AI_NORMALIZE_DEFECT',
  'CONFIRMED_ROUTE_DEFECT',
  'CONFIRMED_CONFIRMATION_DEFECT',
  'CONFIRMED_LEGACY_BUSINESS_DEFECT',
  'CONFIRMED_STORAGE_DEFECT',
  'TEST_CONTRACT_MISMATCH_CANDIDATE',
  'FIXTURE_DATA_ERROR_CANDIDATE',
  'EXPECTED_MAPPING_MISMATCH_CANDIDATE',
  'OBSERVABILITY_EXPECTATION_MISMATCH',
  'NEEDS_PRODUCT_DECISION',
  'UNCLASSIFIED_REQUIRES_REVIEW'
]);
const OWNERSHIP_CONFIDENCES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

module.exports = {
  ALLOWED_NETWORK_PATHS,
  BUSINESS_COLLECTIONS,
  BUSINESS_STORAGE_KEY,
  CASE_STATUSES,
  CORPUS_ROOT,
  FAILURE_OWNERSHIPS,
  FORMAL_COLLECTIONS,
  LANE_STATUSES,
  OBSERVATION_LANES,
  OWNERSHIP_CONFIDENCES,
  PAGE_PATHS,
  ROOT
};
