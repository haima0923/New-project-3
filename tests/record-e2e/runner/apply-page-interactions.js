const { safeClone } = require('../../../utils/record-state-diff');
const { flushAsync } = require('./page-vm-driver');
const { resolvePageSelection } = require('./page-action-registry');

function eventForValue(value, dataset = {}) {
  return {
    currentTarget: { dataset },
    detail: { value }
  };
}

function indexForId(options, selectedId) {
  return (options || []).findIndex((item) => item && item.id === selectedId);
}

function captureEditProjection(page) {
  const result = page.data.parseResult || {};
  const fields = result.fields || page.data.fields || {};
  const items = Array.isArray(fields.items) ? fields.items : [];
  const firstItem = items[0] && typeof items[0] === 'object' ? items[0] : {};
  return {
    confirmedFields: safeClone(result.manual_fields || []),
    derivedAmount: {
      calculatedAmount: fields.calculatedAmount || '',
      itemTotalAmount: firstItem.totalAmount || '',
      topLevelAmount: fields.amount || fields.totalAmount || ''
    },
    item0: safeClone({
      productName: firstItem.productName || '',
      quantity: firstItem.quantity || '',
      unit: firstItem.unit || '',
      unitPrice: firstItem.unitPrice || '',
      totalAmount: firstItem.totalAmount || ''
    }),
    itemsLength: items.length,
    originalText: result.original_text || result.originalText || '',
    preflight: {
      blockingCodes: safeClone(page.data.preflightBlockingReasons || []),
      domainCanSaveFormal: page.data.domainCanSaveFormal === true,
      effectiveCanSaveFormal: page.data.disableQuickSave !== true
        && page.data.disableFormalSave !== true,
      fingerprint: page.data.preflightFingerprint || ''
    },
    topLevel: safeClone({
      productName: fields.productName || '',
      quantity: fields.quantity || '',
      unit: fields.unit || '',
      unitPrice: fields.unitPrice || '',
      amount: fields.amount || fields.totalAmount || ''
    })
  };
}

function captureSelectionPreflight(page, driverEvidence = {}) {
  const fields = page.data.fields || {};
  const primaryCalls = driverEvidence.pagePrimaryActionCalls || {};
  const businessCalls = driverEvidence.productionBusinessCalls || {};
  const storageCalls = driverEvidence.productionStorageCalls || {};
  return {
    blockingCodes: safeClone(page.data.preflightBlockingReasons || []),
    businessSaveInvocationCount: Number(businessCalls.saveConfirmedDraft || 0),
    candidateIds: safeClone({
      orders: (page.data.orderOptions || []).map((item) => item && item.id).filter(Boolean),
      quotations: (page.data.quotationOptions || []).map((item) => item && item.id).filter(Boolean),
      receivables: (page.data.receivableOptions || []).map((item) => item && item.id).filter(Boolean)
    }),
    domainCanSaveFormal: page.data.domainCanSaveFormal === true,
    effectiveCanSaveFormal: page.data.disableQuickSave !== true
      && page.data.disableFormalSave !== true,
    fingerprint: page.data.preflightFingerprint || '',
    formalSaveInvocationCount: Number(primaryCalls.saveFormal || 0),
    orderSelectionConfirmed: fields.orderSelectionConfirmed === true,
    productionStorageWriteCount: Number(storageCalls.saveState || 0),
    requiredSelections: safeClone(
      page.data.domainPreflight && page.data.domainPreflight.requiredSelections || []
    ),
    selectedOrderId: String(fields.orderId || page.data.selectedOrderId || '')
  };
}

async function applySelection(driver, selection, evidence) {
  const { page, surface } = driver;
  const kind = selection.kind;
  let method = '';
  let options = [];
  let depositOperation = false;
  if (kind === 'customerId') {
    method = 'changeCustomerMatch';
    options = page.data.customerMatchOptions;
  } else if (kind === 'receivableId') {
    method = 'changeReceivable';
    options = page.data.receivableOptions;
  } else if (kind === 'orderId') {
    depositOperation = page.data.parseResult
      && page.data.parseResult.operation === 'record_order_deposit';
    if (depositOperation) {
      const resolution = resolvePageSelection({
        availablePageMethods: page,
        capability: 'SELECT_DEPOSIT_ORDER',
        entrySurface: surface,
        selectionKind: kind
      });
      method = resolution.resolvedMethodName;
      options = page.data[resolution.optionsKey];
    } else {
      if (page.data.showGenericOrderSelection !== true
        || page.data.showGenericOrderPicker !== true) {
        return {
          applied: false,
          reason: 'PAGE_INTERACTION_NOT_VISIBLE',
          surface,
          kind,
          selectedId: selection.selectedId
        };
      }
      const resolution = resolvePageSelection({
        availablePageMethods: page,
        capability: 'SELECT_ORDER',
        entrySurface: surface,
        selectionKind: kind
      });
      method = resolution.resolvedMethodName;
      options = page.data[resolution.optionsKey];
    }
  } else if (kind === 'quotationId') {
    if (page.data.showGenericQuotationSelection !== true
      || page.data.showGenericQuotationPicker !== true) {
      return {
        applied: false,
        reason: 'PAGE_INTERACTION_NOT_VISIBLE',
        surface,
        kind,
        selectedId: selection.selectedId
      };
    }
    const resolution = resolvePageSelection({
      availablePageMethods: page,
      capability: 'SELECT_QUOTATION',
      entrySurface: surface,
      selectionKind: kind
    });
    method = resolution.resolvedMethodName;
    options = page.data[resolution.optionsKey];
  }
  const candidateIds = (options || [])
    .map((item) => item && item.id)
    .filter(Boolean);
  if (Array.isArray(selection.expectedCandidateIds)
    && JSON.stringify(candidateIds) !== JSON.stringify(selection.expectedCandidateIds)) {
    return {
      applied: false,
      reason: 'CANDIDATE_SET_MISMATCH',
      surface,
      kind,
      selectedId: selection.selectedId,
      candidateIds,
      expectedCandidateIds: selection.expectedCandidateIds.slice()
    };
  }
  if (Array.isArray(selection.rejectedCandidateIds)
    && selection.rejectedCandidateIds.some((candidateId) => (
      candidateIds.includes(candidateId)
    ))) {
    return {
      applied: false,
      reason: 'REJECTED_CANDIDATE_EXPOSED',
      surface,
      kind,
      selectedId: selection.selectedId,
      candidateIds,
      rejectedCandidateIds: selection.rejectedCandidateIds.slice()
    };
  }
  if (!method || typeof page[method] !== 'function') {
    return {
      applied: false,
      reason: 'MISSING_PAGE_CAPABILITY',
      surface,
      kind,
      selectedId: selection.selectedId
    };
  }
  const index = indexForId(options, selection.selectedId);
  if (index < 0) {
    return {
      applied: false,
      reason: 'CANDIDATE_NOT_PRESENT',
      surface,
      kind,
      selectedId: selection.selectedId,
      candidateIds
    };
  }
  const preSelectionPreflight = captureSelectionPreflight(page, driver.evidence);
  const methodInvocationCountBefore = Number(
    driver.evidence.pageMethodCalls[method] || 0
  );
  const accepted = page[method](eventForValue(index));
  await flushAsync();
  const methodInvocationCountAfter = Number(
    driver.evidence.pageMethodCalls[method] || 0
  );
  const methodInvocationDelta = methodInvocationCountAfter - methodInvocationCountBefore;
  if (methodInvocationDelta !== 1) {
    throw Object.assign(
      new Error(`Page selection method ${method} invoked ${methodInvocationDelta} times, expected 1`),
      { code: 'AUTOMATION_DRIVER_ERROR' }
    );
  }
  const postSelectionPreflight = captureSelectionPreflight(page, driver.evidence);
  if (kind === 'orderId' && !depositOperation) {
    const actualOrderId = String(
      (page.data.fields && page.data.fields.orderId)
      || page.data.selectedOrderId
      || ''
    );
    if (accepted === false || actualOrderId !== String(selection.selectedId)) {
      return {
        applied: false,
        reason: 'PAGE_SELECTION_REJECTED',
        surface,
        kind,
        method,
        selectedId: selection.selectedId,
        actualSelectedId: actualOrderId
      };
    }
  }
  if (kind === 'quotationId') {
    const actualQuotationId = String(
      (page.data.fields && page.data.fields.quotationId)
      || page.data.selectedQuotationId
      || ''
    );
    if (accepted === false || actualQuotationId !== String(selection.selectedId)) {
      return {
        applied: false,
        reason: 'PAGE_SELECTION_REJECTED',
        surface,
        kind,
        method,
        selectedId: selection.selectedId,
        actualSelectedId: actualQuotationId
      };
    }
  }
  const item = {
    applied: true,
    kind,
    method,
    methodInvocationCountAfter,
    methodInvocationCountBefore,
    methodInvocationDelta,
    postSelectionPreflight,
    preSelectionPreflight,
    selectedId: selection.selectedId,
    candidateIds
  };
  evidence.selections.push(item);
  return item;
}

async function applyEdit(driver, edit, evidence, hooks = {}) {
  const { page, surface } = driver;
  if (hooks.directAssignEdit === true) {
    throw Object.assign(new Error('Direct page-data assignment is not a valid page interaction'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  if (hooks.skipPageEditMethod === true) {
    return {
      applied: false,
      reason: 'DRIVER_METHOD_SKIPPED',
      field: edit.field
    };
  }
  let method;
  let event;
  if (edit.scope === 'ITEM') {
    method = 'updateItemField';
    event = eventForValue(edit.value, {
      index: edit.itemIndex,
      field: edit.field
    });
  } else if (edit.field === 'dueDate') {
    method = surface === 'HOME_QUICK' ? 'changeConfirmDate' : 'changeDateField';
    event = eventForValue(edit.value, { field: edit.field });
  } else {
    method = surface === 'HOME_QUICK' ? 'updateConfirmField' : 'updateField';
    event = eventForValue(edit.value, { field: edit.field });
  }
  if (typeof page[method] !== 'function') {
    return {
      applied: false,
      reason: 'MISSING_PAGE_METHOD',
      field: edit.field,
      method
    };
  }
  const projectionBefore = captureEditProjection(page);
  const invocationCountBefore = Number(
    driver.evidence.pageMethodCalls[method] || 0
  );
  page[method](event);
  if (hooks.repeatPageEditMethod === true) page[method](event);
  await flushAsync();
  const projectionAfter = captureEditProjection(page);
  const invocationCountAfter = Number(
    driver.evidence.pageMethodCalls[method] || 0
  );
  const methodInvocationDelta = invocationCountAfter - invocationCountBefore;
  if (methodInvocationDelta !== 1) {
    throw Object.assign(
      new Error(`Page edit method ${method} invoked ${methodInvocationDelta} times, expected 1`),
      { code: 'AUTOMATION_DRIVER_ERROR' }
    );
  }
  const item = {
    applied: true,
    field: edit.field,
    itemIndex: edit.itemIndex,
    method,
    methodInvocationCountAfter: invocationCountAfter,
    methodInvocationCountBefore: invocationCountBefore,
    methodInvocationDelta,
    projectionAfter,
    projectionBefore,
    scope: edit.scope,
    value: safeClone(edit.value)
  };
  evidence.edits.push(item);
  return item;
}

async function applyPageInteractions(driver, interaction, hooks = {}) {
  const evidence = {
    edits: [],
    selections: []
  };
  const failures = [];
  for (const selection of (interaction.userSelections || [])) {
    const result = await applySelection(driver, selection, evidence);
    if (!result.applied) failures.push(result);
  }
  for (const edit of (interaction.userEdits || [])) {
    const result = await applyEdit(driver, edit, evidence, hooks);
    if (!result.applied) failures.push(result);
  }
  return {
    evidence,
    failures
  };
}

module.exports = {
  applyPageInteractions
};
