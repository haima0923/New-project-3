const fs = require('fs');
const path = require('path');
const { analyzeClipboardText, getPasteMeta } = require('../utils/clipboard-chat');
const { parseHybridInput } = require('../utils/ai-parser');
const { normalizeBusinessText } = require('../utils/text-normalize');

const REPORT_MD = path.resolve(__dirname, '../docs/wechat-local-rules-ultra-evaluation.md');
const REPORT_HTML = path.resolve(__dirname, '../docs/wechat-local-rules-ultra-evaluation.html');
const REPORT_TXT = path.resolve(__dirname, '../docs/wechat-local-rules-ultra-evaluation.txt');
const ROOT_MD = path.resolve(__dirname, '../微信本地规则100条升级难度测试报告.md');
const ROOT_HTML = path.resolve(__dirname, '../微信本地规则100条升级难度测试报告.html');
const ROOT_TXT = path.resolve(__dirname, '../微信本地规则100条升级难度测试报告.txt');
const BASE_DATE = '2026年7月1日';

function time(index) {
  const totalMinutes = 9 * 60 + 3 + index;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function wxChat(messages) {
  return messages
    .map(([speaker, content], index) => `${speaker}\n${BASE_DATE} ${time(index)}\n${content}`)
    .join('\n\n');
}

function add(cases, category, title, messages, expected, tags = []) {
  cases.push({
    id: String(cases.length + 1).padStart(3, '0'),
    category,
    title,
    raw: wxChat(messages),
    expected,
    tags
  });
}

const cases = [];

[
  ['报价升级', '王总水杯图文混杂报价', [['王总', '[图片] 不是这个图，下面那个水怀 1,200 个先报下'], ['海马', '5块3一个，不含运费']], { intent: 'quotation', customer: '王总', productName: '水杯', quantity: '1200', unitPrice: '5.3' }, ['图片干扰', '音同字', '逗号数字']],
  ['报价升级', '李姐钥匙扣口语报价', [['李姐', '早，钥匙口两千五百个多钱，先别下单'], ['海马', '1块25一个']], { intent: 'quotation', customer: '李姐', productName: '钥匙扣', quantity: '2500', unitPrice: '1.25' }, ['音同字', '中文数量', '意图否定']],
  ['报价升级', '陈老板杯垫语音错字报价', [['陈老板', '语音转文字：杯甸八百个，问个价'], ['海马', '九毛五']], { intent: 'quotation', customer: '陈老板', productName: '杯垫', quantity: '800', unitPrice: '0.95' }, ['语音错字', '口语价格']],
  ['报价升级', '周姐礼盒简称报价', [['周姐', '礼合 600套先报，不一定做'], ['海马', '4.2/套']], { intent: 'quotation', customer: '周姐', productName: '礼品盒', quantity: '600', unitPrice: '4.2' }, ['简称错字', '斜杠价格', '意图否定']],
  ['报价升级', '钱总包装袋繁简混用报价', [['钱总', '包裝袋 3W 只，透明的，多少钱'], ['海马', '7分5一只']], { intent: 'quotation', customer: '钱总', productName: '包装袋', quantity: '30000', unitPrice: '0.075', remarkIncludes: '透明' }, ['繁简混用', '英文数量', '厘级价格']],
  ['报价升级', '孙总旧款杯垫报价', [['孙总', '老款杯甸再报一下，壹仟伍佰个'], ['海马', '还是8毛']], { intent: 'quotation', customer: '孙总', productName: '老款杯垫', quantity: '1500', unitPrice: '0.8' }, ['财务大写', '音同字']],
  ['报价升级', '赵姐饰品盒紧凑报价', [['赵姐', '饰品合800? 多钱'], ['海马', '2.35呢']], { intent: 'quotation', customer: '赵姐', productName: '饰品盒', quantity: '800', unitPrice: '2.35' }, ['音同字', '缺少单位', '裸数字价格']],
  ['报价升级', '黄老板挂件含尺寸报价', [['黄老板', '五金挂件 30mm 的 3千个，报架一下'], ['海马', '一块六']], { intent: 'quotation', customer: '黄老板', productName: '五金挂件', quantity: '3000', unitPrice: '1.6' }, ['尺寸干扰', '错别字', '中文数量']],
  ['报价升级', '吴总头绳小数价格报价', [['吴总', '头绳5000条，黑色多一点，几钱'], ['海马', '0.36一条']], { intent: 'quotation', customer: '吴总', productName: '头绳', quantity: '5000', unitPrice: '0.36', remarkIncludes: '黑色多一点' }, ['口语问价', '特殊要求']],
  ['报价升级', '刘总收纳盒错字报价', [['刘总', '收钠合陆佰个，带盖的，问价'], ['海马', '7块9']], { intent: 'quotation', customer: '刘总', productName: '收纳盒', quantity: '600', unitPrice: '7.9', remarkIncludes: '带盖' }, ['错别字', '财务大写', '备注']]
].forEach((item) => add(cases, ...item));

[
  ['订单交期升级', '王总先错后改数量订单', [['王总', '卡通水怀先做100，哦不对是一千个'], ['海马', '收到，5.5一个，7/8号前出']], { intent: 'order', customer: '王总', productName: '卡通水杯', quantity: '1000', unitPrice: '5.5', dueDatePresent: true }, ['前后纠正', '斜杠日期']],
  ['订单交期升级', '李姐交期反复订单', [['李姐', '钥匙扣2000个做吧'], ['海马', '1.2一个，下周五发'], ['李姐', '尽量周四晚上前']], { intent: 'order', customer: '李姐', productName: '钥匙扣', quantity: '2000', unitPrice: '1.2', dueDatePresent: true, remarkIncludes: '周四晚上前' }, ['交期反复', '最后要求']],
  ['订单交期升级', '陈老板单位换算订单', [['陈老板', '杯垫 30包，每包100个，先做'], ['海马', '9毛，明早交']], { intent: 'order', customer: '陈老板', productName: '杯垫', quantity: '3000', unitPrice: '0.9', dueDatePresent: true }, ['包装换算', '相对时间']],
  ['订单交期升级', '周姐数量追加订单', [['周姐', '礼品盒先做500套'], ['周姐', '刚确认再加200套，一共700'], ['海马', '3.8一套，后天上午出']], { intent: 'order', customer: '周姐', productName: '礼品盒', quantity: '700', unitPrice: '3.8', dueDatePresent: true }, ['数量追加', '最终数量']],
  ['订单交期升级', '钱总包装袋分批订单', [['钱总', '包装袋1w只先做，后面可能还有2w'], ['海马', '8分一只，下周先发这一万']], { intent: 'order', customer: '钱总', productName: '包装袋', quantity: '10000', unitPrice: '0.08', dueDatePresent: true, remarkIncludes: '后面可能还有20000' }, ['潜在追加', '不要误加总数']],
  ['订单交期升级', '孙总照旧价订单', [['孙总', '老款杯垫一千个，按上次价做'], ['海马', '好的，月底前交']], { intent: 'order', customer: '孙总', productName: '老款杯垫', quantity: '1000', lowConfidenceFields: ['unitPrice'], dueDatePresent: true }, ['历史价格', '低置信字段']],
  ['订单交期升级', '赵姐饰品盒缺标点订单', [['赵姐', '饰品合800做吧颜色浅点'], ['海马', '2.3三天后拿']], { intent: 'order', customer: '赵姐', productName: '饰品盒', quantity: '800', unitPrice: '2.3', dueDatePresent: true, remarkIncludes: '颜色浅点' }, ['缺少标点', '音同字', '备注']],
  ['订单交期升级', '黄老板周末交期订单', [['黄老板', '五金挂件3000个要货'], ['海马', '1.5一个，这周六能出']], { intent: 'order', customer: '黄老板', productName: '五金挂件', quantity: '3000', unitPrice: '1.5', dueDatePresent: true }, ['这周日期']],
  ['订单交期升级', '吴总口语交期订单', [['吴总', '头绳五千条先排'], ['海马', '三毛五，明儿下午发']], { intent: 'order', customer: '吴总', productName: '头绳', quantity: '5000', unitPrice: '0.35', dueDatePresent: true }, ['口语日期', '中文数量']],
  ['订单交期升级', '刘总收纳盒特殊交期订单', [['刘总', '收纳盒600个，别太晚'], ['海马', '7.8一个，10号中午前']], { intent: 'order', customer: '刘总', productName: '收纳盒', quantity: '600', unitPrice: '7.8', dueDatePresent: true, remarkIncludes: '别太晚' }, ['半日交期', '备注']]
].forEach((item) => add(cases, ...item));

[
  ['改价改量升级', '王总不是25是2.5', [['王总', '水杯报价多少'], ['海马', '25一个'], ['王总', '不是25，是2.5吧'], ['海马', '对，2.5一个，先做1000个月底交']], { intent: 'order', customer: '王总', productName: '水杯', quantity: '1000', unitPrice: '2.5', dueDatePresent: true, conflictFields: ['unitPrice'] }, ['小数纠错', '最终价格']],
  ['改价改量升级', '李姐改数量两次', [['李姐', '钥匙扣先做2000个'], ['李姐', '改2500'], ['李姐', '最后确认2300个'], ['海马', '1.3一个，7天后发']], { intent: 'order', customer: '李姐', productName: '钥匙扣', quantity: '2300', unitPrice: '1.3', dueDatePresent: true, conflictFields: ['quantity'] }, ['多次改量', '最后确认']],
  ['改价改量升级', '陈老板砍价口语', [['陈老板', '杯垫1块贵了'], ['陈老板', '九毛二能做就做300个'], ['海马', '能，明天交']], { intent: 'order', customer: '陈老板', productName: '杯垫', quantity: '300', unitPrice: '0.92', dueDatePresent: true, conflictFields: ['unitPrice'] }, ['口语小数', '还价即下单']],
  ['改价改量升级', '周姐含无效旧价', [['周姐', '礼品盒4块那条作废'], ['周姐', '按3.85一套，500套，后天']], { intent: 'order', customer: '周姐', productName: '礼品盒', quantity: '500', unitPrice: '3.85', dueDatePresent: true }, ['作废旧价', '小数价格']],
  ['改价改量升级', '钱总分和厘价格', [['钱总', '包装袋之前8分'], ['钱总', '这次7分8可以吗'], ['海马', '可以，1w只下周发']], { intent: 'order', customer: '钱总', productName: '包装袋', quantity: '10000', unitPrice: '0.078', dueDatePresent: true, conflictFields: ['unitPrice'] }, ['厘级价格', '改价']],
  ['改价改量升级', '孙总旧货取消新货确认', [['孙总', '老款杯垫1000个先不要'], ['孙总', '改成水杯800个，5.5，月底']], { intent: 'order', customer: '孙总', productName: '水杯', quantity: '800', unitPrice: '5.5', dueDatePresent: true }, ['取消旧产品', '改产品']],
  ['改价改量升级', '赵姐最后一句裸价', [['赵姐', '饰品盒800个多少钱'], ['海马', '2.5'], ['赵姐', '贵'], ['海马', '2.35'], ['赵姐', '就这个做，三天后拿']], { intent: 'order', customer: '赵姐', productName: '饰品盒', quantity: '800', unitPrice: '2.35', dueDatePresent: true, conflictFields: ['unitPrice'] }, ['裸数字价格', '最后确认']],
  ['改价改量升级', '黄老板同句纠错', [['黄老板', '五金挂件3000个，单价写错，不是1.8是1.5，周五出']], { intent: 'order', customer: '黄老板', productName: '五金挂件', quantity: '3000', unitPrice: '1.5', dueDatePresent: true, conflictFields: ['unitPrice'] }, ['同句否定纠错']],
  ['改价改量升级', '吴总数量不是价格', [['吴总', '头绳5000条0.35'], ['吴总', '不是3500，是5000条'], ['海马', '明天发']], { intent: 'order', customer: '吴总', productName: '头绳', quantity: '5000', unitPrice: '0.35', dueDatePresent: true }, ['数字歧义', '纠错']],
  ['改价改量升级', '刘总价格与日期粘连', [['刘总', '收纳盒600个'], ['海马', '7.85天后交'], ['海马', '刚刚少了逗号，是7.8，5天后交']], { intent: 'order', customer: '刘总', productName: '收纳盒', quantity: '600', unitPrice: '7.8', dueDatePresent: true, conflictFields: ['unitPrice'] }, ['价格日期粘连', '补充纠错']]
].forEach((item) => add(cases, ...item));

[
  ['备注升级', '王总颜色否定覆盖', [['王总', '杯子1000个颜色深一点'], ['王总', '不对，颜色淡一点，别太深'], ['海马', '25一个月底交']], { intent: 'order', customer: '王总', productName: '杯子', quantity: '1000', unitPrice: '25', remarkIncludes: '颜色淡一点' }, ['备注覆盖', '否定旧要求']],
  ['备注升级', '李姐包装比例', [['李姐', '钥匙扣2000个，每50个一袋'], ['李姐', '外箱别写中文'], ['海马', '1.3一个月底交']], { intent: 'order', customer: '李姐', productName: '钥匙扣', quantity: '2000', unitPrice: '1.3', remarkIncludes: '外箱别写中文' }, ['包装要求', '多轮备注']],
  ['备注升级', '陈老板logo位置', [['陈老板', '杯垫300个logo放中间，不要太靠边'], ['海马', '9毛明天交']], { intent: 'order', customer: '陈老板', productName: '杯垫', quantity: '300', unitPrice: '0.9', remarkIncludes: 'logo放中间' }, ['英文混入', '备注']],
  ['备注升级', '周姐材质要求', [['周姐', '礼品盒500套，外箱不要太厚'], ['周姐', '里面加隔板'], ['海马', '3.8后天出']], { intent: 'order', customer: '周姐', productName: '礼品盒', quantity: '500', unitPrice: '3.8', remarkIncludes: '加隔板' }, ['多备注', '材料要求']],
  ['备注升级', '钱总透明度', [['钱总', '包装袋1w只透明度高点'], ['钱总', '袋口别太紧'], ['海马', '8分下周发']], { intent: 'order', customer: '钱总', productName: '包装袋', quantity: '10000', unitPrice: '0.08', remarkIncludes: '袋口别太紧' }, ['特殊工艺', '备注']],
  ['备注升级', '孙总颜色沿用修改', [['孙总', '老款杯垫1000个颜色按上回'], ['孙总', '但别偏黄'], ['海马', '8毛月底交']], { intent: 'order', customer: '孙总', productName: '老款杯垫', quantity: '1000', unitPrice: '0.8', remarkIncludes: '别偏黄' }, ['历史备注', '补充要求']],
  ['备注升级', '赵姐盒子结构', [['赵姐', '饰品盒800个盒子里面加隔板'], ['赵姐', '磁吸不要太松'], ['海马', '2.3三天后拿']], { intent: 'order', customer: '赵姐', productName: '饰品盒', quantity: '800', unitPrice: '2.3', remarkIncludes: '磁吸不要太松' }, ['结构要求', '备注']],
  ['备注升级', '黄老板材质', [['黄老板', '五金挂件3000个换不锈钢'], ['黄老板', '边缘别刮手'], ['海马', '1.5周五出']], { intent: 'order', customer: '黄老板', productName: '五金挂件', quantity: '3000', unitPrice: '1.5', remarkIncludes: '边缘别刮手' }, ['材质要求', '安全要求']],
  ['备注升级', '吴总颜色比例', [['吴总', '头绳5000条黑色多一点，红色少一点'], ['海马', '0.35明天发']], { intent: 'order', customer: '吴总', productName: '头绳', quantity: '5000', unitPrice: '0.35', remarkIncludes: '红色少一点' }, ['颜色比例']],
  ['备注升级', '刘总尺寸要求', [['刘总', '收纳盒600个尺寸比上次大一点'], ['刘总', '盖子要紧一点'], ['海马', '7.8 10号交']], { intent: 'order', customer: '刘总', productName: '收纳盒', quantity: '600', unitPrice: '7.8', remarkIncludes: '盖子要紧一点' }, ['尺寸要求', '备注']]
].forEach((item) => add(cases, ...item));

[
  ['收款应收升级', '陈总货款含不要算运费', [['陈总', '刚那个运费别算'], ['陈总', '货款一共15,000，月底结']], { intent: 'receivable', customer: '陈总', amount: '15000', dueDatePresent: true }, ['金额逗号', '无效金额干扰']],
  ['收款应收升级', '刘总尾款中文大写', [['刘总', '上次尾款还差伍仟，下周三给']], { intent: 'receivable', customer: '刘总', amount: '5000', dueDatePresent: true }, ['财务大写', '尾款']],
  ['收款应收升级', '老李到账和剩余', [['老李', '刚转3000，剩2000明天补']], { intent: 'payment', customer: '老李', paymentAmount: '3000', dueDatePresent: true, remarkIncludes: '剩2000' }, ['收款剩余分离']],
  ['收款应收升级', '周姐到账错字', [['周姐', '以到账8600，微信转的']], { intent: 'payment', customer: '周姐', paymentAmount: '8600' }, ['错别字', '到账']],
  ['收款应收升级', '马总定金', [['马总', '杯垫定斤收了1000，货月底交']], { intent: 'payment', customer: '马总', paymentAmount: '1000', dueDatePresent: true }, ['定金错字']],
  ['收款应收升级', '王总订单定金', [['王总', '水杯1000个先付订金两千，月底交']], { intent: 'order', customer: '王总', productName: '水杯', quantity: '1000', depositAmount: '2000', dueDatePresent: true }, ['订单定金', '中文金额']],
  ['收款应收升级', '黄老板挂账', [['黄老板', '五金挂件尾款12,000还没给，先挂帐']], { intent: 'receivable', customer: '黄老板', amount: '12000' }, ['挂账错字', '金额逗号']],
  ['收款应收升级', '赵姐付款和剩余中文', [['赵姐', '饰品盒款付了2300，剩余陆佰']], { intent: 'payment', customer: '赵姐', paymentAmount: '2300', remarkIncludes: '剩余600' }, ['收款剩余', '中文数字']],
  ['收款应收升级', '吴总总额待付', [['吴总', '头绳总共1750，明天付款']], { intent: 'receivable', customer: '吴总', amount: '1750', dueDatePresent: true }, ['总额', '应收']],
  ['收款应收升级', '钱总先收后面还有', [['钱总', '包装袋先收800，后面还有2千']], { intent: 'payment', customer: '钱总', paymentAmount: '800', remarkIncludes: '后面还有2000' }, ['收款部分', '剩余款']]
].forEach((item) => add(cases, ...item));

[
  ['更新取消升级', '王总价格更新', [['王总', '那单水杯价格改成25一个，刚刚30别用']], { operation: 'update_order', customer: '王总', productName: '水杯', unitPrice: '25', conflictFields: ['unitPrice'] }, ['更新', '旧值作废']],
  ['更新取消升级', '李姐数量更新', [['李姐', '钥匙扣那单数量改成贰仟伍佰个']], { operation: 'update_order', customer: '李姐', productName: '钥匙扣', quantity: '2500' }, ['更新', '财务大写']],
  ['更新取消升级', '陈老板交期提前', [['陈老板', '杯垫交期提前到明早，不是后天']], { operation: 'update_order', customer: '陈老板', productName: '杯垫', dueDatePresent: true }, ['交期更新', '否定旧日期']],
  ['更新取消升级', '周姐延期错字', [['周姐', '礼品盒延其到下周二，客户说不急']], { operation: 'update_order', customer: '周姐', productName: '礼品盒', dueDatePresent: true, remarkIncludes: '不急' }, ['错别字', '延期']],
  ['更新取消升级', '钱总暂停发货', [['钱总', '包装袋先憋发，等我通知']], { intent: 'unknown', customer: '钱总' }, ['暂停', '不要生成订单']],
  ['更新取消升级', '孙总取消旧款', [['孙总', '老款杯垫不要作了，客户取消']], { intent: 'unknown', customer: '孙总' }, ['取消', '不要生成订单']],
  ['更新取消升级', '赵姐备注更新', [['赵姐', '饰品盒这单备注下，盒子里加隔板，别漏']], { operation: 'update_order', customer: '赵姐', productName: '饰品盒', remarkIncludes: '加隔板' }, ['备注更新']],
  ['更新取消升级', '黄老板报价更新', [['黄老板', '五金挂件上次报架写错，改成1.5一个']], { operation: 'update_quotation', customer: '黄老板', productName: '五金挂件', unitPrice: '1.5' }, ['报价更新', '错别字']],
  ['更新取消升级', '吴总按上次返单', [['吴总', '头绳再来5000条，按上图，明天发']], { intent: 'order', customer: '吴总', productName: '头绳', quantity: '5000', dueDatePresent: true, lowConfidenceFields: ['unitPrice'] }, ['返单', '历史价格']],
  ['更新取消升级', '刘总箱规更新', [['刘总', '收纳盒这单箱规改小，价格数量不变']], { operation: 'update_order', customer: '刘总', productName: '收纳盒', remarkIncludes: '箱规改小' }, ['备注更新', '价格不变']]
].forEach((item) => add(cases, ...item));

[
  ['多产品升级', '王总两产品同交期', [['王总', '水杯1000个5.5，杯垫300个9毛，月底一起交']], { intent: 'order', customer: '王总', multiProducts: ['水杯', '杯垫'] }, ['多产品', '同句']],
  ['多产品升级', '李姐报价两产品', [['李姐', '钥匙扣2000个1.3，包装袋1w只8分，先都报给客户']], { intent: 'quotation', customer: '李姐', multiProducts: ['钥匙扣', '包装袋'] }, ['多产品报价']],
  ['多产品升级', '陈老板产品备注交错', [['陈老板', '杯垫300个颜色浅点；礼品盒500套logo放大']], { intent: 'order', customer: '陈老板', multiProducts: ['杯垫', '礼品盒'] }, ['多产品', '备注交错']],
  ['多产品升级', '周姐两个问价', [['周姐', '先问饰品盒800套多少钱，再问收纳盒600个多少钱']], { intent: 'quotation', customer: '周姐', multiProducts: ['饰品盒', '收纳盒'] }, ['多产品问价']],
  ['多产品升级', '钱总包装袋贴纸一起报', [['钱总', '包装袋一万只，贴纸两万张，一起报']], { intent: 'quotation', customer: '钱总', multiProducts: ['包装袋', '贴纸'] }, ['多产品报价', '中文数量']],
  ['多产品升级', '孙总老款和新款', [['孙总', '老款杯垫1000个，新水杯800个，价格照旧']], { intent: 'order', customer: '孙总', multiProducts: ['老款杯垫', '水杯'], lowConfidenceFields: ['unitPrice'] }, ['多产品', '历史价格']],
  ['多产品升级', '赵姐小夜灯饰品盒', [['赵姐', '饰品盒800个2.3，小夜灯1200个4.6，三天后都拿']], { intent: 'order', customer: '赵姐', multiProducts: ['饰品盒', '小夜灯'], dueDatePresent: true }, ['多产品', '多价格']],
  ['多产品升级', '黄老板挂件钥匙扣', [['黄老板', '五金挂件三千个，钥匙扣两千个，周五出']], { intent: 'order', customer: '黄老板', multiProducts: ['五金挂件', '钥匙扣'], dueDatePresent: true }, ['多产品', '中文数量']],
  ['多产品升级', '吴总头绳扣子', [['吴总', '头绳5000条0.35，扣紫1000件0.38，明天发']], { intent: 'order', customer: '吴总', multiProducts: ['头绳', '扣子'], dueDatePresent: true }, ['音同字', '多产品']],
  ['多产品升级', '刘总收纳盒箱子', [['刘总', '收纳合600个7.8，箱子500个19，10号交']], { intent: 'order', customer: '刘总', multiProducts: ['收纳盒', '箱子'], dueDatePresent: true }, ['音同字', '多产品']]
].forEach((item) => add(cases, ...item));

[
  ['待办升级', '王总回报价', [['王总', '明天提醒我回水怀报价，别忘']], { intent: 'todo', customer: '王总', todoTitleIncludes: '水杯', dueDatePresent: true }, ['待办', '音同字']],
  ['待办升级', '李姐后天发价格', [['李姐', '后天给她回钥匙口价格']], { intent: 'todo', customer: '李姐', todoTitleIncludes: '钥匙扣', dueDatePresent: true }, ['待办', '音同字']],
  ['待办升级', '陈老板催尾款', [['陈老板', '下午催一下杯甸尾款']], { intent: 'todo', customer: '陈老板', todoTitleIncludes: '尾款', dueDatePresent: true }, ['待办', '尾款']],
  ['待办升级', '周姐跟进确认', [['周姐', '明天跟进礼合确认没']], { intent: 'todo', customer: '周姐', todoTitleIncludes: '礼品盒', dueDatePresent: true }, ['待办', '简称错字']],
  ['待办升级', '钱总联系样品', [['钱总', '下周联系包妆袋样品']], { intent: 'todo', customer: '钱总', todoTitleIncludes: '包装袋', dueDatePresent: true }, ['待办', '音同字']],
  ['待办升级', '孙总月底催款', [['孙总', '月底催老款杯垫货款!!!']], { intent: 'todo', customer: '孙总', todoTitleIncludes: '货款', dueDatePresent: true }, ['待办', '标点噪声']],
  ['待办升级', '赵姐问数量', [['赵姐', '明天问饰品合数量到底多少']], { intent: 'todo', customer: '赵姐', todoTitleIncludes: '饰品盒', dueDatePresent: true }, ['待办', '音同字']],
  ['待办升级', '黄老板发对账单', [['黄老板', '后天发五金挂件对帐单']], { intent: 'todo', customer: '黄老板', todoTitleIncludes: '对账单', dueDatePresent: true }, ['待办', '错别字']],
  ['待办升级', '吴总回头绳单价', [['吴总', '今天回头绳单价哈']], { intent: 'todo', customer: '吴总', todoTitleIncludes: '头绳', dueDatePresent: true }, ['待办']],
  ['待办升级', '刘总确认颜色', [['刘总', '明天确认收钠盒颜色']], { intent: 'todo', customer: '刘总', todoTitleIncludes: '收纳盒', dueDatePresent: true }, ['待办', '音同字']]
].forEach((item) => add(cases, ...item));

[
  ['无效否定升级', '王总只是聊天不建单', [['王总', '水杯那个客户说先不要了，别做']], { intent: 'unknown', customer: '王总' }, ['取消', '否定']],
  ['无效否定升级', '李姐只比较价格', [['李姐', '钥匙扣1.3这个只是参考，不下单']], { intent: 'unknown', customer: '李姐' }, ['参考价格', '否定']],
  ['无效否定升级', '陈老板截图旧内容', [['陈老板', '[聊天记录] 杯垫300个9毛明天交'], ['陈老板', '这是上个月的记录，别录']], { intent: 'unknown', customer: '陈老板' }, ['旧记录', '不要录入']],
  ['无效否定升级', '周姐问能不能做样品', [['周姐', '礼品盒能不能先打样，不是大货']], { intent: 'quotation', customer: '周姐', productName: '礼品盒' }, ['样品', '非订单']],
  ['无效否定升级', '钱总运输费用干扰', [['钱总', '包装袋运费大概200，货价先不报']], { intent: 'unknown', customer: '钱总' }, ['运费干扰', '不报价']],
  ['无效否定升级', '孙总价格吐槽', [['孙总', '老款杯垫别人报8毛，我先了解下，不要记订单']], { intent: 'quotation', customer: '孙总', productName: '老款杯垫', unitPrice: '0.8' }, ['竞品价格', '非订单']],
  ['无效否定升级', '赵姐撤回消息', [['赵姐', '饰品盒800个2.3三天后拿'], ['赵姐', '撤回了一条消息'], ['赵姐', '先别录，等确认']], { intent: 'unknown', customer: '赵姐' }, ['撤回', '等待确认']],
  ['无效否定升级', '黄老板图片无业务', [['黄老板', '[图片]'], ['黄老板', '这个颜色好看吗']], { intent: 'unknown', customer: '黄老板' }, ['图片闲聊']],
  ['无效否定升级', '吴总售后问题', [['吴总', '头绳上批有几条断了，先处理售后，不是新单']], { intent: 'todo', customer: '吴总', todoTitleIncludes: '售后' }, ['售后', '非订单']],
  ['无效否定升级', '刘总只问库存', [['刘总', '收纳盒还有库存吗，不是要做货']], { intent: 'quotation', customer: '刘总', productName: '收纳盒' }, ['库存咨询', '非订单']]
].forEach((item) => add(cases, ...item));

[
  ['客户识别升级', '群里小号代发', [['小张-采购', '帮王总问下水杯1000个多少钱'], ['海马', '5.5一个']], { intent: 'quotation', customer: '王总', productName: '水杯', quantity: '1000', unitPrice: '5.5' }, ['代发客户', '群聊']],
  ['客户识别升级', '业务员转述订单', [['阿梅', '李姐说钥匙扣2000个先做'], ['海马', '1.2一个7天后发']], { intent: 'order', customer: '李姐', productName: '钥匙扣', quantity: '2000', unitPrice: '1.2', dueDatePresent: true }, ['转述客户']],
  ['客户识别升级', '客户无后缀', [['张三', '杯垫300个多少钱'], ['海马', '9毛']], { intent: 'quotation', customer: '张三', productName: '杯垫', quantity: '300', unitPrice: '0.9' }, ['无称谓客户']],
  ['客户识别升级', '公司名客户', [['义乌宏达', '礼品盒500套报个价'], ['海马', '3.8一套']], { intent: 'quotation', customer: '义乌宏达', productName: '礼品盒', quantity: '500', unitPrice: '3.8' }, ['公司名']],
  ['客户识别升级', '同名客户带备注', [['王总A厂', '包装袋1w只多少钱'], ['海马', '8分一只']], { intent: 'quotation', customer: '王总A厂', productName: '包装袋', quantity: '10000', unitPrice: '0.08' }, ['同名区分']],
  ['客户识别升级', '英文昵称客户', [['Lily', '小夜灯1200个，4.6可以做吗'], ['海马', '可以，5天后交']], { intent: 'order', customer: 'Lily', productName: '小夜灯', quantity: '1200', unitPrice: '4.6', dueDatePresent: true }, ['英文客户']],
  ['客户识别升级', '客户在正文', [['采购群', '赵姐饰品盒800个要做'], ['海马', '2.3三天后拿']], { intent: 'order', customer: '赵姐', productName: '饰品盒', quantity: '800', unitPrice: '2.3', dueDatePresent: true }, ['群聊', '正文客户']],
  ['客户识别升级', '自我备注客户', [['我', '记一下，黄老板五金挂件3000个1.5周五出']], { intent: 'order', customer: '黄老板', productName: '五金挂件', quantity: '3000', unitPrice: '1.5', dueDatePresent: true }, ['自我记录']],
  ['客户识别升级', '昵称带表情', [['刘总🙂', '收纳盒600个7.8，10号交']], { intent: 'order', customer: '刘总', productName: '收纳盒', quantity: '600', unitPrice: '7.8', dueDatePresent: true }, ['昵称符号']],
  ['客户识别升级', '客户和联系人不同', [['老周司机', '周姐让问贴纸2w张多少钱'], ['海马', '1毛2一张']], { intent: 'quotation', customer: '周姐', productName: '贴纸', quantity: '20000', unitPrice: '0.12' }, ['代问', '客户转述']]
].forEach((item) => add(cases, ...item));

function hasValue(value) {
  return value !== undefined && value !== null && String(value) !== '';
}

function moneyEqual(actual, expected) {
  if (expected === undefined) return true;
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.0001;
}

function normalizeComparable(value) {
  return normalizeBusinessText(value)
    .replace(/[，,。；;！？?\s]/g, '')
    .trim();
}

function textIncludes(actual, expected) {
  if (!hasValue(expected)) return true;
  return normalizeComparable(actual).includes(normalizeComparable(expected));
}

function getIntent(result) {
  if (!result) return '';
  return result.intent || '';
}

function addError(errors, type, field, expected, actual, cause) {
  errors.push({ type, field, expected, actual, cause });
}

function evaluateResult(testCase, analysis, result) {
  const expected = testCase.expected || {};
  const errors = [];

  if (expected.intent === 'unknown') {
    const actualIntent = getIntent(result);
    const operation = result && result.operation ? result.operation : '';
    const businessExtracted = analysis.status === 'ok' && !['unknown', 'cancel_order', 'pause_order'].includes(actualIntent) && !['cancel_order', 'pause_order'].includes(operation);
    if (businessExtracted) {
      addError(errors, 'intent_error', 'intent', 'unknown/no_record', actualIntent || operation, '否定、撤回、取消或纯闲聊场景仍被本地规则当成可入库业务。');
    }
    return errors;
  }

  if (analysis.status !== 'ok') {
    addError(errors, 'no_business_extracted', 'analysis.status', 'ok', analysis.status, '本地摘要层没有选出有效业务片段。');
    return errors;
  }

  const fields = (result && result.fields) || {};
  const actualIntent = getIntent(result);
  const actualOperation = (result && result.operation) || '';

  if (expected.operation) {
    if (actualOperation !== expected.operation) {
      addError(errors, 'operation_error', 'operation', expected.operation, actualOperation || actualIntent, '更新、取消、改价、改备注类动作没有被识别成正确操作。');
    }
  } else if (expected.intent && actualIntent !== expected.intent) {
    addError(errors, 'intent_error', 'intent', expected.intent, actualIntent, '业务意图识别错误。');
  }

  if (hasValue(expected.customer) && fields.customerName !== expected.customer) {
    addError(errors, 'wrong_customer', 'customerName', expected.customer, fields.customerName || '', '客户名应优先取真实客户，不应被群名、代发人或无关文本覆盖。');
  }
  if (hasValue(expected.productName) && !textIncludes(fields.productName, expected.productName)) {
    addError(errors, 'wrong_product', 'productName', expected.productName, fields.productName || '', '商品名、简称、音同字或多轮覆盖没有归一到目标产品。');
  }
  if (hasValue(expected.quantity) && !moneyEqual(fields.quantity, expected.quantity)) {
    addError(errors, 'wrong_quantity', 'quantity', expected.quantity, fields.quantity || '', '数量解析错误，常见原因是中文数字、追加/改量、包装换算或干扰数字处理不足。');
  }
  if (hasValue(expected.unitPrice) && !moneyEqual(fields.unitPrice, expected.unitPrice)) {
    addError(errors, 'wrong_unit_price', 'unitPrice', expected.unitPrice, fields.unitPrice || '', '单价解析错误，常见原因是口语价格、厘级价格、旧价作废或最终价覆盖不足。');
  }
  if (hasValue(expected.amount) && !moneyEqual(fields.amount, expected.amount)) {
    addError(errors, 'wrong_amount', 'amount', expected.amount, fields.amount || '', '应收金额解析错误。');
  }
  if (hasValue(expected.paymentAmount) && !moneyEqual(fields.paymentAmount, expected.paymentAmount)) {
    addError(errors, 'wrong_payment_amount', 'paymentAmount', expected.paymentAmount, fields.paymentAmount || '', '收款金额应和尾款、剩余款、总额分开。');
  }
  if (hasValue(expected.depositAmount) && !moneyEqual(fields.depositAmount, expected.depositAmount)) {
    addError(errors, 'wrong_deposit_amount', 'depositAmount', expected.depositAmount, fields.depositAmount || '', '定金/订金/预付款没有从订单或收款语境中正确抽取。');
  }
  if (expected.dueDatePresent && !fields.dueDate) {
    addError(errors, 'field_missing', 'dueDate', '有交期/提醒日期', fields.dueDate || '', '日期交期没有识别，常见原因是口语日期、半日日期、斜杠日期或交期改口。');
  }
  if (expected.remarkIncludes && !textIncludes(fields.remark, expected.remarkIncludes)) {
    addError(errors, 'remark_lost', 'remark', expected.remarkIncludes, fields.remark || '', '特殊要求、剩余款、旧内容作废或备注更新没有进入备注。');
  }
  if (expected.todoTitleIncludes && !textIncludes(fields.todoTitle, expected.todoTitleIncludes)) {
    addError(errors, 'wrong_todo_title', 'todoTitle', expected.todoTitleIncludes, fields.todoTitle || '', '待办标题没有保留关键动作或商品。');
  }
  if (expected.conflictFields) {
    const actualConflicts = (result.field_conflicts || []).map((item) => item.field);
    expected.conflictFields.forEach((field) => {
      if (!actualConflicts.includes(field)) {
        addError(errors, 'conflict_not_flagged', 'field_conflicts', field, actualConflicts.join(',') || '', '前后改价、改量或纠错场景没有保留冲突证据。');
      }
    });
  }
  if (expected.lowConfidenceFields) {
    const actualLow = result.low_confidence_fields || [];
    expected.lowConfidenceFields.forEach((field) => {
      if (!actualLow.includes(field)) {
        addError(errors, 'low_confidence_not_flagged', 'low_confidence_fields', field, actualLow.join(',') || '', '依赖历史价、照旧价或缺字段场景没有提示低置信。');
      }
    });
  }
  if (expected.multiProducts) {
    const actualMulti = result.multi_products || [];
    const actualText = [fields.productName || '', actualMulti.join('、')].join('、');
    expected.multiProducts.forEach((product) => {
      if (!textIncludes(actualText, product)) {
        addError(errors, 'multi_record_not_supported', 'multi_products', product, actualText, '多产品场景没有完整识别所有产品；后续需要拆成多条草稿。');
      }
    });
  }
  return errors;
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
    no_business_extracted: '摘要层需要保留更多候选业务句，尤其是代发、群聊、自我记录和截图转述。',
    intent_error: '增加否定、撤回、旧记录、样品、库存、售后等场景的意图边界，避免误建订单。',
    operation_error: '更新类动作需要独立识别改价、改量、延期、暂停、取消、备注更新、报价更新。',
    wrong_customer: '客户识别要区分说话人、代发人、群名和正文中的真实客户。',
    wrong_product: '继续扩展商品别名、简称、音同字、错别字、繁简混用，并保留未知商品候选。',
    wrong_quantity: '数量规则需要处理改量最后值、包装换算、追加但不合并、缺单位、中文大写和干扰数字。',
    wrong_unit_price: '价格规则需要处理裸数字、口语小数、厘级价格、旧价作废、同句否定纠错和最终确认价。',
    wrong_amount: '应收金额要和运费、尾款、剩余款、历史记录分离。',
    wrong_payment_amount: '收款金额要和剩余款、总额、后续款分离，优先取到账/已收/刚转对应数字。',
    wrong_deposit_amount: '定金/订金/定斤要统一，并在订单场景里保留为 depositAmount。',
    field_missing: '日期规则需要补齐斜杠日期、明早/明儿、这周六、周四晚上前、10号中午前等口语时间。',
    remark_lost: '备注抽取要收集所有相关消息，并处理“旧要求作废、最后要求为准”。',
    wrong_todo_title: '待办标题需要把商品音同字归一化，并保留催款、回价、发对账单等动作。',
    conflict_not_flagged: '前后改价/改量/纠错应进入冲突字段，不能静默覆盖。',
    low_confidence_not_flagged: '照旧价、按上次、价格不变等历史依赖要标低置信。',
    multi_record_not_supported: '多产品不能只拼到一个字段，需要拆成多个草稿并分别保存数量、价格、备注。'
  };
  return map[type] || '补充该类规则用例，并作为 AI 兜底条件。';
}

function summarizeBy(items, getKeys) {
  const map = {};
  items.forEach((item) => {
    const keys = getKeys(item).filter(Boolean);
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
  return `| ${cells.map(md).join(' | ')} |`;
}

function expectedSummary(expected) {
  const parts = [];
  if (expected.intent) parts.push(`intent=${expected.intent}`);
  if (expected.operation) parts.push(`operation=${expected.operation}`);
  [
    ['customer', 'customer'],
    ['productName', 'product'],
    ['quantity', 'quantity'],
    ['unitPrice', 'unitPrice'],
    ['amount', 'amount'],
    ['paymentAmount', 'payment'],
    ['depositAmount', 'deposit']
  ].forEach(([key, label]) => {
    if (hasValue(expected[key])) parts.push(`${label}=${expected[key]}`);
  });
  if (expected.dueDatePresent) parts.push('dueDate=有');
  if (expected.remarkIncludes) parts.push(`remark包含=${expected.remarkIncludes}`);
  if (expected.todoTitleIncludes) parts.push(`todo包含=${expected.todoTitleIncludes}`);
  if (expected.conflictFields) parts.push(`conflict=${expected.conflictFields.join(',')}`);
  if (expected.lowConfidenceFields) parts.push(`low=${expected.lowConfidenceFields.join(',')}`);
  if (expected.multiProducts) parts.push(`multi=${expected.multiProducts.join('+')}`);
  return parts.join('；');
}

function actualSummary(result, analysis) {
  if (!result) return `analysis=${analysis.status}`;
  const fields = result.fields || {};
  return [
    `analysis=${analysis.status}`,
    `intent=${result.intent || ''}`,
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
    `low=${(result.low_confidence_fields || []).join(',')}`,
    `conflict=${(result.field_conflicts || []).map((item) => item.field).join(',')}`
  ].join('；');
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inTable = false;
  let tableRows = [];
  let inCode = false;
  let code = [];

  function flushTable() {
    if (!inTable) return;
    html.push('<div class="table-wrap"><table>');
    tableRows.forEach((row, index) => {
      if (/^\|\s*-+/.test(row)) return;
      const cells = row.split('|').slice(1, -1);
      const tag = index === 0 ? 'th' : 'td';
      html.push(`<tr>${cells.map((cell) => `<${tag}>${escapeHtml(cell.trim())}</${tag}>`).join('')}</tr>`);
    });
    html.push('</table></div>');
    tableRows = [];
    inTable = false;
  }

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushTable();
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
    if (trimmed.startsWith('|')) {
      inTable = true;
      tableRows.push(trimmed);
      return;
    }
    flushTable();
    if (!trimmed) return;
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      return;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      html.push(`<p class="item">${escapeHtml(trimmed)}</p>`);
      return;
    }
    if (trimmed.startsWith('- ')) {
      html.push(`<p class="item">${escapeHtml(trimmed)}</p>`);
      return;
    }
    html.push(`<p>${escapeHtml(trimmed)}</p>`);
  });
  flushTable();
  return html.join('\n');
}

function buildHtml(markdown) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>微信聊天本地规则 100 条升级难度评测报告</title>
  <style>
    body { margin: 0; background: #f6f7f9; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.65; }
    main { max-width: 1280px; margin: 0 auto; min-height: 100vh; padding: 32px 24px 56px; background: #fff; box-sizing: border-box; }
    h1 { margin: 0 0 16px; font-size: 30px; line-height: 1.25; }
    h2 { margin: 34px 0 12px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 22px; }
    h3 { margin: 24px 0 8px; font-size: 18px; }
    p { margin: 8px 0; font-size: 14px; }
    .item { padding-left: 10px; }
    .table-wrap { overflow-x: auto; margin: 12px 0 18px; border: 1px solid #e5e7eb; border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; min-width: 980px; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #edf0f3; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: #f9fafb; font-weight: 700; }
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
  lines.push('# 微信聊天本地规则解析 100 条升级难度离线评测报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 评测说明');
  lines.push('');
  lines.push('- 本轮是在上一轮高难度 100 题基础上继续升级，不修改解析器，只观察当前本地规则会遇到什么问题。');
  lines.push('- 用例从真实微信场景出发，覆盖图片/语音转文字、代发客户、群聊、自我记录、错别字、撤回、取消、改价、改量、备注覆盖、部分收款、多产品拆单等。');
  lines.push('- 评测链路只走本地规则：`analyzeClipboardText -> parseHybridInput`。当前 Node 环境不会调用真实 AI。');
  lines.push('- 通过表示本地规则抽出的核心字段达到该场景预期；失败表示同类型真实聊天下还存在规则短板。');
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
    lines.push(tableLine([category, item.total, item.passed, item.failed, `${((item.passed / item.total) * 100).toFixed(1)}%`]));
  });
  lines.push('');
  lines.push('## 按难度标签统计');
  lines.push('');
  lines.push('| 难度标签 | 用例数 | 通过 | 失败 | 通过率 |');
  lines.push('|---|---:|---:|---:|---:|');
  Object.entries(byTag)
    .sort((left, right) => right[1].failed - left[1].failed || right[1].total - left[1].total)
    .forEach(([tag, item]) => {
      lines.push(tableLine([tag, item.total, item.passed, item.failed, `${((item.passed / item.total) * 100).toFixed(1)}%`]));
    });
  lines.push('');
  lines.push('## 错误类型统计');
  lines.push('');
  lines.push('| 错误类型 | 次数 | 问题含义 | 初步修复方向 |');
  lines.push('|---|---:|---|---|');
  if (Object.keys(byError).length) {
    Object.entries(byError)
      .sort((left, right) => right[1] - left[1])
      .forEach(([type, count]) => {
        const sampleCause = rows.flatMap((row) => row.errors).find((error) => error.type === type);
        lines.push(tableLine([type, count, sampleCause ? sampleCause.cause : '', solutionForType(type)]));
      });
  } else {
    lines.push('| 无 | 0 | 暂无 | 暂无 |');
  }
  lines.push('');
  lines.push('## 主要发现');
  lines.push('');
  const topTypes = Object.entries(byError).sort((left, right) => right[1] - left[1]).slice(0, 10);
  if (topTypes.length) {
    topTypes.forEach(([type, count], index) => lines.push(`${index + 1}. ${type}：${count} 次。${solutionForType(type)}`));
  } else {
    lines.push('本轮没有发现失败用例。');
  }
  lines.push('');
  lines.push('## 失败样例摘录');
  lines.push('');
  rows.filter((row) => !row.passed).slice(0, 35).forEach((row) => {
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
      row.testCase.category,
      (row.testCase.tags || []).join('、'),
      compactChat(row.testCase.raw),
      row.passed ? '通过' : '失败',
      errorTypeSummary(row.errors),
      causeSummary(row.errors),
      expectedSummary(row.testCase.expected),
      actualSummary(row.result, row.analysis)
    ]));
  });
  lines.push('');
  lines.push('## 下一步建议');
  lines.push('');
  lines.push('1. 先按错误类型修，不按单条样例修。优先级建议：客户识别、多产品拆单、最终值覆盖、日期口语、收款/尾款分离、备注覆盖。');
  lines.push('2. 对“撤回、旧记录、别录、先不要、只是参考、不下单、不是新单”等否定场景建立保护规则，避免错误入库。');
  lines.push('3. 对“代发客户、群聊、自我记录”建立客户候选优先级，真实客户优先于说话人。');
  lines.push('4. 多产品场景要从字段识别升级为多草稿生成；否则识别到商品名也不能安全保存。');
  lines.push('5. 本地规则继续做第一层强解析，仍建议把冲突、否定不清、未知商品和多产品拆单作为 AI 兜底触发条件。');

  const markdown = `${lines.join('\n')}\n`;
  fs.writeFileSync(REPORT_MD, markdown, 'utf8');
  fs.writeFileSync(REPORT_TXT, `\uFEFF${markdown}`, 'utf8');
  fs.writeFileSync(REPORT_HTML, `\uFEFF${buildHtml(markdown)}`, 'utf8');
  fs.writeFileSync(ROOT_MD, markdown, 'utf8');
  fs.writeFileSync(ROOT_TXT, `\uFEFF${markdown}`, 'utf8');
  fs.writeFileSync(ROOT_HTML, `\uFEFF${buildHtml(markdown)}`, 'utf8');
  console.log(`Wrote ${REPORT_MD}`);
  console.log(`Wrote ${REPORT_HTML}`);
  console.log(`Wrote ${REPORT_TXT}`);
  console.log(`Wrote ${ROOT_HTML}`);
  console.log(`Total ${total}, passed ${passed}, failed ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
