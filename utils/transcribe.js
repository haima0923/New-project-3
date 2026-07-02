const { getApiBaseUrl } = require('./api-client');

function getTranscribeEndpoint() {
  if (typeof getApp !== 'function') return '';
  const app = getApp();
  const globalData = app && app.globalData ? app.globalData : {};
  return globalData.aiTranscribeEndpoint || '';
}

function normalizeTranscribeResult(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      text: '',
      confidence: 0,
      provider: 'none',
      status: 'failed',
      message: '语音识别暂时不可用，请改用打字或粘贴。'
    };
  }
  return {
    text: payload.text || '',
    confidence: Number(payload.confidence || 0),
    provider: payload.provider || 'server',
    status: payload.status || (payload.text ? 'ok' : 'failed'),
    message: payload.message || ''
  };
}

function transcribeVoice({ tempFilePath }) {
  const endpoint = getTranscribeEndpoint();
  const baseUrl = getApiBaseUrl();
  if (!endpoint || !baseUrl) {
    return Promise.resolve({
      text: '',
      confidence: 0,
      provider: 'none',
      status: 'not_configured',
      message: '录音已保存，当前未配置语音转文字，请补充文字。'
    });
  }
  if (!tempFilePath) {
    return Promise.resolve({
      text: '',
      confidence: 0,
      provider: 'none',
      status: 'failed',
      message: '没有拿到录音文件，请重新按住说一遍。'
    });
  }

  return new Promise((resolve) => {
    wx.uploadFile({
      url: `${baseUrl}${endpoint}`,
      filePath: tempFilePath,
      name: 'file',
      timeout: 20000,
      success: (res) => {
        try {
          const payload = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          resolve(normalizeTranscribeResult(payload));
        } catch (error) {
          resolve({
            text: '',
            confidence: 0,
            provider: 'server',
            status: 'failed',
            message: '语音识别结果没读懂，请改用打字补充。'
          });
        }
      },
      fail: () => resolve({
        text: '',
        confidence: 0,
        provider: 'server',
        status: 'failed',
        message: '语音识别暂时不可用，请改用打字或粘贴。'
      })
    });
  });
}

module.exports = {
  normalizeTranscribeResult,
  transcribeVoice
};
