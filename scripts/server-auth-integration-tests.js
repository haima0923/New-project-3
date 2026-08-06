#!/usr/bin/env node

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { createSessionToken } = require('../server/src/lib/wechat-auth');

const ROOT = path.resolve(__dirname, '..');
const node = process.execPath;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function request(port, pathName, token = '') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      businessDate: '2026-07-22',
      businessTimezone: 'Asia/Shanghai',
      nowInstant: '2026-07-22T02:30:00.000Z',
      text: '王总订水杯100个，5块5一个，明天交'
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }, token ? { authorization: `Bearer ${token}` } : {})
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const port = await getFreePort();
  const config = {
    authTokenSecret: '0123456789abcdef0123456789abcdef',
    authTokenTtlSeconds: 3600,
    wechatAppId: 'wx-test-app',
    wechatAppSecret: 'test-secret'
  };
  const server = spawn(node, ['src/server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      NODE_ENV: 'production',
      AI_PROVIDER: 'mock',
      AUTH_REQUIRED: 'true',
      WECHAT_APP_ID: config.wechatAppId,
      WECHAT_APP_SECRET: config.wechatAppSecret,
      AUTH_TOKEN_SECRET: config.authTokenSecret,
      AUTH_TOKEN_TTL_SECONDS: String(config.authTokenTtlSeconds)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 5000);
      server.stdout.on('data', (chunk) => {
        if (String(chunk).includes('listening on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      server.stderr.on('data', (chunk) => reject(new Error(String(chunk))));
      server.once('exit', (code) => reject(new Error(`Server exited early with ${code}`)));
    });

    const anonymous = await request(port, '/api/ai/parse');
    assert.strictEqual(anonymous.statusCode, 401);
    assert.strictEqual(anonymous.body.error, 'AUTH_REQUIRED');

    const validToken = createSessionToken('openid_test_user', config).token;
    const verified = await request(port, '/api/ai/parse', validToken);
    assert.strictEqual(verified.statusCode, 200,
      `有效令牌必须进入完整简单订单业务处理：${JSON.stringify(verified.body)}`);

    const tampered = await request(port, '/api/ai/parse', `${validToken}bad`);
    assert.strictEqual(tampered.statusCode, 401);
    assert.strictEqual(tampered.body.error, 'AUTH_REQUIRED');
    console.log('服务器微信登录保护集成测试通过：未登录拒绝、有效令牌放行、篡改令牌拒绝。');
  } finally {
    if (!server.killed) server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
