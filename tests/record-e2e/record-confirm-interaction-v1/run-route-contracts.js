#!/usr/bin/env node
const { ROUTE_CASES } = require('./route-contract-cases');
const { executeRouteContract } = require('./execute-route-contract');

async function runRound(round) {
  const results = [];
  for (const spec of ROUTE_CASES) results.push(await executeRouteContract(spec));
  return { results, round };
}

function semanticMismatches(rounds) {
  if (rounds.length < 2) return [];
  const first = new Map(rounds[0].results.map((result) => [result.id, result.semanticFingerprint]));
  return rounds.slice(1).flatMap((round) => round.results
    .filter((result) => first.get(result.id) !== result.semanticFingerprint)
    .map((result) => ({ id: result.id, round: round.round })));
}

async function runSuite(options = {}) {
  const repeat = Math.max(2, Number(options.repeat || 2));
  const rounds = [];
  for (let round = 1; round <= repeat; round += 1) rounds.push(await runRound(round));
  const results = rounds[0].results;
  const mismatches = semanticMismatches(rounds);
  const runnerErrors = rounds.flatMap((round) => round.results)
    .filter((result) => result.status === 'RUNNER_ERROR');
  const route001 = results.find((result) => result.id === 'ROUTE-001');
  const red = results.filter((result) => result.status === 'CASE_FAIL');
  return {
    contractGate: mismatches.length || runnerErrors.length || !route001 || route001.status !== 'PASS'
      ? 'HARNESS_FAILURE'
      : (red.length ? 'EXPECTED_RED' : 'PASS'),
    determinism: mismatches.length ? 'UNSTABLE' : 'STABLE',
    mismatches,
    results,
    rounds: rounds.length,
    runnerErrorCount: runnerErrors.length,
    totals: {
      caseFail: red.length,
      pass: results.filter((result) => result.status === 'PASS').length,
      runnerError: results.filter((result) => result.status === 'RUNNER_ERROR').length
    }
  };
}

async function main() {
  const index = process.argv.indexOf('--repeat');
  const repeat = index >= 0 ? Number(process.argv[index + 1] || 2) : 2;
  const report = await runSuite({ repeat });
  console.log(`CONTRACT_GATE=${report.contractGate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.determinism}`);
  console.log(`RUNNER_ERROR=${report.runnerErrorCount}`);
  report.results.forEach((result) => {
    console.log(`${result.id}\t${result.classification}\t${result.status}\tFIRST=${result.firstFailure ? result.firstFailure.code : '-'}`);
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.contractGate === 'HARNESS_FAILURE'
    ? 2
    : (report.contractGate === 'EXPECTED_RED' ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RUNNER_FATAL=${error.code || 'RUNNER_FATAL'} ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  runRound,
  runSuite,
  semanticMismatches
};
