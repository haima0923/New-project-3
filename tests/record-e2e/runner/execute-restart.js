const path = require('path');
const { fork } = require('child_process');
const { getStateFingerprint, safeClone } = require('../../../utils/record-state-diff');

function executeRestart(spec, entries, primaryBootId, primaryPid, attempt = 1, options = {}) {
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
    let response = null;
    let settled = false;
    child.once('message', (message) => {
      response = message;
      child.disconnect();
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
      if (!response || !response.ok || exitCode !== 0) {
        const error = new Error(
          response && response.error && response.error.message || 'Restart worker failed'
        );
        error.code = response && response.error && response.error.code
          || 'RESTART_PERSISTENCE_ERROR';
        error.finalAudit = response && response.error && response.error.finalAudit || null;
        error.secondaryError = response && response.error
          && response.error.secondaryError || null;
        error.workerExitAudit = {
          exitCode,
          exitObserved: true,
          ipcClosed: child.connected === false,
          pid: child.pid,
          signal: signal || ''
        };
        reject(error);
        return;
      }
      const result = response.result;
      resolve({
        audit: result.audit,
        newRuntimeInstance: result.bootId !== primaryBootId && result.pid !== primaryPid,
        primaryBootId,
        primaryPid,
        restartBootId: result.bootId,
        restartPid: result.pid,
        state: safeClone(result.state),
        stateFingerprint: getStateFingerprint(result.state),
        status: safeClone(result.status),
        storageEntries: safeClone(result.storageEntries),
        workerExitAudit: {
          exitCode,
          exitObserved: true,
          ipcClosed: child.connected === false,
          signal: signal || ''
        }
      });
    });
    child.send({
      attempt,
      entries: safeClone(entries),
      hooks: safeClone(options.hooks || {}),
      spec: safeClone(spec)
    });
  });
}

module.exports = {
  executeRestart
};
