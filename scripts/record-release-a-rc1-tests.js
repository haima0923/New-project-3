#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LEGACY_BUSINESS_STORAGE_KEY,
  RECORD_TRANSACTION_STORAGE_KEYS
} = require('../utils/record-storage-adapter-contract');
const {
  createRecordStorageCoordinator
} = require('../utils/record-storage-coordinator');
const {
  createFakeStorageGateway,
  createWxStorageGateway
} = require('../utils/record-storage-gateways');
const {
  RECORD_STORAGE_LEGACY_SAVE_STATUSES,
  RECORD_STORAGE_LEGACY_WRITER_SOURCES
} = require('../utils/record-storage-release-contract');
const { createRecordStorageReleaseAMonitor } = require('../utils/record-storage-release-monitor');
const {
  RECORD_STORAGE_CONTROL_KEY,
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_ERRORS
} = require('../utils/record-storage-transaction-contract');
const {
  createLegacyReleaseARecordStorageCoordinator,
  createPersistentRecordTransactionManager
} = require('../utils/record-storage-transaction');
const {
  getRecordStorageBusinessFingerprint,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('../utils/record-storage-state-projector');
const {
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES,
  LEGACY_PAGE_LIFECYCLE_INVENTORY
} = require('../utils/record-save-shadow');
const { safeClone, stableSerialize } = require('../utils/record-state-diff');
const {
  canonicalState,
  runLegacyEquivalenceWithVisitor
} = require('./record-shared-core-phase1e1-tests');

delete global.wx;

const ROOT = path.resolve(__dirname, '..');
const FIXED_NOW = '2026-07-23T06:00:00.000Z';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function baseState(overrides = {}) {
  return Object.assign({
    meta: {
      onboarded: true,
      industry: '合成行业',
      userId: 'local-user',
      createdAt: '2026-07-01T00:00:00.000Z'
    },
    customers: [],
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    dunningRecords: [],
    todos: [],
    orderProgress: [],
    pendingNotes: [],
    aiParseLogs: [],
    dunningTemplates: [],
    operationLogs: [],
    deletedRecords: [],
    productCatalog: []
  }, clone(overrides));
}

function fixedClock() {
  return { now: () => new Date(FIXED_NOW) };
}

function releaseAHarness(initialEntries = {}, options = {}) {
  const gateway = createFakeStorageGateway(initialEntries, Object.assign({
    capacityBytes: 50 * 1024 * 1024
  }, options.gatewayOptions || {}));
  const monitor = options.monitor || createRecordStorageReleaseAMonitor({
    clock: fixedClock(),
    maxEvents: 128
  });
  const coordinator = createLegacyReleaseARecordStorageCoordinator({
    gateway,
    monitor,
    clock: fixedClock()
  });
  return { gateway, monitor, coordinator };
}

function currentBundle(gateway) {
  return gateway.getEntries()[LEGACY_BUSINESS_STORAGE_KEY];
}

function replaceStateContents(target, source) {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, clone(source));
  return target;
}

function assertBusinessEqual(actual, expected, label) {
  assert.strictEqual(
    stableSerialize(stripRecordStorageControl(actual)),
    stableSerialize(stripRecordStorageControl(expected)),
    label
  );
}

test('23个物理Writer和20个生命周期均经统一门面并绑定受控source且无业务key写入旁路', () => {
  assert.strictEqual(LEGACY_BUSINESS_BUNDLE_WRITE_SITES.length, 23);
  assert.strictEqual(LEGACY_PAGE_LIFECYCLE_INVENTORY.length, 20);
  assert.strictEqual(new Set(LEGACY_BUSINESS_BUNDLE_WRITE_SITES.map((item) => item.writerSource)).size, 23);
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES.forEach((site) => {
    assert(RECORD_STORAGE_LEGACY_WRITER_SOURCES[site.writerSource], site.writerSource);
    const source = fs.readFileSync(path.join(ROOT, site.sourceFile), 'utf8');
    assert(source.includes(`${site.callKind}(`), `${site.sourceFile}:${site.callKind}`);
    if (site.sourceFile !== 'app.js') {
      assert(source.includes(`writerSource: '${site.writerSource}'`), `${site.sourceFile}:${site.writerSource}`);
    }
  });
  const productionFiles = [];
  ['app.js', 'pages', 'utils', 'server'].forEach((entry) => {
    const absolute = path.join(ROOT, entry);
    if (fs.statSync(absolute).isFile()) {
      productionFiles.push(entry);
      return;
    }
    const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).forEach((item) => {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.endsWith('.js')) productionFiles.push(path.relative(ROOT, full));
    });
    walk(absolute);
  });
  const directLiteralWrites = productionFiles.filter((file) => (
    /setStorage(?:Sync)?\(\s*['"]yiwu_boss_ai_assistant_v1['"]/.test(
      fs.readFileSync(path.join(ROOT, file), 'utf8')
    )
  ));
  assert.deepStrictEqual(directLiteralWrites, []);
  const storageSource = fs.readFileSync(path.join(ROOT, 'utils/storage.js'), 'utf8');
  assert(storageSource.includes('createLegacyReleaseARecordStorageCoordinator'));
  const transactionExports = require('../utils/record-storage-transaction');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      transactionExports,
      'createLegacyReleaseATransactionManager'
    ),
    false
  );
  const privilegedFactoryConsumers = productionFiles.filter((file) => {
    if ([
      'utils/storage.js',
      'utils/record-storage-transaction.js',
      'utils/record-storage-coordinator.js',
      'utils/record-storage-wx-runtime-harness.js'
    ].includes(file)) return false;
    return fs.readFileSync(path.join(ROOT, file), 'utf8')
      .includes('createLegacyReleaseARecordStorageCoordinator');
  });
  assert.deepStrictEqual(privilegedFactoryConsumers, []);
  assert.strictEqual(storageSource.includes('.setStorageSync('), false);
});

test('Release A协调器身份仍为LEGACY_ONLY且Shared生产Commit继续硬关闭', () => {
  const { gateway, coordinator } = releaseAHarness();
  const identity = coordinator.getIdentity();
  assert.strictEqual(identity.mode, 'LEGACY_ONLY');
  assert.strictEqual(identity.legacyTransactionProtectionEnabled, true);
  assert.strictEqual(identity.sharedProductionCommitEnabled, false);
  assert.throws(
    () => coordinator.commitTransaction({}),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED
  );
  assert.throws(
    () => createRecordStorageCoordinator({ mode: 'SHARED_COMMIT' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED
  );
  assert.throws(
    () => createRecordStorageCoordinator({ mode: 'LEGACY_ONLY' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN
  );
  global.wx = {
    getStorageSync() { return ''; },
    setStorageSync() {},
    removeStorageSync() {},
    getStorageInfoSync() { return { keys: [], currentSize: 0, limitSize: 10240 }; }
  };
  const realWxGatewayShape = createWxStorageGateway();
  assert.throws(
    () => createRecordStorageCoordinator({
      mode: 'LEGACY_ONLY',
      gateway: realWxGatewayShape
    }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN
  );
  delete global.wx;
  const unsigned = coordinator.readState(() => baseState());
  assert.throws(
    () => coordinator.writeLegacyState(unsigned),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_INPUT_INVALID
  );
  const previewManager = createPersistentRecordTransactionManager({
    gateway,
    mode: 'TRANSACTION_PREVIEW'
  });
  const {
    createReleaseARecordStorageCoordinatorFromTransactionManager
  } = require('../utils/record-storage-coordinator');
  assert.throws(
    () => createReleaseARecordStorageCoordinatorFromTransactionManager(
      { gateway },
      previewManager
    ),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN
  );
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert(appSource.includes('prepareRecordStorageInfrastructure'));
  assert.strictEqual(appSource.includes('initializeState'), false);
  assert.strictEqual(appSource.includes('SHARED_COMMIT'), false);
});

test('已有Bundle纯启动零写入且不存在Bundle时只初始化一次并生成revision与receipt', () => {
  const existing = baseState({ futureTopLevel: { keep: true } });
  const existingHarness = releaseAHarness({ [LEGACY_BUSINESS_STORAGE_KEY]: existing });
  const before = existingHarness.gateway.getStats();
  const startup = existingHarness.coordinator.startLegacyStorageInfrastructure(() => baseState());
  const after = existingHarness.gateway.getStats();
  assert.strictEqual(startup.initialized, false);
  assert.strictEqual(startup.writeBlocked, false);
  assert.strictEqual(after.writes - before.writes, 0);
  assert.strictEqual(after.removals - before.removals, 0);
  assert.deepStrictEqual(currentBundle(existingHarness.gateway).futureTopLevel, { keep: true });

  const emptyHarness = releaseAHarness();
  const first = emptyHarness.coordinator.startLegacyStorageInfrastructure(() => baseState());
  const firstRaw = currentBundle(emptyHarness.gateway);
  const firstControl = readRecordStorageControl(firstRaw);
  assert.strictEqual(first.initialized, true);
  assert.strictEqual(firstControl.storageRevision, 1);
  assert.strictEqual(firstControl.recentReceipts.length, 1);
  const stats = emptyHarness.gateway.getStats();
  const second = emptyHarness.coordinator.startLegacyStorageInfrastructure(() => baseState());
  assert.strictEqual(second.initialized, false);
  assert.strictEqual(emptyHarness.gateway.getStats().writes, stats.writes);
  assert.strictEqual(readRecordStorageControl(currentBundle(emptyHarness.gateway)).storageRevision, 1);
});

test('22个代表业务的事务Legacy终态与旧Legacy和Shared Memory业务语义三路一致', async () => {
  let count = 0;
  await runLegacyEquivalenceWithVisitor(({ name, initialState, legacyState, sharedState }) => {
    count += 1;
    const { gateway, coordinator } = releaseAHarness({
      [LEGACY_BUSINESS_STORAGE_KEY]: clone(initialState)
    });
    const releaseState = coordinator.readState(() => clone(initialState));
    replaceStateContents(releaseState, legacyState);
    coordinator.writeLegacyState(releaseState, {
      writerSource: 'RELEASE_A_TEST',
      planId: `legacy-equivalence-${count}`,
      transactionId: `legacy-equivalence-tx-${count}`
    });
    const persisted = currentBundle(gateway);
    assertBusinessEqual(persisted, legacyState, `${name}:release vs legacy`);
    assert.deepStrictEqual(
      canonicalState(stripRecordStorageControl(persisted), initialState),
      canonicalState(sharedState, initialState),
      `${name}:release vs shared`
    );
    assert.strictEqual(readRecordStorageControl(persisted).storageRevision, 1, name);
  });
  assert.strictEqual(count, 22);
});

test('CAS阻止两个页面基于相同base覆盖且失败同步抛出避免继续成功反馈', () => {
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: baseState()
  });
  const pageA = coordinator.readState(() => baseState());
  const pageB = coordinator.readState(() => baseState());
  pageA.todos.push({ id: 'todo-a', title: 'A' });
  pageB.todos.push({ id: 'todo-b', title: 'B' });
  let successSignals = 0;
  coordinator.writeLegacyState(pageA, { writerSource: 'TODO_COMPLETE' });
  successSignals += 1;
  assert.throws(
    () => {
      coordinator.writeLegacyState(pageB, { writerSource: 'TODO_COMPLETE' });
      successSignals += 1;
    },
    (error) => error.code === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_STALE
  );
  assert.strictEqual(successSignals, 1);
  assert.deepStrictEqual(currentBundle(gateway).todos.map((item) => item.id), ['todo-a']);
  assert.strictEqual(readRecordStorageControl(currentBundle(gateway)).storageRevision, 1);
});

test('事务已提交后不因附加读取误报失败且已消费state不能覆盖后续状态', () => {
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: baseState()
  });
  gateway.setFailureSchedule([{
    id: 'forbid-post-commit-context-refresh',
    operation: 'GET',
    key: LEGACY_BUSINESS_STORAGE_KEY,
    occurrence: 7,
    effect: 'THROW_BEFORE',
    code: 'POST_COMMIT_READ_FAILED'
  }]);
  const state = coordinator.readState(() => baseState());
  state.todos.push({ id: 'committed-once', title: 'committed-once' });
  coordinator.writeLegacyState(state, { writerSource: 'TODO_COMPLETE' });
  const writeResult = coordinator.getLastLegacyWriteResult();
  assert.strictEqual(writeResult.legacyStatus, 'LEGACY_SAVE_COMMITTED');
  assert.strictEqual(readRecordStorageControl(currentBundle(gateway)).storageRevision, 1);
  assert.deepStrictEqual(currentBundle(gateway).todos.map((item) => item.id), ['committed-once']);

  gateway.clearFailureSchedule();
  const latest = coordinator.readState(() => baseState());
  latest.todos.push({ id: 'later', title: 'later' });
  coordinator.writeLegacyState(latest, { writerSource: 'TODO_COMPLETE' });
  assert.throws(
    () => coordinator.writeLegacyState(state, { writerSource: 'TODO_COMPLETE' }),
    (error) => error.code === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_STALE
  );
  assert.deepStrictEqual(
    currentBundle(gateway).todos.map((item) => item.id),
    ['committed-once', 'later']
  );
});

test('连续updateState重读最新Bundle、revision单调递增且失败后同步锁释放', () => {
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: baseState()
  });
  ['a', 'b', 'c'].forEach((id) => {
    coordinator.updateLegacyState(() => baseState(), (state) => {
      state.todos.push({ id, title: id });
      return state;
    }, { writerSource: 'ONBOARDING_META' });
  });
  assert.deepStrictEqual(currentBundle(gateway).todos.map((item) => item.id), ['a', 'b', 'c']);
  assert.strictEqual(readRecordStorageControl(currentBundle(gateway)).storageRevision, 3);
  assert.throws(
    () => coordinator.updateLegacyState(
      () => baseState(),
      () => { throw new Error('synthetic-mutator-failure'); },
      { writerSource: 'ONBOARDING_META' }
    ),
    /synthetic-mutator-failure/
  );
  coordinator.updateLegacyState(() => baseState(), (state) => {
    state.todos.push({ id: 'd', title: 'd' });
    return state;
  }, { writerSource: 'ONBOARDING_META' });
  assert.strictEqual(readRecordStorageControl(currentBundle(gateway)).storageRevision, 4);
});

test('容量不足在主Bundle写入前阻断并映射精确失败且旧Bundle完整', () => {
  const initial = baseState();
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: initial
  });
  const currentSize = gateway.getStorageInfoSync().currentSizeBytes;
  gateway.setCapacity(currentSize + 64, true);
  const state = coordinator.readState(() => baseState());
  state.pendingNotes.push({ id: 'large', originalText: 'x'.repeat(5000) });
  assert.throws(
    () => coordinator.writeLegacyState(state, { writerSource: 'INPUT_PENDING' }),
    (error) => error.code === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_CAPACITY_BLOCKED
  );
  assertBusinessEqual(currentBundle(gateway), initial, 'capacity retains base');
  assert.strictEqual(readRecordStorageControl(currentBundle(gateway)), null);
});

test('主Bundle读回损坏不会返回成功，协议恢复完整旧态且后续可继续写', () => {
  const initial = baseState();
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: initial
  });
  gateway.setFailureSchedule([{
    id: 'corrupt-primary',
    operation: 'SET',
    key: LEGACY_BUSINESS_STORAGE_KEY,
    occurrence: 1,
    effect: 'CORRUPT_VALUE',
    code: 'CORRUPT_PRIMARY'
  }]);
  const state = coordinator.readState(() => baseState());
  state.todos.push({ id: 'not-saved', title: 'not-saved' });
  assert.throws(
    () => coordinator.writeLegacyState(state, { writerSource: 'TODO_COMPLETE' }),
    (error) => error.code === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_READBACK_FAILED
  );
  assertBusinessEqual(currentBundle(gateway), initial, 'readback rollback');
  gateway.clearFailureSchedule();
  const retry = coordinator.readState(() => baseState());
  retry.todos.push({ id: 'saved', title: 'saved' });
  coordinator.writeLegacyState(retry, { writerSource: 'TODO_COMPLETE' });
  assert.deepStrictEqual(currentBundle(gateway).todos.map((item) => item.id), ['saved']);
});

test('恢复材料异常统一分类为RECOVERY_REQUIRED并记录停止事件', () => {
  const initial = baseState();
  const { gateway, monitor, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: initial
  });
  gateway.setFailureSchedule([{
    id: 'corrupt-backup-readback',
    operation: 'SET',
    key: RECORD_TRANSACTION_STORAGE_KEYS.backup,
    occurrence: 1,
    effect: 'CORRUPT_VALUE',
    code: 'CORRUPT_BACKUP'
  }]);
  const state = coordinator.readState(() => baseState());
  state.todos.push({ id: 'blocked', title: 'blocked' });
  assert.throws(
    () => coordinator.writeLegacyState(state, { writerSource: 'TODO_COMPLETE' }),
    (error) => error.code === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED
  );
  assert.strictEqual(coordinator.isRecoveryLocked(), true);
  assert(
    monitor.getEvents().some((event) => (
      event.type === 'LEGACY_WRITE_RECOVERY_REQUIRED'
      && event.status === 'LEGACY_SAVE_RECOVERY_REQUIRED'
    ))
  );
  assertBusinessEqual(currentBundle(gateway), initial, 'recovery-required keeps base');
});

test('启动恢复先于初始化：PREPARED保留旧态；矛盾材料进入Recovery Lock并阻断全部writer', () => {
  const initial = baseState();
  const gateway = createFakeStorageGateway({
    [LEGACY_BUSINESS_STORAGE_KEY]: clone(initial)
  });
  const preview = createPersistentRecordTransactionManager({
    gateway,
    mode: 'TRANSACTION_PREVIEW'
  });
  const target = baseState({ todos: [{ id: 'target', title: 'target' }] });
  assert.throws(
    () => preview.commitBundle({
      transactionId: 'startup-crash-tx',
      planId: 'startup-crash-plan',
      planHash: 'startup-crash-hash',
      idempotencyKey: 'startup-crash-idempotency',
      baseRevision: 0,
      baseFingerprint: getRecordStorageBusinessFingerprint(initial),
      targetBundle: target,
      committedAt: FIXED_NOW,
      writerSource: 'RELEASE_A_TEST',
      riskLevel: 'NORMAL'
    }, { crashAt: 'AFTER_JOURNAL_WRITE' }),
    (error) => error && error.simulatedCrash === true
  );
  const recovered = createLegacyReleaseARecordStorageCoordinator({
    gateway,
    clock: fixedClock()
  });
  const startup = recovered.startLegacyStorageInfrastructure(() => baseState());
  assert.strictEqual(startup.recovery.status, RECORD_STORAGE_RECOVERY_STATES.RECOVERED_ROLLED_BACK);
  assert.strictEqual(startup.initialized, false);
  assertBusinessEqual(currentBundle(gateway), initial, 'prepared startup retains old');

  const lockedGateway = createFakeStorageGateway({
    [LEGACY_BUSINESS_STORAGE_KEY]: clone(initial),
    [RECORD_TRANSACTION_STORAGE_KEYS.journal]: { corrupt: true },
    [RECORD_TRANSACTION_STORAGE_KEYS.backup]: { contradictory: true }
  });
  const locked = createLegacyReleaseARecordStorageCoordinator({
    gateway: lockedGateway,
    clock: fixedClock()
  });
  const lockedStartup = locked.startLegacyStorageInfrastructure(() => baseState());
  assert.strictEqual(lockedStartup.writeBlocked, true);
  assert.strictEqual(locked.isRecoveryLocked(), true);
  assert.throws(
    () => locked.updateLegacyState(() => baseState(), (state) => state, {
      writerSource: 'ONBOARDING_META'
    }),
    (error) => error.code === RECORD_STORAGE_LEGACY_SAVE_STATUSES.LEGACY_SAVE_RECOVERY_REQUIRED
  );
  assert.deepStrictEqual(lockedGateway.getEntries()[RECORD_TRANSACTION_STORAGE_KEYS.journal], { corrupt: true });
  assert.deepStrictEqual(lockedGateway.getEntries()[RECORD_TRANSACTION_STORAGE_KEYS.backup], { contradictory: true });
});

test('旧Bundle首次业务写入确定升级并保留未知meta、未知记录字段和业务语义', () => {
  const initial = baseState({
    meta: {
      onboarded: true,
      industry: '旧行业',
      userId: 'local-user',
      legacyMetaField: { keep: true }
    },
    customers: [{
      id: 'customer-old',
      name: '合成客户',
      legacyCustomerField: { keep: true }
    }],
    legacyTopLevel: { keep: true }
  });
  delete initial.productCatalog;
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: initial
  });
  const state = coordinator.readState(() => baseState());
  state.todos.push({ id: 'todo-upgrade', title: '升级后提醒' });
  coordinator.writeLegacyState(state, { writerSource: 'TODO_COMPLETE' });
  const persisted = currentBundle(gateway);
  assert.deepStrictEqual(persisted.meta.legacyMetaField, { keep: true });
  assert.deepStrictEqual(persisted.customers[0].legacyCustomerField, { keep: true });
  assert.deepStrictEqual(persisted.legacyTopLevel, { keep: true });
  assert.strictEqual(persisted.todos[0].id, 'todo-upgrade');
  assert.strictEqual(readRecordStorageControl(persisted).storageRevision, 1);
  assert(Object.prototype.hasOwnProperty.call(persisted, RECORD_STORAGE_CONTROL_KEY));
});

test('持久化receipt有界、未知meta保留且多次Legacy写入只增加基础设施字段', () => {
  const initial = baseState({ meta: { onboarded: true, unknownMeta: 'keep' } });
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: initial
  });
  for (let index = 0; index < 140; index += 1) {
    coordinator.updateLegacyState(() => baseState(), (state) => {
      state.meta.counter = index + 1;
      return state;
    }, {
      writerSource: 'ONBOARDING_META',
      planId: `bounded-plan-${index}`,
      transactionId: `bounded-tx-${index}`
    });
  }
  const persisted = currentBundle(gateway);
  const control = readRecordStorageControl(persisted);
  assert.strictEqual(control.storageRevision, 140);
  assert(control.recentReceipts.length <= 128);
  assert(control.receiptTombstones.length <= 512);
  assert.strictEqual(persisted.meta.unknownMeta, 'keep');
  assert.strictEqual(persisted.meta.counter, 140);
});

test('本地监测有界、脱敏、不持久化且监测异常不影响保存', () => {
  const monitor = createRecordStorageReleaseAMonitor({ clock: fixedClock(), maxEvents: 4 });
  const secrets = [
    '王老板',
    '13800138000',
    '礼品盒',
    '9999.50',
    '严格原文',
    'ALICE',
    'SECRET123'
  ];
  for (let index = 0; index < 8; index += 1) {
    monitor.record('LEGACY_WRITE_DECISION', {
      writerSource: index % 2 ? 'INPUT_FORMAL' : secrets.join('|'),
      status: index % 2 ? secrets[5] : secrets.join('|'),
      errorCode: index % 2 ? secrets[6] : secrets.join('|'),
      revision: index,
      originalText: secrets[4],
      customerName: secrets[0],
      phone: secrets[1],
      productName: secrets[2],
      amount: secrets[3]
    });
  }
  const serialized = JSON.stringify(monitor.getEvents());
  assert.strictEqual(monitor.getEvents().length, 4);
  secrets.forEach((secret) => assert.strictEqual(serialized.includes(secret), false, secret));
  monitor.getEvents().forEach((event) => {
    assert.strictEqual(event.status, 'UNKNOWN');
    assert.strictEqual(event.errorCode, 'UNCLASSIFIED_TECHNICAL_ERROR');
  });
  assert.strictEqual(monitor.getPolicy().remoteUploadEnabled, false);
  assert.strictEqual(monitor.getPolicy().persistenceEnabled, false);

  const throwingMonitor = { record() { throw new Error('monitor-failed'); } };
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: baseState()
  }, { monitor: throwingMonitor });
  const state = coordinator.readState(() => baseState());
  state.todos.push({ id: 'monitor-independent', title: 'monitor-independent' });
  coordinator.writeLegacyState(state, { writerSource: 'TODO_COMPLETE' });
  assert.strictEqual(currentBundle(gateway).todos[0].id, 'monitor-independent');
});

test('金融、转换和软删除整包副作用只提交一次且originalText和items不丢失', () => {
  const initial = baseState({
    customers: [{ id: 'cus-1', name: '合成客户' }],
    orders: [{
      id: 'ord-1',
      customerId: 'cus-1',
      status: '待生产',
      originalText: '严格订单原文',
      items: [
        { productName: '合成商品甲', quantity: '10' },
        { productName: '合成商品乙', quantity: '20' }
      ]
    }],
    receivables: [{
      id: 'rec-1',
      customerId: 'cus-1',
      orderId: 'ord-1',
      amount: '1000',
      paidAmount: '300',
      status: '部分收款',
      originalText: '严格待收原文'
    }],
    paymentRecords: [{
      id: 'pay-1',
      customerId: 'cus-1',
      orderId: 'ord-1',
      receivableId: 'rec-1',
      amount: '300',
      originalText: '严格收款原文'
    }]
  });
  const { gateway, coordinator } = releaseAHarness({
    [LEGACY_BUSINESS_STORAGE_KEY]: initial
  });
  const state = coordinator.readState(() => baseState());
  state.receivables[0].paidAmount = '1000';
  state.receivables[0].status = '已结清';
  state.paymentRecords.push({
    id: 'pay-2',
    customerId: 'cus-1',
    orderId: 'ord-1',
    receivableId: 'rec-1',
    amount: '700',
    originalText: '严格结清原文'
  });
  state.deletedRecords.push({ id: 'deleted-synthetic', recordType: 'todo' });
  coordinator.writeLegacyState(state, { writerSource: 'RECEIVABLE_PAYMENT' });
  const persisted = currentBundle(gateway);
  assert.strictEqual(readRecordStorageControl(persisted).storageRevision, 1);
  assert.strictEqual(persisted.receivables[0].status, '已结清');
  assert.strictEqual(persisted.paymentRecords.length, 2);
  assert.strictEqual(persisted.paymentRecords[1].originalText, '严格结清原文');
  assert.strictEqual(persisted.orders[0].items.length, 2);
  assert.strictEqual(persisted.orders[0].originalText, '严格订单原文');
  assert.strictEqual(persisted.deletedRecords.length, 1);
});

test('生产构建门禁排除runtime-test、页面不接入SavePlan且仓库无运行报告或业务快照', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.strictEqual(appJson.pages.some((page) => page.includes('runtime-test')), false);
  const projectConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
  assert((projectConfig.packOptions && projectConfig.packOptions.ignore || []).some(
    (entry) => entry.type === 'folder' && entry.value === 'runtime-test'
  ));
  ['pages/input/input.js', 'pages/dashboard/dashboard.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.strictEqual(source.includes('record-save-plan'), false);
    assert.strictEqual(source.includes('commitRecordSavePlan'), false);
    assert.strictEqual(source.includes('SHARED_COMMIT'), false);
  });
  const forbidden = [];
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(storage-snapshot|runtime-report|real-data)\.json$/i.test(entry.name)) {
      forbidden.push(path.relative(ROOT, full));
    }
  });
  walk(ROOT);
  assert.deepStrictEqual(forbidden, []);
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
  console.log(`Release A RC1: ${passed}/${tests.length} passed`);
}

if (require.main === module) main();

module.exports = { baseState, main, releaseAHarness };
