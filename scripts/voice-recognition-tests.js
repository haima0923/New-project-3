const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadVoiceRecognition(manager, authSetting = { 'scope.record': true }) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils/voice-recognition.js'), 'utf8');
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require,
    requirePlugin: () => ({
      getRecordRecognitionManager: () => manager
    }),
    wx: {
      getSetting({ success }) {
        success({ authSetting });
      },
      authorize({ success }) {
        success();
      }
    }
  };
  vm.runInNewContext(source, context, { filename: 'voice-recognition.js' });
  return module.exports;
}

function createManager() {
  return {
    starts: [],
    stops: 0,
    start(options) {
      this.starts.push(options);
    },
    stop() {
      this.stops += 1;
    }
  };
}

function testHappyPath() {
  const manager = createManager();
  const voice = loadVoiceRecognition(manager);
  const events = [];
  const started = voice.startVoiceRecognition({
    duration: 12000,
    onStart: () => events.push('start'),
    onRecognize: ({ text }) => events.push(`partial:${text}`),
    onStop: () => events.push('stop'),
    onResult: ({ text, provider }) => events.push(`result:${provider}:${text}`),
    onError: ({ message }) => events.push(`error:${message}`)
  });

  assert(started === true, '有插件和录音权限时应能开始语音识别');
  assert(manager.starts.length === 1, '应调用微信语音识别开始方法');
  assert(manager.starts[0].duration === 12000, '应保留调用方提供的录音时长');
  assert(manager.starts[0].lang === 'zh_CN', '应使用中文识别');

  manager.onStart({});
  manager.onRecognize({ result: '张总订了三百个杯子' });
  manager.onStop({ result: '张总订了三百个杯子，单价五元' });

  assert(events.includes('start'), '应在开始后通知页面更新录音状态');
  assert(events.includes('partial:张总订了三百个杯子'), '应把实时识别内容传回页面');
  assert(events.includes('stop'), '应在松开后通知页面进入整理状态');
  assert(events.includes('result:wechat-si:张总订了三百个杯子，单价五元'), '应把最终文本传回确认卡链路');
}

function testEarlyRelease() {
  const manager = createManager();
  const voice = loadVoiceRecognition(manager);
  voice.startVoiceRecognition({});
  voice.stopVoiceRecognition();
  assert(manager.stops === 0, '识别尚未真正开始时不能直接停止');
  manager.onStart({});
  assert(manager.stops === 1, '用户过快松手时，识别真正开始后也应立刻停止');
}

function testNoPermission() {
  const manager = createManager();
  const voice = loadVoiceRecognition(manager, { 'scope.record': false });
  let errorMessage = '';
  voice.startVoiceRecognition({
    onError: ({ message }) => {
      errorMessage = message;
    }
  });
  assert(manager.starts.length === 0, '没有麦克风权限时不能开始识别');
  assert(errorMessage.includes('麦克风权限'), '没有权限时应给出用户能理解的提示');
}

function run() {
  testHappyPath();
  testEarlyRelease();
  testNoPermission();
  console.log('语音识别链路测试通过：正常识别、过快松手、麦克风权限均已覆盖。');
}

run();
