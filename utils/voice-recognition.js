let recognitionManager = null;
let activeHandlers = {};
let latestPartialText = '';
let managerStarted = false;
let pendingStop = false;

function normalizeRecognizedText(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return '';
  if (/^(未识别语音|未识别到语音|没有识别到语音|无法识别语音|语音识别失败)$/.test(cleanText)) return '';
  return cleanText;
}

function readTextFromPayload(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return normalizeRecognizedText(payload);
  if (Array.isArray(payload)) {
    return normalizeRecognizedText(payload.map(readTextFromPayload).filter(Boolean).join(''));
  }
  if (typeof payload !== 'object') return normalizeRecognizedText(payload);

  const fields = [
    'result',
    'text',
    'content',
    'recognitionResult',
    'recognizeResult',
    'voiceText',
    'transcription',
    'translateResult'
  ];

  for (const field of fields) {
    const value = payload[field];
    const text = readTextFromPayload(value);
    if (text) return text;
  }

  const nestedFields = ['detail', 'data', 'res'];
  for (const field of nestedFields) {
    const text = readTextFromPayload(payload[field]);
    if (text) return text;
  }

  return '';
}

function getPluginManager() {
  if (recognitionManager) return recognitionManager;
  if (typeof requirePlugin !== 'function') return null;
  try {
    const plugin = requirePlugin('WechatSI');
    if (!plugin || typeof plugin.getRecordRecognitionManager !== 'function') return null;
    recognitionManager = plugin.getRecordRecognitionManager();
    return recognitionManager;
  } catch (error) {
    return null;
  }
}

function isVoiceRecognitionAvailable() {
  return Boolean(getPluginManager());
}

function getMessage(error, fallback) {
  if (!error) return fallback;
  return error.msg || error.message || fallback;
}

function emitError(error, fallback) {
  const handler = activeHandlers.onError;
  if (typeof handler === 'function') {
    handler({
      status: 'failed',
      message: getMessage(error, fallback || '语音识别失败，请改用打字或粘贴。'),
      raw: error || null
    });
  }
}

function emitStart(payload) {
  if (typeof activeHandlers.onStart === 'function') {
    activeHandlers.onStart(payload || {});
  }
}

function emitStop(payload) {
  if (typeof activeHandlers.onStop === 'function') {
    activeHandlers.onStop(payload || {});
  }
}

function emitResult(text, payload) {
  const cleanText = normalizeRecognizedText(text);
  if (!cleanText) {
    emitError(payload, '没有听清楚，请重新按住说一遍。');
    return;
  }
  if (typeof activeHandlers.onResult === 'function') {
    activeHandlers.onResult({
      text: cleanText,
      confidence: 0,
      provider: 'wechat-si',
      status: 'ok',
      raw: payload || null
    });
  }
}

function bindManager(manager) {
  manager.onStart = (payload) => {
    latestPartialText = '';
    managerStarted = true;
    emitStart(payload);
    if (pendingStop) {
      pendingStop = false;
      stopVoiceRecognition();
    }
  };

  manager.onRecognize = (payload) => {
    latestPartialText = readTextFromPayload(payload) || latestPartialText;
    if (typeof activeHandlers.onRecognize === 'function') {
      activeHandlers.onRecognize({
        text: latestPartialText,
        raw: payload || null
      });
    }
  };

  manager.onStop = (payload) => {
    const finalText = readTextFromPayload(payload) || latestPartialText;
    managerStarted = false;
    pendingStop = false;
    emitStop(payload);
    emitResult(finalText, payload);
  };

  manager.onError = (payload) => {
    managerStarted = false;
    pendingStop = false;
    latestPartialText = '';
    emitError(payload, '语音识别失败，请改用打字或粘贴。');
  };
}

function startManager(manager, options) {
  latestPartialText = '';
  managerStarted = false;
  pendingStop = false;
  bindManager(manager);
  manager.start({
    duration: options.duration || 60000,
    lang: options.lang || 'zh_CN'
  });
}

function startVoiceRecognition(options = {}) {
  activeHandlers = options;
  const manager = getPluginManager();
  if (!manager) {
    emitError(null, '当前小程序还没配置语音识别，请改用打字或粘贴。');
    return false;
  }

  const start = () => {
    try {
      startManager(manager, options);
    } catch (error) {
      emitError(error, '语音识别启动失败，请改用打字或粘贴。');
    }
  };

  if (typeof wx === 'undefined' || typeof wx.getSetting !== 'function') {
    start();
    return true;
  }

  wx.getSetting({
    success: (res) => {
      const authSetting = (res && res.authSetting) || {};
      if (authSetting['scope.record'] === false) {
        emitError(null, '请先在微信设置里打开麦克风权限。');
        return;
      }
      if (authSetting['scope.record']) {
        start();
        return;
      }
      wx.authorize({
        scope: 'scope.record',
        success: start,
        fail: () => emitError(null, '没有麦克风权限，请改用打字或粘贴。')
      });
    },
    fail: start
  });

  return true;
}

function stopVoiceRecognition() {
  const manager = getPluginManager();
  if (!manager || typeof manager.stop !== 'function') return false;
  if (!managerStarted) {
    pendingStop = true;
    return true;
  }
  try {
    manager.stop();
    return true;
  } catch (error) {
    emitError(error, '语音识别结束失败，请改用打字或粘贴。');
    return false;
  }
}

module.exports = {
  isVoiceRecognitionAvailable,
  startVoiceRecognition,
  stopVoiceRecognition
};
