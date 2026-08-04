const BUSINESS_DATE = '2026-08-04';
const NOW_INSTANT = '2026-08-04T02:30:00.000Z';
const TIMEZONE = 'Asia/Shanghai';

function seedFrom(value) {
  const text = String(value || 'multi-item-order-contract');
  let seed = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  return seed || 1;
}

function deterministicRandom(seedText) {
  let state = seedFrom(seedText);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function withFrozenClock(seedText, callback) {
  const NativeDate = global.Date;
  const nativeRandom = Math.random;
  const previousTimezone = process.env.TZ;
  const fixedMs = new NativeDate(NOW_INSTANT).getTime();
  class FrozenDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedMs]));
    }

    static now() {
      return fixedMs;
    }
  }
  FrozenDate.parse = NativeDate.parse;
  FrozenDate.UTC = NativeDate.UTC;
  process.env.TZ = TIMEZONE;
  global.Date = FrozenDate;
  Math.random = deterministicRandom(seedText);
  try {
    return callback();
  } finally {
    global.Date = NativeDate;
    Math.random = nativeRandom;
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
}

module.exports = {
  BUSINESS_DATE,
  NOW_INSTANT,
  TIMEZONE,
  withFrozenClock
};
