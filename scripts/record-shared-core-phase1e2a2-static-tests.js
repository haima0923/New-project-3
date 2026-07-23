const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LEGACY_BUSINESS_STORAGE_KEY,
  STORAGE_MIGRATION_MODES,
  STORAGE_TARGET_KINDS
} = require('../utils/record-storage-adapter-contract');
const { createRecordStorageCoordinator } = require('../utils/record-storage-coordinator');
const {
  getTrustedGatewayIdentity
} = require('../utils/record-storage-gateway-registry');
const {
  RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS,
  RECORD_STORAGE_RUNTIME_TEST_KEYS,
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST
} = require('../utils/record-storage-runtime-test-contract');
const {
  createWxRuntimeTestStorageGateway
} = require('../utils/record-storage-runtime-test-gateway');
const {
  createRecordStorageWxRuntimeHarness
} = require('../utils/record-storage-wx-runtime-harness');
const { createPersistentRecordTransactionManager } = require('../utils/record-storage-transaction');
const {
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES
} = require('../utils/record-save-shadow');
const {
  ALL_RUNTIME_PROJECT_FILES,
  prepareRecordStorageWxRuntimeProject
} = require('./prepare-record-storage-wx-runtime-project');
const {
  GUARD_ERROR_CODE,
  REAL_BUSINESS_STORAGE_KEY,
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST: RUNTIME_GUARD_KEY_LIST,
  installRuntimeStorageGuard
} = require('../runtime-test/runtime-storage-guard');

const root = path.join(__dirname, '..');
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  const text = JSON.stringify(value);
  return Buffer.byteLength(typeof text === 'string' ? text : '', 'utf8');
}

function createWxStorageDouble(options = {}) {
  const entries = new Map(Object.entries(clone(options.entries || {})));
  const calls = [];
  const limitSizeKb = Number.isFinite(Number(options.limitSizeKb))
    ? Number(options.limitSizeKb)
    : 10240;

  function storageSizeKb() {
    const bytes = Array.from(entries.entries()).reduce((sum, [key, value]) => (
      sum + Buffer.byteLength(key, 'utf8') + byteLength(value)
    ), 0);
    return Math.ceil(bytes / 1024);
  }

  const wxDouble = {
    getSystemInfoSync() {
      return { platform: options.platform || 'devtools' };
    },
    getAccountInfoSync() {
      return { miniProgram: { envVersion: options.envVersion || 'develop' } };
    },
    getStorageInfoSync() {
      calls.push({ operation: 'INFO' });
      return {
        keys: Array.from(entries.keys()).sort(),
        currentSize: storageSizeKb(),
        limitSize: limitSizeKb
      };
    },
    getStorageSync(key) {
      calls.push({ operation: 'GET', key: String(key) });
      return entries.has(String(key)) ? clone(entries.get(String(key))) : '';
    },
    setStorageSync(key, value) {
      calls.push({ operation: 'SET', key: String(key), sizeBytes: byteLength(value) });
      entries.set(String(key), clone(value));
    },
    removeStorageSync(key) {
      calls.push({ operation: 'REMOVE', key: String(key) });
      entries.delete(String(key));
    }
  };
  return {
    wx: wxDouble,
    calls,
    entries,
    snapshot() {
      return Object.fromEntries(Array.from(entries.entries()).map(([key, value]) => [
        key,
        clone(value)
      ]));
    }
  };
}

async function withGuardedWx(options, fn) {
  const previous = global.wx;
  const storage = createWxStorageDouble(options);
  global.wx = storage.wx;
  try {
    const guard = installRuntimeStorageGuard(global.wx);
    assert.strictEqual(guard.isActive(), true);
    return await fn(storage, guard);
  } finally {
    if (previous === undefined) delete global.wx;
    else global.wx = previous;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function resolveRequiredFile(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function collectRuntimeDependencyGraph(outputRoot) {
  const queue = [
    path.join(outputRoot, 'app.js'),
    path.join(outputRoot, 'pages/index/index.js')
  ];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const requirePattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
    let match;
    while ((match = requirePattern.exec(source))) {
      const request = match[2];
      assert(request.startsWith('.'), `隔离入口禁止外部依赖：${request}`);
      const resolved = resolveRequiredFile(file, request);
      assert(resolved, `隔离入口依赖缺失：${file} -> ${request}`);
      const relative = path.relative(outputRoot, resolved);
      assert(!relative.startsWith('..') && !path.isAbsolute(relative), `依赖逃出隔离root：${request}`);
      queue.push(resolved);
    }
  }
  return Array.from(visited).map((file) => path.relative(outputRoot, file)).sort();
}

test('隔离测试只定义四个带版本号的专用key且与真实业务key不同', () => {
  assert.strictEqual(RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.length, 4);
  assert.strictEqual(new Set(RECORD_STORAGE_RUNTIME_TEST_KEY_LIST).size, 4);
  assert.strictEqual(REAL_BUSINESS_STORAGE_KEY, LEGACY_BUSINESS_STORAGE_KEY);
  assert.deepStrictEqual(
    RUNTIME_GUARD_KEY_LIST.slice().sort(),
    RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.slice().sort()
  );
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.forEach((key) => {
    assert(/^huoxiaoling_record_txn_runtime_.+_v1$/.test(key), key);
    assert.notStrictEqual(key, LEGACY_BUSINESS_STORAGE_KEY);
  });
});

test('独立入口先安装硬守卫再加载Harness且只注册测试首页', () => {
  const appSource = fs.readFileSync(path.join(root, 'runtime-test/app.js'), 'utf8');
  const guardRequire = appSource.indexOf("require('./runtime-storage-guard')");
  const guardInstall = appSource.indexOf('installRuntimeStorageGuard(globalThis.wx)');
  const harnessRequire = appSource.indexOf("require('./utils/record-storage-wx-runtime-harness')");
  assert(guardRequire >= 0 && guardInstall > guardRequire && harnessRequire > guardInstall);
  assert(appSource.includes("require('../app')") === false);
  assert(appSource.includes('initializeState') === false);
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'runtime-test/app.json'), 'utf8'));
  assert.deepStrictEqual(appJson.pages, ['pages/index/index']);
  assert.strictEqual(appJson.plugins, undefined);
  assert.strictEqual(appJson.tabBar, undefined);
});

test('生产App未注册隔离页且正式打包明确忽略runtime-test', () => {
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  assert.strictEqual(appSource.includes('recordStorageRuntimeTest'), false);
  assert.strictEqual(appSource.includes('runtime-test'), false);
  assert.strictEqual(appSource.includes('prepareRecordStorageInfrastructure();'), true);
  assert.strictEqual(appSource.includes('initializeState();'), false);
  assert.strictEqual(appJson.pages.some((page) => page.includes('__dev__') || page.includes('runtime-test')), false);
  assert(project.packOptions.ignore.some((entry) => (
    entry.type === 'folder' && entry.value === 'runtime-test'
  )));
  [
    'utils/record-storage-runtime-test-contract.js',
    'utils/record-storage-runtime-test-gateway.js',
    'utils/record-storage-wx-runtime-harness.js'
  ].forEach((file) => {
    assert(project.packOptions.ignore.some((entry) => (
      entry.type === 'file' && entry.value === file
    )), file);
  });
});

test('独立构建只复制固定依赖闭包并逐文件hash一致', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hxl-wx-runtime-static-'));
  try {
    const prepared = prepareRecordStorageWxRuntimeProject(output);
    assert.strictEqual(prepared.manifest.productionAppIncluded, false);
    assert.strictEqual(prepared.manifest.productionStorageIncluded, false);
    assert.strictEqual(prepared.manifest.sourceFileCount, ALL_RUNTIME_PROJECT_FILES.length);
    prepared.manifest.files.forEach((entry) => {
      const source = fs.readFileSync(path.join(root, entry.source));
      const copied = fs.readFileSync(path.join(output, entry.target));
      assert.strictEqual(sha256(source), entry.sha256, entry.source);
      assert.strictEqual(sha256(copied), entry.sha256, entry.target);
    });
    assert.strictEqual(fs.existsSync(path.join(output, 'utils/storage.js')), false);
    assert.strictEqual(fs.existsSync(path.join(output, 'pages/onboarding/onboarding.js')), false);
    assert.strictEqual(fs.existsSync(path.join(output, 'pages/dashboard/dashboard.js')), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('隔离构建拒绝符号链接输出和经真实路径回跳仓库', () => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'hxl-wx-runtime-link-'));
  const outside = path.join(holder, 'outside');
  const outsideLink = path.join(holder, 'outside-link');
  const repositoryLink = path.join(holder, 'repository-link');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, outsideLink);
  fs.symlinkSync(path.join(root, 'runtime-test'), repositoryLink);
  try {
    assert.throws(() => prepareRecordStorageWxRuntimeProject(outsideLink), {
      code: 'WX_RUNTIME_BUILD_OUTPUT_SYMLINK'
    });
    assert.throws(() => prepareRecordStorageWxRuntimeProject(repositoryLink), {
      code: 'WX_RUNTIME_BUILD_OUTPUT_INSIDE_REPOSITORY'
    });
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
});

test('隔离构建依赖图闭合且不含生产启动、业务保存或网络模块', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hxl-wx-runtime-deps-'));
  try {
    prepareRecordStorageWxRuntimeProject(output);
    const graph = collectRuntimeDependencyGraph(output);
    const forbidden = [
      'utils/storage.js',
      'utils/business.js',
      'utils/api-client.js',
      'utils/record-storage-gateways.js',
      'pages/onboarding/onboarding.js',
      'pages/dashboard/dashboard.js'
    ];
    forbidden.forEach((file) => assert.strictEqual(graph.includes(file), false, file));
    assert(graph.includes('app.js'));
    assert(graph.includes('runtime-storage-guard.js'));
    assert(graph.includes('utils/record-storage-coordinator.js'));
    assert(graph.includes('utils/record-storage-wx-runtime-harness.js'));
    assert(graph.includes('utils/record-storage-runtime-test-gateway.js'));
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('硬守卫在底层wx调用前阻断真实业务key读写删除并留下审计', async () => {
  await withGuardedWx({
    entries: { [LEGACY_BUSINESS_STORAGE_KEY]: { historical: 'untouched' } }
  }, (storage, guard) => {
    assert.throws(() => global.wx.getStorageSync(LEGACY_BUSINESS_STORAGE_KEY), {
      code: GUARD_ERROR_CODE
    });
    assert.throws(() => global.wx.setStorageSync(LEGACY_BUSINESS_STORAGE_KEY, {}), {
      code: GUARD_ERROR_CODE
    });
    assert.throws(() => global.wx.removeStorageSync(LEGACY_BUSINESS_STORAGE_KEY), {
      code: GUARD_ERROR_CODE
    });
    assert.deepStrictEqual(
      storage.calls.filter((call) => call.key === LEGACY_BUSINESS_STORAGE_KEY),
      []
    );
    assert.deepStrictEqual(guard.getAuditSummary().realBusinessKey, {
      reads: 1,
      writes: 1,
      removals: 1
    });
    assert.strictEqual(guard.getAuditSummary().forbiddenAccessCount, 3);
    assert.deepStrictEqual(storage.entries.get(LEGACY_BUSINESS_STORAGE_KEY), {
      historical: 'untouched'
    });
  });
});

test('硬守卫过滤Storage信息且白名单测试key可以正常读写删除', async () => {
  await withGuardedWx({
    entries: { unrelated_setting_v1: { keep: true } }
  }, (storage, guard) => {
    const key = RECORD_STORAGE_RUNTIME_TEST_KEYS.primary;
    global.wx.setStorageSync(key, { synthetic: true });
    assert.deepStrictEqual(global.wx.getStorageSync(key), { synthetic: true });
    const info = global.wx.getStorageInfoSync();
    assert.deepStrictEqual(info.keys, [key]);
    global.wx.removeStorageSync(key);
    assert.strictEqual(storage.entries.has('unrelated_setting_v1'), true);
    assert.strictEqual(guard.getAuditSummary().forbiddenAccessCount, 0);
    assert.deepStrictEqual(guard.getAuditSummary().realBusinessKey, {
      reads: 0,
      writes: 0,
      removals: 0
    });
  });
});

test('真实wx隔离Gateway只能在开发者工具develop环境创建', async () => {
  const previous = global.wx;
  try {
    global.wx = createWxStorageDouble({ platform: 'ios' }).wx;
    assert.throws(() => createWxRuntimeTestStorageGateway(), {
      code: 'WX_RUNTIME_TEST_ENVIRONMENT_FORBIDDEN'
    });
    global.wx = createWxStorageDouble({ envVersion: 'release' }).wx;
    assert.throws(() => createWxRuntimeTestStorageGateway(), {
      code: 'WX_RUNTIME_TEST_ENVIRONMENT_FORBIDDEN'
    });
  } finally {
    if (previous === undefined) delete global.wx;
    else global.wx = previous;
  }
});

test('隔离Gateway二次白名单保护、可信身份和事务key绑定有效', async () => {
  await withGuardedWx({}, () => {
    const gateway = createWxRuntimeTestStorageGateway();
    assert.throws(() => gateway.getStorageSync(LEGACY_BUSINESS_STORAGE_KEY), {
      code: GUARD_ERROR_CODE
    });
    assert.throws(() => gateway.setStorageSync(LEGACY_BUSINESS_STORAGE_KEY, {}), {
      code: GUARD_ERROR_CODE
    });
    assert.throws(() => gateway.removeStorageSync(LEGACY_BUSINESS_STORAGE_KEY), {
      code: GUARD_ERROR_CODE
    });
    const identity = getTrustedGatewayIdentity(gateway);
    assert.strictEqual(identity.gatewayKind, STORAGE_TARGET_KINDS.WX_ISOLATED_TEST);
    assert.strictEqual(identity.runtimeTestOnly, true);
    assert.deepStrictEqual(identity.transactionStorageKeys, {
      primary: RECORD_STORAGE_RUNTIME_TEST_KEYS.primary,
      journal: RECORD_STORAGE_RUNTIME_TEST_KEYS.journal,
      backup: RECORD_STORAGE_RUNTIME_TEST_KEYS.backup
    });
    assert.doesNotThrow(() => createPersistentRecordTransactionManager({
      gateway,
      mode: 'TRANSACTION_PREVIEW'
    }));
  });
});

test('普通对象不能伪造隔离Gateway或生产事务能力', () => {
  const plain = {
    getStorageSync() {},
    setStorageSync() {},
    removeStorageSync() {},
    targetKind: STORAGE_TARGET_KINDS.WX_ISOLATED_TEST
  };
  assert.strictEqual(getTrustedGatewayIdentity(plain), null);
  assert.throws(() => createPersistentRecordTransactionManager({
    gateway: plain,
    mode: 'TRANSACTION_PREVIEW'
  }), { code: 'STORAGE_TRANSACTION_MODE_FORBIDDEN' });
});

test('隔离Gateway trace不记录业务值且拒绝错误使用真实key', async () => {
  await withGuardedWx({}, () => {
    const gateway = createWxRuntimeTestStorageGateway();
    gateway.setStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary, {
      secretSyntheticValue: 'must-not-appear-in-trace'
    });
    gateway.getStorageSync(RECORD_STORAGE_RUNTIME_TEST_KEYS.primary);
    assert.throws(() => gateway.setStorageSync('not_allowed_v1', {}), {
      code: GUARD_ERROR_CODE
    });
    const serialized = JSON.stringify(gateway.getRuntimeTrace());
    assert.strictEqual(serialized.includes('must-not-appear-in-trace'), false);
    assert.strictEqual(serialized.includes('RUNTIME_TEST_STORAGE_KEY_FORBIDDEN'), true);
  });
});

test('wx API double下不重载16项含Release A启动结构全部通过且真实业务key访问为0', async () => {
  await withGuardedWx({}, async (storage, guard) => {
    const harness = createRecordStorageWxRuntimeHarness({
      authorizedLaunch: true,
      runtimeStorageGuard: guard
    });
    const result = await harness.runNonReloadSuite();
    assert.strictEqual(result.status, 'PASS');
    assert.strictEqual(result.passed, 16);
    assert.strictEqual(result.failed, 0);
    assert(result.cases.some((item) => (
      item.caseId === 'release-a-startup-and-legacy-writer'
      && item.status === 'PASS'
    )));
    assert.strictEqual(result.productionMode, STORAGE_MIGRATION_MODES.LEGACY_ONLY);
    assert.strictEqual(result.sharedCommitEnabled, false);
    assert.deepStrictEqual(result.storageAudit.realBusinessKey, {
      reads: 0,
      writes: 0,
      removals: 0
    });
    assert.strictEqual(result.storageAudit.forbiddenAccessCount, 0);
    assert.strictEqual(storage.calls.some((call) => (
      call.key === LEGACY_BUSINESS_STORAGE_KEY
    )), false);
    assert.strictEqual(harness.cleanIsolatedStorage().status, 'PASS');
  });
});

test('同一boot不能假装重新加载恢复', async () => {
  await withGuardedWx({}, (storage, guard) => {
    const harness = createRecordStorageWxRuntimeHarness({
      authorizedLaunch: true,
      runtimeStorageGuard: guard
    });
    assert.strictEqual(harness.prepareRecoveryScenario('PREPARED').status, 'PASS');
    const result = harness.resumeRecoveryScenario();
    assert.strictEqual(result.status, 'BLOCKED');
    assert.strictEqual(result.errorCode, 'WX_RUNTIME_TEST_REAL_RELOAD_REQUIRED');
    assert.strictEqual(harness.cleanIsolatedStorage().status, 'PASS');
  });
});

test('五种跨boot恢复和幂等合同在持久化double中通过', async () => {
  await withGuardedWx({}, async (storage, guard) => {
    const expected = {
      PREPARED: 'RECOVERED_ROLLED_BACK',
      MAIN_WRITTEN: 'RECOVERED_COMMITTED',
      PRIMARY_CORRUPT: 'RECOVERED_ROLLED_BACK',
      CONTRADICTORY: 'RECOVERY_REQUIRED',
      IDEMPOTENCY: 'ALREADY_COMMITTED'
    };
    for (const scenario of Object.values(RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS)) {
      const firstBoot = createRecordStorageWxRuntimeHarness({
        authorizedLaunch: true,
        runtimeStorageGuard: guard
      });
      assert.strictEqual(firstBoot.prepareRecoveryScenario(scenario).status, 'PASS', scenario);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const nextBoot = createRecordStorageWxRuntimeHarness({
        authorizedLaunch: true,
        runtimeStorageGuard: guard
      });
      assert.notStrictEqual(firstBoot.bootId, nextBoot.bootId, scenario);
      const resumed = nextBoot.resumeRecoveryScenario();
      assert.strictEqual(resumed.status, 'PASS', `${scenario}:${resumed.errorCode}`);
      assert.strictEqual(resumed.recoveryStatus, expected[scenario], scenario);
      assert.deepStrictEqual(resumed.realBusinessKey, {
        reads: 0,
        writes: 0,
        removals: 0
      });
    }
    const finalHarness = createRecordStorageWxRuntimeHarness({
      authorizedLaunch: true,
      runtimeStorageGuard: guard
    });
    const cleanup = finalHarness.cleanIsolatedStorage();
    assert.strictEqual(cleanup.status, 'PASS');
    assert(cleanup.bootCount >= 10, `bootCount=${cleanup.bootCount}`);
    assert.strictEqual(cleanup.forbiddenAccessCount, 0);
    assert.deepStrictEqual(cleanup.realBusinessKey, {
      reads: 0,
      writes: 0,
      removals: 0
    });
    assert(RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.every((key) => !storage.entries.has(key)));
  });
});

test('容量在第一次事务资料或主Bundle写入前阻断', async () => {
  await withGuardedWx({}, async (storage, guard) => {
    const harness = createRecordStorageWxRuntimeHarness({
      authorizedLaunch: true,
      runtimeStorageGuard: guard
    });
    const result = await harness.runNonReloadSuite();
    const capacity = result.cases.find((entry) => entry.caseId === 'capacity-preflight');
    assert.strictEqual(capacity.status, 'PASS');
    assert.strictEqual(capacity.errorCode, 'STORAGE_CAPACITY_INSUFFICIENT');
    assert.strictEqual(capacity.writes, 0);
    assert.strictEqual(storage.calls.some((call) => (
      call.key === LEGACY_BUSINESS_STORAGE_KEY
    )), false);
    assert.strictEqual(harness.cleanIsolatedStorage().status, 'PASS');
  });
});

test('TRANSACTION_PREVIEW只允许可信隔离Gateway且SHARED_COMMIT继续禁用', async () => {
  await withGuardedWx({}, () => {
    const gateway = createWxRuntimeTestStorageGateway();
    assert.doesNotThrow(() => createRecordStorageCoordinator({
      gateway,
      mode: 'TRANSACTION_PREVIEW'
    }));
    assert.throws(() => createRecordStorageCoordinator({
      gateway,
      mode: 'SHARED_COMMIT'
    }), { code: 'SHARED_PRODUCTION_COMMIT_DISABLED' });
  });
});

test('23个生产Lifecycle继续LEGACY_ONLY且不引用任何隔离测试key', () => {
  assert.strictEqual(LEGACY_BUSINESS_BUNDLE_WRITE_SITES.length, 23);
  LEGACY_BUSINESS_BUNDLE_WRITE_SITES.forEach((site) => {
    const source = fs.readFileSync(path.join(root, site.sourceFile), 'utf8');
    RECORD_STORAGE_RUNTIME_TEST_KEY_LIST.forEach((key) => {
      assert.strictEqual(source.includes(key), false, `${site.sourceFile}:${key}`);
    });
  });
  const storageSource = fs.readFileSync(path.join(root, 'utils/storage.js'), 'utf8');
  assert(storageSource.includes('createLegacyReleaseARecordStorageCoordinator'));
  assert(storageSource.includes('prepareRecordStorageInfrastructure'));
});

test('独立入口和依赖闭包不包含网络、生产保存入口或敏感结果字段', () => {
  const sourceFiles = ALL_RUNTIME_PROJECT_FILES.map((file) => path.join(root, file));
  sourceFiles.forEach((file) => {
    const source = fs.readFileSync(file, 'utf8');
    assert.strictEqual(/\bwx\.(request|uploadFile|downloadFile)\b/.test(source), false, file);
    assert.strictEqual(
      /\bwx\.(?:getStorage|setStorage|removeStorage|clearStorage|clearStorageSync)\b/.test(source),
      false,
      file
    );
    assert.strictEqual(/\b(fetch|XMLHttpRequest)\s*\(/.test(source), false, file);
    assert.strictEqual(source.includes('clearStorage'), false, file);
    assert.strictEqual(source.includes('saveConfirmedDraft('), false, file);
    assert.strictEqual(source.includes('savePendingNote('), false, file);
  });
  const harnessSource = fs.readFileSync(
    path.join(root, 'utils/record-storage-wx-runtime-harness.js'),
    'utf8'
  );
  assert.strictEqual(harnessSource.includes('originalText'), true);
  assert.strictEqual(
    harnessSource.includes("const forbidden = [SENSITIVE_SENTINEL, 'originalText', 'customerName', 'totalAmount']"),
    true
  );
});

async function main() {
  let passed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      console.error(`FAIL ${entry.name}`);
      console.error(error && error.stack || error);
      console.error(`Phase 1E.2A.2 static: ${passed}/${tests.length} passed`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`Phase 1E.2A.2 static: ${passed}/${tests.length} passed`);
}

if (require.main === module) main();

module.exports = { main };
