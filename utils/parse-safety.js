const { diffDays, parseChineseDateDetail, today } = require('./date');
const { stableHash } = require('./record-state-diff');
const { RAW_UNIT_PATTERN, UNIT_PATTERN, unitsMatch } = require('./units');

const SAFE_LOCAL = 'SAFE_LOCAL';
const NEEDS_AI = 'NEEDS_AI';
const NEEDS_USER_CONFIRM = 'NEEDS_USER_CONFIRM';
const NO_RECORD = 'NO_RECORD';

const CUSTOMER_REQUIRED_INTENTS = ['quotation', 'order', 'receivable', 'payment', 'dunning'];
const PRODUCT_REQUIRED_INTENTS = ['quotation', 'order'];
const AMOUNT_REQUIRED_INTENTS = ['receivable'];
const PAYMENT_REQUIRED_INTENTS = ['payment'];
const USER_CONFIRM_STATUSES = [NEEDS_USER_CONFIRM, NO_RECORD];

const CUSTOMER_BAD_PREFIX = /^(?:报给|报价给|发给|卖给|转给|给|帮|找|问|回一下|回|催|联系|客户|那个|这个|记一下|记下|记录|报价|报架|报|下单|订单)/;
const CUSTOMER_BAD_INSIDE = /(?:报给|报价|报架|下单|订单|货款|欠款|尾款|定金|订金|预付|单价|价格|数量|产品|客户说|说要|说下|问价|问下)/;
const CUSTOMER_GENERIC = /^(?:客户|老客户|这个客户|那个客户|老板(?:今|明|昨|后|早|晚|今天|明天|后天|大后天)?|今天|明天|后天|刚才|刚刚|义乌|那笔|上一笔|这单|那单)$/;
const PRODUCT_PRICE_LIKE = /^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬]+)\s*(?:块|元|毛|角|分|钱)/;
const PRODUCT_BAD_PATTERN = /(?:价格|单价|报价|报架|多少钱|贵了|便宜|上次|上回|之前|原价|老价|照旧|颜色|色差|包装(?!袋|盒)|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太|尽快|月底|月末|明天|后天|明早|本周|下周|上周|周[一二三四五六日天]|星期[一二三四五六日天]|交期|到期|交$)/;
const OPTIONAL_CONFIRM_FIELDS = ['phone'];
const FINAL_RECHECK_CLEARABLE_LOW_FIELDS = ['customerName', 'productName', 'quantity', 'unitPrice', 'priceUnit', 'dueDate'];
const SEMANTIC_AI_PATTERN = /(?:上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|价格不变|还是|最终|最后|确认价|改成|改为|改价|不是|不对|写错|算了|贵了|便宜|就按|客户说|他说|她说|颜色|色差|包装(?!袋|盒)|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太|换成|替换|取消|别做|先别|等确认|撤回)/i;
const PACKAGING_REQUIREMENT_PATTERN = /(?:需要|要求|改成|改为|换成|每个|逐个|单独|独立|重新)[^，,。；;\n]{0,8}包装|包装[^，,。；;\n]{0,8}(?:加厚|改成|改为|换成|单独|独立|不要|不能|需要|要求)|(?:外箱|内盒)[^，,。；;\n]{0,12}(?:不要|不能|需要|要求|加厚|印字|印|贴|装)|每\s*(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:个|件|套|只|盒|袋)?\s*(?:(?:装|打)\s*(?:一\s*)?|一\s*)包/i;
const FINANCIAL_RISK_PATTERN = /(?:定金|订金|预付|尾款|欠款|货款|收款|到账|转账|打款|刚打|刚转|还差|催.*(?:款|尾款|货款))/;
const QUANTITY_WITH_UNIT_PATTERN = new RegExp(`(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)\\s*${UNIT_PATTERN}`);
const UNIT_PRICE_PATTERN = new RegExp(`(?:单价|价格|价钱)\\s*(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)|(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)\\s*(?:块|元|毛|角|分|钱)(?:\\s*(?:[零〇一二两三四五六七八九十百千万]|\\d+))?(?:\\s*(?:一|每|/))?|(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)\\s*(?:一|每|/)\\s*${RAW_UNIT_PATTERN}`);

function compact(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function uniqueStrings(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

const MANUAL_ITEM_FIELDS = [
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'totalAmount', 'itemDeliveryDate', 'itemRemark'
];
const PROOF_FIRST_ITEM_ALIAS_FIELDS = [
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'itemDeliveryDate', 'itemRemark'
];
const TRUSTED_MANUAL_EDIT_SCHEMA = 'USER_MANUAL_EDIT_V1';
const USER_PAGE_EDIT = 'USER_PAGE_EDIT';
const USER_ASSISTANT_ANSWER = 'USER_ASSISTANT_ANSWER';
const ASSISTANT_QUESTION_TYPES = new Set(['TEXT', 'DATE', 'NUMBER']);
const USER_RESOLUTION_COMPLETE = 'MANUAL_RESOLUTION_COMPLETE';
const USER_RESOLUTION_INCOMPLETE = 'MANUAL_RESOLUTION_INCOMPLETE';
// This nonce never enters parser/AI JSON. It makes a page edit proof an
// in-process capability instead of another forgeable field on the draft.
const MANUAL_EDIT_SECRET = `${Date.now()}|${Math.random()}|${Math.random()}`;
const assistantAnswerChallengeRegistry = new WeakMap();

function getAssistantQuestionType(question = {}) {
  const type = String(question.questionType || question.answerType || '').trim().toUpperCase();
  return ASSISTANT_QUESTION_TYPES.has(type) ? type : '';
}

function normalizeManualFields(value) {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((item) => typeof item === 'string'))
      .filter((field) => !/^items(?:\[|\.|$)/.test(field))
    : [];
}

function itemKeyHash(value) {
  const text = String(value || 'item');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableProofValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableProofValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableProofValue(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function proofFingerprint(value) {
  const text = stableProofValue(value);
  return `${itemKeyHash(text)}${itemKeyHash(text.split('').reverse().join(''))}`;
}

function getItemIdentityFingerprint(item = {}) {
  return proofFingerprint({
    productName: String(item.productName || ''),
    spec: String(item.spec || '')
  });
}

function getAiResolutionRevision(result = {}) {
  const revision = Number(result.ai_resolution_revision || 0);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function isAiReturnedUncertain(result = {}) {
  const fallback = result.ai_fallback || {};
  return fallback.status === 'returned_uncertain'
    && fallback.attempted === true
    && fallback.business_result_valid === true;
}

function requiresTrustedAiManualProof(result = {}) {
  const fallback = result.ai_fallback || {};
  const route = result.parse_route || {};
  const routeDecision = String(
    route.client_route || route.semantic_decision || route.decision || ''
  ).toUpperCase();
  return fallback.attempted === true
    || !['', 'not_requested'].includes(String(fallback.status || ''))
    || routeDecision === 'ASK_USER'
    || (Array.isArray(result.user_manual_edits) && result.user_manual_edits.length > 0);
}

function getUserResolutionDraftFingerprint(result = {}) {
  const fallback = result.ai_fallback || {};
  return proofFingerprint({
    originalText: String(result.original_text || ''),
    rawText: String(result.raw_text || ''),
    extractedText: String(result.extracted_text || ''),
    intent: String(result.intent || ''),
    source: String(result.source || ''),
    revision: getAiResolutionRevision(result),
    aiStatus: String(fallback.status || ''),
    providerKind: String(fallback.provider_kind || ''),
    parseTrace: result.parse_trace || null,
    flowContext: result.record_flow_context || null
  });
}

function getManualProofDraftFingerprint(result, source) {
  if (source !== USER_ASSISTANT_ANSWER) return getUserResolutionDraftFingerprint(result);
  return proofFingerprint({
    originalText: String(result.original_text || ''),
    rawText: String(result.raw_text || ''),
    extractedText: String(result.extracted_text || ''),
    intent: String(result.intent || ''),
    source: String(result.source || ''),
    revision: getAiResolutionRevision(result),
    aiStatus: String((result.ai_fallback || {}).status || ''),
    providerKind: String((result.ai_fallback || {}).provider_kind || ''),
    confirmationContext: {
      businessDate: String((result.client_confirmation_context || {}).businessDate || ''),
      confirmationSessionId: String(
        (result.client_confirmation_context || {}).confirmationSessionId || ''
      ),
      draftRevision: String((result.client_confirmation_context || {}).draftRevision || ''),
      originalTextFingerprint: String(
        (result.client_confirmation_context || {}).originalTextFingerprint || ''
      )
    },
    parseTrace: result.parse_trace || null,
    flowContext: result.record_flow_context || null
  });
}

function compactManualResolutionState(value, inArray = false) {
  if (Array.isArray(value)) {
    return value.map((entry) => compactManualResolutionState(entry, true));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((output, key) => {
      const compacted = compactManualResolutionState(value[key], false);
      const emptyObject = compacted && typeof compacted === 'object'
        && !Array.isArray(compacted)
        && Object.keys(compacted).length === 0;
      if (compacted === undefined
        || compacted === ''
        || compacted === null
        || (Array.isArray(compacted) && compacted.length === 0)
        || emptyObject) return output;
      output[key] = compacted;
      return output;
    }, {});
  }
  if (!inArray && (value === undefined || value === null || value === '')) return undefined;
  return value;
}

function hasUniqueConfirmationItemKeys(items) {
  if (!Array.isArray(items) || !items.length) return false;
  const keys = items.map((item) => String(item && item.confirmationItemKey || '').trim());
  return keys.every(Boolean) && new Set(keys).size === keys.length;
}

function getManualResolutionFieldsContext(fields = {}) {
  const nextFields = Object.assign({}, fields);
  const items = Array.isArray(fields.items)
    ? fields.items
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => Object.assign({}, item))
    : [];
  const itemKeysValid = !items.length || hasUniqueConfirmationItemKeys(items);
  let itemAliasesValid = true;
  if (items.length > 1) {
    const firstItem = items[0];
    itemAliasesValid = PROOF_FIRST_ITEM_ALIAS_FIELDS.every((field) => (
      manualStateValuesEqual(nextFields[field], firstItem[field])
    ));
    PROOF_FIRST_ITEM_ALIAS_FIELDS.forEach((field) => delete nextFields[field]);
  }
  nextFields.items = itemKeysValid
    ? items.slice().sort((left, right) => (
      String(left.confirmationItemKey || '').localeCompare(String(right.confirmationItemKey || ''))
    ))
    : items;
  return {
    fields: compactManualResolutionState(nextFields),
    itemAliasesValid,
    itemKeysValid
  };
}

function hasValidManualResolutionItemContext(fields) {
  const context = getManualResolutionFieldsContext(fields || {});
  return context.itemKeysValid && context.itemAliasesValid;
}

function manualStateValuesEqual(left, right) {
  return stableProofValue(compactManualResolutionState(left))
    === stableProofValue(compactManualResolutionState(right));
}

function getChangedObjectFields(before = {}, after = {}) {
  return uniqueStrings(Object.keys(before || {}).concat(Object.keys(after || [])))
    .filter((field) => !manualStateValuesEqual(before[field], after[field]));
}

function isAllowedManualFieldTransition(result, fields, field, itemKey) {
  const before = result.fields || {};
  const changedRootFields = getChangedObjectFields(before, fields);
  if (itemKey) {
    const beforeItems = Array.isArray(before.items) ? before.items : [];
    const afterItems = Array.isArray(fields.items) ? fields.items : [];
    if (beforeItems.length !== afterItems.length) return false;
    const allowedItemFields = new Set([field]);
    if (['quantity', 'unit', 'unitPrice', 'priceUnit'].includes(field)) {
      allowedItemFields.add('totalAmount');
    }
    for (let index = 0; index < beforeItems.length; index += 1) {
      const beforeItem = beforeItems[index] || {};
      const afterItem = afterItems[index] || {};
      const currentKey = String(beforeItem.confirmationItemKey || '');
      if (currentKey !== String(afterItem.confirmationItemKey || '')) return false;
      const changedItemFields = getChangedObjectFields(beforeItem, afterItem);
      if (currentKey === itemKey) {
        if (changedItemFields.some((name) => !allowedItemFields.has(name))) return false;
      } else if (changedItemFields.length) {
        return false;
      }
    }
    const allowedRootFields = new Set([
      'items', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
      'amount', 'totalAmount', 'calculatedAmount'
    ]);
    if (field === 'productName') {
      [
        'orderId', 'allowUnlinkedOrderDeposit', 'unlinkedOrderDepositCustomerId',
        'orderSelectionConfirmed'
      ].forEach((name) => allowedRootFields.add(name));
    }
    return changedRootFields.every((name) => allowedRootFields.has(name));
  }
  const allowedRootFields = new Set([field]);
  if (field === 'amount') {
    // Confirming the stated order amount also refreshes its canonical aliases.
    // These are deterministic projections of the same user answer, not extra
    // user-supplied facts.
    ['statedAmount', 'totalAmount', 'calculatedAmount', 'items']
      .forEach((name) => allowedRootFields.add(name));
  }
  if (['customerName', 'phone'].includes(field)) {
    [
      'customerId', 'receivableId', 'orderId', 'allowUnlinkedPayment',
      'allowUnlinkedOrderDeposit', 'unlinkedPaymentCustomerId',
      'unlinkedOrderDepositCustomerId', 'receivableSelectionConfirmed',
      'orderSelectionConfirmed', 'quotationId', 'quotationSelectionConfirmed',
      'customerHistoryConfirmed', 'customerSelectionConfirmed', 'forceNewCustomer'
    ].forEach((name) => allowedRootFields.add(name));
  }
  if (field === 'productName') {
    [
      'orderId', 'allowUnlinkedOrderDeposit', 'unlinkedOrderDepositCustomerId',
      'orderSelectionConfirmed'
    ].forEach((name) => allowedRootFields.add(name));
  }
  return changedRootFields.every((name) => allowedRootFields.has(name));
}

function isAllowedItemStructureTransition(result, fields, options = {}) {
  const action = String(options.action || '');
  if (!['ADD_ITEM', 'REMOVE_ITEM', 'REORDER_ITEMS'].includes(action)) return false;
  const before = result.fields || {};
  const beforeItems = Array.isArray(before.items) ? before.items : [];
  const afterItems = Array.isArray(fields.items) ? fields.items : [];
  if (action === 'REORDER_ITEMS') {
    if (!hasUniqueConfirmationItemKeys(beforeItems)
      || !hasUniqueConfirmationItemKeys(afterItems)
      || beforeItems.length !== afterItems.length) return false;
    const beforeKeys = beforeItems.map((item) => String(item.confirmationItemKey)).sort();
    const afterKeys = afterItems.map((item) => String(item.confirmationItemKey)).sort();
    return beforeKeys.every((itemKey, index) => itemKey === afterKeys[index])
      && getManualResolutionStateFingerprint(result, before)
        === getManualResolutionStateFingerprint(result, fields);
  }
  const itemKey = String(options.itemKey || '');
  if (!itemKey) return false;
  if (action === 'ADD_ITEM') {
    if (afterItems.length !== beforeItems.length + 1) return false;
    if (String(afterItems[afterItems.length - 1].confirmationItemKey || '') !== itemKey) return false;
    for (let index = 0; index < beforeItems.length; index += 1) {
      if (!manualStateValuesEqual(beforeItems[index], afterItems[index])) return false;
    }
  } else {
    const beforeIndex = beforeItems.findIndex((item) => (
      String(item && item.confirmationItemKey || '') === itemKey
    ));
    if (beforeIndex < 0 || afterItems.length !== beforeItems.length - 1) return false;
    const expectedItems = beforeItems.filter((item, index) => index !== beforeIndex);
    if (!manualStateValuesEqual(expectedItems, afterItems)) return false;
  }
  const allowedRootFields = new Set([
    'items', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
    'amount', 'totalAmount', 'calculatedAmount'
  ]);
  return getChangedObjectFields(before, fields).every((name) => allowedRootFields.has(name));
}

function getManualResolutionStateFingerprint(result = {}, fieldsOverride) {
  return proofFingerprint({
    intent: String(result.intent || ''),
    fieldsContext: getManualResolutionFieldsContext(fieldsOverride || result.fields || {}),
    relationReferences: compactManualResolutionState(result.relation_references || null),
    formalSaveBlocked: Boolean(result.formal_save_blocked),
    requiresExistingRecord: Boolean(result.requires_existing_record),
    mixedBusiness: Boolean(result.mixed_business),
    noRecord: Boolean(result.no_record)
  });
}

function getItemRiskDescriptors(type, field, items) {
  if (!MANUAL_ITEM_FIELDS.includes(field) || !items.length) return [{
    riskId: `${type}|${field}`,
    type,
    field,
    itemKey: '',
    itemField: '',
    fieldPath: field,
    resolvable: Boolean(field)
  }];
  return items.map((item, itemIndex) => {
    const itemKey = String(item.confirmationItemKey || '').trim();
    return {
      riskId: `${type}|${field}|${itemKey || itemIndex}`,
      type,
      field: 'items',
      itemKey,
      itemField: field,
      fieldPath: `items[${itemIndex}].${field}`,
      resolvable: Boolean(itemKey)
    };
  });
}

function getConflictRiskDescriptor(conflict = {}) {
  const field = String(conflict.field || '').trim();
  const itemKey = String(conflict.itemKey || '').trim();
  const itemField = String(conflict.itemField || '').trim();
  const fieldPath = String(conflict.fieldPath || '').trim();
  const code = String(conflict.code || 'FIELD_CONFLICT').trim();
  const valuesFingerprint = proofFingerprint(Array.isArray(conflict.values) ? conflict.values : []);
  const isItemRisk = field === 'items';
  const resolvable = isItemRisk
    ? Boolean(itemKey && itemField && itemField !== 'identity' && MANUAL_ITEM_FIELDS.includes(itemField))
    : Boolean(field && !['intent', 'operation', 'businessType', 'relationId'].includes(field));
  return {
    riskId: [
      'CONFLICT', code, field, itemKey, itemField,
      itemKey ? '' : fieldPath,
      valuesFingerprint
    ].join('|'),
    type: 'CONFLICT',
    field,
    itemKey,
    itemField,
    fieldPath: fieldPath || (isItemRisk ? 'items' : field),
    resolvable
  };
}

function collectUserResolvableAiRisks(result = {}, fieldsOverride) {
  const fields = fieldsOverride || result.fields || {};
  const items = Array.isArray(fields.items) ? fields.items : [];
  const risks = [];
  uniqueStrings(result.missing_fields || []).forEach((field) => {
    risks.push(...getItemRiskDescriptors('MISSING', field, items));
  });
  uniqueStrings(result.low_confidence_fields || []).forEach((field) => {
    risks.push(...getItemRiskDescriptors('LOW', field, items));
  });
  (Array.isArray(result.field_conflicts) ? result.field_conflicts : []).forEach((conflict) => {
    risks.push(getConflictRiskDescriptor(conflict));
  });
  const finalValidations = (result.final_parse_safety || {}).field_validations || {};
  uniqueStrings(finalValidations.invalid_fields || [])
    .filter((field) => ['productName', 'dueDate', 'amount'].includes(field))
    .forEach((field) => {
      risks.push(...getItemRiskDescriptors('INVALID', field, items));
    });
  const seen = new Set();
  return risks.filter((risk) => {
    if (seen.has(risk.riskId)) return false;
    seen.add(risk.riskId);
    return true;
  });
}

function getManualEditSigningPayload(proof = {}) {
  return {
    schemaVersion: proof.schemaVersion,
    source: proof.source,
    action: proof.action,
    revision: proof.revision,
    field: proof.field,
    itemKey: proof.itemKey,
    draftFingerprint: proof.draftFingerprint,
    stateFingerprint: proof.stateFingerprint,
    riskSetFingerprint: proof.riskSetFingerprint,
    valueFingerprint: proof.valueFingerprint,
    itemIdentityFingerprint: proof.itemIdentityFingerprint,
    questionId: proof.questionId,
    fieldPath: proof.fieldPath,
    draftRevision: proof.draftRevision,
    originalTextFingerprint: proof.originalTextFingerprint,
    confirmationSessionId: proof.confirmationSessionId,
    questionBusinessDate: proof.questionBusinessDate,
    questionContextFingerprint: proof.questionContextFingerprint,
    questionType: proof.questionType,
    riskIds: uniqueStrings(proof.riskIds || []).sort()
  };
}

function signManualEditProof(proof) {
  const payload = stableProofValue(getManualEditSigningPayload(proof));
  return `${itemKeyHash(`${MANUAL_EDIT_SECRET}|${payload}`)}${itemKeyHash(`${payload}|${MANUAL_EDIT_SECRET}`)}`;
}

function findItemByKey(items, itemKey) {
  const targetKey = String(itemKey || '').trim();
  if (!targetKey || !Array.isArray(items)) return null;
  const matches = items.filter((item) => (
    String(item && item.confirmationItemKey || '').trim() === targetKey
  ));
  return matches.length === 1 ? matches[0] : null;
}

function validateManualEditProof(proof, result, fields) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  const validSource = [USER_PAGE_EDIT, USER_ASSISTANT_ANSWER].includes(proof.source);
  if (proof.schemaVersion !== TRUSTED_MANUAL_EDIT_SCHEMA
    || !validSource
    || proof.action !== 'EDIT_FIELD'
    || Number(proof.revision) !== getAiResolutionRevision(result)
    || proof.draftFingerprint !== getManualProofDraftFingerprint(result, proof.source)
    || proof.stateFingerprint !== getManualResolutionStateFingerprint(result, fields)
    || !proof.riskSetFingerprint
    || !proof.field
    || !Array.isArray(proof.riskIds)
    || !proof.riskIds.length
    || proof.signature !== signManualEditProof(proof)) return false;
  if (proof.source === USER_ASSISTANT_ANSWER) {
    const context = result.client_confirmation_context || {};
    const questionType = getAssistantQuestionType(proof);
    const expectedQuestionFingerprint = proofFingerprint({
      confirmationSessionId: proof.confirmationSessionId,
      draftRevision: proof.draftRevision,
      field: proof.field,
      fieldPath: proof.fieldPath,
      itemKey: proof.itemKey,
      originalTextFingerprint: proof.originalTextFingerprint,
      questionBusinessDate: proof.questionBusinessDate,
      questionId: proof.questionId,
      questionType,
      riskIds: uniqueStrings(proof.riskIds || []).sort()
    });
    if (!questionType
      || !String(proof.questionId || '').trim()
      || !String(proof.fieldPath || '').trim()
      || !String(proof.draftRevision || '').trim()
      || !String(proof.originalTextFingerprint || '').trim()
      || !String(proof.confirmationSessionId || '').trim()
      || !String(proof.questionBusinessDate || '').trim()
      || !String(proof.questionContextFingerprint || '').trim()
      || proof.questionContextFingerprint !== expectedQuestionFingerprint
      || String(context.businessDate || '') !== proof.questionBusinessDate
      || String(context.confirmationSessionId || '') !== proof.confirmationSessionId
      || String(context.draftRevision || '') !== proof.draftRevision
      || String(context.originalTextFingerprint || '') !== proof.originalTextFingerprint) return false;
  }
  if (proof.itemKey) {
    const items = Array.isArray(fields.items) ? fields.items : [];
    if (!hasValidManualResolutionItemContext(fields)) return false;
    const item = findItemByKey(items, proof.itemKey);
    return Boolean(item)
      && proof.valueFingerprint === proofFingerprint(item[proof.field])
      && proof.itemIdentityFingerprint === getItemIdentityFingerprint(item);
  }
  return proof.valueFingerprint === proofFingerprint(fields[proof.field]);
}

function sameExactStrings(left, right) {
  const a = uniqueStrings(left || []).sort();
  const b = uniqueStrings(right || []).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function createTrustedAssistantAnswerChallenge(result = {}, question = {}) {
  const context = result.client_confirmation_context || {};
  const target = question.target || {};
  const field = String(target.field || question.field || '').trim();
  const itemKey = String(target.itemKey || question.itemKey || '').trim();
  const fieldPath = String(target.fieldPath || question.fieldPath || '').trim();
  const questionType = getAssistantQuestionType(question);
  const questionBusinessDate = String(question.businessDate || '').trim();
  const route = result.parse_route || {};
  const trustedQuestionType = getAssistantQuestionType(
    route.questionCandidate || route.activeQuestion || {}
  );
  const routeName = String(
    route.client_route || route.semantic_decision || route.decision || ''
  ).toUpperCase();
  if (routeName !== 'ASK_USER'
    || !field
    || !fieldPath
    || !questionType
    || questionType !== trustedQuestionType
    || !questionBusinessDate
    || String(question.status || '') !== 'OPEN'
    || questionBusinessDate !== String(context.businessDate || '')
    || String(question.confirmationSessionId || '') !== String(context.confirmationSessionId || '')
    || String(question.draftRevision || '') !== String(context.draftRevision || '')
    || String(question.originalTextFingerprint || '') !== String(context.originalTextFingerprint || '')) {
    return null;
  }
  const fields = result.fields || {};
  const items = Array.isArray(fields.items) ? fields.items : [];
  if (itemKey && (!hasValidManualResolutionItemContext(fields)
    || !findItemByKey(items, itemKey))) return null;
  const risks = collectUserResolvableAiRisks(result, fields).filter((risk) => (
    risk.resolvable
      && risk.itemKey === itemKey
      && (itemKey ? risk.itemField === field : risk.field === field)
      && risk.fieldPath === fieldPath
  ));
  const riskIds = risks.map((risk) => risk.riskId).sort();
  const questionRiskIds = uniqueStrings(question.riskIds || []);
  if (!riskIds.length || !sameExactStrings(questionRiskIds, riskIds)) return null;
  const questionId = stableHash({
    confirmationSessionId: context.confirmationSessionId,
    draftRevision: context.draftRevision,
    fieldPath,
    questionBusinessDate,
    questionType,
    riskIds: questionRiskIds.slice().sort()
  }, 'record-confirm-assistant-question');
  if (questionId !== String(question.questionId || '')) return null;
  const challenge = Object.freeze(Object.create(null));
  assistantAnswerChallengeRegistry.set(challenge, Object.freeze({
    beforeDraftFingerprint: getManualProofDraftFingerprint(result, USER_ASSISTANT_ANSWER),
    beforeStateFingerprint: getManualResolutionStateFingerprint(result, fields),
    confirmationSessionId: String(context.confirmationSessionId || ''),
    draftRevision: String(context.draftRevision || ''),
    existingProofs: normalizeTrustedUserManualEdits(
      result.user_manual_edits,
      result,
      fields
    ),
    field,
    fieldPath,
    itemKey,
    originalTextFingerprint: String(context.originalTextFingerprint || ''),
    questionBusinessDate,
    questionId,
    questionType,
    riskIds
  }));
  return challenge;
}

function getManualResolutionRiskSetFingerprint(result, fields, proofs = []) {
  const riskIds = collectUserResolvableAiRisks(result, fields).map((risk) => risk.riskId);
  proofs.forEach((proof) => {
    uniqueStrings(proof && proof.riskIds || []).forEach((riskId) => riskIds.push(riskId));
  });
  return proofFingerprint(uniqueStrings(riskIds).sort());
}

function normalizeTrustedUserManualEdits(value, result, fields) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const candidates = value.reduce((output, proof) => {
    if (!validateManualEditProof(proof, result, fields)) return output;
    if (seen.has(proof.signature)) return output;
    seen.add(proof.signature);
    output.push(Object.assign({}, proof, {
      riskIds: uniqueStrings(proof.riskIds).sort()
    }));
    return output;
  }, []);
  const riskSetFingerprint = getManualResolutionRiskSetFingerprint(
    result,
    fields,
    candidates
  );
  return candidates.filter((proof) => proof.riskSetFingerprint === riskSetFingerprint);
}

function refreshTrustedManualEditProofs(result, fields, templates) {
  const items = Array.isArray(fields.items) ? fields.items : [];
  if (templates.some((template) => template && template.itemKey)
    && !hasValidManualResolutionItemContext(fields)) return [];
  const stateFingerprint = getManualResolutionStateFingerprint(result, fields);
  const riskSetFingerprint = getManualResolutionRiskSetFingerprint(result, fields, templates);
  return templates.reduce((output, template) => {
    const currentItem = template.itemKey ? findItemByKey(items, template.itemKey) : null;
    if (template.itemKey && !currentItem) return output;
    const proof = Object.assign({}, template, {
      schemaVersion: TRUSTED_MANUAL_EDIT_SCHEMA,
      source: template.source || USER_PAGE_EDIT,
      action: 'EDIT_FIELD',
      revision: getAiResolutionRevision(result),
      draftFingerprint: getManualProofDraftFingerprint(result, template.source || USER_PAGE_EDIT),
      stateFingerprint,
      riskSetFingerprint,
      valueFingerprint: proofFingerprint(
        template.itemKey ? currentItem[template.field] : fields[template.field]
      ),
      itemIdentityFingerprint: template.itemKey ? getItemIdentityFingerprint(currentItem) : '',
      riskIds: uniqueStrings(template.riskIds || []).sort()
    });
    if (proof.source === USER_ASSISTANT_ANSWER) {
      const context = result.client_confirmation_context || {};
      const itemIndex = proof.itemKey ? items.indexOf(currentItem) : -1;
      const fieldPath = proof.itemKey ? `items[${itemIndex}].${proof.field}` : proof.field;
      const questionType = getAssistantQuestionType(proof);
      proof.questionBusinessDate = String(context.businessDate || '');
      proof.confirmationSessionId = String(context.confirmationSessionId || '');
      proof.draftRevision = String(context.draftRevision || '');
      proof.originalTextFingerprint = String(context.originalTextFingerprint || '');
      proof.fieldPath = fieldPath;
      proof.questionType = questionType;
      proof.questionContextFingerprint = proofFingerprint({
        confirmationSessionId: proof.confirmationSessionId,
        draftRevision: proof.draftRevision,
        field: proof.field,
        fieldPath,
        itemKey: proof.itemKey,
        originalTextFingerprint: proof.originalTextFingerprint,
        questionBusinessDate: proof.questionBusinessDate,
        questionId: proof.questionId,
        questionType,
        riskIds: proof.riskIds
      });
      if (!questionType
        || !proof.confirmationSessionId
        || !proof.draftRevision
        || !proof.originalTextFingerprint
        || !proof.questionBusinessDate
        || !proof.fieldPath
        || !proof.questionId) return output;
    }
    proof.signature = signManualEditProof(proof);
    output.push(proof);
    return output;
  }, []);
}

function reconcileTrustedUserManualEditState(result = {}, fields = {}, options = {}) {
  if (!requiresTrustedAiManualProof(result)
    || !Array.isArray(result.user_manual_edits)
    || !result.user_manual_edits.length) return result;
  if (!isAllowedItemStructureTransition(result, fields, options)) return result;
  if (String(options.action || '') === 'REORDER_ITEMS') {
    const validForPreviousState = normalizeTrustedUserManualEdits(
      result.user_manual_edits,
      result,
      result.fields || {}
    );
    if (validForPreviousState.length !== result.user_manual_edits.length) {
      return Object.assign({}, result, { user_manual_edits: [] });
    }
    const currentContext = result.client_confirmation_context || {};
    const nextContext = options.nextConfirmationContext || currentContext;
    const currentWithoutRevision = Object.assign({}, currentContext);
    const nextWithoutRevision = Object.assign({}, nextContext);
    const currentDraftRevision = Number(currentContext.draftRevision);
    const nextDraftRevision = Number(nextContext.draftRevision);
    delete currentWithoutRevision.draftRevision;
    delete nextWithoutRevision.draftRevision;
    if (!Number.isInteger(currentDraftRevision)
      || !Number.isInteger(nextDraftRevision)
      || nextDraftRevision !== currentDraftRevision + 1
      || !manualStateValuesEqual(currentWithoutRevision, nextWithoutRevision)) {
      return Object.assign({}, result, { user_manual_edits: [] });
    }
    const nextResult = Object.assign({}, result, {
      client_confirmation_context: Object.assign({}, nextContext),
      fields: Object.assign({}, fields)
    });
    return Object.assign({}, nextResult, {
      user_manual_edits: refreshTrustedManualEditProofs(
        nextResult,
        fields,
        validForPreviousState
      )
    });
  }
  const validForNextState = normalizeTrustedUserManualEdits(
    result.user_manual_edits,
    result,
    fields
  );
  if (validForNextState.length === result.user_manual_edits.length) {
    return Object.assign({}, result, { user_manual_edits: validForNextState });
  }
  const validForPreviousState = normalizeTrustedUserManualEdits(
    result.user_manual_edits,
    result,
    result.fields || {}
  );
  return Object.assign({}, result, {
    user_manual_edits: validForPreviousState.length
      ? refreshTrustedManualEditProofs(result, fields, validForPreviousState)
      : []
  });
}

function createTrustedUserManualEdit(result = {}, options = {}) {
  if (!requiresTrustedAiManualProof(result)) return result;
  const previousFields = result.fields || {};
  const fields = options.fields || result.fields || {};
  const items = Array.isArray(fields.items) ? fields.items : [];
  const field = String(options.field || '').trim();
  const itemKey = String(options.itemKey || '').trim();
  const item = itemKey ? findItemByKey(items, itemKey) : null;
  if (!field || (itemKey && !item)) return result;
  if (itemKey) {
    const previousItems = Array.isArray(previousFields.items) ? previousFields.items : [];
    const previousItem = findItemByKey(previousItems, itemKey);
    if (!previousItem || manualStateValuesEqual(previousItem[field], item[field])) return result;
  } else if (manualStateValuesEqual(previousFields[field], fields[field])) {
    return result;
  }
  if (!isAllowedManualFieldTransition(result, fields, field, itemKey)) return result;
  const matchingRisks = collectUserResolvableAiRisks(result, fields).filter((risk) => (
    risk.resolvable
      && risk.itemKey === itemKey
      && (itemKey ? risk.itemField === field : risk.field === field)
  ));
  const existing = normalizeTrustedUserManualEdits(
    result.user_manual_edits,
    result,
    previousFields
  );
  const matchingRiskIds = matchingRisks.map((risk) => risk.riskId);
  const templates = existing.map((entry) => Object.assign({}, entry));
  const sameFieldProof = templates.find((entry) => (
    entry.itemKey === itemKey && entry.field === field
  ));
  if (sameFieldProof) {
    sameFieldProof.riskIds = uniqueStrings([].concat(
      sameFieldProof.riskIds || [],
      matchingRiskIds
    )).sort();
  } else if (matchingRiskIds.length) {
    templates.push({
      schemaVersion: TRUSTED_MANUAL_EDIT_SCHEMA,
      source: USER_PAGE_EDIT,
      action: 'EDIT_FIELD',
      revision: getAiResolutionRevision(result),
      field,
      itemKey,
      riskIds: uniqueStrings(matchingRiskIds).sort()
    });
  }
  if (!templates.length) return result;
  return Object.assign({}, result, {
    user_manual_edits: refreshTrustedManualEditProofs(result, fields, templates)
  });
}

function createTrustedAssistantAnswerEdit(result = {}, options = {}) {
  const challenge = options.challenge;
  const authority = challenge && assistantAnswerChallengeRegistry.get(challenge);
  if (!authority) return result;
  assistantAnswerChallengeRegistry.delete(challenge);
  const previousFields = result.fields || {};
  const fields = options.fields || previousFields;
  const items = Array.isArray(fields.items) ? fields.items : [];
  const field = authority.field;
  const itemKey = authority.itemKey;
  const item = itemKey ? findItemByKey(items, itemKey) : null;
  const context = result.client_confirmation_context || {};
  const metadata = {
    questionId: authority.questionId,
    questionType: authority.questionType,
    questionBusinessDate: authority.questionBusinessDate,
    fieldPath: authority.fieldPath,
    draftRevision: String(context.draftRevision || ''),
    originalTextFingerprint: String(context.originalTextFingerprint || ''),
    confirmationSessionId: String(context.confirmationSessionId || '')
  };
  if (!field
    || (itemKey && !item)
    || Object.values(metadata).some((value) => !value)
    || metadata.confirmationSessionId !== authority.confirmationSessionId
    || metadata.draftRevision !== authority.draftRevision
    || metadata.originalTextFingerprint !== authority.originalTextFingerprint
    || getManualProofDraftFingerprint(result, USER_ASSISTANT_ANSWER)
      !== authority.beforeDraftFingerprint
    || getManualResolutionStateFingerprint(result, previousFields)
      !== authority.beforeStateFingerprint) return result;
  const itemIndex = itemKey ? items.indexOf(item) : -1;
  if (authority.fieldPath !== (itemKey ? `items[${itemIndex}].${field}` : field)) return result;
  if (itemKey) {
    const previousItems = Array.isArray(previousFields.items) ? previousFields.items : [];
    const previousItem = findItemByKey(previousItems, itemKey);
    if (!previousItem || manualStateValuesEqual(previousItem[field], item[field])) return result;
  } else if (manualStateValuesEqual(previousFields[field], fields[field])) {
    return result;
  }
  if (!isAllowedManualFieldTransition(result, fields, field, itemKey)) return result;
  const matchingRisks = collectUserResolvableAiRisks(result, fields).filter((risk) => (
    risk.resolvable
      && risk.itemKey === itemKey
      && (itemKey ? risk.itemField === field : risk.field === field)
  ));
  if (!matchingRisks.length
    || !sameExactStrings(matchingRisks.map((risk) => risk.riskId), authority.riskIds)) return result;
  const templates = authority.existingProofs.map((entry) => Object.assign({}, entry));
  const questionContextFingerprint = proofFingerprint({
    confirmationSessionId: metadata.confirmationSessionId,
    draftRevision: metadata.draftRevision,
    field,
    fieldPath: metadata.fieldPath,
    itemKey,
    originalTextFingerprint: metadata.originalTextFingerprint,
    questionBusinessDate: metadata.questionBusinessDate,
    questionId: metadata.questionId,
    questionType: metadata.questionType,
    riskIds: authority.riskIds
  });
  templates.push(Object.assign({
    schemaVersion: TRUSTED_MANUAL_EDIT_SCHEMA,
    source: USER_ASSISTANT_ANSWER,
    action: 'EDIT_FIELD',
    revision: getAiResolutionRevision(result),
    field,
    itemKey,
    riskIds: authority.riskIds,
    questionContextFingerprint
  }, metadata));
  return Object.assign({}, result, {
    user_manual_edits: refreshTrustedManualEditProofs(result, fields, templates)
  });
}

function hasTrustedAssistantAnswerEdit(result = {}, fields = {}, question = {}) {
  const target = question.target || {};
  const field = String(target.field || question.field || '').trim();
  const fieldPath = String(target.fieldPath || question.fieldPath || '').trim();
  const itemKey = String(target.itemKey || question.itemKey || '').trim();
  const questionType = getAssistantQuestionType(question);
  const questionBusinessDate = String(question.businessDate || '').trim();
  if (!field || !fieldPath || !questionType || !questionBusinessDate) return false;
  const proofs = normalizeTrustedUserManualEdits(
    result.user_manual_edits,
    result,
    fields
  );
  return proofs.some((proof) => (
    proof.source === USER_ASSISTANT_ANSWER
      && proof.questionId === String(question.questionId || '')
      && proof.questionType === questionType
      && proof.questionBusinessDate === questionBusinessDate
      && proof.field === field
      && proof.fieldPath === fieldPath
      && proof.itemKey === itemKey
      && sameExactStrings(proof.riskIds, question.riskIds || [])
  ));
}

function evaluateUserResolvedAiState(result = {}) {
  const fields = result.fields || {};
  const proofs = normalizeTrustedUserManualEdits(result.user_manual_edits, result, fields);
  const risks = collectUserResolvableAiRisks(result, fields);
  const resolvedRiskIds = new Set();
  proofs.forEach((proof) => proof.riskIds.forEach((riskId) => resolvedRiskIds.add(riskId)));
  const allRiskIds = new Set(resolvedRiskIds);
  risks.forEach((risk) => allRiskIds.add(risk.riskId));
  const unresolvedRisks = risks.filter((risk) => !risk.resolvable || !resolvedRiskIds.has(risk.riskId));
  const fallback = result.ai_fallback || {};
  const eligibleAiOutcome = (isAiReturnedUncertain(result)
    && fallback.provider_kind === 'REAL')
    || (fallback.status === 'not_requested' && proofs.length > 0);
  // parse_route is a derived, mutable presentation/routing result. A trusted
  // edit may legitimately move an uncertain AI draft to FAST_LOCAL in the same
  // turn, so completion is bound to the signed proof, AI revision and Provider
  // identity instead of the post-edit route label.
  const complete = eligibleAiOutcome
    && proofs.length > 0
    && allRiskIds.size > 0
    && unresolvedRisks.length === 0;
  return {
    status: complete ? USER_RESOLUTION_COMPLETE : USER_RESOLUTION_INCOMPLETE,
    allRisksResolved: complete,
    originalAiStatus: String(fallback.status || 'not_requested'),
    revision: getAiResolutionRevision(result),
    resolvedRiskIds: Array.from(resolvedRiskIds).sort(),
    unresolvedRiskIds: unresolvedRisks.map((risk) => risk.riskId).sort(),
    trustedEditCount: proofs.length
  };
}

function normalizeConfirmationItems(value) {
  if (!Array.isArray(value)) return [];
  const keyCounts = value.reduce((counts, item) => {
    const itemKey = String(item && item.confirmationItemKey || '').trim();
    if (itemKey) counts.set(itemKey, (counts.get(itemKey) || 0) + 1);
    return counts;
  }, new Map());
  const duplicatedKeys = new Set(Array.from(keyCounts.entries())
    .filter((entry) => entry[1] > 1)
    .map((entry) => entry[0]));
  const usedKeys = new Set();
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => {
      const next = Object.assign({}, item);
      let itemKey = String(next.confirmationItemKey || '').trim();
      if (duplicatedKeys.has(itemKey)) itemKey = '';
      if (!itemKey || usedKeys.has(itemKey)) {
        const identity = [index, next.productName || '', next.spec || ''].join('|');
        const base = `mip_item_${itemKeyHash(identity)}`;
        itemKey = base;
        let suffix = 1;
        while (usedKeys.has(itemKey)) {
          itemKey = `${base}_${suffix}`;
          suffix += 1;
        }
      }
      usedKeys.add(itemKey);
      next.confirmationItemKey = itemKey;
      return next;
    });
}

function normalizeManualItemFields(value, items) {
  if (!Array.isArray(value)) return [];
  const allowedKeys = new Set(items
    .map((item) => String(item && item.confirmationItemKey || '').trim())
    .filter(Boolean));
  const seen = new Set();
  return value.reduce((output, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return output;
    const itemKey = String(entry.itemKey || '').trim();
    const field = String(entry.field || '').trim();
    if (!allowedKeys.has(itemKey) || !MANUAL_ITEM_FIELDS.includes(field)) return output;
    const identity = `${itemKey}:${field}`;
    if (seen.has(identity)) return output;
    seen.add(identity);
    output.push({ itemKey, field });
    return output;
  }, []);
}

function isItemConflictManuallyConfirmed(conflict, manualItemFields) {
  if (!conflict || conflict.field !== 'items') return false;
  const itemKey = String(conflict.itemKey || '').trim();
  const itemField = String(conflict.itemField || '').trim();
  if (!itemKey || !itemField || itemField === 'identity') return false;
  return manualItemFields.some((entry) => (
    entry.itemKey === itemKey && entry.field === itemField
  ));
}

function hasFieldValue(fields, field) {
  return fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function getItems(fields) {
  return Array.isArray(fields.items)
    ? fields.items.filter((item) => item && typeof item === 'object')
    : [];
}

function buildSemanticScopeText(sourceText, fields = {}) {
  const entityNames = uniqueStrings([].concat(
    fields.customerName || '',
    fields.productName || '',
    getItems(fields).map((item) => item.productName || '')
  ))
    .map(compact)
    .filter((value) => value.length >= 2)
    .sort((left, right) => right.length - left.length);

  return entityNames.reduce(
    // 只移除一次已识别的实体提及。后文若再次出现同名词，可能属于独立要求，
    // 必须继续留给语义规则判断，不能把整段同名文本全部抹掉。
    (text, value) => text.replace(value, ' '),
    String(sourceText || '')
  );
}

function addIssue(issues, field, message, type = 'invalid') {
  issues.push({ field, message, type });
}

function isPackagingProductName(product) {
  return /(?:包装袋|包装盒|礼品盒|收纳盒|饰品盒|文具套装|箱包|箱子)$/.test(product);
}

function validateCustomerName(fields, sourceText, issues) {
  const name = compact(fields.customerName);
  if (!name) return;
  if (CUSTOMER_GENERIC.test(name)) {
    addIssue(issues, 'customerName', `客户称呼“${name}”过于泛化`);
  }
  if (CUSTOMER_BAD_PREFIX.test(name) || CUSTOMER_BAD_INSIDE.test(name)) {
    addIssue(issues, 'customerName', `客户称呼“${name}”包含动作词或业务词`);
  }
  if (/[0-9零〇一二两三四五六七八九十百千万]/.test(name) || /(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|包|盒|袋|组|把|台|块|元|毛|分)$/.test(name)) {
    addIssue(issues, 'customerName', `客户称呼“${name}”疑似混入数量或价格`);
  }
  if (name.length > 10) {
    addIssue(issues, 'customerName', `客户称呼“${name}”过长，可能截入了上下文`);
  }
  if (sourceText && !compact(sourceText).includes(name)) {
    addIssue(issues, 'customerName', `客户称呼“${name}”不在原文中，需要确认`, 'low_confidence');
  }
}

function validateProductName(fields, issues) {
  const product = compact(fields.productName);
  if (!product) return;
  const customer = compact(fields.customerName);
  if (PRODUCT_PRICE_LIKE.test(product) || /^(?:块|元|毛|角|分|钱)/.test(product)) {
    addIssue(issues, 'productName', `产品“${product}”看起来是价格`);
  }
  if (PRODUCT_BAD_PATTERN.test(product) && !isPackagingProductName(product)) {
    addIssue(issues, 'productName', `产品“${product}”疑似备注、价格或时间信息`);
  }
  if (customer && product.includes(customer)) {
    addIssue(issues, 'productName', `产品“${product}”混入了客户称呼`);
  }
  if (/(?:总|老板|经理|姐|哥|先生|女士)/.test(product) && product.length > 3) {
    addIssue(issues, 'productName', `产品“${product}”疑似混入客户称呼`);
  }
}

function validateItems(fields, issues) {
  const items = getItems(fields);
  if (!items.length) return;
  items.forEach((item, index) => {
    const product = compact(item.productName);
    const label = `商品${index + 1}`;
    if (!product) {
      addIssue(issues, 'productName', `${label}缺少商品名`, 'missing');
    } else {
      if (PRODUCT_PRICE_LIKE.test(product) || /^(?:块|元|毛|角|分|钱)/.test(product)) {
        addIssue(issues, 'productName', `${label}“${product}”看起来是价格`);
      }
      if (PRODUCT_BAD_PATTERN.test(product) && !isPackagingProductName(product)) {
        addIssue(issues, 'productName', `${label}“${product}”疑似备注、价格或时间信息`);
      }
    }

    if (hasFieldValue(item, 'quantity')) {
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        addIssue(issues, 'quantity', `${label}数量“${item.quantity}”不是有效正数`);
      }
    }

    if (hasFieldValue(item, 'unitPrice')) {
      const unitPrice = Number(item.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        addIssue(issues, 'unitPrice', `${label}单价“${item.unitPrice}”不是有效正数`);
      }
      if (Number.isFinite(unitPrice) && unitPrice >= 10000) {
        addIssue(issues, 'unitPrice', `${label}单价“${item.unitPrice}”异常偏大`, 'low_confidence');
      }
    }
    const hasConfirmedItemAmount = hasFieldValue(item, 'totalAmount') && Number.isFinite(Number(item.totalAmount));
    if (item.unit && item.priceUnit && !unitsMatch(item.unit, item.priceUnit) && !hasConfirmedItemAmount) {
      addIssue(issues, 'priceUnit', `${label}数量按“${item.unit}”，单价按“${item.priceUnit}”，不能自动换算金额`);
    }
  });
}

function validateQuantity(fields, issues) {
  if (!hasFieldValue(fields, 'quantity')) return;
  const quantity = Number(fields.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    addIssue(issues, 'quantity', `数量“${fields.quantity}”不是有效正数`);
  }
}

function validateUnitPrice(fields, issues) {
  if (!hasFieldValue(fields, 'unitPrice')) return;
  const unitPrice = Number(fields.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    addIssue(issues, 'unitPrice', `单价“${fields.unitPrice}”不是有效正数`);
  }
  if (Number.isFinite(unitPrice) && unitPrice >= 10000) {
    addIssue(issues, 'unitPrice', `单价“${fields.unitPrice}”异常偏大`, 'low_confidence');
  }
}

function sameMoney(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber)
    && Math.abs(Math.round(leftNumber * 100) - Math.round(rightNumber * 100)) === 0;
}

function validateAmountConsistency(fields, issues) {
  if (!hasFieldValue(fields, 'statedAmount') || !hasFieldValue(fields, 'calculatedAmount')) return;
  if (sameMoney(fields.statedAmount, fields.calculatedAmount)) return;
  addIssue(
    issues,
    'amount',
    `原话总金额${fields.statedAmount}元，与数量×单价计算的${fields.calculatedAmount}元不一致，必须确认。`,
    'invalid'
  );
}

function validateOrderDueDate(result, fields, issues, businessDate = '') {
  if (result.intent !== 'order' || !hasFieldValue(fields, 'dueDate')) return;
  if (diffDays(fields.dueDate, businessDate || today()) >= 0) return;
  addIssue(issues, 'dueDate', `交期${fields.dueDate}早于今天，请确认这是历史补录还是日期说错了。`, 'low_confidence');
}

function inferSemanticFields(text, fields) {
  const low = [];
  if (/上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|价格不变|还是|最终|最后|确认价|改价|贵了|便宜|就按/.test(text)) low.push('unitPrice');
  if (/改成|改为|换成|替换|不是|不对|写错|算了/.test(text)) {
    low.push('productName', 'quantity', 'unitPrice', 'dueDate');
  }
  if (/颜色|色差|包装|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太/.test(text)
    || PACKAGING_REQUIREMENT_PATTERN.test(text)) {
    if (!String(fields.remark || '').includes('要求')) low.push('remark');
  }
  return uniqueStrings(low);
}

function evaluateLocalEvidence(result, options = {}) {
  const fields = result.fields || {};
  const intent = result.intent || 'unknown';
  const originalText = compact(options.originalText || result.original_text || '');
  const normalizedText = compact(options.normalizedText || originalText);
  const reasons = [];
  const missingFields = [];
  const hasCustomer = Boolean(compact(fields.customerName)) && originalText.includes(compact(fields.customerName));
  const hasProduct = Boolean(compact(fields.productName)) && originalText.includes(compact(fields.productName));
  const hasQuantity = Boolean(compact(fields.quantity)) && QUANTITY_WITH_UNIT_PATTERN.test(originalText);
  const hasUnitPrice = Boolean(compact(fields.unitPrice)) && UNIT_PRICE_PATTERN.test(originalText);
  const parsedDateDetail = result.date_detail && result.date_detail.matchedText
    ? result.date_detail
    : parseChineseDateDetail(normalizedText || originalText, options.businessDate || undefined);
  const hasDueDate = Boolean(compact(fields.dueDate))
    && !parsedDateDetail.ambiguous
    && !parsedDateDetail.invalid
    && Boolean(parsedDateDetail.date)
    && compact(fields.dueDate) === compact(parsedDateDetail.date);

  // 报价的跟进日期是可选的；订单的交期不是。这里不依赖来源类型，
  // 只看老板原话里是否确实给出了可核对的业务事实。
  if (['quotation', 'order'].includes(intent)) {
    if (!hasCustomer) {
      missingFields.push('customerName');
      reasons.push('客户称呼没有在原话中明确出现。');
    }
    if (!hasProduct) {
      missingFields.push('productName');
      reasons.push('商品名称不能直接从原话核对。');
    }
    if (!hasQuantity) {
      missingFields.push('quantity');
      reasons.push('数量没有在原话中明确说清。');
    }
    if (!hasUnitPrice) {
      missingFields.push('unitPrice');
      reasons.push('单价没有在原话中明确说清。');
    }
    if (intent === 'order' && !hasDueDate) {
      missingFields.push('dueDate');
      reasons.push('订单交期没有在原话中明确说清。');
    }
  }

  return {
    sufficient: !missingFields.length,
    missing_fields: uniqueStrings(missingFields),
    reason_texts: uniqueStrings(reasons),
    // 这是“原话证据不足”，不是字段本身一定为空。页面会让用户确认，
    // 不能把它误解为 AI 已经证明正确。
    has_all_required_values: ['quotation', 'order'].includes(intent)
      ? Boolean(fields.customerName && fields.productName && fields.quantity && fields.unitPrice && (intent !== 'order' || fields.dueDate))
      : true,
    normalized_text: normalizedText
  };
}

function buildReasonText(issue) {
  return issue.message || `${issue.field || '字段'}需要确认`;
}

function evaluateLocalParseSafety(result, options = {}) {
  const fields = result.fields || {};
  const source = options.source || result.source || 'typed';
  const sourceText = Object.prototype.hasOwnProperty.call(options, 'normalizedText')
    ? options.normalizedText
    : (result.original_text || '');
  const issues = [];
  const missingFields = uniqueStrings(result.missing_fields || []);
  const lowFields = uniqueStrings(result.low_confidence_fields || []);
  const conflictFields = uniqueStrings((result.field_conflicts || []).map((item) => item && item.field));
  const lineCount = String(sourceText || '').split(/\n/).filter(Boolean).length;
  const semanticScopeText = buildSemanticScopeText(sourceText, fields);
  const hasSemanticComplexity = SEMANTIC_AI_PATTERN.test(semanticScopeText)
    || PACKAGING_REQUIREMENT_PATTERN.test(semanticScopeText)
    || lineCount >= 2;
  const hasBusinessSignals = ['customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'paymentAmount', 'dueDate']
    .some((field) => hasFieldValue(fields, field));

  validateCustomerName(fields, sourceText, issues);
  validateProductName(fields, issues);
  validateItems(fields, issues);
  validateQuantity(fields, issues);
  validateUnitPrice(fields, issues);
  validateAmountConsistency(fields, issues);
  validateOrderDueDate(result, fields, issues, options.businessDate);

  const items = getItems(fields);
  const hasProductItem = items.some((item) => hasFieldValue(item, 'productName'));
  const hasMultipleItems = items.length > 1;
  const hasFinancialRisk = ['payment', 'receivable', 'dunning'].includes(result.intent)
    || hasFieldValue(fields, 'paymentAmount')
    || hasFieldValue(fields, 'depositAmount')
    || FINANCIAL_RISK_PATTERN.test(sourceText);
  const evidence = evaluateLocalEvidence(result, {
    originalText: options.originalText || result.original_text || '',
    normalizedText: sourceText,
    businessDate: options.businessDate || ''
  });

  if (CUSTOMER_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'customerName')) {
    addIssue(issues, 'customerName', '缺少客户称呼', 'missing');
  }
  if (PRODUCT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'productName') && !hasProductItem) {
    addIssue(issues, 'productName', '缺少产品/规格', 'missing');
  }
  if (AMOUNT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'amount')) {
    addIssue(issues, 'amount', '缺少应收金额', 'missing');
  }
  if (PAYMENT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'paymentAmount')) {
    addIssue(issues, 'paymentAmount', '缺少收款金额', 'missing');
  }

  const invalidFields = uniqueStrings(issues.filter((item) => item.type === 'invalid').map((item) => item.field));
  const validationLowFields = uniqueStrings(issues.filter((item) => item.type === 'low_confidence').map((item) => item.field));
  const semanticLowFields = hasSemanticComplexity ? inferSemanticFields(semanticScopeText, fields) : [];
  const hasMissing = missingFields.length || issues.some((item) => item.type === 'missing');
  const hasLow = lowFields.length || validationLowFields.length || semanticLowFields.length;
  const hasConflicts = conflictFields.length > 0;

  let status = SAFE_LOCAL;
  if (result.formal_save_blocked && !result.requires_existing_record && !result.mixed_business) {
    status = NO_RECORD;
  } else if (result.formal_save_blocked || result.mixed_business || result.requires_existing_record) {
    status = NEEDS_USER_CONFIRM;
  } else if (result.intent === 'unknown' && !hasBusinessSignals) {
    status = NO_RECORD;
  } else if (result.intent === 'unknown' && hasBusinessSignals) {
    status = NEEDS_AI;
  } else if (invalidFields.length || hasConflicts || hasSemanticComplexity || hasMultipleItems || hasFinancialRisk) {
    status = NEEDS_AI;
  } else if (hasMissing || hasLow || result.intent === 'unknown') {
    status = NEEDS_USER_CONFIRM;
  }

  // 只有“字段齐全”还不够：订单/报价的关键事实必须能从老板原话直接核对。
  // 若字段已经齐全但原文证据不足，可以交给一次快速 AI 核对；若字段本身都缺，
  // 则不能让 AI 猜，直接要求老板补充。
  if (status === SAFE_LOCAL && !evidence.sufficient) {
    status = evidence.has_all_required_values ? NEEDS_AI : NEEDS_USER_CONFIRM;
  }

  const reasonItems = issues.concat(
    conflictFields.map((field) => ({ field, message: `${field}存在多个候选或冲突`, type: 'conflict' }))
  );
  if (hasSemanticComplexity) reasonItems.push({ field: 'semantic', message: '存在历史价格、修改、特殊要求或多轮语义，需要 AI 判断最终有效信息', type: 'semantic' });
  if (hasMultipleItems) reasonItems.push({ field: 'items', message: '包含多个商品，需要逐项核对后再保存', type: 'risk' });
  if (hasFinancialRisk) reasonItems.push({ field: 'financial', message: '涉及收款、欠款、定金或催款，必须核对后再保存', type: 'risk' });
  if (result.formal_save_blocked) reasonItems.push({
    field: result.mixed_business ? 'intent' : 'operation',
    message: result.block_reason || '这条内容不能直接保存成正式业务记录。',
    type: 'risk'
  });
  missingFields.forEach((field) => reasonItems.push({ field, message: `${field}缺失`, type: 'missing' }));
  lowFields.forEach((field) => reasonItems.push({ field, message: `${field}低置信度`, type: 'low_confidence' }));
  evidence.reason_texts.forEach((message, index) => reasonItems.push({
    field: evidence.missing_fields[index] || 'evidence',
    message,
    type: evidence.has_all_required_values ? 'low_confidence' : 'missing'
  }));

  const unsafeFields = uniqueStrings([]
    .concat(invalidFields, validationLowFields, semanticLowFields, conflictFields, evidence.has_all_required_values ? evidence.missing_fields : [])
    .filter((field) => field && field !== 'source' && field !== 'semantic'));
  const evidenceMissingAsLow = evidence.has_all_required_values ? evidence.missing_fields : [];
  const evidenceMissingAsRequired = evidence.has_all_required_values ? [] : evidence.missing_fields;

  return {
    status,
    safe_to_auto_accept: status === SAFE_LOCAL,
    reason_texts: uniqueStrings(reasonItems.map(buildReasonText)),
    unsafe_fields: unsafeFields,
    missing_fields: uniqueStrings(missingFields
      .concat(issues.filter((item) => item.type === 'missing').map((item) => item.field), evidenceMissingAsRequired)),
    low_confidence_fields: uniqueStrings(lowFields
      .concat(validationLowFields, semanticLowFields, invalidFields, conflictFields, evidenceMissingAsLow)),
    field_validations: {
      issues,
      invalid_fields: invalidFields,
      semantic_low_fields: semanticLowFields,
      conflict_fields: conflictFields
    },
    evidence_sufficient: evidence.sufficient,
    evidence_missing_fields: evidence.missing_fields,
    evidence_reason_texts: evidence.reason_texts
  };
}

function applyLocalParseSafety(result, options = {}) {
  const safety = evaluateLocalParseSafety(result, options);
  const lowConfidenceFields = uniqueStrings([].concat(result.low_confidence_fields || [], safety.low_confidence_fields || []));
  const missingFields = uniqueStrings([].concat(result.missing_fields || [], safety.missing_fields || []));
  const next = Object.assign({}, result, {
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields,
    local_parse_safety: safety,
    unsafe_reasons: safety.reason_texts,
    confidence: safety.safe_to_auto_accept ? result.confidence : Math.min(Number(result.confidence || 0.35), safety.status === NEEDS_AI ? 0.68 : 0.78)
  });
  next.ai_fallback = Object.assign({}, result.ai_fallback || {}, {
    needed: safety.status === NEEDS_AI || Boolean(result.ai_fallback && result.ai_fallback.needed)
  });
  if (result.formal_save_blocked) next.ai_fallback.needed = false;
  if (USER_CONFIRM_STATUSES.includes(safety.status)) {
    next.ai_fallback.needed = Boolean(result.ai_fallback && result.ai_fallback.needed);
  }
  return next;
}

function getFinalFieldSafety(result, options = {}) {
  const manualFields = normalizeManualFields(result.manual_fields);
  const shouldVerifyCustomerAgainstOriginal = !manualFields.includes('customerName');
  return evaluateLocalParseSafety(Object.assign({}, result, {
    missing_fields: [],
    low_confidence_fields: []
  }), {
    source: 'typed',
    normalizedText: shouldVerifyCustomerAgainstOriginal ? (result.original_text || '') : '',
    businessDate: options.businessDate || ''
  });
}

function isStaleCustomerConflictValue(value, currentCustomerName) {
  const valueText = compact(value);
  const current = compact(currentCustomerName);
  if (!valueText) return true;
  if (current && valueText === current) return true;
  if (/^(?:就这样|可以|好的|行|嗯|客户|今天|明天|后天|元|个|套|块|钱)$/.test(valueText)) return true;
  if (/^(?:礼品盒|饭盒|包装袋|手提袋|笔袋|纸袋|收纳盒|饰品盒|钥匙扣|卡通杯|水杯|杯垫|杯子|拖鞋|发夹|勺子|玩具车|挂件|贴纸|头绳|箱子|扣子|饰品|玩具|文具|日用品|家电)$/.test(valueText)) {
    return true;
  }
  if (!/(?:总|老板|经理|姐|哥|先生|女士)$/.test(valueText) && /(?:盒|杯|袋|鞋|扣|车|夹|垫|绳|纸|勺|笔)$/.test(valueText)) {
    return true;
  }
  if (current && valueText.includes(current) && /(?:今天|明天|后天|刚|已经|已|付|付款|转|打款|到账|下单|说|问|确认|可以|这样)$/.test(valueText)) {
    return true;
  }
  return false;
}

function filterFinalFieldConflicts(conflicts, fields, finalMissing, finalLow) {
  return (conflicts || []).filter((conflict) => {
    if (conflict && conflict.field === 'amount'
      && hasFieldValue(fields, 'statedAmount')
      && hasFieldValue(fields, 'calculatedAmount')
      && sameMoney(fields.statedAmount, fields.calculatedAmount)) {
      return false;
    }
    if (conflict && conflict.field === 'priceUnit' && !conflict.itemKey) {
      const conflictItems = getItems(fields);
      const unresolvedMismatch = (conflictItems.length ? conflictItems : [fields]).some((item) => (
        item.unit
          && item.priceUnit
          && !unitsMatch(item.unit, item.priceUnit)
          && !hasFieldValue(item, 'totalAmount')
      ));
      if (!unresolvedMismatch) return false;
    }
    if (!conflict || conflict.field !== 'customerName') return true;
    if (finalMissing.includes('customerName') || finalLow.includes('customerName')) return true;
    if (!hasFieldValue(fields, 'customerName')) return true;
    const values = Array.isArray(conflict.values) ? conflict.values : [];
    if (!values.length) return true;
    return !values.every((value) => isStaleCustomerConflictValue(value, fields.customerName));
  });
}

function applyFinalParseSafety(result, options = {}) {
  let fields = Object.assign({}, result.fields || {});
  const manualFields = normalizeManualFields(result.manual_fields);
  const rawItems = Array.isArray(fields.items)
    ? fields.items
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => Object.assign({}, item))
    : [];
  const needsItemKeys = rawItems.some((item) => String(item.confirmationItemKey || '').trim())
    || Array.isArray(result.manual_item_fields)
    || (rawItems.length === 1 && manualFields.some((field) => MANUAL_ITEM_FIELDS.includes(field)))
    || (Array.isArray(result.field_conflicts) && result.field_conflicts.some((conflict) => (
      conflict && conflict.field === 'items' && conflict.itemKey
    )));
  const items = needsItemKeys ? normalizeConfirmationItems(rawItems) : rawItems;
  if (Array.isArray(fields.items)) fields.items = items;
  const aiManualResolutionRequired = requiresTrustedAiManualProof(result);
  const rawProofs = Array.isArray(result.user_manual_edits) ? result.user_manual_edits : [];
  const rawItemProofIdentityValid = !rawProofs.some((proof) => proof && proof.itemKey)
    || hasUniqueConfirmationItemKeys(rawItems);
  const trustedUserManualEdits = rawItemProofIdentityValid
    ? normalizeTrustedUserManualEdits(result.user_manual_edits, result, fields)
    : [];
  const rawAssistantProofCount = (Array.isArray(result.user_manual_edits)
    ? result.user_manual_edits
    : []).filter((proof) => proof && proof.source === USER_ASSISTANT_ANSWER).length;
  const trustedAssistantProofCount = trustedUserManualEdits
    .filter((proof) => proof.source === USER_ASSISTANT_ANSWER).length;
  const rejectedAssistantProof = rawAssistantProofCount > trustedAssistantProofCount;
  const resolvedRiskIds = new Set();
  trustedUserManualEdits.forEach((proof) => {
    proof.riskIds.forEach((riskId) => resolvedRiskIds.add(riskId));
  });
  const initialAiRisks = collectUserResolvableAiRisks(result, fields);
  let manualItemFields = normalizeManualItemFields(result.manual_item_fields, items);
  if (items.length === 1) {
    const onlyItemKey = items[0].confirmationItemKey;
    const legacyEntries = manualFields
      .filter((field) => MANUAL_ITEM_FIELDS.includes(field))
      .map((field) => ({ itemKey: onlyItemKey, field }));
    manualItemFields = normalizeManualItemFields(
      manualItemFields.concat(legacyEntries),
      items
    );
  }
  const trustedManualItemFields = trustedUserManualEdits
    .filter((proof) => proof.itemKey)
    .map((proof) => ({ itemKey: proof.itemKey, field: proof.field }));
  const trustedTopLevelFields = trustedUserManualEdits
    .filter((proof) => !proof.itemKey)
    .map((proof) => proof.field);
  const trustedResolvedFields = uniqueStrings(initialAiRisks
    .filter((risk) => risk.resolvable)
    .map((risk) => risk.itemField || risk.field)
    .filter((field) => {
      const matching = initialAiRisks.filter((risk) => (
        risk.resolvable && (risk.itemField || risk.field) === field
      ));
      return matching.length > 0 && matching.every((risk) => resolvedRiskIds.has(risk.riskId));
    }));
  const manualFieldsForSafety = aiManualResolutionRequired
    ? uniqueStrings(trustedTopLevelFields.concat(items.length === 1 ? trustedResolvedFields : []))
    : manualFields;
  const manualItemFieldsForSafety = aiManualResolutionRequired
    ? normalizeManualItemFields(trustedManualItemFields, items)
    : manualItemFields;
  const effectiveManualFields = uniqueStrings(manualFieldsForSafety.filter((field) => (
    items.length === 1 || !MANUAL_ITEM_FIELDS.includes(field)
  )).concat(
    items.length === 1 ? manualItemFieldsForSafety.map((entry) => entry.field) : []
  ));
  const safetyInput = Object.assign({}, result, {
    fields,
    manual_fields: effectiveManualFields,
    manual_item_fields: manualItemFieldsForSafety
  });
  if (result.edit_mode === 'direct_order') {
    const missingFields = [];
    if (!fields.orderId) missingFields.push('orderId');
    if (!fields.customerName) missingFields.push('customerName');
    if (!(items.some((item) => String(item.productName || '').trim()) || fields.productName)) missingFields.push('productName');
    const mismatches = items.filter((item) => item.unit && item.priceUnit && !unitsMatch(item.unit, item.priceUnit) && !hasFieldValue(item, 'totalAmount'));
    const fieldConflicts = mismatches.length ? [{
      field: 'priceUnit',
      values: mismatches.map((item) => `${item.quantity || '-'}${item.unit}，单价按${item.priceUnit}`),
      message: '数量单位和计价单位不同，请手工确认该项金额或改正计价单位。'
    }] : [];
    const status = missingFields.length || fieldConflicts.length ? NEEDS_USER_CONFIRM : SAFE_LOCAL;
    return Object.assign({}, result, {
      fields,
      manual_fields: manualFields,
      manual_item_fields: manualItemFields,
      missing_fields: missingFields,
      low_confidence_fields: fieldConflicts.length ? ['priceUnit'] : [],
      field_conflicts: fieldConflicts,
      final_parse_safety: {
        status,
        safe_to_auto_accept: status === SAFE_LOCAL,
        reason_texts: fieldConflicts.map((item) => item.message)
      }
    });
  }
  const suggestedFields = Object.keys(result.field_suggestions || {});
  let safety = getFinalFieldSafety(safetyInput, options);
  const invalidFields = (((safety.field_validations || {}).invalid_fields) || []);
  if (invalidFields.includes('customerName')) {
    delete fields.customerName;
    delete fields.customerId;
    delete fields.receivableId;
    delete fields.orderId;
  }
  if (invalidFields.includes('productName')) {
    delete fields.productName;
    delete fields.orderId;
  }
  if (fields !== result.fields) {
    safety = getFinalFieldSafety(Object.assign({}, safetyInput, { fields }), options);
  }
  const finalMissing = uniqueStrings(safety.missing_fields || []);
  const conflictFields = uniqueStrings(((safety.field_validations || {}).conflict_fields) || []);
  const declaredAiRecheckFields = uniqueStrings([].concat(
    result.missing_fields || [],
    result.low_confidence_fields || [],
    (result.field_conflicts || [])
      .map((conflict) => conflict && conflict.field)
      .filter((field) => field && field !== 'items'),
    ((safety.field_validations || {}).invalid_fields) || []
  ));
  // A business-valid uncertain AI result must name the facts it could not
  // confirm. Final safety still revalidates values and totals, but it must not
  // silently invent additional evidence-only confirmation work after the user
  // has resolved every precise AI risk.
  const rawFinalLow = uniqueStrings(safety.low_confidence_fields || [])
    .filter((field) => !isAiReturnedUncertain(result) || declaredAiRecheckFields.includes(field));
  const nonConflictFinalLow = rawFinalLow.filter((field) => !conflictFields.includes(field));
  const fieldConflicts = filterFinalFieldConflicts(result.field_conflicts || [], fields, finalMissing, nonConflictFinalLow)
    .filter((conflict) => {
      if (!aiManualResolutionRequired) {
        return !isItemConflictManuallyConfirmed(conflict, manualItemFields)
          && !effectiveManualFields.includes(conflict && conflict.field);
      }
      return !resolvedRiskIds.has(getConflictRiskDescriptor(conflict).riskId);
    });
  const keptConflictFields = uniqueStrings(fieldConflicts.map((conflict) => conflict && conflict.field));
  const finalLow = rawFinalLow
    .filter((field) => !conflictFields.includes(field) || keptConflictFields.includes(field))
    .filter((field) => !effectiveManualFields.includes(field))
    .filter((field) => !trustedResolvedFields.includes(field));
  const missingFields = uniqueStrings([]
    .concat(result.missing_fields || [])
    .filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))
    .filter((field) => !effectiveManualFields.includes(field))
    .filter((field) => !trustedResolvedFields.includes(field))
    .concat(finalMissing
      .filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))
      .filter((field) => !effectiveManualFields.includes(field))
      .filter((field) => !trustedResolvedFields.includes(field))));
  const lowConfidenceFields = uniqueStrings([]
    .concat(result.low_confidence_fields || [])
    .filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))
    .filter((field) => !effectiveManualFields.includes(field))
    .filter((field) => !trustedResolvedFields.includes(field))
    .filter((field) => field !== 'items' || keptConflictFields.includes('items'))
    // 纠错建议不是已证实的事实。用户还没有亲手确认前，不能因为字段碰巧
    // 出现在原话里就把“请确认商品名”的提醒清掉。
    .filter((field) => (aiManualResolutionRequired && field !== 'customerName')
      || !(FINAL_RECHECK_CLEARABLE_LOW_FIELDS.includes(field)
        && !finalLow.includes(field)
        && !(suggestedFields.includes(field) && !effectiveManualFields.includes(field))))
    .concat(finalLow.filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))));

  const resolvedSafetyFields = new Set(trustedResolvedFields);
  const projectedSafety = resolvedSafetyFields.size
    ? Object.assign({}, safety, {
      unsafe_fields: uniqueStrings(safety.unsafe_fields || [])
        .filter((field) => !resolvedSafetyFields.has(field)),
      missing_fields: uniqueStrings(safety.missing_fields || [])
        .filter((field) => !resolvedSafetyFields.has(field)),
      low_confidence_fields: uniqueStrings(safety.low_confidence_fields || [])
        .filter((field) => !resolvedSafetyFields.has(field)),
      evidence_missing_fields: uniqueStrings(safety.evidence_missing_fields || [])
        .filter((field) => !resolvedSafetyFields.has(field)),
      field_validations: Object.assign({}, safety.field_validations || {}, {
        issues: (((safety.field_validations || {}).issues) || [])
          .filter((issue) => !resolvedSafetyFields.has(issue && issue.field)),
        semantic_low_fields: uniqueStrings(
          ((safety.field_validations || {}).semantic_low_fields) || []
        ).filter((field) => !resolvedSafetyFields.has(field))
      })
    })
    : safety;
  const next = Object.assign({}, result, {
    fields,
    manual_fields: manualFields,
    manual_item_fields: manualItemFields,
    user_manual_edits: trustedUserManualEdits,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields,
    field_conflicts: fieldConflicts,
    formal_save_blocked: Boolean(result.formal_save_blocked || rejectedAssistantProof),
    block_reason: rejectedAssistantProof
      ? '当前人工回答已过期，需要重新确认。'
      : result.block_reason,
    final_parse_safety: projectedSafety
  });
  // Final safety can legitimately remove risks that a signed user answer has
  // resolved. Refresh only proofs that were already validated above so the
  // next safety/preflight pass remains bound to the new canonical risk state.
  next.user_manual_edits = refreshTrustedManualEditProofs(
    next,
    fields,
    trustedUserManualEdits
  );
  delete next.userResolution;
  delete next.resolutionOutcome;
  delete next.allRisksResolved;
  next.user_resolution = evaluateUserResolvedAiState(next);
  return next;
}

module.exports = {
  NEEDS_AI,
  NEEDS_USER_CONFIRM,
  NO_RECORD,
  SAFE_LOCAL,
  applyFinalParseSafety,
  applyLocalParseSafety,
  collectUserResolvableAiRisks,
  createTrustedAssistantAnswerChallenge,
  createTrustedAssistantAnswerEdit,
  createTrustedUserManualEdit,
  evaluateLocalEvidence,
  evaluateLocalParseSafety,
  evaluateUserResolvedAiState,
  hasTrustedAssistantAnswerEdit,
  reconcileTrustedUserManualEditState
};
