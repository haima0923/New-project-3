const { safeClone, stableHash } = require('../../../utils/record-state-diff');

function stripNondeterministic(value) {
  if (Array.isArray(value)) return value.map(stripNondeterministic);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if ([
      'pid',
      'bootId',
      'primaryBootId',
      'primaryPid',
      'restartBootId',
      'restartPid',
      'workerId'
    ].includes(key)) return result;
    result[key] = stripNondeterministic(value[key]);
    return result;
  }, {});
}

function normalizeRunResult(result) {
  const semantic = stripNondeterministic(safeClone(result));
  return {
    fingerprint: stableHash(semantic, 'record-e2e-run-semantic-v1'),
    semantic
  };
}

function findChangedPaths(left, right, prefix = '', output = [], limit = 80) {
  if (output.length >= limit) return output;
  if (left === right) return output;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      output.push(prefix || '$');
      return output;
    }
    for (let index = 0; index < left.length && output.length < limit; index += 1) {
      findChangedPaths(left[index], right[index], `${prefix}[${index}]`, output, limit);
    }
    return output;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    output.push(prefix || '$');
    return output;
  }
  const keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
  keys.forEach((key) => {
    if (output.length >= limit) return;
    findChangedPaths(
      left[key],
      right[key],
      prefix ? `${prefix}.${key}` : key,
      output,
      limit
    );
  });
  return output;
}

module.exports = {
  findChangedPaths,
  normalizeRunResult,
  stripNondeterministic
};
