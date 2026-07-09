const { parseChineseDate, today } = require('./date');
const { numberPattern, parseChineseNumber } = require('./chinese-number');
const { simpleFingerprint } = require('./storage');
const { normalizeBusinessText } = require('./text-normalize');
const { applyLocalParseSafety } = require('./parse-safety');

const UNITS = ['个', '件', '箱', '套', '只', '条', '批', '双', '张', '本', '斤', '公斤', '米', '包', '盒', '袋', '组', '把', '台'];
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
  '笔'
];
const CUSTOMER_ACTION_PATTERN = '那边|这边|说|问|欠|欠款|尾款|货款|定金|订金|预付|预付款|还差|还我|还了|还|付|付款|转|打款|到账|先打|下单|先下|下|要|要发|问|报|报架|订|定|定了|买|拿|补|返单|做|收';
const TODO_ACTION_WORDS = '回|回复|答复|跟进|问|催|联系|提醒|确认|发对账单';
const DEPOSIT_PATTERN = /定金|订金|预付|预付款/;
const DEPOSIT_PAYMENT_PATTERN = /定金|订金|预付|预付款|先付|先打|先转/;
const DECIMAL_DIGIT = '\\d|[零一二两三四五六七八九]';
const ITEM_BAD_PRODUCT_PATTERN = /(?:价格|单价|报价|多少钱|颜色|色差|包装(?!袋|盒|纸)|外箱|内盒|logo|特殊|要求|备注|交期|交货|发货|到期|明天|后天|下周|月底|月末|定金|订金|预付|尾款|货款)/i;
const ITEM_EXACT_BAD_PRODUCT_PATTERN = /^(?:块|元|毛|角|分|钱|一个|每个|单价|价格|报价|老板|客户|我|对方|客服|买家|卖家|厂家|工厂|业务员)$/;

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
  return { value: name, source: 'rule:customer_action' };
}

function extractQuantity(text) {
  const packageQuantity = extractPackageQuantity(text);
  if (packageQuantity.quantity) return packageQuantity;

  const finalQuantity = extractFinalQuantity(text);
  if (finalQuantity.quantity) return finalQuantity;

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
    const prefix = text.slice(Math.max(0, item.index - 8), item.index);
    if (!Number.isInteger(parsed) && parsed > 0 && parsed < 100 && /^(?:个|件|只|条|套|双|张|本|箱)$/.test(rawUnit)) return false;
    if (/(?:价格|单价|块|元|毛|角|分)$/.test(prefix)) return false;
    if (parsed === 1 && /(?:块|元|毛|角|分|钱|单价|价格|报价)$/.test(prefix)) return false;
    if (parsed === 1 && /^(?:一|每)(?:个|件|只|条|套|双|张|本|箱)$/.test(item[0])) return false;
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

function extractPackageQuantity(text) {
  const match = text.match(new RegExp(`(${numberPattern()})\\s*(包|盒|箱|袋)\\s*[，,。；;\\s]*(?:每|一)\\s*\\2\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`))
    || text.match(new RegExp(`(${numberPattern()})\\s*(包|盒|箱|袋).*?(?:每|一)\\s*\\2\\s*(${numberPattern()})\\s*(${UNIT_PATTERN})`));
  if (!match) return { quantity: '', unit: '', source: '' };
  const outer = parseChineseNumber(match[1]);
  const inner = parseChineseNumber(match[3]);
  if (!Number.isFinite(outer) || !Number.isFinite(inner)) return { quantity: '', unit: '', source: '' };
  return {
    quantity: toCleanNumber(outer * inner),
    unit: match[4].replace(/^万/, ''),
    source: 'rule:package_multiplier_quantity'
  };
}

function extractFinalQuantity(text) {
  const matches = Array.from(text.matchAll(new RegExp(`(?:最后(?:确认)?|最终|一共|总共|合计|改成|改为|变成|确认)\\D{0,12}?(${numberPattern()})\\s*(${UNIT_PATTERN})?`, 'g')));
  const match = matches.find((item) => /一共|总共|合计|最后|最终/.test(item[0])) || matches[matches.length - 1];
  if (!match) return { quantity: '', unit: '', source: '' };
  const prefix = text.slice(Math.max(0, match.index - 12), match.index + match[0].length);
  if (/(?:价格|单价|块|元|毛|角|分)/.test(prefix) && (!match[2] || /^(?:个|件|只|条|套|双|张|本|箱)$/.test(match[2].replace(/^万/, '')))) {
    return { quantity: '', unit: '', source: '' };
  }
  const rawUnit = match[2] || '';
  const unitHasWan = rawUnit.startsWith('万');
  const parsed = parseChineseNumber(match[1]) * (unitHasWan ? 10000 : 1);
  return {
    quantity: toCleanNumber(parsed),
    unit: rawUnit.replace(/^万/, ''),
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
  const priceUnit = '(?:个|件|只|条|套|双|张|本|箱)';
  const chunk = numberPattern();
  const correctedUnitPrice = text.match(new RegExp(`(?:价格|单价|报价|价)[^，,。；;]{0,16}?(?:不是|不对)\\s*(?:${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:是|改成|应为)?\\s*(${chunk})`))
    || text.match(new RegExp(`(?:不是|不对)\\s*(?:${chunk})\\s*(?:块|元|毛|角|分)?\\s*(?:是|改成|应为)\\s*(${chunk})(?=\\s*(?:，|,|。|；|;|周|明天|后天|月底|月末|\\d{1,2}号|天后|交|发|出|拿|$))`));
  if (correctedUnitPrice && /价格|单价|报价|价|不是|不对/.test(text.slice(Math.max(0, correctedUnitPrice.index - 20), correctedUnitPrice.index + correctedUnitPrice[0].length))) {
    return {
      value: toCleanNumber(parseChineseNumber(correctedUnitPrice[1])),
      source: 'rule:corrected_unit_price'
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
  const explicit = text.match(new RegExp(`(?:总价|总共|一共|合计|金额|欠(?:我|款)?|应收|还差|尾款|定金|订金|预付款?|收了|收到|先收|付了|先付|付款|刚?转了?|刚转|先转|打款|到账|已经到账|先打|给了|还我|还了)\\s*(${numberPattern()})\\s*(万|万元|块|元|块钱)?(?=$|[，,。；;\\s]|月底|明天|今天|下个月|前|结|给|说|还|后|后面|剩)`));
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
    .sort((left, right) => left.index - right.index || right.item.length - left.item.length)[0];
  if (known) return { value: known.item, source: 'rule:known_product' };

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

function extractKnownProducts(text) {
  const source = String(text || '');
  return KNOWN_PRODUCTS
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((item) => ({ item, index: source.indexOf(item) }))
    .filter((entry) => entry.index >= 0)
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
      .replace(new RegExp(`^${customer}`), '')
      .replace(new RegExp(`^${shortCustomer}`), '');
  }

  const hadTrailingAction = /(?:那边|这边|说|问|要|订|定|定了|下单|先下|先做|做|补|发|出|拿)$/.test(cleaned);
  cleaned = cleaned
    .replace(/^(?:给|帮|找|问|报给|报价给|发给|卖给|转给|先问|再问|另外|还有|先下|先做|下单|下|做|要|订|定了|定|买|补|追加|发|出|拿|记一下|记下|客户|那个|这个|这边|那边)+/, '')
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
  if (/^(?:定|订|要|问|报|报价|做|发|下|补|货|客户|产品|这个|那个|先|再|还有|另外)$/.test(cleaned)) return '';
  if (ITEM_BAD_PRODUCT_PATTERN.test(cleaned)) return '';
  if (/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分|钱)?$/.test(cleaned)) return '';
  return cleaned;
}

function cleanCustomerCandidateName(value) {
  let name = cleanCustomerName(value);
  name = name
    .replace(/^(?:我|帮我|提醒我|请我)?(?:催|问|联系|找|提醒)/, '')
    .replace(/^(?:我|帮我|给我|请我|提醒我)/, '')
    .replace(/(?:刚刚|刚|已经|已|又|还|定金|订金|货款|尾款|欠款|款)$/g, '')
    .trim();
  return cleanCustomerName(name);
}

function parseQuantityWithUnit(rawNumber, rawUnit) {
  const unit = String(rawUnit || '');
  const unitHasWan = unit.startsWith('万');
  const parsed = parseChineseNumber(rawNumber) * (unitHasWan ? 10000 : 1);
  if (!Number.isFinite(parsed) || parsed <= 0) return { quantity: '', unit: '' };
  return {
    quantity: toCleanNumber(parsed),
    unit: unit.replace(/^万/, '')
  };
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
    const productName = cleanItemProductName(rawProduct, customerName);
    const quantity = parseQuantityWithUnit(rawQuantity, rawUnit);
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
  const totalAmount = item.totalAmount || item.total_amount || item.amount
    ? toCleanNumber(item.totalAmount || item.total_amount || item.amount)
    : calculateAmount(quantity, unitPrice);
  return {
    productName,
    spec: item.spec || '',
    quantity,
    unit: item.unit || '',
    unitPrice,
    totalAmount,
    itemDeliveryDate: item.itemDeliveryDate || item.deliveryDate || item.dueDate || '',
    itemRemark: item.itemRemark || item.remark || ''
  };
}

function hasItemValue(item) {
  return Boolean(item && (item.productName || item.quantity || item.unitPrice || item.totalAmount));
}

function normalizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(normalizeItem)
    .filter(hasItemValue);
}

function extractItems(text, customerName = '') {
  const candidates = extractItemCandidates(text, customerName);
  return candidates.map((candidate, index) => {
    const next = candidates[index + 1];
    const itemText = text.slice(candidate.index, next ? next.index : text.length);
    const unitPrice = extractUnitPrice(itemText);
    const totalAmount = calculateAmount(candidate.quantity, unitPrice.value);
    return normalizeItem(Object.assign({}, candidate, {
      unitPrice: unitPrice.value,
      totalAmount,
      itemRemark: '',
      source: [candidate.source, unitPrice.source].filter(Boolean).join('+')
    }));
  });
}

function buildLegacyItem(fields = {}) {
  return normalizeItem({
    productName: fields.productName,
    spec: fields.spec,
    quantity: fields.quantity,
    unit: fields.unit,
    unitPrice: fields.unitPrice,
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
      const unit = match[2].replace(/^万/, '');
      const parsed = parseChineseNumber(match[1]) * (match[2].startsWith('万') ? 10000 : 1);
      const prefix = text.slice(Math.max(0, match.index - 8), match.index);
      if (!Number.isFinite(parsed) || parsed <= 0) return false;
      if (parsed === 1 && /(?:块|元|毛|角|分|钱|单价|价格|报价|\d+\.\d+|\d)$/.test(prefix)) return false;
      return /^(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|包|盒|袋|组|把|台)$/.test(unit);
    })
    .length;
}

function extractCustomerNameCandidates(text) {
  const source = String(text || '');
  const names = [];
  const titled = source.match(/[\u4e00-\u9fa5A-Za-z]{1,8}(?:总|老板|经理|姐|哥|先生|女士)/g) || [];
  titled.forEach((name) => names.push(cleanCustomerCandidateName(name)));

  const actionPattern = new RegExp(`([\\u4e00-\\u9fa5]{1,4})(?:${CUSTOMER_ACTION_PATTERN})`, 'g');
  let match;
  while ((match = actionPattern.exec(source)) !== null) {
    names.push(cleanCustomerCandidateName(match[1]));
  }

  return names
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .filter((name) => !/^(先|再|另外|还有|都|客户|产品|这个|那个)$/.test(name))
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

function scoreIntent(text, context) {
  if (context === 'query') return { intent: 'query', candidates: ['query'] };
  if (/售后|断了|坏了|破了|质量问题/.test(text) && /处理|跟进|先/.test(text)) {
    return { intent: 'todo', candidates: ['todo', 'unknown'] };
  }
  if (/联系/.test(text) && parseChineseDate(text)) {
    return { intent: 'todo', candidates: ['todo', 'quotation'] };
  }
  if (/只是参考|别录|先别录|不要录|等确认|撤回|上个月的记录|旧记录|货价先不报|不用录/.test(text)) {
    return { intent: 'unknown', candidates: ['unknown'] };
  }
  if (/(?:不要做了?|别做|取消|先别发|暂时别发|等通知|客户取消)/.test(text)) {
    return { intent: 'unknown', candidates: ['unknown'] };
  }
  if (/库存|有没有库存|还有库存|打样|样品|不是大货/.test(text) && !/先下|下单|确认了|定了|订了|先做|做货|要货/.test(text) && extractProduct(text).value) {
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
  const hasDeliverySignal = /交货|发货|要发|要货|月底交|月末交|给我发|今天.*发|明天.*发|后天.*发|下午发|交|拿|出/.test(text) || /给(?:他|她)(?!回|回复)/.test(text);
  const hasBareUnitPrice = new RegExp(`(${numberPattern()})\\s*${UNIT_PATTERN}\\s*(${numberPattern()})(?!\\s*(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|包|盒|袋|组|把|台|月|号|日))`).test(text);
  const hasPriceSignal = /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分)|(?:一|每)(?:个|件|只|条|套|双|张|本|箱)|单价/.test(text)
    || hasBareUnitPrice;
  const hasStrongQuotationSignal = /报价|报架|报个价|问价|多少钱|问.*(?:价格|价|多少钱)/.test(text);

  if (hasTodoSignal) scores.todo += 7;
  if (/问/.test(text) && /(回|回复|答复)/.test(text) && parseChineseDate(text)) scores.todo += 3;
  if (/收了|已收|收到|先收|转了|刚转|先转|转账|已付款|已付|打款|到账|已经到账|还我|还了|给了|定金|订金|预付|预付款/.test(text)) scores.payment += 5;
  if (DEPOSIT_PATTERN.test(text) && new RegExp(`(${numberPattern()})`).test(text) && !hasQuantity) scores.payment += 4;
  if (DEPOSIT_PATTERN.test(text) && /转了|付了|收了|收到|打了|打款|到账/.test(text) && !hasQuantity) scores.payment += 3;
  if (new RegExp(`(${numberPattern()})\\s*(?:已经到账|到账|已到账)`).test(text)) scores.payment += 5;
  if (/付了|先付|先打|已结清|结清了/.test(text) || (/结清/.test(text) && !/未结清/.test(text))) scores.payment += 5;
  if (/收款.*写错|(?:金额|款).*写错.*不是/.test(text)) scores.payment += 5;
  if (/(?:价格|单价|报价|价).*写错|写错了.*(?:价格|单价|报价|价)/.test(text)) scores.quotation += 7;
  if (/催|提醒.*款|要款/.test(text)) scores.dunning += 5;
  if (/欠|欠款|应收|还差|先记账|记账|月底结|月底给|月结|尾款|货款/.test(text)) scores.receivable += 4;
  if (/(?:今天|明天|后天|下周|月底|月末).*付款/.test(text)) scores.receivable += 5;
  if (/没结|未结|挂账/.test(text)) scores.receivable += 6;
  if (/还有一笔没结|没结.*(?:\d|[零一二两三四五六七八九十百千万俩])/.test(text)) scores.receivable += 4;
  if (/订单|下单|先下|交货|发货|要发|给我发|今天.*发|明天.*发|后天.*发|下午发|确认了|追加|再来|生产|做好|开工|排产|要货|返单|补\d|补[零一二两三四五六七八九十百千万俩]|定了|订|做|周[一二三四五六日天].*(?:拿|出)/.test(text)) scores.order += 4;
  if (/(?:按上次价格|按上回|照旧价|价格照旧).*?(?:做|补|再来|返单)/.test(text) && hasQuantity) scores.order += 6;
  if (DEPOSIT_PAYMENT_PATTERN.test(text) && (hasQuantity || hasDeliverySignal)) scores.order += 4;
  if (DEPOSIT_PAYMENT_PATTERN.test(text) && hasQuantity && extractProduct(text).value) {
    scores.order += 8;
    scores.payment = Math.max(0, scores.payment - 4);
  }
  if (/追加|再来|返单|补/.test(text) && (hasQuantity || parseChineseDate(text))) scores.order += 3;
  if (/改|改成|提前|延期|取消|别做|备注/.test(text) && /那单|这单|订单|交期|数量|杯垫|杯子|玩具|包装袋|礼品盒|钥匙扣|水杯|扣子|收纳盒|小夜灯|饰品盒|五金挂件|贴纸|头绳|箱规/.test(text)) scores.order += 6;
  if ((/交|拿|出/.test(text) || /给(?:他|她)(?!回|回复)/.test(text)) && new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text)) scores.order += 4;
  if (hasQuantity && hasDeliverySignal && hasPriceSignal && !hasStrongQuotationSignal) scores.order += 4;
  if (hasStrongQuotationSignal || /单价|要个价格/.test(text)) scores.quotation += 4;
  if (/报/.test(text) && hasQuantity && hasPriceSignal) scores.quotation += 4;
  if (/问/.test(text) && hasQuantity && hasPriceSignal && !hasDeliverySignal) scores.quotation += 4;
  if (/报价|价格|单价/.test(text) && /改|补一下/.test(text)) scores.quotation += 6;
  if (/报/.test(text) && !hasQuantity) scores.quotation += 1;
  if (/要|订|定|买|拿|补|先下|做|出/.test(text)) scores.order += 1;
  if (/刚转|到账|已到账|付了|已付|收了|收到/.test(text) && /剩|还剩|剩余|还差|补/.test(text) && !extractProduct(text).value) {
    scores.payment += 5;
    scores.order = 0;
  }
  if (/不下单|先不下单|不是要货|先问价|只问|问价|不一定做|先报|先都报|一起报|报给客户|先了解|不要记订单|库存/.test(text)) {
    scores.quotation += 4;
    scores.order = Math.max(0, scores.order - 8);
  }
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
  const items = Array.isArray(fields.items) ? fields.items : [];
  if (['quotation', 'order'].includes(intent) && items.length) {
    if (items.some((item) => !item.productName) && !missing.includes('productName')) missing.push('productName');
    if (items.some((item) => !item.quantity) && !missing.includes('quantity')) missing.push('quantity');
    if (intent === 'quotation' && items.some((item) => !item.unitPrice) && !missing.includes('unitPrice')) missing.push('unitPrice');
  }
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
  const hasQuantity = new RegExp(`(${numberPattern()})\\s*(${UNIT_PATTERN})`).test(text);
  const hasBareUnitPrice = new RegExp(`(${numberPattern()})\\s*${UNIT_PATTERN}\\s*(${numberPattern()})(?!\\s*(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|包|盒|袋|组|把|台|月|号|日))`).test(text);
  const hasPrice = /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万俩]+)\s*(?:块|元|毛|角|分)|(?:一|每)(?:个|件|只|条|套|双|张|本|箱)|单价/.test(text)
    || hasBareUnitPrice;
  return /报价|报架|报个价|问价|多少钱|要个价格|先报|一起报|报给客户/.test(text)
    || (/报/.test(text) && hasQuantity && hasPrice);
}

function parseInput({ text, source = 'typed', context = 'home', state, rawText = '', extractedText = '', pasteMeta = null }) {
  const recognitionText = extractedText || text;
  const originalText = normalizeOriginalText(rawText || text);
  const extractedOriginalText = normalizeOriginalText(recognitionText);
  const normalized = normalizeText(recognitionText);
  const structuredDraft = source === 'paste' ? getPasteStructuredDraft(pasteMeta) : null;
  const scoredIntent = scoreIntent(normalized, context);
  const customer = extractCustomerName(normalized);
  const chatCustomerName = source === 'paste' ? getPasteCustomerName(pasteMeta) : '';
  const customerName = chooseCustomerName(chatCustomerName, customer.value, normalized);
  const structuredItems = normalizeItems(structuredDraft && structuredDraft.items);
  const extractedItems = extractItems(normalized, customerName);
  const itemDrafts = structuredItems.length ? structuredItems : extractedItems;
  const multiProductNames = extractMultiProductNames(normalized);
  const hasMultiProductDraft = multiProductNames.length > 1 || itemDrafts.length > 1;
  const explicitQuotationSignal = hasExplicitQuotationSignal(normalized);
  const intent = hasMultiProductDraft
    ? (scoredIntent.intent === 'quotation' || explicitQuotationSignal ? 'quotation' : 'order')
    : ((structuredDraft && structuredDraft.intent) || scoredIntent.intent);
  const quantity = extractQuantity(normalized);
  const productNumberQuantity = quantity.quantity ? { quantity: '', unit: '', source: '' } : extractQuantityAfterKnownProduct(normalized);
  const unitPrice = extractUnitPrice(normalized);
  const explicitAmount = extractAmount(normalized);
  const depositAmount = extractDepositAmount(normalized);
  const remainingAmount = extractRemainingAmount(normalized);
  const product = extractProduct(normalized);
  const useItems = ['quotation', 'order'].includes(intent);
  const singleItemDraft = useItems && itemDrafts.length ? itemDrafts[0] : null;
  const quantityValue = (singleItemDraft && singleItemDraft.quantity) || (structuredDraft && structuredDraft.quantity) || quantity.quantity || productNumberQuantity.quantity;
  const unitValue = (singleItemDraft && singleItemDraft.unit) || (structuredDraft && structuredDraft.unit) || quantity.unit || productNumberQuantity.unit;
  const unitPriceValue = (singleItemDraft && singleItemDraft.unitPrice) || (structuredDraft && structuredDraft.unitPrice) || unitPrice.value;
  const computedAmount = calculateAmount(quantityValue, unitPriceValue);
  const itemTotalAmount = useItems ? getItemsTotal(itemDrafts) : '';
  const hasDepositSignal = DEPOSIT_PAYMENT_PATTERN.test(normalized);
  const paymentAmount = (intent === 'payment' || /先收|收了|已收|先付|已付|先转|已转|定金|订金|预付|预付款/.test(normalized)) ? (depositAmount.value || explicitAmount.value) : '';
  const receivableAmount = explicitAmount.value || (intent === 'receivable' ? remainingAmount.value : '');
  const explicitAmountIsDeposit = hasDepositSignal && depositAmount.value && explicitAmount.value === depositAmount.value;
  const amount = itemTotalAmount || computedAmount || (intent === 'payment' ? '' : (explicitAmountIsDeposit ? '' : receivableAmount));
  const productName = ['quotation', 'order', 'todo'].includes(intent)
    ? ((singleItemDraft && singleItemDraft.productName) || (hasMultiProductDraft ? multiProductNames.join('、') : ((structuredDraft && structuredDraft.productName) || product.value)))
    : '';
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
    totalAmount: amount,
    paymentAmount,
    depositAmount: hasDepositSignal ? (depositAmount.value || paymentAmount) : '',
    paymentKind: hasDepositSignal ? 'deposit' : '',
    amount,
    remainingAmount: remainingAmount.value,
    paymentMethod: /月结/.test(normalized) ? '月结' : (DEPOSIT_PATTERN.test(normalized) ? '预付' : ''),
    dueDate: date,
    quoteDate: today(),
    remark: buildRemarkText(originalText)
  };
  if (useItems) {
    const items = itemDrafts.length ? itemDrafts : [buildLegacyItem(fields)].filter(hasItemValue);
    if (items.length) {
      fields.items = items;
      const itemsTotal = getItemsTotal(items);
      if (itemsTotal) {
        fields.amount = itemsTotal;
        fields.totalAmount = itemsTotal;
      }
    }
  }
  if (remainingAmount.value && !String(fields.remark || '').includes(`剩余${remainingAmount.value}`)) {
    fields.remark = [fields.remark, `剩余${remainingAmount.value}`].filter(Boolean).join('\n');
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
  const itemsTotal = getItemsTotal(fields.items || []);
  if (itemsTotal && explicitAmount.value && !explicitAmountIsDeposit && !sameMoney(itemsTotal, explicitAmount.value)) {
    fieldConflicts.push({
      field: 'amount',
      values: [itemsTotal, explicitAmount.value],
      message: `商品明细合计${itemsTotal}元，原文总金额${explicitAmount.value}元，不一致，请确认。`
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
  if (!fields.dueDate && /月底|明天|今天|后|下周|下个月|号|日|交|结|到期/.test(normalized)) lowConfidenceFields.push('dueDate');
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
    field_conflicts: fieldConflicts,
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
      productName: hasMultiProductDraft ? 'rule:multi_product_names' : getDraftFieldSource(structuredDraft, 'productName', productName ? product.source : ''),
      quantity: getDraftFieldSource(structuredDraft, 'quantity', quantity.source || productNumberQuantity.source),
      unit: getDraftFieldSource(structuredDraft, 'unit', quantity.source || productNumberQuantity.source),
      unitPrice: getDraftFieldSource(structuredDraft, 'unitPrice', unitPrice.source),
      items: fields.items && fields.items.length ? (structuredItems.length ? 'paste_meta:structuredDraft.items' : 'rule:item_details') : '',
      paymentAmount: paymentAmount ? explicitAmount.source : '',
      depositAmount: hasDepositSignal && (depositAmount.value || paymentAmount) ? (depositAmount.source || explicitAmount.source) : '',
      paymentKind: hasDepositSignal ? 'rule:deposit_keyword' : '',
      amount: computedAmount ? 'rule:quantity_times_unit_price' : (amount ? explicitAmount.source : ''),
      remainingAmount: remainingAmount.source,
      dueDate: getDraftFieldSource(structuredDraft, 'dueText', date ? 'rule:date_phrase' : '')
    },
    multi_products: hasMultiProductDraft ? multiProductNames : [],
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
