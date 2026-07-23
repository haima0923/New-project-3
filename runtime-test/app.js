const {
  installRuntimeStorageGuard
} = require('./runtime-storage-guard');

const runtimeStorageGuard = installRuntimeStorageGuard(globalThis.wx);

const {
  createRecordStorageWxRuntimeHarness
} = require('./utils/record-storage-wx-runtime-harness');

App({
  onLaunch() {
    const harness = createRecordStorageWxRuntimeHarness({
      authorizedLaunch: true,
      runtimeStorageGuard
    });
    this.recordStorageRuntimeTest = harness;
    this.runtimeStorageGuard = runtimeStorageGuard;
    this.globalData.bootId = harness.bootId;
  },
  globalData: {
    bootId: '',
    productionMode: 'LEGACY_ONLY',
    sharedCommitEnabled: false
  }
});
