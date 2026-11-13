const assert = require('assert');
const { withFixedTestClock } = require('./lib/fixed-test-clock');
const { answerQuery } = require('../utils/query');
const { askHybridQuery } = require('../utils/ai-query');

let passed = 0;
let total = 0;
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error('QUERY_MUST_STAY_LOCAL_READONLY'); };
global.wx = { getStorageSync: forbidden, setStorageSync: forbidden, request: forbidden, login: forbidden };
const state = {
  customers: [{ id: 'a', name: '程总' }, { id: 'b', name: '赵姐' }, { id: 'c', name: '王总' }, { id: 'd', name: '张三' }, { id: 'old', name: '刘总', mergedInto: 'c' }],
  orders: [
    { id: 'oa', customerId: 'a', productName: '水杯', quantity: '7', unit: '个', unitPrice: '11', totalAmount: '77', requiredDeliveryDate: '2026-11-13', status: '待生产' },
    { id: 'ob', customerId: 'b', productName: '纸袋', quantity: '3', unit: '个', totalAmount: '9', requiredDeliveryDate: '2026-11-13', status: '待生产' },
    { id: 'od', customerId: 'd', productName: '包装盒', quantity: '2', unit: '个', totalAmount: '18', requiredDeliveryDate: '2026-11-13', status: '待生产' }
  ],
  quotations: [{ id: 'qa', customerId: 'a', productName: '水杯', quantity: '7', unit: '个', totalAmount: '77', quoteDate: '2026-11-01', status: '待确认' }],
  receivables: [{ id: 'ra', customerId: 'a', amount: '111', paidAmount: '11', dueDate: '2026-11-13', status: '部分收款' }],
  paymentRecords: [{ id: 'pa', customerId: 'a', amount: '7', paidAt: '2026-11-12', kind: 'unlinked_payment' }],
  todos: [{ id: 'ta', customerId: 'a', title: '确认水杯交货', remindDate: '2026-11-13', status: '未完成' }],
  pendingNotes: [], dunningRecords: [], orderProgress: [], aiParseLogs: []
};
const initial = JSON.stringify(state);
function text(answer) { return [answer.title].concat(answer.lines || []).join('\n'); }
function check(name, run) {
  total += 1;
  try { run(); assert.strictEqual(JSON.stringify(state), initial); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL ${name}: ${error.message}`); }
}
async function main() {
  await withFixedTestClock('2026-11-12T02:00:00Z', 'Asia/Shanghai', async () => {
    for (const question of [
      '孙总订单进度怎么样？', '请问孙总的订单现在怎么样？', '帮我查一下孙总还欠多少钱？',
      '孙总本月收了多少？', '孙总上次报价多少？', '孙总收到多少定金？', '孙总明天有什么待办？',
      '孙姐订单进度怎么样？', '孙哥还欠多少？', '孙老板订单怎么样？', '王先生订单怎么样？',
      '陈女士还欠多少？', '王小明订单怎么样？', '赵四还欠多少钱？', '刘总订单怎么样？', '孙王总订单怎么样？',
      '最近孙总的订单进度怎么样？', '总计孙总还欠多少钱？', '月底孙总有哪些订单要交？', '本周要交给孙总哪些订单？', 'Alex订单怎么样？', '要交给张三哪些订单？'
    ]) {
      check(`未找到指定客户不能退为全量：${question}`, () => {
        const result = text(answerQuery(question, state));
        assert(result.includes('没找到这位客户') || result.includes('请确认要查哪位客户'), result);
        for (const other of ['水杯', '纸袋', '包装盒', '100元', '77元']) assert(!result.includes(other), result);
      });
    }
    for (const [question, include, exclude] of [
      ['程总订单进度怎么样？', '77元', '纸袋'],
      ['帮我查一下程总订单进度怎么样？', '水杯', '纸袋'],
      ['赵姐订单怎么样？', '纸袋', '水杯'],
      ['张三订单怎么样？', '包装盒', '水杯'],
      ['程总还欠多少钱？', '100', '纸袋'],
      ['程总上次报价是多少？', '77', '纸袋'],
      ['程总收了多少？', '7 元', '纸袋'],
      ['程总明天有什么待办？', '确认水杯交货', '纸袋'],
      ['最近程总的订单进度怎么样？', '77元', '纸袋'],
      ['帮我查程总订单进度怎么样？', '77元', '纸袋']
    ]) check(`已知客户仍只查自己的记录：${question}`, () => {
      const result = text(answerQuery(question, state));
      assert(result.includes(include), result); assert(!result.includes(exclude), result);
    });
    for (const question of ['近期要交哪些订单？', '这周要交哪些货？', '月底前要收哪些款？', '所有客户订单怎么样？', '汇总订单', '订单总金额多少？', '哪些报价还没转订单？', '谁还欠我钱？', '本月收款合计多少？', '客户总数多少？', '总共收了多少钱？', '老板今天有啥事？', '明天有什么待办？', '今天有什么事？', '有哪些待办没做？']) {
      check(`一般查询不能误认客户：${question}`, () => {
        const result = text(answerQuery(question, state));
        assert(!result.includes('没找到这位客户') && !result.includes('请确认要查哪位客户'), result);
      });
    }
    check('一般交货查询保留多位客户', () => {
      const result = text(answerQuery('近期要交哪些订单？', state));
      assert(result.includes('水杯') && result.includes('纸袋') && result.includes('包装盒'), result);
    });
    check('全空状态仍提示未找到指定客户', () => {
      const empty = Object.fromEntries(Object.keys(state).map(key => [key, []]));
      assert(text(answerQuery('孙总订单怎么样？', empty)).includes('没找到这位客户'));
    });
    check('空问题继续提示输入', () => assert.strictEqual(answerQuery('', state).title, '还没输入问题'));
    const hybrid = await askHybridQuery('孙总订单进度怎么样？', state);
    check('真实页面使用的Hybrid查询仍是本地只读结果', () => {
      assert.strictEqual(hybrid.provider, 'local'); assert.strictEqual(hybrid.aiStatus, 'local');
      assert(text(hybrid).includes('没找到这位客户'));
    });
    check('没有网络或Storage操作', () => assert.strictEqual(externalCalls, 0));
    check('不按裸姓把未知称呼关联到已知客户', () => {
      assert(text(answerQuery('王总监订单怎么样？', state)).includes('请确认要查哪位客户'));
    });
    check('明确并列客户继续要求确认', () => {
      assert(text(answerQuery('程总和孙总订单怎么样？', state)).includes('请确认要查哪位客户'));
    });
    check('客户名出现在商品品牌中不改变查询范围', () => {
      const branded = Object.assign({}, state, { customers: state.customers.concat({ id: 'brand', name: '老李' }) });
      const result = text(answerQuery('程总的老李牌水杯订单现在怎么样？', branded));
      assert(result.includes('77元') && !result.includes('请确认要查哪位客户'), result);
    });
    check('完整登记名称不被内部称呼截断', () => {
      const longer = Object.assign({}, state, { customers: state.customers.concat({ id: 'long', name: '王总贸易' }), orders: state.orders.concat({ id: 'ol', customerId: 'long', productName: '布袋', quantity: '8', unit: '个', totalAmount: '24', requiredDeliveryDate: '2026-11-13', status: '待生产' }) });
      const result = text(answerQuery('王总贸易订单怎么样？', longer));
      assert(result.includes('布袋') && result.includes('24元') && !result.includes('水杯'), result);
    });
    check('同名客户不能自动挑一个', () => {
      const duplicate = Object.assign({}, state, { customers: state.customers.concat({ id: 'a2', name: '程总' }) });
      assert(text(answerQuery('程总订单怎么样？', duplicate)).includes('请确认要查哪位客户'));
    });
    const others = Object.assign({}, state, {
      pendingNotes: [{ id: 'pb', status: '待整理', originalText: '赵姐还有333元没给，待核对' }],
      quotations: state.quotations.concat({ id: 'qb', customerId: 'b', productName: '纸袋', totalAmount: '20', quoteDate: '2026-11-01', status: '待确认' })
    });
    check('指定客户的待整理查询不能显示别人的原话', () => {
      const result = text(answerQuery('程总的待整理记录有哪些？', others));
      assert(result.includes('暂不支持按客户查询') && !result.includes('赵姐') && !result.includes('333'), result);
    });
    check('指定客户的今日汇总不能统计全部客户', () => {
      const result = text(answerQuery('程总今天有什么事？', others));
      assert(result.includes('暂不提供按客户的今日汇总') && !result.includes('今天有 ') && !result.includes('赵姐'), result);
    });
    check('指定客户的跟进查询保持客户过滤', () => {
      const result = text(answerQuery('程总的待跟进有哪些？', others));
      assert(result.includes('程总') && result.includes('水杯') && !result.includes('纸袋') && !result.includes('赵姐'), result);
    });
  });
  console.log(`Query customer boundaries: ${passed}/${total} passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
