const { isRealAiEnabled } = require('../config');
const { mockParse, mockQuery } = require('./mock');

function extractJson(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('Empty AI response');
  try {
    return JSON.parse(source);
  } catch (error) {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) throw error;
    return JSON.parse(match[0]);
  }
}

function compactStateForPrompt(state) {
  const safeState = state || {};
  return {
    customers: (safeState.customers || []).slice(0, 50),
    quotations: (safeState.quotations || []).slice(0, 50),
    orders: (safeState.orders || []).slice(0, 50),
    receivables: (safeState.receivables || []).slice(0, 50),
    todos: (safeState.todos || []).slice(0, 50),
    pendingNotes: (safeState.pendingNotes || []).slice(0, 20)
  };
}

function chatCompletion(config, messages) {
  const url = `${config.aiBaseUrl}/chat/completions`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.aiApiKey}`
    },
    body: JSON.stringify({
      model: config.aiModel,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  })
    .then((res) => {
      if (!res.ok) {
        return res.text().then((body) => {
          throw new Error(`AI HTTP ${res.status}: ${body}`);
        });
      }
      return res.json();
    })
    .then((data) => {
      const content = data
        && data.choices
        && data.choices[0]
        && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      return extractJson(content);
    });
}

function parseWithAi(config, payload) {
  if (!isRealAiEnabled(config)) return Promise.resolve(mockParse(payload));
  const today = new Date().toISOString().slice(0, 10);
  return chatCompletion(config, [
    {
      role: 'system',
      content: [
        '你是义乌小工厂老板的AI生意助理，只负责把用户输入解析成结构化草稿。',
        '必须只输出JSON，不要解释。',
        '所有金额、数量、单价都用数字字符串：一万五=15000，2万=20000，9毛钱一个=0.9，3毛5=0.35，5块5一个=5.5，一块二一个=1.2。',
        '相对日期以今天为基准，今天是 ' + today + '。',
        '所有日期必须输出YYYY-MM-DD，不能输出2026.6.30或中文日期。',
        'intent只能是 quotation, order, receivable, payment, dunning, todo, query, unknown。',
        'AI只生成草稿，不能声称已经保存。',
        '意图规则：出现提醒我、明天给客户回、回复、答复、跟进、到点再催等老板自己稍后要做的动作，优先todo；出现欠、还欠、记账、月底给、月底结、货款未结，优先receivable；出现刚转了、已转、付款、打款、到账、收了，优先payment；出现要、订、补、返单、先下、做、要发、交货、发货，优先order；出现报价、报个价、问价且老板已完成报价动作，优先quotation。',
        '待办规则：例如“周姐问500套礼品盒，单价3.8，明天给她回”应解析todo，todoTitle=回复周姐礼品盒报价，dueDate=明天日期，同时保留产品、数量、单价和remark。',
        '口语规则：刚转了3000还剩2000，应解析payment，paymentAmount=3000，remainingAmount=2000，remark保留剩余2000；一共8600月底给，应解析receivable，amount=8600；补500个、返单300个、先下1000个通常是订单。',
        '字段规则：payment场景里paymentAmount表示本次收了多少钱；receivable场景里amount表示应收总额。不要把本次收款金额误填成应收总额。',
        '历史规则：用户说还是原价、价格跟上次一样、按上次报价做时，必须先看businessContext里的recentQuotations/recentOrders；能匹配同客户和同产品才可沿用价格，并在field_sources里标history；找不到历史时不要编价格，unitPrice留空，并把unitPrice放入missing_fields或low_confidence_fields。',
        '背景规则：customerCandidates和businessContext只代表前端筛选后的同客户背景；如果为空，表示没有可用历史。不能自行引用或猜测其他客户的历史。',
        '客户规则：如果原文明确出现客户称呼，如老王、王总、周老板，必须优先使用原文客户；背景信息只能补价格、旧应收、旧订单或旧报价ID，不能覆盖原文客户。',
        '隔离规则：只有同客户历史才可用于补字段；不得把马总的价格、订单、应收用于老王，也不得把任意背景客户替换成原文客户。',
        '更新规则：用户说改、改成、延期、提前、数量改成、价格改成、那单、上次那笔报价等，需要先看businessContext；如果能唯一匹配已有订单或报价，返回对应orderId或quotationId，并把新字段填入fields；如果不能唯一匹配，不要编ID，放入low_confidence_fields。',
        '不确定的客户、产品、价格、日期必须放入low_confidence_fields；缺失的关键字段必须放入missing_fields。',
        '如果原文明确写了价格，例如还是9毛、5.5一个、一块二一个，可以直接填写单价，并在remark保留原文依据。',
        '客户称呼要保留原文，如老王、周老板、马总，不要擅自改成其他称呼。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        text: payload.text || '',
        source: payload.source || 'typed',
        context: payload.context || 'home',
        customerCandidates: payload.customerCandidates || [],
        businessContext: payload.businessContext || {},
        requiredShape: {
          intent: 'order',
          fields: {
            customerId: '',
            customerName: '',
            phone: '',
            company: '',
            region: '',
            todoTitle: '',
            followupDays: '',
            productName: '',
            spec: '',
            quantity: '',
            unit: '',
            unitPrice: '',
            paymentAmount: '',
            amount: '',
            remainingAmount: '',
            paymentMethod: '',
            dueDate: '',
            orderId: '',
            quotationId: '',
            remark: ''
          },
          missing_fields: [],
          low_confidence_fields: [],
          customer_candidates: [],
          computed_fields: [],
          computed_tips: [],
          field_sources: {},
          intent_candidates: [],
          confidence: 0.9,
          confirm_message: ''
        }
      })
    }
  ]).then((result) => Object.assign({}, result, {
    provider: config.aiProvider || 'ai'
  }));
}

function queryWithAi(config, payload) {
  if (!isRealAiEnabled(config)) return Promise.resolve(mockQuery(payload));
  return chatCompletion(config, [
    {
      role: 'system',
      content: [
        '你是义乌小工厂老板的AI查询助理。',
        '你只能根据用户提供的JSON数据回答，不能编造。',
        '回答必须是JSON：{ "title": string, "lines": string[], "readonly": true }。',
        '语气要短、直接、像老板看得懂的待办说明。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: payload.question || '',
        state: compactStateForPrompt(payload.state || {})
      })
    }
  ]).then((result) => Object.assign({}, result, {
    readonly: true,
    provider: config.aiProvider || 'ai'
  }));
}

module.exports = {
  parseWithAi,
  queryWithAi
};
