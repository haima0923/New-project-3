const { parseChineseDate, parseChineseDateDetail, today } = require('./date');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const { simpleFingerprint } = require('./storage');
const { normalizeBusinessText } = require('./text-normalize');
const { applyLocalParseSafety } = require('./parse-safety');
const { RAW_UNIT_PATTERN, UNIT_PATTERN, isSupportedUnit, normalizeUnit, unitsMatch } = require('./units');

const PRODUCT_STOP_WORDS = /(价格|报价|报架|单价|订单|交货|发货|生产|做好|到期|月底|月结|结款|付款|欠款|定金|订金|预付|先记|记一下|三天后|下周|礼拜|星期|周[一二三四五六日天]).*$/;
const KNOWN_PRODUCTS = [
  '卡通水杯',
  '老款杯垫',
  '五金挂件',
  '文具套装',
  '包装袋',
  '手提袋',
  '笔袋',
  '纸袋',
  '收纳盒',
  '小夜灯',
  '饰品盒',
  '玩具车',
  '钥匙扣',
  '拖鞋',
  '礼品盒',
  '饭盒',
  '发夹',
  '发圈',
  '椅子',
  '水杯',
  '保温杯',
  '杯垫',
  '杯子',
  '勺子',
  '箱子',
  '扣子',
  '头绳',
  '贴纸',
  '饰品',
  '玩具',
  '五金',
  '箱包',
  '文具',
  '日用品',
  '家电',
  '挂件',
  '笔'
];
const CUSTOMER_ACTION_PATTERN = '那边|这边|说|问|欠|欠款|尾款|货款|定金|订金|预付|预付款|还差|还我|还了|还|付|付款|转|打款|到账|先打|下单|先下|下|要|要发|问|报|报架|订|定|定了|买|拿|补|返单|做|收';
const CUSTOMER_ORGANIZATION_SUFFIX_PATTERN = '工厂|厂|公司|商行|经营部|工作室|合作社';
const CUSTOMER_ORGANIZATION_DATE_PATTERN = '(?:今天|昨天|明天|后天|刚才|刚刚|现在|这会儿|\\d{1,2}月\\d{1,2}[日号]?)';
const CUSTOMER_ORGANIZATION_REPORT_PATTERN = '(?:说|表示|确认|来|又)';
const CUSTOMER_ORGANIZATION_BRIDGE_PATTERN = `(?:(?:${CUSTOMER_ORGANIZATION_DATE_PATTERN})?(?:${CUSTOMER_ORGANIZATION_REPORT_PATTERN})?|(?:${CUSTOMER_ORGANIZATION_REPORT_PATTERN})(?:${CUSTOMER_ORGANIZATION_DATE_PATTERN})?)`;
const CUSTOMER_ORGANIZATION_ACTION_PATTERN = `${CUSTOMER_ORGANIZATION_BRIDGE_PATTERN}(?:下单|订货|订购|要货|返单|补单|采购|买|要|订|定|拿|做)`;
const CUSTOMER_ORGANIZATION_LEADING_TOKEN_PATTERN = `(?:请|麻烦|${CUSTOMER_ORGANIZATION_DATE_PATTERN})`;
const TODO_ACTION_WORDS = '回|回复|答复|跟进|问|催|联系|提醒|确认|发对账单';
const DEPOSIT_PATTERN = /定金|订金|预付|预付款/;
const DEPOSIT_PAYMENT_PATTERN = /定金|订金|预付|预付款|先付|先打|先转/;
const DECIMAL_DIGIT = '\\d|[零一二两三四五六七八九]';
const ITEM_BAD_PRODUCT_PATTERN = /(?:价格|单价|报价|多少钱|颜色|色差|包装(?!袋|盒|纸)|外箱|内盒|logo|特殊|要求|备注|交期|交货|发货|到期|明天|后天|下周|月底|月末|定金|订金|预付|尾款|货款)/i;
const ITEM_EXACT_BAD_PRODUCT_PATTERN = /^(?:块|块钱|元|元钱|毛|毛钱|角|分钱|分|钱|一个|每个|可以|能不能|单价|价格|报价|老板|客户|我|对方|客服|买家|卖家|厂家|工厂|业务员)$/;
const EXPLICIT_NON_RECORD_PATTERN = /(?:电话你有吗|等会儿看看仓库|还有没有位置|价格以后再谈|样品找出来|先不要做|先别做|暂时别做|等(?:明天|后天|下周|周[一二三四五六日天]|通知)|(?:另外|还有).{0,24}(?:刚(?:微信)?打了|刚转了|打了|转了|收了|付了|还差))/;
const TERMINATION_PATTERN = /(?:取消(?:了|掉)?|客户取消|不要做了?|不用做了?|不做了?|不要了|别做了?|先别做|先不要做|先停(?:一下)?|停一下|停止|暂停|作废|撤销|撤回|先别发|暂时别发|等通知|等(?:他|她|客户)?重新确认)/;
const REPLACEMENT_AFTER_TERMINATION_PATTERN = /(?:取消|不要|别做|先别做|撤回)[^。；;\n]{0,30}(?:改成|改为|换成|变成)|(?:改成|改为|换成|变成)[^。；;\n]{0,30}(?:取消|不要|别做|撤回)/;
const SPEC_TOKEN_PATTERN = '(?:紫色|红色|蓝色|绿色|黄色|橙色|粉色|黑色|白色|灰色|金色|银色|透明|本色|米色|咖色|棕色|藏青|酒红|玫红|大号|中号|小号|加大|加小|长款|短款|圆形|方形|新款|老款|带盖|无盖|磁吸|欧规|美规|英规|日规|国标|非标|[A-Za-zＡ-Ｚａ-ｚ0-9０-９]{1,6}款|(?:XS|S|M|L|XL|XXL|XXXL)码?)';

function normalizeText(text) {
  return normalizeBusinessText(text)
    .replace(/[，。；;]/g, '，')
    .replace(/((?:单价|价格|报价|报|卖|按)\s*\d+\.\d)([1-9])(?=天后)/g, '$1，$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOriginalText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getPaymentClauses(text) {
  return String(text || '')
    .split(/[，,。；;\n]|(?=(?:今天|现在|刚刚)(?:已(?:经)?)?(?:到账|收到|付款|付了|打款|转账))/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasNonFinancialReceiveSignal(text) {
  const amount = numberPattern();
  return getPaymentClauses(text).some((clause) => (
    /收到[^，,。；;\n]{0,10}(?:货(?!款)|报价|消息|样品|文件|通知|快递|订单(?!款|的钱))/.test(clause)
    || new RegExp(`收到[^，,。；;\\n]{0,4}(?:${amount})\\s*(?:${UNIT_PATTERN}|批|次|笔|份)(?!\\s*(?:(?:${amount})\\s*)?(?:元|块|块钱|万元))`).test(clause)
  ));
}

function hasNonFinancialPaymentActionSignal(text) {
  const amount = numberPattern();
  return getPaymentClauses(text).some((clause) => (
    /(?:打了|刚打)[^，,。；;\n]{0,8}(?:电话|样品|打样)|(?:还了|给了)[^，,。；;\n]{0,8}(?:货(?!款)|样品|文件)|(?:文件|报价|订单)[^，,。；;\n]{0,8}转(?:了|过来)?|转(?:了|过来)?[^，,。；;\n]{0,8}(?:文件|报价|订单)/.test(clause)
    || new RegExp(`(?:打款|打了|刚打|转了|刚转|收了|收到)[^，,。；;\\n]{0,4}(?:${amount})\\s*(?:${UNIT_PATTERN}|次|笔|份)(?!\\s*(?:(?:${amount})\\s*)?(?:元|块|块钱|万元))`).test(clause)
  ));
}

function hasNegativeOrFuturePaymentSignal(text) {
  return /(?:没|未|没有|尚未|还没|并未)[^，,。；;\n]{0,8}(?:收(?:到|款)?|付(?:款)?|打款|转账|到账)|(?:准备|打算|计划|等待?|等着|等客户|将要|之后再|以后再)[^，,。；;\n]{0,8}(?:收(?:款)?|付(?:款)?|打款|转账|到账)/.test(String(text || ''));
}

function hasExplicitCompletedPaymentSignal(text) {
  const source = String(text || '');
  return getPaymentClauses(source).some((clause) => {
    if (DEPOSIT_PATTERN.test(clause)) return false;
    if (hasNegativeOrFuturePaymentSignal(clause)) return false;
    if (extractPaymentAmount(clause).value) return true;
    if (hasNonFinancialReceiveSignal(clause) || hasNonFinancialPaymentActionSignal(clause)) return false;
    const financialObjectCompleted = /(?:货款|尾款|款项|这笔钱|这单的钱|订单的钱)[^，,。；;\n]{0,8}(?:已(?:经)?到账|到账了?|收了|已收|付了|已付)/.test(clause)
      || /(?:收了|已收|收到|付了|已付)[^，,。；;\n]{0,6}(?:一点)?(?:钱|货款|尾款|款项)/.test(clause);
    const intrinsicallyFinancialCompletion = /(?:已(?:经)?付款|付款了|刚(?:刚)?打款|打款了)(?!方式)/.test(clause);
    return financialObjectCompleted || intrinsicallyFinancialCompletion;
  });
}

function extractReceivableAmount(text) {
  const source = String(text || '');
  if (DEPOSIT_PATTERN.test(source) || hasExplicitCompletedPaymentSignal(source)) {
    return { value: '', source: '' };
  }
  const amount = numberPattern();
  const moneyUnit = '(万元|元|块钱|块)?';
  const nonMoneyUnit = `(?:${UNIT_PATTERN}|次|笔|份|月|日|号)`;
  const amountBeforeStatus = source.match(new RegExp(
    `(${amount})\\s*${moneyUnit}\\s*(?:待收(?:款)?|未收|没收|尚未收|还没收|未付|没付|尚未付|还没付|欠付)(?=$|[，,。；;\\s]|，)`
  ));
  const outstandingBeforeAmount = source.match(new RegExp(
    `(?:还欠|尚欠)(?:货款|款项|款)?\\s*(${amount})\\s*${moneyUnit}(?!\\s*${nonMoneyUnit})`
  )) || source.match(new RegExp(
    `(?:待收(?:款|金额)|应收款?|欠款|余款|尾款|剩余款|货款)(?:还有|尚有|剩余|还剩|为|是|未收|没收|未付|没付|待收)?\\s*(${amount})\\s*${moneyUnit}(?!\\s*${nonMoneyUnit})`
  ));
  const match = amountBeforeStatus || outstandingBeforeAmount;
  if (!match) return { value: '', source: '' };
  return {
    value: toCleanNumber(parseChineseNumber(
      `${match[1]}${match[2] && match[2].includes('万') && !String(match[1]).includes('万') ? '万' : ''}`
    )),
    source: 'rule:explicit_receivable_amount'
  };
}

function hasExplicitReceivableSignal(text) {
  const source = String(text || '');
  if (DEPOSIT_PATTERN.test(source)) return false;
  if (hasExplicitCompletedPaymentSignal(source)) return false;
  if (/(?:提醒我|提醒|别忘了|记得|催|要款)/.test(source)) return false;
  if (extractReceivableAmount(source).value) return true;
  return /(?:待收款|应收款|欠款|还欠|尚欠|欠付|余款|尾款|货款)[^，,。；;\n]{0,10}(?:待收|未收|没收|未付|没付|尚未|还没|还有|尚有|剩余|还剩)/.test(source)
    || /(?:还有|尚有|剩余|还剩)[^，,。；;\n]{0,10}(?:待收款|应收款|欠款|余款|尾款|货款)/.test(source);
}

function buildRemarkText(originalText) {
  const normalized = normalizeOriginalText(normalizeBusinessText(originalText))
    .replace(/[,，]{2,}/g, '，')
    .replace(/,/g, '，');
  const comparableOriginal = String(originalText || '').replace(/[，,。；;\s]/g, '');
  const comparableNormalized = String(normalized || '').replace(/[，,。；;\s]/g, '');
  if (!normalized || normalized === originalText || comparableNormalized === comparableOriginal) return originalText;
  return `${originalText}\n\n规范化文本：${normalized}`;
}

function toCleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNegatedOrderReference(text, start, length) {
  const source = String(text || '');
  const prefix = source.slice(Math.max(0, start - 16), start);
  const suffix = source.slice(start + length, start + length + 16);
  const negativePrefix = /(?:不是|并非|不算|不属于|不关联|无需关联|不用关联|不要关联|排除)(?:之前|上次|上回|旧|原来|刚才)?(?:的)?\s*$/;
  const negativeSuffix = /^\s*(?:不是|并非|不算|不属于|不关联|无需关联|不用关联|不要关联)/;
  return negativePrefix.test(prefix) || negativeSuffix.test(suffix);
}

function buildMatchedOrderRelationReference(text, match, details, options = {}) {
  const sourceText = String(match && match[0] || '');
  if (!match
    || match.index === undefined
    || isNegatedOrderReference(text, match.index, sourceText.length)) {
    return null;
  }
  return {
    entityType: 'ORDER',
    kind: details.kind,
    explicit: true,
    requiresResolution: true,
    sourceText,
    sourceSpan: {
      start: match.index,
      end: match.index + sourceText.length
    },
    confidence: details.confidence,
    normalizedReference: details.normalizedReference,
    resolvedEntityId: null,
    evidenceSource: 'LOCAL_PARSER',
    sourceField: options.sourceField || 'ORIGINAL_TEXT'
  };
}

function buildMatchedQuotationRelationReference(match, details, options = {}) {
  const sourceText = String(match && match[0] || '');
  if (!match || match.index === undefined || !sourceText) return null;
  return {
    entityType: 'QUOTATION',
    kind: details.kind,
    explicit: true,
    requiresResolution: true,
    sourceText,
    sourceSpan: {
      start: match.index,
      end: match.index + sourceText.length
    },
    confidence: details.confidence,
    normalizedReference: details.normalizedReference,
    resolvedEntityId: null,
    evidenceSource: 'LOCAL_PARSER',
    sourceField: options.sourceField || 'ORIGINAL_TEXT'
  };
}

function extractQuotationRelationReference(text, options = {}) {
  if (!options.hasQuotationToOrderConversion) return null;
  const source = String(text || '');
  const sourceField = options.sourceField || 'ORIGINAL_TEXT';
  const customerName = String(options.customerName || '');
  const productName = String(options.productName || '');
  let match;

  if (customerName && productName) {
    match = new RegExp(
      `${escapeRegExp(customerName)}(?:的|那个|这个|那份|这份|那张|这张)?${escapeRegExp(productName)}(?:的)?报价单?`
    ).exec(source);
    if (match) {
      return buildMatchedQuotationRelationReference(match, {
        kind: 'EXPLICIT_QUOTATION_NAMED_REFERENCE',
        confidence: 0.97,
        normalizedReference: `${customerName}:${productName}:QUOTATION`
      }, { sourceField });
    }
  }

  if (customerName) {
    match = new RegExp(
      `${escapeRegExp(customerName)}(?:的|那个|这个|那份|这份|那张|这张)报价单?`
    ).exec(source);
    if (match) {
      return buildMatchedQuotationRelationReference(match, {
        kind: 'EXPLICIT_QUOTATION_NAMED_REFERENCE',
        confidence: 0.97,
        normalizedReference: `${customerName}:QUOTATION`
      }, { sourceField });
    }
  }

  if (productName) {
    match = new RegExp(`${escapeRegExp(productName)}(?:的)?报价单?`).exec(source);
    if (match) {
      return buildMatchedQuotationRelationReference(match, {
        kind: 'EXPLICIT_QUOTATION_NAMED_REFERENCE',
        confidence: 0.95,
        normalizedReference: `${productName}:QUOTATION`
      }, { sourceField });
    }
  }

  const deicticPatterns = [
    {
      pattern: /这张报价|这份报价|这个报价/,
      normalizedReference: 'THIS_QUOTATION'
    },
    {
      pattern: /那张报价|那份报价|那个报价/,
      normalizedReference: 'THAT_QUOTATION'
    }
  ];
  for (const item of deicticPatterns) {
    match = item.pattern.exec(source);
    if (match) {
      return buildMatchedQuotationRelationReference(match, {
        kind: 'EXPLICIT_QUOTATION_DEICTIC',
        confidence: 0.99,
        normalizedReference: item.normalizedReference
      }, { sourceField });
    }
  }
  return null;
}

function extractOrderRelationReference(text, options = {}) {
  if (options.intent !== 'receivable') return null;
  const source = String(text || '');
  const sourceField = options.sourceField || 'ORIGINAL_TEXT';

  const identifier = /(?:订单号|订单编号|单号)\s*[:：#-]?\s*([A-Za-z0-9][A-Za-z0-9_-]{1,31})/g;
  let match;
  while ((match = identifier.exec(source))) {
    const reference = buildMatchedOrderRelationReference(source, match, {
      kind: 'EXPLICIT_ORDER_IDENTIFIER',
      confidence: 0.99,
      normalizedReference: `ORDER_IDENTIFIER:${String(match[1]).toUpperCase()}`
    }, { sourceField });
    if (reference) return reference;
  }

  const customerName = String(options.customerName || '');
  const productName = String(options.productName || '');
  if (customerName && productName) {
    const namedPattern = new RegExp(
      `${escapeRegExp(customerName)}(?:的)?${escapeRegExp(productName)}订单`
    );
    match = namedPattern.exec(source);
    if (match) {
      const reference = buildMatchedOrderRelationReference(source, match, {
        kind: 'EXPLICIT_ORDER_NAMED_REFERENCE',
        confidence: 0.97,
        normalizedReference: `${customerName}:${productName}:ORDER`
      }, { sourceField });
      if (reference) return reference;
    }
  }
  if (productName) {
    const historicalNamedPattern = new RegExp(
      `(?:上次|之前)(?:的)?${escapeRegExp(productName)}(?:那张|那笔|的)?订单`
    );
    match = historicalNamedPattern.exec(source);
    if (match) {
      const reference = buildMatchedOrderRelationReference(source, match, {
        kind: 'EXPLICIT_ORDER_NAMED_REFERENCE',
        confidence: 0.97,
        normalizedReference: `PREVIOUS:${productName}:ORDER`
      }, { sourceField });
      if (reference) return reference;
    }
  }

  const deicticPatterns = [
    {
      pattern: /之前(?:的)?那张订单|上次(?:的)?那张订单|之前(?:的)?那单|上次(?:的)?那单|上一次订单|上一单|刚才那单/,
      normalizedReference: 'PREVIOUS_ORDER'
    },
    {
      pattern: /这张订单|这单/,
      normalizedReference: 'THIS_ORDER'
    },
    {
      pattern: /那张订单|那单/,
      normalizedReference: 'THAT_ORDER'
    }
  ];
  for (const item of deicticPatterns) {
    match = item.pattern.exec(source);
    if (!match) continue;
    const reference = buildMatchedOrderRelationReference(source, match, {
      kind: 'EXPLICIT_ORDER_DEICTIC',
      confidence: 0.99,
      normalizedReference: item.normalizedReference
    }, { sourceField });
    if (reference) return reference;
  }
  return null;
}

function extractPhone(text) {
  const match = text.match(/1[3-9]\d{9}/);
  return match ? match[0] : '';
}

function cleanCustomerName(value) {
  let cleaned = String(value || '')
    .replace(/^(?:(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩]+)\s*)?(?:元|块)/, '')
    .replace(/^(今天|明天|明日|后天|大后天|晚上|上午|下午|礼拜[一二三四五六日天]|星期[一二三四五六日天]|周[一二三四五六日天]|下周[一二三四五六日天]?|下个月\d{1,2}号?|号)/, '')
    .replace(/^(刚才|刚刚|别忘了|提醒我|提醒|记得|报给|报价给|发给|卖给|转给|给|帮|找|问|回一下|回|催|联系|那个|这个|义乌|客户|收到|收)/, '')
    .replace(/(那单|那笔|上一笔|上次).*$/, '')
    .trim();
  for (let index = 0; index < 3; index += 1) {
    cleaned = cleaned
      .replace(/^(别忘了|提醒我|提醒|记得|报给|报价给|发给|卖给|转给|给|帮|找|问|回一下|回|催|联系)/, '')
      .trim();
  }
  const oldNameWithAction = cleaned.match(/^(老[\u4e00-\u9fa5]{1,2}?)(?:要|问|欠|付|转|补|返单|做|收)$/);
  if (oldNameWithAction) cleaned = oldNameWithAction[1];
  if (!cleaned) return '';
  // “老板今天要……”里的“老板”是说话对象，不是客户名。不能把日期的一部分吞进客户名。
  if (/^老板(?:今|明|昨|后|早|晚|今天|明天|后天|大后天)/.test(cleaned)) return '';
  if (/^(客户|老客户|这个客户|那个客户|老板|昨天|昨天没|今天|明天|后天|刚|刚才|刚刚|又|义乌|那笔|上一笔|不|不要|先|再|还有|另外|那个|这个)$/.test(cleaned)) return '';
  if (/客户/.test(cleaned) && !/(总|老板|经理|姐|哥|先生|女士)$/.test(cleaned)) return '';
  if (/(?:报价|订单)/.test(cleaned)
    && !/(总|老板|经理|姐|哥|先生|女士)$/.test(cleaned)) return '';
  if (/^(今天|明天|后天|月底|下周|下个月)$/.test(cleaned)) return '';
  return cleaned;
}

function extractShortCustomerName(text) {
  const source = String(text || '');
  // “老王 / 阿强”没有称呼后缀时，只在紧挨业务动作、价格或聊天位置的场景下识别。
  const match = source.match(/(?:^|[，,：:\s给催元])((?:老(?!板)|阿)[\u4e00-\u9fa5]{1,2})(?=(?:那个|那边|这边|这单|那批|上次|的|刚|要|说|下|订|定|报|问|欠|还差|付|转|打|收|回|催|提醒|来|今天|明天|后天|下周|这周|周[一二三四五六日天]|水杯|礼品盒|钥匙扣|杯垫|包装袋|收纳盒|头绳|饰品盒|五金挂件|椅子|拖鞋|纸袋|\d|[，,。；;\s]|$))/);
  if (!match) return { value: '', source: '' };
  const value = cleanCustomerName(match[1]);
  return value ? { value, source: 'rule:customer_short_name' } : { value: '', source: '' };
}

function stripCustomerLeadingTokens(value) {
  const leadingTokenPattern = new RegExp(`^${CUSTOMER_ORGANIZATION_LEADING_TOKEN_PATTERN}\\s*`);
  let result = String(value || '').trim();
  let next = result.replace(leadingTokenPattern, '');
  while (next !== result) {
    result = next;
    next = result.replace(leadingTokenPattern, '');
  }
  return result;
}

function isGenericOrganizationCustomerName(value) {
  return /^(?:我们厂|咱们厂|自己厂|本厂|厂家|工厂|公司|本公司|我司)$/.test(String(value || ''));
}

function stripOrganizationCustomerLeadingTokens(value) {
  let result = String(value || '').trim();
  const numericDatePattern = /^\d{1,2}月\d{1,2}[日号]?\s*/;
  const relativeDatePattern = /^(?:今天|昨天|明天|后天|刚才|刚刚|现在|这会儿)\s*/;
  result = result.replace(numericDatePattern, '');
  result = result.replace(/^(?:今天|昨天|明天|后天|刚才|刚刚|现在|这会儿)\s*(?:请|麻烦)\s*/, '');

  const courtesy = result.match(/^(?:请|麻烦)\s*(.*)$/);
  if (!courtesy) return result;
  const remainder = String(courtesy[1] || '')
    .replace(numericDatePattern, '')
    .replace(relativeDatePattern, '');
  const organization = remainder.match(new RegExp(
    `^([\\u4e00-\\u9fa5A-Za-z0-9]{0,16}?(?:${CUSTOMER_ORGANIZATION_SUFFIX_PATTERN}))(?=${CUSTOMER_ORGANIZATION_ACTION_PATTERN})`
  ));
  if (!organization) return result;
  const candidate = cleanCustomerName(organization[1]);
  return candidate && (candidate.length >= 4 || isGenericOrganizationCustomerName(candidate))
    ? remainder
    : result;
}

function hasAmbiguousOrganizationLeadingToken(value) {
  const source = String(value || '').trim();
  const relativeDate = source.match(/^(?:今天|昨天|明天|后天|刚才|刚刚|现在|这会儿)\s*(.*)$/);
  if (relativeDate && !/^(?:请|麻烦)/.test(relativeDate[1])) {
    return new RegExp(
      `^[\\u4e00-\\u9fa5A-Za-z0-9]{0,16}?(?:${CUSTOMER_ORGANIZATION_SUFFIX_PATTERN})(?=${CUSTOMER_ORGANIZATION_ACTION_PATTERN})`
    ).test(relativeDate[1]);
  }

  const courtesy = source.match(/^(?:请|麻烦)\s*(.*)$/);
  if (!courtesy) return false;
  const remainder = String(courtesy[1] || '')
    .replace(/^\d{1,2}月\d{1,2}[日号]?\s*/, '')
    .replace(/^(?:今天|昨天|明天|后天|刚才|刚刚|现在|这会儿)\s*/, '');
  const organization = remainder.match(new RegExp(
    `^([\\u4e00-\\u9fa5A-Za-z0-9]{0,16}?(?:${CUSTOMER_ORGANIZATION_SUFFIX_PATTERN}))(?=${CUSTOMER_ORGANIZATION_ACTION_PATTERN})`
  ));
  if (!organization) return false;
  const candidate = cleanCustomerName(organization[1]);
  return Boolean(candidate && candidate.length < 4 && !isGenericOrganizationCustomerName(candidate));
}

function extractOrganizationCustomerName(text) {
  const source = String(text || '');
  const organizationPattern = new RegExp(
    `^([\\u4e00-\\u9fa5A-Za-z0-9]{0,16}?(?:${CUSTOMER_ORGANIZATION_SUFFIX_PATTERN}))(?=${CUSTOMER_ORGANIZATION_ACTION_PATTERN})`
  );
  const clauses = source.split(/[，,。；;\n]/);

  for (let index = 0; index < clauses.length; index += 1) {
    const rawClause = String(clauses[index] || '').trim();
    if (hasAmbiguousOrganizationLeadingToken(rawClause)) {
      return { value: '', source: '', matched: true };
    }
    const clause = stripOrganizationCustomerLeadingTokens(rawClause);
    const match = clause.match(organizationPattern);
    if (!match) continue;
    const value = clause === rawClause
      && /^(?:今天|昨天|明天|后天|刚才|刚刚|现在|这会儿)/.test(match[1])
      ? String(match[1]).trim()
      : cleanCustomerName(match[1]);
    if (!value || isGenericOrganizationCustomerName(value)) {
      return { value: '', source: '', matched: true };
    }
    return { value, source: 'rule:customer_organization_action', matched: true };
  }
  return { value: '', source: '', matched: false };
}

function extractCustomerName(text) {
  if (/^(?:刚才|刚刚)?(?:那单|那笔|上一笔|上次)/.test(text)) {
    return { value: '', source: '' };
  }

  const oldPrefix = text.match(/^(?:刚才|刚刚|那个|这个|义乌)?(老(?!板)[\u4e00-\u9fa5]{1,2}?)(?=[\u4e00-\u9fa5]{0,10}(?:那单|那笔|问|要|再来|欠|付|转|打款|到账|返单|补|做|收|尾款|货款|玩具|杯垫|杯子))/);
  if (oldPrefix) {
    const name = cleanCustomerName(oldPrefix[1]);
    if (name) return { value: name, source: 'rule:customer_old_prefix' };
  }
  const shortName = extractShortCustomerName(text);
  if (shortName.value) return shortName;
  const disposalDirected = text.match(
    /^(?:请|麻烦)?(?:把|将)\s*([\u4e00-\u9fa5A-Za-z]{1,8}?(?:总|老板|经理|姐|哥|先生|女士))(?=那个|这个|那份|这份|那张|这张|的|报价|订单)/
  );
  if (disposalDirected) {
    const name = cleanCustomerName(disposalDirected[1]);
    if (name) return { value: name, source: 'rule:customer_disposal_title' };
  }
  const directed = text.match(/(?:报价给|报给|发给|卖给|转给|给|帮|找)\s*([\u4e00-\u9fa5A-Za-z]{1,8}?(?:总|老板|经理|姐|哥|先生|女士))/);
  if (directed) {
    const name = cleanCustomerName(directed[1]);
    if (name) return { value: name, source: 'rule:customer_directed_title' };
  }
  const direct = stripCustomerLeadingTokens(text).match(/([\u4e00-\u9fa5A-Za-z]{1,8}?(?:总|老板|经理|姐|哥|先生|女士))/);
  if (direct) {
    const name = cleanCustomerName(direct[1]);
    if (name) return { value: name, source: 'rule:customer_title' };
  }
  const organization = extractOrganizationCustomerName(text);
  if (organization.matched) return organization;
  const oldName = text.match(new RegExp(`(老(?!板)[\\u4e00-\\u9fa5]{1,2}?)(?:${CUSTOMER_ACTION_PATTERN})`));
  if (oldName) {
    const name = cleanCustomerName(oldName[1]);
    if (name) return { value: name, source: 'rule:customer_action' };
  }
  const fallback = text.match(new RegExp(`([\\u4e00-\\u9fa5]{1,4})(?:${CUSTOMER_ACTION_PATTERN})`));
  if (!fallback) return { value: '', source: '' };
  if (/^(?:把|将)/.test(fallback[1])) return { value: '', source: '' };
  const name = cleanCustomerName(fallback[1].replace(/^(给|帮|找|客户|那个)/, ''));
  if (!name) return { value: '', source: '' };
  return { value: name, source: 'rule:customer_action' };
}

function extractQuantity(text) {
  const packageQuantity = extractPackageQuantity(text);
  if (packageQuantity.quantity) return packageQuantity;

  const finalQuantity = extractFinalQuantity(text);
  if (finalQuantity.quantity) return finalQuantity;

  const changeMatch = text.match(new RegExp(`(?:改成|改)\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`));
  if (changeMatch) {
    const parsed = parseQuantityWithUnit(changeMatch[1], changeMatch[2]);
    return {
      quantity: parsed.quantity,
      unit: parsed.unit,
      source: 'rule:changed_quantity'
    };
  }

  const explicitQuantity = text.match(new RegExp(`(?:数量|数)\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})?`));
  if (explicitQuantity) {
    const rawUnit = explicitQuantity[2] || '';
    const parsed = parseQuantityWithUnit(explicitQuantity[1], rawUnit);
    return {
      quantity: parsed.quantity,
      unit: parsed.unit,
      source: 'rule:explicit_quantity'
    };
  }

  const matches = Array.from(text.matchAll(new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`, 'g')));
  const match = matches.find((item) => {
    const parsedQuantity = parseQuantityWithUnit(item[1], item[2]);
    const rawUnit = parsedQuantity.unit;
    const parsed = Number(parsedQuantity.quantity);
    const prefix = text.slice(Math.max(0, item.index - 8), item.index);
    if (!Number.isInteger(parsed) && parsed > 0 && parsed < 100 && /^(?:个|件|只|条|套|双|张|本|箱)$/.test(rawUnit)) return false;
    if (/(?:价格|单价|块|元|毛|角|分)$/.test(prefix)) return false;
    if (parsed === 1 && /(?:块|元|毛|角|分|钱|单价|价格|报价)$/.test(prefix)) return false;
    if (parsed === 1 && /^(?:一|每)(?:个|件|只|条|套|双|张|本|箱)$/.test(item[0])) return false;
    return !(rawUnit === '批' && parsed === 1);
  });
  if (!match) return { quantity: '', unit: '', source: '' };
  const parsed = parseQuantityWithUnit(match[1], match[2]);
  return {
    quantity: parsed.quantity,
    unit: parsed.unit,
    source: 'rule:quantity_unit'
  };
}

function extractPackageQuantity(text) {
  const match = text.match(new RegExp(`(${numberPattern()})\\s*(包|盒|箱|袋)\\s*[，,。；;\\s]*(?:每|一)\\s*\\2\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`))
    || text.match(new RegExp(`(${numberPattern()})\\s*(包|盒|箱|袋).*?(?:每|一)\\s*\\2\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`));
  if (!match) return { quantity: '', unit: '', source: '' };
  const outer = parseChineseNumber(match[1]);
  const inner = parseChineseNumber(match[3]);
  if (!Number.isFinite(outer) || !Number.isFinite(inner)) return { quantity: '', unit: '', source: '' };
  return {
    quantity: toCleanNumber(outer * inner),
    unit: normalizeUnit(match[4]),
    source: 'rule:package_multiplier_quantity'
  };
}

function extractFinalQuantity(text) {
  const correction = text.match(new RegExp(`(?:哦\s*)?(?:不对|不是)\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})?`));
  if (correction) {
    const rawUnit = correction[2] || '';
    // “不是 4.8，最后按 3.8 一个”是在改价格；没有数量单位的小数不能抢走原数量。
    if (!rawUnit && String(correction[1] || '').includes('.')) return { quantity: '', unit: '', source: '' };
    const parsed = parseQuantityWithUnit(correction[1], rawUnit);
    return {
      quantity: parsed.quantity,
      unit: parsed.unit,
      source: 'rule:corrected_quantity'
    };
  }
  const matches = Array.from(text.matchAll(new RegExp(`(?:最后(?:确认)?|最终|一共|总共|合计|改成|改为|变成|确认)\\D{0,12}?(${numberPattern()})\\s*(${UNIT_PATTERN})?`, 'g')));
  const match = matches.find((item) => /一共|总共|合计|最后|最终/.test(item[0])) || matches[matches.length - 1];
  if (!match) return { quantity: '', unit: '', source: '' };
  const prefix = text.slice(Math.max(0, match.index - 12), match.index + match[0].length);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
  if (/^\s*(?:块|元|毛|角|分|钱)\s*(?:一|每|\/)/.test(after)) return { quantity: '', unit: '', source: '' };
  if (/(?:价格|单价|块|元|毛|角|分)/.test(prefix) && (!match[2] || isSupportedUnit(match[2]))) {
    return { quantity: '', unit: '', source: '' };
  }
  const rawUnit = match[2] || '';
  // “最终 20 / 最终 0.08”没有数量单位时不够安全，常见含义是最终单价；不能抢走前面的数量。
  if (!rawUnit) return { quantity: '', unit: '', source: '' };
  const parsed = parseQuantityWithUnit(match[1], rawUnit);
  return {
    quantity: parsed.quantity,
    unit: parsed.unit,
    source: 'rule:final_quantity'
  };
}

function extractQuantityAfterKnownProduct(text) {
  const products = KNOWN_PRODUCTS.slice().sort((left, right) => right.length - left.length);
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${product}\\s*(${numberPattern()})(?!\\s*(?:块|元|毛|角|分|\\.|/))`));
    if (match) {
      return {
        quantity: toCleanNumber(parseChineseNumber(match[1])),
        unit: '',
        source: 'rule:product_followed_number_quantity'
      };
    }
  }
  return { quantity: '', unit: '', source: '' };
}

function parsePriceNumber(whole, decimal) {
  const left = parseChineseNumber(whole);
  if (!decimal) return left;
  const right = parseChineseNumber(decimal);
  if (!Number.isFinite(right)) return left;
  return right >= 10 ? left + (right / 100) : Number(`${left}.${right}`);
}

function parseFenPriceNumber(fen, li) {
  const left = parseChineseNumber(fen);
  const right = li ? parseChineseNumber(li) : 0;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
  return (left + (right / 10)) / 100;
}

function extractUnitPrice(text) {
  const priceUnit = RAW_UNIT_PATTERN;
  const chunk = numberPattern();
  const correctedUnitPrice = text.match(new RegExp(`(?:价格|单价|报价|价)[^，,。；;]{0,16}?(?:不是|不对)\\s*(?:${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:是|改成|应为)?\\s*(${chunk})`))
    || text.match(new RegExp(`(?:不是|不对)\\s*(?:${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:是|改成|应为)\\s*(${chunk})(?=\\s*(?:，|,|。|；|;|周|明天|后天|月底|月末|\\d{1,2}号|天后|交|发|出|拿|$))`));
  if (correctedUnitPrice && /价格|单价|报价|价|不是|不对/.test(text.slice(Math.max(0, correctedUnitPrice.index - 20), correctedUnitPrice.index + correctedUnitPrice[0].length))) {
    return {
      value: toCleanNumber(parseChineseNumber(correctedUnitPrice[1])),
      source: 'rule:corrected_unit_price'
    };
  }

  // 改价、改量后的“最后按 3.8”“最终 0.08”“价格还是 1.2”优先使用最终价格。
  const finalPrice = text.match(new RegExp(`(?:最后按|最终|价格(?:还是|仍是)|单价(?:还是|仍是))\\s*(${chunk})\\s*(?:块|元)?(?=\\s*(?:(?:一|每|/)?${priceUnit}|[，,。；;]|今天|明天|后天|月底|月末|下周|这周|周[一二三四五六日天]|交|发|出|拿|$))`));
  if (finalPrice) {
    return { value: toCleanNumber(parseChineseNumber(finalPrice[1])), source: 'rule:final_unit_price' };
  }

  const priceAfterCue = text.match(new RegExp(`(?:价钱|价格|单价|报价)\\s*(${chunk})\\s*(?:(?:块钱|元钱)|(?:块|元)\\s*(${DECIMAL_DIGIT})?)`));
  if (priceAfterCue) {
    return { value: toCleanNumber(parsePriceNumber(priceAfterCue[1], priceAfterCue[2])), source: 'rule:price_after_cue' };
  }

  // 口语里常说“20块钱一个”。“块钱”不能被拆成一件商品，也不能漏掉价格。
  const moneyWordWithUnit = text.match(new RegExp(`(${chunk})\\s*(?:块钱|元钱)\\s*(?:一|每|/)${priceUnit}`));
  if (moneyWordWithUnit) {
    return {
      value: toCleanNumber(parseChineseNumber(moneyWordWithUnit[1])),
      source: 'rule:money_word_unit_price'
    };
  }

  // 口语里“二十块钱，周日发”常省略“一个”；已有商品数量时仍可作为单价草稿，之后由 AI/确认卡核对。
  const moneyWordWithoutUnit = text.match(new RegExp(`(${chunk})\\s*(?:块钱|元钱)(?=\\s*(?:[，,。；;]|今天|明天|后天|月底|月末|下周|这周|周[一二三四五六日天]|礼拜|交|发|出|拿|$))`));
  if (moneyWordWithoutUnit) {
    return { value: toCleanNumber(parseChineseNumber(moneyWordWithoutUnit[1])), source: 'rule:money_word_price' };
  }

  const yuanJiaoFenWithUnit = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*(${DECIMAL_DIGIT})\\s*(?:毛|角)\\s*(${DECIMAL_DIGIT})\\s*(?:一|每|/)${priceUnit}`));
  if (yuanJiaoFenWithUnit) {
    const yuan = parseChineseNumber(yuanJiaoFenWithUnit[1]);
    const jiao = parseChineseNumber(yuanJiaoFenWithUnit[2]);
    const fen = parseChineseNumber(yuanJiaoFenWithUnit[3]);
    return {
      value: toCleanNumber(yuan + jiao / 10 + fen / 100),
      source: 'rule:yuan_jiao_fen_unit_price'
    };
  }

  const yuanJiaoFen = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*(${DECIMAL_DIGIT})\\s*(?:毛|角)\\s*(${DECIMAL_DIGIT})(?![\\d零一二两三四五六七八九十百千万俩])`));
  if (yuanJiaoFen) {
    const yuan = parseChineseNumber(yuanJiaoFen[1]);
    const jiao = parseChineseNumber(yuanJiaoFen[2]);
    const fen = parseChineseNumber(yuanJiaoFen[3]);
    return {
      value: toCleanNumber(yuan + jiao / 10 + fen / 100),
      source: 'rule:yuan_jiao_fen_price'
    };
  }

  const maoPrice = text.match(new RegExp(`(${chunk})\\s*(?:毛钱|毛|角)\\s*(?:一|每|/)${priceUnit}`));
  if (maoPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(maoPrice[1]) / 10),
      source: 'rule:jiao_unit_price'
    };
  }

  const yuanCentsWithUnit = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*([0-9]{1,2}|[零二两三四五六七八九]{1,2})\\s*(?:一|每|/)?${priceUnit}`));
  if (yuanCentsWithUnit) {
    return {
      value: toCleanNumber(parsePriceNumber(yuanCentsWithUnit[1], yuanCentsWithUnit[2])),
      source: 'rule:yuan_cent_unit_price'
    };
  }

  const colloquialMao = text.match(new RegExp(`(${chunk})\\s*(?:毛钱|毛|角)\\s*(${DECIMAL_DIGIT})?`));
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

  const fenDecimalPrice = text.match(new RegExp(`(${chunk})\\s*(?:分钱|分)\\s*(${DECIMAL_DIGIT})\\s*(?:一|每|/)?${priceUnit}?`));
  if (fenDecimalPrice) {
    return {
      value: toCleanNumber(parseFenPriceNumber(fenDecimalPrice[1], fenDecimalPrice[2])),
      source: 'rule:fen_li_unit_price'
    };
  }

  const colloquialFen = text.match(new RegExp(`(${chunk})\\s*(?:分钱|分)(?!\\s*(?:钟|钟钱))`));
  if (colloquialFen) {
    return {
      value: toCleanNumber(parseChineseNumber(colloquialFen[1]) / 100),
      source: 'rule:fen_unit_price'
    };
  }

  const colloquial = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*(${DECIMAL_DIGIT})?\\s*(?:一|每|/)${priceUnit}`));
  if (colloquial) {
    return {
      value: toCleanNumber(parsePriceNumber(colloquial[1], colloquial[2])),
      source: colloquial[2] ? 'rule:colloquial_decimal_price' : 'rule:price_with_currency_unit'
    };
  }

  const bareColloquial = text.match(new RegExp(`(${chunk})\\s*(?:块|元)\\s*(${DECIMAL_DIGIT})(?!\\s*(?:万|千|百|十|个|件|只|条|套|双|张|本|箱))`));
  if (bareColloquial) {
    return {
      value: toCleanNumber(parsePriceNumber(bareColloquial[1], bareColloquial[2])),
      source: 'rule:colloquial_decimal_price'
    };
  }

  const afterQuantityPrice = text.match(new RegExp(`${UNIT_PATTERN}\\s*[，,]?\\s*(${chunk})\\s*(?:块|元)(?!\\s*(?:钱|[\\d一二两三四五六七八九十百千万俩]*[年月日号天后]))`));
  if (afterQuantityPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(afterQuantityPrice[1])),
      source: 'rule:price_after_quantity'
    };
  }

  const compactCurrencyBeforeCustomer = text.match(new RegExp(`(${chunk})\\s*(?:块|元)(?=[\\u4e00-\\u9fa5]{1,8}(?:总|老板|经理|姐|哥|先生|女士))`));
  if (compactCurrencyBeforeCustomer) {
    return {
      value: toCleanNumber(parseChineseNumber(compactCurrencyBeforeCustomer[1])),
      source: 'rule:compact_currency_before_customer'
    };
  }

  const compactCurrencyBeforeShortCustomer = text.match(new RegExp(`(${chunk})\\s*(?:块|元)(?=(?:老(?!板)|阿)[\\u4e00-\\u9fa5]{1,2})`));
  if (compactCurrencyBeforeShortCustomer) {
    return {
      value: toCleanNumber(parseChineseNumber(compactCurrencyBeforeShortCustomer[1])),
      source: 'rule:compact_currency_before_short_customer'
    };
  }

  const priceBeforeComment = text.match(new RegExp(`(${chunk})\\s*(?:块|元)(?=\\s*(?:贵了|便宜|高了|低了|能做|可以))`));
  if (priceBeforeComment) {
    return {
      value: toCleanNumber(parseChineseNumber(priceBeforeComment[1])),
      source: 'rule:price_before_comment'
    };
  }

  const afterQuantityBarePrice = Array.from(text.matchAll(new RegExp(`${UNIT_PATTERN}\\s*[，,]?\\s*(${chunk})(?=\\s*(?:[，,。；;]|今天|明天|后天|大后天|月底|月末|下周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|(?:${chunk})\\s*天后|\\d{1,2}\\s*号|\\d{1,2}[/-]\\d{1,2}|交|发|出|拿|能做|可以做|做吗|$))`, 'g')))
    .find((item) => {
      const rawNumber = item[1];
      const suffix = text.slice(item.index + item[0].length, item.index + item[0].length + 4);
      return String(rawNumber).includes('.') || !/^\s*(?:\d|号|日|月|天后)/.test(suffix);
    });
  if (afterQuantityBarePrice) {
    const value = parseChineseNumber(afterQuantityBarePrice[1]);
    if (Number.isFinite(value) && value > 0 && value < 1000) {
      return {
        value: toCleanNumber(value),
        source: 'rule:price_after_quantity_bare'
      };
    }
  }

  const correctedPrice = text.match(new RegExp(`(?:价格|单价|报价|价).*?(?:不是|不对)\\s*(?:${chunk})\\s*(?:块|元)?\\s*[，,。；;\\s]*(?:是|改成|应为)\\s*(${chunk})`));
  if (correctedPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(correctedPrice[1])),
      source: 'rule:corrected_unit_price'
    };
  }

  const changedCurrencyPrice = text.match(new RegExp(`(?:单价|价格|价|报价).*?(?:改成|改|成|为|到)\\s*(${chunk})\\s*(?:块|元)\\s*(${DECIMAL_DIGIT})?`));
  const changedBarePrice = text.match(new RegExp(`(?:单价|价格|价|报价).*?(?:改成|改|成|为|到)\\s*(${chunk})(?=\\s*(?:一|每|/)?${priceUnit}|\\s*(?:，|,|。|；|;|$))`));
  const changedPrice = changedCurrencyPrice || changedBarePrice;
  if (changedPrice) {
    return {
      value: toCleanNumber(parsePriceNumber(changedPrice[1], changedPrice[2])),
      source: changedPrice[2] ? 'rule:changed_decimal_price' : 'rule:changed_price'
    };
  }

  const historyPrice = text.match(new RegExp(`(?:原价|旧价|上次|照旧价|按原价|按上回|按上次)\\s*(${chunk})\\s*(?:块|元)?`));
  if (historyPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(historyPrice[1])),
      source: 'rule:history_price_explicit'
    };
  }

  const bareCurrency = text.match(new RegExp(`(?:^|[，,\\s])(${chunk})\\s*(?:块|元)(?!\\s*(?:钱|[\\d一二两三四五六七八九十百千万俩]*[年月日号天后]))`));
  if (bareCurrency) {
    return {
      value: toCleanNumber(parseChineseNumber(bareCurrency[1])),
      source: 'rule:bare_currency_price'
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

  const bareNumberWithUnit = text.match(new RegExp(`(?:^|[，,\\s])(${chunk})\\s*${priceUnit}(?:[？?]|$)`));
  if (bareNumberWithUnit) {
    return {
      value: toCleanNumber(parseChineseNumber(bareNumberWithUnit[1])),
      source: 'rule:bare_number_unit_price'
    };
  }

  const compactBarePrice = text.match(new RegExp(`(?:^|[，,\\s])(${chunk})(?=\\s*(?:今天|明天|后天|大后天|月底|月末|下周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|(?:${chunk})\\s*天后|\\d{1,2}\\s*号|\\d{1,2}[/-]\\d{1,2}|交|发|出|拿|能做|可以做|做吗))`));
  if (compactBarePrice) {
    const value = parseChineseNumber(compactBarePrice[1]);
    if (String(compactBarePrice[1]).includes('.') && Number.isFinite(value) && value > 0 && value < 1000) {
      return {
        value: toCleanNumber(value),
        source: 'rule:compact_bare_price'
      };
    }
  }

  const confirmedBarePrice = text.match(new RegExp(`(?:就|按|行|可以|那就|嗯|好)\\s*[,，]?\\s*(${chunk})(?=\\s*(?:[,，]|先做|做|$))`))
    || text.match(new RegExp(`(?:^|[，,\\s])(${chunk})\\s*(?:呢|吧|可以吗|行不行|行吗|可以|行)[？?]?(?:$|[，,\\s])`));
  if (confirmedBarePrice) {
    return {
      value: toCleanNumber(parseChineseNumber(confirmedBarePrice[1])),
      source: 'rule:confirmed_bare_price'
    };
  }

  const explicit = text.match(new RegExp(`(?:(?:单价|价格|报价|卖|按)\\s*|报(?!一下)\\s*)(${chunk})\\s*(?:块|元)?`));
  if (explicit) {
    return {
      value: toCleanNumber(parseChineseNumber(explicit[1])),
      source: 'rule:explicit_price'
    };
  }

  return { value: '', source: '' };
}

function extractAmount(text) {
  const correction = text.match(new RegExp(`(?:是|应为|改成)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?\\s*不是\\s*(?:${numberPattern()})`));
  const explicit = text.match(new RegExp(`(?:总价|总共|一共|合计|金额|欠(?:我|款)?|应收|还差|只剩|尾款|定金|订金|预付款?|收了|收到|先收|强行收|付了|先付|付款|刚?转了?|刚转|先转|打了|刚打|打款|到账|已经到账|先打|给了|还我|还了)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还|后|后面|剩)`));
  const fallback = correction || explicit
    || text.match(new RegExp(`(?:付|收|给|转|打)?\\s*(?:定金|订金|预付款?)\\D{0,4}?(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还)`))
    || text.match(new RegExp(`(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=\\s*(?:定金|订金|预付款?))`))
    || text.match(new RegExp(`(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=\\s*(?:已经到账|到账|已到账|转了|付了))`))
    || text.match(new RegExp(`(?:挂账|没结|未结|一起结|月结|先记账|记账)\\D{0,8}?(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还|算)`))
    || text.match(new RegExp(`(?:[\\u4e00-\\u9fa5]{0,8}款)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还|算)`))
    || text.match(new RegExp(`(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=月底(?:一起)?结|月底(?:一起)?给|月底(?:一起)?算|月结|前付|后天给|三天后收)`));
  if (!fallback) return { value: '', source: '' };
  const amount = parseChineseNumber(`${fallback[1]}${fallback[2] && fallback[2].includes('万') ? '万' : ''}`);
  return {
    value: toCleanNumber(amount),
    source: correction ? 'rule:corrected_amount' : (explicit ? 'rule:explicit_amount' : 'rule:inferred_amount')
  };
}

function extractPaymentAmount(text) {
  const amount = numberPattern();
  const moneyUnit = '(万元|元|块钱|块)';
  const bareAmountBoundary = `(?=$|[，,。；;\\s]|货款|尾款|款项|这笔|那笔|顶在|算在|记在|哪笔)`;
  const nonMoneyUnit = `(?:${UNIT_PATTERN}|次|笔|份|月|日|号)`;
  for (const clause of getPaymentClauses(text)) {
    if (hasNegativeOrFuturePaymentSignal(clause)) continue;
    if (hasNonFinancialReceiveSignal(clause) || hasNonFinancialPaymentActionSignal(clause)) continue;
    const paymentAction = '(?:付了|已付|已(?:经)?付款|付款了|刚(?:刚)?打款|打款了?|(?:刚(?:刚)?)?(?:微信)?打了|给了|还了|(?:刚(?:刚)?)?(?:微信)?转(?:账|了|过来)?|强行收|收了|已收|收到|已(?:经)?到账|到账了?)';
    const actionToAmount = '[^，,。；;\\n\\d零〇一二两三四五六七八九十百千万俩]{0,8}(?:一笔|一共|合计)?\\s*';
    const afterAction = clause.match(new RegExp(`${paymentAction}${actionToAmount}(${amount})\\s*${moneyUnit}`));
    const afterActionWithoutUnit = clause.match(new RegExp(`${paymentAction}${actionToAmount}(${amount})(?!\\s*${nonMoneyUnit})${bareAmountBoundary}`));
    const beforeCompletion = clause.match(new RegExp(`(${amount})\\s*${moneyUnit}[^，,。；;\\n]{0,6}(?:已(?:经)?到账|到账了?|付了|已付|收了|已收)`));
    const match = afterAction || afterActionWithoutUnit || beforeCompletion;
    if (!match) continue;
    return {
      value: toCleanNumber(parseChineseNumber(`${match[1]}${match[2] && match[2].includes('万') && !String(match[1]).includes('万') ? '万' : ''}`)),
      source: 'rule:completed_payment_amount'
    };
  }
  return { value: '', source: '' };
}

function extractDepositAmount(text) {
  const beforeAmount = text.match(new RegExp(`(?:付|收|给|转|打)?\\s*(?:定金|订金|预付款?)\\D{0,4}?(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还)`));
  const afterAmount = text.match(new RegExp(`(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=\\s*(?:定金|订金|预付款?))`));
  const match = beforeAmount || afterAmount;
  if (!match) return { value: '', source: '' };
  const amount = parseChineseNumber(`${match[1]}${match[2] && match[2].includes('万') ? '万' : ''}`);
  return {
    value: toCleanNumber(amount),
    source: 'rule:deposit_amount'
  };
}

function extractRemainingAmount(text) {
  const match = text.match(new RegExp(`(?:还剩|只剩|剩下|剩余|未收|没收|还差)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?`));
  if (!match) return { value: '', source: '' };
  const amount = parseChineseNumber(`${match[1]}${match[2] && match[2].includes('万') ? '万' : ''}`);
  return {
    value: toCleanNumber(amount),
    source: 'rule:remaining_amount'
  };
}

function extractProduct(text, customerName = '') {
  const changedProduct = KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .find((item) => new RegExp(`(?:改成|改为|换成|变成|改)\\D{0,8}${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text));
  if (changedProduct) return { value: changedProduct, source: 'rule:changed_product' };

  const known = KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((item) => ({ item, index: text.indexOf(item) }))
    .filter((item) => item.index >= 0)
    .filter((item) => item.item !== '笔' || new RegExp(`笔\\s*(${numberPattern()})\\s*${UNIT_PATTERN}`).test(text))
    .sort((left, right) => left.index - right.index || right.item.length - left.item.length)[0];
  if (known) return { value: known.item, source: 'rule:known_product' };

  const beforeQuantity = text.match(new RegExp(`(?:报价给|报给|发给|卖给|转给|给|帮|找|问|报架|下单|订货|订购|要货|返单|补单|采购|报|要|订|定了|定|补|做|发)?([\\u4e00-\\u9fa5A-Za-z]{2,18}?)\\s*(${numberPattern()})\\s*${UNIT_PATTERN}`));
  if (beforeQuantity) {
    const productContext = beforeQuantity[1];
    const productWithoutCustomer = customerName
      ? productContext.replace(new RegExp(`^.*?${escapeRegExp(customerName)}`), '')
      : productContext;
    const product = productWithoutCustomer
      .replace(/.*(?:总|老板|经理|姐|哥|先生|女士)/, '')
      .replace(new RegExp(`^${CUSTOMER_ORGANIZATION_ACTION_PATTERN}`), '')
      .replace(/^(下单|订货|订购|要货|返单|补单|采购|先下|先做|下|做|要|订|定了|定|补|发|给|帮|找|问|报|报价)/, '')
      .replace(PRODUCT_STOP_WORDS, '')
      .replace(/^的|^，/, '');
    const cleanedProduct = cleanItemProductName(product);
    if (cleanedProduct && !/\d/.test(cleanedProduct)) {
      return { value: cleanedProduct, source: 'rule:before_quantity_product' };
    }
  }

  const afterQuantity = text.match(new RegExp(`(?:${numberPattern()})\\s*${UNIT_PATTERN}\\s*([\\u4e00-\\u9fa5A-Za-z0-9]{1,18})`));
  if (afterQuantity) {
    const product = afterQuantity[1].replace(PRODUCT_STOP_WORDS, '').replace(/^的|^，/, '');
    if (product && !/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分|钱)/.test(product)) {
      return { value: product, source: 'rule:after_quantity_product' };
    }
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

function extractKnownProducts(text) {
  const source = String(text || '');
  return KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((item) => ({ item, index: source.indexOf(item) }))
    .filter((entry) => entry.index >= 0)
    .filter((entry) => entry.item !== '笔' || new RegExp(`笔\\s*(${numberPattern()})\\s*${UNIT_PATTERN}`).test(source))
    .sort((left, right) => left.index - right.index || right.item.length - left.item.length)
    .reduce((list, entry) => {
      const overlaps = list.some((existing) => (
        entry.index >= existing.index
        && entry.index + entry.item.length <= existing.index + existing.item.length
      ));
      if (!overlaps) list.push(entry);
      return list;
    }, [])
    .map((entry) => entry.item);
}

function extractMultiProductNames(text) {
  const source = String(text || '');
  if (/(?:改成|改为|换成|变成)/.test(source)) {
    const changedProduct = KNOWN_PRODUCTS
      .slice()
      .sort((left, right) => right.length - left.length)
      .find((item) => new RegExp(`(?:改成|改为|换成|变成)\\D{0,8}${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(source));
    if (changedProduct) return [];
  }
  const names = extractKnownProducts(source);
  if (names.length < 2) return [];
  const quantityLikeNames = names.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*(?:${numberPattern()})\\s*(?:${UNIT_PATTERN})`));
    if (match) return true;
    const askMatch = source.match(new RegExp(`${escaped}\\s*(?:多少钱|价格|报价|单价)`));
    return Boolean(askMatch);
  });
  if (quantityLikeNames.length >= 2) return quantityLikeNames;
  if (/(?:和|跟|及|一起|再问|另外|还有|，|；|;).*(?:报|问|做|发|交|出|价格|多少钱)/.test(source)) return names;
  return [];
}

function cleanItemProductName(value, customerName = '') {
  let cleaned = String(value || '')
    .replace(/[：:，,。；;\s]/g, '')
    .trim();
  if (!cleaned) return '';

  if (customerName) {
    const customer = escapeRegExp(customerName);
    const shortCustomer = escapeRegExp(customerName.replace(/(?:总|老板|经理|姐|哥|先生|女士)$/, ''));
    cleaned = cleaned
      .replace(new RegExp(`^.*?${customer}`), '')
      .replace(new RegExp(`^${shortCustomer}`), '');
  }
  cleaned = cleaned.replace(new RegExp(`^${CUSTOMER_ORGANIZATION_ACTION_PATTERN}`), '');

  const originalKnown = KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .find((item) => cleaned.includes(item));
  if (originalKnown) return originalKnown;

  const hadTrailingAction = /(?:那边|这边|说|问|要|订|定|定了|下单|先下|先做|做|补|发|出|拿)$/.test(cleaned);
  cleaned = cleaned
    .replace(/^(?:给|帮|找|问|报给|报价给|发给|卖给|转给|先问|再问|另外|还有|先下|先做|下单|订货|订购|要货|返单|补单|采购|下|做|要|订|定了|定|买|补|追加|发|出|拿|记一下|记下|客户|那个|这个|这边|那边)+/, '')
    .replace(/(?:那边|这边|说|问|要|订|定|定了|下单|先下|先做|做|补|发|出|拿)$/, '')
    .trim();
  if (customerName) {
    const customer = escapeRegExp(customerName);
    const shortCustomer = escapeRegExp(customerName.replace(/(?:总|老板|经理|姐|哥|先生|女士)$/, ''));
    cleaned = cleaned
      .replace(new RegExp(`^${customer}`), '')
      .replace(new RegExp(`^${shortCustomer}`), '')
      .replace(/^(?:报给|报价给|报价|报架|报)+/, '')
      .trim();
  }

  const known = KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .find((item) => cleaned.includes(item));
  if (known) return known;

  if (hadTrailingAction && cleaned.length <= 4) return '';
  if (!cleaned || cleaned.length > 12) return '';
  if (ITEM_EXACT_BAD_PRODUCT_PATTERN.test(cleaned)) return '';
  if (new RegExp(`^(?:${SPEC_TOKEN_PATTERN})$`).test(cleaned)) return '';
  if (/^(?:加厚|加薄|加硬|变厚|变薄|单独|独立|外箱|内盒|包装要求)$/.test(cleaned)) return '';
  if (/^老板(?:今|明|昨|后|早|晚|今天|明天|后天)/.test(cleaned)) return '';
  if (/^(?:这?周(?:[一二三四五六日天]|拿|交|发|出)|下周(?:[一二三四五六日天]|拿|交|发|出)|(?:明天|后天|今天|月底|月末|礼拜|星期).*(?:交|拿|发|出)?)$/.test(cleaned)) return '';
  // “20块钱一个”会被商品+数量规则误切成“块钱 + 1个”；这是一段价格，不是一件商品。
  if (/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩]+)?(?:块钱|元钱|毛钱|分钱)$/.test(cleaned)) return '';
  if (/^(?:定|订|要|问|报|报价|做|发|下|补|货|客户|产品|这个|那个|先|再|还有|另外)$/.test(cleaned)) return '';
  if (ITEM_BAD_PRODUCT_PATTERN.test(cleaned)) return '';
  if (/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分|钱)?$/.test(cleaned)) return '';
  // “一块二”“五块五”“三毛五”都是价格口语，不能在“一个”前被当成第二个商品。
  if (/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩]+)(?:块|元|毛|角|分)(?:\d|[零〇一二两三四五六七八九十百千万俩])?$/.test(cleaned)) return '';
  return cleaned;
}

function cleanCustomerCandidateName(value) {
  let name = cleanCustomerName(value);
  name = name
    .replace(/^.*(?:报价给|报给|发给|卖给|转给|给|帮|找)/, '')
    .replace(/^(?:我|帮我|提醒我|请我)?(?:催|问|联系|找|提醒)/, '')
    .replace(/^(?:我|帮我|给我|请我|提醒我)/, '')
    .replace(/(?:刚刚|刚|已经|已|又|还|定金|订金|货款|尾款|欠款|款|下单|下|要|问|报|报价|订|定|做|收|付|转|打款)$/g, '')
    .trim();
  return cleanCustomerName(name);
}

function parseQuantityWithUnit(rawNumber, rawUnit) {
  const unit = String(rawUnit || '');
  const rawNumberText = String(rawNumber || '').trim();
  // “千支”是五金批发里的完整计量单位。数字规则会优先把“2千支”切成
  // “2千 + 支”，这里恢复为“2 + 千支”；“2千个”仍保持 2000 个。
  if (normalizeUnit(unit) === '支' && /千$/.test(rawNumberText)) {
    const quantity = parseChineseNumber(rawNumberText.slice(0, -1) || '一');
    if (!Number.isFinite(quantity) || quantity <= 0) return { quantity: '', unit: '' };
    return {
      quantity: toCleanNumber(quantity),
      unit: '千支'
    };
  }
  const unitHasWan = unit.startsWith('万');
  const parsed = parseChineseNumber(rawNumberText) * (unitHasWan ? 10000 : 1);
  if (!Number.isFinite(parsed) || parsed <= 0) return { quantity: '', unit: '' };
  return {
    quantity: toCleanNumber(parsed),
    unit: normalizeUnit(unit)
  };
}

function extractPriceUnit(text) {
  const source = String(text || '');
  const chunk = numberPattern();
  const afterPrice = source.match(new RegExp(`(?:${chunk})\\s*(?:块钱|元钱|块|元|毛|角|分)?\\s*(?:一|每|/)\\s*(${RAW_UNIT_PATTERN})`));
  if (afterPrice) return normalizeUnit(afterPrice[1]);
  const beforePrice = source.match(new RegExp(`(?:每|一)\\s*(${RAW_UNIT_PATTERN})\\s*(?:${chunk})`));
  if (beforePrice) return normalizeUnit(beforePrice[1]);
  return '';
}

const COLLOQUIAL_SINGLE_COUNT_UNITS = new Set([
  '只', '支', '件', '套', '台', '盒', '瓶', '罐', '桶',
  '张', '匹', '令', '条', '头', '双', '对', '本', '组', '把'
]);

function resolveColloquialPriceUnit(quantityUnit, priceUnit, sourceText) {
  const quantity = normalizeUnit(quantityUnit);
  const price = normalizeUnit(priceUnit);
  if (price !== '个' || !COLLOQUIAL_SINGLE_COUNT_UNITS.has(quantity)) return price;
  // “每个”“/个”是明确按个计价，不能擅自改单位；“3.8元一个”则是老板常用的
  // 泛指说法，结合前面的“100套/600双/1000把”按当前计数单位理解。
  if (/(?:每|\/)\s*个/.test(String(sourceText || ''))) return price;
  return quantity;
}

function extractSpec(text) {
  const match = String(text || '').match(new RegExp(`(${SPEC_TOKEN_PATTERN})(?:的)?`));
  return match ? match[1].replace(/的$/, '') : '';
}

function removeSpecFromProduct(productName, spec) {
  if (!productName || !spec) return productName;
  const escaped = escapeRegExp(spec);
  const cleaned = String(productName)
    .replace(new RegExp(`^${escaped}(?:的)?`), '')
    .replace(new RegExp(`${escaped}(?:的)?$`), '')
    .trim();
  return cleaned || productName;
}

function extractVariantItems(text, customerName = '') {
  const source = String(text || '');
  const pattern = new RegExp(`(${SPEC_TOKEN_PATTERN})(?:的)?\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`, 'g');
  const matches = Array.from(source.matchAll(pattern));
  if (matches.length < 2) return [];
  const prefixParts = source.slice(0, matches[0].index).split(/[，,。；;]+/).map((part) => part.trim()).filter(Boolean);
  let productText = prefixParts[prefixParts.length - 1] || '';
  if (customerName) productText = productText.replace(new RegExp(`^${escapeRegExp(customerName)}`), '');
  productText = productText.replace(/^.*?(?:要|订|定|下单|做|报|报价|问价|来|补)\s*/, '');
  const productName = cleanItemProductName(productText, customerName);
  if (!productName) return [];

  const sharedUnitPrice = extractUnitPrice(source);
  const sharedPriceUnit = extractPriceUnit(source);
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const segment = source.slice(match.index, next ? next.index : source.length);
    const localUnitPrice = extractUnitPrice(segment);
    const unitPrice = localUnitPrice.value || sharedUnitPrice.value;
    const parsedQuantity = parseQuantityWithUnit(match[2], match[3]);
    const priceUnit = resolveColloquialPriceUnit(
      parsedQuantity.unit,
      extractPriceUnit(segment) || sharedPriceUnit,
      segment
    );
    return normalizeItem({
      productName,
      spec: match[1],
      quantity: parsedQuantity.quantity,
      unit: parsedQuantity.unit,
      unitPrice,
      priceUnit,
      totalAmount: calculateAmount(parsedQuantity.quantity, unitPrice, parsedQuantity.unit, priceUnit)
    });
  });
}

function compactItemCandidates(candidates) {
  return candidates
    .sort((left, right) => left.index - right.index || right.end - left.end)
    .reduce((list, candidate) => {
      const overlapIndex = list.findIndex((item) => candidate.index < item.end && candidate.end > item.index);
      if (overlapIndex < 0) {
        list.push(candidate);
        return list;
      }
      const current = list[overlapIndex];
      if (candidate.productName.length > current.productName.length) list[overlapIndex] = candidate;
      return list;
    }, []);
}

function extractItemCandidates(text, customerName = '') {
  const source = String(text || '');
  const candidates = [];
  const quantityFirst = new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})\\s*([\\u4e00-\\u9fa5A-Za-z]{1,16})`, 'g');
  const productFirst = new RegExp(`([\\u4e00-\\u9fa5A-Za-z]{1,20})\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`, 'g');

  const pushCandidate = (match, rawProduct, rawQuantity, rawUnit, sourceName) => {
    let productText = rawProduct;
    let quantityText = rawQuantity;
    if (sourceName === 'rule:item_product_quantity') {
      // 正则在“礼品盒五百套”里可能把“百”单独当数量、把“礼品盒五”当商品。
      // 把被截走的中文数字拼回去，再判断商品名。
      const splitQuantity = String(productText || '').match(/([零〇一二两三四五六七八九十百千万俩]+)$/);
      if (splitQuantity && /^[零〇一二两三四五六七八九十百千万俩]+$/.test(String(quantityText || ''))) {
        productText = productText.slice(0, -splitQuantity[1].length);
        quantityText = `${splitQuantity[1]}${quantityText}`;
      }
    }
    const productName = cleanItemProductName(productText, customerName);
    const quantity = parseQuantityWithUnit(quantityText, rawUnit);
    if (!productName || !quantity.quantity) return;
    candidates.push({
      index: match.index,
      end: match.index + match[0].length,
      productName,
      quantity: quantity.quantity,
      unit: quantity.unit,
      source: sourceName
    });
  };

  let match;
  while ((match = quantityFirst.exec(source)) !== null) {
    pushCandidate(match, match[3], match[1], match[2], 'rule:item_quantity_product');
  }
  while ((match = productFirst.exec(source)) !== null) {
    pushCandidate(match, match[1], match[2], match[3], 'rule:item_product_quantity');
  }

  return compactItemCandidates(candidates);
}

function normalizeItem(item = {}) {
  const productName = cleanItemProductName(item.productName || item.product_name || item.name || '');
  const quantity = item.quantity ? toCleanNumber(item.quantity) : '';
  const unitPrice = item.unitPrice || item.unit_price ? toCleanNumber(item.unitPrice || item.unit_price) : '';
  const unit = normalizeUnit(item.unit || '');
  const priceUnit = normalizeUnit(item.priceUnit || item.price_unit || item.unitPriceUnit || item.unit_price_unit || '');
  const totalAmount = item.totalAmount || item.total_amount || item.amount
    ? toCleanNumber(item.totalAmount || item.total_amount || item.amount)
    : calculateAmount(quantity, unitPrice, unit, priceUnit);
  return {
    productName,
    spec: item.spec || '',
    quantity,
    unit,
    unitPrice,
    priceUnit,
    totalAmount,
    itemDeliveryDate: item.itemDeliveryDate || item.deliveryDate || item.dueDate || '',
    itemRemark: item.itemRemark || item.remark || ''
  };
}

function hasItemValue(item) {
  return Boolean(item && (item.productName || item.spec || item.quantity || item.unitPrice || item.totalAmount));
}

function normalizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(normalizeItem)
    .filter(hasItemValue);
}

function extractItems(text, customerName = '') {
  const variantItems = extractVariantItems(text, customerName);
  if (variantItems.length) return variantItems;
  const candidates = extractItemCandidates(text, customerName);
  return candidates.map((candidate, index) => {
    const next = candidates[index + 1];
    const itemText = text.slice(candidate.index, next ? next.index : text.length);
    const unitPrice = extractUnitPrice(itemText);
    const inferredSpec = extractSpec(itemText);
    const spec = isKnownProductName(candidate.productName) && candidate.productName.startsWith(inferredSpec)
      ? ''
      : inferredSpec;
    const productName = removeSpecFromProduct(candidate.productName, spec);
    const priceUnit = resolveColloquialPriceUnit(candidate.unit, extractPriceUnit(itemText), itemText);
    const totalAmount = calculateAmount(candidate.quantity, unitPrice.value, candidate.unit, priceUnit);
    return normalizeItem(Object.assign({}, candidate, {
      productName,
      spec,
      unitPrice: unitPrice.value,
      priceUnit,
      totalAmount,
      itemRemark: '',
      source: [candidate.source, unitPrice.source].filter(Boolean).join('+')
    }));
  });
}

function isKnownProductName(value) {
  return KNOWN_PRODUCTS.includes(String(value || ''));
}

function repairItemDrafts(items, text, fallbackProduct) {
  const list = Array.isArray(items) ? items.map((item) => Object.assign({}, item)) : [];
  const known = extractKnownProducts(text);
  const onlyKnownProduct = known.length === 1 ? known[0] : (isKnownProductName(fallbackProduct) ? fallbackProduct : '');
  if (!onlyKnownProduct) return list;
  return list
    .filter((item) => !/^(?:这?周|下周|明天|后天|今天|月底|月末|礼拜|星期)/.test(String(item.productName || '')))
    .map((item) => {
      if (!isKnownProductName(item.productName)) item.productName = onlyKnownProduct;
      return item;
    });
}

function buildLegacyItem(fields = {}) {
  return normalizeItem({
    productName: fields.productName,
    spec: fields.spec,
    quantity: fields.quantity,
    unit: fields.unit,
    unitPrice: fields.unitPrice,
    priceUnit: fields.priceUnit,
    totalAmount: fields.totalAmount || fields.amount
  });
}

function getItemsTotal(items = []) {
  if (!items.length || items.some((item) => !item.totalAmount)) return '';
  const total = items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  return toCleanNumber(total);
}

function sameMoney(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && Math.abs(leftNumber - rightNumber) < 0.0001;
}

function countQuantityUnitPairs(text) {
  return Array.from(String(text || '').matchAll(new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`, 'g')))
    .filter((match) => {
      const parsedQuantity = parseQuantityWithUnit(match[1], match[2]);
      const unit = parsedQuantity.unit;
      const parsed = Number(parsedQuantity.quantity);
      const prefix = text.slice(Math.max(0, match.index - 8), match.index);
      const suffix = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
      if (!Number.isFinite(parsed) || parsed <= 0) return false;
      if (parsed === 1 && /(?:块|元|毛|角|分|钱|单价|价格|报价|\d+\.\d+|\d)$/.test(prefix)) return false;
      // “一个五块五 / 一套两块三”里的“一 个/套”是价格单位，不是第二件商品。
      if (parsed === 1 && /^(?:\d|[零〇一二两三四五六七八九十百千万俩])(?:块|元|毛|角|分|钱)/.test(suffix)) return false;
      return isSupportedUnit(unit);
    })
    .length;
}

function extractCustomerNameCandidates(text) {
  const source = String(text || '');
  const shortName = extractShortCustomerName(source);
  if (shortName.value) return [shortName.value];
  const titledNames = [];
  const titled = source.match(/[\u4e00-\u9fa5A-Za-z]{1,8}(?:总|老板|经理|姐|哥|先生|女士)/g) || [];
  titled.forEach((name) => titledNames.push(cleanCustomerCandidateName(name)));

  // 原文已经有“王总 / 李姐”这类明确称呼时，不再用宽泛的动作词规则补猜一次。
  // 否则“给王总记订单”会额外截出“王总记”，被误判为两个客户。
  const cleanTitledNames = titledNames
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .filter((name, index, array) => array.indexOf(name) === index);
  if (cleanTitledNames.length) return cleanTitledNames;

  const organization = extractOrganizationCustomerName(source);
  if (organization.matched) return organization.value ? [organization.value] : [];

  const names = [];
  const actionPattern = new RegExp(`([\\u4e00-\\u9fa5]{1,4})(?:${CUSTOMER_ACTION_PATTERN})`, 'g');
  let match;
  while ((match = actionPattern.exec(source)) !== null) {
    names.push(cleanCustomerCandidateName(match[1]));
  }

  return names
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .filter((name) => !/^(先|先付|已付|刚付|再|另外|还有|都|客户|产品|这个|那个|正式|确认|这单|那单|订单|单|到|个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|包|盒|袋|组|把|台)$/.test(name))
    .filter((name) => !/(?:这单|那单|订单|下单|定金|订金|尾款|货款|礼品|品盒)$/.test(name))
    .filter((name) => !/(?:收到|收了|已收|刚收|转了|刚转|打了|到账|付了|已付)$/.test(name))
    .filter((name) => !/(?:以前|之前|原来|过去|历史|老账|旧账|去年|上个月)$/.test(name))
    .filter((name) => !KNOWN_PRODUCTS.some((product) => name.includes(product) || product.includes(name)))
    .filter((name, index, array) => array.indexOf(name) === index);
}

function extractTodoTitle(text, fields = {}) {
  const customerName = fields.customerName || '';
  const customerShort = customerName ? customerName.replace(/总$/, '') : '';
  const productName = fields.productName || '';
  const productPattern = productName ? productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[\\u4e00-\\u9fa5A-Za-z0-9]{1,12}';
  if (/(回|回复|答复)/.test(text)) {
    if (customerName && productName) return { value: `回复${customerName}${productName}报价`, source: 'rule:todo_reply_quote' };
    if (customerName) return { value: `回复${customerName}`, source: 'rule:todo_reply_customer' };
    return { value: '回复客户', source: 'rule:todo_reply' };
  }
  if (/发.*?对账单/.test(text)) {
    const target = text.match(new RegExp(`发\\s*(${productPattern})?\\s*对账单`));
    const product = (target && target[1]) || productName || '';
    return { value: `发${product}对账单`, source: 'rule:todo_statement' };
  }
  if (/催/.test(text)) {
    if (customerName && /尾款/.test(text)) return { value: `催${customerName}尾款`, source: 'rule:todo_dunning_tail' };
    if (customerName && /款|货款|尾款|应收|欠/.test(text)) return { value: `催${customerName}货款`, source: 'rule:todo_dunning' };
    if (customerName) return { value: `催一下${customerName}`, source: 'rule:todo_follow_customer' };
    return { value: '催一下客户', source: 'rule:todo_dunning' };
  }
  if (/联系/.test(text)) {
    if (productName && /样品/.test(text)) return { value: `联系${productName}样品`, source: 'rule:todo_contact_sample' };
    if (productName) return { value: `联系${productName}`, source: 'rule:todo_contact_product' };
  }
  if (/确认/.test(text) && !/跟进/.test(text)) {
    const target = productName
      ? text.match(new RegExp(`${productPattern}([\\u4e00-\\u9fa5A-Za-z0-9]{0,8})`))
      : null;
    const suffix = target && target[1] ? target[1].replace(/确认没|没$/, '') : '';
    if (productName) return { value: `确认${productName}${suffix}`.slice(0, 24), source: 'rule:todo_confirm_product' };
    return { value: '确认事项', source: 'rule:todo_confirm' };
  }
  if (/看.*进度/.test(text)) {
    if (productName) return { value: `看${productName}进度`, source: 'rule:todo_progress' };
    return { value: '看进度', source: 'rule:todo_progress' };
  }
  if (/跟进/.test(text)) {
    if (customerName && productName) return { value: `跟进${customerName}${productName}`, source: 'rule:todo_follow_product' };
    if (customerName) return { value: `跟进${customerName}`, source: 'rule:todo_follow_customer' };
  }
  if (/问/.test(text)) {
    if (customerName && productName) return { value: `跟进${customerName}${productName}`, source: 'rule:todo_ask_customer_product' };
    if (customerName) return { value: `跟进${customerName}`, source: 'rule:todo_ask_customer' };
  }
  const cleaned = text
    .replace(new RegExp(`^(?:${customerShort}|${customerName})?\\s*(?:说|问)?`), '')
    .replace(/(?:今天|明天|明日|后天|大后天|上午|中午|下午|晚上|今晚|月底|月末|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}月\d{1,2}日?|\d{1,2}号)/g, '')
    .replace(/提醒我|提醒|待会|等下|记得/g, '')
    .replace(/[，,\s]+/g, '');
  if (cleaned) return { value: cleaned.slice(0, 24), source: 'rule:todo_cleaned_text' };
  return { value: customerName ? `跟进${customerName}` : '待办提醒', source: 'rule:todo_default' };
}

function collectIntentSignalMatches(text, pattern, kind) {
  const source = String(text || '');
  const signals = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    signals.push({
      kind,
      sourceSpan: {
        start: match.index,
        end: match.index + match[0].length
      },
      sourceText: match[0]
    });
    if (match[0] === '') pattern.lastIndex += 1;
  }
  return signals;
}

function intentSignalSpansOverlap(left, right) {
  return left.sourceSpan.start < right.sourceSpan.end
    && right.sourceSpan.start < left.sourceSpan.end;
}

function isActionableQuotationToOrderSignal(text, signal) {
  const source = String(text || '');
  const start = signal.sourceSpan.start;
  const end = signal.sourceSpan.end;
  const clauseStart = Math.max(
    source.lastIndexOf('，', start - 1),
    source.lastIndexOf(',', start - 1),
    source.lastIndexOf('。', start - 1),
    source.lastIndexOf('；', start - 1),
    source.lastIndexOf(';', start - 1),
    source.lastIndexOf('\n', start - 1)
  ) + 1;
  const clauseEndCandidates = ['，', ',', '。', '；', ';', '\n']
    .map((separator) => source.indexOf(separator, end))
    .filter((index) => index >= 0);
  const clauseEnd = clauseEndCandidates.length
    ? Math.min(...clauseEndCandidates)
    : source.length;
  const prefix = source.slice(clauseStart, start);
  const suffix = source.slice(end, clauseEnd);
  const clause = source.slice(clauseStart, clauseEnd);

  if (/(?:不要|别|不能|不可|禁止|拒绝|不允许|不可以|先不|暂时不|还没|尚未|没有|并未|未|没|不是|并非|是否|是不是|能不能)[^，,。；;\n]*$/.test(prefix)) {
    return false;
  }
  if (/(?:已经|早已|早就|曾经|之前|先前|刚才|刚刚)[^，,。；;\n]*$/.test(prefix)) {
    return false;
  }
  if (/^(?:了|过|已经|已|成功|完成|失败|不成功|没成功|未成功|出错|了吗|吗|么)/.test(suffix)) {
    return false;
  }
  if (/[？?]/.test(clause) || /(?:吗|么)(?:$|[？?])/.test(clause)) {
    return false;
  }
  return true;
}

function collectQuotationToOrderConversionSignals(text, options = {}) {
  const source = String(text || '');
  return collectIntentSignalMatches(
    source,
    /(?:这张|那张|这份|那份|这个|那个)?报价单?(?:再)?(?:转换|转)(?:成|为)?订单/g,
    'QUOTATION_TO_ORDER_CONVERSION'
  ).filter((signal) => isActionableQuotationToOrderSignal(source, signal))
    .map((signal) => ({
      ...signal,
      direction: 'QUOTATION_TO_ORDER',
      explicit: true,
      confidence: 0.99,
      evidenceSource: 'LOCAL_PARSER',
      sourceField: options.sourceField || 'ORIGINAL_TEXT'
    }));
}

function collectQuotationToOrderPhraseSignals(text) {
  return collectIntentSignalMatches(
    String(text || ''),
    /(?:这张|那张|这份|那份|这个|那个)?报价单?[^，,。；;\n]{0,8}(?:转换|转)(?:成|为)?订单/g,
    'QUOTATION_TO_ORDER_PHRASE'
  );
}

function analyzeQuotationOrderIntent(text, options = {}) {
  const source = String(text || '');
  const conversionSource = String(options.conversionText || source);
  const conversionSourceField = options.conversionSourceField || 'ORIGINAL_TEXT';
  const hasQuantity = new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(source);
  const hasBareUnitPrice = new RegExp(`(${numberPattern()})\\s*${UNIT_PATTERN}\\s*(${numberPattern()})(?!\\s*(?:${RAW_UNIT_PATTERN}|月|号|日))`).test(source);
  const hasPrice = new RegExp(`(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万俩]+)\\s*(?:块|元|毛|角|分)|(?:一|每)${RAW_UNIT_PATTERN}|单价`).test(source)
    || hasBareUnitPrice;
  const quotationNegationSignals = collectIntentSignalMatches(
    source,
    /(?:(?:没有|还没|尚未|先不|不|没|未)(?:再)?(?:报价|报个价|问价|询价|报(?!告|废|销|名|警|表|税|关|到))|(?:不是|并非)(?:要)?(?:报价|报个价|问价|询价))/g,
    'QUOTATION_ACTION_NEGATED'
  );
  const quotationPositiveSignals = collectIntentSignalMatches(
    source,
    /报价|报架|报个价|问价|询价|多少钱|价格多少|给个价格|要个价格|先算价格|先出报价单|先报|一起报|报给客户/g,
    'QUOTATION_EXPLICIT'
  ).filter((signal) => !quotationNegationSignals.some((negative) => (
    intentSignalSpansOverlap(signal, negative)
  )));
  if (!quotationPositiveSignals.length && hasQuantity && hasPrice) {
    quotationPositiveSignals.push(...collectIntentSignalMatches(
      source,
      /报(?!告|废|销|名|警|表|税|关|到)/g,
      'QUOTATION_CONTEXTUAL_REPORT_WITH_QUANTITY_AND_PRICE'
    ).filter((signal) => !quotationNegationSignals.some((negative) => (
      intentSignalSpansOverlap(signal, negative)
    ))));
  }
  quotationPositiveSignals.push(...collectIntentSignalMatches(
    source,
    /单价/g,
    'QUOTATION_PRICE_FIELD'
  ));

  const orderDoubleNegationSignals = collectIntentSignalMatches(
    source,
    /(?:不是|并非)(?:没有|还没|尚未|不|没|未)(?:正式|确认)?(?:下单|下订单|订货|要货)/g,
    'ORDER_ACTION_DOUBLE_NEGATION'
  );
  const orderNegationSignals = collectIntentSignalMatches(
    source,
    /(?:还没有|还没|尚未|并未|没有|暂时不|先不|不是|不要|拒绝|没|未|别|不)(?:再)?(?:正式|确认)?(?:下单|下订单|订货|要货)|不一定做|不要记订单/g,
    'ORDER_ACTION_NEGATED'
  ).filter((signal) => !orderDoubleNegationSignals.some((doubleNegative) => (
    intentSignalSpansOverlap(signal, doubleNegative)
  )));

  const reaffirmedOrderSignals = []
    .concat(collectIntentSignalMatches(
      source,
      /(?:现在|这次|今天)(?:已经|就|正式)?(?:确认)?(?:下单|下订单|订货|要货)/g,
      'ORDER_ACTION_REAFFIRMED'
    ))
    .concat(collectIntentSignalMatches(
      source,
      /(?:已经|正式|确认)(?:下单|下订单|订货)/g,
      'ORDER_ACTION_REAFFIRMED'
    ))
    .concat(collectIntentSignalMatches(
      source,
      /(?:不是|并非)报价[^，,。；;\n]{0,12}(?:是)?(?:正式)?(?:订单|下单)/g,
      'ORDER_ACTION_REAFFIRMED'
    ))
    .concat(collectIntentSignalMatches(
      source,
      /(?:(?:后来|之后|随后|后面|接着|然后)[^，,。；;\n]{0,8}(?:下单|下订单|订货|要货)(?:了|啦|完成|确认)|又(?:下单|下订单|订货|要货))/g,
      'ORDER_ACTION_REAFFIRMED'
    ))
    .filter((signal) => !orderNegationSignals.some((negative) => (
      intentSignalSpansOverlap(signal, negative)
    )))
    .concat(orderDoubleNegationSignals);

  const masked = source.split('');
  orderNegationSignals.forEach((signal) => {
    for (let index = signal.sourceSpan.start; index < signal.sourceSpan.end; index += 1) {
      masked[index] = ' ';
    }
  });
  const orderSignalText = masked.join('');
  const orderPositiveSignals = collectIntentSignalMatches(
    orderSignalText,
    /来一单|下单|下订单|先下|订货|要货|确认了|追加|再来|先来|先整|先做|做货|生产|做好|开工|排产|返单/g,
    'ORDER_ACTION_POSITIVE'
  );
  const orderEntitySignals = collectIntentSignalMatches(
    orderSignalText,
    /订单/g,
    'ORDER_ENTITY_EXPLICIT'
  );
  const orderDeliverySignals = collectIntentSignalMatches(
    orderSignalText,
    /(?:今天|明天|后天|大后天|月底|月末|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}月\d{1,2}日?|\d{1,2}号)(?:(?:\s|上午|中午|下午|晚上|今晚|早上|早晨|前|左右|能|可以|安排|计划|准备|统一|一起|分批|先|要|会|就)){0,3}(?:出货|出)(?=$|[，,。；;\n])/g,
    'ORDER_DELIVERY_CONTEXTUAL_PHRASE'
  ).filter((signal) => !/(?:还没|尚未|并未|没有|没|未|暂时不|先不|不|别|不要|不能|不会|拒绝|禁止|取消)(?:再|先|能|会|要|准备)?(?:出货|出)(?=$|[，,。；;\n])/.test(
    signal.sourceText
  ));
  const quotationToOrderPhraseSignals = collectQuotationToOrderPhraseSignals(
    conversionSource
  );
  const quotationToOrderConversionSignals = collectQuotationToOrderConversionSignals(
    conversionSource,
    { sourceField: conversionSourceField }
  );

  return {
    orderDeliverySignals,
    orderEntitySignals,
    orderNegationSignals,
    orderPositiveSignals,
    orderSignalText,
    quotationNegationSignals,
    quotationPositiveSignals,
    quotationToOrderConversionSignals,
    quotationToOrderPhraseSignals,
    reaffirmedOrderSignals
  };
}

function scoreIntent(text, context, businessDate, options = {}) {
  if (context === 'query') return { intent: 'query', candidates: ['query'] };
  if (EXPLICIT_NON_RECORD_PATTERN.test(text)) {
    return { intent: 'unknown', candidates: ['unknown'] };
  }
  const quotationOrderIntent = analyzeQuotationOrderIntent(text, {
    conversionText: options.conversionText || text,
    conversionSourceField: options.conversionSourceField || 'ORIGINAL_TEXT'
  });
  const hasQuotationToOrderPhrase = quotationOrderIntent.quotationToOrderPhraseSignals.length > 0;
  const hasQuotationToOrderConversion = quotationOrderIntent.quotationToOrderConversionSignals.length > 0;
  if (/(?:先按|按).{0,12}(?:不对|不是).{0,12}(?:最后|最终).{0,12}(?:块|元|价)/.test(text)) {
    return { intent: 'quotation', candidates: ['quotation'] };
  }
  if (!hasQuotationToOrderPhrase
    && /(?:不对|不是|改成).*(?:带走|交货|发货|做|订)|(?:带走|交货|发货|做|订).*(?:照上回|按上回|上次)/.test(text)) {
    return { intent: 'order', candidates: ['order'] };
  }
  if (/(?:数量\s*改成|数量改为|先别按旧价|最后按|最终).*(?:个|件|箱|套|只|条|交|发|出|拿)/.test(text)) {
    return { intent: 'order', candidates: ['order'] };
  }
  if (!hasQuotationToOrderConversion
    && /(?:提醒我|别忘了|记得).*(?:回|回复|答复|联系|跟进)/.test(text)
    && !/(?:催.*(?:款|货款|尾款)|(?:款|货款|尾款).*催)/.test(text)) {
    return { intent: 'todo', candidates: ['todo'] };
  }
  if (/售后|断了|坏了|破了|质量问题/.test(text) && /处理|跟进|先/.test(text)) {
    return { intent: 'todo', candidates: ['todo', 'unknown'] };
  }
  if (/联系/.test(text) && parseChineseDate(text, businessDate)) {
    return { intent: 'todo', candidates: ['todo', 'quotation'] };
  }
  if (/只是参考|别录|先别录|不要录|等确认|撤回|上个月的记录|旧记录|货价先不报|不用录/.test(text)) {
    return { intent: 'unknown', candidates: ['unknown'] };
  }
  if (/(?:不要做了?|别做|取消|先别发|暂时别发|等通知|客户取消)/.test(text) && !/(?:改这次|改成|改为|换成)/.test(text)) {
    return { intent: 'unknown', candidates: ['unknown'] };
  }
  const hasPhraseLevelOutboundDeliverySignal = quotationOrderIntent.orderDeliverySignals.length > 0;
  const hasClearOrderFacts = new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text)
    && /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分)/.test(text)
    && (/交|发|拿/.test(text) || hasPhraseLevelOutboundDeliverySignal);
  if (/库存|有没有库存|还有库存|打样|样品|不是大货/.test(text) && !/先下|下单|确认了|定了|订了|先做|做货|要货/.test(text) && !hasClearOrderFacts && extractProduct(text).value) {
    return { intent: 'quotation', candidates: ['quotation', 'todo', 'unknown'] };
  }
  const recordLikeQuestion = /我[:：]|给我发|报|单价|价格|块|元|毛|分|个|件|箱|套|只|条|张|本|交|发|定|订|做|欠|付|转|到账/.test(text);
  if (/多少|哪些|谁|有没有|上次|最近|还欠|要交/.test(text) && /[？?]/.test(text) && !recordLikeQuestion) {
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
  const hasTodoSignal = new RegExp(`提醒我|提醒|别忘了|待会|等下|记得|发.*?对账单|回一下|(?:今天|明天|明日|后天|大后天|上午|中午|下午|晚上|今晚|月底|月末|下周|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\\d{1,2}号|\\d{1,2}日).*?(?:${TODO_ACTION_WORDS})|给(?:他|她|客户|[\\u4e00-\\u9fa5]{1,4}(?:总|姐|哥|老板|经理))?(?:回|回复)|(?:回|回复)(?:他|她|客户)`).test(text);
  const hasDeliverySignal = /交货|发货|要发|要货|月底交|月末交|给我发|今天.*发|明天.*发|后天.*发|下午发|交|拿/.test(text)
    || hasPhraseLevelOutboundDeliverySignal
    || /给(?:他|她)(?!回|回复)/.test(text);
  const hasBareUnitPrice = new RegExp(`(${numberPattern()})\\s*${UNIT_PATTERN}\\s*(${numberPattern()})(?!\\s*(?:${RAW_UNIT_PATTERN}|月|号|日))`).test(text);
  const hasPriceSignal = new RegExp(`(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万俩]+)\\s*(?:块|元|毛|角|分)|(?:一|每)${RAW_UNIT_PATTERN}|单价`).test(text)
    || hasBareUnitPrice;
  const hasExplicitQuotePlan = /(?:问[^，,。；;]{0,12}(?:价|报)|(?:先)?给(?:他|她)?报|先看看价|看(?:看)?价)/.test(text);
  const hasExplicitCompletedPayment = hasExplicitCompletedPaymentSignal(text);
  const hasExplicitReceivable = hasExplicitReceivableSignal(text);
  const orderSignalText = quotationOrderIntent.orderSignalText;
  const hasUnnegatedQuotationSignal = quotationOrderIntent.quotationPositiveSignals.length > 0;
  const hasExplicitQuotationSignal = quotationOrderIntent.quotationPositiveSignals.some(
    (signal) => signal.kind === 'QUOTATION_EXPLICIT'
  );
  const hasQuotationPriceFieldSignal = quotationOrderIntent.quotationPositiveSignals.some(
    (signal) => signal.kind === 'QUOTATION_PRICE_FIELD'
  );
  const hasContextualQuotationSignal = quotationOrderIntent.quotationPositiveSignals.some(
    (signal) => signal.kind === 'QUOTATION_CONTEXTUAL_REPORT_WITH_QUANTITY_AND_PRICE'
  );
  const hasSurvivingOrderAction = quotationOrderIntent.orderPositiveSignals.length > 0
    || quotationOrderIntent.reaffirmedOrderSignals.length > 0;

  if (hasTodoSignal) scores.todo += 7;
  if (/问/.test(text) && /(回|回复|答复)/.test(text) && parseChineseDate(text, businessDate)) scores.todo += 3;
  if (hasExplicitCompletedPayment) scores.payment += 8;
  if (DEPOSIT_PATTERN.test(text)) scores.payment += 5;
  if (DEPOSIT_PATTERN.test(text) && new RegExp(`(${numberPattern()})`).test(text) && !hasQuantity) scores.payment += 4;
  if (DEPOSIT_PATTERN.test(text) && /转了|付了|收了|收到|打了|打款|到账/.test(text) && !hasQuantity) scores.payment += 3;
  if (new RegExp(`(${numberPattern()})\\s*(?:已经到账|到账|已到账)`).test(text)) scores.payment += 5;
  if (/付了|先付|先打|已结清|结清了/.test(text) || (/结清/.test(text) && !/未结清/.test(text))) scores.payment += 5;
  if (/收款.*写错|(?:金额|款).*写错.*不是/.test(text)) scores.payment += 5;
  if (/(?:价格|单价|报价|价).*写错|写错了.*(?:价格|单价|报价|价)/.test(text)) scores.quotation += 7;
  if (/催|提醒.*款|要款/.test(text)) scores.dunning += 5;
  if (hasExplicitReceivable) scores.receivable += 9;
  if (/欠|欠款|应收|还差|先记账|记账|月底结|月结|尾款|货款/.test(text)) scores.receivable += 4;
  if (/(?:今天|明天|后天|下周|月底|月末).*付款/.test(text)) scores.receivable += 5;
  if (/没结|未结|挂账/.test(text)) scores.receivable += 6;
  if (/还有一笔没结|没结.*(?:\d|[零一二两三四五六七八九十百千万俩])/.test(text)) scores.receivable += 4;
  if (/来一单/.test(orderSignalText)) scores.order += 4;
  if (hasQuantity && extractProduct(text).value && /(?:下(?!周)|先整|先来|要货)/.test(orderSignalText)) scores.order += 4;
  if (/订单|下单|先下|交货|发货|要发|给我发|今天.*发|明天.*发|后天.*发|下午发|确认了|追加|再来|先来|先整|生产|做好|开工|排产|要货|返单|补\d|补[零一二两三四五六七八九十百千万俩]|定了|订|做|整|周[一二三四五六日天].*拿/.test(orderSignalText)) scores.order += 4;
  if (hasPhraseLevelOutboundDeliverySignal
    && hasQuantity
    && extractProduct(text).value
    && (hasPriceSignal || countQuantityUnitPairs(text) >= 2)) {
    scores.order += 4;
  }
  if (/(?:按上次价格|按上回|照旧价|价格照旧).*?(?:做|补|再来|返单)/.test(orderSignalText) && hasQuantity) scores.order += 6;
  if (DEPOSIT_PAYMENT_PATTERN.test(orderSignalText) && (hasQuantity || hasDeliverySignal)) scores.order += 4;
  if (DEPOSIT_PAYMENT_PATTERN.test(orderSignalText) && hasQuantity && extractProduct(text).value) {
    scores.order += 8;
    scores.payment = Math.max(0, scores.payment - 4);
  }
  if (/追加|再来|返单|补/.test(orderSignalText) && (hasQuantity || parseChineseDate(text, businessDate))) scores.order += 3;
  if (/改|改成|提前|延期|取消|别做|备注/.test(orderSignalText) && /那单|这单|订单|交期|数量|杯垫|杯子|玩具|包装袋|礼品盒|钥匙扣|水杯|扣子|收纳盒|小夜灯|饰品盒|五金挂件|贴纸|头绳|箱规/.test(orderSignalText)) scores.order += 6;
  if ((/交|拿/.test(orderSignalText) || /给(?:他|她)(?!回|回复)/.test(orderSignalText)) && new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text)) scores.order += 4;
  if (hasQuantity && hasDeliverySignal && hasPriceSignal && !hasExplicitQuotationSignal) scores.order += 4;
  if (hasExplicitQuotationSignal || hasQuotationPriceFieldSignal) scores.quotation += 4;
  if (hasExplicitQuotePlan) {
    scores.quotation += 10;
    scores.order = Math.max(0, scores.order - 6);
  }
  if (hasUnnegatedQuotationSignal && hasQuantity && hasPriceSignal) {
    scores.quotation += hasExplicitQuotationSignal ? 9 : (hasContextualQuotationSignal ? 4 : 0);
  }
  if (/问/.test(text) && hasQuantity && hasPriceSignal && !hasDeliverySignal) scores.quotation += 4;
  if (hasUnnegatedQuotationSignal && /报价|价格|单价/.test(text) && /改|补一下/.test(text)) scores.quotation += 6;
  if ((hasExplicitQuotationSignal || hasContextualQuotationSignal) && !hasQuantity) {
    scores.quotation += 1;
  }
  if (/要|订|定|买|补|先下|先整|做|整/.test(orderSignalText)) scores.order += 1;
  if (/带走/.test(orderSignalText)) scores.order += 4;
  if (/刚转|到账|已到账|付了|已付|收了|收到/.test(text) && /剩|还剩|剩余|还差|补/.test(text) && !extractProduct(text).value) {
    scores.payment += 5;
    scores.order = 0;
  }
  if (/先问价|只问|问价|先报|先都报|一起报|报给客户|先了解|库存/.test(text)
    && hasUnnegatedQuotationSignal) {
    scores.quotation += 4;
    scores.order = Math.max(0, scores.order - 8);
  }
  if (quotationOrderIntent.reaffirmedOrderSignals.length) {
    scores.order += 20;
  } else if (quotationOrderIntent.orderNegationSignals.length && hasSurvivingOrderAction) {
    scores.order += 6;
  }
  if (quotationOrderIntent.orderNegationSignals.length
    && !hasSurvivingOrderAction) {
    scores.order = 0;
  }
  if (quotationOrderIntent.quotationNegationSignals.length
    && !hasUnnegatedQuotationSignal) {
    scores.quotation = 0;
  }
  if (hasQuotationToOrderConversion) {
    scores.order += 20;
  }
  if (/老客户/.test(text) && !hasQuantity && !extractProduct(text).value) scores.order = 0;

  const candidates = Object.keys(scores)
    .filter((key) => key !== 'unknown' && scores[key] > 0)
    .sort((left, right) => scores[right] - scores[left]);
  const isDunning = scores.dunning > 0
    && /(?:(?:催|要款|提醒).*?(?:款|货款|尾款|欠款|应收)|(?:款|货款|尾款|欠款|应收).*?(?:催|要款))/.test(text);

  return {
    intent: isDunning ? 'dunning' : (candidates[0] || 'unknown'),
    candidates: candidates.length ? candidates : ['unknown'],
    evidence: {
      orderNegationApplied: quotationOrderIntent.orderNegationSignals.length > 0
        && !hasSurvivingOrderAction,
      orderDeliverySignals: quotationOrderIntent.orderDeliverySignals,
      orderEntitySignals: quotationOrderIntent.orderEntitySignals,
      orderNegationSignals: quotationOrderIntent.orderNegationSignals,
      orderPositiveSignals: quotationOrderIntent.orderPositiveSignals,
      quotationNegationSignals: quotationOrderIntent.quotationNegationSignals,
      quotationPositiveSignals: quotationOrderIntent.quotationPositiveSignals,
      quotationToOrderConversionSignals:
        quotationOrderIntent.quotationToOrderConversionSignals,
      reaffirmedOrderSignals: quotationOrderIntent.reaffirmedOrderSignals,
      scores: { ...scores },
      winningIntent: isDunning ? 'dunning' : (candidates[0] || 'unknown'),
      winningReason: hasQuotationToOrderConversion && candidates[0] === 'order'
        ? 'EXPLICIT_QUOTATION_TO_ORDER_CONVERSION'
        : ((quotationOrderIntent.reaffirmedOrderSignals.length
        || (quotationOrderIntent.orderNegationSignals.length && hasSurvivingOrderAction))
        && candidates[0] === 'order'
        ? 'REAFFIRMED_ORDER_ACTION'
        : (quotationOrderIntent.orderNegationSignals.length
          && quotationOrderIntent.quotationPositiveSignals.length
          && candidates[0] === 'quotation'
          ? 'EXPLICIT_QUOTATION_WITH_NEGATED_ORDER_ACTION'
          : 'HIGHEST_INTENT_SCORE'))
    }
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

function detectOperation(text, intent) {
  if (!/(改|改成|提前|延期|备注|补一下|写错|取消|别做)/.test(text)) return '';
  if (/取消|别做/.test(text)) return '';
  if (/(?:那笔|上次那笔).*报价|报价.*(?:改|写错)|价格.*(?:改一下|写错)|单价.*(?:改一下|写错)|报.*写错/.test(text)) return 'update_quotation';
  if (/应收|收款|金额.*写错/.test(text)) return '';
  if (/(?:那单|这单|订单|交期|数量|提前|延期|备注|箱规)/.test(text)) return 'update_order';
  if (/(?:那笔|上次那笔).*报价|报价.*改|价格.*改一下|单价.*改一下/.test(text)) return 'update_quotation';
  if (intent === 'quotation' && /报价|价格|单价|价/.test(text)) return 'update_quotation';
  if (intent === 'order' && /那单|这单|订单|交期|数量|提前|延期|备注|上一笔|上次|改|箱规/.test(text)) return 'update_order';
  return '';
}

function buildMissingFields(intent, fields, operation = '') {
  if (['update_order', 'update_quotation'].includes(operation)) return [];
  const missing = [];
  const requiredByIntent = {
    quotation: ['customerName', 'productName', 'quantity', 'unitPrice'],
    order: ['customerName', 'productName', 'quantity', 'dueDate'],
    receivable: ['customerName', 'amount'],
    payment: ['customerName', 'paymentAmount'],
    dunning: ['customerName'],
    todo: ['todoTitle', 'dueDate'],
    query: [],
    unknown: ['intent']
  };
  (requiredByIntent[intent] || []).forEach((field) => {
    if (!fields[field]) missing.push(field);
  });
  const items = Array.isArray(fields.items) ? fields.items : [];
  if (['quotation', 'order'].includes(intent) && items.length) {
    if (items.some((item) => !item.productName) && !missing.includes('productName')) missing.push('productName');
    if (items.some((item) => !item.quantity) && !missing.includes('quantity')) missing.push('quantity');
    const hasPriceInfo = fields.unitPrice
      || fields.totalAmount
      || fields.amount
      || fields.depositAmount
      || fields.paymentAmount
      || items.every((item) => item.unitPrice || item.totalAmount || item.amount);
    if (intent === 'quotation' && items.some((item) => !item.unitPrice) && !missing.includes('unitPrice')) missing.push('unitPrice');
    if (intent === 'order' && !hasPriceInfo && !fields.unitPrice && !fields.totalAmount && !fields.amount && !missing.includes('unitPrice')) missing.push('unitPrice');
  } else if (intent === 'order' && !fields.unitPrice && !fields.totalAmount && !fields.amount && !missing.includes('unitPrice')) {
    missing.push('unitPrice');
  }
  return missing;
}

function calculateAmount(quantity, unitPrice, quantityUnit = '', priceUnit = '') {
  if (!quantity || !unitPrice) return '';
  if (!unitsMatch(quantityUnit, priceUnit)) return '';
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

function cleanChatCustomerName(value) {
  return String(value || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .trim();
}

function getPasteCustomerName(pasteMeta) {
  if (!pasteMeta) return '';
  return cleanChatCustomerName(pasteMeta.customerNameFromChat || pasteMeta.speakerName || '');
}

function isGenericPasteCustomerName(name) {
  return /群|采购|业务|司机|助理|跟单|客服|小张|阿梅|我|自己|海马/.test(cleanChatCustomerName(name));
}

function chooseCustomerName(chatCustomerName, parsedCustomer, normalized) {
  if (chatCustomerName && parsedCustomer && chatCustomerName.includes(parsedCustomer) && chatCustomerName.length > parsedCustomer.length) {
    return chatCustomerName;
  }
  if (parsedCustomer && (/帮|替|给|让|说|记一下|记下|记录/.test(normalized) || isGenericPasteCustomerName(chatCustomerName))) {
    return parsedCustomer;
  }
  return chatCustomerName || parsedCustomer;
}

function getPasteStructuredDraft(pasteMeta) {
  if (!pasteMeta || !pasteMeta.structuredDraft || typeof pasteMeta.structuredDraft !== 'object') return null;
  return pasteMeta.structuredDraft;
}

function getDraftFieldSource(draft, field, fallback) {
  return draft && draft[field] ? `paste_meta:structuredDraft.${field}` : fallback;
}

function hasExplicitQuotationSignal(text) {
  return analyzeQuotationOrderIntent(text).quotationPositiveSignals.some(
    (signal) => signal.kind !== 'QUOTATION_PRICE_FIELD'
  );
}

function detectMixedBusiness(text) {
  const source = String(text || '');
  const quotationOrderIntent = analyzeQuotationOrderIntent(source);
  const orderSignalText = quotationOrderIntent.orderSignalText;
  const hasSeparator = /(?:另外|还有一笔|同时|再说一笔|另一边|除此之外)/.test(source);
  const kinds = [];
  const hasItemQuantity = new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(source);
  const hasTodoSignal = /提醒我|别忘了|记得/.test(source);
  const hasQuotationSignal = quotationOrderIntent.quotationPositiveSignals.some(
    (signal) => signal.kind !== 'QUOTATION_PRICE_FIELD'
  )
    && !(hasTodoSignal && /报价单/.test(source) && !hasItemQuantity);
  if (hasQuotationSignal) kinds.push('quotation');
  const hasCompletedPayment = hasExplicitCompletedPaymentSignal(source);
  const hasOrderAction = /下单|先下|订货|定了|先做|做货|要货|交货|发货|要发|追加|先整|生产|开工|排产|返单/.test(orderSignalText)
    || (hasItemQuantity && /确认了|再来|先来|做好/.test(orderSignalText))
    || /(?:订单|这单|那单|货|商品|产品)[^，,。；;\n]{0,8}(?:确认了|做好)|(?:确认了|做好)[^，,。；;\n]{0,8}(?:订单|这单|那单|货|商品|产品)/.test(orderSignalText)
    || new RegExp(`补\\s*(?:${numberPattern()})`).test(orderSignalText)
    || new RegExp(`订(?!单)[^，,。；;\\n]{0,6}(?:${numberPattern()})\\s*(?:${UNIT_PATTERN})`).test(orderSignalText)
    || /(?:那单|这单|订单|交期|数量)[^，,。；;\n]{0,12}(?:改|提前|延期|取消|备注|追加)|(?:改|提前|延期|取消|备注|追加)[^，,。；;\n]{0,12}(?:那单|这单|订单|交期|数量)/.test(orderSignalText);
  const hasOrderReference = /订单/.test(orderSignalText);
  const suppressNegatedOrder = quotationOrderIntent.orderNegationSignals.length > 0
    && !hasOrderAction
    && !quotationOrderIntent.reaffirmedOrderSignals.length;
  if (!suppressNegatedOrder && (
    hasOrderAction
      || (!hasCompletedPayment && hasOrderReference)
      || (hasItemQuantity && /(?:明天|后天|本周|这周|下周|周[一二三四五六日天]|交|拿|发)/.test(source))
  )) kinds.push('order');
  if (hasCompletedPayment && !/(?:定金|订金|预付)/.test(source)) kinds.push('payment');
  if (/欠款|还差|未结|没结|尾款|待收/.test(source)) kinds.push('receivable');
  if (hasTodoSignal) kinds.push('todo');
  const uniqueKinds = Array.from(new Set(kinds));
  if (hasSeparator) return uniqueKinds.length > 1;
  const hasProductBusiness = uniqueKinds.some((kind) => ['order', 'quotation'].includes(kind));
  const hasOtherBusiness = uniqueKinds.some((kind) => ['payment', 'receivable', 'todo'].includes(kind));
  return hasProductBusiness && hasOtherBusiness;
}

function parseInput({
  text,
  source = 'typed',
  context = 'home',
  state,
  rawText = '',
  extractedText = '',
  pasteMeta = null,
  businessDate = '',
  businessTimezone = 'Asia/Shanghai',
  nowInstant = null
}) {
  const recognitionText = extractedText || text;
  const originalText = normalizeOriginalText(rawText || text);
  const extractedOriginalText = normalizeOriginalText(recognitionText);
  const normalized = normalizeText(recognitionText);
  const hasTerminationSignal = TERMINATION_PATTERN.test(normalized);
  const requiresExistingRecord = hasTerminationSignal && REPLACEMENT_AFTER_TERMINATION_PATTERN.test(normalized);
  const mixedBusiness = detectMixedBusiness(normalized);
  const explicitNoRecord = EXPLICIT_NON_RECORD_PATTERN.test(normalized)
    || (hasTerminationSignal && !requiresExistingRecord)
    || mixedBusiness;
  const structuredDraft = source === 'paste' ? getPasteStructuredDraft(pasteMeta) : null;
  const relationSourceField = source === 'paste'
    && rawText
    && originalText !== extractedOriginalText
    ? 'EXTRACTED_TEXT'
    : 'ORIGINAL_TEXT';
  const scoredIntent = scoreIntent(normalized, context, businessDate, {
    conversionText: extractedOriginalText,
    conversionSourceField: relationSourceField
  });
  const customer = extractCustomerName(normalized);
  const chatCustomerName = source === 'paste' ? getPasteCustomerName(pasteMeta) : '';
  const customerName = chooseCustomerName(chatCustomerName, customer.value, normalized);
  const structuredItems = normalizeItems(structuredDraft && structuredDraft.items);
  const extractedItems = extractItems(normalized, customerName);
  const rawItemDrafts = structuredItems.length ? structuredItems : extractedItems;
  const multiProductNames = extractMultiProductNames(normalized);
  const hasMultiProductDraft = multiProductNames.length > 1 || rawItemDrafts.length > 1;
  const explicitQuotationSignal = hasExplicitQuotationSignal(normalized);
  const structuredIntent = structuredDraft && structuredDraft.intent;
  const hasQuotationToOrderConversion = Boolean(
    scoredIntent.evidence
    && scoredIntent.evidence.quotationToOrderConversionSignals
    && scoredIntent.evidence.quotationToOrderConversionSignals.length
  );
  const intent = structuredIntent
    ? structuredIntent
    : hasMultiProductDraft
    ? (hasQuotationToOrderConversion
      ? 'order'
      : (scoredIntent.intent === 'quotation' || explicitQuotationSignal ? 'quotation' : 'order'))
    : ((structuredDraft && structuredDraft.intent) || scoredIntent.intent);
  const quantity = extractQuantity(normalized);
  const productNumberQuantity = quantity.quantity ? { quantity: '', unit: '', source: '' } : extractQuantityAfterKnownProduct(normalized);
  const unitPrice = extractUnitPrice(normalized);
  const priceUnit = extractPriceUnit(normalized);
  const explicitAmount = extractAmount(normalized);
  const explicitPaymentAmount = extractPaymentAmount(normalized);
  const explicitReceivableAmount = extractReceivableAmount(normalized);
  const depositAmount = extractDepositAmount(normalized);
  const remainingAmount = extractRemainingAmount(normalized);
  const product = extractProduct(normalized, customerName);
  const itemDrafts = repairItemDrafts(rawItemDrafts, normalized, product.value);
  const useItems = ['quotation', 'order'].includes(intent);
  const singleItemDraft = useItems && itemDrafts.length ? itemDrafts[0] : null;
  // “不对八百”“最后确认 500”这类明确更正必须覆盖前面商品旁边的旧数量。
  const quantityValue = (structuredDraft && structuredDraft.quantity) || quantity.quantity || (singleItemDraft && singleItemDraft.quantity) || productNumberQuantity.quantity;
  const unitValue = (singleItemDraft && singleItemDraft.unit) || (structuredDraft && structuredDraft.unit) || quantity.unit || productNumberQuantity.unit;
  const unitPriceValue = (singleItemDraft && singleItemDraft.unitPrice) || (structuredDraft && structuredDraft.unitPrice) || unitPrice.value;
  const priceUnitValue = resolveColloquialPriceUnit(
    unitValue,
    (singleItemDraft && singleItemDraft.priceUnit) || priceUnit,
    normalized
  );
  const computedAmount = calculateAmount(quantityValue, unitPriceValue, unitValue, priceUnitValue);
  // 单商品以已确认的全句数量 × 单价计算，不能让倒装句里局部候选的“1 个”覆盖真实数量。
  const itemTotalAmount = useItems && itemDrafts.length > 1 ? getItemsTotal(itemDrafts) : '';
  const hasDepositSignal = DEPOSIT_PAYMENT_PATTERN.test(normalized);
  const paymentAmount = (intent === 'payment' || /先收|收了|已收|先付|已付|先转|已转|定金|订金|预付|预付款/.test(normalized))
    ? (depositAmount.value || explicitPaymentAmount.value || explicitAmount.value)
    : '';
  const receivableAmount = intent === 'receivable'
    ? (explicitReceivableAmount.value || explicitAmount.value || remainingAmount.value)
    : explicitAmount.value;
  const receivableAmountSource = intent === 'receivable' && explicitReceivableAmount.value
    ? explicitReceivableAmount.source
    : explicitAmount.source;
  const explicitAmountIsDeposit = hasDepositSignal && depositAmount.value && explicitAmount.value === depositAmount.value;
  const calculatedAmount = itemTotalAmount || computedAmount;
  const statedAmount = intent === 'payment' || explicitAmountIsDeposit ? '' : receivableAmount;
  // 老板明确说出的整单总价优先保留。数量×单价只是核对值，两个数不同时
  // 必须展示冲突，不能先把原话金额覆盖掉。
  const amount = statedAmount || calculatedAmount;
  const productName = ['quotation', 'order', 'receivable', 'todo', 'dunning', 'unknown'].includes(intent)
    ? ((singleItemDraft && singleItemDraft.productName) || (hasMultiProductDraft ? multiProductNames.join('、') : ((structuredDraft && structuredDraft.productName) || product.value)))
    : '';
  const dateDetail = parseChineseDateDetail(
    (structuredDraft && structuredDraft.dueText) || normalized,
    businessDate || undefined
  );
  const date = dateDetail.date;
  const suppressNonBusinessOutboundDate = intent === 'unknown'
    && /(?:出去|出门|出差|走走)/.test(normalized);
  const effectiveDueDate = suppressNonBusinessOutboundDate ? '' : date;
  const todoTitle = ['todo', 'dunning'].includes(intent) ? extractTodoTitle(normalized, {
    customerName,
    productName
  }) : { value: '', source: '' };
  const fields = {
    customerName,
    phone: extractPhone(normalized),
    todoTitle: todoTitle.value,
    productName,
    spec: (singleItemDraft && singleItemDraft.spec) || extractSpec(normalized),
    quantity: quantityValue,
    unit: unitValue,
    unitPrice: unitPriceValue,
    priceUnit: priceUnitValue,
    totalAmount: amount,
    statedAmount,
    calculatedAmount,
    paymentAmount,
    depositAmount: hasDepositSignal ? (depositAmount.value || paymentAmount) : '',
    paymentKind: hasDepositSignal ? 'deposit' : '',
    amount,
    remainingAmount: remainingAmount.value,
    paymentMethod: /月结/.test(normalized) ? '月结' : (DEPOSIT_PATTERN.test(normalized) ? '预付' : ''),
    dueDate: effectiveDueDate,
    quoteDate: businessDate || today(),
    remark: buildRemarkText(originalText)
  };
  if (useItems) {
    const items = itemDrafts.length ? itemDrafts : [buildLegacyItem(fields)].filter(hasItemValue);
    if (items.length === 1 && /^(?:rule:corrected_quantity|rule:final_quantity)$/.test(quantity.source || '')) {
      items[0].quantity = quantityValue;
      items[0].unit = unitValue || items[0].unit || '';
      items[0].totalAmount = calculateAmount(items[0].quantity, items[0].unitPrice, items[0].unit, items[0].priceUnit);
    }
    if (items.length) {
      if (items.length === 1) {
        if (quantityValue) items[0].quantity = quantityValue;
        if (unitValue) items[0].unit = unitValue;
        if (unitPriceValue) items[0].unitPrice = unitPriceValue;
        if (priceUnitValue) items[0].priceUnit = priceUnitValue;
        items[0].totalAmount = calculateAmount(items[0].quantity, items[0].unitPrice, items[0].unit, items[0].priceUnit);
      }
      fields.items = items;
      const itemsTotal = getItemsTotal(items);
      if (itemsTotal) {
        fields.calculatedAmount = itemsTotal;
        if (!fields.statedAmount) {
          fields.amount = itemsTotal;
          fields.totalAmount = itemsTotal;
        }
      }
    }
  }
  if (remainingAmount.value && !String(fields.remark || '').includes(`剩余${remainingAmount.value}`)) {
    fields.remark = [fields.remark, `剩余${remainingAmount.value}`].filter(Boolean).join('\n');
  }
  if (explicitNoRecord) {
    // 多笔混在一起、取消/等待通知、普通聊天都不能偷偷形成一笔正式业务草稿。
    ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'statedAmount', 'calculatedAmount', 'paymentAmount', 'depositAmount', 'paymentKind', 'amount', 'remainingAmount', 'dueDate', 'todoTitle'].forEach((field) => delete fields[field]);
    delete fields.items;
  }
  let operation = detectOperation(normalized, intent);
  if (intent === 'payment' && hasDepositSignal) operation = 'record_order_deposit';
  const missingFields = buildMissingFields(intent, fields, operation);
  const customerCandidates = findCustomerCandidates(state, fields.customerName, fields.phone);
  const fieldConflicts = [];
  const customerNameCandidates = extractCustomerNameCandidates(normalized);
  if (customerNameCandidates.length > 1) {
    fieldConflicts.push({
      field: 'customerName',
      values: customerNameCandidates,
      message: `一句话里出现多个客户：${customerNameCandidates.join('、')}，请拆开记录。`
    });
  }
  if (mixedBusiness) {
    fieldConflicts.push({
      field: 'intent',
      values: scoredIntent.candidates,
      message: '这一句话里包含多件不同业务，必须拆开后分别确认。'
    });
  }
  const itemsTotal = getItemsTotal(fields.items || []);
  if (itemsTotal && explicitAmount.value && !explicitAmountIsDeposit && !sameMoney(itemsTotal, explicitAmount.value)) {
    fieldConflicts.push({
      field: 'amount',
      values: [itemsTotal, explicitAmount.value],
      message: `商品明细合计${itemsTotal}元，原文总金额${explicitAmount.value}元，不一致，请确认。`
    });
  }
  const unitPriceMismatches = (fields.items || []).filter((item) => item.unit && item.priceUnit && !unitsMatch(item.unit, item.priceUnit));
  if (unitPriceMismatches.length) {
    fieldConflicts.push({
      field: 'priceUnit',
      values: unitPriceMismatches.map((item) => `${item.quantity || '-'}${item.unit}，单价按${item.priceUnit}`),
      message: '数量单位和计价单位不同，系统没有自动换算金额，请确认每种规格的小计或改正计价单位。'
    });
  }
  const hasUnclearMultiItem = useItems
    && countQuantityUnitPairs(normalized) >= 2
    && (!fields.items || fields.items.length < 2);
  if (hasUnclearMultiItem || (multiProductNames.length > 1 && (!fields.items || fields.items.length < multiProductNames.length))) {
    fieldConflicts.push({
      field: 'productName',
      values: multiProductNames.length ? multiProductNames : [],
      message: '这句话像是多个商品，但商品、数量、单价没有稳定对应，请先确认。'
    });
  }
  const lowConfidenceFields = [];
  if (customerCandidates.length > 1) lowConfidenceFields.push('customerName');
  if (customerNameCandidates.length > 1) lowConfidenceFields.push('customerName');
  if (hasUnclearMultiItem) lowConfidenceFields.push('productName', 'quantity', 'unitPrice');
  if (unitPriceMismatches.length) lowConfidenceFields.push('priceUnit');
  if ((dateDetail.ambiguous || dateDetail.invalid) && dateDetail.matchedText) lowConfidenceFields.push('dueDate');
  if (!suppressNonBusinessOutboundDate
    && !fields.dueDate
    && /月底|明天|今天|后|下周|下个月|号|日|交|结|到期/.test(normalized)) {
    lowConfidenceFields.push('dueDate');
  }
  if (mixedBusiness) lowConfidenceFields.push('intent');
  if (!fields.unitPrice && /上次|上图|原价|老价|老款报价|旧价|照旧|价格不变|按上回|还是|按上次/.test(normalized)) lowConfidenceFields.push('unitPrice');

  const confidence = Math.max(
    0.35,
    0.96
      - missingFields.length * 0.13
      - lowConfidenceFields.length * 0.1
      - (intent === 'unknown' ? 0.18 : 0)
  );
  const draftConfidence = structuredDraft && structuredDraft.extractionConfidence
    ? Number(structuredDraft.extractionConfidence)
    : 0;
  const finalConfidence = draftConfidence ? Math.min(0.98, Math.max(confidence, draftConfidence)) : confidence;
  const computedFields = calculatedAmount ? [statedAmount ? 'calculatedAmount' : 'amount'] : [];
  const computedTips = calculatedAmount ? [statedAmount
    ? `按数量和单价计算为${calculatedAmount}元，已与原话总金额核对。`
    : '总价由数量 × 单价自动计算，可修改。'] : [];
  const intentCandidates = structuredDraft && structuredDraft.intent
    ? [structuredDraft.intent].concat(scoredIntent.candidates.filter((item) => item !== structuredDraft.intent))
    : scoredIntent.candidates;
  const orderRelationReference = extractOrderRelationReference(extractedOriginalText, {
    intent,
    customerName,
    productName,
    sourceField: relationSourceField
  });
  const quotationRelationReference = extractQuotationRelationReference(
    extractedOriginalText,
    {
      hasQuotationToOrderConversion,
      customerName,
      productName,
      sourceField: relationSourceField
    }
  );
  const relationReferences = {};
  if (orderRelationReference) relationReferences.order = orderRelationReference;
  if (quotationRelationReference) {
    relationReferences.quotation = quotationRelationReference;
  }

  const result = {
    id: `parse_${Date.now()}`,
    intent,
    operation,
    fields,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields,
    field_conflicts: fieldConflicts,
    customer_candidates: customerCandidates,
    confidence: finalConfidence,
    confirm_message: buildConfirmMessage(intent, missingFields),
    source,
    original_text: originalText,
    date_detail: dateDetail,
    formal_save_blocked: hasTerminationSignal || mixedBusiness,
    block_reason: mixedBusiness
      ? '一句话里包含多件业务，不能合成一笔正式记录。'
      : (hasTerminationSignal ? '这是取消、暂停或撤回旧记录的操作，必须先找到原记录并再次确认。' : ''),
    requires_existing_record: requiresExistingRecord,
    mixed_business: mixedBusiness,
    computed_fields: computedFields,
    computed_tips: computedTips,
    field_sources: {
      customerName: chatCustomerName ? 'paste_meta:customerNameFromChat' : customer.source,
      todoTitle: todoTitle.source,
      productName: hasMultiProductDraft ? 'rule:multi_product_names' : getDraftFieldSource(structuredDraft, 'productName', productName ? product.source : ''),
      quantity: getDraftFieldSource(structuredDraft, 'quantity', quantity.source || productNumberQuantity.source),
      unit: getDraftFieldSource(structuredDraft, 'unit', quantity.source || productNumberQuantity.source),
      unitPrice: getDraftFieldSource(structuredDraft, 'unitPrice', unitPrice.source),
      priceUnit: priceUnitValue ? 'rule:unit_price_unit' : '',
      items: fields.items && fields.items.length ? (structuredItems.length ? 'paste_meta:structuredDraft.items' : 'rule:item_details') : '',
      paymentAmount: paymentAmount ? (depositAmount.source || explicitPaymentAmount.source || explicitAmount.source) : '',
      depositAmount: hasDepositSignal && (depositAmount.value || paymentAmount) ? (depositAmount.source || explicitAmount.source) : '',
      paymentKind: hasDepositSignal ? 'rule:deposit_keyword' : '',
      amount: statedAmount ? receivableAmountSource : (calculatedAmount ? 'rule:quantity_times_unit_price' : ''),
      statedAmount: statedAmount ? receivableAmountSource : '',
      calculatedAmount: calculatedAmount ? 'rule:quantity_times_unit_price' : '',
      remainingAmount: remainingAmount.source,
      dueDate: suppressNonBusinessOutboundDate
        ? ''
        : getDraftFieldSource(structuredDraft, 'dueText', date ? 'rule:date_phrase' : '')
    },
    multi_products: hasMultiProductDraft ? multiProductNames : [],
    intent_candidates: intentCandidates,
    intent_evidence: scoredIntent.evidence || {
      orderNegationApplied: false,
      orderDeliverySignals: [],
      orderEntitySignals: [],
      orderNegationSignals: [],
      orderPositiveSignals: [],
      quotationNegationSignals: [],
      quotationPositiveSignals: [],
      quotationToOrderConversionSignals: [],
      reaffirmedOrderSignals: [],
      scores: {},
      winningIntent: intent,
      winningReason: 'EARLY_INTENT_RULE'
    },
    ai_fallback: {
      needed: !explicitNoRecord && shouldSuggestAiFallback({
        text: normalized,
        confidence: finalConfidence,
        missingFields,
        source
      }),
      status: 'not_requested'
    },
    createdAt: new Date().toISOString()
  };
  if (Object.keys(relationReferences).length) {
    result.relation_references = relationReferences;
  }
  if (source === 'paste' && rawText && originalText !== extractedOriginalText) {
    result.raw_text = originalText;
    result.extracted_text = extractedOriginalText;
    result.paste_meta = pasteMeta || null;
  }
  return applyLocalParseSafety(result, {
    normalizedText: normalized,
    originalText,
    source,
    businessDate,
    businessTimezone,
    nowInstant
  });
}

module.exports = {
  extractOrderRelationReference,
  extractQuotationRelationReference,
  parseInput,
  shouldSuggestAiFallback
};
