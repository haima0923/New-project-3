#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  NO_RECORD_FORMAL_SAVE_FORBIDDEN,
  NO_RECORD_PENDING_SAVE_FORBIDDEN,
  saveConfirmedDraft,
  savePendingNote
} = require('../utils/business');
const { parseHybridInput } = require('../utils/ai-parser');
const {
  evaluateRecordDomainPreflight,
  isNoRecordPersistenceForbidden
} = require('../utils/record-domain-preflight');
const { safeClone, stableHash } = require('../utils/record-state-diff');
const { buildExecutionPlan } = require('../tests/record-e2e/runner/build-execution-plan');
const { BUSINESS_STORAGE_KEY, ROOT } = require('../tests/record-e2e/runner/constants');
const { createCaseRuntime } = require('../tests/record-e2e/runner/create-case-runtime');
const { loadCorpus } = require('../tests/record-e2e/runner/load-corpus');
const {
  flushAsync,
  loadProductionPage,
  waitForPageParse
} = require('../tests/record-e2e/runner/page-vm-driver');
const productionStorage = require('../utils/storage');

const corpus = loadCorpus();
const amb005 = corpus.byId.get('REC-E2E-AMB-005');
assert(amb005, 'Missing REC-E2E-AMB-005');
const bundle = buildExecutionPlan(amb005, corpus.fixtureResolver);

function stateHash(value) {
  return stableHash(value, 'no-record-persistence-state-v1');
}

function storageSetCount(audit) {
  return (audit.storageEvents || []).filter((event) => (
    event.operation === 'SET' && event.key === BUSINESS_STORAGE_KEY
  )).length;
}

function canonicalNoRecordDraft(overrides = {}) {
  return Object.assign({
    ai_fallback: {
      attempted: false,
      business_result_valid: false,
      needed: false,
      status: 'not_requested'
    },
    field_conflicts: [],
    fields: {},
    intent: 'unknown',
    low_confidence_fields: [],
    missing_fields: [],
    no_record: true,
    operation: null,
    original_text: amb005.input.originalText,
    parse_route: {
      business_evidence_count: 0,
      decision: 'no_record',
      deep_review_available: false,
      final_disposition: 'no_record',
      no_record_eligible: true,
      no_record_eligibility_exclusions: [],
      no_record_eligibility_reason_codes: [
        'CLEAR_NON_BUSINESS',
        'NO_BUSINESS_EVIDENCE',
        'NO_STRUCTURED_FIELDS',
        'NO_RELATION_EVIDENCE',
        'PROCESSING_COMPLETE'
      ],
      relation_evidence_count: 0,
      semantic_decision: 'no_record',
      structured_business_field_count: 0
    },
    source: 'typed'
  }, overrides);
}

function preflight(result, state) {
  return evaluateRecordDomainPreflight({
    aiOutcome: 'not_requested',
    businessType: result.intent,
    finalResult: result,
    initialState: state,
    mode: 'PRODUCTION_ROUTING',
    operation: result.operation,
    originalText: result.original_text,
    providerKind: 'NONE',
    resultScope: 'PRODUCTION_RESULT',
    skipFinalSafety: true
  });
}

async function runSurface(surface) {
  const runtime = createCaseRuntime(safeClone(bundle.workerSpec), { attempt: 1 });
  try {
    const driver = loadProductionPage(surface, runtime, bundle.workerSpec, {
      runLifecycle: false
    });
    const page = driver.page;
    if (surface === 'HOME_QUICK') {
      page.setData({ composerText: amb005.input.originalText });
      page.submitComposer();
    } else {
      page.setData({ text: amb005.input.originalText, source: 'typed' });
      page.runParse();
    }
    await waitForPageParse(page);
    assert.strictEqual(page.data.parseResult.parse_route.decision, 'no_record');
    assert.strictEqual(page.data.parseResult.parse_route.no_record_eligible, true);
    assert.strictEqual(page.data.domainCanSaveFormal, false);
    assert.strictEqual(page.data.domainCanSavePending, false);
    assert.strictEqual(page.data.effectiveCanSaveFormal, false);
    assert.strictEqual(page.data.effectiveCanSavePending, false);
    assert.strictEqual(page.data.showFormalSaveButton, false);
    assert.strictEqual(page.data.showPendingButton, false);
    assert.strictEqual(page.data.showDeepReviewButton, false);

    const stateBefore = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
    const stateFingerprintBefore = stateHash(stateBefore);
    const storageControlBefore = stateBefore && stateBefore.__hxlRecordStorageV1 || {};
    const revisionBefore = Number(storageControlBefore.storageRevision || 0);
    const receiptCountBefore = (storageControlBefore.recentReceipts || []).length;
    const monitorEventsBefore = (
      productionStorage.getRecordStorageInfrastructureStatus().monitorEvents || []
    ).length;
    const storageBefore = runtime.fakeWx.audit();
    const businessBefore = safeClone(driver.evidence.productionBusinessCalls);
    const storageCallsBefore = driver.evidence.productionStorageCalls.saveState;
    const hybridCountBefore = Number(
      driver.evidence.pageMethodCalls.runParse
      || driver.evidence.pageMethodCalls.runQuickParse
      || 0
    );

    const formalMethod = surface === 'HOME_QUICK' ? 'confirmQuickSave' : 'saveFormal';
    const pendingMethod = surface === 'HOME_QUICK' ? 'savePendingFromConfirm' : 'savePending';
    const formal = page[formalMethod]();
    const pending = page[pendingMethod]();
    const deep = page.requestDeepReview();
    await flushAsync();

    assert.strictEqual(formal.code, NO_RECORD_FORMAL_SAVE_FORBIDDEN);
    assert.strictEqual(pending.code, NO_RECORD_PENDING_SAVE_FORBIDDEN);
    assert.strictEqual(deep.code, 'NO_RECORD_DEEP_REVIEW_FORBIDDEN');
    assert.strictEqual(
      driver.evidence.productionBusinessCalls.saveConfirmedDraft,
      businessBefore.saveConfirmedDraft
    );
    assert.strictEqual(
      driver.evidence.productionBusinessCalls.savePendingNote,
      businessBefore.savePendingNote
    );
    assert.strictEqual(
      driver.evidence.productionStorageCalls.saveState,
      storageCallsBefore
    );
    assert.strictEqual(
      Number(
        driver.evidence.pageMethodCalls.runParse
        || driver.evidence.pageMethodCalls.runQuickParse
        || 0
      ),
      hybridCountBefore
    );
    const storageAfter = runtime.fakeWx.audit();
    const rawStateAfter = runtime.fakeWx.getValue(BUSINESS_STORAGE_KEY);
    const storageControlAfter = rawStateAfter && rawStateAfter.__hxlRecordStorageV1 || {};
    const revisionAfter = Number(storageControlAfter.storageRevision || 0);
    const receiptCountAfter = (storageControlAfter.recentReceipts || []).length;
    const newMonitorEvents = (
      productionStorage.getRecordStorageInfrastructureStatus().monitorEvents || []
    ).slice(monitorEventsBefore);
    const transactionBeginCount = newMonitorEvents.filter((event) => (
      event.type === 'LEGACY_WRITE_DECISION'
    )).length;
    assert.strictEqual(storageSetCount(storageAfter), storageSetCount(storageBefore));
    assert.strictEqual(
      stateHash(rawStateAfter),
      stateFingerprintBefore
    );
    assert.strictEqual(transactionBeginCount, 0);
    assert.strictEqual(revisionAfter - revisionBefore, 0);
    assert.strictEqual(receiptCountAfter - receiptCountBefore, 0);
    assert.strictEqual(runtime.network.audit().realNetworkRequests, 0);
    assert.strictEqual(runtime.network.audit().unknownFakeRouteRequests, 0);
    assert.strictEqual(storageAfter.realWxStorageCalls, 0);
    assert.strictEqual(storageAfter.hostFilesystemStorageCalls, 0);
    assert.strictEqual(storageAfter.journalPresent, false);
    assert.strictEqual(storageAfter.backupPresent, false);
    return {
      deepMethod: 'requestDeepReview',
      formalMethod,
      pendingMethod,
      receiptCountDelta: receiptCountAfter - receiptCountBefore,
      revisionDelta: revisionAfter - revisionBefore,
      transactionBeginCount,
      surface
    };
  } finally {
    runtime.dispose();
  }
}

async function main() {
  const parsed = await parseHybridInput({
    context: 'home',
    source: 'typed',
    state: safeClone(bundle.workerSpec.initialState.state),
    text: amb005.input.originalText
  });
  assert.strictEqual(parsed.parse_route.decision, 'no_record');
  assert.strictEqual(parsed.parse_route.no_record_eligible, true);
  assert.strictEqual(parsed.ai_fallback.attempted, false);
  assert.strictEqual(parsed.parse_route.deep_review_available, false);
  assert.strictEqual(isNoRecordPersistenceForbidden(parsed), true);

  const domain = preflight(parsed, safeClone(bundle.workerSpec.initialState.state));
  assert.strictEqual(domain.operation, 'none');
  assert.strictEqual(domain.domainCanSaveFormal, false);
  assert.strictEqual(domain.domainCanSavePending, false);
  assert.strictEqual(domain.noRecordPersistenceForbidden, true);
  assert.deepStrictEqual(domain.requiredSelections, []);
  assert.deepStrictEqual(
    domain.blockingIssues.map((item) => item.code),
    ['NO_RECORD_OR_UNKNOWN_INTENT']
  );

  const directPendingState = safeClone(bundle.workerSpec.initialState.state);
  const directPendingBefore = stateHash(directPendingState);
  assert.throws(
    () => savePendingNote(directPendingState, parsed),
    (error) => error && error.code === NO_RECORD_PENDING_SAVE_FORBIDDEN
  );
  assert.strictEqual(stateHash(directPendingState), directPendingBefore);

  const directFormalState = safeClone(bundle.workerSpec.initialState.state);
  const directFormalBefore = stateHash(directFormalState);
  const formal = saveConfirmedDraft(directFormalState, parsed);
  assert.strictEqual(formal.type, 'error');
  assert.strictEqual(formal.code, NO_RECORD_FORMAL_SAVE_FORBIDDEN);
  assert.strictEqual(formal.noMutation, true);
  assert.strictEqual(stateHash(directFormalState), directFormalBefore);

  const forged = canonicalNoRecordDraft({
    fields: {
      amount: '5000',
      customerName: '伪造客户'
    }
  });
  const forgedState = safeClone(bundle.workerSpec.initialState.state);
  assert.throws(
    () => savePendingNote(forgedState, forged),
    (error) => error && error.code === NO_RECORD_PENDING_SAVE_FORBIDDEN
  );

  const pendingState = safeClone(bundle.workerSpec.initialState.state);
  const pending = canonicalNoRecordDraft({
    missing_fields: ['intent'],
    no_record: false,
    operation: 'pending',
    parse_route: {
      decision: 'pending',
      deep_review_available: true,
      no_record_eligible: false
    }
  });
  const note = savePendingNote(pendingState, pending, '合法PENDING保护');
  assert(note && note.id);
  assert.strictEqual(pendingState.pendingNotes.length, 1);
  assert.strictEqual(preflight(pending, pendingState).domainCanSavePending, true);

  const pageEvidence = [];
  pageEvidence.push(await runSurface('HOME_QUICK'));
  pageEvidence.push(await runSurface('FULL_PAGE'));

  const fullWxml = fs.readFileSync(path.join(ROOT, 'pages/input/input.wxml'), 'utf8');
  const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/dashboard/dashboard.wxml'), 'utf8');
  assert(fullWxml.includes('wx:if="{{showPendingButton}}"'));
  assert(fullWxml.includes('wx:if="{{showFormalSaveButton}}"'));
  assert(homeWxml.includes('wx:if="{{showPendingButton}}"'));
  assert(homeWxml.includes('wx:if="{{showFormalSaveButton}}"'));

  console.log(`NO_RECORD persistence tests passed: ${JSON.stringify({
    businessDirectGuards: 3,
    canonicalRoute: parsed.parse_route.decision,
    domainCanSavePending: domain.domainCanSavePending,
    pageEvidence,
    pendingProtection: true,
    tests: 15
  })}`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
