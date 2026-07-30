# Clear Non-Business NO_RECORD Route V1

## 1. 目标

本合同把“没有可记录的生意事项”从Runner观测投影落实为生产Route和持久化硬门禁。
它只适用于Parser、异步采集和Evidence收集已经完整结束，同时没有任何业务信号、
结构化业务字段、关系Evidence、缺失业务类型、低置信字段、冲突或AI未决依赖的输入。

典型样本：

```text
今天天气不错，晚点出去走走
```

该样本的canonical结果为：

```text
parse_route.decision = NO_RECORD
outcome.disposition = NO_RECORD
AIRequestCount = 0
deepReviewAvailable = false
domainCanSaveFormal = false
domainCanSavePending = false
```

NO_RECORD不是`unknown`的别名。`unknown`但含客户、商品、金额、日期、业务动作、关系
Evidence、缺字段、低置信、冲突、AI未决或未完成异步任务的输入仍是PENDING。

## 2. Route资格

真实生产Route仅使用已有结构化事实，不扫描“天气、吃饭、出去”等闲聊关键词，也不读取
Case ID或Expected。资格同时要求：

- semantic businessType为unknown，且没有canonical operation；
- intent分数完整并且全部业务分数为0；
- 结构化业务字段计数为0；
- 关系Evidence计数为0；
- missingFields、lowConfidenceFields和conflicts为空；
- local safety明确为NO_RECORD；
- Parser、Hybrid、异步工作和Evidence采集全部完成；
- 没有AI unresolved依赖或执行错误。

生产Route记录：

```text
CLEAR_NON_BUSINESS
NO_BUSINESS_EVIDENCE
NO_STRUCTURED_FIELDS
NO_RELATION_EVIDENCE
PROCESSING_COMPLETE
```

语音输入必须显式证明转写完成。剪贴板、多轮和Deep Review只处理了局部结果时不能提前
进入NO_RECORD。

## 3. Preflight资格

Domain Preflight消费canonical Route，不重新解析原文。NO_RECORD统一得到：

```text
effectiveOperation = none
requiredSelections = []
domainCanSaveFormal = false
domainCanSavePending = false
noRecordPersistenceForbidden = true
blockingCode = NO_RECORD_OR_UNKNOWN_INTENT
blockingSource = CANONICAL_NO_RECORD_ROUTE
```

该blocking code表达“无记录可持久化”，不是要求用户补客户、商品、金额或日期。
canonical PENDING且保留严格原文时，`domainCanSavePending`继续为true。

## 4. 页面门禁

FULL_PAGE和HOME_QUICK都消费同一Preflight资格：

- 隐藏正式保存；
- 隐藏“先放待整理”；
- 隐藏Deep Review；
- 显示中性提示“没有识别到需要记录的生意事项”；
- 保留返回和修改原输入能力。

WXML隐藏不是唯一防线。直接调用正式保存、pending保存或Deep Review handler时，页面在
调用business或Storage前拒绝，并记录对应拒绝码：

```text
NO_RECORD_FORMAL_SAVE_FORBIDDEN
NO_RECORD_PENDING_SAVE_FORBIDDEN
NO_RECORD_DEEP_REVIEW_FORBIDDEN
```

## 5. Business持久化兜底

`saveConfirmedDraft()`和`savePendingNote()`在任何mutation、parse log、事务或Storage
操作前消费同一canonical NO_RECORD元数据。伪造UI事件或绕过页面直接调用business时仍
fail closed：

```text
formal success = false
pending success = false
business mutation = 0
Storage save attempt = 0
transactionBeginCount = 0
receiptCount = 0
journalCount = 0
backupCount = 0
```

business不重新解析`originalText`。缺少canonical disposition不会把合法PENDING误判为
NO_RECORD；相反，明确canonical NO_RECORD即使夹带伪造业务字段，也以零副作用拒绝。

## 6. 回归边界

以下合法PENDING继续允许pending保存：

```text
REC-E2E-BASIC-019
REC-E2E-BASIC-020
REC-E2E-AMB-001
REC-E2E-AMB-002
REC-E2E-AMB-014
```

`AMB-012`因存在日期Evidence保持PENDING。`VOICE-004/006`和`MULTI-009`不得在异步或
调用图完成前NO_RECORD；`MULTI-009`继续保持2个Hybrid、26个Raw、orphan=0、shadow=0。

## 7. 冻结结果

120题两轮均为：

```text
ACTIVE         120
PASS            14
CASE_FAIL      106
RUNNER_ERROR     0
BLOCKED          0
```

相对Order Signal Boundary冻结基线13/107，仅`AMB-005`新增PASS。两轮确定性一致；
63条P0失败全部单题重跑，P1分层抽查13条。每轮真实网络、network guard attempt、
真实Storage、fixture mutation、跨Case泄漏、Journal/Backup、Parser Evidence缺失、
orphan/uncorrelated/shadow调用和隔离审计缺失均为0；NO_RECORD正式及pending写入均为0。

这是Headless Node页面方法与Fake/Replay离线证据，不是真实WXML DOM E2E，不代表真实AI
质量，不构成上传或发布批准。
