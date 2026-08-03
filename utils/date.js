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
  const now = arguments.length >= 3 ? (toDate(arguments[2]) || new Date()) : new Date();
  const current = now.getDay();
  let days = (target - current + 7) % 7;
  if (days === 0 && !includeToday) days = 7;
  return addDays(now, days);
}

function calendarWeekday(target, weekOffset = 0, baseDate = new Date()) {
  const now = toDate(baseDate) || new Date();
  const mondayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();
  const monday = toDate(addDays(now, mondayOffset + weekOffset * 7));
  const targetOffset = target === 0 ? 6 : target - 1;
  return addDays(monday, targetOffset);
}

function isValidCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function strictDate(year, month, day) {
  return isValidCalendarDate(year, month, day)
    ? formatDate(new Date(year, month - 1, day))
    : '';
}

function parseChineseDateDetail(text, baseDate = new Date()) {
  const source = text || '';
  const now = toDate(baseDate) || new Date();
  const result = (date = '', matchedText = '', precision = 'day', extra = {}) => Object.assign({
    date,
    matchedText,
    precision,
    ambiguous: false,
    invalid: false
  }, extra);
  let match = source.match(/今天|今日/);
  if (match) return result(formatDate(now), match[0]);
  match = source.match(/明天|明日|明朝|明个儿|明个|明儿/);
  if (match) return result(addDays(now, 1), match[0]);
  match = source.match(/大后天/);
  if (match) return result(addDays(now, 3), match[0]);
  match = source.match(/后天/);
  if (match) return result(addDays(now, 2), match[0]);
  match = source.match(/月底|月末/);
  if (match) return result(endOfMonth(now), match[0], 'month_end');

  // “下周交”没有具体星期几，不能在下一周里随便挑一天。
  match = source.match(/下(?:个)?(?:周|星期|礼拜)(?![一二三四五六日天])/);
  if (match) return result('', match[0], 'week_only', { ambiguous: true });

  const dayAfterMatch = source.match(new RegExp(`(${numberPattern()})\\s*天后`));
  if (dayAfterMatch) {
    return result(addDays(now, parseChineseNumber(dayAfterMatch[1])), dayAfterMatch[0]);
  }

  const weekAfterMatch = source.match(new RegExp(`(${numberPattern()})?\\s*(?:周|星期|礼拜)后`));
  if (weekAfterMatch) {
    const weeks = weekAfterMatch[1] ? parseChineseNumber(weekAfterMatch[1]) : 1;
    return result(addDays(now, weeks * 7), weekAfterMatch[0]);
  }

  const nextWeekMatch = source.match(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (nextWeekMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return result(calendarWeekday(targetMap[nextWeekMatch[1]], 1, now), nextWeekMatch[0], 'calendar_weekday');
  }

  const currentWeekMatch = source.match(/(?:本|这)(?:周|星期|礼拜)([一二三四五六日天])/);
  if (currentWeekMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return result(calendarWeekday(targetMap[currentWeekMatch[1]], 0, now), currentWeekMatch[0], 'calendar_weekday');
  }

  const weekdayMatch = source.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekdayMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return result(nextWeekday(targetMap[weekdayMatch[1]], true, now), weekdayMatch[0], 'weekday');
  }

  const nextMonthDayMatch = source.match(new RegExp(`下(?:个)?月\\s*(${numberPattern()})\\s*(?:号|日)?`));
  if (nextMonthDayMatch) {
    const day = parseChineseNumber(nextMonthDayMatch[1]);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const date = strictDate(nextMonth.getFullYear(), nextMonth.getMonth() + 1, day);
    return result(date, nextMonthDayMatch[0], 'day', { invalid: !date });
  }

  // 老板从微信里粘贴的日期经常在数字、年月日或分隔符两侧带空白。
  // 只在明确的数字日期结构内接受这些空白，不做全句去空格，避免把
  // “下 周 五”一类被拆开的自然语言日期误当成合法日期。
  const fullMatch = source.match(/(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*日?/);
  if (fullMatch) {
    const date = strictDate(Number(fullMatch[1]), Number(fullMatch[2]), Number(fullMatch[3]));
    return result(date, fullMatch[0], 'day', { invalid: !date });
  }

  const slashMonthDayMatch = source.match(/(\d{1,2})\s*[/-]\s*(\d{1,2})\s*(?:号|日)?/);
  if (slashMonthDayMatch) {
    const date = strictDate(now.getFullYear(), Number(slashMonthDayMatch[1]), Number(slashMonthDayMatch[2]));
    return result(date, slashMonthDayMatch[0], 'day', { invalid: !date });
  }

  const monthDayMatch = source.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (monthDayMatch) {
    const date = strictDate(now.getFullYear(), Number(monthDayMatch[1]), Number(monthDayMatch[2]));
    return result(date, monthDayMatch[0], 'day', { invalid: !date });
  }

  const dayMatch = source.match(/(\d{1,2})号|(\d{1,2})日/);
  if (dayMatch) {
    const day = Number(dayMatch[1] || dayMatch[2]);
    // 裸“5号”没有月份。以前自动猜本月/下月会制造错误日期，必须让用户确认。
    return result('', dayMatch[0], 'day_without_month', { ambiguous: true, invalid: day < 1 || day > 31 });
  }

  // 只有“下午/晚上”没有说是哪一天，不能据此猜成今天。放在明确日期规则
  // 之后，避免把“下周五下午”误判成没有日期。
  match = source.match(/上午|中午|下午|晚上|今晚/);
  if (match) return result('', match[0], 'time_only', { ambiguous: true });

  return result();
}

function parseChineseDate(text, baseDate = new Date()) {
  const detail = parseChineseDateDetail(text, baseDate);
  return detail.ambiguous || detail.invalid ? '' : detail.date;
}

module.exports = {
  addDays,
  diffDays,
  endOfMonth,
  formatDate,
  isValidCalendarDate,
  parseChineseDate,
  parseChineseDateDetail,
  nextWeekday,
  today,
  toDate
};
