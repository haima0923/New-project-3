const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { parseInput } = require('../../../utils/parser');
const { normalizeAiResult } = require('../../../utils/ai-parser');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { evaluateRecordDomainPreflight } = require('../../../utils/record-domain-preflight');
const {
  MISSING_PRODUCT_TEXT,
  SECOND_AMBIGUOUS_TEXT,
  SIMPLE_ORDER_TEXT,
  deepMultiItemResponse,
  maliciousManualResponse,
  uncertainProductResponse
} = require('./fixtures');
const {
  answerQuestion,
  editField,
  inputEvent,
  questionState,
  startOriginalText,
  submitOriginalText,
  tick,
  visibleUserText,
  waitForAiRequests,
  waitForParseIdle
} = require('./page-actions');
const { createPageHarness, diffCounts, stateCounts } = require('./runtime');
const { BUSINESS_STORAGE_KEY } = require('../runner/constants');

const INTERNAL_WORDS = [
  'Local', 'Deep', 'AI', '深度核对', '低置信', 'route', '路由', 'provider', 'returned_uncertain', 'HTTP 401', 'HTTP 500',
  'AI_PROVIDER', 'NETWORK_REQUEST_FAILED'
];

function compact(value) {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  return safeClone(value);
}

function createChecks() {
  const checks = [];
  function check(code, pass, expected, actual) {
    checks.push({ actual: compact(actual), code, expected: compact(expected), pass: pass === true });
  }
  return { check, checks };
}

function itemValues(page) {
  const items = page.data.confirmItems || (page.data.fields && page.data.fields.items) || [];
  return items.map((item) => ({
    productName: String(item.productName || ''),
    quantity: String(item.quantity || ''),
    spec: String(item.spec || ''),
    unit: String(item.unit || ''),
    unitPrice: String(item.unitPrice || '')
  }));
}

function originalText(page) {
  const result = page.data.parseResult || {};
  return String(result.original_text || result.originalText || '');
}

function blockingCount(page) {
  const issues = page.data.domainPreflight && page.data.domainPreflight.blockingIssues;
  return Array.isArray(issues) ? issues.length : -1;
}

function noMutation(check, harness, beforeState, prefix) {
  const afterState = harness.readState();
  const deltas = diffCounts(stateCounts(beforeState), stateCounts(afterState));
  const driver = harness.driver.evidence;
  const businessCalls = driver.productionBusinessCalls;
  const storageCalls = driver.productionStorageCalls;
  const allZero = Object.values(deltas).every((value) => value === 0);
  check(`${prefix}.STATE_ZERO_MUTATION`, allZero, true, deltas);
  check(`${prefix}.FULL_STATE_UNCHANGED`,
    stableHash(afterState, 'record-confirm-after') === stableHash(beforeState, 'record-confirm-after'),
    true, {
      after: stableHash(afterState, 'record-confirm-after'),
      before: stableHash(beforeState, 'record-confirm-after')
    });
  check(`${prefix}.BUSINESS_ZERO_CALLS`,
    businessCalls.saveConfirmedDraft === 0 && businessCalls.savePendingNote === 0,
    { saveConfirmedDraft: 0, savePendingNote: 0 }, businessCalls);
  check(`${prefix}.STORAGE_ZERO_WRITES`, storageCalls.saveState === 0, 0, storageCalls.saveState);
  const directBusinessSets = harness.fakeWx.audit().storageEvents.filter((event) => (
    event.operation === 'SET' && event.key === BUSINESS_STORAGE_KEY
  ));
  check(`${prefix}.WX_BUSINESS_STORAGE_ZERO_SETS`, directBusinessSets.length === 0, 0,
    directBusinessSets.length);
  return deltas;
}

function questionChecks(check, page, prefix = 'QUESTION', expectedPrompt = '500个、每个5元、周三交，是什么商品？') {
  const state = questionState(page);
  const question = state.question || {};
  const target = question.target || {};
  check(`${prefix}.EXISTS`, Boolean(state.question), true, Boolean(state.question));
  check(`${prefix}.PROMPT`, state.prompt === expectedPrompt, expectedPrompt, state.prompt);
  check(`${prefix}.ID`, Boolean(question.questionId || question.id), 'non-empty', question.questionId || question.id || '');
  check(`${prefix}.REVISION`, Boolean(question.draftRevision || question.revision),
    'non-empty', question.draftRevision || question.revision || '');
  check(`${prefix}.FIELD`,
    (target.field || question.field) === 'productName', 'productName', target.field || question.field || '');
  check(`${prefix}.FIELD_PATH`,
    (target.fieldPath || question.fieldPath) === 'items[0].productName',
    'items[0].productName', target.fieldPath || question.fieldPath || '');
  check(`${prefix}.ITEM_KEY`, Boolean(target.itemKey || question.itemKey), 'non-empty', target.itemKey || question.itemKey || '');
  check(`${prefix}.RISK_IDS`, Array.isArray(question.riskIds) && question.riskIds.length > 0,
    'at least one', question.riskIds || []);
  check(`${prefix}.ANSWER_TYPE`, question.answerType === 'text', 'text', question.answerType || '');
  check(`${prefix}.OPEN`, question.status === 'OPEN', 'OPEN', question.status || '');
  check(`${prefix}.ASKING_STATE`, state.status === 'ASKING', 'ASKING', state.status);
  check(`${prefix}.ONE_ACTIVE`, state.queueLength <= 1, '<=1', state.queueLength);
  return state;
}

async function executeAssistantQuestion(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  questionChecks(check, harness.page);
  check('UX001.PRODUCT_NOT_DATE_PHRASE',
    !itemValues(harness.page).some((item) => item.productName.includes('周三交')),
    true, itemValues(harness.page));
  check('UX001.SAVE_BLOCKED', harness.page.data.disableFormalSave === true, true,
    harness.page.data.disableFormalSave);
  check('UX001.ORIGINAL_TEXT', originalText(harness.page) === spec.text, spec.text, originalText(harness.page));
  noMutation(check, harness, beforeState, 'UX001');
}

async function executeAnswerSave(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  const beforeQuestion = questionChecks(check, harness.page, 'UX002.BEFORE');
  const answer = await answerQuestion(harness.page, '水杯');
  check('UX002.ANSWER_ACTION', answer.supported === true, true, answer.supported);
  const afterQuestion = questionState(harness.page);
  const items = itemValues(harness.page);
  check('UX002.PRODUCT', items[0] && items[0].productName === '水杯', '水杯', items[0] || null);
  check('UX002.QUESTION_CLOSED', !afterQuestion.question || afterQuestion.question.status !== 'OPEN', true,
    afterQuestion.question);
  check('UX002.SAME_CARD', harness.page.data.text === spec.text, spec.text, harness.page.data.text);
  check('UX002.SAVE_ENABLED', harness.page.data.disableFormalSave === false, false,
    harness.page.data.disableFormalSave);
  check('UX002.SAVE_VISIBLE', harness.page.data.showFormalSaveButton === true, true,
    harness.page.data.showFormalSaveButton);
  check('UX002.ORIGINAL_TEXT', originalText(harness.page) === spec.text, spec.text, originalText(harness.page));
  const edits = harness.page.data.parseResult && harness.page.data.parseResult.user_manual_edits || [];
  const q = beforeQuestion.question || {};
  const target = q.target || {};
  check('UX002.ANSWER_PROVENANCE', edits.some((entry) => (
    entry.source === 'USER_ASSISTANT_ANSWER'
      && entry.field === 'productName'
      && String(entry.itemKey || '') === String(target.itemKey || q.itemKey || '')
      && String(entry.questionId || '') === String(q.questionId || q.id || '')
      && String(entry.draftRevision || entry.revision || '') === String(q.draftRevision || q.revision || '')
  )), 'bound user answer proof', edits);
  if (answer.supported && harness.page.data.disableFormalSave === false) harness.page.saveFormal();
  const afterState = harness.readState();
  const deltas = diffCounts(stateCounts(beforeState), stateCounts(afterState));
  check('UX002.SAVED_COUNTS',
    deltas.customers === 1 && deltas.orders === 1 && deltas.orderProgress === 1
      && deltas.aiParseLogs === 1 && deltas.pendingNotes === 0,
    { aiParseLogs: 1, customers: 1, orderProgress: 1, orders: 1, pendingNotes: 0 }, deltas);
  check('UX002.SAVE_CALLS',
    harness.driver.evidence.productionBusinessCalls.saveConfirmedDraft === 1
      && harness.driver.evidence.productionStorageCalls.saveState === 1,
    { saveConfirmedDraft: 1, saveState: 1 }, {
      saveConfirmedDraft: harness.driver.evidence.productionBusinessCalls.saveConfirmedDraft,
      saveState: harness.driver.evidence.productionStorageCalls.saveState
    });
  const order = (afterState.orders || [])[0] || {};
  const savedItem = (order.items || [])[0] || {};
  check('UX002.SAVED_FACTS', savedItem.productName === '水杯'
    && String(savedItem.quantity || '') === '500'
    && savedItem.unit === '个'
    && String(savedItem.unitPrice || '') === '5'
    && order.originalText === spec.text
    && Boolean(order.requiredDeliveryDate),
  { productName: '水杯', quantity: '500', unit: '个', unitPrice: '5', originalText: spec.text, dueDate: 'non-empty' },
  { item: savedItem, originalText: order.originalText || '', dueDate: order.requiredDeliveryDate || '' });
}

async function executeAutomaticDeep(spec, harness, check, beforeState) {
  await startOriginalText(harness.page, spec.text);
  await tick();
  let requests = harness.network.aiEvents();
  if (requests.length > 0) {
    harness.page.runParse();
    await tick();
    requests = harness.network.aiEvents();
    requests.forEach((event) => {
      if (!event.settled) harness.network.releaseAt(event.index, { response: deepMultiItemResponse() });
    });
    await waitForParseIdle(harness.page);
  } else {
    await waitForParseIdle(harness.page);
  }
  const deep = requests.filter((event) => (
    event.reviewMode === 'deep' || event.path === '/api/ai/parse/deep'
  ));
  check('UX005.AUTO_DEEP_ONCE', deep.length === 1 && requests.length === 1,
    { allAi: 1, deep: 1 }, { allAi: requests.length, deep: deep.length, paths: requests.map((event) => event.path) });
  check('UX005.NO_MANUAL_ACTION',
    Number(harness.driver.evidence.pageMethodCalls.requestDeepReview || 0) === 0,
    0, harness.driver.evidence.pageMethodCalls.requestDeepReview || 0);
  check('UX005.NO_MANUAL_BUTTON', harness.page.data.showDeepReviewButton === false, false,
    harness.page.data.showDeepReviewButton);
  const items = itemValues(harness.page);
  check('UX005.ITEMS', items.length === 2
    && items[0].productName === '礼品盒' && items[0].spec === '大号'
    && items[0].quantity === '100' && items[0].unitPrice === '3'
    && items[1].productName === '礼品盒' && items[1].spec === '小号'
    && items[1].quantity === '200' && items[1].unitPrice === '2',
  [
    { productName: '礼品盒', quantity: '100', spec: '大号', unitPrice: '3' },
    { productName: '礼品盒', quantity: '200', spec: '小号', unitPrice: '2' }
  ], items);
  check('UX005.SAVE_ENABLED', harness.page.data.disableFormalSave === false, false,
    harness.page.data.disableFormalSave);
  const userText = visibleUserText(harness.page);
  check('UX005.NO_INTERNAL_WORDS', !INTERNAL_WORDS.some((word) => userText.includes(word)),
    'no internal words', userText);
  noMutation(check, harness, beforeState, 'UX005');
}

async function executeLastRiskAnswer(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  questionChecks(check, harness.page, 'UX011A.BEFORE');
  const answer = await answerQuestion(harness.page, '水杯');
  const after = questionState(harness.page);
  check('UX011A.ACTION', answer.supported === true, true, answer.supported);
  check('UX011A.NO_OPEN_QUESTION', !after.question || after.question.status !== 'OPEN', true, after.question);
  check('UX011A.NO_BLOCKING', blockingCount(harness.page) === 0, 0, blockingCount(harness.page));
  check('UX011A.SAVE_ENABLED_SAME_TURN', harness.page.data.disableFormalSave === false, false,
    harness.page.data.disableFormalSave);
  check('UX011A.SAVE_ACTION_EXISTS', typeof harness.page.saveFormal === 'function', true,
    typeof harness.page.saveFormal === 'function');
  noMutation(check, harness, beforeState, 'UX011A');
}

async function executeLastRiskDirectEdit(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  editField(harness.page, 'amount', '500');
  await tick();
  check('UX011B.AMOUNT', String(harness.page.data.fields && harness.page.data.fields.amount || '') === '500',
    '500', harness.page.data.fields && harness.page.data.fields.amount);
  check('UX011B.NO_BLOCKING', blockingCount(harness.page) === 0, 0, blockingCount(harness.page));
  check('UX011B.SAVE_ENABLED_SAME_TURN', harness.page.data.disableFormalSave === false, false,
    harness.page.data.disableFormalSave);
  check('UX011B.SAVE_VISIBLE', harness.page.data.showFormalSaveButton === true, true,
    harness.page.data.showFormalSaveButton);
  noMutation(check, harness, beforeState, 'UX011B');
}

async function executeRiskQueue(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  const first = questionChecks(check, harness.page, 'UX011C.FIRST');
  const answer = await answerQuestion(harness.page, '水杯');
  const second = questionState(harness.page);
  check('UX011C.ACTION', answer.supported === true, true, answer.supported);
  check('UX011C.NEXT_QUESTION', Boolean(second.question), true, Boolean(second.question));
  check('UX011C.QUESTION_ADVANCED', Boolean(first.question && second.question)
    && String(first.question.questionId || first.question.id) !== String(second.question.questionId || second.question.id),
  'different questionId', {
    first: first.question && (first.question.questionId || first.question.id) || '',
    second: second.question && (second.question.questionId || second.question.id) || ''
  });
  check('UX011C.STILL_BLOCKED', harness.page.data.disableFormalSave === true, true,
    harness.page.data.disableFormalSave);
  noMutation(check, harness, beforeState, 'UX011C');
}

async function executeAiFailure(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  const requests = harness.network.aiEvents();
  check('UX012.REQUEST_MAX_ONE', requests.length <= 1, '<=1', requests.map((event) => event.path));
  check('UX012.REQUEST_EXERCISED', requests.length === 1, 1, requests.length);
  check('UX012.NOT_LOADING', harness.page.data.parsing !== true, false, harness.page.data.parsing);
  questionChecks(check, harness.page, 'UX012.FALLBACK_QUESTION');
  check('UX012.SAVE_BLOCKED', harness.page.data.disableFormalSave === true, true,
    harness.page.data.disableFormalSave);
  const result = harness.page.data.parseResult || {};
  check('UX012.NO_AI_BUSINESS_SENTINEL', !JSON.stringify(result).includes('DIRTY_AI_'),
    true, JSON.stringify(result).includes('DIRTY_AI_'));
  check('UX012.NO_AI_MANUAL',
    (result.manual_fields || []).length === 0
      && (result.manual_item_fields || []).length === 0
      && (result.user_manual_edits || []).length === 0,
    { manual_fields: [], manual_item_fields: [], user_manual_edits: [] }, {
      manual_fields: result.manual_fields || [],
      manual_item_fields: result.manual_item_fields || [],
      user_manual_edits: result.user_manual_edits || []
    });
  const visible = visibleUserText(harness.page);
  const uiText = (harness.fakeWx.audit().uiEvents || []).map((event) => (
    [event.title, event.content].filter(Boolean).join('\n')
  )).join('\n');
  const allVisibleText = [visible, uiText].filter(Boolean).join('\n');
  check('UX012.NO_TECH_TEXT', !INTERNAL_WORDS.some((word) => allVisibleText.includes(word)),
    'no internal words', allVisibleText);
  noMutation(check, harness, beforeState, 'UX012');
}

async function executeStaleUserEdit(spec, harness, check, beforeState) {
  await startOriginalText(harness.page, spec.text);
  await waitForAiRequests(harness.network, 1);
  harness.page.onTextInput(inputEvent(SIMPLE_ORDER_TEXT));
  const event = harness.network.aiEvents()[0];
  harness.network.releaseAt(event.index, { response: Object.assign(maliciousManualResponse(), {
    ai_request_id: event.requestId || 'stale-response-after-user-edit'
  }) });
  await tick();
  check('UX012_EDIT.REQUEST_ID_PRESENT', Boolean(event.requestId), 'non-empty', event.requestId);
  check('UX012_EDIT.REVISION_PRESENT', Boolean(event.draftRevision), 'non-empty', event.draftRevision);
  check('UX012_EDIT.NEW_TEXT_RETAINED', harness.page.data.text === SIMPLE_ORDER_TEXT,
    SIMPLE_ORDER_TEXT, harness.page.data.text);
  check('UX012_EDIT.OLD_RESULT_DISCARDED', !harness.page.data.parseResult
    || originalText(harness.page) === SIMPLE_ORDER_TEXT, true, originalText(harness.page));
  check('UX012_EDIT.NOT_LOADING', harness.page.data.parsing !== true, false, harness.page.data.parsing);
  check('UX012_EDIT.REQUEST_MAX_ONE', harness.network.aiEvents().length === 1, 1,
    harness.network.aiEvents().length);
  noMutation(check, harness, beforeState, 'UX012_EDIT');
}

async function executeStaleRevision(spec, harness, check, beforeState) {
  await startOriginalText(harness.page, spec.text);
  await waitForAiRequests(harness.network, 1);
  harness.page.onTextInput(inputEvent(SECOND_AMBIGUOUS_TEXT));
  harness.page.runParse();
  await waitForAiRequests(harness.network, 2);
  const events = harness.network.aiEvents();
  harness.network.releaseAt(events[1].index, { response: Object.assign(uncertainProductResponse(), {
    ai_request_id: events[1].requestId || 'new-revision-response'
  }) });
  await waitForParseIdle(harness.page);
  harness.network.releaseAt(events[0].index, { response: Object.assign(maliciousManualResponse(), {
    ai_request_id: events[0].requestId || 'old-revision-response'
  }) });
  await tick();
  check('UX012_REVISION.REQUEST_IDS', events.every((event) => Boolean(event.requestId))
    && events[0].requestId !== events[1].requestId,
  'two non-empty unique requestIds', events.map((event) => event.requestId));
  check('UX012_REVISION.FINGERPRINTS', events[0].originalTextFingerprint !== events[1].originalTextFingerprint,
    'different fingerprints', events.map((event) => event.originalTextFingerprint));
  check('UX012_REVISION.REVISIONS', events.every((event) => Boolean(event.draftRevision))
    && events[0].draftRevision !== events[1].draftRevision,
  'two non-empty distinct revisions', events.map((event) => event.draftRevision));
  check('UX012_REVISION.NEW_TEXT_RETAINED', harness.page.data.text === SECOND_AMBIGUOUS_TEXT,
    SECOND_AMBIGUOUS_TEXT, harness.page.data.text);
  check('UX012_REVISION.OLD_RESULT_DISCARDED', !harness.page.data.parseResult
    || originalText(harness.page) === SECOND_AMBIGUOUS_TEXT, true, originalText(harness.page));
  check('UX012_REVISION.REQUESTS_BY_REVISION', events.length === 2, 2, events.length);
  check('UX012_REVISION.NOT_LOADING', harness.page.data.parsing !== true, false, harness.page.data.parsing);
  questionChecks(
    check,
    harness.page,
    'UX012_REVISION.FALLBACK_QUESTION',
    '200个、每个6元、周四交，是什么商品？'
  );
  noMutation(check, harness, beforeState, 'UX012_REVISION');
}

async function executeDuplicateRequest(spec, harness, check, beforeState) {
  await startOriginalText(harness.page, spec.text);
  await waitForAiRequests(harness.network, 1);
  harness.page.runParse();
  await tick();
  const events = harness.network.aiEvents();
  check('UX012_DUP.ONE_IN_FLIGHT', events.length === 1, 1, events.length);
  const expectedFingerprint = stableHash({ text: spec.text }, 'record-confirm-original-text');
  check('UX012_DUP.REQUEST_KEY', events.length > 0
    && events.every((event) => event.originalTextFingerprint === expectedFingerprint)
    && Boolean(events[0].draftRevision),
  { draftRevision: 'non-empty', originalTextFingerprint: expectedFingerprint }, events.map((event) => ({
    draftRevision: event.draftRevision,
    originalTextFingerprint: event.originalTextFingerprint
  })));
  events.forEach((event) => {
    if (!event.settled) harness.network.releaseAt(event.index, { mode: 'EMPTY_PAYLOAD' });
  });
  await waitForParseIdle(harness.page);
  check('UX012_DUP.NOT_LOADING', harness.page.data.parsing !== true, false, harness.page.data.parsing);
  questionChecks(check, harness.page, 'UX012_DUP.FALLBACK_QUESTION');
  noMutation(check, harness, beforeState, 'UX012_DUP');
}

async function executeSimpleLocal(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  check('GREEN001.ZERO_AI', harness.network.aiEvents().length === 0, 0,
    harness.network.aiEvents().length);
  check('GREEN001.LOCAL_RESULT', Boolean(harness.page.data.parseResult), true,
    Boolean(harness.page.data.parseResult));
  check('GREEN001.NOT_LOADING', harness.page.data.parsing !== true, false, harness.page.data.parsing);
  noMutation(check, harness, beforeState, 'GREEN001');
}

async function executeOriginalText(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  check('GREEN002.ZERO_AI', harness.network.aiEvents().length === 0, 0,
    harness.network.aiEvents().length);
  check('GREEN002.ORIGINAL_EXACT', originalText(harness.page) === spec.text, spec.text,
    originalText(harness.page));
  check('GREEN002.LOCAL_DRAFT', Boolean(harness.page.data.parseResult
    && (harness.page.data.parseResult.ai_fallback || {}).status === 'not_requested'),
  'ai_fallback.status=not_requested', harness.page.data.parseResult && harness.page.data.parseResult.ai_fallback);
  noMutation(check, harness, beforeState, 'GREEN002');
}

async function executeFailureNoMutation(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  check('GREEN003.FAILURE_EXERCISED', harness.network.aiEvents().length === 1, 1,
    harness.network.aiEvents().length);
  harness.page.saveFormal();
  noMutation(check, harness, beforeState, 'GREEN003');
}

async function executeProvenance(spec, harness, check, beforeState) {
  await submitOriginalText(harness.page, spec.text);
  const result = harness.page.data.parseResult || {};
  check('GREEN004.REQUEST_EXERCISED', harness.network.aiEvents().length === 1, 1,
    harness.network.aiEvents().length);
  check('GREEN004.AI_CANNOT_FORGE_MANUAL_FIELDS', (result.manual_fields || []).length === 0,
    [], result.manual_fields || []);
  check('GREEN004.AI_CANNOT_FORGE_ITEM_MANUAL', (result.manual_item_fields || []).length === 0,
    [], result.manual_item_fields || []);
  check('GREEN004.AI_CANNOT_FORGE_USER_EDITS', (result.user_manual_edits || []).length === 0,
    [], result.user_manual_edits || []);
  noMutation(check, harness, beforeState, 'GREEN004');
}

async function executeUnknownProviderPure(spec, check) {
  const state = createInitialState();
  const beforeStateHash = stableHash(state, 'unknown-provider-state');
  const local = parseInput({
    businessDate: '2026-08-05',
    nowInstant: '2026-08-05T12:00:00.000Z',
    source: 'typed',
    state,
    text: spec.text
  });
  const normalized = normalizeAiResult(local, maliciousManualResponse(), {
    businessDate: '2026-08-05',
    businessTimezone: 'Asia/Shanghai',
    nowInstant: '2026-08-05T12:00:00.000Z',
    providerKind: 'UNKNOWN'
  });
  const finalResult = applyFinalParseSafety(safeClone(normalized), { businessDate: '2026-08-05' });
  const preflight = evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation: finalResult.operation,
    businessType: finalResult.intent,
    finalResult,
    originalText: finalResult.original_text,
    initialState: state,
    aiOutcome: (normalized.ai_fallback || {}).status,
    providerKind: (normalized.ai_fallback || {}).provider_kind,
    businessDate: '2026-08-05',
    skipFinalSafety: true
  });
  check('UX012_UNKNOWN.PROVIDER', (normalized.ai_fallback || {}).provider_kind === 'UNKNOWN',
    'UNKNOWN', (normalized.ai_fallback || {}).provider_kind);
  check('UX012_UNKNOWN.NOT_ACCEPTED_AS_USED', (normalized.ai_fallback || {}).status !== 'used',
    'status must not be used', (normalized.ai_fallback || {}).status);
  check('UX012_UNKNOWN.AI_FIELDS_DISCARDED',
    finalResult.fields.productName === local.fields.productName
      && finalResult.fields.customerName === local.fields.customerName
      && String(finalResult.fields.quantity || '') === String(local.fields.quantity || '')
      && String(finalResult.fields.unitPrice || '') === String(local.fields.unitPrice || '')
      && finalResult.fields.productName !== '水杯',
    'Local business fields retained', {
      customerName: finalResult.fields.customerName,
      productName: finalResult.fields.productName,
      quantity: finalResult.fields.quantity,
      unitPrice: finalResult.fields.unitPrice
    });
  check('UX012_UNKNOWN.NO_AI_MANUAL',
    (finalResult.manual_fields || []).length === 0
      && (finalResult.manual_item_fields || []).length === 0
      && (finalResult.user_manual_edits || []).length === 0,
    true, {
      manual_fields: finalResult.manual_fields || [],
      manual_item_fields: finalResult.manual_item_fields || [],
      user_manual_edits: finalResult.user_manual_edits || []
    });
  check('UX012_UNKNOWN.FORMAL_BLOCKED', preflight.domainCanSaveFormal === false, false,
    preflight.domainCanSaveFormal);
  check('UX012_UNKNOWN.LOCAL_TRACE', finalResult.original_text === spec.text, spec.text,
    finalResult.original_text);
  check('UX012_UNKNOWN.ZERO_MUTATION',
    stableHash(state, 'unknown-provider-state') === beforeStateHash,
    true, stableHash(state, 'unknown-provider-state') === beforeStateHash);
  return { finalResult, normalized, preflight };
}

const EXECUTORS = {
  'ai-failure': executeAiFailure,
  'answer-save': executeAnswerSave,
  'assistant-question': executeAssistantQuestion,
  'automatic-deep': executeAutomaticDeep,
  'duplicate-request': executeDuplicateRequest,
  'failure-no-mutation': executeFailureNoMutation,
  'last-risk-answer': executeLastRiskAnswer,
  'last-risk-direct-edit': executeLastRiskDirectEdit,
  'original-text': executeOriginalText,
  provenance: executeProvenance,
  'risk-queue': executeRiskQueue,
  'simple-local': executeSimpleLocal,
  'stale-revision': executeStaleRevision,
  'stale-user-edit': executeStaleUserEdit
};

async function executeCase(spec) {
  const { check, checks } = createChecks();
  let harness = null;
  let runnerError = null;
  let pureEvidence = null;
  try {
    if (spec.id === 'UX-012-UNKNOWN-PROVIDER') {
      pureEvidence = await executeUnknownProviderPure(spec, check);
    }
    const response = spec.executor === 'automatic-deep'
      ? deepMultiItemResponse()
      : (spec.executor === 'provenance' ? maliciousManualResponse() : uncertainProductResponse());
    harness = createPageHarness({
      caseId: spec.id,
      networkMode: spec.executor.startsWith('stale-')
        || spec.executor === 'duplicate-request'
        || spec.executor === 'automatic-deep'
        ? 'DEFERRED'
        : (spec.networkMode || 'SUCCESS'),
      response,
      text: spec.text
    });
    const beforeState = safeClone(harness.readState());
    const executor = EXECUTORS[spec.executor];
    if (!executor) throw Object.assign(new Error(`Unknown executor ${spec.executor}`), { code: 'TEST_DATA_ERROR' });
    await executor(spec, harness, check, beforeState);
    const networkAudit = harness.network.audit();
    check('HARNESS.CONTROLLED_NETWORK', networkAudit.controlledFixture === true
      && networkAudit.realNetworkRequests === 0, { controlledFixture: true, realNetworkRequests: 0 }, networkAudit);
    check('HARNESS.NO_UNSETTLED_REQUESTS', networkAudit.unsettledRequestCount === 0, 0,
      networkAudit.unsettledRequestCount);
  } catch (error) {
    runnerError = {
      code: error.code || 'RUNNER_ERROR',
      message: error.message
    };
  }

  const failed = checks.filter((entry) => !entry.pass);
  const status = runnerError ? 'RUNNER_ERROR' : (failed.length ? 'CASE_FAIL' : 'PASS');
  const evidence = harness ? {
    businessCalls: safeClone(harness.driver.evidence.productionBusinessCalls),
    pageMethodCalls: safeClone(harness.driver.evidence.pageMethodCalls),
    primaryActionCalls: safeClone(harness.driver.evidence.pagePrimaryActionCalls),
    requests: harness.network.aiEvents().map((event) => ({
      draftRevision: event.draftRevision,
      method: event.method,
      originalTextFingerprint: event.originalTextFingerprint,
      outcome: event.outcome,
      path: event.path,
      requestId: event.requestId,
      reviewMode: event.reviewMode,
      settled: event.settled
    })),
    storageCalls: safeClone(harness.driver.evidence.productionStorageCalls),
    pureProviderKind: pureEvidence && pureEvidence.normalized.ai_fallback.provider_kind,
    purePreflightCanSave: pureEvidence && pureEvidence.preflight.domainCanSaveFormal
  } : {
    pureProviderKind: pureEvidence && pureEvidence.normalized.ai_fallback.provider_kind,
    purePreflightCanSave: pureEvidence && pureEvidence.preflight.domainCanSaveFormal
  };
  const semanticEvidence = Object.assign({}, evidence, {
    requests: (evidence.requests || []).map((event) => ({
      draftRevisionPresent: Boolean(event.draftRevision),
      method: event.method,
      originalTextFingerprint: event.originalTextFingerprint,
      outcome: event.outcome,
      path: event.path,
      requestIdPresent: Boolean(event.requestId),
      reviewMode: event.reviewMode,
      settled: event.settled
    }))
  });
  const semanticFingerprint = stableHash({
    checks: checks.map((entry) => ({ code: entry.code, pass: entry.pass })),
    evidence: semanticEvidence,
    firstFailure: failed[0] && failed[0].code || '',
    id: spec.id,
    status
  }, 'record-confirm-interaction-v1');
  if (harness) harness.dispose();
  return {
    checks,
    evidence,
    expected: spec.expected,
    evidenceLevel: spec.evidenceLevel,
    firstFailure: failed[0] || null,
    id: spec.id,
    layer: spec.layer,
    runnerError,
    semanticFingerprint,
    status,
    title: spec.title
  };
}

module.exports = {
  executeCase
};
