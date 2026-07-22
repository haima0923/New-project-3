const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includes(source, text, message) {
  assert(source.includes(text), message || `缺少：${text}`);
}

function excludes(source, text, message) {
  assert(!source.includes(text), message || `不应出现：${text}`);
}

function run() {
  const appConfig = JSON.parse(read('app.json'));
  const tabJs = read('custom-tab-bar/index.js');
  const tabWxml = read('custom-tab-bar/index.wxml');
  const dashboard = read('pages/dashboard/dashboard.wxml');
  const dashboardCss = read('pages/dashboard/dashboard.wxss');
  const dashboardJs = read('pages/dashboard/dashboard.js');
  const input = read('pages/input/input.wxml');
  const inputCss = read('pages/input/input.wxss');
  const inputJs = read('pages/input/input.js');
  const finance = read('pages/finance/finance.wxml');
  const financeJs = read('pages/finance/finance.js');
  const records = read('pages/records/records.wxml');
  const recordsJs = read('pages/records/records.js');
  const recordsCss = read('pages/records/records.wxss');
  const detail = read('pages/record-detail/record-detail.wxml');
  const detailJs = read('pages/record-detail/record-detail.js');
  const orders = read('pages/orders/orders.wxml');
  const ordersJs = read('pages/orders/orders.js');
  const ordersCss = read('pages/orders/orders.wxss');
  const orderInsights = read('utils/order-insights.js');
  const profile = read('pages/profile/profile.wxml');
  const profileJs = read('pages/profile/profile.js');
  const profileCss = read('pages/profile/profile.wxss');
  const productCatalog = read('utils/product-catalog.js');
  const unitsJs = read('utils/units.js');
  const serverModel = read('server/src/ai/model.js');

  assert(appConfig.window.navigationBarBackgroundColor === '#1677FF', '顶部导航没有使用轻快、清晰的主色');
  assert(appConfig.pages.includes('pages/record-detail/record-detail'), '记录详情页必须注册到小程序页面');

  includes(tabJs, "text: '话筒'", '底部中间入口应保留话筒');
  includes(tabJs, 'startCenterVoice', '底部中间话筒必须能开始录音');
  includes(tabJs, 'stopCenterVoice', '底部中间话筒必须能在松开时结束录音');
  includes(tabWxml, 'bindtouchstart="startCenterVoice"', '底部中间入口应支持按住录音');
  includes(tabWxml, 'bindtouchend="stopCenterVoice"', '底部中间入口应支持松开结束录音');
  includes(tabWxml, 'tab-mic-symbol', '底部中间入口应显示话筒图形');

  includes(dashboard, '今天别漏事', '首页应把老板最关心的事放在第一层');
  includes(dashboard, '按住说一句', '首页应明确语音主入口的用途');
  includes(dashboard, 'bindtouchstart="startVoice"', '首页语音入口必须支持按住开始');
  includes(dashboard, 'bindtouchend="stopVoice"', '首页语音入口必须支持松开结束');
  includes(dashboard, 'bindtap="pasteClipboard"', '首页应提供直接粘贴聊天的快捷入口');
  excludes(dashboard, 'home-mic-dock', '首页不应保留重复的底部录音入口');
  includes(dashboard, '请确认，再保存', '首页快捷保存前应明确提醒用户确认');
  includes(dashboard, '先放待整理', '信息不完整时应给出安全的待整理出口');
  includes(dashboard, 'bindtap="closeConfirmCard"', '首页确认卡右上角必须能关闭');
  includes(dashboardJs, 'closeConfirmCard()', '首页关闭确认卡必须有明确动作');
  includes(dashboardCss, 'padding: 0 20rpx calc(176rpx + env(safe-area-inset-bottom));', '首页确认卡必须整体避开底部导航');
  includes(dashboard, '<scroll-view scroll-y="true" class="confirm-modal-body">', '首页确认卡字段区必须可以单独滚动');
  const dashboardCard = dashboardCss.match(/\.confirm-modal-card \{[^}]*\}/)[0];
  includes(dashboardCard, 'display: flex;', '首页确认卡必须使用上下分区布局');
  includes(dashboardCard, 'flex-direction: column;', '首页确认卡必须把字段区和按钮区纵向排列');
  includes(dashboardCard, 'overflow: hidden;', '首页确认卡滚动内容不能越过底部按钮');
  const dashboardBody = dashboardCss.match(/\.confirm-modal-body \{[^}]*\}/)[0];
  includes(dashboardBody, 'flex: 1;', '首页确认卡字段区必须占用剩余高度');
  includes(dashboardBody, 'height: 0;', '首页确认卡字段区必须限制在按钮上方滚动');
  includes(dashboardCss, '.confirm-modal-card .button-row {', '首页确认卡必须有独立按钮布局');
  const dashboardButtonRow = dashboardCss.match(/\.confirm-modal-card \.button-row \{[^}]*\}/)[0];
  includes(dashboardButtonRow, 'position: static;', '首页确认按钮必须在卡片内容底部，不能悬浮覆盖字段');
  excludes(dashboardButtonRow, 'sticky', '首页确认按钮不应使用悬浮定位');
  includes(dashboardCss, 'button:last-child:nth-child(odd)', '首页确认卡三个按钮时主操作必须独占一行');
  includes(dashboardJs, "items.some((item) => item.spec)", '带规格的订单必须进入完整确认卡，首页不能压平规格');
  includes(dashboardJs, 'item.priceUnit', '计价单位不一致时必须进入完整确认卡核对');

  includes(input, '说一句、打一段或粘贴聊天', '完整记一笔页应同时支持语音、文字和聊天');
  includes(input, 'data-source="voice"', '完整记一笔页应提供语音入口');
  includes(input, 'bindtouchstart="startVoice"', '完整记一笔语音入口应支持按住开始');
  includes(input, 'bindtouchend="stopVoice"', '完整记一笔语音入口应支持松开结束');
  includes(inputJs, "require('../../utils/voice-recognition')", '完整记一笔必须复用真实的微信语音识别链路');
  includes(inputJs, 'onResult: (result)', '语音识别成功后必须处理最终文本');
  includes(inputJs, '() => this.runParse()', '语音转文字后必须进入确认卡链路');
  excludes(inputJs, 'wx.getRecorderManager', '完整记一笔不能只录音不转文字');
  includes(inputJs, "parseButtonText: '生成确认卡'", '用户应先看到确认卡，再进行保存');
  includes(input, '先放待整理', '确认页应保留不确定信息的安全出口');
  includes(inputCss, 'align-items: flex-end;', '完整记一笔确认卡应从底部展开');
  includes(input, '<scroll-view scroll-y="true" class="input-confirm-body">', '完整记一笔确认卡字段区必须可以单独滚动');
  const inputCard = inputCss.match(/\.input-confirm-card \{[^}]*\}/)[0];
  includes(inputCard, 'display: flex;', '完整记一笔确认卡必须使用上下分区布局');
  includes(inputCard, 'flex-direction: column;', '完整记一笔确认卡必须把字段区和按钮区纵向排列');
  includes(inputCard, 'overflow: hidden;', '完整记一笔确认卡滚动内容不能越过底部按钮');
  const inputBody = inputCss.match(/\.input-confirm-body \{[^}]*\}/)[0];
  includes(inputBody, 'flex: 1;', '完整记一笔确认卡字段区必须占用剩余高度');
  includes(inputBody, 'height: 0;', '完整记一笔确认卡字段区必须限制在按钮上方滚动');
  includes(input, 'bindtap="closeConfirmCard"', '完整记一笔确认卡右上角必须能关闭');
  includes(inputJs, 'closeConfirmCard()', '完整记一笔关闭确认卡必须有明确动作');
  const inputButtonRow = inputCss.match(/\.input-confirm-card \.button-row \{[^}]*\}/)[0];
  includes(inputButtonRow, 'position: static;', '完整记一笔确认按钮必须在卡片内容底部，不能悬浮覆盖字段');
  excludes(inputButtonRow, 'sticky', '完整记一笔确认按钮不应使用悬浮定位');
  includes(inputCss, 'button:last-child:nth-child(odd)', '完整确认卡三个按钮时主操作必须独占一行');
  includes(input, '<text class="label">规格</text>', '订单确认卡必须允许填写商品规格');
  includes(input, 'value="{{item.priceUnit}}"', '订单确认卡必须允许核对计价单位');
  includes(input, 'data-field="totalAmount"', '数量单位与计价单位不同时必须允许手工确认该项金额');
  includes(input, 'bindtap="addConfirmItem"', '订单确认卡必须允许新增规格或商品');
  includes(input, 'bindtap="removeConfirmItem"', '订单确认卡必须允许删除误识别的规格项');
  includes(inputJs, 'addConfirmItem()', '新增规格按钮必须有真实处理逻辑');
  includes(inputJs, 'removeConfirmItem(event)', '删除规格按钮必须有真实处理逻辑');
  includes(inputJs, 'getRecordItems', '编辑旧订单时必须加载完整商品明细，不能只带第一项');
  includes(inputJs, "wx.getStorageSync('record_to_edit')", '完整记一笔页必须能接收主动修改的准确订单');
  includes(inputJs, 'buildOrderEditDraft(state, orderId)', '主动修改必须从真实已保存订单生成确认卡');
  includes(input, '商品库里的常用商品', '确认卡必须能从本地商品库选择常用商品');
  includes(input, '这个商品的常用规格', '确认卡必须展示当前商品的常用规格');
  includes(input, '{{item.catalogHint}}', '确认卡必须明确说明商品/规格库核对结果');
  includes(inputJs, 'getCatalogCheck(state, item.productName, item.spec)', '确认卡必须按当前用户的真实商品库核对每个规格');
  includes(inputJs, 'applyCatalogSpec(event)', '规格建议必须能由用户主动采用');
  includes(inputCss, '.catalog-chip {', '大量规格建议必须使用可换行的轻量标签');

  includes(finance, '<view class="page-title finance-title">收款</view>', '收款页标题应使用老板易懂的名称');
  includes(finance, '本次收款金额', '收款页应允许直接填写本次实际到账金额');
  includes(finance, '已催款', '收款页应提供简单的催款跟进动作');
  includes(finance, 'data-id="{{item.orderId}}" bindtap="goOrders">看订单</button>', '待收款的看订单必须携带准确订单编号');
  includes(finance, 'data-id="{{item.id}}" bindtap="goOrders">看订单</button>', '待生成待收的订单入口必须携带准确订单编号');
  includes(financeJs, "getRecordDetailUrl('order', event.currentTarget.dataset.id)", '收款页看订单必须跳到准确订单详情');

  includes(records, 'data-id="{{item.sourceId || item.id}}"', '记录卡片必须携带原始记录编号');
  includes(records, 'bindtap="openRecord"', '记录卡片必须可直接进入详情');
  includes(recordsJs, 'getRecordDetailUrl(type, id)', '记录卡片必须跳到准确记录详情');
  includes(records, 'bindtouchstart="recordTouchStart"', '每条记录必须支持独立右滑手势');
  includes(records, 'catchtap="deleteRecord">删除</button>', '右滑操作必须提供删除按钮');
  includes(records, 'catchtap="closeSwipe">取消</button>', '右滑操作必须提供取消按钮');
  includes(recordsJs, 'softDeleteRecord(state, type, id)', '删除记录必须走统一的安全删除和日志逻辑');
  includes(recordsJs, "title: '已删除并记录日志'", '删除成功必须明确告诉用户已记录日志');
  includes(recordsCss, '.record-card-swiped {', '右滑后记录卡必须露出操作区');
  includes(recordsCss, 'transform: translateX(264rpx);', '记录卡右滑方向必须符合用户描述');
  includes(detailJs, 'buildRecordDetail(getState(), this.data.type, this.data.id)', '记录详情必须从真实本地数据按类型和编号读取');
  includes(detail, '商品明细', '记录详情必须能展示订单和报价的商品明细');
  includes(detail, '原始内容', '记录详情必须保留并展示用户原始输入');
  includes(detail, 'bindtap="openOrder"', '有关联订单时必须能从详情继续查看订单');
  includes(detail, 'bindtap="editOrder">修改订单</button>', '订单详情必须提供主动修改入口');
  includes(orders, '<text class="order-key-label">数量</text>', '订单卡片必须醒目展示数量');
  includes(orders, '<text class="order-key-label">金额</text>', '订单卡片必须醒目展示金额');
  includes(ordersJs, 'quantitySummary: buildOrderQuantitySummary(displayItems)', '订单数量必须从真实商品明细汇总');
  includes(ordersJs, 'totalAmountDisplay: formatMoney(item.totalAmount)', '订单金额必须来自真实订单金额');
  includes(ordersCss, '.order-key-metrics {', '订单数量和金额必须使用独立摘要区');
  includes(orders, 'bindtap="editOrder">修改订单</button>', '订单页每笔订单必须提供主动修改入口');
  includes(ordersJs, "wx.setStorageSync('record_to_edit', { type: 'order', id })", '订单修改入口必须传递准确订单编号');
  includes(orders, 'bindtap="toggleCustomerStats">按客户看</button>', '订单页必须提供按客户统计入口');
  includes(orders, 'range="{{orderSortRange}}"', '订单页必须允许用户设置排序');
  includes(orders, 'value="{{filterMinAmount}}"', '订单筛选必须支持最低金额');
  includes(orders, 'value="{{filterMaxAmount}}"', '订单筛选必须支持最高金额');
  includes(orders, 'value="{{filterOrderDate}}"', '订单筛选必须支持下单日期');
  includes(orders, 'value="{{filterShipDate}}"', '订单筛选必须支持实际发货日期');
  includes(orders, 'value="{{filterPaymentDate}}"', '订单筛选必须支持最近收款日期');
  includes(orders, '最近收款 {{item.lastPaymentDate || \'未收款\'}}', '订单卡片必须说明用于筛选的最近收款时间');
  includes(ordersJs, 'buildCustomerOrderStats(orders)', '按客户统计必须来自当前真实订单筛选结果');
  includes(ordersJs, 'enrichOrdersWithPayments(state, decoratedOrders)', '订单收款时间必须从真实关联收款记录推导');
  includes(orderInsights, "{ key: 'amountDesc', label: '订单金额：从高到低' }", '排序必须支持按金额从高到低');
  includes(orderInsights, "{ key: 'paymentDateDesc', label: '收款时间：最新在前' }", '排序必须支持按收款时间');
  includes(ordersCss, '.customer-stats-panel {', '按客户统计必须有移动端友好的独立面板');
  includes(orders, '<text wx:if="{{lineItem.spec}}"> · {{lineItem.spec}}</text>', '订单列表必须展示多规格明细');
  includes(detail, '<view wx:if="{{item.spec}}" class="record-detail-spec">{{item.spec}}</view>', '订单详情必须展示每一项规格');
  includes(unitsJs, "'千支'", '批发单位表必须支持千支');
  includes(unitsJs, "方: '立方米'", '批发单位表必须把方统一为立方米');
  includes(unitsJs, "托: '托盘'", '批发单位表必须把托统一为托盘');
  includes(serverModel, 'productName、spec、quantity、unit、unitPrice、priceUnit、totalAmount', 'AI 结构约束必须包含规格和计价单位');
  includes(serverModel, '不得自行做箱转个、打转个、千支转支等换算', 'AI 不得擅自换算批发单位');
  includes(profile, '我的商品规格库 {{catalogProducts.length}}', '我的页面必须提供可见的个人商品规格库');
  includes(profile, 'bindtap="saveCatalog">保存商品资料</button>', '用户必须能主动维护商品和规格');
  includes(profile, 'bindtap="deleteCatalog">移除</text>', '用户必须能移除错误的商品库条目');
  includes(profileJs, 'ensureProductCatalog(state)', '旧订单和报价必须能迁移为本地商品规格库');
  includes(profileJs, 'saveManualCatalogItem(state', '手工商品资料必须真实保存到本机状态');
  includes(profileCss, '.catalog-item {', '商品规格库必须有适合移动端浏览的列表样式');
  includes(productCatalog, 'learnProductCatalogFromRecord', '确认后的订单和报价必须自动学习到商品规格库');
  includes(productCatalog, 'if (Array.isArray(state.productCatalog))', '商品规格库必须按当前本地用户状态保存，不能使用全局假数据');

  console.log('UI 上线结构检查通过：准确详情、固定操作区、多规格和批发单位均符合本轮规则。');
}

run();
