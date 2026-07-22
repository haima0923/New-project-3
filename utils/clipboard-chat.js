const { numberPattern, parseChineseNumber } = require('./chinese-number');
const { normalizeBusinessText } = require('./text-normalize');
const { RAW_UNIT_PATTERN, normalizeUnit } = require('./units');

function normalizeClipboardText(text) {
  return normalizeBusinessText(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTimeLine(line) {
  return /^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}$/.test(String(line || '').trim());
}

function parseInlineChatHeader(line) {
  const source = normalizeBusinessText(line).trim();
  if (!source || isTimeLine(source)) return null;
  const match = source.match(/^(.{1,24}?)\s+((?:\d{4}年\d{1,2}月\d{1,2}日\s+)?\d{1,2}:\d{2})$/);
  if (!match) return null;
  const speaker = match[1].trim();
  if (!speaker || /[，。！？；,.!?;:：]/.test(speaker)) return null;
  return {
    speaker,
    time: match[2].trim()
  };
}

function isChatHeaderLine(line) {
  return isTimeLine(line) || Boolean(parseInlineChatHeader(line));
}

function countTimelineRows(text) {
  return normalizeClipboardText(text)
    .split('\n')
    .filter(isChatHeaderLine)
    .length;
}

function isTrivialLine(line) {
  const source = String(line || '').trim();
  if (!source) return true;
  if (isChatHeaderLine(source)) return true;
  return /^(好|好的|嗯|哦|OK|ok|收到|谢谢|再试试|好用了|震动吗|有波纹吗|没感觉|就是长按可以|不长按也可以|右上滑跳转了吗|左上滑|右上滑|跳转了吗|测试|试一下)$/.test(source);
}

const PRODUCT_WORDS = [
  '卡通水杯',
  '卡通杯',
  '老款杯垫',
  '五金挂件',
  '文具套装',
  '手提袋',
  '笔袋',
  '纸袋',
  '包装袋',
  '收纳盒',
  '小夜灯',
  '饰品盒',
  '玩具车',
  '钥匙扣',
  '礼品盒',
  '饭盒',
  '水杯',
  '杯垫',
  '杯子',
  '拖鞋',
  '发夹',
  '发圈',
  '勺子',
  '箱包',
  '箱子',
  '扣子',
  '头绳',
  '贴纸',
  '饰品',
  '玩具',
  '五金',
  '文具',
  '日用品',
  '家电',
  '挂件',
  '笔',
  '样品'
];

const UNIT_WORDS = RAW_UNIT_PATTERN;
const SIMPLE_NUMBER = numberPattern();
const DECIMAL_DIGIT = '\\d|[零一二两三四五六七八九]';

function toCleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function cleanSpeakerName(speaker) {
  return normalizeBusinessText(speaker)
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .trim();
}

function isSelfSpeaker(speaker) {
  return /^(我|自己|海马|老板|店里|我们)$/.test(cleanSpeakerName(speaker));
}

function isRelayOrGroupSpeaker(speaker) {
  const name = cleanSpeakerName(speaker);
  return /群|采购|业务|司机|助理|跟单|客服|小张|阿梅/.test(name);
}

function extractCustomerSignal(text) {
  const source = normalizeBusinessText(text).trim();
  const titledName = '[\\u4e00-\\u9fa5A-Za-z]{1,8}(?:总|老板|经理|姐|哥|先生|女士)';
  const patterns = [
    new RegExp(`(?:帮|替|给)\\s*(${titledName})\\s*(?:问|报|看|确认|催|记|下|要|说)`),
    new RegExp(`(${titledName})\\s*(?:说|让|叫|问|要|先|刚|那边|这边)`),
    new RegExp(`(${titledName})\\s*(?=${PRODUCT_WORDS.slice().sort((left, right) => right.length - left.length).join('|')})`),
    new RegExp(`(?:记一下|记下|记录)\\s*(${titledName})`)
  ];
  for (let index = 0; index < patterns.length; index += 1) {
    const match = source.match(patterns[index]);
    if (match && match[1]) return cleanSpeakerName(match[1]);
  }
  return '';
}

function extractProductSignal(text) {
  const source = normalizeBusinessText(text).trim();
  const known = PRODUCT_WORDS
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((item) => ({ item, index: source.indexOf(item) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.item.length - left.item.length)[0];
  if (known) return known.item;

  const askProduct = source.match(/(?:问下|问一下|问问|问|看看|看下|看一下|要|想要|买|订|定|做|报)([\u4e00-\u9fa5A-Za-z0-9]{1,12})/);
  if (askProduct) {
    const before = source.slice(Math.max(0, askProduct.index - 1), askProduct.index);
    if (/不|别/.test(before)) return '';
    const product = askProduct[1]
      .replace(/(?:价格|报价|单价|多少钱|多少|一个|一件|一箱).*$/, '')
      .replace(/^(下|一下|多少|个|件|箱)/, '')
      .trim();
    if (product && !/^(多少|价格|报价|单价|做|太深|太浅|太松|太紧|颜色|浅一点|淡一点|深一点|大一点|小一点|高一点|低一点)$/.test(product)) return product;
  }
  return '';
}

function extractPackageQuantitySignal(text) {
  const source = normalizeBusinessText(text).trim();
  const match = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(包|盒|箱|袋)\\s*[，,。；;\\s]*(?:每|一)\\s*\\2\\s*(${SIMPLE_NUMBER})\\s*(${UNIT_WORDS})`))
    || source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(包|盒|箱|袋).*?(?:每|一)\\s*\\2\\s*(${SIMPLE_NUMBER})\\s*(${UNIT_WORDS})`));
  if (!match) return '';
  const outer = parseChineseNumber(match[1]);
  const inner = parseChineseNumber(match[3]);
  if (!Number.isFinite(outer) || !Number.isFinite(inner)) return '';
  return `${toCleanNumber(outer * inner)}${match[4]}`;
}

function extractFinalQuantitySignal(text, fallbackUnit = '') {
  const source = normalizeBusinessText(text).trim();
  const matches = Array.from(source.matchAll(new RegExp(`(?:最后(?:确认)?|最终|一共|总共|合计|改成|改|改为|变成|确认)\\D{0,12}?(${SIMPLE_NUMBER})\\s*(${UNIT_WORDS})?`, 'g')));
  const finalMatch = matches.find((item) => /一共|总共|合计|最后|最终/.test(item[0])) || matches[matches.length - 1];
  if (finalMatch) {
    const prefix = source.slice(Math.max(0, finalMatch.index - 10), finalMatch.index + finalMatch[0].length);
    if (/(?:价格|单价|块|元|毛|角|分)/.test(prefix)) return '';
    const unit = finalMatch[2] || fallbackUnit || '个';
    return `${finalMatch[1]}${unit}`;
  }
  return '';
}

function extractQuantitySignal(text) {
  const source = normalizeBusinessText(text).trim();
  const packageQuantity = extractPackageQuantitySignal(source);
  if (packageQuantity) return packageQuantity;
  const finalQuantity = extractFinalQuantitySignal(source);
  if (finalQuantity) return finalQuantity;
  const matches = Array.from(source.matchAll(new RegExp(`(${SIMPLE_NUMBER})\\s*(${UNIT_WORDS})`, 'g')));
  const match = matches.find((item) => {
    const parsed = parseChineseNumber(item[1]);
    const candidate = item[0];
    const prefix = source.slice(Math.max(0, item.index - 8), item.index);
    const unit = item[2].replace(/^万/, '');
    if (!Number.isInteger(parsed) && parsed > 0 && parsed < 100 && /^(?:个|件|只|条|套|双|张|本|箱)$/.test(unit)) return false;
    if (/(?:价格|单价|块|元|毛|角|分)$/.test(prefix)) return false;
    if (parsed === 1 && /(?:块|元|毛|角|分|钱|单价|价格|报价)$/.test(prefix)) return false;
    if (parsed === 1 && /(?:一|每)(?:个|件|只|条|套|双|张|本|箱)$/.test(candidate)) return false;
    if (parsed === 1 && /(?:多少钱|多少|单价|价格|报价|问价|几块|几毛)/.test(source)) return false;
    if (parsed === 1 && new RegExp(`(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万]+)\\s*${candidate}`).test(source)) return false;
    return true;
  });
  if (!match) return '';
  return `${match[1]}${match[2]}`;
}

function parseQuantitySignal(value) {
  const match = normalizeBusinessText(value).match(new RegExp(`(${SIMPLE_NUMBER})\\s*(${UNIT_WORDS})`));
  if (!match) return { quantity: '', unit: '' };
  return {
    quantity: toCleanNumber(parseChineseNumber(match[1])),
    unit: normalizeUnit(match[2] || '')
  };
}

function extractDueSignal(text) {
  const source = normalizeBusinessText(text).trim();
  const match = source.match(new RegExp(`(今天|明天|后天|大后天|月底|月末|下周|这周|本周|周[一二三四五六日天]|星期[一二三四五六日天]|(?:${SIMPLE_NUMBER})\\s*天后|\\d{1,2}[/-]\\d{1,2}(?:号|日)?|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{1,2}\\s*号)(?:[^，,。；;]{0,12}(?:交|发|出|拿|到))?`));
  return match ? match[0].replace(/\s+/g, '') : '';
}

function hasPriceQuestion(text) {
  return /多少钱|多少一|价格|报价|单价|几块|几毛|怎么卖|卖多少|问价/.test(normalizeBusinessText(text));
}

function hasQuantityQuestion(text) {
  return /要多少|多少个|多少件|多少箱|数量多少|要几个|几个/.test(normalizeBusinessText(text));
}

function hasNoRecordSignal(text) {
  return /只是参考|别录|先别录|不要录|等确认|撤回|上个月的记录|旧记录|不用录|货价先不报|客户取消/.test(normalizeBusinessText(text));
}

function hasQuoteOnlySignal(text) {
  return /先别下单|不下单|先问价|只问|问价|不一定做|先了解|不是要货|库存|有没有库存|还有库存|先报|报给客户|一起报/.test(normalizeBusinessText(text));
}

function hasOrderSignal(text) {
  const source = normalizeBusinessText(text);
  if (hasQuoteOnlySignal(source) || hasNoRecordSignal(source) || /不是大货|不是新单|先不做/.test(source)) return false;
  return /订单|下单|订|定|先做|先下|做货|生产|交货|发货|出货|拿货|要货|返单|追加|月底交|月末交|交期/.test(source)
    || /做吧|先排/.test(source)
    || new RegExp(`做\\s*(${SIMPLE_NUMBER})\\s*(?:${UNIT_WORDS})`).test(source)
    || /按上次价格做|按上回做|照旧价.*做/.test(source);
}

function formatUnitPrice(number, unit = '个') {
  const value = toCleanNumber(number);
  if (!value) return '';
  return `${value}一${normalizeUnit(unit) || '个'}`;
}

function parseYuanDecimal(whole, decimal) {
  const left = parseChineseNumber(whole);
  if (!Number.isFinite(left)) return NaN;
  if (!decimal) return left;
  const right = parseChineseNumber(decimal);
  if (!Number.isFinite(right)) return left;
  return right >= 10 ? left + (right / 100) : Number(`${left}.${right}`);
}

function parseFenDecimal(fen, li) {
  const left = parseChineseNumber(fen);
  const right = li ? parseChineseNumber(li) : 0;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
  return (left + (right / 10)) / 100;
}

function extractPriceSignal(text, awaitingPrice) {
  const source = normalizeBusinessText(text).trim();
  if (!source) return '';
  const unitPriceWord = `(?:一|每|/)${RAW_UNIT_PATTERN}`;
  const compactPriceDate = new RegExp(`(?:^|[，,\\s])(?:${SIMPLE_NUMBER})\\s*[，,]?\\s*(?:今天|明天|后天|大后天|月底|月末|下周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|(?:${SIMPLE_NUMBER})\\s*天后|\\d{1,2}\\s*号|\\d{1,2}[/-]\\d{1,2}|交|发|出|拿|能做|可以做|做吗)`);
  const hasExplicitPriceSignal = new RegExp(`报价|单价|价格|报|卖|按|块|元|毛|角|分|${unitPriceWord}|能做|可以做|做吗`).test(source)
    || compactPriceDate.test(source);
  if (!awaitingPrice && !hasExplicitPriceSignal) return '';

  const bareNumber = source.match(new RegExp(`^(${SIMPLE_NUMBER})(?:呢|吧|可以吗|行吗|可以|行)?[？?]?$`));
  if (awaitingPrice && bareNumber) return `${bareNumber[1]}一个`;

  const yuanCentsWithUnit = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:块|元)\\s*([0-9]{1,2}|[零二两三四五六七八九]{1,2})\\s*(?:一|每|/)?\\s*(${RAW_UNIT_PATTERN})`));
  if (yuanCentsWithUnit) {
    const value = parseYuanDecimal(yuanCentsWithUnit[1], yuanCentsWithUnit[2]);
    if (Number.isFinite(value)) return formatUnitPrice(value, yuanCentsWithUnit[3]);
  }

  const yuanWithUnit = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:块|元)\\s*(?:一|每|/)\\s*(${RAW_UNIT_PATTERN})`));
  if (yuanWithUnit) {
    const left = parseChineseNumber(yuanWithUnit[1]);
    if (Number.isFinite(left)) return formatUnitPrice(left, yuanWithUnit[2]);
  }

  const colloquialYuan = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:块|元)\\s*(${DECIMAL_DIGIT})(?!\\s*(?:${RAW_UNIT_PATTERN}|天|号|日|月))`));
  if (colloquialYuan) {
    const left = parseChineseNumber(colloquialYuan[1]);
    const right = parseChineseNumber(colloquialYuan[2]);
    if (String(colloquialYuan[1]).includes('.')) return formatUnitPrice(left);
    if (Number.isFinite(left) && Number.isFinite(right)) return formatUnitPrice(Number(`${left}.${right}`));
  }

  const maoWithUnit = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:毛|角)\\s*(?:一|每|/)\\s*(${RAW_UNIT_PATTERN})`));
  if (maoWithUnit) {
    const left = parseChineseNumber(maoWithUnit[1]);
    if (Number.isFinite(left)) return formatUnitPrice(left / 10, maoWithUnit[2]);
  }

  const fenWithUnit = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:分钱|分)\\s*(?:一|每|/)\\s*(${RAW_UNIT_PATTERN})`));
  if (fenWithUnit) {
    const left = parseChineseNumber(fenWithUnit[1]);
    if (Number.isFinite(left)) return formatUnitPrice(left / 100, fenWithUnit[2]);
  }

  const fenDecimalWithUnit = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:分钱|分)\\s*(${DECIMAL_DIGIT})\\s*(?:一|每|/)?\\s*(${RAW_UNIT_PATTERN})`));
  if (fenDecimalWithUnit) {
    const value = parseFenDecimal(fenDecimalWithUnit[1], fenDecimalWithUnit[2]);
    if (Number.isFinite(value)) return formatUnitPrice(value, fenDecimalWithUnit[3]);
  }

  const colloquialFen = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:分钱|分)(?:呢|吧|可以吗|行吗|可以|行)?[？?]?$`));
  if (colloquialFen) {
    const left = parseChineseNumber(colloquialFen[1]);
    if (Number.isFinite(left)) return formatUnitPrice(left / 100);
  }

  const colloquialMao = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:毛|角)\\s*(${DECIMAL_DIGIT})?`));
  if (colloquialMao) {
    const left = parseChineseNumber(colloquialMao[1]);
    const right = colloquialMao[2] ? parseChineseNumber(colloquialMao[2]) : 0;
    if (Number.isFinite(left) && Number.isFinite(right)) return formatUnitPrice((left * 10 + right) / 100);
  }

  const bareNumberWithUnit = source.match(new RegExp(`^(${SIMPLE_NUMBER})\\s*(${RAW_UNIT_PATTERN})(?:呢|吧|可以吗|行吗|可以|行)?[？?]?$`));
  if (awaitingPrice && bareNumberWithUnit) return formatUnitPrice(parseChineseNumber(bareNumberWithUnit[1]), bareNumberWithUnit[2]);

  const compactBarePrice = source.match(new RegExp(`(?:^|[，,\\s])(${SIMPLE_NUMBER})(?=\\s*[，,]?\\s*(?:今天|明天|后天|大后天|月底|月末|下周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|(?:${SIMPLE_NUMBER})\\s*天后|\\d{1,2}\\s*号|\\d{1,2}[/-]\\d{1,2}|交|发|出|拿|能做|可以做|做吗))`));
  if (compactBarePrice) {
    const value = parseChineseNumber(compactBarePrice[1]);
    if (String(compactBarePrice[1]).includes('.') && Number.isFinite(value) && value > 0 && value < 1000) return formatUnitPrice(value);
  }

  const confirmedBarePrice = source.match(new RegExp(`(?:就|按|行|可以|那就|嗯|好)\\s*[,，]?\\s*(${SIMPLE_NUMBER})(?=\\s*(?:[,，]|先做|做|$))`))
    || source.match(new RegExp(`^(${SIMPLE_NUMBER})\\s*(?:呢|吧|可以吗|行不行|行吗|可以|行)[？?]?$`));
  if (awaitingPrice && confirmedBarePrice) return formatUnitPrice(parseChineseNumber(confirmedBarePrice[1]));

  const price = source.match(new RegExp(`(?:报价|单价|价格|报|卖|按)\\s*(${SIMPLE_NUMBER})\\s*(?:块|元)?\\s*(?:一|每|/)?\\s*(${RAW_UNIT_PATTERN})?`))
    || source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:块|元)?\\s*(?:一|每|/)\\s*(${RAW_UNIT_PATTERN})`));
  if (!price) return '';
  const suffix = price[2] || (awaitingPrice ? '个' : '');
  return suffix ? `${price[1]}一${suffix}` : price[1];
}

function parsePriceSignal(value) {
  const source = normalizeBusinessText(value).trim();
  if (!source) return { unitPrice: '', priceUnit: '' };
  const match = source.match(new RegExp(`(${SIMPLE_NUMBER})\\s*(?:一|每|/)\\s*(${UNIT_WORDS})?`))
    || source.match(new RegExp(`^(${SIMPLE_NUMBER})`));
  if (!match) return { unitPrice: '', priceUnit: '' };
  return {
    unitPrice: toCleanNumber(parseChineseNumber(match[1])),
    priceUnit: normalizeUnit(match[2] || '')
  };
}

function getPreviousNonEmptyIndex(lines, startIndex) {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (String(lines[index] || '').trim()) return index;
  }
  return -1;
}

function parseWechatMessages(rawText) {
  const raw = normalizeClipboardText(rawText);
  const lines = raw.split('\n');
  const headers = [];
  lines.forEach((line, index) => {
    const inlineHeader = parseInlineChatHeader(line);
    if (inlineHeader) {
      headers.push({
        index,
        speakerLineIndex: -1,
        contentStart: index + 1,
        speaker: inlineHeader.speaker,
        time: inlineHeader.time
      });
    } else if (isTimeLine(line)) {
      const speakerIndex = getPreviousNonEmptyIndex(lines, index - 1);
      headers.push({
        index,
        speakerLineIndex: speakerIndex,
        contentStart: index + 1,
        speaker: speakerIndex >= 0 ? lines[speakerIndex].trim() : '',
        time: line.trim()
      });
    }
  });

  if (!headers.length) {
    return lines
      .map((line, index) => ({ speaker: '', time: '', content: line.trim(), index }))
      .filter((item) => item.content);
  }

  return headers.map((header, index) => {
    const nextHeader = headers[index + 1];
    const nextSpeakerIndex = nextHeader && nextHeader.speakerLineIndex > header.index
      ? nextHeader.speakerLineIndex
      : -1;
    const contentEnd = nextHeader
      ? (nextSpeakerIndex >= 0 ? nextSpeakerIndex : nextHeader.index)
      : lines.length;
    const content = lines
      .slice(header.contentStart, contentEnd)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
    return {
      speaker: header.speaker,
      time: header.time,
      content,
      index
    };
  }).filter((item) => item.content);
}

function hasCustomerSignal(text) {
  return /[\u4e00-\u9fa5A-Za-z]{1,8}(总|老板|姐|哥|经理|先生|女士)/.test(text);
}

function scoreBusinessText(text) {
  const source = normalizeBusinessText(text).trim();
  if (!source || isTrivialLine(source)) return 0;

  let score = 0;
  if (/报价|报个价|报一下|单价|价格|多少钱|几块|几毛|问价/.test(source)) score += 3;
  if (/订单|下单|订|定|要|做|生产|交货|发货|出货|拿货|要货|返单|追加|别发|不要做|别做|取消|等通知/.test(source)) score += 3;
  if (hasNoRecordSignal(source) || hasQuoteOnlySignal(source)) score += 4;
  if (/欠|尾款|货款|应收|还差|没结|未结|月底结|月结|挂账|到期/.test(source)) score += 3;
  if (/收了|收到|到账|转了|微信转|支付宝|已付|付了|打款|刚转/.test(source)) score += 3;
  if (/售后|质量问题|断了|坏了|破了|处理售后/.test(source)) score += 4;
  if (/提醒|今天|上午|中午|下午|晚上|明天|后天|下周|跟进|回一下|回复|催一下|联系|确认|待办|对账单/.test(source)) score += 2;
  if (hasCustomerSignal(source)) score += 2;
  if (/\d+(?:\.\d+)?|[一二两三四五六七八九十百千万]+/.test(source)) score += 1;
  if (new RegExp(`(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百千万]+)\\s*(?:${RAW_UNIT_PATTERN}|元|块|毛|分)`).test(source)) score += 2;
  if (/今天|上午|中午|下午|晚上|今晚|明天|后天|大后天|月底|月末|下周|周[一二三四五六日天]|星期[一二三四五六日天]|\d+\s*天后|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*号/.test(source)) score += 2;
  if (/水杯|杯子|杯垫|礼品盒|包装袋|扣子|挂件|玩具|文具|钥匙扣|饰品|箱包|箱子|货|产品|样品/.test(source)) score += 2;

  if (/^(好|好的|嗯|哦|OK|ok|收到|谢谢)$/.test(source)) score = 0;
  if (/长按|右上滑|左上滑|波纹|震动|跳转|好用|测试|试试/.test(source) && score < 6) score = 0;
  return score;
}

function formatMessageForExtraction(message) {
  const speaker = String(message.speaker || '').trim();
  const content = String(message.content || '').trim();
  if (!speaker) return content;
  if (hasCustomerSignal(speaker)) return `${speaker}：${content}`;
  return content;
}

function buildSummaryText(context, selectedMessages) {
  const originalText = selectedMessages
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n');
  const customer = cleanSpeakerName(context.customer);
  const product = context.product || '';
  const quantity = context.quantity || '';
  const quantityParts = parseQuantitySignal(quantity);
  const price = quantityParts.unit && quantityParts.unit !== '个' && !context.priceUnitExplicit
    ? String(context.price || '').replace(/一个$/, `一${quantityParts.unit}`)
    : (context.price || '');
  const due = context.due || '';
  let summary = '';

  if ((context.orderSignal || due) && (product || quantity || price || due)) {
    summary = `${customer || ''}${product}${quantity ? quantity : ''}${due ? `，${due}` : ''}${price ? `，${price}` : ''}`;
  } else if (context.priceQuestion && (product || quantity || price)) {
    summary = `${customer ? `给${customer}报` : '报价'}${product}${quantity ? quantity : ''}${price ? `，${price}` : ''}`;
  } else if (product || quantity || price || due) {
    summary = `${customer || ''}${product}${quantity ? quantity : ''}${due ? `，${due}` : ''}${price ? `，${price}` : ''}`;
  }

  if (!summary) return originalText;
  if (!originalText || originalText.includes(summary)) return summary;
  return `${summary}\n${originalText}`;
}

function inferDraftIntent(context) {
  if (context.noRecordSignal) return 'unknown';
  if (context.paymentSignal && context.depositSignal && (context.product || context.quantity || context.due || context.orderSignal)) return 'order';
  if (context.paymentSignal) return 'payment';
  if (context.receivableSignal) return 'receivable';
  if (context.due || context.orderSignal) return 'order';
  if (context.quoteOnlySignal) return 'quotation';
  if (context.priceQuestion && (context.product || context.quantity || context.price)) return 'quotation';
  if (context.price) return 'quotation';
  return '';
}

function buildStructuredDraft(context, score, selectedMessages) {
  const quantity = parseQuantitySignal(context.quantity);
  const price = parsePriceSignal(context.price);
  const priceUnit = context.priceUnitExplicit ? price.priceUnit : (quantity.unit || price.priceUnit || '');
  const intent = inferDraftIntent(context);
  const customerName = cleanSpeakerName(context.customer);
  const productName = context.product || '';
  const item = {
    productName,
    quantity: quantity.quantity,
    unit: quantity.unit || price.priceUnit || '',
    unitPrice: price.unitPrice,
    priceUnit,
    itemDeliveryDate: context.due || ''
  };
  const filledCount = [
    customerName,
    productName,
    quantity.quantity,
    quantity.unit,
    price.unitPrice,
    context.due
  ].filter(Boolean).length;
  const extractionConfidence = Math.min(0.98, Math.max(0.5, (score / 20) + (filledCount * 0.07)));

  return {
    intent,
    customerName,
    customerNameFromChat: customerName,
    productName,
    quantity: quantity.quantity,
    unit: quantity.unit || price.priceUnit || '',
    unitPrice: price.unitPrice,
    priceUnit,
    dueText: context.due || '',
    items: productName ? [item] : [],
    extractionConfidence: toCleanNumber(extractionConfidence),
    extractionReason: selectedMessages.map((item) => item.content).filter(Boolean).join(' / ')
  };
}

function buildConversationBusinessExtraction(scored) {
  const context = {
    customer: '',
    product: '',
    quantity: '',
    price: '',
    due: '',
    priceQuestion: false,
    orderSignal: false,
    quoteOnlySignal: false,
    noRecordSignal: false,
    paymentSignal: false,
    receivableSignal: false,
    depositSignal: false,
    priceUnitExplicit: false,
    cancelledProduct: false
  };
  const selectedIndexes = {};
  let awaitingPrice = false;
  let awaitingQuantity = false;

  scored.forEach((message, index) => {
    const content = String(message.content || '').trim();
    if (!content || isTrivialLine(content)) return;

    const product = extractProductSignal(content);
    const quantity = extractQuantitySignal(content);
    const finalQuantity = context.quantity ? extractFinalQuantitySignal(content, parseQuantitySignal(context.quantity).unit) : extractFinalQuantitySignal(content);
    const due = extractDueSignal(content);
    const priceQuestion = hasPriceQuestion(content);
    const quantityQuestion = hasQuantityQuestion(content);
    const quoteOnlySignal = hasQuoteOnlySignal(content);
    const noRecordSignal = hasNoRecordSignal(content);
    const paymentSignal = /收了|已收|先收|到账|已到账|刚转|转了|付了|已付|打款|定金|预付/.test(normalizeBusinessText(content));
    const depositSignal = /定金|预付/.test(normalizeBusinessText(content));
    const receivableSignal = /货款|尾款|应收|还差|月底结|月结|付款|挂账|没结|未结/.test(normalizeBusinessText(content)) && !paymentSignal;
    const orderSignal = hasOrderSignal(content);
    const price = extractPriceSignal(content, awaitingPrice || priceQuestion || context.priceQuestion);
    const customerSignal = extractCustomerSignal(content);
    const meaningful = product || quantity || finalQuantity || due || priceQuestion || price || orderSignal || quoteOnlySignal || noRecordSignal || paymentSignal || receivableSignal || customerSignal || (message.score >= 5);

    if (meaningful) {
      selectedIndexes[index] = true;
      if (customerSignal && (!context.customer || isRelayOrGroupSpeaker(context.customer) || /帮|替|让|说|记一下/.test(content))) {
        context.customer = customerSignal;
      } else if (message.speaker && !context.customer && !isSelfSpeaker(message.speaker)) {
        context.customer = message.speaker;
      }
      if (/不要|取消/.test(content) && product) context.cancelledProduct = true;
      if (product && (!context.product || /改成|换成|改为|不对|最后|确认/.test(content) || context.cancelledProduct)) {
        context.product = product;
        if (!/不要|取消/.test(content)) context.cancelledProduct = false;
      }
      if (finalQuantity || quantity) {
        const shouldOverrideQuantity = finalQuantity || !context.quantity || /改|改成|改为|最后|最终|确认|一共|总共|合计|不对/.test(content);
        if (shouldOverrideQuantity) context.quantity = finalQuantity || quantity;
      }
      if (due) context.due = due;
      if (priceQuestion) context.priceQuestion = true;
      if (quoteOnlySignal) context.quoteOnlySignal = true;
      if (noRecordSignal) context.noRecordSignal = true;
      if (paymentSignal) context.paymentSignal = true;
      if (receivableSignal) context.receivableSignal = true;
      if (depositSignal) context.depositSignal = true;
      if (orderSignal) context.orderSignal = true;
      if (price && !quantityQuestion) {
        context.price = price;
        context.priceUnitExplicit = new RegExp(`(?:一|每|/)\\s*${RAW_UNIT_PATTERN}`).test(normalizeBusinessText(content));
      }
    }

    if ((awaitingPrice || awaitingQuantity) && meaningful) {
      selectedIndexes[Math.max(0, index - 1)] = true;
    }

    awaitingPrice = priceQuestion && !price;
    awaitingQuantity = quantityQuestion;
  });

  const selectedMessages = scored.filter((_, index) => selectedIndexes[index]);
  const hasEnoughContext = Boolean(
    (context.product && context.quantity)
    || (context.quantity && context.price)
    || (context.product && context.price)
    || selectedMessages.reduce((sum, item) => sum + Math.min(item.score || 0, 4), 0) >= 8
  );

  if (!hasEnoughContext) return null;

  const text = buildSummaryText(context, selectedMessages);
  const customerNameFromChat = cleanSpeakerName(context.customer);
  const score = scoreBusinessText(text)
    + selectedMessages.reduce((sum, item) => sum + Math.min(item.score || 0, 4), 0)
    + (context.product ? 2 : 0)
    + (context.quantity ? 2 : 0)
    + (context.price ? 2 : 0);
  const structuredDraft = buildStructuredDraft(context, score, selectedMessages);

  return {
    messages: selectedMessages,
    text,
    score,
    speakerName: customerNameFromChat,
    customerNameFromChat,
    structuredDraft
  };
}

function chooseBusinessMessages(messages) {
  const scored = messages.map((message) => {
    const text = formatMessageForExtraction(message);
    return Object.assign({}, message, {
      text,
      score: scoreBusinessText(text)
    });
  });

  const conversation = buildConversationBusinessExtraction(scored);
  if (conversation && conversation.score >= 8) return conversation;

  let best = null;
  scored.forEach((message, index) => {
    if (message.score <= 0) return;
    const group = [message];
    for (let offset = 1; offset <= 2; offset += 1) {
      const next = scored[index + offset];
      if (!next || next.score <= 0) break;
      group.push(next);
    }
    const combinedText = group.map((item) => item.text).join('\n');
    const combinedScore = scoreBusinessText(combinedText) + group.reduce((sum, item) => sum + Math.min(item.score, 3), 0);
    if (!best || combinedScore > best.score) {
      best = {
          messages: group,
          text: combinedText,
          score: combinedScore,
          speakerName: group[0] && !isSelfSpeaker(group[0].speaker) ? cleanSpeakerName(group[0].speaker) : '',
          customerNameFromChat: group[0] && !isSelfSpeaker(group[0].speaker) ? cleanSpeakerName(group[0].speaker) : ''
        };
      }
  });

  return best || { messages: [], text: '', score: 0 };
}

function getClipboardWarning(lineCount, messageCount, status) {
  if (!lineCount) return '剪贴板是空的，请先复制微信聊天记录。';
  if (lineCount <= 1 || messageCount <= 1) return '当前剪贴板只包含 1 条内容，通常是微信只复制了一条消息；小程序读不到未进入剪贴板的聊天。';
  if (status === 'no_business') return '没有识别到可记账、订单、收款或提醒的内容，可以补充后再识别，或先存到待整理。';
  return '';
}

function getTextEdge(lines, fromEnd = false) {
  const source = fromEnd ? lines.slice().reverse() : lines;
  const line = source.find((item) => String(item || '').trim());
  return line ? String(line).trim().slice(0, 24) : '';
}

function analyzeClipboardText(text) {
  const rawText = normalizeClipboardText(text);
  const rawLines = rawText ? rawText.split('\n').filter((line) => line.trim()) : [];
  const lineCount = rawLines.length;
  const messages = parseWechatMessages(rawText);
  const selected = chooseBusinessMessages(messages);
  const status = selected.text && selected.score >= 5 ? 'ok' : (rawText ? 'no_business' : 'empty');
  const messageCount = messages.length || (rawText ? 1 : 0);
  return {
    status,
    rawText,
    extractedText: status === 'ok' ? selected.text : '',
    selectedMessages: selected.messages,
    rawMessages: messages,
    speakerName: status === 'ok' ? (selected.speakerName || '') : '',
    customerNameFromChat: status === 'ok' ? (selected.customerNameFromChat || selected.speakerName || '') : '',
    structuredDraft: status === 'ok' ? (selected.structuredDraft || null) : null,
    lineCount,
    messageCount,
    charCount: rawText.length,
    firstLine: getTextEdge(rawLines),
    lastLine: getTextEdge(rawLines, true),
    warning: getClipboardWarning(lineCount, messageCount, status)
  };
}

function getPasteMeta(analysis) {
  return {
    status: analysis.status,
    lineCount: analysis.lineCount,
    messageCount: analysis.messageCount,
    charCount: analysis.charCount || 0,
    firstLine: analysis.firstLine || '',
    lastLine: analysis.lastLine || '',
    speakerName: analysis.speakerName || '',
    customerNameFromChat: analysis.customerNameFromChat || analysis.speakerName || '',
    rawMessages: analysis.rawMessages || [],
    selectedMessages: analysis.selectedMessages || [],
    structuredDraft: analysis.structuredDraft || null,
    warning: analysis.warning || ''
  };
}

function getClipboardDiagnostics(analysis) {
  if (!analysis || !analysis.rawText) return '';
  const edges = analysis.firstLine && analysis.lastLine
    ? `开头：${analysis.firstLine}；结尾：${analysis.lastLine}`
    : '';
  return `已读取 ${analysis.messageCount} 条消息、${analysis.lineCount} 行、${analysis.charCount || analysis.rawText.length} 个字。${edges}`;
}

function getClipboardDisplayText(analysis) {
  return (analysis && (analysis.rawText || analysis.extractedText)) || '';
}

function isSingleMessageClipboard(analysis) {
  return Boolean(analysis && analysis.rawText && (analysis.lineCount <= 3 || analysis.messageCount <= 1));
}

function isWechatChatText(textOrAnalysis) {
  const rawText = typeof textOrAnalysis === 'string'
    ? textOrAnalysis
    : (textOrAnalysis && textOrAnalysis.rawText) || '';
  return countTimelineRows(rawText) >= 2;
}

function getSingleMessagePasteTip() {
  return '当前只读到 1 条微信消息。请回微信多选复制完整聊天，或长按输入框直接粘贴；“追加一条”只作为兜底。';
}

function buildNoBusinessPasteResult(analysis) {
  const rawText = analysis.rawText || '';
  return {
    id: `parse_${Date.now()}`,
    intent: 'unknown',
    operation: 'pending',
    fields: {
      remark: rawText
    },
    missing_fields: ['intent'],
    low_confidence_fields: [],
    customer_candidates: [],
    confidence: 0.2,
    confirm_message: analysis.warning || '没有识别到可保存的业务内容。',
    source: 'paste',
    original_text: rawText,
    raw_text: rawText,
    extracted_text: '',
    paste_meta: getPasteMeta(analysis),
    computed_fields: [],
    computed_tips: [],
    field_sources: {},
    intent_candidates: ['unknown'],
    ai_fallback: {
      needed: false,
      status: 'not_requested'
    },
    createdAt: new Date().toISOString()
  };
}

module.exports = {
  analyzeClipboardText,
  buildNoBusinessPasteResult,
  getClipboardDiagnostics,
  getClipboardDisplayText,
  getPasteMeta,
  getSingleMessagePasteTip,
  isSingleMessageClipboard,
  isWechatChatText,
  normalizeClipboardText,
  parseWechatMessages,
  scoreBusinessText
};
