#!/usr/bin/env node

const assert = require('assert');
const { prepareHybridLocalStage } = require('../../../utils/ai-parser');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const { runMultiItemOrderContract } = require('../multi-item-order-complete-save-v1/run-suite');
const aiFixtures = require('../fixtures/ai/ai-fixtures-v1.json');
const stateFixtures = require('../fixtures/states/state-fixtures-v1.json');
const { createFixtureResolver } = require('../runner/resolve-fixtures');
const { createPageHarness, diffCounts, stateCounts } = require('./runtime');
const {
  BUSINESS_DATE,
  NOW_INSTANT,
  TIMEZONE,
  deepMultiItemResponse
} = require('./fixtures');
const {
  answerQuestion,
  startOriginalText,
  tick,
  waitForParseIdle,
  waitUntil
} = require('./page-actions');

const MISSING_SECOND_PRICE = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个；8月15日交货。';
const MISSING_SECOND_QUANTITY = '王总下单：大号礼品盒100个，每个3元；小号礼品盒每个2元；8月15日交货。';
const MISSING_PRODUCT = '王总周三交500个5元';
const COMPLETE_MULTI_ITEM = '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。';
const MISSING_SECOND_BOTH = '王总下单：大号礼品盒100个，每个3元；小号礼品盒；8月15日交货。';
const AMBIGUOUS_ITEM_PRICE = '王总下单：大号礼品盒100个；小号礼品盒200个；其中一个每个2元；8月15日交货。';
const TRUSTED_HISTORY_PRICE = '王总保温杯再来300个，还是上次价格，8月15日交';
const fixtureResolver = createFixtureResolver(stateFixtures, aiFixtures);

function canonicalRoute(value) {
  const route = value && value.route ? value.route : (value || {});
  return String(route.client_route || route.semantic_decision || route.decision || '').toUpperCase();
}

function activeQuestion(value) {
  const route = value && value.route ? value.route : (value || {});
  return route.activeQuestion || route.questionCandidate || null;
}

function questionTarget(value) {
  const question = activeQuestion(value) || {};
  return question.target || {};
}

function prepare(text, state = createInitialState()) {
  return prepareHybridLocalStage({
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    context: 'home',
    nowInstant: NOW_INSTANT,
    rawText: text,
    reviewMode: 'standard',
    source: 'typed',
    state,
    text
  });
}

function allZero(value = {}) {
  return Object.values(value).every((entry) => Number(entry || 0) === 0);
}

function getPageQuestion(page) {
  return safeClone(page.data.activeQuestion || page.data.assistantQuestion || null);
}

function controlledResponse(overrides = {}) {
  return Object.assign({}, deepMultiItemResponse(), overrides);
}

async function waitForInitialRoute(harness) {
  await waitUntil(() => (
    harness.network.aiEvents().length > 0
    || harness.page.data.parsing !== true
  ), 'initial canonical route');
  await tick();
}

async function pageProbe(text, options = {}) {
  const harness = createPageHarness({
    caseId: options.caseId || 'CLIENT-FACT-PROBE',
    initialState: options.initialState,
    networkMode: 'DEFERRED',
    text
  });
  const beforeState = safeClone(harness.readState());
  const beforeHash = stableHash(beforeState, 'client-fact-state');
  try {
    await startOriginalText(harness.page, text);
    await waitForInitialRoute(harness);
    const requestsBeforeRelease = harness.network.aiEvents().map((event) => safeClone(event));
    harness.network.aiEvents().forEach((event) => {
      if (!event.settled) {
        harness.network.releaseAt(event.index, {
          response: options.response || controlledResponse()
        });
      }
    });
    await waitForParseIdle(harness.page);
    const afterState = safeClone(harness.readState());
    return {
      businessCalls: safeClone(harness.driver.evidence.productionBusinessCalls),
      deltas: diffCounts(stateCounts(beforeState), stateCounts(afterState)),
      fields: safeClone(((harness.page.data.parseResult || {}).fields) || {}),
      fullStateUnchanged: beforeHash === stableHash(afterState, 'client-fact-state'),
      pageMethodCalls: safeClone(harness.driver.evidence.pageMethodCalls),
      parseResult: safeClone(harness.page.data.parseResult || {}),
      question: getPageQuestion(harness.page),
      requests: requestsBeforeRelease,
      storageCalls: safeClone(harness.driver.evidence.productionStorageCalls)
    };
  } finally {
    harness.dispose();
  }
}

function assertZeroMutation(probe, label) {
  assert.strictEqual(probe.fullStateUnchanged, true, `${label}: business state must remain unchanged`);
  assert.strictEqual(allZero(probe.deltas), true, `${label}: state deltas must remain zero`);
  assert.strictEqual(Number(probe.businessCalls.saveConfirmedDraft || 0), 0, `${label}: formal business save must be zero`);
  assert.strictEqual(Number(probe.businessCalls.savePendingNote || 0), 0, `${label}: pending business save must be zero`);
  assert.strictEqual(Number(probe.storageCalls.saveState || 0), 0, `${label}: storage mutation must be zero`);
}

function assertAskTarget(prepared, fieldPath, label) {
  assert.strictEqual(canonicalRoute(prepared), 'ASK_USER', `${label}: canonical route must ASK_USER`);
  assert.strictEqual(questionTarget(prepared).fieldPath, fieldPath, `${label}: question target must be exact`);
}

async function clientFact001() {
  const prepared = prepare(MISSING_SECOND_PRICE);
  const items = prepared.localResult.fields.items || [];
  assertAskTarget(prepared, 'items[1].unitPrice', 'CLIENT-FACT-001');
  assert.strictEqual(items.length, 2, 'CLIENT-FACT-001: second item must be retained');
  assert.strictEqual(items[1].productName, '礼品盒');
  assert.strictEqual(items[1].spec, '小号');
  assert.strictEqual(String(items[1].unitPrice || ''), '', 'CLIENT-FACT-001: unitPrice must not be invented');
  const probe = await pageProbe(MISSING_SECOND_PRICE, { caseId: 'CLIENT-FACT-001' });
  assert.strictEqual(probe.requests.length, 0, 'CLIENT-FACT-001: AI request count must be zero');
  assert.strictEqual(canonicalRoute(probe.parseResult.parse_route), 'ASK_USER');
  const pageTarget = (probe.question || {}).target || {};
  const pageItems = probe.fields.items || [];
  assert.strictEqual(pageTarget.field, 'unitPrice');
  assert.strictEqual(pageTarget.fieldPath, 'items[1].unitPrice');
  assert.strictEqual(pageTarget.itemIndex, 1);
  assert(pageTarget.itemKey, 'CLIENT-FACT-001: page question must bind a stable itemKey');
  assert.strictEqual(pageTarget.itemKey, (pageItems[1] || {}).confirmationItemKey);
  assertZeroMutation(probe, 'CLIENT-FACT-001');
  return { route: canonicalRoute(prepared), target: questionTarget(prepared), requests: probe.requests.length };
}

async function clientFact002() {
  const prepared = prepare(MISSING_SECOND_QUANTITY);
  const items = prepared.localResult.fields.items || [];
  assertAskTarget(prepared, 'items[1].quantity', 'CLIENT-FACT-002');
  assert.strictEqual(items.length, 2, 'CLIENT-FACT-002: second item must be retained');
  assert.strictEqual(items[1].productName, '礼品盒');
  assert.strictEqual(items[1].spec, '小号');
  assert.strictEqual(String(items[1].quantity || ''), '', 'CLIENT-FACT-002: quantity must not be invented');
  const probe = await pageProbe(MISSING_SECOND_QUANTITY, { caseId: 'CLIENT-FACT-002' });
  assert.strictEqual(probe.requests.length, 0, 'CLIENT-FACT-002: AI request count must be zero');
  const pageTarget = (probe.question || {}).target || {};
  const pageItems = probe.fields.items || [];
  assert.strictEqual(pageTarget.field, 'quantity');
  assert.strictEqual(pageTarget.fieldPath, 'items[1].quantity');
  assert.strictEqual(pageTarget.itemIndex, 1);
  assert(pageTarget.itemKey, 'CLIENT-FACT-002: page question must bind a stable itemKey');
  assert.strictEqual(pageTarget.itemKey, (pageItems[1] || {}).confirmationItemKey);
  assertZeroMutation(probe, 'CLIENT-FACT-002');
  return { route: canonicalRoute(prepared), target: questionTarget(prepared), requests: probe.requests.length };
}

async function clientFact003() {
  const prepared = prepare(MISSING_PRODUCT);
  assertAskTarget(prepared, 'items[0].productName', 'CLIENT-FACT-003');
  const probe = await pageProbe(MISSING_PRODUCT, { caseId: 'CLIENT-FACT-003' });
  assert.strictEqual(probe.requests.length, 0, 'CLIENT-FACT-003: missing product must not call AI');
  assert.strictEqual(((probe.question || {}).target || {}).fieldPath, 'items[0].productName');
  assertZeroMutation(probe, 'CLIENT-FACT-003');
  return { route: canonicalRoute(prepared), target: questionTarget(prepared), requests: probe.requests.length };
}

async function clientFact004() {
  const prepared = prepare(COMPLETE_MULTI_ITEM);
  assert.strictEqual(canonicalRoute(prepared), 'AUTO_DEEP', 'CLIENT-FACT-004: complete multi-item must AUTO_DEEP');
  const probe = await pageProbe(COMPLETE_MULTI_ITEM, { caseId: 'CLIENT-FACT-004' });
  const deep = probe.requests.filter((event) => event.path === '/api/ai/parse/deep');
  assert.strictEqual(probe.requests.length, 1, 'CLIENT-FACT-004: total AI requests must equal one');
  assert.strictEqual(deep.length, 1, 'CLIENT-FACT-004: automatic Deep requests must equal one');
  assert.strictEqual(Number(probe.pageMethodCalls.requestDeepReview || 0), 0, 'CLIENT-FACT-004: manual Deep must remain zero');
  assertZeroMutation(probe, 'CLIENT-FACT-004');
  return { route: canonicalRoute(prepared), automaticDeep: deep.length, manualDeep: probe.pageMethodCalls.requestDeepReview || 0 };
}

async function clientFact005() {
  const initialState = fixtureResolver.resolveInitialState({
    fixtureRef: 'state-valid-quotation-v1'
  }).state;
  const before = stableHash(initialState, 'client-fact-005-state');
  const prepared = prepare(TRUSTED_HISTORY_PRICE, initialState);
  const fields = prepared.localResult.fields || {};
  const sources = prepared.localResult.field_sources || {};
  assert.strictEqual(canonicalRoute(prepared), 'AUTO_DEEP', 'CLIENT-FACT-005: trusted quotation history may support AUTO_DEEP');
  assert.strictEqual(prepared.localResult.history_status, 'found');
  assert((prepared.localResult.history_defaulted_fields || []).includes('unitPrice'), 'CLIENT-FACT-005: unitPrice must be supplied by frozen history');
  assert.strictEqual(String(fields.unitPrice || ''), '18');
  assert.strictEqual(sources.unitPrice, 'history:quotation:quo-syn-a-1:unitPrice');
  assert.strictEqual(String(fields.quotationId || ''), '', 'CLIENT-FACT-005: route preparation cannot invent quotationId');
  assert.strictEqual(String(fields.orderId || ''), '', 'CLIENT-FACT-005: route preparation cannot invent orderId');
  assert.strictEqual(stableHash(initialState, 'client-fact-005-state'), before, 'CLIENT-FACT-005: history lookup must not mutate state');
  return {
    historyDefaultedFields: safeClone(prepared.localResult.history_defaulted_fields || []),
    route: canonicalRoute(prepared),
    unitPriceSource: sources.unitPrice
  };
}

async function clientFact006() {
  const probe = await pageProbe(MISSING_SECOND_PRICE, {
    caseId: 'CLIENT-FACT-006',
    response: controlledResponse({
      fields: {
        customerName: '王总',
        dueDate: '2026-08-15',
        items: [
          { productName: '礼品盒', spec: '大号', quantity: '100', unit: '个', unitPrice: '3', priceUnit: '个' },
          { productName: '礼品盒', spec: '小号', quantity: '200', unit: '个', unitPrice: '2', priceUnit: '个' }
        ],
        orderId: 'AI_FORGED_ORDER_ID',
        quotationId: 'AI_FORGED_QUOTATION_ID'
      },
      field_evidence: { unitPrice: ['AI_SELF_PROOF_2元'] },
      field_sources: { unitPrice: 'USER_ASSISTANT_ANSWER' },
      manual_fields: ['unitPrice'],
      manual_item_fields: [{ field: 'unitPrice', itemIndex: 1 }],
      user_manual_edits: [{ field: 'unitPrice', source: 'USER_ASSISTANT_ANSWER', value: '2' }]
    })
  });
  assert.strictEqual(probe.requests.length, 0, 'CLIENT-FACT-006: controlled AI fixture must not be consumed');
  const items = probe.fields.items || [];
  assert.strictEqual(String((items[1] || {}).unitPrice || ''), '', 'CLIENT-FACT-006: AI cannot prove its own route eligibility');
  assertZeroMutation(probe, 'CLIENT-FACT-006');
  return { requests: probe.requests.length, secondUnitPrice: String((items[1] || {}).unitPrice || '') };
}

async function clientFact007() {
  const harness = createPageHarness({
    caseId: 'CLIENT-FACT-007',
    networkMode: 'DEFERRED',
    text: MISSING_SECOND_BOTH
  });
  const beforeState = safeClone(harness.readState());
  try {
    await startOriginalText(harness.page, MISSING_SECOND_BOTH);
    await waitForInitialRoute(harness);
    assert.strictEqual(harness.network.aiEvents().length, 0, 'CLIENT-FACT-007: first missing fact must not call AI');
    const first = getPageQuestion(harness.page);
    const firstTarget = first && first.target || {};
    assert(first, 'CLIENT-FACT-007: exactly one active question is required');
    assert(['quantity', 'unitPrice'].includes(firstTarget.field), 'CLIENT-FACT-007: first target must be one missing field');
    assert.strictEqual(firstTarget.fieldPath, `items[1].${firstTarget.field}`);
    assert(firstTarget.itemKey, 'CLIENT-FACT-007: first question must bind an itemKey');
    await answerQuestion(harness.page, firstTarget.field === 'quantity' ? '200' : '2');
    await waitForParseIdle(harness.page);
    assert.strictEqual(harness.network.aiEvents().length, 0, 'CLIENT-FACT-007: after first answer the second fact must still be asked locally');
    const second = getPageQuestion(harness.page);
    const secondTarget = second && second.target || {};
    assert(second, 'CLIENT-FACT-007: second active question is required after first answer');
    assert(['quantity', 'unitPrice'].includes(secondTarget.field), 'CLIENT-FACT-007: second target must be the other missing field');
    assert.strictEqual(
      new Set([firstTarget.field, secondTarget.field]).size,
      2,
      'CLIENT-FACT-007: questions must advance one field at a time'
    );
    assert.strictEqual(secondTarget.fieldPath, `items[1].${secondTarget.field}`);
    assert.strictEqual(secondTarget.itemKey, firstTarget.itemKey, 'CLIENT-FACT-007: both questions must bind the same item');
    const pageItems = (((harness.page.data.parseResult || {}).fields || {}).items) || [];
    assert.strictEqual(pageItems.length, 2, 'CLIENT-FACT-007: answering must not delete either item');
    assert.strictEqual(firstTarget.itemKey, (pageItems[1] || {}).confirmationItemKey);
    assert.strictEqual(
      stableHash(harness.readState(), 'client-fact-007-state'),
      stableHash(beforeState, 'client-fact-007-state'),
      'CLIENT-FACT-007: answering confirmation questions must not save business data'
    );
    assert.strictEqual(Number(harness.driver.evidence.productionBusinessCalls.saveConfirmedDraft || 0), 0);
    assert.strictEqual(Number(harness.driver.evidence.productionBusinessCalls.savePendingNote || 0), 0);
    assert.strictEqual(Number(harness.driver.evidence.productionStorageCalls.saveState || 0), 0);
    return { first: firstTarget.fieldPath, second: secondTarget.fieldPath, requests: harness.network.aiEvents().length };
  } finally {
    harness.dispose();
  }
}

async function clientFact008() {
  const prepared = prepare(AMBIGUOUS_ITEM_PRICE);
  assert.strictEqual(canonicalRoute(prepared), 'SAFE_BLOCKED', 'CLIENT-FACT-008: ambiguous item ownership must SAFE_BLOCKED');
  assert.strictEqual(activeQuestion(prepared), null, 'CLIENT-FACT-008: must not ask against a guessed item');
  const probe = await pageProbe(AMBIGUOUS_ITEM_PRICE, { caseId: 'CLIENT-FACT-008' });
  assert.strictEqual(probe.requests.length, 0, 'CLIENT-FACT-008: ambiguous item ownership must not call AI');
  assert.strictEqual(probe.question, null, 'CLIENT-FACT-008: no guessed item question may be shown');
  assertZeroMutation(probe, 'CLIENT-FACT-008');
  return { route: canonicalRoute(prepared), requests: probe.requests.length };
}

async function clientFact009() {
  const result = runMultiItemOrderContract({
    caseId: 'REC-E2E-MIO-GREEN-002',
    repeat: 1
  });
  const caseResult = result.attempts[0].results[0];
  assert.strictEqual(caseResult.caseStatus, 'PASS', 'CLIENT-FACT-009: GREEN-002 business optional-field contract must remain PASS');
  assert.strictEqual(caseResult.evidence.saveType, 'order');
  assert.strictEqual(String((caseResult.evidence.secondItem || {}).unitPrice || ''), '');
  return { green002: caseResult.caseStatus, saveType: caseResult.evidence.saveType };
}

const CASES = [
  ['CLIENT-FACT-001', clientFact001],
  ['CLIENT-FACT-002', clientFact002],
  ['CLIENT-FACT-003', clientFact003],
  ['CLIENT-FACT-004', clientFact004],
  ['CLIENT-FACT-005', clientFact005],
  ['CLIENT-FACT-006', clientFact006],
  ['CLIENT-FACT-007', clientFact007],
  ['CLIENT-FACT-008', clientFact008],
  ['CLIENT-FACT-009', clientFact009]
];

async function runRound(round) {
  const results = [];
  for (const [id, execute] of CASES) {
    try {
      const evidence = await execute();
      const status = evidence && evidence.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'PASS';
      results.push({ evidence, id, status });
      console.log(`${status} ${id}`);
    } catch (error) {
      const isAssertion = error && (error.name === 'AssertionError' || error.code === 'ERR_ASSERTION');
      results.push({
        error: { code: error.code || 'ASSERTION_ERROR', message: error.message },
        id,
        status: isAssertion ? 'CASE_FAIL' : 'RUNNER_ERROR'
      });
      console.log(`${isAssertion ? 'CASE_FAIL' : 'RUNNER_ERROR'} ${id}: ${error.message}`);
    }
  }
  return { results, round };
}

function semanticFingerprint(round) {
  return JSON.stringify(round.results.map((result) => ({
    error: result.error || null,
    evidence: result.evidence || null,
    id: result.id,
    status: result.status
  })));
}

async function main() {
  const rounds = [await runRound(1), await runRound(2)];
  const stable = semanticFingerprint(rounds[0]) === semanticFingerprint(rounds[1]);
  const summary = rounds[1].results.reduce((output, result) => {
    output[result.status] = Number(output[result.status] || 0) + 1;
    return output;
  }, { PASS: 0, CASE_FAIL: 0, NOT_APPLICABLE: 0, RUNNER_ERROR: 0 });
  console.log(`CLIENT_FACT_GATE=${summary.CASE_FAIL === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`ROUNDS=${rounds.length}`);
  console.log(`DETERMINISM=${stable ? 'STABLE' : 'DRIFT'}`);
  console.log(`PASS=${summary.PASS} CASE_FAIL=${summary.CASE_FAIL} NOT_APPLICABLE=${summary.NOT_APPLICABLE} RUNNER_ERROR=${summary.RUNNER_ERROR}`);
  if (!stable || summary.CASE_FAIL > 0 || summary.RUNNER_ERROR > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  CASES,
  main,
  prepare
};
