const path = require('path');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createCaseRuntime } = require('../runner/create-case-runtime');
const { collectFinalAudit } = require('../runner/execute-case');
const { loadProductionPage } = require('../runner/page-vm-driver');
const { ROOT } = require('../runner/constants');
const { beginConversion, invokeConfirm } = require('./page-actions');

process.on('message', (message) => {
  const spec = safeClone(message.spec);
  const fixtureBefore = stableHash(spec.initialState.state, 'fixture-before-v1');
  let runtime = null;
  let finalAudit = null;
  let error = null;
  let result = null;
  try {
    runtime = createCaseRuntime(spec, {
      attempt: message.attempt,
      initialEntries: message.entries
    });
    let appDefinition = null;
    global.App = (definition) => { appDefinition = definition; };
    const appPath = path.join(ROOT, 'app.js');
    delete require.cache[require.resolve(appPath)];
    require(appPath);
    if (!appDefinition) throw Object.assign(new Error('App definition was not captured'), { code: 'RESTART_PERSISTENCE_ERROR' });
    const app = { globalData: safeClone(appDefinition.globalData || {}) };
    Object.keys(appDefinition).forEach((key) => {
      if (key !== 'globalData' && typeof appDefinition[key] === 'function') {
        app[key] = appDefinition[key].bind(app);
      }
    });
    global.getApp = () => app;
    if (typeof app.onLaunch === 'function') app.onLaunch();

    let retryEvidence = null;
    if (message.action) {
      const driver = loadProductionPage('QUOTATION_LIST', runtime, spec);
      const opened = beginConversion(
        driver.page,
        message.action.quotationId,
        message.action.deliveryDate
      );
      let invocationError = null;
      if (opened) {
        try {
          invokeConfirm(driver, message.action.quotationId);
        } catch (caught) {
          invocationError = { code: caught.code || 'PAGE_ACTION_ERROR', message: caught.message };
        }
      }
      retryEvidence = {
        conversionCalls: driver.evidence.productionBusinessCalls.convertQuotationToOrder,
        invocationError,
        panelOpened: opened,
        pageConverted: Boolean((driver.page.data.quotations || []).find((item) => (
          item.id === message.action.quotationId && item.isConverted
        ))),
        saveCalls: driver.evidence.productionStorageCalls.saveState,
        uiEvents: runtime.fakeWx.audit().uiEvents
      };
    }
    const storage = require('../../../utils/storage');
    result = {
      bootId: runtime.bootId,
      pid: process.pid,
      retryEvidence,
      state: storage.getState({ writerSource: 'Q2O_RESTART_READ' }),
      storageEntries: runtime.fakeWx.getEntries()
    };
  } catch (caught) {
    error = caught;
  } finally {
    if (runtime) {
      try {
        finalAudit = collectFinalAudit(runtime, spec, fixtureBefore);
      } catch (auditError) {
        error = auditError;
      }
      runtime.dispose();
    }
  }
  if (!process.send) return;
  if (error) {
    process.send({ ok: false, error: { code: error.code || 'RESTART_PERSISTENCE_ERROR', message: error.message } });
  } else {
    process.send({ ok: true, result: Object.assign(result, { audit: finalAudit }) });
  }
});
