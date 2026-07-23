#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  completeTodo,
  convertQuotationToOrder,
  generateDunningMessage,
  generateReceivableFromOrder,
  recordDunning,
  recordPayment,
  saveConfirmedDraft,
  savePendingNote,
  setOrderDeliveryDate,
  softDeleteRecord,
  updateOrderStatus
} = require('../utils/business');
const {
  STORAGE_ADAPTER_ERROR_CODES,
  STORAGE_MIGRATION_MODES,
  STORAGE_TARGET_KINDS
} = require('../utils/record-storage-adapter-contract');
const { KNOWN_NON_BUSINESS_STORAGE_TOPOLOGY } = require('../utils/record-storage-adapter-contract');
const {
  createFakeStorageGateway,
  createLegacyStorageAdapter,
  createWxStorageGateway,
  getTrustedStorageAdapterIdentity,
  isTrustedStorageAdapter
} = require('../utils/record-storage-adapters');
const {
  KNOWN_NON_BUSINESS_STORAGE_KEYS,
  LEGACY_BUSINESS_STATE_PATHS,
  LEGACY_BUSINESS_STORAGE_KEY,
  buildLegacyStorageWrites,
  projectLegacyStorageEntries
} = require('../utils/record-storage-state-projector');
const {
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES,
  LEGACY_PAGE_LIFECYCLE_INVENTORY,
  compareRecordSaveShadowStates
} = require('../utils/record-save-shadow');
const {
  FULL_COLLECTIONS,
  createStateDiff,
  getStateFingerprint,
  normalizeDomainState,
  safeClone,
  stableSerialize
} = require('../utils/record-state-diff');
const { createReleaseAStorageFacade } = require('../utils/storage');
const {
  authorization,
  canonicalState,
  customer,
  fixedClock,
  order,
  orderResult,
  prepare,
  quotation,
  receivable,
  runLegacyEquivalenceWithVisitor,
  scopedIdGenerator,
  stateWith,
  withFixedGlobals
} = require('./record-shared-core-phase1e1-tests');

delete global.wx;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function canonicalCompleteState(state, initialState) {
  const normalized = normalizeDomainState(state);
  const collectionState = canonicalState(normalized, initialState);
  const known = new Set(['meta', 'dunningTemplates'].concat(Object.values(FULL_COLLECTIONS)));
  const extraState = Object.keys(normalized).sort().reduce((result, key) => {
    if (!known.has(key)) result[key] = clone(normalized[key]);
    return result;
  }, {});
  return Object.assign({}, collectionState, {
    meta: clone(normalized.meta),
    dunningTemplates: clone(normalized.dunningTemplates),
    extraState
  });
}

function adapterForState(state, extraEntries = {}, migrationMode = STORAGE_MIGRATION_MODES.SHADOW_COMPARE) {
  const gateway = createFakeStorageGateway(Object.assign({}, clone(extraEntries), {
    [LEGACY_BUSINESS_STORAGE_KEY]: clone(state)
  }));
  const adapter = createLegacyStorageAdapter({ gateway, migrationMode });
  return { adapter, gateway };
}

function previewPrepared(prepared, initialState, extraEntries = {}) {
  const pair = adapterForState(initialState, extraEntries);
  const snapshot = pair.adapter.readSnapshot();
  const preview = pair.adapter.previewCommit(prepared.savePlan, {
    snapshot,
    authorization: authorization(prepared.savePlan),
    clock: fixedClock(),
    idGenerator: scopedIdGenerator('business')
  });
  return Object.assign(pair, { snapshot, preview });
}

test('Storage拓扑完整区分单一业务bundle、登录态和五个页面交接key', () => {
  const state = stateWith({
    customers: [customer('cus-1', '王总', { legacyCustomerField: '保留' })],
    legacyTopLevel: { version: 'old-compatible' }
  });
  const entries = {
    [LEGACY_BUSINESS_STORAGE_KEY]: state,
    huoxiaoling_ai_auth_session_v1: { token: 'synthetic-secret-not-for-domain' },
    pending_to_edit: 'pending-1',
    record_to_edit: { type: 'order', id: 'order-1' },
    force_text_input: true,
    draft_to_input: { text: '合成草稿' },
    finance_segment: 'receivable'
  };
  const inputBefore = stableSerialize(entries);
  const snapshot = projectLegacyStorageEntries(entries);
  assert.strictEqual(snapshot.businessStorageKey, LEGACY_BUSINESS_STORAGE_KEY);
  assert.strictEqual(snapshot.atomicityStrategy, 'SINGLE_BUNDLE_REPLACE_UNVERIFIED');
  assert.deepStrictEqual(snapshot.topology.excludedKeys.sort(), Object.keys(KNOWN_NON_BUSINESS_STORAGE_KEYS).sort());
  assert.deepStrictEqual(snapshot.topology.unknownKeys, []);
  assert.strictEqual(snapshot.domainState.customers[0].legacyCustomerField, '保留');
  assert.deepStrictEqual(snapshot.domainState.legacyTopLevel, { version: 'old-compatible' });
  assert.strictEqual(JSON.stringify(snapshot).includes('synthetic-secret-not-for-domain'), false);
  assert.strictEqual(stableSerialize(entries), inputBefore);
  const requiredPaths = [
    'customers', 'quotations', 'orders', 'receivables', 'paymentRecords', 'todos', 'pendingNotes',
    'meta', 'orderProgress', 'aiParseLogs', 'operationLogs', 'productCatalog', 'dunningRecords',
    'dunningTemplates', 'deletedRecords'
  ];
  requiredPaths.forEach((key) => assert(LEGACY_BUSINESS_STATE_PATHS.some((item) => item.path === key), key));
  assert.strictEqual(LEGACY_BUSINESS_STATE_PATHS.some((item) => item.path === 'records'), false);
  const root = path.resolve(__dirname, '..');
  KNOWN_NON_BUSINESS_STORAGE_TOPOLOGY.forEach((item) => {
    assert.strictEqual(KNOWN_NON_BUSINESS_STORAGE_KEYS[item.key], item.category, item.key);
    item.producers.concat(item.consumers).forEach((file) => {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert(source.includes(item.key), `${item.key} missing in ${file}`);
    });
  });
  assert.deepStrictEqual(
    KNOWN_NON_BUSINESS_STORAGE_TOPOLOGY.map((item) => item.key).sort(),
    Object.keys(KNOWN_NON_BUSINESS_STORAGE_KEYS).sort()
  );
  const directStorageFiles = [];
  function collectStorageSources(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) collectStorageSources(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) directStorageFiles.push(path.relative(root, full));
    });
  }
  collectStorageSources(path.join(root, 'pages'));
  collectStorageSources(path.join(root, 'utils'));
  directStorageFiles.push('app.js');
  Array.from(new Set(directStorageFiles)).forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/wx\.(?:get|set|remove)StorageSync\(\s*['"]([^'"]+)['"]/g)) {
      assert(KNOWN_NON_BUSINESS_STORAGE_KEYS[match[1]], `unclassified direct storage key: ${match[1]} in ${file}`);
    }
  });
});

test('适配器和gateway身份由受保护工厂注册，普通对象不能伪造WX或启用生产commit', () => {
  const plainGateway = {
    getStorageSync() {}, setStorageSync() {}, removeStorageSync() {}
  };
  assert.throws(
    () => createLegacyStorageAdapter({ gateway: plainGateway }),
    (error) => error.code === STORAGE_ADAPTER_ERROR_CODES.STORAGE_ADAPTER_IDENTITY_INVALID
  );
  assert.throws(
    () => createWxStorageGateway(plainGateway),
    (error) => error.code === STORAGE_ADAPTER_ERROR_CODES.STORAGE_GATEWAY_INVALID
  );
  const { adapter, gateway } = adapterForState(stateWith(), {}, STORAGE_MIGRATION_MODES.SHARED_COMMIT);
  assert.strictEqual(isTrustedStorageAdapter(adapter), true);
  assert.strictEqual(getTrustedStorageAdapterIdentity({ getIdentity: () => ({ targetKind: 'WX_TRANSACTIONAL' }) }), null);
  const identity = getTrustedStorageAdapterIdentity(adapter);
  assert.strictEqual(identity.targetKind, STORAGE_TARGET_KINDS.FAKE);
  assert.strictEqual(identity.commitEnabled, false);
  const before = gateway.getStats();
  const disabled = adapter.commit({ planId: 'forged', planHash: 'forged' });
  const after = gateway.getStats();
  assert.strictEqual(disabled.errors[0].code, STORAGE_ADAPTER_ERROR_CODES.SHARED_PRODUCTION_COMMIT_DISABLED);
  assert.strictEqual(disabled.writeAttempted, false);
  assert.deepStrictEqual(after, before);
  assert.throws(
    () => createLegacyStorageAdapter({ gateway, migrationMode: 'PRODUCTION_BY_ENV' }),
    (error) => error.code === STORAGE_ADAPTER_ERROR_CODES.STORAGE_MIGRATION_MODE_INVALID
  );
});

test('Preview只接受本适配器签发且仍与当前业务bundle一致的snapshot', () => {
  const initial = stateWith();
  const prepared = prepare(orderResult(), initial);
  const first = adapterForState(initial);
  const second = adapterForState(initial);
  const trusted = first.adapter.readSnapshot();
  const forged = clone(trusted);
  const forgedResult = first.adapter.previewCommit(prepared.savePlan, {
    snapshot: forged, authorization: authorization(prepared.savePlan), clock: fixedClock(),
    idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(forgedResult.previewStatus, 'FAILED');
  assert.strictEqual(forgedResult.blockingIssues[0].code, STORAGE_ADAPTER_ERROR_CODES.STORAGE_SNAPSHOT_UNTRUSTED);

  const foreignResult = second.adapter.previewCommit(prepared.savePlan, {
    snapshot: trusted, authorization: authorization(prepared.savePlan), clock: fixedClock(),
    idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(foreignResult.previewStatus, 'FAILED');
  assert.strictEqual(foreignResult.blockingIssues[0].code, STORAGE_ADAPTER_ERROR_CODES.STORAGE_SNAPSHOT_UNTRUSTED);

  const changed = clone(initial);
  changed.todos.push({ id: 'todo-after-snapshot', title: '合成并发变化' });
  first.gateway.setStorageSync(LEGACY_BUSINESS_STORAGE_KEY, changed);
  const staleResult = first.adapter.previewCommit(prepared.savePlan, {
    snapshot: trusted, authorization: authorization(prepared.savePlan), clock: fixedClock(),
    idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(staleResult.previewStatus, 'FAILED');
  assert.strictEqual(staleResult.blockingIssues[0].code, STORAGE_ADAPTER_ERROR_CODES.STORAGE_SNAPSHOT_STALE);
});

test('Storage投影和fingerprint稳定，兼容字段保留且登录、页面key不使业务计划过期', () => {
  const raw = stateWith({
    customers: [customer('cus-1', '王总', { legacyCustomerField: { nested: true } })],
    orders: [order('ord-1', 'cus-1', { oldExtension: '保留' })],
    legacyTopLevel: { keep: true }
  });
  const firstEntries = {
    [LEGACY_BUSINESS_STORAGE_KEY]: raw,
    huoxiaoling_ai_auth_session_v1: { token: 'first' },
    finance_segment: 'receivable'
  };
  const secondEntries = {
    finance_segment: 'paid',
    huoxiaoling_ai_auth_session_v1: { token: 'second' },
    [LEGACY_BUSINESS_STORAGE_KEY]: JSON.parse(JSON.stringify(raw))
  };
  const first = projectLegacyStorageEntries(firstEntries);
  const second = projectLegacyStorageEntries(secondEntries);
  assert.strictEqual(first.storageStateFingerprint, second.storageStateFingerprint);
  assert.strictEqual(first.storageStateVersion, second.storageStateVersion);
  assert.strictEqual(first.domainState.orders[0].oldExtension, '保留');
  assert.deepStrictEqual(first.domainState.legacyTopLevel, { keep: true });
  const changed = clone(raw);
  changed.operationLogs.push({ id: 'log-external', type: 'external' });
  assert.notStrictEqual(
    projectLegacyStorageEntries({ [LEGACY_BUSINESS_STORAGE_KEY]: changed }).storageStateFingerprint,
    first.storageStateFingerprint
  );
  const writes = buildLegacyStorageWrites(first.domainState, first);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].key, LEGACY_BUSINESS_STORAGE_KEY);
  assert.strictEqual(writes[0].value.orders[0].oldExtension, '保留');
  assert.deepStrictEqual(writes[0].value.legacyTopLevel, { keep: true });
});

test('Preview Commit只读执行共享Memory Commit，proposedWrites与nextState一致且gateway零写入', () => {
  const initial = stateWith();
  const prepared = prepare(orderResult(), initial);
  const { gateway, snapshot, preview } = previewPrepared(prepared, initial, {
    huoxiaoling_ai_auth_session_v1: { token: 'synthetic-session' },
    draft_to_input: { text: '合成页面草稿' }
  });
  assert.strictEqual(snapshot.storageStateFingerprint, prepared.savePlan.sourceStateFingerprint);
  assert.strictEqual(preview.previewStatus, 'COMMITTED');
  assert.strictEqual(preview.writeAttempted, false);
  assert.strictEqual(preview.commitEnabled, false);
  assert.strictEqual(preview.proposedWrites.length, 1);
  assert.strictEqual(preview.proposedWrites[0].key, LEGACY_BUSINESS_STORAGE_KEY);
  assert.deepStrictEqual(
    normalizeDomainState(preview.proposedWrites[0].value),
    normalizeDomainState(preview.nextDomainState)
  );
  const stats = gateway.getStats();
  assert.strictEqual(stats.writes, 0);
  assert.strictEqual(stats.removals, 0);
  assert.strictEqual(gateway.getEntries().huoxiaoling_ai_auth_session_v1.token, 'synthetic-session');
});

test('Phase 1E.1的22个记一笔场景经Storage投影、Preview和重新投影仍与legacy完整bundle等价', async () => {
  let count = 0;
  await runLegacyEquivalenceWithVisitor(({ name, action, initialState, prepared, legacyState }) => {
    count += 1;
    const legacyGateway = createFakeStorageGateway({
      [LEGACY_BUSINESS_STORAGE_KEY]: clone(initialState),
      huoxiaoling_ai_auth_session_v1: { token: `legacy-synthetic-${count}` }
    });
    const legacyStorage = createReleaseAStorageFacade({
      gateway: legacyGateway,
      clock: fixedClock()
    });
    const storageState = legacyStorage.getState();
    withFixedGlobals(() => {
      if (action === 'SAVE_PENDING') savePendingNote(storageState, clone(prepared.finalResult), '用户选择稍后整理');
      else saveConfirmedDraft(storageState, clone(prepared.finalResult));
    });
    legacyStorage.saveState(storageState, { writerSource: 'RELEASE_A_TEST' });
    const legacyReloaded = legacyStorage.getState();
    assert.deepStrictEqual(
      canonicalState(legacyReloaded, initialState),
      canonicalState(legacyState, initialState),
      `${name}:legacy storage reload`
    );
    assert.strictEqual(
      legacyGateway.getStats().events.filter((entry) => (
        entry.type === 'SET' && entry.key === LEGACY_BUSINESS_STORAGE_KEY
      )).length,
      1,
      `${name}:legacy main bundle write count`
    );
    const { gateway, preview } = previewPrepared(prepared, initialState, {
      huoxiaoling_ai_auth_session_v1: { token: `synthetic-${count}` },
      finance_segment: 'receivable'
    });
    assert.strictEqual(preview.previewStatus, 'COMMITTED', `${name}:${JSON.stringify(preview.blockingIssues)}`);
    assert.deepStrictEqual(
      canonicalState(preview.nextDomainState, initialState),
      canonicalState(legacyReloaded, initialState),
      `${name}:domain`
    );
    assert.deepStrictEqual(
      canonicalCompleteState(preview.nextDomainState, initialState),
      canonicalCompleteState(legacyReloaded, initialState),
      `${name}:complete domain state`
    );
    const reloaded = projectLegacyStorageEntries({
      [LEGACY_BUSINESS_STORAGE_KEY]: preview.proposedWrites[0].value
    }).domainState;
    assert.deepStrictEqual(
      canonicalState(reloaded, initialState),
      canonicalState(legacyReloaded, initialState),
      `${name}:reload`
    );
    assert.deepStrictEqual(
      canonicalCompleteState(reloaded, initialState),
      canonicalCompleteState(legacyReloaded, initialState),
      `${name}:complete reloaded bundle`
    );
    assert.strictEqual(gateway.getStats().writes, 0, `${name}:write count`);
    assert.strictEqual(
      stableSerialize(preview.businessDiff),
      stableSerialize(createStateDiff(initialState, preview.nextDomainState).businessDiff),
      `${name}:business diff`
    );
    assert.strictEqual(
      stableSerialize(preview.fullDiff),
      stableSerialize(createStateDiff(initialState, preview.nextDomainState).fullDiff),
      `${name}:full diff`
    );
  });
  assert.strictEqual(count, 22);
});

test('反投影不把原本缺失且未变化的可选空集合物化进旧bundle', () => {
  const initial = stateWith();
  delete initial.productCatalog;
  delete initial.operationLogs;
  delete initial.deletedRecords;
  const snapshot = projectLegacyStorageEntries({ [LEGACY_BUSINESS_STORAGE_KEY]: initial });
  const writes = buildLegacyStorageWrites(snapshot.domainState, snapshot);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(writes[0].value, 'productCatalog'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(writes[0].value, 'operationLogs'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(writes[0].value, 'deletedRecords'), false);
});

test('未知顶层和记录兼容字段在Preview反投影后不丢失也不进入无关storage key', () => {
  const initial = stateWith({
    customers: [customer('cus-wang', '王总', { futureCustomerFlag: 'keep-customer' })],
    quotations: [quotation('quo-old', 'cus-wang', { futureQuoteFlag: 'keep-quote' })],
    orders: [order('ord-old', 'cus-wang', { futureOrderFlag: 'keep-order' })],
    receivables: [receivable('rec-old', 'cus-wang', { futureReceivableFlag: 'keep-receivable' })],
    futureBundleField: { keep: 'bundle' }
  });
  const prepared = prepare(orderResult({ customerId: 'cus-wang' }), initial);
  const { preview } = previewPrepared(prepared, initial);
  const persisted = preview.proposedWrites[0].value;
  assert.strictEqual(persisted.customers[0].futureCustomerFlag, 'keep-customer');
  assert.strictEqual(persisted.quotations[0].futureQuoteFlag, 'keep-quote');
  assert.strictEqual(persisted.orders.find((item) => item.id === 'ord-old').futureOrderFlag, 'keep-order');
  assert.strictEqual(persisted.receivables[0].futureReceivableFlag, 'keep-receivable');
  assert.deepStrictEqual(persisted.futureBundleField, { keep: 'bundle' });
  assert.deepStrictEqual(preview.proposedWrites.map((item) => item.key), [LEGACY_BUSINESS_STORAGE_KEY]);
});

test('业务state或目标状态变化使Preview旧计划过期，登录态和页面设置变化不影响计划绑定', () => {
  const initial = stateWith();
  const prepared = prepare(orderResult(), initial);
  const unaffectedGateway = createFakeStorageGateway({
    [LEGACY_BUSINESS_STORAGE_KEY]: clone(initial),
    huoxiaoling_ai_auth_session_v1: { token: 'changed-auth' },
    finance_segment: 'paid'
  });
  const unaffectedAdapter = createLegacyStorageAdapter({ gateway: unaffectedGateway });
  const good = unaffectedAdapter.previewCommit(prepared.savePlan, {
    authorization: authorization(prepared.savePlan), clock: fixedClock(), idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(good.previewStatus, 'COMMITTED');

  const changed = clone(initial);
  changed.aiParseLogs.push({ id: 'external-log', originalText: '外部业务变化' });
  const stalePair = adapterForState(changed);
  const stale = stalePair.adapter.previewCommit(prepared.savePlan, {
    authorization: authorization(prepared.savePlan), clock: fixedClock(), idGenerator: scopedIdGenerator('business')
  });
  assert.strictEqual(stale.previewStatus, 'STALE_PLAN');
  assert.strictEqual(stale.proposedWrites.length, 0);
  assert.strictEqual(stalePair.gateway.getStats().writes, 0);
});

test('全部物理业务bundle写入点均有生命周期分类，代表性边界不会伪装成SavePlan已迁移', () => {
  const requiredEntries = [
    'app-launch-initialize', 'record-formal', 'record-pending', 'editing-pending-update',
    'editing-pending-convert', 'quotation-convert', 'order-generate-receivable',
    'direct-payment', 'direct-dunning', 'order-status', 'order-delivery', 'todo-complete', 'pending-ignore',
    'soft-delete', 'customer-merge', 'customer-review', 'product-catalog-auto-migration',
    'product-catalog-manual-save', 'product-catalog-manual-delete', 'onboarding-meta'
  ];
  requiredEntries.forEach((id) => assert(LEGACY_PAGE_LIFECYCLE_INVENTORY.some((item) => item.id === id), id));
  const unsupported = LEGACY_PAGE_LIFECYCLE_INVENTORY.filter((item) => item.phase1e1Support !== 'REPRESENTATIVE_ALLOWED_PATHS');
  assert(unsupported.length >= 10);

  const root = path.resolve(__dirname, '..');
  const writerFiles = ['app.js'];
  function walk(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) writerFiles.push(path.relative(root, full));
    });
  }
  walk(path.join(root, 'pages'));
  const writers = writerFiles.map((file) => ({
    file,
    source: fs.readFileSync(path.join(root, file), 'utf8')
  })).filter((item) => /\b(?:prepareRecordStorageInfrastructure|saveState|updateState)\s*\(/.test(item.source));
  const callCount = writers.reduce((sum, item) => (
    sum + (item.source.match(/\bprepareRecordStorageInfrastructure\s*\(/g) || []).length
      + (item.source.match(/\bsaveState\s*\(/g) || []).length
      + (item.source.match(/\bupdateState\s*\(/g) || []).length
  ), 0);
  assert.strictEqual(callCount, 23);
  assert.strictEqual(LEGACY_BUSINESS_BUNDLE_WRITE_SITES.length, 23);
  const classifiedFiles = new Set(LEGACY_PAGE_LIFECYCLE_INVENTORY.flatMap((item) => item.sourceFiles || []));
  writers.forEach((item) => assert(classifiedFiles.has(item.file), `unclassified bundle writer: ${item.file}`));
  const discoveredSites = writers.flatMap((item) => {
    const perKind = { prepareRecordStorageInfrastructure: 0, saveState: 0, updateState: 0 };
    return Array.from(item.source.matchAll(/\b(prepareRecordStorageInfrastructure|saveState|updateState)\s*\(/g)).map((match) => {
      perKind[match[1]] += 1;
      return { sourceFile: item.file, callKind: match[1], occurrence: perKind[match[1]] };
    });
  });
  const siteKey = (item) => `${item.sourceFile}|${item.callKind}|${item.occurrence}`;
  assert.deepStrictEqual(
    discoveredSites.map(siteKey).sort(),
    LEGACY_BUSINESS_BUNDLE_WRITE_SITES.map(siteKey).sort()
  );
  const lifecycleIds = new Set(LEGACY_PAGE_LIFECYCLE_INVENTORY.map((item) => item.id));
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES.forEach((site) => {
    assert(site.lifecycleIds.length > 0, siteKey(site));
    site.lifecycleIds.forEach((id) => assert(lifecycleIds.has(id), `${siteKey(site)}:${id}`));
  });
  const softDelete = LEGACY_PAGE_LIFECYCLE_INVENTORY.find((item) => item.id === 'soft-delete');
  assert.deepStrictEqual(softDelete.variants, ['quotation', 'order', 'receivable', 'payment', 'todo', 'pending']);
  const catalogEntries = LEGACY_PAGE_LIFECYCLE_INVENTORY.filter((item) => item.id.startsWith('product-catalog-'));
  const catalogSource = fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8');
  catalogEntries.forEach((item) => assert(catalogSource.includes(item.entry), `catalog entry missing: ${item.entry}`));

  const wang = customer('cus-wang', '王总');
  const quoteState = stateWith({ customers: [wang], quotations: [quotation('quo-1', 'cus-wang')] });
  withFixedGlobals(() => convertQuotationToOrder(quoteState, 'quo-1', { requiredDeliveryDate: '2026-08-01' }));
  assert.strictEqual(quoteState.orders.length, 1);
  assert.strictEqual(quoteState.quotations[0].status, '已转订单');
  assert.strictEqual(quoteState.orderProgress.length, 1);

  const financeState = stateWith({
    customers: [wang],
    orders: [order('ord-1', 'cus-wang')],
    paymentRecords: [{
      id: 'pay-deposit', customerId: 'cus-wang', orderId: 'ord-1', receivableId: '', amount: '200', kind: 'deposit'
    }]
  });
  withFixedGlobals(() => generateReceivableFromOrder(financeState, 'ord-1'));
  assert.strictEqual(financeState.receivables.length, 1);
  assert.strictEqual(financeState.paymentRecords[0].receivableId, financeState.receivables[0].id);
  withFixedGlobals(() => recordPayment(financeState, financeState.receivables[0].id, '300', { originalText: '合成直接收款' }));
  assert.strictEqual(financeState.paymentRecords.length, 2);
  const dunning = generateDunningMessage(financeState, financeState.receivables[0].id, 'polite');
  withFixedGlobals(() => recordDunning(financeState, financeState.receivables[0].id, dunning));
  assert.strictEqual(financeState.dunningRecords.length, 1);

  const orderState = stateWith({ customers: [wang], orders: [order('ord-2', 'cus-wang')] });
  withFixedGlobals(() => updateOrderStatus(orderState, 'ord-2', '生产中'));
  withFixedGlobals(() => setOrderDeliveryDate(orderState, 'ord-2', '2026-08-03'));
  assert.strictEqual(orderState.orderProgress.length, 2);
  assert.strictEqual(orderState.operationLogs.length, 2);

  const todoState = stateWith({ todos: [{ id: 'todo-1', title: '合成提醒', status: '待处理' }] });
  withFixedGlobals(() => completeTodo(todoState, 'todo-1'));
  assert.strictEqual(todoState.todos[0].status, '已完成');
  const deleteState = stateWith({ customers: [wang], orders: [order('ord-delete', 'cus-wang')] });
  withFixedGlobals(() => softDeleteRecord(deleteState, 'order', 'ord-delete'));
  assert.strictEqual(deleteState.orders.length, 0);
  assert.strictEqual(deleteState.deletedRecords.length, 1);
  assert.strictEqual(deleteState.operationLogs.length, 1);
});

test('影子差异比较检查最终state并将客户关系差异归类为零容忍业务差异', () => {
  const initial = stateWith({ customers: [customer('cus-1', '王总')] });
  const exact = compareRecordSaveShadowStates({ legacyState: initial, sharedState: clone(initial) });
  assert.strictEqual(exact.equivalent, true);
  assert.deepStrictEqual(exact.fullDifferences, []);
  const changed = clone(initial);
  changed.customers[0].name = '错误客户';
  const mismatch = compareRecordSaveShadowStates({ legacyState: initial, sharedState: changed });
  assert.strictEqual(mismatch.equivalent, false);
  assert(mismatch.businessDifferences.some((item) => item.collection === 'customers'));
  assert.strictEqual(mismatch.allowedDifferences.length, 0);
});

test('当前单bundle不实现伪多key事务，所有写失败注入下SHARED_COMMIT均在零读写处禁用', () => {
  ['BEFORE_SET', 'AFTER_SET', 'SILENT_NOOP', 'BEFORE_REMOVE', 'AFTER_REMOVE'].forEach((phase) => {
    const gateway = createFakeStorageGateway({ [LEGACY_BUSINESS_STORAGE_KEY]: stateWith() }, {
      failureInjection: { phase, key: LEGACY_BUSINESS_STORAGE_KEY }
    });
    const adapter = createLegacyStorageAdapter({ gateway, migrationMode: STORAGE_MIGRATION_MODES.SHARED_COMMIT });
    const result = adapter.commit({ planId: `plan-${phase}`, planHash: `hash-${phase}` });
    assert.strictEqual(result.errors[0].code, STORAGE_ADAPTER_ERROR_CODES.SHARED_PRODUCTION_COMMIT_DISABLED);
    assert.deepStrictEqual(gateway.getStats(), { reads: 0, writes: 0, removals: 0, events: [] });
  });
});

test('生产页面仍固定调用legacy保存且未接入shadow/shared adapter', () => {
  const root = path.resolve(__dirname, '..');
  const inputSource = fs.readFileSync(path.join(root, 'pages/input/input.js'), 'utf8');
  const dashboardSource = fs.readFileSync(path.join(root, 'pages/dashboard/dashboard.js'), 'utf8');
  const businessSource = fs.readFileSync(path.join(root, 'utils/business.js'), 'utf8');
  [inputSource, dashboardSource].forEach((source) => {
    assert(source.includes('saveConfirmedDraft'));
    assert(source.includes('savePendingNote'));
    assert.strictEqual(source.includes('record-storage-adapters'), false);
    assert.strictEqual(source.includes('SHADOW_COMPARE'), false);
    assert.strictEqual(source.includes('SHARED_COMMIT'), false);
  });
  assert.strictEqual(businessSource.includes('commitRecordSavePlan'), false);
  assert.strictEqual(businessSource.includes('record-storage-adapters'), false);
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
  console.log(`Phase 1E.2A: ${passed}/${tests.length} passed`);
}

main();
