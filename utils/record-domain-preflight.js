const {
  applyFinalParseSafety,
  evaluateUserResolvedAiState
} = require('./parse-safety');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const {
  RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS,
  deriveReceivablePaymentKind,
  getReceivableRemainingBalance,
  normalizeMoneyToCents
} = require('./payment-kind');
const { unitsMatch } = require('./units');

const PREFLIGHT_SCHEMA_VERSION = 'record-domain-preflight-v1';
const PRODUCTION_MODE = 'PRODUCTION_ROUTING';
const PRODUCTION_SCOPE = 'PRODUCTION_RESULT';
const ACTIVE_ORDER_STATUSES = Object.freeze(['待生产', '生产中', '待发货', '已发货']);
const EXPLICIT_ORDER_REFERENCE_KINDS = Object.freeze([
  'EXPLICIT_ORDER_DEICTIC',
  'EXPLICIT_ORDER_IDENTIFIER',
  'EXPLICIT_ORDER_NAMED_REFERENCE'
]);
const EXPLICIT_QUOTATION_REFERENCE_KINDS = Object.freeze([
  'EXPLICIT_QUOTATION_DEICTIC',
  'EXPLICIT_QUOTATION_NAMED_REFERENCE'
]);
const ORDER_REFERENCE_SOURCE_FIELDS = Object.freeze([
  'ORIGINAL_TEXT',
  'EXTRACTED_TEXT'
]);
const QUOTATION_REFERENCE_SOURCE_FIELDS = Object.freeze([
  'ORIGINAL_TEXT',
  'EXTRACTED_TEXT'
]);
const ACTIVE_RECEIVABLE_STATUSES = Object.freeze(['待收', '部分收款']);
const ACTIVE_QUOTATION_STATUS = '待确认';
const CONVERTED_QUOTATION_STATUSES = Object.freeze(['converted', 'ordered', '已转订单', '已下单']);
const INACTIVE_QUOTATION_STATUSES = Object.freeze(['cancelled', 'canceled', 'void', '已作废', '已取消', '已失效']);
const QUOTATION_ORDER_RELATION_STATES = Object.freeze({
  CLEAN_EXISTING: 'CLEAN_EXISTING',
  DATA_CONFLICT: 'DATA_CONFLICT',
  NONE: 'NONE'
});

function safeClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return (values || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function stableSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function stableFingerprint(value) {
  const text = stableSerialize(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `rdp1_${hash.toString(16).padStart(8, '0')}`;
}

function compactFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(compactFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).reduce((result, key) => {
    const current = value[key];
    if (current === undefined || current === null || current === '') return result;
    result[key] = compactFingerprintValue(current);
    return result;
  }, {});
}

function normalizeFieldsForFingerprint(fields = {}) {
  const normalized = compactFingerprintValue(fields);
  if (Array.isArray(normalized.items)) {
    normalized.items = normalized.items.map((item) => {
      const next = Object.assign({}, item);
      delete next.confirmationItemKey;
      delete next.confirmationItemOrigin;
      return next;
    });
  }
  const resolvedTotalAmount = resolveDraftTotalAmount(fields);
  // Relation IDs can be deterministically hydrated by a surface or by business
  // immediately before preflight.  The authoritative relation identity already
  // lives in resolvedRelations, so keeping the raw IDs here would make otherwise
  // identical preflights produce different fingerprints.
  delete normalized.customerId;
  delete normalized.quotationId;
  delete normalized.orderId;
  delete normalized.receivableId;
  delete normalized.calculatedAmount;
  delete normalized.calculated_amount;
  if (hasValue(resolvedTotalAmount)) normalized.resolvedTotalAmount = resolvedTotalAmount;
  return normalized;
}

function getTrustedRecordFlowContext(result = {}) {
  const value = result && result.record_flow_context;
  if (!value || typeof value !== 'object') return {};
  if (value.schemaVersion !== 'record-flow-context-v1' || value.generatedBySharedCore !== true) return {};
  if (!['PRODUCTION_ROUTING', 'LOCAL_ONLY', 'AI_ONLY'].includes(value.mode)) return {};
  if (!['PRODUCTION_RESULT', 'LOCAL_ONLY_RESULT', 'AI_ONLY_RESULT'].includes(value.resultScope)) return {};
  if (!['NONE', 'REAL', 'MOCK', 'FAKE', 'REPLAY', 'UNKNOWN'].includes(value.providerKind)) return {};
  return value;
}

function simpleFingerprint(value) {
  const source = String(value || '').replace(/\s+/g, '');
  if (!source) return '';
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash) + source.charCodeAt(index);
    hash &= 0xffffffff;
  }
  return `fp_${Math.abs(hash)}`;
}

function normalizeCustomerNameForMatch(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/(?:老板|先生|女士|总)$/, '');
}

function getCustomerNameMatchKind(customer, customerName) {
  if (!customer || !customerName) return 'NONE';
  const currentName = String(customer.name || '').trim().replace(/\s+/g, '');
  const nextName = String(customerName || '').trim().replace(/\s+/g, '');
  if (!currentName || !nextName) return 'NONE';
  if (currentName === nextName || currentName.replace(/总$/, '') === nextName.replace(/总$/, '')) return 'EXACT';
  return normalizeCustomerNameForMatch(currentName) === normalizeCustomerNameForMatch(nextName)
    ? 'SIMILAR'
    : 'NONE';
}

function customerNameMatches(customer, customerName) {
  if (!customer || !customerName) return true;
  const currentName = String(customer.name || '');
  const nextName = String(customerName || '');
  const currentCompact = normalizeCustomerNameForMatch(currentName);
  const nextCompact = normalizeCustomerNameForMatch(nextName);
  return currentName === nextName
    || currentCompact === nextCompact
    || (currentCompact.length >= 2 && nextName.includes(currentCompact))
    || (nextCompact.length >= 2 && currentName.includes(nextCompact));
}

function getActiveCustomers(state = {}) {
  return (state.customers || []).filter((customer) => !customer.mergedInto);
}

function getCustomerById(state = {}, id) {
  return getActiveCustomers(state).find((customer) => String(customer.id || '') === String(id || '')) || null;
}

function findCustomerMatches(state = {}, fields = {}) {
  const customers = getActiveCustomers(state);
  const phoneFingerprint = simpleFingerprint(fields.phone);
  if (phoneFingerprint) {
    return customers.filter((customer) => (
      customer.phoneFingerprint === phoneFingerprint && customerNameMatches(customer, fields.customerName)
    ));
  }
  if (!fields.customerName) return [];
  return customers.filter((customer) => customerNameMatches(customer, fields.customerName));
}

function orderMatchesProduct(order = {}, productName) {
  if (!productName) return true;
  const source = String(productName || '').replace(/\s+/g, '');
  const current = String(order.productName || '').replace(/\s+/g, '');
  if (!source || !current) return true;
  return source === current || source.includes(current) || current.includes(source);
}

function getExplicitOrderReference(result = {}) {
  const relationReferences = result.relation_references;
  const reference = relationReferences && relationReferences.order;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return null;
  if (String(reference.entityType || '').toUpperCase() !== 'ORDER') return null;
  if (reference.explicit !== true || reference.requiresResolution !== true) return null;
  if (!EXPLICIT_ORDER_REFERENCE_KINDS.includes(String(reference.kind || ''))) return null;
  if (reference.evidenceSource !== 'LOCAL_PARSER') return null;
  if (reference.resolvedEntityId !== null) return null;
  if (!ORDER_REFERENCE_SOURCE_FIELDS.includes(String(reference.sourceField || ''))) return null;
  if (!String(reference.sourceText || '').trim()) return null;
  if (!String(reference.normalizedReference || '').trim()) return null;
  if (!Number.isFinite(Number(reference.confidence))
    || Number(reference.confidence) <= 0
    || Number(reference.confidence) > 1) return null;
  const sourceSpan = reference.sourceSpan;
  if (!sourceSpan || typeof sourceSpan !== 'object' || Array.isArray(sourceSpan)) return null;
  if (!Number.isInteger(sourceSpan.start)
    || !Number.isInteger(sourceSpan.end)
    || sourceSpan.start < 0
    || sourceSpan.end <= sourceSpan.start
    || sourceSpan.end - sourceSpan.start !== String(reference.sourceText).length) return null;
  return reference;
}

function getExplicitQuotationConversionEvidence(result = {}) {
  const evidence = result.intent_evidence;
  const signals = evidence && Array.isArray(evidence.quotationToOrderConversionSignals)
    ? evidence.quotationToOrderConversionSignals
    : [];
  return signals.find((signal) => {
    if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return false;
    if (signal.kind !== 'QUOTATION_TO_ORDER_CONVERSION'
      || signal.direction !== 'QUOTATION_TO_ORDER'
      || signal.explicit !== true
      || signal.evidenceSource !== 'LOCAL_PARSER') return false;
    if (!QUOTATION_REFERENCE_SOURCE_FIELDS.includes(String(signal.sourceField || ''))) return false;
    if (!String(signal.sourceText || '').trim()) return false;
    const sourceSpan = signal.sourceSpan;
    return Boolean(sourceSpan
      && Number.isInteger(sourceSpan.start)
      && Number.isInteger(sourceSpan.end)
      && sourceSpan.start >= 0
      && sourceSpan.end > sourceSpan.start
      && sourceSpan.end - sourceSpan.start === String(signal.sourceText).length);
  }) || null;
}

function getExplicitQuotationReference(result = {}) {
  const relationReferences = result.relation_references;
  const reference = relationReferences && relationReferences.quotation;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return null;
  if (String(reference.entityType || '').toUpperCase() !== 'QUOTATION') return null;
  if (reference.explicit !== true || reference.requiresResolution !== true) return null;
  if (!EXPLICIT_QUOTATION_REFERENCE_KINDS.includes(String(reference.kind || ''))) return null;
  if (reference.evidenceSource !== 'LOCAL_PARSER' || reference.resolvedEntityId !== null) return null;
  if (!QUOTATION_REFERENCE_SOURCE_FIELDS.includes(String(reference.sourceField || ''))) return null;
  if (!String(reference.sourceText || '').trim()
    || !String(reference.normalizedReference || '').trim()) return null;
  const confidence = Number(reference.confidence);
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) return null;
  const sourceSpan = reference.sourceSpan;
  if (!sourceSpan || typeof sourceSpan !== 'object' || Array.isArray(sourceSpan)) return null;
  if (!Number.isInteger(sourceSpan.start)
    || !Number.isInteger(sourceSpan.end)
    || sourceSpan.start < 0
    || sourceSpan.end <= sourceSpan.start
    || sourceSpan.end - sourceSpan.start !== String(reference.sourceText).length) return null;
  return reference;
}

function requiresExplicitQuotationResolution(operation, businessType, result = {}) {
  return operation === 'create_order'
    && businessType === 'order'
    && Boolean(getExplicitQuotationConversionEvidence(result))
    && Boolean(getExplicitQuotationReference(result));
}

function requiresExplicitReceivableOrderResolution(operation, businessType, result = {}) {
  return operation === 'create_receivable'
    && businessType === 'receivable'
    && Boolean(getExplicitOrderReference(result));
}

function getDeletedOrderIds(state = {}) {
  return new Set((state.deletedRecords || [])
    .filter((item) => String(item && item.recordType || '').toLowerCase() === 'order')
    .map((item) => String(item.recordId || item.id || ''))
    .filter(Boolean));
}

function isOrderSelectableForRelation(state, order, customerId, productName) {
  if (!order || typeof order !== 'object') return false;
  if (order.deletedAt || order.deleted === true || order.isDeleted === true) return false;
  if (getDeletedOrderIds(state).has(String(order.id || ''))) return false;
  return ACTIVE_ORDER_STATUSES.includes(order.status)
    && (!customerId || order.customerId === customerId)
    && orderMatchesProduct(order, productName);
}

function toMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function parseStrictMoney(value) {
  if (!hasValue(value) || (typeof value === 'string' && !value.trim())) {
    return { valid: false, value: 0, reason: 'EMPTY' };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return { valid: false, value: 0, reason: 'NOT_FINITE' };
  return { valid: number > 0, value: Number(number.toFixed(2)), reason: number > 0 ? '' : 'NOT_POSITIVE' };
}

function resolveDraftTotalAmount(fields = {}) {
  const items = Array.isArray(fields.items) ? fields.items : [];
  const itemTotals = items.map((item) => Number(item && (item.totalAmount || item.total_amount || item.amount)));
  const calculatedItemsTotal = items.length && itemTotals.every(Number.isFinite)
    ? itemTotals.reduce((sum, amount) => sum + amount, 0)
    : '';
  const firstItemTotal = items.length <= 1 && items[0]
    ? (items[0].totalAmount || items[0].total_amount || items[0].amount || '')
    : '';
  return fields.amount
    || fields.totalAmount
    || fields.statedAmount
    || calculatedItemsTotal
    || firstItemTotal
    || fields.calculatedAmount
    || '';
}

function getExplicitOrderTotalEvidenceCents(result = {}) {
  const originalText = String(
    result.original_text || ((result.fields || {}).originalText) || ((result.fields || {}).original_text) || ''
  );
  const matches = Array.from(originalText.matchAll(new RegExp(
    `(?:(?:最后(?:确认)?|最终(?:确认)?|优惠后)\\s*)?(?:总金额|订单金额|整单金额|这单金额|总价|总计|合计|一共|总共|金额)\\s*(?:是|为|共|改成|改为)?\\s*(${numberPattern()})\\s*(万元|元|块钱|块)?(?=$|[，,。；;\\s]|为准|后|前|交|发|出|拿|结)`,
    'g'
  )));
  const evidence = matches.filter((item) => {
    const prefix = originalText.slice(Math.max(0, Number(item.index || 0) - 12), Number(item.index || 0));
    return !/(?:单价|价格|报价|优惠后?|折扣|运费|货款|已付|付了|付款|已收|收了|收到|收款|到账|定金|订金|预付款?|还欠|尚欠|欠款|待收|应收|尾款)\s*$/.test(prefix);
  }).map((item) => {
    const amount = parseChineseNumber(
      `${item[1]}${item[2] && item[2].includes('万') && !String(item[1]).includes('万') ? '万' : ''}`
    );
    const normalized = normalizeMoneyToCents(amount);
    return normalized.valid ? { cents: normalized.cents, match: item } : null;
  }).filter(Boolean);
  const last = evidence[evidence.length - 1];
  const previous = evidence[evidence.length - 2];
  const resolutionPrefix = previous && last
    ? originalText.slice(
      Number(previous.match.index || 0) + previous.match[0].length,
      Number(last.match.index || 0)
    )
    : '';
  const resolutionSuffix = last
    ? originalText.slice(Number(last.match.index || 0) + last.match[0].length)
    : '';
  const lastMatchText = last ? String(last.match[0] || '').trim() : '';
  const hasInlineResolution = /^(?:最后(?:确认)?|最终(?:确认)?|优惠后)/.test(lastMatchText)
    || /(?:总金额|订单金额|整单金额|这单金额|总价|总计|合计|一共|总共|金额)\s*(?:改成|改为)/.test(lastMatchText);
  const hasAdjacentResolution = /^(?:[，,。；;\s]*(?:不对|更正|改成|改为)[，,。；;\s]*)+$/.test(resolutionPrefix);
  const hasBoundFinalValue = /(?:^|[，,。；;\s])以\s*$/.test(resolutionPrefix)
    && /^\s*为准/.test(resolutionSuffix);
  const lastAmountIsResolved = !previous
    || hasInlineResolution
    || hasAdjacentResolution
    || hasBoundFinalValue;
  return {
    cents: last ? [last.cents] : [],
    conflict: new Set(evidence.map((item) => item.cents)).size > 1 && !lastAmountIsResolved
  };
}

function hasManuallyConfirmedOrderTotal(result = {}, fields = {}) {
  return Array.isArray(result.manual_fields)
    && result.manual_fields.includes('amount')
    && hasValue(fields.amount);
}

function calculateCanonicalOrderItemsTotal(fields = {}, result = {}) {
  const items = Array.isArray(fields.items)
    ? fields.items.filter((item) => item && typeof item === 'object')
    : [];
  const statedTotalEvidence = getExplicitOrderTotalEvidenceCents(result);
  const statedTotalEvidenceCents = statedTotalEvidence.cents;
  // manual_fields travels in the same draft object as parser/AI output, so it
  // cannot authorize a multi-item total that contradicts the line facts.
  // Keep the legacy single-item override; multi-item orders must pass the
  // original-text evidence and canonical subtotal checks below.
  const hasConfirmedTotal = items.length <= 1 && hasManuallyConfirmedOrderTotal(result, fields);
  const confirmedTotal = hasConfirmedTotal ? normalizeMoneyToCents(fields.amount) : null;
  const base = {
    complete: false,
    canonicalTotalCents: 0,
    canonicalTotalAmount: '',
    knownItemCount: 0,
    hasStatedTotal: hasValue(fields.statedAmount) && statedTotalEvidenceCents.length > 0,
    statedTotalEvidenceCents,
    hasConfirmedTotal,
    confirmedTotalAmount: confirmedTotal && confirmedTotal.valid
      ? String(confirmedTotal.cents / 100)
      : '',
    mismatchedFields: []
  };
  if (hasConfirmedTotal && (!confirmedTotal || !confirmedTotal.valid)) base.mismatchedFields.push('amount');
  if (!hasConfirmedTotal && statedTotalEvidence.conflict) base.mismatchedFields.push('statedAmountConflict');
  if (!items.length) return base;

  const subtotalCents = [];
  for (const [index, item] of items.entries()) {
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice || item.unit_price);
    let subtotal = null;
    if (Number.isFinite(quantity) && quantity > 0
      && Number.isFinite(unitPrice) && unitPrice > 0
      && unitsMatch(item.unit || '', item.priceUnit || item.price_unit || '')) {
      const calculated = normalizeMoneyToCents(quantity * unitPrice);
      if (calculated.valid && calculated.cents > 0) {
        subtotal = calculated.cents;
        const itemTotalValue = item.totalAmount || item.total_amount || item.amount;
        if (hasValue(itemTotalValue)) {
          const itemTotal = normalizeMoneyToCents(itemTotalValue);
          if (!itemTotal.valid || itemTotal.cents !== calculated.cents) {
            base.mismatchedFields.push(`items.${index}.totalAmount`);
          }
        }
      }
    }
    if (subtotal === null) {
      const stated = normalizeMoneyToCents(item.totalAmount || item.total_amount || item.amount);
      if (stated.valid && stated.cents > 0) subtotal = stated.cents;
    }
    if (subtotal === null) continue;
    subtotalCents.push(subtotal);
  }

  const canonicalTotalCents = subtotalCents.reduce((sum, cents) => sum + cents, 0);
  const complete = subtotalCents.length === items.length;
  const mismatchedFields = base.mismatchedFields.slice();
  if (!base.hasConfirmedTotal) {
    let statedTotal = null;
    if (base.hasStatedTotal) {
      statedTotal = normalizeMoneyToCents(fields.statedAmount);
      if (!statedTotal.valid || !base.statedTotalEvidenceCents.includes(statedTotal.cents)) {
        mismatchedFields.push('statedAmountSource');
      }
    }
    if (subtotalCents.length) {
      if (!base.hasStatedTotal || complete) {
        const candidateFields = base.hasStatedTotal
          ? ['statedAmount', 'amount', 'totalAmount']
          : ['statedAmount', 'amount', 'totalAmount', 'calculatedAmount'];
        candidateFields.forEach((field) => {
          if (!hasValue(fields[field])) return;
          const candidate = normalizeMoneyToCents(fields[field]);
          if (!candidate.valid || candidate.cents !== canonicalTotalCents) mismatchedFields.push(field);
        });
      } else if (statedTotal && statedTotal.valid) {
        ['amount', 'totalAmount'].forEach((field) => {
          if (!hasValue(fields[field])) return;
          const candidate = normalizeMoneyToCents(fields[field]);
          if (!candidate.valid || candidate.cents !== statedTotal.cents) mismatchedFields.push(field);
        });
      }
    } else if (!base.hasStatedTotal) {
      ['statedAmount', 'amount', 'totalAmount', 'calculatedAmount'].forEach((field) => {
        if (hasValue(fields[field])) mismatchedFields.push(field);
      });
    }
  }
  return {
    complete,
    canonicalTotalCents,
    canonicalTotalAmount: String(canonicalTotalCents / 100),
    knownItemCount: subtotalCents.length,
    hasStatedTotal: base.hasStatedTotal,
    statedTotalEvidenceCents: base.statedTotalEvidenceCents.slice(),
    hasConfirmedTotal: base.hasConfirmedTotal,
    confirmedTotalAmount: base.confirmedTotalAmount,
    mismatchedFields
  };
}

function getReceivableRemainingAmount(receivable = {}) {
  const balance = getReceivableRemainingBalance(receivable.amount, receivable.paidAmount);
  return balance.valid ? balance.remainingAmount : 0;
}

function calculateOrderDepositAmount(state = {}, orderId) {
  if (!orderId) return 0;
  const order = (state.orders || []).find((item) => item.id === orderId);
  return (state.paymentRecords || [])
    .filter((item) => item.orderId === orderId
      && ['deposit'].includes(item.kind || item.paymentKind)
      && (!order || item.customerId === order.customerId))
    .reduce((sum, item) => sum + toMoney(item.amount), 0);
}

function calculateOrderRemainingSettlement(state = {}, order) {
  if (!order) return 0;
  const receivable = (state.receivables || []).find((item) => (
    item.orderId === order.id && item.customerId === order.customerId
  ));
  if (receivable) return getReceivableRemainingAmount(receivable);
  return Math.max(0, toMoney(order.totalAmount) - calculateOrderDepositAmount(state, order.id));
}

function getReceivablePaymentIssue(receivable, amount) {
  if (!receivable) return '没有找到这笔待收款';
  if (!ACTIVE_RECEIVABLE_STATUSES.includes(receivable.status)) return '这笔钱已经结清，不能重复记录';
  const balance = getReceivableRemainingBalance(receivable.amount, receivable.paidAmount);
  if (!balance.valid) return '这笔待收款的金额历史不完整，请先核对原记录';
  const classification = deriveReceivablePaymentKind({
    paymentAmount: amount,
    remainingBefore: balance.remainingAmount,
    isLinkedReceivable: true,
    isLegacyReceivable: receivable.source === 'legacy'
  });
  if (classification.ok) return '';
  if (classification.errorCode === RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.PAYMENT_EXCEEDS_REMAINING) {
    return `本次收款不能超过还差 ${balance.remainingAmount} 元`;
  }
  if (classification.errorCode === RECEIVABLE_PAYMENT_CLASSIFICATION_ERRORS.RECEIVABLE_ALREADY_SETTLED) {
    return '这笔钱已经结清，不能重复记录';
  }
  return '先填本次收款金额';
}

function isDeletedOrder(state = {}, order = {}) {
  if (!order) return false;
  if (order.deleted === true || order.isDeleted === true || order.deletedAt) return true;
  return (state.deletedRecords || []).some((item) => (
    item && item.recordType === 'order' && item.recordId === order.id
  ));
}

function assessQuotationOrderRelation(state = {}, quotation = {}) {
  const orders = state.orders || [];
  const rawForwardId = quotation && quotation.convertedOrderId;
  const hasForwardId = rawForwardId !== undefined
    && rawForwardId !== null
    && rawForwardId !== '';
  const forwardIdIsValid = !hasForwardId || typeof rawForwardId === 'string';
  const forwardOrders = hasForwardId && forwardIdIsValid
    ? orders.filter((item) => item && item.id === rawForwardId)
    : [];
  const reverseOrders = quotation && quotation.id
    ? orders.filter((item) => item && item.quotationId === quotation.id)
    : [];
  const convertedStatus = CONVERTED_QUOTATION_STATUSES.includes(String(
    quotation && quotation.status || ''
  ));
  const forwardOrder = forwardOrders.length === 1 ? forwardOrders[0] : null;
  const orderTypeValid = Boolean(
    forwardOrder && (!forwardOrder.recordType || forwardOrder.recordType === 'order')
  );
  const cleanExisting = Boolean(
    convertedStatus
    && hasForwardId
    && forwardIdIsValid
    && forwardOrders.length === 1
    && reverseOrders.length === 1
    && reverseOrders[0] === forwardOrder
    && orderTypeValid
    && !isDeletedOrder(state, forwardOrder)
    && forwardOrder.customerId === quotation.customerId
    && (!quotation.userId || !forwardOrder.userId || forwardOrder.userId === quotation.userId)
  );
  if (cleanExisting) {
    return {
      state: QUOTATION_ORDER_RELATION_STATES.CLEAN_EXISTING,
      code: 'QUOTATION_ALREADY_CONVERTED',
      order: forwardOrder,
      reason: 'BIDIRECTIONAL_RELATION_VALID'
    };
  }
  if (convertedStatus || hasForwardId || forwardOrders.length || reverseOrders.length) {
    return {
      state: QUOTATION_ORDER_RELATION_STATES.DATA_CONFLICT,
      code: 'QUOTATION_ORDER_RELATION_CONFLICT',
      order: null,
      reason: convertedStatus && !hasForwardId && reverseOrders.length === 0
        ? 'LEGACY_CONVERTED_STATUS_WITHOUT_RELATION'
        : 'RELATION_NOT_BIDIRECTIONAL_OR_TARGET_INVALID'
    };
  }
  return {
    state: QUOTATION_ORDER_RELATION_STATES.NONE,
    code: '',
    order: null,
    reason: 'NO_CONVERSION_RELATION'
  };
}

function isQuotationConverted(state = {}, quotation = {}) {
  return assessQuotationOrderRelation(state, quotation).state
    !== QUOTATION_ORDER_RELATION_STATES.NONE;
}

function compareStableIds(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function getDeletedQuotationIds(state = {}) {
  return new Set((state.deletedRecords || [])
    .filter((item) => item && item.recordType === 'quotation' && item.recordId)
    .map((item) => String(item.recordId)));
}

function getQuotationProductSummary(quotation = {}) {
  const itemNames = (Array.isArray(quotation.items) ? quotation.items : [])
    .map((item) => String(item && item.productName || '').trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
  if (itemNames.length) return itemNames.join('、');
  return String(quotation.productName || '').trim();
}

function normalizeRelationMatchValue(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function getQuotationProductNames(quotation = {}) {
  const itemNames = (Array.isArray(quotation.items) ? quotation.items : [])
    .map((item) => normalizeRelationMatchValue(item && item.productName))
    .filter(Boolean);
  const topLevel = normalizeRelationMatchValue(quotation.productName);
  return uniqueStrings(itemNames.concat(topLevel ? [topLevel] : []));
}

function getDraftProductNames(fields = {}) {
  const itemNames = (Array.isArray(fields.items) ? fields.items : [])
    .map((item) => normalizeRelationMatchValue(item && item.productName))
    .filter(Boolean);
  const topLevel = normalizeRelationMatchValue(fields.productName);
  return uniqueStrings(itemNames.concat(topLevel ? [topLevel] : []));
}

function getNamedQuotationReferenceFacts(reference, fields, customer) {
  if (!reference || reference.kind !== 'EXPLICIT_QUOTATION_NAMED_REFERENCE') {
    return { valid: false, customerName: '', productNames: [] };
  }
  const normalizedReference = String(reference.normalizedReference || '');
  const parts = normalizedReference.split(':').map(normalizeRelationMatchValue);
  if (parts.pop() !== 'QUOTATION' || !parts.length || parts.some((part) => !part)) {
    return { valid: false, customerName: '', productNames: [] };
  }
  const fieldCustomerName = normalizeRelationMatchValue(fields.customerName);
  const resolvedCustomerName = normalizeRelationMatchValue(customer && customer.name);
  const draftProductNames = getDraftProductNames(fields);
  let customerName = '';
  let productNames = [];
  if (parts.length > 1) {
    customerName = parts[0];
    productNames = parts.slice(1);
  } else if (parts[0] === fieldCustomerName || parts[0] === resolvedCustomerName) {
    customerName = parts[0];
  } else {
    productNames = parts.slice();
  }
  const customerMatches = !customerName || (
    customerName === fieldCustomerName
    && customerName === resolvedCustomerName
  );
  const productsMatchDraft = !productNames.length || productNames.every((name) => (
    draftProductNames.includes(name)
  ));
  return {
    valid: customerMatches && productsMatchDraft,
    customerName,
    productNames
  };
}

function quotationMatchesExplicitReference(quotation, reference, fields, customer) {
  if (!quotation || !reference || !customer) return false;
  if (String(quotation.customerId || '') !== String(customer.id || '')) return false;
  const draftProductNames = getDraftProductNames(fields);
  if (reference.kind === 'EXPLICIT_QUOTATION_NAMED_REFERENCE') {
    const facts = getNamedQuotationReferenceFacts(reference, fields, customer);
    if (!facts.valid) return false;
    const expectedProducts = facts.productNames.length
      ? facts.productNames
      : draftProductNames;
    if (!expectedProducts.length) return true;
    const quotationProductNames = getQuotationProductNames(quotation);
    return expectedProducts.every((name) => quotationProductNames.includes(name));
  }
  if (reference.kind === 'EXPLICIT_QUOTATION_DEICTIC') {
    if (!draftProductNames.length) return true;
    const quotationProductNames = getQuotationProductNames(quotation);
    return draftProductNames.every((name) => quotationProductNames.includes(name));
  }
  return false;
}

function classifyExplicitQuotationMatches(state, operation, customerId, fields, reference) {
  const customer = getCustomerById(state, customerId);
  const matches = customer
    ? (state.quotations || []).filter((quotation) => (
      quotationMatchesExplicitReference(quotation, reference, fields, customer)
    ))
    : [];
  const idCounts = matches.reduce((counts, quotation) => {
    const id = String(quotation && quotation.id || '');
    if (id) counts[id] = Number(counts[id] || 0) + 1;
    return counts;
  }, {});
  const safeMatches = [];
  const dangerousMatches = [];
  const ambiguousMatches = [];
  matches.forEach((quotation) => {
    const id = String(quotation && quotation.id || '');
    if (!id || idCounts[id] !== 1) {
      ambiguousMatches.push({
        quotation,
        blockingCodes: ['QUOTATION_TARGET_NOT_FOUND']
      });
      return;
    }
    const codes = getQuotationSelectionBlockingCodes(
      state, quotation, operation, customerId
    );
    if (codes.length) dangerousMatches.push({ quotation, blockingCodes: codes });
    else safeMatches.push(quotation);
  });
  safeMatches.sort((left, right) => compareStableIds(left && left.id, right && right.id));
  dangerousMatches.sort((left, right) => compareStableIds(
    left && left.quotation && left.quotation.id,
    right && right.quotation && right.quotation.id
  ));
  ambiguousMatches.sort((left, right) => compareStableIds(
    left && left.quotation && left.quotation.id,
    right && right.quotation && right.quotation.id
  ));
  const uniquelyRejected = reference
    && reference.kind === 'EXPLICIT_QUOTATION_NAMED_REFERENCE'
    && safeMatches.length === 0
    && dangerousMatches.length === 1
    && ambiguousMatches.length === 0
    && matches.length === 1
    ? dangerousMatches[0]
    : null;
  return {
    ambiguousMatches,
    dangerousMatches,
    safeMatches,
    uniquelyRejected
  };
}

function getQuotationSelectionBlockingCodes(state, quotation, operation, customerId) {
  const codes = [];
  if (!quotation || !String(quotation.id || '').trim()) {
    return ['QUOTATION_TARGET_NOT_FOUND'];
  }
  if (getDeletedQuotationIds(state).has(String(quotation.id))) {
    codes.push('QUOTATION_TARGET_NOT_FOUND');
  }
  if (!customerId || String(quotation.customerId || '') !== String(customerId)) {
    codes.push('QUOTATION_CUSTOMER_MISMATCH');
  }
  if (operation === 'update_quotation') {
    if (isQuotationConverted(state, quotation)
      || String(quotation.status || '') !== ACTIVE_QUOTATION_STATUS) {
      codes.push('QUOTATION_TARGET_NOT_UPDATABLE');
    }
  } else if (operation === 'create_order') {
    const relation = assessQuotationOrderRelation(state, quotation);
    if (relation.state === QUOTATION_ORDER_RELATION_STATES.CLEAN_EXISTING
      || relation.reason === 'LEGACY_CONVERTED_STATUS_WITHOUT_RELATION') {
      codes.push('QUOTATION_ALREADY_CONVERTED');
    } else if (relation.state === QUOTATION_ORDER_RELATION_STATES.DATA_CONFLICT) {
      codes.push('QUOTATION_ORDER_RELATION_CONFLICT');
    } else if (String(quotation.status || '') !== ACTIVE_QUOTATION_STATUS) {
      codes.push('QUOTATION_TARGET_NOT_ACTIVE');
    }
  } else {
    codes.push('QUOTATION_SELECTION_NOT_SUPPORTED_FOR_OPERATION');
  }
  return uniqueStrings(codes);
}

function projectQuotationSelectionCandidate(state, quotation, customer, operation, selectionRequired, selectedId) {
  const items = Array.isArray(quotation.items)
    ? quotation.items.filter((item) => item && typeof item === 'object')
    : [];
  const productSummary = getQuotationProductSummary(quotation);
  return {
    id: String(quotation.id || ''),
    quotationId: String(quotation.id || ''),
    customerId: String(quotation.customerId || ''),
    customerDisplayName: String(customer && customer.name || ''),
    productSummary,
    itemCount: items.length || (productSummary ? 1 : 0),
    quotationAmount: hasValue(quotation.totalAmount) ? quotation.totalAmount : '',
    status: String(quotation.status || ''),
    quoteDate: String(quotation.quoteDate || ''),
    validUntil: String(quotation.validUntil || ''),
    convertedOrderId: String(quotation.convertedOrderId || ''),
    createdAt: String(quotation.createdAt || ''),
    displayName: productSummary || String(quotation.id || ''),
    matchReason: operation === 'update_quotation'
      ? 'safe_quotation_for_update'
      : 'safe_quotation_for_order_creation',
    confidence: null,
    isExact: true,
    isSelected: Boolean(selectedId && String(selectedId) === String(quotation.id || '')),
    selectionRequired: selectionRequired === true,
    selectionEligible: true,
    selectionBlockingCodes: []
  };
}

function buildQuotationSelectionCandidates(state, operation, customerId, selectionRequired, selectedId) {
  if (!customerId || !['update_quotation', 'create_order'].includes(operation)) return [];
  const customer = getCustomerById(state, customerId);
  if (!customer) return [];
  return (state.quotations || [])
    .filter((quotation) => (
      getQuotationSelectionBlockingCodes(
        state, quotation, operation, customerId
      ).length === 0
    ))
    .slice()
    .sort((left, right) => compareStableIds(left && left.id, right && right.id))
    .map((quotation) => projectQuotationSelectionCandidate(
      state,
      quotation,
      customer,
      operation,
      selectionRequired,
      selectedId
    ));
}

function getNoRecordPersistenceFacts(result = {}) {
  const route = result && result.parse_route && typeof result.parse_route === 'object'
    ? result.parse_route
    : {};
  const decision = String(route.decision || '').toLowerCase();
  const semanticDecision = String(route.semantic_decision || '').toLowerCase();
  const finalDisposition = String(route.final_disposition || '').toLowerCase();
  const canonical = decision === 'no_record';
  const qualifiedLegacyProjection = route.no_record_eligible === true
    && (semanticDecision === 'no_record'
      || finalDisposition === 'no_record'
      || result.no_record === true);
  return {
    canonical,
    eligible: route.no_record_eligible === true,
    persistenceForbidden: canonical || qualifiedLegacyProjection,
    decision,
    semanticDecision,
    finalDisposition
  };
}

function isNoRecordPersistenceForbidden(result = {}) {
  return getNoRecordPersistenceFacts(result).persistenceForbidden;
}

function resolveOperation(result = {}, explicitOperation = '') {
  if (isNoRecordPersistenceForbidden(result)) return 'none';
  if (explicitOperation) return explicitOperation;
  if (result.operation) return result.operation;
  if (result.intent === 'quotation') return 'create_quotation';
  if (result.intent === 'order') return 'create_order';
  if (result.intent === 'receivable') return 'create_receivable';
  if (result.intent === 'payment') return 'record_payment';
  if (['todo', 'dunning'].includes(result.intent)) return 'create_todo';
  return 'pending';
}

function operationMatchesIntent(operation, intent) {
  const accepted = {
    create_quotation: ['quotation'],
    update_quotation: ['quotation'],
    create_order: ['order'],
    update_order: ['order'],
    create_receivable: ['receivable'],
    create_receivable_with_payment: ['payment'],
    record_payment: ['payment'],
    record_order_deposit: ['payment'],
    create_todo: ['todo', 'dunning'],
    none: ['unknown'],
    pending: ['unknown', 'pending']
  };
  return Boolean(accepted[operation]) && accepted[operation].includes(intent);
}

function findOtherCollectionType(state, id, expectedType) {
  const definitions = [
    ['customer', 'customers'],
    ['quotation', 'quotations'],
    ['order', 'orders'],
    ['receivable', 'receivables'],
    ['payment', 'paymentRecords'],
    ['todo', 'todos']
  ];
  const found = definitions.find(([type, collection]) => (
    type !== expectedType && (state[collection] || []).some((item) => item.id === id)
  ));
  return found ? found[0] : '';
}

function issue(code, field, riskLevel, sourceRule, requiredAction, relatedRecordIds = [], options = {}) {
  const value = {
    code,
    field: field || '',
    riskLevel,
    sourceRule,
    messageKey: options.messageKey || `RECORD_PREFLIGHT_${code}`,
    messageParams: safeClone(options.messageParams || {}),
    resolvableByUser: options.resolvableByUser !== false,
    requiredAction: requiredAction || 'REVIEW_SAFETY',
    relatedRecordIds: uniqueStrings(relatedRecordIds)
  };
  ['itemKey', 'itemField', 'fieldPath'].forEach((key) => {
    if (options[key] !== undefined && options[key] !== null && options[key] !== '') {
      value[key] = String(options[key]);
    }
  });
  if (Number.isInteger(options.itemIndex) && options.itemIndex >= 0) {
    value.itemIndex = options.itemIndex;
  }
  return value;
}

function candidate(record, displayName, matchReason, isSelected, selectionRequired) {
  return {
    id: String(record.id || ''),
    displayName: String(displayName || record.id || ''),
    matchReason,
    confidence: null,
    isExact: true,
    isSelected: isSelected === true,
    selectionRequired: selectionRequired === true
  };
}

function createCheck() {
  return { checked: true, passed: true, issues: [], warnings: [] };
}

function addIssue(target, check, value) {
  if (target.some((item) => (
    item.code === value.code
      && item.field === value.field
      && String(item.itemKey || '') === String(value.itemKey || '')
      && String(item.itemField || '') === String(value.itemField || '')
      && String(item.fieldPath || '') === String(value.fieldPath || '')
  ))) {
    check.passed = false;
    if (!check.issues.includes(value.code)) check.issues.push(value.code);
    return;
  }
  target.push(value);
  check.issues.push(value.code);
  check.passed = false;
}

function hasUnresolvedAiResult(result = {}) {
  const routeInfo = result.parse_route || {};
  const route = routeInfo.decision;
  const aiFallback = result.ai_fallback || {};
  const aiStatus = aiFallback.status || 'not_requested';
  const hasVerifiedAiResult = aiStatus === 'used' && aiFallback.business_result_valid === true;
  const userResolution = evaluateUserResolvedAiState(result);
  const hasTrustedUserResolution = userResolution.status === 'MANUAL_RESOLUTION_COMPLETE';
  return (['ai_standard', 'ai_deep'].includes(route) || routeInfo.deep_review_available === true)
    && !hasVerifiedAiResult
    && !hasTrustedUserResolution;
}

function isParseSafetyReady(result = {}) {
  const missing = Array.isArray(result.missing_fields) ? result.missing_fields : [];
  const low = Array.isArray(result.low_confidence_fields) ? result.low_confidence_fields : [];
  const conflicts = Array.isArray(result.field_conflicts) ? result.field_conflicts : [];
  return !missing.length
    && !low.length
    && !conflicts.length
    && !hasUnresolvedAiResult(result)
    && !result.formal_save_blocked
    && !result.mixed_business
    && !result.requires_existing_record
    && result.intent !== 'unknown';
}

function resolveAiFacts(input, result) {
  const fallback = result.ai_fallback || {};
  const provenance = getTrustedRecordFlowContext(result);
  return {
    outcome: String(input.aiOutcome || provenance.aiOutcome || fallback.status || 'not_requested').trim().toUpperCase(),
    providerKind: String(input.providerKind || provenance.providerKind || fallback.provider_kind || 'NONE').trim().toUpperCase(),
    attempted: fallback.attempted === true || provenance.aiRequested === true || input.aiRequested === true,
    businessResultValid: fallback.business_result_valid === true
  };
}

function resolveCustomer(input, state, result, blockingIssues, requiredSelections, customerChecks) {
  const fields = result.fields || {};
  const selectedCustomerId = input.selectedCustomerId || fields.customerId || '';
  const matches = findCustomerMatches(state, fields);
  const selected = selectedCustomerId ? getCustomerById(state, selectedCustomerId) : null;
  const inputPhoneFingerprint = simpleFingerprint(fields.phone);
  const selectedMatchesPhone = !inputPhoneFingerprint
    || Boolean(selected && selected.phoneFingerprint === inputPhoneFingerprint);
  const selectedMatchesInput = Boolean(selected)
    && customerNameMatches(selected, fields.customerName)
    && selectedMatchesPhone;
  const forceNew = fields.forceNewCustomer === true;
  const hasDiscriminator = Boolean(fields.phone || fields.company || fields.region || fields.customerNote || fields.wechatRemark);
  let resolvedCustomer = null;
  let resolutionSource = 'NONE';
  let requiresUserSelection = false;
  const uniqueMatchKind = matches.length === 1
    ? getCustomerNameMatchKind(matches[0], fields.customerName)
    : 'NONE';

  if (forceNew && selectedCustomerId) {
    addIssue(blockingIssues, customerChecks, issue(
      'NEW_CUSTOMER_EXISTING_SELECTION_CONFLICT', 'customerId', 'ZERO_TOLERANCE',
      'CUSTOMER_FORCE_NEW_RELATION', 'SELECT_CUSTOMER', [selectedCustomerId]
    ));
  } else if (selectedCustomerId && (!selected || !selectedMatchesInput)) {
    addIssue(blockingIssues, customerChecks, issue(
      selected ? 'CUSTOMER_SELECTION_INPUT_CONFLICT' : 'CUSTOMER_TARGET_NOT_FOUND',
      'customerId', 'ZERO_TOLERANCE', 'CUSTOMER_SELECTED_TARGET', 'SELECT_CUSTOMER', [selectedCustomerId]
    ));
  } else if (selected && matches.length > 1
    && !input.selectedCustomerId
    && fields.customerSelectionConfirmed !== true
    && !(input.userConfirmedRelations || []).includes('customerId')) {
    requiresUserSelection = true;
    requiredSelections.push('customerId');
    addIssue(blockingIssues, customerChecks, issue(
      'CUSTOMER_SELECTION_CONFIRMATION_REQUIRED', 'customerId', 'ZERO_TOLERANCE',
      'CUSTOMER_MULTIPLE_MATCHES', 'SELECT_CUSTOMER', matches.map((item) => item.id)
    ));
  } else if (selected && uniqueMatchKind === 'SIMILAR'
    && !input.selectedCustomerId
    && fields.customerSelectionConfirmed !== true
    && !(input.userConfirmedRelations || []).includes('customerId')) {
    requiresUserSelection = true;
    requiredSelections.push('customerId');
    addIssue(blockingIssues, customerChecks, issue(
      'CUSTOMER_SIMILAR_NAME_CONFIRMATION_REQUIRED', 'customerId', 'DANGEROUS',
      'CUSTOMER_SIMILAR_NAME_MATCH', 'SELECT_CUSTOMER', matches.map((item) => item.id)
    ));
  } else if (selected) {
    resolvedCustomer = selected;
    resolutionSource = matches.length === 1
      && uniqueMatchKind === 'EXACT'
      && !input.selectedCustomerId
      && fields.customerSelectionConfirmed !== true
      && !(input.userConfirmedRelations || []).includes('customerId')
      ? 'UNIQUE_EXACT_MATCH'
      : 'USER_SELECTION';
  } else if (!forceNew && matches.length === 1 && uniqueMatchKind === 'SIMILAR'
    && !input.selectedCustomerId
    && fields.customerSelectionConfirmed !== true
    && !(input.userConfirmedRelations || []).includes('customerId')) {
    requiresUserSelection = true;
    requiredSelections.push('customerId');
    addIssue(blockingIssues, customerChecks, issue(
      'CUSTOMER_SIMILAR_NAME_CONFIRMATION_REQUIRED', 'customerId', 'DANGEROUS',
      'CUSTOMER_SIMILAR_NAME_MATCH', 'SELECT_CUSTOMER', matches.map((item) => item.id)
    ));
  } else if (!forceNew && matches.length === 1) {
    resolvedCustomer = matches[0];
    resolutionSource = 'UNIQUE_EXACT_MATCH';
  } else if (!forceNew && matches.length > 1) {
    requiresUserSelection = true;
    requiredSelections.push('customerId');
    addIssue(blockingIssues, customerChecks, issue(
      'CUSTOMER_SELECTION_REQUIRED', 'customerId', 'ZERO_TOLERANCE',
      'CUSTOMER_MULTIPLE_MATCHES', 'SELECT_CUSTOMER', matches.map((item) => item.id)
    ));
  } else if (forceNew && matches.length && !hasDiscriminator) {
    addIssue(blockingIssues, customerChecks, issue(
      'NEW_CUSTOMER_DISCRIMINATOR_REQUIRED', 'customerName', 'DANGEROUS',
      'CUSTOMER_FORCE_NEW_DUPLICATE', 'EDIT_FIELDS', matches.map((item) => item.id)
    ));
  } else if (fields.customerName) {
    resolutionSource = forceNew ? 'FORCE_NEW' : 'NEW_CUSTOMER';
  }

  const customerCandidates = matches.map((item) => candidate(
    item,
    item.name || item.id,
    getCustomerNameMatchKind(item, fields.customerName) === 'SIMILAR'
      ? 'customer_similar_name_match'
      : 'customer_name_match',
    Boolean(resolvedCustomer && resolvedCustomer.id === item.id),
    requiresUserSelection
  ));
  return {
    customer: resolvedCustomer,
    customerId: resolvedCustomer ? resolvedCustomer.id : '',
    newCustomer: !resolvedCustomer && Boolean(fields.customerName),
    resolutionSource,
    requiresUserSelection,
    candidates: customerCandidates,
    candidatesResolved: true
  };
}

function recordCustomerMismatch(state, record, fields, customerId) {
  if (!record) return true;
  if (fields.forceNewCustomer === true) return true;
  const recordCustomer = getCustomerById(state, record.customerId);
  if (!recordCustomer) return true;
  if (customerId && record.customerId !== customerId) return true;
  if (fields.customerId && record.customerId !== fields.customerId) return true;
  const inputPhoneFingerprint = simpleFingerprint(fields.phone);
  if (inputPhoneFingerprint && recordCustomer.phoneFingerprint !== inputPhoneFingerprint) return true;
  return Boolean(fields.customerName && !customerNameMatches(recordCustomer, fields.customerName));
}

function hasExactPaymentReplay(state, fields, relation = {}) {
  const originalText = String(relation.originalText || '').trim();
  if (!originalText) return false;
  const expectedAmount = toMoney(relation.amount);
  return (state.paymentRecords || []).some((item) => {
    const itemKind = item.kind || item.paymentKind || '';
    return String(item.originalText || '').trim() === originalText
      && toMoney(item.amount) === expectedAmount
      && (!relation.kind || itemKind === relation.kind)
      && (!relation.customerId || item.customerId === relation.customerId)
      && (!relation.orderId || item.orderId === relation.orderId)
      && (!relation.receivableId || item.receivableId === relation.receivableId);
  });
}

function getReceivableSettlementHistoryIssue(state, receivable) {
  if (!receivable) return '';
  const linkedPayments = (state.paymentRecords || []).filter((item) => item.receivableId === receivable.id);
  if (!linkedPayments.length) return '';
  if (linkedPayments.some((item) => !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0)) {
    return 'PAYMENT_RECORD_AMOUNT_INVALID';
  }
  const linkedTotal = linkedPayments.reduce((sum, item) => sum + toMoney(item.amount), 0);
  return Math.abs(linkedTotal - toMoney(receivable.paidAmount)) > 0.01
    ? 'PAID_AMOUNT_MISMATCH'
    : '';
}

function evaluateRecordDomainPreflight(input = {}) {
  const rawResult = input.finalResult && typeof input.finalResult === 'object'
    ? safeClone(input.finalResult)
    : {};
  const result = input.skipFinalSafety === true
    ? rawResult
    : applyFinalParseSafety(rawResult, input.businessDate ? { businessDate: input.businessDate } : {});
  const fields = Object.assign({}, result.fields || {});
  const state = input.initialState && typeof input.initialState === 'object' ? input.initialState : {};
  const provenance = getTrustedRecordFlowContext(result);
  const mode = input.mode || provenance.mode || PRODUCTION_MODE;
  const resultScope = input.resultScope || provenance.resultScope || PRODUCTION_SCOPE;
  const noRecordPersistenceFacts = getNoRecordPersistenceFacts(result);
  const noRecordPersistenceForbidden = noRecordPersistenceFacts.persistenceForbidden;
  const relationsEnabled = resultScope !== 'AI_ONLY_RESULT' && !noRecordPersistenceForbidden;
  const operation = resolveOperation(result, input.operation || '');
  const businessType = input.businessType || (operation === 'record_order_deposit' ? 'order_deposit' : result.intent || 'unknown');
  const explicitOrderReference = getExplicitOrderReference(result);
  const explicitQuotationReference = getExplicitQuotationReference(result);
  const explicitReceivableOrderResolutionRequired = relationsEnabled
    && requiresExplicitReceivableOrderResolution(operation, businessType, result);
  const explicitQuotationResolutionRequired = relationsEnabled
    && requiresExplicitQuotationResolution(operation, businessType, result);
  const blockingIssues = [];
  const warnings = [];
  const requiredSelections = [];
  const customerChecks = createCheck();
  const quotationChecks = createCheck();
  const orderChecks = createCheck();
  const receivableChecks = createCheck();
  const paymentChecks = createCheck();
  const depositChecks = createCheck();
  const amountChecks = createCheck();
  const targetChecks = createCheck();
  const aiChecks = createCheck();
  const duplicateChecks = createCheck();

  if (!operationMatchesIntent(operation, result.intent)) {
    const supportedOperations = [
      'create_quotation', 'update_quotation', 'create_order', 'update_order',
      'create_receivable', 'create_receivable_with_payment', 'record_payment',
      'record_order_deposit', 'create_todo', 'none', 'pending'
    ];
    addIssue(blockingIssues, targetChecks, issue(
      supportedOperations.includes(operation) ? 'OPERATION_INTENT_MISMATCH' : 'OPERATION_UNSUPPORTED',
      'businessType', 'ZERO_TOLERANCE', 'OPERATION_INTENT_CONTRACT',
      'CHANGE_BUSINESS_TYPE', [], { resolvableByUser: false }
    ));
  }
  const supportedRelationsByOperation = {
    create_quotation: [],
    update_quotation: ['quotationId'],
    create_order: ['quotationId'],
    update_order: ['orderId', 'quotationId'],
    create_receivable: ['orderId'],
    create_receivable_with_payment: ['orderId'],
    record_payment: ['orderId', 'receivableId'],
    record_order_deposit: ['orderId'],
    create_todo: ['receivableId'],
    none: [],
    pending: []
  };
  const supportedRelations = supportedRelationsByOperation[operation] || [];
  ['quotationId', 'orderId', 'receivableId'].forEach((field) => {
    const selectedKey = `selected${field.charAt(0).toUpperCase()}${field.slice(1)}`;
    const relationId = input[selectedKey] || fields[field];
    if (!relationId || supportedRelations.includes(field)) return;
    addIssue(blockingIssues, targetChecks, issue(
      'RELATION_NOT_SUPPORTED_FOR_OPERATION', field, 'ZERO_TOLERANCE',
      'OPERATION_RELATION_PRESERVATION', 'CHANGE_BUSINESS_TYPE', [relationId]
    ));
  });
  if (noRecordPersistenceForbidden) {
    addIssue(blockingIssues, targetChecks, issue(
      'NO_RECORD_OR_UNKNOWN_INTENT', 'businessType', 'ZERO_TOLERANCE',
      'CANONICAL_NO_RECORD_ROUTE', 'RETURN_OR_EDIT_INPUT', [], { resolvableByUser: false }
    ));
  } else {
    if (operation === 'pending' || result.intent === 'pending') addIssue(
      blockingIssues, targetChecks,
      issue('PENDING_RESULT_NOT_FORMAL', 'businessType', 'ZERO_TOLERANCE',
        'PENDING_ONLY_CONTRACT', 'SAVE_PENDING', [], { resolvableByUser: false })
    );

    uniqueStrings(result.missing_fields || []).forEach((field) => addIssue(
      blockingIssues, targetChecks,
      issue('MISSING_REQUIRED_FIELD', field, 'DANGEROUS', 'FINAL_PARSE_SAFETY', 'EDIT_FIELDS')
    ));
    uniqueStrings(result.low_confidence_fields || []).forEach((field) => addIssue(
      blockingIssues, targetChecks,
      issue('LOW_CONFIDENCE_FIELD', field, 'DANGEROUS', 'FINAL_PARSE_SAFETY', 'EDIT_FIELDS')
    ));
    (Array.isArray(result.field_conflicts) ? result.field_conflicts : []).forEach((conflict) => addIssue(
      blockingIssues, targetChecks,
      issue(
        'FIELD_CONFLICT', conflict && conflict.field, 'ZERO_TOLERANCE',
        'FINAL_PARSE_SAFETY', 'EDIT_FIELDS', [], {
          itemKey: conflict && conflict.itemKey,
          itemIndex: conflict && conflict.itemIndex,
          itemField: conflict && conflict.itemField,
          fieldPath: conflict && conflict.fieldPath,
          messageParams: conflict && conflict.message
            ? { conflictMessage: String(conflict.message) }
            : {}
        }
      )
    ));
    if (result.formal_save_blocked) addIssue(blockingIssues, targetChecks, issue(
      'FORMAL_SAVE_BLOCKED', '', 'ZERO_TOLERANCE', 'FINAL_PARSE_SAFETY', 'REVIEW_SAFETY', [], { resolvableByUser: false }
    ));
    if (result.mixed_business) addIssue(blockingIssues, targetChecks, issue(
      'MIXED_BUSINESS_UNRESOLVED', 'businessType', 'ZERO_TOLERANCE', 'FINAL_PARSE_SAFETY', 'CHANGE_BUSINESS_TYPE'
    ));
    if (result.intent === 'unknown') addIssue(blockingIssues, targetChecks, issue(
      'NO_RECORD_OR_UNKNOWN_INTENT', 'businessType', 'ZERO_TOLERANCE', 'FINAL_PARSE_SAFETY', 'CHANGE_BUSINESS_TYPE'
    ));
    const finalSafetyStatus = String(((result.final_parse_safety || {}).status) || '').toUpperCase();
    if (finalSafetyStatus === 'NO_RECORD') addIssue(
      blockingIssues, targetChecks,
      issue('NO_RECORD_OR_UNKNOWN_INTENT', 'businessType', 'ZERO_TOLERANCE', 'FINAL_PARSE_SAFETY_STATUS', 'CHANGE_BUSINESS_TYPE')
    );
    if (result.requires_existing_record && !fields.orderId && !fields.quotationId && !fields.receivableId) {
      addIssue(blockingIssues, targetChecks, issue(
        'EXISTING_TARGET_SELECTION_REQUIRED', 'relationId', 'ZERO_TOLERANCE',
        'EXISTING_RECORD_REQUIRED', 'SELECT_TARGET'
      ));
    }
  }

  const aiFacts = resolveAiFacts(input, result);
  const userResolution = evaluateUserResolvedAiState(result);
  const hasTrustedUserResolution = userResolution.status === 'MANUAL_RESOLUTION_COMPLETE';
  const aiInvolved = aiFacts.attempted || !['NOT_REQUESTED', ''].includes(aiFacts.outcome);
  const verifiedUsedOutcome = aiFacts.outcome === 'USED'
    && aiFacts.attempted
    && aiFacts.businessResultValid;
  // AI involvement is fail-closed. Only a completed, business-valid USED result
  // is resolved; requested/requesting/unknown/partial states cannot silently
  // fall back to a locally complete draft.
  const unresolvedAi = !hasTrustedUserResolution && (
    hasUnresolvedAiResult(result)
      || (aiInvolved && !verifiedUsedOutcome)
  );
  if (unresolvedAi) addIssue(blockingIssues, aiChecks, issue(
    'AI_RESULT_UNRESOLVED', '', 'ZERO_TOLERANCE', 'AI_INTEGRITY_GATE', 'RUN_DEEP_REVIEW', [], { resolvableByUser: false }
  ));
  const untrustedProvider = ['MOCK', 'FAKE', 'REPLAY'].includes(aiFacts.providerKind)
    || ['MOCK_USED'].includes(aiFacts.outcome);
  if (mode === PRODUCTION_MODE && untrustedProvider) addIssue(blockingIssues, aiChecks, issue(
    'UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION', '', 'ZERO_TOLERANCE', 'AI_PROVIDER_IDENTITY', 'REVIEW_SAFETY', [], { resolvableByUser: false }
  ));
  if (mode === PRODUCTION_MODE && aiFacts.attempted
    && !['REAL', 'MOCK', 'FAKE', 'REPLAY'].includes(aiFacts.providerKind)) {
    addIssue(blockingIssues, aiChecks, issue(
      'AI_PROVIDER_IDENTITY_UNRESOLVED', '', 'ZERO_TOLERANCE',
      'AI_PROVIDER_IDENTITY', 'REVIEW_SAFETY', [], { resolvableByUser: false }
    ));
  }
  if (mode !== PRODUCTION_MODE || resultScope !== PRODUCTION_SCOPE) addIssue(blockingIssues, aiChecks, issue(
    'NON_PRODUCTION_RESULT_SCOPE', '', 'ZERO_TOLERANCE', 'FLOW_MODE_SCOPE', 'REVIEW_SAFETY', [], { resolvableByUser: false }
  ));

  const finalItems = Array.isArray(fields.items) ? fields.items.filter((item) => item && typeof item === 'object') : [];
  const traceDrafts = (result.parse_trace || {});
  const declaredItemCount = Math.max(
    Array.isArray(result.multi_products) ? result.multi_products.length : 0,
    Number((traceDrafts.localDraft || {}).itemCount || 0),
    Number((traceDrafts.aiDraft || {}).itemCount || 0),
    Number(result.item_count || result.itemCount || 0)
  );
  if (declaredItemCount > 1 && finalItems.length < declaredItemCount) addIssue(
    blockingIssues, targetChecks,
    issue('MULTI_ITEM_LOSS', 'items', 'ZERO_TOLERANCE', 'MULTI_ITEM_PRESERVATION', 'EDIT_FIELDS')
  );
  const orderItemsTotal = calculateCanonicalOrderItemsTotal(fields, result);
  amountChecks.orderItemsTotalComplete = orderItemsTotal.complete;
  amountChecks.orderItemsTotalCents = orderItemsTotal.canonicalTotalCents;
  amountChecks.orderItemsTotalConfirmed = orderItemsTotal.hasConfirmedTotal;
  amountChecks.orderItemsTotalMismatchedFields = orderItemsTotal.mismatchedFields.slice();
  if (businessType === 'order' && orderItemsTotal.mismatchedFields.length) {
    const mismatchField = orderItemsTotal.mismatchedFields.some((field) => field.startsWith('items.'))
      ? 'items'
      : 'amount';
    addIssue(blockingIssues, amountChecks, issue(
      'ORDER_TOTAL_ITEMS_MISMATCH', mismatchField, 'ZERO_TOLERANCE',
      'ORDER_ITEMS_CANONICAL_TOTAL', 'EDIT_FIELDS', [], {
        messageParams: {
          canonicalTotalCents: orderItemsTotal.canonicalTotalCents,
          mismatchedFields: orderItemsTotal.mismatchedFields
        }
      }
    ));
  }

  ['amount', 'totalAmount', 'receivableAmount', 'paymentAmount', 'depositAmount', 'unitPrice'].forEach((field) => {
    if (!hasValue(fields[field])) return;
    const number = Number(fields[field]);
    if (!Number.isFinite(number) || number <= 0) addIssue(
      blockingIssues, amountChecks,
      issue('BUSINESS_AMOUNT_INVALID', field, 'ZERO_TOLERANCE', 'BUSINESS_POSITIVE_AMOUNT', 'EDIT_FIELDS')
    );
  });
  if (hasValue(fields.remainingAmount)) {
    const remaining = Number(fields.remainingAmount);
    if (!Number.isFinite(remaining) || remaining < 0) addIssue(
      blockingIssues, amountChecks,
      issue('REMAINING_AMOUNT_INVALID', 'remainingAmount', 'ZERO_TOLERANCE', 'BUSINESS_NONNEGATIVE_REMAINING', 'EDIT_FIELDS')
    );
  }
  const explicitPaymentKind = String(fields.paymentKind || fields.kind || '').trim().toLowerCase();
  const hasDepositField = hasValue(fields.depositAmount);
  if ((explicitPaymentKind === 'deposit' || hasDepositField)
    && !['create_order', 'record_order_deposit'].includes(operation)) {
    addIssue(blockingIssues, paymentChecks, issue(
      'PAYMENT_DIRECTION_OPERATION_CONFLICT', 'paymentKind', 'ZERO_TOLERANCE',
      'PAYMENT_OPERATION_DIRECTION', 'CHANGE_BUSINESS_TYPE'
    ));
  }
  if (operation === 'record_order_deposit' && explicitPaymentKind && explicitPaymentKind !== 'deposit') {
    addIssue(blockingIssues, depositChecks, issue(
      'PAYMENT_DIRECTION_OPERATION_CONFLICT', 'paymentKind', 'ZERO_TOLERANCE',
      'PAYMENT_OPERATION_DIRECTION', 'CHANGE_BUSINESS_TYPE'
    ));
  } else if (explicitPaymentKind && explicitPaymentKind !== 'deposit') {
    addIssue(blockingIssues, paymentChecks, issue(
      'PAYMENT_KIND_UNSUPPORTED', 'paymentKind', 'ZERO_TOLERANCE',
      'PAYMENT_KIND_DERIVED_BY_OPERATION', 'CHANGE_BUSINESS_TYPE'
    ));
  }

  const customerResolution = relationsEnabled
    ? resolveCustomer(input, state, result, blockingIssues, requiredSelections, customerChecks)
    : {
      customer: null,
      customerId: '',
      newCustomer: false,
      resolutionSource: 'NOT_EVALUATED_AI_ONLY',
      requiresUserSelection: false,
      candidates: [],
      candidatesResolved: false
  };
  const resolvedCustomerId = relationsEnabled ? (customerResolution.customerId || fields.customerId || '') : '';
  const inputQuotationId = relationsEnabled ? String(input.selectedQuotationId || '') : '';
  const fieldQuotationId = relationsEnabled ? String(fields.quotationId || '') : '';
  const rawQuotationId = inputQuotationId || fieldQuotationId;
  const quotationIdConflict = Boolean(
    inputQuotationId && fieldQuotationId && inputQuotationId !== fieldQuotationId
  );
  const quotationSelectionConfirmed = Boolean(
    fields.quotationSelectionConfirmed === true
    || (input.userConfirmedRelations || []).includes('quotationId')
  );
  const selectedOrderId = relationsEnabled ? (input.selectedOrderId || fields.orderId || '') : '';
  const selectedReceivableId = relationsEnabled ? (input.selectedReceivableId || fields.receivableId || '') : '';
  const quotationRelationMatches = explicitQuotationResolutionRequired
    ? classifyExplicitQuotationMatches(
      state,
      operation,
      resolvedCustomerId,
      fields,
      explicitQuotationReference
    )
    : {
      ambiguousMatches: [],
      dangerousMatches: [],
      safeMatches: [],
      uniquelyRejected: null
    };
  const explicitSafeQuotationIds = quotationRelationMatches.safeMatches
    .map((item) => String(item.id || ''));
  const createOrderSelectionTrusted = operation !== 'create_order'
    || (quotationSelectionConfirmed && !quotationIdConflict);
  const selectedQuotationId = createOrderSelectionTrusted ? rawQuotationId : '';
  let quotation = null;
  let rejectedQuotation = null;
  let rejectedQuotationCodes = [];
  let order = null;
  let receivable = null;
  let quotationResolutionSource = 'NONE';
  let orderResolutionSource = 'NONE';
  let receivableResolutionSource = 'NONE';

  if (quotationIdConflict) {
    requiredSelections.push('quotationId');
    addIssue(blockingIssues, quotationChecks, issue(
      'QUOTATION_SELECTION_CONFLICT', 'quotationId', 'ZERO_TOLERANCE',
      'QUOTATION_SELECTION_CONFIRMATION', 'SELECT_QUOTATION',
      [inputQuotationId, fieldQuotationId]
    ));
  }

  if (rawQuotationId) {
    const deletedQuotationIds = getDeletedQuotationIds(state);
    const rawQuotation = (state.quotations || [])
      .find((item) => String(item.id || '') === rawQuotationId) || null;
    let rawCodes;
    if (!rawQuotation || deletedQuotationIds.has(rawQuotationId)) {
      rawCodes = [findOtherCollectionType(state, rawQuotationId, 'quotation')
        ? 'UPDATE_TARGET_TYPE_MISMATCH'
        : 'QUOTATION_TARGET_NOT_FOUND'];
    } else if (operation === 'update_order') {
      const convertedOrder = (state.orders || []).find((item) => (
        item.id === rawQuotation.convertedOrderId
        || item.quotationId === rawQuotation.id
      ));
      if (recordCustomerMismatch(state, rawQuotation, fields, resolvedCustomerId)) {
        rawCodes = ['QUOTATION_CUSTOMER_MISMATCH'];
      } else if (isQuotationConverted(state, rawQuotation)
        && (!selectedOrderId || !convertedOrder || convertedOrder.id !== selectedOrderId)) {
        rawCodes = ['QUOTATION_ALREADY_CONVERTED'];
      } else {
        rawCodes = [];
      }
    } else {
      rawCodes = getQuotationSelectionBlockingCodes(
        state, rawQuotation, operation, resolvedCustomerId
      );
    }
    const explicitSelectionMismatch = operation === 'create_order'
      && explicitQuotationResolutionRequired
      && rawCodes.length === 0
      && !explicitSafeQuotationIds.includes(rawQuotationId);
    if (operation === 'create_order'
      && (!quotationSelectionConfirmed || quotationIdConflict || explicitSelectionMismatch)) {
      requiredSelections.push('quotationId');
      if (rawCodes.length) {
        rejectedQuotation = rawQuotation;
        rejectedQuotationCodes = rawCodes.slice();
      } else if (!quotationSelectionConfirmed || quotationIdConflict) {
        addIssue(blockingIssues, quotationChecks, issue(
          'QUOTATION_SELECTION_CONFIRMATION_REQUIRED', 'quotationId', 'DANGEROUS',
          'QUOTATION_SELECTION_CONFIRMATION', 'SELECT_QUOTATION', [rawQuotationId]
        ));
      }
      if (explicitSelectionMismatch) addIssue(blockingIssues, quotationChecks, issue(
        'QUOTATION_TARGET_REQUIRED', 'quotationId', 'ZERO_TOLERANCE',
        'EXPLICIT_QUOTATION_RELATION', 'SELECT_QUOTATION', explicitSafeQuotationIds
      ));
    } else if (rawCodes.length) {
      rejectedQuotation = rawQuotation;
      rejectedQuotationCodes = rawCodes.slice();
    } else {
      quotation = rawQuotation;
      quotationResolutionSource = operation === 'create_order'
        ? 'USER_CONFIRMED_SELECTION'
        : 'EXPLICIT_SELECTION';
    }
  } else if (operation === 'update_quotation') {
    requiredSelections.push('quotationId');
    addIssue(blockingIssues, targetChecks, issue(
      'QUOTATION_TARGET_REQUIRED', 'quotationId', 'ZERO_TOLERANCE', 'UPDATE_TARGET_REQUIRED', 'SELECT_QUOTATION'
    ));
  }

  if (rejectedQuotationCodes.length) {
    rejectedQuotationCodes.forEach((code) => {
      const relatedIds = [rawQuotationId || (rejectedQuotation && rejectedQuotation.id)];
      if (code === 'QUOTATION_ALREADY_CONVERTED') {
        const convertedOrder = rejectedQuotation && (state.orders || []).find((item) => (
          item.id === rejectedQuotation.convertedOrderId
          || item.quotationId === rejectedQuotation.id
        ));
        addIssue(blockingIssues, duplicateChecks, issue(
          code, 'quotationId', 'ZERO_TOLERANCE',
          'QUOTATION_CONVERSION_DUPLICATE', 'SELECT_QUOTATION',
          relatedIds.concat(convertedOrder && convertedOrder.id),
          { resolvableByUser: false }
        ));
      } else {
        addIssue(blockingIssues, quotationChecks, issue(
          code, 'quotationId', 'ZERO_TOLERANCE',
          code === 'QUOTATION_CUSTOMER_MISMATCH'
            ? 'QUOTATION_CUSTOMER_LINK'
            : 'QUOTATION_TARGET',
          'SELECT_QUOTATION', relatedIds,
          { resolvableByUser: false }
        ));
      }
    });
  }

  if (operation === 'create_order' && explicitQuotationResolutionRequired && !rawQuotationId) {
    if (quotationRelationMatches.safeMatches.length) {
      requiredSelections.push('quotationId');
      addIssue(blockingIssues, quotationChecks, issue(
        'QUOTATION_TARGET_REQUIRED', 'quotationId', 'ZERO_TOLERANCE',
        'EXPLICIT_QUOTATION_RELATION', 'SELECT_QUOTATION', explicitSafeQuotationIds
      ));
    } else if (quotationRelationMatches.uniquelyRejected) {
      rejectedQuotation = quotationRelationMatches.uniquelyRejected.quotation;
      rejectedQuotationCodes = quotationRelationMatches.uniquelyRejected.blockingCodes.slice();
      rejectedQuotationCodes.forEach((code) => addIssue(
        blockingIssues,
        code === 'QUOTATION_ALREADY_CONVERTED' ? duplicateChecks : quotationChecks,
        issue(
          code, 'quotationId', 'ZERO_TOLERANCE',
          code === 'QUOTATION_ALREADY_CONVERTED'
            ? 'QUOTATION_CONVERSION_DUPLICATE'
            : 'EXPLICIT_QUOTATION_RELATION',
          'SELECT_QUOTATION', [rejectedQuotation.id],
          { resolvableByUser: false }
        )
      ));
    } else {
      requiredSelections.push('quotationId');
      addIssue(blockingIssues, quotationChecks, issue(
        'QUOTATION_TARGET_REQUIRED', 'quotationId', 'ZERO_TOLERANCE',
        'EXPLICIT_QUOTATION_RELATION', 'SELECT_QUOTATION', explicitSafeQuotationIds
      ));
    }
  }

  if (selectedOrderId) {
    order = (state.orders || []).find((item) => item.id === selectedOrderId) || null;
    if (!order) addIssue(blockingIssues, orderChecks, issue(
      findOtherCollectionType(state, selectedOrderId, 'order') ? 'UPDATE_TARGET_TYPE_MISMATCH' : 'ORDER_TARGET_NOT_FOUND',
      'orderId', 'ZERO_TOLERANCE', 'ORDER_TARGET', 'SELECT_ORDER', [selectedOrderId]
    ));
    else if (recordCustomerMismatch(state, order, fields, resolvedCustomerId)) addIssue(blockingIssues, orderChecks, issue(
      'ORDER_CUSTOMER_MISMATCH', 'orderId', 'ZERO_TOLERANCE', 'ORDER_CUSTOMER_LINK', 'SELECT_ORDER', [order.id]
    ));
    else {
      orderResolutionSource = 'EXPLICIT_SELECTION';
      if (operation === 'update_order' && !ACTIVE_ORDER_STATUSES.includes(order.status)) addIssue(blockingIssues, targetChecks, issue(
        'ORDER_TARGET_NOT_UPDATABLE', 'orderId', 'ZERO_TOLERANCE', 'UPDATE_TARGET_STATUS', 'SELECT_ORDER', [order.id], { resolvableByUser: false }
      ));
      if (operation === 'create_receivable' && order.status === '已取消') addIssue(blockingIssues, orderChecks, issue(
        'CANCELLED_ORDER_RECEIVABLE_FORBIDDEN', 'orderId', 'ZERO_TOLERANCE', 'RECEIVABLE_ORDER_STATUS', 'SELECT_ORDER', [order.id], { resolvableByUser: false }
      ));
      if (operation === 'update_order') {
        if (Object.prototype.hasOwnProperty.call(fields, 'quotationId')
          && String(fields.quotationId || '') !== String(order.quotationId || '')) {
          addIssue(blockingIssues, quotationChecks, issue(
            'ORDER_QUOTATION_RELATION_IMMUTABLE', 'quotationId', 'ZERO_TOLERANCE',
            'ORDER_QUOTATION_RELATION_PRESERVATION', 'SELECT_QUOTATION',
            [order.id, order.quotationId, fields.quotationId], { resolvableByUser: false }
          ));
        }
        const hasAmountPatch = ['amount', 'totalAmount', 'statedAmount', 'calculatedAmount']
          .some((key) => hasValue(fields[key])) || Array.isArray(fields.items);
        const hasFinancialLinks = (state.paymentRecords || []).some((item) => item.orderId === order.id)
          || (state.receivables || []).some((item) => item.orderId === order.id);
        const nextTotal = resolveDraftTotalAmount(fields);
        const directTotalChanged = result.edit_mode === 'direct_order'
          && String(nextTotal || '') !== String(order.totalAmount || '');
        const parsedTotalChanged = hasValue(nextTotal)
          && toMoney(nextTotal) !== toMoney(order.totalAmount);
        if (hasAmountPatch && hasFinancialLinks && (directTotalChanged || parsedTotalChanged)) {
          addIssue(blockingIssues, amountChecks, issue(
            'ORDER_TOTAL_UPDATE_WITH_FINANCIAL_LINKS', 'amount', 'ZERO_TOLERANCE',
            'ORDER_UPDATE_FINANCIAL_IMMUTABILITY', 'EDIT_FIELDS', [order.id], { resolvableByUser: false }
          ));
        }
      }
    }
  } else if (operation === 'update_order') {
    requiredSelections.push('orderId');
    addIssue(blockingIssues, targetChecks, issue(
      'ORDER_TARGET_REQUIRED', 'orderId', 'ZERO_TOLERANCE', 'UPDATE_TARGET_REQUIRED', 'SELECT_ORDER'
    ));
  }

  if (operation === 'create_receivable' || operation === 'create_receivable_with_payment') {
    const receivableAmount = parseStrictMoney(fields.amount);
    amountChecks.receivableAmount = receivableAmount.value;
    if (!receivableAmount.valid) addIssue(blockingIssues, amountChecks, issue(
      'RECEIVABLE_AMOUNT_INVALID', 'amount', 'ZERO_TOLERANCE', 'RECEIVABLE_POSITIVE_AMOUNT', 'EDIT_FIELDS'
    ));
    if (order) {
      const linkedReceivables = (state.receivables || []).filter((item) => item.orderId === order.id);
      if (linkedReceivables.some((item) => item.customerId !== order.customerId)) addIssue(blockingIssues, receivableChecks, issue(
        'ORDER_RECEIVABLE_CUSTOMER_CONFLICT', 'orderId', 'ZERO_TOLERANCE', 'RECEIVABLE_ORDER_EXISTING_LINK', 'SELECT_ORDER', [order.id]
      ));
      else if (linkedReceivables.length) addIssue(blockingIssues, duplicateChecks, issue(
        'ORDER_ALREADY_HAS_RECEIVABLE', 'orderId', 'ZERO_TOLERANCE', 'RECEIVABLE_DUPLICATE', 'SELECT_RECEIVABLE', linkedReceivables.map((item) => item.id)
      ));
    }
    if (operation === 'create_receivable_with_payment') {
      const payment = parseStrictMoney(fields.paymentAmount || fields.amountPaid || fields.receivedAmount);
      const total = receivableAmount.value;
      const paid = payment.value;
      amountChecks.inputAmount = paid;
      amountChecks.expectedMaximum = total;
      amountChecks.remainingAmount = Math.max(0, total - paid);
      amountChecks.comparison = paid > total ? 'GREATER_THAN_MAXIMUM' : (paid === total ? 'EQUAL_TO_MAXIMUM' : 'LESS_THAN_MAXIMUM');
      amountChecks.calculationSource = 'NEW_RECEIVABLE_TOTAL_MINUS_PAYMENT';
      if (!payment.valid || !receivableAmount.valid || paid > total) addIssue(blockingIssues, amountChecks, issue(
        paid > total ? 'PAYMENT_EXCEEDS_NEW_RECEIVABLE' : 'PAYMENT_AMOUNT_INVALID',
        'paymentAmount', 'ZERO_TOLERANCE', 'NEW_RECEIVABLE_PAYMENT_LIMIT', 'EDIT_FIELDS'
      ));
    }
  }

  const customerIdForCandidates = resolvedCustomerId || fields.customerId || '';
  const activeReceivableCandidates = customerIdForCandidates
    ? (state.receivables || []).filter((item) => item.customerId === customerIdForCandidates && ACTIVE_RECEIVABLE_STATUSES.includes(item.status))
    : [];
  const selectedReceivable = selectedReceivableId
    ? (state.receivables || []).find((item) => item.id === selectedReceivableId) || null
    : null;
  if (operation === 'create_todo' && selectedReceivableId) {
    if (!selectedReceivable) addIssue(blockingIssues, receivableChecks, issue(
      findOtherCollectionType(state, selectedReceivableId, 'receivable')
        ? 'UPDATE_TARGET_TYPE_MISMATCH'
        : 'RECEIVABLE_TARGET_NOT_FOUND',
      'receivableId', 'ZERO_TOLERANCE', 'TODO_RECEIVABLE_TARGET', 'SELECT_RECEIVABLE', [selectedReceivableId]
    ));
    else {
      receivable = selectedReceivable;
      receivableResolutionSource = 'EXPLICIT_SELECTION';
      if (!ACTIVE_RECEIVABLE_STATUSES.includes(receivable.status)) addIssue(blockingIssues, receivableChecks, issue(
        'RECEIVABLE_TARGET_SETTLED', 'receivableId', 'ZERO_TOLERANCE',
        'TODO_RECEIVABLE_STATUS', 'SELECT_RECEIVABLE', [receivable.id], { resolvableByUser: false }
      ));
      if (recordCustomerMismatch(state, receivable, fields, resolvedCustomerId)) addIssue(blockingIssues, receivableChecks, issue(
        'RECEIVABLE_CUSTOMER_MISMATCH', 'receivableId', 'ZERO_TOLERANCE',
        'TODO_RECEIVABLE_CUSTOMER', 'SELECT_RECEIVABLE', [receivable.id]
      ));
      if (receivable.orderId) {
        const linkedOrder = (state.orders || []).find((item) => item.id === receivable.orderId);
        if (!linkedOrder || linkedOrder.customerId !== receivable.customerId) addIssue(blockingIssues, receivableChecks, issue(
          'RECEIVABLE_ORDER_CUSTOMER_CONFLICT', 'receivableId', 'ZERO_TOLERANCE',
          'TODO_RECEIVABLE_ORDER_LINK', 'SELECT_RECEIVABLE', [receivable.id, receivable.orderId]
        ));
      }
    }
  }
  if (result.intent === 'payment' && operation === 'record_payment') {
    const strictPayment = parseStrictMoney(fields.paymentAmount || fields.amount);
    if (!strictPayment.valid) addIssue(blockingIssues, paymentChecks, issue(
      'PAYMENT_AMOUNT_INVALID', 'paymentAmount', 'ZERO_TOLERANCE', 'PAYMENT_POSITIVE_AMOUNT', 'EDIT_FIELDS'
    ));
    if (selectedReceivableId && !selectedReceivable) addIssue(blockingIssues, receivableChecks, issue(
      findOtherCollectionType(state, selectedReceivableId, 'receivable') ? 'UPDATE_TARGET_TYPE_MISMATCH' : 'RECEIVABLE_TARGET_NOT_FOUND',
      'receivableId', 'ZERO_TOLERANCE', 'PAYMENT_RECEIVABLE_TARGET', 'SELECT_RECEIVABLE', [selectedReceivableId]
    ));
    else if (selectedReceivable) {
      receivable = selectedReceivable;
      receivableResolutionSource = 'EXPLICIT_SELECTION';
      if (!ACTIVE_RECEIVABLE_STATUSES.includes(receivable.status)) addIssue(blockingIssues, receivableChecks, issue(
        'RECEIVABLE_TARGET_SETTLED', 'receivableId', 'ZERO_TOLERANCE', 'PAYMENT_RECEIVABLE_STATUS', 'SELECT_RECEIVABLE', [receivable.id], { resolvableByUser: false }
      ));
      if (recordCustomerMismatch(state, receivable, fields, resolvedCustomerId)) addIssue(blockingIssues, receivableChecks, issue(
        'RECEIVABLE_CUSTOMER_MISMATCH', 'receivableId', 'ZERO_TOLERANCE', 'PAYMENT_RECEIVABLE_CUSTOMER', 'SELECT_RECEIVABLE', [receivable.id]
      ));
      if (!input.selectedReceivableId
        && fields.receivableSelectionConfirmed !== true
        && !(input.userConfirmedRelations || []).includes('receivableId')) {
        requiredSelections.push('receivableId');
        addIssue(blockingIssues, receivableChecks, issue(
          'RECEIVABLE_SELECTION_CONFIRMATION_REQUIRED', 'receivableId', 'DANGEROUS', 'PAYMENT_RECEIVABLE_CONFIRMATION', 'SELECT_RECEIVABLE', [receivable.id]
        ));
      }
      if (receivable.orderId) {
        const linkedOrder = (state.orders || []).find((item) => item.id === receivable.orderId);
        if (!linkedOrder || linkedOrder.customerId !== receivable.customerId) addIssue(blockingIssues, receivableChecks, issue(
          'RECEIVABLE_ORDER_CUSTOMER_CONFLICT', 'receivableId', 'ZERO_TOLERANCE', 'PAYMENT_RECEIVABLE_ORDER_LINK', 'SELECT_RECEIVABLE', [receivable.id, receivable.orderId]
        ));
      }
      if (selectedOrderId && receivable.orderId !== selectedOrderId) addIssue(blockingIssues, receivableChecks, issue(
        'RECEIVABLE_ORDER_SELECTION_CONFLICT', 'orderId', 'ZERO_TOLERANCE',
        'PAYMENT_RECEIVABLE_ORDER_SELECTION', 'SELECT_RECEIVABLE', [receivable.id, selectedOrderId, receivable.orderId]
      ));
      const paymentAmount = fields.paymentAmount || fields.amount;
      const historicalAmount = Number(receivable.amount);
      const historicalPaid = Number(receivable.paidAmount || 0);
      if (!Number.isFinite(historicalAmount) || historicalAmount <= 0
        || !Number.isFinite(historicalPaid) || historicalPaid < 0) {
        addIssue(blockingIssues, paymentChecks, issue(
          'RECEIVABLE_HISTORY_AMOUNT_INVALID', 'receivableId', 'ZERO_TOLERANCE',
          'PAYMENT_DIRTY_HISTORY', 'SELECT_RECEIVABLE', [receivable.id], { resolvableByUser: false }
        ));
      }
      if (getReceivableSettlementHistoryIssue(state, receivable)) addIssue(blockingIssues, paymentChecks, issue(
        'RECEIVABLE_SETTLEMENT_HISTORY_CONFLICT', 'receivableId', 'ZERO_TOLERANCE',
        'PAYMENT_HISTORY_RECONCILIATION', 'SELECT_RECEIVABLE', [receivable.id], { resolvableByUser: false }
      ));
      const paymentError = getReceivablePaymentIssue(receivable, paymentAmount);
      amountChecks.inputAmount = toMoney(paymentAmount);
      amountChecks.expectedMaximum = getReceivableRemainingAmount(receivable);
      amountChecks.remainingAmount = Math.max(0, amountChecks.expectedMaximum - amountChecks.inputAmount);
      amountChecks.comparison = amountChecks.inputAmount > amountChecks.expectedMaximum
        ? 'GREATER_THAN_MAXIMUM'
        : (amountChecks.inputAmount === amountChecks.expectedMaximum ? 'EQUAL_TO_MAXIMUM' : 'LESS_THAN_MAXIMUM');
      amountChecks.calculationSource = 'RECEIVABLE_AMOUNT_MINUS_PAID';
      if (paymentError) addIssue(blockingIssues, paymentChecks, issue(
        'RECEIVABLE_PAYMENT_INVALID', 'paymentAmount', 'ZERO_TOLERANCE', 'PAYMENT_AMOUNT_LIMIT', 'EDIT_FIELDS', [receivable.id], { messageParams: { reason: paymentError } }
      ));
      const rawHistoricalRemaining = toMoney(receivable.amount) - toMoney(receivable.paidAmount);
      if (rawHistoricalRemaining < 0) addIssue(blockingIssues, paymentChecks, issue(
        'RECEIVABLE_HISTORY_OVERPAID', 'receivableId', 'ZERO_TOLERANCE',
        'PAYMENT_DIRTY_HISTORY', 'SELECT_RECEIVABLE', [receivable.id], { resolvableByUser: false }
      ));
      if (hasValue(fields.remainingAmount)) {
        const statedRemaining = Number(fields.remainingAmount);
        const calculatedRemaining = amountChecks.remainingAmount;
        if (!Number.isFinite(statedRemaining) || Math.abs(statedRemaining - calculatedRemaining) > 0.01) {
          addIssue(blockingIssues, amountChecks, issue(
            'PAYMENT_REMAINING_AMOUNT_CONFLICT', 'remainingAmount', 'ZERO_TOLERANCE',
            'PAYMENT_REMAINING_RECONCILIATION', 'EDIT_FIELDS', [receivable.id]
          ));
        }
      }
      if (hasExactPaymentReplay(state, fields, {
        originalText: input.originalText || result.originalText || result.original_text,
        amount: paymentAmount,
        customerId: receivable.customerId,
        receivableId: receivable.id
      })) addIssue(blockingIssues, duplicateChecks, issue(
        'POSSIBLE_DUPLICATE_PAYMENT', 'paymentAmount', 'ZERO_TOLERANCE',
        'PAYMENT_EXACT_REPLAY', 'REVIEW_SAFETY', [receivable.id]
      ));
    } else if (customerIdForCandidates && activeReceivableCandidates.length && !(
      fields.allowUnlinkedPayment === true && fields.unlinkedPaymentCustomerId === customerIdForCandidates
    )) {
      requiredSelections.push('receivableId');
      addIssue(blockingIssues, receivableChecks, issue(
        activeReceivableCandidates.length > 1 ? 'MULTIPLE_RECEIVABLE_SELECTION_REQUIRED' : 'RECEIVABLE_SELECTION_REQUIRED',
        'receivableId', 'ZERO_TOLERANCE', 'PAYMENT_RECEIVABLE_CANDIDATES', 'SELECT_RECEIVABLE', activeReceivableCandidates.map((item) => item.id)
      ));
    }
    if (!selectedReceivable && selectedOrderId) addIssue(blockingIssues, receivableChecks, issue(
      'PAYMENT_ORDER_REQUIRES_RECEIVABLE', 'orderId', 'ZERO_TOLERANCE',
      'PAYMENT_ORDER_RELATION_PRESERVATION', 'SELECT_RECEIVABLE', [selectedOrderId]
    ));
    if (!selectedReceivable && customerIdForCandidates && hasExactPaymentReplay(state, fields, {
      originalText: input.originalText || result.originalText || result.original_text,
      amount: fields.paymentAmount || fields.amount,
      kind: 'unlinked_payment',
      customerId: customerIdForCandidates
    })) addIssue(blockingIssues, duplicateChecks, issue(
      'POSSIBLE_DUPLICATE_PAYMENT', 'paymentAmount', 'ZERO_TOLERANCE',
      'PAYMENT_EXACT_REPLAY', 'REVIEW_SAFETY', []
    ));
  }

  const activeOrderCandidates = customerIdForCandidates
    ? (state.orders || []).filter((item) => isOrderSelectableForRelation(
      state,
      item,
      customerIdForCandidates,
      fields.productName
    ))
    : [];
  const safeOrderCandidateIds = activeOrderCandidates.map((item) => String(item.id || ''));
  const selectedOrderEligible = Boolean(selectedOrderId)
    && safeOrderCandidateIds.includes(String(selectedOrderId));
  const orderSelectionConfirmed = Boolean(
    input.selectedOrderId
    || fields.orderSelectionConfirmed === true
    || (input.userConfirmedRelations || []).includes('orderId')
  );
  const orderReferenceGate = {
    applies: explicitReceivableOrderResolutionRequired,
    evidenceKind: explicitReceivableOrderResolutionRequired
      ? explicitOrderReference && explicitOrderReference.kind || ''
      : '',
    evidenceSource: explicitReceivableOrderResolutionRequired
      ? explicitOrderReference && explicitOrderReference.evidenceSource || ''
      : '',
    requiresResolution: explicitReceivableOrderResolutionRequired && Boolean(
      explicitOrderReference && explicitOrderReference.requiresResolution === true
    ),
    candidateIds: explicitReceivableOrderResolutionRequired
      ? safeOrderCandidateIds.slice()
      : [],
    selectedOrderId: explicitReceivableOrderResolutionRequired
      ? String(selectedOrderId || '')
      : '',
    selectionConfirmed: explicitReceivableOrderResolutionRequired
      ? orderSelectionConfirmed
      : false,
    selectedOrderEligible: explicitReceivableOrderResolutionRequired
      ? selectedOrderEligible
      : false,
    resolved: false,
    status: explicitReceivableOrderResolutionRequired
      ? 'UNRESOLVED'
      : 'NOT_APPLICABLE'
  };
  if (explicitReceivableOrderResolutionRequired) {
    if (!activeOrderCandidates.length) {
      requiredSelections.push('orderId');
      addIssue(blockingIssues, orderChecks, issue(
        'ORDER_REFERENCE_UNRESOLVED', 'orderId', 'ZERO_TOLERANCE',
        'RECEIVABLE_EXPLICIT_ORDER_REFERENCE', 'SELECT_ORDER', [selectedOrderId]
      ));
      orderReferenceGate.status = 'NO_SAFE_CANDIDATE';
    } else if (!selectedOrderId) {
      requiredSelections.push('orderId');
      addIssue(blockingIssues, orderChecks, issue(
        activeOrderCandidates.length > 1
          ? 'MULTIPLE_ORDER_SELECTION_REQUIRED'
          : 'ORDER_SELECTION_REQUIRED',
        'orderId', 'ZERO_TOLERANCE',
        'RECEIVABLE_EXPLICIT_ORDER_REFERENCE', 'SELECT_ORDER',
        safeOrderCandidateIds
      ));
      orderReferenceGate.status = 'SELECTION_REQUIRED';
    } else if (!selectedOrderEligible) {
      requiredSelections.push('orderId');
      addIssue(blockingIssues, orderChecks, issue(
        'ORDER_REFERENCE_NOT_ELIGIBLE', 'orderId', 'ZERO_TOLERANCE',
        'RECEIVABLE_EXPLICIT_ORDER_REFERENCE', 'SELECT_ORDER',
        [selectedOrderId].concat(safeOrderCandidateIds)
      ));
      orderReferenceGate.status = 'SELECTION_NOT_ELIGIBLE';
    } else if (!orderSelectionConfirmed) {
      requiredSelections.push('orderId');
      addIssue(blockingIssues, orderChecks, issue(
        'ORDER_SELECTION_CONFIRMATION_REQUIRED', 'orderId', 'DANGEROUS',
        'RECEIVABLE_EXPLICIT_ORDER_REFERENCE', 'SELECT_ORDER', [selectedOrderId]
      ));
      orderReferenceGate.status = 'SELECTION_CONFIRMATION_REQUIRED';
    } else {
      orderReferenceGate.resolved = true;
      orderReferenceGate.status = 'RESOLVED';
    }
  }
  if (operation === 'record_order_deposit') {
    if (selectedOrderId && order && !input.selectedOrderId && fields.orderSelectionConfirmed !== true
      && !(input.userConfirmedRelations || []).includes('orderId')) {
      requiredSelections.push('orderId');
      addIssue(blockingIssues, orderChecks, issue(
        'ORDER_SELECTION_CONFIRMATION_REQUIRED', 'orderId', 'DANGEROUS', 'DEPOSIT_ORDER_CONFIRMATION', 'SELECT_ORDER', [order.id]
      ));
    }
    if (order && !ACTIVE_ORDER_STATUSES.includes(order.status)) addIssue(blockingIssues, orderChecks, issue(
      'ORDER_TARGET_NOT_ACTIVE', 'orderId', 'ZERO_TOLERANCE', 'DEPOSIT_ORDER_STATUS', 'SELECT_ORDER', [order.id], { resolvableByUser: false }
    ));
    if (!selectedOrderId && activeOrderCandidates.length && !(
      fields.allowUnlinkedOrderDeposit === true && fields.unlinkedOrderDepositCustomerId === customerIdForCandidates
    )) {
      requiredSelections.push('orderId');
      addIssue(blockingIssues, orderChecks, issue(
        activeOrderCandidates.length > 1 ? 'MULTIPLE_ORDER_SELECTION_REQUIRED' : 'ORDER_SELECTION_REQUIRED',
        'orderId', 'ZERO_TOLERANCE', 'DEPOSIT_ORDER_CANDIDATES', 'SELECT_ORDER', activeOrderCandidates.map((item) => item.id)
      ));
    }
    const strictDeposit = parseStrictMoney(fields.depositAmount || fields.paymentAmount || fields.amount);
    const depositAmount = strictDeposit.value;
    amountChecks.inputAmount = depositAmount;
    amountChecks.calculationSource = order ? 'ORDER_REMAINING_SETTLEMENT' : 'UNLINKED_DEPOSIT';
    if (!strictDeposit.valid) addIssue(blockingIssues, depositChecks, issue(
      'DEPOSIT_AMOUNT_INVALID', 'depositAmount', 'ZERO_TOLERANCE', 'DEPOSIT_POSITIVE_AMOUNT', 'EDIT_FIELDS'
    ));
    if (order) {
      const linkedReceivables = (state.receivables || []).filter((item) => item.orderId === order.id);
      if (linkedReceivables.length > 1 || linkedReceivables.some((item) => item.customerId !== order.customerId)) addIssue(blockingIssues, depositChecks, issue(
        'ORDER_RECEIVABLE_LINKS_INCONSISTENT', 'orderId', 'ZERO_TOLERANCE', 'DEPOSIT_RECEIVABLE_RELATIONS', 'SELECT_ORDER', linkedReceivables.map((item) => item.id), { resolvableByUser: false }
      ));
      const remaining = calculateOrderRemainingSettlement(state, order);
      amountChecks.expectedMaximum = remaining;
      amountChecks.remainingAmount = Math.max(0, remaining - depositAmount);
      amountChecks.comparison = depositAmount > remaining
        ? 'GREATER_THAN_MAXIMUM'
        : (depositAmount === remaining ? 'EQUAL_TO_MAXIMUM' : 'LESS_THAN_MAXIMUM');
      if (depositAmount > remaining) addIssue(blockingIssues, depositChecks, issue(
        'DEPOSIT_EXCEEDS_ORDER_REMAINING', 'depositAmount', 'ZERO_TOLERANCE', 'DEPOSIT_AMOUNT_LIMIT', 'EDIT_FIELDS', [order.id]
      ));
      const linkedReceivable = linkedReceivables[0] || null;
      const invalidOrderTotal = !Number.isFinite(Number(order.totalAmount)) || Number(order.totalAmount) <= 0;
      const invalidLinkedReceivable = linkedReceivable && (
        !Number.isFinite(Number(linkedReceivable.amount)) || Number(linkedReceivable.amount) <= 0
        || !Number.isFinite(Number(linkedReceivable.paidAmount || 0)) || Number(linkedReceivable.paidAmount || 0) < 0
      );
      const invalidDepositHistory = (state.paymentRecords || []).some((item) => (
        item.orderId === order.id
        && ['deposit'].includes(item.kind || item.paymentKind)
        && (!Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0)
      ));
      const unreconciledOrderPayments = (state.paymentRecords || []).filter((item) => (
        item.orderId === order.id
        && !item.receivableId
        && (Boolean(linkedReceivable) || !['deposit'].includes(item.kind || item.paymentKind))
      ));
      if (invalidOrderTotal || invalidLinkedReceivable || invalidDepositHistory) addIssue(
        blockingIssues, depositChecks,
        issue('ORDER_SETTLEMENT_HISTORY_INVALID', 'orderId', 'ZERO_TOLERANCE',
          'DEPOSIT_DIRTY_HISTORY', 'SELECT_ORDER', [order.id], { resolvableByUser: false })
      );
      if (unreconciledOrderPayments.length) addIssue(
        blockingIssues, depositChecks,
        issue('ORDER_SETTLEMENT_HISTORY_CONFLICT', 'orderId', 'ZERO_TOLERANCE',
          'DEPOSIT_PAYMENT_HISTORY_RECONCILIATION', 'SELECT_ORDER',
          [order.id].concat(unreconciledOrderPayments.map((item) => item.id)), { resolvableByUser: false })
      );
      if (linkedReceivable && getReceivableSettlementHistoryIssue(state, linkedReceivable)) addIssue(
        blockingIssues, depositChecks,
        issue('RECEIVABLE_SETTLEMENT_HISTORY_CONFLICT', 'receivableId', 'ZERO_TOLERANCE',
          'DEPOSIT_RECEIVABLE_HISTORY_RECONCILIATION', 'SELECT_RECEIVABLE',
          [linkedReceivable.id], { resolvableByUser: false })
      );
      const rawRemaining = linkedReceivable
        ? toMoney(linkedReceivable.amount) - toMoney(linkedReceivable.paidAmount)
        : toMoney(order.totalAmount) - calculateOrderDepositAmount(state, order.id);
      if (rawRemaining < 0) addIssue(blockingIssues, depositChecks, issue(
        'ORDER_SETTLEMENT_HISTORY_OVERPAID', 'orderId', 'ZERO_TOLERANCE',
        'DEPOSIT_DIRTY_HISTORY', 'SELECT_ORDER', [order.id], { resolvableByUser: false }
      ));
      if (hasExactPaymentReplay(state, fields, {
        originalText: input.originalText || result.originalText || result.original_text,
        amount: fields.depositAmount || fields.paymentAmount || fields.amount,
        kind: 'deposit',
        customerId: order.customerId,
        orderId: order.id
      })) addIssue(blockingIssues, duplicateChecks, issue(
        'POSSIBLE_DUPLICATE_DEPOSIT', 'depositAmount', 'ZERO_TOLERANCE',
        'DEPOSIT_EXACT_REPLAY', 'REVIEW_SAFETY', [order.id]
      ));
    } else if (customerIdForCandidates && hasExactPaymentReplay(state, fields, {
      originalText: input.originalText || result.originalText || result.original_text,
      amount: fields.depositAmount || fields.paymentAmount || fields.amount,
      kind: 'unlinked_deposit',
      customerId: customerIdForCandidates
    })) addIssue(blockingIssues, duplicateChecks, issue(
      'POSSIBLE_DUPLICATE_DEPOSIT', 'depositAmount', 'ZERO_TOLERANCE',
      'DEPOSIT_EXACT_REPLAY', 'REVIEW_SAFETY', []
    ));
  }

  if (operation === 'create_order') {
    const depositRaw = fields.depositAmount || fields.paymentAmount;
    if (hasValue(depositRaw)) {
      const strictDeposit = parseStrictMoney(depositRaw);
      const depositAmount = strictDeposit.value;
      const strictTotal = parseStrictMoney(resolveDraftTotalAmount(fields));
      const totalAmount = strictTotal.value;
      amountChecks.inputAmount = depositAmount;
      amountChecks.expectedMaximum = totalAmount;
      amountChecks.remainingAmount = Math.max(0, totalAmount - depositAmount);
      amountChecks.comparison = depositAmount > totalAmount
        ? 'GREATER_THAN_MAXIMUM'
        : (depositAmount === totalAmount ? 'EQUAL_TO_MAXIMUM' : 'LESS_THAN_MAXIMUM');
      amountChecks.calculationSource = 'ORDER_TOTAL_MINUS_DEPOSIT';
      if (!strictDeposit.valid || !strictTotal.valid || depositAmount > totalAmount) addIssue(blockingIssues, depositChecks, issue(
        !strictTotal.valid ? 'ORDER_TOTAL_REQUIRED_FOR_DEPOSIT'
          : (!strictDeposit.valid ? 'DEPOSIT_AMOUNT_INVALID' : 'DEPOSIT_EXCEEDS_ORDER_TOTAL'),
        'depositAmount', 'ZERO_TOLERANCE', 'NEW_ORDER_DEPOSIT_LIMIT', 'EDIT_FIELDS'
      ));
    }
  }

  const customerSelectionRequired = blockingIssues.some((item) => (
    ['CUSTOMER_SELECTION_REQUIRED', 'CUSTOMER_SELECTION_CONFIRMATION_REQUIRED'].includes(item.code)
  ));
  const orderSelectionRequired = requiredSelections.includes('orderId');
  const receivableSelectionRequired = requiredSelections.includes('receivableId');
  const quotationSelectionRequired = requiredSelections.includes('quotationId');
  const customerCandidates = customerResolution.candidates;
  const quotationCandidateCustomerId = customerResolution.customerId || '';
  const quotationSelectionCandidates = explicitQuotationResolutionRequired
    ? quotationRelationMatches.safeMatches.map((item) => (
      projectQuotationSelectionCandidate(
        state,
        item,
        customerResolution.customer,
        operation,
        quotationSelectionRequired,
        selectedQuotationId
      )
    ))
    : buildQuotationSelectionCandidates(
      state,
      operation,
      quotationCandidateCustomerId,
      quotationSelectionRequired,
      selectedQuotationId
    );
  const safeQuotationIds = new Set(
    quotationSelectionCandidates.map((item) => String(item.quotationId || item.id || ''))
  );
  const rejectedQuotationId = String(
    rejectedQuotation && rejectedQuotation.id || rawQuotationId || ''
  );
  const rejectedQuotationReferences = rejectedQuotationId
    && rejectedQuotationCodes.length
    && !safeQuotationIds.has(rejectedQuotationId)
    ? [{
      quotationId: rejectedQuotationId,
      customerId: rejectedQuotationCodes.includes('QUOTATION_CUSTOMER_MISMATCH')
        ? ''
        : String(rejectedQuotation && rejectedQuotation.customerId || ''),
      status: rejectedQuotationCodes.includes('QUOTATION_CUSTOMER_MISMATCH')
        ? ''
        : String(rejectedQuotation && rejectedQuotation.status || ''),
      convertedOrderId: rejectedQuotationCodes.includes('QUOTATION_CUSTOMER_MISMATCH')
        ? ''
        : String(rejectedQuotation && rejectedQuotation.convertedOrderId || ''),
      selectionEligible: false,
      selectionBlockingCodes: uniqueStrings(rejectedQuotationCodes)
    }]
    : [];
  const quotationRelationGate = {
    applies: explicitQuotationResolutionRequired || (
      operation === 'create_order' && Boolean(rawQuotationId)
    ),
    evidenceKind: explicitQuotationResolutionRequired
      ? String(explicitQuotationReference && explicitQuotationReference.kind || '')
      : '',
    evidenceSource: explicitQuotationResolutionRequired
      ? String(explicitQuotationReference && explicitQuotationReference.evidenceSource || '')
      : '',
    requiresResolution: explicitQuotationResolutionRequired,
    providedQuotationId: rawQuotationId,
    selectedQuotationId: String(quotation && quotation.id || ''),
    selectionConfirmed: operation === 'create_order'
      ? (quotationSelectionConfirmed && Boolean(quotation))
      : Boolean(quotation),
    safeCandidateIds: Array.from(safeQuotationIds),
    dangerousMatchIds: quotationRelationMatches.dangerousMatches
      .map((item) => String(item.quotation && item.quotation.id || '')),
    ambiguousMatchIds: quotationRelationMatches.ambiguousMatches
      .map((item) => String(item.quotation && item.quotation.id || '')),
    rejectedQuotationIds: rejectedQuotationReferences
      .map((item) => item.quotationId),
    resolved: Boolean(quotation),
    status: !explicitQuotationResolutionRequired && !rawQuotationId
      ? 'NOT_APPLICABLE'
      : (quotation
        ? 'RESOLVED'
        : (rejectedQuotationReferences.length
          ? 'DANGEROUS_REFERENCE_REJECTED'
          : (quotationIdConflict
            ? 'SELECTION_CONFLICT'
            : (quotationSelectionCandidates.length
              ? 'SELECTION_REQUIRED'
              : (quotationRelationMatches.ambiguousMatches.length
                || quotationRelationMatches.dangerousMatches.length > 1
                ? 'AMBIGUOUS_REFERENCE'
                : 'NO_SAFE_CANDIDATE')))))
  };
  // Compatibility alias: quotationCandidates now has the same safe-selection
  // semantics as quotationSelectionCandidates. Dangerous current references
  // are exposed only through rejectedQuotationReferences and relation checks.
  const quotationCandidates = quotationSelectionCandidates;
  const orderCandidates = activeOrderCandidates.map((item) => candidate(
    item, `${item.productName || '未填产品'}，交期${item.requiredDeliveryDate || '-'}`,
    'active_order_for_customer', Boolean(order && order.id === item.id), orderSelectionRequired
  ));
  const receivableCandidates = activeReceivableCandidates.map((item) => candidate(
    item, `待收${item.amount || '-'}元，到期${item.dueDate || '-'}`,
    'active_receivable_for_customer', Boolean(receivable && receivable.id === item.id), receivableSelectionRequired
  ));

  // This is the final structural safety net for page edits made after parsing.
  // Do not add redundant item errors to drafts that are already blocked by a
  // more specific parse/domain contract; once those issues are resolved, the
  // same preflight exposes the incomplete line item precisely.
  if (businessType === 'order' && blockingIssues.length === 0) {
    finalItems.forEach((item, itemIndex) => {
      const quantity = Number(item && item.quantity);
      if (hasValue(item && item.quantity) && Number.isFinite(quantity) && quantity > 0) return;
      addIssue(blockingIssues, targetChecks, issue(
        'ORDER_ITEM_QUANTITY_REQUIRED', 'items', 'ZERO_TOLERANCE',
        'ORDER_ITEM_REQUIRED_FACTS', 'EDIT_FIELDS', [], {
          itemKey: String(item && item.confirmationItemKey || ''),
          itemIndex,
          itemField: 'quantity',
          fieldPath: `items[${itemIndex}].quantity`
        }
      ));
    });
  }

  const baseFormalReady = isParseSafetyReady(result);
  const domainCanSaveFormal = baseFormalReady && blockingIssues.length === 0;
  const strictOriginalText = input.originalText
    || result.originalText
    || result.original_text
    || fields.originalText
    || fields.original_text
    || '';
  const domainCanSavePending = !noRecordPersistenceForbidden && Boolean(strictOriginalText);
  const resolvedRelations = {
    customerId: customerResolution.customerId || '',
    quotationId: quotation ? quotation.id : '',
    orderId: order ? order.id : '',
    receivableId: receivable ? receivable.id : '',
    resolutionSource: {
      customerId: customerResolution.resolutionSource,
      quotationId: quotationResolutionSource,
      orderId: orderResolutionSource,
      receivableId: receivableResolutionSource
    },
    resolutionConfidence: {
      customerId: customerResolution.customer ? 1 : null,
      quotationId: quotation ? 1 : null,
      orderId: order ? 1 : null,
      receivableId: receivable ? 1 : null
    },
    requiresUserSelection: requiredSelections.length > 0
  };
  const candidates = {
    customerCandidates,
    customerCandidatesResolved: relationsEnabled,
    customerSelectionRequired,
    quotationCandidates,
    quotationSelectionCandidates,
    quotationCandidatesResolved: relationsEnabled,
    quotationSelectionCandidatesResolved: relationsEnabled,
    quotationSelectionRequired,
    rejectedQuotationReferences,
    orderCandidates,
    orderCandidatesResolved: relationsEnabled,
    orderSelectionRequired,
    receivableCandidates,
    receivableCandidatesResolved: relationsEnabled,
    receivableSelectionRequired,
    candidatesResolved: relationsEnabled
  };
  const fingerprintPayload = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    mode,
    resultScope,
    operation,
    businessType,
    fields: normalizeFieldsForFingerprint(fields),
    originalText: strictOriginalText,
    aiFacts,
    userResolution,
    blockingIssues,
    warnings,
    requiredSelections: uniqueStrings(requiredSelections),
    resolvedRelations,
    candidates,
    orderReferenceGate,
    quotationRelationGate,
    amountChecks,
    stateFacts: {
      customers: (state.customers || []).map((item) => ({ id: item.id, name: item.name, mergedInto: item.mergedInto || '' })),
      quotations: (state.quotations || []).map((item) => ({ id: item.id, customerId: item.customerId, status: item.status, convertedOrderId: item.convertedOrderId || '' })),
      orders: (state.orders || []).map((item) => ({ id: item.id, customerId: item.customerId, quotationId: item.quotationId || '', status: item.status, totalAmount: item.totalAmount })),
      receivables: (state.receivables || []).map((item) => ({ id: item.id, customerId: item.customerId, orderId: item.orderId || '', status: item.status, amount: item.amount, paidAmount: item.paidAmount })),
      payments: (state.paymentRecords || []).map((item) => ({ id: item.id, customerId: item.customerId, orderId: item.orderId || '', receivableId: item.receivableId || '', kind: item.kind || item.paymentKind || '', amount: item.amount }))
    }
  };

  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    operation,
    businessType,
    mode,
    resultScope,
    domainCanSaveFormal,
    domainCanSavePending,
    noRecordPersistenceForbidden,
    noRecordPersistenceFacts,
    formalSaveBlocked: !domainCanSaveFormal,
    productionEligibilityResolved: mode === PRODUCTION_MODE && resultScope === PRODUCTION_SCOPE,
    userResolution,
    blockingIssues,
    warnings,
    requiredSelections: uniqueStrings(requiredSelections),
    resolvedRelations,
    candidates,
    orderReferenceGate,
    quotationRelationGate,
    customerChecks,
    quotationChecks,
    orderChecks,
    receivableChecks,
    paymentChecks,
    depositChecks,
    amountChecks,
    targetChecks,
    aiChecks,
    duplicateChecks,
    preflightFingerprint: stableFingerprint(fingerprintPayload)
  };
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  ACTIVE_QUOTATION_STATUS,
  ACTIVE_RECEIVABLE_STATUSES,
  EXPLICIT_ORDER_REFERENCE_KINDS,
  ORDER_REFERENCE_SOURCE_FIELDS,
  PREFLIGHT_SCHEMA_VERSION,
  QUOTATION_ORDER_RELATION_STATES,
  assessQuotationOrderRelation,
  calculateCanonicalOrderItemsTotal,
  calculateOrderDepositAmount,
  calculateOrderRemainingSettlement,
  customerNameMatches,
  evaluateRecordDomainPreflight,
  findCustomerMatches,
  getCustomerNameMatchKind,
  getCustomerById,
  getExplicitOrderReference,
  getNoRecordPersistenceFacts,
  getTrustedRecordFlowContext,
  getReceivablePaymentIssue,
  getReceivableRemainingAmount,
  getQuotationSelectionBlockingCodes,
  isQuotationConverted,
  isOrderSelectableForRelation,
  isNoRecordPersistenceForbidden,
  isParseSafetyReady,
  orderMatchesProduct,
  requiresExplicitReceivableOrderResolution,
  resolveDraftTotalAmount,
  stableFingerprint,
  stableSerialize
};
