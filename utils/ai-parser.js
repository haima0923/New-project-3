const { formatDate, isValidCalendarDate, parseChineseDate } = require('./date');
const { parseInput } = require('./parser');
const { getApiBaseUrl, requestJson } = require('./api-client');
const { normalizeBusinessText } = require('./text-normalize');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const {
  applyFinalParseSafety,
  applyLocalParseSafety,
  NEEDS_USER_CONFIRM
} = require('./parse-safety');
const { resolveBusinessTimeContext } = require('./record-flow-runtime');
const { RAW_UNIT_PATTERN, normalizeUnit, unitsMatch } = require('./units');
const { validateVoiceCompletionEvidence } = require('./voice-recognition');

// 普通 AI 只是一轮快速核对：网络层最多 6.7 秒，外层连同本地整理最多 8 秒。
// 自动深度核对使用独立超时预算，不占用日常快速核对的 8 秒预算。
const AI_STANDARD_REQUEST_TIMEOUT_MS = 6700;
const AI_DEEP_REQUEST_TIMEOUT_MS = 25000;
const AI_STANDARD_WAIT_LIMIT_MS = 8000;
const AI_DEEP_WAIT_LIMIT_MS = 25000;
const validIntents = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'query', 'unknown'];
const activeReceivableStatuses = ['待收', '部分收款'];
const ROUTE_LOCAL = 'local';
const ROUTE_AI_STANDARD = 'ai_standard';
const ROUTE_AI_DEEP = 'ai_deep';
const ROUTE_PENDING = 'pending';
const ROUTE_NO_RECORD = 'no_record';
const ROUTE_ASK_USER = 'ASK_USER';
const ROUTE_SAFE_BLOCKED = 'SAFE_BLOCKED';
const CLIENT_ROUTE_SOURCE = 'LOCAL_TRUSTED_ROUTE_V1';
const SOURCE_EVIDENCE_UNIT_PATTERN = `(?:${RAW_UNIT_PATTERN}|片|枚|根|份)`;
const SOURCE_ITEM_IDENTITY_TOKEN = '[\\u3400-\\u9fffA-Za-z0-9Ａ-Ｚａ-ｚ０-９.\\/\\-]';
const SOURCE_DELIMITED_SPEC_PATTERN = '(?:[（(【\\[《“"「『‘\'][^（）()【】\\[\\]《》“”"「」『』‘’\'，,；;]{1,24}[）)】\\]》”"」』’\'])';
const SOURCE_SPACED_SPEC_PATTERN = `(?:(?:\\s+${SOURCE_ITEM_IDENTITY_TOKEN}{1,12}){1,3})`;
const SOURCE_SPEC_SEGMENT_PATTERN = `(?:${SOURCE_DELIMITED_SPEC_PATTERN}|${SOURCE_SPACED_SPEC_PATTERN})`;
const SOURCE_GENERIC_MEASURE_PATTERN = '(?:[\\u3400-\\u9fff]{1,3}|[A-Za-z][A-Za-z.()/\\-]{0,15})';
const ROUTE_LABELS = {
  [ROUTE_LOCAL]: '本地快速整理',
  [ROUTE_AI_STANDARD]: '请 AI 再核对',
  [ROUTE_AI_DEEP]: '请 AI 深度整理',
  [ROUTE_PENDING]: '待整理，不能强行记录',
  [ROUTE_NO_RECORD]: '没有可记录业务'
};
const DEEP_AI_PATTERN = /(?:上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|按原来|价格不变|还是|最终|最后|确认价|改成|改为|改价|改数量|延期|提前|那单|那笔|不是|不对|写错|算了|贵了|便宜|就按|客户说|他说|她说|颜色|色差|包装(?!袋|盒)|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太|换成|替换|取消|别做|先别|等确认|撤回|定金|订金|预付|尾款|欠款|还了|还剩|结清|到账|转了|付了|收了)/i;

function withTrustedClientRoute(route = {}, canonicalRoute) {
  return Object.assign({}, route, {
    client_route: canonicalRoute,
    decisionSource: CLIENT_ROUTE_SOURCE,
    routeAuthority: CLIENT_ROUTE_SOURCE,
    source: CLIENT_ROUTE_SOURCE
  }, canonicalRoute === 'AUTO_DEEP' ? {
    autoDeep: true,
    semantic_decision: 'AUTO_DEEP'
  } : canonicalRoute === ROUTE_ASK_USER ? {
    askUser: true,
    semantic_decision: ROUTE_ASK_USER
  } : canonicalRoute === ROUTE_SAFE_BLOCKED ? {
    safeBlocked: true,
    semantic_decision: ROUTE_SAFE_BLOCKED
  } : {
    semantic_decision: route.decision
  });
}

function getRouteRiskIds(result = {}, field, itemIndex = -1) {
  const riskIds = [];
  const suffix = itemIndex >= 0 ? `|${itemIndex}` : '';
  toArray(result.missing_fields || []).forEach((name) => {
    if (name === field) riskIds.push(`MISSING|${field}${suffix}`);
  });
  toArray(result.low_confidence_fields || []).forEach((name) => {
    if (name === field) riskIds.push(`LOW|${field}${suffix}`);
  });
  toArray(result.field_conflicts || []).forEach((conflict, index) => {
    const conflictField = conflict && typeof conflict === 'object' ? conflict.field : conflict;
    if (conflictField === field) riskIds.push(`CONFLICT|${field}|${index}${suffix}`);
  });
  const safety = result.local_parse_safety || {};
  const invalidFields = ((safety.field_validations || {}).invalid_fields) || [];
  if (invalidFields.includes(field)) riskIds.push(`INVALID|${field}${suffix}`);
  return uniqueStrings(riskIds.length ? riskIds : [`REQUIRED|${field}${suffix}`]);
}

function buildProductQuestionPrompt(text, item = {}) {
  const facts = [];
  const quantity = String(item.quantity || '').trim();
  const unit = String(item.unit || '').trim();
  const unitPrice = String(item.unitPrice || '').trim();
  const deliveryMatch = String(text || '').match(/(?:本|下|上)?周[一二三四五六日天]|星期[一二三四五六日天]|今天|明天|后天|\d{1,2}月\d{1,2}日/);
  if (quantity) facts.push(`${quantity}${unit}`);
  if (unitPrice) facts.push(unit ? `每${unit}${unitPrice}元` : `单价${unitPrice}元`);
  if (deliveryMatch) facts.push(`${deliveryMatch[0]}交`);
  return `${facts.length ? `${facts.join('、')}，` : ''}是什么商品？`;
}

const CLIENT_FACT_GATE_ITEM_FIELDS = Object.freeze([
  'productName', 'quantity', 'unitPrice', 'unit'
]);

function clientFactItemIdentity(item = {}) {
  return [
    normalizeItemIdentityText(item.productName),
    normalizeItemIdentityText(item.spec)
  ].join('|');
}

function sourceItemClauseCandidates(payload = {}, localResult = {}) {
  const sourceText = normalizeBusinessText(String(
    payload.rawText || payload.text || localResult.original_text || ''
  ));
  if (!sourceText || !/[；;\n]/.test(sourceText)) return [];
  const candidates = sourceText
    .split(/[；;\n]+/)
    .map((clause) => String(clause || '').trim())
    .filter(Boolean)
    .filter((clause) => !/^(?:交期|交货|发货|到期|合计|共计|总计|总价|总金额)/.test(clause))
    .filter((clause) => !/^(?:(?:19|20)\d{2}年)?\d{1,2}月\d{1,2}[日号]?(?:前|左右)?(?:交货|交|发货|发|到)?$/.test(clause))
    .map((clause) => {
      const parsed = parseInput({
        businessDate: payload.businessDate,
        businessTimezone: payload.businessTimezone,
        context: payload.context || 'home',
        nowInstant: payload.nowInstant,
        rawText: clause,
        source: 'typed',
        state: { customers: [] },
        text: clause
      });
      const fields = parsed && parsed.fields || {};
      const parsedItems = Array.isArray(fields.items) ? fields.items.filter(Boolean) : [];
      const item = Object.assign({}, parsedItems[0] || {
        productName: fields.productName,
        spec: fields.spec,
        quantity: fields.quantity,
        unit: fields.unit,
        unitPrice: fields.unitPrice,
        priceUnit: fields.priceUnit,
        totalAmount: fields.totalAmount,
        itemDeliveryDate: '',
        itemRemark: ''
      });
      if (!item.unit && item.priceUnit) item.unit = item.priceUnit;
      const productName = String(item.productName || '').trim();
      if (!isPlausibleLocalItemIdentity(productName)
        || /^(?:其中|一个|某个|任意|这项|那项)$/.test(productName)
        || !String(clause).includes(productName)
        || !(String(item.spec || '').trim()
          || String(item.quantity || '').trim()
          || String(item.unitPrice || '').trim())) return null;
      return { clause, item };
    })
    .filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const identity = clientFactItemIdentity(candidate.item);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function applyClientSourceItemDrafts(payload = {}, localResult = {}) {
  if (!['order', 'quotation'].includes(localResult.intent)) return localResult;
  const candidates = sourceItemClauseCandidates(payload, localResult);
  const fields = localResult.fields || {};
  const rawItems = Array.isArray(fields.items) ? fields.items.filter(Boolean) : [];
  if (candidates.length < 2 && rawItems.length < 2) return localResult;
  const existingByIdentity = new Map(rawItems.map((item) => [
    clientFactItemIdentity(item),
    item
  ]));
  const mergedItems = candidates.map((candidate) => Object.assign(
    {},
    candidate.item,
    existingByIdentity.get(clientFactItemIdentity(candidate.item)) || {}
  ));
  rawItems.forEach((item) => {
    const identity = clientFactItemIdentity(item);
    if (!mergedItems.some((candidate) => clientFactItemIdentity(candidate) === identity)) {
      mergedItems.push(Object.assign({}, item));
    }
  });
  if (mergedItems.length < 2) return localResult;
  const duplicatedKeys = getDuplicatedConfirmationItemKeys(mergedItems);
  const usedKeys = new Set();
  const keyedItems = mergedItems.map((item, index) => ensureConfirmationItemKey(
    Object.assign({}, item, {
      confirmationItemKey: duplicatedKeys.has(String(item.confirmationItemKey || ''))
        ? ''
        : String(item.confirmationItemKey || '')
    }),
    'local',
    index,
    usedKeys
  ));
  return Object.assign({}, localResult, {
    fields: Object.assign({}, fields, { items: keyedItems })
  });
}

function hasTrustedManualItemFact(trustedProofs, item, field) {
  const itemKey = String(item && item.confirmationItemKey || '').trim();
  if (!itemKey || !String(item && item[field] === undefined ? '' : item[field]).trim()) return false;
  return toArray(trustedProofs).some((proof) => (
    proof
    && ['USER_ASSISTANT_ANSWER', 'USER_PAGE_EDIT'].includes(proof.source)
    && proof.schemaVersion === 'USER_MANUAL_EDIT_V1'
    && proof.action === 'EDIT_FIELD'
    && proof.itemKey === itemKey
    && proof.field === field
  ));
}

function hasTrustedLocalItemFact(localResult, item, field) {
  if (!String(item && item[field] === undefined ? '' : item[field]).trim()) return false;
  if (String(item && item.confirmationItemOrigin || '') === 'AI_ADDED_ITEM') return false;
  const source = String((localResult.field_sources || {}).items || '');
  return /^rule:item_/.test(source);
}

function hasTrustedTopLevelFact(localResult, field, itemCount) {
  if (itemCount !== 1) return false;
  const fields = localResult.fields || {};
  const source = String((localResult.field_sources || {})[field] || '');
  if (!String(fields[field] === undefined ? '' : fields[field]).trim()) return false;
  return /^(?:history:(?:quotation|order):|rule:|paste_meta:|computed:)/.test(source);
}

function evaluateClientAutoDeepFactGate(payload = {}, localResult = {}) {
  const text = String(payload.rawText || payload.text || localResult.original_text || '');
  const fields = localResult.fields || {};
  const items = Array.isArray(fields.items) ? fields.items.filter(Boolean) : [];
  const sourceCandidates = sourceItemClauseCandidates(payload, localResult);
  const trustedProofs = toArray(localResult.user_manual_edits || []).length
    ? toArray(applyFinalParseSafety(localResult, {
      businessDate: payload.businessDate || ''
    }).user_manual_edits || [])
    : [];
  const sourceByIdentity = new Map(sourceCandidates.map((candidate) => [
    clientFactItemIdentity(candidate.item),
    candidate
  ]));
  const ambiguousOwnership = items.length > 1
    && /(?:其中|某个|任意|有一个|其中一(?:个|项|款))[^；;。\n]{0,12}(?:每|单价|价格)/.test(
      normalizeBusinessText(text)
    );
  const missingTargets = [];
  items.forEach((item, itemIndex) => {
    const sourceCandidate = sourceByIdentity.get(clientFactItemIdentity(item));
    const scope = sourceCandidate
      ? { text: sourceCandidate.clause, unique: true }
      : getAiItemEvidenceScope(text, item, items);
    CLIENT_FACT_GATE_ITEM_FIELDS.forEach((field) => {
      const value = String(item && item[field] === undefined ? '' : item[field]).trim();
      const trustedExternal = hasTrustedLocalItemFact(localResult, item, field)
        || hasTrustedManualItemFact(trustedProofs, item, field)
        || hasTrustedTopLevelFact(localResult, field, items.length);
      let sourceSupported = false;
      if (value && scope.unique) {
        if (field === 'productName') {
          sourceSupported = isAiItemSupplementSupported(field, value, item, scope.text);
        } else if (field === 'quantity' || field === 'unit') {
          sourceSupported = hasBoundItemQuantityEvidence(scope.text, item);
        } else if (field === 'unitPrice') {
          sourceSupported = hasBoundItemUnitPriceEvidence(scope.text, item);
        }
      }
      if ((!value && !trustedExternal) || (value && !sourceSupported && !trustedExternal)) {
        missingTargets.push({
          field,
          fieldPath: `items[${itemIndex}].${field}`,
          item,
          itemIndex,
          itemKey: String(item && item.confirmationItemKey || '')
        });
      }
    });
  });
  return {
    ambiguousOwnership,
    complete: !ambiguousOwnership && missingTargets.length === 0,
    missingTargets
  };
}

function applyQuotationConversionFactExemption(localResult = {}, audit = {}) {
  if (!evaluateExplicitQuotationConversionDeepReview(localResult).eligible) return audit;
  const fields = localResult.fields || {};
  const items = Array.isArray(fields.items) ? fields.items.filter(Boolean) : [];
  const referencedProductName = normalizeItemIdentityText(fields.productName);
  const quotationReference = ((localResult.relation_references || {}).quotation) || {};
  const normalizedReferenceText = normalizeItemIdentityText([
    quotationReference.sourceText,
    quotationReference.normalizedReference
  ].filter(Boolean).join(' '));
  if (!referencedProductName || !normalizedReferenceText.includes(referencedProductName)) return audit;
  const relationItemIndex = items.findIndex((item) => (
    normalizeItemIdentityText(item && item.productName) === referencedProductName
  ));
  if (relationItemIndex < 0) return audit;
  const missingTargets = toArray(audit.missingTargets).filter((target) => (
    target.itemIndex !== relationItemIndex
  ));
  return Object.assign({}, audit, {
    complete: !audit.ambiguousOwnership && missingTargets.length === 0,
    missingTargets
  });
}

function evaluateClientAutoDeepFactGateForRoute(payload = {}, localResult = {}) {
  return applyQuotationConversionFactExemption(
    localResult,
    evaluateClientAutoDeepFactGate(payload, localResult)
  );
}

function getClientFactQuestionCandidate(audit = {}) {
  if (audit.ambiguousOwnership || !audit.missingTargets.length) return null;
  const priority = ['productName', 'quantity', 'unitPrice', 'unit'];
  const target = audit.missingTargets.slice().sort((left, right) => (
    left.itemIndex - right.itemIndex
      || priority.indexOf(left.field) - priority.indexOf(right.field)
  ))[0];
  if (!target) return null;
  const item = target.item || {};
  const label = [item.spec, item.productName].filter(Boolean).join('') || `商品${target.itemIndex + 1}`;
  const prompts = {
    productName: `商品${target.itemIndex + 1}是什么商品？`,
    quantity: `${label}要多少？`,
    unit: `${label}按什么单位计数？`,
    unitPrice: `${label}每${item.unit || item.priceUnit || '件'}多少钱？`
  };
  return {
    answerType: ['quantity', 'unitPrice'].includes(target.field) ? 'number' : 'text',
    prompt: prompts[target.field],
    riskIds: [`MISSING_ITEM_FACT|${target.fieldPath}`],
    target: {
      field: target.field,
      fieldPath: target.fieldPath,
      itemIndex: target.itemIndex,
      itemKey: target.itemKey
    }
  };
}

function shouldApplyClientAutoDeepFactGate(localResult = {}) {
  const fallback = localResult.ai_fallback || {};
  return fallback.attempted !== true
    && !['used', 'returned_uncertain', 'rejected', 'mock_used'].includes(
      String(fallback.status || '').toLowerCase()
    );
}

function applyClientFactGateRisks(payload = {}, localResult = {}) {
  if (!shouldApplyClientAutoDeepFactGate(localResult)) return localResult;
  const audit = evaluateClientAutoDeepFactGateForRoute(payload, localResult);
  if (audit.complete) return localResult;
  const existing = toArray(localResult.field_conflicts || []).slice();
  const conflicts = audit.missingTargets.reduce((output, target) => {
    const alreadyExists = existing.concat(output).some((conflict) => (
      conflict
      && conflict.field === 'items'
      && conflict.itemKey === target.itemKey
      && conflict.itemField === target.field
      && conflict.code === 'CLIENT_SOURCE_FACT_MISSING'
    ));
    if (!alreadyExists) {
      output.push({
        code: 'CLIENT_SOURCE_FACT_MISSING',
        field: 'items',
        fieldPath: target.fieldPath,
        itemField: target.field,
        itemIndex: target.itemIndex,
        itemKey: target.itemKey,
        message: `商品${target.itemIndex + 1}的${target.field}没有可信原文、历史或人工确认依据。`,
        values: []
      });
    }
    return output;
  }, []);
  if (audit.ambiguousOwnership) {
    conflicts.push({
      code: 'CLIENT_ITEM_FACT_OWNERSHIP_AMBIGUOUS',
      field: 'items',
      fieldPath: 'items',
      itemField: 'identity',
      itemIndex: -1,
      itemKey: '',
      message: '原话中的商品事实无法可靠绑定到具体商品。',
      values: []
    });
  }
  const safety = localResult.local_parse_safety || {};
  const evidencePaths = audit.missingTargets.map((target) => target.fieldPath);
  return Object.assign({}, localResult, {
    field_conflicts: existing.concat(conflicts),
    local_parse_safety: Object.assign({}, safety, {
      evidence_missing_fields: uniqueStrings([].concat(
        safety.evidence_missing_fields || [],
        evidencePaths
      )),
      evidence_reason_texts: uniqueReasonTexts([].concat(
        safety.evidence_reason_texts || [],
        conflicts.map((conflict) => conflict.message)
      )),
      evidence_sufficient: false,
      reason_texts: uniqueReasonTexts([].concat(
        safety.reason_texts || [],
        conflicts.map((conflict) => conflict.message)
      )),
      safe_to_auto_accept: false,
      status: NEEDS_USER_CONFIRM
    })
  });
}

function getTrustedQuestionCandidate(text, localResult = {}) {
  const safety = localResult.local_parse_safety || {};
  const fields = localResult.fields || {};
  const items = Array.isArray(fields.items) && fields.items.length
    ? fields.items.filter(Boolean)
    : [fields];
  const missing = uniqueStrings([].concat(
    localResult.missing_fields || [],
    safety.missing_fields || []
  ));
  const low = uniqueStrings([].concat(
    localResult.low_confidence_fields || [],
    safety.low_confidence_fields || []
  ));
  const invalid = uniqueStrings((((safety.field_validations || {}).invalid_fields) || []));
  const currentProductName = String((items[0] && items[0].productName) || fields.productName || '').trim();
  const productLooksLikeDeliveryPhrase = /(?:周|星期)[一二三四五六日天].*交|今天|明天|后天|月底|月末/.test(currentProductName);
  const productRisk = missing.includes('productName')
    || invalid.includes('productName')
    || (low.includes('productName') && productLooksLikeDeliveryPhrase);
  if (productRisk && ['order', 'quotation'].includes(localResult.intent)) {
    const itemIndex = Math.max(0, items.findIndex((item) => !String(item.productName || '').trim()));
    const selectedItem = items[itemIndex] || items[0] || {};
    return {
      answerType: 'text',
      prompt: buildProductQuestionPrompt(text, selectedItem),
      riskIds: getRouteRiskIds(localResult, 'productName', itemIndex),
      target: {
        field: 'productName',
        fieldPath: `items[${itemIndex}].productName`,
        itemIndex
      }
    };
  }
  const amountConflict = toArray(localResult.field_conflicts || []).find((conflict) => (
    (conflict && typeof conflict === 'object' ? conflict.field : conflict) === 'amount'
  ));
  const amountRisk = Boolean(amountConflict)
    || invalid.includes('amount');
  if (amountRisk) {
    const stated = fields.statedAmount || fields.amount || '';
    const calculated = fields.calculatedAmount || '';
    return {
      answerType: 'number',
      prompt: `总金额与商品明细合计不一致。你说的是${stated}元，明细合计${calculated}元，请确认总金额。`,
      riskIds: getRouteRiskIds(localResult, 'amount'),
      target: { field: 'amount', fieldPath: 'amount', itemIndex: -1 }
    };
  }
  if (localResult.intent === 'order'
    && (!String(fields.dueDate || '').trim()
      || missing.includes('dueDate')
      || low.includes('dueDate')
      || invalid.includes('dueDate'))) {
    return {
      answerType: 'date',
      prompt: '这张订单什么时候交货？',
      riskIds: getRouteRiskIds(localResult, 'dueDate'),
      target: { field: 'dueDate', fieldPath: 'dueDate', itemIndex: -1 }
    };
  }
  return null;
}

function unwrapAiResult(result) {
  if (!result || typeof result !== 'object') return {};
  if (result.data && typeof result.data === 'object') return unwrapAiResult(result.data);
  if (result.result && typeof result.result === 'object') return unwrapAiResult(result.result);
  return result;
}

function hasMockProvider(result) {
  if (!result || typeof result !== 'object') return false;
  const provider = String(result.provider || result.aiProvider || '').trim().toLowerCase();
  if (provider === 'mock') return true;
  if (result.data && typeof result.data === 'object' && hasMockProvider(result.data)) return true;
  if (result.result && typeof result.result === 'object' && hasMockProvider(result.result)) return true;
  return false;
}

const AI_BUSINESS_FIELD_KEYS = [
  'customerId', 'customerName', 'phone', 'company', 'region', 'todoTitle', 'followupDays',
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'paymentAmount',
  'depositAmount', 'amount', 'totalAmount', 'statedAmount', 'calculatedAmount',
  'remainingAmount', 'paymentMethod', 'paymentKind', 'dueDate', 'quoteDate', 'orderId',
  'quotationId', 'receivableId', 'remark'
];
const AI_ITEM_FIELD_KEYS = [
  'productName', 'product_name', 'name', 'spec', 'quantity', 'unit', 'unitPrice', 'unit_price',
  'priceUnit', 'price_unit', 'totalAmount', 'total_amount', 'amount', 'itemDeliveryDate',
  'deliveryDate', 'dueDate', 'itemRemark', 'remark'
];
const AI_FIELD_SOURCE_KEYS = new Set(AI_BUSINESS_FIELD_KEYS);
const AI_FIELD_SOURCE_VALUES = new Set(['AI', 'AI_MODEL', 'AI_EXTRACTED', 'AI_INFERRED']);

function isPlainOwnObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeFieldSourceToken(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[\s:./\\-]+/g, '_')
    .replace(/_+/g, '_');
}

function isTrustedUserFieldSource(value) {
  const token = normalizeFieldSourceToken(value);
  return token === 'USER'
    || token.startsWith('USER_')
    || token === 'MANUAL'
    || token.startsWith('MANUAL_');
}

function getCanonicalSourceClaims(value) {
  if (!isPlainOwnObject(value)) return '';
  return Object.keys(value).sort().map((key) => {
    const entry = value[key];
    return `${key}:${typeof entry === 'string' ? entry : `[${typeof entry}]`}`;
  }).join('|');
}

function sanitizeAiFieldSources(aiResult = {}) {
  const hasSnake = Object.prototype.hasOwnProperty.call(aiResult, 'field_sources');
  const hasCamel = Object.prototype.hasOwnProperty.call(aiResult, 'fieldSources');
  const snake = hasSnake ? aiResult.field_sources : null;
  const camel = hasCamel ? aiResult.fieldSources : null;
  if (hasSnake && hasCamel && getCanonicalSourceClaims(snake) !== getCanonicalSourceClaims(camel)) {
    return Object.create(null);
  }
  const claims = hasSnake ? snake : camel;
  if (!isPlainOwnObject(claims)) return Object.create(null);
  return Object.keys(claims).reduce((output, key) => {
    if (!Object.prototype.hasOwnProperty.call(claims, key)
      || !AI_FIELD_SOURCE_KEYS.has(key)
      || ['__proto__', 'prototype', 'constructor', 'toString'].includes(key)) return output;
    const value = claims[key];
    if (typeof value !== 'string') return output;
    const token = normalizeFieldSourceToken(value);
    if (AI_FIELD_SOURCE_VALUES.has(token)) output[key] = 'AI';
    return output;
  }, Object.create(null));
}

function fieldSourceValuesEqual(left, right) {
  if (left === right) return true;
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeTrustedFieldSources(localResult, aiResult, aiFields, finalFields) {
  const localSources = localResult && localResult.field_sources;
  const local = isPlainOwnObject(localSources) ? localSources : {};
  const merged = Object.assign({}, local);
  const aiSources = sanitizeAiFieldSources(aiResult);
  const protectedManualFields = new Set([].concat(
    Array.isArray(localResult && localResult.manual_fields) ? localResult.manual_fields : [],
    (Array.isArray(localResult && localResult.user_manual_edits)
      ? localResult.user_manual_edits.map((proof) => proof && proof.field)
      : [])
  ).map((field) => String(field || '')).filter(Boolean));
  Object.keys(aiSources).forEach((key) => {
    const aiProvidedField = Object.prototype.hasOwnProperty.call(aiFields || {}, key);
    const finalAdoptedAiValue = aiProvidedField
      && Object.prototype.hasOwnProperty.call(finalFields || {}, key)
      && fieldSourceValuesEqual(finalFields[key], aiFields[key]);
    if (!finalAdoptedAiValue
      || protectedManualFields.has(key)
      || isTrustedUserFieldSource(local[key])) return;
    merged[key] = aiSources[key];
  });
  return merged;
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === 'object') return Object.keys(value).some((key) => hasMeaningfulValue(value[key]));
  if (typeof value === 'boolean') return value;
  return true;
}

function hasBusinessScalar(value) {
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'number' && Number.isFinite(value);
}

function hasMeaningfulItem(item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    && AI_ITEM_FIELD_KEYS.some((key) => hasBusinessScalar(item[key]));
}

function normalizeIntentCandidateValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = value.intent || value.type || value.value || value.name || value.label || '';
  }
  return String(value || '').trim().toLowerCase();
}

function getAiBusinessResultValidity(aiResult) {
  const result = unwrapAiResult(aiResult);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { valid: false, kind: 'empty', reason: 'AI result is not an object' };
  }
  const fields = result.fields && typeof result.fields === 'object' && !Array.isArray(result.fields)
    ? result.fields
    : result;
  const intent = String(result.intent || '').trim().toLowerCase();
  const knownIntent = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'query']
    .includes(intent);
  const hasBusinessField = AI_BUSINESS_FIELD_KEYS.some((key) => (
    hasBusinessScalar(fields[key]) || (fields !== result && hasBusinessScalar(result[key]))
  ));
  const fieldEvidence = result.field_evidence || result.fieldEvidence || {};
  const hasBusinessEvidence = AI_BUSINESS_FIELD_KEYS.concat('items').some((key) => (
    hasMeaningfulValue(fieldEvidence[key])
  ));
  const items = fields.items || fields.lineItems || fields.line_items || fields.products || fields.goods
    || result.items || result.lineItems || result.line_items || result.products || result.goods;
  const hasItems = Array.isArray(items) && items.some(hasMeaningfulItem);
  const hasSafetyFinding = [
    result.missing_fields || result.missingFields,
    result.low_confidence_fields || result.lowConfidenceFields,
    result.field_conflicts || result.fieldConflicts
  ].some((value) => hasMeaningfulValue(value));
  const rawIntentCandidates = result.intent_candidates || result.intentCandidates || [];
  const intentCandidates = Array.from(new Set(
    (Array.isArray(rawIntentCandidates) ? rawIntentCandidates : [rawIntentCandidates])
      .map(normalizeIntentCandidateValue)
      .filter(Boolean)
  ));
  const hasIntentUncertainty = intentCandidates.length > 1
    || (intentCandidates.length > 0 && (!intent || intent === 'unknown'
      || intentCandidates.some((candidate) => candidate !== intent)));
  const explicitDecision = String(result.decision || result.status || '').trim().toLowerCase();
  const explicitDecisionReason = result.confirm_message || result.confirmMessage || result.reason || result.message;
  const explicitlyNotRecordable = result.no_record === true
    || result.recordable === false
    || (['no_record', 'needs_user_confirm', 'needs_ai', 'pending'].includes(explicitDecision)
      && hasMeaningfulValue(explicitDecisionReason));
  const hasUnknownConclusion = intent === 'unknown'
    && hasMeaningfulValue(explicitDecisionReason);

  if (hasSafetyFinding || hasIntentUncertainty || explicitlyNotRecordable || hasUnknownConclusion
    || (intent === 'unknown' && (hasBusinessField || hasItems))) {
    return { valid: true, kind: 'uncertain', reason: 'AI returned an explicit safety decision' };
  }
  if (knownIntent || ((hasBusinessField || hasItems) && hasBusinessEvidence)) {
    return { valid: true, kind: 'business', reason: 'AI returned a business decision or field' };
  }
  return { valid: false, kind: 'empty', reason: 'AI returned no business decision, field, or safety finding' };
}

function createEmptyAiBusinessResultError(validity) {
  const error = new Error((validity && validity.reason) || 'AI returned no business result');
  error.code = 'AI_RESPONSE_EMPTY_BUSINESS';
  return error;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function toStringArray(value) {
  return toArray(value)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return item.intent || item.type || item.value || item.name || item.label || '';
    })
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return toStringArray(values).filter((item, index, array) => array.indexOf(item) === index);
}

function getPayloadRawMessages(payload = {}) {
  const pasteMeta = payload.pasteMeta || {};
  const candidates = payload.rawMessages || pasteMeta.rawMessages || pasteMeta.messages || [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((message, index) => ({
      index: message.index !== undefined ? message.index : index,
      speaker: String(message.speaker || '').trim(),
      time: String(message.time || '').trim(),
      content: String(message.content || message.text || '').trim()
    }))
    .filter((message) => message.content);
}

function isMultiMessagePaste(payload = {}) {
  if (payload.source !== 'paste') return false;
  const rawMessages = getPayloadRawMessages(payload);
  const messageCount = rawMessages.length || Number((payload.pasteMeta && payload.pasteMeta.messageCount) || 0);
  return messageCount > 1;
}

function parseMessageUnitPriceCandidates(content) {
  const normalized = normalizeBusinessText(content).trim();
  const candidates = [];
  const chunk = numberPattern();
  const push = (value, flags = {}) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number >= 1000) return;
    const clean = toCleanNumber(number);
    if (!clean) return;
    candidates.push(Object.assign({ value: clean, content }, flags));
  };

  const notBut = normalized.match(new RegExp(`(?:不是|不对)\\s*(${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:是|改成|应为)\\s*(${chunk})`));
  if (notBut) {
    push(parseChineseNumber(notBut[1]), { superseded: true });
    push(parseChineseNumber(notBut[2]), { final: true });
  }

  const changed = normalized.match(new RegExp(`(?:价格|单价|报价|价)[^，,。；;]{0,16}?(?:改成|改为|改|成|为)\\s*(${chunk})`));
  if (changed) push(parseChineseNumber(changed[1]), { final: true });

  const superseded = normalized.match(new RegExp(`(${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:别用|作废|写错|不要)`));
  if (superseded) push(parseChineseNumber(superseded[1]), { superseded: true });

  const parsed = parseInput({
    text: content,
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const value = parsed && parsed.fields ? parsed.fields.unitPrice : '';
  if (value) push(value, {});
  const bare = normalized.match(new RegExp(`^(${numberPattern()})(?:元|块)?$`));
  if (bare) push(parseChineseNumber(bare[1]), {});

  const seen = {};
  return candidates.filter((item) => {
    const key = `${item.value}:${item.superseded ? 'old' : 'current'}:${item.final ? 'final' : ''}`;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function parseMessageUnitPrice(content) {
  const candidates = parseMessageUnitPriceCandidates(content);
  const final = candidates.filter((item) => !item.superseded).slice(-1)[0];
  return final ? final.value : '';
}

function getMessageUnitPriceCandidates(rawMessages) {
  return rawMessages
    .flatMap((message) => parseMessageUnitPriceCandidates(message.content).map((candidate) => ({
      index: message.index,
      speaker: message.speaker,
      content: message.content,
      value: candidate.value,
      final: candidate.final,
      superseded: candidate.superseded
    })))
    .filter((item) => item.value);
}

function parseMessageQuantity(content) {
  const parsed = parseInput({
    text: content,
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const value = parsed && parsed.fields ? parsed.fields.quantity : '';
  return value ? String(value) : '';
}

function getMessageQuantityCandidates(rawMessages) {
  return rawMessages
    .map((message) => ({
      index: message.index,
      speaker: message.speaker,
      content: message.content,
      value: parseMessageQuantity(message.content),
      final: /最后|最终|一共|总共|合计|改成|改为|确认|不对/.test(normalizeBusinessText(message.content))
    }))
    .filter((item) => item.value);
}

function buildFieldConflict(field, values, rawMessages, label) {
  const uniqueValues = uniqueStrings(values);
  if (uniqueValues.length <= 1) return null;
  return {
    field,
    values: uniqueValues,
    message: `${label}出现多个候选：${uniqueValues.join('、')}，需要确认最终以哪一个为准。`,
    evidence: rawMessages
      .filter((message) => uniqueValues.some((value) => String(message.content || '').includes(value)))
      .map((message) => ({
        messageIndex: message.index,
        speaker: message.speaker,
        text: message.content
      }))
  };
}

function extractLocalFieldConflicts(payload) {
  const rawMessages = getPayloadRawMessages(payload);
  if (!rawMessages.length) return [];
  const unitPrices = getMessageUnitPriceCandidates(rawMessages).map((item) => item.value);
  const quantities = getMessageQuantityCandidates(rawMessages).map((item) => item.value);
  const hasPriceCorrectionSignal = rawMessages.some((message) => /价格|单价|报价|价|少了逗号|写错|不是|不对|别用/.test(normalizeBusinessText(message.content || '')));
  const priceConflict = buildFieldConflict('unitPrice', unitPrices, rawMessages, '单价')
    || (hasPriceCorrectionSignal && unitPrices.length ? {
      field: 'unitPrice',
      values: uniqueStrings(unitPrices),
      message: '单价出现纠错或作废表达，需要确认最终单价。',
      evidence: rawMessages.map((message) => ({ messageIndex: message.index, speaker: message.speaker, text: message.content }))
    } : null);
  const quantityConflict = buildFieldConflict('quantity', quantities, rawMessages, '数量');
  return [priceConflict, quantityConflict].filter(Boolean);
}

function applyLatestLocalUnitPrice(next, payload, fieldConflicts) {
  const candidates = getMessageUnitPriceCandidates(getPayloadRawMessages(payload));
  if (!candidates.length || !next.fields) return next;
  const hasConflict = fieldConflicts.some((item) => item.field === 'unitPrice');
  if (!hasConflict && next.fields.unitPrice) return next;
  const currentCandidates = candidates.filter((item) => !item.superseded);
  const latest = currentCandidates.slice().reverse().find((item) => item.final) || currentCandidates[currentCandidates.length - 1] || candidates[candidates.length - 1];
  if (!latest || !latest.value || !next.fields) return next;
  const fields = Object.assign({}, next.fields, {
    unitPrice: latest.value
  });
  const amount = calculateAmount(fields.quantity, fields.unitPrice, fields.unit, fields.priceUnit);
  if (amount) {
    fields.calculatedAmount = amount;
    if (!fields.statedAmount) fields.amount = amount;
  }
  return Object.assign({}, next, {
    fields,
    field_sources: Object.assign({}, next.field_sources || {}, {
      unitPrice: 'rule:latest_conversation_unit_price',
      amount: amount ? 'rule:quantity_times_latest_unit_price' : ((next.field_sources || {}).amount || '')
    })
  });
}

function applyLatestLocalQuantity(next, payload, fieldConflicts) {
  const candidates = getMessageQuantityCandidates(getPayloadRawMessages(payload));
  if (!candidates.length || !next.fields) return next;
  const hasConflict = fieldConflicts.some((item) => item.field === 'quantity');
  if (!hasConflict && next.fields.quantity) return next;
  const latest = candidates.slice().reverse().find((item) => item.final) || candidates[candidates.length - 1];
  if (!latest || !latest.value) return next;
  const fields = Object.assign({}, next.fields, {
    quantity: latest.value
  });
  const amount = calculateAmount(fields.quantity, fields.unitPrice, fields.unit, fields.priceUnit);
  if (amount) {
    fields.calculatedAmount = amount;
    if (!fields.statedAmount) fields.amount = amount;
  }
  return Object.assign({}, next, {
    fields,
    field_sources: Object.assign({}, next.field_sources || {}, {
      quantity: 'rule:latest_conversation_quantity',
      amount: amount ? 'rule:latest_quantity_times_unit_price' : ((next.field_sources || {}).amount || '')
    })
  });
}

function extractRemarkItemsFromMessages(payload) {
  const rawMessages = getPayloadRawMessages(payload);
  if (!rawMessages.length) return [];
  const requirementPattern = /(颜色|色差|深一点|浅一点|淡一点|不要太深|不要太浅|包装|外箱|内盒|贴纸|标签|logo|LOGO|图案|材质|尺寸|规格|加急|交期|唛头|印字|印刷|备注|要求|透明度|隔板|插头|欧规|裁边|箱规|磁吸|边缘|袋口|盖子|带盖|黑色|红色|偏黄|太厚|太松|太紧|刮手|剩余|还剩|后面还有)/i;
  return rawMessages
    .filter((message) => requirementPattern.test(message.content))
    .map((message) => ({
      messageIndex: message.index,
      speaker: message.speaker,
      text: message.content
    }));
}

function buildRemarkFromItems(remarkItems) {
  const items = (remarkItems || [])
    .map((item) => String(item.text || item || '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  const normalizedItems = items
    .map((item) => normalizeBusinessText(item).trim().replace(/[,，]{2,}/g, '，').replace(/,/g, '，'))
    .filter((item, index, array) => item && array.indexOf(item) === index);
  const normalizedText = normalizedItems.length && normalizedItems.join('；') !== items.join('；')
    ? `；规范化要求：${normalizedItems.join('；')}`
    : '';
  return `客户要求：${items.join('；')}${normalizedText}`;
}

function getConversationCustomerName(rawMessages = []) {
  const speakers = rawMessages
    .map((message) => String(message.speaker || '').trim())
    .filter((speaker) => speaker && !/^(?:我|自己|本人|老板|客服|系统)$/.test(speaker))
    .filter((speaker) => !/^(?:就按这个|可以|好的|行|嗯|那就)$/.test(speaker))
    .filter((speaker, index, array) => array.indexOf(speaker) === index);
  return speakers[0] || '';
}

function isUsableConversationCustomer(name) {
  const value = String(name || '').trim();
  return Boolean(value)
    && value.length <= 10
    && !/[0-9零〇一二两三四五六七八九十百千万]/.test(value)
    && !/(?:订单|报价|价格|货款|款|杯|盒|袋|鞋|扣|垫|绳)/.test(value);
}

function attachConversationReview(localResult, payload) {
  const rawMessages = getPayloadRawMessages(payload);
  if (!rawMessages.length) return localResult;
  const fieldConflicts = extractLocalFieldConflicts(payload);
  const remarkItems = extractRemarkItemsFromMessages(payload);
  const conflictFields = fieldConflicts.map((item) => item.field).filter(Boolean);
  let next = Object.assign({}, localResult, {
    raw_messages: rawMessages,
    field_conflicts: fieldConflicts,
    remark_items: remarkItems,
    low_confidence_fields: uniqueStrings([].concat(localResult.low_confidence_fields || [], conflictFields))
  });
  const conversationCustomer = getConversationCustomerName(rawMessages);
  if (isUsableConversationCustomer(conversationCustomer)) {
    const currentCustomer = String((next.fields || {}).customerName || '').trim();
    if (!currentCustomer || !isUsableConversationCustomer(currentCustomer) || currentCustomer !== conversationCustomer) {
      next.fields = Object.assign({}, next.fields || {}, { customerName: conversationCustomer });
      next.field_sources = Object.assign({}, next.field_sources || {}, { customerName: 'rule:conversation_speaker' });
      next.low_confidence_fields = uniqueStrings((next.low_confidence_fields || []).filter((field) => field !== 'customerName'));
    }
  }
  next = applyLatestLocalUnitPrice(next, payload, fieldConflicts);
  next = applyLatestLocalQuantity(next, payload, fieldConflicts);
  if (remarkItems.length && next.fields && !String(next.fields.remark || '').startsWith('客户要求：')) {
    next.fields = Object.assign({}, next.fields, {
      remark: [buildRemarkFromItems(remarkItems), next.fields.remark || next.original_text || ''].filter(Boolean).join('\n\n原始聊天：\n')
    });
  }
  return next;
}

function markAiNeeded(localResult, route = {}) {
  return Object.assign({}, localResult, {
    parse_route: route,
    ai_fallback: Object.assign({}, localResult.ai_fallback || {}, {
      needed: true,
      status: 'requested',
      attempted: true,
      business_result_valid: false
    })
  });
}

function hasPackagingRequirementSignal(source) {
  const text = String(source || '');
  return /包装(?!袋|盒|纸)|包装[^，,。；;\n]{0,12}(?:改成|改为|改|换成|怎么|如何|做|要求|确认|彩盒|外箱|内盒)|客户问[^，,。；;\n]{0,12}包装/.test(text);
}

function shouldForceAi(payload, localResult) {
  if (isMultiMessagePaste(payload)) return true;
  const source = String(payload.text || localResult.original_text || '');
  return /(改成|算了|还是|就按|贵了|便宜|换成|确认价|最终|颜色|logo|LOGO|特殊|要求|备注)/.test(source)
    || hasPackagingRequirementSignal(source);
}

function uniqueReasonTexts(values) {
  return uniqueStrings(values).slice(0, 4);
}

function evaluateSafeLocalReceivableRoute(facts = {}) {
  const fields = facts.fields || {};
  const fieldSources = facts.fieldSources || {};
  const safety = facts.safety || {};
  const validations = safety.field_validations || {};
  const missingFields = uniqueStrings([]
    .concat(facts.missingFields || [], safety.missing_fields || []));
  const lowConfidenceFields = uniqueStrings([]
    .concat(facts.lowConfidenceFields || [], safety.low_confidence_fields || []));
  const conflicts = toArray(facts.conflicts || []);
  const invalidFields = uniqueStrings(validations.invalid_fields || []);
  const semanticLowFields = uniqueStrings(validations.semantic_low_fields || []);
  const safetyConflictFields = uniqueStrings(validations.conflict_fields || []);
  const intentCandidates = uniqueStrings(facts.intentCandidates || []);
  const amount = Number(fields.amount);
  const operation = String(facts.operation || '');
  const suggestedOperation = String(facts.suggestedOperation || '');
  const amountSource = String(fieldSources.amount || fieldSources.statedAmount || '');
  const exclusions = [];
  const reasonCodes = [];

  if (facts.intent !== 'receivable') exclusions.push('NOT_RECEIVABLE_INTENT');
  else reasonCodes.push('RECEIVABLE_INTENT_CONFIRMED');

  if ((operation && operation !== 'create_receivable')
    || (suggestedOperation && suggestedOperation !== 'create_receivable')) {
    exclusions.push('OPERATION_NOT_CREATE_RECEIVABLE');
  } else {
    reasonCodes.push('CREATE_RECEIVABLE_CANDIDATE');
  }
  if (!String(fields.customerName || '').trim()) exclusions.push('CUSTOMER_NOT_CONFIRMED');
  else reasonCodes.push('CUSTOMER_PRESENT');
  if (!Number.isFinite(amount) || amount <= 0) {
    exclusions.push('RECEIVABLE_AMOUNT_NOT_POSITIVE');
  } else if (amountSource !== 'rule:explicit_receivable_amount') {
    exclusions.push('RECEIVABLE_AMOUNT_NOT_EXPLICIT');
  } else {
    reasonCodes.push('EXPLICIT_RECEIVABLE_AMOUNT');
  }
  if (missingFields.length) exclusions.push('MISSING_FIELDS');
  else reasonCodes.push('NO_MISSING_FIELDS');
  if (lowConfidenceFields.length) exclusions.push('LOW_CONFIDENCE_FIELDS');
  else reasonCodes.push('NO_LOW_CONFIDENCE_FIELDS');
  if (conflicts.length || safetyConflictFields.length) exclusions.push('FIELD_CONFLICTS');
  else reasonCodes.push('NO_FIELD_CONFLICTS');
  if (invalidFields.length) exclusions.push('INVALID_FIELDS');
  if (semanticLowFields.length) exclusions.push('SEMANTIC_LOW_CONFIDENCE');
  if (safety.evidence_sufficient !== true) exclusions.push('SOURCE_EVIDENCE_INSUFFICIENT');
  if (uniqueStrings(safety.unsafe_fields || []).length) exclusions.push('UNSAFE_FIELDS');
  if (facts.formalSaveBlocked) exclusions.push('FORMAL_SAVE_BLOCKED');
  if (facts.mixedBusiness) exclusions.push('MIXED_BUSINESS');
  else reasonCodes.push('SINGLE_BUSINESS');
  if (facts.requiresExistingRecord) exclusions.push('REQUIRES_EXISTING_RECORD');
  if (facts.contextPolicy && facts.contextPolicy !== 'none') exclusions.push('CONTEXT_POLICY_REQUIRES_REVIEW');
  if (facts.hasHistoryReference) exclusions.push('HISTORY_REFERENCE_REQUIRES_REVIEW');
  if (facts.hasSemanticDeepRisk) exclusions.push('SEMANTIC_DEEP_RISK');
  if (facts.forceAiRequired) exclusions.push('AI_POLICY_REQUIRES_REVIEW');
  if (facts.hasConversationRisk) exclusions.push('MULTI_MESSAGE_INPUT');
  if (Number(facts.itemCount || 0) > 1) exclusions.push('MULTI_ITEM_INPUT');
  if (fields.paymentAmount) exclusions.push('PAYMENT_SIGNAL_PRESENT');
  if (fields.depositAmount || fields.paymentKind === 'deposit') exclusions.push('DEPOSIT_SIGNAL_PRESENT');
  if (intentCandidates.some((intent) => intent !== 'receivable')) {
    exclusions.push('INTENT_CONFLICT');
  }
  if (facts.deepReviewRequested) exclusions.push('DEEP_REVIEW_REQUESTED');

  return {
    eligible: exclusions.length === 0,
    reasonCodes: uniqueStrings(reasonCodes),
    exclusions: uniqueStrings(exclusions)
  };
}

const NO_RECORD_INTENT_SCORE_KEYS = Object.freeze([
  'dunning',
  'order',
  'payment',
  'quotation',
  'receivable',
  'todo'
]);
const NO_RECORD_BUSINESS_FIELD_KEYS = Object.freeze([
  'amount',
  'calculatedAmount',
  'customerId',
  'customerName',
  'depositAmount',
  'dueDate',
  'orderId',
  'paymentAmount',
  'paymentKind',
  'paymentMethod',
  'phone',
  'priceUnit',
  'productName',
  'quantity',
  'quotationId',
  'receivableId',
  'remainingAmount',
  'spec',
  'statedAmount',
  'todoTitle',
  'totalAmount',
  'unit',
  'unitPrice'
]);
const VOICE_STANDARD_TRUSTED_EVIDENCE_SOURCES = Object.freeze([
  'FAKE_VOICE_FINAL_CALLBACK',
  'VOICE_PROVIDER_FINAL_CALLBACK'
]);

function countRelationEvidence(relationReferences) {
  if (!relationReferences || typeof relationReferences !== 'object') return 0;
  return Object.values(relationReferences).filter((reference) => (
    reference
    && typeof reference === 'object'
    && (
      reference.explicit === true
      || reference.requiresResolution === true
      || hasMeaningfulValue(reference.kind)
      || hasMeaningfulValue(reference.resolvedEntityId)
    )
  )).length;
}

function evaluateClearNonBusinessNoRecord(facts = {}) {
  const fields = facts.fields || {};
  const fieldSources = facts.fieldSources || {};
  const safety = facts.safety || {};
  const validations = safety.field_validations || {};
  const intentEvidence = facts.intentEvidence || {};
  const scores = intentEvidence.scores || {};
  const exclusions = [];
  const reasonCodes = [];
  const structuredBusinessFields = NO_RECORD_BUSINESS_FIELD_KEYS.filter((key) => (
    hasMeaningfulValue(fields[key])
    || hasMeaningfulValue(fieldSources[key])
  ));
  const items = toArray(facts.items || fields.items || []).filter(hasMeaningfulItem);
  const intentSignalKeys = Object.keys(intentEvidence).filter((key) => (
    /Signals$/.test(key) && toArray(intentEvidence[key]).length > 0
  ));
  const scoresComplete = NO_RECORD_INTENT_SCORE_KEYS.every((key) => (
    Object.prototype.hasOwnProperty.call(scores, key)
    && Number.isFinite(Number(scores[key]))
  ));
  const positiveScoreKeys = NO_RECORD_INTENT_SCORE_KEYS.filter((key) => (
    Number(scores[key]) > 0
  ));
  const intentCandidates = uniqueStrings(facts.intentCandidates || []);
  const missingFields = uniqueStrings([]
    .concat(facts.missingFields || [], safety.missing_fields || []));
  const unresolvedMissingFields = missingFields.filter((field) => field !== 'intent');
  const lowConfidenceFields = uniqueStrings([]
    .concat(facts.lowConfidenceFields || [], safety.low_confidence_fields || []));
  const conflicts = toArray(facts.conflicts || []);
  const invalidFields = uniqueStrings(validations.invalid_fields || []);
  const semanticLowFields = uniqueStrings(validations.semantic_low_fields || []);
  const safetyConflictFields = uniqueStrings(validations.conflict_fields || []);
  const unsafeFields = uniqueStrings(safety.unsafe_fields || []);
  const relationEvidenceCount = countRelationEvidence(facts.relationReferences);
  const businessEvidenceCount = structuredBusinessFields.length
    + items.length
    + intentSignalKeys.length
    + positiveScoreKeys.length
    + relationEvidenceCount
    + toArray(facts.customerCandidates || []).length
    + (hasMeaningfulValue(facts.fieldSuggestions) ? 1 : 0);

  if (facts.parserCompleted !== true) exclusions.push('PARSER_NOT_COMPLETED');
  else reasonCodes.push('PARSER_COMPLETED');
  if (facts.asyncWorkCompleted !== true) exclusions.push('ASYNC_WORK_NOT_COMPLETED');
  else reasonCodes.push('ASYNC_WORK_COMPLETED');
  if (safety.status !== 'NO_RECORD') exclusions.push('LOCAL_SAFETY_NOT_NO_RECORD');
  else reasonCodes.push('LOCAL_SAFETY_NO_RECORD');
  if (facts.intent !== 'unknown') exclusions.push('BUSINESS_INTENT_PRESENT');
  else reasonCodes.push('UNKNOWN_INTENT');
  if (hasMeaningfulValue(facts.operation) || hasMeaningfulValue(facts.suggestedOperation)) {
    exclusions.push('CANONICAL_OPERATION_PRESENT');
  } else {
    reasonCodes.push('NO_CANONICAL_OPERATION');
  }
  if (!scoresComplete) exclusions.push('INTENT_SCORE_EVIDENCE_INCOMPLETE');
  if (positiveScoreKeys.length || intentSignalKeys.length) exclusions.push('BUSINESS_INTENT_EVIDENCE_PRESENT');
  else if (scoresComplete) reasonCodes.push('ZERO_BUSINESS_INTENT_EVIDENCE');
  if (intentCandidates.some((intent) => intent !== 'unknown')) {
    exclusions.push('BUSINESS_INTENT_CANDIDATE_PRESENT');
  }
  if (structuredBusinessFields.length || items.length) exclusions.push('STRUCTURED_BUSINESS_FIELDS_PRESENT');
  else reasonCodes.push('NO_STRUCTURED_BUSINESS_FIELDS');
  if (relationEvidenceCount) exclusions.push('RELATION_EVIDENCE_PRESENT');
  else reasonCodes.push('NO_RELATION_EVIDENCE');
  if (toArray(facts.customerCandidates || []).length) exclusions.push('CUSTOMER_CANDIDATES_PRESENT');
  if (hasMeaningfulValue(facts.fieldSuggestions)) exclusions.push('FIELD_SUGGESTIONS_PRESENT');
  if (unresolvedMissingFields.length) exclusions.push('BUSINESS_FIELDS_MISSING');
  if (lowConfidenceFields.length || semanticLowFields.length) exclusions.push('LOW_CONFIDENCE_BUSINESS_FIELDS');
  if (conflicts.length || safetyConflictFields.length) exclusions.push('BUSINESS_FIELD_CONFLICTS');
  if (invalidFields.length || unsafeFields.length) exclusions.push('UNSAFE_OR_INVALID_BUSINESS_FIELDS');
  if (safety.evidence_sufficient !== true) exclusions.push('SOURCE_EVIDENCE_INSUFFICIENT');
  if (facts.formalSaveBlocked) exclusions.push('FORMAL_SAVE_BLOCKED');
  if (facts.mixedBusiness) exclusions.push('MIXED_BUSINESS');
  if (facts.requiresExistingRecord) exclusions.push('REQUIRES_EXISTING_RECORD');
  if (facts.contextPolicy && facts.contextPolicy !== 'none') exclusions.push('CONTEXT_POLICY_REQUIRES_REVIEW');
  if (facts.hasConversationRisk) exclusions.push('MULTI_MESSAGE_INPUT');
  if (facts.hasHistoryReference) exclusions.push('HISTORY_REFERENCE_REQUIRES_REVIEW');
  if (facts.hasSemanticDeepRisk) exclusions.push('SEMANTIC_DEEP_RISK');
  if (facts.forceAiRequired) exclusions.push('AI_POLICY_REQUIRES_REVIEW');
  if (facts.deepReviewRequested) exclusions.push('DEEP_REVIEW_REQUESTED');

  return {
    businessEvidenceCount,
    eligible: exclusions.length === 0,
    exclusions: uniqueStrings(exclusions),
    reasonCodes: uniqueStrings(reasonCodes),
    relationEvidenceCount,
    structuredBusinessFieldCount: structuredBusinessFields.length
  };
}

function evaluateCompletedVoiceStandardReview(facts = {}) {
  const fields = facts.fields || {};
  const items = toArray(facts.items || fields.items || []).filter(hasMeaningfulItem);
  const safety = facts.safety || {};
  const validations = safety.field_validations || {};
  const completion = facts.voiceCompletionAudit || {};
  const inputChannel = String(facts.inputChannel || '').trim().toLowerCase();
  const missingFields = uniqueStrings([]
    .concat(facts.missingFields || [], safety.missing_fields || []));
  const unresolvedBusinessFields = missingFields.filter((field) => field !== 'intent');
  const lowConfidenceFields = uniqueStrings([]
    .concat(facts.lowConfidenceFields || [], safety.low_confidence_fields || []));
  const conflicts = toArray(facts.conflicts || []);
  const invalidFields = uniqueStrings(validations.invalid_fields || []);
  const semanticLowFields = uniqueStrings(validations.semantic_low_fields || []);
  const safetyConflictFields = uniqueStrings(validations.conflict_fields || []);
  const unsafeFields = uniqueStrings(safety.unsafe_fields || []);
  const intentCandidates = uniqueStrings(facts.intentCandidates || [])
    .filter((intent) => intent && intent !== 'unknown');
  const intentScores = facts.intentEvidence && facts.intentEvidence.scores || {};
  const positiveIntentScoreKeys = NO_RECORD_INTENT_SCORE_KEYS.filter((key) => (
    Number(intentScores[key]) > 0
  ));
  const relationEvidenceCount = Number.isFinite(Number(facts.relationEvidenceCount))
    ? Number(facts.relationEvidenceCount)
    : countRelationEvidence(facts.relationReferences);
  const structuredBusinessFields = NO_RECORD_BUSINESS_FIELD_KEYS.filter((key) => (
    hasMeaningfulValue(fields[key])
  ));
  const structuredBusinessFieldCount = Number.isFinite(
    Number(facts.structuredBusinessFieldCount)
  )
    ? Number(facts.structuredBusinessFieldCount)
    : structuredBusinessFields.length;
  const businessEvidenceCount = Number.isFinite(Number(facts.businessEvidenceCount))
    ? Number(facts.businessEvidenceCount)
    : structuredBusinessFieldCount + items.length + relationEvidenceCount;
  const item = items[0] || {};
  const customerPresent = hasMeaningfulValue(fields.customerName)
    || hasMeaningfulValue(fields.customerId);
  const productPresent = hasMeaningfulValue(fields.productName)
    || hasMeaningfulValue(item.productName);
  const quantity = Number(fields.quantity || item.quantity);
  const priceOrAmount = Number(
    fields.unitPrice
    || item.unitPrice
    || fields.amount
    || fields.totalAmount
    || fields.calculatedAmount
    || item.totalAmount
  );
  const strongBusinessCombination = customerPresent
    && productPresent
    && Number.isFinite(quantity)
    && quantity > 0
    && Number.isFinite(priceOrAmount)
    && priceOrAmount > 0;
  const exclusions = [];
  const reasonCodes = [];

  if (!['voice', 'voice_transcript'].includes(inputChannel)) {
    exclusions.push('VOICE_INPUT_CHANNEL_REQUIRED');
  } else {
    reasonCodes.push('VOICE_INPUT_CHANNEL_CONFIRMED');
  }
  if (completion.present !== true) exclusions.push('VOICE_COMPLETION_EVIDENCE_MISSING');
  if (completion.status !== 'COMPLETED' || completion.isFinal !== true) {
    exclusions.push('VOICE_COMPLETION_NOT_FINAL');
  }
  if (completion.valid !== true) exclusions.push('VOICE_COMPLETION_EVIDENCE_INVALID');
  else reasonCodes.push('VOICE_FINAL_TRANSCRIPT_VERIFIED');
  if (completion.sessionMatched !== true) exclusions.push('VOICE_SESSION_MISMATCH');
  else reasonCodes.push('VOICE_SESSION_MATCHED');
  if (completion.fingerprintMatched !== true) {
    exclusions.push('VOICE_TRANSCRIPT_FINGERPRINT_MISMATCH');
  } else {
    reasonCodes.push('VOICE_TRANSCRIPT_FINGERPRINT_MATCHED');
  }
  if (!VOICE_STANDARD_TRUSTED_EVIDENCE_SOURCES.includes(completion.evidenceSource)) {
    exclusions.push('VOICE_COMPLETION_SOURCE_UNTRUSTED');
  }
  if (facts.parserCompleted !== true || facts.evidenceCollectionCompleted !== true) {
    exclusions.push('VOICE_ASYNC_INCOMPLETE');
  } else {
    reasonCodes.push('VOICE_PARSER_AND_EVIDENCE_COMPLETE');
  }
  if (facts.asyncPending) exclusions.push('VOICE_ASYNC_INCOMPLETE');
  if (facts.intent !== 'unknown') exclusions.push('VOICE_LOCAL_INTENT_RESOLVED');
  else reasonCodes.push('VOICE_INTENT_UNRESOLVED');
  if (hasMeaningfulValue(facts.operation) || hasMeaningfulValue(facts.suggestedOperation)) {
    exclusions.push('VOICE_CANONICAL_OPERATION_PRESENT');
  }
  if (facts.clearNoRecordEligible) exclusions.push('VOICE_CLEAR_NO_RECORD');
  if (businessEvidenceCount <= 0 || structuredBusinessFieldCount <= 0) {
    exclusions.push('VOICE_BUSINESS_EVIDENCE_INSUFFICIENT');
  } else {
    reasonCodes.push('VOICE_STRUCTURED_BUSINESS_EVIDENCE');
  }
  if (!strongBusinessCombination) exclusions.push('VOICE_BUSINESS_EVIDENCE_INSUFFICIENT');
  else reasonCodes.push('VOICE_STRONG_BUSINESS_FIELD_COMBINATION');
  if (unresolvedBusinessFields.length) exclusions.push('VOICE_BUSINESS_FIELDS_MISSING');
  if (lowConfidenceFields.length || semanticLowFields.length) {
    exclusions.push('VOICE_LOW_CONFIDENCE_FIELDS');
  }
  if (conflicts.length || safetyConflictFields.length) {
    exclusions.push('VOICE_CONFLICT_PRESENT');
  }
  if (invalidFields.length || unsafeFields.length) {
    exclusions.push('VOICE_UNSAFE_OR_INVALID_FIELDS');
  }
  if (safety.evidence_sufficient !== true) {
    exclusions.push('VOICE_SOURCE_EVIDENCE_INSUFFICIENT');
  }
  if (safety.status !== 'NEEDS_AI') exclusions.push('VOICE_STANDARD_REVIEW_NOT_REQUIRED');
  if (facts.financialRisk) exclusions.push('VOICE_FINANCIAL_RISK');
  if (facts.mixedBusiness
    || intentCandidates.length > 1
    || positiveIntentScoreKeys.length > 1) {
    exclusions.push('VOICE_MIXED_INTENT');
  }
  if (facts.hasConversationRisk) exclusions.push('VOICE_MIXED_INTENT');
  if (facts.contextPolicy && facts.contextPolicy !== 'none') {
    exclusions.push('VOICE_DEEP_REVIEW_REQUIRED');
  }
  if (facts.hasHistoryReference
    || facts.hasSemanticDeepRisk
    || facts.forceAiRequired
    || Number(facts.itemCount || 0) > 1) {
    exclusions.push('VOICE_DEEP_REVIEW_REQUIRED');
  }
  if (facts.deepReviewRequested) exclusions.push('VOICE_DEEP_REVIEW_REQUIRED');
  if (relationEvidenceCount || facts.requiresExistingRecord) {
    exclusions.push('VOICE_DANGEROUS_RELATION_REFERENCE');
  }
  if (facts.formalSaveBlocked) exclusions.push('VOICE_FORMAL_SAVE_BLOCKED');
  if (facts.hasProductSuggestion) exclusions.push('VOICE_LOCAL_CONFIRMATION_AVAILABLE');
  if (facts.aiAlreadyRequested) exclusions.push('VOICE_AI_ALREADY_REQUESTED');

  const uniqueExclusions = uniqueStrings(exclusions);
  if (!uniqueExclusions.length) reasonCodes.push('VOICE_STANDARD_REVIEW_REQUIRED');
  return {
    businessEvidenceCount,
    completionEvidenceValid: completion.valid === true,
    conflictCount: conflicts.length + safetyConflictFields.length,
    eligible: uniqueExclusions.length === 0,
    exclusions: uniqueExclusions,
    financialRisk: facts.financialRisk === true,
    fingerprintMatched: completion.fingerprintMatched === true,
    lowConfidenceFieldCount: uniqueStrings(
      lowConfidenceFields.concat(semanticLowFields)
    ).length,
    mixedIntent: facts.mixedBusiness === true
      || intentCandidates.length > 1
      || positiveIntentScoreKeys.length > 1,
    reasonCodes: uniqueStrings(reasonCodes),
    relationEvidenceCount,
    sessionMatched: completion.sessionMatched === true,
    structuredBusinessFieldCount
  };
}

const TRUSTED_QUOTATION_REFERENCE_KINDS = Object.freeze([
  'EXPLICIT_QUOTATION_DEICTIC',
  'EXPLICIT_QUOTATION_NAMED_REFERENCE'
]);
const TRUSTED_QUOTATION_REFERENCE_SOURCE_FIELDS = Object.freeze([
  'ORIGINAL_TEXT',
  'EXTRACTED_TEXT'
]);

function getTrustedLocalUnresolvedQuotationReference(value) {
  const quotation = normalizeObject(value, null);
  if (!quotation || Array.isArray(value)) return null;
  if (quotation.entityType !== 'QUOTATION'
    || quotation.explicit !== true
    || quotation.requiresResolution !== true
    || quotation.evidenceSource !== 'LOCAL_PARSER'
    || quotation.resolvedEntityId !== null) return null;
  if (!TRUSTED_QUOTATION_REFERENCE_KINDS.includes(String(quotation.kind || ''))) {
    return null;
  }
  if (!TRUSTED_QUOTATION_REFERENCE_SOURCE_FIELDS.includes(
    String(quotation.sourceField || '')
  )) return null;
  const sourceText = String(quotation.sourceText || '');
  const normalizedReference = String(quotation.normalizedReference || '');
  const confidence = Number(quotation.confidence);
  const sourceSpan = quotation.sourceSpan;
  if (!sourceText.trim() || !normalizedReference.trim()) return null;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) return null;
  if (!sourceSpan || typeof sourceSpan !== 'object' || Array.isArray(sourceSpan)) {
    return null;
  }
  if (!Number.isInteger(sourceSpan.start)
    || !Number.isInteger(sourceSpan.end)
    || sourceSpan.start < 0
    || sourceSpan.end <= sourceSpan.start
    || sourceSpan.end - sourceSpan.start !== sourceText.length) return null;
  return quotation;
}

function evaluateExplicitQuotationConversionDeepReview(localResult = {}) {
  const intentEvidence = normalizeObject(localResult.intent_evidence, {});
  const conversionSignals = toArray(
    intentEvidence.quotationToOrderConversionSignals
  );
  const conversion = conversionSignals.find((signal) => (
    signal
    && signal.direction === 'QUOTATION_TO_ORDER'
    && signal.explicit === true
    && signal.evidenceSource === 'LOCAL_PARSER'
  )) || null;
  const relationReferences = normalizeObject(
    localResult.relation_references,
    {}
  );
  const quotation = normalizeObject(relationReferences.quotation, null);
  const trustedQuotation = getTrustedLocalUnresolvedQuotationReference(quotation);
  const quotationReferenceTrusted = Boolean(trustedQuotation);
  const relevant = Boolean(conversion);
  const eligible = Boolean(conversion && quotationReferenceTrusted);
  const reasonCodes = [];
  const exclusionCodes = [];
  if (conversion) reasonCodes.push('QUOTATION_TO_ORDER_CONVERSION_VERIFIED');
  if (quotationReferenceTrusted) {
    reasonCodes.push('EXPLICIT_QUOTATION_REFERENCE_REQUIRES_RESOLUTION');
  }
  if (eligible) reasonCodes.push('QUOTATION_CONVERSION_DEEP_REVIEW_AVAILABLE');
  if (relevant && !quotation) {
    exclusionCodes.push('EXPLICIT_QUOTATION_REFERENCE_MISSING');
  } else if (relevant && !quotationReferenceTrusted) {
    exclusionCodes.push('EXPLICIT_QUOTATION_REFERENCE_UNTRUSTED');
  }
  return {
    conversion,
    eligible,
    exclusionCodes,
    quotation: trustedQuotation,
    reasonCodes,
    relevant
  };
}

function getParseRouteDecision(payload = {}, localResult = {}, policy = 'none') {
  const source = payload.source || localResult.source || 'typed';
  const inputChannel = String(payload.inputChannel || source).trim().toLowerCase();
  const isVoiceInput = ['voice', 'voice_transcript'].includes(inputChannel);
  const text = normalizeBusinessText(String(payload.rawText || payload.text || localResult.original_text || ''));
  const safety = localResult.local_parse_safety || {};
  const fields = localResult.fields || {};
  const items = Array.isArray(fields.items) ? fields.items.filter(Boolean) : [];
  const conflicts = toArray(localResult.field_conflicts || []);
  const hasFinancialRisk = ['payment', 'receivable'].includes(localResult.intent)
    || Boolean(fields.depositAmount || fields.paymentAmount || fields.paymentKind === 'deposit')
    || /定金|订金|预付|尾款|欠款|还款|收款|到账|转账|打款/.test(text);
  const hasConversationRisk = isMultiMessagePaste(payload)
    || getPayloadRawMessages(payload).length > 1;
  const missingFields = toArray(safety.missing_fields || []);
  const hasMissingCriticalFact = missingFields.some((field) => ['customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'paymentAmount', 'intent'].includes(field));
  const hasCompleteButUnverifiedEvidence = safety.evidence_sufficient === false
    && (safety.evidence_missing_fields || []).length > 0
    && !hasMissingCriticalFact
    && (localResult.missing_fields || []).length === 0;
  const hasHistoryReference = /(?:上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|按原来|价格不变|还是)/.test(text);
  // reviewMode/deep 是不可信的页面请求意图，只能由下面的本地事实和
  // safety 结果决定是否进入自动深度核对。
  const deepReviewRequested = false;
  const quotationConversionDeepReview =
    evaluateExplicitQuotationConversionDeepReview(localResult);
  const clientFactGate = shouldApplyClientAutoDeepFactGate(localResult)
    ? evaluateClientAutoDeepFactGateForRoute(payload, localResult)
    : { ambiguousOwnership: false, complete: true, missingTargets: [] };
  // 缺少客户/商品等事实时，“颜色、备注”不能把题目升级成深度 AI；AI 不能替老板编事实。
  const hasSemanticDeepRisk = DEEP_AI_PATTERN.test(text) && (!hasMissingCriticalFact || hasHistoryReference);
  const hasDeepRisk = hasFinancialRisk
    || hasConversationRisk
    || policy !== 'none'
    || conflicts.length > 0
    || items.length > 1
    || hasSemanticDeepRisk
    || quotationConversionDeepReview.eligible;
  const hasProductSuggestion = Boolean(localResult.field_suggestions && localResult.field_suggestions.productName);
  const hasOnlyLocallyConfirmableUnitConflict = conflicts.length > 0
    && conflicts.every((item) => ((item && item.field) || item) === 'priceUnit');
  const canConfirmProductAndUnitLocally = hasProductSuggestion
    && hasOnlyLocallyConfirmableUnitConflict
    && !hasFinancialRisk
    && !hasConversationRisk
    && policy === 'none'
    && items.length <= 1
    && !hasSemanticDeepRisk
    && !quotationConversionDeepReview.eligible
    && !deepReviewRequested;
  const localReasons = uniqueReasonTexts(safety.reason_texts || []);
  const safeLocalReceivable = evaluateSafeLocalReceivableRoute({
    conflicts,
    contextPolicy: policy,
    deepReviewRequested,
    fieldSources: localResult.field_sources || {},
    fields,
    forceAiRequired: shouldForceAi(payload, localResult),
    formalSaveBlocked: localResult.formal_save_blocked === true,
    hasConversationRisk,
    hasHistoryReference,
    hasSemanticDeepRisk,
    intent: localResult.intent,
    intentCandidates: localResult.intent_candidates || [],
    itemCount: items.length,
    lowConfidenceFields: localResult.low_confidence_fields || [],
    missingFields: localResult.missing_fields || [],
    mixedBusiness: localResult.mixed_business === true,
    operation: localResult.operation,
    requiresExistingRecord: localResult.requires_existing_record === true,
    safety,
    suggestedOperation: localResult.suggested_operation
  });
  const voiceCompletionAudit = payload.voiceCompletionEvidenceAudit || {};
  const clearNoRecord = evaluateClearNonBusinessNoRecord({
    asyncWorkCompleted: isVoiceInput
      ? voiceCompletionAudit.valid === true
      : true,
    conflicts,
    contextPolicy: policy,
    customerCandidates: localResult.customer_candidates || [],
    deepReviewRequested,
    fieldSources: localResult.field_sources || {},
    fieldSuggestions: localResult.field_suggestions || {},
    fields,
    forceAiRequired: shouldForceAi(payload, localResult),
    formalSaveBlocked: localResult.formal_save_blocked === true,
    hasConversationRisk,
    hasHistoryReference,
    hasSemanticDeepRisk,
    intent: localResult.intent,
    intentCandidates: localResult.intent_candidates || [],
    intentEvidence: localResult.intent_evidence || {},
    items,
    lowConfidenceFields: localResult.low_confidence_fields || [],
    missingFields: localResult.missing_fields || [],
    mixedBusiness: localResult.mixed_business === true,
    operation: localResult.operation,
    parserCompleted: true,
    relationReferences: localResult.relation_references || {},
    requiresExistingRecord: localResult.requires_existing_record === true,
    safety,
    suggestedOperation: localResult.suggested_operation
  });
  const clearNoRecordCanonicalReasonCodes = clearNoRecord.eligible
    ? uniqueStrings([
      'CLEAR_NON_BUSINESS',
      'NO_BUSINESS_EVIDENCE',
      'NO_STRUCTURED_FIELDS',
      'NO_RELATION_EVIDENCE',
      'PROCESSING_COMPLETE'
    ].concat(clearNoRecord.reasonCodes))
    : clearNoRecord.reasonCodes;
  const voiceStandardReview = evaluateCompletedVoiceStandardReview({
    aiAlreadyRequested: Number(payload.aiRequestCount || 0) > 0
      || payload.aiAlreadyRequested === true,
    asyncPending: false,
    businessEvidenceCount: clearNoRecord.businessEvidenceCount,
    clearNoRecordEligible: clearNoRecord.eligible,
    conflicts,
    contextPolicy: policy,
    deepReviewRequested,
    evidenceCollectionCompleted: true,
    fields,
    financialRisk: hasFinancialRisk,
    forceAiRequired: shouldForceAi(payload, localResult),
    formalSaveBlocked: localResult.formal_save_blocked === true,
    hasConversationRisk,
    hasHistoryReference,
    hasProductSuggestion,
    hasSemanticDeepRisk,
    inputChannel,
    intent: localResult.intent,
    intentCandidates: localResult.intent_candidates || [],
    intentEvidence: localResult.intent_evidence || {},
    itemCount: items.length,
    items,
    lowConfidenceFields: localResult.low_confidence_fields || [],
    missingFields: localResult.missing_fields || [],
    mixedBusiness: localResult.mixed_business === true,
    operation: localResult.operation,
    parserCompleted: true,
    relationEvidenceCount: clearNoRecord.relationEvidenceCount,
    relationReferences: localResult.relation_references || {},
    requiresExistingRecord: localResult.requires_existing_record === true,
    safety,
    structuredBusinessFieldCount: clearNoRecord.structuredBusinessFieldCount,
    suggestedOperation: localResult.suggested_operation,
    voiceCompletionAudit
  });
  let questionCandidate = quotationConversionDeepReview.eligible
    ? null
    : getTrustedQuestionCandidate(text, localResult);
  if (!questionCandidate) {
    questionCandidate = getClientFactQuestionCandidate(clientFactGate);
  }
  // 多轮聊天中的商品语义要结合上下文核对，不能用单句缺字段逻辑
  // 清空已有 Local 业务事实。金额等确定冲突仍可就地问用户。
  if (hasConversationRisk
    && questionCandidate
    && questionCandidate.target
    && questionCandidate.target.field === 'productName') {
    questionCandidate = null;
  }
  // 多商品中的交期低置信常来自修改语义或句子边界，应先自动结合
  // 全部商品核对，不应抢在 AUTO_DEEP 之前让老板手工回答。
  if (items.length > 1
    && questionCandidate
    && questionCandidate.target
    && questionCandidate.target.field === 'dueDate'
    && String(fields.dueDate || '').trim()
    && !toArray(localResult.missing_fields || []).includes('dueDate')) {
    questionCandidate = null;
  }
  const withRouteAudit = (route) => {
    const audited = Object.assign({}, route, isVoiceInput ? {
      voice_completion_evidence_present: voiceCompletionAudit.present === true,
      voice_completion_evidence_fingerprint_matched:
        voiceCompletionAudit.fingerprintMatched === true,
      voice_completion_evidence_session_matched:
        voiceCompletionAudit.sessionMatched === true,
      voice_completion_evidence_source: voiceCompletionAudit.evidenceSource || null,
      voice_completion_evidence_status: voiceCompletionAudit.status || null,
      voice_completion_evidence_valid: voiceCompletionAudit.valid === true,
      voice_standard_eligible: voiceStandardReview.eligible,
      voice_standard_conflict_count: voiceStandardReview.conflictCount,
      voice_standard_exclusion_codes: voiceStandardReview.exclusions,
      voice_standard_financial_risk: voiceStandardReview.financialRisk,
      voice_standard_low_confidence_field_count:
        voiceStandardReview.lowConfidenceFieldCount,
      voice_standard_mixed_intent: voiceStandardReview.mixedIntent,
      voice_standard_reason_codes: voiceStandardReview.reasonCodes
    }
    : {}, localResult.intent === 'unknown'
    ? {
      business_evidence_count: clearNoRecord.businessEvidenceCount,
      no_record_eligible: clearNoRecord.eligible,
      no_record_eligibility_exclusions: clearNoRecord.exclusions,
      no_record_eligibility_reason_codes: clearNoRecordCanonicalReasonCodes,
      relation_evidence_count: clearNoRecord.relationEvidenceCount,
      structured_business_field_count: clearNoRecord.structuredBusinessFieldCount
    }
    : {}, localResult.intent === 'receivable'
    ? {
      receivable_risk_exclusions: safeLocalReceivable.exclusions,
      safe_local_receivable_eligible: safeLocalReceivable.eligible,
      safe_local_receivable_reason_codes: safeLocalReceivable.reasonCodes
    }
    : {}, quotationConversionDeepReview.relevant ? {
      quotation_conversion_deep_review_eligible:
        quotationConversionDeepReview.eligible,
      quotation_conversion_deep_review_exclusion_codes:
        quotationConversionDeepReview.exclusionCodes,
      quotation_conversion_deep_review_reason_codes:
        quotationConversionDeepReview.reasonCodes
    } : {});
    if (route.decision === ROUTE_AI_DEEP) {
      return withTrustedClientRoute(audited, 'AUTO_DEEP');
    }
    if (route.decision === ROUTE_ASK_USER) {
      return withTrustedClientRoute(audited, ROUTE_ASK_USER);
    }
    if (route.decision === ROUTE_SAFE_BLOCKED) {
      return withTrustedClientRoute(audited, ROUTE_SAFE_BLOCKED);
    }
    if (route.decision === ROUTE_LOCAL) {
      return withTrustedClientRoute(audited, 'FAST_LOCAL');
    }
    return withTrustedClientRoute(audited, route.decision || ROUTE_PENDING);
  };

  if (localResult.formal_save_blocked) {
    return withRouteAudit({
      decision: ROUTE_PENDING,
      label: '需要先确认原记录',
      reasons: uniqueReasonTexts([
        localResult.block_reason || '这条内容不能直接变成新的正式记录。'
      ].concat(localReasons))
    });
  }

  if (clearNoRecord.eligible) {
    return withRouteAudit({
      decision: ROUTE_NO_RECORD,
      deep_review_available: false,
      final_disposition: ROUTE_NO_RECORD,
      label: ROUTE_LABELS[ROUTE_NO_RECORD],
      reason_codes: clearNoRecordCanonicalReasonCodes,
      reasons: ['没有业务Evidence，不调用AI，也不生成正式或待整理记录。'],
      semantic_decision: ROUTE_NO_RECORD
    });
  }

  if (safety.status === 'NO_RECORD') {
    return withRouteAudit({
      decision: ROUTE_PENDING,
      label: ROUTE_LABELS[ROUTE_PENDING],
      reasons: uniqueReasonTexts(
        ['存在未完成或未归零的业务Evidence，不能直接丢弃。']
          .concat(clearNoRecord.exclusions, localReasons)
      )
    });
  }

  if (questionCandidate) {
    return withRouteAudit({
      activeQuestion: questionCandidate,
      decision: ROUTE_ASK_USER,
      deep_review_available: false,
      label: '需要你确认一项信息',
      questionCandidate,
      reason_codes: questionCandidate.riskIds,
      reasons: [questionCandidate.prompt]
    });
  }

  if (voiceStandardReview.eligible) {
    return withRouteAudit({
      decision: ROUTE_AI_STANDARD,
      label: ROUTE_LABELS[ROUTE_AI_STANDARD],
      reason_codes: voiceStandardReview.reasonCodes,
      reasons: ['语音终稿和关键业务字段均已核验；本地业务类型未决，本次请AI标准核对一次。']
    });
  }

  if (clientFactGate.ambiguousOwnership || clientFactGate.missingTargets.length > 0) {
    return withRouteAudit({
      decision: ROUTE_SAFE_BLOCKED,
      deep_review_available: false,
      label: clientFactGate.ambiguousOwnership
        ? '商品事实无法可靠对应'
        : '缺少可用于提问的商品事实',
      reason_codes: clientFactGate.ambiguousOwnership
        ? ['CLIENT_ITEM_FACT_OWNERSHIP_AMBIGUOUS']
        : clientFactGate.missingTargets.map((target) => `CLIENT_SOURCE_FACT_MISSING|${target.fieldPath}`),
      reasons: uniqueReasonTexts(clientFactGate.ambiguousOwnership
        ? ['原话中的数量或价格无法可靠对应到具体商品，不能让 AI 猜。']
        : ['商品缺少可信原文、历史或人工确认依据，不能让 AI 补造。'])
    });
  }

  if (hasMissingCriticalFact
    && !hasFinancialRisk
    && !hasConversationRisk
    && !hasHistoryReference
    && !quotationConversionDeepReview.eligible) {
    return withRouteAudit({
      decision: ROUTE_SAFE_BLOCKED,
      deep_review_available: false,
      label: '缺少可用于提问的关键事实',
      reasons: uniqueReasonTexts(['原话缺少关键信息，当前不能安全整理。'].concat(localReasons))
    });
  }

  if (safeLocalReceivable.eligible) {
    return withRouteAudit({
      decision: ROUTE_LOCAL,
      label: ROUTE_LABELS[ROUTE_LOCAL],
      reasons: ['待收款客户、金额和原文证据明确；关系选择和正式保存仍由确认卡与安全检查决定。']
    });
  }

  if (hasProductSuggestion && (!hasDeepRisk || canConfirmProductAndUnitLocally)) {
    return withRouteAudit({
      decision: ROUTE_LOCAL,
      label: ROUTE_LABELS[ROUTE_LOCAL],
      reasons: [canConfirmProductAndUnitLocally
        ? '商品名称和计价单位都可在确认卡直接核对；系统不猜单位换算，也不额外等待 AI。'
        : '商品名称已有明确确认建议，点选或手改后再保存，不让 AI 替你猜。']
    });
  }

  // 原文明确缺少关键事实时，AI 也不能凭空补造客户、商品或金额。
  // 这类内容不浪费等待时间，直接让老板补充或放待整理；但历史、改价和账款等复杂情况仍交给深度 AI。
  if (safety.status === 'NEEDS_USER_CONFIRM' && !hasDeepRisk) {
    if (hasCompleteButUnverifiedEvidence) {
      return withRouteAudit({
        decision: ROUTE_AI_STANDARD,
        label: ROUTE_LABELS[ROUTE_AI_STANDARD],
        reasons: uniqueReasonTexts(['本地已经整理出字段，但有一项不能直接从原话核对。'].concat(localReasons))
      });
    }
    return withRouteAudit({
      decision: ROUTE_PENDING,
      label: '待补充后再保存',
      reasons: uniqueReasonTexts(['原文缺少关键信息，不能让 AI 替老板猜。'].concat(localReasons))
    });
  }

  if (hasDeepRisk || (localResult.intent === 'unknown' && safety.status !== 'SAFE_LOCAL')) {
    const reasons = [];
    if (hasFinancialRisk) reasons.push('涉及收款、欠款或定金，必须谨慎核对。');
    if (hasConversationRisk) reasons.push('这是一段多轮聊天，需要理解前后顺序。');
    if (items.length > 1) reasons.push('包含多个商品，需要逐项整理。');
    if (conflicts.length) reasons.push('内容前后有冲突，不能自动选一个答案。');
    if (policy !== 'none') reasons.push('涉及历史记录或关联旧单。');
    if (hasSemanticDeepRisk) reasons.push('出现改价、最终确认、特殊要求等复杂说法。');
    if (quotationConversionDeepReview.eligible) {
      reasons.push('明确要求把所指报价转成订单，但具体报价仍需核对。');
    }
    if (localResult.intent === 'unknown') reasons.push('本地没有稳定判断出业务类型。');
    return withRouteAudit({
      decision: ROUTE_AI_DEEP,
      deep_review_available: false,
      label: ROUTE_LABELS[ROUTE_AI_DEEP],
      reasons: uniqueReasonTexts(reasons.concat(localReasons))
    });
  }

  if (safety.status === 'NEEDS_AI' || shouldForceAi(payload, localResult)) {
    const reasons = [];
    if (safety.status === 'NEEDS_AI') reasons.push('本地发现有不稳定字段。');
    return withRouteAudit({
      decision: ROUTE_AI_STANDARD,
      label: ROUTE_LABELS[ROUTE_AI_STANDARD],
      reasons: uniqueReasonTexts(reasons.concat(localReasons))
    });
  }

  return withRouteAudit({
    decision: ROUTE_LOCAL,
    label: ROUTE_LABELS[ROUTE_LOCAL],
    reasons: ['文字是一件清楚的业务，本次先按本地规则整理。']
  });
}

function getBusinessDraftSummary(result = {}) {
  const fields = result.fields || {};
  const items = Array.isArray(fields.items) ? fields.items.filter(Boolean) : [];
  return {
    intent: result.intent || 'unknown',
    customerName: fields.customerName || '',
    productName: fields.productName || '',
    quantity: fields.quantity || '',
    unitPrice: fields.unitPrice || '',
    amount: fields.amount || '',
    paymentAmount: fields.paymentAmount || fields.depositAmount || '',
    dueDate: fields.dueDate || '',
    itemCount: items.length || (fields.productName ? 1 : 0)
  };
}

function getAiDraftSummary(aiResult = {}) {
  const normalized = unwrapAiResult(aiResult);
  const fields = normalizeFields(normalized.fields || normalized);
  return getBusinessDraftSummary({
    intent: validIntents.includes(normalized.intent) ? normalized.intent : 'unknown',
    fields
  });
}

function attachParseTrace(result = {}, route = {}, timing = {}) {
  const previous = result.parse_trace || {};
  const localDraft = timing.localDraft || previous.localDraft || getBusinessDraftSummary(result);
  const finalDraft = timing.finalDraft || getBusinessDraftSummary(result);
  return Object.assign({}, result, {
    parse_route: route.decision ? route : (result.parse_route || previous.route || {}),
    parse_trace: {
      route: route.decision ? route : (previous.route || result.parse_route || {}),
      localDurationMs: Number(timing.localDurationMs !== undefined ? timing.localDurationMs : previous.localDurationMs || 0),
      aiDurationMs: Number(timing.aiDurationMs !== undefined ? timing.aiDurationMs : previous.aiDurationMs || 0),
      totalDurationMs: Number(timing.totalDurationMs !== undefined ? timing.totalDurationMs : previous.totalDurationMs || 0),
      networkWaitLimitMs: Number(timing.networkWaitLimitMs !== undefined ? timing.networkWaitLimitMs : previous.networkWaitLimitMs || 0),
      aiRequestId: timing.aiRequestId !== undefined ? timing.aiRequestId : (previous.aiRequestId || ''),
      aiServerElapsedMs: Number(timing.aiServerElapsedMs !== undefined ? timing.aiServerElapsedMs : previous.aiServerElapsedMs || 0),
      aiServerDeadlineMs: Number(timing.aiServerDeadlineMs !== undefined ? timing.aiServerDeadlineMs : previous.aiServerDeadlineMs || 0),
      aiModelTier: timing.aiModelTier !== undefined ? timing.aiModelTier : (previous.aiModelTier || ''),
      aiFailureCode: timing.aiFailureCode !== undefined ? timing.aiFailureCode : (previous.aiFailureCode || ''),
      localDraft,
      aiDraft: timing.aiDraft !== undefined ? timing.aiDraft : (previous.aiDraft || null),
      finalDraft
    }
  });
}

function getAiWaitLimitMs(route = {}) {
  return route.decision === ROUTE_AI_DEEP ? AI_DEEP_WAIT_LIMIT_MS : AI_STANDARD_WAIT_LIMIT_MS;
}

function requestWithDeadline(request, timeoutMs) {
  const waitMs = Number(timeoutMs);
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    const error = new Error('AI total wait limit reached');
    error.code = 'AI_TOTAL_TIMEOUT';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('AI total wait limit reached');
      error.code = 'AI_TOTAL_TIMEOUT';
      reject(error);
    }, waitMs);
    Promise.resolve(request)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function getByPath(source, path) {
  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return current[key];
  }, source);
}

function pickFirst(source, paths) {
  for (let i = 0; i < paths.length; i += 1) {
    const value = getByPath(source, paths[i]);
    if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') return value;
  }
  return '';
}

function normalizeAiItem(item = {}, options = {}) {
  if (!item || typeof item !== 'object') return null;
  const quantity = pickFirst(item, ['quantity', 'qty', 'product.quantity', 'item.quantity']);
  const unitPrice = pickFirst(item, ['unitPrice', 'unit_price', 'price.unitPrice', 'price.unit_price', 'price.perUnit', 'price.per_unit', 'unitAmount']);
  const mapped = {
    productName: pickFirst(item, ['productName', 'product_name', 'product.name', 'product', 'itemName', 'item_name', 'item.name', 'goodsName', 'goods_name', 'name']),
    spec: pickFirst(item, ['spec', 'specification', 'product.spec', 'product.specification']),
    quantity,
    unit: normalizeUnit(pickFirst(item, ['unit', 'product.unit', 'item.unit'])),
    unitPrice,
    priceUnit: normalizeUnit(pickFirst(item, ['priceUnit', 'price_unit', 'unitPriceUnit', 'unit_price_unit', 'price.unit', 'price.perUnitName'])),
    totalAmount: pickFirst(item, ['totalAmount', 'total_amount', 'amount', 'price.amount', 'price.totalAmount']),
    itemDeliveryDate: normalizeDateValue(
      pickFirst(item, ['itemDeliveryDate', 'item_delivery_date', 'deliveryDate', 'delivery_date', 'dueDate', 'due_date']),
      options
    ),
    itemRemark: pickFirst(item, ['itemRemark', 'item_remark', 'remark', 'note', 'memo'])
  };
  if (!mapped.totalAmount && quantity && unitPrice) mapped.totalAmount = calculateAmount(quantity, unitPrice, mapped.unit, mapped.priceUnit);
  const compact = {};
  Object.keys(mapped).forEach((key) => {
    if (mapped[key] !== undefined && mapped[key] !== null && mapped[key] !== '') compact[key] = mapped[key];
  });
  return compact.productName || compact.quantity || compact.unitPrice || compact.totalAmount ? compact : null;
}

function normalizeAiItems(value, options = {}) {
  return (Array.isArray(value) ? value : [])
    .map((item) => normalizeAiItem(item, options))
    .filter(Boolean);
}

function getItemsTotal(items = []) {
  if (!items.length || items.some((item) => !item.totalAmount)) return '';
  const total = items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  return toCleanNumber(total);
}

function normalizeDateValue(value, options = {}) {
  if (!value) return '';
  const source = String(value).trim();
  const numeric = source.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (numeric) {
    const year = Number(numeric[1]);
    const month = Number(numeric[2]);
    const day = Number(numeric[3]);
    return isValidCalendarDate(year, month, day)
      ? formatDate(new Date(year, month - 1, day))
      : '';
  }
  const parsed = parseChineseDate(source, options.businessDate || undefined);
  return parsed || source;
}

function normalizeFields(fields = {}, options = {}) {
  const items = normalizeAiItems(
    fields.items || fields.lineItems || fields.line_items || fields.products || fields.goods,
    options
  );
  const mapped = {
    customerId: pickFirst(fields, ['customerId', 'customer_id', 'customer.id', 'client.id']),
    customerName: pickFirst(fields, ['customerName', 'customer_name', 'customer.name', 'customer', 'clientName', 'client_name', 'client.name']),
    phone: pickFirst(fields, ['phone', 'mobile', 'customer.phone', 'client.phone']),
    company: pickFirst(fields, ['company', 'customer.company', 'client.company']),
    region: pickFirst(fields, ['region', 'customer.region', 'client.region']),
    todoTitle: pickFirst(fields, ['todoTitle', 'todo_title', 'taskTitle', 'task_title', 'reminderTitle', 'reminder_title', 'title']),
    followupDays: pickFirst(fields, ['followupDays', 'followup_days', 'followUpDays', 'follow_up_days']),
    productName: pickFirst(fields, ['productName', 'product_name', 'product.name', 'product', 'itemName', 'item_name', 'item.name', 'goodsName', 'goods_name']),
    spec: pickFirst(fields, ['spec', 'specification', 'product.spec', 'product.specification']),
    quantity: pickFirst(fields, ['quantity', 'qty', 'product.quantity', 'item.quantity']),
    unit: normalizeUnit(pickFirst(fields, ['unit', 'product.unit', 'item.unit'])),
    unitPrice: pickFirst(fields, ['unitPrice', 'unit_price', 'price.unitPrice', 'price.unit_price', 'price.perUnit', 'price.per_unit', 'unitAmount']),
    priceUnit: normalizeUnit(pickFirst(fields, ['priceUnit', 'price_unit', 'unitPriceUnit', 'unit_price_unit', 'price.unit', 'price.perUnitName'])),
    paymentAmount: pickFirst(fields, ['paymentAmount', 'payment_amount', 'paidAmount', 'paid_amount', 'receivedAmount', 'received_amount', 'collectionAmount', 'collection_amount', 'payment.amount']),
    depositAmount: pickFirst(fields, ['depositAmount', 'deposit_amount', 'deposit', 'deposit.amount', 'advanceAmount', 'advance_amount', 'prepaidAmount', 'prepaid_amount']),
    amount: pickFirst(fields, ['amount', 'totalAmount', 'total_amount', 'totalPrice', 'total_price', 'price.amount', 'price.totalAmount', 'money.amount', 'receivable.amount', 'payment.amount']),
    totalAmount: pickFirst(fields, ['totalAmount', 'total_amount', 'totalPrice', 'total_price', 'price.totalAmount']),
    statedAmount: pickFirst(fields, ['statedAmount', 'stated_amount', 'spokenAmount', 'spoken_amount', 'explicitAmount', 'explicit_amount']),
    calculatedAmount: pickFirst(fields, ['calculatedAmount', 'calculated_amount', 'computedAmount', 'computed_amount']),
    remainingAmount: pickFirst(fields, ['remainingAmount', 'remaining_amount', 'leftAmount', 'left_amount', 'unpaidAmount', 'unpaid_amount', 'balance', 'balanceAmount', 'balance_amount', 'payment.remainingAmount']),
    paymentMethod: pickFirst(fields, ['paymentMethod', 'payment_method', 'payment.method']),
    paymentKind: pickFirst(fields, ['paymentKind', 'payment_kind', 'kind', 'payment.kind']),
    dueDate: normalizeDateValue(
      pickFirst(fields, ['dueDate', 'due_date', 'remindDate', 'remind_date', 'reminderDate', 'reminder_date', 'deliveryDate', 'delivery_date', 'requiredDeliveryDate', 'required_delivery_date', 'date.dueDate', 'date.remindDate', 'date.deliveryDate']),
      options
    ),
    quoteDate: normalizeDateValue(pickFirst(fields, ['quoteDate', 'quote_date', 'date.quoteDate']), options),
    orderId: pickFirst(fields, ['orderId', 'order_id', 'order.id']),
    quotationId: pickFirst(fields, ['quotationId', 'quotation_id', 'quotation.id']),
    remark: pickFirst(fields, ['remark', 'note', 'memo'])
  };
  if (items.length) {
    const first = items[0] || {};
    const itemsTotal = getItemsTotal(items);
    mapped.items = items;
    mapped.productName = mapped.productName || first.productName || '';
    mapped.spec = mapped.spec || first.spec || '';
    mapped.quantity = mapped.quantity || first.quantity || '';
    mapped.unit = mapped.unit || first.unit || '';
    mapped.unitPrice = mapped.unitPrice || first.unitPrice || '';
    mapped.priceUnit = mapped.priceUnit || first.priceUnit || '';
    mapped.amount = mapped.amount || itemsTotal || first.totalAmount || '';
    mapped.totalAmount = mapped.totalAmount || itemsTotal || mapped.amount || '';
  }
  const compact = {};
  Object.keys(mapped).forEach((key) => {
    if (mapped[key] !== undefined && mapped[key] !== null && mapped[key] !== '') compact[key] = mapped[key];
  });
  return compact;
}

function compactBusinessContext(state = {}) {
  const customers = state.customers || [];
  const customerNameById = customers.reduce((map, customer) => {
    if (customer && customer.id) map[customer.id] = customer.name || '';
    return map;
  }, {});
  const recentCustomers = customers.slice(0, 30).map((customer) => ({
    id: customer.id,
    name: customer.name,
    company: customer.company || '',
    region: customer.region || '',
    lastTradeAt: customer.lastTradeAt || ''
  }));
  const recentQuotations = (state.quotations || []).slice(0, 30).map((quotation) => ({
    id: quotation.id,
    customerId: quotation.customerId,
    customerName: customerNameById[quotation.customerId] || '',
    productName: quotation.productName || '',
    spec: quotation.spec || '',
    quantity: quotation.quantity || '',
    unit: quotation.unit || '',
    unitPrice: quotation.unitPrice || '',
    priceUnit: quotation.priceUnit || '',
    items: (quotation.items || []).map((item) => Object.assign({}, item)),
    totalAmount: quotation.totalAmount || '',
    deliveryDate: quotation.deliveryDate || '',
    quoteDate: quotation.quoteDate || '',
    status: quotation.status || ''
  }));
  const recentOrders = (state.orders || []).slice(0, 30).map((order) => ({
    id: order.id,
    customerId: order.customerId,
    customerName: customerNameById[order.customerId] || '',
    productName: order.productName || '',
    spec: order.spec || '',
    quantity: order.quantity || '',
    unit: order.unit || '',
    unitPrice: order.unitPrice || '',
    priceUnit: order.priceUnit || '',
    items: (order.items || []).map((item) => Object.assign({}, item)),
    totalAmount: order.totalAmount || '',
    requiredDeliveryDate: order.requiredDeliveryDate || '',
    status: order.status || ''
  }));
  const recentReceivables = (state.receivables || []).slice(0, 30).map((receivable) => ({
    id: receivable.id,
    customerId: receivable.customerId,
    customerName: customerNameById[receivable.customerId] || '',
    orderId: receivable.orderId || '',
    amount: receivable.amount || '',
    paidAmount: receivable.paidAmount || '',
    dueDate: receivable.dueDate || '',
    status: receivable.status || ''
  }));
  const recentPaymentRecords = (state.paymentRecords || []).slice(0, 30).map((payment) => ({
    id: payment.id,
    customerId: payment.customerId,
    customerName: customerNameById[payment.customerId] || '',
    orderId: payment.orderId || '',
    receivableId: payment.receivableId || '',
    kind: payment.kind || payment.paymentKind || '',
    amount: payment.amount || '',
    paidAt: payment.paidAt || '',
    remark: payment.remark || ''
  }));
  return {
    recentCustomers,
    recentQuotations,
    recentOrders,
    recentReceivables,
    recentPaymentRecords
  };
}

function getContextPolicy(text, localResult = {}) {
  const source = String(text || localResult.original_text || '');
  const intent = localResult.intent || 'unknown';
  const fields = localResult.fields || {};
  const hasLineItems = Array.isArray(fields.items) && fields.items.length > 0;
  const hasNewOrderProductInfo = Boolean(fields.productName && (fields.quantity || fields.unitPrice || fields.dueDate || fields.totalAmount || fields.amount));
  const isNewOrderWithDeposit = /定金|订金|预付|预付款/.test(source)
    && intent === 'order'
    && (hasLineItems || hasNewOrderProductInfo);
  if (/改|改成|延期|提前|那单|那笔|上次那笔|改价|改数量/.test(source)) return 'record_update';
  if (
    intent === 'receivable'
    && /应收|待收|尚欠|还欠|欠款|还差|余款|剩余款|尾款|货款|记账|月结|月底结|月底给|未结清应收|未收|没收/.test(source)
    && !/还我|还了|刚?转了|到账|付了|付款|收了|已收|先打|结清了|已结清/.test(source)
  ) {
    return 'none';
  }
  if (isNewOrderWithDeposit) return 'none';
  if (/定金|订金|预付|预付款/.test(source) && (intent === 'payment' || fields.paymentKind === 'deposit' || fields.depositAmount)) return 'order_deposit';
  if (intent === 'payment' || /还我|还了|还剩|剩下|剩余|结清|到账|转了|付了|收了|未收|没收/.test(source)) return 'receivable_history';

  const needsHistoryPrice = /上次|上图|原价|还是|按上次|按原来|照旧|老价/.test(source);
  const repeatOrder = /补|返单|再来|追加/.test(source);
  const quoteOrOrder = ['quotation', 'order'].includes(intent);
  if (quoteOrOrder && (needsHistoryPrice || (repeatOrder && (!fields.unitPrice || !fields.dueDate || !fields.productName)))) {
    return 'customer_history';
  }
  return 'none';
}

function getAiParseEndpoint() {
  if (typeof getApp !== 'function') return '/api/ai/parse';
  const app = getApp();
  const globalData = app && app.globalData ? app.globalData : {};
  return globalData.aiParseEndpoint || '/api/ai/parse';
}

function originalContainsName(originalText, name) {
  const source = String(originalText || '');
  const current = String(name || '');
  if (!source || !current) return false;
  const compactName = current.replace(/总$/, '');
  return source.includes(current) || (compactName.length >= 2 && source.includes(compactName));
}

function isGenericBossAddress(name) {
  return /^老板(?:今|明|昨|后|早|晚|今天|明天|后天|大后天)?$/.test(String(name || '').trim());
}

function isCustomerNameSupportedBySource(originalText, name) {
  const source = String(originalText || '');
  const current = String(name || '').trim();
  if (!current || isGenericBossAddress(current) || !originalContainsName(source, current)) return false;
  if (/(?:总|老板|经理|姐|哥|先生|女士)$/.test(current)) return true;
  if (/^老(?!板)[\u4e00-\u9fa5]{1,2}$/.test(current)) return true;

  // 没有称呼后缀的名字，只有在原文中紧跟业务动作时才保留，避免“老板今天”被截成名字。
  const index = source.indexOf(current);
  const after = index >= 0 ? source.slice(index + current.length) : '';
  return /^(?:那边|这边|说|问|欠|付|转|打款|到账|返单|补|做|收|尾款|货款|下单|下|要|订|定|买|拿|报)/.test(after);
}

function localCustomerHasFieldIssue(localResult = {}) {
  const safety = localResult.local_parse_safety || {};
  const validations = safety.field_validations || {};
  const invalid = toArray(validations.invalid_fields || []);
  const low = uniqueStrings(localResult.low_confidence_fields || []);
  const conflicts = toArray(localResult.field_conflicts || []).map((item) => (item && item.field) || item);
  return invalid.includes('customerName') || low.includes('customerName') || conflicts.includes('customerName');
}

function canProtectLocalCustomer(localResult = {}) {
  const fields = localResult.fields || {};
  return Boolean(
    fields.customerName
    && !localCustomerHasFieldIssue(localResult)
    && isCustomerNameSupportedBySource(localResult.original_text || '', fields.customerName)
  );
}

function extractMentionedCustomerName(text, localResult = {}) {
  const source = String(text || localResult.original_text || '');
  const localName = localResult.fields && localResult.fields.customerName;
  if (localName && isCustomerNameSupportedBySource(source, localName)) return localName;
  const direct = source.match(/([\u4e00-\u9fa5A-Za-z]{1,8}(?:总|老板|经理|姐|哥|先生|女士))/);
  if (direct && isCustomerNameSupportedBySource(source, direct[1])) return direct[1];
  const oldName = source.match(/(老(?!板)[\u4e00-\u9fa5]{1,2})/);
  return oldName && isCustomerNameSupportedBySource(source, oldName[1]) ? oldName[1] : '';
}

function customerMatchesMention(customer, mentionedName) {
  if (!customer || !mentionedName) return false;
  const customerName = String(customer.name || '');
  const source = String(mentionedName || '');
  const customerCompact = customerName.replace(/总$/, '');
  const sourceCompact = source.replace(/总$/, '');
  return customerName === source
    || customerName.includes(source)
    || source.includes(customerName)
    || (customerCompact.length >= 2 && source.includes(customerCompact))
    || (sourceCompact.length >= 2 && customerName.includes(sourceCompact));
}

function mapCustomerNameById(customers) {
  return (customers || []).reduce((map, customer) => {
    if (customer && customer.id) map[customer.id] = customer.name || '';
    return map;
  }, {});
}

function formatScopedCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    company: customer.company || '',
    region: customer.region || '',
    lastTradeAt: customer.lastTradeAt || ''
  };
}

function findScopedHistory(state = {}, mentionedCustomerName, policy) {
  const customers = state.customers || [];
  const matchedCustomers = customers.filter((customer) => customerMatchesMention(customer, mentionedCustomerName));
  const matchedCustomerIds = matchedCustomers.map((customer) => customer.id).filter(Boolean);
  const customerIdSet = matchedCustomerIds.reduce((set, id) => {
    set[id] = true;
    return set;
  }, {});
  const customerNameById = mapCustomerNameById(customers);

  const scopedQuotations = (state.quotations || [])
    .filter((quotation) => customerIdSet[quotation.customerId])
    .slice(0, 20)
    .map((quotation) => ({
      id: quotation.id,
      customerId: quotation.customerId,
      customerName: customerNameById[quotation.customerId] || '',
      productName: quotation.productName || '',
      spec: quotation.spec || '',
      quantity: quotation.quantity || '',
      unit: quotation.unit || '',
      unitPrice: quotation.unitPrice || '',
      priceUnit: quotation.priceUnit || '',
      items: (quotation.items || []).map((item) => Object.assign({}, item)),
      totalAmount: quotation.totalAmount || '',
      deliveryDate: quotation.deliveryDate || '',
      quoteDate: quotation.quoteDate || '',
      status: quotation.status || ''
    }));
  const scopedOrders = (state.orders || [])
    .filter((order) => customerIdSet[order.customerId])
    .slice(0, 20)
    .map((order) => ({
      id: order.id,
      customerId: order.customerId,
      customerName: customerNameById[order.customerId] || '',
      productName: order.productName || '',
      spec: order.spec || '',
      quantity: order.quantity || '',
      unit: order.unit || '',
      unitPrice: order.unitPrice || '',
      priceUnit: order.priceUnit || '',
      items: (order.items || []).map((item) => Object.assign({}, item)),
      totalAmount: order.totalAmount || '',
      requiredDeliveryDate: order.requiredDeliveryDate || '',
      orderDate: order.orderDate || '',
      status: order.status || ''
    }));
  const scopedReceivables = (state.receivables || [])
    .filter((receivable) => customerIdSet[receivable.customerId])
    .filter((receivable) => policy !== 'receivable_history' || activeReceivableStatuses.includes(receivable.status))
    .slice(0, 20)
    .map((receivable) => ({
      id: receivable.id,
      customerId: receivable.customerId,
      customerName: customerNameById[receivable.customerId] || '',
      orderId: receivable.orderId || '',
      amount: receivable.amount || '',
      paidAmount: receivable.paidAmount || '',
      dueDate: receivable.dueDate || '',
      status: receivable.status || ''
    }));
  const scopedPaymentRecords = (state.paymentRecords || [])
    .filter((payment) => customerIdSet[payment.customerId])
    .slice(0, 20)
    .map((payment) => ({
      id: payment.id,
      customerId: payment.customerId,
      orderId: payment.orderId || '',
      receivableId: payment.receivableId || '',
      kind: payment.kind || payment.paymentKind || '',
      amount: payment.amount || '',
      paidAt: payment.paidAt || '',
      remark: payment.remark || ''
    }));

  const found = policy === 'customer_history'
    ? Boolean(scopedQuotations.length || scopedOrders.length)
    : (policy === 'receivable_history'
      ? Boolean(scopedReceivables.length)
      : (policy === 'order_deposit'
        ? Boolean(scopedOrders.length)
        : (policy === 'record_update' ? Boolean(scopedQuotations.length || scopedOrders.length) : false)));

  return {
    mentionedCustomerName,
    customers: matchedCustomers.map(formatScopedCustomer),
    businessContext: found ? {
      recentCustomers: matchedCustomers.map(formatScopedCustomer),
      recentQuotations: scopedQuotations,
      recentOrders: scopedOrders,
      recentReceivables: scopedReceivables,
      recentPaymentRecords: scopedPaymentRecords
    } : {},
    found
  };
}

function buildHistoryWarning(policy, scopedHistory, localResult = {}) {
  if (policy === 'none' || scopedHistory.found) return '';
  const name = scopedHistory.mentionedCustomerName || '这个客户';
  const fields = localResult.fields || {};
  if (policy === 'customer_history') {
    return `没有找到${name}的历史订单/报价，已按新订单草稿处理。请补齐单价、交期等信息后再确认。`;
  }
  if (policy === 'receivable_history') {
    const paymentAmount = Number(fields.paymentAmount || 0);
    const remainingAmount = Number(fields.remainingAmount || 0);
    if (paymentAmount > 0 && remainingAmount > 0) {
      return `没有找到${name}未结清应收。可新建一笔应收总额${paymentAmount + remainingAmount}元，并记录已收${paymentAmount}元。`;
    }
    return `没有找到${name}未结清应收。请确认是新建应收并记录收款，还是先存到待整理。`;
  }
  if (policy === 'order_deposit') {
    return `没有找到${name}可关联的进行中订单。定金不能直接生成应收，建议先存到待整理或补充是哪一单。`;
  }
  return `没有找到${name}可匹配的历史订单/报价，请补充更多信息或先存到待整理。`;
}

function getSuggestedOperation(policy, scopedHistory) {
  if (policy === 'customer_history' && !scopedHistory.found) return 'create_order';
  if (policy === 'receivable_history' && !scopedHistory.found) return 'create_receivable_with_payment';
  if (policy === 'order_deposit') return scopedHistory.found ? 'record_order_deposit' : 'pending';
  if (policy === 'record_update' && !scopedHistory.found) return 'pending';
  return '';
}

function attachHistoryInfo(localResult, policy, scopedHistory) {
  const historyStatus = policy === 'none' ? 'not_required' : (scopedHistory.found ? 'found' : 'not_found');
  return applyCustomerHistoryDefaults(Object.assign({}, localResult, {
    context_policy: policy,
    history_status: historyStatus,
    history_warning_text: buildHistoryWarning(policy, scopedHistory, localResult),
    suggested_operation: getSuggestedOperation(policy, scopedHistory)
  }), policy, scopedHistory);
}

function buildAiRequestPayload(payload, localResult, scopedHistory) {
  const requestPayload = {
    text: payload.text,
    source: payload.source,
    reviewMode: payload.reviewMode === 'deep' ? 'deep' : 'standard',
    context: payload.context,
    rawText: payload.rawText || (localResult && localResult.original_text) || '',
    extractedText: payload.extractedText || payload.text || '',
    rawMessages: getPayloadRawMessages(payload),
    pasteMeta: payload.pasteMeta || null,
    requestId: payload.requestId || '',
    originalTextFingerprint: payload.originalTextFingerprint || '',
    draftRevision: payload.draftRevision === undefined ? '' : payload.draftRevision,
    confirmationSessionId: payload.confirmationSessionId || '',
    requestedRoute: payload.requestedRoute || '',
    route: payload.requestedRoute || '',
    businessTimezone: payload.businessTimezone || 'Asia/Shanghai'
  };
  if (localResult) {
    requestPayload.localDraft = {
      intent: localResult.intent || 'unknown',
      operation: localResult.operation || '',
      fields: localResult.fields || {},
      missing_fields: localResult.missing_fields || [],
      low_confidence_fields: localResult.low_confidence_fields || [],
      field_conflicts: localResult.field_conflicts || [],
      remark_items: localResult.remark_items || [],
      field_sources: localResult.field_sources || {},
      local_parse_safety: localResult.local_parse_safety || null,
      unsafe_reasons: localResult.unsafe_reasons || []
    };
    requestPayload.routeDecision = localResult.parse_route || null;
  }
  // Legacy pages do not provide Phase 1B's explicit businessDate. Omitting the
  // field lets the server derive today's date in Asia/Shanghai; sending an empty
  // string would incorrectly turn a compatible legacy request into a 400.
  if (payload.businessDate) requestPayload.businessDate = payload.businessDate;
  if (payload.nowInstant) requestPayload.nowInstant = payload.nowInstant;
  if (localResult && localResult.history_status === 'found') {
    requestPayload.customerCandidates = scopedHistory.customers;
    requestPayload.businessContext = scopedHistory.businessContext;
  } else if (!localResult && scopedHistory) {
    if (Array.isArray(scopedHistory.customers) && scopedHistory.customers.length) {
      requestPayload.customerCandidates = scopedHistory.customers;
    }
    if (scopedHistory.businessContext && Object.keys(scopedHistory.businessContext).length) {
      requestPayload.businessContext = scopedHistory.businessContext;
    }
  }
  return requestPayload;
}

function hasFieldValue(fields, field) {
  return fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function toCleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function calculateAmount(quantity, unitPrice, quantityUnit = '', priceUnit = '') {
  if (!quantity || !unitPrice) return '';
  if (!unitsMatch(quantityUnit, priceUnit)) return '';
  const quantityNumber = Number(quantity);
  const unitPriceNumber = Number(unitPrice);
  if (!Number.isFinite(quantityNumber) || !Number.isFinite(unitPriceNumber)) return '';
  return toCleanNumber(quantityNumber * unitPriceNumber);
}

function normalizeProductText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function productMatches(inputProduct, historyProduct) {
  const input = normalizeProductText(inputProduct);
  const history = normalizeProductText(historyProduct);
  if (!input || !history) return false;
  return input === history || input.includes(history) || history.includes(input);
}

function getHistoryRecordDate(record) {
  return record.orderDate || record.quoteDate || record.createdAt || record.requiredDeliveryDate || record.deliveryDate || '';
}

function byRecentRecord(left, right) {
  return String(getHistoryRecordDate(right)).localeCompare(String(getHistoryRecordDate(left)));
}

function getHistoryRecords(scopedHistory, productName) {
  const businessContext = scopedHistory.businessContext || {};
  const orders = (businessContext.recentOrders || [])
    .filter((order) => productMatches(productName, order.productName))
    .map((order) => Object.assign({ historyType: 'order' }, order));
  const quotations = (businessContext.recentQuotations || [])
    .filter((quotation) => productMatches(productName, quotation.productName))
    .map((quotation) => Object.assign({ historyType: 'quotation' }, quotation));
  return {
    orders: orders.sort(byRecentRecord),
    priceRecords: orders.concat(quotations).filter((record) => hasFieldValue(record, 'unitPrice')).sort(byRecentRecord)
  };
}

function getHistorySource(record, field) {
  return `history:${record.historyType}:${record.id}:${field}`;
}

function buildHistoryDefaultWarning(fields, defaultedFields) {
  const parts = [];
  if (defaultedFields.includes('unitPrice')) parts.push(`单价 ${fields.unitPrice}`);
  if (defaultedFields.includes('dueDate')) parts.push(`交期 ${fields.dueDate}`);
  if (!parts.length) return '';
  const customerName = fields.customerName || '这个客户';
  const productName = fields.productName || '这个产品';
  return `已按${customerName}上次${productName}记录默认填入：${parts.join('、')}。请重点确认，不对可以直接修改。`;
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function cloneLocalRelationReferences(value) {
  const references = normalizeObject(value, null);
  if (!references) return null;
  const cloneReference = (reference) => ({
    entityType: String(reference.entityType || ''),
    kind: String(reference.kind || ''),
    explicit: reference.explicit === true,
    requiresResolution: reference.requiresResolution === true,
    sourceText: String(reference.sourceText || ''),
    sourceSpan: {
      start: Number(reference.sourceSpan && reference.sourceSpan.start),
      end: Number(reference.sourceSpan && reference.sourceSpan.end)
    },
    confidence: Number(reference.confidence),
    normalizedReference: String(reference.normalizedReference || ''),
    resolvedEntityId: reference.resolvedEntityId === null
      ? null
      : String(reference.resolvedEntityId || ''),
    evidenceSource: String(reference.evidenceSource || ''),
    sourceField: String(reference.sourceField || '')
  });
  const output = {};
  const order = normalizeObject(references.order, null);
  if (order) output.order = cloneReference(order);
  const quotation = getTrustedLocalUnresolvedQuotationReference(
    references.quotation
  );
  if (quotation) {
    output.quotation = cloneReference(quotation);
  }
  return Object.keys(output).length ? output : null;
}

function mergeRemarkItems(localItems, aiItems) {
  const source = [].concat(toArray(aiItems), toArray(localItems));
  const seen = {};
  return source.filter((item) => {
    const text = typeof item === 'string' ? item : String((item && item.text) || '').trim();
    if (!text || seen[text]) return false;
    seen[text] = true;
    return true;
  });
}

function hasExplicitQuotationSignal(source) {
  const text = String(source || '');
  return /报价|报架|报个价|报一下价|报下价|问价|要个价格|先报|一起报|报给客户/.test(text)
    || /给[^，,。；;\n]{1,16}报(?!销)/.test(text)
    || /报(?!销)[^，,。；;\n]{0,12}(?:\d|一|二|两|三|四|五|六|七|八|九|十|百|千|万|w|W)/.test(text);
}

function hasClearProductFields(fields = {}) {
  const items = Array.isArray(fields.items) ? fields.items : [];
  return items.some((item) => item && (item.productName || item.quantity || item.unitPrice))
    || Boolean(fields.productName && (fields.quantity || fields.unitPrice || fields.amount || fields.totalAmount));
}

function hasNoLocalFieldRisk(localResult) {
  return !toArray(localResult.missing_fields).length
    && !toArray(localResult.low_confidence_fields).length
    && !toArray(localResult.field_conflicts).length;
}

function shouldProtectLocalQuotationIntent(localResult) {
  if (!localResult || localResult.intent !== 'quotation') return false;
  const safety = localResult.local_parse_safety || {};
  const localIntentIsSafe = safety.status === 'SAFE_LOCAL'
    || (safety.status === 'NEEDS_AI' && hasNoLocalFieldRisk(localResult));
  if (!localIntentIsSafe) return false;
  const text = localResult.original_text || '';
  return hasExplicitQuotationSignal(text) && hasClearProductFields(localResult.fields || {});
}

function mergeAiIntent(localResult, normalized) {
  const aiIntent = validIntents.includes(normalized.intent) ? normalized.intent : '';
  if (aiIntent && !(shouldProtectLocalQuotationIntent(localResult) && aiIntent !== localResult.intent)) return aiIntent;
  return localResult.intent;
}

function getConflictFields(conflicts) {
  return toArray(conflicts)
    .map((item) => (typeof item === 'string' ? item : item && item.field))
    .filter(Boolean);
}

function normalizeIntentCandidates(value, fallbackIntent) {
  return uniqueStrings([].concat(toStringArray(value), fallbackIntent || []))
    .filter((intent) => validIntents.includes(intent) && intent !== 'unknown' && intent !== 'query');
}

function getAiIntentCandidates(normalized = {}, fallbackIntent = '') {
  return normalizeIntentCandidates(
    normalized.intent_candidates || normalized.intentCandidates,
    validIntents.includes(normalized.intent) ? normalized.intent : fallbackIntent
  );
}

function hasFieldEvidence(normalized = {}, field) {
  const evidence = normalizeObject(normalized.field_evidence || normalized.fieldEvidence, {});
  const value = evidence[field];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function hasExplicitConflictResolution(normalized = {}, field, aiIntentCandidates = []) {
  // "我已经解决了" 不是证据。只有给出“旧值被新值替代”的记录，且能指出
  // 原话来源，才允许深度 AI 清除本地已经发现的普通字段冲突。
  if (['customerName', 'intent', 'items'].includes(field) || aiIntentCandidates.length > 1) return false;
  const facts = toArray(normalized.superseded_facts || normalized.supersededFacts);
  return facts.some((item) => item && item.field === field && (item.newValue || item.new_value))
    && hasFieldEvidence(normalized, field);
}

function mergeConflictEntries(...groups) {
  const seen = {};
  return groups.flat().filter((item) => {
    const field = typeof item === 'string' ? item : (item && item.field);
    const values = item && typeof item === 'object' && Array.isArray(item.values) ? item.values.join('|') : '';
    const message = item && typeof item === 'object' ? String(item.message || '') : String(item || '');
    const itemKey = item && typeof item === 'object' ? String(item.itemKey || '') : '';
    const itemField = item && typeof item === 'object' ? String(item.itemField || '') : '';
    const fieldPath = item && typeof item === 'object' ? String(item.fieldPath || item.itemPath || '') : '';
    const code = item && typeof item === 'object' ? String(item.code || '') : '';
    const key = `${field || ''}|${itemKey}|${itemField}|${fieldPath}|${code}|${values}|${message}`;
    if (!field || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function getLocalHardSafety(localResult = {}, normalized = {}) {
  const localConflicts = toArray(localResult.field_conflicts || []);
  const aiIntentCandidates = getAiIntentCandidates(normalized, localResult.intent);
  const customerConflict = localConflicts.find((item) => item && item.field === 'customerName');
  const customerValues = customerConflict && Array.isArray(customerConflict.values)
    ? uniqueStrings(customerConflict.values)
    : [];
  const localRoute = localResult.parse_route || {};
  const localSafety = localResult.local_parse_safety || {};
  const hasSeveralCustomers = customerValues.length > 1;
  const hasSeveralIntents = aiIntentCandidates.length > 1;
  const localHasNoStableIntent = localResult.intent === 'unknown'
    && (localRoute.decision === ROUTE_PENDING || localSafety.status === 'NO_RECORD');

  return {
    aiIntentCandidates,
    hasSeveralCustomers,
    hasSeveralIntents,
    hasNoStableIntent: localHasNoStableIntent,
    needsBusinessSplit: hasSeveralCustomers || hasSeveralIntents,
    localConflicts
  };
}

function hasJoinedMultiItemValue(fields = {}) {
  return ['productName', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'amount', 'totalAmount']
    .some((field) => typeof fields[field] === 'string' && /[，,、；;]/.test(fields[field]));
}

const ITEM_FACT_FIELDS = [
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'totalAmount', 'itemDeliveryDate', 'itemRemark'
];
const ITEM_NUMERIC_FACT_FIELDS = ['quantity', 'unitPrice', 'totalAmount'];
const LEGACY_FIRST_ITEM_FIELDS = ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'];
const MANUAL_ITEM_FIELDS = ITEM_FACT_FIELDS.slice();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeManualItemFields(value, items = []) {
  if (!Array.isArray(value)) return [];
  const allowedKeys = new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item && item.confirmationItemKey || '').trim())
    .filter(Boolean));
  const seen = new Set();
  return value.reduce((output, entry) => {
    if (!isPlainObject(entry)) return output;
    const itemKey = String(entry.itemKey || '').trim();
    const field = String(entry.field || '').trim();
    if (!itemKey || !MANUAL_ITEM_FIELDS.includes(field)) return output;
    if (allowedKeys.size && !allowedKeys.has(itemKey)) return output;
    const key = `${itemKey}:${field}`;
    if (seen.has(key)) return output;
    seen.add(key);
    output.push({ itemKey, field });
    return output;
  }, []);
}

function normalizeManualFields(value) {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((entry) => typeof entry === 'string'))
      .filter((field) => !/^items(?:\[|\.|$)/.test(field))
    : [];
}

function getDuplicatedConfirmationItemKeys(items = []) {
  const counts = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const itemKey = String(item && item.confirmationItemKey || '').trim();
    if (itemKey) counts.set(itemKey, (counts.get(itemKey) || 0) + 1);
  });
  return new Set(Array.from(counts.entries())
    .filter((entry) => entry[1] > 1)
    .map((entry) => entry[0]));
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

function ensureConfirmationItemKey(item, origin, index, usedKeys) {
  const next = Object.assign({}, item);
  let key = String(next.confirmationItemKey || '').trim();
  if (!key || usedKeys.has(key)) {
    const identity = [origin, index, next.productName || '', next.spec || ''].join('|');
    const base = `mip_${origin}_${itemKeyHash(identity)}`;
    key = base;
    let suffix = 1;
    while (usedKeys.has(key)) {
      key = `${base}_${suffix}`;
      suffix += 1;
    }
  }
  usedKeys.add(key);
  next.confirmationItemKey = key;
  return next;
}

function normalizeItemIdentityText(value) {
  return normalizeProductText(value)
    .toLowerCase()
    .replace(/[，,、。；;：:（）()[\]【】《》"'“”‘’\-—_]/g, '');
}

function hasItemFactValue(item, field) {
  const value = item && item[field];
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
}

function itemFactValuesEqual(field, left, right) {
  if (ITEM_NUMERIC_FACT_FIELDS.includes(field)) {
    const leftNumber = parseChineseNumber(left);
    const rightNumber = parseChineseNumber(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return Math.abs(leftNumber - rightNumber) < 0.0001;
    }
  }
  if (['unit', 'priceUnit'].includes(field)) {
    return normalizeUnit(left) === normalizeUnit(right);
  }
  return normalizeItemIdentityText(left) === normalizeItemIdentityText(right);
}

function areItemIdentitiesCompatible(localItem = {}, aiItem = {}) {
  const localProduct = normalizeItemIdentityText(localItem.productName);
  const aiProduct = normalizeItemIdentityText(aiItem.productName);
  if (!localProduct || !aiProduct || localProduct !== aiProduct) return false;
  const localSpec = normalizeItemIdentityText(localItem.spec);
  const aiSpec = normalizeItemIdentityText(aiItem.spec);
  return !(localSpec && aiSpec && localSpec !== aiSpec);
}

function escapeItemEvidencePattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boundedNumberEvidencePattern(value) {
  const escaped = escapeItemEvidencePattern(value);
  return `(?:^|[^\\d.])${escaped}(?![\\d.])`;
}

function suffixedNumberEvidencePattern(value) {
  return `${escapeItemEvidencePattern(value)}(?![\\d.])`;
}

function itemEvidenceNumbersEqual(left, right) {
  const leftNumber = parseChineseNumber(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber)
    && Math.abs(leftNumber - rightNumber) < 0.0001;
}

function getEquivalentNumberEvidenceMatches(sourceText, value) {
  const source = String(sourceText || '');
  if (!source || !String(value || '').trim()) return [];
  return Array.from(source.matchAll(new RegExp(numberPattern(), 'g')))
    .filter((match) => itemEvidenceNumbersEqual(match[0], value));
}

function startsWithEquivalentQuantityEvidence(sourceText, quantity, unit) {
  const source = String(sourceText || '');
  const normalizedUnit = String(unit || '').trim();
  if (!source || !normalizedUnit) return false;
  return getEquivalentNumberEvidenceMatches(source, quantity).some((match) => (
    match.index === 0
    && new RegExp(`^\\s*${escapeItemEvidencePattern(normalizedUnit)}`).test(
      source.slice(match[0].length)
    )
  ));
}

function findPrefixedQuantityEvidenceStart(sourceText, productStart, quantity, unit) {
  const source = String(sourceText || '');
  const normalizedUnit = String(unit || '').trim();
  if (!source || productStart < 0 || !normalizedUnit) return -1;
  const match = getEquivalentNumberEvidenceMatches(source.slice(0, productStart), quantity)
    .find((candidate) => {
      const afterNumber = source.slice(candidate.index + candidate[0].length, productStart);
      return new RegExp(`^\\s*${escapeItemEvidencePattern(normalizedUnit)}\\s*$`).test(afterNumber);
    });
  return match ? match.index : -1;
}

function hasExactItemTextEvidence(sourceText, value, options = {}) {
  const source = String(sourceText || '');
  const target = String(value || '').trim();
  if (!source || !target) return false;
  const entityCharacter = /[A-Za-z0-9\u3400-\u9fff]/;
  const leftAdjacent = String(options.leftAdjacent || '').trim();
  const rightAdjacent = String(options.rightAdjacent || '').trim();
  const declaredQuantity = String(options.quantity || '').trim();
  const declaredUnit = String(options.unit || '').trim();
  const declaredUnitPrice = String(options.unitPrice || '').trim();
  const declaredPriceUnit = String(options.priceUnit || options.unit || '').trim();
  let cursor = 0;
  while (cursor <= source.length) {
    const index = source.indexOf(target, cursor);
    if (index < 0) return false;
    const leftContext = source.slice(0, index);
    const rightContext = source.slice(index + target.length);
    const compactLeft = leftContext.replace(/\s/g, '');
    const previous = source[index - 1] || '';
    const next = source[index + target.length] || '';
    const leftMatchesAdjacent = Boolean(leftAdjacent)
      && new RegExp(`${escapeItemEvidencePattern(leftAdjacent)}\\s*$`).test(leftContext);
    const rightMatchesAdjacent = Boolean(rightAdjacent)
      && new RegExp(`^\\s*${escapeItemEvidencePattern(rightAdjacent)}`).test(rightContext);
    const quantityTail = rightContext.match(/^\\s*/);
    const rightIsDeclaredQuantityBoundary = Boolean(declaredQuantity && declaredUnit)
      && startsWithEquivalentQuantityEvidence(
        rightContext.slice(quantityTail ? quantityTail[0].length : 0),
        declaredQuantity,
        declaredUnit
      );
    const rightIsDeclaredPriceBoundary = Boolean(declaredUnitPrice)
      && findBoundedUnitPriceEvidenceIndex(
        rightContext,
        declaredUnitPrice,
        declaredPriceUnit
      ) === 0;
    const leftIsDeclaredQuantityBoundary = Boolean(declaredQuantity && declaredUnit)
      && findPrefixedQuantityEvidenceStart(
        source,
        index,
        declaredQuantity,
        declaredUnit
      ) >= 0;
    const leftIsCustomerBoundary = /(?:总|老板|经理|姐|哥|先生|女士|客户)$/.test(compactLeft);
    const leftIsActionBoundary = /(?:下单|订货|订购|采购|买|要|订|拿|做|帮我做|另加|再加|再来|补做)$/.test(compactLeft);
    const leftIsCorrectionBoundary = /(?:不对(?:是)?|更正(?:为|成)?|改成|改为|应该是|实际是)[^，,。；;\n]{0,12}$/.test(compactLeft);
    const leftIsPriorItemPriceBoundary = rightIsDeclaredQuantityBoundary
      && /(?:元|块|块钱|毛|角|分|钱)(?:一|每)?(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|包|盒|袋|组|把|台|块)?$/.test(compactLeft);
    const rightIsBusinessBoundary = /^(?:\s*(?:先|要|需|共|各|每|数量|交|发|拿|做|订|下单|改|换|另加|再加|再来|补做))/.test(rightContext);
    const leftNumericBoundary = !/^[0-9.]/.test(target) || !/[0-9.]$/.test(previous);
    const rightNumericBoundary = !/[0-9.]$/.test(target) || !/^[0-9.]/.test(next);
    const leftBoundary = !previous || !entityCharacter.test(previous)
      || leftMatchesAdjacent
      || leftIsDeclaredQuantityBoundary
      || leftIsCustomerBoundary
      || leftIsActionBoundary
      || leftIsCorrectionBoundary
      || leftIsPriorItemPriceBoundary;
    const rightBoundary = !next || !entityCharacter.test(next)
      || rightMatchesAdjacent
      || rightIsDeclaredQuantityBoundary
      || rightIsDeclaredPriceBoundary
      || rightIsBusinessBoundary;
    if (leftBoundary && rightBoundary && leftNumericBoundary && rightNumericBoundary) return true;
    cursor = index + target.length;
  }
  return false;
}

function isTrustedAiItemSpecShape(value) {
  const spec = String(value || '').trim();
  if (!spec) return true;
  if (spec.length > 24
    || !/^[\u3400-\u9fffA-Za-z0-9Ａ-Ｚａ-ｚ０-９.\/\-×xX*（）()]{1,24}$/.test(spec)
    || /(?:、|,|，|&|＆|\+|＋|\||｜|和|及|与|跟)/.test(spec)
    || /(?:数量|单价|价格|总价|金额|客户|订单|付款|收款|交期|交货|发货|待确认|待定|未定)/.test(spec)) {
    return false;
  }
  return /[\u3400-\u9fffA-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(spec);
}

function findBoundedQuantityEvidenceIndex(sourceText, quantity, unit) {
  const source = String(sourceText || '');
  const value = String(quantity || '').trim();
  const normalizedUnit = String(unit || '').trim();
  if (!source || !value || !normalizedUnit) return -1;
  const match = getEquivalentNumberEvidenceMatches(source, value).find((candidate) => (
    new RegExp(`^\\s*${escapeItemEvidencePattern(normalizedUnit)}`).test(
      source.slice(candidate.index + candidate[0].length)
    )
  ));
  return match ? match.index : -1;
}

function findBoundedUnitPriceEvidenceIndex(sourceText, unitPrice, itemUnit) {
  const source = String(sourceText || '');
  const value = String(unitPrice || '').trim();
  const unit = String(itemUnit || '').trim();
  if (!source || !value) return -1;
  const currencyPattern = '(?:元|块|块钱|毛|角|分|钱)';
  const matches = getEquivalentNumberEvidenceMatches(source, value);
  for (const match of matches) {
    const index = match.index;
    const before = source.slice(0, index);
    const after = source.slice(index + match[0].length);
    const beforeEvidence = unit
      ? new RegExp(`(?:单价(?:是|为)?|(?:统一\\s*)?每\\s*${escapeItemEvidencePattern(unit)}(?:单价)?(?:是|为)?)\\s*$`).test(before)
      : /单价(?:是|为)?\s*$/.test(before);
    const hasCurrencySuffix = new RegExp(`^\\s*${currencyPattern}`).test(after);
    const afterEvidence = unit
      ? new RegExp(`^\\s*${currencyPattern}\\s*(?:(?:一|每|/)\\s*)?${escapeItemEvidencePattern(unit)}`).test(after)
      : false;
    if ((beforeEvidence && hasCurrencySuffix) || afterEvidence) return index;
  }
  return -1;
}

function removeEquivalentQuantityEvidence(sourceText, quantity, unit) {
  const source = String(sourceText || '');
  const normalizedUnit = String(unit || '').trim();
  if (!source || !String(quantity || '').trim() || !normalizedUnit) return source;
  const match = getEquivalentNumberEvidenceMatches(source, quantity).find((candidate) => (
    new RegExp(`^\\s*${escapeItemEvidencePattern(normalizedUnit)}`).test(
      source.slice(candidate.index + candidate[0].length)
    )
  ));
  if (!match) return source;
  const tail = source.slice(match.index + match[0].length);
  const unitMatch = tail.match(new RegExp(`^\\s*${escapeItemEvidencePattern(normalizedUnit)}`));
  if (!unitMatch) return source;
  return source.slice(0, match.index)
    + tail.slice(unitMatch[0].length);
}

function isItemEvidencePathClear(sourceText, aiItem, factIndex, factField = 'quantity') {
  const source = String(sourceText || '');
  const productName = String(aiItem && aiItem.productName || '').trim();
  const productStart = source.indexOf(productName);
  if (!productName || productStart < 0 || factIndex < productStart + productName.length) return false;
  let bridge = source.slice(productStart + productName.length, factIndex);
  const spec = String(aiItem && aiItem.spec || '').trim();
  if (spec) {
    bridge = bridge.replace(new RegExp(`^\\s*[\\/\\-（(【]?\\s*${escapeItemEvidencePattern(spec)}`), '');
  }
  bridge = bridge.replace(/^\s*(?:共|要|需|数量(?:是|为)?|订|做|另加|再加|再来|补做)\s*/, '');
  if (['unitPrice', 'priceUnit'].includes(factField)) {
    const quantity = String(aiItem && aiItem.quantity || '').trim();
    const unit = String(aiItem && aiItem.unit || '').trim();
    const priceUnit = String(aiItem && (aiItem.priceUnit || aiItem.unit) || '').trim();
    if (quantity && unit) {
      bridge = removeEquivalentQuantityEvidence(bridge, quantity, unit);
      bridge = bridge.replace(/^\s*(?:共|要|需|数量(?:是|为)?|订|做|另加|再加|再来|补做)\s*/, '');
    }
    if (priceUnit) {
      bridge = bridge.replace(new RegExp(
        `(?:单价(?:是|为)?|(?:统一\\s*)?每\\s*${escapeItemEvidencePattern(priceUnit)}(?:单价)?(?:是|为)?)\\s*$`
      ), '');
    } else {
      bridge = bridge.replace(/单价(?:是|为)?\s*$/, '');
    }
  }
  bridge = bridge
    .replace(/[\s，,、：:；;。/\-（）()【】]/g, '');
  return !/[A-Za-z0-9\u3400-\u9fff]/.test(bridge);
}

function hasBoundItemQuantityEvidence(sourceText, aiItem) {
  const index = findBoundedQuantityEvidenceIndex(
    sourceText,
    aiItem && aiItem.quantity,
    aiItem && aiItem.unit
  );
  if (index >= 0 && isItemEvidencePathClear(sourceText, aiItem, index)) return true;
  const source = String(sourceText || '');
  const productName = String(aiItem && aiItem.productName || '').trim();
  const productStart = source.indexOf(productName);
  return Boolean(productName)
    && findPrefixedQuantityEvidenceStart(
      source,
      productStart,
      aiItem && aiItem.quantity,
      aiItem && aiItem.unit
    ) >= 0;
}

function hasBoundItemUnitPriceEvidence(sourceText, aiItem) {
  const itemUnit = aiItem && (aiItem.priceUnit || aiItem.unit);
  const index = findBoundedUnitPriceEvidenceIndex(
    sourceText,
    aiItem && aiItem.unitPrice,
    itemUnit
  );
  return index >= 0 && isItemEvidencePathClear(sourceText, aiItem, index, 'unitPrice');
}

function hasExactItemRemarkEvidence(sourceText, value) {
  const source = String(sourceText || '');
  const target = String(value || '').trim();
  if (!source || !target) return false;
  const entityCharacter = /[A-Za-z0-9\u3400-\u9fff]/;
  const targetStartsWithNegation = /^(?:不|不要|别|无需|禁止|非|取消)/.test(target);
  let cursor = 0;
  while (cursor <= source.length) {
    const index = source.indexOf(target, cursor);
    if (index < 0) return false;
    const left = source.slice(0, index);
    const right = source.slice(index + target.length);
    const compactLeft = left.replace(/[\s"'“”‘’（）()【】\[\]：:,，、]/g, '');
    const negated = !targetStartsWithNegation
      && /(?:不要|无需|禁止|严禁|切勿|避免|拒绝|取消|不需要|别|非|不)(?:(?:做成|使用|改为|改成|选择|采用|用|需要|要|推荐|接受|可以|能))*$/.test(compactLeft);
    const previous = source[index - 1] || '';
    const next = source[index + target.length] || '';
    const positiveLead = /(?:备注|要求|颜色|款式|包装|做成|需要)$/.test(compactLeft);
    const leftBoundary = !previous || !entityCharacter.test(previous) || positiveLead;
    const rightBoundary = !next || !entityCharacter.test(next);
    if (!negated && leftBoundary && rightBoundary) return true;
    cursor = index + target.length;
  }
  return false;
}

function isAiItemSupplementSupported(field, value, aiItem, evidenceText) {
  const source = String(evidenceText || '');
  const normalizedValue = String(value === undefined || value === null ? '' : value).trim();
  if (!source || !normalizedValue) return false;
  if (field === 'spec') {
    return isTrustedAiItemSpecShape(normalizedValue)
      && hasExactItemTextEvidence(source, normalizedValue, {
      leftAdjacent: aiItem && aiItem.productName,
      rightAdjacent: aiItem && aiItem.productName,
      quantity: aiItem && aiItem.quantity,
      unit: aiItem && aiItem.unit
      });
  }
  if (field === 'itemRemark') return hasExactItemRemarkEvidence(source, normalizedValue);

  if (field === 'productName') {
    return hasExactItemTextEvidence(source, normalizedValue, {
      leftAdjacent: aiItem && aiItem.spec,
      rightAdjacent: aiItem && aiItem.spec,
      quantity: aiItem && aiItem.quantity,
      unit: aiItem && aiItem.unit,
      unitPrice: aiItem && aiItem.unitPrice,
      priceUnit: aiItem && (aiItem.priceUnit || aiItem.unit)
    });
  }
  if (field === 'quantity') {
    return hasBoundItemQuantityEvidence(source, aiItem);
  }
  if (field === 'unit') {
    return hasBoundItemQuantityEvidence(source, aiItem)
      && normalizeUnit(aiItem && aiItem.unit) === normalizeUnit(normalizedValue);
  }
  if (field === 'unitPrice') {
    if (hasItemFactValue(aiItem, 'quantity') && !hasBoundItemQuantityEvidence(source, aiItem)) return false;
    return hasBoundItemUnitPriceEvidence(source, aiItem);
  }
  if (field === 'priceUnit') {
    if (hasItemFactValue(aiItem, 'quantity') && !hasBoundItemQuantityEvidence(source, aiItem)) return false;
    return normalizeUnit(aiItem && aiItem.priceUnit) === normalizeUnit(normalizedValue)
      && hasBoundItemUnitPriceEvidence(source, aiItem);
  }
  // item total 只由可信数量×单价推导。末项文本范围可能包含整单“合计/共计”，
  // 不能把它当作该 item 的原文小计证据。
  if (field === 'totalAmount') return false;
  return false;
}

function matchItemsByUniqueIdentity(localItems, aiItems) {
  const localCandidates = localItems.map((localItem) => aiItems
    .map((aiItem, aiIndex) => (areItemIdentitiesCompatible(localItem, aiItem) ? aiIndex : -1))
    .filter((aiIndex) => aiIndex >= 0));
  const aiCandidates = aiItems.map((aiItem) => localItems
    .map((localItem, localIndex) => (areItemIdentitiesCompatible(localItem, aiItem) ? localIndex : -1))
    .filter((localIndex) => localIndex >= 0));
  const matches = localCandidates.map((candidates, localIndex) => {
    if (candidates.length !== 1) return -1;
    const aiIndex = candidates[0];
    return aiCandidates[aiIndex].length === 1 && aiCandidates[aiIndex][0] === localIndex
      ? aiIndex
      : -1;
  });
  return matches.every((aiIndex) => aiIndex >= 0)
    && new Set(matches).size === localItems.length
    ? matches
    : null;
}

function getDeclaredLocalItemRiskFields(localResult = {}, localItem = {}, itemIndex = 0, itemCount = 1) {
  const safety = localResult.local_parse_safety || {};
  const validations = safety.field_validations || {};
  const rootRisks = uniqueStrings([].concat(
    localResult.missing_fields || [],
    localResult.low_confidence_fields || [],
    safety.missing_fields || [],
    safety.low_confidence_fields || [],
    safety.unsafe_fields || [],
    validations.invalid_fields || [],
    validations.semantic_low_fields || [],
    validations.conflict_fields || []
  ));
  const itemKey = String(localItem && localItem.confirmationItemKey || '');
  const risks = new Set();
  toArray(localResult.field_conflicts || []).forEach((conflict) => {
    const field = typeof conflict === 'string' ? conflict : conflict && conflict.field;
    if (field === 'items' && conflict && conflict.itemField) {
      const conflictKey = String(conflict.itemKey || '');
      if ((conflictKey && conflictKey === itemKey)
        || (!conflictKey && Number(conflict.itemIndex) === itemIndex)) {
        risks.add(conflict.itemField);
      }
      return;
    }
    if (field && itemCount === 1) risks.add(field);
  });
  if (itemCount === 1) rootRisks.forEach((field) => risks.add(field));
  if (risks.has('amount') || risks.has('quantity') || risks.has('unitPrice')) {
    risks.add('totalAmount');
  }
  if (risks.has('unitPrice')) risks.add('priceUnit');
  return risks;
}

function isPlausibleLocalItemIdentity(value) {
  const productName = String(value || '').trim();
  if (!productName || productName.length > 24) return false;
  if (/^(?:到|交|发|要|做|订|买|拿|好|好的|可以|没问题)$/.test(productName)) return false;
  if (new RegExp(
    `^(?:${numberPattern()})\\s*(?:元|块|块钱|毛|角|分|钱|${SOURCE_EVIDENCE_UNIT_PATTERN})`
  ).test(productName)) return false;
  return !/(?:元|块|块钱|毛|角|分|钱).*(?:周|星期|礼拜|交|发|到)$/.test(productName);
}

function localItemIdentityNeedsCorrection(localResult, localItem, itemIndex, itemCount) {
  const risks = getDeclaredLocalItemRiskFields(
    localResult,
    localItem,
    itemIndex,
    itemCount
  );
  if (risks.has('productName')) return true;
  if (!isPlausibleLocalItemIdentity(localItem && localItem.productName)) return true;
  const originalText = localResult.original_text || localResult.originalText || '';
  const scope = getAiItemEvidenceScope(originalText, localItem, [localItem]);
  return !scope.unique;
}

function hasAiIdentityCorrectionEvidence(localResult, localItem, aiItem, aiItems) {
  if (!localItemIdentityNeedsCorrection(localResult, localItem, 0, 1)) return false;
  const originalText = localResult.original_text || localResult.originalText || '';
  const scope = getAiItemEvidenceScope(originalText, aiItem, aiItems);
  if (!scope.unique
    || !isAiItemSupplementSupported('productName', aiItem.productName, aiItem, scope.text)) {
    return false;
  }
  const productName = String(aiItem && aiItem.productName || '').trim();
  const productIndex = String(originalText || '').indexOf(productName);
  const beforeProduct = productIndex >= 0
    ? String(originalText || '').slice(Math.max(0, productIndex - 18), productIndex)
    : '';
  const explicitCorrection = /(?:不对(?:是)?|更正(?:为|成)?|改成|改为|应该是|实际是)[^，,。；;\n]{0,12}$/.test(beforeProduct);
  return explicitCorrection
    || hasBoundItemQuantityEvidence(scope.text, aiItem)
    || hasBoundItemUnitPriceEvidence(scope.text, aiItem);
}

function mergeMatchedItemFacts(localItem, aiItem, itemIndex, itemConflicts, evidenceText, options = {}) {
  const merged = Object.assign({}, aiItem, localItem);
  let unsupportedAiTotalAmount = false;
  let correctedBaseFact = false;
  const localRiskFields = options.localRiskFields || new Set();
  ITEM_FACT_FIELDS.forEach((field) => {
    const localHasValue = hasItemFactValue(localItem, field);
    const aiHasValue = hasItemFactValue(aiItem, field);
    if (!localHasValue && aiHasValue) {
      if (isAiItemSupplementSupported(field, aiItem[field], aiItem, evidenceText)) {
        merged[field] = aiItem[field];
      } else {
        delete merged[field];
        if (field === 'totalAmount') unsupportedAiTotalAmount = true;
        else {
          const conflict = createItemFieldConflict(
            Object.assign({}, localItem, { [field]: aiItem[field] }),
            itemIndex,
            field,
            'AI_MATCHED_ITEM_FIELD_UNSUPPORTED',
            `商品${itemIndex + 1}的${field}缺少可核对的原文证据。`
          );
          itemConflicts.push(conflict);
        }
      }
      return;
    }
    if (!localHasValue) {
      delete merged[field];
      return;
    }
    if (field === 'productName'
      && options.trustedIdentityCorrection === true
      && aiHasValue) {
      merged[field] = aiItem[field];
      return;
    }
    if (field === 'totalAmount' && correctedBaseFact) {
      if (aiHasValue) merged[field] = aiItem[field];
      else delete merged[field];
      return;
    }
    if (aiHasValue && !itemFactValuesEqual(field, localItem[field], aiItem[field])) {
      const aiSupported = isAiItemSupplementSupported(
        field,
        aiItem[field],
        aiItem,
        evidenceText
      );
      const localEvidenceItem = Object.assign({}, aiItem, { [field]: localItem[field] });
      const localSupported = isAiItemSupplementSupported(
        field,
        localItem[field],
        localEvidenceItem,
        evidenceText
      );
      if (localRiskFields.has(field) && aiSupported && !localSupported) {
        merged[field] = aiItem[field];
        if (['quantity', 'unit', 'unitPrice', 'priceUnit'].includes(field)) {
          correctedBaseFact = true;
        }
        return;
      }
    }
    merged[field] = localItem[field];
    if (aiHasValue && !itemFactValuesEqual(field, localItem[field], aiItem[field])) {
      const conflict = createItemFieldConflict(
        localItem,
        itemIndex,
        field,
        'AI_MATCHED_ITEM_FIELD_CONFLICT',
        `商品${itemIndex + 1}的${field}与本地原文提取结果冲突，已保留本地值。`
      );
      conflict.values = uniqueStrings([localItem[field], aiItem[field]]);
      itemConflicts.push(conflict);
    }
  });

  const calculatedAmount = calculateAmount(
    merged.quantity,
    merged.unitPrice,
    merged.unit,
    merged.priceUnit
  );
  if (calculatedAmount) {
    if (correctedBaseFact
      && hasItemFactValue(aiItem, 'totalAmount')
      && !itemFactValuesEqual('totalAmount', calculatedAmount, aiItem.totalAmount)) {
      const conflict = createItemFieldConflict(
        Object.assign({}, merged, { totalAmount: calculatedAmount }),
        itemIndex,
        'totalAmount',
        'AI_MATCHED_ITEM_TOTAL_MISMATCH',
        `商品${itemIndex + 1}的小计与可信数量、单价计算结果不一致。`
      );
      conflict.values = uniqueStrings([calculatedAmount, aiItem.totalAmount]);
      itemConflicts.push(conflict);
    }
    if (correctedBaseFact) {
      merged.totalAmount = calculatedAmount;
      return merged;
    }
    if (!hasItemFactValue(localItem, 'totalAmount')
      && hasItemFactValue(aiItem, 'totalAmount')
      && !itemFactValuesEqual('totalAmount', calculatedAmount, aiItem.totalAmount)) {
      const conflict = createItemFieldConflict(
        Object.assign({}, localItem, { totalAmount: calculatedAmount }),
        itemIndex,
        'totalAmount',
        'AI_MATCHED_ITEM_TOTAL_MISMATCH',
        `商品${itemIndex + 1}的小计与可信数量、单价计算结果不一致。`
      );
      conflict.values = uniqueStrings([calculatedAmount, aiItem.totalAmount]);
      itemConflicts.push(conflict);
    }
    merged.totalAmount = hasItemFactValue(localItem, 'totalAmount')
      ? localItem.totalAmount
      : calculatedAmount;
  } else if (unsupportedAiTotalAmount) {
    itemConflicts.push(createItemFieldConflict(
      Object.assign({}, localItem, { totalAmount: aiItem.totalAmount }),
      itemIndex,
      'totalAmount',
      'AI_MATCHED_ITEM_FIELD_UNSUPPORTED',
      `商品${itemIndex + 1}的小计缺少可核对的原文证据。`
    ));
  }
  return merged;
}

function projectFirstItemToLegacyFields(fields, items) {
  const projected = Object.assign({}, fields, { items });
  const first = items[0] || {};
  LEGACY_FIRST_ITEM_FIELDS.forEach((field) => {
    if (hasItemFactValue(first, field)) projected[field] = first[field];
    else delete projected[field];
  });
  return projected;
}

function createItemIntegrityConflict(values, message) {
  return {
    field: 'items',
    values: uniqueStrings(values || []),
    message
  };
}

function createItemFieldConflict(item, itemIndex, itemField, code, message) {
  return {
    code,
    field: 'items',
    itemKey: String(item && item.confirmationItemKey || ''),
    itemIndex,
    itemField,
    fieldPath: `items[${itemIndex}].${itemField}`,
    values: hasItemFactValue(item, itemField) ? [String(item[itemField])] : [],
    message
  };
}

function countTextOccurrences(source, target) {
  const text = String(source || '');
  const needle = String(target || '');
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function getAiItemEvidenceScope(originalText, aiItem, aiItems) {
  const source = normalizeBusinessText(originalText || '');
  const productName = String(aiItem && aiItem.productName || '').trim();
  const spec = String(aiItem && aiItem.spec || '').trim();
  if (!productName) return { text: '', unique: false };
  const sameIdentityCount = aiItems.filter((item) => (
    normalizeItemIdentityText(item.productName) === normalizeItemIdentityText(productName)
      && normalizeItemIdentityText(item.spec) === normalizeItemIdentityText(spec)
  )).length;
  if (sameIdentityCount !== 1) return { text: '', unique: false };
  const normalizedProductName = normalizeItemIdentityText(productName);
  const nestedInOtherAiProduct = aiItems.some((item) => {
    const otherProductName = normalizeItemIdentityText(item && item.productName);
    return otherProductName
      && otherProductName !== normalizedProductName
      && otherProductName.includes(normalizedProductName);
  });
  if (nestedInOtherAiProduct) return { text: '', unique: false };
  if (countTextOccurrences(source, productName) !== 1) return { text: '', unique: false };
  if (!hasExactItemTextEvidence(source, productName, {
    leftAdjacent: spec,
    rightAdjacent: spec,
    quantity: aiItem && aiItem.quantity,
    unit: aiItem && aiItem.unit,
    unitPrice: aiItem && aiItem.unitPrice,
    priceUnit: aiItem && (aiItem.priceUnit || aiItem.unit)
  })) return { text: '', unique: false };
  if (spec && (!isTrustedAiItemSpecShape(spec) || !hasExactItemTextEvidence(source, spec, {
    leftAdjacent: productName,
    rightAdjacent: productName,
    quantity: aiItem && aiItem.quantity,
    unit: aiItem && aiItem.unit
  }))) return { text: '', unique: false };
  const productStart = source.indexOf(productName);
  let scopeStart = productStart;
  const prefixedQuantityStart = findPrefixedQuantityEvidenceStart(
    source,
    productStart,
    aiItem && aiItem.quantity,
    aiItem && aiItem.unit
  );
  if (prefixedQuantityStart >= 0) scopeStart = prefixedQuantityStart;
  let hasPrefixedSpec = false;
  let hasSuffixedSpec = false;
  if (spec) {
    const specStart = source.lastIndexOf(spec, productStart);
    const betweenSpecAndProduct = specStart >= 0
      ? source.slice(specStart + spec.length, productStart)
      : '';
    if (specStart >= 0 && /^\s*$/.test(betweenSpecAndProduct)) {
      scopeStart = Math.min(scopeStart, specStart);
      hasPrefixedSpec = true;
    }
    const productEnd = productStart + productName.length;
    const suffixSpecStart = source.indexOf(spec, productEnd);
    const betweenProductAndSpec = suffixSpecStart >= 0
      ? source.slice(productEnd, suffixSpecStart)
      : '';
    if (suffixSpecStart >= 0 && /^[\s/\-（(【]*$/.test(betweenProductAndSpec)) {
      hasSuffixedSpec = true;
    }
  }
  if (spec && !hasPrefixedSpec && !hasSuffixedSpec) return { text: '', unique: false };
  const nextProductStarts = aiItems
    .filter((item) => item !== aiItem)
    .map((item) => String(item && item.productName || '').trim())
    .filter(Boolean)
    // A repeated *other* product name is still a hard right boundary. Ignoring
    // it would let the current item borrow quantity/price facts from text after
    // that product mention. The target item itself remains subject to the
    // stricter unique-identity check above.
    .map((name) => source.indexOf(name, productStart + productName.length))
    .filter((index) => index > productStart);
  const hardStops = [
    source.indexOf('；', productStart),
    source.indexOf(';', productStart),
    source.indexOf('\n', productStart),
    source.indexOf('。', productStart)
  ]
    .filter((index) => index >= 0);
  const endCandidates = nextProductStarts.concat(hardStops).filter((index) => index > productStart);
  const end = endCandidates.length ? Math.min(...endCandidates) : source.length;
  const scopedText = source.slice(scopeStart, end);
  const hasScopedSpec = !spec || hasExactItemTextEvidence(scopedText, spec, {
    leftAdjacent: productName,
    rightAdjacent: productName,
    quantity: aiItem && aiItem.quantity,
    unit: aiItem && aiItem.unit
  });
  if (!scopedText.includes(productName) || !hasScopedSpec) {
    return { text: '', unique: false };
  }
  return { text: scopedText, unique: true };
}

function buildAiAddedItem(aiItem, itemIndex, aiItems, originalText, usedKeys) {
  const item = ensureConfirmationItemKey(aiItem, 'ai', itemIndex, usedKeys);
  item.confirmationItemOrigin = 'AI_ADDED_ITEM';
  const conflicts = [];
  const scope = getAiItemEvidenceScope(originalText, item, aiItems);
  const compositeIdentity = /^.{1,24}(?:、|,|，|&|＆|\+|＋|\/|\||｜|和|及|与|跟|加).{1,24}$/.test(
    String(item.productName || '').trim()
  );
  if (!scope.unique || compositeIdentity) {
    conflicts.push(createItemFieldConflict(
      item,
      itemIndex,
      'identity',
      'AI_ADDED_ITEM_IDENTITY_AMBIGUOUS',
      compositeIdentity
        ? `商品${itemIndex + 1}像是多个商品的集合，不能合并成一个商品保存。`
        : `商品${itemIndex + 1}无法与原文片段唯一对应，请逐项确认。`
    ));
  }

  const supported = {};
  ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'itemDeliveryDate', 'itemRemark']
    .forEach((field) => {
      if (!hasItemFactValue(item, field)) return;
      supported[field] = scope.unique
        && isAiItemSupplementSupported(field, item[field], item, scope.text);
      if (!supported[field]) {
        conflicts.push(createItemFieldConflict(
          item,
          itemIndex,
          field,
          'AI_ADDED_ITEM_FIELD_UNSUPPORTED',
          `商品${itemIndex + 1}的${field}无法从原文逐项核对，请确认或修改。`
        ));
      }
    });

  const calculatedAmount = supported.quantity && supported.unitPrice
    ? calculateAmount(item.quantity, item.unitPrice, item.unit, item.priceUnit)
    : '';
  if (calculatedAmount) {
    if (hasItemFactValue(item, 'totalAmount')
      && !itemFactValuesEqual('totalAmount', calculatedAmount, item.totalAmount)) {
      conflicts.push(createItemFieldConflict(
        item,
        itemIndex,
        'totalAmount',
        'AI_ADDED_ITEM_TOTAL_MISMATCH',
        `商品${itemIndex + 1}的小计与可信数量、单价计算结果不一致。`
      ));
    }
    item.totalAmount = calculatedAmount;
  } else if (hasItemFactValue(item, 'totalAmount')) {
    conflicts.push(createItemFieldConflict(
      item,
      itemIndex,
      'totalAmount',
      'AI_ADDED_ITEM_FIELD_UNSUPPORTED',
      `商品${itemIndex + 1}的小计缺少可信逐项计算依据。`
    ));
  }
  return { item, conflicts };
}

function getUncoveredSourceProductHints(originalText, aiItems) {
  const source = normalizeBusinessText(originalText || '');
  if (!source) return [];
  const explicitItemMarker = '__explicit_item_add__';
  const segmentedSource = source.replace(
    /(?:还有|另外|另加|再要|再加|加做|补做)/g,
    `；${explicitItemMarker}`
  );
  const normalizedAiItems = Array.isArray(aiItems) ? aiItems : [];
  const aiProducts = normalizedAiItems
    .map((item) => normalizeItemIdentityText(item && item.productName))
    .filter(Boolean);
  const aiCoverageIdentities = uniqueStrings(normalizedAiItems.reduce((all, item) => {
    const productName = normalizeItemIdentityText(item && item.productName);
    const spec = normalizeItemIdentityText(item && item.spec);
    if (!productName) return all;
    all.push(productName);
    if (spec) {
      all.push(`${spec}${productName}`);
      all.push(`${productName}${spec}`);
      all.push(`${productName}（${spec}）`);
      all.push(`${productName}(${spec})`);
      all.push(`${productName}【${spec}】`);
      all.push(`${productName}[${spec}]`);
      all.push(`${productName}《${spec}》`);
      all.push(`${productName}“${spec}”`);
      all.push(`${productName}"${spec}"`);
      all.push(`${productName}「${spec}」`);
      all.push(`${productName}『${spec}』`);
      all.push(`${productName} ${spec}`);
      all.push(`${spec} ${productName}`);
    }
    return all;
  }, []));
  const segmentedHints = segmentedSource
    .split(/[；;。\n，,]+/)
    .map((clause) => String(clause || '').trim())
    .filter(Boolean)
    .map((clause) => clause
      .replace(/^.*?(?:下单|订货|订购|要货|返单|补单|采购|买|要|订|拿|做)[：:\s]*/, '')
      .replace(/^(?:要订|下单|订货|订购|要货|返单|补单|采购|买|要|订|拿|做)[：:\s]*/, '')
      .trim())
    .filter((clause) => {
      if (clause.startsWith(explicitItemMarker)) return true;
      return !aiCoverageIdentities.some((identity) => {
        const index = clause.indexOf(identity);
        if (index < 0) return false;
        const before = clause.slice(0, index);
        const after = clause.slice(index + identity.length);
        if (/^(?:\d|[零〇一二两三四五六七八九十百千万俩]|数量|单价|价格|规格)/.test(after)) {
          return true;
        }
        if (!after && new RegExp(
          `(?:${numberPattern()})\\s*${SOURCE_EVIDENCE_UNIT_PATTERN}\\s*$`
        ).test(before)) {
          return true;
        }
        return !after && !/[A-Za-z0-9\u3400-\u9fff]/.test(before);
      });
    })
    .filter((clause) => !/^(?:(?:19|20)\d{2}年)?\d{1,2}月\d{1,2}[日号]?(?:前|左右)?(?:(?:一起|统一|全部|都)?(?:交|交货|发货|出货|送货|到期))?$/.test(clause))
    .filter((clause) => !/^(?:(?:本|这|下|上)?(?:周|星期|礼拜))[一二三四五六日天](?:(?:一起|统一|全部|都)?(?:交|发|到|交货|发货|出货|送货|到期))?$/.test(clause))
    .filter((clause) => !/^(?:交期|交货|发货|出货|送货|到期)/.test(clause))
    .filter((clause) => !/^(?:合计|共计|总计|总价|总金额|订单金额|金额)/.test(clause))
    .filter((clause) => clause.startsWith(explicitItemMarker) || !(
      /(?:定金|订金|预付|尾款|货款|欠款|收款|付款|支付|到账|转账)/.test(clause)
      && new RegExp(`(?:${numberPattern()})\\s*(?:元|块|块钱|毛|角|分)`).test(clause)
    ))
    .filter((clause) => !new RegExp(
      `^(?:每${SOURCE_EVIDENCE_UNIT_PATTERN}|单价|价格)\\s*(?:是|为)?\\s*(?:${numberPattern()})\\s*(?:元|块|块钱|毛|角|分)$`
    ).test(clause))
    .filter((clause) => !new RegExp(
      `^(?:${numberPattern()})\\s*(?:元|块|块钱|毛|角|分)\\s*(?:一|每)?${SOURCE_EVIDENCE_UNIT_PATTERN}$`
    ).test(clause))
    .filter((clause) => !new RegExp(
      `^(?:${numberPattern()})\\s*(?:元|块)(?:${numberPattern()})?\\s*(?:毛|角|分)?(?:一|每)?(?:${SOURCE_EVIDENCE_UNIT_PATTERN})?$`
    ).test(clause))
    .filter((clause) => !new RegExp(
      `^(?:还是|仍按|继续按|按原来)?\\s*(?:${numberPattern()})\\s*(?:元|块|块钱|毛|角|分|钱)(?:一|每)?(?:${SOURCE_EVIDENCE_UNIT_PATTERN})?$`
    ).test(clause))
    .filter((clause) => !new RegExp(
      `^(?:(?:数量)(?:是|为)?|共(?:计)?|合计)?\\s*(?:${numberPattern()})\\s*${SOURCE_EVIDENCE_UNIT_PATTERN}$`
    ).test(clause))
    .filter((clause) => !new RegExp(
      `^每(?:箱|盒|包|袋|套)(?:装|放|含|有)?\\s*(?:${numberPattern()})\\s*${SOURCE_EVIDENCE_UNIT_PATTERN}$`
    ).test(clause))
    .filter((clause) => !/^(?:备注|要求|颜色|包装要求|加急|不急|尽快|不要|别|无需|禁止)/.test(clause))
    .filter((clause) => !/(?:吗|呢|吧|么)[？?]?$/.test(clause))
    .filter((clause) => !/(?:忙不忙|好不好|行不行|能不能|有没有)/.test(clause))
    .filter((clause) => !/^(?:(?:我|客户|对方|老板|[^：:\s]{1,8})[：:])?(?:好|好的|可以|行|没问题|你说|收到|知道了)$/.test(clause))
    .filter((clause) => !/(?:这是新单|不是之前那单|不是原来那单|并非之前订单)$/.test(clause))
    .filter((clause) => !/^(?:到|交|发|要到|补一句|补充一句)$/.test(clause))
    .filter((clause) => !/(?:客户自提|自提|现金结算|月底付款|含税|不含税|开票|发票|送到|送至|发到|配送|先打样|打样|货到付款|月结|现结|到付|包邮|运费|交货|发货|出货|收货|送货|装箱|包装要求|颜色要求|质量要求|验货|联系人|联系电话|收货地址)/.test(clause))
    .filter((clause) => !/^[\u3400-\u9fff]{1,6}色$/.test(clause))
    .filter((clause) => !/^(?:加隔板|贴标签|贴标|印logo|印LOGO|印字|印花|丝印|移印|烫金|烫银|激光|打孔|冲孔|覆膜|过膜|喷涂|喷漆|加厚|防水|防潮|防刮|防锈|抛光|磨砂|做旧|电镀|装磁铁|配内衬|加内衬)$/.test(clause))
    .map((clause) => {
      const explicitItem = clause.startsWith(explicitItemMarker);
      const candidateClause = explicitItem
        ? clause.slice(explicitItemMarker.length).trim()
        : clause;
      if (new RegExp(
        `^(?:${numberPattern()})\\s*${SOURCE_EVIDENCE_UNIT_PATTERN}$`
      ).test(candidateClause)) return '';
      const pendingField = candidateClause.match(
        /^([\u3400-\u9fffA-Za-z0-9Ａ-Ｚａ-ｚ０-９.\/\-]{1,24}?)[，,、：:\s]*(?:数量|单价|价格|规格)\s*(?:是|为)?\s*(?:待定|未定|待确认|不确定|未提供|没说|不知道|晚点确认|稍后确认|后续确认|回头确认)$/
      );
      if (pendingField) return pendingField[1];
      if (!explicitItem && (
        /^(?:包装|加工|工艺|材质|颜色|标签|印刷|唛头|款式|尺寸|质量|外箱|内盒)/.test(candidateClause)
        || /^(?:加|贴|印|喷|烫|打|装|配|换成|做成|改成)[\u3400-\u9fffA-Za-z0-9]/.test(candidateClause)
        || /^[\u3400-\u9fffA-Za-z0-9]{1,12}级$/.test(candidateClause)
        || /^\d{2,4}[\u3400-\u9fffA-Za-z]{1,12}$/.test(candidateClause)
      )) {
        return '';
      }
      const explicitItemFact = candidateClause.match(new RegExp(
        `^(${SOURCE_ITEM_IDENTITY_TOKEN}{1,24}?)(?:${SOURCE_SPEC_SEGMENT_PATTERN})?\\s*(?:${numberPattern()})\\s*(${SOURCE_EVIDENCE_UNIT_PATTERN})$`
      ));
      if (explicitItemFact
        && !isNonProductSourceFact(explicitItemFact[1], explicitItemFact[2], explicitItem)) {
        return explicitItemFact[1];
      }
      const bracketedItemFact = candidateClause.match(new RegExp(
        `^(${SOURCE_ITEM_IDENTITY_TOKEN}{1,24}?)${SOURCE_SPEC_SEGMENT_PATTERN}\\s*(?:${numberPattern()})\\s*(${SOURCE_GENERIC_MEASURE_PATTERN})$`
      ));
      if (bracketedItemFact
        && !isNonProductSourceFact(bracketedItemFact[1], bracketedItemFact[2], explicitItem)) {
        return bracketedItemFact[1];
      }
      return /^[\u3400-\u9fffA-Za-z0-9Ａ-Ｚａ-ｚ０-９.\/\-]{1,24}$/.test(candidateClause)
        ? candidateClause
        : '';
    })
    .map((product) => normalizeItemIdentityText(product))
    .filter(Boolean)
    .filter((product) => !aiProducts.some((aiProduct) => (
      aiProduct === product
    )));
  return uniqueStrings(segmentedHints);
}

function isNonProductSourceFact(label, unit, explicitlyAdded = false) {
  if (explicitlyAdded) return false;
  const normalizedLabel = normalizeItemIdentityText(label);
  const normalizedUnit = normalizeItemIdentityText(unit);
  if (!normalizedLabel) return true;
  if (/^(?:元|块|块钱|毛|角|分|月|日|号|年|天|周|星期|点|时|分钟|工作日|字|折|处|道|班|遍|次|usd|cny|rmb|eur|gbp|jpy|hkd|cad|aud|day|days|week|weeks|month|months|year|years|yr|yrs|hr|hrs|hour|hours|min|mins|minute|minutes)$/.test(normalizedUnit)) {
    return true;
  }
  if (/^(?:说明|备注|折扣|优惠|报价|价格|金额|总价|总金额|检验|抽检|质检|班次|工时|工序|工艺|加工|排产|交期|账期|税率|质保|保修|有效期|保质期)$/.test(normalizedLabel)) {
    return true;
  }
  return /(?:刻字|雕刻|绣字|开槽|缝线|车缝|锁边|包边|裁剪|切割|焊接|滴胶|抛光|打孔|冲孔|喷涂|喷漆|印刷|丝印|移印|烫金|烫银|电镀|检验|抽检|质检|装配|组装|包装|加工)$/.test(normalizedLabel);
}

function getIndependentOriginalItemCount(localResult = {}, options = {}) {
  const originalText = localResult.original_text || localResult.originalText || '';
  const source = String(originalText || '');
  if (!source.trim()) return 0;
  const localItems = Array.isArray((localResult.fields || {}).items)
    ? localResult.fields.items
    : [];
  const productNames = uniqueStrings([].concat(
    localItems.map((item) => String(item && item.productName || '').trim()),
    (Array.isArray(options.aiItems) ? options.aiItems : [])
      .map((item) => String(item && item.productName || '').trim())
  )).filter(Boolean);
  const productSpans = [];
  productNames.forEach((productName) => {
    let cursor = 0;
    while (cursor <= source.length) {
      const index = source.indexOf(productName, cursor);
      if (index < 0) break;
      productSpans.push({ start: index, end: index + productName.length });
      cursor = index + productName.length;
    }
  });
  const itemUnit = SOURCE_EVIDENCE_UNIT_PATTERN;
  const matches = Array.from(source.matchAll(new RegExp(`(${numberPattern()})\\s*(${itemUnit})`, 'g')));
  return matches.filter((match) => {
    const matchStart = Number(match.index || 0);
    const matchEnd = matchStart + String(match[0] || '').length;
    if (productSpans.some((span) => matchStart >= span.start && matchEnd <= span.end)) {
      return false;
    }
    const parsed = parseChineseNumber(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) return false;
    const prefix = source.slice(Math.max(0, match.index - 24), match.index);
    const suffix = source.slice(match.index + match[0].length, match.index + match[0].length + 8);
    const sourceFactLabel = prefix.match(
      new RegExp(`(${SOURCE_ITEM_IDENTITY_TOKEN}{1,24}?)(?:${SOURCE_SPEC_SEGMENT_PATTERN})?\\s*$`)
    );
    const explicitlyAdded = /(?:还有|另外|另加|再要|再加|加做|补做)[^；;。，,]{0,24}$/.test(prefix);
    if (/(?:不是|并非|不对(?:是)?|更正(?:为|成)?)\s*$/.test(prefix)) return false;
    if (sourceFactLabel
      && isNonProductSourceFact(sourceFactLabel[1], match[2], explicitlyAdded)) {
      return false;
    }
    if (parsed === 1
      && new RegExp(`(?:${numberPattern()})\\s*(?:元|块|块钱|毛|角|分|钱)\\s*(?:${numberPattern()})?\\s*$`).test(prefix)) {
      return false;
    }
    if (parsed === 1
      && /^(?:\d|[零〇一二两三四五六七八九十百千万俩])(?:块|元|毛|角|分|钱)/.test(suffix)) {
      return false;
    }
    if (/每(?:箱|盒|包|袋|套)(?:装|放|含|有)?\s*$/.test(prefix)) return false;
    return true;
  }).length;
}

function applyAiItemStructureGuard(localResult = {}, aiFields = {}, options = {}) {
  const localFields = localResult.fields || {};
  const rawLocalItems = Array.isArray(localFields.items) ? localFields.items : [];
  const localItems = normalizeAiItems(rawLocalItems || []);
  const aiItems = normalizeAiItems(aiFields.items || []);
  const joined = hasJoinedMultiItemValue(aiFields);
  const malformed = joined && aiItems.length < 2;
  let fields = Object.assign({}, localFields, aiFields);
  const conflicts = [];

  if (malformed) {
    conflicts.push(createItemIntegrityConflict(
      [],
      'AI 没有逐项返回多件商品，不能把多件商品合并成一条保存。'
    ));
  }

  const independentOriginalItemCount = aiItems.length
    ? getIndependentOriginalItemCount(localResult, Object.assign({}, options, { aiItems }))
    : 0;
  const uncoveredSourceProductHints = aiItems.length > 0
    ? getUncoveredSourceProductHints(
      localResult.original_text || localResult.originalText || '',
      aiItems
    )
    : [];
  if (independentOriginalItemCount > aiItems.length || uncoveredSourceProductHints.length) {
    const conflict = createItemIntegrityConflict(
      [
        `sourceCount>=${independentOriginalItemCount}`,
        `aiCount=${aiItems.length}`
      ].concat(uncoveredSourceProductHints.map((product) => `uncovered:${product}`)),
      '原文仍有未被 AI 逐项覆盖的商品事实，不能按不完整商品清单保存。'
    );
    conflict.code = 'AI_ITEM_SOURCE_COVERAGE_INCOMPLETE';
    conflict.itemField = 'identity';
    conflict.fieldPath = 'items';
    conflicts.push(conflict);
  }

  if (localItems.length > 1 && aiItems.length === 0) {
    const usedKeys = new Set();
    const duplicatedLocalKeys = getDuplicatedConfirmationItemKeys(rawLocalItems);
    const keyedLocalItems = localItems.map((item, index) => ensureConfirmationItemKey(
      Object.assign({}, item, {
        confirmationItemKey: duplicatedLocalKeys.has(String(
          rawLocalItems[index] && rawLocalItems[index].confirmationItemKey || ''
        ).trim())
          ? ''
          : String(rawLocalItems[index] && rawLocalItems[index].confirmationItemKey || '')
      }),
      'local',
      index,
      usedKeys
    ));
    fields = projectFirstItemToLegacyFields(fields, keyedLocalItems);
    const conflict = createItemIntegrityConflict(
      [`localCount=${localItems.length}`, 'aiCount=0'],
      '本地已识别多件商品，但 AI 没有返回逐项商品结构，已保留本地明细并要求确认。'
    );
    conflict.code = 'AI_ITEM_STRUCTURE_MISSING';
    conflict.itemField = 'identity';
    conflict.fieldPath = 'items';
    conflicts.push(conflict);
  }

  if (localItems.length > 0 && aiItems.length > 0) {
    const usedKeys = new Set();
    const duplicatedLocalKeys = getDuplicatedConfirmationItemKeys(rawLocalItems);
    const keyedLocalItems = localItems.map((item, index) => ensureConfirmationItemKey(
      Object.assign({}, item, {
        confirmationItemKey: duplicatedLocalKeys.has(String(
          rawLocalItems[index] && rawLocalItems[index].confirmationItemKey || ''
        ).trim())
          ? ''
          : String(rawLocalItems[index] && rawLocalItems[index].confirmationItemKey || '')
      }),
      'local',
      index,
      usedKeys
    ));
    let matches = matchItemsByUniqueIdentity(keyedLocalItems, aiItems);
    let trustedIdentityCorrection = false;
    if (!matches
      && keyedLocalItems.length === 1
      && aiItems.length === 1
      && hasAiIdentityCorrectionEvidence(
        localResult,
        keyedLocalItems[0],
        aiItems[0],
        aiItems
      )) {
      matches = [0];
      trustedIdentityCorrection = true;
    }
    if (!matches) {
      fields = projectFirstItemToLegacyFields(fields, keyedLocalItems);
      if (!malformed) {
        const conflict = createItemIntegrityConflict(
          [`localCount=${localItems.length}`, `aiCount=${aiItems.length}`],
          'AI 商品无法与本地商品逐项唯一对应，已保留本地明细并要求确认。'
        );
        conflict.code = 'AI_ITEM_IDENTITY_AMBIGUOUS';
        conflict.itemField = 'identity';
        conflict.itemIndex = 0;
        conflict.itemKey = String(keyedLocalItems[0] && keyedLocalItems[0].confirmationItemKey || '');
        conflict.fieldPath = 'items';
        conflicts.push(conflict);
      }
    } else {
      const factConflicts = [];
      const originalText = localResult.original_text || localResult.originalText || '';
      const evidenceScopes = matches.map((aiIndex) => {
        const scope = getAiItemEvidenceScope(originalText, aiItems[aiIndex], aiItems);
        return scope.unique ? scope.text : '';
      });
      const localByAiIndex = {};
      matches.forEach((aiIndex, localIndex) => {
        localByAiIndex[aiIndex] = localIndex;
      });
      const mergedItems = aiItems.map((aiItem, aiIndex) => {
        if (Object.prototype.hasOwnProperty.call(localByAiIndex, aiIndex)) {
          const localIndex = localByAiIndex[aiIndex];
          const matchedAiItem = Object.assign({}, aiItem);
          // Some providers repeat the order-level delivery date inside every
          // item. When it is identical to the already trusted top-level date,
          // it is redundant transport shape rather than a new item fact.
          if (!hasItemFactValue(keyedLocalItems[localIndex], 'itemDeliveryDate')
            && hasItemFactValue(matchedAiItem, 'itemDeliveryDate')
            && hasItemFactValue(localFields, 'dueDate')
            && itemFactValuesEqual(
              'itemDeliveryDate',
              matchedAiItem.itemDeliveryDate,
              localFields.dueDate
            )) {
            delete matchedAiItem.itemDeliveryDate;
          }
          if (!hasItemFactValue(matchedAiItem, 'priceUnit')
            && hasItemFactValue(matchedAiItem, 'unit')
            && hasItemFactValue(matchedAiItem, 'unitPrice')
            && isAiItemSupplementSupported(
              'unitPrice',
              matchedAiItem.unitPrice,
              matchedAiItem,
              evidenceScopes[localIndex]
            )) {
            matchedAiItem.priceUnit = matchedAiItem.unit;
          }
          const mergedItem = mergeMatchedItemFacts(
            keyedLocalItems[localIndex],
            matchedAiItem,
            aiIndex,
            factConflicts,
            evidenceScopes[localIndex],
            {
              trustedIdentityCorrection,
              localRiskFields: getDeclaredLocalItemRiskFields(
                localResult,
                keyedLocalItems[localIndex],
                localIndex,
                keyedLocalItems.length
              )
            }
          );
          mergedItem.confirmationItemKey = keyedLocalItems[localIndex].confirmationItemKey;
          mergedItem.confirmationItemOrigin = 'LOCAL_MATCHED';
          return mergedItem;
        }
        const addedAiItem = Object.assign({}, aiItem);
        if (hasItemFactValue(addedAiItem, 'itemDeliveryDate')
          && hasItemFactValue(localFields, 'dueDate')
          && itemFactValuesEqual(
            'itemDeliveryDate',
            addedAiItem.itemDeliveryDate,
            localFields.dueDate
          )) {
          delete addedAiItem.itemDeliveryDate;
        }
        const added = buildAiAddedItem(
          addedAiItem,
          aiIndex,
          aiItems,
          localResult.original_text || localResult.originalText || '',
          usedKeys
        );
        conflicts.push(...added.conflicts);
        return added.item;
      });
      fields = projectFirstItemToLegacyFields(fields, mergedItems);
      conflicts.push(...factConflicts);
    }
  }

  return {
    fields,
    malformed: conflicts.length > 0,
    conflict: conflicts[0] || null,
    conflicts
  };
}

const PRODUCT_TRANSCRIPTION_HINTS = {
  水怀: '水杯',
  保温怀: '保温杯',
  礼合: '礼品盒',
  礼品和: '礼品盒',
  收纳合: '收纳盒',
  饰品合: '饰品盒',
  钥匙口: '钥匙扣'
};

function getProductTranscriptionHint(originalText, productName) {
  const source = String(originalText || '');
  const current = String(productName || '');
  const raw = Object.keys(PRODUCT_TRANSCRIPTION_HINTS).find((value) => source.includes(value));
  if (!raw) return null;
  const suggestion = PRODUCT_TRANSCRIPTION_HINTS[raw];
  if (!current || (!current.includes(raw) && current !== suggestion)) return null;
  return { raw, suggestion };
}

function applyProductTranscriptionSafety(result = {}) {
  const fields = Object.assign({}, result.fields || {});
  const hint = getProductTranscriptionHint(result.original_text, fields.productName);
  if (!hint) return result;

  const lowConfidenceFields = uniqueStrings([].concat(result.low_confidence_fields || [], 'productName'));
  const existingMessage = String(result.confirm_message || '').trim();
  const hintMessage = fields.productName === hint.suggestion
    ? `原话写的是“${hint.raw}”，当前整理为“${hint.suggestion}”，请确认商品名称。`
    : `商品“${hint.raw}”可能想说“${hint.suggestion}”，请确认或在下方改正。`;
  const localSafety = result.local_parse_safety || {};
  const evidenceMissing = uniqueStrings(localSafety.evidence_missing_fields || []);
  const unsafeFields = uniqueStrings(localSafety.unsafe_fields || []);
  // 这是老板确认一次商品名的问题，不是让 AI 再猜一次的问题。否则既会白等，
  // 又会把“AI 已返回但不确定”误显示成“AI 没有返回”。
  const onlyProductNeedsConfirmation = localSafety.status === 'NEEDS_AI'
    && evidenceMissing.length === 1
    && evidenceMissing[0] === 'productName'
    && unsafeFields.every((field) => field === 'productName');
  const nextSafety = onlyProductNeedsConfirmation
    ? Object.assign({}, localSafety, {
      status: NEEDS_USER_CONFIRM,
      safe_to_auto_accept: false,
      reason_texts: uniqueReasonTexts([].concat(
        localSafety.reason_texts || [],
        '商品名称可能是语音转写或错别字，需要你确认一次。'
      ))
    })
    : localSafety;
  return Object.assign({}, result, {
    low_confidence_fields: lowConfidenceFields,
    local_parse_safety: nextSafety,
    ai_fallback: onlyProductNeedsConfirmation
      ? Object.assign({}, result.ai_fallback || {}, { needed: false })
      : result.ai_fallback,
    field_suggestions: Object.assign({}, result.field_suggestions || {}, {
      productName: { value: hint.suggestion, source: hint.raw, text: hintMessage }
    }),
    confirm_message: existingMessage.includes(hintMessage)
      ? existingMessage
      : [existingMessage, hintMessage].filter(Boolean).join(' ')
  });
}

function applyPostAiConsistency(result, normalized) {
  const fields = Object.assign({}, result.fields || {});
  const fieldSources = Object.assign({}, result.field_sources || {});
  const itemsTotal = getItemsTotal(fields.items || []);
  const calculatedAmount = itemsTotal || (hasFieldValue(fields, 'quantity') && hasFieldValue(fields, 'unitPrice')
    ? calculateAmount(fields.quantity, fields.unitPrice, fields.unit, fields.priceUnit)
    : '');
  const statedAmount = fields.statedAmount || '';
  if (calculatedAmount) {
    fields.calculatedAmount = calculatedAmount;
    fieldSources.calculatedAmount = itemsTotal ? 'computed:items_total' : 'computed:quantity*unitPrice';
    if (statedAmount) {
      fields.amount = statedAmount;
      fields.totalAmount = statedAmount;
      fieldSources.amount = fieldSources.statedAmount || fieldSources.amount || 'rule:explicit_amount';
      fieldSources.totalAmount = fieldSources.amount;
    } else {
      fields.amount = calculatedAmount;
      fields.totalAmount = calculatedAmount;
      fieldSources.amount = fieldSources.calculatedAmount;
      fieldSources.totalAmount = fieldSources.calculatedAmount;
    }
  }
  if ((fields.paymentKind === 'deposit' || fields.depositAmount) && !fields.paymentAmount && fields.depositAmount) {
    fields.paymentAmount = fields.depositAmount;
    fieldSources.paymentAmount = fieldSources.paymentAmount || fieldSources.depositAmount || 'computed:depositAmount';
  }
  const supersededFacts = toArray(normalized.superseded_facts || normalized.supersededFacts || result.superseded_facts);
  // field_conflicts 已在合并阶段根据“是否有可核对的解决证据”处理过。
  // 这里绝不能再因为 AI 返回了空数组而清掉本地发现的风险。
  const fieldConflicts = toArray(result.field_conflicts);
  if (statedAmount && calculatedAmount && Math.abs(Number(statedAmount) - Number(calculatedAmount)) >= 0.005
    && !fieldConflicts.some((item) => item && item.field === 'amount')) {
    fieldConflicts.push({
      field: 'amount',
      values: [statedAmount, calculatedAmount],
      message: `原话总金额${statedAmount}元，与数量×单价计算的${calculatedAmount}元不一致，必须确认。`
    });
  }
  const conflictFields = getConflictFields(fieldConflicts);
  return Object.assign({}, result, {
    fields,
    field_sources: fieldSources,
    field_conflicts: fieldConflicts,
    superseded_facts: supersededFacts,
    low_confidence_fields: uniqueStrings([].concat(result.low_confidence_fields || [], conflictFields))
  });
}

function applyCustomerHistoryDefaults(localResult, policy, scopedHistory) {
  if (policy !== 'customer_history' || !scopedHistory.found) return localResult;
  const fields = Object.assign({}, localResult.fields || {});
  if (!fields.productName) return localResult;

  const history = getHistoryRecords(scopedHistory, fields.productName);
  const priceRecord = history.priceRecords[0];
  const deliveryRecord = history.orders.find((order) => hasFieldValue(order, 'requiredDeliveryDate'));
  const defaultedFields = [];
  const fieldSources = Object.assign({}, localResult.field_sources || {});

  if (!hasFieldValue(fields, 'unitPrice') && priceRecord && hasFieldValue(priceRecord, 'unitPrice')) {
    fields.unitPrice = priceRecord.unitPrice;
    fieldSources.unitPrice = getHistorySource(priceRecord, 'unitPrice');
    defaultedFields.push('unitPrice');
    if (!hasFieldValue(fields, 'unit') && hasFieldValue(priceRecord, 'unit')) {
      fields.unit = priceRecord.unit;
      fieldSources.unit = getHistorySource(priceRecord, 'unit');
    }
  }

  if (!hasFieldValue(fields, 'dueDate') && deliveryRecord && hasFieldValue(deliveryRecord, 'requiredDeliveryDate')) {
    fields.dueDate = deliveryRecord.requiredDeliveryDate;
    fieldSources.dueDate = getHistorySource(deliveryRecord, 'requiredDeliveryDate');
    defaultedFields.push('dueDate');
  }

  if (!defaultedFields.length) return localResult;

  if (hasFieldValue(fields, 'quantity') && hasFieldValue(fields, 'unitPrice')) {
    const amount = calculateAmount(fields.quantity, fields.unitPrice, fields.unit, fields.priceUnit);
    if (amount && !hasFieldValue(fields, 'amount')) {
      fields.amount = amount;
      fieldSources.amount = 'computed:quantity*history_unitPrice';
    }
  }

  return Object.assign({}, localResult, {
    fields,
    field_sources: fieldSources,
    missing_fields: (localResult.missing_fields || []).filter((field) => !defaultedFields.includes(field)),
    low_confidence_fields: (localResult.low_confidence_fields || []).filter((field) => !defaultedFields.includes(field)),
    history_defaulted_fields: defaultedFields,
    history_default_warning_text: buildHistoryDefaultWarning(fields, defaultedFields)
  });
}

function protectLocalFacts(localResult, fields) {
  const nextFields = Object.assign({}, fields);
  const localFields = localResult.fields || {};
  const originalText = localResult.original_text || '';
  const aiCustomerName = nextFields.customerName;
  const aiRemark = String(nextFields.remark || '').trim();
  const localRequirementRemark = buildRemarkFromItems(localResult.remark_items || []);

  if (
    canProtectLocalCustomer(localResult)
    && (!nextFields.customerName || !originalContainsName(originalText, nextFields.customerName))
  ) {
    nextFields.customerName = localFields.customerName;
    if (aiCustomerName && aiCustomerName !== localFields.customerName) delete nextFields.customerId;
  }

  if (localResult.history_status === 'not_found') {
    if (localResult.context_policy === 'customer_history') {
      delete nextFields.orderId;
      delete nextFields.quotationId;
      if (!localFields.unitPrice) {
        delete nextFields.unitPrice;
        if (!localFields.amount) delete nextFields.amount;
      }
      if (!localFields.dueDate) delete nextFields.dueDate;
    }
    if (localResult.context_policy === 'receivable_history') {
      delete nextFields.receivableId;
    }
  }

  // AI 可以帮助理解语义，但不能改写老板原话中已经明确出现的总金额。
  // 数量×单价的计算值仍保留在 calculatedAmount，供确认卡显示矛盾。
  if (hasFieldValue(localFields, 'statedAmount')) {
    nextFields.statedAmount = localFields.statedAmount;
    nextFields.amount = localFields.statedAmount;
    nextFields.totalAmount = localFields.statedAmount;
  }

  nextFields.remark = aiRemark || localRequirementRemark || localFields.remark || originalText;
  return nextFields;
}

function applyAiCustomerEvidenceSafety(result) {
  const fields = Object.assign({}, result.fields || {});
  const originalText = result.original_text || '';
  const lowConfidenceFields = uniqueStrings(result.low_confidence_fields || []);
  if (fields.customerName && !isCustomerNameSupportedBySource(originalText, fields.customerName)) {
    delete fields.customerName;
    delete fields.customerId;
    lowConfidenceFields.push('customerName');
  }
  return Object.assign({}, result, {
    fields,
    low_confidence_fields: uniqueStrings(lowConfidenceFields)
  });
}

function prepareAiBusinessNormalization(aiResult, options = {}) {
  const normalized = unwrapAiResult(aiResult);
  const validity = getAiBusinessResultValidity(normalized);
  if (!validity.valid) throw createEmptyAiBusinessResultError(validity);
  return {
    normalized,
    validity,
    fields: normalizeFields(normalized.fields || normalized, options)
  };
}

function normalizeTrustedProviderKind(value, fallback = 'UNKNOWN') {
  const normalized = String(value || '').trim().toUpperCase();
  return ['REAL', 'MOCK', 'FAKE', 'REPLAY', 'NONE'].includes(normalized)
    ? normalized
    : fallback;
}

// Normalize a provider result without reading or merging any local parser draft.
// AI_ONLY uses this layer so model/normalizer scoring cannot be repaired by the
// local parser. Production routing continues to use normalizeAiResult below.
function normalizeAiBusinessResult(aiResult, options = {}) {
  const prepared = prepareAiBusinessNormalization(aiResult, options);
  const normalized = prepared.normalized;
  const validity = prepared.validity;
  const intentRaw = String(normalized.intent || '').trim().toLowerCase();
  const intent = validIntents.includes(intentRaw) ? intentRaw : 'unknown';
  const explicitDecision = String(normalized.decision || normalized.status || '').trim().toLowerCase();
  const noRecord = normalized.no_record === true
    || normalized.recordable === false
    || explicitDecision === 'no_record';
  const providerKind = normalizeTrustedProviderKind(options.providerKind);
  const mockUsed = providerKind === 'MOCK';
  const missingFields = toStringArray(normalized.missing_fields || normalized.missingFields);
  const lowFields = toStringArray(normalized.low_confidence_fields || normalized.lowConfidenceFields);
  const conflicts = toArray(normalized.field_conflicts || normalized.fieldConflicts);
  const intentCandidates = uniqueStrings([].concat(
    toStringArray(normalized.intent_candidates || normalized.intentCandidates),
    intent
  )).filter((candidate) => validIntents.includes(candidate) && candidate !== 'query');
  let result = {
    id: normalized.id || '',
    source: options.source || 'typed',
    original_text: typeof options.originalText === 'string' ? options.originalText : '',
    intent,
    operation: normalized.operation || '',
    fields: prepared.fields,
    missing_fields: missingFields,
    low_confidence_fields: lowFields,
    field_conflicts: conflicts,
    customer_candidates: toArray(normalized.customer_candidates || normalized.customerCandidates),
    computed_fields: toArray(normalized.computed_fields || normalized.computedFields),
    computed_tips: toArray(normalized.computed_tips || normalized.computedTips),
    field_sources: Object.assign({}, sanitizeAiFieldSources(normalized)),
    field_evidence: normalizeObject(normalized.field_evidence || normalized.fieldEvidence, {}),
    remark_items: toArray(normalized.remark_items || normalized.remarkItems),
    intent_candidates: intentCandidates,
    confidence: normalized.confidence === undefined ? null : normalized.confidence,
    confirm_message: normalized.confirm_message || normalized.confirmMessage
      || (validity.kind === 'uncertain'
        ? 'AI 认为信息仍不确定，请你确认后再处理。'
        : 'AI 识别成下面这样，请你确认。'),
    formal_save_blocked: Boolean(normalized.formal_save_blocked || normalized.formalSaveBlocked || noRecord),
    block_reason: normalized.block_reason || normalized.blockReason
      || (noRecord ? 'AI 明确判断当前内容不能形成业务记录。' : ''),
    requires_existing_record: Boolean(normalized.requires_existing_record || normalized.requiresExistingRecord),
    mixed_business: Boolean(normalized.mixed_business || normalized.mixedBusiness),
    no_record: noRecord,
    ai_fallback: {
      needed: true,
      status: mockUsed
        ? 'mock_used'
        : (validity.kind === 'uncertain' ? 'returned_uncertain' : 'used'),
      attempted: true,
      business_result_valid: true,
      provider_kind: providerKind,
      reason: mockUsed
        ? '调用方注册的是模拟 AI adapter，结果不能作为真实 AI 成功使用。'
        : (validity.kind === 'uncertain'
          ? 'AI 已明确返回不确定或不能记录的安全结论。'
          : 'AI 已成功返回整理结果。')
    },
    ai_business_result_valid: true,
    provider: normalized.provider || '',
    raw_messages: toArray(options.rawMessages || [])
  };
  result = applyPostAiConsistency(result, normalized);
  result = applyAiCustomerEvidenceSafety(result);
  return applyProductTranscriptionSafety(result);
}

function normalizeAiResult(localResult, aiResult, options = {}) {
  const mockUsed = hasMockProvider(aiResult);
  const providerKind = normalizeTrustedProviderKind(
    options.providerKind,
    mockUsed ? 'MOCK' : 'UNKNOWN'
  );
  // 先验证 AI 业务 JSON，再裁决 Provider 是否可信。来源不明不能让
  // 空结果、无效结果绕过统一的 AI_RESPONSE_INVALID 分类。
  const prepared = prepareAiBusinessNormalization(aiResult, options);
  if (!['REAL', 'MOCK'].includes(providerKind)) {
    const rejected = withAiStatus(cloneTrustedLocalSnapshot(localResult), 'rejected', {
      attempted: true,
      businessResultValid: false,
      code: 'AI_PROVIDER_IDENTITY_UNRESOLVED',
      providerKind,
      reason: '本次自动核对结果来源无法确认，已保留核对前的内容。'
    });
    rejected.ai_business_result_valid = false;
    return rejected;
  }
  const normalized = prepared.normalized;
  const validity = prepared.validity;
  const aiFields = prepared.fields;
  const intent = mergeAiIntent(localResult, normalized);
  const hardSafety = getLocalHardSafety(localResult, normalized);
  const itemStructure = applyAiItemStructureGuard(localResult, aiFields, options);
  const aiMissingFields = toStringArray(normalized.missing_fields || normalized.missingFields);
  const aiLowFields = toStringArray(normalized.low_confidence_fields || normalized.lowConfidenceFields);
  const aiConflicts = toArray(normalized.field_conflicts || normalized.fieldConflicts);
  const preservedLocalConflicts = hardSafety.localConflicts.filter((conflict) => {
    const field = typeof conflict === 'string' ? conflict : conflict && conflict.field;
    if (!field) return false;
    if (hardSafety.needsBusinessSplit && ['customerName', 'intent'].includes(field)) return true;
    return !hasExplicitConflictResolution(normalized, field, hardSafety.aiIntentCandidates);
  });
  const hardSafetyConflicts = [];
  if (hardSafety.needsBusinessSplit) {
    hardSafetyConflicts.push({
      field: 'intent',
      values: hardSafety.aiIntentCandidates,
      message: '这一句话里包含多笔不同业务，请拆成多条后分别确认。'
    });
  }
  hardSafetyConflicts.push(...(itemStructure.conflicts || []));
  let merged = Object.assign({}, localResult, normalized, {
    intent,
    formal_save_blocked: Boolean(localResult.formal_save_blocked),
    block_reason: localResult.block_reason || '',
    requires_existing_record: Boolean(localResult.requires_existing_record),
    mixed_business: Boolean(localResult.mixed_business),
    date_detail: localResult.date_detail || null
  });
  // AI business JSON is untrusted data. Routing, safety and shared-core
  // provenance are transport/control-plane facts and must never be supplied by
  // the model response. Keep the local route/safety values and let the shared
  // core attach its protected record_flow_context after normalization.
  // `manual_fields` means a real user edited or confirmed a field. It is trust
  // metadata, not an AI business fact, so only the pre-merge local draft may
  // contribute it; provider JSON and its camelCase alias are always discarded.
  merged.manual_fields = normalizeManualFields(localResult.manual_fields);
  delete merged.manualFields;
  merged.manual_item_fields = normalizeManualItemFields(
    localResult.manual_item_fields,
    (itemStructure.fields || {}).items || []
  );
  delete merged.manualItemFields;
  delete merged.item_manual_fields;
  delete merged.itemManualFields;
  // User-resolution evidence is created only by the confirmation page after
  // this AI cycle. Neither model JSON nor a previous cycle may carry it into a
  // new result. Incrementing the revision also invalidates any copied proof
  // that was bound to the prior AI risk set.
  merged.ai_resolution_revision = Math.max(0, Number(localResult.ai_resolution_revision || 0)) + 1;
  merged.user_manual_edits = [];
  delete merged.userManualEdits;
  delete merged.user_resolution;
  delete merged.userResolution;
  delete merged.resolutionOutcome;
  delete merged.allRisksResolved;
  merged.parse_route = localResult.parse_route;
  merged.local_parse_safety = localResult.local_parse_safety;
  merged.parse_trace = localResult.parse_trace;
  if (localResult.final_parse_safety !== undefined) {
    merged.final_parse_safety = localResult.final_parse_safety;
  } else {
    delete merged.final_parse_safety;
  }
  if (localResult.record_flow_context !== undefined) {
    merged.record_flow_context = localResult.record_flow_context;
  } else {
    delete merged.record_flow_context;
  }
  const localRelationReferences = cloneLocalRelationReferences(
    localResult.relation_references
  );
  if (localRelationReferences) {
    // Structured local language evidence is a production parser fact. AI
    // payloads may neither create nor overwrite it.
    merged.relation_references = localRelationReferences;
  } else {
    delete merged.relation_references;
  }
  merged.id = normalized.id || localResult.id;
  merged.source = localResult.source;
  merged.original_text = localResult.original_text;
  merged.fields = protectLocalFacts(localResult, itemStructure.fields);
  if (localRelationReferences
    && localRelationReferences.quotation
    && localRelationReferences.quotation.resolvedEntityId === null) {
    delete merged.fields.quotationId;
  }
  merged.missing_fields = uniqueStrings([].concat(
    aiMissingFields.filter((field) => !hasFieldValue(merged.fields, field)),
    toStringArray(localResult.missing_fields || []).filter((field) => {
      if (!hasFieldValue(merged.fields, field)) return true;
      return hardSafety.needsBusinessSplit && ['intent', 'customerName', 'productName', 'quantity', 'unitPrice', 'paymentAmount', 'amount'].includes(field);
    })
  ));
  merged.low_confidence_fields = uniqueStrings([].concat(
    aiLowFields,
    toStringArray(localResult.low_confidence_fields || []).filter((field) => {
      if (hardSafety.needsBusinessSplit && ['intent', 'customerName', 'productName', 'quantity', 'unitPrice', 'paymentAmount', 'amount'].includes(field)) return true;
      return preservedLocalConflicts.some((conflict) => (conflict && conflict.field) === field);
    }),
    itemStructure.malformed ? ['items'] : []
  ));
  merged.field_conflicts = mergeConflictEntries(aiConflicts, preservedLocalConflicts, hardSafetyConflicts);
  merged.customer_candidates = toArray(normalized.customer_candidates || normalized.customerCandidates);
  merged.computed_fields = toArray(normalized.computed_fields || normalized.computedFields || localResult.computed_fields);
  merged.computed_tips = toArray(normalized.computed_tips || normalized.computedTips || localResult.computed_tips);
  merged.field_sources = mergeTrustedFieldSources(
    localResult,
    normalized,
    aiFields,
    merged.fields
  );
  merged.field_evidence = normalizeObject(normalized.field_evidence || normalized.fieldEvidence, localResult.field_evidence || {});
  merged.remark_items = mergeRemarkItems(localResult.remark_items, normalized.remark_items || normalized.remarkItems);
  merged.intent_candidates = uniqueStrings([].concat(
    hardSafety.aiIntentCandidates,
    toStringArray(localResult.intent_candidates || []),
    intent
  )).filter((candidate) => validIntents.includes(candidate) && candidate !== 'unknown' && candidate !== 'query');
  merged.confidence = normalized.confidence !== undefined ? normalized.confidence : localResult.confidence;
  merged.confirm_message = normalized.confirm_message || normalized.confirmMessage || localResult.confirm_message || '我识别成下面这样，你确认后再保存。';
  merged.ai_fallback = {
    needed: true,
    status: mockUsed
      ? 'mock_used'
      : (validity.kind === 'uncertain' ? 'returned_uncertain' : 'used'),
    attempted: true,
    business_result_valid: true,
    provider_kind: providerKind,
    reason: mockUsed
      ? '服务返回的是模拟整理结果。'
      : (validity.kind === 'uncertain'
        ? 'AI 已明确返回不确定或不能记录的安全结论。'
        : 'AI 已成功返回整理结果。')
  };
  merged.ai_business_result_valid = true;
  merged.provider = mockUsed ? 'mock' : (normalized.provider || 'server');
  merged.context_policy = localResult.context_policy || 'none';
  merged.history_status = localResult.history_status || 'not_required';
  merged.history_warning_text = localResult.history_warning_text || '';
  merged.history_defaulted_fields = localResult.history_defaulted_fields || [];
  merged.history_default_warning_text = localResult.history_default_warning_text || '';
  merged.suggested_operation = localResult.suggested_operation || '';
  merged.raw_messages = localResult.raw_messages || [];
  merged = applyPostAiConsistency(merged, normalized);
  merged = applyAiCustomerEvidenceSafety(merged);
  return applyProductTranscriptionSafety(merged);
}

function getAiFailureReason(error) {
  const code = String((error && error.code) || '').toUpperCase();
  const message = String((error && (error.errMsg || error.message)) || '').toLowerCase();
  const statusCode = Number(error && error.statusCode);
  if (code === 'AI_TOTAL_TIMEOUT' || code === 'AI_TIMEOUT') return '智能快速核对在 8 秒内没有完成，这条先放待整理。';
  if (code === 'AI_FAST_TIMEOUT') return '智能快速核对超时，这条先放待整理。';
  if (code === 'AUTH_SESSION_NOT_READY') return '智能核对正在准备登录，请稍后点“重新生成确认卡”。';
  if (code === 'AUTH_SESSION_EXPIRED' || code === 'AUTH_REQUIRED' || statusCode === 401) return '智能核对的登录准备还没完成，这条先放待整理。';
  if (statusCode === 429 || code === 'RATE_LIMITED') return '请求太频繁，AI 暂时没有返回结果。';
  if (code === 'AI_RESPONSE_EMPTY_BUSINESS') return 'AI 返回了空业务结果，系统已拒绝采用；这条先放待整理。';
  if (code === 'AI_RESPONSE_INVALID') return 'AI 已返回，但关键内容不够确定；这条保留原话，等你确认后再保存。';
  if (code === 'AI_PROVIDER_UNAVAILABLE') return '智能核对服务暂时不可用，这条先放待整理。';
  if (message.includes('timeout') || message.includes('超时')) return '等待 AI 返回超时，当前只按基础规则整理。';
  if (message.includes('network') || message.includes('request:fail') || message.includes('网络')) {
    return '网络请求没有成功，当前只按基础规则整理。';
  }
  return 'AI 没有返回可用结果，当前只按基础规则整理。';
}

function getAiFailureStatus(error) {
  const code = String((error && error.code) || '').toUpperCase();
  const message = String((error && (error.errMsg || error.message)) || '').toLowerCase();
  if (['AI_TIMEOUT', 'AI_TOTAL_TIMEOUT', 'AI_FAST_TIMEOUT', 'AI_DEEP_TIMEOUT', 'AI_PROVIDER_TIMEOUT'].includes(code)
    || message.includes('timeout') || message.includes('超时')) return 'timed_out';
  if (['AI_RESPONSE_INVALID', 'AI_RESPONSE_EMPTY_BUSINESS'].includes(code)) return 'returned_uncertain';
  return 'failed';
}

function withAiStatus(localResult, status, metadata = {}) {
  const result = Object.assign({}, localResult);
  result.ai_fallback = Object.assign({}, localResult.ai_fallback, {
    status,
    attempted: Boolean(metadata.attempted),
    reason: metadata.reason || '',
    code: metadata.code || '',
    business_result_valid: metadata.businessResultValid === true,
    provider_kind: metadata.providerKind
      || ((localResult.ai_fallback || {}).provider_kind)
      || 'NONE'
  });
  result.ai_business_result_valid = metadata.businessResultValid === true;
  return result;
}

function cloneTrustedLocalSnapshot(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function buildSafeBlockedAiFallback(localSnapshot, error) {
  const code = String(error && error.code || '').toUpperCase();
  const attempted = code !== 'AI_ENDPOINT_MISSING';
  const providerKind = code === 'AI_PROVIDER_IDENTITY_UNRESOLVED' ? 'UNKNOWN' : 'NONE';
  const fallback = withAiStatus(cloneTrustedLocalSnapshot(localSnapshot), getAiFailureStatus(error), {
    attempted,
    businessResultValid: false,
    code: error && error.code,
    providerKind,
    reason: getAiFailureReason(error)
  });
  fallback.formal_save_blocked = true;
  fallback.block_reason = '自动核对未完成，当前不能直接保存。';
  const previousRoute = (localSnapshot && localSnapshot.parse_route) || {};
  const trustedVoiceAudit = Object.keys(previousRoute).reduce((output, key) => {
    if (key.startsWith('voice_completion_') || key.startsWith('voice_standard_')) {
      output[key] = previousRoute[key];
    }
    return output;
  }, {});
  fallback.parse_route = withTrustedClientRoute(Object.assign({}, trustedVoiceAudit, {
    decision: ROUTE_SAFE_BLOCKED,
    deep_review_available: false,
    label: '自动核对未完成',
    reason_codes: uniqueStrings([error && error.code || 'AUTO_REVIEW_FAILED']),
    reasons: ['已保留本地整理结果，未采用本次返回内容。']
  }), ROUTE_SAFE_BLOCKED);
  return fallback;
}

function applySafeLocalReceivableRouteProjection(localResult, route) {
  if (!route
    || route.decision !== ROUTE_LOCAL
    || route.safe_local_receivable_eligible !== true) {
    return localResult;
  }
  const financialReviewReason = '涉及收款、欠款、定金或催款，必须核对后再保存';
  const retainedUnsafeReasons = uniqueStrings(localResult.unsafe_reasons || [])
    .filter((reason) => !String(reason).includes(financialReviewReason));
  const routeReason = '待收款客户和金额已有明确本地证据；关系及正式保存仍需确认卡和安全检查。';
  return Object.assign({}, localResult, {
    ai_fallback: Object.assign({}, localResult.ai_fallback || {}, {
      needed: false
    }),
    local_parse_safety: Object.assign({}, localResult.local_parse_safety || {}, {
      reason_texts: retainedUnsafeReasons.concat(routeReason),
      safe_to_auto_accept: true,
      status: 'SAFE_LOCAL'
    }),
    unsafe_reasons: retainedUnsafeReasons
  });
}

function applyClearNoRecordRouteProjection(localResult, route) {
  if (!route
    || route.decision !== ROUTE_NO_RECORD
    || route.no_record_eligible !== true) {
    return localResult;
  }
  return Object.assign({}, localResult, {
    ai_fallback: Object.assign({}, localResult.ai_fallback || {}, {
      needed: false
    }),
    confirm_message: '这段内容没有可记录的业务，不会保存为正式记录或待整理。',
    no_record: true
  });
}

function applyClientQuestionRouteProjection(localResult, route) {
  if (!route || route.decision !== ROUTE_ASK_USER) return localResult;
  const question = route.questionCandidate || route.activeQuestion || {};
  const target = question.target || {};
  if (target.field !== 'productName') return localResult;
  const fields = Object.assign({}, localResult.fields || {});
  const items = Array.isArray(fields.items)
    ? fields.items.map((item) => Object.assign({}, item))
    : [];
  const itemIndex = Number.isInteger(target.itemIndex) ? target.itemIndex : 0;
  if (items[itemIndex]) items[itemIndex].productName = '';
  fields.productName = itemIndex === 0 ? '' : fields.productName;
  if (items.length) fields.items = items;
  return Object.assign({}, localResult, { fields });
}

function prepareHybridLocalStage(payload) {
  const totalStartedAt = Date.now();
  const localParsedResult = parseInput(payload);
  const policy = getContextPolicy(payload.text, localParsedResult);
  const mentionedCustomerName = extractMentionedCustomerName(payload.text, localParsedResult);
  const scopedHistory = findScopedHistory(payload.state || {}, mentionedCustomerName, policy);
  const localEvidenceResult = applyClientSourceItemDrafts(
    payload,
    attachConversationReview(attachHistoryInfo(localParsedResult, policy, scopedHistory), payload)
  );
  const localSafetyResult = applyClientFactGateRisks(payload, applyProductTranscriptionSafety(applyLocalParseSafety(
    localEvidenceResult,
    {
      normalizedText: normalizeBusinessText(payload.rawText || payload.text || localParsedResult.original_text || ''),
      originalText: payload.rawText || localParsedResult.original_text || '',
      source: payload.source || localParsedResult.source,
      businessDate: payload.businessDate || ''
    }
  )));
  const localDurationMs = Date.now() - totalStartedAt;
  const route = getParseRouteDecision(payload, localSafetyResult, policy);
  const localReviewedResult = applyClientQuestionRouteProjection(
    applyClearNoRecordRouteProjection(
      applySafeLocalReceivableRouteProjection(localSafetyResult, route),
      route
    ),
    route
  );
  const shouldRequestAi = [ROUTE_AI_STANDARD, ROUTE_AI_DEEP].includes(route.decision);
  const localResult = attachParseTrace(
    shouldRequestAi ? markAiNeeded(localReviewedResult, route) : Object.assign({}, localReviewedResult, { parse_route: route }),
    route,
    {
      localDurationMs,
      totalDurationMs: localDurationMs,
      localDraft: getBusinessDraftSummary(localReviewedResult)
    }
  );

  return {
    totalStartedAt,
    localParsedResult,
    localReviewedResult,
    localResult,
    localDurationMs,
    policy,
    scopedHistory,
    route,
    shouldRequestAi
  };
}

function finishHybridWithoutAi(prepared) {
  const { localResult, route, shouldRequestAi } = prepared;

  if (route.decision === ROUTE_NO_RECORD) {
    return withAiStatus(localResult, 'not_requested', {
      attempted: false,
      reason: '没有可记录业务；不会调用AI，也不会保存正式或待整理记录。'
    });
  }
  if (route.decision === ROUTE_PENDING) {
    return withAiStatus(localResult, 'not_requested', {
      attempted: false,
      reason: route.deep_review_available
        ? '这条内容需要进一步核对，当前不能直接保存。'
        : '这段内容还不能确定是一笔什么业务，先放待整理。'
    });
  }
  if (!shouldRequestAi) {
    return withAiStatus(localResult, 'not_requested', {
      attempted: false,
      reason: '这条内容可先按基础规则整理。'
    });
  }
  return null;
}

function requestHybridAiStage(payload, prepared) {
  const {
    totalStartedAt,
    localReviewedResult,
    localResult,
    localDurationMs,
    scopedHistory,
    route
  } = prepared;
  const trustedLocalSnapshot = cloneTrustedLocalSnapshot(localResult);
  return requestHybridAiRaw({ payload, localResult: trustedLocalSnapshot, route, scopedHistory, localDurationMs })
    .then(({ aiResult, aiDurationMs, networkWaitLimitMs }) => attachParseTrace(
      normalizeAiResult(trustedLocalSnapshot, aiResult, {
        businessDate: payload.businessDate || '',
        businessTimezone: payload.businessTimezone || 'Asia/Shanghai',
        nowInstant: payload.nowInstant || null,
        // This identity comes from the trusted network path, not model JSON.
        providerKind: hasMockProvider(aiResult) ? 'MOCK' : 'REAL'
      }),
      route,
      {
        localDurationMs,
        aiDurationMs,
        totalDurationMs: Date.now() - totalStartedAt,
        networkWaitLimitMs,
        localDraft: getBusinessDraftSummary(localReviewedResult),
        aiDraft: getAiDraftSummary(aiResult),
        aiRequestId: aiResult && aiResult.ai_request_id,
        aiServerElapsedMs: aiResult && aiResult.ai_server_elapsed_ms,
        aiServerDeadlineMs: aiResult && aiResult.ai_deadline_ms,
        aiModelTier: aiResult && aiResult.ai_model_tier
      }
    ))
    .catch((error) => {
      const fallback = buildSafeBlockedAiFallback(trustedLocalSnapshot, error);
      return attachParseTrace(fallback, fallback.parse_route, {
      localDurationMs,
      aiDurationMs: Number(error && error.aiDurationMs) || 0,
      totalDurationMs: Date.now() - totalStartedAt,
      networkWaitLimitMs: Number(error && error.networkWaitLimitMs) || 0,
      localDraft: getBusinessDraftSummary(localReviewedResult),
      aiDraft: null,
      aiFailureCode: error && error.code
      });
    });
}

function requestHybridAiRaw({ payload, localResult, route, scopedHistory, localDurationMs = 0 }) {
  if (typeof wx === 'undefined') {
    const error = new Error('Current runtime has no WeChat AI endpoint');
    error.code = 'AI_ENDPOINT_MISSING';
    error.reason = '当前不是微信小程序环境，无法发起 AI 请求。';
    return Promise.reject(error);
  }
  if (!getApiBaseUrl()) {
    const error = new Error('AI service endpoint is not configured');
    error.code = 'AI_ENDPOINT_MISSING';
    error.reason = '没有配置 AI 服务地址，无法发起 AI 请求。';
    return Promise.reject(error);
  }

  const aiStartedAt = Date.now();
  const effectiveRoute = route || { decision: ROUTE_AI_STANDARD };
  const networkWaitLimitMs = getAiWaitLimitMs(effectiveRoute);
  const remainingWaitMs = Math.max(0, networkWaitLimitMs - localDurationMs);
  const requestPath = effectiveRoute.decision === ROUTE_AI_DEEP
    ? `${getAiParseEndpoint().replace(/\/$/, '')}/deep`
    : getAiParseEndpoint();
  const requestTimeoutMs = effectiveRoute.decision === ROUTE_AI_DEEP
    ? AI_DEEP_REQUEST_TIMEOUT_MS
    : AI_STANDARD_REQUEST_TIMEOUT_MS;
  return requestWithDeadline(
    requestJson(requestPath, buildAiRequestPayload(payload, localResult, scopedHistory), requestTimeoutMs, {
      retryAuth: false,
      requireReadyAuth: effectiveRoute.decision === ROUTE_AI_STANDARD
    }),
    remainingWaitMs
  ).then((aiResult) => ({
    aiResult,
    aiDurationMs: Date.now() - aiStartedAt,
    networkWaitLimitMs
  })).catch((error) => {
    error.aiDurationMs = Date.now() - aiStartedAt;
    error.networkWaitLimitMs = networkWaitLimitMs;
    throw error;
  });
}

function parseHybridInput(payload, dependencies = {}) {
  let runtime;
  try {
    // Legacy page callers do not yet pass Phase 1B fields. Resolve them once at
    // the public hybrid entry so local parsing, server prompts and AI merge all
    // share one Shanghai business date even when a request crosses midnight.
    runtime = resolveBusinessTimeContext(payload || {}, { clock: dependencies.clock });
  } catch (error) {
    return Promise.reject(error);
  }
  const inputPayload = payload || {};
  const voiceEvidencePresent = Object.prototype.hasOwnProperty.call(
    inputPayload,
    'voiceCompletionEvidence'
  ) && Boolean(inputPayload.voiceCompletionEvidence);
  const voiceValidation = voiceEvidencePresent
    ? validateVoiceCompletionEvidence(
      inputPayload.voiceCompletionEvidence,
      inputPayload.text,
      {
        inputChannel: inputPayload.inputChannel || inputPayload.source
      }
    )
    : {
      evidence: null,
      fingerprintMatched: false,
      reasons: ['VOICE_EVIDENCE_MISSING'],
      valid: false
    };
  const voiceCompletionEvidenceAudit = {
    present: voiceEvidencePresent,
    valid: voiceValidation.valid === true,
    fingerprintMatched: voiceValidation.fingerprintMatched === true,
    isFinal: voiceEvidencePresent
      && inputPayload.voiceCompletionEvidence.isFinal === true,
    sessionMatched: voiceEvidencePresent
      && !toArray(voiceValidation.reasons).includes('VOICE_SESSION_NOT_CURRENT')
      && !toArray(voiceValidation.reasons).includes('VOICE_SESSION_NOT_COMPLETED'),
    status: voiceEvidencePresent
      ? String(inputPayload.voiceCompletionEvidence.status || '')
      : '',
    evidenceSource: voiceEvidencePresent
      ? String(inputPayload.voiceCompletionEvidence.evidenceSource || '')
      : '',
    exclusionReasonCodes: voiceValidation.reasons || []
  };
  const resolvedPayload = Object.assign({}, inputPayload, {
    businessDate: runtime.businessDate,
    businessTimezone: runtime.businessTimezone,
    nowInstant: runtime.nowInstant,
    voiceCompletionEvidence: voiceValidation.valid
      ? voiceValidation.evidence
      : null,
    voiceCompletionEvidenceAudit
  });
  const prepared = prepareHybridLocalStage(resolvedPayload);
  const requestedRoute = prepared.route.decision === ROUTE_AI_DEEP
    ? 'AUTO_DEEP'
    : (prepared.route.decision === ROUTE_AI_STANDARD
      ? 'AI_STANDARD'
      : String(prepared.route.client_route || prepared.route.decision || 'SAFE_BLOCKED'));
  if (typeof inputPayload.onTrustedClientRouteDecision === 'function') {
    inputPayload.onTrustedClientRouteDecision(Object.freeze({ requestedRoute }));
  }
  const localOnlyResult = finishHybridWithoutAi(prepared);
  if (localOnlyResult) return Promise.resolve(localOnlyResult);
  return requestHybridAiStage(Object.assign({}, resolvedPayload, {
    requestedRoute,
    reviewMode: prepared.route.decision === ROUTE_AI_DEEP ? 'deep' : 'standard'
  }), prepared);
}

module.exports = {
  buildAiRequestPayload,
  compactBusinessContext,
  extractMentionedCustomerName,
  findScopedHistory,
  getContextPolicy,
  getAiFailureReason,
  getAiFailureStatus,
  getAiBusinessResultValidity,
  getParseRouteDecision,
  evaluateClearNonBusinessNoRecord,
  evaluateCompletedVoiceStandardReview,
  evaluateExplicitQuotationConversionDeepReview,
  getTrustedLocalUnresolvedQuotationReference,
  evaluateSafeLocalReceivableRoute,
  applyClearNoRecordRouteProjection,
  applySafeLocalReceivableRouteProjection,
  getBusinessDraftSummary,
  getAiWaitLimitMs,
  finishHybridWithoutAi,
  normalizeAiResult,
  normalizeAiBusinessResult,
  parseHybridInput,
  prepareHybridLocalStage,
  requestHybridAiRaw,
  requestHybridAiStage,
  requestWithDeadline,
  withAiStatus,
  ROUTE_AI_DEEP,
  ROUTE_AI_STANDARD,
  ROUTE_ASK_USER,
  ROUTE_LOCAL,
  ROUTE_NO_RECORD,
  ROUTE_PENDING,
  ROUTE_SAFE_BLOCKED
};
