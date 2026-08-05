const { ALL_CASES, GREEN_CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');

async function runRound(round) {
  const results = [];
  for (const spec of ALL_CASES) {
    const result = await executeCase(spec);
    results.push(result);
  }
  return { results, round };
}

function compareRounds(rounds) {
  if (rounds.length < 2) return { mismatches: [], stable: true };
  const baseline = new Map(rounds[0].results.map((result) => [result.id, result.semanticFingerprint]));
  const mismatches = [];
  rounds.slice(1).forEach((round) => {
    round.results.forEach((result) => {
      if (baseline.get(result.id) !== result.semanticFingerprint) {
        mismatches.push({
          actual: result.semanticFingerprint,
          expected: baseline.get(result.id),
          id: result.id,
          round: round.round
        });
      }
    });
  });
  return { mismatches, stable: mismatches.length === 0 };
}

function summarize(rounds) {
  const results = rounds[0].results;
  const determinism = compareRounds(rounds);
  const runnerErrors = rounds.flatMap((round) => round.results)
    .filter((result) => result.status === 'RUNNER_ERROR');
  const greenIds = new Set(GREEN_CASES.map((spec) => spec.id));
  const greenResults = results.filter((result) => greenIds.has(result.id));
  const redResults = results.filter((result) => result.status === 'CASE_FAIL');
  const gates = {
    determinismStable: determinism.stable,
    expectedProductRedPresent: redResults.length > 0,
    greenControlsPass: greenResults.every((result) => result.status === 'PASS'),
    runnerErrorCount: runnerErrors.length
  };
  return {
    contractGate: gates.determinismStable && gates.greenControlsPass && gates.runnerErrorCount === 0
      ? (gates.expectedProductRedPresent ? 'EXPECTED_RED' : 'PASS')
      : 'HARNESS_FAILURE',
    determinism,
    gates,
    results,
    rounds: rounds.length,
    totals: {
      caseFail: results.filter((result) => result.status === 'CASE_FAIL').length,
      pass: results.filter((result) => result.status === 'PASS').length,
      runnerError: results.filter((result) => result.status === 'RUNNER_ERROR').length,
      total: results.length
    }
  };
}

async function runSuite(options = {}) {
  const repeat = Math.max(2, Number(options.repeat || 2));
  const rounds = [];
  for (let round = 1; round <= repeat; round += 1) {
    rounds.push(await runRound(round));
  }
  return summarize(rounds);
}

module.exports = {
  compareRounds,
  runRound,
  runSuite,
  summarize
};
