const { parseInput } = require('../utils/parser');
const { answerQuery } = require('../utils/query');
const {
  completeTodo,
  convertQuotationToOrder,
  buildOrderEditDraft,
  generateDunningMessage,
  generateReceivableFromOrder,
  getDashboard,
  getItemsSummary,
  getOrderDepositAmount,
  getOrderRemainingSettlement,
  getRecordItems,
  getReceivablePaymentError,
  mergeCustomer,
  recordPayment,
  saveConfirmedDraft,
  softDeleteRecord,
  setOrderDeliveryDate,
  updateOrderStatus
} = require('../utils/business');
const { askHybridQuery } = require('../utils/ai-query');
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
const { buildRecordDetail, getRecordDetailUrl } = require('../utils/record-detail');
const { CANONICAL_UNITS, normalizeUnit } = require('../utils/units');
const {
  buildCustomerOrderStats,
  enrichOrdersWithPayments,
  sortOrders
} = require('../utils/order-insights');
const {
  ensureProductCatalog,
  getCatalogCheck,
  getProductCatalog,
  getProductSuggestions,
  getSpecSuggestions,
  removeCatalogItem,
  saveManualCatalogItem
} = require('../utils/product-catalog');

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
    low_confidence_fields: [],
    // 此构造器模拟用户已经在确认卡上逐项确认，而不是模拟一轮未核对的自动识别。
    manual_fields: ['customerName', 'productName', 'quantity', 'unitPrice', 'dueDate']
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
    { text: '给王总报钥匙扣1000个，1.2元一个，7月18日跟进。', intent: 'quotation', customer: '王总', product: '钥匙扣', quantity: 1000, unitPrice: 1.2, amount: 1200, dueDateRequired: true },
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
    { text: '王总收到尾款1000元。', intent: 'payment', customer: '王总', paymentAmount: 1000 },
    { text: '王总那笔货款今天到账15000，结清了', intent: 'payment', customer: '王总', paymentAmount: 15000, dueDateRequired: true },
    { text: '老李先打1万，剩下月底', intent: 'payment', customer: '老李', paymentAmount: 10000, dueDateRequired: true },
    { text: '张总要一千个杯子五块五月底交', intent: 'order', customer: '张总', product: '杯子', quantity: 1000, unitPrice: 5.5, amount: 5500, dueDateRequired: true },
    { text: '赵总要订二千个挂件，一块五，礼拜五出', intent: 'order', customer: '赵总', product: '挂件', quantity: 2000, unitPrice: 1.5, amount: 3000, dueDateRequired: true },
    { text: '钱总报架，水杯500个，6块一个', intent: 'quotation', customer: '钱总', product: '水杯', quantity: 500, unitPrice: 6, amount: 3000 },
    { text: '给钱总报收纳盒1200个，1.2元一个', intent: 'quotation', customer: '钱总', product: '收纳盒', quantity: 1200, unitPrice: 1.2, amount: 1440 },
    { text: '收纳盒1200个报给钱总，单价1.2元', intent: 'quotation', customer: '钱总', product: '收纳盒', quantity: 1200, unitPrice: 1.2, amount: 1440 },
    { text: '钱总问收纳盒1200个多少钱，报1.2元一个', intent: 'quotation', customer: '钱总', product: '收纳盒', quantity: 1200, unitPrice: 1.2, amount: 1440 },
    { text: '孙总欠款一玩五，月底节', intent: 'receivable', customer: '孙总', amountBlank: true, dueDateRequired: true, missingIncludes: ['amount'] },
    { text: '吴总定了3000个扣子，三毛五，周六拿', intent: 'order', customer: '吴总', product: '扣子', quantity: 3000, unitPrice: 0.35, amount: 1050, dueDateRequired: true },
    { text: '郑总说按上次那个价格，先做500个', intent: 'order', customer: '郑总', quantity: 500, unitPriceBlank: true, lowIncludes: ['unitPrice'], missingIncludes: ['productName', 'dueDate'] }
  ];
  cases.forEach(runParseCase);
  console.log(`记一笔核心样例通过：${cases.length} 条`);
}

function runMultiSpecAndWholesaleUnitTests() {
  const emptyState = () => buildEmptyBusinessState();
  const parseOrder = (text, state = emptyState()) => parseInput({
    text,
    source: 'typed',
    context: 'home',
    state
  });

  const singleSpec = parseOrder('王总要50个拉布布，紫色的，30一个，后天交');
  assert(singleSpec.intent === 'order', 'single-spec input should be recognized as an order');
  assert(singleSpec.fields.productName === '拉布布', `single-spec product should be 拉布布, got ${singleSpec.fields.productName}`);
  assert(singleSpec.fields.spec === '紫色', `single-spec value should be 紫色, got ${singleSpec.fields.spec}`);
  assert(singleSpec.fields.items.length === 1 && singleSpec.fields.items[0].spec === '紫色', 'single specification should be stored in items[0]');
  assert(singleSpec.fields.priceUnit === '个', `single-spec price unit should be 个, got ${singleSpec.fields.priceUnit}`);
  assertNumber(singleSpec.fields.amount, 1500, 'single-spec order amount');

  const multiState = emptyState();
  const multiSpec = parseOrder('王总要拉布布，紫色30个，红色10个，30一个，后天交', multiState);
  assert(multiSpec.fields.items.length === 2, `multi-spec input should produce two items, got ${multiSpec.fields.items.length}`);
  assert(multiSpec.fields.items[0].spec === '紫色' && multiSpec.fields.items[1].spec === '红色', 'multi-spec input should preserve both colors');
  assertNumber(multiSpec.fields.items[0].totalAmount, 900, 'purple item subtotal');
  assertNumber(multiSpec.fields.items[1].totalAmount, 300, 'red item subtotal');
  assertNumber(multiSpec.fields.amount, 1200, 'multi-spec order total');
  const saved = saveConfirmedDraft(multiState, multiSpec);
  assert(saved.type === 'order' && multiState.orders.length === 1, `multi-spec confirmation should save an order, got ${saved.type}`);
  const savedOrder = multiState.orders[0];
  assert(getRecordItems(savedOrder).length === 2, 'saved order should retain both specification lines');
  assertIncludes(getItemsSummary(savedOrder), '紫色30个', 'saved order summary should include purple quantity');
  assertIncludes(getItemsSummary(savedOrder), '红色10个', 'saved order summary should include red quantity');
  const detail = buildRecordDetail(multiState, 'order', savedOrder.id);
  assert(detail.items.length === 2 && detail.items[1].spec === '红色', 'order detail should retain every saved specification');
  const query = answerQuery('王总紫色订单现在怎么样？', multiState);
  const queryText = `${query.title}\n${query.lines.join('\n')}`;
  assertIncludes(queryText, '拉布布 · 紫色', 'query should find an order by its specification');
  assertIncludes(queryText, '拉布布 · 红色', 'query should show the full matched multi-spec order');

  const differentPrices = parseOrder('王总要拉布布，紫色30个9元一个，红色10个8元一个，后天交');
  assertNumber(differentPrices.fields.items[0].unitPrice, 9, 'purple unit price');
  assertNumber(differentPrices.fields.items[1].unitPrice, 8, 'red unit price');
  assertNumber(differentPrices.fields.amount, 350, 'multi-spec different-price total');

  const unitCases = [
    ['王总要3打发圈，24元一打，后天交', '3', '打', '24', '打', 72],
    ['王总要2托盘水杯，1000元一托，后天交', '2', '托盘', '1000', '托盘', 2000],
    ['王总要1柜饰品，20000元一柜，后天交', '1', '柜', '20000', '柜', 20000],
    ['王总要50磅五金，3元一磅，后天交', '50', '磅', '3', '磅', 150],
    ['王总要100平方米地毯，30元一平方米，后天交', '100', '平方米', '30', '平方米', 3000],
    ['王总要20升洗衣液，8元一升，后天交', '20', '升', '8', '升', 160],
    ['王总要5立方米木材，900元一方，后天交', '5', '立方米', '900', '立方米', 4500],
    ['王总要2千支螺丝，120元一千支，后天交', '2', '千支', '120', '千支', 240]
  ];
  unitCases.forEach(([text, quantity, unit, unitPrice, priceUnit, amount]) => {
    const result = parseOrder(text);
    assert(result.fields.quantity === quantity, `${text}: quantity expected ${quantity}, got ${result.fields.quantity}`);
    assert(result.fields.unit === unit, `${text}: unit expected ${unit}, got ${result.fields.unit}`);
    assert(result.fields.unitPrice === unitPrice, `${text}: unitPrice expected ${unitPrice}, got ${result.fields.unitPrice}`);
    assert(result.fields.priceUnit === priceUnit, `${text}: priceUnit expected ${priceUnit}, got ${result.fields.priceUnit}`);
    assertNumber(result.fields.amount, amount, `${text}: amount`);
  });

  const colloquialSingleCounter = parseOrder('王总下单礼品盒100套，3.8元一个，下周五交');
  assert(colloquialSingleCounter.fields.priceUnit === '套', '口语“100套、3.8元一个”应结合当前商品按套计价');
  assertNumber(colloquialSingleCounter.fields.amount, 380, '口语单件计数单位金额');
  assert(!colloquialSingleCounter.field_conflicts.some((item) => item.field === 'priceUnit'), '口语“一个”不应误报套转个冲突');

  const explicitPerPiece = parseOrder('王总下单礼品盒100套，3.8元每个，下周五交');
  assert(explicitPerPiece.fields.priceUnit === '个', '明确“每个”时必须保留按个计价');
  assert(!explicitPerPiece.fields.amount, '明确按个且数量按套时不能自动换算金额');
  assert(explicitPerPiece.field_conflicts.some((item) => item.field === 'priceUnit'), '明确的套/个单位差异必须要求确认');

  const userRequestedUnits = [
    '个', '只', '支', '件', '套', '台', '盒', '瓶', '罐', '桶', '打', '箱', '包', '袋', '捆', '扎',
    '斤', '公斤', '吨', '磅', '米', '码', '卷', '平方米', '平方尺', '张', '升', '立方米', '车', '柜',
    '托盘', '匹', '令', '两', '克', '千支', '条', '头'
  ];
  userRequestedUnits.forEach((unit) => assert(CANONICAL_UNITS.includes(unit), `wholesale unit table should include ${unit}`));
  assert(normalizeUnit('千克') === '公斤', '千克 should normalize to 公斤');
  assert(normalizeUnit('㎡') === '平方米', '㎡ should normalize to 平方米');
  assert(normalizeUnit('m³') === '立方米', 'm³ should normalize to 立方米');
  assert(normalizeUnit('托') === '托盘', '托 should normalize to 托盘');

  const mismatch = parseOrder('王总要3打发圈，2元一个，后天交');
  assert(!mismatch.fields.amount && !mismatch.fields.items[0].totalAmount, 'different quantity/price units must not be auto-converted');
  assert(mismatch.low_confidence_fields.includes('priceUnit'), 'unit mismatch should require confirmation');
  assert(mismatch.field_conflicts.some((item) => item.field === 'priceUnit'), 'unit mismatch should explain the conflict');
  const mismatchState = emptyState();
  const manuallyConfirmed = Object.assign({}, mismatch, {
    fields: Object.assign({}, mismatch.fields, {
      amount: '72',
      totalAmount: '72',
      items: mismatch.fields.items.map((item) => Object.assign({}, item, { totalAmount: '72' }))
    }),
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    manual_fields: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'dueDate']
  });
  const confirmedMismatch = saveConfirmedDraft(mismatchState, manuallyConfirmed);
  assert(confirmedMismatch.type === 'order', `manual item subtotal should allow saving a unit-mismatch order, got ${confirmedMismatch.type}`);
  assertNumber(mismatchState.orders[0].totalAmount, 72, 'manually confirmed mismatch total');
  assertIncludes(mismatchState.orders[0].originalText, '3打发圈', 'multi-unit save should preserve original text');

  console.log(`多规格与批发计量单位测试通过：${unitCases.length + 24} 条`);
}

function runRecordActionsAndOrderEditTests() {
  const state = buildEmptyBusinessState([
    { id: 'cus_edit', name: '王总', isTemporary: true }
  ]);
  state.orders.push({
    id: 'ord_edit',
    customerId: 'cus_edit',
    productName: '拉布布',
    spec: '紫色',
    quantity: '30',
    unit: '个',
    unitPrice: '30',
    priceUnit: '个',
    totalAmount: '1200',
    items: [
      { productName: '拉布布', spec: '紫色', quantity: '30', unit: '个', unitPrice: '30', priceUnit: '个', totalAmount: '900' },
      { productName: '拉布布', spec: '红色', quantity: '10', unit: '个', unitPrice: '30', priceUnit: '个', totalAmount: '300' }
    ],
    requiredDeliveryDate: addDays(today(), 2),
    expectedShipDate: addDays(today(), 2),
    status: '待生产',
    originalText: '王总要拉布布，紫色30个，红色10个，30一个，后天交'
  });
  state.orderProgress.push({ id: 'prog_edit', orderId: 'ord_edit', status: '待生产', note: '创建订单' });

  const editDraft = buildOrderEditDraft(state, 'ord_edit');
  assert(editDraft && editDraft.operation === 'update_order', 'active edit should target the exact saved order');
  assert(editDraft.fields.items.length === 2, 'active edit should load all specification lines');
  editDraft.fields.items[1].quantity = '20';
  editDraft.fields.items[1].totalAmount = '600';
  editDraft.fields.amount = '1500';
  editDraft.fields.totalAmount = '1500';
  editDraft.fields.dueDate = addDays(today(), 4);
  editDraft.fields.remark = '红色改为20个';
  const edited = saveConfirmedDraft(state, editDraft);
  assert(edited.type === 'order' && state.orders.length === 1, `active edit should update instead of creating a second order, got ${edited.type}`);
  assert(state.orders[0].items[1].quantity === '20', 'active edit should save changed specification quantity');
  assertNumber(state.orders[0].totalAmount, 1500, 'active edit total');
  assert(state.orders[0].requiredDeliveryDate === addDays(today(), 4), 'active edit should save changed delivery date');
  assertIncludes(state.orders[0].originalText, '紫色30个', 'active edit should preserve original input');
  assert(state.operationLogs.some((item) => item.action === 'update_order' && item.recordId === 'ord_edit'), 'active edit should append an operation log');

  state.receivables.push({ id: 'rec_edit', orderId: 'ord_edit', customerId: 'cus_edit', amount: '1500', paidAmount: '300', status: '部分收款' });
  state.paymentRecords.push({ id: 'pay_edit', orderId: 'ord_edit', receivableId: 'rec_edit', customerId: 'cus_edit', amount: '300', kind: 'deposit' });
  const financialEdit = buildOrderEditDraft(state, 'ord_edit');
  financialEdit.fields.amount = '1600';
  financialEdit.fields.totalAmount = '1600';
  financialEdit.fields.items[1].totalAmount = '700';
  const blockedEdit = saveConfirmedDraft(state, financialEdit);
  assert(blockedEdit.type === 'error', `changing the total after payment should be blocked, got ${blockedEdit.type}`);
  assertIncludes(blockedEdit.error, '已有定金、收款或待收', 'blocked financial edit should explain why');
  assert(state.pendingNotes.length === 0, 'blocked active edit must not create a misleading pending note');
  assertNumber(state.orders[0].totalAmount, 1500, 'blocked edit should not mutate order money');

  const blockedOrderDelete = softDeleteRecord(state, 'order', 'ord_edit');
  assert(!blockedOrderDelete.ok, 'order with financial links must not be directly deleted');
  const blockedReceivableDelete = softDeleteRecord(state, 'receivable', 'rec_edit');
  assert(!blockedReceivableDelete.ok, 'receivable with payments must not be directly deleted');
  const deletedPayment = softDeleteRecord(state, 'payment', 'pay_edit');
  assert(deletedPayment.ok, 'payment should support confirmed deletion');
  assert(state.paymentRecords.length === 0, 'deleted payment should leave the active payment list');
  assertNumber(state.receivables[0].paidAmount, 0, 'deleting payment should roll back received amount');
  assert(state.receivables[0].status === '待收', `deleting the only payment should restore 待收, got ${state.receivables[0].status}`);
  assert(state.deletedRecords.some((item) => item.recordType === 'payment' && item.recordId === 'pay_edit'), 'deleted payment should remain recoverable in deletedRecords');
  const deletedReceivable = softDeleteRecord(state, 'receivable', 'rec_edit');
  assert(deletedReceivable.ok && state.receivables.length === 0, 'receivable without payments should be deletable');

  state.todos.push({ id: 'todo_delete', title: '提醒王总确认颜色', status: '待办' });
  const deletedTodo = softDeleteRecord(state, 'todo', 'todo_delete');
  assert(deletedTodo.ok && state.todos.length === 0, 'simple reminder should be removed from its active list');
  assert(state.operationLogs.some((item) => item.action === 'delete_record' && item.recordId === 'todo_delete'), 'record deletion should append an operation log');

  const quoteState = buildEmptyBusinessState([{ id: 'cus_quote', name: '周姐' }]);
  quoteState.quotations.push({ id: 'quo_delete_order', customerId: 'cus_quote', status: '已转订单', convertedOrderId: 'ord_from_quote' });
  quoteState.orders.push({ id: 'ord_from_quote', customerId: 'cus_quote', quotationId: 'quo_delete_order', status: '待生产', totalAmount: '100' });
  quoteState.orderProgress.push({ id: 'prog_quote', orderId: 'ord_from_quote', status: '待生产' });
  const deletedConvertedOrder = softDeleteRecord(quoteState, 'order', 'ord_from_quote');
  assert(deletedConvertedOrder.ok, 'converted order without money links should be deletable');
  assert(quoteState.quotations[0].status === '待确认' && !quoteState.quotations[0].convertedOrderId, 'deleting a converted order should restore its quotation safely');
  assert(quoteState.orderProgress.length === 0, 'deleted order progress should move into the delete archive');
  assert(quoteState.deletedRecords[0].related.orderProgress.length === 1, 'delete archive should retain related order progress');

  console.log('订单主动修改、右滑删除与操作日志测试通过：25 条');
}

function runProductCatalogTests() {
  const empty = buildEmptyBusinessState();
  assert(getProductCatalog(empty).length === 0, 'empty business data must not create fake catalog products');
  const historyState = buildEmptyBusinessState([{ id: 'cus_catalog', name: '王总' }]);
  historyState.orders.push({
    id: 'ord_catalog_history',
    customerId: 'cus_catalog',
    items: [
      { productName: '拉布布', spec: '紫色', quantity: '30', unit: '个', unitPrice: '30', priceUnit: '个' },
      { productName: '拉布布', spec: '红色', quantity: '10', unit: '个', unitPrice: '32', priceUnit: '个' }
    ],
    createdAt: '2026-07-18T08:00:00.000Z'
  });
  const bootstrapped = ensureProductCatalog(historyState);
  assert(bootstrapped.length === 1 && bootstrapped[0].productName === '拉布布', 'catalog should bootstrap from real saved order history');
  assert(bootstrapped[0].specs.length === 2, 'catalog bootstrap should keep all historical specifications');
  assert(bootstrapped[0].units.includes('个') && bootstrapped[0].priceUnits.includes('个'), 'catalog should learn quantity and price units separately');
  assert(getCatalogCheck(historyState, '拉布布', '紫色').status === 'known_spec', 'known product/spec should be verified by local catalog');
  assert(getCatalogCheck(historyState, '拉布布', '蓝色').status === 'new_spec', 'new specification should be clearly marked before save');
  assert(getCatalogCheck(historyState, '新商品', '').status === 'new_product', 'unknown product should be marked as first-time product, not fabricated');

  const manySpecs = Array.from({ length: 15 }, (_, index) => `款式${index + 1}`);
  const manual = saveManualCatalogItem(historyState, {
    productName: '耳饰',
    specs: manySpecs,
    units: ['对', '盒'],
    priceUnits: ['对']
  });
  assert(manual && manual.specs.length === 15, 'manual catalog should support products with many specifications');
  assert(getSpecSuggestions(historyState, '耳饰', '', 8).length === 8, 'confirmation card should limit large spec lists to a mobile-friendly first page');
  assert(getProductSuggestions(historyState, '', 6).includes('耳饰'), 'catalog should offer manually maintained products as suggestions');

  const saveStateForCatalog = buildEmptyBusinessState([{ id: 'cus_catalog_save', name: '周姐' }]);
  const orderDraft = {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: '周姐要耳饰，珍珠款20对，银色款10对，后天交',
    fields: {
      customerId: 'cus_catalog_save',
      customerName: '周姐',
      productName: '耳饰',
      spec: '珍珠款',
      quantity: '20',
      unit: '对',
      unitPrice: '10',
      priceUnit: '对',
      amount: '300',
      totalAmount: '300',
      dueDate: addDays(today(), 2),
      items: [
        { productName: '耳饰', spec: '珍珠款', quantity: '20', unit: '对', unitPrice: '10', priceUnit: '对', totalAmount: '200' },
        { productName: '耳饰', spec: '银色款', quantity: '10', unit: '对', unitPrice: '10', priceUnit: '对', totalAmount: '100' }
      ]
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: [],
    manual_fields: ['customerId', 'customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'amount', 'totalAmount', 'dueDate', 'items']
  };
  const saved = saveConfirmedDraft(saveStateForCatalog, orderDraft);
  assert(saved.type === 'order', `confirmed order should save before catalog learning, got ${saved.type}`);
  const learned = getProductCatalog(saveStateForCatalog).find((item) => item.productName === '耳饰');
  assert(learned && learned.specs.length === 2, 'confirmed multi-spec order should automatically update the local catalog');
  const confirmation = buildConfirmationStateForTest(saveStateForCatalog, orderDraft, 'order', orderDraft.fields);
  assert(confirmation.confirmItems[0].catalogHint.includes('本地商品库核对'), 'confirmation card should visibly report catalog verification');
  assert(confirmation.confirmItems[0].specSuggestions.includes('银色款'), 'confirmation card should offer other known specs for the same product');

  const removed = removeCatalogItem(historyState, manual.id);
  assert(removed && !getProductCatalog(historyState).some((item) => item.id === manual.id), 'user should be able to remove an incorrect catalog item without deleting orders');
  assert(historyState.orders.length === 1, 'catalog removal must not delete historical business records');

  console.log('本地商品/规格知识库与确认卡核对测试通过：18 条');
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

  const clearPaste = parseInput({
    text: '报给王总拖鞋3000双2块8',
    source: 'paste',
    context: 'home',
    state: { customers: [] }
  });
  assert(clearPaste.local_parse_safety.status === 'SAFE_LOCAL', `clear single paste should not be downgraded by source, got ${clearPaste.local_parse_safety.status}`);
  assert(clearPaste.ai_fallback.needed === false, 'clear single paste should not mark AI needed only because it was pasted');
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
    { question: '谁还欠我钱？', includes: ['陈总', '刘总', '老李', '还差'], excludes: ['王总'] },
    { question: '陈总欠我多少？', includes: ['陈总', '15000'] },
    { question: '月底前要收哪些款？', includes: ['陈总', '刘总'], excludes: ['老李'] },
    { question: '这周要交哪些货？', includes: ['马总', '杯垫', '待生产'] },
    { question: '马总的单子现在怎么样了？', includes: ['马总', '杯垫', '300', '待生产'] },
    { question: '王总上次报多少？', includes: ['王总', '卡通水杯', '5.5', '5500'] },
    { question: '哪些报价还没转订单？', includes: ['王总', '卡通水杯', '5500'] },
    { question: '刘总还剩多少钱没收？', includes: ['刘总', '还差2000'] },
    { question: '今天有什么事？', includes: ['今天有', '款要处理', '批货快到交期', '待办提醒', '待整理'] },
    { question: '明天有什么待办？', includes: ['明日待办', '跟进周姐礼品盒'] },
    { question: '有哪些待办没做？', includes: ['回复周姐礼品盒报价', '跟进周姐礼品盒'] },
    { question: '有没有待整理的记录？', includes: ['有 1 条待整理记录', '孙总欠款一玩五'] }
  ];
  cases.forEach((item, index) => runQueryCase(state, item, index));
  state.orders.push({
    id: 'ord_wang_multi',
    customerId: 'cus_wang',
    productName: '礼品盒',
    quantity: '500',
    unit: '套',
    totalAmount: '4364.6',
    items: [
      { productName: '礼品盒', quantity: '500', unit: '套', unitPrice: '3.8', totalAmount: '1900' },
      { productName: '饭盒', quantity: '300', unit: '个', unitPrice: '8.2', totalAmount: '2460' }
    ],
    requiredDeliveryDate: addDays(today(), 3),
    status: '待生产'
  });
  const multiOrderAnswer = answerQuery('王总的订单现在怎么样？', state);
  const multiOrderText = `${multiOrderAnswer.title}\n${multiOrderAnswer.lines.join('\n')}`;
  assertIncludes(multiOrderText, '礼品盒', 'multi-item order query should include the first item');
  assertIncludes(multiOrderText, '饭盒', 'multi-item order query should include every saved item');
  console.log(`问一句核心样例通过：${cases.length + 2} 条`);
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

function runSafeBusinessSaveTests() {
  const wrongAiState = buildEmptyBusinessState();
  const originalText = '周老板下周一要发2000个钥匙扣一块二一个';
  const weakLocalResult = parseInput({
    text: originalText,
    source: 'typed',
    context: 'home',
    state: wrongAiState
  });
  weakLocalResult.fields.customerName = '';
  weakLocalResult.fields.customerId = '';
  const wrongAiResult = normalizeAiResult(weakLocalResult, {
    provider: 'server',
    intent: 'order',
    fields: {
      customerName: '老王',
      customerId: 'cus_old_wang',
      productName: '钥匙扣',
      quantity: '2000',
      unit: '个',
      unitPrice: '1.2',
      amount: '2400'
    },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(wrongAiResult.low_confidence_fields.includes('customerName'), 'AI customer absent from original text must be marked low confidence');
  assert(!wrongAiResult.fields.customerId, 'AI customer id absent from original text must be removed');
  const wrongAiSaved = saveConfirmedDraft(wrongAiState, wrongAiResult);
  assert(wrongAiSaved.type === 'pending', `wrong AI customer must not save formally, got ${wrongAiSaved.type}`);
  assert(wrongAiState.orders.length === 0, 'wrong AI customer must not create an order');
  assert(!wrongAiState.customers.some((item) => item.name === '老王'), 'wrong AI customer must not create a customer');

  const paymentState = buildEmptyBusinessState();
  const unlinkedPayment = saveConfirmedDraft(paymentState, {
    intent: 'payment',
    operation: 'record_payment',
    source: 'typed',
    original_text: '周总今天付了2000元',
    fields: { customerName: '周总', paymentAmount: '2000' },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(unlinkedPayment.type === 'payment', `unlinked payment should still be saved, got ${unlinkedPayment.type}`);
  assert(paymentState.paymentRecords.length === 1, 'unlinked payment should create exactly one payment record');
  assert(paymentState.paymentRecords[0].kind === 'unlinked_payment', `unlinked payment kind should be explicit, got ${paymentState.paymentRecords[0].kind}`);
  assert(!paymentState.paymentRecords[0].receivableId, 'unlinked payment must not auto-write off a receivable');
  assert(paymentState.receivables.length === 0, 'unlinked payment must not create a receivable');
  assert(paymentState.paymentRecords[0].originalText === '周总今天付了2000元', 'unlinked payment must retain the original text');

  const depositState = buildEmptyBusinessState();
  const unlinkedDeposit = saveConfirmedDraft(depositState, {
    intent: 'payment',
    operation: 'record_order_deposit',
    source: 'typed',
    original_text: '陈姐收到定金500元',
    fields: { customerName: '陈姐', paymentAmount: '500', depositAmount: '500', paymentKind: 'deposit' },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(unlinkedDeposit.type === 'order_deposit', `unlinked deposit should still be saved, got ${unlinkedDeposit.type}`);
  assert(depositState.paymentRecords.length === 1, 'unlinked deposit should create exactly one payment record');
  assert(depositState.paymentRecords[0].kind === 'unlinked_deposit', `unlinked deposit kind should be explicit, got ${depositState.paymentRecords[0].kind}`);
  assert(!depositState.paymentRecords[0].orderId, 'unlinked deposit must not attach to an order automatically');
  assert(depositState.paymentRecords[0].originalText === '陈姐收到定金500元', 'unlinked deposit must retain the original text');

  const ambiguousPaymentState = buildEmptyBusinessState([{ id: 'cus_ambiguous_payment', name: '赵总' }]);
  ambiguousPaymentState.receivables.push(
    { id: 'rec_ambiguous_1', customerId: 'cus_ambiguous_payment', amount: '1000', paidAmount: '0', status: '待收' },
    { id: 'rec_ambiguous_2', customerId: 'cus_ambiguous_payment', amount: '2000', paidAmount: '0', status: '待收' }
  );
  const blockedAmbiguousPayment = saveConfirmedDraft(ambiguousPaymentState, {
    intent: 'payment',
    operation: 'record_payment',
    source: 'typed',
    original_text: '赵总转了500元',
    fields: { customerName: '赵总', customerId: 'cus_ambiguous_payment', paymentAmount: '500' },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(blockedAmbiguousPayment.type === 'pending', `ambiguous payment should stay pending, got ${blockedAmbiguousPayment.type}`);
  assert(ambiguousPaymentState.paymentRecords.length === 0, 'ambiguous payment must not become an unlinked payment by default');
  const explicitUnlinkedPayment = saveConfirmedDraft(ambiguousPaymentState, {
    intent: 'payment',
    operation: 'record_payment',
    source: 'typed',
    original_text: '赵总转了500元，先不关联旧账',
    fields: {
      customerName: '赵总',
      customerId: 'cus_ambiguous_payment',
      paymentAmount: '500',
      allowUnlinkedPayment: true,
      unlinkedPaymentCustomerId: 'cus_ambiguous_payment'
    },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(explicitUnlinkedPayment.type === 'payment', `explicit unlinked payment should save, got ${explicitUnlinkedPayment.type}`);
  assert(ambiguousPaymentState.paymentRecords[0].kind === 'unlinked_payment', 'explicit unlinked payment should be labelled clearly');
  const staleUnlinkedPaymentAuthorization = saveConfirmedDraft(ambiguousPaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '赵总又转了500元',
    fields: {
      customerName: '赵总', customerId: 'cus_ambiguous_payment', paymentAmount: '500',
      allowUnlinkedPayment: true, unlinkedPaymentCustomerId: 'cus_other_customer'
    },
    missing_fields: [], low_confidence_fields: []
  });
  assert(staleUnlinkedPaymentAuthorization.type === 'pending', 'unlinked payment authorization for another customer must be rejected');

  const mismatchedPaymentState = buildEmptyBusinessState([
    { id: 'cus_mismatch_wang', name: '王总' },
    { id: 'cus_mismatch_li', name: '李总' }
  ]);
  mismatchedPaymentState.receivables.push({
    id: 'rec_mismatch_wang', customerId: 'cus_mismatch_wang', amount: '1000', paidAmount: '0', status: '待收'
  });
  const mismatchedPayment = saveConfirmedDraft(mismatchedPaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '李总转了500元',
    fields: { customerName: '李总', receivableId: 'rec_mismatch_wang', paymentAmount: '500' },
    missing_fields: [], low_confidence_fields: []
  });
  assert(mismatchedPayment.type === 'pending', `mismatched payment customer should stay pending, got ${mismatchedPayment.type}`);
  assertNumber(mismatchedPaymentState.receivables[0].paidAmount, 0, 'mismatched payment must not write off another customer receivable');

  const ambiguousDepositState = buildEmptyBusinessState([{ id: 'cus_ambiguous_deposit', name: '钱总' }]);
  ambiguousDepositState.orders.push(
    { id: 'ord_ambiguous_1', customerId: 'cus_ambiguous_deposit', productName: '礼品盒', totalAmount: '1000', status: '待生产' },
    { id: 'ord_ambiguous_2', customerId: 'cus_ambiguous_deposit', productName: '水杯', totalAmount: '2000', status: '生产中' }
  );
  const blockedAmbiguousDeposit = saveConfirmedDraft(ambiguousDepositState, {
    intent: 'payment',
    operation: 'record_order_deposit',
    source: 'typed',
    original_text: '钱总又付定金300元',
    fields: {
      customerName: '钱总',
      customerId: 'cus_ambiguous_deposit',
      paymentAmount: '300',
      depositAmount: '300',
      paymentKind: 'deposit'
    },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(blockedAmbiguousDeposit.type === 'pending', `ambiguous deposit should stay pending, got ${blockedAmbiguousDeposit.type}`);
  assert(ambiguousDepositState.paymentRecords.length === 0, 'ambiguous deposit must not become an unlinked deposit by default');
  const explicitUnlinkedDeposit = saveConfirmedDraft(ambiguousDepositState, {
    intent: 'payment',
    operation: 'record_order_deposit',
    source: 'typed',
    original_text: '钱总又付定金300元，先不关联订单',
    fields: {
      customerName: '钱总',
      customerId: 'cus_ambiguous_deposit',
      paymentAmount: '300',
      depositAmount: '300',
      paymentKind: 'deposit',
      allowUnlinkedOrderDeposit: true,
      unlinkedOrderDepositCustomerId: 'cus_ambiguous_deposit'
    },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(explicitUnlinkedDeposit.type === 'order_deposit', `explicit unlinked deposit should save, got ${explicitUnlinkedDeposit.type}`);
  assert(ambiguousDepositState.paymentRecords[0].kind === 'unlinked_deposit', 'explicit unlinked deposit should be labelled clearly');

  const excessOrderState = buildEmptyBusinessState([{ id: 'cus_excess_order', name: '孙总' }]);
  const excessOrder = saveConfirmedDraft(excessOrderState, {
    intent: 'order',
    operation: 'create_order',
    source: 'typed',
    original_text: '孙总订礼品盒一千元，先收定金一千二',
    fields: {
      customerName: '孙总',
      customerId: 'cus_excess_order',
      productName: '礼品盒',
      amount: '1000',
      totalAmount: '1000',
      depositAmount: '1200',
      paymentAmount: '1200'
    },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(excessOrder.type === 'pending', `excess order deposit should stay pending, got ${excessOrder.type}`);
  assert(excessOrderState.orders.length === 0, 'excess order deposit must not save the order alone');
  assert(excessOrderState.paymentRecords.length === 0, 'excess order deposit must not create a payment record');

  const ambiguousPaymentCard = buildConfirmationStateForTest(ambiguousPaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '赵总转了500元',
    fields: { customerName: '赵总', customerId: 'cus_ambiguous_payment', paymentAmount: '500' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', { customerName: '赵总', customerId: 'cus_ambiguous_payment', paymentAmount: '500' });
  assert(ambiguousPaymentCard.showReceivablePicker, 'multiple receivables should show a selection picker');
  assert(ambiguousPaymentCard.disableFormalSave, 'multiple receivables should block save before an explicit choice');
  assertIncludes(ambiguousPaymentCard.receivableRange[0], '不关联本次收款', 'payment picker should offer explicit unlinked choice');
  const explicitUnlinkedPaymentCard = buildConfirmationStateForTest(ambiguousPaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '赵总转了500元',
    fields: { customerName: '赵总', customerId: 'cus_ambiguous_payment', paymentAmount: '500' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', {
    customerName: '赵总', customerId: 'cus_ambiguous_payment', paymentAmount: '500', receivableId: '__unlinked_receivable__'
  });
  assert(!explicitUnlinkedPaymentCard.disableFormalSave, 'explicit unlinked payment choice should allow save');
  assert(explicitUnlinkedPaymentCard.fields.allowUnlinkedPayment, 'explicit unlinked payment choice should reach the data layer');
  assert(explicitUnlinkedPaymentCard.fields.unlinkedPaymentCustomerId === 'cus_ambiguous_payment', 'unlinked payment choice should be bound to the selected customer');

  const singlePaymentState = buildEmptyBusinessState([{ id: 'cus_single_payment', name: '吴总' }]);
  singlePaymentState.receivables.push({
    id: 'rec_single_payment', customerId: 'cus_single_payment', amount: '1000', paidAmount: '0', status: '待收'
  });
  const singlePaymentCard = buildConfirmationStateForTest(singlePaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '吴总转了500元',
    fields: { customerName: '吴总', customerId: 'cus_single_payment', paymentAmount: '500' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', { customerName: '吴总', customerId: 'cus_single_payment', paymentAmount: '500' });
  assert(singlePaymentCard.showReceivablePicker, 'single receivable should still offer an explicit unlinked choice');
  assertIncludes(singlePaymentCard.receivableRange[0], '不关联本次收款', 'single receivable picker should offer explicit unlinked choice');
  assertIncludes(singlePaymentCard.paymentWarningText, '已找到一笔可关联待收款', 'single receivable warning should not claim there are multiple records');
  const preselectedPaymentCard = buildConfirmationStateForTest(singlePaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '吴总转了500元',
    fields: { customerName: '吴总', customerId: 'cus_single_payment', receivableId: 'rec_single_payment', paymentAmount: '500' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', {
    customerName: '吴总', customerId: 'cus_single_payment', receivableId: 'rec_single_payment', paymentAmount: '500'
  });
  assert(preselectedPaymentCard.disableFormalSave, 'preselected receivable must still require a user confirmation');
  assertIncludes(preselectedPaymentCard.paymentWarningText, '点选确认', 'preselected receivable should explain the confirmation action');
  const confirmedPaymentCard = buildConfirmationStateForTest(singlePaymentState, {
    intent: 'payment', operation: 'record_payment', source: 'typed', original_text: '吴总转了500元',
    fields: { customerName: '吴总', customerId: 'cus_single_payment', receivableId: 'rec_single_payment', paymentAmount: '500', receivableSelectionConfirmed: true },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', {
    customerName: '吴总', customerId: 'cus_single_payment', receivableId: 'rec_single_payment', paymentAmount: '500', receivableSelectionConfirmed: true
  });
  assert(!confirmedPaymentCard.disableFormalSave, 'confirmed receivable selection should allow save');

  const singleDepositState = buildEmptyBusinessState([{ id: 'cus_single_deposit', name: '郑总' }]);
  singleDepositState.orders.push({
    id: 'ord_single_deposit', customerId: 'cus_single_deposit', productName: '礼品盒', totalAmount: '1000', status: '待生产'
  });
  const singleDepositCard = buildConfirmationStateForTest(singleDepositState, {
    intent: 'payment', operation: 'record_order_deposit', source: 'typed', original_text: '郑总收到定金200元',
    fields: { customerName: '郑总', customerId: 'cus_single_deposit', paymentAmount: '200', depositAmount: '200', paymentKind: 'deposit' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', {
    customerName: '郑总', customerId: 'cus_single_deposit', paymentAmount: '200', depositAmount: '200', paymentKind: 'deposit'
  });
  assert(singleDepositCard.showOrderPicker, 'single order should still offer an explicit unlinked choice');
  assertIncludes(singleDepositCard.orderRange[0], '不关联订单', 'single order picker should offer explicit unlinked choice');
  assertIncludes(singleDepositCard.orderDepositWarningText, '已找到一笔可关联订单', 'single order warning should not claim there are multiple records');
  const preselectedDepositCard = buildConfirmationStateForTest(singleDepositState, {
    intent: 'payment', operation: 'record_order_deposit', source: 'typed', original_text: '郑总收到定金200元',
    fields: { customerName: '郑总', customerId: 'cus_single_deposit', orderId: 'ord_single_deposit', paymentAmount: '200', depositAmount: '200', paymentKind: 'deposit' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', {
    customerName: '郑总', customerId: 'cus_single_deposit', orderId: 'ord_single_deposit', paymentAmount: '200', depositAmount: '200', paymentKind: 'deposit'
  });
  assert(preselectedDepositCard.disableFormalSave, 'preselected order must still require a user confirmation');
  assertIncludes(preselectedDepositCard.orderDepositWarningText, '点选确认', 'preselected order should explain the confirmation action');

  const staleOrderIdCard = buildConfirmationStateForTest(buildEmptyBusinessState([{ id: 'cus_stale_order', name: '冯总' }]), {
    intent: 'payment', operation: 'record_order_deposit', source: 'typed', original_text: '冯总收到定金200元',
    fields: { customerName: '冯总', customerId: 'cus_stale_order', orderId: 'ord_deleted', paymentAmount: '200', depositAmount: '200', paymentKind: 'deposit' },
    missing_fields: [], low_confidence_fields: []
  }, 'payment', {
    customerName: '冯总', customerId: 'cus_stale_order', orderId: 'ord_deleted', paymentAmount: '200', depositAmount: '200', paymentKind: 'deposit'
  });
  assert(!staleOrderIdCard.fields.orderId, 'invalid prefilled order should be cleared before allowing an unlinked deposit');
  assert(!staleOrderIdCard.disableFormalSave, 'no-candidate stale order should follow the stated unlinked-deposit path');

  const excessOrderCard = buildConfirmationStateForTest(excessOrderState, {
    intent: 'order', operation: 'create_order', source: 'typed', original_text: '孙总订礼品盒一千元，先收定金一千二',
    fields: { customerName: '孙总', customerId: 'cus_excess_order', productName: '礼品盒', amount: '1000', totalAmount: '1000', depositAmount: '1200' },
    missing_fields: [], low_confidence_fields: []
  }, 'order', { customerName: '孙总', customerId: 'cus_excess_order', productName: '礼品盒', amount: '1000', totalAmount: '1000', depositAmount: '1200' });
  assert(excessOrderCard.disableFormalSave, 'excess order deposit should be blocked on the confirmation card');
  assert(excessOrderCard.parseResult.low_confidence_fields.includes('depositAmount'), 'confirmation card should flag the excess deposit field');

  const dunningState = buildEmptyBusinessState();
  const dunningDraft = parseInput({
    text: '王总欠5000明天催款',
    source: 'typed',
    context: 'home',
    state: dunningState
  });
  const dunningSaved = saveConfirmedDraft(dunningState, dunningDraft);
  assert(dunningDraft.intent === 'dunning', `dunning text should be recognized as dunning, got ${dunningDraft.intent}`);
  assert(dunningSaved.type === 'todo', `dunning should save as a todo reminder, got ${dunningSaved.type}`);
  assert(dunningState.todos[0].todoType === 'dunning', `dunning todo should retain its type, got ${dunningState.todos[0].todoType}`);
  assert(dunningState.todos[0].remindDate, 'dunning todo should retain the reminder date');
  assert(dunningState.todos[0].originalText === '王总欠5000明天催款', 'dunning todo must retain the original text');
  console.log('安全保存与催款提醒测试通过：53 条');
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
  assert(!confirmation.fields.followupDays, `quotation followup should stay empty until the user chooses it, got ${confirmation.fields.followupDays}`);
  assert(!confirmation.fields.dueDate, `quotation followup date must not be fabricated, got ${confirmation.fields.dueDate}`);
  assertIncludes(confirmation.followupWarningText, '可选；未填写时不会自动补日期');

  const changed = buildConfirmationStateForTest(state, parseResult, parseResult.intent, Object.assign({}, confirmation.fields, {
    followupDays: '5'
  }));
  assert(changed.selectedFollowupDayIndex === 4, `changed followup picker should select 5 days, got ${changed.selectedFollowupDayIndex}`);
  assert(changed.fields.dueDate === addDays(today(), 5), `changed followup days should update date, got ${changed.fields.dueDate}`);

  const saved = saveConfirmedDraft(state, confirmation.parseResult);
  assert(saved.type === 'quotation', `quotation followup should save quotation, got ${saved.type}`);
  assert(!state.quotations[0].followupDays, `saved quotation should not invent followupDays, got ${state.quotations[0].followupDays}`);
  assert(!state.quotations[0].deliveryDate, `saved quotation should not invent a followup date, got ${state.quotations[0].deliveryDate}`);
  console.log('报价跟进时间测试通过：9 条');
}

function runListFilterTests() {
  const filterOrders = loadPageFunction('../pages/orders/orders.js', 'filterOrders');
  const buildOrderQuantitySummary = loadPageFunction('../pages/orders/orders.js', 'buildOrderQuantitySummary');
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
      customerId: 'cus_wang',
      productName: '杯子',
      spec: '白色',
      totalAmount: '1000',
      orderDate: current,
      requiredDeliveryDate: later,
      actualShipDate: current,
      lastPaymentDate: current,
      receivedAmount: 500,
      status: '待生产'
    },
    {
      id: 'ord_ma',
      customerDisplay: '马总',
      customer: { name: '马总' },
      customerId: 'cus_ma',
      productName: '杯垫',
      spec: '老款',
      totalAmount: '300',
      orderDate: addDays(current, -1),
      requiredDeliveryDate: soon,
      actualShipDate: addDays(current, -1),
      lastPaymentDate: addDays(current, -2),
      receivedAmount: 100,
      status: '待生产'
    },
    {
      id: 'ord_overdue',
      customerDisplay: '陈总',
      customer: { name: '陈总' },
      customerId: 'cus_chen',
      productName: '礼品盒',
      totalAmount: '2000',
      orderDate: addDays(current, -2),
      requiredDeliveryDate: overdue,
      status: '待生产'
    },
    {
      id: 'ord_done',
      customerDisplay: '刘总',
      customer: { name: '刘总' },
      customerId: 'cus_liu',
      productName: '挂件',
      totalAmount: '',
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
  assert(filterOrders(orders, { shipDate: current })[0].id === 'ord_wang', 'orders should filter by actual ship date');
  assert(filterOrders(orders, { paymentDate: current })[0].id === 'ord_wang', 'orders should filter by latest payment date');
  assert(filterOrders(orders, { status: '已完成' })[0].id === 'ord_done', 'orders should filter by status');
  assert(filterOrders(orders, { minAmount: '500', maxAmount: '1500' })[0].id === 'ord_wang', 'orders should filter by amount range');
  const deliverySoonIds = filterOrders(orders, { preset: 'deliverySoon' }).map((item) => item.id);
  assert(deliverySoonIds.includes('ord_ma'), 'deliverySoon preset should include orders due within 3 days');
  assert(deliverySoonIds.includes('ord_overdue'), 'deliverySoon preset should include overdue orders');
  assert(!deliverySoonIds.includes('ord_wang'), 'deliverySoon preset should exclude later orders');
  assert(!deliverySoonIds.includes('ord_done'), 'deliverySoon preset should exclude completed orders');
  assert(sortOrders(orders, 'amountDesc')[0].id === 'ord_overdue', 'amount descending sort should put the largest order first');
  assert(sortOrders(orders, 'amountAsc')[0].id === 'ord_ma', 'amount ascending sort should put the smallest known order first');
  assert(sortOrders(orders, 'paymentDateDesc')[0].id === 'ord_wang', 'payment date sort should use latest linked payment date');
  assert(sortOrders(orders, 'shipDateAsc')[0].id === 'ord_ma', 'ship date sort should use actual ship date and keep missing values last');
  const customerStats = buildCustomerOrderStats(orders);
  assert(customerStats[0].customerName === '陈总' && customerStats[0].orderAmount === 2000, 'customer stats should sort by real order amount');
  assert(customerStats.find((item) => item.customerName === '王总').receivedAmount === 500, 'customer stats should sum linked received amount');
  const paymentState = {
    receivables: [{ id: 'rec_ma_filter', orderId: 'ord_ma' }],
    paymentRecords: [
      { id: 'pay_wang_filter', orderId: 'ord_wang', amount: '500', paidAt: current },
      { id: 'pay_ma_filter', receivableId: 'rec_ma_filter', amount: '100', paidAt: addDays(current, -2) }
    ]
  };
  const enriched = enrichOrdersWithPayments(paymentState, orders);
  assert(enriched.find((item) => item.id === 'ord_ma').lastPaymentDate === addDays(current, -2), 'payment date should also follow payment linked through receivable');
  assert(enriched.find((item) => item.id === 'ord_wang').receivedAmount === 500, 'order payment summary should total direct order payments');
  assert(
    buildOrderQuantitySummary([{ quantity: '30', unit: '个' }, { quantity: '10', unit: '个' }]) === '40个（2项）',
    'order list should summarize multi-spec quantities with the same unit'
  );
  assert(
    buildOrderQuantitySummary([{ quantity: '2', unit: '箱' }, { quantity: '5', unit: '件' }]) === '2箱、5件',
    'order list should not add quantities that use different units'
  );
  assert(
    buildOrderQuantitySummary([{ quantity: '30', unit: '个' }, { quantity: '', unit: '个' }]) === '30个、-个',
    'order list must not count an unknown quantity as zero'
  );

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

  console.log('订单筛选、排序、按客户统计与报价筛选测试通过：28 条');
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
        quantity: '50',
        unit: '箱',
        totalAmount: '2500',
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
  assert(orderRecords[0].summary.includes('数量 50箱'), `order record should show quantity, got ${orderRecords[0].summary}`);
  assert(orderRecords[0].summary.includes('金额 ¥2500'), `order record should show amount, got ${orderRecords[0].summary}`);
  console.log('首页工作台数据测试通过：6 条');
}

function runRecordDetailTests() {
  const state = buildEmptyBusinessState([
    { id: 'cus_wang', name: '王总', company: '义乌兴旺饰品厂' }
  ]);
  state.quotations.push({
    id: 'quo_1',
    customerId: 'cus_wang',
    productName: '礼品盒',
    quantity: '20',
    unit: '盒',
    unitPrice: '12',
    totalAmount: '240',
    quoteDate: '2026-07-18',
    originalText: '给王总报20盒礼品盒，12元一盒'
  });
  state.orders.push({
    id: 'ord_1',
    customerId: 'cus_wang',
    productName: '拉布布',
    quantity: '50',
    unit: '个',
    unitPrice: '30',
    totalAmount: '1500',
    requiredDeliveryDate: '2026-07-22',
    status: '待生产',
    originalText: '王总要50个拉布布，紫色的，30一个，后天交',
    items: [
      { productName: '拉布布', spec: '紫色', quantity: '50', unit: '个', unitPrice: '30', totalAmount: '1500' }
    ]
  });
  state.receivables.push({
    id: 'rec_1',
    customerId: 'cus_wang',
    orderId: 'ord_1',
    amount: '1500',
    paidAmount: '500',
    dueDate: '2026-07-25',
    status: '部分收款',
    originalText: '王总这单还差1000元'
  });
  state.paymentRecords.push({
    id: 'pay_1',
    customerId: 'cus_wang',
    receivableId: 'rec_1',
    amount: '500',
    paidAt: '2026-07-20',
    kind: 'receivable_payment',
    originalText: '王总付了500元'
  });
  state.todos.push({
    id: 'todo_1',
    customerId: 'cus_wang',
    title: '提醒确认颜色',
    remindDate: '2026-07-21',
    status: '未完成',
    originalText: '明天提醒我和王总确认颜色'
  });
  state.pendingNotes.push({
    id: 'pending_1',
    status: '待整理',
    guessedIntent: 'order',
    guessedFields: { productName: '耳饰' },
    originalText: '王总说耳饰数量晚点补'
  });

  const order = buildRecordDetail(state, 'order', 'ord_1');
  assert(order && order.typeLabel === '订单详情', 'order detail should load the exact order');
  assert(order.title.includes('拉布布'), `order detail should show product title, got ${order.title}`);
  assert(order.items.length === 1 && order.items[0].spec === '紫色', 'order detail should show item specification');
  assert(order.items[0].quantityText === '50个', `order detail should show quantity and unit, got ${order.items[0].quantityText}`);
  assert(order.originalText.includes('紫色'), 'order detail should preserve original input');
  assert(order.fields.some((item) => item.label === '客户' && item.value.includes('王总')), 'order detail should show the customer');

  const receivable = buildRecordDetail(state, 'receivable', 'rec_1');
  assert(receivable.relatedOrderId === 'ord_1', 'receivable detail should link to its exact order');
  assert(receivable.fields.some((item) => item.label === '还差' && item.value === '1000 元'), 'receivable detail should show the remaining amount');

  const payment = buildRecordDetail(state, 'payment', 'pay_1');
  assert(payment.relatedOrderId === 'ord_1', 'payment detail should derive the related order from its receivable');

  ['quotation', 'todo', 'pending'].forEach((type) => {
    const id = type === 'quotation' ? 'quo_1' : `${type}_1`;
    assert(buildRecordDetail(state, type, id), `${type} detail should load from local state`);
  });
  assert(!buildRecordDetail(state, 'order', 'missing'), 'missing record should not fabricate a detail');
  assert(
    getRecordDetailUrl('order', 'ord 1') === '/pages/record-detail/record-detail?type=order&id=ord%201',
    'record detail URL should safely encode the exact record id'
  );
  state.orders.push({ id: 'ord_unknown', customerId: 'missing_customer', productName: '待核对商品' });
  const unknownOrder = buildRecordDetail(state, 'order', 'ord_unknown');
  assert(unknownOrder.status === '状态未知', 'detail must not invent a missing order status');
  assert(!unknownOrder.customerId, 'detail must not link to a customer that no longer exists');
  assert(unknownOrder.fields.some((item) => item.label === '还差尾款' && item.value === '未填写'), 'detail must not turn an unknown order amount into zero');
  state.receivables.push({ id: 'rec_unknown', customerId: 'cus_wang', status: '待收' });
  const unknownReceivable = buildRecordDetail(state, 'receivable', 'rec_unknown');
  assert(unknownReceivable.fields.some((item) => item.label === '来源' && item.value === '未注明'), 'detail must not invent a receivable source');
  assert(unknownReceivable.fields.some((item) => item.label === '还差' && item.value === '未填写'), 'detail must not turn an unknown receivable amount into zero');
  console.log('统一记录详情测试通过：14 条');
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
  extraDepositDraft.fields.orderId = depositOrder.id;
  extraDepositDraft.fields.orderSelectionConfirmed = true;
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

  const lateDepositState = buildEmptyBusinessState([{ id: 'cus_late_deposit', name: '吴总' }]);
  lateDepositState.orders.push({
    id: 'ord_late_deposit',
    customerId: 'cus_late_deposit',
    productName: '礼品盒',
    totalAmount: '1000',
    status: '生产中'
  });
  const lateReceivable = generateReceivableFromOrder(lateDepositState, 'ord_late_deposit');
  const lateDeposit = saveConfirmedDraft(lateDepositState, {
    intent: 'payment',
    operation: 'record_order_deposit',
    source: 'typed',
    original_text: '吴总礼品盒订单收到定金200元',
    fields: {
      customerName: '吴总',
      customerId: 'cus_late_deposit',
      orderId: 'ord_late_deposit',
      orderSelectionConfirmed: true,
      paymentAmount: '200',
      depositAmount: '200',
      paymentKind: 'deposit'
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  assert(lateDeposit.type === 'order_deposit', `late deposit should save as order_deposit, got ${lateDeposit.type}`);
  assertNumber(lateReceivable.paidAmount, 200, 'late deposit should write off its linked receivable');
  assert(lateDepositState.paymentRecords[0].receivableId === lateReceivable.id, 'late deposit should link to the existing receivable');
  const lateDepositCount = lateDepositState.paymentRecords.length;
  const excessiveLateDeposit = saveConfirmedDraft(lateDepositState, {
    intent: 'payment',
    operation: 'record_order_deposit',
    source: 'typed',
    original_text: '吴总礼品盒订单再收定金900元',
    fields: {
      customerName: '吴总',
      customerId: 'cus_late_deposit',
      orderId: 'ord_late_deposit',
      orderSelectionConfirmed: true,
      paymentAmount: '900',
      depositAmount: '900',
      paymentKind: 'deposit'
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  assert(excessiveLateDeposit.type === 'pending', `excessive late deposit should stay pending, got ${excessiveLateDeposit.type}`);
  assert(lateDepositState.paymentRecords.length === lateDepositCount, 'excessive late deposit must not create a payment record');

  const newReceivablePaymentState = buildEmptyBusinessState([{ id: 'cus_new_receivable_payment', name: '老王' }]);
  const savedNewReceivablePayment = saveConfirmedDraft(newReceivablePaymentState, {
    intent: 'payment',
    operation: 'create_receivable_with_payment',
    source: 'typed',
    original_text: '老王还我4000，还剩2000',
    fields: {
      customerName: '老王',
      customerId: 'cus_new_receivable_payment',
      amount: '6000',
      paymentAmount: '4000',
      remainingAmount: '2000'
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  assert(savedNewReceivablePayment.type === 'receivable_with_payment', `new receivable payment should save both records, got ${savedNewReceivablePayment.type}`);
  assertNumber(newReceivablePaymentState.receivables[0].paidAmount, 4000, 'new receivable should retain the paid amount');
  assert(newReceivablePaymentState.paymentRecords[0].receivableId === newReceivablePaymentState.receivables[0].id, 'new receivable payment should link the payment record');
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
  flowState.paymentRecords.push({
    id: 'pay_unlinked_fin',
    customerId: 'cus_fin',
    amount: '50',
    kind: 'unlinked_payment',
    paidAt: current,
    createdAt: `${current}T12:00:00.000Z`
  });
  finance = buildFinanceViewModel(flowState);
  assert(finance.summary.monthlyPaymentAmount === 1050, `monthly payment should include all received money, got ${finance.summary.monthlyPaymentAmount}`);
  assertIncludes(finance.summary.monthlyPaymentHint, '50 元待核对', 'unlinked payment should be called out separately in the summary');
  assert(finance.paymentRows.some((item) => item.id === 'pay_unlinked_fin' && item.kindLabel === '待核对收款'), 'unlinked payment should be clearly labeled in the payment list');

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
  assert(finance.receivableRows[0].sourceLabel === '历史待收', `legacy source label should be 历史待收, got ${finance.receivableRows[0].sourceLabel}`);
  console.log('财务页面和定金数据测试通过');
}

function runPreReleaseLifecycleTests() {
  const state = buildEmptyBusinessState([{ id: 'cus_wang_release', name: '王总' }]);
  state.dunningTemplates = [{ id: 'polite', content: '{customer}，还差{amount}，麻烦安排一下。' }];

  const quotationDraft = parseInput({
    text: '给王总报钥匙扣1000个，1.2元一个，7月18日跟进。',
    source: 'typed',
    context: 'home',
    state
  });
  const savedQuotation = saveConfirmedDraft(state, quotationDraft);
  assert(savedQuotation.type === 'quotation', `release lifecycle quotation should save, got ${savedQuotation.type}`);
  assert(savedQuotation.record.originalText.includes('钥匙扣1000个'), 'quotation should preserve original text');

  const order = convertQuotationToOrder(state, savedQuotation.record.id, {
    requiredDeliveryDate: addDays(today(), 4)
  });
  assert(order.requiredDeliveryDate === addDays(today(), 4), `converted order should keep selected delivery date, got ${order.requiredDeliveryDate}`);
  assert(order.expectedShipDate === order.requiredDeliveryDate, 'converted order should keep expected ship date aligned');
  assert(savedQuotation.record.convertedOrderId === order.id, 'quotation should link to converted order');
  assert(order.quotationId === savedQuotation.record.id, 'converted order should link back to quotation');

  const depositDraft = parseInput({
    text: '王总这单钥匙扣收到定金200元',
    source: 'typed',
    context: 'home',
    state
  });
  depositDraft.fields.orderId = order.id;
  depositDraft.fields.orderSelectionConfirmed = true;
  const savedDeposit = saveConfirmedDraft(state, depositDraft);
  assert(savedDeposit.type === 'order_deposit', `release lifecycle deposit should save, got ${savedDeposit.type}`);
  assertNumber(getOrderDepositAmount(state, order.id), 200, 'release lifecycle deposit should link to order');

  updateOrderStatus(state, order.id, '已发货');
  const receivable = generateReceivableFromOrder(state, order.id);
  assert(receivable.dueDate === order.requiredDeliveryDate, `generated receivable should use selected delivery date, got ${receivable.dueDate}`);
  assertNumber(receivable.paidAmount, 200, 'generated receivable should include deposit');
  assertNumber(getOrderRemainingSettlement(state, order), 1000, 'remaining order amount should exclude deposit');

  const partialPayment = recordPayment(state, receivable.id, '400');
  assert(partialPayment, 'partial final payment should save');
  assertNumber(getOrderRemainingSettlement(state, order), 600, 'order remaining should include later final payment');
  assertIncludes(generateDunningMessage(state, receivable.id, 'polite'), '600元', 'dunning message should use remaining amount');
  const orderAnswer = answerQuery('王总订单现在怎么样？', state);
  assertIncludes(orderAnswer.lines.join('\n'), '待收尾款600元', 'order query should show remaining final payment');
  const tailAnswer = answerQuery('王总待收尾款多少？', state);
  assertIncludes(tailAnswer.lines.join('\n'), '600', 'tail payment query should be supported');

  const progressCountBeforeSettlement = state.orderProgress.length;
  const finalPayment = recordPayment(state, receivable.id, '600');
  assert(finalPayment && receivable.status === '已结清', 'final payment should settle receivable');
  assert(!finalPayment.completedOrderId, 'settled payment must not auto-complete the linked order');
  assert(order.status === '已发货', `settled payment must keep the manually set order status, got ${order.status}`);
  assert(state.orderProgress.length === progressCountBeforeSettlement, 'settled payment must not create an order progress record');
  const paymentCount = state.paymentRecords.length;
  assert(getReceivablePaymentError(receivable, '1').includes('已经结清'), 'settled receivable should explain why it cannot accept more money');
  assert(!recordPayment(state, receivable.id, '1'), 'settled receivable should reject another payment');
  assert(state.paymentRecords.length === paymentCount, 'rejected payment must not create a payment record');

  const noDateState = buildEmptyBusinessState([{ id: 'cus_no_date', name: '李总' }]);
  noDateState.orders.push({
    id: 'ord_no_date',
    userId: 'local-user',
    customerId: 'cus_no_date',
    productName: '杯垫',
    totalAmount: '500',
    requiredDeliveryDate: '',
    expectedShipDate: '',
    status: '已发货'
  });
  const noDateReceivable = generateReceivableFromOrder(noDateState, 'ord_no_date');
  assert(noDateReceivable.dueDate === '', `missing collection date must stay empty, got ${noDateReceivable.dueDate}`);
  assert(setOrderDeliveryDate(noDateState, 'ord_no_date', addDays(today(), 2)), 'order should allow the owner to supplement a delivery date');
  assert(noDateState.orders[0].requiredDeliveryDate === addDays(today(), 2), 'supplemented delivery date should save');

  const directSaveState = buildEmptyBusinessState([{ id: 'cus_direct_pay', name: '孙总' }]);
  directSaveState.orders.push({ id: 'ord_direct_pay', customerId: 'cus_direct_pay', productName: '挂件', totalAmount: '300', status: '已发货' });
  directSaveState.receivables.push({
    id: 'rec_direct_pay',
    customerId: 'cus_direct_pay',
    orderId: 'ord_direct_pay',
    amount: '300',
    paidAmount: '0',
    status: '待收'
  });
  const directSavedPayment = saveConfirmedDraft(directSaveState, {
    intent: 'payment',
    operation: 'record_payment',
    source: 'typed',
    original_text: '孙总收到挂件尾款300元',
    fields: {
      customerName: '孙总',
      customerId: 'cus_direct_pay',
      receivableId: 'rec_direct_pay',
      receivableSelectionConfirmed: true,
      paymentAmount: '300'
    },
    missing_fields: [],
    low_confidence_fields: [],
    field_conflicts: []
  });
  assert(directSavedPayment.type === 'payment', `confirmed payment should save as payment, got ${directSavedPayment.type}`);
  assert(!directSavedPayment.record.completedOrderId, 'confirmed payment must not report an automatic order completion');
  assert(directSaveState.orders[0].status === '已发货', 'confirmed payment must keep the linked order status unchanged');
  console.log('上线模拟生命周期与异常收款测试通过');
}

async function runQueryDataBoundaryTests() {
  const state = buildEmptyBusinessState([{ id: 'cus_query', name: '赵总' }]);
  state.orders.push({
    id: 'ord_query',
    customerId: 'cus_query',
    productName: '收纳盒',
    quantity: '300',
    unit: '个',
    totalAmount: '1200',
    requiredDeliveryDate: today(),
    status: '已发货'
  });
  state.receivables.push({
    id: 'rec_query',
    customerId: 'cus_query',
    orderId: 'ord_query',
    amount: '1200',
    paidAmount: '800',
    dueDate: today(),
    status: '部分收款'
  });
  state.paymentRecords.push({
    id: 'pay_query',
    customerId: 'cus_query',
    amount: '800',
    paidAt: today(),
    kind: 'final_payment'
  });
  const customerPayment = answerQuery('赵总收了多少？', state);
  assertIncludes(customerPayment.lines.join('\n'), '800', 'customer payment query should read payment records');
  const monthlyPayment = answerQuery('本月收款多少？', state);
  assertIncludes(monthlyPayment.lines.join('\n'), '800', 'monthly payment query should read recorded payments');
  const todayDelivery = answerQuery('今天要交哪些货？', state);
  assertIncludes(todayDelivery.lines.join('\n'), '收纳盒', 'today delivery query must not be mistaken for a collection query');
  const todayCollection = answerQuery('今天要收哪些款？', state);
  assertIncludes(todayCollection.lines.join('\n'), '还差400元', 'today collection query should show the remaining amount');
  const localAnswer = await askHybridQuery('赵总收了多少？', state);
  assert(localAnswer.provider === 'local' && localAnswer.aiStatus === 'local', 'query must use the verifiable local answer instead of an unchecked server answer');
  const localQuote = await parseHybridInput({
    text: '给王总报钥匙扣1000个，1.2元一个，7月18日跟进。',
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  const wrongAiIntent = normalizeAiResult(localQuote, {
    provider: 'ai',
    intent: 'todo',
    fields: { todoTitle: '跟进王总' },
    missing_fields: [],
    low_confidence_fields: []
  });
  assert(wrongAiIntent.intent === 'quotation', 'a server result must not overwrite a safe, explicit local quotation as a todo');
  console.log('问一句数据边界与远程意图保护测试通过：7 条');
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
    text: '王总订500个杯垫，9毛一个，三天后交',
    source: 'typed',
    context: 'home',
    state: { customers: [] }
  });
  assert(result.fields.customerName === '王总', `hybrid skip should keep 王总, got ${result.fields.customerName}`);
  assert(result.fields.remark === '王总订500个杯垫，9毛一个，三天后交', `hybrid skip should keep original remark, got ${result.fields.remark}`);
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
  assert(localResult.ai_fallback.status === 'not_requested', `multi-message paste should wait for an explicit deep-review tap, got ${localResult.ai_fallback.status}`);
  assert(localResult.ai_fallback.needed === true, 'multi-message paste should mark AI fallback as needed');
  assert(localResult.parse_route.deep_review_available, 'multi-message paste should provide an explicit deep-review action');
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
  const noReceivableConfirmation = buildConfirmationStateForTest(
    buildHistoryState({ includeLaoWangReceivable: false }),
    noReceivable,
    noReceivable.intent,
    noReceivable.fields
  );
  assert(
    noReceivableConfirmation.operation === 'create_receivable_with_payment',
    `missing receivable with paid and remaining amounts should create a new receivable, got ${noReceivableConfirmation.operation}`
  );
  assert(
    noReceivableConfirmation.fields.amount === '6000',
    `new receivable total should be 6000, got ${noReceivableConfirmation.fields.amount}`
  );
  assert(noReceivableConfirmation.showRemainingAmountField, 'new receivable payment should allow editing the remaining amount');
  console.log('历史缺失和默认带出测试通过：14 条');
}

async function main() {
  runParseTests();
  runMultiSpecAndWholesaleUnitTests();
  runRecordActionsAndOrderEditTests();
  runProductCatalogTests();
  runLocalParseSafetyTests();
  runClipboardChatTests();
  runQueryTests();
  runContextPolicyTests();
  runDisplayTextTests();
  runTodoSaveTests();
  runSafeBusinessSaveTests();
  runCustomerIdentityTests();
  runInputCustomerHistoryTests();
  runQuotationFollowupTests();
  runListFilterTests();
  runNavigationStateTests();
  runTodoPageTests();
  runHomeWorkbenchTests();
  runRecordDetailTests();
  runFinanceTests();
  runPreReleaseLifecycleTests();
  runHybridMergeTests();
  await runHybridSkipTests();
  await runWechatAiRoutingTests();
  await runHistoryWarningTests();
  await runQueryDataBoundaryTests();
  console.log('核心功能测试全部通过');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
