# Safe Local Receivable Route V1

## 1. Route政策

字段完整、语义明确且没有缺失字段、低置信、冲突或多业务混合的
`receivable/create_receivable`可以走`LOCAL`。LOCAL只表示无需AI即可进入Confirmation和
Domain Preflight，不代表自动保存、自动创建客户、自动关联订单或绕过安全检查。

不完整或存在冲突的待收款继续走`PENDING`；只有用户主动Deep Review后才进入
`AI_DEEP`。本政策不建立自动AI_DEEP，也不改变payment、deposit或dunning的Route。

## 2. 关系与Route分离

订单关系不参与Safe Local资格判断。明确订单指代和普通客户级待收款都可以是LOCAL，但
保存资格不同：

- 没有结构化明确订单指代Evidence：可以按客户级待收款继续Preflight；
- 有明确订单指代Evidence：必须由Domain Preflight要求用户确认合法订单关系；
- 未选择订单时Route仍为LOCAL、AI调用仍为0，但正式保存被阻断；
- 选择后必须基于最新State重新Preflight。

唯一或多个候选都不能自动写入`orderId`。

## 3. BASIC-009与BASIC-010

`BASIC-009`“刘姐那批货还欠3200元，7月31日前收”没有明确订单实体指代，实际为
`LOCAL / AIRequestCount=0`，不要求`SELECT_ORDER`，保存为客户级待收款。

`BASIC-010`“王总收纳盒这单还有8000元待收，7月25日收”包含结构化
`EXPLICIT_ORDER_DEICTIC` Evidence。实际仍为`LOCAL / AIRequestCount=0`，但选择前由
Preflight要求`SELECT_ORDER`；真实`changeOrder()`确认`ord-active-a`后重新Preflight并
解除关系阻断。

详细关系门禁见`docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md`，语言Evidence合同见
`docs/RECORD_ORDER_REFERENCE_EVIDENCE_V1.md`。
