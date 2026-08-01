#!/usr/bin/env node

const assert = require('assert');
const {
  evaluateRecordDomainPreflight,
  stableFingerprint
} = require('../../../utils/record-domain-preflight');
const {
  buildRecordConfirmation
} = require('../../../utils/record-confirmation-builder');
const {
  HEADLESS_TEST_CAPABILITIES
} = require('../../../utils/record-confirmation-contract');

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function customer(id, name) {
  return { id, name, userId: 'candidate-test-user' };
}

function quotation(id, customerId, overrides = {}) {
  return Object.assign({
    id,
    userId: 'candidate-test-user',
    customerId,
    productName: `合成商品${id}`,
    items: [{ productName: `合成商品${id}`, quantity: 10, unit: '个', unitPrice: 5 }],
    totalAmount: 50,
    status: '待确认',
    quoteDate: '2026-07-10',
    validUntil: '2026-07-17',
    createdAt: '2026-07-10T02:00:00.000Z'
  }, overrides);
}

function state(overrides = {}) {
  return Object.assign({
    customers: [
      customer('cus-a', '王总'),
      customer('cus-b', '李姐')
    ],
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    todos: [],
    deletedRecords: []
  }, overrides);
}

function result(operation, fields = {}, intent) {
  return {
    intent: intent || (operation === 'create_order' ? 'order' : 'quotation'),
    operation,
    original_text: '合成报价候选安全测试',
    fields: Object.assign({
      customerId: 'cus-a',
      customerName: '王总'
    }, fields),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

function preflight(operation, fixtureState, fields = {}, options = {}) {
  const finalResult = result(operation, fields, options.intent);
  if (options.modelCandidates) {
    finalResult.quotation_candidates = clone(options.modelCandidates);
  }
  if (options.explicitQuotationConversion) {
    const sourceText = options.referenceSourceText || '王总那个保温杯报价';
    const originalText = `${sourceText}再转成订单`;
    finalResult.original_text = originalText;
    finalResult.intent_evidence = {
      quotationToOrderConversionSignals: [{
        kind: 'QUOTATION_TO_ORDER_CONVERSION',
        direction: 'QUOTATION_TO_ORDER',
        explicit: true,
        confidence: 0.99,
        evidenceSource: 'LOCAL_PARSER',
        sourceField: 'ORIGINAL_TEXT',
        sourceText: '报价再转成订单',
        sourceSpan: {
          start: originalText.indexOf('报价再转成订单'),
          end: originalText.indexOf('报价再转成订单') + '报价再转成订单'.length
        }
      }]
    };
    finalResult.relation_references = {
      quotation: {
        entityType: 'QUOTATION',
        kind: options.referenceKind || 'EXPLICIT_QUOTATION_NAMED_REFERENCE',
        explicit: true,
        requiresResolution: true,
        sourceText,
        sourceSpan: { start: 0, end: sourceText.length },
        confidence: 0.97,
        normalizedReference: options.normalizedReference || '王总:保温杯:QUOTATION',
        resolvedEntityId: null,
        evidenceSource: 'LOCAL_PARSER',
        sourceField: 'ORIGINAL_TEXT'
      }
    };
  }
  return evaluateRecordDomainPreflight({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    operation,
    businessType: finalResult.intent,
    finalResult,
    initialState: fixtureState,
    skipFinalSafety: true
  });
}

function safeCandidates(value) {
  return value.candidates.quotationSelectionCandidates;
}

function candidateIds(value) {
  return safeCandidates(value).map((item) => item.quotationId);
}

function blockingCodes(value) {
  return (value.blockingIssues || []).map((item) => item.code);
}

test('active same-customer quotation is selectable for update', () => {
  const actual = preflight('update_quotation', state({
    quotations: [quotation('quo-a', 'cus-a')]
  }));
  assert.deepStrictEqual(candidateIds(actual), ['quo-a']);
  assert.strictEqual(actual.candidates.quotationSelectionRequired, true);
  assert.strictEqual(safeCandidates(actual)[0].selectionEligible, true);
  assert.deepStrictEqual(safeCandidates(actual)[0].selectionBlockingCodes, []);
});

test('multiple safe quotations use stable id order', () => {
  const fixture = state({
    quotations: [
      quotation('quo-z', 'cus-a'),
      quotation('quo-a', 'cus-a'),
      quotation('quo-m', 'cus-a')
    ]
  });
  assert.deepStrictEqual(
    candidateIds(preflight('update_quotation', fixture)),
    ['quo-a', 'quo-m', 'quo-z']
  );
});

test('cross-customer quotation is never selectable', () => {
  const actual = preflight('update_quotation', state({
    quotations: [quotation('quo-b', 'cus-b')]
  }));
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('customer identity conflict never exposes quotation candidates', () => {
  const actual = preflight('update_quotation', state({
    quotations: [quotation('quo-a', 'cus-a')]
  }), {
    customerId: 'cus-a',
    customerName: '李姐'
  });
  assert(blockingCodes(actual).includes('CUSTOMER_SELECTION_INPUT_CONFLICT'));
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('deleted quotation is never selectable even in a dirty compatibility State', () => {
  const actual = preflight('update_quotation', state({
    quotations: [quotation('quo-deleted', 'cus-a')],
    deletedRecords: [{
      id: 'del-quotation',
      recordType: 'quotation',
      recordId: 'quo-deleted',
      deletedAt: '2026-07-12T02:00:00.000Z'
    }]
  }));
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('selected deleted quotation is rejected and blocks formal save', () => {
  const actual = preflight('update_quotation', state({
    quotations: [quotation('quo-deleted', 'cus-a')],
    deletedRecords: [{
      id: 'del-quotation',
      recordType: 'quotation',
      recordId: 'quo-deleted',
      deletedAt: '2026-07-12T02:00:00.000Z'
    }]
  }), { quotationId: 'quo-deleted' });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert(blockingCodes(actual).includes('QUOTATION_TARGET_NOT_FOUND'));
  assert.strictEqual(actual.domainCanSaveFormal, false);
  assert.strictEqual(actual.candidates.rejectedQuotationReferences[0].quotationId, 'quo-deleted');
  assert(actual.candidates.rejectedQuotationReferences[0]
    .selectionBlockingCodes.includes('QUOTATION_TARGET_NOT_FOUND'));
});

test('quotation without a stable id is never selectable', () => {
  const invalid = quotation('', 'cus-a');
  delete invalid.id;
  const actual = preflight('update_quotation', state({
    quotations: [invalid]
  }));
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('inactive quotation is never selectable', () => {
  ['已作废', '已取消', '已失效', 'cancelled', 'canceled', 'void'].forEach((status) => {
    const actual = preflight('create_order', state({
      quotations: [quotation(`quo-${status}`, 'cus-a', { status })]
    }), {
      productName: '合成商品',
      quantity: 10,
      unit: '个',
      unitPrice: 5,
      dueDate: '2026-07-30'
    });
    assert.deepStrictEqual(candidateIds(actual), []);
  });
});

test('selected unknown-status quotation is rejected and blocks order creation', () => {
  ['', '报价中', 'expired'].forEach((status, index) => {
    const quotationId = `quo-unknown-${index}`;
    const actual = preflight('create_order', state({
      quotations: [quotation(quotationId, 'cus-a', { status })]
    }), {
      quotationId,
      productName: '合成商品',
      quantity: 10,
      unit: '个',
      unitPrice: 5,
      dueDate: '2026-07-30'
    });
    assert.deepStrictEqual(candidateIds(actual), []);
    assert(blockingCodes(actual).includes('QUOTATION_TARGET_NOT_ACTIVE'));
    assert.strictEqual(actual.domainCanSaveFormal, false);
    assert(actual.candidates.rejectedQuotationReferences[0]
      .selectionBlockingCodes.includes('QUOTATION_TARGET_NOT_ACTIVE'));
  });
});

test('converted quotation is never selectable for another order', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-converted', 'cus-a', {
      status: '已转订单',
      convertedOrderId: 'ord-existing'
    })],
    orders: [{ id: 'ord-existing', customerId: 'cus-a', quotationId: 'quo-converted' }]
  }), {
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  });
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('reverse order relation also excludes a converted quotation', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-reverse', 'cus-a')],
    orders: [{ id: 'ord-existing', customerId: 'cus-a', quotationId: 'quo-reverse' }]
  }), {
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  });
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('selected cross-customer reference is blocked and kept out of safe candidates', () => {
  const actual = preflight('update_quotation', state({
    quotations: [
      quotation('quo-safe', 'cus-a'),
      quotation('quo-cross', 'cus-b')
    ]
  }), { quotationId: 'quo-cross' });
  assert(blockingCodes(actual).includes('QUOTATION_CUSTOMER_MISMATCH'));
  assert.strictEqual(actual.domainCanSaveFormal, false);
  assert.deepStrictEqual(candidateIds(actual), ['quo-safe']);
  assert.strictEqual(actual.candidates.rejectedQuotationReferences[0].quotationId, 'quo-cross');
  assert(actual.candidates.rejectedQuotationReferences[0]
    .selectionBlockingCodes.includes('QUOTATION_CUSTOMER_MISMATCH'));
});

test('selected converted reference is blocked and kept out of safe candidates', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-safe', 'cus-a'),
      quotation('quo-converted', 'cus-a', {
        status: '已转订单',
        convertedOrderId: 'ord-existing'
      })
    ],
    orders: [{ id: 'ord-existing', customerId: 'cus-a', quotationId: 'quo-converted' }]
  }), {
    quotationId: 'quo-converted',
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  });
  assert(blockingCodes(actual).includes('QUOTATION_ALREADY_CONVERTED'));
  assert.strictEqual(actual.domainCanSaveFormal, false);
  assert.deepStrictEqual(candidateIds(actual), ['quo-safe']);
  assert(actual.candidates.rejectedQuotationReferences[0]
    .selectionBlockingCodes.includes('QUOTATION_ALREADY_CONVERTED'));
});

test('create quotation does not expose historical quotation selection', () => {
  const actual = preflight('create_quotation', state({
    quotations: [quotation('quo-existing', 'cus-a')]
  }), {
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5
  });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert.strictEqual(actual.candidates.quotationSelectionRequired, false);
});

test('plain new order may expose safe sources but never requires one', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-a', 'cus-a'),
      quotation('quo-b', 'cus-a')
    ]
  }), {
    productName: '合成新商品',
    quantity: 20,
    unit: '个',
    unitPrice: 6,
    dueDate: '2026-07-30'
  });
  assert.deepStrictEqual(candidateIds(actual), ['quo-a', 'quo-b']);
  assert.strictEqual(actual.candidates.quotationSelectionRequired, false);
  assert.strictEqual(actual.requiredSelections.includes('quotationId'), false);
  assert.strictEqual(safeCandidates(actual).some((item) => item.isSelected), false);
});

test('update order does not expose a quotation rebinding picker', () => {
  const actual = preflight('update_order', state({
    quotations: [quotation('quo-a', 'cus-a')],
    orders: [{
      id: 'ord-a',
      customerId: 'cus-a',
      quotationId: 'quo-a',
      status: '待生产',
      totalAmount: 50
    }]
  }), { orderId: 'ord-a', quotationId: 'quo-a' }, { intent: 'order' });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences, []);
  assert.strictEqual(actual.domainCanSaveFormal, true);
});

test('candidate set is recomputed from the latest State', () => {
  const beforeState = state({ quotations: [quotation('quo-a', 'cus-a')] });
  const afterState = clone(beforeState);
  afterState.quotations[0].status = '已作废';
  assert.deepStrictEqual(candidateIds(preflight('update_quotation', beforeState)), ['quo-a']);
  assert.deepStrictEqual(candidateIds(preflight('update_quotation', afterState)), []);
});

test('candidate projection is JSON serializable and complete', () => {
  const actual = safeCandidates(preflight('update_quotation', state({
    quotations: [quotation('quo-a', 'cus-a')]
  })))[0];
  const roundTrip = JSON.parse(JSON.stringify(actual));
  [
    'quotationId',
    'customerId',
    'customerDisplayName',
    'productSummary',
    'itemCount',
    'quotationAmount',
    'status',
    'quoteDate',
    'validUntil',
    'convertedOrderId',
    'createdAt',
    'selectionEligible',
    'selectionBlockingCodes'
  ].forEach((key) => assert(Object.prototype.hasOwnProperty.call(roundTrip, key), key));
});

test('candidate fingerprint is stable when source quotation order changes', () => {
  const first = state({
    quotations: [quotation('quo-b', 'cus-a'), quotation('quo-a', 'cus-a')]
  });
  const second = state({
    quotations: [quotation('quo-a', 'cus-a'), quotation('quo-b', 'cus-a')]
  });
  const firstCandidates = safeCandidates(preflight('update_quotation', first));
  const secondCandidates = safeCandidates(preflight('update_quotation', second));
  assert.deepStrictEqual(firstCandidates, secondCandidates);
  assert.strictEqual(stableFingerprint(firstCandidates), stableFingerprint(secondCandidates));
});

test('model quotation_candidates never establishes safe candidate identity', () => {
  const actual = preflight('update_quotation', state({ quotations: [] }), {}, {
    modelCandidates: [{ id: 'ai-invented-quotation' }]
  });
  assert.deepStrictEqual(candidateIds(actual), []);
});

test('validUntil is projected but does not invent a date-expiry policy', () => {
  const actual = safeCandidates(preflight('create_order', state({
    quotations: [quotation('quo-date', 'cus-a', { validUntil: '2025-01-01' })]
  }), {
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  }))[0];
  assert.strictEqual(actual.validUntil, '2025-01-01');
  assert.strictEqual(actual.selectionEligible, true);
});

test('unique converted named quotation becomes rejected evidence without selection', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-converted', 'cus-a', {
      productName: '保温杯',
      items: [{ productName: '保温杯' }],
      status: '已转订单',
      convertedOrderId: 'ord-existing'
    })],
    orders: [{ id: 'ord-existing', customerId: 'cus-a', quotationId: 'quo-converted' }]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert.strictEqual(actual.quotationRelationGate.selectedQuotationId, '');
  assert.strictEqual(actual.quotationRelationGate.selectionConfirmed, false);
  assert.strictEqual(actual.quotationRelationGate.status, 'DANGEROUS_REFERENCE_REJECTED');
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences.map((item) => item.quotationId), [
    'quo-converted'
  ]);
  assert(blockingCodes(actual).includes('QUOTATION_ALREADY_CONVERTED'));
});

test('unique deleted named quotation is rejected from latest State', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-deleted', 'cus-a', {
      productName: '保温杯',
      items: [{ productName: '保温杯' }]
    })],
    deletedRecords: [{ recordType: 'quotation', recordId: 'quo-deleted' }]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences[0]
    .selectionBlockingCodes, ['QUOTATION_TARGET_NOT_FOUND']);
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
});

test('unique inactive named quotation is rejected without becoming selected', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-inactive', 'cus-a', {
      productName: '保温杯',
      items: [{ productName: '保温杯' }],
      status: '已失效'
    })]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert(actual.candidates.rejectedQuotationReferences[0]
    .selectionBlockingCodes.includes('QUOTATION_TARGET_NOT_ACTIVE'));
  assert.strictEqual(actual.quotationRelationGate.selectedQuotationId, '');
});

test('unique safe named quotation still requires a real selection', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-safe', 'cus-a', {
      productName: '保温杯',
      items: [{ productName: '保温杯' }]
    })]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), ['quo-safe']);
  assert(actual.requiredSelections.includes('quotationId'));
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert.strictEqual(actual.domainCanSaveFormal, false);
});

test('multiple safe named quotations remain unselected in stable order', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-z', 'cus-a', { productName: '保温杯', items: [{ productName: '保温杯' }] }),
      quotation('quo-a', 'cus-a', { productName: '保温杯', items: [{ productName: '保温杯' }] })
    ]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), ['quo-a', 'quo-z']);
  assert(actual.requiredSelections.includes('quotationId'));
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
});

test('safe and dangerous named matches expose only safe candidates', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-safe', 'cus-a', { productName: '保温杯', items: [{ productName: '保温杯' }] }),
      quotation('quo-converted', 'cus-a', {
        productName: '保温杯',
        items: [{ productName: '保温杯' }],
        status: '已转订单',
        convertedOrderId: 'ord-existing'
      })
    ],
    orders: [{ id: 'ord-existing', customerId: 'cus-a', quotationId: 'quo-converted' }]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), ['quo-safe']);
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences, []);
  assert(actual.requiredSelections.includes('quotationId'));
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
});

test('multiple dangerous named matches stay ambiguous without choosing a rejected id', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-one', 'cus-a', {
        productName: '保温杯', items: [{ productName: '保温杯' }], status: '已转订单'
      }),
      quotation('quo-two', 'cus-a', {
        productName: '保温杯', items: [{ productName: '保温杯' }], status: '已失效'
      })
    ]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true
  });
  assert.deepStrictEqual(candidateIds(actual), []);
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences, []);
  assert.strictEqual(actual.quotationRelationGate.status, 'AMBIGUOUS_REFERENCE');
  assert(actual.requiredSelections.includes('quotationId'));
});

test('unconfirmed safe quotation id is only a candidate and requires confirmation', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-safe', 'cus-a')]
  }), {
    quotationId: 'quo-safe',
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  });
  assert.deepStrictEqual(candidateIds(actual), ['quo-safe']);
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert(actual.requiredSelections.includes('quotationId'));
  assert(blockingCodes(actual).includes('QUOTATION_SELECTION_CONFIRMATION_REQUIRED'));
});

test('unconfirmed converted quotation id is rejected and never resolved', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-converted', 'cus-a', { status: '已转订单' })]
  }), { quotationId: 'quo-converted' });
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences.map((item) => item.quotationId), [
    'quo-converted'
  ]);
  assert(blockingCodes(actual).includes('QUOTATION_ALREADY_CONVERTED'));
});

test('unconfirmed cross-customer quotation id is rejected without customer disclosure', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-cross', 'cus-b')]
  }), { quotationId: 'quo-cross' });
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert.strictEqual(actual.candidates.rejectedQuotationReferences[0].customerId, '');
  assert.strictEqual(actual.candidates.rejectedQuotationReferences[0].status, '');
  assert.strictEqual(actual.candidates.rejectedQuotationReferences[0].convertedOrderId, '');
  assert(blockingCodes(actual).includes('QUOTATION_CUSTOMER_MISMATCH'));
});

test('unconfirmed missing quotation id is rejected and never resolved', () => {
  const actual = preflight('create_order', state(), { quotationId: 'quo-missing' });
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences[0]
    .selectionBlockingCodes, ['QUOTATION_TARGET_NOT_FOUND']);
});

test('real confirmed safe quotation selection resolves after latest-State validation', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-safe', 'cus-a')]
  }), {
    quotationId: 'quo-safe',
    quotationSelectionConfirmed: true,
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  });
  assert.strictEqual(actual.resolvedRelations.quotationId, 'quo-safe');
  assert.strictEqual(actual.resolvedRelations.resolutionSource.quotationId, 'USER_CONFIRMED_SELECTION');
  assert.strictEqual(actual.requiredSelections.includes('quotationId'), false);
});

test('confirmed converted quotation selection remains rejected', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-converted', 'cus-a', { status: '已转订单' })]
  }), {
    quotationId: 'quo-converted',
    quotationSelectionConfirmed: true
  });
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert(blockingCodes(actual).includes('QUOTATION_ALREADY_CONVERTED'));
  assert.strictEqual(actual.quotationRelationGate.selectionConfirmed, false);
});

test('confirmation flag without quotation id never becomes confirmed relation state', () => {
  const actual = preflight('create_order', state({
    quotations: [quotation('quo-safe', 'cus-a')]
  }), {
    quotationSelectionConfirmed: true,
    productName: '合成商品',
    quantity: 10,
    unit: '个',
    unitPrice: 5,
    dueDate: '2026-07-30'
  });
  assert.strictEqual(actual.quotationRelationGate.selectedQuotationId, '');
  assert.strictEqual(actual.quotationRelationGate.selectionConfirmed, false);
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
});

test('confirmed safe id outside explicit named matches uses target code not confirmation code', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-target', 'cus-a', {
        productName: '保温杯', items: [{ productName: '保温杯' }]
      }),
      quotation('quo-other', 'cus-a', {
        productName: '饭盒', items: [{ productName: '饭盒' }]
      })
    ]
  }), {
    quotationId: 'quo-other',
    quotationSelectionConfirmed: true,
    customerName: '王总',
    productName: '保温杯'
  }, {
    explicitQuotationConversion: true
  });
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert(blockingCodes(actual).includes('QUOTATION_TARGET_REQUIRED'));
  assert.strictEqual(
    blockingCodes(actual).includes('QUOTATION_SELECTION_CONFIRMATION_REQUIRED'),
    false
  );
});

test('AI quotation suggestions cannot disambiguate explicit safe and dangerous matches', () => {
  const actual = preflight('create_order', state({
    quotations: [
      quotation('quo-safe', 'cus-a', {
        productName: '保温杯', items: [{ productName: '保温杯' }]
      }),
      quotation('quo-danger', 'cus-a', {
        productName: '保温杯', items: [{ productName: '保温杯' }], status: '已转订单'
      })
    ]
  }), { customerName: '王总', productName: '保温杯' }, {
    explicitQuotationConversion: true,
    modelCandidates: [
      { id: 'quo-danger', confidence: 1 },
      { id: 'quo-safe', confidence: 0.1 },
      { id: 'quo-danger' },
      { id: '' },
      { id: { nested: 'quo-safe' } }
    ]
  });
  assert.deepStrictEqual(candidateIds(actual), ['quo-safe']);
  assert.strictEqual(actual.resolvedRelations.quotationId, '');
  assert(actual.requiredSelections.includes('quotationId'));
  assert.deepStrictEqual(actual.candidates.rejectedQuotationReferences, []);
});

test('Shared Confirmation projects Preflight candidates without forcing new-order selection', () => {
  const fixture = state({
    quotations: [quotation('quo-b', 'cus-a'), quotation('quo-a', 'cus-a')]
  });
  const finalResult = result('create_order', {
    productName: '合成新商品',
    quantity: 20,
    unit: '个',
    unitPrice: 6,
    dueDate: '2026-07-30'
  }, 'order');
  const confirmation = buildRecordConfirmation({
    mode: 'PRODUCTION_ROUTING',
    resultScope: 'PRODUCTION_RESULT',
    productionRoute: 'LOCAL',
    finalResult,
    originalText: finalResult.original_text,
    initialState: fixture,
    saveEligibility: {
      canCommitToMemory: true,
      canCommitToRealStorage: false,
      blockedReasons: []
    },
    surfaceCapabilities: HEADLESS_TEST_CAPABILITIES
  });
  assert.deepStrictEqual(
    confirmation.candidates.quotationSelectionCandidates.map((item) => item.id),
    ['quo-a', 'quo-b']
  );
  assert.strictEqual(confirmation.candidates.quotationSelectionRequired, false);
  assert.strictEqual(
    confirmation.surface.requiredCapabilities.includes('SELECT_QUOTATION'),
    false
  );
});

async function main() {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.run();
      passed += 1;
      console.log(`✓ ${current.name}`);
    } catch (error) {
      console.error(`✗ ${current.name}`);
      throw error;
    }
  }
  console.log(`Quotation candidate source tests: ${passed}/${tests.length} passed`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { tests };
