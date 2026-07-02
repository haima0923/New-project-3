const { parseChineseDate, today } = require('./date');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const { simpleFingerprint } = require('./storage');
const { applyLocalParseSafety } = require('./parse-safety');

const UNITS = ['个', '件', '箱', '套', '只', '条', '批', '双', '张', '本', '斤', '公斤', '米'];
const UNIT_PATTERN = `(?:万)?(?:${UNITS.join('|')})`;
const PRODUCT_STOP_WORDS = /(价格|报价|报架|单价|订单|交货|发货|生产|做好|到期|月底|月结|结款|付款|欠款|定金|订金|预付|先记|记一下|三天后|下周|礼拜|星期|周[一二三四五六日天]).*$/;
const KNOWN_PRODUCTS = [
  '卡通水杯',
  '老款杯垫',
  '五金挂件',
  '文具套装',
  '包装袋',
  '收纳盒',
  '小夜灯',
  '饰品盒',
  '玩具车',
  '钥匙扣',
  '礼品盒',
  '水杯',
  '杯垫',
  '杯子',
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
  '笔',
  '包'
];
const CUSTOMER_ACTION_PATTERN = '那边|这边|说|问|欠|欠款|尾款|货款|定金|订金|预付|预付款|还差|还我|还了|还|付|付款|转|打款|到账|先打|下单|先下|下|要|要发|问|报|报架|订|定|定了|买|拿|补|返单|做|收';
const TODO_ACTION_WORDS = '回|回复|答复|跟进|问|催|联系|提醒|确认|发对账单';
const DEPOSIT_PATTERN = /定金|订金|预付|预付款/;
const DEPOSIT_PAYMENT_PATTERN = /定金|订金|预付|预付款|先付|先打|先转/;

function normalizeText(text) {
  return String(text || '')
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

function toCleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function extractPhone(text) {
  const match = text.match(/1[3-9]\d{9}/);
  return match ? match[0] : '';
}

function cleanCustomerName(value) {
  let cleaned = String(value || '')
    .replace(/^(今天|明天|明日|后天|大后天|晚上|上午|下午|礼拜[一二三四五六日天]|星期[一二三四五六日天]|周[一二三四五六日天]|下周[一二三四五六日天]?|下个月\d{1,2}号?|号)/, '')
    .replace(/^(刚才|刚刚|别忘了|提醒我|提醒|记得|报给|报价给|发给|卖给|转给|给|帮|找|问|回一下|回|催|联系|那个|这个|义乌|客户)/, '')
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
  if (/^(客户|老客户|这个客户|那个客户|今天|明天|后天|刚才|刚刚|义乌|那笔|上一笔)$/.test(cleaned)) return '';
  if (/客户/.test(cleaned) && !/(总|老板|经理|姐|哥|先生|女士)$/.test(cleaned)) return '';
  if (/^(今天|明天|后天|月底|下周|下个月)$/.test(cleaned)) return '';
  return cleaned;
}

function extractCustomerName(text) {
  if (/^(?:刚才|刚刚)?(?:那单|那笔|上一笔|上次)/.test(text)) {
    return { value: '', source: '' };
  }

  const oldPrefix = text.match(/^(?:刚才|刚刚|那个|这个|义乌)?(老[\u4e00-\u9fa5]{1,2})(?=[\u4e00-\u9fa5]{0,10}(?:那单|那笔|问|要|再来|欠|付|转|打款|到账|返单|补|做|收|尾款|货款|玩具|杯垫|杯子))/);
  if (oldPrefix) {
    const name = cleanCustomerName(oldPrefix[1]);
    if (name) return { value: name, source: 'rule:customer_old_prefix' };
  }
  const direct = text.match(/(?:报价给|报给|发给|卖给|转给|给|帮|找|客户|那个|问|报)?([\u4e00-\u9fa5A-Za-z]{1,8}?(?:总|老板|经理|姐|哥|先生|女士))/);
  if (direct) {
    const name = cleanCustomerName(direct[1]);
    if (name) return { value: name, source: 'rule:customer_title' };
  }
  const oldName = text.match(new RegExp(`(老[\\u4e00-\\u9fa5]{1,2}?)(?:${CUSTOMER_ACTION_PATTERN})`));
  if (oldName) {
    const name = cleanCustomerName(oldName[1]);
    if (name) return { value: name, source: 'rule:customer_action' };
  }
  const fallback = text.match(new RegExp(`([\\u4e00-\\u9fa5]{1,4})(?:${CUSTOMER_ACTION_PATTERN})`));
  if (!fallback) return { value: '', source: '' };
  const name = cleanCustomerName(fallback[1].replace(/^(给|帮|找|客户|那个)/, ''));
  if (!name) return { value: '', source: '' };
  return { value: name.startsWith('老') ? name : `${name}总`, source: 'rule:customer_action' };
}

function extractQuantity(text) {
  const changeMatch = text.match(new RegExp(`(?:改成|改)\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`));
  if (changeMatch) {
    const unitHasWan = changeMatch[2].startsWith('万');
    const parsed = parseChineseNumber(changeMatch[1]) * (unitHasWan ? 10000 : 1);
    return {
      quantity: toCleanNumber(parsed),
      unit: changeMatch[2].replace(/^万/, ''),
      source: 'rule:changed_quantity'
    };
  }

  const explicitQuantity = text.match(new RegExp(`(?:数量|数)\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})?`));
  if (explicitQuantity) {
    const rawUnit = explicitQuantity[2] || '';
    const unitHasWan = rawUnit.startsWith('万');
    const parsed = parseChineseNumber(explicitQuantity[1]) * (unitHasWan ? 10000 : 1);
    return {
      quantity: toCleanNumber(parsed),
      unit: rawUnit.replace(/^万/, ''),
      source: 'rule:explicit_quantity'
    };
  }

  const matches = Array.from(text.matchAll(new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`, 'g')));
  const match = matches.find((item) => {
    const rawUnit = item[2].replace(/^万/, '');
    const unitHasWan = item[2].startsWith('万');
    const parsed = parseChineseNumber(item[1]) * (unitHasWan ? 10000 : 1);
    return !(rawUnit === '批' && parsed === 1);
  });
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

  const colloquialFen = text.match(new RegExp(`(${chunk})\\s*(?:分钱|分)(?!\\s*(?:钟|钟钱))`));
  if (colloquialFen) {
    return {
      value: toCleanNumber(parseChineseNumber(colloquialFen[1]) / 100),
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

  const afterQuantityPrice = text.match(new RegExp(`${UNIT_PATTERN}\\s*(${chunk})\\s*(?:块|元)(?!\\s*(?:钱|[\\d一二两三四五六七八九十百千万俩]*[年月日号天后]))`));
  if (afterQuantityPrice) {
    return {
      value: toCleanNumber(parseChineseNumber(afterQuantityPrice[1])),
      source: 'rule:price_after_quantity'
    };
  }

  const changedPrice = text.match(new RegExp(`(?:单价|价格|价|报价).*?(?:改成|改|成|为|到)\\s*(${chunk})\\s*(?:块|元)?\\s*(${chunk})?`));
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
  const explicit = text.match(new RegExp(`(?:总价|一共|合计|金额|欠(?:我|款)?|应收|还差|尾款|定金|订金|预付款?|收了|收到|付了|先付|付款|刚?转了|先转|打款|到账|已经到账|先打|给了|还我|还了)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还)`));
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
  const match = text.match(new RegExp(`(?:还剩|剩下|剩余|未收|没收|还差)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?`));
  if (!match) return { value: '', source: '' };
  const amount = parseChineseNumber(`${match[1]}${match[2] && match[2].includes('万') ? '万' : ''}`);
  return {
    value: toCleanNumber(amount),
    source: 'rule:remaining_amount'
  };
}

function extractProduct(text) {
  const known = KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .find((item) => text.includes(item));
  if (known) return { value: known, source: 'rule:known_product' };

  const beforeQuantity = text.match(new RegExp(`(?:报价给|报给|发给|卖给|转给|给|帮|找|问|报|报架|要|订|定|定了|补|做|发)?([\\u4e00-\\u9fa5A-Za-z]{2,18}?)\\s*(${numberPattern()})\\s*${UNIT_PATTERN}`));
  if (beforeQuantity) {
    const product = beforeQuantity[1]
      .replace(/.*(?:总|老板|经理|姐|哥|先生|女士)/, '')
      .replace(/^(先下|先做|下|做|要|订|定了|定|补|发|给|帮|找|问|报|报价)/, '')
      .replace(PRODUCT_STOP_WORDS, '')
      .replace(/^的|^，/, '');
    if (product && !/\d/.test(product)) return { value: product, source: 'rule:before_quantity_product' };
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
  if (/问/.test(text)) {
    if (customerName && productName) return { value: `跟进${customerName}${productName}`, source: 'rule:todo_ask_customer_product' };
    if (customerName) return { value: `跟进${customerName}`, source: 'rule:todo_ask_customer' };
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
  const hasTodoSignal = new RegExp(`提醒我|提醒|别忘了|待会|等下|记得|发对账单|回一下|(?:今天|明天|明日|后天|大后天|月底|月末|下周|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\\d{1,2}号|\\d{1,2}日).*?(?:${TODO_ACTION_WORDS})|给(?:他|她|客户|[\\u4e00-\\u9fa5]{1,4}(?:总|姐|哥|老板|经理))?(?:回|回复)|(?:回|回复)(?:他|她|客户)`).test(text);
  const hasDeliverySignal = /交货|发货|要发|要货|月底交|月末交|给我发|今天.*发|明天.*发|后天.*发|下午发|交|拿|出/.test(text) || /给(?:他|她)(?!回|回复)/.test(text);
  const hasPriceSignal = /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分)|(?:一|每)(?:个|件|只|条|套|双|张|本|箱)|单价/.test(text);
  const hasStrongQuotationSignal = /报价|报架|报个价|问价|多少钱|问.*(?:价格|价|多少钱)/.test(text);

  if (hasTodoSignal) scores.todo += 7;
  if (/问/.test(text) && /(回|回复|答复)/.test(text) && parseChineseDate(text)) scores.todo += 3;
  if (/收了|已收|收到|转了|先转|转账|付款|打款|到账|已经到账|还我|还了|给了|定金|订金|预付|预付款/.test(text)) scores.payment += 5;
  if (DEPOSIT_PATTERN.test(text) && /转了|付了|收了|收到|打了|打款|到账/.test(text) && !hasQuantity) scores.payment += 3;
  if (new RegExp(`(${numberPattern()})\\s*(?:已经到账|到账|已到账)`).test(text)) scores.payment += 5;
  if (/付了|先付|先打|已结清|结清了/.test(text) || (/结清/.test(text) && !/未结清/.test(text))) scores.payment += 5;
  if (/收款.*写错|写错了.*不是/.test(text)) scores.payment += 5;
  if (/催|提醒.*款|要款/.test(text)) scores.dunning += 5;
  if (/欠|欠款|应收|还差|先记账|记账|月底结|月底给|月结|尾款|货款/.test(text)) scores.receivable += 4;
  if (/没结|未结|挂账/.test(text)) scores.receivable += 6;
  if (/还有一笔没结|没结.*(?:\d|[零一二两三四五六七八九十百千万俩])/.test(text)) scores.receivable += 4;
  if (/订单|下单|先下|交货|发货|要发|给我发|今天.*发|明天.*发|后天.*发|下午发|确认了|追加|再来|生产|做好|开工|排产|要货|返单|补\d|补[零一二两三四五六七八九十百千万俩]|定了|订|做|周[一二三四五六日天].*(?:拿|出)/.test(text)) scores.order += 4;
  if (DEPOSIT_PAYMENT_PATTERN.test(text) && (hasQuantity || hasDeliverySignal)) scores.order += 4;
  if (/追加|再来|返单|补/.test(text) && (hasQuantity || parseChineseDate(text))) scores.order += 3;
  if (/改|改成|提前|延期|取消|别做|备注/.test(text) && /那单|订单|交期|数量|杯垫|杯子|玩具|包装袋|礼品盒|钥匙扣|水杯|扣子/.test(text)) scores.order += 6;
  if ((/交|拿|出/.test(text) || /给(?:他|她)(?!回|回复)/.test(text)) && new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text)) scores.order += 4;
  if (hasQuantity && hasDeliverySignal && hasPriceSignal && !hasStrongQuotationSignal) scores.order += 4;
  if (hasStrongQuotationSignal || /单价|要个价格/.test(text)) scores.quotation += 4;
  if (/报/.test(text) && hasQuantity && hasPriceSignal) scores.quotation += 4;
  if (/问/.test(text) && hasQuantity && hasPriceSignal && !hasDeliverySignal) scores.quotation += 4;
  if (/报价|价格|单价/.test(text) && /改|补一下/.test(text)) scores.quotation += 6;
  if (/报/.test(text) && !hasQuantity) scores.quotation += 1;
  if (/要|订|定|买|拿|补|先下|做|出/.test(text)) scores.order += 1;
  if (/老客户/.test(text) && !hasQuantity && !extractProduct(text).value) scores.order = 0;

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

function detectOperation(text, intent) {
  if (!/(改|改成|提前|延期|备注|补一下|写错|取消|别做)/.test(text)) return '';
  if (/取消|别做/.test(text)) return '';
  if (/应收|收款|写错/.test(text)) return '';
  if (intent === 'quotation' && /报价|价格|单价|价/.test(text)) return 'update_quotation';
  if (intent === 'order' && /那单|订单|交期|数量|提前|延期|备注|上一笔|上次|改/.test(text)) return 'update_order';
  return '';
}

function buildMissingFields(intent, fields, operation = '') {
  if (['update_order', 'update_quotation'].includes(operation)) return [];
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

function cleanChatCustomerName(value) {
  return String(value || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .trim();
}

function getPasteCustomerName(pasteMeta) {
  if (!pasteMeta) return '';
  return cleanChatCustomerName(pasteMeta.customerNameFromChat || pasteMeta.speakerName || '');
}

function getPasteStructuredDraft(pasteMeta) {
  if (!pasteMeta || !pasteMeta.structuredDraft || typeof pasteMeta.structuredDraft !== 'object') return null;
  return pasteMeta.structuredDraft;
}

function getDraftFieldSource(draft, field, fallback) {
  return draft && draft[field] ? `paste_meta:structuredDraft.${field}` : fallback;
}

function parseInput({ text, source = 'typed', context = 'home', state, rawText = '', extractedText = '', pasteMeta = null }) {
  const recognitionText = extractedText || text;
  const originalText = normalizeOriginalText(rawText || text);
  const extractedOriginalText = normalizeOriginalText(recognitionText);
  const normalized = normalizeText(recognitionText);
  const structuredDraft = source === 'paste' ? getPasteStructuredDraft(pasteMeta) : null;
  const scoredIntent = scoreIntent(normalized, context);
  const intent = (structuredDraft && structuredDraft.intent) || scoredIntent.intent;
  const quantity = extractQuantity(normalized);
  const customer = extractCustomerName(normalized);
  const chatCustomerName = source === 'paste' ? getPasteCustomerName(pasteMeta) : '';
  const customerName = chatCustomerName || customer.value;
  const unitPrice = extractUnitPrice(normalized);
  const explicitAmount = extractAmount(normalized);
  const depositAmount = extractDepositAmount(normalized);
  const remainingAmount = extractRemainingAmount(normalized);
  const product = extractProduct(normalized);
  const quantityValue = (structuredDraft && structuredDraft.quantity) || quantity.quantity;
  const unitValue = (structuredDraft && structuredDraft.unit) || quantity.unit;
  const unitPriceValue = (structuredDraft && structuredDraft.unitPrice) || unitPrice.value;
  const computedAmount = calculateAmount(quantityValue, unitPriceValue);
  const hasDepositSignal = DEPOSIT_PAYMENT_PATTERN.test(normalized);
  const paymentAmount = (intent === 'payment' || /先收|收了|已收|先付|已付|先转|已转|定金|订金|预付|预付款/.test(normalized)) ? (depositAmount.value || explicitAmount.value) : '';
  const receivableAmount = explicitAmount.value || (intent === 'receivable' ? remainingAmount.value : '');
  const explicitAmountIsDeposit = hasDepositSignal && depositAmount.value && explicitAmount.value === depositAmount.value;
  const amount = computedAmount || (intent === 'payment' ? '' : (explicitAmountIsDeposit ? '' : receivableAmount));
  const productName = ['quotation', 'order', 'todo'].includes(intent) ? ((structuredDraft && structuredDraft.productName) || product.value) : '';
  const date = parseChineseDate((structuredDraft && structuredDraft.dueText) || normalized);
  const todoTitle = intent === 'todo' ? extractTodoTitle(normalized, {
    customerName,
    productName
  }) : { value: '', source: '' };
  const fields = {
    customerName,
    phone: extractPhone(normalized),
    todoTitle: todoTitle.value,
    productName,
    spec: '',
    quantity: quantityValue,
    unit: unitValue,
    unitPrice: unitPriceValue,
    paymentAmount,
    depositAmount: hasDepositSignal ? (depositAmount.value || paymentAmount) : '',
    paymentKind: hasDepositSignal ? 'deposit' : '',
    amount,
    remainingAmount: remainingAmount.value,
    paymentMethod: /月结/.test(normalized) ? '月结' : (DEPOSIT_PATTERN.test(normalized) ? '预付' : ''),
    dueDate: date,
    quoteDate: today(),
    remark: originalText
  };
  let operation = detectOperation(normalized, intent);
  if (intent === 'payment' && hasDepositSignal) operation = 'record_order_deposit';
  const missingFields = buildMissingFields(intent, fields, operation);
  const customerCandidates = findCustomerCandidates(state, fields.customerName, fields.phone);
  const lowConfidenceFields = [];
  if (customerCandidates.length > 1) lowConfidenceFields.push('customerName');
  if (!fields.dueDate && /月底|明天|今天|后|下周|下个月|号|日|交|结|到期/.test(normalized)) lowConfidenceFields.push('dueDate');
  if (!fields.unitPrice && /上次|原价|老价|老款报价|旧价|照旧|价格不变|按上回|还是|按上次/.test(normalized)) lowConfidenceFields.push('unitPrice');

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
  const computedFields = computedAmount ? ['amount'] : [];
  const computedTips = computedAmount ? ['总价由数量 × 单价自动计算，可修改。'] : [];
  const intentCandidates = structuredDraft && structuredDraft.intent
    ? [structuredDraft.intent].concat(scoredIntent.candidates.filter((item) => item !== structuredDraft.intent))
    : scoredIntent.candidates;

  const result = {
    id: `parse_${Date.now()}`,
    intent,
    operation,
    fields,
    missing_fields: missingFields,
    low_confidence_fields: lowConfidenceFields,
    customer_candidates: customerCandidates,
    confidence: finalConfidence,
    confirm_message: buildConfirmMessage(intent, missingFields),
    source,
    original_text: originalText,
    computed_fields: computedFields,
    computed_tips: computedTips,
    field_sources: {
      customerName: chatCustomerName ? 'paste_meta:customerNameFromChat' : customer.source,
      todoTitle: todoTitle.source,
      productName: getDraftFieldSource(structuredDraft, 'productName', productName ? product.source : ''),
      quantity: getDraftFieldSource(structuredDraft, 'quantity', quantity.source),
      unit: getDraftFieldSource(structuredDraft, 'unit', quantity.source),
      unitPrice: getDraftFieldSource(structuredDraft, 'unitPrice', unitPrice.source),
      paymentAmount: paymentAmount ? explicitAmount.source : '',
      depositAmount: hasDepositSignal && (depositAmount.value || paymentAmount) ? (depositAmount.source || explicitAmount.source) : '',
      paymentKind: hasDepositSignal ? 'rule:deposit_keyword' : '',
      amount: computedAmount ? 'rule:quantity_times_unit_price' : (amount ? explicitAmount.source : ''),
      remainingAmount: remainingAmount.source,
      dueDate: getDraftFieldSource(structuredDraft, 'dueText', date ? 'rule:date_phrase' : '')
    },
    intent_candidates: intentCandidates,
    ai_fallback: {
      needed: shouldSuggestAiFallback({
        text: normalized,
        confidence: finalConfidence,
        missingFields,
        source
      }),
      status: 'not_requested'
    },
    createdAt: new Date().toISOString()
  };
  if (source === 'paste' && rawText && originalText !== extractedOriginalText) {
    result.raw_text = originalText;
    result.extracted_text = extractedOriginalText;
    result.paste_meta = pasteMeta || null;
  }
  return applyLocalParseSafety(result, {
    normalizedText: normalized,
    originalText,
    source
  });
}

module.exports = {
  parseInput,
  shouldSuggestAiFallback
};
