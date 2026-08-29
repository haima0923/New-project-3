const { CASES } = require('./contract-cases');
const { executeCase } = require('./execute-case');

async function runRound(round) {
  const results = [];
  for (const spec of CASES) results.push(await executeCase(spec));
  return { round, results };
}

function compareRounds(rounds) {
  if (rounds.length < 2) return { stable: true, mismatches: [] };
  const baseline = new Map(rounds[0].results.map((item) => [item.id, item.semanticFingerprint]));
  const mismatches = [];
  rounds.slice(1).forEach((round) => {
    round.results.forEach((item) => {
      if (baseline.get(item.id) !== item.semanticFingerprint) {
        mismatches.push({ id: item.id, round: round.round, expected: baseline.get(item.id), actual: item.semanticFingerprint });
      }
    });
  });
  return { stable: mismatches.length === 0, mismatches };
}

function summarize(rounds) {
  const results = rounds[0].results;
  const determinism = compareRounds(rounds);
  const totals = ['PASS', 'EXPECTED_RED', 'UNEXPECTED_RED', 'SPEC_REQUIRED', 'RUNNER_ERROR']
    .reduce((output, status) => {
      output[status] = results.filter((item) => item.status === status).length;
      return output;
    }, { TOTAL: results.length });
  const taxonomy = {};
  results.forEach((item) => {
    if (!item.firstFailure) return;
    const key = item.firstFailure.taxonomy || 'TEST_INFRA';
    taxonomy[key] = (taxonomy[key] || 0) + 1;
  });
  const gate = !determinism.stable || totals.RUNNER_ERROR > 0
    ? 'RUNNER_ERROR'
    : (totals.UNEXPECTED_RED > 0 ? 'UNEXPECTED_RED'
      : (totals.EXPECTED_RED > 0 ? 'EXPECTED_RED' : 'PASS'));
  return { gate, rounds: rounds.length, determinism, totals, taxonomy, results };
}

async function runSuite(options = {}) {
  const repeat = Math.max(2, Number(options.repeat || 2));
  const rounds = [];
  for (let round = 1; round <= repeat; round += 1) rounds.push(await runRound(round));
  return summarize(rounds);
}

module.exports = { compareRounds, runRound, runSuite, summarize };
