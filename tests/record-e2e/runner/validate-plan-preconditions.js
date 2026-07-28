const SUCCESS_DEPENDENT_LANES = new Set([
  'RESTART_PERSISTENCE',
  'TRANSACTION_EXACT_REPLAY',
  'CONCURRENT_BASE_REVISION'
]);

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

function validateFormalOrderContract(testCase, errors) {
  const result = testCase.expected.result;
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
    if (testCase.expected.result.businessType === 'order'
      && pageB && !hasExplicitChineseDate(pageB.input.originalText)) {
      errors.push('CONCURRENT_PAGE_B_DUE_DATE_INPUT_MISSING');
    }
  }
}

function validateExecutionPlanPreconditions(testCase, state) {
  const errors = [];
  validatePendingEditContract(testCase, state || {}, errors);
  validateSuccessLaneContract(testCase, errors);
  return Array.from(new Set(errors));
}

module.exports = {
  hasNonZeroBusinessDiff,
  validateExecutionPlanPreconditions
};
