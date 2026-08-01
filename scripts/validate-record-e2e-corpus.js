#!/usr/bin/env node

/*
 * Record E2E Corpus V1 validator.
 *
 * This script is intentionally dependency-free. It validates the repository
 * contract and cross-field semantics; it does not run parser/business code and
 * never derives expected answers from the current implementation.
 */

const fs = require('fs');
const path = require('path');
const {
  validateExecutionPlanPreconditions
} = require('../tests/record-e2e/runner/validate-plan-preconditions');
const {
  nonCanonicalExpectedFieldsForOperation
} = require('../tests/record-e2e/runner/field-aliases');

const ROOT = path.resolve(__dirname, '..');
const E2E_ROOT = path.join(ROOT, 'tests', 'record-e2e');
const CASE_ROOT = path.join(E2E_ROOT, 'cases', 'core-v1');
const SUPPLEMENTAL_CASE_ROOT = path.join(E2E_ROOT, 'cluster-cases');
const ENUM_PATH = path.join(E2E_ROOT, 'contracts', 'record-e2e-enums-v1.json');
const SCHEMA_PATH = path.join(E2E_ROOT, 'schema', 'record-e2e-case-v1.schema.json');
const STATE_FIXTURE_PATH = path.join(E2E_ROOT, 'fixtures', 'states', 'state-fixtures-v1.json');
const AI_FIXTURE_PATH = path.join(E2E_ROOT, 'fixtures', 'ai', 'ai-fixtures-v1.json');
const DECISION_PATH = path.join(E2E_ROOT, 'decisions', 'product-decision-backlog-v1.json');
const INDEX_PATH = path.join(E2E_ROOT, 'corpus-index-v1.json');

const EXPECTED_CATEGORY_COUNTS = Object.freeze({
  FORMAL_BASIC: 20,
  AMBIGUOUS_BLOCKED: 16,
  CUSTOMER_HISTORY_RELATIONS: 14,
  MULTI_ITEM: 12,
  FINANCIAL_SAFETY: 14,
  DATE_TIME: 12,
  CLIPBOARD_CHAT: 10,
  VOICE_TRANSCRIPT: 10,
  SURFACE_PAGE_EDIT: 8,
  PERSISTENCE_IDEMPOTENCY: 4
});
const EXPECTED_EXECUTION_LANE_COUNTS = Object.freeze({
  PAGE_PRODUCTION_OBSERVATION: 110,
  HEADLESS_PRODUCTION_OBSERVATION: 10,
  PAGE_CONFIRMED_DRAFT_DERIVATION: 6,
  TEST_ONLY_ISOLATED_LEGACY_COMMIT: 88,
  PAGE_DUPLICATE_TRIGGER_GUARD: 1,
  TRANSACTION_EXACT_REPLAY: 1,
  RELATION_REFERENCE_TAMPER_GUARD: 2,
  RESTART_PERSISTENCE: 5,
  CONCURRENT_BASE_REVISION: 1
});
const OBSERVATION_LANES = Object.freeze([
  'PAGE_PRODUCTION_OBSERVATION',
  'HEADLESS_PRODUCTION_OBSERVATION'
]);
const NON_REAL_AI_PROFILES = new Set(['FAKE_STANDARD', 'FAKE_DEEP', 'REPLAY']);
const ISOLATED_COMMITTED_STATUSES = new Set([
  'TEST_ONLY_ISOLATED_COMMITTED',
  'TEST_ONLY_PENDING_COMMITTED'
]);
const REQUIRED_CAPABILITY_BY_SELECTION = Object.freeze({
  customerId: 'SELECT_CUSTOMER',
  quotationId: 'SELECT_QUOTATION',
  receivableId: 'SELECT_RECEIVABLE'
});
const KNOWN_PAGE_CAPABILITY_GAPS = Object.freeze({
  'REC-E2E-BASIC-010': ['SELECT_ORDER'],
  'REC-E2E-REL-003': ['SELECT_ORDER'],
  'REC-E2E-REL-009': ['SELECT_CUSTOMER', 'SELECT_ORDER']
});
const REQUIRED_EXACT_REPLAY_IDENTITY_FIELDS = Object.freeze([
  'transactionId',
  'planId',
  'planHash',
  'idempotencyKey',
  'baseRevision',
  'targetRevision',
  'baseFingerprint',
  'targetBundleFingerprint'
]);
const FORBIDDEN_PRODUCTION_COMMIT_TERMS = /(?:FORMAL_PRODUCTION_COMMIT|PAGE_SAVE_SUCCESS|REAL_AI_COMMIT)/;
const FORBIDDEN_EXACT_REPLAY_UI_TERMS = /(?:SECOND_PAGE_SAVE|SECOND_PAGE_CLICK|DOUBLE_UI_TRIGGER|第二次页面|再次点击页面)/i;
const OBSERVATION_SEMANTICS_CASE_IDS = Object.freeze([
  'REC-E2E-BASIC-001', 'REC-E2E-BASIC-002', 'REC-E2E-BASIC-003',
  'REC-E2E-BASIC-004', 'REC-E2E-BASIC-005', 'REC-E2E-BASIC-007',
  'REC-E2E-BASIC-008', 'REC-E2E-BASIC-009', 'REC-E2E-BASIC-015',
  'REC-E2E-BASIC-016', 'REC-E2E-REL-001', 'REC-E2E-DATE-002',
  'REC-E2E-DATE-008', 'REC-E2E-PAGE-001', 'REC-E2E-PAGE-008',
  'REC-E2E-BASIC-017', 'REC-E2E-BASIC-018', 'REC-E2E-AMB-012',
  'REC-E2E-BASIC-019', 'REC-E2E-BASIC-020', 'REC-E2E-AMB-001',
  'REC-E2E-AMB-002', 'REC-E2E-AMB-008', 'REC-E2E-AMB-014',
  'REC-E2E-AMB-015'
]);
const OBSERVATION_SEMANTICS_CASE_SET = new Set(OBSERVATION_SEMANTICS_CASE_IDS);
const EXPLICIT_ORDER_PENDING_CASE_SET = new Set([
  'REC-E2E-BASIC-019', 'REC-E2E-BASIC-020', 'REC-E2E-AMB-001',
  'REC-E2E-AMB-002', 'REC-E2E-AMB-008', 'REC-E2E-AMB-014',
  'REC-E2E-AMB-015'
]);
const PROTECTED_RAW_PARSER_CASE_SET = new Set([
  'REC-E2E-BASIC-006',
  'REC-E2E-BASIC-010',
  'REC-E2E-AMB-005',
  'REC-E2E-BASIC-012',
  'REC-E2E-PAGE-003'
]);

const FORMAL_BUSINESS_COLLECTIONS = Object.freeze([
  'customers',
  'quotations',
  'orders',
  'receivables',
  'payments',
  'todos',
  'orderProgress',
  'dunningRecords',
  'productCatalog'
]);

const ALL_REQUIRED_DIFF_COLLECTIONS = Object.freeze([
  'customers',
  'quotations',
  'orders',
  'receivables',
  'payments',
  'todos',
  'pendingNotes',
  'productCatalog',
  'operationLogs',
  'aiParseLogs'
]);
const STATE_OVERRIDE_KEYS = new Set([
  'meta', 'customers', 'quotations', 'orders', 'receivables', 'paymentRecords',
  'dunningRecords', 'todos', 'orderProgress', 'pendingNotes', 'aiParseLogs',
  'operationLogs', 'productCatalog', 'deletedRecords', 'dunningTemplates',
  'legacyCompatibilityFlag'
]);

const OPERATION_BY_BUSINESS_TYPE = Object.freeze({
  quotation: new Set(['create_quotation', 'update_quotation']),
  order: new Set(['create_order', 'update_order']),
  receivable: new Set(['create_receivable', 'create_receivable_with_payment']),
  payment: new Set(['record_payment']),
  order_deposit: new Set(['record_order_deposit']),
  todo: new Set(['create_todo']),
  pending: new Set(['pending']),
  unknown: new Set(['none', 'pending'])
});

const FORBIDDEN_ALLOWANCE_PATH = /(?:customer|amount|paidAmount|unitPrice|product|items|quantity|dueDate|date|orderId|quotationId|receivableId|originalText|createdCount|updatedCount|deletedCount)/i;
const FORBIDDEN_EXPECTED_SOURCE = /(?:CURRENT_IMPLEMENTATION_OUTPUT|当前实现就是这样|沿用代码输出|为让测试通过)/i;
const FORBIDDEN_KNOWN_RISK = /(?:EXPECTED[_ -]?FAIL|IGNORE|WAIVE|KNOWN[_ -]?BUG[_ -]?PASS|当前行为即正确|PASS_CURRENT_BEHAVIOR)/i;
const SECRET_PATTERN = /(?:sk-[a-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*\S+|bearer\s+[a-z0-9._-]{12,}|token\s*[:=]\s*[a-z0-9._-]{12,}|cookie\s*[:=]|"(?:api[_-]?key|token|cookie)"\s*:\s*"[^"]{4,}")/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:^|[^\d])1[3-9]\d{9}(?:[^\d]|$)/;
const PRECISE_ADDRESS_PATTERN = /(?:(?:省|市|县|区).{0,20}(?:路|街|巷).{0,12}\d{1,5}号|[\u4e00-\u9fa5]{2,20}(?:小区|园区|村|镇).{0,12}\d+(?:幢|栋|单元|室))/;
const WECHAT_IDENTIFIER_PATTERN = /(?:\bwxid_[a-z0-9_-]{5,}|@[a-z0-9_-]*chatroom\b|微信号\s*[:：]\s*\S+)/i;
const DATE_FIELD_PATTERN = /(?:^|\.)(?:dueDate|requiredDeliveryDate|quoteDate|remindDate|paidAt|paymentDate|quoteFollowupDate|orderDeliveryDate|receivableDueDate|todoRemindDate|itemDeliveryDate|date)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CASE_ID_PATTERN = /^REC-E2E-[A-Z]+-\d{3}$/;
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/;
let failures = [];
let warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${path.relative(ROOT, filePath)} 无法解析：${error.message}`);
    return null;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(values));
}

function observationOf(testCase) {
  return testCase && testCase.expected && testCase.expected.observationSemantics || null;
}

function proposalOf(testCase) {
  const observation = observationOf(testCase);
  return observation ? observation.proposal.result : testCase.expected.result;
}

function semanticOf(testCase) {
  const observation = observationOf(testCase);
  if (observation) return observation.semanticResult;
  const proposal = proposalOf(testCase);
  return {
    businessType: proposal.businessType,
    effectiveOperation: proposal.operation
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function enumSet(enums, key) {
  return new Set(asArray(enums && enums[key]));
}

function checkEnum(value, allowed, label) {
  if (!allowed.has(value)) fail(`${label} 枚举非法：${JSON.stringify(value)}`);
}

function checkString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须是非空字符串`);
}

function checkArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} 必须是数组`);
    return [];
  }
  return value;
}

function containsSensitiveData(serialized) {
  return PHONE_PATTERN.test(serialized)
    || EMAIL_PATTERN.test(serialized)
    || SECRET_PATTERN.test(serialized)
    || PRECISE_ADDRESS_PATTERN.test(serialized)
    || WECHAT_IDENTIFIER_PATTERN.test(serialized);
}

function resolveLocalSchemaRef(rootSchema, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((current, segment) => (
    current && current[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
  ), rootSchema);
}

function collectSchemaErrors(rootSchema, schemaNode, value, label) {
  if (!schemaNode) return [`${label} Schema节点不存在`];
  if (schemaNode.$ref) {
    return collectSchemaErrors(rootSchema, resolveLocalSchemaRef(rootSchema, schemaNode.$ref), value, label);
  }
  const errors = [];
  if (schemaNode.oneOf) {
    const matches = schemaNode.oneOf.filter((branch) => (
      collectSchemaErrors(rootSchema, branch, value, label).length === 0
    )).length;
    if (matches !== 1) errors.push(`${label} 必须且只能匹配一个oneOf分支`);
    return errors;
  }
  if (Object.prototype.hasOwnProperty.call(schemaNode, 'const') && value !== schemaNode.const) {
    errors.push(`${label} 必须等于${JSON.stringify(schemaNode.const)}`);
  }
  if (schemaNode.enum && !schemaNode.enum.some((item) => canonicalJson(item) === canonicalJson(value))) {
    errors.push(`${label} 不在Schema枚举中：${JSON.stringify(value)}`);
  }

  const types = asArray(schemaNode.type);
  if (typeof schemaNode.type === 'string') types.push(schemaNode.type);
  if (types.length) {
    const matchesType = types.some((type) => (
      (type === 'object' && isObject(value))
      || (type === 'array' && Array.isArray(value))
      || (type === 'string' && typeof value === 'string')
      || (type === 'boolean' && typeof value === 'boolean')
      || (type === 'number' && typeof value === 'number' && Number.isFinite(value))
      || (type === 'integer' && Number.isInteger(value))
      || (type === 'null' && value === null)
    ));
    if (!matchesType) {
      errors.push(`${label} 类型不符合Schema：${types.join('|')}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schemaNode.minLength !== undefined && value.length < schemaNode.minLength) {
      errors.push(`${label} 长度小于${schemaNode.minLength}`);
    }
    if (schemaNode.pattern && !(new RegExp(schemaNode.pattern)).test(value)) {
      errors.push(`${label} 不符合Schema pattern ${schemaNode.pattern}`);
    }
  }
  if (typeof value === 'number' && schemaNode.minimum !== undefined && value < schemaNode.minimum) {
    errors.push(`${label} 小于Schema minimum ${schemaNode.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schemaNode.minItems !== undefined && value.length < schemaNode.minItems) {
      errors.push(`${label} 少于${schemaNode.minItems}项`);
    }
    if (schemaNode.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) {
      errors.push(`${label} 违反uniqueItems`);
    }
    if (schemaNode.items) value.forEach((item, index) => {
      errors.push(...collectSchemaErrors(rootSchema, schemaNode.items, item, `${label}[${index}]`));
    });
  }
  if (isObject(value)) {
    asArray(schemaNode.required).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${label}.${key} 缺失`);
    });
    Object.entries(value).forEach(([key, item]) => {
      if (schemaNode.properties && schemaNode.properties[key]) {
        errors.push(...collectSchemaErrors(rootSchema, schemaNode.properties[key], item, `${label}.${key}`));
      } else if (schemaNode.additionalProperties === false) {
        errors.push(`${label}.${key} 不允许额外字段`);
      } else if (isObject(schemaNode.additionalProperties)) {
        errors.push(...collectSchemaErrors(rootSchema, schemaNode.additionalProperties, item, `${label}.${key}`));
      }
    });
  }
  return errors;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  values.forEach((value) => {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  });
  return Array.from(duplicates);
}

function getPathEntries(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => getPathEntries(item, `${prefix}[${index}]`));
  }
  if (!isObject(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, item]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return getPathEntries(item, next);
  });
}

function formatShanghaiDate(instant) {
  const milliseconds = Date.parse(instant);
  if (!Number.isFinite(milliseconds)) return '';
  const date = new Date(milliseconds + (8 * 60 * 60 * 1000));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function isValidIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizeText(text, channel) {
  let value = String(text || '').normalize('NFKC').replace(/\r\n?/g, '\n');
  value = value.split('\n').map((line) => line.trim()).join('\n').trim();
  if (channel !== 'CLIPBOARD_CHAT') value = value.replace(/[\s，。！？、；：,.!?;:]+/g, '');
  return value.toLowerCase();
}

function literalSkeleton(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\d+(?:\.\d+)?/g, '<N>')
    .replace(/[零一二两三四五六七八九十百千万点块毛角]+/g, '<CN>')
    .replace(/(?:今天|明天|后天|本月底|月底|下周[一二三四五六日天]|下个月|明年|\d{4}年\d{1,2}月\d{1,2}日)/g, '<DATE>')
    .replace(/[\s，。！？、；：,.!?;:]+/g, '')
    .toLowerCase();
}

function countDiffChanges(scope, collections) {
  return collections.reduce((total, collection) => {
    const change = ((scope || {}).collections || {})[collection] || {};
    return total
      + Number(change.createdCount || 0)
      + Number(change.updatedCount || 0)
      + Number(change.deletedCount || 0);
  }, 0);
}

function hasNonZeroCollection(scope, collection) {
  return countDiffChanges(scope, [collection]) > 0;
}

function hasFormalBusinessDiff(testCase) {
  return countDiffChanges(testCase.expected.stateDiff.business, FORMAL_BUSINESS_COLLECTIONS) > 0;
}

function hasAnyBusinessDiff(testCase) {
  const collections = Object.keys((testCase.expected.stateDiff.business || {}).collections || {});
  return countDiffChanges(testCase.expected.stateDiff.business, collections) > 0;
}

function checkRequiredObject(value, label, keys) {
  if (!isObject(value)) {
    fail(`${label} 必须是对象`);
    return {};
  }
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label}.${key} 缺失`);
  });
  return value;
}

function validateProvenance(testCase, enums) {
  const label = testCase.caseId;
  const provenance = checkRequiredObject(testCase.provenance, `${label}.provenance`, [
    'sources', 'sourceCaseIds', 'adaptation', 'expectedBasis'
  ]);
  const sources = checkArray(provenance.sources, `${label}.provenance.sources`);
  const bases = checkArray(provenance.expectedBasis, `${label}.provenance.expectedBasis`);
  if (!sources.length) fail(`${label} 至少需要一个provenance source`);
  if (bases.length < 2) fail(`${label} expectedBasis至少需要两个独立依据`);
  sources.forEach((item) => checkEnum(item, enumSet(enums, 'provenanceSources'), `${label}.provenance.sources`));
  bases.forEach((item) => {
    checkEnum(item, enumSet(enums, 'expectedBases'), `${label}.provenance.expectedBasis`);
    if (FORBIDDEN_EXPECTED_SOURCE.test(item)) fail(`${label} expectedBasis不得来自当前实现输出`);
  });
  if (FORBIDDEN_EXPECTED_SOURCE.test(JSON.stringify(provenance))) {
    fail(`${label} provenance包含禁止的当前实现答案来源`);
  }
}

function validateInput(testCase, enums) {
  const label = testCase.caseId;
  const input = checkRequiredObject(testCase.input, `${label}.input`, [
    'channel', 'entrySurface', 'originalText'
  ]);
  checkEnum(input.channel, enumSet(enums, 'inputChannels'), `${label}.input.channel`);
  checkEnum(input.entrySurface, enumSet(enums, 'entrySurfaces'), `${label}.input.entrySurface`);
  checkString(input.originalText, `${label}.input.originalText`);

  if (input.channel === 'CLIPBOARD_CHAT') {
    checkString(input.clipboardText, `${label}.input.clipboardText`);
    checkString(input.expectedExtractedText, `${label}.input.expectedExtractedText`);
    if (input.originalText !== input.clipboardText) fail(`${label} 聊天题originalText必须严格等于clipboardText`);
    if (!input.originalText.includes('\n') || input.originalText.includes('\\n')) {
      fail(`${label} 聊天题必须使用解码后的真实换行，不能测试字面量\\\\n`);
    }
    if (!testCase.executionProfiles.includes('CLIPBOARD_CHAT')) fail(`${label} 聊天题缺CLIPBOARD_CHAT执行标签`);
  }
  if (input.channel === 'VOICE_TRANSCRIPT') {
    checkString(input.voiceTranscript, `${label}.input.voiceTranscript`);
    const characteristics = checkArray(input.transcriptCharacteristics, `${label}.input.transcriptCharacteristics`);
    if (!characteristics.length) fail(`${label} 语音题必须标注transcriptCharacteristics`);
    characteristics.forEach((item) => checkEnum(
      item,
      enumSet(enums, 'voiceTranscriptCharacteristics'),
      `${label}.input.transcriptCharacteristics`
    ));
    if (input.originalText !== input.voiceTranscript) fail(`${label} 语音题originalText必须严格等于voiceTranscript`);
    if (!testCase.executionProfiles.includes('VOICE_TRANSCRIPT')) fail(`${label} 语音题缺VOICE_TRANSCRIPT执行标签`);
  }
  if (input.channel === 'PENDING_EDIT') {
    checkString(input.pendingNoteId, `${label}.input.pendingNoteId`);
  } else if (input.pendingNoteId !== undefined) {
    fail(`${label} 只有PENDING_EDIT输入可以声明pendingNoteId`);
  }

  const sensitiveText = JSON.stringify(input);
  if (containsSensitiveData(sensitiveText)) fail(`${label} 输入包含疑似隐私、密钥、微信标识或精确地址`);
}

function validateClock(testCase) {
  const label = testCase.caseId;
  const clock = checkRequiredObject(testCase.clock, `${label}.clock`, [
    'businessDate', 'timezone', 'nowInstant'
  ]);
  if (!isValidIsoDate(clock.businessDate)) fail(`${label}.clock.businessDate不是有效ISO日期`);
  if (clock.timezone !== 'Asia/Shanghai') fail(`${label}.clock.timezone必须为Asia/Shanghai`);
  if (!Number.isFinite(Date.parse(clock.nowInstant))) fail(`${label}.clock.nowInstant不是有效ISO时刻`);
  const projected = formatShanghaiDate(clock.nowInstant);
  if (projected && projected !== clock.businessDate) {
    fail(`${label} nowInstant投影日期${projected}与businessDate ${clock.businessDate}不一致`);
  }
}

function validateAi(testCase, enums, aiFixtureIds, aiFixtureMap) {
  const label = testCase.caseId;
  const ai = checkRequiredObject(testCase.ai, `${label}.ai`, [
    'profile', 'expectedRoute'
  ]);
  checkEnum(ai.profile, enumSet(enums, 'aiProfiles'), `${label}.ai.profile`);
  checkEnum(ai.expectedRoute, enumSet(enums, 'routes'), `${label}.ai.expectedRoute`);
  if (Object.prototype.hasOwnProperty.call(ai, 'productionCommitEligible')) {
    fail(`${label}.ai.productionCommitEligible已弃用；生产资格必须只写expected.productionObservation`);
  }
  if (ai.expectedRoute !== testCase.expected.route) fail(`${label} ai.expectedRoute必须等于expected.route`);
  if (['FAKE_STANDARD', 'FAKE_DEEP', 'REPLAY'].includes(ai.profile)) {
    if (!ai.fixtureRef || !aiFixtureIds.has(ai.fixtureRef)) fail(`${label} AI profile ${ai.profile}需要有效fixtureRef`);
    const fixture = aiFixtureMap.get(ai.fixtureRef);
    if (fixture) {
      if (fixture.caseId !== label) {
        fail(`${label} 必须引用绑定本caseId的独立AI fixture`);
      }
      if (ai.profile === 'FAKE_STANDARD'
        && (fixture.reviewMode !== 'standard' || !['FAKE', 'MOCK'].includes(fixture.providerKind))) {
        fail(`${label} FAKE_STANDARD必须引用standard FAKE/MOCK fixture`);
      }
      if (ai.profile === 'FAKE_DEEP'
        && (fixture.reviewMode !== 'deep' || !['FAKE', 'MOCK'].includes(fixture.providerKind))) {
        fail(`${label} FAKE_DEEP必须引用deep FAKE/MOCK fixture`);
      }
      if (ai.profile === 'REPLAY' && fixture.providerKind !== 'REPLAY') {
        fail(`${label} REPLAY必须引用providerKind=REPLAY fixture`);
      }
      if (ai.expectedRoute === 'AI_STANDARD' && fixture.reviewMode !== 'standard') {
        fail(`${label} AI_STANDARD route必须引用standard fixture`);
      }
      if (ai.expectedRoute === 'AI_DEEP' && fixture.reviewMode !== 'deep') {
        fail(`${label} AI_DEEP route必须引用deep fixture`);
      }
      if (fixture.kind === 'FAKE_RESPONSE' || fixture.kind === 'REPLAY_RESPONSE') {
        const responseFields = cloneJson((fixture.response && fixture.response.fields) || {});
        const responseItems = asArray(responseFields.items);
        const relationTamper = testCase.execution
          && testCase.execution.relationReferenceTamper;
        testCase.interaction.userSelections.forEach((selection) => {
          responseFields[selection.kind] = selection.selectedId;
        });
        testCase.interaction.userEdits.forEach((edit) => {
          if (edit.scope === 'FIELD') responseFields[edit.field] = edit.value;
          if (edit.scope === 'ITEM' && responseItems[edit.itemIndex]) {
            responseItems[edit.itemIndex][edit.field] = edit.value;
            const item = responseItems[edit.itemIndex];
            if (typeof item.quantity === 'number' && typeof item.unitPrice === 'number') {
              item.totalAmount = item.quantity * item.unitPrice;
            }
          }
        });
        if (responseItems.length
          && testCase.interaction.userEdits.some((edit) => edit.scope === 'ITEM')) {
          responseFields.amount = responseItems.reduce((sum, item) => (
            sum + (typeof item.totalAmount === 'number' ? item.totalAmount : 0)
          ), 0);
        }
        const responseComparableFields = cloneJson(responseFields);
        delete responseComparableFields.items;
        if (testCase.expected.observationSemantics) {
          // The V1.2 contract promotes this legacy fixture annotation to
          // proposal.businessType; it is not an actual page-draft field.
          delete responseComparableFields.proposedBusinessType;
        }
        if (relationTamper) {
          if (Object.prototype.hasOwnProperty.call(responseComparableFields, 'quotationId')) {
            fail(`${label} 危险quotationId不得由AI fixture直接建立`);
          }
          if (fixture.response.intent !== relationTamper.baseDraft.intent
            || fixture.response.operation !== relationTamper.baseDraft.operation) {
            fail(`${label} AI fixture生产观察语义与危险关系测试底稿不兼容`);
          }
        } else if (testCase.interaction.userSelections.some(
          (selection) => selection.kind === 'quotationId'
        )) {
          const expectedFields = proposalOf(testCase).fields || {};
          Object.keys(responseComparableFields).forEach((field) => {
            if (canonicalJson(responseComparableFields[field])
              !== canonicalJson(expectedFields[field])) {
              fail(`${label} AI fixture与报价选择后的expected.result.fields.${field}不一致`);
            }
          });
          testCase.interaction.userEdits
            .filter((edit) => edit.scope === 'ITEM')
            .forEach((edit) => {
              const expectedItem = asArray(proposalOf(testCase).items)[edit.itemIndex];
              if (!expectedItem
                || canonicalJson(expectedItem[edit.field]) !== canonicalJson(edit.value)) {
                fail(`${label} 报价选择后的items没有保留用户编辑：${edit.field}`);
              }
            });
        } else {
          if (canonicalJson(responseComparableFields) !== canonicalJson(proposalOf(testCase).fields)) {
            fail(`${label} AI fixture应用选择/编辑后的fields与expected.result.fields不一致`);
          }
          if (canonicalJson(responseItems) !== canonicalJson(proposalOf(testCase).items)) {
            fail(`${label} AI fixture应用选择/编辑后的items与expected.result.items不一致`);
          }
        }
      }
      const fixtureResponse = (fixture.response && typeof fixture.response === 'object')
        ? fixture.response
        : {};
      const fixtureTemplate = String(fixture.sourceTemplateRef || '').toLowerCase();
      const dangerousAiFixture = ['TIMEOUT', 'INVALID_JSON'].includes(fixture.kind)
        || /(?:uncertain|empty-business)/.test(fixtureTemplate)
        || fixtureResponse.no_record === true
        || fixtureResponse.recordable === false
        || String(fixtureResponse.intent || '').toLowerCase() === 'unknown';
      if (dangerousAiFixture
        && testCase.expected.isolatedExecution
        && testCase.expected.isolatedExecution.status === 'TEST_ONLY_ISOLATED_COMMITTED') {
        fail(`${label} AI失败、空业务、NO_RECORD或危险uncertain fixture不得启用正式隔离提交`);
      }
    }
  } else if (ai.fixtureRef) {
    fail(`${label} ${ai.profile}不得引用Fake/Replay fixture`);
  }
  if (ai.profile === 'FAKE_DEEP' && ai.expectedRoute !== 'AI_DEEP') {
    fail(`${label} FAKE_DEEP必须期待AI_DEEP route`);
  }
  if (ai.profile === 'FAKE_STANDARD' && ai.expectedRoute !== 'AI_STANDARD') {
    fail(`${label} FAKE_STANDARD必须期待AI_STANDARD route`);
  }
  if (ai.profile === 'REPLAY' && !['AI_STANDARD', 'AI_DEEP'].includes(ai.expectedRoute)) {
    fail(`${label} REPLAY必须用于AI_STANDARD或AI_DEEP route`);
  }
}

function validateInteraction(testCase, enums) {
  const label = testCase.caseId;
  const interaction = checkRequiredObject(testCase.interaction, `${label}.interaction`, [
    'userEdits', 'userSelections', 'requiredCapabilities', 'requestedSaveAction', 'restartAfterSave'
  ]);
  const requiredCapabilities = checkArray(
    interaction.requiredCapabilities,
    `${label}.interaction.requiredCapabilities`
  );
  requiredCapabilities.forEach((capability) => checkEnum(
    capability,
    enumSet(enums, 'requiredCapabilities'),
    `${label}.interaction.requiredCapabilities`
  ));
  if (duplicateValues(requiredCapabilities).length) {
    fail(`${label}.interaction.requiredCapabilities不得重复`);
  }
  checkArray(interaction.userEdits, `${label}.interaction.userEdits`).forEach((edit, index) => {
    checkEnum(edit && edit.scope, enumSet(enums, 'editScopes'), `${label}.interaction.userEdits[${index}].scope`);
    checkString(edit && edit.field, `${label}.interaction.userEdits[${index}].field`);
    if (edit && edit.scope === 'ITEM' && (!Number.isInteger(edit.itemIndex) || edit.itemIndex < 0)) {
      fail(`${label} ITEM edit必须包含非负itemIndex`);
    }
    const requiredCapability = edit && edit.scope === 'ITEM'
      ? (edit.itemIndex >= 1 ? 'EDIT_ADDITIONAL_ITEM' : 'EDIT_PRIMARY_ITEM')
      : (edit && ['productName', 'quantity', 'unit', 'unitPrice', 'amount'].includes(edit.field)
        ? 'EDIT_PRIMARY_ITEM'
        : 'EDIT_CONFIRMATION_FIELD');
    if (!requiredCapabilities.includes(requiredCapability)) {
      fail(`${label} 编辑${edit && edit.field}缺requiredCapability=${requiredCapability}`);
    }
  });
  checkArray(interaction.userSelections, `${label}.interaction.userSelections`).forEach((selection, index) => {
    checkEnum(selection && selection.kind, enumSet(enums, 'selectionKinds'), `${label}.interaction.userSelections[${index}].kind`);
    checkString(selection && selection.selectedId, `${label}.interaction.userSelections[${index}].selectedId`);
    const requiredCapability = selection && selection.kind === 'orderId'
      ? (proposalOf(testCase).operation === 'record_order_deposit'
        ? 'SELECT_DEPOSIT_ORDER'
        : 'SELECT_ORDER')
      : REQUIRED_CAPABILITY_BY_SELECTION[selection && selection.kind];
    if (requiredCapability && !requiredCapabilities.includes(requiredCapability)) {
      fail(`${label} 选择${selection.kind}缺requiredCapability=${requiredCapability}`);
    }
    const expectedCandidateIds = selection.expectedCandidateIds === undefined
      ? []
      : checkArray(
        selection.expectedCandidateIds,
        `${label}.interaction.userSelections[${index}].expectedCandidateIds`
      );
    const rejectedCandidateIds = selection.rejectedCandidateIds === undefined
      ? []
      : checkArray(
        selection.rejectedCandidateIds,
        `${label}.interaction.userSelections[${index}].rejectedCandidateIds`
      );
    expectedCandidateIds.concat(rejectedCandidateIds).forEach((candidateId) => {
      checkString(candidateId, `${label}.interaction.userSelections[${index}].candidateId`);
    });
    if (duplicateValues(expectedCandidateIds).length
      || duplicateValues(rejectedCandidateIds).length) {
      fail(`${label} 选择候选断言不得包含重复ID`);
    }
    if (expectedCandidateIds.length
      && !expectedCandidateIds.includes(selection.selectedId)) {
      fail(`${label} selectedId必须位于expectedCandidateIds`);
    }
    if (expectedCandidateIds.some((candidateId) => (
      rejectedCandidateIds.includes(candidateId)
    ))) {
      fail(`${label} 安全候选与拒绝候选不得重叠`);
    }
  });
  checkEnum(interaction.requestedSaveAction, enumSet(enums, 'saveActions'), `${label}.interaction.requestedSaveAction`);
  if (typeof interaction.restartAfterSave !== 'boolean') fail(`${label}.interaction.restartAfterSave必须为boolean`);
  if (interaction.sequence !== undefined) {
    checkArray(interaction.sequence, `${label}.interaction.sequence`).forEach((step, index) => {
      checkEnum(step && step.step, enumSet(enums, 'interactionSteps'), `${label}.interaction.sequence[${index}].step`);
      if (step.actor !== undefined) checkString(step.actor, `${label}.interaction.sequence[${index}].actor`);
      if (step.planRef !== undefined) checkString(step.planRef, `${label}.interaction.sequence[${index}].planRef`);
      if (step.baseRevision !== undefined && (!Number.isInteger(step.baseRevision) || step.baseRevision < 0)) {
        fail(`${label}.interaction.sequence[${index}].baseRevision必须是非负整数`);
      }
      if (step.input !== undefined) {
        const stepInput = checkRequiredObject(
          step.input,
          `${label}.interaction.sequence[${index}].input`,
          ['originalText']
        );
        checkString(stepInput.originalText, `${label}.interaction.sequence[${index}].input.originalText`);
      }
      if (step.step === 'PREPARE' && step.input !== undefined && !step.planRef) {
        fail(`${label}.interaction.sequence[${index}] 带独立输入的PREPARE必须声明planRef`);
      }
    });
  }
  Object.entries(KNOWN_PAGE_CAPABILITY_GAPS).forEach(([caseId, expectedCapabilities]) => {
    if (label !== caseId) return;
    expectedCapabilities.forEach((capability) => {
      if (!requiredCapabilities.includes(capability)) {
        fail(`${label} 必须保留当前产品缺口对应的正确requiredCapability=${capability}`);
      }
    });
  });
}

function validateObservationSemantics(testCase, enums) {
  const label = testCase.caseId;
  const observation = observationOf(testCase);
  const standaloneRaw = testCase.expected.rawParser || null;
  const shouldUseNewContract = OBSERVATION_SEMANTICS_CASE_SET.has(label);
  if (shouldUseNewContract !== Boolean(observation)) {
    fail(`${label} observationSemantics迁移集合必须与冻结25题清单一致`);
    return;
  }
  const raw = observation && observation.rawParser || standaloneRaw;
  if (Boolean(standaloneRaw) !== PROTECTED_RAW_PARSER_CASE_SET.has(label)) {
    fail(`${label} 独立rawParser保护合同必须与冻结5题清单一致`);
  }
  if (!observation && !standaloneRaw) return;
  if (raw) {
    checkRequiredObject(
      raw,
      `${label}.expected.rawParser`,
      ['assertionScope']
    );
    checkEnum(
      raw.assertionScope,
      enumSet(enums, 'rawParserAssertionScopes'),
      `${label}.expected.rawParser.assertionScope`
    );
    if (raw.assertionScope === 'REQUIRED') {
      ['intent', 'businessType', 'operation'].forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(raw, field)) {
          fail(`${label} REQUIRED raw parser强断言必须声明${field}`);
        }
      });
    }
  }
  if (!observation) return;
  if (testCase.expected.result !== undefined) {
    fail(`${label} 新四层合同不得与旧expected.result并存`);
  }
  if (observation.contractVersion !== 'record-e2e-observation-semantics-v1') {
    fail(`${label} observationSemantics contractVersion错误`);
  }
  const semantic = checkRequiredObject(
    observation.semanticResult,
    `${label}.expected.observationSemantics.semanticResult`,
    ['businessType', 'effectiveOperation', 'source']
  );
  if (semantic.businessType === 'pending') {
    fail(`${label} pending不得作为canonical semantic businessType`);
  }
  checkEnum(semantic.businessType, enumSet(enums, 'businessTypes'),
    `${label}.expected.observationSemantics.semanticResult.businessType`);
  checkEnum(semantic.effectiveOperation, enumSet(enums, 'operations'),
    `${label}.expected.observationSemantics.semanticResult.effectiveOperation`);
  checkEnum(semantic.source, enumSet(enums, 'semanticResultSources'),
    `${label}.expected.observationSemantics.semanticResult.source`);
  if (!(OPERATION_BY_BUSINESS_TYPE[semantic.businessType] || new Set())
    .has(semantic.effectiveOperation)) {
    fail(`${label} semantic businessType与effectiveOperation不兼容`);
  }
  const proposal = proposalOf(testCase);
  if (proposal.fields
    && Object.prototype.hasOwnProperty.call(proposal.fields, 'proposedBusinessType')) {
    fail(`${label} proposedBusinessType必须由proposal.businessType表达，不能保留在fields`);
  }
  if (proposal.businessType === 'pending') {
    fail(`${label} pending不得作为canonical proposal businessType`);
  }
  if (proposal.businessType !== semantic.businessType
    || proposal.operation !== semantic.effectiveOperation) {
    fail(`${label} semanticResult与proposal业务语义冲突`);
  }
  checkEnum(
    observation.proposal.source,
    enumSet(enums, 'proposalSources'),
    `${label}.expected.observationSemantics.proposal.source`
  );
  checkEnum(
    observation.proposal.operationSource,
    enumSet(enums, 'proposalOperationSources'),
    `${label}.expected.observationSemantics.proposal.operationSource`
  );
  const expectedProposalSource = testCase.execution.lanes
    .includes('PAGE_CONFIRMED_DRAFT_DERIVATION')
    ? 'PAGE_CONFIRMED_DRAFT'
    : (testCase.input.entrySurface === 'HEADLESS'
      ? 'HEADLESS_NORMALIZED_RESULT'
      : 'PAGE_CONFIRMED_DRAFT');
  if (observation.proposal.source !== expectedProposalSource) {
    fail(`${label} proposal.source必须与实际草稿来源一致`);
  }
  const outcome = checkRequiredObject(
    observation.outcome,
    `${label}.expected.observationSemantics.outcome`,
    ['disposition', 'persistedRecordType', 'formalSaveSucceeded', 'pendingSaveSucceeded']
  );
  checkEnum(outcome.disposition, enumSet(enums, 'outcomeDispositions'),
    `${label}.expected.observationSemantics.outcome.disposition`);
  if (outcome.persistedRecordType !== null) {
    checkEnum(outcome.persistedRecordType, enumSet(enums, 'persistedRecordTypes'),
      `${label}.expected.observationSemantics.outcome.persistedRecordType`);
  }
  const saveStatusByDisposition = {
    BLOCKED: 'BLOCKED',
    FORMAL_RECORD: 'FORMAL_COMMITTED',
    NO_RECORD: 'NO_RECORD',
    PENDING_NOTE: 'PENDING_COMMITTED'
  };
  if (testCase.expected.save.status !== saveStatusByDisposition[outcome.disposition]) {
    fail(`${label} outcome.disposition必须与expected.save.status一致`);
  }
  if (outcome.disposition === 'FORMAL_RECORD'
    && (!outcome.formalSaveSucceeded || outcome.pendingSaveSucceeded
      || outcome.persistedRecordType === null
      || !hasFormalBusinessDiff(testCase))) {
    fail(`${label} FORMAL_RECORD必须有正式Commit和正式State Diff证据合同`);
  }
  if (outcome.disposition === 'PENDING_NOTE') {
    if (outcome.formalSaveSucceeded || !outcome.pendingSaveSucceeded
      || outcome.persistedRecordType !== 'pending_note'
      || !hasNonZeroCollection(testCase.expected.stateDiff.business, 'pendingNotes')
      || countDiffChanges(testCase.expected.stateDiff.business, FORMAL_BUSINESS_COLLECTIONS) > 0) {
      fail(`${label} PENDING_NOTE必须只有pending Diff且无正式业务Diff`);
    }
  }
  if (['NO_RECORD', 'BLOCKED'].includes(outcome.disposition)
    && (outcome.formalSaveSucceeded || outcome.pendingSaveSucceeded
      || outcome.persistedRecordType !== null
      || hasAnyBusinessDiff(testCase))) {
    fail(`${label} ${outcome.disposition}不得产生业务持久化`);
  }
  if (EXPLICIT_ORDER_PENDING_CASE_SET.has(label)
    && (semantic.businessType !== 'order'
      || semantic.effectiveOperation !== 'create_order'
      || outcome.disposition !== 'PENDING_NOTE')) {
    fail(`${label} 明确订单提案必须保持order/create_order，仅outcome为PENDING_NOTE`);
  }
}

function validateResult(testCase, enums) {
  const label = testCase.caseId;
  validateObservationSemantics(testCase, enums);
  const result = checkRequiredObject(proposalOf(testCase), `${label}.expected.proposalResult`, [
    'businessType', 'operation', 'originalText', 'fields', 'items',
    'allowedValues', 'conflictValues', 'absentFields'
  ]);
  checkEnum(result.businessType, enumSet(enums, 'businessTypes'), `${label}.expected.proposalResult.businessType`);
  checkEnum(result.operation, enumSet(enums, 'operations'), `${label}.expected.proposalResult.operation`);
  if (!(OPERATION_BY_BUSINESS_TYPE[result.businessType] || new Set()).has(result.operation)) {
    fail(`${label} businessType ${result.businessType}与operation ${result.operation}不兼容`);
  }
  if (result.originalText !== testCase.input.originalText) fail(`${label} expected proposal originalText必须严格等于输入原文`);
  if (!isObject(result.fields)) fail(`${label}.expected.result.fields必须是对象`);
  if (!Array.isArray(result.items)) fail(`${label}.expected.result.items必须是数组`);
  if (!isObject(result.allowedValues)) fail(`${label}.expected.result.allowedValues必须是对象`);
  if (!isObject(result.conflictValues)) fail(`${label}.expected.result.conflictValues必须是对象`);
  if (!Array.isArray(result.absentFields)) fail(`${label}.expected.result.absentFields必须是数组`);

  const explicitPaths = new Set(getPathEntries(result.fields).map(([entryPath]) => entryPath));
  Object.entries(result.allowedValues || {}).forEach(([entryPath, values]) => {
    if (!FIELD_PATH_PATTERN.test(entryPath)) fail(`${label} allowedValues路径非法：${entryPath}`);
    if (!Array.isArray(values) || !values.length) fail(`${label} allowedValues.${entryPath}必须是非空候选数组`);
    if (explicitPaths.has(entryPath)) fail(`${label} ${entryPath}不能同时在fields和allowedValues`);
  });
  Object.entries(result.conflictValues || {}).forEach(([entryPath, values]) => {
    if (!FIELD_PATH_PATTERN.test(entryPath)) fail(`${label} conflictValues路径非法：${entryPath}`);
    if (!Array.isArray(values) || unique(values.map(canonicalJson)).length < 2) {
      fail(`${label} conflictValues.${entryPath}必须包含至少两个不同候选值`);
    }
    if (!testCase.expected.confirmation.conflictFields.includes(entryPath)) {
      fail(`${label} conflictValues.${entryPath}必须同时列入confirmation.conflictFields`);
    }
    if (explicitPaths.has(entryPath) || Object.prototype.hasOwnProperty.call(result.allowedValues, entryPath)) {
      fail(`${label} ${entryPath}不能同时声明唯一值、允许值和冲突候选`);
    }
  });
  asArray(result.absentFields).forEach((entryPath) => {
    if (!FIELD_PATH_PATTERN.test(entryPath)) fail(`${label} absentFields路径非法：${entryPath}`);
    if (explicitPaths.has(entryPath)
      || Object.prototype.hasOwnProperty.call(result.allowedValues || {}, entryPath)
      || Object.prototype.hasOwnProperty.call(result.conflictValues || {}, entryPath)) {
      fail(`${label} ${entryPath}不能同时声明期望值和ABSENT`);
    }
  });
  const forbiddenAliases = nonCanonicalExpectedFieldsForOperation(result.operation);
  [
    ...Object.keys(result.fields),
    ...Object.keys(result.allowedValues),
    ...Object.keys(result.conflictValues),
    ...result.absentFields
  ].forEach((entryPath) => {
    const rootField = (entryPath.match(/^[A-Za-z_][A-Za-z0-9_]*/) || [''])[0];
    if (forbiddenAliases.has(rootField)) {
      fail(`${label} expected.result使用未标准化别名${rootField}`);
    }
  });

  getPathEntries(result).forEach(([entryPath, value]) => {
    if (!DATE_FIELD_PATTERN.test(entryPath)) return;
    if (typeof value === 'string' && !isValidIsoDate(value)) {
      fail(`${label} ${entryPath}必须是明确的YYYY-MM-DD日期`);
    }
  });
}

function validateRouting(testCase, enums) {
  const label = testCase.caseId;
  checkEnum(testCase.expected.route, enumSet(enums, 'routes'), `${label}.expected.route`);
  const routing = checkRequiredObject(testCase.expected.routing, `${label}.expected.routing`, [
    'productionRoute', 'executionPath', 'localSafetyStatus', 'expectedAiCall'
  ]);
  checkEnum(routing.productionRoute, enumSet(enums, 'productionRoutes'), `${label}.expected.routing.productionRoute`);
  checkEnum(routing.executionPath, enumSet(enums, 'executionPaths'), `${label}.expected.routing.executionPath`);
  checkEnum(routing.expectedAiCall, enumSet(enums, 'aiCallExpectations'), `${label}.expected.routing.expectedAiCall`);
  checkString(routing.localSafetyStatus, `${label}.expected.routing.localSafetyStatus`);

  if (testCase.expected.route === 'NO_RECORD') {
    if (routing.productionRoute !== 'PENDING' || routing.executionPath !== 'PRODUCTION_PENDING'
      || routing.localSafetyStatus !== 'NO_RECORD' || routing.expectedAiCall !== 'MUST_NOT_CALL') {
      fail(`${label} NO_RECORD必须映射为PENDING/PRODUCTION_PENDING/NO_RECORD/MUST_NOT_CALL`);
    }
  }
  if (testCase.expected.allowedRoutes !== undefined) {
    const allowed = checkArray(testCase.expected.allowedRoutes, `${label}.expected.allowedRoutes`);
    if (unique(allowed).length < 2 || !allowed.includes(testCase.expected.route)) {
      fail(`${label} allowedRoutes必须至少有两个唯一值并包含主route`);
    }
    checkString(testCase.expected.allowedRoutesReason, `${label}.expected.allowedRoutesReason`);
    if (testCase.riskLevel === 'P0') fail(`${label} P0题不得放宽route`);
  }
}

function validatePreflightAndSave(testCase, enums) {
  const label = testCase.caseId;
  const preflight = checkRequiredObject(testCase.expected.preflight, `${label}.expected.preflight`, [
    'domainCanSaveFormal', 'domainCanSavePending', 'blockingCodes', 'requiredSelections'
  ]);
  if (typeof preflight.domainCanSaveFormal !== 'boolean') fail(`${label} domainCanSaveFormal必须为boolean`);
  if (typeof preflight.domainCanSavePending !== 'boolean') fail(`${label} domainCanSavePending必须为boolean`);
  checkArray(preflight.blockingCodes, `${label}.expected.preflight.blockingCodes`);
  checkArray(preflight.requiredSelections, `${label}.expected.preflight.requiredSelections`).forEach((selection) => {
    checkEnum(selection, enumSet(enums, 'selectionKinds'), `${label}.expected.preflight.requiredSelections`);
  });

  const confirmation = checkRequiredObject(testCase.expected.confirmation, `${label}.expected.confirmation`, [
    'requiredFields', 'missingFields', 'conflictFields'
  ]);
  const confirmationPaths = [
    ...checkArray(confirmation.requiredFields, `${label}.expected.confirmation.requiredFields`),
    ...checkArray(confirmation.missingFields, `${label}.expected.confirmation.missingFields`),
    ...checkArray(confirmation.conflictFields, `${label}.expected.confirmation.conflictFields`)
  ];
  const forbiddenAliases = nonCanonicalExpectedFieldsForOperation(
    proposalOf(testCase).operation
  );
  confirmationPaths.forEach((entryPath) => {
    if (!FIELD_PATH_PATTERN.test(entryPath)) fail(`${label} Confirmation字段路径非法：${entryPath}`);
    const rootField = (entryPath.match(/^[A-Za-z_][A-Za-z0-9_]*/) || [''])[0];
    if (forbiddenAliases.has(rootField)) fail(`${label} Confirmation使用未标准化别名${rootField}`);
  });

  const save = checkRequiredObject(testCase.expected.save, `${label}.expected.save`, [
    'action', 'status'
  ]);
  checkEnum(save.action, enumSet(enums, 'saveActions'), `${label}.expected.save.action`);
  checkEnum(save.status, enumSet(enums, 'saveStatuses'), `${label}.expected.save.status`);
  if (save.action !== testCase.interaction.requestedSaveAction) fail(`${label} expected.save.action必须等于用户请求动作`);
  if (Object.prototype.hasOwnProperty.call(save, 'commitTarget')
    || Object.prototype.hasOwnProperty.call(save, 'productionCommitEligible')) {
    fail(`${label}.expected.save只允许表达业务action/status；生产资格与隔离目标必须使用独立合同`);
  }

  if (save.status === 'FORMAL_COMMITTED') {
    if (save.action !== 'SAVE_FORMAL' || !preflight.domainCanSaveFormal) {
      fail(`${label} FORMAL_COMMITTED必须由可正式保存的SAVE_FORMAL产生`);
    }
    if (!hasFormalBusinessDiff(testCase)) fail(`${label} FORMAL_COMMITTED必须有正式业务State Diff`);
  }
  if (save.status === 'BLOCKED') {
    if (preflight.domainCanSaveFormal) fail(`${label} BLOCKED不能domainCanSaveFormal=true`);
    if (hasAnyBusinessDiff(testCase)) fail(`${label} BLOCKED不得产生任何业务或日志Diff`);
  }
  if (save.status === 'PENDING_COMMITTED') {
    if (save.action !== 'SAVE_PENDING' || !preflight.domainCanSavePending) {
      fail(`${label} PENDING_COMMITTED必须是用户明确SAVE_PENDING且允许待整理`);
    }
    if (!hasNonZeroCollection(testCase.expected.stateDiff.business, 'pendingNotes')) {
      fail(`${label} PENDING_COMMITTED必须创建pendingNotes`);
    }
    if (countDiffChanges(testCase.expected.stateDiff.business, FORMAL_BUSINESS_COLLECTIONS) > 0) {
      fail(`${label} SAVE_PENDING不得产生正式业务Diff`);
    }
  }
  if (save.status === 'NO_RECORD') {
    if (save.action !== 'DO_NOT_SAVE' || hasAnyBusinessDiff(testCase)) {
      fail(`${label} NO_RECORD必须DO_NOT_SAVE且零副作用`);
    }
  }
  if (preflight.requiredSelections.length && !testCase.interaction.userSelections.length) {
    if (preflight.domainCanSaveFormal || save.status === 'FORMAL_COMMITTED') {
      fail(`${label} 多候选未选择不得正式保存`);
    }
  }
}

function validateSurface(testCase, enums) {
  const label = testCase.caseId;
  const surface = checkRequiredObject(testCase.expected.surface, `${label}.expected.surface`, ['home', 'fullPage']);
  ['home', 'fullPage'].forEach((key) => {
    const item = checkRequiredObject(surface[key], `${label}.expected.surface.${key}`, [
      'status', 'surfaceCanCompleteFormal', 'effectiveCanSaveFormal', 'missingCapabilities'
    ]);
    checkEnum(item.status, enumSet(enums, 'surfaceStatuses'), `${label}.expected.surface.${key}.status`);
    if (typeof item.surfaceCanCompleteFormal !== 'boolean') fail(`${label} ${key}.surfaceCanCompleteFormal必须为boolean`);
    if (typeof item.effectiveCanSaveFormal !== 'boolean') fail(`${label} ${key}.effectiveCanSaveFormal必须为boolean`);
    checkArray(item.missingCapabilities, `${label}.expected.surface.${key}.missingCapabilities`);
    if (item.effectiveCanSaveFormal && (!item.surfaceCanCompleteFormal || !testCase.expected.preflight.domainCanSaveFormal)) {
      fail(`${label} ${key} effectiveCanSaveFormal必须同时满足领域和Surface能力`);
    }
  });
}

function selectedSurfaceExpectation(testCase) {
  if (testCase.input.entrySurface === 'HOME_QUICK') {
    return testCase.expected.surface.home;
  }
  if (testCase.input.entrySurface === 'FULL_PAGE') {
    return testCase.expected.surface.fullPage;
  }
  return null;
}

function validateSelectedSurfaceState(testCase, surfaceExpectation) {
  if (!surfaceExpectation) return;
  const label = testCase.caseId;
  if (surfaceExpectation.status === 'NOT_APPLICABLE') {
    fail(`${label} 当前选中的页面Surface不得标记NOT_APPLICABLE`);
    return;
  }
  if (surfaceExpectation.status === 'CAN_COMPLETE') {
    if (!surfaceExpectation.surfaceCanCompleteFormal
      || !surfaceExpectation.effectiveCanSaveFormal) {
      fail(`${label} CAN_COMPLETE必须同时具备Surface业务能力和当前有效正式保存资格`);
    }
    return;
  }
  if (surfaceExpectation.effectiveCanSaveFormal) {
    fail(`${label} 非CAN_COMPLETE Surface不得声明effectiveCanSaveFormal=true`);
  }
  if (surfaceExpectation.status === 'REQUIRES_FULL_PAGE'
    && surfaceExpectation.surfaceCanCompleteFormal) {
    fail(`${label} REQUIRES_FULL_PAGE必须表达当前Surface业务能力不足`);
  }
}

function validateRelationReferenceTamperContract(testCase) {
  const label = testCase.caseId;
  const lanes = testCase.execution.lanes || [];
  const hasLane = lanes.includes('RELATION_REFERENCE_TAMPER_GUARD');
  const contract = testCase.execution.relationReferenceTamper;
  const expected = testCase.expected.relationReferenceTamper;
  if (!hasLane) {
    if (contract !== undefined || expected !== undefined) {
      fail(`${label} 无危险关系Lane不得携带relationReferenceTamper合同`);
    }
    return;
  }
  if (!isObject(contract) || !isObject(expected)) {
    fail(`${label} 危险关系Lane必须同时声明执行输入和Expected`);
    return;
  }
  if (lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')) {
    fail(`${label} 危险关系注入不得与隔离正式提交Lane并存`);
  }
  if (contract.sourceDraft !== 'EXPLICIT_SECURITY_TEST_DRAFT'
    || contract.relationKind !== 'QUOTATION'
    || contract.targetPath !== 'fields.quotationId') {
    fail(`${label} 危险报价引用必须来自显式安全测试底稿且只能注入fields.quotationId`);
  }
  checkString(contract.injectedId, `${label}.execution.relationReferenceTamper.injectedId`);
  const baseDraft = checkRequiredObject(
    contract.baseDraft,
    `${label}.execution.relationReferenceTamper.baseDraft`,
    ['intent', 'operation', 'original_text', 'fields',
      'missing_fields', 'low_confidence_fields', 'field_conflicts']
  );
  if (baseDraft.original_text !== testCase.input.originalText) {
    fail(`${label} 危险关系测试底稿必须保留Case原文`);
  }
  if (Object.prototype.hasOwnProperty.call(baseDraft.fields || {}, 'quotationId')) {
    fail(`${label} 危险quotationId只能由专用Lane单字段注入`);
  }
  if (baseDraft.intent !== proposalOf(testCase).businessType
    || baseDraft.operation !== proposalOf(testCase).operation) {
    fail(`${label} 危险关系测试底稿业务类型或operation与业务Expected不一致`);
  }
  const proposalQuotationId = (proposalOf(testCase).fields || {}).quotationId;
  if (proposalQuotationId !== undefined && proposalQuotationId !== contract.injectedId) {
    fail(`${label} 业务Expected中的quotationId如存在必须等于危险关系注入ID`);
  }
  if (proposalQuotationId === undefined) {
    const expectedRejected = asArray(
      testCase.expected.preflight.rejectedQuotationReferences
    );
    if (testCase.expected.preflight.selectedQuotationId !== ''
      || testCase.expected.preflight.quotationSelectionConfirmed !== false
      || !expectedRejected.some((item) => (
        item && item.quotationId === contract.injectedId
      ))) {
      fail(`${label} 未选中的危险报价必须在主Preflight Expected中表达为rejected reference`);
    }
  }
  const quoteSelections = asArray(testCase.interaction.userSelections)
    .filter((item) => item.kind === 'quotationId');
  if (quoteSelections.length
    || asArray(testCase.interaction.requiredCapabilities).includes('SELECT_QUOTATION')) {
    fail(`${label} 危险报价引用不得同时表达为用户SELECT_QUOTATION`);
  }
  if (testCase.interaction.requestedSaveAction !== 'DO_NOT_SAVE'
    || testCase.expected.save.action !== 'DO_NOT_SAVE'
    || testCase.expected.save.status !== 'BLOCKED'
    || testCase.expected.preflight.domainCanSaveFormal !== false
    || testCase.expected.isolatedExecution.enabled !== false) {
    fail(`${label} 危险关系注入必须阻断正式保存且禁止隔离提交`);
  }
  const expectedCodes = unique(asArray(expected.blockingCodes)).sort();
  const preflightCodes = unique(asArray(testCase.expected.preflight.blockingCodes)).sort();
  const rejectedMainCodes = unique(asArray(
    testCase.expected.preflight.rejectedQuotationReferences
  ).flatMap((item) => asArray(item && item.selectionBlockingCodes))).sort();
  const mainUsesRejectedReferenceContract = rejectedMainCodes.length > 0;
  if (expected.domainCanSaveFormal !== false
    || expected.saveAttempted !== false
    || expected.injectedReferenceExcludedFromSafeCandidates !== true
    || expected.formalBusinessDiff !== 'ZERO_SIDE_EFFECTS'
    || (mainUsesRejectedReferenceContract
      ? (canonicalJson(expectedCodes) !== canonicalJson(rejectedMainCodes)
        || expectedCodes.some((code) => !preflightCodes.includes(code)))
      : canonicalJson(expectedCodes) !== canonicalJson(preflightCodes))
    || hasAnyBusinessDiff(testCase)) {
    fail(`${label} 危险关系Expected必须精确阻断、排除候选且零正式副作用`);
  }
  if (expectedCodes.includes('QUOTATION_CUSTOMER_MISMATCH')
    && baseDraft.operation !== 'update_quotation') {
    fail(`${label} 跨客户报价引用底稿必须使用update_quotation`);
  }
  if (expectedCodes.includes('QUOTATION_ALREADY_CONVERTED')
    && baseDraft.operation !== 'create_order') {
    fail(`${label} 已转报价引用底稿必须使用create_order`);
  }
}

function validateExecutionBoundaries(testCase, enums) {
  const label = testCase.caseId;
  const execution = checkRequiredObject(testCase.execution, `${label}.execution`, [
    'schemaVersion', 'lanes', 'observationSurface', 'draftSourceSurface',
    'missingCapabilityDisposition', 'missingCapabilityFailureStage'
  ]);
  if (execution.schemaVersion !== 'record-e2e-execution-boundary-v1') {
    fail(`${label}.execution.schemaVersion错误`);
  }
  const lanes = checkArray(execution.lanes, `${label}.execution.lanes`);
  if (!lanes.length) fail(`${label} 至少需要一个execution lane`);
  if (duplicateValues(lanes).length) fail(`${label}.execution.lanes不得重复`);
  lanes.forEach((lane) => checkEnum(lane, enumSet(enums, 'executionLanes'), `${label}.execution.lanes`));
  checkEnum(execution.observationSurface, enumSet(enums, 'entrySurfaces'), `${label}.execution.observationSurface`);
  if (!['HOME_QUICK', 'FULL_PAGE', 'NOT_APPLICABLE'].includes(execution.draftSourceSurface)) {
    fail(`${label}.execution.draftSourceSurface枚举非法`);
  }
  checkEnum(
    execution.missingCapabilityDisposition,
    enumSet(enums, 'missingCapabilityDispositions'),
    `${label}.execution.missingCapabilityDisposition`
  );
  checkEnum(
    execution.missingCapabilityFailureStage,
    enumSet(enums, 'missingCapabilityFailureStages'),
    `${label}.execution.missingCapabilityFailureStage`
  );
  if (execution.missingCapabilityDisposition !== 'CASE_FAIL'
    || execution.missingCapabilityFailureStage !== 'SURFACE_ERROR') {
    fail(`${label} 缺失生产页面能力必须分类为CASE_FAIL/SURFACE_ERROR`);
  }
  if (execution.observationSurface !== testCase.input.entrySurface) {
    fail(`${label}.execution.observationSurface必须与input.entrySurface一致`);
  }
  const observationLanes = lanes.filter((lane) => OBSERVATION_LANES.includes(lane));
  if (observationLanes.length !== 1) fail(`${label} 必须且只能有一个生产观察lane`);
  const expectedObservationLane = testCase.input.entrySurface === 'HEADLESS'
    ? 'HEADLESS_PRODUCTION_OBSERVATION'
    : 'PAGE_PRODUCTION_OBSERVATION';
  const hasPageLane = lanes.includes('PAGE_PRODUCTION_OBSERVATION');
  if (!lanes.includes(expectedObservationLane)) {
    fail(`${label} ${testCase.input.entrySurface}必须使用${expectedObservationLane}`);
  }

  const observation = checkRequiredObject(
    testCase.expected.productionObservation,
    `${label}.expected.productionObservation`,
    ['productionEligibility', 'pageFormalSaveAllowed', 'blockingCodes',
      'providerClassification', 'requiredCapabilitiesSatisfied']
  );
  checkEnum(
    observation.productionEligibility,
    enumSet(enums, 'productionEligibilityStatuses'),
    `${label}.expected.productionObservation.productionEligibility`
  );
  checkEnum(
    observation.providerClassification,
    enumSet(enums, 'providerClassifications'),
    `${label}.expected.productionObservation.providerClassification`
  );
  checkArray(observation.blockingCodes, `${label}.expected.productionObservation.blockingCodes`);
  if (observation.requiredCapabilitiesSatisfied !== true) {
    fail(`${label} 正确产品Expected必须要求requiredCapabilitiesSatisfied=true`);
  }
  const expectedProviderClassification = testCase.ai.profile === 'LOCAL_ONLY'
    ? 'TEST_LOCAL_ONLY'
    : (testCase.ai.profile === 'REPLAY' ? 'NON_REAL_REPLAY' : 'NON_REAL_FAKE');
  if (observation.providerClassification !== expectedProviderClassification) {
    fail(`${label} providerClassification与ai.profile不一致`);
  }
  if (testCase.input.entrySurface === 'HEADLESS') {
    if (observation.pageFormalSaveAllowed !== null) {
      fail(`${label} HEADLESS观察不得声称页面正式保存能力`);
    }
  } else if (typeof observation.pageFormalSaveAllowed !== 'boolean') {
    fail(`${label} PAGE观察必须明确pageFormalSaveAllowed boolean`);
  }
  const expectedProductionBlockingCodes = unique([
    ...testCase.expected.preflight.blockingCodes,
    ...(NON_REAL_AI_PROFILES.has(testCase.ai.profile)
      ? ['UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION']
      : [])
  ]).sort();
  if (canonicalJson([...observation.blockingCodes].sort())
    !== canonicalJson(expectedProductionBlockingCodes)) {
    fail(`${label} productionObservation.blockingCodes必须是业务Preflight码与真实Provider资格码的完整集合`);
  }
  if (NON_REAL_AI_PROFILES.has(testCase.ai.profile)
    && observation.productionEligibility === 'ELIGIBLE_LOCAL') {
    fail(`${label} Fake/Replay不得取得LOCAL或REAL生产资格`);
  }
  const surfaceExpectation = selectedSurfaceExpectation(testCase);
  validateSelectedSurfaceState(testCase, surfaceExpectation);
  if (testCase.expected.route === 'NO_RECORD') {
    if (observation.productionEligibility !== 'NO_RECORD') {
      fail(`${label} NO_RECORD生产观察必须为NO_RECORD`);
    }
  } else if (!testCase.expected.preflight.domainCanSaveFormal) {
    if (observation.productionEligibility !== 'BLOCKED_BUSINESS_SAFETY') {
      fail(`${label} 业务Preflight阻断必须优先标记BLOCKED_BUSINESS_SAFETY`);
    }
  } else {
    if (surfaceExpectation
      && surfaceExpectation.surfaceCanCompleteFormal === false) {
      if (observation.productionEligibility !== 'BLOCKED_SURFACE') {
        fail(`${label} 当前入口Surface业务能力不足时必须标记BLOCKED_SURFACE`);
      }
    } else if (testCase.ai.profile === 'LOCAL_ONLY') {
      if (observation.productionEligibility !== 'ELIGIBLE_LOCAL') {
        fail(`${label} 安全LOCAL_ONLY观察必须标记ELIGIBLE_LOCAL，且不能称为REAL AI`);
      }
    } else if (observation.productionEligibility !== 'BLOCKED_NON_REAL_PROVIDER') {
      fail(`${label} 安全Fake/Replay生产观察必须阻断非真实Provider资格`);
    }
  }
  if (observation.productionEligibility === 'BLOCKED_SURFACE'
    && (!surfaceExpectation
      || surfaceExpectation.surfaceCanCompleteFormal !== false)) {
    fail(`${label} BLOCKED_SURFACE只能用于当前Surface业务能力不足`);
  }
  if (observation.productionEligibility === 'BLOCKED_NON_REAL_PROVIDER') {
    if (!NON_REAL_AI_PROFILES.has(testCase.ai.profile)) {
      fail(`${label} BLOCKED_NON_REAL_PROVIDER必须来自Fake或Replay Provider`);
    }
    if (!observation.blockingCodes.includes('UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION')) {
      fail(`${label} 非真实Provider阻断必须包含UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION`);
    }
    if (observation.pageFormalSaveAllowed !== (testCase.input.entrySurface === 'HEADLESS' ? null : false)) {
      fail(`${label} 非真实Provider不得取得生产页面正式保存资格`);
    }
    if (surfaceExpectation
      && surfaceExpectation.surfaceCanCompleteFormal !== true) {
      fail(`${label} Surface业务能力不足不得归类为BLOCKED_NON_REAL_PROVIDER`);
    }
  }
  if (observation.productionEligibility === 'ELIGIBLE_LOCAL') {
    if (testCase.ai.profile !== 'LOCAL_ONLY') {
      fail(`${label} ELIGIBLE_LOCAL必须来自LOCAL_ONLY`);
    }
    if (surfaceExpectation
      && (surfaceExpectation.status !== 'CAN_COMPLETE'
        || surfaceExpectation.surfaceCanCompleteFormal !== true
        || surfaceExpectation.effectiveCanSaveFormal !== true
        || observation.pageFormalSaveAllowed !== true)) {
      fail(`${label} ELIGIBLE_LOCAL必须具备完整Surface能力和当前页面正式保存资格`);
    }
  }
  const expectedPageFormalSaveAllowed = testCase.input.entrySurface === 'HEADLESS'
    ? null
    : (testCase.ai.profile === 'LOCAL_ONLY'
      && testCase.expected.surface[
        testCase.input.entrySurface === 'HOME_QUICK' ? 'home' : 'fullPage'
      ].effectiveCanSaveFormal === true);
  if (observation.pageFormalSaveAllowed !== expectedPageFormalSaveAllowed) {
    fail(`${label} pageFormalSaveAllowed必须与当前页面Surface、业务安全和Provider身份一致`);
  }

  const isolated = checkRequiredObject(
    testCase.expected.isolatedExecution,
    `${label}.expected.isolatedExecution`,
    ['enabled', 'action', 'status', 'marker', 'source', 'sourceLane', 'target', 'stateDiff']
  );
  checkEnum(isolated.action, enumSet(enums, 'saveActions'), `${label}.expected.isolatedExecution.action`);
  checkEnum(isolated.status, enumSet(enums, 'isolatedExecutionStatuses'), `${label}.expected.isolatedExecution.status`);
  checkEnum(isolated.marker, enumSet(enums, 'isolatedExecutionMarkers'), `${label}.expected.isolatedExecution.marker`);
  checkEnum(isolated.source, enumSet(enums, 'isolatedExecutionSources'), `${label}.expected.isolatedExecution.source`);
  checkEnum(isolated.target, enumSet(enums, 'isolatedExecutionTargets'), `${label}.expected.isolatedExecution.target`);
  checkEnum(isolated.stateDiff, enumSet(enums, 'isolatedStateDiffReferences'), `${label}.expected.isolatedExecution.stateDiff`);
  if (isolated.action !== testCase.expected.save.action) {
    fail(`${label} isolatedExecution.action必须与业务save.action一致`);
  }
  const hasIsolatedLane = lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT');
  if (isolated.enabled !== hasIsolatedLane) {
    fail(`${label} isolatedExecution.enabled必须与TEST_ONLY lane一致`);
  }
  if (['FORMAL_COMMITTED', 'PENDING_COMMITTED'].includes(testCase.expected.save.status)
    && !isolated.enabled) {
    fail(`${label} 可提交业务Expected必须启用TEST_ONLY隔离lane`);
  }
  if (['BLOCKED', 'NO_RECORD'].includes(testCase.expected.save.status) && isolated.enabled) {
    fail(`${label} 业务安全阻断或NO_RECORD不得启用隔离提交`);
  }
  if (isolated.enabled) {
    if (!ISOLATED_COMMITTED_STATUSES.has(isolated.status)
      || isolated.marker !== 'TEST_ONLY_ISOLATED_COMMIT'
      || isolated.target !== 'ISOLATED_LEGACY_STORE'
      || isolated.stateDiff !== 'EXPECTED_STATE_DIFF') {
      fail(`${label} 启用隔离执行必须固定TEST_ONLY状态、标记、隔离Legacy目标和Expected Diff`);
    }
    if (!lanes.includes(isolated.sourceLane)) {
      fail(`${label} isolatedExecution.sourceLane必须存在于execution.lanes`);
    }
    if (isolated.source !== 'PAGE_DERIVED_CONFIRMED_DRAFT'
      || !['PAGE_PRODUCTION_OBSERVATION', 'PAGE_CONFIRMED_DRAFT_DERIVATION'].includes(
        isolated.sourceLane
      )) {
      fail(`${label} 隔离执行必须来自真实页面派生确认草稿`);
    }
    if (isolated.status === 'TEST_ONLY_ISOLATED_COMMITTED') {
      if (isolated.action !== 'SAVE_FORMAL'
        || !testCase.expected.preflight.domainCanSaveFormal
        || testCase.expected.preflight.blockingCodes.length
        || testCase.expected.save.status !== 'FORMAL_COMMITTED') {
        fail(`${label} TEST_ONLY正式提交不得绕过业务Preflight`);
      }
      testCase.expected.preflight.requiredSelections.forEach((selectionKind) => {
        if (!testCase.interaction.userSelections.some((item) => item.kind === selectionKind)) {
          fail(`${label} 多候选未选择不得启用TEST_ONLY正式提交：${selectionKind}`);
        }
      });
    }
    if (isolated.status === 'TEST_ONLY_PENDING_COMMITTED') {
      if (isolated.action !== 'SAVE_PENDING'
        || !testCase.expected.preflight.domainCanSavePending
        || testCase.expected.save.status !== 'PENDING_COMMITTED'
        || countDiffChanges(testCase.expected.stateDiff.business, FORMAL_BUSINESS_COLLECTIONS) > 0) {
        fail(`${label} TEST_ONLY待整理提交只能写pending及允许日志副作用`);
      }
    }
  } else {
    if (isolated.marker !== 'NOT_APPLICABLE'
      || isolated.source !== 'NOT_APPLICABLE'
      || isolated.sourceLane !== 'NOT_APPLICABLE'
      || isolated.target !== 'NONE'
      || isolated.stateDiff !== 'ZERO_SIDE_EFFECTS') {
      fail(`${label} 禁止隔离执行时必须NOT_APPLICABLE/NONE/ZERO_SIDE_EFFECTS`);
    }
    const expectedStatus = testCase.expected.save.status === 'NO_RECORD' ? 'NOT_EXECUTED' : 'BLOCKED';
    if (isolated.status !== expectedStatus) {
      fail(`${label} 禁止隔离执行的status应为${expectedStatus}`);
    }
  }
  const hasDraftDerivationLane = lanes.includes('PAGE_CONFIRMED_DRAFT_DERIVATION');
  if (isolated.enabled && testCase.input.entrySurface === 'HEADLESS') {
    if (!hasDraftDerivationLane
      || execution.draftSourceSurface !== 'FULL_PAGE'
      || isolated.sourceLane !== 'PAGE_CONFIRMED_DRAFT_DERIVATION') {
      fail(`${label} HEADLESS提交题必须额外通过真实FULL_PAGE生成确认草稿`);
    }
  } else if (isolated.enabled) {
    if (hasDraftDerivationLane
      || execution.draftSourceSurface !== testCase.input.entrySurface
      || isolated.sourceLane !== 'PAGE_PRODUCTION_OBSERVATION') {
      fail(`${label} PAGE提交题必须直接使用当前页面观察草稿`);
    }
  } else if (hasDraftDerivationLane || execution.draftSourceSurface !== 'NOT_APPLICABLE') {
    fail(`${label} 不执行隔离提交时不得生成测试提交草稿`);
  }
  if (FORBIDDEN_PRODUCTION_COMMIT_TERMS.test(JSON.stringify({
    execution,
    productionObservation: observation,
    isolatedExecution: isolated
  }))) {
    fail(`${label} 执行边界不得使用生产正式提交或真实AI提交伪称`);
  }
  validateRelationReferenceTamperContract(testCase);

  Object.entries(KNOWN_PAGE_CAPABILITY_GAPS).forEach(([caseId, capabilities]) => {
    if (label !== caseId) return;
    if (testCase.expected.surface.fullPage.surfaceCanCompleteFormal !== true) {
      fail(`${label} 不得把当前页面缺陷降为正确Surface Expected`);
    }
    capabilities.forEach((capability) => {
      if (testCase.expected.surface.fullPage.missingCapabilities.includes(capability)) {
        fail(`${label} 不得把当前缺失${capability}写进正确Expected`);
      }
    });
  });

  const hasExactReplayLane = lanes.includes('TRANSACTION_EXACT_REPLAY');
  const exactReplay = testCase.expected.transactionExactReplay;
  if (hasExactReplayLane) {
    if (!hasIsolatedLane || !isObject(exactReplay)) {
      fail(`${label} TRANSACTION_EXACT_REPLAY必须有首次隔离提交lane和Expected`);
    } else {
      const identityFields = checkArray(
        exactReplay.identityFields,
        `${label}.expected.transactionExactReplay.identityFields`
      );
      if (canonicalJson([...identityFields].sort()) !== canonicalJson([...REQUIRED_EXACT_REPLAY_IDENTITY_FIELDS].sort())) {
        fail(`${label} exact replay必须锁定完整且相同的事务身份材料`);
      }
      if (exactReplay.trigger !== 'REPLAY_IDENTICAL_TRANSACTION_MATERIAL'
        || exactReplay.firstCommitStatus !== 'COMMITTED'
        || exactReplay.replayStatus !== 'ALREADY_COMMITTED'
        || exactReplay.pageSaveAttempts !== 1
        || exactReplay.idempotentReplay !== true
        || exactReplay.revisionDeltaOnReplay !== 0
        || exactReplay.businessDiffOnReplay !== 'EMPTY'
        || exactReplay.receiptSemantic !== 'EQUAL_TO_FIRST_COMMIT'
        || exactReplay.receiptCountDeltaOnReplay !== 0) {
        fail(`${label} exact replay必须原样重放且二次零revision/业务/receipt增量`);
      }
      const steps = asArray(testCase.interaction.sequence).map((step) => step.step);
      if (!steps.includes('CAPTURE_TRANSACTION_MATERIAL')
        || !steps.includes('REPLAY_EXACT_TRANSACTION')
        || steps.includes('RETRY_SAME_PLAN')
        || steps.filter((step) => step === 'COMMIT').length !== 1
        || FORBIDDEN_EXACT_REPLAY_UI_TERMS.test(JSON.stringify({
          sequence: testCase.interaction.sequence,
          exactReplay
        }))) {
        fail(`${label} exact replay不得描述为第二次页面保存或点击`);
      }
      const replaySequence = asArray(testCase.interaction.sequence);
      const exactStepNames = [
        'PREPARE',
        'COMMIT',
        'CAPTURE_TRANSACTION_MATERIAL',
        'REPLAY_EXACT_TRANSACTION'
      ];
      const exactSteps = exactStepNames.map((stepName) => (
        replaySequence.filter((step) => step.step === stepName)
      ));
      const exactIndexes = exactStepNames.map((stepName) => (
        replaySequence.findIndex((step) => step.step === stepName)
      ));
      const exactPlanRefs = unique(exactSteps.flat().map((step) => step.planRef).filter(Boolean));
      if (exactSteps.some((matches) => matches.length !== 1)
        || exactIndexes.some((index, position) => position > 0 && index <= exactIndexes[position - 1])
        || exactPlanRefs.length !== 1) {
        fail(`${label} exact replay必须按同一planRef依次PREPARE/COMMIT/CAPTURE/REPLAY`);
      }
      if (testCase.expected.idempotency.scenario !== 'TRANSACTION_EXACT_REPLAY'
        || testCase.expected.idempotency.attempts !== 2
        || canonicalJson(testCase.expected.idempotency.expectedCommitStatuses)
          !== canonicalJson(['COMMITTED', 'ALREADY_COMMITTED'])
        || testCase.expected.idempotency.expectedRevisionDelta !== 1
        || testCase.expected.idempotency.expectedAdditionalBusinessDiff !== exactReplay.businessDiffOnReplay
        || testCase.expected.idempotency.journalFinal !== exactReplay.journalFinal
        || testCase.expected.idempotency.backupFinal !== exactReplay.backupFinal) {
        fail(`${label} exact replay专用Expected必须与idempotency全字段一致`);
      }
    }
  } else if (exactReplay !== undefined) {
    fail(`${label} 无TRANSACTION_EXACT_REPLAY lane不得携带exact replay Expected`);
  }
  if (testCase.expected.idempotency.expectedCommitStatuses.includes('ALREADY_COMMITTED')
    && !hasExactReplayLane) {
    fail(`${label} ALREADY_COMMITTED只能由TRANSACTION_EXACT_REPLAY lane断言`);
  }

  const hasDuplicateTriggerLane = lanes.includes('PAGE_DUPLICATE_TRIGGER_GUARD');
  const duplicateTrigger = testCase.expected.pageDuplicateTrigger;
  if (hasDuplicateTriggerLane) {
    const sequence = asArray(testCase.interaction.sequence);
    const commitSteps = sequence.filter((step) => step.step === 'COMMIT');
    const duplicateSteps = sequence.filter((step) => step.step === 'TRIGGER_DUPLICATE_PAGE_SAVE');
    const planRefs = unique(commitSteps.concat(duplicateSteps).map((step) => step.planRef).filter(Boolean));
    if (!hasPageLane
      || !hasIsolatedLane
      || !isObject(duplicateTrigger)
      || testCase.expected.idempotency.scenario !== 'DOUBLE_UI_TRIGGER'
      || duplicateTrigger.sameUserAction !== true
      || duplicateTrigger.triggerAttempts !== 2
      || duplicateTrigger.pageSaveHandlerAttempts !== 1
      || duplicateTrigger.transactionCommitAttempts !== 1
      || duplicateTrigger.secondTriggerStatus !== 'SECOND_TRIGGER_SUPPRESSED'
      || duplicateTrigger.additionalBusinessDiff !== 'EMPTY'
      || duplicateTrigger.expectedRevisionDelta !== 1
      || duplicateTrigger.transactionExactReplay !== false
      || commitSteps.length !== 1
      || duplicateSteps.length !== 1
      || planRefs.length !== 1
      || testCase.expected.idempotency.attempts !== duplicateTrigger.triggerAttempts
      || testCase.expected.idempotency.expectedCommitStatuses.length !== 1
      || testCase.expected.idempotency.expectedCommitStatuses[0] !== 'COMMITTED'
      || testCase.expected.idempotency.expectedRevisionDelta !== duplicateTrigger.expectedRevisionDelta
      || testCase.expected.idempotency.expectedAdditionalBusinessDiff !== duplicateTrigger.additionalBusinessDiff
      || testCase.expected.idempotency.journalFinal !== 'CLEARED'
      || testCase.expected.idempotency.backupFinal !== 'CLEARED') {
      fail(`${label} 页面点击风暴必须在第二次进入事务前抑制，且不得伪称ALREADY_COMMITTED`);
    }
  } else if (duplicateTrigger !== undefined) {
    fail(`${label} 无PAGE_DUPLICATE_TRIGGER_GUARD lane不得携带页面防重Expected`);
  }

  const hasRestartLane = lanes.includes('RESTART_PERSISTENCE');
  if (hasRestartLane !== testCase.expected.restart.required) {
    fail(`${label} RESTART_PERSISTENCE lane必须与expected.restart.required双向一致`);
  }
  if (hasRestartLane && !hasIsolatedLane) {
    fail(`${label} RESTART_PERSISTENCE必须有首次隔离提交lane`);
  }
  const restartSteps = asArray(testCase.interaction.sequence).filter((step) => step.step === 'RESTART').length;
  if (hasRestartLane && restartSteps < 1) {
    fail(`${label} RESTART_PERSISTENCE lane必须包含真实RESTART步骤`);
  }
  if (testCase.expected.restart.attempts !== (hasRestartLane ? Math.max(1, restartSteps) : 0)) {
    fail(`${label} expected.restart.attempts必须与sequence重启次数一致`);
  }

  const hasConcurrentLane = lanes.includes('CONCURRENT_BASE_REVISION');
  const concurrent = testCase.expected.concurrentBaseRevision;
  if (hasConcurrentLane) {
    if (!hasPageLane
      || !hasIsolatedLane
      || !isObject(concurrent)
      || testCase.expected.idempotency.scenario !== 'SAME_BASE_CONCURRENT_COMMITS'
      || testCase.expected.idempotency.attempts !== 2
      || concurrent.sharedBaseRevision !== true
      || concurrent.firstCommitStatus !== 'COMMITTED'
      || concurrent.secondCommitStatus !== 'REVISION_MISMATCH'
      || concurrent.firstWriterPreserved !== true
      || concurrent.expectedRevisionDelta !== 1
      || canonicalJson(testCase.expected.idempotency.expectedCommitStatuses)
        !== canonicalJson([concurrent.firstCommitStatus, concurrent.secondCommitStatus])
      || testCase.expected.idempotency.expectedRevisionDelta !== concurrent.expectedRevisionDelta
      || testCase.expected.idempotency.expectedAdditionalBusinessDiff !== 'EMPTY'
      || testCase.expected.idempotency.journalFinal !== 'CLEARED'
      || testCase.expected.idempotency.backupFinal !== 'CLEARED') {
      fail(`${label} CONCURRENT lane必须明确同base、后提交失败且首写者保留`);
    }
    const sequence = asArray(testCase.interaction.sequence);
    const prepares = sequence.filter((step) => step.step === 'PREPARE');
    const commits = sequence.filter((step) => step.step === 'COMMIT');
    const prepareActors = unique(prepares.map((step) => step.actor).filter(Boolean)).sort();
    const commitActors = unique(commits.map((step) => step.actor).filter(Boolean)).sort();
    const expectedActors = asArray(concurrent && concurrent.actors).slice().sort();
    const baseRevisions = unique(prepares.map((step) => step.baseRevision));
    const planRefByActor = new Map(prepares.map((step) => [step.actor, step.planRef]));
    const preparePlanRefs = unique(prepares.map((step) => step.planRef).filter(Boolean));
    if (prepares.length !== 2
      || commits.length !== 2
      || baseRevisions.length !== 1
      || !Number.isInteger(baseRevisions[0])
      || canonicalJson(prepareActors) !== canonicalJson(expectedActors)
      || canonicalJson(commitActors) !== canonicalJson(expectedActors)
      || preparePlanRefs.length !== 2
      || commits.some((step) => planRefByActor.get(step.actor) !== step.planRef)) {
      fail(`${label} 并发合同必须由两个actor读取同一base后各提交一次`);
    }
  } else if (concurrent !== undefined) {
    fail(`${label} 无CONCURRENT_BASE_REVISION lane不得携带并发Expected`);
  }
}

function validateDiff(testCase, enums) {
  const label = testCase.caseId;
  const stateDiff = checkRequiredObject(testCase.expected.stateDiff, `${label}.expected.stateDiff`, ['business', 'full']);
  ['business', 'full'].forEach((scopeName) => {
    const scope = checkRequiredObject(stateDiff[scopeName], `${label}.expected.stateDiff.${scopeName}`, [
      'collections', 'fieldAssertions', 'relationAssertions', 'mustRemainUnchanged'
    ]);
    if (!isObject(scope.collections)) fail(`${label} ${scopeName}.collections必须是对象`);
    Object.entries(scope.collections || {}).forEach(([collection, change]) => {
      checkEnum(collection, enumSet(enums, 'stateDiffCollections'), `${label}.${scopeName}.collections`);
      ['createdCount', 'updatedCount', 'deletedCount'].forEach((key) => {
        if (!Number.isInteger(change && change[key]) || change[key] < 0) {
          fail(`${label} ${scopeName}.${collection}.${key}必须是非负整数`);
        }
      });
    });
    checkArray(scope.fieldAssertions, `${label}.${scopeName}.fieldAssertions`).forEach((assertion, index) => {
      const assertionLabel = `${label}.${scopeName}.fieldAssertions[${index}]`;
      if (!isObject(assertion)) {
        fail(`${assertionLabel}必须是对象`);
        return;
      }
      checkEnum(assertion.collection, enumSet(enums, 'stateDiffCollections'), `${assertionLabel}.collection`);
      checkEnum(assertion.change, enumSet(enums, 'changeKinds'), `${assertionLabel}.change`);
      checkString(assertion.path, `${assertionLabel}.path`);
      if (!FIELD_PATH_PATTERN.test(assertion.path)) fail(`${assertionLabel}.path非法`);
      checkEnum(assertion.assert, enumSet(enums, 'assertions'), `${assertionLabel}.assert`);
      if (!hasNonZeroCollection(scope, assertion.collection)) {
        fail(`${assertionLabel}引用的collection没有声明变化`);
      }
      if (assertion.assert === 'ABSENT' && Object.prototype.hasOwnProperty.call(assertion, 'value')) {
        fail(`${assertionLabel} ABSENT不得包含value`);
      }
      if (assertion.assert !== 'ABSENT' && !Object.prototype.hasOwnProperty.call(assertion, 'value')) {
        fail(`${assertionLabel} ${assertion.assert}必须包含value`);
      }
    });
    checkArray(scope.relationAssertions, `${label}.${scopeName}.relationAssertions`).forEach((assertion, index) => {
      const assertionLabel = `${label}.${scopeName}.relationAssertions[${index}]`;
      if (!isObject(assertion)) {
        fail(`${assertionLabel}必须是对象`);
        return;
      }
      checkEnum(assertion.fromCollection, enumSet(enums, 'stateDiffCollections'), `${assertionLabel}.fromCollection`);
      checkEnum(assertion.toCollection, enumSet(enums, 'stateDiffCollections'), `${assertionLabel}.toCollection`);
      checkString(assertion.fromPath, `${assertionLabel}.fromPath`);
      if (!FIELD_PATH_PATTERN.test(assertion.fromPath)) fail(`${assertionLabel}.fromPath非法`);
      if (!hasNonZeroCollection(scope, assertion.fromCollection)) {
        fail(`${assertionLabel} fromCollection没有声明变化`);
      }
      if (assertion.toId !== undefined) {
        checkString(assertion.toId, `${assertionLabel}.toId`);
      } else if (!scope.collections[assertion.toCollection]
        || scope.collections[assertion.toCollection].createdCount !== 1) {
        fail(`${assertionLabel} 无toId时toCollection必须恰好创建一条记录`);
      }
    });
    checkArray(scope.mustRemainUnchanged, `${label}.${scopeName}.mustRemainUnchanged`).forEach((collection) => {
      checkEnum(collection, enumSet(enums, 'stateDiffCollections'), `${label}.${scopeName}.mustRemainUnchanged`);
      if (hasNonZeroCollection(scope, collection)) fail(`${label} ${collection}不能同时变化和mustRemainUnchanged`);
    });
  });

  if (testCase.riskLevel === 'P0') {
    const business = stateDiff.business;
    if (!Object.keys(business.collections || {}).length && !(business.mustRemainUnchanged || []).length) {
      fail(`${label} P0题必须有最终State或零副作用断言`);
    }
  }
  if (testCase.expected.save.status === 'BLOCKED' || testCase.expected.save.status === 'NO_RECORD') {
    const unchanged = new Set(stateDiff.business.mustRemainUnchanged || []);
    ALL_REQUIRED_DIFF_COLLECTIONS.forEach((collection) => {
      if (!unchanged.has(collection) && !(
        stateDiff.business.collections[collection]
        && !hasNonZeroCollection(stateDiff.business, collection)
      )) fail(`${label} 阻断/NO_RECORD题必须声明${collection}零副作用`);
    });
  }
  const originalTextAssertions = ['business', 'full'].flatMap((scopeName) => (
    stateDiff[scopeName].fieldAssertions || []
  )).filter((assertion) => (
    assertion.path === 'originalText' && assertion.assert === 'EXACT'
  ));
  if (originalTextAssertions.some((assertion) => (
    assertion.value !== testCase.input.originalText
  ))) {
    fail(`${label} State Diff中的originalText精确断言必须等于输入原文`);
  }
}

function validateMultiItem(testCase) {
  const isHomeItemZeroSync = testCase.caseId === 'REC-E2E-PAGE-008';
  if (testCase.category !== 'MULTI_ITEM'
    && !testCase.tags.includes('MULTI_ITEM')
    && !isHomeItemZeroSync) return;
  const label = testCase.caseId;
  const items = proposalOf(testCase).items;
  if (isHomeItemZeroSync) {
    if (!Array.isArray(items) || items.length !== 1) fail(`${label} 首页items[0]同步题必须恰好断言一个商品`);
    const assertions = JSON.stringify(testCase.expected.stateDiff);
    if (!/items\[0\]/.test(assertions)) fail(`${label} 必须有items[0] State Diff字段断言`);
    if (!/originalText/.test(assertions)) fail(`${label} 必须断言originalText`);
    return;
  }
  if (!Array.isArray(items) || items.length < 2) fail(`${label} 多商品题必须断言至少两件商品`);
  const fieldAssertions = testCase.expected.stateDiff.business.fieldAssertions || [];
  const assertionsByPath = new Map(fieldAssertions.map((assertion) => [assertion.path, assertion]));
  const lengthAssertion = assertionsByPath.get('items.length');
  if (!lengthAssertion || lengthAssertion.assert !== 'EXACT' || lengthAssertion.value !== items.length) {
    fail(`${label} 多商品题必须精确断言最终items.length=${items.length}`);
  }
  items.forEach((item, itemIndex) => {
    ['productName', 'quantity', 'unit', 'unitPrice'].forEach((field) => {
      const entryPath = `items[${itemIndex}].${field}`;
      const assertion = assertionsByPath.get(entryPath);
      if (item[field] !== undefined) {
        if (!assertion || assertion.assert !== 'EXACT' || assertion.value !== item[field]) {
          fail(`${label} 必须精确断言${entryPath}`);
        }
      } else if (field === 'unitPrice'
        && proposalOf(testCase).absentFields.includes(entryPath)) {
        if (!assertion || assertion.assert !== 'ABSENT') fail(`${label} 必须断言${entryPath}缺失`);
      } else {
        fail(`${label} ${entryPath}缺失且未声明为允许缺失`);
      }
    });
    ['totalAmount', 'itemDeliveryDate'].forEach((field) => {
      if (item[field] === undefined) return;
      const entryPath = `items[${itemIndex}].${field}`;
      const assertion = assertionsByPath.get(entryPath);
      if (!assertion || assertion.assert !== 'EXACT' || assertion.value !== item[field]) {
        fail(`${label} 必须精确断言${entryPath}`);
      }
    });
    if (Object.prototype.hasOwnProperty.call(item, 'dueDate')) {
      fail(`${label} 单项交期必须使用itemDeliveryDate，不能使用items[].dueDate`);
    }
  });
  const originalTextAssertion = assertionsByPath.get('originalText');
  if (!originalTextAssertion || originalTextAssertion.assert !== 'EXACT'
    || originalTextAssertion.value !== testCase.input.originalText) {
    fail(`${label} 多商品题必须精确断言originalText`);
  }
  if (proposalOf(testCase).fields.dueDate) {
    const dueAssertion = assertionsByPath.get('requiredDeliveryDate');
    if (!dueAssertion || dueAssertion.assert !== 'EXACT'
      || dueAssertion.value !== proposalOf(testCase).fields.dueDate) {
      fail(`${label} 共享交期必须断言订单requiredDeliveryDate`);
    }
  }
}

function validateFinancial(testCase) {
  if (testCase.category !== 'FINANCIAL_SAFETY') return;
  const label = testCase.caseId;
  if (testCase.riskLevel !== 'P0') fail(`${label} 金融安全题必须是P0`);
  const result = proposalOf(testCase);
  const hasAmount = ['amount', 'paymentAmount', 'depositAmount'].some((key) => (
    typeof result.fields[key] === 'number' && result.fields[key] > 0
  ));
  const amountBlocking = testCase.expected.preflight.blockingCodes.some((code) => /AMOUNT|EXCEEDS|PAYMENT|DEPOSIT/.test(code));
  if (!hasAmount && !amountBlocking) fail(`${label} 金融题必须有明确金额或明确金额阻断原因`);
  if (testCase.allowances.some((item) => (item.paths || []).some((entryPath) => /amount/i.test(entryPath)))) {
    fail(`${label} 金额不得列入allowances`);
  }
  if (testCase.tags.includes('OVERPAYMENT') && testCase.expected.save.status !== 'BLOCKED') {
    fail(`${label} 超额金融题必须BLOCKED`);
  }
  if (testCase.tags.includes('MULTIPLE_RECEIVABLES')
    && !testCase.expected.preflight.requiredSelections.includes('receivableId')) {
    fail(`${label} 多待收题必须要求选择receivableId`);
  }
}

function validateRestartAndIdempotency(testCase, enums) {
  const label = testCase.caseId;
  const restart = checkRequiredObject(testCase.expected.restart, `${label}.expected.restart`, [
    'required', 'attempts', 'stateFingerprint', 'recordCountStable', 'mustPersist', 'additionalBusinessDiff'
  ]);
  const idempotency = checkRequiredObject(testCase.expected.idempotency, `${label}.expected.idempotency`, [
    'scenario', 'attempts', 'expectedCommitStatuses', 'expectedRevisionDelta',
    'expectedAdditionalBusinessDiff', 'journalFinal', 'backupFinal'
  ]);
  if (typeof restart.required !== 'boolean') fail(`${label} restart.required必须为boolean`);
  if (!Number.isInteger(restart.attempts) || restart.attempts < 0) {
    fail(`${label} restart.attempts必须为非负整数`);
  }
  if (!['NOT_APPLICABLE', 'EQUAL_TO_POST_SAVE'].includes(restart.stateFingerprint)) {
    fail(`${label} restart.stateFingerprint枚举非法`);
  }
  if (!['NOT_APPLICABLE', 'EMPTY'].includes(restart.additionalBusinessDiff)) {
    fail(`${label} restart.additionalBusinessDiff枚举非法`);
  }
  checkArray(restart.mustPersist, `${label}.expected.restart.mustPersist`).forEach((item, index) => {
    if (!isObject(item)) fail(`${label}.expected.restart.mustPersist[${index}]必须是定位对象`);
  });
  checkEnum(idempotency.scenario, enumSet(enums, 'idempotencyScenarios'), `${label}.expected.idempotency.scenario`);
  if (!Number.isInteger(idempotency.attempts) || idempotency.attempts < 0) {
    fail(`${label} idempotency.attempts必须为非负整数`);
  }
  if (!Number.isInteger(idempotency.expectedRevisionDelta) || idempotency.expectedRevisionDelta < 0) {
    fail(`${label} idempotency.expectedRevisionDelta必须为非负整数`);
  }
  checkArray(idempotency.expectedCommitStatuses, `${label}.expected.idempotency.expectedCommitStatuses`)
    .forEach((status) => {
      if (!['COMMITTED', 'ALREADY_COMMITTED', 'REVISION_MISMATCH'].includes(status)) {
        fail(`${label} idempotency.expectedCommitStatuses枚举非法：${status}`);
      }
    });
  if (!['NOT_APPLICABLE', 'EMPTY', 'DISTINCT_COMMIT'].includes(idempotency.expectedAdditionalBusinessDiff)) {
    fail(`${label} idempotency.expectedAdditionalBusinessDiff枚举非法`);
  }
  if (!['NOT_APPLICABLE', 'CLEARED'].includes(idempotency.journalFinal)
    || !['NOT_APPLICABLE', 'CLEARED'].includes(idempotency.backupFinal)) {
    fail(`${label} Journal/Backup最终状态枚举非法`);
  }
  if (testCase.executionProfiles.includes('RESTART_PERSISTENCE') && !restart.required) {
    fail(`${label} RESTART_PERSISTENCE题必须restart.required=true`);
  }
  if (testCase.interaction.restartAfterSave !== restart.required) {
    fail(`${label} interaction.restartAfterSave必须与expected.restart.required一致`);
  }
  if (!restart.required && (
    restart.attempts !== 0
    ||
    restart.stateFingerprint !== 'NOT_APPLICABLE'
    || restart.additionalBusinessDiff !== 'NOT_APPLICABLE'
    || restart.mustPersist.length
  )) {
    fail(`${label} 无重启题的restart断言必须全部NOT_APPLICABLE`);
  }
  if (testCase.category === 'PERSISTENCE_IDEMPOTENCY'
    && !restart.required
    && idempotency.scenario === 'NOT_APPLICABLE') {
    fail(`${label} 持久化幂等题必须包含restart或idempotency合同`);
  }
}

function validateAllowancesAndRisk(testCase, enums) {
  const label = testCase.caseId;
  checkArray(testCase.allowances, `${label}.allowances`).forEach((allowance, index) => {
    checkEnum(allowance && allowance.kind, enumSet(enums, 'allowanceKinds'), `${label}.allowances[${index}].kind`);
    checkArray(allowance && allowance.paths, `${label}.allowances[${index}].paths`).forEach((entryPath) => {
      if (FORBIDDEN_ALLOWANCE_PATH.test(entryPath)) fail(`${label} 禁止业务差异allowance：${entryPath}`);
    });
    checkString(allowance && allowance.reason, `${label}.allowances[${index}].reason`);
  });
  if (testCase.knownRisk !== null) {
    if (!isObject(testCase.knownRisk)) fail(`${label}.knownRisk必须是对象或null`);
    if (FORBIDDEN_KNOWN_RISK.test(JSON.stringify(testCase.knownRisk))) {
      fail(`${label} knownRisk包含失败豁免语义`);
    }
  }
}

function validateStateReferences(testCase, resolvedStateFixtureMap) {
  const label = testCase.caseId;
  const baseState = cloneJson(resolvedStateFixtureMap.get(testCase.initialState.fixtureRef) || {});
  const state = Object.assign(baseState, cloneJson(testCase.initialState.overrides || {}));
  const collectionBySelection = {
    customerId: 'customers',
    orderId: 'orders',
    quotationId: 'quotations',
    receivableId: 'receivables'
  };
  const blockingCodes = testCase.expected.preflight.blockingCodes || [];
  testCase.interaction.userSelections.forEach((selection) => {
    const collection = collectionBySelection[selection.kind];
    const exists = asArray(state[collection]).some((item) => item && item.id === selection.selectedId);
    const intentionalMissing = blockingCodes.some((code) => /TARGET_NOT_FOUND|DELETED|INVALID_TARGET/.test(code));
    if (!exists && !intentionalMissing) {
      fail(`${label} 选择${selection.kind}=${selection.selectedId}在初始State中不存在`);
    }
    if (selection.kind === 'quotationId') {
      asArray(selection.expectedCandidateIds)
        .concat(asArray(selection.rejectedCandidateIds))
        .forEach((quotationId) => {
          const quotationExists = asArray(state.quotations).some((item) => (
            item && String(item.id || '') === String(quotationId || '')
          ));
          if (!quotationExists) {
            fail(`${label} 报价候选合同ID在初始State中不存在：${quotationId}`);
          }
        });
    }
  });
  testCase.expected.preflight.requiredSelections.forEach((selectionKind) => {
    const hasSelection = testCase.interaction.userSelections.some((item) => item.kind === selectionKind);
    const collection = collectionBySelection[selectionKind];
    if (!hasSelection && asArray(state[collection]).length < 2) {
      fail(`${label} 要求选择${selectionKind}，但初始State不足两个候选`);
    }
  });
  if (testCase.input.channel === 'PENDING_EDIT') {
    const pending = asArray(state.pendingNotes).find((item) => (
      item && item.id === testCase.input.pendingNoteId
    ));
    if (!pending) {
      fail(`${label} pendingNoteId在初始State中不存在：${testCase.input.pendingNoteId}`);
    } else if (String(pending.originalText || '') !== String(testCase.input.originalText || '')) {
      fail(`${label} pendingNoteId原文与Case input.originalText不一致`);
    }
  }
  const tamper = testCase.execution && testCase.execution.relationReferenceTamper;
  if (tamper) {
    const quotation = asArray(state.quotations).find((item) => (
      item && String(item.id || '') === String(tamper.injectedId || '')
    ));
    const customerId = tamper.preflightContext
      && tamper.preflightContext.selectedCustomerId;
    const customerExists = asArray(state.customers).some((item) => (
      item && String(item.id || '') === String(customerId || '')
    ));
    if (!quotation) fail(`${label} 危险quotationId在初始State中不存在`);
    if (!customerExists) fail(`${label} 危险关系selectedCustomerId在初始State中不存在`);
    const expectedCodes = asArray(testCase.expected.relationReferenceTamper
      && testCase.expected.relationReferenceTamper.blockingCodes);
    if (quotation && expectedCodes.includes('QUOTATION_CUSTOMER_MISMATCH')
      && String(quotation.customerId || '') === String(customerId || '')) {
      fail(`${label} 跨客户引用测试的报价与当前客户实际相同`);
    }
    const reverseOrder = quotation && asArray(state.orders).find((item) => (
      item && String(item.quotationId || '') === String(quotation.id || '')
    ));
    const converted = quotation && (
      Boolean(quotation.convertedOrderId)
      || String(quotation.status || '') === '已转订单'
      || Boolean(reverseOrder)
    );
    if (expectedCodes.includes('QUOTATION_ALREADY_CONVERTED') && !converted) {
      fail(`${label} 已转报价引用测试的fixture没有转换事实`);
    }
    if (quotation && customerExists) {
      const factualCodes = String(quotation.customerId || '') !== String(customerId || '')
        ? ['QUOTATION_CUSTOMER_MISMATCH']
        : (
          tamper.baseDraft.operation === 'create_order' && converted
            ? ['QUOTATION_ALREADY_CONVERTED']
            : []
        );
      const expectedPreflightCodes = asArray(testCase.expected.preflight.blockingCodes)
        .slice()
        .sort();
      if (!factualCodes.length) {
        fail(`${label} 危险报价引用fixture没有可验证的跨客户或重复转单事实`);
      } else if (
        canonicalJson(expectedCodes.slice().sort()) !== canonicalJson(factualCodes)
        || factualCodes.some((code) => !expectedPreflightCodes.includes(code))
      ) {
        fail(`${label} 危险报价引用阻断码必须由fixture事实独立决定：${factualCodes.join(',')}`);
      }
    }
  }
  validateExecutionPlanPreconditions(testCase, state)
    .forEach((code) => fail(`${label} execution plan前置条件失败：${code}`));
}

function validateCase(testCase, context) {
  const {
    enums, schema, stateFixtureIds, resolvedStateFixtureMap, aiFixtureIds, aiFixtureMap
  } = context;
  if (!isObject(testCase)) {
    fail('题目必须是对象');
    return;
  }
  const label = testCase.caseId || '<missing-caseId>';
  collectSchemaErrors(schema, schema, testCase, label).forEach(fail);
  const serializedCase = JSON.stringify(testCase);
  if (containsSensitiveData(serializedCase)) {
    fail(`${label} Case包含疑似隐私、密钥、微信标识或精确地址`);
  }
  [
    'schemaVersion', 'caseId', 'title', 'status', 'riskLevel', 'category', 'tags',
    'provenance', 'executionProfiles', 'execution', 'input', 'clock', 'initialState', 'ai',
    'interaction', 'expected', 'allowances', 'knownRisk'
  ].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(testCase, key)) fail(`${label}.${key} 缺失`);
  });
  if (testCase.schemaVersion !== 'record-e2e-case-v1.2') fail(`${label} schemaVersion错误`);
  if (!CASE_ID_PATTERN.test(String(testCase.caseId || ''))) fail(`${label} caseId格式错误`);
  checkString(testCase.title, `${label}.title`);
  checkEnum(testCase.status, enumSet(enums, 'statuses'), `${label}.status`);
  checkEnum(testCase.riskLevel, enumSet(enums, 'riskLevels'), `${label}.riskLevel`);
  checkEnum(testCase.category, enumSet(enums, 'categories'), `${label}.category`);
  const tags = checkArray(testCase.tags, `${label}.tags`);
  if (tags.length < 2 || duplicateValues(tags).length) fail(`${label}.tags至少两个且不可重复`);
  const profiles = checkArray(testCase.executionProfiles, `${label}.executionProfiles`);
  profiles.forEach((profile) => checkEnum(profile, enumSet(enums, 'executionProfiles'), `${label}.executionProfiles`));
  if (!profiles.includes('HEADLESS_DETERMINISTIC')) fail(`${label} 核心题必须可由Headless确定性Runner消费`);
  if (profiles.includes('PAGE_E2E') && testCase.input && testCase.input.entrySurface === 'HEADLESS') {
    fail(`${label} PAGE_E2E题必须指定HOME_QUICK或FULL_PAGE`);
  }

  validateProvenance(testCase, enums);
  validateInput(testCase, enums);
  validateClock(testCase);
  const initialState = checkRequiredObject(testCase.initialState, `${label}.initialState`, ['fixtureRef', 'overrides']);
  if (!stateFixtureIds.has(initialState.fixtureRef)) fail(`${label} fixtureRef不存在：${initialState.fixtureRef}`);
  if (!isObject(initialState.overrides)) fail(`${label}.initialState.overrides必须是对象`);
  Object.keys(initialState.overrides || {}).forEach((key) => {
    if (!STATE_OVERRIDE_KEYS.has(key)) fail(`${label}.initialState.overrides.${key}不是允许的State顶层键`);
  });
  validateResult(testCase, enums);
  validateRouting(testCase, enums);
  validateAi(testCase, enums, aiFixtureIds, aiFixtureMap);
  validateInteraction(testCase, enums);
  validatePreflightAndSave(testCase, enums);
  validateStateReferences(testCase, resolvedStateFixtureMap);
  validateSurface(testCase, enums);
  validateExecutionBoundaries(testCase, enums);
  validateDiff(testCase, enums);
  validateMultiItem(testCase);
  validateFinancial(testCase);
  validateRestartAndIdempotency(testCase, enums);
  validateAllowancesAndRisk(testCase, enums);
}

function validateFixtureCollections(stateFixtureDocument, aiFixtureDocument) {
  const stateFixtures = asArray(stateFixtureDocument && stateFixtureDocument.fixtures);
  const aiFixtures = asArray(aiFixtureDocument && aiFixtureDocument.fixtures);
  const stateIds = stateFixtures.map((item) => item.fixtureId);
  const aiIds = aiFixtures.map((item) => item.fixtureId);
  duplicateValues(stateIds).forEach((id) => fail(`State fixtureId重复：${id}`));
  duplicateValues(aiIds).forEach((id) => fail(`AI fixtureId重复：${id}`));
  duplicateValues(aiFixtures.filter((item) => item.caseId).map((item) => item.caseId))
    .forEach((id) => fail(`AI fixture caseId重复：${id}`));

  const stateSet = new Set(stateIds);
  const stateFixtureMap = new Map(stateFixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const resolvedStateFixtureMap = new Map();
  const resolving = new Set();
  function resolveStateFixture(fixtureId) {
    if (resolvedStateFixtureMap.has(fixtureId)) return resolvedStateFixtureMap.get(fixtureId);
    if (resolving.has(fixtureId)) {
      fail(`${fixtureId} State fixture继承存在循环`);
      return {};
    }
    const fixture = stateFixtureMap.get(fixtureId);
    if (!fixture) return {};
    resolving.add(fixtureId);
    const base = fixture.extends ? cloneJson(resolveStateFixture(fixture.extends)) : {};
    const resolved = Object.assign(base, cloneJson(fixture.extends ? fixture.patch : fixture.state));
    resolving.delete(fixtureId);
    resolvedStateFixtureMap.set(fixtureId, resolved);
    return resolved;
  }
  stateFixtures.forEach((fixture) => {
    checkString(fixture.fixtureId, 'state fixtureId');
    checkString(fixture.description, `${fixture.fixtureId}.description`);
    if (fixture.extends && !stateSet.has(fixture.extends)) fail(`${fixture.fixtureId} extends不存在：${fixture.extends}`);
    if (!fixture.extends && !isObject(fixture.state)) fail(`${fixture.fixtureId} 根fixture必须包含state`);
    if (fixture.extends && !isObject(fixture.patch)) fail(`${fixture.fixtureId} 派生fixture必须包含patch`);
    const serialized = JSON.stringify(fixture);
    if (containsSensitiveData(serialized)) {
      fail(`${fixture.fixtureId} State fixture包含疑似隐私或密钥`);
    }
    resolveStateFixture(fixture.fixtureId);
  });
  aiFixtures.forEach((fixture) => {
    checkString(fixture.fixtureId, 'AI fixtureId');
    if (!['standard', 'deep'].includes(fixture.reviewMode)) {
      fail(`${fixture.fixtureId} reviewMode必须是standard/deep`);
    }
    if (!['FAKE', 'MOCK', 'REPLAY'].includes(fixture.providerKind)) {
      fail(`${fixture.fixtureId} providerKind必须是FAKE/MOCK/REPLAY`);
    }
    if (fixture.kind === 'REPLAY_RESPONSE' && fixture.sanitized !== true) {
      fail(`${fixture.fixtureId} Replay必须显式sanitized=true`);
    }
    if (fixture.kind === 'REPLAY_RESPONSE' && fixture.capturedFromRealCustomer !== false) {
      fail(`${fixture.fixtureId} Replay必须显式capturedFromRealCustomer=false`);
    }
    const serialized = JSON.stringify(fixture);
    if (containsSensitiveData(serialized)) {
      fail(`${fixture.fixtureId} AI fixture包含疑似隐私或密钥`);
    }
  });
  return {
    stateFixtureIds: stateSet,
    resolvedStateFixtureMap,
    aiFixtureIds: new Set(aiIds),
    aiFixtureMap: new Map(aiFixtures.map((fixture) => [fixture.fixtureId, fixture]))
  };
}

function loadCases() {
  if (!fs.existsSync(CASE_ROOT)) {
    fail('tests/record-e2e/cases/core-v1 不存在');
    return { files: [], cases: [] };
  }
  const files = fs.readdirSync(CASE_ROOT)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const cases = [];
  files.forEach((fileName) => {
    const document = readJson(path.join(CASE_ROOT, fileName));
    if (!document) return;
    if (document.schemaVersion !== 'record-e2e-case-file-v1') fail(`${fileName} case file schemaVersion错误`);
    if (!Array.isArray(document.cases)) {
      fail(`${fileName}.cases必须是数组`);
      return;
    }
    document.cases.forEach((testCase) => {
      Object.defineProperty(testCase, '__file', { value: fileName, enumerable: false });
      cases.push(testCase);
    });
  });
  return { files, cases };
}

function loadSupplementalCases() {
  if (!fs.existsSync(SUPPLEMENTAL_CASE_ROOT)) return { files: [], cases: [] };
  const manifestFiles = fs.readdirSync(SUPPLEMENTAL_CASE_ROOT)
    .filter((name) => name.endsWith('.manifest.json'))
    .sort();
  const files = [];
  const cases = [];
  manifestFiles.forEach((manifestFile) => {
    const manifest = readJson(path.join(SUPPLEMENTAL_CASE_ROOT, manifestFile));
    if (!manifest) return;
    if (manifest.schemaVersion !== 'record-e2e-supplemental-manifest-v1'
      || manifest.includeInCoreCount !== false
      || !Array.isArray(manifest.caseFiles)
      || !Array.isArray(manifest.caseIds)) {
      fail(`${manifestFile} 补充Case manifest错误`);
      return;
    }
    const manifestCases = [];
    manifest.caseFiles.forEach((fileName) => {
      if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) {
        fail(`${manifestFile} 包含非法Case路径：${fileName}`);
        return;
      }
      files.push(fileName);
      const document = readJson(path.join(SUPPLEMENTAL_CASE_ROOT, fileName));
      if (!document || !Array.isArray(document.cases)) {
        fail(`${fileName}.cases必须是数组`);
        return;
      }
      document.cases.forEach((testCase) => {
        Object.defineProperty(testCase, '__file', { value: fileName, enumerable: false });
        manifestCases.push(testCase);
        cases.push(testCase);
      });
    });
    const ids = manifestCases
      .filter((item) => item.status === 'ACTIVE')
      .map((item) => item.caseId);
    if (ids.length !== manifest.exactActiveCaseCount
      || canonicalJson(ids) !== canonicalJson(manifest.caseIds)) {
      fail(`${manifestFile} 补充Case集合与manifest不一致`);
    }
  });
  return { files, cases };
}

function countBy(cases, selector) {
  return cases.reduce((result, testCase) => {
    const values = asArray(selector(testCase));
    values.forEach((value) => {
      const key = String(value);
      result[key] = (result[key] || 0) + 1;
    });
    return result;
  }, {});
}

function validateDuplicates(cases) {
  const exact = new Map();
  const skeletons = new Map();
  cases.forEach((testCase) => {
    const normalized = normalizeText(testCase.input.originalText, testCase.input.channel);
    if (!exact.has(normalized)) exact.set(normalized, []);
    exact.get(normalized).push(testCase.caseId);
    const skeletonKey = [
      testCase.category,
      testCase.input.channel,
      proposalOf(testCase).businessType,
      proposalOf(testCase).operation,
      testCase.initialState.fixtureRef,
      testCase.expected.route,
      testCase.expected.save.status,
      literalSkeleton(testCase.input.originalText)
    ].join('|');
    if (!skeletons.has(skeletonKey)) skeletons.set(skeletonKey, []);
    skeletons.get(skeletonKey).push(testCase.caseId);
  });
  const exactDuplicates = Array.from(exact.values()).filter((ids) => ids.length > 1);
  exactDuplicates.forEach((ids) => fail(`规范化原文重复：${ids.join(', ')}`));
  const lowValue = Array.from(skeletons.values()).filter((ids) => ids.length > 1);
  lowValue.forEach((ids) => warn(`疑似仅换数字/字面量重复：${ids.join(', ')}`));
  return {
    normalizedUniqueCount: exact.size,
    skeletonUniqueCount: skeletons.size,
    suspiciousLowValueCount: lowValue.length,
    largestSkeletonCluster: Math.max(0, ...Array.from(skeletons.values()).map((ids) => ids.length))
  };
}

function validateCoverage(cases, decisions, indexDocument) {
  const active = cases.filter((testCase) => testCase.status === 'ACTIVE');
  const categoryCounts = countBy(active, (item) => [item.category]);
  const riskCounts = countBy(active, (item) => [item.riskLevel]);
  const profileCounts = countBy(active, (item) => item.executionProfiles);
  const laneCounts = countBy(active, (item) => item.execution.lanes);
  if (active.length !== 120) fail(`ACTIVE题必须为120，实际${active.length}`);
  Object.entries(EXPECTED_CATEGORY_COUNTS).forEach(([category, expected]) => {
    if ((categoryCounts[category] || 0) !== expected) {
      fail(`${category}必须${expected}题，实际${categoryCounts[category] || 0}`);
    }
  });
  if ((riskCounts.P0 || 0) < 40) fail(`P0必须>=40，实际${riskCounts.P0 || 0}`);
  if ((riskCounts.P1 || 0) < 50) fail(`P1必须>=50，实际${riskCounts.P1 || 0}`);
  if ((riskCounts.P2 || 0) > 30) fail(`P2必须<=30，实际${riskCounts.P2 || 0}`);
  if ((profileCounts.REAL_QWEN_QUALITY || 0) < 50) {
    fail(`REAL_QWEN_QUALITY必须>=50，实际${profileCounts.REAL_QWEN_QUALITY || 0}`);
  }
  if ((profileCounts.PAGE_E2E || 0) < 40) {
    fail(`PAGE_E2E必须>=40，实际${profileCounts.PAGE_E2E || 0}`);
  }
  Object.entries(EXPECTED_EXECUTION_LANE_COUNTS).forEach(([lane, expected]) => {
    if ((laneCounts[lane] || 0) !== expected) {
      fail(`${lane}必须${expected}题，实际${laneCounts[lane] || 0}`);
    }
  });
  const page008 = active.find((item) => item.caseId === 'REC-E2E-PAGE-008');
  if (!page008 || !page008.knownRisk || page008.knownRisk.riskId !== 'HOME_ITEM0_EDIT_SYNC') {
    fail('必须包含REC-E2E-PAGE-008首页items[0]同步静态P0候选题');
  }

  const decisionItems = asArray(decisions && decisions.decisions);
  if (decisionItems.length > 20) fail(`产品决策待办最多20项，实际${decisionItems.length}`);
  decisionItems.forEach((item, index) => {
    ['decisionId', 'inputExample', 'currentPossibleBehaviors', 'risk',
      'whyContractIsInsufficient', 'recommendedQuestionForOwner'].forEach((key) => {
      if (!item || !Object.prototype.hasOwnProperty.call(item, key)) {
        fail(`产品决策待办[${index}].${key}缺失`);
      }
    });
    const serialized = JSON.stringify(item);
    if (containsSensitiveData(serialized)) {
      fail(`产品决策待办[${index}]包含疑似隐私或密钥`);
    }
  });

  if (!indexDocument || indexDocument.schemaVersion !== 'record-e2e-corpus-index-v1') {
    fail('corpus-index-v1.json schemaVersion错误');
  } else {
    if (indexDocument.activeCaseCount !== 120) fail('corpus index activeCaseCount必须为120');
    if (indexDocument.caseSchemaVersion !== 'record-e2e-case-v1.2') {
      fail('corpus index caseSchemaVersion错误');
    }
    if (indexDocument.executionBoundaryContractVersion !== 'record-e2e-execution-boundary-v1') {
      fail('corpus index executionBoundaryContractVersion错误');
    }
    if (JSON.stringify(indexDocument.expectedCategoryCounts) !== JSON.stringify(EXPECTED_CATEGORY_COUNTS)) {
      fail('corpus index分类配额与Validator不一致');
    }
    if (!indexDocument.stateDiffCollectionMap
      || indexDocument.stateDiffCollectionMap.payments !== 'paymentRecords') {
      fail('corpus index必须显式声明State Diff payments到State paymentRecords的映射');
    }
    if (!indexDocument.resultToStateFieldMap
      || indexDocument.resultToStateFieldMap.receivableAmount !== 'receivables[].amount') {
      fail('corpus index必须显式声明receivableAmount到receivables[].amount的映射');
    }
    if (indexDocument.observationSemanticsContractVersion
      !== 'record-e2e-observation-semantics-v1') {
      fail('corpus index observationSemanticsContractVersion错误');
    }
    if (indexDocument.expectedResultLayer
      !== 'RAW_SEMANTIC_PROPOSAL_OUTCOME_SEPARATED_WITH_V1_1_LEGACY_COMPATIBILITY') {
      fail('corpus index必须固定四层观察语义与V1.1兼容边界');
    }
    if (indexDocument.observationSemanticsMigratedCaseCount
      !== OBSERVATION_SEMANTICS_CASE_IDS.length) {
      fail('corpus index observationSemantics迁移数量必须为25');
    }
    if (JSON.stringify(indexDocument.expectedExecutionLaneCounts) !== JSON.stringify(EXPECTED_EXECUTION_LANE_COUNTS)) {
      fail('corpus index execution lane配额与Validator不一致');
    }
  }
  return { active, categoryCounts, riskCounts, profileCounts, laneCounts, decisionItems };
}

function printMap(title, map, preferredOrder = []) {
  console.log(`\n${title}`);
  const keys = unique(preferredOrder.concat(Object.keys(map).sort()));
  keys.filter((key) => map[key] !== undefined).forEach((key) => {
    console.log(`  ${key}: ${map[key]}`);
  });
}

function captureValidationFailures(callback) {
  const outerFailures = failures;
  failures = [];
  try {
    callback();
  } catch (error) {
    failures.push(`校验抛出异常：${error.message}`);
  }
  const captured = failures.slice();
  failures = outerFailures;
  return captured;
}

function runExecutionBoundaryContractSelfTests(cases, enums, resolvedStateFixtureMap) {
  const results = [];
  const casesFingerprintBefore = canonicalJson(cases);
  const inputsFingerprintBefore = canonicalJson(cases.map((item) => item.input));
  const expectedFingerprintBefore = canonicalJson(cases.map((item) => item.expected));
  function expectMutationFailure(name, sourceCase, mutate, validator) {
    const candidate = cloneJson(sourceCase);
    mutate(candidate);
    const captured = captureValidationFailures(() => validator(candidate));
    if (!captured.length) {
      fail(`合同自测未拦截：${name}`);
      results.push({ name, passed: false });
    } else {
      results.push({ name, passed: true });
    }
  }
  function expectValidationPass(name, sourceCase, validator) {
    const candidate = cloneJson(sourceCase);
    const captured = captureValidationFailures(() => validator(candidate));
    if (captured.length) {
      fail(`合同自测误拒绝：${name}：${captured.join('；')}`);
      results.push({ name, passed: false });
    } else {
      results.push({ name, passed: true });
    }
  }

  const safeFake = cases.find((item) => (
    NON_REAL_AI_PROFILES.has(item.ai.profile)
    && item.expected.isolatedExecution.status === 'TEST_ONLY_ISOLATED_COMMITTED'
  ));
  const blocked = cases.find((item) => item.expected.save.status === 'BLOCKED');
  const orderSelection = cases.find((item) => item.caseId === 'REC-E2E-BASIC-010');
  const exactReplay = cases.find((item) => item.caseId === 'REC-E2E-PERSIST-003');
  const tamperCrossCustomer = cases.find((item) => item.caseId === 'REC-E2E-REL-007');
  const tamperConverted = cases.find((item) => item.caseId === 'REC-E2E-REL-008');
  const semanticFormal = cases.find((item) => item.caseId === 'REC-E2E-BASIC-001');
  const semanticPending = cases.find((item) => item.caseId === 'REC-E2E-BASIC-019');
  const protectedParser = cases.find((item) => item.caseId === 'REC-E2E-BASIC-006');
  const localSurfaceComplete = cases.find((item) => item.caseId === 'REC-E2E-BASIC-001');
  const surfaceBlocked = cases.find((item) => item.caseId === 'REC-E2E-PAGE-002');
  const providerBlocked = cases.find((item) => item.caseId === 'REC-E2E-VOICE-006');
  const businessBlocked = cases.find((item) => item.caseId === 'REC-E2E-VOICE-004');
  const noRecord = cases.find((item) => item.caseId === 'REC-E2E-AMB-005');
  const legacyProviderSurface = cases.find((item) => item.caseId === 'REC-E2E-VOICE-010');
  if (!safeFake || !blocked || !orderSelection || !exactReplay
    || !tamperCrossCustomer || !tamperConverted || !semanticFormal
    || !semanticPending || !protectedParser || !localSurfaceComplete
    || !surfaceBlocked || !providerBlocked || !businessBlocked || !noRecord
    || !legacyProviderSurface) {
    fail('合同自测基础Case缺失');
    return results;
  }
  const validateLayeredSurfaceEligibility = (item) => {
    validateSurface(item, enums);
    validateExecutionBoundaries(item, enums);
  };

  expectMutationFailure(
    'pending不得写成canonical businessType',
    semanticPending,
    (item) => {
      item.expected.observationSemantics.semanticResult.businessType = 'pending';
      item.expected.observationSemantics.proposal.result.businessType = 'pending';
      item.expected.observationSemantics.semanticResult.effectiveOperation = 'pending';
      item.expected.observationSemantics.proposal.result.operation = 'pending';
    },
    (item) => validateObservationSemantics(item, enums)
  );
  expectMutationFailure(
    'RAW_PARSER强断言缺operation',
    semanticFormal,
    (item) => {
      item.expected.observationSemantics.rawParser = {
        assertionScope: 'REQUIRED',
        businessType: 'order',
        intent: 'order'
      };
    },
    (item) => validateObservationSemantics(item, enums)
  );
  expectMutationFailure(
    'FORMAL_RECORD缺正式State Diff',
    semanticFormal,
    (item) => {
      Object.keys(item.expected.stateDiff.business.collections).forEach((collection) => {
        item.expected.stateDiff.business.collections[collection] = {
          createdCount: 0,
          deletedCount: 0,
          updatedCount: 0
        };
      });
    },
    (item) => validateObservationSemantics(item, enums)
  );
  expectMutationFailure(
    'PENDING_NOTE缺pending Diff',
    semanticPending,
    (item) => {
      item.expected.stateDiff.business.collections.pendingNotes = {
        createdCount: 0,
        deletedCount: 0,
        updatedCount: 0
      };
    },
    (item) => validateObservationSemantics(item, enums)
  );
  expectMutationFailure(
    'PENDING_NOTE产生正式订单',
    semanticPending,
    (item) => {
      item.expected.stateDiff.business.collections.orders = {
        createdCount: 1,
        deletedCount: 0,
        updatedCount: 0
      };
    },
    (item) => validateObservationSemantics(item, enums)
  );
  expectMutationFailure(
    'raw null operation不得自动等于semantic none',
    semanticFormal,
    (item) => {
      item.expected.observationSemantics.semanticResult.businessType = 'unknown';
      item.expected.observationSemantics.semanticResult.effectiveOperation = 'none';
    },
    (item) => validateObservationSemantics(item, enums)
  );
  const parserProtectionPreserved = !observationOf(protectedParser)
    && protectedParser.expected.rawParser
    && protectedParser.expected.rawParser.assertionScope === 'REQUIRED';
  if (!parserProtectionPreserved) {
    fail('BASIC-006不得迁入观测语义假差异清单且必须保留raw合同');
  }
  results.push({
    name: 'BASIC-006修复后仍保留RAW_PARSER强合同',
    passed: parserProtectionPreserved
  });

  expectValidationPass(
    '完整LOCAL Surface与生产资格组合合法',
    localSurfaceComplete,
    validateLayeredSurfaceEligibility
  );
  expectValidationPass(
    'Surface业务能力不足与BLOCKED_SURFACE组合合法',
    surfaceBlocked,
    validateLayeredSurfaceEligibility
  );
  expectValidationPass(
    'Surface能力完整但Fake Provider阻断组合合法',
    providerBlocked,
    validateLayeredSurfaceEligibility
  );
  expectValidationPass(
    'Provider阻断保持页面正式保存禁用',
    providerBlocked,
    validateLayeredSurfaceEligibility
  );
  expectValidationPass(
    '业务Preflight阻断优先于Provider资格',
    businessBlocked,
    validateLayeredSurfaceEligibility
  );
  expectValidationPass(
    'NO_RECORD保持独立生产资格',
    noRecord,
    validateLayeredSurfaceEligibility
  );
  expectValidationPass(
    '旧Fake Surface能力表达保持兼容且生产仍阻断',
    legacyProviderSurface,
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Surface能力false不得effective true',
    providerBlocked,
    (item) => {
      item.expected.surface.fullPage.surfaceCanCompleteFormal = false;
      item.expected.surface.fullPage.effectiveCanSaveFormal = true;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'CAN_COMPLETE不得effective false',
    providerBlocked,
    (item) => {
      item.expected.surface.fullPage.status = 'CAN_COMPLETE';
      item.expected.surface.fullPage.effectiveCanSaveFormal = false;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Surface能力完整不得标BLOCKED_SURFACE',
    providerBlocked,
    (item) => {
      item.expected.productionObservation.productionEligibility = 'BLOCKED_SURFACE';
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Surface能力不足不得标BLOCKED_NON_REAL_PROVIDER',
    surfaceBlocked,
    (item) => {
      item.expected.productionObservation.productionEligibility = 'BLOCKED_NON_REAL_PROVIDER';
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Provider阻断不得缺失不可信Provider码',
    providerBlocked,
    (item) => {
      item.expected.productionObservation.blockingCodes = [];
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Provider阻断不得允许页面正式保存',
    providerBlocked,
    (item) => {
      item.expected.productionObservation.pageFormalSaveAllowed = true;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'BLOCKED状态不得effective true',
    providerBlocked,
    (item) => {
      item.expected.surface.fullPage.effectiveCanSaveFormal = true;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'LOCAL CAN_COMPLETE不得关闭pageFormalSaveAllowed',
    localSurfaceComplete,
    (item) => {
      item.expected.productionObservation.pageFormalSaveAllowed = false;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'ELIGIBLE_LOCAL不得与选中Surface阻断共存',
    localSurfaceComplete,
    (item) => {
      item.expected.surface.home.status = 'BLOCKED';
      item.expected.surface.home.effectiveCanSaveFormal = false;
      item.expected.productionObservation.pageFormalSaveAllowed = false;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    '当前选中的页面Surface不得NOT_APPLICABLE',
    providerBlocked,
    (item) => {
      item.expected.surface.fullPage.status = 'NOT_APPLICABLE';
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    '未知productionEligibility必须拒绝',
    providerBlocked,
    (item) => {
      item.expected.productionObservation.productionEligibility = 'BLOCKED_UNKNOWN';
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Surface合同缺effectiveCanSaveFormal必须拒绝',
    providerBlocked,
    (item) => {
      delete item.expected.surface.fullPage.effectiveCanSaveFormal;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'REQUIRES_FULL_PAGE不得声称Surface能力完整',
    surfaceBlocked,
    (item) => {
      item.expected.surface.home.surfaceCanCompleteFormal = true;
    },
    validateLayeredSurfaceEligibility
  );
  expectMutationFailure(
    'Fake Provider不得伪装LOCAL Provider分类',
    providerBlocked,
    (item) => {
      item.expected.productionObservation.providerClassification = 'TEST_LOCAL_ONLY';
    },
    validateLayeredSurfaceEligibility
  );
  const layeredValidatorCaseIdIndependent = !/REC-E2E-/.test(
    `${selectedSurfaceExpectation.toString()}${validateSelectedSurfaceState.toString()}`
  );
  if (!layeredValidatorCaseIdIndependent) {
    fail('Surface/productionEligibility分层Validator不得读取Case ID');
  }
  results.push({
    name: 'Surface分层Validator不按Case ID特判',
    passed: layeredValidatorCaseIdIndependent
  });

  expectMutationFailure(
    'Fake生产资格错误标为ELIGIBLE',
    safeFake,
    (item) => { item.expected.productionObservation.productionEligibility = 'ELIGIBLE_LOCAL'; },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    'Fake隔离执行未标TEST_ONLY',
    safeFake,
    (item) => { item.expected.isolatedExecution.marker = 'FORMAL_PRODUCTION_COMMIT'; },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '业务安全阻断题强开正式隔离提交',
    blocked,
    (item) => {
      item.execution.lanes.push('TEST_ONLY_ISOLATED_LEGACY_COMMIT');
      item.expected.isolatedExecution = {
        enabled: true,
        action: 'SAVE_FORMAL',
        status: 'TEST_ONLY_ISOLATED_COMMITTED',
        marker: 'TEST_ONLY_ISOLATED_COMMIT',
        source: item.input.entrySurface === 'HEADLESS'
          ? 'HEADLESS_PRODUCTION_DERIVED_CONFIRMED_DRAFT'
          : 'PAGE_DERIVED_CONFIRMED_DRAFT',
        sourceLane: item.input.entrySurface === 'HEADLESS'
          ? 'HEADLESS_PRODUCTION_OBSERVATION'
          : 'PAGE_PRODUCTION_OBSERVATION',
        target: 'ISOLATED_LEGACY_STORE',
        stateDiff: 'EXPECTED_STATE_DIFF'
      };
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    'userSelections缺requiredCapability',
    orderSelection,
    (item) => {
      item.interaction.requiredCapabilities = item.interaction.requiredCapabilities
        .filter((capability) => capability !== 'SELECT_ORDER');
    },
    (item) => validateInteraction(item, enums)
  );
  expectMutationFailure(
    '订单选择缺口错误标为Runner BLOCKED',
    orderSelection,
    (item) => { item.execution.missingCapabilityDisposition = 'BLOCKED'; },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    'exact replay缺首次隔离提交lane',
    exactReplay,
    (item) => {
      item.execution.lanes = item.execution.lanes
        .filter((lane) => lane !== 'TEST_ONLY_ISOLATED_LEGACY_COMMIT');
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    'exact replay伪装第二次页面保存',
    exactReplay,
    (item) => {
      item.interaction.sequence = item.interaction.sequence.map((step) => (
        step.step === 'REPLAY_EXACT_TRANSACTION'
          ? { step: 'COMMIT', planRef: step.planRef, actor: 'SECOND_PAGE_CLICK' }
          : step
      ));
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '执行lane缺Expected',
    safeFake,
    (item) => { delete item.expected.isolatedExecution; },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '可提交业务静默关闭隔离lane',
    safeFake,
    (item) => {
      item.execution.lanes = item.execution.lanes
        .filter((lane) => lane !== 'TEST_ONLY_ISOLATED_LEGACY_COMMIT');
      item.execution.draftSourceSurface = 'NOT_APPLICABLE';
      item.expected.isolatedExecution = {
        enabled: false,
        action: item.expected.save.action,
        status: 'BLOCKED',
        marker: 'NOT_APPLICABLE',
        source: 'NOT_APPLICABLE',
        sourceLane: 'NOT_APPLICABLE',
        target: 'NONE',
        stateDiff: 'ZERO_SIDE_EFFECTS'
      };
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    'exact replay更换planRef',
    exactReplay,
    (item) => {
      item.interaction.sequence = item.interaction.sequence.map((step) => (
        step.step === 'REPLAY_EXACT_TRANSACTION'
          ? Object.assign({}, step, { planRef: 'different-plan' })
          : step
      ));
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '危险relation injection缺专用Lane',
    tamperCrossCustomer,
    (item) => {
      item.execution.lanes = item.execution.lanes.filter((lane) => (
        lane !== 'RELATION_REFERENCE_TAMPER_GUARD'
      ));
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '危险relation injection缺具体ID',
    tamperCrossCustomer,
    (item) => { item.execution.relationReferenceTamper.injectedId = ''; },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '危险quotationId混入用户选择',
    tamperCrossCustomer,
    (item) => {
      item.interaction.userSelections.push({
        kind: 'quotationId',
        selectedId: item.execution.relationReferenceTamper.injectedId
      });
      item.interaction.requiredCapabilities.push('SELECT_QUOTATION');
    },
    (item) => {
      validateInteraction(item, enums);
      validateExecutionBoundaries(item, enums);
    }
  );
  expectMutationFailure(
    '危险quotationId错误声明为安全候选',
    tamperCrossCustomer,
    (item) => {
      item.expected.relationReferenceTamper
        .injectedReferenceExcludedFromSafeCandidates = false;
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '危险关系Lane错误允许正式保存',
    tamperCrossCustomer,
    (item) => {
      item.expected.relationReferenceTamper.domainCanSaveFormal = true;
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '危险关系Lane缺零正式副作用',
    tamperCrossCustomer,
    (item) => {
      item.expected.stateDiff.business.collections.customers = {
        createdCount: 1,
        updatedCount: 0,
        deletedCount: 0
      };
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '跨客户引用缺客户不匹配码',
    tamperCrossCustomer,
    (item) => {
      item.expected.relationReferenceTamper.blockingCodes = [
        'QUOTATION_ALREADY_CONVERTED'
      ];
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '已转报价引用缺重复转换阻断码',
    tamperConverted,
    (item) => {
      item.expected.relationReferenceTamper.blockingCodes = [
        'QUOTATION_CUSTOMER_MISMATCH'
      ];
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '跨客户引用同步篡改两层阻断码仍必须失败',
    tamperCrossCustomer,
    (item) => {
      item.expected.relationReferenceTamper.blockingCodes = [
        'QUOTATION_ALREADY_CONVERTED'
      ];
      item.expected.preflight.blockingCodes = [
        'QUOTATION_ALREADY_CONVERTED'
      ];
    },
    (item) => validateStateReferences(item, resolvedStateFixtureMap)
  );
  expectMutationFailure(
    '已转引用同步篡改两层阻断码仍必须失败',
    tamperConverted,
    (item) => {
      item.expected.relationReferenceTamper.blockingCodes = [
        'QUOTATION_CUSTOMER_MISMATCH'
      ];
      item.expected.preflight.blockingCodes = [
        'QUOTATION_CUSTOMER_MISMATCH'
      ];
    },
    (item) => validateStateReferences(item, resolvedStateFixtureMap)
  );
  expectMutationFailure(
    '危险关系Lane混用SELECT_QUOTATION能力',
    tamperConverted,
    (item) => {
      item.interaction.requiredCapabilities.push('SELECT_QUOTATION');
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  expectMutationFailure(
    '危险quotationId在底稿中预注入',
    tamperConverted,
    (item) => {
      item.execution.relationReferenceTamper.baseDraft.fields.quotationId
        = item.execution.relationReferenceTamper.injectedId;
    },
    (item) => validateExecutionBoundaries(item, enums)
  );
  const originalTextCase = cases.find((item) => (
    (item.expected.stateDiff.business.fieldAssertions || [])
      .some((assertion) => assertion.path === 'originalText')
  ));
  if (!originalTextCase) {
    fail('合同自测缺少originalText State Diff基础Case');
  } else {
    expectMutationFailure(
      'State Diff originalText与输入原文矛盾',
      originalTextCase,
      (item) => {
        const assertion = item.expected.stateDiff.business.fieldAssertions
          .find((entry) => entry.path === 'originalText');
        assertion.value = `${item.input.originalText}（错误）`;
      },
      (item) => validateDiff(item, enums)
    );
  }

  const knownGapFailures = Object.keys(KNOWN_PAGE_CAPABILITY_GAPS).flatMap((caseId) => {
    const item = cases.find((candidate) => candidate.caseId === caseId);
    if (!item) return [`${caseId}缺失`];
    return captureValidationFailures(() => {
      validateInteraction(item, enums);
      validateExecutionBoundaries(item, enums);
    });
  });
  if (knownGapFailures.length) {
    fail(`合同自测未能正向表达页面能力缺口：${knownGapFailures.join('；')}`);
    results.push({ name: '缺失页面能力可表达为CASE_FAIL/SURFACE_ERROR', passed: false });
  } else {
    results.push({ name: '缺失页面能力可表达为CASE_FAIL/SURFACE_ERROR', passed: true });
  }

  const allMigrated = cases.length === 120 && cases.every((item) => (
    item.schemaVersion === 'record-e2e-case-v1.2'
    && item.execution
    && Array.isArray(item.execution.lanes)
    && item.execution.lanes.length
    && item.expected.productionObservation
    && item.expected.isolatedExecution
  ));
  if (!allMigrated) fail('合同自测：120条ACTIVE未全部迁移执行边界');
  results.push({ name: '120条ACTIVE迁移完整', passed: allMigrated });
  const casesImmutable = canonicalJson(cases) === casesFingerprintBefore;
  const inputsImmutable = canonicalJson(cases.map((item) => item.input)) === inputsFingerprintBefore;
  const expectedImmutable = canonicalJson(cases.map((item) => item.expected)) === expectedFingerprintBefore;
  if (!casesImmutable) fail('合同自测不得修改Case对象');
  if (!inputsImmutable) fail('合同自测不得修改Validator输入');
  if (!expectedImmutable) fail('合同自测不得修改Expected对象');
  results.push({ name: 'Validator专项不修改Case对象', passed: casesImmutable });
  results.push({ name: 'Validator专项不修改输入对象', passed: inputsImmutable });
  results.push({ name: 'Validator专项不修改Expected对象', passed: expectedImmutable });
  return results;
}

function main() {
  const enums = readJson(ENUM_PATH);
  const schema = readJson(SCHEMA_PATH);
  const stateFixtures = readJson(STATE_FIXTURE_PATH);
  const aiFixtures = readJson(AI_FIXTURE_PATH);
  const decisions = readJson(DECISION_PATH);
  const indexDocument = readJson(INDEX_PATH);
  if (!enums || !schema || !stateFixtures || !aiFixtures) {
    throw new Error('基础合同文件无法加载');
  }
  if (schema.$id !== 'record-e2e-case-v1.2.schema.json') fail('JSON Schema $id错误');
  if (enums.schemaVersion !== 'record-e2e-enums-v1.2'
    || enums.caseSchemaVersion !== 'record-e2e-case-v1.2'
    || enums.observationSemanticsVersion !== 'record-e2e-observation-semantics-v1'
    || enums.executionBoundaryVersion !== 'record-e2e-execution-boundary-v1') {
    fail('执行边界枚举版本错误');
  }
  const fixtureContext = validateFixtureCollections(stateFixtures, aiFixtures);
  const loaded = loadCases();
  const supplemental = loadSupplementalCases();
  const caseValidationContext = {
    enums,
    schema,
    stateFixtureIds: fixtureContext.stateFixtureIds,
    resolvedStateFixtureMap: fixtureContext.resolvedStateFixtureMap,
    aiFixtureIds: fixtureContext.aiFixtureIds,
    aiFixtureMap: fixtureContext.aiFixtureMap
  };
  loaded.cases.forEach((testCase) => validateCase(testCase, caseValidationContext));
  supplemental.cases.forEach((testCase) => validateCase(testCase, caseValidationContext));
  duplicateValues(loaded.cases.concat(supplemental.cases).map((item) => item.caseId))
    .forEach((caseId) => fail(`caseId重复：${caseId}`));
  const duplicateStats = validateDuplicates(loaded.cases);
  const coverage = validateCoverage(loaded.cases, decisions, indexDocument);
  const selfTestResults = process.argv.includes('--contract-self-test')
    ? runExecutionBoundaryContractSelfTests(
      coverage.active,
      enums,
      fixtureContext.resolvedStateFixtureMap
    )
    : [];

  const active = coverage.active;
  const channelCounts = countBy(active, (item) => [item.input.channel]);
  const surfaceCounts = countBy(active, (item) => [item.input.entrySurface]);
  const businessTypeCounts = countBy(active, (item) => [proposalOf(item).businessType]);
  const routeCounts = countBy(active, (item) => [item.expected.route]);
  const saveCounts = countBy(active, (item) => [item.expected.save.status]);
  const fixtureCounts = countBy(active, (item) => [item.initialState.fixtureRef]);
  const capabilityCounts = countBy(active, (item) => item.interaction.requiredCapabilities);
  const isolatedEnabledCount = active.filter((item) => item.expected.isolatedExecution.enabled).length;
  const providerBlockedButIsolatedCount = active.filter((item) => (
    item.expected.productionObservation.productionEligibility === 'BLOCKED_NON_REAL_PROVIDER'
    && item.expected.isolatedExecution.enabled
  )).length;
  const businessBlockedAndIsolatedForbiddenCount = active.filter((item) => (
    ['BLOCKED_BUSINESS_SAFETY', 'NO_RECORD'].includes(
      item.expected.productionObservation.productionEligibility
    )
    && !item.expected.isolatedExecution.enabled
  )).length;

  console.log('Record E2E Corpus V1 校验与覆盖统计');
  console.log(`  JSON case files: ${loaded.files.length}`);
  console.log(`  Supplemental ACTIVE题数: ${supplemental.cases.filter((item) => item.status === 'ACTIVE').length}`);
  console.log(`  总ACTIVE题数: ${active.length}`);
  console.log(`  State fixtures: ${fixtureContext.stateFixtureIds.size}`);
  console.log(`  AI fixtures: ${fixtureContext.aiFixtureIds.size}`);
  console.log(`  产品决策待办数量: ${coverage.decisionItems.length}`);
  console.log(`  规范化原文唯一数: ${duplicateStats.normalizedUniqueCount}`);
  console.log(`  结构skeleton唯一数: ${duplicateStats.skeletonUniqueCount}`);
  console.log(`  疑似低价值题簇: ${duplicateStats.suspiciousLowValueCount}`);
  console.log(`  最大skeleton簇: ${duplicateStats.largestSkeletonCluster}`);
  printMap('各分类题数', coverage.categoryCounts, Object.keys(EXPECTED_CATEGORY_COUNTS));
  printMap('P0/P1/P2数量', coverage.riskCounts, ['P0', 'P1', 'P2']);
  printMap('各inputChannel数量', channelCounts, enums.inputChannels);
  printMap('各entrySurface数量', surfaceCounts, enums.entrySurfaces);
  printMap('各executionProfile数量', coverage.profileCounts, enums.executionProfiles);
  printMap('各execution lane数量', coverage.laneCounts, enums.executionLanes);
  printMap('requiredCapability各类型数量', capabilityCounts, enums.requiredCapabilities);
  printMap('各businessType数量', businessTypeCounts, enums.businessTypes);
  printMap('各route预期数量', routeCounts, enums.routes);
  printMap('正式保存/待整理/阻断数量', saveCounts, enums.saveStatuses);
  printMap('使用各initialState fixture数量', fixtureCounts);
  console.log(`\nREAL_QWEN_QUALITY数量: ${coverage.profileCounts.REAL_QWEN_QUALITY || 0}`);
  console.log(`PAGE_E2E数量: ${coverage.profileCounts.PAGE_E2E || 0}`);
  console.log(`启用TEST_ONLY_ISOLATED_COMMIT数量: ${isolatedEnabledCount}`);
  console.log(`生产资格阻断但隔离执行允许数量: ${providerBlockedButIsolatedCount}`);
  console.log(`业务安全阻断且隔离执行禁止数量: ${businessBlockedAndIsolatedForbiddenCount}`);
  console.log(`SELECT_ORDER Case数量: ${capabilityCounts.SELECT_ORDER || 0}`);
  console.log(`SELECT_QUOTATION Case数量: ${capabilityCounts.SELECT_QUOTATION || 0}`);
  console.log(`RELATION_REFERENCE_TAMPER_GUARD数量: ${coverage.laneCounts.RELATION_REFERENCE_TAMPER_GUARD || 0}`);
  console.log(`TRANSACTION_EXACT_REPLAY数量: ${coverage.laneCounts.TRANSACTION_EXACT_REPLAY || 0}`);
  console.log(`RESTART_PERSISTENCE数量: ${coverage.laneCounts.RESTART_PERSISTENCE || 0}`);
  console.log(`CONCURRENT_BASE_REVISION数量: ${coverage.laneCounts.CONCURRENT_BASE_REVISION || 0}`);
  console.log(`产品决策待办数量: ${coverage.decisionItems.length}`);
  console.log(`重复或疑似低价值题数量: ${duplicateStats.suspiciousLowValueCount}`);
  if (selfTestResults.length) {
    console.log(`合同自测: ${selfTestResults.filter((item) => item.passed).length}/${selfTestResults.length}`);
    selfTestResults.forEach((item) => console.log(`  ${item.passed ? 'PASS' : 'FAIL'} ${item.name}`));
  }

  if (warnings.length) {
    console.log('\n警告');
    warnings.forEach((message) => console.log(`  WARN ${message}`));
  }
  if (failures.length) {
    console.error(`\n校验失败：${failures.length}项`);
    failures.forEach((message) => console.error(`  FAIL ${message}`));
    process.exitCode = 1;
    return;
  }
  console.log('\n校验通过：120条ACTIVE合成题符合Record E2E Case V1.2四层观察语义合同。');
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
