const { safeClone } = require('../../../utils/record-state-diff');

const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const PRIVATE_RUNTIME_KEY = /^(?:_internal|runtime|driver|gateway|facade)$/;

function sanitize(value, stack = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      return value
        .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
        .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]');
    }
    return value;
  }
  if (stack.has(value)) return '[CIRCULAR]';
  stack.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitize(item, stack));
    stack.delete(value);
    return output;
  }
  const result = {};
  Object.keys(value).sort().forEach((key) => {
    if (PRIVATE_RUNTIME_KEY.test(key)) return;
    if (typeof value[key] === 'function') return;
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(value[key], stack);
  });
  stack.delete(value);
  return result;
}

function sanitizeEvidence(value) {
  return safeClone(sanitize(value));
}

module.exports = {
  sanitizeEvidence
};
