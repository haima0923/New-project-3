const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');
const { stripRecordStorageControl } = require('../../../utils/record-storage-state-projector');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../runner/constants');
const { RECORD_STORAGE_CONTROL_KEY } = require('../../../utils/record-storage-transaction-contract');

function controlFacts(entries = {}) {
  const control = entries[BUSINESS_STORAGE_KEY]
    && entries[BUSINESS_STORAGE_KEY][RECORD_STORAGE_CONTROL_KEY] || {};
  return {
    receiptCount: (control.recentReceipts || []).length,
    revision: Number(control.storageRevision || 0)
  };
}

process.on('message', (message) => {
  const spec = safeClone(message.spec);
  let runtime = null;
  try {
    runtime = createCaseRuntime(spec, {
      attempt: message.attempt,
      initialEntries: message.entries
    });
    const controlBeforeLaunch = controlFacts(runtime.fakeWx.getEntries());
    let appDefinition = null;
    global.App = (definition) => { appDefinition = definition; };
    const appPath = path.join(ROOT, 'app.js');
    delete require.cache[require.resolve(appPath)];
    require(appPath);
    if (!appDefinition) {
      throw Object.assign(new Error('App definition was not captured'), {
        code: 'RESTART_PERSISTENCE_ERROR'
      });
    }
    const app = { globalData: safeClone(appDefinition.globalData || {}) };
    Object.keys(appDefinition).forEach((key) => {
      if (key !== 'globalData' && typeof appDefinition[key] === 'function') {
        app[key] = appDefinition[key].bind(app);
      }
    });
    global.getApp = () => app;
    if (typeof app.onLaunch === 'function') app.onLaunch();

    const storage = require('../../../utils/storage');
    const state = storage.getState({ writerSource: 'SIO_RESTART_READ' });
    const listDriver = loadProductionPage('ORDER_LIST', runtime, spec);
    const detailDriver = loadProductionPage('RECORD_DETAIL', runtime, spec, {
      onLoadOptions: { type: 'order', id: message.orderId }
    });
    const order = (state.orders || []).find((item) => item.id === message.orderId) || null;
    const listOrder = (listDriver.page.data.orders || []).find((item) => item.id === message.orderId) || null;
    const controlAfterLaunch = controlFacts(runtime.fakeWx.getEntries());
    const audit = runtime.audit();
    const result = {
      controlAfterLaunch,
      controlBeforeLaunch,
      detail: safeClone(detailDriver.page.data.detail || null),
      listOrder: safeClone(listOrder),
      order: safeClone(order),
      orderCount: (state.orders || []).length,
      pid: process.pid,
      state: stripRecordStorageControl(state),
      storageEntries: runtime.fakeWx.getEntries(),
      uiEvents: safeClone(audit.storageAudit.uiEvents || [])
    };
    runtime.dispose();
    runtime = null;
    if (process.send) process.send({ ok: true, result });
  } catch (error) {
    if (runtime) runtime.dispose();
    if (process.send) {
      process.send({
        ok: false,
        error: { code: error.code || 'RESTART_PERSISTENCE_ERROR', message: error.message }
      });
    }
  }
});
