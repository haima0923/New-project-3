# 记一笔安全报价候选真值源 V1

## 1. 结论与范围

Domain Preflight 是报价候选的唯一安全真值源。它基于每次调用收到的最新只读 State，
同时考虑当前客户、operation、报价状态和转单关系，输出
`quotationSelectionCandidates`。页面、AI fixture 和 Runner 都不得另行扫描 State
或从模型的 `quotation_candidates` 建立可选记录身份。

本阶段没有实现完整页报价 picker，没有修改任何页面、parser、AI normalizer、business、
Storage 或 Coordinator。生产继续为 `LEGACY_ONLY`，Shared 生产 Commit 继续禁用。

## 2. 安全候选与危险引用

两个概念必须分开：

- `quotationSelectionCandidates`：当前客户和operation下可以向用户展示的安全报价；
- `rejectedQuotationReferences`、`quotationChecks`、`blockingIssues`：当前草稿已经携带
  的危险或无效 `quotationId` 的审计结果。

危险引用不能进入安全候选，系统也不能静默替换成其他报价。

安全候选必须满足：

1. 报价在最新State中真实存在，且没有删除事实；
2. 客户身份已经成功解析或由用户明确选择，报价客户与该客户一致；客户ID/名称冲突、
   多候选未确认或无效选择时不输出报价候选；
3. 状态为当前既有活动状态`待确认`；
4. 没有`convertedOrderId`，也没有订单反向引用该报价；
5. operation只限当前合同明确的`update_quotation`或可引用报价的`create_order`；
6. 输出按稳定quotationId排序，可JSON序列化；
7. 只有候选一条时也不自动选择。

`validUntil`被投影供未来UI展示，但当前产品合同没有定义日期过期的自动失效政策，因此
本阶段不根据系统日期自行排除报价。显式删除、失效状态和转单关系仍会排除。

明确新报价不会暴露历史报价选择；`update_order`也不会获得通用报价重新绑定候选。
`update_order`合法保留原报价关系时属于只读关系，不会被误列为危险拒绝引用。
普通新订单可以得到安全的可选来源，但候选存在本身不会强迫用户选择。

## 3. 候选投影

每项安全候选仅包含稳定、安全的展示投影：

```text
quotationId
customerId
customerDisplayName
productSummary
itemCount
quotationAmount
status
quoteDate
validUntil
convertedOrderId
createdAt
selectionEligible
selectionBlockingCodes
```

真正可选项固定为`selectionEligible=true`且`selectionBlockingCodes=[]`。兼容字段
`quotationCandidates`与新字段使用同一安全集合，不再回显草稿中的危险报价。

Shared Confirmation只投影Preflight结果，不重算候选，也不再根据候选数量自行推断
`selectionRequired`。

## 4. REL-007 / REL-008 合同修订

两题继续保持ACTIVE、P0、原业务Expected和零副作用断言，但不再冒充合法页面选择：

| Case | 专用注入 | 真实Preflight结果 | 保存与Diff |
| --- | --- | --- | --- |
| `REC-E2E-REL-007` | `quo-cross-b`注入合成甲厂的更新报价底稿 | `QUOTATION_CUSTOMER_MISMATCH` | 不保存，正式Diff为0 |
| `REC-E2E-REL-008` | 已转单`quo-syn-a-1`注入创建订单底稿 | `QUOTATION_ALREADY_CONVERTED` | 不保存、不重复转单，正式Diff为0 |

新Lane为`RELATION_REFERENCE_TAMPER_GUARD`。它从原始输入完成页面生产观察后，使用合同
明确的`EXPLICIT_SECURITY_TEST_DRAFT`，只注入`fields.quotationId`，再调用真实Domain
Preflight。它不调用页面picker、不调用business、不尝试保存。

Runner Evidence包含注入前后底稿、唯一变更路径、注入ID、Preflight、候选排除、拒绝
引用，以及页面方法、business、Storage、事务的动态调用计数和真实Storage前后Diff。
REL-007/008的安全Lane均PASS；Case整体仍因当前原始页面结果与确认语义不一致而分别为
`AI_NORMALIZE_ERROR/operation`和`AI_NORMALIZE_ERROR/businessType`，不能把该整体状态
写成关系安全失败。

## 5. Validator与测试

Validator拒绝：

- 危险引用没有专用Lane、注入字段或ID；
- 同一危险ID又出现在`userSelections`或`SELECT_QUOTATION`能力中；
- 危险引用被声明为安全候选；
- Lane允许正式保存、启用隔离Commit或存在正式业务Diff；
- 跨客户题缺少客户不匹配码；
- 已转报价题缺少重复转换阻断码；
- 同时篡改两层Expected后与fixture真实关系不一致；
- fixture中不存在注入报价、客户或转换事实。

平台无关专项测试22/22覆盖合法单/多候选、稳定顺序、跨客户、客户身份冲突、删除、
脏删除引用、空关系ID、未知状态引用、失效、已转、反向
订单关系、最新State重算、JSON投影、AI fixture候选不可信、无自动选择和Confirmation
投影。Runner Kernel自测48/48，执行边界合同自测24/24。Runner自测会真实触发一次
页面方法、business调用和Fake Storage写入，证明动态门禁能抓住非零活动，而不是信任
硬编码的`false`或空Diff；任一禁止活动或审计仪表缺失均产生`RUNNER_ERROR`，不会被
归成产品`CASE_FAIL`。

## 6. 全量基线

120条ACTIVE两轮结果一致：

```text
PASS=4
CASE_FAIL=116
RUNNER_ERROR=0
BLOCKED=0
```

65条P0失败全部单题重跑一致，P1分层抽查10条一致。两轮网络、未知Fake路由、真实wx
Storage、宿主文件Storage、fixture mutation、跨Case泄漏、Journal和Backup均为0。

`RELATION_REFERENCE_TAMPER_GUARD`为2/2 PASS。`SELECT_QUOTATION`合法用户选择Case当前
为0；REL-007/008只验证危险引用。

## 7. 下一阶段边界

实现完整页`SELECT_QUOTATION`前，至少补充两条真正的合法选择Case：

1. 同一客户有多张安全报价，用户明确选择其中一张；
2. 安全报价与危险报价并存，页面只展示安全报价。

未来页面必须只消费本合同的安全候选，不得自动选择第一项。`PAGE-008`、解析/AI差异
和其他Cluster不属于本阶段。
