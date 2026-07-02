# 货小玲 Parser / AI / 记一笔链路审计

本文件由解析器 / AI Agent 只读盘点生成。本轮只新增本文档，未修改页面、parser、接口、测试脚本或任何业务代码。

## 1. 总体判断

当前“记一笔”已经有较完整的本地实现链路：入口覆盖首页快记、完整输入页、粘贴微信聊天、语音识别；解析链路以本地规则为基础，经 `utils/ai-parser.js` 判断是否需要 AI；确认后通过 `utils/business.js` 写入本地 `wx.setStorageSync` 状态。

真实 AI 边界处于“已预留并部分接通”的状态：前端 `app.js` 配了固定 `apiBaseUrl` 和 `aiParseEndpoint`，`utils/ai-parser.js` 在小程序环境且有 API 地址时会请求 `/api/ai/parse`；服务端也有 parse/query/transcribe 路由。但服务端默认无 AI key 时运行 mock，且语音转文字 endpoint 为空。因此不能简单说“只有本地规则”，也不能说“真实大模型已稳定接通”。

主要严重风险是前后端 parser 副本已经分叉、语音转文字链路不一致、真实微信聊天复杂度仍主要靠规则和历史测试集兜底。保存前有确认卡和待整理兜底，能降低误存风险，但复杂场景仍需要重点回归。

## 2. 记一笔完整链路

### 入口

- 首页快记：`pages/dashboard/dashboard.js`
  - 文本输入：`composerText`、`submitComposer()`。
  - 粘贴微信聊天：`pasteClipboard()` 读取剪贴板，调用 `analyzeClipboardText()`，成功后直接 `runQuickParse()`。
  - 语音：`startVoice()` / `beginVoiceRecognition()` 调用 `utils/voice-recognition.js` 的 WechatSI 插件封装，识别出文字后 `runQuickParse(text, 'voice')`。
  - 保存：`confirmQuickSave()` 调 `saveConfirmedDraft()`；不确定时 `savePendingFromConfirm()`。

- 完整记一笔页：`pages/input/input.js`
  - 文本输入：`onTextInput()`、`runParse()`。
  - 粘贴微信聊天：`readClipboardToInput()`、`pasteClipboard()`、`appendClipboard()`。
  - 语音录音：`setupRecorder()`、`startVoice()`、`stopVoice()` 使用 `wx.getRecorderManager()`，目前只保存录音提示用户校对文字，没有在该页实际调用 `utils/transcribe.js`。
  - 解析：`runParse()` 构造 payload 后调用 `parseHybridInput()`。
  - 确认：`buildConfirmationState()` 做字段显示、客户匹配、收款/定金/应收确认。
  - 保存：`saveFormal()` 调 `saveConfirmedDraft()`；`savePending()` 调 `savePendingNote()`。

### 解析和保存路径

1. 用户输入文本、语音识别文本或粘贴聊天。
2. 粘贴内容先经 `utils/clipboard-chat.js` 分析，提取有效业务消息、说话人、原始聊天、结构草稿等。
3. 页面调用 `utils/ai-parser.js` 的 `parseHybridInput(payload)`。
4. `parseHybridInput()` 先调用 `utils/parser.js` 的 `parseInput()` 得到本地草稿。
5. `utils/parse-safety.js` 对本地结果做安全判断，可能标记 `SAFE_LOCAL`、`NEEDS_USER_CONFIRM`、`NEEDS_AI`、`NO_RECORD`。
6. 若需要 AI，且小程序环境中有 API 地址，则请求 `/api/ai/parse`；否则返回本地结果并标记 `skipped_no_endpoint`。
7. 页面展示确认卡，用户可改字段、选客户、选应收、选订单定金归属。
8. 用户确认后 `utils/business.js` 保存为报价、订单、应收、收款、待办、订单定金或待整理。
9. `utils/storage.js` 通过 `wx.setStorageSync` 保存本地 state。

## 3. 相关文件清单

### 页面入口

- `pages/dashboard/dashboard.js`：首页快记、语音、粘贴、快速确认保存。
- `pages/input/input.js`：完整记一笔、字段补齐、客户匹配、收款/定金确认、待整理。
- `pages/pending/pending.js`：待整理列表，支持带回 `pages/input` 编辑。

### 前端解析与业务

- `utils/parser.js`：本地规则解析器。
- `utils/ai-parser.js`：本地规则 + AI fallback 协调层。
- `utils/parse-safety.js`：本地解析安全判断。
- `utils/text-normalize.js`：文本归一化、错别字/别名/数字归一。
- `utils/clipboard-chat.js`：微信聊天粘贴分析。
- `utils/business.js`：确认后保存和业务流转。
- `utils/storage.js`：本地状态。
- `utils/display.js`：字段展示、待整理原因文案。
- `utils/voice-recognition.js`：WechatSI 实时语音识别封装。
- `utils/transcribe.js`：后端语音转文字上传封装，但当前页面未形成完整调用链。
- `utils/api-client.js`：读取 `apiBaseUrl` 并封装 `wx.request`。

### 服务端与副本

- `server/src/server.js`：`/health`、`/api/ai/parse`、`/api/ai/query`、`/api/ai/transcribe`。
- `server/src/ai/model.js`：真实 AI 调用和 mock fallback。
- `server/src/ai/mock.js`：mock parse/query/transcribe，复用 `server/utils/*`。
- `server/src/config.js`：AI 环境变量和 mock/real 判断。
- `server/utils/parser.js`、`server/utils/ai-parser.js`、`server/utils/parse-safety.js`：服务端副本，当前与前端部分不同。

### 测试与报告

- `scripts/core-feature-tests.js`
- `scripts/evaluate-wechat-local-rules.js`
- `scripts/evaluate-wechat-local-rules-hard.js`
- `scripts/evaluate-wechat-local-rules-ultra.js`
- `scripts/ai-contract-smoke.js`
- `promptfoo/record-full.yaml`
- `promptfoo/record-cases-100.json`
- `promptfoo/providers/local-record.js`
- `docs/wechat-local-rules-*.md|txt|html`
- `docs/local-parse-safety-acceptance-report.*`
- `reports/promptfoo-record/*`

## 4. 本地规则解析器现状

### `utils/parser.js`

职责：

- 识别意图：`quotation`、`order`、`receivable`、`payment`、`dunning`、`todo`、`query`、`unknown`。
- 提取客户、电话、商品、数量、单位、单价、金额、定金、剩余金额、日期、待办标题、备注。
- 判断操作类型：如 `update_order`、`update_quotation`、`record_order_deposit`。
- 计算总价：数量 * 单价。
- 生成 `missing_fields`、`low_confidence_fields`、`customer_candidates`、`field_sources`、`intent_candidates`、`confidence`、`original_text`。
- 最后调用 `applyLocalParseSafety()`。

现状：

- 本地规则非常重，包含大量中文口语、错别字、微信聊天场景正则。
- 对短句和常见生意场景有直接识别能力。
- 对多轮聊天、改价、历史价格、特殊要求等复杂场景会倾向需要 AI 或用户确认。

### `utils/ai-parser.js`

职责：

- 包装本地 `parseInput()`，形成混合解析。
- 判断是否强制 AI：粘贴、语音、多消息粘贴、改价/特殊要求/历史语义等。
- 根据客户名查找同客户历史，构造 `businessContext`。
- 构造 AI 请求 payload，包括 `localDraft`、`rawMessages`、`pasteMeta`、上下文。
- 规范化 AI 返回，合并字段，并保护本地明确事实。
- AI 不可用时返回本地结果并标记状态。

关键边界：

- 非小程序环境或没有 `apiBaseUrl` 时，不请求服务端，返回 `skipped_no_endpoint`。
- 小程序环境有 `apiBaseUrl` 时，会请求 `getAiParseEndpoint()`，默认 `/api/ai/parse`。
- `normalizeAiResult()` 会把 AI 返回合并到本地结果，但仍保留 `original_text`、`source`、本地字段来源等。

### `utils/parse-safety.js`

存在，职责是本地解析安全判断：

- 状态包括 `SAFE_LOCAL`、`NEEDS_AI`、`NEEDS_USER_CONFIRM`、`NO_RECORD`。
- 粘贴和语音来源直接倾向 `NEEDS_AI`。
- 检查客户名、商品名、数量、单价、必填字段、冲突字段、语义复杂度。
- 将风险字段放入 `low_confidence_fields` 或 `missing_fields`。
- 降低不安全结果的 confidence。

### `utils/text-normalize.js`

存在，职责是文本归一化：

- 产品别名归一。
- 常见错别字/同音字归一。
- 大写财务数字归一。
- 全角转半角。
- 阿拉伯数字中的 `w/W`、万、千等数量级归一。

### 前后端副本差异

只读哈希检查结果：

- `utils/business.js` 与 `server/utils/business.js` 哈希相同。
- `utils/query.js` 与 `server/utils/query.js` 哈希相同。
- `utils/parser.js` 与 `server/utils/parser.js` 哈希不同。
- `utils/ai-parser.js` 与 `server/utils/ai-parser.js` 哈希不同。
- `utils/parse-safety.js` 与 `server/utils/parse-safety.js` 哈希不同。

风险：服务端 mock parse 使用的是 `server/utils/parser.js`，不一定等同于小程序前端当前规则。后续如果只改一边，测试和真机表现可能分叉。

## 5. AI 接口现状

### 前端是否调用真实 AI parse

会在条件满足时调用：

- `utils/ai-parser.js` 的 `parseHybridInput()` 会先本地解析。
- 如果需要 AI，且 `typeof wx !== 'undefined'` 且 `getApiBaseUrl()` 有值，则通过 `requestJson()` 请求 AI parse endpoint。
- `app.js` 当前配置：
  - `apiBaseUrl: 'https://39.105.7.48'`
  - `aiParseEndpoint: '/api/ai/parse'`
  - `aiTranscribeEndpoint: ''`

因此真机小程序环境中，复杂输入、粘贴、语音等可能会请求 `https://39.105.7.48/api/ai/parse`。但该接口后端是否真实 AI，取决于服务端环境变量。

### 服务端 AI / mock

- `server/src/server.js`
  - `POST /api/ai/parse` 调 `parseWithAi()`。
  - `POST /api/ai/query` 调 `queryWithAi()`。
  - `POST /api/ai/transcribe` 调 `transcribeWithAi()`。
- `server/src/config.js`
  - 默认 `AI_PROVIDER=mock`。
  - 只有 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 存在且 provider 不是 mock，才启用真实 AI。
- `server/src/ai/model.js`
  - 真实 AI 使用 OpenAI-compatible `/chat/completions`。
  - 没有真实配置时，parse/query/transcribe 都走 mock。
- `server/src/ai/mock.js`
  - `mockParse()` 复用 `server/utils/parser.js`。
  - `mockQuery()` 复用 `server/utils/query.js`。
  - `mockTranscribe()` 返回 not_configured，不做真实转文字。

### 边界是否清晰

代码层边界基本清晰：本地规则先出草稿，AI 只增强复杂输入，用户仍需确认。

产品/环境层边界不够清晰：

- 前端写死生产样式 IP 地址，但当前文档定位仍说后端/真实 AI 是后续接入目标。
- 服务端默认 mock，前端文案会出现 `mock_used`。
- 测试脚本在 Node 环境下不会调用真实 AI，历史报告主要验证本地规则。
- `server/utils/*` 副本和前端 `utils/*` 不完全一致。

## 6. 支持业务类型清单

真实代码支持以下 intent / operation：

- 报价
  - intent：`quotation`
  - 保存：`saveQuotation()`
  - 更新：`updateQuotationFromDraft()`
  - 流转：`convertQuotationToOrder()`

- 订单
  - intent：`order`
  - 保存：`saveOrder()`
  - 更新：`updateOrderFromDraft()`
  - 状态：`updateOrderStatus()`
  - 流转：`generateReceivableFromOrder()`

- 应收款
  - intent：`receivable`
  - 保存：`saveReceivable()`
  - 订单生成：`generateReceivableFromOrder()`

- 收款
  - intent：`payment`
  - 普通收款：`savePayment()`、`recordPayment()`
  - 没匹配到旧应收时可能走 `create_receivable_with_payment`

- 订单定金
  - operation：`record_order_deposit`
  - 保存：`saveOrderDeposit()`
  - 规则：定金归订单阶段已收款，不直接新建应收。

- 催款
  - intent：`dunning`
  - 当前 parser 支持 intent，业务侧有 `generateDunningMessage()`、`recordDunning()`。
  - 但 `saveConfirmedDraft()` 没有直接以 `intent === 'dunning'` 保存催款草稿的独立分支，更多是在应收/收款页面操作。

- 待办提醒
  - intent：`todo`
  - 保存：`saveTodo()`
  - 完成：`completeTodo()`

- 待整理
  - intent：`unknown` 或 operation：`pending`
  - 保存：`savePendingNote()`
  - 来源：字段缺失、匹配不到唯一客户/订单/应收、用户主动稍后整理、无业务粘贴等。

## 7. 字段提取清单

### 通用字段

- `customerName`：客户称呼。
- `phone`：手机号。
- `remark`：备注，通常保留原始输入或聊天要求。
- `original_text`：原始输入文本。
- `raw_text`：粘贴时的原始聊天。
- `extracted_text`：粘贴时提取出的业务文本。
- `source`：`typed`、`paste`、`voice`。
- `confidence`：本地或 AI 合并后的置信度。
- `field_sources`：字段来源，例如规则、结构草稿、历史记录、计算字段。
- `missing_fields`：缺失字段。
- `low_confidence_fields`：低置信字段。
- `intent_candidates`：候选业务类型。

### 报价

- 客户：`customerName`
- 商品：`productName`
- 规格：`spec`
- 数量：`quantity`
- 单位：`unit`
- 单价：`unitPrice`
- 总价：`amount`
- 报价日期：`quoteDate`
- 跟进/交付相关日期：`dueDate` 或页面中的 followup 逻辑
- 备注：`remark`

### 订单

- 客户：`customerName`
- 商品：`productName`
- 规格：`spec`
- 数量：`quantity`
- 单位：`unit`
- 单价：`unitPrice`
- 总价：`amount`
- 交期：`dueDate`
- 定金：`depositAmount`、`paymentAmount`、`paymentKind`
- 关联报价：`quotationId`
- 备注：`remark`

### 应收款

- 客户：`customerName`
- 金额：`amount`
- 到期日：`dueDate`
- 关联订单：`orderId`
- 已收金额：`paidAmount` 在保存后生成，解析阶段可能来自 `paymentAmount`
- 剩余金额：`remainingAmount`
- 备注：`remark`

### 收款

- 客户：`customerName`
- 本次收款：`paymentAmount`
- 关联应收：`receivableId`
- 关联订单：`orderId`
- 收款类型：`paymentKind`
- 剩余金额：`remainingAmount`
- 备注：`remark`

### 订单定金

- 客户：`customerName`
- 定金金额：`depositAmount` / `paymentAmount`
- 定金类型：`paymentKind = deposit`
- 关联订单：`orderId`
- 商品/交期可辅助匹配：`productName`、`dueDate`

### 待办提醒

- 待办标题：`todoTitle`
- 客户：`customerName`
- 提醒日期：`dueDate`
- 可保留商品/数量/单价等上下文：`productName`、`quantity`、`unitPrice`
- 备注：`remark`

## 8. 待整理兜底逻辑

### 进入待整理的情况

- `saveConfirmedDraft()` 收到 `intent === 'unknown'`。
- 操作为 `update_quotation` 但找不到 `quotationId`。
- 操作为 `update_order` 但找不到 `orderId`。
- 报价/订单/应收/待办保存时客户匹配不唯一。
- 订单定金找不到唯一可关联订单。
- 新建应收并记录收款时，已收金额大于应收总额。
- 普通收款找不到可关联应收，或收款金额大于剩余应收。
- 粘贴微信聊天没有识别到业务内容，页面会构造 `unknown/pending` 草稿。
- 用户主动点击稍后整理。

### 字段缺失还是识别不确定

两类都会进入待整理：

- 字段缺失：例如缺客户、缺订单 ID、缺应收 ID、缺关键金额。
- 识别不确定：例如低置信字段、冲突字段、复杂聊天、历史匹配失败、无业务内容。

### 强行分类风险

存在但有缓冲：

- `parser.js` 会给出单一 `intent`，复杂短句可能被归入报价/订单/收款之一。
- `parse-safety.js` 会把粘贴、语音、多轮、冲突、复杂语义拉到 AI 或用户确认。
- 页面保存前仍有确认卡，`disableFormalSave` 可阻止缺关键信息直接保存。

风险仍在：如果本地规则给出错误 intent 且字段看似完整，用户未认真核对就可能误存。

### 信息丢失风险

- 正常 parse result 保留 `original_text` 和 `remark`。
- 粘贴时保留 `raw_text`、`extracted_text`、`paste_meta`、`rawMessages`。
- `savePendingNote()` 保存 `originalText`、`draft`、`missingFields`、`lowConfidenceFields`。

风险点：

- 首页快速确认卡比完整输入页简化，复杂字段展示可能不如完整页。
- AI 返回合并时如果字段被覆盖，虽有 `protectLocalFacts()`，仍需测试复杂客户名/商品名。
- `saveConfirmedDraft()` 只保存业务记录需要的字段，parse 中部分诊断信息主要进入 `aiParseLogs` 或 pending draft。

## 9. 语音转文字现状

### 首页语音

- `app.json` 已配置 `WechatSI` 插件和录音权限。
- `utils/voice-recognition.js` 使用 `requirePlugin('WechatSI').getRecordRecognitionManager()`。
- `pages/dashboard/dashboard.js` 使用插件实时识别，拿到文字后走 `runQuickParse(text, 'voice')`。
- 如果插件不可用或无权限，会提示改用打字或粘贴。

判断：首页语音识别有真实插件链路，但依赖微信环境、插件权限、真机表现。

### 完整输入页语音

- `pages/input/input.js` 使用 `wx.getRecorderManager()` 录音。
- 录音结束后只提示“录音已保存/待语音转文字”，未看到实际调用 `utils/transcribe.js`。

判断：完整输入页更像录音入口占位，未形成完整语音转文字闭环。

### 后端 transcribe

- `utils/transcribe.js` 存在，支持用 `wx.uploadFile` 上传到 `aiTranscribeEndpoint`。
- `app.js` 中 `aiTranscribeEndpoint: ''`。
- `server/src/server.js` 有 `/api/ai/transcribe`。
- `server/src/ai/model.js` 的 `transcribeWithAi()` 当前直接返回 mock。
- `server/src/ai/mock.js` 的 `mockTranscribe()` 返回 not_configured。

结论：语音转文字能力不稳定，当前不能视为完整接通。真机风险包括插件不可用、录音权限失败、识别结果为空、完整输入页无法自动转文字、后端 transcribe endpoint 未配置。

## 10. 测试覆盖现状

### 可复跑脚本

- `scripts/core-feature-tests.js`
  - 覆盖 `parseInput`、`parseHybridInput`、`parse-safety`、业务保存、查询、确认状态、剪贴板等。
- `scripts/evaluate-wechat-local-rules.js`
  - 100 条微信本地规则评估，链路为 `analyzeClipboardText -> parseHybridInput`。
- `scripts/evaluate-wechat-local-rules-hard.js`
  - 高难度本地规则评估。
- `scripts/evaluate-wechat-local-rules-ultra.js`
  - 升级难度本地规则评估。
- `scripts/ai-contract-smoke.js`
  - 对 `/api/ai/parse` 做接口合约 smoke。
- `scripts/run-promptfoo-record-local.ps1`
  - 运行 promptfoo 记一笔本地评估。
- `scripts/run-promptfoo-query-local.ps1`
  - 运行 promptfoo 问一句本地评估。

### promptfoo

- `promptfoo/record-full.yaml` + `promptfoo/record-cases-100.json`
  - 记一笔 100 条评估。
- `promptfoo/query-full.yaml`、`promptfoo/query-local.yaml`、`promptfoo/query-cases-100.json`
  - 问一句评估。
- `promptfoo/providers/local-record.js`
  - 会请求 `${baseUrl}/api/ai/parse`。
- `promptfoo/providers/local-query.js`
  - 会请求 query 接口。

### 历史报告

- `docs/wechat-local-rules-evaluation.*`
- `docs/wechat-local-rules-hard-evaluation.*`
- `docs/wechat-local-rules-ultra-evaluation.*`
- `docs/local-parse-safety-acceptance-report.*`
- 根目录中文测试报告文件。
- `reports/promptfoo-record/*`
- `reports/promptfoo-query/*`

### 过拟合风险

存在。当前规则和报告大量围绕固定 100 条、本地 hard/ultra 用例演进；历史报告明确说明 Node 环境下没有 `wx` 和 API endpoint，因此不会调用真实 AI。真实微信聊天会有更多截断、撤回、表情、图片说明、语音口误、错别字、多客户同名、多产品、多轮改价等情况，固定用例不能覆盖全部。

## 11. 高风险问题

### 11.1 parser 前后端重复风险

`utils/parser.js` 与 `server/utils/parser.js` 哈希不同；`utils/ai-parser.js` 与 `server/utils/ai-parser.js` 哈希不同；`utils/parse-safety.js` 与 `server/utils/parse-safety.js` 哈希不同。服务端 mock 使用 `server/utils/*`，前端使用根 `utils/*`，可能导致真机本地结果、服务端 mock 结果、测试结果不一致。

### 11.2 规则解析和 AI 解析职责不清风险

代码层有边界，但产品状态容易混淆：前端有固定 API 地址，服务端默认 mock，测试环境不调 AI，文案又会出现 mock。后续需要明确当前到底以“纯本地规则”为准，还是以“真实 AI 增强”为准。

### 11.3 字段丢失风险

复杂粘贴中，`clipboard-chat` 会选择分数最高的一组业务消息，可能丢掉其他同样重要的消息；首页快速确认字段展示较少；AI 合并字段虽有保护，但仍需验证客户名、备注、特殊要求、历史默认字段不会被覆盖。

### 11.4 待整理兜底不稳风险

待整理能兜底大量不确定场景，但如果错误 intent 的字段看起来完整，系统可能允许保存正式记录。待整理依赖页面确认状态和业务保存逻辑，不是 parser 单独能保证。

### 11.5 真实微信聊天复杂度不足风险

测试集很多，但仍是脚本化样例。真实聊天中的多客户、多产品、图片/语音上下文、撤回、只复制一条、口头简称、群聊角色、跨天聊天等会更复杂。

### 11.6 语音转文字未接通风险

首页使用 WechatSI，完整输入页使用录音但不转文字，后端 transcribe endpoint 为空且 mock 返回 not_configured。真机体验可能出现：首页能识别，输入页不能自动转文字。

### 11.7 API 地址不一致风险

`app.js` 写死 `https://39.105.7.48`，服务端默认配置端口 `3001` 且 README 描述本地 mock server。需要确认线上 IP、HTTPS、证书、小程序 request 合法域名、服务端是否真实 AI。

## 12. 后续建议修复顺序

1. 先明确当前阶段：本地规则版、mock AI 联调版、真实 AI 增强版三者选一个作为验收基线。
2. 处理前后端 parser 副本：确定单一来源，或建立同步/差异检查。
3. 明确 AI parse endpoint：确认 `https://39.105.7.48/api/ai/parse` 当前是否可用、是否 mock、是否已配合法域名。
4. 补一轮“记一笔保存前确认”回归：报价、订单、应收、收款、订单定金、待办、待整理。
5. 梳理语音：决定保留 WechatSI 识别、后端转文字，还是先只支持文字/粘贴。
6. 扩展真实微信聊天样本：尤其多轮改价、多产品、多客户、只复制一条、无业务内容。
7. 再优化文案：把 mock、AI、解析安全等技术表达转成老板能理解的提示。

## 13. 哪些问题可以并行处理

- 只读梳理前后端 parser 差异。
- 只读梳理 AI endpoint、服务端部署、合法域名和 mock/real 配置。
- 设计新增真实微信聊天测试样本。
- 梳理语音真机测试清单。
- 产品文案 Agent 梳理解析确认卡文案。
- 测试 Agent 整理可复跑脚本和历史报告对应关系。

## 14. 哪些问题必须串行处理

- 修改 `utils/parser.js` 与 `server/utils/parser.js`：必须先确定单一来源和同步策略。
- 修改 `utils/ai-parser.js` / `server/utils/ai-parser.js`：会影响 AI fallback、历史上下文、字段合并。
- 修改 `utils/business.js` 的保存分支：会影响正式记录和待整理兜底。
- 修改 `pages/input/input.js` 的确认状态：会影响字段补齐、客户匹配、收款和定金。
- 修改 `app.js` 的 API 地址：涉及环境、合法域名、真机联调。
- 接入真实语音转文字：涉及 `app.js` endpoint、`utils/transcribe.js`、服务端 `/api/ai/transcribe`、权限和真机测试。
- 改变 intent / operation 命名：会影响 parser、display、business、测试用例、历史报告。
