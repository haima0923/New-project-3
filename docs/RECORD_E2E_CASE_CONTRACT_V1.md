# 记一笔 E2E 测试题合同 V1

## 1. 目的与边界

本合同定义“记一笔”从原始输入到最终 State Diff 的统一测试题格式。它服务于：

- Phase 2 Headless 确定性 Runner；
- 后续微信页面 E2E Driver；
- 独立的真实千问质量 Runner；
- 单题重跑、Trace、截图和失败分类。

V1 只建立合同、合成 fixtures 与 120 条核心题，不实现 Runner，不操作微信页面，不调用真实千问，不写真实微信业务 Storage。Expected 来自产品合同、Preflight 安全规则、业务 State 合同和人工审查；当前实现输出只能用于以后发现差异，不能定义正确答案。

## 2. 文件布局

```text
tests/record-e2e/
  schema/record-e2e-case-v1.schema.json
  contracts/record-e2e-enums-v1.json
  cases/core-v1/*.json
  fixtures/states/state-fixtures-v1.json
  fixtures/ai/ai-fixtures-v1.json
  decisions/product-decision-backlog-v1.json
  corpus-index-v1.json
scripts/validate-record-e2e-corpus.js
```

Schema 描述机器结构，枚举文件提供封闭值域，Validator 负责跨字段语义、安全、隐私、去重和覆盖门禁。Schema 与 Validator 缺一不可。

## 3. Case 主结构

每题必须包含：

```text
schemaVersion
caseId / title / status / riskLevel / category / tags
provenance
executionProfiles
input
clock
initialState
ai
interaction
expected
allowances
knownRisk
```

`caseId` 是不随排序变化的永久标识。ACTIVE、NEEDS_PRODUCT_DECISION、RETIRED 是唯一状态；已知 Bug 不得使用 EXPECTED_FAIL、IGNORE_FAILURE 或等价方式豁免。

`provenance.sources` 记录题型来源，`sourceCaseIds` 记录可追溯的旧匿名题号，`expectedBasis` 至少包含两项独立依据。禁止使用 `CURRENT_IMPLEMENTATION_OUTPUT` 作为答案依据。

## 4. 输入与执行能力

输入渠道为：

```text
TYPED_TEXT
CLIPBOARD_CHAT
VOICE_TRANSCRIPT
HISTORY_EDIT
PENDING_EDIT
```

入口为 `HOME_QUICK`、`FULL_PAGE` 或 `HEADLESS`。聊天题必须保留 `clipboardText`、`expectedExtractedText`，且 `originalText` 严格等于原始剪贴板文本；语音题只保存合成转写文本，必须提供 `voiceTranscript` 和 `transcriptCharacteristics`。

`PENDING_EDIT` 必须额外声明 `input.pendingNoteId`。该 ID 必须存在于展开后的匿名初始 State；不得让 Runner 猜测要更新哪条待整理记录。

`executionProfiles` 只是未来 Runner 能力标签：

```text
HEADLESS_DETERMINISTIC
PAGE_E2E
REAL_QWEN_QUALITY
VOICE_TRANSCRIPT
CLIPBOARD_CHAT
RESTART_PERSISTENCE
```

REAL_QWEN_QUALITY 不表示本题已经调用过千问。确定性运行的 AI 行为仍由 `ai.profile` 指定。

## 5. 固定时间

所有 ACTIVE 题都显式提供：

```json
{
  "businessDate": "2026-07-15",
  "timezone": "Asia/Shanghai",
  "nowInstant": "2026-07-15T02:00:00.000Z"
}
```

`nowInstant` 按 `timezone` 投影后必须等于 `businessDate`。日期 expected 使用 `YYYY-MM-DD`，不得读取系统“今天”、运行时改写答案，或用无限远未来日期逃避过去日期检查。

## 6. 初始 State

Case 通过 `initialState.fixtureRef` 引用匿名 State；小范围差异可放在 `overrides`。fixture 使用合成 ID、称呼、商品和金额，不包含真实客户资料。

V1 的 fixture 继承和 case overrides 都采用“顶层键整体替换”，不做数组追加或按 id 隐式合并。需要两笔历史记录时应建立包含两笔完整记录的专用 fixture；不得依赖 Runner 猜测 override 语义。Validator 只允许已知 State 顶层键。

V1 覆盖空 State、唯一客户、单/多历史订单、同名客户、有效/已转报价、活动订单、单/多开放待收、已结清待收、部分定金、未知兼容字段、多商品历史、待整理编辑，以及跨客户和失效历史安全场景。

State fixture 存储字段可沿用当前 State 的 `paymentRecords`；`expected.stateDiff` 使用公共 Diff 集合名 `payments`。Runner 负责这一项明确映射，不得自行猜测其他字段。

## 7. AI fixture 与真实质量边界

`ai.profile` 为：

```text
LOCAL_ONLY
FAKE_STANDARD
FAKE_DEEP
REPLAY
REAL_QUALITY_ELIGIBLE
```

FAKE_STANDARD、FAKE_DEEP、REPLAY 必须引用匹配 reviewMode/providerKind 的 fixture。fixture 只含合成响应、脱敏且明确非真实客户的 Replay，或 timeout、非法 JSON、空业务等故障合同。

每道使用 Fake/Replay 的 ACTIVE 题引用一个绑定同一 `caseId` 的独立 fixture。Case-bound fixture 的 `response.fields` 表示 provider 响应经过 AI normalizer 和 Confirmation 字段投影后的合成结果，不是原始 HTTP JSON；原始 Provider 合同由通用形状 fixture 单独描述。成功响应的客户、商品、金额、关系和 items 必须与该题人工审查的 expected 一致；有 `userSelections` 时 fixture 保留候选但不预填选择结果；有 `userEdits` 时 fixture 表示编辑前值。Validator 会应用选择和编辑，再检查所得字段是否精确等于 expected。通用 fixtures 只作为 Standard、Deep、uncertain、空业务、非法 JSON、timeout、Mock、多商品和历史候选的形状模板，不直接被不同业务事实的题目混用。

Fake/Mock/Replay 可在隔离 Memory 中验证下游正式业务 State Diff，但：

- `productionCommitEligible` 永远为 false；
- commitTarget 只能是 `MEMORY_ONLY` 或 `NONE`；
- 不计入真实模型质量；
- 不取得生产正式保存资格。

真实千问质量运行必须由显式独立命令触发，只使用合成题，只记录模型、路由、耗时、错误码和脱敏响应，不写生产 State。V1 本身不执行真实千问。

## 8. Route 与 NO_RECORD

`expected.route` 是判分主值，`ai.expectedRoute` 必须与其一致。允许值：

```text
LOCAL
PENDING
AI_STANDARD
AI_DEEP
NO_RECORD
```

NO_RECORD 是 E2E 语义状态，不是假装存在同名生产 route。它必须同时声明：

```text
productionRoute = PENDING
executionPath = PRODUCTION_PENDING
localSafetyStatus = NO_RECORD
expectedAiCall = MUST_NOT_CALL
```

只有产品合同确实允许多种路由时才可使用 `allowedRoutes`，必须给出理由；P0 题不得放宽路由。

## 9. 用户交互

`interaction.userEdits` 支持字段和指定 `itemIndex` 的商品编辑；`userSelections` 支持客户、订单、报价和待收候选。复杂幂等/并发题可用封闭的 `interaction.sequence` 表达 PREPARE、COMMIT、RESTART、RETRY_SAME_PLAN 等步骤，以及可选的 `actor`、`planRef`、`baseRevision` 和 `input.originalText`。Runner 指令、页面 actor 和第二个并发动作的原文不得拼进主 `input.originalText`。

`requestedSaveAction` 只有：

```text
SAVE_FORMAL
SAVE_PENDING
DO_NOT_SAVE
```

Expected 表示应用全部人工编辑和选择后的最终结果。选择前的阻断条件仍由 `requiredSelections` 明确记录。

## 10. Result、Preflight、Confirmation 与 Surface

`expected.result` 是“AI/本地结果完成 normalizer、应用用户选择与编辑、投影为 Confirmation 标准语义字段之后，执行保存之前”的判分层。它不是原始 parser JSON，也不是 Storage 记录。它必须保留 `originalText`，并明确 businessType、operation、fields、items。

V1 的关键字段只使用确认卡标准语义名：

| 业务语义 | Result/Confirmation 字段 | Storage / State Diff 常见字段 |
| --- | --- | --- |
| 收款金额 | `paymentAmount` | `paymentRecords[].amount` |
| 定金金额 | `depositAmount` | `paymentRecords[].amount` |
| 待收金额 | `receivableAmount` | `receivables[].amount` |
| 订单交期 | `orderDeliveryDate` | `orders[].requiredDeliveryDate` |
| 待收到期 | `receivableDueDate` | `receivables[].dueDate` |
| 收款日期 | `paymentDate` | `paymentRecords[].paidAt` |
| 提醒日期 | `todoRemindDate` | `todos[].dueDate` |
| 报价跟进日 | `quoteFollowupDate` | 报价/提醒投影字段 |

因此同一 operation 不得混用 `amount/paymentAmount`、`amount/depositAmount` 或 `dueDate/paidAt` 等别名。`quoteDate` 是保存时由固定 clock 生成的报价记录日期，不在没有用户输入日期的 Result 中伪造成解析事实。

合理且不影响业务结论的可变项只能通过“合法字段路径 → 非空候选数组”的 `allowedValues` 表示。互相冲突、保存前必须消解的候选使用 `conflictValues`；其字段必须同时出现在 `confirmation.conflictFields`，不能被 Runner 当作任一值都通过。`absentFields` 只接受合法字段路径。不得允许任意客户、金额、商品、数量或日期。

Preflight 分开表达：

- `domainCanSaveFormal`；
- `domainCanSavePending`；
- `blockingCodes`；
- `requiredSelections`。

Confirmation 明确 required、missing、conflict 字段。Surface 分别为 home/fullPage 对象，并同时表达：

- status：CAN_COMPLETE、REQUIRES_FULL_PAGE、BLOCKED、NOT_APPLICABLE；
- `surfaceCanCompleteFormal`；
- `effectiveCanSaveFormal`；
- `missingCapabilities`。

业务安全不等于当前页面有能力完成确认；完整页也不能解除领域安全阻断。

## 11. 保存与 State Diff

保存状态为：

```text
FORMAL_COMMITTED
PENDING_COMMITTED
BLOCKED
NO_RECORD
```

规则：

- FORMAL_COMMITTED 必须由 `SAVE_FORMAL` 且 `domainCanSaveFormal=true` 产生，并具有正式业务 Diff；
- PENDING_COMMITTED 必须由用户明确 `SAVE_PENDING` 产生，只允许 pendingNotes 及合同允许的日志变化；
- BLOCKED 和 NO_RECORD 必须零业务副作用；
- Fake/Replay 的 “committed” 只表示隔离 Memory 提交。

`expected.stateDiff.business/full` 通过 collection count、fieldAssertions、relationAssertions 和 mustRemainUnchanged 描述结果。`fieldAssertions` 的封闭字段为 `collection/change/path/assert/value`；除 `ABSENT` 外必须给出 `value`，而 `ABSENT` 禁止带 `value`。`relationAssertions` 的封闭字段为 `fromCollection/fromPath/toCollection/toId`。省略 `toId` 只表示目标集合在本次 Diff 中恰好创建了一条记录；如果目标不唯一，题目必须给出 `toId`，不得由 Runner 猜测。公共集合覆盖 customers、quotations、orders、receivables、payments、todos、pendingNotes、productCatalog、operationLogs、aiParseLogs，并可扩展到合同枚举中的兼容集合。

P0 至少有一项最终 State 断言或完整零副作用断言。金额、关系、`originalText`、`items[]` 不能只靠记录数量间接判断。

## 12. 多商品

多商品题至少两件，并逐项断言名称、数量、单位、单价；信息缺失必须显式进入 Confirmation missing/conflict。State Diff 必须包含 `items[1]` 及后续商品和 `originalText`。

首页 `REC-E2E-PAGE-008` 是单商品 `items[0]` 同步 P0 候选：人工修改后的顶层字段和 `items[0]` 必须同步，金额按新值计算，旧 item 不得保存。`knownRisk` 仅记录静态证据，不改变 expected、不豁免失败。本阶段不修复产品代码。

## 13. 重启、幂等与并发

`expected.restart` 表达重启后指纹、记录数和必须存在的记录；`expected.idempotency` 表达：

- SAME_PLAN_RETRY；
- DISTINCT_ACTIONS_MUST_NOT_DEDUP；
- SAME_BASE_CONCURRENT_COMMITS；
- DOUBLE_UI_TRIGGER。

合同可断言 revision 增量、二次业务 Diff、Commit statuses、Journal 和 Backup 的最终清理状态。并发题的第二个业务动作使用对应 PREPARE step 的 `input.originalText`；主 `expected.result` 仍判定主动作，第二个动作的安全结果由 commit status、revision 与零额外 Diff 断言。Phase 2 先在隔离 Store 消费这些不变量，页面 Runner 后续复用同一 Case。

## 14. Allowances 与 Known Risk

Allowances 只能是：

```text
GENERATED_ID
FIXED_TIME_FORMAT
OBJECT_KEY_ORDER
NON_SEMANTIC_LOG_ORDER
```

必须给出路径和理由。客户、金额、商品、数量、日期、业务关系、记录数量、`originalText`、`items[]` 永远不能放入 allowances。

`knownRisk` 只记录 riskId、状态、摘要和静态证据。它不参与判分，不能包含 expected-fail、ignore、waive 或“当前行为即正确”等语义。

## 15. 隐私与独立答案

全部题目为人工重写的合成业务表达。“王总”“李姐”等是虚构通用称呼。禁止真实手机号、邮箱、精确地址、微信号、Cookie、API Key、Token、真实聊天记录和可识别客户资料。

每题 expected 必须能从原文、initialState、产品规则和安全规则独立推出。Runner 输出、当前 parser 结果、当前页面行为及已知 Bug 均不得回写为正确答案。

## 16. 产品决策待办

合同无法唯一确定的产品行为放入 `product-decision-backlog-v1.json`，不计入 120 条 ACTIVE 题。待办只包含产品政策问题，不包含依赖、Driver 或代码实现选择。

## 17. 校验与运行

Validator 无第三方依赖，且只读取仓库文件：

```bash
node scripts/validate-record-e2e-corpus.js
```

在本项目当前受控环境中也可使用微信开发者工具内置 Electron 的 Node 模式运行。它检查：

- JSON、实际 Schema 子集、必填字段、封闭枚举、fixture 继承/引用和 caseId 唯一性；
- 固定时钟、时区投影和明确 ISO 日期；
- Result 标准字段层、allowed/conflict/absent 路径、Route、AI profile/reviewMode/providerKind、Preflight、Surface、Save 与 Diff 的交叉关系；
- Sequence、fieldAssertions、relationAssertions 的封闭结构和引用对象；
- P0 零副作用、多候选、Fake/Replay 隔离；
- 多商品第二件、金融超额和关系安全；
- 隐私、密钥、allowances、knownRisk；
- 原文重复、疑似仅换数字重复、分类和风险配额；
- ACTIVE、PAGE_E2E、REAL_QWEN_QUALITY、输入渠道、路由、保存和 fixtures 的覆盖统计。

校验只输出控制台统计，不生成或提交运行报告。

## 18. Phase 2 消费约定

Phase 2 Runner 应：

1. 按 caseId 单题加载；
2. 解析 fixture 继承并应用受控 overrides；
3. 注入固定 clock、MemoryStore 和选择/编辑动作；
4. 根据 `ai.profile` 使用本地、Fake 或 Replay；
5. 从原文走生产等价 parseHybridInput、页面安全、Legacy business 和隔离 Store；
6. 分层比较 result、route、preflight、confirmation、save、stateDiff、restart/idempotency；
7. 输出 Trace 和失败归类，不修改 expected；
8. 永远不访问真实业务 key。

页面选择器、点击坐标和截图路径属于 Driver，不写入 Case；真实模型重复次数、成本和稳定性属于质量 Runner，不与确定性代码回归混算。
