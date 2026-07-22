const {
  RECORD_STORAGE_ADAPTER_SCHEMA_VERSION,
  RECORD_STORAGE_PREVIEW_SCHEMA_VERSION,
  STORAGE_ADAPTER_ERROR_CODES,
  STORAGE_ATOMICITY_STRATEGIES,
  STORAGE_MIGRATION_MODES,
  STORAGE_TARGET_KINDS,
  normalizeStorageMigrationMode
} = require('./record-storage-adapter-contract');
const {
  LEGACY_BUSINESS_STORAGE_KEY,
  buildLegacyStorageWrites,
  projectLegacyStorageEntries
} = require('./record-storage-state-projector');
const { commitRecordSavePlan } = require('./record-save-commit');
const { createRecordMemoryStore } = require('./record-memory-store');
const { getStateFingerprint, safeClone } = require('./record-state-diff');

const TRUSTED_GATEWAYS = new WeakMap();
const TRUSTED_ADAPTERS = new WeakMap();
const TRUSTED_SNAPSHOTS = new WeakMap();

function adapterError(code, message, details = {}) {
  return {
    code,
    message,
    details: safeClone(details)
  };
}

function validateGatewayShape(gateway) {
  if (!gateway || typeof gateway !== 'object'
    || typeof gateway.getStorageSync !== 'function'
    || typeof gateway.setStorageSync !== 'function'
    || typeof gateway.removeStorageSync !== 'function') {
    throw Object.assign(new Error('Storage gateway合同不完整。'), {
      code: STORAGE_ADAPTER_ERROR_CODES.STORAGE_GATEWAY_INVALID
    });
  }
}

function registerGateway(gateway, descriptor) {
  validateGatewayShape(gateway);
  TRUSTED_GATEWAYS.set(gateway, Object.freeze(Object.assign({}, descriptor)));
  return gateway;
}

function getTrustedGatewayIdentity(gateway) {
  const descriptor = TRUSTED_GATEWAYS.get(gateway);
  return descriptor ? safeClone(descriptor) : null;
}

function createWxStorageGateway() {
  if (arguments.length > 0) {
    throw Object.assign(new Error('微信Storage gateway只能在平台组合根绑定真实wx。'), {
      code: STORAGE_ADAPTER_ERROR_CODES.STORAGE_GATEWAY_INVALID
    });
  }
  const wxApi = typeof globalThis !== 'undefined' ? globalThis.wx : null;
  validateGatewayShape(wxApi);
  const gateway = {
    getStorageSync(key) {
      return wxApi.getStorageSync(key);
    },
    setStorageSync(key, value) {
      return wxApi.setStorageSync(key, value);
    },
    removeStorageSync(key) {
      return wxApi.removeStorageSync(key);
    },
    listStorageKeysSync() {
      if (typeof wxApi.getStorageInfoSync !== 'function') return null;
      const result = wxApi.getStorageInfoSync();
      return result && Array.isArray(result.keys) ? result.keys.slice() : null;
    }
  };
  return registerGateway(gateway, {
    gatewayKind: STORAGE_TARGET_KINDS.WX_LEGACY,
    canTouchRealStorage: true,
    source: 'WX_API'
  });
}

function normalizeFailureInjection(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    phase: String(value.phase || ''),
    key: String(value.key || ''),
    code: String(value.code || 'FAKE_STORAGE_INJECTED_FAILURE')
  };
}

function createFakeStorageGateway(initialEntries = {}, options = {}) {
  let entries = safeClone(initialEntries || {});
  let failure = normalizeFailureInjection(options.failureInjection);
  const events = [];
  let reads = 0;
  let writes = 0;
  let removals = 0;

  function maybeFail(phase, key) {
    if (!failure || failure.phase !== phase) return;
    if (failure.key && failure.key !== String(key || '')) return;
    const error = new Error(failure.code);
    error.code = failure.code;
    throw error;
  }

  const gateway = {
    getStorageSync(key) {
      maybeFail('BEFORE_GET', key);
      reads += 1;
      events.push({ type: 'GET', key: String(key) });
      const value = safeClone(entries[key]);
      maybeFail('AFTER_GET', key);
      return value;
    },
    setStorageSync(key, value) {
      maybeFail('BEFORE_SET', key);
      writes += 1;
      events.push({ type: 'SET', key: String(key) });
      if (!failure || failure.phase !== 'SILENT_NOOP' || (failure.key && failure.key !== String(key))) {
        entries[key] = safeClone(value);
      }
      maybeFail('AFTER_SET', key);
      return undefined;
    },
    removeStorageSync(key) {
      maybeFail('BEFORE_REMOVE', key);
      removals += 1;
      events.push({ type: 'REMOVE', key: String(key) });
      delete entries[key];
      maybeFail('AFTER_REMOVE', key);
      return undefined;
    },
    listStorageKeysSync() {
      return Object.keys(entries).sort();
    },
    getStats() {
      return { reads, writes, removals, events: safeClone(events) };
    },
    getEntries() {
      return safeClone(entries);
    },
    setFailureInjection(value) {
      failure = normalizeFailureInjection(value);
    },
    clearFailureInjection() {
      failure = null;
    }
  };
  return registerGateway(gateway, {
    gatewayKind: STORAGE_TARGET_KINDS.FAKE,
    canTouchRealStorage: false,
    source: 'IN_MEMORY_FAKE'
  });
}

function readGatewayEntries(gateway) {
  const listed = typeof gateway.listStorageKeysSync === 'function' ? gateway.listStorageKeysSync() : null;
  const enumerationComplete = Array.isArray(listed);
  const keys = enumerationComplete ? listed.slice().map(String).sort() : [LEGACY_BUSINESS_STORAGE_KEY];
  const entries = {};
  keys.forEach((key) => {
    if (key === LEGACY_BUSINESS_STORAGE_KEY) entries[key] = gateway.getStorageSync(key);
    else entries[key] = { __presenceOnly: true };
  });
  if (!enumerationComplete || !keys.includes(LEGACY_BUSINESS_STORAGE_KEY)) {
    const value = gateway.getStorageSync(LEGACY_BUSINESS_STORAGE_KEY);
    if (value !== undefined && value !== null && value !== '') entries[LEGACY_BUSINESS_STORAGE_KEY] = value;
  }
  return { entries, enumerationComplete };
}

function buildDisabledCommitResult(plan, identity) {
  return {
    schemaVersion: 'record-storage-commit-disabled-v1',
    planId: String(plan && plan.planId || ''),
    planHash: String(plan && plan.planHash || ''),
    status: 'BLOCKED',
    commitSucceeded: false,
    commitEnabled: false,
    writeAttempted: false,
    targetKind: identity.targetKind,
    migrationMode: identity.migrationMode,
    errors: [adapterError(
      STORAGE_ADAPTER_ERROR_CODES.SHARED_PRODUCTION_COMMIT_DISABLED,
      'Phase 1E.2A禁止共享生产Commit。'
    )]
  };
}

function createLegacyStorageAdapter(options = {}) {
  const gateway = options.gateway;
  const gatewayIdentity = getTrustedGatewayIdentity(gateway);
  if (!gatewayIdentity) {
    const error = new Error('只能使用受保护工厂创建的Storage gateway。');
    error.code = STORAGE_ADAPTER_ERROR_CODES.STORAGE_ADAPTER_IDENTITY_INVALID;
    throw error;
  }
  const migrationMode = normalizeStorageMigrationMode(options.migrationMode);
  if (!migrationMode) {
    const error = new Error('Storage迁移模式无效。');
    error.code = STORAGE_ADAPTER_ERROR_CODES.STORAGE_MIGRATION_MODE_INVALID;
    throw error;
  }
  const targetKind = gatewayIdentity.gatewayKind === STORAGE_TARGET_KINDS.FAKE
    ? STORAGE_TARGET_KINDS.FAKE
    : (migrationMode === STORAGE_MIGRATION_MODES.SHADOW_COMPARE
      ? STORAGE_TARGET_KINDS.SHADOW
      : STORAGE_TARGET_KINDS.WX_LEGACY);
  const identity = Object.freeze({
    schemaVersion: RECORD_STORAGE_ADAPTER_SCHEMA_VERSION,
    adapterName: 'legacy-business-bundle-preview',
    targetKind,
    gatewayKind: gatewayIdentity.gatewayKind,
    migrationMode,
    commitEnabled: false,
    supportsPreview: true,
    supportsAtomicReplace: false,
    atomicityStrategy: STORAGE_ATOMICITY_STRATEGIES.SINGLE_BUNDLE_REPLACE_UNVERIFIED,
    businessStorageKey: LEGACY_BUSINESS_STORAGE_KEY
  });

  let adapter;
  adapter = {
    getIdentity() {
      return safeClone(identity);
    },
    readSnapshot() {
      const read = readGatewayEntries(gateway);
      const snapshot = projectLegacyStorageEntries(read.entries, options.projectorOptions || {});
      snapshot.topology.enumerationComplete = read.enumerationComplete;
      TRUSTED_SNAPSHOTS.set(snapshot, Object.freeze({
        adapter,
        businessStorageKey: snapshot.businessStorageKey,
        fingerprint: snapshot.storageStateFingerprint,
        snapshotFingerprint: snapshot.storageSnapshotFingerprint
      }));
      return snapshot;
    },
    getVersion() {
      return this.readSnapshot().storageStateVersion;
    },
    getFingerprint() {
      return this.readSnapshot().storageStateFingerprint;
    },
    previewCommit(plan, previewOptions = {}) {
      try {
        let snapshot;
        if (previewOptions.snapshot) {
          const provided = previewOptions.snapshot;
          const trust = TRUSTED_SNAPSHOTS.get(provided);
          const providedFingerprint = provided && provided.domainState
            ? getStateFingerprint(provided.domainState)
            : '';
          if (!trust
            || trust.adapter !== adapter
            || trust.businessStorageKey !== provided.businessStorageKey
            || trust.fingerprint !== provided.storageStateFingerprint
            || trust.fingerprint !== providedFingerprint
            || trust.snapshotFingerprint !== provided.storageSnapshotFingerprint) {
            throw Object.assign(new Error('Preview快照不是本适配器签发的可信快照。'), {
              code: STORAGE_ADAPTER_ERROR_CODES.STORAGE_SNAPSHOT_UNTRUSTED
            });
          }
          const current = this.readSnapshot();
          if (current.storageStateFingerprint !== trust.fingerprint
            || current.businessBundlePresent !== provided.businessBundlePresent) {
            throw Object.assign(new Error('Preview快照已经落后于当前Storage业务状态。'), {
              code: STORAGE_ADAPTER_ERROR_CODES.STORAGE_SNAPSHOT_STALE
            });
          }
          snapshot = current;
        } else {
          snapshot = this.readSnapshot();
        }
        if (!snapshot || snapshot.schemaVersion !== 'record-storage-snapshot-v1') {
          throw Object.assign(new Error('Preview快照无效。'), {
            code: STORAGE_ADAPTER_ERROR_CODES.STORAGE_SNAPSHOT_INVALID
          });
        }
        const store = createRecordMemoryStore(snapshot.domainState, {
          version: snapshot.storageStateVersion
        });
        const receipt = commitRecordSavePlan(plan, store, {
          target: 'MEMORY',
          authorization: previewOptions.authorization,
          clock: previewOptions.clock,
          idGenerator: previewOptions.idGenerator
        });
        const nextDomainState = store.getState();
        const succeeded = receipt && receipt.commitSucceeded === true;
        return {
          schemaVersion: RECORD_STORAGE_PREVIEW_SCHEMA_VERSION,
          planId: String(plan && plan.planId || ''),
          planHash: String(plan && plan.planHash || ''),
          previewStatus: receipt && receipt.status || 'FAILED',
          stateBeforeFingerprint: snapshot.storageStateFingerprint,
          stateAfterFingerprint: getStateFingerprint(nextDomainState),
          storageStateVersion: snapshot.storageStateVersion,
          businessDiff: safeClone(receipt && receipt.businessDiff || {}),
          fullDiff: safeClone(receipt && receipt.fullDiff || {}),
          nextDomainState,
          proposedWrites: succeeded ? buildLegacyStorageWrites(nextDomainState, snapshot) : [],
          proposedRemovals: [],
          atomicityStrategy: STORAGE_ATOMICITY_STRATEGIES.SINGLE_BUNDLE_REPLACE_UNVERIFIED,
          commitEnabled: false,
          writeAttempted: false,
          blockingIssues: safeClone(receipt && receipt.errors || []),
          warnings: [{
            code: STORAGE_ADAPTER_ERROR_CODES.SHARED_PRODUCTION_COMMIT_DISABLED,
            message: 'Preview只在内存执行；真实微信Storage写入保持禁用。'
          }],
          memoryReceipt: safeClone(receipt)
        };
      } catch (error) {
        return {
          schemaVersion: RECORD_STORAGE_PREVIEW_SCHEMA_VERSION,
          planId: String(plan && plan.planId || ''),
          planHash: String(plan && plan.planHash || ''),
          previewStatus: 'FAILED',
          businessDiff: {},
          fullDiff: {},
          proposedWrites: [],
          proposedRemovals: [],
          atomicityStrategy: STORAGE_ATOMICITY_STRATEGIES.SINGLE_BUNDLE_REPLACE_UNVERIFIED,
          commitEnabled: false,
          writeAttempted: false,
          blockingIssues: [adapterError(
            error && error.code || STORAGE_ADAPTER_ERROR_CODES.STORAGE_PREVIEW_FAILED,
            error && error.message || 'Storage preview失败。'
          )],
          warnings: []
        };
      }
    },
    commit(plan) {
      return buildDisabledCommitResult(plan, identity);
    },
    getCommitReceipt() {
      return null;
    }
  };
  TRUSTED_ADAPTERS.set(adapter, identity);
  return adapter;
}

function getTrustedStorageAdapterIdentity(adapter) {
  const identity = TRUSTED_ADAPTERS.get(adapter);
  return identity ? safeClone(identity) : null;
}

function isTrustedStorageAdapter(adapter) {
  return TRUSTED_ADAPTERS.has(adapter);
}

module.exports = {
  createFakeStorageGateway,
  createLegacyStorageAdapter,
  createWxStorageGateway,
  getTrustedGatewayIdentity,
  getTrustedStorageAdapterIdentity,
  isTrustedStorageAdapter
};
