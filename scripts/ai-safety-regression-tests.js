const assert = require('assert');
const {
  parseHybridInput,
  normalizeAiResult,
  getAiBusinessResultValidity,
  getAiFailureReason
} = require('../utils/ai-parser');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { buildParseEvidence } = require('../utils/parse-evidence');
const { saveConfirmedDraft } = require('../utils/business');
const { saveConfirmedDraft: saveServerConfirmedDraft } = require('../server/utils/business');
const {
  getAiBusinessResultValidity: getServerAiBusinessResultValidity,
  parseWithAi
} = require('../server/src/ai/model');
const { runOneFlow } = require('./record-flow-gate');

function emptyState() {
  return {
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
    dunningRecords: [], todos: [], orderProgress: [], pendingNotes: [], aiParseLogs: [],
    operationLogs: [], productCatalog: []
  };
}

function buildAiRequiredOrder(route = 'ai_standard') {
  return {
    intent: 'order',
    source: 'voice',
    original_text: '王总订水杯100个，5块5一个，明天交',
    fields: {
      customerName: '王总', productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5',
      amount: '550', dueDate: '2026-07-23', items: [{
        productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', totalAmount: '550'
      }]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    local_parse_safety: { status: 'NEEDS_AI' },
    parse_route: { decision: route, label: route === 'ai_deep' ? '请 AI 深度整理' : '请 AI 再核对' },
    ai_fallback: { needed: true, status: 'requested', attempted: true, business_result_valid: false }
  };
}

function formalRecordCount(state) {
  return ['customers', 'quotations', 'orders', 'receivables', 'paymentRecords', 'todos']
    .reduce((count, key) => count + (state[key] || []).length, 0);
}

function testAiBusinessResultValidityContract() {
  const invalidResults = [
    {},
    { fields: {} },
    { intent: '' },
    { intent: 'unknown', fields: {} },
    { provider: 'server', model: 'x' },
    { items: [] },
    { fields: { items: [] } },
    { missing_fields: [], low_confidence_fields: [], field_conflicts: [] },
    { provider: 'server', requestId: 'request-only', timing: 10, status: 'ok' },
    { status: 'NEEDS_USER_CONFIRM' },
    { decision: 'pending' },
    { fields: { customerName: '   ' } },
    { fields: { remark: '\t\n' } },
    { fields: { items: [{ productName: '   ', quantity: '\t' }] } },
    { status: 'NEEDS_USER_CONFIRM', reason: '   ' },
    { fields: { remark: true } },
    { fields: { remark: { provider: 'x' } } },
    { fields: { items: [{ productName: { value: '水杯' }, quantity: false }] } },
    { fields: { quantity: '999' } }
  ];
  const validResults = [
    { intent: 'order', fields: {} },
    { intent: 'order', fields: {}, intent_candidates: ['order'] },
    { intent: 'order', fields: {}, intent_candidates: [{ intent: 'order' }] },
    { intent: 'order', fields: {}, intent_candidates: ['payment'] },
    { intent_candidates: ['order'] },
    { fields: { customerName: '王总' }, field_evidence: { customerName: [{ text: '王总' }] } },
    { intent: 'unknown', missing_fields: ['intent'] },
    { intent: 'unknown', confirm_message: '信息不足，不能判断业务类型。' },
    { no_record: true },
    { status: 'NEEDS_USER_CONFIRM', reason: '金额存在冲突，需要用户确认。' },
    { intent: 'order', no_record: true },
    { intent: 'order', recordable: false },
    { intent: 'order', status: 'pending', reason: '不能安全记录。' },
    { intent: 'unknown', fields: { amount: '500' }, confirm_message: '无法判断是收款还是欠款。' },
    { intent: 'order', fields: { items: [{ productName: '水杯', quantity: '100' }] } }
  ];

  invalidResults.forEach((result, index) => {
    assert.strictEqual(getAiBusinessResultValidity(result).valid, false, `客户端无效样例 ${index + 1} 必须拒绝`);
    assert.strictEqual(getServerAiBusinessResultValidity(result).valid, false, `服务端无效样例 ${index + 1} 必须拒绝`);
    assert.throws(
      () => normalizeAiResult(buildAiRequiredOrder(), result),
      (error) => error && error.code === 'AI_RESPONSE_EMPTY_BUSINESS',
      `无效样例 ${index + 1} 不能被合并成本地字段的 AI 成功结果`
    );
  });
  validResults.forEach((result, index) => {
    assert.strictEqual(getAiBusinessResultValidity(result).valid, true, `客户端有效样例 ${index + 1} 不应误判为空`);
    assert.strictEqual(getServerAiBusinessResultValidity(result).valid, true, `服务端有效样例 ${index + 1} 不应误判为空`);
  });
  const contradictoryIntent = { intent: 'order', fields: {}, intent_candidates: ['payment'] };
  assert.strictEqual(getAiBusinessResultValidity(contradictoryIntent).kind, 'uncertain', '客户端不得忽略相互矛盾的单一intent候选');
  assert.strictEqual(getServerAiBusinessResultValidity(contradictoryIntent).kind, 'uncertain', '服务端不得忽略相互矛盾的单一intent候选');
  const contradictoryObjectIntent = { intent: 'order', fields: {}, intent_candidates: [{ intent: 'payment' }] };
  assert.strictEqual(getAiBusinessResultValidity(contradictoryObjectIntent).kind, 'uncertain', '客户端不得忽略对象格式的矛盾intent候选');
  assert.strictEqual(getServerAiBusinessResultValidity(contradictoryObjectIntent).kind, 'uncertain', '服务端不得忽略对象格式的矛盾intent候选');
  const candidateWithoutIntent = { intent_candidates: ['order'] };
  assert.strictEqual(getAiBusinessResultValidity(candidateWithoutIntent).kind, 'uncertain', '客户端只有候选但无最终intent时必须保持不确定');
  assert.strictEqual(getServerAiBusinessResultValidity(candidateWithoutIntent).kind, 'uncertain', '服务端只有候选但无最终intent时必须保持不确定');
}

function buildAiRequiredDraft(intent, route = 'ai_standard') {
  const draft = buildAiRequiredOrder(route);
  draft.intent = intent;
  draft.original_text = `合成${intent}业务，验证AI失败不会正式保存`;
  const fieldsByIntent = {
    quotation: {
      customerName: '王总', productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', amount: '550',
      items: [{ productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', totalAmount: '550' }]
    },
    order: draft.fields,
    receivable: { customerName: '王总', amount: '550', dueDate: '2026-07-31' },
    payment: { customerName: '王总', paymentAmount: '300', paymentMethod: '微信' },
    todo: { customerName: '王总', dueDate: '2026-07-23', remark: '提醒跟进打样' }
  };
  draft.fields = fieldsByIntent[intent];
  return draft;
}

async function withFakeServerAiResult(aiResult, reviewMode = 'standard') {
  const originalFetch = global.fetch;
  const calls = [];
  const config = {
    aiBaseUrl: 'https://example.test/v1',
    aiApiKey: 'synthetic-test-key',
    aiProvider: 'fake-provider',
    aiModel: 'quality-model',
    aiFastModel: 'fast-model',
    aiFastRequestTimeoutMs: 5200,
    aiQualityRequestTimeoutMs: 20000
  };
  try {
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(aiResult) } }] })
      };
    };
    const result = await parseWithAi(config, {
      reviewMode,
      source: 'typed',
      text: '合成测试输入',
      localDraft: { intent: 'order', fields: {} }
    });
    return { result, calls };
  } finally {
    global.fetch = originalFetch;
  }
}

async function testServerRejectsEmptyBusinessForStandardAndDeep() {
  const invalidResults = [
    {},
    { fields: {} },
    { intent: '' },
    { provider: 'server', model: 'x' },
    { intent: 'unknown', fields: {} },
    { items: [] },
    { fields: { items: [] }, missing_fields: [], low_confidence_fields: [], field_conflicts: [] },
    { missing_fields: [], low_confidence_fields: [], field_conflicts: [] },
    { provider: 'server', requestId: 'request-only', timing: 10, token: 20, metadata: { model: 'x' } }
  ];
  for (const reviewMode of ['standard', 'deep']) {
    for (const result of invalidResults) {
      let failure = null;
      try {
        await withFakeServerAiResult(result, reviewMode);
      } catch (error) {
        failure = error;
      }
      assert(failure, `${reviewMode} 空业务结果必须失败`);
      assert.strictEqual(failure.code, 'AI_RESPONSE_EMPTY_BUSINESS', `${reviewMode} 必须使用统一空业务错误码`);
    }
  }

  const standard = await withFakeServerAiResult({
    intent: 'order',
    fields: { customerName: '王总', productName: '水杯', quantity: '100', unitPrice: '5.5' }
  }, 'standard');
  assert.strictEqual(standard.result.ai_business_result_valid, true, '合法 standard 结果必须带有效标记');
  assert.strictEqual(standard.calls.length, 1, '合法 standard 只请求一次模型');

  const deepUncertain = await withFakeServerAiResult({
    intent: 'unknown',
    fields: {},
    missing_fields: ['intent'],
    confirm_message: '无法安全判断业务类型。'
  }, 'deep');
  assert.strictEqual(deepUncertain.result.ai_business_result_valid, true, '有效安全拒绝不能被误判为空业务');

  const deepItems = await withFakeServerAiResult({
    intent: 'order',
    fields: { items: [
      { productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5' },
      { productName: '礼品盒', quantity: '20', unit: '套', unitPrice: '8' }
    ] }
  }, 'deep');
  assert.strictEqual(deepItems.result.ai_business_result_valid, true, '多商品 deep 结果不能被误判为空');
}

function testClientAndBusinessDefenseInDepth() {
  ['quotation', 'order', 'receivable', 'payment', 'todo'].forEach((intent) => {
    ['ai_standard', 'ai_deep'].forEach((route) => {
      [false, undefined].forEach((validityFlag) => {
        const forged = buildAiRequiredDraft(intent, route);
        forged.ai_fallback = { status: 'used', attempted: true };
        if (validityFlag !== undefined) forged.ai_fallback.business_result_valid = validityFlag;
        [saveConfirmedDraft, saveServerConfirmedDraft].forEach((save, saveIndex) => {
          const state = emptyState();
          const saved = save(state, forged);
          const saveLabel = saveIndex === 0 ? '客户端business' : '服务端business镜像';
          assert.strictEqual(saved.type, 'pending', `${saveLabel}/${intent}/${route} used但无有效证明时必须进入待整理`);
          assert.strictEqual(formalRecordCount(state), 0, `${saveLabel}/${intent}/${route} 不能产生任何正式记录`);
          assert.strictEqual(saved.record.originalText, forged.original_text, `${saveLabel}/${intent}/${route} 阻断后必须保留原文`);
        });
      });
    });
  });

  const standard = normalizeAiResult(buildAiRequiredOrder('ai_standard'), {
    provider: 'server',
    intent: 'order',
    fields: buildAiRequiredOrder().fields
  });
  assert.strictEqual(standard.ai_fallback.status, 'used', '合法 standard 仍应成功');
  assert.strictEqual(standard.ai_fallback.business_result_valid, true, '合法 standard 必须带有效证明');
  const standardState = emptyState();
  assert.strictEqual(saveConfirmedDraft(standardState, standard).type, 'order', '合法 standard 仍可保存订单');

  const deep = normalizeAiResult(buildAiRequiredOrder('ai_deep'), {
    provider: 'server',
    intent: 'order',
    fields: buildAiRequiredOrder('ai_deep').fields
  });
  const deepState = emptyState();
  assert.strictEqual(saveConfirmedDraft(deepState, deep).type, 'order', '合法 deep 仍可保存订单');

  const mock = normalizeAiResult(buildAiRequiredOrder('ai_standard'), {
    provider: 'mock', intent: 'order', fields: buildAiRequiredOrder().fields
  });
  assert.strictEqual(mock.ai_fallback.status, 'mock_used', 'mock 必须保持 mock_used');
  const mockState = emptyState();
  assert.strictEqual(saveConfirmedDraft(mockState, mock).type, 'pending', 'mock 不能正式保存');
  assert.strictEqual(formalRecordCount(mockState), 0, 'mock 不能产生正式业务副作用');

  const wrappedMock = normalizeAiResult(buildAiRequiredOrder('ai_standard'), {
    provider: ' MOCK ',
    data: { intent: 'order', fields: buildAiRequiredOrder().fields }
  });
  assert.strictEqual(wrappedMock.ai_fallback.status, 'mock_used', '包装在data外层的mock标记不能在解包时丢失');
  const wrappedMockState = emptyState();
  assert.strictEqual(saveConfirmedDraft(wrappedMockState, wrappedMock).type, 'pending', '包装mock不能正式保存');
  assert.strictEqual(formalRecordCount(wrappedMockState), 0, '包装mock不能产生正式业务副作用');

  const uncertain = normalizeAiResult(buildAiRequiredOrder('ai_deep'), {
    intent: 'unknown', missing_fields: ['intent'], confirm_message: '信息不足，不能确定。'
  });
  assert.strictEqual(uncertain.ai_fallback.status, 'returned_uncertain', '有效安全拒绝应记录为 returned_uncertain');
  assert.strictEqual(uncertain.ai_fallback.business_result_valid, true, '有效安全拒绝不是空业务结果');
  const uncertainState = emptyState();
  assert.strictEqual(saveConfirmedDraft(uncertainState, uncertain).type, 'pending', '有效不确定结论仍不能正式保存');

  [
    { intent: 'order', no_record: true },
    { intent: 'order', recordable: false },
    { intent: 'order', status: 'pending', reason: '不能安全记录。' },
    { intent: 'unknown', fields: { amount: '500' }, confirm_message: '无法判断是收款还是欠款。' }
  ].forEach((aiResult, index) => {
    const safeResult = normalizeAiResult(buildAiRequiredOrder('ai_deep'), aiResult);
    assert.strictEqual(safeResult.ai_fallback.status, 'returned_uncertain', `显式安全结论 ${index + 1} 不能标成used`);
    const state = emptyState();
    assert.strictEqual(saveConfirmedDraft(state, safeResult).type, 'pending', `显式安全结论 ${index + 1} 不能正式保存`);
    assert.strictEqual(formalRecordCount(state), 0, `显式安全结论 ${index + 1} 不能产生正式业务副作用`);
  });

  const multiLocal = buildAiRequiredOrder('ai_deep');
  multiLocal.original_text = '王总订水杯100个5块5一个，礼品盒20套8元一套，明天交';
  multiLocal.fields.items = [
    { productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5', totalAmount: '550' },
    { productName: '礼品盒', quantity: '20', unit: '套', unitPrice: '8', totalAmount: '160' }
  ];
  multiLocal.fields.productName = '水杯';
  multiLocal.fields.amount = '710';
  const multi = normalizeAiResult(multiLocal, {
    provider: 'server', intent: 'order', fields: multiLocal.fields
  });
  assert.strictEqual(multi.ai_fallback.status, 'used', '有效多商品结果不能被误判为空');
  assert.strictEqual(multi.fields.items.length, 2, '有效多商品明细必须保留');
  const multiState = emptyState();
  const multiSaved = saveConfirmedDraft(multiState, multi);
  assert.strictEqual(multiSaved.type, 'order', '有效AI多商品结果必须仍可按现有规则保存');
  assert.strictEqual(multiSaved.record.items.length, 2, '有效AI多商品保存后不能丢失第二个商品');
}

function makeLiveRequestHandler(scenario) {
  return (options) => {
    const success = (statusCode, data) => options.success({ statusCode, data });
    if (scenario === 'success') {
      success(200, {
        provider: 'live-fake-provider',
        intent: 'order',
        fields: {
          customerName: '李姐', productName: '椅子', quantity: '5', unit: '个', unitPrice: '20',
          amount: '100', dueDate: '2026-07-26',
          items: [{ productName: '椅子', quantity: '5', unit: '个', unitPrice: '20', amount: '100', dueDate: '2026-07-26' }],
          remark: 'LIVE_RESPONSE_SENTINEL'
        },
        intent_candidates: [{ intent: 'order' }],
        field_evidence: {
          customerName: [{ text: '李姐' }], productName: [{ text: '椅孑' }],
          quantity: [{ text: '5个' }], unitPrice: [{ text: '20元一个' }], dueDate: [{ text: '周日交' }]
        }
      });
      return;
    }
    if (scenario === 'delayed_success') {
      setTimeout(() => success(200, {
        provider: 'live-fake-provider',
        intent: 'order',
        fields: {
          customerName: '李姐', productName: '椅子', quantity: '5', unit: '个', unitPrice: '20',
          amount: '100', dueDate: '2026-07-26',
          items: [{ productName: '椅子', quantity: '5', unit: '个', unitPrice: '20', amount: '100', dueDate: '2026-07-26' }],
          remark: 'DELAYED_LIVE_RESPONSE_SENTINEL'
        },
        intent_candidates: [{ intent: 'order' }],
        field_evidence: {
          customerName: [{ text: '李姐' }], productName: [{ text: '椅孑' }],
          quantity: [{ text: '5个' }], unitPrice: [{ text: '20元一个' }], dueDate: [{ text: '周日交' }]
        }
      }), 25);
      return;
    }
    if (scenario === '401') return success(401, { error: 'AUTH_REQUIRED' });
    if (scenario === '403') return success(403, { error: 'FORBIDDEN' });
    if (scenario === '500') return success(500, { error: 'SERVER_ERROR' });
    if (scenario === 'empty_response') return success(200, '');
    if (scenario === 'non_json') return success(200, 'not-json');
    if (scenario === 'empty_json') return success(200, {});
    if (scenario === 'empty_fields') return success(200, { fields: {} });
    if (scenario === 'metadata_only') return success(200, { provider: 'server', model: 'x' });
    if (scenario === 'mock') {
      return success(200, {
        provider: 'mock', intent: 'order', fields: { customerName: '李姐', productName: '椅孑', quantity: '5' }
      });
    }
    if (scenario === 'timeout') return options.fail({ errMsg: 'request:fail timeout' });
    if (scenario === 'network') return options.fail({ errMsg: 'request:fail network disconnected' });
    throw new Error(`Unknown fake live scenario: ${scenario}`);
  };
}

function getFormalDelta(evidence) {
  return ['customers', 'quotations', 'orders', 'receivables', 'paymentRecords', 'todos']
    .reduce((count, key) => count + Math.max(0, (evidence.saveDelta || {})[key] || 0), 0);
}

async function testLiveModeNeverUsesStubOrFakesSuccess() {
  const baseCase = {
    id: 'p0-live-integrity',
    title: 'live模式结果完整性',
    input: '李姐要订5个椅孑，20元一个，周日交',
    source: 'voice',
    edits: [{ field: 'productName', value: '椅子' }],
    expect: { intent: 'order' }
  };
  for (const entry of ['input', 'dashboard']) {
    const success = await runOneFlow(baseCase, entry, {
      liveAi: true,
      apiBaseUrl: 'https://fake-live.test',
      requestHandler: makeLiveRequestHandler('success')
    });
    assert.strictEqual(success.hybridStubInjected, false, `${entry} live模式不得注入stub`);
    assert.strictEqual(success.requestCount, 1, `${entry} live成功应只请求一次`);
    assert.strictEqual(success.aiStatus, 'used', `${entry} live成功必须记录used`);
    assert.strictEqual(success.aiProvider, 'live-fake-provider', `${entry} 必须保留真实响应provider`);
    assert.strictEqual(success.aiBusinessResultValid, true, `${entry} live成功必须通过业务有效性检查`);
    assert.strictEqual(success.finalFields.remark, 'LIVE_RESPONSE_SENTINEL', `${entry} 真实响应字段不能被本地stub覆盖`);
    assert.strictEqual(success.buttonDisabled, false, `${entry} 有效live结果经现有商品确认后必须解锁保存`);
    assert.strictEqual(success.savedRecordType, 'order', `${entry} 有效live结果必须保存为订单`);
    assert.strictEqual(success.savedOriginalText, baseCase.input, `${entry} 有效live保存必须保留原文`);
    assert((success.saveDelta.orders || 0) > 0, `${entry} 有效live结果必须产生订单`);
    assert.deepStrictEqual(success.failures, [], `${entry} live成功证据不能隐藏失败expectation`);

    const delayed = await runOneFlow(baseCase, entry, {
      liveAi: true,
      apiBaseUrl: 'https://fake-live.test',
      requestHandler: makeLiveRequestHandler('delayed_success'),
      parseWaitTimeoutMs: 1000
    });
    assert.strictEqual(delayed.hybridStubInjected, false, `${entry} 延迟live成功也不得注入stub`);
    assert.strictEqual(delayed.requestCount, 1, `${entry} 延迟live成功应只请求一次`);
    assert.strictEqual(delayed.aiStatus, 'used', `${entry} 必须等待异步live响应完成后再取证`);
    assert.strictEqual(delayed.aiProvider, 'live-fake-provider', `${entry} 延迟live成功必须保留fake AI来源`);
    assert.strictEqual(delayed.aiBusinessResultValid, true, `${entry} 延迟live成功必须保留业务有效标记`);
    assert.strictEqual(delayed.finalFields.remark, 'DELAYED_LIVE_RESPONSE_SENTINEL', `${entry} 不能在live响应前提前取证`);
    assert.strictEqual(delayed.buttonDisabled, false, `${entry} 延迟有效live结果经现有商品确认后必须解锁保存`);
    assert((delayed.saveDelta.orders || 0) > 0, `${entry} 延迟有效live结果必须产生订单`);
    assert.strictEqual(delayed.savedOriginalText, baseCase.input, `${entry} 延迟live保存必须保留原文`);
    assert.deepStrictEqual(delayed.failures, [], `${entry} 延迟live成功证据不能隐藏失败expectation`);
  }

  const failures = {
    '401': { status: 'failed', code: 'AUTH_SESSION_EXPIRED' },
    '403': { status: 'failed', code: 'FORBIDDEN' },
    timeout: { status: 'timed_out', code: 'NETWORK_REQUEST_FAILED' },
    network: { status: 'failed', code: 'NETWORK_REQUEST_FAILED' },
    '500': { status: 'failed', code: 'SERVER_ERROR' },
    empty_response: { status: 'failed', code: '' },
    non_json: { status: 'returned_uncertain', code: 'AI_RESPONSE_EMPTY_BUSINESS' },
    empty_json: { status: 'returned_uncertain', code: 'AI_RESPONSE_EMPTY_BUSINESS' },
    empty_fields: { status: 'returned_uncertain', code: 'AI_RESPONSE_EMPTY_BUSINESS' },
    metadata_only: { status: 'returned_uncertain', code: 'AI_RESPONSE_EMPTY_BUSINESS' },
    mock: { status: 'mock_used', code: '' }
  };
  for (const entry of ['input', 'dashboard']) {
    for (const [scenario, expected] of Object.entries(failures)) {
      const evidence = await runOneFlow(Object.assign({}, baseCase, { id: `p0-live-${scenario}` }), entry, {
        liveAi: true,
        apiBaseUrl: 'https://fake-live.test',
        requestHandler: makeLiveRequestHandler(scenario)
      });
      assert.strictEqual(evidence.hybridStubInjected, false, `${entry}/${scenario} live失败不得注入stub`);
      assert.strictEqual(evidence.requestCount, 1, `${entry}/${scenario} 请求次数必须为1`);
      assert.strictEqual(evidence.aiStatus, expected.status, `${entry}/${scenario} 必须保留真实失败状态`);
      assert.strictEqual(evidence.aiFailureCode, expected.code, `${entry}/${scenario} 必须保留具体失败码`);
      assert.notStrictEqual(evidence.aiStatus, 'used', `${entry}/${scenario} 不能假成功`);
      if (scenario === 'mock') {
        assert.strictEqual(evidence.aiBusinessResultValid, true, `${entry}/${scenario} 可保留结构有效性，但必须由mock状态隔离`);
        assert.strictEqual(evidence.aiProvider, 'mock', `${entry}/${scenario} 必须保留mock来源`);
      } else {
        assert.strictEqual(evidence.aiBusinessResultValid, false, `${entry}/${scenario} 不能伪造业务有效证明`);
        assert.strictEqual(evidence.aiProvider, '', `${entry}/${scenario} 不能把本地字段包装成server字段`);
      }
      assert.strictEqual(evidence.buttonDisabled, true, `${entry}/${scenario} 正式保存按钮必须禁用`);
      assert.strictEqual(getFormalDelta(evidence), 0, `${entry}/${scenario} 不能产生客户或业务记录`);
    }
  }

  const nonLive = await runOneFlow(Object.assign({}, baseCase, {
    id: 'p0-non-live-stub',
    aiScenario: 'used_local'
  }), 'input', { liveAi: false });
  assert.strictEqual(nonLive.hybridStubInjected, true, '非live受控诊断模式应继续支持stub');
  assert.strictEqual(nonLive.aiStatus, 'used', '非live受控stub仍应产生明确的used测试结果');
}

async function testPageDeepEmptyBusinessIsBlocked() {
  const testCase = {
    id: 'p0-deep-empty',
    title: 'deep空业务结果',
    input: '王总水杯100个，5块5一个，改成后天交',
    source: 'typed',
    reviewMode: 'deep',
    expect: { intent: 'order', allowFormalSave: false }
  };
  for (const entry of ['input', 'dashboard']) {
    const evidence = await runOneFlow(testCase, entry, {
      liveAi: true,
      apiBaseUrl: 'https://fake-live.test',
      requestHandler: makeLiveRequestHandler('empty_json')
    });
    assert.strictEqual(evidence.aiStatus, 'returned_uncertain', `${entry} deep空业务必须标记不可信`);
    assert.strictEqual(evidence.buttonDisabled, true, `${entry} deep空业务不能解锁保存按钮`);
    assert.strictEqual(getFormalDelta(evidence), 0, `${entry} deep空业务不能产生正式记录`);
  }
}

async function testLocalOnlyFlowUnaffected() {
  const text = '王总订水杯100个，5块5一个，明天交';
  const local = await parseHybridInput({
    text,
    rawText: text,
    source: 'typed', context: 'home', state: emptyState()
  });
  assert.strictEqual(local.parse_route.decision, 'local', '清楚输入仍应走local');
  assert.strictEqual(local.ai_fallback.status, 'not_requested', 'local不应被P0修复误标成AI失败');
  const state = emptyState();
  assert.strictEqual(saveConfirmedDraft(state, local).type, 'order', 'local正式保存不应受AI有效标记影响');

  const pageCase = {
    id: 'p0-local-page-save',
    title: 'local双入口正常保存',
    input: text,
    source: 'typed',
    expect: { intent: 'order', allowFormalSave: true, recordType: 'order' }
  };
  for (const entry of ['input', 'dashboard']) {
    const evidence = await runOneFlow(pageCase, entry, { liveAi: false });
    assert.strictEqual(evidence.aiStatus, 'not_requested', `${entry} local页面流程不得请求AI`);
    assert.strictEqual(evidence.buttonDisabled, false, `${entry} local页面流程必须保持可保存`);
    assert((evidence.saveDelta.orders || 0) > 0, `${entry} local页面流程必须保存订单`);
    assert.strictEqual(evidence.savedOriginalText, text, `${entry} local页面保存必须保留原文`);
    assert.deepStrictEqual(evidence.failures, [], `${entry} local页面回归不得隐藏失败expectation`);
  }
}

async function testMixedBusinessCannotBeDowngraded() {
  const text = '王总，杯垫500个，九毛一个，另外周姐刚打了3000';
  const local = await parseHybridInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'home',
    state: emptyState()
  });
  const merged = normalizeAiResult(local, {
    provider: 'test-ai',
    intent: 'quotation',
    fields: { customerName: '王总', productName: '杯垫', quantity: '500', unit: '个', unitPrice: '0.9' },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    intent_candidates: ['quotation', 'payment']
  });
  assert(merged.field_conflicts.some((item) => item.field === 'customerName'), '多个客户的本地风险不能被 AI 空数组清掉');
  assert(merged.field_conflicts.some((item) => item.field === 'intent'), '多笔业务必须明确提示拆开记录');
  assert(merged.low_confidence_fields.includes('intent'), '多业务必须保持为不确定状态');
  assert(merged.missing_fields.includes('intent'), '多业务不能伪装成一笔完整记录');
  const saved = saveConfirmedDraft(emptyState(), merged);
  assert.strictEqual(saved.type, 'pending', '多业务 AI 结果不能直接保存为报价/订单/收款');
}

function testAiMustShowResolutionEvidence() {
  const local = {
    intent: 'order',
    source: 'paste',
    original_text: '王总水杯1000个，之前30一个，后面确认25一个',
    fields: { customerName: '王总', productName: '水杯', quantity: '1000', unit: '个', unitPrice: '25' },
    missing_fields: [],
    low_confidence_fields: ['unitPrice'],
    field_conflicts: [{ field: 'unitPrice', values: ['30', '25'] }],
    local_parse_safety: { status: 'NEEDS_AI' }
  };
  const withoutEvidence = normalizeAiResult(local, {
    intent: 'order', fields: local.fields, missing_fields: [], low_confidence_fields: [], field_conflicts: []
  });
  assert(withoutEvidence.field_conflicts.some((item) => item.field === 'unitPrice'), 'AI 未给解决依据时不能清除价格冲突');
  const resolved = normalizeAiResult(local, {
    intent: 'order', fields: local.fields, missing_fields: [], low_confidence_fields: [], field_conflicts: [],
    superseded_facts: [{ field: 'unitPrice', oldValue: '30', newValue: '25', reason: '后面确认' }],
    field_evidence: { unitPrice: [{ messageIndex: 1, text: '后面确认25一个' }] }
  });
  assert(!resolved.field_conflicts.length, '有替代记录和原话证据时可以清除已解决的单字段冲突');
}

function testCollapsedItemsAreBlocked() {
  const local = {
    intent: 'order',
    source: 'typed',
    original_text: '王总订杯垫300个九毛一个，礼品盒200个三块八一个，后天交',
    fields: {
      customerName: '王总',
      productName: '杯垫', quantity: '300', unit: '个', unitPrice: '0.9',
      items: [
        { productName: '杯垫', quantity: '300', unit: '个', unitPrice: '0.9', totalAmount: '270' },
        { productName: '礼品盒', quantity: '200', unit: '个', unitPrice: '3.8', totalAmount: '760' }
      ]
    },
    missing_fields: [], low_confidence_fields: [], field_conflicts: [],
    local_parse_safety: { status: 'NEEDS_AI' }
  };
  const merged = normalizeAiResult(local, {
    intent: 'order',
    fields: { customerName: '王总', productName: '杯垫,礼品盒', quantity: '300,200', unit: '个,个', unitPrice: '0.9,3.8' },
    missing_fields: [], low_confidence_fields: [], field_conflicts: []
  });
  assert.strictEqual(merged.fields.items.length, 2, 'AI 拼接多商品时不能覆盖本地已拆出的明细');
  assert(merged.field_conflicts.some((item) => item.field === 'items'), 'AI 拼接多商品必须被拦住');
  assert(merged.low_confidence_fields.includes('items'), '多商品结构异常必须要求逐项确认');
}

async function testProductTranscriptionNeedsConfirmation() {
  const text = '王总订水怀100个，5块5一个，明天交';
  const result = await parseHybridInput({
    text,
    rawText: text,
    source: 'voice',
    context: 'home',
    state: emptyState()
  });
  const final = applyFinalParseSafety(result);
  assert(result.field_suggestions && result.field_suggestions.productName, '常见转写错误必须给出商品名称确认提示');
  assert.strictEqual(result.parse_route.decision, 'local', '已有明确商品建议时应由老板确认，不能额外等待 AI');
  assert.strictEqual(result.ai_fallback.status, 'not_requested', '明确商品建议不能发起无效 AI 请求');
  assert(result.low_confidence_fields.includes('productName'), '商品名转写错误不能当作已确认');
  assert(final.low_confidence_fields.includes('productName'), '进入确认页后商品名提醒不能被自动清掉');

  const anotherText = '王总订礼品和5套，三块八一个，明天交';
  const another = await parseHybridInput({
    text: anotherText,
    rawText: anotherText,
    source: 'voice',
    context: 'home',
    state: emptyState()
  });
  assert.strictEqual(another.fields.productName, '礼品盒', '“礼品和”必须先整理为礼品盒候选');
  assert.strictEqual(another.parse_route.decision, 'local', '已有明确商品候选时不能额外等待 AI');
  assert(another.low_confidence_fields.includes('productName'), '“礼品和”也必须要求老板确认，不能悄悄保存');
}

function testReturnedUncertainIsNotReportedAsNoResponse() {
  const reason = getAiFailureReason({ code: 'AI_RESPONSE_INVALID' });
  assert(reason.includes('AI 已返回'), 'AI 返回但内容不完整时必须如实说明已返回');
  const evidence = buildParseEvidence({
    ai_fallback: { status: 'returned_uncertain', attempted: true, reason },
    fields: {}, parse_route: { label: '请 AI 再核对' }
  });
  assert.strictEqual(evidence.aiStatusText, 'AI 已返回，但不够确定', '确认卡不能把无效回答说成 AI 没有返回');
}

async function testNextMonthDateHasDirectEvidence() {
  const text = '赵总下单卡通杯800个，6元一个，下个月5号交';
  const result = await parseHybridInput({
    text,
    rawText: text,
    source: 'typed',
    context: 'home',
    state: emptyState()
  });
  assert(result.fields.dueDate, '“下个月5号”必须解析为交期');
  assert(!result.low_confidence_fields.includes('dueDate'), '原话明确有“下个月5号”时不能误报交期不确定');
}

async function testServerDeepContractRejectsCollapsedItems() {
  const originalFetch = global.fetch;
  const calls = [];
  const config = {
    aiBaseUrl: 'https://example.test/v1',
    aiApiKey: 'test-key',
    aiProvider: 'qwen',
    aiModel: 'quality-model',
    aiFastModel: 'fast-model',
    aiFastRequestTimeoutMs: 5200,
    aiQualityRequestTimeoutMs: 20000
  };
  try {
    global.fetch = async (url, options) => {
      calls.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          intent: 'order',
          fields: { productName: '杯垫,礼品盒', quantity: '300,200', unitPrice: '0.9,3.8' },
          missing_fields: [], low_confidence_fields: [], field_conflicts: []
        }) } }] })
      };
    };
    const result = await parseWithAi(config, {
      reviewMode: 'deep', source: 'typed', text: '两件商品', localDraft: { intent: 'order', fields: {} }
    });
    assert(calls[0].messages[0].content.includes('fields.items必须是逐项数组'), '深度 AI 提示必须强制逐项商品数组');
    assert(calls[0].messages[1].content.includes('"items":[]'), '深度 AI 返回结构必须包含 items 数组');
    assert(result.field_conflicts.some((item) => item.field === 'items'), '服务端也要拦住多商品被拼成一条的返回');
  } finally {
    global.fetch = originalFetch;
  }
}

Promise.resolve()
  .then(testAiBusinessResultValidityContract)
  .then(testServerRejectsEmptyBusinessForStandardAndDeep)
  .then(testClientAndBusinessDefenseInDepth)
  .then(testLiveModeNeverUsesStubOrFakesSuccess)
  .then(testPageDeepEmptyBusinessIsBlocked)
  .then(testLocalOnlyFlowUnaffected)
  .then(testMixedBusinessCannotBeDowngraded)
  .then(testAiMustShowResolutionEvidence)
  .then(testCollapsedItemsAreBlocked)
  .then(testProductTranscriptionNeedsConfirmation)
  .then(testReturnedUncertainIsNotReportedAsNoResponse)
  .then(testNextMonthDateHasDirectEvidence)
  .then(testServerDeepContractRejectsCollapsedItems)
  .then(() => console.log('AI安全回归测试通过：live失败保真、空业务拒绝、双入口按钮、保存副作用、standard/deep、mock、多商品和local。'))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
