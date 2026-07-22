const {
  COLLECTION_BY_ENTITY,
  COMMIT_RECEIPT_SCHEMA_VERSION,
  COMMIT_STATUSES,
  COMMIT_TARGET_POLICIES,
  ENTITY_TYPES,
  OPERATION_ACTIONS,
  SAVE_ACTIONS,
  SAVE_PLAN_ERROR_CODES,
  SAVE_PLAN_SCHEMA_VERSION,
  isTemporaryRecordId,
  isTemporaryReferencePath
} = require('./record-save-plan-contract');
const {
  computePlanHash
} = require('./record-save-plan-builder');
const {
  createEmptyStateDiff,
  createStateDiff,
  safeClone,
  stableHash,
  stableSerialize
} = require('./record-state-diff');
const { isRecordMemoryStore } = require('./record-memory-store');

function commitError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = safeClone(details);
  return error;
}

function normalizeError(error, stage) {
  return {
    code: String(error && error.code || SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_FAILED),
    message: String(error && error.message || 'SavePlan提交失败。'),
    stage,
    details: safeClone(error && error.details || {})
  };
}

function readClock(clock) {
  let value;
  if (typeof clock === 'function') value = clock();
  else if (clock && typeof clock.now === 'function') value = clock.now();
  else value = new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw commitError('CLOCK_INVALID_RESULT', 'clock没有返回有效时间。');
  return date.toISOString();
}

function nextBusinessId(idGenerator, scope) {
  let value;
  if (typeof idGenerator === 'function') value = idGenerator(scope);
  else if (idGenerator && typeof idGenerator.next === 'function') value = idGenerator.next(scope);
  else value = `memory-${scope}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.startsWith('temp:')) {
    throw commitError(SAVE_PLAN_ERROR_CODES.BUSINESS_ID_INVALID, `业务ID生成失败：${scope}`);
  }
  return normalized;
}

function containsInvalidValue(value, seen = new Set()) {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return true;
  if (typeof value === 'number' && !Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const invalid = Object.keys(value).some((key) => (
    ['__proto__', 'constructor', 'prototype'].includes(key)
    || containsInvalidValue(value[key], seen)
  ));
  seen.delete(value);
  return invalid;
}

function collectTempReferences(value, path = '', result = []) {
  if (typeof value === 'string' && isTemporaryRecordId(value) && isTemporaryReferencePath(path)) {
    result.push({ path, value });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTempReferences(item, `${path}[${index}]`, result));
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => collectTempReferences(value[key], path ? `${path}.${key}` : key, result));
  }
  return result;
}

function resolveValue(value, resolvedIds, path = '') {
  if (typeof value === 'string' && isTemporaryRecordId(value) && isTemporaryReferencePath(path)) {
    if (!resolvedIds[value]) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_TEMP_REFERENCE_INVALID, `临时引用未解析：${value}`);
    }
    return resolvedIds[value];
  }
  if (Array.isArray(value)) return value.map((item, index) => resolveValue(item, resolvedIds, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      result[key] = resolveValue(value[key], resolvedIds, path ? `${path}.${key}` : key);
      return result;
    }, {});
  }
  return value;
}

function normalizeResolvedDiffOrder(diff) {
  return Object.keys(diff || {}).reduce((output, collection) => {
    const entry = safeClone(diff[collection] || {});
    ['created', 'updated', 'deleted'].forEach((field) => {
      entry[field] = (entry[field] || []).slice().sort((left, right) => {
        const leftId = String((left && left.id) || '');
        const rightId = String((right && right.id) || '');
        return leftId.localeCompare(rightId);
      });
    });
    output[collection] = entry;
    return output;
  }, {});
}

const OPERATION_PRECONDITIONS = new Set(['TARGET_ABSENT', 'TARGET_FINGERPRINT']);

function validateOperationShape(operation) {
  if (!operation || typeof operation !== 'object' || !operation.operationId) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'SavePlan操作缺少operationId。');
  }
  if (!ENTITY_TYPES[operation.entityType] || !OPERATION_ACTIONS[operation.action]) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'SavePlan操作类型或action无效。', {
      operationId: operation.operationId
    });
  }
  if (!/^(CREATE|UPDATE|UPSERT|APPEND|LINK|DELETE)_[A-Z_]+$/.test(String(operation.type || ''))
    || !String(operation.type).endsWith(`_${operation.entityType}`)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'SavePlan operation.type无效。', {
      operationId: operation.operationId, type: operation.type
    });
  }
  const expectedCollection = COLLECTION_BY_ENTITY[operation.entityType];
  if (!expectedCollection || operation.collection !== expectedCollection) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'SavePlan实体与集合不一致。', {
      operationId: operation.operationId,
      expectedCollection,
      actualCollection: operation.collection
    });
  }
  if (!Array.isArray(operation.preconditions) || !Array.isArray(operation.dependsOn)
    || !Array.isArray(operation.relationUpdates)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'SavePlan操作合同字段不完整。');
  }
  operation.preconditions.forEach((precondition) => {
    if (!precondition || !OPERATION_PRECONDITIONS.has(precondition.type)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'SavePlan包含未知操作前置条件。', {
        operationId: operation.operationId,
        preconditionType: precondition && precondition.type
      });
    }
  });
  if (['CREATE', 'APPEND'].includes(operation.action)) {
    if (!operation.payload || !isTemporaryRecordId(operation.temporaryId)
      || String(operation.payload.id || '') !== String(operation.temporaryId)
      || operation.targetId) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, '新建操作缺少一致的临时ID。');
    }
  } else if (operation.temporaryId) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, '非新建操作不得声明临时ID。');
  }
  if (['UPDATE', 'UPSERT', 'LINK', 'DELETE'].includes(operation.action) && !operation.targetId) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, '目标操作缺少targetId。');
  }
  if (['UPDATE', 'UPSERT', 'LINK'].includes(operation.action)
    && String(operation.payload && operation.payload.id || '') !== String(operation.targetId || '')) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, '目标操作的payload.id与targetId不一致。');
  }
  if (operation.action !== 'DELETE' && (!operation.payload || typeof operation.payload !== 'object')) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, '非删除操作缺少payload。');
  }
}

function validateOperationGraph(operations) {
  const producerByTemp = new Map();
  operations.forEach((operation) => {
    validateOperationShape(operation);
    if (operation.temporaryId) {
      if (producerByTemp.has(operation.temporaryId)) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_TEMP_REFERENCE_INVALID, '临时ID存在多个生产操作。');
      }
      producerByTemp.set(operation.temporaryId, operation.operationId);
    }
  });
  operations.forEach((operation) => {
    const payloadRefs = collectTempReferences(operation.payload, 'payload')
      .filter((reference) => reference.value !== operation.temporaryId);
    const declared = (operation.relationUpdates || []).map((item) => ({
      path: String(item && item.path || ''),
      value: String(item && item.value || '')
    })).sort((left, right) => `${left.path}:${left.value}`.localeCompare(`${right.path}:${right.value}`));
    const actual = payloadRefs.map((item) => ({ path: item.path.replace(/^payload\.?/, ''), value: item.value }))
      .sort((left, right) => `${left.path}:${left.value}`.localeCompare(`${right.path}:${right.value}`));
    if (stableSerialize(declared) !== stableSerialize(actual)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_TEMP_REFERENCE_INVALID, 'relationUpdates与payload临时关系不一致。', {
        operationId: operation.operationId
      });
    }
    actual.forEach((reference) => {
      const producer = producerByTemp.get(reference.value);
      if (!producer) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_TEMP_REFERENCE_INVALID, `临时引用没有生产操作：${reference.value}`);
      }
      if (!(operation.dependsOn || []).includes(producer)) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_DEPENDENCY_INVALID, `临时引用缺少依赖：${reference.value}`);
      }
    });
  });
}

function validatePlanShape(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan必须是对象。');
  }
  if (plan.schemaVersion !== SAVE_PLAN_SCHEMA_VERSION || !plan.planId || !plan.planHash
    || !plan.idempotencyKey || !Array.isArray(plan.operations)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan合同字段不完整。');
  }
  const validModes = new Set(['PRODUCTION_ROUTING', 'LOCAL_ONLY', 'AI_ONLY']);
  const validScopes = new Set(['PRODUCTION_RESULT', 'LOCAL_ONLY_RESULT', 'AI_ONLY_RESULT']);
  const scopeByMode = {
    PRODUCTION_ROUTING: 'PRODUCTION_RESULT',
    LOCAL_ONLY: 'LOCAL_ONLY_RESULT',
    AI_ONLY: 'AI_ONLY_RESULT'
  };
  if (!SAVE_ACTIONS[plan.action] || !validModes.has(plan.mode) || !validScopes.has(plan.resultScope)
    || !COMMIT_TARGET_POLICIES[plan.commitTargetPolicy]) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan action、mode、resultScope或提交策略无效。');
  }
  if (scopeByMode[plan.mode] !== plan.resultScope) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan mode与resultScope不匹配。');
  }
  if (!plan.confirmationId || !Number.isInteger(plan.confirmationRevision) || plan.confirmationRevision < 1
    || !plan.confirmationContentHash || !plan.preflightFingerprint
    || !Number.isInteger(plan.sourceStateVersion) || plan.sourceStateVersion < 0
    || !plan.sourceStateFingerprint || !plan.expectedBusinessDiff || !plan.expectedFullDiff
    || !Array.isArray(plan.dependencies) || !Array.isArray(plan.preconditions)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan缺少确认、预检、state或diff绑定。');
  }
  if (containsInvalidValue(plan)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan包含不可序列化或非法数值。');
  }
  if (computePlanHash(plan) !== plan.planHash) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_HASH_MISMATCH, 'SavePlan内容与planHash不一致。');
  }
  if (plan.idempotencyKey !== `record-save:${plan.planHash}`) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_HASH_MISMATCH, 'idempotencyKey与planHash不一致。');
  }
  if (plan.blocked && plan.operations.length) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, '被阻断计划不得包含写操作。');
  }
  if (plan.blocked !== (plan.commitTargetPolicy === COMMIT_TARGET_POLICIES.BLOCKED)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan阻断状态与提交策略不一致。');
  }
  if (!plan.blocked && plan.mode !== 'PRODUCTION_ROUTING') {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, '非生产mode不得生成可提交计划。');
  }
  if (!plan.blocked && plan.commitTargetPolicy !== COMMIT_TARGET_POLICIES.REAL_OR_MEMORY) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, '可提交生产计划必须使用REAL_OR_MEMORY策略。');
  }
  if (!plan.blocked && plan.action === SAVE_ACTIONS.SAVE_FORMAL && !plan.operations.length) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, '正式计划不得为空。');
  }
  if (plan.action === SAVE_ACTIONS.SAVE_PENDING
    && plan.operations.some((operation) => operation.entityType !== 'PENDING_NOTE'
      || operation.action !== 'CREATE')) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, '待整理计划只能创建待整理记录。');
  }
  const allowedCollections = new Set(Object.values(COLLECTION_BY_ENTITY));
  Object.keys(plan.collectionOrders || {}).forEach((collection) => {
    if (!allowedCollections.has(collection) || !Array.isArray(plan.collectionOrders[collection])) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, `无效的集合顺序：${collection}`);
    }
  });
  (plan.preconditions || []).forEach((precondition) => {
    if (!precondition || !['STATE_VERSION', 'STATE_FINGERPRINT'].includes(precondition.type)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan包含未知全局前置条件。');
    }
  });
  const expectedStatePreconditions = [{ type: 'STATE_FINGERPRINT', expected: plan.sourceStateFingerprint }, {
    type: 'STATE_VERSION', expected: plan.sourceStateVersion
  }];
  const declaredStatePreconditions = plan.preconditions.map((precondition) => ({
    type: precondition.type,
    expected: precondition.expected
  })).sort((left, right) => left.type.localeCompare(right.type));
  if (stableSerialize(declaredStatePreconditions) !== stableSerialize(expectedStatePreconditions)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'SavePlan state前置条件与source state绑定不一致。');
  }
  validateOperationGraph(plan.operations);
  const projectedDependencies = plan.operations.flatMap((operation) => (operation.dependsOn || []).map((dependsOn) => ({
    operationId: operation.operationId,
    dependsOn
  }))).sort((left, right) => `${left.operationId}:${left.dependsOn}`.localeCompare(`${right.operationId}:${right.dependsOn}`));
  const declaredDependencies = plan.dependencies.map((item) => ({
    operationId: String(item && item.operationId || ''),
    dependsOn: String(item && item.dependsOn || '')
  })).sort((left, right) => `${left.operationId}:${left.dependsOn}`.localeCompare(`${right.operationId}:${right.dependsOn}`));
  if (stableSerialize(projectedDependencies) !== stableSerialize(declaredDependencies)) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_DEPENDENCY_INVALID, 'plan dependencies与operation依赖不一致。');
  }
}

function validateAuthorization(plan, authorization) {
  if (!authorization || typeof authorization !== 'object' || authorization.userInitiated !== true) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_AUTHORIZATION_INVALID, '缺少明确的用户保存授权。');
  }
  const expected = {
    planId: plan.planId,
    planHash: plan.planHash,
    idempotencyKey: plan.idempotencyKey,
    action: plan.action,
    confirmationId: plan.confirmationId,
    confirmationRevision: plan.confirmationRevision,
    confirmationContentHash: plan.confirmationContentHash,
    preflightFingerprint: plan.preflightFingerprint
  };
  const mismatch = Object.keys(expected).find((key) => String(authorization[key]) !== String(expected[key]));
  if (mismatch) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_AUTHORIZATION_INVALID, `保存授权与计划的${mismatch}不一致。`);
  }
}

function buildDependencyOrder(operations) {
  const byId = new Map();
  const originalIndex = new Map();
  operations.forEach((operation, index) => {
    if (!operation || !operation.operationId || byId.has(operation.operationId)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_DEPENDENCY_INVALID, 'SavePlan存在空或重复operationId。');
    }
    byId.set(operation.operationId, operation);
    originalIndex.set(operation.operationId, index);
  });
  const indegree = new Map();
  const next = new Map();
  operations.forEach((operation) => {
    const dependencies = Array.from(new Set(operation.dependsOn || []));
    dependencies.forEach((dependency) => {
      if (!byId.has(dependency) || dependency === operation.operationId) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_DEPENDENCY_INVALID, `无效依赖：${dependency}`);
      }
      if (!next.has(dependency)) next.set(dependency, []);
      next.get(dependency).push(operation.operationId);
    });
    indegree.set(operation.operationId, dependencies.length);
  });
  const queue = operations.filter((operation) => indegree.get(operation.operationId) === 0)
    .sort((left, right) => originalIndex.get(left.operationId) - originalIndex.get(right.operationId));
  const ordered = [];
  while (queue.length) {
    const operation = queue.shift();
    ordered.push(operation);
    (next.get(operation.operationId) || []).forEach((operationId) => {
      indegree.set(operationId, indegree.get(operationId) - 1);
      if (indegree.get(operationId) === 0) {
        queue.push(byId.get(operationId));
        queue.sort((left, right) => originalIndex.get(left.operationId) - originalIndex.get(right.operationId));
      }
    });
  }
  if (ordered.length !== operations.length) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_DEPENDENCY_CYCLE, 'SavePlan操作依赖存在循环。');
  }
  return ordered;
}

function buildResolvedIds(operations, idGenerator, stateBefore) {
  const resolvedIds = {};
  const generated = new Set();
  Object.keys(stateBefore || {}).forEach((collection) => {
    if (!Array.isArray(stateBefore[collection])) return;
    stateBefore[collection].forEach((record) => {
      if (record && record.id) generated.add(String(record.id));
    });
  });
  operations.forEach((operation) => {
    if (!operation.temporaryId) return;
    if (!isTemporaryRecordId(operation.temporaryId) || resolvedIds[operation.temporaryId]) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_TEMP_REFERENCE_INVALID, `无效或重复临时ID：${operation.temporaryId}`);
    }
    const entityScope = String(operation.entityType || 'record').toLowerCase();
    const id = nextBusinessId(idGenerator, entityScope);
    if (generated.has(id)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.BUSINESS_ID_INVALID, `业务ID重复：${entityScope}`);
    }
    generated.add(id);
    resolvedIds[operation.temporaryId] = id;
  });
  const produced = new Set(Object.keys(resolvedIds));
  operations.forEach((operation) => {
    collectTempReferences(operation, 'operation').forEach((reference) => {
      if (!produced.has(reference.value)) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_TEMP_REFERENCE_INVALID, `临时引用没有生产操作：${reference.value}`);
      }
    });
  });
  return resolvedIds;
}

function findRecord(state, collection, id) {
  return (state[collection] || []).find((record) => String(record.id || '') === String(id || '')) || null;
}

function validateOperationPreconditions(operation, state) {
  const collection = operation.collection || COLLECTION_BY_ENTITY[operation.entityType];
  const records = state[collection] || [];
  (operation.preconditions || []).forEach((precondition) => {
    if (precondition.type === 'TARGET_ABSENT') {
      if (records.some((record) => String(record.id || '') === String(precondition.targetId || ''))) {
        throw commitError(SAVE_PLAN_ERROR_CODES.STALE_SAVE_PLAN, `创建目标${precondition.targetId}已经存在。`);
      }
    } else if (precondition.type === 'TARGET_FINGERPRINT') {
      const target = findRecord(state, collection, precondition.targetId);
      if (!target || stableHash(target, 'record1') !== precondition.expectedFingerprint) {
        throw commitError(SAVE_PLAN_ERROR_CODES.STALE_SAVE_PLAN, `目标${precondition.targetId}已经变化。`);
      }
    }
  });
}

function validateNoTemporaryIds(state) {
  const references = collectTempReferences(state, 'state');
  if (references.length) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, '提交结果仍包含临时ID。', {
      references: Array.from(new Set(references.map((item) => item.value))).slice(0, 20)
    });
  }
}

function addViolation(violations, code, details = {}) {
  const stableDetails = safeClone(details);
  violations.set(`${code}:${stableHash(stableDetails, 'invariant1')}`, { code, details: stableDetails });
}

function collectInvariantViolations(state) {
  const violations = new Map();
  collectTempReferences(state, 'state').forEach((reference) => {
    addViolation(violations, 'TEMPORARY_ID_REMAINED', reference);
  });
  Object.keys(state).forEach((collection) => {
    if (!Array.isArray(state[collection])) return;
    const seen = new Set();
    state[collection].forEach((record, index) => {
      const id = String(record && record.id || '');
      if (!id) addViolation(violations, 'RECORD_ID_MISSING', { collection, index });
      else if (seen.has(id)) addViolation(violations, 'RECORD_ID_DUPLICATE', { collection, id });
      seen.add(id);
    });
  });
  const customers = new Set((state.customers || []).map((item) => String(item.id || '')));
  const orders = new Map((state.orders || []).map((item) => [String(item.id || ''), item]));
  const quotations = new Map((state.quotations || []).map((item) => [String(item.id || ''), item]));
  const receivables = new Map((state.receivables || []).map((item) => [String(item.id || ''), item]));
  ['quotations', 'orders', 'receivables', 'paymentRecords'].forEach((collection) => {
    (state[collection] || []).forEach((record) => {
      if (record.customerId && !customers.has(String(record.customerId))) {
        addViolation(violations, 'CUSTOMER_REFERENCE_INVALID', {
          collection, recordId: record.id, customerId: record.customerId
        });
      }
    });
  });
  (state.orders || []).forEach((order) => {
    if (order.quotationId) {
      const quotation = quotations.get(String(order.quotationId));
      if (!quotation || (quotation.customerId && quotation.customerId !== order.customerId)) {
        addViolation(violations, 'ORDER_QUOTATION_RELATION_INVALID', {
          orderId: order.id, quotationId: order.quotationId,
          orderCustomerId: order.customerId, quotationCustomerId: quotation && quotation.customerId
        });
      }
    }
  });
  (state.quotations || []).forEach((quotation) => {
    if (quotation.convertedOrderId) {
      const order = orders.get(String(quotation.convertedOrderId));
      if (!order || String(order.quotationId || '') !== String(quotation.id || '')) {
        addViolation(violations, 'QUOTATION_ORDER_RELATION_INVALID', {
          quotationId: quotation.id, convertedOrderId: quotation.convertedOrderId,
          orderQuotationId: order && order.quotationId
        });
      }
    }
  });
  (state.receivables || []).forEach((receivable) => {
    if (receivable.orderId) {
      const order = orders.get(String(receivable.orderId));
      if (!order || (receivable.customerId && order.customerId !== receivable.customerId)) {
        addViolation(violations, 'RECEIVABLE_ORDER_RELATION_INVALID', {
          receivableId: receivable.id, orderId: receivable.orderId,
          receivableCustomerId: receivable.customerId, orderCustomerId: order && order.customerId
        });
      }
    }
    const paid = Number(receivable.paidAmount || 0);
    const amount = Number(receivable.amount || 0);
    if (!Number.isFinite(paid) || !Number.isFinite(amount) || paid < 0 || amount < 0 || paid > amount + 0.000001) {
      addViolation(violations, 'RECEIVABLE_AMOUNT_INVALID', {
        receivableId: receivable.id, amount: receivable.amount, paidAmount: receivable.paidAmount
      });
    }
  });
  (state.paymentRecords || []).forEach((payment) => {
    const amount = Number(payment.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      addViolation(violations, 'PAYMENT_AMOUNT_INVALID', { paymentId: payment.id, amount: payment.amount });
    }
    const order = payment.orderId ? orders.get(String(payment.orderId)) : null;
    const receivable = payment.receivableId ? receivables.get(String(payment.receivableId)) : null;
    if (!payment.customerId) {
      addViolation(violations, 'PAYMENT_CUSTOMER_REQUIRED', { paymentId: payment.id });
    }
    if (payment.orderId && !order) {
      addViolation(violations, 'PAYMENT_ORDER_REFERENCE_INVALID', { paymentId: payment.id, orderId: payment.orderId });
    }
    if (payment.receivableId && !receivable) {
      addViolation(violations, 'PAYMENT_RECEIVABLE_REFERENCE_INVALID', {
        paymentId: payment.id, receivableId: payment.receivableId
      });
    }
    if (order && payment.customerId && String(order.customerId || '') !== String(payment.customerId)) {
      addViolation(violations, 'PAYMENT_ORDER_CUSTOMER_MISMATCH', {
        paymentId: payment.id, paymentCustomerId: payment.customerId, orderCustomerId: order.customerId
      });
    }
    if (receivable && payment.customerId && String(receivable.customerId || '') !== String(payment.customerId)) {
      addViolation(violations, 'PAYMENT_RECEIVABLE_CUSTOMER_MISMATCH', {
        paymentId: payment.id, paymentCustomerId: payment.customerId, receivableCustomerId: receivable.customerId
      });
    }
    if (receivable && String(receivable.orderId || '') !== String(payment.orderId || '')) {
      addViolation(violations, 'PAYMENT_ORDER_RECEIVABLE_MISMATCH', {
        paymentId: payment.id, paymentOrderId: payment.orderId, receivableOrderId: receivable.orderId
      });
    }
  });
  (state.orderProgress || []).forEach((progress) => {
    if (progress.orderId && !orders.has(String(progress.orderId))) {
      addViolation(violations, 'ORDER_PROGRESS_REFERENCE_INVALID', {
        progressId: progress.id, orderId: progress.orderId
      });
    }
  });
  return violations;
}

function validateNoNewInvariantViolations(stateBefore, stateAfter) {
  const before = collectInvariantViolations(stateBefore);
  const after = collectInvariantViolations(stateAfter);
  const introduced = Array.from(after.keys()).filter((key) => !before.has(key));
  if (introduced.length) {
    throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, 'SavePlan引入了新的业务不变量错误。', {
      violations: introduced.map((key) => after.get(key)).slice(0, 20)
    });
  }
}

function validateFinancialDeltas(stateBefore, stateAfter) {
  const beforePaymentMap = new Map((stateBefore.paymentRecords || []).map((item) => [String(item.id || ''), item]));
  const afterPaymentMap = new Map((stateAfter.paymentRecords || []).map((item) => [String(item.id || ''), item]));
  beforePaymentMap.forEach((before, id) => {
    const after = afterPaymentMap.get(id);
    if (!after || stableSerialize(before) !== stableSerialize(after)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, '记一笔SavePlan不得修改或删除既有收款记录。', {
        paymentId: id, deleted: !after
      });
    }
  });
  const newPayments = (stateAfter.paymentRecords || []).filter((item) => !beforePaymentMap.has(String(item.id || '')));
  const beforeReceivables = new Map((stateBefore.receivables || []).map((item) => [String(item.id || ''), item]));
  (stateAfter.receivables || []).forEach((receivable) => {
    const before = beforeReceivables.get(String(receivable.id || ''));
    const changed = !before || stableSerialize(before) !== stableSerialize(receivable);
    if (changed) {
      const paid = Number(receivable.paidAmount || 0);
      const amount = Number(receivable.amount || 0);
      const expectedStatus = paid <= 0 ? '待收' : (paid >= amount ? '已结清' : '部分收款');
      if (receivable.status !== expectedStatus) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, '待收款状态与金额不一致。', {
          receivableId: receivable.id, amount, paidAmount: paid,
          expectedStatus, actualStatus: receivable.status
        });
      }
    }
    const paidDelta = Number(receivable.paidAmount || 0) - Number(before && before.paidAmount || 0);
    const linkedPayments = newPayments.filter((payment) => String(payment.receivableId || '') === String(receivable.id || ''));
    const paymentSum = linkedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    if (Math.abs(paidDelta - paymentSum) > 0.000001) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, '待收款已收增量与新收款记录不一致。', {
        receivableId: receivable.id, paidDelta, paymentSum
      });
    }
  });
  const orders = new Map((stateAfter.orders || []).map((item) => [String(item.id || ''), item]));
  const depositKinds = new Set(['deposit', 'order_deposit']);
  const touchedOrderIds = new Set(newPayments.filter((payment) => depositKinds.has(payment.kind || payment.paymentKind))
    .map((payment) => String(payment.orderId || '')).filter(Boolean));
  touchedOrderIds.forEach((orderId) => {
    const order = orders.get(orderId);
    const total = Number(order && order.totalAmount || 0);
    const deposited = (stateAfter.paymentRecords || [])
      .filter((payment) => String(payment.orderId || '') === orderId
        && depositKinds.has(payment.kind || payment.paymentKind))
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    if (!order || !Number.isFinite(total) || total < 0 || deposited > total + 0.000001) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, '订单定金累计超过订单总额。', {
        orderId, total, deposited
      });
    }
  });
}

function validateOriginalText(plan, stateBefore, resolvedOperations) {
  const entities = new Set(['QUOTATION', 'ORDER', 'RECEIVABLE', 'PAYMENT', 'TODO', 'PENDING_NOTE', 'AI_PARSE_LOG']);
  resolvedOperations.filter((operation) => entities.has(operation.entityType) && operation.action !== 'DELETE')
    .forEach((operation) => {
      if (['UPDATE', 'UPSERT', 'LINK'].includes(operation.action)) {
        const before = findRecord(stateBefore, operation.collection, operation.targetId);
        if (before && String(before.originalText || '') === String(operation.payload && operation.payload.originalText || '')) {
          return;
        }
      }
      if (String(operation.payload && operation.payload.originalText || '') !== String(plan.originalText || '')) {
        throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVARIANT_FAILED, `${operation.entityType}没有严格保留originalText。`, {
          operationId: operation.operationId
        });
      }
  });
}

function validateInvariants(plan, stateBefore, stateAfter, resolvedOperations = []) {
  validateNoNewInvariantViolations(stateBefore, stateAfter);
  validateFinancialDeltas(stateBefore, stateAfter);
  validateOriginalText(plan, stateBefore, resolvedOperations);
}

function buildBaseReceipt(plan, status, store, details = {}) {
  const state = store.getState();
  return Object.assign({
    schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION,
    planId: plan && plan.planId || '',
    planHash: plan && plan.planHash || '',
    status,
    commitSucceeded: status === COMMIT_STATUSES.COMMITTED || status === COMMIT_STATUSES.ALREADY_COMMITTED,
    committedAt: '',
    idempotentReplay: false,
    resolvedIds: {},
    appliedOperations: [],
    skippedOperations: [],
    failedOperation: null,
    stateVersionBefore: store.getVersion(),
    stateVersionAfter: store.getVersion(),
    businessDiff: createEmptyStateDiff(state).businessDiff,
    fullDiff: createEmptyStateDiff(state).fullDiff,
    errors: [],
    warnings: []
  }, details);
}

function commitRecordSavePlan(plan, store, dependencies = {}) {
  let stage = 'VALIDATE_PLAN';
  try {
    if (!store || typeof store.getState !== 'function' || typeof store.beginTransaction !== 'function') {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_INVALID, 'commit需要兼容合同的store。');
    }
    validatePlanShape(plan);
    if (dependencies.target !== 'MEMORY' || !isRecordMemoryStore(store)) {
      throw commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_AUTHORIZATION_INVALID, 'Phase 1E.1只允许可信MemoryStore提交。');
    }
    validateAuthorization(plan, dependencies.authorization);

    const previousByPlan = store.getCommitReceipt(plan.planId);
    if (previousByPlan) {
      if (previousByPlan.planHash !== plan.planHash) {
        return buildBaseReceipt(plan, COMMIT_STATUSES.BLOCKED, store, {
          errors: [normalizeError(commitError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_ID_COLLISION, 'planId已用于其他计划。'), stage)]
        });
      }
      return buildBaseReceipt(plan, COMMIT_STATUSES.ALREADY_COMMITTED, store, {
        committedAt: previousByPlan.committedAt,
        idempotentReplay: true,
        resolvedIds: safeClone(previousByPlan.resolvedIds || {}),
        skippedOperations: (plan.operations || []).map((operation) => operation.operationId),
        originalCommitResultRef: {
          planId: previousByPlan.planId || plan.planId,
          planHash: previousByPlan.planHash,
          committedAt: previousByPlan.committedAt
        },
        warnings: [{ code: 'SAVE_PLAN_ALREADY_COMMITTED', originalReceiptPlanHash: previousByPlan.planHash }]
      });
    }
    const previousByKey = store.getCommitReceiptByIdempotencyKey(plan.idempotencyKey);
    if (previousByKey && previousByKey.planHash !== plan.planHash) {
      return buildBaseReceipt(plan, COMMIT_STATUSES.BLOCKED, store, {
        errors: [normalizeError(commitError(
          SAVE_PLAN_ERROR_CODES.SAVE_PLAN_IDEMPOTENCY_COLLISION,
          'idempotencyKey已用于其他计划。'
        ), stage)]
      });
    }
    if (previousByKey && previousByKey.planHash === plan.planHash) {
      return buildBaseReceipt(plan, COMMIT_STATUSES.ALREADY_COMMITTED, store, {
        committedAt: previousByKey.committedAt,
        idempotentReplay: true,
        resolvedIds: safeClone(previousByKey.resolvedIds || {}),
        skippedOperations: (plan.operations || []).map((operation) => operation.operationId),
        originalCommitResultRef: {
          planId: previousByKey.planId || '',
          planHash: previousByKey.planHash,
          committedAt: previousByKey.committedAt
        },
        warnings: [{
          code: 'SAVE_PLAN_IDEMPOTENCY_KEY_ALREADY_COMMITTED',
          originalPlanId: previousByKey.planId || ''
        }]
      });
    }
    if (plan.blocked || plan.commitTargetPolicy === COMMIT_TARGET_POLICIES.BLOCKED) {
      return buildBaseReceipt(plan, COMMIT_STATUSES.BLOCKED, store, {
        errors: safeClone(plan.blockingIssues || [])
      });
    }
    stage = 'VALIDATE_STATE';
    if (store.getVersion() !== plan.sourceStateVersion || store.getFingerprint() !== plan.sourceStateFingerprint) {
      return buildBaseReceipt(plan, COMMIT_STATUSES.STALE_PLAN, store, {
        errors: [normalizeError(commitError(SAVE_PLAN_ERROR_CODES.STALE_SAVE_PLAN, '业务state已变化，旧计划失效。'), stage)]
      });
    }

    const orderedOperations = buildDependencyOrder(plan.operations);
    const stateBefore = store.getState();
    const resolvedIds = buildResolvedIds(orderedOperations, dependencies.idGenerator, stateBefore);
    const resolvedOperations = orderedOperations.map((operation, index) => (
      resolveValue(operation, resolvedIds, `operations[${index}]`)
    ));
    const resolvedCollectionOrders = resolveValue(plan.collectionOrders || {}, resolvedIds, 'collectionOrders');
    const resolvedExpectedBusinessDiff = normalizeResolvedDiffOrder(
      resolveValue(plan.expectedBusinessDiff || {}, resolvedIds, 'expectedBusinessDiff')
    );
    const resolvedExpectedFullDiff = normalizeResolvedDiffOrder(
      resolveValue(plan.expectedFullDiff || {}, resolvedIds, 'expectedFullDiff')
    );

    stage = 'BEGIN_TRANSACTION';
    store.beginTransaction(plan);
    try {
      stage = 'APPLY_OPERATIONS';
      resolvedOperations.forEach((operation, index) => {
        const workingState = store.getWorkingState();
        validateOperationPreconditions(operation, workingState);
        store.applyOperation(operation, index);
      });
      Object.keys(resolvedCollectionOrders).sort().forEach((collection) => {
        store.setCollectionOrder(collection, resolvedCollectionOrders[collection]);
      });

      stage = 'VALIDATE_INVARIANTS';
      store.maybeFail('BEFORE_INVARIANTS', null, -1);
      const stateAfter = store.getWorkingState();
      validateInvariants(plan, stateBefore, stateAfter, resolvedOperations);
      const diff = createStateDiff(stateBefore, stateAfter);
      if (stableSerialize(diff.businessDiff) !== stableSerialize(resolvedExpectedBusinessDiff)
        || stableSerialize(diff.fullDiff) !== stableSerialize(resolvedExpectedFullDiff)) {
        throw commitError(
          SAVE_PLAN_ERROR_CODES.SAVE_PLAN_EXPECTED_DIFF_MISMATCH,
          '实际state diff与SavePlan声明不一致。',
          {
            expectedBusinessDiffHash: stableHash(resolvedExpectedBusinessDiff, 'diff1'),
            actualBusinessDiffHash: stableHash(diff.businessDiff, 'diff1'),
            expectedFullDiffHash: stableHash(resolvedExpectedFullDiff, 'diff1'),
            actualFullDiffHash: stableHash(diff.fullDiff, 'diff1')
          }
        );
      }

      stage = 'COMMIT_TRANSACTION';
      const receipt = {
        schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION,
        planId: plan.planId,
        planHash: plan.planHash,
        status: COMMIT_STATUSES.COMMITTED,
        commitSucceeded: true,
        committedAt: readClock(dependencies.clock),
        idempotentReplay: false,
        resolvedIds: safeClone(resolvedIds),
        appliedOperations: resolvedOperations.map((operation) => ({
          operationId: operation.operationId,
          entityType: operation.entityType,
          action: operation.action,
          targetId: operation.targetId || (operation.payload && operation.payload.id) || ''
        })),
        skippedOperations: [],
        failedOperation: null,
        businessDiff: diff.businessDiff,
        fullDiff: diff.fullDiff,
        errors: [],
        warnings: []
      };
      return store.commitTransaction(receipt);
    } catch (error) {
      const failedOperation = error && error.details && error.details.operationId
        ? error.details.operationId
        : null;
      store.rollbackTransaction();
      return buildBaseReceipt(plan, COMMIT_STATUSES.ROLLED_BACK, store, {
        failedOperation,
        errors: [normalizeError(error, stage)]
      });
    }
  } catch (error) {
    if (store && typeof store.hasActiveTransaction === 'function' && store.hasActiveTransaction()) {
      store.rollbackTransaction();
    }
    if (store && typeof store.getState === 'function') {
      return buildBaseReceipt(plan || {}, COMMIT_STATUSES.FAILED, store, {
        errors: [normalizeError(error, stage)]
      });
    }
    return {
      schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION,
      planId: plan && plan.planId || '',
      planHash: plan && plan.planHash || '',
      status: COMMIT_STATUSES.FAILED,
      commitSucceeded: false,
      errors: [normalizeError(error, stage)]
    };
  }
}

module.exports = {
  buildDependencyOrder,
  commitRecordSavePlan,
  normalizeResolvedDiffOrder,
  resolveValue,
  validateInvariants,
  validatePlanShape
};
