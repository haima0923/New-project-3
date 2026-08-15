function createPermissionController(wx, mode = 'GRANTED') {
  const originalGetSetting = wx.getSetting;
  const originalAuthorize = wx.authorize;
  const pendingSettings = [];
  const pendingAuthorizations = [];
  const audit = [];
  let permissionGranted = mode === 'GRANTED';

  wx.getSetting = (callbacks = {}) => {
    audit.push({ type: 'GET_SETTING', mode });
    if (permissionGranted) {
      if (typeof callbacks.success === 'function') {
        callbacks.success({ authSetting: { 'scope.record': true } });
      }
      return;
    }
    if (mode === 'DENIED') {
      if (typeof callbacks.success === 'function') {
        callbacks.success({ authSetting: { 'scope.record': false } });
      }
      return;
    }
    pendingSettings.push(callbacks);
  };

  wx.authorize = (callbacks = {}) => {
    audit.push({ type: 'AUTHORIZE', mode });
    if (mode === 'GRANTED') {
      if (typeof callbacks.success === 'function') callbacks.success({});
      return;
    }
    if (mode === 'DENIED') {
      if (typeof callbacks.fail === 'function') callbacks.fail({ errMsg: 'auth deny' });
      return;
    }
    pendingAuthorizations.push(callbacks);
  };

  return {
    audit() {
      return {
        events: audit.slice(),
        pendingAuthorizations: pendingAuthorizations.length,
        pendingSettings: pendingSettings.length
      };
    },
    releaseGranted() {
      const setting = pendingSettings.shift();
      if (setting && typeof setting.success === 'function') {
        permissionGranted = true;
        setting.success({ authSetting: { 'scope.record': true } });
        return true;
      }
      const authorization = pendingAuthorizations.shift();
      if (authorization && typeof authorization.success === 'function') {
        permissionGranted = true;
        authorization.success({});
        return true;
      }
      return false;
    },
    releaseDenied() {
      const setting = pendingSettings.shift();
      if (setting && typeof setting.success === 'function') {
        setting.success({ authSetting: { 'scope.record': false } });
        return true;
      }
      const authorization = pendingAuthorizations.shift();
      if (authorization && typeof authorization.fail === 'function') {
        authorization.fail({ errMsg: 'authorize:fail controlled denial' });
        return true;
      }
      return false;
    },
    releaseNeedsAuthorize() {
      const setting = pendingSettings.shift();
      if (!setting || typeof setting.success !== 'function') return false;
      setting.success({ authSetting: {} });
      return true;
    },
    // Page/Input construction probes permission before the current gesture.
    // Readiness contracts must release the capture's newest callback, never an
    // unrelated page-initialization probe left at the head of the queue.
    releaseLatestNeedsAuthorize() {
      const setting = pendingSettings.pop();
      if (!setting || typeof setting.success !== 'function') return false;
      setting.success({ authSetting: {} });
      return true;
    },
    releaseLatestGranted() {
      const authorization = pendingAuthorizations.pop();
      if (authorization && typeof authorization.success === 'function') {
        permissionGranted = true;
        authorization.success({});
        return true;
      }
      const setting = pendingSettings.pop();
      if (!setting || typeof setting.success !== 'function') return false;
      permissionGranted = true;
      setting.success({ authSetting: { 'scope.record': true } });
      return true;
    },
    releaseLatestDenied() {
      const authorization = pendingAuthorizations.pop();
      if (authorization && typeof authorization.fail === 'function') {
        authorization.fail({ errMsg: 'authorize:fail controlled denial' });
        return true;
      }
      const setting = pendingSettings.pop();
      if (!setting || typeof setting.success !== 'function') return false;
      setting.success({ authSetting: { 'scope.record': false } });
      return true;
    },
    restore() {
      wx.getSetting = originalGetSetting;
      wx.authorize = originalAuthorize;
    }
  };
}

function createControlledVoiceManager() {
  const starts = [];
  const stops = [];
  let currentBindings = null;

  const manager = {
    __recordVoiceFake: true,
    onStart: null,
    onRecognize: null,
    onStop: null,
    onError: null,
    start(options = {}) {
      currentBindings = {
        onError: manager.onError,
        onRecognize: manager.onRecognize,
        onStart: manager.onStart,
        onStop: manager.onStop
      };
      starts.push({ options: Object.assign({}, options), bindings: currentBindings });
    },
    stop() {
      stops.push({ startCount: starts.length });
    }
  };

  function session(index) {
    return starts[index === undefined ? starts.length - 1 : index] || null;
  }

  function invoke(index, key, payload) {
    const target = session(index);
    if (!target || typeof target.bindings[key] !== 'function') return false;
    target.bindings[key](payload);
    return true;
  }

  return {
    audit() {
      return {
        startCount: starts.length,
        stopCount: stops.length,
        sessionIds: starts.map((entry) => String(entry.options.recordVoiceSessionId || ''))
      };
    },
    emitError(index, code = 'VOICE_ERROR') {
      return invoke(index, 'onError', { code, message: code, synthetic: true });
    },
    emitFinal(index, text, resultSequence = 2) {
      return invoke(index, 'onStop', { result: text, resultSequence, synthetic: true });
    },
    emitPartial(index, text, resultSequence = 1) {
      return invoke(index, 'onRecognize', { result: text, resultSequence, synthetic: true });
    },
    emitStart(index) {
      return invoke(index, 'onStart', { synthetic: true });
    },
    manager,
    plugin: {
      getRecordRecognitionManager() { return manager; }
    }
  };
}

module.exports = {
  createControlledVoiceManager,
  createPermissionController
};
