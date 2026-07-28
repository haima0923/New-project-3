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

module.exports = {
  normalizeRunResult,
  stripNondeterministic
};
