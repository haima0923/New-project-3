function getApiBaseUrl() {
  if (typeof getApp !== 'function') return '';
  const app = getApp();
  const globalData = app && app.globalData ? app.globalData : {};
  return (globalData.apiBaseUrl || '').replace(/\/$/, '');
}

function requestJson(path, data, timeout) {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return Promise.reject(new Error('API base URL is not configured'));

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${path}`,
      method: 'POST',
      data,
      timeout: timeout || 12000,
      header: {
        'content-type': 'application/json'
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
          return;
        }
        reject(new Error(`Request failed with status ${res.statusCode}`));
      },
      fail: reject
    });
  });
}

module.exports = {
  getApiBaseUrl,
  requestJson
};
