const {
  activeOrderStatuses,
  activeReceivableStatuses,
  findCustomerMatches,
  getCustomerById,
  getOrderRemainingSettlement,
  getReceivablePaymentError,
  orderMatchesProduct
} = require('./business');
const { resolveConfirmationOperation } = require('./record-confirmation-contract');

function hasCustomerDiscriminator(fields = {}) {
  return Boolean(fields.phone || fields.company || fields.region || fields.customerNote || fields.wechatRemark);
}

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function candidate(item, displayName, matchReason, selectionRequired) {
  return {
    id: String(item.id || ''),
    displayName,
    matchReason,
    confidence: null,
    isExact: true,
    selectionRequired: selectionRequired === true
  };
}

function hasConfirmedUnlinkedPayment(fields, customerId) {
  return fields.allowUnlinkedPayment === true
    && Boolean(customerId)
    && fields.unlinkedPaymentCustomerId === customerId;
}

function hasConfirmedUnlinkedDeposit(fields, customerId) {
  return fields.allowUnlinkedOrderDeposit === true
    && Boolean(customerId)
    && fields.unlinkedOrderDepositCustomerId === customerId;
}

function resolveCustomerFacts(state, fields) {
  const matches = Array.isArray(state.customers) ? findCustomerMatches(state, fields) : [];
  const selected = fields.customerId ? getCustomerById(state, fields.customerId) : null;
  const hasMatchInput = Boolean(fields.customerName || fields.phone);
  const selectedMatchesInput = Boolean(selected) && (
    !hasMatchInput || matches.some((item) => item.id === selected.id)
  );
  const customerLinkMismatch = Boolean(fields.customerId) && !selectedMatchesInput;
  const customerSelectionRequired = !fields.forceNewCustomer && (
    customerLinkMismatch || (matches.length > 1 && !selectedMatchesInput)
  );
  const resolvedCustomer = selectedMatchesInput
    ? selected
    : (matches.length === 1 && !fields.forceNewCustomer ? matches[0] : null);
  return {
    matches,
    resolvedCustomer,
    customerLinkMismatch,
    customerSelectionRequired
  };
}

function resolveRecordConfirmationContext(input = {}) {
  const result = input.result || {};
  const fields = result.fields || {};
  const state = input.initialState && typeof input.initialState === 'object' ? input.initialState : null;
  const empty = {
    candidateContext: {},
    customerHistoryConfirmationRequired: false,
    customerHistoryCount: 0,
    customerHistoryKind: '',
    newCustomerDiscriminatorRequired: false,
    customerLinkMismatch: false,
    receivableLinkMismatch: false,
    orderLinkMismatch: false,
    receivableOrderLinkMismatch: false,
    receivablePaymentError: '',
    orderDepositAmountError: ''
  };
  if (!state || input.resultScope === 'AI_ONLY_RESULT') return empty;

  const candidateContext = {};
  const customerFacts = resolveCustomerFacts(state, fields);
  if (Array.isArray(state.customers) && fields.customerName) {
    candidateContext.customerCandidates = customerFacts.matches.map((item) => candidate(
      item,
      String(item.name || item.id || ''),
      'customer_name_match',
      customerFacts.customerSelectionRequired
    ));
    candidateContext.customerCandidatesResolved = true;
  }

  const customer = customerFacts.resolvedCustomer;
  const customerId = customer && customer.id;
  const operation = input.operation || resolveConfirmationOperation(result);
  let customerHistoryConfirmationRequired = false;
  let customerHistoryCount = 0;
  let customerHistoryKind = '';
  if (customerId && fields.customerHistoryConfirmed !== true && !fields.forceNewCustomer) {
    if (operation === 'create_order') {
      customerHistoryCount = (state.orders || []).filter((item) => item.customerId === customerId).length;
      customerHistoryKind = 'order';
    } else if (operation === 'create_quotation') {
      customerHistoryCount = (state.quotations || []).filter((item) => item.customerId === customerId).length;
      customerHistoryKind = 'quotation';
    } else if (operation === 'create_receivable') {
      customerHistoryCount = (state.receivables || []).filter((item) => (
        item.customerId === customerId && !['已结清', '坏账'].includes(item.status)
      )).length;
      customerHistoryKind = 'receivable';
    }
    customerHistoryConfirmationRequired = customerHistoryCount > 0;
  }

  let receivableLinkMismatch = false;
  let receivableOrderLinkMismatch = false;
  let receivablePaymentError = '';
  if (result.intent === 'payment' && operation !== 'record_order_deposit' && customerId) {
    const receivables = (state.receivables || []).filter((item) => (
      item.customerId === customerId && activeReceivableStatuses.includes(item.status)
    ));
    const selected = receivables.find((item) => item.id === fields.receivableId) || null;
    const selectedConfirmed = Boolean(selected) && fields.receivableSelectionConfirmed === true;
    receivableLinkMismatch = Boolean(fields.receivableId) && !selected;
    const selectionRequired = receivableLinkMismatch || (
      receivables.length > 0
      && !selectedConfirmed
      && !hasConfirmedUnlinkedPayment(fields, customerId)
    );
    candidateContext.receivableCandidates = receivables.map((item) => candidate(
      item,
      `待收${item.amount || '-'}元，到期${item.dueDate || '-'}`,
      'active_receivable_for_customer',
      selectionRequired
    ));
    candidateContext.receivableCandidatesResolved = true;
    if (selectedConfirmed) {
      receivablePaymentError = getReceivablePaymentError(selected, fields.paymentAmount || fields.amount) || '';
      if (selected.orderId) {
        const linkedOrder = (state.orders || []).find((item) => item.id === selected.orderId);
        receivableOrderLinkMismatch = !linkedOrder || linkedOrder.customerId !== selected.customerId;
      }
    }
  } else if (result.intent === 'payment' && operation !== 'record_order_deposit' && fields.receivableId) {
    receivableLinkMismatch = true;
  }

  let orderLinkMismatch = false;
  let orderDepositAmountError = '';
  if (operation === 'record_order_deposit' && customerId) {
    const orders = (state.orders || []).filter((item) => (
      item.customerId === customerId
      && activeOrderStatuses.includes(item.status)
      && orderMatchesProduct(item, fields.productName)
    ));
    const selected = orders.find((item) => item.id === fields.orderId) || null;
    const selectedConfirmed = Boolean(selected) && fields.orderSelectionConfirmed === true;
    orderLinkMismatch = Boolean(fields.orderId) && !selected;
    const selectionRequired = orderLinkMismatch || (
      orders.length > 0
      && !selectedConfirmed
      && !hasConfirmedUnlinkedDeposit(fields, customerId)
    );
    candidateContext.orderCandidates = orders.map((item) => candidate(
      item,
      `${item.productName || '未填产品'}，交期${item.requiredDeliveryDate || '-'}`,
      'active_order_for_deposit',
      selectionRequired
    ));
    candidateContext.orderCandidatesResolved = true;
    if (selectedConfirmed) {
      const paymentAmount = toMoney(fields.depositAmount || fields.paymentAmount);
      const remainingAmount = getOrderRemainingSettlement(state, selected);
      if (paymentAmount <= 0) orderDepositAmountError = '先填本次定金金额';
      else if (paymentAmount > remainingAmount) orderDepositAmountError = '本次定金超过订单剩余待结算金额';
    }
  } else if (operation === 'record_order_deposit' && fields.orderId) {
    orderLinkMismatch = true;
  }

  return {
    candidateContext,
    customerHistoryConfirmationRequired,
    customerHistoryCount,
    customerHistoryKind,
    newCustomerDiscriminatorRequired: fields.forceNewCustomer === true
      && !hasCustomerDiscriminator(fields),
    customerLinkMismatch: customerFacts.customerLinkMismatch,
    receivableLinkMismatch,
    orderLinkMismatch,
    receivableOrderLinkMismatch,
    receivablePaymentError,
    orderDepositAmountError
  };
}

module.exports = {
  resolveRecordConfirmationContext
};
