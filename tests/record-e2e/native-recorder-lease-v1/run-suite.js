const { stableHash } = require('../../../utils/record-state-diff');
const { CONTRACTS } = require('./contract-cases');
const { executeCase } = require('./execute-case');
const { controllerSource } = require('./runtime');

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  Object.keys(value).sort().forEach((key) => {
    if (/^(at|time|timestamp|touchStartAt|readyAt|startedAt|endedAt|recorderOnStopAt)$/i.test(key)) {
      result[key] = value[key] === undefined || value[key] === null ? null : 'PRESENT';
      return;
    }
    if (/^(captureId|nativeLeaseId|sessionId|requestId)$/i.test(key)) {
      result[key] = value[key] ? 'PRESENT' : '';
      return;
    }
    result[key] = sanitize(value[key]);
  });
  return result;
}

function runRound(round) {
  return CONTRACTS.map((contract) => {
    try {
      const execution = executeCase(contract);
      const normalized = sanitize(execution);
      return Object.assign({}, execution, {
        expectedStatus: contract.expectedStatus,
        fingerprint: stableHash(normalized, `native-lease:${contract.id}`),
        round
      });
    } catch (error) {
      return {
        checks: [],
        expectedStatus: contract.expectedStatus,
        fingerprint: stableHash({ code: error.code || '', message: error.message || '' }, `native-lease:${contract.id}`),
        firstFailure: error.code || 'RUNNER_EXCEPTION',
        id: contract.id,
        round,
        status: 'RUNNER_ERROR'
      };
    }
  });
}

function runSuite(repeat = 2) {
  const rounds = [];
  for (let round = 1; round <= repeat; round += 1) rounds.push(runRound(round));
  const first = rounds[0];
  const unstable = first.filter((entry, index) => rounds.some((round) => (
    round[index].status !== entry.status || round[index].fingerprint !== entry.fingerprint
  ))).map((entry) => entry.id);
  const profile = controllerSource() ? 'PARTIAL_V2_WORKTREE' : 'PARENT_CAPABILITY_MISSING';
  const baselineDrift = first.filter((entry) => {
    const contract = CONTRACTS.find((candidate) => candidate.id === entry.id);
    const expectedStatus = profile === 'PARENT_CAPABILITY_MISSING'
      ? (contract.id.startsWith('GREEN-') ? 'PASS' : 'CASE_FAIL')
      : contract.expectedStatus;
    const expectedFirstFailure = profile === 'PARENT_CAPABILITY_MISSING'
      ? (contract.id.startsWith('GREEN-') ? '' : 'NATIVE_LEASE_CAPABILITY_PRESENT')
      : contract.expectedFirstFailure;
    return entry.status !== expectedStatus || entry.firstFailure !== expectedFirstFailure;
  }).map((entry) => entry.id);
  const runnerErrors = first.filter((entry) => entry.status === 'RUNNER_ERROR');
  const pass = first.filter((entry) => entry.status === 'PASS').length;
  const caseFail = first.filter((entry) => entry.status === 'CASE_FAIL').length;
  let gate = 'EXPECTED_RED';
  if (unstable.length || runnerErrors.length) gate = 'HARNESS_FAILURE';
  else if (!caseFail) gate = 'PASS';
  else if (baselineDrift.length) gate = 'CONTRACT_DRIFT';
  return {
    baselineDrift,
    caseFail,
    gate,
    pass,
    profile,
    repeat,
    results: first,
    runnerError: runnerErrors.length,
    unstable
  };
}

module.exports = { runSuite };
