const {
  ACTION_TYPES,
  CONFIRMATION_SCHEMA_VERSION,
  CONFIRMATION_STATUSES,
  FIELD_CATALOG,
  FIELD_SOURCES,
  FIELD_VISIBILITIES,
  RISK_LEVELS,
  SURFACE_CAPABILITY_NAMES,
  SURFACE_TYPES,
  getConfirmationFieldPolicy,
  hasSurfaceCapability,
  normalizeSurfaceCapabilities,
  resolveConfirmationOperation
} = require('./record-confirmation-contract');
const { evaluateRecordDomainPreflight, getTrustedRecordFlowContext } = require('./record-domain-preflight');

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

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
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

// This is a deterministic invalidation fingerprint, not a cryptographic signature.
function stableContentHash(value) {
  const text = stableSerialize(value);
  let fnv = 2166136261;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv ^= code;
    fnv = Math.imul(fnv, 16777619) >>> 0;
    djb = (((djb << 5) + djb) ^ code) >>> 0;
  }
  return `rc1_${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`;
}

function resolveBusinessType(result = {}) {
  const operation = result.operation || '';
  const intent = result.intent || 'unknown';
  if (operation === 'record_order_deposit') return 'order_deposit';
  if (intent === 'dunning') return 'todo';
  if (intent === 'unknown' || operation === 'pending') return 'pending';
  return intent;
}

function resolveTodoType(result = {}) {
  if (result.intent === 'dunning') return 'dunning';
  return (result.fields || {}).todoType || '';
}

function getDateSemanticKey(businessType) {
  return {
    quotation: 'quoteFollowupDate',
    order: 'orderDeliveryDate',
    receivable: 'receivableDueDate',
    payment: 'paymentDate',
    todo: 'todoRemindDate'
  }[businessType] || '';
}

function mapLegacyFieldKey(field, businessType, operation) {
  if (field === 'intent') return 'businessType';
  if (field === 'dueDate') return getDateSemanticKey(businessType) || 'dueDate';
  if (field === 'amount') {
    if (businessType === 'receivable') return 'receivableAmount';
    if (businessType === 'payment') return 'paymentAmount';
    return 'totalAmount';
  }
  if (field === 'paymentAmount' && operation === 'record_order_deposit') return 'depositAmount';
  return field;
}

function resolveSemanticValues(result, businessType) {
  const fields = result.fields || {};
  const values = {};
  Object.keys(FIELD_CATALOG).forEach((key) => {
    if (hasValue(fields[key])) values[key] = safeClone(fields[key]);
  });
  const dateKey = getDateSemanticKey(businessType);
  if (dateKey && !hasValue(values[dateKey]) && hasValue(fields.dueDate)) values[dateKey] = fields.dueDate;
  if (businessType === 'receivable' && !hasValue(values.receivableAmount) && hasValue(fields.amount)) {
    values.receivableAmount = fields.amount;
  }
  if (['quotation', 'order'].includes(businessType)
    && !hasValue(values.totalAmount)
    && hasValue(fields.amount)) {
    values.totalAmount = fields.amount;
  }
  if (businessType === 'order_deposit') {
    if (!hasValue(values.depositAmount) && hasValue(fields.paymentAmount)) values.depositAmount = fields.paymentAmount;
    delete values.paymentAmount;
  }
  return values;
}

function getLegacyKeyForSemantic(key, businessType, operation, fields) {
  if (key === getDateSemanticKey(businessType) && !hasValue(fields[key])) return 'dueDate';
  if (key === 'receivableAmount' && !hasValue(fields.receivableAmount)) return 'amount';
  if (key === 'totalAmount' && !hasValue(fields.totalAmount)) return 'amount';
  if (key === 'depositAmount' && operation === 'record_order_deposit' && !hasValue(fields.depositAmount)) return 'paymentAmount';
  return key;
}

function buildItems(result, businessType) {
  const fields = result.fields || {};
  const sourceItems = Array.isArray(fields.items)
    ? fields.items.filter((item) => item && typeof item === 'object')
    : [];
  if (sourceItems.length) {
    return { items: safeClone(sourceItems), derivedFromLegacy: false };
  }
  if (!['quotation', 'order'].includes(businessType)) return { items: [], derivedFromLegacy: false };
  const legacyItem = {};
  ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'itemDeliveryDate', 'itemRemark']
    .forEach((field) => {
      if (hasValue(fields[field])) legacyItem[field] = safeClone(fields[field]);
    });
  return Object.keys(legacyItem).length
    ? { items: [legacyItem], derivedFromLegacy: true }
    : { items: [], derivedFromLegacy: false };
}

function normalizeFieldSource(result, semanticKey, legacyKey) {
  const manual = uniqueStrings(result.manual_fields || []);
  if (manual.includes(semanticKey) || manual.includes(legacyKey)) {
    return { source: FIELD_SOURCES.USER, sourceResolved: true, rawReference: 'manual_fields' };
  }
  const sources = result.field_sources || {};
  const rawReference = sources[semanticKey] || sources[legacyKey] || '';
  return {
    source: FIELD_SOURCES.UNKNOWN,
    sourceResolved: false,
    rawReference: String(rawReference || '')
  };
}

function normalizeEvidence(result, semanticKey, legacyKey) {
  const evidence = result.field_evidence || {};
  const value = Object.prototype.hasOwnProperty.call(evidence, semanticKey)
    ? evidence[semanticKey]
    : evidence[legacyKey];
  return {
    value: value === undefined ? null : safeClone(value),
    resolved: value !== undefined && value !== null && value !== ''
  };
}

function buildBlockingIssues(preflight, businessType, operation) {
  return (preflight.blockingIssues || []).map((item) => Object.assign({}, safeClone(item), {
    field: mapLegacyFieldKey(item.field || '', businessType, operation),
    source: item.sourceRule || 'DOMAIN_PREFLIGHT'
  }));
}

function candidateDisplayName(candidate, type) {
  if (!candidate || typeof candidate !== 'object') return '';
  if (candidate.displayName || candidate.label || candidate.name) {
    return String(candidate.displayName || candidate.label || candidate.name);
  }
  if (type === 'order') return String(candidate.productName || candidate.id || '');
  return String(candidate.id || '');
}

function normalizeCandidateList(value, type, selectedId, selectionRequired) {
  const source = Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  return source.map((candidate) => ({
    id: String(candidate.id || ''),
    displayName: candidateDisplayName(candidate, type),
    matchReason: String(candidate.matchReason || candidate.match_reason || ''),
    confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : null,
    isExact: candidate.isExact === true || candidate.is_exact === true,
    isSelected: Boolean(selectedId && String(candidate.id || '') === String(selectedId)),
    selectionRequired: candidate.selectionRequired === true || selectionRequired === true
  }));
}

function getCandidateSource(result, localResult, candidateContext, resultScope, type) {
  const field = `${type}_candidates`;
  const contextField = `${type}Candidates`;
  const resolvedField = `${type}CandidatesResolved`;
  if (candidateContext && Array.isArray(candidateContext[contextField])) {
    return {
      value: candidateContext[contextField],
      resolved: candidateContext[resolvedField] === true,
      selectionRequired: candidateContext[`${type}SelectionRequired`] === true
    };
  }
  if (type === 'customer' && resultScope !== 'AI_ONLY_RESULT'
    && localResult && Array.isArray(localResult[field])) {
    return {
      value: localResult[field],
      resolved: true,
      selectionRequired: localResult[`${type}_selection_required`] === true
    };
  }
  // Candidate identities are business-context facts. Model output may mention
  // candidates, but it cannot establish that those records really exist.
  // Only trusted caller context or the existing local history resolver may
  // populate selectable candidates.
  return { value: [], resolved: false, selectionRequired: false };
}

function buildCandidates(result, resultScope, candidateContext = {}, localResult = null) {
  const fields = result.fields || {};
  const definitions = [
    ['customer', 'customerId'],
    ['order', 'orderId'],
    ['quotation', 'quotationId'],
    ['receivable', 'receivableId']
  ];
  const candidates = {};
  let allResolved = true;
  definitions.forEach(([type, idField]) => {
    const source = getCandidateSource(result, localResult, candidateContext, resultScope, type);
    const items = normalizeCandidateList(
      source.value,
      type,
      fields[idField],
      source.selectionRequired
    );
    const title = `${type}Candidates`;
    candidates[title] = items;
    candidates[`${title}Resolved`] = source.resolved;
    candidates[`${type}SelectionRequired`] = source.selectionRequired === true;
    if (!source.resolved) allResolved = false;
  });
  candidates.quotationSelectionCandidates = safeClone(candidates.quotationCandidates);
  candidates.quotationSelectionCandidatesResolved = candidates.quotationCandidatesResolved === true;
  candidates.rejectedQuotationReferences = safeClone(
    candidateContext.rejectedQuotationReferences || []
  );
  candidates.candidatesResolved = allResolved;
  return candidates;
}

function getCandidateSelectionCapabilities(candidates) {
  const required = [];
  if (candidates.customerSelectionRequired) required.push(SURFACE_CAPABILITY_NAMES.SELECT_CUSTOMER);
  if (candidates.orderSelectionRequired) required.push(SURFACE_CAPABILITY_NAMES.SELECT_ORDER);
  if (candidates.quotationSelectionRequired) required.push(SURFACE_CAPABILITY_NAMES.SELECT_QUOTATION);
  if (candidates.receivableSelectionRequired) required.push(SURFACE_CAPABILITY_NAMES.SELECT_RECEIVABLE);
  return required;
}

function getRequiredSurfaceCapabilities(result, items, candidates, preflight, needsDeepReview, originalText) {
  const required = [];
  if (originalText) required.push(SURFACE_CAPABILITY_NAMES.SHOW_ORIGINAL_TEXT);
  if ((result.missing_fields || []).length || (result.low_confidence_fields || []).length || (result.field_conflicts || []).length) {
    required.push(SURFACE_CAPABILITY_NAMES.EDIT_BASIC_FIELDS);
  }
  if (items.length > 1 || items.some((item) => item.spec || item.itemDeliveryDate)) {
    required.push(SURFACE_CAPABILITY_NAMES.EDIT_ITEMS);
  }
  if (items.some((item) => item.unit && item.priceUnit
    && item.unit !== item.priceUnit && !item.totalAmount)) {
    required.push(SURFACE_CAPABILITY_NAMES.EDIT_ITEMS);
  }
  if (result.requiresFullInputReason
    || result.suggested_operation === 'create_receivable_with_payment') {
    required.push(SURFACE_CAPABILITY_NAMES.HANDLE_COMPLEX_CONFIRMATION);
  }
  (preflight.blockingIssues || []).forEach((item) => {
    if (item.requiredAction === 'SELECT_CUSTOMER') required.push(SURFACE_CAPABILITY_NAMES.SELECT_CUSTOMER);
    if (item.requiredAction === 'SELECT_ORDER') required.push(SURFACE_CAPABILITY_NAMES.SELECT_ORDER);
    if (item.requiredAction === 'SELECT_QUOTATION') required.push(SURFACE_CAPABILITY_NAMES.SELECT_QUOTATION);
    if (item.requiredAction === 'SELECT_RECEIVABLE') required.push(SURFACE_CAPABILITY_NAMES.SELECT_RECEIVABLE);
  });
  required.push(...getCandidateSelectionCapabilities(candidates));
  if (result.requires_existing_record) {
    if (result.operation === 'update_order') required.push(SURFACE_CAPABILITY_NAMES.SELECT_ORDER);
    else if (result.operation === 'update_quotation') required.push(SURFACE_CAPABILITY_NAMES.SELECT_QUOTATION);
    else if (result.intent === 'payment') required.push(SURFACE_CAPABILITY_NAMES.SELECT_RECEIVABLE);
  }
  if (result.intent === 'unknown') required.push(SURFACE_CAPABILITY_NAMES.CHANGE_BUSINESS_TYPE);
  if (needsDeepReview) required.push(SURFACE_CAPABILITY_NAMES.RUN_DEEP_REVIEW);
  required.push(SURFACE_CAPABILITY_NAMES.COMMIT_FORMAL);
  return uniqueStrings(required);
}

function getFieldEditCapability(field) {
  if (field === 'businessType') return SURFACE_CAPABILITY_NAMES.CHANGE_BUSINESS_TYPE;
  if (field === 'originalText') return '';
  if (field === 'customerId') return SURFACE_CAPABILITY_NAMES.SELECT_CUSTOMER;
  if (field === 'orderId') return SURFACE_CAPABILITY_NAMES.SELECT_ORDER;
  if (field === 'quotationId') return SURFACE_CAPABILITY_NAMES.SELECT_QUOTATION;
  if (field === 'receivableId') return SURFACE_CAPABILITY_NAMES.SELECT_RECEIVABLE;
  return SURFACE_CAPABILITY_NAMES.EDIT_BASIC_FIELDS;
}

function buildFieldModels(result, businessType, policy, semanticValues, blockingIssues, capabilities) {
  const missingMapped = uniqueStrings(result.missing_fields || [])
    .map((field) => mapLegacyFieldKey(field, businessType, result.operation));
  const required = uniqueStrings(policy.required || []);
  const issueFields = uniqueStrings(blockingIssues.map((issue) => issue.field));
  const candidateRelationFields = ['customerId', 'orderId', 'quotationId', 'receivableId']
    .filter((field) => hasValue((result.fields || {})[field]));
  const keys = uniqueStrings([].concat(
    Object.keys(semanticValues),
    required,
    missingMapped,
    policy.recommended,
    issueFields,
    candidateRelationFields
  )).filter((key) => FIELD_CATALOG[key]);
  return keys.map((key) => {
    const catalog = FIELD_CATALOG[key];
    const legacyKey = getLegacyKeyForSemantic(key, businessType, result.operation, result.fields || {});
    const fieldIssues = blockingIssues.filter((issue) => issue.field === key);
    const source = normalizeFieldSource(result, key, legacyKey);
    const evidence = normalizeEvidence(result, key, legacyKey);
    let visibility = FIELD_VISIBILITIES.OPTIONAL;
    if (required.includes(key)
      || fieldIssues.length
      || catalog.role === 'RELATION'
      || key === 'businessType'
      || key === 'originalText') visibility = FIELD_VISIBILITIES.MUST_SHOW;
    else if (policy.recommended.includes(key)) visibility = FIELD_VISIBILITIES.RECOMMENDED;
    const riskLevel = fieldIssues.reduce((highest, issue) => {
      const order = Object.values(RISK_LEVELS);
      return order.indexOf(issue.riskLevel) > order.indexOf(highest) ? issue.riskLevel : highest;
    }, RISK_LEVELS.NONE);
    const editCapability = getFieldEditCapability(key);
    return {
      key,
      legacyKey,
      label: catalog.label,
      value: hasValue(semanticValues[key]) ? safeClone(semanticValues[key]) : '',
      displayValue: hasValue(semanticValues[key]) ? String(semanticValues[key]) : '',
      role: catalog.role,
      visibility,
      required: required.includes(key),
      recommended: policy.recommended.includes(key),
      editable: hasSurfaceCapability(capabilities, editCapability),
      riskLevel,
      confidence: null,
      source: source.source,
      sourceResolved: source.sourceResolved,
      rawSourceReference: source.rawReference,
      evidence: evidence.value,
      evidenceResolved: evidence.resolved,
      confirmedByUser: source.source === FIELD_SOURCES.USER,
      issues: safeClone(fieldIssues)
    };
  });
}

function buildItemConfirmations(items, blockingIssues, capabilities) {
  const itemKeys = ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'itemDeliveryDate', 'itemRemark'];
  return items.map((item, index) => ({
    index,
    fields: itemKeys.filter((key) => hasValue(item[key])).map((key) => {
      const catalog = FIELD_CATALOG[key];
      const issues = blockingIssues.filter((issue) => issue.field === key);
      const riskLevel = issues.reduce((highest, issue) => {
        const order = Object.values(RISK_LEVELS);
        return order.indexOf(issue.riskLevel) > order.indexOf(highest) ? issue.riskLevel : highest;
      }, RISK_LEVELS.NONE);
      return {
        key,
        label: catalog.label,
        value: safeClone(item[key]),
        displayValue: String(item[key]),
        role: catalog.role,
        visibility: key === 'productName' ? FIELD_VISIBILITIES.MUST_SHOW : FIELD_VISIBILITIES.RECOMMENDED,
        required: key === 'productName',
        editable: hasSurfaceCapability(capabilities, SURFACE_CAPABILITY_NAMES.EDIT_ITEMS),
        riskLevel,
        hasRisk: issues.length > 0,
        riskResolved: issues.length === 0,
        source: FIELD_SOURCES.UNKNOWN,
        sourceResolved: false,
        evidence: null,
        evidenceResolved: false,
        confirmedByUser: false,
        issues: safeClone(issues)
      };
    })
  }));
}

function createWarning(code, riskLevel, messageKey, source, messageParams = {}) {
  return { code, riskLevel, messageKey, messageParams: safeClone(messageParams), source };
}

function buildWarnings(result, saveEligibility, mode, productionRoute, surfaceMissingCapabilities) {
  const warnings = uniqueStrings(result.unsafe_reasons || []).map((reason, index) => createWarning(
    `FINAL_SAFETY_WARNING_${index + 1}`, RISK_LEVELS.WARNING,
    'CONFIRMATION_FINAL_SAFETY_WARNING', 'FINAL_RESULT', { rawReason: reason }
  ));
  if (saveEligibility && saveEligibility.domainCanSaveFormal === true) {
    uniqueStrings(saveEligibility.blockedReasons || []).forEach((reason, index) => {
      warnings.push(createWarning(
        `COMMIT_POLICY_WARNING_${index + 1}`, RISK_LEVELS.INFO,
        'CONFIRMATION_COMMIT_POLICY_WARNING', 'SAVE_ELIGIBILITY', { rawReason: reason }
      ));
    });
  }
  if (mode === 'LOCAL_ONLY' && ['AI_STANDARD', 'AI_DEEP'].includes(productionRoute)) {
    warnings.push(createWarning(
      'MODE_LOCAL_ONLY_PRODUCTION_AI_REQUIRED', RISK_LEVELS.WARNING,
      'CONFIRMATION_LOCAL_ONLY_PRODUCTION_AI_REQUIRED', 'MODE', { productionRoute }
    ));
  }
  if (surfaceMissingCapabilities.length) {
    warnings.push(createWarning(
      'SURFACE_CAPABILITY_MISSING', RISK_LEVELS.INFO,
      'CONFIRMATION_SURFACE_CAPABILITY_MISSING', 'SURFACE', { capabilities: surfaceMissingCapabilities }
    ));
  }
  return warnings;
}

function action(type, available, enabled, disabledReasons, requiresExplicitUserAction = true) {
  const actionAvailable = available === true;
  const actionEnabled = actionAvailable && enabled === true;
  return {
    type,
    available: actionAvailable,
    enabled: actionEnabled,
    disabledReasons: actionEnabled ? [] : uniqueStrings(disabledReasons || []),
    requiresExplicitUserAction: requiresExplicitUserAction === true
  };
}

function buildActions(confirmationState) {
  const {
    domain,
    surface,
    candidates,
    preflight,
    hasResult,
    hasFields,
    canCommitToRealStorage
  } = confirmationState;
  const formalReasons = [];
  if (!domain.domainCanSaveFormal) formalReasons.push(...domain.domainBlockingReasons);
  if (!surface.surfaceCanCompleteFormal) formalReasons.push(...surface.missingCapabilities);
  if (!canCommitToRealStorage) formalReasons.push('REAL_STORAGE_NOT_ALLOWED');
  return [
    action(ACTION_TYPES.SAVE_FORMAL, hasResult, surface.effectiveCanCommitFormal, formalReasons),
    action(ACTION_TYPES.SAVE_PENDING, hasResult, surface.effectiveCanCommitPending,
      surface.effectiveCanCommitPending
        ? []
        : (surface.effectiveCanSavePending ? ['REAL_STORAGE_NOT_ALLOWED'] : ['PENDING_NOT_AVAILABLE'])),
    action(ACTION_TYPES.OPEN_FULL_PAGE, surface.surfaceType !== SURFACE_TYPES.FULL_PAGE,
      surface.requiresFullPage, surface.requiresFullPage ? [] : ['FULL_PAGE_NOT_REQUIRED']),
    action(ACTION_TYPES.RUN_DEEP_REVIEW, domain.domainNeedsDeepReview,
      domain.domainNeedsDeepReview
        && surface.capabilities.canRunDeepReview
        && !surface.requiresFullPage,
      surface.requiresFullPage
        ? ['OPEN_FULL_PAGE_FIRST']
        : (surface.capabilities.canRunDeepReview ? [] : ['RUN_DEEP_REVIEW_UNAVAILABLE'])),
    action(ACTION_TYPES.EDIT_FIELDS, hasFields,
      surface.capabilities.canEditBasicFields || surface.capabilities.canEditAllFields,
      ['EDIT_FIELDS_UNAVAILABLE']),
    action(ACTION_TYPES.SELECT_CUSTOMER, candidates.customerCandidates.length > 0,
      surface.capabilities.canSelectCustomer, ['SELECT_CUSTOMER_UNAVAILABLE']),
    action(ACTION_TYPES.SELECT_ORDER, candidates.orderCandidates.length > 0,
      surface.capabilities.canSelectOrder, ['SELECT_ORDER_UNAVAILABLE']),
    action(ACTION_TYPES.SELECT_QUOTATION, candidates.quotationCandidates.length > 0,
      surface.capabilities.canSelectQuotation, ['SELECT_QUOTATION_UNAVAILABLE']),
    action(ACTION_TYPES.SELECT_RECEIVABLE, candidates.receivableCandidates.length > 0,
      surface.capabilities.canSelectReceivable, ['SELECT_RECEIVABLE_UNAVAILABLE']),
    action(ACTION_TYPES.CONFIRM_CUSTOMER_HISTORY,
      (preflight.requiredSelections || []).includes('customerHistory'),
      false,
      ['NOT_REQUIRED_BY_CURRENT_DOMAIN_PREFLIGHT']),
    action(ACTION_TYPES.CHANGE_BUSINESS_TYPE, hasResult,
      surface.capabilities.canChangeBusinessType, ['CHANGE_BUSINESS_TYPE_UNAVAILABLE']),
    action(ACTION_TYPES.CANCEL, true, true, [], false)
  ];
}

function buildContentFingerprintPayload(input) {
  const result = input.result;
  const fields = result.fields || {};
  return {
    mode: input.mode,
    resultScope: input.resultScope,
    businessType: input.businessType,
    rawIntent: result.intent || '',
    todoType: resolveTodoType(result),
    operation: input.operation,
    suggestedOperation: result.suggested_operation || '',
    businessFields: safeClone(fields),
    originalText: input.originalText,
    semanticValues: input.semanticValues,
    items: input.items,
    missingFields: uniqueStrings(result.missing_fields || []),
    lowConfidenceFields: uniqueStrings(result.low_confidence_fields || []),
    fieldConflicts: safeClone(result.field_conflicts || []),
    formalSaveBlocked: Boolean(result.formal_save_blocked),
    mixedBusiness: Boolean(result.mixed_business),
    requiresExistingRecord: Boolean(result.requires_existing_record),
    aiState: {
      status: (result.ai_fallback || {}).status || 'not_requested',
      businessResultValid: (result.ai_fallback || {}).business_result_valid === true
    },
    selectedRelations: {
      customerId: fields.customerId || '',
      quotationId: fields.quotationId || '',
      orderId: fields.orderId || '',
      receivableId: fields.receivableId || ''
    },
    manualFields: uniqueStrings(result.manual_fields || []),
    userConfirmationState: {
      customerHistoryConfirmed: fields.customerHistoryConfirmed === true,
      orderSelectionConfirmed: fields.orderSelectionConfirmed === true,
      receivableSelectionConfirmed: fields.receivableSelectionConfirmed === true,
      forceNewCustomer: fields.forceNewCustomer === true,
      allowUnlinkedPayment: fields.allowUnlinkedPayment === true,
      unlinkedPaymentCustomerId: fields.unlinkedPaymentCustomerId || '',
      allowUnlinkedOrderDeposit: fields.allowUnlinkedOrderDeposit === true,
      unlinkedOrderDepositCustomerId: fields.unlinkedOrderDepositCustomerId || '',
      customerNote: fields.customerNote || '',
      company: fields.company || '',
      region: fields.region || '',
      wechatRemark: fields.wechatRemark || ''
    },
    candidateState: ['customer', 'quotation', 'order', 'receivable'].reduce((state, type) => {
      const title = `${type}Candidates`;
      state[type] = {
        resolved: input.candidates[`${title}Resolved`] === true,
        selectionRequired: input.candidates[`${type}SelectionRequired`] === true,
        items: (input.candidates[title] || []).map((item) => ({
          id: item.id || '',
          isSelected: item.isSelected === true,
          selectionRequired: item.selectionRequired === true
        })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
      };
      return state;
    }, {}),
    preflightFingerprint: input.preflight.preflightFingerprint,
    domainCanSaveFormal: input.domainCanSaveFormal,
    canCommitToRealStorage: input.canCommitToRealStorage
  };
}

function buildSourceReferences(input) {
  const reference = input.traceReference && typeof input.traceReference === 'object'
    ? input.traceReference
    : {};
  return {
    runId: String(reference.runId || ''),
    traceId: String(reference.traceId || ''),
    caseId: String(reference.caseId || ''),
    finalSafetyAvailable: Boolean(input.finalSafety),
    candidateContextProvided: Boolean(input.candidateContext),
    preflightFingerprint: String((input.preflight && input.preflight.preflightFingerprint) || '')
  };
}

function buildRecordConfirmation(input = {}) {
  const result = input.finalResult && typeof input.finalResult === 'object'
    ? safeClone(input.finalResult)
    : null;
  const flowContext = getTrustedRecordFlowContext(result || {});
  const mode = input.mode || flowContext.mode || '';
  const resultScope = input.resultScope || flowContext.resultScope || '';
  const originalText = typeof input.originalText === 'string'
    ? input.originalText
    : (result && (result.originalText || result.original_text)) || '';
  const capabilities = normalizeSurfaceCapabilities(input.surfaceCapabilities);
  if (!result) {
    const emptyHash = stableContentHash({ mode, resultScope, originalText });
    return {
      schemaVersion: CONFIRMATION_SCHEMA_VERSION,
      confirmationId: input.confirmationId || `confirmation_${emptyHash}`,
      revision: 1,
      contentHash: emptyHash,
      status: CONFIRMATION_STATUSES.NO_RESULT,
      mode,
      resultScope,
      businessType: 'pending',
      operation: 'pending',
      todoType: '',
      originalText,
      normalizedText: input.normalizedText || '',
      inputSource: input.inputSource || 'typed',
      fields: [],
      items: [],
      itemConfirmations: [],
      itemsDerivedFromLegacy: false,
      requiredFields: [],
      requiredFieldGroups: [],
      recommendedFields: [],
      optionalFields: [],
      missingFields: [],
      lowConfidenceFields: [],
      fieldConflicts: [],
      preflightFingerprint: '',
      preflight: null,
      warnings: [],
      blockingIssues: [],
      candidates: {
        customerCandidates: [], customerCandidatesResolved: false, customerSelectionRequired: false,
        orderCandidates: [], orderCandidatesResolved: false, orderSelectionRequired: false,
        quotationCandidates: [], quotationCandidatesResolved: false, quotationSelectionRequired: false,
        quotationSelectionCandidates: [], quotationSelectionCandidatesResolved: false,
        rejectedQuotationReferences: [],
        receivableCandidates: [], receivableCandidatesResolved: false, receivableSelectionRequired: false,
        candidatesResolved: false,
        customerHistoryConfirmationRequired: false,
        customerHistoryCount: 0,
        customerHistoryKind: '',
        newCustomerDiscriminatorRequired: false
      },
      domain: {
        domainCanSaveFormal: false,
        domainCanSavePending: false,
        domainNeedsUserConfirmation: false,
        domainNeedsDeepReview: false,
        domainFormalSaveBlocked: true,
        domainBlockingReasons: ['NO_RESULT'],
        domainWarnings: []
      },
      surface: {
        surfaceType: capabilities.surfaceType,
        capabilities,
        surfaceCanCompleteFormal: false,
        surfaceCanCompletePending: false,
        requiresFullPage: false,
        missingCapabilities: [],
        displayWarnings: [],
        effectiveCanSaveFormal: false,
        effectiveCanCommitFormal: false,
        effectiveCanSavePending: false,
        effectiveCanCommitPending: false
      },
      actions: [action(ACTION_TYPES.CANCEL, true, true, [], false)],
      sourceReferences: buildSourceReferences(input)
    };
  }

  const businessType = resolveBusinessType(result);
  const todoType = resolveTodoType(result);
  const operation = resolveConfirmationOperation(result);
  const policy = getConfirmationFieldPolicy(businessType, todoType);
  const semanticValues = resolveSemanticValues(result, businessType);
  semanticValues.businessType = businessType;
  semanticValues.originalText = originalText;
  const itemsState = buildItems(result, businessType);
  const saveEligibility = input.saveEligibility || {};
  // Always bind preflight to the current result/state. A caller-supplied object
  // is not a trust token and must not be able to bypass final parse safety.
  const preflight = evaluateRecordDomainPreflight({
    mode,
    resultScope,
    operation,
    businessType,
    finalResult: result,
    originalText,
    initialState: input.initialState,
    aiOutcome: input.aiOutcome,
    providerKind: input.providerKind,
    userConfirmedFields: input.userConfirmedFields,
    userConfirmedRelations: input.userConfirmedRelations
  });
  const domainCanSavePending = preflight.domainCanSavePending === true;
  const candidates = buildCandidates(
    result,
    resultScope,
    preflight.candidates || {},
    input.localResult || null
  );
  const blockingIssues = buildBlockingIssues(preflight, businessType, operation);
  const domainCanSaveFormal = preflight.domainCanSaveFormal === true;
  const canCommitToMemory = saveEligibility.canCommitToMemory === true
    && domainCanSaveFormal;
  const canCommitToRealStorage = mode === 'PRODUCTION_ROUTING'
    && saveEligibility.canCommitToRealStorage === true
    && domainCanSaveFormal;
  const needsDeepReview = mode === 'AI_ONLY'
    ? false
    : Boolean(input.deepReviewAvailable || (result.parse_route || {}).deep_review_available);
  const requiredSurfaceCapabilities = getRequiredSurfaceCapabilities(
    result, itemsState.items, candidates, preflight, needsDeepReview, originalText
  );
  const missingCapabilities = requiredSurfaceCapabilities
    .filter((capability) => !hasSurfaceCapability(capabilities, capability));
  const surfaceCanCompleteFormal = Boolean(result) && missingCapabilities.length === 0;
  const surfaceCanCompletePending = Boolean(result)
    && capabilities.canCommitPending
    && (!originalText || capabilities.canShowOriginalText);
  const requiresFullPage = capabilities.surfaceType !== SURFACE_TYPES.FULL_PAGE
    && capabilities.surfaceType !== SURFACE_TYPES.HEADLESS_TEST
    && missingCapabilities.length > 0;
  const warnings = buildWarnings(
    result, saveEligibility, mode, input.productionRoute || '', missingCapabilities
  );
  const fields = buildFieldModels(result, businessType, policy, semanticValues, blockingIssues, capabilities);
  const domainBlockingReasons = domainCanSaveFormal
    ? []
    : uniqueStrings(saveEligibility.blockedReasons || []).concat(
      blockingIssues.map((issue) => issue.code)
    ).filter((value, index, array) => array.indexOf(value) === index);
  const domain = {
    domainCanSaveFormal,
    domainCanSavePending,
    domainNeedsUserConfirmation: true,
    domainNeedsDeepReview: needsDeepReview,
    domainFormalSaveBlocked: !domainCanSaveFormal,
    domainBlockingReasons,
    domainWarnings: safeClone(warnings),
    canCommitToMemory,
    canCommitToRealStorage,
    commitScope: canCommitToRealStorage
      ? (saveEligibility.commitScope || 'REAL_OR_MEMORY')
      : (canCommitToMemory ? 'MEMORY_ONLY' : 'BLOCKED'),
    aiResultResolved: saveEligibility.aiResultResolved === true
  };
  const surface = {
    surfaceType: capabilities.surfaceType,
    capabilities,
    requiredCapabilities: requiredSurfaceCapabilities,
    surfaceCanCompleteFormal,
    surfaceCanCompletePending,
    requiresFullPage,
    missingCapabilities,
    displayWarnings: safeClone(warnings),
    effectiveCanSaveFormal: domainCanSaveFormal && surfaceCanCompleteFormal,
    effectiveCanCommitFormal: domainCanSaveFormal && surfaceCanCompleteFormal && canCommitToRealStorage,
    effectiveCanSavePending: domainCanSavePending && surfaceCanCompletePending,
    effectiveCanCommitPending: mode === 'PRODUCTION_ROUTING'
      && domainCanSavePending && surfaceCanCompletePending
  };
  const contentHash = stableContentHash(buildContentFingerprintPayload({
    result,
    mode,
    resultScope,
    businessType,
    operation,
    originalText,
    semanticValues,
    items: itemsState.items,
    candidates,
    preflight,
    domainCanSaveFormal,
    canCommitToRealStorage
  }));
  const previousCandidate = input.previousConfirmation && typeof input.previousConfirmation === 'object'
    ? input.previousConfirmation
    : null;
  const previous = previousCandidate
    && previousCandidate.schemaVersion === CONFIRMATION_SCHEMA_VERSION
    && String(previousCandidate.confirmationId || '').trim()
    && Number.isInteger(previousCandidate.revision)
    && previousCandidate.revision > 0
    ? previousCandidate
    : null;
  const previousRevision = previous && Number.isInteger(previous.revision) && previous.revision > 0
    ? previous.revision
    : 0;
  const confirmationId = (previous && previous.confirmationId)
    || input.confirmationId
    || (input.traceReference && (input.traceReference.traceId || input.traceReference.runId))
    || `confirmation_${contentHash}`;
  const confirmation = {
    schemaVersion: CONFIRMATION_SCHEMA_VERSION,
    confirmationId: String(confirmationId),
    revision: previousRevision + 1,
    contentHash,
    status: domainCanSaveFormal
      ? CONFIRMATION_STATUSES.READY_FORMAL
      : (domainCanSavePending ? CONFIRMATION_STATUSES.PENDING_ONLY : CONFIRMATION_STATUSES.BLOCKED),
    mode,
    resultScope,
    productionRoute: input.productionRoute || '',
    executionPath: input.executionPath || '',
    businessType,
    operation,
    todoType,
    originalText,
    normalizedText: input.normalizedText || '',
    inputSource: input.inputSource || result.source || 'typed',
    businessDate: input.businessDate || '',
    businessTimezone: input.businessTimezone || '',
    fields,
    items: itemsState.items,
    itemConfirmations: buildItemConfirmations(itemsState.items, blockingIssues, capabilities),
    itemsDerivedFromLegacy: itemsState.derivedFromLegacy,
    requiredFields: uniqueStrings(policy.required || []),
    requiredFieldGroups: safeClone(policy.requiredAnyOf || []),
    recommendedFields: safeClone(policy.recommended),
    optionalFields: safeClone(policy.optional),
    missingFields: uniqueStrings(result.missing_fields || []).map((field) => mapLegacyFieldKey(field, businessType, result.operation)),
    lowConfidenceFields: uniqueStrings(result.low_confidence_fields || []).map((field) => mapLegacyFieldKey(field, businessType, result.operation)),
    fieldConflicts: safeClone(result.field_conflicts || []),
    preflightFingerprint: preflight.preflightFingerprint,
    preflight: safeClone(preflight),
    warnings,
    blockingIssues,
    candidates,
    domain,
    surface,
    actions: [],
    sourceReferences: buildSourceReferences(Object.assign({}, input, { preflight }))
  };
  confirmation.actions = buildActions({
    domain,
    surface,
    candidates,
    preflight,
    hasResult: true,
    hasFields: fields.length > 0,
    canCommitToRealStorage
  });
  return confirmation;
}

function deriveConfirmationSummary(confirmation) {
  if (!confirmation || confirmation.status === CONFIRMATION_STATUSES.NO_RESULT) {
    return {
      canSaveFormal: false,
      canCommitToMemory: false,
      canCommitToRealStorage: false,
      commitScope: 'BLOCKED',
      canSavePending: false,
      needsUserConfirmation: false,
      needsAdditionalFieldConfirmation: false,
      requiresExplicitSaveAction: false,
      needsDeepReview: false,
      needsFullPage: false,
      requiredFields: [],
      missingRequiredFields: [],
      missingFields: [],
      warnings: []
    };
  }
  const domain = confirmation.domain || {};
  const surface = confirmation.surface || {};
  const warningTexts = (confirmation.warnings || []).map((warning) => (
    (warning.messageParams && warning.messageParams.rawReason)
      || warning.messageKey
  ));
  return {
    canSaveFormal: domain.domainCanSaveFormal === true,
    canCommitToMemory: domain.canCommitToMemory === true,
    canCommitToRealStorage: domain.canCommitToRealStorage === true,
    commitScope: domain.commitScope || 'BLOCKED',
    canSavePending: domain.domainCanSavePending === true,
    needsUserConfirmation: domain.domainNeedsUserConfirmation === true,
    needsAdditionalFieldConfirmation: !domain.domainCanSaveFormal
      || (confirmation.missingFields || []).length > 0
      || (confirmation.lowConfidenceFields || []).length > 0
      || (confirmation.fieldConflicts || []).length > 0,
    requiresExplicitSaveAction: true,
    needsDeepReview: domain.domainNeedsDeepReview === true,
    needsFullPage: surface.requiresFullPage === true,
    requiredFields: safeClone(confirmation.requiredFields || []),
    missingRequiredFields: safeClone(confirmation.missingFields || []),
    missingFields: safeClone(confirmation.missingFields || []),
    warnings: uniqueStrings(warningTexts)
  };
}

module.exports = {
  buildRecordConfirmation,
  deriveConfirmationSummary,
  stableContentHash,
  stableSerialize
};
