const path = require('path');
const { fork } = require('child_process');
const { getStateFingerprint, safeClone } = require('../../../utils/record-state-diff');

function executeRestart(spec, entries, primaryBootId, attempt = 1) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'restart-worker.js'), [], {
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1'
      }),
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('Restart worker timed out'), {
        code: 'RESTART_PERSISTENCE_ERROR'
      }));
    }, 5000);
    child.once('message', (message) => {
      clearTimeout(timer);
      child.disconnect();
      if (!message || !message.ok) {
        const error = new Error(message && message.error && message.error.message || 'Restart worker failed');
        error.code = message && message.error && message.error.code || 'RESTART_PERSISTENCE_ERROR';
        reject(error);
        return;
      }
      const result = message.result;
      resolve({
        audit: result.audit,
        newRuntimeInstance: result.bootId !== primaryBootId,
        primaryBootId,
        restartBootId: result.bootId,
        restartPid: result.pid,
        state: safeClone(result.state),
        stateFingerprint: getStateFingerprint(result.state),
        status: safeClone(result.status),
        storageEntries: safeClone(result.storageEntries)
      });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.send({ attempt, entries: safeClone(entries), spec: safeClone(spec) });
  });
}

module.exports = {
  executeRestart
};
