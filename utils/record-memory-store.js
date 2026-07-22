const {
  COLLECTION_BY_ENTITY,
  SAVE_PLAN_ERROR_CODES
} = require('./record-save-plan-contract');
const {
  getStateFingerprint,
  normalizeDomainState,
  safeClone,
  stableHash
} = require('./record-state-diff');

const TRUSTED_MEMORY_STORES = new WeakSet();

function createStoreError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = safeClone(details);
  return error;
}

function normalizeFailureInjection(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    phase: String(value.phase || 'BEFORE_APPLY'),
    operationIndex: Number.isInteger(value.operationIndex) ? value.operationIndex : null,
    operationId: String(value.operationId || ''),
    code: String(value.code || 'MEMORY_STORE_INJECTED_FAILURE')
  };
}

function recordId(record) {
  return record && record.id !== undefined && record.id !== null ? String(record.id) : '';
}

function collectionForOperation(operation) {
  const expected = COLLECTION_BY_ENTITY[operation.entityType] || '';
  if (operation.collection !== expected) {
    throw createStoreError(
      SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID,
      '操作实体与集合不一致。',
      { entityType: operation.entityType, collection: operation.collection, expected }
    );
  }
  return expected;
}

class RecordMemoryStore {
  constructor(initialState = {}, options = {}) {
    this._state = normalizeDomainState(initialState);
    this._version = Number.isInteger(options.version) && options.version >= 0 ? options.version : 1;
    this._receiptsByPlanId = new Map();
    this._receiptsByIdempotencyKey = new Map();
    this._transaction = null;
    this._failureInjection = normalizeFailureInjection(options.failureInjection);
    TRUSTED_MEMORY_STORES.add(this);
  }

  getState() {
    return safeClone(this._state);
  }

  getVersion() {
    return this._version;
  }

  getFingerprint() {
    return getStateFingerprint(this._state);
  }

  getCommitReceipt(planId) {
    const receipt = this._receiptsByPlanId.get(String(planId || ''));
    return receipt ? safeClone(receipt) : null;
  }

  getCommitReceiptByIdempotencyKey(idempotencyKey) {
    const receipt = this._receiptsByIdempotencyKey.get(String(idempotencyKey || ''));
    return receipt ? safeClone(receipt) : null;
  }

  setFailureInjection(value) {
    this._failureInjection = normalizeFailureInjection(value);
  }

  clearFailureInjection() {
    this._failureInjection = null;
  }

  hasActiveTransaction() {
    return Boolean(this._transaction);
  }

  beginTransaction(plan) {
    if (this._transaction) {
      throw createStoreError('MEMORY_STORE_TRANSACTION_ACTIVE', 'MemoryStore已有活动事务。');
    }
    this._transaction = {
      planId: String(plan && plan.planId || ''),
      idempotencyKey: String(plan && plan.idempotencyKey || ''),
      stateBefore: safeClone(this._state),
      workingState: safeClone(this._state),
      versionBefore: this._version,
      appliedOperations: []
    };
    return {
      version: this._version,
      fingerprint: getStateFingerprint(this._state)
    };
  }

  _requireTransaction() {
    if (!this._transaction) {
      throw createStoreError('MEMORY_STORE_TRANSACTION_MISSING', 'MemoryStore没有活动事务。');
    }
    return this._transaction;
  }

  maybeFail(phase, operation, operationIndex) {
    const injection = this._failureInjection;
    if (!injection || injection.phase !== phase) return;
    if (injection.operationIndex !== null && injection.operationIndex !== operationIndex) return;
    if (injection.operationId && injection.operationId !== String(operation && operation.operationId || '')) return;
    throw createStoreError(injection.code, `MemoryStore在${phase}注入失败。`, {
      phase,
      operationIndex,
      operationId: operation && operation.operationId
    });
  }

  getWorkingState() {
    const transaction = this._requireTransaction();
    return safeClone(transaction.workingState);
  }

  applyOperation(operation, operationIndex) {
    const transaction = this._requireTransaction();
    const collection = collectionForOperation(operation);
    if (!collection || !Array.isArray(transaction.workingState[collection])) {
      throw createStoreError(
        SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID,
        `SavePlan操作使用了未知集合：${collection || operation.entityType}`,
        { operationId: operation.operationId }
      );
    }

    this.maybeFail('BEFORE_APPLY', operation, operationIndex);
    const records = transaction.workingState[collection];
    const action = String(operation.action || '');
    const payload = safeClone(operation.payload);
    const targetId = String(operation.targetId || (payload && payload.id) || '');
    const index = records.findIndex((record) => recordId(record) === targetId);

    if (action === 'CREATE' || action === 'APPEND') {
      if (!payload || !recordId(payload)) {
        throw createStoreError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, 'CREATE操作缺少记录ID。');
      }
      if (records.some((record) => recordId(record) === recordId(payload))) {
        throw createStoreError('SAVE_PLAN_TARGET_ALREADY_EXISTS', `记录${recordId(payload)}已经存在。`);
      }
      if (action === 'APPEND') records.push(payload);
      else records.push(payload);
    } else if (action === 'UPDATE' || action === 'LINK') {
      if (index < 0) throw createStoreError('SAVE_PLAN_TARGET_NOT_FOUND', `更新目标${targetId}不存在。`);
      records[index] = payload;
    } else if (action === 'UPSERT') {
      if (index < 0) records.push(payload);
      else records[index] = payload;
    } else if (action === 'DELETE') {
      if (index < 0) throw createStoreError('SAVE_PLAN_TARGET_NOT_FOUND', `删除目标${targetId}不存在。`);
      records.splice(index, 1);
    } else {
      throw createStoreError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, `未知操作action：${action}`);
    }

    transaction.appliedOperations.push({
      operationId: operation.operationId,
      entityType: operation.entityType,
      action,
      targetId: targetId || recordId(payload),
      operationHash: stableHash(operation, 'operation1')
    });
    this.maybeFail('AFTER_APPLY', operation, operationIndex);
    return safeClone(transaction.appliedOperations[transaction.appliedOperations.length - 1]);
  }

  setCollectionOrder(collection, orderedIds) {
    const transaction = this._requireTransaction();
    const records = transaction.workingState[collection];
    if (!Array.isArray(records)) {
      throw createStoreError(SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID, `未知集合顺序：${collection}`);
    }
    const byId = new Map(records.map((record) => [recordId(record), record]));
    const normalizedIds = (orderedIds || []).map((idValue) => String(idValue || ''));
    const seen = new Set(normalizedIds);
    if (normalizedIds.length !== records.length || seen.size !== normalizedIds.length
      || normalizedIds.some((id) => !id || !byId.has(id))) {
      throw createStoreError(
        SAVE_PLAN_ERROR_CODES.SAVE_PLAN_OPERATION_INVALID,
        `集合${collection}的目标顺序不是当前记录的精确排列。`
      );
    }
    const ordered = [];
    normalizedIds.forEach((id) => {
      ordered.push(byId.get(id));
    });
    transaction.workingState[collection] = ordered;
  }

  commitTransaction(receipt) {
    const transaction = this._requireTransaction();
    this.maybeFail('BEFORE_ATOMIC_SWAP', null, -1);
    const nextVersion = transaction.versionBefore + 1;
    const storedReceipt = Object.assign({}, safeClone(receipt), {
      stateVersionBefore: transaction.versionBefore,
      stateVersionAfter: nextVersion
    });
    this._state = transaction.workingState;
    this._version = nextVersion;
    this._receiptsByPlanId.set(transaction.planId, safeClone(storedReceipt));
    if (transaction.idempotencyKey) {
      this._receiptsByIdempotencyKey.set(transaction.idempotencyKey, safeClone(storedReceipt));
    }
    this._transaction = null;
    return safeClone(storedReceipt);
  }

  rollbackTransaction() {
    if (!this._transaction) return false;
    this._transaction = null;
    return true;
  }
}

function createRecordMemoryStore(initialState, options) {
  return new RecordMemoryStore(initialState, options);
}

function isRecordMemoryStore(value) {
  return Boolean(value && TRUSTED_MEMORY_STORES.has(value));
}

module.exports = {
  RecordMemoryStore,
  createRecordMemoryStore,
  createStoreError,
  isRecordMemoryStore
};
