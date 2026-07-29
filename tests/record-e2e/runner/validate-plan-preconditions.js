const SUCCESS_DEPENDENT_LANES = new Set([
  'RESTART_PERSISTENCE',
  'TRANSACTION_EXACT_REPLAY',
  'CONCURRENT_BASE_REVISION'
]);
const SELECTION_COLLECTIONS = Object.freeze({
  customerId: 'customers',
  orderId: 'orders',
  quotationId: 'quotations',
  receivableId: 'receivables'
});
const SELECTION_CAPABILITIES = Object.freeze({
  customerId: 'SELECT_CUSTOMER',
  orderId: 'SELECT_ORDER',
  quotationId: 'SELECT_QUOTATION',
  receivableId: 'SELECT_RECEIVABLE'
});
const { expectedProposal } = require('./observation-semantics');

function hasNonZeroBusinessDiff(testCase) {
  return Object.values(testCase.expected.stateDiff.business.collections || {}).some((change) => (
    Number(change.createdCount || 0)
    + Number(change.updatedCount || 0)
    + Number(change.deletedCount || 0) > 0
  ));
}

function hasExplicitChineseDate(text) {
  return /\d{1,2}月\d{1,2}日/.test(String(text || ''));
}

function explicitOrderUnits(text) {
  const value = String(text || '');
  const quantity = value.match(/\d+(?:\.\d+)?\s*(个|套|件|箱|包|只|条|张|米|公斤|斤|吨)/);
  const price = value.match(/\d+(?:\.\d+)?\s*元(?:\s*)[一每](个|套|件|箱|包|只|条|张|米|公斤|斤|吨)/);
  return {
    priceUnit: price && price[1] || '',
    quantityUnit: quantity && quantity[1] || ''
  };
}

function validateFormalOrderContract(testCase, errors) {
  const result = expectedProposal(testCase);
  if (result.businessType !== 'order' || testCase.expected.save.status !== 'FORMAL_COMMITTED') return;
  const fields = result.fields || {};
  if (!fields.customerName && !fields.customerId) errors.push('FORMAL_ORDER_CUSTOMER_EXPECTED_MISSING');
  if (result.operation === 'create_order' && !(result.items || []).length && !fields.productName) {
    errors.push('FORMAL_ORDER_PRODUCT_EXPECTED_MISSING');
  }
  if (result.operation === 'create_order' && (result.items || []).length
    && (result.items || []).some((item) => !item.productName || Number(item.quantity || 0) <= 0)) {
    errors.push('FORMAL_ORDER_ITEM_EXPECTED_INCOMPLETE');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields.orderDeliveryDate || ''))) {
    errors.push('FORMAL_ORDER_DUE_DATE_EXPECTED_MISSING');
  }
}

function validatePendingEditContract(testCase, state, errors) {
  if (testCase.input.channel !== 'PENDING_EDIT') return;
  const pending = (state.pendingNotes || []).find((item) => (
    item && item.id === testCase.input.pendingNoteId
  ));
  if (!pending) {
    errors.push('PENDING_EDIT_TARGET_NOT_FOUND');
    return;
  }
  if (String(pending.originalText || '') !== String(testCase.input.originalText || '')) {
    errors.push('PENDING_EDIT_ORIGINAL_TEXT_MISMATCH');
  }
}

function buildSelectionTargets(testCase, state) {
  const required = new Set(testCase.interaction.requiredCapabilities || []);
  return (testCase.interaction.userSelections || []).map((selection) => {
    const collection = SELECTION_COLLECTIONS[selection.kind] || '';
    const fixtureCandidateIds = collection
      ? (state[collection] || []).map((item) => item && item.id).filter(Boolean)
      : [];
    return {
      capability: SELECTION_CAPABILITIES[selection.kind] || '',
      collection,
      fixtureCandidateIds,
      fixtureTargetExists: fixtureCandidateIds.includes(selection.selectedId),
      requiredByContract: required.has(SELECTION_CAPABILITIES[selection.kind]),
      selectedId: selection.selectedId,
      selectionKind: selection.kind
    };
  });
}

function validateSelectionTargets(testCase, state, errors) {
  const blocking = new Set(testCase.expected.preflight.blockingCodes || []);
  buildSelectionTargets(testCase, state).forEach((target) => {
    if (!target.requiredByContract || target.fixtureTargetExists || !target.collection) return;
    const deliberatelyMissing = (
      target.selectionKind === 'orderId' && blocking.has('ORDER_TARGET_NOT_FOUND')
    ) || (
      target.selectionKind === 'quotationId' && blocking.has('QUOTATION_TARGET_NOT_FOUND')
    );
    if (!deliberatelyMissing) {
      errors.push(`SELECTION_TARGET_NOT_FOUND:${target.selectionKind}:${target.selectedId}`);
    }
  });
}

function validateSuccessLaneContract(testCase, errors) {
  const lanes = testCase.execution.lanes || [];
  if (!lanes.some((lane) => SUCCESS_DEPENDENT_LANES.has(lane))) return;
  validateFormalOrderContract(testCase, errors);
  const expected = testCase.expected;
  if (!lanes.includes('TEST_ONLY_ISOLATED_LEGACY_COMMIT')
    || !expected.isolatedExecution.enabled
    || expected.isolatedExecution.status !== 'TEST_ONLY_ISOLATED_COMMITTED'
    || expected.isolatedExecution.action !== 'SAVE_FORMAL') {
    errors.push('LANE_SUCCESS_FIRST_COMMIT_CONTRACT_MISSING');
  }
  if (expected.save.status !== 'FORMAL_COMMITTED'
    || expected.preflight.domainCanSaveFormal !== true
    || (expected.preflight.blockingCodes || []).length
    || ['PENDING', 'NO_RECORD'].includes(expected.route)) {
    errors.push('LANE_SUCCESS_PRECONDITION_UNSATISFIED');
  }
  if (!hasNonZeroBusinessDiff(testCase)) {
    errors.push('LANE_SUCCESS_EXPECTED_BUSINESS_CHANGE_MISSING');
  }
  if (lanes.includes('CONCURRENT_BASE_REVISION')) {
    const pageB = (testCase.interaction.sequence || []).find((step) => (
      step && step.actor === 'PAGE_B' && step.input
    ));
    if (!pageB || !pageB.input.originalText) errors.push('CONCURRENT_PAGE_B_INPUT_MISSING');
    if (expectedProposal(testCase).businessType === 'order'
      && pageB && !hasExplicitChineseDate(pageB.input.originalText)) {
      errors.push('CONCURRENT_PAGE_B_DUE_DATE_INPUT_MISSING');
    }
    if (expectedProposal(testCase).businessType === 'order' && pageB) {
      const units = explicitOrderUnits(pageB.input.originalText);
      if (units.quantityUnit && units.priceUnit && units.quantityUnit !== units.priceUnit) {
        errors.push('CONCURRENT_PAGE_B_EXPLICIT_UNIT_CONFLICT');
      }
    }
  }
}

function validateRelationTamperContract(testCase, state, errors) {
  const lanes = testCase.execution.lanes || [];
  const hasLane = lanes.includes('RELATION_REFERENCE_TAMPER_GUARD');
  const tamper = testCase.execution.relationReferenceTamper;
  const expected = testCase.expected.relationReferenceTamper;
  if (!hasLane) {
    if (tamper || expected) errors.push('RELATION_TAMPER_CONTRACT_WITHOUT_LANE');
    return;
  }
  if (!tamper || !expected) {
    errors.push('RELATION_TAMPER_CONTRACT_MISSING');
    return;
  }
  const quotation = (state.quotations || []).find((item) => (
    item && String(item.id || '') === String(tamper.injectedId || '')
  ));
  const selectedCustomerId = tamper.preflightContext
    && tamper.preflightContext.selectedCustomerId;
  const customerExists = (state.customers || []).some((item) => (
    item && String(item.id || '') === String(selectedCustomerId || '')
  ));
  if (!quotation) errors.push('RELATION_TAMPER_QUOTATION_NOT_FOUND');
  if (!customerExists) errors.push('RELATION_TAMPER_CUSTOMER_NOT_FOUND');
  if (tamper.sourceDraft !== 'EXPLICIT_SECURITY_TEST_DRAFT'
    || tamper.relationKind !== 'QUOTATION'
    || tamper.targetPath !== 'fields.quotationId') {
    errors.push('RELATION_TAMPER_INPUT_CONTRACT_INVALID');
  }
  if (tamper.baseDraft
    && tamper.baseDraft.fields
    && Object.prototype.hasOwnProperty.call(tamper.baseDraft.fields, 'quotationId')) {
    errors.push('RELATION_TAMPER_REFERENCE_PREINJECTED');
  }
  if ((testCase.interaction.userSelections || []).some((item) => (
    item.kind === 'quotationId'
  )) || (testCase.interaction.requiredCapabilities || []).includes('SELECT_QUOTATION')) {
    errors.push('RELATION_TAMPER_MIXED_WITH_USER_SELECTION');
  }
  const blocking = new Set(expected.blockingCodes || []);
  if (quotation && blocking.has('QUOTATION_CUSTOMER_MISMATCH')
    && String(quotation.customerId || '') === String(selectedCustomerId || '')) {
    errors.push('RELATION_TAMPER_CUSTOMER_MISMATCH_FACT_MISSING');
  }
  const reverseOrder = quotation && (state.orders || []).find((item) => (
    item && String(item.quotationId || '') === String(quotation.id || '')
  ));
  if (blocking.has('QUOTATION_ALREADY_CONVERTED') && quotation
    && !quotation.convertedOrderId
    && String(quotation.status || '') !== '已转订单'
    && !reverseOrder) {
    errors.push('RELATION_TAMPER_CONVERSION_FACT_MISSING');
  }
  if (testCase.interaction.requestedSaveAction !== 'DO_NOT_SAVE'
    || expected.domainCanSaveFormal !== false
    || expected.saveAttempted !== false
    || expected.formalBusinessDiff !== 'ZERO_SIDE_EFFECTS') {
    errors.push('RELATION_TAMPER_ZERO_SIDE_EFFECT_CONTRACT_INVALID');
  }
}

function validateExecutionPlanPreconditions(testCase, state) {
  const errors = [];
  validatePendingEditContract(testCase, state || {}, errors);
  validateSelectionTargets(testCase, state || {}, errors);
  validateSuccessLaneContract(testCase, errors);
  validateRelationTamperContract(testCase, state || {}, errors);
  return Array.from(new Set(errors));
}

module.exports = {
  buildSelectionTargets,
  hasNonZeroBusinessDiff,
  validateExecutionPlanPreconditions
};
