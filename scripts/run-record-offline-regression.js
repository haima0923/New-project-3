#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD_STATE = Symbol.for('huoxiaoling.recordOfflineNetworkGuard.v1');
const REQUIRED_GUARD_APIS = Object.freeze([
  'fetch',
  'http.get',
  'http.request',
  'https.get',
  'https.request',
  'net.connect',
  'net.createConnection',
  'net.Socket.connect',
  'tls.connect'
]);
const SENSITIVE_ENV_NAME = /(?:^|_)(?:AI|API|QWEN|DASHSCOPE|BAIZEJI|OPENAI|ANTHROPIC|AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:_|$)|(?:API|AI).*KEY/i;
const STRIPPED_ENV_NAMES = new Set([
  'ALLOW_LIVE_AI_SMOKE',
  'ALL_PROXY',
  'API_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'HUOXIAOLING_API_BASE_URL',
  'NO_PROXY',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy'
]);

function safeStackSummary() {
  return String(new Error('offline guard').stack || '')
    .split('\n')
    .slice(2)
    .filter((line) => !line.includes('run-record-offline-regression.js'))
    .filter((line) => !line.includes('node:internal'))
    .slice(0, 4)
    .map((line) => line.trim().replace(ROOT, '<workspace>'));
}

function parseDestination(api, args) {
  const first = args[0];
  let host = '';
  let port = '';
  let rawUrl = '';
  if (typeof first === 'string' || first instanceof URL) {
    rawUrl = String(first);
  } else if (first && typeof first === 'object') {
    host = String(first.hostname || first.host || '');
    port = String(first.port || '');
    if (first.href) rawUrl = String(first.href);
  }
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      host = parsed.hostname;
      port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    } catch (error) {
      host = '<unparseable>';
    }
  }
  return {
    api,
    callerScript: safeStackSummary()[0] || '<unknown>',
    destinationHost: host || '<unknown>',
    destinationPort: port || '<unknown>',
    stackSummary: safeStackSummary()
  };
}

function appendGuardAttempt(event) {
  const auditPath = process.env.RECORD_OFFLINE_AUDIT_PATH;
  if (auditPath) {
    fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
  }
  process.stderr.write(`RECORD_OFFLINE_NETWORK_GUARD ${JSON.stringify(event)}\n`);
}

function createGuardError(api, args) {
  const event = parseDestination(api, args);
  appendGuardAttempt(event);
  const error = new Error(
    `Offline regression blocked ${api} to ${event.destinationHost}:${event.destinationPort}`
  );
  error.code = 'AUTOMATION_NETWORK_GUARD_ERROR';
  error.networkGuardEvidence = event;
  return error;
}

function installOfflineNetworkGuard() {
  if (global[GUARD_STATE]) return global[GUARD_STATE];
  const state = {
    apiSurfaces: {},
    installed: false,
    installedAt: 'PRELOAD_BEFORE_PROJECT_CODE',
    mode: 'OFFLINE_FAIL_CLOSED',
    version: 'record-offline-network-guard-v1'
  };
  const guard = (api) => function blockedNetworkApi(...args) {
    throw createGuardError(api, args);
  };
  global.fetch = guard('fetch');
  state.apiSurfaces.fetch = true;

  const http = require('http');
  const https = require('https');
  const net = require('net');
  const tls = require('tls');
  http.request = guard('http.request');
  http.get = guard('http.get');
  https.request = guard('https.request');
  https.get = guard('https.get');
  net.connect = guard('net.connect');
  net.createConnection = guard('net.createConnection');
  net.Socket.prototype.connect = guard('net.Socket.connect');
  tls.connect = guard('tls.connect');
  [
    'http.request',
    'http.get',
    'https.request',
    'https.get',
    'net.connect',
    'net.createConnection',
    'net.Socket.connect',
    'tls.connect'
  ].forEach((api) => {
    state.apiSurfaces[api] = true;
  });
  state.installed = true;
  global[GUARD_STATE] = Object.freeze(state);
  return global[GUARD_STATE];
}

function buildOfflineEnv(sourceEnv = process.env, auditPath = '') {
  const env = {};
  const strippedNames = [];
  Object.entries(sourceEnv).forEach(([name, value]) => {
    if (name === 'NODE_OPTIONS'
      || STRIPPED_ENV_NAMES.has(name)
      || SENSITIVE_ENV_NAME.test(name)) {
      strippedNames.push(name);
      return;
    }
    env[name] = value;
  });
  const preloadPath = path.resolve(__filename);
  env.NODE_OPTIONS = `--require=${JSON.stringify(preloadPath)}`;
  env.RECORD_OFFLINE_AUDIT_PATH = auditPath;
  env.RECORD_OFFLINE_GUARD_PRELOAD = '1';
  env.RECORD_OFFLINE_MODE = '1';
  env.RECORD_OFFLINE_STRIPPED_ENV_NAMES = strippedNames.sort().join(',');
  return {
    env,
    evidence: {
      inputKeyCount: Object.keys(sourceEnv).length,
      outputKeyCount: Object.keys(env).length,
      performed: true,
      strippedNames: strippedNames.sort()
    }
  };
}

function testEntry(script, args = []) {
  return {
    args: [path.join(ROOT, script), ...args],
    command: process.execPath
  };
}

const TESTS = Object.freeze({
  'ai-contract-offline': testEntry('scripts/ai-contract-smoke.js', ['--offline']),
  'ai-model-routing': testEntry('scripts/ai-model-routing-tests.js'),
  'ai-p0-safety': testEntry('scripts/ai-safety-regression-tests.js'),
  'corpus-validator': testEntry('scripts/validate-record-e2e-corpus.js'),
  'domain-preflight': testEntry('scripts/record-domain-preflight-tests.js'),
  'e2e-amb-002': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-AMB-002']),
  'e2e-amb-005': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-AMB-005']),
  'e2e-amb-011': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-AMB-011']),
  'e2e-amb-016': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-AMB-016']),
  'e2e-basic-001': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-001']),
  'e2e-basic-004': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-004']),
  'e2e-basic-006': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-006']),
  'e2e-basic-007': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-007']),
  'e2e-basic-008': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-008']),
  'e2e-basic-009': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-009']),
  'e2e-basic-010': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-010']),
  'e2e-basic-012': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-012']),
  'e2e-basic-016': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-016']),
  'e2e-basic-019': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-BASIC-019']),
  'e2e-chat-003': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-CHAT-003']),
  'e2e-chat-005': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-CHAT-005']),
  'e2e-chat-007': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-CHAT-007']),
  'e2e-chat-009': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-CHAT-009']),
  'e2e-date-009': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-DATE-009']),
  'e2e-multi-008': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-MULTI-008']),
  'e2e-page-001': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-PAGE-001']),
  'e2e-page-003': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-PAGE-003']),
  'e2e-page-008': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-PAGE-008']),
  'e2e-rel-001': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-REL-001']),
  'e2e-rel-002': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-REL-002']),
  'e2e-rel-008': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-REL-008']),
  'e2e-voice-004': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-VOICE-004']),
  'e2e-voice-006': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-VOICE-006']),
  'e2e-voice-007': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-VOICE-007']),
  'e2e-voice-008': testEntry('scripts/run-record-e2e-headless.js', ['--case-id', 'REC-E2E-VOICE-008']),
  'five-step': testEntry('scripts/five-step-user-tests.js'),
  'financial-adjacent': testEntry('tests/record-e2e/runner-tests/payment-financial-adjacent-tests.js'),
  'flow-gate': testEntry('scripts/record-flow-gate.js'),
  'full-corpus-report-self-tests': testEntry('tests/record-e2e/runner-tests/full-corpus-self-tests.js'),
  'home-primary-item': testEntry('scripts/record-home-primary-item-sync-tests.js'),
  'observation-semantics': testEntry('tests/record-e2e/runner-tests/runner-self-tests.js'),
  'offline-guard-self-tests': testEntry('scripts/record-offline-regression-tests.js'),
  'order-reference-evidence': testEntry('scripts/record-parser-order-reference-evidence-tests.js'),
  'order-selection': testEntry('tests/record-e2e/runner-tests/order-selection-surface-tests.js'),
  'page-action-registry': testEntry('tests/record-e2e/runner-tests/page-action-registry-tests.js'),
  'parser-invocation-graph': testEntry('tests/record-e2e/runner-tests/parser-invocation-graph-tests.js'),
  'payment-parser': testEntry('scripts/record-parser-payment-intent-tests.js'),
  'quotation-negation-parser': testEntry('scripts/record-parser-quotation-negation-tests.js'),
  'quotation-candidate': testEntry('tests/record-e2e/runner-tests/quotation-candidate-source-tests.js'),
  'quotation-selection': testEntry('tests/record-e2e/runner-tests/quotation-selection-surface-tests.js'),
  'receivable-parser': testEntry('scripts/record-parser-receivable-intent-tests.js'),
  'release-a-rc1': testEntry('scripts/record-release-a-rc1-tests.js'),
  'route-status': testEntry('scripts/parse-route-observability-tests.js'),
  'runner-kernel': testEntry('tests/record-e2e/runner-tests/runner-self-tests.js'),
  'shared-core-phase1a': testEntry('scripts/record-shared-core-phase1a-tests.js'),
  'shared-core-phase1c': testEntry('scripts/record-shared-core-phase1c-tests.js'),
  'shared-confirmation': testEntry('scripts/record-shared-core-phase1d-tests.js'),
  'ui-structure': testEntry('scripts/ui-release-tests.js'),
  'voice-fake': testEntry('scripts/voice-recognition-tests.js')
});

function readGuardAttempts(auditPath) {
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoNetworkAttempts(attempts, testId) {
  if (!attempts.length) return;
  throw Object.assign(
    new Error(`${testId} attempted ${attempts.length} network call(s)`),
    {
      code: 'AUTOMATION_NETWORK_GUARD_ERROR',
      evidence: attempts
    }
  );
}

function offlineAuditPath(testId) {
  return path.join(
    '/private/tmp',
    `record-offline-${testId.replace(/[^a-z0-9-]/gi, '-')}-${process.pid}-${Date.now()}.jsonl`
  );
}

function fullCorpusEntry(outputPath) {
  const resolved = path.resolve(outputPath);
  if (!resolved.startsWith('/private/tmp/')) {
    throw Object.assign(
      new Error('Full corpus output must be under /private/tmp'),
      { code: 'OFFLINE_TEST_ARGUMENT_ERROR' }
    );
  }
  return testEntry('scripts/run-record-e2e-headless.js', [
    '--all',
    '--repeat',
    '2',
    '--output',
    resolved
  ]);
}

function runAllowlistedTest(testId, options = {}) {
  const entry = testId === 'full-corpus'
    ? fullCorpusEntry(
      options.output || '/private/tmp/record-parser-payment-intent-v1-offline.json'
    )
    : TESTS[testId];
  if (!entry) {
    throw Object.assign(new Error(`Test is not allowlisted: ${testId}`), {
      code: 'OFFLINE_TEST_NOT_ALLOWLISTED'
    });
  }
  const auditPath = offlineAuditPath(testId);
  const offline = buildOfflineEnv(process.env, auditPath);
  const startedAt = new Date().toISOString();
  const child = spawnSync(entry.command, entry.args, {
    cwd: ROOT,
    env: offline.env,
    stdio: 'inherit'
  });
  const attempts = readGuardAttempts(auditPath);
  const result = {
    envScrub: offline.evidence,
    exitCode: child.status,
    guardApis: REQUIRED_GUARD_APIS,
    guardInstalledByPreload: true,
    networkGuardAttempts: attempts.length,
    signal: child.signal || '',
    startedAt,
    testId
  };
  console.log(`OFFLINE_REGRESSION_RESULT ${JSON.stringify(result)}`);
  assertNoNetworkAttempts(attempts, testId);
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw Object.assign(
      new Error(`${testId} exited with ${child.status}${child.signal ? ` (${child.signal})` : ''}`),
      { code: 'OFFLINE_TEST_FAILED' }
    );
  }
  return result;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-record-offline-regression.js --list',
    '  node scripts/run-record-offline-regression.js --test TEST_ID',
    '  node scripts/run-record-offline-regression.js --test full-corpus [--output /private/tmp/report.json]'
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--list') {
    console.log([...Object.keys(TESTS), 'full-corpus'].sort().join('\n'));
    return;
  }
  let testId = '';
  let output = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--test') testId = argv[++index] || '';
    else if (arg === '--output') output = argv[++index] || '';
    else throw Object.assign(new Error(`Unknown argument: ${arg}`), {
      code: 'OFFLINE_TEST_ARGUMENT_ERROR'
    });
  }
  if (!testId) {
    console.log(usage());
    return;
  }
  runAllowlistedTest(testId, { output });
}

if (process.env.RECORD_OFFLINE_GUARD_PRELOAD === '1') {
  installOfflineNetworkGuard();
} else if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`${error.code || 'OFFLINE_REGRESSION_ERROR'}: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = {
  REQUIRED_GUARD_APIS,
  TESTS,
  assertNoNetworkAttempts,
  buildOfflineEnv,
  installOfflineNetworkGuard,
  main,
  parseDestination,
  readGuardAttempts,
  runAllowlistedTest
};
