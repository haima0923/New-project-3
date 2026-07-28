# 记一笔 Headless Runner Kernel V1

## 1. 状态与边界

本阶段实现 E2E Phase 2B.1-R2 的确定性执行内核。第一次 Phase 2B.1 复查发现
Restart 空 State、未执行事务 replay/CAS、弱重复触发计数和缺少逐 Case 隔离审计等假绿
路径，因此当时停止且结果不可信。R2 不修产品代码，只给执行内核增加强证据门禁。它：

- 为 120 条 ACTIVE Case 生成执行计划；
- 每道执行题使用独立 Node 子进程；
- 加载真实 `pages/dashboard/dashboard.js` 或 `pages/input/input.js`；
- 调用当前 `parseHybridInput()`、页面 Confirmation/Preflight、Legacy business、
  Release A Coordinator 和隔离内存 Storage；
- 支持生产观察、页面草稿派生、TEST_ONLY 隔离提交、页面重复触发、事务 exact
  replay、真正的新运行实例重启及同 base revision 并发；
- 用 24 条代表题验证 Runner Kernel，不代表 120 条已经全量执行。

它不是微信 WXML/DOM 页面 E2E，不使用微信开发者工具，不是真实千问质量测试，也不是
Shared 生产链。Fake/Replay 不能取得真实 Provider 身份；`CASE_FAIL` 是产品实际结果与
Case 合同不一致，不代表 Runner 错误，也不会被 Expected-Fail 豁免。

## 2. 运行命令

```text
node scripts/run-record-e2e-headless.js --plan-only
node scripts/run-record-e2e-headless.js --list
node scripts/run-record-e2e-headless.js --smoke
node scripts/run-record-e2e-headless.js --smoke --repeat 2
node scripts/run-record-e2e-headless.js --case-id REC-E2E-PAGE-008
node scripts/run-record-e2e-headless.js --case-id REC-E2E-PAGE-008 --json
node tests/record-e2e/runner-tests/runner-self-tests.js
```

默认不写仓库内报告。`--json` 只向标准输出打印脱敏证据。Phase 2B.1 没有无参数全量执行
入口；120 条全量、分类过滤和报告输出属于 Phase 2B.2。

## 3. 进程与模块隔离

父进程只加载 Corpus、fixture、Expected、执行计划和断言器。每道 Case：

1. `fork()` 新 Node 子进程；
2. 安装固定时钟、固定时区、确定性随机数、Fake wx、Fake WechatSI 和网络 Guard；
3. 再加载生产页面及生产模块；
4. 执行 Case Lane；
5. 返回脱敏证据；
6. 父进程必须观察到子进程退出后才接收该 Case 完成；
7. 销毁 require cache、模块单例、全局 wx、页面实例和 Coordinator 队列。

Expected 不进入 Worker spec，不能参与 Actual 生成。Worker 只收到原始输入、执行边界、
匿名初始 State、Fake/Replay fixture 和交互步骤；父进程在 Worker 完成后才加载 Expected
进行断言。

## 4. Storage 与网络隔离

生产代码仍会使用逻辑 Key `yiwu_boss_ai_assistant_v1`。Runner 允许该逻辑调用，但此时
全局 `wx` 是当前 Case 的纯内存 Fake：

```text
productionLogicalKeyCalls：记录但允许
realWxStorageCalls：必须为 0
```

Fake wx 不连接微信开发者工具。运行时还会动态包装 Node `fs` 写入口；任何写文件尝试都
产生 `AUTOMATION_STORAGE_GUARD_ERROR`。Release A 隔离提交使用受保护
`createFakeStorageGateway()`；Journal、Backup、Receipt 和 revision 都留在当前 Worker
内存中。

网络只允许 Fake wx 命中内存路径：

```text
/api/auth/wechat-login
/api/ai/parse
/api/ai/parse/deep
```

`fetch`、Node HTTP/HTTPS 和未知 wx.request 路径均由 Guard 阻断。语音使用 Fake
WechatSI 最终转写事件，不走 HTTP。每个 Case 完成前必须动态证明：

```text
realNetworkRequests = 0
unknownFakeRouteRequests = 0
realWxStorageCalls = 0
hostFilesystemStorageCalls = 0
fixtureMutationCount = 0
journalCount = 0
backupCount = 0
```

缺少审计本身也会得到 `RUNNER_ERROR/ISOLATION_AUDIT_NOT_EXECUTED`，不能默认通过。

## 5. 页面 VM

Runner 读取并执行真实页面 JS，捕获 `Page()` 配置，实例化独立 page 对象，并为
`setData()` 提供微信兼容的字段路径更新。输入和交互只调用页面现有方法：

- HOME：`onComposerInput()`、`submitComposer()`、`pasteClipboard()`、
  `beginVoiceRecognition()`、`updateConfirmField()`、`changeConfirmDate()`；
- FULL：`onTextInput()`、`runParse()`、`pasteClipboard()`、`startVoice()`、
  `updateField()`、`updateItemField()`、现有客户/待收/定金订单选择方法；
- PENDING_EDIT：写入隔离交接 Key，由真实 `onShow()` 读取，再通过真实解析和保存方法。

Runner 不加载 WXML，不声称验证按钮绑定、视觉渲染、触控或页面截图。完整页不存在的通用
`SELECT_ORDER` / `SELECT_QUOTATION` 不会被虚构；相关 Case 为
`CASE_FAIL/SURFACE_ERROR`，依赖该交互的保存 Lane 不执行并保持零正式副作用。

## 6. AI 身份

Fake/Replay 响应必须实际经过生产 `wx.request`、AI normalizer 和合并。生产前端原本会把
成功 transport 归类为 REAL；测试 transport adapter 只把成功结果的
`ai_fallback.provider_kind` 改为 `FAKE` 或 `REPLAY`，并在前后计算业务 Hash。

该适配不得改变客户、商品、items、数量、金额、日期、关系或 originalText。生产观察因此
会得到 `BLOCKED_NON_REAL_PROVIDER`。若业务 Preflight 除 Provider 身份外完全安全，
隔离 Lane 才可移除 AI 执行控制元数据，并再次运行生产 Preflight；它从不把 Provider
改成 REAL。

## 7. 执行 Lane

| Lane | 执行语义 |
| --- | --- |
| `PAGE_PRODUCTION_OBSERVATION` | 真实页面方法、路由、Confirmation、Preflight、Surface 与页面保存资格 |
| `HEADLESS_PRODUCTION_OBSERVATION` | 直接生产 parser/AI 观察；不冒充页面 |
| `PAGE_CONFIRMED_DRAFT_DERIVATION` | HEADLESS提交题额外经真实完整页派生草稿 |
| `TEST_ONLY_ISOLATED_LEGACY_COMMIT` | 页面草稿业务 Hash不变，调用当前 Legacy business 与 Release A 隔离 Store |
| `PAGE_DUPLICATE_TRIGGER_GUARD` | 同一页面动作的两次触发；不使用事务 replay 代替 |
| `TRANSACTION_EXACT_REPLAY` | 原样重放同 transaction/plan/hash/base 材料，期望 `ALREADY_COMMITTED` |
| `RESTART_PERSISTENCE` | 导出 Fake持久层，启动全新 Worker/App/Coordinator 后读取 |
| `CONCURRENT_BASE_REVISION` | A/B读同 base，A提交，B用旧 base提交并由 CAS 阻断 |

业务安全阻断、NO_RECORD、AI失败、危险 uncertain、缺关键字段、跨客户、超额金融、无效目标
或候选未选择都不能由 TEST_ONLY Lane 绕过。

## 8. Lane 状态机与完成证据

每个 Lane 依次记录：

```text
PLANNED
PRECONDITIONS_CHECKED
PRECONDITIONS_PASSED
STARTED
PRIMARY_ACTION_ATTEMPTED
PRIMARY_ACTION_SUCCEEDED
COMPLETION_EVIDENCE_COLLECTED
ASSERTIONS_COMPLETED
COMPLETED
```

Lane 只有全部布尔证据为真且断言完成才能 `PASS`。未启动、未尝试核心动作或缺少完成证据
一律为 `RUNNER_ERROR/LANE_EXECUTION_EVIDENCE_MISSING`。Restart 首次提交失败、exact replay
没有首次 Receipt、concurrent A 未提交、duplicate trigger 缺少业务/事务计数时，后续
动作不得启动，更不能用空 State 或空 Diff 判绿。

`--plan-only` 除 Schema 外还检查首次成功提交合同。Restart、replay、concurrent 的订单
必须已有客户、商品、数量和固定 ISO 交期，Expected Preflight 必须允许正式语义，且
TEST_ONLY 首次提交合同和非零业务 Diff 均存在。`PERSIST-001/002/003/004`的合成订单已
按既有“正式订单交期必填”规则补充固定交期；`PERSIST-004`的并发B合成输入还把
“200个/4元一套”的显式单位冲突机械统一为“200个/4元一个”。计划阶段会拒绝并发B
缺固定交期或显式数量/计价单位冲突。上述只修复“两个草稿本身均安全”这一CAS前置，
产品规则、A提交/B stale目标和最终业务Expected都没有改变。

`BASIC-020`使用的专属待整理 fixture 原文已机械修正为与 Case 的“陈姐/礼盒”原文一致；
计划阶段会拒绝 pending ID、目标或原文不一致。

## 9. 事务、重启与重复触发证据

- `PERSIST-003`：首次 TEST_ONLY Legacy Commit 必须真实返回 `COMMITTED` 和 Receipt，
  随后原样重放 transactionId、planId、planHash、idempotencyKey、base/target revision
  与 fingerprint。Replay 返回 `ALREADY_COMMITTED`，revision、Receipt 和业务记录零增量；
  首次及 replay 阶段都不调用页面正式保存 handler，实际调用数为 0；首次事务来自
  页面派生草稿的 TEST_ONLY 隔离提交。旧 Case 字段仍期待`pageSaveAttempts=1`，因此该题
  当前如实为`CASE_FAIL/STORAGE_TRANSACTION_ERROR`，但 exact replay Lane 的真实事务证据
  完整存在；Runner不会硬编码 1 制造通过。
- `RESTART_PERSISTENCE`：首次 Commit 后导出 Fake Storage，原 Case Worker 退出，再启动
  新 PID/Boot ID 的 App Worker；保存型 Case 必须有可识别非空业务变化。
- `PERSIST-004`：A/B 读取相同 base revision/fingerprint；A真实提交并产生 Receipt，
  B不刷新 base 而真实调用 Coordinator，得到 `LEGACY_SAVE_STALE`，主 Bundle 写入为 0。
- `FIN-014`：分别记录页面 handler、Legacy business、Storage/事务入口、Receipt 和金融
  记录数量；第二次页面调用被页面 guard 抑制，不使用 exact replay 代替页面证据。

## 10. 结果与失败分类

```text
PASS         所有要求 Lane 都符合 Expected
CASE_FAIL    Runner正确执行，但产品 Actual 与 Expected 不一致
RUNNER_ERROR Driver、Worker、网络/Storage Guard、断言或清理自身错误
BLOCKED      Case/fixture/执行合同缺失或矛盾
```

断言按最早差异分类：INPUT、ROUTE、RESULT、PREFLIGHT、CONFIRMATION、SURFACE、隔离保存、
事务、State Diff、Restart。页面缺能力属于产品 `SURFACE_ERROR`；页面有方法但 Driver
不调用属于 `AUTOMATION_DRIVER_ERROR`。

一个 Case 可有多个发现，但只有一个 `primaryFailure`。测试数据/Runner硬门禁优先，其后
是 requiredCapability Surface、输入、parse/route、AI、Preflight、Confirmation、保存、
Legacy、事务和Restart。五条订单/报价选择能力缺失 Case 固定以
`REQUIRED_PAGE_CAPABILITY_MISSING/SURFACE_ERROR`为主，其他差异只作为 secondary finding。

## 11. Evidence

每题 JSON 至少包含：

```text
executionPlan / clock / fixtureMutationAudit / runtimeEvidence
actualInput / routeEvidence / aiEvidence
pageEvidence / pageDerivationEvidence / interactionEvidence
preflightEvidence / productionObservation / surfaceEvidence
isolatedCommitEvidence / duplicateTriggerEvidence
transactionReplayEvidence / restartEvidence / concurrentEvidence
businessDiff / fullDiff / storageAudit / networkAudit
laneResults / assertions / caseStatus / failureStage / failureCode
```

Token、Cookie、Authorization 和类似密钥字段会被脱敏。证据不保存完整外部响应；本阶段所有
AI fixture 和业务数据均为仓库内合成数据。

## 12. 代表性 Smoke

`tests/record-e2e/runner-smoke/smoke-manifest-v1.json` 只引用以下 24 个既有 ACTIVE Case：

```text
PAGE-008 / PERSIST-003 / FIN-014
BASIC-010 / REL-003 / REL-007 / REL-008 / REL-009
BASIC-001 / PERSIST-001
CHAT-001 / CHAT-003 / MULTI-001
AMB-003 / AMB-005
FIN-003 / FIN-001
VOICE-001 / BASIC-020 / PERSIST-004
PAGE-007 / AMB-010 / DATE-007 / AMB-011
```

它覆盖 HOME、FULL、HEADLESS、打字、聊天、语音转写、待整理编辑、Local、Fake
Standard、Fake Deep、Replay、全部执行 Lane、页面缺能力、编辑、多商品、金融、重启、
exact replay、重复触发和并发。Case 内容仍以 Corpus 为唯一来源，manifest 不复制题目。

## 13. 自测与假绿防护

Runner 当前 40 项自测覆盖：

1. 错误 Expected；
2. 漏执行保存；
3. 未知网络；
4. 宿主 Storage；
5. 跨 Case State；
6. fixture 修改；
7. 页面能力缺失分类；
8. Driver 跳过现有方法；
9. Fake 生产阻断与安全隔离提交；
10. 业务安全不可绕过；
11. exact replay 不二次调用页面保存；
12. 禁止直接赋值伪造页面编辑；
13. 重启必须新 Worker；
14. 固定时钟不受宿主日期影响；
15. 同 base CAS 保留先提交者；
16. Lane 未 STARTED、核心动作未 attempted、缺 Completion Evidence 均不能 PASS；
17. 首次提交失败和空 State 不能启动或通过 Restart；
18. Restart 必须跨 PID 与 Boot ID；
19. exact replay 缺首次 Receipt 或更换 transactionId 必须失败；
20. concurrent A 未提交不得运行 B，B 未真实尝试不得 PASS；
21. duplicate trigger 缺四层计数不得 PASS；
22. Surface 主错误不能被 Route 覆盖；
23. pending Case/fixture 原文矛盾在 plan 阶段失败；
24. required selection的fixture目标必须真实存在；
25. 并发B的显式数量/计价单位冲突必须在plan阶段失败；
26. 缺少要求Lane结果或Lane停在PLANNED都不能离开断言器；
27. Surface零副作用必须读取真实runtime Storage Diff，不能比较两个合成空State；
28. Storage save调用不能冒充Coordinator事务决策；
29. 网络/Storage审计未执行、fixture mutation、Journal残留和宿主文件写入均硬失败。

Smoke `--repeat 2` 比较 Case/Lane状态、Route、Preflight、页面业务语义、Diff、Receipt 和
failureStage。只排除 PID、Boot ID 等非业务运行标识。

## 14. PAGE-008 证据边界

`REC-E2E-PAGE-008`真实调用首页编辑方法后，已观察到顶层商品/数量/单价更新但
`items[0]`未同步，最早失败层是 `CONFIRMATION_ERROR`。由于页面模型已在保存前不一致，
Runner不绕过Preflight取得最终订单；因此当前只确认页面确认模型同步缺陷，尚未据此宣称
错误旧 item 已写入最终业务 State。

## 15. 当前限制与本轮结果

- 本阶段只执行 24 条 Smoke，不构成 120 条全量产品通过率。
- `CASE_FAIL` 会完整保留，不能用 knownRisk 或 Expected Fail 消除。
- R2的24题双轮Smoke为 `PASS=0 / CASE_FAIL=24 / RUNNER_ERROR=0 / BLOCKED=0`，两轮语义
  fingerprint一致。产品 Case 失败不被豁免，也不影响 Runner 完整性完成判断。
- `PERSIST-003`、`PERSIST-004`、`FIN-014`和Restart的事务证据来自对应 Case 的真实生产
  seam与隔离 Store，不再只由自测替代。
- 微信 WXML/真机、真实千问、120题全量、聚类报告和截图/Trace 文件输出均属于后续阶段。
