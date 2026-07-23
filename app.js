const { prepareRecordStorageInfrastructure } = require('./utils/storage');

App({
  onLaunch() {
    const startup = prepareRecordStorageInfrastructure();
    this.globalData.recordStorageRecoveryLocked = Boolean(startup && startup.writeBlocked);
    this.globalData.recordStorageStartupStatus = startup && startup.status || '';
  },
  globalData: {
    userId: 'local-user',
    apiBaseUrl: 'https://api.baizeji.com',
    aiAuthEnabled: true,
    aiParseEndpoint: '/api/ai/parse',
    aiTranscribeEndpoint: '',
    recordStorageRecoveryLocked: false,
    recordStorageStartupStatus: ''
  }
});
