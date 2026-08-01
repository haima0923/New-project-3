# 报价转订单 Parser Evidence V1

## 1. 结论

“报价转成订单”“报价转为订单”“报价转订单”等方向明确的动作，由本地 Parser 识别为
订单意图。Raw operation 继续为空；现有语义投影据此自然得到
`order / create_order`，没有新增转换 operation 枚举。

本阶段是 Parser Evidence 的局部铺路任务，不完成报价候选解析、用户选择、已转报价校验或
正式保存。Route、AI、Domain Preflight、页面、business 和 Storage 均未修改。

## 2. 转换 Evidence

有效短语写入既有 `intent_evidence`：

```text
quotationToOrderConversionSignals[]
kind = QUOTATION_TO_ORDER_CONVERSION
direction = QUOTATION_TO_ORDER
explicit = true
confidence = 0.99
evidenceSource = LOCAL_PARSER
sourceField = ORIGINAL_TEXT | EXTRACTED_TEXT
sourceText/sourceSpan = 原文准确片段
```

REL-008“把王总那个保温杯报价再转成订单”的转换片段为：

```text
sourceText = 报价再转成订单
sourceSpan = [8, 15)
winningReason = EXPLICIT_QUOTATION_TO_ORDER_CONVERSION
```

Parser只识别`quotation → order`方向。订单转报价不会命中。历史完成、疑问、否定、未完成
和失败描述也不会生成新建订单转换 Evidence，例如“已经转成订单了”“转成订单了吗”
“不要转”“还没转”和“转订单失败了”。

## 3. 报价关系 Evidence

转换短语中存在命名或指示性报价引用时，复用既有 `relation_references` 合同的
`quotation`槽：

```text
entityType = QUOTATION
kind = EXPLICIT_QUOTATION_NAMED_REFERENCE | EXPLICIT_QUOTATION_DEICTIC
explicit = true
requiresResolution = true
resolvedEntityId = null
evidenceSource = LOCAL_PARSER
```

REL-008为：

```text
sourceText = 王总那个保温杯报价
sourceSpan = [1, 10)
normalizedReference = 王总:保温杯:QUOTATION
```

`normalizedReference`保留客户与商品上下文，只用于后续筛选。Parser不读取State、不扫描候选、
不自动选唯一报价，也不写入`quotationId`。裸“报价转订单”只有转换方向，没有足够具体的
历史报价指代，因此不生成可信报价关系。

## 4. 客户名边界

句首处置结构只在后续确实是带称呼后缀的客户时去除“把/将”：

```text
把王总那个报价……       → 王总
将李姐那份报价……         → 李姐
请把陈老板那个报价……     → 陈老板
```

没有全局删除“把/将”。“把手产品报价转成订单”不会生成“手”或“把手产品”客户。

## 5. Runner Evidence

Runner从真实Raw Parser和`relation_references.quotation`记录：

```text
quotationToOrderConversionEvidencePresent
conversionDirection / conversionSourceText / conversionSourceSpan
quotationRelationEvidencePresent
quotationRelationKind / quotationRelationSourceText / quotationRelationSourceSpan
quotationRelationRequiresResolution / quotationRelationResolvedEntityId
quotationRelationEvidenceSource
```

报价关系在当前REL-008无AI链上逐层到达Raw、Hybrid、Confirmation和Preflight输入；任一层
缺失或改写都会成为Runner错误。Runner不根据Expected补造Evidence。

## 6. AI边界

当前`utils/ai-parser.js`的本地关系白名单仍只覆盖order。本阶段禁止修改AI Merge，且
REL-008真实Route仍为`PENDING / AIRequestCount=0`，所以没有进入该限制路径。后续若要让
报价关系跨AI Review保留，必须单独审计机械白名单；AI仍不得创建、覆盖或解析可信
`quotationId`。

## 7. 验收结果

REL-008当前为：

```text
Raw = order / operation null
Semantic = order / create_order
customer = 王总
product = 保温杯
quotation relation resolvedEntityId = null
Route = PENDING
AIRequestCount = 0
Preflight = 缺quantity、dueDate、unitPrice而阻断
business State Diff = 0
Case = CASE_FAIL / ROUTE_ERROR
```

Parser错误已经消除；Route及报价关系解析仍是独立后续阶段。120题离线双轮保持
`PASS=25 / CASE_FAIL=95 / RUNNER_ERROR=0 / BLOCKED=0`，其他119题的状态、最早失败层、
Route、AI次数和业务Diff不变；隔离提交Lane仍为88，网络尝试为0。
