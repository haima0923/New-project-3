# 首页单商品主商品同步 V1

## 1. 结论与范围

首页快捷确认卡的单商品人工编辑现在使用同一份业务商品数据：

```text
items[0] = 最终业务商品结构
顶层 productName / quantity / unit / unitPrice / amount = items[0] 的兼容展示投影
```

用户通过首页真实 `updateConfirmField()` 修改商品、数量、单位、单价或金额时，页面先在一份
新草稿中原子更新 `items[0]`，再同步顶层投影、计算既有派生金额，最后一次性更新页面并
重建 Confirmation 与 Domain Preflight。原始 parser 结果、`originalText` 和第二件及后续
商品不会被原地修改。

本阶段只修改首页单商品确认；没有修改完整输入页、parser、AI、Domain Preflight政策、
Legacy business、Storage、Coordinator、订单选择或报价选择。

## 2. 字段映射

| 用户编辑字段 | 顶层投影 | `items[0]`业务字段 | 规则 |
| --- | --- | --- | --- |
| 商品 | `fields.productName` | `fields.items[0].productName` | 两处使用同一用户新值 |
| 数量 | `fields.quantity` | `fields.items[0].quantity` | 使用既有数值校验 |
| 单位 | `fields.unit` / `priceUnit` | `fields.items[0].unit` / `priceUnit` | 使用既有单位标准化 |
| 单价 | `fields.unitPrice` | `fields.items[0].unitPrice` | 使用既有金额标准化 |
| 总金额 | `fields.amount` / `totalAmount` | `fields.items[0].totalAmount` | 遵守既有手工金额与派生金额优先级 |

数量或单价变化时，如果不存在明确 `statedAmount` 或用户手工确认的金额，继续按现有
`quantity × unitPrice`规则更新 `calculatedAmount` 和总金额。明确口述金额或人工修改金额
继续优先，不会被公式静默覆盖。

## 3. 原子编辑与用户确认

首页只对白名单中的主商品字段执行同步。每次编辑：

1. 安全复制当前草稿和唯一商品；
2. 标准化用户新值；
3. 更新 `items[0]`；
4. 从该商品同步顶层兼容字段；
5. 按既有政策更新派生金额；
6. 只把用户实际编辑字段加入 `manual_fields`；
7. 一次性 `setData`；
8. 重建首页 Confirmation 和 Domain Preflight。

该过程不清空无关 `low_confidence_fields`、字段冲突、缺失字段或关系阻断，也不改变
Fake/Replay生产资格。

## 4. 保存前一致性门禁

首页正式保存前会再次比较单商品顶层投影与 `items[0]`，至少覆盖商品、数量、单位、单价
和金额。任何不一致或非法数量/单价都会阻断正式保存，不能把两份冲突数据交给 business
自行选择。

这道门禁是防御性检查，正常路径仍依赖编辑时的正确原子同步。

## 5. 多商品保护

该同步只适用于 `items.length === 1`。多商品或缺少标准主商品时：

- 首页不覆盖 `items[0]`；
- 不删除第二件及后续商品；
- 不把多商品压成顶层单商品；
- 保持完整页处理政策；
- 首页主商品编辑不会产生部分更新。

## 6. `REC-E2E-PAGE-008`证据

修复前，首页顶层字段被真实页面方法更新，但 `items[0]`保留旧值，最早失败层为
`CONFIRMATION_ERROR`。

修复后，真实编辑链的逐步证据为：

| 步骤 | 顶层字段 | `items[0]` | 金额 |
| --- | --- | --- | ---: |
| 初始 | 帆布袋 / 100 / 6 | 帆布袋 / 100 / 6 | 600 |
| 改商品 | 保温袋 / 100 / 6 | 保温袋 / 100 / 6 | 600 |
| 改数量 | 保温袋 / 150 / 6 | 保温袋 / 150 / 6 | 900 |
| 改单价 | 保温袋 / 150 / 8 | 保温袋 / 150 / 8 | 1200 |

`originalText`始终保留为原始输入，`finalLegacyDraft`也使用同步后的新值。
`PAGE-008`不再因`HOME_PRIMARY_ITEM_NOT_SYNCED`或等价Confirmation差异失败，当前最早
差异转为`LOCAL_PARSE_ERROR`。

该题仍被既有安全规则阻断：订单交期缺失，且人工改成的商品没有原始输入证据。Runner
没有绕过Preflight执行隔离提交，正式业务Diff为零，`finalSavedRecord`为空。因此当前只
确认页面模型和最终Legacy草稿已同步，不能声称这组数据已写入最终订单。

## 7. Runner证据

首页编辑Evidence现在逐步记录：

```text
topLevelBeforeEdit
itemBeforeEdit
topLevelAfterEachEdit
itemAfterEachEdit
derivedAmountAfterEachEdit
confirmedFieldsAfterEdit
preflightAfterEdit
finalLegacyDraft
finalSavedRecord
```

Runner仍调用真实首页方法，不直接修改`page.data`。所有一致性判断来自每次方法调用后的
页面状态，不使用Expected生成Actual。

## 8. 验证结果

- 首页主商品同步专项：16/16。
- Runner Kernel自测：50/50。
- `PAGE-008 --repeat 2`：两轮一致，`CASE_FAIL/LOCAL_PARSE_ERROR`，
  `RUNNER_ERROR=0 / BLOCKED=0`。
- 120条核心题双轮：两轮均为
  `PASS=4 / CASE_FAIL=116 / RUNNER_ERROR=0 / BLOCKED=0`。
- 65条P0失败全部单题重跑，P1分层抽查10条，均与全量一致。
- 当前Cluster为37个，覆盖116/116；首页主商品不同步Cluster已移除。
- 两轮网络、真实Storage、fixture mutation、跨Case泄漏、Journal和Backup均为0。

完整脱敏报告只写入仓库外：

```text
/private/tmp/record-e2e-home-primary-item-sync-v1.json
```

该临时文件不提交Git。

## 9. 尚未解决

- `REL-007/008`的AI Normalize差异；
- `BASIC-010`及其他本地解析operation/字段差异；
- `PAGE-008`当前暴露的本地operation和订单必填安全差异；
- 其他尚未判责的解析、AI、Route、Preflight和State Diff Cluster。
