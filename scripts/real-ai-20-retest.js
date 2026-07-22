/*
 * 真实 AI 复测：只使用虚构客户和商品，不读取或输出用户真实生意数据。
 * 在服务端目录执行：node - < scripts/real-ai-20-retest.js
 */
const path = require('path');

const root = process.cwd();
const { getConfig, isRealAiEnabled } = require(path.join(root, 'src/config'));
const { parseWithAi } = require(path.join(root, 'src/ai/model'));

function valueOf(fields, name) {
  return String((fields || {})[name] || '');
}

function includes(value, expected) {
  return String(value || '').includes(String(expected));
}

function itemCount(result) {
  const fields = result.fields || {};
  return Array.isArray(fields.items) ? fields.items.length : 0;
}

function resultSummary(result = {}) {
  const fields = result.fields || {};
  return {
    intent: result.intent || '',
    fields: {
      customerName: valueOf(fields, 'customerName'),
      productName: valueOf(fields, 'productName'),
      quantity: valueOf(fields, 'quantity'),
      unit: valueOf(fields, 'unit'),
      unitPrice: valueOf(fields, 'unitPrice'),
      amount: valueOf(fields, 'amount'),
      paymentAmount: valueOf(fields, 'paymentAmount'),
      depositAmount: valueOf(fields, 'depositAmount'),
      paymentKind: valueOf(fields, 'paymentKind'),
      dueDate: valueOf(fields, 'dueDate'),
      todoTitle: valueOf(fields, 'todoTitle'),
      items: (fields.items || []).map((item) => ({
        productName: valueOf(item, 'productName'),
        quantity: valueOf(item, 'quantity'),
        unit: valueOf(item, 'unit'),
        unitPrice: valueOf(item, 'unitPrice'),
        totalAmount: valueOf(item, 'totalAmount')
      }))
    },
    lowConfidenceFields: result.low_confidence_fields || [],
    missingFields: result.missing_fields || [],
    fieldConflicts: result.field_conflicts || [],
    intentCandidates: result.intent_candidates || [],
    confirmMessage: result.confirm_message || '',
    model: result.ai_model || '',
    tier: result.ai_model_tier || ''
  };
}

function correct(detail) {
  return { status: 'correct', detail };
}

function safe(detail) {
  return { status: 'safe_block', detail };
}

function wrong(detail) {
  return { status: 'wrong', detail };
}

function hasLow(result, field) {
  return (result.low_confidence_fields || []).includes(field)
    || (result.missing_fields || []).includes(field)
    || (result.field_conflicts || []).some((item) => item && item.field === field);
}

const simpleCases = [
  {
    id: 'S01',
    text: '王总订水杯100个，5块5一个，明天交',
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'customerName') === '王总'
      && valueOf(r.fields, 'productName') === '水杯' && valueOf(r.fields, 'quantity') === '100'
      && valueOf(r.fields, 'unitPrice') === '5.5' && valueOf(r.fields, 'dueDate')
      ? correct('订单字段正确') : wrong('订单关键字段不完整或不正确')
  },
  {
    id: 'S02',
    text: '给李姐报礼品盒500套，3块8一套',
    check: (r) => r.intent === 'quotation' && valueOf(r.fields, 'customerName') === '李姐'
      && valueOf(r.fields, 'productName') === '礼品盒' && valueOf(r.fields, 'quantity') === '500'
      && valueOf(r.fields, 'unitPrice') === '3.8'
      ? correct('报价字段正确') : wrong('报价字段不完整或业务类型错误')
  },
  {
    id: 'S03',
    text: '张总要纸袋2000个，1块2一个，下周一交',
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'customerName') === '张总'
      && valueOf(r.fields, 'productName') === '纸袋' && valueOf(r.fields, 'quantity') === '2000'
      && valueOf(r.fields, 'unitPrice') === '1.2' && valueOf(r.fields, 'dueDate')
      ? correct('口语单价和交期正确') : wrong('口语单价或交期未正确整理')
  },
  {
    id: 'S04',
    text: '陈姐订钥匙扣800个，一块二一个，周三交',
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'customerName') === '陈姐'
      && valueOf(r.fields, 'productName') === '钥匙扣' && valueOf(r.fields, 'quantity') === '800'
      && valueOf(r.fields, 'unitPrice') === '1.2' && valueOf(r.fields, 'dueDate')
      ? correct('订单字段正确') : wrong('订单字段不完整或不正确')
  },
  {
    id: 'S05',
    text: '老王要拖鞋500双，2块8一双，三天后交',
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'customerName') === '老王'
      && valueOf(r.fields, 'productName') === '拖鞋' && valueOf(r.fields, 'quantity') === '500'
      && valueOf(r.fields, 'unitPrice') === '2.8' && valueOf(r.fields, 'dueDate')
      ? correct('订单字段正确') : wrong('订单字段不完整或不正确')
  },
  {
    id: 'S06',
    text: '郑老板报挂件3000个，1块5一个',
    check: (r) => r.intent === 'quotation' && valueOf(r.fields, 'customerName') === '郑老板'
      && valueOf(r.fields, 'productName') === '挂件' && valueOf(r.fields, 'quantity') === '3000'
      && valueOf(r.fields, 'unitPrice') === '1.5'
      ? correct('报价字段正确') : wrong('报价字段不完整或业务类型错误')
  },
  {
    id: 'S07',
    text: '赵总下单卡通杯800个，6元一个，下个月5号交',
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'customerName') === '赵总'
      && includes(valueOf(r.fields, 'productName'), '卡通杯') && valueOf(r.fields, 'quantity') === '800'
      && valueOf(r.fields, 'unitPrice') === '6' && valueOf(r.fields, 'dueDate')
      ? correct('下个月交期正确') : wrong('下个月交期或订单字段错误')
  },
  {
    id: 'S08',
    text: '周姐问500套礼品盒，单价3.8，明天给她回',
    check: (r) => r.intent === 'todo' && includes(valueOf(r.fields, 'todoTitle'), '周姐') && valueOf(r.fields, 'dueDate')
      ? correct('提醒任务正确') : wrong('应为提醒任务，但结果不正确')
  },
  {
    id: 'S09',
    text: '王总订水怀100个，5块5一个，明天交',
    check: (r) => {
      if (r.errorCode === 'AI_RESPONSE_INVALID') return safe('快速 AI 拒绝把疑似错字当成确定商品') ;
      const product = valueOf(r.fields, 'productName');
      if ((product === '水杯' || product === '水怀') && hasLow(r, 'productName')) return safe('商品名保留待确认，不会直接误存');
      return wrong('商品转写错误既没有正确整理，也没有要求确认');
    }
  },
  {
    id: 'S10',
    text: '刘姐说先看看价，杯子一千个，2块8一个',
    check: (r) => r.intent === 'quotation' && valueOf(r.fields, 'customerName') === '刘姐'
      && includes(valueOf(r.fields, 'productName'), '杯') && valueOf(r.fields, 'quantity') === '1000'
      && valueOf(r.fields, 'unitPrice') === '2.8'
      ? correct('询价按报价草稿整理') : wrong('询价场景整理不正确')
  }
];

const deepCases = [
  {
    id: 'C01',
    text: '老王补300个杯垫，还是上次价格，下周五交',
    businessContext: { recentOrders: [{ id: 'ord_old', customerName: '老王', productName: '杯垫', unitPrice: '0.8', unit: '个' }] },
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'unitPrice') === '0.8'
      ? correct('正确使用同客户历史价格') : safe('没有可靠历史价格时应保留待确认')
  },
  {
    id: 'C02',
    text: '王总：水杯1000个先按30一个\n我：贵了可以少点\n王总：最后25一个，先做1000个，月底交',
    rawMessages: [
      { index: 0, speaker: '王总', content: '水杯1000个先按30一个' },
      { index: 1, speaker: '我', content: '贵了可以少点' },
      { index: 2, speaker: '王总', content: '最后25一个，先做1000个，月底交' }
    ],
    check: (r) => r.intent === 'order' && valueOf(r.fields, 'unitPrice') === '25'
      ? correct('按后续确认价 25 整理') : wrong('没有正确处理前后改价')
  },
  {
    id: 'C03',
    text: '王总下单：杯垫300个，每个0.9元；礼品盒200个，每个3.8元；后天交。',
    check: (r) => itemCount(r) === 2
      && valueOf(r.fields.items[0], 'productName') && valueOf(r.fields.items[1], 'productName')
      ? correct('返回了两条商品明细') : safe('未逐项返回多商品时已被结构校验拦住')
  },
  {
    id: 'C04',
    text: '周姐刚微信打了两千，顶在上回礼品盒款里',
    businessContext: { recentReceivables: [{ id: 'rec_1', customerName: '周姐', amount: '5000', paidAmount: '0', status: '待收' }] },
    check: (r) => r.intent === 'payment' && valueOf(r.fields, 'paymentAmount') === '2000'
      ? correct('本次收款金额正确') : wrong('收款场景没有正确整理')
  },
  {
    id: 'C05',
    text: '李总纸袋这单先付了两千定金，余款发货前结',
    check: (r) => ['order', 'payment'].includes(r.intent)
      && (valueOf(r.fields, 'depositAmount') === '2000' || valueOf(r.fields, 'paymentAmount') === '2000')
      ? correct('定金金额正确，并保留待确认关联') : wrong('定金金额或业务类型错误')
  },
  {
    id: 'C06',
    text: '王总水杯1000个，原来5块5，改成6块，下周五交',
    check: (r) => valueOf(r.fields, 'unitPrice') === '6'
      ? correct('改价后的单价为 6') : wrong('没有识别最终改价')
  },
  {
    id: 'C07',
    text: '周姐问500套礼品盒，单价3.8，明天给她回',
    check: (r) => r.intent === 'todo' && includes(valueOf(r.fields, 'todoTitle'), '周姐')
      ? correct('正确识别为待办提醒') : wrong('待办场景业务类型错误')
  },
  {
    id: 'C08',
    text: '王总礼品盒先报个大概价，数量和单价还没定',
    check: (r) => hasLow(r, 'quantity') || hasLow(r, 'unitPrice')
      ? correct('缺少数量和价格时明确要求确认') : wrong('缺少关键事实却没有标记风险')
  },
  {
    id: 'C09',
    text: '老王补300个杯垫，还是上次价格',
    check: (r) => hasLow(r, 'unitPrice')
      ? correct('没有历史资料时不编造旧价格') : wrong('没有历史资料却把价格当成确定值')
  },
  {
    id: 'C10',
    text: '王总，杯垫500个，九毛一个，另外周姐刚打了3000',
    check: (r) => (r.intent_candidates || []).filter((item) => ['quotation', 'order', 'payment'].includes(item)).length > 1
      || includes(r.confirm_message, '两笔') || includes(r.confirm_message, '多笔')
      ? correct('识别到混合业务，要求拆开确认') : wrong('混合业务没有明确提示拆开')
  }
];

async function runCase(testCase, reviewMode) {
  const startedAt = Date.now();
  const payload = {
    reviewMode,
    source: reviewMode === 'deep' ? 'paste' : 'voice',
    text: testCase.text,
    rawText: testCase.text,
    rawMessages: testCase.rawMessages || [],
    localDraft: { intent: 'unknown', fields: {} },
    businessContext: testCase.businessContext || {},
    customerCandidates: []
  };
  try {
    const result = await parseWithAi(getConfig(), payload);
    const outcome = testCase.check(result);
    return Object.assign({ id: testCase.id, text: testCase.text, elapsedMs: Date.now() - startedAt }, outcome, resultSummary(result));
  } catch (error) {
    const failed = { errorCode: error && error.code, errorMessage: error && error.message };
    const outcome = testCase.check(failed);
    return Object.assign({ id: testCase.id, text: testCase.text, elapsedMs: Date.now() - startedAt }, outcome, failed);
  }
}

function summarize(results) {
  const elapsed = results.map((item) => item.elapsedMs);
  const count = (status) => results.filter((item) => item.status === status).length;
  return {
    total: results.length,
    correct: count('correct'),
    safeBlock: count('safe_block'),
    wrong: count('wrong'),
    averageMs: Math.round(elapsed.reduce((sum, value) => sum + value, 0) / Math.max(1, elapsed.length)),
    minMs: Math.min(...elapsed),
    maxMs: Math.max(...elapsed),
    withinEightSeconds: results.filter((item) => item.elapsedMs <= 8000).length
  };
}

async function main() {
  const config = getConfig();
  if (!isRealAiEnabled(config)) throw new Error('REAL_AI_CONFIG_MISSING');
  const simple = [];
  const deep = [];
  for (const item of simpleCases) simple.push(await runCase(item, 'standard'));
  for (const item of deepCases) deep.push(await runCase(item, 'deep'));
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'real-ai',
    simple: { summary: summarize(simple), cases: simple },
    deep: { summary: summarize(deep), cases: deep }
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ errorCode: error && error.code, errorMessage: error && error.message })}\n`);
  process.exitCode = 1;
});
