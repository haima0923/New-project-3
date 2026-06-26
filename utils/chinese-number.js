const DIGIT_MAP = {
  零: 0,
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

function parseSection(section) {
  if (isNumericText(section)) return Number(section);
  let total = 0;
  let number = 0;
  const chars = String(section || '').split('');
  chars.forEach((char) => {
    if (DIGIT_MAP[char] !== undefined) {
      number = DIGIT_MAP[char];
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
  const source = String(value || '').trim();
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
  return '\\d+(?:\\.\\d+)?万(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万俩]+)?|\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万俩]+';
}

module.exports = {
  numberPattern,
  parseChineseNumber
};
