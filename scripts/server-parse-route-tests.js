#!/usr/bin/env node

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { mockParse } = require('../server/src/ai/mock');

const ROOT = path.resolve(__dirname, '..');
const port = 38000 + (process.pid % 1000);
const fakeAiPort = 40000 + (process.pid % 1000);
const fakeAiResponses = [];
const fakeAiRequests = [];
let server = null;

const fakeAiServer = http.createServer((req, res) => {
  let text = '';
  req.on('data', (chunk) => { text += chunk; });
  req.on('end', () => {
    try {
      fakeAiRequests.push(JSON.parse(text || '{}'));
      if (!fakeAiResponses.length) throw new Error('离线AI响应队列为空');
      const result = fakeAiResponses.shift();
      const payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    } catch (error) {
      const payload = JSON.stringify({ error: error.message });
      res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    }
  });
});

function startFakeAiServer() {
  return new Promise((resolve, reject) => {
    fakeAiServer.once('error', reject);
    fakeAiServer.listen(fakeAiPort, '127.0.0.1', resolve);
  });
}

function startProductServer() {
  server = spawn(process.execPath, ['server/src/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      NODE_ENV: 'test',
      AUTH_REQUIRED: 'false',
      AI_PROVIDER: 'offline-fake-provider',
      AI_API_KEY: 'synthetic-offline-key',
      AI_BASE_URL: `http://127.0.0.1:${fakeAiPort}`,
      AI_MODEL: 'offline-quality-model',
      AI_FAST_MODEL: 'offline-fast-model'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function stopServer() {
  if (server && !server.killed) server.kill('SIGTERM');
  if (fakeAiServer.listening) fakeAiServer.close();
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
    const mock = mockParse({ text: '王总订水杯100个，5块5一个，明天交', source: 'typed' });
    assert.strictEqual(mock.provider, 'mock', '服务端mock必须明确保留mock来源');

    await startFakeAiServer();
    startProductServer();
    await waitUntilReady();
    const sample = {
      text: '王总订水杯100个，5块5一个，明天交',
      source: 'voice',
      localDraft: { intent: 'order', fields: {} }
    };
    fakeAiResponses.push({
      intent: 'order',
      fields: { customerName: '王总', productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5' },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const standard = await request('/api/ai/parse', sample);
    assert.strictEqual(standard.statusCode, 200, '普通核对接口应可用');
    assert(standard.body.ai_request_id, '普通核对必须返回可追踪编号');
    assert.strictEqual(standard.body.ai_deadline_ms, 5200, '普通核对服务端上限必须是 5.2 秒');
    assert.strictEqual(standard.body.ai_business_result_valid, true, '普通核对有效结果必须带业务有效标记');
    assert.strictEqual(standard.body.provider, 'offline-fake-provider', '普通核对必须保留离线fake来源');

    fakeAiResponses.push({
      intent: 'order',
      fields: { items: [
        { productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5' },
        { productName: '礼品盒', quantity: '20', unit: '套', unitPrice: '8' }
      ] },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const deep = await request('/api/ai/parse/deep', sample);
    assert.strictEqual(deep.statusCode, 200, '深度核对接口应可用');
    assert(deep.body.ai_request_id, '深度核对必须返回可追踪编号');
    assert.strictEqual(deep.body.ai_deadline_ms, 20000, '深度核对必须使用独立的较长上限');
    assert.strictEqual(deep.body.ai_business_result_valid, true, '深度核对有效多商品结果必须带业务有效标记');
    assert.strictEqual(deep.body.fields.items.length, 2, '深度核对有效多商品结果必须保留items');

    fakeAiResponses.push({});
    const emptyStandard = await request('/api/ai/parse', sample);
    assert.strictEqual(emptyStandard.statusCode, 422, '普通核对空业务结果必须返回422');
    assert.strictEqual(emptyStandard.body.error, 'AI_RESPONSE_EMPTY_BUSINESS', '普通核对必须返回统一空业务错误码');

    fakeAiResponses.push({ fields: {} });
    const emptyDeep = await request('/api/ai/parse/deep', sample);
    assert.strictEqual(emptyDeep.statusCode, 422, '深度核对空fields必须返回422');
    assert.strictEqual(emptyDeep.body.error, 'AI_RESPONSE_EMPTY_BUSINESS', '深度核对必须返回统一空业务错误码');

    assert.strictEqual(fakeAiRequests.length, 4, '离线fake上游请求次数必须符合预期');
    assert.strictEqual(fakeAiRequests[0].model, 'offline-fast-model', 'standard必须使用离线fast模型');
    assert.strictEqual(fakeAiRequests[1].model, 'offline-quality-model', 'deep必须使用离线quality模型');
    console.log('服务端识别路由测试通过：mock来源明确、standard/deep有效结果正常、空业务结果均返回422。');
  } finally {
    stopServer();
  }
}

main().catch((error) => {
  stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});
