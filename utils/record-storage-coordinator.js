const {
  LEGACY_BUSINESS_STORAGE_KEY,
  STORAGE_TARGET_KINDS
} = require('./record-storage-adapter-contract');
const { getTrustedGatewayIdentity } = require('./record-storage-gateways');
const {
  RECORD_STORAGE_COORDINATOR_MODES,
  RECORD_STORAGE_TRANSACTION_ERRORS,
  normalizeCoordinatorMode
} = require('./record-storage-transaction-contract');
const { createPersistentRecordTransactionManager } = require('./record-storage-transaction');
const {
  getRecordStorageBusinessFingerprint,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('./record-storage-state-projector');
const { safeClone, stableHash } = require('./record-state-diff');

const TRUSTED_COORDINATORS = new WeakMap();

function coordinatorError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = safeClone(details);
  return error;
}

function resolveLegacyGateway(provided) {
  if (provided) return provided;
  return {
    getStorageSync(key) {
      if (!globalThis.wx || typeof globalThis.wx.getStorageSync !== 'function') {
        throw coordinatorError('WX_STORAGE_UNAVAILABLE', '当前环境没有微信Storage读取能力。');
      }
      return globalThis.wx.getStorageSync(key);
    },
    setStorageSync(key, value) {
      if (!globalThis.wx || typeof globalThis.wx.setStorageSync !== 'function') {
        throw coordinatorError('WX_STORAGE_UNAVAILABLE', '当前环境没有微信Storage写入能力。');
      }
      return globalThis.wx.setStorageSync(key, value);
    },
    removeStorageSync(key) {
      if (!globalThis.wx || typeof globalThis.wx.removeStorageSync !== 'function') {
        throw coordinatorError('WX_STORAGE_UNAVAILABLE', '当前环境没有微信Storage删除能力。');
      }
      return globalThis.wx.removeStorageSync(key);
    }
  };
}

function createRecordStorageCoordinator(options = {}) {
  const mode = normalizeCoordinatorMode(options.mode);
  if (!mode) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
      'Legacy Writer协调模式无效。'
    );
  }
  if (mode === RECORD_STORAGE_COORDINATOR_MODES.SHARED_COMMIT) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
      '共享生产Commit仍明确禁用。'
    );
  }
  const gateway = resolveLegacyGateway(options.gateway);
  const gatewayIdentity = getTrustedGatewayIdentity(gateway);
  if (options.gateway && !gatewayIdentity) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      '显式注入的Storage gateway必须由受保护工厂创建。'
    );
  }
  if (mode === RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW
    && (!gatewayIdentity || gatewayIdentity.gatewayKind !== STORAGE_TARGET_KINDS.FAKE)) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      'TRANSACTION_PREVIEW只能使用受保护Fake Gateway。'
    );
  }
  const readContexts = new WeakMap();
  let writing = false;
  let transactionQueue = Promise.resolve();
  const transactionManager = mode === RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW
    ? createPersistentRecordTransactionManager({ gateway, mode })
    : null;

  function readRawBundle() {
    const value = gateway.getStorageSync(LEGACY_BUSINESS_STORAGE_KEY);
    return value || null;
  }

  function bindReadContext(state, rawBundle, writerSource) {
    if (state && typeof state === 'object') {
      readContexts.set(state, {
        businessFingerprint: getRecordStorageBusinessFingerprint(rawBundle || {}),
        bundleFingerprint: stableHash(rawBundle || null, 'legacybundle1'),
        persistentRevision: readRecordStorageControl(rawBundle || {})
          ? readRecordStorageControl(rawBundle || {}).storageRevision
          : 0,
        bundlePresent: Boolean(rawBundle),
        writerSource: String(writerSource || 'LEGACY_READ')
      });
    }
    return state;
  }

  function readState(createInitialState, readOptions = {}) {
    const raw = readRawBundle();
    const businessRaw = raw ? stripRecordStorageControl(raw) : null;
    const state = raw
      ? Object.assign(createInitialState(), businessRaw)
      : createInitialState();
    return bindReadContext(state, raw, readOptions.writerSource);
  }

  function writeLegacyState(state, writeOptions = {}) {
    if (mode !== RECORD_STORAGE_COORDINATOR_MODES.LEGACY_ONLY) {
      throw coordinatorError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
        '事务预演协调器不能执行Legacy passthrough写入。'
      );
    }
    if (writing) {
      throw coordinatorError(
        RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_REENTRANT,
        '业务Bundle Legacy Writer发生进程内重入。'
      );
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw coordinatorError('LEGACY_STATE_INVALID', 'Legacy Writer必须写入完整业务Bundle对象。');
    }
    writing = true;
    try {
      const context = readContexts.get(state);
      if (!context) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_STATE_CONTEXT_REQUIRED,
          'Legacy Writer缺少受协调器签发的读取上下文。'
        );
      }
      const current = readRawBundle();
      const currentControl = readRecordStorageControl(current || {});
      const currentFingerprint = getRecordStorageBusinessFingerprint(current || {});
      const currentBundleFingerprint = stableHash(current || null, 'legacybundle1');
      const currentRevision = currentControl ? currentControl.storageRevision : 0;
      if (currentFingerprint !== context.businessFingerprint
        || currentBundleFingerprint !== context.bundleFingerprint
        || currentRevision !== context.persistentRevision
        || Boolean(current) !== context.bundlePresent) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_STALE,
          'Legacy Writer基于旧快照，已阻止覆盖新数据。',
          { writerSource: writeOptions.writerSource || context.writerSource }
        );
      }
      if (context.persistentRevision > 0) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_STALE,
          '含持久化控制信封的Bundle禁止由Legacy passthrough覆盖。'
        );
      }
      gateway.setStorageSync(LEGACY_BUSINESS_STORAGE_KEY, state);
      bindReadContext(state, state, writeOptions.writerSource || context && context.writerSource || 'LEGACY_WRITE');
      return state;
    } finally {
      writing = false;
    }
  }

  function updateLegacyState(createInitialState, mutator, writeOptions = {}) {
    const state = readState(createInitialState, writeOptions);
    const nextState = mutator(state) || state;
    if (nextState !== state && nextState && typeof nextState === 'object') {
      const context = readContexts.get(state);
      if (context) readContexts.set(nextState, context);
    }
    return writeLegacyState(nextState, writeOptions);
  }

  function initializeLegacyState(createInitialState, writeOptions = {}) {
    const state = readState(createInitialState, Object.assign({ writerSource: 'APP_LAUNCH_INITIALIZE' }, writeOptions));
    return writeLegacyState(state, Object.assign({ writerSource: 'APP_LAUNCH_INITIALIZE' }, writeOptions));
  }

  const coordinator = {
    getIdentity() {
      return {
        schemaVersion: 'record-storage-coordinator-v1',
        mode,
        businessStorageKey: LEGACY_BUSINESS_STORAGE_KEY,
        sharedProductionCommitEnabled: false,
        gatewayKind: gatewayIdentity && gatewayIdentity.gatewayKind || (options.gateway ? 'UNKNOWN' : STORAGE_TARGET_KINDS.WX_LEGACY)
      };
    },
    initializeLegacyState,
    readRawBundle,
    readState,
    updateLegacyState,
    writeLegacyState,
    commitTransaction(input, commitOptions) {
      if (!transactionManager) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
          'LEGACY_ONLY不允许调用共享事务Commit。'
        );
      }
      return transactionManager.commitBundle(input, commitOptions);
    },
    enqueueTransaction(inputOrBuilder, commitOptions) {
      if (!transactionManager) {
        return Promise.reject(coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
          'LEGACY_ONLY不允许进入共享事务队列。'
        ));
      }
      const queued = transactionQueue.then(() => {
        const snapshot = transactionManager.readTransactionSnapshot();
        const input = typeof inputOrBuilder === 'function'
          ? inputOrBuilder(safeClone(snapshot))
          : inputOrBuilder;
        return transactionManager.commitBundle(input, commitOptions);
      });
      transactionQueue = queued.then(() => undefined, () => undefined);
      return queued;
    },
    recoverTransaction(recoveryOptions) {
      if (!transactionManager) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
          'LEGACY_ONLY不创建或恢复共享事务资料。'
        );
      }
      return transactionManager.recover(recoveryOptions);
    }
  };
  TRUSTED_COORDINATORS.set(coordinator, Object.freeze({ mode, gateway }));
  return Object.freeze(coordinator);
}

function isTrustedRecordStorageCoordinator(value) {
  return TRUSTED_COORDINATORS.has(value);
}

module.exports = {
  createRecordStorageCoordinator,
  isTrustedRecordStorageCoordinator
};
