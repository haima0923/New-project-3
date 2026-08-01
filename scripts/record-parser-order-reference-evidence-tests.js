#!/usr/bin/env node

const assert = require('assert');
const {
  extractOrderRelationReference,
  extractQuotationRelationReference,
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

  const conversionPositives = [
    ['把王总那个保温杯报价再转成订单', '王总', '保温杯'],
    ['将李姐那份礼品盒报价转为订单', '李姐', '礼品盒'],
    ['请把陈老板那个报价转换成订单', '陈老板', ''],
    ['这个报价转成订单', '', ''],
    ['那张报价转为订单', '', ''],
    ['王总保温杯报价转订单', '王总', '保温杯'],
    ['报价单再转成订单', '', '']
  ];
  conversionPositives.forEach(([text, customerName, productName]) => {
    const result = parse(text);
    const signals = result.intent_evidence.quotationToOrderConversionSignals;
    assert.strictEqual(result.intent, 'order', `${text}: order intent`);
    assert.strictEqual(result.operation, '', `${text}: no new operation enum`);
    assert.strictEqual(signals.length, 1, `${text}: one conversion signal`);
    assert.strictEqual(signals[0].direction, 'QUOTATION_TO_ORDER');
    assert.strictEqual(signals[0].explicit, true);
    assert.strictEqual(signals[0].evidenceSource, 'LOCAL_PARSER');
    assert.strictEqual(signals[0].sourceField, 'ORIGINAL_TEXT');
    assert.strictEqual(
      text.slice(signals[0].sourceSpan.start, signals[0].sourceSpan.end),
      signals[0].sourceText,
      `${text}: conversion sourceSpan`
    );
    assert.strictEqual(result.fields.customerName, customerName, `${text}: customer`);
    assert.strictEqual(result.fields.productName, productName, `${text}: product`);
    assert.strictEqual(result.fields.quotationId, undefined, `${text}: no quotationId`);
    assert.strictEqual(
      result.intent_evidence.winningReason,
      'EXPLICIT_QUOTATION_TO_ORDER_CONVERSION'
    );
  });

  const conversionNegatives = [
    '这个报价已经转成订单了',
    '这个报价转成订单了吗',
    '这个报价是不是转成订单了',
    '不要把这个报价转成订单',
    '这个报价不能转成订单',
    '这个报价还没转成订单',
    '报价转订单失败了',
    '把订单转成报价',
    '订单转为报价'
  ];
  conversionNegatives.forEach((text) => {
    const result = parse(text);
    assert.notStrictEqual(result.intent, 'order', `${text}: no create-order intent`);
    assert.deepStrictEqual(
      result.intent_evidence.quotationToOrderConversionSignals || [],
      [],
      `${text}: no conversion evidence`
    );
    assert.strictEqual(result.fields.quotationId, undefined, `${text}: no quotationId`);
  });

  const ordinaryQuotation = parse('给王总报价保温杯300个18元');
  assert.strictEqual(ordinaryQuotation.intent, 'quotation');
  assert.deepStrictEqual(
    ordinaryQuotation.intent_evidence.quotationToOrderConversionSignals || [],
    []
  );
  const ordinaryOrder = parse('王总下单保温杯300个18元');
  assert.strictEqual(ordinaryOrder.intent, 'order');
  assert.deepStrictEqual(
    ordinaryOrder.intent_evidence.quotationToOrderConversionSignals || [],
    []
  );
  [
    '王总保温杯报价300个',
    '看看王总那个保温杯报价',
    '修改王总那个报价',
    '提醒我跟进王总那个报价'
  ].forEach((text) => {
    const result = parse(text);
    assert.notStrictEqual(result.intent, 'order', `${text}: reference is not conversion`);
    assert.deepStrictEqual(
      result.intent_evidence.quotationToOrderConversionSignals || [],
      []
    );
  });

  const conversionTarget = parse('把王总那个保温杯报价再转成订单');
  const conversionSignal = conversionTarget.intent_evidence
    .quotationToOrderConversionSignals[0];
  assert.strictEqual(conversionTarget.fields.customerName, '王总');
  assert.strictEqual(conversionTarget.fields.productName, '保温杯');
  assert.deepStrictEqual(conversionSignal.sourceSpan, { start: 8, end: 15 });
  assert.strictEqual(conversionSignal.sourceText, '报价再转成订单');
  const quotationReference = conversionTarget.relation_references.quotation;
  assert.strictEqual(quotationReference.entityType, 'QUOTATION');
  assert.strictEqual(
    quotationReference.kind,
    'EXPLICIT_QUOTATION_NAMED_REFERENCE'
  );
  assert.strictEqual(quotationReference.explicit, true);
  assert.strictEqual(quotationReference.requiresResolution, true);
  assert.strictEqual(quotationReference.resolvedEntityId, null);
  assert.strictEqual(quotationReference.evidenceSource, 'LOCAL_PARSER');
  assert.strictEqual(quotationReference.sourceText, '王总那个保温杯报价');
  assert.deepStrictEqual(quotationReference.sourceSpan, { start: 1, end: 10 });
  assert.strictEqual(
    quotationReference.normalizedReference,
    '王总:保温杯:QUOTATION'
  );
  assert.strictEqual(
    conversionTarget.original_text.slice(
      quotationReference.sourceSpan.start,
      quotationReference.sourceSpan.end
    ),
    quotationReference.sourceText
  );
  assert.deepStrictEqual(
    extractQuotationRelationReference(
      '把王总那个保温杯报价再转成订单',
      {
        hasQuotationToOrderConversion: true,
        customerName: '王总',
        productName: '保温杯'
      }
    ),
    quotationReference
  );
  const pastedConversion = parseInput({
    text: '把王总那个保温杯报价再转成订单',
    rawText: '王总：聊天背景\n把王总那个保温杯报价再转成订单',
    extractedText: '把王总那个保温杯报价再转成订单',
    source: 'paste',
    context: 'input',
    state: EMPTY_STATE,
    businessDate: BUSINESS_DATE,
    businessTimezone: 'Asia/Shanghai',
    nowInstant: NOW_INSTANT
  });
  const pastedConversionSignal = pastedConversion.intent_evidence
    .quotationToOrderConversionSignals[0];
  const pastedQuotationReference = pastedConversion.relation_references.quotation;
  assert.strictEqual(pastedConversionSignal.sourceField, 'EXTRACTED_TEXT');
  assert.strictEqual(pastedQuotationReference.sourceField, 'EXTRACTED_TEXT');
  assert.strictEqual(
    pastedConversion.extracted_text.slice(
      pastedConversionSignal.sourceSpan.start,
      pastedConversionSignal.sourceSpan.end
    ),
    pastedConversionSignal.sourceText
  );
  assert.strictEqual(
    pastedConversion.extracted_text.slice(
      pastedQuotationReference.sourceSpan.start,
      pastedQuotationReference.sourceSpan.end
    ),
    pastedQuotationReference.sourceText
  );

  const deicticQuotation = parse('这个报价转成订单')
    .relation_references.quotation;
  assert.strictEqual(deicticQuotation.kind, 'EXPLICIT_QUOTATION_DEICTIC');
  assert.strictEqual(deicticQuotation.resolvedEntityId, null);
  const bareConversion = parse('报价转订单');
  assert.strictEqual(bareConversion.intent, 'order');
  assert.strictEqual(bareConversion.relation_references, undefined);
  assert.strictEqual(bareConversion.fields.quotationId, undefined);

  const quotationEvidenceJson = JSON.stringify(
    conversionTarget.relation_references
  );
  assert.deepStrictEqual(
    JSON.parse(quotationEvidenceJson),
    conversionTarget.relation_references
  );
  assert.strictEqual(
    stableHash(
      conversionTarget.relation_references,
      'quotation-relation-evidence-v1'
    ),
    stableHash(
      JSON.parse(quotationEvidenceJson),
      'quotation-relation-evidence-v1'
    )
  );

  const quotationStateVariants = [
    EMPTY_STATE,
    {
      ...EMPTY_STATE,
      quotations: [{ id: 'quo-only', customerId: 'cus-wang', productName: '保温杯' }]
    },
    {
      ...EMPTY_STATE,
      quotations: [
        { id: 'quo-one', customerId: 'cus-wang', productName: '保温杯' },
        { id: 'quo-two', customerId: 'cus-wang', productName: '保温杯' }
      ]
    }
  ];
  const stateIndependentQuotationEvidence = quotationStateVariants.map((state) => {
    const result = parse('把王总那个保温杯报价再转成订单', state);
    assert.strictEqual(result.fields.quotationId, undefined);
    return {
      conversion: result.intent_evidence.quotationToOrderConversionSignals,
      relation: result.relation_references
    };
  });
  stateIndependentQuotationEvidence.slice(1).forEach((evidence) => {
    assert.deepStrictEqual(evidence, stateIndependentQuotationEvidence[0]);
  });

  assert.strictEqual(
    parse('把手产品报价转成订单').fields.customerName,
    '',
    'product name containing 把 must not become a customer'
  );
  const mixedConversion = parse('把王总那个报价转成订单，明天提醒我跟进');
  assert.strictEqual(mixedConversion.mixed_business, true);
  assert.strictEqual(mixedConversion.formal_save_blocked, true);
  assert.strictEqual(
    mixedConversion.intent_evidence.quotationToOrderConversionSignals.length,
    1
  );

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

  const localQuotationReference = conversionTarget.relation_references;
  const quotationAiBase = {
    provider: 'mock',
    intent: 'order',
    operation: 'create_order',
    fields: Object.assign({}, conversionTarget.fields),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
  const quotationMergeVariants = [
    {
      label: 'AI没有返回relation',
      ai: quotationAiBase
    },
    {
      label: 'AI返回空relation',
      ai: Object.assign({}, quotationAiBase, { relation_references: {} })
    },
    {
      label: 'AI只返回quotation candidates',
      ai: Object.assign({}, quotationAiBase, {
        quotation_candidates: [{ id: 'quo-ai-candidate', reason: '仅供用户选择' }]
      })
    },
    {
      label: 'AI返回冲突quotation建议',
      ai: Object.assign({}, quotationAiBase, {
        fields: Object.assign({}, quotationAiBase.fields, {
          quotationId: 'quo-ai-forged'
        }),
        relation_references: {
          quotation: {
            entityType: 'QUOTATION',
            kind: 'AI_SUGGESTION',
            explicit: true,
            requiresResolution: false,
            sourceText: '伪造报价',
            sourceSpan: { start: 0, end: 4 },
            confidence: 1,
            normalizedReference: 'AI:QUOTATION',
            resolvedEntityId: 'quo-ai-forged',
            evidenceSource: 'AI'
          }
        }
      })
    }
  ];
  quotationMergeVariants.forEach(({ label, ai }) => {
    const result = normalizeAiResult(
      conversionTarget,
      ai,
      { providerKind: 'MOCK' }
    );
    assert.deepStrictEqual(
      result.relation_references,
      localQuotationReference,
      `${label}: LOCAL_PARSER quotation Evidence必须完整保留`
    );
    assert.deepStrictEqual(
      result.relation_references.quotation.sourceSpan,
      { start: 1, end: 10 },
      `${label}: AI不得改写本地sourceSpan`
    );
    assert.strictEqual(
      result.relation_references.quotation.resolvedEntityId,
      null,
      `${label}: AI不得解析quotation relation`
    );
    assert.strictEqual(
      result.fields.quotationId,
      undefined,
      `${label}: AI不得把候选或直接ID升级成quotationId`
    );
  });

  const aiQuotationReferenceCannotCreate = normalizeAiResult(
    bareConversion,
    Object.assign({}, quotationAiBase, {
      relation_references: localQuotationReference
    }),
    { providerKind: 'MOCK' }
  );
  assert.strictEqual(
    aiQuotationReferenceCannotCreate.relation_references,
    undefined,
    '缺少本地quotation Evidence时，AI不得创造可信报价关系'
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

  const conversionRun = await runSuite({
    caseId: 'REC-E2E-REL-008',
    repeat: 1
  });
  const conversionCase = conversionRun.attempts[0].results[0];
  assert.strictEqual(conversionCase.caseStatus, 'CASE_FAIL');
  assert.strictEqual(conversionCase.failureStage, 'AI_NORMALIZE_ERROR');
  const conversionRaw = conversionCase.parserObservation.summary
    .canonicalLocalResults[0].resultSummary;
  assert.strictEqual(conversionRaw.businessType, 'order');
  assert.strictEqual(conversionRaw.operation, null);
  assert.strictEqual(
    conversionRaw.intentEvidence.winningReason,
    'EXPLICIT_QUOTATION_TO_ORDER_CONVERSION'
  );
  assert.strictEqual(
    conversionCase.observationSemantics.semanticResult.businessType,
    'order'
  );
  assert.strictEqual(
    conversionCase.observationSemantics.semanticResult.effectiveOperation,
    'create_order'
  );
  assert.strictEqual(
    conversionCase.observationSemantics.proposal.fields.customerName,
    '王总'
  );
  assert.strictEqual(
    conversionCase.observationSemantics.proposal.fields.productName,
    '保温杯'
  );
  assert.strictEqual(
    conversionCase.observationSemantics.proposal.fields.quotationId,
    undefined
  );
  assert.strictEqual(
    conversionCase.relationEvidence
      .quotationToOrderConversionEvidencePresent,
    true
  );
  assert.strictEqual(
    conversionCase.relationEvidence.conversionDirection,
    'QUOTATION_TO_ORDER'
  );
  assert.strictEqual(
    conversionCase.relationEvidence.conversionSourceText,
    '报价再转成订单'
  );
  assert.deepStrictEqual(
    conversionCase.relationEvidence.conversionSourceSpan,
    { start: 8, end: 15 }
  );
  assert.strictEqual(
    conversionCase.relationEvidence.quotationRelationEvidencePresent,
    true
  );
  assert.strictEqual(
    conversionCase.relationEvidence.quotationRelationKind,
    'EXPLICIT_QUOTATION_NAMED_REFERENCE'
  );
  assert.strictEqual(
    conversionCase.relationEvidence.quotationRelationSourceText,
    '王总那个保温杯报价'
  );
  assert.deepStrictEqual(
    conversionCase.relationEvidence.quotationRelationSourceSpan,
    { start: 1, end: 10 }
  );
  assert.strictEqual(
    conversionCase.relationEvidence.quotationRelationRequiresResolution,
    true
  );
  assert.strictEqual(
    conversionCase.relationEvidence.quotationRelationResolvedEntityId,
    null
  );
  assert.strictEqual(
    conversionCase.relationEvidence.quotationRelationEvidenceSource,
    'LOCAL_PARSER'
  );
  assert.deepStrictEqual(
    conversionCase.relationEvidence
      .quotationRelationEvidencePropagationStages,
    ['RAW_PARSER', 'HYBRID_RESULT', 'CONFIRMATION_DRAFT', 'PREFLIGHT_INPUT']
  );
  assert.throws(
    () => buildRelationEvidence(
      Object.assign({}, conversionCase.parserObservation, {
        hybridInvocations: []
      }),
      {
        relation_references:
          conversionCase.relationEvidence.stages.confirmationDraft
      },
      {
        preflightInputRelationReferences:
          conversionCase.relationEvidence.stages.preflightInput
      }
    ),
    (error) => error.code === 'RELATION_EVIDENCE_PROPAGATION_MISSING'
  );
  const changedQuotationConfirmation = JSON.parse(JSON.stringify(
    conversionCase.relationEvidence.stages.confirmationDraft
  ));
  changedQuotationConfirmation.quotation.normalizedReference =
    'FORGED_QUOTATION_REFERENCE';
  assert.throws(
    () => buildRelationEvidence(
      conversionCase.parserObservation,
      { relation_references: changedQuotationConfirmation },
      {
        preflightInputRelationReferences:
          conversionCase.relationEvidence.stages.preflightInput
      }
    ),
    (error) => error.code === 'RELATION_EVIDENCE_PROPAGATION_MISMATCH'
  );
  assert.strictEqual(conversionCase.routeEvidence.initialRoute, 'PENDING');
  assert.strictEqual(conversionCase.routeEvidence.initialDeepReviewAvailable, true);
  assert.strictEqual(
    conversionCase.routeEvidence.quotationConversionDeepReviewEligible,
    true
  );
  assert.strictEqual(conversionCase.routeEvidence.actualRoute, 'AI_DEEP');
  assert.strictEqual(conversionCase.routeEvidence.AIRequestCount, 1);
  assert.strictEqual(conversionCase.routeEvidence.standardAIRequestCount, 0);
  assert.strictEqual(conversionCase.routeEvidence.deepAIRequestCount, 1);
  assert.strictEqual(
    conversionCase.routeEvidence.requestDeepReviewInvocationCount,
    1
  );
  assert.strictEqual(conversionCase.routeEvidence.secondHybridInvocationCount, 1);
  assert.strictEqual(
    conversionCase.routeEvidence.duplicateDeepReviewInvocationCount,
    0
  );
  assert.strictEqual(conversionCase.routeEvidence.duplicateDeepAIRequestCount, 0);
  assert.strictEqual(
    conversionCase.routeEvidence.quotationLocalEvidenceDropCount,
    0
  );
  assert.strictEqual(
    conversionCase.routeEvidence.untrustedQuotationIdPromotionCount,
    0
  );
  Object.values(conversionCase.businessDiff).forEach((diff) => {
    assert.deepStrictEqual(diff.created, []);
    assert.deepStrictEqual(diff.deleted, []);
    assert.deepStrictEqual(diff.updated, []);
  });

  const quotationUpdateRun = await runSuite({
    caseId: 'REC-E2E-REL-010',
    repeat: 1
  });
  const quotationUpdateCase = quotationUpdateRun.attempts[0].results[0];
  const quotationUpdateRaw = quotationUpdateCase.parserObservation.summary
    .canonicalLocalResults[0].resultSummary;
  assert.strictEqual(quotationUpdateRaw.businessType, 'quotation');
  assert.strictEqual(quotationUpdateRaw.operation, 'update_quotation');
  assert.strictEqual(
    quotationUpdateCase.relationEvidence
      .quotationToOrderConversionEvidencePresent,
    false
  );
  assert.strictEqual(
    quotationUpdateCase.relationEvidence.quotationRelationEvidencePresent,
    false
  );

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
    'ai-merge-guard=7',
    'runner-targets=2',
    `quotation-conversion-positive=${conversionPositives.length}`,
    `quotation-conversion-negative=${conversionNegatives.length}`,
    'quotation-relation=3',
    'quotation-runner-targets=2',
    'runner-hard-gates=4',
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
