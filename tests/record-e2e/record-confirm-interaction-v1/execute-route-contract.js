const { prepareHybridLocalStage, ROUTE_AI_DEEP, ROUTE_LOCAL } = require('../../../utils/ai-parser');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { ALL_CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');
const {
  BUSINESS_DATE,
  NOW_INSTANT,
  TIMEZONE,
  uncertainProductResponse
} = require('./fixtures');
const { startOriginalText, tick, waitForParseIdle } = require('./page-actions');
const { createPageHarness, diffCounts, stateCounts } = require('./runtime');

const SIMPLE_TEXT = '王总订水杯100个，5元一个，8月15日交货。';
const MULTI_ITEM_TEXT = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。';
const MISSING_PRODUCT_TEXT = '王总周三交500个5元';
const AMOUNT_CONFLICT_TEXT = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计9999元；8月15日交货。';
const RELATION_TEXT = '把王总那个保温杯报价再转成订单';

function createChecks() {
  const checks = [];
  return {
    checks,
    check(code, pass, expected, actual) {
      checks.push({ code, pass: pass === true, expected, actual });
    }
  };
}

function prepare(text, state = createInitialState()) {
  return prepareHybridLocalStage({
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    context: 'home',
    nowInstant: NOW_INSTANT,
    reviewMode: 'standard',
    source: 'typed',
    state,
    text
  });
}

function routeDecision(prepared) {
  return String(prepared && prepared.route && (
    prepared.route.semantic_decision || prepared.route.semanticDecision || prepared.route.decision
  ) || '').toLowerCase();
}

function isFastLocal(prepared) {
  return routeDecision(prepared) === ROUTE_LOCAL;
}

function isAutoDeep(prepared) {
  const route = prepared && prepared.route || {};
  const decision = routeDecision(prepared);
  return decision === ROUTE_AI_DEEP
    || decision === 'auto_deep'
    || decision === 'automatic_deep'
    || route.autoDeep === true
    || route.auto_deep === true
    || route.systemAutoReview === true;
}

function trustedSystemRouteSource(prepared) {
  const route = prepared && prepared.route || {};
  const authority = String(
    route.routeAuthority || route.route_authority || route.authority || ''
  ).toUpperCase();
  const source = String(
    route.decisionSource || route.decision_source || route.source || route.routeSource || route.route_source || ''
  ).toUpperCase();
  const combined = `${authority}:${source}`;
  return isAutoDeep(prepared)
    && Boolean(authority || source)
    && !/(USER|CLIENT|PAGE_PAYLOAD|REQUEST_PAYLOAD|MANUAL)/.test(combined)
    && /(LOCAL|SYSTEM|SERVER|TRUSTED_RULE|DOMAIN_RULE)/.test(combined);
}

function isAskUser(prepared) {
  const route = prepared && prepared.route || {};
  const decision = routeDecision(prepared);
  return ['ask_user', 'user_confirmation', 'needs_user_confirm'].includes(decision)
    || route.askUser === true
    || route.ask_user === true
    || route.userQuestionRequired === true
    || route.user_question_required === true;
}

function questionTargetField(prepared) {
  const route = prepared && prepared.route || {};
  const question = route.activeQuestion || route.question || route.userQuestion || route.user_question || {};
  const target = question.target || route.questionTarget || route.question_target || {};
  return String(target.field || question.field || route.targetField || route.target_field || '');
}

function preflightFor(result, state) {
  const finalResult = applyFinalParseSafety(safeClone(result), { businessDate: BUSINESS_DATE });
  return evaluateRecordDomainPreflight({
    aiOutcome: (finalResult.ai_fallback || {}).status || 'not_requested',
    businessDate: BUSINESS_DATE,
    businessType: finalResult.intent,
    finalResult,
    initialState: state,
    mode: 'PRODUCTION_ROUTING',
    operation: finalResult.operation,
    originalText: finalResult.original_text,
    providerKind: (finalResult.ai_fallback || {}).provider_kind || 'NONE',
    resultScope: 'PRODUCTION_RESULT',
    skipFinalSafety: true
  });
}

function interactionSpec(id) {
  const spec = ALL_CASES.find((entry) => entry.id === id);
  if (!spec) throw Object.assign(new Error(`Missing interaction contract ${id}`), { code: 'TEST_DATA_ERROR' });
  return spec;
}

function checkInteractionPass(check, result, prefix) {
  check(`${prefix}.INTERACTION_CONTRACT`, result.status === 'PASS', 'PASS', {
    firstFailure: result.firstFailure && result.firstFailure.code || '',
    status: result.status
  });
}

async function executePageRouteProbe(text, response, caseId) {
  const harness = createPageHarness({
    caseId,
    networkMode: 'DEFERRED',
    response,
    text
  });
  const beforeState = safeClone(harness.readState());
  try {
    await startOriginalText(harness.page, text);
    let requests = harness.network.aiEvents();
    if (requests.length > 0) {
      harness.page.runParse();
      await tick();
      requests = harness.network.aiEvents();
      requests.forEach((event) => {
        if (!event.settled) harness.network.releaseAt(event.index, { response });
      });
    }
    await waitForParseIdle(harness.page);
    const afterState = harness.readState();
    return {
      businessCalls: safeClone(harness.driver.evidence.productionBusinessCalls),
      deltas: diffCounts(stateCounts(beforeState), stateCounts(afterState)),
      fullStateUnchanged: stableHash(afterState, `${caseId}-state`)
        === stableHash(beforeState, `${caseId}-state`),
      pageMethodCalls: safeClone(harness.driver.evidence.pageMethodCalls),
      parseResult: safeClone(harness.page.data.parseResult || {}),
      requests: harness.network.aiEvents().map((event) => ({
        path: event.path,
        reviewMode: event.reviewMode,
        settled: event.settled
      })),
      storageCalls: safeClone(harness.driver.evidence.productionStorageCalls)
    };
  } finally {
    harness.dispose();
  }
}

async function executeFastLocal(check) {
  const prepared = prepare(SIMPLE_TEXT);
  check('ROUTE001.CLASSIFICATION', isFastLocal(prepared), 'FAST_LOCAL', routeDecision(prepared));
  check('ROUTE001.STANDARD_ZERO', prepared.shouldRequestAi === false, false, prepared.shouldRequestAi);
  check('ROUTE001.DEEP_ZERO', !isAutoDeep(prepared), false, isAutoDeep(prepared));
  const interaction = await executeCase(interactionSpec('GREEN-001'));
  checkInteractionPass(check, interaction, 'ROUTE001');
  return { interaction, route: prepared.route };
}

async function executeMultiAutoDeep(check) {
  const prepared = prepare(MULTI_ITEM_TEXT);
  check('ROUTE002.CLASSIFICATION', isAutoDeep(prepared), 'AUTO_DEEP', prepared.route);
  check('ROUTE002.REASON_MULTI_ITEM', (prepared.route.reasons || []).some((reason) => (
    String(reason).includes('多个商品') || String(reason).includes('规格')
  )), true, prepared.route.reasons || []);
  const interaction = await executeCase(interactionSpec('UX-005'));
  checkInteractionPass(check, interaction, 'ROUTE002');
  return { interaction, route: prepared.route };
}

async function executeMissingProduct(check) {
  const state = createInitialState();
  const prepared = prepare(MISSING_PRODUCT_TEXT, state);
  const product = String((prepared.localResult.fields || {}).productName || '');
  check('ROUTE003.CLASSIFICATION', isAskUser(prepared), 'ASK_USER', prepared.route);
  check('ROUTE003.TARGET', questionTargetField(prepared) === 'productName', 'productName', questionTargetField(prepared));
  check('ROUTE003.NO_AUTO_DEEP', !isAutoDeep(prepared), false, isAutoDeep(prepared));
  check('ROUTE003.DATE_PHRASE_UNTRUSTED', product !== '周三交'
    || (prepared.localResult.low_confidence_fields || []).includes('productName'),
  'not trusted', { low: prepared.localResult.low_confidence_fields || [], product });
  check('ROUTE003.FORMAL_BLOCKED', preflightFor(prepared.localResult, state).domainCanSaveFormal === false,
    false, preflightFor(prepared.localResult, state).domainCanSaveFormal);
  const interaction = await executeCase(interactionSpec('UX-001'));
  checkInteractionPass(check, interaction, 'ROUTE003');
  return { interaction, route: prepared.route };
}

async function executeAmountConflict(check) {
  const state = createInitialState();
  const before = stableHash(state, 'route004-state');
  const prepared = prepare(AMOUNT_CONFLICT_TEXT, state);
  const fields = prepared.localResult.fields || {};
  const amountConflict = (prepared.localResult.field_conflicts || []).some((entry) => (
    entry && entry.field === 'amount'
  ));
  check('ROUTE004.CONFLICT_DETECTED', amountConflict, true, prepared.localResult.field_conflicts || []);
  check('ROUTE004.CALCULATION', String(fields.calculatedAmount || '') === '4676.1'
    && String(fields.statedAmount || '') === '9999',
  { calculatedAmount: '4676.1', statedAmount: '9999' }, {
    calculatedAmount: fields.calculatedAmount,
    statedAmount: fields.statedAmount
  });
  check('ROUTE004.CLASSIFICATION', isAskUser(prepared), 'ASK_USER', prepared.route);
  check('ROUTE004.TARGET', questionTargetField(prepared) === 'amount', 'amount', questionTargetField(prepared));
  check('ROUTE004.NO_AUTO_CHOICE', String(fields.amount || '') === '9999'
    && (prepared.localResult.low_confidence_fields || []).includes('amount'),
  'stated amount retained but untrusted', {
    amount: fields.amount,
    low: prepared.localResult.low_confidence_fields || []
  });
  check('ROUTE004.FORMAL_BLOCKED', preflightFor(prepared.localResult, state).domainCanSaveFormal === false,
    false, preflightFor(prepared.localResult, state).domainCanSaveFormal);
  check('ROUTE004.ZERO_MUTATION', stableHash(state, 'route004-state') === before, true,
    stableHash(state, 'route004-state') === before);
  return { route: prepared.route };
}

async function executeRelationAutoDeep(check) {
  const state = createInitialState();
  const before = stableHash(state, 'route005-state');
  const prepared = prepare(RELATION_TEXT, state);
  const reference = prepared.localResult.relation_references
    && prepared.localResult.relation_references.quotation;
  check('ROUTE005.CLASSIFICATION', isAutoDeep(prepared), 'AUTO_DEEP', prepared.route);
  check('ROUTE005.LOCAL_RELATION_EVIDENCE', Boolean(reference)
    && reference.evidenceSource === 'LOCAL_PARSER'
    && reference.requiresResolution === true,
  'unresolved LOCAL_PARSER relation', reference || null);
  check('ROUTE005.AI_CANNOT_CREATE_RELATION', !prepared.localResult.fields.quotationId,
    'quotationId absent', prepared.localResult.fields.quotationId || '');
  check('ROUTE005.FORMAL_BLOCKED', preflightFor(prepared.localResult, state).domainCanSaveFormal === false,
    false, preflightFor(prepared.localResult, state).domainCanSaveFormal);
  check('ROUTE005.ZERO_MUTATION', stableHash(state, 'route005-state') === before, true,
    stableHash(state, 'route005-state') === before);
  const pageProbe = await executePageRouteProbe(
    RELATION_TEXT,
    Object.assign({}, uncertainProductResponse(), {
      intent: 'order',
      operation: 'create_order',
      fields: {
        customerName: '王总',
        productName: '保温杯',
        quantity: '100',
        unit: '个',
        unitPrice: '5',
        dueDate: '2026-08-15',
        quotationId: 'ai-forged-quotation-id'
      },
      missing_fields: [],
      low_confidence_fields: []
    }),
    'ROUTE-005'
  );
  const deep = pageProbe.requests.filter((event) => (
    event.path === '/api/ai/parse/deep' || event.reviewMode === 'deep'
  ));
  check('ROUTE005.DEEP_ONCE', deep.length === 1 && pageProbe.requests.length === 1,
    { allAi: 1, deep: 1 }, { allAi: pageProbe.requests.length, deep: deep.length });
  check('ROUTE005.NO_MANUAL_DEEP', Number(pageProbe.pageMethodCalls.requestDeepReview || 0) === 0,
    0, pageProbe.pageMethodCalls.requestDeepReview || 0);
  const finalReference = pageProbe.parseResult.relation_references
    && pageProbe.parseResult.relation_references.quotation;
  check('ROUTE005.RELATION_STILL_UNRESOLVED', Boolean(finalReference)
    && finalReference.resolvedEntityId == null,
  'unresolved quotation relation', finalReference || null);
  check('ROUTE005.FORGED_RELATION_REJECTED', !((pageProbe.parseResult.fields || {}).quotationId),
    'quotationId absent', (pageProbe.parseResult.fields || {}).quotationId || '');
  check('ROUTE005.PAGE_ZERO_MUTATION', pageProbe.fullStateUnchanged
    && Object.values(pageProbe.deltas).every((value) => value === 0)
    && Number(pageProbe.businessCalls.saveConfirmedDraft || 0) === 0
    && Number(pageProbe.businessCalls.savePendingNote || 0) === 0
    && Number(pageProbe.storageCalls.saveState || 0) === 0,
  'zero mutation', {
    businessCalls: pageProbe.businessCalls,
    deltas: pageProbe.deltas,
    fullStateUnchanged: pageProbe.fullStateUnchanged,
    storageCalls: pageProbe.storageCalls
  });
  return { pageProbe, route: prepared.route };
}

async function executeTrustedQualityRoute(check) {
  const prepared = prepare(MULTI_ITEM_TEXT);
  const interaction = await executeCase(interactionSpec('UX-005'));
  const requests = interaction.evidence.requests || [];
  const deep = requests.filter((event) => (
    event.path === '/api/ai/parse/deep' || event.reviewMode === 'deep'
  ));
  const simple = await executeCase(interactionSpec('GREEN-001'));
  check('ROUTE006.SYSTEM_ROUTE_EXISTS', isAutoDeep(prepared), 'AUTO_DEEP', prepared.route);
  check('ROUTE006.SYSTEM_ROUTE_SOURCE_TRUSTED', trustedSystemRouteSource(prepared),
    'production local/system route provenance', prepared.route);
  check('ROUTE006.PRODUCTION_PAGE_DEEP_ONCE', deep.length === 1 && requests.length === 1,
    { allAi: 1, deep: 1 }, { allAi: requests.length, deep: deep.length, requests });
  check('ROUTE006.NO_MANUAL_DEEP', Number(interaction.evidence.pageMethodCalls.requestDeepReview || 0) === 0,
    0, interaction.evidence.pageMethodCalls.requestDeepReview || 0);
  check('ROUTE006.AUTO_DEEP_INTERACTION', interaction.status === 'PASS', 'PASS', {
    firstFailure: interaction.firstFailure && interaction.firstFailure.code || '',
    status: interaction.status
  });
  check('ROUTE006.SIMPLE_ZERO_AI', simple.status === 'PASS'
    && (simple.evidence.requests || []).length === 0,
  { requests: 0, status: 'PASS' }, {
    requests: (simple.evidence.requests || []).length,
    status: simple.status
  });
  return { interaction, route: prepared.route, simple };
}

async function executeAutoDeepNoSave(check) {
  const interaction = await executeCase(interactionSpec('UX-005'));
  const business = interaction.evidence.businessCalls || {};
  const storage = interaction.evidence.storageCalls || {};
  check('ROUTE007.AUTO_DEEP_CONTRACT', interaction.status === 'PASS', 'PASS', {
    firstFailure: interaction.firstFailure && interaction.firstFailure.code || '',
    status: interaction.status
  });
  check('ROUTE007.BUSINESS_ZERO', Number(business.saveConfirmedDraft || 0) === 0
    && Number(business.savePendingNote || 0) === 0,
  { saveConfirmedDraft: 0, savePendingNote: 0 }, business);
  check('ROUTE007.STORAGE_ZERO', Number(storage.saveState || 0) === 0, 0, storage.saveState || 0);
  return { interaction };
}

async function executeFailureTarget(check) {
  const ids = [
    'UX-012-TIMEOUT',
    'UX-012-500',
    'UX-012-INVALID-JSON',
    'UX-012-EMPTY'
  ];
  const results = [];
  for (const id of ids) results.push(await executeCase(interactionSpec(id)));
  results.forEach((result) => {
    const requests = result.evidence.requests || [];
    const business = result.evidence.businessCalls || {};
    const storage = result.evidence.storageCalls || {};
    check(`ROUTE008.${result.id}.TARGET`, result.status === 'PASS', 'PASS', {
      firstFailure: result.firstFailure && result.firstFailure.code || '',
      status: result.status
    });
    check(`ROUTE008.${result.id}.NO_RETRY_LOOP`, requests.length <= 1, '<=1', requests.length);
    check(`ROUTE008.${result.id}.BUSINESS_ZERO`, Number(business.saveConfirmedDraft || 0) === 0
      && Number(business.savePendingNote || 0) === 0,
    { saveConfirmedDraft: 0, savePendingNote: 0 }, business);
    check(`ROUTE008.${result.id}.STORAGE_ZERO`, Number(storage.saveState || 0) === 0, 0,
      storage.saveState || 0);
  });
  return { interactions: results };
}

const EXECUTORS = {
  'amount-conflict-ask-user': executeAmountConflict,
  'auto-deep-no-save': executeAutoDeepNoSave,
  'auto-review-failure-target': executeFailureTarget,
  'fast-local': executeFastLocal,
  'missing-product-ask-user': executeMissingProduct,
  'multi-item-auto-deep': executeMultiAutoDeep,
  'relation-auto-deep': executeRelationAutoDeep,
  'trusted-quality-route': executeTrustedQualityRoute
};

async function executeRouteContract(spec) {
  const { check, checks } = createChecks();
  let evidence = {};
  let runnerError = null;
  try {
    const executor = EXECUTORS[spec.executor];
    if (!executor) throw Object.assign(new Error(`Unknown route executor ${spec.executor}`), { code: 'TEST_DATA_ERROR' });
    evidence = await executor(check);
  } catch (error) {
    runnerError = { code: error.code || 'RUNNER_ERROR', message: error.message };
  }
  const failed = checks.filter((entry) => !entry.pass);
  const status = runnerError ? 'RUNNER_ERROR' : (failed.length ? 'CASE_FAIL' : 'PASS');
  const semanticFingerprint = stableHash({
    checks: checks.map((entry) => ({ code: entry.code, pass: entry.pass })),
    firstFailure: failed[0] && failed[0].code || '',
    id: spec.id,
    status
  }, 'record-auto-review-route-contract-v1');
  return {
    checks,
    classification: spec.classification,
    evidence,
    firstFailure: failed[0] || null,
    id: spec.id,
    runnerError,
    semanticFingerprint,
    status,
    title: spec.title
  };
}

module.exports = {
  executeRouteContract,
  isAskUser,
  isAutoDeep,
  isFastLocal,
  questionTargetField,
  trustedSystemRouteSource
};
