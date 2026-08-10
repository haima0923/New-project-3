const { stableHash } = require('../../../utils/record-state-diff');
const { CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    if (/^(confirmationSessionId|requestId)$/i.test(key)) {
      output[`${key}Present`] = Boolean(value[key]);
      return;
    }
    output[key] = sanitize(value[key]);
  });
  return output;
}

async function runRound() {
  const results = [];
  for (const spec of CASES) {
    try {
      const result = await executeCase(spec.id);
      results.push(Object.assign(result, {
        expectedFirstFailure: spec.expectedFirstFailure,
        expectedStatus: spec.expectedStatus,
        drift: result.status !== spec.expectedStatus
          || result.firstFailure !== spec.expectedFirstFailure
      }));
    } catch (error) {
      results.push({
        checks: [],
        drift: true,
        error: { code: error.code || 'RUNNER_ERROR', message: error.message },
        expectedFirstFailure: spec.expectedFirstFailure,
        expectedStatus: spec.expectedStatus,
        firstFailure: '',
        id: spec.id,
        status: 'RUNNER_ERROR'
      });
    }
  }
  return results;
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let index = 0; index < repeat; index += 1) rounds.push(await runRound());
  const fingerprints = rounds.map((results) => stableHash(sanitize(results), 'save-hang-round-v1'));
  const stable = fingerprints.every((value) => value === fingerprints[0]);
  const latest = rounds[rounds.length - 1];
  const pass = latest.filter((item) => item.status === 'PASS').length;
  const caseFail = latest.filter((item) => item.status === 'CASE_FAIL').length;
  const runnerError = latest.filter((item) => item.status === 'RUNNER_ERROR').length;
  const drift = latest.filter((item) => item.drift).map((item) => item.id);
  const greenFailures = latest.filter((item) => (
    item.expectedStatus === 'PASS' && item.status !== 'PASS'
  )).map((item) => item.id);
  const gate = runnerError || !stable || drift.length || greenFailures.length
    ? 'HARNESS_FAILURE'
    : (caseFail ? 'EXPECTED_RED' : 'PASS');
  return {
    caseFail,
    determinism: stable ? 'STABLE' : 'UNSTABLE',
    drift,
    fingerprints,
    gate,
    greenFailures,
    pass,
    results: latest,
    rounds: repeat,
    runnerError
  };
}

module.exports = { runSuite };
