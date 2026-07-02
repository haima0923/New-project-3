const PRODUCT_ALIAS_PAIRS = [
  ['卡通水怀', '卡通水杯'],
  ['老款杯甸', '老款杯垫'],
  ['水怀', '水杯'],
  ['杯甸', '杯垫'],
  ['钥匙口', '钥匙扣'],
  ['包妆袋', '包装袋'],
  ['包裝袋', '包装袋'],
  ['包裝袋', '包装袋'],
  ['包裝', '包装'],
  ['包妆', '包装'],
  ['礼合', '礼品盒'],
  ['礼品合', '礼品盒'],
  ['饰品合', '饰品盒'],
  ['饰品箱', '饰品盒'],
  ['收纳合', '收纳盒'],
  ['收钠盒', '收纳盒'],
  ['收钠合', '收纳盒'],
  ['小夜等', '小夜灯'],
  ['扣紫', '扣子'],
  ['文具套裝', '文具套装']
];

const WORD_ALIAS_PAIRS = [
  ['报架', '报价'],
  ['延其', '延期'],
  ['到帐', '到账'],
  ['以到账', '已到账'],
  ['挂帐', '挂账'],
  ['对帐单', '对账单'],
  ['定斤', '定金'],
  ['订金', '定金'],
  ['不要作了', '不要做了'],
  ['先憋发', '先别发'],
  ['憋发', '别发'],
  ['几钱', '多少钱'],
  ['多钱', '多少钱'],
  ['明儿', '明天'],
  ['明早', '明天上午'],
  ['淡点', '淡一点'],
  ['高点', '高一点'],
  ['浅点', '浅一点'],
  ['别太深', '不要太深'],
  ['别裁边', '不要裁边'],
  ['盒子里加隔板', '盒子里面加隔板'],
  ['插头欧规', '插头要欧规']
];

const FINANCIAL_DIGIT_MAP = {
  '〇': '零',
  '壹': '一',
  '贰': '二',
  '貳': '二',
  '叁': '三',
  '參': '三',
  '肆': '四',
  '伍': '五',
  '陆': '六',
  '陸': '六',
  '柒': '七',
  '捌': '八',
  '玖': '九',
  '拾': '十',
  '佰': '百',
  '仟': '千',
  '萬': '万',
  '圆': '元'
};

function replaceAllText(text, pairs) {
  return pairs.reduce((current, [from, to]) => current.split(from).join(to), text);
}

function toHalfWidth(text) {
  return String(text || '').replace(/[\uff01-\uff5e]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
  }).replace(/\u3000/g, ' ');
}

function normalizeFinancialDigits(text) {
  return String(text || '').replace(/[〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬圆]/g, (char) => {
    return FINANCIAL_DIGIT_MAP[char] || char;
  });
}

function normalizeArabicMagnitude(text) {
  return String(text || '')
    .replace(/(?<=\d),(?=\d{3}\b)/g, '')
    .replace(/(\d+(?:\.\d+)?)\s*[wW](?=\s*(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|码|包|盒|袋|组|把|台|$))/g, (_, value) => String(Number(value) * 10000))
    .replace(/(\d+(?:\.\d+)?)\s*万(?=\s*(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|码|包|盒|袋|组|把|台|$))/g, (_, value) => String(Number(value) * 10000))
    .replace(/(\d+(?:\.\d+)?)\s*[kK](?=\s*(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|码|包|盒|袋|组|把|台|$))/g, (_, value) => String(Number(value) * 1000))
    .replace(/(\d+(?:\.\d+)?)\s*千(?=\s*(?:个|件|箱|套|只|条|批|双|张|本|斤|公斤|米|码|包|盒|袋|组|把|台|$))/g, (_, value) => String(Number(value) * 1000));
}

function normalizeBusinessText(text) {
  let normalized = toHalfWidth(text);
  normalized = normalizeFinancialDigits(normalized);
  normalized = normalizeArabicMagnitude(normalized);
  normalized = replaceAllText(normalized, PRODUCT_ALIAS_PAIRS);
  normalized = replaceAllText(normalized, WORD_ALIAS_PAIRS);
  normalized = normalized
    .replace(/包\s*装/g, '包装')
    .replace(/对\s*账\s*单/g, '对账单')
    .replace(/logo\s+/gi, 'logo')
    .replace(/一点哈/g, '一点')
    .replace(/logo/gi, 'logo')
    .replace(/LOGO/g, 'logo');
  return normalized;
}

module.exports = {
  normalizeBusinessText,
  normalizeFinancialDigits,
  normalizeArabicMagnitude,
  toHalfWidth
};
