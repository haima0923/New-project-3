# Record Local Quotation Negation Parser V1

## 1. 范围

本阶段只修复：

```text
REC-E2E-BASIC-006
```

目标是让明确报价请求中的被否定订单动作不再参与order评分。订单否定只抑制订单候选，
不能独立创建quotation。未修改Route、AI parser/normalizer、Domain Preflight、页面、
business、Storage、Coordinator或120题业务Expected，也未处理`REC-E2E-AMB-005`。

## 2. BASIC-006准确合同

原文：

```text
给郑老板报挂件3000个，1块5一个，还没下单
```

合同字段：

```text
customer = 郑老板
product = 挂件
quantity = 3000
unit = 个
unitPrice = 1.5
amount = 4500
businessType = quotation
effectiveOperation = create_quotation
route = LOCAL
```

旧parser同时把“下单”按数量、商品和动作规则累计为order，却没有把“还没下单”识别成
被否定的订单动作；最终raw为`order/null`，Route为PENDING，订单又因缺交期被Preflight
阻断。Expected quotation有独立“给郑老板报……”和完整数量/单价证据，不是由“还没下单”
凭空产生。

## 3. 窄规则

parser分别记录：

```text
quotationPositiveSignals
quotationNegationSignals
orderPositiveSignals
orderNegationSignals
reaffirmedOrderSignals
winningIntent
winningReason
```

quotation正向证据包括明确“报价、报个价、问价、询价”等表达，也保留项目已有的
“报 + 商品数量 + 明确价格”组合证据。

“单价”继续保留为既有价格字段Evidence，但它不是足以压过下单、交期等订单事实的强报价
动作；“要做水杯，单价5元”和“要500个，7月20日交，单价6元”仍保持原订单候选。

quotation也有独立否定Evidence。“不报价、先不报价、不是报价”会过滤对应报价信号；
上下文单字“报”只在商品数量与明确价格同时存在、且后字不是“告、废、销、名、警、表、
税、关、到”等非报价词时成立。因此“报废水杯”“报告成本”不会产生quotation。

订单否定只覆盖邻近订单动作，例如：

```text
还没下单
尚未下单
没有下单
未下单
暂时不下单
先不下单
不是下单
不要下单
别下单
没再下单
拒绝下单
没确认下单
没订货
没有要货
```

每条Evidence保存最小`sourceText`及`sourceSpan`。评分使用保持原长度的遮罩文本，只移除
被否定订单片段对order的贡献；客户、商品、数量、单价、金额和originalText仍从原输入
提取。

如果整句没有独立的重新肯定动作，明确订单否定会把order候选压到0。这样即使输入同时带齐
商品、数量、价格和交期，“没有正式下单”“尚未确认下单”也不会被内部“正式下单/
确认下单”子串重新肯定，更不会保存成正式订单。订单否定本身不给quotation加分，因此
“客户还没下单”“暂时不下单”“还没有下单记录”“不一定做”“不要记订单”都不会自动
变成报价。

## 4. 双重否定和转折

规则只在订单动作范围内处理当前合同所需的转折，不把“不是”做成全局否定词。

以下句子保留order：

```text
之前没下单，这次正式下单
虽然还没下单，但现在确认下单
还没下单的客户今天已经下单了
不是不下单，是现在就下单
不是没下单，是现在就下单
并非未下单，已经下单
还没下单，但先做100个
报价已确认，现在下单
不是报价，是正式订单
```

前一段否定Evidence仍保留，但后续独立“现在、这次、今天、已经、正式、确认下单”形成
`reaffirmedOrderSignals`；后续独立“先做/做货”等生产动作也保留为
`orderPositiveSignals`，order不会被前一段否定吞掉。双重否定Evidence与订单否定
Evidence不得共享span。“先报价，确认后再下单”仍按当前合同以当前报价动作作为主业务，
不把未来条件动作当成已下单事实。

这不是通用中文谓词极性重构。payment、终止语义和关系否定中的其他双重否定缺口不在本
Cluster范围内。

## 5. BASIC-006实际结果

修复后生产等价链为：

```text
raw parser = quotation / operation null
raw confidence = 0.96
quotation evidence = “报” [4,5)
order negation evidence = “还没下单” [19,23)
order score = 0
quotation score = 4
winningReason = EXPLICIT_QUOTATION_WITH_NEGATED_ORDER_ACTION
semantic operation = create_quotation
route = LOCAL
AI request count = 0
Preflight blockingCodes = []
domainCanSaveFormal = true
outcome = FORMAL_RECORD / quotation
```

隔离Legacy提交实际创建1个客户和1条报价，订单增量为0。报价保留：

```text
customer = 郑老板
product = 挂件
quantity = 3000
unit = 个
unitPrice = 1.5
amount = 4500
status = 待确认
originalText = 给郑老板报挂件3000个，1块5一个，还没下单
```

Case由`CASE_FAIL/LOCAL_PARSE_ERROR/CONFIRMED_LOCAL_PARSER_DEFECT/HIGH`变为`PASS`。

## 6. 专项与保护回归

Quotation Negation专项通过：

```text
明确报价 + 否定订单          8
正式订单/重新肯定保护         13
无报价需求保护               11
否定订单零正式保存            15
跨业务及历史语境保护            4
```

相邻E2E中，`BASIC-001/004/PAGE-001`继续PASS；`BASIC-007/008`、
`REL-001/002`、`CHAT-003/005/007/009`、`DATE-009`、`MULTI-008`、
`VOICE-007/008`等保持各自原主失败。`BASIC-010`继续PASS；
`BASIC-012`和`PAGE-003`分别保持AI Normalize与超额收款Preflight差异。
`PAGE-008`未绕过交期，`REL-008`、`VOICE-004/006`、`AMB-011`责任未变化。
`AMB-005`继续为`LOCAL_PARSE_ERROR/CONFIRMED_LOCAL_PARSER_DEFECT/HIGH`。

Parser Invocation Graph 21/21、Runner Kernel 71/71、全量报告17/17、
Page Action 14/14、SELECT_ORDER 15/15、Quotation Candidate 22/22、
SELECT_QUOTATION 23/23、Home Primary Item 16/16、Release A RC1 16/16、
Domain Preflight 28/28、Shared Confirmation 16/16、Record Flow Gate 50题/99入口、
五步用户测试28/28及离线门禁15/15全部通过。

## 7. 120题重基线

两轮均为：

```text
ACTIVE        120
PASS           13
CASE_FAIL     107
RUNNER_ERROR    0
BLOCKED         0
```

相对12/108冻结基线仅`BASIC-006`由失败转为PASS。`LOCAL_PARSE_ERROR`从8降至7，
`CONFIRMED_LOCAL_PARSER_DEFECT`从2降至1；其他Failure Stage与Ownership计数不变。
63条P0失败全部单题重跑，P1分层抽查13条，29个Cluster覆盖107/107条失败。

两轮parser调用图与业务Evidence完全一致。real network、unknown fake route、真实wx
Storage、宿主文件Storage、fixture mutation、跨Case污染、Journal、Backup、parser
Evidence missing、orphan、uncorrelated、shadow调用和未执行隔离审计全部为0。统一离线
入口额外报告network guard attempt为0。

## 8. 未完成范围

`REC-E2E-AMB-005`的单字“出”误触发order仍保留。`REL-008`、
`VOICE-004/006`、`AMB-011`以及其他AI Normalize、Route、Preflight和未分类Cluster未在
本阶段处理。

`server/utils/parser.js`是既有mock副本，本阶段未授权同步；其与微信端parser的长期一致性
属于独立单一真值源问题，不应在本Cluster顺手扩大。

生产继续为`LEGACY_ONLY`，Shared生产Commit关闭。未调用真实千问、未运行真实WXML页面
E2E、未上传、未push。
