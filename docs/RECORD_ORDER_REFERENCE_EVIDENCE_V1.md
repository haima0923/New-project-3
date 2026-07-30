# Structured Order Reference Evidence V1

## 1. 目标与边界

本阶段只建立“用户明确指向订单实体”的结构化语言 Evidence，并把它从本地 parser
机械透传到 Hybrid、Confirmation 草稿和 Domain Preflight 输入。

本阶段不改变：

- Domain Preflight 的保存资格或 `requiredSelections`；
- Safe Local Receivable Route；
- 页面或 `SELECT_ORDER`；
- business、Storage、Coordinator；
- AI prompt、AI请求或AI normalizer业务映射；
- 120题核心业务Expected。

该阶段冻结时，BASIC-010选择前仍为
`requiredSelections=[] / domainCanSaveFormal=true`。后续
`candidate-record-safe-local-receivable-v1`由Domain Preflight消费本Evidence建立了关系
必选门禁；语言Evidence本身的生成和透传合同没有改变。

## 2. 数据合同

parser仅在已经确定为`receivable`的本地业务结果中输出：

```text
relation_references.order
```

字段如下：

| 字段 | 含义 |
| --- | --- |
| `entityType` | 固定为`ORDER` |
| `kind` | `EXPLICIT_ORDER_DEICTIC`、`EXPLICIT_ORDER_IDENTIFIER`或`EXPLICIT_ORDER_NAMED_REFERENCE` |
| `explicit` | 明确语言指代时为`true` |
| `requiresResolution` | 尚需解析或用户确认具体订单时为`true` |
| `sourceText` | 最小必要原文短语 |
| `sourceSpan.start/end` | 相对parser识别原文、前闭后开的字符位置 |
| `sourceField` | span对应`ORIGINAL_TEXT`或`EXTRACTED_TEXT` |
| `confidence` | 对明确语言模式本身的置信度，不是保存资格 |
| `normalizedReference` | 可审计的规范化指代，不是业务ID |
| `resolvedEntityId` | 本阶段保持`null` |
| `evidenceSource` | 固定为`LOCAL_PARSER` |

该结构可JSON序列化、深复制并进入Runner fingerprint；不包含State、历史客户、候选对象或
完整聊天。

## 3. 语言边界

明确指代：

- 指示词：`这单`、`那单`、`上一单`等；
- 稳定编号表达：`订单号A123`、`订单编号...`、`单号...`；
- 已有客户和商品语言事实约束下的命名表达，例如`王总的收纳盒订单`。

不构成明确订单指代：

- `那批货`、`这批货`、单独的`货`或`批`；
- 客户存在历史订单；
- 同客户只有一张候选订单；
- 商品名与历史订单相同；
- `这次`、`客户以前有订单`、`订单总金额`；
- 普通新订单、商品描述或State候选数量。

否定关系表达不能被当成正向关系，例如“不关联旧订单”不生成可要求选择的正向Evidence。
Evidence只表达语言指代，不改变`businessType`、`operation`、Route、金额、客户或日期。

## 4. BASIC-010

原文：

```text
王总收纳盒这单还有8000元待收，7月25日收
```

实际Evidence：

```text
entityType = ORDER
kind = EXPLICIT_ORDER_DEICTIC
explicit = true
requiresResolution = true
sourceText = 这单
sourceSpan = { start: 5, end: 7 }
confidence = 0.99
normalizedReference = THIS_ORDER
resolvedEntityId = null
evidenceSource = LOCAL_PARSER
sourceField = ORIGINAL_TEXT
```

Runner确认该结构依次存在于：

```text
RAW_PARSER
HYBRID_RESULT
CONFIRMATION_DRAFT
PREFLIGHT_INPUT
```

同时保持：

```text
businessType = receivable
effectiveOperation = create_receivable
route = LOCAL
AIRequestCount = 0
amount = 8000
customer = 王总
dueDate = 2026-07-25
```

parser未写入`orderId`，Evidence中的`resolvedEntityId`也保持`null`。当前Case后续真实
`SELECT_ORDER`仍由既有Case交互执行，不能反推或伪造语言Evidence。

## 5. BASIC-009

原文：

```text
刘姐那批货还欠3200元，7月31日前收
```

“那批货”是货物/批次回指，不是订单实体指示词。BASIC-009没有
`EXPLICIT_ORDER_DEICTIC`或同等级Evidence，仍为客户级待收款：

```text
route = LOCAL
AIRequestCount = 0
orderId = ""
```

即使State中增加唯一、多张、跨客户或商品匹配的历史订单，parser Evidence也不变化。

## 6. AI与透传边界

LOCAL链的parser、Hybrid和页面草稿本来会保留未知顶层字段。AI成功合并是唯一需要明确
防污染的环节：AI payload不能创建、覆盖、清空或解析本地
`relation_references`。合并结果只机械复制可信本地parser Evidence。

Shared Confirmation只投影该结构，并继续把完整`finalResult`交给Domain Preflight；
Confirmation和Runner都不重新解析原文，也不读取State补造Evidence。

## 7. 测试结果

- Relation Evidence专项：
  - 明确指代5组；
  - 负向11组；
  - BASIC-009/010各3种State，共6组State独立性；
  - paste聊天`EXTRACTED_TEXT` span坐标基准；
  - raw/Hybrid/Confirmation/Preflight输入四阶段传播；
  - AI覆盖与AI凭空创建防护2组；
  - 四阶段Evidence缺失/改写Runner硬门禁2组；
  - Evidence阶段冻结点的Preflight门禁保持不变；
  - BASIC-009/010真实Runner目标2组。
- Parser Invocation Graph：21/21。
- Runner Kernel：70/70。
- Order Selection：15/15。
- Quotation Candidate：22/22。
- Quotation Selection：23/23。
- Home Primary Item：16/16。
- Release A RC1：16/16。
- Domain Preflight：20/20。
- Shared Confirmation：16/16。
- Offline Guard：15/15。

120题两轮一致：

```text
PASS           12
CASE_FAIL     108
RUNNER_ERROR    0
BLOCKED         0
```

63条P0失败全部单题重跑，P1分层抽查13条，30个Cluster覆盖108/108失败。两轮网络、
真实wx Storage、宿主文件Storage、fixture mutation、cross-case leak、Journal/Backup、
parser Evidence缺失、orphan、uncorrelated、shadow和隔离审计缺失均为0。

起始HEAD的同一全量结果也是12/108，本阶段没有改变Case状态。相对10/110可信发布基线的
+2来自此前已进入起始WIP的Safe Local BASIC-009/010。

`shared-core-phase1a`当前为22/26；4个差异在本阶段起始HEAD只读归档中完全相同，属于此前
WIP已有的共享核心金样本/等价性差异，不是本轮Evidence回归，也未在本阶段修改或隐藏。

## 8. 后续消费合同

Domain Preflight现已直接消费本结构：明确指代的`create_receivable`未确认合法
`orderId`时要求`SELECT_ORDER`并阻断正式保存；普通客户级待收款不全局强制订单关系，
且唯一候选也不自动选择。实现与选择前后Evidence见
`docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md`。
