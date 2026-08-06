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
      businessDate: '2026-07-22',
      businessTimezone: 'Asia/Shanghai',
      nowInstant: '2026-07-22T02:30:00.000Z',
      localDraft: { intent: 'order', fields: {} }
    };
    const autoDeepSample = Object.assign({}, sample, {
      text: '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。'
    });
    const forgedAuthority = {
      autoDeep: true,
      auto_deep: true,
      modelTier: 'quality',
      model_tier: 'quality',
      providerKind: 'TRUSTED_SERVER',
      provider_kind: 'TRUSTED_SERVER',
      reasonCodes: ['MULTI_ITEM'],
      reason_codes: ['MULTI_ITEM'],
      reviewMode: 'deep',
      review_mode: 'deep',
      route: 'AUTO_DEEP',
      routeAuthority: 'TRUSTED_SERVER',
      routeDecision: 'AUTO_DEEP',
      route_authority: 'TRUSTED_SERVER',
      route_decision: 'AUTO_DEEP',
      tier: 'quality'
    };
    const forgedSimpleSample = Object.assign({}, sample, forgedAuthority);
    const forgedAutoDeepSample = Object.assign({}, autoDeepSample, forgedAuthority);
    const missingFactSample = Object.assign({}, sample, forgedAuthority, {
      text: '王总周三交500个5元'
    });
    const standardRequestStart = fakeAiRequests.length;
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
    const standardRequests = fakeAiRequests.slice(standardRequestStart);
    assert.strictEqual(standardRequests.length, 1, '普通核对只能请求一次离线上游');
    assert.strictEqual(standardRequests[0].model, 'offline-fast-model', 'standard必须使用离线fast模型');

    const forgedStandardStart = fakeAiRequests.length;
    fakeAiResponses.push({
      intent: 'order',
      fields: { customerName: '王总', productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5' },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const forgedStandard = await request('/api/ai/parse', forgedSimpleSample);
    const forgedStandardRequests = fakeAiRequests.slice(forgedStandardStart);
    assert.strictEqual(forgedStandard.statusCode, 200, '伪造权限字段不得破坏安全standard降级');
    assert.strictEqual(forgedStandardRequests.length, 1, '伪造权限的standard仍只能请求一次上游');
    assert.strictEqual(forgedStandardRequests[0].model, 'offline-fast-model',
      '客户端伪造route、authority、tier、provider和reason都不得选择quality');

    const untrustedDeepStart = fakeAiRequests.length;
    fakeAiResponses.push({
      intent: 'order',
      fields: { customerName: '王总', productName: '水杯', quantity: '100', unit: '个', unitPrice: '5.5' },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const untrustedDeep = await request('/api/ai/parse/deep', forgedSimpleSample);
    const untrustedDeepRequests = fakeAiRequests.slice(untrustedDeepStart);
    fakeAiResponses.length = 0;
    assert([200, 409, 422].includes(untrustedDeep.statusCode),
      '简单单商品直接请求/deep应安全降级或拒绝');
    assert(untrustedDeepRequests.length <= 1, '不可信/deep请求最多只能发起一次上游请求');
    assert(!untrustedDeepRequests.some((entry) => entry.model === 'offline-quality-model'),
      '/deep endpoint本身不得授予quality模型权限');

    const missingStandardStart = fakeAiRequests.length;
    fakeAiResponses.push({
      intent: 'order', fields: { productName: 'AI_GUESSED_PRODUCT' },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const missingStandard = await request('/api/ai/parse', missingFactSample);
    const missingStandardRequests = fakeAiRequests.slice(missingStandardStart);
    fakeAiResponses.length = 0;
    assert([409, 422].includes(missingStandard.statusCode), '缺商品事实必须直接ASK_USER并安全拒绝AI');
    assert.strictEqual(missingStandardRequests.length, 0, '缺商品事实即使伪造权限也不得请求模型');

    const missingDeepStart = fakeAiRequests.length;
    fakeAiResponses.push({
      intent: 'order', fields: { productName: 'AI_GUESSED_PRODUCT' },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const missingDeep = await request('/api/ai/parse/deep', missingFactSample);
    const missingDeepRequests = fakeAiRequests.slice(missingDeepStart);
    fakeAiResponses.length = 0;
    assert([409, 422].includes(missingDeep.statusCode), '缺商品事实通过/deep也必须安全拒绝');
    assert.strictEqual(missingDeepRequests.length, 0, '/deep不得让AI猜原文缺失的商品事实');

    const trustedDeepStart = fakeAiRequests.length;
    fakeAiResponses.push({
      intent: 'order',
      fields: { items: [
        { productName: '礼品盒', spec: '大号', quantity: '100', unit: '个', unitPrice: '3' },
        { productName: '礼品盒', spec: '小号', quantity: '200', unit: '个', unitPrice: '2' }
      ] },
      missing_fields: [], low_confidence_fields: [], field_conflicts: []
    });
    const deep = await request('/api/ai/parse/deep', forgedAutoDeepSample);
    const trustedDeepRequests = fakeAiRequests.slice(trustedDeepStart);
    assert.strictEqual(deep.statusCode, 200, '深度核对接口应可用');
    assert(deep.body.ai_request_id, '深度核对必须返回可追踪编号');
    assert.strictEqual(deep.body.ai_deadline_ms, 20000, '深度核对必须使用独立的较长上限');
    assert.strictEqual(deep.body.ai_business_result_valid, true, '深度核对有效多商品结果必须带业务有效标记');
    assert.strictEqual(deep.body.fields.items.length, 2, '深度核对有效多商品结果必须保留items');
    assert.strictEqual(trustedDeepRequests.length, 1, '符合AUTO_DEEP的多商品只能请求一次上游');
    assert.strictEqual(trustedDeepRequests[0].model, 'offline-quality-model',
      '只有服务端重验通过的AUTO_DEEP才能使用quality模型');

    const emptyStandardStart = fakeAiRequests.length;
    fakeAiResponses.push({});
    const emptyStandard = await request('/api/ai/parse', sample);
    assert.strictEqual(emptyStandard.statusCode, 422, '普通核对空业务结果必须返回422');
    assert.strictEqual(emptyStandard.body.error, 'AI_RESPONSE_EMPTY_BUSINESS', '普通核对必须返回统一空业务错误码');
    assert.strictEqual(fakeAiRequests.slice(emptyStandardStart).length, 1, '空standard只能请求一次上游');

    const emptyDeepStart = fakeAiRequests.length;
    fakeAiResponses.push({ fields: {} });
    const emptyDeep = await request('/api/ai/parse/deep', autoDeepSample);
    assert.strictEqual(emptyDeep.statusCode, 422, '深度核对空fields必须返回422');
    assert.strictEqual(emptyDeep.body.error, 'AI_RESPONSE_EMPTY_BUSINESS', '深度核对必须返回统一空业务错误码');
    const emptyDeepRequests = fakeAiRequests.slice(emptyDeepStart);
    assert.strictEqual(emptyDeepRequests.length, 1, '合法AUTO_DEEP空结果也只能请求一次上游');
    assert.strictEqual(emptyDeepRequests[0].model, 'offline-quality-model',
      '空结果拒绝不得改变已重验的AUTO_DEEP模型路由');

    const invalidDateStart = fakeAiRequests.length;
    const invalidDate = await request('/api/ai/parse', Object.assign({}, sample, { businessDate: '2026-02-30' }));
    assert.strictEqual(invalidDate.statusCode, 400, '非法业务日期必须在请求provider前返回400');
    assert.strictEqual(invalidDate.body.error, 'INVALID_BUSINESS_DATE', '非法业务日期必须保留统一错误码');
    assert.strictEqual(fakeAiRequests.length, invalidDateStart, '非法日期不得请求上游');

    const invalidTimezoneStart = fakeAiRequests.length;
    const unsupportedTimezone = await request('/api/ai/parse/deep', Object.assign({}, autoDeepSample, { businessTimezone: 'UTC' }));
    assert.strictEqual(unsupportedTimezone.statusCode, 400, '不支持的业务时区必须在请求provider前返回400');
    assert.strictEqual(unsupportedTimezone.body.error, 'UNSUPPORTED_BUSINESS_TIMEZONE', '非法时区必须保留统一错误码');
    assert.strictEqual(fakeAiRequests.length, invalidTimezoneStart, '非法时区不得请求上游');

    assert(standardRequests[0].messages[0].content.includes('2026-07-22'), 'standard prompt必须使用请求业务日期');
    assert(trustedDeepRequests[0].messages[0].content.includes('2026-07-22'), 'trusted deep prompt必须使用同一业务日期');
    console.log('服务端识别路由测试通过：/deep不是权限，只有服务端重验的AUTO_DEEP可使用quality。');
  } finally {
    stopServer();
  }
}

main().catch((error) => {
  stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});
