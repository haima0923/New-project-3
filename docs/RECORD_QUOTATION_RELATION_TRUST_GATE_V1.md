# 报价关系信任门禁（V1）

## 1. 结论

明确“报价转订单”的`create_order`不能把AI建议、历史唯一候选或危险报价直接写入
`quotationId`。Domain Preflight只把用户通过真实`SELECT_QUOTATION`确认、并在最新State中
仍然安全的报价视为已解决关系。

信任顺序固定为：

```text
用户确认的安全选择 > LOCAL_PARSER结构化关系Evidence > AI关系建议
```

本门禁只处理明确报价关系的`create_order`。普通新建订单、报价、收款、待收款、定金、
待办及历史`update_order`兼容路径不受影响。

## 2. 输入与资格

Preflight直接消费Parser已经产生并贯穿Hybrid、Confirmation和Preflight输入的
`relationReferences.quotation`，不扫描`originalText`，不读取Case ID或Expected。
门禁要求Evidence满足：

- `entityType=QUOTATION`；
- `explicit=true`；
- `requiresResolution=true`；
- `evidenceSource=LOCAL_PARSER`；
- 当前operation为`create_order`。

AI结果中的`quotationId`、候选或关系文本只能作为不可信建议，不能自行成为已解析关系。

## 3. 最新State分类

Preflight按当前客户、报价状态、删除事实和既有转单关系重新分类：

| State事实 | 输出 | 保存资格 |
| --- | --- | --- |
| 一张或多张安全匹配报价 | 只暴露安全候选并要求`SELECT_QUOTATION` | 用户确认前阻断 |
| 唯一命名匹配但已转单、删除或失效 | 写入`rejectedQuotationReferences` | 不展示为候选，不解析 |
| 安全与危险同时存在 | 只展示安全候选 | 仍须用户选择 |
| 多张危险匹配 | 保持歧义，不猜具体目标 | 阻断，不自动选择 |
| 无合法匹配 | 关系未解决 | 阻断 |

即使只有一张安全报价也不能自动选择。用户选择后仍须在最新State复核客户一致、未删除、
状态可关联且尚未转成其他订单；确认字段为真但目标危险、跨客户或不存在时仍然拒绝。

## 4. ID信任边界

- `fields.quotationId`存在但没有真实用户确认：不得写入`resolvedRelations`，安全ID只能进入
  候选确认，危险、跨客户或不存在ID进入拒绝事实。
- AI建议的ID不得提升为用户选择。
- 只有真实页面选择方法产生确认、且最新State复核通过的安全ID，才以
  `USER_CONFIRMED_SELECTION`成为已解决关系。
- 危险报价的商品、价格、数量等字段不得继承到订单草稿。
- `update_order`保留既有历史报价关系的兼容语义，不要求重新选择，也不允许重绑到危险报价。

## 5. REL-008证据

原文“把王总那个保温杯报价再转成订单”保留本地
`EXPLICIT_QUOTATION_NAMED_REFERENCE`，并在真实页面触发一次Deep Review：

```text
Route = AI_DEEP
AIRequestCount = 1
selectedQuotationId = ""
quotationSelectionConfirmed = false
safeQuotationCandidateIds = []
rejectedQuotationReferences = [quo-syn-a-1 / QUOTATION_ALREADY_CONVERTED]
quotationRelationGate.status = DANGEROUS_REFERENCE_REJECTED
quotationRelationGate.resolved = false
requiredSelections = []
domainCanSaveFormal = false
outcome = BLOCKED
formal/pending save = false
business diff = 0
```

已转报价既不进入安全候选，也不写入`quotationId`，更不会被AI或唯一历史匹配自动提升。

## 6. 回归与证据边界

专项结果：报价候选38/38、真实报价选择25/25、Domain Preflight 28/28、Runner Kernel
78/78、离线守卫15/15、Release A RC1 16/16。

120题离线双轮均为：

```text
ACTIVE=120
PASS=26
CASE_FAIL=94
RUNNER_ERROR=0
BLOCKED=0
```

冻结HEAD的仓库外只读归档重跑为25/95。逐题比较只发现REL-008由
`AI_NORMALIZE_ERROR / fields.quotationId`变为PASS；其他119题的状态、最早失败层、
Route、AI次数和业务Diff不变。P0失败53条全部单题重跑，P1分层抽查11条，23个Cluster
覆盖94/94失败，隔离提交Lane保持88。

两轮网络、真实微信Storage、宿主文件存储、Fixture变更、跨Case泄漏、Parser调用图、
Journal/Backup均为0；以下报价关系硬门禁也均为0：

```text
unconfirmedQuotationIdAcceptedCount
aiQuotationIdPromotedCount
dangerousQuotationSelectedCount
dangerousQuotationFieldInheritanceCount
quotationAutoSelectionCount
quotationSelectionMissingCount
```

本阶段没有修改Parser、Route、AI Normalizer/Merge、页面、business、Storage/Coordinator、
Fixture或其他119题Expected；没有调用真实AI、真实网络或真实微信Storage。production保持
`LEGACY_ONLY`，`sharedProductionCommitEnabled=false`，本候选不是Release。
