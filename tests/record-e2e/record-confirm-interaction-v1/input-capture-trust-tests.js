#!/usr/bin/env node

const { stableHash } = require('../../../utils/record-state-diff');
const voiceRecognition = require('../../../utils/voice-recognition');
const { createPageHarness, diffCounts, stateCounts } = require('./runtime');
const { inputEvent, tick, waitForParseIdle } = require('./page-actions');

const MANUAL_CLIPBOARD_TEXT = '用户在等待时的新输入';
const STALE_CLIPBOARD_TEXT = '旧剪贴板订单：礼品盒10个5元';
const NORMALIZED_STALE_CLIPBOARD_TEXT = '旧剪贴板订单:礼品盒10个5元';
const MANUAL_VOICE_TEXT = '用户在录音时改为手工输入';
const STALE_VOICE_TEXT = '迟到的旧语音订单';
const NORMAL_VOICE_TEXT = '王总礼品盒10个每个5元周三交';

function routeOf(page) {
  const route = page.data.parseResult && page.data.parseResult.parse_route || {};
  return String(route.client_route || route.semantic_decision || route.decision || '');
}

function check(code, pass, detail = {}) {
  return { code, detail, pass: Boolean(pass) };
}

function zeroDelta(delta) {
  return Object.values(delta).every((value) => Number(value || 0) === 0);
}

async function settlePage(page) {
  await tick();
  if (page.data.parsing === true) await waitForParseIdle(page);
  await tick();
}

function captureVoiceCallbacks() {
  const original = voiceRecognition.startVoiceRecognition;
  let callbacks = null;
  voiceRecognition.startVoiceRecognition = (options) => {
    callbacks = options;
    return true;
  };
  return {
    get callbacks() { return callbacks; },
    restore() { voiceRecognition.startVoiceRecognition = original; }
  };
}

async function capture001() {
  const harness = createPageHarness({ caseId: 'CAPTURE-001', text: STALE_CLIPBOARD_TEXT });
  try {
    let clipboardSuccess = null;
    harness.fakeWx.wx.getClipboardData = (options) => { clipboardSuccess = options.success; };
    let parseCalls = 0;
    const runParse = harness.page.runParse.bind(harness.page);
    harness.page.runParse = (...args) => {
      parseCalls += 1;
      return runParse(...args);
    };
    harness.page.onTextInput(inputEvent('原页面输入'));
    harness.page.pasteClipboard();
    harness.page.onTextInput(inputEvent(MANUAL_CLIPBOARD_TEXT));
    const before = {
      route: routeOf(harness.page),
      session: harness.page.confirmationSessionId,
      source: harness.page.data.source,
      state: stateCounts(harness.readState()),
      text: harness.page.data.text
    };
    clipboardSuccess({ data: STALE_CLIPBOARD_TEXT });
    await settlePage(harness.page);
    const after = {
      route: routeOf(harness.page),
      session: harness.page.confirmationSessionId,
      source: harness.page.data.source,
      state: stateCounts(harness.readState()),
      text: harness.page.data.text
    };
    const evidence = {
      aiRequests: harness.network.aiEvents().length,
      after,
      before,
      parseCalls,
      staleTextApplied: after.text === NORMALIZED_STALE_CLIPBOARD_TEXT
    };
    return {
      checks: [
        check('CAPTURE_001_TEXT_PRESERVED', after.text === before.text, evidence),
        check('CAPTURE_001_SOURCE_PRESERVED', after.source === before.source, evidence),
        check('CAPTURE_001_ROUTE_PRESERVED', after.route === before.route, evidence),
        check('CAPTURE_001_SESSION_PRESERVED', after.session === before.session, evidence),
        check('CAPTURE_001_PARSE_NOT_TRIGGERED', parseCalls === 0, evidence),
        check('CAPTURE_001_AI_ZERO', evidence.aiRequests === 0, evidence),
        check('CAPTURE_001_MUTATION_ZERO', zeroDelta(diffCounts(before.state, after.state)), evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
  }
}

async function capture002() {
  const harness = createPageHarness({ caseId: 'CAPTURE-002', text: STALE_CLIPBOARD_TEXT });
  try {
    let clipboardSuccess = null;
    harness.fakeWx.wx.getClipboardData = (options) => { clipboardSuccess = options.success; };
    let parseCalls = 0;
    const runParse = harness.page.runParse.bind(harness.page);
    harness.page.runParse = (...args) => {
      parseCalls += 1;
      return runParse(...args);
    };
    const beforeState = stateCounts(harness.readState());
    harness.page.onTextInput(inputEvent('原页面输入'));
    harness.page.pasteClipboard();
    clipboardSuccess({ data: STALE_CLIPBOARD_TEXT });
    await settlePage(harness.page);
    const afterState = stateCounts(harness.readState());
    const evidence = {
      parseCalls,
      route: routeOf(harness.page),
      source: harness.page.data.source,
      text: harness.page.data.text
    };
    return {
      checks: [
        check('CAPTURE_002_TEXT_APPLIED', evidence.text === NORMALIZED_STALE_CLIPBOARD_TEXT, evidence),
        check('CAPTURE_002_SOURCE_IS_PASTE', evidence.source === 'paste', evidence),
        check('CAPTURE_002_PARSE_TRIGGERED_ONCE', parseCalls === 1, evidence),
        check('CAPTURE_002_PARSE_RESULT_PRESENT', Boolean(harness.page.data.parseResult), evidence),
        check('CAPTURE_002_MUTATION_ZERO', zeroDelta(diffCounts(beforeState, afterState)), evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
  }
}

async function capture003() {
  const voice = captureVoiceCallbacks();
  const harness = createPageHarness({ caseId: 'CAPTURE-003', text: '' });
  try {
    let parseCalls = 0;
    const runParse = harness.page.runParse.bind(harness.page);
    harness.page.runParse = (...args) => {
      parseCalls += 1;
      return runParse(...args);
    };
    const beforeState = stateCounts(harness.readState());
    harness.page.startVoice();
    harness.page.onTextInput(inputEvent(MANUAL_VOICE_TEXT));
    const before = {
      route: routeOf(harness.page),
      session: harness.page.confirmationSessionId,
      source: harness.page.data.source,
      text: harness.page.data.text
    };
    voice.callbacks.onStop();
    voice.callbacks.onResult({ text: STALE_VOICE_TEXT });
    await settlePage(harness.page);
    const after = {
      route: routeOf(harness.page),
      session: harness.page.confirmationSessionId,
      source: harness.page.data.source,
      text: harness.page.data.text,
      voiceButtonText: harness.page.data.voiceButtonText
    };
    const evidence = {
      aiRequests: harness.network.aiEvents().length,
      after,
      before,
      parseCalls
    };
    return {
      checks: [
        check('CAPTURE_003_TEXT_PRESERVED', after.text === before.text, evidence),
        check('CAPTURE_003_SOURCE_PRESERVED', after.source === before.source, evidence),
        check('CAPTURE_003_ROUTE_PRESERVED', after.route === before.route, evidence),
        check('CAPTURE_003_SESSION_PRESERVED', after.session === before.session, evidence),
        check('CAPTURE_003_PARSE_NOT_TRIGGERED', parseCalls === 0, evidence),
        check('CAPTURE_003_OLD_LOADING_NOT_APPLIED', after.voiceButtonText !== '正在整理…', evidence),
        check('CAPTURE_003_AI_ZERO', evidence.aiRequests === 0, evidence),
        check('CAPTURE_003_MUTATION_ZERO', zeroDelta(diffCounts(beforeState, stateCounts(harness.readState()))), evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
    voice.restore();
  }
}

async function capture004() {
  const voice = captureVoiceCallbacks();
  const harness = createPageHarness({ caseId: 'CAPTURE-004', text: '' });
  try {
    let parseCalls = 0;
    const runParse = harness.page.runParse.bind(harness.page);
    harness.page.runParse = (...args) => {
      parseCalls += 1;
      return runParse(...args);
    };
    const beforeState = stateCounts(harness.readState());
    harness.page.startVoice();
    voice.callbacks.onRecognize({ text: '王总礼品盒' });
    voice.callbacks.onStop();
    voice.callbacks.onResult({ text: NORMAL_VOICE_TEXT });
    await settlePage(harness.page);
    const evidence = {
      parseCalls,
      route: routeOf(harness.page),
      source: harness.page.data.source,
      text: harness.page.data.text
    };
    return {
      checks: [
        check('CAPTURE_004_TEXT_APPLIED', evidence.text === NORMAL_VOICE_TEXT, evidence),
        check('CAPTURE_004_SOURCE_IS_VOICE', evidence.source === 'voice', evidence),
        check('CAPTURE_004_PARSE_TRIGGERED_ONCE', parseCalls === 1, evidence),
        check('CAPTURE_004_PARSE_RESULT_PRESENT', Boolean(harness.page.data.parseResult), evidence),
        check('CAPTURE_004_MUTATION_ZERO', zeroDelta(diffCounts(beforeState, stateCounts(harness.readState()))), evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
    voice.restore();
  }
}

async function capture005() {
  const harness = createPageHarness({ caseId: 'CAPTURE-005', text: '' });
  try {
    const callbacks = [];
    harness.fakeWx.wx.getClipboardData = (options) => { callbacks.push(options.success); };
    let parseCalls = 0;
    const runParse = harness.page.runParse.bind(harness.page);
    harness.page.runParse = (...args) => {
      parseCalls += 1;
      return runParse(...args);
    };
    const beforeState = stateCounts(harness.readState());
    harness.page.pasteClipboard();
    harness.page.pasteClipboard();
    callbacks[1]({ data: '新剪贴板订单：水杯20个3元' });
    await settlePage(harness.page);
    const currentText = harness.page.data.text;
    const currentSession = harness.page.confirmationSessionId;
    callbacks[0]({ data: STALE_CLIPBOARD_TEXT });
    await settlePage(harness.page);
    const evidence = {
      currentText,
      finalText: harness.page.data.text,
      parseCalls,
      sessionPreserved: harness.page.confirmationSessionId === currentSession
    };
    return {
      checks: [
        check('CAPTURE_005_NEWEST_CAPTURE_WINS', evidence.finalText === currentText, evidence),
        check('CAPTURE_005_OLD_CAPTURE_NO_PARSE', parseCalls === 1, evidence),
        check('CAPTURE_005_SESSION_PRESERVED', evidence.sessionPreserved, evidence),
        check('CAPTURE_005_MUTATION_ZERO', zeroDelta(diffCounts(beforeState, stateCounts(harness.readState()))), evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
  }
}

const CASES = [
  ['CAPTURE-001', capture001],
  ['CAPTURE-002', capture002],
  ['CAPTURE-003', capture003],
  ['CAPTURE-004', capture004],
  ['CAPTURE-005', capture005]
];

async function runRound(round) {
  const results = [];
  for (const [id, execute] of CASES) {
    try {
      const outcome = await execute();
      const firstFailure = outcome.checks.find((entry) => !entry.pass) || null;
      results.push({
        checks: outcome.checks,
        evidence: outcome.evidence,
        firstFailure,
        id,
        status: firstFailure ? 'CASE_FAIL' : 'PASS'
      });
    } catch (error) {
      results.push({
        error: { code: error.code || 'RUNNER_ERROR', message: error.message },
        firstFailure: null,
        id,
        status: 'RUNNER_ERROR'
      });
    }
  }
  return { results, round };
}

function semanticFingerprint(result) {
  return stableHash({
    checks: (result.checks || []).map((entry) => ({ code: entry.code, pass: entry.pass })),
    id: result.id,
    status: result.status
  }, 'record-input-capture-trust-v1');
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let round = 1; round <= Math.max(2, Number(repeat || 2)); round += 1) {
    rounds.push(await runRound(round));
  }
  const baseline = new Map(rounds[0].results.map((result) => [result.id, semanticFingerprint(result)]));
  const mismatches = rounds.slice(1).flatMap((round) => round.results
    .filter((result) => baseline.get(result.id) !== semanticFingerprint(result))
    .map((result) => ({ id: result.id, round: round.round })));
  const runnerErrors = rounds.flatMap((round) => round.results)
    .filter((result) => result.status === 'RUNNER_ERROR');
  const failures = rounds[0].results.filter((result) => result.status === 'CASE_FAIL');
  return {
    contractGate: runnerErrors.length || mismatches.length
      ? 'HARNESS_FAILURE'
      : (failures.length ? 'EXPECTED_RED' : 'PASS'),
    determinism: mismatches.length ? 'UNSTABLE' : 'STABLE',
    results: rounds[0].results,
    rounds: rounds.length,
    runnerErrorCount: runnerErrors.length
  };
}

async function main() {
  const index = process.argv.indexOf('--repeat');
  const report = await runSuite(index >= 0 ? process.argv[index + 1] : 2);
  console.log(`CONTRACT_GATE=${report.contractGate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.determinism}`);
  console.log(`RUNNER_ERROR=${report.runnerErrorCount}`);
  report.results.forEach((result) => {
    console.log(`${result.id}\t${result.status}\tFIRST=${result.firstFailure ? result.firstFailure.code : '-'}`);
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

module.exports = { runSuite };
