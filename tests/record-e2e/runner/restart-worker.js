const path = require('path');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createCaseRuntime } = require('./create-case-runtime');
const { ROOT } = require('./constants');
const { collectFinalAudit } = require('./execute-case');
const { sanitizeEvidence } = require('./sanitize-evidence');

process.on('message', (message) => {
  const spec = safeClone(message.spec);
  const fixtureBefore = stableHash(spec.initialState.state, 'fixture-before-v1');
  let runtime = null;
  let appDefinition = null;
  let result = null;
  let finalAudit = null;
  let primaryError = null;
  try {
    runtime = createCaseRuntime(spec, {
      attempt: message.attempt,
      initialEntries: message.entries
    });
    global.App = (definition) => { appDefinition = definition; };
    if (message.hooks && message.hooks.forceErrorAfterRuntime) {
      throw Object.assign(new Error('Forced restart worker error after runtime bootstrap'), {
        code: 'RESTART_PERSISTENCE_ERROR'
      });
    }
    const appPath = path.join(ROOT, 'app.js');
    delete require.cache[require.resolve(appPath)];
    require(appPath);
    if (!appDefinition) throw new Error('App definition was not captured');
    const app = {
      globalData: JSON.parse(JSON.stringify(appDefinition.globalData || {}))
    };
    Object.keys(appDefinition).forEach((key) => {
      if (key !== 'globalData' && typeof appDefinition[key] === 'function') {
        app[key] = appDefinition[key].bind(app);
      }
    });
    global.getApp = () => app;
    if (typeof app.onLaunch === 'function') app.onLaunch();
    const storage = require('../../../utils/storage');
    const state = storage.getState({ writerSource: 'APP_LAUNCH_INITIALIZE' });
    const status = storage.getRecordStorageInfrastructureStatus();
    result = {
      bootId: runtime.bootId,
      pid: process.pid,
      state,
      status,
      storageEntries: runtime.fakeWx.getEntries()
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (runtime) {
      try {
        finalAudit = collectFinalAudit(runtime, spec, fixtureBefore);
      } catch (auditError) {
        finalAudit = auditError.finalAudit || finalAudit;
        if (primaryError) {
          auditError.secondaryError = {
            code: primaryError.code || 'RESTART_PERSISTENCE_ERROR',
            message: primaryError.message
          };
        }
        primaryError = auditError;
      }
      runtime.dispose();
    } else {
      finalAudit = {
        bootstrapAudit: {
          auditPerformed: true,
          runtimeCreated: false
        }
      };
      primaryError = Object.assign(
        new Error(primaryError && primaryError.message || 'Restart runtime bootstrap failed'),
        {
          code: 'ISOLATION_AUDIT_NOT_EXECUTED',
          secondaryError: primaryError && {
            code: primaryError.code || 'RESTART_PERSISTENCE_ERROR',
            message: primaryError.message
          }
        }
      );
    }
  }
  if (process.send) {
    if (primaryError) {
      process.send({
        ok: false,
        error: {
          code: primaryError.code || 'RESTART_PERSISTENCE_ERROR',
          finalAudit: sanitizeEvidence(finalAudit || {}),
          message: primaryError.message,
          secondaryError: primaryError.secondaryError || null,
          stack: primaryError.stack
        }
      });
    } else {
      process.send({
        ok: true,
        result: Object.assign(result, {
          audit: finalAudit
        })
      });
    }
  }
});
