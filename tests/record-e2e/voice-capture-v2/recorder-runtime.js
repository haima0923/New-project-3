function createControlledRecorderManager() {
  const calls = { starts: [], stops: [] };
  const listeners = { error: null, start: null, stop: null };

  const manager = {
    onError(callback) { listeners.error = callback; },
    onStart(callback) { listeners.start = callback; },
    onStop(callback) { listeners.stop = callback; },
    start(options = {}) {
      calls.starts.push({
        options: Object.assign({}, options),
        listeners: Object.assign({}, listeners)
      });
    },
    stop() {
      calls.stops.push({ startCount: calls.starts.length });
    }
  };

  function startAt(index) {
    return calls.starts[index === undefined ? calls.starts.length - 1 : index] || null;
  }

  function emit(index, type, payload) {
    const entry = startAt(index);
    const callback = entry && entry.listeners[type] || listeners[type];
    if (typeof callback !== 'function') return false;
    callback(payload || {});
    return true;
  }

  return {
    audit() {
      return {
        options: calls.starts.map((entry) => Object.assign({}, entry.options)),
        startCount: calls.starts.length,
        stopCount: calls.stops.length
      };
    },
    emitError(index, errMsg = 'operateRecorder:fail controlled error') {
      return emit(index, 'error', { errMsg });
    },
    emitStart(index) {
      return emit(index, 'start', {});
    },
    emitStop(index, payload = {}) {
      return emit(index, 'stop', Object.assign({
        duration: 1800,
        fileSize: 12000,
        tempFilePath: 'wxfile://controlled-vcap.mp3'
      }, payload));
    },
    manager
  };
}

function createPermissionController(wx, mode = 'GRANTED') {
  const originalGetSetting = wx.getSetting;
  const originalAuthorize = wx.authorize;
  const pendingAuthorizations = [];
  let granted = mode === 'GRANTED';
  const events = [];

  wx.getSetting = (callbacks = {}) => {
    events.push('GET_SETTING');
    if (typeof callbacks.success === 'function') {
      callbacks.success({ authSetting: { 'scope.record': granted } });
    }
  };

  wx.authorize = (callbacks = {}) => {
    events.push('AUTHORIZE');
    if (mode === 'DENIED') {
      if (typeof callbacks.fail === 'function') callbacks.fail({ errMsg: 'authorize:fail auth deny' });
      return;
    }
    if (mode === 'FIRST_AUTH') {
      pendingAuthorizations.push(callbacks);
      return;
    }
    granted = true;
    if (typeof callbacks.success === 'function') callbacks.success({});
  };

  return {
    audit() {
      return { events: events.slice(), granted, pending: pendingAuthorizations.length };
    },
    releaseGranted() {
      const callbacks = pendingAuthorizations.shift();
      if (!callbacks) return false;
      granted = true;
      if (typeof callbacks.success === 'function') callbacks.success({});
      return true;
    },
    restore() {
      wx.getSetting = originalGetSetting;
      wx.authorize = originalAuthorize;
    }
  };
}

function createLegacyWechatSiManager() {
  const listeners = {};
  const calls = { starts: 0, stops: 0 };
  const manager = {
    onError: null,
    onRecognize: null,
    onStart: null,
    onStop: null,
    start() {
      calls.starts += 1;
      listeners.onError = manager.onError;
      listeners.onRecognize = manager.onRecognize;
      listeners.onStart = manager.onStart;
      listeners.onStop = manager.onStop;
    },
    stop() { calls.stops += 1; }
  };
  return {
    audit() { return { startCount: calls.starts, stopCount: calls.stops }; },
    manager,
    plugin: { getRecordRecognitionManager() { return manager; } }
  };
}

module.exports = {
  createControlledRecorderManager,
  createLegacyWechatSiManager,
  createPermissionController
};
