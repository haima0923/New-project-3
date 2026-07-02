const { parseInput } = require('../utils/parser');
const { answerQuery } = require('../utils/query');
const { completeTodo, generateReceivableFromOrder, getDashboard, getOrderDepositAmount, mergeCustomer, recordPayment, saveConfirmedDraft } = require('../utils/business');
const { addDays, endOfMonth, today } = require('../utils/date');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const {
  buildAiRequestPayload,
  findScopedHistory,
  getContextPolicy,
  normalizeAiResult,
  parseHybridInput
} = require('../utils/ai-parser');
const { evaluateLocalParseSafety } = require('../utils/parse-safety');
const { getIntentDraftLabel, getMissingText, getPendingReasonText } = require('../utils/display');
const {
  consumeNextOrderFilter,
  consumeOrderFilterReset,
  requestOrderFilterReset,
  setNextOrderFilter
} = require('../utils/navigation-state');
const {
  buildAllRecords,
  buildRecentRecords,
  buildTodayTasks
} = require('../utils/home-workbench');
const {
  analyzeClipboardText,
  buildNoBusinessPasteResult,
  getClipboardDiagnostics,
  getClipboardDisplayText,
  getPasteMeta,
  getSingleMessagePasteTip,
  isSingleMessageClipboard,
  isWechatChatText
} = require('../utils/clipboard-chat');
const { buildFinanceViewModel } = require('../utils/finance');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function assertIncludes(source, keyword, message) {
  assert(String(source || '').includes(keyword), message || `${source} should include ${keyword}`);
}

function assertNotIncludes(source, keyword, message) {
  assert(!String(source || '').includes(keyword), message || `${source} should not include ${keyword}`);
}

function assertNumber(value, expected, message) {
  assert(Math.abs(asNumber(value) - expected) < 0.0001, `${message}: expected ${expected}, got ${value}`);
}

function runParseCase(item, index) {
  const result = parseInput({
    text: item.text,
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const prefix = `记一笔 ${index + 1}「${item.text}」`;
  const fields = result.fields || {};

  assert(result.intent === item.intent, `${prefix}: intent expected ${item.intent}, got ${result.intent}`);
  if (item.customer) assertIncludes(fields.customerName, item.customer, `${prefix}: customerName expected ${item.customer}, got ${fields.customerName}`);
  if (item.todoTitle) assertIncludes(fields.todoTitle, item.todoTitle, `${prefix}: todoTitle expected ${item.todoTitle}, got ${fields.todoTitle}`);
  if (item.product) assertIncludes(fields.productName, item.product, `${prefix}: productName expected ${item.product}, got ${fields.productName}`);
  if (item.quantity !== undefined) assertNumber(fields.quantity, item.quantity, `${prefix}: quantity`);
  if (item.unitPrice !== undefined) assertNumber(fields.unitPrice, item.unitPrice, `${prefix}: unitPrice`);
  if (item.amount !== undefined) assertNumber(fields.amount, item.amount, `${prefix}: amount`);
  if (item.paymentAmount !== undefined) assertNumber(fields.paymentAmount, item.paymentAmount, `${prefix}: paymentAmount`);
  if (item.depositAmount !== undefined) assertNumber(fields.depositAmount, item.depositAmount, `${prefix}: depositAmount`);
  if (item.paymentKind !== undefined) assert(fields.paymentKind === item.paymentKind, `${prefix}: paymentKind expected ${item.paymentKind}, got ${fields.paymentKind}`);
  if (item.remainingAmount !== undefined) assertNumber(fields.remainingAmount, item.remainingAmount, `${prefix}: remainingAmount`);
  if (item.amountBlank) assert(!fields.amount, `${prefix}: amount should stay blank, got ${fields.amount}`);
  if (item.unitPriceBlank) assert(!fields.unitPrice, `${prefix}: unitPrice should stay blank, got ${fields.unitPrice}`);
  if (item.dueDateRequired) assert(fields.dueDate, `${prefix}: dueDate should be present`);
  if (item.dueDate) assert(fields.dueDate === item.dueDate, `${prefix}: dueDate expected ${item.dueDate}, got ${fields.dueDate}`);
  if (item.remarkIncludes) assertIncludes(fields.remark, item.remarkIncludes, `${prefix}: remark should include ${item.remarkIncludes}, got ${fields.remark}`);
  (item.missingIncludes || []).forEach((field) => {
    assert(result.missing_fields.includes(field), `${prefix}: missing_fields should include ${field}`);
  });
  (item.lowIncludes || []).forEach((field) => {
    assert(result.low_confidence_fields.includes(field), `${prefix}: low_confidence_fields should include ${field}`);
  });
  assertIncludes(result.original_text, item.text.slice(0, 4), `${prefix}: original text should be preserved`);
}

function buildQueryState() {
  const current = today();
  const monthEnd = endOfMonth(current);
  return {
    customers: [
      { id: 'cus_wang', name: '王总' },
      { id: 'cus_ma', name: '马总' },
      { id: 'cus_chen', name: '陈总' },
      { id: 'cus_liu', name: '刘总' },
      { id: 'cus_zhou', name: '周姐' },
      { id: 'cus_laoli', name: '老李' }
    ],
    quotations: [
      {
        id: 'quo_wang_1',
        customerId: 'cus_wang',
        productName: '卡通水杯',
        quantity: '1000',
        unit: '个',
        unitPrice: '5.5',
        totalAmount: '5500',
        quoteDate: current,
        status: '待确认'
      }
    ],
    orders: [
      {
        id: 'ord_ma_1',
        customerId: 'cus_ma',
        productName: '杯垫',
        quantity: '300',
        unit: '个',
        unitPrice: '0.9',
        totalAmount: '270',
        requiredDeliveryDate: addDays(current, 3),
        status: '待生产',
        orderDate: current
      }
    ],
    receivables: [
      {
        id: 'rec_chen_1',
        customerId: 'cus_chen',
        amount: '15000',
        paidAmount: '0',
        dueDate: monthEnd,
        status: '待收'
      },
      {
        id: 'rec_liu_1',
        customerId: 'cus_liu',
        amount: '5000',
        paidAmount: '3000',
        dueDate: monthEnd,
        status: '部分收款'
      },
      {
        id: 'rec_laoli_1',
        customerId: 'cus_laoli',
        amount: '23000',
        paidAmount: '10000',
        dueDate: addDays(monthEnd, 7),
        status: '部分收款'
      },
      {
        id: 'rec_wang_settled',
        customerId: 'cus_wang',
        amount: '15000',
        paidAmount: '15000',
        dueDate: current,
        status: '已结清'
      }
    ],
    pendingNotes: [
      {
        id: 'pending_1',
        originalText: '孙总欠款一玩五，月底节',
        status: '待整理'
      }
    ],
    paymentRecords: [],
    dunningRecords: [],
    todos: [
      {
        id: 'todo_zhou_today',
        customerId: 'cus_zhou',
        title: '回复周姐礼品盒报价',
        productName: '礼品盒',
        remindDate: current,
        status: '待办'
      },
      {
        id: 'todo_zhou_tomorrow',
        customerId: 'cus_zhou',
        title: '跟进周姐礼品盒',
        productName: '礼品盒',
        remindDate: addDays(current, 1),
        status: '待办'
      }
    ],
    orderProgress: []
  };
}

function buildHistoryState({ includeLaoWangHistory = true, includeLaoWangReceivable = true } = {}) {
  const customers = [
    { id: 'cus_ma', name: '马总', lastTradeAt: '2026-06-18' },
    { id: 'cus_laowang', name: '老王', lastTradeAt: '2026-06-22' }
  ];
  const quotations = [
    {
      id: 'quo_ma',
      customerId: 'cus_ma',
      productName: '杯垫',
      quantity: '300',
      unit: '个',
      unitPrice: '0.9',
      totalAmount: '270',
      quoteDate: today(),
      status: '待确认'
    }
  ];
  const orders = [];
  const receivables = [];

  if (includeLaoWangHistory) {
    quotations.push({
      id: 'quo_laowang',
      customerId: 'cus_laowang',
      productName: '杯垫',
      quantity: '500',
      unit: '个',
      unitPrice: '0.8',
      totalAmount: '400',
      quoteDate: today(),
      status: '待确认'
    });
    orders.push({
      id: 'ord_laowang',
      customerId: 'cus_laowang',
      productName: '杯垫',
      quantity: '500',
      unit: '个',
      unitPrice: '0.8',
      totalAmount: '400',
      requiredDeliveryDate: addDays(today(), 3),
      orderDate: today(),
      status: '已完成'
    });
  }

  if (includeLaoWangReceivable) {
    receivables.push({
      id: 'rec_laowang',
      customerId: 'cus_laowang',
      amount: '6000',
      paidAmount: '0',
      dueDate: endOfMonth(today()),
      status: '待收'
    });
  }

  return {
    customers,
    quotations,
    orders,
    receivables,
    paymentRecords: [],
    todos: [],
    pendingNotes: []
  };
}

function buildEmptyBusinessState(customers = []) {
  return {
    customers,
    quotations: [],
    orders: [],
    receivables: [],
    paymentRecords: [],
    dunningRecords: [],
    orderProgress: [],
    todos: [],
    pendingNotes: [],
    aiParseLogs: []
  };
}

function buildOrderDraft(fields = {}) {
  return {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: '王总定300个杯子5天后要货5毛一个',
    fields: Object.assign({
      customerName: '王总',
      productName: '杯子',
      quantity: '300',
      unit: '个',
      unitPrice: '0.5',
      amount: '150',
      dueDate: addDays(today(), 5),
      remark: '王总定300个杯子5天后要货5毛一个'
    }, fields),
    missing_fields: [],
    low_confidence_fields: []
  };
}

function runQueryCase(state, item, index) {
  const result = answerQuery(item.question, state);
  const text = `${result.title}\n${(result.lines || []).join('\n')}`;
  const prefix = `问一句 ${index + 1}「${item.question}」`;
  (item.includes || []).forEach((keyword) => {
    assertIncludes(text, keyword, `${prefix}: result should include ${keyword}; got ${text}`);
  });
  (item.excludes || []).forEach((keyword) => {
    assertNotIncludes(text, keyword, `${prefix}: result should not include ${keyword}; got ${text}`);
  });
  assertNotIncludes(text, '我还没完全听懂', `${prefix}: should not hit fallback`);
}

function runParseTests() {
  const cases = [
    { text: '给王总报1000个卡通水杯，5块5一个，月底交', intent: 'order', customer: '王总', product: '卡通水杯', quantity: 1000, unitPrice: 5.5, amount: 5500, dueDateRequired: true },
    { text: '王总订1000个水杯，5块一个，先付定金1000，月底交', intent: 'order', customer: '王总', product: '水杯', quantity: 1000, unitPrice: 5, amount: 5000, paymentAmount: 1000, depositAmount: 1000, paymentKind: 'deposit', dueDateRequired: true },
    { text: '王总订1000个水杯，先付定金1000，月底交', intent: 'order', customer: '王总', product: '水杯', quantity: 1000, amountBlank: true, paymentAmount: 1000, depositAmount: 1000, paymentKind: 'deposit', dueDateRequired: true },
    { text: '给王总报价1000个卡通水杯，5块5一个', intent: 'quotation', customer: '王总', product: '卡通水杯', quantity: 1000, unitPrice: 5.5, amount: 5500 },
    { text: '李总问钥匙扣2000个多少钱，一块二一个', intent: 'quotation', customer: '李总', product: '钥匙扣', quantity: 2000, unitPrice: 1.2, amount: 2400 },
    { text: '陈老板要报个价，杯垫300个，9毛', intent: 'quotation', customer: '陈老板', product: '杯垫', quantity: 300, unitPrice: 0.9, amount: 270 },
    { text: '周姐问500套礼品盒，单价3.8，明天给她回', intent: 'todo', customer: '周姐', todoTitle: '回复周姐礼品盒报价', product: '礼品盒', quantity: 500, unitPrice: 3.8, amount: 1900, dueDateRequired: true },
    { text: '周姐问500套礼品盒多少钱，单价3.8', intent: 'quotation', customer: '周姐', product: '礼品盒', quantity: 500, unitPrice: 3.8, amount: 1900 },
    { text: '马总 300个杯垫 三天后交 9毛一个', intent: 'order', customer: '马总', product: '杯垫', quantity: 300, unitPrice: 0.9, amount: 270, dueDateRequired: true },
    { text: '马总要一千个杯垫，单价 0.95天后交货', intent: 'order', customer: '马总', product: '杯垫', quantity: 1000, unitPrice: 0.9, amount: 900, dueDate: addDays(today(), 5), remarkIncludes: '0.95天后' },
    { text: '老王补500个老款杯垫，9毛，三天后给他', intent: 'order', customer: '老王', product: '老款杯垫', quantity: 500, unitPrice: 0.9, amount: 450, dueDateRequired: true },
    { text: '老王那边补500个老款杯垫，还是9毛，三天后给他', intent: 'order', customer: '老王', product: '老款杯垫', quantity: 500, unitPrice: 0.9, amount: 450, dueDateRequired: true },
    { text: '李总样品确认了，先下1000个，5.5一个', intent: 'order', customer: '李总', product: '样品', quantity: 1000, unitPrice: 5.5, amount: 5500, missingIncludes: ['dueDate'] },
    { text: '周老板下周一要发2000个钥匙扣一块二一个', intent: 'order', customer: '周老板', product: '钥匙扣', quantity: 2000, unitPrice: 1.2, amount: 2400, dueDateRequired: true },
    { text: '陈总欠我一万五，月底结', intent: 'receivable', customer: '陈总', amount: 15000, dueDateRequired: true },
    { text: '陈总：有未结清应收 15000，月底到期', intent: 'receivable', customer: '陈总', amount: 15000, dueDateRequired: true },
    { text: '刘总这批货先记账，一共8600，月底给', intent: 'receivable', customer: '刘总', amount: 8600, dueDateRequired: true },
    { text: '王总货款还差3200，明天说打', intent: 'receivable', customer: '王总', amount: 3200, dueDateRequired: true },
    { text: '老李尾款2万3，下个月5号前结', intent: 'receivable', customer: '老李', amount: 23000, dueDateRequired: true },
    { text: '刘总刚转了3000，还剩2000', intent: 'payment', customer: '刘总', paymentAmount: 3000, remainingAmount: 2000 },
    { text: '老王还我4000还剩2000', intent: 'payment', customer: '老王', paymentAmount: 4000, remainingAmount: 2000 },
    { text: '陈总付了5000，微信转的', intent: 'payment', customer: '陈总', paymentAmount: 5000 },
    { text: '王总那笔货款今天到账15000，结清了', intent: 'payment', customer: '王总', paymentAmount: 15000, dueDateRequired: true },
    { text: '老李先打1万，剩下月底', intent: 'payment', customer: '老李', paymentAmount: 10000, dueDateRequired: true },
    { text: '张总要一千个杯子五块五月底交', intent: 'order', customer: '张总', product: '杯子', quantity: 1000, unitPrice: 5.5, amount: 5500, dueDateRequired: true },
    { text: '赵总要订二千个挂件，一块五，礼拜五出', intent: 'order', customer: '赵总', product: '挂件', quantity: 2000, unitPrice: 1.5, amount: 3000, dueDateRequired: true },
    { text: '钱总报架，水杯500个，6块一个', intent: 'quotation', customer: '钱总', product: '水杯', quantity: 500, unitPrice: 6, amount: 3000 },
    { text: '孙总欠款一玩五，月底节', intent: 'receivable', customer: '孙总', amountBlank: true, dueDateRequired: true, missingIncludes: ['amount'] },
    { text: '吴总定了3000个扣子，三毛五，周六拿', intent: 'order', customer: '吴总', product: '扣子', quantity: 3000, unitPrice: 0.35, amount: 1050, dueDateRequired: true },
    { text: '郑总说按上次那个价格，先做500个', intent: 'order', customer: '郑总', quantity: 500, unitPriceBlank: true, lowIncludes: ['unitPrice'], missingIncludes: ['productName', 'dueDate'] }
  ];
  cases.forEach(runParseCase);
  console.log(`记一笔核心样例通过：${cases.length} 条`);
}

function runLocalParseSafetyTests() {
  const safe = parseInput({
    text: '报给王总拖鞋3000双2块8',
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  assert(safe.intent === 'quotation', `safe local case should be quotation, got ${safe.intent}`);
  assert(safe.fields.customerName === '王总', `customer should strip action prefix, got ${safe.fields.customerName}`);
  assert(safe.fields.productName === '拖鞋', `product should stop before quantity, got ${safe.fields.productName}`);
  assert(safe.fields.quantity === '3000', `quantity should be 3000, got ${safe.fields.quantity}`);
  assert(safe.fields.unitPrice === '2.8', `unitPrice should be 2.8, got ${safe.fields.unitPrice}`);
  assert(safe.local_parse_safety.status === 'SAFE_LOCAL', `safe case should be SAFE_LOCAL, got ${safe.local_parse_safety.status}`);
  assert(safe.ai_fallback.needed === false, 'safe typed case should not need AI');

  const dirtyCustomer = evaluateLocalParseSafety({
    intent: 'quotation',
    source: 'typed',
    fields: {
      customerName: '报给王总',
      productName: '拖鞋',
      quantity: '3000',
      unitPrice: '2.8'
    },
    missing_fields: [],
    low_confidence_fields: []
  }, {
    source: 'typed',
    normalizedText: '报给王总拖鞋3000双2块8'
  });
  assert(dirtyCustomer.status === 'NEEDS_AI', `dirty customer should route to AI, got ${dirtyCustomer.status}`);
  assert(dirtyCustomer.low_confidence_fields.includes('customerName'), 'dirty customer should mark customerName low confidence');

  const dirtyProduct = evaluateLocalParseSafety({
    intent: 'quotation',
    source: 'typed',
    fields: {
      customerName: '王总',
      productName: '2块8',
      quantity: '3000',
      unitPrice: '2.8'
    },
    missing_fields: [],
    low_confidence_fields: []
  }, {
    source: 'typed',
    normalizedText: '报给王总拖鞋3000双2块8'
  });
  assert(dirtyProduct.status === 'NEEDS_AI', `price-like product should route to AI, got ${dirtyProduct.status}`);
  assert(dirtyProduct.low_confidence_fields.includes('productName'), 'price-like product should mark productName low confidence');

  const semantic = parseInput({
    text: '王总拖鞋3000双，价格还是上次那个，颜色要淡一点',
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  assert(semantic.local_parse_safety.status === 'NEEDS_AI', `history price and requirement should need AI, got ${semantic.local_parse_safety.status}`);
  assert(semantic.ai_fallback.needed === true, 'semantic typed case should request AI when available');

  const paste = parseInput({
    text: '王总拖鞋3000双2块8',
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(paste.local_parse_safety.status === 'NEEDS_AI', `paste source should directly need AI, got ${paste.local_parse_safety.status}`);
  assert(paste.ai_fallback.needed === true, 'paste source should mark AI needed');
  console.log('本地解析安全门控测试通过：5 条');
}

function runClipboardChatTests() {
  const noBusinessChat = `海马
2026年06月29日 14:51
再试试

李子树🌳
2026年06月29日 14:53
好用了

海马
2026年06月29日 14:53
震动吗

海马
2026年06月29日 14:53
有波纹吗

李子树🌳
2026年06月29日 14:53
没感觉

李子树🌳
2026年06月29日 14:53
就是长按可以

李子树🌳
2026年06月29日 14:53
不长按也可以

海马
2026年06月29日 14:53
右上滑跳转了吗`;
  const noBusiness = analyzeClipboardText(noBusinessChat);
  assert(noBusiness.status === 'no_business', `test chat should be no_business, got ${noBusiness.status}`);
  assert(noBusiness.lineCount > 20, `test chat should keep multiple lines, got ${noBusiness.lineCount}`);
  assert(noBusiness.messageCount >= 8, `test chat should detect messages, got ${noBusiness.messageCount}`);
  assert(!noBusiness.extractedText, `test chat should not extract business text, got ${noBusiness.extractedText}`);
  const pendingResult = buildNoBusinessPasteResult(noBusiness);
  assert(pendingResult.intent === 'unknown', `no business paste should be unknown, got ${pendingResult.intent}`);
  assert(pendingResult.original_text.includes('右上滑跳转了吗'), 'no business paste should preserve raw chat');
  assert(pendingResult.fields.remark.includes('没感觉'), 'no business paste remark should preserve raw chat');

  const singleMessageChat = `海马
2026年06月30日 12:55
你好`;
  const singleAnalysis = analyzeClipboardText(singleMessageChat);
  assert(singleAnalysis.messageCount === 1, `single chat should detect one message, got ${singleAnalysis.messageCount}`);
  assert(isSingleMessageClipboard(singleAnalysis), 'single chat should be marked as single-message clipboard');
  assertIncludes(getSingleMessagePasteTip(), '长按输入框', 'single-message tip should guide direct textarea paste');

  const orderChat = `王总
2026年06月29日 14:51
水杯要500个

海马
2026年06月29日 14:52
7天后交，20一个`;
  const orderAnalysis = analyzeClipboardText(orderChat);
  assert(orderAnalysis.status === 'ok', `order chat should extract business text, got ${orderAnalysis.status}`);
  assert(orderAnalysis.customerNameFromChat === '王总', `order chat customer should keep speaker name, got ${orderAnalysis.customerNameFromChat}`);
  assert(orderAnalysis.structuredDraft.intent === 'order', `order chat structured draft should be order, got ${orderAnalysis.structuredDraft.intent}`);
  assert(orderAnalysis.structuredDraft.productName === '水杯', `order chat structured product should be 水杯, got ${orderAnalysis.structuredDraft.productName}`);
  assert(orderAnalysis.structuredDraft.quantity === '500', `order chat structured quantity should be 500, got ${orderAnalysis.structuredDraft.quantity}`);
  assert(orderAnalysis.structuredDraft.unit === '个', `order chat structured unit should be 个, got ${orderAnalysis.structuredDraft.unit}`);
  assert(orderAnalysis.structuredDraft.unitPrice === '20', `order chat structured unit price should be 20, got ${orderAnalysis.structuredDraft.unitPrice}`);
  assertIncludes(orderAnalysis.structuredDraft.dueText, '7天后', 'order chat structured due text should keep delivery date');
  assert(getClipboardDisplayText(orderAnalysis) === orderAnalysis.rawText, 'paste display text should preserve full raw chat');
  assertNotIncludes(getClipboardDisplayText(orderAnalysis), '王总：水杯要500个', 'paste display text should not be replaced by extracted snippet');
  assertIncludes(orderAnalysis.extractedText, '王总', 'order chat should keep customer speaker');
  assertIncludes(orderAnalysis.extractedText, '水杯要500个', 'order chat should keep product and quantity');
  assertIncludes(orderAnalysis.extractedText, '7天后交', 'order chat should merge adjacent delivery message');

  const parsed = parseInput({
    text: orderAnalysis.extractedText,
    rawText: orderAnalysis.rawText,
    extractedText: orderAnalysis.extractedText,
    pasteMeta: getPasteMeta(orderAnalysis),
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(parsed.original_text.includes('\n'), 'paste original text should preserve line breaks');
  assert(parsed.fields.customerName === '王总', `paste parser should keep titled chat speaker, got ${parsed.fields.customerName}`);
  assert(parsed.fields.remark.includes('海马'), 'paste remark should keep raw chat');
  assert(parsed.extracted_text.includes('水杯要500个'), 'paste parse result should expose extracted text');

  const fragmentedChat = `海马
2026年06月30日 12:55
你好

李子树🌳
2026年06月30日 12:55
你好我想问下箱子

海马
2026年06月30日 12:55
想要多少

李子树🌳
2026年06月30日 12:55
500个

李子树🌳
2026年06月30日 12:55
多少钱一个

海马
2026年06月30日 12:55
59`;
  const fragmentedAnalysis = analyzeClipboardText(fragmentedChat);
  assert(isWechatChatText(fragmentedChat), 'fragmented chat should be detected as wechat chat text');
  assert(fragmentedAnalysis.status === 'ok', `fragmented chat should extract business text, got ${fragmentedAnalysis.status}`);
  assert(fragmentedAnalysis.customerNameFromChat === '李子树', `fragmented chat customer should preserve nickname, got ${fragmentedAnalysis.customerNameFromChat}`);
  assert(fragmentedAnalysis.structuredDraft.intent === 'quotation', `fragmented chat structured draft should be quotation, got ${fragmentedAnalysis.structuredDraft.intent}`);
  assert(fragmentedAnalysis.structuredDraft.productName === '箱子', `fragmented chat structured product should be 箱子, got ${fragmentedAnalysis.structuredDraft.productName}`);
  assert(fragmentedAnalysis.structuredDraft.quantity === '500', `fragmented chat structured quantity should be 500, got ${fragmentedAnalysis.structuredDraft.quantity}`);
  assert(fragmentedAnalysis.structuredDraft.unit === '个', `fragmented chat structured unit should be 个, got ${fragmentedAnalysis.structuredDraft.unit}`);
  assert(fragmentedAnalysis.structuredDraft.unitPrice === '59', `fragmented chat structured unit price should be 59, got ${fragmentedAnalysis.structuredDraft.unitPrice}`);
  assert(fragmentedAnalysis.messageCount === 6, `fragmented chat should detect 6 messages, got ${fragmentedAnalysis.messageCount}`);
  assertIncludes(fragmentedAnalysis.extractedText, '箱子', 'fragmented chat should keep product');
  assertIncludes(fragmentedAnalysis.extractedText, '500个', 'fragmented chat should keep quantity');
  assertIncludes(fragmentedAnalysis.extractedText, '59一个', 'fragmented chat should infer unit price from price answer');
  assertIncludes(getClipboardDiagnostics(fragmentedAnalysis), '6 条消息', 'clipboard diagnostics should show message count');
  const fragmentedParsed = parseInput({
    text: fragmentedAnalysis.extractedText,
    rawText: fragmentedAnalysis.rawText,
    extractedText: fragmentedAnalysis.extractedText,
    pasteMeta: getPasteMeta(fragmentedAnalysis),
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(fragmentedParsed.intent === 'quotation', `fragmented chat should become quotation, got ${fragmentedParsed.intent}`);
  assert(fragmentedParsed.fields.customerName === '李子树', `fragmented chat customer should be 李子树, got ${fragmentedParsed.fields.customerName}`);
  assert(fragmentedParsed.fields.productName === '箱子', `fragmented chat product should be 箱子, got ${fragmentedParsed.fields.productName}`);
  assert(fragmentedParsed.fields.quantity === '500', `fragmented chat quantity should be 500, got ${fragmentedParsed.fields.quantity}`);
  assert(fragmentedParsed.fields.unitPrice === '59', `fragmented chat unit price should be 59, got ${fragmentedParsed.fields.unitPrice}`);

  const maoPriceChat = `张三
2026年06月30日 13:00
想问下扣子

海马
2026年06月30日 13:01
要多少

张三
2026年06月30日 13:02
一千件

张三
2026年06月30日 13:03
单价多少

海马
2026年06月30日 13:04
3毛8`;
  const maoAnalysis = analyzeClipboardText(maoPriceChat);
  assert(maoAnalysis.status === 'ok', `mao price chat should extract business text, got ${maoAnalysis.status}`);
  assert(maoAnalysis.structuredDraft.customerNameFromChat === '张三', `mao price chat customer should be 张三, got ${maoAnalysis.structuredDraft.customerNameFromChat}`);
  assert(maoAnalysis.structuredDraft.productName === '扣子', `mao price chat product should be 扣子, got ${maoAnalysis.structuredDraft.productName}`);
  assert(maoAnalysis.structuredDraft.quantity === '1000', `mao price chat quantity should be 1000, got ${maoAnalysis.structuredDraft.quantity}`);
  assert(maoAnalysis.structuredDraft.unit === '件', `mao price chat unit should be 件, got ${maoAnalysis.structuredDraft.unit}`);
  assert(maoAnalysis.structuredDraft.unitPrice === '0.38', `mao price chat unit price should be 0.38, got ${maoAnalysis.structuredDraft.unitPrice}`);
  assertIncludes(maoAnalysis.extractedText, '0.38一件', 'mao price display should follow quantity unit');
  const maoParsed = parseInput({
    text: maoAnalysis.extractedText,
    rawText: maoAnalysis.rawText,
    extractedText: maoAnalysis.extractedText,
    pasteMeta: getPasteMeta(maoAnalysis),
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(maoParsed.intent === 'quotation', `mao price chat should become quotation, got ${maoParsed.intent}`);
  assert(maoParsed.fields.customerName === '张三', `mao price chat customer should be 张三, got ${maoParsed.fields.customerName}`);
  assert(maoParsed.fields.productName === '扣子', `mao price chat product should be 扣子, got ${maoParsed.fields.productName}`);
  assert(maoParsed.fields.quantity === '1000', `mao price chat quantity should be 1000, got ${maoParsed.fields.quantity}`);
  assert(maoParsed.fields.unit === '件', `mao price chat unit should be 件, got ${maoParsed.fields.unit}`);
  assert(maoParsed.fields.unitPrice === '0.38', `mao price chat unit price should be 0.38, got ${maoParsed.fields.unitPrice}`);
  assert(maoParsed.fields.amount === '380', `mao price chat amount should be 380, got ${maoParsed.fields.amount}`);
  console.log('粘贴聊天提取测试通过：15 条');
}

function runQueryTests() {
  const state = buildQueryState();
  const cases = [
    { question: '谁还欠我钱？', includes: ['陈总', '刘总', '老李', '剩余'], excludes: ['王总'] },
    { question: '陈总欠我多少？', includes: ['陈总', '15000'] },
    { question: '月底前要收哪些款？', includes: ['陈总', '刘总'], excludes: ['老李'] },
    { question: '这周要交哪些货？', includes: ['马总', '杯垫', '待生产'] },
    { question: '马总的单子现在怎么样了？', includes: ['马总', '杯垫', '300', '待生产'] },
    { question: '王总上次报多少？', includes: ['王总', '卡通水杯', '5.5', '5500'] },
    { question: '哪些报价还没转订单？', includes: ['王总', '卡通水杯', '5500'] },
    { question: '刘总还剩多少钱没收？', includes: ['刘总', '剩余2000'] },
    { question: '今天有什么事？', includes: ['今天有', '款要处理', '批货快到交期', '待办提醒', '待整理'] },
    { question: '明天有什么待办？', includes: ['明日待办', '跟进周姐礼品盒'] },
    { question: '有哪些待办没做？', includes: ['回复周姐礼品盒报价', '跟进周姐礼品盒'] },
    { question: '有没有待整理的记录？', includes: ['有 1 条待整理记录', '孙总欠款一玩五'] }
  ];
  cases.forEach((item, index) => runQueryCase(state, item, index));
  console.log(`问一句核心样例通过：${cases.length} 条`);
}

function buildRequestForTest(text, state) {
  const localResult = parseInput({
    text,
    source: 'typed',
    context: 'home',
    state
  });
  const policy = getContextPolicy(text, localResult);
  const scopedHistory = findScopedHistory(state, localResult.fields.customerName, policy);
  const historyStatus = policy === 'none' ? 'not_required' : (scopedHistory.found ? 'found' : 'not_found');
  const localWithHistory = Object.assign({}, localResult, {
    history_status: historyStatus
  });
  return {
    localResult,
    policy,
    scopedHistory,
    requestPayload: buildAiRequestPayload({
      text,
      source: 'typed',
      context: 'home'
    }, localWithHistory, scopedHistory)
  };
}

function runContextPolicyTests() {
  const stateWithHistory = buildHistoryState();
  const newOrder = buildRequestForTest('王总定300个杯子5天后要货5毛一个', stateWithHistory);
  assert(newOrder.policy === 'none', `new order policy should be none, got ${newOrder.policy}`);
  assert(!newOrder.requestPayload.customerCandidates, 'new order should not send customer candidates');
  assert(!newOrder.requestPayload.businessContext, 'new order should not send business context');

  const newReceivable = buildRequestForTest('陈总：有未结清应收 15000，月底到期', stateWithHistory);
  assert(newReceivable.policy === 'none', `new receivable policy should be none, got ${newReceivable.policy}`);
  assert(!newReceivable.requestPayload.customerCandidates, 'new receivable should not send customer candidates');
  assert(!newReceivable.requestPayload.businessContext, 'new receivable should not send business context');

  const replenishment = buildRequestForTest('老王补300个杯垫', stateWithHistory);
  assert(replenishment.policy === 'customer_history', `replenishment policy should be customer_history, got ${replenishment.policy}`);
  assert(replenishment.scopedHistory.found, 'replenishment should find 老王 history');
  const replenishmentText = JSON.stringify(replenishment.requestPayload);
  assertIncludes(replenishmentText, '老王', 'replenishment context should include 老王');
  assertNotIncludes(replenishmentText, '马总', 'replenishment context should not include 马总');
  assertNotIncludes(replenishmentText, 'quo_ma', 'replenishment context should not include 马总 quotation');

  const stateWithoutLaoWangHistory = buildHistoryState({ includeLaoWangHistory: false });
  const noHistory = buildRequestForTest('老王补300个杯垫', stateWithoutLaoWangHistory);
  assert(noHistory.policy === 'customer_history', `no-history policy should be customer_history, got ${noHistory.policy}`);
  assert(!noHistory.scopedHistory.found, 'no-history replenishment should not find history');
  assert(!noHistory.requestPayload.customerCandidates, 'no-history replenishment should not send customer candidates');
  assert(!noHistory.requestPayload.businessContext, 'no-history replenishment should not send business context');

  const paymentWithHistory = buildRequestForTest('老王还我4000还剩2000', stateWithHistory);
  assert(paymentWithHistory.policy === 'receivable_history', `payment policy should be receivable_history, got ${paymentWithHistory.policy}`);
  assert(paymentWithHistory.scopedHistory.found, 'payment should find 老王 receivable');
  const paymentText = JSON.stringify(paymentWithHistory.requestPayload);
  assertIncludes(paymentText, 'rec_laowang', 'payment context should include 老王 receivable');
  assertNotIncludes(paymentText, '马总', 'payment context should not include 马总');

  const noReceivableState = buildHistoryState({ includeLaoWangReceivable: false });
  const noReceivable = buildRequestForTest('老王还我4000还剩2000', noReceivableState);
  assert(noReceivable.policy === 'receivable_history', `no-receivable policy should be receivable_history, got ${noReceivable.policy}`);
  assert(!noReceivable.scopedHistory.found, 'no-receivable payment should not find old receivable');
  assert(!noReceivable.requestPayload.customerCandidates, 'no-receivable payment should not send customer candidates');
  assert(!noReceivable.requestPayload.businessContext, 'no-receivable payment should not send business context');

  console.log('背景策略与 scoped payload 测试通过：6 条');
}

function runDisplayTextTests() {
  const messyFields = ['customerId', 'customerName', 'productName', 'spec', 'unit', 'paymentMethod', 'dueDate'];
  const text = getMissingText(messyFields, {
    customerName: '老王',
    productName: '老款杯垫',
    unit: '个'
  });
  assert(text === '交期/到期日', `display text should hide internal/filled fields, got ${text}`);

  const pendingText = getMissingText(['dueDate', 'unitPrice'], {
    customerName: '老王',
    productName: '老款杯垫',
    quantity: '500',
    unit: '个'
  });
  assert(pendingText === '单价、交期/到期日', `pending missing text should be Chinese labels, got ${pendingText}`);
  assert(getIntentDraftLabel('order') === '订单草稿', `order draft label should be Chinese, got ${getIntentDraftLabel('order')}`);
  assert(getIntentDraftLabel('todo') === '待办提醒草稿', `todo draft label should be Chinese, got ${getIntentDraftLabel('todo')}`);
  assertIncludes(getPendingReasonText({ guessedIntent: 'order', reason: '用户选择稍后整理' }), '订单');
  assertIncludes(getPendingReasonText({ guessedIntent: 'todo', reason: '用户选择稍后整理' }), '待办提醒');
  console.log('字段展示中文化测试通过：6 条');
}

function runTodoSaveTests() {
  const state = buildEmptyBusinessState();
  const parseResult = parseInput({
    text: '周姐问500套礼品盒，单价3.8，明天给她回',
    source: 'typed',
    context: 'home',
    state
  });
  const saved = saveConfirmedDraft(state, parseResult);
  assert(saved.type === 'todo', `todo should save formally, got ${saved.type}`);
  assert(state.todos.length === 1, `todo should be saved, got ${state.todos.length}`);
  assertIncludes(state.todos[0].title, '回复周姐礼品盒报价', `todo title should be friendly, got ${state.todos[0].title}`);
  assert(state.todos[0].status === '待办', `todo status should be 待办, got ${state.todos[0].status}`);
  const dashboardBeforeComplete = getDashboard(state);
  assert(dashboardBeforeComplete.todoActive.length === 1, `dashboard should count active todos, got ${dashboardBeforeComplete.todoActive.length}`);
  assert(dashboardBeforeComplete.todoTomorrow.length === 1, `dashboard should list tomorrow todos, got ${dashboardBeforeComplete.todoTomorrow.length}`);
  const completed = completeTodo(state, state.todos[0].id);
  assert(completed && completed.status === '已完成', 'todo should be marked completed');
  const dashboardAfterComplete = getDashboard(state);
  assert(dashboardAfterComplete.todoActive.length === 0, `completed todo should leave active list, got ${dashboardAfterComplete.todoActive.length}`);
  console.log('待办提醒保存测试通过：8 条');
}

function runCustomerIdentityTests() {
  const oneCustomerState = buildEmptyBusinessState([
    { id: 'cus_wang', name: '王总', isTemporary: true }
  ]);
  const savedWithOneMatch = saveConfirmedDraft(oneCustomerState, buildOrderDraft());
  assert(savedWithOneMatch.type === 'order', `single matched customer should save order, got ${savedWithOneMatch.type}`);
  assert(oneCustomerState.customers.length === 1, `single match should not create duplicate customer, got ${oneCustomerState.customers.length}`);
  assert(oneCustomerState.orders[0].customerId === 'cus_wang', `order should attach to cus_wang, got ${oneCustomerState.orders[0].customerId}`);

  const duplicateState = buildEmptyBusinessState([
    { id: 'cus_wang_a', name: '王总', isTemporary: true },
    { id: 'cus_wang_b', name: '王总', isTemporary: true }
  ]);
  const pending = saveConfirmedDraft(duplicateState, buildOrderDraft());
  assert(pending.type === 'pending', `duplicate names without selected customer should become pending, got ${pending.type}`);
  assert(duplicateState.orders.length === 0, 'duplicate names without selected customer should not save an order');

  const selected = saveConfirmedDraft(duplicateState, buildOrderDraft({ customerId: 'cus_wang_b' }));
  assert(selected.type === 'order', `selected duplicate customer should save order, got ${selected.type}`);
  assert(duplicateState.orders[0].customerId === 'cus_wang_b', `selected order should attach to cus_wang_b, got ${duplicateState.orders[0].customerId}`);

  const created = saveConfirmedDraft(duplicateState, buildOrderDraft({
    forceNewCustomer: true,
    customerNote: '眼镜厂王总'
  }));
  assert(created.type === 'order', `new duplicate customer should save order, got ${created.type}`);
  assert(duplicateState.customers[0].wechatRemark === '眼镜厂王总', `new duplicate should keep note, got ${duplicateState.customers[0].wechatRemark}`);
  assert(duplicateState.orders[0].customerId === duplicateState.customers[0].id, 'new duplicate order should attach to the created customer id');

  const mergeState = buildEmptyBusinessState([
    { id: 'cus_keep', name: '王总', isTemporary: true },
    { id: 'cus_merge', name: '王总', isTemporary: true }
  ]);
  mergeState.orders.push(
    { id: 'ord_keep', customerId: 'cus_keep', productName: '杯子', status: '待生产', requiredDeliveryDate: addDays(today(), 3) },
    { id: 'ord_merge', customerId: 'cus_merge', productName: '杯垫', status: '待生产', requiredDeliveryDate: addDays(today(), 4) }
  );
  mergeState.quotations.push({ id: 'quo_merge', customerId: 'cus_merge', productName: '水杯' });
  mergeState.receivables.push({ id: 'rec_merge', customerId: 'cus_merge', amount: '1000', paidAmount: '0', status: '待收' });
  mergeState.paymentRecords.push({ id: 'pay_merge', customerId: 'cus_merge', amount: '200' });
  const merged = mergeCustomer(mergeState, 'cus_keep', 'cus_merge');
  assert(merged && merged.id === 'cus_keep', 'merge should keep target customer');
  assert(mergeState.customers.find((item) => item.id === 'cus_merge').mergedInto === 'cus_keep', 'merged source should be hidden');
  ['orders', 'quotations', 'receivables', 'paymentRecords'].forEach((collection) => {
    assert(mergeState[collection].every((item) => item.customerId !== 'cus_merge'), `${collection} should be reassigned`);
  });
  const query = answerQuery('王总的单子现在怎么样了？', mergeState);
  const queryText = `${query.title}\n${query.lines.join('\n')}`;
  assertIncludes(queryText, '杯子', 'merged query should include keep customer order');
  assertIncludes(queryText, '杯垫', 'merged query should include merged customer order');
  console.log('客户重名与合并测试通过：5 条');
}

function buildConfirmationStateForTest(state, parseResult, intent, fields) {
  const file = path.resolve(__dirname, '../pages/input/input.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = {
    require: createRequire(file),
    console,
    Page: () => {},
    wx: {},
    result: null
  };
  vm.runInNewContext(`${code}\nresult = buildConfirmationState(${JSON.stringify(state)}, ${JSON.stringify(parseResult)}, ${JSON.stringify(intent)}, ${JSON.stringify(fields)});`, sandbox);
  return sandbox.result;
}

function loadPageFunction(relativeFile, functionName) {
  const file = path.resolve(__dirname, relativeFile);
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = {
    require: createRequire(file),
    console,
    Page: () => {},
    wx: {},
    result: null
  };
  vm.runInNewContext(`${code}\nresult = ${functionName};`, sandbox);
  return sandbox.result;
}

function runInputCustomerHistoryTests() {
  const state = buildEmptyBusinessState([
    { id: 'cus_wang', name: '王总', isTemporary: true }
  ]);
  state.orders.push({
    id: 'ord_old',
    customerId: 'cus_wang',
    productName: '杯垫',
    quantity: '500',
    unit: '个',
    requiredDeliveryDate: addDays(today(), 2),
    status: '待生产'
  });
  const draft = buildOrderDraft();
  const blocked = buildConfirmationStateForTest(state, draft, draft.intent, draft.fields);
  assert(blocked.showCustomerMatchBox, 'existing customer should show customer match box');
  assert(blocked.customerHistoryTitle.includes('已有 1 笔订单'), `history title should mention existing order, got ${blocked.customerHistoryTitle}`);
  assert(blocked.showCustomerHistoryConfirm, 'existing order should require explicit new-order confirmation');
  assert(blocked.disableFormalSave, 'existing order should block formal save before confirmation');

  const newCustomerBlocked = buildConfirmationStateForTest(state, draft, draft.intent, Object.assign({}, draft.fields, {
    forceNewCustomer: true
  }));
  assert(newCustomerBlocked.showCustomerPicker, 'new customer from existing history should show customer picker');
  assert(newCustomerBlocked.showCustomerDisambiguationField, 'new customer from existing history should ask for discriminator');
  assert(newCustomerBlocked.customerMatchWarningText.includes('补手机号或客户区分备注'), `new customer warning should ask for discriminator, got ${newCustomerBlocked.customerMatchWarningText}`);
  assert(newCustomerBlocked.disableFormalSave, 'new customer without discriminator should block formal save');

  const newCustomerReady = buildConfirmationStateForTest(state, draft, draft.intent, Object.assign({}, draft.fields, {
    forceNewCustomer: true,
    customerNote: '义乌一区王总'
  }));
  assert(!newCustomerReady.disableFormalSave, 'new customer with discriminator should allow formal save');

  const confirmed = buildConfirmationStateForTest(state, draft, draft.intent, Object.assign({}, draft.fields, {
    customerId: 'cus_wang',
    customerHistoryConfirmed: true
  }));
  assert(!confirmed.disableFormalSave, 'confirmed new order should allow formal save');
  assert(!confirmed.showCustomerHistoryConfirm, 'confirmed new order should hide confirmation button');
  console.log('客户历史确认卡测试通过：1 条');
}

function runQuotationFollowupTests() {
  const state = buildEmptyBusinessState();
  const parseResult = parseInput({
    text: '给陈老板报价，杯垫300个，9毛',
    source: 'typed',
    context: 'home',
    state
  });
  const confirmation = buildConfirmationStateForTest(state, parseResult, parseResult.intent, parseResult.fields);
  assert(confirmation.parseResult.intent === 'quotation', `quotation followup should keep quotation intent, got ${confirmation.parseResult.intent}`);
  assert(confirmation.showFollowupDaysField, 'quotation confirmation should show followup days field');
  assert(!confirmation.showDueDateField, 'quotation confirmation should not show generic due date field');
  assert(confirmation.fields.followupDays === '2', `quotation followup default should be 2 days, got ${confirmation.fields.followupDays}`);
  assert(confirmation.selectedFollowupDayIndex === 1, `quotation followup picker should select 2 days, got ${confirmation.selectedFollowupDayIndex}`);
  assert(confirmation.fields.dueDate === addDays(today(), 2), `quotation followup date should default to 2 days later, got ${confirmation.fields.dueDate}`);
  assertIncludes(confirmation.followupWarningText, '默认 2 天后跟进');

  const changed = buildConfirmationStateForTest(state, parseResult, parseResult.intent, Object.assign({}, confirmation.fields, {
    followupDays: '5'
  }));
  assert(changed.selectedFollowupDayIndex === 4, `changed followup picker should select 5 days, got ${changed.selectedFollowupDayIndex}`);
  assert(changed.fields.dueDate === addDays(today(), 5), `changed followup days should update date, got ${changed.fields.dueDate}`);

  const saved = saveConfirmedDraft(state, confirmation.parseResult);
  assert(saved.type === 'quotation', `quotation followup should save quotation, got ${saved.type}`);
  assert(state.quotations[0].followupDays === '2', `saved quotation should keep followupDays, got ${state.quotations[0].followupDays}`);
  assert(state.quotations[0].deliveryDate === addDays(today(), 2), `saved quotation should keep followup date, got ${state.quotations[0].deliveryDate}`);
  console.log('报价跟进时间测试通过：10 条');
}

function runListFilterTests() {
  const filterOrders = loadPageFunction('../pages/orders/orders.js', 'filterOrders');
  const filterQuotations = loadPageFunction('../pages/quotations/quotations.js', 'filterQuotations');
  const current = today();
  const soon = addDays(current, 2);
  const later = addDays(current, 5);
  const overdue = addDays(current, -1);

  const orders = [
    {
      id: 'ord_wang',
      customerDisplay: '王总（临时客户）',
      customer: { name: '王总' },
      productName: '杯子',
      spec: '白色',
      orderDate: current,
      requiredDeliveryDate: later,
      status: '待生产'
    },
    {
      id: 'ord_ma',
      customerDisplay: '马总',
      customer: { name: '马总' },
      productName: '杯垫',
      spec: '老款',
      orderDate: addDays(current, -1),
      requiredDeliveryDate: soon,
      status: '待生产'
    },
    {
      id: 'ord_overdue',
      customerDisplay: '陈总',
      customer: { name: '陈总' },
      productName: '礼品盒',
      orderDate: addDays(current, -2),
      requiredDeliveryDate: overdue,
      status: '待生产'
    },
    {
      id: 'ord_done',
      customerDisplay: '刘总',
      customer: { name: '刘总' },
      productName: '挂件',
      orderDate: current,
      requiredDeliveryDate: soon,
      status: '已完成'
    }
  ];
  assert(filterOrders(orders, { keyword: '王' })[0].id === 'ord_wang', 'orders should filter keyword by customer');
  assert(filterOrders(orders, { keyword: '杯垫' })[0].id === 'ord_ma', 'orders should filter keyword by product');
  assert(filterOrders(orders, { customer: '王' })[0].id === 'ord_wang', 'orders should filter by customer');
  assert(filterOrders(orders, { product: '杯垫' })[0].id === 'ord_ma', 'orders should filter by product');
  assert(filterOrders(orders, { orderDate: current })[0].id === 'ord_wang', 'orders should filter by order date');
  assert(filterOrders(orders, { dueDate: soon })[0].id === 'ord_ma', 'orders should filter by delivery date');
  const deliverySoonIds = filterOrders(orders, { preset: 'deliverySoon' }).map((item) => item.id);
  assert(deliverySoonIds.includes('ord_ma'), 'deliverySoon preset should include orders due within 3 days');
  assert(deliverySoonIds.includes('ord_overdue'), 'deliverySoon preset should include overdue orders');
  assert(!deliverySoonIds.includes('ord_wang'), 'deliverySoon preset should exclude later orders');
  assert(!deliverySoonIds.includes('ord_done'), 'deliverySoon preset should exclude completed orders');

  const quotations = [
    {
      id: 'quo_wang',
      customerDisplay: '王总',
      customer: { name: '王总' },
      productName: '水杯',
      spec: '卡通',
      quoteDate: '2026-06-23',
      deliveryDate: '2026-06-30'
    },
    {
      id: 'quo_chen',
      customerDisplay: '陈总',
      customer: { name: '陈总' },
      productName: '钥匙扣',
      spec: '金属',
      quoteDate: '2026-06-21',
      deliveryDate: '2026-06-27'
    }
  ];
  assert(filterQuotations(quotations, { keyword: '陈' })[0].id === 'quo_chen', 'quotations should filter keyword by customer');
  assert(filterQuotations(quotations, { keyword: '水杯' })[0].id === 'quo_wang', 'quotations should filter keyword by product');
  assert(filterQuotations(quotations, { customer: '陈' })[0].id === 'quo_chen', 'quotations should filter by customer');
  assert(filterQuotations(quotations, { product: '水杯' })[0].id === 'quo_wang', 'quotations should filter by product');
  assert(filterQuotations(quotations, { quoteDate: '2026-06-21' })[0].id === 'quo_chen', 'quotations should filter by quote date');
  assert(filterQuotations(quotations, { dueDate: '2026-06-30' })[0].id === 'quo_wang', 'quotations should filter by delivery date');

  console.log('订单/报价筛选测试通过：16 条');
}

function runNavigationStateTests() {
  const previousGetApp = global.getApp;
  const app = { globalData: {} };
  global.getApp = () => app;
  try {
    requestOrderFilterReset();
    assert(consumeOrderFilterReset(), 'other page should request order filter reset');
    assert(!consumeOrderFilterReset(), 'order filter reset should be one-time');

    requestOrderFilterReset();
    setNextOrderFilter({ preset: 'deliverySoon', label: '货快到期' });
    assert(!consumeOrderFilterReset(), 'deliverySoon route should cancel ordinary reset flag');
    const routeFilter = consumeNextOrderFilter();
    assert(routeFilter && routeFilter.preset === 'deliverySoon', 'deliverySoon route filter should be consumed');
    assert(!consumeNextOrderFilter(), 'deliverySoon route filter should be one-time');
  } finally {
    global.getApp = previousGetApp;
  }
  console.log('订单入口状态测试通过：5 条');
}

function runTodoPageTests() {
  const groupTodos = loadPageFunction('../pages/todos/todos.js', 'groupTodos');
  const current = today();
  const state = {
    customers: [
      { id: 'cus_zhou', name: '周姐' }
    ],
    todos: [
      { id: 'todo_overdue', customerId: 'cus_zhou', title: '催周姐确认', remindDate: addDays(current, -1), status: '待办' },
      { id: 'todo_today', customerId: 'cus_zhou', title: '今天回复周姐', remindDate: current, status: '待办' },
      { id: 'todo_tomorrow', customerId: 'cus_zhou', title: '明天跟进周姐', remindDate: addDays(current, 1), status: '待办' },
      { id: 'todo_later', customerId: 'cus_zhou', title: '下周跟进周姐', remindDate: addDays(current, 7), status: '待办' },
      { id: 'todo_done', customerId: 'cus_zhou', title: '已完成事项', remindDate: current, status: '已完成' }
    ]
  };
  const groups = groupTodos(state);
  assert(groups.overdueTodos.length === 1, `todo page should show 1 overdue, got ${groups.overdueTodos.length}`);
  assert(groups.todayTodos.length === 1, `todo page should show 1 today, got ${groups.todayTodos.length}`);
  assert(groups.tomorrowTodos.length === 1, `todo page should show 1 tomorrow, got ${groups.tomorrowTodos.length}`);
  assert(groups.laterTodos.length === 1, `todo page should show 1 later, got ${groups.laterTodos.length}`);
  assert(groups.todayTodos[0].customerDisplay.includes('周姐'), `todo page should decorate customer display, got ${groups.todayTodos[0].customerDisplay}`);
  console.log('待办提醒页面测试通过：5 条');
}

function runHomeWorkbenchTests() {
  const current = today();
  const state = {
    customers: [
      { id: 'cus_zhang', name: '张总', company: '义乌市启航贸易有限公司' },
      { id: 'cus_li', name: '李总', company: '义乌盛旺工艺品有限公司' }
    ],
    quotations: [
      {
        id: 'quo_li',
        customerId: 'cus_li',
        productName: '礼品盒',
        totalAmount: '1900',
        quoteDate: addDays(current, -4),
        status: '待确认',
        createdAt: `${current}T09:00:00.000Z`
      }
    ],
    orders: [
      {
        id: 'ord_li',
        customerId: 'cus_li',
        productName: '包装袋',
        requiredDeliveryDate: addDays(current, 2),
        status: '待生产',
        createdAt: `${current}T10:00:00.000Z`
      }
    ],
    receivables: [
      {
        id: 'rec_zhang',
        customerId: 'cus_zhang',
        amount: '38500',
        paidAmount: '0',
        dueDate: current,
        status: '待收',
        createdAt: `${current}T08:00:00.000Z`
      }
    ],
    paymentRecords: [],
    dunningRecords: [],
    todos: [
      {
        id: 'todo_li',
        customerId: 'cus_li',
        title: '确认打样',
        remindDate: current,
        status: '未完成',
        createdAt: `${current}T11:00:00.000Z`
      }
    ],
    pendingNotes: [
      {
        id: 'pending_1',
        status: '待整理',
        originalText: '客户说晚点补数量',
        createdAt: `${current}T12:00:00.000Z`
      }
    ],
    aiParseLogs: [
      {
        id: 'log_1',
        originalText: '收到张总尾款38500',
        action: 'save_payment',
        createdAt: `${current}T13:00:00.000Z`
      }
    ]
  };

  const tasks = buildTodayTasks(state, 3);
  assert(tasks.length === 3, `home tasks should show 3 items, got ${tasks.length}`);
  assert(tasks[0].type === 'receivable', `first home task should be receivable, got ${tasks[0].type}`);
  assert(tasks.some((item) => item.type === 'order'), 'home tasks should include delivery-soon order');
  assert(tasks.some((item) => item.type === 'quotation'), 'home tasks should include quotation followup');

  const recent = buildRecentRecords(state, 3);
  assert(recent[0].title.includes('张总尾款'), `recent records should prefer parse logs, got ${recent[0].title}`);
  const orderRecords = buildAllRecords(state, 'order');
  assert(orderRecords.length === 1 && orderRecords[0].title.includes('包装袋'), 'record filter should return order records');
  console.log('首页工作台数据测试通过：6 条');
}

function runFinanceTests() {
  const current = today();
  const depositState = buildEmptyBusinessState();
  const orderWithDepositDraft = parseInput({
    text: '王总订1000个水杯，5块一个，先付定金1000，月底交',
    source: 'typed',
    context: 'home',
    state: depositState
  });
  const savedOrderWithDeposit = saveConfirmedDraft(depositState, orderWithDepositDraft);
  assert(savedOrderWithDeposit.type === 'order', `order with deposit should save as order, got ${savedOrderWithDeposit.type}`);
  const depositOrder = depositState.orders[0];
  assert(depositState.paymentRecords.length === 1, `order deposit should create one payment record, got ${depositState.paymentRecords.length}`);
  assert(depositState.paymentRecords[0].kind === 'deposit', `payment kind should be deposit, got ${depositState.paymentRecords[0].kind}`);
  assert(depositState.paymentRecords[0].orderId === depositOrder.id, 'deposit payment should link to order');
  assertNumber(getOrderDepositAmount(depositState, depositOrder.id), 1000, 'order deposit amount');
  let depositFinance = buildFinanceViewModel(depositState);
  assert(depositFinance.summary.productionSettlementAmount === 4000, `deposit should reduce production settlement to 4000, got ${depositFinance.summary.productionSettlementAmount}`);
  assert(depositFinance.paymentRows[0].kindLabel === '定金', `payment row should label deposit, got ${depositFinance.paymentRows[0].kindLabel}`);

  const extraDepositDraft = parseInput({
    text: '王总水杯订单又转了200定金',
    source: 'typed',
    context: 'home',
    state: depositState
  });
  const savedExtraDeposit = saveConfirmedDraft(depositState, extraDepositDraft);
  assert(savedExtraDeposit.type === 'order_deposit', `extra deposit should save as order_deposit, got ${savedExtraDeposit.type}`);
  assertNumber(getOrderDepositAmount(depositState, depositOrder.id), 1200, 'extra order deposit amount');

  const depositReceivable = generateReceivableFromOrder(depositState, depositOrder.id);
  assert(depositReceivable.status === '部分收款', `deposit receivable should be partial, got ${depositReceivable.status}`);
  assertNumber(depositReceivable.paidAmount, 1200, 'generated receivable paid amount should include deposits');
  assert(depositState.paymentRecords.every((item) => item.receivableId === depositReceivable.id), 'deposit records should be linked to generated receivable');
  depositFinance = buildFinanceViewModel(depositState);
  assert(depositFinance.receivableRows[0].remainingAmount === 3800, `deposit receivable remaining should be 3800, got ${depositFinance.receivableRows[0].remainingAmount}`);
  const depositQuery = answerQuery('王总这个订单收了多少定金？', depositState);
  assertIncludes(depositQuery.lines.join('\n'), '已收定金1200元', 'deposit query should include paid deposit');
  const settlementQuery = answerQuery('生产中的货还有多少尾款没收？', buildEmptyBusinessState());
  assertIncludes(settlementQuery.lines.join('\n'), '当前没有生产中待结算订单', 'empty settlement query should be readable');

  const flowState = buildEmptyBusinessState([
    { id: 'cus_fin', name: '周总', company: '义乌财务测试厂' }
  ]);
  flowState.orders.push(
    {
      id: 'ord_fin',
      customerId: 'cus_fin',
      productName: '水杯',
      quantity: '100',
      unit: '个',
      totalAmount: '1000',
      requiredDeliveryDate: addDays(current, 2),
      status: '生产中',
      createdAt: `${current}T09:00:00.000Z`
    },
    {
      id: 'ord_ship',
      customerId: 'cus_fin',
      productName: '杯垫',
      quantity: '200',
      unit: '个',
      totalAmount: '800',
      requiredDeliveryDate: current,
      status: '已发货',
      createdAt: `${current}T10:00:00.000Z`
    }
  );

  let finance = buildFinanceViewModel(flowState);
  assert(finance.summary.productionSettlementAmount === 1000, `production settlement should be 1000, got ${finance.summary.productionSettlementAmount}`);
  assert(finance.stats.shippedPendingAmount === 800, `shipped pending should be 800, got ${finance.stats.shippedPendingAmount}`);
  assert(finance.settlementRows.length === 2, `settlement rows should include two orders, got ${finance.settlementRows.length}`);

  const receivable = generateReceivableFromOrder(flowState, 'ord_fin');
  assert(receivable && receivable.source === 'order', `order receivable source should be order, got ${receivable && receivable.source}`);
  finance = buildFinanceViewModel(flowState);
  assert(finance.settlementRows.length === 1, `generated order should leave settlement rows, got ${finance.settlementRows.length}`);
  assert(finance.receivableRows.some((item) => item.id === receivable.id), 'generated receivable should enter finance receivable rows');

  recordPayment(flowState, receivable.id, '400');
  finance = buildFinanceViewModel(flowState);
  assert(finance.summary.monthlyPaymentAmount === 400, `monthly payment should be 400, got ${finance.summary.monthlyPaymentAmount}`);
  assert(finance.stats.partialRemainingAmount === 600, `partial remaining should be 600, got ${finance.stats.partialRemainingAmount}`);
  recordPayment(flowState, receivable.id, '600');
  finance = buildFinanceViewModel(flowState);
  assert(flowState.receivables[0].status === '已结清', `receivable should be settled, got ${flowState.receivables[0].status}`);
  assert(finance.stats.settledThisMonthCount === 1, `settled count should be 1, got ${finance.stats.settledThisMonthCount}`);

  const legacyState = buildEmptyBusinessState();
  const legacyDraft = parseInput({
    text: '王总以前欠我5000，月底结',
    source: 'typed',
    context: 'home',
    state: legacyState
  });
  const saved = saveConfirmedDraft(legacyState, legacyDraft);
  assert(saved.type === 'receivable', `legacy debt should save as receivable, got ${saved.type}`);
  assert(legacyState.receivables[0].source === 'legacy', `legacy debt source should be legacy, got ${legacyState.receivables[0].source}`);
  finance = buildFinanceViewModel(legacyState);
  assert(finance.receivableRows[0].sourceLabel === '历史应收', `legacy source label should be 历史应收, got ${finance.receivableRows[0].sourceLabel}`);
  console.log('财务页面和定金数据测试通过');
}

function runHybridMergeTests() {
  const text = '老王补500个老款杯垫，9毛，三天后给他';
  const localResult = parseInput({
    text,
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const merged = normalizeAiResult(localResult, {
    intent: 'order',
    fields: {
      customerId: 'cus_ma',
      customerName: '马总',
      productName: '杯垫',
      quantity: '500',
      unit: '个',
      unitPrice: '0.9',
      amount: '450',
      dueDate: '2026-06-25',
      remark: '补500个老款杯垫，9毛，三天后给他'
    },
    missing_fields: [],
    low_confidence_fields: [],
    intent_candidates: [{ intent: 'order' }],
    provider: 'server'
  });

  assert(merged.fields.customerName === '老王', `hybrid merge should keep 老王, got ${merged.fields.customerName}`);
  assert(!merged.fields.customerId, `hybrid merge should drop wrong customerId, got ${merged.fields.customerId}`);
  assert(merged.original_text === text, `hybrid merge should preserve original text, got ${merged.original_text}`);
  assertIncludes(merged.fields.remark, '补500个', `hybrid merge should keep a useful business remark, got ${merged.fields.remark}`);
  assert(merged.intent_candidates[0] === 'order', `hybrid merge should normalize intent candidate objects, got ${merged.intent_candidates[0]}`);
  console.log('远程合并保护测试通过：1 条');
}

async function runHybridSkipTests() {
  const result = await parseHybridInput({
    text: '老王补500个老款杯垫，9毛，三天后给他',
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  assert(result.fields.customerName === '老王', `hybrid skip should keep 老王, got ${result.fields.customerName}`);
  assert(result.fields.remark === '老王补500个老款杯垫，9毛，三天后给他', `hybrid skip should keep original remark, got ${result.fields.remark}`);
  assert(result.ai_fallback.status === 'not_requested', `hybrid skip should not request remote AI, got ${result.ai_fallback.status}`);
  console.log('高置信本地识别跳过远程测试通过：1 条');
}

async function runWechatAiRoutingTests() {
  const finalPriceChat = `王总
2026年07月01日 09:10
这个水杯多少钱

海马
2026年07月01日 09:12
30一个

王总
2026年07月01日 09:14
贵了，25一个可以吗

海马
2026年07月01日 09:15
可以，就25一个，先做1000个，月底交`;
  const analysis = analyzeClipboardText(finalPriceChat);
  assert(analysis.rawMessages.length === 4, `rawMessages should keep 4 chat messages, got ${analysis.rawMessages.length}`);
  const localResult = await parseHybridInput({
    text: analysis.extractedText,
    rawText: analysis.rawText,
    extractedText: analysis.extractedText,
    pasteMeta: getPasteMeta(analysis),
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(localResult.ai_fallback.status === 'skipped_no_endpoint', `multi-message paste should request AI when available, got ${localResult.ai_fallback.status}`);
  assert(localResult.ai_fallback.needed === true, 'multi-message paste should mark AI fallback as needed');
  assert(localResult.intent === 'order', `local fallback should infer final order intent, got ${localResult.intent}`);
  assert(localResult.fields.quantity === '1000', `local fallback should keep final quantity 1000, got ${localResult.fields.quantity}`);
  assert(localResult.fields.unitPrice === '25', `local fallback should show final candidate price 25, got ${localResult.fields.unitPrice}`);
  assert(localResult.fields.dueDate, 'local fallback should parse final delivery date');
  assert(localResult.field_conflicts.length === 1, `local fallback should flag price conflict, got ${JSON.stringify(localResult.field_conflicts)}`);
  assert(localResult.field_conflicts[0].field === 'unitPrice', `price conflict should be unitPrice, got ${localResult.field_conflicts[0].field}`);
  const blocked = buildConfirmationStateForTest({ customers: [] }, localResult, localResult.intent, localResult.fields);
  assert(blocked.showFieldConflicts, 'confirmation should show field conflict lines');
  assert(blocked.disableFormalSave, 'field conflicts should block formal save');

  const colorChat = `王总
2026年07月01日 09:10
杯子1000个，颜色要淡一点，不要太深

海马
2026年07月01日 09:12
好的，25一个，月底交`;
  const colorAnalysis = analyzeClipboardText(colorChat);
  const colorResult = await parseHybridInput({
    text: colorAnalysis.extractedText,
    rawText: colorAnalysis.rawText,
    extractedText: colorAnalysis.extractedText,
    pasteMeta: getPasteMeta(colorAnalysis),
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(colorResult.remark_items.length === 1, `color requirement should become remark item, got ${JSON.stringify(colorResult.remark_items)}`);
  assertIncludes(colorResult.fields.remark, '客户要求：', 'local fallback remark should start with summarized requirement');
  assertIncludes(colorResult.fields.remark, '颜色要淡一点', 'local fallback remark should include color requirement');

  const merged = normalizeAiResult(localResult, {
    provider: 'ai',
    intent: 'order',
    fields: {
      customerName: '王总',
      productName: '水杯',
      quantity: '1000',
      unit: '个',
      unitPrice: '25',
      dueDate: today(),
      remark: '客户确认：单价25一个，先做1000个。'
    },
    field_conflicts: [],
    superseded_facts: [
      { field: 'unitPrice', oldValue: '30', newValue: '25', reason: '后续已确认25一个' }
    ],
    remark_items: [
      { text: '客户确认：先做1000个' }
    ],
    field_evidence: {
      unitPrice: [{ messageIndex: 3, text: '可以，就25一个，先做1000个，月底交' }]
    },
    low_confidence_fields: [],
    missing_fields: []
  });
  assert(!merged.field_conflicts.length, 'AI resolved result should clear local field conflicts');
  assert(merged.fields.unitPrice === '25', `AI resolved unit price should be 25, got ${merged.fields.unitPrice}`);
  assert(merged.fields.amount === '25000', `AI resolved amount should be recomputed to 25000, got ${merged.fields.amount}`);
  assert(merged.superseded_facts.length === 1, 'AI resolved result should keep superseded fact');
  assertIncludes(merged.fields.remark, '单价25', 'AI remark should not be overwritten by raw chat');
  console.log('微信多轮 AI 路由与冲突保护测试通过：16 条');
}

async function runHistoryWarningTests() {
  const historyOrder = await parseHybridInput({
    text: '老王补300个杯垫',
    source: 'typed',
    context: 'home',
    state: buildHistoryState()
  });
  assert(historyOrder.history_status === 'found', `order history status should be found, got ${historyOrder.history_status}`);
  assert(historyOrder.fields.unitPrice === '0.8', `history default should fill unitPrice 0.8, got ${historyOrder.fields.unitPrice}`);
  assert(historyOrder.fields.dueDate === addDays(today(), 3), `history default should fill dueDate, got ${historyOrder.fields.dueDate}`);
  assert(historyOrder.fields.amount === '240', `history default should compute amount 240, got ${historyOrder.fields.amount}`);
  assert(historyOrder.history_defaulted_fields.includes('unitPrice'), 'history defaulted fields should include unitPrice');
  assert(historyOrder.history_defaulted_fields.includes('dueDate'), 'history defaulted fields should include dueDate');
  assertIncludes(historyOrder.history_default_warning_text, '已按老王上次杯垫记录默认填入');

  const confirmation = buildConfirmationStateForTest(buildHistoryState(), historyOrder, historyOrder.intent, historyOrder.fields);
  assert(confirmation.showHistoryDefaultWarning, 'confirmation should show history default warning');
  assert(confirmation.historyDefaultFieldMap.unitPrice, 'confirmation should highlight history unitPrice');
  assert(confirmation.historyDefaultFieldMap.dueDate, 'confirmation should highlight history dueDate');

  const noHistoryOrder = await parseHybridInput({
    text: '老王补300个杯垫',
    source: 'typed',
    context: 'home',
    state: buildHistoryState({ includeLaoWangHistory: false })
  });
  assert(noHistoryOrder.history_status === 'not_found', `order history status should be not_found, got ${noHistoryOrder.history_status}`);
  assertIncludes(noHistoryOrder.history_warning_text, '没有找到老王的历史订单/报价');

  const noReceivable = await parseHybridInput({
    text: '老王还我4000还剩2000',
    source: 'typed',
    context: 'home',
    state: buildHistoryState({ includeLaoWangReceivable: false })
  });
  assert(noReceivable.history_status === 'not_found', `receivable history status should be not_found, got ${noReceivable.history_status}`);
  assertIncludes(noReceivable.history_warning_text, '应收总额6000元');
  assert(noReceivable.fields.customerName === '老王', `history warning payment should keep 老王, got ${noReceivable.fields.customerName}`);
  console.log('历史缺失和默认带出测试通过：13 条');
}

async function main() {
  runParseTests();
  runLocalParseSafetyTests();
  runClipboardChatTests();
  runQueryTests();
  runContextPolicyTests();
  runDisplayTextTests();
  runTodoSaveTests();
  runCustomerIdentityTests();
  runInputCustomerHistoryTests();
  runQuotationFollowupTests();
  runListFilterTests();
  runNavigationStateTests();
  runTodoPageTests();
  runHomeWorkbenchTests();
  runFinanceTests();
  runHybridMergeTests();
  await runHybridSkipTests();
  await runWechatAiRoutingTests();
  await runHistoryWarningTests();
  console.log('核心功能测试全部通过');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
