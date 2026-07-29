#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  REQUIRED_GUARD_APIS,
  assertNoNetworkAttempts,
  buildOfflineEnv,
  readGuardAttempts
} = require('./run-record-offline-regression');
const { parseMode } = require('./ai-contract-smoke');

const ROOT = path.resolve(__dirname, '..');
const AI_SMOKE = path.join(__dirname, 'ai-contract-smoke.js');
let sequence = 0;

function auditPath(label) {
  sequence += 1;
  return path.join(
    '/private/tmp',
    `record-offline-self-test-${label}-${process.pid}-${sequence}.jsonl`
  );
}

function spawnOffline(args, options = {}) {
  const targetAuditPath = options.auditPath || auditPath('child');
  const offline = buildOfflineEnv(
    Object.assign({}, process.env, options.sourceEnv || {}),
    targetAuditPath
  );
  Object.assign(offline.env, options.afterScrubEnv || {});
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: offline.env
  });
  return {
    attempts: readGuardAttempts(targetAuditPath),
    auditPath: targetAuditPath,
    envScrub: offline.evidence,
    result
  };
}

function assertGuardProbe(name, code, expectedApi) {
  const probe = spawnOffline(['-e', code], { auditPath: auditPath(name) });
  assert.strictEqual(probe.result.status, 0, `${name}: ${probe.result.stderr}`);
  assert.strictEqual(probe.attempts.length, 1, `${name}: one attempt must be captured`);
  assert.strictEqual(probe.attempts[0].api, expectedApi);
  assert.strictEqual(probe.attempts[0].destinationHost, 'api.baizeji.com');
  return probe;
}

const tests = [
  {
    name: 'default-ai-contract-smoke-refuses-without-network',
    run() {
      const execution = spawnOffline([AI_SMOKE]);
      assert.strictEqual(execution.result.status, 2);
      assert.match(execution.result.stderr, /AI_SMOKE_MODE_REQUIRED/);
      assert.deepStrictEqual(execution.attempts, []);
    }
  },
  {
    name: 'offline-ai-contract-smoke-uses-replay-only',
    run() {
      const execution = spawnOffline([AI_SMOKE, '--offline']);
      assert.strictEqual(execution.result.status, 0, execution.result.stderr);
      assert.match(execution.result.stdout, /OFFLINE_REPLAY/);
      assert.deepStrictEqual(execution.attempts, []);
    }
  },
  {
    name: 'live-flag-without-environment-consent-refuses',
    run() {
      const execution = spawnOffline([AI_SMOKE, '--live-ai']);
      assert.strictEqual(execution.result.status, 1);
      assert.match(execution.result.stderr, /LIVE_AI_DUAL_OPT_IN_REQUIRED/);
      assert.deepStrictEqual(execution.attempts, []);
    }
  },
  {
    name: 'environment-consent-without-live-flag-refuses',
    run() {
      const execution = spawnOffline([AI_SMOKE], {
        afterScrubEnv: { ALLOW_LIVE_AI_SMOKE: '1' }
      });
      assert.strictEqual(execution.result.status, 2);
      assert.match(execution.result.stderr, /AI_SMOKE_MODE_REQUIRED/);
      assert.deepStrictEqual(execution.attempts, []);
    }
  },
  {
    name: 'dual-consent-still-requires-explicit-endpoint',
    run() {
      const execution = spawnOffline([AI_SMOKE, '--live-ai'], {
        afterScrubEnv: { ALLOW_LIVE_AI_SMOKE: '1' }
      });
      assert.strictEqual(execution.result.status, 1);
      assert.match(execution.result.stderr, /LIVE_AI_ENDPOINT_REQUIRED/);
      assert.deepStrictEqual(execution.attempts, []);
    }
  },
  {
    name: 'fetch-is-blocked-and-sanitized',
    run() {
      const probe = assertGuardProbe(
        'fetch',
        [
          'try {',
          '  fetch("https://api.baizeji.com/api/ai/parse?token=do-not-log", {',
          '    method: "POST",',
          '    headers: { Authorization: "Bearer do-not-log" },',
          '    body: "private-body-do-not-log"',
          '  });',
          '} catch (error) {',
          '  if (error.code !== "AUTOMATION_NETWORK_GUARD_ERROR") process.exit(3);',
          '}'
        ].join('\n'),
        'fetch'
      );
      const serialized = JSON.stringify(probe.attempts);
      assert(!serialized.includes('do-not-log'));
      assert(!serialized.includes('Authorization'));
      assert(!serialized.includes('private-body'));
    }
  },
  {
    name: 'https-request-is-blocked',
    run() {
      assertGuardProbe(
        'https',
        [
          'try {',
          '  require("https").request({ hostname: "api.baizeji.com", port: 443 });',
          '} catch (error) {',
          '  if (error.code !== "AUTOMATION_NETWORK_GUARD_ERROR") process.exit(3);',
          '}'
        ].join('\n'),
        'https.request'
      );
    }
  },
  {
    name: 'net-connect-is-blocked',
    run() {
      assertGuardProbe(
        'net',
        [
          'try {',
          '  require("net").connect({ host: "api.baizeji.com", port: 443 });',
          '} catch (error) {',
          '  if (error.code !== "AUTOMATION_NETWORK_GUARD_ERROR") process.exit(3);',
          '}'
        ].join('\n'),
        'net.connect'
      );
    }
  },
  {
    name: 'worker-inherits-preloaded-guard',
    run() {
      const code = [
        'const { Worker } = require("worker_threads");',
        'const worker = new Worker(`',
        '  try {',
        '    fetch("https://api.baizeji.com/worker");',
        '  } catch (error) {',
        '    if (error.code === "AUTOMATION_NETWORK_GUARD_ERROR") process.exit(0);',
        '    process.exit(3);',
        '  }',
        '`, { eval: true });',
        'worker.on("exit", (code) => process.exit(code));',
        'worker.on("error", () => process.exit(4));'
      ].join('\n');
      assertGuardProbe('worker', code, 'fetch');
    }
  },
  {
    name: 'child-process-inherits-preloaded-guard',
    run() {
      const code = [
        'const { spawnSync } = require("child_process");',
        'const child = spawnSync(process.execPath, ["-e", `',
        '  try {',
        '    fetch("https://api.baizeji.com/child");',
        '  } catch (error) {',
        '    if (error.code === "AUTOMATION_NETWORK_GUARD_ERROR") process.exit(0);',
        '    process.exit(3);',
        '  }',
        '`], { env: process.env });',
        'process.exit(child.status === 0 ? 0 : 4);'
      ].join('\n');
      assertGuardProbe('child-process', code, 'fetch');
    }
  },
  {
    name: 'offline-child-environment-strips-ai-secrets-and-proxies',
    run() {
      const offline = buildOfflineEnv({
        ALLOW_LIVE_AI_SMOKE: '1',
        API_BASE_URL: 'https://api.baizeji.com',
        DASHSCOPE_API_KEY: 'synthetic-secret',
        HTTP_PROXY: 'http://proxy.invalid',
        PATH: process.env.PATH,
        QWEN_API_KEY: 'synthetic-secret'
      }, auditPath('env'));
      assert.strictEqual(offline.env.API_BASE_URL, undefined);
      assert.strictEqual(offline.env.DASHSCOPE_API_KEY, undefined);
      assert.strictEqual(offline.env.QWEN_API_KEY, undefined);
      assert.strictEqual(offline.env.HTTP_PROXY, undefined);
      assert.strictEqual(offline.env.ALLOW_LIVE_AI_SMOKE, undefined);
      assert.strictEqual(offline.env.RECORD_OFFLINE_MODE, '1');
      assert(offline.evidence.strippedNames.includes('QWEN_API_KEY'));
    }
  },
  {
    name: 'one-network-attempt-invalidates-the-test',
    run() {
      assert.throws(
        () => assertNoNetworkAttempts([{
          api: 'fetch',
          destinationHost: 'api.baizeji.com',
          destinationPort: '443'
        }], 'sentinel-round'),
        (error) => error.code === 'AUTOMATION_NETWORK_GUARD_ERROR'
      );
    }
  },
  {
    name: 'network-guard-error-is-not-a-product-case-fail',
    run() {
      let actual = null;
      try {
        assertNoNetworkAttempts([{ api: 'https.request' }], 'sentinel-case');
      } catch (error) {
        actual = error;
      }
      assert(actual);
      assert.strictEqual(actual.code, 'AUTOMATION_NETWORK_GUARD_ERROR');
      assert.notStrictEqual(actual.code, 'CASE_FAIL');
    }
  },
  {
    name: 'offline-mode-never-consumes-live-endpoint',
    run() {
      const mode = parseMode(['--offline'], {
        API_BASE_URL: 'https://api.baizeji.com'
      });
      assert.strictEqual(mode.mode, 'OFFLINE_REPLAY');
      assert.strictEqual(mode.baseUrl, '');
      assert(!fs.readFileSync(AI_SMOKE, 'utf8').includes(
        "process.env.API_BASE_URL || 'https://api.baizeji.com'"
      ));
    }
  },
  {
    name: 'guard-surfaces-are-declared-complete',
    run() {
      assert.deepStrictEqual(REQUIRED_GUARD_APIS, [
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
    }
  }
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  console.log(`PASS ${test.name}`);
}
console.log(`Record offline regression tests: ${passed}/${tests.length} passed`);
