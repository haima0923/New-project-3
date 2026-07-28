const { safeClone } = require('../../../utils/record-state-diff');
const { flushAsync } = require('./page-vm-driver');

function eventForValue(value, dataset = {}) {
  return {
    currentTarget: { dataset },
    detail: { value }
  };
}

function indexForId(options, selectedId) {
  return (options || []).findIndex((item) => item && item.id === selectedId);
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
      method = 'changeOrderDeposit';
      options = page.data.orderOptions;
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
      method = 'changeOrder';
      options = page.data.orderOptions;
    }
  } else if (kind === 'quotationId') {
    method = 'changeQuotation';
    options = page.data.quotationOptions;
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
      candidateIds: (options || []).map((item) => item && item.id).filter(Boolean)
    };
  }
  const accepted = page[method](eventForValue(index));
  await flushAsync();
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
  const item = {
    applied: true,
    kind,
    method,
    selectedId: selection.selectedId
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
  page[method](event);
  await flushAsync();
  const item = {
    applied: true,
    field: edit.field,
    itemIndex: edit.itemIndex,
    method,
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
