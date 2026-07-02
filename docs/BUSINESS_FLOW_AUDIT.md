# 业务流转链路盘点

本文件作为“业务流转 Agent”盘点结果，只基于当前真实代码记录，不包含业务代码修改建议的实现。

## 1. 总体判断

当前项目已经形成了“报价 -> 订单 -> 应收款 -> 收款 -> 催款”的基础链路，核心逻辑主要集中在 `utils/business.js`，页面入口分布在报价、订单、财务、应收款、客户、首页等页面。

整体方向符合“货小玲”轻便 AI 生意助理的定位：记录以本地存储为主，业务记录通过客户、订单、应收款等 ID 进行关联，首页通过经营看板把待收款、临近交期、报价待跟进、待整理等事项汇总给老板。

但当前链路仍存在几类较高风险：

- 报价转订单可能缺少幂等保护，重复点击或重复转换可能生成重复订单。
- `pages/receivables` 的收款入口没有像 `pages/finance` 一样校验剩余金额，存在超额收款或已结清后继续收款风险。
- 报价转订单时，报价中的交期字段没有明确带入订单交期，后续生成应收款时可能退回到今天作为默认应收日期。
- 订单生成应收款后不会更新订单状态，状态一致性依赖页面和用户理解。
- 催款是复制话术和手动记录，没有自动发送风险，但应收款页面可能对已结清记录继续生成或记录催款。

## 2. 报价链路

### 创建位置

报价主要通过“记一笔”确认后的统一保存入口创建：

- `pages/input/input.js`
- `utils/business.js`
  - `saveConfirmedDraft()`
  - `saveQuotation()`
  - `updateQuotationFromDraft()`

报价列表和转订单入口在：

- `pages/quotations/quotations.js`
- `pages/quotations/quotations.wxml`

### 保存位置

报价保存到本地业务状态：

- `state.quotations`
- 最终由 `utils/storage.js` 的 `saveState()` 写入本地存储。

### 主要字段

`saveQuotation()` 当前写入字段包括：

- `id`
- `customerId`
- `productName`
- `spec`
- `quantity`
- `unit`
- `unitPrice`
- `totalAmount`
- `paymentMethod`
- `followupDays`
- `deliveryDate`
- `quoteDate`
- `validUntil`
- `status`
- `remark`
- `createdAt`
- `updatedAt`

默认状态为：

- `待确认`

### 报价转订单

报价转订单逻辑在：

- `utils/business.js`
  - `convertQuotationToOrder()`
- `pages/quotations/quotations.js`
  - `convert()`

转换行为：

- 根据报价创建一条订单。
- 将 `quotation.status` 更新为 `已下单`。
- 订单写入 `state.orders`。
- 订单进度写入 `state.orderProgress`。

风险点：

- `convertQuotationToOrder()` 没有在函数内明确阻止已转订单报价再次转换。
- 如果页面按钮或调用方没有状态保护，可能重复生成订单。
- 报价里的 `deliveryDate` 没有明确映射为订单的 `requiredDeliveryDate` 或 `expectedShipDate`，存在交期字段丢失风险。

### 报价待跟进逻辑

报价待跟进主要在：

- `pages/quotations/quotations.js`
  - `isQuotationDueForFollowup()`
- `utils/business.js`
  - `getDashboard()`
- `utils/home-workbench.js`
  - `buildTodayTasks()`

当前逻辑：

- 只处理状态为 `待确认` 的报价。
- 如果有 `deliveryDate`，到期或过期后视为需要跟进。
- 如果没有 `deliveryDate`，报价创建后满 3 天视为需要跟进。

## 3. 订单链路

### 创建位置

订单主要有两个创建来源：

- 记一笔直接创建订单：
  - `utils/business.js`
    - `saveConfirmedDraft()`
    - `saveOrder()`
    - `updateOrderFromDraft()`
- 报价转订单：
  - `utils/business.js`
    - `convertQuotationToOrder()`
  - `pages/quotations/quotations.js`
    - `convert()`

订单页面在：

- `pages/orders/orders.js`
- `pages/orders/orders.wxml`

### 保存位置

订单保存到：

- `state.orders`

订单进度保存到：

- `state.orderProgress`

### 主要字段

订单字段包括：

- `id`
- `customerId`
- `quotationId`
- `productName`
- `spec`
- `quantity`
- `unit`
- `unitPrice`
- `totalAmount`
- `paymentMethod`
- `orderDate`
- `requiredDeliveryDate`
- `expectedShipDate`
- `actualShipDate`
- `status`
- `logisticsInfo`
- `remark`
- `createdAt`
- `updatedAt`

### 订单状态

订单状态定义在：

- `utils/constants.js`

当前状态包括：

- `待生产`
- `生产中`
- `待发货`
- `已发货`
- `已完成`
- `已取消`

订单默认状态：

- `待生产`

### 交期提醒逻辑

订单交期提醒逻辑在：

- `pages/orders/orders.js`
  - `isDeliverySoonOrder()`
- `utils/business.js`
  - `getDashboard()`
- `utils/home-workbench.js`
  - `buildTodayTasks()`

当前逻辑：

- 排除 `已完成`、`已取消`。
- 有 `requiredDeliveryDate` 才参与计算。
- 距离交期小于等于 3 天会进入临近交期。
- 由于只判断 `<= 3`，已过交期的未完成订单也会进入该集合。

### 订单生成应收款

生成逻辑在：

- `utils/business.js`
  - `generateReceivableFromOrder()`
- `pages/orders/orders.js`
  - `createReceivable()`
- `pages/finance/finance.js`
  - `createReceivable()`

当前行为：

- 如果订单已有应收款，则直接返回已有应收款，避免重复生成。
- 如果订单下已有定金付款记录，会把定金计入应收款的 `paidAmount`。
- 应收款金额仍为订单总金额，已付定金通过 `paidAmount` 体现。
- 应收款状态根据已付金额变为 `待收`、`部分收款` 或 `已结清`。
- 定金付款记录会补上 `receivableId` 关联。

风险点：

- 生成应收款后不会更新订单状态。
- 应收日期优先取 `order.requiredDeliveryDate`，没有则取当天；如果订单交期为空，可能导致应收款默认当天到期。

## 4. 应收款链路

### 生成位置

应收款来源包括：

- 记一笔直接创建应收款：
  - `utils/business.js`
    - `saveReceivable()`
- 记一笔创建应收款并记录收款：
  - `utils/business.js`
    - `saveReceivableWithPayment()`
- 订单生成应收款：
  - `utils/business.js`
    - `generateReceivableFromOrder()`

### 保存位置

应收款保存到：

- `state.receivables`

### 主要字段

应收款字段包括：

- `id`
- `customerId`
- `orderId`
- `amount`
- `dueDate`
- `status`
- `source`
- `paidAmount`
- `dunningCount`
- `lastDunningDate`
- `remark`
- `createdAt`
- `updatedAt`

### 应收款状态

应收款状态定义在：

- `utils/constants.js`

当前状态包括：

- `待收`
- `部分收款`
- `已结清`
- `坏账`

活跃应收状态在 `utils/business.js` 中为：

- `待收`
- `部分收款`

### 部分收款与结清

支持部分收款和结清：

- 收款金额小于应收剩余金额时，状态变为 `部分收款`。
- 累计已收金额大于等于应收金额时，状态变为 `已结清`。

相关函数：

- `savePayment()`
- `recordPayment()`
- `saveReceivableWithPayment()`
- `getRemainingAmount()`

### 逾期判断

逾期判断分布在：

- `utils/business.js`
  - `getDashboard()`
- `utils/finance.js`
  - `buildFinanceViewModel()`
- `pages/receivables/receivables.js`

基本依据：

- `dueDate` 存在。
- 当前日期晚于 `dueDate`。
- 状态不是 `已结清` 或 `坏账`。

## 5. 收款链路

### 创建位置

收款记录来源包括：

- 记一笔识别为收款：
  - `utils/business.js`
    - `saveConfirmedDraft()`
    - `savePayment()`
- 财务页面手动收款：
  - `pages/finance/finance.js`
    - `savePayment()`
  - `utils/business.js`
    - `recordPayment()`
- 应收款页面手动收款：
  - `pages/receivables/receivables.js`
    - `savePayment()`
  - `utils/business.js`
    - `recordPayment()`
- 订单定金：
  - `utils/business.js`
    - `saveOrderDeposit()`

### 保存位置

收款记录保存到：

- `state.paymentRecords`

### 关联应收款

普通收款记录通过 `receivableId` 关联应收款。

订单定金初始通过 `orderId` 关联订单，`receivableId` 为空；当订单生成应收款后，`generateReceivableFromOrder()` 会把对应定金记录补上 `receivableId`。

### 核销欠款

普通收款通过以下字段核销：

- `receivable.paidAmount`
- `receivable.status`
- `paymentRecord.receivableId`

`savePayment()` 会检查活跃应收款和剩余金额。

`recordPayment()` 只根据传入 `receivableId` 追加收款并更新状态，本身没有做活跃状态和超额收款保护。

### 重复收款风险

存在中高风险：

- `createPaymentRecord()` 每次调用都会新增记录，没有幂等键。
- `pages/finance` 会校验收款金额不能大于剩余金额。
- `pages/receivables` 没有校验收款金额不能大于剩余金额，也没有排除已结清应收款。
- `recordPayment()` 内部没有阻止重复提交、超额收款或已结清后继续收款。

### 金额不一致风险

存在风险：

- `recordPayment()` 允许累计已收金额超过应收金额。
- 一旦超过，应收款状态仍会变为 `已结清`，但 `paidAmount` 可能大于 `amount`。
- 收款记录没有保存核销前后的剩余金额快照，后续追查需要重新计算。

## 6. 催款链路

### 催款话术生成

催款话术生成在：

- `utils/business.js`
  - `generateDunningMessage()`

使用数据：

- 应收款
- 客户
- 剩余金额
- 应收日期
- `state.dunningTemplates`

### 催款记录保存

催款记录保存逻辑在：

- `utils/business.js`
  - `recordDunning()`

保存到：

- `state.dunningRecords`

同时会更新应收款：

- `dunningCount`
- `lastDunningDate`
- `updatedAt`

### 页面入口

催款入口在：

- `pages/finance/finance.js`
  - `copyDunning()`
  - `markDunned()`
- `pages/receivables/receivables.js`
  - `copyDunning()`
  - `markDunned()`

### 是否自动发送

当前代码没有自动发送催款消息。

当前行为是：

- 生成话术。
- 复制到剪贴板。
- 用户手动发送。
- 用户手动记录已催。

### 风险点

- `recordDunning()` 不检查应收款是否已结清。
- `pages/receivables` 会加载所有应收款，若界面没有限制，可能对已结清应收款继续复制或记录催款。

## 7. 定金链路

### 当前是否支持订单定金

当前代码支持订单定金。

相关逻辑：

- `utils/business.js`
  - `saveOrderDeposit()`
  - `generateReceivableFromOrder()`
  - `findOrderForDeposit()`
- `utils/finance.js`
  - `computeOrderDepositAmount()`
  - `buildFinanceViewModel()`

### 定金是否挂在订单下面

是。

定金记录写入 `state.paymentRecords`，关键字段为：

- `orderId`
- `kind: 'deposit'`
- `receivableId: ''`

这说明定金初始挂在订单下，不是独立订单，也不是独立应收款。

### 定金是否影响应收款和尾款

是。

订单生成应收款时：

- 查找订单下 `kind` 为 `deposit` 的付款记录。
- 定金合计计入新应收款的 `paidAmount`。
- 应收款状态根据定金覆盖情况变为 `待收`、`部分收款` 或 `已结清`。
- 财务页面的生产结算视图会用订单总额减定金计算待结算金额。

### 风险点

- 订单生成应收款后，定金会补上 `receivableId`；该逻辑对现有定金链路是有利的。
- `findOrderForDeposit()` 只匹配尚未生成应收款的订单；应收款生成后再补录订单定金可能无法通过当前记一笔链路匹配。
- 定金记录本身没有尾款快照，尾款需要通过订单总额、应收款和付款记录动态计算。

## 8. 客户档案链路

### 创建位置

客户创建和关联主要在：

- `utils/business.js`
  - `findOrCreateCustomer()`
  - `saveQuotation()`
  - `saveOrder()`
  - `saveReceivable()`
  - `saveReceivableWithPayment()`
  - `savePayment()`
  - `saveOrderDeposit()`

客户页面在：

- `pages/customer/customer.js`

### 保存位置

客户保存到：

- `state.customers`

### 自动创建或关联

保存报价、订单、应收款、收款、定金时，代码会尝试通过 `findOrCreateCustomer()` 自动创建或关联客户。

匹配策略大致为：

- 优先手机号指纹加客户名。
- 再使用客户名匹配。
- 如果同名客户有多个，会返回不确定结果，部分业务会进入待整理。

### 临时客户和手机号

支持手机号可选。

`utils/storage.js` 中客户标准化逻辑包含：

- `phone`
- `phoneMasked`
- `phoneFingerprint`
- `isTemporary: !phone`
- `wechatRemark`

这说明没有手机号时会形成临时客户。

### 重复客户风险

存在中等风险：

- 同名、无手机号、无公司或地区信息时，客户可能重复创建。
- 如果同名客户已经有多个，部分保存链路会因为无法确定客户而进入待整理。
- 客户页面提供了合并和标记分开能力，但业务保存时仍依赖当前匹配规则。

客户合并逻辑会更新：

- `quotations`
- `orders`
- `receivables`
- `paymentRecords`
- `todos`

## 9. 每日经营看板链路

### 数据来源

首页看板数据主要来自：

- `utils/business.js`
  - `getDashboard()`
- `utils/home-workbench.js`
  - `buildTodayTasks()`
  - `buildRecentRecords()`
- `pages/dashboard/dashboard.js`

### 指标计算

当前看板相关指标包括：

- 今日应收
- 逾期应收
- 临近交期订单
- 报价待跟进
- 待整理
- 待办

### 待收款

来源：

- `state.receivables`

条件：

- 状态不是 `已结清` 或 `坏账`。
- `dueDate` 等于当天，或已经逾期。

### 临近交期

来源：

- `state.orders`

条件：

- 状态不是 `已完成` 或 `已取消`。
- 有 `requiredDeliveryDate`。
- 距交期小于等于 3 天。

### 报价待跟进

来源：

- `state.quotations`

条件：

- 状态为 `待确认`。
- 到达交期相关跟进日，或报价创建满 3 天。

### 待整理数量

来源：

- `state.pendingNotes`

条件：

- 状态为 `待整理`。

### 是否暴露客户名和金额

首页任务数据会展示客户显示名、金额、交期、报价总额等摘要信息。

这符合“老板打开就知道今天该干嘛”的核心心智，但也意味着首页会直接暴露客户名和金额，后续如果有隐私模式或手机借用场景，需要单独设计。

### 看板风险

- `getDashboard()` 的 `totalThings` 会加上所有未完成待办，而不只是今天、逾期、明天相关待办，可能放大“今天要处理”的数量。
- 临近交期逻辑包括已过期订单，适合提醒但命名上可能和“临近”不完全一致。

## 10. 状态一致性风险

### 报价转订单后报价状态

已更新。

`convertQuotationToOrder()` 会将报价状态更新为：

- `已下单`

风险：

- 函数内没有明确阻止已下单报价再次转订单。

### 订单生成应收款后订单状态

未看到自动更新订单状态。

当前行为：

- 生成应收款。
- 关联订单。
- 不改变订单状态。

风险：

- 用户可能无法从订单状态直接判断是否已经进入应收款。
- 订单状态和财务结算状态需要依赖应收款是否存在来判断。

### 应收款部分收款后剩余金额

财务工具函数可计算剩余金额：

- `getRemainingAmount()`

状态会更新为：

- `部分收款`

风险：

- 如果收款入口没有校验超额，剩余金额可能变为负数。

### 应收款结清后状态

当前逻辑支持结清。

累计已收金额大于等于应收金额时，状态变为：

- `已结清`

风险：

- 已结清记录仍可能被部分入口继续收款或催款。

### 逾期应收款进入催款

支持。

财务页面和应收款页面都可生成催款话术并记录催款。

风险：

- 催款函数本身不限制逾期状态，也不限制已结清状态。

### 删除或修改记录后的关联同步

当前未看到完整的删除链路。

风险：

- 如果后续增加删除报价、订单、应收款、收款记录功能，必须设计级联规则。
- 当前更新报价和订单会修改主记录，但对已生成的下游订单、应收款、收款记录没有自动同步策略。

## 11. 字段丢失风险

### 报价转订单字段

风险较高：

- 报价有 `deliveryDate`。
- 转订单时订单的 `requiredDeliveryDate` 和 `expectedShipDate` 当前为空。
- 后续从该订单生成应收款时，如果订单没有交期，应收款 `dueDate` 可能默认为当天。

### 订单生成应收款字段

风险中等：

- 应收款只保存订单 ID、金额、应收日期、已收金额等字段。
- 商品、规格、数量等仍需通过订单关联查看。
- 如果订单后续被修改，应收款没有订单字段快照。

### 收款字段

风险中等：

- 收款记录不保存核销前余额、核销后余额。
- 金额异常时排查需要重新计算。

### 催款字段

风险中等：

- 催款记录保存了 `receivableId` 和话术。
- 没有保存催款时的欠款金额、逾期天数、客户显示名快照。

### 客户合并字段

风险中等：

- 客户合并会更新主要业务记录的 `customerId`。
- 待整理记录中的猜测客户字段不一定随合并更新。

## 12. 重复记录风险

### 报价重复

记一笔创建报价时没有业务去重。

风险：

- 同一段微信聊天或同一笔报价重复确认，可能生成重复报价。

### 订单重复

风险较高：

- 报价转订单函数没有内部幂等保护。
- 重复点击或重复调用可能生成重复订单。

### 应收款重复

风险较低到中等：

- `generateReceivableFromOrder()` 会检查同一订单是否已有应收款。
- 记一笔直接创建应收款没有业务去重。

### 收款重复

风险较高：

- `recordPayment()` 每次都会新增付款记录。
- 没有防止重复提交的业务键。
- 应收款页面缺少超额收款校验。

### 客户重复

风险中等：

- 同名无手机号客户容易重复。
- 多个同名客户会导致部分业务进入待整理。
- 客户页面提供合并能力，但不是自动合并。

## 13. 高风险文件清单

后续修改业务流转时必须谨慎处理以下文件：

- `utils/business.js`
  - 报价、订单、应收款、收款、定金、催款、客户关联的核心逻辑。
- `utils/storage.js`
  - 本地数据结构、默认状态、客户标准化、兼容迁移逻辑。
- `utils/finance.js`
  - 财务视图、收款统计、定金和尾款计算。
- `utils/home-workbench.js`
  - 首页今日任务和最近记录聚合。
- `utils/constants.js`
  - 业务类型、状态枚举、状态文案。
- `utils/parser.js`
  - 记一笔识别结果会直接影响业务流转。
- `utils/ai-parser.js`
  - AI 解析边界会影响业务字段进入保存链路。
- `pages/input/input.js`
  - 记一笔确认卡和保存入口。
- `pages/quotations/quotations.js`
  - 报价跟进和转订单入口。
- `pages/orders/orders.js`
  - 订单状态和生成应收款入口。
- `pages/finance/finance.js`
  - 财务页收款、催款、结算入口。
- `pages/receivables/receivables.js`
  - 应收款页收款和催款入口，当前存在较高校验风险。
- `pages/customer/customer.js`
  - 客户合并、重复客户处理和业务记录关联展示。
- `pages/dashboard/dashboard.js`
  - 老板每日看板入口。

## 14. 后续建议修复顺序

建议优先级如下：

1. 统一收款校验：把剩余金额、活跃状态、已结清保护下沉到 `recordPayment()` 或公共收款函数。
2. 增加报价转订单幂等保护：已下单报价不允许再次转订单，或转订单前查重。
3. 明确报价交期到订单交期的字段映射，避免应收款默认当天到期。
4. 梳理订单生成应收款后的状态表达：决定是否新增订单财务状态，或在页面明确展示“已生成应收款”。
5. 限制已结清应收款继续收款和催款。
6. 给收款记录和催款记录增加关键快照字段，方便后续核对。
7. 优化客户去重规则，降低临时客户重复创建。
8. 设计未来删除和修改记录时的关联同步规则。

## 15. 哪些问题可以并行处理

以下任务可以多 Agent 并行盘点或实现，但落地前需要主控 Agent 统一合并判断：

- 首页看板展示规则和任务优先级优化。
- 客户重复识别和客户合并体验优化。
- 催款话术和催款记录字段补充。
- 报价、订单、应收款页面的 UI 提示文案优化。
- 测试用例补充，包括报价转订单、订单生成应收款、部分收款、结清、定金抵扣。
- 文档补充，包括业务状态说明和字段字典。

## 16. 哪些问题必须串行处理

以下任务必须单 Agent 串行推进，避免状态规则冲突：

- 收款核销规则调整。
- 应收款状态机调整。
- 订单定金和尾款计算规则调整。
- 报价转订单幂等规则调整。
- 订单生成应收款规则调整。
- 客户合并对历史业务记录的迁移规则调整。
- 本地存储结构升级和兼容迁移。
- parser / AI 解析结果到业务保存字段的结构调整。

