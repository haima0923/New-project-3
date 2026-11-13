// Test-only clock shared by suites whose fixtures use explicit business dates.
async function withFixedTestClock(nowInstant, timezone, run) {
  const NativeDate = global.Date;
  const previousTimezone = process.env.TZ;
  const fixedMs = NativeDate.parse(nowInstant);
  if (!Number.isFinite(fixedMs)) throw new Error('Invalid fixed test instant');
  class FrozenDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedMs]));
    }
    static now() { return fixedMs; }
  }
  global.Date = FrozenDate;
  process.env.TZ = timezone;
  try {
    return await run();
  } finally {
    global.Date = NativeDate;
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
}

module.exports = { withFixedTestClock };
