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
const CUSTOMER_GENERIC = /^(?:客户|老客户|这个客户|那个客户|今天|明天|后天|刚才|刚刚|义乌|那笔|上一笔|这单|那单)$/;
const PRODUCT_PRICE_LIKE = /^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬]+)\s*(?:块|元|毛|角|分|钱)/;
const PRODUCT_BAD_PATTERN = /(?:价格|单价|报价|报架|多少钱|贵了|便宜|上次|上回|之前|原价|老价|照旧|颜色|色差|包装(?!袋|盒)|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太|尽快|月底|月末|明天|后天|下周|交期|到期)/;
const SEMANTIC_AI_PATTERN = /(?:上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|价格不变|还是|最终|最后|确认价|改成|改为|改价|不是|不对|写错|算了|贵了|便宜|就按|客户说|他说|她说|颜色|色差|包装(?!袋|盒)|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太|换成|替换|取消|别做|先别|等确认|撤回)/i;

function compact(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function uniqueStrings(values) {
  return (values || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

function hasFieldValue(fields, field) {
  return fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function getItems(fields) {
  return Array.isArray(fields.items)
    ? fields.items.filter((item) => item && typeof item === 'object')
    : [];
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

    if (!hasFieldValue(item, 'quantity')) {
      addIssue(issues, 'quantity', `${label}缺少数量`, 'missing');
    } else {
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

function inferSemanticFields(text, fields) {
  const low = [];
  if (/上次|上回|上图|之前|原价|老价|旧价|照旧|按老|按上|价格不变|还是|最终|最后|确认价|改价|贵了|便宜|就按/.test(text)) low.push('unitPrice');
  if (/改成|改为|换成|替换|不是|不对|写错|算了/.test(text)) {
    low.push('productName', 'quantity', 'unitPrice', 'dueDate');
  }
  if (/颜色|色差|包装|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太/.test(text)) {
    if (!String(fields.remark || '').includes('要求')) low.push('remark');
  }
  return uniqueStrings(low);
}

function getRouteForSource(source) {
  if (source === 'paste' || source === 'voice') return NEEDS_AI;
  return '';
}

function buildReasonText(issue) {
  return issue.message || `${issue.field || '字段'}需要确认`;
}

function evaluateLocalParseSafety(result, options = {}) {
  const fields = result.fields || {};
  const source = options.source || result.source || 'typed';
  const sourceText = options.normalizedText || result.original_text || '';
  const issues = [];
  const missingFields = uniqueStrings(result.missing_fields || []);
  const lowFields = uniqueStrings(result.low_confidence_fields || []);
  const conflictFields = uniqueStrings((result.field_conflicts || []).map((item) => item && item.field));
  const routeBySource = getRouteForSource(source);
  const lineCount = String(sourceText || '').split(/\n/).filter(Boolean).length;
  const hasSemanticComplexity = SEMANTIC_AI_PATTERN.test(sourceText) || lineCount >= 2;
  const hasBusinessSignals = ['customerName', 'productName', 'quantity', 'unitPrice', 'amount', 'paymentAmount', 'dueDate']
    .some((field) => hasFieldValue(fields, field));

  validateCustomerName(fields, sourceText, issues);
  validateProductName(fields, issues);
  validateItems(fields, issues);
  validateQuantity(fields, issues);
  validateUnitPrice(fields, issues);

  const items = getItems(fields);
  const hasProductItem = items.some((item) => hasFieldValue(item, 'productName'));
  const hasQuantityItem = items.some((item) => hasFieldValue(item, 'quantity'));

  if (CUSTOMER_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'customerName')) {
    addIssue(issues, 'customerName', '缺少客户称呼', 'missing');
  }
  if (PRODUCT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'productName') && !hasProductItem) {
    addIssue(issues, 'productName', '缺少产品/规格', 'missing');
  }
  if (PRODUCT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'quantity') && !hasQuantityItem) {
    addIssue(issues, 'quantity', '缺少数量', 'missing');
  }
  if (AMOUNT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'amount')) {
    addIssue(issues, 'amount', '缺少应收金额', 'missing');
  }
  if (PAYMENT_REQUIRED_INTENTS.includes(result.intent) && !hasFieldValue(fields, 'paymentAmount')) {
    addIssue(issues, 'paymentAmount', '缺少收款金额', 'missing');
  }

  const invalidFields = uniqueStrings(issues.filter((item) => item.type === 'invalid').map((item) => item.field));
  const validationLowFields = uniqueStrings(issues.filter((item) => item.type === 'low_confidence').map((item) => item.field));
  const semanticLowFields = hasSemanticComplexity ? inferSemanticFields(sourceText, fields) : [];
  const hasMissing = missingFields.length || issues.some((item) => item.type === 'missing');
  const hasLow = lowFields.length || validationLowFields.length || semanticLowFields.length;
  const hasConflicts = conflictFields.length > 0;

  let status = SAFE_LOCAL;
  if (result.intent === 'unknown' && !hasBusinessSignals && !hasMissing && !hasLow && !invalidFields.length) {
    status = NO_RECORD;
  } else if (result.intent === 'unknown' && hasBusinessSignals) {
    status = NEEDS_AI;
  } else if (routeBySource || invalidFields.length || hasConflicts || hasSemanticComplexity) {
    status = NEEDS_AI;
  } else if (hasMissing || hasLow || result.intent === 'unknown') {
    status = NEEDS_USER_CONFIRM;
  }

  const reasonItems = issues.concat(
    conflictFields.map((field) => ({ field, message: `${field}存在多个候选或冲突`, type: 'conflict' }))
  );
  if (routeBySource) reasonItems.push({ field: 'source', message: source === 'voice' ? '语音输入直接走 AI 解析' : '微信聊天复制内容直接走 AI 解析', type: 'route' });
  if (hasSemanticComplexity) reasonItems.push({ field: 'semantic', message: '存在历史价格、修改、特殊要求或多轮语义，需要 AI 判断最终有效信息', type: 'semantic' });
  missingFields.forEach((field) => reasonItems.push({ field, message: `${field}缺失`, type: 'missing' }));
  lowFields.forEach((field) => reasonItems.push({ field, message: `${field}低置信度`, type: 'low_confidence' }));

  const unsafeFields = uniqueStrings([]
    .concat(invalidFields, validationLowFields, semanticLowFields, conflictFields)
    .filter((field) => field && field !== 'source' && field !== 'semantic'));

  return {
    status,
    safe_to_auto_accept: status === SAFE_LOCAL,
    reason_texts: uniqueStrings(reasonItems.map(buildReasonText)),
    unsafe_fields: unsafeFields,
    missing_fields: uniqueStrings(missingFields.concat(issues.filter((item) => item.type === 'missing').map((item) => item.field))),
    low_confidence_fields: uniqueStrings(lowFields.concat(validationLowFields, semanticLowFields, invalidFields, conflictFields)),
    field_validations: {
      issues,
      invalid_fields: invalidFields,
      semantic_low_fields: semanticLowFields,
      conflict_fields: conflictFields
    }
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
  if (USER_CONFIRM_STATUSES.includes(safety.status)) {
    next.ai_fallback.needed = Boolean(result.ai_fallback && result.ai_fallback.needed);
  }
  return next;
}

module.exports = {
  NEEDS_AI,
  NEEDS_USER_CONFIRM,
  NO_RECORD,
  SAFE_LOCAL,
  applyLocalParseSafety,
  evaluateLocalParseSafety
};
