const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createPageHarness, diffCounts, stateCounts } = require('../record-confirm-interaction-v1/runtime');
const { questionState, submitOriginalText, tick } = require('../record-confirm-interaction-v1/page-actions');
const {
  conversationWxmlContract,
  questionUiContract,
  renderConversationSnapshot
} = require('../../wechat-runtime/record-conversation-mode-v1/static-wxml-tests');
const {
  ANSWER_TO_DEEP_TEXT,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  SIMPLE_ORDER_TEXT,
  answerToDeepSuccessResponse,
  check,
  multiSuccessResponse
} = require('./fixtures');
const { probeServerRoute } = require('./server-route-probe');

function allZero(value) {
  return Object.values(value || {}).every((entry) => Number(entry || 0) === 0);
}

function readPath(value, pathExpression) {
  return String(pathExpression || '').split('.').filter(Boolean).reduce((current, key) => (
    current === undefined || current === null ? undefined : current[key]
  ), value);
}

function resolveTemplateValue(template, data) {
  const value = String(template || '');
  const match = value.match(/^\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}$/);
  return match ? readPath(data, match[1]) : value;
}

function resolvedDataset(contract, page) {
  return Object.keys(contract.actionDataset || {}).reduce((output, key) => {
    output[key] = resolveTemplateValue(contract.actionDataset[key], page.data || {});
    return output;
  }, {});
}

async function ticks(count = 4) {
  for (let index = 0; index < count; index += 1) await tick();
}

async function waitFor(predicate, limit = 80) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return true;
    await tick();
  }
  return false;
}

function beginParse(page, text) {
  page.onTextInput({ detail: { value: String(text) } });
  const operation = Promise.resolve(page.runParse());
  operation.catch(() => {});
  return operation;
}

async function beginWxmlAnswer(page, value) {
  const contract = questionUiContract();
  const inputHandler = page[contract.answerInputHandler];
  const actionHandler = page[contract.actionHandler];
  if (!contract.ready || typeof inputHandler !== 'function' || typeof actionHandler !== 'function') {
    const error = new Error('Production question WXML event chain is unavailable');
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  await Promise.resolve(inputHandler.call(page, {
    currentTarget: { dataset: {} }, detail: { value: String(value) }
  }));
  await tick();
  const dataset = resolvedDataset(contract, page);
  const operation = Promise.resolve(actionHandler.call(page, {
    currentTarget: { dataset }, detail: {}
  }));
  operation.catch(() => {});
  return { contract, dataset, operation };
}

function clientRoute(result = {}) {
  const route = result.parse_route || result.route || {};
  return String(route.client_route || route.clientRoute || route.semantic_decision
    || route.semanticDecision || route.decision || '').toUpperCase();
}

function proofSummary(result = {}) {
  return (result.user_manual_edits || []).map((proof) => ({
    field: String(proof.field || ''),
    itemKey: String(proof.itemKey || ''),
    questionIdPresent: Boolean(proof.questionId),
    signaturePresent: Boolean(proof.signature),
    source: String(proof.source || '')
  }));
}

function businessSemantic(data = {}) {
  const result = data.parseResult || {};
  const fields = data.fields || result.fields || {};
  return {
    amount: String(fields.amount || ''),
    calculatedAmount: String(fields.calculatedAmount || ''),
    fields: safeClone(fields),
    intent: String(result.intent || ''),
    operation: String(result.operation || ''),
    missingFields: safeClone(result.missing_fields || []),
    lowConfidenceFields: safeClone(result.low_confidence_fields || []),
    fieldConflicts: safeClone(result.field_conflicts || []),
    blockerLines: safeClone(data.domainBlockingLines || []),
    canPendingSave: Boolean(data.domainCanSavePending),
    domainCanSaveFormal: Boolean(data.domainCanSaveFormal),
    dueDate: String(fields.dueDate || ''),
    domainPreflight: safeClone(data.domainPreflight || {}),
    finalSafety: safeClone(result.final_parse_safety || {}),
    aiFallback: safeClone(result.ai_fallback || {}),
    items: (fields.items || []).map((item) => ({
      itemKey: String(item.confirmationItemKey || item.itemKey || ''),
      productName: String(item.productName || ''),
      quantity: String(item.quantity || ''),
      unitPrice: String(item.unitPrice || '')
    })),
    originalText: String(result.original_text || result.raw_text || ''),
    proof: proofSummary(result),
    trustedProof: safeClone(result.user_manual_edits || []),
    preflightFingerprint: String(data.preflightFingerprint
      || data.domainPreflightFingerprint || result.preflight_fingerprint || ''),
    provider: String(result.ai_provider_identity || result.provider_kind || result.provider
      || (result.ai_fallback || {}).provider_kind || ''),
    route: clientRoute(result),
    userResolution: safeClone(result.user_resolution || {})
  };
}

function snapshot(harness, label) {
  const data = harness.page.data || {};
  const rendered = renderConversationSnapshot(data);
  const network = harness.network.audit();
  const question = questionState(harness.page);
  const mode = rendered.autoReviewVisible ? 'AUTO_REVIEW'
    : (rendered.safeBlockedSurfaceVisible ? 'SAFE_BLOCKED'
      : (rendered.clarifyingSurfaceVisible ? 'CLARIFYING'
        : (rendered.confirmingCoreVisible ? 'CONFIRMING' : 'INPUT')));
  return {
    aiRequests: network.events.filter((entry) => entry.path.startsWith('/api/ai/parse')).map((entry) => ({
      outcome: entry.outcome, path: entry.path, settled: entry.settled
    })),
    assistantState: String(data.assistantQuestionState || ''),
    label,
    mode,
    model: businessSemantic(data),
    parsing: Boolean(data.parsing),
    question: {
      field: String(question.question && question.question.target && question.question.target.field || ''),
      prompt: question.prompt,
      queueLength: question.queueLength,
      status: question.status
    },
    rendered,
    unsettled: network.unsettledRequestCount
  };
}

function exclusiveChecks(prefix, view) {
  const flags = {
    AUTO_REVIEW: view.rendered.autoReviewVisible,
    CLARIFYING: view.rendered.clarifyingSurfaceVisible,
    CONFIRMING: view.rendered.confirmingCoreVisible,
    INPUT: view.rendered.inputModeVisible,
    SAFE_BLOCKED: view.rendered.safeBlockedSurfaceVisible
  };
  const activeCount = Object.values(flags).filter(Boolean).length;
  return [
    check(`${prefix}.ONE_VISIBLE_MODE`, activeCount === 1, 1, { activeCount, flags }, 'RENDERED_WXML'),
    check(`${prefix}.CLARIFY_CONFIRM_EXCLUSIVE`,
      !(view.rendered.clarifyingSurfaceVisible && view.rendered.confirmingCoreVisible),
      { clarifying: 'xor', confirming: 'xor' }, {
        clarifying: view.rendered.clarifyingSurfaceVisible,
        confirming: view.rendered.confirmingCoreVisible
      }, 'RENDERED_WXML'),
    check(`${prefix}.ANSWER_FORM_EXCLUSIVE`,
      !(view.rendered.answerInputVisible && view.rendered.confirmingCoreVisible), true, {
        answerInput: view.rendered.answerInputVisible,
        confirming: view.rendered.confirmingCoreVisible
      }, 'RENDERED_WXML')
  ];
}

function mutationChecks(harness, beforeState, prefix) {
  const after = harness.readState();
  const delta = diffCounts(stateCounts(beforeState), stateCounts(after));
  const business = harness.driver.evidence.productionBusinessCalls || {};
  const storage = harness.driver.evidence.productionStorageCalls || {};
  return [
    check(`${prefix}.STATE_ZERO`, allZero(delta)
      && stableHash(beforeState, 'conversation-state') === stableHash(after, 'conversation-state'),
    'unchanged', { delta, sameHash: stableHash(beforeState, 'conversation-state') === stableHash(after, 'conversation-state') }),
    check(`${prefix}.BUSINESS_ZERO`, Number(business.saveConfirmedDraft || 0) === 0
      && Number(business.savePendingNote || 0) === 0, 0, business),
    check(`${prefix}.STORAGE_ZERO`, Number(storage.saveState || 0) === 0, 0, storage.saveState || 0)
  ];
}

async function withHarness(options, execute) {
  const harness = createPageHarness(options);
  const beforeState = safeClone(harness.readState());
  try {
    return await execute(harness, beforeState);
  } finally {
    if (typeof harness.page.onUnload === 'function') {
      await Promise.resolve(harness.page.onUnload());
    }
    const unsettled = harness.network.audit().unsettledRequestCount;
    harness.dispose();
    if (unsettled !== 0) {
      const error = new Error(`Conversation harness leaked ${unsettled} controlled request(s)`);
      error.code = 'HARNESS_UNSETTLED_REQUESTS';
      throw error;
    }
  }
}

async function conv001() {
  return withHarness({ caseId: 'CONV-001', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' }, async (harness, before) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const view = snapshot(harness, 'CLARIFYING');
    const source = conversationWxmlContract();
    return [
      check('CONV001.TOP_LEVEL_MODE_GATE', source.topLevelMutualExclusion, true, source, 'STATIC_WXML'),
      check('CONV001.QUESTION_SURFACE', view.rendered.clarifyingSurfaceVisible
        && view.rendered.answerInputVisible && view.rendered.answerActionVisible, true, view.rendered, 'RENDERED_WXML'),
      check('CONV001.NO_CONFIRMING_SURFACE', !view.rendered.confirmingCoreVisible
        && !view.rendered.formalSaveVisible && !view.rendered.pendingSaveVisible, true, view.rendered, 'RENDERED_WXML'),
      check('CONV001.EXACT_QUESTION', view.question.prompt === '500个、每个5元、周三交，是什么商品？',
        '500个、每个5元、周三交，是什么商品？', view.question.prompt),
      ...exclusiveChecks('CONV001', view),
      ...mutationChecks(harness, before, 'CONV001')
    ];
  });
}

async function conv002() {
  return withHarness({ caseId: 'CONV-002', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' }, async (harness, before) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const initial = snapshot(harness, 'CLARIFYING');
    const action = await beginWxmlAnswer(harness.page, '水杯');
    await action.operation;
    await ticks();
    const final = snapshot(harness, 'CONFIRMING');
    const fields = harness.page.data.fields || {};
    return [
      check('CONV002.BEFORE_ONLY_CLARIFYING', initial.rendered.clarifyingSurfaceVisible
        && !initial.rendered.confirmingCoreVisible, true, initial.rendered, 'RENDERED_WXML'),
      check('CONV002.LAST_QUESTION_CLOSED', !harness.page.data.activeQuestion, null, harness.page.data.activeQuestion),
      check('CONV002.FINAL_ONLY_CONFIRMING', final.rendered.confirmingCoreVisible
        && !final.rendered.clarifyingSurfaceVisible && final.rendered.formalSaveEnabled, true, final.rendered, 'RENDERED_WXML'),
      check('CONV002.FACTS_READY', fields.productName === '水杯' && fields.quantity === '500'
        && fields.unitPrice === '5' && fields.dueDate === '2026-08-05',
      { productName: '水杯', quantity: '500', unitPrice: '5', dueDate: '2026-08-05' }, fields),
      check('CONV002.ORIGINAL_PRESERVED', final.model.originalText === MISSING_PRODUCT_TEXT,
        MISSING_PRODUCT_TEXT, final.model.originalText),
      check('CONV002.NO_AI', harness.network.aiEvents().length === 0, 0, harness.network.aiEvents().length),
      ...exclusiveChecks('CONV002.BEFORE', initial),
      ...exclusiveChecks('CONV002.AFTER', final),
      ...mutationChecks(harness, before, 'CONV002')
    ];
  });
}

async function conv003() {
  return withHarness({ caseId: 'CONV-003', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' }, async (harness, before) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const view = snapshot(harness, 'CLARIFYING');
    return [
      check('CONV003.KNOWN_FACTS_IN_PROMPT', /500个/.test(view.question.prompt)
        && /每个5元/.test(view.question.prompt) && /周三交/.test(view.question.prompt), true, view.question.prompt),
      check('CONV003.QUESTION_CONTROLS_VISIBLE', view.rendered.clarifyingSurfaceVisible
        && view.rendered.answerInputVisible && view.rendered.answerActionVisible, true, view.rendered, 'RENDERED_WXML'),
      check('CONV003.FORMS_HIDDEN', !view.rendered.confirmingCoreVisible
        && !view.rendered.formalSaveVisible && !view.rendered.pendingSaveVisible, true, view.rendered, 'RENDERED_WXML'),
      ...exclusiveChecks('CONV003', view),
      ...mutationChecks(harness, before, 'CONV003')
    ];
  });
}

async function conv004() {
  const initialChecks = await withHarness({ caseId: 'CONV-004', text: MULTI_ITEM_TEXT, networkMode: 'DEFERRED', response: multiSuccessResponse() }, async (harness, before) => {
    const operation = beginParse(harness.page, MULTI_ITEM_TEXT);
    const requested = await waitFor(() => harness.network.aiEvents().length === 1);
    const pending = snapshot(harness, 'AUTO_REVIEW');
    if (requested) harness.network.releaseAt(harness.network.aiEvents()[0].index, { response: multiSuccessResponse() });
    await operation;
    await waitFor(() => harness.page.data.parsing !== true);
    const final = snapshot(harness, 'CONFIRMING');
    return [
      check('CONV004.DEEP_REQUESTED_ONCE', requested && harness.network.aiEvents().length === 1
        && harness.network.aiEvents()[0].path === '/api/ai/parse/deep', { count: 1, path: '/api/ai/parse/deep' },
      harness.network.aiEvents().map((event) => event.path)),
      check('CONV004.PENDING_WAIT_SURFACE', pending.rendered.autoReviewVisible, true, pending.rendered, 'RENDERED_WXML'),
      check('CONV004.PENDING_NO_CONFIRM', !pending.rendered.confirmingCoreVisible
        && !pending.rendered.formalSaveVisible && !pending.rendered.pendingSaveVisible, true, pending.rendered, 'RENDERED_WXML'),
      check('CONV004.FINAL_CONFIRM_AFTER_SETTLE', final.rendered.confirmingCoreVisible
        && final.rendered.formalSaveEnabled && !final.rendered.autoReviewVisible, true, final.rendered, 'RENDERED_WXML'),
      check('CONV004.NO_MANUAL_DEEP', Number(harness.driver.evidence.pageMethodCalls.requestDeepReview || 0) === 0,
        0, harness.driver.evidence.pageMethodCalls.requestDeepReview || 0),
      ...exclusiveChecks('CONV004.PENDING', pending),
      ...exclusiveChecks('CONV004.FINAL', final),
      ...mutationChecks(harness, before, 'CONV004')
    ];
  });
  const staleConfirmChecks = await withHarness({
    caseId: 'CONV-004-STALE-CONFIRM', text: MULTI_ITEM_TEXT, networkMode: 'SUCCESS', response: multiSuccessResponse()
  }, async (harness, before) => {
    await submitOriginalText(harness.page, MULTI_ITEM_TEXT);
    const beforeReviewState = safeClone(harness.readState());
    const businessBefore = Number(harness.driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0);
    const pendingBefore = Number(harness.driver.evidence.productionBusinessCalls.savePendingNote || 0);
    const storageBefore = Number(harness.driver.evidence.productionStorageCalls.saveState || 0);
    harness.network.setMode('DEFERRED');
    const operation = Promise.resolve(harness.page.runParse());
    operation.catch(() => {});
    const requested = await waitFor(() => harness.network.aiEvents().length === 2);
    const pending = snapshot(harness, 'AUTO_REVIEW_FROM_CONFIRMING');
    await Promise.resolve(harness.page.saveFormal());
    await Promise.resolve(harness.page.savePending());
    await ticks();
    const afterSave = safeClone(harness.readState());
    if (requested) harness.network.releaseAt(harness.network.aiEvents()[1].index, { response: multiSuccessResponse() });
    await operation;
    await waitFor(() => harness.page.data.parsing !== true);
    const delta = diffCounts(stateCounts(beforeReviewState), stateCounts(afterSave));
    const businessDelta = Number(harness.driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0)
      - businessBefore;
    const pendingDelta = Number(harness.driver.evidence.productionBusinessCalls.savePendingNote || 0)
      - pendingBefore;
    const storageDelta = Number(harness.driver.evidence.productionStorageCalls.saveState || 0)
      - storageBefore;
    return [
      check('CONV004.STALE_CONFIRM_REVIEW_STARTED', requested && pending.rendered.autoReviewVisible,
        true, { requested, rendered: pending.rendered }, 'RENDERED_WXML'),
      check('CONV004.STALE_CONFIRM_HIDDEN', !pending.rendered.confirmingCoreVisible
        && !pending.rendered.formalSaveEnabled, true, pending.rendered, 'RENDERED_WXML'),
      check('CONV004.DIRECT_SAVE_DURING_REVIEW_ZERO', allZero(delta)
        && businessDelta === 0 && pendingDelta === 0 && storageDelta === 0,
      { pending: 0, save: 0, state: 'zero', storage: 0 }, {
        pending: pendingDelta, save: businessDelta, state: delta, storage: storageDelta
      }),
      ...exclusiveChecks('CONV004.STALE_CONFIRM', pending)
    ];
  });
  const staleQuestionChecks = await withHarness({
    caseId: 'CONV-004-STALE-QUESTION', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED'
  }, async (harness) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const operation = Promise.resolve(harness.page.runParse());
    operation.catch(() => {});
    const pending = snapshot(harness, 'AUTO_REVIEW_FROM_CLARIFYING');
    await operation;
    return [
      check('CONV004.STALE_QUESTION_HIDDEN', pending.rendered.autoReviewVisible
        && !pending.rendered.clarifyingSurfaceVisible && !pending.rendered.confirmingCoreVisible,
      true, pending.rendered, 'RENDERED_WXML'),
      ...exclusiveChecks('CONV004.STALE_QUESTION', pending)
    ];
  });
  return initialChecks.concat(staleConfirmChecks, staleQuestionChecks);
}

async function conv005() {
  return withHarness({ caseId: 'CONV-005', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' }, async (harness, before) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const action = await beginWxmlAnswer(harness.page, '水杯');
    await action.operation;
    await ticks();
    const final = snapshot(harness, 'CONFIRMING');
    return [
      check('CONV005.NO_AI_AFTER_ANSWER', harness.network.aiEvents().length === 0, 0, harness.network.aiEvents().length),
      check('CONV005.DIRECT_CONFIRMING', final.rendered.confirmingCoreVisible
        && final.rendered.formalSaveEnabled && !final.rendered.autoReviewVisible
        && !final.rendered.clarifyingSurfaceVisible, true, final.rendered, 'RENDERED_WXML'),
      check('CONV005.PROOF_RETAINED', final.model.proof.some((proof) => proof.source === 'USER_ASSISTANT_ANSWER'
        && proof.signaturePresent), true, final.model.proof),
      ...exclusiveChecks('CONV005', final),
      ...mutationChecks(harness, before, 'CONV005')
    ];
  });
}

function requestIdentity(event, authority = {}) {
  const data = event && event.requestData || {};
  return {
    confirmationSessionMatches: Boolean(event && event.confirmationSessionId)
      && String(event.confirmationSessionId) === String(authority.confirmationSessionId || ''),
    draftRevisionMatches: Boolean(String(event && event.draftRevision || '').trim())
      && String(event.draftRevision) === String(authority.draftRevision || ''),
    fingerprintMatches: Boolean(event && event.originalTextFingerprint)
      && String(event.originalTextFingerprint) === String(authority.originalTextFingerprint || '')
      && String(event.originalTextFingerprint) === String(event.independentlyComputedFingerprint || ''),
    requestIdPresent: Boolean(String(event && event.requestId || '').trim()),
    requestedRoute: String(data.requestedRoute || data.requested_route || event && event.route || '').toUpperCase()
  };
}

function serverRejudgable(event) {
  const data = event && event.requestData || {};
  const messages = Array.isArray(data.rawMessages)
    ? data.rawMessages.map((entry) => String(entry && (entry.content || entry.text) || '')).join('\n') : '';
  const canonicalInput = messages || String(data.text || data.extractedText || '');
  const originalCarrier = String(data.rawText || data.raw_text || data.originalText || '');
  return {
    canonicalExcludesOldConflict: !/5000/.test(canonicalInput),
    hasCanonicalAnswer: /4676(?:\.10|\.1)(?!\d)/.test(canonicalInput),
    originalPreservedSeparately: /5000/.test(originalCarrier)
  };
}

async function answerToDeep(caseId, release) {
  return withHarness({ caseId, text: ANSWER_TO_DEEP_TEXT, networkMode: 'DEFERRED' }, async (harness, before) => {
    await submitOriginalText(harness.page, ANSWER_TO_DEEP_TEXT);
    const beforeAnswer = snapshot(harness, 'CLARIFYING');
    const question = safeClone(harness.page.data.activeQuestion || {});
    const authority = {
      confirmationSessionId: String(question.confirmationSessionId || ''),
      draftRevision: String(question.draftRevision || ''),
      originalTextFingerprint: String(question.originalTextFingerprint || '')
    };
    const action = await beginWxmlAnswer(harness.page, '4676.10');
    const requested = await waitFor(() => harness.network.aiEvents().length === 1, 24);
    const pending = snapshot(harness, requested ? 'AUTO_REVIEW' : 'POST_ANSWER_NO_REQUEST');
    const event = harness.network.aiEvents()[0] || null;
    if (event && release) harness.network.releaseAt(event.index, release);
    if (release || !event) {
      await action.operation;
      await waitFor(() => harness.page.data.parsing !== true, 80);
    }
    await ticks();
    return {
      action: { dataset: safeClone(action.dataset) },
      aiEvents: safeClone(harness.network.aiEvents()),
      authority,
      beforeAnswer,
      event: event && safeClone(event),
      final: snapshot(harness, 'SETTLED'),
      finalResult: safeClone(harness.page.data.parseResult || {}),
      manualDeep: Number(harness.driver.evidence.pageMethodCalls.requestDeepReview || 0),
      mutation: mutationChecks(harness, before, caseId),
      pending,
      requested,
      unsettledFinal: harness.network.audit().unsettledRequestCount
    };
  });
}

async function conv006() {
  const probe = await answerToDeep('CONV-006', { response: answerToDeepSuccessResponse() });
  const identity = requestIdentity(probe.event, probe.authority);
  const serverInput = serverRejudgable(probe.event);
  const serverDecision = probe.event ? probeServerRoute(probe.event.requestData) : {
    route: '', reasonCodes: [], questionTarget: null, text: ''
  };
  return [
    check('CONV006.REROUTED_AUTO_DEEP', probe.pending.model.route === 'AUTO_DEEP', 'AUTO_DEEP', probe.pending.model.route),
    check('CONV006.REQUEST_ONCE', probe.requested && probe.aiEvents.length === 1
      && probe.event.path === '/api/ai/parse/deep', { count: 1, path: '/api/ai/parse/deep' },
    probe.aiEvents.map((event) => event.path)),
    check('CONV006.REQUEST_IDENTITY', Object.values(identity).slice(0, 4).every(Boolean)
      && /AUTO_DEEP|AI_DEEP/.test(identity.requestedRoute), 'all identity + AUTO_DEEP', identity),
    check('CONV006.SERVER_CAN_REJUDGE_ANSWER', serverInput.hasCanonicalAnswer
      && serverInput.canonicalExcludesOldConflict && serverInput.originalPreservedSeparately,
    { hasCanonicalAnswer: true, canonicalExcludesOldConflict: true, originalPreservedSeparately: true }, serverInput),
    check('CONV006.TRUSTED_SERVER_ROUTE', serverDecision.route === 'AUTO_DEEP', 'AUTO_DEEP', serverDecision),
    check('CONV006.PENDING_ONLY_AUTO_REVIEW', probe.pending.rendered.autoReviewVisible
      && !probe.pending.rendered.confirmingCoreVisible && !probe.pending.rendered.formalSaveVisible,
    true, probe.pending.rendered, 'RENDERED_WXML'),
    check('CONV006.FINAL_CONFIRM_AFTER_DEEP', probe.final.rendered.confirmingCoreVisible
      && probe.final.rendered.formalSaveEnabled && !probe.final.rendered.autoReviewVisible,
    true, probe.final.rendered, 'RENDERED_WXML'),
    check('CONV006.USER_FACT_RETAINED', probe.final.model.amount === '4676.1'
      && probe.final.model.originalText === ANSWER_TO_DEEP_TEXT,
    { amount: '4676.1', originalText: 'preserved' }, probe.final.model),
    check('CONV006.SETTLED', probe.event && probe.event.settled === true
      && probe.event.outcome === 'HTTP_200' && probe.unsettledFinal === 0,
    { outcome: 'HTTP_200', settled: true, unsettled: 0 }, {
      outcome: probe.event && probe.event.outcome || '', settled: Boolean(probe.event && probe.event.settled),
      unsettled: probe.unsettledFinal
    }),
    ...exclusiveChecks('CONV006.PENDING', probe.pending),
    ...exclusiveChecks('CONV006.FINAL', probe.final),
    ...probe.mutation
  ];
}

async function conv007() {
  const modes = ['TIMEOUT', 'HTTP_500', 'INVALID_JSON', 'UNKNOWN_PROVIDER'];
  const failureContract = {
    TIMEOUT: { code: 'NETWORK_REQUEST_FAILED', outcome: 'NETWORK_REQUEST_FAILED', provider: 'NONE', status: 'timed_out' },
    HTTP_500: { code: 'SERVER_ERROR', outcome: 'HTTP_500', provider: 'NONE', status: 'failed' },
    INVALID_JSON: { code: 'AI_RESPONSE_EMPTY_BUSINESS', outcome: 'HTTP_200', provider: 'NONE', status: 'returned_uncertain' },
    UNKNOWN_PROVIDER: { code: 'AI_PROVIDER_IDENTITY_UNRESOLVED', outcome: 'AI_PROVIDER_IDENTITY_UNRESOLVED', provider: 'UNKNOWN', status: 'failed' }
  };
  const checks = [];
  for (const mode of modes) {
    const probe = await answerToDeep(`CONV-007-${mode}`, { mode });
    const dirty = JSON.stringify({
      fields: probe.final.model.fields,
      parseResult: probe.finalResult
    }).includes('DIRTY_AI');
    const failure = probe.finalResult.ai_fallback || {};
    const expected = failureContract[mode];
    const identity = requestIdentity(probe.event, probe.authority);
    checks.push(
      check(`CONV007.${mode}.REQUEST_ONCE`, probe.requested
        && probe.aiEvents.length === 1 && probe.event.path === '/api/ai/parse/deep',
      { count: 1, path: '/api/ai/parse/deep' }, probe.aiEvents.map((entry) => entry.path)),
      check(`CONV007.${mode}.REQUEST_IDENTITY`, Object.values(identity).slice(0, 4).every(Boolean)
        && /AUTO_DEEP|AI_DEEP/.test(identity.requestedRoute), 'bound request identity', identity),
      check(`CONV007.${mode}.PENDING`, probe.pending.rendered.autoReviewVisible
        && probe.pending.unsettled === 1 && !probe.pending.rendered.confirmingCoreVisible,
      { autoReview: true, confirming: false, unsettled: 1 }, {
        autoReview: probe.pending.rendered.autoReviewVisible,
        confirming: probe.pending.rendered.confirmingCoreVisible,
        unsettled: probe.pending.unsettled
      }, 'RENDERED_WXML'),
      check(`CONV007.${mode}.SAFE_TERMINAL`, probe.final.rendered.safeBlockedSurfaceVisible
        && !probe.final.rendered.confirmingCoreVisible && !probe.final.rendered.formalSaveEnabled,
      'SAFE_BLOCKED only', probe.final.rendered, 'RENDERED_WXML'),
      check(`CONV007.${mode}.FAILURE_CLASSIFICATION`, failure.attempted === true
        && failure.business_result_valid === false && failure.status === expected.status
        && failure.code === expected.code && failure.provider_kind === expected.provider
        && probe.event && probe.event.settled === true && probe.event.outcome === expected.outcome
        && probe.unsettledFinal === 0 && probe.final.model.route === 'SAFE_BLOCKED', expected, {
          code: failure.code, outcome: probe.event && probe.event.outcome || '',
          provider: failure.provider_kind, route: probe.final.model.route,
          status: failure.status, unsettled: probe.unsettledFinal
        }),
      check(`CONV007.${mode}.USER_LOCAL_RETAINED`, probe.final.model.originalText === ANSWER_TO_DEEP_TEXT
        && probe.final.model.amount === '4676.1' && probe.final.model.items.length === 2,
      { amount: '4676.1', itemCount: 2, originalText: 'preserved' }, probe.final.model),
      check(`CONV007.${mode}.NO_DIRTY_ADOPTION`, !dirty, false, dirty),
      ...exclusiveChecks(`CONV007.${mode}`, probe.final),
      ...probe.mutation
    );
  }
  return checks;
}

async function conv008() {
  const probe = await answerToDeep('CONV-008', { response: answerToDeepSuccessResponse() });
  return [
    check('CONV008.NO_QUESTION', probe.pending.question.prompt === '', '', probe.pending.question.prompt),
    check('CONV008.REVIEW_STILL_REQUIRED', probe.pending.model.route === 'AUTO_DEEP', 'AUTO_DEEP', probe.pending.model.route),
    check('CONV008.NOT_CONFIRMING_ON_NULL_QUESTION', !probe.pending.rendered.confirmingCoreVisible
      && !probe.pending.rendered.formalSaveEnabled, true, probe.pending.rendered, 'RENDERED_WXML'),
    check('CONV008.REQUEST_CLEANED', probe.unsettledFinal === 0, 0, probe.unsettledFinal),
    ...exclusiveChecks('CONV008', probe.pending),
    ...probe.mutation
  ];
}

async function conv009() {
  const views = [];
  await withHarness({ caseId: 'CONV-009-CLARIFY', text: MISSING_PRODUCT_TEXT }, async (harness) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    views.push(snapshot(harness, 'CLARIFYING'));
  });
  await withHarness({ caseId: 'CONV-009-CONFIRM', text: SIMPLE_ORDER_TEXT }, async (harness) => {
    await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
    views.push(snapshot(harness, 'CONFIRMING'));
  });
  await withHarness({ caseId: 'CONV-009-REVIEW', text: MULTI_ITEM_TEXT, networkMode: 'DEFERRED' }, async (harness) => {
    const operation = beginParse(harness.page, MULTI_ITEM_TEXT);
    const requested = await waitFor(() => harness.network.aiEvents().length === 1);
    views.push(snapshot(harness, 'AUTO_REVIEW'));
    if (requested) harness.network.releaseAt(harness.network.aiEvents()[0].index, { response: multiSuccessResponse() });
    await operation;
    await waitFor(() => harness.page.data.parsing !== true);
  });
  await withHarness({ caseId: 'CONV-009-SAFE', text: MULTI_ITEM_TEXT, networkMode: 'TIMEOUT' }, async (harness) => {
    await submitOriginalText(harness.page, MULTI_ITEM_TEXT);
    views.push(snapshot(harness, 'SAFE_BLOCKED'));
  });
  await withHarness({ caseId: 'CONV-009-INPUT', text: '' }, async (harness) => {
    views.push(snapshot(harness, 'INPUT'));
  });
  return views.flatMap((view, index) => exclusiveChecks(`CONV009.STEP${index + 1}`, view));
}

async function conv010() {
  return withHarness({ caseId: 'CONV-010', text: MULTI_ITEM_TEXT, networkMode: 'TIMEOUT' }, async (harness, before) => {
    await submitOriginalText(harness.page, MULTI_ITEM_TEXT);
    const view = snapshot(harness, 'SAFE_BLOCKED');
    const text = String(harness.page.data.safeBlockedMessage || '');
    const recoveryHandler = harness.page[view.rendered.recoveryActionHandler];
    if (typeof recoveryHandler === 'function') {
      await Promise.resolve(recoveryHandler.call(harness.page, { currentTarget: { dataset: {} }, detail: {} }));
      await ticks();
    }
    const recovered = snapshot(harness, 'INPUT');
    return [
      check('CONV010.SAFE_RECOVERY_VISIBLE', view.rendered.safeBlockedSurfaceVisible
        && view.rendered.recoveryActionVisible && Boolean(view.rendered.recoveryActionHandler), true,
      view.rendered, 'RENDERED_WXML'),
      check('CONV010.NO_OTHER_SURFACES', !view.rendered.confirmingCoreVisible
        && !view.rendered.clarifyingSurfaceVisible && !view.rendered.formalSaveVisible
        && !view.rendered.pendingSaveVisible, true, view.rendered, 'RENDERED_WXML'),
      check('CONV010.NON_TECHNICAL_COPY', Boolean(text) && text.length <= 60
        && !/AI|route|Provider|requestId|HTTP/i.test(text), 'short non-technical copy', text),
      check('CONV010.DEEP_FAILED_ONCE', harness.network.aiEvents().length === 1
        && harness.network.aiEvents()[0].outcome === 'NETWORK_REQUEST_FAILED',
      { count: 1, outcome: 'NETWORK_REQUEST_FAILED' }, harness.network.aiEvents()),
      check('CONV010.RECOVERY_TO_INPUT', typeof recoveryHandler === 'function'
        && recovered.rendered.inputModeVisible && recovered.model.originalText === ''
        && harness.page.data.text === MULTI_ITEM_TEXT,
      { handler: 'callable', input: true, originalInput: MULTI_ITEM_TEXT, parseResult: null }, {
        handler: typeof recoveryHandler, input: recovered.rendered.inputModeVisible,
        originalInput: harness.page.data.text, originalText: recovered.model.originalText
      }, 'RENDERED_WXML'),
      ...exclusiveChecks('CONV010', view),
      ...mutationChecks(harness, before, 'CONV010')
    ];
  });
}

async function conv011() {
  return withHarness({ caseId: 'CONV-011', text: SIMPLE_ORDER_TEXT }, async (harness, before) => {
    await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
    const initial = snapshot(harness, 'CONFIRMING');
    const item = (harness.page.data.confirmItems || [])[0] || {};
    await Promise.resolve(harness.page.updateItemField({
      currentTarget: { dataset: { field: 'productName', itemKey: item.itemKey } },
      detail: { value: '' }
    }));
    await ticks();
    const final = snapshot(harness, 'CLARIFYING');
    return [
      check('CONV011.START_CONFIRMING', initial.rendered.confirmingCoreVisible
        && initial.rendered.formalSaveEnabled, true, initial.rendered, 'RENDERED_WXML'),
      check('CONV011.NEW_QUESTION', Boolean(harness.page.data.activeQuestion)
        && final.question.field === 'productName', 'productName', final.question),
      check('CONV011.RETURNS_ONLY_CLARIFYING', final.rendered.clarifyingSurfaceVisible
        && !final.rendered.confirmingCoreVisible && !final.rendered.formalSaveVisible
        && !final.rendered.pendingSaveVisible, true, final.rendered, 'RENDERED_WXML'),
      ...exclusiveChecks('CONV011', final),
      ...mutationChecks(harness, before, 'CONV011')
    ];
  });
}

async function conv012() {
  const checks = [];
  for (const [label, text] of [['CLARIFYING', MISSING_PRODUCT_TEXT], ['CONFIRMING', SIMPLE_ORDER_TEXT]]) {
    await withHarness({ caseId: `CONV-012-${label}`, text }, async (harness, before) => {
      await submitOriginalText(harness.page, text);
      const semanticBefore = businessSemantic(harness.page.data);
      const expandedBefore = Boolean(harness.page.data.originalTextExpanded);
      if (typeof harness.page.toggleOriginalText !== 'function') {
        const error = new Error('Production original-text presentation action is unavailable');
        error.code = 'TEST_DATA_ERROR';
        throw error;
      }
      await Promise.resolve(harness.page.toggleOriginalText());
      await ticks();
      const expandedAfter = Boolean(harness.page.data.originalTextExpanded);
      const semanticAfter = businessSemantic(harness.page.data);
      const sensitivity = safeClone(semanticBefore);
      sensitivity.fields = Object.assign({}, sensitivity.fields, { customerName: '__ORACLE_CHANGE__' });
      const view = snapshot(harness, label);
      checks.push(
        check(`CONV012.${label}.PRESENTATION_CHANGED`, expandedBefore !== expandedAfter,
          { before: false, after: true }, { after: expandedAfter, before: expandedBefore }),
        check(`CONV012.${label}.PRESENTATION_PURE`,
          stableHash(semanticBefore, 'conversation-semantics') === stableHash(semanticAfter, 'conversation-semantics'),
        'same semantic hash', { after: semanticAfter, before: semanticBefore }),
        check(`CONV012.${label}.ORACLE_SENSITIVE`,
          stableHash(semanticBefore, 'conversation-semantics')
            !== stableHash(sensitivity, 'conversation-semantics'), true, true),
        ...exclusiveChecks(`CONV012.${label}`, view),
        ...mutationChecks(harness, before, `CONV012.${label}`)
      );
    });
  }
  return checks;
}

async function green001() {
  return withHarness({ caseId: 'GREEN-CONV-001', text: SIMPLE_ORDER_TEXT }, async (harness, before) => {
    await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
    const view = snapshot(harness, 'CONFIRMING');
    return [
      check('GREEN001.NO_QUESTION', !harness.page.data.activeQuestion, null, harness.page.data.activeQuestion),
      check('GREEN001.NO_AI', harness.network.aiEvents().length === 0, 0, harness.network.aiEvents().length),
      check('GREEN001.CONFIRM_READY', view.rendered.confirmingCoreVisible && view.rendered.formalSaveEnabled,
        true, view.rendered, 'RENDERED_WXML'),
      ...mutationChecks(harness, before, 'GREEN001')
    ];
  });
}

async function green002() {
  return withHarness({ caseId: 'GREEN-CONV-002', text: MISSING_PRODUCT_TEXT }, async (harness, before) => {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const hadQuestion = Boolean(harness.page.data.activeQuestion);
    const action = await beginWxmlAnswer(harness.page, '水杯');
    await action.operation;
    await ticks();
    const view = snapshot(harness, 'CONFIRMING');
    return [
      check('GREEN002.REAL_QUESTION_ANSWER', hadQuestion && !harness.page.data.activeQuestion, true,
        { after: Boolean(harness.page.data.activeQuestion), before: hadQuestion }),
      check('GREEN002.PRODUCT', harness.page.data.fields.productName === '水杯', '水杯', harness.page.data.fields.productName),
      check('GREEN002.CONFIRM_READY', view.rendered.confirmingCoreVisible && view.rendered.formalSaveEnabled,
        true, view.rendered, 'RENDERED_WXML'),
      ...mutationChecks(harness, before, 'GREEN002')
    ];
  });
}

async function green003() {
  return withHarness({ caseId: 'GREEN-CONV-003', text: MULTI_ITEM_TEXT, networkMode: 'DEFERRED' }, async (harness, before) => {
    const operation = beginParse(harness.page, MULTI_ITEM_TEXT);
    const requested = await waitFor(() => harness.network.aiEvents().length === 1);
    if (requested) harness.network.releaseAt(harness.network.aiEvents()[0].index, { response: multiSuccessResponse() });
    await operation;
    await waitFor(() => harness.page.data.parsing !== true);
    const view = snapshot(harness, 'CONFIRMING');
    return [
      check('GREEN003.DEEP_ONCE', requested && harness.network.aiEvents().length === 1
        && harness.network.aiEvents()[0].path === '/api/ai/parse/deep',
      { count: 1, path: '/api/ai/parse/deep' }, harness.network.aiEvents().map((event) => event.path)),
      check('GREEN003.TWO_ITEMS', (harness.page.data.confirmItems || []).length === 2,
        2, (harness.page.data.confirmItems || []).length),
      check('GREEN003.CONFIRM_READY', view.rendered.confirmingCoreVisible && view.rendered.formalSaveEnabled,
        true, view.rendered, 'RENDERED_WXML'),
      ...mutationChecks(harness, before, 'GREEN003')
    ];
  });
}

const EXECUTORS = {
  'CONV-001': conv001,
  'CONV-002': conv002,
  'CONV-003': conv003,
  'CONV-004': conv004,
  'CONV-005': conv005,
  'CONV-006': conv006,
  'CONV-007': conv007,
  'CONV-008': conv008,
  'CONV-009': conv009,
  'CONV-010': conv010,
  'CONV-011': conv011,
  'CONV-012': conv012,
  'GREEN-CONV-001': green001,
  'GREEN-CONV-002': green002,
  'GREEN-CONV-003': green003
};

async function executeCase(spec) {
  const executor = EXECUTORS[spec.id];
  if (!executor) {
    const error = new Error(`Missing executor for ${spec.id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  return executor();
}

module.exports = { EXECUTORS, executeCase, snapshot };
