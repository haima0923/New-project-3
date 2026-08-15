#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseInput } = require('../../../utils/parser');
const {
  convertQuotationToOrder,
  generateReceivableFromOrder,
  recordPayment,
  saveConfirmedDraft,
  savePendingNote
} = require('../../../utils/business');
const { createInitialState } = require('../../../utils/storage');

const ROOT = path.resolve(__dirname, '../../..');
const CORPUS_PATH = path.join(__dirname, 'golden-corpus-v1.json');
const TAXONOMY_PATH = path.join(__dirname, 'failure-taxonomy-v1.json');

function parseArgs(argv) {
  const output = { repeat: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--core-report') output.coreReport = argv[++index];
    else if (arg === '--output') output.output = argv[++index];
    else if (arg === '--repeat') output.repeat = Number(argv[++index]);
    else if (arg === '--json') output.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!output.coreReport) {
    throw new Error('Usage: node run.js --core-report /private/tmp/core120.json [--repeat 2] [--output /private/tmp/readiness.json]');
  }
  if (!Number.isInteger(output.repeat) || output.repeat < 1) {
    throw new Error('--repeat must be a positive integer');
  }
  return output;
}

function jsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateSupplementalCorpus(corpus) {
  const required = [
    'caseId', 'category', 'inputMode', 'inputText', 'expectedBusinessType',
    'mustExtract', 'mustPreserve', 'mustNotInvent', 'allowedUnknown',
    'expectedDisposition', 'caseStatus', 'riskLevel'
  ];
  const ids = new Set();
  (corpus.supplementalCases || []).forEach((testCase) => {
    const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(testCase, key));
    if (missing.length) throw new Error(`${testCase.caseId || 'UNKNOWN'} missing corpus keys: ${missing.join(', ')}`);
    if (ids.has(testCase.caseId)) throw new Error(`Duplicate supplemental caseId: ${testCase.caseId}`);
    ids.add(testCase.caseId);
    if (testCase.caseStatus === 'ACTIVE' && !testCase.probe) {
      throw new Error(`${testCase.caseId} ACTIVE case has no executable probe`);
    }
  });
  return true;
}

function getPath(value, keyPath) {
  return String(keyPath).split('.').reduce((cursor, key) => (
    cursor === null || cursor === undefined ? undefined : cursor[key]
  ), value);
}

function semanticallyEqual(actual, expected) {
  if (expected && expected.predicate === 'NON_EMPTY') {
    return actual !== undefined && actual !== null && String(actual).trim() !== '';
  }
  if (typeof actual === 'number' || typeof expected === 'number') {
    return Number.isFinite(Number(actual)) && Number(actual) === Number(expected);
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
    || String(actual === undefined ? '' : actual) === String(expected);
}

function isAbsent(value) {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function domainForPath(keyPath) {
  const key = String(keyPath).toLowerCase();
  if (key.includes('originaltext')) return 'ORIGINAL_TEXT';
  if (key.includes('customer')) return 'CUSTOMER';
  if (key.includes('product') || key.includes('items') || key.includes('spec')) return 'ITEM';
  if (key.includes('quantity')) return 'QUANTITY';
  if (key.includes('unitprice') || key.includes('price')) return 'PRICE';
  if (key.includes('unit')) return 'UNIT';
  if (key.includes('amount')) return 'AMOUNT';
  if (key.includes('date') || key.includes('due') || key.includes('until')) return 'DATE';
  if (/id($|\.)/.test(key) || key.includes('relation')) return 'RELATION';
  return 'SAFETY';
}

function assertion(name, actual, expected, domain, layer) {
  return {
    actual,
    domain,
    expected,
    layer,
    name,
    pass: semanticallyEqual(actual, expected)
  };
}

function quotationState() {
  const state = createInitialState();
  state.customers.push({ id: 'c1', userId: 'local-user', name: '王总' });
  state.quotations.push({
    id: 'q1',
    userId: 'local-user',
    customerId: 'c1',
    productName: '纸杯',
    quantity: '1000',
    unit: '个',
    unitPrice: '1',
    priceUnit: '个',
    totalAmount: '1000',
    items: [{
      productName: '纸杯', quantity: '1000', unit: '个', unitPrice: '1',
      priceUnit: '个', totalAmount: '1000'
    }],
    status: '待确认',
    originalText: '给王总报纸杯1000个'
  });
  return state;
}

function safeQuotationDraft(originalKey = 'original_text') {
  const draft = {
    intent: 'quotation',
    operation: 'create_quotation',
    source: 'typed',
    confidence: 0.99,
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    fields: {
      customerName: '王总',
      productName: '纸杯',
      quantity: '1000',
      unit: '个',
      unitPrice: '1',
      amount: '1000',
      items: [{
        productName: '纸杯', quantity: '1000', unit: '个', unitPrice: '1', totalAmount: '1000'
      }]
    }
  };
  draft[originalKey] = '给王总报纸杯1000个，1元一个';
  return draft;
}

function executeStaticProbe(testCase) {
  const checks = [];
  let actual = {};
  if (testCase.probe === 'QUOTE_TO_ORDER_CURRENT_ORIGINAL') {
    const state = quotationState();
    const current = testCase.inputText;
    const record = convertQuotationToOrder(state, 'q1', {
      requiredDeliveryDate: '2026-08-20',
      originalText: current
    });
    actual = { record, state };
    checks.push(assertion('order.originalText', record && record.originalText, current, 'ORIGINAL_TEXT', 'L4'));
    checks.push(assertion('quotation.originalText', state.quotations[0].originalText, '给王总报纸杯1000个', 'ORIGINAL_TEXT', 'L4'));
    checks.push(assertion('quotation.convertedOrderId', state.quotations[0].convertedOrderId, record && record.id, 'RELATION', 'L4'));
    checks.push(assertion('order.quotationId', record && record.quotationId, 'q1', 'RELATION', 'L4'));
  } else if (testCase.probe === 'PAYMENT_DATE_PRESERVED') {
    const state = createInitialState();
    state.customers.push({ id: 'c1', userId: 'local-user', name: '王总' });
    state.receivables.push({
      id: 'r1', customerId: 'c1', orderId: '', amount: '1000', paidAmount: '0',
      status: '待收', source: 'manual'
    });
    const record = recordPayment(state, 'r1', '100', {
      originalText: testCase.inputText,
      paidAt: '2000-01-02'
    });
    actual = { record, state };
    checks.push(assertion('payment.paidAt', record && record.paidAt, '2000-01-02', 'DATE', 'L4'));
    checks.push(assertion('payment.originalText', record && record.originalText, testCase.inputText, 'ORIGINAL_TEXT', 'L4'));
    const saveState = createInitialState();
    saveState.customers.push({ id: 'c1', userId: 'local-user', name: '王总' });
    saveState.receivables.push({
      id: 'r1', customerId: 'c1', orderId: '', amount: '1000', paidAmount: '0',
      status: '待收', source: 'manual'
    });
    const saveResult = saveConfirmedDraft(saveState, {
      intent: 'payment', operation: 'record_payment', original_text: testCase.inputText,
      source: 'typed', confidence: 0.99, missing_fields: [], low_confidence_fields: [],
      field_conflicts: [], fields: {
        customerName: '王总', customerId: 'c1', receivableId: 'r1',
        receivableSelectionConfirmed: true, paymentAmount: '100',
        paymentDate: '2000-01-02', dueDate: '2000-01-02'
      }
    });
    actual.saveResult = saveResult;
    actual.saveState = saveState;
    checks.push(assertion('confirmedSave.type', saveResult.type, 'payment', 'SAVE_MAPPING', 'L4'));
    checks.push(assertion('confirmedSave.payment.paidAt', saveResult.record && saveResult.record.paidAt, '2000-01-02', 'DATE', 'L4'));
    const noDateState = createInitialState();
    noDateState.customers.push({ id: 'c2', userId: 'local-user', name: '李总' });
    noDateState.receivables.push({
      id: 'r2', customerId: 'c2', orderId: '', amount: '500', paidAmount: '0',
      status: '待收', source: 'manual'
    });
    const noDateRecord = recordPayment(noDateState, 'r2', '100');
    actual.noDateRecord = noDateRecord;
    checks.push(assertion('payment.withoutBusinessDate.paidAt.absent', isAbsent(noDateRecord && noDateRecord.paidAt), true, 'DATE', 'L4'));
    const inputPageSource = fs.readFileSync(path.join(ROOT, 'pages/input/input.js'), 'utf8');
    checks.push(assertion('confirmation.paymentDate.visible', /showDueDateField:[^\n]*record_payment/.test(inputPageSource), true, 'CONFIRMATION', 'L3'));
    checks.push(assertion('confirmation.paymentDate.label', /operation === 'record_payment'[\s\S]{0,80}\? '收款日期'/.test(inputPageSource), true, 'CONFIRMATION', 'L3'));
    checks.push(assertion('confirmation.paymentDate.editSync', /this\.data\.operation === 'record_payment'[\s\S]{0,120}nextFields\.paymentDate = value/.test(inputPageSource), true, 'EDIT_STATE', 'L3'));
  } else if (testCase.probe === 'QUOTATION_VALID_UNTIL_NOT_INVENTED') {
    const state = createInitialState();
    const result = saveConfirmedDraft(state, safeQuotationDraft());
    const record = result.record;
    actual = { record, result, state };
    checks.push(assertion('quotation.saved', result.type, 'quotation', 'SAVE_MAPPING', 'L4'));
    checks.push(assertion('quotation.validUntil.absent', isAbsent(record && record.validUntil), true, 'SAFETY', 'L4'));
    checks.push(assertion('quotation.originalText', record && record.originalText, testCase.inputText, 'ORIGINAL_TEXT', 'L4'));
  } else if (testCase.probe === 'TODO_PHONE_DOES_NOT_CREATE_CUSTOMER') {
    const state = createInitialState();
    const result = saveConfirmedDraft(state, {
      intent: 'todo', operation: 'create_todo', original_text: testCase.inputText,
      source: 'typed', confidence: 0.99, missing_fields: [], low_confidence_fields: [],
      field_conflicts: [], fields: { todoTitle: '打电话', dueDate: '2026-08-16', phone: '13800138000' }
    });
    actual = { result, state };
    checks.push(assertion('todo.saved', result.type, 'todo', 'SAVE_MAPPING', 'L4'));
    checks.push(assertion('customers.createdCount', state.customers.length, 0, 'CUSTOMER', 'L4'));
    checks.push(assertion('todo.customerId.absent', isAbsent(result.record && result.record.customerId), true, 'SAFETY', 'L4'));
  } else if (testCase.probe === 'ZERO_AMOUNT_ORDER_CANNOT_CREATE_RECEIVABLE') {
    const state = createInitialState();
    state.customers.push({ id: 'c1', userId: 'local-user', name: '王总' });
    state.orders.push({
      id: 'o1', userId: 'local-user', customerId: 'c1', status: '待生产',
      totalAmount: '', requiredDeliveryDate: '2026-08-20'
    });
    const record = generateReceivableFromOrder(state, 'o1');
    actual = { record, state };
    checks.push(assertion('receivable.notCreated', record === null, true, 'AMOUNT', 'L4'));
    checks.push(assertion('receivables.createdCount', state.receivables.length, 0, 'SAFETY', 'L4'));
  } else if (testCase.probe === 'CAMEL_ORIGINAL_TEXT_EXPLICITLY_BLOCKED_OR_PRESERVED') {
    const state = createInitialState();
    const result = saveConfirmedDraft(state, safeQuotationDraft('originalText'));
    const explicitBlock = result.type === 'error' && result.noMutation === true && state.quotations.length === 0;
    const preserved = result.record && result.record.originalText === testCase.inputText;
    actual = { explicitBlock, preserved, result, state };
    checks.push(assertion('camelOriginalText.preservedOrExplicitlyBlocked', Boolean(explicitBlock || preserved), true, 'ORIGINAL_TEXT', 'L4'));
  } else if (testCase.probe === 'QUOTE_TO_ORDER_IDEMPOTENT') {
    const state = quotationState();
    const first = convertQuotationToOrder(state, 'q1', { requiredDeliveryDate: '2026-08-20' });
    const second = convertQuotationToOrder(state, 'q1', { requiredDeliveryDate: '2026-08-20' });
    actual = { first, second, state };
    checks.push(assertion('orders.createdCount', state.orders.length, 1, 'DUPLICATE_SAVE', 'L4'));
    checks.push(assertion('repeatConversion.sameOrder', second && second.id, first && first.id, 'DUPLICATE_SAVE', 'L4'));
    checks.push(assertion('quote.forwardRelation', state.quotations[0].convertedOrderId, first && first.id, 'RELATION', 'L4'));
    checks.push(assertion('order.reverseRelation', first && first.quotationId, 'q1', 'RELATION', 'L4'));
  } else if (testCase.probe === 'PENDING_HAS_ZERO_FORMAL_SIDE_EFFECTS') {
    const state = createInitialState();
    const record = savePendingNote(state, {
      intent: 'unknown', original_text: testCase.inputText, source: 'typed',
      fields: {}, missing_fields: ['productName', 'amount'],
      low_confidence_fields: ['productName', 'amount'], field_conflicts: []
    }, '信息不足，稍后整理');
    const formalCount = ['orders', 'quotations', 'receivables', 'paymentRecords', 'todos']
      .reduce((sum, key) => sum + state[key].length, 0);
    actual = { formalCount, record, state };
    checks.push(assertion('pending.createdCount', state.pendingNotes.length, 1, 'PENDING_POLICY', 'L4'));
    checks.push(assertion('pending.originalText', record && record.originalText, testCase.inputText, 'ORIGINAL_TEXT', 'L4'));
    checks.push(assertion('formalSideEffects.count', formalCount, 0, 'SAFETY', 'L4'));
  } else if (testCase.probe === 'NO_EVIDENCE_PRODUCT_CANNOT_SAVE_FORMAL') {
    const state = createInitialState();
    const result = saveConfirmedDraft(state, {
      intent: 'order', operation: 'create_order', original_text: testCase.inputText,
      source: 'typed', confidence: 0.99, missing_fields: [], low_confidence_fields: [],
      field_conflicts: [], fields: {
        customerName: '王总', productName: '单', quantity: '2000', unit: '个',
        unitPrice: '5', amount: '10000', dueDate: '2026-08-31',
        items: [{
          productName: '单', quantity: '2000', unit: '个', unitPrice: '5', totalAmount: '10000'
        }]
      }
    });
    actual = { result, state };
    checks.push(assertion('formalSave.blocked', result.type === 'error' && result.noMutation === true, true, 'SAFETY', 'L4'));
    checks.push(assertion('orders.createdCount', state.orders.length, 0, 'ITEM', 'L4'));
    checks.push(assertion('customers.createdCount', state.customers.length, 0, 'CUSTOMER', 'L4'));
  } else {
    throw new Error(`Unsupported static probe: ${testCase.probe}`);
  }
  return { actual, assertions: checks };
}

function localDisposition(result) {
  return result.intent !== 'unknown'
    && result.formal_save_blocked !== true
    && result.local_parse_safety
    && result.local_parse_safety.safe_to_auto_accept === true
    ? 'formal'
    : 'pending';
}

function executeLocalParse(testCase) {
  const result = parseInput({
    text: testCase.inputText,
    source: 'voice',
    state: createInitialState()
  });
  const checks = [
    assertion('businessType', result.intent, testCase.expectedBusinessType, 'INTENT', 'L2'),
    assertion('originalText', result.original_text, testCase.inputText, 'ORIGINAL_TEXT', 'L2')
  ];
  Object.entries(testCase.mustExtract || {}).forEach(([key, expected]) => {
    checks.push(assertion(`mustExtract.${key}`, getPath(result, key), expected, domainForPath(key), 'L2'));
  });
  (testCase.mustNotInvent || []).forEach((key) => {
    checks.push(assertion(`mustNotInvent.${key}`, isAbsent(getPath(result, key)), true, 'SAFETY', 'L2'));
  });
  checks.push(assertion(
    'expectedDisposition',
    localDisposition(result),
    testCase.expectedDisposition,
    'PENDING_POLICY',
    'L2'
  ));
  return { actual: result, assertions: checks };
}

function supplementalResult(testCase) {
  try {
    const execution = testCase.probe === 'LOCAL_PARSE'
      ? executeLocalParse(testCase)
      : executeStaticProbe(testCase);
    const failed = execution.assertions.filter((item) => !item.pass);
    const primary = failed[0] || null;
    return {
      assertions: execution.assertions,
      businessType: testCase.expectedBusinessType,
      caseId: testCase.caseId,
      category: testCase.category,
      failureDomain: primary ? primary.domain : null,
      primaryFailure: primary,
      readinessStatus: primary ? 'EXPECTED_RED' : 'PASS',
      riskLevel: testCase.riskLevel,
      source: 'TRUST_READINESS_SUPPLEMENTAL',
      testLayer: primary ? primary.layer : (testCase.probe === 'LOCAL_PARSE' ? 'L2' : 'L4')
    };
  } catch (error) {
    return {
      assertions: [],
      businessType: testCase.expectedBusinessType,
      caseId: testCase.caseId,
      category: testCase.category,
      error: { code: error.code || 'SUPPLEMENTAL_RUNNER_ERROR', message: error.message },
      failureDomain: 'TEST_INFRA',
      readinessStatus: 'RUNNER_ERROR',
      riskLevel: testCase.riskLevel,
      source: 'TRUST_READINESS_SUPPLEMENTAL',
      testLayer: 'L5'
    };
  }
}

function classifyDomain(layer, name) {
  const value = String(name || '').toLowerCase();
  if (layer === 'INPUT') return value.includes('original') ? 'ORIGINAL_TEXT' : 'BOUNDARY';
  if (value.includes('originaltext')) return 'ORIGINAL_TEXT';
  if (value.includes('customer')) return 'CUSTOMER';
  if (value.includes('product') || value.includes('items') || value.includes('spec')) return 'ITEM';
  if (value.includes('quantity')) return 'QUANTITY';
  if (value.includes('unitprice') || value.includes('price')) return 'PRICE';
  if (value.includes('unit')) return 'UNIT';
  if (value.includes('amount') || value.includes('payment') || value.includes('deposit') || value.includes('remaining')) return 'AMOUNT';
  if (value.includes('date') || value.includes('due') || value.includes('delivery') || value.includes('remind')) return 'DATE';
  if (value.includes('quotationid') || value.includes('orderid') || value.includes('receivableid') || value.includes('relation')) return 'RELATION';
  if (layer === 'CONFIRMATION') return 'CONFIRMATION';
  if (layer === 'SURFACE' || value.includes('edit')) return 'EDIT_STATE';
  if (layer === 'DUPLICATE_TRIGGER') return 'DUPLICATE_SAVE';
  if (['STATE_DIFF', 'OUTCOME', 'ISOLATED_COMMIT', 'TRANSACTION_REPLAY', 'CONCURRENT', 'RESTART'].includes(layer)) return 'SAVE_MAPPING';
  if (value.includes('pending') || value.includes('disposition')) return 'PENDING_POLICY';
  if (value.includes('businesstype') || value.includes('operation') || value.includes('route')) return 'INTENT';
  return 'SAFETY';
}

function layerProjection(layer) {
  if (layer === 'INPUT') return 'L1';
  if (['RAW_PARSER', 'SEMANTIC_RESULT', 'ROUTE', 'PREFLIGHT', 'PRODUCTION_OBSERVATION'].includes(layer)) return 'L2';
  if (['PROPOSAL', 'CONFIRMATION', 'SURFACE', 'PAGE_DERIVATION'].includes(layer)) return 'L3';
  if (['ISOLATED_COMMIT', 'STATE_DIFF', 'OUTCOME', 'TRANSACTION_REPLAY', 'DUPLICATE_TRIGGER', 'CONCURRENT', 'RESTART'].includes(layer)) return 'L4';
  return 'L5';
}

function projectCoreResult(result) {
  const primary = result.primaryFailure || {};
  const readinessStatus = result.caseStatus === 'PASS'
    ? 'PASS'
    : (result.caseStatus === 'CASE_FAIL'
      ? 'EXPECTED_RED'
      : 'RUNNER_ERROR');
  return {
    assertions: result.assertions || [],
    businessType: result.businessType,
    businessMutationCreated: Object.values(result.businessDiff || {}).some((change) => (
      change && Array.isArray(change.created) && change.created.length > 0
    )),
    caseId: result.caseId,
    category: result.category,
    failureDomain: readinessStatus === 'PASS'
      ? null
      : (readinessStatus === 'RUNNER_ERROR'
        ? 'TEST_INFRA'
        : classifyDomain(primary.layer, primary.name)),
    failureSignature: readinessStatus === 'PASS' ? '' : [
      result.failureStage, result.failureCode, primary.layer, primary.name
    ].join('|'),
    primaryFailure: primary,
    readinessStatus,
    riskLevel: result.riskLevel,
    source: 'CORE120',
    testLayer: readinessStatus === 'PASS' ? 'L5' : layerProjection(primary.layer)
  };
}

function addCount(target, key) {
  const value = key || 'UNSPECIFIED';
  target[value] = (target[value] || 0) + 1;
}

function summarize(results) {
  const output = {
    TOTAL: results.length,
    PASS: 0,
    EXPECTED_RED: 0,
    UNEXPECTED_RED: 0,
    SPEC_REQUIRED: 0,
    RUNNER_ERROR: 0,
    byBusinessType: {},
    byFailureDomain: {},
    byRisk: {},
    byTestLayer: {}
  };
  results.forEach((result) => {
    output[result.readinessStatus] += 1;
    addCount(output.byBusinessType, `${result.businessType}:${result.readinessStatus}`);
    addCount(output.byFailureDomain, result.failureDomain || 'NONE');
    addCount(output.byRisk, `${result.riskLevel}:${result.readinessStatus}`);
    addCount(output.byTestLayer, `${result.testLayer}:${result.readinessStatus}`);
  });
  return output;
}

const REDLINES = {
  originalText: ['ORIGINAL_TEXT'],
  customer: ['CUSTOMER'],
  item: ['ITEM', 'QUANTITY', 'UNIT', 'PRICE'],
  amount: ['AMOUNT'],
  date: ['DATE'],
  duplicateSave: ['DUPLICATE_SAVE'],
  relations: ['RELATION'],
  inventedInfo: ['SAFETY']
};

function p0RedlineScore(results) {
  const output = {};
  Object.entries(REDLINES).forEach(([name, domains]) => {
    const relevant = results.filter((result) => (
      result.riskLevel === 'P0'
      && (result.assertions || []).some((item) => domains.includes(
        item.domain || classifyDomain(item.layer, item.name)
      ))
    ));
    const contractReds = relevant.filter((result) => (
      (result.assertions || []).some((item) => (
        item.pass === false
        && domains.includes(item.domain || classifyDomain(item.layer, item.name))
      ))
    ));
    const confirmedViolations = contractReds.filter((result) => {
      if (result.source === 'TRUST_READINESS_SUPPLEMENTAL') return true;
      return (result.assertions || []).some((item) => {
        if (item.pass !== false
          || !domains.includes(item.domain || classifyDomain(item.layer, item.name))) return false;
        if (name === 'originalText') {
          return ['INPUT', 'PROPOSAL'].includes(item.layer)
            && ['pageOriginalText', 'originalText'].includes(item.name);
        }
        if (name === 'inventedInfo') {
          return String(item.name || '').startsWith('absentFields.') && item.actual === true;
        }
        if (name === 'duplicateSave') {
          // A duplicate-lane precondition failure is a contract red, but it is
          // not evidence that production committed the same business mutation
          // twice. Supplemental probes carry explicit state-diff evidence and
          // are handled above; Core runner contract drift remains unconfirmed.
          return false;
        }
        return result.businessMutationCreated === true && item.layer === 'STATE_DIFF';
      });
    });
    output[name] = {
      checkedCases: relevant.length,
      contractRedCaseIds: contractReds.map((item) => item.caseId),
      contractReds: contractReds.length,
      confirmedViolationCaseIds: confirmedViolations.map((item) => item.caseId),
      confirmedViolations: confirmedViolations.length
    };
  });
  return output;
}

function clusterResults(results) {
  const groups = new Map();
  results.filter((item) => item.readinessStatus === 'EXPECTED_RED').forEach((item) => {
    const key = `${item.riskLevel}|${item.testLayer}|${item.failureDomain}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.caseId);
  });
  return Array.from(groups.entries()).map(([key, caseIds]) => {
    const [riskLevel, testLayer, failureDomain] = key.split('|');
    return { riskLevel, testLayer, failureDomain, caseCount: caseIds.length, caseIds };
  }).sort((left, right) => (
    (left.riskLevel === right.riskLevel ? 0 : (left.riskLevel === 'P0' ? -1 : 1))
    || right.caseCount - left.caseCount
    || left.failureDomain.localeCompare(right.failureDomain)
  ));
}

function gitValue(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function gitEvidence() {
  return {
    branch: gitValue(['branch', '--show-current']),
    head: gitValue(['rev-parse', 'HEAD']),
    candidateTag: gitValue(['rev-parse', 'candidate-voice-wxvoice-readiness-ux-v1^{}']),
    dirtyPaths: gitValue(['status', '--short']).split('\n').filter(Boolean)
  };
}

function stableAttemptFingerprint(results) {
  return JSON.stringify(results.map((result) => ({
    caseId: result.caseId,
    readinessStatus: result.readinessStatus,
    primary: result.primaryFailure && result.primaryFailure.name || ''
  })));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const coreReportPath = path.resolve(options.coreReport);
  const core = jsonFile(coreReportPath);
  if (!core.summary || core.summary.RUNNER_ERROR !== 0 || core.summary.BLOCKED !== 0) {
    throw new Error('Core report must have RUNNER_ERROR=0 and BLOCKED=0 before readiness projection');
  }
  if (!core.determinism || core.determinism.stable !== true) {
    throw new Error('Core report is not deterministic');
  }
  const corpus = jsonFile(CORPUS_PATH);
  const taxonomy = jsonFile(TAXONOMY_PATH);
  validateSupplementalCorpus(corpus);
  const active = corpus.supplementalCases.filter((item) => item.caseStatus === 'ACTIVE');
  const specRequired = corpus.supplementalCases.filter((item) => item.caseStatus === 'SPEC_REQUIRED');
  const supplementalAttempts = Array.from({ length: options.repeat }, () => (
    active.map(supplementalResult)
  ));
  const fingerprints = supplementalAttempts.map(stableAttemptFingerprint);
  const supplementalStable = fingerprints.every((item) => item === fingerprints[0]);
  if (!supplementalStable) throw new Error('Supplemental readiness cases are not deterministic');
  const specResults = specRequired.map((item) => ({
    assertions: [],
    businessType: item.expectedBusinessType,
    caseId: item.caseId,
    category: item.category,
    failureDomain: 'SPEC_CONFLICT',
    readinessStatus: 'SPEC_REQUIRED',
    riskLevel: item.riskLevel,
    source: 'TRUST_READINESS_SPEC_BACKLOG',
    specConflict: item.specConflict,
    testLayer: 'L2'
  }));
  const results = core.caseResults.map(projectCoreResult)
    .concat(supplementalAttempts[0], specResults);
  const report = {
    schemaVersion: 'record-e2e-trust-readiness-report-v1',
    generatedAt: new Date().toISOString(),
    git: gitEvidence(),
    executionBoundary: {
      core: 'PageVM/headless production JS + Fake wx + isolated memory storage; no WXML DOM, real AI, WeChat device or real ASR.',
      supplemental: 'Local parser and public business functions only; no production mutation and no persistent wx storage.',
      coreReportPath
    },
    corpus: {
      total: results.length,
      coreActive: core.caseResults.length,
      supplementalActive: active.length,
      specRequired: specRequired.length,
      voiceTranscript: results.filter((item) => item.category === 'VOICE_TRANSCRIPT').length,
      fingerprint: core.corpus && core.corpus.fingerprint || '',
      sourceManifest: path.relative(ROOT, CORPUS_PATH)
    },
    taxonomy,
    determinism: {
      coreStable: core.determinism.stable === true,
      coreComparedAttempts: core.determinism.comparedAttempts,
      supplementalStable,
      supplementalComparedAttempts: options.repeat
    },
    summary: summarize(results),
    p0Redlines: p0RedlineScore(results),
    clusters: clusterResults(results),
    hardGates: core.hardGates,
    results
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(options.output);
    if (outputPath === ROOT || outputPath.startsWith(`${ROOT}${path.sep}`)) {
      throw new Error('Readiness reports must be written outside the repository');
    }
    fs.writeFileSync(outputPath, serialized);
  }
  if (options.json || !options.output) process.stdout.write(serialized);
  else {
    const summary = report.summary;
    process.stdout.write([
      `TOTAL=${summary.TOTAL}`,
      `PASS=${summary.PASS}`,
      `EXPECTED_RED=${summary.EXPECTED_RED}`,
      `UNEXPECTED_RED=${summary.UNEXPECTED_RED}`,
      `SPEC_REQUIRED=${summary.SPEC_REQUIRED}`,
      `RUNNER_ERROR=${summary.RUNNER_ERROR}`,
      `DETERMINISTIC=${report.determinism.coreStable && report.determinism.supplementalStable}`,
      `REPORT=${path.resolve(options.output)}`
    ].join('\n') + '\n');
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`RUNNER_ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
