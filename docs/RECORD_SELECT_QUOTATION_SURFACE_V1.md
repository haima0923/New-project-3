# 完整页安全报价选择 V1

## 1. 范围与结论

完整输入页已经实现通用报价选择交互，但不自行判断报价是否安全。页面只消费 Domain
Preflight 的：

```text
domainPreflight.candidates.quotationSelectionCandidates
```

页面没有扫描全部报价生成候选，没有读取 AI fixture 的 `quotation_candidates`，也没有
“最近报价”“名称最像”或自动选择第一张等新政策。生产继续保持 `LEGACY_ONLY`，Shared
生产 Commit 继续禁用。

本阶段是 Node Page VM 对真实页面 JS 方法的 Headless 验证，不是微信 WXML/DOM 页面
E2E，也没有调用真实千问。

## 2. 显示与页面状态

完整页使用以下状态：

```text
quotationCandidates
quotationOptions
selectedQuotationId
selectedQuotation
quotationSelectionRequired
quotationSelectionReason
quotationSelectionConfirmed
```

候选只保留安全展示投影：报价 ID、客户 ID/称呼、商品摘要、商品数、金额、状态、
报价日期、有效期和创建时间。页面不会把完整报价对象、聊天原文、手机号、地址或内部日志
绑定到 WXML。

选择区仅在以下情形显示：

- Preflight 要求 `quotationId`；
- Preflight 的阻断动作是 `SELECT_QUOTATION`；
- 当前草稿已经有一个合法、已确认的报价关系。

仅仅存在历史报价不会显示选择区，也不会强迫明确新报价或没有历史引用的新订单关联旧
报价。唯一安全候选也不会自动选择。

## 3. 选择、取消与改选

真实页面方法为：

```text
changeQuotation()
selectQuotationCandidate()
applyQuotationSelection()
clearQuotationSelection()
```

选择时先用最新 State 重建 Confirmation 和 Domain Preflight，再确认传入 ID 仍位于
安全候选中。接受后，稳定 `quotationId` 写入页面确认草稿，
`quotationSelectionConfirmed=true`，并再次重建 Preflight 和 Surface。

选中历史报价时，页面以该报价的现有商品明细为底稿，再合并老板原话和确认卡中的明确
修改；稀疏更新草稿不能把历史 `items[]` 覆盖为空。`originalText` 和完整 `items[]`
继续保留。

取消选择会清除 `quotationId`、确认标记和 resolved relation，并重新恢复
`QUOTATION_TARGET_REQUIRED` 阻断。改选时先回到不含旧关系的 base fields，再验证和
写入新报价，不残留旧报价 ID 或转换关系。

## 4. 动态变化与保存前复核

选择报价后，修改客户会立即清除旧报价关系；修改 operation、业务类型或影响关系合法性
的字段会重新计算 Preflight。页面不会静默替换成另一张报价。

正式保存仍使用完整页原有 `saveFormal()` 链。保存前它重新读取最新 State、重建
Confirmation 和 Domain Preflight，因此以下变化都会阻断保存：

- 报价被删除；
- 报价状态变为不可用；
- 报价被另一操作转成订单；
- 客户与报价不再一致；
- operation 不再允许该关系；
- 报价不再属于安全候选或合法已确认关系。

## 5. 危险事件防护

`applyQuotationSelection()` 不接受任意事件 ID。以下 ID 即使通过伪造事件传入也会被
拒绝，且不会改变 selected ID 或草稿：

- 其他客户的报价；
- 已转订单的报价；
- 已删除报价；
- 非活动报价；
- 不在本次 Preflight 安全候选中的报价。

`REC-E2E-REL-007` 和 `REC-E2E-REL-008` 继续是
`RELATION_REFERENCE_TAMPER_GUARD`，不会通过 picker 注入危险关系。它们的安全 Lane
继续验证 `QUOTATION_CUSTOMER_MISMATCH`、`QUOTATION_ALREADY_CONVERTED` 和零正式
副作用。

## 6. 两条合法补充 Case

两条合成 P0 Case 独立存放在
`tests/record-e2e/cluster-cases/select-quotation-v1.json`，不计入120条核心题：

| Case | 场景 | 页面选择证据 | 当前整体结果 |
| --- | --- | --- | --- |
| `REC-E2E-QSEL-001` | 同客户两张安全报价，选择第二张 | 页面展示两张安全报价；真实调用 `changeQuotation`；草稿写入 `quo-syn-a-2`；商品、数量、价格和 `items[]` 保留 | `CASE_FAIL/PREFLIGHT_ERROR` |
| `REC-E2E-QSEL-002` | 安全与跨客户、已转、删除报价并存 | 页面只展示 `quo-safe-a`；危险 ID 的页面伪造选择专项全部拒绝；草稿写入安全 ID | `CASE_FAIL/PREFLIGHT_ERROR` |

两题双轮确定性一致，`RUNNER_ERROR=0`、`BLOCKED=0`。当前 Case FAIL 来自既有最终解析
安全仍保留 `LOW_CONFIDENCE_FIELD`，导致隔离提交未执行；页面候选、真实方法调用、关系
绑定和 `items[]` 均符合合同。正确的正式提交 Expected 没有被放宽，这个上游解析/安全
差异不在本 Cluster 修复。

## 7. 回归结果

专项结果：

```text
安全报价候选真值源       22/22
完整页报价选择            20/20
完整页订单选择            15/15
Page Action Registry      13/13
```

核心120条重新执行两轮：

```text
ACTIVE       120
PASS           4
CASE_FAIL    116
RUNNER_ERROR   0
BLOCKED        0
```

两轮确定性一致；65条P0失败全部单题重跑，P1分层抽查10条一致。报价 UI 没有改变核心
120题统计，因为其中没有合法 `SELECT_QUOTATION` 用户选择题；REL-007/008仍是危险关系
测试。

`SELECT_ORDER` 15/15 保持通过。`PAGE-008`、金融、持久化和生产模式没有改变。

## 8. 未完成范围

- `PAGE-008` 首页顶层字段与 `items[0]` 同步问题未修；
- REL-007/008 的 Case 整体仍有既有 AI Normalize 差异；
- 两条合法报价选择补充题暴露的最终解析低置信度差异未修；
- 没有真实千问质量测试；
- 没有微信 WXML/DOM 页面自动化或体验版真机验收。
