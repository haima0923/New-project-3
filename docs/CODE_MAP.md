# 货小玲代码地图

本文件由代码地图 Agent 只读盘点生成，用于后续多 Agent 协作定位文件范围。当前轮次只新增本文档，未修改业务代码。

## 1. 项目整体结构

- `app.js`：小程序全局入口，启动时读取并保存本地状态；`globalData` 中配置 `apiBaseUrl`、AI parse endpoint 等。
- `app.json`：页面注册、窗口配置、自定义 tabBar、录音插件 `WechatSI` 权限配置。
- `app.wxss`：全局样式。
- `pages/`：微信小程序页面。
- `utils/`：前端本地解析、业务流转、本地存储、查询、显示、语音、剪贴板等核心工具。
- `custom-tab-bar/`：自定义底部导航组件。
- `server/`：Node.js mock/AI 接口服务，包含 parse、query、transcribe 接口。
- `scripts/`：本地规则、promptfoo、核心功能、AI 合约等测试/报告脚本。
- `promptfoo/`：promptfoo 配置、测试用例和本地 provider。
- `docs/`：接口、部署、数据库草案、产品/协作规则、历史测试报告。
- `reports/`：promptfoo 历史运行结果与 HTML/CSV/JSON 报告。

## 2. 小程序页面结构

`app.json` 当前注册页面：

- `pages/onboarding/onboarding`
- `pages/dashboard/dashboard`
- `pages/records/records`
- `pages/input/input`
- `pages/finance/finance`
- `pages/profile/profile`
- `pages/quotations/quotations`
- `pages/orders/orders`
- `pages/receivables/receivables`
- `pages/todos/todos`
- `pages/pending/pending`
- `pages/query/query`
- `pages/customer/customer`

### `pages/dashboard`

- 文件：`dashboard.js`、`dashboard.wxml`、`dashboard.wxss`、`dashboard.json`
- 角色：每日经营看板和首页快速入口。
- 主要依赖：`utils/ai-parser.js`、`utils/business.js`、`utils/home-workbench.js`、`utils/storage.js`、`utils/voice-recognition.js`、`utils/clipboard-chat.js`、`utils/display.js`、`utils/navigation-state.js`。
- 主要能力：语音/文本/剪贴板快速记一笔、快速解析确认、保存正式记录、保存待整理、跳转问一句/记录/财务/订单/报价/待办/待整理。
- 风险：页面很重，直接串联解析、确认、保存、语音、剪贴板和首页任务，是后续修改最需要谨慎的页面主入口。

### `pages/input`

- 文件：`input.js`、`input.wxml`、`input.wxss`、`input.json`
- 角色：完整“记一笔”输入与确认页。
- 主要依赖：`utils/ai-parser.js`、`utils/business.js`、`utils/storage.js`、`utils/display.js`、`utils/date.js`、`utils/clipboard-chat.js`、`utils/navigation-state.js`。
- 主要能力：手动输入、粘贴聊天、语音输入、解析、字段补齐、客户匹配、历史信息确认、收款/定金关联、保存正式记录、保存待整理。
- 风险：代码体量大，业务分支多，是记一笔主流程和解析结果落库的关键页面。

### `pages/records`

- 文件：`records.js`、`records.wxml`、`records.wxss`、`records.json`
- 角色：记录列表。
- 主要依赖：`utils/home-workbench.js`、`utils/navigation-state.js`、`utils/storage.js`。
- 主要能力：汇总展示报价、订单、应收、收款、待办、待整理等记录；支持筛选；按记录类型跳转到对应页面。

### `pages/finance`

- 文件：`finance.js`、`finance.wxml`、`finance.wxss`、`finance.json`
- 角色：财务轻量视图，主要围绕应收、收款、待结算。
- 主要依赖：`utils/business.js`、`utils/finance.js`、`utils/storage.js`、`utils/navigation-state.js`。
- 主要能力：切换财务分组、记录收款、复制催款话术、标记已催款、从订单生成应收、跳转输入/订单。
- 风险：虽然页面名是 finance，但产品上不能扩张成重型财务软件。

### `pages/profile`

- 文件：`profile.js`、`profile.wxml`、`profile.wxss`、`profile.json`
- 角色：我的/概览页。
- 主要依赖：`utils/storage.js`、`utils/voice-recognition.js`。
- 主要能力：读取本地状态，展示用户/数据概览和语音能力状态。

### `pages/quotations`

- 文件：`quotations.js`、`quotations.wxml`、`quotations.wxss`、`quotations.json`
- 角色：报价列表和跟进。
- 主要依赖：`utils/business.js`、`utils/date.js`、`utils/storage.js`、`utils/navigation-state.js`。
- 主要能力：报价筛选、复制跟进话术、报价转订单。

### `pages/orders`

- 文件：`orders.js`、`orders.wxml`、`orders.wxss`、`orders.json`
- 角色：订单列表和交付进度。
- 主要依赖：`utils/business.js`、`utils/constants.js`、`utils/date.js`、`utils/navigation-state.js`、`utils/storage.js`。
- 主要能力：订单筛选、路由筛选、更新订单状态、从订单生成应收、跳转记一笔。
- 风险：订单状态变更会写入 `orders` 和 `orderProgress`，并可能生成应收。

### `pages/receivables`

- 文件：`receivables.js`、`receivables.wxml`、`receivables.wxss`、`receivables.json`
- 角色：应收款列表。
- 主要依赖：`utils/business.js`、`utils/date.js`、`utils/navigation-state.js`、`utils/storage.js`。
- 主要能力：记录收款、复制催款话术、标记已催款、跳转记一笔。

### `pages/todos`

- 文件：`todos.js`、`todos.wxml`、`todos.wxss`、`todos.json`
- 角色：待办提醒列表。
- 主要依赖：`utils/business.js`、`utils/date.js`、`utils/storage.js`。
- 主要能力：按日期分组待办、完成待办、跳转记一笔。

### `pages/pending`

- 文件：`pending.js`、`pending.wxml`、`pending.wxss`、`pending.json`
- 角色：待整理记录列表。
- 主要依赖：`utils/storage.js`、`utils/display.js`。
- 主要能力：查看待整理、把待整理带回 `pages/input` 编辑、忽略待整理。

### `pages/query`

- 文件：`query.js`、`query.wxml`、`query.wxss`、`query.json`
- 角色：问一句。
- 主要依赖：`utils/ai-query.js`、`utils/storage.js`。
- 主要能力：输入问题，基于本地状态优先回答；如果配置了服务端接口，可走 `/api/ai/query`。

### `pages/customer`

- 文件：`customer.js`、`customer.wxml`、`customer.wxss`、`customer.json`
- 角色：客户档案和重复客户处理。
- 主要依赖：`utils/business.js`、`utils/storage.js`。
- 主要能力：客户详情/列表、客户交易记录展示、重复客户合并、标记为不同客户、跳转记一笔。

## 3. 核心工具函数

### `utils/storage.js`

- 本地状态核心文件。
- 使用 `wx.getStorageSync` / `wx.setStorageSync`，存储 key 为 `yiwu_boss_ai_assistant_v1`。
- 初始状态包含：`meta`、`customers`、`quotations`、`orders`、`receivables`、`paymentRecords`、`dunningRecords`、`todos`、`orderProgress`、`pendingNotes`、`aiParseLogs`、`dunningTemplates`。
- 导出：`createInitialState`、`getState`、`saveState`、`updateState`、`generateId`、`simpleFingerprint`、`maskPhone`、`normalizeCustomer`、`getCustomerDisplay`。

### `utils/parser.js`

- 本地规则解析器，不是真实大模型。
- 负责从文本中提取客户、电话、数量、单价、金额、定金、尾款、产品、待办标题、日期、意图和操作类型。
- 入口：`parseInput(...)`。
- 导出：`parseInput`、`shouldSuggestAiFallback`。
- 风险：规则复杂且正则很多，改动会影响记一笔、测试脚本、mock server。

### `utils/ai-parser.js`

- 混合解析协调层。
- 先调用 `parser.parseInput` 做本地解析，再根据上下文、历史记录、低置信字段决定是否请求服务端 `/api/ai/parse`。
- 无 `apiBaseUrl` 或非小程序环境时，会返回本地结果并标记 AI 状态。
- 导出：`parseHybridInput`、`buildAiRequestPayload`、`compactBusinessContext`、`extractMentionedCustomerName`、`findScopedHistory`、`getContextPolicy`、`normalizeAiResult`。
- 风险：连接本地规则、服务端 AI、历史补全和保护本地事实，属于解析链路核心。

### `utils/business.js`

- 业务流转核心文件。
- 负责客户创建/匹配、报价保存、订单保存、应收保存、收款保存、待办保存、待整理保存、报价转订单、订单生成应收、订单状态更新、完成待办、记录收款、催款、看板汇总。
- 导出：`saveConfirmedDraft`、`savePendingNote`、`convertQuotationToOrder`、`generateReceivableFromOrder`、`updateOrderStatus`、`recordPayment`、`recordDunning`、`generateDunningMessage`、`getDashboard`、`decorateRecords` 等。
- 风险：所有业务状态写入和流转都集中在这里，必须小步修改并回归。

### `utils/query.js`

- 本地“问一句”回答器。
- 基于本地 state 回答欠款、订单、近期应收、报价跟进、交货等问题。
- 导出：`answerQuery`。

### `utils/ai-query.js`

- 混合查询协调层。
- 先使用 `query.answerQuery` 生成本地答案；如果配置了服务端接口，再请求 `/api/ai/query` 并规范化结果。
- 导出：`askHybridQuery`、`normalizeAiAnswer`。

### `utils/finance.js`

- 财务视图模型构建。
- 负责应收、收款、待结算订单、逾期金额、本月应收/收款等轻量统计。
- 导出：`buildFinanceViewModel`、`formatMoney`、`getReceivableSource`、`getRemainingAmount`。

### `utils/home-workbench.js`

- 首页/记录页工作台数据构建。
- 负责今日任务、近期记录、全部记录、记录类型元信息。
- 导出：`buildTodayTasks`、`buildTodayTaskRecords`、`buildAllRecords`、`buildRecentRecords`、`formatDateTime`、`shortText`。

### `utils/display.js`

- 展示字段、缺失字段、待整理原因等文案映射。
- 被 `pages/input` 和 `pages/pending` 使用。

### `utils/date.js`

- 日期工具。
- 被解析器、业务流转、页面分组、查询、财务统计使用。

### `utils/constants.js`

- 意图、输入来源、报价状态、订单状态、应收状态、待整理状态、行业列表等常量。
- 风险：状态文案变动会影响页面筛选和业务逻辑。

### 其他实际存在的 `utils` 文件

- `utils/api-client.js`：读取 `app.globalData.apiBaseUrl`，封装 `wx.request` POST JSON。
- `utils/transcribe.js`：语音转文字接口封装，依赖 `apiBaseUrl`。
- `utils/voice-recognition.js`：微信同声传译/录音识别插件封装。
- `utils/clipboard-chat.js`：剪贴板聊天内容分析、消息提取、结构草稿能力。
- `utils/parse-safety.js`：本地解析安全/校验相关逻辑。
- `utils/navigation-state.js`：页面间筛选/跳转状态。
- `utils/text-normalize.js`：业务文本归一化、别名替换、数字归一。
- `utils/chinese-number.js`：中文数字解析。

## 4. 后端相关代码

### 目录结构

- `server/package.json`：Node >= 20，脚本包括 `start`、`dev`、`check`。
- `server/README.md`：说明 mock server 无 npm 依赖，接口包括 `/health`、`/api/ai/parse`、`/api/ai/query`。
- `server/src/server.js`：HTTP server 入口。
- `server/src/config.js`：读取 `.env` 和环境变量，判断是否启用真实 AI。
- `server/src/lib/http.js`：CORS、读 JSON body、发送 JSON。
- `server/src/ai/model.js`：真实 AI 调用和 mock fallback。
- `server/src/ai/mock.js`：mock parse/query/transcribe。
- `server/deploy/`：nginx 示例和 PM2 ecosystem 配置。
- `server/utils/`：一份前端 `utils` 的服务端副本。

### 接口

- `GET /health`：返回服务健康和当前模式 `ai` 或 `mock`。
- `POST /api/ai/parse`：调用 `parseWithAi(config, body)`。
- `POST /api/ai/query`：调用 `queryWithAi(config, body)`。
- `POST /api/ai/transcribe`：调用 `transcribeWithAi(config)`，当前 README 未列出该接口，但 `server.js` 中实际存在。

### mock/model/server 文件

- `server/src/ai/mock.js`：mock 模式下复用 `../../utils/parser` 和 `../../utils/query`，返回 provider/mock 标记。
- `server/src/ai/model.js`：有真实 AI 配置时调用 OpenAI-compatible `/chat/completions`；无配置时走 mock。
- `server/src/server.js`：不依赖 Express，使用 Node 原生 `http`。

### 后端风险

- 前端 `app.js` 当前写死 `apiBaseUrl: 'https://39.105.7.48'`，属于 API 配置高风险点。
- `server/utils/` 与根目录 `utils/` 存在重复副本，后续修改解析/业务/查询时要确认是否需要同步。
- `server/README.md` 接口列表未提到 `/api/ai/transcribe`，与实际代码不完全一致。

## 5. 测试与报告相关代码

### 可运行脚本

- `scripts/core-feature-tests.js`：核心功能测试，覆盖解析、查询、业务流转、页面/工具相关逻辑。
- `scripts/ai-contract-smoke.js`：AI 接口合约 smoke 测试。
- `scripts/evaluate-wechat-local-rules.js`：微信本地规则评估。
- `scripts/evaluate-wechat-local-rules-hard.js`：高难度本地规则评估。
- `scripts/evaluate-wechat-local-rules-ultra.js`：升级难度本地规则评估。
- `scripts/export-wechat-local-rules-report.js`：导出本地规则报告。
- `scripts/build-promptfoo-record-report.js`：根据 promptfoo 结果生成记一笔中文报告。
- `scripts/build-promptfoo-query-report.js`：根据 promptfoo 结果生成问一句中文报告。
- `scripts/run-promptfoo-record-local.ps1`：运行 promptfoo 记一笔本地评估，必要时会使用 `npm exec --package promptfoo@latest`。
- `scripts/run-promptfoo-query-local.ps1`：运行 promptfoo 问一句本地评估，必要时会使用 `npm exec --package promptfoo@latest`。

### `promptfoo/`

- `record-full.yaml`、`record-cases-100.json`：记一笔 100 条评估。
- `query-full.yaml`、`query-local.yaml`、`query-cases-100.json`：问一句评估。
- `providers/local-record.js`、`providers/local-query.js`：promptfoo 本地 provider。

### 历史报告

- `docs/wechat-local-rules-*.html|md|txt`：微信本地规则测试/高难度/升级难度历史报告。
- `docs/local-parse-safety-acceptance-report.html|txt`：本地解析安全验收报告。
- 根目录中文报告文件：历史导出的本地规则测试报告。
- `reports/promptfoo-record/`、`reports/promptfoo-query/`：promptfoo 历史运行生成的 JSON/CSV/HTML。

## 6. 业务链路文件定位

### 记一笔

- 页面入口：`pages/dashboard/dashboard.js`、`pages/input/input.js`
- 解析：`utils/ai-parser.js`、`utils/parser.js`、`utils/parse-safety.js`、`utils/text-normalize.js`、`utils/chinese-number.js`、`utils/clipboard-chat.js`
- 保存：`utils/business.js`、`utils/storage.js`
- 展示：`utils/display.js`、`utils/home-workbench.js`、`pages/records/records.js`
- 后端可选：`server/src/server.js`、`server/src/ai/model.js`、`server/src/ai/mock.js`

### 问一句

- 页面入口：`pages/query/query.js`
- 本地查询：`utils/ai-query.js`、`utils/query.js`
- 数据来源：`utils/storage.js`、`utils/business.js`
- 后端可选：`server/src/server.js`、`server/src/ai/model.js`、`server/src/ai/mock.js`
- promptfoo：`promptfoo/query-*.yaml|json`、`promptfoo/providers/local-query.js`

### 报价

- 页面：`pages/quotations/quotations.js`
- 保存/流转：`utils/business.js` 的报价保存、报价转订单相关函数。
- 解析来源：`utils/parser.js`、`utils/ai-parser.js`
- 展示聚合：`utils/home-workbench.js`、`pages/records/records.js`

### 订单

- 页面：`pages/orders/orders.js`
- 保存/流转：`utils/business.js` 的订单保存、订单状态更新、订单生成应收、定金/尾款相关函数。
- 状态常量：`utils/constants.js`
- 展示聚合：`utils/home-workbench.js`、`pages/dashboard/dashboard.js`

### 应收款

- 页面：`pages/receivables/receivables.js`、`pages/finance/finance.js`
- 保存/流转：`utils/business.js` 的应收保存、从订单生成应收、收款记录。
- 视图模型：`utils/finance.js`
- 查询：`utils/query.js`

### 收款

- 页面：`pages/finance/finance.js`、`pages/receivables/receivables.js`
- 流转：`utils/business.js` 的 `recordPayment`、`savePayment`、`saveReceivableWithPayment`。
- 数据：`paymentRecords`、`receivables`、可能关联 `orders`。

### 催款

- 页面：`pages/finance/finance.js`、`pages/receivables/receivables.js`
- 流转：`utils/business.js` 的 `generateDunningMessage`、`recordDunning`。
- 模板来源：`utils/storage.js` 初始状态中的 `dunningTemplates`。

### 待办提醒

- 页面：`pages/todos/todos.js`
- 解析/保存：`utils/parser.js`、`utils/ai-parser.js`、`utils/business.js`
- 首页聚合：`utils/home-workbench.js`、`utils/business.js` 的 `getDashboard`。

### 待整理

- 页面：`pages/pending/pending.js`
- 写入：`pages/dashboard/dashboard.js`、`pages/input/input.js` 调用 `savePendingNote`。
- 展示文案：`utils/display.js`
- 数据：`storage` state 中的 `pendingNotes`。

### 客户档案

- 页面：`pages/customer/customer.js`
- 客户创建/匹配/合并：`utils/business.js`、`utils/storage.js`
- 关联展示：报价、订单、应收、收款、待办等记录通过 `customerId` 关联。

### 每日经营看板

- 页面：`pages/dashboard/dashboard.js`
- 聚合：`utils/business.js` 的 `getDashboard`、`utils/home-workbench.js` 的 `buildTodayTasks` / `buildRecentRecords`。
- 数据来源：本地 state 中报价、订单、应收、待办、待整理等数组。

### 自定义底部导航

- 配置：`app.json` 的 `tabBar.custom = true`
- 组件：`custom-tab-bar/index.js|wxml|wxss|json`
- 主要能力：五个 tab 路由、财务角标、中心语音按钮联动首页 `startVoice` / `stopVoice` / `cancelVoice`。

## 7. 高风险文件

- `utils/parser.js`：本地规则解析核心，影响记一笔、mock server、测试报告。
- `utils/ai-parser.js`：混合解析核心，连接本地规则、AI 接口、历史上下文、字段保护。
- `utils/business.js`：业务状态流转核心，影响客户、报价、订单、应收、收款、待办、待整理、看板。
- `utils/storage.js`：本地状态结构和存储 key，涉及数据兼容。
- `utils/query.js` / `utils/ai-query.js`：问一句回答逻辑和服务端 query 接入。
- `utils/finance.js`：财务轻量视图，容易扩张成重型财务。
- `pages/dashboard/dashboard.js`：首页、快速记一笔、语音、剪贴板、看板入口集中。
- `pages/input/input.js`：完整记一笔确认和保存主流程。
- `pages/orders/orders.js`：订单状态和生成应收。
- `pages/finance/finance.js` / `pages/receivables/receivables.js`：收款、催款、应收处理。
- `app.json`：页面注册、tabBar、插件和权限。
- `app.js`：全局 API 地址和 endpoint 配置。
- `custom-tab-bar/index.js`：底部导航、财务角标、中心语音按钮。
- `server/src/ai/model.js`：真实 AI 提示词、返回格式和 mock/AI 分支。
- `server/src/server.js`：AI parse/query/transcribe 路由。
- `server/utils/*`：服务端副本，可能与根 `utils/*` 不一致。

## 8. 发现的结构与产品描述不一致处

- 产品描述说后端、数据库、真实大模型、语音转文字属于后续接入或联调目标；但当前仓库已经存在 `server/`、`/api/ai/parse`、`/api/ai/query`、`/api/ai/transcribe`、`utils/transcribe.js`、`utils/voice-recognition.js` 等接入代码。判断：这些更像联调/预留/可选能力，不代表当前已经稳定上线。
- `app.js` 中已配置固定 `apiBaseUrl: 'https://39.105.7.48'`，与“当前数据主要本地存储、真实后端后续接入”存在阶段表述差异。后续应核实该地址是否生产可用、测试可用或历史遗留。
- `app.json`、多个源码文件和部分导航文案在当前读取环境中显示为乱码，且 `app.json` 的窗口标题仍显示旧名称的乱码形态。判断：可能是既有文件编码/历史命名问题；本轮只盘点，不修改。
- `server/README.md` 只列出 parse/query 接口，但 `server/src/server.js` 实际还提供 transcribe 接口。
- 根目录与 `docs/` 中存在多份历史测试报告，`reports/` 也有 promptfoo 历史报告；后续需要区分“可运行脚本”和“历史产物”。

## 9. 下一步建议

1. 由产品规则 Agent 复核：哪些现有页面/文案仍带旧名称或重型财务倾向。
2. 由解析器 / AI Agent 只读梳理 `utils/parser.js`、`utils/ai-parser.js`、`server/src/ai/model.js` 的解析边界和 AI fallback 条件。
3. 由测试与回归 Agent 整理最小回归清单：记一笔、问一句、订单生成应收、收款、催款、待整理。
4. 任何后续代码修改前，先明确是否允许触碰高风险文件，并一次只改一个业务链路。
