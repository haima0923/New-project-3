const fs = require('fs');
const path = require('path');
const { analyzeClipboardText, getPasteMeta } = require('../utils/clipboard-chat');
const { parseHybridInput } = require('../utils/ai-parser');

const REPORT_MD = path.resolve(__dirname, '../docs/wechat-local-rules-hard-evaluation.md');
const REPORT_HTML = path.resolve(__dirname, '../docs/wechat-local-rules-hard-evaluation.html');
const REPORT_TXT = path.resolve(__dirname, '../docs/wechat-local-rules-hard-evaluation.txt');
const BASE_DATE = '2026年07月01日';

function time(index) {
  const minute = 8 + index;
  return `10:${String(minute).padStart(2, '0')}`;
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function add(category, title, messages, expected, tags = []) {
  cases.push({
    id: String(cases.length + 1).padStart(3, '0'),
    category,
    title,
    raw: wxChat(messages),
    expected,
    tags
  });
}

[
  ['王总', '水杯', '1000', '5.5', [['王总', '早，刚才那个图先别管，想问水怀 1,000 个多钱？？'], ['海马', '5块5一个']], ['无效信息', '音同字', '数字标点']],
  ['李总', '钥匙扣', '2000', '1.2', [['李总', '钥匙口贰仟个 报个价 先不下单'], ['海马', '一块二一只']], ['音同字', '数字大写', '意图干扰']],
  ['陈老板', '杯垫', '300', '0.9', [['陈老板', '[图片] 这个杯甸，三百个'], ['海马', '九毛，先按这个报']], ['无效信息', '音同字', '数字大写']],
  ['周姐', '礼品盒', '500', '3.8', [['周姐', '礼品盒５００套多钱，，'], ['海马', '3.8/套']], ['全角数字', '标点错误']],
  ['钱总', '包装袋', '10000', '0.08', [['钱总', '包妆袋一万只，不要算运费'], ['海马', '8分/只']], ['音同字', '数字大写', '无效信息']],
  ['孙总', '老款杯垫', '1000', '0.8', [['孙总', '老款杯垫先别做哈，只问一下1000个价格'], ['海马', '八毛一个']], ['意图干扰', '数字混用']],
  ['赵姐', '饰品盒', '800', '2.3', [['赵姐', '饰品合 800 个几钱'], ['海马', '两块三']], ['音同字', '口语']],
  ['黄老板', '五金挂件', '3000', '1.5', [['黄老板', '五金挂件3千个，帮我报一下'], ['海马', '单价壹块伍']], ['数字大小写', '口语价格']],
  ['吴总', '头绳', '5000', '0.35', [['吴总', '头绳五千条？别急着排产'], ['海马', '三毛五']], ['数字大写', '意图干扰']],
  ['刘总', '收纳盒', '600', '7.8', [['刘总', '收钠盒 600个 多少'], ['海马', '7块8']], ['音同字', '标点缺失']],
  ['马总', '小夜灯', '1200', '4.6', [['马总', '小夜灯 1,200个'], ['马总', '不是要货，先问价'], ['海马', '4.6元/个']], ['数字标点', '多轮对话', '意图干扰']],
  ['何姐', '贴纸', '20000', '0.12', [['何姐', '贴纸2W张，问下'], ['海马', '一毛二一张']], ['英文数量', '口语价格']]
].forEach(([customer, product, quantity, unitPrice, messages, tags]) => {
  add('报价', `${customer}${product}高难报价`, messages, { intent: 'quotation', customer, product, quantity, unitPrice }, tags);
});

[
  ['王总', '卡通水杯', '1000', '5.5', [['王总', '那个卡通水杯先做 壹仟 个，刚语音说错不是一百'], ['海马', '收到，5块5一个，月底交']], ['多轮改口', '数字大写']],
  ['李总', '钥匙扣', '2000', '1.2', [['李总', '钥匙扣 2,000个 先做吧'], ['李总', '中间不要那个链子'], ['海马', '一块二一个 7天后发']], ['数字标点', '特殊要求']],
  ['陈老板', '杯垫', '300', '0.9', [['陈老板', '杯甸三百个可以做吗'], ['海马', '9毛 明天交货']], ['音同字', '数字大写']],
  ['周姐', '礼品盒', '500', '3.8', [['周姐', '礼品盒500套先做！！！'], ['海马', '3.8一套后天出']], ['标点错误', '缺少分隔']],
  ['钱总', '包装袋', '10000', '0.08', [['钱总', '包裝袋 1w只 做货'], ['海马', '8分钱一只 下周发']], ['繁简混用', '英文数量']],
  ['孙总', '老款杯垫', '1000', '0.8', [['孙总', '老款杯垫 一千个 照旧'], ['海马', '八毛，月底交']], ['数字大写', '历史价格']],
  ['赵姐', '饰品盒', '800', '2.3', [['赵姐', '饰品盒800'], ['赵姐', '做吧'], ['海马', '两块三，3天后拿']], ['多轮对话', '标点缺失']],
  ['黄老板', '五金挂件', '3000', '1.5', [['黄老板', '五金挂件三千个'], ['黄老板', '不是样品，是大货'], ['海马', '一块五 周五出']], ['数字大写', '意图干扰']],
  ['吴总', '头绳', '5000', '0.35', [['吴总', '头绳5000条明天发'], ['海马', '3毛5']], ['缺少标点', '口语价格']],
  ['刘总', '收纳盒', '600', '7.8', [['刘总', '收纳合600个'], ['海马', '7块8，7月10号交']], ['音同字', '口语日期']],
  ['马总', '小夜灯', '1200', '4.6', [['马总', '小夜等 1200个 先排'], ['海马', '4.6元一个5天后交']], ['音同字', '缺少标点']],
  ['何姐', '贴纸', '20000', '0.12', [['何姐', '贴纸贰万张先做'], ['海马', '1毛2一张，月底交']], ['数字大写']]
].forEach(([customer, product, quantity, unitPrice, messages, tags]) => {
  add('订单', `${customer}${product}高难订单`, messages, { intent: 'order', customer, product, quantity, unitPrice, dueDatePresent: true }, tags);
});

[
  ['王总', '水杯', '1000', '25', [['王总', '水怀多少'], ['海马', '30一个'], ['王总', '贵了 25行不行'], ['海马', '行，就25，先做1,000个，月底交']], ['音同字', '改价', '数字标点']],
  ['李总', '钥匙扣', '2000', '1.3', [['李总', '钥匙扣问价'], ['海马', '1.5'], ['李总', '算啦 1.3可以？'], ['海马', '可以，做贰仟个，7天后发']], ['改价', '数字大写']],
  ['陈老板', '杯垫', '300', '0.9', [['陈老板', '杯甸价格'], ['海马', '1块'], ['陈老板', '9毛才做'], ['海马', '那就9毛，300个明天交']], ['音同字', '改价']],
  ['周姐', '礼品盒', '500', '3.8', [['周姐', '礼品盒多钱'], ['海马', '4块一套'], ['周姐', '3.8套？'], ['海马', '嗯3.8一套500套后天交']], ['改价', '标点缺失']],
  ['钱总', '包装袋', '10000', '0.08', [['钱总', '包妆袋报价'], ['海马', '1毛一只'], ['钱总', '8分吧'], ['海马', '可以，壹万只，下周发']], ['音同字', '改价', '数字大写']],
  ['孙总', '杯子', '800', '5.5', [['孙总', '杯子报一下'], ['海马', '6元一个'], ['孙总', '五块五'], ['海马', '好，800个月底交']], ['改价', '中文价格']],
  ['赵姐', '饰品盒', '800', '2.3', [['赵姐', '饰品合多少'], ['海马', '两块五'], ['赵姐', '两块三'], ['海马', '行 800个 三天后拿']], ['音同字', '改价']],
  ['黄老板', '挂件', '3000', '1.5', [['黄老板', '挂件问价'], ['海马', '2元一个'], ['黄老板', '一块五吧'], ['海马', '可以，3000个周五出']], ['改价']],
  ['吴总', '头绳', '5000', '0.35', [['吴总', '头绳报价'], ['海马', '4毛'], ['吴总', '三毛伍可以吗'], ['海马', '可以，五千条明天发']], ['改价', '数字大写']],
  ['刘总', '收纳盒', '600', '7.8', [['刘总', '收纳盒价格'], ['海马', '8块'], ['刘总', '7块8'], ['海马', '就7块8，陆佰个，7月10日交']], ['改价', '数字大写']],
  ['马总', '小夜灯', '1200', '4.6', [['马总', '小夜灯多少'], ['海马', '5元一个'], ['马总', '4.6呢'], ['海马', '可以 1200个5天后交']], ['改价', '标点缺失']],
  ['何姐', '贴纸', '20000', '0.12', [['何姐', '贴纸报价'], ['海马', '1毛5一张'], ['何姐', '1毛2吧'], ['海马', '行2W张月底交']], ['改价', '英文数量']]
].forEach(([customer, product, quantity, unitPrice, messages, tags]) => {
  add('改价确认', `${customer}${product}高难改价`, messages, { intent: 'order', customer, product, quantity, unitPrice, dueDatePresent: true, conflictFields: ['unitPrice'] }, tags);
});

[
  ['王总', '杯子', '1000', '颜色要淡一点，不要太深', [['王总', '杯子1000个 颜色要淡点，，别太深'], ['海马', '收到，25一个月底交']], ['特殊要求', '标点错误']],
  ['李总', '钥匙扣', '2000', '每100个一包', [['李总', '钥匙口2000个 包装每100个一包'], ['海马', '1.3一个，月底交']], ['音同字', '特殊要求']],
  ['陈老板', '杯垫', '300', 'logo放大一点', [['陈老板', '杯垫三百个'], ['陈老板', 'logo 放大一点哈'], ['海马', '9毛明天交']], ['多轮要求', '英文混入']],
  ['周姐', '礼品盒', '500', '外箱不要太厚', [['周姐', '礼品盒500套外箱不要太厚'], ['海马', '3.8一套后天出']], ['特殊要求', '缺少标点']],
  ['钱总', '包装袋', '10000', '透明度高一点', [['钱总', '包装袋1w只，透明度高点'], ['海马', '8分钱一只下周发']], ['英文数量', '特殊要求']],
  ['孙总', '老款杯垫', '1000', '不要偏黄', [['孙总', '老款杯甸一千个，颜色按上回 不要偏黄'], ['海马', '8毛月底交']], ['音同字', '数字大写', '特殊要求']],
  ['赵姐', '饰品盒', '800', '里面加隔板', [['赵姐', '饰品盒800个'], ['赵姐', '盒子里加隔板'], ['海马', '2.3，3天后拿']], ['多轮要求']],
  ['黄老板', '五金挂件', '3000', '不锈钢', [['黄老板', '五金挂件3000个材质换不锈钢'], ['海马', '1.5周五出']], ['特殊要求', '缺少标点']],
  ['吴总', '头绳', '5000', '黑色多一点', [['吴总', '头绳5000条 黑色多一点'], ['海马', '0.35明天发']], ['特殊要求']],
  ['刘总', '收纳盒', '600', '尺寸比上次大一点', [['刘总', '收纳合600个尺寸比上次大一点'], ['海马', '7.8，7月10日交']], ['音同字', '特殊要求']],
  ['马总', '小夜灯', '1200', '插头要欧规', [['马总', '小夜灯1200个插头欧规'], ['海马', '4.6 5天后交']], ['特殊要求']],
  ['何姐', '贴纸', '20000', '图案不要裁边', [['何姐', '贴纸贰万张，图案别裁边'], ['海马', '0.12月底交']], ['数字大写', '特殊要求']]
].forEach(([customer, product, quantity, requirement, messages, tags]) => {
  add('特殊要求', `${customer}${product}高难特殊要求`, messages, { intent: 'order', customer, product, quantity, dueDatePresent: true, remarkIncludes: requirement }, tags);
});

[
  ['陈总', '有一笔货款 15,000，月底结，刚那个红包别算', 'receivable', 'amount', '15000', ['数字标点', '无效信息']],
  ['刘总', '上次尾款还差伍仟，下周给', 'receivable', 'amount', '5000', ['数字大写']],
  ['老李', '刚转了3,000，还剩2,000', 'payment', 'paymentAmount', '3000', ['数字标点']],
  ['周姐', '已到帐8600 微信转的', 'payment', 'paymentAmount', '8600', ['音同字']],
  ['马总', '杯垫定斤收了1000，月底交', 'payment', 'paymentAmount', '1000', ['音同字']],
  ['王总', '水怀1000个 先付订金贰仟 月底交', 'order', 'depositAmount', '2000', ['音同字', '数字大写']],
  ['黄老板', '那笔五金挂件尾款12,000还没结', 'receivable', 'amount', '12000', ['数字标点']],
  ['赵姐', '饰品盒款付了2300 剩余肆仟陆佰', 'payment', 'paymentAmount', '2300', ['数字大写']],
  ['吴总', '头绳一共1750明天付款', 'receivable', 'amount', '1750', ['缺少标点']],
  ['何姐', '贴纸款2400以到账', 'payment', 'paymentAmount', '2400', ['音同字']],
  ['钱总', '包装袋先收800后面还有2千', 'payment', 'paymentAmount', '800', ['数字混用']],
  ['孙总', '老款杯垫挂帐800月底一起结', 'receivable', 'amount', '800', ['音同字', '缺少标点']],
  ['郭总', '今天打款5千，不是3千', 'payment', 'paymentAmount', '5000', ['数字混用']],
  ['范姐', '定金叁千 货月底交', 'payment', 'paymentAmount', '3000', ['数字大写']],
  ['郑总', '还有一笔没结，一共壹万贰', 'receivable', 'amount', '12000', ['数字大写']],
  ['曹老板', '上次货款结清了哈，别再催', 'payment', '', '', ['无效信息']]
].forEach(([customer, content, intent, field, value, tags]) => {
  const expected = { intent, customer };
  if (field) expected[field] = value;
  add('收款应收', `${customer}高难收款应收`, [[customer, '刚才那个图片不是账单'], [customer, content]], expected, tags);
});

[
  ['王总', '那单水怀价格改成25一个，刚语音错了', 'update_order', 'unitPrice', '25', ['音同字', '更新']],
  ['李总', '钥匙扣那单数量改成贰仟伍佰个', 'update_order', 'quantity', '2500', ['数字大写', '更新']],
  ['陈老板', '杯甸交期提前到明天', 'update_order', '', '', ['音同字', '更新']],
  ['周姐', '礼品盒延其到下周', 'update_order', '', '', ['音同字', '更新']],
  ['钱总', '包装袋按上次价格做1w只', 'order', 'quantity', '10000', ['英文数量', '历史价格']],
  ['孙总', '老款杯垫照旧价，补壹仟个', 'order', 'quantity', '1000', ['数字大写', '历史价格']],
  ['赵姐', '饰品盒不要作了', 'unknown', '', '', ['音同字', '取消']],
  ['黄老板', '五金挂件上次那笔报架改一下', 'update_quotation', '', '', ['音同字', '更新']],
  ['吴总', '头绳再来5,000条，按上回', 'order', 'quantity', '5000', ['数字标点', '历史价格']],
  ['刘总', '收纳盒这单备注下 箱规改小', 'update_order', '', '', ['缺少标点', '更新']],
  ['马总', '小夜灯先憋发，等通知', 'unknown', '', '', ['音同字', '暂停']],
  ['何姐', '贴纸价格写错了，不是0.15是0.12', 'quotation', 'unitPrice', '0.12', ['缺少标点', '纠错']]
].forEach(([customer, content, intent, field, value, tags]) => {
  const expected = { intent, customer };
  if (field) expected[field] = value;
  add('更新历史', `${customer}高难历史更新`, [[customer, '等下，我补一句'], [customer, content]], expected, tags);
});

[
  ['王总', '水怀1000个25一个；杯甸300个9毛，月底一起交', ['水杯', '杯垫'], ['音同字', '多产品']],
  ['李总', '钥匙扣2,000个1.3，包妆袋1w只8分，下周发', ['钥匙扣', '包装袋'], ['数字标点', '英文数量', '音同字']],
  ['陈老板', '杯垫300个颜色浅点 礼品盒伍佰套logo放大', ['杯垫', '礼品盒'], ['数字大写', '缺少标点']],
  ['周姐', '先问礼品合500套多少钱再问收纳合600个多少钱', ['礼品盒', '收纳盒'], ['音同字', '缺少标点']],
  ['钱总', '包装袋和贴纸一起报 包装袋一万只 贴纸贰万张', ['包装袋', '贴纸'], ['数字大写', '缺少标点']],
  ['孙总', '老款杯甸1000个，水怀800个，价格照旧', ['老款杯垫', '水杯'], ['音同字']],
  ['赵姐', '饰品盒800个2.3 小夜等1200个4.6', ['饰品盒', '小夜灯'], ['音同字']],
  ['黄老板', '五金挂件三千个 钥匙扣两千个 周五出', ['五金挂件', '钥匙扣'], ['数字大写', '缺少标点']],
  ['吴总', '头绳5000条0.35扣紫1000件0.38', ['头绳', '扣子'], ['音同字', '缺少标点']],
  ['刘总', '收纳合600个7.8 箱子伍佰个59', ['收纳盒', '箱子'], ['音同字', '数字大写']],
  ['马总', '小夜灯1,200个4.6 包装袋5,000只0.08', ['小夜灯', '包装袋'], ['数字标点']],
  ['何姐', '贴纸2W张0.12，文具套裝200套12块', ['贴纸', '文具套装'], ['英文数量', '繁简混用']]
].forEach(([customer, content, products, tags]) => {
  add('多产品', `${customer}高难多产品`, [[customer, '你好，刚才发的图片别管'], ['海马', '在'], [customer, content]], { intent: 'order', customer, multiProducts: products }, tags);
});

[
  ['王总', '明天提醒我回水怀报价，别忘了', 'todo', '回复王总水杯报价', ['音同字', '待办']],
  ['李总', '后天给他回钥匙口价格', 'todo', '回复李总钥匙扣报价', ['音同字', '待办']],
  ['陈老板', '下午催下杯甸尾款', 'todo', '催陈老板货款', ['音同字', '待办']],
  ['周姐', '明天跟进礼品合确认没', 'todo', '跟进周姐礼品盒', ['音同字', '待办']],
  ['钱总', '下周联系包妆袋样品', 'todo', '联系包装袋样品', ['音同字', '待办']],
  ['孙总', '月底催老款杯垫货款！！！', 'todo', '催孙总货款', ['标点错误', '待办']],
  ['赵姐', '明天问饰品盒数量多少', 'todo', '跟进赵姐饰品盒', ['口语', '待办']],
  ['黄老板', '后天发五金挂件对帐单', 'todo', '发五金挂件对账单', ['音同字', '待办']],
  ['吴总', '今天回头绳单价哈', 'todo', '回复吴总头绳报价', ['口语', '待办']],
  ['刘总', '明天确认收纳合颜色', 'todo', '确认收纳盒颜色', ['音同字', '待办']],
  ['马总', '周五提醒我看小夜等进度', 'todo', '看小夜灯进度', ['音同字', '待办']],
  ['何姐', '后天跟进贴纸报架', 'todo', '跟进何姐贴纸', ['音同字', '待办']]
].forEach(([customer, content, intent, todoTitle, tags]) => {
  add('待办', `${customer}高难待办`, [[customer, '刚刚那个不用理'], [customer, content]], { intent, customer, todoTitle, dueDatePresent: true }, tags);
});

function expectedSummary(expected) {
  return Object.entries(expected)
    .filter(([key]) => !['conflictFields', 'remarkIncludes', 'dueDatePresent', 'multiProducts'].includes(key))
    .map(([key, value]) => (key === 'intent' && /^update_/.test(String(value)) ? `operation=${value}` : `${key}=${value}`))
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
    `todo=${fields.todoTitle || ''}`,
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
      addError(errors, 'operation_error', 'operation', expected.intent, result.operation, '更新订单/报价没有进入正确 operation。');
    }
  } else if (expected.intent && result.intent !== expected.intent) {
    addError(errors, 'intent_error', 'intent', expected.intent, result.intent, '复杂噪声、错别字或上下文导致意图误判。');
  }
  if (expected.customer && !textIncludes(fields.customerName, expected.customer)) {
    addError(errors, fields.customerName ? 'wrong_customer' : 'field_missing', 'customerName', expected.customer, fields.customerName, '多轮聊天或说话人噪声导致客户名识别不准。');
  }
  if (expected.product && !textIncludes(fields.productName, expected.product)) {
    addError(errors, fields.productName ? 'wrong_product' : 'field_missing', 'productName', expected.product, fields.productName, '商品错别字、音同字、繁简混用或未知商品没有归一化。');
  }
  if (expected.quantity !== undefined && !moneyEqual(fields.quantity, expected.quantity)) {
    addError(errors, fields.quantity ? 'wrong_quantity' : 'field_missing', 'quantity', expected.quantity, fields.quantity, '数量含逗号、全角、英文 W/k 或财务大写时本地规则不稳定。');
  }
  if (expected.unitPrice !== undefined && !moneyEqual(fields.unitPrice, expected.unitPrice)) {
    addError(errors, fields.unitPrice ? 'wrong_unit_price' : 'field_missing', 'unitPrice', expected.unitPrice, fields.unitPrice, '口语价、改价、分/毛/元混写或无标点时价格识别不稳定。');
  }
  if (expected.amount !== undefined && !moneyEqual(fields.amount, expected.amount)) {
    addError(errors, fields.amount ? 'wrong_amount' : 'field_missing', 'amount', expected.amount, fields.amount, '金额里的逗号、大写、剩余款和总款语义混淆。');
  }
  if (expected.paymentAmount !== undefined && !moneyEqual(fields.paymentAmount, expected.paymentAmount)) {
    addError(errors, fields.paymentAmount ? 'wrong_payment_amount' : 'field_missing', 'paymentAmount', expected.paymentAmount, fields.paymentAmount, '收款金额与剩余金额、到账错别字或大写金额区分不足。');
  }
  if (expected.depositAmount !== undefined && !moneyEqual(fields.depositAmount, expected.depositAmount)) {
    addError(errors, fields.depositAmount ? 'wrong_deposit_amount' : 'field_missing', 'depositAmount', expected.depositAmount, fields.depositAmount, '定金/订金错别字和订单上下文关联不足。');
  }
  if (expected.dueDatePresent && !fields.dueDate) {
    addError(errors, 'field_missing', 'dueDate', '有日期', fields.dueDate, '相对日期、缺少标点或口语时间没有被稳定识别。');
  }
  if (expected.todoTitle && !textIncludes(fields.todoTitle, expected.todoTitle.replace(/报价$/, ''))) {
    addError(errors, fields.todoTitle ? 'wrong_todo_title' : 'field_missing', 'todoTitle', expected.todoTitle, fields.todoTitle, '待办标题遇到错别字或口语省略时无法归一化。');
  }
  if (expected.remarkIncludes && !textIncludes(fields.remark, expected.remarkIncludes)) {
    addError(errors, 'remark_lost', 'remark', expected.remarkIncludes, fields.remark, '特殊要求分散在多轮消息或写法不标准时备注丢失。');
  }
  if (expected.conflictFields) {
    const actualConflicts = (result.field_conflicts || []).map((item) => item.field);
    expected.conflictFields.forEach((field) => {
      if (!actualConflicts.includes(field)) {
        addError(errors, 'conflict_not_flagged', 'field_conflicts', field, actualConflicts.join(','), '多轮改价没有标记旧值和新值的冲突。');
      }
    });
  }
  if (expected.multiProducts) {
    const productName = String(fields.productName || '');
    const detectedCount = expected.multiProducts.filter((product) => productName.includes(product)).length;
    if (detectedCount < expected.multiProducts.length) {
      addError(errors, 'multi_record_not_supported', 'productName', expected.multiProducts.join('+'), productName, '多产品、错别字和无标点组合时无法完整识别全部商品。');
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
    no_business_extracted: '降低噪声场景下的业务召回阈值，同时保留无效信息过滤。',
    intent_error: '引入多候选意图和证据权重，错别字或多轮改口交给 AI 仲裁。',
    operation_error: '把更新类动作词和错别字纳入 operation 判定，如延其、报架、憋发。',
    wrong_customer: '说话人、昵称、客户档案做候选匹配，避免从业务句里硬猜客户。',
    field_missing: '建立字段候选池，从原始全量消息而不是单条摘要里补字段。',
    wrong_product: '增加商品别名/音同字/繁简归一化词典，未知商品进入候选而不是丢弃。',
    wrong_quantity: '支持逗号、全角数字、W/w/k、财务大写数字和“3千”格式。',
    wrong_unit_price: '支持更多口语价格和无标点价格，按最后确认消息选择最终价。',
    wrong_amount: '金额解析独立支持逗号、大写和上下文语义。',
    wrong_payment_amount: '到账/到帐/以到账等错别字归一化，收款与剩余款分离。',
    wrong_deposit_amount: '定金/订金/定斤等同音词归一化，并与订单语义合并。',
    wrong_todo_title: '待办标题需要商品别名归一化和动作模板扩展。',
    remark_lost: '备注抽取应从所有相关消息收集要求，并做近义词归一化。',
    conflict_not_flagged: '改价场景保留旧价、新价和最终确认消息作为证据。',
    multi_record_not_supported: '多产品需要真正拆成多条草稿；只拼商品名不是最终能力。'
  };
  return map[type] || '补充规则用例，并优先让 AI 处理该类复杂语义。';
}

function summarizeBy(items, getKeys) {
  const map = {};
  items.forEach((item) => {
    const keys = getKeys(item);
    keys.forEach((key) => {
      if (!map[key]) map[key] = { total: 0, passed: 0, failed: 0 };
      map[key].total += 1;
      if (item.passed) map[key].passed += 1;
      else map[key].failed += 1;
    });
  });
  return map;
}

function tableLine(cells) {
  return `| ${cells.join(' | ')} |`;
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let code = [];
  let inCode = false;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        inCode = true;
      }
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    if (!trimmed) return;
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      return;
    }
    if (trimmed.startsWith('|')) {
      html.push(`<p class="table-row">${escapeHtml(trimmed)}</p>`);
      return;
    }
    if (trimmed.startsWith('- ')) {
      html.push(`<p>${escapeHtml(trimmed)}</p>`);
      return;
    }
    html.push(`<p>${escapeHtml(trimmed)}</p>`);
  });
  return html.join('\n');
}

function buildHtml(markdown) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>微信聊天本地规则高难度评测报告</title>
  <style>
    body { margin: 0; background: #f6f7f9; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.65; }
    main { max-width: 1200px; margin: 0 auto; min-height: 100vh; padding: 32px 24px 56px; background: #fff; box-sizing: border-box; }
    h1 { margin: 0 0 16px; font-size: 30px; line-height: 1.25; }
    h2 { margin: 34px 0 12px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 22px; }
    h3 { margin: 24px 0 8px; font-size: 18px; }
    p { margin: 8px 0; font-size: 14px; }
    .table-row { overflow-x: auto; white-space: pre; padding: 6px 8px; border-bottom: 1px solid #eef0f3; font-family: Consolas, monospace; }
    pre { overflow-x: auto; padding: 14px 16px; border-radius: 8px; background: #111827; color: #f9fafb; white-space: pre-wrap; }
  </style>
</head>
<body><main>${markdownToHtml(markdown)}</main></body>
</html>
`;
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
    rows.push({ testCase, analysis, result, errors, passed: errors.length === 0 });
  }

  const total = rows.length;
  const passed = rows.filter((row) => row.passed).length;
  const failed = total - passed;
  const byCategory = summarizeBy(rows, (row) => [row.testCase.category]);
  const byTag = summarizeBy(rows, (row) => row.testCase.tags || ['未标记']);
  const byError = {};
  rows.flatMap((row) => row.errors).forEach((error) => {
    byError[error.type] = (byError[error.type] || 0) + 1;
  });

  const lines = [];
  lines.push('# 微信聊天本地规则解析 100 条高难度离线评测报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 评测说明');
  lines.push('');
  lines.push('- 本报告沿用上一轮 100 题的 8 类业务类型，但整体提高难度。');
  lines.push('- 新增干扰：无效寒暄/图片提示、多轮改口、标点错误、音同字、繁简混用、数字大小写/全角/W/逗号混写。');
  lines.push('- 评测链路仍然只跑本地规则：`analyzeClipboardText -> parseHybridInput`。当前 Node 环境不会调用真实 AI。');
  lines.push('- 通过表示本地规则抽出的核心字段达到预期；失败表示该场景需要继续增强本地规则或交给 AI 仲裁。');
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
    lines.push(tableLine([md(category), item.total, item.passed, item.failed, `${((item.passed / item.total) * 100).toFixed(1)}%`]));
  });
  lines.push('');
  lines.push('## 按新增难度统计');
  lines.push('');
  lines.push('| 难度标签 | 用例数 | 通过 | 失败 | 通过率 |');
  lines.push('|---|---:|---:|---:|---:|');
  Object.entries(byTag)
    .sort((left, right) => right[1].failed - left[1].failed || right[1].total - left[1].total)
    .forEach(([tag, item]) => {
      lines.push(tableLine([md(tag), item.total, item.passed, item.failed, `${((item.passed / item.total) * 100).toFixed(1)}%`]));
    });
  lines.push('');
  lines.push('## 错误类型统计');
  lines.push('');
  lines.push('| 错误类型 | 次数 | 初步解决方向 |');
  lines.push('|---|---:|---|');
  if (Object.keys(byError).length) {
    Object.entries(byError)
      .sort((left, right) => right[1] - left[1])
      .forEach(([type, count]) => lines.push(tableLine([md(type), count, md(solutionForType(type))])));
  } else {
    lines.push('| 无 | 0 | 暂无 |');
  }
  lines.push('');
  lines.push('## 主要发现');
  lines.push('');
  const topTypes = Object.entries(byError).sort((left, right) => right[1] - left[1]).slice(0, 8);
  if (topTypes.length) {
    topTypes.forEach(([type, count], index) => lines.push(`${index + 1}. ${type}：${count} 次。${solutionForType(type)}`));
  } else {
    lines.push('本轮没有发现失败用例。');
  }
  lines.push('');
  lines.push('## 失败样例摘录');
  lines.push('');
  rows.filter((row) => !row.passed).slice(0, 30).forEach((row) => {
    lines.push(`### ${row.testCase.id} ${row.testCase.title}`);
    lines.push('');
    lines.push(`- 场景：${row.testCase.category}`);
    lines.push(`- 难度标签：${(row.testCase.tags || []).join('、')}`);
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
  lines.push('| ID | 场景 | 难度标签 | 微信聊天摘要 | 是否通过 | 错误类型 | 错误原因 | 预期 | 实际 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  rows.forEach((row) => {
    lines.push(tableLine([
      row.testCase.id,
      md(row.testCase.category),
      md((row.testCase.tags || []).join('、')),
      md(compactChat(row.testCase.raw)),
      row.passed ? '通过' : '失败',
      md(errorTypeSummary(row.errors)),
      md(causeSummary(row.errors)),
      md(expectedSummary(row.testCase.expected)),
      md(actualSummary(row.result, row.analysis))
    ]));
  });
  lines.push('');
  lines.push('## 建议优先级');
  lines.push('');
  lines.push('1. 优先做商品别名/音同字/繁简归一化词典，先覆盖高频客户商品。');
  lines.push('2. 数字解析扩展到逗号、全角、W/w/k、财务大写，以及“3千/2千5”这类口语。');
  lines.push('3. 摘要层保留更多多轮上下文，尤其是“旧价 -> 还价 -> 最终确认”的最后一轮。');
  lines.push('4. 多产品场景仍建议拆多条草稿；本地只能识别列表，不等于能安全保存多条记录。');
  lines.push('5. 错别字、反复改口和上下文消歧应作为 AI 必走条件，而不是完全依赖本地规则。');

  const markdown = `${lines.join('\n')}\n`;
  fs.writeFileSync(REPORT_MD, markdown, 'utf8');
  fs.writeFileSync(REPORT_TXT, `\uFEFF${markdown}`, 'utf8');
  fs.writeFileSync(REPORT_HTML, `\uFEFF${buildHtml(markdown)}`, 'utf8');
  console.log(`Wrote ${REPORT_MD}`);
  console.log(`Wrote ${REPORT_HTML}`);
  console.log(`Wrote ${REPORT_TXT}`);
  console.log(`Total ${total}, passed ${passed}, failed ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
