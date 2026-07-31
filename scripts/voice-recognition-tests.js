const assert = require('assert');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'utils', 'voice-recognition.js');

function createManager() {
  return {
    __recordVoiceFake: true,
    starts: [],
    stops: 0,
    callbackSnapshots: [],
    start(options) {
      this.starts.push(options);
      this.callbackSnapshots.push({
        onStart: this.onStart,
        onRecognize: this.onRecognize,
        onStop: this.onStop,
        onError: this.onError
      });
    },
    stop() {
      this.stops += 1;
    }
  };
}

function loadVoiceRecognition(manager, options = {}) {
  const previousWx = global.wx;
  const previousRequirePlugin = global.requirePlugin;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const pendingSettings = [];
  const pendingTimers = [];
  if (options.captureTimers) {
    global.setTimeout = (callback) => {
      const handle = {
        callback,
        cleared: false,
        unref() {}
      };
      pendingTimers.push(handle);
      return handle;
    };
    global.clearTimeout = (handle) => {
      if (handle) handle.cleared = true;
    };
  }
  global.requirePlugin = () => ({
    getRecordRecognitionManager: () => manager
  });
  global.wx = {
    getSetting(callbacks) {
      if (options.deferPermission) {
        pendingSettings.push(callbacks);
        return;
      }
      callbacks.success({
        authSetting: options.authSetting || { 'scope.record': true }
      });
    },
    authorize(callbacks) {
      if (options.authorizeFailure) callbacks.fail();
      else callbacks.success();
    }
  };
  delete require.cache[require.resolve(MODULE_PATH)];
  const voice = require(MODULE_PATH);
  return {
    manager,
    pendingSettings,
    pendingTimers,
    restore() {
      voice.cancelVoiceRecognition('TEST_CLEANUP');
      delete require.cache[require.resolve(MODULE_PATH)];
      if (previousWx === undefined) delete global.wx;
      else global.wx = previousWx;
      if (previousRequirePlugin === undefined) delete global.requirePlugin;
      else global.requirePlugin = previousRequirePlugin;
      global.setTimeout = previousSetTimeout;
      global.clearTimeout = previousClearTimeout;
    },
    voice
  };
}

function withVoice(manager, callback, options) {
  const runtime = loadVoiceRecognition(manager, options);
  try {
    callback(runtime.voice, runtime);
  } finally {
    runtime.restore();
  }
}

function testHappyFinalEvidence() {
  withVoice(createManager(), (voice, runtime) => {
    const events = [];
    voice.startVoiceRecognition({
      duration: 12000,
      onStart: (event) => events.push(['start', event]),
      onRecognize: (event) => events.push(['partial', event]),
      onStop: (event) => events.push(['stop', event]),
      onResult: (event) => events.push(['result', event]),
      onError: (event) => events.push(['error', event])
    });
    assert.strictEqual(runtime.manager.starts.length, 1);
    runtime.manager.onStart({ synthetic: true });
    runtime.manager.onRecognize({
      result: '赵姐礼品盒五百套',
      resultSequence: 1,
      synthetic: true
    });
    runtime.manager.onStop({
      result: '赵姐礼品盒五百套三块八一套',
      resultSequence: 2,
      synthetic: true
    });
    const result = events.find(([type]) => type === 'result')[1];
    assert.strictEqual(result.text, '赵姐礼品盒五百套三块八一套');
    assert.strictEqual(result.provider, 'fake-wechat-si');
    assert.strictEqual(result.voiceCompletionEvidence.status, 'COMPLETED');
    assert.strictEqual(result.voiceCompletionEvidence.isFinal, true);
    assert.strictEqual(
      result.voiceCompletionEvidence.evidenceSource,
      'FAKE_VOICE_FINAL_CALLBACK'
    );
    assert.strictEqual(result.voiceCompletionEvidence.transcriptSourceField, 'result');
    assert.strictEqual(events.filter(([type]) => type === 'result').length, 1);
    assert.strictEqual(voice.getVoiceRecognitionAudit().acceptedFinalCount, 1);
    assert.strictEqual(voice.validateVoiceCompletionEvidence(
      result.voiceCompletionEvidence,
      result.text,
      { inputChannel: 'VOICE_TRANSCRIPT' }
    ).valid, true);
  });
}

function testPartialsNeverBecomeFinalWithoutStopPayload() {
  withVoice(createManager(), (voice, runtime) => {
    let resultCount = 0;
    let errorCount = 0;
    voice.startVoiceRecognition({
      onResult: () => { resultCount += 1; },
      onError: () => { errorCount += 1; }
    });
    runtime.manager.onStart({});
    runtime.manager.onRecognize({ result: '只有部分文字' });
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'PARTIAL');
    runtime.manager.onStop({});
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(errorCount, 1);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'FAILED');
    assert.strictEqual(voice.getVoiceRecognitionAudit().evidence, null);
  });
}

function testMultiplePartialAndDuplicateFinal() {
  withVoice(createManager(), (voice, runtime) => {
    const results = [];
    voice.startVoiceRecognition({ onResult: (result) => results.push(result) });
    const callback = runtime.manager.onStop;
    runtime.manager.onStart({});
    runtime.manager.onRecognize({ result: '第一段', resultSequence: 1 });
    runtime.manager.onRecognize({ result: '第一段', resultSequence: 2 });
    runtime.manager.onRecognize({ result: '第二段', resultSequence: 3 });
    callback({ result: '完整结果', resultSequence: 4 });
    callback({ result: '完整结果', resultSequence: 5 });
    assert.strictEqual(results.length, 1);
    const audit = voice.getVoiceRecognitionAudit();
    assert.strictEqual(audit.partialCallbackCount, 2);
    assert.strictEqual(audit.finalCallbackInvocationCount, 2);
    assert(audit.audit.some((event) => [
      'DUPLICATE_FINAL_IGNORED',
      'UNBOUND_FINAL_IGNORED'
    ].includes(event.type)));
  });
}

function testProviderSequenceRegressionRejected() {
  withVoice(createManager(), (voice, runtime) => {
    let resultCount = 0;
    voice.startVoiceRecognition({ onResult: () => { resultCount += 1; } });
    runtime.manager.onStart({});
    runtime.manager.onRecognize({ result: '较新部分', resultSequence: 4 });
    runtime.manager.onRecognize({ result: '较旧部分', resultSequence: 3 });
    runtime.manager.onStop({ result: '倒退终稿', resultSequence: 2 });
    assert.strictEqual(resultCount, 0);
    const audit = voice.getVoiceRecognitionAudit();
    assert.strictEqual(audit.status, 'PARTIAL');
    assert.strictEqual(
      audit.audit.filter((event) => event.type === 'PROVIDER_SEQUENCE_REJECTED').length,
      2
    );
  });
}

function testEarlyRelease() {
  withVoice(createManager(), (voice, runtime) => {
    voice.startVoiceRecognition({});
    voice.stopVoiceRecognition();
    assert.strictEqual(runtime.manager.stops, 0);
    runtime.manager.onStart({});
    assert.strictEqual(runtime.manager.stops, 1);
  });
}

function testCancelBeforePermission() {
  withVoice(createManager(), (voice, runtime) => {
    let resultCount = 0;
    voice.startVoiceRecognition({ onResult: () => { resultCount += 1; } });
    voice.cancelVoiceRecognition('TEST_CANCEL_BEFORE_PERMISSION');
    runtime.pendingSettings[0].success({
      authSetting: { 'scope.record': true }
    });
    assert.strictEqual(runtime.manager.starts.length, 0);
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'CANCELLED');
  }, { deferPermission: true });
}

function testCancelAndErrorDoNotPromotePartial() {
  withVoice(createManager(), (voice, runtime) => {
    let resultCount = 0;
    voice.startVoiceRecognition({ onResult: () => { resultCount += 1; } });
    const callbacks = runtime.manager.callbackSnapshots[0];
    callbacks.onStart({});
    callbacks.onRecognize({ result: '取消前部分' });
    voice.cancelVoiceRecognition('TEST_CANCEL');
    callbacks.onStop({ result: '取消后迟到终稿' });
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'CANCELLED');
  });

  withVoice(createManager(), (voice, runtime) => {
    let resultCount = 0;
    voice.startVoiceRecognition({ onResult: () => { resultCount += 1; } });
    const callbacks = runtime.manager.callbackSnapshots[0];
    callbacks.onStart({});
    callbacks.onRecognize({ result: '错误前部分' });
    callbacks.onError({ message: 'provider failed' });
    callbacks.onStop({ result: '错误后迟到终稿' });
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'FAILED');
  });
}

function testExplicitTimeout() {
  withVoice(createManager(), (voice, runtime) => {
    let resultCount = 0;
    voice.startVoiceRecognition({ onResult: () => { resultCount += 1; } });
    runtime.manager.onStart({});
    runtime.manager.onRecognize({ result: '超时前部分' });
    runtime.manager.onError({ code: 'TIMEOUT', message: 'provider timeout' });
    runtime.manager.onStop({ result: '超时后迟到终稿' });
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'TIMED_OUT');
  });
}

function testTimeoutIsTerminalBeforeSynchronousStopFinal() {
  const manager = createManager();
  manager.stop = function stopWithSynchronousFinal() {
    this.stops += 1;
    if (typeof this.onStop === 'function') {
      this.onStop({ result: 'stop同步终稿' });
    }
  };
  withVoice(manager, (voice, runtime) => {
    let resultCount = 0;
    let errorCount = 0;
    voice.startVoiceRecognition({
      duration: 1000,
      onResult: () => { resultCount += 1; },
      onError: () => { errorCount += 1; }
    });
    runtime.manager.onStart({});
    const timer = runtime.pendingTimers.find((handle) => !handle.cleared);
    assert(timer);
    timer.callback();
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(errorCount, 1);
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'TIMED_OUT');
    assert.strictEqual(voice.getVoiceRecognitionAudit().evidence, null);
    assert(voice.getVoiceRecognitionAudit().audit.some(
      (event) => event.type === 'FINAL_AFTER_TERMINAL_IGNORED'
    ));
  }, { captureTimers: true });
}

function testStaleSessionAndSupersede() {
  withVoice(createManager(), (voice, runtime) => {
    const sessionAResults = [];
    const sessionBResults = [];
    voice.startVoiceRecognition({ onResult: (result) => sessionAResults.push(result) });
    runtime.manager.onStart({});
    voice.startVoiceRecognition({ onResult: (result) => sessionBResults.push(result) });
    assert.strictEqual(runtime.manager.starts.length, 1);
    assert.strictEqual(voice.getVoiceRecognitionAudit().waitingForProviderRelease, true);
    // Simulate the real singleton-manager behavior: the delayed A final is
    // delivered through manager's current callback property, not a saved
    // callback snapshot.
    runtime.manager.onStop({ result: '旧会话迟到' });
    assert.strictEqual(runtime.manager.starts.length, 2);
    runtime.manager.onStart({});
    runtime.manager.onStop({ result: '新会话最终结果' });
    assert.strictEqual(sessionAResults.length, 0);
    assert.strictEqual(sessionBResults.length, 1);
    assert.strictEqual(sessionBResults[0].text, '新会话最终结果');
    assert.strictEqual(
      sessionBResults[0].voiceCompletionEvidence.transcriptFingerprint,
      voice.createTranscriptFingerprint(
        sessionBResults[0].voiceCompletionEvidence.sessionId,
        '新会话最终结果'
      )
    );
  });
}

function testFingerprintAndManualInvalidation() {
  withVoice(createManager(), (voice, runtime) => {
    let result = null;
    voice.startVoiceRecognition({ onResult: (value) => { result = value; } });
    runtime.manager.onStart({});
    runtime.manager.onStop({ result: '最终语音文本' });
    const evidence = result.voiceCompletionEvidence;
    assert.strictEqual(voice.validateVoiceCompletionEvidence(
      evidence,
      '被修改的文本',
      { inputChannel: 'VOICE_TRANSCRIPT' }
    ).valid, false);
    assert.strictEqual(voice.validateVoiceCompletionEvidence(
      evidence,
      result.text,
      { inputChannel: 'MANUAL_TEXT' }
    ).valid, false);
    assert.strictEqual(voice.invalidateVoiceCompletionEvidence(
      evidence,
      'MANUAL_EDIT_AFTER_VOICE'
    ), true);
    assert.strictEqual(voice.validateVoiceCompletionEvidence(
      evidence,
      result.text,
      { inputChannel: 'VOICE_TRANSCRIPT' }
    ).valid, false);
  });
}

function testNoPermission() {
  withVoice(createManager(), (voice, runtime) => {
    let errorMessage = '';
    voice.startVoiceRecognition({
      onError: ({ message }) => {
        errorMessage = message;
      }
    });
    assert.strictEqual(runtime.manager.starts.length, 0);
    assert(errorMessage.includes('麦克风权限'));
    assert.strictEqual(voice.getVoiceRecognitionAudit().status, 'FAILED');
  }, { authSetting: { 'scope.record': false } });
}

async function testHybridPropagationEnablesNarrowStandardRoute() {
  const runtime = loadVoiceRecognition(createManager());
  const previousGetApp = global.getApp;
  const memoryStorage = {};
  const requestPaths = [];
  try {
    const completeVoiceTranscript = (text) => {
      let result = null;
      runtime.voice.startVoiceRecognition({
        onResult: (value) => { result = value; }
      });
      runtime.manager.onStart({ synthetic: true });
      runtime.manager.onStop({ result: text, synthetic: true });
      assert(result, 'Fake Voice final callback must produce a completed result');
      return result;
    };
    let finalResult = null;
    finalResult = completeVoiceTranscript('赵姐礼品盒五百套三块八一套');
    global.getApp = () => ({
      globalData: {
        aiAuthEnabled: true,
        aiParseEndpoint: '/api/ai/parse',
        apiBaseUrl: 'memory://voice-route-test'
      }
    });
    Object.assign(global.wx, {
      getStorageSync(key) { return memoryStorage[key]; },
      login(options) { options.success({ code: 'voice-route-test-code' }); },
      removeStorageSync(key) { delete memoryStorage[key]; },
      request(options) {
        const pathName = String(options.url || '').replace('memory://voice-route-test', '');
        requestPaths.push(pathName);
        if (pathName === '/api/auth/wechat-login') {
          options.success({
            statusCode: 200,
            data: {
              token: 'REDACTED_SYNTHETIC_TEST_TOKEN',
              expiresAt: '2099-01-01T00:00:00.000Z'
            }
          });
          return;
        }
        assert.strictEqual(pathName, '/api/ai/parse');
        options.success({
          statusCode: 200,
          data: {
            provider: 'e2e-fake-standard',
            intent: 'order',
            operation: 'create_order',
            fields: {
              amount: 1900,
              customerName: '赵姐',
              productName: '礼品盒',
              quantity: 500,
              unit: '套',
              unitPrice: 3.8
            },
            field_conflicts: [],
            low_confidence_fields: [],
            missing_fields: []
          }
        });
      },
      setStorageSync(key, value) { memoryStorage[key] = value; }
    });
    const aiParser = require('../utils/ai-parser');
    const { prewarmAiAuth } = require('../utils/api-client');
    await prewarmAiAuth();
    const basePayload = {
      text: finalResult.text,
      source: 'voice',
      inputChannel: 'VOICE_TRANSCRIPT',
      entrySurface: 'FULL_PAGE',
      context: 'home',
      state: {
        customers: [],
        orders: [],
        quotations: [],
        receivables: [],
        payments: [],
        todos: [],
        pendingNotes: []
      },
      reviewMode: 'standard',
      businessDate: '2026-07-15',
      businessTimezone: 'Asia/Shanghai',
      nowInstant: '2026-07-15T02:00:00.000Z'
    };
    const withoutEvidence = await aiParser.parseHybridInput(basePayload);
    const withEvidence = await aiParser.parseHybridInput(Object.assign({}, basePayload, {
      voiceCompletionEvidence: finalResult.voiceCompletionEvidence
    }));
    const forgedTyped = await aiParser.parseHybridInput(Object.assign({}, basePayload, {
      source: 'typed',
      inputChannel: 'MANUAL_TEXT',
      voiceCompletionEvidence: Object.assign({}, finalResult.voiceCompletionEvidence, {
        evidenceSource: 'FORGED_SOURCE',
        status: 'FORGED_STATUS'
      })
    }));
    const noRecordFinal = completeVoiceTranscript('今天天气不错，晚点出去走走');
    const noRecordResult = await aiParser.parseHybridInput(Object.assign({}, basePayload, {
      text: noRecordFinal.text,
      voiceCompletionEvidence: noRecordFinal.voiceCompletionEvidence
    }));
    const localOrderFinal = completeVoiceTranscript(
      '王总订水杯100个，5块5一个，明天交'
    );
    const localOrderResult = await aiParser.parseHybridInput(Object.assign({}, basePayload, {
      text: localOrderFinal.text,
      voiceCompletionEvidence: localOrderFinal.voiceCompletionEvidence
    }));
    assert.strictEqual(withoutEvidence.parse_route.decision, 'pending');
    assert.strictEqual(withEvidence.parse_route.decision, 'ai_standard');
    assert.strictEqual(withoutEvidence.ai_fallback.attempted, false);
    assert.strictEqual(withEvidence.ai_fallback.attempted, true);
    assert.strictEqual(withEvidence.ai_fallback.status, 'used');
    assert.strictEqual(withEvidence.intent, 'order');
    assert.strictEqual(withEvidence.operation, 'create_order');
    assert.strictEqual(
      requestPaths.filter((pathName) => pathName === '/api/ai/parse').length,
      1,
      '同一个可信final语音处理链只能发起一次Standard AI请求'
    );
    assert.strictEqual(noRecordResult.parse_route.decision, 'no_record');
    assert.strictEqual(noRecordResult.ai_fallback.attempted, false);
    assert.strictEqual(localOrderResult.parse_route.decision, 'local');
    assert.strictEqual(localOrderResult.ai_fallback.attempted, false);
    assert.strictEqual(
      requestPaths.filter((pathName) => pathName === '/api/ai/parse').length,
      1,
      '可信final闲聊和本地已解决订单均不得增加AI请求'
    );
    assert.strictEqual(
      withEvidence.parse_route.voice_completion_evidence_present,
      true
    );
    assert.strictEqual(
      withEvidence.parse_route.voice_completion_evidence_valid,
      true
    );
    assert.strictEqual(
      withEvidence.parse_route.voice_completion_evidence_source,
      'FAKE_VOICE_FINAL_CALLBACK'
    );
    assert.strictEqual(withEvidence.parse_route.voice_standard_eligible, true);
    assert(
      withEvidence.parse_route.voice_standard_reason_codes.includes(
        'VOICE_STANDARD_REVIEW_REQUIRED'
      )
    );
    assert.strictEqual(
      Object.keys(forgedTyped.parse_route).some(
        (key) => key.startsWith('voice_completion_evidence_')
      ),
      false
    );
    const persistedShape = JSON.stringify(withEvidence);
    assert(!persistedShape.includes(finalResult.voiceCompletionEvidence.sessionId));
    assert(!persistedShape.includes(
      finalResult.voiceCompletionEvidence.transcriptFingerprint
    ));
  } finally {
    if (previousGetApp === undefined) delete global.getApp;
    else global.getApp = previousGetApp;
    runtime.restore();
  }
}

async function run() {
  const tests = [
    testHappyFinalEvidence,
    testPartialsNeverBecomeFinalWithoutStopPayload,
    testMultiplePartialAndDuplicateFinal,
    testProviderSequenceRegressionRejected,
    testEarlyRelease,
    testCancelBeforePermission,
    testCancelAndErrorDoNotPromotePartial,
    testExplicitTimeout,
    testTimeoutIsTerminalBeforeSynchronousStopFinal,
    testStaleSessionAndSupersede,
    testFingerprintAndManualInvalidation,
    testNoPermission,
    testHybridPropagationEnablesNarrowStandardRoute
  ];
  for (const test of tests) await test();
  console.log(`语音最终转写Evidence专项通过：${tests.length}/${tests.length}。`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
