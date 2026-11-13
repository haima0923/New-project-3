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

const CALENDAR_NUMBER = '[负+\\-]?(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)';
const CALENDAR_YEAR = '(?:今年|明年|后年|去年|前年|[\\d零〇一二三四五六七八九]+\\s*年)';

function calendarNumber(raw) {
  const text = String(raw || '').trim();
  // “两三周”“三五天”是范围，不能只采用最后一个中文数字。
  if (/^[负+\-]/.test(text) || /[一二两三四五六七八九]{2}/.test(text)
    || /^[零〇一二两三四五六七八九]{2,}$/.test(text)) return NaN;
  const value = parseChineseNumber(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
}

function calendarYear(raw, currentYear) {
  if (!raw) return currentYear;
  const offsets = { 今年: 0, 明年: 1, 后年: 2, 去年: -1, 前年: -2 };
  if (Object.prototype.hasOwnProperty.call(offsets, raw)) return currentYear + offsets[raw];
  const digits = { 零: '0', 〇: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
  const text = raw.replace(/\s*年$/, '').replace(/[零〇一二三四五六七八九]/g, c => digits[c]);
  return /^\d{4}$/.test(text) ? Number(text) : NaN;
}

function parseSingleChineseDateDetail(text, baseDate = new Date()) {
  const source = String(text || '');
  const now = toDate(baseDate) || new Date();
  const result = (date = '', matchedText = '', precision = 'day', extra = {}) => Object.assign({
    date,
    matchedText,
    precision,
    ambiguous: false,
    invalid: false
  }, extra);
  const badNumberPrefix = (matched) => /[\d.A-Za-z负+\-]$/.test(source.slice(0, matched.index).trim());
  const badCalendarPrefix = (matched) => badNumberPrefix(matched)
    || /[年月半上下本这]$|(?:年|月)的$|(?:上|下|本|这)个$/.test(source.slice(0, matched.index).trim());
  const badDurationPrefix = (matched) => badNumberPrefix(matched)
    || /[年月周天日]$/.test(source.slice(0, matched.index).trim());
  const checkedDate = (date, matched, precision = 'day', badPrefix = false) => {
    const parts = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const valid = !badPrefix && parts && isValidCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    return result(valid ? date : '', matched[0], precision, { invalid: !valid });
  };
  const monthAt = (offset) => new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const monthOffsets = { 本: 0, 这: 0, 这个: 0, 下: 1, 下下: 2, 上: -1, 上上: -2 };

  let match = source.match(/今天|今日/);
  if (match) return result(formatDate(now), match[0]);
  match = source.match(/明天|明日|明朝|明个儿|明个|明儿/);
  if (match) return result(addDays(now, 1), match[0]);
  match = source.match(/大后天/);
  if (match) return result(addDays(now, 3), match[0]);
  match = source.match(/后天/);
  if (match) return result(addDays(now, 2), match[0]);

  // 先消费完整的年份、月份限定，不能把“12月底/下个月底”截成裸“月底”。
  match = source.match(new RegExp(`(?:(${CALENDAR_YEAR})\\s*的?\\s*)?(${CALENDAR_NUMBER})\\s*月(?:的\\s*月)?(?:底|末)`));
  if (match) {
    const year = calendarYear(match[1], now.getFullYear());
    const month = calendarNumber(match[2]);
    const date = strictDate(year, month, 1);
    return checkedDate(date ? endOfMonth(date) : '', match, 'month_end', badCalendarPrefix(match));
  }
  match = source.match(/(?:(下下|下|上上|上|本|这个|这)(?:个)?)?月(?:的\s*月)?(?:底|末)/);
  if (match) {
    return checkedDate(endOfMonth(monthAt(monthOffsets[match[1]] || 0)), match, 'month_end', badCalendarPrefix(match));
  }

  match = source.match(new RegExp(`(?:${numberPattern()})\\s*个?半(?:个)?月(?:之|以)?后|(?:几|数)(?:个)?(?:天|周|星期|礼拜|月)(?:之|以)?后`));
  if (match) return result('', match[0], 'duration_unclear', { ambiguous: true });
  match = source.match(/半(?:个)?月(?:之|以)?后/);
  if (match) return checkedDate(addDays(now, 15), match, 'day', badDurationPrefix(match));

  const dayAfterMatch = source.match(new RegExp(`([负+-]?\\s*(?:${numberPattern()}))\\s*天(?:之|以)?后`));
  if (dayAfterMatch) {
    const rawDays = dayAfterMatch[1].trim();
    const days = calendarNumber(rawDays);
    return checkedDate(Number.isFinite(days) ? addDays(now, days) : '', dayAfterMatch, 'day', badDurationPrefix(dayAfterMatch));
  }

  const weekAfterMatch = source.match(new RegExp(`([负+\\-]?\\s*(?:${numberPattern()}))?\\s*(?:个)?(?:周|星期|礼拜)(?:之|以)?后`));
  if (weekAfterMatch) {
    const weeks = weekAfterMatch[1] ? calendarNumber(weekAfterMatch[1]) : 1;
    const prefix = source.slice(0, weekAfterMatch.index).trim();
    const days = weeks * 7;
    return checkedDate(Number.isSafeInteger(days) ? addDays(now, days) : '', weekAfterMatch, 'day',
      badDurationPrefix(weekAfterMatch) || /[几数半]$/.test(prefix));
  }

  const monthAfterMatch = source.match(new RegExp(`([负+\\-]?\\s*(?:${numberPattern()}))\\s*(?:个)?月(?:之|以)?后`));
  if (monthAfterMatch) {
    const months = calendarNumber(monthAfterMatch[1]);
    const target = Number.isFinite(months) ? monthAt(months) : null;
    const lastDay = target && new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    const date = target ? strictDate(target.getFullYear(), target.getMonth() + 1, Math.min(now.getDate(), lastDay)) : '';
    return checkedDate(date, monthAfterMatch, 'day', badDurationPrefix(monthAfterMatch));
  }

  const nextWeekMatch = source.match(/(下下|下|上上|上|本|这个|这)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (nextWeekMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return checkedDate(calendarWeekday(targetMap[nextWeekMatch[2]], monthOffsets[nextWeekMatch[1]], now), nextWeekMatch,
      'calendar_weekday', badCalendarPrefix(nextWeekMatch));
  }

  // “下周/周末”没有唯一的交货日。
  match = source.match(/(?:(?:下下|下|上上|上|本|这个|这)(?:个)?)?(?:周|星期|礼拜)末|(?:下下|下|上上|上|本|这个|这)(?:个)?(?:周|星期|礼拜)(?![一二三四五六日天])/);
  if (match) return result('', match[0], 'week_only', { ambiguous: true });

  const weekdayMatch = source.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekdayMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return checkedDate(nextWeekday(targetMap[weekdayMatch[1]], true, now), weekdayMatch, 'weekday', badCalendarPrefix(weekdayMatch));
  }

  const nextMonthDayMatch = source.match(new RegExp(`(下下|下|上上|上|本|这个|这)(?:个)?月\\s*(${CALENDAR_NUMBER})\\s*(?:号|日)?`));
  if (nextMonthDayMatch) {
    const day = calendarNumber(nextMonthDayMatch[2]);
    const nextMonth = monthAt(monthOffsets[nextMonthDayMatch[1]]);
    const date = strictDate(nextMonth.getFullYear(), nextMonth.getMonth() + 1, day);
    return checkedDate(date, nextMonthDayMatch, 'day', badCalendarPrefix(nextMonthDayMatch));
  }

  // 老板从微信里粘贴的日期经常在数字、年月日或分隔符两侧带空白。
  // 只在明确的数字日期结构内接受这些空白，不做全句去空格，避免把
  // “下 周 五”一类被拆开的自然语言日期误当成合法日期。
  const fullMatch = source.match(/(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*(?:日|号)?/);
  if (fullMatch) {
    const date = strictDate(Number(fullMatch[1]), Number(fullMatch[2]), Number(fullMatch[3]));
    return checkedDate(date, fullMatch, 'day', badCalendarPrefix(fullMatch));
  }

  const slashMonthDayMatch = source.match(/(\d{1,2})\s*[/-]\s*(\d{1,2})\s*(?:号|日)?/);
  if (slashMonthDayMatch) {
    const date = strictDate(now.getFullYear(), Number(slashMonthDayMatch[1]), Number(slashMonthDayMatch[2]));
    return checkedDate(date, slashMonthDayMatch, 'day', badCalendarPrefix(slashMonthDayMatch));
  }

  const monthDayMatch = source.match(new RegExp(`(?:(${CALENDAR_YEAR})\\s*的?\\s*)?(${CALENDAR_NUMBER})\\s*月\\s*的?\\s*(${CALENDAR_NUMBER})\\s*(?:日|号)?`));
  if (monthDayMatch) {
    const date = strictDate(calendarYear(monthDayMatch[1], now.getFullYear()), calendarNumber(monthDayMatch[2]), calendarNumber(monthDayMatch[3]));
    return checkedDate(date, monthDayMatch, 'day', badCalendarPrefix(monthDayMatch));
  }

  const dayMatch = source.match(new RegExp(`(${CALENDAR_NUMBER})\\s*(?:号|日)`));
  if (dayMatch) {
    const day = calendarNumber(dayMatch[1]);
    // 裸“5号”没有月份。以前自动猜本月/下月会制造错误日期，必须让用户确认。
    return result('', dayMatch[0], 'day_without_month', { ambiguous: true, invalid: !Number.isFinite(day) || day < 1 || day > 31 });
  }

  match = source.match(/(?:下下|下|上上|上|本|这个|这)(?:个)?月|月中|工作日|节后/);
  if (match) return result('', match[0], 'date_unclear', { ambiguous: true });

  // 只有“下午/晚上”没有说是哪一天，不能据此猜成今天。放在明确日期规则
  // 之后，避免把“下周五下午”误判成没有日期。
  match = source.match(/上午|中午|下午|晚上|今晚/);
  if (match) return result('', match[0], 'time_only', { ambiguous: true });

  return result();
}

function parseChineseDateDetail(text, baseDate = new Date()) {
  const source = String(text || '');
  const detail = parseSingleChineseDateDetail(source, baseDate);
  if (!detail.date) return detail;
  const index = source.indexOf(detail.matchedText);
  const before = source.slice(0, index).trim();
  const after = source.slice(index + detail.matchedText.length).trim();
  const uncertain = /(?:不是|不在|不要|别在|大概|大约|差不多|约|可能|也许)\s*$/.test(before)
    || /^(?:(?:交货|交付|发货|交)\s*)?(?:左右|前后|上下|或|到|至|[~～])/.test(after)
    || (/(?:天|周|星期|礼拜|月)(?:之|以)?后$/.test(detail.matchedText) && /工作日/.test(source));
  // 原话里有两个日期时也不能只取其中一个。补答与原话使用同一条保护，
  // 不依赖Input整答校验来弥补首次解析误定日期。
  const remainder = source.slice(0, index) + ' ' + source.slice(index + detail.matchedText.length);
  const other = parseSingleChineseDateDetail(remainder, baseDate);
  const multiple = Boolean(other.date) || other.precision === 'day_without_month';
  return uncertain || multiple
    ? Object.assign({}, detail, { date: '', precision: multiple ? 'multiple_dates' : 'date_unclear', ambiguous: true })
    : detail;
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
