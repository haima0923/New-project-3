#!/usr/bin/env node

const { stableHash } = require('../../../utils/record-state-diff');
const { check } = require('./fixtures');
const { pageVmChecks } = require('./page-vm-tests');
const { sourceChecks } = require('../../wechat-runtime/record-confirm-surface-v1/static-source-tests');

const CASE_IDS = Array.from({ length: 12 }, (_value, index) => (
  `SURFACE-${String(index + 1).padStart(3, '0')}`
));
const BASELINE_EXPECTED_STATUS = Object.freeze(CASE_IDS.reduce((output, id) => {
  output[id] = id === 'SURFACE-008' ? 'PASS' : 'CASE_FAIL';
  return output;
}, {}));
const GREEN_CONTROLS = new Set(['SURFACE-008']);

async function runRound(round) {
  const results = [];
  for (const id of CASE_IDS) {
    try {
      const checks = sourceChecks(id, check).concat(await pageVmChecks(id));
      const firstFailure = checks.find((entry) => !entry.pass) || null;
      results.push({
        checks,
        evidenceLayers: Array.from(new Set(checks.map((entry) => entry.evidenceLayer))),
        firstFailure,
        id,
        status: firstFailure ? 'CASE_FAIL' : 'PASS'
      });
    } catch (error) {
      results.push({
        error: { code: error.code || 'RUNNER_ERROR', message: error.message },
        evidenceLayers: [],
        firstFailure: null,
        id,
        status: 'RUNNER_ERROR'
      });
    }
  }
  return { results, round };
}

function resultFingerprint(result) {
  return stableHash({
    checks: (result.checks || []).map((entry) => ({
      actual: entry.actual === undefined ? null : entry.actual,
      code: entry.code,
      evidenceLayer: entry.evidenceLayer,
      expected: entry.expected === undefined ? null : entry.expected,
      pass: entry.pass
    })),
    error: result.error || null,
    firstFailure: result.firstFailure ? result.firstFailure.code : '',
    id: result.id,
    status: result.status
  }, 'record-confirm-surface-v1');
}

async function runSuite(repeat = 2) {
  const rounds = [];
  const roundCount = Math.max(2, Number(repeat || 2));
  for (let round = 1; round <= roundCount; round += 1) {
    rounds.push(await runRound(round));
  }
  const baseline = new Map(rounds[0].results.map((result) => [result.id, resultFingerprint(result)]));
  const mismatches = rounds.slice(1).flatMap((round) => round.results
    .filter((result) => baseline.get(result.id) !== resultFingerprint(result))
    .map((result) => ({ id: result.id, round: round.round })));
  const runnerErrors = rounds.flatMap((round) => round.results)
    .filter((result) => result.status === 'RUNNER_ERROR');
  const failures = rounds[0].results.filter((result) => result.status === 'CASE_FAIL');
  const greenControlFailures = rounds[0].results.filter((result) => (
    GREEN_CONTROLS.has(result.id) && result.status !== 'PASS'
  ));
  const allPass = rounds[0].results.every((result) => result.status === 'PASS');
  const baselineDrift = rounds[0].results.filter((result) => (
    result.status !== BASELINE_EXPECTED_STATUS[result.id]
  ));
  return {
    contractGate: runnerErrors.length || mismatches.length || greenControlFailures.length
      ? 'HARNESS_FAILURE'
      : (allPass ? 'PASS' : (baselineDrift.length ? 'CONTRACT_DRIFT' : 'EXPECTED_RED')),
    baselineDrift: baselineDrift.map((result) => ({
      actual: result.status,
      expected: BASELINE_EXPECTED_STATUS[result.id],
      id: result.id
    })),
    determinism: mismatches.length ? 'UNSTABLE' : 'STABLE',
    evidence: {
      greenControls: Array.from(GREEN_CONTROLS),
      realWxml: 'NOT_RUN_THIS_PHASE',
      requiredLayers: ['STATIC_SOURCE', 'PAGE_VM']
    },
    greenControlFailures: greenControlFailures.map((result) => result.id),
    results: rounds[0].results,
    rounds: rounds.length,
    runnerErrorCount: runnerErrors.length
  };
}

async function main() {
  const repeatIndex = process.argv.indexOf('--repeat');
  const report = await runSuite(repeatIndex >= 0 ? process.argv[repeatIndex + 1] : 2);
  const counts = report.results.reduce((output, result) => {
    output[result.status] = Number(output[result.status] || 0) + 1;
    return output;
  }, { CASE_FAIL: 0, PASS: 0, RUNNER_ERROR: 0 });
  console.log(`CONTRACT_GATE=${report.contractGate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.determinism}`);
  console.log(`PASS=${counts.PASS} CASE_FAIL=${counts.CASE_FAIL} RUNNER_ERROR=${counts.RUNNER_ERROR}`);
  console.log('EVIDENCE=STATIC_SOURCE+PAGE_VM');
  console.log('REAL_WXML=NOT_RUN_THIS_PHASE');
  report.results.forEach((result) => {
    console.log(`${result.id}\t${result.status}\tFIRST=${result.firstFailure ? result.firstFailure.code : '-'}`);
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.contractGate === 'HARNESS_FAILURE'
    ? 2
    : (report.contractGate === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RUNNER_FATAL=${error.code || 'RUNNER_FATAL'} ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  CASE_IDS,
  BASELINE_EXPECTED_STATUS,
  GREEN_CONTROLS,
  runSuite
};
