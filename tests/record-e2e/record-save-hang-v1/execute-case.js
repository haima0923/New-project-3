const {
  BUSINESS_STORAGE_KEY,
  ORDER_TEXT,
  businessProjection,
  createDirectHarness,
  createVoicePrepared,
  dispatchFormalSave,
  formalSaveWxmlContract,
  pageSaveSummary,
  prepareExactConfirmation
} = require('./runtime');

function check(code, pass, actual) {
  return { code, pass: pass === true, actual };
}

function exitedSaving(summary) {
  return summary.page.saving === false
    && summary.page.showParseProgress === false
    && summary.page.conversationPhase !== 'SAVING'
    && summary.lock === false;
}

function persistedExactlyOnce(summary) {
  return summary.businessCalls === 1
    && summary.storageCalls === 1
    && summary.state.matchingOrderCount === 1
    && summary.state.recordIdPresent === true
    && summary.state.storageRevision === 1;
}

async function directProbe(caseId, options = {}) {
  const harness = createDirectHarness({
    caseId,
    instrumentation: options.instrumentation || null
  });
  try {
    const identity = await prepareExactConfirmation(harness.page);
    if (typeof options.beforeSave === 'function') options.beforeSave(harness);
    let thrown = null;
    try {
      dispatchFormalSave(harness.page);
    } catch (error) {
      thrown = error;
    }
    return {
      identity,
      navigation: harness.fakeWx.audit().navigationEvents,
      summary: pageSaveSummary(
        harness.page,
        harness.driver.evidence,
        harness.readState(),
        thrown
      )
    };
  } finally {
    harness.dispose();
  }
}

async function voiceProbe(origin, caseId) {
  const prepared = await createVoicePrepared(origin, caseId);
  try {
    dispatchFormalSave(prepared.harness.input.page);
    return {
      identity: prepared.identity,
      navigation: prepared.harness.navigation.audit(),
      summary: pageSaveSummary(
        prepared.harness.input.page,
        prepared.harness.input.evidence,
        prepared.harness.fakeWx.getValue(BUSINESS_STORAGE_KEY) || {}
      )
    };
  } finally {
    prepared.harness.dispose();
  }
}

async function greenStatic() {
  const contract = formalSaveWxmlContract();
  return [
    check('GREEN001.REAL_BUTTON_FOUND', contract.buttonFound, contract),
    check('GREEN001.REAL_HANDLER', contract.handler === 'saveFormal', contract),
    check('GREEN001.DISABLED_BOUND', /disableFormalSave/.test(contract.disabledExpression), contract),
    check('GREEN001.VISIBLE_ONLY_FORMAL', /showFormalSaveButton/.test(contract.wxIfExpression), contract)
  ];
}

async function save001() {
  const probe = await directProbe('SAVE-HANG-001');
  return [
    check('SAVE001.WXML_TO_BUSINESS_ONCE', probe.summary.businessCalls === 1, probe.summary),
    check('SAVE001.STORAGE_ONCE', probe.summary.storageCalls === 1, probe.summary),
    check('SAVE001.ORDER_PERSISTED_ONCE', persistedExactlyOnce(probe.summary), probe.summary),
    check('SAVE001.PROGRESS_CLEARED', probe.summary.page.showParseProgress === false, probe.summary),
    check('SAVE001.EXITED_SAVING', exitedSaving(probe.summary), probe.summary)
  ];
}

async function save002() {
  const direct = await directProbe('SAVE-HANG-002-DIRECT');
  const voice = await voiceProbe('dashboard', 'SAVE-HANG-002-VOICE');
  return [
    check('SAVE002.BOTH_PERSIST_ONCE', persistedExactlyOnce(direct.summary)
      && persistedExactlyOnce(voice.summary), { direct, voice }),
    check('SAVE002.SEMANTIC_EQUAL', JSON.stringify(businessProjection(direct.summary))
      === JSON.stringify(businessProjection(voice.summary)), { direct, voice }),
    check('SAVE002.SESSION_SEPARATE_AND_VALID', Boolean(direct.identity.confirmationSessionId)
      && Boolean(voice.identity.confirmationSessionId), { direct: direct.identity, voice: voice.identity }),
    check('SAVE002.DIRECT_EXITED', exitedSaving(direct.summary), direct.summary),
    check('SAVE002.VOICE_EXITED', exitedSaving(voice.summary), voice.summary)
  ];
}

async function save003() {
  const hero = await voiceProbe('dashboard', 'SAVE-HANG-003-HERO');
  const tab = await voiceProbe('records', 'SAVE-HANG-003-TAB');
  return [
    check('SAVE003.BOTH_PERSIST_ONCE', persistedExactlyOnce(hero.summary)
      && persistedExactlyOnce(tab.summary), { hero, tab }),
    check('SAVE003.SEMANTIC_EQUAL', JSON.stringify(businessProjection(hero.summary))
      === JSON.stringify(businessProjection(tab.summary)), { hero, tab }),
    check('SAVE003.NO_DASHBOARD_HOP', !tab.navigation.some((event) => (
      event.url === '/pages/dashboard/dashboard'
    )), tab.navigation),
    check('SAVE003.HERO_EXITED', exitedSaving(hero.summary), hero.summary),
    check('SAVE003.TAB_EXITED', exitedSaving(tab.summary), tab.summary)
  ];
}

async function save004() {
  const probe = await directProbe('SAVE-HANG-004');
  return [
    check('SAVE004.COMMIT_COMPLETE', persistedExactlyOnce(probe.summary), probe.summary),
    check('SAVE004.RECEIPT_PRESENT', probe.summary.state.storagePlanIdPresent
      && probe.summary.state.storageTransactionIdPresent, probe.summary.state),
    check('SAVE004.SUCCESS_SURFACE_EXITED', exitedSaving(probe.summary), probe.summary),
    check('SAVE004.INPUT_READY', probe.summary.page.conversationPhase === 'INPUT'
      && probe.summary.page.parseResultPresent === false, probe.summary.page)
  ];
}

async function save005Business() {
  const probe = await directProbe('SAVE-HANG-005-BUSINESS', {
    instrumentation: {
      invokeSaveConfirmedDraft() {
        const error = new Error('Injected business throw');
        error.code = 'TEST_BUSINESS_THROW';
        throw error;
      }
    }
  });
  return [
    check('SAVE005B.THROW_EXERCISED', probe.summary.errorCode === 'TEST_BUSINESS_THROW', probe.summary),
    check('SAVE005B.ZERO_PERSISTED_MUTATION', probe.summary.state.matchingOrderCount === 0
      && probe.summary.storageCalls === 0, probe.summary),
    check('SAVE005B.RECOVERED_FROM_THROW', exitedSaving(probe.summary), probe.summary),
    check('SAVE005B.RETRY_AVAILABLE', probe.summary.lock === false, probe.summary)
  ];
}

async function save005Storage() {
  const probe = await directProbe('SAVE-HANG-005-STORAGE', {
    instrumentation: {
      beforeSaveState() {
        const error = new Error('Injected storage throw');
        error.code = 'TEST_STORAGE_THROW';
        throw error;
      }
    }
  });
  return [
    check('SAVE005S.THROW_EXERCISED', probe.summary.errorCode === 'TEST_STORAGE_THROW', probe.summary),
    check('SAVE005S.BUSINESS_CALLED_ONCE', probe.summary.businessCalls === 1, probe.summary),
    check('SAVE005S.ZERO_PERSISTED_MUTATION', probe.summary.state.matchingOrderCount === 0, probe.summary),
    check('SAVE005S.RECOVERED_FROM_THROW', exitedSaving(probe.summary), probe.summary),
    check('SAVE005S.NO_AUTO_RETRY', probe.summary.storageCalls === 1, probe.summary)
  ];
}

async function save005PostCommit() {
  const probe = await directProbe('SAVE-HANG-005-POSTCOMMIT', {
    beforeSave(harness) {
      harness.fakeWx.wx.showToast = () => {
        const error = new Error('Injected post-commit UI throw');
        error.code = 'TEST_POST_COMMIT_UI_THROW';
        throw error;
      };
    }
  });
  return [
    check('SAVE005P.THROW_EXERCISED', probe.summary.errorCode === 'TEST_POST_COMMIT_UI_THROW', probe.summary),
    check('SAVE005P.EXACTLY_ONE_COMMITTED', persistedExactlyOnce(probe.summary), probe.summary),
    check('SAVE005P.RECOVERED_AFTER_COMMIT', exitedSaving(probe.summary), probe.summary),
    check('SAVE005P.NO_AUTO_RETRY', probe.summary.businessCalls === 1
      && probe.summary.storageCalls === 1, probe.summary)
  ];
}

async function save005Navigation() {
  const probe = await directProbe('SAVE-HANG-005-NAVIGATION', {
    beforeSave(harness) {
      harness.fakeWx.wx.switchTab = () => {
        const error = new Error('Injected navigation failure');
        error.code = 'TEST_NAVIGATION_FAILURE';
        throw error;
      };
    }
  });
  return [
    check('SAVE005N.NO_SAVE_NAVIGATION_DEPENDENCY', probe.navigation.length === 0, probe.navigation),
    check('SAVE005N.EXACTLY_ONE_COMMITTED', persistedExactlyOnce(probe.summary), probe.summary),
    check('SAVE005N.PROGRESS_CLEARED', probe.summary.page.showParseProgress === false, probe.summary),
    check('SAVE005N.EXITED_SAVING', exitedSaving(probe.summary), probe.summary)
  ];
}

const EXECUTORS = {
  'GREEN-SAVE-HANG-001': greenStatic,
  'SAVE-HANG-001': save001,
  'SAVE-HANG-002': save002,
  'SAVE-HANG-003': save003,
  'SAVE-HANG-004': save004,
  'SAVE-HANG-005-BUSINESS': save005Business,
  'SAVE-HANG-005-NAVIGATION': save005Navigation,
  'SAVE-HANG-005-POSTCOMMIT': save005PostCommit,
  'SAVE-HANG-005-STORAGE': save005Storage
};

async function executeCase(id) {
  const executor = EXECUTORS[id];
  if (!executor) {
    const error = new Error(`Unknown SAVE-HANG case: ${id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  const checks = await executor();
  const firstFailure = checks.find((entry) => entry.pass !== true);
  return {
    checks,
    firstFailure: firstFailure ? firstFailure.code : '',
    id,
    sourceText: ORDER_TEXT,
    status: firstFailure ? 'CASE_FAIL' : 'PASS'
  };
}

module.exports = { executeCase };
