const { diffDays, parseChineseDateDetail, today } = require('./date');
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
const FINANCIAL_RISK_PATTERN = /(?:定金|订金|预付|尾款|欠款|货款|收款|到账|转账|打款|刚打|刚转|还差|催.*(?:款|尾款|货款))/;
const QUANTITY_WITH_UNIT_PATTERN = new RegExp(`(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)\\s*${UNIT_PATTERN}`);
const UNIT_PRICE_PATTERN = new RegExp(`(?:单价|价格|价钱)\\s*(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)|(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)\\s*(?:块|元|毛|角|分|钱)(?:\\s*(?:[零〇一二两三四五六七八九十百千万]|\\d+))?(?:\\s*(?:一|每|/))?|(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)\\s*(?:一|每|/)\\s*${RAW_UNIT_PATTERN}`);

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
  if (/颜色|色差|包装|外箱|内盒|logo|LOGO|特殊|要求|备注|淡一点|浅一点|深一点|不要太/.test(text)) {
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
  const hasSemanticComplexity = SEMANTIC_AI_PATTERN.test(sourceText) || lineCount >= 2;
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
  const semanticLowFields = hasSemanticComplexity ? inferSemanticFields(sourceText, fields) : [];
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
  const manualFields = result.manual_fields || [];
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
  const manualFields = uniqueStrings(result.manual_fields || []);
  if (result.edit_mode === 'direct_order') {
    const items = Array.isArray(fields.items) ? fields.items.filter((item) => item && typeof item === 'object') : [];
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
  let safety = getFinalFieldSafety(Object.assign({}, result, { fields }), options);
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
    safety = getFinalFieldSafety(Object.assign({}, result, { fields }), options);
  }
  const finalMissing = uniqueStrings(safety.missing_fields || []);
  const conflictFields = uniqueStrings(((safety.field_validations || {}).conflict_fields) || []);
  const rawFinalLow = uniqueStrings(safety.low_confidence_fields || []);
  const nonConflictFinalLow = rawFinalLow.filter((field) => !conflictFields.includes(field));
  const fieldConflicts = filterFinalFieldConflicts(result.field_conflicts || [], fields, finalMissing, nonConflictFinalLow)
    .filter((conflict) => !manualFields.includes(conflict && conflict.field));
  const keptConflictFields = uniqueStrings(fieldConflicts.map((conflict) => conflict && conflict.field));
  const finalLow = rawFinalLow
    .filter((field) => !conflictFields.includes(field) || keptConflictFields.includes(field))
    .filter((field) => !manualFields.includes(field));
  const missingFields = uniqueStrings([]
    .concat(result.missing_fields || [])
    .filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))
    .concat(finalMissing.filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))));
  const lowConfidenceFields = uniqueStrings([]
    .concat(result.low_confidence_fields || [])
    .filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))
    .filter((field) => !manualFields.includes(field))
    // 纠错建议不是已证实的事实。用户还没有亲手确认前，不能因为字段碰巧
    // 出现在原话里就把“请确认商品名”的提醒清掉。
    .filter((field) => !(FINAL_RECHECK_CLEARABLE_LOW_FIELDS.includes(field)
      && !finalLow.includes(field)
      && !(suggestedFields.includes(field) && !manualFields.includes(field))))
    .concat(finalLow.filter((field) => !OPTIONAL_CONFIRM_FIELDS.includes(field))));

  return Object.assign({}, result, {
    fields,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields,
    field_conflicts: fieldConflicts,
    final_parse_safety: safety
  });
}

module.exports = {
  NEEDS_AI,
  NEEDS_USER_CONFIRM,
  NO_RECORD,
  SAFE_LOCAL,
  applyFinalParseSafety,
  applyLocalParseSafety,
  evaluateLocalEvidence,
  evaluateLocalParseSafety
};
