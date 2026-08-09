const { stableHash } = require('../../../utils/record-state-diff');
const { CASES, GREEN_CONTROLS } = require('./contract-cases');
const { executeCase } = require('./execute-case');

const BASELINE_EXPECTED_STATUS = Object.freeze({
  'CONV-001': 'CASE_FAIL',
  'CONV-002': 'CASE_FAIL',
  'CONV-003': 'CASE_FAIL',
  'CONV-004': 'CASE_FAIL',
  'CONV-005': 'PASS',
  'CONV-006': 'CASE_FAIL',
  'CONV-007': 'CASE_FAIL',
  'CONV-008': 'CASE_FAIL',
  'CONV-009': 'CASE_FAIL',
  'CONV-010': 'CASE_FAIL',
  'CONV-011': 'CASE_FAIL',
  'CONV-012': 'CASE_FAIL',
  'GREEN-CONV-001': 'PASS',
  'GREEN-CONV-002': 'PASS',
  'GREEN-CONV-003': 'PASS'
});

function sanitize(value, key = '') {
  if (/^(?:requestId|confirmationSessionId|sessionId|signature|createdAt|updatedAt|timestamp)$/i.test(key)) {
    return value ? '<present>' : '';
  }
  if (/fingerprint/i.test(key)) return value ? '<present>' : '';
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((output, childKey) => {
      output[childKey] = sanitize(value[childKey], childKey);
      return output;
    }, {});
  }
  return value;
}

async function runRound(round) {
  const results = [];
  for (const spec of CASES) {
    try {
      const checks = await executeCase(spec);
      const firstFailure = checks.find((entry) => !entry.pass) || null;
      results.push({
        checks,
        evidenceLayers: Array.from(new Set(checks.map((entry) => entry.evidenceLayer))),
        firstFailure,
        id: spec.id,
        status: firstFailure ? 'CASE_FAIL' : 'PASS',
        title: spec.title
      });
    } catch (error) {
      results.push({
        error: { code: error.code || 'RUNNER_ERROR', message: error.message },
        evidenceLayers: [],
        firstFailure: null,
        id: spec.id,
        status: 'RUNNER_ERROR',
        title: spec.title
      });
    }
  }
  return { results, round };
}

function resultFingerprint(result) {
  return stableHash(sanitize({
    checks: result.checks || [],
    error: result.error || null,
    firstFailure: result.firstFailure ? result.firstFailure.code : '',
    id: result.id,
    status: result.status
  }), 'record-conversation-mode-v1');
}

async function runSuite(repeat = 2) {
  const rounds = [];
  const roundCount = Math.max(2, Number(repeat || 2));
  for (let round = 1; round <= roundCount; round += 1) rounds.push(await runRound(round));
  const baseline = new Map(rounds[0].results.map((result) => [result.id, resultFingerprint(result)]));
  const mismatches = rounds.slice(1).flatMap((round) => round.results
    .filter((result) => baseline.get(result.id) !== resultFingerprint(result))
    .map((result) => ({ id: result.id, round: round.round })));
  const runnerErrors = rounds.flatMap((round) => round.results)
    .filter((result) => result.status === 'RUNNER_ERROR');
  const greenControlFailures = rounds[0].results.filter((result) => (
    GREEN_CONTROLS.has(result.id) && result.status !== 'PASS'
  ));
  const allPass = rounds[0].results.every((result) => result.status === 'PASS');
  const baselineDrift = rounds[0].results.filter((result) => (
    result.status !== BASELINE_EXPECTED_STATUS[result.id]
  ));
  const harnessFailure = runnerErrors.length || mismatches.length || greenControlFailures.length;
  return {
    baselineDrift: baselineDrift.map((result) => ({
      actual: result.status, expected: BASELINE_EXPECTED_STATUS[result.id], id: result.id
    })),
    contractGate: harnessFailure ? 'HARNESS_FAILURE'
      : (allPass ? 'PASS' : (baselineDrift.length ? 'CONTRACT_DRIFT' : 'EXPECTED_RED')),
    determinism: mismatches.length ? 'UNSTABLE' : 'STABLE',
    evidence: {
      fixturePolicy: 'raw text + controlled network + real production user actions only',
      realWxml: 'NOT_RUN_THIS_PHASE',
      requiredLayers: ['STATIC_WXML', 'RENDERED_WXML', 'PAGE_VM']
    },
    greenControlFailures: greenControlFailures.map((result) => result.id),
    results: rounds[0].results,
    rounds: rounds.length,
    runnerErrorCount: runnerErrors.length
  };
}

module.exports = {
  BASELINE_EXPECTED_STATUS,
  resultFingerprint,
  runSuite,
  sanitize
};
