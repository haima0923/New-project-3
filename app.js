const { getState, saveState } = require('./utils/storage');

App({
  onLaunch() {
    const state = getState();
    saveState(state);
  },
  globalData: {
    userId: 'local-user',
    apiBaseUrl: 'https://api.baizeji.com',
    aiAuthEnabled: true,
    aiParseEndpoint: '/api/ai/parse',
    aiTranscribeEndpoint: ''
  }
});
