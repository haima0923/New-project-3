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
      AI_FAST_MODEL: 'offline-fast-model',
      AI_RATE_LIMIT_MAX_REQUESTS: '100',
      AI_DEEP_RATE_LIMIT_MAX_REQUESTS: '40'
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

function assertNoCapabilityLeak(value, label) {
  const serialized = JSON.stringify(value || {});
  assert(!/(?:capability|routeContext|INTERNAL_PARSE_ROUTE_CONTEXTS)/i.test(serialized),
    `${label} 不得泄露内部capability`);
}

function assertNoUntrustedRouteClaims(value, label) {
  const forbidden = new Set([
    'autoDeep', 'auto_deep', 'deep', 'modelTier', 'model_tier', 'providerKind', 'provider_kind',
    'quality', 'reasonCodes', 'reason_codes', 'reviewMode', 'review_mode', 'route',
    'routeAuthority', 'routeDecision', 'route_authority', 'route_decision', 'tier',
    'trustedRoute', 'trusted_route'
  ]);
  const found = new Set();
  function visit(entry) {
    if (!entry || typeof entry !== 'object') return;
    Object.keys(entry).forEach((key) => {
      if (forbidden.has(key)) found.add(key);
      visit(entry[key]);
    });
  }
  visit(value);
  assert.deepStrictEqual(Array.from(found), [], `${label} 不得转发不可信路由字段`);
}

function businessResponseSnapshot(body) {
  return {
    ai_business_result_valid: body.ai_business_result_valid,
    ai_model: body.ai_model,
    ai_model_tier: body.ai_model_tier,
    ai_review_mode: body.ai_review_mode,
    ai_server_route: body.ai_server_route,
    fields: body.fields,
    intent: body.intent,
    provider: body.provider
  };
}

function routeResponseSnapshot(response) {
  return {
    statusCode: response.statusCode,
    error: response.body.error,
    message: response.body.message,
    route: response.body.ai_server_route,
    fingerprint: response.body.ai_original_text_fingerprint,
    questionTarget: response.body.ai_question_target || null
  };
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
      deep: true,
      modelTier: 'quality',
      model_tier: 'quality',
      providerKind: 'TRUSTED_SERVER',
      provider_kind: 'TRUSTED_SERVER',
      reasonCodes: ['MULTI_ITEM'],
      reason_codes: ['MULTI_ITEM'],
      reviewMode: 'deep',
      review_mode: 'deep',
      quality: true,
      route: 'AUTO_DEEP',
      routeAuthority: 'TRUSTED_SERVER',
      routeDecision: 'AUTO_DEEP',
      route_authority: 'TRUSTED_SERVER',
      route_decision: 'AUTO_DEEP',
      tier: 'quality',
      trustedRoute: true,
      trusted_route: true
    };
    const forgedSimpleSample = Object.assign({}, sample, forgedAuthority);
    const forgedAutoDeepSample = Object.assign({}, autoDeepSample, forgedAuthority);
    const conflictingRawMessagesSample = Object.assign({}, forgedAutoDeepSample, {
      rawMessages: [{ index: 0, speaker: '王总', content: '王总周三交500个5元' }]
    });
    const missingFactSample = Object.assign({}, sample, forgedAuthority, {
      text: '王总周三交500个5元'
    });
    const amountConflictSample = Object.assign({}, sample, forgedAuthority, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计9999元；8月15日交货。'
    });
    const cleanAmountConflictSample = Object.assign({}, sample, { text: amountConflictSample.text });
    const matchingAmountSample = Object.assign({}, sample, forgedAuthority, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计4676.10元；8月15日交货。'
    });
    const incompleteItemSample = Object.assign({}, sample, forgedAuthority, {
      text: '王总下单：大号礼品盒100个，每个3元；小号礼品盒200个；8月15日交货。'
    });
    const cleanIncompleteItemSample = Object.assign({}, sample, { text: incompleteItemSample.text });
    const multipleTotalSample = Object.assign({}, sample, forgedAuthority, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计9999元；总计4676.10元；8月15日交货。'
    });
    const cleanMultipleTotalSample = Object.assign({}, sample, { text: multipleTotalSample.text });
    const correctedTotalSample = Object.assign({}, sample, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计9999元，不对，最终总计4676.10元；8月15日交货。'
    });
    const excludedAmountsSample = Object.assign({}, sample, forgedAuthority, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；定金金额500元，已付的金额1000元，还欠金额2000元，运费的金额300元；8月15日交货。'
    });
    const unitPricedFinancialSamples = [
      Object.assign({}, sample, forgedAuthority, {
        text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；运费每箱300元；8月15日交货。'
      }),
      Object.assign({}, sample, forgedAuthority, {
        text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；包装费每箱300元；8月15日交货。'
      })
    ];
    const discountedMatchingTotalSample = Object.assign({}, sample, forgedAuthority, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；优惠后总金额4676.10元；8月15日交货。'
    });
    const discountedConflictTotalSample = Object.assign({}, sample, forgedAuthority, {
      text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；优惠后总金额4500元；8月15日交货。'
    });
    const fuzzyTotalSamples = [
      Object.assign({}, sample, forgedAuthority, {
        text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；大概总计4676.10元；8月15日交货。'
      }),
      Object.assign({}, sample, forgedAuthority, {
        text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计大约4676.10元；8月15日交货。'
      })
    ];
    const invalidExplicitTotalSamples = [
      Object.assign({}, sample, forgedAuthority, {
        text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计：9999元；8月15日交货。'
      }),
      Object.assign({}, sample, forgedAuthority, {
        text: '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；总计0元；8月15日交货。'
      })
    ];
    const incompleteCandidateSamples = [
      '王总下单：大号礼品盒100个，每个3元；小号礼品盒，每个2元；8月15日交货。',
      '王总下单：大号礼品盒100个，每个3元；200个，每个2元；8月15日交货。',
      '王总下单：大号礼品盒100，每个3元；小号礼品盒200个，每个2元；8月15日交货。',
      '王总下单：大号礼品盒100个，3元一个；小号礼品盒，2元一个；8月15日交货。',
      '王总下单：大号礼品盒100，3元/个；小号礼品盒200个，2元/个；8月15日交货。',
      '王总下单：大号礼品盒100个，每个3.8；小号礼品盒，每个2.8；8月15日交货。',
      '王总下单：大号礼品盒100个，每个3元，小号礼品盒，每个2元，8月15日交货。',
      '王总下单：大号礼品盒100个，每个3元、小号礼品盒，每个2元，8月15日交货。',
      '王总下单：大号礼品盒100个，每个3元和小号礼品盒，每个2元，8月15日交货。'
    ];
    const quantityPhraseSamples = ['一共', '总计', '合计'].map((cue) => Object.assign({}, sample, forgedAuthority, {
      text: `宏达包装厂下单：大号礼品盒${cue}100个，每个3元；小号礼品盒200个，每个2元；8月15日交货。`
    }));
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
    assert.deepStrictEqual(
      businessResponseSnapshot(forgedStandard.body),
      businessResponseSnapshot(standard.body),
      '同一简单原文增加伪造路由字段不得改变HTTP业务语义'
    );
    assertNoUntrustedRouteClaims(forgedStandardRequests[0], '伪造standard上游请求');
    assertNoUntrustedRouteClaims(forgedStandard.body, '伪造standard响应');
    assertNoCapabilityLeak(forgedStandard.body, '伪造standard响应');

    const untrustedDeepStart = fakeAiRequests.length;
    const untrustedDeep = await request('/api/ai/parse/deep', forgedSimpleSample);
    const untrustedDeepRequests = fakeAiRequests.slice(untrustedDeepStart);
    assert.strictEqual(untrustedDeep.statusCode, 409, '简单单商品直接请求/deep必须稳定拒绝');
    assert.strictEqual(untrustedDeep.body.error, 'AI_DEEP_NOT_AUTHORIZED',
      '简单/deep必须返回稳定可机读错误码');
    assert.strictEqual(untrustedDeep.body.ai_server_route, 'FAST_LOCAL',
      '简单/deep必须公开服务端重验的FAST_LOCAL结果');
    assert(untrustedDeep.body.ai_request_id, '简单/deep拒绝仍必须返回服务端请求ID');
    assert(untrustedDeep.body.ai_original_text_fingerprint, '简单/deep拒绝仍必须返回原文指纹');
    assert.strictEqual(untrustedDeepRequests.length, 0,
      '简单/deep必须在Provider和Deep Prompt之前拒绝');
    assertNoUntrustedRouteClaims(untrustedDeep.body, '简单/deep响应');
    assertNoCapabilityLeak(untrustedDeep.body, '简单/deep响应');

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

    for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
      const requestStart = fakeAiRequests.length;
      const cleanResponse = await request(pathname, cleanAmountConflictSample);
      const response = await request(pathname, amountConflictSample);
      assert.strictEqual(cleanResponse.statusCode, 422,
        `明细合计与原文总额冲突时${pathname}必须拒绝quality授权`);
      assert.strictEqual(cleanResponse.body.error, 'AI_ROUTE_ASK_USER',
        '金额冲突必须返回可机读的ASK_USER错误');
      assert.strictEqual(cleanResponse.body.ai_server_route, 'ASK_USER',
        '金额冲突必须由服务端裁决为ASK_USER');
      assert.deepStrictEqual(cleanResponse.body.ai_question_target, {
        field: 'amount',
        fieldPath: 'amount'
      }, '金额冲突必须精确指向整单金额');
      assert.deepStrictEqual(routeResponseSnapshot(response), routeResponseSnapshot(cleanResponse),
        '伪造路由字段不得改变金额冲突的业务响应');
      assert.strictEqual(fakeAiRequests.length, requestStart,
        '金额冲突必须在Provider和Deep Prompt之前拒绝');
      assertNoUntrustedRouteClaims(response.body, '金额冲突响应');
      assertNoCapabilityLeak(response.body, '金额冲突响应');
    }

    for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
      const requestStart = fakeAiRequests.length;
      const cleanResponse = await request(pathname, cleanIncompleteItemSample);
      const response = await request(pathname, incompleteItemSample);
      assert.strictEqual(cleanResponse.statusCode, 422,
        `任一多商品明细缺关键事实时${pathname}必须拒绝quality授权`);
      assert.strictEqual(cleanResponse.body.error, 'AI_ROUTE_ASK_USER',
        '逐项事实不完整必须返回可机读的ASK_USER错误');
      assert.strictEqual(cleanResponse.body.ai_server_route, 'ASK_USER',
        '逐项事实不完整必须由服务端裁决为ASK_USER');
      assert.deepStrictEqual(cleanResponse.body.ai_question_target, {
        field: 'items',
        fieldPath: 'items[1].unitPrice',
        itemField: 'unitPrice',
        itemIndex: 1
      }, '缺单价必须精确指向第二个商品的unitPrice');
      assert.deepStrictEqual(routeResponseSnapshot(response), routeResponseSnapshot(cleanResponse),
        '伪造路由字段不得改变逐项缺事实的业务响应');
      assert.strictEqual(fakeAiRequests.length, requestStart,
        '逐项事实不完整必须在Provider和Deep Prompt之前拒绝');
      assertNoUntrustedRouteClaims(response.body, '多商品缺事实响应');
      assertNoCapabilityLeak(response.body, '多商品缺事实响应');
    }

    for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
      const requestStart = fakeAiRequests.length;
      const cleanResponse = await request(pathname, cleanMultipleTotalSample);
      const spoofedResponse = await request(pathname, multipleTotalSample);
      assert.strictEqual(cleanResponse.statusCode, 422,
        '多个不一致整单总额必须fail-closed为ASK_USER');
      assert.strictEqual(cleanResponse.body.error, 'AI_ROUTE_ASK_USER');
      assert.strictEqual(cleanResponse.body.ai_server_route, 'ASK_USER');
      assert.deepStrictEqual(routeResponseSnapshot(spoofedResponse), routeResponseSnapshot(cleanResponse),
        '伪造路由字段不得从多总额冲突中获得quality');
      assert.strictEqual(fakeAiRequests.length, requestStart,
        '多个总额无法唯一裁决时Provider必须为0');
    }

    for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
      const requestStart = fakeAiRequests.length;
      const correctedTotal = await request(pathname, correctedTotalSample);
      assert.strictEqual(correctedTotal.statusCode, 422,
        '服务端尚未冻结总额纠错语法时必须fail-closed');
      assert.strictEqual(correctedTotal.body.error, 'AI_ROUTE_ASK_USER');
      assert.strictEqual(fakeAiRequests.length, requestStart,
        '不得猜测最后一个总额就是真值');
    }

    const excludedAmountsStart = fakeAiRequests.length;
    const excludedAmounts = await request('/api/ai/parse', excludedAmountsSample);
    assert.strictEqual(excludedAmounts.statusCode, 409,
      '单价、定金、已付、欠款和运费不得冒充整单总额');
    assert.strictEqual(excludedAmounts.body.error, 'AI_DEEP_REQUIRED');
    assert.strictEqual(excludedAmounts.body.ai_server_route, 'AUTO_DEEP');
    assert.strictEqual(fakeAiRequests.length, excludedAmountsStart,
      '排除型金额样例的/parse不得自动请求Provider');

    for (const payload of unitPricedFinancialSamples) {
      const requestStart = fakeAiRequests.length;
      const response = await request('/api/ai/parse', payload);
      assert.strictEqual(response.statusCode, 409,
        '按箱计价的运费或包装费不得冒充商品候选');
      assert.strictEqual(response.body.error, 'AI_DEEP_REQUIRED');
      assert.strictEqual(response.body.ai_server_route, 'AUTO_DEEP');
      assert.strictEqual(fakeAiRequests.length, requestStart,
        '排除按单位计价财务金额后，/parse仍不得自动请求Provider');
    }

    const discountedMatchingStart = fakeAiRequests.length;
    const discountedMatching = await request('/api/ai/parse', discountedMatchingTotalSample);
    assert.strictEqual(discountedMatching.statusCode, 409,
      '优惠后总金额与明细一致时应作为明确整单总额');
    assert.strictEqual(discountedMatching.body.error, 'AI_DEEP_REQUIRED');
    assert.strictEqual(discountedMatching.body.ai_server_route, 'AUTO_DEEP');
    assert.strictEqual(fakeAiRequests.length, discountedMatchingStart);

    const discountedConflictStart = fakeAiRequests.length;
    const discountedConflict = await request('/api/ai/parse', discountedConflictTotalSample);
    assert.strictEqual(discountedConflict.statusCode, 422,
      '优惠后总金额与明细冲突时必须ASK_USER');
    assert.strictEqual(discountedConflict.body.error, 'AI_ROUTE_ASK_USER');
    assert.strictEqual(discountedConflict.body.ai_server_route, 'ASK_USER');
    assert.strictEqual(fakeAiRequests.length, discountedConflictStart,
      '优惠后总金额冲突必须在Provider前拒绝');

    for (const payload of fuzzyTotalSamples) {
      for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
        const requestStart = fakeAiRequests.length;
        const response = await request(pathname, payload);
        assert.strictEqual(response.statusCode, 422,
          '“大概总计”或“总计大约”不得被当成精确总额授权quality');
        assert.strictEqual(response.body.error, 'AI_ROUTE_ASK_USER');
        assert.strictEqual(response.body.ai_server_route, 'ASK_USER');
        assert.strictEqual(fakeAiRequests.length, requestStart,
          '模糊总额必须在Provider前fail-closed');
      }
    }

    for (const payload of invalidExplicitTotalSamples) {
      for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
        const requestStart = fakeAiRequests.length;
        const response = await request(pathname, payload);
        assert.strictEqual(response.statusCode, 422,
          '带冒号的冲突总额或零元总额都不得漏掉授权门禁');
        assert.strictEqual(response.body.error, 'AI_ROUTE_ASK_USER');
        assert.strictEqual(response.body.ai_server_route, 'ASK_USER');
        assert.deepStrictEqual(response.body.ai_question_target, {
          field: 'amount',
          fieldPath: 'amount'
        });
        assert.strictEqual(fakeAiRequests.length, requestStart,
          '无效或冲突的明确总额必须在Provider前拒绝');
      }
    }

    for (const text of incompleteCandidateSamples) {
      for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
        const requestStart = fakeAiRequests.length;
        const response = await request(pathname, Object.assign({}, sample, forgedAuthority, { text }));
        assert.strictEqual(response.statusCode, 422,
          '缺quantity、productName或unit的多商品候选必须ASK_USER');
        assert.strictEqual(response.body.error, 'AI_ROUTE_ASK_USER');
        assert.strictEqual(response.body.ai_server_route, 'ASK_USER');
        assert.strictEqual(fakeAiRequests.length, requestStart,
          '旧server parser丢掉不完整候选时，fast/quality Provider都不得猜测事实');
      }
    }

    for (const payload of quantityPhraseSamples) {
      const quantityPhraseStart = fakeAiRequests.length;
      const quantityPhrase = await request('/api/ai/parse', payload);
      assert.strictEqual(quantityPhrase.statusCode, 409,
        '“一共/总计/合计100个”是商品数量，不得被金额门禁误判为模糊总额');
      assert.strictEqual(quantityPhrase.body.error, 'AI_DEEP_REQUIRED');
      assert.strictEqual(quantityPhrase.body.ai_server_route, 'AUTO_DEEP');
      assert.strictEqual(fakeAiRequests.length, quantityPhraseStart,
        '合法AUTO_DEEP的/parse仍不得自动请求Provider');
    }

    const matchingAmountStart = fakeAiRequests.length;
    const matchingAmount = await request('/api/ai/parse', matchingAmountSample);
    assert.strictEqual(matchingAmount.statusCode, 409,
      '原文总额与完整明细合计一致时不得误伤合法AUTO_DEEP');
    assert.strictEqual(matchingAmount.body.error, 'AI_DEEP_REQUIRED');
    assert.strictEqual(matchingAmount.body.ai_server_route, 'AUTO_DEEP');
    assert.strictEqual(fakeAiRequests.length, matchingAmountStart,
      '合法AUTO_DEEP的/parse仍不得自动请求Provider');

    const deepRequiredStart = fakeAiRequests.length;
    const deepRequired = await request('/api/ai/parse', forgedAutoDeepSample);
    const deepRequiredRequests = fakeAiRequests.slice(deepRequiredStart);
    assert.strictEqual(deepRequired.statusCode, 409,
      '完整多商品通过/parse必须稳定要求可信Deep入口');
    assert.strictEqual(deepRequired.body.error, 'AI_DEEP_REQUIRED',
      '完整多商品/parse必须返回客户端可机读的Deep错误码');
    assert.strictEqual(deepRequired.body.ai_server_route, 'AUTO_DEEP',
      '完整多商品/parse必须公开服务端重验的AUTO_DEEP');
    assert(deepRequired.body.ai_request_id, '完整多商品/parse拒绝必须返回服务端请求ID');
    assert(deepRequired.body.ai_original_text_fingerprint,
      '完整多商品/parse拒绝必须返回原文指纹');
    assert.strictEqual(deepRequiredRequests.length, 0,
      '完整多商品/parse不得自动递归请求Deep或调用Provider');
    assertNoUntrustedRouteClaims(deepRequired.body, '完整多商品/parse响应');
    assertNoCapabilityLeak(deepRequired.body, '完整多商品/parse响应');

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
    assertNoUntrustedRouteClaims(trustedDeepRequests[0], '可信Deep上游请求');
    assertNoUntrustedRouteClaims(deep.body, '可信Deep响应');
    assertNoCapabilityLeak(deep.body, '可信Deep响应');

    for (const pathname of ['/api/ai/parse', '/api/ai/parse/deep']) {
      const requestStart = fakeAiRequests.length;
      const conflictingRawMessages = await request(pathname, conflictingRawMessagesSample);
      assert.strictEqual(conflictingRawMessages.statusCode, 422,
        'rawMessages与text不同时必须按模型真实优先读取的rawMessages重验事实');
      assert.strictEqual(conflictingRawMessages.body.error, 'AI_ROUTE_ASK_USER');
      assert.strictEqual(conflictingRawMessages.body.ai_server_route, 'ASK_USER');
      assert.strictEqual(fakeAiRequests.length, requestStart,
        '未经capability指纹绑定的rawMessages不得进入quality Provider');
      assertNoCapabilityLeak(conflictingRawMessages.body, 'rawMessages不一致响应');
    }

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
