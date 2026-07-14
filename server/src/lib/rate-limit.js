function getClientKey(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',')[0]
    .trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createRateLimiter({ windowMs = 60000, maxRequests = 30 } = {}) {
  const entries = new Map();

  function consume(req, now = Date.now(), keyOverride = '') {
    const key = keyOverride || getClientKey(req);
    const current = entries.get(key);
    const active = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };
    active.count += 1;
    entries.set(key, active);
    if (entries.size > 10000) {
      entries.forEach((value, entryKey) => {
        if (value.resetAt <= now) entries.delete(entryKey);
      });
    }
    return {
      allowed: active.count <= maxRequests,
      retryAfterSeconds: Math.max(1, Math.ceil((active.resetAt - now) / 1000))
    };
  }

  return { consume };
}

module.exports = {
  createRateLimiter,
  getClientKey
};
