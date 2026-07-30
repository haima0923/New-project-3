const assert = require('assert');
const { parseInput } = require('../utils/parser');
const { saveConfirmedDraft } = require('../utils/business');
const {
  parseHybridInput,
  evaluateClearNonBusinessNoRecord,
  evaluateSafeLocalReceivableRoute,
  requestWithDeadline,
  ROUTE_AI_STANDARD,
  ROUTE_AI_DEEP,
  ROUTE_LOCAL,
  ROUTE_NO_RECORD,
  ROUTE_PENDING
} = require('../utils/ai-parser');
const { buildParseEvidence } = require('../utils/parse-evidence');
const { prewarmAiAuth } = require('../utils/api-client');

function payload(text, source) {
  return {
    text,
    source,
    context: 'home',
    state: { customers: [], quotations: [], orders: [], receivables: [] }
  };
}

function assertTrace(result, label) {
  assert(result.parse_route && result.parse_route.decision, `${label} 缺少明确处理方式`);
  assert(result.parse_trace && result.parse_trace.route, `${label} 缺少识别过程凭证`);
  assert(Number.isFinite(result.parse_trace.localDurationMs), `${label} 没有记录本地耗时`);
  assert(Number.isFinite(result.parse_trace.totalDurationMs), `${label} 没有记录总耗时`);
  assert(result.parse_trace.localDraft, `${label} 没有记录本地先整理的结果`);
}

function buildEmptyState() {
  return {
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
    todos: [], pendingNotes: [], aiParseLogs: []
  };
}

function withFakeWechat(mode, run) {
  const oldWx = global.wx;
  const oldGetApp = global.getApp;
  const storage = {};
  global.getApp = () => ({ globalData: {
    apiBaseUrl: 'https://example.test',
    aiAuthEnabled: true,
    aiParseEndpoint: '/api/ai/parse'
  } });
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    removeStorageSync(key) { delete storage[key]; },
    login(options) { options.success({ code: 'route-test-code' }); },
    request(options) {
      if (options.url.endsWith('/api/auth/wechat-login')) {
        options.success({ statusCode: 200, data: { token: 'route-test-token', expiresAt: '2099-01-01T00:00:00.000Z' } });
        return;
      }
      if (mode === 'timeout') {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      options.success({
        statusCode: 200,
        data: {
          provider: 'real-ai-test-double',
          ai_model_tier: 'quality',
          intent: 'order',
          fields: { customerName: '王总', productName: '水杯', quantity: '5', unit: '个', unitPrice: '5.5', dueDate: '2026-07-20' }
        }
      });
    }
  };
  return Promise.resolve()
    .then(() => prewarmAiAuth())
    .then(run)
    .finally(() => {
      if (oldWx === undefined) delete global.wx;
      else global.wx = oldWx;
      if (oldGetApp === undefined) delete global.getApp;
      else global.getApp = oldGetApp;
    });
}

function safeReceivableFacts(overrides = {}) {
  const base = {
    conflicts: [],
    contextPolicy: 'none',
    deepReviewRequested: false,
    fieldSources: {
      amount: 'rule:explicit_receivable_amount',
      customerName: 'rule:customer_title'
    },
    fields: {
      amount: '5000',
      customerName: '王总'
    },
    formalSaveBlocked: false,
    forceAiRequired: false,
    hasConversationRisk: false,
    hasHistoryReference: false,
    hasSemanticDeepRisk: false,
    intent: 'receivable',
    intentCandidates: ['receivable'],
    itemCount: 0,
    lowConfidenceFields: [],
    missingFields: [],
    mixedBusiness: false,
    operation: '',
    requiresExistingRecord: false,
    safety: {
      evidence_sufficient: true,
      field_validations: {
        conflict_fields: [],
        invalid_fields: [],
        semantic_low_fields: []
      },
      low_confidence_fields: [],
      missing_fields: [],
      unsafe_fields: []
    },
    suggestedOperation: ''
  };
  return Object.assign({}, base, overrides, {
    fieldSources: Object.assign({}, base.fieldSources, overrides.fieldSources || {}),
    fields: Object.assign({}, base.fields, overrides.fields || {}),
    safety: Object.assign({}, base.safety, overrides.safety || {}, {
      field_validations: Object.assign(
        {},
        base.safety.field_validations,
        overrides.safety && overrides.safety.field_validations || {}
      )
    })
  });
}

function clearNoRecordFacts(overrides = {}) {
  const base = {
    asyncWorkCompleted: true,
    conflicts: [],
    contextPolicy: 'none',
    customerCandidates: [],
    deepReviewRequested: false,
    fieldSources: {},
    fieldSuggestions: {},
    fields: {},
    forceAiRequired: false,
    formalSaveBlocked: false,
    hasConversationRisk: false,
    hasHistoryReference: false,
    hasSemanticDeepRisk: false,
    intent: 'unknown',
    intentCandidates: ['unknown'],
    intentEvidence: {
      orderDeliverySignals: [],
      orderEntitySignals: [],
      orderPositiveSignals: [],
      quotationPositiveSignals: [],
      reaffirmedOrderSignals: [],
      scores: {
        dunning: 0,
        order: 0,
        payment: 0,
        quotation: 0,
        receivable: 0,
        todo: 0
      }
    },
    items: [],
    lowConfidenceFields: [],
    missingFields: ['intent'],
    mixedBusiness: false,
    operation: '',
    parserCompleted: true,
    relationReferences: {},
    requiresExistingRecord: false,
    safety: {
      evidence_sufficient: true,
      field_validations: {
        conflict_fields: [],
        invalid_fields: [],
        semantic_low_fields: []
      },
      low_confidence_fields: [],
      missing_fields: ['intent'],
      status: 'NO_RECORD',
      unsafe_fields: []
    },
    suggestedOperation: ''
  };
  return Object.assign({}, base, overrides, {
    fieldSources: Object.assign({}, base.fieldSources, overrides.fieldSources || {}),
    fields: Object.assign({}, base.fields, overrides.fields || {}),
    intentEvidence: Object.assign({}, base.intentEvidence, overrides.intentEvidence || {}, {
      scores: Object.assign(
        {},
        base.intentEvidence.scores,
        overrides.intentEvidence && overrides.intentEvidence.scores || {}
      )
    }),
    safety: Object.assign({}, base.safety, overrides.safety || {}, {
      field_validations: Object.assign(
        {},
        base.safety.field_validations,
        overrides.safety && overrides.safety.field_validations || {}
      )
    })
  });
}

async function main() {
  const screenshotLocal = parseInput({
    text: '老板今天要订5个椅子，20块钱一个。这周日交货',
    source: 'voice',
    state: { customers: [] }
  });
  assert.strictEqual(screenshotLocal.fields.customerName, '', '“老板今天”不是客户名，客户必须留空');
  assert.strictEqual(screenshotLocal.fields.productName, '椅子', '原句商品必须是椅子');
  assert.strictEqual(screenshotLocal.fields.quantity, '5', '原句数量必须是 5');
  assert.strictEqual(screenshotLocal.fields.unitPrice, '20', '“20块钱一个”必须识别为单价 20');
  assert.strictEqual(screenshotLocal.fields.items.length, 1, '单商品不能凭空多出“块钱”');
  assert.strictEqual(screenshotLocal.fields.items[0].productName, '椅子', '单商品名称必须是椅子');

  const local = await parseHybridInput(payload('王总订水杯100个，5块5一个，明天交', 'typed'));
  assert.strictEqual(local.parse_route.decision, ROUTE_LOCAL, '清楚的手打订单应走本地快速整理');
  assert.strictEqual(local.ai_fallback.status, 'not_requested', '本地快速整理不应等待 AI');
  assertTrace(local, '本地快速整理');
  const localEvidence = buildParseEvidence(local);
  assert.strictEqual(localEvidence.routeLabel, '本地快速整理', '凭证应显示本地快速整理');
  assert(localEvidence.totalDurationText, '凭证应显示总耗时');

  const clearNonBusinessPhrases = [
    '哈哈哈',
    '你好呀',
    '辛苦啦',
    '天气真好',
    '我去散步了',
    '随便聊聊',
    '晚安',
    '祝你开心'
  ];
  for (const text of clearNonBusinessPhrases) {
    const parsed = await parseHybridInput(payload(text, 'typed'));
    assert.strictEqual(parsed.intent, 'unknown', `${text}必须保留raw unknown`);
    assert.strictEqual(
      parsed.parse_route.semantic_decision,
      ROUTE_NO_RECORD,
      `${text}必须由真实parser与Route得到NO_RECORD`
    );
    assert.strictEqual(parsed.parse_route.no_record_eligible, true, `${text}必须取得窄NO_RECORD资格`);
    assert.strictEqual(parsed.parse_route.business_evidence_count, 0, `${text}不得出现业务Evidence`);
    assert.strictEqual(parsed.parse_route.structured_business_field_count, 0, `${text}不得出现结构化业务字段`);
    assert.strictEqual(parsed.parse_route.relation_evidence_count, 0, `${text}不得出现关系Evidence`);
    assert.strictEqual(parsed.ai_fallback.attempted, false, `${text}不得调用AI`);
  }

  const clearNoRecord = await parseHybridInput(payload(
    '今天天气不错，晚点出去走走',
    'typed'
  ));
  assert.strictEqual(clearNoRecord.intent, 'unknown', '明确非业务输入必须保留raw unknown');
  assert.strictEqual(clearNoRecord.parse_route.decision, ROUTE_PENDING, '共享生产执行路径继续使用既有PENDING兼容值');
  assert.strictEqual(clearNoRecord.parse_route.semantic_decision, ROUTE_NO_RECORD, '明确非业务必须投影为canonical NO_RECORD语义');
  assert.strictEqual(clearNoRecord.parse_route.no_record_eligible, true, 'NO_RECORD必须记录窄资格命中');
  assert.strictEqual(clearNoRecord.parse_route.business_evidence_count, 0, 'NO_RECORD业务Evidence计数必须为0');
  assert.strictEqual(clearNoRecord.ai_fallback.needed, false, 'NO_RECORD不需要AI');
  assert.strictEqual(clearNoRecord.ai_fallback.attempted, false, 'NO_RECORD不得调用AI');
  assert.strictEqual(clearNoRecord.no_record, true, 'NO_RECORD终态必须由真实Route结果携带');

  const incidentalBusinessDate = await parseHybridInput(payload(
    '今天天气不错，大家辛苦了',
    'typed'
  ));
  assert.strictEqual(incidentalBusinessDate.parse_route.semantic_decision, undefined, '带来源的业务日期Evidence不能在Route层被静默丢弃');
  assert.strictEqual(incidentalBusinessDate.parse_route.no_record_eligible, false, 'AMB-012当前日期Evidence必须fail-closed');
  assert(incidentalBusinessDate.parse_route.no_record_eligibility_exclusions.includes(
    'LOCAL_SAFETY_NOT_NO_RECORD'
  ), 'AMB-012必须记录Safety尚未确认NO_RECORD');
  assert(incidentalBusinessDate.parse_route.no_record_eligibility_exclusions.includes(
    'STRUCTURED_BUSINESS_FIELDS_PRESENT'
  ), 'AMB-012必须记录dueDate结构化Evidence');

  const noRecordExclusions = [
    ['unknown但有客户', { fields: { customerName: '王总' } }, 'STRUCTURED_BUSINESS_FIELDS_PRESENT'],
    ['unknown但有商品', { fields: { productName: '礼盒' } }, 'STRUCTURED_BUSINESS_FIELDS_PRESENT'],
    ['unknown但有数量', { fields: { quantity: '300' } }, 'STRUCTURED_BUSINESS_FIELDS_PRESENT'],
    ['unknown但有金额', { fields: { amount: '3000' } }, 'STRUCTURED_BUSINESS_FIELDS_PRESENT'],
    ['unknown但有日期', { fields: { dueDate: '2026-07-31' } }, 'STRUCTURED_BUSINESS_FIELDS_PRESENT'],
    ['unknown但有关系', {
      relationReferences: { order: { explicit: true, requiresResolution: true } }
    }, 'RELATION_EVIDENCE_PRESENT'],
    ['有订单候选评分', {
      intentEvidence: { scores: { order: 0.4 } }
    }, 'BUSINESS_INTENT_EVIDENCE_PRESENT'],
    ['有报价候选', {
      intentCandidates: ['unknown', 'quotation']
    }, 'BUSINESS_INTENT_CANDIDATE_PRESENT'],
    ['有订单信号', {
      intentEvidence: { orderPositiveSignals: [{ sourceText: '下单' }] }
    }, 'BUSINESS_INTENT_EVIDENCE_PRESENT'],
    ['Parser失败或未完成', { parserCompleted: false }, 'PARSER_NOT_COMPLETED'],
    ['Hybrid Evidence未完成', { asyncWorkCompleted: false }, 'ASYNC_WORK_NOT_COMPLETED'],
    ['语音异步未完成', { asyncWorkCompleted: false }, 'ASYNC_WORK_NOT_COMPLETED'],
    ['多轮局部空结果', { hasConversationRisk: true }, 'MULTI_MESSAGE_INPUT'],
    ['AI unresolved', { forceAiRequired: true }, 'AI_POLICY_REQUIRES_REVIEW'],
    ['业务字段缺失', {
      missingFields: ['amount'],
      safety: { missing_fields: ['amount'] }
    }, 'BUSINESS_FIELDS_MISSING'],
    ['低置信业务字段', {
      lowConfidenceFields: ['customerName']
    }, 'LOW_CONFIDENCE_BUSINESS_FIELDS'],
    ['业务冲突', {
      conflicts: [{ field: 'amount' }]
    }, 'BUSINESS_FIELD_CONFLICTS'],
    ['关系历史策略', {
      contextPolicy: 'order_history'
    }, 'CONTEXT_POLICY_REQUIRES_REVIEW'],
    ['多业务混合', { mixedBusiness: true }, 'MIXED_BUSINESS'],
    ['需要既有记录', { requiresExistingRecord: true }, 'REQUIRES_EXISTING_RECORD'],
    ['明确operation', { operation: 'create_order' }, 'CANONICAL_OPERATION_PRESENT'],
    ['明确businessType', { intent: 'order' }, 'BUSINESS_INTENT_PRESENT']
  ];
  noRecordExclusions.forEach(([name, overrides, code]) => {
    const qualification = evaluateClearNonBusinessNoRecord(clearNoRecordFacts(overrides));
    assert.strictEqual(qualification.eligible, false, `${name}不得取得NO_RECORD资格`);
    assert(qualification.exclusions.includes(code), `${name}必须记录排除原因${code}`);
  });

  const clearVoice = await parseHybridInput(payload('王总订水杯100个，5块5一个，明天交', 'voice'));
  assert.strictEqual(clearVoice.parse_route.decision, ROUTE_LOCAL, '清楚的语音转写文字应与手打文字同路由');
  assert.strictEqual(clearVoice.ai_fallback.status, 'not_requested', '清楚的语音转写文字不应因为来源而等待 AI');

  const localReceivable = await parseHybridInput(payload('刘姐那批货还欠3200元，7月31日前收', 'typed'));
  assert.strictEqual(localReceivable.intent, 'receivable', '明确欠款必须保留receivable业务类型');
  assert.strictEqual(localReceivable.parse_route.decision, ROUTE_LOCAL, '字段完整的明确待收款必须走LOCAL');
  assert.strictEqual(localReceivable.parse_route.safe_local_receivable_eligible, true, 'LOCAL待收款必须记录窄资格命中');
  assert.strictEqual(localReceivable.ai_fallback.needed, false, 'Safe Local待收款不需要AI结果');
  assert.strictEqual(localReceivable.ai_fallback.attempted, false, 'Safe Local待收款不得调用AI');
  assert.strictEqual(localReceivable.local_parse_safety.status, 'SAFE_LOCAL', 'Route专属安全投影必须与LOCAL一致');

  const localVoiceReceivable = await parseHybridInput(payload(
    '刘姐那批货还欠3200元，7月31日前收',
    'voice'
  ));
  assert.strictEqual(localVoiceReceivable.parse_route.decision, ROUTE_LOCAL, '输入渠道本身不能覆盖完整明确的Safe Local事实');
  assert.strictEqual(localVoiceReceivable.ai_fallback.attempted, false, '明确的语音转写待收款也不得自动调用AI');

  for (const text of [
    '王总余款5000元未收，7月25日收',
    '王总应收款还有4000元，7月25日收',
    '王总尚欠货款6000元，7月25日收'
  ]) {
    const explicitReceivable = await parseHybridInput(payload(text, 'typed'));
    assert.strictEqual(explicitReceivable.intent, 'receivable', `${text}必须保留receivable语义`);
    assert.strictEqual(explicitReceivable.context_policy, 'none', `${text}不得被误投影为历史收款核销`);
    assert.strictEqual(explicitReceivable.parse_route.decision, ROUTE_LOCAL, `${text}字段完整时必须走LOCAL`);
    assert.strictEqual(explicitReceivable.ai_fallback.attempted, false, `${text}不得自动调用AI`);
  }

  const relatedReceivable = await parseHybridInput(payload(
    '王总收纳盒这单还有8000元待收，7月25日收',
    'typed'
  ));
  assert.strictEqual(relatedReceivable.parse_route.decision, ROUTE_LOCAL, '关系待选择不能把明确待收款降为PENDING');
  assert.strictEqual(relatedReceivable.fields.orderId, undefined, 'Route不得扫描State或自动写入orderId');
  assert.strictEqual(relatedReceivable.ai_fallback.attempted, false, '关系待选择的Safe Local待收款不得调用AI');

  const unsafeFactCases = [
    {
      name: '缺金额',
      facts: safeReceivableFacts({
        fields: { amount: '' },
        missingFields: ['amount'],
        safety: { missing_fields: ['amount'] }
      }),
      code: 'RECEIVABLE_AMOUNT_NOT_POSITIVE'
    },
    {
      name: '客户不明确',
      facts: safeReceivableFacts({
        fields: { customerName: '' },
        missingFields: ['customerName'],
        safety: { missing_fields: ['customerName'] }
      }),
      code: 'CUSTOMER_NOT_CONFIRMED'
    },
    {
      name: '金额不是明确待收证据',
      facts: safeReceivableFacts({
        fieldSources: { amount: 'rule:quantity_times_unit_price' }
      }),
      code: 'RECEIVABLE_AMOUNT_NOT_EXPLICIT'
    },
    {
      name: '金额冲突',
      facts: safeReceivableFacts({
        conflicts: [{ field: 'amount' }]
      }),
      code: 'FIELD_CONFLICTS'
    },
    {
      name: '低置信字段',
      facts: safeReceivableFacts({
        lowConfidenceFields: ['customerName']
      }),
      code: 'LOW_CONFIDENCE_FIELDS'
    },
    {
      name: 'payment与receivable混合',
      facts: safeReceivableFacts({
        fields: { paymentAmount: '1000' },
        mixedBusiness: true
      }),
      code: 'PAYMENT_SIGNAL_PRESENT'
    },
    {
      name: 'deposit与receivable混合',
      facts: safeReceivableFacts({
        fields: { depositAmount: '1000', paymentKind: 'deposit' }
      }),
      code: 'DEPOSIT_SIGNAL_PRESENT'
    },
    {
      name: '语义冲突',
      facts: safeReceivableFacts({
        intentCandidates: ['receivable', 'payment']
      }),
      code: 'INTENT_CONFLICT'
    },
    {
      name: '多轮输入',
      facts: safeReceivableFacts({
        hasConversationRisk: true
      }),
      code: 'MULTI_MESSAGE_INPUT'
    },
    {
      name: '历史关系策略',
      facts: safeReceivableFacts({
        contextPolicy: 'receivable_history'
      }),
      code: 'CONTEXT_POLICY_REQUIRES_REVIEW'
    },
    {
      name: '历史指代',
      facts: safeReceivableFacts({
        hasHistoryReference: true
      }),
      code: 'HISTORY_REFERENCE_REQUIRES_REVIEW'
    },
    {
      name: '复杂语义',
      facts: safeReceivableFacts({
        hasSemanticDeepRisk: true
      }),
      code: 'SEMANTIC_DEEP_RISK'
    },
    {
      name: '既有AI策略',
      facts: safeReceivableFacts({
        forceAiRequired: true
      }),
      code: 'AI_POLICY_REQUIRES_REVIEW'
    },
    {
      name: '用户主动Deep',
      facts: safeReceivableFacts({
        deepReviewRequested: true
      }),
      code: 'DEEP_REVIEW_REQUESTED'
    }
  ];
  unsafeFactCases.forEach((item) => {
    const qualification = evaluateSafeLocalReceivableRoute(item.facts);
    assert.strictEqual(qualification.eligible, false, `${item.name}不得取得Safe Local资格`);
    assert(qualification.exclusions.includes(item.code), `${item.name}必须记录排除原因${item.code}`);
  });

  const incompleteReceivable = await parseHybridInput(payload('王总还有货款待收', 'typed'));
  assert.strictEqual(incompleteReceivable.intent, 'receivable', '缺金额仍应保留receivable候选');
  assert.strictEqual(incompleteReceivable.parse_route.decision, ROUTE_PENDING, '缺金额receivable必须保持PENDING');
  assert.strictEqual(incompleteReceivable.parse_route.safe_local_receivable_eligible, false, '缺金额不得取得Safe Local资格');
  assert.strictEqual(incompleteReceivable.parse_route.deep_review_available, true, '不安全receivable必须保留主动Deep入口');
  assert.strictEqual(incompleteReceivable.ai_fallback.attempted, false, '未主动Deep不得请求AI');

  const incompleteDeep = await withFakeWechat('success', () => parseHybridInput(Object.assign(
    payload('王总还有货款待收', 'typed'),
    { reviewMode: 'deep' }
  )));
  assert.strictEqual(incompleteDeep.parse_route.decision, ROUTE_AI_DEEP, '只有用户主动触发后不安全receivable才进入AI_DEEP');

  const suggestedProduct = await withFakeWechat('success', () => parseHybridInput(payload(
    '王总那个礼合要5套，三块八一套，下周三拿',
    'voice'
  )));
  assert.strictEqual(suggestedProduct.parse_route.decision, ROUTE_LOCAL, '明确的商品转写提示应直接交给老板确认，不能让 AI 再猜一次');
  assert.strictEqual(suggestedProduct.ai_fallback.status, 'not_requested', '商品名已有明确建议时不应浪费等待时间请求 AI');
  assertTrace(suggestedProduct, '商品名称确认提示');
  assert(suggestedProduct.field_suggestions && suggestedProduct.field_suggestions.productName, '确认卡必须展示商品名称建议');
  assert.strictEqual(suggestedProduct.fields.customerName, '王总', '本地整理仍必须保留原文已经明确的客户');
  assert.strictEqual(suggestedProduct.fields.items.length, 1, '商品名称确认提示不能把单商品拆坏');
  assert.strictEqual(suggestedProduct.fields.unitPrice, '3.8', '商品名称确认提示不能改变已明确的单价');
  const suggestedProductEvidence = buildParseEvidence(suggestedProduct);
  assert.strictEqual(suggestedProductEvidence.routeLabel, '本地快速整理', '凭证应说明本次没有请求 AI');

  const aiChecked = await withFakeWechat('success', () => parseHybridInput(payload(
    '王总要订5个水悲，五块五一个，明天交',
    'voice'
  )));
  assert.strictEqual(aiChecked.parse_route.decision, ROUTE_AI_STANDARD, '不认识的商品转写应请求一次快速 AI 再核对');
  assert.strictEqual(aiChecked.ai_fallback.status, 'used', 'AI 成功返回时必须明确记录成功');
  assertTrace(aiChecked, 'AI 再核对');
  assert(aiChecked.parse_trace.aiDraft && aiChecked.parse_trace.aiDraft.productName === '水杯', '凭证应记录 AI 单独回答了什么');
  assert(aiChecked.parse_trace.aiDurationMs >= 0, 'AI 成功时应记录联网整理等待时间');
  assert.strictEqual(aiChecked.fields.customerName, '王总', 'AI 不能覆盖原文已经明确的客户');
  assert.strictEqual(aiChecked.fields.items.length, 1, 'AI 合并后仍必须只有一件商品');
  assert.strictEqual(aiChecked.fields.unitPrice, '5.5', 'AI 合并后单价仍必须是 5.5');
  const aiCheckedEvidence = buildParseEvidence(aiChecked);
  assert.strictEqual(aiCheckedEvidence.routeLabel, '请 AI 再核对', '凭证应说明本次是 AI 再核对');
  assert(aiCheckedEvidence.aiSummary.includes('水杯'), '凭证应展示 AI 回答的关键字段');

  const failed = await withFakeWechat('timeout', () => parseHybridInput(payload(
    '王总要订5个水悲，五块五一个，明天交',
    'voice'
  )));
  assert.strictEqual(failed.ai_fallback.status, 'timed_out', 'AI 超时必须与其他失败状态区分');
  assertTrace(failed, 'AI 超时');
  assert(failed.parse_trace.aiDurationMs >= 0, 'AI 超时时也应记录已经等了多久');
  const failedEvidence = buildParseEvidence(failed);
  assert.strictEqual(failedEvidence.aiStatusText, '智能核对等待超时', '凭证不能把超时说成成功');

  const deepDefault = await parseHybridInput(payload('王总水杯100个，5块5一个，改成后天交', 'typed'));
  assert.strictEqual(deepDefault.parse_route.decision, ROUTE_PENDING, '改价内容首次必须不联网等待慢模型');
  assert.strictEqual(deepDefault.parse_route.deep_review_available, true, '改价内容必须明确给出深度核对入口');
  assert.strictEqual(deepDefault.ai_fallback.attempted, false, '未点击深度核对时不得调用 AI');
  const deepUsed = await withFakeWechat('success', () => parseHybridInput(Object.assign(
    payload('王总水杯100个，5块5一个，改成后天交', 'typed'),
    { reviewMode: 'deep' }
  )));
  assert.strictEqual(deepUsed.parse_route.decision, ROUTE_AI_DEEP, '只有用户主动点击后才允许走深度核对');

  const failedButComplete = Object.assign({}, failed, {
    intent: 'order',
    fields: { customerName: '王总', productName: '椅子', quantity: '5', unit: '个', unitPrice: '20', amount: '100' },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  const blockedState = buildEmptyState();
  const blockedSave = saveConfirmedDraft(blockedState, failedButComplete);
  assert.strictEqual(blockedSave.type, 'pending', 'AI 失败后，即使字段看起来齐全，也不能直接正式保存');
  assert.strictEqual(blockedState.orders.length, 0, 'AI 失败后不能生成正式订单');
  assert(blockedSave.record.reason.includes('联网整理等待超时'), '待整理原因必须明确告诉老板本次联网整理已超时');

  let deadlineError = null;
  const deadlineStartedAt = Date.now();
  try {
    await requestWithDeadline(new Promise(() => {}), 20);
  } catch (error) {
    deadlineError = error;
  }
  assert(deadlineError && deadlineError.code === 'AI_TOTAL_TIMEOUT', '总等待上限必须能主动结束等待');
  assert(Date.now() - deadlineStartedAt < 500, '总等待上限测试不应卡住');

  console.log('识别、合并、保存和等待时间测试通过：原句字段正确、AI 不会保留“老板今”、AI 失败不能正式保存、超时可结束。');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
