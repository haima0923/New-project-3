const RECEIVABLE_PAYMENT_KINDS = Object.freeze({
  FINAL: 'final_payment',
  PARTIAL: 'partial_payment'
});

const RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS = Object.freeze({
  INVALID_PAYMENT_AMOUNT: 'PAYMENT_AMOUNT_INVALID',
  INVALID_REMAINING_BALANCE: 'RECEIVABLE_REMAINING_BALANCE_INVALID',
  NON_POSITIVE_PAYMENT_AMOUNT: 'PAYMENT_AMOUNT_NON_POSITIVE',
  RECEIVABLE_ALREADY_SETTLED: 'RECEIVABLE_ALREADY_SETTLED',
  RECEIVABLE_LINK_REQUIRED: 'RECEIVABLE_LINK_REQUIRED',
  PAYMENT_EXCEEDS_REMAINING: 'PAYMENT_EXCEEDS_REMAINING'
});

function normalizeMoneyToCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { valid: false, cents: 0, amount: 0 };
  const amount = Number(numeric.toFixed(2));
  return { valid: true, cents: Math.round(amount * 100), amount };
}

function getReceivableRemainingBalance(totalAmount, paidAmount) {
  const total = normalizeMoneyToCents(totalAmount);
  const paid = normalizeMoneyToCents(paidAmount);
  if (!total.valid || !paid.valid || total.cents < 0 || paid.cents < 0) {
    return {
      valid: false,
      remainingAmount: 0,
      remainingCents: 0,
      totalAmount: total.amount,
      totalCents: total.cents,
      paidAmount: paid.amount,
      paidCents: paid.cents
    };
  }
  const remainingCents = total.cents - paid.cents;
  return {
    valid: remainingCents >= 0,
    remainingAmount: remainingCents / 100,
    remainingCents,
    totalAmount: total.amount,
    totalCents: total.cents,
    paidAmount: paid.amount,
    paidCents: paid.cents
  };
}

function classificationError(errorCode, details = {}) {
  return Object.assign({
    ok: false,
    kind: '',
    classificationReason: '',
    errorCode,
    normalizedPaymentAmount: 0,
    normalizedRemainingBefore: 0,
    remainingAfter: 0,
    paymentAmountCents: 0,
    remainingBeforeCents: 0,
    remainingAfterCents: 0
  }, details);
}

function deriveReceivablePaymentKind(input = {}) {
  const payment = normalizeMoneyToCents(input.paymentAmount);
  const remaining = normalizeMoneyToCents(input.remainingBefore);
  const audit = {
    isLinkedReceivable: input.isLinkedReceivable === true,
    isLegacyReceivable: input.isLegacyReceivable === true,
    normalizedPaymentAmount: payment.amount,
    normalizedRemainingBefore: remaining.amount,
    paymentAmountCents: payment.cents,
    remainingBeforeCents: remaining.cents
  };
  if (!audit.isLinkedReceivable) return classificationError(RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.RECEIVABLE_LINK_REQUIRED, audit);
  if (!payment.valid) return classificationError(RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.INVALID_PAYMENT_AMOUNT, audit);
  if (!remaining.valid || remaining.cents < 0) return classificationError(RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.INVALID_REMAINING_BALANCE, audit);
  if (payment.cents <= 0) return classificationError(RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.NON_POSITIVE_PAYMENT_AMOUNT, audit);
  if (remaining.cents <= 0) return classificationError(RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.RECEIVABLE_ALREADY_SETTLED, audit);
  if (payment.cents > remaining.cents) return classificationError(RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.PAYMENT_EXCEEDS_REMAINING, audit);
  const remainingAfterCents = remaining.cents - payment.cents;
  const isFinal = remainingAfterCents === 0;
  return Object.assign({}, audit, {
    ok: true,
    kind: isFinal ? RECEIVABLE_PAYMENT_KINDS.FINAL : RECEIVABLE_PAYMENT_KINDS.PARTIAL,
    classificationReason: isFinal ? 'PAYMENT_EQUALS_REMAINING_BALANCE' : 'PAYMENT_BELOW_REMAINING_BALANCE',
    errorCode: '',
    remainingAfter: remainingAfterCents / 100,
    remainingAfterCents
  });
}

module.exports = {
  RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS,
  RECEIVABLE_PAYMENT_KINDS,
  deriveReceivablePaymentKind,
  getReceivableRemainingBalance,
  normalizeMoneyToCents
};
