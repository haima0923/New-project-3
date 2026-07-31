# 货小玲项目文档索引

本文件用于新开 Codex 对话时快速建立项目上下文。Codex 应先读本文件，再根据任务读取对应文档。

> 当前VOICE-006 Surface/Provider分层合同候选分支：
> `fix/record-voice-006-surface-contract-v1`。E2E V1.2 已把
> raw parser、semantic result、proposal 和最终 outcome 分层；pending只表示最终
> disposition，不再覆盖推测业务类型。当前120题双轮为：
> `PASS=16 / CASE_FAIL=104 / RUNNER_ERROR=0 / BLOCKED=0`；63条P0失败全部单题重跑，
> P1分层抽查11条，26个Cluster覆盖104条失败；Hybrid/Raw parser调用图两轮一致，
> evidence missing/orphan/uncorrelated/shadow均为0。网络/真实Storage/fixture/Worker/
> 事务清理门禁均通过。`BASIC-010`的“这单”现在产生可信、未解析且不含orderId的结构化
> 订单指代Evidence，并沿raw parser、Hybrid、Confirmation和Preflight输入完整透传；
> Domain Preflight现在要求BASIC-010在真实`changeOrder()`确认合法订单前不得正式保存；
> `BASIC-009`的“那批货”不被误标为明确订单关系。日期、数量、次数、笔数、非金融“收到”与真实第二订单动作均有
> 强负例门禁。`BASIC-006`的明确报价请求现在会记录独立报价Evidence及“还没下单”的
> 订单否定Evidence，raw/semantic为quotation/create_quotation；纯“还没下单”不会
> 凭空创建报价，否定报价及“报废/报告”不会误造quotation，双重否定和后续明确下单也不会
> 被前一段否定吞掉。孤立汉字“出”现在不再提供order分数；普通“出去/出门/出差”及商业
> 非订单“报价出了吗/货款打出去了/出库”不创建订单，明确下单、订单实体和具备完整业务
> 事实的“周五出”交付简写仍保留。AMB-005现在由真实生产Route返回canonical NO_RECORD；
> FULL/HOME隐藏正式、pending和Deep入口，页面handler及business直接调用均fail closed，
> NO_RECORD正式和pending写入均为0；业务不完整、语音未完成和多轮局部结果仍保持PENDING。
> 语音最终完成现在由Provider final callback产生session绑定、sequence绑定和转写指纹绑定的
> 结构化Evidence；FULL/HOME复用同一helper并机械透传到parseHybridInput与Route输入Trace。
> partial、取消、失败、超时、旧session和手工编辑均不能保留有效final Evidence。Route现在
> 只在可信final、结构化业务Evidence充分、intent未决且无金融/冲突/Deep风险时进入一次
> AI_STANDARD。VOICE-004已从PENDING/AI0推进到AI_STANDARD/AI1；其原文没有交期，
> 测试合同现明确期待`MISSING_REQUIRED_FIELD`安全阻断、DO_NOT_SAVE、零持久化及零业务
> Diff，因此完整分层结果为PASS。`orderDeliveryDate` Expected与运行时`dueDate`由
> 测试基础设施精确别名合同比较。VOICE-006现在按Surface业务能力与生产Provider资格
> 分层：FULL_PAGE能力完整，但Fake Provider生产资格被阻断；生产写入为0，隔离提交仍
> 验证客户和订单各增加1，因此Case为PASS。VOICE-010原有Surface问题保持可见。
> 当前已确认本地Parser缺陷数量为0。所有回归现在由默认离线、显式白名单且fail-closed的进程预加载门禁运行；
> Live AI smoke要求CLI和环境双重授权，最终全量统一入口控制台审计的network attempt为0。
> 该计数已进入全量JSON硬门禁。误触审计不能证明远端绝对未收到旧请求；可以确认应用未收到
> HTTP status、response headers、response body或真实AI结果，且未发现真实数据、密钥或
> 认证头被请求携带的证据。本阶段未修改parser、AI Normalizer、Storage/Coordinator核心
> 或生产业务安全政策；本阶段只修改Corpus Validator的Surface/Provider分层校验、
> VOICE-006两项Surface Expected、Runner机械哨兵和相关文档，没有改动Voice glue、
> Route、AI fixture/Normalizer、Preflight、页面、business、Storage、Runner等待或
> Completion Evidence Schema。
> 状态为 **HEADLESS NODE PAGE-METHOD RUNNER / 120-CASE DETERMINISTIC BASELINE /
> NOT WX WXML E2E / REAL QWEN NOT CALLED / NOT RELEASE**。

## 1. 新对话必读

每次新开 Codex 对话，建议先读取：

```text
AGENTS.md
docs/DOC_INDEX.md
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/CODEX_DAILY_PLAYBOOK.md
```

用途：

- 明确货小玲是什么。
- 明确不能做什么。
- 明确多 Agent 怎么协作。
- 明确不懂编程的用户如何和 Codex 协作。

## 2. 核心规则文档

| 文件 | 用途 | 谁主要使用 |
| --- | --- | --- |
| `AGENTS.md` | 项目最高规则、产品定位、高风险限制 | Codex / 所有 Agent |
| `docs/MULTI_AGENT_OPERATING_GUIDE.md` | 多 Agent 操作方法、模板、边界 | 用户 / Codex |
| `docs/AGENT_WORKFLOW.md` | Agent 角色职责和协作流程 | Codex |
| `docs/CODEX_DAILY_PLAYBOOK.md` | 日常操作手册 | 用户 |
| `docs/PRODUCT_RULES.md` | 产品定位、什么能做、什么不能做 | 产品规则 Agent |
| `docs/BUG_TEMPLATE.md` | Bug 反馈模板 | 用户 |

## 3. 代码和业务理解文档

| 文件 | 用途 |
| --- | --- |
| `docs/CODE_MAP.md` | 项目结构、页面、utils、后端、测试、高风险文件 |
| `docs/PRODUCT_AUDIT.md` | 产品定位、品牌、文案、UI 风险盘点 |
| `docs/XIAOLING_CHARACTER_GUIDE.md` | 小玲角色母版、固定特征、生成流程和验收标准 |
| `docs/RECORD_SHARED_CORE_CONTRACT.md` | 记一笔共享核心输入、模式、AI adapter、状态、trace、确认态、savePlan 和适配边界的权威合同 |
| `docs/RECORD_TEST_CONTRACT_V1.md` | 第一阶段测试题、fixture、五层评分、零容忍门禁、报告和 canary 的权威合同 |
| `docs/RECORD_E2E_CASE_CONTRACT_V1.md` | E2E Case V1.1统一Schema、固定时钟、匿名fixtures、生产观察/TEST_ONLY隔离执行、事务exact replay、State Diff和Runner消费合同 |
| `docs/RECORD_E2E_RUNNER_KERNEL_V1.md` | 独立Worker、真实页面JS方法、Surface/action注册表、Fake wx/network/voice、隔离Legacy提交、Lane、Evidence和假绿自测 |
| `docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md` | 120题双轮确定性结果及SELECT_ORDER、报价候选真值源修订后的重基线、Ownership、当前Cluster、P0重跑和隔离门禁 |
| `docs/RECORD_SELECT_ORDER_SURFACE_V1.md` | 完整页通用订单候选、选择/取消/改选、Preflight复核、安全边界和目标Case证据 |
| `docs/RECORD_QUOTATION_CANDIDATE_SOURCE_V1.md` | Domain Preflight安全报价候选真值源、危险引用分离、REL-007/008专用Lane及后续合法picker题边界 |
| `docs/RECORD_SELECT_QUOTATION_SURFACE_V1.md` | 完整页只消费Preflight安全报价候选、选择/取消/改选、保存前复核及两条合法补充E2E题 |
| `docs/RECORD_HOME_PRIMARY_ITEM_SYNC_V1.md` | 首页单商品以items[0]为业务核心、顶层投影原子同步、金额规则、多商品保护和PAGE-008证据边界 |
| `docs/RECORD_E2E_OBSERVATION_SEMANTICS_V1.md` | Hybrid/Raw parser调用图、raw parser状态、semantic result、proposal、outcome四层合同，25条迁移和保护Case证据 |
| `docs/RECORD_PARSER_PAYMENT_INTENT_V1.md` | 明确已收款本地parser证据、待收/定金/订单/非金融负例边界及BASIC-012、PAGE-003重基线 |
| `docs/RECORD_PARSER_QUOTATION_NEGATION_V1.md` | 明确报价与订单否定的组合证据、否定范围、重新肯定保护及BASIC-006重基线 |
| `docs/RECORD_PARSER_ORDER_SIGNAL_BOUNDARY_V1.md` | 单字“出”订单误触发、短语级Evidence、商业非订单与多商品交付保护及AMB-005重基线 |
| `docs/RECORD_NO_RECORD_ROUTE_POLICY_V1.md` | Clear Non-Business canonical NO_RECORD资格、页面与business持久化硬门禁、合法PENDING及异步保护 |
| `docs/RECORD_VOICE_COMPLETION_EVIDENCE_V1.md` | Provider final callback、session/转写指纹绑定、FULL/HOME机械透传及非语音渠道保护 |
| `docs/RECORD_VOICE_STANDARD_ROUTE_V1.md` | 可信语音终稿、充分业务Evidence和intent未决的窄AI_STANDARD资格、单次AI及保护边界 |
| `docs/RECORD_ORDER_REFERENCE_EVIDENCE_V1.md` | 明确订单指代的结构化Evidence、语言边界、State独立性及raw→Preflight透传合同 |
| `docs/RECORD_RECEIVABLE_ROUTE_POLICY_V1.md` | Safe Local待收款Route、复杂待收款PENDING和订单关系与Route分离政策 |
| `docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md` | 明确订单指代待收款的选择前阻断、真实选择、最新State复核和危险关系边界 |
| `docs/RECORD_OFFLINE_TEST_SAFETY_V1.md` | AI smoke误触审计、默认离线、Live双开关、进程预加载网络门禁、密钥剥离和回归白名单 |
| `docs/RECORD_WX_STORAGE_RUNTIME_TEST_PLAYBOOK.md` | Phase 1E.2A.2 微信开发者工具隔离 Storage 事务验证步骤、恢复顺序和清理规则 |
| `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` | Phase 1E.2B.1 共享保存受控切换、资格、回退、Recovery Lock、监测和 Release A/B/C 计划；不代表生产已开启 |
| `docs/RECORD_RELEASE_A_RC1_CHECKLIST.md` | Release A RC1 的23个Legacy writer、启动恢复、事务失败、旧Bundle升级、回滚兼容和人工发布评审清单；尚未上传或发布 |
| `docs/PARSER_AI_AUDIT.md` | 记一笔 parser / AI 链路审计 |
| `docs/BUSINESS_FLOW_AUDIT.md` | 报价、订单、待收款、收款、定金、催款业务流转 |
| `docs/TEST_AUDIT.md` | 当前测试能力、可运行脚本、缺口和回归建议 |
| `docs/CONFIG_RELEASE_AUDIT.md` | app.js、app.json、小程序发布配置风险 |
| `docs/RECORD_CONFIRM_CARD_SPEC.md` | 记一笔确认卡字段标准和多商品阶段规则 |
| `docs/RELEASE_TEST_SYSTEM_V2.md` | 当前测试证据边界、P0 状态和后续发布门禁 |
| `docs/体验版真机测试清单.md` | 体验版人工验收步骤；Node P0 已验证，但仍不能代替微信运行时发布批准 |

权威关系：

- `AGENTS.md` 是项目和产品最高规则。
- `docs/RECORD_CONFIRM_CARD_SPEC.md` 管用户可见字段和确认卡产品语义。
- `docs/RECORD_SHARED_CORE_CONTRACT.md` 管共享核心的接口和平台边界。
- `docs/RECORD_TEST_CONTRACT_V1.md` 管第一阶段自动测试、评分和报告。
- `docs/RECORD_E2E_CASE_CONTRACT_V1.md` 管 120 条核心题的机器结构和跨 Runner 复用边界；PAGE、HEADLESS、TEST_ONLY隔离提交和事务exact replay必须分lane判分。
- `docs/RECORD_E2E_RUNNER_KERNEL_V1.md` 管Headless执行内核；`docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md`管120题双轮结果；`docs/RECORD_E2E_OBSERVATION_SEMANTICS_V1.md`管raw/semantic/proposal/outcome分层；`docs/RECORD_PARSER_PAYMENT_INTENT_V1.md`管明确已收款parser与负例边界；`docs/RECORD_PARSER_QUOTATION_NEGATION_V1.md`管报价正向Evidence、订单否定范围与重新肯定保护；`docs/RECORD_PARSER_ORDER_SIGNAL_BOUNDARY_V1.md`管单字“出”的订单信号边界与短语级Evidence；`docs/RECORD_NO_RECORD_ROUTE_POLICY_V1.md`管Clear Non-Business canonical Route及零持久化门禁；`docs/RECORD_VOICE_COMPLETION_EVIDENCE_V1.md`管语音Provider最终回调、session/指纹绑定及FULL/HOME透传；`docs/RECORD_VOICE_STANDARD_ROUTE_V1.md`管可信终稿、充分结构化业务Evidence和intent未决的窄AI_STANDARD资格；`docs/RECORD_ORDER_REFERENCE_EVIDENCE_V1.md`管明确订单指代的parser Evidence与机械透传；`docs/RECORD_RECEIVABLE_ROUTE_POLICY_V1.md`管Safe Local待收款Route；`docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md`管明确订单指代待收款的Preflight门禁；`docs/RECORD_OFFLINE_TEST_SAFETY_V1.md`管默认离线、Live授权和进程级网络门禁；`docs/RECORD_SELECT_ORDER_SURFACE_V1.md`管完整页订单选择；`docs/RECORD_QUOTATION_CANDIDATE_SOURCE_V1.md`管安全报价候选与危险引用；`docs/RECORD_SELECT_QUOTATION_SURFACE_V1.md`管完整页报价选择；`docs/RECORD_HOME_PRIMARY_ITEM_SYNC_V1.md`管首页单商品编辑同步与保存前一致性门禁。它们都不代表WXML/DOM页面E2E或真实千问质量。
- `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` 管共享保存切换控制与发布顺序；它从属于共享核心安全合同，不能覆盖生产固定 `LEGACY_ONLY` 或自行批准 canary。
- `docs/RECORD_RELEASE_A_RC1_CHECKLIST.md` 管 Release A 候选证据和发布前人工检查；它不构成上传、发布或开启 Shared 的授权。
- `PARSER_AI_AUDIT.md`、`BUSINESS_FLOW_AUDIT.md`、`TEST_AUDIT.md` 是代码事实审计；
  审计中的历史结论不覆盖较新的合同和当前代码。
- 合同尚未实现。合同描述的目标能力不能写成当前已上线能力。

## 4. 后端 / 数据 / 部署文档

| 文件 | 用途 |
| --- | --- |
| `docs/api-contract.md` | API 合同说明 |
| `docs/database-schema.sql` | 数据库 schema 参考 |
| `docs/deployment.md` | 部署说明 |

这些不是多 Agent 操作核心文档，但涉及后端、数据库或部署时需要读取。

## 5. 历史测试报告

以下文件是历史报告，不是核心规则文档：

```text
docs/local-parse-safety-acceptance-report.*
docs/wechat-local-rules-evaluation.*
docs/wechat-local-rules-hard-evaluation.*
docs/wechat-local-rules-ultra-evaluation.*
```

注意：

- 历史报告不一定代表当前代码。
- 自动生成报告不进入 Git 源代码候选快照；需要时由固定提交重新生成。
- 运行相关测试脚本可能会重新生成报告文件。
- 如果本轮不希望修改报告文件，不要运行会写报告的脚本。

## 6. 按任务类型读取哪些文档

### 6.1 记一笔 / 确认卡任务

必读：

```text
AGENTS.md
docs/DOC_INDEX.md
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/RECORD_CONFIRM_CARD_SPEC.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
docs/RECORD_E2E_CASE_CONTRACT_V1.md
docs/RECORD_E2E_RUNNER_KERNEL_V1.md
docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md
docs/PARSER_AI_AUDIT.md
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RELEASE_TEST_SYSTEM_V2.md
```

重点检查：

- 输入。
- 识别。
- 确认卡。
- 保存。
- 记录页。
- 详情页。
- 问一句。
- 测试。

### 6.2 Parser / AI 识别任务

必读：

```text
docs/PARSER_AI_AUDIT.md
docs/RECORD_CONFIRM_CARD_SPEC.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
docs/RECORD_E2E_CASE_CONTRACT_V1.md
docs/RECORD_E2E_RUNNER_KERNEL_V1.md
docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
```

高风险文件：

```text
utils/parser.js
utils/ai-parser.js
utils/parse-safety.js
utils/text-normalize.js
server/
promptfoo/
scripts/
```

### 6.3 业务流转任务

必读：

```text
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
```

适用问题：

- 报价转订单。
- 订单生成待收款。
- 收款核销。
- 部分收款。
- 订单定金。
- 催款提醒。
- 客户合并。

### 6.4 UI / 文案 / 页面体验任务

必读：

```text
docs/PRODUCT_RULES.md
docs/PRODUCT_AUDIT.md
docs/CODE_MAP.md
docs/RECORD_CONFIRM_CARD_SPEC.md（涉及记一笔确认卡时）
docs/RECORD_SHARED_CORE_CONTRACT.md（涉及记一笔页面判断时）
docs/RECORD_TEST_CONTRACT_V1.md（涉及记一笔页面验收时）
docs/XIAOLING_CHARACTER_GUIDE.md（涉及小玲形象时）
```

重点：

- 是否老板看得懂。
- 是否变成后台系统。
- 是否有假数据。
- 是否遗漏记录页、详情页等用户链路页面。

### 6.5 测试 / 回归任务

必读：

```text
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
```

注意：

- 旧审计用于了解当前和历史事实；新共享核心/测试实现与验收以两份合同为准。
- 部分测试会生成报告文件。
- 如果本轮不允许修改 docs/reports/temp，不要运行生成报告的脚本。

### 6.6 配置 / 发布 / 小程序权限任务

必读：

```text
docs/CONFIG_RELEASE_AUDIT.md
docs/deployment.md
```

高风险文件：

```text
app.js
app.json
project.config.json
project.private.config.json
sitemap.json
custom-tab-bar/
```

## 7. 当前重要项目快照

详细见：

```text
docs/PROJECT_CONTEXT_SNAPSHOT.md
```

该文件记录近期完成的工作、分支状态、确认卡改造边界和下一阶段建议。
