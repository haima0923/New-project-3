const {
  RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS
} = require('../../utils/record-storage-runtime-test-contract');

function emptyResult() {
  return {
    schemaVersion: '',
    suite: '',
    status: 'NOT_RUN',
    passed: 0,
    failed: 0,
    cases: []
  };
}

function emptyStatus() {
  return {
    revision: 0,
    receiptCount: 0,
    trace: { isolatedKeysPresent: [] },
    storageAudit: {
      forbiddenAccessCount: 0,
      realBusinessKey: { reads: 0, writes: 0, removals: 0 }
    }
  };
}

Page({
  data: {
    busy: false,
    bootId: '',
    message: '独立隔离入口已启动。',
    result: emptyResult(),
    status: emptyStatus(),
    recoveryScenarios: [
      { value: RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.PREPARED, label: 'PREPARED后中断' },
      { value: RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.MAIN_WRITTEN, label: '主Bundle写入后中断' },
      { value: RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.PRIMARY_CORRUPT, label: '主Bundle损坏' },
      { value: RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.CONTRADICTORY, label: '互相矛盾状态' },
      { value: RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS.IDEMPOTENCY, label: '幂等跨重载' }
    ]
  },

  onLoad() {
    const app = getApp();
    this.harness = app && app.recordStorageRuntimeTest;
    if (!this.harness) {
      this.setData({ message: '隔离测试Harness未初始化。' });
      return;
    }
    this.setData({
      bootId: this.harness.bootId,
      message: '独立入口已授权。生产 app、onboarding 和业务初始化均未加载。'
    });
    this.refreshStatus();
  },

  ensureHarness() {
    return Boolean(this.harness);
  },

  refreshStatus() {
    if (!this.ensureHarness()) return;
    try {
      this.setData({ status: this.harness.getRuntimeStatus() });
    } catch (error) {
      this.setData({ message: `读取状态失败：${error.code || 'UNKNOWN'}` });
    }
  },

  async runNonReloadSuite() {
    if (!this.ensureHarness() || this.data.busy) return;
    this.setData({ busy: true, message: '正在运行不需要重载的隔离测试…' });
    try {
      const result = await this.harness.runNonReloadSuite();
      this.setData({
        result,
        status: this.harness.getRuntimeStatus(),
        message: result.status === 'PASS'
          ? `不重载测试通过：${result.passed}/${result.cases.length}`
          : `不重载测试失败：${result.failed}/${result.cases.length}`
      });
    } catch (error) {
      this.setData({
        result: Object.assign(emptyResult(), {
          suite: 'WX_RUNTIME_NON_RELOAD',
          status: 'FAIL',
          failed: 1,
          cases: [{ caseId: 'suite-exception', status: 'FAIL', errorCode: error.code || 'UNKNOWN' }]
        }),
        message: `测试异常：${error.code || 'UNKNOWN'}`
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  prepareRecovery(event) {
    if (!this.ensureHarness() || this.data.busy) return;
    const scenario = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.scenario
      : '';
    try {
      const result = this.harness.prepareRecoveryScenario(scenario);
      this.setData({
        result: {
          schemaVersion: result.schemaVersion,
          suite: 'WX_RUNTIME_RECOVERY_PREPARE',
          status: result.status,
          passed: result.status === 'PASS' ? 1 : 0,
          failed: result.status === 'FAIL' ? 1 : 0,
          cases: [result]
        },
        status: this.harness.getRuntimeStatus(),
        message: result.status === 'PASS'
          ? `已准备 ${scenario}。现在请点击开发者工具“重新编译”，再返回本页点击“恢复/验证”。`
          : `准备 ${scenario} 失败：${result.errorCode || 'UNKNOWN'}`
      });
    } catch (error) {
      this.setData({ message: `准备恢复场景失败：${error.code || 'UNKNOWN'}` });
    }
  },

  resumeRecovery() {
    if (!this.ensureHarness() || this.data.busy) return;
    try {
      const result = this.harness.resumeRecoveryScenario();
      this.setData({
        result: {
          schemaVersion: result.schemaVersion,
          suite: 'WX_RUNTIME_RECOVERY_RESUME',
          status: result.status,
          passed: result.status === 'PASS' ? 1 : 0,
          failed: result.status === 'FAIL' ? 1 : 0,
          cases: [result]
        },
        status: this.harness.getRuntimeStatus(),
        message: result.status === 'PASS'
          ? `恢复验证通过：${result.recoveryStatus || result.scenario}`
          : `恢复验证未通过：${result.errorCode || result.status}`
      });
    } catch (error) {
      this.setData({ message: `恢复验证异常：${error.code || 'UNKNOWN'}` });
    }
  },

  cleanIsolatedStorage() {
    if (!this.ensureHarness() || this.data.busy) return;
    try {
      const result = this.harness.cleanIsolatedStorage();
      const status = this.harness.getRuntimeStatus();
      status.revision = 0;
      status.receiptCount = 0;
      status.trace.isolatedKeysPresent = [];
      status.storageAudit = {
        forbiddenAccessCount: result.forbiddenAccessCount,
        realBusinessKey: result.realBusinessKey,
        bootCount: result.bootCount,
        suiteRunId: result.suiteRunId
      };
      this.setData({
        result: {
          schemaVersion: result.schemaVersion,
          suite: 'WX_RUNTIME_CLEANUP',
          status: result.status,
          passed: result.status === 'PASS' ? 1 : 0,
          failed: result.status === 'FAIL' ? 1 : 0,
          cases: [result]
        },
        status,
        message: result.status === 'PASS'
          ? '四个隔离测试key已清理；Storage硬阻断审计保持可见。'
          : '隔离测试key清理失败。'
      });
    } catch (error) {
      this.setData({ message: `清理失败：${error.code || 'UNKNOWN'}` });
    }
  }
});
