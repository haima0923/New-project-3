# Record Local Order Signal Boundary V1

## 1. 范围

本阶段只修复：

```text
REC-E2E-AMB-005
```

目标是让孤立汉字“出”及由它组成的普通表达不再凭空产生order。明确下单、订单实体、
商品数量价格与受约束交付短语仍沿用既有合同。未修改Route、AI parser/normalizer、
Domain Preflight、页面、business、Storage、Coordinator或120题业务Expected。

## 2. AMB-005准确合同与旧Evidence

原文：

```text
今天天气不错，晚点出去走走
```

Case为P1、TYPED_TEXT、HOME_QUICK、空State。合同要求raw为`unknown/null`，规范化语义为
NO_RECORD，不调用AI，不保存正式或待整理记录，全部State集合保持不变。

修复前动态Evidence为：

```text
scores.order = 1
其他intent score = 0
orderPositiveSignals = []
winningIntent = order
winningReason = HIGHEST_INTENT_SCORE
```

静态代码确认唯一加分来自通用订单评分中的裸`/出/`。对应源码字符是“出去”的第一个字，
span为`[9,10)`；它没有客户、商品、数量、价格、金额或订单实体支持。120条ACTIVE中没有
合法订单以“出”为唯一Evidence，唯一含“出”的核心题就是AMB-005。

## 3. 新订单信号边界

订单不再从单字“出”或“拿”获得独立分数。以下短语不会仅因字符“出”创建订单：

```text
出去 / 出门 / 出差 / 出现 / 出错
发出去 / 拿出去 / 说出去
报价出了吗 / 货款打出去了 / 出库 / 准备出货 / 出口报价
```

明确订单仍由短语级或既有业务组合Evidence支持：

```text
下单 / 正式下单 / 订货 / 要货
订单 / 这单修改
先做 / 做货 / 生产 / 排产 / 返单
```

`intent_evidence`新增两类只读审计字段：

```text
orderEntitySignals
orderDeliverySignals
```

`订单`记录为`ORDER_ENTITY_EXPLICIT`。日期交付简写只在完整短语边界上记录为
`ORDER_DELIVERY_CONTEXTUAL_PHRASE`，例如“周五出”。日期与“出”之间只接受既有交付
修饰词（如“上午、能、安排”），不再接受任意字符；“周五出去走走”不会匹配。
“周五不出、先不出、不能出、还没出、没法出、无法出、来不及出”等否定交付span也
会被排除，不能提供订单分数。

## 4. 受约束交付与模糊口语

项目既有语料使用“挂件3000个、钥匙扣2000个，周五出”表达交付。该能力没有被删除，
但“日期 + 出”只有在同时存在商品、数量，并具备明确价格或多商品数量结构时才参与订单
评分。

以下模糊表达没有现成产品合同，因此不再仅凭“出”判为订单：

```text
给王总出500个
明天出一批
先出300个
```

它们保持unknown或当前其他安全语义。本阶段没有为生产、发货或待办发明新业务类型，也
没有通过统一降低confidence把它们交给AI。

## 5. AMB-005实际结果

修复后生产等价链：

```text
raw parser = unknown / operation null
raw confidence = 0.65
scores.order = 0
orderPositiveSignals = []
orderEntitySignals = []
orderDeliverySignals = []
safetyStatus = NO_RECORD
route = PENDING
AI request count = 0
semantic businessType = unknown
semantic effectiveOperation = unresolved
outcome = BLOCKED
formal/pending save = false/false
业务State Diff = 0
```

Case不再以`LOCAL_PARSE_ERROR/CONFIRMED_LOCAL_PARSER_DEFECT`失败。当前最早差异推进为
`ROUTE_ERROR`：生产Route仍为PENDING，而Case规范层期望NO_RECORD；Domain Preflight
还把unknown映射为pending/unresolved。这是独立非Parser边界，本阶段没有修改。顶层
合同按阶段顺序把Route列为primary；页面观察Lane仍保留`effectiveOperation=unresolved`
对应的局部语义差异，不能据此把已经通过的raw parser重新归为Parser缺陷。

## 6. 专项与保护回归

Order Signal Boundary专项：

```text
普通非业务语境             11
商业非订单语境             15
明确订单保护                8
受约束日期交付保护           3
混合语境                    6
模糊口语                    4
unknown有效日期保护          1
quotation/receivable/payment保护 4
```

`BASIC-006`和`BASIC-010`继续PASS；`BASIC-012`与`PAGE-003`保持既有AI Normalize和
Preflight差异。8条正常订单保护及16条多商品核心Case保持原状态和最早失败层。
`REL-008`、`VOICE-004/006`、`AMB-011`、`PAGE-008`责任与安全结论未变化。

Parser Invocation Graph 21/21、Runner Kernel 71/71、全量报告17/17、
Page Action 14/14、SELECT_ORDER 15/15、Quotation Candidate 22/22、
SELECT_QUOTATION 23/23、Home Primary Item 16/16、Release A RC1 16/16、
Domain Preflight 28/28、Shared Confirmation 16/16、Record Flow Gate 50题/99入口、
五步用户测试28/28及离线门禁15/15均通过。

## 7. 120题重基线

两轮均为：

```text
ACTIVE        120
PASS           13
CASE_FAIL     107
RUNNER_ERROR    0
BLOCKED         0
```

总PASS不变，因为AMB-005继续暴露独立Route合同差异。Failure Stage从
`LOCAL_PARSE_ERROR 7 / ROUTE_ERROR 42`变为`6 / 43`；
`CONFIRMED_LOCAL_PARSER_DEFECT`从1降为0，`UNCLASSIFIED_REQUIRES_REVIEW`从95升为96。
63条P0失败全部单题重跑，P1分层抽查13条，28个Cluster覆盖107/107。

两轮确定性一致。real network、unknown fake route、真实wx Storage、宿主文件Storage、
fixture mutation、跨Case污染、Journal、Backup、parser Evidence missing、orphan、
uncorrelated、shadow调用和未执行隔离审计全部为0；统一离线入口报告network guard
attempt为0。

新增的`orderEntitySignals/orderDeliverySignals`是raw Evidence Schema字段，因此39条
已提交Case的`aiParseLogs`及其plan/receipt指纹发生机械变化。业务记录集合、全部120题的
business Diff、revision和提交语义均未改变；不能把这些技术Evidence指纹描述成位级不变。

## 8. 未完成范围

当前已没有已确认的本地Parser缺陷。`REL-008`、`VOICE-004/006`、`AMB-011`以及其他
AI Normalize、Route、Preflight和未分类Cluster不在本阶段处理范围。

生产继续为`LEGACY_ONLY`，Shared生产Commit关闭。未调用真实千问，未执行真实WXML页面
E2E，未上传，未push。
