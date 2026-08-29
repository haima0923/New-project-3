const { createPageHarness } = require('../record-confirm-interaction-v1/runtime');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');

const INTENTS = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'unknown'];
const OPERATIONS = {
  quotation: 'create_quotation',
  order: 'create_order',
  receivable: 'create_receivable',
  payment: 'record_payment',
  dunning: 'create_todo',
  todo: 'create_todo',
  unknown: 'pending'
};

function createDraft(options = {}) {
  const intent = options.intent || 'order';
  const originalText = String(options.originalText || '王总下单旧杯100个，每个10元，2026-08-20交货。');
  return {
    id: `controlled-${options.id || intent}`,
    intent,
    operation: options.operation || OPERATIONS[intent] || 'pending',
    suggested_operation: options.suggestedOperation || '',
    source: 'typed',
    original_text: originalText,
    raw_text: originalText,
    fields: safeClone(options.fields || {}),
    missing_fields: safeClone(options.missingFields || []),
    low_confidence_fields: safeClone(options.lowConfidenceFields || []),
    field_conflicts: safeClone(options.fieldConflicts || []),
    manual_fields: safeClone(options.manualFields || []),
    manual_item_fields: safeClone(options.manualItemFields || []),
    user_manual_edits: safeClone(options.userManualEdits || []),
    local_parse_safety: {
      status: 'SAFE_LOCAL',
      reason_codes: [],
      reason_texts: []
    },
    parse_route: {
      decision: 'local',
      semantic_decision: 'LOCAL',
      production_route: 'LOCAL'
    },
    ai_fallback: {
      attempted: false,
      business_result_valid: false,
      needed: false,
      provider_kind: 'NONE',
      status: 'not_requested'
    },
    formal_save_blocked: false,
    mixed_business: false,
    requires_existing_record: false,
    client_confirmation_context: {
      confirmationSessionId: `csi-session-${options.id || intent}`,
      draftRevision: '1',
      originalTextFingerprint: stableHash({ text: originalText }, 'record-confirm-original-text'),
      requestId: `csi-request-${options.id || intent}`,
      requestedRoute: 'FAST_LOCAL'
    }
  };
}

function baseCustomer() {
  return {
    id: 'cus-csi-wang',
    userId: 'local-user',
    name: '王总',
    phone: '',
    company: '',
    region: '',
    wechatRemark: '',
    tags: [],
    mergedInto: '',
    isTemporary: false,
    duplicateReviewed: true,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z'
  };
}

function createFixtureState(kind = '') {
  const state = createInitialState();
  if (!kind) return state;
  state.customers.unshift(baseCustomer());
  if (['PAYMENT_RELATION', 'ALL_RELATIONS'].includes(kind)) {
    state.receivables.unshift({
      id: 'rec-csi-open',
      userId: 'local-user',
      customerId: 'cus-csi-wang',
      orderId: '',
      amount: '1000',
      paidAmount: '0',
      dueDate: '2026-08-30',
      status: '待收',
      source: 'manual',
      originalText: '王总欠款1000元',
      remark: '',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z'
    });
  }
  if (kind === 'ALL_RELATIONS') {
    state.orders.unshift({
      id: 'ord-csi-open',
      userId: 'local-user',
      customerId: 'cus-csi-wang',
      quotationId: '',
      productName: '旧杯',
      quantity: '100',
      unit: '个',
      unitPrice: '10',
      totalAmount: '1000',
      items: [{ productName: '旧杯', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' }],
      requiredDeliveryDate: '2026-08-20',
      expectedShipDate: '2026-08-20',
      status: '待生产',
      originalText: '王总下单旧杯100个',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z'
    });
    state.quotations.unshift({
      id: 'quo-csi-open',
      userId: 'local-user',
      customerId: 'cus-csi-wang',
      productName: '旧杯',
      quantity: '100',
      unit: '个',
      unitPrice: '10',
      totalAmount: '1000',
      items: [{ productName: '旧杯', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000' }],
      deliveryDate: '2026-08-18',
      status: '待确认',
      convertedOrderId: '',
      originalText: '给王总报旧杯100个',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z'
    });
  }
  return state;
}

function createHarnessForDraft(caseId, draft, stateKind = '') {
  return createPageHarness({
    caseId,
    initialState: createFixtureState(stateKind),
    text: draft.original_text
  });
}

function mountDraft(page, draft) {
  page.setData({
    text: draft.original_text,
    source: draft.source,
    intent: draft.intent,
    operation: draft.operation,
    parseResult: safeClone(draft),
    fields: safeClone(draft.fields),
    conversationPhase: 'CONFIRMING',
    parsing: false,
    saving: false
  });
  const index = INTENTS.indexOf(draft.intent);
  if (index < 0) throw Object.assign(new Error(`Unsupported controlled intent: ${draft.intent}`), {
    code: 'CONTROLLED_DRAFT_INTENT_UNSUPPORTED'
  });
  page.changeIntent({ detail: { value: String(index) } });
  return page.data;
}

function editField(page, field, value) {
  page.updateField({
    currentTarget: { dataset: { field } },
    detail: { value: String(value) }
  });
}

function editItem(page, index, field, value) {
  const items = page.data.fields && page.data.fields.items || [];
  const item = items[index] || {};
  page.updateItemField({
    currentTarget: {
      dataset: {
        field,
        index,
        itemKey: item.confirmationItemKey || item.itemKey || ''
      }
    },
    detail: { value: String(value) }
  });
}

function changeDate(page, value, field = 'dueDate') {
  page.changeDateField({
    currentTarget: { dataset: { field } },
    detail: { value: String(value) }
  });
}

function switchIntent(page, intent) {
  const index = INTENTS.indexOf(intent);
  if (index < 0) throw Object.assign(new Error(`Unsupported switch intent: ${intent}`), {
    code: 'CONTROLLED_SWITCH_INTENT_UNSUPPORTED'
  });
  page.changeIntent({ detail: { value: String(index) } });
}

function removeItem(page, index) {
  const items = page.data.fields && page.data.fields.items || [];
  const item = items[index] || {};
  page.removeConfirmItem({
    currentTarget: { dataset: { index, itemKey: item.confirmationItemKey || item.itemKey || '' } }
  });
}

function capture(page, harness) {
  const parseResult = safeClone(page.data.parseResult || {});
  const businessLog = harness.driver.evidence.businessCallLog || [];
  return {
    card: {
      confirmItems: safeClone(page.data.confirmItems || []),
      fields: safeClone(page.data.fields || {}),
      intent: String(page.data.intent || ''),
      operation: String(page.data.operation || ''),
      surfaceOriginalText: String(page.data.surfaceOriginalText || ''),
      visibility: {
        amount: page.data.showAmountField === true,
        dueDate: page.data.showDueDateField === true,
        itemList: page.data.showItemList === true,
        paymentAmount: page.data.showPaymentAmountField === true,
        product: page.data.showProductField === true,
        todoTitle: page.data.showTodoTitleField === true
      }
    },
    evidence: {
      businessCalls: safeClone(harness.driver.evidence.productionBusinessCalls || {}),
      storageCalls: safeClone(harness.driver.evidence.productionStorageCalls || {})
    },
    parseResult,
    savePayload: safeClone(businessLog.length ? businessLog[businessLog.length - 1].parseResult : null),
    state: safeClone(harness.readState())
  };
}

module.exports = {
  capture,
  changeDate,
  createDraft,
  createFixtureState,
  createHarnessForDraft,
  editField,
  editItem,
  mountDraft,
  removeItem,
  safeClone,
  switchIntent
};
