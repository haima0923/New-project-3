const RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION = 'record-storage-wx-runtime-test-v1';

const RECORD_STORAGE_RUNTIME_TEST_PAGE = 'pages/index/index';

const RECORD_STORAGE_RUNTIME_TEST_KEYS = Object.freeze({
  primary: 'huoxiaoling_record_txn_runtime_test_v1',
  journal: 'huoxiaoling_record_txn_runtime_journal_v1',
  backup: 'huoxiaoling_record_txn_runtime_backup_v1',
  receipts: 'huoxiaoling_record_txn_runtime_receipts_v1'
});

const RECORD_STORAGE_RUNTIME_TEST_KEY_LIST = Object.freeze(
  Object.values(RECORD_STORAGE_RUNTIME_TEST_KEYS).slice()
);

const RECORD_STORAGE_RUNTIME_TEST_STATUSES = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_RUN: 'NOT_RUN'
});

const RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS = Object.freeze({
  PREPARED: 'PREPARED',
  MAIN_WRITTEN: 'MAIN_WRITTEN',
  PRIMARY_CORRUPT: 'PRIMARY_CORRUPT',
  CONTRADICTORY: 'CONTRADICTORY',
  IDEMPOTENCY: 'IDEMPOTENCY'
});

function readWechatRuntimeEnvironment(wxApi) {
  try {
    const system = wxApi && typeof wxApi.getSystemInfoSync === 'function'
      ? wxApi.getSystemInfoSync() || {}
      : {};
    const account = wxApi && typeof wxApi.getAccountInfoSync === 'function'
      ? wxApi.getAccountInfoSync() || {}
      : {};
    const miniProgram = account.miniProgram || {};
    return {
      platform: String(system.platform || ''),
      envVersion: String(miniProgram.envVersion || ''),
      isDevtoolsDevelop: system.platform === 'devtools' && miniProgram.envVersion === 'develop'
    };
  } catch (error) {
    return { platform: '', envVersion: '', isDevtoolsDevelop: false };
  }
}

module.exports = {
  RECORD_STORAGE_RUNTIME_RECOVERY_SCENARIOS,
  RECORD_STORAGE_RUNTIME_TEST_KEYS,
  RECORD_STORAGE_RUNTIME_TEST_KEY_LIST,
  RECORD_STORAGE_RUNTIME_TEST_PAGE,
  RECORD_STORAGE_RUNTIME_TEST_SCHEMA_VERSION,
  RECORD_STORAGE_RUNTIME_TEST_STATUSES,
  readWechatRuntimeEnvironment
};
