// DIAGNOSTIC_ONLY: no WechatSI, ASR, parser, handoff, business, or storage.
const RECORDER_OPTIONS = Object.freeze({
  audioSource: 'auto',
  duration: 60000,
  encodeBitRate: 48000,
  format: 'mp3',
  numberOfChannels: 1,
  sampleRate: 16000
});

const TEST_LABELS = Object.freeze({
  A: 'TEST-A 立即说',
  B: 'TEST-B 等1秒再说'
});

let recorderManager = null;
let audioContext = null;
let sessionSequence = 0;

function now() {
  return Date.now();
}

function compactEvidence(session, stopPayload, recorderOnStopAt) {
  const duration = Number(stopPayload && stopPayload.duration || 0);
  const touchStartAt = Number(session.touchStartAt || 0);
  const touchEndAt = Number(session.touchEndAt || 0);
  const recorderStartCalledAt = Number(session.recorderStartCalledAt || 0);
  const recorderOnStartAt = Number(session.recorderOnStartAt || 0);
  const pressDuration = touchEndAt > touchStartAt ? touchEndAt - touchStartAt : 0;
  return Object.freeze({
    diagnosticOnly: true,
    sessionId: session.sessionId,
    testId: session.testId,
    testLabel: TEST_LABELS[session.testId],
    phrase: '冯总订水杯137个，每个5元，8月15日交',
    recorderOptions: RECORDER_OPTIONS,
    touchStartAt,
    recorderStartCalledAt,
    recorderOnStartAt,
    touchEndAt,
    recorderOnStopAt,
    startCallDelay: recorderStartCalledAt - touchStartAt,
    realReadyDelay: recorderOnStartAt ? recorderOnStartAt - touchStartAt : null,
    pressDuration,
    reportedDuration: duration,
    recordedDurationDifference: duration ? pressDuration - duration : null,
    duration,
    fileSize: Number(stopPayload && stopPayload.fileSize || 0) || null,
    tempFilePath: String(stopPayload && stopPayload.tempFilePath || ''),
    rawOnStopFields: Object.keys(stopPayload || {}).sort()
  });
}

function evidenceSummary(evidence) {
  if (!evidence) return '尚未录制';
  return [
    `startCallDelay=${evidence.startCallDelay}ms`,
    `realReadyDelay=${evidence.realReadyDelay}ms`,
    `pressDuration=${evidence.pressDuration}ms`,
    `reportedDuration=${evidence.reportedDuration}ms`,
    `difference=${evidence.recordedDurationDifference}ms`,
    `fileSize=${evidence.fileSize || '未提供'}`,
    `tempFilePath=${evidence.tempFilePath || '未提供'}`
  ].join('\n');
}

function recorderErrorEvidence(error) {
  const payload = error && typeof error === 'object' ? error : {};
  return Object.freeze({
    at: now(),
    errCode: payload.errCode == null ? null : payload.errCode,
    errMsg: String(payload.errMsg || payload.message || error || 'UNKNOWN'),
    fields: Object.keys(payload).sort(),
    raw: payload
  });
}

Page({
  data: {
    activeTest: 'A',
    activeTestLabel: TEST_LABELS.A,
    authorized: false,
    recorderReady: false,
    isPressing: false,
    recorderOptionsText: JSON.stringify(RECORDER_OPTIONS),
    status: 'IDLE',
    statusText: '先预先授权，再选择一条测试。',
    lastErrorText: '',
    testASummary: '尚未录制',
    testBSummary: '尚未录制'
  },

  onLoad() {
    recorderManager = wx.getRecorderManager();
    this.currentSession = null;
    this.results = { A: null, B: null };
    this.bindRecorderEvents();
    this.resetNativeRecorder({ silent: true });
    this.refreshPermission();
  },

  onHide() {
    this.stopForLifecycle('PAGE_HIDDEN');
  },

  onUnload() {
    this.stopForLifecycle('PAGE_UNLOADED');
    if (audioContext && typeof audioContext.destroy === 'function') audioContext.destroy();
    audioContext = null;
  },

  bindRecorderEvents() {
    recorderManager.onStart(() => {
      const session = this.currentSession;
      if (!session || session.terminal) return;
      session.recorderOnStartAt = now();
      if (session.stopWhenStarted) {
        recorderManager.stop();
        this.setData({
          status: 'STOPPING',
          statusText: `${TEST_LABELS[session.testId]}：手指已松开，Recorder 启动后立即安全停止`
        });
        return;
      }
      this.setData({
        status: 'RECORDING',
        statusText: `${TEST_LABELS[session.testId]}：原生 RecorderManager 已开始录音`
      });
    });

    recorderManager.onStop((payload) => {
      const session = this.currentSession;
      if (!session && this.resettingRecorder) {
        this.resettingRecorder = false;
        this.setData({
          recorderReady: true,
          statusText: '原生 Recorder 已清理，可以开始成对测试。'
        });
        return;
      }
      if (!session || session.terminal) return;
      session.terminal = true;
      const evidence = compactEvidence(session, payload, now());
      this.results[session.testId] = evidence;
      this.currentSession = null;
      this.setData({
        isPressing: false,
        status: 'RECORDED',
        statusText: `${TEST_LABELS[session.testId]} 已生成原始录音，请立即播放检查开头。`,
        testASummary: evidenceSummary(this.results.A),
        testBSummary: evidenceSummary(this.results.B)
      });
      console.info('[VOICE_CAPTURE_V2_POC][RecorderManager.onStop]', JSON.stringify(evidence));
    });

    recorderManager.onError((error) => {
      const session = this.currentSession;
      const idleErrorMessage = String(error && (error.errMsg || error.message) || '');
      if (!session && /recorder not start/i.test(idleErrorMessage)) {
        this.resettingRecorder = false;
        this.setData({
          recorderReady: true,
          statusText: '原生 Recorder 当前空闲，可以开始成对测试。'
        });
        return;
      }
      if (!session && this.resettingRecorder) {
        this.resettingRecorder = false;
        this.setData({
          recorderReady: true,
          statusText: '原生 Recorder 当前空闲，可以开始成对测试。'
        });
        return;
      }
      if (session) session.terminal = true;
      const diagnosticError = recorderErrorEvidence(error);
      this.lastError = diagnosticError;
      this.currentSession = null;
      this.setData({
        isPressing: false,
        status: 'ERROR',
        statusText: `录音失败：${diagnosticError.errMsg}`,
        lastErrorText: JSON.stringify(diagnosticError, null, 2)
      });
      console.error('[VOICE_CAPTURE_V2_POC][RecorderManager.onError]', JSON.stringify(diagnosticError));
      if (/is recording or paused/i.test(diagnosticError.errMsg)) {
        this.resetNativeRecorder({ silent: true });
      }
    });
  },

  resetNativeRecorder({ silent = false } = {}) {
    if (!recorderManager || this.currentSession) return;
    this.resettingRecorder = true;
    this.setData({
      recorderReady: false,
      statusText: silent ? '正在清理原生 Recorder 状态…' : '正在停止残留录音，请稍候…'
    });
    try {
      recorderManager.stop();
    } catch (error) {
      this.resettingRecorder = false;
      this.setData({ recorderReady: true });
    }
    setTimeout(() => {
      if (!this.resettingRecorder) return;
      this.resettingRecorder = false;
      this.setData({
        recorderReady: true,
        statusText: '原生 Recorder 重置完成，可以重新按住录音。'
      });
    }, 400);
  },

  resetRecorderTap() {
    this.resetNativeRecorder({ silent: false });
  },

  refreshPermission() {
    wx.getSetting({
      success: (result) => this.setData({
        authorized: Boolean(result && result.authSetting && result.authSetting['scope.record'])
      })
    });
  },

  authorizeMicrophone() {
    wx.authorize({
      scope: 'scope.record',
      success: () => this.setData({
        authorized: true,
        statusText: '麦克风已授权。现在可执行 TEST-A / TEST-B。'
      }),
      fail: () => this.setData({
        authorized: false,
        statusText: '麦克风未授权，请到微信设置中开启。'
      })
    });
  },

  chooseTest(event) {
    if (this.currentSession) return;
    const testId = String(event.currentTarget.dataset.test || 'A');
    if (!TEST_LABELS[testId]) return;
    this.setData({ activeTest: testId, activeTestLabel: TEST_LABELS[testId] });
  },

  touchStart() {
    if (!this.data.authorized) {
      wx.showToast({ title: '请先预先授权麦克风', icon: 'none' });
      return;
    }
    if (this.currentSession) return;
    if (!this.data.recorderReady) {
      wx.showToast({ title: '正在清理录音状态，请稍候', icon: 'none' });
      return;
    }
    sessionSequence += 1;
    const session = {
      sessionId: `recorder-poc-${sessionSequence}`,
      testId: this.data.activeTest,
      terminal: false,
      touchStartAt: now(),
      recorderStartCalledAt: 0,
      recorderOnStartAt: 0,
      touchEndAt: 0
    };
    this.currentSession = session;
    session.recorderStartCalledAt = now();
    try {
      recorderManager.start(RECORDER_OPTIONS);
    } catch (error) {
      const diagnosticError = recorderErrorEvidence(error);
      session.terminal = true;
      this.lastError = diagnosticError;
      this.currentSession = null;
      this.setData({
        isPressing: false,
        status: 'ERROR',
        statusText: `录音启动异常：${diagnosticError.errMsg}`,
        lastErrorText: JSON.stringify(diagnosticError, null, 2)
      });
      return;
    }
    this.setData({
      isPressing: true,
      status: 'STARTING',
      statusText: `${TEST_LABELS[session.testId]}：touchstart，立即调用 RecorderManager.start()`
    });
  },

  touchEnd() {
    const session = this.currentSession;
    if (!session || session.terminal || session.touchEndAt) return;
    session.touchEndAt = now();
    if (!session.recorderOnStartAt) {
      session.stopWhenStarted = true;
      this.setData({
        isPressing: false,
        status: 'WAITING_FOR_START',
        statusText: `${TEST_LABELS[session.testId]}：手指已松开，等待 Recorder 启动后安全停止`
      });
      return;
    }
    recorderManager.stop();
    this.setData({
      isPressing: false,
      status: 'STOPPING',
      statusText: `${TEST_LABELS[session.testId]}：等待 RecorderManager.onStop()`
    });
  },

  touchCancel() {
    this.touchEnd();
  },

  stopForLifecycle(reason) {
    const session = this.currentSession;
    if (!session || session.terminal) return;
    session.touchEndAt = session.touchEndAt || now();
    session.lifecycleReason = reason;
    recorderManager.stop();
  },

  playTest(event) {
    const testId = String(event.currentTarget.dataset.test || 'A');
    const evidence = this.results && this.results[testId];
    if (!evidence || !evidence.tempFilePath) {
      wx.showToast({ title: '这条还没有录音文件', icon: 'none' });
      return;
    }
    if (audioContext && typeof audioContext.destroy === 'function') audioContext.destroy();
    audioContext = wx.createInnerAudioContext();
    audioContext.src = evidence.tempFilePath;
    audioContext.onError((error) => {
      wx.showToast({ title: `播放失败：${String(error && error.errMsg || '')}`, icon: 'none' });
    });
    audioContext.play();
  },

  copyEvidence() {
    const payload = {
      diagnosticOnly: true,
      recorderOptions: RECORDER_OPTIONS,
      lastError: this.lastError || null,
      testA: this.results && this.results.A || null,
      testB: this.results && this.results.B || null
    };
    wx.setClipboardData({
      data: JSON.stringify(payload, null, 2),
      success: () => wx.showToast({ title: '两条证据已复制', icon: 'none' })
    });
  }
});
