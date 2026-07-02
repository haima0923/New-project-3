# 货小玲产品规则审计

本文件由产品规则 Agent 只读盘点生成。本轮只检查产品定位、旧名称、UI 风险、空状态和文案风险，不修改业务代码、页面、样式、配置或 parser。

## 1. 总体判断

当前项目整体方向基本符合“轻便 AI 生意助理”的定位：核心页面围绕记一笔、问一句、报价、订单、收款、待办、待整理展开；数据初始状态为空，没有发现真实页面直接塞入假客户、假订单、假欠款或模拟金额。

主要风险不在业务能力本身，而在用户可见命名和表达：仍有“生意备忘秘书”旧名称；“财务”“应收”“生成应收”等词比较重，容易让老板误以为这是财务软件或 ERP；视觉上仍以默认亮蓝 `#1677FF` 为主，和“藏青蓝 + 金色点缀”的目标风格不完全一致。

判断：没有发现严重到“产品已经变成重型 ERP”的偏差，但存在中高风险的品牌、文案和信息密度问题，后续需要分批修正。

## 2. 高风险问题

### 2.1 用户可见旧名称残留

- `app.json:18`：`navigationBarTitleText` 仍是“生意备忘秘书”。
- `pages/onboarding/onboarding.wxml:2`：首屏标题仍是“老板的生意备忘秘书”。
- `README.md:3`：产品心智仍写“老板的生意备忘秘书”。

风险：这是用户第一眼能看到的品牌命名，和“货小玲”不一致，会影响后续统一品牌。

### 2.2 “财务”入口过重

- `app.json:56`：tabBar 文案为“财务”。
- `custom-tab-bar/index.js:20`：自定义 tab 文案为“财务”，图标为 `¥`。
- `pages/finance/finance.json:2`：页面标题为“财务”。
- `pages/finance/finance.wxml:4-5`：页面主标题为“财务”，副标题包含“应收、收款、待结算”。

风险：目标产品不是财务软件，但用户底部导航直接看到“财务”，容易建立重型软件心智。建议后续评估是否改为“收款”“钱款”“欠款”等更老板口语化的表达。

### 2.3 亮蓝默认品牌感过强

- `app.wxss:91`、`app.wxss:180`：全局主按钮使用 `#1677FF`。
- `custom-tab-bar/index.wxss:51`：中心按钮使用亮蓝渐变。
- `pages/dashboard/dashboard.wxss:65`、`pages/dashboard/dashboard.wxss:1055`：首页核心视觉大量使用亮蓝。
- `pages/profile/profile.wxss:6`：我的页面主卡片使用亮蓝渐变。

风险：当前视觉更像通用 SaaS 默认蓝，不像“藏青蓝 + 金色点缀”的稳定品牌系统。金色/橙色存在，但更多像警示或强调色，不是统一品牌点缀。

## 3. 中风险问题

### 3.1 页面信息密度偏高

- `pages/input/input.wxml:44`、`50`、`62`、`66`、`78`、`113`、`248`：记一笔确认页包含“确认卡片”“解析安全判断”“历史信息提醒”“需要确认的冲突”“已按历史默认填入”“客户匹配”“需要确认”等多个模块。
- `pages/finance/finance.wxml:10-31`：财务页顶部有 4 个汇总卡片。
- `pages/customer/customer.wxml:23-58`：客户详情包含快捷操作、疑似重复客户、报价历史、订单历史、收款记录。

风险：这些能力有价值，但对义乌中小工厂老板来说，容易显得“系统化”和“后台化”。建议后续按“今天要做什么”优先级收敛展示。

### 3.2 专业术语偏多

- `pages/input/input.js:78-79`：`保存为应收款`、`新建应收并记录已收`。
- `pages/input/input.js:92`：`匹配应收款`。
- `pages/input/input.js:857`：`应收总额`、`应收金额`。
- `pages/finance/finance.wxml:12`：`本月应收`。
- `pages/orders/orders.wxml:81`：`生成应收款`。
- `pages/customer/customer.wxml:31`：`报价、订单、应收都会归到当前客户下面`。

风险：这些词对系统开发者清楚，但老板口语里更可能说“欠我多少钱”“这笔钱收了没”“这单尾款”。建议逐步替换用户可见术语。

### 3.3 查询和 mock 状态文案偏技术化

- `pages/query/query.js:28`：`已通过测试后端 mock 查询。`
- `pages/input/input.js:1328`：`已通过测试后端 mock 识别，结果仍需你确认。`
- `pages/profile/profile.wxml:47`：`当前是本地测试版...`

风险：mock、本地测试版、测试后端等技术词不适合正式老板端。如果当前只是测试环境可以保留，但发布前必须替换或隐藏。

### 3.4 高级筛选接近后台工具

- `pages/orders/orders.wxml:7-45`：订单页有筛选、收起、高级筛选、客户/产品/日期筛选。
- `pages/quotations/quotations.wxml:7-45`：报价页有类似高级筛选。

风险：目前仍是卡片流，不是表格，但“高级筛选”会让产品接近后台管理。建议保留搜索，弱化高级筛选心智。

## 4. 低风险问题

### 4.1 示例文案不属于假数据，但需要注意边界

- `pages/input/input.wxml:33`：输入框 placeholder 示例含“王总”“1000个”“5块5”。
- `pages/input/input.wxml:102`：待办标题 placeholder 含“回复周姐礼品盒报价”。
- `pages/input/input.wxml:127`：客户区分备注 placeholder 含“一区王总、眼镜厂王总、朋友介绍”。
- `pages/query/query.wxml:6`、`11-13`：问一句示例含“谁还欠我钱”“王总上次报多少”。
- `pages/todos/todos.wxml:7`：空状态示例含“明天提醒我给周姐回报价”。

判断：这些是输入示例和引导，不是页面真实数据。风险较低，但正式文案应尽量短，避免用户误以为已有真实客户。

### 4.2 图标风格不统一

- `custom-tab-bar/index.js:17-21`：底部导航图标使用字符 `⌂`、`▤`、`¥`、`人`，中心按钮为空。
- `utils/home-workbench.js:21-27`：记录类型 icon 使用汉字“报”“单”“应”“收”“提”等。

风险：字符图标和汉字图标都能用，但视觉质感不统一。后续统一设计时建议一起处理。

### 4.3 “临时客户”表达可能显得系统化

- `utils/business.js:111`、`135`：默认客户名可能生成“临时客户”。
- `pages/orders/orders.wxml:68`、`pages/quotations/quotations.wxml:68`：列表中无客户显示“临时客户”。
- `pages/customer/customer.wxml:14`、`20`：客户档案展示“临时客户”。

风险：不是假数据，但“临时客户”偏系统字段。后续可考虑老板视角文案，例如“还没填客户名”。

## 5. 旧名称残留清单

- `app.json:18`：`生意备忘秘书`
- `pages/onboarding/onboarding.wxml:2`：`老板的生意备忘秘书`
- `README.md:3`：`老板的生意备忘秘书`
- `server/package.json`：包名为 `yiwu-boss-ai-assistant-server`，属于内部英文旧定位，不是用户可见高风险。
- `utils/storage.js:1`：存储 key 为 `yiwu_boss_ai_assistant_v1`，属于内部兼容命名，不能随意改，改动前必须评估数据迁移。
- `server/src/server.js:19`：health service 名为 `yiwu-boss-ai-assistant-server`，属于接口/运维命名。

## 6. 假数据风险清单

### 未发现真实页面硬编码假业务数据

- `utils/storage.js:11-18`：`customers`、`quotations`、`orders`、`receivables`、`paymentRecords`、`dunningRecords`、`todos`、`orderProgress`、`pendingNotes` 初始均为空数组。
- `pages/orders/orders.js:53`、`pages/quotations/quotations.js:47`、`pages/receivables/receivables.js:8` 等页面初始 data 为空数组。

### 需要继续隔离的示例/测试内容

- `pages/input/input.wxml:33`、`102`、`127`：输入 placeholder 示例。
- `pages/query/query.wxml:6`、`11-13`：问一句 placeholder 和示例问题。
- `pages/todos/todos.wxml:7`：空状态示例句。
- `docs/wechat-local-rules-*.md|txt|html`、根目录中文测试报告、`promptfoo/*cases*.json`：大量测试客户、测试金额、模拟聊天记录，属于历史报告/测试用例，不应进入真实页面。

### 非假数据但可能误解的地方

- `utils/storage.js:21-33`：默认催款模板是功能模板，不是假客户或假欠款。
- `utils/business.js:111`、`135`：自动生成“临时客户”是缺字段 fallback，不是假客户，但用户侧文案需谨慎。

## 7. UI 重型化风险清单

- `pages/finance/finance.wxml`：财务页有四宫格汇总、分段切换、应收/收款/待结算列表、生成应收操作，最接近财务后台。
- `pages/input/input.wxml`：记一笔确认流程模块多，解析安全、历史默认、客户匹配等信息可能压过“老板确认一下就保存”的主线。
- `pages/customer/customer.wxml`：客户档案包含重复客户、历史报价、历史订单、收款记录，接近 CRM 客户详情。
- `pages/orders/orders.wxml` 和 `pages/quotations/quotations.wxml`：高级筛选会让列表页偏后台。
- `pages/profile/profile.wxml`：本地数据、识别状态、版本说明更像测试/管理页，不是老板日常高频页面。

## 8. 后续建议修复顺序

1. 先统一用户可见品牌名：`app.json` 标题、onboarding 标题、README 产品心智。
2. 再调整底部导航和页面标题：重点评估“财务”是否改成更轻的“收款”或“钱款”。
3. 再做用户可见术语降重：应收、生成应收、匹配应收款、应收总额等词分批替换成老板口语。
4. 然后统一视觉主色：从默认亮蓝过渡到藏青蓝，金色只做点缀和关键行动提示。
5. 最后收敛重型页面信息密度：先处理 finance/input/customer 三类高密页面。

## 9. 哪些可以批量修

- 用户可见旧名称：`生意备忘秘书` 到 `货小玲`，但要避开存储 key 和接口兼容字段。
- 纯展示文案中的“财务/应收”轻量化替换。
- 页面空状态文案优化。
- placeholder 和示例问题统一老板口语。
- 颜色变量或全局基础色统一，但前提是先确定视觉规范。
- 自定义 tabBar 文案和图标风格统一。

## 10. 哪些必须单独确认后再修

- `utils/storage.js` 的 `STORAGE_KEY`：涉及本地数据兼容，不能直接重命名。
- `server/package.json`、`server/src/server.js` 的 service/package 命名：涉及部署、监控、脚本和接口识别。
- `app.js` 的 `apiBaseUrl`、AI endpoint：涉及真实接口/联调环境。
- “财务”模块整体定位：改名会影响 tab、页面标题、用户心智和功能边界，建议先定产品词。
- `pages/input/input.js` 中解析确认状态和业务操作文案：和实际业务逻辑强绑定，不能只做搜索替换。
- `pages/finance/finance.js` / `pages/orders/orders.js` 的“生成应收”动作：涉及订单到收款的业务流转，必须确认新词是否仍准确。
- 颜色体系大改：会影响全局样式、页面样式、自定义 tabBar 和视觉一致性，需要单独 UI 回归。
