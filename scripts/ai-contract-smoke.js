#!/usr/bin/env node

function modeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseMode(argv, env = process.env) {
  const allowed = new Set(['--offline', '--live-ai']);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length) {
    throw modeError('AI_SMOKE_ARGUMENT_ERROR', `Unknown argument: ${unknown.join(', ')}`);
  }
  const offline = argv.includes('--offline');
  const live = argv.includes('--live-ai');
  if (offline && live) {
    throw modeError(
      'AI_SMOKE_ARGUMENT_ERROR',
      'Choose exactly one mode: --offline or --live-ai'
    );
  }
  if (offline) {
    return {
      baseUrl: '',
      mode: 'OFFLINE_REPLAY'
    };
  }
  if (!live) {
    throw modeError(
      'AI_SMOKE_MODE_REQUIRED',
      'AI contract smoke is offline by default. Choose --offline, or use --live-ai with ALLOW_LIVE_AI_SMOKE=1.'
    );
  }
  if (env.ALLOW_LIVE_AI_SMOKE !== '1') {
    throw modeError(
      'LIVE_AI_DUAL_OPT_IN_REQUIRED',
      '--live-ai also requires ALLOW_LIVE_AI_SMOKE=1'
    );
  }
  const rawBaseUrl = String(env.API_BASE_URL || '').trim();
  if (!rawBaseUrl) {
    throw modeError(
      'LIVE_AI_ENDPOINT_REQUIRED',
      'Live AI smoke requires an explicit API_BASE_URL'
    );
  }
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch (error) {
    throw modeError('LIVE_AI_ENDPOINT_INVALID', 'API_BASE_URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw modeError(
      'LIVE_AI_ENDPOINT_INVALID',
      'API_BASE_URL must use HTTPS and must not contain URL credentials'
    );
  }
  return {
    baseUrl: rawBaseUrl.replace(/\/$/, ''),
    liveHost: parsed.hostname,
    mode: 'LIVE_EXPLICIT'
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function hasText(value, keyword) {
  return String(value || '').includes(keyword);
}

const businessContext = {
  recentCustomers: [
    { id: 'cus_ma', name: '马总', lastTradeAt: '2026-06-18' },
    { id: 'cus_wang', name: '王总', lastTradeAt: '2026-06-18' },
    { id: 'cus_li', name: '李总', lastTradeAt: '2026-06-18' },
    { id: 'cus_chen', name: '陈总', lastTradeAt: '2026-06-18' },
    { id: 'cus_liu', name: '刘总', lastTradeAt: '2026-06-18' },
    { id: 'cus_old_wang', name: '老王', lastTradeAt: '2026-06-18' }
  ],
  recentQuotations: [
    {
      id: 'quo_ma_1',
      customerId: 'cus_ma',
      customerName: '马总',
      productName: '杯垫',
      quantity: '300',
      unit: '个',
      unitPrice: '0.9',
      totalAmount: '270',
      quoteDate: '2026-06-10',
      status: '待确认'
    },
    {
      id: 'quo_wang_1',
      customerId: 'cus_wang',
      customerName: '王总',
      productName: '水杯',
      quantity: '500',
      unit: '个',
      unitPrice: '20',
      totalAmount: '10000',
      quoteDate: '2026-06-10',
      status: '待确认'
    }
  ],
  recentOrders: [],
  recentReceivables: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRequestJson(runtime) {
  if (runtime.mode === 'OFFLINE_REPLAY') {
    return async function requestOfflineReplay(path, data, replayFixture) {
      assert(
        path === '/api/ai/parse' || path === '/api/ai/query',
        `offline replay path is not allowlisted: ${path}`
      );
      assert(data && typeof data === 'object', `${path} offline request body is required`);
      assert(
        replayFixture && typeof replayFixture === 'object',
        `${path} offline replay fixture is required`
      );
      return clone(replayFixture);
    };
  }
  return async function requestLiveJson(path, data) {
    const response = await fetch(`${runtime.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      throw modeError(
        'LIVE_AI_RESPONSE_INVALID',
        `${path} returned a non-JSON response (body redacted)`
      );
    }
    if (!response.ok) {
      throw modeError(
        'LIVE_AI_HTTP_ERROR',
        `${path} failed with HTTP ${response.status} (body redacted)`
      );
    }
    return json;
  };
}

function parseReplayFixture(item) {
  return {
    fields: {
      amount: item.amount,
      customerName: item.customer,
      productName: item.product,
      quantity: item.quantity,
      unitPrice: item.unitPrice
    },
    intent: item.intent,
    low_confidence_fields: [],
    missing_fields: []
  };
}

function assertDirectPayload(name, payload) {
  assert(payload && typeof payload === 'object', `${name} response must be an object`);
  assert(!payload.data, `${name} response must not wrap payload in data`);
  assert(!payload.result, `${name} response must not wrap payload in result`);
}

async function testParse(requestJson) {
  const cases = [
    {
      text: '陈总欠我一万五，月底结',
      intent: 'receivable',
      customer: '陈',
      amount: 15000
    },
    {
      text: '刘总刚转了3000，还剩2000',
      intent: 'payment',
      customer: '刘',
      amount: 3000
    },
    {
      text: '马总 300个杯垫 三天后交 9毛一个',
      intent: 'order',
      customer: '马',
      product: '杯垫',
      quantity: 300,
      unitPrice: 0.9,
      amount: 270
    },
    {
      text: '李总一千个杯子五块五月底交',
      intent: 'order',
      customer: '李',
      product: '杯子',
      quantity: 1000,
      unitPrice: 5.5,
      amount: 5500
    },
    {
      text: '周老板下周一要发2000个钥匙扣一块二一个',
      intent: 'order',
      customer: '周',
      product: '钥匙扣',
      quantity: 2000,
      unitPrice: 1.2,
      amount: 2400
    },
    {
      text: '老王那边补500个老款杯垫，还是9毛，三天后给他',
      intent: 'order',
      customer: '老王',
      product: '老款杯垫',
      quantity: 500,
      unitPrice: 0.9,
      amount: 450
    },
    {
      text: '马总返单300个杯垫，价格跟上次一样，周六交',
      intent: 'order',
      customer: '马',
      product: '杯垫',
      quantity: 300,
      unitPrice: 0.9
    },
    {
      text: '李总样品确认了，先下1000个，5.5一个',
      intent: 'order',
      customer: '李',
      quantity: 1000,
      unitPrice: 5.5,
      amount: 5500
    },
    {
      text: '王总说先按上次报价做500个',
      intent: 'order',
      customer: '王',
      quantity: 500,
      unitPrice: 20
    },
    {
      text: '陈总这批货先记账，一共8600，月底给',
      intent: 'receivable',
      customer: '陈',
      amount: 8600
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const result = await requestJson('/api/ai/parse', {
      text: item.text,
      source: 'typed',
      context: 'home',
      customerCandidates: businessContext.recentCustomers,
      businessContext
    }, parseReplayFixture(item));

    assertDirectPayload(`parse ${index + 1}`, result);
    assert(result.intent === item.intent, `${item.text}: intent should be ${item.intent}, got ${result.intent}`);
    assert(result.fields && typeof result.fields === 'object', `${item.text}: fields is required`);
    if (item.customer) assert(hasText(result.fields.customerName, item.customer), `${item.text}: customerName should contain ${item.customer}, got ${result.fields.customerName}`);
    if (item.product) assert(hasText(result.fields.productName, item.product), `${item.text}: productName should contain ${item.product}, got ${result.fields.productName}`);
    if (item.quantity !== undefined) assert(asNumber(result.fields.quantity) === item.quantity, `${item.text}: quantity should be ${item.quantity}, got ${result.fields.quantity}`);
    if (item.unitPrice !== undefined) assert(Math.abs(asNumber(result.fields.unitPrice) - item.unitPrice) < 0.0001, `${item.text}: unitPrice should be ${item.unitPrice}, got ${result.fields.unitPrice}`);
    if (item.amount !== undefined) assert(Math.abs(asNumber(result.fields.amount) - item.amount) < 0.0001, `${item.text}: amount should be ${item.amount}, got ${result.fields.amount}`);
    assert(Array.isArray(result.missing_fields), `${item.text}: missing_fields must be an array`);
    assert(Array.isArray(result.low_confidence_fields), `${item.text}: low_confidence_fields must be an array`);
  }

  console.log('parse ok');
}

async function testParseContractShape(requestJson) {
  const result = await requestJson('/api/ai/parse', {
    text: '马总要300个杯垫，3天后交货，9毛钱一个',
    source: 'typed',
    context: 'home',
    customerCandidates: businessContext.recentCustomers,
    businessContext
  }, {
    fields: {
      amount: 270,
      customerName: '马总',
      productName: '杯垫',
      quantity: 300,
      unitPrice: 0.9
    },
    intent: 'order',
    low_confidence_fields: [],
    missing_fields: []
  });

  assertDirectPayload('parse', result);
  assert(result.intent === 'order', `parse intent should be order, got ${result.intent}`);
  assert(result.fields && typeof result.fields === 'object', 'parse fields is required');
  assert(hasText(result.fields.customerName, '马'), `customerName should contain 马, got ${result.fields.customerName}`);
  assert(hasText(result.fields.productName, '杯垫'), `productName should contain 杯垫, got ${result.fields.productName}`);
  assert(asNumber(result.fields.quantity) === 300, `quantity should be 300, got ${result.fields.quantity}`);
  assert(Math.abs(asNumber(result.fields.unitPrice) - 0.9) < 0.0001, `unitPrice should be 0.9, got ${result.fields.unitPrice}`);
  assert(Math.abs(asNumber(result.fields.amount) - 270) < 0.0001, `amount should be 270, got ${result.fields.amount}`);
  assert(Array.isArray(result.missing_fields), 'missing_fields must be an array');
  assert(Array.isArray(result.low_confidence_fields), 'low_confidence_fields must be an array');
  console.log('parse contract shape ok');
}

async function testQuery(requestJson) {
  const result = await requestJson('/api/ai/query', {
    question: '马总的单子现在怎么样了',
    state: {
      customers: [
        {
          id: 'cus_1',
          name: '马总',
          company: '',
          region: '',
          lastTradeAt: '2026-06-18'
        }
      ],
      orders: [
        {
          id: 'ord_1',
          customerId: 'cus_1',
          productName: '杯垫',
          quantity: '300',
          unit: '个',
          unitPrice: '0.9',
          totalAmount: '270',
          requiredDeliveryDate: '2026-06-21',
          status: '待生产',
          orderDate: '2026-06-18'
        }
      ],
      quotations: [],
      receivables: [],
      pendingNotes: [],
      paymentRecords: [],
      dunningRecords: [],
      orderProgress: []
    }
  }, {
    lines: ['马总有一笔杯垫订单，当前状态为待生产。'],
    title: '马总订单'
  });

  assertDirectPayload('query', result);
  assert(typeof result.title === 'string' && result.title.trim(), 'query title is required');
  assert(Array.isArray(result.lines), 'query lines must be an array');
  assert(result.lines.length > 0, 'query lines must not be empty');
  assert(!hasText(result.title, '没完全听懂'), 'query should not return fallback title');
  assert(!result.lines.some((line) => hasText(line, '没完全听懂')), 'query should not return fallback lines');
  console.log('query ok');
}

async function main() {
  const runtime = parseMode(process.argv.slice(2));
  const requestJson = createRequestJson(runtime);
  await testParseContractShape(requestJson);
  await testParse(requestJson);
  await testQuery(requestJson);
  if (runtime.mode === 'OFFLINE_REPLAY') {
    console.log('AI contract smoke passed: OFFLINE_REPLAY (network disabled)');
  } else {
    console.log(`AI contract smoke passed: LIVE_EXPLICIT host=${runtime.liveHost}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code || 'AI_CONTRACT_SMOKE_ERROR'}: ${error.message}`);
    process.exit(error.code === 'AI_SMOKE_MODE_REQUIRED' ? 2 : 1);
  });
}

module.exports = {
  createRequestJson,
  main,
  parseMode
};
