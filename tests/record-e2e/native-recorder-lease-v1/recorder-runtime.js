const { createControlledRecorderManager } = require('../voice-capture-v2/recorder-runtime');

function audioPayload(label, overrides = {}) {
  const suffix = String(label || 'unknown').toLowerCase();
  return Object.assign({
    duration: suffix === 'a' ? 1111 : 2222,
    fileSize: suffix === 'a' ? 11111 : 22222,
    tempFilePath: `wxfile://${suffix}-native-lease.mp3`
  }, overrides);
}

function proveControlledCallbackSnapshots() {
  const recorder = createControlledRecorderManager();
  const events = [];
  recorder.manager.onStart(() => events.push('A_START'));
  recorder.manager.onStop(() => events.push('A_STOP'));
  recorder.manager.onError(() => events.push('A_ERROR'));
  recorder.manager.start({ label: 'A' });
  recorder.manager.onStart(() => events.push('B_START'));
  recorder.manager.onStop(() => events.push('B_STOP'));
  recorder.manager.onError(() => events.push('B_ERROR'));
  recorder.manager.start({ label: 'B' });
  recorder.emitStart(0);
  recorder.emitStop(0, audioPayload('A'));
  recorder.emitError(0, 'operateRecorder:fail A');
  recorder.emitStart(1);
  recorder.emitStop(1, audioPayload('B'));
  recorder.emitError(1, 'operateRecorder:fail B');
  return {
    events,
    startCount: recorder.audit().startCount
  };
}

module.exports = {
  audioPayload,
  createControlledRecorderManager,
  proveControlledCallbackSnapshots
};
