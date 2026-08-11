const fs = require('fs');
const { stableHash } = require('../../../utils/record-state-diff');
const { CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');
const { CONTROLLER_PATH } = require('./runtime');

function fingerprint(result) {
  return stableHash({
    checks: (result.checks || []).map((entry) => ({
      actual: entry.actual,
      code: entry.code,
      pass: entry.pass
    })),
    firstFailure: result.firstFailure,
    id: result.id,
    status: result.status
  }, 'voice-capture-v2-result');
}

function runnerError(contract, error) {
  return {
    checks: [],
    error: {
      code: String(error && error.code || 'UNEXPECTED_RUNNER_ERROR'),
      message: String(error && error.message || error || '')
    },
    firstFailure: '',
    id: contract.id,
    status: 'RUNNER_ERROR'
  };
}

async function runRound() {
  const results = [];
  for (const contract of CASES) {
    try {
      results.push(await executeCase(contract));
    } catch (error) {
      results.push(runnerError(contract, error));
    }
  }
  return results;
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let index = 0; index < repeat; index += 1) rounds.push(await runRound());
  const unstable = [];
  CASES.forEach((contract, caseIndex) => {
    const values = rounds.map((round) => fingerprint(round[caseIndex]));
    if (!values.every((value) => value === values[0])) unstable.push(contract.id);
  });
  const results = rounds[rounds.length - 1];
  const profile = fs.existsSync(CONTROLLER_PATH)
    ? 'VOICE_CAPTURE_V2_WORKTREE'
    : 'PARENT_CAPABILITY_MISSING';
  const runnerErrors = results.filter((entry) => entry.status === 'RUNNER_ERROR');
  const drift = results.filter((entry) => {
    const contract = CASES.find((candidate) => candidate.id === entry.id);
    const capabilityMissing = profile === 'PARENT_CAPABILITY_MISSING'
      && !contract.id.startsWith('GREEN-')
      && contract.id !== 'VCAP-024';
    const expectedStatus = capabilityMissing ? 'CASE_FAIL' : 'PASS';
    const expectedFirstFailure = capabilityMissing
      ? contract.capabilityMissingFirstFailure
      : contract.firstFailure;
    return entry.status !== expectedStatus || entry.firstFailure !== expectedFirstFailure;
  });
  const greenFailures = results.filter((entry) => {
    const contract = CASES.find((candidate) => candidate.id === entry.id);
    const capabilityMissing = profile === 'PARENT_CAPABILITY_MISSING'
      && !contract.id.startsWith('GREEN-')
      && contract.id !== 'VCAP-024';
    return !capabilityMissing && contract.expected === 'GREEN' && entry.status !== 'PASS';
  });
  const passCount = results.filter((entry) => entry.status === 'PASS').length;
  const failCount = results.filter((entry) => entry.status === 'CASE_FAIL').length;
  let gate = 'EXPECTED_RED';
  let exitCode = 1;
  if (runnerErrors.length || unstable.length || greenFailures.length) {
    gate = 'HARNESS_FAILURE';
    exitCode = 2;
  } else if (drift.length) {
    gate = 'CONTRACT_DRIFT';
    exitCode = 2;
  } else if (failCount === 0) {
    gate = 'PASS';
    exitCode = 0;
  }
  return {
    drift: drift.map((entry) => entry.id),
    exitCode,
    failCount,
    gate,
    greenFailures: greenFailures.map((entry) => entry.id),
    passCount,
    profile,
    repeat,
    results,
    runnerErrorCount: runnerErrors.length,
    unstable
  };
}

module.exports = { fingerprint, runRound, runSuite };
