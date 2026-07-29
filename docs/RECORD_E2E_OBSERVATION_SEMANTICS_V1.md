# 记一笔 E2E 观察语义 V1

## 1. 目的与边界

Headless E2E 不再把 parser 原始返回、页面/领域层确定的业务语义、保存前业务提案和最终
持久化结果压在同一份 `expected.result` 中。V1.2 Case 合同将它们拆为四层：

```text
rawParser → semanticResult → proposal → outcome
```

本阶段只修改 E2E Schema、Case、Validator、Runner、报告和测试文档。没有修改 parser、
AI、Route、页面、Confirmation 生产实现、Domain Preflight、business 或 Storage，也
没有降低客户、商品、交期、金额和关系安全规则。

## 2. 四层合同

### 2.1 `rawParser`

`rawParser` 是实际本地 parser 调用图，不再假设一个 Hybrid 只调用一次 Raw Parser。
它记录总体状态、Hybrid 调用、Direct Raw 父调用、每个 Raw 子调用、父子关系、稳定序号、
输入指纹、调用角色、结果摘要和异常。完整聊天原文不会复制进调用图。

总体状态严格区分：

- `RAW_PARSER_INVOKED`：至少一条真实 Raw 调用已完整采集；
- `RAW_PARSER_NOT_INVOKED_BY_PRODUCTION_PATH`：监控完整且真实调用为零；
- `RAW_PARSER_INVOCATION_FAILED`：真实调用开始后异常；
- `RAW_PARSER_EVIDENCE_MISSING`：监控、父子关联或采集完整性无法证明，必须是 Runner Error。

普通用户 E2E 使用 `EVIDENCE_ONLY`。只有显式声明 `assertionScope=REQUIRED` 的五条 parser
保护题才以对应 Hybrid 的 canonical local Raw 结果判分。不得默认取第一条或最后一条
Raw 调用，也不得补跑 shadow parser。

普通生产页面路径明确禁止`Direct Raw`父级；只有独立parser专项合同可显式声明允许。
分支依赖页面出现0次调用时，必须由注册表和实际页面状态共同证明为无业务确认分支，否则
以`UNRESOLVED_ZERO_PARSER_INVOCATION`硬失败。parser或后续Lane抛错时，已完成的调用图会
随Worker错误一并返回，隔离审计继续在finally完成。

### 2.1.1 Hybrid/Raw 调用图

Instrumentation 在生产 `utils/ai-parser.js` 加载前安装，以 Node 内置
`AsyncLocalStorage`关联异步父子调用。采集过程只记录开始、结果/异常和 finally 完成；
数量、角色和路径验证在采集完成后执行，因此验证失败不会再次清空已经取得的 Evidence。

`REC-E2E-MULTI-009` 的真实链为：

```text
FULL_PAGE / CLIPBOARD_CHAT
→ pasteClipboard()
→ readClipboardToInput()
→ runParse()
→ parseHybridInput(INITIAL_PARSE)
→ requestDeepReview()
→ runParse()
→ parseHybridInput(DEEP_REVIEW)
```

输入包含三条聊天消息。每个 Hybrid 的 Raw 调用数来自当前生产实现：

```text
1 次整段 primary local parse
+ 3 次单价冲突扫描
+ 3 次数量冲突扫描
+ 3 次最新单价扫描
+ 3 次最新数量扫描
= 13 次
```

因此该题实际为 `2 Hybrid / 26 Raw`；两组结构和指纹序列相同、Hybrid ID不同，
`orphan/uncorrelated/shadow=0`。`13`不是全局固定产品合同，而是
`1 + 4 × 当前非空聊天消息数`这一生产实现结构的动态基数。

### 2.2 `semanticResult`

`semanticResult` 是生产链在 Confirmation/Domain Preflight/normalized result 中实际
确定的 canonical 业务语义：

```text
businessType
effectiveOperation
source
```

Runner 优先读取实际 Domain Preflight 或页面 Confirmation 结果，不根据输入关键词重建
规则。例如 raw 为 `order/null`，Domain Preflight 实际给出
`order/create_order`，两份证据同时保留。

明确别名只有集中且可测试的两类：

- `dunning` intent 投影为 `todo/create_todo`；
- 真正无业务记录时投影为 `unknown/none`。

raw 的空 operation 不会全局映射为 semantic `none`。

### 2.3 `proposal`

`proposal` 表示安全处置前，实际页面或 Headless 确认草稿提出的业务：

```text
businessType
operation
source
```

缺客户、缺字段或低置信的订单仍可提案为 `order/create_order`。最终进入待整理不会把
proposal 或 raw business type 倒灌为 `pending`。

### 2.4 `outcome`

`outcome` 只从实际 Commit、Receipt、State Diff 和保存决策产生：

```text
disposition
persistedRecordType
formalSaveSucceeded
pendingSaveSucceeded
actualSource
```

Disposition 为：

- `FORMAL_RECORD`：实际产生正式业务记录；
- `PENDING_NOTE`：实际只产生待整理；
- `NO_RECORD`：明确不生成记录；
- `BLOCKED`：安全或执行决策阻断，未产生正式记录。

`persistedRecordType` 必须由实际 State Diff 得到，不能根据 Expected 或 business type
猜测。

## 3. 断言与失败阶段

普通 E2E 默认断言 `semanticResult`、`proposal`、`outcome` 和 State Diff。raw evidence
仍完整输出，但 raw operation 为空不再单独触发 `LOCAL_PARSE_ERROR`。

`LOCAL_PARSE_ERROR` 只保留给明确要求 raw parser 正确的题，或 raw 错误使 Route/后续
生产链无法修正的题。AI 若真实修正本地结果，整题不能继续因本地 raw 差异失败。主失败
会移动到下一处实际差异，例如 Route、Preflight、Confirmation 或 State Diff。

Validator 同时强制：

- 新 canonical business type 不能是 `pending`；
- `PENDING_NOTE` 必须有 pending Diff 且正式业务 Diff 为零；
- `FORMAL_RECORD` 必须有正式 Commit/State Diff；
- `NO_RECORD` 不得有业务持久化；
- `BLOCKED` 不得有正式保存；
- raw、semantic、proposal、outcome 的 Expected 不得互相覆盖。

## 4. 25 条迁移结果

下表中的 raw、semantic、proposal、outcome 均来自实际执行证据。`null` 保留 parser 的
真实空 operation。

| Case | 迁移前主失败 | 迁移后结果/主失败 | raw | semantic / proposal | outcome | 剩余真实差异 |
| --- | --- | --- | --- | --- | --- | --- |
| BASIC-001 | LOCAL_PARSE | PASS | order/null | order/create_order | FORMAL order | 无 |
| BASIC-002 | LOCAL_PARSE | LOCAL_PARSE | order/null | order/create_order | FORMAL order | proposal.customerId |
| BASIC-003 | LOCAL_PARSE | ROUTE | order/null | order/create_order | BLOCKED | route |
| BASIC-004 | LOCAL_PARSE | PASS | order/null | order/create_order | FORMAL order | 无 |
| BASIC-005 | LOCAL_PARSE | PASS | order/null | order/create_order | FORMAL order | 无 |
| BASIC-007 | LOCAL_PARSE | LOCAL_PARSE | quotation/null | quotation/create_quotation | FORMAL quotation | proposal.customerId |
| BASIC-008 | LOCAL_PARSE | ROUTE | quotation/null | quotation/create_quotation | BLOCKED | route |
| BASIC-009 | LOCAL_PARSE | ROUTE | receivable/null | receivable/create_receivable | BLOCKED | route |
| BASIC-015 | LOCAL_PARSE | ROUTE | todo/null | todo/create_todo | BLOCKED | route |
| BASIC-016 | LOCAL_PARSE | LOCAL_PARSE | todo/null | todo/create_todo | FORMAL todo | proposal.customerId |
| REL-001 | LOCAL_PARSE | ROUTE | order/null | order/create_order | BLOCKED | route |
| DATE-002 | LOCAL_PARSE | PASS | order/null | order/create_order | FORMAL order | 无 |
| DATE-008 | LOCAL_PARSE | PASS | order/null | order/create_order | FORMAL order | 无 |
| PAGE-001 | LOCAL_PARSE | PASS | order/null | order/create_order | FORMAL order | 无 |
| PAGE-008 | LOCAL_PARSE | ROUTE | order/null | order/create_order | BLOCKED | route/交期合同 |
| BASIC-017 | LOCAL_PARSE | ROUTE | dunning/null | todo/create_todo | BLOCKED | route |
| BASIC-018 | LOCAL_PARSE | ROUTE | dunning/null | todo/create_todo | BLOCKED | route |
| AMB-012 | LOCAL_PARSE | ROUTE | unknown/null | unknown/none | BLOCKED | route |
| BASIC-019 | LOCAL_PARSE | PREFLIGHT | order/null | order/create_order | PENDING_NOTE | blockingCodes |
| BASIC-020 | LOCAL_PARSE | LOCAL_PARSE | order/null | order/create_order | PENDING_NOTE | proposal.productName |
| AMB-001 | LOCAL_PARSE | LOCAL_PARSE | order/null | order/create_order | PENDING_NOTE | proposal.productName |
| AMB-002 | LOCAL_PARSE | STATE_DIFF | order/null | order/create_order | PENDING_NOTE | operationLogs 映射 |
| AMB-008 | AI_NORMALIZE | ROUTE | order/null | order/create_order | PENDING_NOTE | route |
| AMB-014 | LOCAL_PARSE | LOCAL_PARSE | order/null | order/create_order | PENDING_NOTE | proposal.productName |
| AMB-015 | AI_NORMALIZE | ROUTE | order/null | order/create_order | PENDING_NOTE | route |

25 条中 6 条转为 PASS；19 条仍为 `CASE_FAIL`，但已移动到下一处真实差异。所有 7 条
待整理题实际只新增一条 pending note，正式业务 Diff 为零。

## 5. 保护 Case

以下真实问题没有被观察语义映射隐藏：

- `BASIC-006`、`BASIC-010`、`AMB-005`、`BASIC-012`、`PAGE-003`：
  `CONFIRMED_LOCAL_PARSER_DEFECT/HIGH`；
- `REL-008`：`CONFIRMED_OPERATION_MAPPING_DEFECT/HIGH`；
- `VOICE-004`：`CONFIRMED_ROUTE_DEFECT/HIGH`；
- `VOICE-006`：异步观测候选；
- `AMB-011`：超时测试合同候选。

`PAGE-008` 的首页顶层/`items[0]`同步已经通过；当前 raw 为 `order/null`，semantic 为
`order/create_order`。原文缺交期，Preflight 返回 `MISSING_REQUIRED_FIELD`，正式 Diff
为零。因此其当前主失败是 Route/合同候选，不是 raw 空 operation，也没有绕过交期保存。

`BASIC-010` 的原文包含“还有8000元待收”，本地链仍未正确识别待收金额与意图，Route
为 PENDING，正式 Diff 为零；它继续是高置信本地 parser 缺陷，不能由 semantic 投影伪装
成 receivable。

## 6. 当前确定性基线

最终 120 条核心题执行两轮，结果完全一致：

```text
PASS          10
CASE_FAIL    110
RUNNER_ERROR   0
BLOCKED        0
```

65 条 P0 失败全部单题重跑，P1 分层抽查 13 条；31 个 Cluster 覆盖 110/110
`CASE_FAIL`。两轮的 parser 调用图数量、阶段、父子关系和输入指纹序列一致；120题中
合法零Raw调用路径为0。网络、未知 Fake Route、真实 wx Storage、宿主文件 Storage、
fixture修改、跨 Case 污染、Journal、Backup、parser evidence missing、orphan、
uncorrelated、shadow 和未执行隔离审计计数均为零。

Parser Invocation Graph专项21/21、Runner Kernel自测68/68、全量/报告自测17/17通过。

这是 Local/Fake/Replay Headless 基线，不是真实千问质量测试，也不是微信 WXML/DOM E2E。
