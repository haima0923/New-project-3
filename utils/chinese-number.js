const DIGIT_MAP = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

const UNIT_MAP = {
  十: 10,
  百: 100,
  千: 1000
};

function isNumericText(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || '').trim());
}

function normalizeNumberText(value) {
  return String(value || '')
    .trim()
    .replace(/[\uff10-\uff19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/(?<=\d),(?=\d{3}\b)/g, '')
    .replace(/俩/g, '两')
    .replace(/壹/g, '一')
    .replace(/[貳贰]/g, '二')
    .replace(/叁|參/g, '三')
    .replace(/肆/g, '四')
    .replace(/伍/g, '五')
    .replace(/陆|陸/g, '六')
    .replace(/柒/g, '七')
    .replace(/捌/g, '八')
    .replace(/玖/g, '九')
    .replace(/拾/g, '十')
    .replace(/佰/g, '百')
    .replace(/仟/g, '千')
    .replace(/萬/g, '万')
    .replace(/([0-9]+(?:\.[0-9]+)?)\s*[wW]/g, (_, value) => String(Number(value) * 10000))
    .replace(/([0-9]+(?:\.[0-9]+)?)\s*[kK]/g, (_, value) => String(Number(value) * 1000))
    .replace(/^([0-9]+(?:\.[0-9]+)?)\s*万$/, (_, value) => String(Number(value) * 10000))
    .replace(/^([0-9]+(?:\.[0-9]+)?)\s*千$/, (_, value) => String(Number(value) * 1000));
}

function parseSection(section) {
  const source = normalizeNumberText(section);
  if (isNumericText(source)) return Number(source);
  if (isNumericText(section)) return Number(section);
  let total = 0;
  let number = 0;
  const chars = String(source || '').split('');
  chars.forEach((char) => {
    if (DIGIT_MAP[char] !== undefined) {
      number = DIGIT_MAP[char];
      return;
    }
    if (/\d/.test(char)) {
      number = Number(char);
      return;
    }
    if (UNIT_MAP[char]) {
      total += (number || 1) * UNIT_MAP[char];
      number = 0;
    }
  });
  return total + number;
}

function parseChineseNumber(value) {
  const source = normalizeNumberText(value);
  if (!source) return NaN;
  if (isNumericText(source)) return Number(source);
  if (/^\d+(?:\.\d+)?万$/.test(source)) return Number(source.replace('万', '')) * 10000;

  const normalized = source.replace(/俩/g, '两');
  if (normalized.includes('万')) {
    const [left, right] = normalized.split('万');
    let rightValue = parseSection(right);
    if (right && !/[十百千]/.test(right) && rightValue > 0 && rightValue < 10) {
      rightValue *= 1000;
    }
    return parseSection(left) * 10000 + rightValue;
  }
  return parseSection(normalized);
}

function numberPattern() {
  return '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?[wWkK]|\\d+(?:\\.\\d+)?(?:万|千)(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万俩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬]+)?|\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万俩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬]+';
}

module.exports = {
  normalizeNumberText,
  numberPattern,
  parseChineseNumber
};
