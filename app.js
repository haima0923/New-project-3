const { getState, saveState } = require('./utils/storage');

App({
  onLaunch() {
    const state = getState();
    saveState(state);
  },
  globalData: {
    userId: 'local-user',
    apiBaseUrl: 'https://39.105.7.48',
    aiParseEndpoint: '/api/ai/parse'
  }
});
