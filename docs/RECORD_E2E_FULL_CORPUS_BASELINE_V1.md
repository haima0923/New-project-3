# 记一笔确定性全量基线 V1

## 最新增量基线：Payment Kind Balance Classification（2026-07-31）

在冻结基线`fed80c859d27d6b7b17877deb836643e7abdddcb`上，待收款收款类型改为按
保存时剩余余额派生。FIN-001/013/014从`SURFACE_ERROR`转为PASS；BASIC-011和
VOICE-010继续PASS并新增`partial_payment`强断言。双轮实际结果：

```text
ACTIVE        120
Executed      120
PASS           25
CASE_FAIL      95
RUNNER_ERROR    0
BLOCKED         0
SURFACE_ERROR   0
```

相对冻结基线`22/98`，仅FIN-001/013/014顶层状态与最早失败层改变；120题Route无变化，
业务Diff只在审定的FIN-001/013/014、BASIC-011和VOICE-010发生。双轮稳定，54条P0失败
全部单题重跑，P1分层抽查11条；隔离Legacy提交Lane总数保持88。

每轮网络、真实微信/宿主Storage、Fixture mutation、跨Case泄漏、Parser Evidence、
orphan/uncorrelated/shadow invocation、Voice、Journal/Backup门禁均为0。新增的
`duplicatePaymentCommitCount`、`paymentKindBalanceMismatchCount`和
`overpaymentCommitCount`也进入全量硬门禁并为0。详细合同见
`docs/RECORD_PAYMENT_KIND_POLICY_V1.md`。

旧`shared-core-phase1a`专项在当前工作区与冻结HEAD均稳定为22通过/4个既有失败，内容为
历史AI合并/低置信字段和冻结指纹差异；本轮未修改该套件或相关AI逻辑。Shared SavePlan、
CAS、exact replay、stale plan和回滚专项均通过。

## 1. 结论与边界

E2E Phase 2B.2-R1 在 Headless Runner Kernel V1 上，从清洁的独立 Worker 环境重新执行
120 条 ACTIVE Case 两轮。Observation Semantics V1 完成后，最终两轮结果完全一致：

```text
ACTIVE       120
Executed     120
PASS          10
CASE_FAIL    110
RUNNER_ERROR   0
BLOCKED        0
```

这是 Local/Fake/Replay 的确定性基线，不是真实千问质量测试，不是微信 WXML/DOM 页面
E2E，也不构成产品发布结论。`CASE_FAIL` 只表示 Actual 与人工合同 Expected 不一致；
其中只有证据充分的项目才标为确认产品问题，其余保持候选或待人工判责。

原始 Phase 2B.2-R1 基线没有修改生产代码。后续 `SELECT_ORDER` Cluster Fix只修改
完整输入页的订单候选交互；报价候选真值源阶段只修改Domain Preflight安全候选投影、
Shared Confirmation投影和E2E危险引用合同；随后完整页只消费该安全投影实现报价
选择、取消、改选和保存前复核。首页主商品同步阶段只修改首页单商品人工编辑、保存前
一致性门禁和Runner逐步Evidence。parser、AI、Domain Preflight政策、business、Storage、
Coordinator和120条题的业务正确Expected仍未修改。

Observation Semantics V1 进一步只修改测试合同和 Runner，将 raw parser、
semanticResult、proposal 与 outcome 分开。原始 `PASS=4/CASE_FAIL=116` 作为迁移前
历史基线保留；当前 `PASS=10/CASE_FAIL=110` 的变化来自25条观测映射迁移，不包含
parser或产品代码修复。

## 2. 跨页面动作注册表

上一轮全量第 1 轮因 `REC-E2E-BASIC-019` 错把首页待整理保存固定调用为完整页
`savePending()` 而作废。R1 不按 Case ID 特判，而是建立集中注册表，并同时用真实 Page
方法探测：

| Surface | editMode | Action | 真实 Page 方法 | 当前 Corpus 动态覆盖 |
| --- | --- | --- | --- | --- |
| `HOME_QUICK` | `CREATE` | `SAVE_FORMAL` | `confirmQuickSave` | 有，TEST_ONLY 正式语义由独立隔离 Lane 执行 |
| `HOME_QUICK` | `CREATE` | `SAVE_PENDING` | `savePendingFromConfirm` | 有 |
| `FULL_PAGE` | `CREATE` | `SAVE_FORMAL` | `saveFormal` | 有 |
| `FULL_PAGE` | `CREATE` | `SAVE_PENDING` | `savePending` | 有 |
| `FULL_PAGE` | `PENDING_EDIT` | `SAVE_FORMAL` | `saveFormal` | 合同支持 |
| `FULL_PAGE` | `PENDING_EDIT` | `SAVE_PENDING` | `savePending` | 有 |
| `FULL_PAGE` | `HISTORY_EDIT` | `UPDATE` | `saveFormal` | 注册但当前 ACTIVE Corpus 无题 |

注册表缺项不得 fallback；方法缺失、实际调用方法与解析结果不一致，或调用计数不是一次，
均不能 PASS。产品页面真实缺少合同要求的选择能力时仍为
`CASE_FAIL/SURFACE_ERROR`，不伪造页面方法。

`BASIC-019` 现在动态证明：

- Surface 为 `HOME_QUICK`，动作是 `SAVE_PENDING`；
- 实际解析并调用 `savePendingFromConfirm()` 一次，`savePending()` 调用为零；
- 待整理记录新增一条；
- 客户、报价、订单、待收、收款和提醒正式副作用均为零；
- 网络、Storage、fixture、Worker、Journal/Backup 审计均通过。

该题仍为 `CASE_FAIL/LOCAL_PARSE_ERROR`，原因是解析及合同字段差异，不再是 Driver 错误。

## 3. 全量执行与硬门禁

两轮各自都满足：

```text
Executed = 120
RUNNER_ERROR = 0
BLOCKED = 0
realNetworkRequests = 0
unknownFakeRouteRequests = 0
realWxStorageCalls = 0
hostFilesystemStorageCalls = 0
fixtureMutationCount = 0
crossCaseLeakCount = 0
journalCount = 0
backupCount = 0
```

两轮 Case 集合 fingerprint 相同。确定性比较包含 Case/Lane 状态、实际页面方法、
primary failure、Ownership、Route、Preflight、Confirmation、业务 Diff、Receipt、
revision、Restart 和 Concurrent 语义。PID、Boot ID 和绝对耗时不参与业务判分。

完整脱敏 Evidence 只在显式 `--output` 时写入仓库外临时目录；本次最终重跑未生成
仓库内报告文件，也不能用临时输出替代由固定提交重新运行生成的证据。

## 4. 风险、阶段与 Ownership

风险结果：

| 风险 | PASS | CASE_FAIL | RUNNER_ERROR | BLOCKED |
| --- | ---: | ---: | ---: | ---: |
| P0 | 0 | 65 | 0 | 0 |
| P1 | 10 | 45 | 0 | 0 |

当前十条 PASS 为：

```text
REC-E2E-BASIC-001
REC-E2E-BASIC-004
REC-E2E-BASIC-005
REC-E2E-DATE-001
REC-E2E-DATE-002
REC-E2E-DATE-003
REC-E2E-DATE-008
REC-E2E-DATE-011
REC-E2E-DATE-012
REC-E2E-PAGE-001
```

Primary failure stage：

| Stage | Case数 |
| --- | ---: |
| `AI_NORMALIZE_ERROR` | 23 |
| `LOCAL_PARSE_ERROR` | 9 |
| `PREFLIGHT_ERROR` | 20 |
| `SURFACE_ERROR` | 10 |
| `ROUTE_ERROR` | 43 |
| `STATE_DIFF_ERROR` | 4 |
| `STORAGE_TRANSACTION_ERROR` | 1 |

Ownership：

| Ownership | Case数 | 含义 |
| --- | ---: | --- |
| `CONFIRMED_LOCAL_PARSER_DEFECT` | 3 | 保护的高置信 parser 缺陷 |
| `CONFIRMED_OPERATION_MAPPING_DEFECT` | 1 | `REL-008`报价转订单 operation |
| `CONFIRMED_ROUTE_DEFECT` | 1 | 已确认 Route 缺陷 |
| `EXPECTED_MAPPING_MISMATCH_CANDIDATE` | 1 | State Diff/字段映射候选，未改合同 |
| `OBSERVABILITY_EXPECTATION_MISMATCH` | 4 | 可观测边界候选 |
| `TEST_CONTRACT_MISMATCH_CANDIDATE` | 4 | 执行 Lane 正确但旧统计/超时合同冲突 |
| `UNCLASSIFIED_REQUIRES_REVIEW` | 96 | 证据不足以判产品或测试合同责任 |

Ownership 不改变 Case 状态和 Expected。尤其不得把 94 条未分类差异直接称为产品 Bug，
也不得用“候选”标签自动修改题库。

## 5. Lane 与 Case 结果必须分开

| Lane | PASS | CASE_FAIL | 说明 |
| --- | ---: | ---: | --- |
| `PAGE_PRODUCTION_OBSERVATION` | 11 | 99 | 110 条页面观察全部执行 |
| `HEADLESS_PRODUCTION_OBSERVATION` | 4 | 6 | 10 条 Headless 观察全部执行 |
| `PAGE_CONFIRMED_DRAFT_DERIVATION` | 5 | 1 | `PAGE-008`主商品一致性已通过；`AMB-015`仍有解析/确认差异 |
| `TEST_ONLY_ISOLATED_LEGACY_COMMIT` | 25 | 64 | 89 条合同 Lane 均有明确结果 |
| `PAGE_DUPLICATE_TRIGGER_GUARD` | 1 | 0 | `FIN-014` Lane 通过 |
| `TRANSACTION_EXACT_REPLAY` | 0 | 1 | 事务动作成功，旧 Case 统计断言失败 |
| `RESTART_PERSISTENCE` | 5 | 0 | 五条都由新 Worker 读取成功 |
| `CONCURRENT_BASE_REVISION` | 1 | 0 | A提交/B stale 的 CAS 证据通过 |

Lane 动作成功但 Case 整体因其他 Expected 失败是合法结果，不能把 Case FAIL 错写为
事务、重启、CAS 或重复保护失败。

## 6. 已确认问题

### 6.1 订单选择能力已补齐

完整页已增加由Domain Preflight合法候选驱动的真实订单选择、取消和改选方法，并在选择
及保存前重新验证订单存在性、状态和客户关系。`BASIC-010`、`REL-003`、`REL-009`不再以
`SURFACE_ERROR/REQUIRED_PAGE_CAPABILITY_MISSING`失败；当前分别进入
`LOCAL_PARSE_ERROR`、`AI_NORMALIZE_ERROR`、`AI_NORMALIZE_ERROR`。三个Case的正式业务
Diff仍为零。只有`REL-003`在原始输入链实际到达可见选择控件；另两题因更早差异未调用
隐藏页面方法，Runner如实保留交互失败证据。本阶段没有修改这些上游差异或Expected。

### 6.2 报价危险引用与完整页选择能力

`REL-007`、`REL-008`不是合法报价picker题。两题分别通过专用
`RELATION_REFERENCE_TAMPER_GUARD`注入跨客户和已转报价，再调用真实Domain Preflight；
准确得到`QUOTATION_CUSTOMER_MISMATCH`和`QUOTATION_ALREADY_CONVERTED`，危险ID均不在
安全候选中，不调用页面选择或business保存，正式副作用为零。两个安全Lane均PASS。

Case整体仍因原始页面结果与确认语义不一致而为`CASE_FAIL/AI_NORMALIZE_ERROR`：
`REL-007`最早是`fields.customerId`差异，`REL-008`最早是businessType差异；Ownership保持
`UNCLASSIFIED_REQUIRES_REVIEW`。当前120题中合法`SELECT_QUOTATION`用户选择Case为0；
两条独立补充题已通过同一Runner真实调用完整页`changeQuotation()`，验证安全候选、
取消、改选、危险ID拒绝和草稿关系绑定。两题当前因既有`LOW_CONFIDENCE_FIELD`成为
`CASE_FAIL/PREFLIGHT_ERROR`，不是Surface能力缺失。

### 6.3 首页编辑与 `items[0]` 同步已修复

`PAGE-008` 为一条 P0。真实首页编辑方法现在使顶层字段和`items[0]`逐步保持一致：
商品“帆布袋→保温袋”、数量`100→150`、单价`6→8`，金额按既有规则
`600→900→1200`；`originalText`未变，最终Legacy草稿也使用新值。该题不再以
`CONFIRMATION_ERROR/HOME_PRIMARY_ITEM_NOT_SYNCED`失败，当前最早差异是
`ROUTE_ERROR`；订单交期必填和正式Diff为零均保持。

Preflight仍因订单交期缺失及人工商品没有原文证据而阻断。Runner没有绕过安全规则保存，
正式业务Diff为零、最终保存记录为空。因此已确认页面模型同步修复，但尚未证明该题完成
最终订单保存。详细证据见`docs/RECORD_HOME_PRIMARY_ITEM_SYNC_V1.md`。

## 7. 重点事务 Case

- `PERSIST-003`：首次隔离 Legacy Commit 返回 `COMMITTED` 并产生 Receipt；原样重放
  相同 transaction/plan/hash/base 材料返回 `ALREADY_COMMITTED`；revision、Receipt、
  业务记录均零重复增量，Journal/Backup 为零，Restart Lane 通过。Case 主失败来自旧
  `pageSaveAttempts=1` 与 exact replay 不二次调用页面 handler 的合同冲突，另有
  `operationLogs.createdCount`可观测性次要差异；Ownership 为
  `TEST_CONTRACT_MISMATCH_CANDIDATE`，不是事务幂等失败。
- `PERSIST-004`：A/B 读取同一 base revision/fingerprint；A真实提交并产生 Receipt；
  B继续用旧 base 调用 Coordinator，得到 `LEGACY_SAVE_STALE`，主 Bundle 写入为零，
  A数据保留。Concurrent 与 Restart Lane 均通过；Case 整体只因 `operationLogs` Diff
  映射预期失败，Ownership 为 `EXPECTED_MAPPING_MISMATCH_CANDIDATE`，不是 CAS 失败。
- `FIN-014`：FULL_PAGE `saveFormal` 真实调用两次；页面 handler=2、Legacy business=1、
  transaction begin=1、committed Receipt=1、最终金融记录=1。Duplicate Lane 通过；
  Case 整体仍有 Surface、payment kind 和 operationLogs 合同差异，Ownership 为
  `TEST_CONTRACT_MISMATCH_CANDIDATE`。

## 8. 失败 Cluster

原始Phase 2B.2-R1的39个Cluster如下，完整覆盖116条CASE_FAIL，且每条只进入一个主
Cluster。该表保留为修复前证据，不再代表当前页面能力：

| Cluster | Case数 | 风险 | Stage | Ownership |
| --- | ---: | --- | --- | --- |
| 页面缺少必要交互能力：SELECT_ORDER | 3 | P0 | SURFACE_ERROR | CONFIRMED_PRODUCT_CAPABILITY_GAP |
| 页面缺少必要交互能力：SELECT_QUOTATION | 2 | P0 | SURFACE_ERROR | CONFIRMED_PRODUCT_CAPABILITY_GAP |
| 首页顶层编辑与items[0]不同步 | 1 | P0 | CONFIRMATION_ERROR | CONFIRMED_CONFIRMATION_DEFECT |
| 安全预检差异：domainCanSaveFormal | 12 | P0 | PREFLIGHT_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / businessType | 12 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 未分类Surface status差异 | 8 | P0 | SURFACE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_STANDARD / businessType | 7 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / originalText | 6 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 生产路由差异：PENDING / route | 6 | P0 | ROUTE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：pending / businessType | 5 | P0 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 安全预检差异：blockingCodes | 3 | P0 | PREFLIGHT_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / operation | 3 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 安全预检差异：requiredFields.receivableId.modeled | 2 | P0 | PREFLIGHT_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.receivableId | 2 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 可观测集合预期差异：operationLogs | 2 | P0 | STATE_DIFF_ERROR | OBSERVABILITY_EXPECTATION_MISMATCH |
| Fake/Replay标准化差异：REPLAY / fields.orderId | 1 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：receivable / operation | 1 | P0 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 隔离提交operationLogs映射预期差异 | 1 | P0 | STATE_DIFF_ERROR | EXPECTED_MAPPING_MISMATCH_CANDIDATE |
| 安全预检差异：productionEligibility | 1 | P0 | PREFLIGHT_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.paymentDate | 1 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| FIN-014 Surface统计合同冲突 | 1 | P0 | SURFACE_ERROR | TEST_CONTRACT_MISMATCH_CANDIDATE |
| Fake/Replay标准化差异：FAKE_DEEP / fields.statedAmount | 1 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.remainingBeforePayment | 1 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.conflictingDirection | 1 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Exact replay旧页面保存计数合同冲突 | 1 | P0 | STORAGE_TRANSACTION_ERROR | TEST_CONTRACT_MISMATCH_CANDIDATE |
| 本地解析字段差异：order / operation | 9 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 生产路由差异：LOCAL / route | 6 | P1 | ROUTE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：todo / businessType | 2 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_STANDARD / originalText | 2 | P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：REPLAY / originalText | 2 | P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：todo / operation | 2 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：quotation / operation | 2 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：unknown / operation | 1 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.productName | 1 | P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：unknown / businessType | 1 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：quotation / businessType | 1 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：order / fields.quantity | 1 | P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.explicitNewRecord | 1 | P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / items.length | 1 | P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |

首页主商品同步阶段重新生成37个当前Cluster，仍覆盖116/116。首页顶层与`items[0]`
不同步Cluster已移除；`PAGE-008`现在进入本地解析operation差异。其余主要Cluster包括：

| 当前Cluster | Case数 | 风险 | Stage | Ownership |
| --- | ---: | --- | --- | --- |
| Fake/Replay标准化差异：FAKE_DEEP / businessType（含REL-008） | 13 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：receivable / businessType | 1 | P0 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| 本地解析字段差异：order / operation（含PAGE-008） | 10 | P0/P1 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / items.length | 4 | P0/P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.customerId（含REL-007） | 3 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |

其中`BASIC-010`、`REL-003`和`REL-009`分别位于receivable/businessType、
items.length和fields.customerId组。这表示真实订单选择入口已存在，但Case继续暴露更早
的上游差异；它不授权把这些差异自动归为产品Bug。

## 9. 重跑与回归

- 65 条 `P0 + CASE_FAIL` 全部逐条单题重跑，语义 fingerprint 与全量一致。
- P1 按 failure stage、Ownership 和业务分类分层选择 13 条，全部一致：
  `AMB-005`、`AMB-008`、`AMB-011`、`BASIC-002`、`BASIC-019`、
  `CHAT-001`、`CHAT-002`、`DATE-004`、`PAGE-005`、`REL-001`、`VOICE-001`、
  `VOICE-004`、`VOICE-006`。
- Corpus Validator 与执行边界合同自测为 120 题通过、32/32；报价候选专项22/22，
  报价选择Surface专项23/23；首页主商品同步专项16/16。
- Runner Kernel 自测 68/68（含四层观察语义、危险关系页面、business、Storage和事务动态零调用门禁，
  以及审计缺失强制`RUNNER_ERROR`）；
  Parser Invocation Graph专项21/21；Page Action注册表自测14/14；订单选择Surface专项测试
  15/15；全量/报告自测17/17。
- Release A RC1 16/16、Domain Preflight 20/20、Record Flow Gate 50题/99入口、
  五步用户测试 28/28、AI/P0、route/status、AI模型路由、Voice Recognition Fake
  全部通过。

## 10. 建议修复顺序

`SELECT_ORDER`、`SELECT_QUOTATION`和首页单商品编辑同步Cluster均已独立完成，报价候选
继续以Preflight为唯一真值源。下一优先建议是独立处理`BASIC-010`、`PAGE-008`等本地
解析operation/字段映射Cluster；解析/安全低置信度差异和其他未分类Case必须按各自
Cluster判责，不能在页面任务中顺手放宽安全或修改Expected。

## 11. Observation Semantics V1 重基线

25 条旧合同曾把 raw operation、最终业务 operation、proposed business type 和
pending持久化结果混为一层。V1.2 现在分别记录 `rawParser`、`semanticResult`、
`proposal`和`outcome`，并要求 semantic/outcome 都来自Actual生产等价证据。

迁移后6条变为PASS，19条移动到下一处真实差异；raw空operation不再遮挡Route、
Preflight、字段和State Diff差异。当前`LOCAL_PARSE_ERROR=11`，其中5条高置信parser
缺陷仍为CASE_FAIL并得到明确Ownership；其余仍需后续按Case证据判责。`PAGE-008`不再因
raw operation为空失败，仍因Route/交期合同阻断且正式Diff为零；`BASIC-010`仍是高置信
待收款识别缺陷。

两轮均为`PASS=10 / CASE_FAIL=110 / RUNNER_ERROR=0 / BLOCKED=0`，65条P0失败全部单题
重跑，P1分层抽查13条，31个Cluster覆盖110/110。两轮parser调用图完全一致，
`parserEvidenceMissing/orphan/uncorrelated/shadow=0`，120题中真实零Raw调用路径为0。
详细25条逐题迁移表见
`docs/RECORD_E2E_OBSERVATION_SEMANTICS_V1.md`。

## 12. Payment Intent Parser V1 重基线

`BASIC-012`和`PAGE-003`原先都因明确收款被本地parser识别为order而成为
`LOCAL_PARSE_ERROR/CONFIRMED_LOCAL_PARSER_DEFECT`。本阶段只调整本地parser的窄收款
证据、非金融“收到”负例和payment中的订单关系/mixed边界：

- `BASIC-012`现在raw为`payment/null`、Route为`AI_DEEP`、semantic operation为
  `record_payment`；隔离提交产生一条600元收款、订单增量0。Case继续因未关联收款标记
  映射差异成为`CASE_FAIL/AI_NORMALIZE_ERROR`。
- `PAGE-003`现在raw为`payment/null`，本次收款4500、关系上下文剩余4000，Route为
  `AI_DEEP`。Preflight继续阻断超额收款，正式业务Diff为0；Case成为
  `CASE_FAIL/PREFLIGHT_ERROR`。

两题不再属于确认的本地parser缺陷。`BASIC-006`、`BASIC-010`和`AMB-005`继续保持
`LOCAL_PARSE_ERROR/CONFIRMED_LOCAL_PARSER_DEFECT/HIGH`，没有被语义投影或新payment
规则隐藏。

120条双轮结果仍为：

```text
PASS          10
CASE_FAIL    110
RUNNER_ERROR   0
BLOCKED        0
```

Failure Stage从上一基线的`LOCAL_PARSE_ERROR=11 / AI_NORMALIZE_ERROR=21 /
PREFLIGHT_ERROR=19 / ROUTE_ERROR=44`变为`9 / 23 / 20 / 43`。第三条变化来自同一
payment完成语义边界的`AMB-016`从Route差异推进到Fake字段差异。Ownership中的
`CONFIRMED_LOCAL_PARSER_DEFECT`从5降为3，新增两条下游
`UNCLASSIFIED_REQUIRES_REVIEW`。除两条目标和`AMB-016`外，其他117题的顶层Case状态、
主失败和Ownership均不变；Evidence层另有4条直接相关修正：`FIN-004`、`PAGE-004`补齐raw收款金额，
`FIN-013`不再把明确付款误投影为todo，`CHAT-001`的聊天确认“收到”不再被误当付款。
其余114题的raw/semantic/proposal/outcome/Preflight/业务Diff比较无变化。

65条P0失败全部单题重跑、P1分层抽查13条；31个Cluster覆盖110/110失败。Parser专项、
Runner、页面选择、Release A、Preflight、Shared Confirmation、Flow Gate、五步用户链、
AI/P0、Route和Voice Fake回归全部通过。两轮全部隔离与parser调用图硬门禁为0。
所有命令由默认离线且fail-closed的白名单入口执行，进程级network guard attempt为0；
网络误触审计和门禁合同见`docs/RECORD_OFFLINE_TEST_SAFETY_V1.md`。

详细规则、负例和目标证据见`docs/RECORD_PARSER_PAYMENT_INTENT_V1.md`。

## 13. Structured Order Reference Evidence V1 重基线

本地parser现在可以为明确订单实体指代输出`relation_references.order`，区分
`EXPLICIT_ORDER_DEICTIC`、`EXPLICIT_ORDER_IDENTIFIER`和
`EXPLICIT_ORDER_NAMED_REFERENCE`。Evidence包含最小`sourceText`、准确`sourceSpan`、
`requiresResolution`和`resolvedEntityId=null`，不读取State、不按候选数量或商品匹配
推导，也不自动生成`orderId`。

`BASIC-010`的“这单”在raw parser、Hybrid、Confirmation草稿和Preflight输入四阶段保持
同一结构，Route仍为LOCAL且AI调用0。`BASIC-009`的“那批货”不产生同等级订单指代Evidence。
本阶段没有修改Preflight保存门禁，因此`requiredSelections`与
`domainCanSaveFormal`保持既有行为。

起始HEAD与当前代码的120题双轮均为：

```text
PASS           12
CASE_FAIL     108
RUNNER_ERROR    0
BLOCKED         0
```

两轮确定性一致，63条P0失败全部单题重跑，P1分层抽查13条，30个Cluster覆盖108/108。
相对10/110可信发布基线的两条PASS来自起始WIP中的Safe Local BASIC-009/010；本阶段只新增
Evidence和报告观测，没有改变Case状态。详细合同见
`docs/RECORD_ORDER_REFERENCE_EVIDENCE_V1.md`。

## 14. Safe Local Receivable Order Gate V1 重基线

Domain Preflight现在只消费既有`relation_references.order`结构。仅当业务为
`receivable/create_receivable`且Evidence同时满足`ORDER / explicit=true /
requiresResolution=true`时，才要求用户确认合法`orderId`。它不扫描原文，不根据历史
候选、商品匹配、Case ID或Expected推导明确关系。

`BASIC-010`选择前保持`LOCAL / AIRequestCount=0`，候选为`ord-active-a`，但
`requiredSelections=[orderId] / ORDER_SELECTION_REQUIRED /
domainCanSaveFormal=false`。Runner真实调用一次`changeOrder()`后，选择确认为
`ord-active-a`，重新Preflight清除关系阻断；保存前基于最新State再次验证，最终待收款
金额8000、日期2026-07-25、客户王总、orderId为`ord-active-a`，原文不变。

`BASIC-009`没有明确订单Evidence，保持`LOCAL / AIRequestCount=0`且不要求选择订单。
唯一或多个候选都不会自动关联；跨客户、不存在、删除、失效或未确认orderId继续阻断。

120题双轮结果相对Structured Evidence冻结基线不变：

```text
PASS           12
CASE_FAIL     108
RUNNER_ERROR    0
BLOCKED         0
```

两轮确定性一致；63条P0失败全部单题重跑，P1分层抽查13条，30个Cluster覆盖108/108。
所有网络、Storage、fixture、事务清理和Parser Graph硬门禁均为0。详细政策见
`docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md`。

## 15. Quotation Negation Parser V1 重基线

`BASIC-006`原文“给郑老板报挂件3000个，1块5一个，还没下单”同时包含独立报价证据和
被否定订单动作。旧parser让“下单”累计order分数，却未识别“还没下单”的否定范围，
因此raw为`order/null`并最终停在`LOCAL_PARSE_ERROR`。

本阶段只在本地parser中记录quotation正向、order正向、order否定和后续重新肯定Evidence。
被否定order片段不再参与order评分；没有quotation正向Evidence的“还没下单”不会被新造为
quotation，后续“现在/这次/今天已经或正式下单”以及独立“先做/做货”动作也不会被前一段
否定吞掉。否定报价、报废/报告、双重否定以及“还没正式下单/尚未确认下单”内部子串均有
专项门禁。

`BASIC-006`现在raw为`quotation/null`、semantic为
`quotation/create_quotation`、Route为LOCAL、AI请求0、Preflight无阻断；隔离提交创建
1条报价和1个客户，订单Diff为0，原文和3000个、1.5元、4500元字段全部保留。Case变为
PASS。

120题双轮均为：

```text
PASS           13
CASE_FAIL     107
RUNNER_ERROR    0
BLOCKED         0
```

相对12/108冻结基线只新增`BASIC-006`一条PASS。`LOCAL_PARSE_ERROR`从8降为7，
`CONFIRMED_LOCAL_PARSER_DEFECT`从2降为1；其余Failure Stage和Ownership计数不变。
63条P0失败全部单题重跑，P1分层抽查13条，29个Cluster覆盖107/107。两轮确定性一致，
网络、Storage、fixture、Parser Graph、Worker及Journal/Backup硬门禁全部为0。

`AMB-005`继续为唯一已确认本地parser缺陷；详细边界见
`docs/RECORD_PARSER_QUOTATION_NEGATION_V1.md`。

## 16. Order Signal Boundary Parser V1 重基线

`AMB-005`原文“今天天气不错，晚点出去走走”没有任何业务字段。旧parser的动态Evidence
只有`order=1`，其他intent全部为0且`orderPositiveSignals=[]`；静态审计确认唯一分数来自
通用订单评分中的裸`/出/`。

本阶段移除单字“出/拿”的独立order分数，并把“日期+出”限制为完整交付短语及商品、数量
加价格或多商品结构组合。“周五出”交付简写与明确下单、订单实体、多商品订单继续有效；
“出去、出门、出差、出错、报价出了吗、货款打出去了、给王总出500个”不再凭单字生成
order。

`AMB-005`现在raw为`unknown/null`、order分数0、AI调用0、正式及待整理保存均为false，
全部业务Diff为0。它不再属于确认本地parser缺陷；当前最早差异推进为`ROUTE_ERROR`，
因为生产Route仍为PENDING而Case规范语义为NO_RECORD，本阶段没有修改Route或Preflight。

120题双轮均为：

```text
PASS           13
CASE_FAIL     107
RUNNER_ERROR    0
BLOCKED         0
```

相对13/107冻结基线总数不变。`LOCAL_PARSE_ERROR`从7降为6，`ROUTE_ERROR`从42升为43，
`CONFIRMED_LOCAL_PARSER_DEFECT`从1降为0，`UNCLASSIFIED_REQUIRES_REVIEW`从95升为96。
63条P0失败全部单题重跑，P1分层抽查13条，28个Cluster覆盖107/107。所有隔离硬门禁及
network guard attempt均为0。新增raw Evidence字段使39条已提交Case的aiParseLogs及
plan/receipt指纹机械变化，但全部业务Diff、revision和提交语义不变。详细边界见
`docs/RECORD_PARSER_ORDER_SIGNAL_BOUNDARY_V1.md`。

## 17. Clear Non-Business NO_RECORD Route V1 重基线

`AMB-005`原文“今天天气不错，晚点出去走走”的raw继续为`unknown/null`，业务信号、
结构化业务字段和关系Evidence均为0。Parser、Hybrid及异步采集完整结束后，真实生产
Route现在返回canonical `NO_RECORD`，而不是由Runner事后把PENDING投影成NO_RECORD。
Route reasonCodes包含`CLEAR_NON_BUSINESS / NO_BUSINESS_EVIDENCE /
NO_STRUCTURED_FIELDS / NO_RELATION_EVIDENCE / PROCESSING_COMPLETE`，AI请求0且
Deep Review不可用。

Domain Preflight对canonical NO_RECORD同时关闭正式和pending保存资格。FULL_PAGE和
HOME_QUICK隐藏正式保存、“先放待整理”和Deep Review；即使直接调用隐藏handler或绕过
页面调用business，`saveConfirmedDraft()`和`savePendingNote()`也会在任何mutation、
Storage或事务开始前分别以`NO_RECORD_FORMAL_SAVE_FORBIDDEN`和
`NO_RECORD_PENDING_SAVE_FORBIDDEN`拒绝。

本门禁不等于`unknown => NO_RECORD`。含客户、商品、金额、日期、关系Evidence、缺字段、
低置信、冲突、AI未决或未完成异步工作的输入仍保持PENDING。BASIC-019/020和
AMB-001/002/014继续可以保存pending；AMB-012因日期Evidence保持PENDING；
VOICE-004/006和MULTI-009没有提前终止，MULTI-009调用图仍为2个Hybrid、26个Raw。

120题最终离线双轮均为：

```text
PASS           14
CASE_FAIL     106
RUNNER_ERROR    0
BLOCKED         0
```

相对13/107冻结基线只新增`AMB-005`一条PASS。两轮确定性一致；63条P0失败全部单题重跑，
P1分层抽查13条，28个Cluster覆盖106/106。每轮`noRecordCaseCount=1`，
`noRecordFormalWriteCount=0`，`noRecordPendingWriteCount=0`；网络、真实Storage、
fixture、跨Case泄漏、Journal/Backup、Parser Evidence、orphan/uncorrelated/shadow
调用和隔离审计缺失硬门禁全部为0。详细政策见
`docs/RECORD_NO_RECORD_ROUTE_POLICY_V1.md`。

## 18. Voice Transcription Completion Evidence V1 重基线

`VOICE-004`准确转写“赵姐礼品盒五百套三块八一套”继续得到客户赵姐、商品礼品盒、
数量500、单价3.8、金额1900和`raw unknown/null`。本阶段没有修改Route，
所以它仍为`PENDING / AIRequestCount=0 / ROUTE_ERROR`。

新增的可信Evidence由语音Provider最终`onStop`回调在`runParse()`之前产生，绑定当前
单调session、final sequence和准确转写指纹。`onRecognize`只表示PARTIAL；取消、错误、
超时、旧session延迟回调和重复final均不能伪装新的COMPLETED。用户手工修改文本会使旧
Evidence失效。

FULL_PAGE和HOME_QUICK复用同一Voice helper及Schema，并把同一Evidence机械透传到
`parseHybridInput()`和Route输入Trace。非语音渠道不得携带该Evidence；只有
`present/status/source/valid`四个必要脱敏状态进入既有`aiParseLogs` Route Trace，
完整Evidence、session ID、转写指纹和Provider对象不进入订单、报价、收付款、pending
note或业务Storage。`VOICE-006`继续为
`AI_STANDARD / AIRequestCount=1 / SURFACE_ERROR`，独立异步/Surface问题保持可见。

120题最终离线双轮均为：

```text
PASS           14
CASE_FAIL     106
RUNNER_ERROR    0
BLOCKED         0
```

相对Clear NO_RECORD冻结基线业务结果完全不变。两轮确定性一致；63条P0失败全部单题重跑，
P1分层抽查13条，28个Cluster覆盖106/106。每轮`voiceEvidenceMissingCount=0`、
`voiceFingerprintMismatchCount=0`、`voiceStaleSessionAcceptedCount=0`；网络、真实
Storage、fixture、跨Case泄漏、Journal/Backup、Parser Evidence和调用图隔离门禁也均为0。
详细合同见`docs/RECORD_VOICE_COMPLETION_EVIDENCE_V1.md`。

## 19. Verified Voice Standard Route V1 重基线

`VOICE-004`继续使用准确转写“赵姐礼品盒五百套三块八一套”。Route在执行前读取6B.1
已经建立的可信终稿Evidence：状态COMPLETED、session匹配、转写指纹匹配、Fake final
callback来源可信。raw仍为`unknown/null`，结构化字段继续为客户赵姐、商品礼品盒、
数量500套、单价3.8和金额1900，只有intent未决。

新Route窄资格要求可信final、Parser/Evidence完整、客户+商品+正数量+正单价/金额强组合、
无业务缺字段、低置信、冲突、金融/混合/关系/Deep风险，且当前Safety确实需要Standard
核对。它不扫描原文，不读取Case ID、Expected或Fake结果。命中后真实生产Route返回
`AI_STANDARD`，并通过既有Fake Standard adapter恰好请求一次；Runner物理计数为
`standardAIRequestCount=1 / duplicateVoiceStandardAIRequestCount=0`。

VOICE-004使用既有`ai-case-rec-e2e-voice-004-v1`，规范化和合并结果为
`order/create_order`，但转写及Fake结果均无交期。既有Domain Preflight继续以
`MISSING_REQUIRED_FIELD`阻断，正式业务Diff为0。因此它从`ROUTE_ERROR`推进到
`PREFLIGHT_ERROR`，没有通过补造dueDate、修改Expected或放宽正式保存实现。

可信final闲聊仍为`NO_RECORD / AIRequestCount=0`，final且本地已解决订单仍为
`LOCAL / AIRequestCount=0`；Safe Local receivable、payment、deposit和Deep政策不变。
`VOICE-006`继续为`AI_STANDARD / AIRequestCount=1 / SURFACE_ERROR`，原独立问题保持
可见。

120题最终离线双轮均为：

```text
PASS           14
CASE_FAIL     106
RUNNER_ERROR    0
BLOCKED         0
```

相对14/106冻结基线总数不变；`ROUTE_ERROR`从42降为41，`PREFLIGHT_ERROR`从20升为21。
两轮确定性一致；63条P0失败全部单题重跑，P1分层抽查12条，27个Cluster覆盖106/106。
每轮新增`duplicateVoiceStandardAIRequestCount=0`，并且网络、真实Storage、fixture、
跨Case泄漏、Journal/Backup、Parser Graph及三项Voice Evidence门禁全部为0。详细政策见
`docs/RECORD_VOICE_STANDARD_ROUTE_V1.md`。

## 20. VOICE-004分层缺交期安全合同重基线

VOICE-004保留全部Voice Completion、Route、AI、Normalize、Merge和业务字段断言：
可信final Evidence有效，Route为`AI_STANDARD`，Standard Fake AI请求恰好1次，
Deep与重复请求为0，语义为`order/create_order`，客户赵姐、礼品盒、500套、单价3.8、
金额1900均保持。原文与Fake结果没有交期，运行时Confirmation输出
`missingFields=[dueDate]`；Expected使用canonical
`missingFields=[orderDeliveryDate]`，由共享的精确字段别名合同在断言时标准化。

该Case现在采用既有`DO_NOT_SAVE / BLOCKED_BUSINESS_SAFETY / ZERO_SIDE_EFFECTS`
模式。Domain Preflight继续返回`domainCanSaveFormal=false`、
`domainCanSavePending=true`及`MISSING_REQUIRED_FIELD`；页面未调用正式或pending
保存，business与Storage写入口均未调用，Outcome为`BLOCKED`，正式/pending持久化、
业务Diff、事务、Receipt、Journal与Backup均为0。没有补造dueDate，也没有放宽Preflight。

动态Execution Plan统计为：

```text
VOICE-004 TEST_ONLY_ISOLATED_LEGACY_COMMIT: 1 → 0
其他119题提交Lane: 88 → 88
全量提交Lane: 89 → 88
```

120题离线双轮均为：

```text
ACTIVE         120
PASS            15
CASE_FAIL      105
RUNNER_ERROR     0
BLOCKED          0
```

相对14/106冻结基线仅VOICE-004从`CASE_FAIL / PREFLIGHT_ERROR`转为PASS；
`PREFLIGHT_ERROR`从21降为20，其他Failure Stage与Ownership保持。其他119题的顶层
状态、最早失败层、Ownership、Route、Preflight语义、AI请求次数和业务Diff逐题一致。
两轮确定性稳定；63条P0失败全部单题重跑，P1分层抽查12条，27个Cluster覆盖105/105
失败。每轮网络、真实Storage、fixture mutation、跨Case泄漏、Journal/Backup、Parser
Evidence、orphan/uncorrelated/shadow、隔离审计、三项Voice Evidence和重复Voice
Standard AI请求硬门禁全部为0。

## 21. VOICE-006 Surface与生产资格分层重基线

本轮只修正Corpus Validator的分层资格合同和VOICE-006 Expected，没有修改生产代码、
AI fixture、Runner等待、页面投影或业务保存路径。VOICE-006的FULL_PAGE具备完整业务能力，
但Fake Standard Provider不具备生产正式保存资格，因此精确状态为：

```text
surface.status = BLOCKED
surfaceCanCompleteFormal = true
effectiveCanSaveFormal = false
productionEligibility = BLOCKED_NON_REAL_PROVIDER
pageFormalSaveAllowed = false
blockingCodes = [UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION]
```

真实Route仍为`AI_STANDARD`，Standard AI请求恰好1次且重复计数为0；Semantic、
Confirmation和Domain Preflight均正确。生产页面、business和Storage写入均为0；隔离
Legacy事务仍提交客户和订单各1条，并产生1个revision和1个receipt，Journal/Backup为0。

120题离线双轮结果一致：

```text
ACTIVE         120
PASS            16
CASE_FAIL      104
RUNNER_ERROR     0
BLOCKED          0
```

Failure Stage为`AI_NORMALIZE=23 / LOCAL_PARSE=6 / PREFLIGHT=20 / ROUTE=41 /
STATE_DIFF=4 / STORAGE_TRANSACTION=1 / SURFACE=9`。63条P0失败全部单题重跑，P1分层
抽查11条，26个Cluster覆盖104/104失败。隔离提交Lane总数为88。与15/105冻结报告相比，
仅VOICE-006从`CASE_FAIL / SURFACE_ERROR / OBSERVABILITY_EXPECTATION_MISMATCH`转为PASS；
其他119题的状态、最早失败层、Ownership、Route、AI、Preflight、生产观察和业务Diff
逐题一致。两轮全部网络、真实Storage、fixture、跨Case泄漏、Journal/Backup、Parser Graph、
Voice Evidence和重复Voice Standard AI硬门禁为0。

## 22. VOICE-010 Fake Deep Provider Surface合同重基线

本轮只把VOICE-010的FULL_PAGE Surface Expected从`CAN_COMPLETE / true / true`修正为
`BLOCKED / true / false`，没有修改生产代码、Corpus Validator、Runner等待或Snapshot、
AI fixture、Provider信任政策、Domain Preflight、Action Plan或隔离提交Lane。VOICE-010
继续要求可信Voice Evidence、主动Deep Review、`AI_DEEP`和Fake Deep AI恰好1次；收款
语义、1500元、2026-07-15以及真实`changeReceivable(rec-open-a)`选择均保持原合同。

选择完成后的Domain与生产资格分层为：

```text
domainCanSaveFormal = true
domainCanSavePending = true
surfaceCanCompleteFormal = true
productionEligibility = BLOCKED_NON_REAL_PROVIDER
effectiveCanSaveFormal = false
pageFormalSaveAllowed = false
surface.status = BLOCKED
blockingCodes = [UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION]
```

生产页面、business与Storage正式保存调用均为0。`TEST_ONLY_ISOLATED_LEGACY_COMMIT`
继续提交payment 1条、更新receivable 1条、把paidAmount更新为2500，并产生revision与
receipt各1；Journal/Backup最终为0。隔离提交Lane总数保持88。

120题离线双轮结果一致：

```text
ACTIVE         120
PASS            17
CASE_FAIL      103
RUNNER_ERROR     0
BLOCKED          0
```

Failure Stage为`AI_NORMALIZE=23 / LOCAL_PARSE=6 / PREFLIGHT=20 / ROUTE=41 /
STATE_DIFF=4 / STORAGE_TRANSACTION=1 / SURFACE=8`。62条P0失败全部单题重跑，P1分层
抽查11条，26个Cluster覆盖103/103失败。与16/104冻结报告逐题比较，仅VOICE-010从
`CASE_FAIL / SURFACE_ERROR / UNCLASSIFIED_REQUIRES_REVIEW`转为PASS；其他119题的状态、
最早失败层、Ownership、Route、AI请求、Preflight、Eligibility、Surface Actual和业务
Diff完全一致。两轮网络、真实Storage、fixture、跨Case泄漏、Journal/Backup、Parser Graph、
Voice Evidence、陈旧Session和重复Voice Standard AI硬门禁全部为0。

## 23. BASIC-011 Fake Deep Provider Surface合同重基线

本轮只把BASIC-011的FULL_PAGE Surface Expected从`CAN_COMPLETE / true / true`修正为
`BLOCKED / true / false`，没有修改生产代码、Corpus Validator、Runner、AI fixture、
Provider信任政策、Domain Preflight、Action Plan、关系选择或隔离提交Lane。

BASIC-011原文“王总这笔待收今天付了1500元”继续走`AI_DEEP`，Fake Deep AI请求恰好
1次；Semantic保持`payment / record_payment`。Runner真实调用
`changeReceivable(rec-open-a)`一次，选择后`requiredSelections=[]`。业务Domain与
Surface能力完整，但Fake Provider不能取得生产资格：

```text
domainCanSaveFormal = true
domainCanSavePending = true
surfaceCanCompleteFormal = true
productionEligibility = BLOCKED_NON_REAL_PROVIDER
effectiveCanSaveFormal = false
pageFormalSaveAllowed = false
surface.status = BLOCKED
blockingCodes = [UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION]
```

生产页面正式和pending保存调用均为0，production business与Storage写入均为0。
`TEST_ONLY_ISOLATED_LEGACY_COMMIT`继续提交payment 1条、更新receivable 1条、把
paidAmount从1000更新为2500，并产生revision与receipt各1；Journal/Backup最终为0。
隔离提交Lane总数保持88。

120题离线双轮结果一致：

```text
ACTIVE         120
PASS            18
CASE_FAIL      102
RUNNER_ERROR     0
BLOCKED          0
```

Failure Stage为`AI_NORMALIZE=23 / LOCAL_PARSE=6 / PREFLIGHT=20 / ROUTE=41 /
STATE_DIFF=4 / STORAGE_TRANSACTION=1 / SURFACE=7`。61条P0失败全部单题重跑，P1分层
抽查11条，26个Cluster覆盖102/102失败。与17/103冻结报告逐题比较，仅BASIC-011从
`CASE_FAIL / SURFACE_ERROR / UNCLASSIFIED_REQUIRES_REVIEW`转为PASS；其他119题的状态、
最早失败层、Ownership、Route、AI请求、Preflight、Eligibility、Surface Actual和业务
Diff完全一致。两轮网络、真实Storage、fixture、跨Case泄漏、Journal/Backup、Parser
Graph、Voice Evidence、陈旧Session和重复Voice Standard AI硬门禁全部为0。

## 24. Composite Order + Deposit解析日志去重重基线

BASIC-014原文“孙老板订1000个卡套，5元一个，已付定金1000元，7月28日交”继续走
`AI_DEEP`，Fake Deep请求恰好1次，Semantic为`order / create_order`。隔离事务继续创建
客户1、订单1和定金付款1，定金金额1000且关联新订单；revision和receipt各1，
`operationLogs=0`。

解析日志现在按顶层确认保存拥有Envelope。Legacy订单保存通过内部嵌套上下文关闭定金子
保存日志，Shared SavePlan移除同一订单分支中的第二个parse-log operation；两者均只保留
一条`action=save_order`日志，且完整保存原文、parseResult、订单和定金信息。Standalone
Deposit仍各自写一条`action=save_order_deposit`日志。重放、重复触发、readback及提交失败
不会留下额外或部分日志，首页最近记录只显示该原文一次。

BASIC-014的FULL_PAGE Surface Expected同步冻结Provider分层事实：

```text
surface.status = BLOCKED
surfaceCanCompleteFormal = true
effectiveCanSaveFormal = false
productionEligibility = BLOCKED_NON_REAL_PROVIDER
pageFormalSaveAllowed = false
```

120题离线双轮结果一致：

```text
ACTIVE         120
PASS            19
CASE_FAIL      101
RUNNER_ERROR     0
BLOCKED          0
SURFACE_ERROR    6
```

与18/102冻结报告逐题比较，仅BASIC-014由`CASE_FAIL / SURFACE_ERROR`变为PASS；其他119题
的状态、最早失败层、Route和业务Diff一致。60条P0失败全部单题重跑，P1分层抽查11条，
26个Cluster覆盖101/101失败；隔离提交Lane总数保持88。两轮网络、真实Storage、fixture、
跨Case泄漏、Journal/Backup、Parser Graph、Voice Evidence、陈旧Session和重复Voice
Standard AI门禁均为0；专项`duplicateCompositeParseLogCount=0`且
`standaloneDepositParseLogMissingCount=0`。

## 25. 多商品新建订单Operation Log与Provider Surface重基线

`MULTI-001`、`MULTI-002`和`MULTI-006`继续走`AI_DEEP`，Fake Deep请求各1次，最终
Semantic均为`order / create_order`。三条分别创建一个含2、3、2个items的订单；客户、
各项商品、数量、单位、单价、总额与明确交期保持原断言。

FULL_PAGE具备完成这些订单的业务能力，但Fake Deep Provider不具备生产资格，因此三条
Surface Expected统一冻结为：

```text
surface.status = BLOCKED
surfaceCanCompleteFormal = true
effectiveCanSaveFormal = false
productionEligibility = BLOCKED_NON_REAL_PROVIDER
pageFormalSaveAllowed = false
```

生产页面、business和Storage正式保存调用均为0。`TEST_ONLY_ISOLATED_LEGACY_COMMIT`
继续在隔离Store中创建客户1和订单1，保存同一订单的全部items，并产生一条顶层
`aiParseLogs(action=save_order)`、零条`operationLogs`、一次revision和一张receipt。
新建订单不写业务操作日志；已有订单的部分显式修改、状态变化及删除仍按既有窄合同写日志。

120题离线双轮结果一致：

```text
ACTIVE         120
PASS            22
CASE_FAIL       98
RUNNER_ERROR     0
BLOCKED          0
SURFACE_ERROR    3
```

与19/101冻结报告逐题比较，仅`MULTI-001/002/006`由`CASE_FAIL / SURFACE_ERROR /
UNCLASSIFIED_REQUIRES_REVIEW`变为PASS；其他117题的状态、最早失败层、Ownership、Route、
AI请求、Preflight、Eligibility、Surface Actual、业务Diff、aiParseLogs和operationLogs
Actual均不变。57条P0失败全部单题重跑，P1分层抽查11条，26个Cluster覆盖98/98失败；
隔离提交Lane总数保持88。两轮硬门禁中的网络、真实Storage、fixture、跨Case泄漏、
Journal/Backup、Parser Graph、Voice Evidence、陈旧Session及重复Voice Standard AI计数
全部为0；`FIN-001/013/014`继续稳定为`CASE_FAIL / SURFACE_ERROR`。
