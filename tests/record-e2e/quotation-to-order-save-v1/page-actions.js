const {
  invokeResolvedPageAction,
  resolvePageAction
} = require('../runner/page-action-registry');

function quotationEvent(id) {
  return { currentTarget: { dataset: { id } } };
}

function deliveryEvent(value) {
  return { detail: { value } };
}

function resolveConfirm(page) {
  return resolvePageAction({
    availablePageMethods: page,
    editMode: 'CREATE',
    entrySurface: 'QUOTATION_LIST',
    requestedAction: 'CONVERT_QUOTATION_TO_ORDER'
  });
}

function invokeConfirm(driver, quotationId) {
  const resolution = resolveConfirm(driver.page);
  return invokeResolvedPageAction(driver.page, resolution, {
    args: [quotationEvent(quotationId)],
    readMethodCount: () => driver.evidence.pageMethodCalls.confirmConvert || 0
  });
}

function beginConversion(page, quotationId, deliveryDate) {
  page.startConvert(quotationEvent(quotationId));
  if (page.data.convertingQuotationId === quotationId) {
    page.changeConversionDeliveryDate(deliveryEvent(deliveryDate));
    return true;
  }
  return false;
}

module.exports = {
  beginConversion,
  deliveryEvent,
  invokeConfirm,
  quotationEvent,
  resolveConfirm
};
