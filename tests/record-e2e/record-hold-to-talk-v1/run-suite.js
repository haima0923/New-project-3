const { stableHash } = require('../../../utils/record-state-diff');
const { CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');

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
  }, 'record-hold-to-talk-v1-result');
}

function runnerErrorResult(contract, error) {
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
      results.push(runnerErrorResult(contract, error));
    }
  }
  return results;
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let index = 0; index < repeat; index += 1) rounds.push(await runRound());
  const unstable = [];
  CASES.forEach((contract, caseIndex) => {
    const fingerprints = rounds.map((round) => fingerprint(round[caseIndex]));
    if (!fingerprints.every((value) => value === fingerprints[0])) unstable.push(contract.id);
  });
  const finalResults = rounds[rounds.length - 1];
  const runnerErrors = finalResults.filter((entry) => entry.status === 'RUNNER_ERROR');
  const drift = finalResults.filter((entry) => {
    const contract = CASES.find((item) => item.id === entry.id);
    const expectedStatus = contract.expected === 'GREEN' ? 'PASS' : 'CASE_FAIL';
    return entry.status !== expectedStatus || entry.firstFailure !== contract.firstFailure;
  });
  const greenFailures = finalResults.filter((entry) => {
    const contract = CASES.find((item) => item.id === entry.id);
    return contract.expected === 'GREEN' && entry.status !== 'PASS';
  });
  const passCount = finalResults.filter((entry) => entry.status === 'PASS').length;
  const failCount = finalResults.filter((entry) => entry.status === 'CASE_FAIL').length;
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
    repeat,
    results: finalResults,
    runnerErrorCount: runnerErrors.length,
    unstable
  };
}

module.exports = {
  fingerprint,
  runRound,
  runSuite
};
