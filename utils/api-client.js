function getApiBaseUrl() {
  if (typeof getApp !== 'function') return '';
  const app = getApp();
  const globalData = app && app.globalData ? app.globalData : {};
  return (globalData.apiBaseUrl || '').replace(/\/$/, '');
}

const AI_AUTH_STORAGE_KEY = 'huoxiaoling_ai_auth_session_v1';
let pendingLogin = null;

function getGlobalData() {
  if (typeof getApp !== 'function') return {};
  const app = getApp();
  return app && app.globalData ? app.globalData : {};
}

function isAiAuthEnabled() {
  return getGlobalData().aiAuthEnabled === true;
}

function getStoredSession() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return {};
  const session = wx.getStorageSync(AI_AUTH_STORAGE_KEY);
  return session && typeof session === 'object' ? session : {};
}

function saveSession(session) {
  if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
    wx.setStorageSync(AI_AUTH_STORAGE_KEY, session);
  }
}

function clearSession() {
  if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
    wx.removeStorageSync(AI_AUTH_STORAGE_KEY);
  }
}

function createRequestError(statusCode, payload) {
  const error = new Error(`Request failed with status ${statusCode}`);
  error.statusCode = statusCode;
  error.code = payload && payload.error ? payload.error : '';
  return error;
}

function rawRequestJson(path, data, timeout, header = {}) {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return Promise.reject(new Error('API base URL is not configured'));

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${path}`,
      method: 'POST',
      data,
      timeout: timeout || 12000,
      header: Object.assign({
        'content-type': 'application/json'
      }, header),
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
          return;
        }
        reject(createRequestError(res.statusCode, res.data));
      },
      fail: reject
    });
  });
}

function wxLogin() {
  if (typeof wx === 'undefined' || typeof wx.login !== 'function') {
    return Promise.reject(new Error('WeChat login is unavailable'));
  }
  return new Promise((resolve, reject) => {
    wx.login({
      success: (result) => {
        if (result && result.code) {
          resolve(result.code);
          return;
        }
        reject(new Error('WeChat login did not return a code'));
      },
      fail: reject
    });
  });
}

function sessionIsUsable(session) {
  return Boolean(session.token && session.expiresAt && new Date(session.expiresAt).getTime() > Date.now() + 60000);
}

function getAiAuthToken(forceRefresh = false) {
  if (!isAiAuthEnabled()) return Promise.resolve('');
  const saved = getStoredSession();
  if (!forceRefresh && sessionIsUsable(saved)) return Promise.resolve(saved.token);
  if (pendingLogin) return pendingLogin;

  pendingLogin = wxLogin()
    .then((code) => rawRequestJson('/api/auth/wechat-login', { code }, 12000))
    .then((session) => {
      if (!session || !session.token || !session.expiresAt) throw new Error('Invalid authentication response');
      saveSession({ token: session.token, expiresAt: session.expiresAt });
      return session.token;
    })
    .finally(() => {
      pendingLogin = null;
    });
  return pendingLogin;
}

function requestJson(path, data, timeout) {
  if (path === '/api/auth/wechat-login') return rawRequestJson(path, data, timeout);
  return getAiAuthToken()
    .then((token) => rawRequestJson(path, data, timeout, token ? { authorization: `Bearer ${token}` } : {}))
    .catch((error) => {
      if (error && error.statusCode === 401 && error.code === 'AUTH_REQUIRED') {
        clearSession();
        return getAiAuthToken(true)
          .then((token) => rawRequestJson(path, data, timeout, { authorization: `Bearer ${token}` }));
      }
      throw error;
    });
}

module.exports = {
  AI_AUTH_STORAGE_KEY,
  clearSession,
  getApiBaseUrl,
  getAiAuthToken,
  requestJson
};
