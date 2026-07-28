const path = require('path');
const { fork } = require('child_process');
const { safeClone } = require('../../../utils/record-state-diff');

function runCaseWorker(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'worker.js'), [], {
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1'
      }),
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const timeoutMs = Number(options.timeoutMs || 15000);
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`Case worker timed out after ${timeoutMs}ms`);
      error.code = 'AUTOMATION_DRIVER_ERROR';
      reject(error);
    }, timeoutMs);
    child.once('message', (message) => {
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      if (!message || message.ok !== true) {
        const error = new Error(message && message.error && message.error.message || 'Case worker failed');
        error.code = message && message.error && message.error.code || 'AUTOMATION_DRIVER_ERROR';
        error.workerStack = message && message.error && message.error.stack || '';
        reject(error);
        return;
      }
      resolve(message.result);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.send(safeClone(payload));
  });
}

module.exports = {
  runCaseWorker
};
