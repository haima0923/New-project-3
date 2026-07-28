# 完整页通用订单选择能力 V1

## 1. 范围与结论

本阶段只补齐完整输入页的 `SELECT_ORDER` 产品能力：

```text
Preflight要求选择订单
→ 完整页展示合法候选
→ 用户真实选择、取消或改选
→ 页面确认草稿写入稳定orderId
→ 重新执行Domain Preflight
→ 保存前基于最新State再次复核
```

没有修改首页、parser、AI、Domain Preflight政策、business、Storage或Coordinator；
没有实现 `SELECT_QUOTATION`，也没有修复 `PAGE-008`。

## 2. 页面交互

候选区仅在Domain Preflight已经给出合法订单候选，且当前业务确实需要或允许显式订单
关系时显示。完整页使用真实Page方法：

- `changeOrder()`：处理picker选择；
- `selectOrderCandidate()`：复用候选ID安全校验的页面事件入口；当前可见选择控件使用picker；
- `clearOrderSelection()`：取消当前选择；
- `applyOrderSelection()`：执行统一的候选存在、状态和客户关系校验。

页面不会自动选择第一张订单。明确新建订单时，即使客户有历史订单，也不会出现通用订单
选择区。

候选投影只向WXML提供ID、客户显示名、商品摘要、商品数、金额、状态、交期和创建时间，
不会把完整业务对象或聊天原文放进页面。

## 3. 数据绑定与安全

页面状态包含订单候选、`selectedOrderId`、选中订单投影、是否必选及原因。选择成功后，
稳定ID写入当前确认草稿的订单关系字段，并立即重建Confirmation和Domain Preflight；
`originalText`和`items[]`保持不变。

每次选择及保存前都会从最新State重新确认：

- 订单仍存在且未删除；
- 状态仍可用于当前操作；
- 订单属于当前客户；
- ID来自当前Preflight允许的候选；
- 多候选要求已由用户明确完成；
- 当前operation允许该关联或更新。

伪造跨客户ID、失效订单和已被删除的订单均会被拒绝。取消选择会清空已解析关系并重新
触发Preflight；如选择仍属必填，正式保存重新阻断。

## 4. 目标Case

| Case | 修复前 | 当前结果 | SELECT_ORDER证据 | 正式业务副作用 |
| --- | --- | --- | --- | ---: |
| `REC-E2E-BASIC-010` | `SURFACE_ERROR / REQUIRED_PAGE_CAPABILITY_MISSING` | `LOCAL_PARSE_ERROR` | 完整页真实方法存在，Runner能力探测为true | 0 |
| `REC-E2E-REL-003` | `SURFACE_ERROR / REQUIRED_PAGE_CAPABILITY_MISSING` | `AI_NORMALIZE_ERROR` | 完整页真实方法存在，Runner能力探测为true | 0 |
| `REC-E2E-REL-009` | `SURFACE_ERROR / REQUIRED_PAGE_CAPABILITY_MISSING` | `AI_NORMALIZE_ERROR` | 完整页真实方法存在，Runner能力探测为true | 0 |

这三题不再因缺少 `SELECT_ORDER` 失败。它们的新失败属于更早的解析或AI标准化差异；
本阶段不扩大范围修复，也不修改Expected。

当前原始输入链中，`REL-003`已经实际显示选择控件并调用`changeOrder()`；`BASIC-010`和
`REL-009`分别在本地解析和AI标准化层提前失败，尚未形成可见订单控件。Runner会记录
`PAGE_INTERACTION_NOT_VISIBLE`或候选不存在，不再调用隐藏方法制造“已选择”证据。
页面专项测试另行证明：一旦生产确认草稿到达对应operation，合法订单可经真实picker进入
草稿，跨客户伪造ID则由真实页面方法拒绝。二者不改变`REL-009`的安全合同：如果parser或
AI已经产生跨客户关系，页面保留冲突草稿供Domain Preflight返回
`ORDER_CUSTOMER_MISMATCH`；用户不能通过候选控件新造这类关系，两层都会阻断保存。

## 5. 回归证据

订单选择专项测试15/15覆盖：

- 真实完整页方法与Runner能力探测；
- Preflight候选经真实`changeOrder()`进入草稿；
- update order选择后保留用户新交期；
- 跨客户伪造事件拒绝；
- 展示后删除和选择后删除；
- 保存前最新State复核；
- 取消、A/B改选、选中后改日期再改选/取消，以及客户变化失效；
- 明确新业务不显示旧订单；
- 从通用选择切换到订单定金时清理通用状态，保留既有定金选择器；
- Runner不会在选择控件隐藏时直接调用页面方法制造交互证据；
- `SELECT_QUOTATION`仍为未实现；
- WXML绑定存在且首页未修改。

全量120题双轮结果保持确定性：

```text
PASS          4
CASE_FAIL   116
RUNNER_ERROR  0
BLOCKED       0
```

总体数量未变化不表示能力未生效：三个目标Case已经离开Surface能力缺口，进入各自真实的
上游差异层；当前确认的页面能力缺口只剩两条 `SELECT_QUOTATION` Case。

## 6. 尚未解决

- `SELECT_QUOTATION`仍缺真实完整页交互；
- `PAGE-008`首页顶层字段与`items[0]`不同步仍存在；
- 解析、AI标准化、路由、Preflight和Expected映射的其他Cluster仍按全量基线保留。
