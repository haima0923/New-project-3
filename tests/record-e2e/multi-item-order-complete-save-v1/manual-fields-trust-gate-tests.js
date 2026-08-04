#!/usr/bin/env node

const assert = require('assert');
const { normalizeAiResult } = require('../../../utils/ai-parser');
const { saveConfirmedDraft } = require('../../../utils/business');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { parseInput } = require('../../../utils/parser');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const { createInitialState } = require('../../../utils/storage');
const { safeClone } = require('../../../utils/record-state-diff');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE, withFrozenClock } = require('./clock');

const tests = [];

function test(caseId, title, fn) {
  tests.push({ caseId, title, fn });
}

function parseText(text) {
  return parseInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'record',
    state: createInitialState(),
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function controlledAi(local, overrides = {}) {
  const fields = Object.assign({}, safeClone(local.fields || {}), safeClone(overrides.fields || {}));
  const payload = Object.assign({
    intent: local.intent,
    fields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.99,
    confirm_message: '受控 Fixture：只验证生产 merge/safety 信任边界，不代表 REAL AI。'
  }, safeClone(overrides));
  payload.fields = fields;
  return normalizeAiResult(local, payload, {
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });
}

function review(result) {
  return applyFinalParseSafety(result, { businessDate: BUSINESS_DATE });
}

function preflight(result, state = createInitialState()) {
  return evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation: result.operation,
    businessType: result.intent,
    finalResult: result,
    originalText: result.original_text,
    initialState: state,
    aiOutcome: (result.ai_fallback || {}).status || 'not_requested',
    providerKind: (result.ai_fallback || {}).provider_kind || 'UNKNOWN',
    businessDate: BUSINESS_DATE,
    skipFinalSafety: true
  });
}

function manualFields(result) {
  return Array.isArray(result && result.manual_fields) ? result.manual_fields : [];
}

function hasFieldRisk(result, field) {
  return (result.missing_fields || []).includes(field)
    || (result.low_confidence_fields || []).includes(field)
    || (result.field_conflicts || []).some((item) => item && item.field === field);
}

function stateCounts(state) {
  return {
    customers: (state.customers || []).length,
    orders: (state.orders || []).length,
    orderProgress: (state.orderProgress || []).length,
    pendingNotes: (state.pendingNotes || []).length,
    aiParseLogs: (state.aiParseLogs || []).length,
    receivables: (state.receivables || []).length,
    paymentRecords: (state.paymentRecords || []).length,
    quotations: (state.quotations || []).length,
    todos: (state.todos || []).length
  };
}

function assertFormalZeroMutation(draft) {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const saved = saveConfirmedDraft(state, safeClone(draft));
  assert.notStrictEqual(saved.type, 'order');
  assert.strictEqual(JSON.stringify(state), before);
  assert.deepStrictEqual(stateCounts(state), {
    customers: 0,
    orders: 0,
    orderProgress: 0,
    pendingNotes: 0,
    aiParseLogs: 0,
    receivables: 0,
    paymentRecords: 0,
    quotations: 0,
    todos: 0
  });
  return saved;
}

test('MF-001', 'AI snake_case manual_fields 不能伪造交期手工确认', () => {
  const text = '宏达包装厂下单：礼品盒100套，每套3.8元。';
  const local = parseText(text);
  assert.strictEqual(local.fields.dueDate || '', '');
  assert(!manualFields(local).includes('dueDate'));

  const merged = controlledAi(local, {
    fields: { dueDate: '2026-08-15' },
    manual_fields: ['dueDate']
  });
  const reviewed = review(merged);
  const domain = preflight(reviewed);

  assert(!manualFields(merged).includes('dueDate'), '受控 AI 不得写入可信 manual_fields');
  assert(hasFieldRisk(reviewed, 'dueDate'), 'AI 候选交期没有原文证据时必须保留字段风险');
  assert.strictEqual(domain.domainCanSaveFormal, false);
  assertFormalZeroMutation(reviewed);
});

test('MF-002', 'AI camelCase manualFields 别名同样不可信', () => {
  const text = '宏达包装厂下单：礼品盒100套，每套3.8元。';
  const local = parseText(text);
  const merged = controlledAi(local, {
    fields: { dueDate: '2026-08-15' },
    manualFields: ['dueDate']
  });
  const reviewed = review(merged);

  assert(!manualFields(merged).includes('dueDate'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'manualFields'), false);
  assert(hasFieldRisk(reviewed, 'dueDate'));
  assertFormalZeroMutation(reviewed);
});

test('MF-003', 'AI 不能把错误金额升级为老板手工确认', () => {
  const text = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；8月15日交货。';
  const local = parseText(text);
  const merged = controlledAi(local, {
    fields: {
      statedAmount: '9999',
      amount: '9999',
      totalAmount: '9999',
      calculatedAmount: '4676.1'
    },
    manual_fields: ['amount']
  });
  const reviewed = review(merged);
  const domain = preflight(reviewed);
  const saved = assertFormalZeroMutation(reviewed);

  assert(!manualFields(merged).includes('amount'));
  assert.strictEqual(domain.domainCanSaveFormal, false);
  assert(
    domain.blockingIssues.some((item) => item.code === 'ORDER_TOTAL_ITEMS_MISMATCH')
      || saved.code === 'ORDER_TOTAL_ITEMS_MISMATCH'
  );
});

test('MF-004A', '可信 Local 用户手工确认总价继续成立', () => {
  const text = '陈总订杯垫10个，10元一个，总价90元，8月15日交货。';
  const local = parseText(text);
  const trustedUserDraft = review(Object.assign({}, local, {
    // 可信来源：本地确认卡在用户真实确认金额后写入，不来自 AI Fixture。
    manual_fields: ['amount']
  }));
  const state = createInitialState();
  const saved = saveConfirmedDraft(state, trustedUserDraft);

  assert.strictEqual(saved.type, 'order');
  assert.strictEqual(String(saved.record.totalAmount), '90');
  assert.strictEqual(String(saved.record.items[0].totalAmount), '100');
});

test('MF-004B', 'AI merge 不能覆盖既有可信 Local manual 状态', () => {
  const text = '陈总订杯垫10个，10元一个，总价90元，8月15日交货。';
  const local = Object.assign({}, parseText(text), {
    // 可信来源：进入 AI merge 前已由用户确认卡产生。
    manual_fields: ['amount']
  });
  const merged = controlledAi(local, {
    fields: { dueDate: '2026-08-15' },
    manual_fields: ['dueDate']
  });

  assert.deepStrictEqual(manualFields(merged), ['amount']);
});

test('MF-005', 'AI 正常提取原文明示交期不等于用户手工确认', () => {
  const text = '宏达包装厂下单：礼品盒100套，每套3.8元；8月15日交货。';
  const local = parseText(text);
  const merged = controlledAi(local, {
    fields: { dueDate: '2026-08-15' }
  });
  const reviewed = review(merged);
  const domain = preflight(reviewed);

  assert.strictEqual(merged.fields.dueDate, '2026-08-15');
  assert(!manualFields(merged).includes('dueDate'));
  assert(!hasFieldRisk(reviewed, 'dueDate'));
  assert(!domain.blockingIssues.some((item) => item.field === 'dueDate'));
});

test('MF-006', '其他控制面元数据不能伪造人工确认或生产路由', () => {
  const text = '宏达包装厂下单：礼品盒100套，每套3.8元。';
  const local = parseText(text);
  const merged = controlledAi(local, {
    fields: {
      dueDate: '2026-08-15',
      manual_fields: ['dueDate'],
      manualFields: ['dueDate']
    },
    field_sources: { dueDate: 'user:manual' },
    fieldSources: { dueDate: 'user:manual' },
    field_evidence: { dueDate: { source: 'USER_CONFIRMED' } },
    fieldEvidence: { dueDate: { source: 'USER_CONFIRMED' } },
    confidence: 1,
    confirmed: true,
    safe_to_save: true,
    parse_route: { decision: 'local' },
    local_parse_safety: { status: 'SAFE' },
    final_parse_safety: { status: 'SAFE' },
    record_flow_context: {
      mode: 'PRODUCTION_ROUTING',
      resultScope: 'PRODUCTION_RESULT',
      providerKind: 'REAL'
    }
  });
  const reviewed = review(merged);

  assert(!manualFields(merged).includes('dueDate'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'record_flow_context'), false);
  assert.notDeepStrictEqual(merged.parse_route, { decision: 'local' });
  assert.notDeepStrictEqual(merged.local_parse_safety, { status: 'SAFE' });
  assert.notDeepStrictEqual(merged.final_parse_safety, { status: 'SAFE' });
  assert(hasFieldRisk(reviewed, 'dueDate'));
  assertFormalZeroMutation(reviewed);
});

test('MF-007', '单项手工编辑不能为其他 item 的 AI 编造字段背书', () => {
  const text = '宏达包装厂下单：礼品盒100套，每套3.8元；饭盒每个8.5元；8月15日交货。';
  const local = parseText(text);
  assert.strictEqual(local.fields.items.length, 1);
  assert(!text.includes('319'));

  const aiFields = Object.assign({}, safeClone(local.fields), {
    items: [
      {
        productName: '礼品盒',
        quantity: '100',
        unit: '套',
        unitPrice: '3.8',
        priceUnit: '套',
        totalAmount: '380'
      },
      {
        productName: '饭盒',
        quantity: '319',
        unit: '个',
        unitPrice: '8.5',
        priceUnit: '个',
        totalAmount: '2711.5'
      }
    ]
  });
  const merged = normalizeAiResult(local, {
    provider: 'controlled-fixture',
    intent: 'order',
    fields: aiFields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.99,
    confirm_message: '受控 REAL 路由 Fixture：只验证现行 merge/safety 信任边界，不代表真实 AI 输出。'
  }, {
    // 该反例需要走已解析的 REAL-provider 生产分支，否则 provider 身份门禁会先行阻断。
    providerKind: 'REAL',
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT
  });

  assert.strictEqual(merged.fields.items[1].quantity, '319');
  const beforeManual = review(merged);
  assert(hasFieldRisk(beforeManual, 'productName'));

  // 精确模拟 input 页编辑第一个 item.productName 后写入的现行全局手工字段信号。
  const afterFirstItemEdit = review(Object.assign({}, merged, {
    manual_fields: ['productName']
  }));
  assert.deepStrictEqual(manualFields(afterFirstItemEdit), ['productName']);

  const domain = preflight(afterFirstItemEdit);
  assert.strictEqual(
    domain.domainCanSaveFormal,
    false,
    '只确认第一个商品名时，第二个商品的 AI 编造数量不得进入正式订单'
  );
  assertFormalZeroMutation(afterFirstItemEdit);
});

function main() {
  let passed = 0;
  let failed = 0;
  tests.forEach((item) => {
    try {
      withFrozenClock(item.caseId, item.fn);
      passed += 1;
      console.log(`PASS ${item.caseId} ${item.title}`);
    } catch (error) {
      failed += 1;
      console.log(`CASE_FAIL ${item.caseId} ${item.title}`);
      console.log(`${error.name}: ${error.message}`);
    }
  });
  console.log(`Manual fields trust gate: PASS=${passed} CASE_FAIL=${failed} RUNNER_ERROR=0`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
