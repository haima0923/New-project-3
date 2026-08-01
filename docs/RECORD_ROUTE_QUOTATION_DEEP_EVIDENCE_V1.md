# 明确报价转订单 Deep Review 与 Evidence 保留 V1

## 1. 结论

本阶段完成报价转订单的窄范围 Deep Review 链路。只有本地 Parser 同时给出可信的转换
Evidence 和明确报价关系 Evidence 时，页面才开放“深度核对”。首次解析保持 `PENDING`，
不会后台调用 AI；用户真实点击 `requestDeepReview()` 后，第二次 Hybrid 才进入一次
`AI_DEEP`。

这是关系解析前的局部铺路，不会选择报价、写入 `quotationId`、创建订单或放宽 Domain
Preflight。生产仍为 `LEGACY_ONLY`，共享生产 Commit 关闭。

## 2. 双 Evidence 资格

本轮特殊报价转换 Deep 资格只读取 Parser 已产生的结构化数据，不扫描 `originalText`、
Case ID、Expected、State 或候选数量。资格必须同时满足：

```text
quotationToOrderConversionSignals[].direction = QUOTATION_TO_ORDER
quotationToOrderConversionSignals[].explicit = true
quotationToOrderConversionSignals[].evidenceSource = LOCAL_PARSER

relation_references.quotation.entityType = QUOTATION
relation_references.quotation.explicit = true
relation_references.quotation.requiresResolution = true
relation_references.quotation.evidenceSource = LOCAL_PARSER
relation_references.quotation.resolvedEntityId = null
```

关系Evidence还必须通过既有结构完整性边界：kind只能是明确报价指代类型，sourceField只能
来自原始或提取文本，sourceText、normalizedReference、confidence和sourceSpan均有效，且
span长度与必要短语一致。畸形对象即使自称`LOCAL_PARSER`也不可信。

Route 记录以下原因码：

```text
QUOTATION_TO_ORDER_CONVERSION_VERIFIED
EXPLICIT_QUOTATION_REFERENCE_REQUIRES_RESOLUTION
QUOTATION_CONVERSION_DEEP_REVIEW_AVAILABLE
```

只有转换 Evidence、没有明确报价关系时，记录
`EXPLICIT_QUOTATION_REFERENCE_MISSING`，不开放特殊 Deep。

## 3. 明确指代与裸句边界

“把王总那个保温杯报价再转成订单”“把王总那个报价转成订单”“将李姐那份报价转为
订单”“这张报价转成订单”“那份报价转为订单”同时具备双 Evidence，因此首次
`PENDING / deepReviewAvailable=true / AI=0`，点击后为 `AI_DEEP / Deep AI=1`。

“报价再转成订单”“报价转成订单”“报价转订单”虽然保留方向 Evidence，但没有指向某张
报价；“从报价生成订单”在现有 Parser 合同下也没有明确报价关系。它们均继续
`PENDING / deepReviewAvailable=false / AI=0`。Route 不会为裸句制造关系，也不会只凭方向
Evidence 放宽资格。

历史完成、疑问、否定、失败和反向转换同样不取得本轮特殊 Deep 资格。普通缺字段订单和
普通报价继续使用原 Route。

## 4. 用户主动 Deep

REL-008 初次页面状态为：

```text
initialRoute = PENDING
initialDeepReviewAvailable = true
requestDeepReviewInvocationCount = 0
AIRequestCount = 0
```

Runner 通过真实页面方法点击后记录：

```text
requestDeepReviewInvocationCount = 1
secondHybridInvocationCount = 1
actualRoute = AI_DEEP
standardAIRequestCount = 0
deepAIRequestCount = 1
duplicateDeepReviewInvocationCount = 0
duplicateDeepAIRequestCount = 0
```

Runner 不直接调用 Fixture。Fake Deep 请求来自生产 Route。

## 5. AI Merge 信任边界

`LOCAL_PARSER` 的未解析 quotation Evidence 进入机械白名单，与既有 order Evidence 并存。
AI 未返回 relation、返回空 relation、返回候选或返回冲突 relation 时，都不能删除或改写
本地 Evidence。AI 没有本地 quotation Evidence 时，也不能创建可信关系。

信任顺序保持：

```text
USER_SELECTION > LOCAL_PARSER > AI_SUGGESTION
```

本阶段没有用户报价选择，所以最终保持：

```text
resolvedEntityId = null
quotationId = null
quotationSelectionConfirmed = false
```

AI 的 `quotation_candidates` 或直接 `quotationId` 均不能升级为可信关系。

## 6. REL-008 Evidence 与安全结果

本地关系为：

```text
kind = EXPLICIT_QUOTATION_NAMED_REFERENCE
sourceText = 王总那个保温杯报价
sourceSpan = [1, 10)
evidenceSource = LOCAL_PARSER
requiresResolution = true
resolvedEntityId = null
```

它逐层到达 Raw Parser、Initial Hybrid、Deep Hybrid Merge、Confirmation 和 Preflight
输入。`quotationLocalEvidenceDropCount=0`，`untrustedQuotationIdPromotionCount=0`。

REL-008 仍为 `CASE_FAIL`，但最早失败层从 `ROUTE_ERROR` 推进到
`AI_NORMALIZE_ERROR / ASSERTION_FAILED:fields.quotationId`。这暴露了旧 Expected 要求直接
得到 `quo-syn-a-1`，而当前安全合同要求报价关系仍未解析。本阶段不修改该 Expected、
Fixture、Preflight或候选选择。

## 7. 离线回归

120题两轮均为：

```text
ACTIVE         120
PASS            25
CASE_FAIL       95
RUNNER_ERROR     0
BLOCKED          0
SURFACE_ERROR    0
```

除 REL-008 的 Route、AI次数和最早失败层外，其他119题的状态、最早失败层、Route、AI次数、
Deep入口、关系 Evidence 和业务 Diff 与修改前报告相同。P0失败54条全部单题重跑，P1分层
抽查11条；隔离提交Lane仍为88。两轮网络、真实Storage、Fixture修改、Parser调用图、
Journal/Backup以及本阶段四项Deep/关系硬门禁均为0。未调用真实千问，未Push，不是发布版。
