/*
 * 上线前“记一笔”标准题库（第 2 版）
 *
 * 这不是拿 AI 随机拼出来的空题，而是先固定一笔真实业务事实，再把它改写成
 * 老板常见的不同说法。每一题都给出应有结果、不能出现的结果和应走的路线。
 *
 * 题数：1,490（1,390 道用户输入 + 100 道 AI 失败保护场景）
 */

const { diffDays, parseChineseDate, today } = require('../utils/date');

const customers = ['王总', '李姐', '陈老板', '周姐', '老王', '赵姐', '黄老板', '吴总', '钱总', '孙姐', '阿强', '刘总', '马姐', '何老板', '郑总', '杨姐', '冯总', '方姐', '郭老板', '宋总'];

const products = [
  { name: '水杯', unit: '个', price: '5.5', spokenPrice: '五块五', typos: ['水怀', '水悲'] },
  { name: '椅子', unit: '个', price: '20', spokenPrice: '二十块钱', typos: ['椅孑', '一子'] },
  { name: '礼品盒', unit: '套', price: '3.8', spokenPrice: '三块八', typos: ['礼合', '礼品和'] },
  { name: '钥匙扣', unit: '个', price: '1.2', spokenPrice: '一块二', typos: ['钥匙口', '钥时扣'] },
  { name: '杯垫', unit: '个', price: '0.9', spokenPrice: '九毛', typos: ['杯甸', '杯店'] },
  { name: '包装袋', unit: '只', price: '0.08', spokenPrice: '八分', typos: ['包裝袋', '包装代'] },
  { name: '收纳盒', unit: '个', price: '7.8', spokenPrice: '七块八', typos: ['收钠合', '收纳和'] },
  { name: '头绳', unit: '条', price: '0.35', spokenPrice: '三毛五', typos: ['头神', '头神儿'] },
  { name: '饰品盒', unit: '套', price: '2.3', spokenPrice: '两块三', typos: ['饰品合', '饰品和'] },
  { name: '五金挂件', unit: '个', price: '1.5', spokenPrice: '一块五', typos: ['五金挂健', '五金挂见'] }
];

const quantities = ['5', '20', '100', '300', '500', '800', '1000', '2000', '3000', '5000'];
const dueWords = ['明天', '后天', '周日', '这周五', '下周一', '月底', '下周三', '礼拜天', '明个儿', '下周拿'];
const notes = ['蓝色的', '外箱别写中文', '颜色淡一点', '袋口别太紧', 'logo 放中间', '要加隔板', '不要太厚', '黑色多一点', '尽量早点', '先给样品'];
// 这些是本地已经有明确替换建议的常见语音转写。它们不应再自动等待 AI，
// 而应在确认卡上让老板点一下商品名称后再保存。
const LOCAL_PRODUCT_CONFIRMATION_TYPOS = new Set(['水怀', '礼合', '钥匙口', '饰品合']);

function asNumberText(value) {
  return String(value).replace(/\.0$/, '');
}

function amountOf(quantity, unitPrice) {
  return asNumberText(Number(quantity) * Number(unitPrice));
}

function row(index) {
  const product = products[index % products.length];
  // 用不同进位取值，避免“同一个客户 + 同一个商品 + 同一句式”循环复用，
  // 让每一题都是一条不同的真实表达，而不只是把编号改掉。
  const customer = customers[Math.floor(index / products.length) % customers.length];
  const quantity = quantities[(Math.floor(index / 20) + Math.floor(index / 200)) % quantities.length];
  const due = dueWords[(index * 3 + Math.floor(index / 11)) % dueWords.length];
  return { product, customer, quantity, due, note: notes[(index * 7 + Math.floor(index / 13)) % notes.length] };
}

function expectedBusiness(intent, data, extra = {}) {
  return Object.assign({
    intent,
    customer: data.customer,
    product: data.product.name,
    quantity: data.quantity,
    unitPrice: data.product.price,
    amount: amountOf(data.quantity, data.product.price),
    route: 'local',
    canSaveAfterConfirm: true
  }, extra);
}

function applySpecificDueDateExpectation(data, extra = {}) {
  const expected = Object.assign({}, extra);
  const parsedDueDate = parseChineseDate(data.due);
  // “下周拿/下周交”没有具体星期几；已经早于今天的交期也可能是历史补录
  // 或口误。两类都不能无提示直接保存，必须让老板确认。
  if (!parsedDueDate) {
    expected.route = 'pending';
    expected.mustBlock = true;
    expected.canSaveAfterConfirm = false;
    expected.requiresManualProductConfirmation = false;
    expected.mustBlockOnAiFailure = false;
  } else if (diffDays(parsedDueDate, today()) < 0) {
    const hadLocalProductConfirmation = expected.requiresManualProductConfirmation === true;
    if ((expected.route || 'local') === 'local' && !hadLocalProductConfirmation) expected.route = 'pending';
    expected.mustBlock = true;
    expected.canSaveAfterConfirm = false;
    // 这类题至少还要确认交期，不能再用“只点一下商品名就应当保存”的专项断言。
    if (hadLocalProductConfirmation) expected.requiresManualProductConfirmation = false;
  }
  return expected;
}

function createCase(id, category, expression, source, input, expected, extras = {}) {
  return Object.assign({
    id,
    category,
    expression,
    source,
    input,
    expected,
    originalText: input,
    rawMessages: [],
    severity: 'normal'
  }, extras);
}

function makeCorpus() {
  const cases = [];
  const add = (category, expression, source, input, expected, extras) => {
    const id = `R${String(cases.length + 1).padStart(4, '0')}`;
    cases.push(createCase(id, category, expression, source, input, expected, extras));
  };

  // 300 道：应由本地规则快速整理的清楚手打文字。
  for (let index = 0; index < 150; index += 1) {
    const data = row(index);
    const templates = [
      `${data.customer}订${data.quantity}${data.product.unit}${data.product.name}，${data.product.price}元一个，${data.due}交货`,
      `给${data.customer}记订单：${data.product.name}${data.quantity}${data.product.unit}，单价${data.product.price}，${data.due}发`,
      `${data.customer}要${data.product.name}${data.quantity}${data.product.unit}，${data.product.price}一${data.product.unit}，${data.due}拿`,
      `${data.customer}下单${data.product.name} ${data.quantity}${data.product.unit}，${data.product.price}元/${data.product.unit}，${data.due}出`
    ];
    add('清楚的单商品订单', '完整手打文字', 'typed', templates[index % templates.length], expectedBusiness('order', data, applySpecificDueDateExpectation(data)));
  }
  for (let index = 0; index < 100; index += 1) {
    const data = row(index + 3);
    const templates = [
      `给${data.customer}报${data.product.name}${data.quantity}${data.product.unit}，${data.product.price}元一个`,
      `${data.customer}问价，${data.product.name}${data.quantity}${data.product.unit}，单价${data.product.price}`,
      `${data.customer}那边${data.product.name}${data.quantity}${data.product.unit}先报${data.product.price}一${data.product.unit}`,
      `报价：${data.customer}，${data.product.name} ${data.quantity}${data.product.unit}，${data.product.price}元/${data.product.unit}`
    ];
    add('清楚的报价', '完整手打文字', 'typed', templates[index % templates.length], expectedBusiness('quotation', data));
  }
  for (let index = 0; index < 50; index += 1) {
    const data = row(index + 6);
    add('清楚的提醒', '完整手打文字', 'typed', `明天提醒我给${data.customer}回${data.product.name}的价格`, {
      intent: 'todo', customer: data.customer, route: 'local', canSaveAfterConfirm: true, todo: true
    });
  }

  // 160 道：错别字、同音字和语音转写。已有明确本地建议的词由老板确认；
  // 其余无法直接核对的词才进入快速 AI 路径。
  for (let index = 0; index < 160; index += 1) {
    const data = row(index);
    const typo = data.product.typos[index % data.product.typos.length];
    const templates = [
      `${data.customer}要订${data.quantity}${data.product.unit}${typo}，${data.product.spokenPrice}一个，${data.due}交`,
      `${data.customer}说${typo}${data.quantity}${data.product.unit}先整，${data.product.spokenPrice}一${data.product.unit}，${data.due}发`,
      `${data.customer}那个${typo}要${data.quantity}${data.product.unit}，价钱${data.product.spokenPrice}，${data.due}拿`,
      `${data.customer}下${typo}${data.quantity}${data.product.unit}，${data.product.price}块钱一个，${data.due}`
    ];
    const needsManualProductConfirmation = LOCAL_PRODUCT_CONFIRMATION_TYPOS.has(typo);
    add('错别字和同音字', '语音转写易错字', 'voice', templates[index % templates.length], expectedBusiness('order', data, applySpecificDueDateExpectation(data, {
      route: needsManualProductConfirmation ? 'local' : 'ai_standard',
      requiresManualProductConfirmation: needsManualProductConfirmation,
      canSaveAfterConfirm: true
    })), { severity: 'high' });
  }

  // 140 道：口语、方言、中文数字、口头价格和日期。来源是语音不再强制 AI，
  // 文字本身清楚时应和手打文字一样快速整理。
  for (let index = 0; index < 140; index += 1) {
    const data = row(index + 8);
    const spokenQuantity = [
      { text: '五', value: '5' }, { text: '二十', value: '20' }, { text: '一百', value: '100' },
      { text: '三百', value: '300' }, { text: '五百', value: '500' }, { text: '八百', value: '800' },
      { text: '一千', value: '1000' }, { text: '两千', value: '2000' }, { text: '三千', value: '3000' }, { text: '五千', value: '5000' }
    ][index % 10];
    const chineseQuantity = `${spokenQuantity.text}${data.product.unit}`;
    const spokenData = Object.assign({}, data, { quantity: spokenQuantity.value });
    const templates = [
      `${data.customer}这单${data.product.name}要${chineseQuantity}，${data.product.spokenPrice}一${data.product.unit}，明个儿交`,
      `${data.customer}说${data.product.name}先来${chineseQuantity}，${data.product.spokenPrice}，礼拜天发`,
      `${data.customer}那边${data.product.name}${chineseQuantity}，一${data.product.unit}${data.product.spokenPrice}，后晌给他`,
      `${data.customer}要货，${data.product.name}${chineseQuantity}，价钱${data.product.spokenPrice}，这礼拜出`
    ];
    // “后晌/下午”只说了时段，没有说哪一天；“这礼拜出”也只有范围。
    // 两者都不能由本地程序猜成一个精确交期。
    const hasOnlyBroadDeliveryWindow = [2, 3].includes(index % templates.length);
    add('义乌口语和本地说法', '口语价格、口语日期、中文数量', 'voice', templates[index % templates.length], expectedBusiness('order', spokenData, {
      route: hasOnlyBroadDeliveryWindow ? 'pending' : 'local',
      mustBlock: hasOnlyBroadDeliveryWindow
    }), { severity: 'high' });
  }

  // 140 道：语序颠倒、没有标点、价格或交期在前。
  for (let index = 0; index < 140; index += 1) {
    const data = row(index + 11);
    const templates = [
      `${data.product.price}块钱一个，${data.product.name}${data.quantity}${data.product.unit}，${data.customer}要订，${data.due}拿`,
      `${data.due}交 ${data.product.name}${data.quantity}${data.product.unit} ${data.customer} ${data.product.price}一${data.product.unit} 下单`,
      `${data.quantity}${data.product.unit}${data.product.name}${data.product.price}元${data.customer}${data.due}发货`,
      `${data.customer} ${data.due} ${data.product.price}块一${data.product.unit} ${data.product.name}${data.quantity}${data.product.unit} 做`
    ];
    add('语句顺序颠倒', '价格、交期、客户位置调换', 'typed', templates[index % templates.length], expectedBusiness('order', data, applySpecificDueDateExpectation(data, { route: 'local' })), { severity: 'high' });
  }

  // 100 道：多轮微信聊天；首次必须提示深度核对，不能自动等待慢模型。
  for (let index = 0; index < 100; index += 1) {
    const data = row(index + 14);
    const rawMessages = [
      { index: 0, speaker: data.customer, content: `${data.product.name}${data.quantity}${data.product.unit}，${data.due}能不能出？` },
      { index: 1, speaker: '我', content: `${data.product.price}元一${data.product.unit}可以。` },
      { index: 2, speaker: data.customer, content: '那就按这个做。' }
    ];
    add('微信聊天单条业务', '聊天粘贴', 'paste', `${data.customer}：${data.product.name}${data.quantity}${data.product.unit}，${data.due}能不能出？\n我：${data.product.price}元一${data.product.unit}可以。\n${data.customer}：那就按这个做。`, expectedBusiness('order', data, { route: 'pending', mustBlock: true, requiresDeepReview: true }), { rawMessages, severity: 'high' });
  }

  // 120 道：改价、改量、历史、取消、两个意思混在一起，必须走深度 AI。
  for (let index = 0; index < 120; index += 1) {
    const data = row(index + 2);
    const oldPrice = asNumberText(Number(data.product.price) + 1);
    const templates = [
      `${data.customer}${data.product.name}${data.quantity}${data.product.unit}，不是${oldPrice}，最后按${data.product.price}一个，${data.due}交`,
      `${data.customer}刚刚那个${data.product.name}数量改成${data.quantity}${data.product.unit}，价格还是${data.product.price}，${data.due}发`,
      `${data.customer}上次那笔${data.product.name}不要，改这次${data.quantity}${data.product.unit}，${data.product.price}一${data.product.unit}，${data.due}`,
      `${data.customer}说先别按旧价，${data.product.name}${data.quantity}${data.product.unit}最终${data.product.price}，${data.due}出`
    ];
    add('改价改量和前后纠正', '前后信息覆盖', 'typed', templates[index % templates.length], expectedBusiness('order', data, { route: 'pending', mustBlock: true, requiresDeepReview: true }), { severity: 'critical' });
  }

  // 80 道：多商品。正确结果是两个商品，绝不能把单价词误拆成商品。
  for (let index = 0; index < 80; index += 1) {
    const first = row(index);
    const second = row(index + 3);
    const input = `${first.customer}要${first.product.name}${first.quantity}${first.product.unit}${first.product.price}元一个，${second.product.name}${second.quantity}${second.product.unit}${second.product.price}元一个，${first.due}一起交`;
    add('多商品订单', '一个客户两种商品', index % 2 ? 'voice' : 'typed', input, {
      intent: 'order', customer: first.customer, itemCount: 2, products: [first.product.name, second.product.name], route: 'pending', mustBlock: true, requiresDeepReview: true, canSaveAfterConfirm: true
    }, { severity: 'critical' });
  }

  // 100 道：欠款、收款、定金及其关联，不能因为看似完整就放松处理。
  for (let index = 0; index < 100; index += 1) {
    const data = row(index + 4);
    const amount = ['800', '1200', '2000', '3200', '5000', '8600', '12000', '15000', '3000', '1000'][index % 10];
    const type = index % 4;
    if (type === 0) {
      add('账款高风险', '待收款口语', 'voice', `${data.customer}那批${data.product.name}还差${amount}没给，${data.due}收`, {
        intent: 'receivable', customer: data.customer, amount, route: 'pending', mustBlock: true, requiresDeepReview: true, canSaveAfterConfirm: true
      }, { severity: 'critical' });
    } else if (type === 1) {
      add('账款高风险', '收款口语', 'voice', `${data.customer}刚微信打了${amount}，顶到上回${data.product.name}款里`, {
        intent: 'payment', customer: data.customer, paymentAmount: amount, route: 'pending', mustBlock: true, requiresDeepReview: true, canSaveAfterConfirm: true
      }, { severity: 'critical' });
    } else if (type === 2) {
      add('账款高风险', '订单定金', 'typed', `${data.customer}${data.product.name}${data.quantity}${data.product.unit}先付定金${amount}，${data.due}交`, {
        intent: 'order', customer: data.customer, product: data.product.name, quantity: data.quantity, paymentAmount: amount, deposit: true, route: 'pending', mustBlock: true, requiresDeepReview: true, canSaveAfterConfirm: true
      }, { severity: 'critical' });
    } else {
      add('账款高风险', '催款提醒', 'typed', `${data.due}提醒我催${data.customer}${data.product.name}的尾款${amount}`, {
        intent: 'dunning', customer: data.customer, amount, route: 'pending', mustBlock: true, requiresDeepReview: true, canSaveAfterConfirm: true
      }, { severity: 'critical' });
    }
  }

  // 130 道：关键事实缺失。正确答案就是“别猜，要求补充”。
  for (let index = 0; index < 130; index += 1) {
    const data = row(index + 9);
    const source = index % 2 ? 'voice' : 'typed';
    const ordinaryMissingRoute = 'pending';
    const patterns = [
      { text: `${data.product.name}${data.quantity}${data.product.unit}，${data.product.spokenPrice}一个，${data.note}，${data.due}交`, expected: { intent: 'order', product: data.product.name, quantity: data.quantity, customerAbsent: true, route: ordinaryMissingRoute } },
      { text: `${data.customer}来一单，${data.due}发`, expected: { intent: 'order', customer: data.customer, route: ordinaryMissingRoute } },
      { text: `${data.customer}的${data.product.name}要做，价格照上次`, expected: { intent: 'order', customer: data.customer, product: data.product.name, route: 'pending' } },
      { text: `${data.customer}说那个按原来做，尽快`, expected: { customer: data.customer, route: 'pending' } },
      { text: `${data.product.name}一批，${data.note}，${data.due}给`, expected: { product: data.product.name, customerAbsent: true, route: ordinaryMissingRoute } }
    ];
    const picked = patterns[index % patterns.length];
    add('缺少关键信息', '客户、商品、价格或关联信息缺失', source, picked.text, Object.assign({ mustBlock: true, canSaveAfterConfirm: false }, picked.expected), { severity: 'critical' });
  }

  // 90 道：多笔业务和普通聊天，不能伪造一笔业务记录。
  for (let index = 0; index < 90; index += 1) {
    const data = row(index + 5);
    const other = row(index + 7);
    const patterns = [
      `${data.customer}${data.product.name}报价${data.quantity}${data.product.unit}${data.product.price}元，另外${other.customer}刚打了2000`,
      `等会儿看看仓库还有没有位置，${data.customer}这批${data.product.name}${data.due}再说`,
      `${data.customer}电话你有吗？我想问问${data.product.name}${data.quantity}${data.product.unit}怎么做`,
      `${data.customer}说${data.product.name}${data.quantity}${data.product.unit}先不要做，等${data.due}通知`,
      `今天先把${data.customer}的${data.product.name}${data.quantity}${data.product.unit}样品找出来，价格以后再谈`
    ];
    add('混合业务或非业务内容', '不能强行保存', 'voice', patterns[index % patterns.length], {
      route: 'pending', mustBlock: true, noRecord: true, canSaveAfterConfirm: false
    }, { severity: 'critical' });
  }

  // 30 道：单商品价格附近的“块钱一个”永久回归题，防止再次伪造第二个商品。
  for (let index = 0; index < 30; index += 1) {
    const data = row(index + 1);
    const templates = [
      `老板今天要订${data.quantity}${data.product.unit}${data.product.name}，${data.product.price}块钱一个。这周日交货`,
      `${data.customer}要${data.quantity}${data.product.unit}${data.product.name}，${data.product.price}块钱一${data.product.unit}，周日交`,
      `${data.product.name}${data.quantity}${data.product.unit} ${data.product.price}块钱一个 ${data.due}交`,
      `${data.customer}说${data.product.name}${data.quantity}${data.product.unit}，${data.product.price}块钱一个，${data.due}拿`
    ];
    const customerAbsent = index % templates.length === 0 || index % templates.length === 2;
    const singleItemOptions = {
      customer: customerAbsent ? '' : data.customer,
      customerAbsent,
      itemCount: 1,
      forbiddenCustomers: customerAbsent ? ['老板今', '老板'] : [],
      forbiddenProducts: ['块钱', '块', '钱'],
      route: customerAbsent ? 'pending' : 'local',
      mustBlock: customerAbsent,
      canSaveAfterConfirm: !customerAbsent
    };
    const optionsWithDueSafety = [2, 3].includes(index % templates.length)
      ? applySpecificDueDateExpectation(data, singleItemOptions)
      : singleItemOptions;
    add('单商品防误拆回归', '价格词不能变成第二个商品', 'voice', templates[index % templates.length], expectedBusiness('order', data, optionsWithDueSafety), { severity: 'critical' });
  }

  // 100 道：AI 失败、超时、登录失败、格式异常。它们不是新句式，而是对 AI 路径的保护测试。
  const failureModes = ['timeout', 'network', 'login_failed', 'server_500', 'invalid_json'];
  for (let index = 0; index < 100; index += 1) {
    const data = row(index + 1);
    const failureMode = failureModes[index % failureModes.length];
    const typo = data.product.typos[0] || data.product.name;
    const needsManualProductConfirmation = LOCAL_PRODUCT_CONFIRMATION_TYPOS.has(typo);
    add('AI 失败保护', 'AI 没有成功返回时不能误存', 'voice', `语音转写：${data.customer}要订${data.quantity}${data.product.unit}${typo}，${data.product.spokenPrice}一个，${data.due}交`, expectedBusiness('order', data, applySpecificDueDateExpectation(data, {
      route: needsManualProductConfirmation ? 'local' : 'ai_standard',
      requiresManualProductConfirmation: needsManualProductConfirmation,
      mustBlockOnAiFailure: !needsManualProductConfirmation,
      canSaveAfterConfirm: needsManualProductConfirmation
    })), { severity: 'critical', failureMode });
  }

  return cases;
}

const corpus = makeCorpus();
if (corpus.length !== 1490) throw new Error(`题库数量应为 1490，实际为 ${corpus.length}`);
const uniqueInputs = new Set(corpus.map((item) => `${item.source}|${item.input}`));
if (uniqueInputs.size !== corpus.length) {
  throw new Error(`题库中存在 ${corpus.length - uniqueInputs.size} 道重复输入；不能用重复题充数。`);
}

module.exports = {
  corpus,
  makeCorpus
};
