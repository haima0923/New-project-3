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
    let response = null;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`Case worker timed out after ${timeoutMs}ms`);
      error.code = 'AUTOMATION_DRIVER_ERROR';
      reject(error);
    }, timeoutMs);
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
        const error = new Error(
          response && response.error && response.error.message
          || `Case worker exited without a successful result (${exitCode}, ${signal || 'no-signal'})`
        );
        error.code = response && response.error && response.error.code
          || 'AUTOMATION_DRIVER_ERROR';
        error.finalAudit = response && response.error && response.error.finalAudit || null;
        error.parserObservation = response && response.error
          && response.error.parserObservation || null;
        error.parserObservationCollectionFailure = response && response.error
          && response.error.parserObservationCollectionFailure || null;
        error.productionPathObservation = response && response.error
          && response.error.productionPathObservation || null;
        error.secondaryError = response && response.error && response.error.secondaryError || null;
        error.workerExitAudit = {
          exitCode,
          exitObserved: true,
          ipcClosed: child.connected === false,
          pid: child.pid,
          signal: signal || ''
        };
        error.workerStack = response && response.error && response.error.stack || '';
        reject(error);
        return;
      }
      resolve(Object.assign({}, response.result, {
        workerExitAudit: {
          exitCode,
          exitObserved: true,
          ipcClosed: child.connected === false,
          pid: child.pid,
          signal: signal || ''
        }
      }));
    });
    child.send(safeClone(payload));
  });
}

module.exports = {
  runCaseWorker
};
