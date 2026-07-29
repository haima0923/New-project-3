# 记一笔 E2E 测试题合同 V1

## 1. 目的与边界

本合同定义“记一笔”从原始输入到最终 State Diff 的统一测试题格式。它服务于：

- Phase 2 Headless 确定性 Runner；
- 后续微信页面 E2E Driver；
- 独立的真实千问质量 Runner；
- 单题重跑、Trace、截图和失败分类。

V1 只建立合同、合成 fixtures 与 120 条核心题，不实现 Runner，不操作微信页面，不调用真实千问，不写真实微信业务 Storage。Phase 2A 将 Case 小版本升级为 `record-e2e-case-v1.1`，只补充执行边界，不改变业务答案。Expected 来自产品合同、Preflight 安全规则、业务 State 合同和人工审查；当前实现输出只能用于以后发现差异，不能定义正确答案。

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
为保持既有工具路径稳定，Schema文件名仍为`record-e2e-case-v1.schema.json`；其`$id`和Case内版本已明确升级为`record-e2e-case-v1.1.schema.json` / `record-e2e-case-v1.1`，不得仅凭物理文件名推断版本。

## 3. Case 主结构

每题必须包含：

```text
schemaVersion
caseId / title / status / riskLevel / category / tags
provenance
executionProfiles
execution
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

`executionProfiles` 只是未来 Runner 能力标签，不决定实际执行层。`execution.lanes` 才是机器可执行边界：

```text
PAGE_PRODUCTION_OBSERVATION
HEADLESS_PRODUCTION_OBSERVATION
PAGE_CONFIRMED_DRAFT_DERIVATION
TEST_ONLY_ISOLATED_LEGACY_COMMIT
PAGE_DUPLICATE_TRIGGER_GUARD
TRANSACTION_EXACT_REPLAY
RESTART_PERSISTENCE
CONCURRENT_BASE_REVISION
```

页面观察必须调用当前生产页面方法；Headless观察必须明确省略页面，不得冒充PAGE结果。现有6条HEADLESS但需要提交的题，必须额外执行`PAGE_CONFIRMED_DRAFT_DERIVATION`，通过真实完整页方法生成草稿后才能进入隔离提交。隔离提交、页面点击防重、重启、事务重放和并发分别产生独立lane结果。

`execution.missingCapabilityDisposition`固定为`CASE_FAIL`，`missingCapabilityFailureStage`固定为`SURFACE_ERROR`。`laneResults`属于未来Runner输出，不写入Case Expected，避免把当前产品缺陷固化为正确答案。

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

AI profile只描述确定性输入来源，不再携带生产Commit资格。生产资格与测试执行分别写入：

```text
expected.productionObservation
expected.isolatedExecution
```

Fake/Mock/Replay必须分类为`NON_REAL_FAKE`或`NON_REAL_REPLAY`；安全业务也只能得到`BLOCKED_NON_REAL_PROVIDER`，不得包装成REAL。LOCAL_ONLY分类为`TEST_LOCAL_ONLY`；若当前本地生产链业务与Surface均安全，可观察为`ELIGIBLE_LOCAL`，但不代表真实AI成绩。

测试隔离提交必须标记`TEST_ONLY_ISOLATED_COMMIT`，目标只能是`ISOLATED_LEGACY_STORE`，草稿来源只能是`PAGE_DERIVED_CONFIRMED_DRAFT`。页面题直接引用页面观察lane；6条HEADLESS提交题保留Headless生产观察，同时额外使用真实`FULL_PAGE`生成确认草稿，不允许直接把Headless对象交给business。

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

`interaction.userEdits` 支持字段和指定 `itemIndex` 的商品编辑；`userSelections` 支持客户、订单、报价和待收候选。每个选择或编辑必须同时声明`interaction.requiredCapabilities`，包括客户、普通订单、报价、待收、定金订单、主商品、后续商品和普通确认字段编辑。复杂幂等/并发题可用封闭的 `interaction.sequence` 表达 PREPARE、COMMIT、RESTART、事务材料捕获和exact replay等步骤。

Phase 2A最初曾把5条关系题都表达为页面能力题；当前合同已进一步拆分：

| Case | 必要能力 |
| --- | --- |
| `REC-E2E-BASIC-010` | `SELECT_ORDER` |
| `REC-E2E-REL-003` | `SELECT_ORDER` |
| `REC-E2E-REL-009` | `SELECT_CUSTOMER`、`SELECT_ORDER` |

上述订单能力已在完整页实现，Case会继续暴露更早或更后的真实差异。`REL-007/008`已改为
危险关系注入题，不再声明`SELECT_QUOTATION`；未来合法报价picker必须由新Case覆盖。
Runner发现真正缺失的合同页面能力时仍产生`CASE_FAIL/SURFACE_ERROR`，不得伪造事件、
直接改对象、记为Runner错误或Expected Fail。

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

## 11. 生产观察、隔离执行与 State Diff

旧`expected.save`只保留“完成全部合法交互后的正确业务动作与业务结果”：

```text
FORMAL_COMMITTED
PENDING_COMMITTED
BLOCKED
NO_RECORD
```

它不再包含`productionCommitEligible`或`commitTarget`，也不表示页面实际保存、生产正式Commit或真实AI Commit。

`expected.productionObservation`独立表达Provider分类、生产资格、页面是否允许正式保存和完整生产Preflight阻断码。Fake/Replay的阻断码必须包含真实代码`UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION`；如同时存在业务阻断，必须保留两类码的完整并集。`expected.preflight.domainCanSaveFormal`继续是Provider无关的业务安全结论。

`expected.isolatedExecution`独立表达是否启用、TEST_ONLY状态、草稿来源、观察lane、隔离目标和State Diff引用。正式隔离提交必须同时满足：真实观察层已形成确认草稿、全部交互已通过对应真实方法、业务Preflight允许、候选已选择、无跨客户/金额冲突/超额/无效目标/NO_RECORD/AI失败或危险不确定结果。唯一允许绕开的只能是测试身份或非真实Provider生产资格。

规则：

- FORMAL_COMMITTED 必须由 `SAVE_FORMAL` 且 `domainCanSaveFormal=true` 产生，并具有正式业务 Diff；
- PENDING_COMMITTED 必须由用户明确 `SAVE_PENDING` 产生，只允许 pendingNotes 及合同允许的日志变化；
- BLOCKED 和 NO_RECORD 必须零业务副作用；
- 正式隔离执行状态只能是`TEST_ONLY_ISOLATED_COMMITTED`；
- 待整理隔离执行状态只能是`TEST_ONLY_PENDING_COMMITTED`；
- 业务安全阻断不得借TEST_ONLY层写正式业务。

`expected.stateDiff.business/full` 通过 collection count、fieldAssertions、relationAssertions 和 mustRemainUnchanged 描述结果。`fieldAssertions` 的封闭字段为 `collection/change/path/assert/value`；除 `ABSENT` 外必须给出 `value`，而 `ABSENT` 禁止带 `value`。`relationAssertions` 的封闭字段为 `fromCollection/fromPath/toCollection/toId`。省略 `toId` 只表示目标集合在本次 Diff 中恰好创建了一条记录；如果目标不唯一，题目必须给出 `toId`，不得由 Runner 猜测。公共集合覆盖 customers、quotations、orders、receivables、payments、todos、pendingNotes、productCatalog、operationLogs、aiParseLogs，并可扩展到合同枚举中的兼容集合。

P0 至少有一项最终 State 断言或完整零副作用断言。金额、关系、`originalText`、`items[]` 不能只靠记录数量间接判断。

## 12. 多商品

多商品题至少两件，并逐项断言名称、数量、单位、单价；信息缺失必须显式进入 Confirmation missing/conflict。State Diff 必须包含 `items[1]` 及后续商品和 `originalText`。

首页 `REC-E2E-PAGE-008` 是单商品 `items[0]` 同步 P0 候选：人工修改后的顶层字段和 `items[0]` 必须同步，金额按新值计算，旧 item 不得保存。`knownRisk` 仅记录静态证据，不改变 expected、不豁免失败。本阶段不修复产品代码。

## 13. 重启、幂等与并发

`expected.restart` 增加明确`attempts`，表达重启次数、重启后指纹、记录数和必须存在的记录。`expected.idempotency` 表达：

- SAME_PLAN_RETRY；
- DISTINCT_ACTIONS_MUST_NOT_DEDUP；
- SAME_BASE_CONCURRENT_COMMITS；
- DOUBLE_UI_TRIGGER。

`REC-E2E-PERSIST-003`固定为`TRANSACTION_EXACT_REPLAY`：第一次由观察草稿进入TEST_ONLY Legacy隔离提交；随后捕获完全相同的transactionId、planId、planHash、idempotencyKey、base/target revision、base fingerprint和目标Bundle fingerprint，并在事务层原样重放。第二次必须返回`ALREADY_COMMITTED`，revision、业务记录和receipt数量增量均为0，receipt语义与第一次相同。页面保存入口只能调用一次，不能用第二次页面点击、重新生成transaction或STALE结果模拟幂等。

`REC-E2E-PERSIST-004`由`CONCURRENT_BASE_REVISION`表达两个actor读取同一base、A成功、B返回`REVISION_MISMATCH`且不能覆盖A。`REC-E2E-FIN-014`由`PAGE_DUPLICATE_TRIGGER_GUARD`约束同一次用户动作/同一plan的点击风暴：第二次触发必须在再次进入保存handler和事务前被抑制，因此只有一个`COMMITTED`，不能伪称事务`ALREADY_COMMITTED`。两个独立金融确认是否应去重仍由`REC-DECISION-008`保留为产品待办。

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
node scripts/validate-record-e2e-corpus.js --contract-self-test
```

在本项目当前受控环境中也可使用微信开发者工具内置 Electron 的 Node 模式运行。它检查：

- JSON、实际 Schema 子集、必填字段、封闭枚举、fixture 继承/引用和 caseId 唯一性；
- 固定时钟、时区投影和明确 ISO 日期；
- Result 标准字段层、Route、AI profile、Preflight、Surface、业务Save与Diff的交叉关系；
- 九类execution lane、生产观察/隔离执行/危险关系注入分离、requiredCapability映射、restart/exact replay/concurrent双向合同；
- Sequence、fieldAssertions、relationAssertions 的封闭结构和引用对象；
- P0 零副作用、多候选、Fake/Replay 隔离；
- 多商品第二件、金融超额和关系安全；
- 隐私、密钥、allowances、knownRisk；
- 原文重复、疑似仅换数字重复、分类和风险配额；
- Fake/Replay生产资格、业务安全不可绕过、exact replay同一身份、页面能力分类和危险关系注入的22个合同哨兵；
- ACTIVE、PAGE_E2E、REAL_QWEN_QUALITY、输入渠道、路由、保存、lane、能力和fixtures的覆盖统计。

校验只输出控制台统计，不生成或提交运行报告。

未来Runner的每个`laneResults[]`至少包含：

```text
lane
executionState
status
failureStage
failureCode
assertions
evidence
```

`status`只能是PASS、CASE_FAIL、RUNNER_ERROR、BLOCKED。所有要求lane均符合Expected才是Case PASS；真实执行后产品事实不符是CASE_FAIL；Runner不会调用生产中已有能力才是RUNNER_ERROR；合同或fixture不足才是BLOCKED。若页面lane已因产品缺失能力产生CASE_FAIL，依赖草稿的后续lane使用`NOT_EXECUTED_UPSTREAM_CASE_FAIL`，零Diff且不调用保存；该依赖未执行不再额外记RUNNER_ERROR或BLOCKED，Case总结果仍是最早的CASE_FAIL。

## 18. Phase 2 消费约定

Phase 2 Runner 应：

1. 按 caseId 单题加载；
2. 解析 fixture 继承并应用受控 overrides；
3. 注入固定 clock、MemoryStore 和选择/编辑动作；
4. 根据 `ai.profile` 使用本地、Fake 或 Replay；
5. 分别执行页面或Headless生产观察，不混写结果；
6. 只有业务安全允许时，才将观察层草稿交给Legacy business、Release A Coordinator和隔离Store，并标记TEST_ONLY；
7. exact replay只在事务层原样重放，restart和concurrent使用各自lane；
8. 分层比较result、route、preflight、confirmation、productionObservation、isolatedExecution、stateDiff和事务断言；
9. 输出每lane的status/failureStage/failureCode/assertions/evidence，不修改expected；
10. 永远不访问真实业务 key。

页面选择器、点击坐标和截图路径属于 Driver，不写入 Case；真实模型重复次数、成本和稳定性属于质量 Runner，不与确定性代码回归混算。

## 19. Phase 2A 迁移基线

120条ACTIVE题的执行边界分布为：

| lane | Case数 |
| --- | ---: |
| PAGE_PRODUCTION_OBSERVATION | 110 |
| HEADLESS_PRODUCTION_OBSERVATION | 10 |
| PAGE_CONFIRMED_DRAFT_DERIVATION | 6 |
| TEST_ONLY_ISOLATED_LEGACY_COMMIT | 89 |
| PAGE_DUPLICATE_TRIGGER_GUARD | 1 |
| RELATION_REFERENCE_TAMPER_GUARD | 2 |
| TRANSACTION_EXACT_REPLAY | 1 |
| RESTART_PERSISTENCE | 5 |
| CONCURRENT_BASE_REVISION | 1 |

79条正式业务语义题与10条待整理题允许TEST_ONLY隔离执行；29条BLOCKED与2条NO_RECORD题禁止隔离提交。受保护的`riskLevel/result/route/routing/preflight/confirmation/surface/save action+status/stateDiff`迁移前后指纹保持一致。本阶段没有实现Runner、修改产品代码或形成任何运行通过结论。

## 20. 危险关系注入与报价候选

`RELATION_REFERENCE_TAMPER_GUARD`只用于合同明确的合成异常关系。它必须声明
`EXPLICIT_SECURITY_TEST_DRAFT`、唯一注入路径和ID；Runner只能改变该路径，然后调用
真实Domain Preflight。它不得调用页面选择方法、business或保存入口，必须期待正式阻断、
危险ID不在安全候选中且正式State Diff为0。

危险ID不得同时出现在`userSelections`或`requiredCapabilities=SELECT_QUOTATION`。
REL-007/008分别注入跨客户和已转订单报价；原P0阻断Expected保持不变，但不再代表合法
报价picker能力。

报价安全候选只来自Domain Preflight最新State输出。AI fixture中的
`quotation_candidates`不能建立用户可选身份，Shared Confirmation只能投影Preflight，
不能自行筛选或因候选数量自动要求选择。当前120题中合法`SELECT_QUOTATION`用户选择题
为0，后续页面阶段必须另建合法选择Case。
