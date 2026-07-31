const RUNTIME_FIELD_BY_CANONICAL_FIELD = Object.freeze({
  depositAmount: 'depositAmount',
  orderDeliveryDate: 'dueDate',
  paymentDate: 'dueDate',
  receivableAmount: 'amount',
  receivableDueDate: 'dueDate',
  todoRemindDate: 'dueDate'
});

// Missing/conflict arrays historically used their runtime names verbatim.
// Keep this new normalization deliberately scoped to the declared order
// delivery-date alias so unrelated assertion sets do not change.
const CANONICAL_ASSERTION_FIELD_BY_RUNTIME_ALIAS_BY_OPERATION = Object.freeze({
  create_order: Object.freeze({
    dueDate: 'orderDeliveryDate'
  }),
  update_order: Object.freeze({
    dueDate: 'orderDeliveryDate'
  })
});

// This preserves the validator's established canonical Expected contract.
// `pending.dueDate` has no safe business-specific canonical projection.
const NON_CANONICAL_EXPECTED_FIELDS_BY_OPERATION = Object.freeze({
  record_payment: Object.freeze(['amount', 'paidAt']),
  record_order_deposit: Object.freeze(['amount', 'paymentAmount', 'paidAt']),
  create_order: Object.freeze(['dueDate']),
  update_order: Object.freeze(['dueDate']),
  create_quotation: Object.freeze(['dueDate']),
  update_quotation: Object.freeze(['dueDate']),
  create_receivable: Object.freeze(['amount', 'dueDate']),
  create_receivable_with_payment: Object.freeze(['amount', 'dueDate']),
  create_todo: Object.freeze(['dueDate']),
  pending: Object.freeze(['dueDate', 'paidAt'])
});

function replaceRootField(path, replacement) {
  const input = String(path || '');
  const match = input.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!match || !replacement || replacement === match[0]) return input;
  return `${replacement}${input.slice(match[0].length)}`;
}

function canonicalizeFieldPath(path, operation) {
  const input = String(path || '');
  const match = input.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!match) return input;
  const aliases = CANONICAL_ASSERTION_FIELD_BY_RUNTIME_ALIAS_BY_OPERATION[operation] || {};
  return replaceRootField(input, aliases[match[0]]);
}

function normalizeFieldPaths(value, operation) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((field) => canonicalizeFieldPath(field, operation))
  )).sort();
}

function runtimeFieldPathForCanonical(path) {
  const input = String(path || '');
  const match = input.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!match) return input;
  return replaceRootField(input, RUNTIME_FIELD_BY_CANONICAL_FIELD[match[0]]);
}

function nonCanonicalExpectedFieldsForOperation(operation) {
  return new Set(NON_CANONICAL_EXPECTED_FIELDS_BY_OPERATION[operation] || []);
}

module.exports = {
  CANONICAL_ASSERTION_FIELD_BY_RUNTIME_ALIAS_BY_OPERATION,
  NON_CANONICAL_EXPECTED_FIELDS_BY_OPERATION,
  RUNTIME_FIELD_BY_CANONICAL_FIELD,
  canonicalizeFieldPath,
  nonCanonicalExpectedFieldsForOperation,
  normalizeFieldPaths,
  runtimeFieldPathForCanonical
};
