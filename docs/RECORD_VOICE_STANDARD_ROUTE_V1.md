# Verified Voice Standard Route V1

## 1. 目标与边界

本合同让生产Route消费已经由`Voice Transcription Completion Evidence V1`建立的可信
终稿Evidence。只有最终语音转写已验证、关键业务字段充分、本地intent仍未决且没有安全
排除项时，才自动请求一次现有Standard AI：

```text
trusted voice final
→ sufficient structured business evidence
→ unresolved local intent
→ AI_STANDARD once
→ normalize/merge
→ Confirmation
→ Domain Preflight
```

`AI_STANDARD`只负责核对未决业务类型，不代表可正式保存。缺字段、关系、Provider资格和
正式保存仍由既有Confirmation及Domain Preflight判断。本阶段没有修改Voice Provider、
Completion Evidence Schema、Parser、AI Prompt/Provider/Normalizer/Merge、页面、
Preflight、business、Storage或120题核心Expected。

## 2. 窄资格

集中资格函数只读取Route阶段已有结构化事实，不扫描原始转写、不读取Case ID、Expected
或Fake输出。正向条件必须同时成立：

- 渠道是`VOICE`或`VOICE_TRANSCRIPT`；
- Completion Evidence存在，状态为`COMPLETED`、`isFinal=true`；
- Evidence来源为真实或Fake Voice final callback；
- 当前session与准确转写指纹均匹配；
- Parser及Evidence采集完成，没有异步pending；
- 本地intent为`unknown`，没有canonical operation；
- 当前结构化字段构成客户、商品、正数量及正单价/金额的强组合；
- 只缺`intent`，没有其他业务缺字段、低置信、冲突、无效或不安全字段；
- 既有Safety判定确实需要Standard AI。

资格命中记录：

```text
VOICE_INPUT_CHANNEL_CONFIRMED
VOICE_FINAL_TRANSCRIPT_VERIFIED
VOICE_SESSION_MATCHED
VOICE_TRANSCRIPT_FINGERPRINT_MATCHED
VOICE_PARSER_AND_EVIDENCE_COMPLETE
VOICE_INTENT_UNRESOLVED
VOICE_STRUCTURED_BUSINESS_EVIDENCE
VOICE_STRONG_BUSINESS_FIELD_COMBINATION
VOICE_STANDARD_REVIEW_REQUIRED
```

只有客户、日期、商品、数字或金额中的单项证据不足以取得资格。

## 3. 排除项

以下任一事实存在时，不进入本Voice Standard分支：

- Evidence缺失、非final、无效、来源不可信、旧session或指纹不匹配；
- 非语音渠道、手工编辑后的输入、Parser/Evidence未完成；
- NO_RECORD、业务Evidence不足或本地intent已明确；
- payment、deposit、receivable等金融风险；
- 低置信、字段冲突、多业务、危险关系、历史/上下文、多商品Deep风险；
- 已主动进入Deep Review、已有AI operation或同一处理链已经请求过AI。

Clear Non-Business final语音继续`NO_RECORD / AIRequestCount=0`；明确本地订单、报价、todo
和Safe Local receivable继续按既有LOCAL政策；金融Deep政策不降为AI_STANDARD。

## 4. 单次AI与Runner Evidence

一次合格的`parseHybridInput()`只通过真实生产Route进入一次Standard adapter。Runner用
Fake network audit中的实际`/api/ai/parse`事件计算：

```text
standardAIRequestCount
deepAIRequestCount
AIRequestCount
duplicateVoiceStandardAIRequestCount
```

观察、渲染、Confirmation、Preflight或Runner采样不得重复请求。全量硬门禁要求
`duplicateVoiceStandardAIRequestCount=0`；任何最终命中Voice Standard资格的Case还必须
严格满足`Standard=1 / Deep=0 / Total=1 / Route=AI_STANDARD`。语音链的重复计数来自全部
物理Standard事件，不因最终Route变为non-eligible而归零。Runner同时记录资格、原因、
排除项、raw结果、Fake fixture/provider、normalized结果、merged结果以及后续Preflight和
State Diff。

既有Completion Evidence的完整session ID、指纹值和Provider对象仍不得进入持久化Trace。
6B.2只允许在`parse_route`扩展非敏感资格诊断：final/session/fingerprint校验布尔值、
Evidence来源、结构字段计数和reason/exclusion codes。

## 5. VOICE-004

准确转写：

```text
赵姐礼品盒五百套三块八一套
```

Route前动态Evidence：

```text
voice status = COMPLETED
session matched = true
fingerprint matched = true
raw = unknown / null
customer = 赵姐
product = 礼品盒
quantity = 500
unit = 套
unitPrice = 3.8
amount = 1900
missingFields = [intent]
conflictCount = 0
```

修复后生产Route为`AI_STANDARD`，物理Standard AI请求恰好1次，fixture为
`ai-case-rec-e2e-voice-004-v1`，Provider为`e2e-fake-standard`。既有Fake结果规范化及
合并为`order/create_order`，但没有交期。Domain Preflight因此以
`MISSING_REQUIRED_FIELD`阻断正式保存，订单和客户等正式业务Diff均为0。Case从
`ROUTE_ERROR`推进到`PREFLIGHT_ERROR`；本阶段不补造交期、不降低安全门禁，也不修改
Expected。

## 6. VOICE-006及相邻保护

`VOICE-006`继续为`AI_STANDARD / AIRequestCount=1 / SURFACE_ERROR`，没有第二次AI请求，
原异步/Surface问题保持可见。

专项同时证明：

- final闲聊仍为NO_RECORD且AI请求0；
- final且本地已解决订单仍为LOCAL且AI请求0；
- Safe Local receivable、payment、deposit及关系门禁保持既有政策；
- PARTIAL、CANCELLED、FAILED、TIMED_OUT、旧session、指纹不匹配和非语音渠道均不能
  取得本资格；
- 缺交期订单仍被Preflight阻断且正式业务Diff为0。

## 7. 离线全量结果

120题离线双轮均为：

```text
ACTIVE         120
PASS            14
CASE_FAIL      106
RUNNER_ERROR     0
BLOCKED          0
```

与14/106冻结基线总数相同；`ROUTE_ERROR`从42降为41，`PREFLIGHT_ERROR`从20升为21，
对应VOICE-004的责任层推进。两轮确定性一致；63条P0失败全部单题重跑，P1分层抽查12条，
27个Cluster覆盖106/106失败。

每轮网络、真实Storage、fixture mutation、跨Case泄漏、Journal/Backup、Parser Evidence、
orphan/uncorrelated/shadow调用、Voice Evidence缺失/指纹不符/旧session接受及重复
Voice Standard AI请求全部为0。未使用真实麦克风或千问，production仍为`LEGACY_ONLY`，
`sharedProductionCommitEnabled=false`。

## 8. VOICE-004分层缺交期安全合同补充

后续6B.4-R1没有改变本文件定义的Voice Standard Route。VOICE-004仍需满足可信final
Evidence、session与指纹匹配、`AI_STANDARD`、Standard Fake AI恰好1次、
`order/create_order`以及全部已确认字段断言。

唯一合同修正位于测试分层：原文没有交期，因此Expected明确
`orderDeliveryDate`缺失；运行时`dueDate`通过测试基础设施共享的精确别名合同与其等价。
Domain Preflight的`MISSING_REQUIRED_FIELD`正确阻止正式保存，Case使用现有
`DO_NOT_SAVE / BLOCKED`模式，不调用正式或pending保存，也不进入隔离Legacy提交。
零持久化、零业务Diff和零Storage/事务副作用与Route成功一起构成PASS。

全量双轮从14/106更新为15/105，只有VOICE-004状态变化；提交Lane因该Case移除隔离
提交从89变为88。其他119题以及VOICE-006的`SURFACE_ERROR`保持冻结责任。此补充没有
修改Voice glue、Route、AI fixture/Normalizer、Preflight、页面、business或Storage。
