# 记一笔解析日志 Envelope 所有权 V1

状态：候选合同，未发布。

本合同限定 `aiParseLogs` 的写入所有权。它记录一次原始输入及其解析结果进入顶层确认保存流程的审计 Envelope，不是订单、付款或定金等子实体各自的 provenance 日志。

## 1. 基本规则

```text
one original input
+ one confirmation/save plan
+ one transaction receipt
→ one aiParseLog
```

一个顶层保存即使同时创建客户、订单和定金付款，也只写一条解析日志。日志保留完整 `originalText` 和完整 `parseResult`，因此不会因关闭嵌套子日志而丢失定金金额或业务语义。

这不是全局文本去重：两次真实、独立的用户确认即使文本相同，仍分别拥有各自的顶层 Envelope。实现不得根据 Case ID、原文内容或提交后的状态删除日志。

## 2. 订单加定金

订单顶层保存拥有唯一日志：

```text
saveOrder(top-level)
→ saveOrderDeposit(nested, emitAiParseLog=false)
→ append save_order
```

正确 Diff 为：客户 `+1`、订单 `+1`、定金付款 `+1`、`aiParseLogs +1`。唯一日志的 `action` 为 `save_order`，其 `parseResult` 继续包含 `depositAmount/paymentAmount`。

Legacy 路径仅由 `saveOrder()` 的结构化内部参数关闭嵌套定金日志；`saveOrderDeposit()` 默认仍拥有日志。Shared SavePlan 只在订单顶层分支加入一条 `AI_PARSE_LOG/save_order` operation，定金 payment 和 order progress operation 不再创建第二条日志。

## 3. 独立定金保护

Standalone Deposit 没有外层订单保存，因此保持：

```text
saveOrderDeposit(top-level/default)
→ aiParseLogs +1
→ action = save_order_deposit
```

已关联订单、付款类型、金额、关系、revision 和 receipt 合同均不因日志所有权调整而变化。未关联定金的既有 `save_unlinked_order_deposit` 行为也保持默认日志所有权。

## 4. 事务、重放与首页

- 唯一日志和客户、订单、付款处于同一 Shared MemoryStore 事务。
- customer、order、payment、日志前后、事务后置 readback、invariant 与 atomic swap 失败均必须完整回滚；不留下部分业务记录、日志或 receipt。
- 同一 plan、同一 idempotency key 或已提交 receipt 重放不新增业务记录或解析日志。
- 首页“最近记下的”继续只读取 `aiParseLogs`；订单加定金的原始输入只出现一次，不修改首页生产代码。

## 5. BASIC-014证据

原文：

```text
孙老板订1000个卡套，5元一个，已付定金1000元，7月28日交
```

离线结果：Route 为 `AI_DEEP`，Fake Deep 请求恰好1次；语义为 `order/create_order`。隔离提交创建客户1、订单1、定金付款1，定金关联新订单，`aiParseLogs`仅创建1条且 `action=save_order`，`operationLogs=0`，revision与receipt各1。

Fake Provider继续不具备生产保存资格：Surface为 `BLOCKED`，业务能力为true，effective正式保存资格为false，生产页面/business/Storage写入为0。隔离提交只用于验证业务保存合同。

## 6. 离线回归基线

120条ACTIVE Case双轮一致：

```text
PASS          19
CASE_FAIL    101
RUNNER_ERROR   0
BLOCKED        0
SURFACE_ERROR  6
```

与18/102冻结基线逐题比较，只有BASIC-014从`CASE_FAIL / SURFACE_ERROR`变为PASS；其他119条的状态、最早失败层、Route和业务Diff不变。`TEST_ONLY_ISOLATED_LEGACY_COMMIT` Lane总数仍为88。

网络、真实微信Storage、fixture mutation、跨Case泄漏、Journal/Backup、Parser Graph、Voice Evidence与重复Voice Standard AI门禁均为0。专项证明 `duplicateCompositeParseLogCount=0`、`standaloneDepositParseLogMissingCount=0`。

本阶段未修改AI、fixture、Parser、Preflight、页面、首页生产逻辑、日志Schema、Storage/Coordinator核心或Shared生产可达性。production仍为`LEGACY_ONLY`，`sharedProductionCommitEnabled=false`。
