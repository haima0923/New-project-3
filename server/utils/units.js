const CANONICAL_UNITS = [
  '个', '只', '支', '件', '套', '台', '盒', '瓶', '罐', '桶',
  '打', '箱', '包', '袋', '捆', '扎',
  '斤', '公斤', '吨', '磅',
  '米', '码', '卷',
  '平方米', '平方尺', '张',
  '升', '立方米',
  '车', '柜', '托盘',
  '匹', '令', '两', '克', '千支', '条', '头',
  '批', '双', '对', '本', '组', '把'
];

const UNIT_ALIASES = {
  千克: '公斤',
  kg: '公斤',
  KG: '公斤',
  t: '吨',
  T: '吨',
  lb: '磅',
  LB: '磅',
  m: '米',
  M: '米',
  yd: '码',
  YD: '码',
  '㎡': '平方米',
  'm²': '平方米',
  m2: '平方米',
  'M²': '平方米',
  M2: '平方米',
  L: '升',
  l: '升',
  'm³': '立方米',
  m3: '立方米',
  'M³': '立方米',
  M3: '立方米',
  方: '立方米',
  托: '托盘',
  doz: '打',
  DOZ: '打'
};

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNIT_TOKENS = Array.from(new Set(CANONICAL_UNITS.concat(Object.keys(UNIT_ALIASES))))
  .sort((left, right) => right.length - left.length);
const RAW_UNIT_PATTERN = `(?:${UNIT_TOKENS.map(escapeRegExp).join('|')})`;
const UNIT_PATTERN = `(?:万)?${RAW_UNIT_PATTERN}`;

function normalizeUnit(value) {
  const raw = String(value || '').trim().replace(/^万/, '');
  return UNIT_ALIASES[raw] || raw;
}

function isSupportedUnit(value) {
  return CANONICAL_UNITS.includes(normalizeUnit(value));
}

function unitsMatch(quantityUnit, priceUnit) {
  if (!quantityUnit || !priceUnit) return true;
  return normalizeUnit(quantityUnit) === normalizeUnit(priceUnit);
}

module.exports = {
  CANONICAL_UNITS,
  RAW_UNIT_PATTERN,
  UNIT_ALIASES,
  UNIT_PATTERN,
  isSupportedUnit,
  normalizeUnit,
  unitsMatch
};
