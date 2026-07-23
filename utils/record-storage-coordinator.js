const {
  LEGACY_BUSINESS_STORAGE_KEY,
  RECORD_TRANSACTION_STORAGE_KEYS,
  STORAGE_TARGET_KINDS
} = require('./record-storage-adapter-contract');
const { getTrustedGatewayIdentity } = require('./record-storage-gateway-registry');
const {
  RECORD_STORAGE_COORDINATOR_MODES,
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_ERRORS,
  RECORD_STORAGE_TRANSACTION_STATES,
  normalizeCoordinatorMode
} = require('./record-storage-transaction-contract');
const {
  createPersistentRecordTransactionManager,
  getTrustedRecordStorageTransactionManagerIdentity
} = require('./record-storage-transaction');
const {
  RECORD_STORAGE_LEGACY_SAVE_STATUSES,
  RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS,
  RECORD_STORAGE_RELEASE_A_SCHEMA_VERSION,
  normalizeLegacyWriterSource
} = require('./record-storage-release-contract');
const {
  getRecordStorageBusinessFingerprint,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('./record-storage-state-projector');
const { safeClone, stableHash } = require('./record-state-diff');

const TRUSTED_COORDINATORS = new WeakMap();
const RELEASE_A_COORDINATOR_AUTHORITY = Object.freeze({});

function coordinatorError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = safeClone(details);
  return error;
}

function createCoordinator(options = {}, authority = null) {
  const mode = normalizeCoordinatorMode(options.mode);
  const releaseAEnabled = authority === RELEASE_A_COORDINATOR_AUTHORITY;
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
  if (!options.gateway) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      'Storage协调器必须显式注入受保护Gateway，禁止回落到全局wx。'
    );
  }
  const gateway = options.gateway;
  const gatewayIdentity = getTrustedGatewayIdentity(gateway);
  if (!gatewayIdentity) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      '显式注入的Storage gateway必须由受保护工厂创建。'
    );
  }
  if (!releaseAEnabled
    && gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.WX_LEGACY) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      '真实业务wx Gateway只能由Release A高层Coordinator工厂使用。'
    );
  }
  const transactionPreviewGatewayAllowed = gatewayIdentity && (
    gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.FAKE
    || (gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.WX_ISOLATED_TEST
      && gatewayIdentity.runtimeTestOnly === true)
  );
  if (mode === RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW
    && !transactionPreviewGatewayAllowed) {
    throw coordinatorError(
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
      'TRANSACTION_PREVIEW只能使用受保护Fake或微信开发者工具隔离测试Gateway。'
    );
  }
  const transactionStorageKeys = gatewayIdentity && gatewayIdentity.transactionStorageKeys || {
    primary: LEGACY_BUSINESS_STORAGE_KEY,
    journal: RECORD_TRANSACTION_STORAGE_KEYS.journal,
    backup: RECORD_TRANSACTION_STORAGE_KEYS.backup
  };
  const readContexts = new WeakMap();
  let writing = false;
  let recoveryLocked = false;
  let legacySequence = 0;
  let lastLegacyWriteResult = null;
  let lastStartupResult = null;
  let transactionQueue = Promise.resolve();
  const transactionManager = mode === RECORD_STORAGE_COORDINATOR_MODES.TRANSACTION_PREVIEW
    ? createPersistentRecordTransactionManager({ gateway, mode })
    : (releaseAEnabled
      ? options.releaseATransactionManager
      : null);
  if (releaseAEnabled) {
    const transactionIdentity = getTrustedRecordStorageTransactionManagerIdentity(transactionManager);
    if (!transactionIdentity
      || transactionIdentity.legacyReleaseA !== true
      || transactionIdentity.gateway !== gateway) {
      throw coordinatorError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN,
        'Release A协调器需要与同一Gateway绑定的受保护事务管理器。'
      );
    }
  }

  function monitor(type, payload = {}) {
    if (!options.monitor || typeof options.monitor.record !== 'function') return;
    try { options.monitor.record(type, payload); } catch (ignored) {
      // 基础设施监测永远不能改变保存结果。
    }
  }

  function resolveWriterSource(value) {
    if (!releaseAEnabled) return String(value || 'LEGACY_WRITE');
    const normalized = normalizeLegacyWriterSource(value);
    if (!normalized) {
      throw coordinatorError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
        'Release A Legacy Writer必须显式提供受控来源。'
      );
    }
    return normalized;
  }

  function nowIso() {
    const value = options.clock && typeof options.clock.now === 'function'
      ? options.clock.now()
      : new Date();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw coordinatorError(
        RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID,
        'Release A事务时钟返回无效时刻。'
      );
    }
    return date.toISOString();
  }

  function legacyTransactionInput(state, context, writeOptions, writerSource) {
    legacySequence += 1;
    const targetBundle = stripRecordStorageControl(safeClone(state));
    const targetFingerprint = getRecordStorageBusinessFingerprint(targetBundle);
    const planHash = stableHash({
      writerSource,
      baseRevision: context.persistentRevision,
      baseFingerprint: context.businessFingerprint,
      targetFingerprint
    }, 'legacyplan1');
    const seed = stableHash({
      planHash,
      sequence: legacySequence,
      committedAt: nowIso()
    }, 'legacytx1');
    const planId = String(writeOptions.planId || `legacy_plan_${seed}`);
    const transactionId = String(writeOptions.transactionId || `legacy_tx_${seed}`);
    const idempotencyKey = String(writeOptions.idempotencyKey || planId);
    return {
      transactionId,
      planId,
      planHash,
      idempotencyKey,
      baseRevision: context.persistentRevision,
      baseFingerprint: context.businessFingerprint,
      targetBundle,
      committedAt: nowIso(),
      writerSource,
      riskLevel: /PAYMENT|RECEIVABLE|FORMAL/.test(writerSource) ? 'FINANCIAL' : 'NORMAL'
    };
  }

  function firstResultErrorCode(result) {
    return result && result.errors && result.errors[0] && result.errors[0].code || '';
  }

  function classifyLegacyFailure(result) {
    const errorCode = firstResultErrorCode(result);
    if ([
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_PRIMARY_READBACK_MISMATCH,
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_COMMIT_OUTCOME_UNKNOWN
    ].includes(errorCode)) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_READBACK_FAILED;
    }
    if ([
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_INSUFFICIENT,
      RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_NOT_CONFIRMED
    ].includes(errorCode)) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_CAPACITY_BLOCKED;
    }
    if (result && result.status === RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_STALE;
    }
    if (result && result.status === RECORD_STORAGE_TRANSACTION_STATES.ROLLED_BACK) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_ROLLED_BACK;
    }
    if (result && [
      RECORD_STORAGE_TRANSACTION_STATES.RECOVERY_REQUIRED,
      RECORD_STORAGE_TRANSACTION_STATES.COMMIT_OUTCOME_UNKNOWN
    ].includes(result.status)) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED;
    }
    if (result && result.recovery && (
      result.recovery.writeBlocked === true
      || result.recovery.status === RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED
    )) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED;
    }
    if (result && result.recovery
      && result.recovery.status === RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK) {
      return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_ROLLED_BACK;
    }
    return RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_FAILED;
  }

  function throwLegacyFailure(result, writerSource) {
    const status = classifyLegacyFailure(result);
    const errorCode = firstResultErrorCode(result);
    if (status === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED
      || result && result.writeBlocked === true
      || result && result.recovery && result.recovery.writeBlocked === true) {
      recoveryLocked = true;
    }
    const monitorType = {
      LEGACY_SAVE_STALE: RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_STALE,
      LEGACY_SAVE_ROLLED_BACK: RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_ROLLED_BACK,
      LEGACY_SAVE_RECOVERY_REQUIRED: RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_RECOVERY_REQUIRED,
      LEGACY_SAVE_CAPACITY_BLOCKED: RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_CAPACITY_BLOCKED,
      LEGACY_SAVE_READBACK_FAILED: RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_READBACK_FAILED
    }[status];
    if (monitorType) monitor(monitorType, { writerSource, status, errorCode });
    lastLegacyWriteResult = safeClone(Object.assign({}, result, { legacyStatus: status }));
    throw coordinatorError(status, 'Legacy业务Bundle事务没有提交成功。', {
      writerSource,
      transactionStatus: result && result.status || '',
      errorCode
    });
  }

  function readRawBundle() {
    const value = gateway.getStorageSync(transactionStorageKeys.primary);
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
    const writerSource = resolveWriterSource(writeOptions.writerSource);
    if (releaseAEnabled && recoveryLocked) {
      monitor(RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_RECOVERY_REQUIRED, {
        writerSource,
        status: RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED
      });
      throw coordinatorError(
        RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED,
        'Storage处于Recovery Lock，业务写入已阻断。'
      );
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
        if (releaseAEnabled) {
          monitor(RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_STALE, {
            writerSource,
            status: RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_STALE,
            revision: currentRevision
          });
          lastLegacyWriteResult = {
            legacyStatus: RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_STALE,
            writerSource,
            currentRevision
          };
        }
        throw coordinatorError(
          releaseAEnabled
            ? RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_STALE
            : RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_STALE,
          'Legacy Writer基于旧快照，已阻止覆盖新数据。',
          { writerSource }
        );
      }
      if (!releaseAEnabled && context.persistentRevision > 0) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_STALE,
          '含持久化控制信封的Bundle禁止由Legacy passthrough覆盖。'
        );
      }
      if (releaseAEnabled) {
        monitor(RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_DECISION, {
          writerSource,
          status: 'TRANSACTIONAL_LEGACY',
          revision: context.persistentRevision
        });
        monitor(RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.WRITER_QUEUE_DELAY, {
          writerSource,
          status: 'SYNCHRONOUS_CRITICAL_SECTION',
          revision: context.persistentRevision,
          queueDelayMs: 0
        });
        const result = transactionManager.commitBundle(
          legacyTransactionInput(state, context, writeOptions, writerSource),
          writeOptions.transactionOptions || {}
        );
        if (!result || result.commitSucceeded !== true) throwLegacyFailure(result || {}, writerSource);
        // transaction manager 已完成主 Bundle 的写后读回。这里不能再做一次可能失败的
        // 附加读取，否则会把已 COMMITTED 误报为失败，调用方重试可能产生重复业务。
        // 保留 state 的旧 read context，把该对象视为已消费；再次保存必然由 CAS 判 stale。
        const legacyStatus = result.status === RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED
          ? RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_ALREADY_COMMITTED
          : RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_COMMITTED;
        lastLegacyWriteResult = safeClone(Object.assign({}, result, { legacyStatus, writerSource }));
        if (result.status === RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING
          || result.writeBlocked === true
          || result.recovery && result.recovery.writeBlocked === true) {
          recoveryLocked = true;
        }
        monitor(RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.LEGACY_WRITE_COMMITTED, {
          writerSource,
          status: legacyStatus,
          revision: result.targetRevision || result.receipt && result.receipt.committedRevision || 0
        });
        return state;
      }
      gateway.setStorageSync(transactionStorageKeys.primary, state);
      bindReadContext(state, state, writerSource);
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
    if (releaseAEnabled) {
      const startup = startLegacyStorageInfrastructure(createInitialState, writeOptions);
      if (startup.writeBlocked) {
        throw coordinatorError(
          RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED,
          '启动恢复未完成，初始化已阻断。',
          { recoveryStatus: startup.recovery && startup.recovery.status || '' }
        );
      }
      return startup.state;
    }
    const state = readState(createInitialState, Object.assign({ writerSource: 'APP_LAUNCH_INITIALIZE' }, writeOptions));
    return writeLegacyState(state, Object.assign({ writerSource: 'APP_LAUNCH_INITIALIZE' }, writeOptions));
  }

  function recoverLegacyStorage(recoveryOptions = {}) {
    if (!releaseAEnabled || !transactionManager) {
      throw coordinatorError(
        RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
        '普通LEGACY_ONLY协调器不具备Release A生产恢复能力。'
      );
    }
    const recovery = transactionManager.recover(recoveryOptions);
    recoveryLocked = Boolean(recovery && recovery.writeBlocked);
    monitor(RECORD_STORAGE_RELEASE_A_MONITOR_EVENTS.STARTUP_RECOVERY_RESULT, {
      writerSource: 'APP_LAUNCH_INITIALIZE',
      status: recovery && recovery.status || 'UNKNOWN',
      errorCode: firstResultErrorCode(recovery)
    });
    return safeClone(recovery);
  }

  function startLegacyStorageInfrastructure(createInitialState, startupOptions = {}) {
    const recovery = recoverLegacyStorage(startupOptions.recoveryOptions || {});
    if (recovery.writeBlocked) {
      lastStartupResult = {
        schemaVersion: RECORD_STORAGE_RELEASE_A_SCHEMA_VERSION,
        status: RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED,
        writeBlocked: true,
        initialized: false,
        recovery
      };
      return safeClone(lastStartupResult);
    }
    const raw = readRawBundle();
    if (raw) {
      const state = readState(createInitialState, { writerSource: 'APP_LAUNCH_INITIALIZE' });
      lastStartupResult = {
        schemaVersion: RECORD_STORAGE_RELEASE_A_SCHEMA_VERSION,
        status: recovery.status,
        writeBlocked: false,
        initialized: false,
        state,
        recovery
      };
      return safeClone(lastStartupResult);
    }
    const state = readState(createInitialState, { writerSource: 'APP_LAUNCH_INITIALIZE' });
    writeLegacyState(state, Object.assign({}, startupOptions, {
      writerSource: 'APP_LAUNCH_INITIALIZE'
    }));
    lastStartupResult = {
      schemaVersion: RECORD_STORAGE_RELEASE_A_SCHEMA_VERSION,
      status: RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_COMMITTED,
      writeBlocked: false,
      initialized: true,
      state,
      recovery
    };
    return safeClone(lastStartupResult);
  }

  const coordinator = {
    getIdentity() {
      return {
        schemaVersion: 'record-storage-coordinator-v1',
        mode,
        businessStorageKey: transactionStorageKeys.primary,
        sharedProductionCommitEnabled: false,
        legacyTransactionProtectionEnabled: releaseAEnabled,
        recoveryLocked,
        gatewayKind: gatewayIdentity && gatewayIdentity.gatewayKind || (options.gateway ? 'UNKNOWN' : STORAGE_TARGET_KINDS.WX_LEGACY)
      };
    },
    getLastLegacyWriteResult() {
      return safeClone(lastLegacyWriteResult);
    },
    getLastStartupResult() {
      return safeClone(lastStartupResult);
    },
    initializeLegacyState,
    isRecoveryLocked() {
      return recoveryLocked;
    },
    readRawBundle,
    readState,
    recoverLegacyStorage,
    startLegacyStorageInfrastructure,
    updateLegacyState,
    writeLegacyState,
    commitTransaction(input, commitOptions) {
      if (!transactionManager || releaseAEnabled) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
          'LEGACY_ONLY不允许调用共享事务Commit。'
        );
      }
      return transactionManager.commitBundle(input, commitOptions);
    },
    enqueueTransaction(inputOrBuilder, commitOptions) {
      if (!transactionManager || releaseAEnabled) {
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
      if (!transactionManager || releaseAEnabled) {
        throw coordinatorError(
          RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED,
          'LEGACY_ONLY不创建或恢复共享事务资料。'
        );
      }
      return transactionManager.recover(recoveryOptions);
    }
  };
  TRUSTED_COORDINATORS.set(coordinator, Object.freeze({ mode, gateway, releaseAEnabled }));
  return Object.freeze(coordinator);
}

function createRecordStorageCoordinator(options = {}) {
  return createCoordinator(options);
}

function createReleaseARecordStorageCoordinatorFromTransactionManager(
  options = {},
  transactionManager
) {
  return createCoordinator(
    Object.assign({}, options, {
      mode: RECORD_STORAGE_COORDINATOR_MODES.LEGACY_ONLY,
      releaseATransactionManager: transactionManager
    }),
    RELEASE_A_COORDINATOR_AUTHORITY
  );
}

function isTrustedRecordStorageCoordinator(value) {
  return TRUSTED_COORDINATORS.has(value);
}

module.exports = {
  createReleaseARecordStorageCoordinatorFromTransactionManager,
  createRecordStorageCoordinator,
  isTrustedRecordStorageCoordinator
};
