#!/usr/bin/env node

const assert = require('assert');
const {
  convertQuotationToOrder,
  generateReceivableFromOrder,
  saveConfirmedDraft,
  savePendingNote
} = require('../utils/business');
const { buildRecentRecords } = require('../utils/home-workbench');
const { buildSaveEligibility, createNoAiAdapter, runRecordFlow } = require('../utils/record-flow-core');
const { buildRecordConfirmation } = require('../utils/record-confirmation-builder');
const { HEADLESS_TEST_CAPABILITIES } = require('../utils/record-confirmation-contract');
const { evaluateRecordDomainPreflight } = require('../utils/record-domain-preflight');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { commitRecordSavePlan, validateInvariants } = require('../utils/record-save-commit');
const { createRecordMemoryStore } = require('../utils/record-memory-store');
const { prepareRecordSavePlan, computePlanHash } = require('../utils/record-save-plan-builder');
const { COMMIT_STATUSES, SAVE_ACTIONS } = require('../utils/record-save-plan-contract');
const {
  FULL_COLLECTIONS,
  createStateDiff,
  getStateFingerprint,
  normalizeDomainState,
  safeClone,
  stableHash,
  stableSerialize
} = require('../utils/record-state-diff');
const { createInitialState } = require('../utils/storage');

delete global.wx;

const FIXED_INSTANT = '2026-07-22T02:30:00.000Z';
const BUSINESS_DATE = '2026-07-22';
const tests = [];
let legacyEquivalenceVisitor = null;
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function stateWith(overrides = {}) {
  return Object.assign(createInitialState(), {
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [],
    todos: [], pendingNotes: [], orderProgress: [], aiParseLogs: [], operationLogs: [],
    productCatalog: [], dunningRecords: [], deletedRecords: []
  }, clone(overrides));
}

function customer(id, name, overrides = {}) {
  return Object.assign({
    id, userId: 'local-user', name, phoneMasked: '', phoneFingerprint: '', company: '', region: '',
    wechatRemark: '', duplicateReviewed: false, mergedInto: '', tags: [], isTemporary: true,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', lastTradeAt: '2026-07-01'
  }, overrides);
}

function order(id, customerId, overrides = {}) {
  return Object.assign({
    id, userId: 'local-user', customerId, quotationId: '', productName: '礼品盒', spec: '',
    quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000',
    items: [{ productName: '礼品盒', spec: '', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000', itemDeliveryDate: '', itemRemark: '' }],
    originalText: '历史订单', paymentMethod: '', orderDate: '2026-07-01', requiredDeliveryDate: '2026-08-01',
    expectedShipDate: '2026-08-01', actualShipDate: '', status: '待生产', logisticsInfo: '', remark: '',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z'
  }, overrides);
}

function quotation(id, customerId, overrides = {}) {
  return Object.assign({
    id, userId: 'local-user', customerId, productName: '礼品盒', spec: '', quantity: '100', unit: '个',
    unitPrice: '10', priceUnit: '个', totalAmount: '1000',
    items: [{ productName: '礼品盒', spec: '', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000', itemDeliveryDate: '', itemRemark: '' }],
    originalText: '历史报价', paymentMethod: '', followupDays: '', deliveryDate: '', quoteDate: '2026-07-01',
    validUntil: '2026-07-08', status: '待确认', remark: '',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z'
  }, overrides);
}

function receivable(id, customerId, overrides = {}) {
  return Object.assign({
    id, userId: 'local-user', customerId, orderId: '', amount: '1000', dueDate: '2026-08-01',
    status: '部分收款', source: 'manual', paidAmount: '200', dunningCount: 0, lastDunningDate: '',
    originalText: '历史待收', remark: '',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z'
  }, overrides);
}

function result(intent, operation, fields, originalText, overrides = {}) {
  return Object.assign({
    intent,
    operation,
    fields: clone(fields || {}),
    original_text: originalText || '合成保存输入',
    source: 'test',
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    formal_save_blocked: false,
    mixed_business: false,
    requires_existing_record: false
  }, overrides);
}

function orderResult(fields = {}, text = '王总订礼品盒100个，每个10元，8月1日交') {
  return result('order', 'create_order', Object.assign({
    customerName: '王总', productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个',
    amount: '1000', totalAmount: '1000', dueDate: '2026-08-01',
    items: [{ productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' }]
  }, fields), text);
}

function fixedClock() { return { now: () => new Date(FIXED_INSTANT) }; }

function scopedIdGenerator(prefix) {
  let count = 0;
  return { next(scope) { count += 1; return `${prefix}-${scope}-${count}`; } };
}

function preflight(finalResult, initialState) {
  return evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING', resultScope: 'PRODUCTION_RESULT', operation: finalResult.operation,
    businessType: finalResult.intent, finalResult, originalText: finalResult.original_text,
    initialState, aiOutcome: (finalResult.ai_fallback || {}).status || 'not_requested',
    providerKind: (finalResult.ai_fallback || {}).provider_kind || 'NONE', skipFinalSafety: true
  });
}

function prepare(finalResultInput, initialStateInput, action = SAVE_ACTIONS.SAVE_FORMAL, options = {}) {
  const initialState = initialStateInput || stateWith();
  const finalResult = applyFinalParseSafety(clone(finalResultInput), { businessDate: BUSINESS_DATE });
  const domainPreflight = preflight(finalResult, initialState);
  const eligibility = buildSaveEligibility(finalResult, { providerKind: 'NONE', aiRequested: false });
  const confirmation = buildRecordConfirmation({
    mode: options.mode || 'PRODUCTION_ROUTING',
    resultScope: options.resultScope || 'PRODUCTION_RESULT',
    productionRoute: 'LOCAL', executionPath: 'PRODUCTION_LOCAL', finalResult,
    finalSafety: finalResult.final_parse_safety, saveEligibility: eligibility, preflight: domainPreflight,
    aiOutcome: (finalResult.ai_fallback || {}).status || 'not_requested',
    providerKind: (finalResult.ai_fallback || {}).provider_kind || 'NONE',
    originalText: finalResult.original_text, normalizedText: finalResult.original_text, inputSource: 'test',
    businessDate: BUSINESS_DATE, businessTimezone: 'Asia/Shanghai', initialState,
    surfaceCapabilities: HEADLESS_TEST_CAPABILITIES,
    confirmationId: options.confirmationId || 'confirmation-phase1e1'
  });
  const savePlan = prepareRecordSavePlan({
    action, mode: options.mode || 'PRODUCTION_ROUTING', resultScope: options.resultScope || 'PRODUCTION_RESULT',
    confirmation, preflight: confirmation.preflight, finalResult, initialState,
    sourceStateVersion: options.sourceStateVersion || 1, businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai', nowInstant: FIXED_INSTANT, pendingReason: options.pendingReason
  }, { clock: fixedClock(), idGenerator: options.planIdGenerator || scopedIdGenerator('plan') });
  return { finalResult, preflight: domainPreflight, confirmation, savePlan };
}

function authorization(plan, overrides = {}) {
  return Object.assign({
    userInitiated: true,
    planId: plan.planId,
    planHash: plan.planHash,
    idempotencyKey: plan.idempotencyKey,
    action: plan.action,
    confirmationId: plan.confirmationId,
    confirmationRevision: plan.confirmationRevision,
    confirmationContentHash: plan.confirmationContentHash,
    preflightFingerprint: plan.preflightFingerprint
  }, overrides);
}

function commit(plan, store, options = {}) {
  return commitRecordSavePlan(plan, store, {
    target: 'MEMORY', clock: fixedClock(), idGenerator: options.idGenerator || scopedIdGenerator('business'),
    authorization: options.authorization || authorization(plan)
  });
}

function withFixedGlobals(fn) {
  const OriginalDate = global.Date;
  const originalRandom = Math.random;
  let randomIndex = 0;
  class FixedDate extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_INSTANT])); }
    static now() { return new OriginalDate(FIXED_INSTANT).getTime(); }
  }
  FixedDate.parse = OriginalDate.parse;
  FixedDate.UTC = OriginalDate.UTC;
  global.Date = FixedDate;
  Math.random = () => { randomIndex += 1; return ((randomIndex % 997) + 1) / 1000; };
  try { return fn(); } finally { global.Date = OriginalDate; Math.random = originalRandom; }
}

function canonicalState(state, initialState) {
  const normalized = normalizeDomainState(state);
  const initial = normalizeDomainState(initialState);
  const replacements = {};
  Object.values(FULL_COLLECTIONS).forEach((collection) => {
    const initialIds = new Set((initial[collection] || []).map((item) => String(item.id || '')));
    let count = 0;
    (normalized[collection] || []).forEach((item) => {
      const id = String(item.id || '');
      if (id && !initialIds.has(id)) {
        count += 1;
        replacements[id] = `${collection}:new:${count}`;
      }
    });
  });
  function replace(value) {
    if (typeof value === 'string' && replacements[value]) return replacements[value];
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((output, key) => {
        output[key] = replace(value[key]);
        return output;
      }, {});
    }
    return value;
  }
  return Object.values(FULL_COLLECTIONS).reduce((output, collection) => {
    output[collection] = replace(normalized[collection]);
    return output;
  }, {});
}

function legacySave(initialState, finalResult, action) {
  const state = clone(initialState);
  withFixedGlobals(() => {
    if (action === SAVE_ACTIONS.SAVE_PENDING) savePendingNote(state, clone(finalResult), '用户选择稍后整理');
    else {
      const saved = saveConfirmedDraft(state, clone(finalResult));
      assert.notStrictEqual(saved && saved.type, 'pending', `legacy unexpected pending: ${finalResult.intent}/${finalResult.operation}`);
      assert.notStrictEqual(saved && saved.type, 'error', `legacy unexpected error: ${finalResult.intent}/${finalResult.operation}`);
    }
  });
  return state;
}

function newSave(initialState, prepared, label = '') {
  const store = createRecordMemoryStore(initialState);
  const receipt = commit(prepared.savePlan, store);
  assert.strictEqual(receipt.status, COMMIT_STATUSES.COMMITTED, `${label}:${JSON.stringify(receipt.errors)}`);
  return { state: store.getState(), receipt };
}

test('SavePlan为纯数据且planHash在固定输入、state、clock和ID策略下稳定', () => {
  const initial = stateWith();
  const draft = orderResult();
  const beforeState = JSON.stringify(initial);
  const beforeDraft = JSON.stringify(draft);
  const first = prepare(draft, initial).savePlan;
  const second = prepare(draft, initial).savePlan;
  assert.strictEqual(first.blocked, false);
  assert.strictEqual(first.planHash, second.planHash);
  assert.strictEqual(first.planId, second.planId);
  assert.strictEqual(computePlanHash(first), first.planHash);
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.strictEqual(JSON.stringify(initial), beforeState);
  assert.strictEqual(JSON.stringify(draft), beforeDraft);
  assert.strictEqual(JSON.stringify(first).includes('wx.'), false);
  assert.strictEqual(JSON.stringify(first).includes('function'), false);
});

test('正式保存阻断与待整理严格分离，非生产mode和不可信provider不能产生正式操作', () => {
  const blocked = prepare(result('unknown', 'pending', {}, '无法识别', { formal_save_blocked: true }), stateWith());
  assert.strictEqual(blocked.savePlan.blocked, true);
  assert.deepStrictEqual(blocked.savePlan.operations, []);
  const pending = prepare(blocked.finalResult, stateWith(), SAVE_ACTIONS.SAVE_PENDING);
  assert.strictEqual(pending.savePlan.blocked, false, JSON.stringify({
    issues: pending.savePlan.blockingIssues,
    helper: pending.preflight.preflightFingerprint,
    confirmation: pending.confirmation.preflightFingerprint,
    plan: pending.savePlan.preflightFingerprint
  }));
  assert.deepStrictEqual(Array.from(new Set(pending.savePlan.operations.map((item) => item.entityType))), ['PENDING_NOTE']);
  ['LOCAL_ONLY', 'AI_ONLY'].forEach((mode) => {
    const resultScope = mode === 'LOCAL_ONLY' ? 'LOCAL_ONLY_RESULT' : 'AI_ONLY_RESULT';
    const output = prepare(orderResult(), stateWith(), SAVE_ACTIONS.SAVE_FORMAL, { mode, resultScope });
    assert.strictEqual(output.savePlan.blocked, true);
    assert.strictEqual(output.savePlan.operations.length, 0);
  });
  ['MOCK', 'FAKE', 'REPLAY'].forEach((providerKind) => {
    const draft = orderResult({}, `provider ${providerKind}`);
    draft.parse_route = { decision: 'ai_standard' };
    draft.ai_fallback = { attempted: true, status: providerKind === 'MOCK' ? 'mock_used' : 'used', business_result_valid: true, provider_kind: providerKind };
    const output = prepare(draft, stateWith());
    assert.strictEqual(output.savePlan.blocked, true, providerKind);
    assert.strictEqual(output.savePlan.operations.length, 0, providerKind);
  });
});

test('Confirmation、Preflight和state绑定任一变化都会阻断或使旧计划过期', () => {
  const initial = stateWith();
  const prepared = prepare(orderResult(), initial);
  const plan = prepared.savePlan;
  ['confirmationRevision', 'confirmationContentHash', 'preflightFingerprint'].forEach((field) => {
    const changed = clone(plan);
    changed[field] = `${changed[field]}-changed`;
    changed.planHash = computePlanHash(changed);
    changed.idempotencyKey = `record-save:${changed.planHash}`;
    const store = createRecordMemoryStore(initial);
    const receipt = commit(changed, store, { authorization: authorization(plan) });
    assert.strictEqual(receipt.status, COMMIT_STATUSES.FAILED, field);
  });
  const changedState = clone(initial);
  changedState.todos.push({ id: 'todo-external', title: '外部变化' });
  const stale = commit(plan, createRecordMemoryStore(changedState));
  assert.strictEqual(stale.status, COMMIT_STATUSES.STALE_PLAN);
});

test('MemoryStore深拷贝、版本和指纹隔离，不共享题目state', () => {
  const initial = stateWith();
  const first = createRecordMemoryStore(initial);
  const second = createRecordMemoryStore(initial);
  const before = JSON.stringify(initial);
  const prepared = prepare(orderResult(), initial);
  assert.strictEqual(commit(prepared.savePlan, first).status, COMMIT_STATUSES.COMMITTED);
  assert.strictEqual(second.getState().orders.length, 0);
  assert.strictEqual(first.getVersion(), 2);
  assert.strictEqual(second.getVersion(), 1);
  assert.notStrictEqual(first.getFingerprint(), second.getFingerprint());
  assert.strictEqual(JSON.stringify(initial), before);
});

test('Commit生成业务/full diff并一次增加版本', () => {
  const initial = stateWith();
  const prepared = prepare(orderResult(), initial);
  const store = createRecordMemoryStore(initial);
  const receipt = commit(prepared.savePlan, store);
  assert.strictEqual(receipt.status, COMMIT_STATUSES.COMMITTED);
  assert.strictEqual(receipt.stateVersionBefore, 1);
  assert.strictEqual(receipt.stateVersionAfter, 2);
  assert.strictEqual(receipt.businessDiff.customers.created.length, 1);
  assert.strictEqual(receipt.businessDiff.orders.created.length, 1);
  assert.strictEqual(receipt.fullDiff.orderProgress.created.length, 1);
  assert.strictEqual(receipt.fullDiff.aiParseLogs.created.length, 1);
  assert.strictEqual(receipt.fullDiff.productCatalog.created.length, 1);
});

test('客户、主记录、金融、关联、日志阶段失败均完整回滚', () => {
  const deposit = orderResult({ depositAmount: '300', paymentAmount: '300' }, '王总订礼品盒100个，每个10元，付定金300元，8月1日交');
  const initial = stateWith();
  const plan = prepare(deposit, initial).savePlan;
  const operationIndex = (entityType) => plan.operations.findIndex((operation) => operation.entityType === entityType);
  ['CUSTOMER', 'ORDER', 'PAYMENT', 'AI_PARSE_LOG'].forEach((entityType) => {
    assert(operationIndex(entityType) >= 0, `missing failure injection operation: ${entityType}`);
  });
  assert.strictEqual(
    plan.operations.filter((operation) => operation.entityType === 'AI_PARSE_LOG').length,
    1,
    'composite order deposit plan must contain one parse-log operation'
  );
  const failures = [
    { phase: 'AFTER_APPLY', operationIndex: operationIndex('CUSTOMER') },
    { phase: 'AFTER_APPLY', operationIndex: operationIndex('ORDER') },
    { phase: 'AFTER_APPLY', operationIndex: operationIndex('PAYMENT') },
    { phase: 'BEFORE_APPLY', operationIndex: operationIndex('AI_PARSE_LOG') },
    { phase: 'AFTER_APPLY', operationIndex: operationIndex('AI_PARSE_LOG') },
    { phase: 'BEFORE_INVARIANTS' },
    { phase: 'BEFORE_ATOMIC_SWAP' }
  ];
  const assertRolledBack = (store, label) => {
    const stateBefore = store.getState();
    const fingerprintBefore = store.getFingerprint();
    const receipt = commit(plan, store);
    assert.strictEqual(receipt.status, COMMIT_STATUSES.ROLLED_BACK, label);
    assert.deepStrictEqual(store.getState(), stateBefore, label);
    assert.strictEqual(store.getVersion(), 1, label);
    assert.strictEqual(store.getFingerprint(), fingerprintBefore, label);
    assert.strictEqual(store.getCommitReceipt(plan.planId), null, label);
    assert.strictEqual(JSON.stringify(store.getState()).includes('temp:'), false);
  };
  failures.forEach((failure) => {
    assertRolledBack(createRecordMemoryStore(initial, { failureInjection: failure }), JSON.stringify(failure));
  });

  const readbackStore = createRecordMemoryStore(initial);
  const readWorkingState = readbackStore.getWorkingState.bind(readbackStore);
  let readbackCount = 0;
  readbackStore.getWorkingState = () => {
    readbackCount += 1;
    if (readbackCount > plan.operations.length) throw new Error('injected post-operation readback failure');
    return readWorkingState();
  };
  assertRolledBack(readbackStore, 'post-operation readback failure');
});

test('同一plan幂等重放不重复写入，planId碰撞明确阻断', () => {
  const initial = stateWith();
  const raw = orderResult(
    { depositAmount: '300', paymentAmount: '300' },
    '王总订礼品盒100个每个10元，先付定金300元，8月1日交'
  );
  const plan = prepare(raw, initial).savePlan;
  const store = createRecordMemoryStore(initial);
  const first = commit(plan, store);
  const stateAfterFirst = store.getState();
  const second = commit(plan, store);
  assert.strictEqual(first.status, COMMIT_STATUSES.COMMITTED);
  assert.strictEqual(first.businessDiff.customers.created.length, 1);
  assert.strictEqual(first.businessDiff.orders.created.length, 1);
  assert.strictEqual(first.businessDiff.payments.created.length, 1);
  assert.strictEqual(first.fullDiff.aiParseLogs.created.length, 1);
  assert.strictEqual(stateAfterFirst.aiParseLogs.length, 1);
  assert.strictEqual(stateAfterFirst.aiParseLogs[0].action, 'save_order');
  assert.strictEqual(second.status, COMMIT_STATUSES.ALREADY_COMMITTED);
  assert.strictEqual(second.idempotentReplay, true);
  assert.deepStrictEqual(store.getState(), stateAfterFirst);
  assert.strictEqual(store.getVersion(), 2);
  const sameBusinessPlan = clone(plan);
  sameBusinessPlan.planId = 'another-plan-id';
  const sameBusinessReceipt = commit(sameBusinessPlan, store);
  assert.strictEqual(sameBusinessReceipt.status, COMMIT_STATUSES.ALREADY_COMMITTED);
  assert.strictEqual(store.getVersion(), 2);

  const collision = clone(plan);
  collision.originalText = `${collision.originalText}冲突`;
  collision.planHash = computePlanHash(collision);
  collision.idempotencyKey = `record-save:${collision.planHash}`;
  const collisionReceipt = commit(collision, store, { authorization: authorization(collision) });
  assert.strictEqual(collisionReceipt.status, COMMIT_STATUSES.BLOCKED);
  assert(collisionReceipt.errors.some((item) => item.code === 'SAVE_PLAN_ID_COLLISION'));
});

test('依赖环、悬空临时引用、危险键和重复业务ID均fail closed', () => {
  const initial = stateWith();
  const plan = prepare(orderResult(), initial).savePlan;

  const cyclic = clone(plan);
  cyclic.operations[0].dependsOn = [cyclic.operations[0].operationId];
  cyclic.planHash = computePlanHash(cyclic);
  cyclic.idempotencyKey = `record-save:${cyclic.planHash}`;
  const cyclicReceipt = commit(cyclic, createRecordMemoryStore(initial), { authorization: authorization(cyclic) });
  assert.strictEqual(cyclicReceipt.status, COMMIT_STATUSES.FAILED);
  assert(cyclicReceipt.errors.some((item) => item.code === 'SAVE_PLAN_DEPENDENCY_INVALID'));

  const dangling = clone(plan);
  dangling.operations[1].payload.customerId = 'temp:customer:missing';
  dangling.planHash = computePlanHash(dangling);
  dangling.idempotencyKey = `record-save:${dangling.planHash}`;
  const danglingReceipt = commit(dangling, createRecordMemoryStore(initial), { authorization: authorization(dangling) });
  assert.strictEqual(danglingReceipt.status, COMMIT_STATUSES.FAILED);
  assert(danglingReceipt.errors.some((item) => item.code === 'SAVE_PLAN_TEMP_REFERENCE_INVALID'));

  const missingDependency = clone(plan);
  const relationOperation = missingDependency.operations.find((operation) => operation.relationUpdates.length);
  assert(relationOperation);
  relationOperation.dependsOn = [];
  missingDependency.planHash = computePlanHash(missingDependency);
  missingDependency.idempotencyKey = `record-save:${missingDependency.planHash}`;
  const missingDependencyReceipt = commit(missingDependency, createRecordMemoryStore(initial), {
    authorization: authorization(missingDependency)
  });
  assert.strictEqual(missingDependencyReceipt.status, COMMIT_STATUSES.FAILED);
  assert(missingDependencyReceipt.errors.some((item) => item.code === 'SAVE_PLAN_DEPENDENCY_INVALID'));

  const wrongCollection = clone(plan);
  wrongCollection.operations[0].collection = 'orders';
  wrongCollection.planHash = computePlanHash(wrongCollection);
  wrongCollection.idempotencyKey = `record-save:${wrongCollection.planHash}`;
  const wrongCollectionReceipt = commit(wrongCollection, createRecordMemoryStore(initial), {
    authorization: authorization(wrongCollection)
  });
  assert.strictEqual(wrongCollectionReceipt.status, COMMIT_STATUSES.FAILED);
  assert(wrongCollectionReceipt.errors.some((item) => item.code === 'SAVE_PLAN_OPERATION_INVALID'));

  const unknownPrecondition = clone(plan);
  unknownPrecondition.operations[0].preconditions = [{ type: 'ASSUME_SAFE' }];
  unknownPrecondition.planHash = computePlanHash(unknownPrecondition);
  unknownPrecondition.idempotencyKey = `record-save:${unknownPrecondition.planHash}`;
  const unknownPreconditionReceipt = commit(unknownPrecondition, createRecordMemoryStore(initial), {
    authorization: authorization(unknownPrecondition)
  });
  assert.strictEqual(unknownPreconditionReceipt.status, COMMIT_STATUSES.FAILED);
  assert(unknownPreconditionReceipt.errors.some((item) => item.code === 'SAVE_PLAN_OPERATION_INVALID'));

  const unsafe = clone(plan);
  unsafe.operations[0].payload = JSON.parse('{"id":"temp:customer:1","__proto__":{"polluted":true}}');
  const unsafeReceipt = commit(unsafe, createRecordMemoryStore(initial));
  assert.strictEqual(unsafeReceipt.status, COMMIT_STATUSES.FAILED);
  assert(unsafeReceipt.errors.some((item) => item.code === 'SAVE_PLAN_INVALID'));
  assert.strictEqual({}.polluted, undefined);

  const duplicateIdStore = createRecordMemoryStore(initial);
  const duplicateIdReceipt = commit(plan, duplicateIdStore, {
    idGenerator: { next() { return 'same-business-id'; } }
  });
  assert.strictEqual(duplicateIdReceipt.status, COMMIT_STATUSES.FAILED);
  assert.strictEqual(duplicateIdStore.getVersion(), 1);
  assert.deepStrictEqual(duplicateIdStore.getState(), normalizeDomainState(initial));
});

test('LINK合同按目标指纹原子替换关系记录且不绕过diff审计', () => {
  const wang = customer('cus-wang', '王总');
  const initial = stateWith({ customers: [wang], orders: [order('ord-link', 'cus-wang')] });
  const raw = result('order', 'update_order', {
    customerName: '王总', customerId: 'cus-wang', orderId: 'ord-link', productName: '礼品盒',
    quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', amount: '1000', dueDate: '2026-08-03',
    items: [{ productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' }]
  }, '王总这单改到8月3日交', {
    manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'dueDate']
  });
  const plan = clone(prepare(raw, initial).savePlan);
  const orderOperation = plan.operations.find((operation) => operation.entityType === 'ORDER' && operation.action === 'UPDATE');
  assert(orderOperation);
  orderOperation.action = 'LINK';
  plan.planHash = computePlanHash(plan);
  plan.idempotencyKey = `record-save:${plan.planHash}`;
  const store = createRecordMemoryStore(initial);
  const receipt = commit(plan, store, { authorization: authorization(plan) });
  assert.strictEqual(receipt.status, COMMIT_STATUSES.COMMITTED, JSON.stringify(receipt.errors));
  assert.strictEqual(store.getState().orders[0].requiredDeliveryDate, '2026-08-03');
  assert.strictEqual(receipt.businessDiff.orders.updated.length, 1);
});

test('State Diff稳定区分created/updated/deleted、changedFields和空diff', () => {
  const before = stateWith({ customers: [customer('c1', '王总'), customer('c2', '李总')] });
  const after = clone(before);
  after.customers[0].region = '义乌';
  after.customers.splice(1, 1);
  after.todos.push({ id: 't1', title: '发货' });
  const first = createStateDiff(before, after);
  const second = createStateDiff(before, after);
  assert.strictEqual(stableSerialize(first), stableSerialize(second));
  assert.strictEqual(first.businessDiff.customers.updated.length, 1);
  assert(first.businessDiff.customers.updated[0].changedFields.includes('region'));
  assert.strictEqual(first.businessDiff.customers.deleted.length, 1);
  assert.strictEqual(first.businessDiff.todos.created.length, 1);
  assert.strictEqual(createStateDiff(before, before).stateChanged, false);

  const metaAfter = clone(before);
  metaAfter.meta.industry = '礼品';
  const metaDiff = createStateDiff(before, metaAfter);
  assert.strictEqual(metaDiff.stateChanged, true);
  assert.strictEqual(metaDiff.fullDiff.meta.updated.length, 1);
  assert(metaDiff.fullDiff.meta.updated[0].changedFields.includes('value.industry'));
});

test('代表业务与现有business隔离保存结果等价', () => {
  const wang = customer('cus-wang', '王总');
  const ord = order('ord-1', 'cus-wang');
  const quo = quotation('quo-1', 'cus-wang');
  const rec = receivable('rec-1', 'cus-wang', { orderId: 'ord-1' });
  const missingCatalogState = stateWith({ customers: [wang], orders: [ord] });
  delete missingCatalogState.productCatalog;
  const cappedLogsState = stateWith({
    aiParseLogs: Array.from({ length: 100 }, (_, index) => ({
      id: `old-log-${index}`, originalText: `历史日志${index}`, createdAt: '2026-07-01T00:00:00.000Z'
    }))
  });
  const cases = [
    ['新客户订单', stateWith(), orderResult()],
    ['已有客户订单', stateWith({ customers: [wang] }), orderResult({ customerId: 'cus-wang' })],
    ['新订单含定金', stateWith(), Object.assign(
      orderResult({ depositAmount: '300', paymentAmount: '300' },
        '王总订礼品盒100个每个10元，先付定金300元，8月1日交'),
      { id: 'parse-composite-order-deposit' }
    )],
    ['多商品订单', stateWith(), orderResult({
      productName: '礼品盒', amount: '1600', totalAmount: '1600',
      items: [
        { productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' },
        { productName: '水杯', quantity: '200', unit: '个', unitPrice: '3', priceUnit: '个', totalAmount: '600' }
      ]
    }, '王总订礼品盒100个每个10元，水杯200个每个3元，8月1日交')],
    ['报价', stateWith(), result('quotation', 'create_quotation', {
      customerName: '王总', productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', amount: '1000'
    }, '给王总报礼品盒100个，每个10元')],
    ['已有客户报价', stateWith({ customers: [wang] }), result('quotation', 'create_quotation', {
      customerName: '王总', customerId: 'cus-wang', productName: '礼品盒', quantity: '100', unit: '个',
      unitPrice: '10', priceUnit: '个', amount: '1000'
    }, '给已有客户王总报礼品盒100个，每个10元')],
    ['多商品无顶层总额', stateWith(), result('order', 'create_order', {
      customerName: '王总', productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个',
      dueDate: '2026-08-01', items: [
        { productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个' },
        { productName: '水杯', quantity: '200', unit: '个', unitPrice: '3', priceUnit: '个' }
      ]
    }, '王总订礼品盒100个和水杯200个，8月1日交', {
      manual_fields: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate']
    })],
    ['目录缺失时回填历史再保存', missingCatalogState, result('quotation', 'create_quotation', {
      customerName: '王总', customerId: 'cus-wang', productName: '水杯', quantity: '50', unit: '个',
      unitPrice: '3', priceUnit: '个', amount: '150'
    }, '给王总报水杯50个，每个3元')],
    ['更新报价', stateWith({ customers: [wang], quotations: [quo] }), result('quotation', 'update_quotation', {
      customerName: '王总', customerId: 'cus-wang', quotationId: 'quo-1', productName: '礼品盒',
      quantity: '120', unit: '个', unitPrice: '9', priceUnit: '个', amount: '1080'
    }, '王总礼品盒报价改成120个，每个9元', {
      manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'dueDate']
    })],
    ['记一笔关联报价创建订单', stateWith({ customers: [wang], quotations: [quo] }), orderResult({
      customerId: 'cus-wang', quotationId: 'quo-1', quotationSelectionConfirmed: true
    }, '王总确认礼品盒100个每个10元的上一笔报价，8月1日交')],
    ['更新订单', stateWith({ customers: [wang], orders: [ord] }), result('order', 'update_order', {
      customerName: '王总', customerId: 'cus-wang', orderId: 'ord-1', productName: '礼品盒',
      quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', amount: '1000', dueDate: '2026-08-02',
      items: [{ productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' }]
    }, '王总礼品盒100个每个10元的订单改到8月2日交', {
      manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'dueDate']
    })],
    ['创建待收款', stateWith({ customers: [wang] }), result('receivable', 'create_receivable', {
      customerName: '王总', customerId: 'cus-wang', amount: '1000', dueDate: '2026-08-01'
    }, '王总欠1000元，8月1日收')],
    ['按订单创建待收款', stateWith({ customers: [wang], orders: [ord] }), result('receivable', 'create_receivable', {
      customerName: '王总', customerId: 'cus-wang', orderId: 'ord-1', orderSelectionConfirmed: true,
      amount: '1000', dueDate: '2026-08-01'
    }, '王总这单1000元，8月1日收')],
    ['新建待收并首付款', stateWith({ customers: [wang] }), result('payment', 'create_receivable_with_payment', {
      customerName: '王总', customerId: 'cus-wang', amount: '6000', paymentAmount: '4000',
      remainingAmount: '2000', dueDate: '2026-08-01'
    }, '王总总共欠6000元，今天付4000元，还剩2000元，8月1日收')],
    ['按订单新建待收并首付款', stateWith({ customers: [wang], orders: [ord] }), result('payment', 'create_receivable_with_payment', {
      customerName: '王总', customerId: 'cus-wang', orderId: 'ord-1', orderSelectionConfirmed: true,
      amount: '1000', paymentAmount: '300', remainingAmount: '700', dueDate: '2026-08-01'
    }, '王总这单总共1000元，今天付300元，还剩700元，8月1日收')],
    ['部分收款', stateWith({ customers: [wang], orders: [ord], receivables: [rec] }), result('payment', 'record_payment', {
      customerName: '王总', customerId: 'cus-wang', receivableId: 'rec-1', receivableSelectionConfirmed: true, paymentAmount: '300'
    }, '王总今天付了300元')],
    ['正好结清', stateWith({ customers: [wang], orders: [ord], receivables: [rec] }), result('payment', 'record_payment', {
      customerName: '王总', customerId: 'cus-wang', receivableId: 'rec-1', receivableSelectionConfirmed: true, paymentAmount: '800'
    }, '王总今天付清剩余800元')],
    ['未关联普通收款', stateWith({ customers: [wang] }), result('payment', 'record_payment', {
      customerName: '王总', customerId: 'cus-wang', paymentAmount: '300'
    }, '王总今天付了300元，不关联待收')],
    ['订单定金', stateWith({ customers: [wang], orders: [ord] }), result('payment', 'record_order_deposit', {
      customerName: '王总', customerId: 'cus-wang', orderId: 'ord-1', orderSelectionConfirmed: true,
      productName: '礼品盒', paymentAmount: '300', depositAmount: '300', paymentKind: 'deposit'
    }, '王总这单收到定金300元')],
    ['普通提醒', stateWith(), result('todo', 'create_todo', {
      todoTitle: '给王总发样品', dueDate: '2026-07-23'
    }, '明天提醒我给王总发样品')],
    ['催款提醒', stateWith({ customers: [wang] }), result('dunning', 'create_todo', {
      customerName: '王总', customerId: 'cus-wang', todoTitle: '催王总付款', todoType: 'dunning', dueDate: '2026-07-23'
    }, '明天提醒我催王总付款')],
    ['解析日志超过100条时截断', cappedLogsState, result('todo', 'create_todo', {
      todoTitle: '给王总打电话', dueDate: '2026-07-23'
    }, '明天提醒我给王总打电话')],
    ['待整理', stateWith(), result('unknown', 'pending', {}, '这段内容先留着', { formal_save_blocked: true })]
  ];
  assert.strictEqual(cases.length, 23);
  cases.forEach(([name, initial, raw]) => {
    const action = name === '待整理' ? SAVE_ACTIONS.SAVE_PENDING : SAVE_ACTIONS.SAVE_FORMAL;
    const prepared = prepare(raw, initial, action, { pendingReason: '用户选择稍后整理' });
    assert.strictEqual(prepared.savePlan.blocked, false, `${name}:${JSON.stringify(prepared.savePlan.blockingIssues)}`);
    const legacy = legacySave(initial, prepared.finalResult, action);
    const shared = newSave(initial, prepared, name);
    const modern = shared.state;
    assert.deepStrictEqual(canonicalState(modern, initial), canonicalState(legacy, initial), name);
    if (typeof legacyEquivalenceVisitor === 'function') {
      legacyEquivalenceVisitor({
        name,
        action,
        initialState: clone(initial),
        rawResult: clone(raw),
        prepared: clone(prepared),
        legacyState: clone(legacy),
        sharedState: clone(modern)
      });
    }
    assert.deepStrictEqual(modern.meta, normalizeDomainState(initial).meta, `${name}:meta must not change`);
    assert.deepStrictEqual(modern.dunningTemplates, normalizeDomainState(initial).dunningTemplates, `${name}:templates must not change`);
    if (name === '目录缺失时回填历史再保存') {
      assert.deepStrictEqual(modern.productCatalog.map((item) => item.productName).sort(), ['水杯', '礼品盒']);
      assert(modern.productCatalog.every((item) => Number(item.useCount) >= 1));
    }
    if (name === '解析日志超过100条时截断') {
      assert.strictEqual(modern.aiParseLogs.length, 100);
      assert.strictEqual(modern.aiParseLogs[0].originalText, raw.original_text);
      assert.strictEqual(modern.aiParseLogs.some((item) => item.id === 'old-log-99'), false);
    }
    if (name === '新订单含定金') {
      [legacy, modern].forEach((savedState) => {
        assert.strictEqual(savedState.orders.length, 1);
        assert.strictEqual(savedState.paymentRecords.length, 1);
        assert.strictEqual(savedState.orderProgress.length, 2);
        assert.strictEqual(savedState.operationLogs.length, 0);
        assert.strictEqual(savedState.paymentRecords[0].kind, 'deposit');
        assert.strictEqual(savedState.paymentRecords[0].orderId, savedState.orders[0].id);
        assert.strictEqual(savedState.aiParseLogs.length, 1);
        assert.strictEqual(savedState.aiParseLogs[0].action, 'save_order');
        assert.strictEqual(savedState.aiParseLogs[0].userId, 'local-user');
        assert.strictEqual(savedState.aiParseLogs[0].inputSource, 'test');
        assert.strictEqual(savedState.aiParseLogs[0].originalText, raw.original_text);
        assert.strictEqual(savedState.aiParseLogs[0].parseResult.id, 'parse-composite-order-deposit');
        assert.strictEqual(savedState.aiParseLogs[0].parseResult.intent, 'order');
        assert.strictEqual(savedState.aiParseLogs[0].parseResult.operation, 'create_order');
        assert.strictEqual(savedState.aiParseLogs[0].parseResult.fields.depositAmount, '300');
        assert.strictEqual(savedState.aiParseLogs[0].createdAt, FIXED_INSTANT);
      });
      assert.strictEqual(
        prepared.savePlan.operations.filter((operation) => operation.entityType === 'AI_PARSE_LOG').length,
        1
      );
      assert.strictEqual(
        stableHash(legacy.aiParseLogs[0].parseResult, 'parse-result1'),
        stableHash(modern.aiParseLogs[0].parseResult, 'parse-result1')
      );
      assert.strictEqual(shared.receipt.stateVersionBefore, 1);
      assert.strictEqual(shared.receipt.stateVersionAfter, 2);
      assert.strictEqual(shared.receipt.fullDiff.aiParseLogs.created.length, 1);
      const recentMatches = buildRecentRecords(modern, 3)
        .filter((record) => record.title.includes(raw.original_text.slice(0, 8)));
      assert.strictEqual(recentMatches.length, 1);
    }
    if (name === '订单定金') {
      [legacy, modern].forEach((savedState) => {
        assert.strictEqual(savedState.aiParseLogs.length, 1);
        assert.strictEqual(savedState.aiParseLogs[0].action, 'save_order_deposit');
      });
      assert.strictEqual(
        prepared.savePlan.operations.filter((operation) => operation.entityType === 'AI_PARSE_LOG').length,
        1
      );
    }
    if (name === '报价') assert.strictEqual(modern.quotations[0].originalText, raw.original_text);
    if (name === '部分收款') assert.strictEqual(modern.paymentRecords[0].originalText, raw.original_text);
    if (name === '未关联普通收款') {
      assert.strictEqual(modern.paymentRecords[0].kind, 'unlinked_payment');
      assert.strictEqual(modern.paymentRecords[0].receivableId, '');
    }
  });
});

test('多商品、originalText及产品目录副作用完整保留', () => {
  const raw = orderResult({
    amount: '1600', totalAmount: '1600',
    items: [
      { productName: '礼品盒', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' },
      { productName: '水杯', quantity: '200', unit: '个', unitPrice: '3', priceUnit: '个', totalAmount: '600' }
    ]
  }, '严格原文：王总礼品盒100个每个10元，水杯200个每个3元，8月1日交');
  const initial = stateWith();
  const prepared = prepare(raw, initial);
  const saved = newSave(initial, prepared).state;
  assert.strictEqual(saved.orders[0].items.length, 2);
  assert.strictEqual(saved.orders[0].items[1].productName, '水杯');
  assert.strictEqual(saved.orders[0].originalText, raw.original_text);
  assert.strictEqual(saved.productCatalog.length, 2);
  assert.strictEqual(prepared.savePlan.originalText, raw.original_text);
});

test('普通业务文本中的temp前缀不会被当成基础设施临时ID', () => {
  const originalText = 'temp:customer:1';
  const raw = result('unknown', 'pending', {}, originalText, { formal_save_blocked: true });
  const initial = stateWith();
  const prepared = prepare(raw, initial, SAVE_ACTIONS.SAVE_PENDING);
  const store = createRecordMemoryStore(initial);
  const receipt = commit(prepared.savePlan, store);
  assert.strictEqual(receipt.status, COMMIT_STATUSES.COMMITTED, JSON.stringify(receipt.errors));
  assert.strictEqual(store.getState().pendingNotes[0].originalText, originalText);
});

test('部分收款、结清与定金同步金额及双向关联', () => {
  const wang = customer('cus-wang', '王总');
  const ord = order('ord-1', 'cus-wang');
  const rec = receivable('rec-1', 'cus-wang', { orderId: 'ord-1' });
  const cases = [
    ['partial', '300', '500', '部分收款', 'partial_payment'],
    ['settled', '800', '1000', '已结清', 'final_payment'],
    ['deposit', '300', '500', '部分收款', 'deposit']
  ];
  cases.forEach(([name, amount, expectedPaid, expectedStatus, expectedKind]) => {
    const initial = stateWith({ customers: [wang], orders: [ord], receivables: [rec] });
    const raw = name === 'deposit'
      ? result('payment', 'record_order_deposit', {
        customerName: '王总', customerId: 'cus-wang', orderId: 'ord-1', orderSelectionConfirmed: true,
        productName: '礼品盒', paymentAmount: amount, depositAmount: amount, paymentKind: 'deposit'
      }, `王总定金${amount}`)
      : result('payment', 'record_payment', {
        customerName: '王总', customerId: 'cus-wang', receivableId: 'rec-1', receivableSelectionConfirmed: true,
        paymentAmount: amount
      }, `王总收款${amount}`);
    const prepared = prepare(raw, initial);
    const saved = newSave(initial, prepared).state;
    assert.strictEqual(saved.receivables[0].paidAmount, expectedPaid, name);
    assert.strictEqual(saved.receivables[0].status, expectedStatus, name);
    assert.strictEqual(saved.paymentRecords[0].receivableId, 'rec-1', name);
    assert.strictEqual(saved.paymentRecords[0].orderId, 'ord-1', name);
    assert.strictEqual(saved.paymentRecords[0].kind, expectedKind, name);
  });
});

test('收款SavePlan按绑定余额分类，并发、精确重放和失败回滚均保持单次原子提交', () => {
  const wang = customer('cus-wang', '王总');
  const ord = order('ord-1', 'cus-wang');
  const rec = receivable('rec-1', 'cus-wang', { orderId: 'ord-1' });
  const initial = stateWith({ customers: [wang], orders: [ord], receivables: [rec] });
  const raw = result('payment', 'record_payment', {
    customerName: '王总', customerId: 'cus-wang', receivableId: 'rec-1',
    receivableSelectionConfirmed: true, paymentAmount: '300'
  }, '王总收款300元');
  const firstPrepared = prepare(raw, initial, SAVE_ACTIONS.SAVE_FORMAL, {
    confirmationId: 'payment-confirmation-a',
    planIdGenerator: scopedIdGenerator('payment-plan-a')
  });
  const secondPrepared = prepare(raw, initial, SAVE_ACTIONS.SAVE_FORMAL, {
    confirmationId: 'payment-confirmation-b',
    planIdGenerator: scopedIdGenerator('payment-plan-b')
  });
  const operationTypes = firstPrepared.savePlan.operations.map((operation) => operation.entityType);
  ['RECEIVABLE', 'PAYMENT', 'AI_PARSE_LOG'].forEach((entityType) => {
    assert(operationTypes.includes(entityType), `payment plan missing ${entityType}`);
  });

  const store = createRecordMemoryStore(initial);
  const first = commit(firstPrepared.savePlan, store);
  assert.strictEqual(first.status, COMMIT_STATUSES.COMMITTED);
  assert.strictEqual(store.getState().paymentRecords.length, 1);
  assert.strictEqual(store.getState().paymentRecords[0].kind, 'partial_payment');
  assert.strictEqual(store.getState().receivables[0].paidAmount, '500');
  assert.strictEqual(store.getState().receivables[0].status, '部分收款');
  assert.strictEqual(store.getState().aiParseLogs.length, 1);
  assert.strictEqual(store.getState().operationLogs.length, 0);
  assert.strictEqual(store.getVersion(), 2);

  const replay = commit(firstPrepared.savePlan, store);
  assert.strictEqual(replay.status, COMMIT_STATUSES.ALREADY_COMMITTED);
  assert.strictEqual(replay.idempotentReplay, true);
  assert.strictEqual(store.getState().paymentRecords.length, 1);
  assert.strictEqual(store.getState().receivables[0].paidAmount, '500');
  assert.strictEqual(store.getVersion(), 2);

  const stale = commit(secondPrepared.savePlan, store);
  assert.strictEqual(stale.status, COMMIT_STATUSES.STALE_PLAN);
  assert.strictEqual(store.getState().paymentRecords.length, 1);
  assert.strictEqual(store.getState().receivables[0].paidAmount, '500');
  assert.strictEqual(store.getVersion(), 2);

  const failurePoints = firstPrepared.savePlan.operations
    .map((operation, operationIndex) => ({ entityType: operation.entityType, operationIndex }))
    .filter((item) => ['RECEIVABLE', 'PAYMENT', 'AI_PARSE_LOG'].includes(item.entityType))
    .map((item) => ({ phase: 'AFTER_APPLY', operationIndex: item.operationIndex }))
    .concat([{ phase: 'BEFORE_ATOMIC_SWAP' }]);
  failurePoints.forEach((failureInjection) => {
    const rollbackStore = createRecordMemoryStore(initial, { failureInjection });
    const before = rollbackStore.getState();
    const fingerprint = rollbackStore.getFingerprint();
    const receipt = commit(firstPrepared.savePlan, rollbackStore);
    assert.strictEqual(receipt.status, COMMIT_STATUSES.ROLLED_BACK, JSON.stringify(failureInjection));
    assert.deepStrictEqual(rollbackStore.getState(), before);
    assert.strictEqual(rollbackStore.getFingerprint(), fingerprint);
    assert.strictEqual(rollbackStore.getVersion(), 1);
    assert.strictEqual(rollbackStore.getCommitReceipt(firstPrepared.savePlan.planId), null);
  });

  const over = prepare(result('payment', 'record_payment', {
    customerName: '王总', customerId: 'cus-wang', receivableId: 'rec-1',
    receivableSelectionConfirmed: true, paymentAmount: '800.01'
  }, '王总收款800.01元'), initial);
  assert.strictEqual(over.savePlan.blocked, true);
  assert.strictEqual(over.savePlan.operations.length, 0);
});

test('无关历史脏记录不阻断新业务，但新增跨客户金融关系会被拒绝', () => {
  const dirtyInitial = stateWith({
    receivables: [receivable('legacy-dirty', 'missing-customer')]
  });
  const prepared = prepare(orderResult(), dirtyInitial);
  const dirtyStore = createRecordMemoryStore(dirtyInitial);
  const dirtyReceipt = commit(prepared.savePlan, dirtyStore);
  assert.strictEqual(dirtyReceipt.status, COMMIT_STATUSES.COMMITTED, JSON.stringify(dirtyReceipt.errors));
  assert.strictEqual(dirtyStore.getState().orders.length, 1);

  const before = stateWith({
    customers: [customer('c1', '王总'), customer('c2', '李总')],
    orders: [order('o1', 'c1')],
    receivables: [receivable('r1', 'c1', { orderId: 'o1' })]
  });
  const after = clone(before);
  after.paymentRecords.push({
    id: 'p-cross', customerId: 'c2', orderId: 'o1', receivableId: 'r1',
    amount: '100', kind: 'final_payment', originalText: '错误跨客户收款'
  });
  assert.throws(
    () => validateInvariants({ originalText: '错误跨客户收款' }, before, after, []),
    (error) => error && error.code === 'SAVE_PLAN_INVARIANT_FAILED'
  );

  const missingCustomer = clone(before);
  missingCustomer.receivables[0].paidAmount = '300';
  missingCustomer.paymentRecords.push({
    id: 'p-no-customer', customerId: '', orderId: 'o1', receivableId: 'r1',
    amount: '100', kind: 'final_payment', originalText: '缺客户收款'
  });
  assert.throws(
    () => validateInvariants({ originalText: '缺客户收款' }, before, missingCustomer, []),
    (error) => error && error.code === 'SAVE_PLAN_INVARIANT_FAILED'
  );

  const missingOrderLink = clone(before);
  missingOrderLink.receivables[0].paidAmount = '300';
  missingOrderLink.paymentRecords.push({
    id: 'p-no-order', customerId: 'c1', orderId: '', receivableId: 'r1',
    amount: '100', kind: 'final_payment', originalText: '缺订单关系收款'
  });
  assert.throws(
    () => validateInvariants({ originalText: '缺订单关系收款' }, before, missingOrderLink, []),
    (error) => error && error.code === 'SAVE_PLAN_INVARIANT_FAILED'
  );

  const wrongStatus = clone(before);
  wrongStatus.receivables[0].status = '已结清';
  assert.throws(
    () => validateInvariants({ originalText: '错误结清' }, before, wrongStatus, []),
    (error) => error && error.code === 'SAVE_PLAN_INVARIANT_FAILED'
  );

  const withExistingPayment = clone(before);
  withExistingPayment.paymentRecords.push({
    id: 'p-existing', customerId: 'c1', orderId: 'o1', receivableId: 'r1',
    amount: '200', kind: 'final_payment', originalText: '历史收款'
  });
  const mutatedPayment = clone(withExistingPayment);
  mutatedPayment.paymentRecords[0].amount = '900';
  assert.throws(
    () => validateInvariants({ originalText: '篡改收款' }, withExistingPayment, mutatedPayment, []),
    (error) => error && error.code === 'SAVE_PLAN_INVARIANT_FAILED'
  );
});

test('报价页转单和订单页生成待收保持旧生命周期边界，未伪装成记一笔SavePlan等价', () => {
  const wang = customer('cus-wang', '王总');
  const quoteState = stateWith({ customers: [wang], quotations: [quotation('quo-direct', 'cus-wang')] });
  const directOrder = withFixedGlobals(() => convertQuotationToOrder(quoteState, 'quo-direct', {
    requiredDeliveryDate: '2026-08-01'
  }));
  assert(directOrder);
  assert.strictEqual(directOrder.remark, '由报价 quo-direct 转入');
  assert.strictEqual(quoteState.quotations[0].convertedOrderId, directOrder.id);
  assert.strictEqual(quoteState.aiParseLogs.length, 0);

  quoteState.paymentRecords.unshift({
    id: 'deposit-direct', customerId: 'cus-wang', orderId: directOrder.id, receivableId: '',
    amount: '200', kind: 'deposit', originalText: '历史定金'
  });
  const generated = withFixedGlobals(() => generateReceivableFromOrder(quoteState, directOrder.id));
  assert(generated);
  assert.strictEqual(generated.paidAmount, '200');
  assert.strictEqual(quoteState.paymentRecords[0].receivableId, generated.id);
});

test('runRecordFlow默认不准备计划，显式请求只返回计划且不自动commit', async () => {
  let count = 0;
  const dependencies = { clock: fixedClock(), idGenerator: { next(scope) { count += 1; return `flow-${scope}-${count}`; } }, aiAdapter: createNoAiAdapter() };
  const input = {
    mode: 'PRODUCTION_ROUTING', originalText: '王总订礼品盒100个，每个10元，8月1日交', inputSource: 'test',
    context: 'record', businessDate: BUSINESS_DATE, businessTimezone: 'Asia/Shanghai', initialState: stateWith()
  };
  const normal = await runRecordFlow(input, dependencies);
  assert.strictEqual(normal.savePlan, null);
  const planned = await runRecordFlow(Object.assign({}, input, {
    prepareSavePlan: true, saveAction: 'SAVE_FORMAL'
  }), dependencies);
  assert(planned.savePlan);
  assert.strictEqual(planned.savePlan.blocked, false);
  assert(planned.savePlan.operations.length > 0);
  assert.strictEqual(input.initialState.orders.length, 0);
});

test('计划内容或授权被篡改时不会写入', () => {
  const initial = stateWith();
  const plan = prepare(orderResult(), initial).savePlan;
  const tampered = clone(plan);
  tampered.operations[0].payload.name = '篡改客户';
  const store = createRecordMemoryStore(initial);
  const invalidHash = commit(tampered, store);
  assert.strictEqual(invalidHash.status, COMMIT_STATUSES.FAILED);
  assert.strictEqual(store.getVersion(), 1);
  const badAuth = commit(plan, store, { authorization: authorization(plan, { confirmationRevision: 999 }) });
  assert.strictEqual(badAuth.status, COMMIT_STATUSES.FAILED);
  assert.strictEqual(store.getVersion(), 1);

  const rehashed = clone(plan);
  rehashed.warnings.push({ code: 'TAMPERED_AUDIT_WARNING' });
  rehashed.planHash = computePlanHash(rehashed);
  rehashed.idempotencyKey = `record-save:${rehashed.planHash}`;
  const oldAuthorization = authorization(plan);
  const rehashedReceipt = commit(rehashed, store, { authorization: oldAuthorization });
  assert.strictEqual(rehashedReceipt.status, COMMIT_STATUSES.FAILED);
  assert(rehashedReceipt.errors.some((item) => item.code === 'SAVE_PLAN_AUTHORIZATION_INVALID'));
  assert.strictEqual(store.getVersion(), 1);

  const committedStore = createRecordMemoryStore(initial);
  assert.strictEqual(commit(plan, committedStore).status, COMMIT_STATUSES.COMMITTED);
  const unauthorizedReplay = commitRecordSavePlan(plan, committedStore, {
    target: 'MEMORY', clock: fixedClock(), idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(unauthorizedReplay.status, COMMIT_STATUSES.FAILED);
  assert(unauthorizedReplay.errors.some((item) => item.code === 'SAVE_PLAN_AUTHORIZATION_INVALID'));
});

test('非法plan枚举、目标ID、依赖投影和非MemoryStore均fail closed', () => {
  const initial = stateWith();
  const base = prepare(orderResult(), initial).savePlan;
  const mutations = [
    (plan) => { plan.mode = 'SECRET_TEST_MODE'; },
    (plan) => { plan.resultScope = 'AI_ONLY_RESULT'; },
    (plan) => { plan.action = 'AUTO_SAVE'; },
    (plan) => { plan.commitTargetPolicy = 'WRITE_ANYWHERE'; },
    (plan) => { plan.commitTargetPolicy = 'MEMORY_ONLY'; },
    (plan) => { plan.preconditions[0].expected = 999; },
    (plan) => {
      const operation = plan.operations.find((item) => item.action === 'CREATE');
      operation.targetId = 'unexpected-target';
    },
    (plan) => { plan.dependencies = []; }
  ];
  mutations.forEach((mutate, index) => {
    const plan = clone(base);
    mutate(plan);
    plan.planHash = computePlanHash(plan);
    plan.idempotencyKey = `record-save:${plan.planHash}`;
    const receipt = commit(plan, createRecordMemoryStore(initial), { authorization: authorization(plan) });
    assert.strictEqual(receipt.status, COMMIT_STATUSES.FAILED, `invalid plan ${index}`);
  });

  const fakeStore = {
    getState: () => normalizeDomainState(initial),
    beginTransaction() {},
    getVersion: () => 1,
    getFingerprint: () => getStateFingerprint(initial)
  };
  const receipt = commitRecordSavePlan(base, fakeStore, {
    target: 'MEMORY', authorization: authorization(base), clock: fixedClock(), idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(receipt.status, COMMIT_STATUSES.FAILED);
  assert(receipt.errors.some((item) => item.code === 'SAVE_PLAN_AUTHORIZATION_INVALID'));
});

test('报价已转单、订单状态变化和待收已结清使各自旧计划失效', () => {
  const wang = customer('cus-wang', '王总');
  const statesAndResults = [
    [stateWith({ customers: [wang], quotations: [quotation('quo-1', 'cus-wang')] }), orderResult({ customerId: 'cus-wang', quotationId: 'quo-1' })],
    [stateWith({ customers: [wang], orders: [order('ord-1', 'cus-wang')] }), result('payment', 'record_order_deposit', {
      customerName: '王总', customerId: 'cus-wang', orderId: 'ord-1', orderSelectionConfirmed: true,
      paymentAmount: '100', depositAmount: '100', paymentKind: 'deposit'
    }, '王总定金100元')],
    [stateWith({ customers: [wang], receivables: [receivable('rec-1', 'cus-wang')] }), result('payment', 'record_payment', {
      customerName: '王总', customerId: 'cus-wang', receivableId: 'rec-1', receivableSelectionConfirmed: true, paymentAmount: '100'
    }, '王总收款100元')]
  ];
  statesAndResults.forEach(([initial, raw], index) => {
    const plan = prepare(raw, initial).savePlan;
    assert.strictEqual(plan.blocked, false, JSON.stringify(plan.blockingIssues));
    const changed = clone(initial);
    if (index === 0) {
      changed.quotations[0].status = '已转订单';
      changed.quotations[0].convertedOrderId = 'external-order';
    } else if (index === 1) {
      changed.orders[0].status = '已取消';
    } else {
      changed.receivables[0].status = '已结清';
      changed.receivables[0].paidAmount = changed.receivables[0].amount;
    }
    const receipt = commit(plan, createRecordMemoryStore(changed));
    assert.strictEqual(receipt.status, COMMIT_STATUSES.STALE_PLAN);
  });
});

async function main() {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`PASS ${item.name}`);
    } catch (error) {
      console.error(`FAIL ${item.name}`);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`Phase 1E.1: ${passed}/${tests.length} passed`);
}

async function runLegacyEquivalenceWithVisitor(visitor) {
  const selected = tests.find((item) => item.name === '代表业务与现有business隔离保存结果等价');
  if (!selected) throw new Error('Phase 1E.1等价题未注册。');
  const previous = legacyEquivalenceVisitor;
  legacyEquivalenceVisitor = visitor;
  try {
    await selected.fn();
  } finally {
    legacyEquivalenceVisitor = previous;
  }
}

if (require.main === module) main();

module.exports = {
  authorization,
  canonicalState,
  clone,
  customer,
  fixedClock,
  order,
  orderResult,
  prepare,
  quotation,
  receivable,
  result,
  runLegacyEquivalenceWithVisitor,
  scopedIdGenerator,
  stateWith,
  withFixedGlobals
};
