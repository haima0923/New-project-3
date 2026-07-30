# Receivable Order Relation Gate V1

## 1. 产品边界

普通客户级待收款不把`orderId`设为全局必填。只有同时满足以下条件才启用订单关系门禁：

```text
businessType = receivable
effectiveOperation = create_receivable
relation_references.order.entityType = ORDER
relation_references.order.explicit = true
relation_references.order.requiresResolution = true
```

Preflight只消费既有结构化Evidence，不扫描`originalText`，也不根据Case ID、Expected、
历史候选数量或商品匹配重新推导语言关系。

消费前还必须验证Evidence符合冻结合同：kind属于三种明确订单指代、来源为
`LOCAL_PARSER`、`resolvedEntityId=null`、sourceField和sourceSpan完整、最小sourceText与
normalizedReference非空且confidence有效。非本地、畸形或已解析伪结构不能触发门禁。

## 2. 门禁状态

| 状态 | requiredSelections | 保存资格 | 阻断码 |
| --- | --- | --- | --- |
| 有安全候选、尚未选择 | `orderId` | 阻断 | `ORDER_SELECTION_REQUIRED`或`MULTIPLE_ORDER_SELECTION_REQUIRED` |
| 没有安全候选 | `orderId` | 阻断 | `ORDER_REFERENCE_UNRESOLVED` |
| orderId不在安全候选中 | `orderId` | 阻断 | `ORDER_REFERENCE_NOT_ELIGIBLE` |
| orderId安全但未确认 | `orderId` | 阻断 | `ORDER_SELECTION_CONFIRMATION_REQUIRED` |
| 安全orderId且用户确认 | 空 | 继续其他Preflight | 无关系阻断 |

安全候选继续遵守已有客户一致、有效状态、未删除和商品关系约束。唯一候选也不会自动选择。
保存前由隔离提交入口重新读取最新State；选择后订单被删除、失效或不再匹配时必须阻断。

## 3. BASIC-010两阶段Evidence

选择前：

```text
route = LOCAL
AIRequestCount = 0
candidateIds = [ord-active-a]
selectedOrderId = ""
orderSelectionConfirmed = false
requiredSelections = [orderId]
blockingCodes = [ORDER_SELECTION_REQUIRED]
domainCanSaveFormal = false
effectiveCanSaveFormal = false
正式业务Diff = 0
```

Runner真实调用一次`changeOrder()`后：

```text
selectedOrderId = ord-active-a
orderSelectionConfirmed = true
requiredSelections = []
domainCanSaveFormal = true
effectiveCanSaveFormal = true
```

保存前Evidence标记`stateSource=ISOLATED_GATEWAY_REREAD`，再次确认订单仍为王总的有效
`ord-active-a`。最终新增一条8000元、预计收款日2026-07-25且关联该订单的待收款；
`originalText`保持不变，没有新增或修改订单，AI调用仍为0。

## 4. BASIC-009保护

`BASIC-009`没有同等级订单指代Evidence。即使客户存在历史订单、候选唯一或商品名称匹配，
也不要求`SELECT_ORDER`，不自动写入`orderId`，仍可按客户级待收款完成。

## 5. 测试与隔离

- Domain Preflight专项：28/28（含非本地、畸形和已解析Evidence拒绝消费）；
- Order Selection专项：15/15；
- Structured Order Reference Evidence专项通过；
- Receivable Parser和Payment Parser边界专项通过；
- Runner Kernel / Observation Semantics：70/70；
- Parser Invocation Graph：21/21；
- Offline Guard：15/15；
- 120题双轮均为`PASS=12 / CASE_FAIL=108 / RUNNER_ERROR=0 / BLOCKED=0`；
- 63条P0失败全部单题重跑，P1分层抽查13条；
- 两轮网络、真实wx Storage、宿主文件Storage、fixture mutation、cross-case leak、
  Journal/Backup、parser Evidence缺失、orphan、uncorrelated、shadow和隔离审计缺失均为0。

本阶段未修改parser、Route、页面、AI、business、Storage或120题核心Expected。
