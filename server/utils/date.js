const { numberPattern, parseChineseNumber } = require('./chinese-number');

function pad(value) {
  return String(value).padStart(2, '0');
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function formatDate(date = new Date()) {
  const normalized = date instanceof Date ? date : toDate(date);
  if (!normalized) return '';
  return `${normalized.getFullYear()}-${pad(normalized.getMonth() + 1)}-${pad(normalized.getDate())}`;
}

function today() {
  return formatDate(new Date());
}

function addDays(dateValue, days) {
  const date = toDate(dateValue) || new Date();
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function endOfMonth(dateValue = new Date()) {
  const date = toDate(dateValue) || new Date();
  return formatDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

function diffDays(left, right) {
  const leftDate = toDate(left);
  const rightDate = toDate(right);
  if (!leftDate || !rightDate) return 0;
  const ms = leftDate.getTime() - rightDate.getTime();
  return Math.round(ms / 86400000);
}

function nextWeekday(target, includeToday = true) {
  const now = new Date();
  const current = now.getDay();
  let days = (target - current + 7) % 7;
  if (days === 0 && !includeToday) days = 7;
  return addDays(now, days);
}

function parseChineseDate(text) {
  const source = text || '';
  const now = new Date();
  if (/今天|今日/.test(source)) return today();
  if (/明天|明日/.test(source)) return addDays(now, 1);
  if (/大后天/.test(source)) return addDays(now, 3);
  if (/后天/.test(source)) return addDays(now, 2);
  if (/月底|月末/.test(source)) return endOfMonth(now);

  const dayAfterMatch = source.match(new RegExp(`(${numberPattern()})\\s*天后`));
  if (dayAfterMatch) {
    return addDays(now, parseChineseNumber(dayAfterMatch[1]));
  }

  const weekAfterMatch = source.match(new RegExp(`(${numberPattern()})?\\s*(?:周|星期|礼拜)后`));
  if (weekAfterMatch) {
    const weeks = weekAfterMatch[1] ? parseChineseNumber(weekAfterMatch[1]) : 1;
    return addDays(now, weeks * 7);
  }

  const nextWeekMatch = source.match(/下(?:周|星期|礼拜)([一二三四五六日天])/);
  if (nextWeekMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return nextWeekday(targetMap[nextWeekMatch[1]], false);
  }

  const weekdayMatch = source.match(/(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekdayMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return nextWeekday(targetMap[weekdayMatch[1]], true);
  }

  const nextMonthDayMatch = source.match(new RegExp(`下(?:个)?月\\s*(${numberPattern()})\\s*(?:号|日)?`));
  if (nextMonthDayMatch) {
    const day = parseChineseNumber(nextMonthDayMatch[1]);
    return formatDate(new Date(now.getFullYear(), now.getMonth() + 1, day));
  }

  const fullMatch = source.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if (fullMatch) {
    return formatDate(new Date(Number(fullMatch[1]), Number(fullMatch[2]) - 1, Number(fullMatch[3])));
  }

  const monthDayMatch = source.match(/(\d{1,2})月(\d{1,2})日?/);
  if (monthDayMatch) {
    return formatDate(new Date(now.getFullYear(), Number(monthDayMatch[1]) - 1, Number(monthDayMatch[2])));
  }

  const dayMatch = source.match(/(\d{1,2})号|(\d{1,2})日/);
  if (dayMatch) {
    const day = Number(dayMatch[1] || dayMatch[2]);
    let date = new Date(now.getFullYear(), now.getMonth(), day);
    if (diffDays(formatDate(date), today()) < -10) {
      date = new Date(now.getFullYear(), now.getMonth() + 1, day);
    }
    return formatDate(date);
  }

  return '';
}

module.exports = {
  addDays,
  diffDays,
  endOfMonth,
  formatDate,
  parseChineseDate,
  nextWeekday,
  today,
  toDate
};
