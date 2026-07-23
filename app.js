const { initializeState } = require('./utils/storage');

App({
  onLaunch() {
    initializeState();
  },
  globalData: {
    userId: 'local-user',
    apiBaseUrl: 'https://api.baizeji.com',
    aiAuthEnabled: true,
    aiParseEndpoint: '/api/ai/parse',
    aiTranscribeEndpoint: ''
  }
});
