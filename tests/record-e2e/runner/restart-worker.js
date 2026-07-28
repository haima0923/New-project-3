const path = require('path');
const { createCaseRuntime } = require('./create-case-runtime');
const { ROOT } = require('./constants');

process.on('message', (message) => {
  const spec = message.spec;
  const runtime = createCaseRuntime(spec, {
    attempt: message.attempt,
    initialEntries: message.entries
  });
  let appDefinition = null;
  global.App = (definition) => { appDefinition = definition; };
  try {
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
    if (process.send) {
      process.send({
        ok: true,
        result: {
          audit: runtime.audit(),
          bootId: runtime.bootId,
          pid: process.pid,
          state,
          status,
          storageEntries: runtime.fakeWx.getEntries()
        }
      });
    }
  } catch (error) {
    if (process.send) {
      process.send({
        ok: false,
        error: {
          code: error.code || 'RESTART_PERSISTENCE_ERROR',
          message: error.message,
          stack: error.stack
        }
      });
    }
  } finally {
    runtime.dispose();
  }
});
