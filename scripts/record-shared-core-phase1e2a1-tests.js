#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LEGACY_BUSINESS_STORAGE_KEY,
  STORAGE_MIGRATION_MODES
} = require('../utils/record-storage-adapter-contract');
const {
  createFakeStorageGateway,
  createLegacyStorageAdapter,
  createWxStorageGateway
} = require('../utils/record-storage-adapters');
const { createRecordStorageCoordinator } = require('../utils/record-storage-coordinator');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_CONTROL_KEY,
  RECORD_STORAGE_JOURNAL_KEY,
  RECORD_STORAGE_RECEIPT_POLICY,
  RECORD_STORAGE_RECOVERY_STATES,
  RECORD_STORAGE_TRANSACTION_CHECKPOINTS,
  RECORD_STORAGE_TRANSACTION_ERRORS,
  RECORD_STORAGE_TRANSACTION_STATES
} = require('../utils/record-storage-transaction-contract');
const {
  createPersistentRecordTransactionManager,
  strictClone
} = require('../utils/record-storage-transaction');
const {
  getRecordStorageBusinessFingerprint,
  projectLegacyStorageEntries,
  readRecordStorageControl,
  stripRecordStorageControl
} = require('../utils/record-storage-state-projector');
const {
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES,
  compareRecordSaveShadowStates
} = require('../utils/record-save-shadow');
const { safeClone, stableSerialize } = require('../utils/record-state-diff');
const {
  canonicalState,
  runLegacyEquivalenceWithVisitor,
  stateWith
} = require('./record-shared-core-phase1e1-tests');

delete global.wx;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function oldBundle(overrides = {}) {
  return Object.assign({
    meta: { onboarded: true, industry: '合成行业', userId: 'local-user', createdAt: '2026-07-01T00:00:00.000Z' },
    customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [], dunningRecords: [],
    todos: [], orderProgress: [], pendingNotes: [], aiParseLogs: [], dunningTemplates: [],
    legacyTopLevel: { preserved: true }
  }, clone(overrides));
}

function targetFrom(base, suffix = '1') {
  const target = stripRecordStorageControl(base);
  target.orders = (target.orders || []).concat([{
    id: `order-${suffix}`,
    customerId: `customer-${suffix}`,
    productName: '合成礼品盒',
    items: [
      { productName: '合成礼品盒', quantity: '100', unit: '个' },
      { productName: '合成杯垫', quantity: '200', unit: '个' }
    ],
    originalText: `严格原文-${suffix}`
  }]);
  return target;
}

function transactionInput(base, target, suffix = '1', overrides = {}) {
  return Object.assign({
    transactionId: `transaction-${suffix}`,
    planId: `plan-${suffix}`,
    planHash: `plan-hash-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    baseRevision: readRecordStorageControl(base)
      ? readRecordStorageControl(base).storageRevision
      : 0,
    baseFingerprint: getRecordStorageBusinessFingerprint(base),
    targetBundle: stripRecordStorageControl(target),
    committedAt: '2026-07-23T00:00:00.000Z',
    writerSource: 'PHASE_1E2A1_TEST',
    riskLevel: 'NORMAL'
  }, overrides);
}

function createPair(base, options = {}) {
  const gateway = createFakeStorageGateway({
    [LEGACY_BUSINESS_STORAGE_KEY]: clone(base)
  }, options);
  const manager = createPersistentRecordTransactionManager({
    gateway,
    mode: 'TRANSACTION_PREVIEW'
  });
  return { gateway, manager };
}

function currentBundle(gateway) {
  return gateway.getEntries()[LEGACY_BUSINESS_STORAGE_KEY];
}

function assertBusinessState(actual, expected, message) {
  assert.strictEqual(
    stableSerialize(stripRecordStorageControl(actual)),
    stableSerialize(stripRecordStorageControl(expected)),
    message
  );
}

test('23个Legacy Writer和app初始化全部经过统一存储门面且没有业务key字面量写入旁路', () => {
  const root = path.resolve(__dirname, '..');
  assert.strictEqual(LEGACY_BUSINESS_BUNDLE_WRITE_SITES.length, 23);
  const expectedApp = LEGACY_BUSINESS_BUNDLE_WRITE_SITES.find((item) => item.sourceFile === 'app.js');
  assert.deepStrictEqual(expectedApp, {
    sourceFile: 'app.js', callKind: 'prepareRecordStorageInfrastructure', occurrence: 1,
    lifecycleIds: ['app-launch-initialize'], writerSource: 'APP_LAUNCH_INITIALIZE'
  });
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES.forEach((site) => {
    const source = fs.readFileSync(path.join(root, site.sourceFile), 'utf8');
    assert(source.includes(`${site.callKind}(`), `${site.sourceFile}:${site.callKind}`);
    const storageImportPattern = site.sourceFile === 'app.js'
      ? /require\(['"]\.\/utils\/storage['"]\)/
      : /require\(['"]\.\.\/\.\.\/utils\/storage['"]\)/;
    assert(storageImportPattern.test(source), `${site.sourceFile}:storage import source`);
  });
  const sourceFiles = ['app.js'];
  ['pages', 'utils', 'server'].forEach((directory) => {
    function walk(current) {
      fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) sourceFiles.push(path.relative(root, full));
      });
    }
    walk(path.join(root, directory));
  });
  const directLiteralWrites = sourceFiles.filter((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return /setStorage(?:Sync)?\(\s*['"]yiwu_boss_ai_assistant_v1['"]/.test(source);
  });
  assert.deepStrictEqual(directLiteralWrites, []);
  const infrastructureWriteAllowlist = new Set([
    'utils/record-storage-coordinator.js',
    'utils/record-storage-gateways.js',
    'utils/record-storage-runtime-test-gateway.js',
    'utils/record-storage-transaction.js',
    'utils/record-storage-wx-runtime-harness.js'
  ]);
  const nonBusinessWriteAllowlist = new Set([
    'pages/dashboard/dashboard.js',
    'pages/orders/orders.js',
    'pages/pending/pending.js',
    'pages/record-detail/record-detail.js',
    'utils/api-client.js'
  ]);
  const unexpectedRawWriters = sourceFiles.filter((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (!/\.setStorage(?:Sync)?\(/.test(source)) return false;
    return !infrastructureWriteAllowlist.has(file) && !nonBusinessWriteAllowlist.has(file);
  });
  assert.deepStrictEqual(unexpectedRawWriters, []);
  nonBusinessWriteAllowlist.forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.strictEqual(source.includes('yiwu_boss_ai_assistant_v1'), false, `${file}:business key bypass`);
    assert.strictEqual(source.includes('LEGACY_BUSINESS_STORAGE_KEY'), false, `${file}:business constant bypass`);
  });
  const rootStorage = fs.readFileSync(path.join(root, 'utils/storage.js'), 'utf8');
  const serverStorage = fs.readFileSync(path.join(root, 'server/utils/storage.js'), 'utf8');
  assert(rootStorage.includes('createLegacyReleaseARecordStorageCoordinator'));
  assert(serverStorage.includes('getRootStorageFacade'));
  assert(serverStorage.includes("require('../../utils/storage')"));
  assert.strictEqual(rootStorage.includes('.setStorageSync('), false);
  assert.strictEqual(serverStorage.includes('.setStorageSync('), false);
  const gatewayExports = require('../utils/record-storage-gateways');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(gatewayExports, 'registerGateway'), false);
});

test('LEGACY_ONLY保持单bundle旧数据语义并阻断stale覆盖，事务模式不能伪造或在生产gateway启用', () => {
  const base = oldBundle();
  const fake = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: clone(base) });
  const coordinator = createRecordStorageCoordinator({ gateway: fake, mode: 'LEGACY_ONLY' });
  const state = coordinator.readState(() => oldBundle());
  state.meta.industry = '新合成行业';
  const returned = coordinator.writeLegacyState(state, { writerSource: 'TEST_LEGACY' });
  assert.strictEqual(returned, state);
  assert.strictEqual(fake.getStats().writes, 1);
  assert.strictEqual(currentBundle(fake).meta.industry, '新合成行业');
  const staleFirst = coordinator.readState(() => oldBundle());
  const staleSecond = coordinator.readState(() => oldBundle());
  staleFirst.meta.industry = 'Writer A';
  coordinator.writeLegacyState(staleFirst, { writerSource: 'WRITER_A' });
  staleSecond.meta.industry = 'Writer B';
  assert.throws(
    () => coordinator.writeLegacyState(staleSecond, { writerSource: 'WRITER_B' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_STALE
  );
  assert.strictEqual(currentBundle(fake).meta.industry, 'Writer A');
  assert.throws(
    () => coordinator.writeLegacyState(oldBundle(), { writerSource: 'UNSIGNED_STATE' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_STATE_CONTEXT_REQUIRED
  );
  assert.strictEqual(coordinator.getIdentity().sharedProductionCommitEnabled, false);
  assert.throws(
    () => coordinator.commitTransaction({}),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED
  );
  assert.throws(
    () => createRecordStorageCoordinator({ gateway: fake, mode: 'SHARED_COMMIT' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.SHARED_PRODUCTION_COMMIT_DISABLED
  );
  assert.throws(
    () => createPersistentRecordTransactionManager({ gateway: {}, mode: 'TRANSACTION_PREVIEW' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_TRANSACTION_MODE_FORBIDDEN
  );
  assert.throws(
    () => createWxStorageGateway({}),
    (error) => error.code === 'STORAGE_GATEWAY_INVALID'
  );
});

test('空Storage首次与重复初始化保留兼容字段和非业务key，事务控制信封不泄漏给Legacy页面且不能被覆盖', () => {
  const emptyGateway = createFakeStorageGateway({
    draft_to_input: { text: '合成页面交接内容' }
  });
  const emptyCoordinator = createRecordStorageCoordinator({ gateway: emptyGateway, mode: 'LEGACY_ONLY' });
  const initialized = emptyCoordinator.initializeLegacyState(() => oldBundle(), { writerSource: 'APP_LAUNCH_INITIALIZE' });
  assert.strictEqual(initialized.meta.industry, '合成行业');
  assert.strictEqual(emptyGateway.getStats().reads, 2);
  assert.strictEqual(emptyGateway.getStats().writes, 1);
  const compatibleBundle = currentBundle(emptyGateway);
  compatibleBundle.futureField = { keep: true };
  emptyGateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, compatibleBundle);
  emptyCoordinator.initializeLegacyState(() => oldBundle(), { writerSource: 'APP_LAUNCH_INITIALIZE_AGAIN' });
  assert.deepStrictEqual(currentBundle(emptyGateway).futureField, { keep: true });
  assert.deepStrictEqual(emptyGateway.getEntries().draft_to_input, { text: '合成页面交接内容' });

  const base = oldBundle();
  const transactionPair = createPair(base);
  const target = targetFrom(base, 'control-boundary');
  assert.strictEqual(
    transactionPair.manager.commitBundle(transactionInput(base, target, 'control-boundary')).commitSucceeded,
    true
  );
  const legacy = createRecordStorageCoordinator({ gateway: transactionPair.gateway, mode: 'LEGACY_ONLY' });
  const pageState = legacy.readState(() => oldBundle());
  assert.strictEqual(pageState[RECORD_STORAGE_CONTROL_KEY], undefined);
  pageState.meta.industry = '不得覆盖事务控制';
  assert.throws(
    () => legacy.writeLegacyState(pageState, { writerSource: 'STALE_LEGACY_PAGE' }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.LEGACY_WRITER_STALE
  );
  assert.strictEqual(readRecordStorageControl(currentBundle(transactionPair.gateway)).storageRevision, 1);
  assert.strictEqual(currentBundle(transactionPair.gateway).meta.industry, '合成行业');
});

test('旧Bundle无revision可确定迁移且保留meta、记录和顶层未知兼容字段', () => {
  const base = oldBundle({
    meta: { onboarded: true, unknownMeta: 'keep-meta' },
    customers: [{ id: 'customer-old', name: '合成客户', unknownCustomer: 'keep-customer' }],
    optionalLegacyShape: { nested: { keep: true } }
  });
  delete base.operationLogs;
  delete base.productCatalog;
  const snapshot = projectLegacyStorageEntries({ [LEGACY_BUSINESS_STORAGE_KEY]: base });
  assert.strictEqual(snapshot.persistentRevision, 0);
  assert.strictEqual(snapshot.persistentRevisionResolved, false);
  assert.strictEqual(snapshot.storageStateVersion, 1);
  assert.strictEqual(snapshot.domainState[RECORD_STORAGE_CONTROL_KEY], undefined);
  const target = clone(base);
  target.todos = [{ id: 'todo-1', title: '合成提醒', originalText: '严格原文' }];
  const { gateway, manager } = createPair(base);
  const result = manager.commitBundle(transactionInput(base, target, 'compat'));
  assert.strictEqual(result.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED);
  const stored = currentBundle(gateway);
  const control = readRecordStorageControl(stored);
  assert.strictEqual(control.storageRevision, 1);
  assert.strictEqual(stored.meta.unknownMeta, 'keep-meta');
  assert.strictEqual(stored.customers[0].unknownCustomer, 'keep-customer');
  assert.deepStrictEqual(stored.optionalLegacyShape, { nested: { keep: true } });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'operationLogs'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'productCatalog'), false);
  assert.throws(
    () => projectLegacyStorageEntries({
      [LEGACY_BUSINESS_STORAGE_KEY]: Object.assign({}, base, { [RECORD_STORAGE_CONTROL_KEY]: 'legacy-collision' })
    }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CONTROL_NAMESPACE_COLLISION
  );
});

test('成功事务执行backup、PREPARED journal、CAS、主Bundle读回和清理并持久化最小receipt', () => {
  const base = oldBundle();
  const target = targetFrom(base, 'success');
  const { gateway, manager } = createPair(base);
  const result = manager.commitBundle(transactionInput(base, target, 'success'));
  assert.strictEqual(result.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED);
  assert.strictEqual(result.commitSucceeded, true);
  assert.strictEqual(result.baseRevision, 0);
  assert.strictEqual(result.targetRevision, 1);
  assertBusinessState(currentBundle(gateway), target, 'successful target');
  const entries = gateway.getEntries();
  assert.strictEqual(entries[RECORD_STORAGE_BACKUP_KEY], undefined);
  assert.strictEqual(entries[RECORD_STORAGE_JOURNAL_KEY], undefined);
  const control = readRecordStorageControl(entries[LEGACY_BUSINESS_STORAGE_KEY]);
  assert.strictEqual(control.lastCommittedPlanId, 'plan-success');
  assert.strictEqual(control.lastCommittedPlanHash, 'plan-hash-success');
  assert.strictEqual(control.lastCommittedStateFingerprint, getRecordStorageBusinessFingerprint(target));
  assert.strictEqual(JSON.stringify(control).includes('严格原文'), false);
  assert.strictEqual(JSON.stringify(control).includes('合成客户'), false);
  assert.strictEqual(gateway.getStats().writes, 4);
  assert.strictEqual(gateway.getStats().removals, 2);
});

test('CAS阻止stale writer，持久化receipt跨重启幂等且planId碰撞失败', () => {
  const base = oldBundle();
  const firstTarget = targetFrom(base, 'first');
  const { gateway, manager } = createPair(base);
  const firstInput = transactionInput(base, firstTarget, 'same');
  const first = manager.commitBundle(firstInput);
  assert.strictEqual(first.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED);
  const staleTarget = targetFrom(base, 'stale');
  const stale = manager.commitBundle(transactionInput(base, staleTarget, 'stale', {
    baseRevision: 0,
    baseFingerprint: getRecordStorageBusinessFingerprint(base)
  }));
  assert.strictEqual(stale.status, RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT);
  assertBusinessState(currentBundle(gateway), firstTarget, 'stale writer must not overwrite');

  const restartedGateway = createFakeStorageGateway(gateway.getEntries());
  const restarted = createPersistentRecordTransactionManager({ gateway: restartedGateway, mode: 'TRANSACTION_PREVIEW' });
  const replay = restarted.commitBundle(firstInput);
  assert.strictEqual(replay.status, RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED);
  assert.strictEqual(replay.idempotentReplay, true);
  assert.strictEqual(restartedGateway.getStats().writes, 0);
  const collision = restarted.commitBundle(Object.assign({}, firstInput, { planHash: 'different-hash' }));
  assert.strictEqual(collision.status, RECORD_STORAGE_TRANSACTION_STATES.FAILED);
  assert.strictEqual(collision.errors[0].code, RECORD_STORAGE_TRANSACTION_ERRORS.SAVE_PLAN_ID_COLLISION);
  assert.strictEqual(restartedGateway.getStats().writes, 0);
});

test('CAS窗口发现外部新Bundle时只清理自己的事务材料且绝不恢复Backup覆盖外部状态', () => {
  const base = oldBundle({ casWindow: 'base' });
  const target = targetFrom(base, 'cas-window');
  const external = oldBundle({ casWindow: 'external-writer', externalOnly: { keep: true } });
  const { gateway, manager } = createPair(base);
  const result = manager.commitBundle(transactionInput(base, target, 'cas-window'), {
    onCheckpoint(name) {
      if (name === 'AFTER_JOURNAL_WRITE') {
        gateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, external);
      }
    }
  });
  assert.strictEqual(result.status, RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT);
  assert.strictEqual(result.commitSucceeded, false);
  assert.deepStrictEqual(currentBundle(gateway), external);
  assert.strictEqual(gateway.getEntries()[RECORD_STORAGE_JOURNAL_KEY], undefined);
  assert.strictEqual(gateway.getEntries()[RECORD_STORAGE_BACKUP_KEY], undefined);
});

test('CAS通过后主写前出现合法外部Bundle时最终CAS阻断；若同时崩溃则恢复保留外部态和材料', () => {
  const base = oldBundle({ finalCasWindow: 'base' });
  const target = targetFrom(base, 'final-cas-window');
  const external = oldBundle({ finalCasWindow: 'external', todos: [{ id: 'external-must-survive' }] });

  const withoutCrash = createPair(base);
  const stale = withoutCrash.manager.commitBundle(transactionInput(base, target, 'final-cas-stale'), {
    onCheckpoint(name) {
      if (name === 'BEFORE_MAIN_WRITE') {
        withoutCrash.gateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, external);
      }
    }
  });
  assert.strictEqual(stale.status, RECORD_STORAGE_TRANSACTION_STATES.STALE_STORAGE_SNAPSHOT);
  assert.deepStrictEqual(currentBundle(withoutCrash.gateway), external);
  assert.strictEqual(withoutCrash.gateway.getEntries()[RECORD_STORAGE_JOURNAL_KEY], undefined);
  assert.strictEqual(withoutCrash.gateway.getEntries()[RECORD_STORAGE_BACKUP_KEY], undefined);

  const withCrash = createPair(base);
  assert.throws(
    () => withCrash.manager.commitBundle(transactionInput(base, target, 'final-cas-crash'), {
      crashAt: 'BEFORE_MAIN_WRITE',
      onCheckpoint(name) {
        if (name === 'BEFORE_MAIN_WRITE') {
          withCrash.gateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, external);
        }
      }
    }),
    (error) => error.code === 'SIMULATED_PROCESS_CRASH'
  );
  const restartedGateway = createFakeStorageGateway(withCrash.gateway.getEntries());
  const restarted = createPersistentRecordTransactionManager({ gateway: restartedGateway, mode: 'TRANSACTION_PREVIEW' });
  const recovery = restarted.recover();
  assert.strictEqual(recovery.status, RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED);
  assert.strictEqual(recovery.writeBlocked, true);
  assert.deepStrictEqual(currentBundle(restartedGateway), external);
  assert(restartedGateway.getEntries()[RECORD_STORAGE_JOURNAL_KEY]);
  assert(restartedGateway.getEntries()[RECORD_STORAGE_BACKUP_KEY]);
  const second = restarted.recover();
  assert.strictEqual(second.writeBlocked, true);
  assert.deepStrictEqual(currentBundle(restartedGateway), external);
});

test('同planHash或幂等键不能绑定不同目标，严格序列化拒绝隐藏字段与稀疏数据', () => {
  const base = oldBundle();
  const firstTarget = targetFrom(base, 'identity-first');
  const { gateway, manager } = createPair(base);
  const firstInput = transactionInput(base, firstTarget, 'identity-first');
  assert.strictEqual(manager.commitBundle(firstInput).commitSucceeded, true);
  const current = currentBundle(gateway);
  const conflictingTarget = targetFrom(current, 'identity-conflict');
  const collision = manager.commitBundle(transactionInput(current, conflictingTarget, 'identity-second', {
    planHash: firstInput.planHash,
    idempotencyKey: 'different-idempotency'
  }));
  assert.strictEqual(collision.status, RECORD_STORAGE_TRANSACTION_STATES.FAILED);
  assert.strictEqual(collision.errors[0].code, RECORD_STORAGE_TRANSACTION_ERRORS.SAVE_PLAN_ID_COLLISION);

  const hidden = { visible: true };
  Object.defineProperty(hidden, 'secret', { value: 'hidden', enumerable: false });
  assert.throws(() => strictClone(hidden), (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID);
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'value';
  assert.throws(() => strictClone(sparse), (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID);
  assert.throws(
    () => strictClone({ value: Symbol('hidden') }),
    (error) => error.code === RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_SERIALIZATION_INVALID
  );
});

test('事务队列让连续writer执行前读取最新revision并稳定保留全部合法变化', async () => {
  const base = oldBundle();
  const gateway = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: base });
  const coordinator = createRecordStorageCoordinator({ gateway, mode: 'TRANSACTION_PREVIEW' });
  const build = (suffix) => (snapshot) => {
    const target = stripRecordStorageControl(snapshot.bundle);
    target.todos = (target.todos || []).concat([{ id: `todo-${suffix}`, title: `任务-${suffix}` }]);
    return transactionInput(snapshot.bundle, target, suffix, {
      baseRevision: snapshot.revision,
      baseFingerprint: snapshot.businessFingerprint
    });
  };
  const [first, second, third] = await Promise.all([
    coordinator.enqueueTransaction(build('queue-1')),
    coordinator.enqueueTransaction(build('queue-2')),
    coordinator.enqueueTransaction(build('queue-3'))
  ]);
  [first, second, third].forEach((result) => assert.strictEqual(result.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED));
  const stored = currentBundle(gateway);
  assert.deepStrictEqual(stored.todos.map((item) => item.id), ['todo-queue-1', 'todo-queue-2', 'todo-queue-3']);
  assert.strictEqual(readRecordStorageControl(stored).storageRevision, 3);
});

test('同一计划并发重复点击只提交一次，后续等待者取得同一持久化receipt', async () => {
  const base = oldBundle();
  const target = targetFrom(base, 'duplicate-click');
  const input = transactionInput(base, target, 'duplicate-click');
  const gateway = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: base });
  const coordinator = createRecordStorageCoordinator({ gateway, mode: 'TRANSACTION_PREVIEW' });
  const [first, second] = await Promise.all([
    coordinator.enqueueTransaction(input),
    coordinator.enqueueTransaction(input)
  ]);
  assert.strictEqual(first.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED);
  assert.strictEqual(second.status, RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED);
  assert.strictEqual(second.idempotentReplay, true);
  assert.strictEqual(first.receipt.transactionId, second.receipt.transactionId);
  assert.strictEqual(currentBundle(gateway).orders.length, 1);
  assert.strictEqual(readRecordStorageControl(currentBundle(gateway)).storageRevision, 1);
});

test('11个进程崩溃点重启恢复后只能得到完整旧态或完整新态且恢复可重复', () => {
  const oldExpected = new Set([
    'BEFORE_RECEIPT_PREPARE', 'BEFORE_BACKUP_WRITE', 'AFTER_BACKUP_WRITE',
    'BEFORE_JOURNAL_WRITE', 'AFTER_JOURNAL_WRITE', 'BEFORE_MAIN_WRITE'
  ]);
  const checkpoints = Object.values(RECORD_STORAGE_TRANSACTION_CHECKPOINTS);
  assert.strictEqual(checkpoints.length, 11);
  checkpoints.forEach((checkpoint) => {
    const base = oldBundle({ legacyCrashCase: checkpoint });
    const target = targetFrom(base, checkpoint);
    const { gateway, manager } = createPair(base);
    assert.throws(
      () => manager.commitBundle(transactionInput(base, target, checkpoint), { crashAt: checkpoint }),
      (error) => error.code === 'SIMULATED_PROCESS_CRASH'
    );
    const restartedGateway = createFakeStorageGateway(gateway.getEntries());
    const restarted = createPersistentRecordTransactionManager({ gateway: restartedGateway, mode: 'TRANSACTION_PREVIEW' });
    const recovered = restarted.recover();
    assert.strictEqual(recovered.writeBlocked, false, `${checkpoint}:${JSON.stringify(recovered)}`);
    const expected = oldExpected.has(checkpoint) ? base : target;
    assertBusinessState(currentBundle(restartedGateway), expected, checkpoint);
    const control = readRecordStorageControl(currentBundle(restartedGateway));
    if (oldExpected.has(checkpoint)) assert.strictEqual(control, null, checkpoint);
    else {
      assert.strictEqual(control.storageRevision, 1, checkpoint);
      assert.strictEqual(control.lastCommittedPlanId, `plan-${checkpoint}`, checkpoint);
    }
    const entries = restartedGateway.getEntries();
    assert.strictEqual(entries[RECORD_STORAGE_JOURNAL_KEY], undefined, checkpoint);
    assert.strictEqual(entries[RECORD_STORAGE_BACKUP_KEY], undefined, checkpoint);
    const secondRecovery = restarted.recover();
    assert.strictEqual(secondRecovery.status, RECORD_STORAGE_RECOVERY_STATES.CLEAN, checkpoint);
    assertBusinessState(currentBundle(restartedGateway), expected, `${checkpoint}:second recovery`);
  });
});

test('Fake Gateway写错、截断、静默失败和清理失败均恢复到完整状态', () => {
  const cases = [
    ['backup-throw', 'SET', RECORD_STORAGE_BACKUP_KEY, 'THROW_BEFORE', false],
    ['backup-noop', 'SET', RECORD_STORAGE_BACKUP_KEY, 'SILENT_NOOP', false],
    ['backup-readback-corrupt', 'GET', RECORD_STORAGE_BACKUP_KEY, 'RETURN_CORRUPT', false, 2],
    ['journal-throw', 'SET', RECORD_STORAGE_JOURNAL_KEY, 'THROW_BEFORE', false],
    ['journal-noop', 'SET', RECORD_STORAGE_JOURNAL_KEY, 'SILENT_NOOP', false],
    ['journal-readback-corrupt', 'GET', RECORD_STORAGE_JOURNAL_KEY, 'RETURN_CORRUPT', false, 2],
    ['journal-start-throw', 'SET', RECORD_STORAGE_JOURNAL_KEY, 'THROW_BEFORE', false, 2],
    ['journal-start-noop', 'SET', RECORD_STORAGE_JOURNAL_KEY, 'SILENT_NOOP', false, 2],
    ['main-throw', 'SET', LEGACY_BUSINESS_STORAGE_KEY, 'THROW_BEFORE', false],
    ['main-noop', 'SET', LEGACY_BUSINESS_STORAGE_KEY, 'SILENT_NOOP', false],
    ['main-corrupt', 'SET', LEGACY_BUSINESS_STORAGE_KEY, 'CORRUPT_VALUE', false],
    ['main-truncate', 'SET', LEGACY_BUSINESS_STORAGE_KEY, 'TRUNCATE_VALUE', false],
    ['main-applied-throw', 'SET', LEGACY_BUSINESS_STORAGE_KEY, 'APPLY_THEN_THROW', true],
    ['main-readback-corrupt', 'GET', LEGACY_BUSINESS_STORAGE_KEY, 'RETURN_CORRUPT', true, 5],
    ['journal-remove-noop', 'REMOVE', RECORD_STORAGE_JOURNAL_KEY, 'SILENT_NOOP', true],
    ['backup-remove-throw', 'REMOVE', RECORD_STORAGE_BACKUP_KEY, 'THROW_BEFORE', true]
  ];
  cases.forEach(([name, operation, key, effect, commits, occurrence = 1]) => {
    const base = oldBundle({ faultCase: name });
    const target = targetFrom(base, name);
    const pair = createPair(base, {
      failureSchedule: [{ operation, key, occurrence, effect, code: `FAULT_${name}` }]
    });
    const result = pair.manager.commitBundle(transactionInput(base, target, name));
    assert.strictEqual(result.commitSucceeded, commits, `${name}:${JSON.stringify(result)}`);
    assertBusinessState(currentBundle(pair.gateway), commits ? target : base, name);
    const restarted = createPersistentRecordTransactionManager({
      gateway: createFakeStorageGateway(pair.gateway.getEntries()),
      mode: 'TRANSACTION_PREVIEW'
    });
    assert.strictEqual(restarted.recover().writeBlocked, false, name);
  });
});

test('恢复读取失败或主Bundle、Backup、Journal矛盾时安全阻断并保留材料', () => {
  const base = oldBundle({ recoveryCase: 'read-failure' });
  const target = targetFrom(base, 'read-failure');
  const prepared = createPair(base);
  assert.throws(
    () => prepared.manager.commitBundle(transactionInput(base, target, 'read-failure'), {
      crashAt: 'AFTER_JOURNAL_WRITE'
    }),
    (error) => error.code === 'SIMULATED_PROCESS_CRASH'
  );
  const entries = prepared.gateway.getEntries();
  const readFailureGateway = createFakeStorageGateway(entries, {
    failureSchedule: [{
      operation: 'GET', key: RECORD_STORAGE_JOURNAL_KEY, occurrence: 1,
      effect: 'THROW_BEFORE', code: 'FAULT_RECOVERY_READ'
    }]
  });
  const readFailureManager = createPersistentRecordTransactionManager({
    gateway: readFailureGateway, mode: 'TRANSACTION_PREVIEW'
  });
  const readFailure = readFailureManager.recover();
  assert.strictEqual(readFailure.status, RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED);
  assert.strictEqual(readFailure.writeBlocked, true);
  assert(readFailureGateway.getEntries()[RECORD_STORAGE_JOURNAL_KEY]);
  assert(readFailureGateway.getEntries()[RECORD_STORAGE_BACKUP_KEY]);

  const contradictory = clone(entries);
  contradictory[LEGACY_BUSINESS_STORAGE_KEY] = { corruptMain: true };
  contradictory[RECORD_STORAGE_BACKUP_KEY].bundle = { corruptBackup: true };
  const contradictionGateway = createFakeStorageGateway(contradictory);
  const contradictionManager = createPersistentRecordTransactionManager({
    gateway: contradictionGateway, mode: 'TRANSACTION_PREVIEW'
  });
  const recovery = contradictionManager.recover();
  assert.strictEqual(recovery.status, RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED);
  assert.strictEqual(recovery.writeBlocked, true);
  assert.deepStrictEqual(contradictionGateway.getEntries(), contradictory);
});

test('无Journal残留Backup只接受精确旧态或精确目标态，业务被篡改时安全阻断', () => {
  const base = oldBundle({ orphanBackup: 'base' });
  const target = targetFrom(base, 'orphan-backup');
  const prepared = createPair(base);
  assert.throws(
    () => prepared.manager.commitBundle(transactionInput(base, target, 'orphan-backup'), {
      crashAt: 'BEFORE_BACKUP_CLEANUP'
    }),
    (error) => error.code === 'SIMULATED_PROCESS_CRASH'
  );
  const tampered = currentBundle(prepared.gateway);
  tampered.orders[0].productName = '被外部篡改的商品';
  prepared.gateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, tampered);
  const restarted = createPersistentRecordTransactionManager({
    gateway: createFakeStorageGateway(prepared.gateway.getEntries()),
    mode: 'TRANSACTION_PREVIEW'
  });
  const recovery = restarted.recover();
  assert.strictEqual(recovery.status, RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED);
  assert.strictEqual(recovery.writeBlocked, true);
});

test('干净拓扑中的非对象主Bundle和损坏控制receipt不会被误判为可写状态', () => {
  ['corrupt', 42, ['array']].forEach((invalid, index) => {
    const gateway = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: invalid });
    const manager = createPersistentRecordTransactionManager({ gateway, mode: 'TRANSACTION_PREVIEW' });
    const recovery = manager.recover();
    assert.strictEqual(recovery.status, RECORD_STORAGE_RECOVERY_STATES.RECOVERY_REQUIRED, String(index));
    assert.strictEqual(recovery.writeBlocked, true, String(index));
  });
  const malformed = oldBundle({
    [RECORD_STORAGE_CONTROL_KEY]: {
      schemaVersion: 'record-storage-control-v1',
      storageSchemaVersion: 1,
      storageRevision: 1,
      recentReceipts: [{ planId: 'missing-contract' }],
      receiptTombstones: []
    }
  });
  const gateway = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: malformed });
  const manager = createPersistentRecordTransactionManager({ gateway, mode: 'TRANSACTION_PREVIEW' });
  assert.strictEqual(manager.recover().writeBlocked, true);

  const base = oldBundle();
  const target = targetFrom(base, 'clean-integrity');
  const committed = createPair(base);
  assert.strictEqual(committed.manager.commitBundle(transactionInput(base, target, 'clean-integrity')).commitSucceeded, true);
  const changedBusiness = currentBundle(committed.gateway);
  changedBusiness.todos = [{ id: 'silent-corruption' }];
  committed.gateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, changedBusiness);
  assert.strictEqual(committed.manager.recover().writeBlocked, true);

  const ledgerPair = createPair(base);
  assert.strictEqual(ledgerPair.manager.commitBundle(transactionInput(base, target, 'ledger-integrity')).commitSucceeded, true);
  const changedLedger = currentBundle(ledgerPair.gateway);
  changedLedger[RECORD_STORAGE_CONTROL_KEY].lastCommittedPlanId = 'other-valid-plan';
  ledgerPair.gateway.mutateEntry(LEGACY_BUSINESS_STORAGE_KEY, changedLedger);
  assert.strictEqual(ledgerPair.manager.recover().writeBlocked, true);
});

test('Fake Gateway身份对象冻结且微信缺key返回空字符串时仍按不存在处理', () => {
  const fake = createFakeStorageGateway({});
  assert.strictEqual(Object.isFrozen(fake), true);
  const originalSet = fake.setStorageSync;
  fake.setStorageSync = () => { throw new Error('redirected'); };
  assert.strictEqual(fake.setStorageSync, originalSet);

  const wxLikeEmpty = createFakeStorageGateway({}, { absentValue: '' });
  const manager = createPersistentRecordTransactionManager({ gateway: wxLikeEmpty, mode: 'TRANSACTION_PREVIEW' });
  assert.strictEqual(manager.recover().status, RECORD_STORAGE_RECOVERY_STATES.CLEAN);
  const base = {};
  const target = oldBundle({ migratedFromEmpty: true });
  const result = manager.commitBundle(transactionInput(base, target, 'wx-empty'));
  assert.strictEqual(result.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED);
  assertBusinessState(currentBundle(wxLikeEmpty), target, 'wx empty migration');
});

test('Journal清理持续失败时保留Backup并阻断后续写入，故障解除后恢复为完整新态', () => {
  const base = oldBundle({ cleanupCase: 'persistent-journal' });
  const target = targetFrom(base, 'persistent-journal');
  const { gateway, manager } = createPair(base, {
    failureSchedule: [
      { operation: 'REMOVE', key: RECORD_STORAGE_JOURNAL_KEY, occurrence: 1, effect: 'SILENT_NOOP' },
      { operation: 'REMOVE', key: RECORD_STORAGE_JOURNAL_KEY, occurrence: 2, effect: 'SILENT_NOOP' }
    ]
  });
  const result = manager.commitBundle(transactionInput(base, target, 'persistent-journal'));
  assert.strictEqual(result.commitSucceeded, true);
  assert.strictEqual(result.status, RECORD_STORAGE_TRANSACTION_STATES.COMMITTED_CLEANUP_PENDING);
  assert(gateway.getEntries()[RECORD_STORAGE_JOURNAL_KEY]);
  assert(gateway.getEntries()[RECORD_STORAGE_BACKUP_KEY]);
  gateway.clearFailureSchedule();
  const recovery = manager.recover();
  assert.strictEqual(recovery.writeBlocked, false);
  assertBusinessState(currentBundle(gateway), target, 'cleanup recovery target');
  assert.strictEqual(gateway.getEntries()[RECORD_STORAGE_JOURNAL_KEY], undefined);
  assert.strictEqual(gateway.getEntries()[RECORD_STORAGE_BACKUP_KEY], undefined);
});

test('容量未知或峰值不足在第一个事务key写入前阻断且不覆盖主Bundle', () => {
  [
    { capacityConfirmed: false, expected: RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_NOT_CONFIRMED },
    { capacityConfirmed: true, capacityBytes: 200, expected: RECORD_STORAGE_TRANSACTION_ERRORS.STORAGE_CAPACITY_INSUFFICIENT }
  ].forEach((options, index) => {
    const base = oldBundle({ largeField: 'x'.repeat(1000) });
    const target = targetFrom(base, `capacity-${index}`);
    const { gateway, manager } = createPair(base, options);
    const result = manager.commitBundle(transactionInput(base, target, `capacity-${index}`));
    assert.strictEqual(result.commitSucceeded, false);
    assert.strictEqual(result.errors[0].code, options.expected);
    assert.strictEqual(gateway.getStats().writes, 0);
    assertBusinessState(currentBundle(gateway), base, `capacity-${index}`);
  });
});

test('持久化receipt有界且不保存业务正文，最近高风险操作受最低保留策略保护', () => {
  const base = oldBundle();
  const { gateway, manager } = createPair(base);
  const totalCommits = RECORD_STORAGE_RECEIPT_POLICY.maxTombstones + 188;
  let retainedInput = null;
  for (let index = 1; index <= totalCommits; index += 1) {
    const current = currentBundle(gateway);
    const target = stripRecordStorageControl(current);
    target.meta.lastSyntheticCommit = index;
    const input = transactionInput(current, target, `receipt-${index}`, {
      baseRevision: readRecordStorageControl(current) ? readRecordStorageControl(current).storageRevision : 0,
      baseFingerprint: getRecordStorageBusinessFingerprint(current),
      riskLevel: index % 2 === 0 ? 'FINANCIAL' : 'NORMAL'
    });
    if (index === totalCommits - 50) retainedInput = clone(input);
    const result = manager.commitBundle(input);
    assert.strictEqual(result.commitSucceeded, true, `receipt-${index}`);
  }
  const control = readRecordStorageControl(currentBundle(gateway));
  assert.strictEqual(control.recentReceipts.length, RECORD_STORAGE_RECEIPT_POLICY.maxRecentReceipts);
  assert.strictEqual(control.receiptTombstones.length, RECORD_STORAGE_RECEIPT_POLICY.maxTombstones);
  assert(control.recentReceipts.filter((entry) => entry.riskLevel === 'FINANCIAL').length
    >= RECORD_STORAGE_RECEIPT_POLICY.minHighRiskReceipts);
  assert(control.receiptTombstones.filter((entry) => entry.riskLevel === 'FINANCIAL').length
    >= RECORD_STORAGE_RECEIPT_POLICY.minHighRiskReceipts);
  const serialized = JSON.stringify(control.recentReceipts);
  assert.strictEqual(serialized.includes('originalText'), false);
  assert.strictEqual(serialized.includes('customerName'), false);
  assert.strictEqual(serialized.includes('amount'), false);
  const restartedGateway = createFakeStorageGateway(gateway.getEntries());
  const restarted = createPersistentRecordTransactionManager({
    gateway: restartedGateway,
    mode: 'TRANSACTION_PREVIEW'
  });
  const oldReplay = restarted.commitBundle(retainedInput);
  assert.strictEqual(oldReplay.status, RECORD_STORAGE_TRANSACTION_STATES.ALREADY_COMMITTED);
  assert.strictEqual(restartedGateway.getStats().writes, 0);
});

test('Phase 1E.1的22个业务场景在事务target bundle层继续与Legacy和Memory结果语义等价', async () => {
  let count = 0;
  await runLegacyEquivalenceWithVisitor((entry) => {
    count += 1;
    const pair = createPair(entry.initialState);
    const input = transactionInput(entry.initialState, entry.sharedState, `business-${count}`, {
      planId: entry.prepared.savePlan.planId,
      planHash: entry.prepared.savePlan.planHash,
      riskLevel: ['部分收款', '正好结清', '订单定金'].includes(entry.name) ? 'FINANCIAL' : 'NORMAL'
    });
    const result = pair.manager.commitBundle(input);
    assert.strictEqual(result.commitSucceeded, true, entry.name);
    assertBusinessState(currentBundle(pair.gateway), entry.sharedState, `${entry.name}:transaction target exact`);
    const projected = projectLegacyStorageEntries(pair.gateway.getEntries());
    const memoryComparison = compareRecordSaveShadowStates({
      legacyState: entry.sharedState,
      sharedState: projected.domainState
    });
    assert.strictEqual(memoryComparison.equivalent, true, `${entry.name}:memory`);
    assert.deepStrictEqual(
      canonicalState(projected.domainState, entry.initialState),
      canonicalState(entry.legacyState, entry.initialState),
      `${entry.name}:legacy`
    );
    assert.strictEqual(readRecordStorageControl(currentBundle(pair.gateway)).storageRevision, 1, entry.name);
  });
  assert.strictEqual(count, 22);
});

test('生产页面与business仍未接入共享Commit且旧Storage Adapter继续硬禁用commit', () => {
  const root = path.resolve(__dirname, '..');
  ['pages/input/input.js', 'pages/dashboard/dashboard.js', 'utils/business.js', 'server/utils/business.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.strictEqual(source.includes('commitTransaction'), false, file);
    assert.strictEqual(source.includes('record-storage-transaction'), false, file);
    assert.strictEqual(source.includes('TRANSACTION_PREVIEW'), false, file);
  });
  const base = stateWith();
  const gateway = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: base });
  const adapter = createLegacyStorageAdapter({ gateway, migrationMode: STORAGE_MIGRATION_MODES.SHARED_COMMIT });
  assert.strictEqual(Object.isFrozen(adapter), true);
  const originalCommit = adapter.commit;
  adapter.commit = () => ({ commitSucceeded: true });
  assert.strictEqual(adapter.commit, originalCommit);
  const before = gateway.getStats();
  const blocked = adapter.commit({ planId: 'still-disabled', planHash: 'still-disabled' });
  assert.strictEqual(blocked.errors[0].code, 'SHARED_PRODUCTION_COMMIT_DISABLED');
  assert.deepStrictEqual(gateway.getStats(), before);
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
  console.log(`Phase 1E.2A.1: ${passed}/${tests.length} passed`);
}

if (require.main === module) main();

module.exports = { main };
