const { stableHash } = require('../../../utils/record-state-diff');
const { execFileSync } = require('child_process');
const path = require('path');
const { CASES } = require('./contract-cases');

const WORKER_PATH = path.join(__dirname, 'worker.js');

function runnerError(contract, error) {
  return {
    checks: [],
    error: {
      code: String(error && error.code || 'UNEXPECTED_RUNNER_ERROR'),
      message: String(error && error.message || error || '')
    },
    expectedFirstFailure: contract.expectedFirstFailure,
    expectedStatus: contract.expectedStatus,
    firstFailure: '',
    id: contract.id,
    rawStatus: 'RUNNER_ERROR',
    status: 'RUNNER_ERROR'
  };
}

function project(contract, result) {
  let status = 'PASS';
  if (result.rawStatus === 'RUNNER_ERROR') status = 'RUNNER_ERROR';
  else if (result.rawStatus === 'CASE_FAIL') {
    status = contract.expectedStatus === 'SPEC_REQUIRED'
      ? 'SPEC_REQUIRED'
      : (contract.expectedStatus === 'EXPECTED_RED'
        && result.firstFailure === contract.expectedFirstFailure
        ? 'EXPECTED_RED'
        : 'UNEXPECTED_RED');
  }
  return Object.assign({}, result, {
    expectedFirstFailure: contract.expectedFirstFailure,
    expectedStatus: contract.expectedStatus,
    status
  });
}

async function runRound() {
  const results = [];
  for (const contract of CASES) {
    try {
      const output = execFileSync(process.execPath, [WORKER_PATH, contract.id], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      });
      results.push(project(contract, JSON.parse(output)));
    } catch (error) {
      results.push(runnerError(contract, error));
    }
  }
  return results;
}

function fingerprint(results) {
  return stableHash(results.map((entry) => ({
    checks: (entry.checks || []).map((check) => ({ code: check.code, pass: check.pass })),
    error: entry.error || null,
    firstFailure: entry.firstFailure,
    id: entry.id,
    status: entry.status
  })), 'voice-record-evidence-boundary-v1-round');
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let index = 0; index < repeat; index += 1) rounds.push(await runRound());
  const roundFingerprints = rounds.map(fingerprint);
  const stable = roundFingerprints.every((value) => value === roundFingerprints[0]);
  const results = rounds[rounds.length - 1];
  const counts = ['PASS', 'EXPECTED_RED', 'UNEXPECTED_RED', 'SPEC_REQUIRED', 'RUNNER_ERROR']
    .reduce((output, status) => {
      output[status] = results.filter((entry) => entry.status === status).length;
      return output;
    }, {});
  let gate = 'PASS';
  let exitCode = 0;
  if (!stable || counts.RUNNER_ERROR || counts.UNEXPECTED_RED || counts.SPEC_REQUIRED) {
    gate = 'HARNESS_FAILURE';
    exitCode = 2;
  } else if (counts.EXPECTED_RED) {
    gate = 'EXPECTED_RED';
    exitCode = 1;
  }
  return { counts, exitCode, gate, repeat, results, roundFingerprints, stable };
}

module.exports = { runSuite };
