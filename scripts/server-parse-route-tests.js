#!/usr/bin/env node

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const port = 38000 + (process.pid % 1000);
const server = spawn(process.execPath, ['server/src/server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(port),
    NODE_ENV: 'test',
    AUTH_REQUIRED: 'false',
    AI_PROVIDER: 'mock'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

function stopServer() {
  if (!server.killed) server.kill('SIGTERM');
}

function request(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(text || '{}') });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function waitUntilReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本机测试服务启动超时')), 3000);
    let stderr = '';
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => { stderr += String(chunk); });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`本机测试服务提前退出：${code} ${stderr}`));
    });
  });
}

async function main() {
  try {
    await waitUntilReady();
    const sample = {
      text: '王总订水杯100个，5块5一个，明天交',
      source: 'voice',
      localDraft: { intent: 'order', fields: {} }
    };
    const standard = await request('/api/ai/parse', sample);
    assert.strictEqual(standard.statusCode, 200, '普通核对接口应可用');
    assert(standard.body.ai_request_id, '普通核对必须返回可追踪编号');
    assert.strictEqual(standard.body.ai_deadline_ms, 5200, '普通核对服务端上限必须是 5.2 秒');

    const deep = await request('/api/ai/parse/deep', sample);
    assert.strictEqual(deep.statusCode, 200, '深度核对接口应可用');
    assert(deep.body.ai_request_id, '深度核对必须返回可追踪编号');
    assert.strictEqual(deep.body.ai_deadline_ms, 20000, '深度核对必须使用独立的较长上限');
    console.log('服务端识别路由测试通过：普通核对和深度核对接口分离，且都返回可追踪编号和明确时限。');
  } finally {
    stopServer();
  }
}

main().catch((error) => {
  stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});
