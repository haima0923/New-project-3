const { parseChineseDate, today } = require('./date');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const { simpleFingerprint } = require('./storage');

const UNITS = ['个', '件', '箱', '套', '只', '条', '批', '双', '张', '本', '斤', '公斤', '米'];
const UNIT_PATTERN = `(?:万)?(?:${UNITS.join('|')})`;
const PRODUCT_STOP_WORDS = /(价格|报价|报架|单价|订单|交货|发货|生产|做好|到期|月底|月结|结款|付款|欠款|先记|记一下|三天后|下周|礼拜|星期|周[一二三四五六日天]).*$/;
const KNOWN_PRODUCTS = ['卡通水杯', '老款杯垫', '钥匙扣', '礼品盒', '水杯', '杯垫', '杯子', '扣子', '饰品', '玩具', '五金', '箱包', '文具', '日用品', '家电', '挂件', '笔', '包'];
const CUSTOMER_ACTION_PATTERN = '那边|这边|说|问|欠|欠款|尾款|货款|还差|还我|还了|还|付|付款|转|打款|到账|先打|下单|先下|下|要|要发|问|报|报架|订|定|定了|买|拿|补|返单|做|收';
const TODO_ACTION_WORDS = '回|回复|答复|跟进|问|催|联系|提醒';

function normalizeText(text) {
  return String(text || '')
    .replace(/[，。；;]/g, '，')
    .replace(/((?:单价|价格|报价|报|卖|按)\s*\d+\.\d)([1-9])(?=天后)/g, '$1，$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOriginalText(text) {
  return String(text || '')
    .replace(/[，。；;]/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

function toCleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function extractPhone(text) {
  const match = text.match(/1[3-9]\d{9}/);
  return match ? match[0] : '';
}

function extractCustomerName(text) {
  const direct = text.match(/(?:给|帮|找|客户|那个)?([\u4e00-\u9fa5A-Za-z]{1,8}(?:总|老板|经理|姐|哥|先生|女士))/);
  if (direct) return { value: direct[1], source: 'rule:customer_title' };
  const oldName = text.match(new RegExp(`(老[\\u4e00-\\u9fa5]{1,2}?)(?:${CUSTOMER_ACTION_PATTERN})`));
  if (oldName) return { value: oldName[1], source: 'rule:customer_action' };
  const fallback = text.match(new RegExp(`([\\u4e00-\\u9fa5]{1,4})(?:${CUSTOMER_ACTION_PATTERN})`));
  if (!fallback) return { value: '', source: '' };
  const name = fallback[1].replace(/^(给|帮|找|客户|那个)/, '');
  return { value: name.startsWith('老') ? name : `${name}总`, source: 'rule:customer_action' };
}

function extractQuantity(text) {
  const match = text.match(new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`));
  if (!match) return { quantity: '', unit: '', source: '' };
  const rawNumber = match[1];
  const rawUnit = match[2];
  const unitHasWan = rawUnit.startsWith('万');
  const parsed = parseChineseNumber(rawNumber) * (unitHasWan ? 10000 : 1);
  return {
    quantity: toCleanNumber(parsed),
    unit: rawUnit.replace(/^万/, ''),
    source: 'rule:quantity_unit'
  };
}

function parsePriceNumber(whole, decimal) {
  const left = parseChineseNumber(whole);
  if (!decimal) return left;
  const right = parseChineseNumber(decimal);
  if (!Number.isFinite(right)) return left;
  return Number(`${left}.${right}`);
}

function extractUnitPrice(text) {
  const priceUnit = '(?:个|件|只|条|套|双|张|本|箱)';
  const chunk = numberPattern();
  const maoPrice = text.match(new RegExp(`(${chunk})\\s*(?:毛钱|毛|角)\\s*(?:一|每|/)${priceUnit}`));
  if (maoPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(maoPrice[1]) / 10),
      source: 'rule:jiao_unit_price'
    };
  }

  const colloquialMao = text.match(new RegExp(`(${chunk})\\s*(?:毛钱|毛|角)\\s*(${chunk})?`));
  if (colloquialMao) {
    const left = parseChineseNumber(colloquialMao[1]);
    const right = colloquialMao[2] ? parseChineseNumber(colloquialMao[2]) : 0;
    return {
      value: toCleanNumber((left * 10 + right) / 100),
      source: colloquialMao[2] ? 'rule:colloquial_jiao_fen_price' : 'rule:jiao_unit_price'
    };
  }

  const fenPrice = text.match(new RegExp(`(${chunk})\\s*(?:分钱|分)\\s*(?:一|每|/)${priceUnit}`));
  if (fenPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(fenPrice[1]) / 100),
      source: 'rule:fen_unit_price'
    };
  }

  const colloquial = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*(${chunk})?\\s*(?:一|每|/)${priceUnit}`));
  if (colloquial) {
    return {
      value: toCleanNumber(parsePriceNumber(colloquial[1], colloquial[2])),
      source: colloquial[2] ? 'rule:colloquial_decimal_price' : 'rule:price_with_currency_unit'
    };
  }

  const bareColloquial = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*(${chunk})(?!\\s*(?:万|千|百|十|个|件|只|条|套|双|张|本|箱))`));
  if (bareColloquial) {
    return {
      value: toCleanNumber(parsePriceNumber(bareColloquial[1], bareColloquial[2])),
      source: 'rule:colloquial_decimal_price'
    };
  }

  const slash = text.match(new RegExp(`(${chunk})\\s*(?:元|块)?\\s*/\\s*${priceUnit}`));
  if (slash) {
    return {
      value: toCleanNumber(parseChineseNumber(slash[1])),
      source: 'rule:slash_unit_price'
    };
  }

  const bareUnit = text.match(new RegExp(`(${chunk})\\s*(?:一|每)${priceUnit}`));
  if (bareUnit) {
    return {
      value: toCleanNumber(parseChineseNumber(bareUnit[1])),
      source: 'rule:bare_unit_price'
    };
  }

  const explicit = text.match(new RegExp(`(?:单价|价格|报价|报|卖|按)\\s*(${chunk})\\s*(?:块|元)?`));
  if (explicit) {
    return {
      value: toCleanNumber(parseChineseNumber(explicit[1])),
      source: 'rule:explicit_price'
    };
  }

  return { value: '', source: '' };
}

function extractAmount(text) {
  const explicit = text.match(new RegExp(`(?:总价|一共|合计|金额|欠(?:我|款)?|应收|还差|尾款|收了|付了|付款|刚?转了|打款|到账|先打|还我|还了)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还)`));
  if (!explicit) return { value: '', source: '' };
  const amount = parseChineseNumber(`${explicit[1]}${explicit[2] && explicit[2].includes('万') ? '万' : ''}`);
  return {
    value: toCleanNumber(amount),
    source: 'rule:explicit_amount'
  };
}

function extractRemainingAmount(text) {
  const match = text.match(new RegExp(`(?:还剩|剩下|剩余|未收|没收)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?`));
  if (!match) return { value: '', source: '' };
  const amount = parseChineseNumber(`${match[1]}${match[2] && match[2].includes('万') ? '万' : ''}`);
  return {
    value: toCleanNumber(amount),
    source: 'rule:remaining_amount'
  };
}

function extractProduct(text) {
  const known = KNOWN_PRODUCTS.find((item) => text.includes(item));
  if (known) return { value: known, source: 'rule:known_product' };

  const afterQuantity = text.match(new RegExp(`(?:${numberPattern()})\\s*${UNIT_PATTERN}\\s*([\\u4e00-\\u9fa5A-Za-z0-9]{1,18})`));
  if (afterQuantity) {
    const product = afterQuantity[1].replace(PRODUCT_STOP_WORDS, '').replace(/^的|^，/, '');
    if (product) return { value: product, source: 'rule:after_quantity_product' };
  }

  const beforeQuantity = text.match(new RegExp(`(?:问|报|报架|要|订|定|定了|补|做|发)?([\\u4e00-\\u9fa5A-Za-z0-9]{2,18})\\s*(${numberPattern()})\\s*${UNIT_PATTERN}`));
  if (beforeQuantity) {
    const product = beforeQuantity[1]
      .replace(/.*(?:总|老板|经理|姐|哥|先生|女士)/, '')
      .replace(/^(先下|先做|下|做|要|订|定了|定|补|发)/, '')
      .replace(PRODUCT_STOP_WORDS, '')
      .replace(/^的|^，/, '');
    if (product && !/\d/.test(product)) return { value: product, source: 'rule:before_quantity_product' };
  }

  const afterProductWord = text.match(/(?:产品|货|款式|品名)[:：是\s]*([\u4e00-\u9fa5A-Za-z0-9]{2,18})/);
  if (afterProductWord) {
    return {
      value: afterProductWord[1].replace(PRODUCT_STOP_WORDS, ''),
      source: 'rule:product_keyword'
    };
  }

  if (/样品/.test(text)) return { value: '样品', source: 'rule:sample_keyword' };

  return { value: '', source: '' };
}

function extractTodoTitle(text, fields = {}) {
  const customerName = fields.customerName || '';
  const customerShort = customerName ? customerName.replace(/总$/, '') : '';
  const productName = fields.productName || '';
  if (/(回|回复|答复)/.test(text)) {
    if (customerName && productName) return { value: `回复${customerName}${productName}报价`, source: 'rule:todo_reply_quote' };
    if (customerName) return { value: `回复${customerName}`, source: 'rule:todo_reply_customer' };
    return { value: '回复客户', source: 'rule:todo_reply' };
  }
  if (/催/.test(text)) {
    if (customerName && /款|货款|尾款|应收|欠/.test(text)) return { value: `催${customerName}货款`, source: 'rule:todo_dunning' };
    if (customerName) return { value: `催一下${customerName}`, source: 'rule:todo_follow_customer' };
    return { value: '催一下客户', source: 'rule:todo_dunning' };
  }
  if (/跟进/.test(text)) {
    if (customerName && productName) return { value: `跟进${customerName}${productName}`, source: 'rule:todo_follow_product' };
    if (customerName) return { value: `跟进${customerName}`, source: 'rule:todo_follow_customer' };
  }
  const cleaned = text
    .replace(new RegExp(`^(?:${customerShort}|${customerName})?\\s*(?:说|问)?`), '')
    .replace(/(?:今天|明天|明日|后天|大后天|月底|月末|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}月\d{1,2}日?|\d{1,2}号).*/, '')
    .replace(/提醒我|提醒|待会|等下|记得/g, '')
    .replace(/[，,\s]+/g, '');
  if (cleaned) return { value: cleaned.slice(0, 24), source: 'rule:todo_cleaned_text' };
  return { value: customerName ? `跟进${customerName}` : '待办提醒', source: 'rule:todo_default' };
}

function scoreIntent(text, context) {
  if (context === 'query') return { intent: 'query', candidates: ['query'] };
  if (/多少|哪些|谁|有没有|上次|最近|还欠|要交/.test(text) && /[？?]/.test(text)) {
    return { intent: 'query', candidates: ['query'] };
  }

  const scores = {
    quotation: 0,
    order: 0,
    receivable: 0,
    payment: 0,
    dunning: 0,
    todo: 0,
    unknown: 0
  };
  const hasQuantity = new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text);
  const hasTodoSignal = new RegExp(`提醒我|提醒|待会|等下|记得|(?:今天|明天|明日|后天|大后天|月底|月末|下周|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\\d{1,2}号|\\d{1,2}日).*?(?:${TODO_ACTION_WORDS})|给(?:他|她|客户|[\\u4e00-\\u9fa5]{1,4}(?:总|姐|哥|老板|经理))?(?:回|回复)|(?:回|回复)(?:他|她|客户)`).test(text);
  const hasDeliverySignal = /交货|发货|要发|要货|月底交|月末交|交|拿|出/.test(text) || /给(?:他|她)(?!回|回复)/.test(text);
  const hasPriceSignal = /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分)|(?:一|每)(?:个|件|只|条|套|双|张|本|箱)|单价/.test(text);
  const hasStrongQuotationSignal = /报价|报架|报个价|问价|多少钱|问.*(?:价格|价|多少钱)/.test(text);

  if (hasTodoSignal) scores.todo += 7;
  if (/问/.test(text) && /(回|回复|答复)/.test(text) && parseChineseDate(text)) scores.todo += 3;
  if (/收了|已收|转了|付款|打款|到账|还我|还了/.test(text)) scores.payment += 5;
  if (/付了|先打|已结清|结清了/.test(text) || (/结清/.test(text) && !/未结清/.test(text))) scores.payment += 5;
  if (/催|提醒.*款|要款/.test(text)) scores.dunning += 5;
  if (/欠|欠款|应收|还差|先记账|记账|月底结|月底给|月结|尾款|货款/.test(text)) scores.receivable += 4;
  if (/订单|下单|先下|交货|发货|要发|生产|做好|开工|排产|要货|返单|补\d|补[零一二两三四五六七八九十百千万俩]|定了|订|做|周[一二三四五六日天].*(?:拿|出)/.test(text)) scores.order += 4;
  if ((/交|拿|出/.test(text) || /给(?:他|她)(?!回|回复)/.test(text)) && new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text)) scores.order += 4;
  if (hasQuantity && hasDeliverySignal && hasPriceSignal && !hasStrongQuotationSignal) scores.order += 4;
  if (hasStrongQuotationSignal || /单价/.test(text)) scores.quotation += 4;
  if (/报/.test(text) && !hasQuantity) scores.quotation += 1;
  if (/要|订|定|买|拿|补|先下|做|出/.test(text)) scores.order += 1;

  const candidates = Object.keys(scores)
    .filter((key) => key !== 'unknown' && scores[key] > 0)
    .sort((left, right) => scores[right] - scores[left]);

  return {
    intent: candidates[0] || 'unknown',
    candidates: candidates.length ? candidates : ['unknown']
  };
}

function findCustomerCandidates(state, customerName, phone) {
  const customers = state.customers || [];
  if (!customerName && !phone) return [];
  const phoneDigits = String(phone || '').replace(/\s+/g, '');
  const phoneFingerprint = simpleFingerprint(phoneDigits);
  return customers.filter((customer) => {
    const sameName = customerName && customer.name && customer.name.includes(customerName.replace(/总$/, ''));
    const samePhone = phoneFingerprint && customer.phoneFingerprint === phoneFingerprint;
    return sameName || samePhone;
  }).slice(0, 5);
}

function buildMissingFields(intent, fields) {
  const missing = [];
  const requiredByIntent = {
    quotation: ['customerName', 'productName', 'quantity', 'unitPrice'],
    order: ['customerName', 'productName', 'quantity', 'dueDate'],
    receivable: ['customerName', 'amount', 'dueDate'],
    payment: ['customerName', 'paymentAmount'],
    dunning: ['customerName'],
    todo: ['todoTitle', 'dueDate'],
    query: [],
    unknown: ['intent']
  };
  (requiredByIntent[intent] || []).forEach((field) => {
    if (!fields[field]) missing.push(field);
  });
  return missing;
}

function calculateAmount(quantity, unitPrice) {
  if (!quantity || !unitPrice) return '';
  const quantityNumber = Number(quantity);
  const unitPriceNumber = Number(unitPrice);
  if (!Number.isFinite(quantityNumber) || !Number.isFinite(unitPriceNumber)) return '';
  return toCleanNumber(quantityNumber * unitPriceNumber);
}

function buildConfirmMessage(intent, missingFields) {
  const intentLabel = {
    quotation: '报价',
    order: '订单',
    receivable: '应收款',
    payment: '收款',
    dunning: '催款',
    todo: '待办提醒',
    query: '问一句',
    unknown: '待判断'
  }[intent] || '待判断';
  if (missingFields.length) {
    return `我先识别成${intentLabel}草稿，有些信息需要你补一下。`;
  }
  return `我识别成${intentLabel}，你确认后再保存。`;
}

function shouldSuggestAiFallback({ text, confidence, missingFields, source }) {
  const lineCount = String(text || '').split(/\n/).filter(Boolean).length;
  return confidence < 0.72 || lineCount >= 3 || (source === 'paste' && text.length > 80) || missingFields.length >= 2;
}

function parseInput({ text, source = 'typed', context = 'home', state }) {
  const originalText = normalizeOriginalText(text);
  const normalized = normalizeText(text);
  const scoredIntent = scoreIntent(normalized, context);
  const quantity = extractQuantity(normalized);
  const customer = extractCustomerName(normalized);
  const unitPrice = extractUnitPrice(normalized);
  const explicitAmount = extractAmount(normalized);
  const remainingAmount = extractRemainingAmount(normalized);
  const product = extractProduct(normalized);
  const computedAmount = calculateAmount(quantity.quantity, unitPrice.value);
  const paymentAmount = scoredIntent.intent === 'payment' ? explicitAmount.value : '';
  const amount = computedAmount || (scoredIntent.intent === 'payment' ? '' : explicitAmount.value);
  const productName = ['quotation', 'order', 'todo'].includes(scoredIntent.intent) ? product.value : '';
  const date = parseChineseDate(normalized);
  const todoTitle = scoredIntent.intent === 'todo' ? extractTodoTitle(normalized, {
    customerName: customer.value,
    productName
  }) : { value: '', source: '' };
  const fields = {
    customerName: customer.value,
    phone: extractPhone(normalized),
    todoTitle: todoTitle.value,
    productName,
    spec: '',
    quantity: quantity.quantity,
    unit: quantity.unit,
    unitPrice: unitPrice.value,
    paymentAmount,
    amount,
    remainingAmount: remainingAmount.value,
    paymentMethod: /月结/.test(normalized) ? '月结' : (/预付|定金/.test(normalized) ? '预付' : ''),
    dueDate: date,
    quoteDate: today(),
    remark: originalText
  };
  const missingFields = buildMissingFields(scoredIntent.intent, fields);
  const customerCandidates = findCustomerCandidates(state, customer.value, fields.phone);
  const lowConfidenceFields = [];
  if (customerCandidates.length > 1) lowConfidenceFields.push('customerName');
  if (!fields.dueDate && /月底|明天|今天|后|下周|下个月|号|日|交|结|到期/.test(normalized)) lowConfidenceFields.push('dueDate');
  if (!fields.unitPrice && /上次|原价|还是|按上次/.test(normalized)) lowConfidenceFields.push('unitPrice');

  const confidence = Math.max(
    0.35,
    0.96
      - missingFields.length * 0.13
      - lowConfidenceFields.length * 0.1
      - (scoredIntent.intent === 'unknown' ? 0.18 : 0)
  );
  const computedFields = computedAmount ? ['amount'] : [];
  const computedTips = computedAmount ? ['总价由数量 × 单价自动计算，可修改。'] : [];

  return {
    id: `parse_${Date.now()}`,
    intent: scoredIntent.intent,
    fields,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields,
    customer_candidates: customerCandidates,
    confidence,
    confirm_message: buildConfirmMessage(scoredIntent.intent, missingFields),
    source,
    original_text: originalText,
    computed_fields: computedFields,
    computed_tips: computedTips,
    field_sources: {
      customerName: customer.source,
      todoTitle: todoTitle.source,
      productName: productName ? product.source : '',
      quantity: quantity.source,
      unit: quantity.source,
      unitPrice: unitPrice.source,
      paymentAmount: paymentAmount ? explicitAmount.source : '',
      amount: computedAmount ? 'rule:quantity_times_unit_price' : (amount ? explicitAmount.source : ''),
      remainingAmount: remainingAmount.source,
      dueDate: date ? 'rule:date_phrase' : ''
    },
    intent_candidates: scoredIntent.candidates,
    ai_fallback: {
      needed: shouldSuggestAiFallback({
        text: normalized,
        confidence,
        missingFields,
        source
      }),
      status: 'not_requested'
    },
    createdAt: new Date().toISOString()
  };
}

module.exports = {
  parseInput,
  shouldSuggestAiFallback
};
