const fs = require('fs');
const path = require('path');
const { stableHash, stableSerialize } = require('../../../utils/record-state-diff');
const {
  capture,
  changeDate,
  createDraft,
  createHarnessForDraft,
  editField,
  editItem,
  mountDraft,
  removeItem,
  safeClone,
  switchIntent
} = require('./runtime');

const TAXONOMY = new Set([
  'DISPLAY_MAPPING',
  'EDIT_SYNC',
  'STALE_PARSE_RESULT',
  'TYPE_SWITCH_RESIDUE',
  'HIDDEN_FIELD_LEAK',
  'ITEM_SYNC',
  'FLATTENED_ITEM_CONFLICT',
  'AMOUNT_SYNC',
  'DATE_SYNC',
  'RELATION_LEAK',
  'ORIGINAL_TEXT_MUTATION',
  'SAVE_SOURCE_OF_TRUTH',
  'SPEC_REQUIRED',
  'TEST_INFRA'
]);

const ORDER_TEXT = '王总下单旧杯100个，每个10元，2026-08-20交货，总价1000元。';
const QUOTE_TEXT = '给王总报价旧杯100个每个10元，新杯50个每个20元，2026-08-18跟进，总价2000元。';
const RECEIVABLE_TEXT = '王总欠款1000元，2026-08-30收。';
const PAYMENT_TEXT = '王总在2026-08-15收到250元。';
const TODO_TEXT = '2026-08-20提醒我给王总回电话。';
const DUNNING_TEXT = '2026-08-20提醒我催王总付款。';
const EDIT_ORDER_TEXT = '李总下单新杯120套，每套12元，2026-08-25交货，总价1440元。';
const STALE_ROOT_TEXT = '李总下单旧杯100个，每个12元，2026-08-20交货，总价1200元。';
const STALE_ITEM_TEXT = '王总下单新杯100个，每个10元，2026-08-20交货，总价1000元。';
const MULTI_EDIT_TEXT = '给王总报价旧杯120个每个10元，饭盒60个每个20元，2026-08-18跟进，总价2400元。';
const MULTI_REBUILD_TEXT = '给王总报价新杯50个每个20元，饭盒30个每个20元，2026-08-18跟进，总价1600元。';
const AMOUNT_TEXT = '王总下单旧杯120个，每个10元，2026-08-20交货，总价1200元。';
const ORIGINAL_RECEIVABLE_TEXT = '王总欠款1200元，2026-09-02收。';
const QUOTE_DATE_TEXT = '给王总报价旧杯100个每个10元，新杯50个每个20元，2026-08-10跟进，总价2000元。';

function orderFields(overrides = {}) {
  return Object.assign({
    customerName: '王总',
    productName: '旧杯',
    quantity: '100',
    unit: '个',
    unitPrice: '10',
    priceUnit: '个',
    amount: '1000',
    totalAmount: '1000',
    calculatedAmount: '1000',
    dueDate: '2026-08-20',
    items: [{
      productName: '旧杯', spec: '', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个',
      totalAmount: '1000', itemDeliveryDate: '', itemRemark: ''
    }],
    remark: ''
  }, overrides);
}

function quotationFields(overrides = {}) {
  return Object.assign({
    customerName: '王总',
    productName: '旧杯',
    quantity: '100',
    unit: '个',
    unitPrice: '10',
    priceUnit: '个',
    amount: '2000',
    totalAmount: '2000',
    calculatedAmount: '2000',
    dueDate: '2026-08-18',
    followupDays: '3',
    quoteDate: '2026-08-15',
    items: [
      { productName: '旧杯', spec: '', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000', itemDeliveryDate: '', itemRemark: '' },
      { productName: '新杯', spec: '', quantity: '50', unit: '个', unitPrice: '20', priceUnit: '个', totalAmount: '1000', itemDeliveryDate: '', itemRemark: '' }
    ],
    remark: ''
  }, overrides);
}

function receivableFields(overrides = {}) {
  return Object.assign({ customerName: '王总', amount: '1000', dueDate: '2026-08-30', remark: '' }, overrides);
}

function paymentFields(overrides = {}) {
  return Object.assign({ customerName: '王总', amount: '250', paymentAmount: '250', paymentDate: '2026-08-15', dueDate: '2026-08-15', remark: '' }, overrides);
}

function todoFields(overrides = {}) {
  return Object.assign({ customerName: '王总', todoTitle: '给王总回电话', dueDate: '2026-08-20', remark: '' }, overrides);
}

function withQuotationConversionEvidence(controlledDraft) {
  const originalText = controlledDraft.original_text;
  const conversionText = '报价转成订单';
  const sourceText = '王总旧杯报价';
  controlledDraft.intent_evidence = {
    quotationToOrderConversionSignals: [{
      kind: 'QUOTATION_TO_ORDER_CONVERSION',
      direction: 'QUOTATION_TO_ORDER',
      explicit: true,
      confidence: 0.99,
      evidenceSource: 'LOCAL_PARSER',
      sourceField: 'ORIGINAL_TEXT',
      sourceText: conversionText,
      sourceSpan: {
        start: originalText.indexOf(conversionText),
        end: originalText.indexOf(conversionText) + conversionText.length
      }
    }]
  };
  controlledDraft.relation_references = {
    quotation: {
      entityType: 'QUOTATION',
      kind: 'EXPLICIT_QUOTATION_NAMED_REFERENCE',
      explicit: true,
      requiresResolution: true,
      sourceText,
      sourceSpan: { start: originalText.indexOf(sourceText), end: originalText.indexOf(sourceText) + sourceText.length },
      confidence: 0.97,
      normalizedReference: '王总:旧杯:QUOTATION',
      resolvedEntityId: null,
      evidenceSource: 'LOCAL_PARSER',
      sourceField: 'ORIGINAL_TEXT'
    }
  };
  return controlledDraft;
}

function compact(value) {
  if (value === undefined) return null;
  return safeClone(value);
}

function createRecorder() {
  const checks = [];
  function check(taxonomy, code, pass, expected, actual) {
    if (!TAXONOMY.has(taxonomy)) throw Object.assign(new Error(`Unknown taxonomy: ${taxonomy}`), {
      code: 'TEST_TAXONOMY_UNKNOWN'
    });
    checks.push({ taxonomy, code, pass: pass === true, expected: compact(expected), actual: compact(actual) });
  }
  return { check, checks };
}

function valueAt(root, path) {
  return String(path || '').split('.').filter(Boolean).reduce((value, part) => {
    if (value === undefined || value === null) return undefined;
    const match = /^(.*)\[(\d+)\]$/.exec(part);
    if (match) {
      const list = value[match[1]];
      return Array.isArray(list) ? list[Number(match[2])] : undefined;
    }
    return value[part];
  }, root);
}

function eq(check, taxonomy, code, actual, expected) {
  check(taxonomy, code, stableSerialize(actual) === stableSerialize(expected), expected, actual);
}

function absent(check, taxonomy, code, root, path) {
  const actual = valueAt(root, path);
  check(taxonomy, code, actual === undefined || actual === null || actual === '', 'absent', actual);
}

function fieldParity(check, snapshot, prefix = 'PARITY') {
  eq(check, 'SAVE_SOURCE_OF_TRUTH', `${prefix}.CARD_PARSE_FIELDS`, snapshot.card.fields,
    snapshot.parseResult.fields || {});
}

function latest(state, collection) {
  const list = state && state[collection];
  return Array.isArray(list) && list.length ? list[0] : null;
}

function prepareControlledLocalSave(page) {
  const current = safeClone(page.data.parseResult || {});
  current.parse_route = Object.assign({}, current.parse_route || {}, {
    decision: 'local',
    semantic_decision: 'LOCAL',
    production_route: 'LOCAL',
    client_route: 'FAST_LOCAL',
    deep_review_available: false,
    autoDeep: false,
    reasons: []
  });
  current.ai_fallback = {
    attempted: false,
    business_result_valid: false,
    needed: false,
    provider_kind: 'NONE',
    status: 'not_requested'
  };
  current.local_parse_safety = Object.assign({}, current.local_parse_safety || {}, {
    status: 'SAFE_LOCAL',
    reason_codes: [],
    reason_texts: []
  });
  current.formal_save_blocked = false;
  const noSemanticBlockers = !(page.data.preflightBlockingReasons || []).length
    && !(current.missing_fields || []).length
    && !(current.low_confidence_fields || []).length
    && !(current.field_conflicts || []).length
    && current.formal_save_blocked !== true;
  page.setData({
    activeQuestion: null,
    assistantQuestionState: 'READY',
    assistantQuestions: [],
    conversationPhase: 'CONFIRMING',
    parseResult: current,
    // A field edit can reroute a controlled Draft to ASK_USER even when its
    // final semantic state has no blocker. This suite isolates the downstream
    // Confirmation -> Business -> Storage contract, so restore only that
    // route-owned UI bit. saveFormal and Business still rebuild and re-run
    // final safety/domain preflight against the exact confirmed fields.
    disableFormalSave: noSemanticBlockers ? false : page.data.disableFormalSave
  });
}

function formalSave(page, harness) {
  prepareControlledLocalSave(page);
  page.saveFormal();
  return capture(page, harness);
}

function pendingSave(page, harness) {
  page.savePending();
  return capture(page, harness);
}

function assertFormalReached(check, after, taxonomy, code) {
  eq(check, taxonomy, code, after.evidence.businessCalls.saveConfirmedDraft, 1);
}

function draft(options) {
  return createDraft(options);
}

function runDraftOrder(page, harness, check) {
  const mounted = capture(page, harness);
  eq(check, 'DISPLAY_MAPPING', 'ORDER.CUSTOMER', mounted.card.fields.customerName, '王总');
  eq(check, 'DISPLAY_MAPPING', 'ORDER.ITEM', mounted.card.confirmItems[0] && mounted.card.confirmItems[0].productName, '旧杯');
  eq(check, 'DISPLAY_MAPPING', 'ORDER.DATE', mounted.card.fields.dueDate, '2026-08-20');
  eq(check, 'DISPLAY_MAPPING', 'ORDER.ITEM_LIST_VISIBLE', mounted.card.visibility.itemList, true);
  fieldParity(check, mounted, 'ORDER');
}

function runDraftQuotationMulti(page, harness, check) {
  const mounted = capture(page, harness);
  eq(check, 'DISPLAY_MAPPING', 'QUOTE.ITEM_COUNT', mounted.card.confirmItems.length, 2);
  eq(check, 'DISPLAY_MAPPING', 'QUOTE.ITEM2', mounted.card.confirmItems[1] && mounted.card.confirmItems[1].productName, '新杯');
  eq(check, 'DISPLAY_MAPPING', 'QUOTE.TOTAL', mounted.card.fields.amount, '2000');
  eq(check, 'DISPLAY_MAPPING', 'QUOTE.ORIGINAL', mounted.card.surfaceOriginalText, QUOTE_TEXT);
  fieldParity(check, mounted, 'QUOTE');
}

function runDraftReceivable(page, harness, check) {
  const mounted = capture(page, harness);
  eq(check, 'DISPLAY_MAPPING', 'RECEIVABLE.AMOUNT_VISIBLE', mounted.card.visibility.amount, true);
  eq(check, 'DISPLAY_MAPPING', 'RECEIVABLE.AMOUNT', mounted.card.fields.amount, '1000');
  eq(check, 'DISPLAY_MAPPING', 'RECEIVABLE.DATE', mounted.card.fields.dueDate, '2026-08-30');
  fieldParity(check, mounted, 'RECEIVABLE');
}

function runDraftPayment(page, harness, check) {
  const mounted = capture(page, harness);
  eq(check, 'DISPLAY_MAPPING', 'PAYMENT.AMOUNT_VISIBLE', mounted.card.visibility.paymentAmount, true);
  eq(check, 'DISPLAY_MAPPING', 'PAYMENT.DATE_VISIBLE', mounted.card.visibility.dueDate, true);
  eq(check, 'DISPLAY_MAPPING', 'PAYMENT.AMOUNT', mounted.card.fields.paymentAmount, '250');
  eq(check, 'DISPLAY_MAPPING', 'PAYMENT.DATE', mounted.card.fields.paymentDate || mounted.card.fields.dueDate, '2026-08-15');
  fieldParity(check, mounted, 'PAYMENT');
}

function runDraftDunning(page, harness, check) {
  const mounted = capture(page, harness);
  eq(check, 'DISPLAY_MAPPING', 'DUNNING.TITLE_VISIBLE', mounted.card.visibility.todoTitle, true);
  eq(check, 'DISPLAY_MAPPING', 'DUNNING.TODO_TYPE', mounted.card.fields.todoType, 'dunning');
  eq(check, 'DISPLAY_MAPPING', 'DUNNING.DATE', mounted.card.fields.dueDate, '2026-08-20');
  fieldParity(check, mounted, 'DUNNING');
}

function runEditOrderAll(page, harness, check) {
  editField(page, 'customerName', '李总');
  editItem(page, 0, 'productName', '新杯');
  editItem(page, 0, 'quantity', '120');
  editItem(page, 0, 'unit', '套');
  editItem(page, 0, 'priceUnit', '套');
  editItem(page, 0, 'unitPrice', '12');
  editField(page, 'amount', '1440');
  changeDate(page, '2026-08-25');
  const before = capture(page, harness);
  fieldParity(check, before, 'EDIT_ORDER');
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'EDIT_SYNC', 'EDIT_ORDER.FORMAL_SAVE_REACHED');
  const payload = after.savePayload || {};
  const order = latest(after.state, 'orders') || {};
  eq(check, 'EDIT_SYNC', 'EDIT_ORDER.PAYLOAD_CUSTOMER', valueAt(payload, 'fields.customerName'), '李总');
  eq(check, 'EDIT_SYNC', 'EDIT_ORDER.PAYLOAD_ITEM', valueAt(payload, 'fields.items[0].productName'), '新杯');
  eq(check, 'EDIT_SYNC', 'EDIT_ORDER.PAYLOAD_QUANTITY', valueAt(payload, 'fields.items[0].quantity'), '120');
  eq(check, 'EDIT_SYNC', 'EDIT_ORDER.PAYLOAD_UNIT', valueAt(payload, 'fields.items[0].unit'), '套');
  eq(check, 'EDIT_SYNC', 'EDIT_ORDER.PAYLOAD_PRICE', valueAt(payload, 'fields.items[0].unitPrice'), '12');
  eq(check, 'AMOUNT_SYNC', 'EDIT_ORDER.STORAGE_AMOUNT', order.totalAmount, '1440');
  eq(check, 'DATE_SYNC', 'EDIT_ORDER.STORAGE_DATE', order.requiredDeliveryDate, '2026-08-25');
  check('EDIT_SYNC', 'EDIT_ORDER.OLD_VALUES_GONE', order.productName !== '旧杯' && String(order.quantity) !== '100',
    'old item facts absent', { productName: order.productName, quantity: order.quantity });
}

function runEditReceivable(page, harness, check) {
  editField(page, 'amount', '1200');
  changeDate(page, '2026-09-02');
  const before = capture(page, harness);
  fieldParity(check, before, 'EDIT_RECEIVABLE');
  const after = formalSave(page, harness);
  const rec = latest(after.state, 'receivables') || {};
  eq(check, 'AMOUNT_SYNC', 'EDIT_RECEIVABLE.AMOUNT', rec.amount, '1200');
  eq(check, 'DATE_SYNC', 'EDIT_RECEIVABLE.DATE', rec.dueDate, '2026-09-02');
  check('EDIT_SYNC', 'EDIT_RECEIVABLE.OLD_GONE', rec.amount !== '1000' && rec.dueDate !== '2026-08-30', true,
    { amount: rec.amount, dueDate: rec.dueDate });
}

function runEditPayment(page, harness, check) {
  editField(page, 'paymentAmount', '300');
  changeDate(page, '2026-08-16');
  const before = capture(page, harness);
  fieldParity(check, before, 'EDIT_PAYMENT');
  const after = formalSave(page, harness);
  const payment = latest(after.state, 'paymentRecords') || {};
  eq(check, 'AMOUNT_SYNC', 'EDIT_PAYMENT.AMOUNT', payment.amount, '300');
  eq(check, 'DATE_SYNC', 'EDIT_PAYMENT.DATE', payment.paidAt, '2026-08-16');
}

function runEditTodo(page, harness, check) {
  editField(page, 'todoTitle', '给李总回电话');
  changeDate(page, '2026-08-22');
  const before = capture(page, harness);
  fieldParity(check, before, 'EDIT_TODO');
  const after = formalSave(page, harness);
  const todo = latest(after.state, 'todos') || {};
  eq(check, 'EDIT_SYNC', 'EDIT_TODO.TITLE', todo.title, '给李总回电话');
  eq(check, 'DATE_SYNC', 'EDIT_TODO.DATE', todo.remindDate, '2026-08-22');
}

function runStaleRoot(page, harness, check) {
  const stale = safeClone(page.data.parseResult);
  editField(page, 'customerName', '李总');
  editItem(page, 0, 'unitPrice', '12');
  editField(page, 'amount', '1200');
  page.data.parseResult.fields = stale.fields;
  const before = capture(page, harness);
  check('STALE_PARSE_RESULT', 'STALE_ROOT.SETUP', before.card.fields.customerName === '李总'
    && before.parseResult.fields.customerName === '王总', 'card new / parse old', {
    card: before.card.fields.customerName, parse: before.parseResult.fields.customerName
  });
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'STALE_PARSE_RESULT', 'STALE_ROOT.FORMAL_SAVE_REACHED');
  const payload = after.savePayload || {};
  const order = latest(after.state, 'orders') || {};
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'STALE_ROOT.PAYLOAD_CUSTOMER', valueAt(payload, 'fields.customerName'), '李总');
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'STALE_ROOT.PAYLOAD_AMOUNT', valueAt(payload, 'fields.amount'), '1200');
  eq(check, 'STALE_PARSE_RESULT', 'STALE_ROOT.STORAGE_AMOUNT', order.totalAmount, '1200');
}

function runStaleItem(page, harness, check) {
  const stale = safeClone(page.data.parseResult);
  editItem(page, 0, 'productName', '新杯');
  page.data.parseResult.fields = stale.fields;
  const before = capture(page, harness);
  check('STALE_PARSE_RESULT', 'STALE_ITEM.SETUP', valueAt(before.card, 'fields.items[0].productName') === '新杯'
    && valueAt(before.parseResult, 'fields.items[0].productName') === '旧杯', 'card new / parse old', {
    card: valueAt(before.card, 'fields.items[0].productName'), parse: valueAt(before.parseResult, 'fields.items[0].productName')
  });
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'STALE_PARSE_RESULT', 'STALE_ITEM.FORMAL_SAVE_REACHED');
  const order = latest(after.state, 'orders') || {};
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'STALE_ITEM.PAYLOAD_PRODUCT', valueAt(after.savePayload, 'fields.items[0].productName'), '新杯');
  eq(check, 'ITEM_SYNC', 'STALE_ITEM.STORAGE_PRODUCT', valueAt(order, 'items[0].productName'), '新杯');
  eq(check, 'ITEM_SYNC', 'STALE_ITEM.STORAGE_QUANTITY', valueAt(order, 'items[0].quantity'), '100');
}

function runStalePayment(page, harness, check) {
  const stale = safeClone(page.data.parseResult);
  editField(page, 'paymentAmount', '300');
  changeDate(page, '2026-08-16');
  page.data.parseResult.fields = stale.fields;
  const after = formalSave(page, harness);
  const payment = latest(after.state, 'paymentRecords') || {};
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'STALE_PAYMENT.PAYLOAD_AMOUNT', valueAt(after.savePayload, 'fields.paymentAmount'), '300');
  eq(check, 'STALE_PARSE_RESULT', 'STALE_PAYMENT.STORAGE_AMOUNT', payment.amount, '300');
  eq(check, 'STALE_PARSE_RESULT', 'STALE_PAYMENT.STORAGE_DATE', payment.paidAt, '2026-08-16');
}

function switchAndCapture(page, harness, intent) {
  switchIntent(page, intent);
  return capture(page, harness);
}

function runSwitchQuotationOrder(page, harness, check) {
  const switched = switchAndCapture(page, harness, 'order');
  eq(check, 'TYPE_SWITCH_RESIDUE', 'QO.INTENT', switched.card.intent, 'order');
  absent(check, 'TYPE_SWITCH_RESIDUE', 'QO.FOLLOWUP_DAYS_CLEARED', switched.parseResult, 'fields.followupDays');
  absent(check, 'DATE_SYNC', 'QO.QUOTE_DATE_CLEARED', switched.parseResult, 'fields.quoteDate');
  absent(check, 'DATE_SYNC', 'QO.FOLLOWUP_DATE_NOT_REUSED', switched.parseResult, 'fields.dueDate');
}

function runSwitchOrderQuotation(page, harness, check) {
  const switched = switchAndCapture(page, harness, 'quotation');
  eq(check, 'TYPE_SWITCH_RESIDUE', 'OQ.INTENT', switched.card.intent, 'quotation');
  absent(check, 'DATE_SYNC', 'OQ.DELIVERY_NOT_REUSED', switched.parseResult, 'fields.dueDate');
  absent(check, 'HIDDEN_FIELD_LEAK', 'OQ.DEPOSIT_CLEARED', switched.parseResult, 'fields.depositAmount');
}

function runSwitchOrderReceivable(page, harness, check) {
  const switched = switchAndCapture(page, harness, 'receivable');
  eq(check, 'TYPE_SWITCH_RESIDUE', 'OR.INTENT', switched.card.intent, 'receivable');
  absent(check, 'HIDDEN_FIELD_LEAK', 'OR.ITEMS_CLEARED', switched.parseResult, 'fields.items');
  absent(check, 'HIDDEN_FIELD_LEAK', 'OR.PRODUCT_CLEARED', switched.parseResult, 'fields.productName');
  absent(check, 'AMOUNT_SYNC', 'OR.ORDER_TOTAL_NOT_REUSED', switched.parseResult, 'fields.amount');
  absent(check, 'DATE_SYNC', 'OR.ORDER_DATE_NOT_REUSED', switched.parseResult, 'fields.dueDate');
}

function runSwitchReceivablePayment(page, harness, check) {
  const switched = switchAndCapture(page, harness, 'payment');
  eq(check, 'TYPE_SWITCH_RESIDUE', 'RP.INTENT', switched.card.intent, 'payment');
  absent(check, 'AMOUNT_SYNC', 'RP.RECEIVABLE_AMOUNT_NOT_REUSED', switched.parseResult, 'fields.paymentAmount');
  absent(check, 'DATE_SYNC', 'RP.DUE_DATE_NOT_REUSED', switched.parseResult, 'fields.paymentDate');
}

function runSwitchTodoDunning(page, harness, check) {
  const switched = switchAndCapture(page, harness, 'dunning');
  eq(check, 'TYPE_SWITCH_RESIDUE', 'TD.TODO_TYPE', switched.parseResult.fields.todoType, 'dunning');
  eq(check, 'EDIT_SYNC', 'TD.TITLE_PRESERVED', switched.card.fields.todoTitle, '给王总回电话');
}

function runSwitchDunningTodo(page, harness, check) {
  const switched = switchAndCapture(page, harness, 'todo');
  absent(check, 'TYPE_SWITCH_RESIDUE', 'DT.TODO_TYPE_CLEARED', switched.parseResult, 'fields.todoType');
  const after = formalSave(page, harness);
  const todo = latest(after.state, 'todos') || {};
  absent(check, 'HIDDEN_FIELD_LEAK', 'DT.STORAGE_NOT_DUNNING', todo, 'todoType');
}

function runFormalPending(page, harness, check) {
  editField(page, 'amount', '1200');
  const after = pendingSave(page, harness);
  const note = latest(after.state, 'pendingNotes') || {};
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'PENDING.GUESSED_AMOUNT', valueAt(note, 'guessedFields.amount'), '1200');
  eq(check, 'ORIGINAL_TEXT_MUTATION', 'PENDING.ORIGINAL', note.originalText, RECEIVABLE_TEXT);
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'PENDING.NO_FORMAL_ORDER', (after.state.orders || []).length, 0);
}

function runHiddenRelationPaymentTodo(page, harness, check) {
  switchIntent(page, 'todo');
  const switched = capture(page, harness);
  absent(check, 'RELATION_LEAK', 'HIDDEN.RECEIVABLE_CLEARED', switched.parseResult, 'fields.receivableId');
  absent(check, 'HIDDEN_FIELD_LEAK', 'HIDDEN.PAYMENT_AMOUNT_CLEARED', switched.parseResult, 'fields.paymentAmount');
  const after = formalSave(page, harness);
  const todo = latest(after.state, 'todos') || {};
  absent(check, 'RELATION_LEAK', 'HIDDEN.STORAGE_RECEIVABLE_ABSENT', todo, 'receivableId');
}

function runMultiEditIsolation(page, harness, check) {
  editItem(page, 0, 'quantity', '120');
  editItem(page, 1, 'productName', '饭盒');
  editItem(page, 1, 'quantity', '60');
  const before = capture(page, harness);
  eq(check, 'ITEM_SYNC', 'MULTI.ITEM1_QUANTITY', valueAt(before.card, 'fields.items[0].quantity'), '120');
  eq(check, 'ITEM_SYNC', 'MULTI.ITEM2_PRODUCT', valueAt(before.card, 'fields.items[1].productName'), '饭盒');
  eq(check, 'ITEM_SYNC', 'MULTI.ITEM2_QUANTITY', valueAt(before.card, 'fields.items[1].quantity'), '60');
  eq(check, 'FLATTENED_ITEM_CONFLICT', 'MULTI.TOP_PRODUCT_ITEM1', before.card.fields.productName, '旧杯');
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'ITEM_SYNC', 'MULTI.FORMAL_SAVE_REACHED');
  const quote = latest(after.state, 'quotations') || {};
  eq(check, 'ITEM_SYNC', 'MULTI.STORAGE_COUNT', (quote.items || []).length, 2);
  eq(check, 'ITEM_SYNC', 'MULTI.STORAGE_ITEM2', valueAt(quote, 'items[1].productName'), '饭盒');
}

function runMultiRemoveAdd(page, harness, check) {
  removeItem(page, 0);
  let snapshot = capture(page, harness);
  eq(check, 'ITEM_SYNC', 'REMOVE.COUNT', snapshot.card.fields.items.length, 1);
  eq(check, 'FLATTENED_ITEM_CONFLICT', 'REMOVE.NEW_FIRST', snapshot.card.fields.productName, '新杯');
  page.addConfirmItem();
  editItem(page, 1, 'productName', '饭盒');
  editItem(page, 1, 'quantity', '30');
  snapshot = capture(page, harness);
  eq(check, 'ITEM_SYNC', 'ADD.COUNT', snapshot.card.fields.items.length, 2);
  eq(check, 'ITEM_SYNC', 'ADD.ITEM2', valueAt(snapshot.card, 'fields.items[1].productName'), '饭盒');
  check('ITEM_SYNC', 'ADD.REMOVED_ITEM_RISK_CLEARED',
    !(snapshot.parseResult.low_confidence_fields || []).includes('productName'),
    'removed/replaced item does not retain productName risk',
    snapshot.parseResult.low_confidence_fields || []);
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'ITEM_SYNC', 'ADD.FORMAL_SAVE_REACHED');
  const quote = latest(after.state, 'quotations') || {};
  eq(check, 'ITEM_SYNC', 'ADD.STORAGE_COUNT', (quote.items || []).length, 2);
}

function runFlattenedConflict(page, harness, check) {
  const snapshot = capture(page, harness);
  eq(check, 'FLATTENED_ITEM_CONFLICT', 'FLAT.ITEMS_WIN_PRODUCT', snapshot.card.fields.productName, '旧杯');
  eq(check, 'FLATTENED_ITEM_CONFLICT', 'FLAT.ITEMS_WIN_QUANTITY', snapshot.card.fields.quantity, '100');
  eq(check, 'FLATTENED_ITEM_CONFLICT', 'FLAT.PARSE_SYNC', valueAt(snapshot.parseResult, 'fields.productName'), '旧杯');
}

function runAmountSemantics(page, harness, check) {
  editItem(page, 0, 'quantity', '120');
  const snapshot = capture(page, harness);
  eq(check, 'AMOUNT_SYNC', 'AMOUNT.DETERMINISTIC_ITEM_TOTAL', valueAt(snapshot.card, 'fields.items[0].totalAmount'), '1200');
  eq(check, 'AMOUNT_SYNC', 'AMOUNT.DETERMINISTIC_ROOT_TOTAL', snapshot.card.fields.amount, '1200');
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'AMOUNT.PARSE_TOTAL', valueAt(snapshot.parseResult, 'fields.amount'), '1200');
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'AMOUNT_SYNC', 'AMOUNT.FORMAL_SAVE_REACHED');
  const order = latest(after.state, 'orders') || {};
  eq(check, 'AMOUNT_SYNC', 'AMOUNT.STORAGE_TOTAL', order.totalAmount, '1200');
}

function runDateSemantics(page, harness, check) {
  changeDate(page, '2026-08-25');
  const after = formalSave(page, harness);
  const order = latest(after.state, 'orders') || {};
  eq(check, 'DATE_SYNC', 'DATE.ORDER_CARD', valueAt(after.savePayload, 'fields.dueDate'), '2026-08-25');
  eq(check, 'DATE_SYNC', 'DATE.ORDER_STORAGE', order.requiredDeliveryDate, '2026-08-25');
  eq(check, 'DATE_SYNC', 'DATE.ORDER_EXPECTED_SHIP', order.expectedShipDate, '2026-08-25');
}

function runDepositAliasEdit(page, harness, check) {
  editField(page, 'paymentAmount', '300');
  const snapshot = capture(page, harness);
  eq(check, 'AMOUNT_SYNC', 'DEPOSIT.CARD_PAYMENT', snapshot.card.fields.paymentAmount, '300');
  eq(check, 'AMOUNT_SYNC', 'DEPOSIT.CANONICAL_ALIAS', snapshot.card.fields.depositAmount, '300');
  const after = formalSave(page, harness);
  const payment = latest(after.state, 'paymentRecords') || {};
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'DEPOSIT.PAYLOAD_ALIAS', valueAt(after.savePayload, 'fields.depositAmount'), '300');
  eq(check, 'AMOUNT_SYNC', 'DEPOSIT.STORAGE_PAYMENT', payment.amount, '300');
}

function runQuotationRootTotal(page, harness, check) {
  editItem(page, 1, 'unitPrice', '30');
  const snapshot = capture(page, harness);
  const itemTotal = Number(valueAt(snapshot.card, 'fields.items[0].totalAmount') || 0)
    + Number(valueAt(snapshot.card, 'fields.items[1].totalAmount') || 0);
  eq(check, 'AMOUNT_SYNC', 'QUOTE_TOTAL.ITEM_SUM', String(itemTotal), '2500');
  check('FLATTENED_ITEM_CONFLICT', 'QUOTE_TOTAL.ROOT_SYNC_OR_BLOCK',
    String(snapshot.card.fields.amount || '') === '2500' || page.data.disableFormalSave === true,
    'root total 2500 or formal blocked', {
      disableFormalSave: page.data.disableFormalSave,
      rootAmount: snapshot.card.fields.amount
    });
  check('DISPLAY_MAPPING', 'QUOTE_TOTAL.CONTROL_VISIBLE',
    page.data.showOrderAmountSummary === true || page.data.showAmountField === true,
    'visible root total confirmation control', {
      showAmountField: page.data.showAmountField,
      showOrderAmountSummary: page.data.showOrderAmountSummary
    });
}

function runItemMetaEditability(page, harness, check) {
  const wxml = fs.readFileSync(path.join(__dirname, '../../../pages/input/input.wxml'), 'utf8');
  check('DISPLAY_MAPPING', 'ITEM_META.DELIVERY_EDITABLE',
    /data-field=["']itemDeliveryDate["'][^>]*bind(?:input|change)=/.test(wxml),
    'editable itemDeliveryDate control', 'read-only or absent');
  check('DISPLAY_MAPPING', 'ITEM_META.REMARK_EDITABLE',
    /data-field=["']itemRemark["'][^>]*bind(?:input|change)=/.test(wxml),
    'editable itemRemark control', 'read-only or absent');
}

function runHiddenQuotationFields(page, harness, check) {
  const snapshot = capture(page, harness);
  absent(check, 'HIDDEN_FIELD_LEAK', 'HIDDEN_QUOTE.VALID_UNTIL', snapshot.parseResult, 'fields.validUntil');
  absent(check, 'HIDDEN_FIELD_LEAK', 'HIDDEN_QUOTE.PAYMENT_METHOD', snapshot.parseResult, 'fields.paymentMethod');
  const after = formalSave(page, harness);
  const quote = latest(after.state, 'quotations') || {};
  absent(check, 'HIDDEN_FIELD_LEAK', 'HIDDEN_QUOTE.STORAGE_VALID_UNTIL', quote, 'validUntil');
  absent(check, 'HIDDEN_FIELD_LEAK', 'HIDDEN_QUOTE.STORAGE_PAYMENT_METHOD', quote, 'paymentMethod');
}

function runExplicitHiddenQuotationField(page, harness, check, field, code) {
  const snapshot = capture(page, harness);
  absent(check, 'HIDDEN_FIELD_LEAK', `HIDDEN_QUOTE.${code}_PROJECTED`, snapshot.parseResult, `fields.${field}`);
  eq(check, 'HIDDEN_FIELD_LEAK', `HIDDEN_QUOTE.${code}_CONTROL_REQUIRED`, page.data.disableFormalSave, true);
  eq(check, 'HIDDEN_FIELD_LEAK', `HIDDEN_QUOTE.${code}_PENDING_AVAILABLE`, page.data.showPendingButton, true);
  check('HIDDEN_FIELD_LEAK', `HIDDEN_QUOTE.${code}_BLOCK_REASON`,
    (page.data.preflightBlockingReasons || []).includes('LOW_CONFIDENCE_FIELD'),
    'LOW_CONFIDENCE_FIELD', page.data.preflightBlockingReasons || []);
  const beforeCollectionCounts = {
    customers: (snapshot.state.customers || []).length,
    quotations: (snapshot.state.quotations || []).length
  };
  const after = formalSave(page, harness);
  eq(check, 'HIDDEN_FIELD_LEAK', `HIDDEN_QUOTE.${code}_NO_BUSINESS_SAVE`,
    after.evidence.businessCalls.saveConfirmedDraft || 0, 0);
  eq(check, 'HIDDEN_FIELD_LEAK', `HIDDEN_QUOTE.${code}_NO_STORAGE_MUTATION`,
    {
      customers: (after.state.customers || []).length,
      quotations: (after.state.quotations || []).length
    }, beforeCollectionCounts);
}

function runExplicitHiddenValidUntil(page, harness, check) {
  runExplicitHiddenQuotationField(page, harness, check, 'validUntil', 'EXPLICIT_VALID_UNTIL');
}

function runExplicitHiddenPaymentMethod(page, harness, check) {
  runExplicitHiddenQuotationField(page, harness, check, 'paymentMethod', 'EXPLICIT_PAYMENT_METHOD');
}

function runQuotationAuthorityPositive(page, harness, check) {
  const before = capture(page, harness);
  eq(check, 'DISPLAY_MAPPING', 'QUOTE_AUTH.CUSTOMER_VISIBLE', page.data.showCustomerFields, true);
  eq(check, 'DISPLAY_MAPPING', 'QUOTE_AUTH.ITEMS_VISIBLE', page.data.showItemList, true);
  eq(check, 'DISPLAY_MAPPING', 'QUOTE_AUTH.FOLLOWUP_VISIBLE', page.data.showFollowupDaysField, true);
  eq(check, 'DISPLAY_MAPPING', 'QUOTE_AUTH.REMARK_VISIBLE', page.data.showRemarkField, true);
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.DERIVED_TOTAL_BEFORE', before.card.fields.totalAmount, '2000');
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.FORMAL_SAVE_REACHED');
  const quote = latest(after.state, 'quotations') || {};
  const customer = (after.state.customers || []).find((item) => item.id === quote.customerId) || {};
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.STORAGE_CUSTOMER', customer.name, '王总');
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.STORAGE_ITEM_COUNT', (quote.items || []).length, 2);
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.STORAGE_ITEM1_QUANTITY', valueAt(quote, 'items[0].quantity'), '100');
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.STORAGE_ITEM2_PRICE', valueAt(quote, 'items[1].unitPrice'), '20');
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.STORAGE_DERIVED_TOTAL', quote.totalAmount, '2000');
  eq(check, 'DATE_SYNC', 'QUOTE_AUTH.STORAGE_BUSINESS_DATE', quote.quoteDate, '2026-08-15');
  eq(check, 'DATE_SYNC', 'QUOTE_AUTH.STORAGE_FOLLOWUP_DATE', quote.deliveryDate, before.card.fields.dueDate);
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'QUOTE_AUTH.STORAGE_REMARK', quote.remark, '备注A12');
  eq(check, 'ORIGINAL_TEXT_MUTATION', 'QUOTE_AUTH.STORAGE_ORIGINAL', quote.originalText, QUOTE_TEXT);
}

function runDateQuotation(page, harness, check) {
  page.changeFollowupDays({ detail: { value: '4' } });
  const snapshot = capture(page, harness);
  eq(check, 'DATE_SYNC', 'DATE_QUOTE.DAYS', snapshot.card.fields.followupDays, '5');
  eq(check, 'DATE_SYNC', 'DATE_QUOTE.CARD', snapshot.card.fields.dueDate, '2026-08-10');
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'DATE_SYNC', 'DATE_QUOTE.FORMAL_SAVE_REACHED');
  const quote = latest(after.state, 'quotations') || {};
  eq(check, 'DATE_SYNC', 'DATE_QUOTE.STORAGE', quote.deliveryDate, '2026-08-10');
}

function runDateReceivable(page, harness, check) {
  changeDate(page, '2026-09-02');
  const after = formalSave(page, harness);
  const rec = latest(after.state, 'receivables') || {};
  eq(check, 'DATE_SYNC', 'DATE_RECEIVABLE.PAYLOAD', valueAt(after.savePayload, 'fields.dueDate'), '2026-09-02');
  eq(check, 'DATE_SYNC', 'DATE_RECEIVABLE.STORAGE', rec.dueDate, '2026-09-02');
}

function runDatePayment(page, harness, check) {
  changeDate(page, '2026-08-16');
  const after = formalSave(page, harness);
  const payment = latest(after.state, 'paymentRecords') || {};
  eq(check, 'DATE_SYNC', 'DATE_PAYMENT.PAYLOAD', valueAt(after.savePayload, 'fields.paymentDate'), '2026-08-16');
  eq(check, 'DATE_SYNC', 'DATE_PAYMENT.STORAGE', payment.paidAt, '2026-08-16');
}

function runDateTodo(page, harness, check) {
  changeDate(page, '2026-08-22');
  const after = formalSave(page, harness);
  const todo = latest(after.state, 'todos') || {};
  eq(check, 'DATE_SYNC', 'DATE_TODO.PAYLOAD', valueAt(after.savePayload, 'fields.dueDate'), '2026-08-22');
  eq(check, 'DATE_SYNC', 'DATE_TODO.STORAGE', todo.remindDate, '2026-08-22');
}

function runPaymentRemainingAmount(page, harness, check) {
  editField(page, 'remainingAmount', '800');
  const snapshot = capture(page, harness);
  eq(check, 'AMOUNT_SYNC', 'REMAINING.CARD_PAYMENT', snapshot.card.fields.paymentAmount, '250');
  eq(check, 'AMOUNT_SYNC', 'REMAINING.CARD_REMAINING', snapshot.card.fields.remainingAmount, '800');
  eq(check, 'AMOUNT_SYNC', 'REMAINING.DERIVED_TOTAL', snapshot.card.fields.amount, '1050');
  const after = formalSave(page, harness);
  const rec = latest(after.state, 'receivables') || {};
  const payment = latest(after.state, 'paymentRecords') || {};
  eq(check, 'AMOUNT_SYNC', 'REMAINING.STORAGE_TOTAL', rec.amount, '1050');
  eq(check, 'AMOUNT_SYNC', 'REMAINING.STORAGE_PAYMENT', payment.amount, '250');
}

function runQuotationRelationIntegrity(page, harness, check) {
  let snapshot = capture(page, harness);
  absent(check, 'RELATION_LEAK', 'QUOTE_REL.UNCONFIRMED_ID_REJECTED', snapshot.parseResult, 'fields.quotationId');
  const index = (page.data.quotationOptions || []).findIndex((item) => item.id === 'quo-csi-open');
  check('RELATION_LEAK', 'QUOTE_REL.OPTION_EXISTS', index >= 0, 'quo-csi-open option',
    (page.data.quotationOptions || []).map((item) => item.id));
  const accepted = index >= 0 && page.changeQuotation({ detail: { value: String(index) } });
  eq(check, 'RELATION_LEAK', 'QUOTE_REL.PICKER_ACCEPTED', accepted, true);
  snapshot = capture(page, harness);
  eq(check, 'RELATION_LEAK', 'QUOTE_REL.CONFIRMED_ID', snapshot.card.fields.quotationId, 'quo-csi-open');
  eq(check, 'RELATION_LEAK', 'QUOTE_REL.CONFIRMED_FLAG', snapshot.card.fields.quotationSelectionConfirmed, true);
  editField(page, 'customerName', '李总');
  const edited = capture(page, harness);
  absent(check, 'RELATION_LEAK', 'QUOTE_REL.CUSTOMER_EDIT_CLEARS_ID', edited.parseResult, 'fields.quotationId');
  absent(check, 'RELATION_LEAK', 'QUOTE_REL.CUSTOMER_EDIT_CLEARS_FLAG', edited.parseResult, 'fields.quotationSelectionConfirmed');
}

function runOrderRelationSwitch(page, harness, check) {
  switchIntent(page, 'order');
  const snapshot = capture(page, harness);
  eq(check, 'TYPE_SWITCH_RESIDUE', 'ORDER_REL.CREATE_NOT_UPDATE', snapshot.card.operation, 'create_order');
  absent(check, 'RELATION_LEAK', 'ORDER_REL.ORDER_ID_CLEARED', snapshot.parseResult, 'fields.orderId');
  absent(check, 'AMOUNT_SYNC', 'ORDER_REL.RECEIVABLE_AMOUNT_CLEARED', snapshot.parseResult, 'fields.amount');
  absent(check, 'DATE_SYNC', 'ORDER_REL.RECEIVABLE_DATE_CLEARED', snapshot.parseResult, 'fields.dueDate');
}

function runRelationIntegrity(page, harness, check) {
  const options = page.data.receivableOptions || [];
  const index = options.findIndex((item) => item.id === 'rec-csi-open');
  check('RELATION_LEAK', 'REL.OPTION_EXISTS', index >= 0, 'rec-csi-open option', options.map((item) => item.id));
  if (index >= 0) page.changeReceivable({ detail: { value: String(index) } });
  let snapshot = capture(page, harness);
  eq(check, 'RELATION_LEAK', 'REL.EXPLICIT_ID', snapshot.card.fields.receivableId, 'rec-csi-open');
  eq(check, 'RELATION_LEAK', 'REL.EXPLICIT_CONFIRM', snapshot.card.fields.receivableSelectionConfirmed, true);
  editField(page, 'customerName', '李总');
  snapshot = capture(page, harness);
  absent(check, 'RELATION_LEAK', 'REL.CUSTOMER_EDIT_CLEARS_ID', snapshot.parseResult, 'fields.receivableId');
  absent(check, 'RELATION_LEAK', 'REL.CUSTOMER_EDIT_CLEARS_CONFIRM', snapshot.parseResult, 'fields.receivableSelectionConfirmed');
}

function runOriginalFormal(page, harness, check) {
  editField(page, 'amount', '1200');
  changeDate(page, '2026-09-02');
  const after = formalSave(page, harness);
  assertFormalReached(check, after, 'ORIGINAL_TEXT_MUTATION', 'ORIGINAL.FORMAL_SAVE_REACHED');
  const receivable = latest(after.state, 'receivables') || {};
  eq(check, 'ORIGINAL_TEXT_MUTATION', 'ORIGINAL.PAYLOAD', after.savePayload && after.savePayload.original_text, ORIGINAL_RECEIVABLE_TEXT);
  eq(check, 'ORIGINAL_TEXT_MUTATION', 'ORIGINAL.STORAGE', receivable.originalText, ORIGINAL_RECEIVABLE_TEXT);
}

function runOriginalPending(page, harness, check) {
  editField(page, 'amount', '1200');
  const after = pendingSave(page, harness);
  const note = latest(after.state, 'pendingNotes') || {};
  eq(check, 'ORIGINAL_TEXT_MUTATION', 'ORIGINAL_PENDING.STORAGE', note.originalText, RECEIVABLE_TEXT);
  eq(check, 'SAVE_SOURCE_OF_TRUTH', 'ORIGINAL_PENDING.EDIT', valueAt(note, 'guessedFields.amount'), '1200');
}

function runSpecObservation(page, harness, check, code) {
  const snapshot = capture(page, harness);
  check('SPEC_REQUIRED', code, true, 'product decision intentionally unresolved', {
    disableFormalSave: page.data.disableFormalSave,
    domainBlocking: page.data.preflightBlockingReasons || [],
    fields: snapshot.card.fields
  });
}

function runSpecSparseQuotation(page, harness, check) {
  const snapshot = capture(page, harness);
  absent(check, 'AMOUNT_SYNC', 'SPEC.SPARSE_QUOTATION.NO_INVENTED_AMOUNT', snapshot.parseResult, 'fields.amount');
  runSpecObservation(page, harness, check, 'SPEC.SPARSE_QUOTATION');
}

function runSpecSparseOrder(page, harness, check) {
  const snapshot = capture(page, harness);
  absent(check, 'AMOUNT_SYNC', 'SPEC.SPARSE_ORDER.NO_INVENTED_AMOUNT', snapshot.parseResult, 'fields.amount');
  runSpecObservation(page, harness, check, 'SPEC.SPARSE_ORDER');
}

const SCENARIOS = {
  draft_order: runDraftOrder,
  draft_quotation_multi: runDraftQuotationMulti,
  draft_receivable: runDraftReceivable,
  draft_payment: runDraftPayment,
  draft_dunning: runDraftDunning,
  edit_order_all: runEditOrderAll,
  edit_receivable: runEditReceivable,
  edit_payment: runEditPayment,
  edit_todo: runEditTodo,
  stale_order_root: runStaleRoot,
  stale_order_item: runStaleItem,
  stale_payment: runStalePayment,
  switch_quotation_order: runSwitchQuotationOrder,
  switch_order_quotation: runSwitchOrderQuotation,
  switch_order_receivable: runSwitchOrderReceivable,
  switch_receivable_payment: runSwitchReceivablePayment,
  switch_todo_dunning: runSwitchTodoDunning,
  switch_dunning_todo: runSwitchDunningTodo,
  formal_to_pending: runFormalPending,
  hidden_relation_payment_todo: runHiddenRelationPaymentTodo,
  multi_edit_isolation: runMultiEditIsolation,
  multi_remove_add: runMultiRemoveAdd,
  flattened_conflict: runFlattenedConflict,
  amount_semantics: runAmountSemantics,
  date_semantics: runDateSemantics,
  relation_integrity: runRelationIntegrity,
  original_formal: runOriginalFormal,
  original_pending: runOriginalPending,
  spec_sparse_quotation: runSpecSparseQuotation,
  spec_sparse_order: runSpecSparseOrder,
  spec_dunning_required(page, harness, check) { runSpecObservation(page, harness, check, 'SPEC.DUNNING_REQUIRED'); },
  deposit_alias_edit: runDepositAliasEdit,
  quotation_root_total: runQuotationRootTotal,
  item_meta_editability: runItemMetaEditability,
  hidden_quotation_fields: runHiddenQuotationFields,
  explicit_hidden_valid_until: runExplicitHiddenValidUntil,
  explicit_hidden_payment_method: runExplicitHiddenPaymentMethod,
  quotation_authority_positive: runQuotationAuthorityPositive,
  date_quotation: runDateQuotation,
  date_receivable: runDateReceivable,
  date_payment: runDatePayment,
  date_todo: runDateTodo,
  payment_remaining_amount: runPaymentRemainingAmount,
  quotation_relation_integrity: runQuotationRelationIntegrity,
  order_relation_switch: runOrderRelationSwitch
};

function setupFor(spec) {
  switch (spec.scenario) {
    case 'draft_quotation_multi':
      return { draft: draft({ id: spec.id, intent: 'quotation', originalText: QUOTE_TEXT, fields: quotationFields() }) };
    case 'quotation_root_total':
      return { draft: draft({
        id: spec.id,
        intent: 'quotation',
        originalText: QUOTE_TEXT,
        fields: quotationFields({ statedAmount: '2000' }),
        manualFields: ['amount']
      }) };
    case 'item_meta_editability':
      return { draft: draft({ id: spec.id, intent: 'order', originalText: ORDER_TEXT, fields: orderFields({
        items: [{ productName: '旧杯', spec: '', quantity: '100', unit: '个', unitPrice: '10', priceUnit: '个', totalAmount: '1000', itemDeliveryDate: '2026-08-21', itemRemark: '红色包装' }]
      }) }) };
    case 'hidden_quotation_fields':
      return { draft: draft({ id: spec.id, intent: 'quotation', originalText: QUOTE_TEXT, fields: quotationFields({
        validUntil: '2026-09-01', paymentMethod: '月结', quoteDate: '2026-08-15'
      }) }) };
    case 'explicit_hidden_valid_until':
      return { draft: draft({
        id: spec.id,
        intent: 'quotation',
        originalText: '给王总报价旧杯100个每个10元，新杯50个每个20元，2026-08-18跟进，总价2000元，报价有效到2026-09-01。',
        fields: quotationFields({ validUntil: '2026-09-01' })
      }) };
    case 'explicit_hidden_payment_method':
      return { draft: draft({
        id: spec.id,
        intent: 'quotation',
        originalText: '给王总报价旧杯100个每个10元，新杯50个每个20元，2026-08-18跟进，总价2000元，付款方式月结。',
        fields: quotationFields({ paymentMethod: '月结' })
      }) };
    case 'quotation_authority_positive':
      return { draft: draft({
        id: spec.id,
        intent: 'quotation',
        originalText: QUOTE_TEXT,
        fields: quotationFields({ remark: '备注A12' })
      }) };
    case 'date_quotation':
      return { draft: draft({ id: spec.id, intent: 'quotation', originalText: QUOTE_DATE_TEXT, fields: quotationFields() }) };
    case 'draft_receivable':
    case 'edit_receivable':
    case 'formal_to_pending':
    case 'original_pending':
      return { draft: draft({ id: spec.id, intent: 'receivable', originalText: RECEIVABLE_TEXT, fields: receivableFields() }) };
    case 'original_formal':
      return { draft: draft({
        id: spec.id,
        intent: 'receivable',
        originalText: ORIGINAL_RECEIVABLE_TEXT,
        fields: receivableFields()
      }) };
    case 'date_receivable':
      return { draft: draft({ id: spec.id, intent: 'receivable', originalText: RECEIVABLE_TEXT, fields: receivableFields() }) };
    case 'draft_payment':
    case 'edit_payment':
    case 'stale_payment':
      return { draft: draft({ id: spec.id, intent: 'payment', originalText: PAYMENT_TEXT, fields: paymentFields() }) };
    case 'date_payment':
      return { draft: draft({ id: spec.id, intent: 'payment', originalText: PAYMENT_TEXT, fields: paymentFields() }) };
    case 'payment_remaining_amount':
      return { draft: draft({
        id: spec.id,
        intent: 'payment',
        operation: 'create_receivable_with_payment',
        suggestedOperation: 'create_receivable_with_payment',
        originalText: '王总本次收250元，还剩750元，2026-08-15收到。',
        fields: paymentFields({ amount: '1000', paymentAmount: '250', remainingAmount: '750' })
      }) };
    case 'draft_dunning':
    case 'switch_dunning_todo':
      return { draft: draft({ id: spec.id, intent: 'dunning', originalText: DUNNING_TEXT, fields: todoFields({ todoTitle: '催王总付款', todoType: 'dunning' }) }) };
    case 'edit_todo':
    case 'switch_todo_dunning':
      return { draft: draft({ id: spec.id, intent: 'todo', originalText: TODO_TEXT, fields: todoFields() }) };
    case 'date_todo':
      return { draft: draft({ id: spec.id, intent: 'todo', originalText: TODO_TEXT, fields: todoFields() }) };
    case 'switch_quotation_order':
      return { draft: draft({ id: spec.id, intent: 'quotation', originalText: QUOTE_TEXT, fields: quotationFields() }) };
    case 'switch_order_receivable':
      return { draft: draft({ id: spec.id, intent: 'order', originalText: RECEIVABLE_TEXT, fields: orderFields() }) };
    case 'switch_receivable_payment':
      return { draft: draft({ id: spec.id, intent: 'receivable', originalText: PAYMENT_TEXT, fields: receivableFields() }) };
    case 'hidden_relation_payment_todo':
      return {
        draft: draft({
          id: spec.id,
          intent: 'payment',
          originalText: TODO_TEXT,
          fields: paymentFields({
            customerId: 'cus-csi-wang',
            receivableId: 'rec-csi-open',
            receivableSelectionConfirmed: true,
            todoTitle: '给王总回电话'
          })
        }),
        stateKind: 'PAYMENT_RELATION'
      };
    case 'deposit_alias_edit':
      return { draft: draft({
        id: spec.id,
        intent: 'order',
        originalText: '王总下单旧杯100个，每个10元，2026-08-20交货，总价1000元，定金200元。',
        fields: orderFields({ depositAmount: '200', paymentAmount: '200', paymentKind: 'deposit' })
      }) };
    case 'edit_order_all':
      return { draft: draft({
        id: spec.id,
        intent: 'order',
        originalText: EDIT_ORDER_TEXT,
        fields: orderFields()
      }) };
    case 'stale_order_root':
      return { draft: draft({
        id: spec.id,
        intent: 'order',
        originalText: STALE_ROOT_TEXT,
        fields: orderFields()
      }) };
    case 'stale_order_item':
      return { draft: draft({
        id: spec.id,
        intent: 'order',
        originalText: STALE_ITEM_TEXT,
        fields: orderFields()
      }) };
    case 'multi_edit_isolation':
      return { draft: draft({
        id: spec.id,
        intent: 'quotation',
        originalText: MULTI_EDIT_TEXT,
        fields: quotationFields()
      }) };
    case 'multi_remove_add':
      return { draft: draft({
        id: spec.id,
        intent: 'quotation',
        originalText: MULTI_REBUILD_TEXT,
        fields: quotationFields()
      }) };
    case 'amount_semantics':
      return { draft: draft({
        id: spec.id,
        intent: 'order',
        originalText: AMOUNT_TEXT,
        fields: orderFields()
      }) };
    case 'flattened_conflict':
      return {
        draft: draft({ id: spec.id, intent: 'order', originalText: ORDER_TEXT, fields: orderFields({ productName: '顶层错商品', quantity: '999' }) })
      };
    case 'relation_integrity':
      return {
        draft: draft({ id: spec.id, intent: 'payment', originalText: PAYMENT_TEXT, fields: paymentFields({ customerId: 'cus-csi-wang' }) }),
        stateKind: 'PAYMENT_RELATION'
      };
    case 'quotation_relation_integrity':
      return {
        draft: withQuotationConversionEvidence(draft({
          id: spec.id,
          intent: 'order',
          originalText: '把王总旧杯报价转成订单，2026-08-20交货。',
          fields: orderFields({
            customerId: 'cus-csi-wang'
          })
        })),
        stateKind: 'ALL_RELATIONS'
      };
    case 'order_relation_switch':
      return {
        draft: draft({
          id: spec.id,
          intent: 'receivable',
          originalText: '王总这张订单欠款1000元，2026-08-30收。',
          fields: receivableFields({
            customerId: 'cus-csi-wang',
            orderId: 'ord-csi-open',
            orderSelectionConfirmed: true
          })
        }),
        stateKind: 'ALL_RELATIONS'
      };
    case 'spec_sparse_quotation':
      return { draft: draft({ id: spec.id, intent: 'quotation', originalText: '给王总报旧杯。', fields: { customerName: '王总', productName: '旧杯', items: [{ productName: '旧杯' }] } }) };
    case 'spec_sparse_order':
      return { draft: draft({ id: spec.id, intent: 'order', originalText: '王总下单旧杯。', fields: { customerName: '王总', productName: '旧杯', items: [{ productName: '旧杯' }] } }) };
    case 'spec_dunning_required':
      return { draft: draft({ id: spec.id, intent: 'dunning', originalText: '提醒我催款。', fields: { todoTitle: '催款' } }) };
    default:
      return { draft: draft({ id: spec.id, intent: 'order', originalText: ORDER_TEXT, fields: orderFields() }) };
  }
}

function classify(spec, checks) {
  if (spec.baselineStatus === 'SPEC_REQUIRED') return 'SPEC_REQUIRED';
  const firstFailure = checks.find((item) => !item.pass) || null;
  if (!firstFailure) return 'PASS';
  if (spec.baselineStatus === 'EXPECTED_RED'
    && spec.baselineFirstFailure
    && spec.baselineFirstFailure.taxonomy === firstFailure.taxonomy
    && spec.baselineFirstFailure.code === firstFailure.code) return 'EXPECTED_RED';
  return 'UNEXPECTED_RED';
}

async function executeCase(spec) {
  const recorder = createRecorder();
  const setup = setupFor(spec);
  let harness;
  try {
    harness = createHarnessForDraft(spec.id, setup.draft, setup.stateKind || '');
    mountDraft(harness.page, setup.draft);
    const scenario = SCENARIOS[spec.scenario];
    if (!scenario) throw Object.assign(new Error(`Missing scenario: ${spec.scenario}`), {
      code: 'SCENARIO_NOT_IMPLEMENTED'
    });
    await Promise.resolve(scenario(harness.page, harness, recorder.check));
    const status = classify(spec, recorder.checks);
    const firstFailure = recorder.checks.find((item) => !item.pass) || null;
    const evidence = capture(harness.page, harness);
    return {
      id: spec.id,
      category: spec.category,
      status,
      checks: recorder.checks,
      firstFailure,
      evidence: {
        businessCalls: safeClone(harness.driver.evidence.productionBusinessCalls),
        storageCalls: safeClone(harness.driver.evidence.productionStorageCalls),
        finalIntent: evidence.card.intent,
        finalOperation: evidence.card.operation,
        savePayloadPresent: Boolean(evidence.savePayload)
      },
      semanticFingerprint: stableHash({
        checks: recorder.checks,
        firstFailure,
        status
      }, 'confirmation-semantic-integrity-v1')
    };
  } catch (error) {
    return {
      id: spec.id,
      category: spec.category,
      status: 'RUNNER_ERROR',
      checks: recorder.checks,
      firstFailure: {
        taxonomy: 'TEST_INFRA',
        code: error.code || 'RUNNER_ERROR',
        message: error.message,
        stack: error.stack
      },
      evidence: {},
      semanticFingerprint: stableHash({ code: error.code || 'RUNNER_ERROR', message: error.message },
        'confirmation-semantic-integrity-v1')
    };
  } finally {
    if (harness) harness.dispose();
  }
}

module.exports = { executeCase };
