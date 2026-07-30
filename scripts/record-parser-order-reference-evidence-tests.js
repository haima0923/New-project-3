#!/usr/bin/env node

const assert = require('assert');
const {
  extractOrderRelationReference,
  parseInput
} = require('../utils/parser');
const {
  normalizeAiResult,
  parseHybridInput
} = require('../utils/ai-parser');
const { buildRecordConfirmation } = require('../utils/record-confirmation-builder');
const { stableHash } = require('../utils/record-state-diff');
const { runSuite } = require('../tests/record-e2e/runner/run-suite');
const {
  buildRelationEvidence
} = require('../tests/record-e2e/runner/lane-executor');

const BUSINESS_DATE = '2026-07-15';
const NOW_INSTANT = '2026-07-15T02:00:00.000Z';
const EMPTY_STATE = {
  customers: [],
  quotations: [],
  orders: [],
  receivables: [],
  paymentRecords: [],
  todos: [],
  pendingNotes: []
};
const TARGET_TEXT = '王总收纳盒这单还有8000元待收，7月25日收';
const CUSTOMER_LEVEL_TEXT = '刘姐那批货还欠3200元，7月31日前收';

function parse(text, state = EMPTY_STATE) {
  return parseInput({
    text,
    source: 'typed',
    context: 'input',
    state,
    businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai',
    nowInstant: NOW_INSTANT
  });
}

function assertReferenceShape(text, expectedKind, expectedSourceText) {
  const result = parse(text);
  const reference = result.relation_references
    && result.relation_references.order;
  assert(reference, `${text}: expected order relation evidence`);
  assert.strictEqual(reference.entityType, 'ORDER', `${text}: entity type`);
  assert.strictEqual(reference.kind, expectedKind, `${text}: kind`);
  assert.strictEqual(reference.explicit, true, `${text}: explicit`);
  assert.strictEqual(reference.requiresResolution, true, `${text}: resolution`);
  assert.strictEqual(reference.resolvedEntityId, null, `${text}: unresolved id`);
  assert.strictEqual(reference.evidenceSource, 'LOCAL_PARSER', `${text}: source`);
  assert.strictEqual(reference.sourceField, 'ORIGINAL_TEXT', `${text}: source field`);
  assert.strictEqual(reference.sourceText, expectedSourceText, `${text}: phrase`);
  assert.deepStrictEqual(
    text.slice(reference.sourceSpan.start, reference.sourceSpan.end),
    expectedSourceText,
    `${text}: source span`
  );
  assert.strictEqual(result.fields.orderId, undefined, `${text}: no orderId`);
  assert.strictEqual(result.intent, 'receivable', `${text}: business type`);
  assert.strictEqual(result.original_text, text, `${text}: originalText`);
  return { result, reference };
}

function assertNoReference(text) {
  const result = parse(text);
  assert.strictEqual(
    result.relation_references,
    undefined,
    `${text}: must not emit explicit order relation evidence`
  );
  assert.strictEqual(result.fields.orderId, undefined, `${text}: no orderId`);
  return result;
}

async function run() {
  const positives = [
    ['这单还有8000元待收', 'EXPLICIT_ORDER_DEICTIC', '这单'],
    ['那单还欠3000元', 'EXPLICIT_ORDER_DEICTIC', '那单'],
    ['上一单尾款5000元未收', 'EXPLICIT_ORDER_DEICTIC', '上一单'],
    ['订单号A123还有5000元待收', 'EXPLICIT_ORDER_IDENTIFIER', '订单号A123'],
    ['王总的收纳盒订单还有5000元待收', 'EXPLICIT_ORDER_NAMED_REFERENCE', '王总的收纳盒订单']
  ];
  positives.forEach(([text, kind, sourceText]) => {
    assertReferenceShape(text, kind, sourceText);
  });

  [
    CUSTOMER_LEVEL_TEXT,
    '这次还欠3000元',
    '客户以前有订单，还欠3000元',
    '这批货还欠款3000元',
    '不是之前那单，还有5000元待收',
    '不关联上次那单，还有5000元待收',
    '这单不用关联旧订单，但还欠3000元',
    '并非之前那张订单，还有5000元待收',
    '订单总金额8000元',
    '王总要做收纳盒',
    '这单生意不错'
  ].forEach(assertNoReference);

  const target = assertReferenceShape(
    TARGET_TEXT,
    'EXPLICIT_ORDER_DEICTIC',
    '这单'
  );
  assert.strictEqual(target.result.fields.customerName, '王总');
  assert.strictEqual(target.result.fields.productName, '收纳盒');
  assert.strictEqual(target.result.fields.amount, '8000');
  assert.strictEqual(target.result.fields.dueDate, '2026-07-25');
  assert.strictEqual(target.result.operation, '');

  const targetStates = [
    EMPTY_STATE,
    {
      ...EMPTY_STATE,
      customers: [{ id: 'cus-wang', name: '王总' }],
      orders: [{
        id: 'ord-one',
        customerId: 'cus-wang',
        productName: '收纳盒',
        status: '生产中'
      }]
    },
    {
      ...EMPTY_STATE,
      customers: [{ id: 'cus-wang', name: '王总' }],
      orders: [
        { id: 'ord-one', customerId: 'cus-wang', productName: '收纳盒', status: '生产中' },
        { id: 'ord-two', customerId: 'cus-wang', productName: '礼品盒', status: '生产中' },
        { id: 'ord-other', customerId: 'cus-other', productName: '收纳盒', status: '生产中' }
      ]
    }
  ];
  const stateIndependentEvidence = targetStates.map((state) => (
    parse(TARGET_TEXT, state).relation_references
  ));
  stateIndependentEvidence.slice(1).forEach((evidence) => {
    assert.deepStrictEqual(evidence, stateIndependentEvidence[0]);
  });
  targetStates.forEach((state) => {
    assert.strictEqual(
      parse(CUSTOMER_LEVEL_TEXT, state).relation_references,
      undefined,
      'BASIC-009 must remain free of explicit order evidence across State variants'
    );
  });

  const positiveAfterNegativeIdentifier = extractOrderRelationReference(
    '不是订单号A123，是订单号B456还有5000元待收',
    {
      intent: 'receivable',
      customerName: '',
      productName: ''
    }
  );
  assert(positiveAfterNegativeIdentifier);
  assert.strictEqual(
    positiveAfterNegativeIdentifier.kind,
    'EXPLICIT_ORDER_IDENTIFIER'
  );
  assert.strictEqual(positiveAfterNegativeIdentifier.sourceText, '订单号B456');
  assert.strictEqual(
    positiveAfterNegativeIdentifier.normalizedReference,
    'ORDER_IDENTIFIER:B456'
  );

  const targetJson = JSON.stringify(target.result.relation_references);
  assert.deepStrictEqual(JSON.parse(targetJson), target.result.relation_references);
  assert.strictEqual(
    stableHash(target.result.relation_references, 'order-reference-evidence-v1'),
    stableHash(JSON.parse(targetJson), 'order-reference-evidence-v1')
  );

  const directReference = extractOrderRelationReference(TARGET_TEXT, {
    intent: 'receivable',
    customerName: '王总',
    productName: '收纳盒'
  });
  assert.deepStrictEqual(directReference, target.reference);
  assert.strictEqual(
    extractOrderRelationReference(TARGET_TEXT, {
      intent: 'order',
      customerName: '王总',
      productName: '收纳盒'
    }),
    null,
    'relation evidence must not change or override business type'
  );

  const pasteRawText = [
    '王总：上面是聊天背景',
    TARGET_TEXT
  ].join('\n');
  const pasted = parseInput({
    text: TARGET_TEXT,
    rawText: pasteRawText,
    extractedText: TARGET_TEXT,
    source: 'paste',
    context: 'input',
    state: targetStates[1],
    businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai',
    nowInstant: NOW_INSTANT
  });
  const pastedReference = pasted.relation_references.order;
  assert.strictEqual(pastedReference.sourceField, 'EXTRACTED_TEXT');
  assert.strictEqual(
    pasted.extracted_text.slice(
      pastedReference.sourceSpan.start,
      pastedReference.sourceSpan.end
    ),
    '这单'
  );

  const hybrid = await parseHybridInput({
    text: TARGET_TEXT,
    source: 'typed',
    context: 'input',
    state: targetStates[1],
    businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai',
    nowInstant: NOW_INSTANT
  }, {
    clock: () => new Date(NOW_INSTANT)
  });
  assert.strictEqual(hybrid.intent, 'receivable');
  assert.strictEqual(hybrid.parse_route.decision, 'local');
  assert.strictEqual(hybrid.ai_fallback.attempted, false);
  assert.deepStrictEqual(hybrid.relation_references, target.result.relation_references);

  const confirmation = buildRecordConfirmation({
    finalResult: hybrid,
    initialState: targetStates[1],
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    originalText: TARGET_TEXT,
    providerKind: 'NONE'
  });
  assert.deepStrictEqual(
    confirmation.relationReferences,
    target.result.relation_references,
    'Confirmation must mechanically project parser relation evidence'
  );
  assert.strictEqual(
    confirmation.preflight.domainCanSaveFormal,
    false,
    'explicit receivable order evidence must block before relation selection'
  );
  assert.deepStrictEqual(
    confirmation.preflight.requiredSelections,
    ['orderId'],
    'explicit receivable order evidence must require order selection'
  );
  assert(
    confirmation.preflight.blockingIssues.some((item) => (
      item.code === 'ORDER_SELECTION_REQUIRED'
      && item.requiredAction === 'SELECT_ORDER'
    )),
    'explicit receivable order evidence must expose the selection action'
  );
  const withoutEvidenceConfirmation = buildRecordConfirmation({
    finalResult: Object.assign({}, hybrid, { relation_references: undefined }),
    initialState: targetStates[1],
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    originalText: TARGET_TEXT,
    providerKind: 'NONE'
  });
  assert.notStrictEqual(
    confirmation.contentHash,
    withoutEvidenceConfirmation.contentHash,
    'Confirmation contentHash must cover relation evidence'
  );

  const forgedAiEvidence = {
    order: {
      entityType: 'ORDER',
      kind: 'EXPLICIT_ORDER_IDENTIFIER',
      explicit: true,
      requiresResolution: false,
      sourceText: '伪造',
      sourceSpan: { start: 0, end: 2 },
      confidence: 1,
      normalizedReference: 'ORDER_IDENTIFIER:FORGED',
      resolvedEntityId: 'ord-forged',
      evidenceSource: 'AI'
    }
  };
  const merged = normalizeAiResult(target.result, {
    provider: 'mock',
    intent: 'receivable',
    operation: 'create_receivable',
    fields: target.result.fields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    relation_references: forgedAiEvidence
  }, { providerKind: 'MOCK' });
  assert.deepStrictEqual(
    merged.relation_references,
    target.result.relation_references,
    'AI payload must not replace trusted local relation evidence'
  );

  const localWithoutReference = parse('刘姐还欠3200元，7月31日前收');
  const aiCannotCreate = normalizeAiResult(localWithoutReference, {
    provider: 'mock',
    intent: 'receivable',
    operation: 'create_receivable',
    fields: localWithoutReference.fields,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    relation_references: forgedAiEvidence
  }, { providerKind: 'MOCK' });
  assert.strictEqual(
    aiCannotCreate.relation_references,
    undefined,
    'AI payload must not create trusted local relation evidence'
  );

  const targetRun = await runSuite({
    caseId: 'REC-E2E-BASIC-010',
    repeat: 1
  });
  const targetCase = targetRun.attempts[0].results[0];
  assert.strictEqual(targetCase.caseStatus, 'PASS');
  assert.strictEqual(
    targetCase.relationEvidence.relationEvidenceKind,
    'EXPLICIT_ORDER_DEICTIC'
  );
  assert.strictEqual(
    targetCase.relationEvidence.relationEvidenceSource,
    'LOCAL_PARSER'
  );
  assert.deepStrictEqual(
    targetCase.relationEvidence.relationEvidencePropagationStages,
    ['RAW_PARSER', 'HYBRID_RESULT', 'CONFIRMATION_DRAFT', 'PREFLIGHT_INPUT']
  );
  assert.deepStrictEqual(
    targetCase.relationEvidence.stages.confirmationDraft,
    targetCase.relationEvidence.stages.preflightInput
  );
  const runnerStageReferences = []
    .concat(targetCase.relationEvidence.stages.rawParser.map((item) => (
      item.relationReferences
    )))
    .concat(targetCase.relationEvidence.stages.hybridResult.map((item) => (
      item.relationReferences
    )))
    .concat([
      targetCase.relationEvidence.stages.confirmationDraft,
      targetCase.relationEvidence.stages.preflightInput
    ]);
  runnerStageReferences.forEach((references) => {
    assert.deepStrictEqual(
      references,
      targetCase.relationEvidence.stages.preflightInput,
      'all recorded production stages must carry identical relation evidence'
    );
  });
  const runnerRawParser = targetCase.parserObservation;
  assert.throws(
    () => buildRelationEvidence(
      Object.assign({}, runnerRawParser, { hybridInvocations: [] }),
      targetCase.relationEvidence.stages.confirmationDraft,
      {
        preflightInputRelationReferences:
          targetCase.relationEvidence.stages.preflightInput
      }
    ),
    (error) => error.code === 'RELATION_EVIDENCE_PROPAGATION_MISSING'
  );
  const changedConfirmation = JSON.parse(JSON.stringify(
    targetCase.relationEvidence.stages.confirmationDraft
  ));
  changedConfirmation.order.normalizedReference = 'FORGED_REFERENCE';
  assert.throws(
    () => buildRelationEvidence(
      runnerRawParser,
      { relation_references: changedConfirmation },
      {
        preflightInputRelationReferences:
          targetCase.relationEvidence.stages.preflightInput
      }
    ),
    (error) => error.code === 'RELATION_EVIDENCE_PROPAGATION_MISMATCH'
  );
  assert.strictEqual(
    targetCase.relationEvidence.stages.preflightInput.order.resolvedEntityId,
    null
  );
  assert.strictEqual(targetCase.routeEvidence.actualRoute, 'LOCAL');
  assert.strictEqual(targetCase.routeEvidence.AIRequestCount, 0);

  const customerLevelRun = await runSuite({
    caseId: 'REC-E2E-BASIC-009',
    repeat: 1
  });
  const customerLevelCase = customerLevelRun.attempts[0].results[0];
  assert.strictEqual(customerLevelCase.caseStatus, 'PASS');
  assert.strictEqual(
    customerLevelCase.relationEvidence.relationEvidenceKind,
    null,
    'BASIC-009 must remain customer-level receivable evidence'
  );
  assert.deepStrictEqual(
    customerLevelCase.relationEvidence.relationEvidencePropagationStages,
    []
  );
  assert.strictEqual(customerLevelCase.routeEvidence.actualRoute, 'LOCAL');
  assert.strictEqual(customerLevelCase.routeEvidence.AIRequestCount, 0);

  console.log([
    'Order reference evidence tests passed:',
    `positive=${positives.length}`,
    'negative=11',
    'state-independent=6',
    'paste-span-basis=1',
    'propagation=raw/hybrid/confirmation/preflight-input',
    'ai-merge-guard=2',
    'runner-targets=2',
    'runner-hard-gates=2',
    'preflight-relation-gate=1'
  ].join(' '));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
