const path = require('path');
const { fork } = require('child_process');
const { safeClone } = require('../../../utils/record-state-diff');

function executeOrderRestart(spec, entries, orderId, attempt = 1) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'restart-worker.js'), [], {
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1'
      }),
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let response = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(new Error('Single-item order restart worker timed out'), {
        code: 'RESTART_PERSISTENCE_ERROR'
      }));
    }, 8000);
    child.once('message', (message) => {
      response = message;
      if (child.connected) child.disconnect();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!response || response.ok !== true || exitCode !== 0) {
        const error = new Error(response && response.error && response.error.message
          || 'Single-item order restart worker failed');
        error.code = response && response.error && response.error.code || 'RESTART_PERSISTENCE_ERROR';
        reject(error);
        return;
      }
      resolve(Object.assign({}, response.result, {
        newProcess: response.result.pid !== process.pid,
        workerExitAudit: { exitCode, exitObserved: true, signal: signal || '' }
      }));
    });
    child.send({ attempt, entries: safeClone(entries), orderId, spec: safeClone(spec) });
  });
}

module.exports = { executeOrderRestart };
