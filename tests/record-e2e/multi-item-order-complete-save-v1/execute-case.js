const { normalizeAiResult } = require('../../../utils/ai-parser');
const { saveConfirmedDraft, savePendingNote } = require('../../../utils/business');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { parseInput } = require('../../../utils/parser');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { BUSINESS_DATE, NOW_INSTANT, TIMEZONE, withFrozenClock } = require('./clock');
const { CORE_ITEMS, CORE_TEXT } = require('./contract-cases');

function serializable(value) {
  if (value === undefined) return null;
  return safeClone(value);
}

function createAssertions() {
  const assertions = [];
  return {
    assertions,
    check(name, condition, expected, actual) {
      assertions.push({
        name,
        pass: Boolean(condition),
        expected: serializable(expected),
        actual: serializable(actual)
      });
    }
  };
}

function classifyAssertions(assertions) {
  return assertions.every((item) => item.pass) ? 'PASS' : 'CASE_FAIL';
}

function list(state, key) {
  return Array.isArray(state && state[key]) ? state[key] : [];
}

function moneyToCents(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return NaN;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, decimal = ''] = unsigned.split('.');
  const cents = Number(whole) * 100 + Number(`${decimal}00`.slice(0, 2));
  return negative ? -cents : cents;
}

function lineSubtotalCents(item = {}) {
  return Number(item.quantity) * moneyToCents(item.unitPrice);
}

function coreItems() {
  return CORE_ITEMS.map((item) => Object.assign({ spec: '', itemDeliveryDate: '', itemRemark: '' }, item));
}

function buildOrderDraft(options = {}) {
  const items = safeClone(options.items || coreItems());
  const first = items[0] || {};
  const originalText = options.originalText || CORE_TEXT;
  const customerName = options.customerName || '宏达包装厂';
  const totalAmount = Object.prototype.hasOwnProperty.call(options, 'totalAmount')
    ? options.totalAmount
    : '4676.1';
  const dueDate = Object.prototype.hasOwnProperty.call(options, 'dueDate')
    ? options.dueDate
    : '2026-08-15';
  return {
    id: options.id || 'parse_multi_item_contract',
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: originalText,
    fields: {
      customerName,
      productName: first.productName || '',
      quantity: first.quantity || '',
      unit: first.unit || '',
      unitPrice: first.unitPrice || '',
      priceUnit: first.priceUnit || '',
      amount: totalAmount,
      totalAmount,
      calculatedAmount: options.calculatedAmount || totalAmount,
      dueDate,
      items
    },
    missing_fields: safeClone(options.missingFields || []),
    low_confidence_fields: safeClone(options.lowConfidenceFields || []),
    field_conflicts: safeClone(options.fieldConflicts || []),
    manual_fields: safeClone(options.manualFields || ['remark']),
    formal_save_blocked: false,
    mixed_business: false,
    requires_existing_record: false,
    multi_products: items.map((item) => item.productName).filter(Boolean),
    item_count: items.length,
    confirmationSessionId: options.confirmationSessionId || '',
    operationId: options.operationId || ''
  };
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

function preflight(result, state = createInitialState()) {
  return evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation: result.operation,
    businessType: result.intent,
    finalResult: result,
    originalText: result.original_text,
    initialState: state,
    businessDate: BUSINESS_DATE
  });
}

function controlledAiFields(overrides = {}) {
  const items = safeClone(overrides.items || coreItems());
  return Object.assign({
    customerName: '宏达包装厂',
    productName: items[0] && items[0].productName || '',
    quantity: items[0] && items[0].quantity || '',
    unit: items[0] && items[0].unit || '',
    unitPrice: items[0] && items[0].unitPrice || '',
    priceUnit: items[0] && items[0].priceUnit || '',
    amount: '4676.1',
    totalAmount: '4676.1',
    calculatedAmount: '4676.1',
    dueDate: '2026-08-15',
    items
  }, overrides);
}

function normalizeControlledAi(local, fields) {
  return normalizeAiResult(local, {
    intent: 'order',
    fields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    confidence: 0.99,
    confirm_message: '受控测试结果，仅验证 merge/safety。'
  });
}

function itemRiskFields(result) {
  const fields = [];
  (result.missing_fields || []).forEach((field) => fields.push(String(field)));
  (result.low_confidence_fields || []).forEach((field) => fields.push(String(field)));
  (result.field_conflicts || []).forEach((conflict) => fields.push(String(conflict && conflict.field || '')));
  return Array.from(new Set(fields.filter((field) => (
    field === 'items'
    || field.startsWith('items[')
    || ['productName', 'quantity', 'unit', 'unitPrice', 'priceUnit'].includes(field)
  ))));
}

function itemFactsEqual(left, right) {
  const fields = ['productName', 'quantity', 'unit', 'unitPrice', 'priceUnit'];
  return fields.every((field) => String(left && left[field] || '') === String(right && right[field] || ''));
}

function stateCounts(state) {
  return {
    customers: list(state, 'customers').length,
    orders: list(state, 'orders').length,
    orderProgress: list(state, 'orderProgress').length,
    aiParseLogs: list(state, 'aiParseLogs').length,
    pendingNotes: list(state, 'pendingNotes').length,
    receivables: list(state, 'receivables').length,
    paymentRecords: list(state, 'paymentRecords').length,
    quotations: list(state, 'quotations').length,
    todos: list(state, 'todos').length
  };
}

function executeRed001(recorder) {
  const parsed = parseText(CORE_TEXT);
  recorder.check('customerName 完整', parsed.fields.customerName === '宏达包装厂', '宏达包装厂', parsed.fields.customerName);
  recorder.check('customerName 不是截断值', parsed.fields.customerName !== '达包装厂', 'not 达包装厂', parsed.fields.customerName);
  recorder.check('originalText 完整', parsed.original_text === CORE_TEXT, CORE_TEXT, parsed.original_text);
  recorder.check('本地 parser 保留两个 items', parsed.fields.items.length === 2, 2, parsed.fields.items.length);
  return {
    provider: 'LOCAL_PARSER_NO_PROVIDER',
    surface: 'NO_PAGE_OR_WXML',
    parsed: {
      customerName: parsed.fields.customerName,
      items: parsed.fields.items,
      originalText: parsed.original_text
    }
  };
}

function executeRed002(recorder) {
  const local = parseText(CORE_TEXT);
  const swappedItems = [
    { productName: '礼品盒', quantity: '319', unit: '个', unitPrice: '8.5', priceUnit: '个', totalAmount: '2711.5' },
    { productName: '饭盒', quantity: '517', unit: '套', unitPrice: '3.8', priceUnit: '套', totalAmount: '1964.6' }
  ];
  const merged = applyFinalParseSafety(normalizeControlledAi(local, controlledAiFields({ items: swappedItems })), {
    businessDate: BUSINESS_DATE
  });
  const risks = itemRiskFields(merged);
  const hasItemRisk = risks.length > 0;
  const localItems = local.fields.items;
  const finalItems = merged.fields.items || [];
  recorder.check('两个商品不能只按数组长度判定安全', finalItems.length === 2 && (
    (itemFactsEqual(finalItems[0], localItems[0]) && itemFactsEqual(finalItems[1], localItems[1])) || hasItemRisk
  ), '保留本地逐项事实或产生 item 级风险', { finalItems, risks });
  ['productName', 'quantity', 'unit', 'unitPrice', 'priceUnit'].forEach((field) => {
    recorder.check(`items[0].${field} 不被串位`, String(finalItems[0] && finalItems[0][field] || '') === String(localItems[0][field] || '') || hasItemRisk, localItems[0][field], finalItems[0] && finalItems[0][field]);
    recorder.check(`items[1].${field} 不被串位`, String(finalItems[1] && finalItems[1][field] || '') === String(localItems[1][field] || '') || hasItemRisk, localItems[1][field], finalItems[1] && finalItems[1][field]);
  });
  recorder.check('错配前后总额相同不能掩盖问题', moneyToCents(merged.fields.totalAmount || merged.fields.amount) === 467610, 467610, moneyToCents(merged.fields.totalAmount || merged.fields.amount));
  return {
    provider: 'CONTROLLED_AI_FIXTURE_NOT_REAL',
    surface: 'NO_PAGE_OR_WXML',
    localItems,
    controlledAiItems: swappedItems,
    finalItems,
    itemRiskFields: risks
  };
}

function executeRed003(recorder) {
  const local = parseText(CORE_TEXT);
  const aiItems = safeClone(coreItems());
  delete aiItems[1].unitPrice;
  delete aiItems[1].priceUnit;
  delete aiItems[1].totalAmount;
  const merged = applyFinalParseSafety(normalizeControlledAi(local, controlledAiFields({
    items: aiItems,
    amount: '1964.6',
    totalAmount: '1964.6',
    calculatedAmount: '1964.6'
  })), { businessDate: BUSINESS_DATE });
  const risks = itemRiskFields(merged);
  const finalSecond = merged.fields.items && merged.fields.items[1] || {};
  const preserved = String(finalSecond.unitPrice || '') === '8.5';
  recorder.check('原文明示的第二项8.5必须保留或阻断', preserved || risks.length > 0, 'unitPrice=8.5 或 item级风险', { unitPrice: finalSecond.unitPrice || '', risks });
  recorder.check('不得无告警退化为第一项小计', moneyToCents(merged.fields.totalAmount || merged.fields.amount) === 467610 || risks.length > 0, '467610分 或 item级风险', moneyToCents(merged.fields.totalAmount || merged.fields.amount));
  recorder.check('originalText 不因 AI merge 改写', merged.original_text === CORE_TEXT, CORE_TEXT, merged.original_text);
  return {
    provider: 'CONTROLLED_AI_FIXTURE_NOT_REAL',
    surface: 'NO_PAGE_OR_WXML',
    localSecondItem: local.fields.items[1],
    controlledAiSecondItem: aiItems[1],
    finalSecondItem: finalSecond,
    finalAmountCents: moneyToCents(merged.fields.totalAmount || merged.fields.amount),
    itemRiskFields: risks
  };
}

function executeRed004(recorder) {
  const local = parseText(CORE_TEXT);
  const merged = applyFinalParseSafety(normalizeControlledAi(local, controlledAiFields()), {
    businessDate: BUSINESS_DATE
  });
  const remarkRisks = [];
  (merged.missing_fields || []).forEach((field) => { if (field === 'remark') remarkRisks.push('missing'); });
  (merged.low_confidence_fields || []).forEach((field) => { if (field === 'remark') remarkRisks.push('low_confidence'); });
  (merged.field_conflicts || []).forEach((conflict) => { if (conflict && conflict.field === 'remark') remarkRisks.push('conflict'); });
  recorder.check('客户名中的包装不产生 remark 风险', remarkRisks.length === 0, [], remarkRisks);
  recorder.check('受控 AI 的正确客户名被保留', merged.fields.customerName === '宏达包装厂', '宏达包装厂', merged.fields.customerName);

  const explicitText = '王总下单礼品盒10套，每套3.8元，8月15日交货，需要单独包装。';
  const explicit = applyFinalParseSafety(parseText(explicitText), { businessDate: BUSINESS_DATE });
  recorder.check('独立明确包装要求仍保留风险提示', (explicit.low_confidence_fields || []).includes('remark'), true, explicit.low_confidence_fields || []);
  return {
    provider: 'CONTROLLED_AI_FIXTURE_NOT_REAL',
    surface: 'NO_PAGE_OR_WXML',
    customerIndustryWordRisks: remarkRisks,
    explicitPackagingRisks: explicit.low_confidence_fields || []
  };
}

function executeRed005(recorder) {
  const wrongInternalTotal = buildOrderDraft({
    totalAmount: '9999',
    calculatedAmount: '4676.1',
    customerName: '王总',
    originalText: '王总下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；8月15日交货。'
  });
  const domain = preflight(wrongInternalTotal);
  recorder.check('场景A preflight 阻止内部错误顶层总额', domain.domainCanSaveFormal === false, false, {
    domainCanSaveFormal: domain.domainCanSaveFormal,
    blockingCodes: domain.blockingIssues.map((item) => item.code)
  });
  const state = createInitialState();
  const saved = saveConfirmedDraft(state, safeClone(wrongInternalTotal));
  recorder.check('场景A business 不得写入9999订单', list(state, 'orders').length === 0, 0, list(state, 'orders').map((item) => item.totalAmount));
  recorder.check('场景A 失败不产生客户或待整理', list(state, 'customers').length === 0 && list(state, 'pendingNotes').length === 0, { customers: 0, pendingNotes: 0 }, stateCounts(state));
  recorder.check('场景A 返回正式阻断而非成功订单', saved.type !== 'order', 'blocked/error', saved.type);

  const explicitConflictText = '王总下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计9999元；8月15日交货。';
  const parsedConflict = parseText(explicitConflictText);
  const conflictDomain = preflight(parsedConflict);
  const amountConflict = (parsedConflict.field_conflicts || []).some((item) => ['amount', 'totalAmount'].includes(item && item.field));
  recorder.check('场景B 识别用户明示总计9999', moneyToCents(parsedConflict.fields.statedAmount) === 999900, 999900, moneyToCents(parsedConflict.fields.statedAmount));
  recorder.check('场景B 产生金额冲突', amountConflict, true, parsedConflict.field_conflicts || []);
  recorder.check('场景B preflight 阻止未确认保存', conflictDomain.domainCanSaveFormal === false, false, {
    domainCanSaveFormal: conflictDomain.domainCanSaveFormal,
    blockingCodes: conflictDomain.blockingIssues.map((item) => item.code)
  });
  return {
    provider: 'NO_PROVIDER',
    surface: 'NO_PAGE_OR_WXML',
    scenarioA: { preflight: domain.domainCanSaveFormal, saveType: saved.type, state: stateCounts(state) },
    scenarioB: {
      parsedStatedAmount: parsedConflict.fields.statedAmount,
      parsedCalculatedAmount: parsedConflict.fields.calculatedAmount,
      conflicts: parsedConflict.field_conflicts || [],
      preflight: conflictDomain.domainCanSaveFormal
    }
  };
}

function executeRed006(recorder) {
  const sameState = createInitialState();
  const sameDraft = buildOrderDraft({
    confirmationSessionId: 'confirmation-session-stable-001',
    operationId: 'save-operation-stable-001'
  });
  const first = saveConfirmedDraft(sameState, safeClone(sameDraft));
  const firstCounts = stateCounts(sameState);
  const firstBusinessRevision = stableHash(sameState);
  const second = saveConfirmedDraft(sameState, safeClone(sameDraft));
  const secondCounts = stateCounts(sameState);
  const secondBusinessRevision = stableHash(sameState);
  const replayResult = Boolean(second && (
    second.idempotentReplay === true
    || second.replay === true
    || (second.record && first.record && second.record.id === first.record.id)
  ));
  recorder.check('同一 operation 首次保存成功', first.type === 'order' && firstCounts.orders === 1, { type: 'order', orders: 1 }, { type: first.type, counts: firstCounts });
  recorder.check('同一 operation 重放不新增订单', secondCounts.orders === 1, 1, secondCounts.orders);
  recorder.check('同一 operation 重放不新增进度', secondCounts.orderProgress === 1, 1, secondCounts.orderProgress);
  recorder.check('同一 operation 重放不新增 parse log', secondCounts.aiParseLogs === 1, 1, secondCounts.aiParseLogs);
  recorder.check('同一 operation 重放不新增客户', secondCounts.customers === 1, 1, secondCounts.customers);
  recorder.check('同一 operation 重放不发生额外业务 revision', secondBusinessRevision === firstBusinessRevision, firstBusinessRevision, secondBusinessRevision);
  recorder.check('同一 operation 返回同一成功或 replay 结果', replayResult, true, { firstId: first.record && first.record.id, secondId: second.record && second.record.id, secondType: second.type });

  const newOperationState = createInitialState();
  const firstOperation = buildOrderDraft({ confirmationSessionId: 'confirmation-session-new-001', operationId: 'save-operation-new-001' });
  const secondOperation = buildOrderDraft({ confirmationSessionId: 'confirmation-session-new-002', operationId: 'save-operation-new-002' });
  saveConfirmedDraft(newOperationState, firstOperation);
  saveConfirmedDraft(newOperationState, secondOperation);
  const newCounts = stateCounts(newOperationState);
  recorder.check('新的 operation 允许保存相同内容为另一张订单', newCounts.orders === 2 && new Set(newOperationState.orders.map((item) => item.id)).size === 2, 2, newCounts.orders);
  recorder.check('新的 operation 仍复用同一客户', newCounts.customers === 1, 1, newCounts.customers);
  return {
    provider: 'NO_PROVIDER',
    surface: 'BUSINESS_API_NO_PAGE',
    stableOperation: {
      firstCounts,
      secondCounts,
      firstBusinessRevision,
      secondBusinessRevision,
      revisionObservation: 'BUSINESS_STATE_FINGERPRINT_EQUIVALENT',
      replayResult
    },
    newOperation: newCounts,
    productionApiAcceptedIdentityFields: false
  };
}

function executeRed007(recorder) {
  const blockedText = '王总下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元。';
  const blockedDraft = buildOrderDraft({ customerName: '王总', originalText: blockedText, dueDate: '' });
  const formalState = createInitialState();
  const formalResult = saveConfirmedDraft(formalState, safeClone(blockedDraft));
  const formalCounts = stateCounts(formalState);
  recorder.check('SAVE_FORMAL 返回明确阻断', formalResult.type === 'error' || formalResult.blocked === true, 'error/blocked', formalResult.type);
  recorder.check('SAVE_FORMAL 不产生订单', formalCounts.orders === 0, 0, formalCounts.orders);
  recorder.check('SAVE_FORMAL 不自动产生 pending', formalCounts.pendingNotes === 0, 0, formalCounts.pendingNotes);
  recorder.check('SAVE_FORMAL 不产生客户', formalCounts.customers === 0, 0, formalCounts.customers);
  recorder.check('SAVE_FORMAL 不产生 parse log', formalCounts.aiParseLogs === 0, 0, formalCounts.aiParseLogs);
  recorder.check('SAVE_FORMAL 不产生任何范围外业务', formalCounts.receivables === 0 && formalCounts.paymentRecords === 0 && formalCounts.quotations === 0 && formalCounts.todos === 0, { receivables: 0, payments: 0, quotations: 0, todos: 0 }, formalCounts);

  const pendingState = createInitialState();
  savePendingNote(pendingState, safeClone(blockedDraft), '用户明确选择稍后整理');
  const pendingCounts = stateCounts(pendingState);
  recorder.check('显式 SAVE_PENDING 才写一条待整理', pendingCounts.pendingNotes === 1 && pendingCounts.orders === 0, { pendingNotes: 1, orders: 0 }, pendingCounts);
  return {
    provider: 'NO_PROVIDER',
    surface: 'BUSINESS_API_NO_PAGE',
    formal: { resultType: formalResult.type, counts: formalCounts, blockingIssues: formalResult.preflight && formalResult.preflight.blockingIssues || [] },
    explicitPending: pendingCounts
  };
}

function executeGreen001(recorder) {
  const state = createInitialState();
  const draft = buildOrderDraft({ confirmationSessionId: 'green-session-001', operationId: 'green-operation-001' });
  const saved = saveConfirmedDraft(state, draft);
  const counts = stateCounts(state);
  const order = state.orders[0] || {};
  const savedItems = list(order, 'items');
  recorder.check('正确 final draft 保存为一张订单', saved.type === 'order' && counts.orders === 1, { type: 'order', orders: 1 }, { type: saved.type, orders: counts.orders });
  recorder.check('订单包含两个 items', savedItems.length === 2, 2, savedItems.length);
  recorder.check('逐项金额按整数分正确', lineSubtotalCents(savedItems[0]) === 196460 && lineSubtotalCents(savedItems[1]) === 271150, [196460, 271150], savedItems.map(lineSubtotalCents));
  recorder.check('整单总额为467610分', moneyToCents(order.totalAmount) === 467610, 467610, moneyToCents(order.totalAmount));
  recorder.check('整单交期正确', order.requiredDeliveryDate === '2026-08-15' && order.expectedShipDate === '2026-08-15', '2026-08-15', { required: order.requiredDeliveryDate, expected: order.expectedShipDate });
  recorder.check('originalText 完整', order.originalText === CORE_TEXT, CORE_TEXT, order.originalText);
  recorder.check('正式副作用基数正确', counts.customers === 1 && counts.orderProgress === 1 && counts.aiParseLogs === 1, { customers: 1, orderProgress: 1, aiParseLogs: 1 }, counts);
  recorder.check('没有额外业务记录', counts.pendingNotes === 0 && counts.receivables === 0 && counts.paymentRecords === 0 && counts.quotations === 0 && counts.todos === 0, { pendingNotes: 0, receivables: 0, paymentRecords: 0, quotations: 0, todos: 0 }, counts);
  return {
    provider: 'NO_PROVIDER_TRUSTED_FINAL_DRAFT',
    surface: 'BUSINESS_CONTROL_ONLY',
    saveType: saved.type,
    counts,
    order
  };
}

function executeGreen002(recorder) {
  const text = '王总下单：礼品盒517套，每套3.8元；饭盒319个；8月15日交货。';
  const incompleteItems = coreItems();
  incompleteItems[1].unitPrice = '';
  incompleteItems[1].priceUnit = '';
  incompleteItems[1].totalAmount = '';
  const draft = buildOrderDraft({
    customerName: '王总',
    originalText: text,
    items: incompleteItems,
    totalAmount: '1964.6',
    calculatedAmount: '1964.6'
  });
  const state = createInitialState();
  const saved = saveConfirmedDraft(state, draft);
  const order = state.orders[0] || {};
  const second = order.items && order.items[1] || {};
  recorder.check('原文缺价时可按不完整订单保存', saved.type === 'order' && state.orders.length === 1, { type: 'order', orders: 1 }, { type: saved.type, orders: state.orders.length });
  recorder.check('不完整第二项仍保留', order.items && order.items.length === 2 && second.productName === '饭盒', { items: 2, productName: '饭盒' }, { items: order.items && order.items.length, second });
  recorder.check('不得编造第二项价格', !second.unitPrice && !second.totalAmount, { unitPrice: '', totalAmount: '' }, { unitPrice: second.unitPrice, totalAmount: second.totalAmount });
  recorder.check('有交期且没有待整理', order.requiredDeliveryDate === '2026-08-15' && state.pendingNotes.length === 0, { dueDate: '2026-08-15', pendingNotes: 0 }, { dueDate: order.requiredDeliveryDate, pendingNotes: state.pendingNotes.length });
  return {
    provider: 'NO_PROVIDER_TRUSTED_FINAL_DRAFT',
    surface: 'BUSINESS_CONTROL_ONLY',
    saveType: saved.type,
    secondItem: second,
    counts: stateCounts(state)
  };
}

function executeGreen003(recorder) {
  const text = '王总订100个水杯，每个8元，8月15日交。';
  const item = { productName: '水杯', quantity: '100', unit: '个', unitPrice: '8', priceUnit: '个', totalAmount: '800' };
  const draft = buildOrderDraft({
    customerName: '王总',
    originalText: text,
    items: [item],
    totalAmount: '800',
    calculatedAmount: '800'
  });
  const state = createInitialState();
  const saved = saveConfirmedDraft(state, draft);
  const order = state.orders[0] || {};
  recorder.check('单商品仍保存为一张订单', saved.type === 'order' && state.orders.length === 1, { type: 'order', orders: 1 }, { type: saved.type, orders: state.orders.length });
  recorder.check('单商品兼容为一个 item', order.items && order.items.length === 1 && order.items[0].productName === '水杯', { items: 1, productName: '水杯' }, order.items || []);
  recorder.check('单商品交期正确', order.requiredDeliveryDate === '2026-08-15', '2026-08-15', order.requiredDeliveryDate);
  recorder.check('单商品原文完整', order.originalText === text, text, order.originalText);
  recorder.check('单商品不产生待整理', state.pendingNotes.length === 0, 0, state.pendingNotes.length);
  return {
    provider: 'NO_PROVIDER_TRUSTED_FINAL_DRAFT',
    surface: 'BUSINESS_CONTROL_ONLY',
    saveType: saved.type,
    counts: stateCounts(state),
    order
  };
}

const executors = {
  'REC-E2E-MIO-RED-001': executeRed001,
  'REC-E2E-MIO-RED-002': executeRed002,
  'REC-E2E-MIO-RED-003': executeRed003,
  'REC-E2E-MIO-RED-004': executeRed004,
  'REC-E2E-MIO-RED-005': executeRed005,
  'REC-E2E-MIO-RED-006': executeRed006,
  'REC-E2E-MIO-RED-007': executeRed007,
  'REC-E2E-MIO-GREEN-001': executeGreen001,
  'REC-E2E-MIO-GREEN-002': executeGreen002,
  'REC-E2E-MIO-GREEN-003': executeGreen003
};

function executeCase(testCase) {
  const executor = executors[testCase.caseId];
  if (!executor) {
    return {
      caseId: testCase.caseId,
      caseStatus: 'RUNNER_ERROR',
      contractKind: testCase.contractKind,
      error: { code: 'TEST_DATA_ERROR', message: `Missing executor for ${testCase.caseId}` },
      productionLocations: testCase.productionLocations,
      surfaceError: false
    };
  }
  try {
    return withFrozenClock(testCase.caseId, () => {
      const recorder = createAssertions();
      const evidence = executor(recorder);
      const caseStatus = classifyAssertions(recorder.assertions);
      const firstFailure = recorder.assertions.find((item) => !item.pass) || null;
      const result = {
        caseId: testCase.caseId,
        caseStatus,
        contractKind: testCase.contractKind,
        layer: testCase.layer,
        title: testCase.title,
        scenario: testCase.scenario,
        baselineExpectation: testCase.baselineExpectation,
        assertions: recorder.assertions,
        firstFailure,
        evidence,
        productionLocations: safeClone(testCase.productionLocations),
        clock: { businessDate: BUSINESS_DATE, nowInstant: NOW_INSTANT, timezone: TIMEZONE },
        surfaceError: false
      };
      result.semanticFingerprint = stableHash({
        caseId: result.caseId,
        caseStatus: result.caseStatus,
        assertions: result.assertions.map((item) => ({ name: item.name, pass: item.pass, actual: item.actual })),
        evidence: result.evidence
      });
      return result;
    });
  } catch (error) {
    return {
      caseId: testCase.caseId,
      caseStatus: 'RUNNER_ERROR',
      contractKind: testCase.contractKind,
      layer: testCase.layer,
      title: testCase.title,
      error: { code: error.code || 'RUNNER_ERROR', message: error.message, stack: error.stack || '' },
      productionLocations: safeClone(testCase.productionLocations),
      surfaceError: false
    };
  }
}

module.exports = {
  buildOrderDraft,
  classifyAssertions,
  executeCase,
  moneyToCents,
  stateCounts
};
