# Record Local Payment Intent Parser V1

## 1. 范围

本阶段只修复两条已经确认的本地 parser 缺陷：

```text
REC-E2E-BASIC-012
REC-E2E-PAGE-003
```

两题都表达收款业务，但旧规则把普通订单关系词、否定关系说明或无关词内的“整”当成
订单证据，最终形成 `order` 草稿。此次未修改 Route、AI normalizer、Domain Preflight、
页面、business、Storage 或120题业务 Expected。

## 2. 原误判

`BASIC-012` 原文为：

```text
王总今天付了600元，这是零散款，不关联旧订单
```

旧评分中“付了”只给 payment 5分；“订单”与其中的“订”累计给 order 5分。同分依赖
候选插入顺序，order胜出。`detectMixedBusiness()`又把“不关联旧订单”当作第二笔订单
业务，清空收款字段并阻断后续Deep Review。

`PAGE-003` 原文为：

```text
王总那笔只剩4000元，完整页强行收4500元
```

旧规则不认识“强行收 + 明确金额”，却让“完整页”中的“整”成为弱订单证据。本次收款
4500元和剩余4000元也没有分别投影。

上述规则命中说明以运行时 parser结果和代码评分路径共同确认；项目尚未引入大规模动态
ruleId trace。

## 3. 正向收款证据

本地 parser 只在下列窄证据存在时提高普通收款优先级：

- 完成型付款动作与带货币单位的明确金额邻近，例如“付了3000元”“刚打款8000元”；
- 完成型入账动作与明确金额邻近，例如“收到王总货款5000元”；
- 明确执行收款与金额邻近，例如目标安全题“强行收4500元”；
- 金额在前、完成状态在后，例如“5000元已经到账”；
- 明确金融对象与完成状态共现，例如“尾款已经到账”“这单的钱收了”。

金额可以是阿拉伯数字或现有中文数字格式，但日期、商品数量、次数、笔数和模糊量词不得
作为收款金额。“7月15日已到账5000元”只取5000，“今天收了一点钱”和“刚打款3笔”
都保留金额缺失阻断。parser不编造缺失金额；“尾款已经到账”仍会
保留 `payment` 候选，同时由既有缺字段和Route政策要求补充或Deep Review。

当付款语义与“这单”“旧订单”等关系词共现时，主业务仍是
`payment`。Raw parser保留 `operation=null`，Domain Preflight使用现有canonical
resolver投影为 `record_payment`；没有在parser内新增第二套operation映射。

## 4. 待收、定金、订单与非金融边界

以下状态不是已收款：

- “还有8000元待收”“还欠3000元”“尾款没付”“货款未到账”；
- “等客户付款”“准备付款”“计划明天打款”；
- 只描述付款方式、计划或未完成状态的句子。

`BASIC-010`仍为 `unknown/PENDING`，继续作为独立的待收款本地parser缺陷，不由本阶段
伪装为payment。

“定金、订金、预付款”继续走既有定金合同。旧订单定金仍投影
`record_order_deposit`；完整的新订单事实加定金仍以order为主。本阶段没有修改
定金政策，也没有把普通货款改成定金。

下列非金融对象不会因“收到”被标成payment：

```text
收到货
收到消息
收到报价
收到样品
收到文件
收到通知
收到快递
收到订单
```

“收纳盒、收货地址、付款方式、转文件、转报价、转订单”也不能仅凭单字
“收/付/款/转”产生payment。明确新订单、订单修改和只有订单金额但没有资金完成动作的
句子继续保持原意。带数字的“收到500个杯子”“文件转了3次”“刚打款3笔”也不得把
500、3编造成收款金额。

否定与非金融门禁按分句判断：“昨天没到账，今天到账5000元”和“收到货了，今天又收到
500元”仍能识别后一个真实收款事实，同时不会把“昨天没”“又”编造成客户。明确称呼
“收到王总货款5000元”“今天收到李总3000元”分别保留王总、李总；泛称“客户刚打款”
不得生成名为“刚”的客户。

## 5. Mixed business边界

完成型付款中的裸订单关系不再自动构成第二笔order业务。`BASIC-012`因此得到：

```text
raw intent = payment
raw operation = null
mixed_business = false
paymentAmount = 600
```

但真实的两个动作仍保持mixed阻断，例如：

```text
王总那单交期改到8月2日，另外付了500元
王总付了500元，另外订单生产100个
```

这里同时包含订单更新/生产和已付款，不得合成一笔记录；生产、做好、开工、排产和返单
等真实订单动作不能被“payment优先”吞掉。

## 6. 目标Case结果

### BASIC-012

- Raw：`payment/null`，金额600，客户王总，原文不变；
- Route：真实页面链先得到可Deep Review状态，再由真实页面动作进入`AI_DEEP`；
- Fake AI：仅在现有Route决定后调用；
- Semantic：`payment/record_payment`；
- 隔离提交：产生一条600元未关联收款，订单增量0；
- 当前Case：`CASE_FAIL/AI_NORMALIZE_ERROR`；
- 剩余差异：Fake结果未投影 `allowUnlinkedPayment` 与
  `unlinkedPaymentCustomerId`，不属于本阶段。

### PAGE-003

- Raw：`payment/null`；
- 本次收款：4500；
- 关系上下文剩余金额：4000；
- Route：`AI_DEEP`；
- Semantic：`payment/record_payment`；
- Preflight：正式保存继续阻断，含
  `RECEIVABLE_PAYMENT_INVALID` 与现有未解决证据码；
- 正式业务Diff：0；
- 当前Case：`CASE_FAIL/PREFLIGHT_ERROR`。

两题都不再因“payment被识别为order”产生`LOCAL_PARSE_ERROR`。

## 7. 回归证据

专项测试覆盖：

```text
完成型收款              28
待收/未完成保护           7
定金保护                  6
非金融误判保护           28
订单保护                 10
```

Runner Kernel为69/69，Parser Invocation Graph为21/21，全量/报告为17/17。

120条核心题执行两轮：

```text
PASS          10
CASE_FAIL    110
RUNNER_ERROR   0
BLOCKED        0
```

两轮完全一致；65条P0失败全部单题重跑，P1分层抽查13条。`LOCAL_PARSE_ERROR`
从11降为9，`AI_NORMALIZE_ERROR`从21增至23，`PREFLIGHT_ERROR`从19增至20，
`ROUTE_ERROR`从44降至43。新增推进的`AMB-016`原文“王总转来1000元，没说是哪一单”
属于同一完成型payment边界：raw/semantic已成为payment/record_payment，整体继续暴露
Fake字段差异。
这表示两条观测已推进到下一处真实差异，不表示两条Case整体通过。

与上一可信基线逐题比较，除两条目标和同边界`AMB-016`外，其他117题的顶层Case状态、
主失败与Ownership均不变。
Evidence层另有4条与本规则直接相关的修正：`FIN-004`与`PAGE-004`的raw金额缺失消除，
`FIN-013`从错误todo raw改为payment，`CHAT-001`的“我：收到”不再被当成第二笔付款。
其余113题的raw/semantic/proposal/outcome/Preflight/业务Diff比较无变化。

网络误触审计和默认离线门禁见`docs/RECORD_OFFLINE_TEST_SAFETY_V1.md`。正式重跑中
网络guard attempt、未知Fake Route、真实wx Storage、宿主文件Storage、fixture修改、跨Case污染、
Journal、Backup、parser evidence missing、orphan、uncorrelated、shadow和未执行隔离
审计计数在两轮均为0。

## 8. 未完成范围

仍保留的高置信本地parser缺陷：

```text
REC-E2E-BASIC-006
REC-E2E-BASIC-010
REC-E2E-AMB-005
```

`REL-008`、`VOICE-004/006`、`AMB-011`及其他AI、Preflight、Route和合同差异也未在本阶段
修复。生产继续为 `LEGACY_ONLY`，Shared生产Commit关闭；未调用真实千问，未执行微信
WXML/DOM页面E2E，未上传、未push。
