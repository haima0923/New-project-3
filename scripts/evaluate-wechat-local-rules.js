const fs = require('fs');
const path = require('path');
const { analyzeClipboardText, getPasteMeta } = require('../utils/clipboard-chat');
const { parseHybridInput } = require('../utils/ai-parser');

const REPORT_PATH = path.resolve(__dirname, '../docs/wechat-local-rules-evaluation.md');
const BASE_DATE = '2026年07月01日';

function time(index) {
  const minute = 10 + index;
  return `09:${String(minute).padStart(2, '0')}`;
}

function wxChat(messages) {
  return messages
    .map(([speaker, content], index) => `${speaker}\n${BASE_DATE} ${time(index)}\n${content}`)
    .join('\n\n');
}

function moneyEqual(actual, expected) {
  if (expected === undefined) return true;
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.0001;
}

function textIncludes(actual, expected) {
  if (expected === undefined || expected === '') return true;
  return String(actual || '').includes(String(expected));
}

function md(value) {
  return String(value === undefined || value === null || value === '' ? '-' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function compactChat(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}$/.test(line))
    .join(' / ');
}

const cases = [];

function add(category, title, messages, expected) {
  cases.push({
    id: String(cases.length + 1).padStart(3, '0'),
    category,
    title,
    raw: wxChat(messages),
    expected
  });
}

[
  ['王总', '水杯', '1000个', '5块5一个', '5.5'],
  ['李总', '钥匙扣', '2000个', '一块二一个', '1.2'],
  ['陈老板', '杯垫', '300个', '9毛', '0.9'],
  ['周姐', '礼品盒', '500套', '3.8一套', '3.8'],
  ['钱总', '包装袋', '1万只', '8分钱一只', '0.08'],
  ['孙总', '老款杯垫', '1000个', '还是八毛一个', '0.8'],
  ['赵姐', '饰品盒', '800个', '两块三', '2.3'],
  ['黄老板', '五金挂件', '3000个', '单价一块五', '1.5'],
  ['吴总', '头绳', '5000条', '三毛五', '0.35'],
  ['刘总', '收纳盒', '600个', '7块8', '7.8'],
  ['马总', '小夜灯', '1200个', '4.6元一个', '4.6'],
  ['何姐', '贴纸', '2万张', '1毛2一张', '0.12']
].forEach(([customer, product, quantityText, priceText, price]) => {
  const quantity = quantityText.includes('万') ? String(Number(quantityText.replace(/万.*/, '')) * 10000) : quantityText.match(/\d+/)[0];
  add('报价', `${customer}${product}报价`, [
    [customer, `想问下${product}${quantityText}多少钱`],
    ['海马', priceText]
  ], { intent: 'quotation', customer, product, quantity, unitPrice: price });
});

[
  ['王总', '卡通水杯', '1000个', '5块5一个', '5.5', '月底交'],
  ['李总', '钥匙扣', '2000个', '一块二一个', '1.2', '7天后发'],
  ['陈老板', '杯垫', '300个', '9毛', '0.9', '明天交货'],
  ['周姐', '礼品盒', '500套', '3.8一套', '3.8', '后天出货'],
  ['钱总', '包装袋', '1万只', '8分钱一只', '0.08', '下周发'],
  ['孙总', '老款杯垫', '1000个', '八毛一个', '0.8', '月底交'],
  ['赵姐', '饰品盒', '800个', '两块三', '2.3', '3天后拿'],
  ['黄老板', '五金挂件', '3000个', '一块五', '1.5', '周五出'],
  ['吴总', '头绳', '5000条', '三毛五', '0.35', '明天发'],
  ['刘总', '收纳盒', '600个', '7块8', '7.8', '7月10日交'],
  ['马总', '小夜灯', '1200个', '4.6元一个', '4.6', '5天后交'],
  ['何姐', '贴纸', '2万张', '1毛2一张', '0.12', '月底交']
].forEach(([customer, product, quantityText, priceText, price, dueText]) => {
  const quantity = quantityText.includes('万') ? String(Number(quantityText.replace(/万.*/, '')) * 10000) : quantityText.match(/\d+/)[0];
  add('订单', `${customer}${product}下单`, [
    [customer, `${product}${quantityText}先做`],
    ['海马', `${priceText}，${dueText}`]
  ], { intent: 'order', customer, product, quantity, unitPrice: price, dueDatePresent: true });
});

[
  ['王总', '水杯', '30一个', '25一个', '1000个', '月底交', '25'],
  ['李总', '钥匙扣', '1.5一个', '1.3一个', '2000个', '7天后发', '1.3'],
  ['陈老板', '杯垫', '1块', '9毛', '300个', '明天交', '0.9'],
  ['周姐', '礼品盒', '4块一套', '3.8一套', '500套', '后天交', '3.8'],
  ['钱总', '包装袋', '1毛一只', '8分钱一只', '1万只', '下周发', '0.08'],
  ['孙总', '杯子', '6元一个', '5块5一个', '800个', '月底交', '5.5'],
  ['赵姐', '饰品盒', '两块五', '两块三', '800个', '3天后拿', '2.3'],
  ['黄老板', '挂件', '2元一个', '一块五', '3000个', '周五出', '1.5'],
  ['吴总', '头绳', '4毛', '三毛五', '5000条', '明天发', '0.35'],
  ['刘总', '收纳盒', '8块', '7块8', '600个', '7月10日交', '7.8'],
  ['马总', '小夜灯', '5元一个', '4.6元一个', '1200个', '5天后交', '4.6'],
  ['何姐', '贴纸', '1毛5一张', '1毛2一张', '2万张', '月底交', '0.12']
].forEach(([customer, product, oldPrice, finalPrice, quantityText, dueText, price]) => {
  const quantity = quantityText.includes('万') ? String(Number(quantityText.replace(/万.*/, '')) * 10000) : quantityText.match(/\d+/)[0];
  add('改价确认', `${customer}${product}先报价后改价`, [
    [customer, `${product}多少钱`],
    ['海马', oldPrice],
    [customer, `贵了，${finalPrice}可以吗`],
    ['海马', `可以，就${finalPrice}，先做${quantityText}，${dueText}`]
  ], { intent: 'order', customer, product, quantity, unitPrice: price, dueDatePresent: true, conflictFields: ['unitPrice'] });
});

[
  ['王总', '杯子', '1000个', '25一个', '颜色要淡一点，不要太深'],
  ['李总', '钥匙扣', '2000个', '1.3一个', '包装袋每100个一包'],
  ['陈老板', '杯垫', '300个', '9毛', 'logo放大一点'],
  ['周姐', '礼品盒', '500套', '3.8一套', '外箱不要太厚'],
  ['钱总', '包装袋', '1万只', '8分钱一只', '透明度高一点'],
  ['孙总', '老款杯垫', '1000个', '8毛', '颜色按上次，不要偏黄'],
  ['赵姐', '饰品盒', '800个', '2.3', '盒子里面加隔板'],
  ['黄老板', '五金挂件', '3000个', '1.5', '材质换成不锈钢'],
  ['吴总', '头绳', '5000条', '0.35', '黑色多一点'],
  ['刘总', '收纳盒', '600个', '7.8', '尺寸比上次大一点'],
  ['马总', '小夜灯', '1200个', '4.6', '插头要欧规'],
  ['何姐', '贴纸', '2万张', '0.12', '图案不要裁边']
].forEach(([customer, product, quantityText, priceText, requirement]) => {
  const quantity = quantityText.includes('万') ? String(Number(quantityText.replace(/万.*/, '')) * 10000) : quantityText.match(/\d+/)[0];
  add('特殊要求', `${customer}${product}带特殊要求`, [
    [customer, `${product}${quantityText}，${requirement}`],
    ['海马', `好的，${priceText}，月底交`]
  ], { intent: 'order', customer, product, quantity, dueDatePresent: true, remarkIncludes: requirement });
});

[
  ['陈总', '有一笔货款15000，月底结', 'receivable', 'amount', '15000'],
  ['刘总', '上次尾款还差5000，下周给', 'receivable', 'amount', '5000'],
  ['老李', '刚转了3000，还剩2000', 'payment', 'paymentAmount', '3000'],
  ['周姐', '已到账8600，微信转的', 'payment', 'paymentAmount', '8600'],
  ['马总', '杯垫定金收了1000，月底交', 'payment', 'paymentAmount', '1000'],
  ['王总', '水杯1000个，先付定金2000，月底交', 'order', 'depositAmount', '2000'],
  ['黄老板', '那笔五金挂件尾款12000还没结', 'receivable', 'amount', '12000'],
  ['赵姐', '饰品盒款付了2300，剩余4600', 'payment', 'paymentAmount', '2300'],
  ['吴总', '头绳一共1750，明天付款', 'receivable', 'amount', '1750'],
  ['何姐', '贴纸款2400已到账', 'payment', 'paymentAmount', '2400'],
  ['钱总', '包装袋先收了800，后面还有2000', 'payment', 'paymentAmount', '800'],
  ['孙总', '老款杯垫挂账800，月底一起结', 'receivable', 'amount', '800'],
  ['郭总', '今天打款5000，不是3000', 'payment', 'paymentAmount', '5000'],
  ['范姐', '定金三千，货月底交', 'payment', 'paymentAmount', '3000'],
  ['郑总', '还有一笔没结，一共一万二', 'receivable', 'amount', '12000'],
  ['曹老板', '上次货款结清了', 'payment', '', '']
].forEach(([customer, content, intent, field, value]) => {
  const expected = { intent, customer };
  if (field) expected[field] = value;
  add('收款应收', `${customer}收款应收`, [
    [customer, content]
  ], expected);
});

[
  ['王总', '那单水杯价格改成25一个', 'update_order', 'unitPrice', '25'],
  ['李总', '钥匙扣那单数量改成2500个', 'update_order', 'quantity', '2500'],
  ['陈老板', '杯垫交期提前到明天', 'update_order', '', ''],
  ['周姐', '礼品盒延期到下周', 'update_order', '', ''],
  ['钱总', '包装袋按上次价格做1万只', 'order', 'quantity', '10000'],
  ['孙总', '老款杯垫照旧价，补1000个', 'order', 'quantity', '1000'],
  ['赵姐', '饰品盒不要做了', 'unknown', '', ''],
  ['黄老板', '五金挂件上次那笔报价改一下', 'update_quotation', '', ''],
  ['吴总', '头绳再来5000条，按上回', 'order', 'quantity', '5000'],
  ['刘总', '收纳盒这单备注一下，箱规改小', 'update_order', '', ''],
  ['马总', '小夜灯先别发，等通知', 'unknown', '', ''],
  ['何姐', '贴纸价格写错了，不是0.15，是0.12', 'quotation', 'unitPrice', '0.12']
].forEach(([customer, content, intent, field, value]) => {
  const expected = { intent, customer };
  if (field) expected[field] = value;
  add('更新历史', `${customer}历史或更新`, [
    [customer, content]
  ], expected);
});

[
  ['王总', '水杯1000个25一个，杯垫300个9毛，月底一起交', ['水杯', '杯垫']],
  ['李总', '钥匙扣2000个1.3，包装袋1万只8分，下周发', ['钥匙扣', '包装袋']],
  ['陈老板', '杯垫300个，颜色浅一点；礼品盒500套，logo放大', ['杯垫', '礼品盒']],
  ['周姐', '先问礼品盒500套多少钱，再问收纳盒600个多少钱', ['礼品盒', '收纳盒']],
  ['钱总', '包装袋和贴纸一起报，包装袋1万只，贴纸2万张', ['包装袋', '贴纸']],
  ['孙总', '老款杯垫1000个，水杯800个，价格照旧', ['老款杯垫', '水杯']],
  ['赵姐', '饰品盒800个2.3，小夜灯1200个4.6', ['饰品盒', '小夜灯']],
  ['黄老板', '五金挂件3000个，钥匙扣2000个，周五出', ['五金挂件', '钥匙扣']],
  ['吴总', '头绳5000条0.35，扣子1000件0.38', ['头绳', '扣子']],
  ['刘总', '收纳盒600个7.8，箱子500个59', ['收纳盒', '箱子']],
  ['马总', '小夜灯1200个4.6，包装袋5000只0.08', ['小夜灯', '包装袋']],
  ['何姐', '贴纸2万张0.12，文具套装200套12块', ['贴纸', '文具套装']]
].forEach(([customer, content, products]) => {
  add('多产品', `${customer}一段话多产品`, [
    [customer, '你好'],
    ['海马', '在的'],
    [customer, content]
  ], { intent: 'order', customer, multiProducts: products });
});

[
  ['王总', '明天提醒我回复水杯报价', 'todo', '回复王总水杯报价'],
  ['李总', '后天给他回钥匙扣价格', 'todo', '回复李总钥匙扣报价'],
  ['陈老板', '下午催一下杯垫尾款', 'todo', '催陈老板货款'],
  ['周姐', '明天跟进礼品盒确认没', 'todo', '跟进周姐礼品盒'],
  ['钱总', '下周联系包装袋样品', 'todo', '联系包装袋样品'],
  ['孙总', '月底催老款杯垫货款', 'todo', '催孙总货款'],
  ['赵姐', '明天问饰品盒数量', 'todo', '跟进赵姐饰品盒'],
  ['黄老板', '后天发五金挂件对账单', 'todo', '发五金挂件对账单'],
  ['吴总', '今天回头绳单价', 'todo', '回复吴总头绳报价'],
  ['刘总', '明天确认收纳盒颜色', 'todo', '确认收纳盒颜色'],
  ['马总', '周五提醒我看小夜灯进度', 'todo', '看小夜灯进度'],
  ['何姐', '后天跟进贴纸报价', 'todo', '跟进何姐贴纸']
].forEach(([customer, content, intent, todoTitle]) => {
  add('待办', `${customer}待办提醒`, [
    [customer, content]
  ], { intent, customer, todoTitle, dueDatePresent: true });
});

function expectedSummary(expected) {
  return Object.entries(expected)
    .filter(([key]) => !['conflictFields', 'remarkIncludes', 'dueDatePresent', 'multiProducts'].includes(key))
    .map(([key, value]) => (key === 'intent' && /^update_/.test(String(value))
      ? `operation=${value}`
      : `${key}=${value}`))
    .concat(expected.dueDatePresent ? ['dueDate=有'] : [])
    .concat(expected.conflictFields ? [`conflict=${expected.conflictFields.join(',')}`] : [])
    .concat(expected.remarkIncludes ? [`remark包含=${expected.remarkIncludes}`] : [])
    .concat(expected.multiProducts ? [`multiProducts=${expected.multiProducts.join('+')}`] : [])
    .join('；');
}

function actualSummary(result, analysis) {
  if (!result) return `analysis=${analysis.status}`;
  const fields = result.fields || {};
  return [
    `intent=${result.intent}`,
    `operation=${result.operation || ''}`,
    `customer=${fields.customerName || ''}`,
    `product=${fields.productName || ''}`,
    `multi=${(result.multi_products || []).join('+')}`,
    `quantity=${fields.quantity || ''}`,
    `unitPrice=${fields.unitPrice || ''}`,
    `amount=${fields.amount || ''}`,
    `payment=${fields.paymentAmount || ''}`,
    `deposit=${fields.depositAmount || ''}`,
    `due=${fields.dueDate || ''}`,
    `missing=${(result.missing_fields || []).join(',')}`,
    `low=${(result.low_confidence_fields || []).join(',')}`,
    `conflict=${(result.field_conflicts || []).map((item) => item.field).join(',')}`
  ].join('；');
}

function addError(errors, type, field, expected, actual, cause) {
  errors.push({ type, field, expected, actual, cause });
}

function evaluateResult(testCase, analysis, result) {
  const expected = testCase.expected || {};
  const errors = [];
  if (analysis.status !== 'ok') {
    addError(errors, 'no_business_extracted', 'analysis.status', 'ok', analysis.status, '本地业务打分没有选出有效业务片段。');
    return errors;
  }
  const fields = (result && result.fields) || {};
  if (expected.intent && /^update_/.test(String(expected.intent))) {
    if (result.operation !== expected.intent) {
      addError(errors, 'operation_error', 'operation', expected.intent, result.operation, '更新订单/报价应进入 operation，而不是普通新建意图。');
    }
  } else if (expected.intent && result.intent !== expected.intent) {
    addError(errors, 'intent_error', 'intent', expected.intent, result.intent, '意图打分规则被关键词误导，或缺少该类表达规则。');
  }
  if (expected.customer && !textIncludes(fields.customerName, expected.customer)) {
    addError(errors, fields.customerName ? 'wrong_customer' : 'field_missing', 'customerName', expected.customer, fields.customerName, '说话人/客户称呼提取或清洗规则不足。');
  }
  if (expected.product && !textIncludes(fields.productName, expected.product)) {
    addError(errors, fields.productName ? 'wrong_product' : 'field_missing', 'productName', expected.product, fields.productName, '商品词库和“问/要/做+产品”提取规则覆盖不足。');
  }
  if (expected.quantity !== undefined && !moneyEqual(fields.quantity, expected.quantity)) {
    addError(errors, fields.quantity ? 'wrong_quantity' : 'field_missing', 'quantity', expected.quantity, fields.quantity, '数量单位识别、中文数字或万单位换算不稳定。');
  }
  if (expected.unitPrice !== undefined && !moneyEqual(fields.unitPrice, expected.unitPrice)) {
    addError(errors, fields.unitPrice ? 'wrong_unit_price' : 'field_missing', 'unitPrice', expected.unitPrice, fields.unitPrice, '口语价格、改价或单位价格解析规则覆盖不足。');
  }
  if (expected.amount !== undefined && !moneyEqual(fields.amount, expected.amount)) {
    addError(errors, fields.amount ? 'wrong_amount' : 'field_missing', 'amount', expected.amount, fields.amount, '应收总额/收款金额容易和单价、总价混淆。');
  }
  if (expected.paymentAmount !== undefined && !moneyEqual(fields.paymentAmount, expected.paymentAmount)) {
    addError(errors, fields.paymentAmount ? 'wrong_payment_amount' : 'field_missing', 'paymentAmount', expected.paymentAmount, fields.paymentAmount, '收款金额与应收金额、剩余金额的语义区分不足。');
  }
  if (expected.depositAmount !== undefined && !moneyEqual(fields.depositAmount, expected.depositAmount)) {
    addError(errors, fields.depositAmount ? 'wrong_deposit_amount' : 'field_missing', 'depositAmount', expected.depositAmount, fields.depositAmount, '定金属于订单阶段，本地规则常缺少订单关联和金额归类能力。');
  }
  if (expected.dueDatePresent && !fields.dueDate) {
    addError(errors, 'field_missing', 'dueDate', '有日期', fields.dueDate, '相对日期或口语交期没有被日期规则识别。');
  }
  if (expected.todoTitle && !textIncludes(fields.todoTitle, expected.todoTitle.replace(/报价$/, ''))) {
    addError(errors, fields.todoTitle ? 'wrong_todo_title' : 'field_missing', 'todoTitle', expected.todoTitle, fields.todoTitle, '待办标题生成依赖有限模板，无法覆盖复杂说法。');
  }
  if (expected.remarkIncludes && !textIncludes(fields.remark, expected.remarkIncludes)) {
    addError(errors, 'remark_lost', 'remark', expected.remarkIncludes, fields.remark, '特殊要求没有被本地备注抽取规则收集。');
  }
  if (expected.conflictFields) {
    const actualConflicts = (result.field_conflicts || []).map((item) => item.field);
    expected.conflictFields.forEach((field) => {
      if (!actualConflicts.includes(field)) {
        addError(errors, 'conflict_not_flagged', 'field_conflicts', field, actualConflicts.join(','), '多轮对话里旧值和最终值没有被冲突检测覆盖。');
      }
    });
  }
  if (expected.multiProducts) {
    const productName = String(fields.productName || '');
    const detectedCount = expected.multiProducts.filter((product) => productName.includes(product)).length;
    if (detectedCount < expected.multiProducts.length) {
      addError(errors, 'multi_record_not_supported', 'productName', expected.multiProducts.join('+'), productName, '当前确认卡只能生成单条草稿，多产品聊天无法拆成多条记录。');
    }
  }
  return errors;
}

function errorTypeSummary(errors) {
  if (!errors.length) return '无';
  return Array.from(new Set(errors.map((error) => error.type))).join('、');
}

function causeSummary(errors) {
  if (!errors.length) return '通过';
  return Array.from(new Set(errors.map((error) => error.cause))).join('；');
}

function solutionForType(type) {
  const map = {
    no_business_extracted: '提高业务片段召回：保留更多上下文，降低多消息业务阈值，并让 AI 对整段原文做兜底判断。',
    intent_error: '把意图判断从关键词计分升级为“候选意图+证据+冲突”结构；复杂对话交给 AI 仲裁。',
    wrong_customer: '区分说话人、老板本人和客户称呼；微信昵称与客户档案做候选匹配。',
    field_missing: '增加字段候选池，不只取单一摘要；对产品、价格、日期分别做多候选抽取。',
    wrong_product: '扩充商品抽取，支持未知商品；避免把“想问/先做/要货”等动作词混入产品。',
    wrong_quantity: '数量抽取跳过单价中的“一个/一件”，增强“万、千、包、盒”等单位换算。',
    wrong_unit_price: '价格抽取按时间顺序保留候选，结合“可以/就按/贵了/确认”等词选择最终价。',
    wrong_amount: '区分总价、应收、单价和收款；金额字段必须带来源语义。',
    wrong_payment_amount: '收款场景独立解析 paymentAmount、remainingAmount，不复用应收总额规则。',
    wrong_deposit_amount: '定金必须结合订单上下文；找不到订单时进入待整理，不生成应收。',
    wrong_todo_title: '待办标题用意图模板+产品/客户/动作组合，复杂句交由 AI 重写标题。',
    remark_lost: '把颜色、包装、logo、材质、尺寸等特殊要求作为 remark_items 单独抽取。',
    conflict_not_flagged: '本地保留多候选并展示冲突；AI 返回 superseded_facts 后清除冲突。',
    multi_record_not_supported: '增加多记录拆分能力：一段微信聊天可生成多个报价/订单草稿。',
    wrong_deposit_amount: '定金金额和订单关联分离；不能把定金误当作应收或普通收款。'
  };
  return map[type] || '补充规则用例，并优先让 AI 处理该类语义。';
}

async function main() {
  const rows = [];
  for (const testCase of cases) {
    const analysis = analyzeClipboardText(testCase.raw);
    let result = null;
    if (analysis.status === 'ok') {
      result = await parseHybridInput({
        text: analysis.extractedText,
        rawText: analysis.rawText,
        extractedText: analysis.extractedText,
        pasteMeta: getPasteMeta(analysis),
        source: 'paste',
        context: 'home',
        state: { customers: [], quotations: [], orders: [], receivables: [], paymentRecords: [], todos: [] }
      });
    }
    const errors = evaluateResult(testCase, analysis, result || {});
    rows.push({
      testCase,
      analysis,
      result,
      errors,
      passed: errors.length === 0
    });
  }

  const total = rows.length;
  const passed = rows.filter((row) => row.passed).length;
  const failed = total - passed;
  const byCategory = {};
  rows.forEach((row) => {
    const category = row.testCase.category;
    if (!byCategory[category]) byCategory[category] = { total: 0, passed: 0, failed: 0 };
    byCategory[category].total += 1;
    if (row.passed) byCategory[category].passed += 1;
    else byCategory[category].failed += 1;
  });
  const byError = {};
  rows.flatMap((row) => row.errors).forEach((error) => {
    byError[error.type] = (byError[error.type] || 0) + 1;
  });

  const now = new Date().toISOString();
  const lines = [];
  lines.push('# 微信聊天本地规则解析 100 条离线评测报告');
  lines.push('');
  lines.push(`生成时间：${now}`);
  lines.push('');
  lines.push('## 评测说明');
  lines.push('');
  lines.push('- 本报告模拟 100 条不同场景的微信聊天复制内容。');
  lines.push('- 评测链路：`analyzeClipboardText -> parseHybridInput`，在 Node 环境下没有 `wx` 和 API endpoint，因此不会调用真实 AI，相当于只看本地规则/本地兜底能力。');
  lines.push('- “通过”表示本地结果满足该用例预期；“失败”表示字段、意图、备注、冲突提示或多记录拆分存在问题。');
  lines.push('- 部分改价场景如果能填最终候选值并标出冲突，视为通过，因为本地规则已做到安全拦截，不会直接误存。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 总用例：${total}`);
  lines.push(`- 通过：${passed}`);
  lines.push(`- 失败：${failed}`);
  lines.push(`- 通过率：${((passed / total) * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('## 按场景统计');
  lines.push('');
  lines.push('| 场景 | 用例数 | 通过 | 失败 | 通过率 |');
  lines.push('|---|---:|---:|---:|---:|');
  Object.entries(byCategory).forEach(([category, item]) => {
    lines.push(`| ${md(category)} | ${item.total} | ${item.passed} | ${item.failed} | ${((item.passed / item.total) * 100).toFixed(1)}% |`);
  });
  lines.push('');
  lines.push('## 错误类型统计');
  lines.push('');
  lines.push('| 错误类型 | 次数 | 初步解决方向 |');
  lines.push('|---|---:|---|');
  Object.entries(byError)
    .sort((left, right) => right[1] - left[1])
    .forEach(([type, count]) => {
      lines.push(`| ${md(type)} | ${count} | ${md(solutionForType(type))} |`);
    });
  if (!Object.keys(byError).length) lines.push('| 无 | 0 | 暂无 |');
  lines.push('');
  lines.push('## 主要发现');
  lines.push('');
  const topTypes = Object.entries(byError).sort((left, right) => right[1] - left[1]).slice(0, 6);
  if (topTypes.length) {
    topTypes.forEach(([type, count], index) => {
      lines.push(`${index + 1}. ${type}：${count} 次。${solutionForType(type)}`);
    });
  } else {
    lines.push('本轮没有发现失败用例。');
  }
  lines.push('');
  lines.push('## 失败样例摘录');
  lines.push('');
  rows.filter((row) => !row.passed).slice(0, 20).forEach((row) => {
    lines.push(`### ${row.testCase.id} ${row.testCase.title}`);
    lines.push('');
    lines.push(`- 场景：${row.testCase.category}`);
    lines.push(`- 错误类型：${errorTypeSummary(row.errors)}`);
    lines.push(`- 原因：${causeSummary(row.errors)}`);
    lines.push(`- 预期：${expectedSummary(row.testCase.expected)}`);
    lines.push(`- 实际：${actualSummary(row.result, row.analysis)}`);
    lines.push('');
    lines.push('```text');
    lines.push(row.testCase.raw);
    lines.push('```');
    lines.push('');
  });
  lines.push('## 100 条明细');
  lines.push('');
  lines.push('| ID | 场景 | 微信聊天摘要 | 是否通过 | 错误类型 | 错误原因 | 预期 | 实际 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  rows.forEach((row) => {
    lines.push([
      row.testCase.id,
      md(row.testCase.category),
      md(compactChat(row.testCase.raw)),
      row.passed ? '通过' : '失败',
      md(errorTypeSummary(row.errors)),
      md(causeSummary(row.errors)),
      md(expectedSummary(row.testCase.expected)),
      md(actualSummary(row.result, row.analysis))
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  });
  lines.push('');
  lines.push('## 建议优先级');
  lines.push('');
  lines.push('1. 先解决高频字段错误：产品、单价、金额、待办标题，这些直接影响确认卡可用性。');
  lines.push('2. 对多产品聊天新增“拆多条草稿”能力；如果本地不能拆，必须提示用户或交给 AI。');
  lines.push('3. 本地继续保留“安全拦截”边界：有多个价格/数量候选时不要直接保存，除非 AI 返回明确 `superseded_facts`。');
  lines.push('4. 真机要接通 AI，必须把 `apiBaseUrl` 换成合法 HTTPS 域名，并在微信公众平台配置 request 合法域名。');

  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(`Total ${total}, passed ${passed}, failed ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
