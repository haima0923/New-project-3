function getApiBaseUrl() {
  if (typeof getApp !== 'function') return '';
  const app = getApp();
  const globalData = app && app.globalData ? app.globalData : {};
  return (globalData.apiBaseUrl || '').replace(/\/$/, '');
}

const AI_AUTH_STORAGE_KEY = 'huoxiaoling_ai_auth_session_v1';
const AI_AUTH_PREWARM_TIMEOUT_MS = 5000;
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
  error.serverRequestId = payload && payload.ai_request_id ? String(payload.ai_request_id) : '';
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
      fail: (error) => {
        const next = error instanceof Error ? error : new Error((error && error.errMsg) || 'Network request failed');
        if (!next.code) next.code = 'NETWORK_REQUEST_FAILED';
        reject(next);
      }
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

function getAiAuthToken(forceRefresh = false, timeoutMs = AI_AUTH_PREWARM_TIMEOUT_MS) {
  if (!isAiAuthEnabled()) return Promise.resolve('');
  const saved = getStoredSession();
  if (!forceRefresh && sessionIsUsable(saved)) return Promise.resolve(saved.token);
  if (pendingLogin) return pendingLogin;

  pendingLogin = wxLogin()
    .then((code) => rawRequestJson('/api/auth/wechat-login', { code }, timeoutMs))
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

function prewarmAiAuth() {
  return getAiAuthToken(false, AI_AUTH_PREWARM_TIMEOUT_MS)
    .then(() => ({ ready: true }))
    .catch((error) => ({ ready: false, code: (error && error.code) || 'AUTH_SESSION_EXPIRED' }));
}

function normalizeAuthError(error) {
  if (!error) {
    const unknown = new Error('AI authentication is unavailable');
    unknown.code = 'AUTH_SESSION_EXPIRED';
    return unknown;
  }
  if (!error.code) error.code = 'AUTH_SESSION_EXPIRED';
  return error;
}

function createAuthNotReadyError() {
  const error = new Error('AI authentication is still preparing');
  error.code = 'AUTH_SESSION_NOT_READY';
  return error;
}

function requestJson(path, data, timeout, options = {}) {
  if (path === '/api/auth/wechat-login') return rawRequestJson(path, data, timeout);
  // 旧的查询等非快速路径仍保留 401 后重新登录一次的兼容行为。
  // 快速核对会显式传入 false，避免在 8 秒窗口内再做一次登录和重试。
  const retryAuth = options.retryAuth !== false;
  const requireReadyAuth = options.requireReadyAuth === true;
  // 普通快速核对不能把“首次微信登录”算进 8 秒，也不能在页面已经提示结束后
  // 继续向服务端发 AI 请求。页面加载、开始录音和开始输入时会提前预热登录；
  // 若仍未完成，本次立即返回可重试状态。深度核对不受这个限制。
  if (requireReadyAuth && isAiAuthEnabled() && !sessionIsUsable(getStoredSession())) {
    return Promise.reject(createAuthNotReadyError());
  }
  return getAiAuthToken(false, Math.min(Number(timeout) || AI_AUTH_PREWARM_TIMEOUT_MS, AI_AUTH_PREWARM_TIMEOUT_MS))
    .catch((error) => { throw normalizeAuthError(error); })
    .then((token) => rawRequestJson(path, data, timeout, token ? { authorization: `Bearer ${token}` } : {}))
    .catch((error) => {
      if (retryAuth && error && error.statusCode === 401 && error.code === 'AUTH_REQUIRED') {
        clearSession();
        return getAiAuthToken(true, AI_AUTH_PREWARM_TIMEOUT_MS)
          .then((token) => rawRequestJson(path, data, timeout, { authorization: `Bearer ${token}` }));
      }
      if (error && error.statusCode === 401 && error.code === 'AUTH_REQUIRED') {
        clearSession();
        error.code = 'AUTH_SESSION_EXPIRED';
      }
      throw error;
    });
}

module.exports = {
  AI_AUTH_STORAGE_KEY,
  clearSession,
  getApiBaseUrl,
  getAiAuthToken,
  prewarmAiAuth,
  requestJson
};
