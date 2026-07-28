# 记一笔确定性全量基线 V1

## 1. 结论与边界

E2E Phase 2B.2-R1 在 Headless Runner Kernel V1 上，从清洁的独立 Worker 环境重新执行
120 条 ACTIVE Case 两轮。两轮结果完全一致：

```text
ACTIVE       120
Executed     120
PASS           4
CASE_FAIL    116
RUNNER_ERROR   0
BLOCKED        0
```

这是 Local/Fake/Replay 的确定性基线，不是真实千问质量测试，不是微信 WXML/DOM 页面
E2E，也不构成产品发布结论。`CASE_FAIL` 只表示 Actual 与人工合同 Expected 不一致；
其中只有证据充分的项目才标为确认产品问题，其余保持候选或待人工判责。

原始 Phase 2B.2-R1 基线没有修改生产代码。后续 `SELECT_ORDER` Cluster Fix只修改
完整输入页的候选交互和确认草稿映射；parser、AI、Domain Preflight政策、business、
Storage、Coordinator和120条题的业务Expected仍未修改。

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

完整脱敏 Evidence 只在显式 `--output` 时写入仓库外临时目录；本次Cluster Fix重跑
临时文件为`/tmp/record-select-order-full-corpus-v1.json`，不属于源码、不提交Git，也不能
替代由固定提交重新运行生成的证据。

## 4. 风险、阶段与 Ownership

风险结果：

| 风险 | PASS | CASE_FAIL | RUNNER_ERROR | BLOCKED |
| --- | ---: | ---: | ---: | ---: |
| P0 | 0 | 65 | 0 | 0 |
| P1 | 4 | 51 | 0 | 0 |

四条 PASS 均为日期题：

```text
REC-E2E-DATE-001
REC-E2E-DATE-003
REC-E2E-DATE-011
REC-E2E-DATE-012
```

Primary failure stage：

| Stage | Case数 |
| --- | ---: |
| `AI_NORMALIZE_ERROR` | 44 |
| `LOCAL_PARSE_ERROR` | 26 |
| `PREFLIGHT_ERROR` | 18 |
| `SURFACE_ERROR` | 11 |
| `ROUTE_ERROR` | 12 |
| `STATE_DIFF_ERROR` | 3 |
| `CONFIRMATION_ERROR` | 1 |
| `STORAGE_TRANSACTION_ERROR` | 1 |

Ownership：

| Ownership | Case数 | 含义 |
| --- | ---: | --- |
| `CONFIRMED_CONFIRMATION_DEFECT` | 1 | 已有生产等价页面方法证据 |
| `CONFIRMED_PRODUCT_CAPABILITY_GAP` | 2 | 页面确实缺少合同要求的报价选择入口 |
| `EXPECTED_MAPPING_MISMATCH_CANDIDATE` | 1 | State Diff/字段映射候选，未改合同 |
| `OBSERVABILITY_EXPECTATION_MISMATCH` | 2 | operationLogs 可观测预期差异 |
| `TEST_CONTRACT_MISMATCH_CANDIDATE` | 2 | 执行 Lane 正确但旧统计合同冲突 |
| `UNCLASSIFIED_REQUIRES_REVIEW` | 108 | 证据不足以判产品或测试合同责任 |

Ownership 不改变 Case 状态和 Expected。尤其不得把 108 条未分类差异直接称为产品 Bug，
也不得用“候选”标签自动修改题库。

## 5. Lane 与 Case 结果必须分开

| Lane | PASS | CASE_FAIL | 说明 |
| --- | ---: | ---: | --- |
| `PAGE_PRODUCTION_OBSERVATION` | 4 | 106 | 110 条页面观察全部执行 |
| `HEADLESS_PRODUCTION_OBSERVATION` | 4 | 6 | 10 条 Headless 观察全部执行 |
| `PAGE_CONFIRMED_DRAFT_DERIVATION` | 5 | 1 | `PAGE-008`在页面模型层失败 |
| `TEST_ONLY_ISOLATED_LEGACY_COMMIT` | 23 | 66 | 89 条合同 Lane 均有明确结果 |
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

### 6.2 缺少报价选择能力

`REL-007`、`REL-008` 共两条 P0。fixture 中目标报价存在，合同要求
`SELECT_QUOTATION`，完整页无对应生产方法或处理入口。保存未成功，正式副作用为零。

### 6.3 首页编辑与 `items[0]` 不同步

`PAGE-008` 为一条 P0。真实首页编辑方法把顶层商品从“帆布袋”改为“保温袋”、数量从
100 改为 150、单价从 6 改为 8，但 `items[0]` 保留旧值。最早失败层是
`CONFIRMATION_ERROR`。Preflight 阻断后 Runner 没有绕过安全规则保存，因此当前确认的是
页面确认模型不同步，尚未证明错误旧值最终写入订单。

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

`SELECT_ORDER` Cluster Fix后重新生成40个当前Cluster，仍覆盖116/116。与本次修复直接
相关的当前主Cluster为：

| 当前Cluster | Case数 | 风险 | Stage | Ownership |
| --- | ---: | --- | --- | --- |
| 页面缺少必要交互能力：SELECT_QUOTATION | 2 | P0 | SURFACE_ERROR | CONFIRMED_PRODUCT_CAPABILITY_GAP |
| 首页顶层编辑与items[0]不同步 | 1 | P0 | CONFIRMATION_ERROR | CONFIRMED_CONFIRMATION_DEFECT |
| 本地解析字段差异：receivable / businessType | 1 | P0 | LOCAL_PARSE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / items.length | 3 | P0/P1 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |
| Fake/Replay标准化差异：FAKE_DEEP / fields.customerId | 2 | P0 | AI_NORMALIZE_ERROR | UNCLASSIFIED_REQUIRES_REVIEW |

其中后三组分别包含`BASIC-010`、`REL-003`和`REL-009`。这表示真实订单选择入口已存在，
但Case继续暴露更早的上游差异；它不授权把这些差异自动归为产品Bug。

## 9. 重跑与回归

- 65 条 `P0 + CASE_FAIL` 全部逐条单题重跑，语义 fingerprint 与全量一致。
- P1 按 failure stage、Ownership 和业务分类分层选择 10 条，全部一致：
  `AMB-005`、`AMB-008`、`BASIC-001`、`CHAT-001`、`DATE-002`、`DATE-004`、
  `PAGE-001`、`REL-001`、`REL-014`、`VOICE-001`。
- Corpus Validator 与 Phase 2A 合同自测为 120 题通过、12/12。
- Runner Kernel 自测 41/41（含Restart子Worker错误仍返回完整隔离审计）；Page Action
  注册表自测13/13；订单选择Surface专项测试15/15；全量/报告自测14/14。
- Release A RC1 16/16、Domain Preflight 20/20、Record Flow Gate 50题/99入口、
  五步用户测试 28/28、AI/P0、route/status、AI模型路由、Voice Recognition Fake
  全部通过。

## 10. 建议修复顺序

`SELECT_ORDER`页面能力Cluster已经独立完成。下一优先建议是处理
`SELECT_QUOTATION`（2条P0）：它是当前剩余的高置信完整页选择能力缺口，正式副作用均为
零，且可沿用订单选择的Preflight候选和交互模式。

其后才是`PAGE-008`（1条P0）以及108条未分类差异的分层Evidence判责。测试合同/映射
候选必须先修合同，不能据此修改产品代码。
