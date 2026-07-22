#!/usr/bin/env node

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FLOW_MODES,
  PRODUCTION_ROUTES,
  PROVIDER_KINDS
} = require('../utils/record-flow-contract');
const {
  createFakeAiAdapter,
  createNoAiAdapter,
  runRecordFlow
} = require('../utils/record-flow-core');
const { createExistingHybridAiAdapter } = require('../utils/record-flow-ai-adapters');
const {
  DEFAULT_BUSINESS_TIMEZONE,
  businessDateFromInstant
} = require('../utils/record-flow-runtime');
const { parseInput } = require('../utils/parser');
const { buildAiRequestPayload, parseHybridInput } = require('../utils/ai-parser');
const { applyFinalParseSafety } = require('../utils/parse-safety');
const { parseWithAi } = require('../server/src/ai/model');
const releaseCorpusFixture = require('../test-fixtures/release-parse-corpus-v2');

delete global.wx;

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function fixedClock(instant) {
  return {
    source: 'FIXED_TEST',
    now() {
      return new Date(instant);
    }
  };
}

function steppingClock(instants) {
  let index = 0;
  return {
    source: 'FIXED_TEST',
    now() {
      const value = instants[Math.min(index, instants.length - 1)];
      index += 1;
      return new Date(value);
    },
    getCallCount() {
      return index;
    }
  };
}

function sequenceIdGenerator(prefix = 'phase1b') {
  let sequence = 0;
  return {
    source: 'FIXED_TEST',
    next(scope) {
      sequence += 1;
      return `${prefix}-${scope}-${sequence}`;
    }
  };
}

function mappedIdGenerator(values) {
  const calls = [];
  return {
    source: 'FIXED_TEST',
    next(scope) {
      calls.push(scope);
      const value = values[scope];
      return typeof value === 'function' ? value(calls.filter((item) => item === scope).length) : value;
    },
    getCalls() {
      return calls.slice();
    }
  };
}

async function withFakeWechatTransport(handler, run) {
  const oldWx = global.wx;
  const oldGetApp = global.getApp;
  global.getApp = () => ({ globalData: {
    apiBaseUrl: 'https://phase1b-offline.invalid',
    aiAuthEnabled: false,
    aiParseEndpoint: '/api/ai/parse'
  } });
  global.wx = {
    request(options) {
      handler(options);
    }
  };
  try {
    return await run();
  } finally {
    if (oldWx === undefined) delete global.wx;
    else global.wx = oldWx;
    if (oldGetApp === undefined) delete global.getApp;
    else global.getApp = oldGetApp;
  }
}

function baseInput(originalText, overrides = {}) {
  return Object.assign({
    mode: FLOW_MODES.PRODUCTION_ROUTING,
    originalText,
    inputSource: 'typed',
    context: 'home',
    reviewMode: 'standard',
    initialState: {}
  }, overrides);
}

function dependencies(overrides = {}) {
  return Object.assign({
    clock: fixedClock('2026-07-22T02:30:00.000Z'),
    idGenerator: sequenceIdGenerator(),
    aiAdapter: createNoAiAdapter()
  }, overrides);
}

function completeAiOrder(fields = {}) {
  return {
    intent: 'order',
    fields: Object.assign({
      customerName: '王总',
      productName: '水悲',
      quantity: '5',
      unit: '个',
      unitPrice: '5.5',
      priceUnit: '个',
      dueDate: '2026-07-23',
      remark: 'PHASE1B_AI_UNIQUE'
    }, fields),
    field_evidence: {
      customerName: ['王总'],
      productName: ['水悲'],
      quantity: ['5个'],
      unitPrice: ['五块五'],
      dueDate: ['明天']
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  };
}

async function runLocalDate(text, businessDate) {
  return runRecordFlow(baseInput(text, { businessDate }), dependencies());
}

async function timezoneProbe() {
  const output = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，明天交', {
    nowInstant: '2026-07-21T16:30:00.000Z'
  }), dependencies({
    clock: fixedClock('2026-07-21T16:30:00.000Z')
  }));
  process.stdout.write(JSON.stringify({
    businessDate: output.trace.runtime.businessDate,
    dueDate: output.result.fields.dueDate,
    route: output.trace.routing.productionRoute
  }));
}

test('默认业务时区固定为Asia/Shanghai且不取机器本地日期', async () => {
  const output = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，明天交'), dependencies({
    clock: fixedClock('2026-07-21T16:30:00.000Z')
  }));
  assert.strictEqual(output.trace.runtime.businessTimezone, DEFAULT_BUSINESS_TIMEZONE);
  assert.strictEqual(output.trace.runtime.businessDate, '2026-07-22');
  assert.strictEqual(output.trace.runtime.nowInstant, '2026-07-21T16:30:00.000Z');
  assert.strictEqual(output.trace.runtime.nowInstantResolved, true);
  assert.strictEqual(output.result.fields.dueDate, '2026-07-23');
});

test('UTC和洛杉矶系统时区下相同注入时刻得到同一结果', () => {
  const runs = ['UTC', 'America/Los_Angeles'].map((timezone) => {
    const stdout = execFileSync(process.execPath, [__filename, '--timezone-probe'], {
      cwd: process.cwd(),
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', TZ: timezone }),
      encoding: 'utf8'
    });
    return JSON.parse(stdout);
  });
  assert.deepStrictEqual(runs[0], runs[1]);
  assert.deepStrictEqual(runs[0], {
    businessDate: '2026-07-22',
    dueDate: '2026-07-23',
    route: PRODUCTION_ROUTES.LOCAL
  });
});

test('显式businessDate决定明天且跨年稳定', async () => {
  const july = await runLocalDate('王总订礼品盒500个，单价3.8元，明天交', '2026-07-22');
  const yearEnd = await runLocalDate('王总订礼品盒500个，单价3.8元，明天交', '2026-12-31');
  assert.strictEqual(july.result.fields.dueDate, '2026-07-23');
  assert.strictEqual(yearEnd.result.fields.dueDate, '2027-01-01');
  assert.strictEqual(july.trace.runtime.nowInstant, null);
  assert.strictEqual(july.trace.runtime.nowInstantResolved, false);
});

test('跨午夜两次运行分别固定各自业务日期且单次运行不漂移', async () => {
  const before = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，明天交', {
    nowInstant: '2026-07-22T15:59:59.000Z'
  }), dependencies({ clock: fixedClock('2026-07-22T15:59:59.000Z') }));
  const after = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，明天交', {
    nowInstant: '2026-07-22T16:00:01.000Z'
  }), dependencies({ clock: fixedClock('2026-07-22T16:00:01.000Z') }));
  assert.strictEqual(before.trace.runtime.businessDate, '2026-07-22');
  assert.strictEqual(before.result.fields.dueDate, '2026-07-23');
  assert.strictEqual(after.trace.runtime.businessDate, '2026-07-23');
  assert.strictEqual(after.result.fields.dueDate, '2026-07-24');
});

test('上海零点与UTC前一天不会混用', async () => {
  let capturedRequest;
  const adapter = createFakeAiAdapter((request) => {
    capturedRequest = request;
    return completeAiOrder({ dueDate: '明天' });
  });
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice',
    nowInstant: '2026-07-21T16:30:00.000Z'
  }), dependencies({
    clock: fixedClock('2026-07-21T16:30:00.000Z'),
    aiAdapter: adapter
  }));
  assert.strictEqual(output.trace.runtime.businessDate, '2026-07-22');
  assert.strictEqual(output.trace.local.result.fields.dueDate, '2026-07-23');
  assert.strictEqual(capturedRequest.businessDate, '2026-07-22');
  assert.strictEqual(capturedRequest.businessTimezone, 'Asia/Shanghai');
  assert.strictEqual(capturedRequest.nowInstant, '2026-07-21T16:30:00.000Z');
  assert.strictEqual(output.result.fields.dueDate, '2026-07-23');
});

test('下周五、本月底、下月底和三天后冻结当前日期语义', async () => {
  const cases = [
    ['下周五', '2026-07-31'],
    ['本月底', '2026-07-31'],
    // 当前parser把“下月底”中的“月底”按本月末处理；Phase 1B只冻结参考日，
    // 不借时间注入改写这一产品语义。
    ['下月底', '2026-07-31'],
    ['三天后', '2026-07-25']
  ];
  for (const [phrase, expected] of cases) {
    const output = await runLocalDate(`王总订礼品盒500个，单价3.8元，${phrase}交`, '2026-07-22');
    assert.strictEqual(output.result.fields.dueDate, expected, phrase);
  }
});

test('非法日期、时区、时刻和日期冲突均fail closed', async () => {
  const cases = [
    [{ businessDate: '2026-02-30' }, 'INVALID_BUSINESS_DATE'],
    [{ businessTimezone: 'UTC' }, 'UNSUPPORTED_BUSINESS_TIMEZONE'],
    [{ nowInstant: '2026-07-22' }, 'INVALID_NOW_INSTANT'],
    [{ businessDate: '2026-07-22', nowInstant: '2026-07-21T10:00:00.000Z' }, 'BUSINESS_DATE_MISMATCH']
  ];
  for (const [runtimeInput, expectedCode] of cases) {
    const output = await runRecordFlow(baseInput('明天提醒我催王总', runtimeInput), dependencies());
    assert.strictEqual(output.result, null);
    assert.strictEqual(output.errors[0].code, expectedCode);
    assert.strictEqual(output.saveEligibility.allowed, false);
  }
});

test('clock无效时不会降级系统时间继续解析', async () => {
  const output = await runRecordFlow(baseInput('明天提醒我催王总'), dependencies({
    clock: { source: 'FIXED_TEST', now() { return 'not-a-date'; } }
  }));
  assert.strictEqual(output.errors[0].code, 'CLOCK_INVALID_RESULT');
  assert.strictEqual(output.result, null);
  assert.strictEqual(output.trace.runtime.clockSource, 'FIXED_TEST');
  assert.strictEqual(output.trace.timing.startedAt, null);
});

test('空ID和本次运行重复ID均明确失败', async () => {
  const empty = await runRecordFlow(baseInput('明天提醒我催王总', { businessDate: '2026-07-22' }), dependencies({
    idGenerator: mappedIdGenerator({ run: '', trace: 'trace-ok' })
  }));
  assert.strictEqual(empty.errors[0].code, 'ID_GENERATOR_INVALID_RESULT');
  const duplicate = await runRecordFlow(baseInput('明天提醒我催王总', { businessDate: '2026-07-22' }), dependencies({
    idGenerator: mappedIdGenerator({ run: 'duplicate-id', trace: 'duplicate-id' })
  }));
  assert.strictEqual(duplicate.errors[0].code, 'ID_GENERATOR_INVALID_RESULT');

  const adapter = createFakeAiAdapter(() => completeAiOrder());
  const duplicateRequest = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice',
    businessDate: '2026-07-22'
  }), dependencies({
    idGenerator: mappedIdGenerator({ run: 'run-duplicate', trace: 'trace-ok', ai_request: 'run-duplicate' }),
    aiAdapter: adapter
  }));
  assert.strictEqual(duplicateRequest.errors[0].code, 'ID_GENERATOR_INVALID_RESULT');
  assert.strictEqual(adapter.getCallCount(), 0);
  assert.strictEqual(duplicateRequest.saveEligibility.allowed, false);
});

test('固定runId、traceId和requestId贯穿trace与fake adapter', async () => {
  let captured;
  const adapter = createFakeAiAdapter((request) => {
    captured = request;
    return completeAiOrder();
  });
  const ids = mappedIdGenerator({
    run: 'fixed-run-id',
    trace: 'fixed-trace-id',
    ai_request: 'fixed-ai-request-id'
  });
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice',
    businessDate: '2026-07-22',
    caseId: 'phase1b-fixed-id-case'
  }), dependencies({ idGenerator: ids, aiAdapter: adapter }));
  assert.strictEqual(output.trace.runId, 'fixed-run-id');
  assert.strictEqual(output.trace.traceId, 'fixed-trace-id');
  assert.strictEqual(output.trace.caseId, 'phase1b-fixed-id-case');
  assert.strictEqual(output.trace.ai.requestId, 'fixed-ai-request-id');
  assert.strictEqual(captured.requestId, 'fixed-ai-request-id');
  assert.deepStrictEqual(captured.traceContext, {
    runId: 'fixed-run-id',
    traceId: 'fixed-trace-id',
    caseId: 'phase1b-fixed-id-case'
  });
  assert.strictEqual(output.trace.runtime.idGeneratorSource, 'FIXED_TEST');
  assert.deepStrictEqual(ids.getCalls(), ['run', 'trace', 'ai_request']);
});

test('同一顺序ID生成器跨两次run不会共享ID', async () => {
  const ids = sequenceIdGenerator('shared-sequence');
  const first = await runRecordFlow(baseInput('明天提醒我催王总', { businessDate: '2026-07-22' }), dependencies({ idGenerator: ids }));
  const second = await runRecordFlow(baseInput('后天提醒我催李总', { businessDate: '2026-07-22' }), dependencies({ idGenerator: ids }));
  assert.notStrictEqual(first.trace.runId, second.trace.runId);
  assert.notStrictEqual(first.trace.traceId, second.trace.traceId);
});

test('steppingClock统一计算总耗时和阶段耗时', async () => {
  const start = Date.parse('2026-07-22T02:30:00.000Z');
  const instants = Array.from({ length: 16 }, (_, index) => new Date(start + index * 10).toISOString());
  const clock = steppingClock(instants);
  const output = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，明天交'), dependencies({ clock }));
  assert.strictEqual(output.trace.timing.latencyMs, 110);
  assert.strictEqual(output.trace.timing.stages.input.latencyMs, 10);
  assert.strictEqual(output.trace.timing.stages.local.latencyMs, 10);
  assert.strictEqual(output.trace.timing.stages.routing.latencyMs, 10);
  assert.strictEqual(output.trace.timing.stages.final.latencyMs, 10);
  assert.strictEqual(output.trace.timing.finishedAt, instants[11]);
  assert.strictEqual(clock.getCallCount(), 12);
});

test('clock倒退时耗时不为负并记录CLOCK_MOVED_BACKWARD', async () => {
  const base = Date.parse('2026-07-22T02:30:00.000Z');
  const offsets = [0, 10, 5, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const clock = steppingClock(offsets.map((offset) => new Date(base + offset).toISOString()));
  const output = await runRecordFlow(baseInput('王总订礼品盒500个，单价3.8元，明天交'), dependencies({ clock }));
  assert.strictEqual(output.trace.timing.stages.input.latencyMs, 0);
  assert(output.trace.warnings.some((warning) => warning.code === 'CLOCK_MOVED_BACKWARD' && warning.stage === 'input'));
  assert(Object.values(output.trace.timing.stages).every((stage) => stage.latencyMs === null || stage.latencyMs >= 0));
});

test('AI相对日期标准化使用同一businessDate', async () => {
  const adapter = createFakeAiAdapter(() => completeAiOrder({ dueDate: '明天' }));
  const output = await runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice',
    businessDate: '2026-12-31'
  }), dependencies({ aiAdapter: adapter }));
  assert.strictEqual(output.result.fields.dueDate, '2027-01-01');
});

test('旧公开调用不传新时间参数时非日期字段和route保持兼容', async () => {
  const input = baseInput('提醒我催王总');
  delete input.businessDate;
  delete input.businessTimezone;
  const oldResult = applyFinalParseSafety(await parseHybridInput({
    text: input.originalText,
    rawText: input.originalText,
    source: 'typed',
    context: 'home',
    reviewMode: 'standard',
    state: {}
  }));
  const output = await runRecordFlow(input, dependencies());
  assert.strictEqual(output.result.intent, oldResult.intent);
  assert.strictEqual(output.result.operation, oldResult.operation);
  assert.deepStrictEqual(output.result.fields.customerName, oldResult.fields.customerName);
  assert.strictEqual(output.result.parse_route.decision, oldResult.parse_route.decision);
  assert.strictEqual(output.saveEligibility.allowed, false);
});

test('parser兼容旧签名并可显式接收参考业务日期', () => {
  const legacy = parseInput({ text: '王总订礼品盒500个，单价3.8元', source: 'typed', context: 'home', state: {} });
  const fixed = parseInput({
    text: '王总订礼品盒500个，单价3.8元，明天交',
    source: 'typed',
    context: 'home',
    state: {},
    businessDate: '2026-07-22'
  });
  assert.strictEqual(legacy.intent, 'order');
  assert.strictEqual(fixed.fields.dueDate, '2026-07-23');
  assert.strictEqual(fixed.fields.quoteDate, '2026-07-22');
});

test('根目录与server遗留parser/date/safety/runtime镜像保持逐字同步', () => {
  ['parser.js', 'date.js', 'parse-safety.js', 'record-flow-runtime.js'].forEach((file) => {
    const rootContent = fs.readFileSync(path.join(__dirname, '..', 'utils', file), 'utf8');
    const serverContent = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', file), 'utf8');
    assert.strictEqual(serverContent, rootContent, `${file} 镜像必须同步，不能形成第三套日期规则`);
  });
});

test('1490题正式fixture固定业务日期和时区且题数不变', () => {
  assert.strictEqual(releaseCorpusFixture.corpus.length, 1490);
  assert.strictEqual(releaseCorpusFixture.REFERENCE_BUSINESS_DATE, '2026-07-22');
  assert.strictEqual(releaseCorpusFixture.BUSINESS_TIMEZONE, 'Asia/Shanghai');
  assert(releaseCorpusFixture.corpus.every((item) => (
    item.businessDate === '2026-07-22' && item.businessTimezone === 'Asia/Shanghai'
  )));
  const runnerSource = fs.readFileSync(path.join(__dirname, 'release-parse-corpus-v2.js'), 'utf8');
  assert(runnerSource.includes('businessDate: testCase.businessDate'));
  assert(runnerSource.includes('businessTimezone: testCase.businessTimezone'));
});

test('旧页面形态standard/deep请求省略空日期并由服务端上海clock补齐', async () => {
  const config = {
    aiProvider: 'offline-phase1b',
    aiApiKey: 'synthetic-key',
    aiBaseUrl: 'https://offline-phase1b.invalid',
    aiModel: 'offline-quality',
    aiFastModel: 'offline-fast',
    aiFastRequestTimeoutMs: 5200,
    aiQualityRequestTimeoutMs: 20000
  };
  const originalFetch = global.fetch;
  const prompts = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    prompts.push(body.messages[0].content);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(completeAiOrder()) } }] };
      }
    };
  };
  try {
    const localResult = parseInput({
      text: '王总订水杯5个，五块五一个，明天交',
      source: 'typed',
      context: 'home',
      state: {}
    });
    for (const reviewMode of ['standard', 'deep']) {
      const legacyPayload = buildAiRequestPayload({
        text: '王总订水杯5个，五块五一个，明天交',
        source: 'typed',
        context: 'home',
        reviewMode
      }, localResult, { found: false, customers: [], businessContext: {} });
      assert(!Object.prototype.hasOwnProperty.call(legacyPayload, 'businessDate'));
      assert.strictEqual(legacyPayload.businessTimezone, 'Asia/Shanghai');
      const result = await parseWithAi(config, legacyPayload, {
        clock: fixedClock('2026-07-21T16:30:00.000Z')
      });
      assert.strictEqual(result.intent, 'order');
    }
    assert.strictEqual(prompts.length, 2);
    assert(prompts.every((prompt) => prompt.includes('2026-07-22')));
    assert(prompts.every((prompt) => !prompt.includes('2026-07-21')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('旧parseHybridInput入口在standard/deep单次运行中固定同一业务时间', async () => {
  const captures = [];
  const cases = [
    {
      text: '王总要订5个水悲，五块五一个，明天交',
      rawText: '王总要订5个水悲，五块五一个，明天交',
      source: 'voice',
      context: 'home',
      reviewMode: 'standard',
      state: {}
    },
    {
      text: '王总水杯100个5块5一个，礼品盒200个3块一个，改成后天交',
      rawText: '王总水杯100个5块5一个，礼品盒200个3块一个，改成后天交',
      source: 'typed',
      context: 'home',
      reviewMode: 'deep',
      state: {}
    }
  ];
  await withFakeWechatTransport((options) => {
    captures.push(JSON.parse(JSON.stringify(options.data || {})));
    options.success({
      statusCode: 200,
      data: Object.assign({}, completeAiOrder(), { ai_request_id: `server-${captures.length}` })
    });
  }, async () => {
    for (const payload of cases) {
      await parseHybridInput(payload, {
        clock: fixedClock('2026-07-21T16:30:00.000Z')
      });
    }
  });
  assert.strictEqual(captures.length, 2);
  assert(captures.every((body) => body.businessDate === '2026-07-22'));
  assert(captures.every((body) => body.businessTimezone === 'Asia/Shanghai'));
  assert(captures.every((body) => body.nowInstant === '2026-07-21T16:30:00.000Z'));
});

test('core requestId与服务端serverRequestId在成功和HTTP失败时分开追踪', async () => {
  const successCapture = [];
  const ids = mappedIdGenerator({
    run: 'request-map-run',
    trace: 'request-map-trace',
    ai_request: 'client-ai-request'
  });
  const success = await withFakeWechatTransport((options) => {
    successCapture.push(JSON.parse(JSON.stringify(options.data || {})));
    options.success({
      statusCode: 200,
      data: Object.assign({}, completeAiOrder(), { ai_request_id: 'server-success-request' })
    });
  }, () => runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice'
  }), dependencies({
    idGenerator: ids,
    aiAdapter: createExistingHybridAiAdapter()
  })));
  assert.strictEqual(successCapture.length, 1);
  assert.strictEqual(successCapture[0].requestId, 'client-ai-request');
  assert.strictEqual(success.trace.ai.requestId, 'client-ai-request');
  assert.strictEqual(success.trace.ai.serverRequestId, 'server-success-request');
  assert.strictEqual(success.trace.ai.providerRequestId, '');

  const failure = await withFakeWechatTransport((options) => {
    options.success({
      statusCode: 422,
      data: { error: 'AI_RESPONSE_EMPTY_BUSINESS', ai_request_id: 'server-failure-request' }
    });
  }, () => runRecordFlow(baseInput('王总要订5个水悲，五块五一个，明天交', {
    inputSource: 'voice'
  }), dependencies({ aiAdapter: createExistingHybridAiAdapter() })));
  assert.strictEqual(failure.trace.ai.serverRequestId, 'server-failure-request');
  assert.strictEqual(failure.trace.ai.providerRequestId, '');
  assert.strictEqual(failure.trace.ai.outcome, 'EMPTY_BUSINESS_RESULT');
  assert.strictEqual(failure.saveEligibility.allowed, false);
});

test('server目录可独立复制并加载AI模型模块', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huoxiaoling-phase1b-server-'));
  const copiedServer = path.join(tempRoot, 'server');
  try {
    fs.cpSync(path.join(__dirname, '..', 'server'), copiedServer, { recursive: true });
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(copiedServer, 'src/ai/model.js'))});process.stdout.write('server-standalone-ok')`], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      stdio: 'pipe'
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('服务端standard和deep prompt共用注入日期且默认按上海日期', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const config = {
    aiProvider: 'offline-phase1b',
    aiApiKey: 'synthetic-offline-key',
    aiBaseUrl: 'http://127.0.0.1:9',
    aiModel: 'offline-quality',
    aiFastModel: 'offline-fast',
    aiFastRequestTimeoutMs: 5200,
    aiQualityRequestTimeoutMs: 20000
  };
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(completeAiOrder()) } }] };
      }
    };
  };
  try {
    const payload = {
      text: '王总订水杯5个，五块五一个，明天交',
      source: 'typed',
      businessDate: '2026-07-22',
      businessTimezone: 'Asia/Shanghai',
      nowInstant: '2026-07-22T02:30:00.000Z'
    };
    await parseWithAi(config, Object.assign({}, payload, { reviewMode: 'standard' }), {
      clock: fixedClock('2026-07-22T02:30:00.000Z')
    });
    await parseWithAi(config, Object.assign({}, payload, { reviewMode: 'deep' }), {
      clock: fixedClock('2026-07-22T02:30:00.000Z')
    });
    await parseWithAi(config, { text: payload.text, source: 'typed', reviewMode: 'standard' }, {
      clock: fixedClock('2026-07-21T16:30:00.000Z')
    });
    assert.strictEqual(calls.length, 3);
    assert(calls[0].messages[0].content.includes('2026-07-22'));
    assert(calls[1].messages[0].content.includes('2026-07-22'));
    assert(calls[2].messages[0].content.includes('2026-07-22'));
    assert(!calls.some((call) => call.messages[0].content.includes('2026-07-21')));
    await assert.rejects(
      () => parseWithAi(config, Object.assign({}, payload, { businessDate: '2026-02-30' }), {
        clock: fixedClock('2026-07-22T02:30:00.000Z')
      }),
      (error) => error && error.code === 'INVALID_BUSINESS_DATE'
    );
    assert.strictEqual(calls.length, 3, '非法日期必须在provider调用前拒绝');
  } finally {
    global.fetch = originalFetch;
  }
});

test('业务日期投影函数明确使用UTC+08合同', () => {
  assert.strictEqual(businessDateFromInstant('2026-07-21T16:00:01.000Z'), '2026-07-22');
  assert.strictEqual(businessDateFromInstant('2026-12-31T16:00:01.000Z'), '2027-01-01');
});

async function main() {
  let passed = 0;
  const failures = [];
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`PASS ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.error(`FAIL ${item.name}`);
      console.error(error.stack || error.message);
    }
  }
  console.log(`Phase 1B tests: ${passed}/${tests.length} passed`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv.includes('--timezone-probe')) {
  timezoneProbe().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
} else {
  main();
}
